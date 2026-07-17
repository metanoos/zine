//! Native HTTP proxy for provider calls made by the webview.
//!
//! Some LLM providers return CORS headers that a webview rejects. The proxy
//! keeps the existing request shape native and forwards either the complete
//! response body or framed SSE `data:` payloads over the caller's IPC channel.
//! Protocol-specific JSON parsing remains in `apps/client/src/ai/llm.ts`.

use std::collections::HashMap;

use futures_util::StreamExt;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use tauri::ipc::Channel;

const MAX_ERROR_BODY_BYTES: usize = 500;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum LlmMethod {
    Get,
    Post,
}

fn parse_method(method: &str) -> Result<LlmMethod, String> {
    match method.to_ascii_uppercase().as_str() {
        "POST" => Ok(LlmMethod::Post),
        "GET" => Ok(LlmMethod::Get),
        _ => Err(format!("unsupported method: {method}")),
    }
}

fn parse_headers(headers: &HashMap<String, String>) -> Result<HeaderMap, String> {
    let mut header_map = HeaderMap::new();
    for (key, value) in headers {
        let name = HeaderName::from_bytes(key.as_bytes())
            .map_err(|error| format!("bad header name {key:?}: {error}"))?;
        let value = HeaderValue::from_str(value)
            .map_err(|error| format!("bad header value for {key}: {error}"))?;
        header_map.append(name, value);
    }
    Ok(header_map)
}

fn build_request(
    client: &reqwest::Client,
    url: &str,
    method: &str,
    headers: &HashMap<String, String>,
    body: String,
) -> Result<reqwest::RequestBuilder, String> {
    let request = match parse_method(method)? {
        LlmMethod::Post => client.post(url),
        LlmMethod::Get => client.get(url),
    };
    Ok(request.headers(parse_headers(headers)?).body(body))
}

fn request_error(error: &reqwest::Error) -> String {
    format!("LLM request failed: {error}")
}

fn error_body_snippet(text: String) -> String {
    if text.len() <= MAX_ERROR_BODY_BYTES {
        return text;
    }

    let mut end = MAX_ERROR_BODY_BYTES;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &text[..end])
}

fn http_error(status: reqwest::StatusCode, text: String) -> String {
    format!("HTTP {}: {}", status.as_u16(), error_body_snippet(text))
}

/// Stateful framing for the proxy's existing SSE contract. Each complete
/// `\n\n`-delimited event yields its joined `data:` payload; comments,
/// keep-alives, and an incomplete trailing event yield no IPC message.
#[derive(Default)]
struct SseFramer {
    buffer: String,
}

impl SseFramer {
    fn push(&mut self, chunk: &[u8]) -> Vec<String> {
        self.buffer.push_str(&String::from_utf8_lossy(chunk));
        let mut payloads = Vec::new();
        while let Some(index) = self.buffer.find("\n\n") {
            let raw_event = self.buffer[..index].to_string();
            self.buffer = self.buffer[index + 2..].to_string();
            let data = extract_sse_data(&raw_event);
            if !data.is_empty() {
                payloads.push(data);
            }
        }
        payloads
    }
}

/// Extract the joined `data:` payload from one raw SSE event block, mirroring
/// `llm.ts`: collect every line starting with `data:`, strip the prefix, trim
/// one leading space, and join the remainder with `\n`.
fn extract_sse_data(raw_event: &str) -> String {
    raw_event
        .lines()
        .filter_map(|line| line.strip_prefix("data:"))
        .map(|rest| rest.strip_prefix(' ').unwrap_or(rest))
        .collect::<Vec<_>>()
        .join("\n")
}

/// Proxy an LLM request and forward its response over `on_event`. The command
/// name, arguments, and channel behavior are part of the TypeScript IPC
/// contract in `apps/client/src/ai/llm.ts`.
#[tauri::command]
pub(crate) async fn llm_fetch(
    url: String,
    method: String,
    headers: HashMap<String, String>,
    body: String,
    stream: bool,
    on_event: Channel<String>,
) -> Result<(), String> {
    let client = reqwest::Client::new();
    let response = build_request(&client, &url, &method, &headers, body)?
        .send()
        .await
        .map_err(|error| request_error(&error))?;
    let status = response.status();
    if !status.is_success() {
        let text = response.text().await.unwrap_or_default();
        return Err(http_error(status, text));
    }

    if !stream {
        let text = response
            .text()
            .await
            .map_err(|error| format!("read body: {error}"))?;
        on_event
            .send(text)
            .map_err(|error| format!("ipc send failed: {error}"))?;
        return Ok(());
    }

    let mut byte_stream = response.bytes_stream();
    let mut framer = SseFramer::default();
    while let Some(chunk_result) = byte_stream.next().await {
        let chunk = chunk_result.map_err(|error| format!("stream chunk: {error}"))?;
        for data in framer.push(&chunk) {
            on_event
                .send(data)
                .map_err(|error| format!("ipc send failed: {error}"))?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_the_existing_methods_case_insensitively() {
        let cases = [
            ("POST", Ok(LlmMethod::Post)),
            ("post", Ok(LlmMethod::Post)),
            ("PoSt", Ok(LlmMethod::Post)),
            ("GET", Ok(LlmMethod::Get)),
            ("get", Ok(LlmMethod::Get)),
            ("PUT", Err("unsupported method: PUT".to_string())),
            (" POST ", Err("unsupported method:  POST ".to_string())),
            ("", Err("unsupported method: ".to_string())),
        ];

        for (method, expected) in cases {
            assert_eq!(parse_method(method), expected, "method {method:?}");
        }
    }

    #[test]
    fn parses_valid_headers_and_rejects_malformed_headers() {
        let cases = [
            ("content-type", "application/json", true, ""),
            ("X-Provider-Version", "2023-06-01", true, ""),
            ("bad header", "value", false, "bad header name"),
            ("x-provider", "line\nbreak", false, "bad header value"),
        ];

        for (key, value, accepted, error_prefix) in cases {
            let headers = HashMap::from([(key.to_string(), value.to_string())]);
            let result = parse_headers(&headers);
            assert_eq!(result.is_ok(), accepted, "header {key:?}: {value:?}");
            if !accepted {
                assert!(
                    result.unwrap_err().starts_with(error_prefix),
                    "header {key:?}: {value:?} should report {error_prefix:?}"
                );
            }
        }
    }

    #[test]
    fn malformed_urls_keep_the_existing_request_error_prefix() {
        let request = build_request(
            &reqwest::Client::new(),
            "not a URL",
            "POST",
            &HashMap::new(),
            "request body".to_string(),
        )
        .expect("method and headers are valid");
        let error = request.build().expect_err("URL should be rejected");

        assert!(request_error(&error).starts_with("LLM request failed: "));
    }

    #[test]
    fn frames_sse_events_across_chunk_boundaries() {
        let input = b": keep-alive\n\ndata: first\n\ndata: second-a\ndata:second-b\n\nevent: done\ndata: [DONE]\n\ntrailing";
        let expected = vec![
            "first".to_string(),
            "second-a\nsecond-b".to_string(),
            "[DONE]".to_string(),
        ];
        let splits = [
            vec![input.len()],
            vec![1; input.len()],
            vec![7, 9, 1, 23, input.len() - 40],
        ];

        for chunk_sizes in splits {
            let mut framer = SseFramer::default();
            let mut payloads = Vec::new();
            let mut offset = 0;
            for size in chunk_sizes {
                let end = offset + size;
                payloads.extend(framer.push(&input[offset..end]));
                offset = end;
            }
            assert_eq!(offset, input.len());
            assert_eq!(payloads, expected);
        }
    }

    #[test]
    fn http_errors_are_capped_without_panicking_on_utf8_boundaries() {
        let cases = [
            (
                "provider error".to_string(),
                "HTTP 429: provider error".to_string(),
            ),
            (
                format!("{}érest", "a".repeat(MAX_ERROR_BODY_BYTES - 1)),
                format!("HTTP 429: {}…", "a".repeat(MAX_ERROR_BODY_BYTES - 1)),
            ),
            (
                "a".repeat(MAX_ERROR_BODY_BYTES + 1),
                format!("HTTP 429: {}…", "a".repeat(MAX_ERROR_BODY_BYTES)),
            ),
        ];

        for (body, expected) in cases {
            assert_eq!(
                http_error(reqwest::StatusCode::TOO_MANY_REQUESTS, body),
                expected
            );
        }
    }
}

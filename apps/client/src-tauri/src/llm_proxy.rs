//! Native HTTP proxy for provider calls made by the webview.
//!
//! Some LLM providers return CORS headers that a webview rejects. The proxy
//! keeps the existing request shape native and forwards either the complete
//! response body or framed SSE `data:` payloads over the caller's IPC channel.
//! Protocol-specific JSON parsing remains in `apps/client/src/ai/llm.ts`.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use tauri::{ipc::Channel, State};
use tokio::sync::Notify;

const MAX_ERROR_BODY_BYTES: usize = 500;
const MAX_ACTIVE_REQUESTS: usize = 32;
const MAX_PRE_CANCELLED_REQUESTS: usize = 64;
const MAX_COMPLETED_REQUESTS: usize = 128;
const REQUEST_ID_TTL: Duration = Duration::from_secs(5 * 60);
const CANCELLED_ERROR: &str = "LLM request cancelled";

#[derive(Default)]
struct LlmCancellationSignal {
    cancelled: AtomicBool,
    changed: Notify,
}

impl LlmCancellationSignal {
    fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }

    fn cancel(&self) {
        if !self.cancelled.swap(true, Ordering::AcqRel) {
            self.changed.notify_waiters();
        }
    }

    async fn cancelled(&self) {
        loop {
            let changed = self.changed.notified();
            if self.cancelled.load(Ordering::Acquire) {
                return;
            }
            changed.await;
        }
    }
}

#[derive(Default)]
struct LlmRequestRegistryState {
    active: HashMap<String, Arc<LlmCancellationSignal>>,
    pre_cancelled: HashMap<String, Instant>,
    completed: HashMap<String, Instant>,
    fail_closed_until: Option<Instant>,
}

impl LlmRequestRegistryState {
    fn prune(&mut self, now: Instant) {
        self.pre_cancelled
            .retain(|_, created| now.saturating_duration_since(*created) <= REQUEST_ID_TTL);
        self.completed
            .retain(|_, created| now.saturating_duration_since(*created) <= REQUEST_ID_TTL);
        if self
            .fail_closed_until
            .is_some_and(|deadline| now >= deadline)
        {
            self.fail_closed_until = None;
        }
    }
}

/// Bounded native cancellation registry. Request ids never contain provider
/// data and are retained only long enough to close IPC ordering races.
#[derive(Clone, Default)]
pub(crate) struct LlmRequestRegistry {
    state: Arc<Mutex<LlmRequestRegistryState>>,
}

impl LlmRequestRegistry {
    fn register(&self, request_id: &str) -> Result<LlmRequestRegistration, String> {
        self.register_at(request_id, Instant::now())
    }

    fn register_at(
        &self,
        request_id: &str,
        now: Instant,
    ) -> Result<LlmRequestRegistration, String> {
        validate_request_id(request_id)?;
        let mut state = self
            .state
            .lock()
            .map_err(|_| "LLM cancellation registry is unavailable".to_string())?;
        state.prune(now);
        if state.completed.contains_key(request_id)
            || state.active.contains_key(request_id)
            || state.active.len() >= MAX_ACTIVE_REQUESTS
        {
            return Err("LLM request id is unavailable".to_string());
        }
        let signal = Arc::new(LlmCancellationSignal::default());
        let fail_closed = state
            .fail_closed_until
            .is_some_and(|deadline| now < deadline);
        if state.pre_cancelled.remove(request_id).is_some() || fail_closed {
            signal.cancel();
        }
        state.active.insert(request_id.to_string(), signal.clone());
        drop(state);
        Ok(LlmRequestRegistration {
            registry: self.clone(),
            request_id: request_id.to_string(),
            signal,
        })
    }

    fn cancel(&self, request_id: &str) -> Result<(), String> {
        self.cancel_at(request_id, Instant::now())
    }

    fn cancel_at(&self, request_id: &str, now: Instant) -> Result<(), String> {
        validate_request_id(request_id)?;
        let mut state = self
            .state
            .lock()
            .map_err(|_| "LLM cancellation registry is unavailable".to_string())?;
        state.prune(now);
        if state.completed.contains_key(request_id) {
            return Ok(());
        }
        if let Some(signal) = state.active.get(request_id) {
            signal.cancel();
            return Ok(());
        }
        if state.pre_cancelled.contains_key(request_id) {
            return Ok(());
        }
        if state.pre_cancelled.len() >= MAX_PRE_CANCELLED_REQUESTS {
            // An untrusted renderer may consume the tombstone budget, but it
            // must never make a later cancelled request dispatch. Fail closed
            // for the same bounded monotonic interval instead of evicting a
            // cancellation record whose native registration may still arrive.
            state.fail_closed_until = now.checked_add(REQUEST_ID_TTL);
            return Ok(());
        }
        state.pre_cancelled.insert(request_id.to_string(), now);
        Ok(())
    }

    fn complete_at(&self, request_id: &str, now: Instant) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.prune(now);
        state.active.remove(request_id);
        state.pre_cancelled.remove(request_id);
        if state.completed.len() >= MAX_COMPLETED_REQUESTS {
            if let Some((oldest, completed_at)) = state
                .completed
                .iter()
                .min_by_key(|(_, completed)| **completed)
                .map(|(id, completed)| (id.clone(), *completed))
            {
                // Preserve the no-reuse guarantee when the bounded completed
                // cache saturates. New registrations fail closed until the
                // evicted id would have expired naturally.
                let deadline = completed_at.checked_add(REQUEST_ID_TTL);
                state.fail_closed_until = match (state.fail_closed_until, deadline) {
                    (Some(current), Some(next)) => Some(current.max(next)),
                    (current, None) => current,
                    (None, next) => next,
                };
                state.completed.remove(&oldest);
            }
        }
        state.completed.insert(request_id.to_string(), now);
    }
}

struct LlmRequestRegistration {
    registry: LlmRequestRegistry,
    request_id: String,
    signal: Arc<LlmCancellationSignal>,
}

impl Drop for LlmRequestRegistration {
    fn drop(&mut self) {
        // This is a std::sync::Mutex specifically so every async return path can
        // clean up synchronously without awaiting or holding a lock across I/O.
        self.registry.complete_at(&self.request_id, Instant::now());
    }
}

fn validate_request_id(request_id: &str) -> Result<(), String> {
    let bytes = request_id.as_bytes();
    if bytes.len() != 36
        || bytes[8] != b'-'
        || bytes[13] != b'-'
        || bytes[18] != b'-'
        || bytes[23] != b'-'
        || bytes.iter().enumerate().any(|(index, byte)| {
            !matches!(index, 8 | 13 | 18 | 23) && !matches!(byte, b'0'..=b'9' | b'a'..=b'f')
        })
    {
        return Err("LLM request id is invalid".to_string());
    }
    Ok(())
}

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

async fn execute_llm_fetch(
    url: String,
    method: String,
    headers: HashMap<String, String>,
    body: String,
    stream: bool,
    cancelled: Arc<LlmCancellationSignal>,
    mut on_event: impl FnMut(String) -> Result<(), String>,
) -> Result<(), String> {
    if cancelled.is_cancelled() {
        return Err(CANCELLED_ERROR.to_string());
    }
    let client = reqwest::Client::new();
    let request = build_request(&client, &url, &method, &headers, body)?;
    let response = tokio::select! {
        biased;
        _ = cancelled.cancelled() => return Err(CANCELLED_ERROR.to_string()),
        response = request.send() => response.map_err(|error| request_error(&error))?,
    };
    let status = response.status();
    if !status.is_success() {
        let text = tokio::select! {
            biased;
            _ = cancelled.cancelled() => return Err(CANCELLED_ERROR.to_string()),
            text = response.text() => text.unwrap_or_default(),
        };
        return Err(http_error(status, text));
    }

    if !stream {
        let text = tokio::select! {
            biased;
            _ = cancelled.cancelled() => return Err(CANCELLED_ERROR.to_string()),
            text = response.text() => text.map_err(|error| format!("read body: {error}"))?,
        };
        on_event(text)?;
        return Ok(());
    }

    let mut byte_stream = response.bytes_stream();
    let mut framer = SseFramer::default();
    loop {
        let chunk_result = tokio::select! {
            biased;
            _ = cancelled.cancelled() => return Err(CANCELLED_ERROR.to_string()),
            chunk = byte_stream.next() => chunk,
        };
        let Some(chunk_result) = chunk_result else {
            break;
        };
        let chunk = chunk_result.map_err(|error| format!("stream chunk: {error}"))?;
        for data in framer.push(&chunk) {
            on_event(data)?;
        }
    }
    Ok(())
}

/// Proxy an LLM request and forward its response over `on_event`. The opaque
/// request id exists only to make AbortSignal cancellation real across IPC; it
/// is never derived from provider, prompt, credential, or response bytes.
#[tauri::command]
pub(crate) async fn llm_fetch(
    registry: State<'_, LlmRequestRegistry>,
    request_id: String,
    url: String,
    method: String,
    headers: HashMap<String, String>,
    body: String,
    stream: bool,
    on_event: Channel<String>,
) -> Result<(), String> {
    let registration = registry.register(&request_id)?;
    execute_llm_fetch(
        url,
        method,
        headers,
        body,
        stream,
        registration.signal.clone(),
        |data| {
            on_event
                .send(data)
                .map_err(|_| "LLM response IPC failed".to_string())
        },
    )
    .await
}

/// Idempotently cancel an active request or leave a bounded tombstone when IPC
/// scheduling delivers cancellation before `llm_fetch` registration.
#[tauri::command]
pub(crate) fn llm_cancel(
    registry: State<'_, LlmRequestRegistry>,
    request_id: String,
) -> Result<(), String> {
    registry.cancel(&request_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::mpsc::{self, Receiver, Sender};
    use std::thread::JoinHandle;
    use std::time::Duration;

    const REQUEST_ID: &str = "01234567-89ab-cdef-0123-456789abcdef";

    fn stalled_http_server(prefix: Vec<u8>) -> (String, Receiver<()>, Sender<()>, JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind local HTTP fixture");
        let address = listener.local_addr().expect("fixture address");
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let handle = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().expect("accept request");
            socket
                .set_read_timeout(Some(Duration::from_secs(5)))
                .expect("set fixture read timeout");
            let mut request = Vec::new();
            let mut chunk = [0_u8; 1_024];
            while !request.windows(4).any(|window| window == b"\r\n\r\n") {
                let read = socket.read(&mut chunk).expect("read request headers");
                if read == 0 {
                    break;
                }
                request.extend_from_slice(&chunk[..read]);
            }
            if !prefix.is_empty() {
                socket.write_all(&prefix).expect("write response prefix");
                socket.flush().expect("flush response prefix");
            }
            entered_tx.send(()).expect("publish fixture barrier");
            let _ = release_rx.recv_timeout(Duration::from_secs(5));
        });
        (
            format!("http://{address}/llm"),
            entered_rx,
            release_tx,
            handle,
        )
    }

    async fn cancel_stalled_request(prefix: Vec<u8>, stream: bool) -> (String, Vec<String>) {
        let (url, entered, release, server) = stalled_http_server(prefix);
        let registry = LlmRequestRegistry::default();
        let registration = registry.register(REQUEST_ID).expect("register request");
        let events = Arc::new(Mutex::new(Vec::new()));
        let recorded = events.clone();
        let (event_tx, event_rx) = mpsc::channel();
        let task = tokio::spawn(execute_llm_fetch(
            url,
            "POST".to_string(),
            HashMap::new(),
            "request".to_string(),
            stream,
            registration.signal.clone(),
            move |event| {
                recorded.lock().expect("event lock").push(event);
                let _ = event_tx.send(());
                Ok(())
            },
        ));
        entered
            .recv_timeout(Duration::from_secs(5))
            .expect("reach provider barrier");
        if stream {
            event_rx
                .recv_timeout(Duration::from_secs(5))
                .expect("consume the first stream event before cancellation");
        }
        registry.cancel(REQUEST_ID).expect("cancel request");
        let error = task
            .await
            .expect("join request")
            .expect_err("request cancels");
        release.send(()).expect("release fixture server");
        server.join().expect("join fixture server");
        drop(registration);
        let events = Arc::try_unwrap(events)
            .expect("only test owns events")
            .into_inner()
            .expect("event lock");
        (error, events)
    }

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

    #[test]
    fn request_ids_are_strict_lowercase_uuids() {
        for accepted in [
            REQUEST_ID,
            "ffffffff-ffff-ffff-ffff-ffffffffffff",
            "00000000-0000-0000-0000-000000000000",
        ] {
            assert!(validate_request_id(accepted).is_ok(), "accept {accepted:?}");
        }
        for rejected in [
            "0123456789abcdef0123456789abcdef",
            "01234567-89AB-cdef-0123-456789abcdef",
            "01234567-89ab-cdef-0123-456789abcdeg",
            "01234567-89ab-cdef-0123-456789abcdef0",
            "../234567-89ab-cdef-0123-456789abcdef",
        ] {
            assert!(
                validate_request_id(rejected).is_err(),
                "reject {rejected:?}"
            );
        }
    }

    #[test]
    fn cancel_before_registration_is_consumed_and_cleanup_is_complete() {
        let registry = LlmRequestRegistry::default();
        registry.cancel(REQUEST_ID).expect("pre-cancel request");
        registry.cancel(REQUEST_ID).expect("idempotent pre-cancel");
        let registration = registry
            .register(REQUEST_ID)
            .expect("register cancelled request");
        assert!(registration.signal.cancelled.load(Ordering::Acquire));
        drop(registration);

        let state = registry.state.lock().expect("registry state");
        assert!(state.active.is_empty());
        assert!(state.pre_cancelled.is_empty());
        assert!(state.completed.contains_key(REQUEST_ID));
    }

    #[test]
    fn late_cancel_after_completion_cannot_recreate_a_tombstone_or_reuse_the_id() {
        let registry = LlmRequestRegistry::default();
        let registration = registry.register(REQUEST_ID).expect("register request");
        drop(registration);
        registry
            .cancel(REQUEST_ID)
            .expect("late cancel is idempotent");

        {
            let state = registry.state.lock().expect("registry state");
            assert!(state.pre_cancelled.is_empty());
            assert!(state.completed.contains_key(REQUEST_ID));
        }
        assert_eq!(
            registry
                .register(REQUEST_ID)
                .err()
                .expect("completed id fails closed"),
            "LLM request id is unavailable",
        );
    }

    #[test]
    fn monotonic_ttl_prunes_only_expired_request_ids() {
        let registry = LlmRequestRegistry::default();
        let started = Instant::now();
        registry
            .cancel_at(REQUEST_ID, started)
            .expect("create controlled tombstone");
        let before_expiry = started + REQUEST_ID_TTL - Duration::from_millis(1);
        registry
            .cancel_at(REQUEST_ID, before_expiry)
            .expect("tombstone remains idempotent before expiry");
        assert!(registry
            .state
            .lock()
            .expect("registry state")
            .pre_cancelled
            .contains_key(REQUEST_ID));

        let after_expiry = started + REQUEST_ID_TTL + Duration::from_millis(1);
        let fresh_id = "fedcba98-7654-3210-fedc-ba9876543210";
        registry
            .cancel_at(fresh_id, after_expiry)
            .expect("prune at controlled time");
        let state = registry.state.lock().expect("registry state");
        assert!(!state.pre_cancelled.contains_key(REQUEST_ID));
        assert!(state.pre_cancelled.contains_key(fresh_id));
    }

    #[test]
    fn registry_bounds_fail_closed_without_evicting_pending_cancellation() {
        let registry = LlmRequestRegistry::default();
        for index in 0..MAX_PRE_CANCELLED_REQUESTS {
            registry
                .cancel(&format!("00000000-0000-0000-0000-{index:012x}"))
                .expect("fill pre-cancel registry");
        }
        let overflow = "ffffffff-ffff-ffff-ffff-ffffffffffff";
        registry.cancel(overflow).expect("overflow fails closed");
        let registration = registry
            .register(overflow)
            .expect("register during fail-closed interval");
        assert!(registration.signal.cancelled.load(Ordering::Acquire));
    }

    #[test]
    fn completed_registry_overflow_cannot_make_an_evicted_id_dispatchable() {
        let registry = LlmRequestRegistry::default();
        for index in 0..=MAX_COMPLETED_REQUESTS {
            let request_id = format!("10000000-0000-0000-0000-{index:012x}");
            let registration = registry
                .register(&request_id)
                .expect("register completed request");
            drop(registration);
        }
        let evicted = "10000000-0000-0000-0000-000000000000";
        let registration = registry
            .register(evicted)
            .expect("completed-cache overflow fails closed");
        assert!(registration.signal.is_cancelled());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn cancellation_interrupts_request_send_before_response_headers() {
        let (error, events) = cancel_stalled_request(Vec::new(), false).await;
        assert_eq!(error, CANCELLED_ERROR);
        assert!(events.is_empty());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn cancellation_interrupts_nonstream_response_body() {
        let prefix = b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\npartial".to_vec();
        let (error, events) = cancel_stalled_request(prefix, false).await;
        assert_eq!(error, CANCELLED_ERROR);
        assert!(events.is_empty());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn cancellation_interrupts_stream_response_body() {
        let event = b"data: {\"choices\":[]}\n\n";
        let prefix = format!(
            "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n{:x}\r\n{}\r\n",
            event.len(),
            String::from_utf8_lossy(event),
        )
        .into_bytes();
        let (error, events) = cancel_stalled_request(prefix, true).await;
        assert_eq!(error, CANCELLED_ERROR);
        assert_eq!(events, vec!["{\"choices\":[]}".to_string()]);
    }
}

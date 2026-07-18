//! Native, DNS-pinned sampling for attacker-named rendezvous relays.
//!
//! A webview WebSocket resolves DNS after JavaScript validation, which permits
//! rebinding to loopback or a private LAN. This command resolves once, rejects
//! the entire answer set if any address is non-public, connects the validated
//! `SocketAddr` itself, and then performs the TLS/WebSocket handshake using the
//! original URL so Host and SNI remain correct.

use std::collections::BTreeSet;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::net::{lookup_host, TcpStream};
use tokio::time::timeout;
use tokio_tungstenite::client_async_tls_with_config;
use tokio_tungstenite::tungstenite::protocol::{Message, WebSocketConfig};

const MAX_URL_BYTES: usize = 2_048;
const HEX_ID_BYTES: usize = 64;
const HARD_MAX_FILTER_BYTES: usize = 64 * 1024;
const HARD_MAX_UNIQUE_EVENTS: usize = 256;
const HARD_MAX_TOTAL_BYTES: usize = 4 * 1024 * 1024;
const HARD_MAX_EVENT_BYTES: usize = 2 * 1024 * 1024;
const HARD_MAX_CONTENT_BYTES: usize = 1024 * 1024;
const HARD_MAX_TAGS: usize = 4_096;
const HARD_MAX_TAG_VALUES: usize = 32;
const HARD_MAX_TAG_VALUE_BYTES: usize = 16_384;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RendezvousRelaySampleRequest {
    url: String,
    filter: Value,
    requested_ids: Option<Vec<String>>,
    timeout_ms: u64,
    max_unique_events: usize,
    max_total_bytes: usize,
    max_event_bytes: usize,
    max_content_length: usize,
    max_tags: usize,
    max_tag_values: usize,
    max_tag_value_length: usize,
}

fn is_hex_id(value: &str) -> bool {
    value.len() == HEX_ID_BYTES
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn is_public_ipv4(ip: Ipv4Addr) -> bool {
    let [a, b, c, _] = ip.octets();
    !(ip.is_private()
        || ip.is_loopback()
        || ip.is_link_local()
        || ip.is_unspecified()
        || ip.is_broadcast()
        || ip.is_multicast()
        || a == 0
        || (a == 100 && (64..=127).contains(&b))
        || (a == 192 && b == 0 && c == 0)
        || (a == 192 && b == 0 && c == 2)
        || (a == 192 && b == 88 && c == 99)
        || (a == 198 && (18..=19).contains(&b))
        || (a == 198 && b == 51 && c == 100)
        || (a == 203 && b == 0 && c == 113)
        || a >= 240)
}

fn is_public_ipv6(ip: Ipv6Addr) -> bool {
    if let Some(mapped) = ip.to_ipv4_mapped() {
        return is_public_ipv4(mapped);
    }
    let segments = ip.segments();
    let global_unicast = (segments[0] & 0xe000) == 0x2000;
    let ietf_protocol_assignment = segments[0] == 0x2001 && segments[1] < 0x0200;
    let documentation = segments[0] == 0x2001 && segments[1] == 0x0db8;
    let deprecated_6to4 = segments[0] == 0x2002;
    let documentation_v2 = segments[0] & 0xfff0 == 0x3ff0;
    global_unicast
        && !ietf_protocol_assignment
        && !documentation
        && !deprecated_6to4
        && !documentation_v2
        && !ip.is_loopback()
        && !ip.is_unspecified()
        && !ip.is_unique_local()
        && !ip.is_unicast_link_local()
        && !ip.is_multicast()
}

fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => is_public_ipv4(ip),
        IpAddr::V6(ip) => is_public_ipv6(ip),
    }
}

fn validate_event(
    event: &Value,
    request: &RendezvousRelaySampleRequest,
    requested_ids: Option<&BTreeSet<String>>,
) -> Result<String, String> {
    let object = event
        .as_object()
        .ok_or_else(|| "relay returned a malformed event".to_string())?;
    let id = object
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| is_hex_id(id))
        .ok_or_else(|| "relay returned an event with an invalid id".to_string())?;
    if requested_ids.is_some_and(|ids| !ids.contains(id)) {
        return Err(format!("relay returned unrequested event {id}"));
    }
    let content = object
        .get("content")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("relay event {id} has malformed content"))?;
    if content.len() > request.max_content_length {
        return Err(format!("relay event {id} content exceeds limit"));
    }
    let tags = object
        .get("tags")
        .and_then(Value::as_array)
        .ok_or_else(|| format!("relay event {id} has malformed tags"))?;
    if tags.len() > request.max_tags {
        return Err(format!("relay event {id} tag count exceeds limit"));
    }
    for tag in tags {
        let values = tag
            .as_array()
            .ok_or_else(|| format!("relay event {id} has a malformed tag"))?;
        if values.len() > request.max_tag_values
            || values.iter().any(|value| {
                value
                    .as_str()
                    .is_none_or(|value| value.len() > request.max_tag_value_length)
            })
        {
            return Err(format!("relay event {id} has oversized tags"));
        }
    }
    Ok(id.to_string())
}

async fn resolve_public(url: &reqwest::Url) -> Result<Vec<SocketAddr>, String> {
    let host = url
        .host_str()
        .ok_or_else(|| "rendezvous relay URL needs a host".to_string())?;
    let port = url
        .port_or_known_default()
        .ok_or_else(|| "rendezvous relay URL needs a port".to_string())?;
    let mut addresses = if let Ok(ip) = host.parse::<IpAddr>() {
        vec![SocketAddr::new(ip, port)]
    } else {
        lookup_host((host, port))
            .await
            .map_err(|error| format!("resolve rendezvous relay {host}: {error}"))?
            .collect::<Vec<_>>()
    };
    addresses.sort();
    addresses.dedup();
    if addresses.is_empty() {
        return Err("rendezvous relay hostname resolved to no addresses".to_string());
    }
    if addresses.iter().any(|address| !is_public_ip(address.ip())) {
        return Err("rendezvous relay hostname resolved to a non-public address".to_string());
    }
    Ok(addresses)
}

async fn connect_pinned(addresses: &[SocketAddr]) -> Result<TcpStream, String> {
    let mut failures = Vec::new();
    for address in addresses {
        match TcpStream::connect(address).await {
            Ok(stream) => return Ok(stream),
            Err(error) => failures.push(format!("{address}: {error}")),
        }
    }
    Err(format!(
        "could not connect to any validated rendezvous relay address ({})",
        failures.join("; ")
    ))
}

async fn sample(request: RendezvousRelaySampleRequest) -> Result<Vec<Value>, String> {
    if request.url.len() > MAX_URL_BYTES {
        return Err("rendezvous relay URL is too long".to_string());
    }
    let url = reqwest::Url::parse(&request.url)
        .map_err(|_| "rendezvous relay URL is invalid".to_string())?;
    if !matches!(url.scheme(), "ws" | "wss")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("rendezvous relay must be an unauthenticated WebSocket URL".to_string());
    }
    let host = url
        .host_str()
        .ok_or_else(|| "rendezvous relay URL needs a host".to_string())?
        .to_ascii_lowercase();
    if host == "localhost" || host.ends_with(".localhost") || host.ends_with(".onion") {
        return Err("rendezvous relay must be stranger-readable and clearnet".to_string());
    }
    if request.max_unique_events == 0
        || request.max_event_bytes == 0
        || request.max_total_bytes < request.max_event_bytes
        || request.max_unique_events > HARD_MAX_UNIQUE_EVENTS
        || request.max_total_bytes > HARD_MAX_TOTAL_BYTES
        || request.max_event_bytes > HARD_MAX_EVENT_BYTES
        || request.max_content_length > HARD_MAX_CONTENT_BYTES
        || request.max_tags > HARD_MAX_TAGS
        || request.max_tag_values > HARD_MAX_TAG_VALUES
        || request.max_tag_value_length > HARD_MAX_TAG_VALUE_BYTES
        || serde_json::to_vec(&request.filter)
            .map_err(|error| format!("serialize rendezvous relay filter: {error}"))?
            .len()
            > HARD_MAX_FILTER_BYTES
    {
        return Err("rendezvous relay sample bounds are invalid".to_string());
    }
    let requested_ids = request
        .requested_ids
        .as_ref()
        .map(|ids| ids.iter().cloned().collect::<BTreeSet<_>>());
    if requested_ids.as_ref().is_some_and(|ids| {
        ids.len() > HARD_MAX_UNIQUE_EVENTS || ids.iter().any(|id| !is_hex_id(id))
    }) {
        return Err("rendezvous requested ids must be lowercase hex".to_string());
    }

    let addresses = resolve_public(&url).await?;
    let stream = connect_pinned(&addresses).await?;
    stream
        .set_nodelay(true)
        .map_err(|error| format!("configure rendezvous relay socket: {error}"))?;
    let mut websocket_config = WebSocketConfig::default();
    websocket_config.max_message_size = Some(request.max_event_bytes.saturating_add(4_096));
    websocket_config.max_frame_size = Some(request.max_event_bytes.saturating_add(4_096));
    let (mut websocket, _) =
        client_async_tls_with_config(request.url.as_str(), stream, Some(websocket_config), None)
            .await
            .map_err(|error| format!("rendezvous relay WebSocket handshake failed: {error}"))?;

    let subscription = "zine-rendezvous";
    websocket
        .send(Message::Text(
            serde_json::to_string(&json!(["REQ", subscription, request.filter]))
                .map_err(|error| format!("serialize rendezvous relay query: {error}"))?
                .into(),
        ))
        .await
        .map_err(|error| format!("send rendezvous relay query: {error}"))?;

    let mut events = Vec::new();
    let mut seen = BTreeSet::new();
    let mut total_bytes = 0usize;
    while let Some(message) = websocket.next().await {
        let message = message.map_err(|error| format!("read rendezvous relay: {error}"))?;
        if message.is_close() {
            break;
        }
        if !message.is_text() {
            continue;
        }
        let text = message
            .to_text()
            .map_err(|error| format!("decode rendezvous relay frame: {error}"))?;
        total_bytes = total_bytes.saturating_add(text.len());
        if total_bytes > request.max_total_bytes {
            return Err("rendezvous relay sample exceeds total byte limit".to_string());
        }
        let envelope: Value = serde_json::from_str(text)
            .map_err(|_| "rendezvous relay returned malformed JSON".to_string())?;
        let values = envelope
            .as_array()
            .ok_or_else(|| "rendezvous relay returned a malformed envelope".to_string())?;
        match values.first().and_then(Value::as_str) {
            Some("EOSE") if values.get(1).and_then(Value::as_str) == Some(subscription) => break,
            Some("EVENT") if values.get(1).and_then(Value::as_str) == Some(subscription) => {
                let event = values
                    .get(2)
                    .ok_or_else(|| "rendezvous relay omitted its event".to_string())?;
                let encoded = serde_json::to_vec(event)
                    .map_err(|error| format!("measure rendezvous relay event: {error}"))?;
                if encoded.len() > request.max_event_bytes {
                    return Err("rendezvous relay event exceeds byte limit".to_string());
                }
                let id = validate_event(event, &request, requested_ids.as_ref())?;
                if seen.insert(id) {
                    if events.len() >= request.max_unique_events {
                        return Err(
                            "rendezvous relay sample exceeds unique event limit".to_string()
                        );
                    }
                    events.push(event.clone());
                }
            }
            Some("AUTH") => {
                return Err("rendezvous relay requires authentication".to_string());
            }
            _ => {}
        }
    }
    let _ = websocket
        .send(Message::Text(
            serde_json::to_string(&json!(["CLOSE", subscription]))
                .unwrap_or_else(|_| "[\"CLOSE\",\"zine-rendezvous\"]".to_string())
                .into(),
        ))
        .await;
    let _ = websocket.close(None).await;
    Ok(events)
}

#[tauri::command]
pub async fn rendezvous_sample_relay(
    request: RendezvousRelaySampleRequest,
) -> Result<Vec<Value>, String> {
    let timeout_ms = request.timeout_ms.clamp(1, 30_000);
    timeout(Duration::from_millis(timeout_ms), sample(request))
        .await
        .map_err(|_| format!("rendezvous relay sample timed out after {timeout_ms}ms"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn private_and_special_addresses_are_never_connectable() {
        for value in [
            "0.0.0.0",
            "10.0.0.1",
            "100.64.0.1",
            "127.0.0.1",
            "169.254.1.1",
            "172.16.0.1",
            "192.168.1.1",
            "192.0.2.1",
            "198.18.0.1",
            "198.51.100.1",
            "203.0.113.1",
            "224.0.0.1",
        ] {
            assert!(
                !is_public_ip(value.parse().expect("test address")),
                "{value}"
            );
        }
        for value in [
            "::",
            "::1",
            "::ffff:127.0.0.1",
            "fc00::1",
            "fe80::1",
            "2001:2::1",
            "2001:db8::1",
            "2002:7f00:1::",
            "3fff::1",
        ] {
            assert!(
                !is_public_ip(value.parse().expect("test address")),
                "{value}"
            );
        }
    }

    #[test]
    fn public_addresses_remain_connectable() {
        for value in ["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111"] {
            assert!(
                is_public_ip(value.parse().expect("test address")),
                "{value}"
            );
        }
    }

    #[test]
    fn hostile_event_shapes_are_bounded_before_returning_to_javascript() {
        let request = RendezvousRelaySampleRequest {
            url: "wss://relay.example".to_string(),
            filter: json!({}),
            requested_ids: Some(vec!["a".repeat(64)]),
            timeout_ms: 1_000,
            max_unique_events: 1,
            max_total_bytes: 1_000,
            max_event_bytes: 500,
            max_content_length: 4,
            max_tags: 2,
            max_tag_values: 4,
            max_tag_value_length: 20,
        };
        let oversized = json!({
            "id": "a".repeat(64),
            "content": "too long",
            "tags": [],
        });
        assert!(validate_event(
            &oversized,
            &request,
            request
                .requested_ids
                .as_ref()
                .map(|ids| ids.iter().cloned().collect())
                .as_ref(),
        )
        .expect_err("oversized content must fail")
        .contains("content exceeds"));
    }
}

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

#[derive(Clone, Debug, Eq, PartialEq)]
enum LlmRegistryLifecycle {
    Closed,
    Open(crate::VaultRuntimeBinding),
    Closing(crate::VaultRuntimeBinding),
}

struct ActiveLlmRequest {
    binding: crate::VaultRuntimeBinding,
    signal: Arc<LlmCancellationSignal>,
}

struct LlmRequestRegistryState {
    lifecycle: LlmRegistryLifecycle,
    active: HashMap<String, ActiveLlmRequest>,
    pre_cancelled: HashMap<String, Instant>,
    completed: HashMap<String, Instant>,
    fail_closed_until: Option<Instant>,
}

impl Default for LlmRequestRegistryState {
    fn default() -> Self {
        Self {
            // Bootstrap is fail-closed. Only a successful native vault
            // activation may open provider registration for its generation.
            lifecycle: LlmRegistryLifecycle::Closed,
            active: HashMap::new(),
            pre_cancelled: HashMap::new(),
            completed: HashMap::new(),
            fail_closed_until: None,
        }
    }
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
    drained: Arc<Notify>,
}

impl LlmRequestRegistry {
    pub(crate) fn open(&self, binding: &crate::VaultRuntimeBinding) -> Result<(), String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "LLM cancellation registry is unavailable".to_string())?;
        match &state.lifecycle {
            LlmRegistryLifecycle::Closed => {
                if !state.active.is_empty() {
                    return Err(
                        "LLM cancellation registry did not drain before activation".to_string()
                    );
                }
                state.pre_cancelled.clear();
                state.completed.clear();
                state.fail_closed_until = None;
                state.lifecycle = LlmRegistryLifecycle::Open(binding.clone());
                Ok(())
            }
            LlmRegistryLifecycle::Open(current)
                if current == binding
                    && state
                        .active
                        .values()
                        .all(|request| request.binding == *binding) =>
            {
                // Re-activating the already-open vault is idempotent even
                // while its own provider requests are in flight.
                Ok(())
            }
            LlmRegistryLifecycle::Open(_) | LlmRegistryLifecycle::Closing(_) => {
                Err("LLM cancellation registry belongs to another vault activation".to_string())
            }
        }
    }

    fn register(
        &self,
        binding: &crate::VaultRuntimeBinding,
        request_id: &str,
    ) -> Result<LlmRequestRegistration, String> {
        self.register_at(binding, request_id, Instant::now())
    }

    fn register_at(
        &self,
        binding: &crate::VaultRuntimeBinding,
        request_id: &str,
        now: Instant,
    ) -> Result<LlmRequestRegistration, String> {
        validate_request_id(request_id)?;
        let mut state = self
            .state
            .lock()
            .map_err(|_| "LLM cancellation registry is unavailable".to_string())?;
        state.prune(now);
        if !matches!(&state.lifecycle, LlmRegistryLifecycle::Open(current) if current == binding) {
            return Err("LLM provider requests require the active vault generation".to_string());
        }
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
        state.active.insert(
            request_id.to_string(),
            ActiveLlmRequest {
                binding: binding.clone(),
                signal: signal.clone(),
            },
        );
        drop(state);
        Ok(LlmRequestRegistration {
            registry: self.clone(),
            request_id: request_id.to_string(),
            signal,
        })
    }

    fn cancel(&self, journal_generation: u64, request_id: &str) -> Result<(), String> {
        self.cancel_at(journal_generation, request_id, Instant::now())
    }

    fn cancel_at(
        &self,
        journal_generation: u64,
        request_id: &str,
        now: Instant,
    ) -> Result<(), String> {
        validate_request_id(request_id)?;
        let mut state = self
            .state
            .lock()
            .map_err(|_| "LLM cancellation registry is unavailable".to_string())?;
        state.prune(now);
        let lifecycle_matches = matches!(
            &state.lifecycle,
            LlmRegistryLifecycle::Open(binding) | LlmRegistryLifecycle::Closing(binding)
                if binding.generation == journal_generation
        );
        if !lifecycle_matches {
            // A command queued by an older renderer cannot cancel or seed a
            // tombstone inside the next vault activation.
            return Ok(());
        }
        if state.completed.contains_key(request_id) {
            return Ok(());
        }
        if let Some(request) = state.active.get(request_id) {
            if request.binding.generation != journal_generation {
                return Ok(());
            }
            request.signal.cancel();
            return Ok(());
        }
        if !matches!(state.lifecycle, LlmRegistryLifecycle::Open(_)) {
            // After close, a late cancel is harmless and must not create a
            // tombstone that could cross into a later vault activation.
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

    pub(crate) async fn close_for_vault_transition(
        &self,
        binding: &crate::VaultRuntimeBinding,
    ) -> Result<(), String> {
        let mut lifecycle_mismatch = false;
        loop {
            let drained = self.drained.notified();
            let active = {
                let mut state = self
                    .state
                    .lock()
                    .map_err(|_| "LLM cancellation registry is unavailable".to_string())?;
                match &state.lifecycle {
                    LlmRegistryLifecycle::Open(current) if current == binding => {
                        state.lifecycle = LlmRegistryLifecycle::Closing(binding.clone());
                    }
                    LlmRegistryLifecycle::Closing(current) if current == binding => {}
                    LlmRegistryLifecycle::Closed
                    | LlmRegistryLifecycle::Open(_)
                    | LlmRegistryLifecycle::Closing(_) => {
                        lifecycle_mismatch = true;
                        state.lifecycle = LlmRegistryLifecycle::Closing(binding.clone());
                    }
                }
                for request in state.active.values() {
                    request.signal.cancel();
                    if request.binding != *binding {
                        lifecycle_mismatch = true;
                    }
                }
                state.active.len()
            };
            if active == 0 {
                let mut state = self
                    .state
                    .lock()
                    .map_err(|_| "LLM cancellation registry is unavailable".to_string())?;
                if !state.active.is_empty() {
                    continue;
                }
                state.lifecycle = LlmRegistryLifecycle::Closed;
                state.pre_cancelled.clear();
                state.completed.clear();
                state.fail_closed_until = None;
                return if lifecycle_mismatch {
                    Err("LLM cancellation registry had a stale vault binding".to_string())
                } else {
                    Ok(())
                };
            }
            drained.await;
        }
    }

    pub(crate) fn verify_closed(&self) -> Result<(), String> {
        let state = self
            .state
            .lock()
            .map_err(|_| "LLM cancellation registry is unavailable".to_string())?;
        if state.lifecycle != LlmRegistryLifecycle::Closed
            || !state.active.is_empty()
            || !state.pre_cancelled.is_empty()
            || !state.completed.is_empty()
            || state.fail_closed_until.is_some()
        {
            return Err("LLM cancellation registry did not close".to_string());
        }
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
        drop(state);
        self.drained.notify_one();
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

fn require_request_generation(
    binding: &crate::VaultRuntimeBinding,
    journal_generation: u64,
) -> Result<(), String> {
    if binding.generation != journal_generation {
        return Err("LLM request belongs to a stale vault generation".to_string());
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

fn deliver_if_live(
    cancelled: &LlmCancellationSignal,
    data: String,
    on_event: &mut impl FnMut(String) -> Result<(), String>,
) -> Result<(), String> {
    if cancelled.is_cancelled() {
        return Err(CANCELLED_ERROR.to_string());
    }
    on_event(data)
}

fn frame_chunk_if_live(
    cancelled: &LlmCancellationSignal,
    framer: &mut SseFramer,
    chunk: &[u8],
) -> Result<Vec<String>, String> {
    if cancelled.is_cancelled() {
        return Err(CANCELLED_ERROR.to_string());
    }
    Ok(framer.push(chunk))
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
        deliver_if_live(&cancelled, text, &mut on_event)?;
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
        for data in frame_chunk_if_live(&cancelled, &mut framer, &chunk)? {
            deliver_if_live(&cancelled, data, &mut on_event)?;
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
    journal_generation: u64,
    url: String,
    method: String,
    headers: HashMap<String, String>,
    body: String,
    stream: bool,
    on_event: Channel<String>,
) -> Result<(), String> {
    let binding = crate::active_vault_binding()?;
    require_request_generation(&binding, journal_generation)?;
    let registration = registry.register(&binding, &request_id)?;
    crate::require_active_vault_binding(&binding)?;
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
    journal_generation: u64,
) -> Result<(), String> {
    registry.cancel(journal_generation, &request_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::path::PathBuf;
    use std::sync::mpsc::{self, Receiver, Sender};
    use std::thread::JoinHandle;
    use std::time::Duration;

    const REQUEST_ID: &str = "01234567-89ab-cdef-0123-456789abcdef";

    fn binding(generation: u64) -> crate::VaultRuntimeBinding {
        crate::VaultRuntimeBinding {
            id: format!("vault-{generation}"),
            directory: PathBuf::from(format!("/test/vault-{generation}")),
            generation,
        }
    }

    fn open_registry(generation: u64) -> (LlmRequestRegistry, crate::VaultRuntimeBinding) {
        let registry = LlmRequestRegistry::default();
        let binding = binding(generation);
        registry.open(&binding).expect("open test registry");
        (registry, binding)
    }

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
        let (registry, binding) = open_registry(1);
        let registration = registry
            .register(&binding, REQUEST_ID)
            .expect("register request");
        let events = Arc::new(Mutex::new(Vec::new()));
        let recorded = events.clone();
        let (event_tx, event_rx) = mpsc::channel();
        let signal = registration.signal.clone();
        let task = tokio::spawn(async move {
            let _registration = registration;
            execute_llm_fetch(
                url,
                "POST".to_string(),
                HashMap::new(),
                "request".to_string(),
                stream,
                signal,
                move |event| {
                    recorded.lock().expect("event lock").push(event);
                    let _ = event_tx.send(());
                    Ok(())
                },
            )
            .await
        });
        entered
            .recv_timeout(Duration::from_secs(5))
            .expect("reach provider barrier");
        if stream {
            event_rx
                .recv_timeout(Duration::from_secs(5))
                .expect("consume the first stream event before cancellation");
        }
        registry
            .cancel(binding.generation, REQUEST_ID)
            .expect("cancel request");
        let error = task
            .await
            .expect("join request")
            .expect_err("request cancels");
        release.send(()).expect("release fixture server");
        server.join().expect("join fixture server");
        let events = Arc::try_unwrap(events)
            .expect("only test owns events")
            .into_inner()
            .expect("event lock");
        (error, events)
    }

    async fn close_stalled_request(prefix: Vec<u8>, stream: bool) -> (String, Vec<String>) {
        let (url, entered, release, server) = stalled_http_server(prefix);
        let (registry, binding) = open_registry(7);
        let registration = registry
            .register(&binding, REQUEST_ID)
            .expect("register request");
        let events = Arc::new(Mutex::new(Vec::new()));
        let recorded = events.clone();
        let (event_tx, event_rx) = mpsc::channel();
        let signal = registration.signal.clone();
        let task = tokio::spawn(async move {
            let _registration = registration;
            execute_llm_fetch(
                url,
                "POST".to_string(),
                HashMap::new(),
                "request".to_string(),
                stream,
                signal,
                move |event| {
                    recorded.lock().expect("event lock").push(event);
                    let _ = event_tx.send(());
                    Ok(())
                },
            )
            .await
        });
        entered
            .recv_timeout(Duration::from_secs(5))
            .expect("reach provider barrier");
        if stream {
            event_rx
                .recv_timeout(Duration::from_secs(5))
                .expect("consume first event before vault close");
        }
        registry
            .close_for_vault_transition(&binding)
            .await
            .expect("vault close drains request");
        registry
            .verify_closed()
            .expect("registry closed after drain");
        let error = task
            .await
            .expect("join request")
            .expect_err("request cancels");
        release.send(()).expect("release fixture server");
        server.join().expect("join fixture server");
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
    fn bootstrap_is_closed_and_cancel_cannot_seed_the_first_activation() {
        let registry = LlmRequestRegistry::default();
        let first = binding(1);
        assert!(registry.register(&first, REQUEST_ID).is_err());
        registry
            .cancel(first.generation, REQUEST_ID)
            .expect("closed cancel is inert");
        registry.open(&first).expect("open first activation");
        let registration = registry
            .register(&first, REQUEST_ID)
            .expect("first active generation registers");
        assert!(!registration.signal.is_cancelled());
    }

    #[test]
    fn reopening_the_same_activation_is_idempotent_with_active_requests() {
        let (registry, binding) = open_registry(1);
        let registration = registry
            .register(&binding, REQUEST_ID)
            .expect("register request");

        registry
            .open(&binding)
            .expect("same activation remains idempotent");
        assert!(!registration.signal.is_cancelled());
    }

    #[tokio::test]
    async fn close_rejects_late_registration_and_old_generation_cannot_enter_the_next() {
        let (registry, first) = open_registry(1);
        let active = registry
            .register(&first, REQUEST_ID)
            .expect("register first generation");
        let closer_registry = registry.clone();
        let closer_binding = first.clone();
        let closing = tokio::spawn(async move {
            closer_registry
                .close_for_vault_transition(&closer_binding)
                .await
        });
        loop {
            let is_closing = matches!(
                registry.state.lock().expect("registry state").lifecycle,
                LlmRegistryLifecycle::Closing(_)
            );
            if is_closing {
                break;
            }
            tokio::task::yield_now().await;
        }
        assert!(active.signal.is_cancelled());
        assert!(registry
            .register(&first, "11111111-1111-1111-1111-111111111111")
            .is_err());
        drop(active);
        closing
            .await
            .expect("join close")
            .expect("drain first generation");
        assert!(registry
            .register(&first, "22222222-2222-2222-2222-222222222222")
            .is_err());

        let second = binding(2);
        registry.open(&second).expect("open second generation");
        assert!(require_request_generation(&second, first.generation).is_err());
        assert!(registry
            .register(&first, "33333333-3333-3333-3333-333333333333")
            .is_err());
        let next_request_id = "44444444-4444-4444-4444-444444444444";
        registry
            .cancel(first.generation, next_request_id)
            .expect("late prior-generation cancel is inert");
        let next = registry
            .register(&second, next_request_id)
            .expect("second generation registers");
        assert!(!next.signal.is_cancelled());
        assert_eq!(
            registry
                .state
                .lock()
                .expect("registry state")
                .active
                .get(&next.request_id)
                .expect("active second-generation request")
                .binding,
            second,
        );
    }

    #[test]
    fn cancel_before_registration_is_consumed_and_cleanup_is_complete() {
        let (registry, binding) = open_registry(1);
        registry
            .cancel(binding.generation, REQUEST_ID)
            .expect("pre-cancel request");
        registry
            .cancel(binding.generation, REQUEST_ID)
            .expect("idempotent pre-cancel");
        let registration = registry
            .register(&binding, REQUEST_ID)
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
        let (registry, binding) = open_registry(1);
        let registration = registry
            .register(&binding, REQUEST_ID)
            .expect("register request");
        drop(registration);
        registry
            .cancel(binding.generation, REQUEST_ID)
            .expect("late cancel is idempotent");

        {
            let state = registry.state.lock().expect("registry state");
            assert!(state.pre_cancelled.is_empty());
            assert!(state.completed.contains_key(REQUEST_ID));
        }
        assert_eq!(
            registry
                .register(&binding, REQUEST_ID)
                .err()
                .expect("completed id fails closed"),
            "LLM request id is unavailable",
        );
    }

    #[test]
    fn monotonic_ttl_prunes_only_expired_request_ids() {
        let (registry, binding) = open_registry(1);
        let started = Instant::now();
        registry
            .cancel_at(binding.generation, REQUEST_ID, started)
            .expect("create controlled tombstone");
        let before_expiry = started + REQUEST_ID_TTL - Duration::from_millis(1);
        registry
            .cancel_at(binding.generation, REQUEST_ID, before_expiry)
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
            .cancel_at(binding.generation, fresh_id, after_expiry)
            .expect("prune at controlled time");
        let state = registry.state.lock().expect("registry state");
        assert!(!state.pre_cancelled.contains_key(REQUEST_ID));
        assert!(state.pre_cancelled.contains_key(fresh_id));
    }

    #[test]
    fn registry_bounds_fail_closed_without_evicting_pending_cancellation() {
        let (registry, binding) = open_registry(1);
        for index in 0..MAX_PRE_CANCELLED_REQUESTS {
            registry
                .cancel(
                    binding.generation,
                    &format!("00000000-0000-0000-0000-{index:012x}"),
                )
                .expect("fill pre-cancel registry");
        }
        let overflow = "ffffffff-ffff-ffff-ffff-ffffffffffff";
        registry
            .cancel(binding.generation, overflow)
            .expect("overflow fails closed");
        let registration = registry
            .register(&binding, overflow)
            .expect("register during fail-closed interval");
        assert!(registration.signal.cancelled.load(Ordering::Acquire));
    }

    #[test]
    fn completed_registry_overflow_cannot_make_an_evicted_id_dispatchable() {
        let (registry, binding) = open_registry(1);
        for index in 0..=MAX_COMPLETED_REQUESTS {
            let request_id = format!("10000000-0000-0000-0000-{index:012x}");
            let registration = registry
                .register(&binding, &request_id)
                .expect("register completed request");
            drop(registration);
        }
        let evicted = "10000000-0000-0000-0000-000000000000";
        let registration = registry
            .register(&binding, evicted)
            .expect("completed-cache overflow fails closed");
        assert!(registration.signal.is_cancelled());
    }

    #[test]
    fn cancellation_after_nonstream_body_read_fences_ipc_delivery() {
        let signal = LlmCancellationSignal::default();
        let ready_body = "provider body ready for IPC".to_string();
        let mut delivered = Vec::new();
        signal.cancel();
        let error = deliver_if_live(&signal, ready_body, &mut |event| {
            delivered.push(event);
            Ok(())
        })
        .expect_err("post-read cancellation fences delivery");
        assert_eq!(error, CANCELLED_ERROR);
        assert!(delivered.is_empty());
    }

    #[test]
    fn cancellation_after_stream_chunk_framing_fences_every_ipc_event() {
        let signal = LlmCancellationSignal::default();
        let mut framer = SseFramer::default();
        let ready_events = framer.push(b"data: first\n\ndata: second\n\n");
        let mut delivered = Vec::new();
        signal.cancel();
        for event in ready_events {
            let error = deliver_if_live(&signal, event, &mut |data| {
                delivered.push(data);
                Ok(())
            })
            .expect_err("post-chunk cancellation fences delivery");
            assert_eq!(error, CANCELLED_ERROR);
        }
        assert!(delivered.is_empty());
    }

    #[test]
    fn cancellation_after_stream_chunk_read_fences_framing_and_ipc() {
        let signal = LlmCancellationSignal::default();
        let ready_chunk = b"data: provider bytes ready\n\n";
        let mut framer = SseFramer::default();
        signal.cancel();
        let error = frame_chunk_if_live(&signal, &mut framer, ready_chunk)
            .expect_err("post-read cancellation fences stream framing");
        assert_eq!(error, CANCELLED_ERROR);
        assert!(framer.buffer.is_empty());
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

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn vault_close_cancels_and_drains_a_stalled_send() {
        let (error, events) = close_stalled_request(Vec::new(), false).await;
        assert_eq!(error, CANCELLED_ERROR);
        assert!(events.is_empty());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn vault_close_cancels_and_drains_a_stalled_nonstream_body() {
        let prefix = b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\npartial".to_vec();
        let (error, events) = close_stalled_request(prefix, false).await;
        assert_eq!(error, CANCELLED_ERROR);
        assert!(events.is_empty());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn vault_close_cancels_and_drains_a_stalled_stream_body() {
        let event = b"data: {\"choices\":[]}\n\n";
        let prefix = format!(
            "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n{:x}\r\n{}\r\n",
            event.len(),
            String::from_utf8_lossy(event),
        )
        .into_bytes();
        let (error, events) = close_stalled_request(prefix, true).await;
        assert_eq!(error, CANCELLED_ERROR);
        assert_eq!(events, vec!["{\"choices\":[]}".to_string()]);
    }
}

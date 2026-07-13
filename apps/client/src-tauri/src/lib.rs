// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
use std::net::{SocketAddr, TcpStream};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

static RELAY_SPAWNED: AtomicBool = AtomicBool::new(false);

/// Spawn the local zine-relay sidecar if it isn't already up.
///
/// Locates the relay binary via (in order): the `TRACER_RELAY_BIN` env var,
/// the monorepo default `../../../relay/zine-relay` relative to this crate.
/// Then connects to ws://127.0.0.1:4869 — if that's already accepting TCP,
/// we assume a relay is already running (e.g. the harness CLI started one)
/// and don't spawn a second. Otherwise spawn detached and poll the port
/// until it's listening (or timeout).
///
/// This uses std::process::Command rather than tauri-plugin-shell: dev-focused,
/// no bundling sidecar naming conventions to satisfy yet. When this ships as a
/// distributed binary, switch to the plugin's sidecar declaration.
#[tauri::command]
fn spawn_relay() -> Result<String, String> {
    if RELAY_SPAWNED.load(Ordering::SeqCst) {
        return Ok("already spawned".into());
    }

    let addr: SocketAddr = "127.0.0.1:4869"
        .parse::<SocketAddr>()
        .map_err(|e: std::net::AddrParseError| e.to_string())?;

    // Already listening? Don't double-spawn.
    if TcpStream::connect_timeout(&addr, Duration::from_millis(200)).is_ok() {
        RELAY_SPAWNED.store(true, Ordering::SeqCst);
        return Ok("already running".into());
    }

    let bin = resolve_relay_binary()?;

    Command::new(&bin)
        .arg("--host")
        .arg("127.0.0.1")
        .arg("--port")
        .arg("4869")
        .spawn()
        .map_err(|e| format!("failed to spawn relay binary at {}: {}", bin, e))?;

    // Wait for the port to accept connections.
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if Instant::now() > deadline {
            return Err("relay spawned but did not start listening within 5s".into());
        }
        if TcpStream::connect_timeout(&addr, Duration::from_millis(200)).is_ok() {
            RELAY_SPAWNED.store(true, Ordering::SeqCst);
            return Ok("spawned".into());
        }
        std::thread::sleep(Duration::from_millis(150));
    }
}

fn resolve_relay_binary() -> Result<String, String> {
    if let Ok(bin) = std::env::var("TRACER_RELAY_BIN") {
        if std::path::Path::new(&bin).exists() {
            return Ok(bin);
        }
        return Err(format!("TRACER_RELAY_BIN set but not found: {}", bin));
    }
    // Monorepo default: src-tauri/ -> ../../../relay/zine-relay
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    let candidate = std::path::Path::new(manifest_dir)
        .join("../../../relay/zine-relay");
    let candidate = candidate.canonicalize().unwrap_or(candidate);
    if candidate.exists() {
        return Ok(candidate.to_string_lossy().into_owned());
    }
    Err(format!(
        "no relay binary found. Build it: cd relay && go build -o zine-relay . — or set TRACER_RELAY_BIN. (looked for: {})",
        candidate.display()
    ))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![greet, spawn_relay])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

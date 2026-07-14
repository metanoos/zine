// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use serde::Serialize;
use tauri::{ipc::Channel, Manager, path::BaseDirectory};

static RELAY_SPAWNED: AtomicBool = AtomicBool::new(false);

// Same set the harness skips when walking a watched folder (store.ts).
const IGNORED_SEGMENTS: &[&str] = &[
    ".git",
    "node_modules",
    ".next",
    ".dart_tool",
    "build",
    ".tracer",
    ".zine",
    ".DS_Store",
];

/// Spawn the local zine-relay sidecar if it isn't already up.
///
/// Locates the relay binary via (in order):
///   1. `TRACER_RELAY_BIN` env var (dev override / pointing at a custom build)
///   2. the bundled resource `binaries/zine-relay` (installed app — this is the
///      path that makes a distributed build actually run)
///   3. the monorepo default `../../../relay/zine-relay` relative to this
///      crate (`tauri dev` from a checkout)
///
/// Then connects to ws://127.0.0.1:4869 — if that's already accepting TCP, we
/// assume a relay is already running (e.g. the harness CLI started one) and
/// don't spawn a second. Otherwise spawn detached and poll the port until it's
/// listening (or timeout).
///
/// Uses std::process::Command rather than tauri-plugin-shell's sidecar
/// declaration: the resource is bundled via `bundle.resources` in
/// tauri.conf.json, which avoids the target-triple rename convention while
/// still shipping the binary inside the installer.
#[tauri::command]
async fn spawn_relay(app: tauri::AppHandle) -> Result<String, String> {
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

    let bin = resolve_relay_binary(&app)?;

    // The bundled resource may not be executable on disk (resource_dir copy
    // preserves mode on some platforms, not others). Make sure the owner can
    // execute before spawning — otherwise the Command fails with EACCES.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = fs::metadata(&bin) {
            let mut perms = meta.permissions();
            if (perms.mode() & 0o100) == 0 {
                perms.set_mode(perms.mode() | 0o100);
                let _ = fs::set_permissions(&bin, perms);
            }
        }
    }

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

/// Resolve the relay binary path across dev and installed-app layouts.
fn resolve_relay_binary(app: &tauri::AppHandle) -> Result<String, String> {
    // 1. Explicit env override (dev convenience / custom build).
    if let Ok(bin) = std::env::var("TRACER_RELAY_BIN") {
        if Path::new(&bin).exists() {
            return Ok(bin);
        }
        return Err(format!("TRACER_RELAY_BIN set but not found: {}", bin));
    }
    // 2. Bundled resource — the path that matters for a distributed build.
    //    `binaries/zine-relay` is declared in tauri.conf.json bundle.resources.
    if let Ok(resource) = app.path().resolve("binaries/zine-relay", BaseDirectory::Resource) {
        if resource.exists() {
            return Ok(resource.to_string_lossy().into_owned());
        }
    }
    // 3. Monorepo default: src-tauri/ -> ../../../relay/zine-relay (tauri dev).
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    let candidate = Path::new(manifest_dir).join("../../../relay/zine-relay");
    let candidate = candidate.canonicalize().unwrap_or(candidate);
    if candidate.exists() {
        return Ok(candidate.to_string_lossy().into_owned());
    }
    Err(format!(
        "no relay binary found. Build it: cd relay && go build -o zine-relay . — or set TRACER_RELAY_BIN. (looked for bundled resource, then: {})",
        candidate.display()
    ))
}

// --- disk backing for the workspace -------------------------------------
//
// The desktop client's source of truth is a real folder on disk; the relay
// holds provenance. These commands are the only disk surface the webview
// gets — there's no tauri-plugin-fs exposed to JS. Every path the webview
// sends is a relative path resolved against `root`, and `resolve_under`
// rejects anything that escapes the root (absolute paths, `..` traversal),
// so the webview can't touch files outside the attached folder.

/// Resolve `relative` under `root`, rejecting traversal outside the root.
fn resolve_under(root: &str, relative: &str) -> Result<PathBuf, String> {
    let root_path = PathBuf::from(root);
    let joined = if Path::new(relative).is_absolute() {
        // Treat an absolute path as an error rather than honoring it — the
        // contract is "relative path under root".
        return Err(format!("path must be relative to the folder root: {relative}"));
    } else {
        root_path.join(relative)
    };
    // canonicalize collapses any `..` segments. If the file doesn't exist
    // yet (we're about to create it), canonicalize the parent instead and
    // re-append the file name.
    let canon = match joined.canonicalize() {
        Ok(p) => p,
        Err(_) => {
            let parent = joined.parent().unwrap_or_else(|| Path::new(""));
            let file_name = joined.file_name();
            let parent_canon = parent
                .canonicalize()
                .map_err(|e| format!("parent folder does not exist ({}): {}", parent.display(), e))?;
            match file_name {
                Some(name) => parent_canon.join(name),
                None => parent_canon,
            }
        }
    };
    // Final containment check: the canonical path must start with the
    // canonical root. This is what actually stops `..` escapes.
    let root_canon = root_path
        .canonicalize()
        .map_err(|e| format!("root folder does not exist: {}", e))?;
    if !canon.starts_with(&root_canon) {
        return Err(format!("path escapes the folder root: {}", relative));
    }
    Ok(canon)
}

#[derive(Serialize)]
struct DirEntry {
    relative_path: String,
    is_dir: bool,
}

/// Native folder picker. Returns the chosen absolute path, or null if the
/// user cancelled. Uses the dialog plugin's blocking variant, which runs
/// the native OS picker and resolves when the user confirms or cancels.
#[tauri::command]
async fn pick_folder(app: tauri::AppHandle) -> Result<Option<String>, String> {
    // blocking_pick_folder() runs the native OS picker and parks the calling
    // thread until the user confirms or cancels. It must NOT run on the main
    // thread (it deadlocks: the dialog result is dispatched through the
    // main-thread event loop, which is the very thread it blocks), so this
    // command is `async` — Tauri then runs it on the async runtime and leaves
    // the main thread free to pump the dialog's completion. See
    // tauri-plugin-dialog's own blocking_* docs.
    use tauri_plugin_dialog::DialogExt;
    let chosen = app
        .dialog()
        .file()
        .set_title("Choose a folder to manage")
        .blocking_pick_folder();
    match chosen {
        Some(fp) => {
            let path = fp.into_path().map_err(|e| format!("invalid path: {}", e))?;
            Ok(Some(path.to_string_lossy().into_owned()))
        }
        None => Ok(None),
    }
}

/// Recursively list a folder, returning relative paths (relative to `root`).
/// Skips the same ignored segments as the harness walker. Both files AND
/// directories are emitted as entries — directories carry `is_dir: true` with
/// their own relative path, then recursion populates their contents. This
/// mirrors the harness's `scanDir` (store.ts), which uses `readdirSync({
/// withFileTypes: true })` and branches on `entry.isDirectory()`.
///
/// The client's `baselineScan` (workspace.ts) groups entries by directory and
/// dispatches on `is_dir`: a directory entry mints a `kind: "folder"` member
/// with its own genesis and recurses, exactly like the harness. Returning
/// only files (an earlier shape) left the `isDir` branch dead and silently
/// dropped every nested file on attach — empty subdirectories were lost too.
#[tauri::command]
fn list_dir(root: String) -> Result<Vec<DirEntry>, String> {
    let root_path = PathBuf::from(&root);
    let root_canon = root_path
        .canonicalize()
        .map_err(|e| format!("root folder does not exist: {}", e))?;
    let mut out = Vec::new();
    walk_dir(&root_canon, &root_canon, &mut out)?;
    out.sort_by(|a, b| a.relative_path.cmp(&b.relative_path));
    Ok(out)
}

fn walk_dir(dir: &Path, root: &Path, out: &mut Vec<DirEntry>) -> Result<(), String> {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(e) => return Err(format!("failed to read {}: {}", dir.display(), e)),
    };
    for entry in entries {
        let entry = entry.map_err(|e| format!("dir entry error: {}", e))?;
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if IGNORED_SEGMENTS.iter().any(|seg| *seg == name_str) {
            continue;
        }
        let path = entry.path();
        let ft = entry
            .file_type()
            .map_err(|e| format!("file type error for {}: {}", path.display(), e))?;
        if ft.is_dir() {
            let rel = path
                .strip_prefix(root)
                .map_err(|e| format!("strip_prefix failed: {}", e))?
                .to_string_lossy()
                .into_owned();
            // Emit the directory itself before recursing, so the client's
            // baselineScan sees the folder-member and mints its genesis —
            // mirroring the harness's readdirSync withFileTypes branch.
            out.push(DirEntry {
                relative_path: rel,
                is_dir: true,
            });
            walk_dir(&path, root, out)?;
        } else if ft.is_file() {
            let rel = path
                .strip_prefix(root)
                .map_err(|e| format!("strip_prefix failed: {}", e))?
                .to_string_lossy()
                .into_owned();
            out.push(DirEntry {
                relative_path: rel,
                is_dir: false,
            });
        }
    }
    Ok(())
}

/// Read a file as UTF-8 text. Non-UTF8 files (binaries) return an error
/// rather than garbage — the editor only handles text.
#[tauri::command]
fn read_text_file(root: String, relative_path: String) -> Result<String, String> {
    let abs = resolve_under(&root, &relative_path)?;
    let bytes = fs::read(&abs).map_err(|e| format!("read {}: {}", abs.display(), e))?;
    String::from_utf8(bytes)
        .map_err(|_| format!("{} is not valid UTF-8 (binary files aren't editable)", abs.display()))
}

/// Write text to a file, creating parent directories as needed.
#[tauri::command]
fn write_text_file(root: String, relative_path: String, contents: String) -> Result<(), String> {
    let abs = resolve_under(&root, &relative_path)?;
    if let Some(parent) = abs.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("create dirs {}: {}", parent.display(), e))?;
    }
    fs::write(&abs, contents).map_err(|e| format!("write {}: {}", abs.display(), e))
}

/// Delete a file. Folder deletes go through `delete_folder` (recursive).
#[tauri::command]
fn delete_file(root: String, relative_path: String) -> Result<(), String> {
    let abs = resolve_under(&root, &relative_path)?;
    fs::remove_file(&abs).map_err(|e| format!("delete {}: {}", abs.display(), e))
}

/// Recursively delete a folder. Refuses to delete the root itself.
#[tauri::command]
fn delete_folder(root: String, relative_path: String) -> Result<(), String> {
    let abs = resolve_under(&root, &relative_path)?;
    let root_canon = PathBuf::from(&root)
        .canonicalize()
        .map_err(|e| format!("root folder does not exist: {}", e))?;
    if abs == root_canon {
        return Err("refusing to delete the folder root".into());
    }
    fs::remove_dir_all(&abs).map_err(|e| format!("delete {}: {}", abs.display(), e))
}

/// Create a directory (including parents). No-op if it already exists.
/// Folders have no provenance node of their own — they're implicit in file
/// paths, same as the harness.
#[tauri::command]
fn create_folder(root: String, relative_path: String) -> Result<(), String> {
    let abs = resolve_under(&root, &relative_path)?;
    fs::create_dir_all(&abs).map_err(|e| format!("create {}: {}", abs.display(), e))
}

/// Move `src_relative` into `dest_folder_relative` ("" = root), keeping the
/// same basename. Tries a fast rename; falls back to copy+remove for
/// cross-volume moves. Both src and dest must stay under `root`.
#[tauri::command]
fn move_path(root: String, src_relative: String, dest_folder_relative: String) -> Result<(), String> {
    let src_abs = resolve_under(&root, &src_relative)?;
    let name = src_abs
        .file_name()
        .ok_or_else(|| "source has no file name".to_string())?;
    let dest_relative = if dest_folder_relative.is_empty() {
        name.to_string_lossy().into_owned()
    } else {
        format!("{}/{}", dest_folder_relative, name.to_string_lossy())
    };
    let dest_abs = resolve_under(&root, &dest_relative)?;
    if dest_abs.exists() {
        return Err(format!(
            "destination already exists: {}",
            dest_abs.display()
        ));
    }
    if let Some(parent) = dest_abs.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("create dest dirs {}: {}", parent.display(), e))?;
    }
    match fs::rename(&src_abs, &dest_abs) {
        Ok(()) => Ok(()),
        Err(_) => {
            // Cross-device / cross-volume: copy then remove.
            copy_recursive(&src_abs, &dest_abs)?;
            if src_abs.is_dir() {
                fs::remove_dir_all(&src_abs)
            } else {
                fs::remove_file(&src_abs)
            }
            .map_err(|e| format!("remove old after copy: {}", e))
        }
    }
}

/// Rename `src_relative` (file or folder) to `new_name` within its current
/// parent. Same rename + cross-volume fallback as `move_path`, just keeping the
/// parent and swapping only the basename. `new_name` must not be empty or
/// contain a path separator (the UI guards this too). Rejects if the resolved
/// destination already exists.
#[tauri::command]
fn rename_path(root: String, src_relative: String, new_name: String) -> Result<(), String> {
    if new_name.is_empty() || new_name == "." || new_name == ".." {
        return Err(format!("invalid new name: {:?}", new_name));
    }
    if new_name.contains('/') || new_name.contains('\\') {
        return Err("new name must not contain a path separator".to_string());
    }
    let src_abs = resolve_under(&root, &src_relative)?;
    let dest_abs = src_abs
        .parent()
        .map(|p| p.join(&new_name))
        .ok_or_else(|| "source has no parent directory".to_string())?;
    // dest is src's parent joined with a bare name, so it can't escape the
    // workspace root (src was already under it, and the name has no separator).
    if dest_abs.exists() {
        return Err(format!(
            "destination already exists: {}",
            dest_abs.display()
        ));
    }
    match fs::rename(&src_abs, &dest_abs) {
        Ok(()) => Ok(()),
        Err(_) => {
            // Cross-device / cross-volume: copy then remove.
            copy_recursive(&src_abs, &dest_abs)?;
            if src_abs.is_dir() {
                fs::remove_dir_all(&src_abs)
            } else {
                fs::remove_file(&src_abs)
            }
            .map_err(|e| format!("remove old after copy: {}", e))
        }
    }
}

fn copy_recursive(src: &Path, dest: &Path) -> Result<(), String> {
    if src.is_dir() {
        fs::create_dir_all(dest).map_err(|e| format!("mkdir {}: {}", dest.display(), e))?;
        for entry in fs::read_dir(src).map_err(|e| format!("readdir {}: {}", src.display(), e))? {
            let entry = entry.map_err(|e| format!("dir entry: {}", e))?;
            let entry_name = entry.file_name();
            copy_recursive(&entry.path(), &dest.join(entry_name))?;
        }
        Ok(())
    } else {
        fs::copy(src, dest).map_err(|e| format!("copy {} -> {}: {}", src.display(), dest.display(), e))?;
        Ok(())
    }
}

/// A sensible default to offer on first run: `$HOME/zine` if it exists.
/// Returns null otherwise — the user must pick explicitly.
#[tauri::command]
fn attached_folder_default() -> Result<Option<String>, String> {
    if let Some(home) = dirs_home() {
        let candidate = home.join("zine");
        if candidate.is_dir() {
            return Ok(Some(candidate.to_string_lossy().into_owned()));
        }
    }
    Ok(None)
}

fn dirs_home() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .filter(|p| p.is_dir())
}

// --- LLM fetch proxy ----------------------------------------------------
//
// The webview can't reliably `fetch()` cross-origin LLM providers — some
// responses arrive double-stamped with `Access-Control-Allow-Origin` (e.g.
// `http://localhost:1420, *`), which browsers reject. Routing the request
// through native HTTP sidesteps CORS entirely: there's no browser in the loop.
//
// SSE streaming is the wrinkle: the caller (llm.ts) passes an `onDelta` to get
// content chunks as they arrive. A plain `Result` can't deliver mid-flight
// chunks, so we forward each SSE event over the Tauri `ipc::Channel` as we see
// it, and resolve `Ok(())` when the stream closes. Protocol-specific JSON
// parsing stays in JS — Rust only does SSE framing (split on blank line, join
// `data:` lines), mirroring llm.ts's `consumeSSE`. Non-streaming calls emit one
// message holding the full body, then resolve.

/// One message forwarded to the webview over `on_event`. For streaming
/// responses this is a single SSE event's joined `data:` payload; for
/// non-streaming responses it's the full response body.
#[tauri::command]
async fn llm_fetch(
    url: String,
    method: String,
    headers: std::collections::HashMap<String, String>,
    body: String,
    stream: bool,
    on_event: Channel<String>,
) -> Result<(), String> {
    let client = reqwest::Client::new();
    let mut req = match method.to_ascii_uppercase().as_str() {
        "POST" => client.post(&url),
        "GET" => client.get(&url),
        _ => return Err(format!("unsupported method: {method}")),
    };
    let mut header_map = reqwest::header::HeaderMap::new();
    for (k, v) in &headers {
        let name = reqwest::header::HeaderName::from_bytes(k.as_bytes())
            .map_err(|e| format!("bad header name {k:?}: {e}"))?;
        let value = reqwest::header::HeaderValue::from_str(v)
            .map_err(|e| format!("bad header value for {k}: {e}"))?;
        header_map.append(name, value);
    }
    req = req.headers(header_map).body(body);

    let resp = req
        .send()
        .await
        .map_err(|e| format!("LLM request failed: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        let snippet = if text.len() > 500 {
            format!("{}…", &text[..500])
        } else {
            text
        };
        return Err(format!("HTTP {}: {}", status.as_u16(), snippet));
    }

    if !stream {
        let text = resp
            .text()
            .await
            .map_err(|e| format!("read body: {e}"))?;
        on_event
            .send(text)
            .map_err(|e| format!("ipc send failed: {e}"))?;
        return Ok(());
    }

    let mut byte_stream = resp.bytes_stream();
    let mut buffer = String::new();
    while let Some(chunk_result) = byte_stream.next().await {
        let chunk = chunk_result.map_err(|e| format!("stream chunk: {e}"))?;
        buffer.push_str(&String::from_utf8_lossy(&chunk));
        while let Some(idx) = buffer.find("\n\n") {
            let raw_event = buffer[..idx].to_string();
            buffer = buffer[idx + 2..].to_string();
            let data = extract_sse_data(&raw_event);
            if data.is_empty() {
                continue;
            }
            on_event
                .send(data)
                .map_err(|e| format!("ipc send failed: {e}"))?;
        }
    }
    Ok(())
}

/// Extract the joined `data:` payload from one raw SSE event block, mirroring
/// llm.ts's framing: collect every line starting with `data:`, strip the
/// prefix, trim one leading space, and join the remainder with `\n`. Returns
/// an empty string for events with no `data:` field (comments, keep-alives).
fn extract_sse_data(raw_event: &str) -> String {
    let lines: Vec<&str> = raw_event
        .lines()
        .filter_map(|l| l.strip_prefix("data:"))
        .map(|rest| rest.strip_prefix(' ').unwrap_or(rest))
        .collect();
    lines.join("\n")
}

// --- Friend ACL management ----------------------------------------------
//
// The relay reads ~/.tracer/friends.json (siblings to the relay DB) to decide
// who may connect. These commands let the webview manage that file without
// touching the filesystem directly (no tauri-plugin-fs exposed to JS). The
// relay re-reads the file on its 5s poll, so changes take effect without a
// restart. See relay/friends.go + protocol/transport.md §5.

/// On-disk shape, matching relay/friends.go's FriendsFile.
#[derive(serde::Deserialize, serde::Serialize, Clone)]
struct FriendsFile {
    owner: String,
    friends: Vec<String>,
}

/// Resolve ~/.tracer/friends.json — the same path the relay uses (sibling to
/// the relay DB at ~/.tracer/relay.sqlite3).
fn friends_json_path() -> Result<PathBuf, String> {
    let home = dirs_home().ok_or("could not determine home directory")?;
    Ok(home.join(".tracer").join("friends.json"))
}

/// Read friends.json. Returns a default (empty owner, no friends) if the file
/// doesn't exist yet — that's the open-mode state.
fn read_friends_file() -> Result<FriendsFile, String> {
    let path = friends_json_path()?;
    if !path.exists() {
        return Ok(FriendsFile {
            owner: String::new(),
            friends: Vec::new(),
        });
    }
    let raw = fs::read_to_string(&path)
        .map_err(|e| format!("read {}: {}", path.display(), e))?;
    serde_json::from_str(&raw).map_err(|e| format!("parse {}: {}", path.display(), e))
}

/// Write friends.json atomically (temp + rename), mirroring operator.go's
/// persistence pattern. Writes to a sibling temp file then renames, so a crash
/// mid-write never leaves a corrupt file.
fn write_friends_file(data: &FriendsFile) -> Result<(), String> {
    let path = friends_json_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("create {}: {}", parent.display(), e))?;
    }
    let json = serde_json::to_string_pretty(data)
        .map_err(|e| format!("serialize friends.json: {e}"))?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, json)
        .map_err(|e| format!("write {}: {}", tmp.display(), e))?;
    fs::rename(&tmp, &path)
        .map_err(|e| format!("rename {} -> {}: {}", tmp.display(), path.display(), e))
}

/// Validate a hex pubkey: 64 lowercase hex chars (32 bytes). Matches
/// relay/friends.go's isValidPubkey.
fn is_valid_pubkey(s: &str) -> bool {
    s.len() == 64 && s.chars().all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c))
}

#[derive(Serialize)]
struct FriendsState {
    owner: String,
    friends: Vec<String>,
    /// Whether the relay is in friend mode (owner is set) vs open mode.
    friend_mode: bool,
}

/// Read the current friend ACL. friend_mode is true when an owner is set —
/// that's what activates the relay's NIP-42 AUTH requirement.
#[tauri::command]
fn list_friends() -> Result<FriendsState, String> {
    let ff = read_friends_file()?;
    Ok(FriendsState {
        friend_mode: is_valid_pubkey(&ff.owner),
        owner: ff.owner,
        friends: ff.friends,
    })
}

/// Set the owner pubkey. This is what activates friend mode — until an owner is
/// set, the relay stays in open mode (no AUTH required).
#[tauri::command]
fn set_owner(pubkey: String) -> Result<FriendsState, String> {
    if !is_valid_pubkey(&pubkey) {
        return Err(format!(
            "invalid pubkey (expected 64 lowercase hex chars): {}",
            pubkey
        ));
    }
    let mut ff = read_friends_file()?;
    ff.owner = pubkey;
    write_friends_file(&ff)?;
    list_friends()
}

/// Add a friend pubkey (read-only access). Dedupes — adding the same key twice
/// is a no-op. Refuses to add the owner as a friend (the owner has write
/// access, not read-only).
#[tauri::command]
fn add_friend(pubkey: String) -> Result<FriendsState, String> {
    if !is_valid_pubkey(&pubkey) {
        return Err(format!(
            "invalid pubkey (expected 64 lowercase hex chars): {}",
            pubkey
        ));
    }
    let mut ff = read_friends_file()?;
    if ff.owner == pubkey {
        return Err("that pubkey is the owner (owners have write access, not friend access)".into());
    }
    if !ff.friends.contains(&pubkey) {
        ff.friends.push(pubkey);
        write_friends_file(&ff)?;
    }
    list_friends()
}

/// Remove a friend pubkey.
#[tauri::command]
fn remove_friend(pubkey: String) -> Result<FriendsState, String> {
    let mut ff = read_friends_file()?;
    ff.friends.retain(|p| p != &pubkey);
    write_friends_file(&ff)?;
    list_friends()
}

// --- Tor sidecar: inbound reachability via onion service -----------------
//
// The desktop relay is 127.0.0.1-only. Friends reach it through a Tor onion
// service: Tor forwards inbound onion connections to the relay's localhost
// port. The onion address is derived from the Nostr key (see onion-key.ts +
// protocol/transport.md §3), so it's stable across reinstalls and networks.
//
// The key never touches disk. The press derives the 32-byte ed25519 seed
// (pure crypto), passes it here as base64, and this command hands it to Tor's
// control port inline via `ADD_ONION ED25519-V3:<base64>`. On next launch,
// re-derived and re-registered — no ~/.tracer/onion-key file (transport.md §3.4).

static TOR_SPAWNED: AtomicBool = AtomicBool::new(false);

/// Spawn the Tor daemon if it isn't already up. Mirrors spawn_relay: locate the
/// binary, spawn detached, poll the SOCKS port for readiness. Returns "running"
/// / "spawned" / "already spawned" so the caller can decide whether to set up
/// the onion service next.
#[tauri::command]
async fn spawn_tor(app: tauri::AppHandle) -> Result<String, String> {
    if TOR_SPAWNED.load(Ordering::SeqCst) {
        return Ok("already spawned".into());
    }

    let socks_addr: SocketAddr = "127.0.0.1:9050"
        .parse()
        .map_err(|e: std::net::AddrParseError| e.to_string())?;

    // Already listening? Don't double-spawn (a system tor, or a prior launch).
    if TcpStream::connect_timeout(&socks_addr, Duration::from_millis(200)).is_ok() {
        TOR_SPAWNED.store(true, Ordering::SeqCst);
        return Ok("already running".into());
    }

    let bin = resolve_tor_binary(&app)?;

    // The Tor data directory stores descriptors etc. Keep it under the app data
    // dir so it's cleaned up with the app, not scattered in the user's home.
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("could not resolve app data dir: {e}"))?
        .join(".tor");
    fs::create_dir_all(&data_dir)
        .map_err(|e| format!("could not create tor data dir: {e}"))?;

    // Cookie auth for the control port — safer than a hashed password (no
    // shared secret to leak) and the standard ADD_ONION path. Detached so Tor
    // survives the app process if needed (matches the relay's spawn posture).
    Command::new(&bin)
        .arg("--SocksPort")
        .arg("9050")
        .arg("--ControlPort")
        .arg("127.0.0.1:9051")
        .arg("--CookieAuthentication")
        .arg("1")
        .arg("--CookieAuthFile")
        .arg(data_dir.join("control_auth_cookie"))
        .arg("--DataDirectory")
        .arg(&data_dir)
        .arg("--Log")
        .arg("notice stdout")
        .spawn()
        .map_err(|e| format!("failed to spawn tor binary at {}: {}", bin, e))?;

    // Wait for the SOCKS port to accept connections (Tor's readiness signal).
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        if Instant::now() > deadline {
            return Err("tor spawned but did not start listening within 15s".into());
        }
        if TcpStream::connect_timeout(&socks_addr, Duration::from_millis(200)).is_ok() {
            TOR_SPAWNED.store(true, Ordering::SeqCst);
            return Ok("spawned".into());
        }
        std::thread::sleep(Duration::from_millis(300));
    }
}

/// Resolve the tor binary path, mirroring resolve_relay_binary's ladder:
///   1. TRACER_TOR_BIN env var (dev override / pointing at system tor)
///   2. bundled resource binaries/tor (installed app)
///   3. system `tor` on PATH (dev convenience — brew install tor)
fn resolve_tor_binary(app: &tauri::AppHandle) -> Result<String, String> {
    if let Ok(bin) = std::env::var("TRACER_TOR_BIN") {
        if Path::new(&bin).exists() {
            return Ok(bin);
        }
        return Err(format!("TRACER_TOR_BIN set but not found: {}", bin));
    }
    if let Ok(resource) = app.path().resolve("binaries/tor", BaseDirectory::Resource) {
        if resource.exists() {
            // Ensure the exec bit is set (same fixup as the relay binary).
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if let Ok(meta) = fs::metadata(&resource) {
                    let mut perms = meta.permissions();
                    if (perms.mode() & 0o100) == 0 {
                        perms.set_mode(perms.mode() | 0o100);
                        let _ = fs::set_permissions(&resource, perms);
                    }
                }
            }
            return Ok(resource.to_string_lossy().into_owned());
        }
    }
    // 3. System tor on PATH — `which tor` equivalent. Common in dev (brew/apt).
    if let Ok(path) = std::env::var("PATH") {
        for dir in path.split(':') {
            let candidate = Path::new(dir).join("tor");
            if candidate.exists() {
                return Ok(candidate.to_string_lossy().into_owned());
            }
        }
    }
    Err(
        "no tor binary found. Install it (macOS: brew install tor; Linux: apt install tor) \
         and set TRACER_TOR_BIN, or bundle it at binaries/tor."
            .into(),
    )
}

/// Create (or re-create) the onion service, forwarding onion port 80 to the
/// relay at 127.0.0.1:4869. The seed is the 32-byte ed25519 key derived from
/// the Nostr secret (see onion-key.ts), passed as base64. Returns the .onion
/// address Tor reports — which MUST match the address the press computed
/// independently (pure crypto, no Tor). A mismatch means the seed was corrupted
/// in transit; the caller should treat it as an error.
#[tauri::command]
async fn setup_onion(app: tauri::AppHandle, seed_base64: String) -> Result<String, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("could not resolve app data dir: {e}"))?
        .join(".tor");
    let cookie_path = data_dir.join("control_auth_cookie");

    // Connect to Tor's control port (line-based text protocol, RFC-ish).
    let mut stream = TcpStream::connect("127.0.0.1:9051")
        .map_err(|e| format!("could not connect to tor control port: {e}"))?;
    let mut reader = BufReader::new(stream.try_clone().unwrap());

    // Authenticate via cookie. Tor sends the hex-encoded cookie on connect.
    let cookie_hex = fs::read(&cookie_path)
        .map_err(|e| format!("could not read control auth cookie: {e}"))
        .map(|bytes| {
            bytes.iter().map(|b| format!("{:02x}", b)).collect::<String>()
        })?;
    let auth_cmd = format!("AUTHENTICATE {}\r\n", cookie_hex);
    stream
        .write_all(auth_cmd.as_bytes())
        .map_err(|e| format!("control write AUTHENTICATE: {e}"))?;
    read_control_reply(&mut reader, "AUTHENTICATE")?;

    // ADD_ONION with the derived key. Port=80,127.0.0.1:4869 means inbound
    // onion port 80 forwards to the relay's localhost port. The key is passed
    // inline — never persisted to disk by Tor (transport.md §3.4).
    let add_cmd = format!(
        "ADD_ONION ED25519-V3:{} Port=80,127.0.0.1:4869\r\n",
        seed_base64
    );
    stream
        .write_all(add_cmd.as_bytes())
        .map_err(|e| format!("control write ADD_ONION: {e}"))?;

    // The reply contains a line like: 250-ServiceID=<address-without-.onion>
    let reply = read_control_reply(&mut reader, "ADD_ONION")?;
    for line in &reply {
        if let Some(rest) = line.strip_prefix("ServiceID=") {
            return Ok(format!("{}.onion", rest));
        }
    }
    Err(format!(
        "ADD_ONION succeeded but no ServiceID in reply: {:?}",
        reply
    ))
}

/// Read a Tor control-port reply for the given command, returning the lines of
/// the (250 OK) response. Tor uses 3-digit codes: 6xx = multiline, 250 = OK.
/// We read until a line whose 4th char is a space (not '-'), which ends the
/// reply. Non-250 final codes are errors.
fn read_control_reply<R: BufRead>(
    reader: &mut R,
    label: &str,
) -> Result<Vec<String>, String> {
    let mut lines = Vec::new();
    loop {
        let mut line = String::new();
        let n = reader
            .read_line(&mut line)
            .map_err(|e| format!("control read ({label}): {e}"))?;
        if n == 0 {
            return Err(format!("control port closed during {}", label));
        }
        // Tor control replies: "xyz-text" where xyz is a 3-digit code. If the
        // 4th char is '-', more lines follow; if it's ' ' (space), this is the
        // final line. We collect the text of each line.
        let trimmed = line.trim_end_matches(|c| c == '\r' || c == '\n');
        if trimmed.len() >= 4 {
            let code = &trimmed[..3];
            let sep = trimmed.as_bytes()[3] as char;
            // The informational part is after the code+separator.
            lines.push(trimmed[4..].to_string());
            if sep == ' ' {
                if code != "250" {
                    return Err(format!("{} failed: {}", label, trimmed));
                }
                return Ok(lines);
            }
        }
    }
}

/// Derive the onion address from the Nostr secret — but the secret lives in the
/// webview's localStorage (browser-side identity), not in Rust. So this command
/// is a thin pass-through: the webview computes the seed + address (onion-key.ts,
/// pure crypto), and calls this only to verify Tor agrees. The actual derivation
/// is done in TypeScript so the Nostr secret never crosses the IPC boundary
/// more than once (as the derived seed, not the raw secret).
///
/// In practice the webview calls setup_onion(seedBase64) directly; this command
/// exists for the "show the address before Tor is running" path (the address is
/// computable from pure crypto, no Tor needed).
#[tauri::command]
async fn derive_onion_address() -> Result<String, String> {
    Err(
        "onion derivation is browser-side (onion-key.ts) — the Nostr secret \
         never enters Rust. Call setup_onion(seedBase64) with the derived seed."
            .into(),
    )
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            spawn_relay,
            pick_folder,
            list_dir,
            read_text_file,
            write_text_file,
            delete_file,
            delete_folder,
            create_folder,
            move_path,
            rename_path,
            attached_folder_default,
            llm_fetch,
            spawn_tor,
            setup_onion,
            derive_onion_address,
            list_friends,
            set_owner,
            add_friend,
            remove_friend,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

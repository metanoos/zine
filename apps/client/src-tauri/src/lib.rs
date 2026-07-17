// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
mod llm_proxy;

use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use base64::Engine;
use serde::Serialize;
use tauri::{path::BaseDirectory, Manager};

static RELAY_SPAWNED: AtomicBool = AtomicBool::new(false);
const SECRET_VAULT_FILENAME: &str = "zine-secrets.hold";
const SECRET_SALT_FILENAME: &str = "zine-secrets.salt";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SecretVaultStatus {
    vault_exists: bool,
}

fn secret_data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_local_data_dir()
        .map_err(|error| format!("could not resolve secure-vault directory: {error}"))
}

/// Report whether this install already has a Stronghold snapshot. The path is
/// deliberately kept native; JavaScript only needs create-vs-unlock wording.
#[tauri::command]
fn secret_vault_status(app: tauri::AppHandle) -> Result<SecretVaultStatus, String> {
    let data_dir = secret_data_dir(&app)?;
    Ok(SecretVaultStatus {
        vault_exists: data_dir.join(SECRET_VAULT_FILENAME).is_file(),
    })
}

// Segments skipped when walking an attached folder — non-content noise that
// should never become a trace node (VCS, deps, build artifacts, OS cruft).
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
///   2. in debug builds, the monorepo default `../../../relay/zine-relay`
///      (`npm run dev` builds this from current source before launching Tauri)
///   3. the bundled resource `binaries/zine-relay` (installed app — this is the
///      path that makes a distributed build actually run)
///   4. the monorepo path as a final fallback when no resource exists
///
/// Then connects to ws://127.0.0.1:4869 — if that's already accepting TCP, we
/// assume a relay is already running (e.g. another launch started one) and
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

/// The platform-specific executable suffix — empty on Unix, `.exe` on Windows.
/// Used so the dev-resolver and the build script look for the same filename Go
/// actually produces on each platform.
#[cfg(windows)]
const EXE_SUFFIX: &str = ".exe";
#[cfg(not(windows))]
const EXE_SUFFIX: &str = "";

/// Resolve the relay binary path across dev and installed-app layouts.
fn resolve_relay_binary(app: &tauri::AppHandle) -> Result<String, String> {
    // 1. Explicit env override (dev convenience / custom build).
    if let Ok(bin) = std::env::var("TRACER_RELAY_BIN") {
        if Path::new(&bin).exists() {
            return Ok(bin);
        }
        return Err(format!("TRACER_RELAY_BIN set but not found: {}", bin));
    }

    // 2. Debug checkout — prefer the binary the root dev script just built.
    // The checked-in bundle resource can target a prior source revision and is
    // for release packaging, not the live development loop.
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    let candidate = Path::new(manifest_dir)
        .join(format!("../../../relay/zine-relay{}", EXE_SUFFIX));
    let candidate = candidate.canonicalize().unwrap_or(candidate);
    #[cfg(debug_assertions)]
    if candidate.exists() {
        return Ok(candidate.to_string_lossy().into_owned());
    }

    // 3. Bundled resource — the path that matters for a distributed build.
    //    `binaries/zine-relay` / `binaries/zine-relay.exe` is declared in
    //    tauri.conf.json bundle.resources.
    let resource_name = format!("binaries/zine-relay{}", EXE_SUFFIX);
    if let Ok(resource) = app.path().resolve(&resource_name, BaseDirectory::Resource) {
        if resource.exists() {
            return Ok(resource.to_string_lossy().into_owned());
        }
    }

    // 4. Monorepo fallback (also gives release-from-checkout a useful error
    // path when the bundle resource was omitted).
    if candidate.exists() {
        return Ok(candidate.to_string_lossy().into_owned());
    }
    Err(format!(
        "no relay binary found. Build it: cd relay && go build -o zine-relay{} . — or set TRACER_RELAY_BIN. (looked for bundled resource, then: {})",
        EXE_SUFFIX,
        candidate.display()
    ))
}

/// Run the relay binary's one-shot reset mode. Keeping the database deletion
/// inside the relay binary means the process that owns the SQLite schema also
/// owns its reset semantics; the Tauri shell never reaches into the database.
fn run_relay_factory_reset(bin: &str) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = fs::metadata(bin) {
            let mut perms = meta.permissions();
            if (perms.mode() & 0o100) == 0 {
                perms.set_mode(perms.mode() | 0o100);
                fs::set_permissions(bin, perms)
                    .map_err(|e| format!("make relay binary executable at {bin}: {e}"))?;
            }
        }
    }

    let output = Command::new(bin)
        .arg("--reset")
        .output()
        .map_err(|e| format!("run relay factory reset at {bin}: {e}"))?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(if stderr.is_empty() {
        format!("relay factory reset exited with {}", output.status)
    } else {
        format!("relay factory reset failed: {stderr}")
    })
}

/// Factory-reset the desktop-owned records before the webview clears its own
/// localStorage. The first pass removes the old ACL and events. The running
/// relay polls its ACL every five seconds, so wait one full poll interval, then
/// purge once more to catch any final in-flight write from the old webview.
/// Returning only after the second pass guarantees the fresh browser key can
/// mint a new root against an empty, local-mode sidecar.
#[tauri::command]
async fn factory_reset(app: tauri::AppHandle) -> Result<(), String> {
    // Revoke app-owned Tor reachability before deleting the ACL. Otherwise the
    // relay's deliberate local-mode reset window would be reachable through a
    // still-running onion while the new vault screen waits for user input.
    stop_owned_tor()?;
    let bin = resolve_relay_binary(&app)?;
    run_relay_factory_reset(&bin)?;
    std::thread::sleep(Duration::from_millis(5_250));
    run_relay_factory_reset(&bin)
}

/// Delete the encrypted Stronghold snapshot after JavaScript has unloaded its
/// active handle. The per-install Argon2 salt is deliberately retained: it is
/// not key material, and the native process survives a webview reload, so
/// retaining it avoids a salt/snapshot race while the next empty vault is
/// created. With no snapshot, bootstrap presents the create-vault flow.
fn remove_secret_vault_snapshot(data_dir: &Path) -> Result<(), String> {
    let path = data_dir.join(SECRET_VAULT_FILENAME);
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("remove secure vault {}: {error}", path.display())),
    }
}

#[tauri::command]
fn factory_reset_vault(app: tauri::AppHandle) -> Result<(), String> {
    remove_secret_vault_snapshot(&secret_data_dir(&app)?)
}

// --- native scan/reify substrate -----------------------------------------
//
// The workspace is local-store/relay backed. These commands are the narrow
// native surface for explicitly scanning from or reifying to disk; there is no
// tauri-plugin-fs exposed to JS. Every write path is resolved under the folder
// the user picked, and `resolve_under` rejects absolute paths, traversal, and
// symlink escapes.

/// Resolve `relative` under `root`, rejecting traversal outside the root.
fn resolve_under(root: &str, relative: &str) -> Result<PathBuf, String> {
    let root_path = PathBuf::from(root);
    let relative_path = Path::new(relative);
    if relative_path.is_absolute()
        || relative_path.components().any(|component| {
            matches!(
                component,
                std::path::Component::ParentDir
                    | std::path::Component::RootDir
                    | std::path::Component::Prefix(_)
            )
        })
    {
        return Err(format!("path must be relative to the folder root: {relative}"));
    }
    let root_canon = root_path
        .canonicalize()
        .map_err(|e| format!("root folder does not exist: {}", e))?;
    let joined = root_canon.join(relative_path);

    // Existing targets are canonicalized directly. For a new nested target,
    // canonicalize the nearest existing ancestor: this both permits
    // write_text_file to create several missing parent levels and detects an
    // existing symlink that points outside the chosen root.
    let canon = match joined.canonicalize() {
        Ok(path) => path,
        Err(_) => {
            let mut ancestor = joined.as_path();
            while !ancestor.exists() {
                ancestor = ancestor
                    .parent()
                    .ok_or_else(|| format!("could not resolve parent for {relative}"))?;
            }
            let ancestor_canon = ancestor
                .canonicalize()
                .map_err(|e| format!("resolve {}: {}", ancestor.display(), e))?;
            if !ancestor_canon.starts_with(&root_canon) {
                return Err(format!("path escapes the folder root: {}", relative));
            }
            joined
        }
    };
    if !canon.starts_with(&root_canon) {
        return Err(format!("path escapes the folder root: {}", relative));
    }
    Ok(canon)
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

/// Native single-file picker. Returns the chosen absolute path, or null if the
/// user cancelled. Used by the Scan op to acquire a single file from a substrate
/// (an external disk path). Mirrors pick_folder; async for the same deadlock reason.
#[tauri::command]
async fn pick_file(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let chosen = app
        .dialog()
        .file()
        .set_title("Choose a file to scan")
        .blocking_pick_file();
    match chosen {
        Some(fp) => {
            let path = fp.into_path().map_err(|e| format!("invalid path: {}", e))?;
            Ok(Some(path.to_string_lossy().into_owned()))
        }
        None => Ok(None),
    }
}

/// Read an external file or folder (an absolute path the user explicitly picked
/// via pick_file/pick_folder) for the Scan op. Unlike read_text_file/list_dir,
/// this does NOT confine the read to the attached folder root — the whole point
/// of scan is to acquire a foreign snapshot from a substrate. Safety is the OS
/// picker: the user chose this path on purpose.
///
/// Returns a list of (relativePath, content) pairs — for a single file, one
/// entry with relativePath = its file name; for a folder, one entry per file
/// under it, relativePath = the path relative to the picked folder. Non-UTF8
/// files are skipped (binaries aren't editable).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ScannedFile {
    relative_path: String,
    content: String,
}

const MAX_SCAN_FILES: usize = 1_000;
const MAX_SCAN_BYTES: u64 = 32 * 1024 * 1024;

#[derive(Default)]
struct ScanBudget {
    files: usize,
    bytes: u64,
}

impl ScanBudget {
    fn reserve(&mut self, bytes: u64) -> Result<(), String> {
        let next_files = self.files.saturating_add(1);
        let next_bytes = self.bytes.saturating_add(bytes);
        if next_files > MAX_SCAN_FILES {
            return Err(format!(
                "Scan exceeds the {}-file safety limit; choose a smaller folder",
                MAX_SCAN_FILES
            ));
        }
        if next_bytes > MAX_SCAN_BYTES {
            return Err(format!(
                "Scan exceeds the {} MiB safety limit; choose a smaller folder",
                MAX_SCAN_BYTES / (1024 * 1024)
            ));
        }
        self.files = next_files;
        self.bytes = next_bytes;
        Ok(())
    }
}

#[tauri::command]
async fn scan_external(abs_path: String) -> Result<Vec<ScannedFile>, String> {
    tauri::async_runtime::spawn_blocking(move || scan_external_blocking(abs_path))
        .await
        .map_err(|error| format!("Scan worker failed: {error}"))?
}

fn scan_external_blocking(abs_path: String) -> Result<Vec<ScannedFile>, String> {
    let path = PathBuf::from(&abs_path);
    let meta = fs::metadata(&path).map_err(|e| format!("stat {}: {}", path.display(), e))?;
    if meta.is_file() {
        let mut budget = ScanBudget::default();
        budget.reserve(meta.len())?;
        let bytes = fs::read(&path).map_err(|e| format!("read {}: {}", path.display(), e))?;
        let content = match String::from_utf8(bytes) {
            Ok(s) => s,
            Err(_) => {
                return Err(format!(
                    "{} is not valid UTF-8 (binary files aren't scannable)",
                    path.display()
                ))
            }
        };
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "scanned".to_string());
        return Ok(vec![ScannedFile { relative_path: name, content }]);
    }
    // Folder: recurse, one entry per file, relative to the picked root.
    let canon = path
        .canonicalize()
        .map_err(|e| format!("root folder does not exist: {}", e))?;
    let mut out = Vec::new();
    let mut budget = ScanBudget::default();
    scan_walk(&canon, &canon, &mut out, &mut budget)?;
    out.sort_by(|a, b| a.relative_path.cmp(&b.relative_path));
    Ok(out)
}

fn scan_walk(
    dir: &Path,
    root: &Path,
    out: &mut Vec<ScannedFile>,
    budget: &mut ScanBudget,
) -> Result<(), String> {
    let entries = fs::read_dir(dir)
        .map_err(|e| format!("failed to read {}: {}", dir.display(), e))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("entry error: {}", e))?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if IGNORED_SEGMENTS.iter().any(|segment| *segment == name.as_ref()) {
            continue;
        }
        let ft = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        if ft.is_dir() {
            scan_walk(&entry.path(), root, out, budget)?;
        } else if ft.is_file() {
            let bytes_len = match entry.metadata() {
                Ok(metadata) => metadata.len(),
                Err(_) => continue,
            };
            budget.reserve(bytes_len)?;
            let bytes = match fs::read(entry.path()) {
                Ok(b) => b,
                Err(_) => continue, // unreadable file: skip, don't abort the whole scan
            };
            let content = match String::from_utf8(bytes) {
                Ok(s) => s,
                Err(_) => continue, // binary: skip (matches the editor's contract)
            };
            let rel = entry
                .path()
                .strip_prefix(root)
                .map_err(|e| format!("strip_prefix failed: {}", e))?
                .to_string_lossy()
                .into_owned();
            out.push(ScannedFile {
                relative_path: rel,
                content,
            });
        }
    }
    Ok(())
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

fn dirs_home() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .filter(|p| p.is_dir())
}

// --- OpenTimestamps (NIP-03) --------------------------------------------
//
// Hosts HTTP for OTS calendar submission. The browser can't reach the public
// calendars directly (they don't send CORS headers), so like `llm_fetch` this
// is a thin Rust proxy: it takes a Nostr event id (hex SHA-256), submits the
// raw 32-byte digest to a calendar, and returns the .ots proof base64-encoded.
// The JS side builds + signs the NIP-03 kind-1040 anchor around it.
//
// Single calendar for now (plumbing). The submission is one POST per calendar,
// so multi-calendar redundancy is additive later — it just needs binary proof
// merging, which is out of scope here.

/// Default calendar. Public, free, run by Peter Todd. The OTS submission
/// protocol is: POST the raw 32-byte digest as the binary body, receive the
/// .ots proof (binary) as the response body. No content-type required.
const OTS_CALENDAR: &str = "https://alice.btc.calendar.opentimestamps.org";

/// Stamp a Nostr event id against Bitcoin via OpenTimestamps. Takes the event
/// id as lowercase hex (64 chars = 32 bytes), POSTs the raw digest to the
/// calendar, and returns the .ots proof as base64. The returned proof is
/// typically *partial* — it proves calendar submission and is upgradeable to a
/// full Bitcoin-anchored proof once the digest lands in a block (minutes to
/// hours; occasionally never if the calendar drops it).
#[tauri::command]
async fn stamp_ots(digest_hex: String) -> Result<String, String> {
    let bytes = hex::decode(&digest_hex)
        .map_err(|e| format!("invalid hex digest: {e}"))?;
    if bytes.len() != 32 {
        return Err(format!("expected 32-byte digest, got {}", bytes.len()));
    }
    let client = reqwest::Client::new();
    let resp = client
        .post(OTS_CALENDAR)
        .body(bytes)
        .send()
        .await
        .map_err(|e| format!("OTS stamp request failed: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        let snippet = if text.len() > 500 {
            format!("{}…", &text[..500])
        } else {
            text
        };
        return Err(format!("OTS stamp HTTP {}: {}", status.as_u16(), snippet));
    }
    let proof = resp
        .bytes()
        .await
        .map_err(|e| format!("read OTS proof: {e}"))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(&proof))
}

/// Attempt to upgrade a partial .ots proof to a full Bitcoin-anchored one.
/// POSTs the existing proof to the calendar's `/upgrade` endpoint. Returns
/// `Some(base64)` if the proof was upgraded (the calendar returned a longer
/// proof containing the Bitcoin attestation), or `None` if it's still pending
/// (the digest hasn't landed in a block yet — try again later). Errors only on
/// transport failure, not on "still pending," which is a normal OTS state.
#[tauri::command]
async fn upgrade_ots(proof_b64: String) -> Result<Option<String>, String> {
    let proof = base64::engine::general_purpose::STANDARD
        .decode(&proof_b64)
        .map_err(|e| format!("invalid base64 proof: {e}"))?;
    let client = reqwest::Client::new();
    let resp = client
        .post(format!("{OTS_CALENDAR}/upgrade"))
        .header("Accept", "application/vnd.opentimestamps.v1")
        .body(proof.clone())
        .send()
        .await
        .map_err(|e| format!("OTS upgrade request failed: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        let snippet = if text.len() > 500 {
            format!("{}…", &text[..500])
        } else {
            text
        };
        return Err(format!("OTS upgrade HTTP {}: {}", status.as_u16(), snippet));
    }
    let upgraded = resp
        .bytes()
        .await
        .map_err(|e| format!("read upgraded OTS proof: {e}"))?;
    // The upgraded proof contains the Bitcoin attestation when confirmed; a
    // still-pending proof comes back unchanged (same bytes). If nothing grew,
    // there's nothing to republish.
    if upgraded.len() > proof.len() {
        Ok(Some(base64::engine::general_purpose::STANDARD.encode(&upgraded)))
    } else {
        Ok(None)
    }
}

// --- Access policy management -------------------------------------------
//
// The relay reads ~/.tracer/peers.json (sibling to the relay DB) to decide
// who may connect. These commands let the webview manage that file without
// touching the filesystem directly (no tauri-plugin-fs exposed to JS). The
// relay re-reads the file on its 5s poll, so changes take effect without a
// restart. See relay/access-policy.go + protocol/transport.md §5.

/// On-disk shape, matching relay/access-policy.go's PeersFile. The `writers`
/// field is omitted on older files — serde defaults it to empty, and writing
/// it back adds the key (harmless; old relays ignore the field).
#[derive(serde::Deserialize, serde::Serialize, Clone)]
struct PeersFile {
    owner: String,
    peers: Vec<String>,
    /// May publish events signed as themselves (read+write, own pubkey only).
    /// The canonical writer is a headless press (zine-mcp). Absent on older
    /// peers.json files → empty; serialized back as `writers: []`.
    #[serde(default)]
    writers: Vec<String>,
}

/// Resolve ~/.tracer/peers.json — the same path the relay uses (sibling to the
/// relay DB at ~/.tracer/relay.sqlite3).
fn peers_json_path() -> Result<PathBuf, String> {
    let home = dirs_home().ok_or("could not determine home directory")?;
    Ok(home.join(".tracer").join("peers.json"))
}

const PEERS_LOCK_TIMEOUT: Duration = Duration::from_secs(2);
const PEERS_STALE_LOCK_AGE: Duration = Duration::from_secs(30);

/// Cross-process lock shared with zine-mcp. Both processes update peers.json,
/// so an unlocked read-modify-write can otherwise discard the other's change.
/// The lock is a sibling created atomically with create_new; stale files are
/// recovered after 30 seconds so a crashed process cannot block ACL edits.
struct PeersFileLock {
    path: PathBuf,
    _file: fs::File,
}

impl PeersFileLock {
    fn acquire(path: &Path, timeout: Duration) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("create {}: {}", parent.display(), e))?;
        }
        let deadline = Instant::now() + timeout;
        loop {
            match fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(path)
            {
                Ok(file) => {
                    return Ok(Self {
                        path: path.to_path_buf(),
                        _file: file,
                    });
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    let stale = fs::metadata(path)
                        .and_then(|metadata| metadata.modified())
                        .ok()
                        .and_then(|modified| modified.elapsed().ok())
                        .is_some_and(|age| age > PEERS_STALE_LOCK_AGE);
                    if stale {
                        let _ = fs::remove_file(path);
                        continue;
                    }
                    if Instant::now() >= deadline {
                        return Err(format!(
                            "timed out waiting for access-policy lock {}",
                            path.display()
                        ));
                    }
                    std::thread::sleep(Duration::from_millis(10));
                }
                Err(error) => {
                    return Err(format!(
                        "create access-policy lock {}: {}",
                        path.display(),
                        error
                    ));
                }
            }
        }
    }
}

impl Drop for PeersFileLock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

fn peers_lock_path() -> Result<PathBuf, String> {
    let peers_path = peers_json_path()?;
    let file_name = peers_path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("could not resolve peers.json filename")?;
    Ok(peers_path.with_file_name(format!("{file_name}.lock")))
}

fn acquire_peers_file_lock() -> Result<PeersFileLock, String> {
    PeersFileLock::acquire(&peers_lock_path()?, PEERS_LOCK_TIMEOUT)
}

/// Read peers.json. Returns a default (empty owner, no peers) if the file
/// doesn't exist yet — that's the local-mode state.
fn read_peers_file_unlocked() -> Result<PeersFile, String> {
    let path = peers_json_path()?;
    if !path.exists() {
        return Ok(PeersFile {
            owner: String::new(),
            peers: Vec::new(),
            writers: Vec::new(),
        });
    }
    let raw = fs::read_to_string(&path)
        .map_err(|e| format!("read {}: {}", path.display(), e))?;
    serde_json::from_str(&raw).map_err(|e| format!("parse {}: {}", path.display(), e))
}

fn read_peers_file() -> Result<PeersFile, String> {
    let _lock = acquire_peers_file_lock()?;
    read_peers_file_unlocked()
}

/// Write peers.json atomically (temp + rename), mirroring operator.go's
/// persistence pattern. Writes to a sibling temp file then renames, so a crash
/// mid-write never leaves a corrupt file.
fn write_peers_file_unlocked(data: &PeersFile) -> Result<(), String> {
    let path = peers_json_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("create {}: {}", parent.display(), e))?;
    }
    let json = serde_json::to_string_pretty(data)
        .map_err(|e| format!("serialize peers.json: {e}"))?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, json)
        .map_err(|e| format!("write {}: {}", tmp.display(), e))?;
    fs::rename(&tmp, &path)
        .map_err(|e| format!("rename {} -> {}: {}", tmp.display(), path.display(), e))
}

/// Validate a hex pubkey: 64 lowercase hex chars (32 bytes). Matches
/// relay/access-policy.go's isValidPubkey.
fn is_valid_pubkey(s: &str) -> bool {
    s.len() == 64 && s.chars().all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c))
}

#[derive(Serialize)]
struct PeersState {
    owner: String,
    peers: Vec<String>,
    /// Keys authorized to publish their own events (read+write, own pubkey
    /// only). Surfaced so a UI can show/manage them; the relay's write gate
    /// enforces `ev.PubKey == authed` for writer events.
    writers: Vec<String>,
    /// Whether the relay is in networked mode (owner is set) vs local mode.
    #[serde(rename = "networkedMode")]
    networked_mode: bool,
}

fn peers_state(pf: PeersFile) -> PeersState {
    PeersState {
        networked_mode: is_valid_pubkey(&pf.owner),
        owner: pf.owner,
        peers: pf.peers,
        writers: pf.writers,
    }
}

/// Read the current access policy. networked_mode is true when an owner is set
/// — that's what activates the relay's NIP-42 AUTH requirement.
#[tauri::command]
fn list_peers() -> Result<PeersState, String> {
    Ok(peers_state(read_peers_file()?))
}

/// Set the owner pubkey. This is what activates networked mode — until an owner
/// is set, the relay stays in local mode (no AUTH required).
#[tauri::command]
fn set_owner(pubkey: String) -> Result<PeersState, String> {
    if !is_valid_pubkey(&pubkey) {
        return Err(format!(
            "invalid pubkey (expected 64 lowercase hex chars): {}",
            pubkey
        ));
    }
    let _lock = acquire_peers_file_lock()?;
    let mut pf = read_peers_file_unlocked()?;
    pf.owner = pubkey;
    write_peers_file_unlocked(&pf)?;
    Ok(peers_state(pf))
}

/// Add a peer pubkey (read-only access). Dedupes — adding the same key twice
/// is a no-op. Refuses to add the owner as a peer (the owner has write access,
/// not read-only).
#[tauri::command]
fn add_peer(pubkey: String) -> Result<PeersState, String> {
    if !is_valid_pubkey(&pubkey) {
        return Err(format!(
            "invalid pubkey (expected 64 lowercase hex chars): {}",
            pubkey
        ));
    }
    let _lock = acquire_peers_file_lock()?;
    let mut pf = read_peers_file_unlocked()?;
    if pf.owner == pubkey {
        return Err("that pubkey is the owner (owners have write access, not peer access)".into());
    }
    if !pf.peers.contains(&pubkey) {
        pf.peers.push(pubkey);
        write_peers_file_unlocked(&pf)?;
    }
    Ok(peers_state(pf))
}

/// Remove a peer pubkey.
#[tauri::command]
fn remove_peer(pubkey: String) -> Result<PeersState, String> {
    let _lock = acquire_peers_file_lock()?;
    let mut pf = read_peers_file_unlocked()?;
    pf.peers.retain(|p| p != &pubkey);
    write_peers_file_unlocked(&pf)?;
    Ok(peers_state(pf))
}

/// Add a writer pubkey (read+write access, own events only). Dedupes. Refuses
/// to add the owner as a writer (the owner already writes everything; a writer
/// entry for it is noise) and refuses to add an existing peer (a key is one
/// role at a time — peer is read-only, writer is read+write-as-self).
#[tauri::command]
fn add_writer(pubkey: String) -> Result<PeersState, String> {
    if !is_valid_pubkey(&pubkey) {
        return Err(format!(
            "invalid pubkey (expected 64 lowercase hex chars): {}",
            pubkey
        ));
    }
    let _lock = acquire_peers_file_lock()?;
    let mut pf = read_peers_file_unlocked()?;
    if pf.owner == pubkey {
        return Err("that pubkey is the owner (owners have full write access)".into());
    }
    if pf.peers.contains(&pubkey) {
        return Err("that pubkey is a peer (read-only) — remove it as a peer first".into());
    }
    if !pf.writers.contains(&pubkey) {
        pf.writers.push(pubkey);
        write_peers_file_unlocked(&pf)?;
    }
    Ok(peers_state(pf))
}

/// Remove a writer pubkey.
#[tauri::command]
fn remove_writer(pubkey: String) -> Result<PeersState, String> {
    let _lock = acquire_peers_file_lock()?;
    let mut pf = read_peers_file_unlocked()?;
    pf.writers.retain(|p| p != &pubkey);
    write_peers_file_unlocked(&pf)?;
    Ok(peers_state(pf))
}

// --- Tor sidecar: inbound reachability via onion service -----------------
//
// The desktop relay is 127.0.0.1-only. Peers reach it through a Tor onion
// service: Tor forwards inbound onion connections to the relay's localhost
// port. The onion address is derived from the Nostr key (see onion-key.ts +
// protocol/transport.md §3), so it's stable across reinstalls and networks.
//
// The key never touches disk. The press derives the 32-byte ed25519 seed
// (pure crypto), passes it here as base64, and this command hands it to Tor's
// control port inline via `ADD_ONION ED25519-V3:<base64>`. On next launch,
// re-derived and re-registered — no ~/.tracer/onion-key file (transport.md §3.4).

static TOR_SPAWNED: AtomicBool = AtomicBool::new(false);
static TOR_CHILD: Mutex<Option<std::process::Child>> = Mutex::new(None);

fn stop_owned_tor() -> Result<(), String> {
    let mut owned = TOR_CHILD
        .lock()
        .map_err(|_| "Tor process lock is poisoned".to_string())?;
    if let Some(mut child) = owned.take() {
        if child
            .try_wait()
            .map_err(|error| format!("inspect Tor process before reset: {error}"))?
            .is_none()
        {
            child
                .kill()
                .map_err(|error| format!("stop Tor before factory reset: {error}"))?;
            child
                .wait()
                .map_err(|error| format!("wait for Tor shutdown before factory reset: {error}"))?;
        }
    }
    TOR_SPAWNED.store(false, Ordering::SeqCst);
    Ok(())
}

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
    let child = Command::new(&bin)
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
    *TOR_CHILD
        .lock()
        .map_err(|_| "Tor process lock is poisoned".to_string())? = Some(child);

    // Wait for the SOCKS port to accept connections (Tor's readiness signal).
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        if Instant::now() > deadline {
            let _ = stop_owned_tor();
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
    if let Ok(resource) =
        app.path()
            .resolve(format!("binaries/tor{}", EXE_SUFFIX), BaseDirectory::Resource)
    {
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
    //    PATH is `;`-delimited on Windows, `:` elsewhere.
    let path_sep = if cfg!(windows) { ';' } else { ':' };
    let tor_name = format!("tor{}", EXE_SUFFIX);
    if let Ok(path) = std::env::var("PATH") {
        for dir in path.split(path_sep) {
            let candidate = Path::new(dir).join(&tor_name);
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
        let trimmed = line.trim_end_matches(['\r', '\n']);
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let data_dir = secret_data_dir(app.handle())
                .map_err(std::io::Error::other)?;
            fs::create_dir_all(&data_dir)?;
            app.handle().plugin(
                tauri_plugin_stronghold::Builder::with_argon2(
                    &data_dir.join(SECRET_SALT_FILENAME),
                )
                .build(),
            )?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            secret_vault_status,
            spawn_relay,
            factory_reset,
            factory_reset_vault,
            pick_folder,
            pick_file,
            scan_external,
            write_text_file,
            llm_proxy::llm_fetch,
            stamp_ots,
            upgrade_ots,
            spawn_tor,
            setup_onion,
            list_peers,
            set_owner,
            add_peer,
            remove_peer,
            add_writer,
            remove_writer,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn scanned_files_serialize_for_the_typescript_boundary() {
        let value = serde_json::to_value(ScannedFile {
            relative_path: "notes/draft.md".to_string(),
            content: "draft".to_string(),
        })
        .expect("scanned file should serialize");

        assert_eq!(value["relativePath"], "notes/draft.md");
        assert_eq!(value["content"], "draft");
        assert!(value.get("relative_path").is_none());
    }

    #[test]
    fn scan_budget_rejects_oversized_batches_before_reading_more_files() {
        let mut bytes = ScanBudget::default();
        assert!(bytes.reserve(MAX_SCAN_BYTES).is_ok());
        assert!(bytes.reserve(1).unwrap_err().contains("MiB safety limit"));

        let mut files = ScanBudget::default();
        for _ in 0..MAX_SCAN_FILES {
            files.reserve(0).expect("file inside count budget");
        }
        assert!(files.reserve(0).unwrap_err().contains("file safety limit"));
    }

    #[test]
    fn factory_reset_removes_only_the_secret_vault_snapshot() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock should be after Unix epoch")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "zine-secret-reset-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).expect("create secret reset test directory");
        let vault = dir.join(SECRET_VAULT_FILENAME);
        let salt = dir.join(SECRET_SALT_FILENAME);
        let unrelated = dir.join("keep-me");
        fs::write(&vault, b"encrypted").expect("write vault fixture");
        fs::write(&salt, b"salt").expect("write salt fixture");
        fs::write(&unrelated, b"other").expect("write unrelated fixture");

        remove_secret_vault_snapshot(&dir).expect("reset vault snapshot");
        remove_secret_vault_snapshot(&dir).expect("reset should be idempotent");

        assert!(!vault.exists());
        assert!(salt.exists(), "the live plugin's KDF salt must survive reload");
        assert!(unrelated.exists());
        fs::remove_dir_all(dir).expect("remove secret reset test directory");
    }

    #[test]
    fn peers_file_lock_excludes_second_writer_and_cleans_up() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock should be after Unix epoch")
            .as_nanos();
        let dir =
            std::env::temp_dir().join(format!("zine-peers-lock-{}-{nonce}", std::process::id()));
        fs::create_dir_all(&dir).expect("create lock test directory");
        let lock_path = dir.join("peers.json.lock");

        {
            let _first = PeersFileLock::acquire(&lock_path, Duration::from_millis(50))
                .expect("first writer should acquire lock");
            assert!(lock_path.exists());
            let second = PeersFileLock::acquire(&lock_path, Duration::from_millis(20));
            assert!(second.is_err(), "second writer must not enter concurrently");
        }

        assert!(
            !lock_path.exists(),
            "dropping the owner must remove the lock"
        );
        let second = PeersFileLock::acquire(&lock_path, Duration::from_millis(50))
            .expect("lock should be reusable after release");
        drop(second);
        fs::remove_dir_all(dir).expect("remove lock test directory");
    }

    #[test]
    fn resolve_under_allows_missing_nested_parents_but_rejects_traversal() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock should be after Unix epoch")
            .as_nanos();
        let dir =
            std::env::temp_dir().join(format!("zine-resolve-under-{}-{nonce}", std::process::id()));
        fs::create_dir_all(&dir).expect("create resolver test directory");

        let resolved = resolve_under(
            dir.to_str().expect("temporary path should be UTF-8"),
            "nested/deeper/file.md",
        )
        .expect("missing parent directories should be creatable");
        assert_eq!(
            resolved,
            dir.canonicalize()
                .expect("temporary root should canonicalize")
                .join("nested/deeper/file.md")
        );
        assert!(
            resolve_under(
                dir.to_str().expect("temporary path should be UTF-8"),
                "../outside.md",
            )
            .is_err(),
            "parent traversal must be rejected"
        );

        fs::remove_dir_all(dir).expect("remove resolver test directory");
    }
}

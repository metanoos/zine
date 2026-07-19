// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
mod desktop_operation_journal;
mod kademlia;
mod llm_proxy;
mod rendezvous_relay;

use std::collections::HashSet;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{path::BaseDirectory, Manager};
use zeroize::{Zeroize, Zeroizing};

static RELAY_SPAWNED: AtomicBool = AtomicBool::new(false);
static RELAY_CHILD: Mutex<Option<Child>> = Mutex::new(None);
static VAULT_RUNTIME_GATE: Mutex<()> = Mutex::new(());
static VAULT_TRANSITION_GATE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static WEBVIEW_RESTART_PENDING: AtomicBool = AtomicBool::new(false);
static NEXT_VAULT_RUNTIME_GENERATION: AtomicU64 = AtomicU64::new(1);
const SECRET_VAULT_FILENAME: &str = "zine-secrets.hold";
const SECRET_SALT_FILENAME: &str = "zine-secrets.salt";
const SECRET_VAULTS_DIRNAME: &str = "vaults";
const SECRET_VAULT_SNAPSHOT_FILENAME: &str = "secrets.hold";
const SECRET_VAULT_SALT_FILENAME: &str = "secrets.salt";
const VAULT_RELAY_FILENAME: &str = "relay.sqlite3";
const VAULT_PEERS_FILENAME: &str = "peers.json";
const VAULT_RUNTIME_VERIFIER_FILENAME: &str = "runtime.keycheck";
const SECRET_VAULT_REGISTRY_FILENAME: &str = "zine-vaults.json";
const ACTIVE_ONION_MARKER_PREFIX: &str = ".zine-active-onion-";
const LEGACY_VAULT_ID: &str = "legacy";
const VAULT_REGISTRY_LOCK_TIMEOUT: Duration = Duration::from_secs(2);
const VAULT_REGISTRY_STALE_LOCK_AGE: Duration = Duration::from_secs(30);
const LLM_VAULT_DRAIN_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SecretVaultStatus {
    vault_exists: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SecretVaultRecord {
    id: String,
    name: String,
    created_at: u64,
    legacy: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SecretVaultSummary {
    id: String,
    name: String,
    created_at: u64,
    legacy: bool,
    snapshot_exists: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StrongholdKdfEnvelope {
    version: u8,
    vault_id: Option<String>,
    passphrase: String,
}

#[derive(Clone)]
struct ActiveVaultRuntime {
    id: String,
    directory: PathBuf,
    generation: u64,
    closing: bool,
    journal_key: desktop_operation_journal::JournalKey,
    journal_session_id: String,
}

impl std::fmt::Debug for ActiveVaultRuntime {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ActiveVaultRuntime")
            .field("id", &self.id)
            .field("directory", &self.directory)
            .field("generation", &self.generation)
            .field("closing", &self.closing)
            .field("journal_key", &"[REDACTED]")
            .field("journal_session_id", &"[REDACTED]")
            .finish()
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct VaultRuntimeActivation {
    journal_session_id: String,
    journal_generation: u64,
}

#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub(crate) struct VaultRuntimeBinding {
    pub(crate) id: String,
    pub(crate) directory: PathBuf,
    pub(crate) generation: u64,
}

impl ActiveVaultRuntime {
    fn binding(&self) -> VaultRuntimeBinding {
        VaultRuntimeBinding {
            id: self.id.clone(),
            directory: self.directory.clone(),
            generation: self.generation,
        }
    }
}

static ACTIVE_VAULT_RUNTIME: Mutex<Option<ActiveVaultRuntime>> = Mutex::new(None);

fn secret_data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_local_data_dir()
        .map_err(|error| format!("could not resolve secure-vault directory: {error}"))
}

fn ensure_private_directory(path: &Path) -> Result<(), String> {
    fs::create_dir_all(path).map_err(|error| format!("create {}: {error}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let permissions = fs::Permissions::from_mode(0o700);
        fs::set_permissions(path, permissions)
            .map_err(|error| format!("protect {}: {error}", path.display()))?;
    }
    Ok(())
}

/// Make directory-entry updates durable after rename or removal. Syncing a
/// file persists its payload, but not the parent directory entry that names it.
fn sync_directory(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        fs::File::open(path)
            .and_then(|directory| directory.sync_all())
            .map_err(|error| format!("sync directory {}: {error}", path.display()))?;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
        fs::OpenOptions::new()
            .read(true)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
            .open(path)
            .and_then(|directory| directory.sync_all())
            .map_err(|error| format!("sync directory {}: {error}", path.display()))?;
    }
    Ok(())
}

fn vault_registry_path(data_dir: &Path) -> PathBuf {
    data_dir.join(SECRET_VAULT_REGISTRY_FILENAME)
}

fn vault_registry_staging_path(data_dir: &Path) -> PathBuf {
    vault_registry_path(data_dir).with_extension("json.tmp")
}

fn vault_registry_backup_path(data_dir: &Path) -> PathBuf {
    vault_registry_path(data_dir).with_extension("json.bak")
}

fn vault_registry_lock_path(data_dir: &Path) -> PathBuf {
    vault_registry_path(data_dir).with_extension("json.lock")
}

fn valid_vault_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 96
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}

fn vault_directory(data_dir: &Path, vault: &SecretVaultRecord) -> Result<PathBuf, String> {
    if vault.legacy {
        if vault.id != LEGACY_VAULT_ID {
            return Err("secure-vault registry has an invalid legacy entry".into());
        }
        return Ok(data_dir.to_path_buf());
    }
    if !valid_vault_id(&vault.id) || vault.id == LEGACY_VAULT_ID {
        return Err(format!(
            "secure-vault registry has an invalid id: {}",
            vault.id
        ));
    }
    Ok(data_dir.join(SECRET_VAULTS_DIRNAME).join(&vault.id))
}

fn vault_snapshot_path(data_dir: &Path, vault: &SecretVaultRecord) -> Result<PathBuf, String> {
    if vault.legacy {
        return Ok(data_dir.join(SECRET_VAULT_FILENAME));
    }
    Ok(vault_directory(data_dir, vault)?.join(SECRET_VAULT_SNAPSHOT_FILENAME))
}

fn vault_salt_path(data_dir: &Path, vault_id: Option<&str>) -> Result<PathBuf, String> {
    match vault_id {
        None => Ok(data_dir.join(SECRET_SALT_FILENAME)),
        Some(id) if valid_vault_id(id) && id != LEGACY_VAULT_ID => Ok(data_dir
            .join(SECRET_VAULTS_DIRNAME)
            .join(id)
            .join(SECRET_VAULT_SALT_FILENAME)),
        Some(id) => Err(format!("secure-vault KDF has an invalid id: {id}")),
    }
}

fn create_or_read_vault_salt(path: &Path) -> Result<[u8; 32], String> {
    if let Some(parent) = path.parent() {
        ensure_private_directory(parent)
            .map_err(|error| format!("create secure-vault KDF directory: {error}"))?;
    }
    loop {
        match fs::read(path) {
            Ok(raw) => {
                return raw.try_into().map_err(|raw: Vec<u8>| {
                    format!(
                        "secure-vault KDF salt {} has {} bytes instead of 32",
                        path.display(),
                        raw.len()
                    )
                });
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let mut salt = [0u8; 32];
                getrandom::fill(&mut salt)
                    .map_err(|error| format!("generate secure-vault KDF salt: {error}"))?;
                match fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(path)
                {
                    Ok(mut file) => {
                        file.write_all(&salt)
                            .map_err(|error| format!("write secure-vault KDF salt: {error}"))?;
                        file.sync_all()
                            .map_err(|error| format!("sync secure-vault KDF salt: {error}"))?;
                        return Ok(salt);
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                    Err(error) => {
                        return Err(format!("create secure-vault KDF salt: {error}"));
                    }
                }
            }
            Err(error) => {
                return Err(format!(
                    "read secure-vault KDF salt {}: {error}",
                    path.display()
                ));
            }
        }
    }
}

fn derive_stronghold_key_v1(passphrase: &[u8], salt: &[u8]) -> Vec<u8> {
    // KDF v1 is the exact rust-argon2 1.0 default used by
    // tauri-plugin-stronghold 2.3.1. Never replace this with Config::default:
    // rust-argon2 2.x changed that default to Argon2id with stronger but
    // incompatible parameters, which would make existing snapshots unreadable.
    argon2::hash_raw(passphrase, salt, &argon2::Config::original())
        .expect("could not derive secure-vault encryption key")
}

fn derive_stronghold_key(data_dir: &Path, encoded: &str) -> Vec<u8> {
    let parsed = serde_json::from_str::<StrongholdKdfEnvelope>(encoded)
        .ok()
        .filter(|envelope| envelope.version == 1);
    let (vault_id, mut passphrase) = match parsed {
        Some(envelope) => (envelope.vault_id, envelope.passphrase),
        None => (None, encoded.to_string()),
    };
    let salt_path =
        vault_salt_path(data_dir, vault_id.as_deref()).expect("invalid secure-vault KDF envelope");
    let salt =
        create_or_read_vault_salt(&salt_path).expect("could not initialize secure-vault KDF salt");
    let derived = derive_stronghold_key_v1(passphrase.as_bytes(), &salt);
    passphrase.zeroize();
    derived
}

fn validate_vault_registry(data_dir: &Path, raw: &[u8]) -> Result<Vec<SecretVaultRecord>, String> {
    let vaults: Vec<SecretVaultRecord> = serde_json::from_slice(raw)
        .map_err(|error| format!("decode secure-vault registry: {error}"))?;
    let mut ids = HashSet::new();
    let mut names = HashSet::new();
    for vault in &vaults {
        let _ = vault_snapshot_path(data_dir, vault)?;
        let name = vault.name.trim();
        if name.is_empty() {
            return Err("secure-vault registry contains an empty name".into());
        }
        if name.chars().count() > 64 {
            return Err("secure-vault registry contains an overlong name".into());
        }
        if !ids.insert(vault.id.as_str()) {
            return Err(format!(
                "secure-vault registry contains duplicate id: {}",
                vault.id
            ));
        }
        if !names.insert(name.to_lowercase()) {
            return Err(format!(
                "secure-vault registry contains duplicate name: {}",
                vault.name
            ));
        }
    }
    Ok(vaults)
}

struct VaultRegistryLock {
    path: PathBuf,
    _file: fs::File,
}

impl VaultRegistryLock {
    fn acquire(data_dir: &Path) -> Result<Self, String> {
        ensure_private_directory(data_dir)
            .map_err(|error| format!("create secure-vault directory: {error}"))?;
        let path = vault_registry_lock_path(data_dir);
        let deadline = Instant::now() + VAULT_REGISTRY_LOCK_TIMEOUT;
        loop {
            match fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&path)
            {
                Ok(file) => {
                    return Ok(Self { path, _file: file });
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    let stale = fs::metadata(&path)
                        .and_then(|metadata| metadata.modified())
                        .ok()
                        .and_then(|modified| modified.elapsed().ok())
                        .is_some_and(|age| age > VAULT_REGISTRY_STALE_LOCK_AGE);
                    if stale {
                        let _ = fs::remove_file(&path);
                        continue;
                    }
                    if Instant::now() >= deadline {
                        return Err(format!(
                            "timed out waiting for secure-vault registry lock {}",
                            path.display()
                        ));
                    }
                    std::thread::sleep(Duration::from_millis(10));
                }
                Err(error) => {
                    return Err(format!(
                        "create secure-vault registry lock {}: {error}",
                        path.display()
                    ));
                }
            }
        }
    }
}

impl Drop for VaultRegistryLock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

fn write_vault_registry_unlocked(
    data_dir: &Path,
    vaults: &[SecretVaultRecord],
) -> Result<(), String> {
    ensure_private_directory(data_dir)
        .map_err(|error| format!("create secure-vault directory: {error}"))?;
    let encoded = serde_json::to_vec_pretty(vaults)
        .map_err(|error| format!("encode secure-vault registry: {error}"))?;
    let registry = vault_registry_path(data_dir);
    let temporary = vault_registry_staging_path(data_dir);
    let backup = vault_registry_backup_path(data_dir);
    let mut staged = fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(&temporary)
        .map_err(|error| format!("open secure-vault registry staging file: {error}"))?;
    staged
        .write_all(&encoded)
        .map_err(|error| format!("write secure-vault registry staging file: {error}"))?;
    staged
        .sync_all()
        .map_err(|error| format!("sync secure-vault registry staging file: {error}"))?;
    drop(staged);

    if registry.is_file() {
        fs::copy(&registry, &backup)
            .map_err(|error| format!("back up secure-vault registry: {error}"))?;
        fs::File::open(&backup)
            .and_then(|file| file.sync_all())
            .map_err(|error| format!("sync secure-vault registry backup: {error}"))?;
        sync_directory(data_dir)?;
    }

    #[cfg(windows)]
    if registry.exists() {
        fs::remove_file(&registry)
            .map_err(|error| format!("replace secure-vault registry: {error}"))?;
    }
    fs::rename(&temporary, &registry)
        .map_err(|error| format!("install secure-vault registry: {error}"))?;
    sync_directory(data_dir)?;
    match fs::remove_file(&backup) {
        Ok(()) => sync_directory(data_dir)?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        // The live registry is already installed and durable. A stale recovery
        // copy is safe to overwrite on the next transaction; reporting failure
        // here would falsely tell the caller that its committed write failed.
        Err(_) => {}
    }
    Ok(())
}

/// Load the non-secret vault index. An install with the old single snapshot is
/// adopted in place as one named vault; the snapshot is never copied or
/// re-encrypted, so the existing passphrase and KDF inputs remain valid.
fn load_vault_registry_unlocked(data_dir: &Path) -> Result<Vec<SecretVaultRecord>, String> {
    let registry = vault_registry_path(data_dir);
    let candidates = [
        registry.clone(),
        vault_registry_staging_path(data_dir),
        vault_registry_backup_path(data_dir),
    ];
    let mut candidate_errors = Vec::new();
    for candidate in candidates {
        if candidate.is_file() {
            match fs::read(&candidate)
                .map_err(|error| format!("read {}: {error}", candidate.display()))
                .and_then(|raw| validate_vault_registry(data_dir, &raw))
            {
                Ok(vaults) => return Ok(vaults),
                Err(error) => candidate_errors.push(error),
            }
        }
    }
    if !candidate_errors.is_empty() {
        return Err(format!(
            "secure-vault registry and recovery copies are unreadable: {}",
            candidate_errors.join("; ")
        ));
    }

    if data_dir.join(SECRET_VAULT_FILENAME).is_file() {
        let created_at = fs::metadata(data_dir.join(SECRET_VAULT_FILENAME))
            .and_then(|metadata| metadata.modified())
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|duration| duration.as_millis() as u64)
            .unwrap_or(0);
        let vaults = vec![SecretVaultRecord {
            id: LEGACY_VAULT_ID.into(),
            name: "Personal".into(),
            created_at,
            legacy: true,
        }];
        write_vault_registry_unlocked(data_dir, &vaults)?;
        return Ok(vaults);
    }

    Ok(Vec::new())
}

fn load_vault_registry(data_dir: &Path) -> Result<Vec<SecretVaultRecord>, String> {
    let _lock = VaultRegistryLock::acquire(data_dir)?;
    load_vault_registry_unlocked(data_dir)
}

fn vault_summaries(
    data_dir: &Path,
    vaults: Vec<SecretVaultRecord>,
) -> Result<Vec<SecretVaultSummary>, String> {
    vaults
        .into_iter()
        .map(|vault| {
            let snapshot_exists = vault_snapshot_path(data_dir, &vault)?.is_file();
            Ok(SecretVaultSummary {
                id: vault.id,
                name: vault.name,
                created_at: vault.created_at,
                legacy: vault.legacy,
                snapshot_exists,
            })
        })
        .collect()
}

#[tauri::command]
fn list_secret_vaults(app: tauri::AppHandle) -> Result<Vec<SecretVaultSummary>, String> {
    let data_dir = secret_data_dir(&app)?;
    vault_summaries(&data_dir, load_vault_registry(&data_dir)?)
}

fn reserve_secret_vault(
    data_dir: &Path,
    name: &str,
    nonce: u128,
) -> Result<SecretVaultSummary, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Enter a vault name".into());
    }
    if name.chars().count() > 64 {
        return Err("Vault names must be 64 characters or fewer".into());
    }

    let _lock = VaultRegistryLock::acquire(data_dir)?;
    let mut vaults = load_vault_registry_unlocked(data_dir)?;
    let normalized_name = name.to_lowercase();
    if vaults
        .iter()
        .any(|vault| vault.name.trim().to_lowercase() == normalized_name)
    {
        return Err(format!("A vault named {name} already exists"));
    }
    let mut suffix = 0u32;
    let id = loop {
        let candidate = if suffix == 0 {
            format!("vault-{nonce:x}")
        } else {
            format!("vault-{nonce:x}-{suffix}")
        };
        if !vaults.iter().any(|vault| vault.id == candidate) {
            break candidate;
        }
        suffix += 1;
    };
    let record = SecretVaultRecord {
        id,
        name: name.into(),
        created_at: (nonce / 1_000_000) as u64,
        legacy: false,
    };
    ensure_private_directory(&vault_directory(data_dir, &record)?)
        .map_err(|error| format!("create secure-vault directory: {error}"))?;
    vaults.push(record.clone());
    write_vault_registry_unlocked(data_dir, &vaults)?;
    vault_summaries(data_dir, vec![record])?
        .pop()
        .ok_or_else(|| "created vault is unavailable".into())
}

#[tauri::command]
fn create_secret_vault(app: tauri::AppHandle, name: String) -> Result<SecretVaultSummary, String> {
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| format!("system clock cannot create a vault id: {error}"))?
        .as_nanos();
    reserve_secret_vault(&secret_data_dir(&app)?, &name, nonce)
}

/// A failed first unlock may leave only its registry reservation. Remove that
/// empty record, but refuse once Stronghold has written any encrypted state.
#[tauri::command]
fn discard_empty_secret_vault(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let data_dir = secret_data_dir(&app)?;
    let _lock = VaultRegistryLock::acquire(&data_dir)?;
    let mut vaults = load_vault_registry_unlocked(&data_dir)?;
    let Some(index) = vaults.iter().position(|vault| vault.id == id) else {
        return Ok(());
    };
    if vault_snapshot_path(&data_dir, &vaults[index])?.is_file() {
        return Err("Cannot discard a vault after encrypted state has been created".into());
    }
    if !vaults[index].legacy {
        let directory = vault_directory(&data_dir, &vaults[index])?;
        match fs::remove_dir_all(&directory) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(format!(
                    "remove empty secure-vault directory {}: {error}",
                    directory.display()
                ));
            }
        }
    }
    vaults.remove(index);
    write_vault_registry_unlocked(&data_dir, &vaults)
}

/// Compatibility status for older frontend bundles. New clients consume the
/// full vault list instead of flattening the install to one Boolean.
#[tauri::command]
fn secret_vault_status(app: tauri::AppHandle) -> Result<SecretVaultStatus, String> {
    let data_dir = secret_data_dir(&app)?;
    let vaults = load_vault_registry(&data_dir)?;
    Ok(SecretVaultStatus {
        vault_exists: vaults.iter().any(|vault| {
            vault_snapshot_path(&data_dir, vault)
                .map(|path| path.is_file())
                .unwrap_or(false)
        }),
    })
}

fn vault_runtime_directory(data_dir: &Path, vault: &SecretVaultRecord) -> Result<PathBuf, String> {
    if vault.legacy {
        let home = dirs_home().ok_or("could not determine home directory")?;
        return Ok(home.join(".tracer"));
    }
    vault_directory(data_dir, vault)
}

fn prepare_vault_runtime_directory(path: &Path) -> Result<PathBuf, String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() || !metadata.file_type().is_dir() {
                return Err("The vault runtime directory is unsafe".into());
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err("The vault runtime directory is unavailable".into()),
    }
    ensure_private_directory(path)
        .map_err(|_| "The vault runtime directory is unavailable".to_string())?;
    let metadata = fs::symlink_metadata(path)
        .map_err(|_| "The vault runtime directory is unavailable".to_string())?;
    if metadata.file_type().is_symlink() || !metadata.file_type().is_dir() {
        return Err("The vault runtime directory is unsafe".into());
    }
    let canonical = fs::canonicalize(path)
        .map_err(|_| "The vault runtime directory is unavailable".to_string())?;
    revalidate_pinned_vault_runtime_directory(&canonical)?;
    Ok(canonical)
}

pub(crate) fn revalidate_pinned_vault_runtime_directory(path: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|_| "The vault runtime directory is unavailable".to_string())?;
    if metadata.file_type().is_symlink() || !metadata.file_type().is_dir() {
        return Err("The vault runtime directory is unsafe".into());
    }
    let canonical = fs::canonicalize(path)
        .map_err(|_| "The vault runtime directory is unavailable".to_string())?;
    if canonical != path {
        return Err("The vault runtime directory binding is stale".into());
    }
    Ok(())
}

fn active_vault_runtime() -> Result<ActiveVaultRuntime, String> {
    let active = ACTIVE_VAULT_RUNTIME
        .lock()
        .map_err(|_| "active vault runtime lock is poisoned".to_string())?
        .clone();
    usable_vault_runtime(active)
}

fn usable_vault_runtime(active: Option<ActiveVaultRuntime>) -> Result<ActiveVaultRuntime, String> {
    let active =
        active.ok_or_else(|| "Unlock a vault before using its native runtime".to_string())?;
    if active.closing {
        return Err("The active vault is locking; wait for shutdown to finish".into());
    }
    Ok(active)
}

pub(crate) fn active_vault_binding() -> Result<VaultRuntimeBinding, String> {
    Ok(active_vault_runtime()?.binding())
}

pub(crate) fn require_active_vault_binding(expected: &VaultRuntimeBinding) -> Result<(), String> {
    let active = active_vault_runtime()?;
    if active.binding() != *expected {
        return Err("The Kademlia command belongs to a stale vault session".into());
    }
    Ok(())
}

fn next_vault_runtime_generation() -> Result<u64, String> {
    NEXT_VAULT_RUNTIME_GENERATION
        .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |generation| {
            generation.checked_add(1)
        })
        .map_err(|_| "vault runtime generation counter is exhausted".to_string())
}

fn verify_vault_runtime_key(directory: &Path, key: &[u8]) -> Result<(), String> {
    if key.len() != 32 {
        return Err("The vault runtime key is invalid".into());
    }
    let verifier_path = directory.join(VAULT_RUNTIME_VERIFIER_FILENAME);
    let mut hasher = Sha256::new();
    hasher.update(b"zine-vault-runtime-v1\0");
    hasher.update(key);
    let expected = hasher.finalize();
    match fs::read(&verifier_path) {
        Ok(stored) => {
            if stored.len() != expected.len() {
                return Err("The vault runtime verifier is corrupt".into());
            }
            let mismatch = stored
                .iter()
                .zip(expected.iter())
                .fold(0u8, |acc, (left, right)| acc | (left ^ right));
            if mismatch != 0 {
                return Err("The selected vault did not authorize its native runtime".into());
            }
            Ok(())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&verifier_path)
                .map_err(|error| format!("create vault runtime verifier: {error}"))?;
            file.write_all(&expected)
                .map_err(|error| format!("write vault runtime verifier: {error}"))?;
            file.sync_all()
                .map_err(|error| format!("sync vault runtime verifier: {error}"))
        }
        Err(error) => Err(format!("read vault runtime verifier: {error}")),
    }
}

#[tauri::command]
fn activate_vault_runtime(
    app: tauri::AppHandle,
    id: String,
    workspace_key: Vec<u8>,
) -> Result<VaultRuntimeActivation, String> {
    let _gate = VAULT_RUNTIME_GATE
        .lock()
        .map_err(|_| "vault runtime operation lock is poisoned".to_string())?;
    let workspace_key = Zeroizing::new(workspace_key);
    let data_dir = secret_data_dir(&app)?;
    let vaults = load_vault_registry(&data_dir)?;
    let vault = vaults
        .iter()
        .find(|vault| vault.id == id)
        .ok_or_else(|| "The selected vault is not registered".to_string())?;
    if !vault_snapshot_path(&data_dir, vault)?.is_file() {
        return Err("Finish creating the encrypted vault before activating it".into());
    }
    let directory = prepare_vault_runtime_directory(&vault_runtime_directory(&data_dir, vault)?)?;
    let verified = verify_vault_runtime_key(&directory, &workspace_key);
    verified?;
    let journal_key = desktop_operation_journal::JournalKey::derive(&workspace_key, &id)?;
    let llm_registry = app.state::<llm_proxy::LlmRequestRegistry>();

    let mut active = ACTIVE_VAULT_RUNTIME
        .lock()
        .map_err(|_| "active vault runtime lock is poisoned".to_string())?;
    if let Some(existing) = active.as_ref() {
        if existing.closing {
            return Err("The active vault is locking; wait for shutdown to finish".into());
        }
        if existing.id == id {
            llm_registry.open(&existing.binding())?;
            return Ok(VaultRuntimeActivation {
                journal_session_id: existing.journal_session_id.clone(),
                journal_generation: existing.generation,
            });
        }
        return Err(format!("Lock vault {} before activating {id}", existing.id));
    }
    let generation = next_vault_runtime_generation()?;
    let mut session_nonce = [0u8; 32];
    getrandom::fill(&mut session_nonce)
        .map_err(|_| "The vault journal session cannot be created".to_string())?;
    let journal_session_id = hex::encode(session_nonce);
    let runtime = ActiveVaultRuntime {
        id,
        directory,
        generation,
        closing: false,
        journal_key,
        journal_session_id: journal_session_id.clone(),
    };
    let binding = runtime.binding();
    *active = Some(runtime);
    if let Err(error) = llm_registry.open(&binding) {
        // Activation is not successful until the provider boundary is bound to
        // the exact same vault generation. Roll back rather than exposing an
        // active vault whose LLM registry is stale or permissive.
        *active = None;
        return Err(error);
    }
    Ok(VaultRuntimeActivation {
        journal_session_id,
        journal_generation: generation,
    })
}

fn stop_owned_relay() -> Result<(), String> {
    let mut owned = RELAY_CHILD
        .lock()
        .map_err(|_| "relay process lock is poisoned".to_string())?;
    if let Some(mut child) = owned.take() {
        match child.try_wait() {
            Ok(Some(_)) => {}
            Ok(None) => {
                if let Err(error) = child.kill() {
                    *owned = Some(child);
                    return Err(format!("stop active vault relay: {error}"));
                }
                if let Err(error) = child.wait() {
                    *owned = Some(child);
                    return Err(format!("wait for active vault relay shutdown: {error}"));
                }
            }
            Err(error) => {
                *owned = Some(child);
                return Err(format!("inspect active vault relay: {error}"));
            }
        }
    }
    RELAY_SPAWNED.store(false, Ordering::SeqCst);
    Ok(())
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
/// Then connects to ws://127.0.0.1:4869. A listener not owned by this process
/// is rejected because it may be serving another vault. Otherwise spawn the
/// active vault's relay and wait for a child-owned readiness token written
/// only after that child has bound the port.
///
/// Uses std::process::Command rather than tauri-plugin-shell's sidecar
/// declaration: the resource is bundled via `bundle.resources` in
/// tauri.conf.json, which avoids the target-triple rename convention while
/// still shipping the binary inside the installer.
#[tauri::command]
fn spawn_relay(app: tauri::AppHandle) -> Result<String, String> {
    let _gate = VAULT_RUNTIME_GATE
        .lock()
        .map_err(|_| "vault runtime operation lock is poisoned".to_string())?;
    if RELAY_SPAWNED.load(Ordering::SeqCst) {
        let mut owned = RELAY_CHILD
            .lock()
            .map_err(|_| "relay process lock is poisoned".to_string())?;
        if let Some(child) = owned.as_mut() {
            match child.try_wait() {
                Ok(None) => return Ok("already spawned".into()),
                Ok(Some(_)) => {
                    *owned = None;
                    RELAY_SPAWNED.store(false, Ordering::SeqCst);
                }
                Err(error) => return Err(format!("inspect active vault relay: {error}")),
            }
        } else {
            RELAY_SPAWNED.store(false, Ordering::SeqCst);
        }
    }

    let addr: SocketAddr = "127.0.0.1:4869"
        .parse::<SocketAddr>()
        .map_err(|e: std::net::AddrParseError| e.to_string())?;

    // A process we do not own could be serving another vault's database. Never
    // silently attach to it: the fixed loopback port is part of the active
    // vault boundary.
    if TcpStream::connect_timeout(&addr, Duration::from_millis(200)).is_ok() {
        return Err("relay port 4869 is already in use by another process".into());
    }

    let bin = resolve_relay_binary(&app)?;
    let runtime = active_vault_runtime()?;
    let database = runtime.directory.join(VAULT_RELAY_FILENAME);
    let mut ready_nonce = [0u8; 32];
    getrandom::fill(&mut ready_nonce)
        .map_err(|error| format!("generate relay readiness nonce: {error}"))?;
    let ready_token = hex::encode(ready_nonce);
    let ready_path = runtime
        .directory
        .join(format!(".relay-ready-{}-{ready_token}", std::process::id()));

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

    let child = Command::new(&bin)
        .arg("--host")
        .arg("127.0.0.1")
        .arg("--port")
        .arg("4869")
        .arg("--db")
        .arg(&database)
        .arg("--ready-file")
        .arg(&ready_path)
        .arg("--ready-token")
        .arg(&ready_token)
        .spawn()
        .map_err(|e| format!("failed to spawn relay binary at {}: {}", bin, e))?;
    *RELAY_CHILD
        .lock()
        .map_err(|_| "relay process lock is poisoned".to_string())? = Some(child);

    // The relay writes the nonce only after its own net.Listen succeeds. A
    // competing process may win the port race, but it cannot make this child
    // appear ready; the child exit below is surfaced instead.
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if Instant::now() > deadline {
            let _ = stop_owned_relay();
            let _ = fs::remove_file(&ready_path);
            return Err("relay spawned but did not start listening within 5s".into());
        }

        let exited = {
            let mut owned = RELAY_CHILD
                .lock()
                .map_err(|_| "relay process lock is poisoned".to_string())?;
            let child = owned
                .as_mut()
                .ok_or_else(|| "relay process disappeared before readiness".to_string())?;
            match child.try_wait() {
                Ok(None) => None,
                Ok(Some(status)) => {
                    *owned = None;
                    Some(status)
                }
                Err(error) => return Err(format!("inspect starting vault relay: {error}")),
            }
        };
        if let Some(status) = exited {
            RELAY_SPAWNED.store(false, Ordering::SeqCst);
            let _ = fs::remove_file(&ready_path);
            return Err(format!("vault relay exited before readiness: {status}"));
        }

        match fs::read_to_string(&ready_path) {
            Ok(token) if token == ready_token => {
                if TcpStream::connect_timeout(&addr, Duration::from_millis(200)).is_ok() {
                    let child_still_running = {
                        let mut owned = RELAY_CHILD
                            .lock()
                            .map_err(|_| "relay process lock is poisoned".to_string())?;
                        let child = owned.as_mut().ok_or_else(|| {
                            "relay process disappeared after readiness".to_string()
                        })?;
                        match child.try_wait() {
                            Ok(None) => true,
                            Ok(Some(_)) => {
                                *owned = None;
                                false
                            }
                            Err(error) => return Err(format!("verify ready vault relay: {error}")),
                        }
                    };
                    if child_still_running {
                        let _ = fs::remove_file(&ready_path);
                        RELAY_SPAWNED.store(true, Ordering::SeqCst);
                        return Ok("spawned".into());
                    }
                    RELAY_SPAWNED.store(false, Ordering::SeqCst);
                    let _ = fs::remove_file(&ready_path);
                    return Err("vault relay exited after publishing readiness".into());
                }
            }
            Ok(_) => {
                let _ = stop_owned_relay();
                let _ = fs::remove_file(&ready_path);
                return Err("vault relay wrote an invalid readiness token".into());
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                let _ = stop_owned_relay();
                let _ = fs::remove_file(&ready_path);
                return Err(format!("read vault relay readiness: {error}"));
            }
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
    let candidate =
        Path::new(manifest_dir).join(format!("../../../relay/zine-relay{}", EXE_SUFFIX));
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
async fn factory_reset(
    app: tauri::AppHandle,
    kademlia_runtime: tauri::State<'_, kademlia::KademliaRuntime>,
) -> Result<(), String> {
    // Revoke app-owned Tor reachability before deleting the ACL. Otherwise the
    // relay's deliberate local-mode reset window would be reachable through a
    // still-running onion while the new vault screen waits for user input.
    let active_kademlia_directory = active_vault_binding()?.directory;
    lock_vault_runtime(app.clone()).await?;
    kademlia::reset_runtime(&active_kademlia_directory, &kademlia_runtime).await?;
    desktop_operation_journal::remove_database_files(&active_kademlia_directory)?;
    let bin = resolve_relay_binary(&app)?;
    run_relay_factory_reset(&bin)?;
    std::thread::sleep(Duration::from_millis(5_250));
    run_relay_factory_reset(&bin)?;
    if let Some(home) = dirs_home() {
        let verifier = home.join(".tracer").join(VAULT_RUNTIME_VERIFIER_FILENAME);
        match fs::remove_file(&verifier) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(format!(
                    "remove legacy vault runtime verifier {}: {error}",
                    verifier.display()
                ));
            }
        }
    }
    Ok(())
}

/// Delete every encrypted vault snapshot and its non-secret index after
/// JavaScript has unloaded the active Stronghold handle. The per-install
/// Argon2 salt is retained: it is not key material, and the native process
/// survives a webview reload.
fn remove_secret_vaults(data_dir: &Path) -> Result<(), String> {
    let legacy = data_dir.join(SECRET_VAULT_FILENAME);
    match fs::remove_file(&legacy) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("remove secure vault {}: {error}", legacy.display())),
    }

    let snapshots = data_dir.join(SECRET_VAULTS_DIRNAME);
    match fs::remove_dir_all(&snapshots) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(format!(
                "remove secure vaults directory {}: {error}",
                snapshots.display()
            ))
        }
    }

    for registry in [
        vault_registry_path(data_dir),
        vault_registry_staging_path(data_dir),
        vault_registry_backup_path(data_dir),
    ] {
        match fs::remove_file(&registry) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(format!(
                    "remove secure-vault registry {}: {error}",
                    registry.display()
                ));
            }
        }
    }
    Ok(())
}

#[tauri::command]
fn factory_reset_vault(app: tauri::AppHandle) -> Result<(), String> {
    let _gate = VAULT_RUNTIME_GATE
        .lock()
        .map_err(|_| "vault runtime operation lock is poisoned".to_string())?;
    if ACTIVE_VAULT_RUNTIME
        .lock()
        .map_err(|_| "active vault runtime lock is poisoned".to_string())?
        .is_some()
    {
        return Err("Lock the active vault before factory reset".into());
    }
    let data_dir = secret_data_dir(&app)?;
    let _registry_lock = VaultRegistryLock::acquire(&data_dir)?;
    remove_secret_vaults(&data_dir)
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
        return Err(format!(
            "path must be relative to the folder root: {relative}"
        ));
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
        return Ok(vec![ScannedFile {
            relative_path: name,
            content,
        }]);
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
    let entries =
        fs::read_dir(dir).map_err(|e| format!("failed to read {}: {}", dir.display(), e))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("entry error: {}", e))?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if IGNORED_SEGMENTS
            .iter()
            .any(|segment| *segment == name.as_ref())
        {
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
    let bytes = hex::decode(&digest_hex).map_err(|e| format!("invalid hex digest: {e}"))?;
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
        Ok(Some(
            base64::engine::general_purpose::STANDARD.encode(&upgraded),
        ))
    } else {
        Ok(None)
    }
}

// --- Access policy management -------------------------------------------
//
// The relay reads the active vault's peers.json (sibling to its relay DB) to
// decide who may connect. Legacy installs retain ~/.tracer; new vaults keep
// both files inside their private native directory. The relay re-reads the file
// on its 5s poll, so changes take effect without a restart.

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

/// Resolve peers.json from one captured runtime. Callers hold
/// VAULT_RUNTIME_GATE while capturing the runtime and completing the full
/// lock/read/write transaction, so a vault switch cannot change the path.
fn peers_json_path(runtime: &ActiveVaultRuntime) -> PathBuf {
    runtime.directory.join(VAULT_PEERS_FILENAME)
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
            ensure_private_directory(parent)?;
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

fn peers_lock_path(peers_path: &Path) -> Result<PathBuf, String> {
    let file_name = peers_path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("could not resolve peers.json filename")?;
    Ok(peers_path.with_file_name(format!("{file_name}.lock")))
}

fn acquire_peers_file_lock(peers_path: &Path) -> Result<PeersFileLock, String> {
    PeersFileLock::acquire(&peers_lock_path(peers_path)?, PEERS_LOCK_TIMEOUT)
}

/// Read peers.json. Returns a default (empty owner, no peers) if the file
/// doesn't exist yet — that's the local-mode state.
fn read_peers_file_unlocked(path: &Path) -> Result<PeersFile, String> {
    let candidates = [
        path.to_path_buf(),
        path.with_extension("json.tmp"),
        path.with_extension("json.bak"),
    ];
    let mut errors = Vec::new();
    for candidate in candidates {
        if !candidate.is_file() {
            continue;
        }
        match fs::read_to_string(&candidate)
            .map_err(|error| format!("read {}: {error}", candidate.display()))
            .and_then(|raw| {
                serde_json::from_str(&raw)
                    .map_err(|error| format!("parse {}: {error}", candidate.display()))
            }) {
            Ok(peers) => return Ok(peers),
            Err(error) => errors.push(error),
        }
    }
    if errors.is_empty() {
        return Ok(PeersFile {
            owner: String::new(),
            peers: Vec::new(),
            writers: Vec::new(),
        });
    }
    Err(format!(
        "active vault access policy and recovery copies are unreadable: {}",
        errors.join("; ")
    ))
}

fn read_peers_file() -> Result<PeersFile, String> {
    let _gate = VAULT_RUNTIME_GATE
        .lock()
        .map_err(|_| "vault runtime operation lock is poisoned".to_string())?;
    let path = peers_json_path(&active_vault_runtime()?);
    let _lock = acquire_peers_file_lock(&path)?;
    read_peers_file_unlocked(&path)
}

/// Write peers.json atomically (temp + rename), mirroring operator.go's
/// persistence pattern. Writes to a sibling temp file then renames, so a crash
/// mid-write never leaves a corrupt file.
fn write_peers_file_unlocked(path: &Path, data: &PeersFile) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        ensure_private_directory(parent)?;
    }
    let json =
        serde_json::to_string_pretty(data).map_err(|e| format!("serialize peers.json: {e}"))?;
    let tmp = path.with_extension("json.tmp");
    let backup = path.with_extension("json.bak");
    let mut staged = fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(&tmp)
        .map_err(|error| format!("open {}: {error}", tmp.display()))?;
    staged
        .write_all(json.as_bytes())
        .map_err(|error| format!("write {}: {error}", tmp.display()))?;
    staged
        .sync_all()
        .map_err(|error| format!("sync {}: {error}", tmp.display()))?;
    drop(staged);
    if path.is_file() {
        fs::copy(path, &backup).map_err(|error| format!("back up {}: {error}", path.display()))?;
    }
    #[cfg(windows)]
    if path.exists() {
        fs::remove_file(&path).map_err(|error| format!("replace {}: {error}", path.display()))?;
    }
    fs::rename(&tmp, path)
        .map_err(|e| format!("rename {} -> {}: {}", tmp.display(), path.display(), e))?;
    let _ = fs::remove_file(backup);
    Ok(())
}

/// Validate a hex pubkey: 64 lowercase hex chars (32 bytes). Matches
/// relay/access-policy.go's isValidPubkey.
fn is_valid_pubkey(s: &str) -> bool {
    s.len() == 64
        && s.chars()
            .all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c))
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
    let _gate = VAULT_RUNTIME_GATE
        .lock()
        .map_err(|_| "vault runtime operation lock is poisoned".to_string())?;
    let path = peers_json_path(&active_vault_runtime()?);
    let _lock = acquire_peers_file_lock(&path)?;
    let mut pf = read_peers_file_unlocked(&path)?;
    pf.owner = pubkey;
    write_peers_file_unlocked(&path, &pf)?;
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
    let _gate = VAULT_RUNTIME_GATE
        .lock()
        .map_err(|_| "vault runtime operation lock is poisoned".to_string())?;
    let path = peers_json_path(&active_vault_runtime()?);
    let _lock = acquire_peers_file_lock(&path)?;
    let mut pf = read_peers_file_unlocked(&path)?;
    if pf.owner == pubkey {
        return Err("that pubkey is the owner (owners have write access, not peer access)".into());
    }
    if !pf.peers.contains(&pubkey) {
        pf.peers.push(pubkey);
        write_peers_file_unlocked(&path, &pf)?;
    }
    Ok(peers_state(pf))
}

/// Remove a peer pubkey.
#[tauri::command]
fn remove_peer(pubkey: String) -> Result<PeersState, String> {
    let _gate = VAULT_RUNTIME_GATE
        .lock()
        .map_err(|_| "vault runtime operation lock is poisoned".to_string())?;
    let path = peers_json_path(&active_vault_runtime()?);
    let _lock = acquire_peers_file_lock(&path)?;
    let mut pf = read_peers_file_unlocked(&path)?;
    pf.peers.retain(|p| p != &pubkey);
    write_peers_file_unlocked(&path, &pf)?;
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
    let _gate = VAULT_RUNTIME_GATE
        .lock()
        .map_err(|_| "vault runtime operation lock is poisoned".to_string())?;
    let path = peers_json_path(&active_vault_runtime()?);
    let _lock = acquire_peers_file_lock(&path)?;
    let mut pf = read_peers_file_unlocked(&path)?;
    if pf.owner == pubkey {
        return Err("that pubkey is the owner (owners have full write access)".into());
    }
    if pf.peers.contains(&pubkey) {
        return Err("that pubkey is a peer (read-only) — remove it as a peer first".into());
    }
    if !pf.writers.contains(&pubkey) {
        pf.writers.push(pubkey);
        write_peers_file_unlocked(&path, &pf)?;
    }
    Ok(peers_state(pf))
}

/// Remove a writer pubkey.
#[tauri::command]
fn remove_writer(pubkey: String) -> Result<PeersState, String> {
    let _gate = VAULT_RUNTIME_GATE
        .lock()
        .map_err(|_| "vault runtime operation lock is poisoned".to_string())?;
    let path = peers_json_path(&active_vault_runtime()?);
    let _lock = acquire_peers_file_lock(&path)?;
    let mut pf = read_peers_file_unlocked(&path)?;
    pf.writers.retain(|p| p != &pubkey);
    write_peers_file_unlocked(&path, &pf)?;
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
static ACTIVE_ONION_IDS: Mutex<Vec<String>> = Mutex::new(Vec::new());

fn valid_onion_service_id(id: &str) -> bool {
    id.len() == 56
        && id
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || (b'2'..=b'7').contains(&byte))
}

fn active_onion_marker_path(data_dir: &Path, id: &str) -> PathBuf {
    data_dir.join(format!("{ACTIVE_ONION_MARKER_PREFIX}{id}"))
}

/// Detached Tor services survive a process crash, so persist their public
/// service IDs before ADD_ONION. One create-new marker per ID avoids a JSON
/// rewrite window where the cleanup registry itself could be lost.
fn remember_active_onion(data_dir: &Path, id: &str) -> Result<(), String> {
    if !valid_onion_service_id(id) {
        return Err("The onion service id is invalid".into());
    }
    ensure_private_directory(data_dir)?;
    let marker = active_onion_marker_path(data_dir, id);
    match fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&marker)
    {
        Ok(mut file) => {
            file.write_all(id.as_bytes())
                .map_err(|error| format!("write onion cleanup marker: {error}"))?;
            file.sync_all()
                .map_err(|error| format!("sync onion cleanup marker: {error}"))?;
            sync_directory(data_dir)?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(format!("create onion cleanup marker: {error}")),
    }
    let mut ids = ACTIVE_ONION_IDS
        .lock()
        .map_err(|_| "active onion registry lock is poisoned".to_string())?;
    if !ids.iter().any(|candidate| candidate == id) {
        ids.push(id.to_string());
    }
    Ok(())
}

fn forget_active_onion(data_dir: &Path, id: &str) -> Result<(), String> {
    let marker = active_onion_marker_path(data_dir, id);
    match fs::remove_file(&marker) {
        Ok(()) => sync_directory(data_dir)?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("remove onion cleanup marker: {error}")),
    }
    ACTIVE_ONION_IDS
        .lock()
        .map_err(|_| "active onion registry lock is poisoned".to_string())?
        .retain(|candidate| candidate != id);
    Ok(())
}

fn persisted_onion_ids(data_dir: &Path) -> Result<Vec<String>, String> {
    let mut ids = Vec::new();
    let entries = match fs::read_dir(data_dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(ids),
        Err(error) => return Err(format!("read onion cleanup markers: {error}")),
    };
    for entry in entries {
        let entry = entry.map_err(|error| format!("read onion cleanup marker: {error}"))?;
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        let Some(id) = name.strip_prefix(ACTIVE_ONION_MARKER_PREFIX) else {
            continue;
        };
        if !valid_onion_service_id(id) {
            return Err(format!("invalid onion cleanup marker: {name}"));
        }
        ids.push(id.to_string());
    }
    ids.sort();
    ids.dedup();
    Ok(ids)
}

fn stop_owned_tor() -> Result<(), String> {
    let mut owned = TOR_CHILD
        .lock()
        .map_err(|_| "Tor process lock is poisoned".to_string())?;
    if let Some(mut child) = owned.take() {
        match child.try_wait() {
            Ok(Some(_)) => {}
            Ok(None) => {
                if let Err(error) = child.kill() {
                    *owned = Some(child);
                    return Err(format!("stop active vault Tor process: {error}"));
                }
                if let Err(error) = child.wait() {
                    *owned = Some(child);
                    return Err(format!("wait for active vault Tor shutdown: {error}"));
                }
            }
            Err(error) => {
                *owned = Some(child);
                return Err(format!("inspect active vault Tor process: {error}"));
            }
        }
    }
    TOR_SPAWNED.store(false, Ordering::SeqCst);
    Ok(())
}

fn authenticated_tor_control(
    app: &tauri::AppHandle,
) -> Result<(TcpStream, BufReader<TcpStream>), String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("could not resolve app data dir: {error}"))?
        .join(".tor");
    let cookie_path = data_dir.join("control_auth_cookie");
    let mut stream = TcpStream::connect("127.0.0.1:9051")
        .map_err(|error| format!("could not connect to tor control port: {error}"))?;
    let reader_stream = stream
        .try_clone()
        .map_err(|error| format!("clone tor control stream: {error}"))?;
    let mut reader = BufReader::new(reader_stream);
    let cookie_hex = fs::read(&cookie_path)
        .map_err(|error| format!("could not read control auth cookie: {error}"))
        .map(|bytes| {
            bytes
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>()
        })?;
    stream
        .write_all(format!("AUTHENTICATE {cookie_hex}\r\n").as_bytes())
        .map_err(|error| format!("control write AUTHENTICATE: {error}"))?;
    read_control_reply(&mut reader, "AUTHENTICATE")?;
    Ok((stream, reader))
}

fn remove_active_onions(app: &tauri::AppHandle) -> Result<(), String> {
    let data_dir = secret_data_dir(app)?;
    for id in persisted_onion_ids(&data_dir)? {
        remember_active_onion(&data_dir, &id)?;
    }
    let has_ids = !ACTIVE_ONION_IDS
        .lock()
        .map_err(|_| "active onion registry lock is poisoned".to_string())?
        .is_empty();
    if !has_ids {
        return Ok(());
    }
    // Port unreachability is not proof that the prior Tor process is gone: it
    // may still be starting after an app crash. `?` retains the durable IDs
    // until an authenticated control connection confirms DEL_ONION/552.
    let (mut stream, mut reader) = authenticated_tor_control(app)?;
    loop {
        let id = ACTIVE_ONION_IDS
            .lock()
            .map_err(|_| "active onion registry lock is poisoned".to_string())?
            .last()
            .cloned();
        let Some(id) = id else {
            break;
        };
        stream
            .write_all(format!("DEL_ONION {id}\r\n").as_bytes())
            .map_err(|error| format!("control write DEL_ONION: {error}"))?;
        match read_control_reply(&mut reader, "DEL_ONION") {
            Ok(_) => forget_active_onion(&data_dir, &id)?,
            Err(error) if error.contains("552") => forget_active_onion(&data_dir, &id)?,
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

/// Resolve persisted detached services before the first vault can bind the
/// shared relay port. If the old Tor process is gone, starting our configured
/// Tor gives us an authenticated control connection where DEL_ONION returning
/// 552 definitively retires each stale marker.
fn cleanup_persisted_onions_on_startup(app: &tauri::AppHandle) -> Result<(), String> {
    let data_dir = secret_data_dir(app)?;
    if persisted_onion_ids(&data_dir)?.is_empty() {
        return Ok(());
    }
    if remove_active_onions(app).is_ok() {
        return Ok(());
    }

    let start_result = spawn_tor(app.clone())
        .map_err(|error| format!("could not recover detached onion cleanup ownership: {error}"))?;
    let cleanup_result = remove_active_onions(app);
    let stop_result = if start_result == "spawned" {
        stop_owned_tor()
    } else {
        Ok(())
    };
    match (cleanup_result, stop_result) {
        (Ok(()), Ok(())) => Ok(()),
        (Err(cleanup), Ok(())) => Err(cleanup),
        (Ok(()), Err(stop)) => Err(stop),
        (Err(cleanup), Err(stop)) => Err(format!("{cleanup}; additionally, {stop}")),
    }
}

#[tauri::command]
fn remove_onion(app: tauri::AppHandle, address: String) -> Result<(), String> {
    let _gate = VAULT_RUNTIME_GATE
        .lock()
        .map_err(|_| "vault runtime operation lock is poisoned".to_string())?;
    let id = address.strip_suffix(".onion").unwrap_or(&address);
    if !valid_onion_service_id(id) {
        return Err("The onion address is invalid".into());
    }
    let is_active = ACTIVE_ONION_IDS
        .lock()
        .map_err(|_| "active onion registry lock is poisoned".to_string())?
        .iter()
        .any(|candidate| candidate == id);
    if !is_active {
        return Ok(());
    }
    let (mut stream, mut reader) = authenticated_tor_control(&app)?;
    stream
        .write_all(format!("DEL_ONION {id}\r\n").as_bytes())
        .map_err(|error| format!("control write DEL_ONION: {error}"))?;
    match read_control_reply(&mut reader, "DEL_ONION") {
        Ok(_) => {}
        Err(error) if error.contains("552") => {}
        Err(error) => return Err(error),
    }
    forget_active_onion(&secret_data_dir(&app)?, id)
}

/// End vault-owned reachability before the webview releases its secret
/// session. Marking the generation as closing rejects new native work while
/// Kademlia drains its persistence queue and relay samples are cancelled; the
/// active binding remains installed until every vault-owned service has
/// stopped.
async fn lock_vault_runtime_inner(
    app: &tauri::AppHandle,
    kademlia_runtime: &kademlia::KademliaRuntime,
    rendezvous_runtime: &rendezvous_relay::RendezvousRelayRuntime,
    llm_registry: &llm_proxy::LlmRequestRegistry,
) -> Result<(), String> {
    let _transition = VAULT_TRANSITION_GATE.lock().await;
    let binding = {
        let _gate = VAULT_RUNTIME_GATE
            .lock()
            .map_err(|_| "vault runtime operation lock is poisoned".to_string())?;
        let mut active = ACTIVE_VAULT_RUNTIME
            .lock()
            .map_err(|_| "active vault runtime lock is poisoned".to_string())?;
        let Some(active) = active.as_mut() else {
            return llm_registry.verify_closed();
        };
        active.closing = true;
        active.binding()
    };

    tokio::time::timeout(
        LLM_VAULT_DRAIN_TIMEOUT,
        llm_registry.close_for_vault_transition(&binding),
    )
    .await
    .map_err(|_| "LLM provider requests did not drain during vault shutdown".to_string())??;
    llm_registry.verify_closed()?;

    kademlia::stop_for_vault_transition(kademlia_runtime, &binding).await?;
    rendezvous_runtime
        .cancel_for_vault_transition(&binding)
        .await;

    let _gate = VAULT_RUNTIME_GATE
        .lock()
        .map_err(|_| "vault runtime operation lock is poisoned".to_string())?;
    remove_active_onions(app)?;
    stop_owned_tor()?;
    stop_owned_relay()?;
    let mut active = ACTIVE_VAULT_RUNTIME
        .lock()
        .map_err(|_| "active vault runtime lock is poisoned".to_string())?;
    match active.as_ref() {
        Some(current) if current.binding() == binding => *active = None,
        Some(_) => return Err("The active vault changed during native shutdown".into()),
        None => return Err("The active vault disappeared during native shutdown".into()),
    }
    Ok(())
}

#[tauri::command]
async fn lock_vault_runtime(app: tauri::AppHandle) -> Result<(), String> {
    let kademlia_runtime = app.state::<kademlia::KademliaRuntime>();
    let rendezvous_runtime = app.state::<rendezvous_relay::RendezvousRelayRuntime>();
    let llm_registry = app.state::<llm_proxy::LlmRequestRegistry>();
    lock_vault_runtime_inner(&app, &kademlia_runtime, &rendezvous_runtime, &llm_registry).await
}

/// A webview reload does not reset native plugin or sidecar state. If the new
/// renderer finds an already-active vault, close its native reachability and
/// restart the process so Stronghold is unloaded before any selector appears.
#[tauri::command]
async fn recover_webview_reload(app: tauri::AppHandle) -> Result<bool, String> {
    if WEBVIEW_RESTART_PENDING.load(Ordering::SeqCst) {
        return Ok(true);
    }
    if WEBVIEW_RESTART_PENDING.load(Ordering::SeqCst) {
        return Ok(true);
    }
    let active = ACTIVE_VAULT_RUNTIME
        .lock()
        .map_err(|_| "active vault runtime lock is poisoned".to_string())?
        .is_some();
    if !active {
        return Ok(false);
    }
    lock_vault_runtime(app.clone()).await?;
    WEBVIEW_RESTART_PENDING.store(true, Ordering::SeqCst);
    app.request_restart();
    Ok(true)
}

/// Spawn the Tor daemon if it isn't already up. Mirrors spawn_relay: locate the
/// binary, spawn detached, poll the SOCKS port for readiness. Returns "running"
/// / "spawned" / "already spawned" so the caller can decide whether to set up
/// the onion service next.
#[tauri::command]
fn spawn_tor(app: tauri::AppHandle) -> Result<String, String> {
    let _gate = VAULT_RUNTIME_GATE
        .lock()
        .map_err(|_| "vault runtime operation lock is poisoned".to_string())?;
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
    ensure_private_directory(&data_dir)
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
    if let Ok(resource) = app.path().resolve(
        format!("binaries/tor{}", EXE_SUFFIX),
        BaseDirectory::Resource,
    ) {
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
/// independently (pure crypto, no Tor). The expected address is persisted
/// before registration so a crash cannot lose cleanup ownership of a detached
/// service. A mismatch means the seed was corrupted in transit.
#[tauri::command]
fn setup_onion(
    app: tauri::AppHandle,
    seed_base64: String,
    expected_address: String,
) -> Result<String, String> {
    let _gate = VAULT_RUNTIME_GATE
        .lock()
        .map_err(|_| "vault runtime operation lock is poisoned".to_string())?;
    let runtime = active_vault_runtime()?;
    let peers_path = peers_json_path(&runtime);
    let peers = {
        let _peers_lock = acquire_peers_file_lock(&peers_path)?;
        read_peers_file_unlocked(&peers_path)?
    };
    if !is_valid_pubkey(&peers.owner) {
        return Err("Activate networked mode before making this vault reachable".into());
    }

    let expected_id = expected_address
        .strip_suffix(".onion")
        .unwrap_or(&expected_address);
    if !valid_onion_service_id(expected_id) {
        return Err("The expected onion address is invalid".into());
    }
    let (mut stream, mut reader) = authenticated_tor_control(&app)?;
    let data_dir = secret_data_dir(&app)?;
    remember_active_onion(&data_dir, expected_id)?;

    // ADD_ONION with the derived key. Port=80,127.0.0.1:4869 means inbound
    // onion port 80 forwards to the relay's localhost port. The key is passed
    // inline — never persisted to disk by Tor (transport.md §3.4).
    let add_cmd = format!(
        "ADD_ONION ED25519-V3:{} Flags=Detach Port=80,127.0.0.1:4869\r\n",
        seed_base64
    );
    stream
        .write_all(add_cmd.as_bytes())
        .map_err(|e| format!("control write ADD_ONION: {e}"))?;

    // The reply contains a line like: 250-ServiceID=<address-without-.onion>.
    // Keep the expected marker on ambiguous control failures; the next normal
    // lock or app startup will issue a harmless DEL_ONION retry.
    let reply = read_control_reply(&mut reader, "ADD_ONION")?;
    for line in &reply {
        if let Some(rest) = line.strip_prefix("ServiceID=") {
            if rest != expected_id {
                if valid_onion_service_id(rest) {
                    remember_active_onion(&data_dir, rest)?;
                    stream
                        .write_all(format!("DEL_ONION {rest}\r\n").as_bytes())
                        .map_err(|error| format!("control write mismatched DEL_ONION: {error}"))?;
                    match read_control_reply(&mut reader, "DEL_ONION") {
                        Ok(_) => forget_active_onion(&data_dir, rest)?,
                        Err(error) if error.contains("552") => {
                            forget_active_onion(&data_dir, rest)?
                        }
                        Err(error) => return Err(error),
                    }
                }
                forget_active_onion(&data_dir, expected_id)?;
                return Err(format!(
                    "Tor reported {rest}.onion but the selected key derives {expected_address}"
                ));
            }
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
fn read_control_reply<R: BufRead>(reader: &mut R, label: &str) -> Result<Vec<String>, String> {
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
    let mut builder = tauri::Builder::default();
    #[cfg(desktop)]
    {
        // Must be the first plugin: a second process must exit before it can
        // open Stronghold or a decrypted workspace cache.
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
            }
        }));
    }
    let app = builder
        .manage(kademlia::KademliaRuntime::default())
        .manage(rendezvous_relay::RendezvousRelayRuntime::default())
        .manage(llm_proxy::LlmRequestRegistry::default())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let data_dir = secret_data_dir(app.handle()).map_err(std::io::Error::other)?;
            ensure_private_directory(&data_dir).map_err(std::io::Error::other)?;
            // A prior crash may have left detached onion services alive. Drain
            // their durable IDs before any vault can bind the shared relay port.
            cleanup_persisted_onions_on_startup(app.handle()).map_err(std::io::Error::other)?;
            app.handle().plugin(
                tauri_plugin_stronghold::Builder::new(move |password| {
                    derive_stronghold_key(&data_dir, password)
                })
                .build(),
            )?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            secret_vault_status,
            list_secret_vaults,
            create_secret_vault,
            discard_empty_secret_vault,
            activate_vault_runtime,
            lock_vault_runtime,
            recover_webview_reload,
            spawn_relay,
            factory_reset,
            factory_reset_vault,
            pick_folder,
            pick_file,
            scan_external,
            write_text_file,
            llm_proxy::llm_fetch,
            llm_proxy::llm_cancel,
            stamp_ots,
            upgrade_ots,
            spawn_tor,
            setup_onion,
            remove_onion,
            list_peers,
            set_owner,
            add_peer,
            remove_peer,
            add_writer,
            remove_writer,
            kademlia::kademlia_start,
            kademlia::kademlia_stop,
            kademlia::kademlia_status,
            kademlia::kademlia_publish_pointer,
            kademlia::kademlia_lookup,
            kademlia::kademlia_cancel,
            rendezvous_relay::rendezvous_sample_relay,
            rendezvous_relay::rendezvous_cancel_relay_sample,
            desktop_operation_journal::desktop_operation_journal_create,
            desktop_operation_journal::desktop_operation_journal_replace,
            desktop_operation_journal::desktop_operation_journal_load,
            desktop_operation_journal::desktop_operation_journal_list_page,
            desktop_operation_journal::desktop_operation_journal_delete,
            desktop_operation_journal::desktop_operation_journal_delete_expired,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");
    app.run(|app_handle, event| {
        if let tauri::RunEvent::ExitRequested { api, .. } = event {
            if let Err(error) =
                tauri::async_runtime::block_on(lock_vault_runtime(app_handle.clone()))
            {
                eprintln!("could not stop the active vault runtime: {error}");
                api.prevent_exit();
            }
        }
    });
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
    fn vault_registry_adopts_the_legacy_snapshot_without_moving_it() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock should be after Unix epoch")
            .as_nanos();
        let dir =
            std::env::temp_dir().join(format!("zine-secret-adopt-{}-{nonce}", std::process::id()));
        fs::create_dir_all(&dir).expect("create secret adoption test directory");
        let legacy = dir.join(SECRET_VAULT_FILENAME);
        fs::write(&legacy, b"encrypted").expect("write legacy vault fixture");

        let first = load_vault_registry(&dir).expect("adopt legacy vault");
        let second = load_vault_registry(&dir).expect("reopen adopted registry");

        assert_eq!(first.len(), 1);
        assert_eq!(first[0].id, LEGACY_VAULT_ID);
        assert!(first[0].legacy);
        assert_eq!(second.len(), 1, "adoption must be idempotent");
        assert!(legacy.exists(), "adoption must preserve the snapshot path");
        assert!(vault_registry_path(&dir).is_file());
        fs::remove_dir_all(dir).expect("remove secret adoption test directory");
    }

    #[test]
    fn reserved_vaults_get_distinct_snapshot_paths_and_start_empty() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock should be after Unix epoch")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "zine-secret-reserve-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).expect("create secret reservation test directory");

        let first = reserve_secret_vault(&dir, "Work", nonce).expect("reserve first vault");
        let second = reserve_secret_vault(&dir, "Personal", nonce).expect("reserve second vault");
        let records = load_vault_registry(&dir).expect("reopen vault registry");

        assert_ne!(first.id, second.id);
        assert_eq!(first.name, "Work");
        assert!(!first.snapshot_exists);
        assert!(!second.snapshot_exists);
        assert_eq!(records.len(), 2);
        let first_path = vault_snapshot_path(
            &dir,
            records
                .iter()
                .find(|vault| vault.id == first.id)
                .expect("first record"),
        )
        .expect("first snapshot path");
        let second_path = vault_snapshot_path(
            &dir,
            records
                .iter()
                .find(|vault| vault.id == second.id)
                .expect("second record"),
        )
        .expect("second snapshot path");
        assert_ne!(first_path, second_path);
        assert_eq!(
            first_path.file_name().and_then(|name| name.to_str()),
            Some(SECRET_VAULT_SNAPSHOT_FILENAME)
        );
        assert_eq!(
            first_path
                .parent()
                .and_then(Path::file_name)
                .and_then(|name| name.to_str()),
            Some(first.id.as_str())
        );
        fs::remove_dir_all(dir).expect("remove secret reservation test directory");
    }

    #[test]
    fn vault_names_are_unique_without_case_or_whitespace_ambiguity() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock should be after Unix epoch")
            .as_nanos();
        let dir =
            std::env::temp_dir().join(format!("zine-secret-name-{}-{nonce}", std::process::id()));
        reserve_secret_vault(&dir, "Work", nonce).expect("reserve named vault");
        let duplicate = reserve_secret_vault(&dir, " work ", nonce + 1);
        assert!(duplicate.unwrap_err().contains("already exists"));
        fs::remove_dir_all(dir).expect("remove vault name test directory");
    }

    #[test]
    fn vault_registry_recovers_when_the_live_file_is_missing_or_corrupt() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock should be after Unix epoch")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "zine-secret-recovery-{}-{nonce}",
            std::process::id()
        ));
        let created =
            reserve_secret_vault(&dir, "Recoverable", nonce).expect("reserve recoverable vault");
        let registry = vault_registry_path(&dir);
        let backup = vault_registry_backup_path(&dir);
        fs::copy(&registry, &backup).expect("stage registry backup");
        fs::write(&registry, b"not-json").expect("corrupt live registry");

        let recovered = load_vault_registry(&dir).expect("recover registry backup");
        assert_eq!(recovered.len(), 1);
        assert_eq!(recovered[0].id, created.id);

        fs::remove_file(&registry).expect("remove live registry");
        let recovered_missing = load_vault_registry(&dir).expect("recover missing registry");
        assert_eq!(recovered_missing[0].id, created.id);
        fs::remove_dir_all(dir).expect("remove registry recovery test directory");
    }

    #[test]
    fn vault_registry_rejects_duplicate_ids_and_names() {
        let dir =
            std::env::temp_dir().join(format!("zine-secret-duplicates-{}", std::process::id()));
        let duplicate_ids = br#"[
          {"id":"vault-one","name":"One","createdAt":1,"legacy":false},
          {"id":"vault-one","name":"Two","createdAt":2,"legacy":false}
        ]"#;
        assert!(validate_vault_registry(&dir, duplicate_ids)
            .unwrap_err()
            .contains("duplicate id"));

        let duplicate_names = br#"[
          {"id":"vault-one","name":"Work","createdAt":1,"legacy":false},
          {"id":"vault-two","name":" work ","createdAt":2,"legacy":false}
        ]"#;
        assert!(validate_vault_registry(&dir, duplicate_names)
            .unwrap_err()
            .contains("duplicate name"));
    }

    #[test]
    fn vault_registry_lock_excludes_a_second_transaction() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock should be after Unix epoch")
            .as_nanos();
        let dir =
            std::env::temp_dir().join(format!("zine-secret-lock-{}-{nonce}", std::process::id()));
        let first = VaultRegistryLock::acquire(&dir).expect("acquire first registry lock");
        let second = VaultRegistryLock::acquire(&dir);
        assert!(second.is_err(), "a second registry transaction must wait");
        drop(first);
        VaultRegistryLock::acquire(&dir).expect("registry lock should be reusable");
        fs::remove_dir_all(dir).expect("remove registry lock test directory");
    }

    #[test]
    fn new_vaults_have_distinct_kdf_salt_paths() {
        let dir = std::env::temp_dir().join(format!("zine-secret-salts-{}", std::process::id()));
        let first = vault_salt_path(&dir, Some("vault-one")).expect("first salt path");
        let second = vault_salt_path(&dir, Some("vault-two")).expect("second salt path");
        let legacy = vault_salt_path(&dir, None).expect("legacy salt path");
        assert_ne!(first, second);
        assert_ne!(first, legacy);
        assert_eq!(
            first.file_name().and_then(|name| name.to_str()),
            Some(SECRET_VAULT_SALT_FILENAME)
        );
    }

    #[test]
    fn kdf_v1_matches_the_legacy_stronghold_plugin() {
        let passphrase = b"legacy vault passphrase";
        let salt = [0x5au8; 32];
        let legacy = argon2_legacy::hash_raw(passphrase, &salt, &argon2_legacy::Config::default())
            .expect("legacy plugin KDF vector");

        assert_eq!(derive_stronghold_key_v1(passphrase, &salt), legacy);
    }

    #[cfg(unix)]
    #[test]
    fn owned_relay_can_stop_and_relaunch_without_leaving_a_child() {
        let _gate = VAULT_RUNTIME_GATE
            .lock()
            .expect("vault runtime operation lock");

        for _ in 0..2 {
            let child = Command::new("sleep")
                .arg("30")
                .spawn()
                .expect("spawn relay stand-in");
            *RELAY_CHILD.lock().expect("relay process lock") = Some(child);
            RELAY_SPAWNED.store(true, Ordering::SeqCst);

            stop_owned_relay().expect("stop relay stand-in");
            assert!(!RELAY_SPAWNED.load(Ordering::SeqCst));
            assert!(RELAY_CHILD.lock().expect("relay process lock").is_none());
        }
    }

    #[cfg(unix)]
    #[test]
    fn vault_directories_are_owner_only() {
        use std::os::unix::fs::PermissionsExt;

        let dir =
            std::env::temp_dir().join(format!("zine-private-directory-{}", std::process::id()));
        ensure_private_directory(&dir).expect("create protected vault directory");
        let mode = fs::metadata(&dir)
            .expect("read protected directory metadata")
            .permissions()
            .mode();
        assert_eq!(mode & 0o077, 0);
        fs::remove_dir_all(dir).expect("remove protected directory test fixture");
    }

    #[cfg(unix)]
    #[test]
    fn vault_runtime_rejects_symlink_and_non_directory_leaves() {
        use std::os::unix::fs::symlink;

        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "zine-unsafe-vault-leaf-{}-{nonce}",
            std::process::id()
        ));
        let sentinel = root.join("sentinel");
        let symlink_leaf = root.join("symlink-vault");
        let file_leaf = root.join("file-vault");
        fs::create_dir_all(&sentinel).expect("create sentinel directory");
        fs::write(sentinel.join("keep"), b"sentinel").expect("write sentinel");
        symlink(&sentinel, &symlink_leaf).expect("create vault symlink");
        fs::write(&file_leaf, b"not a directory").expect("write non-directory leaf");

        assert!(prepare_vault_runtime_directory(&symlink_leaf).is_err());
        assert!(prepare_vault_runtime_directory(&file_leaf).is_err());
        assert_eq!(
            fs::read(sentinel.join("keep")).expect("read sentinel"),
            b"sentinel"
        );
        assert!(!sentinel.join("press.sqlite3").exists());
        fs::remove_dir_all(root).expect("remove unsafe leaf fixture");
    }

    #[cfg(unix)]
    #[test]
    fn reset_revalidates_a_pinned_vault_path_before_deleting() {
        use std::os::unix::fs::symlink;

        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "zine-replaced-vault-leaf-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&root).expect("create replacement fixture");
        let leaf = root.join("vault");
        let pinned = prepare_vault_runtime_directory(&leaf).expect("pin vault directory");
        let displaced = root.join("displaced-vault");
        fs::rename(&leaf, &displaced).expect("displace pinned vault directory");
        let sentinel = root.join("sentinel");
        fs::create_dir_all(&sentinel).expect("create sentinel directory");
        fs::write(sentinel.join("keep"), b"sentinel").expect("write sentinel");
        fs::write(sentinel.join("press.sqlite3"), b"do not delete")
            .expect("write sentinel database");
        symlink(&sentinel, &leaf).expect("replace vault leaf with symlink");

        assert!(desktop_operation_journal::remove_database_files(&pinned).is_err());
        assert_eq!(
            fs::read(sentinel.join("keep")).expect("read sentinel"),
            b"sentinel"
        );
        assert_eq!(
            fs::read(sentinel.join("press.sqlite3")).expect("read sentinel database"),
            b"do not delete"
        );
        fs::remove_dir_all(root).expect("remove replacement fixture");
    }

    #[test]
    fn native_runtime_requires_the_workspace_key_sealed_by_the_vault() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock should be after Unix epoch")
            .as_nanos();
        let dir =
            std::env::temp_dir().join(format!("zine-runtime-key-{}-{nonce}", std::process::id()));
        fs::create_dir_all(&dir).expect("create runtime verifier directory");
        verify_vault_runtime_key(&dir, &[0x11; 32]).expect("install runtime verifier");
        verify_vault_runtime_key(&dir, &[0x11; 32]).expect("reopen with matching key");
        assert!(verify_vault_runtime_key(&dir, &[0x22; 32])
            .unwrap_err()
            .contains("did not authorize"));
        fs::remove_dir_all(dir).expect("remove runtime verifier test directory");
    }

    #[test]
    fn native_commands_require_an_open_non_closing_vault_generation() {
        assert!(usable_vault_runtime(None)
            .expect_err("locked vault must reject native commands")
            .contains("Unlock a vault"));

        let closing = ActiveVaultRuntime {
            id: "vault-a".into(),
            directory: PathBuf::from("vault-a"),
            generation: 41,
            closing: true,
            journal_key: desktop_operation_journal::JournalKey::derive(&[0x41; 32], "vault-a")
                .expect("derive closing test journal key"),
            journal_session_id: "a".repeat(64),
        };
        assert!(usable_vault_runtime(Some(closing))
            .expect_err("closing generation must reject native commands")
            .contains("locking"));

        let open = ActiveVaultRuntime {
            id: "vault-a".into(),
            directory: PathBuf::from("vault-a"),
            generation: 42,
            closing: false,
            journal_key: desktop_operation_journal::JournalKey::derive(&[0x42; 32], "vault-a")
                .expect("derive open test journal key"),
            journal_session_id: "b".repeat(64),
        };
        assert_eq!(
            usable_vault_runtime(Some(open.clone()))
                .expect("open generation is usable")
                .binding(),
            open.binding()
        );
    }

    #[test]
    fn factory_reset_removes_all_secret_vaults_but_keeps_the_kdf_salt() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock should be after Unix epoch")
            .as_nanos();
        let dir =
            std::env::temp_dir().join(format!("zine-secret-reset-{}-{nonce}", std::process::id()));
        fs::create_dir_all(&dir).expect("create secret reset test directory");
        let vault = dir.join(SECRET_VAULT_FILENAME);
        let vaults_dir = dir.join(SECRET_VAULTS_DIRNAME);
        let second_vault = vaults_dir
            .join("vault-test")
            .join(SECRET_VAULT_SNAPSHOT_FILENAME);
        let registry = vault_registry_path(&dir);
        let salt = dir.join(SECRET_SALT_FILENAME);
        let unrelated = dir.join("keep-me");
        fs::create_dir_all(second_vault.parent().expect("second vault directory"))
            .expect("create vault snapshots directory");
        fs::write(&vault, b"encrypted").expect("write vault fixture");
        fs::write(&second_vault, b"encrypted-too").expect("write second vault fixture");
        fs::write(&registry, b"[]").expect("write registry fixture");
        fs::write(&salt, b"salt").expect("write salt fixture");
        fs::write(&unrelated, b"other").expect("write unrelated fixture");

        remove_secret_vaults(&dir).expect("reset vault snapshots");
        remove_secret_vaults(&dir).expect("reset should be idempotent");

        assert!(!vault.exists());
        assert!(!vaults_dir.exists());
        assert!(!registry.exists());
        assert!(
            salt.exists(),
            "the live plugin's KDF salt must survive reload"
        );
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
    fn peers_transaction_keeps_the_captured_vault_path() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock should be after Unix epoch")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "zine-peers-captured-path-{}-{nonce}",
            std::process::id()
        ));
        let vault_a = ActiveVaultRuntime {
            id: "vault-a".into(),
            directory: dir.join("vault-a"),
            generation: 1,
            closing: false,
            journal_key: desktop_operation_journal::JournalKey::derive(&[0xa1; 32], "vault-a")
                .expect("derive vault A test journal key"),
            journal_session_id: "a".repeat(64),
        };
        let vault_b = ActiveVaultRuntime {
            id: "vault-b".into(),
            directory: dir.join("vault-b"),
            generation: 2,
            closing: false,
            journal_key: desktop_operation_journal::JournalKey::derive(&[0xb2; 32], "vault-b")
                .expect("derive vault B test journal key"),
            journal_session_id: "b".repeat(64),
        };
        let path_a = peers_json_path(&vault_a);
        let path_b = peers_json_path(&vault_b);
        let owner = "a".repeat(64);
        {
            let _lock = acquire_peers_file_lock(&path_a).expect("lock captured vault ACL");
            write_peers_file_unlocked(
                &path_a,
                &PeersFile {
                    owner: owner.clone(),
                    peers: Vec::new(),
                    writers: Vec::new(),
                },
            )
            .expect("write captured vault ACL");
        }

        assert_eq!(
            read_peers_file_unlocked(&path_a)
                .expect("read captured vault ACL")
                .owner,
            owner
        );
        assert!(!path_b.exists(), "another vault path must remain untouched");
        fs::remove_dir_all(dir).expect("remove captured path test directory");
    }

    #[test]
    fn detached_onion_cleanup_ids_survive_process_memory_loss() {
        let _gate = VAULT_RUNTIME_GATE
            .lock()
            .expect("vault runtime operation lock");
        ACTIVE_ONION_IDS
            .lock()
            .expect("active onion registry")
            .clear();
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock should be after Unix epoch")
            .as_nanos();
        let dir =
            std::env::temp_dir().join(format!("zine-onion-cleanup-{}-{nonce}", std::process::id()));
        let id = "a".repeat(56);

        remember_active_onion(&dir, &id).expect("persist detached onion id");
        ACTIVE_ONION_IDS
            .lock()
            .expect("active onion registry")
            .clear();
        let persisted = persisted_onion_ids(&dir).expect("recover marker");
        assert_eq!(persisted.as_slice(), std::slice::from_ref(&id));

        remember_active_onion(&dir, &id).expect("reload detached onion id");
        forget_active_onion(&dir, &id).expect("retire detached onion id");
        assert!(persisted_onion_ids(&dir)
            .expect("read retired markers")
            .is_empty());
        assert!(ACTIVE_ONION_IDS
            .lock()
            .expect("active onion registry")
            .is_empty());
        fs::remove_dir_all(dir).expect("remove onion cleanup test directory");
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

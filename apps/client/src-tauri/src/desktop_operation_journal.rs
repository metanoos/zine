use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use rusqlite::config::DbConfig;
use rusqlite::{params, Connection, OpenFlags, OptionalExtension, TransactionBehavior};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use crate::{active_vault_runtime, VAULT_RUNTIME_GATE};

const JOURNAL_FILENAME: &str = "press.sqlite3";
const JOURNAL_WAL_FILENAME: &str = "press.sqlite3-wal";
const JOURNAL_SHM_FILENAME: &str = "press.sqlite3-shm";
const JOURNAL_SCHEMA_VERSION: i64 = 2;
const MAX_ENVELOPE_BYTES: usize = 2 * 1_024 * 1_024;
const MAX_CIPHERTEXT_BYTES: usize = MAX_ENVELOPE_BYTES + 16;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
// Mirrors DESKTOP_OPERATION_MAX_RETENTION_MS in the owning TypeScript
// contract. Keep the expression visible so both trust boundaries derive the
// same exact 30-day interval.
const DESKTOP_OPERATION_MAX_RETENTION_MS: u64 = 30 * 24 * 60 * 60 * 1_000;
const DEFAULT_PAGE_LIMIT: usize = 8;
const MAX_PAGE_LIMIT: usize = 16;
const NONCE_BYTES: usize = 24;
const KEY_BYTES: usize = 64;
const ENCRYPTION_KEY_BYTES: usize = 32;
const KDF_SALT: &[u8] = b"zine.desktop-operation-journal.hkdf.v1";
const KDF_INFO_PREFIX: &[u8] = b"zine.desktop-operation-journal.key.v1\0";
const RECORD_ID_DOMAIN: &[u8] = b"zine.desktop-operation-journal.record-id.v1\0";
const AEAD_DOMAIN: &[u8] = b"zine.desktop-operation-journal.envelope.v1\0";
const ENVELOPE_HASH_DOMAIN: &[u8] = b"zine.desktop-operation.envelope.v1\0";

type HmacSha256 = Hmac<Sha256>;

#[derive(Clone)]
pub(crate) struct PinnedVaultDirectory {
    #[cfg(test)]
    path: PathBuf,
    handle: Arc<fs::File>,
}

impl PinnedVaultDirectory {
    pub(crate) fn open(path: &Path) -> Result<Self, String> {
        #[cfg(unix)]
        {
            use std::os::unix::fs::{MetadataExt, OpenOptionsExt};

            let handle = fs::OpenOptions::new()
                .read(true)
                .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
                .open(path)
                .map_err(|_| storage_unavailable())?;
            let descriptor_metadata = handle.metadata().map_err(|_| storage_unavailable())?;
            let path_metadata = fs::symlink_metadata(path).map_err(|_| storage_unavailable())?;
            if !descriptor_metadata.is_dir()
                || path_metadata.file_type().is_symlink()
                || !path_metadata.is_dir()
                || descriptor_metadata.dev() != path_metadata.dev()
                || descriptor_metadata.ino() != path_metadata.ino()
            {
                return Err(storage_unavailable());
            }
            let canonical = fs::canonicalize(path).map_err(|_| storage_unavailable())?;
            if canonical != path {
                return Err(storage_unavailable());
            }
            Ok(Self {
                #[cfg(test)]
                path: path.to_path_buf(),
                handle: Arc::new(handle),
            })
        }
        #[cfg(not(unix))]
        {
            let _ = path;
            Err("The operation journal requires descriptor-relative filesystem support".into())
        }
    }

    fn sqlite_path(&self) -> Result<PathBuf, String> {
        #[cfg(target_os = "linux")]
        {
            use std::os::fd::AsRawFd;

            let root = PathBuf::from(format!("/proc/self/fd/{}", self.handle.as_raw_fd()));
            Ok(root.join(JOURNAL_FILENAME))
        }
        #[cfg(target_os = "macos")]
        {
            use std::ffi::{CStr, OsStr};
            use std::os::fd::AsRawFd;
            use std::os::unix::ffi::OsStrExt;

            // rusqlite's default macOS VFS cannot open a database or its WAL
            // relative to a directory descriptor. F_GETPATH instead resolves
            // the *current* path of the already-pinned directory. The
            // pre/post dev+inode checks in `open_checked` detect a completed
            // rename or symlink substitution and fail closed. They do not
            // claim protection from a malicious same-UID ABA swap between
            // both checks; eliminating that residual race requires a custom
            // SQLite VFS whose main/WAL/SHM opens are all based on openat(2).
            let mut buffer = [0i8; libc::PATH_MAX as usize];
            if unsafe {
                libc::fcntl(
                    self.handle.as_raw_fd(),
                    libc::F_GETPATH,
                    buffer.as_mut_ptr(),
                )
            } < 0
            {
                return Err(storage_unavailable());
            }
            let directory = unsafe { CStr::from_ptr(buffer.as_ptr()) };
            Ok(PathBuf::from(OsStr::from_bytes(directory.to_bytes())).join(JOURNAL_FILENAME))
        }
        #[cfg(not(any(target_os = "linux", target_os = "macos")))]
        {
            Err("The operation journal requires descriptor-relative filesystem support".into())
        }
    }

    #[cfg(unix)]
    fn verify_sqlite_path(&self, path: &Path) -> Result<(), String> {
        use std::os::unix::fs::MetadataExt;

        let descriptor_metadata = self.handle.metadata().map_err(|_| storage_unavailable())?;
        let parent = path.parent().ok_or_else(storage_unavailable)?;
        let parent_metadata = fs::metadata(parent).map_err(|_| storage_unavailable())?;
        if !parent_metadata.is_dir()
            || descriptor_metadata.dev() != parent_metadata.dev()
            || descriptor_metadata.ino() != parent_metadata.ino()
        {
            return Err(storage_unavailable());
        }

        let relative = self
            .open_relative(JOURNAL_FILENAME, false)?
            .ok_or_else(storage_unavailable)?;
        let relative_metadata = relative.metadata().map_err(|_| storage_unavailable())?;
        let path_metadata = fs::symlink_metadata(path).map_err(|_| storage_unavailable())?;
        if path_metadata.file_type().is_symlink()
            || !path_metadata.is_file()
            || relative_metadata.dev() != path_metadata.dev()
            || relative_metadata.ino() != path_metadata.ino()
        {
            return Err(storage_unavailable());
        }
        Ok(())
    }

    fn open_relative(&self, name: &str, create: bool) -> Result<Option<fs::File>, String> {
        #[cfg(unix)]
        {
            use std::ffi::CString;
            use std::os::fd::{AsRawFd, FromRawFd};

            let name = CString::new(name).map_err(|_| storage_unavailable())?;
            let mut flags = libc::O_RDWR | libc::O_CLOEXEC | libc::O_NOFOLLOW;
            if create {
                flags |= libc::O_CREAT;
            }
            let descriptor =
                unsafe { libc::openat(self.handle.as_raw_fd(), name.as_ptr(), flags, 0o600) };
            if descriptor < 0 {
                let error = std::io::Error::last_os_error();
                if !create && error.kind() == std::io::ErrorKind::NotFound {
                    return Ok(None);
                }
                return Err(storage_unavailable());
            }
            let file = unsafe { fs::File::from_raw_fd(descriptor) };
            if !file
                .metadata()
                .map_err(|_| storage_unavailable())?
                .is_file()
            {
                return Err(storage_unavailable());
            }
            if unsafe { libc::fchmod(file.as_raw_fd(), 0o600) } != 0 {
                return Err(storage_unavailable());
            }
            Ok(Some(file))
        }
        #[cfg(not(unix))]
        {
            let _ = (name, create);
            Err("The operation journal requires descriptor-relative filesystem support".into())
        }
    }

    fn unlink_relative(&self, name: &str) -> Result<(), String> {
        #[cfg(unix)]
        {
            use std::ffi::CString;
            use std::os::fd::AsRawFd;

            let name = CString::new(name).map_err(|_| storage_unavailable())?;
            if unsafe { libc::unlinkat(self.handle.as_raw_fd(), name.as_ptr(), 0) } == 0 {
                return Ok(());
            }
            let error = std::io::Error::last_os_error();
            if error.kind() == std::io::ErrorKind::NotFound {
                Ok(())
            } else {
                Err(storage_unavailable())
            }
        }
        #[cfg(not(unix))]
        {
            let _ = name;
            Err("The operation journal requires descriptor-relative filesystem support".into())
        }
    }

    fn sync(&self) -> Result<(), String> {
        self.handle.sync_all().map_err(|_| storage_unavailable())
    }
}

pub(crate) trait JournalDirectorySource {
    fn pinned_directory(&self) -> Result<PinnedVaultDirectory, String>;
}

impl JournalDirectorySource for PinnedVaultDirectory {
    fn pinned_directory(&self) -> Result<PinnedVaultDirectory, String> {
        Ok(self.clone())
    }
}

impl JournalDirectorySource for PathBuf {
    fn pinned_directory(&self) -> Result<PinnedVaultDirectory, String> {
        PinnedVaultDirectory::open(self)
    }
}

impl JournalDirectorySource for Path {
    fn pinned_directory(&self) -> Result<PinnedVaultDirectory, String> {
        PinnedVaultDirectory::open(self)
    }
}

pub(crate) struct JournalKey {
    material: Zeroizing<Vec<u8>>,
}

impl Clone for JournalKey {
    fn clone(&self) -> Self {
        Self {
            material: Zeroizing::new(self.material.to_vec()),
        }
    }
}

impl JournalKey {
    pub(crate) fn derive(workspace_key: &[u8], vault_id: &str) -> Result<Self, String> {
        if workspace_key.len() != 32 || vault_id.is_empty() || vault_id.len() > 96 {
            return Err("The vault journal key cannot be derived".into());
        }
        let hkdf = Hkdf::<Sha256>::new(Some(KDF_SALT), workspace_key);
        let mut info = Vec::with_capacity(KDF_INFO_PREFIX.len() + vault_id.len());
        info.extend_from_slice(KDF_INFO_PREFIX);
        info.extend_from_slice(vault_id.as_bytes());
        let mut material = Zeroizing::new(vec![0u8; KEY_BYTES]);
        hkdf.expand(&info, material.as_mut_slice())
            .map_err(|_| "The vault journal key cannot be derived".to_string())?;
        Ok(Self { material })
    }

    fn encryption_key(&self) -> &[u8] {
        &self.material[..ENCRYPTION_KEY_BYTES]
    }

    fn record_id_key(&self) -> &[u8] {
        &self.material[ENCRYPTION_KEY_BYTES..]
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeJournalRecord {
    revision: u64,
    envelope: String,
}

#[derive(Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum NativeJournalCreateResult {
    Created,
    Exists,
}

#[derive(Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum NativeJournalReplaceResult {
    Replaced,
    Conflict,
    Missing,
}

#[derive(Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum NativeJournalDeleteResult {
    Deleted,
    Conflict,
    Missing,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeJournalPage {
    records: Vec<NativeJournalRecord>,
    next_cursor: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeExpiryBatch {
    deleted: u64,
    has_more: bool,
}

struct EnvelopeMetadata {
    operation_id: String,
    attempt_id: String,
    delete_by_ms: u64,
}

struct StoredRecord {
    record_id: Vec<u8>,
    revision: u64,
    delete_by_ms: u64,
    nonce: Vec<u8>,
    ciphertext: Vec<u8>,
}

struct JournalStore {
    directory: PinnedVaultDirectory,
    #[cfg(test)]
    path: PathBuf,
    key: JournalKey,
}

impl JournalStore {
    fn new<D: JournalDirectorySource + ?Sized>(
        directory: &D,
        key: JournalKey,
    ) -> Result<Self, String> {
        let directory = directory.pinned_directory()?;
        #[cfg(test)]
        let path = directory.path.join(JOURNAL_FILENAME);
        prepare_private_database_file(&directory)?;
        let store = Self {
            directory,
            #[cfg(test)]
            path,
            key,
        };
        let connection = store.open()?;
        drop(connection);
        store.directory.sync()?;
        protect_database_files(&store.directory)?;
        Ok(store)
    }

    fn open(&self) -> Result<Connection, String> {
        self.open_checked(|| Ok(()))
    }

    fn open_checked<F>(&self, after_connection_open: F) -> Result<Connection, String>
    where
        F: FnOnce() -> Result<(), String>,
    {
        let path = self.directory.sqlite_path()?;
        #[cfg(unix)]
        self.directory.verify_sqlite_path(&path)?;
        let connection = Connection::open_with_flags(
            &path,
            OpenFlags::SQLITE_OPEN_READ_WRITE
                | OpenFlags::SQLITE_OPEN_CREATE
                | OpenFlags::SQLITE_OPEN_FULL_MUTEX
                | OpenFlags::SQLITE_OPEN_NOFOLLOW,
        )
        .map_err(|_| storage_unavailable())?;
        after_connection_open()?;
        #[cfg(unix)]
        self.directory.verify_sqlite_path(&path)?;
        connection
            .busy_timeout(Duration::from_secs(5))
            .map_err(|_| storage_unavailable())?;
        let journal_mode: String = connection
            .query_row("PRAGMA journal_mode=WAL", [], |row| row.get(0))
            .map_err(|_| storage_unavailable())?;
        if !journal_mode.eq_ignore_ascii_case("wal") {
            return Err(storage_unavailable());
        }
        connection
            .pragma_update(None, "synchronous", "FULL")
            .map_err(|_| storage_unavailable())?;
        connection
            .execute_batch(
                "PRAGMA foreign_keys=ON;
                 PRAGMA fullfsync=ON;
                 PRAGMA checkpoint_fullfsync=ON;
                 PRAGMA wal_autocheckpoint=1000;",
            )
            .map_err(|_| storage_unavailable())?;
        migrate(&connection)?;
        connection
            .set_db_config(DbConfig::SQLITE_DBCONFIG_DEFENSIVE, true)
            .map_err(|_| storage_unavailable())?;
        connection
            .set_db_config(DbConfig::SQLITE_DBCONFIG_TRUSTED_SCHEMA, false)
            .map_err(|_| storage_unavailable())?;
        protect_database_files(&self.directory)?;
        Ok(connection)
    }

    fn create(&self, envelope: &str) -> Result<NativeJournalCreateResult, String> {
        self.create_at(envelope, native_unix_time_ms()?)
    }

    fn create_at(&self, envelope: &str, now_ms: u64) -> Result<NativeJournalCreateResult, String> {
        let metadata = validate_envelope(envelope)?;
        require_live_deadline(&metadata, now_ms)?;
        let record_id = self.record_id(&metadata.operation_id, &metadata.attempt_id)?;
        let mut connection = self.open()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| storage_unavailable())?;
        if let Some(existing) = load_stored(&transaction, &record_id)? {
            self.decrypt_and_validate(&existing)?;
            transaction.commit().map_err(|_| storage_unavailable())?;
            protect_database_files(&self.directory)?;
            return Ok(NativeJournalCreateResult::Exists);
        }
        let revision = 1;
        let (nonce, ciphertext) = self.encrypt(
            &record_id,
            revision,
            metadata.delete_by_ms,
            envelope.as_bytes(),
        )?;
        transaction
            .execute(
                "INSERT INTO desktop_operation_envelopes \
                 (record_id, revision, delete_by_ms, nonce, ciphertext) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    &record_id,
                    revision as i64,
                    metadata.delete_by_ms as i64,
                    &nonce,
                    &ciphertext,
                ],
            )
            .map_err(|_| storage_unavailable())?;
        transaction.commit().map_err(|_| storage_unavailable())?;
        protect_database_files(&self.directory)?;
        Ok(NativeJournalCreateResult::Created)
    }

    fn replace(
        &self,
        operation_id: &str,
        attempt_id: &str,
        expected_envelope_sha256: &str,
        envelope: &str,
    ) -> Result<NativeJournalReplaceResult, String> {
        self.replace_at(
            operation_id,
            attempt_id,
            expected_envelope_sha256,
            envelope,
            native_unix_time_ms()?,
        )
    }

    fn replace_at(
        &self,
        operation_id: &str,
        attempt_id: &str,
        expected_envelope_sha256: &str,
        envelope: &str,
        now_ms: u64,
    ) -> Result<NativeJournalReplaceResult, String> {
        validate_portable_id(operation_id)?;
        validate_portable_id(attempt_id)?;
        validate_sha256(expected_envelope_sha256)?;
        let metadata = validate_envelope(envelope)?;
        require_live_deadline(&metadata, now_ms)?;
        if metadata.operation_id != operation_id || metadata.attempt_id != attempt_id {
            return Err("The replacement envelope belongs to a different operation attempt".into());
        }
        let record_id = self.record_id(operation_id, attempt_id)?;
        let mut connection = self.open()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| storage_unavailable())?;
        let Some(existing) = load_stored(&transaction, &record_id)? else {
            transaction.commit().map_err(|_| storage_unavailable())?;
            return Ok(NativeJournalReplaceResult::Missing);
        };
        let plaintext = self.decrypt_and_validate(&existing)?;
        if existing.delete_by_ms != metadata.delete_by_ms {
            // Retention is fixed at attempt creation. A lifecycle update may
            // never postpone or accelerate whole-envelope deletion.
            return Ok(NativeJournalReplaceResult::Conflict);
        }
        if plaintext == envelope {
            transaction.commit().map_err(|_| storage_unavailable())?;
            protect_database_files(&self.directory)?;
            return Ok(NativeJournalReplaceResult::Replaced);
        }
        if envelope_sha256(&plaintext) != expected_envelope_sha256 {
            transaction.commit().map_err(|_| storage_unavailable())?;
            return Ok(NativeJournalReplaceResult::Conflict);
        }
        let next_revision = existing.revision.checked_add(1).ok_or_else(conflict)?;
        if next_revision > MAX_SAFE_INTEGER {
            return Err(conflict());
        }
        let (nonce, ciphertext) = self.encrypt(
            &record_id,
            next_revision,
            existing.delete_by_ms,
            envelope.as_bytes(),
        )?;
        let changed = transaction
            .execute(
                "UPDATE desktop_operation_envelopes \
                 SET revision = ?1, nonce = ?2, ciphertext = ?3 \
                 WHERE record_id = ?4 AND revision = ?5",
                params![
                    next_revision as i64,
                    &nonce,
                    &ciphertext,
                    &record_id,
                    existing.revision as i64,
                ],
            )
            .map_err(|_| storage_unavailable())?;
        if changed != 1 {
            return Err(conflict());
        }
        transaction.commit().map_err(|_| storage_unavailable())?;
        protect_database_files(&self.directory)?;
        Ok(NativeJournalReplaceResult::Replaced)
    }

    fn load(
        &self,
        operation_id: &str,
        attempt_id: &str,
    ) -> Result<Option<NativeJournalRecord>, String> {
        self.load_at(operation_id, attempt_id, native_unix_time_ms()?)
    }

    fn load_at(
        &self,
        operation_id: &str,
        attempt_id: &str,
        now_ms: u64,
    ) -> Result<Option<NativeJournalRecord>, String> {
        validate_native_time(now_ms)?;
        validate_portable_id(operation_id)?;
        validate_portable_id(attempt_id)?;
        let record_id = self.record_id(operation_id, attempt_id)?;
        let mut connection = self.open()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| storage_unavailable())?;
        let Some(stored) = load_stored(&transaction, &record_id)? else {
            transaction.commit().map_err(|_| storage_unavailable())?;
            return Ok(None);
        };
        let envelope = self.decrypt_and_validate(&stored)?;
        if stored.delete_by_ms <= now_ms {
            delete_stored(&transaction, &stored)?;
            transaction.commit().map_err(|_| storage_unavailable())?;
            protect_database_files(&self.directory)?;
            return Ok(None);
        }
        transaction.commit().map_err(|_| storage_unavailable())?;
        Ok(Some(NativeJournalRecord {
            revision: stored.revision,
            envelope,
        }))
    }

    fn list_page(
        &self,
        cursor: Option<&str>,
        requested_limit: Option<u32>,
    ) -> Result<NativeJournalPage, String> {
        self.list_page_at(cursor, requested_limit, native_unix_time_ms()?)
    }

    fn list_page_at(
        &self,
        cursor: Option<&str>,
        requested_limit: Option<u32>,
        now_ms: u64,
    ) -> Result<NativeJournalPage, String> {
        validate_native_time(now_ms)?;
        let limit = page_limit(requested_limit)?;
        let cursor = decode_cursor(cursor)?;
        let mut connection = self.open()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| storage_unavailable())?;
        let fetch_limit = limit + 1;
        let mut stored_records = if let Some(cursor) = cursor.as_deref() {
            collect_stored(
                &transaction,
                "SELECT record_id, revision, delete_by_ms, nonce, length(ciphertext), ciphertext \
                 FROM desktop_operation_envelopes WHERE record_id > ?1 \
                 ORDER BY record_id LIMIT ?2",
                params![cursor, fetch_limit as i64],
            )?
        } else {
            collect_stored(
                &transaction,
                "SELECT record_id, revision, delete_by_ms, nonce, length(ciphertext), ciphertext \
                 FROM desktop_operation_envelopes ORDER BY record_id LIMIT ?1",
                params![fetch_limit as i64],
            )?
        };
        let has_more = stored_records.len() > limit;
        if has_more {
            stored_records.truncate(limit);
        }
        let next_cursor = if has_more {
            stored_records
                .last()
                .map(|record| hex::encode(&record.record_id))
        } else {
            None
        };
        let mut records = Vec::with_capacity(stored_records.len());
        for stored in stored_records {
            let envelope = self.decrypt_and_validate(&stored)?;
            if stored.delete_by_ms <= now_ms {
                delete_stored(&transaction, &stored)?;
                continue;
            }
            records.push(NativeJournalRecord {
                revision: stored.revision,
                envelope,
            });
        }
        transaction.commit().map_err(|_| storage_unavailable())?;
        protect_database_files(&self.directory)?;
        Ok(NativeJournalPage {
            records,
            next_cursor,
        })
    }

    fn delete(
        &self,
        operation_id: &str,
        attempt_id: &str,
        expected_envelope_sha256: &str,
    ) -> Result<NativeJournalDeleteResult, String> {
        validate_portable_id(operation_id)?;
        validate_portable_id(attempt_id)?;
        validate_sha256(expected_envelope_sha256)?;
        let record_id = self.record_id(operation_id, attempt_id)?;
        let mut connection = self.open()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| storage_unavailable())?;
        let Some(current) = load_stored(&transaction, &record_id)? else {
            transaction.commit().map_err(|_| storage_unavailable())?;
            return Ok(NativeJournalDeleteResult::Missing);
        };
        let current_envelope = self.decrypt_and_validate(&current)?;
        if envelope_sha256(&current_envelope) != expected_envelope_sha256 {
            transaction.commit().map_err(|_| storage_unavailable())?;
            return Ok(NativeJournalDeleteResult::Conflict);
        }
        let changed = transaction
            .execute(
                "DELETE FROM desktop_operation_envelopes WHERE record_id = ?1 AND revision = ?2",
                params![&record_id, current.revision as i64],
            )
            .map_err(|_| storage_unavailable())?;
        if changed != 1 {
            return Err(conflict());
        }
        transaction.commit().map_err(|_| storage_unavailable())?;
        protect_database_files(&self.directory)?;
        Ok(NativeJournalDeleteResult::Deleted)
    }

    fn delete_expired_at(
        &self,
        now_ms: u64,
        requested_limit: Option<u32>,
    ) -> Result<NativeExpiryBatch, String> {
        if now_ms > MAX_SAFE_INTEGER {
            return Err("The operation journal expiry is invalid".into());
        }
        let limit = page_limit(requested_limit)?;
        let mut connection = self.open()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| storage_unavailable())?;
        let due = collect_stored(
            &transaction,
            "SELECT record_id, revision, delete_by_ms, nonce, length(ciphertext), ciphertext \
             FROM desktop_operation_envelopes WHERE delete_by_ms <= ?1 \
             ORDER BY delete_by_ms, record_id LIMIT ?2",
            params![now_ms as i64, limit as i64],
        )?;
        for stored in &due {
            // The deadline is plaintext only so SQLite can select candidates.
            // Authenticate its AEAD binding before allowing it to delete data.
            self.decrypt_and_validate(stored)?;
            delete_stored(&transaction, stored)?;
        }
        let has_more: bool = transaction
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM desktop_operation_envelopes WHERE delete_by_ms <= ?1)",
                params![now_ms as i64],
                |row| row.get(0),
            )
            .map_err(|_| storage_unavailable())?;
        transaction.commit().map_err(|_| storage_unavailable())?;
        protect_database_files(&self.directory)?;
        Ok(NativeExpiryBatch {
            deleted: u64::try_from(due.len()).map_err(|_| storage_unavailable())?,
            has_more,
        })
    }

    fn record_id(&self, operation_id: &str, attempt_id: &str) -> Result<Vec<u8>, String> {
        validate_portable_id(operation_id)?;
        validate_portable_id(attempt_id)?;
        let mut mac = <HmacSha256 as Mac>::new_from_slice(self.key.record_id_key())
            .map_err(|_| storage_unavailable())?;
        mac.update(RECORD_ID_DOMAIN);
        mac.update(operation_id.as_bytes());
        mac.update(b"\0");
        mac.update(attempt_id.as_bytes());
        Ok(mac.finalize().into_bytes().to_vec())
    }

    fn encrypt(
        &self,
        record_id: &[u8],
        revision: u64,
        delete_by_ms: u64,
        plaintext: &[u8],
    ) -> Result<(Vec<u8>, Vec<u8>), String> {
        let cipher = XChaCha20Poly1305::new_from_slice(self.key.encryption_key())
            .map_err(|_| storage_unavailable())?;
        let mut nonce = vec![0u8; NONCE_BYTES];
        getrandom::fill(&mut nonce).map_err(|_| storage_unavailable())?;
        let aad = associated_data(record_id, revision, delete_by_ms);
        let ciphertext = cipher
            .encrypt(
                XNonce::from_slice(&nonce),
                Payload {
                    msg: plaintext,
                    aad: &aad,
                },
            )
            .map_err(|_| storage_unavailable())?;
        Ok((nonce, ciphertext))
    }

    fn decrypt(&self, stored: &StoredRecord) -> Result<Zeroizing<Vec<u8>>, String> {
        if stored.record_id.len() != 32 || stored.nonce.len() != NONCE_BYTES {
            return Err(authentication_failed());
        }
        let cipher = XChaCha20Poly1305::new_from_slice(self.key.encryption_key())
            .map_err(|_| authentication_failed())?;
        let aad = associated_data(&stored.record_id, stored.revision, stored.delete_by_ms);
        let plaintext = cipher
            .decrypt(
                XNonce::from_slice(&stored.nonce),
                Payload {
                    msg: &stored.ciphertext,
                    aad: &aad,
                },
            )
            .map_err(|_| authentication_failed())?;
        Ok(Zeroizing::new(plaintext))
    }

    fn decrypt_and_validate(&self, stored: &StoredRecord) -> Result<String, String> {
        let plaintext = self.decrypt(stored)?;
        let serialized = std::str::from_utf8(&plaintext).map_err(|_| authentication_failed())?;
        let metadata = validate_envelope(serialized).map_err(|_| authentication_failed())?;
        let expected_id = self.record_id(&metadata.operation_id, &metadata.attempt_id)?;
        if expected_id != stored.record_id || metadata.delete_by_ms != stored.delete_by_ms {
            return Err(authentication_failed());
        }
        Ok(serialized.to_owned())
    }
}

fn delete_stored(
    transaction: &rusqlite::Transaction<'_>,
    stored: &StoredRecord,
) -> Result<(), String> {
    let changed = transaction
        .execute(
            "DELETE FROM desktop_operation_envelopes WHERE record_id = ?1 AND revision = ?2",
            params![&stored.record_id, stored.revision as i64],
        )
        .map_err(|_| storage_unavailable())?;
    if changed == 1 {
        Ok(())
    } else {
        Err(conflict())
    }
}

#[tauri::command]
pub(crate) fn desktop_operation_journal_create(
    journal_session_id: String,
    journal_generation: u64,
    envelope: String,
) -> Result<NativeJournalCreateResult, String> {
    with_active_store(&journal_session_id, journal_generation, |store| {
        store.create(&envelope)
    })
}

#[tauri::command]
pub(crate) fn desktop_operation_journal_replace(
    journal_session_id: String,
    journal_generation: u64,
    operation_id: String,
    attempt_id: String,
    expected_envelope_sha256: String,
    envelope: String,
) -> Result<NativeJournalReplaceResult, String> {
    with_active_store(&journal_session_id, journal_generation, |store| {
        store.replace(
            &operation_id,
            &attempt_id,
            &expected_envelope_sha256,
            &envelope,
        )
    })
}

#[tauri::command]
pub(crate) fn desktop_operation_journal_load(
    journal_session_id: String,
    journal_generation: u64,
    operation_id: String,
    attempt_id: String,
) -> Result<Option<NativeJournalRecord>, String> {
    with_active_store(&journal_session_id, journal_generation, |store| {
        store.load(&operation_id, &attempt_id)
    })
}

#[tauri::command]
pub(crate) fn desktop_operation_journal_list_page(
    journal_session_id: String,
    journal_generation: u64,
    cursor: Option<String>,
    limit: Option<u32>,
) -> Result<NativeJournalPage, String> {
    with_active_store(&journal_session_id, journal_generation, |store| {
        store.list_page(cursor.as_deref(), limit)
    })
}

#[tauri::command]
pub(crate) fn desktop_operation_journal_delete(
    journal_session_id: String,
    journal_generation: u64,
    operation_id: String,
    attempt_id: String,
    expected_envelope_sha256: String,
) -> Result<NativeJournalDeleteResult, String> {
    with_active_store(&journal_session_id, journal_generation, |store| {
        store.delete(&operation_id, &attempt_id, &expected_envelope_sha256)
    })
}

#[tauri::command]
pub(crate) fn desktop_operation_journal_delete_expired(
    journal_session_id: String,
    journal_generation: u64,
    limit: Option<u32>,
) -> Result<NativeExpiryBatch, String> {
    with_active_store(&journal_session_id, journal_generation, |store| {
        store.delete_expired_at(native_unix_time_ms()?, limit)
    })
}

pub(crate) fn remove_database_files<D: JournalDirectorySource + ?Sized>(
    directory: &D,
) -> Result<(), String> {
    let directory = directory.pinned_directory()?;
    // Remove transient sidecars before the main file so a crash cannot leave
    // an old WAL beside a newly-created database on the next activation.
    for name in [JOURNAL_SHM_FILENAME, JOURNAL_WAL_FILENAME, JOURNAL_FILENAME] {
        directory.unlink_relative(name)?;
    }
    directory.sync()
}

fn with_active_store<T>(
    journal_session_id: &str,
    journal_generation: u64,
    operation: impl FnOnce(&JournalStore) -> Result<T, String>,
) -> Result<T, String> {
    with_runtime_gate(|| {
        let runtime = active_vault_runtime()?;
        require_active_journal_session(&runtime, journal_session_id, journal_generation)?;
        let store = JournalStore::new(&runtime.journal_directory, runtime.journal_key)?;
        operation(&store)
    })
}

fn with_runtime_gate<T>(operation: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    let _gate = VAULT_RUNTIME_GATE
        .lock()
        .map_err(|_| "The operation journal is unavailable".to_string())?;
    operation()
}

fn require_active_journal_session(
    runtime: &crate::ActiveVaultRuntime,
    journal_session_id: &str,
    journal_generation: u64,
) -> Result<(), String> {
    let valid_generation = journal_generation > 0
        && journal_generation <= MAX_SAFE_INTEGER
        && journal_generation == runtime.generation;
    let valid_session = valid_journal_session_id(journal_session_id)
        && constant_time_equal(
            runtime.journal_session_id.as_bytes(),
            journal_session_id.as_bytes(),
        );
    if !valid_generation || !valid_session {
        return Err("The operation journal command belongs to a stale vault session".into());
    }
    Ok(())
}

fn valid_journal_session_id(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

fn constant_time_equal(expected: &[u8], candidate: &[u8]) -> bool {
    if expected.len() != candidate.len() {
        return false;
    }
    expected
        .iter()
        .zip(candidate)
        .fold(0u8, |difference, (left, right)| difference | (left ^ right))
        == 0
}

fn native_unix_time_ms() -> Result<u64, String> {
    let elapsed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "The operation journal native clock is unavailable".to_string())?;
    let now_ms = u64::try_from(elapsed.as_millis())
        .map_err(|_| "The operation journal native clock is unavailable".to_string())?;
    if now_ms > MAX_SAFE_INTEGER {
        return Err("The operation journal native clock is unavailable".into());
    }
    Ok(now_ms)
}

fn page_limit(requested: Option<u32>) -> Result<usize, String> {
    let limit = requested
        .map(|value| value as usize)
        .unwrap_or(DEFAULT_PAGE_LIMIT);
    if !(1..=MAX_PAGE_LIMIT).contains(&limit) {
        return Err(format!(
            "The operation journal page limit must be between 1 and {MAX_PAGE_LIMIT}"
        ));
    }
    Ok(limit)
}

fn decode_cursor(cursor: Option<&str>) -> Result<Option<Vec<u8>>, String> {
    let Some(cursor) = cursor else {
        return Ok(None);
    };
    if !valid_journal_session_id(cursor) {
        return Err("The operation journal cursor is invalid".into());
    }
    let decoded = hex::decode(cursor).map_err(|_| "The operation journal cursor is invalid")?;
    if decoded.len() != 32 {
        return Err("The operation journal cursor is invalid".into());
    }
    Ok(Some(decoded))
}

fn migrate(connection: &Connection) -> Result<(), String> {
    let version: i64 = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|_| storage_unavailable())?;
    let table = format!(
        "CREATE TABLE desktop_operation_envelopes (
           record_id BLOB PRIMARY KEY NOT NULL
             CHECK(typeof(record_id) = 'blob' AND length(record_id) = 32),
           revision INTEGER NOT NULL CHECK(revision >= 1),
           delete_by_ms INTEGER NOT NULL CHECK(delete_by_ms >= 0),
           nonce BLOB NOT NULL
             CHECK(typeof(nonce) = 'blob' AND length(nonce) = {NONCE_BYTES}),
           ciphertext BLOB NOT NULL
             CHECK(typeof(ciphertext) = 'blob'
               AND length(ciphertext) >= 16
               AND length(ciphertext) <= {MAX_CIPHERTEXT_BYTES})
         ) WITHOUT ROWID;"
    );
    match version {
        0 => connection
            .execute_batch(&format!(
                "BEGIN IMMEDIATE;
                 {table}
                 CREATE INDEX desktop_operation_envelopes_expiry
                   ON desktop_operation_envelopes(delete_by_ms);
                 PRAGMA user_version = {JOURNAL_SCHEMA_VERSION};
                 COMMIT;"
            ))
            .map_err(|_| storage_unavailable()),
        1 => connection
            .execute_batch(&format!(
                "BEGIN IMMEDIATE;
                 ALTER TABLE desktop_operation_envelopes
                   RENAME TO desktop_operation_envelopes_v1;
                 DROP INDEX desktop_operation_envelopes_expiry;
                 {table}
                 INSERT INTO desktop_operation_envelopes
                   (record_id, revision, delete_by_ms, nonce, ciphertext)
                   SELECT record_id, revision, delete_by_ms, nonce, ciphertext
                   FROM desktop_operation_envelopes_v1;
                 DROP TABLE desktop_operation_envelopes_v1;
                 CREATE INDEX desktop_operation_envelopes_expiry
                   ON desktop_operation_envelopes(delete_by_ms);
                 PRAGMA user_version = {JOURNAL_SCHEMA_VERSION};
                 COMMIT;"
            ))
            .map_err(|_| storage_unavailable()),
        JOURNAL_SCHEMA_VERSION => Ok(()),
        _ => Err("The operation journal schema is unsupported".into()),
    }
}

fn load_stored(connection: &Connection, record_id: &[u8]) -> Result<Option<StoredRecord>, String> {
    connection
        .query_row(
            "SELECT record_id, revision, delete_by_ms, nonce, length(ciphertext), ciphertext \
             FROM desktop_operation_envelopes WHERE record_id = ?1",
            params![record_id],
            stored_from_row,
        )
        .optional()
        .map_err(|_| storage_unavailable())
}

fn collect_stored<P: rusqlite::Params>(
    connection: &Connection,
    sql: &str,
    parameters: P,
) -> Result<Vec<StoredRecord>, String> {
    let mut statement = connection.prepare(sql).map_err(|_| storage_unavailable())?;
    let rows = statement
        .query_map(parameters, stored_from_row)
        .map_err(|_| storage_unavailable())?;
    let mut records = Vec::new();
    for row in rows {
        records.push(row.map_err(|_| storage_unavailable())?);
    }
    Ok(records)
}

fn stored_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<StoredRecord> {
    let revision: i64 = row.get(1)?;
    let delete_by_ms: i64 = row.get(2)?;
    // Inspect SQLite's scalar length before asking rusqlite to materialize the
    // attacker-controlled BLOB into a Vec.
    let ciphertext_len: i64 = row.get(4)?;
    if revision <= 0
        || revision as u64 > MAX_SAFE_INTEGER
        || delete_by_ms < 0
        || delete_by_ms as u64 > MAX_SAFE_INTEGER
        || ciphertext_len < 16
        || ciphertext_len as usize > MAX_CIPHERTEXT_BYTES
    {
        return Err(rusqlite::Error::InvalidQuery);
    }
    Ok(StoredRecord {
        record_id: row.get(0)?,
        revision: revision as u64,
        delete_by_ms: delete_by_ms as u64,
        nonce: row.get(3)?,
        ciphertext: row.get(5)?,
    })
}

fn validate_envelope(serialized: &str) -> Result<EnvelopeMetadata, String> {
    if serialized.as_bytes().len() > MAX_ENVELOPE_BYTES {
        return Err("The private operation envelope is too large".into());
    }
    let value: Value = serde_json::from_str(serialized)
        .map_err(|_| "The private operation envelope is malformed".to_string())?;
    validate_safe_json_numbers(&value)?;
    let canonical = serde_json::to_string(&value)
        .map_err(|_| "The private operation envelope is malformed".to_string())?;
    if canonical != serialized {
        return Err("The private operation envelope is not canonical".into());
    }
    let object = value
        .as_object()
        .ok_or_else(|| "The private operation envelope is malformed".to_string())?;
    if object.get("version").and_then(Value::as_u64) != Some(1)
        || object.get("contract").and_then(Value::as_str)
            != Some("desktop-operation-private-local-v1")
    {
        return Err("The private operation envelope contract is unsupported".into());
    }
    let operation_id = object
        .get("operationId")
        .and_then(Value::as_str)
        .ok_or_else(|| "The private operation envelope is malformed".to_string())?;
    validate_portable_id(operation_id)?;
    let attempt_id = object
        .get("attempt")
        .and_then(Value::as_object)
        .and_then(|attempt| attempt.get("attemptId"))
        .and_then(Value::as_str)
        .ok_or_else(|| "The private operation envelope is malformed".to_string())?;
    validate_portable_id(attempt_id)?;
    let retention = object
        .get("retention")
        .and_then(Value::as_object)
        .ok_or_else(|| "The private operation envelope is malformed".to_string())?;
    if retention.get("version").and_then(Value::as_u64) != Some(1)
        || retention.get("classification").and_then(Value::as_str) != Some("vault-local-private")
        || retention.get("deadlineBehavior").and_then(Value::as_str)
            != Some("delete-entire-private-envelope")
        || retention
            .get("deleteAfterTerminal")
            .and_then(Value::as_bool)
            != Some(true)
    {
        return Err("The private operation retention policy is unsupported".into());
    }
    let started_at_ms = retention
        .get("startedAtMs")
        .and_then(Value::as_u64)
        .filter(|value| *value <= MAX_SAFE_INTEGER)
        .ok_or_else(|| "The private operation retention start is invalid".to_string())?;
    let delete_by_ms = retention
        .get("deleteByMs")
        .and_then(Value::as_u64)
        .filter(|value| *value <= MAX_SAFE_INTEGER)
        .ok_or_else(|| "The private operation retention deadline is invalid".to_string())?;
    let interval = delete_by_ms
        .checked_sub(started_at_ms)
        .filter(|interval| *interval > 0 && *interval <= DESKTOP_OPERATION_MAX_RETENTION_MS)
        .ok_or_else(|| {
            "The private operation retention deadline is not positively bounded".to_string()
        })?;
    debug_assert!(interval > 0);
    Ok(EnvelopeMetadata {
        operation_id: operation_id.to_owned(),
        attempt_id: attempt_id.to_owned(),
        delete_by_ms,
    })
}

fn validate_native_time(now_ms: u64) -> Result<(), String> {
    if now_ms <= MAX_SAFE_INTEGER {
        Ok(())
    } else {
        Err("The operation journal native clock is unavailable".into())
    }
}

fn require_live_deadline(metadata: &EnvelopeMetadata, now_ms: u64) -> Result<(), String> {
    validate_native_time(now_ms)?;
    let remaining_ms = metadata.delete_by_ms.checked_sub(now_ms).ok_or_else(|| {
        "The private operation envelope has reached its deletion deadline".to_string()
    })?;
    if remaining_ms == 0 {
        Err("The private operation envelope has reached its deletion deadline".into())
    } else if remaining_ms > DESKTOP_OPERATION_MAX_RETENTION_MS {
        Err("The private operation envelope exceeds the native retention maximum".into())
    } else {
        Ok(())
    }
}

fn validate_safe_json_numbers(value: &Value) -> Result<(), String> {
    match value {
        Value::Number(number) => {
            let valid = number
                .as_u64()
                .map(|value| value <= MAX_SAFE_INTEGER)
                .or_else(|| {
                    number
                        .as_i64()
                        .map(|value| value >= -(MAX_SAFE_INTEGER as i64))
                })
                .unwrap_or(false);
            if !valid {
                return Err("The private operation envelope contains an unsafe number".into());
            }
        }
        Value::Array(values) => {
            for value in values {
                validate_safe_json_numbers(value)?;
            }
        }
        Value::Object(values) => {
            for value in values.values() {
                validate_safe_json_numbers(value)?;
            }
        }
        Value::Null | Value::Bool(_) | Value::String(_) => {}
    }
    Ok(())
}

fn validate_portable_id(value: &str) -> Result<(), String> {
    let mut bytes = value.bytes();
    let Some(first) = bytes.next() else {
        return Err("The operation journal identifier is invalid".into());
    };
    if value.len() < 8
        || value.len() > 128
        || !first.is_ascii_alphanumeric()
        || !bytes
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
    {
        return Err("The operation journal identifier is invalid".into());
    }
    Ok(())
}

fn validate_sha256(value: &str) -> Result<(), String> {
    if valid_journal_session_id(value) {
        Ok(())
    } else {
        Err("The operation journal envelope hash is invalid".into())
    }
}

fn envelope_sha256(serialized: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(ENVELOPE_HASH_DOMAIN);
    hasher.update(serialized.as_bytes());
    hex::encode(hasher.finalize())
}

fn associated_data(record_id: &[u8], revision: u64, delete_by_ms: u64) -> Vec<u8> {
    let mut data = Vec::with_capacity(AEAD_DOMAIN.len() + record_id.len() + 16);
    data.extend_from_slice(AEAD_DOMAIN);
    data.extend_from_slice(record_id);
    data.extend_from_slice(&revision.to_be_bytes());
    data.extend_from_slice(&delete_by_ms.to_be_bytes());
    data
}

fn prepare_private_database_file(directory: &PinnedVaultDirectory) -> Result<(), String> {
    let file = directory
        .open_relative(JOURNAL_FILENAME, true)?
        .ok_or_else(storage_unavailable)?;
    file.sync_all().map_err(|_| storage_unavailable())
}

fn protect_database_files(directory: &PinnedVaultDirectory) -> Result<(), String> {
    if directory.open_relative(JOURNAL_FILENAME, false)?.is_none() {
        return Err(storage_unavailable());
    }
    for sidecar in [JOURNAL_WAL_FILENAME, JOURNAL_SHM_FILENAME] {
        let _ = directory.open_relative(sidecar, false)?;
    }
    Ok(())
}

#[cfg(test)]
fn database_files(path: &Path) -> [PathBuf; 3] {
    let mut wal = path.as_os_str().to_os_string();
    wal.push("-wal");
    let mut shm = path.as_os_str().to_os_string();
    shm.push("-shm");
    [path.to_path_buf(), PathBuf::from(wal), PathBuf::from(shm)]
}

fn storage_unavailable() -> String {
    "The operation journal storage is unavailable".into()
}

fn authentication_failed() -> String {
    "The operation journal record could not be authenticated".into()
}

fn conflict() -> String {
    "The operation journal changed before this write".into()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::LazyLock;
    use std::time::{SystemTime, UNIX_EPOCH};

    static TEST_STARTED_AT_MS: LazyLock<u64> = LazyLock::new(|| {
        native_unix_time_ms().expect("sample test retention start from the native clock")
    });

    fn temp_directory(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock")
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "zine-operation-journal-{label}-{}-{nonce}",
            std::process::id()
        ));
        crate::prepare_vault_runtime_directory(&path).expect("prepare pinned journal directory")
    }

    fn key(seed: u8, vault_id: &str) -> JournalKey {
        JournalKey::derive(&[seed; 32], vault_id).expect("derive test key")
    }

    fn envelope(
        operation_id: &str,
        attempt_id: &str,
        delete_by_ms: u64,
        prompt: &str,
        response: &str,
    ) -> String {
        envelope_with_retention(
            operation_id,
            attempt_id,
            *TEST_STARTED_AT_MS,
            *TEST_STARTED_AT_MS + delete_by_ms,
            prompt,
            response,
        )
    }

    fn envelope_with_retention(
        operation_id: &str,
        attempt_id: &str,
        started_at_ms: u64,
        delete_by_ms: u64,
        prompt: &str,
        response: &str,
    ) -> String {
        serde_json::to_string(&serde_json::json!({
            "attempt": { "attemptId": attempt_id },
            "contract": "desktop-operation-private-local-v1",
            "operationId": operation_id,
            "prepared": { "messages": [{ "content": prompt, "role": "user" }] },
            "response": { "text": response },
            "retention": {
                "classification": "vault-local-private",
                "deadlineBehavior": "delete-entire-private-envelope",
                "deleteAfterTerminal": true,
                "deleteByMs": delete_by_ms,
                "startedAtMs": started_at_ms,
                "version": 1
            },
            "version": 1
        }))
        .expect("serialize fixture")
    }

    #[test]
    fn journal_reopens_and_applies_idempotent_cas_updates() {
        let directory = temp_directory("cas");
        let store = JournalStore::new(&directory, key(0x11, "vault-cas")).expect("open store");
        let initial = envelope("operation-cas", "attempt-cas", 20_000, "prompt one", "");
        assert_eq!(
            store.create(&initial).expect("create"),
            NativeJournalCreateResult::Created
        );
        assert_eq!(
            store.create(&initial).expect("idempotent create"),
            NativeJournalCreateResult::Exists
        );
        assert_eq!(
            store
                .replace(
                    "operation-cas",
                    "attempt-cas",
                    &envelope_sha256(&initial),
                    &initial,
                )
                .expect("idempotent current update"),
            NativeJournalReplaceResult::Replaced
        );

        let changed = envelope(
            "operation-cas",
            "attempt-cas",
            20_000,
            "prompt one",
            "response two",
        );
        assert_eq!(
            store
                .replace(
                    "operation-cas",
                    "attempt-cas",
                    &envelope_sha256(&initial),
                    &changed,
                )
                .expect("CAS update"),
            NativeJournalReplaceResult::Replaced
        );
        assert_eq!(
            store
                .replace(
                    "operation-cas",
                    "attempt-cas",
                    &envelope_sha256(&initial),
                    &changed,
                )
                .expect("idempotent retried update"),
            NativeJournalReplaceResult::Replaced
        );
        let stale = envelope(
            "operation-cas",
            "attempt-cas",
            20_000,
            "different",
            "response two",
        );
        assert_eq!(
            store
                .replace(
                    "operation-cas",
                    "attempt-cas",
                    &envelope_sha256(&initial),
                    &stale,
                )
                .expect("stale replace"),
            NativeJournalReplaceResult::Conflict
        );
        let retimed = envelope(
            "operation-cas",
            "attempt-cas",
            20_001,
            "prompt one",
            "response two",
        );
        assert_eq!(
            store
                .replace(
                    "operation-cas",
                    "attempt-cas",
                    &envelope_sha256(&changed),
                    &retimed,
                )
                .expect("retimed replace"),
            NativeJournalReplaceResult::Conflict
        );

        let reopened = JournalStore::new(&directory, key(0x11, "vault-cas")).expect("reopen store");
        let loaded = reopened
            .load("operation-cas", "attempt-cas")
            .expect("load after reopen")
            .expect("record exists");
        assert_eq!(loaded.revision, 2);
        assert_eq!(loaded.envelope, changed);
        fs::remove_dir_all(directory).expect("remove fixture");
    }

    #[test]
    fn delete_uses_exact_envelope_hash_cas() {
        let directory = temp_directory("delete-cas");
        let store =
            JournalStore::new(&directory, key(0x12, "vault-delete-cas")).expect("open store");
        let current = envelope(
            "operation-delete",
            "attempt-delete",
            20_000,
            "current",
            "response",
        );
        let stale = envelope(
            "operation-delete",
            "attempt-delete",
            20_000,
            "stale",
            "response",
        );
        store.create(&current).expect("create delete candidate");

        assert_eq!(
            store
                .delete(
                    "operation-delete",
                    "attempt-delete",
                    &envelope_sha256(&stale),
                )
                .expect("stale delete"),
            NativeJournalDeleteResult::Conflict
        );
        assert!(store
            .load("operation-delete", "attempt-delete")
            .expect("load after conflict")
            .is_some());
        assert_eq!(
            store
                .delete(
                    "operation-delete",
                    "attempt-delete",
                    &envelope_sha256(&current),
                )
                .expect("current delete"),
            NativeJournalDeleteResult::Deleted
        );
        assert_eq!(
            store
                .delete(
                    "operation-delete",
                    "attempt-delete",
                    &envelope_sha256(&current),
                )
                .expect("missing delete"),
            NativeJournalDeleteResult::Missing
        );
        fs::remove_dir_all(directory).expect("remove fixture");
    }

    #[test]
    fn journal_keys_and_opaque_ids_isolate_vaults() {
        let directory = temp_directory("isolation");
        let store_a = JournalStore::new(&directory, key(0x21, "vault-a")).expect("open vault A");
        let serialized = envelope(
            "operation-shared",
            "attempt-shared",
            20_000,
            "private",
            "result",
        );
        store_a.create(&serialized).expect("create vault A record");

        let store_b = JournalStore::new(&directory, key(0x22, "vault-b")).expect("open vault B");
        assert!(store_b
            .load("operation-shared", "attempt-shared")
            .expect("opaque lookup")
            .is_none());
        assert!(expect_error(store_b.list_page(None, None)).contains("authenticated"));
        fs::remove_dir_all(directory).expect("remove fixture");
    }

    #[test]
    fn ciphertext_and_authenticated_metadata_tampering_fails_closed() {
        let directory = temp_directory("tamper");
        let store = JournalStore::new(&directory, key(0x31, "vault-tamper")).expect("open store");
        let serialized = envelope(
            "operation-tamper",
            "attempt-tamper",
            20_000,
            "secret",
            "result",
        );
        store.create(&serialized).expect("create record");
        let connection =
            Connection::open(directory.join(JOURNAL_FILENAME)).expect("open raw database");
        connection
            .execute(
                "UPDATE desktop_operation_envelopes SET ciphertext = zeroblob(length(ciphertext))",
                [],
            )
            .expect("tamper ciphertext");
        drop(connection);
        assert!(
            expect_error(store.load("operation-tamper", "attempt-tamper"))
                .contains("authenticated")
        );
        fs::remove_dir_all(directory).expect("remove fixture");
    }

    #[test]
    fn tampered_expiry_cannot_delete_an_unauthenticated_record() {
        let directory = temp_directory("expiry-tamper");
        let store =
            JournalStore::new(&directory, key(0x32, "vault-expiry-tamper")).expect("open store");
        let serialized = envelope(
            "operation-expiry-tamper",
            "attempt-expiry-tamper",
            20_000,
            "secret",
            "result",
        );
        store.create(&serialized).expect("create record");
        let connection =
            Connection::open(directory.join(JOURNAL_FILENAME)).expect("open raw database");
        connection
            .execute(
                "UPDATE desktop_operation_envelopes SET delete_by_ms = 1",
                [],
            )
            .expect("tamper expiry");
        drop(connection);
        assert!(store
            .delete_expired_at(1, None)
            .unwrap_err()
            .contains("authenticated"));
        let count: i64 = Connection::open(directory.join(JOURNAL_FILENAME))
            .expect("reopen raw database")
            .query_row(
                "SELECT count(*) FROM desktop_operation_envelopes",
                [],
                |row| row.get(0),
            )
            .expect("count retained records");
        assert_eq!(count, 1, "tampered metadata must not delete the record");
        fs::remove_dir_all(directory).expect("remove fixture");
    }

    #[test]
    fn expiry_deletes_whole_envelopes_only_when_due() {
        let directory = temp_directory("expiry");
        let store = JournalStore::new(&directory, key(0x41, "vault-expiry")).expect("open store");
        store
            .create_at(
                &envelope_with_retention("operation-early", "attempt-early", 0, 1_000, "early", ""),
                0,
            )
            .expect("create early");
        store
            .create_at(
                &envelope_with_retention("operation-late", "attempt-late", 0, 2_000, "late", ""),
                0,
            )
            .expect("create late");
        let before = store.delete_expired_at(999, None).expect("before expiry");
        assert_eq!(before.deleted, 0);
        assert!(!before.has_more);
        let at_expiry = store.delete_expired_at(1_000, None).expect("at expiry");
        assert_eq!(at_expiry.deleted, 1);
        assert!(!at_expiry.has_more);
        assert!(store
            .load_at("operation-early", "attempt-early", 1_000)
            .expect("load early")
            .is_none());
        assert!(store
            .load_at("operation-late", "attempt-late", 1_000)
            .expect("load late")
            .is_some());
        fs::remove_dir_all(directory).expect("remove fixture");
    }

    #[test]
    fn expired_load_deletes_the_row_and_returns_absent() {
        let directory = temp_directory("expired-load");
        let store =
            JournalStore::new(&directory, key(0x42, "vault-expired-load")).expect("open store");
        let expired = envelope_with_retention(
            "operation-expired-load",
            "attempt-expired-load",
            0,
            1_000,
            "prompt",
            "response",
        );
        store.create_at(&expired, 0).expect("create future record");

        assert!(store
            .load_at("operation-expired-load", "attempt-expired-load", 1_000)
            .expect("load at deadline")
            .is_none());
        let count: i64 = Connection::open(directory.join(JOURNAL_FILENAME))
            .expect("open raw database")
            .query_row(
                "SELECT count(*) FROM desktop_operation_envelopes",
                [],
                |row| row.get(0),
            )
            .expect("count rows");
        assert_eq!(count, 0, "expired load must durably remove the whole row");
        fs::remove_dir_all(directory).expect("remove fixture");
    }

    #[test]
    fn expired_list_rows_are_deleted_and_never_returned() {
        let directory = temp_directory("expired-list");
        let store =
            JournalStore::new(&directory, key(0x43, "vault-expired-list")).expect("open store");
        store
            .create_at(
                &envelope_with_retention(
                    "operation-expired-list",
                    "attempt-expired-list",
                    0,
                    1_000,
                    "expired",
                    "response",
                ),
                0,
            )
            .expect("create expiring record");
        let live = envelope(
            "operation-live-list",
            "attempt-live-list",
            20_000,
            "live",
            "response",
        );
        store.create(&live).expect("create live record");

        let page = store
            .list_page_at(None, Some(16), 1_000)
            .expect("list at deadline");
        assert_eq!(page.records.len(), 1);
        assert_eq!(page.records[0].envelope, live);
        let count: i64 = Connection::open(directory.join(JOURNAL_FILENAME))
            .expect("open raw database")
            .query_row(
                "SELECT count(*) FROM desktop_operation_envelopes",
                [],
                |row| row.get(0),
            )
            .expect("count rows");
        assert_eq!(count, 1);
        fs::remove_dir_all(directory).expect("remove fixture");
    }

    #[test]
    fn expired_create_and_replace_writes_are_rejected() {
        let directory = temp_directory("expired-writes");
        let store =
            JournalStore::new(&directory, key(0x44, "vault-expired-writes")).expect("open store");
        let current = envelope_with_retention(
            "operation-expired-write",
            "attempt-expired-write",
            0,
            1_000,
            "current",
            "response",
        );
        assert!(store
            .create_at(&current, 1_000)
            .unwrap_err()
            .contains("deletion deadline"));
        store
            .create_at(&current, 999)
            .expect("create before deadline");
        let replacement = envelope_with_retention(
            "operation-expired-write",
            "attempt-expired-write",
            0,
            1_000,
            "replacement",
            "response",
        );
        assert!(store
            .replace_at(
                "operation-expired-write",
                "attempt-expired-write",
                &envelope_sha256(&current),
                &replacement,
                1_000,
            )
            .unwrap_err()
            .contains("deletion deadline"));
        assert_eq!(
            store
                .load_at("operation-expired-write", "attempt-expired-write", 999)
                .expect("load unchanged record")
                .expect("record remains")
                .envelope,
            current
        );
        fs::remove_dir_all(directory).expect("remove fixture");
    }

    #[test]
    fn native_retention_accepts_exact_contract_maximum_and_rejects_one_more() {
        let directory = temp_directory("retention-limit");
        let store =
            JournalStore::new(&directory, key(0x45, "vault-retention-limit")).expect("open store");
        let started_at_ms = 1_000;
        let exact = envelope_with_retention(
            "operation-retention-max",
            "attempt-retention-max",
            started_at_ms,
            started_at_ms + DESKTOP_OPERATION_MAX_RETENTION_MS,
            "prompt",
            "response",
        );
        assert_eq!(
            store
                .create_at(&exact, started_at_ms)
                .expect("exact maximum"),
            NativeJournalCreateResult::Created
        );
        let over = envelope_with_retention(
            "operation-retention-over",
            "attempt-retention-over",
            started_at_ms,
            started_at_ms + DESKTOP_OPERATION_MAX_RETENTION_MS + 1,
            "prompt",
            "response",
        );
        assert!(store
            .create_at(&over, started_at_ms)
            .unwrap_err()
            .contains("positively bounded"));

        let forged_future_start = envelope_with_retention(
            "operation-retention-future",
            "attempt-retention-future",
            started_at_ms + 1_000_000,
            started_at_ms + 1_000_000 + DESKTOP_OPERATION_MAX_RETENTION_MS,
            "prompt",
            "response",
        );
        assert!(store
            .create_at(&forged_future_start, started_at_ms)
            .unwrap_err()
            .contains("native retention maximum"));
        fs::remove_dir_all(directory).expect("remove fixture");
    }

    #[test]
    fn list_expiry_deletion_rolls_back_if_another_row_fails_authentication() {
        let directory = temp_directory("expiry-transaction");
        let store = JournalStore::new(&directory, key(0x46, "vault-expiry-transaction"))
            .expect("open store");
        store
            .create_at(
                &envelope_with_retention(
                    "operation-expiry-transaction",
                    "attempt-expiry-transaction",
                    0,
                    1_000,
                    "expired",
                    "response",
                ),
                0,
            )
            .expect("create expiring record");
        let tampered = envelope(
            "operation-tamper-transaction",
            "attempt-tamper-transaction",
            20_000,
            "live",
            "response",
        );
        store.create(&tampered).expect("create live record");
        let tampered_id = store
            .record_id("operation-tamper-transaction", "attempt-tamper-transaction")
            .expect("derive tampered record id");
        let connection =
            Connection::open(directory.join(JOURNAL_FILENAME)).expect("open raw database");
        connection
            .execute(
                "UPDATE desktop_operation_envelopes SET ciphertext = zeroblob(length(ciphertext)) \
                 WHERE record_id = ?1",
                params![tampered_id],
            )
            .expect("tamper live record");
        drop(connection);

        assert!(expect_error(store.list_page_at(None, Some(16), 1_000)).contains("authenticated"));
        let count: i64 = Connection::open(directory.join(JOURNAL_FILENAME))
            .expect("open raw database")
            .query_row(
                "SELECT count(*) FROM desktop_operation_envelopes",
                [],
                |row| row.get(0),
            )
            .expect("count rows after rollback");
        assert_eq!(
            count, 2,
            "failed list transaction must not partially delete"
        );
        fs::remove_dir_all(directory).expect("remove fixture");
    }

    #[test]
    fn malformed_and_oversized_envelopes_are_rejected() {
        let directory = temp_directory("limits");
        let store = JournalStore::new(&directory, key(0x51, "vault-limits")).expect("open store");
        assert!(store.create("{").unwrap_err().contains("malformed"));
        let oversized = "x".repeat(MAX_ENVELOPE_BYTES + 1);
        assert!(store.create(&oversized).unwrap_err().contains("too large"));
        fs::remove_dir_all(directory).expect("remove fixture");
    }

    #[test]
    fn oversized_raw_ciphertext_is_rejected_before_record_materialization() {
        let directory = temp_directory("raw-blob-limit");
        let store = JournalStore::new(&directory, key(0x52, "vault-raw-blob")).expect("open store");
        store
            .create(&envelope(
                "operation-raw-blob",
                "attempt-raw-blob",
                20_000,
                "prompt",
                "response",
            ))
            .expect("create record");
        let connection =
            Connection::open(directory.join(JOURNAL_FILENAME)).expect("open raw database");
        connection
            .execute_batch("PRAGMA ignore_check_constraints=ON;")
            .expect("enable raw corruption fixture");
        connection
            .execute(
                "UPDATE desktop_operation_envelopes SET ciphertext = zeroblob(?1)",
                params![(MAX_CIPHERTEXT_BYTES + 1) as i64],
            )
            .expect("inject oversized raw ciphertext");
        drop(connection);

        assert!(
            expect_error(store.load("operation-raw-blob", "attempt-raw-blob"))
                .contains("storage is unavailable")
        );
        fs::remove_dir_all(directory).expect("remove fixture");
    }

    #[test]
    fn list_uses_bounded_opaque_cursor_pages() {
        use std::collections::HashSet;

        let directory = temp_directory("pagination");
        let store =
            JournalStore::new(&directory, key(0x54, "vault-pagination")).expect("open store");
        for suffix in 0..5 {
            store
                .create(&envelope(
                    &format!("operation-page-{suffix}"),
                    &format!("attempt-page-{suffix}"),
                    20_000,
                    "prompt",
                    "response",
                ))
                .expect("create paginated record");
        }

        let mut cursor = None;
        let mut seen = HashSet::new();
        let mut page_sizes = Vec::new();
        loop {
            let page = store
                .list_page(cursor.as_deref(), Some(2))
                .expect("list journal page");
            page_sizes.push(page.records.len());
            for record in page.records {
                let operation_id = validate_envelope(&record.envelope)
                    .expect("validate listed envelope")
                    .operation_id;
                assert!(seen.insert(operation_id), "pages must not repeat records");
            }
            let Some(next) = page.next_cursor else {
                break;
            };
            assert!(valid_journal_session_id(&next), "cursor stays opaque");
            cursor = Some(next);
        }
        assert_eq!(page_sizes, vec![2, 2, 1]);
        assert_eq!(seen.len(), 5);
        assert!(store.list_page(None, Some(0)).is_err());
        assert!(store
            .list_page(None, Some((MAX_PAGE_LIMIT + 1) as u32))
            .is_err());
        fs::remove_dir_all(directory).expect("remove fixture");
    }

    #[test]
    fn expiry_deletion_is_bounded_and_reports_remaining_work() {
        let directory = temp_directory("expiry-batches");
        let store =
            JournalStore::new(&directory, key(0x55, "vault-expiry-batches")).expect("open store");
        for suffix in 0..5 {
            store
                .create_at(
                    &envelope_with_retention(
                        &format!("operation-expiry-{suffix}"),
                        &format!("attempt-expiry-{suffix}"),
                        0,
                        1_000,
                        "prompt",
                        "response",
                    ),
                    0,
                )
                .expect("create expiring record");
        }

        let first = store
            .delete_expired_at(1_000, Some(2))
            .expect("delete first batch");
        let second = store
            .delete_expired_at(1_000, Some(2))
            .expect("delete second batch");
        let third = store
            .delete_expired_at(1_000, Some(2))
            .expect("delete final batch");
        assert_eq!((first.deleted, first.has_more), (2, true));
        assert_eq!((second.deleted, second.has_more), (2, true));
        assert_eq!((third.deleted, third.has_more), (1, false));
        assert!(store
            .list_page_at(None, Some(2), 1_000)
            .expect("list after expiry")
            .records
            .is_empty());
        fs::remove_dir_all(directory).expect("remove fixture");
    }

    #[test]
    fn journal_commands_reject_stale_activation_bindings() {
        let directory = temp_directory("stale-activation");
        let runtime = crate::ActiveVaultRuntime {
            id: "vault-session".into(),
            directory: directory.clone(),
            generation: 7,
            closing: false,
            journal_key: key(0x56, "vault-session"),
            journal_directory: PinnedVaultDirectory::open(&directory)
                .expect("pin journal directory"),
            journal_session_id: "a".repeat(64),
        };
        assert!(require_active_journal_session(&runtime, &"a".repeat(64), 7).is_ok());
        assert!(require_active_journal_session(&runtime, &"a".repeat(64), 6).is_err());
        assert!(require_active_journal_session(&runtime, &"b".repeat(64), 7).is_err());

        let reopened = crate::ActiveVaultRuntime {
            generation: 8,
            journal_session_id: "b".repeat(64),
            ..runtime
        };
        assert!(require_active_journal_session(&reopened, &"a".repeat(64), 7).is_err());
        assert!(require_active_journal_session(&reopened, &"b".repeat(64), 8).is_ok());
        fs::remove_dir_all(directory).expect("remove fixture");
    }

    #[test]
    fn queued_journal_work_samples_time_only_after_acquiring_runtime_gate() {
        use std::sync::atomic::{AtomicU64, Ordering};
        use std::sync::{mpsc, Arc, Barrier};

        let gate = VAULT_RUNTIME_GATE.lock().expect("hold runtime gate");
        let clock = Arc::new(AtomicU64::new(999));
        let started = Arc::new(Barrier::new(2));
        let (sender, receiver) = mpsc::channel();
        let queued_clock = clock.clone();
        let queued_started = started.clone();
        let worker = std::thread::spawn(move || {
            queued_started.wait();
            let sampled = with_runtime_gate(|| Ok(queued_clock.load(Ordering::SeqCst)))
                .expect("sample queued clock");
            sender.send(sampled).expect("send sampled time");
        });
        started.wait();
        assert!(receiver.try_recv().is_err(), "work must still be queued");
        clock.store(1_000, Ordering::SeqCst);
        drop(gate);

        assert_eq!(
            receiver
                .recv_timeout(Duration::from_secs(1))
                .expect("receive post-gate time"),
            1_000
        );
        worker.join().expect("join queued clock worker");
    }

    #[test]
    fn sqlite_uses_wal_full_synchronous_and_busy_timeout() {
        let directory = temp_directory("pragmas");
        let store = JournalStore::new(&directory, key(0x53, "vault-pragmas")).expect("open store");
        let connection = store.open().expect("open configured connection");
        let journal_mode: String = connection
            .query_row("PRAGMA journal_mode", [], |row| row.get(0))
            .expect("journal mode");
        let synchronous: i64 = connection
            .query_row("PRAGMA synchronous", [], |row| row.get(0))
            .expect("synchronous mode");
        let busy_timeout: i64 = connection
            .query_row("PRAGMA busy_timeout", [], |row| row.get(0))
            .expect("busy timeout");
        assert_eq!(journal_mode.to_ascii_lowercase(), "wal");
        assert_eq!(synchronous, 2, "SQLite FULL synchronous is numeric mode 2");
        assert_eq!(busy_timeout, 5_000);
        drop(connection);
        fs::remove_dir_all(directory).expect("remove fixture");
    }

    #[test]
    fn version_one_database_migrates_to_ciphertext_size_constraints() {
        let directory = temp_directory("migration-v1");
        let database = directory.join(JOURNAL_FILENAME);
        let connection = Connection::open(&database).expect("open v1 database");
        connection
            .execute_batch(
                "CREATE TABLE desktop_operation_envelopes (
                   record_id BLOB PRIMARY KEY NOT NULL CHECK(length(record_id) = 32),
                   revision INTEGER NOT NULL CHECK(revision >= 1),
                   delete_by_ms INTEGER NOT NULL CHECK(delete_by_ms >= 0),
                   nonce BLOB NOT NULL CHECK(length(nonce) = 24),
                   ciphertext BLOB NOT NULL
                 ) WITHOUT ROWID;
                 CREATE INDEX desktop_operation_envelopes_expiry
                   ON desktop_operation_envelopes(delete_by_ms);
                 PRAGMA user_version = 1;",
            )
            .expect("create v1 schema");
        drop(connection);

        let store =
            JournalStore::new(&directory, key(0x53, "vault-migration")).expect("migrate store");
        let version: i64 = store
            .open()
            .expect("open migrated database")
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .expect("read migrated version");
        assert_eq!(version, JOURNAL_SCHEMA_VERSION);
        store
            .create(&envelope(
                "operation-migrate",
                "attempt-migrate",
                20_000,
                "prompt",
                "response",
            ))
            .expect("write after migration");
        fs::remove_dir_all(directory).expect("remove fixture");
    }

    #[test]
    fn factory_reset_removes_database_and_sidecars() {
        let directory = temp_directory("reset");
        let store = JournalStore::new(&directory, key(0x52, "vault-reset")).expect("open store");
        store
            .create(&envelope(
                "operation-reset",
                "attempt-reset",
                20_000,
                "prompt",
                "response",
            ))
            .expect("create record");
        remove_database_files(&directory).expect("remove journal files");
        assert!(database_files(&store.path)
            .into_iter()
            .all(|path| !path.exists()));
        fs::remove_dir_all(directory).expect("remove fixture");
    }

    #[cfg(unix)]
    #[test]
    fn pinned_descriptor_survives_directory_rename_and_symlink_swap() {
        use std::os::unix::fs::symlink;

        let directory = temp_directory("descriptor-swap");
        let pinned = PinnedVaultDirectory::open(&directory).expect("pin vault directory");
        let store = JournalStore::new(&pinned, key(0x57, "vault-descriptor-swap"))
            .expect("open pinned store");
        let serialized = envelope(
            "operation-descriptor-swap",
            "attempt-descriptor-swap",
            20_000,
            "prompt",
            "response",
        );
        store.create(&serialized).expect("create pinned record");

        let displaced = directory.with_extension("displaced");
        let sentinel = directory.with_extension("sentinel");
        fs::rename(&directory, &displaced).expect("rename pinned directory");
        fs::create_dir_all(&sentinel).expect("create sentinel directory");
        fs::write(sentinel.join(JOURNAL_FILENAME), b"do not open or delete")
            .expect("write sentinel database");
        symlink(&sentinel, &directory).expect("swap logical path to sentinel symlink");

        assert_eq!(
            store
                .load("operation-descriptor-swap", "attempt-descriptor-swap")
                .expect("load through pinned descriptor")
                .expect("pinned record remains")
                .envelope,
            serialized
        );
        remove_database_files(&pinned).expect("reset pinned descriptor");
        assert_eq!(
            fs::read(sentinel.join(JOURNAL_FILENAME)).expect("read sentinel database"),
            b"do not open or delete"
        );
        assert!(database_files(&displaced.join(JOURNAL_FILENAME))
            .into_iter()
            .all(|path| !path.exists()));

        fs::remove_file(&directory).expect("remove fixture symlink");
        fs::remove_dir_all(displaced).expect("remove displaced fixture");
        fs::remove_dir_all(sentinel).expect("remove sentinel fixture");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn post_open_directory_identity_change_fails_closed() {
        use std::os::unix::fs::symlink;

        let directory = temp_directory("post-open-swap");
        let store =
            JournalStore::new(&directory, key(0x58, "vault-post-open-swap")).expect("open store");
        let displaced = directory.with_extension("displaced");
        let sentinel = directory.with_extension("sentinel");

        let result = store.open_checked(|| {
            fs::rename(&directory, &displaced).map_err(|_| storage_unavailable())?;
            fs::create_dir_all(&sentinel).map_err(|_| storage_unavailable())?;
            fs::write(sentinel.join(JOURNAL_FILENAME), b"do not configure")
                .map_err(|_| storage_unavailable())?;
            symlink(&sentinel, &directory).map_err(|_| storage_unavailable())?;
            Ok(())
        });

        assert_eq!(
            result.expect_err("post-open substitution must fail"),
            storage_unavailable()
        );
        assert_eq!(
            fs::read(sentinel.join(JOURNAL_FILENAME)).expect("read sentinel database"),
            b"do not configure"
        );
        fs::remove_file(&directory).expect("remove fixture symlink");
        fs::remove_dir_all(displaced).expect("remove displaced fixture");
        fs::remove_dir_all(sentinel).expect("remove sentinel fixture");
    }

    #[test]
    fn exact_private_bytes_never_appear_in_sqlite_files() {
        let directory = temp_directory("canary");
        let store = JournalStore::new(&directory, key(0x61, "vault-canary")).expect("open store");
        let prompt = "PROMPT-CANARY-84dbed38-7ee7-4b3d-b633-55ed13a7be58";
        let response = "RESPONSE-CANARY-39c4809a-8496-4e2b-b5dd-f4d2154823dd";
        let connection = store.open().expect("keep WAL connection open");
        store
            .create(&envelope(
                "operation-canary",
                "attempt-canary",
                20_000,
                prompt,
                response,
            ))
            .expect("create canary record");
        let files = existing_database_files(&store.path);
        assert!(
            files
                .iter()
                .any(|path| path.as_os_str().to_string_lossy().ends_with("-wal")),
            "the canary must exercise a real WAL file",
        );
        for path in files {
            let bytes = fs::read(&path).expect("read database file");
            assert!(
                !contains(&bytes, prompt.as_bytes()),
                "prompt leaked into {}",
                path.display()
            );
            assert!(
                !contains(&bytes, response.as_bytes()),
                "response leaked into {}",
                path.display()
            );
        }
        drop(connection);
        fs::remove_dir_all(directory).expect("remove fixture");
    }

    #[cfg(unix)]
    #[test]
    fn sqlite_database_and_sidecars_are_owner_only() {
        use std::os::unix::fs::PermissionsExt;

        let directory = temp_directory("permissions");
        let store =
            JournalStore::new(&directory, key(0x71, "vault-permissions")).expect("open store");
        let connection = store.open().expect("keep sidecars open");
        store
            .create(&envelope(
                "operation-permissions",
                "attempt-permissions",
                20_000,
                "prompt",
                "response",
            ))
            .expect("create record");
        protect_database_files(&store.directory).expect("protect database files");
        for path in existing_database_files(&store.path) {
            let mode = fs::metadata(&path).expect("metadata").permissions().mode();
            assert_eq!(mode & 0o077, 0, "{} must be owner-only", path.display());
        }
        drop(connection);
        fs::remove_dir_all(directory).expect("remove fixture");
    }

    fn existing_database_files(path: &Path) -> Vec<PathBuf> {
        database_files(path)
            .into_iter()
            .filter(|candidate| candidate.exists())
            .collect()
    }

    fn contains(haystack: &[u8], needle: &[u8]) -> bool {
        !needle.is_empty()
            && haystack
                .windows(needle.len())
                .any(|window| window == needle)
    }

    fn expect_error<T>(result: Result<T, String>) -> String {
        match result {
            Ok(_) => panic!("operation was expected to fail"),
            Err(error) => error,
        }
    }
}

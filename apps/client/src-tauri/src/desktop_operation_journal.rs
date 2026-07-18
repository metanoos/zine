use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use rusqlite::config::DbConfig;
use rusqlite::{params, Connection, OpenFlags, OptionalExtension, TransactionBehavior};
use serde::Serialize;
use serde_json::Value;
use sha2::Sha256;
use zeroize::Zeroizing;

use crate::{active_vault_runtime, ensure_private_directory, sync_directory, VAULT_RUNTIME_GATE};

const JOURNAL_FILENAME: &str = "press.sqlite3";
const JOURNAL_SCHEMA_VERSION: i64 = 1;
const MAX_ENVELOPE_BYTES: usize = 2 * 1_024 * 1_024;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const NONCE_BYTES: usize = 24;
const KEY_BYTES: usize = 64;
const ENCRYPTION_KEY_BYTES: usize = 32;
const KDF_SALT: &[u8] = b"zine.desktop-operation-journal.hkdf.v1";
const KDF_INFO_PREFIX: &[u8] = b"zine.desktop-operation-journal.key.v1\0";
const RECORD_ID_DOMAIN: &[u8] = b"zine.desktop-operation-journal.record-id.v1\0";
const AEAD_DOMAIN: &[u8] = b"zine.desktop-operation-journal.envelope.v1\0";

type HmacSha256 = Hmac<Sha256>;

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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeJournalWriteReceipt {
    revision: u64,
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
    path: PathBuf,
    key: JournalKey,
}

impl JournalStore {
    fn new(directory: &Path, key: JournalKey) -> Result<Self, String> {
        ensure_private_directory(directory).map_err(|_| storage_unavailable())?;
        // SQLite's NOFOLLOW flag rejects symlinks in every path component.
        // Canonicalizing the already-authorized private vault directory keeps
        // the final database entry protected without rejecting macOS `/var`.
        let canonical_directory = fs::canonicalize(directory).map_err(|_| storage_unavailable())?;
        let path = canonical_directory.join(JOURNAL_FILENAME);
        prepare_private_database_file(&path)?;
        let store = Self { path, key };
        let connection = store.open()?;
        drop(connection);
        sync_directory(&canonical_directory).map_err(|_| storage_unavailable())?;
        protect_database_files(&store.path)?;
        Ok(store)
    }

    fn open(&self) -> Result<Connection, String> {
        let connection = Connection::open_with_flags(
            &self.path,
            OpenFlags::SQLITE_OPEN_READ_WRITE
                | OpenFlags::SQLITE_OPEN_CREATE
                | OpenFlags::SQLITE_OPEN_FULL_MUTEX
                | OpenFlags::SQLITE_OPEN_NOFOLLOW,
        )
        .map_err(|_| storage_unavailable())?;
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
        protect_database_files(&self.path)?;
        Ok(connection)
    }

    fn create(&self, envelope: &str) -> Result<u64, String> {
        let metadata = validate_envelope(envelope)?;
        let record_id = self.record_id(&metadata.operation_id, &metadata.attempt_id)?;
        let mut connection = self.open()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| storage_unavailable())?;
        if let Some(existing) = load_stored(&transaction, &record_id)? {
            let plaintext = self.decrypt(&existing)?;
            if plaintext.as_slice() == envelope.as_bytes()
                && existing.delete_by_ms == metadata.delete_by_ms
            {
                transaction.commit().map_err(|_| storage_unavailable())?;
                protect_database_files(&self.path)?;
                return Ok(existing.revision);
            }
            return Err(conflict());
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
        protect_database_files(&self.path)?;
        Ok(revision)
    }

    fn update(&self, expected_revision: u64, envelope: &str) -> Result<u64, String> {
        if expected_revision == 0 || expected_revision > MAX_SAFE_INTEGER {
            return Err(conflict());
        }
        let metadata = validate_envelope(envelope)?;
        let record_id = self.record_id(&metadata.operation_id, &metadata.attempt_id)?;
        let mut connection = self.open()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| storage_unavailable())?;
        let existing = load_stored(&transaction, &record_id)?.ok_or_else(conflict)?;
        if existing.delete_by_ms != metadata.delete_by_ms {
            // Retention is fixed at attempt creation. A lifecycle update may
            // never postpone or accelerate whole-envelope deletion.
            return Err(conflict());
        }
        let plaintext = self.decrypt(&existing)?;
        let exact_desired = plaintext.as_slice() == envelope.as_bytes();
        if exact_desired
            && (existing.revision == expected_revision
                || existing.revision == expected_revision.saturating_add(1))
        {
            transaction.commit().map_err(|_| storage_unavailable())?;
            protect_database_files(&self.path)?;
            return Ok(existing.revision);
        }
        if existing.revision != expected_revision {
            return Err(conflict());
        }
        let next_revision = expected_revision.checked_add(1).ok_or_else(conflict)?;
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
                    expected_revision as i64,
                ],
            )
            .map_err(|_| storage_unavailable())?;
        if changed != 1 {
            return Err(conflict());
        }
        transaction.commit().map_err(|_| storage_unavailable())?;
        protect_database_files(&self.path)?;
        Ok(next_revision)
    }

    fn load(
        &self,
        operation_id: &str,
        attempt_id: &str,
    ) -> Result<Option<NativeJournalRecord>, String> {
        validate_portable_id(operation_id)?;
        validate_portable_id(attempt_id)?;
        let record_id = self.record_id(operation_id, attempt_id)?;
        let connection = self.open()?;
        let Some(stored) = load_stored(&connection, &record_id)? else {
            return Ok(None);
        };
        let envelope = self.decrypt_and_validate(&stored)?;
        Ok(Some(NativeJournalRecord {
            revision: stored.revision,
            envelope,
        }))
    }

    fn list(&self) -> Result<Vec<NativeJournalRecord>, String> {
        let connection = self.open()?;
        let mut statement = connection
            .prepare(
                "SELECT record_id, revision, delete_by_ms, nonce, ciphertext \
                 FROM desktop_operation_envelopes ORDER BY delete_by_ms, record_id",
            )
            .map_err(|_| storage_unavailable())?;
        let rows = statement
            .query_map([], stored_from_row)
            .map_err(|_| storage_unavailable())?;
        let mut records = Vec::new();
        for row in rows {
            let stored = row.map_err(|_| storage_unavailable())?;
            let envelope = self.decrypt_and_validate(&stored)?;
            records.push(NativeJournalRecord {
                revision: stored.revision,
                envelope,
            });
        }
        Ok(records)
    }

    fn delete(
        &self,
        operation_id: &str,
        attempt_id: &str,
        expected_revision: u64,
    ) -> Result<bool, String> {
        validate_portable_id(operation_id)?;
        validate_portable_id(attempt_id)?;
        if expected_revision == 0 || expected_revision > MAX_SAFE_INTEGER {
            return Err(conflict());
        }
        let record_id = self.record_id(operation_id, attempt_id)?;
        let mut connection = self.open()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| storage_unavailable())?;
        let Some(current) = load_stored(&transaction, &record_id)? else {
            transaction.commit().map_err(|_| storage_unavailable())?;
            return Ok(false);
        };
        if current.revision != expected_revision {
            return Err(conflict());
        }
        self.decrypt_and_validate(&current)?;
        let changed = transaction
            .execute(
                "DELETE FROM desktop_operation_envelopes WHERE record_id = ?1 AND revision = ?2",
                params![&record_id, expected_revision as i64],
            )
            .map_err(|_| storage_unavailable())?;
        if changed != 1 {
            return Err(conflict());
        }
        transaction.commit().map_err(|_| storage_unavailable())?;
        protect_database_files(&self.path)?;
        Ok(true)
    }

    fn delete_expired(&self, now_ms: u64) -> Result<u64, String> {
        if now_ms > MAX_SAFE_INTEGER {
            return Err("The operation journal expiry is invalid".into());
        }
        let mut connection = self.open()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| storage_unavailable())?;
        let due = {
            let mut statement = transaction
                .prepare(
                    "SELECT record_id, revision, delete_by_ms, nonce, ciphertext \
                     FROM desktop_operation_envelopes WHERE delete_by_ms <= ?1 \
                     ORDER BY delete_by_ms, record_id",
                )
                .map_err(|_| storage_unavailable())?;
            let rows = statement
                .query_map(params![now_ms as i64], stored_from_row)
                .map_err(|_| storage_unavailable())?;
            let mut due = Vec::new();
            for row in rows {
                due.push(row.map_err(|_| storage_unavailable())?);
            }
            due
        };
        for stored in &due {
            // The deadline is plaintext only so SQLite can select candidates.
            // Authenticate its AEAD binding before allowing it to delete data.
            self.decrypt_and_validate(stored)?;
            let changed = transaction
                .execute(
                    "DELETE FROM desktop_operation_envelopes WHERE record_id = ?1 AND revision = ?2",
                    params![&stored.record_id, stored.revision as i64],
                )
                .map_err(|_| storage_unavailable())?;
            if changed != 1 {
                return Err(conflict());
            }
        }
        transaction.commit().map_err(|_| storage_unavailable())?;
        protect_database_files(&self.path)?;
        u64::try_from(due.len()).map_err(|_| storage_unavailable())
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

#[tauri::command]
pub(crate) fn desktop_operation_journal_create(
    envelope: String,
) -> Result<NativeJournalWriteReceipt, String> {
    with_active_store(|store| {
        store
            .create(&envelope)
            .map(|revision| NativeJournalWriteReceipt { revision })
    })
}

#[tauri::command]
pub(crate) fn desktop_operation_journal_update(
    expected_revision: u64,
    envelope: String,
) -> Result<NativeJournalWriteReceipt, String> {
    with_active_store(|store| {
        store
            .update(expected_revision, &envelope)
            .map(|revision| NativeJournalWriteReceipt { revision })
    })
}

#[tauri::command]
pub(crate) fn desktop_operation_journal_load(
    operation_id: String,
    attempt_id: String,
) -> Result<Option<NativeJournalRecord>, String> {
    with_active_store(|store| store.load(&operation_id, &attempt_id))
}

#[tauri::command]
pub(crate) fn desktop_operation_journal_list() -> Result<Vec<NativeJournalRecord>, String> {
    with_active_store(|store| store.list())
}

#[tauri::command]
pub(crate) fn desktop_operation_journal_delete(
    operation_id: String,
    attempt_id: String,
    expected_revision: u64,
) -> Result<bool, String> {
    with_active_store(|store| store.delete(&operation_id, &attempt_id, expected_revision))
}

#[tauri::command]
pub(crate) fn desktop_operation_journal_delete_expired(now_ms: u64) -> Result<u64, String> {
    with_active_store(|store| store.delete_expired(now_ms))
}

pub(crate) fn remove_database_files(directory: &Path) -> Result<(), String> {
    let database = directory.join(JOURNAL_FILENAME);
    // Remove transient sidecars before the main file so a crash cannot leave
    // an old WAL beside a newly-created database on the next activation.
    for path in database_files(&database).into_iter().rev() {
        match fs::remove_file(&path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(storage_unavailable()),
        }
    }
    sync_directory(directory).map_err(|_| storage_unavailable())
}

fn with_active_store<T>(
    operation: impl FnOnce(&JournalStore) -> Result<T, String>,
) -> Result<T, String> {
    let _gate = VAULT_RUNTIME_GATE
        .lock()
        .map_err(|_| "The operation journal is unavailable".to_string())?;
    let runtime = active_vault_runtime()?;
    let store = JournalStore::new(&runtime.directory, runtime.journal_key)?;
    operation(&store)
}

fn migrate(connection: &Connection) -> Result<(), String> {
    let version: i64 = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|_| storage_unavailable())?;
    match version {
        0 => connection
            .execute_batch(
                "BEGIN IMMEDIATE;
                 CREATE TABLE desktop_operation_envelopes (
                   record_id BLOB PRIMARY KEY NOT NULL CHECK(length(record_id) = 32),
                   revision INTEGER NOT NULL CHECK(revision >= 1),
                   delete_by_ms INTEGER NOT NULL CHECK(delete_by_ms >= 0),
                   nonce BLOB NOT NULL CHECK(length(nonce) = 24),
                   ciphertext BLOB NOT NULL
                 ) WITHOUT ROWID;
                 CREATE INDEX desktop_operation_envelopes_expiry
                   ON desktop_operation_envelopes(delete_by_ms);
                 PRAGMA user_version = 1;
                 COMMIT;",
            )
            .map_err(|_| storage_unavailable()),
        JOURNAL_SCHEMA_VERSION => Ok(()),
        _ => Err("The operation journal schema is unsupported".into()),
    }
}

fn load_stored(connection: &Connection, record_id: &[u8]) -> Result<Option<StoredRecord>, String> {
    connection
        .query_row(
            "SELECT record_id, revision, delete_by_ms, nonce, ciphertext \
             FROM desktop_operation_envelopes WHERE record_id = ?1",
            params![record_id],
            stored_from_row,
        )
        .optional()
        .map_err(|_| storage_unavailable())
}

fn stored_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<StoredRecord> {
    let revision: i64 = row.get(1)?;
    let delete_by_ms: i64 = row.get(2)?;
    if revision <= 0
        || revision as u64 > MAX_SAFE_INTEGER
        || delete_by_ms < 0
        || delete_by_ms as u64 > MAX_SAFE_INTEGER
    {
        return Err(rusqlite::Error::InvalidQuery);
    }
    Ok(StoredRecord {
        record_id: row.get(0)?,
        revision: revision as u64,
        delete_by_ms: delete_by_ms as u64,
        nonce: row.get(3)?,
        ciphertext: row.get(4)?,
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
    {
        return Err("The private operation retention policy is unsupported".into());
    }
    let delete_by_ms = retention
        .get("deleteByMs")
        .and_then(Value::as_u64)
        .filter(|value| *value <= MAX_SAFE_INTEGER)
        .ok_or_else(|| "The private operation retention deadline is invalid".to_string())?;
    Ok(EnvelopeMetadata {
        operation_id: operation_id.to_owned(),
        attempt_id: attempt_id.to_owned(),
        delete_by_ms,
    })
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

fn associated_data(record_id: &[u8], revision: u64, delete_by_ms: u64) -> Vec<u8> {
    let mut data = Vec::with_capacity(AEAD_DOMAIN.len() + record_id.len() + 16);
    data.extend_from_slice(AEAD_DOMAIN);
    data.extend_from_slice(record_id);
    data.extend_from_slice(&revision.to_be_bytes());
    data.extend_from_slice(&delete_by_ms.to_be_bytes());
    data
}

fn prepare_private_database_file(path: &Path) -> Result<(), String> {
    if !path.exists() {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        match options.open(path) {
            Ok(file) => file.sync_all().map_err(|_| storage_unavailable())?,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(_) => return Err(storage_unavailable()),
        }
    }
    let metadata = fs::symlink_metadata(path).map_err(|_| storage_unavailable())?;
    if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
        return Err(storage_unavailable());
    }
    protect_private_file(path)
}

fn protect_database_files(path: &Path) -> Result<(), String> {
    protect_private_file(path)?;
    for sidecar in database_files(path).into_iter().skip(1) {
        if sidecar.exists() {
            protect_private_file(&sidecar)?;
        }
    }
    Ok(())
}

fn database_files(path: &Path) -> [PathBuf; 3] {
    let mut wal = path.as_os_str().to_os_string();
    wal.push("-wal");
    let mut shm = path.as_os_str().to_os_string();
    shm.push("-shm");
    [path.to_path_buf(), PathBuf::from(wal), PathBuf::from(shm)]
}

fn protect_private_file(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))
            .map_err(|_| storage_unavailable())?;
    }
    Ok(())
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
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_directory(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "zine-operation-journal-{label}-{}-{nonce}",
            std::process::id()
        ))
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
        serde_json::to_string(&serde_json::json!({
            "attempt": { "attemptId": attempt_id },
            "contract": "desktop-operation-private-local-v1",
            "operationId": operation_id,
            "prepared": { "messages": [{ "content": prompt, "role": "user" }] },
            "response": { "text": response },
            "retention": {
                "classification": "vault-local-private",
                "deadlineBehavior": "delete-entire-private-envelope",
                "deleteByMs": delete_by_ms,
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
        assert_eq!(store.create(&initial).expect("create"), 1);
        assert_eq!(store.create(&initial).expect("idempotent create"), 1);
        assert_eq!(
            store
                .update(1, &initial)
                .expect("idempotent current update"),
            1
        );

        let changed = envelope(
            "operation-cas",
            "attempt-cas",
            20_000,
            "prompt one",
            "response two",
        );
        assert_eq!(store.update(1, &changed).expect("CAS update"), 2);
        assert_eq!(
            store
                .update(1, &changed)
                .expect("idempotent retried update"),
            2
        );
        let stale = envelope(
            "operation-cas",
            "attempt-cas",
            20_000,
            "different",
            "response two",
        );
        assert!(store.update(1, &stale).unwrap_err().contains("changed"));
        let retimed = envelope(
            "operation-cas",
            "attempt-cas",
            20_001,
            "prompt one",
            "response two",
        );
        assert!(store.update(2, &retimed).unwrap_err().contains("changed"));

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
        assert!(expect_error(store_b.list()).contains("authenticated"));
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
            .delete_expired(1)
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
            .create(&envelope(
                "operation-early",
                "attempt-early",
                1_000,
                "early",
                "",
            ))
            .expect("create early");
        store
            .create(&envelope(
                "operation-late",
                "attempt-late",
                2_000,
                "late",
                "",
            ))
            .expect("create late");
        assert_eq!(store.delete_expired(999).expect("before expiry"), 0);
        assert_eq!(store.delete_expired(1_000).expect("at expiry"), 1);
        assert!(store
            .load("operation-early", "attempt-early")
            .expect("load early")
            .is_none());
        assert!(store
            .load("operation-late", "attempt-late")
            .expect("load late")
            .is_some());
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
        protect_database_files(&store.path).expect("protect database files");
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

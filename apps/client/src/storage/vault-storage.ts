import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { bytesToHex, hexToBytes, randomBytes } from "@noble/ciphers/utils.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";

/** Authenticated encrypted facade over browser localStorage.
 *
 * Desktop vault state uses one encrypted key index plus an opaque encrypted
 * record per logical localStorage key. The random 256-bit content key lives in
 * the active Stronghold snapshot. Per-record ciphertext avoids rewriting the
 * complete Root on every editor crash-pad update, while the keyed physical
 * names keep logical record names hidden before unlock. Browser reader builds
 * do not activate a vault and retain ordinary localStorage.
 */

const VAULT_STATE_PREFIX = "zine.vault-state.";
const VAULT_RECORD_PREFIX = "zine.vault-record.";
const VAULT_STATE_VERSION = 2;
const LEGACY_STATE_VERSION = 1;
const GLOBAL_KEYS = new Set([
  "zine-theme",
  "zine.navRailExpanded",
  "zine.press.sidebarWidth",
  "zine.voiceAttribution",
]);

let activeVaultId: string | null = null;
let activeVaultKey: Uint8Array | null = null;
let activeVaultMigratesLegacy = false;
let activeValues = new Map<string, string>();
let vaultBoundaryInstalled = false;
let storageSessionAcceptsWork = true;
let storageGeneration = 0;
const storageListeners = new Set<() => void>();

interface EncryptedVaultEnvelope {
  version: 2;
  nonce: string;
  ciphertext: string;
}

interface VaultIndexPayload {
  version: 2;
  keys: string[];
}

interface VaultRecordPayload {
  version: 2;
  key: string;
  value: string;
}

interface LegacyEncryptedVaultState {
  version: 1;
  nonce: string;
  ciphertext: string;
}

interface LegacyVaultStatePayload {
  version: 1;
  values: Record<string, string>;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function rawStorage(): Storage {
  const storage = (globalThis as { localStorage?: Storage }).localStorage;
  if (!storage) throw new Error("Browser storage is unavailable");
  return storage;
}

function validVaultId(id: string): boolean {
  return /^[a-zA-Z0-9-]{1,96}$/.test(id);
}

function vaultIndexKey(id: string): string {
  return `${VAULT_STATE_PREFIX}${id}`;
}

function vaultRecordPrefix(id: string): string {
  return `${VAULT_RECORD_PREFIX}${id}.`;
}

function isPhysicalVaultKey(key: string): boolean {
  return key.startsWith(VAULT_STATE_PREFIX) || key.startsWith(VAULT_RECORD_PREFIX);
}

function indexAssociatedData(id: string): Uint8Array {
  return encoder.encode(`zine-vault-index-v2:${id}`);
}

function legacyAssociatedData(id: string): Uint8Array {
  return encoder.encode(`zine-vault-state-v1:${id}`);
}

function recordId(id: string, key: Uint8Array, logicalKey: string): string {
  return bytesToHex(hmac(
    sha256,
    key,
    encoder.encode(`zine-vault-record-v2:${id}\0${logicalKey}`),
  ));
}

function recordStorageKey(id: string, key: Uint8Array, logicalKey: string): string {
  return `${vaultRecordPrefix(id)}${recordId(id, key, logicalKey)}`;
}

function recordAssociatedData(id: string, opaqueId: string): Uint8Array {
  return encoder.encode(`zine-vault-record-v2:${id}:${opaqueId}`);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize);
    for (const byte of chunk) binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function base64ToBytes(encoded: string): Uint8Array {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function encryptPayload(
  key: Uint8Array,
  associatedData: Uint8Array,
  payload: VaultIndexPayload | VaultRecordPayload,
): string {
  const nonce = randomBytes(24);
  const plaintext = encoder.encode(JSON.stringify(payload));
  try {
    const ciphertext = xchacha20poly1305(key, nonce, associatedData).encrypt(plaintext);
    return JSON.stringify({
      version: VAULT_STATE_VERSION,
      nonce: bytesToBase64(nonce),
      ciphertext: bytesToBase64(ciphertext),
    } satisfies EncryptedVaultEnvelope);
  } finally {
    plaintext.fill(0);
  }
}

function decryptPayload(
  key: Uint8Array,
  associatedData: Uint8Array,
  raw: string,
): unknown {
  const envelope = JSON.parse(raw) as Partial<EncryptedVaultEnvelope>;
  if (
    envelope.version !== VAULT_STATE_VERSION ||
    typeof envelope.nonce !== "string" ||
    typeof envelope.ciphertext !== "string"
  ) {
    throw new Error("unsupported encrypted state format");
  }
  const plaintext = xchacha20poly1305(
    key,
    base64ToBytes(envelope.nonce),
    associatedData,
  ).decrypt(base64ToBytes(envelope.ciphertext));
  try {
    return JSON.parse(decoder.decode(plaintext)) as unknown;
  } finally {
    plaintext.fill(0);
  }
}

function decryptLegacyState(id: string, key: Uint8Array, raw: string): Map<string, string> {
  const envelope = JSON.parse(raw) as Partial<LegacyEncryptedVaultState>;
  if (
    envelope.version !== LEGACY_STATE_VERSION ||
    typeof envelope.nonce !== "string" ||
    typeof envelope.ciphertext !== "string"
  ) {
    throw new Error("unsupported encrypted state format");
  }
  const plaintext = xchacha20poly1305(
    key,
    hexToBytes(envelope.nonce),
    legacyAssociatedData(id),
  ).decrypt(hexToBytes(envelope.ciphertext));
  let payload: Partial<LegacyVaultStatePayload>;
  try {
    payload = JSON.parse(decoder.decode(plaintext)) as Partial<LegacyVaultStatePayload>;
  } finally {
    plaintext.fill(0);
  }
  if (
    payload.version !== LEGACY_STATE_VERSION ||
    !payload.values ||
    typeof payload.values !== "object" ||
    Array.isArray(payload.values)
  ) {
    throw new Error("invalid legacy encrypted state payload");
  }
  const values = new Map<string, string>();
  for (const [logicalKey, value] of Object.entries(payload.values)) {
    if (typeof value !== "string") throw new Error("invalid encrypted state value");
    values.set(logicalKey, value);
  }
  return values;
}

function loadEncryptedState(id: string, key: Uint8Array, raw: string): Map<string, string> {
  try {
    const version = (JSON.parse(raw) as { version?: unknown }).version;
    if (version === LEGACY_STATE_VERSION) return decryptLegacyState(id, key, raw);
    const index = decryptPayload(key, indexAssociatedData(id), raw) as Partial<VaultIndexPayload>;
    if (
      index.version !== VAULT_STATE_VERSION ||
      !Array.isArray(index.keys) ||
      index.keys.some((entry) => typeof entry !== "string") ||
      new Set(index.keys).size !== index.keys.length
    ) {
      throw new Error("invalid encrypted vault index");
    }

    const storage = rawStorage();
    const values = new Map<string, string>();
    for (const logicalKey of index.keys) {
      if (GLOBAL_KEYS.has(logicalKey) || isPhysicalVaultKey(logicalKey)) {
        throw new Error("invalid logical key in encrypted vault index");
      }
      const opaqueId = recordId(id, key, logicalKey);
      const encryptedRecord = storage.getItem(`${vaultRecordPrefix(id)}${opaqueId}`);
      if (!encryptedRecord) throw new Error("encrypted vault record is missing");
      const record = decryptPayload(
        key,
        recordAssociatedData(id, opaqueId),
        encryptedRecord,
      ) as Partial<VaultRecordPayload>;
      if (
        record.version !== VAULT_STATE_VERSION ||
        record.key !== logicalKey ||
        typeof record.value !== "string"
      ) {
        throw new Error("invalid encrypted vault record");
      }
      values.set(logicalKey, record.value);
    }
    return values;
  } catch (error) {
    throw new Error(
      `The encrypted workspace state for this vault cannot be opened: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function persistRecord(id: string, key: Uint8Array, logicalKey: string, value: string): string {
  const opaqueId = recordId(id, key, logicalKey);
  rawStorage().setItem(
    `${vaultRecordPrefix(id)}${opaqueId}`,
    encryptPayload(key, recordAssociatedData(id, opaqueId), {
      version: VAULT_STATE_VERSION,
      key: logicalKey,
      value,
    }),
  );
  return opaqueId;
}

function persistIndex(id: string, key: Uint8Array, values: ReadonlyMap<string, string>): void {
  rawStorage().setItem(
    vaultIndexKey(id),
    encryptPayload(key, indexAssociatedData(id), {
      version: VAULT_STATE_VERSION,
      keys: [...values.keys()],
    }),
  );
}

/** Install a complete state record-first, then atomically publish its index.
 * A crash can leave an unreadable orphan record, never an index that points to
 * a missing value. Orphans are removed only after the new index is durable. */
function persistCompleteState(
  id: string,
  key: Uint8Array,
  values: ReadonlyMap<string, string>,
): void {
  const expectedRecords = new Set<string>();
  for (const [logicalKey, value] of values) {
    expectedRecords.add(`${vaultRecordPrefix(id)}${persistRecord(id, key, logicalKey, value)}`);
  }
  persistIndex(id, key, values);

  const storage = rawStorage();
  const prefix = vaultRecordPrefix(id);
  const orphans: string[] = [];
  for (let index = 0; index < storage.length; index++) {
    const physicalKey = storage.key(index);
    if (physicalKey?.startsWith(prefix) && !expectedRecords.has(physicalKey)) {
      orphans.push(physicalKey);
    }
  }
  for (const orphan of orphans) storage.removeItem(orphan);
}

/** Activate and decrypt one vault before profile modules read from storage. */
export function activateVaultStorage(
  id: string,
  key: Uint8Array,
  migrateLegacy = false,
): void {
  if (!validVaultId(id)) throw new Error("The selected vault id is invalid");
  if (key.length !== 32) throw new Error("The vault workspace key is invalid");
  vaultBoundaryInstalled = true;
  clearActiveVaultStorage();

  let installedKey: Uint8Array | null = null;
  try {
    const storage = rawStorage();
    const indexKey = vaultIndexKey(id);
    const encrypted = storage.getItem(indexKey);
    const values = encrypted ? loadEncryptedState(id, key, encrypted) : new Map<string, string>();
    const oldPlaintextPrefix = `${indexKey}.`;
    const migratedSources: string[] = [];
    for (let index = 0; index < storage.length; index++) {
      const sourceKey = storage.key(index);
      if (!sourceKey) continue;
      if (sourceKey.startsWith(oldPlaintextPrefix)) {
        const logicalKey = sourceKey.slice(oldPlaintextPrefix.length);
        if (!values.has(logicalKey)) {
          const value = storage.getItem(sourceKey);
          if (value !== null) values.set(logicalKey, value);
        }
        migratedSources.push(sourceKey);
        continue;
      }
      if (
        migrateLegacy &&
        sourceKey.startsWith("zine.") &&
        !GLOBAL_KEYS.has(sourceKey) &&
        !isPhysicalVaultKey(sourceKey)
      ) {
        if (!values.has(sourceKey)) {
          const value = storage.getItem(sourceKey);
          if (value !== null) values.set(sourceKey, value);
        }
        migratedSources.push(sourceKey);
      }
    }

    installedKey = new Uint8Array(key);
    persistCompleteState(id, installedKey, values);
    for (const sourceKey of migratedSources) storage.removeItem(sourceKey);
    activeVaultId = id;
    activeVaultKey = installedKey;
    activeVaultMigratesLegacy = migrateLegacy;
    activeValues = values;
    storageSessionAcceptsWork = true;
    installedKey = null;
    publishStorageGeneration();
  } catch (error) {
    installedKey?.fill(0);
    publishStorageGeneration();
    throw error;
  }
}

function clearActiveVaultStorage(): void {
  activeVaultKey?.fill(0);
  activeVaultId = null;
  activeVaultKey = null;
  activeVaultMigratesLegacy = false;
  storageSessionAcceptsWork = false;
  activeValues.clear();
  activeValues = new Map();
}

function publishStorageGeneration(): void {
  storageGeneration += 1;
  for (const listener of storageListeners) {
    try {
      listener();
    } catch (error) {
      console.error("vault storage subscriber failed", error);
    }
  }
}

/** Zero the in-memory content key and release decrypted state before selection. */
export function deactivateVaultStorage(): void {
  clearActiveVaultStorage();
  publishStorageGeneration();
}

export function activeVaultStorageId(): string | null {
  return activeVaultId;
}

/** True only for the active vault explicitly authorized to adopt legacy
 * install-global state during this activation transaction. */
export function activeVaultStorageMigratesLegacy(): boolean {
  return activeVaultMigratesLegacy;
}

/** Monotonic lease for session-global async clients. Every activation,
 * deactivation, and failed replacement invalidates work captured earlier. */
export function vaultStorageGeneration(): number {
  return storageGeneration;
}

/** The browser profile starts open. Desktop activation reopens this authority
 * only after decryption succeeds; fencing and deactivation close it. */
export function vaultStorageSessionAcceptsWork(): boolean {
  return storageSessionAcceptsWork;
}

/** Invalidate captured async work before native reachability is locked while
 * keeping the active vault readable for orderly shutdown. */
export function fenceVaultStorageSession(): void {
  storageSessionAcceptsWork = false;
  publishStorageGeneration();
}

/** Notify external stores when the active vault boundary changes. */
export function subscribeVaultStorage(listener: () => void): () => void {
  storageListeners.add(listener);
  return () => storageListeners.delete(listener);
}

function visibleKeys(): string[] {
  const storage = rawStorage();
  if (!activeVaultId) {
    if (vaultBoundaryInstalled) {
      return Array.from({ length: storage.length }, (_, index) => storage.key(index))
        .filter((key): key is string => key !== null && GLOBAL_KEYS.has(key));
    }
    return Array.from({ length: storage.length }, (_, index) => storage.key(index))
      .filter((key): key is string => key !== null);
  }
  const keys = [...activeValues.keys()];
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (key && GLOBAL_KEYS.has(key)) keys.push(key);
  }
  return keys;
}

/** Storage-compatible object so existing stores can keep their narrow API. */
export const vaultStorage: Storage = {
  get length(): number {
    return visibleKeys().length;
  },
  clear(): void {
    // The only production caller is the explicitly destructive factory reset,
    // whose contract is to remove every vault and global preference.
    rawStorage().clear();
    activeValues.clear();
  },
  getItem(key: string): string | null {
    if (GLOBAL_KEYS.has(key) || isPhysicalVaultKey(key)) {
      return rawStorage().getItem(key);
    }
    if (!activeVaultId) {
      return vaultBoundaryInstalled ? null : rawStorage().getItem(key);
    }
    return activeValues.get(key) ?? null;
  },
  key(index: number): string | null {
    return visibleKeys()[index] ?? null;
  },
  removeItem(key: string): void {
    if (GLOBAL_KEYS.has(key) || isPhysicalVaultKey(key)) {
      rawStorage().removeItem(key);
      return;
    }
    if (!activeVaultId) {
      if (vaultBoundaryInstalled) throw new Error("The vault workspace is locked");
      rawStorage().removeItem(key);
      return;
    }
    if (!activeVaultKey || !activeValues.has(key)) return;
    const next = new Map(activeValues);
    next.delete(key);
    // Publish the smaller index first. A crash before removing the ciphertext
    // leaves a harmless opaque orphan that activation cleans up.
    persistIndex(activeVaultId, activeVaultKey, next);
    rawStorage().removeItem(recordStorageKey(activeVaultId, activeVaultKey, key));
    activeValues = next;
  },
  setItem(key: string, value: string): void {
    if (GLOBAL_KEYS.has(key) || isPhysicalVaultKey(key)) {
      rawStorage().setItem(key, value);
      return;
    }
    if (!activeVaultId) {
      if (vaultBoundaryInstalled) throw new Error("The vault workspace is locked");
      rawStorage().setItem(key, value);
      return;
    }
    if (!activeVaultKey) throw new Error("The vault workspace is locked");
    const normalized = String(value);
    const existed = activeValues.has(key);
    persistRecord(activeVaultId, activeVaultKey, key, normalized);
    const next = new Map(activeValues);
    next.set(key, normalized);
    if (!existed) persistIndex(activeVaultId, activeVaultKey, next);
    activeValues = next;
  },
};

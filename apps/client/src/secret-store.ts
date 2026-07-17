/**
 * Persistent secret values live behind this boundary; serializable profiles
 * retain only opaque references.
 *
 *   unlock store -> preload session cache -> resolve briefly at use site
 *        |                    |                         |
 *        +-- migration ------+                         +-- sign / transport
 *             write -> read-back verify -> profile swap -> legacy delete
 *
 * The synchronous cache exists because the provenance/editor stack signs in
 * event handlers that are already synchronous at their resolution boundary.
 * Store I/O remains asynchronous and every bootstrap/migration write is
 * awaited before the app is allowed to author.
 */

export interface SecretStoreCapabilities {
  persistent: boolean;
  signing: boolean;
  model: boolean;
}

export interface SecretStore {
  get(ref: string): Promise<Uint8Array | null>;
  set(ref: string, value: Uint8Array): Promise<void>;
  delete(ref: string): Promise<void>;
  listRefs(): Promise<string[]>;
  capabilities(): SecretStoreCapabilities;
}

function copy(value: Uint8Array): Uint8Array {
  return new Uint8Array(value);
}

export class MemorySecretStore implements SecretStore {
  readonly values = new Map<string, Uint8Array>();

  constructor(
    private readonly caps: SecretStoreCapabilities = {
      persistent: false,
      signing: true,
      model: true,
    },
  ) {}

  async get(ref: string): Promise<Uint8Array | null> {
    const value = this.values.get(ref);
    return value ? copy(value) : null;
  }

  async set(ref: string, value: Uint8Array): Promise<void> {
    this.values.set(ref, copy(value));
  }

  async delete(ref: string): Promise<void> {
    const value = this.values.get(ref);
    value?.fill(0);
    this.values.delete(ref);
  }

  async listRefs(): Promise<string[]> {
    return [...this.values.keys()].sort();
  }

  capabilities(): SecretStoreCapabilities {
    return { ...this.caps };
  }
}

export class SecretStoreLockedError extends Error {
  constructor(message = "The secure vault is locked") {
    super(message);
    this.name = "SecretStoreLockedError";
  }
}

const nodeProcess = (globalThis as {
  process?: { release?: { name?: string } };
}).process;
const nodeTestRuntime = nodeProcess?.release?.name === "node";

let activeStore: SecretStore = new MemorySecretStore({
  persistent: false,
  signing: nodeTestRuntime,
  model: nodeTestRuntime,
});
let activeCapabilities = activeStore.capabilities();
let unlocked = nodeTestRuntime;
const sessionSecrets = new Map<string, Uint8Array>();

function clearCache(): void {
  for (const value of sessionSecrets.values()) value.fill(0);
  sessionSecrets.clear();
}

/** Install and fully preload an unlocked store before rendering authoring UI. */
export async function unlockSecretSession(store: SecretStore): Promise<void> {
  const refs = await store.listRefs();
  const loaded = new Map<string, Uint8Array>();
  for (const ref of refs) {
    const value = await store.get(ref);
    if (value) loaded.set(ref, copy(value));
  }
  clearCache();
  activeStore = store;
  activeCapabilities = store.capabilities();
  for (const [ref, value] of loaded) sessionSecrets.set(ref, value);
  unlocked = true;
}

/** Browser startup deliberately installs a non-authoring, session-only store. */
export async function initializeBrowserReadOnlySecretSession(): Promise<void> {
  await unlockSecretSession(new MemorySecretStore({
    persistent: false,
    signing: false,
    model: false,
  }));
}

export function lockSecretSession(): void {
  clearCache();
  unlocked = false;
}

export function secretSessionCapabilities(): SecretStoreCapabilities {
  return { ...activeCapabilities };
}

export function isSecretSessionUnlocked(): boolean {
  return unlocked;
}

export function canPersistSecrets(): boolean {
  return unlocked && activeCapabilities.persistent;
}

export function canSignWithSecrets(): boolean {
  return unlocked && activeCapabilities.signing;
}

export function canUseModelSecrets(): boolean {
  return unlocked && activeCapabilities.model;
}

/** Resolve a short-lived copy; callers may zero it after use when practical. */
export function getSecretCached(ref: string): Uint8Array | null {
  if (!unlocked) return null;
  const value = sessionSecrets.get(ref);
  return value ? copy(value) : null;
}

/** Cache immediately for synchronous consumers, then durably write + verify. */
export async function putSecret(ref: string, value: Uint8Array): Promise<void> {
  if (!unlocked) throw new SecretStoreLockedError();
  if (!activeCapabilities.signing && !activeCapabilities.model) {
    throw new SecretStoreLockedError("This press is read-only; secure authoring is unavailable");
  }
  const cached = copy(value);
  sessionSecrets.set(ref, cached);
  try {
    await activeStore.set(ref, value);
    const verified = await activeStore.get(ref);
    if (!verified || !equalBytes(verified, value)) {
      throw new Error(`Secure-store verification failed for ${ref}`);
    }
  } catch (error) {
    cached.fill(0);
    sessionSecrets.delete(ref);
    throw error;
  }
}

export async function deleteSecret(ref: string): Promise<void> {
  if (!unlocked) throw new SecretStoreLockedError();
  await activeStore.delete(ref);
  const cached = sessionSecrets.get(ref);
  cached?.fill(0);
  sessionSecrets.delete(ref);
}

export async function listSecretRefs(): Promise<string[]> {
  if (!unlocked) throw new SecretStoreLockedError();
  return activeStore.listRefs();
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a[i] ^ b[i];
  return mismatch === 0;
}

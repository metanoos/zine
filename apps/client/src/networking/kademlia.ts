import { invoke } from "@tauri-apps/api/core";

import { isTauri } from "../identity/identity.js";
import {
  activeVaultStorageId,
  subscribeVaultStorage,
  vaultStorage,
  vaultStorageGeneration,
  vaultStorageSessionAcceptsWork,
} from "../storage/vault-storage.js";

const STORAGE_KEY = "zine.kademlia.v1";
export const DEFAULT_KADEMLIA_LISTEN = "/ip4/0.0.0.0/tcp/0";

export interface KademliaConfig {
  enabled: boolean;
  listenAddress: string;
  bootstrapPeers: string[];
}

export interface KademliaStatus {
  running: boolean;
  peerId: string;
  listeners: string[];
  connectedPeers: number;
  routingPeers: number;
  storedCoordinates: number;
  lastError: string | null;
}

export interface RendezvousPointer {
  eventId: string;
  relayUrl: string;
}

export interface KademliaApplyResult {
  config: KademliaConfig;
  status: KademliaStatus | null;
}

type QueryStorage = Pick<Storage, "getItem" | "setItem">;
type ReadStorage = Pick<Storage, "getItem">;
type ConfigListener = () => void;
interface VaultLease {
  generation: number;
  vaultId: string | null;
}

const configListeners = new Set<ConfigListener>();
let runtimeLifecycleQueue: Promise<unknown> = Promise.resolve();

export const DEFAULT_KADEMLIA_CONFIG: KademliaConfig = {
  enabled: false,
  listenAddress: DEFAULT_KADEMLIA_LISTEN,
  bootstrapPeers: [],
};

export function normalizeKademliaConfig(value: unknown): KademliaConfig {
  if (!value || typeof value !== "object") return { ...DEFAULT_KADEMLIA_CONFIG };
  const raw = value as Partial<KademliaConfig>;
  const bootstrapPeers = Array.isArray(raw.bootstrapPeers)
    ? [...new Set(raw.bootstrapPeers
      .filter((peer): peer is string => typeof peer === "string")
      .map((peer) => peer.trim())
      .filter(Boolean))].slice(0, 32)
    : [];
  return {
    enabled: raw.enabled === true,
    listenAddress:
      typeof raw.listenAddress === "string" && raw.listenAddress.trim()
        ? raw.listenAddress.trim().slice(0, 512)
        : DEFAULT_KADEMLIA_LISTEN,
    bootstrapPeers,
  };
}

export function loadKademliaConfig(
  storage: ReadStorage = vaultStorage,
): KademliaConfig {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    return raw
      ? normalizeKademliaConfig(JSON.parse(raw))
      : { ...DEFAULT_KADEMLIA_CONFIG };
  } catch {
    return { ...DEFAULT_KADEMLIA_CONFIG };
  }
}

export function saveKademliaConfig(
  config: KademliaConfig,
  storage: QueryStorage = vaultStorage,
): KademliaConfig {
  const normalized = normalizeKademliaConfig(config);
  storage.setItem(STORAGE_KEY, JSON.stringify(normalized));
  invalidateKademliaConfigCache();
  for (const listener of configListeners) listener();
  return normalized;
}

/** Subscribe to committed Coins/Kademlia configuration changes.
 *
 * `storage` does not fire in the tab that performed the write, so saves notify
 * this module's listeners directly while the DOM listener covers other tabs. */
export function subscribeKademliaConfig(listener: ConfigListener): () => void {
  configListeners.add(listener);
  const unsubscribeVaultStorage = subscribeVaultStorage(() => {
    invalidateKademliaConfigCache();
    listener();
  });
  const storageTarget = typeof window !== "undefined" &&
      typeof window.addEventListener === "function"
    ? window
    : null;
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === STORAGE_KEY) {
      invalidateKademliaConfigCache();
      listener();
    }
  };
  storageTarget?.addEventListener("storage", onStorage);
  return () => {
    configListeners.delete(listener);
    unsubscribeVaultStorage();
    storageTarget?.removeEventListener("storage", onStorage);
  };
}

// Memoize the parsed config so `useSyncExternalStore`'s getSnapshot does not
// re-read and JSON.parse storage on every App render. Invalidated by
// `saveKademliaConfig` (same tab), the `storage` event (other tabs), and the
// vault-storage subscription (vault switches) — every path that can change the
// stored config.
let cachedConfig: { storage: ReadStorage; value: KademliaConfig } | undefined;

function invalidateKademliaConfigCache(): void {
  cachedConfig = undefined;
}

function readKademliaConfigCached(storage: ReadStorage = vaultStorage): KademliaConfig {
  if (cachedConfig && cachedConfig.storage === storage) {
    return cachedConfig.value;
  }
  const value = loadKademliaConfig(storage);
  cachedConfig = { storage, value };
  return value;
}

/** Stable scalar snapshot for React's external-store subscription. */
export function kademliaEnabledSnapshot(): boolean {
  return readKademliaConfigCached().enabled;
}

class StaleVaultOperationError extends Error {
  constructor(readonly lease: VaultLease) {
    super("Coins operation was cancelled because the active vault changed");
    this.name = "StaleVaultOperationError";
  }
}

function captureVaultLease(): VaultLease {
  return {
    generation: vaultStorageGeneration(),
    vaultId: activeVaultStorageId(),
  };
}

function leaseIsCurrent(lease: VaultLease): boolean {
  return vaultStorageSessionAcceptsWork() &&
    lease.generation === vaultStorageGeneration() &&
    lease.vaultId === activeVaultStorageId();
}

function assertCurrentLease(lease: VaultLease): void {
  if (!leaseIsCurrent(lease)) throw new StaleVaultOperationError(lease);
}

function queueRuntimeLifecycle<T>(
  lease: VaultLease,
  operation: (lease: VaultLease) => Promise<T>,
): Promise<T> {
  const task = runtimeLifecycleQueue.then(async () => {
    assertCurrentLease(lease);
    return operation(lease);
  });
  runtimeLifecycleQueue = task.then(() => undefined, () => undefined);
  return task;
}

function serializeRuntimeLifecycle<T>(
  operation: (lease: VaultLease) => Promise<T>,
): Promise<T> {
  return queueRuntimeLifecycle(captureVaultLease(), operation);
}

/** Read-only status waits for lifecycle changes that were already committed. */
function afterRuntimeLifecycle<T>(
  operation: (lease: VaultLease) => Promise<T>,
): Promise<T> {
  const lease = captureVaultLease();
  const barrier = runtimeLifecycleQueue;
  return barrier.then(async () => {
    assertCurrentLease(lease);
    return operation(lease);
  });
}

/** Serialize only the short start/readiness boundary. Native lookup and Put
 * work begins after this returns and therefore cannot block another data-plane
 * operation in the lifecycle queue. Configuration is read at execution time,
 * so a stale caller cannot restart the runtime after a committed disable. */
function prepareDataPlane(
  requireEnabled: boolean,
  lease: VaultLease,
): Promise<boolean> {
  return queueRuntimeLifecycle(lease, async () => {
    if (!isTauri()) return false;
    const config = loadKademliaConfig();
    if (!config.enabled) {
      if (requireEnabled) throw new Error("Coins rendezvous is disabled");
      return false;
    }
    await startForLease(config, lease);
    return true;
  });
}

function operationAborted(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error("operation aborted");
  error.name = "AbortError";
  return error;
}

async function invokeKademliaOperation<T>(
  command: "kademlia_publish_pointer" | "kademlia_lookup",
  payload: Record<string, unknown>,
  lease: VaultLease,
  signal?: AbortSignal,
): Promise<T> {
  assertCurrentLease(lease);
  if (signal?.aborted) throw operationAborted(signal);
  const operationId = crypto.randomUUID();
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      unsubscribeVaultStorage();
      callback();
    };
    const cancel = () => {
      void invoke("kademlia_cancel", { operationId }).catch(() => undefined);
    };
    const onAbort = () => {
      if (!signal) return;
      cancel();
      finish(() => reject(operationAborted(signal)));
    };
    const onVaultStorage = () => {
      if (leaseIsCurrent(lease)) return;
      cancel();
      finish(() => reject(new StaleVaultOperationError(lease)));
    };
    const unsubscribeVaultStorage = subscribeVaultStorage(onVaultStorage);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    if (!leaseIsCurrent(lease)) {
      onVaultStorage();
      return;
    }
    let native: Promise<T>;
    try {
      native = invoke<T>(command, { ...payload, operationId });
    } catch (error) {
      finish(() => reject(error));
      return;
    }
    native.then(
      (value) => finish(() => {
        try {
          assertCurrentLease(lease);
          resolve(value);
        } catch (error) {
          reject(error);
        }
      }),
      (error) => finish(() => reject(error)),
    );
  });
}

async function startNativeKademlia(
  config: KademliaConfig,
): Promise<KademliaStatus | null> {
  if (!isTauri() || !config.enabled) return null;
  return invoke<KademliaStatus>("kademlia_start", { config });
}

async function stopNativeKademlia(): Promise<void> {
  if (!isTauri()) return;
  await invoke("kademlia_stop");
}

async function nativeKademliaStatus(): Promise<KademliaStatus> {
  if (!isTauri()) {
    return {
      running: false,
      peerId: "",
      listeners: [],
      connectedPeers: 0,
      routingPeers: 0,
      storedCoordinates: 0,
      lastError: null,
    };
  }
  return invoke<KademliaStatus>("kademlia_status");
}

async function startForLease(
  config: KademliaConfig,
  lease: VaultLease,
): Promise<KademliaStatus | null> {
  assertCurrentLease(lease);
  const status = await startNativeKademlia(config);
  if (!leaseIsCurrent(lease)) {
    throw new StaleVaultOperationError(lease);
  }
  return status;
}

async function stopForLease(lease: VaultLease): Promise<void> {
  assertCurrentLease(lease);
  await stopNativeKademlia();
  assertCurrentLease(lease);
}

async function statusForLease(lease: VaultLease): Promise<KademliaStatus> {
  assertCurrentLease(lease);
  const status = await nativeKademliaStatus();
  assertCurrentLease(lease);
  return status;
}

/** Start only the configuration that is still committed when this serialized
 * operation reaches the runtime. A queued stale caller can never re-enable a
 * node after a later Coins disable has committed. */
export function ensureKademliaStarted(
  storage: ReadStorage = vaultStorage,
): Promise<KademliaStatus | null> {
  return serializeRuntimeLifecycle((lease) =>
    startForLease(loadKademliaConfig(storage), lease));
}

export function stopKademlia(): Promise<void> {
  return serializeRuntimeLifecycle(stopForLease);
}

export function restartKademlia(
  storage: ReadStorage = vaultStorage,
): Promise<KademliaStatus | null> {
  return serializeRuntimeLifecycle(async (lease) => {
    await stopForLease(lease);
    return startForLease(loadKademliaConfig(storage), lease);
  });
}

/**
 * Apply a replacement configuration without committing an unusable setup.
 *
 * The native start command intentionally leaves an already-running node alone,
 * so validating a replacement requires stopping the current runtime first. We
 * persist only after the replacement has started successfully. If any part of
 * the replacement fails, the previously persisted configuration and runtime
 * are restored before the original error is surfaced.
 */
export function applyKademliaConfig(
  candidate: KademliaConfig,
  storage: QueryStorage = vaultStorage,
): Promise<KademliaApplyResult> {
  return serializeRuntimeLifecycle(async (lease) => {
    // Read at execution time, not call time. Earlier queued applies may have
    // committed a newer authoritative value while this operation was waiting.
    const previous = loadKademliaConfig(storage);
    const next = normalizeKademliaConfig(candidate);

    if (!isTauri()) {
      assertCurrentLease(lease);
      const config = saveKademliaConfig(next, storage);
      assertCurrentLease(lease);
      return {
        config,
        status: null,
      };
    }

    try {
      await stopForLease(lease);
      const status = next.enabled
        ? await startForLease(next, lease)
        : await statusForLease(lease);
      assertCurrentLease(lease);
      const config = saveKademliaConfig(next, storage);
      assertCurrentLease(lease);
      return { config, status };
    } catch (cause) {
      if (cause instanceof StaleVaultOperationError || !leaseIsCurrent(lease)) {
        // Native start is generation-fenced too. Never issue a stale stop after
        // the boundary changed: it could target the newly active vault.
        throw cause instanceof StaleVaultOperationError
          ? cause
          : new StaleVaultOperationError(lease);
      }
      let restoreFailure: unknown = null;
      try {
        // A failed start can still have progressed far enough to create a
        // runtime. Stop is idempotent, so always return to a known baseline.
        await stopNativeKademlia();
        assertCurrentLease(lease);
        if (previous.enabled) {
          await startForLease(previous, lease);
        }
        assertCurrentLease(lease);
        saveKademliaConfig(previous, storage);
      } catch (restoreCause) {
        restoreFailure = restoreCause;
      }

      if (restoreFailure !== null) {
        const originalMessage = cause instanceof Error ? cause.message : String(cause);
        const restoreMessage = restoreFailure instanceof Error
          ? restoreFailure.message
          : String(restoreFailure);
        throw new Error(
          `${originalMessage} (restoring the previous Kademlia configuration failed: ${restoreMessage})`,
        );
      }
      throw cause;
    }
  });
}

export function kademliaStatus(): Promise<KademliaStatus> {
  return afterRuntimeLifecycle(statusForLease);
}

export function publishRendezvousPointer(
  coordinate: string,
  pointer: RendezvousPointer,
  signal?: AbortSignal,
): Promise<void> {
  const lease = captureVaultLease();
  if (signal?.aborted) return Promise.reject(operationAborted(signal));
  return prepareDataPlane(true, lease).then(async (ready) => {
    if (!ready) return;
    await invokeKademliaOperation<void>(
      "kademlia_publish_pointer",
      { coordinate, pointer },
      lease,
      signal,
    );
  });
}

export function lookupRendezvousPointers(
  coordinate: string,
  signal?: AbortSignal,
): Promise<RendezvousPointer[]> {
  const lease = captureVaultLease();
  if (signal?.aborted) return Promise.reject(operationAborted(signal));
  return prepareDataPlane(false, lease).then(async (ready) => {
    if (!ready) return [];
    return invokeKademliaOperation<RendezvousPointer[]>(
      "kademlia_lookup",
      { coordinate },
      lease,
      signal,
    );
  });
}

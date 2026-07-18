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
let runtimeOperationQueue: Promise<unknown> = Promise.resolve();

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
  for (const listener of configListeners) listener();
  return normalized;
}

/** Subscribe to committed Coins/Kademlia configuration changes.
 *
 * `storage` does not fire in the tab that performed the write, so saves notify
 * this module's listeners directly while the DOM listener covers other tabs. */
export function subscribeKademliaConfig(listener: ConfigListener): () => void {
  configListeners.add(listener);
  const unsubscribeVaultStorage = subscribeVaultStorage(listener);
  const storageTarget = typeof window !== "undefined" &&
      typeof window.addEventListener === "function"
    ? window
    : null;
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === STORAGE_KEY) listener();
  };
  storageTarget?.addEventListener("storage", onStorage);
  return () => {
    configListeners.delete(listener);
    unsubscribeVaultStorage();
    storageTarget?.removeEventListener("storage", onStorage);
  };
}

/** Stable scalar snapshot for React's external-store subscription. */
export function kademliaEnabledSnapshot(): boolean {
  return loadKademliaConfig().enabled;
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

function serializeRuntimeOperation<T>(
  operation: (lease: VaultLease) => Promise<T>,
): Promise<T> {
  const lease = captureVaultLease();
  const task = runtimeOperationQueue.then(async () => {
    assertCurrentLease(lease);
    return operation(lease);
  });
  runtimeOperationQueue = task.then(() => undefined, () => undefined);
  return task;
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
  return serializeRuntimeOperation((lease) =>
    startForLease(loadKademliaConfig(storage), lease));
}

export function stopKademlia(): Promise<void> {
  return serializeRuntimeOperation(stopForLease);
}

export function restartKademlia(
  storage: ReadStorage = vaultStorage,
): Promise<KademliaStatus | null> {
  return serializeRuntimeOperation(async (lease) => {
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
  return serializeRuntimeOperation(async (lease) => {
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
  return serializeRuntimeOperation(statusForLease);
}

export function publishRendezvousPointer(
  coordinate: string,
  pointer: RendezvousPointer,
): Promise<void> {
  return serializeRuntimeOperation(async (lease) => {
    if (!isTauri()) return;
    const config = loadKademliaConfig();
    if (!config.enabled) {
      throw new Error("Coins rendezvous is disabled");
    }
    await startForLease(config, lease);
    assertCurrentLease(lease);
    await invoke("kademlia_publish_pointer", { coordinate, pointer });
    assertCurrentLease(lease);
  });
}

export function lookupRendezvousPointers(
  coordinate: string,
): Promise<RendezvousPointer[]> {
  return serializeRuntimeOperation(async (lease) => {
    const config = loadKademliaConfig();
    if (!isTauri() || !config.enabled) return [];
    await startForLease(config, lease);
    assertCurrentLease(lease);
    const pointers = await invoke<RendezvousPointer[]>("kademlia_lookup", { coordinate });
    assertCurrentLease(lease);
    return pointers;
  });
}

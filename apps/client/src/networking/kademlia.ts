import { invoke } from "@tauri-apps/api/core";

import { isTauri } from "../identity/identity.js";

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
  storage: ReadStorage = localStorage,
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
  storage: QueryStorage = localStorage,
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
    storageTarget?.removeEventListener("storage", onStorage);
  };
}

/** Stable scalar snapshot for React's external-store subscription. */
export function kademliaEnabledSnapshot(): boolean {
  return loadKademliaConfig().enabled;
}

function serializeRuntimeOperation<T>(operation: () => Promise<T>): Promise<T> {
  const task = runtimeOperationQueue.then(operation);
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

/** Start only the configuration that is still committed when this serialized
 * operation reaches the runtime. A queued stale caller can never re-enable a
 * node after a later Coins disable has committed. */
export function ensureKademliaStarted(
  storage: ReadStorage = localStorage,
): Promise<KademliaStatus | null> {
  return serializeRuntimeOperation(() =>
    startNativeKademlia(loadKademliaConfig(storage)));
}

export function stopKademlia(): Promise<void> {
  return serializeRuntimeOperation(stopNativeKademlia);
}

export function restartKademlia(
  storage: ReadStorage = localStorage,
): Promise<KademliaStatus | null> {
  return serializeRuntimeOperation(async () => {
    await stopNativeKademlia();
    return startNativeKademlia(loadKademliaConfig(storage));
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
  storage: QueryStorage = localStorage,
): Promise<KademliaApplyResult> {
  return serializeRuntimeOperation(async () => {
    // Read at execution time, not call time. Earlier queued applies may have
    // committed a newer authoritative value while this operation was waiting.
    const previous = loadKademliaConfig(storage);
    const next = normalizeKademliaConfig(candidate);

    if (!isTauri()) {
      return {
        config: saveKademliaConfig(next, storage),
        status: null,
      };
    }

    try {
      await stopNativeKademlia();
      const status = next.enabled
        ? await startNativeKademlia(next)
        : await nativeKademliaStatus();
      const config = saveKademliaConfig(next, storage);
      return { config, status };
    } catch (cause) {
      let restoreFailure: unknown = null;
      try {
        // A failed start can still have progressed far enough to create a
        // runtime. Stop is idempotent, so always return to a known baseline.
        await stopNativeKademlia();
        if (previous.enabled) {
          await startNativeKademlia(previous);
        }
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
  return serializeRuntimeOperation(nativeKademliaStatus);
}

export function publishRendezvousPointer(
  coordinate: string,
  pointer: RendezvousPointer,
): Promise<void> {
  return serializeRuntimeOperation(async () => {
    if (!isTauri()) return;
    const config = loadKademliaConfig();
    if (!config.enabled) {
      throw new Error("Coins rendezvous is disabled");
    }
    await startNativeKademlia(config);
    await invoke("kademlia_publish_pointer", { coordinate, pointer });
  });
}

export function lookupRendezvousPointers(
  coordinate: string,
): Promise<RendezvousPointer[]> {
  return serializeRuntimeOperation(async () => {
    const config = loadKademliaConfig();
    if (!isTauri() || !config.enabled) return [];
    await startNativeKademlia(config);
    return invoke<RendezvousPointer[]>("kademlia_lookup", { coordinate });
  });
}

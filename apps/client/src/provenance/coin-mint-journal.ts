import type { Event } from "nostr-tools";
import { verifyEvent } from "nostr-tools/pure";
import {
  activeVaultStorageId,
  vaultStorage,
  vaultStorageGeneration,
  vaultStorageSessionAcceptsWork,
} from "../storage/vault-storage.js";

const STORAGE_KEY = "zine.pending-coin-mints.v1";
const MAX_PENDING_COIN_MINTS = 32;

type JournalStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type QueueScope = JournalStorage | string;
interface VaultLease {
  generation: number;
  vaultId: string | null;
}
interface CompletionQueueEntry {
  coinId: string;
  task: Promise<unknown>;
}

const prepareQueues = new Map<QueueScope, Promise<unknown>>();
const completionQueues = new Map<QueueScope, Map<string, CompletionQueueEntry>>();

export interface PendingCoinMint {
  operationKey: string;
  sourceFolderId: string;
  mintFolderId: string;
  localPath: string;
  memberName: string;
  phrase: string;
  coin: Event;
  queuedAt: number;
}

export interface CoinMintCompletion<TAttestation> {
  publishPair: (coin: Event) => Promise<TAttestation>;
  persistMembership: (pending: PendingCoinMint) => Promise<void>;
  persistLocal: (pending: PendingCoinMint) => Promise<void> | void;
}

function isPendingCoinMint(value: unknown): value is PendingCoinMint {
  if (!value || typeof value !== "object") return false;
  const pending = value as Partial<PendingCoinMint>;
  return (
    typeof pending.operationKey === "string" &&
    pending.operationKey.length > 0 &&
    typeof pending.sourceFolderId === "string" &&
    typeof pending.mintFolderId === "string" &&
    typeof pending.localPath === "string" &&
    typeof pending.memberName === "string" &&
    typeof pending.phrase === "string" &&
    typeof pending.queuedAt === "number" &&
    Number.isFinite(pending.queuedAt) &&
    verifyEvent(pending.coin as Event)
  );
}

function readJournal(storage: JournalStorage): PendingCoinMint[] {
  const raw = storage.getItem(STORAGE_KEY);
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("the pending Mint journal is corrupt JSON");
  }
  if (!Array.isArray(parsed)) {
    throw new Error("the pending Mint journal has an invalid shape");
  }
  return parsed.map((value, index) => {
    if (!isPendingCoinMint(value)) {
      throw new Error(`the pending Mint journal contains an invalid record at index ${index}`);
    }
    return value;
  });
}

function writeJournal(storage: JournalStorage, records: readonly PendingCoinMint[]): void {
  if (records.length === 0) {
    storage.removeItem(STORAGE_KEY);
    return;
  }
  storage.setItem(STORAGE_KEY, JSON.stringify(records));
}

function captureVaultLease(storage: JournalStorage): VaultLease | null {
  return storage === vaultStorage
    ? {
        generation: vaultStorageGeneration(),
        vaultId: activeVaultStorageId(),
      }
    : null;
}

function vaultLeaseIsCurrent(lease: VaultLease): boolean {
  return vaultStorageSessionAcceptsWork() &&
    lease.generation === vaultStorageGeneration() &&
    lease.vaultId === activeVaultStorageId();
}

class StaleVaultOperationError extends Error {
  constructor() {
    super("pending Mint operation was cancelled because the active vault changed");
    this.name = "StaleVaultOperationError";
  }
}

function assertCurrentVault(lease: VaultLease | null): void {
  if (lease && !vaultLeaseIsCurrent(lease)) throw new StaleVaultOperationError();
}

function queueScope(storage: JournalStorage, lease: VaultLease | null): QueueScope {
  return lease
    ? `vault:${lease.generation}:${lease.vaultId ?? "browser"}`
    : storage;
}

/** Stable identity for one incomplete user gesture. The record is removed on
 * success, so deliberately Minting the same span again later remains valid. */
export function coinMintOperationKey(input: {
  sourceFolderId: string;
  signerPubkey: string;
  phrase: string;
  origin: unknown;
}): string {
  return JSON.stringify([
    input.sourceFolderId,
    input.signerPubkey,
    input.phrase,
    input.origin,
  ]);
}

export function pendingCoinMint(
  operationKey: string,
  storage: JournalStorage = vaultStorage,
): PendingCoinMint | null {
  return readJournal(storage).find((record) => record.operationKey === operationKey) ?? null;
}

/** Every incomplete Mint retained by this install, oldest first. Recovery
 * callers use the signed Coin and stored folder/path metadata directly; they
 * never need to reconstruct a now-stale source selection. */
export function pendingCoinMints(
  storage: JournalStorage = vaultStorage,
): PendingCoinMint[] {
  return readJournal(storage).sort(
    (left, right) => left.queuedAt - right.queuedAt ||
      left.operationKey.localeCompare(right.operationKey),
  );
}

/** Create and durably remember the exact signed Coin before any public phase. */
export async function preparePendingCoinMint(
  operationKey: string,
  create: () => Promise<Omit<PendingCoinMint, "operationKey" | "queuedAt">>,
  storage: JournalStorage = vaultStorage,
  now = Date.now(),
): Promise<PendingCoinMint> {
  const lease = captureVaultLease(storage);
  const scope = queueScope(storage, lease);
  const previous = prepareQueues.get(scope) ?? Promise.resolve();
  const task = previous.catch(() => undefined).then(async () => {
    assertCurrentVault(lease);
    const records = readJournal(storage);
    const existing = records.find((record) => record.operationKey === operationKey);
    if (existing) return existing;
    if (records.length >= MAX_PENDING_COIN_MINTS) {
      throw new Error(`too many incomplete Mint gestures (${MAX_PENDING_COIN_MINTS})`);
    }
    const pending: PendingCoinMint = {
      ...(await create()),
      operationKey,
      queuedAt: now,
    };
    assertCurrentVault(lease);
    if (!isPendingCoinMint(pending)) {
      throw new Error("refusing to journal an invalid pending Mint");
    }
    // Completion may have removed another record while signing awaited I/O.
    // Re-read both identity and capacity before committing this exact event.
    const latest = readJournal(storage);
    const concurrentlyPrepared = latest.find(
      (record) => record.operationKey === operationKey,
    );
    if (concurrentlyPrepared) return concurrentlyPrepared;
    if (latest.length >= MAX_PENDING_COIN_MINTS) {
      throw new Error(`too many incomplete Mint gestures (${MAX_PENDING_COIN_MINTS})`);
    }
    latest.push(pending);
    assertCurrentVault(lease);
    writeJournal(storage, latest);
    return pending;
  });
  const barrier = task.then(() => undefined, () => undefined);
  prepareQueues.set(scope, barrier);
  try {
    return await task;
  } finally {
    if (prepareQueues.get(scope) === barrier) prepareQueues.delete(scope);
  }
}

/** Resume the same pair through every remaining phase. The journal is cleared
 * only after public pair, membership, and local inventory all succeed. */
export async function completePendingCoinMint<TAttestation>(
  pending: PendingCoinMint,
  completion: CoinMintCompletion<TAttestation>,
  storage: JournalStorage = vaultStorage,
): Promise<TAttestation> {
  const lease = captureVaultLease(storage);
  assertCurrentVault(lease);
  const scope = queueScope(storage, lease);
  let scopedQueue = completionQueues.get(scope);
  const inFlight = scopedQueue?.get(pending.operationKey);
  if (inFlight) {
    if (inFlight.coinId !== pending.coin.id) {
      throw new Error("the pending Mint journal no longer matches the signed Coin pair");
    }
    return inFlight.task as Promise<TAttestation>;
  }
  const task = (async () => {
    assertCurrentVault(lease);
    const durable = pendingCoinMint(pending.operationKey, storage);
    if (!durable || durable.coin.id !== pending.coin.id) {
      throw new Error("the pending Mint journal no longer matches the signed Coin pair");
    }
    const attestation = await completion.publishPair(durable.coin);
    assertCurrentVault(lease);
    await completion.persistMembership(durable);
    assertCurrentVault(lease);
    await completion.persistLocal(durable);
    assertCurrentVault(lease);
    const records = readJournal(storage);
    assertCurrentVault(lease);
    writeJournal(
      storage,
      records.filter((record) => record.operationKey !== durable.operationKey),
    );
    return attestation;
  })();
  if (!scopedQueue) {
    scopedQueue = new Map();
    completionQueues.set(scope, scopedQueue);
  }
  const entry = { coinId: pending.coin.id, task };
  scopedQueue.set(pending.operationKey, entry);
  try {
    return await task;
  } finally {
    if (scopedQueue.get(pending.operationKey) === entry) {
      scopedQueue.delete(pending.operationKey);
      if (scopedQueue.size === 0) completionQueues.delete(scope);
    }
  }
}

export interface CoinMintRecoveryFailure {
  operationKey: string;
  coinId: string;
  error: string;
}

/** Resume every durable record without requiring the original source gesture
 * to be recreated. Failures remain journaled and do not starve later records. */
export async function resumePendingCoinMints<TAttestation>(
  completionFor: (pending: PendingCoinMint) => CoinMintCompletion<TAttestation>,
  storage: JournalStorage = vaultStorage,
  shouldResume: (pending: PendingCoinMint) => boolean = () => true,
): Promise<{
  completed: number;
  remaining: number;
  failures: CoinMintRecoveryFailure[];
}> {
  const lease = captureVaultLease(storage);
  assertCurrentVault(lease);
  let completed = 0;
  const failures: CoinMintRecoveryFailure[] = [];
  for (const pending of pendingCoinMints(storage)) {
    assertCurrentVault(lease);
    if (!shouldResume(pending)) {
      assertCurrentVault(lease);
      continue;
    }
    try {
      await completePendingCoinMint(pending, completionFor(pending), storage);
      assertCurrentVault(lease);
      completed++;
    } catch (error) {
      // A vault transition invalidates the complete recovery pass. It is not a
      // per-record publication failure, and the new vault's journal must never
      // be used to calculate this session's result.
      assertCurrentVault(lease);
      failures.push({
        operationKey: pending.operationKey,
        coinId: pending.coin.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  assertCurrentVault(lease);
  return { completed, remaining: pendingCoinMints(storage).length, failures };
}

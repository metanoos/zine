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
const prepareQueues = new Map<string, Promise<unknown>>();

type JournalStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
interface VaultLease {
  generation: number;
  vaultId: string | null;
}

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

function assertCurrentVault(lease: VaultLease | null): void {
  if (
    lease &&
    (!vaultStorageSessionAcceptsWork() ||
      lease.generation !== vaultStorageGeneration() ||
      lease.vaultId !== activeVaultStorageId())
  ) {
    throw new Error("pending Mint operation was cancelled because the active vault changed");
  }
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

/** Create and durably remember the exact signed Coin before any public phase. */
export async function preparePendingCoinMint(
  operationKey: string,
  create: () => Promise<Omit<PendingCoinMint, "operationKey" | "queuedAt">>,
  storage: JournalStorage = vaultStorage,
  now = Date.now(),
): Promise<PendingCoinMint> {
  const lease = captureVaultLease(storage);
  const queueKey = lease
    ? `${lease.generation}:${lease.vaultId ?? "browser"}:${operationKey}`
    : operationKey;
  const previous = prepareQueues.get(queueKey) ?? Promise.resolve();
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
    // Another operation key may have completed while create awaited I/O.
    const latest = readJournal(storage);
    const concurrentlyPrepared = latest.find(
      (record) => record.operationKey === operationKey,
    );
    if (concurrentlyPrepared) return concurrentlyPrepared;
    latest.push(pending);
    assertCurrentVault(lease);
    writeJournal(storage, latest);
    return pending;
  });
  prepareQueues.set(queueKey, task);
  try {
    return await task;
  } finally {
    if (prepareQueues.get(queueKey) === task) prepareQueues.delete(queueKey);
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
}

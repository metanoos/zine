import type { Event } from "nostr-tools";
import { verifyEvent } from "nostr-tools/pure";

const STORAGE_KEY = "zine.pending-coin-mints.v1";
const MAX_PENDING_COIN_MINTS = 32;
const prepareQueues = new Map<string, Promise<unknown>>();

type JournalStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

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
  storage: JournalStorage = localStorage,
): PendingCoinMint | null {
  return readJournal(storage).find((record) => record.operationKey === operationKey) ?? null;
}

/** Create and durably remember the exact signed Coin before any public phase. */
export async function preparePendingCoinMint(
  operationKey: string,
  create: () => Promise<Omit<PendingCoinMint, "operationKey" | "queuedAt">>,
  storage: JournalStorage = localStorage,
  now = Date.now(),
): Promise<PendingCoinMint> {
  const previous = prepareQueues.get(operationKey) ?? Promise.resolve();
  const task = previous.catch(() => undefined).then(async () => {
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
    writeJournal(storage, latest);
    return pending;
  });
  prepareQueues.set(operationKey, task);
  try {
    return await task;
  } finally {
    if (prepareQueues.get(operationKey) === task) prepareQueues.delete(operationKey);
  }
}

/** Resume the same pair through every remaining phase. The journal is cleared
 * only after public pair, membership, and local inventory all succeed. */
export async function completePendingCoinMint<TAttestation>(
  pending: PendingCoinMint,
  completion: CoinMintCompletion<TAttestation>,
  storage: JournalStorage = localStorage,
): Promise<TAttestation> {
  const durable = pendingCoinMint(pending.operationKey, storage);
  if (!durable || durable.coin.id !== pending.coin.id) {
    throw new Error("the pending Mint journal no longer matches the signed Coin pair");
  }
  const attestation = await completion.publishPair(durable.coin);
  await completion.persistMembership(durable);
  await completion.persistLocal(durable);
  const records = readJournal(storage);
  writeJournal(
    storage,
    records.filter((record) => record.operationKey !== durable.operationKey),
  );
  return attestation;
}

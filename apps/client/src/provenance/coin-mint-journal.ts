import type { Event } from "nostr-tools";
import { verifyEvent } from "nostr-tools/pure";
import { diffChars } from "diff";
import {
  findPendingBrackets,
  findResolvedBrackets,
  resolveBracket,
  resolvedBracketMarkup,
} from "./brackets.js";
import {
  activeVaultStorageId,
  vaultStorage,
  vaultStorageGeneration,
  vaultStorageSessionAcceptsWork,
} from "../storage/vault-storage.js";
import {
  editorTransactionLogFromArray,
  editorTransactionLogToArray,
  flattenRuns,
  minimalTextChange,
  nextEditorTransactionSequence,
  reconcileRunsText,
  synthesizeEditorTransactionTransition,
  validateEditorTransactionTransition,
  type EditorTransactionLog,
  type FileState,
} from "../workspace/workspace-core.js";
import type {
  EditorSelectionState,
  EditorTransaction,
} from "@zine/protocol";

const STORAGE_KEY = "zine.pending-coin-mints.v1";
// Bounds localStorage write amplification and the recovery sweep cost each
// gesture re-runs; raising this loosens both, not just the visible queue depth.
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

const journalQueues = new Map<QueueScope, Promise<unknown>>();
const completionQueues = new Map<QueueScope, Map<string, CompletionQueueEntry>>();
const folderCompletionQueues = new Map<QueueScope, Map<string, Promise<void>>>();
const sourceCompletionQueues = new Map<QueueScope, Map<string, Promise<void>>>();

export interface PendingCoinMint {
  operationKey: string;
  sourceFolderId: string;
  mintFolderId: string;
  localPath: string;
  memberName: string;
  phrase: string;
  coin: Event;
  /** Durable proof that the public Coin/attestation pair already completed.
   * Completion adapters validate and restore this value before skipping any
   * network publication on retry. */
  publishedAttestation?: unknown;
  /** The final source citation checkpoint for an extracted Mint. Direct Mints
   * omit this field and retain their existing three-phase completion path. */
  sourceFinalization?: CoinMintSourceFinalization;
  queuedAt: number;
}

interface CoinMintSourceFinalizationBase {
  /** Desktop Mint begins with a pending bracket; the headless span tool begins
   * with raw selected text and installs the canonical resolved bracket. */
  relativePath: string;
  sourceNodeId: string;
  sourceContentHash: string;
  /** UTF-16 offsets into the source snapshot identified above. */
  range: { start: number; end: number };
  /** Durable phase marker written only after the citation checkpoint lands. */
  completedNodeId?: string;
  /** Set before public pair publication. Concurrent preparation must respect
   * this durable range reservation until the journal row clears. */
  publicationReserved?: true;
}

export type CoinMintSourceFinalization = CoinMintSourceFinalizationBase & (
  | {
      kind: "pending-bracket";
      /** Exact unresolved bracket envelope in the source snapshot. */
      bracketRange: { start: number; end: number };
    }
  | { kind: "span" }
);

function translateUsingParts(
  parts: ReturnType<typeof diffChars>,
  baseText: string,
  currentText: string,
  from: number,
  to: number,
): { from: number; to: number } | null {
  let baseOffset = 0;
  let deltaBeforeStart = 0;
  let deltaBeforeEnd = 0;
  for (const part of parts) {
    const length = part.value.length;
    if (part.added) {
      if (baseOffset > from && baseOffset < to) return null;
      if (baseOffset <= from) deltaBeforeStart += length;
      if (baseOffset < to) deltaBeforeEnd += length;
    } else if (part.removed) {
      const removedEnd = baseOffset + length;
      if (baseOffset < to && removedEnd > from) return null;
      if (removedEnd <= from) deltaBeforeStart -= length;
      if (removedEnd <= to) deltaBeforeEnd -= length;
      baseOffset = removedEnd;
    } else {
      baseOffset += length;
    }
  }
  const translated = {
    from: from + deltaBeforeStart,
    to: to + deltaBeforeEnd,
  };
  return currentText.slice(translated.from, translated.to) === baseText.slice(from, to)
    ? translated
    : null;
}

function translateUnchangedRange(
  baseText: string,
  currentText: string,
  from: number,
  to: number,
): { from: number; to: number } | null {
  return translateUsingParts(diffChars(baseText, currentText), baseText, currentText, from, to);
}

/** Resolve the captured citation after disjoint live edits have shifted it.
 * A citation already resolved by an earlier retry is also accepted; edits
 * overlapping either the pending or resolved envelope fail closed.
 *
 * The two translations use different base texts (`sourceText` for the pending
 * envelope, `steppedText` for the resolved envelope), so their `diffChars`
 * outputs cannot be shared — each call computes its own diff. The first call
 * short-circuits the second via the early return when the pending envelope
 * survived, so the second diff only runs in the already-failing path. */
export function rebasedFinalizedCoinMintSourceText(
  record: PendingCoinMint,
  sourceText: string,
  currentText: string,
): string {
  const steppedText = finalizedCoinMintSourceText(record, sourceText);
  const sourceChange = minimalTextChange(sourceText, steppedText);
  if (!sourceChange) return currentText;
  const pendingRange = translateUnchangedRange(
    sourceText,
    currentText,
    sourceChange.from,
    sourceChange.to,
  );
  if (pendingRange) {
    return currentText.slice(0, pendingRange.from) +
      sourceChange.insert +
      currentText.slice(pendingRange.to);
  }
  const resolvedRange = translateUnchangedRange(
    steppedText,
    currentText,
    sourceChange.from,
    sourceChange.from + sourceChange.insert.length,
  );
  if (resolvedRange) return currentText;
  throw new Error("Mint source citation changed while its Step was in flight");
}

/** Finalize an extracted Mint citation against the correct UTF-16 space.
 *
 * Journal ranges start in the captured-source snapshot. After an earlier
 * same-source Mint completes, `rebasePendingSourceAfter` shifts later rows
 * into post-citation live space while leaving `sourceNodeId` /
 * `sourceContentHash` pointed at the original capture. Applying those
 * rebased ranges against the capture strands a public Coin; applying
 * still-original ranges only against live text drops concurrent-edit
 * translation. Detect which space the durable ranges occupy, then either
 * translate from the capture or apply directly to the live document. */
export function resolvedFinalizedCoinMintSourceText(
  record: PendingCoinMint,
  capturedSourceText: string,
  currentText: string,
): string {
  try {
    finalizedCoinMintSourceText(record, capturedSourceText);
  } catch {
    return finalizedCoinMintSourceText(record, currentText);
  }
  return rebasedFinalizedCoinMintSourceText(record, capturedSourceText, currentText);
}

/** Preserve every editor transaction already pending on the source and append
 * the citation resolution as one later transaction. The workspace validates
 * this complete log against the prior signed Step before publication. */
export function finalizedCoinMintSourceStepEditorTransactions(
  currentText: string,
  finalizedText: string,
  captured: EditorTransactionLog,
  signerPubkey: string,
  timestamp = Date.now(),
): EditorTransaction[] {
  return [
    ...editorTransactionLogToArray(captured),
    ...synthesizeEditorTransactionTransition(
      currentText,
      finalizedText,
      signerPubkey,
      timestamp,
      nextEditorTransactionSequence(captured),
    ),
  ];
}

function applyEditorTransactionText(
  text: string,
  transaction: EditorTransaction,
): string {
  const ordered = transaction.changes.map((change, index) => ({ change, index })).sort(
    (left, right) =>
      right.change.from - left.change.from ||
      right.change.to - left.change.to ||
      right.index - left.index,
  );
  let current = text;
  for (const { change } of ordered) {
    current = current.slice(0, change.from) +
      change.text +
      current.slice(change.to);
  }
  return current;
}

/** Operationally move real editor transactions around the citation metadata
 * rewrite. Only offsets change; actor, timestamp, sequence, and intent remain
 * exact. Selection evidence is retained when it translates unambiguously and
 * otherwise omitted rather than fabricated. */
function rebaseCoinMintSourceEditorTransactions(
  sourceText: string,
  steppedText: string,
  currentText: string,
  expectedRebasedText: string,
  transactions: readonly EditorTransaction[],
): EditorTransaction[] {
  if (!validateEditorTransactionTransition(
    sourceText,
    currentText,
    transactions,
  ).valid) {
    throw new Error(
      "Mint source contains an invalid concurrent EditorTransaction log",
    );
  }
  const sourceChange = minimalTextChange(sourceText, steppedText);
  if (!sourceChange) return [...transactions];
  const replacementDelta = sourceChange.insert.length -
    (sourceChange.to - sourceChange.from);
  let citationFrom = sourceChange.from;
  let citationTo = sourceChange.to;
  let original = sourceText;
  let rebased = steppedText;
  const transformed: EditorTransaction[] = [];
  const translateSelection = (
    selection: EditorSelectionState | null,
  ): EditorSelectionState | null => {
    if (selection === null) return null;
    const ranges = selection.ranges.map((range) => {
      const translate = (position: number) => {
        if (position <= citationFrom) return position;
        if (position >= citationTo) return position + replacementDelta;
        return null;
      };
      const anchor = translate(range.anchor);
      const head = translate(range.head);
      return anchor === null || head === null ? null : { anchor, head };
    });
    return ranges.some((range) => range === null)
      ? null
      : {
          ranges: ranges as { anchor: number; head: number }[],
          main: selection.main,
        };
  };
  for (const transaction of transactions) {
    let shiftBeforeCitation = 0;
    const transformedChanges = transaction.changes.map((change) => {
      const before = change.to <= citationFrom;
      const after = change.from >= citationTo;
      if (!before && !after) {
        throw new Error("Mint source citation overlaps a concurrent editor transaction");
      }
      if (before) {
        shiftBeforeCitation += change.text.length - (change.to - change.from);
        return { ...change };
      }
      return {
        ...change,
        from: change.from + replacementDelta,
        to: change.to + replacementDelta,
      };
    });
    const transformedTransaction: EditorTransaction = {
      ...transaction,
      changes: transformedChanges,
      selectionBefore: transaction.changes.length === 0
        ? translateSelection(transaction.selectionBefore)
        : null,
      selectionAfter: transaction.changes.length === 0
        ? translateSelection(transaction.selectionAfter)
        : null,
    };
    if (
      transformedTransaction.changes.length === 0 &&
      (
        transformedTransaction.selectionBefore === null ||
        transformedTransaction.selectionAfter === null
      )
    ) {
      continue;
    }
    original = applyEditorTransactionText(original, transaction);
    rebased = applyEditorTransactionText(rebased, transformedTransaction);
    citationFrom += shiftBeforeCitation;
    citationTo += shiftBeforeCitation;
    transformed.push(transformedTransaction);
  }
  if (
    original !== currentText ||
    rebased !== expectedRebasedText ||
    !validateEditorTransactionTransition(steppedText, rebased, transformed).valid
  ) {
    throw new Error(
      "Mint source concurrent EditorTransactions could not be rebased truthfully",
    );
  }
  return transformed;
}

/** Advance a delayed source-citation Step without overwriting edits made while
 * its relay barrier was in flight. The citation replacement is translated
 * from the captured source, and real concurrent EditorTransactions retain
 * their authorship and transaction metadata on top of the Step that landed. */
export function rebaseFinalizedCoinMintSourceFile(
  record: PendingCoinMint,
  current: FileState,
  sourceText: string,
  steppedText: string,
  steppedNodeId: string,
  signerPubkey: string,
  concurrentEditorTransactions: readonly EditorTransaction[] = [],
): FileState {
  const currentText = flattenRuns(current.runs);
  if (finalizedCoinMintSourceText(record, sourceText) !== steppedText) {
    throw new Error("Mint source Step does not match its captured citation target");
  }
  const rebasedText = rebasedFinalizedCoinMintSourceText(record, sourceText, currentText);
  const runs = reconcileRunsText(current.runs, rebasedText, signerPubkey);
  const pending = concurrentEditorTransactions.length > 0
    ? rebaseCoinMintSourceEditorTransactions(
        sourceText,
        steppedText,
        currentText,
        rebasedText,
        concurrentEditorTransactions,
      )
    : synthesizeEditorTransactionTransition(
        steppedText,
        rebasedText,
        signerPubkey,
      );
  const { editorTransactions: _priorTransactions, ...rest } = current;
  return {
    ...rest,
    runs,
    nodeId: steppedNodeId,
    ...(pending.length > 0
      ? { editorTransactions: editorTransactionLogFromArray(pending) }
      : {}),
  };
}

export interface CoinMintCompletion<TAttestation> {
  publishPair: (coin: Event) => Promise<TAttestation>;
  serializeAttestation?: (attestation: TAttestation) => unknown;
  restoreAttestation?: (stored: unknown, coin: Event) => TAttestation | null;
  persistMembership: (pending: PendingCoinMint) => Promise<void>;
  persistLocal: (pending: PendingCoinMint) => Promise<void> | void;
  /** Required for extracted Mints. Completion must not return until the source
   * file's resolved bracket has itself landed as a Step. */
  finalizeSource?: (pending: PendingCoinMint) => Promise<string>;
}

/** Restore only the exact valid same-minter attestation created by compound
 * Mint. A corrupt local marker must never suppress required publication. */
export function storedCoinMintAttestation(value: unknown, coin: Event): Event | null {
  if (!value || typeof value !== "object") return null;
  const attestation = value as Event;
  try {
    if (
      attestation.kind !== 4294 ||
      attestation.pubkey !== coin.pubkey ||
      !verifyEvent(attestation)
    ) return null;
  } catch {
    return null;
  }
  const targets = attestation.tags.filter((tag) => tag[0] === "e");
  const kinds = attestation.tags.filter((tag) => tag[0] === "k");
  const authors = attestation.tags.filter((tag) => tag[0] === "p");
  const geohashes = attestation.tags.filter((tag) => tag[0] === "g");
  if (
    targets.length !== 1 ||
    targets[0]?.[1] !== coin.id ||
    targets[0]?.[2] !== "" ||
    targets[0]?.[3] !== "target" ||
    kinds.length !== 1 ||
    kinds[0]?.[1] !== "4290" ||
    authors.length > 1 ||
    (authors.length === 1 && authors[0]?.[1] !== coin.pubkey) ||
    geohashes.length > 1 ||
    attestation.tags.some((tag) => !["e", "k", "p", "g"].includes(tag[0] ?? ""))
  ) return null;
  try {
    const content = JSON.parse(attestation.content) as unknown;
    if (!content || typeof content !== "object" || Array.isArray(content)) return null;
    const record = content as Record<string, unknown>;
    return Object.keys(record).every((key) => key === "message") &&
        (record.message === undefined || typeof record.message === "string")
      ? attestation
      : null;
  } catch {
    return null;
  }
}

/** Durable result shared by every caller coalesced onto one Mint gesture. */
export interface CoinMintCompletionReceipt<TAttestation> {
  attestation: TAttestation;
  /** Present for an extracted Mint once its citation Step is durable. */
  sourceNodeId?: string;
}

function isCoinMintSourceFinalization(value: unknown): value is CoinMintSourceFinalization {
  if (!value || typeof value !== "object") return false;
  const source = value as Partial<CoinMintSourceFinalization>;
  const range = source.range as Partial<CoinMintSourceFinalization["range"]> | undefined;
  const bracketRange = (source as { bracketRange?: { start?: unknown; end?: unknown } }).bracketRange;
  const validBracketRange = source.kind !== "pending-bracket" || (
    Number.isInteger(bracketRange?.start) &&
    Number.isInteger(bracketRange?.end) &&
    (bracketRange!.start as number) >= 0 &&
    (bracketRange!.end as number) >= (bracketRange!.start as number)
  );
  return (
    (source.kind === "pending-bracket" || source.kind === "span") &&
    typeof source.relativePath === "string" &&
    source.relativePath.length > 0 &&
    typeof source.sourceNodeId === "string" &&
    /^[0-9a-f]{64}$/.test(source.sourceNodeId) &&
    typeof source.sourceContentHash === "string" &&
    /^[0-9a-f]{64}$/.test(source.sourceContentHash) &&
    (source.completedNodeId === undefined || /^[0-9a-f]{64}$/.test(source.completedNodeId)) &&
    (source.publicationReserved === undefined || source.publicationReserved === true) &&
    Number.isInteger(range?.start) &&
    Number.isInteger(range?.end) &&
    range!.start! >= 0 &&
    range!.end! >= range!.start! &&
    validBracketRange
  );
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
    (pending.sourceFinalization === undefined ||
      isCoinMintSourceFinalization(pending.sourceFinalization)) &&
    typeof pending.queuedAt === "number" &&
    Number.isFinite(pending.queuedAt) &&
    verifyEvent(pending.coin as Event)
  );
}

/** Return the exact source body an extracted Mint must Step. The transform is
 * idempotent only at the recorded target: a crash after the citation Step but
 * before journal cleanup sees the same Coin id there and performs no second
 * rewrite. Concurrent edits that move/remove the target fail closed and leave
 * the journal available for recovery. */
export function finalizedCoinMintSourceText(
  pending: PendingCoinMint,
  currentText: string,
): string {
  const source = pending.sourceFinalization;
  if (!source) return currentText;

  const expectedMatchStart = source.kind === "pending-bracket"
    ? source.bracketRange.start
    : source.range.start;
  const alreadyResolved = findResolvedBrackets(currentText).some(
    (bracket) =>
      bracket.matchStart === expectedMatchStart &&
      bracket.nodeId === pending.coin.id &&
      bracket.phrase === pending.phrase.trim(),
  );
  if (alreadyResolved) return currentText;

  if (source.kind === "pending-bracket") {
    const target = findPendingBrackets(currentText).find(
      (bracket) =>
        bracket.matchStart === source.bracketRange.start &&
        bracket.matchEnd === source.bracketRange.end &&
        bracket.phraseStart === source.range.start &&
        bracket.phraseEnd === source.range.end &&
        bracket.phrase === pending.phrase,
    );
    if (!target) {
      throw new Error(
        `cannot finalize Mint source ${source.relativePath}: its recorded pending bracket is missing`,
      );
    }
    return resolveBracket(currentText, target.matchStart, target.matchEnd, pending.coin.id);
  }

  const exactPhrase = currentText.slice(source.range.start, source.range.end);
  if (exactPhrase !== pending.phrase) {
    throw new Error(
      `cannot finalize Mint source ${source.relativePath}: its selected span no longer matches`,
    );
  }
  const markup = resolvedBracketMarkup(pending.phrase, pending.coin.id);
  if (!markup) throw new Error("cannot finalize an empty Mint source citation");
  return currentText.slice(0, source.range.start) + markup + currentText.slice(source.range.end);
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

function queueJournalOperation<T>(scope: QueueScope, operation: () => Promise<T> | T): Promise<T> {
  const previous = journalQueues.get(scope) ?? Promise.resolve();
  const task = previous.catch(() => undefined).then(operation);
  const barrier = task.then(() => undefined, () => undefined);
  journalQueues.set(scope, barrier);
  return task.finally(() => {
    if (journalQueues.get(scope) === barrier) journalQueues.delete(scope);
  });
}

function queueFolderCompletion<T>(
  scope: QueueScope,
  mintFolderId: string,
  operation: () => Promise<T>,
): Promise<T> {
  let scopedQueues = folderCompletionQueues.get(scope);
  if (!scopedQueues) {
    scopedQueues = new Map();
    folderCompletionQueues.set(scope, scopedQueues);
  }
  const previous = scopedQueues.get(mintFolderId) ?? Promise.resolve();
  const task = previous.catch(() => undefined).then(operation);
  const barrier = task.then(() => undefined, () => undefined);
  scopedQueues.set(mintFolderId, barrier);
  return task.finally(() => {
    if (scopedQueues.get(mintFolderId) === barrier) {
      scopedQueues.delete(mintFolderId);
      if (scopedQueues.size === 0) folderCompletionQueues.delete(scope);
    }
  });
}

function sourceCompletionKey(pending: PendingCoinMint): string | null {
  const source = pending.sourceFinalization;
  return source
    ? JSON.stringify([
        pending.sourceFolderId,
        source.relativePath,
        source.sourceNodeId,
        source.sourceContentHash,
      ])
    : null;
}

function queueSourceCompletion<T>(
  scope: QueueScope,
  sourceKey: string | null,
  operation: () => Promise<T>,
): Promise<T> {
  if (!sourceKey) return operation();
  let scopedQueues = sourceCompletionQueues.get(scope);
  if (!scopedQueues) {
    scopedQueues = new Map();
    sourceCompletionQueues.set(scope, scopedQueues);
  }
  const previous = scopedQueues.get(sourceKey) ?? Promise.resolve();
  const task = previous.catch(() => undefined).then(operation);
  const barrier = task.then(() => undefined, () => undefined);
  scopedQueues.set(sourceKey, barrier);
  return task.finally(() => {
    if (scopedQueues.get(sourceKey) === barrier) {
      scopedQueues.delete(sourceKey);
      if (scopedQueues.size === 0) sourceCompletionQueues.delete(scope);
    }
  });
}

function sameSourceIdentity(left: PendingCoinMint, right: PendingCoinMint): boolean {
  return sourceCompletionKey(left) !== null &&
    sourceCompletionKey(left) === sourceCompletionKey(right);
}

function sourceEditRange(source: CoinMintSourceFinalization): { start: number; end: number } {
  return source.kind === "pending-bracket" ? source.bracketRange : source.range;
}

function sourceReplacementDelta(pending: PendingCoinMint): number {
  const source = pending.sourceFinalization;
  if (!source) return 0;
  const replaced = sourceEditRange(source);
  const replacementLength = source.kind === "pending-bracket"
    ? source.range.end - source.bracketRange.start + ` | ${pending.coin.id} ]]`.length
    : resolvedBracketMarkup(pending.phrase, pending.coin.id).length;
  return replacementLength - (replaced.end - replaced.start);
}

function shiftSourceFinalization(
  source: CoinMintSourceFinalization,
  delta: number,
): CoinMintSourceFinalization {
  const range = { start: source.range.start + delta, end: source.range.end + delta };
  return source.kind === "pending-bracket"
    ? {
        ...source,
        range,
        bracketRange: {
          start: source.bracketRange.start + delta,
          end: source.bracketRange.end + delta,
        },
      }
    : { ...source, range };
}

function sourceRangesOverlap(left: PendingCoinMint, right: PendingCoinMint): boolean {
  const leftRange = sourceEditRange(left.sourceFinalization!);
  const rightRange = sourceEditRange(right.sourceFinalization!);
  return leftRange.start < rightRange.end && rightRange.start < leftRange.end;
}

function comparePendingMintOrder(left: PendingCoinMint, right: PendingCoinMint): number {
  const leftReserved = left.sourceFinalization?.publicationReserved === true ? 0 : 1;
  const rightReserved = right.sourceFinalization?.publicationReserved === true ? 0 : 1;
  return leftReserved - rightReserved ||
    left.queuedAt - right.queuedAt ||
    left.operationKey.localeCompare(right.operationKey) ||
    left.coin.id.localeCompare(right.coin.id);
}

/** Return obsolete overlapping legacy rows when `pending` is their stable
 * winner. New preparations reject overlap eagerly, but older journals may
 * already contain an impossible pair. A possibly-public reserved gesture wins;
 * otherwise only the oldest signed, still-local gesture may cross publication. */
function sourceReservationLosers(
  pending: PendingCoinMint,
  records: readonly PendingCoinMint[],
): Set<string> {
  if (!pending.sourceFinalization || pending.sourceFinalization.completedNodeId) return new Set();
  const overlaps = records.filter((record) =>
    record.operationKey !== pending.operationKey &&
    record.sourceFinalization &&
    !record.sourceFinalization.completedNodeId &&
    sameSourceIdentity(pending, record) &&
    sourceRangesOverlap(pending, record)
  );
  if (overlaps.length === 0) return new Set();
  const winner = [pending, ...overlaps].sort(comparePendingMintOrder)[0]!;
  if (winner.operationKey !== pending.operationKey) {
    throw new Error(
      `cannot complete Mint source ${pending.sourceFinalization.relativePath}: ` +
        "an earlier pending Mint overlaps its recorded source range",
    );
  }
  return new Set(overlaps.map((record) => record.operationKey));
}

function assertPendingSourceDoesNotOverlap(
  pending: PendingCoinMint,
  records: readonly PendingCoinMint[],
): void {
  if (!pending.sourceFinalization) return;
  const conflict = records.find((record) =>
    record.operationKey !== pending.operationKey &&
    record.sourceFinalization &&
    !record.sourceFinalization.completedNodeId &&
    sameSourceIdentity(pending, record) &&
    sourceRangesOverlap(pending, record)
  );
  if (conflict) {
    throw new Error(
      `cannot journal Mint source ${pending.sourceFinalization.relativePath}: ` +
        "its source range overlaps another pending Mint",
    );
  }
}

function reserveSourcePublication(
  scope: QueueScope,
  pending: PendingCoinMint,
  storage: JournalStorage,
  lease: VaultLease | null,
): Promise<PendingCoinMint> {
  if (!pending.sourceFinalization || pending.sourceFinalization.completedNodeId) {
    return Promise.resolve(pending);
  }
  return queueJournalOperation(scope, () => {
    assertCurrentVault(lease);
    const records = readJournal(storage);
    const index = records.findIndex((record) =>
      record.operationKey === pending.operationKey && record.coin.id === pending.coin.id
    );
    if (index === -1) {
      throw new Error("the pending Mint journal no longer matches the signed Coin pair");
    }
    const current = records[index]!;
    const obsoleteOverlaps = sourceReservationLosers(current, records);
    const reserved: PendingCoinMint = {
      ...current,
      sourceFinalization: { ...current.sourceFinalization!, publicationReserved: true },
    };
    const retained = records
      .filter((record) => !obsoleteOverlaps.has(record.operationKey))
      .map((record) => record.operationKey === current.operationKey ? reserved : record);
    assertCurrentVault(lease);
    writeJournal(storage, retained);
    return reserved;
  });
}

function persistPublishedAttestation(
  scope: QueueScope,
  pending: PendingCoinMint,
  publishedAttestation: unknown,
  storage: JournalStorage,
  lease: VaultLease | null,
): Promise<PendingCoinMint> {
  return queueJournalOperation(scope, () => {
    assertCurrentVault(lease);
    const records = readJournal(storage);
    const index = records.findIndex((record) =>
      record.operationKey === pending.operationKey && record.coin.id === pending.coin.id
    );
    if (index === -1) {
      throw new Error("the pending Mint journal no longer matches the signed Coin pair");
    }
    const updated = { ...records[index]!, publishedAttestation };
    records[index] = updated;
    assertCurrentVault(lease);
    writeJournal(storage, records);
    return updated;
  });
}

function rebasePendingSourceAfter(
  completed: PendingCoinMint,
  pending: PendingCoinMint,
): PendingCoinMint {
  if (
    !completed.sourceFinalization ||
    !pending.sourceFinalization ||
    pending.sourceFinalization.completedNodeId ||
    !sameSourceIdentity(completed, pending)
  ) {
    return pending;
  }
  const completedRange = sourceEditRange(completed.sourceFinalization);
  const pendingRange = sourceEditRange(pending.sourceFinalization);
  if (pendingRange.end <= completedRange.start) return pending;
  if (completedRange.end <= pendingRange.start) {
    return {
      ...pending,
      sourceFinalization: shiftSourceFinalization(
        pending.sourceFinalization,
        sourceReplacementDelta(completed),
      ),
    };
  }
  throw new Error(
    `cannot rebase Mint source ${pending.sourceFinalization.relativePath}: ` +
      "pending source ranges overlap",
  );
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

interface CoinMintSourceReservation {
  sourceFolderId: string;
  relativePath: string;
}

export function coinMintSourcePathBlocksMutation(
  sourcePath: string,
  path: string,
  isFolder: boolean,
): boolean {
  return sourcePath === path ||
    (isFolder && (path === "" || sourcePath.startsWith(`${path}/`)));
}

/** Hold an extracted source path synchronously, before the first async Mint
 * preparation step can yield. The reservation overlaps the durable journal
 * row and is released only when the foreground gesture settles. */
export function createCoinMintSourceReservationRegistry(): {
  reserve: (sourceFolderId: string, relativePath: string) => () => void;
  blocks: (sourceFolderId: string, path: string, isFolder: boolean) => boolean;
} {
  const active = new Map<symbol, CoinMintSourceReservation>();
  return {
    reserve(sourceFolderId, relativePath) {
      const token = Symbol("pending Mint source");
      active.set(token, { sourceFolderId, relativePath });
      return () => active.delete(token);
    },
    blocks(sourceFolderId, path, isFolder) {
      return [...active.values()].some((reservation) =>
        reservation.sourceFolderId === sourceFolderId &&
        coinMintSourcePathBlocksMutation(reservation.relativePath, path, isFolder)
      );
    },
  };
}

/** Return the unfinished extracted Mint whose source citation would be
 * stranded by moving, renaming, or deleting `path`. Once the citation Step is
 * durable, the remaining membership/inventory phases no longer depend on the
 * source path and ordinary workspace mutations may proceed. */
export function pendingCoinMintBlockingSourceMutation(
  sourceFolderId: string,
  path: string,
  isFolder: boolean,
  storage: JournalStorage = vaultStorage,
): PendingCoinMint | null {
  return pendingCoinMints(storage).find((pending) => {
    const source = pending.sourceFinalization;
    if (
      pending.sourceFolderId !== sourceFolderId ||
      !source ||
      source.completedNodeId
    ) return false;
    return coinMintSourcePathBlocksMutation(source.relativePath, path, isFolder);
  }) ?? null;
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
  return queueJournalOperation(scope, async () => {
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
    assertPendingSourceDoesNotOverlap(pending, latest);
    latest.push(pending);
    assertCurrentVault(lease);
    writeJournal(storage, latest);
    return pending;
  });
}

/** Resume the same pair through every remaining phase. Extracted Mints Step
 * their source citation before entering membership/local inventory; direct
 * Mints preserve the original pair → membership → local ordering. */
export async function completePendingCoinMint<TAttestation>(
  pending: PendingCoinMint,
  completion: CoinMintCompletion<TAttestation>,
  storage: JournalStorage = vaultStorage,
): Promise<CoinMintCompletionReceipt<TAttestation>> {
  const lease = captureVaultLease(storage);
  assertCurrentVault(lease);
  const scope = queueScope(storage, lease);
  let scopedQueue = completionQueues.get(scope);
  const inFlight = scopedQueue?.get(pending.operationKey);
  if (inFlight) {
    if (inFlight.coinId !== pending.coin.id) {
      throw new Error("the pending Mint journal no longer matches the signed Coin pair");
    }
    return inFlight.task as Promise<CoinMintCompletionReceipt<TAttestation>>;
  }
  const task = queueSourceCompletion(scope, sourceCompletionKey(pending), () =>
    queueFolderCompletion(scope, pending.mintFolderId, async () => {
    assertCurrentVault(lease);
    let durable = pendingCoinMint(pending.operationKey, storage);
    if (!durable || durable.coin.id !== pending.coin.id) {
      throw new Error("the pending Mint journal no longer matches the signed Coin pair");
    }
    // Reserve an unambiguous source range durably while still wholly local.
    // Once the pair is public it cannot be revoked, so a concurrent prepare
    // must see and respect this boundary rather than strand an uncited Coin.
    durable = await reserveSourcePublication(scope, durable, storage, lease);
    const restoredAttestation: TAttestation | null = durable.publishedAttestation !== undefined
      ? completion.restoreAttestation?.(durable.publishedAttestation, durable.coin) ?? null
      : null;
    let attestation: TAttestation;
    if (restoredAttestation !== null) {
      attestation = restoredAttestation;
    } else {
      attestation = await completion.publishPair(durable.coin) as TAttestation;
      const stored = completion.serializeAttestation?.(attestation);
      if (stored !== undefined) {
        durable = await persistPublishedAttestation(scope, durable, stored, storage, lease);
      }
    }
    assertCurrentVault(lease);
    if (durable.sourceFinalization && !durable.sourceFinalization.completedNodeId) {
      if (!completion.finalizeSource) {
        throw new Error("extracted Mint completion is missing its source finalization phase");
      }
      const completedNodeId = await completion.finalizeSource(durable);
      assertCurrentVault(lease);
      if (!/^[0-9a-f]{64}$/.test(completedNodeId)) {
        throw new Error("Mint source finalization did not return a valid citation node id");
      }
      const durableRecord = durable;
      durable = await queueJournalOperation(scope, () => {
        assertCurrentVault(lease);
        const records = readJournal(storage);
        const durableOperationKey = durableRecord.operationKey;
        const durableCoinId = durableRecord.coin.id;
        const durableIndex = records.findIndex(
          (record) =>
            record.operationKey === durableOperationKey && record.coin.id === durableCoinId,
        );
        if (durableIndex === -1) {
          throw new Error("the pending Mint journal no longer matches the signed Coin pair");
        }
        const updated: PendingCoinMint = {
          ...durableRecord,
          sourceFinalization: { ...durableRecord.sourceFinalization!, completedNodeId },
        };
        records[durableIndex] = updated;
        // Resolving one citation changes the document's UTF-16 offsets. Rebase
        // every later non-overlapping Mint from this same durable source
        // snapshot before its source lock is released and before it publishes.
        for (let index = 0; index < records.length; index++) {
          if (index === durableIndex) continue;
          records[index] = rebasePendingSourceAfter(durableRecord, records[index]!);
        }
        assertCurrentVault(lease);
        writeJournal(storage, records);
        return updated;
      });
    }
    await completion.persistMembership(durable);
    assertCurrentVault(lease);
    await completion.persistLocal(durable);
    assertCurrentVault(lease);
    await queueJournalOperation(scope, () => {
      assertCurrentVault(lease);
      const records = readJournal(storage);
      writeJournal(
        storage,
        records.filter((record) => record.operationKey !== durable.operationKey),
      );
    });
    return {
      attestation,
      ...(durable.sourceFinalization?.completedNodeId
        ? { sourceNodeId: durable.sourceFinalization.completedNodeId }
        : {}),
    };
  }));
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

export interface CoinMintRecoverySessionLease {
  readonly signal: AbortSignal;
  readonly promise: Promise<void>;
  release(): void;
}

export const COIN_MINT_RECOVERY_RETRY_MIN_MS = 5_000;
export const COIN_MINT_RECOVERY_RETRY_MAX_MS = 5 * 60_000;

/** Keep retrying a durable Mint journal until it is empty or its vault-scoped
 * signal is aborted. The caller owns the wait primitive so the desktop can
 * combine bounded timers with an immediate browser-online wakeup. */
export async function retryCoinMintRecovery(
  attempt: () => Promise<{ remaining: number }>,
  waitForRetry: (delayMs: number, signal: AbortSignal) => Promise<void>,
  signal: AbortSignal,
  onAttemptError: (error: unknown) => void = () => undefined,
): Promise<void> {
  let retryDelayMs = COIN_MINT_RECOVERY_RETRY_MIN_MS;
  while (!signal.aborted) {
    try {
      const result = await attempt();
      if (signal.aborted || result.remaining === 0) return;
    } catch (error) {
      if (signal.aborted) return;
      onAttemptError(error);
    }
    try {
      await waitForRetry(retryDelayMs, signal);
    } catch (error) {
      if (signal.aborted) return;
      throw error;
    }
    retryDelayMs = Math.min(
      COIN_MINT_RECOVERY_RETRY_MAX_MS,
      retryDelayMs * 2,
    );
  }
}

/** Share one startup-recovery pass across React's setup → cleanup → setup
 * StrictMode replay. Cleanup aborts on the next microtask only when no replay
 * has reattached, so a real opt-out still fences the pending public phase. */
export function createCoinMintRecoverySessionRegistry(): {
  acquire(
    session: string,
    start: (signal: AbortSignal) => Promise<void>,
  ): CoinMintRecoverySessionLease;
} {
  type SessionState = {
    controller: AbortController;
    promise: Promise<void>;
    subscribers: number;
    settled: boolean;
  };
  const active = new Map<string, SessionState>();
  return {
    acquire(session, start) {
      let state = active.get(session);
      if (!state) {
        const controller = new AbortController();
        state = {
          controller,
          promise: Promise.resolve(),
          subscribers: 0,
          settled: false,
        };
        active.set(session, state);
        const ownedState = state;
        ownedState.promise = start(controller.signal).finally(() => {
          ownedState.settled = true;
          if (active.get(session) === ownedState) active.delete(session);
        });
      }
      state.subscribers++;
      let released = false;
      const ownedState = state;
      return {
        signal: ownedState.controller.signal,
        promise: ownedState.promise,
        release() {
          if (released) return;
          released = true;
          ownedState.subscribers = Math.max(0, ownedState.subscribers - 1);
          queueMicrotask(() => {
            if (ownedState.settled || ownedState.subscribers > 0) return;
            if (active.get(session) === ownedState) active.delete(session);
            const reason = new Error("Coins disabled during Mint recovery");
            reason.name = "AbortError";
            ownedState.controller.abort(reason);
          });
        },
      };
    },
  };
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

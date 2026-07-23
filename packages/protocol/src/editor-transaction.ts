/** Semantic history action attached to one replayable editor transaction. */
export type EditorTransactionIntent = "undo" | "redo";

/** One UTF-16 range mutation inside an editor transaction. */
export interface TextChange {
  op: "insert" | "delete" | "replace";
  from: number;
  to: number;
  text: string;
}

/** One directional editor selection range in UTF-16 coordinates. */
export interface EditorSelectionRange {
  anchor: number;
  head: number;
}

/** Complete multi-range editor selection. `main` indexes the primary range. */
export interface EditorSelectionState {
  ranges: EditorSelectionRange[];
  main: number;
}

/**
 * One discrete editor transaction. Synthetic non-editor transitions use null
 * selections rather than claiming cursor state that was never observed.
 */
export interface EditorTransaction {
  sequence: number;
  timestamp: number;
  actor: string;
  changes: TextChange[];
  selectionBefore: EditorSelectionState | null;
  selectionAfter: EditorSelectionState | null;
  intent?: EditorTransactionIntent;
}

export interface EditorTransactionTransitionValidation {
  valid: boolean;
  reason?: string;
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

function hasExactKeys(
  value: object,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    keys.every((key) => allowed.has(key));
}

export function isEditorSelectionState(value: unknown): value is EditorSelectionState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (!hasExactKeys(value, ["ranges", "main"])) return false;
  const selection = value as Partial<EditorSelectionState>;
  if (
    !Array.isArray(selection.ranges) ||
    selection.ranges.length === 0 ||
    !nonNegativeInteger(selection.main) ||
    selection.main >= selection.ranges.length
  ) return false;
  return selection.ranges.every((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
    if (!hasExactKeys(candidate, ["anchor", "head"])) return false;
    const range = candidate as Partial<EditorSelectionRange>;
    return nonNegativeInteger(range.anchor) && nonNegativeInteger(range.head);
  });
}

export function isTextChange(value: unknown): value is TextChange {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (!hasExactKeys(value, ["op", "from", "to", "text"])) return false;
  const change = value as Partial<TextChange>;
  return (
    (change.op === "insert" || change.op === "delete" || change.op === "replace") &&
    nonNegativeInteger(change.from) &&
    nonNegativeInteger(change.to) &&
    change.to >= change.from &&
    typeof change.text === "string"
  );
}

export function isEditorTransaction(value: unknown): value is EditorTransaction {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (!hasExactKeys(
    value,
    ["sequence", "timestamp", "actor", "changes", "selectionBefore", "selectionAfter"],
    ["intent"],
  )) return false;
  const transaction = value as Partial<EditorTransaction>;
  return (
    nonNegativeInteger(transaction.sequence) &&
    Number.isFinite(transaction.timestamp) &&
    typeof transaction.actor === "string" &&
    Array.isArray(transaction.changes) &&
    transaction.changes.every(isTextChange) &&
    (transaction.selectionBefore === null ||
      isEditorSelectionState(transaction.selectionBefore)) &&
    (transaction.selectionAfter === null ||
      isEditorSelectionState(transaction.selectionAfter)) &&
    ((transaction.selectionBefore === null) === (transaction.selectionAfter === null)) &&
    (transaction.intent === undefined ||
      transaction.intent === "undo" ||
      transaction.intent === "redo") &&
    (
      transaction.changes.length > 0 ||
      transaction.selectionBefore !== null ||
      transaction.selectionAfter !== null
    )
  );
}

/** Parse an exact current-schema array; one malformed entry rejects the whole log. */
export function parseEditorTransactionArray(value: unknown): EditorTransaction[] {
  return Array.isArray(value) && value.every(isEditorTransaction) ? value : [];
}

export function parseEditorTransactionsFromContent(content: string): EditorTransaction[] {
  try {
    const parsed = JSON.parse(content) as { editorTransactions?: unknown };
    return parseEditorTransactionArray(parsed.editorTransactions);
  } catch {
    return [];
  }
}

function minimalTextChange(before: string, after: string): TextChange | null {
  if (before === after) return null;
  const maxPrefix = Math.min(before.length, after.length);
  let from = 0;
  while (from < maxPrefix && before[from] === after[from]) from += 1;
  let oldEnd = before.length;
  let newEnd = after.length;
  while (oldEnd > from && newEnd > from && before[oldEnd - 1] === after[newEnd - 1]) {
    oldEnd -= 1;
    newEnd -= 1;
  }
  const text = after.slice(from, newEnd);
  return {
    op: from === oldEnd ? "insert" : text === "" ? "delete" : "replace",
    from,
    to: oldEnd,
    text,
  };
}

/** Represent one observed non-editor transition without inventing selections. */
export function synthesizeEditorTransactionTransition(
  before: string,
  after: string,
  actor: string,
  timestamp = Date.now(),
  sequence = 0,
): EditorTransaction[] {
  const change = minimalTextChange(before, after);
  return change
    ? [{
        sequence,
        timestamp,
        actor,
        changes: [change],
        selectionBefore: null,
        selectionAfter: null,
      }]
    : [];
}

function selectionWithin(selection: EditorSelectionState, length: number): boolean {
  return selection.ranges.every((range) => range.anchor <= length && range.head <= length);
}

function selectionsEqual(left: EditorSelectionState, right: EditorSelectionState): boolean {
  return left.main === right.main &&
    left.ranges.length === right.ranges.length &&
    left.ranges.every((range, index) =>
      right.ranges[index]?.anchor === range.anchor &&
      right.ranges[index]?.head === range.head
    );
}

/** Validate and replay one node-local EditorTransaction log. */
export function validateEditorTransactionTransition(
  before: string,
  after: string,
  transactions: readonly EditorTransaction[],
): EditorTransactionTransitionValidation {
  let current = before;
  let previousSequence = -1;
  let previousSelectionAfter: EditorSelectionState | null = null;

  for (const transaction of transactions) {
    if (!isEditorTransaction(transaction)) {
      return { valid: false, reason: "malformed editor transaction" };
    }
    if (transaction.sequence <= previousSequence) {
      return { valid: false, reason: "editor transaction sequences are not strictly increasing" };
    }
    previousSequence = transaction.sequence;
    if (
      previousSelectionAfter &&
      transaction.selectionBefore &&
      !selectionsEqual(previousSelectionAfter, transaction.selectionBefore)
    ) {
      return {
        valid: false,
        reason: `transaction ${transaction.sequence} selection does not continue the prior post-state`,
      };
    }
    if (
      transaction.selectionBefore &&
      !selectionWithin(transaction.selectionBefore, current.length)
    ) {
      return {
        valid: false,
        reason: `transaction ${transaction.sequence} starts with a selection outside its pre-state`,
      };
    }

    const ordered = transaction.changes.map((change, index) => ({ change, index })).sort(
      (left, right) =>
        left.change.from - right.change.from ||
        left.change.to - right.change.to ||
        left.index - right.index,
    );
    let priorEnd = -1;
    for (const { change } of ordered) {
      if (change.to > current.length) {
        return {
          valid: false,
          reason: `transaction ${transaction.sequence} addresses text outside its pre-state`,
        };
      }
      if (change.from < priorEnd) {
        return {
          valid: false,
          reason: `transaction ${transaction.sequence} contains overlapping ranges`,
        };
      }
      const expected = change.from === change.to
        ? "insert"
        : change.text === ""
          ? "delete"
          : "replace";
      if (change.op !== expected) {
        return {
          valid: false,
          reason: `transaction ${transaction.sequence} has an inconsistent operation label`,
        };
      }
      priorEnd = change.to;
    }

    for (const { change } of [...ordered].sort(
      (left, right) =>
        right.change.from - left.change.from ||
        right.change.to - left.change.to ||
        right.index - left.index,
    )) {
      current = `${current.slice(0, change.from)}${change.text}${current.slice(change.to)}`;
    }
    if (
      transaction.selectionAfter &&
      !selectionWithin(transaction.selectionAfter, current.length)
    ) {
      return {
        valid: false,
        reason: `transaction ${transaction.sequence} ends with a selection outside its post-state`,
      };
    }
    previousSelectionAfter = transaction.selectionAfter;
  }

  return current === after
    ? { valid: true }
    : { valid: false, reason: "editor transactions do not reproduce the signed snapshot" };
}

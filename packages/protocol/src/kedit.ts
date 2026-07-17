/** Semantic editor history action attached to one replayable transaction. */
export type KEditIntent = "undo" | "redo";

/** One UTF-16 range in a discrete editor transaction. */
export interface KEdit {
  op: "ins" | "del" | "repl";
  from: number;
  to: number;
  text: string;
  voice: string;
  t: number;
  tx: number;
  intent?: KEditIntent;
}

export interface KEditTransitionValidation {
  valid: boolean;
  reason?: string;
}

export function isKEdit(value: unknown): value is KEdit {
  if (!value || typeof value !== "object") return false;
  const edit = value as Partial<KEdit>;
  return (
    (edit.op === "ins" || edit.op === "del" || edit.op === "repl") &&
    Number.isInteger(edit.from) &&
    Number.isInteger(edit.to) &&
    (edit.from as number) >= 0 &&
    (edit.to as number) >= (edit.from as number) &&
    typeof edit.text === "string" &&
    typeof edit.voice === "string" &&
    Number.isFinite(edit.t) &&
    Number.isInteger(edit.tx) &&
    (edit.tx as number) >= 0 &&
    (edit.intent === undefined || edit.intent === "undo" || edit.intent === "redo")
  );
}

export function parseKEditArray(value: unknown): KEdit[] {
  return Array.isArray(value) ? value.filter(isKEdit) : [];
}

export function parseKEditsFromContent(content: string): KEdit[] {
  try {
    const parsed = JSON.parse(content) as { kedits?: unknown };
    return parseKEditArray(parsed.kedits);
  } catch {
    return [];
  }
}

export function groupKEditsByTransaction(kedits: readonly KEdit[]): KEdit[][] {
  const groups: KEdit[][] = [];
  for (const edit of kedits) {
    const previous = groups[groups.length - 1];
    if (previous && previous[0]?.tx === edit.tx) previous.push(edit);
    else groups.push([edit]);
  }
  return groups;
}

function minimalTextChange(before: string, after: string): { from: number; to: number; insert: string } | null {
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
  return { from, to: oldEnd, insert: after.slice(from, newEnd) };
}

export function synthesizeKEditTransition(
  before: string,
  after: string,
  voice: string,
  t = Date.now(),
  tx = 0,
): KEdit[] {
  const change = minimalTextChange(before, after);
  if (!change) return [];
  return [{
    op: change.from === change.to ? "ins" : change.insert === "" ? "del" : "repl",
    from: change.from,
    to: change.to,
    text: change.insert,
    voice,
    t,
    tx,
  }];
}

/** Validate and replay one node-local KEdit log against its signed transition. */
export function validateKEditTransition(
  before: string,
  after: string,
  kedits: readonly KEdit[],
): KEditTransitionValidation {
  let current = before;
  let cursor = 0;
  let previousTx = -1;

  while (cursor < kedits.length) {
    const first = kedits[cursor];
    if (!isKEdit(first)) return { valid: false, reason: "malformed KEdit entry" };
    if (first.tx <= previousTx) {
      return { valid: false, reason: "transaction ids are not strictly increasing" };
    }
    previousTx = first.tx;

    const group: { edit: KEdit; index: number }[] = [];
    while (cursor < kedits.length && kedits[cursor]?.tx === first.tx) {
      const edit = kedits[cursor];
      if (!isKEdit(edit)) return { valid: false, reason: "malformed KEdit entry" };
      if (edit.t !== first.t) {
        return { valid: false, reason: `transaction ${first.tx} has inconsistent timestamps` };
      }
      if (edit.intent !== first.intent) {
        return { valid: false, reason: `transaction ${first.tx} has inconsistent history intent` };
      }
      group.push({ edit, index: group.length });
      cursor += 1;
    }

    const ordered = [...group].sort(
      (left, right) => left.edit.from - right.edit.from || left.edit.to - right.edit.to || left.index - right.index,
    );
    let priorEnd = -1;
    for (const { edit } of ordered) {
      if (edit.to > current.length) {
        return { valid: false, reason: `transaction ${first.tx} addresses text outside its pre-state` };
      }
      if (edit.from < priorEnd) {
        return { valid: false, reason: `transaction ${first.tx} contains overlapping ranges` };
      }
      const expectedOp = edit.from === edit.to ? "ins" : edit.text === "" ? "del" : "repl";
      if (edit.op !== expectedOp) {
        return { valid: false, reason: `transaction ${first.tx} has an inconsistent operation label` };
      }
      priorEnd = edit.to;
    }

    const descending = [...group].sort(
      (left, right) => right.edit.from - left.edit.from || right.edit.to - left.edit.to || right.index - left.index,
    );
    for (const { edit } of descending) {
      current = `${current.slice(0, edit.from)}${edit.text}${current.slice(edit.to)}`;
    }
  }

  return current === after
    ? { valid: true }
    : { valid: false, reason: "editor transactions do not reproduce the signed snapshot" };
}

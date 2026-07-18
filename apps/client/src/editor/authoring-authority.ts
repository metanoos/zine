import type { AuthoritySpanV1 } from "@zine/trace-context";

/**
 * Local-only editor evidence for the trace-authoring adapter.
 *
 * This Wave 1 state intentionally lives only in the mounted CodeMirror view.
 * Reload, tab repopulation, move, import, and any unannotated dispatch reset or
 * create ineligible bytes. A Step does not serialize or rekey this state; the
 * map survives only while the same mounted editor state survives. It is not
 * KEdit provenance, is not written into Runs, and makes no durable persistence
 * or consumption claim.
 */
export const EDITOR_AUTHORITY_VERSION = 1;

export type EditorAuthorityOrigin =
  | "manual"
  | "paste"
  | "drop"
  | "model"
  | "undo-redo"
  | "unknown";

export interface EditorAuthoritySpan extends AuthoritySpanV1 {
  origin: EditorAuthorityOrigin;
}

export interface EditorAuthorityState {
  version: 1;
  persistence: "current-editor-session-only";
  nextOrdinal: number;
  spans: readonly EditorAuthoritySpan[];
}

export interface EditorAuthorityChange {
  fromA: number;
  toA: number;
  fromB: number;
  toB: number;
}

export interface EditorTransactionSignals {
  model: boolean;
  paste: boolean;
  drop: boolean;
  manualType: boolean;
  undoRedo: boolean;
}

export function classifyEditorTransaction(
  signals: EditorTransactionSignals,
): EditorAuthorityOrigin {
  if (signals.model) return "model";
  if (signals.paste) return "paste";
  if (signals.drop) return "drop";
  if (signals.undoRedo) return "undo-redo";
  if (signals.manualType) return "manual";
  return "unknown";
}

export function createEditorAuthorityState(docLength: number): EditorAuthorityState {
  return {
    version: EDITOR_AUTHORITY_VERSION,
    persistence: "current-editor-session-only",
    nextOrdinal: 2,
    spans: docLength > 0
      ? [{
          id: "editor-authority-v1:1",
          actorId: "",
          origin: "unknown",
          instructionEligible: false,
          fromUtf16: 0,
          toUtf16: docLength,
        }]
      : [],
  };
}

/** Programmatic document replacement/reload fails closed over the whole body. */
export function resetEditorAuthorityState(
  previous: EditorAuthorityState,
  docLength: number,
): EditorAuthorityState {
  const ordinal = previous.nextOrdinal;
  return {
    version: EDITOR_AUTHORITY_VERSION,
    persistence: "current-editor-session-only",
    nextOrdinal: ordinal + 1,
    spans: docLength > 0
      ? [{
          id: `editor-authority-v1:${ordinal}`,
          actorId: "",
          origin: "unknown",
          instructionEligible: false,
          fromUtf16: 0,
          toUtf16: docLength,
        }]
      : [],
  };
}

/**
 * Map prior authority through one CodeMirror change set and classify every
 * inserted range from transaction metadata. Unknown and restored bytes remain
 * represented, but ineligible, so the kernel can explain why they stayed data.
 */
export function applyEditorAuthorityChanges(
  previous: EditorAuthorityState,
  changes: readonly EditorAuthorityChange[],
  origin: EditorAuthorityOrigin,
  actorId: string,
): EditorAuthorityState {
  if (changes.length === 0) return previous;
  const ordered = [...changes].sort((left, right) => left.fromA - right.fromA);
  const retained: EditorAuthoritySpan[] = [];

  for (const span of previous.spans) {
    let cursor = span.fromUtf16;
    let part = 0;
    for (const change of ordered) {
      if (change.toA < cursor || change.fromA > span.toUtf16) continue;
      const beforeEnd = Math.min(change.fromA, span.toUtf16);
      if (beforeEnd > cursor) {
        retained.push({
          ...span,
          id: `${span.id}:part-${part++}`,
          fromUtf16: mapOldPosition(ordered, cursor, 1),
          toUtf16: mapOldPosition(ordered, beforeEnd, -1),
        });
      }
      if (change.fromA === change.toA) {
        // A zero-width insertion splits the old span without consuming it.
        cursor = Math.max(cursor, change.fromA);
      } else {
        cursor = Math.max(cursor, change.toA);
      }
      if (cursor >= span.toUtf16) break;
    }
    if (cursor < span.toUtf16) {
      retained.push({
        ...span,
        id: `${span.id}:part-${part}`,
        fromUtf16: mapOldPosition(ordered, cursor, 1),
        toUtf16: mapOldPosition(ordered, span.toUtf16, -1),
      });
    }
  }

  let nextOrdinal = previous.nextOrdinal;
  for (const change of ordered) {
    if (change.toB <= change.fromB) continue;
    retained.push({
      id: `editor-authority-v1:${nextOrdinal++}`,
      actorId,
      origin,
      instructionEligible: origin === "manual" && actorId.length > 0,
      fromUtf16: change.fromB,
      toUtf16: change.toB,
    });
  }

  return {
    version: EDITOR_AUTHORITY_VERSION,
    persistence: "current-editor-session-only",
    nextOrdinal,
    spans: normalizeSpans(retained),
  };
}

function mapOldPosition(
  changes: readonly EditorAuthorityChange[],
  position: number,
  assoc: -1 | 1,
): number {
  let delta = 0;
  for (const change of changes) {
    if (position < change.fromA) return position + delta;
    if (position === change.fromA) return assoc < 0 ? change.fromB : change.toB;
    if (position < change.toA) return assoc < 0 ? change.fromB : change.toB;
    if (position === change.toA) return assoc < 0 ? change.fromB : change.toB;
    delta = change.toB - change.toA;
  }
  return position + delta;
}

function normalizeSpans(spans: readonly EditorAuthoritySpan[]): EditorAuthoritySpan[] {
  const ordered = spans
    .filter((span) => span.toUtf16 > span.fromUtf16)
    .sort((left, right) => left.fromUtf16 - right.fromUtf16 || left.toUtf16 - right.toUtf16);
  const normalized: EditorAuthoritySpan[] = [];
  for (const span of ordered) {
    const previous = normalized[normalized.length - 1];
    if (
      previous &&
      previous.toUtf16 === span.fromUtf16 &&
      previous.actorId === span.actorId &&
      previous.origin === span.origin &&
      previous.instructionEligible === span.instructionEligible
    ) {
      normalized[normalized.length - 1] = { ...previous, toUtf16: span.toUtf16 };
    } else {
      normalized.push(span);
    }
  }
  return normalized;
}

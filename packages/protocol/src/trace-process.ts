import type { ProtocolEvent } from "./event.js";

import {
  parseEditorTransactionsFromContent,
  validateEditorTransactionTransition,
  type EditorTransactionIntent,
  type EditorSelectionState,
} from "./editor-transaction.js";

export interface TraceProcessChange {
  op: "insert" | "delete" | "replace";
  from: number;
  to: number;
  inserted: string;
  deleted: string;
  actor: string;
}

export interface TraceProcessTransaction {
  sequence: number;
  timestamp: number;
  intent?: EditorTransactionIntent;
  selectionBefore: EditorSelectionState | null;
  selectionAfter: EditorSelectionState | null;
  changes: TraceProcessChange[];
}

export interface TraceProcessView {
  status: "complete" | "absent" | "invalid";
  transactions: TraceProcessTransaction[];
  reason?: string;
}

export interface TraceProcessLogStep {
  seq: number;
  nodeId?: string;
  steppedAt: number;
  relativePath: string;
  process?: TraceProcessView;
  conformance?: import("./trace-conformance.js").TraceConformanceStatus;
  conformanceReason?: string;
}

export interface TraceProcessSummary {
  transactions: number;
  ranges: number;
  inserted: number;
  deleted: number;
  firstAt: number | null;
  lastAt: number | null;
  spanMs: number;
  longestGapMs: number;
  undo: number;
  redo: number;
}

function invalid(reason: string): TraceProcessView {
  return { status: "invalid", transactions: [], reason };
}

function processEditorTransactions(
  event: ProtocolEvent,
  previousSnapshot: string,
  snapshot: string,
  raw: unknown[],
): TraceProcessView {
  if (raw.length === 0) {
    return snapshot === previousSnapshot
      ? { status: "complete", transactions: [] }
      : invalid("an empty editor transaction log cannot change the signed snapshot");
  }

  const editorTransactions = parseEditorTransactionsFromContent(event.content);
  if (editorTransactions.length !== raw.length) {
    return invalid("one or more editor transactions are malformed");
  }
  const validation = validateEditorTransactionTransition(
    previousSnapshot,
    snapshot,
    editorTransactions,
  );
  if (!validation.valid) return invalid(validation.reason ?? "editor transaction log is invalid");

  let current = previousSnapshot;
  const transactions: TraceProcessTransaction[] = [];
  for (const transaction of editorTransactions) {
    const ordered = transaction.changes.map((change, index) => ({ change, index })).sort(
      (left, right) =>
        left.change.from - right.change.from ||
        left.change.to - right.change.to ||
        left.index - right.index,
    );
    const changes: TraceProcessChange[] = [];
    for (const { change } of ordered) {
      changes.push({
        op: change.op,
        from: change.from,
        to: change.to,
        inserted: change.text,
        deleted: current.slice(change.from, change.to),
        actor: transaction.actor,
      });
    }

    // CodeMirror multi-range offsets share one pre-transaction coordinate
    // space. Apply right-to-left so earlier offsets remain stable.
    for (let index = changes.length - 1; index >= 0; index -= 1) {
      const change = changes[index];
      current = `${current.slice(0, change.from)}${change.inserted}${current.slice(change.to)}`;
    }
    transactions.push({
      sequence: transaction.sequence,
      timestamp: transaction.timestamp,
      ...(transaction.intent ? { intent: transaction.intent } : {}),
      selectionBefore: transaction.selectionBefore,
      selectionAfter: transaction.selectionAfter,
      changes,
    });
  }
  return { status: "complete", transactions };
}

/** Recover the mandatory EditorTransaction process log. */
export function traceProcessFromEvent(
  event: ProtocolEvent,
  previousSnapshot: string,
): TraceProcessView {
  let parsed: {
    snapshot?: unknown;
    editorTransactions?: unknown;
  };
  try {
    parsed = JSON.parse(event.content) as typeof parsed;
  } catch {
    return invalid("node content is not valid JSON");
  }
  if (typeof parsed.snapshot !== "string") {
    return invalid("node has no signed text snapshot");
  }
  if (Object.prototype.hasOwnProperty.call(parsed, "editorTransactions")) {
    return Array.isArray(parsed.editorTransactions)
      ? processEditorTransactions(
          event,
          previousSnapshot,
          parsed.snapshot,
          parsed.editorTransactions,
        )
      : invalid("file Step editor transaction log is not an array");
  }
  return invalid("file Step is missing its required EditorTransaction log");
}

function charCount(value: string): number {
  return [...value].length;
}

export function summarizeTraceProcess(process: TraceProcessView): TraceProcessSummary {
  const transactions = process.status === "complete" ? process.transactions : [];
  const times = transactions.map((transaction) => transaction.timestamp).sort((left, right) => left - right);
  let longestGapMs = 0;
  for (let index = 1; index < times.length; index += 1) {
    longestGapMs = Math.max(longestGapMs, Math.max(0, times[index] - times[index - 1]));
  }
  const changes = transactions.flatMap((transaction) => transaction.changes);
  const firstAt = times[0] ?? null;
  const lastAt = times.length > 0 ? times[times.length - 1] : null;
  return {
    transactions: transactions.length,
    ranges: changes.length,
    inserted: changes.reduce((total, change) => total + charCount(change.inserted), 0),
    deleted: changes.reduce((total, change) => total + charCount(change.deleted), 0),
    firstAt,
    lastAt,
    spanMs: firstAt === null || lastAt === null ? 0 : Math.max(0, lastAt - firstAt),
    longestGapMs,
    undo: transactions.filter((transaction) => transaction.intent === "undo").length,
    redo: transactions.filter((transaction) => transaction.intent === "redo").length,
  };
}

function formatDuration(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${Math.round(ms / 1_000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.round(ms / 3_600_000)}h`;
}

/** Compact mechanical observations embedded beside every Step in AI context. */
export function renderTraceProcessSummary(process: TraceProcessView | undefined): string {
  if (!process || process.status === "absent") return "";
  if (process.status === "invalid") {
    return `snapshot only — ${process.reason ?? "could not validate editor transactions"}`;
  }
  const summary = summarizeTraceProcess(process);
  const history = [
    summary.undo > 0 ? `undo ${summary.undo}` : "",
    summary.redo > 0 ? `redo ${summary.redo}` : "",
  ].filter(Boolean);
  return [
    `trace ${summary.transactions} transactions / ${summary.ranges} ranges`,
    `+${summary.inserted}/−${summary.deleted}`,
    `span ${formatDuration(summary.spanMs)}`,
    `longest gap ${formatDuration(summary.longestGapMs)}`,
    ...history,
  ].join(" · ");
}

function isoTime(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * Render exact validated editor transactions for Analyze. Evidence anchors use
 * the directory-log Step sequence plus a transaction ordinal (`[#4.2]`). The
 * containing review separately cites the exact source node ids.
 */
export function renderTraceProcessLog(steps: readonly TraceProcessLogStep[]): string {
  const ordered = [...steps].sort((left, right) =>
    left.steppedAt - right.steppedAt ||
    left.relativePath.localeCompare(right.relativePath) ||
    left.seq - right.seq);
  const complete = ordered.filter(
    (step) => step.process?.status === "complete" && step.conformance !== "invalid",
  );
  const invalidArtifacts = ordered.filter((step) => step.conformance === "invalid");
  const snapshotOnlySteps = ordered.filter((step) => step.process?.status === "invalid");
  const missing = ordered.filter((step) => !step.process || step.process.status === "absent").length;
  const transactionCount = complete.reduce(
    (total, step) => total + (step.process?.transactions.length ?? 0),
    0,
  );
  const lines = [
    `--- trace process log: ${transactionCount} transactions across ${complete.length} Full Trace Steps; ${missing} missing; ${snapshotOnlySteps.length} snapshot-only; ${invalidArtifacts.length} invalid artifacts ---`,
  ];
  if (
    transactionCount === 0 &&
    snapshotOnlySteps.length === 0 &&
    invalidArtifacts.length === 0
  ) {
    lines.push("(no high-resolution editor transactions are present in the analyzed Steps)");
    return lines.join("\n");
  }

  for (const step of invalidArtifacts) {
    lines.push(
      `[#${step.seq}] ${step.relativePath} · node ${step.nodeId ?? "unknown"} · INVALID: ${step.conformanceReason ?? "signed-artifact integrity or lineage failed"} · process excluded`,
    );
  }

  for (const step of snapshotOnlySteps) {
    if (step.conformance === "invalid") continue;
    lines.push(
      `[#${step.seq}] ${step.relativePath} · node ${step.nodeId ?? "unknown"} · SNAPSHOT ONLY: ${step.process?.reason ?? "process validation failed"}`,
    );
  }

  // Interleave transactions from different files by their captured editor
  // time. The anchor retains the containing Step and original transaction
  // ordinal, while this global order makes cross-file timing evidence legible.
  const transactions = complete.flatMap((step) =>
    step.process!.transactions.map((transaction, transactionIndex) => ({
      step,
      transaction,
      transactionIndex,
    })),
  ).sort((left, right) =>
    left.transaction.timestamp - right.transaction.timestamp ||
    left.step.relativePath.localeCompare(right.step.relativePath) ||
    left.step.seq - right.step.seq ||
    left.transactionIndex - right.transactionIndex);

  let priorTimestamp: number | null = null;
  for (const { step, transaction, transactionIndex } of transactions) {
    const gap = priorTimestamp === null
      ? ""
      : ` · Δ${formatDuration(Math.max(0, transaction.timestamp - priorTimestamp))}`;
    const actors = [...new Set(transaction.changes.map((change) => change.actor))].join(", ");
    const intent = transaction.intent ? ` · ${transaction.intent}` : "";
    lines.push(
      `[#${step.seq}.${transactionIndex + 1}] ${isoTime(transaction.timestamp)}${gap} · ${step.relativePath} · node ${step.nodeId ?? "unknown"} · transaction ${transaction.sequence} · actor ${actors || "unknown"}${intent}`,
    );
    for (const change of transaction.changes) {
      if (change.deleted) {
        lines.push(`      − ${change.from}:${change.to} ${JSON.stringify(change.deleted)}`);
      }
      if (change.inserted) {
        lines.push(`      + ${change.from}:${change.to} ${JSON.stringify(change.inserted)}`);
      }
    }
    priorTimestamp = transaction.timestamp;
  }
  return lines.join("\n");
}

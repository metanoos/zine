import type { ProtocolEvent } from "./event.js";

import {
  groupKEditsByTransaction,
  parseKEditsFromContent,
  type KEditIntent,
} from "./kedit.js";

export interface TraceProcessChange {
  op: "ins" | "del" | "repl";
  from: number;
  to: number;
  inserted: string;
  deleted: string;
  voice: string;
}

export interface TraceProcessTransaction {
  tx: number;
  at: number;
  intent?: KEditIntent;
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

function expectedOp(from: number, to: number, text: string): TraceProcessChange["op"] {
  return from === to ? "ins" : text === "" ? "del" : "repl";
}

/**
 * Recover the exact editor transactions carried by one Step. The result is
 * usable only when the complete KEdit sequence reproduces the signed snapshot;
 * invalid logs fail closed instead of yielding a persuasive partial process.
 */
export function traceProcessFromEvent(
  event: ProtocolEvent,
  previousSnapshot: string,
): TraceProcessView {
  let parsed: { snapshot?: unknown; kedits?: unknown };
  try {
    parsed = JSON.parse(event.content) as typeof parsed;
  } catch {
    return invalid("node content is not valid JSON");
  }
  if (typeof parsed.snapshot !== "string") {
    return invalid("node has no signed text snapshot");
  }
  if (!Array.isArray(parsed.kedits)) {
    return invalid("file Step is missing its required KEdit log");
  }
  if (parsed.kedits.length === 0) {
    return parsed.snapshot === previousSnapshot
      ? { status: "complete", transactions: [] }
      : invalid("an empty KEdit log cannot change the signed snapshot");
  }

  const kedits = parseKEditsFromContent(event.content);
  if (kedits.length !== parsed.kedits.length) {
    return invalid("one or more KEdit entries are malformed");
  }

  let current = previousSnapshot;
  const transactions: TraceProcessTransaction[] = [];
  let previousTx = -1;
  for (const group of groupKEditsByTransaction(kedits)) {
    const first = group[0];
    if (!first) return invalid("empty KEdit transaction");
    if (first.tx <= previousTx) {
      return invalid("KEdit transaction ids are not strictly increasing");
    }
    previousTx = first.tx;
    if (group.some((edit) => edit.t !== first.t)) {
      return invalid(`transaction ${first.tx} has inconsistent timestamps`);
    }
    if (group.some((edit) => edit.intent !== first.intent)) {
      return invalid(`transaction ${first.tx} has inconsistent history intent`);
    }
    if (group.some((edit) => edit.tx !== first.tx)) {
      return invalid("non-atomic transaction grouping");
    }

    const ordered = [...group].sort((left, right) => left.from - right.from || left.to - right.to);
    let priorEnd = -1;
    const changes: TraceProcessChange[] = [];
    for (const edit of ordered) {
      if (edit.to > current.length) {
        return invalid(`transaction ${first.tx} addresses text outside its pre-state`);
      }
      if (edit.from < priorEnd) {
        return invalid(`transaction ${first.tx} contains overlapping ranges`);
      }
      if (edit.op !== expectedOp(edit.from, edit.to, edit.text)) {
        return invalid(`transaction ${first.tx} has an inconsistent operation label`);
      }
      priorEnd = edit.to;
      changes.push({
        op: edit.op,
        from: edit.from,
        to: edit.to,
        inserted: edit.text,
        deleted: current.slice(edit.from, edit.to),
        voice: edit.voice,
      });
    }

    // CodeMirror multi-range offsets share one pre-transaction coordinate
    // space. Apply right-to-left so earlier offsets remain stable.
    for (let index = changes.length - 1; index >= 0; index -= 1) {
      const change = changes[index];
      current = `${current.slice(0, change.from)}${change.inserted}${current.slice(change.to)}`;
    }
    transactions.push({
      tx: first.tx,
      at: first.t,
      ...(first.intent ? { intent: first.intent } : {}),
      changes,
    });
  }

  if (current !== parsed.snapshot) {
    return invalid("editor transactions do not reproduce the signed snapshot");
  }
  return { status: "complete", transactions };
}

function charCount(value: string): number {
  return [...value].length;
}

export function summarizeTraceProcess(process: TraceProcessView): TraceProcessSummary {
  const transactions = process.status === "complete" ? process.transactions : [];
  const times = transactions.map((transaction) => transaction.at).sort((left, right) => left - right);
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
    `trace ${summary.transactions} tx / ${summary.ranges} ranges`,
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
 * Render exact validated KEdit transactions for Analyze. Evidence anchors use
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
    left.transaction.at - right.transaction.at ||
    left.step.relativePath.localeCompare(right.step.relativePath) ||
    left.step.seq - right.step.seq ||
    left.transactionIndex - right.transactionIndex);

  let priorAt: number | null = null;
  for (const { step, transaction, transactionIndex } of transactions) {
    const gap = priorAt === null ? "" : ` · Δ${formatDuration(Math.max(0, transaction.at - priorAt))}`;
    const voices = [...new Set(transaction.changes.map((change) => change.voice))].join(", ");
    const intent = transaction.intent ? ` · ${transaction.intent}` : "";
    lines.push(
      `[#${step.seq}.${transactionIndex + 1}] ${isoTime(transaction.at)}${gap} · ${step.relativePath} · node ${step.nodeId ?? "unknown"} · tx ${transaction.tx} · voice ${voices || "unknown"}${intent}`,
    );
    for (const change of transaction.changes) {
      if (change.deleted) {
        lines.push(`      − ${change.from}:${change.to} ${JSON.stringify(change.deleted)}`);
      }
      if (change.inserted) {
        lines.push(`      + ${change.from}:${change.to} ${JSON.stringify(change.inserted)}`);
      }
    }
    priorAt = transaction.at;
  }
  return lines.join("\n");
}

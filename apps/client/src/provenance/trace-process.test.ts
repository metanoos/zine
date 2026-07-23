import assert from "node:assert/strict";
import test from "node:test";
import type { Event } from "nostr-tools";

import {
  renderTraceProcessLog,
  renderTraceProcessSummary,
  summarizeTraceProcess,
  traceProcessFromEvent,
} from "./trace-process.js";
import type { EditorTransaction } from "./provenance.js";

const voice = "a".repeat(64);

function event(snapshot: string, editorTransactions?: EditorTransaction[]): Event {
  return {
    id: "b".repeat(64),
    pubkey: voice,
    created_at: 2,
    kind: 4290,
    tags: [["action", "edit"]],
    content: JSON.stringify({ snapshot, ...(editorTransactions ? { editorTransactions } : {}) }),
    sig: "c".repeat(128),
  };
}

function edit(
  sequence: number,
  from: number,
  to: number,
  text: string,
  t: number,
  intent?: "undo" | "redo",
): EditorTransaction {
  return {
    sequence,
    timestamp: t,
    actor: voice,
    changes: [{
      op: from === to ? "insert" : text === "" ? "delete" : "replace",
      from,
      to,
      text,
    }],
    selectionBefore: null,
    selectionAfter: null,
    ...(intent ? { intent } : {}),
  };
}

test("recovers intermediate text that the signed snapshot no longer contains", () => {
  const process = traceProcessFromEvent(event("final", [
    edit(0, 0, 0, "draft", 1_000),
    edit(1, 0, 5, "final", 3_000),
  ]), "");
  assert.equal(process.status, "complete");
  assert.equal(process.transactions[1].changes[0].deleted, "draft");
  assert.equal(process.transactions[1].changes[0].inserted, "final");
  assert.match(renderTraceProcessSummary(process), /2 transactions \/ 2 ranges · \+10\/−5/);
});

test("applies multi-range transactions atomically against one pre-state", () => {
  const first = edit(7, 0, 1, "A", 1_000);
  const second = edit(7, 3, 4, "D", 1_000);
  const process = traceProcessFromEvent(event("AbcD", [
    { ...first, changes: [...first.changes, ...second.changes] },
  ]), "abcd");
  assert.equal(process.status, "complete");
  assert.deepEqual(
    process.transactions[0].changes.map((change) => change.deleted),
    ["a", "d"],
  );
});

test("fails closed when the editor log does not reproduce the signed snapshot", () => {
  const process = traceProcessFromEvent(event("signed", [edit(0, 0, 0, "other", 1_000)]), "");
  assert.equal(process.status, "invalid");
  assert.match(process.reason ?? "", /do not reproduce/);
  assert.equal(process.transactions.length, 0);
});

test("fails closed when transaction ids are reused out of sequence", () => {
  const process = traceProcessFromEvent(event("abc", [
    edit(1, 0, 0, "a", 1_000),
    edit(2, 1, 1, "b", 2_000),
    edit(1, 2, 2, "c", 3_000),
  ]), "");
  assert.equal(process.status, "invalid");
  assert.match(process.reason ?? "", /strictly increasing/);
});

test("summaries remain mechanical and preserve undo, redo, span, and gaps", () => {
  const process = traceProcessFromEvent(event("ab", [
    edit(0, 0, 0, "a", 1_000),
    edit(1, 1, 1, "b", 11_000, "undo"),
    edit(2, 2, 2, "c", 12_000, "redo"),
    edit(3, 2, 3, "", 13_000),
  ]), "");
  const summary = summarizeTraceProcess(process);
  assert.deepEqual(
    { transactions: summary.transactions, ranges: summary.ranges, undo: summary.undo, redo: summary.redo },
    { transactions: 4, ranges: 4, undo: 1, redo: 1 },
  );
  assert.equal(summary.spanMs, 12_000);
  assert.equal(summary.longestGapMs, 10_000);
});

test("exact Analyze log carries stable evidence anchors, node ids, actors, and deleted text", () => {
  const process = traceProcessFromEvent(event("final", [
    edit(0, 0, 0, "draft", 1_000),
    edit(1, 0, 5, "final", 3_000),
  ]), "");
  const log = renderTraceProcessLog([{
    seq: 4,
    nodeId: "node-4",
    steppedAt: 4_000,
    relativePath: "essay.md",
    process,
  }]);
  assert.match(log, /\[#4\.2\]/);
  assert.match(log, /node node-4/);
  assert.match(log, new RegExp(`actor ${voice}`));
  assert.match(log, /− 0:5 "draft"/);
  assert.match(log, /\+ 0:5 "final"/);
});

test("Analyze interleaves transactions from different Steps by captured editor time", () => {
  const early = traceProcessFromEvent(event("early", [edit(0, 0, 0, "early", 1_000)]), "");
  const late = traceProcessFromEvent(event("late", [edit(0, 0, 0, "late", 3_000)]), "");
  const log = renderTraceProcessLog([
    { seq: 1, steppedAt: 2_000, relativePath: "late-step.md", process: late },
    { seq: 2, steppedAt: 4_000, relativePath: "early-work.md", process: early },
  ]);
  assert.ok(log.indexOf("[#2.1]") < log.indexOf("[#1.1]"));
  assert.match(log, /\[#1\.1\].*Δ2s/);
});

test("a file Step without editor transactions is nonconforming", () => {
  const process = traceProcessFromEvent(event("imported"), "");
  assert.equal(process.status, "invalid");
  const log = renderTraceProcessLog([{
    seq: 1,
    nodeId: "node-1",
    steppedAt: 1,
    relativePath: "import.md",
    process,
  }]);
  assert.match(log, /0 missing; 1 snapshot-only/);
  assert.match(log, /SNAPSHOT ONLY/);
  assert.match(log, /missing its required EditorTransaction log/);
});

test("an explicit empty EditorTransaction log is complete only for an unchanged Step", () => {
  assert.equal(traceProcessFromEvent(event("same", []), "same").status, "complete");
  assert.equal(traceProcessFromEvent(event("changed", []), "before").status, "invalid");
});

test("Analyze excludes process transactions from an invalid signed artifact", () => {
  const process = traceProcessFromEvent(
    event("draft", [edit(0, 0, 0, "draft", 1_000)]),
    "",
  );
  const log = renderTraceProcessLog([{
    seq: 3,
    nodeId: "bad-node",
    steppedAt: 2_000,
    relativePath: "draft.md",
    process,
    conformance: "invalid",
    conformanceReason: "event id or signature is invalid",
  }]);
  assert.match(log, /INVALID: event id or signature is invalid · process excluded/);
  assert.doesNotMatch(log, /\[#3\.1\]/);
});

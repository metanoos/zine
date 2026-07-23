import assert from "node:assert/strict";
import test from "node:test";

import { restoreCrashPadFile } from "./crash-pad-restore.js";
import type { LocalFile } from "./local-store.js";
import {
  appendEditorTransactionLog,
  editorTransactionLogToArray,
  validateEditorTransactionTransition,
  type FileState,
} from "./workspace-core.js";

const VOICE = "a".repeat(64);
const RECOVERY_VOICE = "b".repeat(64);

function transaction(
  from: number,
  to: number,
  text: string,
  actor: string,
  timestamp: number,
  sequence: number,
) {
  return {
    sequence,
    timestamp,
    actor,
    changes: [{
      op: from === to ? "insert" as const : text === "" ? "delete" as const : "replace" as const,
      from,
      to,
      text,
    }],
    selectionBefore: null,
    selectionAfter: null,
  };
}

test("a crash-pad overlay preserves the stepped trace identity", () => {
  const existing: FileState = {
    runs: [{ voice: VOICE, text: "stepped" }],
    nodeId: "head-1",
    traceId: "genesis-1",
    tags: [],
  };
  const pad: LocalFile = {
    kind: "file",
    content: "stepped plus draft",
    runs: [{ voice: VOICE, text: "stepped plus draft" }],
    nodeId: "head-1",
    tags: [],
    updatedAt: 2,
  };

  const restored = restoreCrashPadFile(existing, pad, VOICE, RECOVERY_VOICE);
  assert.equal(restored.nodeId, "head-1");
  assert.equal(restored.traceId, "genesis-1");
});

test("a stale crash-pad head cannot replace the freshly scanned signed head", () => {
  const existing: FileState = {
    runs: [{ voice: VOICE, text: "stepped twice" }],
    nodeId: "head-2",
    traceId: "genesis-1",
    tags: [],
  };
  const pad: LocalFile = {
    kind: "file",
    content: "stepped twice plus newer draft",
    runs: [{ voice: VOICE, text: "stepped twice plus newer draft" }],
    nodeId: "head-1",
    traceId: "genesis-1",
    tags: [],
    updatedAt: 3,
  };

  const restored = restoreCrashPadFile(existing, pad, VOICE, RECOVERY_VOICE);
  assert.equal(restored.nodeId, "head-2");
  assert.equal(restored.traceId, "genesis-1");
  assert.equal(restored.runs.map((run) => run.text).join(""), pad.content);
});

test("recovery synthesis uses the reconciler identity instead of guessing from mixed runs", () => {
  const existing: FileState = {
    runs: [{ voice: VOICE, text: "author text" }],
    nodeId: "head-1",
    traceId: "genesis-1",
    tags: [],
  };
  const modelVoice = "c".repeat(64);
  const pad: LocalFile = {
    kind: "file",
    content: "author text model text",
    runs: [
      { voice: VOICE, text: "author text " },
      { voice: modelVoice, text: "model text" },
    ],
    nodeId: "head-1",
    tags: [],
    updatedAt: 4,
    editorTransactions: [transaction(999, 999, "model text", modelVoice, 3, 0)],
  };

  const restored = restoreCrashPadFile(existing, pad, VOICE, RECOVERY_VOICE);
  const transactions = editorTransactionLogToArray(restored.editorTransactions);
  assert.equal(transactions.length, 1);
  assert.equal(transactions[0]?.actor, RECOVERY_VOICE);
  assert.notEqual(transactions[0]?.actor, restored.runs[0]?.voice);
});

test("recovery validates an alternate-voice journal against the signed head, not a staged local body", () => {
  const stagedBody = "draft body";
  const alternateVoice = "c".repeat(64);
  const existing: FileState = {
    // A failed Step already staged the draft in the local-primary record, but
    // nodeId still identifies an empty signed snapshot.
    runs: [{ voice: VOICE, text: stagedBody }],
    nodeId: "signed-empty-head",
    tags: [],
    updatedAt: 2,
  };
  const pad: LocalFile = {
    kind: "file",
    content: stagedBody,
    runs: [{ voice: VOICE, text: stagedBody }],
    nodeId: "signed-empty-head",
    tags: [],
    updatedAt: 2,
    editorTransactions: [transaction(0, 0, stagedBody, VOICE, 1, 0)],
  };

  const restored = restoreCrashPadFile(
    existing,
    pad,
    VOICE,
    RECOVERY_VOICE,
    { steppedSnapshot: "" },
  );
  const restoredLog = editorTransactionLogToArray(restored.editorTransactions);
  assert.deepEqual(restoredLog, pad.editorTransactions);

  const afterAlternateEdit = appendEditorTransactionLog(restored.editorTransactions!, [
    transaction(stagedBody.length, stagedBody.length, "!", alternateVoice, 2, 1),
  ]);
  assert.deepEqual(
    validateEditorTransactionTransition("", `${stagedBody}!`, editorTransactionLogToArray(afterAlternateEdit)),
    { valid: true },
  );
});

import assert from "node:assert/strict";
import test from "node:test";

import { restoreCrashPadFile } from "./crash-pad-restore.js";
import type { LocalFile } from "./local-store.js";
import { keditLogToArray, type FileState } from "./workspace-core.js";

const VOICE = "a".repeat(64);
const RECOVERY_VOICE = "b".repeat(64);

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
    kedits: [{
      op: "ins",
      from: 999,
      to: 999,
      text: "model text",
      voice: modelVoice,
      t: 3,
      tx: 0,
    }],
  };

  const restored = restoreCrashPadFile(existing, pad, VOICE, RECOVERY_VOICE);
  const edits = keditLogToArray(restored.kedits);
  assert.equal(edits.length, 1);
  assert.equal(edits[0]?.voice, RECOVERY_VOICE);
  assert.notEqual(edits[0]?.voice, restored.runs[0]?.voice);
});

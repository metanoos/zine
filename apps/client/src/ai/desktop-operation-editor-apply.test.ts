import assert from "node:assert/strict";
import test from "node:test";

import { contentFingerprint } from "./context-snapshot.js";
import { prepareDesktopExtendApplyV1 } from "./desktop-operation-editor-apply.js";
import type { AcceptedArtifactIntentV1 } from "./desktop-operation-envelope.js";

function intent(text: string, at = text.length): AcceptedArtifactIntentV1 {
  return {
    version: 1,
    intentId: "artifact-intent-12345678",
    kind: "apply-extend-result",
    operationId: "operation-12345678",
    attemptId: "attempt-12345678",
    acceptedAtMs: 1,
    targetRevision: {
      folderId: "folder",
      path: "draft.md",
      traceId: "trace",
      headId: "head",
      contentHash: contentFingerprint(text),
    },
    applyRange: { fromUtf16: at, toUtf16: at },
    preparedRequestSha256: "11".repeat(32),
    selectedContextManifestSha256: "22".repeat(32),
    responseSha256: "33".repeat(32),
  };
}

test("prepares one deterministic local continuation without stepping or publishing", () => {
  const planned = prepareDesktopExtendApplyV1("Draft", intent("Draft"), "Continuation");
  assert.deepEqual(planned.change, { from: 5, to: 5, insert: "\nContinuation" });
  assert.equal(planned.resultingText, "Draft\nContinuation");
  assert.equal(planned.resultingContentHash, contentFingerprint(planned.resultingText));
});

test("fails closed when the target or insertion range changed", () => {
  assert.throws(
    () => prepareDesktopExtendApplyV1("Changed", intent("Draft"), "Continuation"),
    /no longer matches/,
  );
  const invalid = { ...intent("Draft"), applyRange: { fromUtf16: 0, toUtf16: 1 } };
  assert.throws(
    () => prepareDesktopExtendApplyV1("Draft", invalid, "Continuation"),
    /invalid insertion range/,
  );
});

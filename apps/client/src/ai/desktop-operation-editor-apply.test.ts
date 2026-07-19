import assert from "node:assert/strict";
import test from "node:test";

import { contentFingerprint } from "./context-snapshot.js";
import { prepareDesktopExtendApplyV1 } from "./desktop-operation-editor-apply.js";
import type { AcceptedArtifactIntentV1 } from "./desktop-operation-envelope.js";
import { compileTraceAuthoringOperation } from "./trace-authoring-adapter.js";

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

function authoring(text: string, at = text.length) {
  return compileTraceAuthoringOperation({
    operation: "extend",
    operationInputs: {
      seed: text,
      hasSelection: false,
      rangeFrom: at,
      rangeTo: at,
      sourceFrom: 0,
      sourceTo: text.length,
    },
    targetText: text,
    renderedContextBlock:
      `context\n--- file contents ---\n## draft.md  (ACTIVE)\n${text}\n\n=== END CONTEXT ===`,
    actingAuthorId: "",
    authoritySpans: [],
    sourceRevision: {
      traceId: "trace",
      headId: "head",
      path: "draft.md",
      contentHash: contentFingerprint(text),
    },
  }).authoring!;
}

test("prepares one deterministic local continuation without stepping or publishing", () => {
  const planned = prepareDesktopExtendApplyV1(
    "Draft", intent("Draft"), "Continuation", authoring("Draft"),
  );
  assert.deepEqual(planned.changes, [{ from: 5, insert: "\nContinuation" }]);
  assert.equal(planned.resultingText, "Draft\nContinuation");
  assert.equal(planned.resultingContentHash, contentFingerprint(planned.resultingText));
});

test("fails closed when the target or insertion range changed", () => {
  assert.throws(
    () => prepareDesktopExtendApplyV1(
      "Changed", intent("Draft"), "Continuation", authoring("Draft"),
    ),
    /no longer matches/,
  );
  const invalid = { ...intent("Draft"), applyRange: { fromUtf16: 0, toUtf16: 1 } };
  assert.throws(
    () => prepareDesktopExtendApplyV1(
      "Draft", invalid, "Continuation", authoring("Draft", 0),
    ),
    /invalid insertion range/,
  );
});

test("accept validates directive output and deletes directives in the same transaction", () => {
  const text = "Draft ((tighten this))";
  const from = text.indexOf("((");
  const preparedAuthoring = compileTraceAuthoringOperation({
    operation: "extend",
    operationInputs: {
      seed: text,
      hasSelection: false,
      rangeFrom: text.length,
      rangeTo: text.length,
      sourceFrom: 0,
      sourceTo: text.length,
    },
    targetText: text,
    renderedContextBlock:
      `context\n--- file contents ---\n## draft.md  (ACTIVE)\n${text}\n\n=== END CONTEXT ===`,
    actingAuthorId: "author",
    authoritySpans: [{
      id: "manual-1",
      actorId: "author",
      origin: "manual",
      instructionEligible: true,
      fromUtf16: from,
      toUtf16: text.length,
    }],
    sourceRevision: {
      traceId: "trace",
      headId: "head",
      path: "draft.md",
      contentHash: contentFingerprint(text),
    },
  }).authoring!;
  const marker = preparedAuthoring.compiled.directives[0]!.marker;
  const planned = prepareDesktopExtendApplyV1(
    text,
    intent(text),
    `${marker}\n((tighten this))\nTighter continuation`,
    preparedAuthoring,
  );
  assert.deepEqual(planned.changes, [{
    from,
    to: text.length,
    insert: "\nTighter continuation",
  }]);
  assert.equal(planned.resultingText, "Draft \nTighter continuation");
  assert.doesNotMatch(planned.resultingText, /tighten this|ZINE_DIRECTIVE/);
});

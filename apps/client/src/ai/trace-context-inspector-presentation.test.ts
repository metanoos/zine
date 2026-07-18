import assert from "node:assert/strict";
import test from "node:test";
import {
  TRACE_CONTEXT_INSPECTOR_CLASSIFICATION_LABELS,
  TRACE_CONTEXT_INSPECTOR_EVIDENCE_KIND_LABELS,
  TRACE_CONTEXT_INSPECTOR_INERT_REASON_LABELS,
  TRACE_CONTEXT_INSPECTOR_OPERATION_LABELS,
  TRACE_CONTEXT_INSPECTOR_POLICY_LABELS,
  formatTraceContextInspectorRange,
  freezeTraceContextInspectorPresentationV1,
  groupTraceContextInspectorPresentationV1,
  type TraceContextInspectorPresentationV1,
} from "./trace-context-inspector-presentation.js";

function makePresentation(): TraceContextInspectorPresentationV1 {
  return {
    version: 1,
    policy: "selected-trace-v1",
    operation: "settle",
    targetRevision: {
      traceId: "trace-a",
      headId: "head-a",
      contentHash: "sha256:a",
      operationRange: { fromUtf16: 0, toUtf16: 100 },
    },
    directives: [
      {
        id: "directive-late",
        ordinal: 1,
        marker: "[D2]",
        displayInstruction: "Late",
        classification: "instruction",
        sourceRange: { fromUtf16: 40, toUtf16: 48 },
        localExcerpt: {
          displayText: "Late block",
          sourceRange: { fromUtf16: 30, toUtf16: 60 },
          byteLength: 10,
          relation: "containing",
          omittedBefore: false,
          omittedAfter: false,
        },
        canExclude: true,
        canReactivate: false,
      },
      {
        id: "directive-early",
        ordinal: 0,
        marker: "[D1]",
        displayInstruction: "Early",
        classification: "instruction",
        sourceRange: { fromUtf16: 4, toUtf16: 13 },
        localExcerpt: {
          displayText: "Early block",
          sourceRange: { fromUtf16: 0, toUtf16: 20 },
          byteLength: 11,
          relation: "containing",
          omittedBefore: false,
          omittedAfter: false,
        },
        state: "pending",
        canExclude: true,
        canReactivate: false,
      },
    ],
    protectedRanges: [
      { id: "protected-late", sourceRange: { fromUtf16: 70, toUtf16: 80 }, displayText: "late", classification: "quoted-data" },
      { id: "protected-early", sourceRange: { fromUtf16: 15, toUtf16: 20 }, displayText: "early", classification: "quoted-data" },
    ],
    inertDirectives: [
      { id: "inert-late", ordinal: 3, displayCandidate: "late", sourceRange: { fromUtf16: 90, toUtf16: 95 }, classification: "quoted-data", reason: "wrong-actor", canPromote: false },
      { id: "inert-early", ordinal: 2, displayCandidate: "early", sourceRange: { fromUtf16: 21, toUtf16: 29 }, classification: "quoted-data", reason: "missing-authority", canPromote: true },
    ],
    compilationErrors: [
      { id: "error-late", code: "UNTERMINATED_DIRECTIVE", displayMessage: "late", sourceRange: { fromUtf16: 88, toUtf16: 100 } },
      { id: "error-early", code: "EMPTY_DIRECTIVE", displayMessage: "early", sourceRange: { fromUtf16: 22, toUtf16: 26 } },
    ],
    selectedEvidence: [
      {
        id: "evidence-second",
        selectionOrder: 1,
        kind: "process-fact",
        displayClaim: "Second",
        classification: "quoted-data",
        source: { displayLabel: "Step two" },
        selectionReasons: ["recent"],
        sensitivity: "trace-private",
        byteCost: 12,
        canExclude: true,
      },
      {
        id: "evidence-first",
        selectionOrder: 0,
        kind: "correction",
        displayClaim: "First",
        classification: "quoted-data",
        source: { displayLabel: "Correction one" },
        selectionReasons: ["explicit"],
        sensitivity: "profile-private",
        byteCost: 10,
        canExclude: true,
      },
    ],
    excludedEvidence: [
      { reason: "other", count: 1, displayLabel: "Other" },
      { reason: "budget", count: 4, displayLabel: "Over budget" },
      { reason: "user-excluded", count: 2, displayLabel: "Excluded once" },
    ],
    metadata: {
      completeness: { complete: true, failures: [] },
      budget: {
        effectiveContextBytes: 4096,
        usedContextBytes: 512,
        candidateCount: 9,
        selectedCount: 2,
        truncated: false,
      },
      versions: {
        compiler: "compiler-v1",
        selector: "selector-v1",
        renderer: "renderer-v1",
        promptLayers: ["system-v1", "operation-v1"],
      },
      fingerprint: "fingerprint-a",
    },
  };
}

test("groups Inspector items in deterministic semantic order without mutating input", () => {
  const presentation = makePresentation();
  const originalDirectiveOrder = presentation.directives.map((item) => item.id);
  const groups = groupTraceContextInspectorPresentationV1(presentation);

  assert.deepEqual(groups.directives.map((item) => item.id), ["directive-early", "directive-late"]);
  assert.deepEqual(groups.protectedRanges.map((item) => item.id), ["protected-early", "protected-late"]);
  assert.deepEqual(groups.inertDirectives.map((item) => item.id), ["inert-early", "inert-late"]);
  assert.deepEqual(groups.compilationErrors.map((item) => item.id), ["error-early", "error-late"]);
  assert.deepEqual(groups.selectedEvidence.map((item) => item.id), ["evidence-first", "evidence-second"]);
  assert.deepEqual(groups.excludedEvidence.map((item) => item.reason), ["budget", "user-excluded", "other"]);
  assert.deepEqual(presentation.directives.map((item) => item.id), originalDirectiveOrder);
  assert.ok(Object.isFrozen(groups));
  assert.ok(Object.isFrozen(groups.directives));
});

test("freezes a detached presentation graph through every nested collection", () => {
  const source = makePresentation();
  const frozen = freezeTraceContextInspectorPresentationV1(source);

  assert.notEqual(frozen, source);
  assert.ok(Object.isFrozen(frozen));
  assert.ok(Object.isFrozen(frozen.targetRevision));
  assert.ok(Object.isFrozen(frozen.targetRevision.operationRange));
  assert.ok(Object.isFrozen(frozen.directives));
  assert.ok(Object.isFrozen(frozen.directives[0]));
  assert.ok(Object.isFrozen(frozen.directives[0].localExcerpt));
  assert.ok(Object.isFrozen(frozen.metadata));
  assert.ok(Object.isFrozen(frozen.metadata.versions.promptLayers));
  assert.equal(source.directives[0].displayInstruction, "Late");
});

test("pins stable user-facing labels for policy, operation, classification, authority failure, and ranges", () => {
  assert.equal(TRACE_CONTEXT_INSPECTOR_POLICY_LABELS["selected-trace-v1"], "Selected trace");
  assert.equal(TRACE_CONTEXT_INSPECTOR_OPERATION_LABELS.settle, "Settle");
  assert.equal(TRACE_CONTEXT_INSPECTOR_CLASSIFICATION_LABELS.instruction, "Instruction");
  assert.equal(TRACE_CONTEXT_INSPECTOR_CLASSIFICATION_LABELS["quoted-data"], "Quoted data");
  assert.equal(TRACE_CONTEXT_INSPECTOR_EVIDENCE_KIND_LABELS["process-fact"], "Process fact");
  assert.equal(
    TRACE_CONTEXT_INSPECTOR_INERT_REASON_LABELS["outside-operation-range"],
    "Outside the prepared operation range",
  );
  assert.equal(
    TRACE_CONTEXT_INSPECTOR_INERT_REASON_LABELS["mixed-authority"],
    "The directive contains mixed authority",
  );
  assert.equal(formatTraceContextInspectorRange({ fromUtf16: 12, toUtf16: 27 }), "12–27 UTF-16");
});

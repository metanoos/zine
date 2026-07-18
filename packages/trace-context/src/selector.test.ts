import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

import corpusJson from "../corpus/evidence-selection-v1.json" with { type: "json" };
import type { ProtocolEvent } from "../../protocol/src/event.js";
import type { KEdit } from "../../protocol/src/kedit.js";
import {
  summarizeTraceProcess,
  traceProcessFromEvent,
} from "../../protocol/src/trace-process.js";
import {
  selectTraceContextV1,
  TRACE_CONTEXT_SELECTION_HARD_LIMITS_V1,
  type EvidenceCandidateV1,
  type TraceContextSelectionInputV1,
  type TraceContextSelectionResultV1,
  type TraceProcessFactV1,
  type TraceProcessStatusV1,
} from "./index.js";

interface GoldenCase {
  name: string;
  input?: unknown;
  construct?: {
    kind: "candidate-text-code-units";
    textCodeUnits: number[];
    input: unknown;
  };
  expected: Record<string, unknown>;
}

const corpus = corpusJson as unknown as {
  version: 1;
  contract: "package-local-non-normative-v1";
  cases: GoldenCase[];
};

const VOICE_A = "a".repeat(64);
const VOICE_B = "b".repeat(64);

test("selection corpus is portable JSON and identifies the package-local contract", async () => {
  assert.equal(corpus.version, 1);
  assert.equal(corpus.contract, "package-local-non-normative-v1");
  assert.ok(corpus.cases.length >= 10);
  const source = await readFile(new URL("../corpus/evidence-selection-v1.json", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\\u[dD][89aAbB][0-9a-fA-F]{2}/, "corpus must not encode lone surrogates");
  assert.deepEqual(JSON.parse(source), corpusJson);
});

test("selection corpus passes an available strict non-Node JSON parser", (t) => {
  const corpusPath = fileURLToPath(new URL("../corpus/evidence-selection-v1.json", import.meta.url));
  const ruby = spawnSync("ruby", ["--version"], { encoding: "utf8" });
  if (!ruby.error) {
    const parsed = spawnSync(
      "ruby",
      ["-rjson", "-e", "JSON.parse(File.read(ARGV.fetch(0)))", corpusPath],
      { encoding: "utf8" },
    );
    assert.equal(parsed.status, 0, parsed.stderr);
    return;
  }
  const jq = spawnSync("jq", ["--version"], { encoding: "utf8" });
  if (!jq.error) {
    const parsed = spawnSync("jq", ["empty", corpusPath], { encoding: "utf8" });
    assert.equal(parsed.status, 0, parsed.stderr);
    return;
  }
  t.skip("Ruby and jq are unavailable; Node portability assertions still ran");
});

for (const fixture of corpus.cases) {
  test(`selection golden: ${fixture.name}`, async () => {
    const result = await selectTraceContextV1(materializeFixtureInput(fixture));
    assertGoldenResult(result, fixture.expected);
  });
}

test("candidate enumeration order does not change rendered bytes or identities", async () => {
  const candidates = [
    preference("nfc", "café", "Keep café exactly."),
    preference("nfd", "café", "Keep café exactly."),
  ];
  const forward = await selectTraceContextV1(selectionInput(candidates));
  const reverse = await selectTraceContextV1(selectionInput([...candidates].reverse()));
  assertSuccess(forward);
  assertSuccess(reverse);
  assert.equal(forward.renderedContext, reverse.renderedContext);
  assert.equal(forward.manifestSha256, reverse.manifestSha256);
  assert.equal(forward.manifest.hashes.frozenInputsSha256, reverse.manifest.hashes.frozenInputsSha256);
  assert.deepEqual(forward.manifest.selected.map((item) => item.id), ["nfd", "nfc"]);
  assert.ok(forward.renderedContext.includes("café"));
  assert.ok(forward.renderedContext.includes("café"));
  assert.notEqual("café", "café", "selector fixtures must retain distinct code-unit sequences");
});

test("text-only projects excluded candidates before validation, conflicts, limits, and hashes", async () => {
  const approved = citation("citation", "Quoted body", {
    nodeId: "hidden-node-a",
    traceId: "hidden-trace-a",
    processStatus: "invalid",
  });
  const baseline = textOnlyInput([approved], {
    limits: { version: 1, maxInputBytes: 1_024 },
  });
  const noisy: unknown = {
    ...baseline,
    candidates: [
      {
        kind: "process-fact",
        id: "citation",
        dedupeKey: "citation",
        text: "HIDDEN PROCESS ".repeat(2_000),
        arbitrary: { malformed: true },
      },
      {
        kind: "explicit-preference",
        id: "citation",
        dedupeKey: "citation",
        text: "HIDDEN PREFERENCE",
      },
      citation("citation", "Quoted body", {
        nodeId: "hidden-node-b",
        traceId: "hidden-trace-b",
        processStatus: "snapshot-only",
      }),
    ],
  };

  const first = await selectTraceContextV1(baseline);
  const second = await selectTraceContextV1(noisy);
  assertSuccess(first);
  assertSuccess(second);
  assert.equal(second.renderedContext, first.renderedContext);
  assert.equal(second.manifestSha256, first.manifestSha256);
  assert.equal(second.manifest.hashes.frozenInputsSha256, first.manifest.hashes.frozenInputsSha256);
  assert.equal(second.manifest.input.projectedInputBytes, first.manifest.input.projectedInputBytes);
  assert.equal(second.manifest.budget.candidateCount, 1);
  assert.equal(second.decisions.length, 1);
  assert.deepEqual(second.manifest.selected[0]?.source, {
    kind: "citation",
    ref: "citation:citation",
    approvedOrder: 0,
  });
  for (const forbidden of [
    "HIDDEN PROCESS",
    "HIDDEN PREFERENCE",
    "hidden-node",
    "hidden-trace",
    "processStatus",
    "traceId",
  ]) {
    assert.equal(second.renderedContext.includes(forbidden), false, `render leaked ${forbidden}`);
  }
});

test("selected-trace failures never expose a successful completeness claim", async () => {
  for (const [status, code] of [
    ["invalid", "INVALID_PROCESS_EVIDENCE"],
    ["snapshot-only", "CONTEXT_INCOMPLETE"],
  ] as const) {
    const result = await selectTraceContextV1(selectionInput([
      processFact("process", zeroStepSummary(), { status }),
    ]));
    assert.equal(result.ok, false);
    if (result.ok) continue;
    assert.equal(result.error.code, code);
    assert.equal("completeness" in result, false);
    assert.equal(JSON.stringify(result).includes("selectionComplete"), false);
  }
});

test("process facts reject caller-authored prose and inconsistent mechanical shapes", async () => {
  const opaqueText = {
    ...processFact("process", zeroStepSummary()),
    text: "The writer secretly prefers praise.",
  };
  const proseResult = await selectTraceContextV1(selectionInput([
    opaqueText as unknown as EvidenceCandidateV1,
  ]));
  assert.equal(proseResult.ok, false);
  if (!proseResult.ok) {
    assert.equal(proseResult.error.code, "MALFORMED_INPUT");
    if (proseResult.error.code === "MALFORMED_INPUT") {
      assert.equal(proseResult.error.path, "$.candidates[0]");
    }
  }

  const inconsistent = processFact("change", {
    kind: "change",
    transactionIndex: 0,
    operation: "insert",
    range: { fromUtf16: 0, toUtf16: 1 },
    insertedCodePointCount: 1,
    deletedCodePointCount: 0,
    voiceId: VOICE_A,
  });
  const inconsistentResult = await selectTraceContextV1(selectionInput([inconsistent]));
  assert.equal(inconsistentResult.ok, false);
  if (!inconsistentResult.ok) assert.equal(inconsistentResult.error.code, "MALFORMED_INPUT");
});

test("process facts reject impossible summaries, signer identities, and count relationships", async () => {
  const invalidFacts: readonly TraceProcessFactV1[] = [
    { ...zeroStepSummary(), rangeCount: 1 },
    {
      kind: "step-summary",
      transactionCount: 1,
      rangeCount: 1,
      insertedCodePointCount: 1,
      deletedCodePointCount: 0,
      spanMs: 0,
      longestGapMs: 0,
      undoCount: 0,
      redoCount: 0,
    },
    {
      kind: "step-summary",
      transactionCount: 2,
      rangeCount: 1,
      insertedCodePointCount: 1,
      deletedCodePointCount: 0,
      firstCapturedAtMs: 1,
      lastCapturedAtMs: 2,
      spanMs: 1,
      longestGapMs: 1,
      undoCount: 0,
      redoCount: 0,
    },
    {
      kind: "step-summary",
      transactionCount: 1,
      rangeCount: 1,
      insertedCodePointCount: 1,
      deletedCodePointCount: 0,
      firstCapturedAtMs: 1,
      lastCapturedAtMs: 11,
      spanMs: 10,
      longestGapMs: 1,
      undoCount: 0,
      redoCount: 0,
    },
    {
      kind: "step-summary",
      transactionCount: 1,
      rangeCount: 1,
      insertedCodePointCount: 1,
      deletedCodePointCount: 0,
      firstCapturedAtMs: 1,
      lastCapturedAtMs: 1,
      spanMs: 0,
      longestGapMs: 0,
      undoCount: 1,
      redoCount: 1,
    },
    {
      kind: "transaction",
      transactionIndex: 0,
      capturedAtMs: 1,
      changeCount: 1,
      voiceIds: [VOICE_A, VOICE_B],
    },
    {
      kind: "transaction",
      transactionIndex: 0,
      capturedAtMs: 1,
      changeCount: 1,
      voiceIds: ["friendly voice"],
    },
    {
      kind: "transaction",
      transactionIndex: 0,
      capturedAtMs: 1,
      changeCount: 1,
      voiceIds: ["A".repeat(64)],
    },
    {
      kind: "transaction",
      transactionIndex: 0,
      capturedAtMs: 1,
      changeCount: 1,
      voiceIds: ["a".repeat(63)],
    },
    {
      kind: "transaction",
      transactionIndex: 0,
      capturedAtMs: 1,
      changeCount: 1,
      voiceIds: ["a".repeat(65)],
    },
    {
      kind: "transaction",
      transactionIndex: 0,
      capturedAtMs: 1,
      changeCount: 1,
      voiceIds: [`${"a".repeat(63)}\n`],
    },
    {
      kind: "change",
      transactionIndex: 0,
      operation: "delete",
      range: { fromUtf16: 0, toUtf16: 1 },
      insertedCodePointCount: 0,
      deletedCodePointCount: 2,
      voiceId: VOICE_A,
    },
  ];

  for (const [index, fact] of invalidFacts.entries()) {
    const result = await selectTraceContextV1(selectionInput([processFact(`invalid-${index}`, fact)]));
    assert.equal(result.ok, false, `invalid fact ${index}`);
    if (!result.ok) assert.equal(result.error.code, "MALFORMED_INPUT", `invalid fact ${index}`);
  }
});

test("Step summaries enforce exact one/two-transaction timing", async () => {
  const invalidFacts: readonly TraceProcessFactV1[] = [
    {
      kind: "step-summary",
      transactionCount: 1,
      rangeCount: 1,
      insertedCodePointCount: 1,
      deletedCodePointCount: 0,
      firstCapturedAtMs: 1,
      lastCapturedAtMs: 2,
      spanMs: 1,
      longestGapMs: 0,
      undoCount: 0,
      redoCount: 0,
    },
    {
      kind: "step-summary",
      transactionCount: 2,
      rangeCount: 2,
      insertedCodePointCount: 2,
      deletedCodePointCount: 0,
      firstCapturedAtMs: 1,
      lastCapturedAtMs: 3,
      spanMs: 2,
      longestGapMs: 1,
      undoCount: 0,
      redoCount: 0,
    },
  ];
  for (const [index, fact] of invalidFacts.entries()) {
    const result = await selectTraceContextV1(selectionInput([
      processFact(`aggregate-contradiction-${index}`, fact),
    ]));
    assert.equal(result.ok, false, `aggregate contradiction ${index}`);
    if (!result.ok) {
      assert.equal(result.error.code, "MALFORMED_INPUT", `aggregate contradiction ${index}`);
    }
  }

  const validBoundaryFacts: readonly TraceProcessFactV1[] = [
    {
      kind: "step-summary",
      transactionCount: 1,
      rangeCount: 1,
      insertedCodePointCount: 1,
      deletedCodePointCount: 0,
      firstCapturedAtMs: 7,
      lastCapturedAtMs: 7,
      spanMs: 0,
      longestGapMs: 0,
      undoCount: 0,
      redoCount: 0,
    },
    {
      kind: "step-summary",
      transactionCount: 2,
      rangeCount: 2,
      insertedCodePointCount: 2,
      deletedCodePointCount: 0,
      firstCapturedAtMs: 7,
      lastCapturedAtMs: 9,
      spanMs: 2,
      longestGapMs: 2,
      undoCount: 0,
      redoCount: 0,
    },
    {
      kind: "step-summary",
      transactionCount: 1,
      rangeCount: 2,
      insertedCodePointCount: 1,
      deletedCodePointCount: 1,
      firstCapturedAtMs: 7,
      lastCapturedAtMs: 7,
      spanMs: 0,
      longestGapMs: 0,
      undoCount: 0,
      redoCount: 0,
    },
  ];
  for (const [index, fact] of validBoundaryFacts.entries()) {
    const result = await selectTraceContextV1(selectionInput([
      processFact(`aggregate-boundary-${index}`, fact),
    ]));
    assertSuccess(result);
  }
});

test("Step summaries accept protocol-valid no-op KEdit ranges", async () => {
  const noOp = protocolStepSummary("a", "a", [{
    op: "ins",
    from: 0,
    to: 0,
    text: "",
    voice: VOICE_A,
    t: 7,
    tx: 0,
  }]);
  assert.deepEqual(noOp, {
    kind: "step-summary",
    transactionCount: 1,
    rangeCount: 1,
    insertedCodePointCount: 0,
    deletedCodePointCount: 0,
    firstCapturedAtMs: 7,
    lastCapturedAtMs: 7,
    spanMs: 0,
    longestGapMs: 0,
    undoCount: 0,
    redoCount: 0,
  });

  const mixed = protocolStepSummary("a", "ax", [
    {
      op: "ins",
      from: 0,
      to: 0,
      text: "",
      voice: VOICE_A,
      t: 9,
      tx: 0,
    },
    {
      op: "ins",
      from: 1,
      to: 1,
      text: "x",
      voice: VOICE_A,
      t: 9,
      tx: 0,
    },
  ]);
  assert.equal(mixed.rangeCount, 2);
  assert.equal(mixed.insertedCodePointCount + mixed.deletedCodePointCount, 1);

  for (const [index, fact] of [noOp, mixed].entries()) {
    const result = await selectTraceContextV1(selectionInput([
      processFact(`protocol-no-op-${index}`, fact),
    ]));
    assertSuccess(result);
  }
});

test("Step summaries enforce the n-transaction longest-gap lower bound without overflow", async () => {
  const invalidFacts: readonly TraceProcessFactV1[] = [
    {
      kind: "step-summary",
      transactionCount: 3,
      rangeCount: 3,
      insertedCodePointCount: 3,
      deletedCodePointCount: 0,
      firstCapturedAtMs: 0,
      lastCapturedAtMs: 10,
      spanMs: 10,
      longestGapMs: 0,
      undoCount: 0,
      redoCount: 0,
    },
    {
      kind: "step-summary",
      transactionCount: 4,
      rangeCount: 4,
      insertedCodePointCount: 4,
      deletedCodePointCount: 0,
      firstCapturedAtMs: 0,
      lastCapturedAtMs: 10,
      spanMs: 10,
      longestGapMs: 3,
      undoCount: 0,
      redoCount: 0,
    },
  ];
  for (const [index, fact] of invalidFacts.entries()) {
    const result = await selectTraceContextV1(selectionInput([
      processFact(`gap-lower-bound-reject-${index}`, fact),
    ]));
    assert.equal(result.ok, false, `gap lower-bound rejection ${index}`);
    if (!result.ok) {
      assert.equal(result.error.code, "MALFORMED_INPUT", `gap lower-bound rejection ${index}`);
    }
  }

  const validFacts: readonly TraceProcessFactV1[] = [
    {
      kind: "step-summary",
      transactionCount: 4,
      rangeCount: 4,
      insertedCodePointCount: 4,
      deletedCodePointCount: 0,
      firstCapturedAtMs: 0,
      lastCapturedAtMs: 10,
      spanMs: 10,
      longestGapMs: 4,
      undoCount: 0,
      redoCount: 0,
    },
    {
      kind: "step-summary",
      transactionCount: 3,
      rangeCount: 3,
      insertedCodePointCount: 3,
      deletedCodePointCount: 0,
      firstCapturedAtMs: 7,
      lastCapturedAtMs: 7,
      spanMs: 0,
      longestGapMs: 0,
      undoCount: 0,
      redoCount: 0,
    },
    {
      kind: "step-summary",
      transactionCount: Number.MAX_SAFE_INTEGER,
      rangeCount: Number.MAX_SAFE_INTEGER,
      insertedCodePointCount: Number.MAX_SAFE_INTEGER,
      deletedCodePointCount: 0,
      firstCapturedAtMs: 0,
      lastCapturedAtMs: Number.MAX_SAFE_INTEGER,
      spanMs: Number.MAX_SAFE_INTEGER,
      longestGapMs: 2,
      undoCount: 0,
      redoCount: 0,
    },
  ];
  for (const [index, fact] of validFacts.entries()) {
    const result = await selectTraceContextV1(selectionInput([
      processFact(`gap-lower-bound-accept-${index}`, fact),
    ]));
    assertSuccess(result);
  }
});

test("canonical signer pubkeys render in full as opaque mechanical identifiers", async () => {
  const result = await selectTraceContextV1(selectionInput([processFact("voices", {
    kind: "transaction",
    transactionIndex: 0,
    capturedAtMs: 1,
    changeCount: 2,
    voiceIds: [VOICE_B, VOICE_A],
  })]));
  assertSuccess(result);
  assert.ok(result.renderedContext.includes(`voices ${VOICE_A},${VOICE_B}`));
  assert.equal(result.renderedContext.includes("friendly voice"), false);
});

test("every process fact is bound to the exact target trace and prepared head chain", async () => {
  const mismatches: EvidenceCandidateV1[] = [
    processFact("wrong-trace", zeroStepSummary(), { traceId: "other" }),
    processFact("wrong-head", zeroStepSummary(), { headId: "other" }),
    processFact("wrong-zero", zeroStepSummary(), { nodeId: "prior" }),
    processFact("wrong-prior", zeroStepSummary(), { chainDistance: 1, nodeId: "head" }),
    processFact("wrong-tx", {
      kind: "transaction",
      transactionIndex: 1,
      capturedAtMs: 1,
      changeCount: 1,
      voiceIds: [VOICE_A],
    }),
  ];
  for (const candidate of mismatches) {
    const result = await selectTraceContextV1(selectionInput([candidate]));
    assert.equal(result.ok, false, candidate.id);
    if (!result.ok) assert.equal(result.error.code, "PROCESS_SOURCE_MISMATCH", candidate.id);
  }
});

test("cross-trace material remains available only as an explicitly approved citation", async () => {
  const result = await selectTraceContextV1(selectionInput([
    citation("foreign", "Quoted foreign body", {
      nodeId: "foreign-head",
      traceId: "foreign-trace",
      processStatus: "snapshot-only",
    }),
  ]));
  assertSuccess(result);
  assert.deepEqual(result.manifest.selected.map((item) => item.id), ["foreign"]);
  assert.ok(result.renderedContext.includes("Quoted foreign body"));
});

test("effective context arithmetic takes the minimum without double subtraction", async () => {
  const cases = [
    { context: 300, request: 1_000, reserved: 100, expected: 300 },
    {
      context: 1_000_000,
      request: 1_000_000,
      reserved: 0,
      expected: TRACE_CONTEXT_SELECTION_HARD_LIMITS_V1.maxRenderedContextBytes,
    },
    { context: 1_000, request: 500, reserved: 100, expected: 400 },
  ];
  for (const fixture of cases) {
    const result = await selectTraceContextV1(selectionInput([], {
      maxContextBytes: fixture.context,
      preparedRequestMaxBytes: fixture.request,
      reservedPromptBytes: fixture.reserved,
    }));
    assertSuccess(result);
    assert.equal(result.manifest.budget.effectiveContextBytes, fixture.expected);
    assert.equal(
      result.manifest.budget.preparedRequestAvailableBytes,
      fixture.request - fixture.reserved,
    );
  }
});

test("current target and mandatory rendered bytes are counted exactly once", async () => {
  const target = "😀 target";
  const result = await selectTraceContextV1(selectionInput([
    instruction("instruction", "Continue exactly."),
  ], { currentText: target }));
  assertSuccess(result);
  assert.equal(result.renderedContext.split(target).length - 1, 1);
  assert.equal(
    result.manifest.budget.currentTargetTextBytes,
    new TextEncoder().encode(target).length,
  );
  assert.equal(
    result.manifest.budget.usedRenderedBytes,
    new TextEncoder().encode(result.renderedContext).length,
  );
  const selectedCost = result.manifest.selected.reduce((sum, item) => sum + item.renderedByteCost, 0);
  assert.equal(
    result.manifest.budget.usedRenderedBytes,
    2 + result.manifest.budget.currentTargetRenderedBytes + selectedCost,
  );
  assert.ok(
    result.manifest.budget.reservedPromptBytes + result.manifest.budget.usedRenderedBytes
      <= result.manifest.budget.preparedRequestMaxBytes,
  );
});

test("total and per-candidate input byte ceilings are independent typed failures", async () => {
  const perCandidate = await selectTraceContextV1({
    ...selectionInput([citation("large", "x".repeat(200))]),
    limits: { version: 1, maxCandidateInputBytes: 128 },
  });
  assert.equal(perCandidate.ok, false);
  if (!perCandidate.ok) assert.equal(perCandidate.error.code, "CANDIDATE_INPUT_LIMIT_EXCEEDED");

  const total = await selectTraceContextV1({
    ...selectionInput([], { currentText: "x".repeat(1_000) }),
    limits: { version: 1, maxInputBytes: 512 },
  });
  assert.equal(total.ok, false);
  if (!total.ok) assert.equal(total.error.code, "INPUT_LIMIT_EXCEEDED");
});

test("candidate and manifest ceilings fail visibly", async () => {
  const candidateLimited = await selectTraceContextV1({
    ...selectionInput([preference("a", "a", "A"), preference("b", "b", "B")]),
    limits: { version: 1, maxCandidates: 1 },
  });
  assert.equal(candidateLimited.ok, false);
  if (!candidateLimited.ok) assert.equal(candidateLimited.error.code, "CANDIDATE_LIMIT_EXCEEDED");

  const manifestLimited = await selectTraceContextV1({
    ...selectionInput([]),
    limits: { version: 1, maxManifestBytes: 1 },
  });
  assert.equal(manifestLimited.ok, false);
  if (!manifestLimited.ok) assert.equal(manifestLimited.error.code, "MANIFEST_LIMIT_EXCEEDED");
});

test("host-task cancellation interrupts bounded candidate validation", async () => {
  const candidates = Array.from({ length: 10_000 }, (_, index) => (
    preference(`candidate-${index}`, `ref-${index}`, `value-${index}`)
  ));
  const controller = new AbortController();
  const pending = selectTraceContextV1(selectionInput(candidates), { signal: controller.signal });
  setTimeout(() => controller.abort("test cancellation"), 0);
  const result = await pending;
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "CANCELLED");
});

test("host-task cancellation interrupts aggregate UTF-8 preflight inside a large string", async () => {
  const controller = new AbortController();
  const pending = selectTraceContextV1(selectionInput([
    citation("large", "x".repeat(TRACE_CONTEXT_SELECTION_HARD_LIMITS_V1.maxCandidateInputBytes * 2)),
  ]), { signal: controller.signal });
  setTimeout(() => controller.abort("test preflight cancellation"), 0);
  const result = await pending;
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "CANCELLED");
});

test("duplicate collapse is deterministic and conflicting identities fail", async () => {
  const first = preference("z", "same", "First");
  const duplicate = { ...preference("a", "same", "First"), dedupeKey: first.dedupeKey };
  const collapsed = await selectTraceContextV1(selectionInput([first, duplicate]));
  assertSuccess(collapsed);
  assert.deepEqual(collapsed.manifest.selected.map((item) => item.id), ["a"]);
  assert.equal(collapsed.manifest.exclusionSummary.countsByReason.duplicateCollapsed, 1);

  const conflict = await selectTraceContextV1(selectionInput([
    first,
    { ...duplicate, text: "Second" },
  ]));
  assert.equal(conflict.ok, false);
  if (!conflict.ok) assert.equal(conflict.error.code, "DUPLICATE_CONFLICT");
});

test("success output is deeply frozen and exact UTF-16 ranges survive selection", async () => {
  const result = await selectTraceContextV1(selectionInput([{
    version: 1,
    id: "protected",
    dedupeKey: "protected",
    kind: "protected-range",
    claimClass: "explicit",
    source: {
      kind: "target",
      ref: "protected-v1:0001:0:6",
      traceId: "trace",
      headId: "head",
      range: { fromUtf16: 0, toUtf16: 6 },
    },
    reasons: ["protected-current-range"],
    text: "[[😀]]",
  }], {
    operation: "settle",
    currentText: "[[😀]] target",
    range: { fromUtf16: 0, toUtf16: 6 },
  }));
  assertSuccess(result);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.manifest), true);
  assert.equal(Object.isFrozen(result.manifest.selected[0]), true);
  assert.deepEqual(result.manifest.operation.range, { fromUtf16: 0, toUtf16: 6 });
  assert.deepEqual(result.manifest.selected[0]?.source, {
    kind: "target",
    ref: "protected-v1:0001:0:6",
    traceId: "trace",
    headId: "head",
    range: { fromUtf16: 0, toUtf16: 6 },
  });
});

test("protected evidence binds to the exact scanner range, target identity, and operation range", async () => {
  const base: Extract<EvidenceCandidateV1, { kind: "protected-range" }> = {
    version: 1,
    id: "protected",
    dedupeKey: "protected",
    kind: "protected-range",
    claimClass: "explicit",
    source: {
      kind: "target",
      ref: "protected-v1:0001:7:13",
      traceId: "trace",
      headId: "head",
      range: { fromUtf16: 7, toUtf16: 13 },
    },
    reasons: ["protected-current-range"],
    text: "[[😀]]",
  };
  const mismatches: readonly [string, EvidenceCandidateV1, OperationOverrides?][] = [
    ["wrong trace", { ...base, source: { ...base.source, traceId: "other" } }],
    ["wrong head", { ...base, source: { ...base.source, headId: "other" } }],
    ["out of bounds", {
      ...base,
      source: { ...base.source, range: { fromUtf16: 7, toUtf16: 99 } },
    }],
    ["surrogate split", {
      ...base,
      source: { ...base.source, range: { fromUtf16: 7, toUtf16: 10 } },
      text: "[[",
    }],
    ["text mismatch", { ...base, text: "[[other]]" }],
    ["scanner ref mismatch", { ...base, source: { ...base.source, ref: "protected-v1:9999:7:13" } }],
    ["not protected syntax", {
      ...base,
      source: {
        ...base.source,
        ref: "protected-v1:0001:0:6",
        range: { fromUtf16: 0, toUtf16: 6 },
      },
      text: "prefix",
    }],
    ["outside operation", base, { range: { fromUtf16: 0, toUtf16: 6 } }],
  ];

  for (const [name, candidate, overrides] of mismatches) {
    const result = await selectTraceContextV1(selectionInput([candidate], {
      currentText: "prefix [[😀]] suffix",
      range: { fromUtf16: 7, toUtf16: 13 },
      ...overrides,
    }));
    assert.equal(result.ok, false, name);
    if (!result.ok) assert.equal(result.error.code, "TARGET_SOURCE_MISMATCH", name);
  }
});

function materializeFixtureInput(fixture: GoldenCase): unknown {
  if (!fixture.construct) return fixture.input;
  const input = structuredClone(fixture.construct.input) as {
    candidates: { text?: string }[];
  };
  input.candidates[0]!.text = String.fromCharCode(...fixture.construct.textCodeUnits);
  return input;
}

function assertGoldenResult(
  result: TraceContextSelectionResultV1,
  expected: Record<string, unknown>,
): void {
  assert.equal(result.ok, expected.ok);
  if (!result.ok) {
    assert.equal(result.error.code, expected.code);
    assert.equal(result.error.stage, expected.stage);
    for (const field of ["path", "receivedPolicy", "candidateId", "reason", "available", "limit"] as const) {
      if (field in expected) {
        assert.equal((result.error as unknown as Record<string, unknown>)[field], expected[field]);
      }
    }
    assert.equal(JSON.stringify(result).includes("selectionComplete"), false);
    return;
  }
  assert.equal(result.renderedContext, expected.renderedContext);
  assert.deepEqual(result.manifest.selected.map((item) => item.id), expected.selectedIds);
  assert.equal(result.manifest.budget.effectiveContextBytes, expected.effectiveContextBytes);
  assert.equal(
    result.manifest.budget.preparedRequestAvailableBytes,
    expected.preparedRequestAvailableBytes,
  );
  assert.equal(result.manifest.budget.currentTargetTextBytes, expected.currentTargetTextBytes);
  assert.equal(result.manifest.completeness.selectionComplete, expected.selectionComplete);
  assert.equal(
    result.manifest.budget.usedRenderedBytes,
    new TextEncoder().encode(result.renderedContext).length,
  );
  assert.match(result.manifest.hashes.frozenInputsSha256, /^[0-9a-f]{64}$/);
  assert.match(result.manifest.hashes.renderedContextSha256, /^[0-9a-f]{64}$/);
  assert.match(result.manifestSha256, /^[0-9a-f]{64}$/);
  for (const forbidden of (expected.forbiddenRenderedSubstrings ?? []) as string[]) {
    assert.equal(result.renderedContext.includes(forbidden), false, `render leaked ${forbidden}`);
  }
}

function assertSuccess(
  result: TraceContextSelectionResultV1,
): asserts result is Extract<TraceContextSelectionResultV1, { ok: true }> {
  assert.equal(result.ok, true, result.ok ? undefined : `${result.error.code}: ${result.error.message}`);
}

interface OperationOverrides {
  operation?: "extend" | "settle";
  currentText?: string;
  range?: { fromUtf16: number; toUtf16: number };
  maxContextBytes?: number;
  preparedRequestMaxBytes?: number;
  reservedPromptBytes?: number;
}

function selectionInput(
  candidates: readonly EvidenceCandidateV1[],
  overrides: OperationOverrides = {},
): TraceContextSelectionInputV1 {
  const operation = overrides.operation ?? "extend";
  return {
    version: 1,
    policy: "selected-trace-v1",
    operation: {
      version: 1,
      operation,
      target: {
        traceId: "trace",
        headId: "head",
        contentHash: "hash",
        currentText: overrides.currentText ?? "Draft",
      },
      ...(overrides.range ? { range: overrides.range } : {}),
      maxContextBytes: overrides.maxContextBytes ?? 256 * 1_024,
      preparedRequestMaxBytes: overrides.preparedRequestMaxBytes ?? 512 * 1_024,
      reservedPromptBytes: overrides.reservedPromptBytes ?? 0,
    },
    candidates,
  };
}

function textOnlyInput(
  candidates: readonly EvidenceCandidateV1[],
  extras: Partial<TraceContextSelectionInputV1> = {},
): TraceContextSelectionInputV1 {
  return { ...selectionInput(candidates), ...extras, policy: "text-only-v1" };
}

function preference(
  id: string,
  ref: string,
  text: string,
): Extract<EvidenceCandidateV1, { kind: "explicit-preference" }> {
  return {
    version: 1,
    id,
    dedupeKey: id,
    kind: "explicit-preference",
    claimClass: "explicit",
    source: { kind: "local", ref },
    reasons: ["explicit-scoped-preference"],
    text,
  };
}

function instruction(id: string, text: string): EvidenceCandidateV1 {
  return {
    version: 1,
    id,
    dedupeKey: id,
    kind: "operation-instruction",
    claimClass: "explicit",
    source: { kind: "operation", ref: `operation:${id}` },
    reasons: ["explicit-operation-intent"],
    text,
  };
}

function citation(
  id: string,
  text: string,
  source: Partial<Extract<EvidenceCandidateV1, { kind: "citation" }>["source"]> = {},
): EvidenceCandidateV1 {
  return {
    version: 1,
    id,
    dedupeKey: id,
    kind: "citation",
    claimClass: "explicit",
    source: {
      kind: "citation",
      ref: `citation:${id}`,
      nodeId: source.nodeId ?? `node-${id}`,
      approvedOrder: source.approvedOrder ?? 0,
      ...(source.processStatus ? { processStatus: source.processStatus } : {}),
      ...(source.traceId ? { traceId: source.traceId } : {}),
      ...(source.range ? { range: source.range } : {}),
    },
    reasons: ["approved-direct-citation"],
    text,
  };
}

interface ProcessSourceOverrides {
  status?: TraceProcessStatusV1;
  traceId?: string;
  headId?: string;
  nodeId?: string;
  chainDistance?: number;
  transactionIndex?: number;
}

function processFact(
  id: string,
  fact: TraceProcessFactV1,
  overrides: ProcessSourceOverrides = {},
): EvidenceCandidateV1 {
  return {
    version: 1,
    id,
    dedupeKey: id,
    kind: "process-fact",
    claimClass: "mechanical",
    source: {
      kind: "trace",
      ref: `trace:${id}`,
      traceId: overrides.traceId ?? "trace",
      headId: overrides.headId ?? "head",
      nodeId: overrides.nodeId ?? "head",
      processStatus: overrides.status ?? "full-trace",
      chainDistance: overrides.chainDistance ?? 0,
      transactionIndex: overrides.transactionIndex ?? 0,
    },
    reasons: ["prepared-head-process"],
    fact,
  };
}

function zeroStepSummary(): Extract<TraceProcessFactV1, { kind: "step-summary" }> {
  return {
    kind: "step-summary",
    transactionCount: 0,
    rangeCount: 0,
    insertedCodePointCount: 0,
    deletedCodePointCount: 0,
    spanMs: 0,
    longestGapMs: 0,
    undoCount: 0,
    redoCount: 0,
  };
}

function protocolStepSummary(
  previousSnapshot: string,
  snapshot: string,
  kedits: readonly KEdit[],
): Extract<TraceProcessFactV1, { kind: "step-summary" }> {
  const event: ProtocolEvent = {
    id: "event",
    pubkey: VOICE_A,
    created_at: 0,
    kind: 4_290,
    tags: [],
    content: JSON.stringify({ snapshot, kedits }),
    sig: "signature",
  };
  const process = traceProcessFromEvent(event, previousSnapshot);
  assert.equal(process.status, "complete", process.reason);
  const summary = summarizeTraceProcess(process);
  return {
    kind: "step-summary",
    transactionCount: summary.transactions,
    rangeCount: summary.ranges,
    insertedCodePointCount: summary.inserted,
    deletedCodePointCount: summary.deleted,
    ...(summary.firstAt !== null ? { firstCapturedAtMs: summary.firstAt } : {}),
    ...(summary.lastAt !== null ? { lastCapturedAtMs: summary.lastAt } : {}),
    spanMs: summary.spanMs,
    longestGapMs: summary.longestGapMs,
    undoCount: summary.undo,
    redoCount: summary.redo,
  };
}

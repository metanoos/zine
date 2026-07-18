import assert from "node:assert/strict";
import test from "node:test";

import corpusJson from "../corpus/evidence-selection-v1.json" with { type: "json" };
import {
  selectTraceContextV1,
  type EvidenceCandidateV1,
  type TraceContextSelectionInputV1,
  type TraceContextSelectionResultV1,
} from "./index.js";

interface GoldenCase {
  name: string;
  input: unknown;
  cancelled?: boolean;
  expected: unknown;
}

const corpus = corpusJson as unknown as {
  version: 1;
  contract: "package-local-non-normative-v1";
  cases: GoldenCase[];
};

test("selection corpus identifies the package-local non-normative contract", () => {
  assert.equal(corpus.version, 1);
  assert.equal(corpus.contract, "package-local-non-normative-v1");
  assert.ok(corpus.cases.length >= 10);
});

for (const fixture of corpus.cases) {
  test(`selection golden: ${fixture.name}`, async () => {
    const controller = new AbortController();
    if (fixture.cancelled) controller.abort("golden cancellation");
    const result = await selectTraceContextV1(fixture.input, { signal: controller.signal });
    const actual = summarize(result);
    if (process.env.PRINT_SELECTION_GOLDENS === "1") {
      process.stdout.write(`${JSON.stringify({ name: fixture.name, expected: actual }, null, 2)}\n`);
      return;
    }
    assert.deepEqual(actual, fixture.expected);
  });
}

test("candidate enumeration order does not change selection or identity", async () => {
  const candidates = [
    preference("nfc", "café", "NFC"),
    preference("nfd", "café", "NFD"),
  ];
  const forward = await selectTraceContextV1(selectionInput(candidates));
  const reverse = await selectTraceContextV1(selectionInput([...candidates].reverse()));
  assert.equal(forward.ok, true);
  assert.equal(reverse.ok, true);
  if (!forward.ok || !reverse.ok) return;
  assert.equal(forward.renderedContext, reverse.renderedContext);
  assert.equal(forward.manifestSha256, reverse.manifestSha256);
  assert.equal(forward.manifest.hashes.frozenInputsSha256, reverse.manifest.hashes.frozenInputsSha256);
  assert.deepEqual(forward.manifest.selected.map((item) => item.id), ["nfd", "nfc"]);
});

test("text-only and bounded policies share the contract without leaking disallowed candidates", async () => {
  const instruction: EvidenceCandidateV1 = {
    version: 1,
    id: "instruction",
    dedupeKey: "instruction",
    kind: "operation-instruction",
    claimClass: "explicit",
    source: { kind: "operation", ref: "operation:intent" },
    reasons: ["explicit-operation-intent"],
    text: "Continue.",
  };
  const process: EvidenceCandidateV1 = {
    version: 1,
    id: "process",
    dedupeKey: "process",
    kind: "process-fact",
    claimClass: "mechanical",
    source: {
      kind: "trace",
      ref: "trace:node:tx",
      traceId: "trace",
      headId: "head",
      nodeId: "node",
      processStatus: "full-trace",
      chainDistance: 0,
      transactionIndex: 0,
    },
    reasons: ["prepared-head-process"],
    text: "1 transaction",
  };
  const scopedPreference = preference("preference", "preference", "Prefer short sentences.");

  const textOnly = await selectTraceContextV1({
    ...selectionInput([instruction, process, scopedPreference]),
    policy: "text-only-v1",
  });
  const bounded = await selectTraceContextV1({
    ...selectionInput([instruction, process, scopedPreference]),
    policy: "bounded-trace-v1",
  });
  assert.equal(textOnly.ok, true);
  assert.equal(bounded.ok, true);
  if (!textOnly.ok || !bounded.ok) return;
  assert.deepEqual(textOnly.manifest.selected.map((item) => item.id), ["instruction"]);
  assert.deepEqual(bounded.manifest.selected.map((item) => item.id), ["instruction", "process"]);
  assert.equal(textOnly.manifest.exclusionSummary.countsByReason.policyExcluded, 2);
  assert.equal(bounded.manifest.exclusionSummary.countsByReason.policyExcluded, 1);
});

test("conflicting duplicate identities fail instead of picking one", async () => {
  const first = preference("first", "same", "First value");
  const second = { ...preference("second", "same", "Second value"), dedupeKey: first.dedupeKey };
  const result = await selectTraceContextV1(selectionInput([first, second]));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "DUPLICATE_CONFLICT");
});

test("candidate ids remain unambiguous across different evidence references", async () => {
  const first = preference("same-id", "first", "First value");
  const second = { ...preference("same-id", "second", "Second value"), dedupeKey: "second" };
  const result = await selectTraceContextV1(selectionInput([first, second]));
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "MALFORMED_INPUT");
    if (result.error.code === "MALFORMED_INPUT") {
      assert.equal(result.error.path, "$.candidates[1].id");
    }
  }
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

test("host-task cancellation during a large selection returns a typed incomplete result", async () => {
  const candidates = Array.from({ length: 1_000 }, (_, index) => (
    preference(`candidate-${index}`, `ref-${index}`, `value-${index}`)
  ));
  const controller = new AbortController();
  const pending = selectTraceContextV1(selectionInput(candidates), { signal: controller.signal });
  setTimeout(() => controller.abort("test cancellation"), 0);
  const result = await pending;
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "CANCELLED");
});

test("success output is deeply frozen and rendered byte accounting is exact", async () => {
  const result = await selectTraceContextV1(selectionInput([
    preference("unicode", "unicode", "😀 café"),
  ]));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.manifest), true);
  assert.equal(Object.isFrozen(result.manifest.selected[0]), true);
  assert.equal(
    new TextEncoder().encode(result.renderedContext).length,
    result.manifest.budget.usedRenderedBytes,
  );
});

test("half-open UTF-16 source ranges survive selection without remapping", async () => {
  const input: TraceContextSelectionInputV1 = {
    version: 1,
    policy: "selected-trace-v1",
    operation: {
      version: 1,
      operation: "settle",
      target: { traceId: "trace", headId: "head", contentHash: "hash" },
      range: { fromUtf16: 0, toUtf16: 2 },
      maxContextBytes: 4_096,
      reservedPromptBytes: 0,
    },
    candidates: [{
      version: 1,
      id: "protected-emoji",
      dedupeKey: "protected-emoji",
      kind: "protected-range",
      claimClass: "explicit",
      source: {
        kind: "target",
        ref: "target:emoji",
        traceId: "trace",
        headId: "head",
        range: { fromUtf16: 0, toUtf16: 2 },
      },
      reasons: ["protected-current-range"],
      text: "😀",
    }],
  };
  const result = await selectTraceContextV1(input);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.manifest.operation.range, { fromUtf16: 0, toUtf16: 2 });
  assert.deepEqual(result.manifest.selected[0]?.source, {
    kind: "target",
    ref: "target:emoji",
    traceId: "trace",
    headId: "head",
    range: { fromUtf16: 0, toUtf16: 2 },
  });
  assert.ok(result.renderedContext.includes("😀"));
});

function selectionInput(candidates: readonly EvidenceCandidateV1[]): TraceContextSelectionInputV1 {
  return {
    version: 1,
    policy: "selected-trace-v1",
    operation: {
      version: 1,
      operation: "extend",
      target: { traceId: "trace", headId: "head", contentHash: "hash" },
      maxContextBytes: 256 * 1_024,
      reservedPromptBytes: 0,
    },
    candidates,
  };
}

function preference(id: string, ref: string, text: string): EvidenceCandidateV1 {
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

function summarize(result: TraceContextSelectionResultV1): unknown {
  if (!result.ok) {
    const error = result.error;
    return {
      ok: false,
      error: {
        code: error.code,
        stage: error.stage,
        ...(error.code === "MALFORMED_INPUT" ? { path: error.path } : {}),
        ...(error.code === "MANDATORY_BUDGET_EXCEEDED"
          ? {
              available: error.available,
              required: error.required,
              ...(error.candidateId ? { candidateId: error.candidateId } : {}),
            }
          : {}),
      },
    };
  }
  return {
    ok: true,
    selectedIds: result.manifest.selected.map((item) => item.id),
    selectedReasons: result.manifest.selected.map((item) => item.reasons),
    decisions: result.decisions.map((decision) => (
      `${decision.candidateId}:${decision.disposition}:${decision.reason}`
    )),
    exclusionCounts: result.manifest.exclusionSummary.countsByReason,
    firstBudgetRejectedRef: result.manifest.exclusionSummary.firstBudgetRejectedRef ?? null,
    budget: result.manifest.budget,
    renderedContextSha256: result.manifest.hashes.renderedContextSha256,
    frozenInputsSha256: result.manifest.hashes.frozenInputsSha256,
    manifestSha256: result.manifestSha256,
  };
}

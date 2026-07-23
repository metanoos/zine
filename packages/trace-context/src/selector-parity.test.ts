import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

import protocolCorpusJson from "../../protocol/corpus/conformance-v1.json" with { type: "json" };
import {
  summarizeTraceProcess,
  traceProcessFromEvent,
  verifyFileTraceChain,
  type ProtocolEvent,
  type TraceConformanceStatus,
} from "../../protocol/src/index.js";
import parityCorpusJson from "../corpus/selector-parity-v1.json" with { type: "json" };
import {
  projectTraceProcessCandidatesV1,
  selectTraceContextV1,
  type EvidenceCandidateV1,
  type EvidenceSelectionDecisionV1,
  type TraceContextSelectionInputV1,
  type TraceContextProcessProjectionInputV1,
  type TraceProcessFactV1,
} from "./index.js";

interface ProtocolFixture {
  name: string;
  sourceVector: string;
  expectedStatus: TraceConformanceStatus;
  signatureExpectation: "valid" | "invalid";
  chain: ProtocolEvent[];
}

interface SuccessExpected {
  ok: true;
  renderedContext: string;
  manifestSha256: string;
  selectedFacts: TraceProcessFactV1[];
  decisions: EvidenceSelectionDecisionV1[];
}

interface FailureExpected {
  ok: false;
  code: string;
  stage: string;
  candidateId?: string;
  sourceRef?: string;
}

interface ParityCase {
  name: string;
  scope: "process-adapter-projectable" | "selector-only";
  protocolFixture?: string;
  adapterFixture?: string;
  processProjection?: TraceContextProcessProjectionInputV1;
  budgetEdge?: "context-ceiling" | "request-remainder";
  input: TraceContextSelectionInputV1;
  expected: SuccessExpected | FailureExpected;
}

interface ProjectionCase {
  name: string;
  verificationBoundary: "native-neutral-non-cryptographic";
  input: TraceContextProcessProjectionInputV1;
  expectedCandidates: Extract<EvidenceCandidateV1, { kind: "process-fact" }>[];
}

interface AdapterRejectionMutation {
  name: string;
  fixture: string;
  mutation: {
    target: string;
    operation: "replace" | "replace-snapshot-preserve-id-signature";
    value: unknown;
  };
  expected: {
    accepted: false;
    reason: string;
  };
}

interface AdapterFixture {
  name: string;
  provenance: "adapter-owned-static";
  cryptographicVerification: "required-in-desktop-and-mcp-adapter-tests";
  expectedStatus: "invalid";
  expectedIssue: {
    code: "owner-changed";
    stepIndex: 1;
  };
  chain: ProtocolEvent[];
}

const corpus = parityCorpusJson as unknown as {
  format: string;
  version: 1;
  contract: string;
  projectorContract: string;
  runtimeBoundary: string;
  scopeDefinitions: Record<ParityCase["scope"], string>;
  protocolFixtures: ProtocolFixture[];
  cases: ParityCase[];
  processProjectionCases: ProjectionCase[];
  adapterRejectionMutations: AdapterRejectionMutation[];
  adapterFixtures: AdapterFixture[];
};

const protocolCorpus = protocolCorpusJson as unknown as {
  traces: Array<{
    name: string;
    status: TraceConformanceStatus;
    chain: ProtocolEvent[];
  }>;
};

const encoder = new TextEncoder();

test("selector parity corpus is strict portable JSON with the package-local boundary", async () => {
  assert.equal(corpus.format, "zine-trace-context-selector-parity");
  assert.equal(corpus.version, 1);
  assert.equal(corpus.contract, "package-local-non-normative-v1");
  assert.equal(corpus.projectorContract, "surface-neutral-process-candidates-v1");
  assert.match(corpus.runtimeBoundary, /desktop and MCP/i);
  assert.match(corpus.runtimeBoundary, /only for process-adapter-projectable cases/i);
  assert.deepEqual(
    corpus.cases.map((fixture) => fixture.name),
    [
      "two-step full trace",
      "text-only projection",
      "unicode bytes",
      "context-limited exact budget edge",
      "request-remainder-limited exact budget edge",
      "snapshot-only failure",
      "invalid trace failure",
      "trace source mismatch",
      "head source mismatch",
    ],
  );
  assert.deepEqual(
    corpus.cases.map((fixture) => fixture.scope),
    [
      "process-adapter-projectable",
      ...Array<string>(4).fill("selector-only"),
      "process-adapter-projectable",
      "process-adapter-projectable",
      "selector-only",
      "selector-only",
    ],
  );
  assert.deepEqual(Object.keys(corpus.scopeDefinitions).sort(), [
    "process-adapter-projectable",
    "selector-only",
  ]);

  const sourceUrl = new URL("../corpus/selector-parity-v1.json", import.meta.url);
  const source = await readFile(sourceUrl, "utf8");
  assert.deepEqual(JSON.parse(source), parityCorpusJson);
  assert.doesNotMatch(source, /\\u[dD][89aAbB][0-9a-fA-F]{2}/, "no lone surrogate escapes");

  const corpusPath = fileURLToPath(sourceUrl);
  for (const [command, args] of [
    ["ruby", ["-rjson", "-e", "JSON.parse(File.read(ARGV.fetch(0)))", corpusPath]],
    ["jq", ["empty", corpusPath]],
  ] as const) {
    const available = spawnSync(command, ["--version"], { encoding: "utf8" });
    if (available.error) continue;
    const parsed = spawnSync(command, args, { encoding: "utf8" });
    assert.equal(parsed.status, 0, `${command}: ${parsed.stderr}`);
  }
});

test("native-neutral projector cases pin nonzero source ids and no-op enumeration", () => {
  assert.deepEqual(
    corpus.processProjectionCases.map((fixture) => fixture.name),
    [
      "nonzero source transaction sequence uses process-array ordinals",
      "no-op range omits only zero-effect change",
    ],
  );
  for (const fixture of corpus.processProjectionCases) {
    assert.equal(fixture.verificationBoundary, "native-neutral-non-cryptographic");
    assert.deepEqual(projectTraceProcessCandidatesV1(fixture.input), fixture.expectedCandidates);
  }

  const nonzero = corpus.processProjectionCases[0]!;
  assert.equal(nonzero.input.steps[0]!.transactions[0]!.sourceTransactionId, 7);
  assert.deepEqual(
    nonzero.expectedCandidates.map((candidate) => candidate.source.transactionIndex),
    [0, 0, 0],
  );
  const noOp = corpus.processProjectionCases[1]!;
  assert.deepEqual(
    noOp.expectedCandidates.map((candidate) => candidate.fact.kind),
    ["step-summary", "transaction"],
  );
});

test("non-FULL adapter cases use the canonical neutral head-summary carrier", () => {
  const fixtures = corpus.cases.filter((fixture) =>
    fixture.scope === "process-adapter-projectable" && !fixture.processProjection);
  assert.deepEqual(fixtures.map((fixture) => fixture.name), [
    "snapshot-only failure",
    "invalid trace failure",
  ]);
  for (const fixture of fixtures) {
    const candidate = fixture.input.candidates[0];
    assert.equal(candidate?.kind, "process-fact");
    if (candidate?.kind !== "process-fact") continue;
    const ref = `trace-process-v1:${candidate.source.traceId}:${candidate.source.headId}:summary`;
    assert.equal(candidate.id, ref);
    assert.equal(candidate.dedupeKey, ref);
    assert.equal(candidate.source.ref, ref);
    assert.deepEqual(candidate.reasons, ["prepared-head-process"]);
    assert.equal(candidate.fact.kind, "step-summary");
  }
});

test("adapter rejection descriptors resolve to strict, non-inert drift mutations", async () => {
  assert.deepEqual(
    corpus.adapterRejectionMutations.map((descriptor) => descriptor.mutation.target),
    [
      "verdict.steps[1].process.transactions[0].timestamp",
      "chain[1].content",
      "read.headId",
      "processProjection.steps[0].nodeId",
      "processProjection.steps[0].chainDistance",
      "projectedCandidate.source.transactionIndex",
    ],
  );
  assert.equal(new Set(corpus.adapterRejectionMutations.map((item) => item.name)).size, 6);
  assert.equal(new Set(corpus.adapterRejectionMutations.map((item) => item.expected.reason)).size, 6);

  const fixture = corpus.protocolFixtures.find((item) => item.name === "two-step-full-trace");
  assert.ok(fixture);
  const exactEvents = new Set(fixture.chain.map(strictCanonicalJson));
  const verdict = await verifyFileTraceChain(
    fixture.chain,
    (event) => exactEvents.has(strictCanonicalJson(event)),
    {
      expectedTraceId: fixture.chain[0]?.id,
      expectedNucleusId: fixture.chain.at(-1)?.id,
    },
  );
  assert.equal(verdict.status, "full", JSON.stringify(verdict.issues));
  const processProjection = deriveProjection(fixture.chain);
  const projectedCandidate = projectTraceProcessCandidatesV1(processProjection).find(
    (candidate) => candidate.fact.kind === "transaction" && candidate.source.chainDistance === 0,
  );
  assert.ok(projectedCandidate);
  const mutationRoot: Record<string, unknown> = {
    verdict,
    chain: fixture.chain,
    read: { headId: fixture.chain.at(-1)!.id },
    processProjection,
    projectedCandidate,
  };

  for (const descriptor of corpus.adapterRejectionMutations) {
    assert.equal(descriptor.fixture, "two-step-full-trace");
    assert.equal(descriptor.expected.accepted, false);
    assert.ok(
      descriptor.mutation.operation === "replace"
        || descriptor.mutation.operation === "replace-snapshot-preserve-id-signature",
    );
    const applied = applyStrictDescriptorMutation(mutationRoot, descriptor.mutation);
    assert.notDeepEqual(applied.previousValue, applied.nextValue, descriptor.name);

    if (descriptor.mutation.operation === "replace-snapshot-preserve-id-signature") {
      const originalChain = mutationRoot.chain as readonly ProtocolEvent[];
      const mutatedChain = applied.root.chain as readonly ProtocolEvent[];
      assert.equal(mutatedChain[1]?.id, originalChain[1]?.id);
      assert.equal(mutatedChain[1]?.sig, originalChain[1]?.sig);
    }

    if (descriptor.mutation.target.startsWith("processProjection.")) {
      const invokeProjector = () => projectTraceProcessCandidatesV1(
        applied.root.processProjection as TraceContextProcessProjectionInputV1,
      );
      if (descriptor.expected.reason === "process-distance-mismatch") {
        assert.throws(invokeProjector, /distance zero must bind exactly the prepared head/);
      } else {
        // A prior-node id remains structurally valid to the surface-neutral
        // projector. Its chain binding is intentionally enforced by adapters.
        assert.doesNotThrow(invokeProjector);
      }
    }
  }

  assert.throws(
    () => applyStrictDescriptorMutation(mutationRoot, {
      target: "verdict.steps[1].process.transactions[0].capturedAtMs",
      operation: "replace",
      value: 9999999999999,
    }),
    /does not resolve to an existing property/,
  );
});

test("embedded signed fixtures remain exact protocol-owned conformance vectors", async () => {
  for (const fixture of corpus.protocolFixtures) {
    const source = protocolCorpus.traces.find((vector) => vector.name === fixture.sourceVector);
    assert.ok(source, fixture.sourceVector);
    assert.equal(source.status, fixture.expectedStatus, fixture.name);
    assert.deepEqual(fixture.chain, source.chain, fixture.name);

    for (const event of fixture.chain) {
      assert.match(event.id, /^[0-9a-f]{64}$/, `${fixture.name}: event id`);
      assert.match(event.sig, /^[0-9a-f]{128}$/, `${fixture.name}: event signature`);
      assert.equal(
        /^0+$/.test(event.sig),
        fixture.signatureExpectation === "invalid",
        `${fixture.name}: signature expectation`,
      );
    }

    // Cryptographic validation of these exact vectors is owned by the protocol
    // package suite. Here the callback trusts only byte-identical corpus events
    // so the context package can independently exercise protocol semantics.
    const exactEvents = new Set(fixture.chain.map(strictCanonicalJson));
    const verdict = await verifyFileTraceChain(
      fixture.chain,
      (event) => fixture.signatureExpectation === "valid"
        && exactEvents.has(strictCanonicalJson(event)),
      {
        expectedTraceId: fixture.chain[0]?.id,
        expectedNucleusId: fixture.chain.at(-1)?.id,
      },
    );
    assert.equal(verdict.status, fixture.expectedStatus, fixture.name);
  }
});

test("adapter-owned invalid ancestry fixture has strict hashes and a locally valid head shape", () => {
  assert.equal(corpus.adapterFixtures.length, 1);
  const fixture = corpus.adapterFixtures[0]!;
  assert.equal(fixture.name, "invalid-ancestor-valid-head");
  assert.equal(fixture.provenance, "adapter-owned-static");
  assert.equal(
    fixture.cryptographicVerification,
    "required-in-desktop-and-mcp-adapter-tests",
  );
  assert.deepEqual(fixture.expectedIssue, { code: "owner-changed", stepIndex: 1 });
  assert.equal(fixture.chain.length, 3);

  for (const [index, event] of fixture.chain.entries()) {
    assert.equal(event.kind, 4_290);
    assert.match(event.pubkey, /^[0-9a-f]{64}$/);
    assert.match(event.sig, /^[0-9a-f]{128}$/);
    assert.equal(event.tags.filter((tag) => tag[0] === "F")[0]?.[1], "essay.md");
    const expectedId = createHash("sha256")
      .update(JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content]))
      .digest("hex");
    assert.equal(event.id, expectedId);
    const previous = event.tags.filter((tag) => tag[0] === "e" && tag[3] === "prev");
    assert.equal(previous.length, index === 0 ? 0 : 1);
    if (index > 0) assert.equal(previous[0]?.[1], fixture.chain[index - 1]?.id);
  }
  assert.notEqual(fixture.chain[1]!.pubkey, fixture.chain[0]!.pubkey);
  assert.equal(fixture.chain[2]!.pubkey, fixture.chain[0]!.pubkey);

  // Signature validity is intentionally asserted only by each owning adapter,
  // where the native cryptographic dependency already exists.
  const parityCase = corpus.cases.find((item) => item.adapterFixture === fixture.name);
  assert.equal(parityCase?.name, "invalid trace failure");
  assert.equal(parityCase.input.operation.target.traceId, fixture.chain[0]!.id);
  assert.equal(parityCase.input.operation.target.headId, fixture.chain[2]!.id);
  assert.equal(parityCase.input.operation.target.chosenPath, "essay.md");
});

test("protocol-derived facts independently match every applicable selector input", () => {
  const fixtures = new Map(corpus.protocolFixtures.map((fixture) => [fixture.name, fixture]));
  for (const parityCase of corpus.cases) {
    if (!parityCase.protocolFixture || parityCase.protocolFixture === "snapshot-only") continue;
    const fixture = fixtures.get(parityCase.protocolFixture);
    assert.ok(fixture, parityCase.name);
    const derived = deriveFacts(fixture.chain);
    for (const candidate of parityCase.input.candidates) {
      if (candidate.kind !== "process-fact") continue;
      const key = factKey(candidate);
      assert.deepEqual(candidate.fact, derived.get(key), `${parityCase.name}: ${candidate.id}`);
    }
  }
});

test("the adapter-projectable selector input is exactly the shared protocol projection", () => {
  const parityCase = corpus.cases.find((fixture) => fixture.processProjection !== undefined);
  assert.ok(parityCase?.protocolFixture);
  assert.ok(parityCase.processProjection);
  const fixture = corpus.protocolFixtures.find((item) => item.name === parityCase.protocolFixture);
  assert.ok(fixture);

  const independentlyDerived = deriveProjection(fixture.chain);
  assert.deepEqual(parityCase.processProjection, independentlyDerived);
  assert.deepEqual(
    parityCase.input.candidates,
    projectTraceProcessCandidatesV1(independentlyDerived),
  );
});

for (const parityCase of corpus.cases) {
  test(`selector parity: ${parityCase.name}`, async () => {
    const result = await selectTraceContextV1(parityCase.input);
    assert.equal(result.ok, parityCase.expected.ok);
    if (!result.ok || !parityCase.expected.ok) {
      assert.equal(result.ok, false);
      assert.equal(parityCase.expected.ok, false);
      if (result.ok || parityCase.expected.ok) return;
      assert.equal(result.error.code, parityCase.expected.code);
      assert.equal(result.error.stage, parityCase.expected.stage);
      assert.equal(
        "candidateId" in result.error ? result.error.candidateId : undefined,
        parityCase.expected.candidateId,
      );
      assert.equal(
        "sourceRef" in result.error ? result.error.sourceRef : undefined,
        parityCase.expected.sourceRef,
      );
      return;
    }

    assert.equal(result.renderedContext, parityCase.expected.renderedContext);
    assert.equal(result.manifestSha256, parityCase.expected.manifestSha256);
    assert.deepEqual(
      result.manifest.selected.flatMap((item) => item.fact ? [item.fact] : []),
      parityCase.expected.selectedFacts,
    );
    assert.deepEqual(result.decisions, parityCase.expected.decisions);
    assert.equal(
      independentDomainHash(
        "zine.trace-context.package-manifest.v1",
        strictCanonicalJson(result.manifest),
      ),
      parityCase.expected.manifestSha256,
    );
    assert.equal(
      encoder.encode(result.renderedContext).length,
      result.manifest.budget.usedRenderedBytes,
    );

    if (parityCase.budgetEdge) {
      assert.equal(
        result.manifest.budget.usedRenderedBytes,
        326,
      );
      assert.equal(
        result.manifest.budget.effectiveContextBytes,
        326,
      );
      const oneByteShort = structuredClone(parityCase.input);
      if (parityCase.budgetEdge === "context-ceiling") {
        assert.equal(parityCase.input.operation.maxContextBytes, 326);
        assert.ok(
          parityCase.input.operation.preparedRequestMaxBytes
            - parityCase.input.operation.reservedPromptBytes > 326,
        );
        oneByteShort.operation.maxContextBytes -= 1;
      } else {
        assert.ok(parityCase.input.operation.maxContextBytes > 326);
        assert.equal(
          parityCase.input.operation.preparedRequestMaxBytes
            - parityCase.input.operation.reservedPromptBytes,
          326,
        );
        oneByteShort.operation.preparedRequestMaxBytes -= 1;
      }
      const shortResult = await selectTraceContextV1(oneByteShort);
      assert.equal(shortResult.ok, false);
      if (!shortResult.ok) {
        assert.equal(shortResult.error.code, "MANDATORY_BUDGET_EXCEEDED");
        assert.equal(shortResult.error.stage, "render");
      }
    }
  });
}

function deriveFacts(chain: readonly ProtocolEvent[]): Map<string, TraceProcessFactV1> {
  const facts = new Map<string, TraceProcessFactV1>();
  let previousSnapshot = "";
  for (const event of chain) {
    const process = traceProcessFromEvent(event, previousSnapshot);
    assert.equal(process.status, "complete", `${event.id}: ${process.reason}`);
    const summary = summarizeTraceProcess(process);
    facts.set(`${event.id}:summary`, {
      kind: "step-summary",
      transactionCount: summary.transactions,
      rangeCount: summary.ranges,
      insertedCodePointCount: summary.inserted,
      deletedCodePointCount: summary.deleted,
      ...(summary.firstAt === null ? {} : { firstCapturedAtMs: summary.firstAt }),
      ...(summary.lastAt === null ? {} : { lastCapturedAtMs: summary.lastAt }),
      spanMs: summary.spanMs,
      longestGapMs: summary.longestGapMs,
      undoCount: summary.undo,
      redoCount: summary.redo,
    });
    process.transactions.forEach((transaction, transactionIndex) => {
      facts.set(`${event.id}:transaction:${transactionIndex}`, {
        kind: "transaction",
        transactionIndex,
        capturedAtMs: transaction.timestamp,
        ...(transaction.intent ? { intent: transaction.intent } : {}),
        changeCount: transaction.changes.length,
        voiceIds: [...new Set(transaction.changes.map((change) => change.actor))].sort(),
      });
      transaction.changes.forEach((change, changeIndex) => {
        facts.set(`${event.id}:transaction:${transactionIndex}:change:${changeIndex}`, {
          kind: "change",
          transactionIndex,
          operation: change.op,
          range: { fromUtf16: change.from, toUtf16: change.to },
          insertedCodePointCount: [...change.inserted].length,
          deletedCodePointCount: [...change.deleted].length,
          voiceId: change.actor,
        });
      });
    });
    const parsed = JSON.parse(event.content) as { snapshot: string };
    previousSnapshot = parsed.snapshot;
  }
  return facts;
}

function deriveProjection(chain: readonly ProtocolEvent[]): TraceContextProcessProjectionInputV1 {
  assert.ok(chain.length > 0);
  let previousSnapshot = "";
  const steps = chain.map((event, eventIndex) => {
    const process = traceProcessFromEvent(event, previousSnapshot);
    assert.equal(process.status, "complete", `${event.id}: ${process.reason}`);
    const parsed = JSON.parse(event.content) as { snapshot: string };
    previousSnapshot = parsed.snapshot;
    return {
      version: 1 as const,
      nodeId: event.id,
      chainDistance: chain.length - eventIndex - 1,
      transactions: process.transactions.map((transaction) => ({
        version: 1 as const,
        sourceTransactionId: transaction.sequence,
        capturedAtMs: transaction.timestamp,
        ...(transaction.intent ? { intent: transaction.intent } : {}),
        changes: transaction.changes.map((change) => ({
          version: 1 as const,
          operation: change.op,
          range: { fromUtf16: change.from, toUtf16: change.to },
          insertedText: change.inserted,
          deletedText: change.deleted,
          voiceId: change.actor,
        })),
      })),
    };
  });
  return {
    version: 1,
    traceId: chain[0]!.id,
    headId: chain.at(-1)!.id,
    steps,
  };
}

function factKey(candidate: Extract<EvidenceCandidateV1, { kind: "process-fact" }>): string {
  const prefix = candidate.source.nodeId;
  switch (candidate.fact.kind) {
    case "step-summary": return `${prefix}:summary`;
    case "transaction": return `${prefix}:transaction:${candidate.fact.transactionIndex}`;
    case "change": {
      const changeIndex = /:change:(\d+)$/.exec(candidate.source.ref)?.[1];
      assert.ok(changeIndex, candidate.id);
      return `${prefix}:transaction:${candidate.fact.transactionIndex}:change:${changeIndex}`;
    }
  }
}

function independentDomainHash(domain: string, value: string): string {
  return createHash("sha256").update(`${domain}\0${value}`, "utf8").digest("hex");
}

function strictCanonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(strictCanonicalJson).join(",")}]`;
  assert.equal(typeof value, "object");
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${strictCanonicalJson(record[key])}`)
    .join(",")}}`;
}

function applyStrictDescriptorMutation(
  root: Record<string, unknown>,
  mutation: AdapterRejectionMutation["mutation"],
): {
  root: Record<string, unknown>;
  previousValue: unknown;
  nextValue: unknown;
} {
  const cloned = structuredClone(root);
  const path = parseDescriptorTarget(mutation.target);
  assert.ok(path.length > 0, `${mutation.target}: mutation path must not be empty`);
  let current: unknown = cloned;
  for (const segment of path.slice(0, -1)) {
    assert.ok(
      current !== null && typeof current === "object",
      `${mutation.target}: path stops before ${String(segment)}`,
    );
    const container = current as Record<string | number, unknown>;
    assert.ok(
      Object.prototype.hasOwnProperty.call(container, segment),
      `${mutation.target}: does not resolve at ${String(segment)}`,
    );
    current = container[segment];
  }

  assert.ok(
    current !== null && typeof current === "object",
    `${mutation.target}: mutation parent is not an object`,
  );
  const container = current as Record<string | number, unknown>;
  const leaf = path.at(-1)!;
  assert.ok(
    Object.prototype.hasOwnProperty.call(container, leaf),
    `${mutation.target}: does not resolve to an existing property`,
  );
  const keysBefore = Reflect.ownKeys(container);
  const previousValue = structuredClone(container[leaf]);
  const nextValue = structuredClone(mutation.value);
  assert.notDeepEqual(previousValue, nextValue, `${mutation.target}: replacement must change the value`);
  container[leaf] = nextValue;
  assert.deepEqual(
    Reflect.ownKeys(container),
    keysBefore,
    `${mutation.target}: replacement must not insert an inert property`,
  );
  return { root: cloned, previousValue, nextValue: container[leaf] };
}

function parseDescriptorTarget(target: string): readonly (string | number)[] {
  const path: (string | number)[] = [];
  for (const component of target.split(".")) {
    const match = /^([A-Za-z_$][A-Za-z0-9_$]*)(?:\[(0|[1-9][0-9]*)\])?$/.exec(component);
    assert.ok(match, `${target}: unsupported mutation path component ${component}`);
    path.push(match[1]!);
    if (match[2] !== undefined) path.push(Number(match[2]));
  }
  return path;
}

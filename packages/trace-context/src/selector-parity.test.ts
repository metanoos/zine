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
  selectTraceContextV1,
  type EvidenceCandidateV1,
  type EvidenceSelectionDecisionV1,
  type TraceContextSelectionInputV1,
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
  protocolFixture?: string;
  exactBudgetProbe?: true;
  input: TraceContextSelectionInputV1;
  expected: SuccessExpected | FailureExpected;
}

const corpus = parityCorpusJson as unknown as {
  format: string;
  version: 1;
  contract: string;
  runtimeBoundary: string;
  protocolFixtures: ProtocolFixture[];
  cases: ParityCase[];
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
  assert.match(corpus.runtimeBoundary, /desktop and MCP/i);
  assert.deepEqual(
    corpus.cases.map((fixture) => fixture.name),
    [
      "two-step full trace",
      "text-only projection",
      "unicode bytes",
      "exact rendered budget edge",
      "snapshot-only failure",
      "invalid trace failure",
      "trace source mismatch",
      "head source mismatch",
    ],
  );

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

    if (parityCase.exactBudgetProbe) {
      assert.equal(
        result.manifest.budget.usedRenderedBytes,
        parityCase.input.operation.maxContextBytes,
      );
      assert.equal(
        result.manifest.budget.effectiveContextBytes,
        parityCase.input.operation.maxContextBytes,
      );
      const oneByteShort = structuredClone(parityCase.input);
      oneByteShort.operation.maxContextBytes -= 1;
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
    for (const transaction of process.transactions) {
      facts.set(`${event.id}:tx:${transaction.tx}`, {
        kind: "transaction",
        transactionIndex: transaction.tx,
        capturedAtMs: transaction.at,
        ...(transaction.intent ? { intent: transaction.intent } : {}),
        changeCount: transaction.changes.length,
        voiceIds: [...new Set(transaction.changes.map((change) => change.voice))].sort(),
      });
      transaction.changes.forEach((change, changeIndex) => {
        facts.set(`${event.id}:tx:${transaction.tx}:change:${changeIndex}`, {
          kind: "change",
          transactionIndex: transaction.tx,
          operation: change.op === "ins" ? "insert" : change.op === "del" ? "delete" : "replace",
          range: { fromUtf16: change.from, toUtf16: change.to },
          insertedCodePointCount: [...change.inserted].length,
          deletedCodePointCount: [...change.deleted].length,
          voiceId: change.voice,
        });
      });
    }
    const parsed = JSON.parse(event.content) as { snapshot: string };
    previousSnapshot = parsed.snapshot;
  }
  return facts;
}

function factKey(candidate: Extract<EvidenceCandidateV1, { kind: "process-fact" }>): string {
  const prefix = candidate.source.nodeId;
  switch (candidate.fact.kind) {
    case "step-summary": return `${prefix}:summary`;
    case "transaction": return `${prefix}:tx:${candidate.fact.transactionIndex}`;
    case "change": {
      const changeIndex = /:change:(\d+)$/.exec(candidate.source.ref)?.[1];
      assert.ok(changeIndex, candidate.id);
      return `${prefix}:tx:${candidate.fact.transactionIndex}:change:${changeIndex}`;
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

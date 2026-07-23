import assert from "node:assert/strict";
import test from "node:test";

import type { ProtocolEvent, TraceEventVerifier } from "@zine/protocol";
import type { Event } from "nostr-tools";
import { verifyEvent as verifyNostrEvent } from "nostr-tools/pure";
import parityCorpusJson from "../../../packages/trace-context/corpus/selector-parity-v1.json" with {
  type: "json",
};
import {
  selectTraceContextV1,
  type EvidenceSelectionDecisionV1,
  type TraceContextSelectionInputV1,
  type TraceProcessFactV1,
} from "../../../packages/trace-context/src/index.js";
import {
  adaptVerifiedMcpFileForTraceContextSelectionV1,
  McpTraceContextSelectionAdapterError,
  type McpTraceContextSelectionAdapterInputV1,
} from "./trace-context-selection-adapter.js";

const GENESIS_ID = "a".repeat(64);
const CHANGE_ID = "b".repeat(64);
const HEAD_ID = "c".repeat(64);
const VOICE_ID = "d".repeat(64);
const ROOT_ID = "e".repeat(64);
const PATH = "draft.md";
const CURRENT_TEXT = "Draft revised";

function transaction(
  from: number,
  to: number,
  text: string,
  actor: string,
  timestamp: number,
  sequence: number,
): Record<string, unknown> {
  return {
    sequence,
    timestamp,
    actor,
    changes: [{
      op: from === to ? "insert" : text === "" ? "delete" : "replace",
      from,
      to,
      text,
    }],
    selectionBefore: null,
    selectionAfter: null,
  };
}

interface CorpusFixture {
  name: string;
  chain: ProtocolEvent[];
}

interface CorpusSuccessExpected {
  ok: true;
  renderedContext: string;
  manifestSha256: string;
  selectedFacts: TraceProcessFactV1[];
  decisions: EvidenceSelectionDecisionV1[];
}

interface CorpusFailureExpected {
  ok: false;
  code: string;
  stage: string;
  candidateId?: string;
  sourceRef?: string;
}

interface ProjectableCorpusCase {
  name: string;
  scope: "process-adapter-projectable" | "selector-only";
  protocolFixture?: string;
  adapterFixture?: string;
  input: TraceContextSelectionInputV1;
  expected: CorpusSuccessExpected | CorpusFailureExpected;
}

interface RejectionDescriptor {
  name: string;
  fixture: string;
  mutation: {
    target: string;
    operation: "replace" | "replace-snapshot-preserve-id-signature";
    value: unknown;
  };
  expected: { accepted: false; reason: string };
}

const parityCorpus = parityCorpusJson as unknown as {
  protocolFixtures: CorpusFixture[];
  adapterFixtures: CorpusFixture[];
  cases: ProjectableCorpusCase[];
  adapterRejectionMutations: RejectionDescriptor[];
};

const ADAPTER_CASES = [
  {
    name: "extend",
    operation: {
      version: 1,
      operation: "extend",
      maxContextBytes: 32_768,
      preparedRequestMaxBytes: 65_536,
      reservedPromptBytes: 1_024,
    },
  },
  {
    name: "settle",
    operation: {
      version: 1,
      operation: "settle",
      range: { fromUtf16: 0, toUtf16: CURRENT_TEXT.length },
      maxContextBytes: 16_384,
      preparedRequestMaxBytes: 32_768,
      reservedPromptBytes: 2_048,
    },
  },
] as const;

test("internally verifies one immutable chain and derives exact Append/Settle selector inputs", async (t) => {
  const fixture = await fullFixture();
  for (const adapterCase of ADAPTER_CASES) {
    await t.test(adapterCase.name, async () => {
      const adapted = await adaptVerifiedMcpFileForTraceContextSelectionV1({
        ...fixture.input,
        operation: adapterCase.operation,
      });
      assert.deepEqual(adapted.operation, {
        version: 1,
        operation: adapterCase.operation.operation,
        target: {
          traceId: GENESIS_ID,
          headId: HEAD_ID,
          contentHash: fixture.currentHash,
          currentText: CURRENT_TEXT,
          chosenPath: PATH,
        },
        ...("range" in adapterCase.operation
          ? { range: { ...adapterCase.operation.range } }
          : {}),
        maxContextBytes: adapterCase.operation.maxContextBytes,
        preparedRequestMaxBytes: adapterCase.operation.preparedRequestMaxBytes,
        reservedPromptBytes: adapterCase.operation.reservedPromptBytes,
      });
      assert.deepEqual(adapted.candidates.map((candidate) => candidate.id), [
        `trace-process-v1:${GENESIS_ID}:${HEAD_ID}:summary`,
        `trace-process-v1:${GENESIS_ID}:${HEAD_ID}:transaction:0`,
        `trace-process-v1:${GENESIS_ID}:${CHANGE_ID}:summary`,
        `trace-process-v1:${GENESIS_ID}:${CHANGE_ID}:transaction:0`,
        `trace-process-v1:${GENESIS_ID}:${CHANGE_ID}:transaction:0:change:0`,
        `trace-process-v1:${GENESIS_ID}:${GENESIS_ID}:summary`,
        `trace-process-v1:${GENESIS_ID}:${GENESIS_ID}:transaction:0`,
        `trace-process-v1:${GENESIS_ID}:${GENESIS_ID}:transaction:0:change:0`,
      ]);
      assert.equal(adapted.candidates.some((candidate) => candidate.id.startsWith("mcp-trace:")), false);
      assert.deepEqual(adapted.limits, {
        version: 1,
        maxCandidates: 32,
        maxInputBytes: 128 * 1_024,
      });
      const selection = await selectTraceContextV1(adapted);
      assert.equal(selection.ok, true, selection.ok ? undefined : selection.error.message);
    });
  }
});

test("matches every exported process-adapter-projectable input and selector result", async (t) => {
  const projectable = parityCorpus.cases.filter((fixture) =>
    fixture.scope === "process-adapter-projectable");
  assert.deepEqual(projectable.map((fixture) => fixture.name), [
    "two-step full trace",
    "snapshot-only failure",
    "invalid trace failure",
  ]);

  for (const fixture of projectable) {
    await t.test(fixture.name, async () => {
      const signedFixture = corpusFixture(fixture);
      assert.ok(signedFixture.chain.length > 0);
      for (const event of signedFixture.chain) {
        assert.equal(verifyNostrEvent(event as Event), true, `${fixture.name}: ${event.id}`);
      }
      const adapted = await adaptVerifiedMcpFileForTraceContextSelectionV1({
        version: 1,
        policy: fixture.input.policy,
        operation: {
          version: 1,
          operation: fixture.input.operation.operation,
          ...(fixture.input.operation.range
            ? { range: { ...fixture.input.operation.range } }
            : {}),
          maxContextBytes: fixture.input.operation.maxContextBytes,
          preparedRequestMaxBytes: fixture.input.operation.preparedRequestMaxBytes,
          reservedPromptBytes: fixture.input.operation.reservedPromptBytes,
        },
        chain: signedFixture.chain,
        verifyEvent: (event) => verifyNostrEvent(event as Event),
        ...(fixture.input.limits ? { limits: fixture.input.limits } : {}),
      });
      assert.deepEqual(adapted, fixture.input);
      await assertCorpusSelection(adapted, fixture.expected);
    });
  }
});

test("executes the applicable shared rejection descriptor at the MCP boundary", async () => {
  const descriptor = parityCorpus.adapterRejectionMutations.find(
    (item) => item.mutation.target === "chain[1].content",
  );
  assert.ok(descriptor);
  assert.equal(descriptor.expected.accepted, false);
  assert.equal(descriptor.expected.reason, "verified-chain-drift");
  const fullCase = parityCorpus.cases.find((fixture) => fixture.name === "two-step full trace");
  assert.ok(fullCase);
  const fixture = corpusFixture(fullCase);
  const chain = structuredClone(fixture.chain);
  const payload = JSON.parse(chain[1]!.content) as Record<string, unknown>;
  payload.snapshot = descriptor.mutation.value;
  chain[1]!.content = JSON.stringify(payload);
  await assert.rejects(
    adaptVerifiedMcpFileForTraceContextSelectionV1({
      version: 1,
      policy: fullCase.input.policy,
      operation: {
        version: 1,
        operation: fullCase.input.operation.operation,
        maxContextBytes: fullCase.input.operation.maxContextBytes,
        preparedRequestMaxBytes: fullCase.input.operation.preparedRequestMaxBytes,
        reservedPromptBytes: fullCase.input.operation.reservedPromptBytes,
      },
      chain,
      verifyEvent: (event) => verifyNostrEvent(event as Event),
    }),
    /head did not pass the injected trusted event verifier/,
  );
});

test("binds operation ranges to exact Unicode boundaries in the verified head snapshot", async () => {
  const currentText = "a😀雪b";
  const fixture = await snapshotOnlyFixture(currentText);
  for (const [name, range, error] of [
    [
      "past verified snapshot end",
      { fromUtf16: 0, toUtf16: currentText.length + 1 },
      /operation range must be within the verified head snapshot/,
    ],
    [
      "surrogate split at end",
      { fromUtf16: 0, toUtf16: 2 },
      /operation range must not split a UTF-16 surrogate pair/,
    ],
    [
      "surrogate split at start",
      { fromUtf16: 2, toUtf16: 4 },
      /operation range must not split a UTF-16 surrogate pair/,
    ],
  ] as const) {
    await assert.rejects(
      adaptVerifiedMcpFileForTraceContextSelectionV1({
        ...fixture,
        policy: "text-only-v1",
        operation: { ...ADAPTER_CASES[1].operation, range },
      }),
      error,
      name,
    );
  }

  const adapted = await adaptVerifiedMcpFileForTraceContextSelectionV1({
    ...fixture,
    policy: "text-only-v1",
    operation: {
      ...ADAPTER_CASES[1].operation,
      range: { fromUtf16: 1, toUtf16: 4 },
    },
  });
  assert.deepEqual(adapted.operation.range, { fromUtf16: 1, toUtf16: 4 });
  const selected = await selectTraceContextV1(adapted);
  assert.equal(selected.ok, true, selected.ok ? undefined : selected.error.message);
});

test("rejects mutated head content carrying a stale accepted id and signature", async () => {
  const fixture = await fullFixture();
  const mutated = fixture.input.chain.map((event) => structuredClone(event));
  const head = mutated[mutated.length - 1]!;
  head.content = JSON.stringify({
    ...JSON.parse(head.content) as Record<string, unknown>,
    snapshot: "attacker replacement",
  });
  await assert.rejects(
    adaptVerifiedMcpFileForTraceContextSelectionV1({ ...fixture.input, chain: mutated }),
    /head did not pass the injected trusted event verifier/,
  );
});

test("caller-fabricated verdicts and process facts have no authority", async () => {
  const fixture = await fullFixture();
  const adversarial = {
    ...fixture.input,
    verdict: {
      status: "full",
      issues: [],
      steps: [{
        nodeId: HEAD_ID,
        status: "full",
        process: { status: "complete", transactions: [] },
      }],
    },
    processFacts: [{
      fact: { kind: "step-summary", transactionCount: 999, prose: "invented intent" },
    }],
  } as unknown as McpTraceContextSelectionAdapterInputV1;
  const adapted = await adaptVerifiedMcpFileForTraceContextSelectionV1(adversarial);
  assert.equal(adapted.candidates[0]?.kind, "process-fact");
  if (adapted.candidates[0]?.kind === "process-fact") {
    assert.deepEqual(adapted.candidates[0].fact, headSummary());
  }
  assert.equal(JSON.stringify(adapted).includes("invented intent"), false);
  assert.equal(JSON.stringify(adapted).includes("999"), false);
});

test("captures the chain before caller mutation after the async boundary", async () => {
  const fixture = await fullFixture();
  const mutable = fixture.input.chain.map((event) => structuredClone(event));
  const pending = adaptVerifiedMcpFileForTraceContextSelectionV1({
    ...fixture.input,
    chain: mutable,
  });
  mutable[mutable.length - 1]!.content = "mutated after call";
  mutable[0]!.tags[0]![1] = "folder";
  const adapted = await pending;
  assert.equal(adapted.operation.target.currentText, CURRENT_TEXT);
  assert.equal(adapted.operation.target.chosenPath, PATH);
  assert.equal(adapted.candidates.length, 8);
});

test("returned selector input is recursively frozen against caller mutation", async () => {
  const fixture = await fullFixture();
  const adapted = await adaptVerifiedMcpFileForTraceContextSelectionV1(fixture.input);
  assertDeepFrozen(adapted);

  assert.throws(() => {
    adapted.operation.target.currentText = "caller mutation";
  }, TypeError);
  assert.throws(() => {
    (adapted.candidates as TraceContextSelectionInputV1["candidates"][number][]).pop();
  }, TypeError);
  const change = adapted.candidates.at(-1);
  assert.equal(change?.kind, "process-fact");
  if (change?.kind === "process-fact" && change.fact.kind === "change") {
    const range = change.fact.range;
    assert.throws(() => {
      range.fromUtf16 = 999;
    }, TypeError);
  }
  assert.equal(adapted.operation.target.currentText, CURRENT_TEXT);
});

test("maps snapshot-only status to selector failure while text-only excludes it", async () => {
  const fixture = await snapshotOnlyFixture();
  const selectedInput = await adaptVerifiedMcpFileForTraceContextSelectionV1(fixture);
  assert.equal(selectedInput.candidates[0]?.source.kind, "trace");
  if (selectedInput.candidates[0]?.source.kind === "trace") {
    assert.equal(selectedInput.candidates[0].source.processStatus, "snapshot-only");
  }
  const selected = await selectTraceContextV1(selectedInput);
  assert.equal(selected.ok, false);
  if (!selected.ok) assert.equal(selected.error.code, "CONTEXT_INCOMPLETE");

  const textOnlyInput = await adaptVerifiedMcpFileForTraceContextSelectionV1({
    ...fixture,
    policy: "text-only-v1",
  });
  const textOnly = await selectTraceContextV1(textOnlyInput);
  assert.equal(textOnly.ok, true, textOnly.ok ? undefined : textOnly.error.message);
  if (textOnly.ok) assert.equal(textOnly.manifest.selected.length, 0);
});

test("text-only drops malformed process requests before coordinate validation", async () => {
  const fixture = await fullFixture();
  const adversarial = {
    ...fixture.input,
    policy: "text-only-v1",
    processFactRequests: [{
      version: 2,
      kind: "change",
      nodeId: "not-a-node-id",
      chainDistance: -1,
      transactionIndex: -1,
      changeIndex: -1,
    }],
  } as unknown as McpTraceContextSelectionAdapterInputV1;
  const adapted = await adaptVerifiedMcpFileForTraceContextSelectionV1(adversarial);
  assert.deepEqual(adapted.candidates, []);
  const selected = await selectTraceContextV1(adapted);
  assert.equal(selected.ok, true, selected.ok ? undefined : selected.error.message);
});

test("maps invalid ancestry to selector failure when the signed head remains valid", async () => {
  const fixture = await fullFixture();
  const exactVerifier = fixture.input.verifyEvent;
  const invalidAncestorVerifier: TraceEventVerifier = (event) =>
    event.id !== GENESIS_ID && exactVerifier(event);
  const adapted = await adaptVerifiedMcpFileForTraceContextSelectionV1({
    ...fixture.input,
    verifyEvent: invalidAncestorVerifier,
  });
  assert.equal(adapted.candidates[0]?.source.kind, "trace");
  if (adapted.candidates[0]?.source.kind === "trace") {
    assert.equal(adapted.candidates[0].source.processStatus, "invalid");
  }
  const selected = await selectTraceContextV1(adapted);
  assert.equal(selected.ok, false);
  if (!selected.ok) assert.equal(selected.error.code, "INVALID_PROCESS_EVIDENCE");
});

test("deterministic enumeration keeps no-op summaries and transactions but omits change facts", async () => {
  const fixture = await fullFixture();
  const adapted = await adaptVerifiedMcpFileForTraceContextSelectionV1(fixture.input);
  const headFacts = adapted.candidates.flatMap((candidate) =>
    candidate.kind === "process-fact"
      && candidate.source.kind === "trace"
      && candidate.source.nodeId === HEAD_ID
      ? [candidate.fact]
      : []);
  assert.deepEqual(headFacts, [
    headSummary(),
    {
      kind: "transaction",
      transactionIndex: 0,
      capturedAtMs: 300,
      changeCount: 1,
      voiceIds: [VOICE_ID],
    },
  ]);
  assert.equal(headFacts.some((fact) => fact.kind === "change"), false);
});

test("preserves a verified selection-only transaction actor through the MCP boundary", async () => {
  const draftHash = await sha256("Draft");
  const chain = [
    event(GENESIS_ID, [], "Draft", draftHash, [
      transaction(0, 0, "Draft", VOICE_ID, 100, 0),
    ], "1".repeat(64)),
    event(HEAD_ID, [["e", GENESIS_ID, "", "prev"]], "Draft", draftHash, [{
      sequence: 1,
      timestamp: 200,
      actor: VOICE_ID,
      changes: [],
      selectionBefore: { ranges: [{ anchor: 0, head: 0 }], main: 0 },
      selectionAfter: { ranges: [{ anchor: 1, head: 1 }], main: 0 },
    }], "2".repeat(64)),
  ];
  const adapted = await adaptVerifiedMcpFileForTraceContextSelectionV1({
    version: 1,
    policy: "selected-trace-v1",
    operation: ADAPTER_CASES[0].operation,
    chain,
    verifyEvent: exactVectorVerifier(chain),
  });
  const transactionFact = adapted.candidates.find((candidate) =>
    candidate.kind === "process-fact"
    && candidate.source.kind === "trace"
    && candidate.source.nodeId === HEAD_ID
    && candidate.fact.kind === "transaction");

  assert.ok(
    transactionFact
    && transactionFact.kind === "process-fact"
    && transactionFact.fact.kind === "transaction",
  );
  if (
    !transactionFact
    || transactionFact.kind !== "process-fact"
    || transactionFact.fact.kind !== "transaction"
  ) return;
  assert.deepEqual(transactionFact.fact, {
    kind: "transaction",
    transactionIndex: 0,
    capturedAtMs: 200,
    changeCount: 0,
    voiceIds: [VOICE_ID],
  });
  const selected = await selectTraceContextV1(adapted);
  assert.equal(selected.ok, true, selected.ok ? undefined : selected.error.message);
  if (selected.ok) {
    assert.match(selected.renderedContext, new RegExp(`selection only · actor ${VOICE_ID}`));
  }
});

test("projects every protocol-valid FULL EditorTransaction domain value through the MCP boundary", async () => {
  const snapshot = "AB";
  const contentHash = await sha256(snapshot);
  const chain = [event(HEAD_ID, [], snapshot, contentHash, [
    {
      ...transaction(0, 0, "A", "historical writer", -Number.MAX_VALUE, 0),
    },
    {
      ...transaction(1, 1, "B", "\ud800", Number.MAX_VALUE, Number.MAX_SAFE_INTEGER + 1),
    },
  ], "5".repeat(64))];
  const adapted = await adaptVerifiedMcpFileForTraceContextSelectionV1({
    version: 1,
    policy: "selected-trace-v1",
    operation: ADAPTER_CASES[0].operation,
    chain,
    verifyEvent: exactVectorVerifier(chain),
  });
  assert.equal(adapted.candidates.length, 5);
  assert.equal(adapted.candidates[0]?.kind, "process-fact");
  if (adapted.candidates[0]?.kind === "process-fact"
    && adapted.candidates[0].fact.kind === "step-summary") {
    assert.equal(adapted.candidates[0].fact.timingStatus, "outside-summary-domain");
  }
  const selected = await selectTraceContextV1(adapted);
  assert.equal(selected.ok, true, selected.ok ? undefined : selected.error.message);
});

test("rejects malformed metadata, malformed chain shapes, bounds, and cancellation with typed errors", async () => {
  const fixture = await fullFixture();
  const malformed: unknown[] = [
    null,
    { ...fixture.input, policy: "unknown" },
    {
      ...fixture.input,
      operation: { ...ADAPTER_CASES[0].operation, operation: "settle" },
    },
    {
      ...fixture.input,
      chain: [{ ...fixture.input.chain[0], tags: null }],
    },
    {
      ...fixture.input,
      operation: {
        ...ADAPTER_CASES[0].operation,
        preparedRequestMaxBytes: 1,
        reservedPromptBytes: 2,
      },
    },
  ];
  for (const value of malformed) {
    await assert.rejects(
      adaptVerifiedMcpFileForTraceContextSelectionV1(
        value as McpTraceContextSelectionAdapterInputV1,
      ),
      McpTraceContextSelectionAdapterError,
    );
  }

  let verifierCalls = 0;
  await assert.rejects(
    adaptVerifiedMcpFileForTraceContextSelectionV1({
      ...fixture.input,
      limits: { version: 1, maxCandidates: 7 },
      verifyEvent: (event) => {
        verifierCalls += 1;
        return fixture.input.verifyEvent(event);
      },
    }),
    /candidate count exceeds the selector ceiling/,
  );
  assert.equal(verifierCalls, 0, "candidate bounds must run before cryptographic verification");
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    adaptVerifiedMcpFileForTraceContextSelectionV1({
      ...fixture.input,
      signal: controller.signal,
    }),
    /operation was cancelled/,
  );
});

interface Fixture {
  input: McpTraceContextSelectionAdapterInputV1;
  currentHash: string;
}

async function fullFixture(): Promise<Fixture> {
  const draftHash = await sha256("Draft");
  const currentHash = await sha256(CURRENT_TEXT);
  const chain: ProtocolEvent[] = [
    event(GENESIS_ID, [], "Draft", draftHash, [
      transaction(0, 0, "Draft", VOICE_ID, 100, 0),
    ], "1".repeat(64)),
    event(CHANGE_ID, [["e", GENESIS_ID, "", "prev"]], CURRENT_TEXT, currentHash, [
      transaction(5, 5, " revised", VOICE_ID, 200, 0),
    ], "2".repeat(64)),
    event(HEAD_ID, [["e", CHANGE_ID, "", "prev"]], CURRENT_TEXT, currentHash, [
      transaction(0, 0, "", VOICE_ID, 300, 0),
    ], "3".repeat(64)),
  ];
  return {
    currentHash,
    input: {
      version: 1,
      policy: "selected-trace-v1",
      operation: ADAPTER_CASES[0].operation,
      chain,
      verifyEvent: exactVectorVerifier(chain),
      limits: { version: 1, maxCandidates: 32, maxInputBytes: 128 * 1_024 },
    },
  };
}

async function snapshotOnlyFixture(
  snapshot = "Readable signed snapshot",
): Promise<McpTraceContextSelectionAdapterInputV1> {
  const contentHash = await sha256(snapshot);
  const chain = [event(HEAD_ID, [], snapshot, contentHash, undefined, "4".repeat(64))];
  return {
    version: 1,
    policy: "selected-trace-v1",
    operation: ADAPTER_CASES[0].operation,
    chain,
    verifyEvent: exactVectorVerifier(chain),
  };
}

function event(
  id: string,
  previousTags: string[][],
  snapshot: string,
  contentHash: string,
  editorTransactions: readonly Record<string, unknown>[] | undefined,
  operationId: string,
): ProtocolEvent {
  return {
    id,
    pubkey: VOICE_ID,
    created_at: 1,
    kind: 4_290,
    tags: [["z", "file"], ["f", ROOT_ID], ["F", PATH], ...previousTags],
    content: JSON.stringify({
      snapshot,
      contentHash,
      operationId,
      ...(editorTransactions === undefined ? {} : { editorTransactions }),
    }),
    sig: `signature:${id}`,
  };
}

function corpusFixture(fixture: ProjectableCorpusCase): CorpusFixture {
  const name = fixture.protocolFixture ?? fixture.adapterFixture;
  assert.ok(name, fixture.name);
  const matches = [...parityCorpus.protocolFixtures, ...parityCorpus.adapterFixtures]
    .filter((candidate) => candidate.name === name);
  assert.equal(matches.length, 1, fixture.name);
  return matches[0]!;
}

async function assertCorpusSelection(
  input: TraceContextSelectionInputV1,
  expected: CorpusSuccessExpected | CorpusFailureExpected,
): Promise<void> {
  const result = await selectTraceContextV1(input);
  assert.equal(result.ok, expected.ok);
  if (!result.ok || !expected.ok) {
    assert.equal(result.ok, false);
    assert.equal(expected.ok, false);
    if (result.ok || expected.ok) return;
    assert.equal(result.error.code, expected.code);
    assert.equal(result.error.stage, expected.stage);
    assert.equal(
      "candidateId" in result.error ? result.error.candidateId : undefined,
      expected.candidateId,
    );
    assert.equal(
      "sourceRef" in result.error ? result.error.sourceRef : undefined,
      expected.sourceRef,
    );
    return;
  }
  assert.equal(result.renderedContext, expected.renderedContext);
  assert.equal(result.manifestSha256, expected.manifestSha256);
  assert.deepEqual(result.decisions, expected.decisions);
  assert.deepEqual(
    result.manifest.selected.flatMap((item) => item.fact ? [item.fact] : []),
    expected.selectedFacts,
  );
}

function exactVectorVerifier(chain: readonly ProtocolEvent[]): TraceEventVerifier {
  const accepted = new Set(chain.map(eventIdentity));
  return (candidate) => accepted.has(eventIdentity(candidate));
}

function eventIdentity(event: ProtocolEvent): string {
  return JSON.stringify([
    event.id,
    event.pubkey,
    event.created_at,
    event.kind,
    event.tags,
    event.content,
    event.sig,
  ]);
}

function assertDeepFrozen(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) assertDeepFrozen(child);
}

function headSummary(): TraceProcessFactV1 {
  return {
    kind: "step-summary",
    transactionCount: 1,
    rangeCount: 1,
    insertedCodePointCount: 0,
    deletedCodePointCount: 0,
    firstCapturedAtMs: 300,
    lastCapturedAtMs: 300,
    spanMs: 0,
    longestGapMs: 0,
    undoCount: 0,
    redoCount: 0,
  };
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

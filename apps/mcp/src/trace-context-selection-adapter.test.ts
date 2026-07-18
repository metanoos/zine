import assert from "node:assert/strict";
import test from "node:test";

import type { ProtocolEvent, TraceEventVerifier } from "@zine/protocol";
import {
  selectTraceContextV1,
  type TraceContextSelectionInputV1,
  type TraceProcessFactV1,
} from "../../../packages/trace-context/src/index.js";
import {
  adaptVerifiedMcpFileForTraceContextSelectionV1,
  type McpProcessFactRequestV1,
  type McpTraceContextSelectionAdapterInputV1,
} from "./trace-context-selection-adapter.js";

const GENESIS_ID = "a".repeat(64);
const CHANGE_ID = "b".repeat(64);
const HEAD_ID = "c".repeat(64);
const VOICE_ID = "d".repeat(64);
const ROOT_ID = "e".repeat(64);
const PATH = "draft.md";
const CURRENT_TEXT = "Draft revised";

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

test("internally verifies one immutable chain and derives exact Extend/Settle selector inputs", async (t) => {
  const fixture = await fullFixture();
  for (const adapterCase of ADAPTER_CASES) {
    await t.test(adapterCase.name, async () => {
      const adapted = await adaptVerifiedMcpFileForTraceContextSelectionV1({
        ...fixture.input,
        operation: adapterCase.operation,
      });
      const expected: TraceContextSelectionInputV1 = {
        version: 1,
        policy: "selected-trace-v1",
        operation: {
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
        },
        candidates: [
          expectedCandidate(HEAD_ID, 0, 0, "summary", headSummary()),
          expectedCandidate(CHANGE_ID, 1, 0, "summary", changeSummary()),
          expectedCandidate(CHANGE_ID, 1, 0, "transaction:0", {
            kind: "transaction",
            transactionIndex: 0,
            capturedAtMs: 200,
            changeCount: 1,
            voiceIds: [VOICE_ID],
          }),
          expectedCandidate(CHANGE_ID, 1, 0, "transaction:0:change:0", {
            kind: "change",
            transactionIndex: 0,
            operation: "insert",
            range: { fromUtf16: 5, toUtf16: 5 },
            insertedCodePointCount: 8,
            deletedCodePointCount: 0,
            voiceId: VOICE_ID,
          }, { fromUtf16: 5, toUtf16: 5 }),
        ],
        limits: { version: 1, maxCandidates: 32, maxInputBytes: 128 * 1_024 },
      };
      assert.deepEqual(adapted, expected);
      const selection = await selectTraceContextV1(adapted);
      assert.equal(selection.ok, true, selection.ok ? undefined : selection.error.message);
    });
  }
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
  assert.equal(adapted.candidates.length, fixture.input.processFactRequests.length);
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
  const malformedRequests = [{
    version: 2,
    kind: "change",
    nodeId: "not-a-node-id",
    chainDistance: -1,
    transactionIndex: -1,
    changeIndex: -1,
  }] as unknown as readonly McpProcessFactRequestV1[];
  const adapted = await adaptVerifiedMcpFileForTraceContextSelectionV1({
    ...fixture.input,
    policy: "text-only-v1",
    processFactRequests: malformedRequests,
  });
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

test("no-op ranges support derived summaries and transactions but not change facts", async () => {
  const fixture = await fullFixture();
  const summaryAndTransaction = await adaptVerifiedMcpFileForTraceContextSelectionV1({
    ...fixture.input,
    processFactRequests: [
      request(HEAD_ID, 0, "step-summary"),
      request(HEAD_ID, 0, "transaction", 0),
    ],
  });
  assert.deepEqual(summaryAndTransaction.candidates.map((candidate) => {
    assert.equal(candidate.kind, "process-fact");
    return candidate.kind === "process-fact" ? candidate.fact : undefined;
  }), [
    headSummary(),
    {
      kind: "transaction",
      transactionIndex: 0,
      capturedAtMs: 300,
      changeCount: 1,
      voiceIds: [VOICE_ID],
    },
  ]);

  await assert.rejects(
    adaptVerifiedMcpFileForTraceContextSelectionV1({
      ...fixture.input,
      processFactRequests: [request(HEAD_ID, 0, "change", 0, 0)],
    }),
    /no-op range has no selector change-fact shape/,
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
    event(GENESIS_ID, [], "Draft", draftHash, [{
      op: "ins", from: 0, to: 0, text: "Draft", voice: VOICE_ID, t: 100, tx: 0,
    }], "1".repeat(64)),
    event(CHANGE_ID, [["e", GENESIS_ID, "", "prev"]], CURRENT_TEXT, currentHash, [{
      op: "ins", from: 5, to: 5, text: " revised", voice: VOICE_ID, t: 200, tx: 0,
    }], "2".repeat(64)),
    event(HEAD_ID, [["e", CHANGE_ID, "", "prev"]], CURRENT_TEXT, currentHash, [{
      op: "ins", from: 0, to: 0, text: "", voice: VOICE_ID, t: 300, tx: 0,
    }], "3".repeat(64)),
  ];
  return {
    currentHash,
    input: {
      version: 1,
      policy: "selected-trace-v1",
      operation: ADAPTER_CASES[0].operation,
      chain,
      verifyEvent: exactVectorVerifier(chain),
      processFactRequests: [
        request(HEAD_ID, 0, "step-summary"),
        request(CHANGE_ID, 1, "step-summary"),
        request(CHANGE_ID, 1, "transaction", 0),
        request(CHANGE_ID, 1, "change", 0, 0),
      ],
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
    processFactRequests: [request(HEAD_ID, 0, "step-summary")],
  };
}

function event(
  id: string,
  previousTags: string[][],
  snapshot: string,
  contentHash: string,
  kedits: readonly Record<string, unknown>[] | undefined,
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
      ...(kedits === undefined ? {} : { kedits }),
    }),
    sig: `signature:${id}`,
  };
}

function request(
  nodeId: string,
  chainDistance: number,
  kind: McpProcessFactRequestV1["kind"],
  transactionIndex?: number,
  changeIndex?: number,
): McpProcessFactRequestV1 {
  if (kind === "step-summary") return { version: 1, kind, nodeId, chainDistance };
  if (kind === "transaction") {
    return { version: 1, kind, nodeId, chainDistance, transactionIndex: transactionIndex! };
  }
  return {
    version: 1,
    kind,
    nodeId,
    chainDistance,
    transactionIndex: transactionIndex!,
    changeIndex: changeIndex!,
  };
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

function changeSummary(): TraceProcessFactV1 {
  return {
    kind: "step-summary",
    transactionCount: 1,
    rangeCount: 1,
    insertedCodePointCount: 8,
    deletedCodePointCount: 0,
    firstCapturedAtMs: 200,
    lastCapturedAtMs: 200,
    spanMs: 0,
    longestGapMs: 0,
    undoCount: 0,
    redoCount: 0,
  };
}

function expectedCandidate(
  nodeId: string,
  chainDistance: number,
  transactionIndex: number,
  suffix: string,
  fact: TraceProcessFactV1,
  range?: Utf16Range,
): TraceContextSelectionInputV1["candidates"][number] {
  const ref = `mcp-trace:${GENESIS_ID}:${nodeId}:${suffix}`;
  return {
    version: 1,
    id: ref,
    dedupeKey: ref,
    kind: "process-fact",
    claimClass: "mechanical",
    source: {
      kind: "trace",
      ref,
      traceId: GENESIS_ID,
      headId: HEAD_ID,
      nodeId,
      processStatus: "full-trace",
      chainDistance,
      transactionIndex,
      ...(range ? { range } : {}),
    },
    reasons: [chainDistance === 0 ? "prepared-head-process" : "recent-target-process"],
    fact,
  };
}

interface Utf16Range {
  fromUtf16: number;
  toUtf16: number;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

import assert from "node:assert/strict";
import test from "node:test";

import {
  verifyFileTraceChain,
  type ProtocolEvent,
} from "@zine/protocol";
import {
  selectTraceContextV1,
  type TraceContextSelectionInputV1,
  type TraceProcessFactV1,
} from "../../../packages/trace-context/src/index.js";
import {
  adaptVerifiedMcpFileForTraceContextSelectionV1,
  type McpBoundProcessFactV1,
  type McpTraceContextSelectionAdapterInputV1,
} from "./trace-context-selection-adapter.js";

const GENESIS_ID = "a".repeat(64);
const CHANGE_ID = "b".repeat(64);
const HEAD_ID = "c".repeat(64);
const VOICE_ID = "d".repeat(64);
const ROOT_ID = "e".repeat(64);
const PATH = "draft.md";
const CURRENT_TEXT = "Draft revised";

const HEAD_SUMMARY: TraceProcessFactV1 = {
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

const CHANGE_SUMMARY: TraceProcessFactV1 = {
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

const CHANGE_TRANSACTION: TraceProcessFactV1 = {
  kind: "transaction",
  transactionIndex: 0,
  capturedAtMs: 200,
  changeCount: 1,
  voiceIds: [VOICE_ID],
};

const CHANGE_FACT: TraceProcessFactV1 = {
  kind: "change",
  transactionIndex: 0,
  operation: "insert",
  range: { fromUtf16: 5, toUtf16: 5 },
  insertedCodePointCount: 8,
  deletedCodePointCount: 0,
  voiceId: VOICE_ID,
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

test("maps verified MCP Extend/Settle fixtures into exact selector inputs", async (t) => {
  const fixture = await verifiedFixture();
  for (const adapterCase of ADAPTER_CASES) {
    await t.test(adapterCase.name, async () => {
      const adapterInput: McpTraceContextSelectionAdapterInputV1 = {
        ...fixture,
        version: 1,
        policy: "selected-trace-v1",
        operation: adapterCase.operation,
      };
      const adapted = adaptVerifiedMcpFileForTraceContextSelectionV1(adapterInput);
      const expected: TraceContextSelectionInputV1 = {
        version: 1,
        policy: "selected-trace-v1",
        operation: {
          version: 1,
          operation: adapterCase.operation.operation,
          target: {
            traceId: GENESIS_ID,
            headId: HEAD_ID,
            contentHash: fixture.read.contentHash,
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
          expectedCandidate(HEAD_ID, 0, 0, HEAD_SUMMARY, "summary"),
          expectedCandidate(CHANGE_ID, 1, 0, CHANGE_SUMMARY, "summary"),
          expectedCandidate(CHANGE_ID, 1, 0, CHANGE_TRANSACTION, "transaction:0"),
          expectedCandidate(CHANGE_ID, 1, 0, CHANGE_FACT, "transaction:0:change:0", {
            fromUtf16: 5,
            toUtf16: 5,
          }),
        ],
        limits: {
          version: 1,
          maxCandidates: 32,
          maxInputBytes: 128 * 1_024,
        },
      };
      assert.deepEqual(adapted, expected);
      assert.deepEqual(JSON.parse(JSON.stringify(adapted)), expected);

      const selection = await selectTraceContextV1(adapted);
      assert.equal(
        selection.ok,
        true,
        selection.ok ? undefined : `${selection.error.code}: ${selection.error.message}`,
      );
    });
  }
});

test("fails closed when verification, read, or process bindings drift", async (t) => {
  const fixture = await verifiedFixture();
  const baseline: McpTraceContextSelectionAdapterInputV1 = {
    ...fixture,
    version: 1,
    policy: "selected-trace-v1",
    operation: ADAPTER_CASES[0].operation,
  };

  const cases: readonly {
    name: string;
    input: McpTraceContextSelectionAdapterInputV1;
    message: RegExp;
  }[] = [
    {
      name: "non-Full-Trace verdict",
      input: { ...baseline, verdict: { ...baseline.verdict, status: "snapshot-only" } },
      message: /verdict must be full/,
    },
    {
      name: "verdict-to-chain mismatch",
      input: {
        ...baseline,
        verdict: {
          ...baseline.verdict,
          steps: baseline.verdict.steps.map((step, index) =>
            index === 1 ? { ...step, nodeId: "f".repeat(64) } : step),
        },
      },
      message: /does not bind the supplied chain/,
    },
    {
      name: "read snapshot mismatch",
      input: { ...baseline, read: { ...baseline.read, currentText: "drifted" } },
      message: /current text does not bind/,
    },
    {
      name: "target head mismatch",
      input: {
        ...baseline,
        processFacts: baseline.processFacts.map((binding, index) =>
          index === 0 ? { ...binding, headId: "f".repeat(64) } : binding),
      },
      message: /exact target trace and head/,
    },
    {
      name: "node-distance mismatch",
      input: {
        ...baseline,
        processFacts: baseline.processFacts.map((binding, index) =>
          index === 1 ? { ...binding, chainDistance: 2 } : binding),
      },
      message: /node and distance/,
    },
    {
      name: "transaction binding mismatch",
      input: {
        ...baseline,
        processFacts: baseline.processFacts.map((binding, index) =>
          index === 2 ? { ...binding, transactionIndex: 1 } : binding),
      },
      message: /transaction index does not bind/,
    },
    {
      name: "closed fact mismatch",
      input: {
        ...baseline,
        processFacts: baseline.processFacts.map((binding, index) =>
          index === 1
            ? {
                ...binding,
                fact: { ...CHANGE_SUMMARY, insertedCodePointCount: 7 },
              }
            : binding),
      },
      message: /closed process fact does not exactly match/,
    },
    {
      name: "caller-authored process prose",
      input: {
        ...baseline,
        processFacts: baseline.processFacts.map((binding, index) =>
          index === 1
            ? {
                ...binding,
                fact: { ...CHANGE_SUMMARY, prose: "the writer intended this" } as TraceProcessFactV1,
              }
            : binding),
      },
      message: /closed process fact does not exactly match/,
    },
  ];

  for (const fixtureCase of cases) {
    await t.test(fixtureCase.name, () => {
      assert.throws(
        () => adaptVerifiedMcpFileForTraceContextSelectionV1(fixtureCase.input),
        fixtureCase.message,
      );
    });
  }
});

test("represents verified no-op ranges only through selector-supported facts", async () => {
  const fixture = await verifiedFixture();
  const noOpChange: McpBoundProcessFactV1 = {
    version: 1,
    traceId: GENESIS_ID,
    headId: HEAD_ID,
    nodeId: HEAD_ID,
    chainDistance: 0,
    transactionIndex: 0,
    changeIndex: 0,
    fact: {
      kind: "change",
      transactionIndex: 0,
      operation: "insert",
      range: { fromUtf16: 0, toUtf16: 0 },
      insertedCodePointCount: 0,
      deletedCodePointCount: 0,
      voiceId: VOICE_ID,
    },
  };
  assert.throws(
    () => adaptVerifiedMcpFileForTraceContextSelectionV1({
      ...fixture,
      version: 1,
      policy: "selected-trace-v1",
      operation: ADAPTER_CASES[0].operation,
      processFacts: [noOpChange],
    }),
    /no-op range has no selector change-fact shape/,
  );
  assert.doesNotThrow(() => adaptVerifiedMcpFileForTraceContextSelectionV1({
    ...fixture,
    version: 1,
    policy: "selected-trace-v1",
    operation: ADAPTER_CASES[0].operation,
    processFacts: [fixture.processFacts[0]!],
  }));
});

async function verifiedFixture(): Promise<Pick<
  McpTraceContextSelectionAdapterInputV1,
  "read" | "chain" | "verdict" | "processFacts" | "limits"
>> {
  const draftHash = await sha256("Draft");
  const currentHash = await sha256(CURRENT_TEXT);
  const chain: readonly ProtocolEvent[] = [
    event(GENESIS_ID, [], "Draft", draftHash, [{
      op: "ins",
      from: 0,
      to: 0,
      text: "Draft",
      voice: VOICE_ID,
      t: 100,
      tx: 0,
    }], "1".repeat(64)),
    event(CHANGE_ID, [["e", GENESIS_ID, "", "prev"]], CURRENT_TEXT, currentHash, [{
      op: "ins",
      from: 5,
      to: 5,
      text: " revised",
      voice: VOICE_ID,
      t: 200,
      tx: 0,
    }], "2".repeat(64)),
    event(HEAD_ID, [["e", CHANGE_ID, "", "prev"]], CURRENT_TEXT, currentHash, [{
      op: "ins",
      from: 0,
      to: 0,
      text: "",
      voice: VOICE_ID,
      t: 300,
      tx: 0,
    }], "3".repeat(64)),
  ];
  const verdict = await verifyFileTraceChain(chain, () => true, {
    expectedOwnerPubkey: VOICE_ID,
    expectedRootId: ROOT_ID,
    expectedRelativePath: PATH,
    expectedNucleusId: HEAD_ID,
    expectedTraceId: GENESIS_ID,
  });
  assert.equal(verdict.status, "full", JSON.stringify(verdict.issues));
  const processFacts: readonly McpBoundProcessFactV1[] = [
    binding(HEAD_ID, 0, 0, HEAD_SUMMARY),
    binding(CHANGE_ID, 1, 0, CHANGE_SUMMARY),
    binding(CHANGE_ID, 1, 0, CHANGE_TRANSACTION),
    { ...binding(CHANGE_ID, 1, 0, CHANGE_FACT), changeIndex: 0 },
  ];
  return {
    read: {
      version: 1,
      traceId: GENESIS_ID,
      headId: HEAD_ID,
      contentHash: currentHash,
      currentText: CURRENT_TEXT,
      chosenPath: PATH,
    },
    chain,
    verdict,
    processFacts,
    limits: {
      version: 1,
      maxCandidates: 32,
      maxInputBytes: 128 * 1_024,
    },
  };
}

function event(
  id: string,
  previousTags: string[][],
  snapshot: string,
  contentHash: string,
  kedits: readonly Record<string, unknown>[],
  operationId: string,
): ProtocolEvent {
  return {
    id,
    pubkey: VOICE_ID,
    created_at: 1,
    kind: 4_290,
    tags: [
      ["z", "file"],
      ["f", ROOT_ID],
      ["F", PATH],
      ...previousTags,
    ],
    content: JSON.stringify({ snapshot, contentHash, operationId, kedits }),
    sig: "signature",
  };
}

function binding(
  nodeId: string,
  chainDistance: number,
  transactionIndex: number,
  fact: TraceProcessFactV1,
): McpBoundProcessFactV1 {
  return {
    version: 1,
    traceId: GENESIS_ID,
    headId: HEAD_ID,
    nodeId,
    chainDistance,
    transactionIndex,
    fact,
  };
}

function expectedCandidate(
  nodeId: string,
  chainDistance: number,
  transactionIndex: number,
  fact: TraceProcessFactV1,
  suffix: string,
  range?: { fromUtf16: number; toUtf16: number },
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

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

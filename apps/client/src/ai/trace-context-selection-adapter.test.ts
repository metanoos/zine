import assert from "node:assert/strict";
import test from "node:test";

import type { Event, EventTemplate } from "nostr-tools";
import { finalizeEvent, getPublicKey, verifyEvent } from "nostr-tools/pure";

import type { ProtocolEvent } from "@zine/protocol";
import { selectTraceContextV1 } from "@zine/trace-context";

import {
  adaptDesktopTraceContextSelectionV1,
  DesktopTraceContextSelectionAdapterError,
  type DesktopProcessFactRequestV1,
  type DesktopTraceContextOperationMetadataV1,
  type DesktopTraceContextSelectionAdapterInputV1,
} from "./trace-context-selection-adapter.js";

const SECRET = Uint8Array.from([...new Uint8Array(31), 1]);
const OWNER = getPublicKey(SECRET);
const ROOT_ID = "f".repeat(64);
const OPERATION_ID = "1".repeat(64);
const PATH = "draft.md";

interface FileNodeOptions {
  path?: string;
  kedits?: unknown;
  omitKedits?: boolean;
  tx?: number;
  at?: number;
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Buffer.from(digest).toString("hex");
}

async function fileNode(
  before: string,
  snapshot: string,
  previous?: Event,
  options: FileNodeOptions = {},
): Promise<Event> {
  const at = options.at ?? 1_700_000_000_000 + (previous ? 1 : 0);
  const tx = options.tx ?? 17;
  const defaultKedits = before === snapshot
    ? []
    : [{
        op: before.length === 0 ? "ins" : snapshot.length === 0 ? "del" : "repl",
        from: 0,
        to: before.length,
        text: snapshot,
        voice: OWNER,
        t: at,
        tx,
      }];
  const template: EventTemplate = {
    kind: 4290,
    created_at: 1_700_000_000 + (previous ? 1 : 0),
    tags: [
      ["z", "file"],
      ["F", options.path ?? PATH],
      ["f", ROOT_ID],
      ["action", previous ? "edit" : "import"],
      ...(previous ? [["e", previous.id, "", "prev"]] : []),
    ],
    content: JSON.stringify({
      snapshot,
      contentHash: await sha256(snapshot),
      operationId: OPERATION_ID,
      ...(options.omitKedits ? {} : { kedits: options.kedits ?? defaultKedits }),
    }),
  };
  return finalizeEvent(template, SECRET);
}

async function fullChain(): Promise<readonly [Event, Event]> {
  const genesis = await fileNode("", "Draft", undefined, { at: 1_000, tx: 17 });
  const head = await fileNode("Draft", "Current 🧠 draft", genesis, { at: 2_000, tx: 41 });
  return [genesis, head];
}

function mutableChain(chain: readonly ProtocolEvent[]): ProtocolEvent[] {
  return structuredClone([...chain]);
}

const FULL_FACT_REQUESTS: readonly DesktopProcessFactRequestV1[] = [
  { version: 1, kind: "step-summary", chainDistance: 0 },
  { version: 1, kind: "transaction", chainDistance: 0, transactionIndex: 0 },
  { version: 1, kind: "change", chainDistance: 1, transactionIndex: 0, changeIndex: 0 },
];

function operation(
  overrides: Partial<DesktopTraceContextOperationMetadataV1> = {},
): DesktopTraceContextOperationMetadataV1 {
  return {
    version: 1,
    operation: "extend",
    maxContextBytes: 16_384,
    preparedRequestMaxBytes: 300_000,
    reservedPromptBytes: 1_024,
    ...overrides,
  };
}

function input(
  chain: readonly ProtocolEvent[],
  overrides: Partial<DesktopTraceContextSelectionAdapterInputV1> = {},
): DesktopTraceContextSelectionAdapterInputV1 {
  return {
    version: 1,
    policy: "selected-trace-v1",
    operation: operation(),
    chain,
    verifyEvent,
    processFacts: FULL_FACT_REQUESTS,
    limits: { version: 1, maxCandidates: 24 },
    ...overrides,
  };
}

test("derives the target and ordinal mechanical facts from one internally verified signed clone", async () => {
  const chain = await fullChain();
  const result = await adaptDesktopTraceContextSelectionV1(input(chain));
  const headPayload = JSON.parse(chain[1].content) as { contentHash: string };

  assert.deepEqual(result.operation.target, {
    traceId: chain[0].id,
    headId: chain[1].id,
    contentHash: headPayload.contentHash,
    currentText: "Current 🧠 draft",
    chosenPath: PATH,
  });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.operation), true);
  assert.equal(Object.isFrozen(result.operation.target), true);
  assert.equal(Object.isFrozen(result.candidates), true);
  assert.equal(Object.isFrozen(result.candidates[0]), true);
  assert.deepEqual(result.candidates.map((candidate) => ({
    kind: candidate.kind,
    status: candidate.source.kind === "trace" ? candidate.source.processStatus : undefined,
    transactionIndex: candidate.source.kind === "trace" ? candidate.source.transactionIndex : undefined,
    fact: candidate.kind === "process-fact" ? candidate.fact : undefined,
  })), [
    {
      kind: "process-fact",
      status: "full-trace",
      transactionIndex: 0,
      fact: {
        kind: "step-summary",
        transactionCount: 1,
        rangeCount: 1,
        insertedCodePointCount: 15,
        deletedCodePointCount: 5,
        firstCapturedAtMs: 2_000,
        lastCapturedAtMs: 2_000,
        spanMs: 0,
        longestGapMs: 0,
        undoCount: 0,
        redoCount: 0,
      },
    },
    {
      kind: "process-fact",
      status: "full-trace",
      transactionIndex: 0,
      fact: {
        kind: "transaction",
        transactionIndex: 0,
        capturedAtMs: 2_000,
        changeCount: 1,
        voiceIds: [OWNER],
      },
    },
    {
      kind: "process-fact",
      status: "full-trace",
      transactionIndex: 0,
      fact: {
        kind: "change",
        transactionIndex: 0,
        operation: "insert",
        range: { fromUtf16: 0, toUtf16: 0 },
        insertedCodePointCount: 5,
        deletedCodePointCount: 0,
        voiceId: OWNER,
      },
    },
  ]);

  const selection = await selectTraceContextV1(result);
  assert.equal(selection.ok, true, selection.ok ? undefined : selection.error.message);
});

test("ignores fabricated verdict authority and rejects unsigned head/text/hash/path/process mutations", async () => {
  const signed = await fullChain();
  const fabricated = input(signed) as DesktopTraceContextSelectionAdapterInputV1 & { verdict: unknown };
  fabricated.verdict = {
    status: "full",
    issues: [],
    steps: [{
      nodeId: signed[1].id,
      stepIndex: 0,
      status: "full",
      process: { status: "complete", transactions: [] },
    }],
  };
  const baseline = await adaptDesktopTraceContextSelectionV1(fabricated);
  assert.equal(baseline.operation.target.currentText, "Current 🧠 draft");
  assert.equal(baseline.candidates.length, 3);

  const cases: readonly [string, (chain: ProtocolEvent[]) => void][] = [
    ["signature", (chain) => { chain[1]!.sig = "0".repeat(128); }],
    ["text", (chain) => {
      const payload = JSON.parse(chain[1]!.content) as Record<string, unknown>;
      payload.snapshot = "UNSIGNED TEXT";
      chain[1]!.content = JSON.stringify(payload);
    }],
    ["hash", (chain) => {
      const payload = JSON.parse(chain[1]!.content) as Record<string, unknown>;
      payload.contentHash = "0".repeat(64);
      chain[1]!.content = JSON.stringify(payload);
    }],
    ["path", (chain) => {
      chain[1]!.tags.find((tag) => tag[0] === "F")![1] = "forged.md";
    }],
    ["process", (chain) => {
      const payload = JSON.parse(chain[1]!.content) as { kedits: unknown[] };
      payload.kedits = [];
      chain[1]!.content = JSON.stringify(payload);
    }],
  ];
  for (const [name, mutate] of cases) {
    const chain = mutableChain(signed);
    mutate(chain);
    await assert.rejects(
      adaptDesktopTraceContextSelectionV1(input(chain)),
      DesktopTraceContextSelectionAdapterError,
      name,
    );
  }
});

test("captures the entire signed chain before the verifier can yield", async () => {
  const signed = await fullChain();
  const mutable = mutableChain(signed);
  const source = input(mutable);
  const pending = adaptDesktopTraceContextSelectionV1(source);

  mutable[0]!.sig = "0".repeat(128);
  mutable[1]!.content = JSON.stringify({
    snapshot: "MUTATED AFTER CALL",
    contentHash: "0".repeat(64),
    operationId: OPERATION_ID,
    kedits: [],
  });
  mutable[1]!.tags.find((tag) => tag[0] === "F")![1] = "mutated.md";
  source.policy = "text-only-v1";
  source.operation.maxContextBytes = 1;
  (source.processFacts as DesktopProcessFactRequestV1[]).length = 0;
  if (source.limits) source.limits.maxCandidates = 1;

  const result = await pending;
  assert.equal(result.policy, "selected-trace-v1");
  assert.equal(result.operation.maxContextBytes, 16_384);
  assert.equal(result.limits?.maxCandidates, 24);
  assert.equal(result.operation.target.currentText, "Current 🧠 draft");
  assert.equal(result.operation.target.chosenPath, PATH);
  assert.equal(result.operation.target.traceId, signed[0].id);
  assert.equal(result.operation.target.headId, signed[1].id);
  assert.equal(result.candidates.length, 3);
});

test("rejects out-of-bounds and surrogate-splitting operation ranges against signed current text", async () => {
  const node = await fileNode("", "A🧠B");
  for (const range of [
    { fromUtf16: 0, toUtf16: 99 },
    { fromUtf16: 2, toUtf16: 3 },
  ]) {
    await assert.rejects(
      adaptDesktopTraceContextSelectionV1(input([node], {
        operation: operation({ operation: "settle", range }),
        processFacts: [],
      })),
      /within the signed current text on UTF-16 code-point boundaries/,
    );
  }

  await assert.doesNotReject(adaptDesktopTraceContextSelectionV1(input([node], {
    operation: operation({ operation: "settle", range: { fromUtf16: 1, toUtf16: 3 } }),
    processFacts: [],
  })));
});

test("preserves zero request remainder for the selector's typed budget failure", async () => {
  const chain = await fullChain();
  const adapted = await adaptDesktopTraceContextSelectionV1(input(chain, {
    operation: operation({
      maxContextBytes: 1_000,
      preparedRequestMaxBytes: 64,
      reservedPromptBytes: 64,
    }),
    processFacts: [],
  }));
  const selection = await selectTraceContextV1(adapted);
  assert.equal(selection.ok, false);
  if (!selection.ok) {
    assert.equal(selection.error.code, "MANDATORY_BUDGET_EXCEEDED");
    assert.equal(selection.error.available, 0);
  }
});

test("maps snapshot-only process to a typed selected-trace failure and text-only projection", async () => {
  const snapshot = await fileNode("", "Readable snapshot", undefined, { omitKedits: true });
  const selectedInput = await adaptDesktopTraceContextSelectionV1(input([snapshot], {
    processFacts: [{ version: 1, kind: "step-summary", chainDistance: 0 }],
  }));
  assert.equal(selectedInput.candidates[0]?.source.kind, "trace");
  if (selectedInput.candidates[0]?.source.kind === "trace") {
    assert.equal(selectedInput.candidates[0].source.processStatus, "snapshot-only");
  }
  const selected = await selectTraceContextV1(selectedInput);
  assert.equal(selected.ok, false);
  if (!selected.ok) assert.equal(selected.error.code, "CONTEXT_INCOMPLETE");

  const textOnlyInput = await adaptDesktopTraceContextSelectionV1(input([snapshot], {
    policy: "text-only-v1",
    processFacts: [{
      version: 1,
      kind: "change",
      chainDistance: 99,
      transactionIndex: 99,
      changeIndex: 99,
    }],
  }));
  assert.deepEqual(textOnlyInput.candidates, []);
  const textOnly = await selectTraceContextV1(textOnlyInput);
  assert.equal(textOnly.ok, true, textOnly.ok ? undefined : textOnly.error.message);
});

test("maps invalid ancestry to invalid process without trusting an unsigned target head", async () => {
  const signed = await fullChain();
  const invalidAncestor = mutableChain(signed);
  invalidAncestor[0]!.sig = "0".repeat(128);
  const adapted = await adaptDesktopTraceContextSelectionV1(input(invalidAncestor, {
    processFacts: [{ version: 1, kind: "step-summary", chainDistance: 0 }],
  }));
  assert.equal(adapted.candidates[0]?.source.kind, "trace");
  if (adapted.candidates[0]?.source.kind === "trace") {
    assert.equal(adapted.candidates[0].source.processStatus, "invalid");
  }
  const selected = await selectTraceContextV1(adapted);
  assert.equal(selected.ok, false);
  if (!selected.ok) assert.equal(selected.error.code, "INVALID_PROCESS_EVIDENCE");

  const unsignedHead = mutableChain(signed);
  unsignedHead[1]!.sig = "0".repeat(128);
  await assert.rejects(
    adaptDesktopTraceContextSelectionV1(input(unsignedHead, { policy: "text-only-v1" })),
    /head has an invalid id or signature/,
  );
});

test("represents a verified no-op transaction only through supported summary/transaction facts", async () => {
  const noOp = await fileNode("", "", undefined, {
    kedits: [{
      op: "ins",
      from: 0,
      to: 0,
      text: "",
      voice: OWNER,
      t: 9_000,
      tx: 77,
    }],
  });
  const supported = await adaptDesktopTraceContextSelectionV1(input([noOp], {
    processFacts: [
      { version: 1, kind: "step-summary", chainDistance: 0 },
      { version: 1, kind: "transaction", chainDistance: 0, transactionIndex: 0 },
    ],
  }));
  assert.deepEqual(supported.candidates.map((candidate) =>
    candidate.kind === "process-fact" ? candidate.fact.kind : candidate.kind), [
    "step-summary",
    "transaction",
  ]);
  const selected = await selectTraceContextV1(supported);
  assert.equal(selected.ok, true, selected.ok ? undefined : selected.error.message);

  await assert.rejects(
    adaptDesktopTraceContextSelectionV1(input([noOp], {
      processFacts: [{
        version: 1,
        kind: "change",
        chainDistance: 0,
        transactionIndex: 0,
        changeIndex: 0,
      }],
    })),
    /no-op range has no selector change-fact shape/,
  );
});

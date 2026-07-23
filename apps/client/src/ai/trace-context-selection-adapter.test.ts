import assert from "node:assert/strict";
import test from "node:test";

import type { Event, EventTemplate } from "nostr-tools";
import { finalizeEvent, getPublicKey, verifyEvent } from "nostr-tools/pure";

import type { ProtocolEvent } from "@zine/protocol";
import parityCorpusJson from "@zine/trace-context/selector-parity-corpus" with { type: "json" };
import {
  selectTraceContextV1,
  type EvidenceSelectionDecisionV1,
  type TraceContextSelectionInputV1,
  type TraceProcessFactV1,
} from "@zine/trace-context";

import {
  adaptDesktopTraceContextSelectionV1,
  DesktopTraceContextSelectionAdapterError,
  type DesktopTraceContextOperationMetadataV1,
  type DesktopTraceContextSelectionAdapterInputV1,
} from "./trace-context-selection-adapter.js";

const SECRET = Uint8Array.from([...new Uint8Array(31), 1]);
const OTHER_SECRET = Uint8Array.from([...new Uint8Array(31), 2]);
const OWNER = getPublicKey(SECRET);
const ROOT_ID = "f".repeat(64);
const OPERATION_ID = "1".repeat(64);
const PATH = "draft.md";

interface FileNodeOptions {
  path?: string;
  editorTransactions?: unknown;
  omitEditorTransactions?: boolean;
  sequence?: number;
  timestamp?: number;
}

interface ParityProtocolFixture {
  name: string;
  chain: ProtocolEvent[];
}

interface ParitySuccessExpected {
  ok: true;
  renderedContext: string;
  manifestSha256: string;
  selectedFacts: TraceProcessFactV1[];
  decisions: EvidenceSelectionDecisionV1[];
}

interface ParityFailureExpected {
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
  input: TraceContextSelectionInputV1;
  expected: ParitySuccessExpected | ParityFailureExpected;
}

interface AdapterRejectionDescriptor {
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

const parityCorpus = parityCorpusJson as unknown as {
  protocolFixtures: ParityProtocolFixture[];
  adapterFixtures: ParityProtocolFixture[];
  cases: ParityCase[];
  adapterRejectionMutations: AdapterRejectionDescriptor[];
};

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
  const timestamp = options.timestamp ?? 1_700_000_000_000 + (previous ? 1 : 0);
  const sequence = options.sequence ?? 17;
  const defaultEditorTransactions = before === snapshot
    ? []
    : [{
        sequence,
        timestamp,
        actor: OWNER,
        changes: [{
          op: before.length === 0 ? "insert" : snapshot.length === 0 ? "delete" : "replace",
          from: 0,
          to: before.length,
          text: snapshot,
        }],
        selectionBefore: null,
        selectionAfter: null,
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
      ...(options.omitEditorTransactions
        ? {}
        : { editorTransactions: options.editorTransactions ?? defaultEditorTransactions }),
    }),
  };
  return finalizeEvent(template, SECRET);
}

async function fullChain(): Promise<readonly [Event, Event]> {
  const genesis = await fileNode("", "Draft", undefined, { timestamp: 1_000, sequence: 17 });
  const head = await fileNode("Draft", "Current 🧠 draft", genesis, { timestamp: 2_000, sequence: 41 });
  return [genesis, head];
}

function resignEvent(
  event: Event,
  mutate: (template: EventTemplate) => void,
  secret: Uint8Array = SECRET,
): Event {
  const template: EventTemplate = {
    kind: event.kind,
    created_at: event.created_at,
    tags: event.tags.map((tag) => [...tag]),
    content: event.content,
  };
  mutate(template);
  return finalizeEvent(template, secret);
}

function mutableChain(chain: readonly ProtocolEvent[]): ProtocolEvent[] {
  return structuredClone([...chain]);
}

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
    limits: { version: 1, maxCandidates: 24 },
    ...overrides,
  };
}

function corpusFixture(parityCase: ParityCase): ParityProtocolFixture {
  const fixtureName = parityCase.protocolFixture ?? parityCase.adapterFixture;
  const fixture = [...parityCorpus.protocolFixtures, ...parityCorpus.adapterFixtures]
    .find((item) => item.name === fixtureName);
  assert.ok(fixture, `${parityCase.name}: protocol fixture`);
  return fixture;
}

function corpusAdapterInput(
  parityCase: ParityCase,
  chain: readonly ProtocolEvent[] = corpusFixture(parityCase).chain,
): DesktopTraceContextSelectionAdapterInputV1 {
  const operationInput = parityCase.input.operation;
  return {
    version: 1,
    policy: parityCase.input.policy,
    operation: {
      version: 1,
      operation: operationInput.operation,
      ...(operationInput.range ? { range: structuredClone(operationInput.range) } : {}),
      maxContextBytes: operationInput.maxContextBytes,
      preparedRequestMaxBytes: operationInput.preparedRequestMaxBytes,
      reservedPromptBytes: operationInput.reservedPromptBytes,
    },
    chain,
    verifyEvent,
    ...(parityCase.input.limits ? { limits: structuredClone(parityCase.input.limits) } : {}),
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
  assert.deepEqual(result.candidates.map((candidate) => candidate.id), [
    `trace-process-v1:${chain[0].id}:${chain[1].id}:summary`,
    `trace-process-v1:${chain[0].id}:${chain[1].id}:transaction:0`,
    `trace-process-v1:${chain[0].id}:${chain[1].id}:transaction:0:change:0`,
    `trace-process-v1:${chain[0].id}:${chain[0].id}:summary`,
    `trace-process-v1:${chain[0].id}:${chain[0].id}:transaction:0`,
    `trace-process-v1:${chain[0].id}:${chain[0].id}:transaction:0:change:0`,
  ]);
  assert.deepEqual(result.candidates.map((candidate) =>
    candidate.kind === "process-fact" ? candidate.fact.kind : candidate.kind), [
    "step-summary",
    "transaction",
    "change",
    "step-summary",
    "transaction",
    "change",
  ]);
  assert.deepEqual(
    result.candidates.map((candidate) =>
      candidate.source.kind === "trace" ? candidate.source.processStatus : undefined),
    Array<string>(6).fill("full-trace"),
  );
  assert.deepEqual(
    result.candidates[2]?.kind === "process-fact" ? result.candidates[2].fact : undefined,
    {
      kind: "change",
      transactionIndex: 0,
      operation: "replace",
      range: { fromUtf16: 0, toUtf16: 5 },
      insertedCodePointCount: 15,
      deletedCodePointCount: 5,
      voiceId: OWNER,
    },
  );
  assert.deepEqual(
    result.candidates[5]?.kind === "process-fact" ? result.candidates[5].fact : undefined,
    {
      kind: "change",
      transactionIndex: 0,
      operation: "insert",
      range: { fromUtf16: 0, toUtf16: 0 },
      insertedCodePointCount: 5,
      deletedCodePointCount: 0,
      voiceId: OWNER,
    },
  );

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
  assert.equal(baseline.candidates.length, 6);

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
      const payload = JSON.parse(chain[1]!.content) as { editorTransactions: unknown[] };
      payload.editorTransactions = [];
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

test("rejects every correctly signed head-local integrity failure", async () => {
  const [genesis, signedHead] = await fullChain();
  const cases: readonly [
    string,
    (template: EventTemplate) => void,
    Uint8Array?,
  ][] = [
    ["invalid-root-tag", (template) => {
      template.tags = template.tags.filter((tag) => tag[0] !== "f");
    }],
    ["owner-changed", () => {}, OTHER_SECRET],
    ["broken-prev", (template) => {
      template.tags.find((tag) => tag[0] === "e" && tag[3] === "prev")![1] = "0".repeat(64);
    }],
    ["invalid-operation-id", (template) => {
      const payload = JSON.parse(template.content) as Record<string, unknown>;
      payload.operationId = "not-an-operation-id";
      template.content = JSON.stringify(payload);
    }],
    ["unexpected-folder-checkpoint", (template) => {
      const payload = JSON.parse(template.content) as Record<string, unknown>;
      payload.folderCheckpoint = { cause: "checkpoint" };
      template.content = JSON.stringify(payload);
    }],
    ["nonconforming-deltas", (template) => {
      const payload = JSON.parse(template.content) as Record<string, unknown>;
      payload.deltas = [];
      template.content = JSON.stringify(payload);
    }],
  ];

  for (const [issueCode, mutate, secret] of cases) {
    const head = resignEvent(signedHead, mutate, secret);
    await assert.rejects(
      adaptDesktopTraceContextSelectionV1(input([genesis, head], {
        policy: "text-only-v1",
      })),
      new RegExp(`valid signed snapshot: ${issueCode}`),
      issueCode,
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
    editorTransactions: [],
  });
  mutable[1]!.tags.find((tag) => tag[0] === "F")![1] = "mutated.md";
  source.policy = "text-only-v1";
  source.operation.maxContextBytes = 1;
  if (source.limits) source.limits.maxCandidates = 1;

  const result = await pending;
  assert.equal(result.policy, "selected-trace-v1");
  assert.equal(result.operation.maxContextBytes, 16_384);
  assert.equal(result.limits?.maxCandidates, 24);
  assert.equal(result.operation.target.currentText, "Current 🧠 draft");
  assert.equal(result.operation.target.chosenPath, PATH);
  assert.equal(result.operation.target.traceId, signed[0].id);
  assert.equal(result.operation.target.headId, signed[1].id);
  assert.equal(result.candidates.length, 6);
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
      })),
      /within the signed current text on UTF-16 code-point boundaries/,
    );
  }

  await assert.doesNotReject(adaptDesktopTraceContextSelectionV1(input([node], {
    operation: operation({ operation: "settle", range: { fromUtf16: 1, toUtf16: 3 } }),
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
  }));
  const selection = await selectTraceContextV1(adapted);
  assert.equal(selection.ok, false);
  if (!selection.ok) {
    assert.equal(selection.error.code, "MANDATORY_BUDGET_EXCEEDED");
    assert.equal(selection.error.available, 0);
  }
});

test("maps snapshot-only process to a typed selected-trace failure and text-only projection", async () => {
  const snapshot = await fileNode("", "Readable snapshot", undefined, {
    omitEditorTransactions: true,
  });
  const selectedInput = await adaptDesktopTraceContextSelectionV1(input([snapshot]));
  assert.equal(selectedInput.candidates[0]?.source.kind, "trace");
  if (selectedInput.candidates[0]?.source.kind === "trace") {
    assert.equal(selectedInput.candidates[0].source.processStatus, "snapshot-only");
  }
  const selected = await selectTraceContextV1(selectedInput);
  assert.equal(selected.ok, false);
  if (!selected.ok) assert.equal(selected.error.code, "CONTEXT_INCOMPLETE");

  const textOnlyInput = await adaptDesktopTraceContextSelectionV1(input([snapshot], {
    policy: "text-only-v1",
  }));
  assert.deepEqual(textOnlyInput.candidates, []);
  const textOnly = await selectTraceContextV1(textOnlyInput);
  assert.equal(textOnly.ok, true, textOnly.ok ? undefined : textOnly.error.message);
});

test("carries an incomplete ancestor's global verdict through a complete head", async () => {
  const genesis = await fileNode("", "Draft", undefined, {
    omitEditorTransactions: true,
    timestamp: 1_000,
  });
  const head = await fileNode("Draft", "Current draft", genesis, { timestamp: 2_000 });
  const adapted = await adaptDesktopTraceContextSelectionV1(input([genesis, head]));
  assert.equal(adapted.candidates.length, 1);
  const candidate = adapted.candidates[0]!;
  const canonicalRef = `trace-process-v1:${genesis.id}:${head.id}:summary`;
  assert.equal(candidate.id, canonicalRef);
  assert.equal(candidate.dedupeKey, canonicalRef);
  assert.equal(candidate.kind, "process-fact");
  assert.equal(candidate.source.kind, "trace");
  if (candidate.kind === "process-fact" && candidate.source.kind === "trace") {
    assert.equal(candidate.source.ref, canonicalRef);
    assert.equal(candidate.fact.kind, "step-summary");
    assert.equal(candidate.source.nodeId, head.id);
    assert.equal(candidate.source.chainDistance, 0);
    assert.equal(candidate.source.processStatus, "snapshot-only");
  }
  const repeated = await adaptDesktopTraceContextSelectionV1(input([genesis, head]));
  assert.deepEqual(repeated.candidates, adapted.candidates);
  const selected = await selectTraceContextV1(adapted);
  assert.equal(selected.ok, false);
  if (!selected.ok) assert.equal(selected.error.code, "CONTEXT_INCOMPLETE");
});

test("maps invalid ancestry to invalid process without trusting an unsigned target head", async () => {
  const signed = await fullChain();
  const invalidAncestor = mutableChain(signed);
  invalidAncestor[0]!.sig = "0".repeat(128);
  const adapted = await adaptDesktopTraceContextSelectionV1(input(invalidAncestor));
  assert.equal(adapted.candidates[0]?.source.kind, "trace");
  if (adapted.candidates[0]?.source.kind === "trace") {
    assert.equal(adapted.candidates[0].source.processStatus, "invalid");
  }
  const selected = await selectTraceContextV1(adapted);
  assert.equal(selected.ok, false);
  if (!selected.ok) assert.equal(selected.error.code, "INVALID_PROCESS_EVIDENCE");

  const textOnlyInput = await adaptDesktopTraceContextSelectionV1(input(invalidAncestor, {
    policy: "text-only-v1",
  }));
  assert.deepEqual(textOnlyInput.candidates, []);
  const textOnly = await selectTraceContextV1(textOnlyInput);
  assert.equal(textOnly.ok, true, textOnly.ok ? undefined : textOnly.error.message);

  const unsignedHead = mutableChain(signed);
  unsignedHead[1]!.sig = "0".repeat(128);
  await assert.rejects(
    adaptDesktopTraceContextSelectionV1(input(unsignedHead, { policy: "text-only-v1" })),
    /valid signed snapshot: invalid-event/,
  );
});

test("enumerates a verified no-op transaction without a zero-effect change fact", async () => {
  const noOp = await fileNode("", "", undefined, {
    editorTransactions: [{
      sequence: 77,
      timestamp: 9_000,
      actor: OWNER,
      changes: [{ op: "insert", from: 0, to: 0, text: "" }],
      selectionBefore: null,
      selectionAfter: null,
    }],
  });
  const supported = await adaptDesktopTraceContextSelectionV1(input([noOp]));
  assert.deepEqual(supported.candidates.map((candidate) =>
    candidate.kind === "process-fact" ? candidate.fact.kind : candidate.kind), [
    "step-summary",
    "transaction",
  ]);
  const selected = await selectTraceContextV1(supported);
  assert.equal(selected.ok, true, selected.ok ? undefined : selected.error.message);
});

test("projects every protocol-valid FULL EditorTransaction domain value through the desktop boundary", async () => {
  const node = await fileNode("", "AB", undefined, {
    editorTransactions: [
      {
        sequence: 0,
        timestamp: -Number.MAX_VALUE,
        actor: "historical writer",
        changes: [{ op: "insert", from: 0, to: 0, text: "A" }],
        selectionBefore: null,
        selectionAfter: null,
      },
      {
        sequence: Number.MAX_SAFE_INTEGER + 1,
        timestamp: Number.MAX_VALUE,
        actor: "\ud800",
        changes: [{ op: "insert", from: 1, to: 1, text: "B" }],
        selectionBefore: null,
        selectionAfter: null,
      },
    ],
  });
  const adapted = await adaptDesktopTraceContextSelectionV1(input([node]));
  assert.equal(adapted.candidates.length, 5);
  assert.equal(adapted.candidates[0]?.kind, "process-fact");
  if (adapted.candidates[0]?.kind === "process-fact") {
    assert.equal(adapted.candidates[0].fact.kind, "step-summary");
    if (adapted.candidates[0].fact.kind === "step-summary") {
      assert.equal(adapted.candidates[0].fact.timingStatus, "outside-summary-domain");
    }
  }
  const selected = await selectTraceContextV1(adapted);
  assert.equal(selected.ok, true, selected.ok ? undefined : selected.error.message);
});

test("rejects malformed metadata, malformed chain shapes, bounds, and cancellation with adapter errors", async () => {
  const chain = await fullChain();
  const malformed: unknown[] = [
    null,
    { ...input(chain), policy: "unknown" },
    { ...input(chain), operation: operation({ operation: "settle", range: undefined }) },
    { ...input(chain), chain: [{ ...chain[0], tags: null }] },
    { ...input(chain), operation: operation({ preparedRequestMaxBytes: 1, reservedPromptBytes: 2 }) },
  ];
  for (const value of malformed) {
    await assert.rejects(
      adaptDesktopTraceContextSelectionV1(value as DesktopTraceContextSelectionAdapterInputV1),
      DesktopTraceContextSelectionAdapterError,
    );
  }

  let verifierCalls = 0;
  await assert.rejects(
    adaptDesktopTraceContextSelectionV1(input(chain, {
      limits: { version: 1, maxCandidates: 5 },
      verifyEvent: (event) => {
        verifierCalls += 1;
        return verifyEvent(event as Event);
      },
    })),
    /candidate count exceeds the selector ceiling/,
  );
  assert.equal(verifierCalls, 0, "candidate bounds must run before cryptographic verification");
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    adaptDesktopTraceContextSelectionV1(input(chain, { signal: controller.signal })),
    /operation was cancelled/,
  );
});

const projectableParityCases = parityCorpus.cases.filter(
  (parityCase) => parityCase.scope === "process-adapter-projectable",
);

for (const parityCase of projectableParityCases) {
  test(`matches exported adapter input: ${parityCase.name}`, async () => {
    const adapted = await adaptDesktopTraceContextSelectionV1(corpusAdapterInput(parityCase));
    assert.deepEqual(adapted, parityCase.input);
  });

  test(`matches exported selector result: ${parityCase.name}`, async () => {
    const adapted = await adaptDesktopTraceContextSelectionV1(corpusAdapterInput(parityCase));
    const result = await selectTraceContextV1(adapted);
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
  });
}

test("executes every applicable exported adapter rejection descriptor", async () => {
  const parityCase = projectableParityCases.find((item) => item.name === "two-step full trace");
  assert.ok(parityCase);
  const fixture = corpusFixture(parityCase);
  const projectedCandidate = parityCase.input.candidates.find((candidate) =>
    candidate.kind === "process-fact"
    && candidate.fact.kind === "transaction"
    && candidate.source.chainDistance === 0);
  assert.ok(projectedCandidate);
  const mutationRoot: Record<string, unknown> = {
    verdict: {
      steps: [
        { process: { transactions: [{ timestamp: 1_700_000_000_000 }] } },
        { process: { transactions: [{ timestamp: 1_700_000_000_001 }] } },
      ],
    },
    chain: fixture.chain,
    read: { headId: fixture.chain[fixture.chain.length - 1]!.id },
    processProjection: {
      steps: [
        { nodeId: fixture.chain[0]!.id, chainDistance: 1 },
        { nodeId: fixture.chain[fixture.chain.length - 1]!.id, chainDistance: 0 },
      ],
    },
    projectedCandidate,
  };

  for (const descriptor of parityCorpus.adapterRejectionMutations) {
    assert.equal(descriptor.fixture, fixture.name);
    assert.equal(descriptor.expected.accepted, false);
    const mutated = applyDescriptorMutation(mutationRoot, descriptor.mutation);
    if (descriptor.mutation.target === "chain[1].content") {
      await assert.rejects(
        adaptDesktopTraceContextSelectionV1(corpusAdapterInput(
          parityCase,
          mutated.chain as ProtocolEvent[],
        )),
        DesktopTraceContextSelectionAdapterError,
        descriptor.name,
      );
      continue;
    }

    const source = Object.assign(corpusAdapterInput(parityCase), {
      verdict: mutated.verdict,
      read: mutated.read,
      processProjection: mutated.processProjection,
      projectedCandidate: mutated.projectedCandidate,
    });
    const adapted = await adaptDesktopTraceContextSelectionV1(source);
    assert.deepEqual(adapted, parityCase.input, descriptor.name);
  }
});

function applyDescriptorMutation(
  root: Record<string, unknown>,
  mutation: AdapterRejectionDescriptor["mutation"],
): Record<string, unknown> {
  const cloned = structuredClone(root);
  const path = mutation.target.split(".").flatMap((component): (string | number)[] => {
    const match = /^([A-Za-z_$][A-Za-z0-9_$]*)(?:\[(0|[1-9][0-9]*)\])?$/.exec(component);
    assert.ok(match, `${mutation.target}: mutation path`);
    return match[2] === undefined ? [match[1]!] : [match[1]!, Number(match[2])];
  });
  let current: unknown = cloned;
  for (const segment of path.slice(0, -1)) {
    assert.ok(current !== null && typeof current === "object", mutation.target);
    current = (current as Record<string | number, unknown>)[segment];
  }
  assert.ok(current !== null && typeof current === "object", mutation.target);
  const parent = current as Record<string | number, unknown>;
  const leaf = path[path.length - 1]!;
  assert.ok(Object.prototype.hasOwnProperty.call(parent, leaf), mutation.target);
  assert.notDeepEqual(parent[leaf], mutation.value, mutation.target);
  parent[leaf] = structuredClone(mutation.value);
  return cloned;
}

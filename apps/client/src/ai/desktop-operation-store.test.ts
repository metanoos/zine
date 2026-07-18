import assert from "node:assert/strict";
import test from "node:test";

import {
  selectTraceContextV1,
  type TraceContextSelectionSuccessV1,
} from "@zine/trace-context";

import { contentFingerprint } from "./context-snapshot.js";
import {
  createDesktopOperationEnvelopeV1,
  type DesktopOperationEnvelopeV1,
} from "./desktop-operation-envelope.js";
import {
  reduceDesktopOperationV1,
  type DesktopOperationTransitionV1,
} from "./desktop-operation-lifecycle.js";
import {
  DesktopOperationStoreV1,
  type DesktopOperationJournalBackendV1,
} from "./desktop-operation-store.js";
import type { PreparedOperation } from "./prepared-operation.js";

const BASE_TIME = 10_000;
const TARGET_TEXT = "draft";
const HASH = (label: string) => contentFingerprint(label);
let selectedPromise: Promise<TraceContextSelectionSuccessV1> | null = null;

async function selectedContext(): Promise<TraceContextSelectionSuccessV1> {
  selectedPromise ??= selectTraceContextV1({
    version: 1,
    policy: "text-only-v1",
    operation: {
      version: 1,
      operation: "extend",
      target: {
        traceId: HASH("trace"),
        headId: HASH("head"),
        contentHash: HASH(TARGET_TEXT),
        currentText: TARGET_TEXT,
        chosenPath: "draft.md",
      },
      range: { fromUtf16: 0, toUtf16: TARGET_TEXT.length },
      maxContextBytes: 16_384,
      preparedRequestMaxBytes: 32_768,
      reservedPromptBytes: 1_024,
    },
    candidates: [],
  }).then((result) => {
    assert.equal(result.ok, true);
    return result as TraceContextSelectionSuccessV1;
  });
  return selectedPromise;
}

async function envelope(suffix = "0001"): Promise<DesktopOperationEnvelopeV1> {
  const selected = await selectedContext();
  const prepared: PreparedOperation = Object.freeze({
    version: 1,
    requestId: `request-${suffix}`,
    operation: "extend",
    operationInputs: Object.freeze({
      seed: TARGET_TEXT,
      hasSelection: false,
      rangeFrom: TARGET_TEXT.length,
      rangeTo: TARGET_TEXT.length,
      sourceFrom: 0,
      sourceTo: TARGET_TEXT.length,
    }),
    contextSnapshot: {} as PreparedOperation["contextSnapshot"],
    contextFingerprint: HASH("context"),
    traceAuthoring: null,
    messages: Object.freeze([
      { role: "system" as const, content: "Continue the document." },
      { role: "user" as const, content: selected.renderedContext },
    ]),
    providerId: "provider-0001",
    providerFingerprint: HASH("provider"),
    targetRevision: {
      folderId: HASH("folder"),
      path: "draft.md",
      traceId: HASH("trace"),
      headId: HASH("head"),
      contentHash: HASH(TARGET_TEXT),
    },
    provenance: Object.freeze({
      modelVoicePubkey: "a".repeat(64),
      lensId: "default" as const,
      voicePromptHash: HASH("voice"),
      dependencyFingerprint: HASH("dependency"),
    }),
    budget: Object.freeze({
      maxBytes: 32_768,
      totalBytes: 2_048,
      estimatedTokens: 512,
      contextBytes: 1_024,
      promptLayerBytes: 1_024,
    }),
    preparedRequestHash: HASH("prepared"),
    createdAt: BASE_TIME,
  });
  return createDesktopOperationEnvelopeV1({
    operationId: `operation-${suffix}`,
    attemptId: `attempt-${suffix}`,
    prepared,
    provider: {
      protocol: "openai",
      modelId: "model-1",
      transportConfigSha256: HASH("transport"),
    },
    selectedContext: {
      ...selected,
      placement: {
        messageIndex: 1,
        fromUtf16: 0,
        toUtf16: selected.renderedContext.length,
      },
    },
    maxOutputTokens: 1_024,
    createdAtMs: BASE_TIME,
    retainForMs: 60_000,
  });
}

class FakeJournalBackend implements DesktopOperationJournalBackendV1 {
  readonly records = new Map<string, { revision: number; envelope: string }>();
  createCalls = 0;
  updateCalls = 0;
  nextLoadOverride: unknown = undefined;
  updateBarrier: Promise<void> | null = null;

  async create(serialized: string): Promise<unknown> {
    this.createCalls += 1;
    const key = identity(serialized);
    const existing = this.records.get(key);
    if (existing) {
      if (existing.envelope !== serialized) throw new Error("conflict");
      return { revision: existing.revision };
    }
    this.records.set(key, { revision: 1, envelope: serialized });
    return { revision: 1 };
  }

  async update(expectedRevision: number, serialized: string): Promise<unknown> {
    this.updateCalls += 1;
    if (this.updateBarrier) await this.updateBarrier;
    const key = identity(serialized);
    const existing = this.records.get(key);
    if (!existing || existing.revision !== expectedRevision) throw new Error("conflict");
    if (existing.envelope === serialized) return { revision: existing.revision };
    const revision = existing.revision + 1;
    this.records.set(key, { revision, envelope: serialized });
    return { revision };
  }

  async load(operationId: string, attemptId: string): Promise<unknown> {
    if (this.nextLoadOverride !== undefined) {
      const override = this.nextLoadOverride;
      this.nextLoadOverride = undefined;
      return override;
    }
    return this.records.get(`${operationId}\0${attemptId}`) ?? null;
  }

  async list(): Promise<unknown> {
    return [...this.records.values()];
  }

  async delete(
    operationId: string,
    attemptId: string,
    expectedRevision: number,
  ): Promise<unknown> {
    const key = `${operationId}\0${attemptId}`;
    const existing = this.records.get(key);
    if (!existing) return false;
    if (existing.revision !== expectedRevision) throw new Error("conflict");
    return this.records.delete(key);
  }

  async deleteExpired(nowMs: number): Promise<unknown> {
    let deleted = 0;
    for (const [key, record] of this.records) {
      const parsed = JSON.parse(record.envelope) as DesktopOperationEnvelopeV1;
      if (parsed.retention.deleteByMs <= nowMs) {
        this.records.delete(key);
        deleted += 1;
      }
    }
    return deleted;
  }
}

test("store validates before writes and strictly validates native reads", async () => {
  const backend = new FakeJournalBackend();
  const store = new DesktopOperationStoreV1(backend);
  const valid = await envelope();
  const invalid = { ...valid, contract: "not-the-contract" } as unknown as DesktopOperationEnvelopeV1;

  await assert.rejects(store.create(invalid), /unsupported envelope version or contract/);
  assert.equal(backend.createCalls, 0);

  const created = await store.create(valid);
  assert.equal(created.revision, 1);
  assert.equal(Object.isFrozen(created.envelope), true);
  const loaded = await store.load(valid.operationId, valid.attempt.attemptId);
  assert.equal(loaded?.envelope.prepared.requestSha256, valid.prepared.requestSha256);
  assert.equal(Object.isFrozen(loaded?.envelope), true);

  backend.nextLoadOverride = { revision: 1, envelope: "{" };
  await assert.rejects(
    store.load(valid.operationId, valid.attempt.attemptId),
    /serialized envelope is not valid JSON/,
  );
});

test("store rejects mismatched and duplicate native recovery records", async () => {
  const backend = new FakeJournalBackend();
  const store = new DesktopOperationStoreV1(backend);
  const first = await envelope("1001");
  const second = await envelope("1002");
  await store.create(first);
  await store.create(second);

  backend.nextLoadOverride = backend.records.get(`${second.operationId}\0${second.attempt.attemptId}`);
  await assert.rejects(
    store.load(first.operationId, first.attempt.attemptId),
    /different operation attempt/,
  );

  const duplicate = backend.records.get(`${first.operationId}\0${first.attempt.attemptId}`)!;
  const originalList = backend.list.bind(backend);
  backend.list = async () => [duplicate, duplicate];
  await assert.rejects(store.list(), /duplicate operation attempt/);
  backend.list = originalList;
  assert.equal((await store.list()).length, 2);
});

test("persistReduction completes CAS storage before exposing effects", async () => {
  const backend = new FakeJournalBackend();
  const store = new DesktopOperationStoreV1(backend);
  let current = await store.create(await envelope("2001"));
  let atMs = BASE_TIME + 1;

  for (const type of ["approve", "record-dispatch-intent"] as const) {
    const reduction = reduceDesktopOperationV1(current.envelope, transition(type, atMs));
    current = (await store.persistReduction(current, reduction)).stored;
    atMs += 1;
  }

  let release!: () => void;
  backend.updateBarrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const dispatch = reduceDesktopOperationV1(
    current.envelope,
    transition("record-provider-io-may-have-started", atMs),
  );
  let resolved = false;
  const pending = store.persistReduction(current, dispatch).then((result) => {
    resolved = true;
    return result;
  });
  await Promise.resolve();
  assert.equal(backend.updateCalls, 3);
  assert.equal(resolved, false, "effects must not be exposed while persistence is pending");
  release();
  const persisted = await pending;
  assert.equal(persisted.effects[0]?.kind, "dispatch-provider-request");
  assert.equal(persisted.stored.envelope.lifecycle.status, "provider-io");
});

test("delete and deleteExpired use explicit native authority", async () => {
  const backend = new FakeJournalBackend();
  const store = new DesktopOperationStoreV1(backend);
  const first = await store.create(await envelope("3001"));
  const second = await store.create(await envelope("3002"));

  assert.equal(await store.delete(first), true);
  assert.equal(await store.load(first.envelope.operationId, first.envelope.attempt.attemptId), null);
  assert.equal(await store.deleteExpired(second.envelope.retention.deleteByMs), 1);
  assert.equal((await store.list()).length, 0);
});

function identity(serialized: string): string {
  const parsed = JSON.parse(serialized) as DesktopOperationEnvelopeV1;
  return `${parsed.operationId}\0${parsed.attempt.attemptId}`;
}

function transition<T extends DesktopOperationTransitionV1["type"]>(
  type: T,
  atMs: number,
): Extract<DesktopOperationTransitionV1, { type: T }> {
  return {
    version: 1,
    type,
    transitionId: `transition-${type}-${atMs}`,
    atMs,
  } as Extract<DesktopOperationTransitionV1, { type: T }>;
}

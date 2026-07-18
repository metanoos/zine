import assert from "node:assert/strict";
import test from "node:test";

import {
  selectTraceContextV1,
  type TraceContextSelectionSuccessV1,
} from "@zine/trace-context";

import { contentFingerprint } from "./context-snapshot.js";
import {
  createDesktopOperationEnvelopeV1,
  hashDesktopOperationEnvelopeV1,
  type DesktopOperationEnvelopeV1,
} from "./desktop-operation-envelope.js";
import {
  captureDesktopOperationJournalSessionV1,
  clearDesktopOperationJournalSessionV1,
} from "./desktop-operation-journal-session.js";
import {
  reduceDesktopOperationV1,
  type DesktopOperationTransitionV1,
} from "./desktop-operation-lifecycle.js";
import {
  createNativeDesktopOperationJournalBackendV1,
  DesktopOperationStoreV1,
  type DesktopOperationJournalBackendV1,
} from "./desktop-operation-store.js";
import {
  computePreparedOperationRequestHashV1,
  type PreparedOperation,
} from "./prepared-operation.js";

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
  const requestId = `request-${suffix}`;
  const operationInputs = Object.freeze({
    seed: TARGET_TEXT,
    hasSelection: false,
    rangeFrom: TARGET_TEXT.length,
    rangeTo: TARGET_TEXT.length,
    sourceFrom: 0,
    sourceTo: TARGET_TEXT.length,
  });
  const messages = Object.freeze([
    { role: "system" as const, content: "Continue the document." },
    { role: "user" as const, content: selected.renderedContext },
  ]);
  const providerFingerprint = HASH("provider");
  const targetRevision = {
    folderId: HASH("folder"),
    path: "draft.md",
    traceId: HASH("trace"),
    headId: HASH("head"),
    contentHash: HASH(TARGET_TEXT),
  };
  const dependencyFingerprint = HASH("dependency");
  const createdAt = BASE_TIME;
  const prepared: PreparedOperation = Object.freeze({
    version: 1,
    requestId,
    operation: "extend",
    operationInputs,
    contextSnapshot: {} as PreparedOperation["contextSnapshot"],
    contextFingerprint: HASH("context"),
    traceAuthoring: null,
    messages,
    providerId: "provider-0001",
    providerFingerprint,
    targetRevision,
    provenance: Object.freeze({
      modelVoicePubkey: "a".repeat(64),
      lensId: "default" as const,
      voicePromptHash: HASH("voice"),
      dependencyFingerprint,
    }),
    budget: Object.freeze({
      maxBytes: 32_768,
      totalBytes: 2_048,
      estimatedTokens: 512,
      contextBytes: 1_024,
      promptLayerBytes: 1_024,
    }),
    preparedRequestHash: computePreparedOperationRequestHashV1({
      requestId,
      operation: "extend",
      operationInputs,
      messages,
      traceAuthoring: null,
      providerFingerprint,
      targetRevision,
      dependencyFingerprint,
      createdAt,
    }),
    createdAt,
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
  replaceCalls = 0;
  nextLoadOverride: unknown = undefined;
  nextListOverride: unknown = undefined;
  replaceBarrier: Promise<void> | null = null;
  nowMs = BASE_TIME;

  async create(serialized: string): Promise<unknown> {
    this.createCalls += 1;
    const key = identity(serialized);
    const existing = this.records.get(key);
    if (existing) return "exists";
    this.records.set(key, { revision: 1, envelope: serialized });
    return "created";
  }

  async replace(
    operationId: string,
    attemptId: string,
    expectedEnvelopeSha256: string,
    serialized: string,
  ): Promise<unknown> {
    this.replaceCalls += 1;
    if (this.replaceBarrier) await this.replaceBarrier;
    const key = `${operationId}\0${attemptId}`;
    const existing = this.records.get(key);
    if (!existing) return "missing";
    if (existing.envelope === serialized) return "replaced";
    const current = JSON.parse(existing.envelope) as DesktopOperationEnvelopeV1;
    if (hashDesktopOperationEnvelopeV1(current) !== expectedEnvelopeSha256) return "conflict";
    const revision = existing.revision + 1;
    this.records.set(key, { revision, envelope: serialized });
    return "replaced";
  }

  async load(operationId: string, attemptId: string): Promise<unknown> {
    if (this.nextLoadOverride !== undefined) {
      const override = this.nextLoadOverride;
      this.nextLoadOverride = undefined;
      return override;
    }
    return this.records.get(`${operationId}\0${attemptId}`) ?? null;
  }

  async listPage(cursor: string | null, limit: number): Promise<unknown> {
    if (this.nextListOverride !== undefined) {
      const override = this.nextListOverride;
      this.nextListOverride = undefined;
      return override;
    }
    const records = [...this.records.values()];
    const from = cursor === null ? 0 : Number.parseInt(cursor, 16);
    const page = records.slice(from, from + limit);
    const next = from + page.length;
    return {
      records: page,
      nextCursor: next < records.length ? next.toString(16).padStart(64, "0") : null,
    };
  }

  async delete(
    operationId: string,
    attemptId: string,
    expectedEnvelopeSha256: string,
  ): Promise<unknown> {
    const key = `${operationId}\0${attemptId}`;
    const existing = this.records.get(key);
    if (!existing) return "missing";
    const current = JSON.parse(existing.envelope) as DesktopOperationEnvelopeV1;
    if (hashDesktopOperationEnvelopeV1(current) !== expectedEnvelopeSha256) return "conflict";
    this.records.delete(key);
    return "deleted";
  }

  async deleteExpired(limit: number): Promise<unknown> {
    let deleted = 0;
    for (const [key, record] of this.records) {
      const parsed = JSON.parse(record.envelope) as DesktopOperationEnvelopeV1;
      if (parsed.retention.deleteByMs <= this.nowMs) {
        this.records.delete(key);
        deleted += 1;
        if (deleted === limit) break;
      }
    }
    const hasMore = [...this.records.values()].some((record) => {
      const parsed = JSON.parse(record.envelope) as DesktopOperationEnvelopeV1;
      return parsed.retention.deleteByMs <= this.nowMs;
    });
    return { deleted, hasMore };
  }
}

test("store validates before writes and strictly validates native reads", async () => {
  const backend = new FakeJournalBackend();
  const store = new DesktopOperationStoreV1(backend);
  const valid = await envelope();
  const invalid = { ...valid, contract: "not-the-contract" } as unknown as DesktopOperationEnvelopeV1;

  await assert.rejects(store.create(invalid), /unsupported envelope version or contract/);
  assert.equal(backend.createCalls, 0);

  assert.equal(await store.create(valid), "created");
  assert.equal(await store.create(valid), "exists");
  const key = { operationId: valid.operationId, attemptId: valid.attempt.attemptId };
  const loaded = await store.load(key);
  assert.equal(loaded?.prepared.requestSha256, valid.prepared.requestSha256);
  assert.equal(Object.isFrozen(loaded), true);

  backend.nextLoadOverride = { revision: 1, envelope: "{" };
  await assert.rejects(
    store.load(key),
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
    store.load({ operationId: first.operationId, attemptId: first.attempt.attemptId }),
    /different operation attempt/,
  );

  const duplicate = backend.records.get(`${first.operationId}\0${first.attempt.attemptId}`)!;
  backend.nextListOverride = { records: [duplicate, duplicate], nextCursor: null };
  await assert.rejects(store.listPage(), /duplicate operation attempt/);
  const page = await store.listPage();
  assert.equal(page.records.length, 2);
  assert.equal("revision" in page.records[0]!, false, "native revisions must not leak");
});

test("replace validates envelope-hash CAS and waits for native durability", async () => {
  const backend = new FakeJournalBackend();
  const store = new DesktopOperationStoreV1(backend);
  const current = await envelope("2001");
  await store.create(current);
  const reduction = reduceDesktopOperationV1(current, transition("approve", BASE_TIME + 1));
  const key = { operationId: current.operationId, attemptId: current.attempt.attemptId };

  let release!: () => void;
  backend.replaceBarrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  let resolved = false;
  const pending = store.replace(
    key,
    hashDesktopOperationEnvelopeV1(current),
    reduction.envelope,
  ).then((result) => {
    resolved = true;
    return result;
  });
  await Promise.resolve();
  assert.equal(backend.replaceCalls, 1);
  assert.equal(resolved, false, "replace must wait for native persistence");
  release();
  assert.equal(await pending, "replaced");
  assert.equal((await store.load(key))?.lifecycle.status, "approved");
});

test("delete uses envelope CAS and reports deleted, conflict, and missing", async () => {
  const backend = new FakeJournalBackend();
  const store = new DesktopOperationStoreV1(backend);
  const first = await envelope("3001");
  const second = await envelope("3002");
  await store.create(first);
  await store.create(second);

  const key = {
    operationId: first.operationId,
    attemptId: first.attempt.attemptId,
  };
  assert.equal(await store.delete(key, hashDesktopOperationEnvelopeV1(second)), "conflict");
  assert.notEqual(await store.load(key), null);
  assert.equal(await store.delete(key, hashDesktopOperationEnvelopeV1(first)), "deleted");
  assert.equal(await store.delete(key, hashDesktopOperationEnvelopeV1(first)), "missing");
  assert.equal(await store.load(key), null);
});

test("deleteExpired uses a bounded native-clock batch", async () => {
  const backend = new FakeJournalBackend();
  const store = new DesktopOperationStoreV1(backend);
  await store.create(await envelope("3101"));
  await store.create(await envelope("3102"));
  await store.create(await envelope("3103"));
  backend.nowMs = BASE_TIME + 60_000;

  assert.deepEqual(await store.deleteExpired(2), { deleted: 2, hasMore: true });
  assert.deepEqual(await store.deleteExpired(2), { deleted: 1, hasMore: false });
  assert.equal((await store.listPage()).records.length, 0);
});

test("native backend stays bound to its construction-time activation session", async () => {
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  const nativeInvoke = async (command: string, args?: Record<string, unknown>) => {
    calls.push({ command, args });
    if (command === "desktop_operation_journal_list_page") {
      return { records: [], nextCursor: null };
    }
    if (command === "desktop_operation_journal_delete_expired") {
      return { deleted: 0, hasMore: false };
    }
    return null;
  };
  captureDesktopOperationJournalSessionV1({
    journalSessionId: "a".repeat(64),
    journalGeneration: 41,
  });
  const backend = createNativeDesktopOperationJournalBackendV1(nativeInvoke);
  await backend.listPage(null, 2);
  captureDesktopOperationJournalSessionV1({
    journalSessionId: "b".repeat(64),
    journalGeneration: 42,
  });
  await backend.deleteExpired(2);
  const nextBackend = createNativeDesktopOperationJournalBackendV1(nativeInvoke);
  await nextBackend.listPage(null, 2);
  assert.deepEqual(calls.map((call) => call.args), [
    { journalSessionId: "a".repeat(64), journalGeneration: 41, cursor: null, limit: 2 },
    { journalSessionId: "a".repeat(64), journalGeneration: 41, limit: 2 },
    { journalSessionId: "b".repeat(64), journalGeneration: 42, cursor: null, limit: 2 },
  ]);

  clearDesktopOperationJournalSessionV1();
  assert.throws(
    () => createNativeDesktopOperationJournalBackendV1(nativeInvoke),
    /Unlock a vault/,
  );
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

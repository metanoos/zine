import { invoke } from "@tauri-apps/api/core";

import {
  parseDesktopOperationEnvelopeV1,
  serializeDesktopOperationEnvelopeV1,
  type DesktopOperationEnvelopeV1,
} from "./desktop-operation-envelope.js";
import { requireDesktopOperationJournalSessionV1 } from "./desktop-operation-journal-session.js";

export interface NativeDesktopOperationJournalRecordV1 {
  revision: number;
  envelope: string;
}

export interface DesktopOperationJournalKeyV1 {
  operationId: string;
  attemptId: string;
}

export type DesktopOperationJournalDeleteResultV1 = "deleted" | "conflict" | "missing";
export type DesktopOperationJournalCreateResultV1 = "created" | "exists";
export type DesktopOperationJournalReplaceResultV1 = "replaced" | "conflict" | "missing";

export interface DesktopOperationPageV1 {
  records: readonly DesktopOperationEnvelopeV1[];
  nextCursor: string | null;
}

export interface DesktopOperationExpiryBatchV1 {
  deleted: number;
  hasMore: boolean;
}

/**
 * Explicit native boundary. Tests may inject a fake implementation, but the
 * production store never falls back to browser storage or another authority.
 */
export interface DesktopOperationJournalBackendV1 {
  create(envelope: string): Promise<unknown>;
  replace(
    operationId: string,
    attemptId: string,
    expectedEnvelopeSha256: string,
    envelope: string,
  ): Promise<unknown>;
  load(operationId: string, attemptId: string): Promise<unknown>;
  listPage(cursor: string | null, limit: number): Promise<unknown>;
  delete(
    operationId: string,
    attemptId: string,
    expectedEnvelopeSha256: string,
  ): Promise<unknown>;
  deleteExpired(limit: number): Promise<unknown>;
}

export class DesktopOperationStoreError extends Error {
  constructor(message: string) {
    super(`Desktop operation store: ${message}`);
    this.name = "DesktopOperationStoreError";
  }
}

export class DesktopOperationStoreV1 {
  constructor(private readonly backend: DesktopOperationJournalBackendV1) {}

  async create(envelope: DesktopOperationEnvelopeV1): Promise<DesktopOperationJournalCreateResultV1> {
    const serialized = serializeDesktopOperationEnvelopeV1(envelope);
    const result = await this.backend.create(serialized);
    if (result !== "created" && result !== "exists") {
      fail("native create result is invalid");
    }
    return result;
  }

  async replace(
    key: DesktopOperationJournalKeyV1,
    expectedEnvelopeSha256: string,
    envelope: DesktopOperationEnvelopeV1,
  ): Promise<DesktopOperationJournalReplaceResultV1> {
    validateKey(key);
    requireSha256(expectedEnvelopeSha256, "expected envelope hash");
    const serialized = serializeDesktopOperationEnvelopeV1(envelope);
    if (
      envelope.operationId !== key.operationId
      || envelope.attempt.attemptId !== key.attemptId
    ) {
      fail("replacement envelope belongs to a different operation attempt");
    }
    const result = await this.backend.replace(
      key.operationId,
      key.attemptId,
      expectedEnvelopeSha256,
      serialized,
    );
    if (result !== "replaced" && result !== "conflict" && result !== "missing") {
      fail("native replace result is invalid");
    }
    return result;
  }

  async load(key: DesktopOperationJournalKeyV1): Promise<DesktopOperationEnvelopeV1 | null> {
    validateKey(key);
    const raw = await this.backend.load(key.operationId, key.attemptId);
    if (raw === null) return null;
    const envelope = parseNativeRecord(raw);
    if (
      envelope.operationId !== key.operationId
      || envelope.attempt.attemptId !== key.attemptId
    ) {
      fail("native lookup returned a different operation attempt");
    }
    return envelope;
  }

  async listPage(cursor: string | null = null, limit = 8): Promise<DesktopOperationPageV1> {
    requireCursor(cursor);
    requirePageLimit(limit);
    const raw = await this.backend.listPage(cursor, limit);
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      fail("native list page is invalid");
    }
    const page = raw as Record<string, unknown>;
    if (
      Object.keys(page).some((key) => key !== "records" && key !== "nextCursor")
      || !Array.isArray(page.records)
    ) {
      fail("native list page is invalid");
    }
    requireCursor(page.nextCursor);
    if (page.records.length > limit) fail("native list page exceeds its requested limit");
    const records = page.records.map(parseNativeRecord);
    const identities = new Set<string>();
    for (const envelope of records) {
      const identity = `${envelope.operationId}\0${envelope.attempt.attemptId}`;
      if (identities.has(identity)) fail("native list returned a duplicate operation attempt");
      identities.add(identity);
    }
    return Object.freeze({
      records: Object.freeze(records),
      nextCursor: page.nextCursor,
    });
  }

  async delete(
    key: DesktopOperationJournalKeyV1,
    expectedEnvelopeSha256: string,
  ): Promise<DesktopOperationJournalDeleteResultV1> {
    validateKey(key);
    requireSha256(expectedEnvelopeSha256, "expected envelope hash");
    const result = await this.backend.delete(
      key.operationId,
      key.attemptId,
      expectedEnvelopeSha256,
    );
    if (result !== "deleted" && result !== "conflict" && result !== "missing") {
      fail("native delete result is invalid");
    }
    return result;
  }

  async deleteExpired(limit = 8): Promise<DesktopOperationExpiryBatchV1> {
    requirePageLimit(limit);
    const raw = await this.backend.deleteExpired(limit);
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      fail("native expired-delete result is invalid");
    }
    const result = raw as Record<string, unknown>;
    if (
      Object.keys(result).some((key) => key !== "deleted" && key !== "hasMore")
      || typeof result.hasMore !== "boolean"
    ) {
      fail("native expired-delete result is invalid");
    }
    return Object.freeze({
      deleted: requireNonNegativeSafeInteger(result.deleted, "native expired-delete count"),
      hasMore: result.hasMore,
    });
  }
}

export type DesktopOperationJournalInvokeV1 = (
  command: string,
  args?: Record<string, unknown>,
) => Promise<unknown>;

export function createNativeDesktopOperationJournalBackendV1(
  nativeInvoke: DesktopOperationJournalInvokeV1 = (command, args) => invoke(command, args),
): DesktopOperationJournalBackendV1 {
  // A store is a capability for exactly one activation. Never consult the
  // mutable renderer-global binding again: after lock/switch, native rejects
  // this captured session instead of silently rebinding the old store.
  const session = requireDesktopOperationJournalSessionV1();
  const args = (commandArgs: Record<string, unknown> = {}): Record<string, unknown> => ({
    ...session,
    ...commandArgs,
  });
  const backend: DesktopOperationJournalBackendV1 = {
    create: async (envelope) => nativeInvoke("desktop_operation_journal_create", args({ envelope })),
    replace: async (operationId, attemptId, expectedEnvelopeSha256, envelope) => nativeInvoke(
      "desktop_operation_journal_replace",
      args({
        operationId,
        attemptId,
        expectedEnvelopeSha256,
        envelope,
      }),
    ),
    load: async (operationId, attemptId) => nativeInvoke("desktop_operation_journal_load", args({
      operationId,
      attemptId,
    })),
    listPage: async (cursor, limit) => nativeInvoke(
      "desktop_operation_journal_list_page",
      args({ cursor, limit }),
    ),
    delete: async (operationId, attemptId, expectedEnvelopeSha256) => nativeInvoke(
      "desktop_operation_journal_delete",
      args({ operationId, attemptId, expectedEnvelopeSha256 }),
    ),
    deleteExpired: async (limit) => nativeInvoke(
      "desktop_operation_journal_delete_expired",
      args({ limit }),
    ),
  };
  return Object.freeze(backend);
}

/** Production construction is intentionally explicit; no browser fallback. */
export function createNativeDesktopOperationStoreV1(): DesktopOperationStoreV1 {
  return new DesktopOperationStoreV1(createNativeDesktopOperationJournalBackendV1());
}

function parseNativeRecord(value: unknown): DesktopOperationEnvelopeV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("native record is invalid");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "revision" && key !== "envelope")) {
    fail("native record has unsupported fields");
  }
  requireRevision(record.revision, "native record revision");
  if (typeof record.envelope !== "string") fail("native record envelope is invalid");
  return parseDesktopOperationEnvelopeV1(record.envelope);
}

function requireRevision(value: unknown, subject: string): number {
  const revision = requireNonNegativeSafeInteger(value, subject);
  if (revision < 1) fail(`${subject} must be positive`);
  return revision;
}

function requireCursor(value: unknown): asserts value is string | null {
  if (value !== null && (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value))) {
    fail("native list cursor is invalid");
  }
}

function requirePageLimit(value: unknown): asserts value is number {
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 16) {
    fail("page limit must be an integer between 1 and 16");
  }
}

function requireIdentity(value: unknown, subject: string): asserts value is string {
  if (
    typeof value !== "string"
    || value.length < 8
    || value.length > 128
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)
  ) {
    fail(`${subject} is invalid`);
  }
}

function validateKey(key: DesktopOperationJournalKeyV1): void {
  if (key === null || typeof key !== "object" || Array.isArray(key)) {
    fail("operation key is invalid");
  }
  if (Object.keys(key).some((field) => field !== "operationId" && field !== "attemptId")) {
    fail("operation key has unsupported fields");
  }
  requireIdentity(key.operationId, "operation id");
  requireIdentity(key.attemptId, "attempt id");
}

function requireSha256(value: unknown, subject: string): asserts value is string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    fail(`${subject} is invalid`);
  }
}

function requireNonNegativeSafeInteger(value: unknown, subject: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    fail(`${subject} must be a non-negative safe integer`);
  }
  return value as number;
}

function fail(message: string): never {
  throw new DesktopOperationStoreError(message);
}

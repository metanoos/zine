import { invoke } from "@tauri-apps/api/core";

import {
  parseDesktopOperationEnvelopeV1,
  serializeDesktopOperationEnvelopeV1,
  type DesktopOperationEnvelopeV1,
} from "./desktop-operation-envelope.js";
import type {
  DesktopOperationEffectV1,
  DesktopOperationReductionV1,
} from "./desktop-operation-lifecycle.js";

export interface NativeDesktopOperationJournalRecordV1 {
  revision: number;
  envelope: string;
}

export interface NativeDesktopOperationJournalWriteReceiptV1 {
  revision: number;
}

/**
 * Explicit native boundary. Tests may inject a fake implementation, but the
 * production store never falls back to browser storage or another authority.
 */
export interface DesktopOperationJournalBackendV1 {
  create(envelope: string): Promise<unknown>;
  update(expectedRevision: number, envelope: string): Promise<unknown>;
  load(operationId: string, attemptId: string): Promise<unknown>;
  list(): Promise<unknown>;
  delete(operationId: string, attemptId: string, expectedRevision: number): Promise<unknown>;
  deleteExpired(nowMs: number): Promise<unknown>;
}

export interface StoredDesktopOperationEnvelopeV1 {
  revision: number;
  envelope: DesktopOperationEnvelopeV1;
}

export interface PersistedDesktopOperationReductionV1 {
  version: 1;
  stored: StoredDesktopOperationEnvelopeV1;
  /** Interpret only after `persistReduction` resolves successfully. */
  effects: readonly DesktopOperationEffectV1[];
}

export class DesktopOperationStoreError extends Error {
  constructor(message: string) {
    super(`Desktop operation store: ${message}`);
    this.name = "DesktopOperationStoreError";
  }
}

export class DesktopOperationStoreV1 {
  constructor(private readonly backend: DesktopOperationJournalBackendV1) {}

  async create(envelope: DesktopOperationEnvelopeV1): Promise<StoredDesktopOperationEnvelopeV1> {
    const serialized = serializeDesktopOperationEnvelopeV1(envelope);
    const receipt = requireWriteReceipt(await this.backend.create(serialized));
    return stored(receipt.revision, parseDesktopOperationEnvelopeV1(serialized));
  }

  async update(
    expectedRevision: number,
    envelope: DesktopOperationEnvelopeV1,
  ): Promise<StoredDesktopOperationEnvelopeV1> {
    requireRevision(expectedRevision, "expected revision");
    const serialized = serializeDesktopOperationEnvelopeV1(envelope);
    const receipt = requireWriteReceipt(
      await this.backend.update(expectedRevision, serialized),
    );
    if (
      receipt.revision !== expectedRevision
      && receipt.revision !== expectedRevision + 1
    ) {
      fail("native write revision is not the expected idempotent CAS result");
    }
    return stored(receipt.revision, parseDesktopOperationEnvelopeV1(serialized));
  }

  async load(
    operationId: string,
    attemptId: string,
  ): Promise<StoredDesktopOperationEnvelopeV1 | null> {
    const raw = await this.backend.load(operationId, attemptId);
    if (raw === null) return null;
    const record = parseNativeRecord(raw);
    if (
      record.envelope.operationId !== operationId
      || record.envelope.attempt.attemptId !== attemptId
    ) {
      fail("native lookup returned a different operation attempt");
    }
    return record;
  }

  async list(): Promise<readonly StoredDesktopOperationEnvelopeV1[]> {
    const raw = await this.backend.list();
    if (!Array.isArray(raw)) fail("native list result is invalid");
    const records = raw.map(parseNativeRecord);
    const identities = new Set<string>();
    for (const record of records) {
      const identity = `${record.envelope.operationId}\0${record.envelope.attempt.attemptId}`;
      if (identities.has(identity)) fail("native list returned a duplicate operation attempt");
      identities.add(identity);
    }
    return Object.freeze(records);
  }

  async delete(
    record: StoredDesktopOperationEnvelopeV1,
  ): Promise<boolean> {
    const revision = requireRevision(record.revision, "record revision");
    serializeDesktopOperationEnvelopeV1(record.envelope);
    const deleted = await this.backend.delete(
      record.envelope.operationId,
      record.envelope.attempt.attemptId,
      revision,
    );
    if (typeof deleted !== "boolean") fail("native delete result is invalid");
    return deleted;
  }

  async deleteExpired(nowMs: number): Promise<number> {
    requireNonNegativeSafeInteger(nowMs, "expiry time");
    const deleted = await this.backend.deleteExpired(nowMs);
    return requireNonNegativeSafeInteger(deleted, "native expired-delete count");
  }

  /**
   * The reducer's next envelope is durably CAS-stored before effects become
   * available to an interpreter. A rejected write returns no effects.
   */
  async persistReduction(
    current: StoredDesktopOperationEnvelopeV1,
    reduction: DesktopOperationReductionV1,
  ): Promise<PersistedDesktopOperationReductionV1> {
    if (reduction.mustPersistBeforeEffects !== true) {
      fail("reduction does not require store-before-effects ordering");
    }
    if (
      current.envelope.operationId !== reduction.envelope.operationId
      || current.envelope.attempt.attemptId !== reduction.envelope.attempt.attemptId
    ) {
      fail("reduction belongs to a different operation attempt");
    }
    const next = await this.update(current.revision, reduction.envelope);
    return Object.freeze({
      version: 1,
      stored: next,
      effects: Object.freeze([...reduction.effects]),
    });
  }
}

export function createNativeDesktopOperationJournalBackendV1(): DesktopOperationJournalBackendV1 {
  const backend: DesktopOperationJournalBackendV1 = {
    create: (envelope) => invoke("desktop_operation_journal_create", { envelope }),
    update: (expectedRevision, envelope) => invoke("desktop_operation_journal_update", {
      expectedRevision,
      envelope,
    }),
    load: (operationId, attemptId) => invoke("desktop_operation_journal_load", {
      operationId,
      attemptId,
    }),
    list: () => invoke("desktop_operation_journal_list"),
    delete: (operationId, attemptId, expectedRevision) => invoke(
      "desktop_operation_journal_delete",
      { operationId, attemptId, expectedRevision },
    ),
    deleteExpired: (nowMs) => invoke("desktop_operation_journal_delete_expired", { nowMs }),
  };
  return Object.freeze(backend);
}

/** Production construction is intentionally explicit; no browser fallback. */
export function createNativeDesktopOperationStoreV1(): DesktopOperationStoreV1 {
  return new DesktopOperationStoreV1(createNativeDesktopOperationJournalBackendV1());
}

function parseNativeRecord(value: unknown): StoredDesktopOperationEnvelopeV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("native record is invalid");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "revision" && key !== "envelope")) {
    fail("native record has unsupported fields");
  }
  const revision = requireRevision(record.revision, "native record revision");
  if (typeof record.envelope !== "string") fail("native record envelope is invalid");
  return stored(revision, parseDesktopOperationEnvelopeV1(record.envelope));
}

function requireWriteReceipt(value: unknown): NativeDesktopOperationJournalWriteReceiptV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("native write receipt is invalid");
  }
  const receipt = value as Record<string, unknown>;
  if (Object.keys(receipt).some((key) => key !== "revision")) {
    fail("native write receipt has unsupported fields");
  }
  return Object.freeze({
    revision: requireRevision(receipt.revision, "native write revision"),
  });
}

function stored(
  revision: number,
  envelope: DesktopOperationEnvelopeV1,
): StoredDesktopOperationEnvelopeV1 {
  serializeDesktopOperationEnvelopeV1(envelope);
  return Object.freeze({ revision, envelope });
}

function requireRevision(value: unknown, subject: string): number {
  const revision = requireNonNegativeSafeInteger(value, subject);
  if (revision < 1) fail(`${subject} must be positive`);
  return revision;
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

import type { Event } from "nostr-tools";
import { verifyEvent } from "nostr-tools/pure";

import {
  verifyFileTraceChain,
  type TraceConformanceIssue,
  type TraceConformanceStatus,
} from "./trace-conformance.js";

const BUNDLE_FORMAT = "zine-trace";
const BUNDLE_VERSION = 1;
const NODE_ID_PATTERN = /^[0-9a-f]{64}$/;
const SIGNATURE_PATTERN = /^[0-9a-f]{128}$/;
const MAX_TARGETS = 1_000;
const MAX_EVENTS = 10_000;
const MAX_EVENT_IDS_PER_TARGET = 10_000;
const MAX_TOTAL_EVENT_REFERENCES = 10_000;
const MAX_PATH_LENGTH = 1_024;
const MAX_EVENT_CONTENT_LENGTH = 16 * 1024 * 1024;
const MAX_TAGS_PER_EVENT = 4_096;
const MAX_TAG_VALUES = 32;
const MAX_TAG_VALUE_LENGTH = 16_384;
const MAX_DECLARED_ISSUES = 10_000;
const MAX_ISSUE_CODE_LENGTH = 256;
const MAX_ISSUE_MESSAGE_LENGTH = 8_192;

export type ReifyBundleIssueCategory =
  | "container-integrity"
  | "event-integrity"
  | "trace-conformance"
  | "materialized-file";

export interface ReifyBundleVerificationIssue {
  readonly category: ReifyBundleIssueCategory;
  readonly code: string;
  readonly message: string;
  readonly targetIndex?: number;
  readonly eventIndex?: number;
  readonly relativePath?: string;
  readonly eventId?: string;
  readonly stepIndex?: number;
}

export interface ReifyBundleDeclaredConformance {
  readonly status: TraceConformanceStatus;
  readonly issues: readonly TraceConformanceIssue[];
}

export interface ReifyBundleRecomputedConformance {
  readonly status: TraceConformanceStatus;
  readonly issues: readonly TraceConformanceIssue[];
  readonly steps: readonly {
    readonly nodeId: string;
    readonly stepIndex: number;
    readonly status: TraceConformanceStatus;
  }[];
}

export type ReifyMaterializedFileStatus =
  | "verified"
  | "match-unverified"
  | "missing"
  | "mismatch"
  | "unavailable";

export interface ReifyMaterializedFileVerification {
  readonly status: ReifyMaterializedFileStatus;
  readonly matchesSnapshot: boolean | null;
  readonly matchesSignedContentHash: boolean | null;
}

export interface ReifyBundleTargetVerification {
  readonly targetIndex: number;
  readonly relativePath: string | null;
  readonly traceId: string | null;
  readonly nucleusId: string | null;
  readonly eventIds: readonly string[];
  readonly declaredConformance: ReifyBundleDeclaredConformance | null;
  readonly recomputedConformance: ReifyBundleRecomputedConformance | null;
  readonly declarationMatches: boolean | null;
  readonly materializedFile: ReifyMaterializedFileVerification;
  readonly valid: boolean;
  readonly issues: readonly ReifyBundleVerificationIssue[];
}

export interface ReifyBundleEventVerification {
  readonly eventIndex: number;
  readonly eventId: string | null;
  readonly cryptographicallyValid: boolean;
  readonly valid: boolean;
  readonly issues: readonly ReifyBundleVerificationIssue[];
}

export interface ReifyBundleVerificationResult {
  readonly valid: boolean;
  readonly format: typeof BUNDLE_FORMAT | null;
  readonly version: typeof BUNDLE_VERSION | null;
  readonly targets: readonly ReifyBundleTargetVerification[];
  readonly events: readonly ReifyBundleEventVerification[];
  readonly issues: readonly ReifyBundleVerificationIssue[];
  readonly trustStatement: string;
}

export type ReifyBundleFileLoader = (
  relativePath: string,
) => unknown | Promise<unknown>;

export type ReifyBundleFileSource =
  | ReadonlyMap<string, unknown>
  | Readonly<Record<string, unknown>>
  | ReifyBundleFileLoader;

interface ParsedTarget {
  relativePath: string | null;
  traceId: string | null;
  nucleusId: string | null;
  eventIds: string[];
  eventIndexUsable: boolean;
  declaredConformance: ReifyBundleDeclaredConformance | null;
}

interface ParsedEvent {
  eventIndex: number;
  eventId: string | null;
  event: Event | null;
  cryptographicallyValid: boolean;
}

const TRUST_STATEMENT =
  "Valid event signatures prove only that the named pubkeys signed the events. They do not prove identity, truth, humanness, originality, or exclusive authorship.";

const EMPTY_FILE_VERIFICATION: ReifyMaterializedFileVerification = {
  status: "unavailable",
  matchesSnapshot: null,
  matchesSignedContentHash: null,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isCanonicalId(value: unknown): value is string {
  return typeof value === "string" && NODE_ID_PATTERN.test(value);
}

function addUnexpectedFieldIssues(
  value: Record<string, unknown>,
  allowed: readonly string[],
  addIssue: (code: string, message: string) => void,
): boolean {
  const allowedFields = new Set(allowed);
  let valid = true;
  for (const field of Object.keys(value)) {
    if (!allowedFields.has(field)) {
      addIssue("unexpected-field", `object carries unsupported field ${field}`);
      valid = false;
    }
  }
  return valid;
}

function isSafeRelativePath(value: string): boolean {
  if (
    value.length === 0 ||
    value.length > MAX_PATH_LENGTH ||
    value.startsWith("/") ||
    value.startsWith("\\") ||
    value.includes("\\") ||
    /^[A-Za-z]:/.test(value) ||
    /[\0-\x1f\x7f]/.test(value)
  ) {
    return false;
  }
  const segments = value.split("/");
  return (
    segments.every((segment) => segment !== "" && segment !== "." && segment !== "..") &&
    segments[0]?.toLowerCase() !== ".zine"
  );
}

function copyConformanceIssue(value: unknown): TraceConformanceIssue | null {
  if (!isRecord(value)) return null;
  const keys = Object.keys(value);
  if (keys.some((key) => !["kind", "code", "message", "stepIndex", "nodeId"].includes(key))) {
    return null;
  }
  if (
    (value.kind !== "process" && value.kind !== "integrity") ||
    typeof value.code !== "string" ||
    value.code.length === 0 ||
    value.code.length > MAX_ISSUE_CODE_LENGTH ||
    typeof value.message !== "string" ||
    value.message.length === 0 ||
    value.message.length > MAX_ISSUE_MESSAGE_LENGTH ||
    !Number.isSafeInteger(value.stepIndex) ||
    (value.stepIndex as number) < 0 ||
    (value.nodeId !== undefined && !isCanonicalId(value.nodeId))
  ) {
    return null;
  }
  return {
    kind: value.kind,
    code: value.code,
    message: value.message,
    stepIndex: value.stepIndex as number,
    ...(value.nodeId === undefined ? {} : { nodeId: value.nodeId }),
  };
}

function sameConformanceIssue(
  left: TraceConformanceIssue,
  right: TraceConformanceIssue,
): boolean {
  return (
    left.kind === right.kind &&
    left.code === right.code &&
    left.message === right.message &&
    left.stepIndex === right.stepIndex &&
    left.nodeId === right.nodeId
  );
}

function sameConformance(
  declared: ReifyBundleDeclaredConformance,
  recomputed: ReifyBundleRecomputedConformance,
): boolean {
  return (
    declared.status === recomputed.status &&
    declared.issues.length === recomputed.issues.length &&
    declared.issues.every((issue, index) =>
      sameConformanceIssue(issue, recomputed.issues[index]!),
    )
  );
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function verifyRawEvent(event: Event): boolean {
  try {
    return verifyEvent({
      id: event.id,
      pubkey: event.pubkey,
      created_at: event.created_at,
      kind: event.kind,
      tags: event.tags.map((tag) => [...tag]),
      content: event.content,
      sig: event.sig,
    });
  } catch {
    return false;
  }
}

async function readMaterializedFile(
  source: ReifyBundleFileSource,
  relativePath: string,
): Promise<{ found: boolean; value: unknown; failed: boolean }> {
  try {
    if (typeof source === "function") {
      const value = await source(relativePath);
      return { found: value !== undefined && value !== null, value, failed: false };
    }
    if (source instanceof Map) {
      return {
        found: source.has(relativePath),
        value: source.get(relativePath),
        failed: false,
      };
    }
    if (isRecord(source)) {
      return {
        found: Object.prototype.hasOwnProperty.call(source, relativePath),
        value: source[relativePath],
        failed: false,
      };
    }
    return { found: false, value: undefined, failed: true };
  } catch {
    return { found: false, value: undefined, failed: true };
  }
}

function invalidResult(
  issue: ReifyBundleVerificationIssue,
): ReifyBundleVerificationResult {
  return deepFreeze({
    valid: false,
    format: null,
    version: null,
    targets: [],
    events: [],
    issues: [issue],
    trustStatement: TRUST_STATEMENT,
  });
}

async function verifyReifyTraceBundleInternal(
  input: unknown,
  files: ReifyBundleFileSource,
): Promise<ReifyBundleVerificationResult> {
  const issues: ReifyBundleVerificationIssue[] = [];
  const addIssue = (issue: ReifyBundleVerificationIssue) => {
    issues.push(issue);
  };

  if (!isRecord(input)) {
    return invalidResult({
      category: "container-integrity",
      code: "invalid-container",
      message: "trace bundle must be a JSON object",
    });
  }
  addUnexpectedFieldIssues(
    input,
    ["format", "version", "targets", "events"],
    (code, message) => addIssue({ category: "container-integrity", code, message }),
  );

  const format = input.format === BUNDLE_FORMAT ? BUNDLE_FORMAT : null;
  if (format === null) {
    addIssue({
      category: "container-integrity",
      code: "unsupported-format",
      message: `trace bundle format must be ${BUNDLE_FORMAT}`,
    });
  }
  const version = input.version === BUNDLE_VERSION ? BUNDLE_VERSION : null;
  if (version === null) {
    addIssue({
      category: "container-integrity",
      code: "unsupported-version",
      message: `trace bundle version must be ${BUNDLE_VERSION}`,
    });
  }
  const rawTargets = Array.isArray(input.targets) ? input.targets : [];
  if (!Array.isArray(input.targets)) {
    addIssue({
      category: "container-integrity",
      code: "invalid-targets",
      message: "trace bundle targets must be an array",
    });
  } else if (input.targets.length > MAX_TARGETS) {
    addIssue({
      category: "container-integrity",
      code: "too-many-targets",
      message: `trace bundle exceeds the ${MAX_TARGETS} target limit`,
    });
  }
  const rawEvents = Array.isArray(input.events) ? input.events : [];
  if (!Array.isArray(input.events)) {
    addIssue({
      category: "container-integrity",
      code: "invalid-events",
      message: "trace bundle events must be an array",
    });
  } else if (input.events.length > MAX_EVENTS) {
    addIssue({
      category: "container-integrity",
      code: "too-many-events",
      message: `trace bundle exceeds the ${MAX_EVENTS} event limit`,
    });
  }

  const parsedTargets: ParsedTarget[] = [];
  const seenPaths = new Map<string, number>();
  let remainingEventReferences = MAX_TOTAL_EVENT_REFERENCES;
  for (let targetIndex = 0; targetIndex < Math.min(rawTargets.length, MAX_TARGETS); targetIndex += 1) {
    const rawTarget = rawTargets[targetIndex];
    let eventIndexUsable = true;
    const targetIssue = (code: string, message: string, relativePath?: string) => {
      addIssue({
        category: "container-integrity",
        code,
        message,
        targetIndex,
        ...(relativePath ? { relativePath } : {}),
      });
    };
    if (!isRecord(rawTarget)) {
      targetIssue("invalid-target", "bundle target must be a JSON object");
      parsedTargets.push({
        relativePath: null,
        traceId: null,
        nucleusId: null,
        eventIds: [],
        eventIndexUsable: false,
        declaredConformance: null,
      });
      continue;
    }
    addUnexpectedFieldIssues(
      rawTarget,
      ["relativePath", "traceId", "nucleusId", "eventIds", "conformance", "conformanceIssues"],
      (code, message) => targetIssue(code, message),
    );

    const relativePath = typeof rawTarget.relativePath === "string"
      ? rawTarget.relativePath
      : null;
    if (relativePath === null || !isSafeRelativePath(relativePath)) {
      targetIssue("unsafe-target-path", "target path must be a safe non-empty relative path");
    } else {
      const priorIndex = seenPaths.get(relativePath);
      if (priorIndex !== undefined) {
        targetIssue(
          "duplicate-target-path",
          `target path duplicates target ${priorIndex}`,
          relativePath,
        );
      } else {
        seenPaths.set(relativePath, targetIndex);
      }
    }

    const traceId = isCanonicalId(rawTarget.traceId) ? rawTarget.traceId : null;
    if (traceId === null) targetIssue("invalid-trace-id", "target traceId must be a canonical event id");
    const nucleusId = isCanonicalId(rawTarget.nucleusId) ? rawTarget.nucleusId : null;
    if (nucleusId === null) targetIssue("invalid-nucleus-id", "target nucleusId must be a canonical event id");

    const eventIds: string[] = [];
    const rawEventIds = Array.isArray(rawTarget.eventIds) ? rawTarget.eventIds : null;
    let parseEventIds = rawEventIds !== null;
    if (rawEventIds === null || rawEventIds.length === 0) {
      eventIndexUsable = false;
      parseEventIds = false;
      targetIssue("invalid-event-index", "target eventIds must be a non-empty ordered array");
    } else if (rawEventIds.length > MAX_EVENT_IDS_PER_TARGET) {
      eventIndexUsable = false;
      parseEventIds = false;
      targetIssue(
        "event-index-too-large",
        `target eventIds exceeds the ${MAX_EVENT_IDS_PER_TARGET} entry limit`,
      );
    } else if (rawEventIds.length > remainingEventReferences) {
      eventIndexUsable = false;
      parseEventIds = false;
      targetIssue(
        "event-reference-budget-exceeded",
        `trace bundle exceeds the ${MAX_TOTAL_EVENT_REFERENCES} total event-reference limit`,
      );
    } else {
      remainingEventReferences -= rawEventIds.length;
    }
    if (parseEventIds && rawEventIds !== null) {
      const seenIds = new Set<string>();
      for (let eventIndex = 0; eventIndex < rawEventIds.length; eventIndex += 1) {
        const eventId = rawEventIds[eventIndex];
        if (!isCanonicalId(eventId)) {
          eventIndexUsable = false;
          targetIssue("invalid-indexed-event-id", "target eventIds contains a non-canonical event id");
          continue;
        }
        eventIds.push(eventId);
        if (seenIds.has(eventId)) {
          targetIssue("duplicate-indexed-event-id", "target eventIds contains a duplicate event id");
        }
        seenIds.add(eventId);
      }
    }
    if (traceId !== null && !eventIds.includes(traceId)) {
      targetIssue("trace-id-not-indexed", "target traceId is absent from eventIds");
    } else if (traceId !== null && eventIds[0] !== traceId) {
      targetIssue("wrong-trace-endpoint", "target traceId must be the first eventId");
    }
    if (nucleusId !== null && !eventIds.includes(nucleusId)) {
      targetIssue("nucleus-id-not-indexed", "target nucleusId is absent from eventIds");
    } else if (nucleusId !== null && eventIds[eventIds.length - 1] !== nucleusId) {
      targetIssue("wrong-nucleus-endpoint", "target nucleusId must be the last eventId");
    }

    let declaredConformance: ReifyBundleDeclaredConformance | null = null;
    const status = rawTarget.conformance;
    if (status !== "full" && status !== "snapshot-only" && status !== "invalid") {
      addIssue({
        category: "container-integrity",
        code: "invalid-declared-conformance",
        message: "target conformance must use the shared reader vocabulary",
        targetIndex,
        ...(relativePath ? { relativePath } : {}),
      });
    } else if (
      !Array.isArray(rawTarget.conformanceIssues) ||
      rawTarget.conformanceIssues.length > MAX_DECLARED_ISSUES
    ) {
      addIssue({
        category: "container-integrity",
        code: "invalid-declared-conformance-issues",
        message: "target conformanceIssues must be a bounded array",
        targetIndex,
        ...(relativePath ? { relativePath } : {}),
      });
    } else {
      const copiedIssues = rawTarget.conformanceIssues.map(copyConformanceIssue);
      if (copiedIssues.some((issue) => issue === null)) {
        addIssue({
          category: "container-integrity",
          code: "invalid-declared-conformance-issue",
          message: "target conformanceIssues contains an invalid issue",
          targetIndex,
          ...(relativePath ? { relativePath } : {}),
        });
      } else {
        declaredConformance = {
          status,
          issues: copiedIssues as TraceConformanceIssue[],
        };
      }
    }
    parsedTargets.push({
      relativePath,
      traceId,
      nucleusId,
      eventIds,
      eventIndexUsable,
      declaredConformance,
    });
  }

  const parsedEvents: ParsedEvent[] = [];
  const eventOccurrences = new Map<string, number[]>();
  for (let eventIndex = 0; eventIndex < Math.min(rawEvents.length, MAX_EVENTS); eventIndex += 1) {
    const rawEvent = rawEvents[eventIndex];
    let structurallyValid = true;
    const eventIssue = (code: string, message: string, eventId?: string) => {
      structurallyValid = false;
      addIssue({
        category: "event-integrity",
        code,
        message,
        eventIndex,
        ...(eventId ? { eventId } : {}),
      });
    };
    if (!isRecord(rawEvent)) {
      eventIssue("invalid-event-shape", "bundle event must be a JSON object");
      parsedEvents.push({ eventIndex, eventId: null, event: null, cryptographicallyValid: false });
      continue;
    }
    if (!addUnexpectedFieldIssues(
      rawEvent,
      ["id", "pubkey", "created_at", "kind", "tags", "content", "sig"],
      (code, message) => eventIssue(code, message),
    )) {
      structurallyValid = false;
    }
    const eventId = isCanonicalId(rawEvent.id) ? rawEvent.id : null;
    if (eventId === null) eventIssue("invalid-event-id", "event id must be 64 lowercase hex characters");
    if (!isCanonicalId(rawEvent.pubkey)) {
      eventIssue("invalid-event-pubkey", "event pubkey must be 64 lowercase hex characters", eventId ?? undefined);
    }
    if (!Number.isSafeInteger(rawEvent.created_at) || (rawEvent.created_at as number) < 0) {
      eventIssue("invalid-event-created-at", "event created_at must be a non-negative safe integer", eventId ?? undefined);
    }
    if (
      !Number.isSafeInteger(rawEvent.kind) ||
      (rawEvent.kind as number) < 0 ||
      (rawEvent.kind as number) > 65_535
    ) {
      eventIssue("invalid-event-kind", "event kind must be an unsigned 16-bit integer", eventId ?? undefined);
    }
    if (typeof rawEvent.content !== "string" || rawEvent.content.length > MAX_EVENT_CONTENT_LENGTH) {
      eventIssue("invalid-event-content", "event content must be a bounded string", eventId ?? undefined);
    }
    if (typeof rawEvent.sig !== "string" || !SIGNATURE_PATTERN.test(rawEvent.sig)) {
      eventIssue("invalid-event-signature", "event signature must be 128 lowercase hex characters", eventId ?? undefined);
    }

    const tags: string[][] = [];
    if (!Array.isArray(rawEvent.tags) || rawEvent.tags.length > MAX_TAGS_PER_EVENT) {
      eventIssue("invalid-event-tags", "event tags must be a bounded array", eventId ?? undefined);
    } else {
      for (const rawTag of rawEvent.tags) {
        if (!Array.isArray(rawTag) || rawTag.length > MAX_TAG_VALUES) {
          eventIssue("invalid-event-tag", "event tag must be a bounded string array", eventId ?? undefined);
          continue;
        }
        if (rawTag.some((value) => typeof value !== "string" || value.length > MAX_TAG_VALUE_LENGTH)) {
          eventIssue("invalid-event-tag-value", "event tag values must be bounded strings", eventId ?? undefined);
          continue;
        }
        tags.push([...(rawTag as string[])]);
      }
    }

    const event = structurallyValid && eventId !== null
      ? {
          id: eventId,
          pubkey: rawEvent.pubkey as string,
          created_at: rawEvent.created_at as number,
          kind: rawEvent.kind as number,
          tags,
          content: rawEvent.content as string,
          sig: rawEvent.sig as string,
        }
      : null;
    const cryptographicallyValid = event !== null && verifyRawEvent(event);
    if (event !== null && !cryptographicallyValid) {
      addIssue({
        category: "event-integrity",
        code: "invalid-event",
        message: "event id or signature is invalid",
        eventIndex,
        eventId: event.id,
      });
    }
    if (eventId !== null) {
      const occurrences = eventOccurrences.get(eventId) ?? [];
      occurrences.push(eventIndex);
      eventOccurrences.set(eventId, occurrences);
    }
    parsedEvents.push({ eventIndex, eventId, event, cryptographicallyValid });
  }

  const uniqueEvents = new Map<string, ParsedEvent>();
  for (const parsedEvent of parsedEvents) {
    if (parsedEvent.eventId === null) continue;
    const occurrences = eventOccurrences.get(parsedEvent.eventId)!;
    if (occurrences.length > 1) {
      if (parsedEvent.eventIndex !== occurrences[0]) {
        addIssue({
          category: "container-integrity",
          code: "duplicate-event-id",
          message: `event id duplicates event ${occurrences[0]}`,
          eventIndex: parsedEvent.eventIndex,
          eventId: parsedEvent.eventId,
        });
      }
      continue;
    }
    uniqueEvents.set(parsedEvent.eventId, parsedEvent);
  }

  const referencedEventIds = new Set<string>();
  for (let targetIndex = 0; targetIndex < parsedTargets.length; targetIndex += 1) {
    const target = parsedTargets[targetIndex]!;
    for (const eventId of target.eventIds) {
      referencedEventIds.add(eventId);
      const occurrences = eventOccurrences.get(eventId);
      if (!occurrences) {
        addIssue({
          category: "container-integrity",
          code: "dangling-event-reference",
          message: "target eventIds references an event absent from the bundle",
          targetIndex,
          ...(target.relativePath ? { relativePath: target.relativePath } : {}),
          eventId,
        });
      } else if (occurrences.length > 1) {
        addIssue({
          category: "container-integrity",
          code: "ambiguous-event-reference",
          message: "target eventIds references a duplicate event id",
          targetIndex,
          ...(target.relativePath ? { relativePath: target.relativePath } : {}),
          eventId,
        });
      } else if (parsedEvents[occurrences[0]!]?.event === null) {
        addIssue({
          category: "container-integrity",
          code: "invalid-event-reference",
          message: "target eventIds references a structurally invalid event",
          targetIndex,
          ...(target.relativePath ? { relativePath: target.relativePath } : {}),
          eventId,
        });
      }
    }
  }
  for (const parsedEvent of parsedEvents) {
    if (parsedEvent.eventId !== null && !referencedEventIds.has(parsedEvent.eventId)) {
      addIssue({
        category: "container-integrity",
        code: "unindexed-event",
        message: "bundle event is not indexed by any target",
        eventIndex: parsedEvent.eventIndex,
        eventId: parsedEvent.eventId,
      });
    }
    for (const tag of parsedEvent.event?.tags ?? []) {
      if (
        tag[0] === "e" &&
        tag[3] === "prev" &&
        isCanonicalId(tag[1]) &&
        !eventOccurrences.has(tag[1])
      ) {
        addIssue({
          category: "container-integrity",
          code: "dangling-prev-reference",
          message: "event prev edge references an event absent from the bundle",
          eventIndex: parsedEvent.eventIndex,
          eventId: parsedEvent.eventId ?? undefined,
        });
      }
    }
  }

  const targetResults: ReifyBundleTargetVerification[] = [];
  const conformanceByChain = new Map<
    string,
    Awaited<ReturnType<typeof verifyFileTraceChain>>
  >();
  for (let targetIndex = 0; targetIndex < parsedTargets.length; targetIndex += 1) {
    const target = parsedTargets[targetIndex]!;
    let recomputedConformance: ReifyBundleRecomputedConformance | null = null;
    let declarationMatches: boolean | null = null;

    const chain = target.eventIndexUsable
      ? target.eventIds.map((eventId) => uniqueEvents.get(eventId)?.event ?? null)
      : [];
    if (target.eventIndexUsable && chain.every((event): event is Event => event !== null)) {
      const conformanceKey = JSON.stringify([
        target.traceId,
        target.nucleusId,
        target.eventIds,
      ]);
      let verdict = conformanceByChain.get(conformanceKey);
      if (!verdict) {
        verdict = await verifyFileTraceChain(chain, {
          expectedNucleusId: target.nucleusId ?? undefined,
          expectedTraceId: target.traceId ?? undefined,
        });
        conformanceByChain.set(conformanceKey, verdict);
      }
      recomputedConformance = {
        status: verdict.status,
        issues: verdict.issues.map((issue) => ({ ...issue })),
        steps: verdict.steps.map((step) => ({
          nodeId: step.nodeId,
          stepIndex: step.stepIndex,
          status: step.status,
        })),
      };
      for (const issue of verdict.issues) {
        addIssue({
          category: "trace-conformance",
          code: issue.code,
          message: issue.message,
          targetIndex,
          ...(target.relativePath ? { relativePath: target.relativePath } : {}),
          ...(issue.nodeId ? { eventId: issue.nodeId } : {}),
          stepIndex: issue.stepIndex,
        });
      }
      if (target.declaredConformance !== null) {
        declarationMatches = sameConformance(target.declaredConformance, recomputedConformance);
        if (!declarationMatches) {
          addIssue({
            category: "container-integrity",
            code: "declared-conformance-mismatch",
            message: "stored conformance status or issues disagree with the recomputed verdict",
            targetIndex,
            ...(target.relativePath ? { relativePath: target.relativePath } : {}),
          });
        }
      }
    }

    let materializedFile: ReifyMaterializedFileVerification = { ...EMPTY_FILE_VERIFICATION };
    if (target.relativePath !== null && isSafeRelativePath(target.relativePath) && target.nucleusId !== null) {
      const nucleus = uniqueEvents.get(target.nucleusId)?.event ?? null;
      let snapshot: string | null = null;
      let signedContentHash: string | null = null;
      if (nucleus !== null) {
        try {
          const content = JSON.parse(nucleus.content) as unknown;
          if (isRecord(content)) {
            snapshot = typeof content.snapshot === "string" ? content.snapshot : null;
            signedContentHash = typeof content.contentHash === "string" ? content.contentHash : null;
          }
        } catch {
          // The shared conformance verifier reports malformed signed content.
        }
      }
      if (snapshot !== null) {
        const loaded = await readMaterializedFile(files, target.relativePath);
        if (loaded.failed) {
          materializedFile = { ...EMPTY_FILE_VERIFICATION };
          addIssue({
            category: "materialized-file",
            code: "file-load-failed",
            message: "ordinary file loader failed",
            targetIndex,
            relativePath: target.relativePath,
          });
        } else if (!loaded.found) {
          materializedFile = {
            status: "missing",
            matchesSnapshot: false,
            matchesSignedContentHash: false,
          };
          addIssue({
            category: "materialized-file",
            code: "missing-file",
            message: "exported ordinary file is missing",
            targetIndex,
            relativePath: target.relativePath,
          });
        } else if (typeof loaded.value !== "string") {
          materializedFile = {
            status: "mismatch",
            matchesSnapshot: false,
            matchesSignedContentHash: false,
          };
          addIssue({
            category: "materialized-file",
            code: "invalid-file-content",
            message: "exported ordinary file content must be a string",
            targetIndex,
            relativePath: target.relativePath,
          });
        } else {
          const matchesSnapshot = loaded.value === snapshot;
          const matchesSignedContentHash = signedContentHash !== null &&
            await sha256Hex(loaded.value) === signedContentHash;
          const cryptographicallyBound =
            matchesSnapshot &&
            matchesSignedContentHash &&
            recomputedConformance?.status !== "invalid";
          materializedFile = {
            status: matchesSnapshot
              ? cryptographicallyBound ? "verified" : "match-unverified"
              : "mismatch",
            matchesSnapshot,
            matchesSignedContentHash,
          };
          if (!matchesSnapshot) {
            addIssue({
              category: "materialized-file",
              code: "file-content-mismatch",
              message: "exported ordinary file differs from the selected signed snapshot",
              targetIndex,
              relativePath: target.relativePath,
            });
          }
        }
      }
    }

    const targetIssues = issues.filter((issue) => issue.targetIndex === targetIndex);
    targetResults.push({
      targetIndex,
      relativePath: target.relativePath,
      traceId: target.traceId,
      nucleusId: target.nucleusId,
      eventIds: [...target.eventIds],
      declaredConformance: target.declaredConformance === null
        ? null
        : {
            status: target.declaredConformance.status,
            issues: target.declaredConformance.issues.map((issue) => ({ ...issue })),
          },
      recomputedConformance,
      declarationMatches,
      materializedFile,
      valid: targetIssues.length === 0,
      issues: targetIssues,
    });
  }

  const eventResults = parsedEvents.map((event) => {
    const eventIssues = issues.filter((issue) => issue.eventIndex === event.eventIndex);
    return {
      eventIndex: event.eventIndex,
      eventId: event.eventId,
      cryptographicallyValid: event.cryptographicallyValid,
      valid: eventIssues.length === 0,
      issues: eventIssues,
    };
  });

  return deepFreeze({
    valid: issues.length === 0,
    format,
    version,
    targets: targetResults,
    events: eventResults,
    issues,
    trustStatement: TRUST_STATEMENT,
  });
}

/**
 * Verify an untrusted parsed `.zine/trace.json` and its separately exported
 * ordinary files. Expected input failures are returned as frozen issues;
 * signed content is never rendered or executed by this reader.
 */
export async function verifyReifyTraceBundle(
  input: unknown,
  files: ReifyBundleFileSource,
): Promise<ReifyBundleVerificationResult> {
  try {
    return await verifyReifyTraceBundleInternal(input, files);
  } catch {
    return invalidResult({
      category: "container-integrity",
      code: "reader-failure",
      message: "trace bundle could not be safely inspected",
    });
  }
}

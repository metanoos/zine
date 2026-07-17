import type { ProtocolEvent, TraceEventVerifier } from "./event.js";

import {
  traceProcessFromEvent,
  type TraceProcessView,
} from "./trace-process.js";

const TRACE_NODE_KIND = 4290;
const NODE_ID_PATTERN = /^[0-9a-f]{64}$/;

export type TraceConformanceStatus = "full" | "snapshot-only" | "invalid";

export type TraceConformanceIssueKind = "process" | "integrity";

export interface TraceConformanceIssue {
  kind: TraceConformanceIssueKind;
  code: string;
  message: string;
  stepIndex: number;
  nodeId?: string;
}

export interface TraceConformanceStep {
  nodeId: string;
  stepIndex: number;
  status: TraceConformanceStatus;
  process: TraceProcessView;
}

export interface TraceConformanceVerdict {
  status: TraceConformanceStatus;
  issues: TraceConformanceIssue[];
  steps: TraceConformanceStep[];
}

export interface VerifyFileTraceOptions {
  /** False when a self-contained nucleus is readable but private or missing
   * ancestry prevents the reader from validating its complete process. */
  historyComplete?: boolean;
  expectedOwnerPubkey?: string;
  expectedRootId?: string;
  expectedRelativePath?: string;
  expectedNucleusId?: string;
  expectedTraceId?: string;
}

export interface FileTraceInspection {
  chain: ProtocolEvent[];
  historyComplete: boolean;
  missingPreviousNodeId?: string;
  verdict: TraceConformanceVerdict;
}

export type TraceEventLoader = (nodeId: string) => Promise<ProtocolEvent | null>;

function statusForIssues(issues: readonly TraceConformanceIssue[]): TraceConformanceStatus {
  if (issues.some((issue) => issue.kind === "integrity")) return "invalid";
  if (issues.some((issue) => issue.kind === "process")) return "snapshot-only";
  return "full";
}

export function traceConformanceLabel(status: TraceConformanceStatus): string {
  if (status === "full") return "FULL TRACE";
  if (status === "snapshot-only") return "SNAPSHOT ONLY";
  return "INVALID";
}

export function combineTraceConformance(
  verdicts: readonly TraceConformanceVerdict[],
): TraceConformanceVerdict {
  const issues = verdicts.flatMap((verdict) => verdict.issues);
  return {
    status: statusForIssues(issues),
    issues,
    steps: verdicts.flatMap((verdict) => verdict.steps),
  };
}

function verifyRawEvent(event: ProtocolEvent, verifyEvent: TraceEventVerifier): boolean {
  // nostr-tools memoizes verification on the object. Verify a field-only copy
  // so a cached success cannot survive later mutation by a caller.
  return verifyEvent({
    id: event.id,
    pubkey: event.pubkey,
    created_at: event.created_at,
    kind: event.kind,
    tags: event.tags.map((tag) => [...tag]),
    content: event.content,
    sig: event.sig,
  });
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

function processUnavailable(reason: string): TraceProcessView {
  return { status: "invalid", transactions: [], reason };
}

function isNodeId(value: unknown): value is string {
  return typeof value === "string" && NODE_ID_PATTERN.test(value);
}

function validateDeltaTransition(
  before: string,
  after: string,
  deltas: unknown,
): { valid: boolean; reason?: string } {
  if (!Array.isArray(deltas)) {
    return { valid: false, reason: "deltas is not an array" };
  }

  let current = before;
  for (let index = 0; index < deltas.length; index += 1) {
    const candidate = deltas[index];
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      return { valid: false, reason: `delta ${index} is not an object` };
    }
    const delta = candidate as {
      type?: unknown;
      position?: unknown;
      newValue?: unknown;
    };
    if (delta.type !== "insert" && delta.type !== "delete" && delta.type !== "replace") {
      continue;
    }
    if (!delta.position || typeof delta.position !== "object" || Array.isArray(delta.position)) {
      return { valid: false, reason: `body delta ${index} has no valid position` };
    }
    const { start, end } = delta.position as { start?: unknown; end?: unknown };
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      (start as number) < 0 ||
      (end as number) < (start as number) ||
      (end as number) > current.length
    ) {
      return { valid: false, reason: `body delta ${index} addresses text outside its pre-state` };
    }

    let replacement: string;
    if (delta.type === "insert") {
      if (start !== end || typeof delta.newValue !== "string") {
        return { valid: false, reason: `body delta ${index} is not a valid insertion` };
      }
      replacement = delta.newValue;
    } else if (delta.type === "delete") {
      if (end === start || (delta.newValue !== null && delta.newValue !== "")) {
        return { valid: false, reason: `body delta ${index} is not a valid deletion` };
      }
      replacement = "";
    } else {
      if (end === start || typeof delta.newValue !== "string" || delta.newValue.length === 0) {
        return { valid: false, reason: `body delta ${index} is not a valid replacement` };
      }
      replacement = delta.newValue;
    }
    current = `${current.slice(0, start as number)}${replacement}${current.slice(end as number)}`;
  }

  return current === after
    ? { valid: true }
    : { valid: false, reason: "body deltas do not reproduce the signed snapshot" };
}

function withIssue(
  verdict: TraceConformanceVerdict,
  issue: TraceConformanceIssue,
): TraceConformanceVerdict {
  const issues = [...verdict.issues, issue];
  return { ...verdict, status: statusForIssues(issues), issues };
}

/**
 * Verify one genesis→nucleus file chain with a single reader vocabulary.
 *
 * Snapshot integrity and process integrity deliberately have different
 * failure states. A signed, hash-valid snapshot remains readable when its
 * KEdit evidence is missing or does not replay; it is SNAPSHOT ONLY. Broken
 * event integrity or lineage is INVALID. Only both together are FULL TRACE.
 */
export async function verifyFileTraceChain(
  chain: readonly ProtocolEvent[],
  verifyEvent: TraceEventVerifier,
  options: VerifyFileTraceOptions = {},
): Promise<TraceConformanceVerdict> {
  const historyComplete = options.historyComplete !== false;
  const issues: TraceConformanceIssue[] = [];
  const steps: TraceConformanceStep[] = [];
  if (chain.length === 0) {
    return {
      status: "invalid",
      issues: [{
        kind: "integrity",
        code: "empty-chain",
        message: "file trace has no signed nucleus",
        stepIndex: 0,
      }],
      steps,
    };
  }

  const first = chain[0]!;
  const last = chain[chain.length - 1]!;
  const owner = first.pubkey;
  let previousSnapshot = "";
  let ancestorIntegrityFailed = false;

  for (let stepIndex = 0; stepIndex < chain.length; stepIndex += 1) {
    const event = chain[stepIndex]!;
    const issueStart = issues.length;
    const addIntegrity = (code: string, message: string) => {
      issues.push({
        kind: "integrity",
        code,
        message,
        stepIndex,
        nodeId: event.id,
      });
    };

    if (!verifyRawEvent(event, verifyEvent)) {
      addIntegrity("invalid-event", "event id or signature is invalid");
    }
    const reifications = event.tags.filter((tag) => tag[0] === "z");
    if (
      event.kind !== TRACE_NODE_KIND ||
      reifications.length !== 1 ||
      reifications[0]?.[1] !== "file"
    ) {
      addIntegrity("not-file-node", "event is not exactly one file TraceNode");
    }
    const rootTags = event.tags.filter((tag) => tag[0] === "f");
    if (rootTags.length !== 1 || !rootTags[0]?.[1]) {
      addIntegrity("invalid-root-tag", "file TraceNode must carry exactly one Root tag");
    }
    const pathTags = event.tags.filter((tag) => tag[0] === "F");
    if (pathTags.length !== 1 || !pathTags[0]?.[1]) {
      addIntegrity("invalid-path-tag", "file TraceNode must carry exactly one structural name");
    }
    if (event.pubkey !== owner) {
      addIntegrity("owner-changed", "prev chain changes owner");
    }

    const previousTags = event.tags.filter(
      (tag) => tag[0] === "e" && tag[3] === "prev",
    );
    if (previousTags.length > 1) {
      addIntegrity("ambiguous-prev", "file TraceNode carries more than one prev edge");
    } else if (previousTags.length === 1 && !isNodeId(previousTags[0]?.[1])) {
      addIntegrity("malformed-prev", "prev edge does not carry a canonical event id");
    } else if (stepIndex === 0) {
      if (historyComplete && previousTags.length !== 0) {
        addIntegrity("non-genesis-start", "complete chain does not begin at genesis");
      }
    } else if (
      previousTags.length !== 1 ||
      previousTags[0]?.[1] !== chain[stepIndex - 1]?.id
    ) {
      addIntegrity("broken-prev", "prev edge does not name the preceding chain node");
    }

    let parsed: { snapshot?: unknown; contentHash?: unknown; deltas?: unknown } = {};
    try {
      const value = JSON.parse(event.content) as unknown;
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        addIntegrity("malformed-content", "node content is not a JSON object");
      } else {
        parsed = value as typeof parsed;
      }
    } catch {
      addIntegrity("malformed-content", "node content is not valid JSON");
    }
    if (typeof parsed.snapshot !== "string") {
      addIntegrity("missing-snapshot", "file TraceNode has no signed text snapshot");
    }
    if (typeof parsed.contentHash !== "string") {
      addIntegrity("missing-content-hash", "file TraceNode has no snapshot content hash");
    } else if (
      typeof parsed.snapshot === "string" &&
      await sha256Hex(parsed.snapshot) !== parsed.contentHash
    ) {
      addIntegrity("snapshot-hash-mismatch", "signed snapshot hash mismatch");
    }
    const carriesDeltas = Object.prototype.hasOwnProperty.call(parsed, "deltas");
    if (carriesDeltas && !Array.isArray(parsed.deltas)) {
      addIntegrity("nonconforming-deltas", "file TraceNode deltas is not an array");
    } else if (
      stepIndex > 0 &&
      carriesDeltas &&
      typeof parsed.snapshot === "string"
    ) {
      const deltaValidation = validateDeltaTransition(
        previousSnapshot,
        parsed.snapshot,
        parsed.deltas,
      );
      if (!deltaValidation.valid) {
        addIntegrity(
          "nonconforming-deltas",
          deltaValidation.reason ?? "body deltas do not reproduce the signed snapshot",
        );
      }
    }

    const priorAvailable = stepIndex > 0 || historyComplete;
    const process = typeof parsed.snapshot !== "string"
      ? processUnavailable("signed text snapshot is unavailable")
      : priorAvailable
        ? traceProcessFromEvent(event, previousSnapshot)
        : processUnavailable("previous snapshot is unavailable with private or missing history");
    if (process.status !== "complete") {
      issues.push({
        kind: "process",
        code: priorAvailable ? "nonconforming-kedits" : "process-history-unavailable",
        message: process.reason ?? "KEdit process could not be validated",
        stepIndex,
        nodeId: event.id,
      });
    }

    const stepIssues = issues.slice(issueStart);
    if (stepIssues.some((issue) => issue.kind === "integrity")) {
      ancestorIntegrityFailed = true;
    }
    steps.push({
      nodeId: event.id,
      stepIndex,
      status: ancestorIntegrityFailed ? "invalid" : statusForIssues(stepIssues),
      process,
    });
    if (typeof parsed.snapshot === "string") previousSnapshot = parsed.snapshot;
  }

  if (!historyComplete) {
    issues.push({
      kind: "process",
      code: "history-incomplete",
      message: "complete prev history is unavailable; the signed nucleus remains readable",
      stepIndex: 0,
      nodeId: first.id,
    });
  }
  if (options.expectedOwnerPubkey && last.pubkey !== options.expectedOwnerPubkey) {
    issues.push({
      kind: "integrity",
      code: "unexpected-owner",
      message: "nucleus is signed by an unexpected owner",
      stepIndex: chain.length - 1,
      nodeId: last.id,
    });
  }
  if (options.expectedNucleusId && last.id !== options.expectedNucleusId) {
    issues.push({
      kind: "integrity",
      code: "unexpected-nucleus",
      message: "resolved chain ends at the wrong nucleus",
      stepIndex: chain.length - 1,
      nodeId: last.id,
    });
  }
  if (options.expectedTraceId && historyComplete && first.id !== options.expectedTraceId) {
    issues.push({
      kind: "integrity",
      code: "unexpected-trace",
      message: "resolved genesis does not match the requested trace identity",
      stepIndex: 0,
      nodeId: first.id,
    });
  }
  const nucleusRoot = last.tags.find((tag) => tag[0] === "f")?.[1];
  if (options.expectedRootId && nucleusRoot !== options.expectedRootId) {
    issues.push({
      kind: "integrity",
      code: "unexpected-root",
      message: "nucleus Root does not match the requested Root",
      stepIndex: chain.length - 1,
      nodeId: last.id,
    });
  }
  const nucleusPath = last.tags.find((tag) => tag[0] === "F")?.[1];
  if (options.expectedRelativePath && nucleusPath !== options.expectedRelativePath) {
    issues.push({
      kind: "integrity",
      code: "unexpected-path",
      message: "nucleus structural name does not match the requested file",
      stepIndex: chain.length - 1,
      nodeId: last.id,
    });
  }

  return { status: statusForIssues(issues), issues, steps };
}

/** Resolve as much exact ancestry as is available, then apply the same reader
 * verdict. Missing private ancestry downgrades to SNAPSHOT ONLY; ambiguous,
 * cyclic, or mismatched ancestry is INVALID. */
export async function inspectFileTraceNucleus(
  nucleus: ProtocolEvent,
  loadEvent: TraceEventLoader,
  verifyEvent: TraceEventVerifier,
  options: Omit<VerifyFileTraceOptions, "historyComplete"> = {},
): Promise<FileTraceInspection> {
  const newestFirst: ProtocolEvent[] = [nucleus];
  const seen = new Set<string>([nucleus.id]);
  let historyComplete = false;
  let missingPreviousNodeId: string | undefined;
  let integrityIssue: TraceConformanceIssue | undefined;

  while (true) {
    const current = newestFirst[newestFirst.length - 1]!;
    const previousTags = current.tags.filter(
      (tag) => tag[0] === "e" && tag[3] === "prev",
    );
    if (previousTags.length === 0) {
      historyComplete = true;
      break;
    }
    if (previousTags.length > 1) break;
    const previousId = previousTags[0]?.[1];
    if (!isNodeId(previousId)) {
      integrityIssue = {
        kind: "integrity",
        code: "malformed-prev",
        message: "prev edge does not carry a canonical event id",
        stepIndex: 0,
        nodeId: current.id,
      };
      break;
    }
    if (seen.has(previousId)) {
      integrityIssue = {
        kind: "integrity",
        code: "cyclic-prev",
        message: "prev chain is cyclic",
        stepIndex: 0,
        nodeId: current.id,
      };
      break;
    }
    seen.add(previousId);
    const previous = await loadEvent(previousId);
    if (!previous) {
      missingPreviousNodeId = previousId;
      break;
    }
    if (previous.id !== previousId) {
      integrityIssue = {
        kind: "integrity",
        code: "wrong-loaded-event",
        message: "ancestry loader returned the wrong event",
        stepIndex: 0,
        nodeId: current.id,
      };
      break;
    }
    newestFirst.push(previous);
  }

  const chain = newestFirst.reverse();
  let verdict = await verifyFileTraceChain(chain, verifyEvent, {
    ...options,
    historyComplete,
  });
  if (
    integrityIssue &&
    !verdict.issues.some(
      (issue) => issue.code === integrityIssue.code && issue.nodeId === integrityIssue.nodeId,
    )
  ) {
    verdict = withIssue(verdict, integrityIssue);
  }
  return {
    chain,
    historyComplete,
    ...(missingPreviousNodeId ? { missingPreviousNodeId } : {}),
    verdict,
  };
}

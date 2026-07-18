import { renderTraceProcessSummary } from "../provenance/trace-process.js";
import { traceConformanceLabel } from "../provenance/trace-conformance.js";
import type { DeltaLogEntry } from "./context-block.js";
import type { SelectedEvidenceV1 } from "@zine/trace-context";
import {
  PROMPT_LAYER_VERSIONS,
  type PreparedOperation,
} from "./prepared-operation.js";
import {
  freezeTraceContextInspectorPresentationV1,
  type TraceContextInspectorCompilationErrorV1,
  type TraceContextInspectorExcludedEvidenceSummaryV1,
  type TraceContextInspectorInertDirectiveV1,
  type TraceContextInspectorPresentationV1,
  type TraceContextInspectorRangeV1,
  type TraceContextInspectorSelectedEvidenceV1,
} from "./trace-context-inspector-presentation.js";

const encoder = new TextEncoder();

interface FrozenTraceRow {
  readonly inputPath: string;
  readonly inputTraceId: string | null;
  readonly inputHeadId: string | null;
  readonly entry: DeltaLogEntry;
}

/**
 * Pure projection from an already-frozen prepared operation into the local,
 * non-sensitive Inspector DTO. This does not gather, select, rebuild prompts,
 * resolve private storage, or add authority that was not frozen at prepare.
 */
export function adaptPreparedOperationForTraceContextInspector(
  prepared: PreparedOperation,
): TraceContextInspectorPresentationV1 {
  const authoring = prepared.traceAuthoring;
  const operationRange = operationRangeForPrepared(prepared);
  const excerpts = new Map(
    authoring?.compiled.excerpts.map((excerpt) => [excerpt.id, excerpt]) ?? [],
  );

  const directives = authoring?.compiled.directives.map((directive) => {
    const excerpt = excerpts.get(directive.localAnchor.excerptId);
    if (!excerpt) {
      throw new Error(`Prepared directive ${directive.id} has no frozen local excerpt`);
    }
    return {
      id: directive.id,
      ordinal: directive.ordinal,
      marker: directive.marker,
      displayInstruction: directive.instruction,
      classification: "instruction" as const,
      sourceRange: copyRange(directive.sourceRange),
      instructionRange: copyRange(directive.instructionRange),
      localExcerpt: {
        displayText: excerpt.text,
        sourceRange: copyRange(excerpt.sourceRange),
        byteLength: excerpt.byteLength,
        relation: directive.localAnchor.relation,
        omittedBefore: excerpt.omittedBefore,
        omittedAfter: excerpt.omittedAfter,
      },
      state: "pending" as const,
      canExclude: false,
      canReactivate: false,
    };
  }) ?? [];

  const protectedRanges = authoring?.compiled.scan.protectedRanges
    .filter((protectedRange) => containsRange(operationRange, protectedRange.range))
    .map((protectedRange) => ({
      id: protectedRange.id,
      sourceRange: copyRange(protectedRange.range),
      displayText: protectedRange.text,
      classification: "quoted-data" as const,
    })) ?? [];

  const inertDirectives: TraceContextInspectorInertDirectiveV1[] =
    authoring?.compiled.decisions
      .flatMap((decision): TraceContextInspectorInertDirectiveV1[] => {
        if (decision.reason === "authorized") return [];
        return [{
          id: decision.candidate.id,
          ordinal: decision.candidate.ordinal,
          displayCandidate: prepared.contextSnapshot.target.body.slice(
            decision.candidate.range.fromUtf16,
            decision.candidate.range.toUtf16,
          ),
          sourceRange: copyRange(decision.candidate.range),
          classification: "quoted-data",
          reason: decision.reason,
          canPromote: false,
        }];
      }) ?? [];

  // The scan may retain malformed syntax wholly outside the operation range.
  // Such errors are inspectable but did not block this prepared request.
  const compilationErrors: TraceContextInspectorCompilationErrorV1[] =
    authoring?.compiled.scan.errors.map((error, index) => ({
      id: `trace-authoring-error:${index}:${error.code}:${error.range.fromUtf16}`,
      code: error.code,
      displayMessage: error.message,
      sourceRange: copyRange(error.range),
      ...(error.relatedRange ? { relatedRange: copyRange(error.relatedRange) } : {}),
    })) ?? [];

  const selection = prepared.traceContextSelection;
  const traceRows = selection ? [] : orderedTraceRows(prepared);
  const selectedEvidence = selection
    ? selection.manifest.selected.map(selectedEvidenceForSelection)
    : traceRows.map((row, index) => selectedEvidenceForTraceRow(row, index));
  const excludedEvidence = selection
    ? excludedEvidenceForSelection(selection.decisions)
    : excludedEvidenceForSnapshot(prepared);
  const snapshot = prepared.contextSnapshot;

  return freezeTraceContextInspectorPresentationV1({
    version: 1,
    // Selection-backed preparations project their frozen package policy;
    // legacy preparations retain the bounded chronological snapshot label.
    policy: selection?.manifest.policy ?? "bounded-trace-v1",
    operation: prepared.operation,
    targetRevision: {
      traceId: prepared.targetRevision.traceId,
      headId: prepared.targetRevision.headId,
      contentHash: prepared.targetRevision.contentHash,
      displayPath: prepared.targetRevision.path,
      operationRange,
    },
    directives,
    protectedRanges,
    inertDirectives,
    compilationErrors,
    selectedEvidence,
    excludedEvidence,
    metadata: {
      completeness: {
        complete: selection ? selection.manifest.completeness.selectionComplete : snapshot.completeness.complete,
        failures: selection ? [] : snapshot.completeness.failures.map((failure) => ({
          code: `SNAPSHOT_${failure.stage.toUpperCase()}`,
          displayLabel: `${failure.path || "Root"}: ${failure.message}`,
        })),
      },
      budget: {
        effectiveContextBytes: selection?.manifest.budget.effectiveContextBytes ?? snapshot.budget.maxBytes,
        // PreparedOperation owns the exact context bytes sent. This can differ
        // from the immutable raw snapshot after directive markerization.
        usedContextBytes: prepared.budget.contextBytes,
        candidateCount: selection?.manifest.budget.candidateCount ?? traceRows.length,
        selectedCount: selectedEvidence.length,
        // Package selection reports its own deterministic truncation; the
        // legacy snapshot path still fails closed rather than truncating.
        truncated: selection?.manifest.budget.truncated ?? false,
      },
      versions: {
        compiler: authoring
          ? `trace-authoring-adapter:v${authoring.version}/kernel:v${authoring.kernelVersion}`
          : `not-applied:${prepared.operation}`,
        selector: selection ? "@zine/trace-context:selectTraceContextV1" : "context-snapshot:v1/bounded-chronological",
        renderer: selection?.manifest.contract ?? "context-block:v1",
        promptLayers: [...PROMPT_LAYER_VERSIONS],
      },
      fingerprint: selection?.manifest.hashes.frozenInputsSha256 ?? prepared.contextFingerprint,
      ...(selection ? {
        selectionIdentities: {
          frozenInputsSha256: selection.manifest.hashes.frozenInputsSha256,
          renderedContextSha256: selection.manifest.hashes.renderedContextSha256,
          manifestSha256: selection.manifestSha256,
        },
      } : {}),
    },
  });
}

function operationRangeForPrepared(prepared: PreparedOperation): TraceContextInspectorRangeV1 {
  const selectedRange = prepared.traceContextSelection?.manifest.operation.range;
  if (selectedRange) return copyRange(selectedRange);
  if (prepared.traceAuthoring) return copyRange(prepared.traceAuthoring.operationRange);
  const bodyLength = prepared.contextSnapshot.target.body.length;
  return {
    fromUtf16: prepared.operationInputs.sourceFrom
      ?? prepared.operationInputs.rangeFrom
      ?? 0,
    toUtf16: prepared.operationInputs.sourceTo
      ?? prepared.operationInputs.rangeTo
      ?? bodyLength,
  };
}

function selectedEvidenceForSelection(
  evidence: SelectedEvidenceV1,
  selectionOrder: number,
): TraceContextInspectorSelectedEvidenceV1 {
  const source = evidence.source;
  return {
    id: evidence.id,
    selectionOrder,
    kind: evidence.kind === "explicit-preference"
      ? "preference"
      : evidence.kind === "operation-instruction" ? "instruction" : evidence.kind,
    displayClaim: evidence.fact
      ? `${evidence.fact.kind}: ${JSON.stringify(evidence.fact)}`
      : `${evidence.kind} (${evidence.id})`,
    classification: evidence.authority,
    source: {
      displayLabel: source.ref,
      ...("traceId" in source ? { traceId: source.traceId } : {}),
      ...("headId" in source ? { headId: source.headId } : {}),
      ...("nodeId" in source ? { nodeId: source.nodeId } : {}),
      ...("range" in source && source.range ? { sourceRange: copyRange(source.range) } : {}),
    },
    scope: source.kind === "operation" ? "operation" : "file",
    selectionReasons: [...evidence.reasons],
    sensitivity: evidence.kind === "citation" ? "public" : "trace-private",
    byteCost: evidence.renderedByteCost,
    byteCostLabel: "rendered context bytes",
    canExclude: false,
  };
}

function excludedEvidenceForSelection(
  decisions: NonNullable<PreparedOperation["traceContextSelection"]>["decisions"],
): readonly TraceContextInspectorExcludedEvidenceSummaryV1[] {
  const budget = decisions.filter((decision) =>
    decision.disposition === "excluded" && decision.reason === "budget-exceeded");
  const duplicate = decisions.filter((decision) => decision.disposition === "collapsed");
  return [
    ...(budget.length > 0 ? [{
      reason: "budget" as const,
      count: budget.length,
      displayLabel: "Candidates outside the exact rendered-context budget",
      firstRejectedSource: { displayLabel: budget[0]!.candidateId },
    }] : []),
    ...(duplicate.length > 0 ? [{
      reason: "duplicate" as const,
      count: duplicate.length,
      displayLabel: "Duplicate candidates collapsed by the selector",
      firstRejectedSource: { displayLabel: duplicate[0]!.candidateId },
    }] : []),
  ];
}

function orderedTraceRows(prepared: PreparedOperation): readonly FrozenTraceRow[] {
  const inputsByPath = new Map(
    prepared.contextSnapshot.inputs.map((input) => [input.path, input]),
  );
  return prepared.contextSnapshot.deltaLog
    .map((entry) => {
      const input = inputsByPath.get(entry.relativePath);
      return {
        inputPath: entry.relativePath,
        inputTraceId: input?.traceId ?? null,
        inputHeadId: input?.headId ?? null,
        entry,
      };
    })
    .sort((left, right) =>
      left.entry.steppedAt - right.entry.steppedAt
      || left.entry.seq - right.entry.seq
      || compareText(left.inputPath, right.inputPath)
      || compareText(left.entry.nodeId ?? "", right.entry.nodeId ?? ""));
}

function selectedEvidenceForTraceRow(
  row: FrozenTraceRow,
  selectionOrder: number,
): TraceContextInspectorSelectedEvidenceV1 {
  const { entry } = row;
  const processSummary = renderTraceProcessSummary(entry.process);
  const conformance = entry.conformance ? traceConformanceLabel(entry.conformance) : "";
  const timestamp = Number.isFinite(entry.steppedAt)
    ? new Date(entry.steppedAt).toISOString()
    : `${entry.steppedAt}ms`;
  const displayedPath = entry.action === "rename" && entry.fromPath
    ? `${entry.fromPath} → ${entry.relativePath}`
    : entry.relativePath;
  const displayClaim = [
    `${entry.source === "folder" ? "Folder" : "File"} trace row #${entry.seq}`,
    entry.action,
    displayedPath,
    timestamp,
    conformance,
    processSummary,
  ].filter(Boolean).join(" · ");
  const selectionReasons = [
    "Included by the current bounded chronological context",
    entry.conformance === "full" ? "Full Trace process status" : "Status retained as quoted data",
    "Item size is its serialized source record; the budget below is the exact prepared-operation context total",
  ];
  return {
    id: [
      "trace-row",
      entry.source,
      entry.nodeId ?? "unsigned",
      entry.seq,
      entry.action,
      entry.fromPath ?? "",
      entry.relativePath,
    ].join(":"),
    selectionOrder,
    kind: "process-fact",
    displayClaim,
    classification: "quoted-data",
    source: {
      displayLabel: `Trace row #${entry.seq} · ${entry.relativePath}`,
      ...(entry.source === "file" && row.inputTraceId ? { traceId: row.inputTraceId } : {}),
      ...(entry.source === "file" && row.inputHeadId ? { headId: row.inputHeadId } : {}),
      ...(entry.nodeId ? { nodeId: entry.nodeId } : {}),
    },
    scope: entry.source === "folder" ? "folder" : "file",
    selectionReasons,
    sensitivity: "trace-private",
    byteCost: encoder.encode(JSON.stringify(entry)).length,
    byteCostLabel: "source record bytes",
    canExclude: false,
  };
}

function excludedEvidenceForSnapshot(
  prepared: PreparedOperation,
): readonly TraceContextInspectorExcludedEvidenceSummaryV1[] {
  const shielded = prepared.contextSnapshot.shields.filter(
    (decision) => decision.decision === "shielded",
  ).length;
  const outsideMount = prepared.contextSnapshot.shields.filter(
    (decision) => decision.decision === "outside-mount",
  ).length;
  const summaries: TraceContextInspectorExcludedEvidenceSummaryV1[] = [];
  if (shielded > 0) {
    summaries.push({
      reason: "policy-excluded",
      count: shielded,
      displayLabel: "Paths behind an explicit context shield",
    });
  }
  if (outsideMount > 0) {
    summaries.push({
      reason: "policy-excluded",
      count: outsideMount,
      displayLabel: "Paths outside the active context mount",
    });
  }
  return summaries;
}

function containsRange(outer: TraceContextInspectorRangeV1, inner: TraceContextInspectorRangeV1): boolean {
  return outer.fromUtf16 <= inner.fromUtf16 && outer.toUtf16 >= inner.toUtf16;
}

function copyRange(range: TraceContextInspectorRangeV1): TraceContextInspectorRangeV1 {
  return { fromUtf16: range.fromUtf16, toUtf16: range.toUtf16 };
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

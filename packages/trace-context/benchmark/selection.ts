import { pathToFileURL } from "node:url";

import {
  selectTraceContextV1,
  type EvidenceCandidateV1,
  type TraceContextSelectionInputV1,
} from "../src/index.js";

export const SELECTOR_RELATIVE_SIZES_V1 = Object.freeze([0, 100, 1_000, 10_000] as const);

export interface SelectorRelativeResultV1 {
  version: 1;
  size: number;
  projectedInputBytes: number;
  renderedContextBytes: number;
  selectedCount: number;
  budgetExcludedCount: number;
  selectionComplete: true;
  frozenInputsSha256: string;
  renderedContextSha256: string;
  manifestSha256: string;
}

export function buildSelectorRelativeInputV1(
  size: number,
  reverse = false,
): TraceContextSelectionInputV1 {
  if (!Number.isSafeInteger(size) || size < 0 || size > 10_000) {
    throw new RangeError("selector relative size must be an integer from 0 through 10,000");
  }
  const candidates: EvidenceCandidateV1[] = Array.from({ length: size }, (_, index) => {
    const ordinal = index.toString().padStart(5, "0");
    return {
      version: 1,
      id: `citation-${ordinal}`,
      dedupeKey: `citation-${ordinal}`,
      kind: "citation",
      claimClass: "explicit",
      source: {
        kind: "citation",
        ref: `citation:${ordinal}`,
        nodeId: `node-${ordinal}`,
        approvedOrder: index,
      },
      reasons: ["approved-direct-citation"],
      text: `Quoted deterministic source ${ordinal}.`,
    };
  });
  if (reverse) candidates.reverse();
  return {
    version: 1,
    policy: "selected-trace-v1",
    operation: {
      version: 1,
      operation: "extend",
      target: {
        traceId: "benchmark-trace",
        headId: "benchmark-head",
        contentHash: "benchmark-content-hash",
        currentText: "Deterministic selector benchmark target.",
      },
      maxContextBytes: 256 * 1_024,
      preparedRequestMaxBytes: 512 * 1_024,
      reservedPromptBytes: 8 * 1_024,
    },
    candidates,
  };
}

export async function runSelectorRelativeCaseV1(
  size: number,
  reverse = false,
): Promise<SelectorRelativeResultV1> {
  const result = await selectTraceContextV1(buildSelectorRelativeInputV1(size, reverse));
  if (!result.ok) {
    throw new Error(`selector relative case ${size} failed: ${result.error.code}`);
  }
  return Object.freeze({
    version: 1,
    size,
    projectedInputBytes: result.manifest.input.projectedInputBytes,
    renderedContextBytes: new TextEncoder().encode(result.renderedContext).length,
    selectedCount: result.manifest.budget.selectedCount,
    budgetExcludedCount: result.manifest.exclusionSummary.countsByReason.budgetExceeded,
    selectionComplete: result.manifest.completeness.selectionComplete,
    frozenInputsSha256: result.manifest.hashes.frozenInputsSha256,
    renderedContextSha256: result.manifest.hashes.renderedContextSha256,
    manifestSha256: result.manifestSha256,
  });
}

async function main(): Promise<void> {
  const cases = [];
  for (const size of SELECTOR_RELATIVE_SIZES_V1) {
    cases.push(await runSelectorRelativeCaseV1(size));
  }
  process.stdout.write(`${JSON.stringify({
    version: 1,
    contract: "selector-relative-structure-v1",
    note: "Deterministic structural coverage only; no wall-clock product latency claim.",
    cases,
  }, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}

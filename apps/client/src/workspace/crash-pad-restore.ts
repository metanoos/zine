import type { LocalFile } from "./local-store.js";
import {
  flattenRuns,
  keditLogFromArray,
  recoverStepKEdits,
  type FileState,
  type Run,
} from "./workspace-core.js";

/** Reconstruct an editor FileState by overlaying one crash-pad buffer on the
 * stepped workspace snapshot. */
export function restoreCrashPadFile(
  existing: FileState | undefined,
  file: LocalFile,
  fallbackVoice: string,
  recoveryVoice: string,
): FileState {
  const runs: Run[] =
    file.runs && file.runs.length > 0 && flattenRuns(file.runs) === file.content
      ? file.runs
      : file.content.length === 0
        ? []
        : [{ voice: file.voicePubkey ?? fallbackVoice, text: file.content }];
  const recoveredKEdits = recoverStepKEdits(
    existing ? flattenRuns(existing.runs) : "",
    file.content,
    file.kedits,
    // An unusable or missing crash journal is a machine reconciliation, not a
    // fresh AUTHOR or MODEL transaction. Its atomic recovery KEdit therefore
    // uses the dedicated per-machine reconciler identity; run attribution is
    // preserved separately and must never be guessed from the first run.
    recoveryVoice,
    file.updatedAt,
  ).kedits;
  return {
    kind: existing?.kind,
    runs,
    // The scanned signed head is workspace truth. Pad bytes may be newer, but
    // its identity can be stale in the crash window after a Step persisted and
    // before the pad was cleared/rebased.
    nodeId: existing?.nodeId || file.nodeId || "",
    ...(existing?.traceId ?? file.traceId
      ? { traceId: existing?.traceId ?? file.traceId }
      : {}),
    updatedAt: file.updatedAt,
    tags: file.tags ?? existing?.tags ?? [],
    citationIds: file.citationIds ?? existing?.citationIds,
    ...(recoveredKEdits.length > 0 ? { kedits: keditLogFromArray(recoveredKEdits) } : {}),
    ...(existing?.eventMeta ? { eventMeta: existing.eventMeta } : {}),
  };
}

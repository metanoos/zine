import type { LocalFile } from "./local-store.js";
import {
  flattenRuns,
  editorTransactionLogFromArray,
  recoverStepEditorTransactions,
  type FileState,
  type Run,
} from "./workspace-core.js";

export interface CrashPadRestoreOptions {
  /** Exact snapshot carried by the signed head selected for this file. The
   * local primary record may already contain a failed/staged write, so its body
   * is not always the EditorTransaction journal's real pre-state. */
  steppedSnapshot?: string;
}

/** Reconstruct an editor FileState by overlaying one crash-pad buffer on the
 * stepped workspace snapshot. */
export function restoreCrashPadFile(
  existing: FileState | undefined,
  file: LocalFile,
  fallbackVoice: string,
  recoveryVoice: string,
  options: CrashPadRestoreOptions = {},
): FileState {
  const runs: Run[] =
    file.runs && file.runs.length > 0 && flattenRuns(file.runs) === file.content
      ? file.runs
      : file.content.length === 0
        ? []
        : [{ voice: file.voicePubkey ?? fallbackVoice, text: file.content }];
  const recoveredEditorTransactions = recoverStepEditorTransactions(
    options.steppedSnapshot ?? (existing ? flattenRuns(existing.runs) : ""),
    file.content,
    file.editorTransactions,
    // An unusable or missing crash journal is a machine reconciliation, not a
    // fresh AUTHOR or MODEL transaction. Its atomic recovery EditorTransaction therefore
    // uses the dedicated per-machine reconciler identity; run attribution is
    // preserved separately and must never be guessed from the first run.
    recoveryVoice,
    file.updatedAt,
  ).editorTransactions;
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
    ...(recoveredEditorTransactions.length > 0 ? { editorTransactions: editorTransactionLogFromArray(recoveredEditorTransactions) } : {}),
    ...(existing?.eventMeta ? { eventMeta: existing.eventMeta } : {}),
  };
}

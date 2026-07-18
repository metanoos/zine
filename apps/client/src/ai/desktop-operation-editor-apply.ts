import { contentFingerprint } from "./context-snapshot.js";
import type { AcceptedArtifactIntentV1 } from "./desktop-operation-envelope.js";
import {
  buildAcceptedExtendChanges,
  type EditorTextChange,
  type PreparedTraceAuthoringV1,
} from "./trace-authoring-adapter.js";

export interface PreparedDesktopExtendApplyV1 {
  changes: readonly EditorTextChange[];
  resultingText: string;
  resultingContentHash: string;
}

/** Pure editor mutation plan for one already-persisted Extend accept intent. */
export function prepareDesktopExtendApplyV1(
  targetText: string,
  intent: AcceptedArtifactIntentV1,
  responseText: string,
  authoring: PreparedTraceAuthoringV1,
): PreparedDesktopExtendApplyV1 {
  if (contentFingerprint(targetText) !== intent.targetRevision.contentHash) {
    throw new Error("Desktop Extend target content no longer matches its accepted intent");
  }
  const { fromUtf16, toUtf16 } = intent.applyRange;
  if (
    !Number.isSafeInteger(fromUtf16)
    || !Number.isSafeInteger(toUtf16)
    || fromUtf16 < 0
    || toUtf16 !== fromUtf16
    || toUtf16 > targetText.length
  ) {
    throw new Error("Desktop Extend accepted intent has an invalid insertion range");
  }
  const changes = buildAcceptedExtendChanges(authoring, targetText, fromUtf16, responseText);
  let resultingText = targetText;
  for (const change of [...changes].sort((left, right) => right.from - left.from)) {
    resultingText = resultingText.slice(0, change.from)
      + change.insert
      + resultingText.slice(change.to ?? change.from);
  }
  return Object.freeze({
    changes: Object.freeze(changes.map((change) => Object.freeze({ ...change }))),
    resultingText,
    resultingContentHash: contentFingerprint(resultingText),
  });
}

import { contentFingerprint } from "./context-snapshot.js";
import type { AcceptedArtifactIntentV1 } from "./desktop-operation-envelope.js";

export interface PreparedDesktopExtendApplyV1 {
  change: { from: number; to: number; insert: string };
  resultingText: string;
  resultingContentHash: string;
}

/** Pure editor mutation plan for one already-persisted Extend accept intent. */
export function prepareDesktopExtendApplyV1(
  targetText: string,
  intent: AcceptedArtifactIntentV1,
  responseText: string,
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
  const previous = fromUtf16 > 0 ? targetText.slice(fromUtf16 - 1, fromUtf16) : "";
  const insert = `${fromUtf16 > 0 && previous !== "\n" ? "\n" : ""}${responseText}`;
  const resultingText = targetText.slice(0, fromUtf16) + insert + targetText.slice(toUtf16);
  return Object.freeze({
    change: Object.freeze({ from: fromUtf16, to: toUtf16, insert }),
    resultingText,
    resultingContentHash: contentFingerprint(resultingText),
  });
}

export const STREAMING_BOTTOM_THRESHOLD = 24;

export type StreamingScrollAnchor =
  | { kind: "bottom" }
  | { kind: "fixed"; scrollTop: number };

export type ScrollMetrics = {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
};

/** Capture the reader's intent before a streamed append changes layout. */
export function captureStreamingScrollAnchor(
  metrics: ScrollMetrics,
  bottomThreshold = STREAMING_BOTTOM_THRESHOLD,
): StreamingScrollAnchor {
  const maxScrollTop = Math.max(0, metrics.scrollHeight - metrics.clientHeight);
  return metrics.scrollTop >= maxScrollTop - bottomThreshold
    ? { kind: "bottom" }
    : { kind: "fixed", scrollTop: metrics.scrollTop };
}

/** Resolve the exact scrollTop to restore after the streamed append is laid out. */
export function restoreStreamingScrollTop(
  anchor: StreamingScrollAnchor,
  metrics: Pick<ScrollMetrics, "scrollHeight" | "clientHeight">,
): number {
  if (anchor.kind === "fixed") return anchor.scrollTop;
  return Math.max(0, metrics.scrollHeight - metrics.clientHeight);
}

/**
 * A dependency-free SVG activity chart for the Times view. Originally a single
 * gold area+line (one total per bucket); now a *stacked* area where each band is
 * one trace and a band's thickness in a time slice = how many social or
 * lineage relations targeted that trace. The same layers can render as
 * independent lines for comparison or as contiguous stacked area for total
 * volume plus composition.
 *
 * Buckets + layers are computed by the caller (TimesView) so this component is
 * purely presentational — give it buckets, layers, and a window and it draws.
 *
 * No charting library: one `<path>` per layer. The common case (n > 1 buckets)
 * connects bucket centers with a stacked-area polyline — the standard shape, and
 * what the chart was before. The degenerate single-bucket case (e.g. a fresh
 * relay under the weekly "all" bucket) would collapse to a zero-width sliver,
 * so it falls back to centered stacked bars. Native `<title>` elements give
 * hover tooltips for free (layer totals + per-bucket counts), matching the
 * no-JS-hover posture of the rest of the app. Sizing is a fixed viewBox +
 * `vector-effect: non-scaling-stroke` so fills stretch to the card while the
 * hairline separators stay crisp.
 */

export type WindowKey = "24h" | "7d" | "30d" | "all";

/** One time-bucket. Layer `values` are indexed parallel to the buckets array.
 *  - `startSec` / `endSec` — UNIX-second bounds of the bucket.
 *  - `label` — short x-axis tick label (e.g. "Mon", "14:00"). */
export interface StackBucket {
  startSec: number;
  endSec: number;
  label: string;
}

/** One stacked band: a single trace's inbound-usage counts over the
 *  window. `color` is a CSS color/var set via inline `fill` (presentation
 *  attributes don't resolve var() reliably across browsers). */
export interface StackLayer {
  id: string;
  name: string;
  color: string;
  values: number[];
}

const VB_W = 800;
const VB_H = 180;
const PAD_L = 8;
const PAD_R = 8;
const PAD_T = 12;
const PAD_B = 22; // room for x labels

const PLOT_W = VB_W - PAD_L - PAD_R;
const PLOT_H = VB_H - PAD_T - PAD_B;
const BASE_Y = VB_H - PAD_B;

export function TimesChart({
  buckets,
  layers,
  window,
  mode = "stacked",
}: {
  buckets: StackBucket[];
  layers: StackLayer[];
  window: WindowKey;
  mode?: "lines" | "stacked";
}) {
  const n = buckets.length;
  const hasData = layers.length > 0 && layers.some((l) => l.values.some((v) => v > 0));

  // Empty state: draw the baseline + axes so the card doesn't collapse.
  if (n === 0 || !hasData) {
    return (
      <svg
        className="times-chart-svg"
        viewBox={`0 0 ${VB_W} ${VB_H}`}
        role="img"
        aria-label="No trace usage in this window"
      >
        <line x1={PAD_L} y1={BASE_Y} x2={VB_W - PAD_R} y2={BASE_Y} className="times-chart-baseline" />
        <text x={VB_W / 2} y={VB_H / 2} className="times-chart-empty">
          no trace usage in this window
        </text>
      </svg>
    );
  }

  // Per-bucket stack sum (the y extent of the whole stack at each slice) and the
  // tallest stack — the scale the bands are measured against.
  const stackSums = new Array(n).fill(0);
  for (const layer of layers) {
    for (let i = 0; i < n; i++) stackSums[i] += layer.values[i] ?? 0;
  }
  const maxSum = Math.max(1, ...stackSums);
  const maxLine = Math.max(1, ...layers.flatMap((layer) => layer.values));
  const maxY = mode === "lines" ? maxLine : maxSum;
  const yFor = (value: number) => BASE_Y - (value / maxY) * PLOT_H;

  // Cumulative bottoms/tops per layer per bucket: bottom of layer L = top of
  // L-1. Built bottom-up so the first layer sits on the baseline.
  const tops: number[][] = layers.map(() => new Array(n).fill(0));
  const bots: number[][] = layers.map(() => new Array(n).fill(0));
  {
    const running = new Array(n).fill(0);
    for (let l = 0; l < layers.length; l++) {
      for (let i = 0; i < n; i++) {
        bots[l][i] = running[i];
        tops[l][i] = running[i] + (layers[l].values[i] ?? 0);
        running[i] = tops[l][i];
      }
    }
  }

  // Center-based x for the polyline case (matches the pre-stack chart).
  const xAt = (i: number) => (n === 1 ? VB_W / 2 : PAD_L + (i / (n - 1)) * PLOT_W);

  // Single-bucket window: a stacked area would be a zero-width sliver, so draw
  // centered bars instead. Each layer is one rect spanning most of the slot.
  if (n === 1) {
    const barW = PLOT_W * 0.5;
    const bx = VB_W / 2 - barW / 2;
    return (
      <svg
        className="times-chart-svg"
        viewBox={`0 0 ${VB_W} ${VB_H}`}
        role="img"
        aria-label={`Usage this bucket: ${stackSums[0]} relations across ${layers.length} trace${layers.length === 1 ? "" : "s"}`}
      >
        <line x1={PAD_L} y1={PAD_T} x2={VB_W - PAD_R} y2={PAD_T} className="times-chart-grid" />
        <line x1={PAD_L} y1={BASE_Y} x2={VB_W - PAD_R} y2={BASE_Y} className="times-chart-baseline" />
        <text x={PAD_L} y={PAD_T + 2} className="times-chart-ymax">
          {maxY}
        </text>
        {mode === "lines" ? layers.map((layer) => (
          <circle
            key={layer.id}
            cx={VB_W / 2}
            cy={yFor(layer.values[0] ?? 0)}
            r={4}
            fill={layer.color}
            stroke="var(--surface-raised)"
            strokeWidth={1}
          >
            <title>{`${layer.name}: ${layer.values[0] ?? 0} use${layer.values[0] === 1 ? "" : "s"}`}</title>
          </circle>
        )) : layers.map((layer, l) => (
          <rect
            key={layer.id}
            x={bx}
            y={yFor(tops[l][0])}
            width={barW}
            height={Math.max(0, yFor(bots[l][0]) - yFor(tops[l][0]))}
            fill={layer.color}
            stroke="var(--surface-raised)"
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          >
            <title>{`${layer.name}: ${layers[l].values[0]} use${layers[l].values[0] === 1 ? "" : "s"}`}</title>
          </rect>
        ))}
      </svg>
    );
  }

  // Stacked-area polyline: top edge across centers, then bottom edge back.
  const layerPath = (l: number) => {
    const fwd: string[] = [];
    for (let i = 0; i < n; i++) fwd.push(`${i === 0 ? "M" : "L"}${xAt(i).toFixed(2)},${yFor(tops[l][i]).toFixed(2)}`);
    const back: string[] = [];
    for (let i = n - 1; i >= 0; i--) back.push(`L${xAt(i).toFixed(2)},${yFor(bots[l][i]).toFixed(2)}`);
    return `${fwd.join(" ")} ${back.join(" ")} Z`;
  };
  const linePath = (l: number) => layers[l].values
    .map((value, i) => `${i === 0 ? "M" : "L"}${xAt(i).toFixed(2)},${yFor(value ?? 0).toFixed(2)}`)
    .join(" ");

  // Per-bucket hit columns carry the tooltip for the whole stack at that slice.
  const colW = PLOT_W / n;
  const bucketRange = (i: number) => {
    const fmt =
      window === "24h"
        ? new Date(buckets[i].startSec * 1000).toLocaleString(undefined, { hour: "numeric", minute: "2-digit" })
        : new Date(buckets[i].startSec * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" });
    const total = stackSums[i];
    return `${fmt} · ${total} relation${total === 1 ? "" : "s"}`;
  };

  // Pick ~5 x ticks spread across the series, always including the last.
  const tickStep = Math.max(1, Math.ceil(n / 5));
  const ticks: number[] = [];
  for (let i = 0; i < n; i += tickStep) ticks.push(i);
  if (ticks[ticks.length - 1] !== n - 1) ticks.push(n - 1);

  const layerTotal = (l: number) => layers[l].values.reduce((s, v) => s + v, 0);
  const grandTotal = stackSums.reduce((s, v) => s + v, 0);

  return (
    <svg
      className="times-chart-svg"
      viewBox={`0 0 ${VB_W} ${VB_H}`}
      role="img"
      aria-label={`Trace usage over ${window}: ${grandTotal} relations across ${layers.length} trace${layers.length === 1 ? "" : "s"}`}
    >
      {/* y max label + faint top rule */}
      <text x={PAD_L} y={PAD_T + 2} className="times-chart-ymax">
        {maxY}
      </text>
      <line x1={PAD_L} y1={PAD_T} x2={VB_W - PAD_R} y2={PAD_T} className="times-chart-grid" />
      <line x1={PAD_L} y1={BASE_Y} x2={VB_W - PAD_R} y2={BASE_Y} className="times-chart-baseline" />

      {/* The same values render as independent lines or cumulative bands. */}
      {layers.map((layer, l) => mode === "lines" ? (
        <path
          key={layer.id}
          d={linePath(l)}
          fill="none"
          stroke={layer.color}
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        >
          <title>{`${layer.name}: ${layerTotal(l)} use${layerTotal(l) === 1 ? "" : "s"} this window`}</title>
        </path>
      ) : (
        <path
          key={layer.id}
          d={layerPath(l)}
          className="times-chart-layer"
          fill={layer.color}
          stroke="var(--surface-raised)"
          strokeWidth={0.75}
          vectorEffect="non-scaling-stroke"
        >
          <title>{`${layer.name}: ${layerTotal(l)} use${layerTotal(l) === 1 ? "" : "s"} this window`}</title>
        </path>
      ))}

      {/* per-bucket hit columns carry the bucket tooltip (whole-stack count) */}
      {Array.from({ length: n }, (_, i) => (
        <rect
          key={i}
          x={Math.max(PAD_L, xAt(i) - colW / 2)}
          y={PAD_T}
          width={Math.max(2, colW)}
          height={PLOT_H}
          fill="transparent"
        >
          <title>{bucketRange(i)}</title>
        </rect>
      ))}

      {/* x ticks */}
      {ticks.map((i) => (
        <text
          key={i}
          x={xAt(i)}
          y={BASE_Y + 14}
          className="times-chart-tick"
          textAnchor={i === 0 ? "start" : i === n - 1 ? "end" : "middle"}
        >
          {buckets[i].label}
        </text>
      ))}
    </svg>
  );
}

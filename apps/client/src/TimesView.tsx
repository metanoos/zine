/**
 * The Times view — zines on this relay, ranked by metric per unit time.
 *
 * The ranked unit is the ZINE (folder), not the tag or the file name. For the
 * active time window (24h / 7d / 30d / all), every FileTraceNode the read
 * relays hold is grouped by its source folder and each zine is ranked by the
 * selected metric — activity (seals), citations, recency, or voices (distinct
 * authors, a liveness signal). A seals-per-bucket chart above the leaderboard
 * stays as a relay-pulse overview; it's zine-agnostic by construction.
 *
 * This reframes the old Times, which ranked tags and file basenames across
 * events. The tag-cooccurrence and per-file-names columns are gone — they were
 * about tags and files, not zines. What remains is a leaderboard: which zines
 * moved in the window, and by how much.
 *
 * Fetching is live and read-only: every window or refresh hits the relay via
 * `fetchRelayActivity` (no client cache). The refreshKey pattern mirrors
 * Stacks.
 *
 * Metrics map to the protocol (trace-provenance.md):
 *   - activity   — #t=[tag] saves (seal events) in window (default). Formerly
 *     the tag-activity metric; now the zine's seal count.
 *   - citations  — sum of q-tag counts (deliberate reuse) on the zine's events.
 *   - recency    — rank by the zine's last-seen seal time.
 *   - voices     — distinct signing pubkeys (authors) on the zine's events.
 *
 * Above the leaderboard, the stacked chart plots **minted traces being cited
 * over time**: each band is one minted span, and a band's thickness in a time
 * slice = how many events sealed in that slice cited that span (its `q` tags).
 * Only minted spans (`resolveNodeName` → `kind: "span"`) are plotted, capped at
 * the top 6 by inbound activity plus an "other" band — the long tail of
 * sparsely-cited spans is rolled up so the stack stays readable and name
 * resolution stays bounded.
 */

import { useEffect, useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import type { Event } from "nostr-tools";
import { eventMeta, fetchRelayActivity, fetchFolderDisplayName, resolveNodeName } from "./provenance.js";
import { identityColors, identityForPubkey, identityFromPubkey, type KeyIdentity } from "./keys-store.js";
import { TimesChart, type StackBucket, type StackLayer, type WindowKey } from "./TimesChart.js";

/** How a band's color is derived.
 *  - "trace" — hash the band's nodeId. A minted trace's nodeId is the sha256 of
 *    its canonical event (content included), so the band owns a stable hue tied
 *    to the trace itself: same span, same color on every reload/device. This is
 *    the trace's *identity* color.
 *  - "voice" — the minter's *published* voice identity (kind-34292), so spans
 *    from the same author share the author's chosen colors and the stack reads
 *    as provenance — which voices minted what. Falls back to the pubkey hash
 *    when no declaration is on the relays (identityForPubkey handles that). */
type ColorMode = "trace" | "voice";

/** Band color under the active mode. "other" (null id) is always neutral
 *  --rule-strong regardless of mode, so the rollup reads as miscellany. In
 *  "trace" mode the nodeId is hashed directly. In "voice" mode the caller passes
 *  the minter's resolved KeyIdentity (published declaration or hash fallback);
 *  while it's still resolving, the nodeId hash is used so the band isn't
 *  uncolored. */
function colorForNode(
  id: string | null,
  mode: ColorMode,
  minterIdentity: KeyIdentity | undefined,
): string {
  if (id === null) return "var(--rule-strong)";
  const identity = mode === "voice" ? minterIdentity ?? identityFromPubkey(id) : identityFromPubkey(id);
  return identityColors(identity, 1).fg;
}
/** Max bands plotted before rolling the rest into "other". */
const MAX_LAYERS = 6;
/** Cap on resolveNodeName calls per window — the long tail barely registers, so
 *  we only ever resolve the busiest cited nodes (kept over files too, since we
 *  need kind to tell span from file, and now the minter pubkey for voice mode). */
const RESOLVE_CAP = 20;

type Metric = "activity" | "citations" | "recency" | "voices";

/** One zine's rolled-up activity in the window. Built by `aggregate` and ranked
 *  by the selected metric. */
interface ZineStat {
  folderId: string;
  /** Resolved display name (manifest first-member filename, else id prefix). */
  name: string;
  /** Seal events in the window carrying this zine — the "activity" metric. */
  seals: number;
  /** Sum of q-tag counts on the zine's events in window. */
  citations: number;
  /** Distinct signing pubkeys — the "voices" liveness metric. */
  voices: Set<string>;
  /** Most recent sealedAt (ms) among the zine's events in window. */
  lastSeenMs: number;
}

interface Aggregation {
  zines: ZineStat[];
  /** The time buckets the chart stacks against (label-only + bounds). */
  buckets: StackBucket[];
  /** Per cited nodeId, a count array indexed parallel to `buckets`. Built from
   *  every in-window event's `q` targets — inbound citation volume per trace. */
  perNode: Map<string, number[]>;
}

const WINDOW_SECS: Record<Exclude<WindowKey, "all">, number> = {
  "24h": 24 * 3600,
  "7d": 7 * 24 * 3600,
  "30d": 30 * 24 * 3600,
};

/** Bucket size for a given window: hourly for 24h, daily for 7d/30d, weekly
 *  for all-time. Keeps the bucket count bounded (~24 / 7 / 30 / N-weeks). */
function bucketSecs(window: WindowKey): number {
  if (window === "24h") return 3600;
  if (window === "7d" || window === "30d") return 24 * 3600;
  return 7 * 24 * 3600; // all → weekly
}

function bucketLabel(startSec: number, window: WindowKey): string {
  const d = new Date(startSec * 1000);
  if (window === "24h") return d.toLocaleString(undefined, { hour: "numeric" });
  if (window === "all") return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return d.toLocaleDateString(undefined, { weekday: "short" });
}

/** Pure aggregation: events → per-zine stats + the time buckets + per-node
 *  inbound-citation counts per bucket. Kept out of the component so the metric
 *  re-rank is a cheap sort, not a re-scan. Names are resolved lazily in the
 *  effect (relay round-trip); here the name is the folderId prefix until then. */
function aggregate(events: Event[], window: WindowKey): Aggregation {
  const byFolder = new Map<string, ZineStat>();
  const bs = bucketSecs(window);
  const now = Math.floor(Date.now() / 1000);
  const span = window === "all" ? Infinity : WINDOW_SECS[window];
  const earliest = span === Infinity ? 0 : now - span;

  for (const event of events) {
    const meta = eventMeta(event);
    const t = meta.createdAtSec;
    if (t < earliest) continue; // relay may return slightly out-of-window
    if (!meta.folderId) continue; // foreign/malformed — no zine to attribute to
    let stat = byFolder.get(meta.folderId);
    if (!stat) {
      stat = {
        folderId: meta.folderId,
        name: meta.folderId.slice(0, 8),
        seals: 0,
        citations: 0,
        voices: new Set(),
        lastSeenMs: 0,
      };
      byFolder.set(meta.folderId, stat);
    }
    stat.seals++;
    stat.citations += meta.citationCount;
    stat.voices.add(event.pubkey);
    if (meta.sealedAtMs > stat.lastSeenMs) stat.lastSeenMs = meta.sealedAtMs;
  }

  // Build the time buckets: one per bucketSecs span covering [earliest, now].
  const buckets: StackBucket[] = [];
  if (span !== Infinity) {
    const firstBucketStart = Math.floor(earliest / bs) * bs;
    for (let s = firstBucketStart; s < now; s += bs) {
      buckets.push({ startSec: s, endSec: s + bs, label: bucketLabel(s, window) });
    }
  } else if (events.length > 0) {
    // all-time: span from the earliest event to now, weekly buckets
    const minT = Math.min(...events.map((e) => eventMeta(e).createdAtSec), now);
    const firstBucketStart = Math.floor(minT / bs) * bs;
    for (let s = firstBucketStart; s < now; s += bs) {
      buckets.push({ startSec: s, endSec: s + bs, label: bucketLabel(s, window) });
    }
  }
  const bucketIdx = (t: number) => {
    if (buckets.length === 0) return -1;
    const i = Math.floor((t - buckets[0].startSec) / bs);
    return i >= 0 && i < buckets.length ? i : -1;
  };

  // Per-node inbound citations: for each in-window event, every `q` target it
  // cites increments that target's count in the event's bucket. A node cited
  // multiple times by one event still counts once per cite (citationCount is
  // the q-tag frequency; here we walk the raw targets).
  const perNode = new Map<string, number[]>();
  const ensure = (id: string) => {
    let arr = perNode.get(id);
    if (!arr) {
      arr = new Array(buckets.length).fill(0);
      perNode.set(id, arr);
    }
    return arr;
  };
  for (const event of events) {
    const meta = eventMeta(event);
    const i = bucketIdx(meta.createdAtSec);
    if (i < 0) continue;
    for (const target of meta.citationTargets) ensure(target)[i]++;
  }

  return { zines: [...byFolder.values()], buckets, perNode };
}

function rank(zines: ZineStat[], metric: Metric): ZineStat[] {
  const sorted = [...zines];
  if (metric === "citations") {
    sorted.sort((a, b) => b.citations - a.citations || b.seals - a.seals);
  } else if (metric === "recency") {
    sorted.sort((a, b) => b.lastSeenMs - a.lastSeenMs);
  } else if (metric === "voices") {
    sorted.sort((a, b) => b.voices.size - a.voices.size || b.seals - a.seals);
  } else {
    sorted.sort((a, b) => b.seals - a.seals || b.lastSeenMs - a.lastSeenMs); // activity
  }
  return sorted;
}

function timeAgo(ms: number): string {
  if (!ms) return "—";
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** Recency bar width: newest zine (== newestMs) = 100%, a zine at the window's
 *  start edge = ~8%. For the "all" window the edge is the oldest zine's time,
 *  so the bar spans the observed range. Linear, clamped. */
function barPctForRecency(seenMs: number, edgeMs: number, newestMs: number): number {
  if (newestMs <= edgeMs) return 100; // single zine or all-same-time
  const frac = (seenMs - edgeMs) / (newestMs - edgeMs);
  return Math.max(8, Math.min(100, frac * 100));
}

export function TimesView() {
  const [window, setWindow] = useState<WindowKey>("7d");
  const [metric, setMetric] = useState<Metric>("activity");
  const [refreshKey, setRefreshKey] = useState(0);
  const [events, setEvents] = useState<Event[]>([]);
  const [status, setStatus] = useState<{ state: "idle" | "loading" | "ready" | "error"; msg?: string }>(
    { state: "idle" },
  );
  // Names are resolved after aggregation, so the table doesn't wait on N
  // relay round-trips before rendering. Patched in as they resolve.
  const [names, setNames] = useState<Map<string, string>>(new Map());
  /** Chart band color mode: by trace identity (nodeId hash) or by voice (the
   *  span's minter pubkey). Toggled in the toolbar; the layers rebuild on flip. */
  const [colorMode, setColorMode] = useState<ColorMode>("trace");

  useEffect(() => {
    let cancelled = false;
    setStatus({ state: "loading" });
    const since = window === "all" ? undefined : Math.floor(Date.now() / 1000) - WINDOW_SECS[window];
    fetchRelayActivity({ since })
      .then((rows) => {
        if (cancelled) return;
        setEvents(rows);
        setStatus({ state: "ready" });
      })
      .catch((e) => {
        if (cancelled) return;
        setStatus({ state: "error", msg: e instanceof Error ? e.message : String(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [window, refreshKey]);

  const agg = useMemo(() => aggregate(events, window), [events, window]);

  // Resolve display names for the zines in view (bounded by the window's zine
  // count). Best-effort: a failed fetch leaves the id-prefix placeholder.
  useEffect(() => {
    let cancelled = false;
    const folderIds = agg.zines.map((z) => z.folderId);
    if (folderIds.length === 0) return;
    Promise.all(
      folderIds.map((id) => fetchFolderDisplayName(id).catch(() => id.slice(0, 8))),
    ).then((resolved) => {
      if (cancelled) return;
      const next = new Map<string, string>();
      folderIds.forEach((id, i) => next.set(id, resolved[i]));
      setNames(next);
    });
    return () => {
      cancelled = true;
    };
  }, [agg.zines]);

  const ranked = useMemo(() => rank(agg.zines, metric), [agg.zines, metric]);
  // Bar scale tracks the displayed metric.
  const metricValue = (z: ZineStat) =>
    metric === "citations"
      ? z.citations
      : metric === "voices"
        ? z.voices.size
        : metric === "recency"
          ? z.lastSeenMs
          : z.seals;
  // For recency, "max" is the latest lastSeenMs; bar width is recency rank.
  const maxCount = ranked.reduce((m, z) => Math.max(m, metricValue(z)), 0);
  // Recency bar edge: the window's start (bounded windows), or the oldest zine
  // in view (the "all" window). Falls back to newestMs so the bar is full when
  // there's nothing to span.
  const windowEdgeMs = useMemo(() => {
    if (window === "all" || ranked.length === 0) {
      return ranked.reduce((m, z) => Math.min(m, z.lastSeenMs), maxCount);
    }
    return Date.now() - WINDOW_SECS[window] * 1000;
  }, [ranked, maxCount, window]);
  const totalEvents = agg.zines.reduce((s, z) => s + z.seals, 0);
  // Total inbound citations across all cited nodes this window — the stack sum.
  const totalCites = useMemo(
    () => Array.from(agg.perNode.values()).reduce((s, arr) => s + arr.reduce((a, b) => a + b, 0), 0),
    [agg.perNode],
  );

  // Build the chart layers from per-node inbound citation counts. Only minted
  // spans are plotted; we resolve the top RESOLVE_CAP busiest cited node ids
  // (kept over files too — kind is the only way to tell span from file), keep
  // the spans among them, plot the top MAX_LAYERS, and roll the rest into one
  // "other" band. Names/kind start unresolved (placeholder layers render the
  // top node ids by raw count) and patch in as the cached resolveNodeName calls
  // settle, mirroring the zine-name pattern.
  const [layers, setLayers] = useState<StackLayer[]>([]);
  useEffect(() => {
    let cancelled = false;
    // Rank all cited node ids by total inbound count; resolve only the busiest.
    const ranked = Array.from(agg.perNode.entries())
      .map(([id, arr]) => [id, arr.reduce((a, b) => a + b, 0)] as const)
      .filter(([, c]) => c > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, RESOLVE_CAP);
    if (ranked.length === 0) {
      setLayers([]);
      return;
    }
    const allIds = ranked.map(([id]) => id);
    const build = (
      names: Map<string, string>,
      kinds: Map<string, "file" | "span">,
      minterIdentities: Map<string, KeyIdentity>,
    ): StackLayer[] => {
      // Kinds unknown yet (first pass) → treat every id as a span so the
      // placeholder stack renders the top ids by raw count; it refines to
      // spans-only once kinds resolve.
      const spans = allIds.filter((id) => (kinds.get(id) ?? "span") === "span");
      const top = spans.slice(0, MAX_LAYERS).map((id) => ({
        id,
        name: names.get(id) ?? id.slice(0, 8),
        color: colorForNode(id, colorMode, minterIdentities.get(id)),
        values: agg.perNode.get(id) ?? [],
      }));
      const restIds = spans.slice(MAX_LAYERS);
      if (restIds.length > 0) {
        const merged = new Array(agg.buckets.length).fill(0);
        for (const id of restIds) {
          const arr = agg.perNode.get(id);
          if (arr) for (let i = 0; i < merged.length; i++) merged[i] += arr[i] ?? 0;
        }
        top.push({
          id: "__other",
          name: `other · ${restIds.length}`,
          color: colorForNode(null, colorMode, undefined),
          values: merged,
        });
      }
      return top;
    };
    const empty = new Map();
    setLayers(build(empty, empty, empty));
    Promise.all(allIds.map(async (id) => [id, await resolveNodeName(id)] as const)).then(async (resolved) => {
      if (cancelled) return;
      const names = new Map<string, string>();
      const kinds = new Map<string, "file" | "span">();
      const minterPubkeys = new Map<string, string>(); // nodeId → minter pubkey
      for (const [id, chip] of resolved) {
        names.set(id, chip?.name ?? id.slice(0, 8));
        if (chip?.kind) kinds.set(id, chip.kind);
        if (chip?.pubkey) minterPubkeys.set(id, chip.pubkey);
      }
      // Voice mode needs each minter's *published* identity (kind-34292), an
      // async fetch. Trace mode skips this — it hashes the nodeId directly.
      // Build once now (names + kinds refined, voice colors still hashed), then
      // again once identities resolve so the bands adopt the authors' colors.
      setLayers(build(names, kinds, empty));
      if (colorMode !== "voice") return;
      const uniqueMinters = [...new Set(minterPubkeys.values())];
      const byPubkey = new Map<string, KeyIdentity>();
      await Promise.all(
        uniqueMinters.map(async (pk) => byPubkey.set(pk, await identityForPubkey(pk))),
      );
      if (cancelled) return;
      const minterIdentities = new Map<string, KeyIdentity>();
      for (const [id, pk] of minterPubkeys) {
        const ident = byPubkey.get(pk);
        if (ident) minterIdentities.set(id, ident);
      }
      setLayers(build(names, kinds, minterIdentities));
    });
    return () => {
      cancelled = true;
    };
  }, [agg.perNode, agg.buckets.length, colorMode]);

  if (status.state === "ready" && totalEvents === 0 && agg.zines.length === 0) {
    return (
      <section className="view-placeholder times-view">
        <p className="view-placeholder-blurb">No events on this relay in the {window} window yet.</p>
        <p className="times-empty">
          Publish to the relay — edit a file in Press, or widen the window to "all" — and activity will appear here.
        </p>
      </section>
    );
  }

  return (
    <section className="view-placeholder times-view">
      <header className="times-header">
        <div>
          <p className="view-placeholder-blurb">
            Zines on this relay ·{" "}
            <span className="times-folder">
              {agg.zines.length} zine{agg.zines.length === 1 ? "" : "s"}
            </span>
          </p>
        </div>
        <div className="times-window-pills" role="tablist" aria-label="Time window">
          {(["24h", "7d", "30d", "all"] as WindowKey[]).map((w) => (
            <button
              key={w}
              type="button"
              role="tab"
              aria-selected={window === w}
              className={"times-pill" + (window === w ? " active" : "")}
              onClick={() => setWindow(w)}
            >
              {w}
            </button>
          ))}
        </div>
      </header>

      <div className="times-toolbar">
        <label className="times-metric">
          <span>rank by</span>
          <select value={metric} onChange={(e) => setMetric(e.target.value as Metric)}>
            <option value="activity">activity</option>
            <option value="citations">citations</option>
            <option value="recency">recency</option>
            <option value="voices">voices</option>
          </select>
        </label>
        <div className="times-color-toggle" role="group" aria-label="Chart color by">
          <span className="times-color-toggle-label">color by</span>
          <div className="times-window-pills">
            {(["trace", "voice"] as ColorMode[]).map((m) => (
              <button
                key={m}
                type="button"
                role="tab"
                aria-selected={colorMode === m}
                className={"times-pill" + (colorMode === m ? " active" : "")}
                onClick={() => setColorMode(m)}
                title={
                  m === "trace"
                    ? "Color each band by the trace's own identity (nodeId hash)"
                    : "Color each band by its minter's voice (author pubkey hash)"
                }
              >
                {m}
              </button>
            ))}
          </div>
        </div>
        <button
          type="button"
          className={"run-agent-btn times-refresh" + (status.state === "loading" ? " running" : "")}
          onClick={() => setRefreshKey((k) => k + 1)}
          disabled={status.state === "loading"}
        >
          <RefreshCw size={13} aria-hidden="true" />
          {status.state === "loading" ? "loading…" : "refresh"}
        </button>
        <span className="times-count">{totalEvents} event{totalEvents === 1 ? "" : "s"}</span>
      </div>

      {status.state === "error" && <p className="sampler-status error">{status.msg}</p>}

      <div className="times-chart">
        <p className="times-chart-caption">
          minted traces cited · {totalCites} citation{totalCites === 1 ? "" : "s"}
        </p>
        <TimesChart buckets={agg.buckets} layers={layers} window={window} />
        {layers.length > 0 && (
          <ul className="times-chart-legend legend" aria-label="Minted traces in chart">
            {layers.map((l) => (
              <li key={l.id} className="legend-item">
                <span className="swatch-dot" style={{ background: l.color }} />
                <span>{l.name}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="times-zines">
        <h2 className="times-col-title">zines · {ranked.length}</h2>
        {ranked.length === 0 ? (
          <p className="times-empty">No zines in this window.</p>
        ) : (
          <ul className="times-tag-list">
            {ranked.map((z) => {
              const val = metricValue(z);
              const pct =
                metric === "recency"
                  ? // recency bar: position within [windowEdge, newest]. Newest
                    // = full bar; a zine at the window's start edge ≈ 8%.
                    barPctForRecency(val, windowEdgeMs, maxCount)
                  : maxCount > 0
                    ? (val / maxCount) * 100
                    : 0;
              return (
                <li key={z.folderId} className="times-tag-row">
                  <span className="times-zine-name" title={z.folderId}>
                    {names.get(z.folderId) ?? z.name}
                  </span>
                  <span className="times-tag-bar" style={{ width: `${Math.min(100, pct)}%` }} />
                  <span className="times-tag-count">
                    {metric === "voices"
                      ? `${z.voices.size} voice${z.voices.size === 1 ? "" : "s"}`
                      : metric === "citations"
                        ? `${z.citations} cite${z.citations === 1 ? "" : "s"}`
                        : `${z.seals} seal${z.seals === 1 ? "" : "s"}`}
                  </span>
                  <span className="times-tag-time">{timeAgo(z.lastSeenMs)}</span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}

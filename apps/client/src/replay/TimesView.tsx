/**
 * The Times view — the temporal projection of the shared social query.
 *
 * The ranked unit is the ZINE (folder), not the tag or the file name. For the
 * active time window (24h / 7d / 30d / all), every matching FileTraceNode the
 * configured read relays hold is grouped by its source folder and ranked by the
 * selected metric — activity (steps), citations, recency, or voices (distinct
 * authors, a liveness signal). A steps-per-bucket chart above the leaderboard
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
 *   - activity   — #t=[tag] saves (step events) in window (default). Formerly
 *     the tag-activity metric; now the zine's step count.
 *   - citations  — sum of q-tag counts (deliberate reuse) on the zine's events.
 *   - recency    — rank by the zine's last-seen step time.
 *   - voices     — distinct signing pubkeys (authors) on the zine's events.
 *
 * Above the leaderboard, the chart plots **trace usage over time**. Ordinary
 * social `q` citations (explicit brackets, tacit tags, replies) and lineage
 * edges (`forked-from`, `merge-parent`, `extracted-from`) feed the same inbound
 * usage series; structural LLM-scope q-tags are excluded. Each band is one
 * target trace, capped at the top 6 plus an "other" band so the long tail stays
 * readable. The same values render as independent lines or stacked area.
 */

import { useEffect, useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import type { Event } from "nostr-tools";
import { eventMeta, fetchRelayActivity, fetchFolderDisplayName, resolveNodeName } from "../provenance/provenance.js";
import { identityColors, identityForPubkey, identityFromPubkey, type KeyIdentity } from "../identity/keys-store.js";
import { TimesChart, type StackBucket, type StackLayer, type WindowKey } from "./TimesChart.js";
import {
  DEFAULT_SOCIAL_QUERY,
  authorsForSocialScope,
  matchesSocialText,
  socialWindowSince,
  type SocialQuery,
} from "../networking/social-query.js";
import { usageTargets } from "../provenance/trace-usage.js";

/** How a band's color is derived.
 *  - "trace" — hash the band's nodeId. A minted trace's nodeId is the sha256 of
 *    its canonical event (content included), so the band owns a stable hue tied
 *    to the trace itself: same span, same color on every reload/device. This is
 *    the trace's *identity* color.
 *  - "voice" — the target trace author's *published* voice identity
 *    (kind-34292), so traces from the same author share the author's chosen
 *    colors. Falls back to the pubkey hash
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
  authorIdentity: KeyIdentity | undefined,
): string {
  if (id === null) return "var(--rule-strong)";
  const identity = mode === "voice" ? authorIdentity ?? identityFromPubkey(id) : identityFromPubkey(id);
  return identityColors(identity, 1).fg;
}
/** Max bands plotted before rolling the rest into "other". */
const MAX_LAYERS = 6;
/** Cap on resolveNodeName calls per window — the long tail barely registers, so
 *  we only ever resolve the busiest target nodes and their author pubkeys. */
const RESOLVE_CAP = 20;

type Metric = "activity" | "citations" | "recency" | "voices";

/** One zine's rolled-up activity in the window. Built by `aggregate` and ranked
 *  by the selected metric. */
interface ZineStat {
  folderId: string;
  /** Resolved display name (manifest first-member filename, else id prefix). */
  name: string;
  /** Step events in the window carrying this zine — the "activity" metric. */
  steps: number;
  /** Sum of q-tag counts on the zine's events in window. */
  citations: number;
  /** Distinct signing pubkeys — the "voices" liveness metric. */
  voices: Set<string>;
  /** Author tags observed in the window, used by the shared text query. */
  tags: Set<string>;
  /** Most recent steppedAt (ms) among the zine's events in window. */
  lastSeenMs: number;
}

interface Aggregation {
  zines: ZineStat[];
  /** The time buckets the chart stacks against (label-only + bounds). */
  buckets: StackBucket[];
  /** Per used nodeId, a count array indexed parallel to `buckets`. */
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
        steps: 0,
        citations: 0,
        voices: new Set(),
        tags: new Set(),
        lastSeenMs: 0,
      };
      byFolder.set(meta.folderId, stat);
    }
    stat.steps++;
    stat.citations += meta.citationCount;
    stat.voices.add(event.pubkey);
    for (const tag of meta.userTags) stat.tags.add(tag);
    if (meta.steppedAtMs > stat.lastSeenMs) stat.lastSeenMs = meta.steppedAtMs;
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

  // Per-node inbound usage: ordinary social q targets plus provenance lineage
  // targets. usageTargets excludes model-scope q edges and dedupes per event.
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
    for (const target of usageTargets(event)) ensure(target)[i]++;
  }

  return { zines: [...byFolder.values()], buckets, perNode };
}

function rank(zines: ZineStat[], metric: Metric): ZineStat[] {
  const sorted = [...zines];
  if (metric === "citations") {
    sorted.sort((a, b) => b.citations - a.citations || b.steps - a.steps);
  } else if (metric === "recency") {
    sorted.sort((a, b) => b.lastSeenMs - a.lastSeenMs);
  } else if (metric === "voices") {
    sorted.sort((a, b) => b.voices.size - a.voices.size || b.steps - a.steps);
  } else {
    sorted.sort((a, b) => b.steps - a.steps || b.lastSeenMs - a.lastSeenMs); // activity
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

export function TimesView({ query = DEFAULT_SOCIAL_QUERY }: { query?: SocialQuery } = {}) {
  const window: WindowKey = query.window;
  const [metric, setMetric] = useState<Metric>("activity");
  const [chartMode, setChartMode] = useState<"lines" | "stacked">("stacked");
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
    (async () => {
      const authors = await authorsForSocialScope(query.scope);
      return fetchRelayActivity({ since: socialWindowSince(query.window), authors });
    })()
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
  }, [query.scope, query.window, refreshKey]);

  const baseAgg = useMemo(() => aggregate(events, window), [events, window]);

  // Resolve display names for the zines in view (bounded by the window's zine
  // count). Best-effort: a failed fetch leaves the id-prefix placeholder.
  useEffect(() => {
    let cancelled = false;
    const folderIds = baseAgg.zines.map((z) => z.folderId);
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
  }, [baseAgg.zines]);

  // Search is the third shared bound. Resolve names against the full scoped
  // window first, then recompute both the leaderboard and chart from only the
  // matching folders so Stacks/Times/Spaces remain intersections of one query.
  const visibleFolderIds = useMemo(() => {
    const ids = new Set<string>();
    for (const zine of baseAgg.zines) {
      if (matchesSocialText(query.text, {
        folderId: zine.folderId,
        name: names.get(zine.folderId),
        tags: [...zine.tags],
      })) ids.add(zine.folderId);
    }
    return ids;
  }, [baseAgg.zines, names, query.text]);
  const visibleEvents = useMemo(
    () => events.filter((event) => {
      const folderId = eventMeta(event).folderId;
      return !!folderId && visibleFolderIds.has(folderId);
    }),
    [events, visibleFolderIds],
  );
  const agg = useMemo(() => aggregate(visibleEvents, window), [visibleEvents, window]);

  const ranked = useMemo(() => rank(agg.zines, metric), [agg.zines, metric]);
  // Bar scale tracks the displayed metric.
  const metricValue = (z: ZineStat) =>
    metric === "citations"
      ? z.citations
      : metric === "voices"
        ? z.voices.size
        : metric === "recency"
          ? z.lastSeenMs
          : z.steps;
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
  const totalEvents = agg.zines.reduce((s, z) => s + z.steps, 0);
  // Total inbound relations across all used nodes this window — the stack sum.
  const totalUses = useMemo(
    () => Array.from(agg.perNode.values()).reduce((s, arr) => s + arr.reduce((a, b) => a + b, 0), 0),
    [agg.perNode],
  );

  // Build chart layers from per-node inbound usage. Resolve names only for the
  // busiest bounded prefix, plot the top MAX_LAYERS, and roll every remaining
  // target into one "other" band without requiring a relay lookup per target.
  const [layers, setLayers] = useState<StackLayer[]>([]);
  useEffect(() => {
    let cancelled = false;
    // Rank every used target by total inbound count.
    const ranked = Array.from(agg.perNode.entries())
      .map(([id, arr]) => [id, arr.reduce((a, b) => a + b, 0)] as const)
      .filter(([, c]) => c > 0)
      .sort((a, b) => b[1] - a[1]);
    if (ranked.length === 0) {
      setLayers([]);
      return;
    }
    const allIds = ranked.map(([id]) => id);
    const resolveIds = allIds.slice(0, RESOLVE_CAP);
    const build = (
      names: Map<string, string>,
      authorIdentities: Map<string, KeyIdentity>,
    ): StackLayer[] => {
      const top = allIds.slice(0, MAX_LAYERS).map((id) => ({
        id,
        name: names.get(id) ?? id.slice(0, 8),
        color: colorForNode(id, colorMode, authorIdentities.get(id)),
        values: agg.perNode.get(id) ?? [],
      }));
      const restIds = allIds.slice(MAX_LAYERS);
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
    setLayers(build(empty, empty));
    Promise.all(resolveIds.map(async (id) => [id, await resolveNodeName(id)] as const)).then(async (resolved) => {
      if (cancelled) return;
      const names = new Map<string, string>();
      const authorPubkeys = new Map<string, string>(); // nodeId → target author
      for (const [id, chip] of resolved) {
        names.set(id, chip?.name ?? id.slice(0, 8));
        if (chip?.pubkey) authorPubkeys.set(id, chip.pubkey);
      }
      // Voice mode needs each target author's *published* identity (kind-34292), an
      // async fetch. Trace mode skips this — it hashes the nodeId directly.
      // Build once now (names refined, voice colors still hashed), then
      // again once identities resolve so the bands adopt the authors' colors.
      setLayers(build(names, empty));
      if (colorMode !== "voice") return;
      const uniqueAuthors = [...new Set(authorPubkeys.values())];
      const byPubkey = new Map<string, KeyIdentity>();
      await Promise.all(
        uniqueAuthors.map(async (pk) => byPubkey.set(pk, await identityForPubkey(pk))),
      );
      if (cancelled) return;
      const authorIdentities = new Map<string, KeyIdentity>();
      for (const [id, pk] of authorPubkeys) {
        const ident = byPubkey.get(pk);
        if (ident) authorIdentities.set(id, ident);
      }
      setLayers(build(names, authorIdentities));
    });
    return () => {
      cancelled = true;
    };
  }, [agg.perNode, agg.buckets.length, colorMode]);

  if (status.state === "ready" && totalEvents === 0 && agg.zines.length === 0) {
    return (
      <section className="view-placeholder times-view">
        <p className="view-placeholder-blurb">No reachable events match the shared {window} query yet.</p>
        <p className="times-empty">
          Send a trace, widen the window, or change the social scope; aggregates only include configured read relays.
        </p>
      </section>
    );
  }

  return (
    <section className="view-placeholder times-view">
      <header className="times-header">
        <div>
          <p className="view-placeholder-blurb">
            Zines matching the shared query ·{" "}
            <span className="times-folder">
              {agg.zines.length} zine{agg.zines.length === 1 ? "" : "s"}
            </span>
          </p>
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
                    : "Color each band by its target trace author's voice"
                }
              >
                {m}
              </button>
            ))}
          </div>
        </div>
        <div className="times-color-toggle" role="group" aria-label="Chart form">
          <span className="times-color-toggle-label">chart</span>
          <div className="times-window-pills">
            {(["lines", "stacked"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                aria-pressed={chartMode === mode}
                className={"times-pill" + (chartMode === mode ? " active" : "")}
                onClick={() => setChartMode(mode)}
              >
                {mode}
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
          trace usage · {totalUses} relation{totalUses === 1 ? "" : "s"}
        </p>
        <TimesChart buckets={agg.buckets} layers={layers} window={window} mode={chartMode} />
        {layers.length > 0 && (
          <ul className="times-chart-legend legend" aria-label="Traces in usage chart">
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
                        : `${z.steps} step${z.steps === 1 ? "" : "s"}`}
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

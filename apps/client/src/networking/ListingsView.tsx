/**
 * Stacks — the editorial presentation of zines.
 *
 * Stacks is the reader's OUTPUT: the zines this press has chosen to show,
 * arranged into named sections by the operator and their curation team. Think of
 * it as the magazine front-of-book — what's on display this week.
 *
 * Named stacks ride on the opinion layer (kind 34291) as two `d` axes:
 * `sd:<pubkey>` for a curator's section definitions and
 * `sa:<stackId>:<folderId>` for assignments. The team's defs merge (operator's
 * order/titles win); each section's zines are ordered by the team's averaged
 * rank (effectiveStackRank).
 *
 * Zines the team promoted but didn't file into any section fall into a trailing
 * "Unfiled" group, so nothing the team blessed is silently lost. Staff (operator
 * + curation team) get affordances to manage sections and reassign — readers see
 * the curated view only.
 *
 * Read-only by default: every refresh hits the relay via `fetchFolderIndex` +
 * `fetchStackDefs` + `fetchStackAssignments` (no client cache). The refreshKey
 * pattern mirrors Times. Kept under the `ListingsView` export name so App.tsx
 * imports stay valid through the redesign.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw, Plus, X, ChevronUp, ChevronDown } from "lucide-react";
import {
  effectiveStackRank,
  fetchFolderDisplayName,
  fetchFolderIndex,
  fetchStackAssignments,
  fetchStackDefs,
  publishStackAssignment,
  publishStackDefs,
  type FolderIndexEntry,
  type StackDef,
} from "../provenance/provenance.js";
import { authorVoice } from "../identity/keys-store.js";
import { canSignWithSecrets } from "../identity/secret-store.js";
import { isStaff, relayOperatorPubkeys } from "./operator-store.js";
import {
  DEFAULT_SOCIAL_QUERY,
  authorsForSocialScope,
  matchesSocialText,
  socialWindowSince,
  type SocialQuery,
} from "./social-query.js";

// --- types ---------------------------------------------------------------

/** One zine rendered as a card. Carries the relay rollup + its resolved display
 *  name. "Promoted" is derived from `entry.citationTotal` (which folds in
 *  attests — they're `q`-tag citations) rather than the removed alpha signal. */
interface ZineCard {
  entry: FolderIndexEntry;
  /** Resolved display name — manifest's first member filename, else id prefix. */
  name: string;
}

/** A zine carrying its computed section rank, used transiently while sorting. */
interface RankedZine extends ZineCard {
  rank: number;
}

/** A resolved section: its definition + the zines filed in it, ordered by the
 *  team's averaged rank. `unfiled` is the synthetic trailing section for
 *  promoted-but-unassigned zines. */
interface ResolvedStack {
  def?: StackDef;
  id: string;
  title: string;
  zines: ZineCard[];
}

type StackOrder = "curated" | "activity" | "citations" | "recency" | "voices";

// --- helpers -------------------------------------------------------------

function timeAgo(ms: number): string {
  if (!ms) return "—";
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 0 || s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

/** The team pubkey set: the active voice + the configured operators (which
 *  already includes the hosted relay's operator + curation team via operator-
 *  store). Used to scope stack-def and stack-assignment fetches to the team. */
function teamPubkeySet(): Set<string> {
  const localVoice = canSignWithSecrets()
    ? authorVoice()
    : null;
  return new Set(
    [localVoice, ...relayOperatorPubkeys()].filter(
      (k): k is string => typeof k === "string",
    ),
  );
}

/** Stable slug from a title: lowercase, non-alphanumeric → dash. Good enough for
 *  a `d`-tag id; uniqueness across a team is enforced by the operator's order
 *  winning the merge. */
function slugify(title: string): string {
  return (
    title
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "stack"
  );
}

function sortZines<T extends ZineCard>(zines: T[], order: Exclude<StackOrder, "curated">): T[] {
  return [...zines].sort((a, b) => {
    if (order === "citations") return b.entry.citationTotal - a.entry.citationTotal || b.entry.lastSeenMs - a.entry.lastSeenMs;
    if (order === "recency") return b.entry.lastSeenMs - a.entry.lastSeenMs;
    if (order === "voices") return b.entry.authorPubkeys.size - a.entry.authorPubkeys.size || b.entry.eventCount - a.entry.eventCount;
    return b.entry.eventCount - a.entry.eventCount || b.entry.lastSeenMs - a.entry.lastSeenMs;
  });
}

// --- main view -----------------------------------------------------------

export function ListingsView({
  onOpenFolder,
  query = DEFAULT_SOCIAL_QUERY,
}: {
  /** Open this folder in the Press (editor). Undefined hides the affordance. */
  onOpenFolder?: (folderId: string) => void;
  /** Bounds shared with Times and Spaces by the app shell. */
  query?: SocialQuery;
} = {}) {
  const [refreshKey, setRefreshKey] = useState(0);
  const [stacks, setStacks] = useState<ResolvedStack[]>([]);
  const [defs, setDefs] = useState<StackDef[]>([]);
  const [totalZines, setTotalZines] = useState(0);
  const [order, setOrder] = useState<StackOrder>("curated");
  const [status, setStatus] = useState<{
    state: "idle" | "loading" | "ready" | "error";
    msg?: string;
  }>({ state: "idle" });

  const staff = isStaff();
  const teamSet = useMemo(() => teamPubkeySet(), [refreshKey]);

  useEffect(() => {
    let cancelled = false;
    setStatus({ state: "loading" });
    (async () => {
      try {
        const authors = await authorsForSocialScope(query.scope);
        const [folderIndex, stackDefs, assignments] = await Promise.all([
          fetchFolderIndex({
            since: socialWindowSince(query.window),
            authors,
            limit: 2000,
          }),
          fetchStackDefs([...teamSet]),
          fetchStackAssignments([...teamSet]),
        ]);
        if (cancelled) return;
        // Names for every folder, resolved in parallel.
        const ids = [...folderIndex.keys()];
        const nameResults = await Promise.all(
          ids.map((id) => fetchFolderDisplayName(id).catch(() => shortId(id))),
        );
        const cardByFolder = new Map<string, ZineCard>();
        for (let i = 0; i < ids.length; i++) {
          const id = ids[i];
          const entry = folderIndex.get(id)!;
          const name = nameResults[i];
          if (!matchesSocialText(query.text, { folderId: id, name, tags: entry.topTags })) continue;
          cardByFolder.set(id, {
            entry,
            name,
          });
        }
        // Build each named section in def order.
        const resolved: ResolvedStack[] = stackDefs.map((def) => {
          const perFolder = assignments.get(def.id) ?? new Map();
          const zines: RankedZine[] = [];
          for (const [folderId, card] of cardByFolder) {
            if (!perFolder.has(folderId)) continue;
            const rank = effectiveStackRank(assignments, teamSet, def.id, folderId);
            zines.push({ ...card, rank });
          }
          if (order === "curated") {
            zines.sort((a, b) => a.rank - b.rank || b.entry.lastSeenMs - a.entry.lastSeenMs);
          } else {
            zines.splice(0, zines.length, ...sortZines(zines, order));
          }
          return { def, id: def.id, title: def.title, zines };
        });
        // The trailing stack completes the query result set: curation shapes
        // grouping, but never hides an otherwise matching zine.
        const assigned = new Set<string>();
        for (const perFolder of assignments.values()) {
          for (const fid of perFolder.keys()) assigned.add(fid);
        }
        const unfiled: ZineCard[] = [];
        for (const [folderId, card] of cardByFolder) {
          if (assigned.has(folderId)) continue;
          unfiled.push(card);
        }
        const fallbackOrder = order === "curated" ? "activity" : order;
        unfiled.splice(0, unfiled.length, ...sortZines(unfiled, fallbackOrder));
        if (unfiled.length > 0) {
          resolved.push({ id: "__unfiled__", title: "The rest", zines: unfiled });
        }
        if (cancelled) return;
        setStacks(resolved);
        setDefs(stackDefs);
        setTotalZines(cardByFolder.size);
        setStatus({ state: "ready" });
      } catch (e) {
        if (cancelled) return;
        setStatus({
          state: "error",
          msg: e instanceof Error ? e.message : String(e),
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshKey, teamSet, query.scope, query.text, query.window, order]);

  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  return (
    <section className="view-placeholder listings-view stacks-view">
      <header className="listings-header">
        <div>
          <p className="view-placeholder-blurb">
            The list projection of this query, grouped by curator stacks ·{" "}
            <span className="listings-count">
              {totalZines} zine{totalZines === 1 ? "" : "s"}
            </span>
          </p>
        </div>
        <label className="times-metric stacks-order">
          <span>order by</span>
          <select value={order} onChange={(event) => setOrder(event.target.value as StackOrder)}>
            <option value="curated">curated</option>
            <option value="activity">activity</option>
            <option value="citations">citations</option>
            <option value="recency">recency</option>
            <option value="voices">voices</option>
          </select>
        </label>
        <button
          type="button"
          className={"run-agent-btn listings-refresh" + (status.state === "loading" ? " running" : "")}
          onClick={refresh}
          disabled={status.state === "loading"}
        >
          <RefreshCw size={13} aria-hidden="true" />
          {status.state === "loading" ? "loading…" : "refresh"}
        </button>
      </header>

      {status.state === "error" && (
        <p className="sampler-status error">{status.msg}</p>
      )}

      {staff && <StackEditor defs={defs} onChanged={refresh} />}

      {stacks.length === 0 && status.state === "ready" && (
        <p className="times-empty listings-empty">
          {defs.length === 0
            ? "No stacks defined yet. " +
              (staff ? "Create one above." : "Check back once the curators file zines.")
            : "No zines match the shared query bounds."}
        </p>
      )}

      <div className="stacks-sections">
        {stacks.map((stack) => (
          <StackSection
            key={stack.id}
            stack={stack}
            defs={defs}
            staff={staff}
            onOpenFolder={onOpenFolder}
            onChanged={refresh}
          />
        ))}
      </div>
    </section>
  );
}

// --- stack editor (staff only) -------------------------------------------

/** Inline section management: add/reorder/remove stacks. Publishes the author's
 *  whole def set on each change (replaceable-as-a-whole). */
function StackEditor({
  defs,
  onChanged,
}: {
  defs: StackDef[];
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");

  const publish = async (next: StackDef[]) => {
    try {
      await publishStackDefs(next);
      onChanged();
    } catch (e) {
      console.error("stack def publish failed", e);
    }
  };

  const add = () => {
    const title = draft.trim();
    if (!title) return;
    const id = slugify(title);
    if (defs.some((d) => d.id === id)) {
      setDraft("");
      return;
    }
    publish([...defs, { id, title, order: defs.length }]);
    setDraft("");
  };

  const remove = (id: string) =>
    publish(defs.filter((d) => d.id !== id).map((d, i) => ({ ...d, order: i })));

  const move = (id: string, dir: -1 | 1) => {
    const i = defs.findIndex((d) => d.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= defs.length) return;
    const next = [...defs];
    [next[i], next[j]] = [next[j], next[i]];
    publish(next.map((d, k) => ({ ...d, order: k })));
  };

  return (
    <div className="stack-editor">
      <button
        type="button"
        className="run-agent-btn stack-editor-toggle"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {open ? "hide stack editor" : "manage stacks"}
      </button>
      {open && (
        <div className="stack-editor-body">
          <form
            className="stack-editor-add"
            onSubmit={(e) => {
              e.preventDefault();
              add();
            }}
          >
            <input
              type="text"
              className="stack-editor-input"
              placeholder="new section title…"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />
            <button type="submit" className="run-agent-btn" disabled={!draft.trim()}>
              <Plus size={13} aria-hidden="true" /> add section
            </button>
          </form>
          <ol className="stack-editor-list">
            {defs.map((d, i) => (
              <li key={d.id} className="stack-editor-row">
                <span className="stack-editor-title">{d.title}</span>
                <code className="stack-editor-id">{d.id}</code>
                <div className="stack-editor-controls">
                  <button
                    type="button"
                    className="listings-doctrine-move"
                    disabled={i === 0}
                    onClick={() => move(d.id, -1)}
                    aria-label="Move section up"
                  >
                    <ChevronUp size={13} />
                  </button>
                  <button
                    type="button"
                    className="listings-doctrine-move"
                    disabled={i === defs.length - 1}
                    onClick={() => move(d.id, 1)}
                    aria-label="Move section down"
                  >
                    <ChevronDown size={13} />
                  </button>
                  <button
                    type="button"
                    className="stack-editor-remove"
                    onClick={() => remove(d.id)}
                    aria-label={`Remove section ${d.title}`}
                  >
                    <X size={13} />
                  </button>
                </div>
              </li>
            ))}
          </ol>
          {defs.length === 0 && (
            <p className="times-empty">No sections yet. Add one above to start filing zines.</p>
          )}
        </div>
      )}
    </div>
  );
}

// --- stack section -------------------------------------------------------

function StackSection({
  stack,
  defs,
  staff,
  onOpenFolder,
  onChanged,
}: {
  stack: ResolvedStack;
  defs: StackDef[];
  staff: boolean;
  onOpenFolder?: (folderId: string) => void;
  onChanged: () => void;
}) {
  const isUnfiled = stack.id === "__unfiled__";
  return (
    <section className="stack-section">
      <header className="stack-section-header">
        <h2 className="stack-section-title">{stack.title}</h2>
        <span className="stack-section-count">
          {stack.zines.length} zine{stack.zines.length === 1 ? "" : "s"}
        </span>
      </header>
      {stack.zines.length === 0 ? (
        <p className="times-empty stack-section-empty">
          {isUnfiled ? "Nothing unfiled." : "No zines filed here yet."}
        </p>
      ) : (
        <div className="stack-grid">
          {stack.zines.map((zine, i) => (
            <ZineCardView
              key={zine.entry.folderId}
              zine={zine}
              featured={!isUnfiled && i === 0}
              rank={i}
              defs={defs}
              stackId={stack.id}
              staff={staff}
              onOpenFolder={onOpenFolder}
              onChanged={onChanged}
            />
          ))}
        </div>
      )}
    </section>
  );
}

// --- zine card -----------------------------------------------------------

function ZineCardView({
  zine,
  featured,
  rank,
  defs,
  stackId,
  staff,
  onOpenFolder,
  onChanged,
}: {
  zine: ZineCard;
  featured: boolean;
  rank: number;
  defs: StackDef[];
  stackId: string;
  staff: boolean;
  onOpenFolder?: (folderId: string) => void;
  onChanged: () => void;
}) {
  const [assignOpen, setAssignOpen] = useState(false);
  const { entry, name } = zine;
  const moveTo = async (targetStackId: string) => {
    // Publish the reader's assignment at the current rank (preserve order on a
    // move between sections). A real re-rank would re-index; this is the simple
    // "file it here" gesture.
    try {
      await publishStackAssignment({ stackId: targetStackId, folderId: entry.folderId, rank });
      onChanged();
    } catch (e) {
      console.error("stack assignment failed", e);
    }
    setAssignOpen(false);
  };
  return (
    <article className={"stack-card" + (featured ? " featured" : "")}>
      <div className="stack-card-head">
        {featured && <span className="stack-card-featured-badge">№{rank + 1}</span>}
        {staff && (
          <button
            type="button"
            className="stack-card-assign-toggle"
            title="File in a different stack"
            onClick={() => setAssignOpen((o) => !o)}
          >
            file ↦
          </button>
        )}
        {assignOpen && staff && (
          <div className="stack-card-assign-menu" role="menu">
            {defs.map((d) => (
              <button
                key={d.id}
                type="button"
                role="menuitem"
                className={"stack-card-assign-item" + (d.id === stackId ? " current" : "")}
                onClick={() => moveTo(d.id)}
              >
                {d.title}
              </button>
            ))}
          </div>
        )}
      </div>
      <button
        type="button"
        className="stack-card-title-btn"
        onClick={() => onOpenFolder?.(entry.folderId)}
        disabled={!onOpenFolder}
        title={onOpenFolder ? `Open ${name} in the press` : name}
      >
        <span className="stack-card-title">{name}</span>
      </button>
      <span className="stack-card-id" title={entry.folderId}>
        {shortId(entry.folderId)}
      </span>
      <span className="stack-card-stats">
        <span>{entry.eventCount} step{entry.eventCount === 1 ? "" : "s"}</span>
        {entry.citationTotal > 0 && (
          <span>{entry.citationTotal} cite{entry.citationTotal === 1 ? "" : "s"}</span>
        )}
        <span>{entry.authorPubkeys.size} voice{entry.authorPubkeys.size === 1 ? "" : "s"}</span>
        <span className="stack-card-time">{timeAgo(entry.lastSeenMs)}</span>
      </span>
      {entry.topTags.length > 0 && (
        <span className="stack-card-tags">
          {entry.topTags.slice(0, 3).map((t) => (
            <span key={t} className="times-chip">
              #{t}
            </span>
          ))}
        </span>
      )}
    </article>
  );
}

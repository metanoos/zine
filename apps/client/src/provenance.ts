import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import type { Event, EventTemplate } from "nostr-tools";
import type { Filter } from "nostr-tools";
import { Relay } from "nostr-tools/relay";

import { loadOrCreateVoice } from "./identity.js";
import { writeRelays, readRelays } from "./relay-config.js";
import type { Run } from "./workspace-core.js";
import { flattenRuns } from "./workspace-core.js";

/**
 * Bridge between the editor and the local relay. Mirrors the harness's
 * `ProvenanceStore` publish/fetch shapes exactly so events are
 * interoperable: a kind-4290 sealed here is queryable by the CLI, and
 * vice versa.
 *
 * One deliberate divergence from the harness: this producer follows the
 * spec (trace-provenance.md) and OMITS `oldValue` on delta serialization.
 * The harness still ships it (a stale carryover the spec marks "removed");
 * `applyDeltas` ignores it either way, so omitting is safe and correct.
 */

const FILE_TRACE_NODE_KIND = 4290;
/** The single TraceNode kind (spec §1/§R11.3): file and folder nodes both use
 *  4290, discriminated by the `z` tag. Alias kept for readability at sites
 *  that mean "the trace-node kind" without caring about file vs folder. */
const TRACE_NODE_KIND = 4290;
const TRACE_NAME_KIND = 4291;
/** Legacy: folder-trace nodes minted before kind consolidation. Readers
 *  accept these (querying both 4290 + 4292 and merging); no new writes. */
const FOLDER_TRACE_NODE_KIND = 4292;
const TRACE_ALPHA_KIND = 4293;
const FOLDER_MANIFEST_KIND = 34290;
/** Spec §4: TraceHead — parameterized replaceable head-pointer cache. Same
 *  number as the legacy folder manifest (34290); new writes use the spec's
 *  `{ head }` content shape, `d` = trace identity. The legacy read path
 *  distinguishes the two by content shape (`content.files` vs `content.head`). */
const TRACE_HEAD_KIND = 34290;

/** The trace-provenance kinds. Used to decide whether a sampled event is
 *  zine/trace-compatible (renders as a body) or foreign (renders with a "not a
 *  zine trace" badge). Per spec §1 the canonical set is {4290, 34290, 34291};
 *  4291/4292 are retained here only so legacy sampled events keep rendering.
 *  See protocol/trace-provenance.md §Event kinds. */
const TRACE_KINDS = new Set<number>([
  FILE_TRACE_NODE_KIND, // 4290 — file AND folder nodes (z tag discriminates)
  TRACE_NAME_KIND, // 4291 — legacy, retired in favor of TraceOpinion (34291)
  FOLDER_TRACE_NODE_KIND, // 4292 — legacy folder nodes pre-consolidation
]);

/** Provenance for a sampled event, surfaced as an in-memory metadata strip in
 *  the editor pane. Never written to disk — a sampled file reloads as a plain
 *  clean document. `compatible` flags the kind badge (zine trace vs not).
 *  Distinct from the Times-view `EventMeta` (parsed kind-4290 fields) — this
 *  carries a sampled hit's origin, not its parsed internals. */
export interface SampleEventMeta {
  eventId: string;
  pubkey: string;
  kind: number;
  /** Nostr wall-clock seconds (not ms). */
  createdAt: number;
  relays: string[];
  /** True for 4290/4291/4292 — drives the kind badge. */
  compatible: boolean;
}

/** One file's entry in its folder's membership (kind-4292 `snapshot.members`).
 *  Mirrors `apps/harness/src/models.ts` bit-for-bit so a folder-trace node
 *  written here is readable by the harness CLI and vice versa. Under spec-clean
 *  tombstones (protocol §FolderTraceNode), a deleted file leaves the snapshot
 *  via a `remove` delta rather than staying as an `isDeleted` entry — so this
 *  type has no tombstone field. `isDeleted` is kept optional purely so the
 *  three workspace backends' `markDeleted` callers compile unchanged while
 *  tombstone semantics finish migrating; the 4292 path always omits it. */
export interface ManifestFileEntry {
  /** "file" or "folder". Absent on legacy entries (pre-nesting) — readers
   *  default "file", the only member kind before this revision (spec §3.2). */
  kind?: "file" | "folder";
  relativePath: string;
  latestNodeId: string;
  contentHash: string;
  /** Always absent from the 4292 path. Optional only so legacy 34290 fallback
   *  reads and the workspace `markDeleted` helpers still type-check during the
   *  migration; treat as false if present. */
  isDeleted?: boolean;
}

export interface EditorDelta {
  type: "insert" | "delete" | "replace";
  positionStart: number;
  positionEnd: number;
  newValue: string | null;
  timestamp: number;
}

/**
 * Minimal common-prefix/suffix diff. Returns the deltas that turn `oldText`
 * into `newText`. For the debounce-level publish path this is enough: a run
 * of consecutive typing produces one contiguous change region, which this
 * captures exactly. The harness uses diff-match-patch for finer granularity
 * (merging adjacent delete+insert into replace); we don't need that here
 * because the editor's own transactions are already the per-op granularity —
 * this diff is only to summarize the accumulated change since last seal.
 */
export function diffToDeltas(oldText: string, newText: string): EditorDelta[] {
  if (oldText === newText) return [];
  let start = 0;
  const maxPrefix = Math.min(oldText.length, newText.length);
  while (start < maxPrefix && oldText[start] === newText[start]) start++;
  let oldEnd = oldText.length;
  let newEnd = newText.length;
  while (oldEnd > start && newEnd > start && oldText[oldEnd - 1] === newText[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }
  const inserted = newText.slice(start, newEnd);
  const type: EditorDelta["type"] = oldEnd === start ? "insert" : inserted === "" ? "delete" : "replace";
  return [
    {
      type,
      positionStart: start,
      positionEnd: oldEnd,
      newValue: inserted,
      timestamp: Date.now(),
    },
  ];
}

/**
 * The single contiguous region where `oldText` and `newText` differ, expressed
 * as offsets into the **new** text — the range a "scroll this action into view"
 * consumer can hand to `EditorView.scrollIntoView`. Same common-prefix/suffix
 * shape as `diffToDeltas`, but folded to a bare range:
 *  - insert/replace → the newly written span `[start, start + inserted.length)`
 *  - delete → a collapsed point `[start, start)` at the deletion site
 *  - identical → `null` (nothing to scroll to)
 *
 * Used by folder replay: each step's `contentUpToHere` vs the previous step's
 * gives the footprint of *this seal's* deltas without re-parsing event JSON.
 */
export function stepDeltaRange(
  oldText: string,
  newText: string,
): { from: number; to: number } | null {
  if (oldText === newText) return null;
  let start = 0;
  const maxPrefix = Math.min(oldText.length, newText.length);
  while (start < maxPrefix && oldText[start] === newText[start]) start++;
  let oldEnd = oldText.length;
  let newEnd = newText.length;
  while (oldEnd > start && newEnd > start && oldText[oldEnd - 1] === newText[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }
  const inserted = newText.slice(start, newEnd);
  // delete → collapsed point; insert/replace → the inserted span in the new doc
  const to = inserted === "" ? start : start + inserted.length;
  return { from: start, to };
}

// --- per-character authorship (the `authors` content field) --------------
//
// The protocol's only structural author signal is `event.pubkey` — one signer
// per node. That's enough to say *who sealed* a checkpoint, but it collapses
// every multi-author document to a single run on reload: a node signed by B
// that edits text authored by A reads back as if B wrote the whole thing.
//
// `authors` is the optional, additive fix: a serialized run list carried in the
// node's content, aligned 1:1 with `snapshot`. Concatenating `authors[].t` in
// order reproduces `snapshot` exactly, so the per-character truth a live editor
// already tracks (App.tsx's `voiceField` / `spliceRuns`) survives across reload
// and across devices — anywhere the chain is read. Old nodes without `authors`
// keep reading via per-node-signer attribution; the field never disagrees with
// `snapshot` because it's validated on read. This is the concrete carrier for
// the stance the spec already states: "authorship provenance lives on that
// edge, not the signer field" (spec:236).
//
// Wire shape uses short keys (`v`/`len`/`src`) per protocol §3.6: runs carry
// NO text (the body lives once, in `snapshot`), only a UTF-16 length. This is
// the §R11.6 de-duplication — an earlier `{v, t}` form stored the body twice.

/** Compact run entry on the wire: `v` = author pubkey, `len` = run length in
 *  UTF-16 code units (= JS `.length`, per spec §2), `src` = OPTIONAL event id
 *  of a node signed by `v` corroborating this run (§3.6 verification rule). */
interface AuthorEntry {
  v: string;
  len: number;
  src?: string;
}

/** Serialize a run list to the wire form, merging adjacent same-voice runs
 *  first (defensive — the editor already collapses them, but a caller can hand
 *  us a list with adjacent duplicates after a slice). Emits length-only runs —
 *  no text — per protocol §3.6. `src` is preserved when present (§3.6
 *  verification). Empty input → []. */
export function buildAuthors(runs: Run[]): AuthorEntry[] {
  const merged = mergeAdjacent(runs);
  const out: AuthorEntry[] = [];
  for (const r of merged) {
    if (r.text.length === 0) continue;
    out.push(r.src ? { v: r.voice, len: r.text.length, src: r.src } : { v: r.voice, len: r.text.length });
  }
  return out;
}

/** Merge runs that share a voice (and the same `src`) and are adjacent,
 *  mirroring `charsToRuns`. Different `src` keeps runs separate so merge
 *  attribution can name distinct corroborating parents. */
function mergeAdjacent(runs: Run[]): Run[] {
  const out: Run[] = [];
  for (const r of runs) {
    const last = out[out.length - 1];
    if (last && last.voice === r.voice && last.src === r.src) last.text += r.text;
    else if (r.text.length > 0) out.push({ voice: r.voice, text: r.text, ...(r.src ? { src: r.src } : {}) });
  }
  return out;
}

/** Expand a run list to per-char pairs. Mirrors App.tsx's `runsToChars`; kept
 *  locally so `reconstructRunsFromChain` can adopt an `authors` map into the
 *  char buffer without an App.tsx dependency. */
function runsToChars(runs: Run[]): { ch: string; voice: string }[] {
  const out: { ch: string; voice: string }[] = [];
  for (const r of runs) for (const ch of r.text) out.push({ ch, voice: r.voice });
  return out;
}

/** Deserialize a node's `authors` field back to a run list. Returns `null`
 *  when the field is absent, not an array, or its run lengths don't sum to
 *  exactly `snapshot.length` (the integrity check — a forged or stale map is
 *  treated as missing, and the caller falls back to per-node-signer
 *  attribution). Reconstructs each run's text by partitioning `snapshot` at
 *  the accumulated `len` offsets — runs carry no text on the wire (§3.6), so
 *  the snapshot is the single source of body text. Merges adjacent same-voice
 *  entries defensively. */
export function parseAuthors(authors: unknown, snapshot: string): Run[] | null {
  if (!Array.isArray(authors)) return null;
  // First pass: validate shape and sum lengths. Any non-integer/negative len
  // fails the whole map — better to degrade to signer attribution than to
  // slice with a bad offset.
  let total = 0;
  const entries: { v: string; len: number; src?: string }[] = [];
  for (const entry of authors) {
    if (!entry || typeof entry !== "object") return null;
    const { v, len, src } = entry as { v?: unknown; len?: unknown; src?: unknown };
    if (typeof v !== "string" || typeof len !== "number" || !Number.isInteger(len) || len < 0) {
      return null;
    }
    if (src !== undefined && typeof src !== "string") return null;
    if (len === 0) continue;
    entries.push(src ? { v, len, src } : { v, len });
    total += len;
  }
  // The integrity anchor: run lengths must sum to exactly the snapshot's
  // UTF-16 length. A mismatch means the map is stale or forged — drop it and
  // let the caller attribute by signer, same as the legacy no-authors path.
  if (total !== snapshot.length) return null;
  // Second pass: partition snapshot by the accumulated offsets into runs.
  // Adjacent same-voice runs merge only when `src` matches, so a merge node's
  // multi-parent attribution (two runs, same pubkey, different src) survives.
  const runs: Run[] = [];
  let cursor = 0;
  for (const { v, len, src } of entries) {
    const text = snapshot.slice(cursor, cursor + len);
    cursor += len;
    const last = runs[runs.length - 1];
    if (last && last.voice === v && last.src === src) last.text += text;
    else runs.push(src ? { voice: v, text, src } : { voice: v, text });
  }
  return runs;
}

export interface PublishEditInput {
  prevEventId: string | null;
  relativePath: string;
  folderId: string;
  deltas: EditorDelta[];
  snapshot: string;
  contentHash: string;
  /** Per-character attribution for `snapshot`, serialized into the node's
   *  `authors` field (protocol §FileTraceNode Content). Concatenating the runs'
   *  text in order MUST reproduce `snapshot` exactly; readers validate this and
   *  fall back to per-node-signer attribution on mismatch. Absent → the node is
   *  sealed with signer-only attribution (the legacy behavior; old chains still
   *  read correctly). This is the durable, reconstructable-from-chain carrier
   *  for "authorship provenance lives on that edge, not the signer field"
   *  (spec:236) — without it, every reload collapses a multi-author document to
   *  a single run. */
  authors?: Run[];
  action?: string;
  summary?: string | null;
  /** User-authored `t` tags for this file. Containment is NOT expressed here —
   *  it lives on the folder manifest's composition edge and on the `["f"]`
   *  mirror, so `t` tags are purely topical labels. */
  tags?: string[];
  /** Hardened-span node ids this trace cites — emitted as one `q` tag each
   *  (NIP-18 quote shape). The container cites every resolved `[[ phrase |
   *  nodeId ]]` it contains on each seal (spec:189). The read side
   *  (`eventMeta.citationCount`) and the Times view already count `q` tags; this
   *  is the emission half that was missing. Absent on minted-span genesis
   *  (those nodes are the *cited* thing) and on delete tombstones (empty
   *  snapshot, nothing to cite). */
  citations?: string[];
  /** Optional override signer (secret key bytes). Defaults to the keychain's
   *  manual (pen) key via loadOrCreateVoice() — the posture every existing seal
   *  uses. The per-voice Send/zine affordance passes the clicked voice's key so
   *  the trace is signed as that voice rather than the manual default. */
  signer?: Uint8Array;
  /** Fork lineage: the source node id a fork-on-write file was seeded from.
   *  Emits `["e", forkedFrom, "", "forked-from"]` (spec §Forking). Absent on
   *  every non-fork path. The `action` field is set to `"fork"` by the caller
   *  when this is present. */
  forkedFrom?: string;
  /** Merge parents (spec §3.1/§3.8 Merging): foreign node ids this owner is
   *  unilaterally accepting into *this* chain. Emits one
   *  `["e", parentId, "", "merge-parent"]` per entry. The merge node is signed
   *  by this chain's owner only — parent authors neither co-sign nor approve.
   *  Callers set `action: "merge"` when these are present. */
  mergeParents?: string[];
  /** Extraction lineage (spec §3.8, REQUIRED on minted-span nodes): the exact
   *  origin node-version the span was pulled out of. Emits
   *  `["e", extractedFrom, "", "extracted-from"]`. Absent on whole-file genesis
   *  imports and every non-minting path. */
  extractedFrom?: string;
  /** Body hash for the `x` tag (spec §3.1: REQUIRED on minted-span nodes and
   *  folder nodes, OPTIONAL on named file nodes — an open question). When set,
   *  emits `["x", bodyHashTag]`, enabling `#x` content-identity queries that
   *  find every trace with an identical body whoever minted it. For a minted
   *  span this is `sha256(snapshot)`; for a folder, the canonical folder body
   *  hash. Named files leave this unset (opting out of cross-folder copy
   *  detection per the spec's open question). */
  bodyHashTag?: string;
  /** The sealed node id this whole document is replying to (the Reply
   *  action's source, at the moment the reply was written). Emits a `q` tag
   *  (folded into the same dedup as `citations`) plus a `reply-to` delta
   *  entry carrying `sourceEventId` — "cites, doesn't inline, is this
   *  document's subject" (spec §reply-to delta type), distinct from a
   *  bracket citation. Absent on every non-Reply write. */
  replyingTo?: string;
  /** Cited-trace node ids tagged onto this document *without* a body bracket —
   *  the protocol's `tag-add` (spec §Tagging vs. bracketing): "cites, doesn't
   *  inline, is a zine." Each emits one `q` tag (folded into the same dedup as
   *  `citations` and `replyingTo`, so a trace quoted in the body AND tagged
   *  doesn't double up) plus a `tag-add` delta carrying `sourceEventId`.
   *  `snapshot`/`contentHash` are untouched — a tag never alters the body, the
   *  same stance `reply-to` already takes. Absent on every non-tagging write. */
  taggedTraces?: string[];
  /** `action: llm` only — the event id of the minted rule-manifest trace
   *  whose body names the expansion algorithm + params (protocol §3.7). Each
   *  LLM seal cites its rule so a reader can reconstruct the submitted prompt.
   *  Absent on every non-LLM write. Emitted as a `q` tag (folded into the same
   *  dedup as citations) and recorded in the node content's `injectRule` field.
   *  See `getOrCreateRuleTrace`. */
  injectRule?: string;
  /** `action: llm` only — node ids of everything in the model's scope at call
   *  time (folder members' heads, the active file's nucleus, the rule trace).
   *  Emitted as `q` tags alongside the body citations, so a reader fetching the
   *  cited nuclei can reconstruct what the model saw (§3.7 reconstruction).
   *  The rule-trace id (`injectRule`) is typically included here too. Absent on
   *  every non-LLM write. */
  scopeCitations?: string[];
  /** `action: llm` only — the model configuration that answered the call, so a
   *  reader knows not just what was asked and what was in scope, but which call
   *  configuration produced the response. Serialized as a top-level `llm` field
   *  in the node content. Absent on every non-LLM write. */
  llm?: { model: string; temperature: number | null; maxTokens: number; provider: string };
}

/** From a file's prev-chain, the user-authored `t` tags carried by the chain
 *  head. All `t` tags are author labels now — there is no structural folder
 *  tag prepended — so the whole list is returned as-is. Returns [] for an empty
 *  chain. */
export function headUserTags(chain: Event[]): string[] {
  if (chain.length === 0) return [];
  const head = chain[chain.length - 1];
  return head.tags.filter((t) => t[0] === "t").map((t) => t[1]);
}

/** The tagged-but-not-quoted trace node ids on a file's chain head — the
 *  `tag-add` subset of the head's `q` tags, with every id the body cites via a
 *  resolved `[[ phrase | nodeId ]]` bracket removed. This is the read-back half
 *  of `PublishEditInput.taggedTraces`: on attach, a file's tagged traces are
 *  recovered as (head q-tags) minus (body brackets), so a tag survives reload
 *  without being re-added. `bracketNodeIds` is the caller's
 *  `findResolvedBrackets(content).map(b => b.nodeId)` — kept a parameter so this
 *  helper stays free of a brackets.js import. Returns [] for an empty chain. */
export function headTaggedTraces(chain: Event[], bracketNodeIds: string[]): string[] {
  if (chain.length === 0) return [];
  const targets = eventMeta(chain[chain.length - 1]).citationTargets;
  const bracket = new Set(bracketNodeIds);
  // Preserve head order; drop only ids the body already cites (those are
  // recovered from the body on every seal, not stored as tagged traces).
  return targets.filter((id) => !bracket.has(id));
}

// --- multi-relay connection pool ------------------------------------------
//
// The provenance layer publishes to and reads from the user's configured relay
// set (relay-config.ts) — and only that set. The home relay is just another
// entry in the list now; whether it's contacted at all is governed by its
// `read`/`write` toggles, exactly like any external relay the user adds. There
// is no implicit "always include the primary" path, because that would make
// the user's off toggles a lie.
//
// Connections are cached per-URL so repeat publishes don't reconnect. We also
// retry briefly per URL, because the desktop's home relay is a Tauri-spawned
// sidecar that may still be booting on the first publish of a session.

const relayCache = new Map<string, Promise<Relay>>();

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Lazily connects to a relay URL, caching the open connection.
 *
 *  The relay is constructed as an instance (not via the static Relay.connect)
 *  so we can set `onauth` BEFORE `connect()` resolves — the relay's AUTH
 *  challenge arrives as a message on the open WebSocket, and if onauth isn't
 *  set by then it's silently dropped. Constructing → setting onauth →
 *  connecting is the race-free order nostr-tools' own pool uses (nostr.bundle.
 *  js:3620-3634). In friend mode (transport.md §5) the sidecar challenges every
 *  connection; this handler signs the kind-22242 AUTH event with the manual
 *  (pen) key so the relay recognizes us as owner or friend. In open mode the
 *  relay never challenges, so this is dead code that costs nothing. */
function getRelay(url: string): Promise<Relay> {
  let p = relayCache.get(url);
  if (!p) {
    p = withTimeout(connectWithAuth(url), 4000, `connect ${url}`);
    relayCache.set(url, p);
    // Drop from cache on failure so the next call can retry.
    p.catch(() => relayCache.delete(url));
  }
  return p;
}

/** Construct a Relay instance, wire the NIP-42 AUTH handler, then connect.
 *  Separated from getRelay so the caching layer isn't duplicated.
 *
 *  onauth expects (evt: EventTemplate) => Promise<VerifiedEvent>, but
 *  finalizeEvent returns NostrEvent (whose verified brand is `boolean |
 *  undefined` vs VerifiedEvent's `true`). The event IS verified — finalizeEvent
 *  computes the id+sig — so the cast is type-only, not a semantic lie.
 *
 *  AUTH race: nostr-tools' onauth fires when the challenge arrives and calls
 *  relay.auth() internally, but publish()/subscribe() don't wait for auth to
 *  complete. In friend mode the relay rejects every event/filter with
 *  "auth-required:" until AUTH is processed. We bridge this by tracking the
 *  auth completion as a promise and awaiting it (with a short timeout) before
 *  returning the relay. In open mode the relay never challenges, so the
 *  promise never resolves — the timeout (1.5s) handles that gracefully. */
async function connectWithAuth(url: string): Promise<Relay> {
  const relay = new Relay(url);
  let authResolve: (() => void) | undefined;
  const authDone = new Promise<void>((resolve) => {
    authResolve = resolve;
  });
  relay.onauth = async (evt) => {
    const signed = finalizeEvent(evt, loadOrCreateVoice().secretKey) as unknown as
      Awaited<ReturnType<NonNullable<Relay["onauth"]>>>;
    // Resolve the ready promise once the signed AUTH event is produced.
    // The relay still needs to process it (a round-trip), so the caller
    // adds a short grace delay after authDone resolves — see below.
    authResolve?.();
    return signed;
  };
  await relay.connect();
  // Wait for the AUTH round-trip, but don't block forever — open-mode
  // relays never challenge, so the promise would hang. 2s is enough for
  // a localhost relay to process the AUTH event (measured: ~500ms for
  // the challenge to arrive + ~500ms for the relay to process our response).
  // The extra delay after authDone resolves covers the relay's processing
  // of our AUTH event before it marks the connection authed.
  await Promise.race([
    authDone.then(() => new Promise<void>((r) => setTimeout(r, 500))),
    new Promise<void>((r) => setTimeout(r, 2500)),
  ]);
  return relay;
}

// One in-flight retry loop per URL, so concurrent callers share it instead of
// each spawning their own. Without this, N seal/fetch sites calling
// getWriteRelays/getReadRelays at slightly offset times run N overlapping retry
// loops; with a flat delay those rounds interleave into a reconnect burst that
// a rate-limiting proxy (or a freshly-booting sidecar) sees as one big spike —
// and 429s. Coalescing means one Relay.connect per round, no matter how many
// callers are waiting on the same URL.
const retryingCache = new Map<string, Promise<Relay | null>>();

/**
 * Connect with a short retry loop — the desktop sidecar can take a moment to
 * come up. A dead external relay still yields null (best-effort), but a URL we
 * never manage to open at all returns null too; callers handle both.
 *
 * Concurrent calls for the same URL are coalesced onto one shared loop (see
 * `retryingCache`), and retries use exponential backoff + jitter so staggered
 * callers can't re-synchronize their rounds into another burst.
 */
async function getRelayRetrying(url: string, maxAttempts = 5): Promise<Relay | null> {
  const existing = retryingCache.get(url);
  if (existing) return existing;
  const p = (async (): Promise<Relay | null> => {
    try {
      let lastErr: unknown;
      for (let i = 0; i < maxAttempts; i++) {
        try {
          return await getRelay(url);
        } catch (e) {
          lastErr = e;
          // Backoff + jitter: the jitter de-syncs staggered callers so their
          // rounds don't re-pile-up into a burst (~200-400, 400-600, 800-1000,
          // 1600-1800ms across the 5 attempts — ~3s total, room for a slow boot).
          if (i < maxAttempts - 1) {
            await delay(200 * 2 ** i + Math.random() * 200);
          }
        }
      }
      console.warn(`could not connect to relay ${url}:`, lastErr);
      return null;
    } finally {
      retryingCache.delete(url);
    }
  })();
  retryingCache.set(url, p);
  return p;
}

/** Connect to every write-enabled relay. Order matches the user's list. */
async function getWriteRelays(): Promise<Relay[]> {
  const urls = writeRelays().map((e) => e.url);
  const out: Relay[] = [];
  for (const url of urls) {
    if (out.some((r) => r.url === url)) continue;
    const r = await getRelayRetrying(url);
    if (r) out.push(r);
  }
  return out;
}

/** Connect to every read-enabled relay. Order matches the user's list. */
async function getReadRelays(): Promise<Relay[]> {
  const urls = readRelays().map((e) => e.url);
  const out: Relay[] = [];
  for (const url of urls) {
    if (out.some((r) => r.url === url)) continue;
    const r = await getRelayRetrying(url);
    if (r) out.push(r);
  }
  return out;
}

/**
 * Publish to one relay, retrying once after NIP-42 AUTH if the relay rejects
 * with "auth-required:". nostr-tools' individual Relay.publish() does NOT
 * retry after auth (only the SimpleRelayPool does); we replicate the pool's
 * retry pattern here so friend-mode relays accept our writes. The relay's
 * onauth handler (set in connectWithAuth) signs the AUTH event with the
 * manual key.
 */
async function publishWithAuth(relay: Relay, event: Event): Promise<string> {
  try {
    return await relay.publish(event);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.startsWith("auth-required:") && relay.onauth) {
      // The relay challenged us. Sign the AUTH event and retry — by the time
      // relay.auth() resolves, the relay has processed our AUTH and marked
      // the connection authed, so the retry should succeed.
      await relay.auth(relay.onauth);
      return await relay.publish(event);
    }
    throw err;
  }
}

/**
 * Publish to every relay in parallel. A single relay failing is collected but
 * does not fail the call — one dead external relay shouldn't block a save, and
 * the write set is the user's choice, so the home relay is no more "canonical"
 * than any other. The call rejects only when *every* relay failed (or when the
 * set was empty to begin with), so a save is never a silent no-op.
 */
async function publishToMany(relays: Relay[], event: Event): Promise<void> {
  if (relays.length === 0) {
    throw new Error(
      "no relays available to publish to — enable write on at least one relay (the home relay is off)",
    );
  }
  const results = await Promise.allSettled(relays.map((r) => publishWithAuth(r, event)));
  const ok = results.some((r) => r.status === "fulfilled");
  if (!ok) {
    const msgs = results
      .map((r, i) =>
        r.status === "rejected" ? `${relays[i].url}: ${String(r.reason)}` : null,
      )
      .filter(Boolean)
      .join("; ");
    throw new Error(`publish failed on every relay${msgs ? ` (${msgs})` : ""}`);
  }
}

/** Dedupe user tags case-insensitively, keeping first-seen casing. Containment
 *  is no longer expressed as a `t` tag — it lives on the folder manifest's
 *  composition edge and on the `["f", folderId]` mirror — so `t` is purely
 *  topical labels, authored or empty. */
function buildTTags(userTags: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const tag of userTags) {
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  return out;
}

/** §3.7 pending LLM metadata. The client's op path seals LLM write-back
 *  through the generic `writeFile` → backend → publishEdit chain, which spans
 *  3 backends + an interface — threading `injectRule`/`scopeCitations`/`llm`
 *  through every signature is high-risk churn. Instead, an LLM op stashes its
 *  metadata here just before its write-back seal; publishEdit reads and clears
 *  it. This is a single-slot stash (one pending LLM seal at a time) — the ops
 *  are synchronous from seal-trigger to publishEdit, so there's no concurrency.
 *  If the stash is set but the next publishEdit turns out NOT to be the LLM op
 *  (e.g. an intervening file save), the metadata is consumed anyway and lost —
 *  acceptable, since the op will set it again on retry, and an LLM op losing
 *  its scope pin degrades to "scope invisible," not corruption. */
let pendingLlmMeta: {
  injectRule: string;
  scopeCitations: string[];
  llm: { model: string; temperature: number | null; maxTokens: number; provider: string };
} | null = null;

/** Set the pending LLM metadata consumed by the next publishEdit call. Called
 *  by LLM ops just before their write-back seal. The action marker (`"llm"`)
 *  must be set on that publishEdit for the metadata to attach — a non-LLM
 *  publishEdit clears the stash without consuming it, so a stray save between
 *  set and seal doesn't mislabel a non-LLM node. */
export function setPendingLlmMeta(meta: {
  injectRule: string;
  scopeCitations: string[];
  llm: { model: string; temperature: number | null; maxTokens: number; provider: string };
}): void {
  pendingLlmMeta = meta;
}

/** Builds, signs, and publishes a kind-4290 FileTraceNode. Returns the signed
 *  event (its `id` is the new node id the caller should track as prevEventId). */
export async function publishEdit(input: PublishEditInput): Promise<Event> {
  // §3.7: consume pending LLM metadata. The stash is single-use — clear it
  // regardless of whether this publishEdit is the LLM op, so a stale stash
  // never leaks onto a later unrelated seal. The stash is set by prepareLlmMeta
  // (App.tsx) just before the op's write-back seal; when present, this IS the
  // LLM seal, so mark the action and attach the metadata. The client's write-
  // back path defaults action to "edit"; the stash is the signal that this
  // particular seal is an LLM op, so we override action to "llm" here.
  if (pendingLlmMeta) {
    input.action = "llm";
    input.injectRule = pendingLlmMeta.injectRule;
    input.scopeCitations = [
      ...(input.scopeCitations ?? []),
      ...pendingLlmMeta.scopeCitations,
    ];
    if (!input.llm) input.llm = pendingLlmMeta.llm;
    pendingLlmMeta = null;
  }
  const relays = await getWriteRelays();
  // Sign as the override signer when provided (per-voice Send/zine), else the
  // keychain's manual (pen) key — the posture every auto-seal uses.
  const signer = input.signer ?? loadOrCreateVoice().secretKey;
  const sealedAt = Date.now();

  const tags: string[][] = [
    // Reification discriminator (protocol §3.1: REQUIRED on every node). `z`
    // splits file-reified from folder-reified traces within the single
    // TraceNode kind — once kinds consolidate (Phase 3), this is the only way
    // to tell a file node from a folder node.
    ["z", "file"],
    ["file", input.relativePath],
    ["folder", input.folderId],
    ["F", input.relativePath],
    ["D", input.folderId],
    // Filterable folder-membership mirror (spec tag table). Single-letter `f`
    // so `#f` queries can find every node in a folder by stable id — the
    // queryable counterpart to the positional `["folder", folderId]` above,
    // which NIP-01 `#` filters can't reach. Containment is composition (the
    // folder's manifest edge); this is a lookup index, not a label.
    ["f", input.folderId],
    ["action", input.action ?? "edit"],
  ];
  if (input.prevEventId) tags.push(["e", input.prevEventId, "", "prev"]);
  // Fork lineage (spec §Forking): the source node a fork-on-write file was
  // seeded from. Parallel to the minted-span `extracted-from` marker but for
  // whole-trace forks.
  if (input.forkedFrom) tags.push(["e", input.forkedFrom, "", "forked-from"]);
  // Merge parents (spec §3.1/§3.8 Merging): foreign heads this owner is
  // accepting into this chain. Unilateral — only this chain's owner signs.
  if (input.mergeParents) {
    const seen = new Set<string>();
    for (const parentId of input.mergeParents) {
      if (!parentId || seen.has(parentId)) continue;
      seen.add(parentId);
      tags.push(["e", parentId, "", "merge-parent"]);
    }
  }
  // Extraction lineage (spec §3.8: REQUIRED on minted-span nodes): the exact
  // origin node-version the span was pulled out of. The origin doc's own cite
  // (the `q` tag on its next seal) flows the other direction; this records the
  // extraction fan-out so a reader can find every span minted from one source.
  if (input.extractedFrom) tags.push(["e", input.extractedFrom, "", "extracted-from"]);
  // Body hash (spec §3.1: REQUIRED on minted-span nodes). Enables `#x`
  // content-identity queries. Named files omit it (spec open question — opting
  // out of cross-folder copy detection for byte-identical files).
  if (input.bodyHashTag) tags.push(["x", input.bodyHashTag]);

  // t-tags: topical labels only — no folder-name tag is derived or prepended.
  for (const tag of buildTTags(input.tags ?? [])) {
    tags.push(["t", tag]);
  }

  // q-tags: one per minted span this trace cites (spec:189 — the origin doc's
  // cite of each minted node, mirrored at top level), the Reply source
  // (replyingTo), and the tagged zines (taggedTraces) — all the same
  // "composition" edge, folded into one dedup so a trace cited more than one way
  // (quoted AND tagged, or tagged AND replied-to) never emits two q-tags.
  // NIP-18 quote shape, read back by `eventMeta` (citationCount +
  // citationTargets) and ranked on by the Times view.
  const qTargets = [
    ...(input.citations ?? []),
    ...(input.replyingTo ? [input.replyingTo] : []),
    ...(input.taggedTraces ?? []),
    // §3.7: an action:llm node also cites its full scope (folder members' heads,
    // the active file's nucleus, the rule trace) so a reader can reconstruct the
    // submitted prompt. Folded into the same dedup so a node cited as a body
    // bracket AND in scope emits one q-tag, not two.
    ...(input.scopeCitations ?? []),
    ...(input.injectRule ? [input.injectRule] : []),
  ];
  if (qTargets.length > 0) {
    const seen = new Set<string>();
    for (const nodeId of qTargets) {
      if (!nodeId || seen.has(nodeId)) continue;
      seen.add(nodeId);
      // NIP-18 quote shape (spec §3.1): ["q", nucleusId, relayHint, ownerPubkey].
      // relayHint is an empty string when no hint is known; the ownerPubkey
      // (4th element) is omitted here since the file-citation path doesn't
      // track it — readers tolerate a 3-element form.
      tags.push(["q", nodeId, ""]);
    }
  }
  // §3.7 advisory marker: this node carries LLM scope citations + a rule, so
  // readers reconstructing an LLM call can find these nodes by tag rather than
  // by content-shape sniffing. Non-normative — `q` semantics are unchanged.
  if (input.injectRule) tags.push(["scope", "llm"]);

  // Emit `authors` only when the caller's run list concatenates exactly to
  // `snapshot` — buildAuthors drops empty runs but doesn't re-check alignment,
  // so a caller passing a stale/edited map would otherwise serialize a
  // mismatched field that parseAuthors (correctly) rejects on read. Treat the
  // validation here as the write-side guard: never persist an authors map the
  // read side would discard.
  const authors =
    input.authors && flattenRuns(input.authors) === input.snapshot
      ? buildAuthors(input.authors)
      : undefined;

  const template: EventTemplate = {
    kind: FILE_TRACE_NODE_KIND,
    created_at: Math.floor(sealedAt / 1000),
    tags,
    content: JSON.stringify({
      sealedAt,
      // Spec-compliant: no `oldValue` (recoverable from prev.snapshot).
      deltas: [
        ...input.deltas.map((d) => ({
          type: d.type,
          position: { start: d.positionStart, end: d.positionEnd },
          newValue: d.newValue,
          timestamp: d.timestamp,
        })),
        // Citation deltas (spec §3.3: one `cite` delta type, four roles).
        // `role: "reply"` — this document replies to another sealed trace: no
        // position/newValue; body untouched. The pinned source is the paired
        // `q` tag above; this marks *which* q-tag is "this doc's subject".
        ...(input.replyingTo
          ? [{ type: "cite", role: "reply", op: "add", sourceEventId: input.replyingTo, timestamp: sealedAt }]
          : []),
        // `role: "tag"` — a zine tagged onto this trace: no position/newValue;
        // body untouched. One entry per tagged zine; the pinned source is the
        // paired `q` tag above. `snapshot`/`contentHash` are untouched (a tag
        // never alters the body), so these are observations, like reply.
        ...(input.taggedTraces ?? []).map((nodeId) => ({
          type: "cite",
          role: "tag",
          op: "add",
          sourceEventId: nodeId,
          timestamp: sealedAt,
        })),
      ],
      snapshot: input.snapshot,
      contentHash: input.contentHash,
      // Per-character attribution, validated against snapshot above. Absent on
      // nodes whose caller had no run list (genesis from plain text, deletes,
      // or the legacy signer-only path) — readers fall back to per-node-signer.
      ...(authors && authors.length > 0 ? { authors } : {}),
      ...(input.summary ? { summary: input.summary } : {}),
      // §3.7: action:llm nodes name their expansion rule + call configuration.
      // `injectRule` is the event id of the minted rule-manifest trace; `llm`
      // records the model/temperature/maxTokens/provider that answered. Both
      // absent on non-LLM nodes (readers treat as "not an LLM call").
      ...(input.injectRule ? { injectRule: input.injectRule } : {}),
      ...(input.llm ? { llm: input.llm } : {}),
    }),
  };

  const signed = finalizeEvent(template, signer);
  await publishToMany(relays, signed);
  return signed;
}

/** Harden a bracketed phrase into its own permanently-addressable kind-4290
 *  node (protocol §3.8). The span's text becomes an immutable, citable
 *  snapshot:
 *
 *  - `action: "import"` (spec §3.4 — "a span just minted").
 *  - `snapshot` = the phrase text; `deltas: []` (no prev — genesis for this
 *    synthetic path); `contentHash` = sha256(phrase).
 *  - Synthetic relative path `<originDoc>#<shortId>` in the same folder
 *    (spec §3.8), so the minted span is discoverable via a normal `#D` scan
 *    rather than needing an orphan-node category.
 *  - `["x", contentHash]` (spec §3.1: REQUIRED) — enables `#x` content-
 *    identity clustering so independent mints of the same words find
 *    each other.
 *  - `["e", originNodeId, "", "extracted-from"]` (spec §3.1/§3.8: REQUIRED) —
 *    the exact origin node-version the span was pulled out of, recording
 *    extraction fan-out so a reader can find every span minted from one source.
 *
 *  The caller rewrites the bracket `[[ phrase ]]` → `[[ phrase | newNodeId ]]`
 *  in the origin document; that rewrite is itself an ordinary cite delta on
 *  the origin doc's next seal (role: "inline", q-tagged at newNodeId) —
 *  produced by the normal seal path, not here.
 *
 *  Returns the signed event; `event.id` is the citable, immutable node id. */
export async function publishHardenedSpan(input: {
  folderId: string;
  originPath: string;
  phrase: string;
  /** REQUIRED: the origin document's current nucleus (node-version the span was
   *  pulled out of). Emitted as the `extracted-from` edge. */
  originNodeId: string;
}): Promise<Event> {
  const contentHash = await sha256HexLocal(input.phrase);
  // Short, stable suffix from the phrase hash so the synthetic path is
  // deterministic for an identical span (two mints of the same text
  // co-locate on disk; they're distinct nodes, distinguished by event id).
  const shortId = contentHash.slice(0, 8);
  const syntheticPath = `${input.originPath}#${shortId}`;

  return publishEdit({
    prevEventId: null,
    relativePath: syntheticPath,
    folderId: input.folderId,
    deltas: [],
    snapshot: input.phrase,
    contentHash,
    action: "import",
    summary: "minted span",
    // Spec §3.1: the body hash is REQUIRED on minted-span nodes — `#x`
    // content-identity queries depend on it (spec §6, §R3).
    bodyHashTag: contentHash,
    // Spec §3.8: the origin node-version this span was extracted from, REQUIRED
    // on minted-span nodes. The origin doc's own cite (the `q` tag on its
    // next seal) flows the other direction; this records extraction fan-out.
    extractedFrom: input.originNodeId,
  });
}

/** sha256 of `text` as lowercase hex. workspace.ts has the same helper; we
 *  keep a local copy here so provenance doesn't grow a workspace import just
 *  for hashing. Identical bytes → identical hash, so hashes interoperate.
 *  Exported because the alpha tune affordance needs to hash a palette item's
 *  body into the same contentHash the alpha chain keys on. */
export async function sha256HexLocal(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// --- injection rules (§3.7) ---------------------------------------------
//
// An injection rule is a minted immutable trace whose body is the
// InjectManifest JSON (`{ algorithm, params }`), NOT executable code. The
// press mints one per distinct (algorithm, params) combination and reuses it
// for every LLM call with the same manifest — so identical call configurations
// share a rule trace, and a config change mints a new one. This mirrors how
// brackets mint on first resolution. The rule trace is discoverable by
// folder scan (synthetic path under the press folder) and immutable by
// construction (genesis, no prev chain).

/** Per-press cache: (algorithm + paramsHash) → rule trace event id. Avoids
 *  minting a new rule trace on every LLM seal when the config hasn't changed.
 *  Keyed by `${algorithm}:${paramsHash}` where paramsHash is sha256 of the
 *  canonical JSON of params (stable key ordering). */
const ruleTraceCache = new Map<string, string>();

/** Canonical JSON for the params hash: keys sorted, no insignificant whitespace.
 *  Stable so two identical param objects hash identically regardless of key
 *  insertion order (the same posture as the §2 canonical folder body). */
function canonicalParamsHash(params: Record<string, unknown>): Promise<string> {
  const canonical = JSON.stringify(params, Object.keys(params).sort());
  return sha256HexLocal(canonical);
}

/** Mint (or reuse) a minted rule-manifest trace for `manifest`. Returns the
 *  rule trace's event id, caching it per (algorithm, paramsHash) so identical
 *  call configurations share one rule trace. The rule trace lives under the
 *  press folder at a synthetic path (`<press>#rule-<shortHash>`), is sealed as
 *  an immutable genesis (`action: import`, no prev), and carries the manifest
 *  JSON as its `snapshot` body — so a reader fetching the cited rule trace gets
 *  the manifest in one bounded fetch, exactly like any cited nucleus. */
export async function getOrCreateRuleTrace(
  folderId: string,
  manifest: { algorithm: string; params: Record<string, unknown> },
): Promise<string> {
  const paramsHash = await canonicalParamsHash(manifest.params);
  const cacheKey = `${manifest.algorithm}:${paramsHash}`;
  const cached = ruleTraceCache.get(cacheKey);
  if (cached) return cached;

  const body = JSON.stringify(manifest);
  const contentHash = await sha256HexLocal(body);
  const shortId = contentHash.slice(0, 8);
  const syntheticPath = `#rule-${manifest.algorithm}-${shortId}`;
  const event = await publishEdit({
    prevEventId: null,
    relativePath: syntheticPath,
    folderId,
    deltas: [],
    snapshot: body,
    contentHash,
    action: "import",
    summary: `inject rule: ${manifest.algorithm}`,
    bodyHashTag: contentHash,
  });
  ruleTraceCache.set(cacheKey, event.id);
  return event.id;
}

/** Fetches the full prev-chain for a file, ordered genesis→latest. Mirrors
 *  store.ts:fetchChain — never trusts created_at; walks `e...prev` links.
 *  Queries every enabled read relay and merges by event id (dedup), so a chain
 *  split across the local sidecar and an external relay still reconstructs.
 *  Head resolution is shared with the alpha read path via `resolveHead`. */
export async function fetchChain(folderId: string, relativePath: string): Promise<Event[]> {
  const relays = await getReadRelays();
  const filter: Filter = {
    kinds: [FILE_TRACE_NODE_KIND],
    "#F": [relativePath],
    "#D": [folderId],
  };
  const all = await queryMany(relays, filter);
  const byId = new Map(all.map((e) => [e.id, e]));

  const head = resolveHead(all);
  if (!head) return [];

  const chain: Event[] = [];
  let cursor: string | undefined = head.id;
  const guard = new Set<string>();
  while (cursor && !guard.has(cursor)) {
    guard.add(cursor);
    const event = byId.get(cursor);
    if (!event) break;
    chain.push(event);
    cursor = event.tags.find((t) => t[0] === "e" && t[3] === "prev")?.[1];
  }
  return chain.reverse();
}

/** Returns the latest event id for a file, or null if none published yet. */
export async function fetchLatestEventId(folderId: string, relativePath: string): Promise<string | null> {
  const chain = await fetchChain(folderId, relativePath);
  return chain.length > 0 ? chain[chain.length - 1].id : null;
}

/** Revoke a published zine (the whole folder trace) by publishing a NIP-09
 *  kind-5 deletion request signed by the owner's key. Per spec §10: the owner
 *  MAY revoke their own published nodes; a relay advertising NIP-9 MUST honor
 *  it. This fans out `e` tags for every kind-4290 node in the folder (the
 *  genesis is added explicitly — it carries no `f` tag, since an event cannot
 *  know its own id before signing) plus `a` tags for the replaceable TraceHead
 *  and any owned TraceOpinions. Revocation is advisory across relays and does
 *  not touch the chain (history is retained on the author's machine and
 *  readers' caches); it changes relay *retention* only.
 *
 *  Mirrors the publish shape of `publishTraceHead` (sign with
 *  `finalizeEvent`, fan out via `publishToMany`) and the read shape of
 *  `fetchFolderNodes` (`queryMany` over the read set). */
export async function revokeZine(
  folderId: string,
  reason: string,
  opts?: { signer?: Uint8Array },
): Promise<Event> {
  const signer = opts?.signer ?? loadOrCreateVoice().secretKey;
  // `getPublicKey` derives the pubkey from the secret so the `a`-tag address
  // matches the key that signed the target events, even if the caller passed a
  // non-default signer. `loadOrCreateVoice().publicKey` is the same value for
  // the default signer.
  const pubkey = opts?.signer ? getPublicKey(opts.signer) : loadOrCreateVoice().publicKey;

  const readRelays = await getReadRelays();

  // 1. Every kind-4290 node in the folder. `#f` catches every non-genesis node
  //    (file chains + the folder's own non-genesis nodes). The genesis id
  //    equals `folderId` (an event can't know its own id before signing, so it
  //    carries no `f` tag) and is added explicitly.
  const nodes = await queryMany(readRelays, { kinds: [FILE_TRACE_NODE_KIND], "#f": [folderId] });
  const eTags: string[][] = nodes.map((n) => ["e", n.id, ""]);
  if (!eTags.some((t) => t[1] === folderId)) eTags.push(["e", folderId, ""]);

  // 2. Replaceable kinds, deleted by NIP-33 address (`a` tag). TraceHead's `d`
  //    is the folder id; TraceOpinion's `d` is `x:`/`n:` + subject, so sweep by
  //    author + kind and emit one `a` per owned opinion.
  const aTags: string[][] = [["a", `${TRACE_HEAD_KIND}:${pubkey}:${folderId}`]];
  const opinions = await queryMany(readRelays, {
    kinds: [TRACE_OPINION_KIND],
    authors: [pubkey],
  });
  for (const op of opinions) {
    const d = op.tags.find((t) => t[0] === "d")?.[1];
    if (d) aTags.push(["a", `${TRACE_OPINION_KIND}:${pubkey}:${d}`]);
  }

  const template: EventTemplate = {
    kind: 5,
    created_at: Math.floor(Date.now() / 1000),
    tags: [...eTags, ...aTags],
    content: reason,
  };
  const signed = finalizeEvent(template, signer);
  await publishToMany(await getWriteRelays(), signed);
  return signed;
}

/** Revoke a single file's published chain within a folder. Same NIP-09 posture
 *  as `revokeZine` but scoped to one member: gathers the file's chain via
 *  `fetchChain` (the prev-walk, not the whole-folder `#f` sweep) and emits one
 *  `e` tag per node. No `a` tag — a file trace has no replaceable head of its
 *  own (TraceHead is per-folder). */
export async function revokeFile(
  folderId: string,
  relativePath: string,
  reason: string,
  opts?: { signer?: Uint8Array },
): Promise<Event> {
  const signer = opts?.signer ?? loadOrCreateVoice().secretKey;
  const chain = await fetchChain(folderId, relativePath);
  const eTags: string[][] = chain.map((n) => ["e", n.id, ""]);

  const template: EventTemplate = {
    kind: 5,
    created_at: Math.floor(Date.now() / 1000),
    tags: eTags,
    content: reason,
  };
  const signed = finalizeEvent(template, signer);
  await publishToMany(await getWriteRelays(), signed);
  return signed;
}

// --- folder activity (Times view) ---------------------------------------
//
// A read-only aggregation surface: pull every kind-4290 node for a folder
// within an optional time window, then let the caller bucket/count tags
// client-side. Like fetchChain this fans out to every read relay and merges by
// event id, but it does NOT walk the prev-chain — every node counts as its own
// activity sample, which is what the Times graph wants (seal events over time,
// not just current heads).

/** Fetch every FileTraceNode in a folder, optionally bounded to a time window.
 *  `since`/`until` are NIP-01 UNIX-second bounds, passed straight to the
 *  filter. No prev-chain walk — every matching node is returned as its own
 *  sample of activity. */
export async function fetchFolderActivity(
  folderId: string,
  opts: { since?: number; until?: number; limit?: number } = {},
): Promise<Event[]> {
  const relays = await getReadRelays();
  const filter: Filter = {
    kinds: [FILE_TRACE_NODE_KIND],
    "#D": [folderId],
    ...(opts.since != null ? { since: opts.since } : {}),
    ...(opts.until != null ? { until: opts.until } : {}),
    limit: opts.limit ?? 2000,
  };
  // Spec §R11.3: file and folder share kind 4290. Post-filter to file nodes
  // so folder membership events don't appear in the file-activity feed.
  return (await queryMany(relays, filter)).filter((e) =>
    e.tags.some((t) => t[0] === "z" && t[1] === "file"),
  );
}

/** Relay-wide activity: every file-reified trace node the read relays hold,
 *  across all folders. Unlike `fetchFolderActivity`, no `#D` filter — the relay
 *  is treated as the whole database, so Times can show something even with no
 *  folder attached. Each event's folder id is recoverable from its `#D` tag
 *  (see `eventMeta().folderId`). */
export async function fetchRelayActivity(
  opts: { since?: number; until?: number; limit?: number } = {},
): Promise<Event[]> {
  const relays = await getReadRelays();
  const filter: Filter = {
    kinds: [FILE_TRACE_NODE_KIND],
    ...(opts.since != null ? { since: opts.since } : {}),
    ...(opts.until != null ? { until: opts.until } : {}),
    limit: opts.limit ?? 2000,
  };
  // Spec §R11.3: file and folder share kind 4290. Post-filter to file nodes.
  return (await queryMany(relays, filter)).filter((e) =>
    e.tags.some((t) => t[0] === "z" && t[1] === "file"),
  );
}

// --- folder index + folder-level alpha addressing (Listings) --------------
//
// The Listings view needs two things fetchRelayActivity alone doesn't give it:
//   1. An enumeration of every distinct folder on the relay with rolled-up
//      stats per folder (the inbox/kept/cut lists are per-folder).
//   2. A stable addressing key for a *project-as-a-whole*, because TraceAlpha
//      (kind 4293) is keyed on contentHash and a folder has no hash of its
//      own — only its member files do.
//
// `folderHash(folderId)` resolves (2): a synthetic, deterministic contentHash
// for a folder's identity, so an operator's promote/demote opinion lives on
// one stable address per project rather than being scattered across the
// folder's file hashes. publishTraceAlpha / fetchAlphaHeads are contentHash-
// agnostic (they carry/look-up the string opaquely), so this needs no
// protocol change — it's a client convention, documented here.

/** A stable, synthetic contentHash for a folder-as-a-project. Used as the
 *  `contentHash` argument to publishTraceAlpha / fetchAlphaHeads when the
 *  operator is promoting or demoting a whole project, not any single file.
 *  `sha256("folder:" + folderId)` — deterministic across readers, so every
 *  press that tunes the same project addresses the same alpha chain. */
export async function folderHash(folderId: string): Promise<string> {
  return sha256HexLocal(`folder:${folderId}`);
}

/** One folder's rolled-up activity, the unit of the Listings inbox. Built by
 *  `fetchFolderIndex` from a relay-wide scan; never stored, always recomputed.
 *  `topTags` is the most frequent author tags (capped), for display + doctrine
 *  alignment; `authorPubkeys` is the set of distinct seal signers (a liveness
 *  signal — a project worked on by many voices is usually worth keeping). */
export interface FolderIndexEntry {
  folderId: string;
  eventCount: number;
  citationTotal: number;
  /** ms — the most recent seal's sealedAt (falls back to created_at*1000). */
  lastSeenMs: number;
  /** Top author tags by occurrence, capped at 8, most frequent first. */
  topTags: string[];
  authorPubkeys: Set<string>;
}

/** Enumerate every distinct folder the read relays hold, with per-folder
 *  rollups. A relay-wide scan (no `#D` filter) grouped by `eventMeta().folderId`
 *  — the same shape TimesView groups ad-hoc, lifted into a reusable read so
 *  the inbox reads one source of truth. Folders with no `#D` tag (foreign or
 *  malformed events) are skipped, not counted under a synthetic bucket. */
export async function fetchFolderIndex(
  opts: { since?: number; until?: number; limit?: number } = {},
): Promise<Map<string, FolderIndexEntry>> {
  const events = await fetchRelayActivity(opts);
  const byFolder = new Map<string, FolderIndexEntry>();
  const tagCounts = new Map<string, Map<string, number>>(); // folderId -> tag -> count
  for (const event of events) {
    const meta = eventMeta(event);
    if (!meta.folderId) continue;
    let entry = byFolder.get(meta.folderId);
    if (!entry) {
      entry = {
        folderId: meta.folderId,
        eventCount: 0,
        citationTotal: 0,
        lastSeenMs: 0,
        topTags: [],
        authorPubkeys: new Set(),
      };
      byFolder.set(meta.folderId, entry);
      tagCounts.set(meta.folderId, new Map());
    }
    entry.eventCount++;
    entry.citationTotal += meta.citationCount;
    if (meta.sealedAtMs > entry.lastSeenMs) entry.lastSeenMs = meta.sealedAtMs;
    entry.authorPubkeys.add(event.pubkey);
    const counts = tagCounts.get(meta.folderId)!;
    for (const tag of meta.userTags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  // Resolve topTags per folder once, after the pass.
  for (const [folderId, entry] of byFolder) {
    const counts = tagCounts.get(folderId)!;
    entry.topTags = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([tag]) => tag);
  }
  return byFolder;
}

/** The parsed, Times-relevant fields of a kind-4290 event. Centralizes event-
 *  shape knowledge so the view never touches tag arrays or content JSON
 *  directly. `sealedAtMs` falls back to `created_at*1000` when the content
 *  lacks the ms-resolution field (older nodes). `userTags` is every `t` tag —
 *  all topical labels now, since containment is no longer expressed as a `t`.
 *  `citationTargets` is the raw node-id list of every `q` tag, in tag order —
 *  the traces this one composes (bracket quotes, the Reply source, and tagged
 *  zines). Kept parallel to `citationCount` (which Times still uses as a rank
 *  signal) because the display needs the actual ids to resolve each cited
 *  trace's name, not just how many there are. */
export interface EventMeta {
  userTags: string[];
  action?: string;
  relativePath?: string;
  /** The folder this event belongs to, from its `#D` tag. Present on every
   *  folder-scoped kind (manifest, FileTraceNode). Used by Times to group relay-
   *  wide activity by folder when no single folder is attached. */
  folderId?: string;
  /** Reification discriminator from the `z` tag (protocol §3.1): `"file"` or
   *  `"folder"`. Once kinds consolidate this is the only way to tell a file
   *  node from a folder node; undefined on legacy events minted before the tag
   *  was emitted (callers fall back to kind). */
  z?: "file" | "folder";
  citationCount: number;
  /** Every `q` tag's target node id, in declared (tag) order — the traces this
   *  node composes. Mirrors the emission order in `publishEdit`, so the
   *  citation-chip list reads body-quotes first, then Reply source, then
   *  tagged zines. Empty for a leaf. */
  citationTargets: string[];
  sealedAtMs: number;
  createdAtSec: number;
}

export function eventMeta(event: Event): EventMeta {
  const userTags: string[] = [];
  let action: string | undefined;
  let relativePath: string | undefined;
  let folderId: string | undefined;
  let z: "file" | "folder" | undefined;
  let citationCount = 0;
  const citationTargets: string[] = [];
  for (const tag of event.tags) {
    switch (tag[0]) {
      case "t":
        if (typeof tag[1] === "string") userTags.push(tag[1]);
        break;
      case "action":
        if (typeof tag[1] === "string") action = tag[1];
        break;
      case "file":
        if (typeof tag[1] === "string") relativePath = tag[1];
        break;
      case "D":
        if (typeof tag[1] === "string") folderId = tag[1];
        break;
      case "z":
        if (tag[1] === "file" || tag[1] === "folder") z = tag[1];
        break;
      case "q":
        citationCount++;
        if (typeof tag[1] === "string") citationTargets.push(tag[1]);
        break;
    }
  }

  let sealedAtMs = (event.created_at ?? 0) * 1000;
  try {
    const parsed = JSON.parse(event.content) as { sealedAt?: number };
    if (typeof parsed.sealedAt === "number") sealedAtMs = parsed.sealedAt;
  } catch {
    // non-JSON or absent content — fall back to created_at resolution
  }
  return {
    userTags,
    action,
    relativePath,
    folderId,
    z,
    citationCount,
    citationTargets,
    sealedAtMs,
    createdAtSec: event.created_at ?? 0,
  };
}

/** Reads a kind-4290 event's reply citation, if any (spec §3.3: a `cite` delta
 *  with `role: "reply"`) — the sealed node id this document is a reply to,
 *  pinned at the moment the reply was written. Also tolerates the legacy
 *  `type: "reply-to"` shape from events minted before the cite unification.
 *  Returns null for an ordinary edit/import node, a malformed/absent content
 *  body, or when no reply citation is present. Used to render the "replying
 *  to" chip without re-parsing the event's content at every call site. */
export function respondsTo(event: Event): string | null {
  try {
    const parsed = JSON.parse(event.content) as {
      deltas?: Array<{ type?: string; role?: string; sourceEventId?: string }>;
    };
    const entry = parsed.deltas?.find(
      (d) => d.type === "cite" && d.role === "reply",
    );
    return typeof entry?.sourceEventId === "string" ? entry.sourceEventId : null;
  } catch {
    return null;
  }
}

// --- cited-trace name resolution (for the citation-chip row) -------------
//
// A `q` edge points at another trace's nucleus by event id. To render it as a
// chip in the tag row we need that trace's *name*: a named trace (a file) shows
// its relative path's basename; a nameless trace (a minted span) has a
// synthetic `<origin>#<shortId>` path and no real name — its body (the span's
// own text) is its "name" for display (see spec §Named vs nameless traces). The
// same cited trace can appear from many documents, so the resolution is cached
// per node id for the session (mirroring `displayNameCache`).

/** One resolved cited-trace chip. `kind` distinguishes the two reifications so
 *  CSS can render a file name and a span phrase with distinct affordances. */
export interface CitationChip {
  nodeId: string;
  name: string;
  kind: "file" | "span";
}

/** Truncate a span phrase for chip display: collapse to one whitespace run and
 *  cap at `max`, adding an ellipsis. A bare `[[ text ]]` minted into a nameless
 *  trace can be long; the chip needs a short, readable handle. */
function truncatePhrase(text: string, max = 32): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= max) return collapsed;
  return collapsed.slice(0, max - 1).trimEnd() + "…";
}

const nodeNameCache = new Map<string, CitationChip | null>();

/** Resolve a cited node id to a display name + kind, caching for the session.
 *  Fetches the node (once, then cached), reads its `file` tag (`relativePath`)
 *  and its `snapshot` body, and picks the name:
 *    - a file path with no `#` → `{ kind: "file", name: basename }`
 *    - a synthetic span path (`origin#shortId`) or no `file` tag at all →
 *      `{ kind: "span", name: truncated snapshot }` (the phrase itself, per
 *      spec §Named vs nameless traces — for a nameless trace, body-hash is the
 *      addressing scheme and the body is what a reader sees).
 *  Returns null when the node can't be fetched from any read relay (a citation
 *  the source has since deleted, or an offline relay) — the caller renders a
 *  fallback id-abbrev chip rather than blocking the row. */
export async function resolveNodeName(nodeId: string): Promise<CitationChip | null> {
  const cached = nodeNameCache.get(nodeId);
  if (cached !== undefined) return cached;
  const event = await fetchEventById(nodeId);
  if (!event) {
    nodeNameCache.set(nodeId, null);
    return null;
  }
  const meta = eventMeta(event);
  let snapshot = "";
  try {
    const parsed = JSON.parse(event.content) as { snapshot?: unknown };
    if (typeof parsed.snapshot === "string") snapshot = parsed.snapshot;
  } catch {
    // non-JSON content — snapshot stays ""
  }
  const path = meta.relativePath;
  // A synthetic minted-span path is `<originDoc>#<shortId>` (spec §3.8 Minting);
  // a real file path never contains `#` (paths are filesystem-shaped). No `file`
  // tag at all is also a nameless trace (e.g. an older node, or a foreign kind).
  const isNameless = !path || path.includes("#");
  const chip: CitationChip | null = isNameless
    ? { nodeId, name: truncatePhrase(snapshot) || nodeId.slice(0, 8), kind: "span" }
    : { nodeId, name: path.split("/").pop() || path, kind: "file" };
  nodeNameCache.set(nodeId, chip);
  return chip;
}

// --- folder trace nodes (kind 4292) -------------------------------------
//
// A folder is a trace whose body is an ordered membership list — a
// `FolderTraceNode` (kind 4292), non-replaceable, carried on an `e…prev` chain
// exactly like a file. Every node carries its full `snapshot.members`, so
// resolving "what's in this folder now" is one bounded fetch (the uncited head
// of the chain), not a fan-out to members. This is the property SEND, ZINE, and
// (next milestone) forking lean on: a cited folder must be self-contained.
// See protocol/trace-provenance.md §FolderTraceNode.
//
// The public API keeps the old `*Manifest*` names so the three workspace
// backends (workspace.ts, workspace-relay.ts, workspace-local.ts) compile
// unchanged — underneath, they now read/write 4292 chain nodes, not a
// replaceable 34290 manifest.
//
// Backward compatibility: folders published before this migration have a
// kind-34290 manifest and no 4292 chain. `fetchManifest` falls back to that
// legacy event when no 4292 head exists, so pre-existing folders keep reading
// correctly. The first write to such a folder publishes a 4292 genesis whose
// `snapshot.members` is seeded from the 34290 data — a lazy, per-folder,
// on-first-write migration. 34290 events are never rewritten or deleted.

/** The membership body of a folder-trace node — `snapshot.members` on the wire. */
interface FolderSnapshot {
  members: ManifestFileEntry[];
}

/** The selection recorded by a `focus` folder delta (protocol §FolderTraceNode
 *  Content — focus selection payload). Mirrors the protocol's three reifications:
 *  a file, a folder, or a minted span (a quotation living inside a file). */
export type FocusSelection =
  | { kind: "file"; path: string; nodeId?: string }
  | { kind: "folder"; path: string; nodeId?: string }
  | { kind: "span"; nodeId: string; phrase: string; originPath: string };

/** A single change since `prev.snapshot` on a FolderTraceNode (protocol §3.3).
 *  Membership deltas (`add`/`remove`/`rename`) are the three structural facts a
 *  folder asserts about its members: a member appeared, a member left, a member
 *  moved to a new path. There is no `reorder` — ordering is fully recoverable
 *  from `snapshot.members` (the §2 canonical projection *is* the ordered list),
 *  so a dedicated ordering delta would carry no information the snapshot didn't.
 *  `rename` carries `fromPath`/`toPath` so one user gesture is one replayable
 *  event (the pre-rename path decomposed into add+remove, which orphaned the
 *  file's history from its new path). It is the structural path axis —
 *  folder-owned addressing — explicitly distinct from `TraceOpinion`'s display
 *  `name` (§5/§R6), which is author-scoped and deliberately history-less.
 *
 *  `focus` is an observation, not membership: it records panel occupancy
 *  (`op: 'mount'` = a trace entered a panel; `op: 'unmount'` = the trace that
 *  was there left), so a reading session can be replayed in the press editor.
 *  `op` defaults to `'mount'` and MAY be omitted. A `focus` node re-emits the
 *  *same* `snapshot.members` as `prev` — `contentHash` is unaffected, exactly
 *  as a `quote`/`tag-add` delta never alters the file snapshot's text. */
export type FolderDelta =
  | { type: "add" | "remove"; kind?: "file" | "folder"; relativePath: string; nodeId?: string; timestamp: number }
  | { type: "rename"; kind?: "file" | "folder"; fromPath: string; toPath: string; nodeId: string; timestamp: number }
  | { type: "focus"; op?: "mount" | "unmount"; selection: FocusSelection; panelIndex: number; timestamp: number };

/** Fetches every folder-reified trace node for `folderId` across all read
 *  relays, merged by event id. Queries both the new kind-4290-with-`z:folder`
 *  form and the legacy kind-4292 form (spec §R11.3), post-filtering 4290
 *  results to folder-discriminated nodes so file nodes for the same folder
 *  aren't mistaken for folder nodes. Does not resolve the chain — returns the
 *  raw node set for `fetchLatestFolderNode` to head-resolve, and for the
 *  context-block directory log to read every membership event (add/remove). */
export async function fetchFolderNodes(folderId: string): Promise<Event[]> {
  const relays = await getReadRelays();
  // Query by both `#f` (spec §3.1 folder-id mirror) and `#D` (legacy mirror)
  // so nodes keyed either way resolve. Also fetch the genesis node by id
  // directly (Phase 5: it carries no f/D since an event can't know its own id).
  const [byF, byD, byDlegacy, genesis] = await Promise.all([
    queryMany(relays, { kinds: [TRACE_NODE_KIND], "#f": [folderId] }),
    queryMany(relays, { kinds: [TRACE_NODE_KIND], "#D": [folderId] }),
    queryMany(relays, { kinds: [FOLDER_TRACE_NODE_KIND], "#D": [folderId] }),
    queryMany(relays, { ids: [folderId] }),
  ]);
  const byIdMap = new Map<string, Event>();
  for (const e of byF) {
    if (e.tags.some((t) => t[0] === "z" && t[1] === "folder")) byIdMap.set(e.id, e);
  }
  for (const e of byD) {
    if (e.tags.some((t) => t[0] === "z" && t[1] === "folder")) byIdMap.set(e.id, e);
  }
  for (const e of byDlegacy) byIdMap.set(e.id, e);
  for (const e of genesis) {
    if (e.tags.some((t) => t[0] === "z" && t[1] === "folder") || e.kind === FOLDER_TRACE_NODE_KIND) {
      byIdMap.set(e.id, e);
    }
  }
  return [...byIdMap.values()];
}

/** Resolves the latest (uncited-as-prev) folder-trace node for `folderId`, or
 *  null if the folder has no 4292 chain yet. Same head-finding rule as file
 *  chains (`resolveHead`): a node nobody else cites as `prev` is the head. */
export async function fetchLatestFolderNode(folderId: string): Promise<Event | null> {
  const all = await fetchFolderNodes(folderId);
  return resolveHead(all);
}

/** Parses `snapshot.members` out of a kind-4292 event's content. Returns [] on
 *  malformed/empty content. */
export function membersFromNode(event: Event): ManifestFileEntry[] {
  try {
    const parsed = JSON.parse(event.content) as { snapshot?: FolderSnapshot };
    return parsed.snapshot?.members ?? [];
  } catch {
    return [];
  }
}

/** Lazy-migration fallback: read the latest legacy kind-34290 manifest and
 *  reconstruct the member list from its `content.files`. Used only when no 4292
 *  head exists for the folder. Returns [] if no legacy manifest either. */
async function fetchLegacyManifestMembers(folderId: string): Promise<ManifestFileEntry[]> {
  const relays = await getReadRelays();
  const event = await queryLatestMany(relays, { kinds: [FOLDER_MANIFEST_KIND], "#d": [folderId] });
  if (!event) return [];
  try {
    const parsed = JSON.parse(event.content) as { files: ManifestFileEntry[] };
    return parsed.files ?? [];
  } catch {
    return [];
  }
}

/** Reads the current file set for a folder from its latest 4292 node's
 *  `snapshot.members`. Falls back to the legacy 34290 manifest when no 4292
 *  chain exists yet (lazy migration). Empty array for a fresh folder. */
export async function fetchManifest(folderId: string): Promise<ManifestFileEntry[]> {
  const head = await fetchLatestFolderNode(folderId);
  if (head) return membersFromNode(head);
  return fetchLegacyManifestMembers(folderId);
}

// --- folder display name ------------------------------------------------
//
// The protocol has no folder-name primitive: kind-4291 TraceName is keyed by
// contentHashHex (spec §TraceName), not folderId, and nothing writes
// folder-name events. So a folder's display name is resolved in tiers:
//   1. the local `label` the user typed when creating (passed in as
//      `fallbackLabel` by the picker);
//   2. the manifest's first member's filename (relay round-trip, cached);
//   3. the folderId prefix.
// Resolved names are cached per session so the round-trip happens once.

const displayNameCache = new Map<string, string>();

/** Resolve a human-readable name for a folder, for the picker list. Returns
 *  `fallbackLabel` verbatim when it's a real label (not an id-derived prefix),
 *  else the cached/relay-resolved name. Never throws — a failed fetch falls
 *  back to the id prefix so the picker stays usable offline. */
export async function fetchFolderDisplayName(
  folderId: string,
  fallbackLabel?: string,
): Promise<string> {
  // A real local label short-circuits everything.
  if (fallbackLabel && fallbackLabel.trim()) return fallbackLabel;
  const cached = displayNameCache.get(folderId);
  if (cached !== undefined) return cached;
  let resolved = folderId.slice(0, 8);
  try {
    const members = await fetchManifest(folderId);
    const first = members[0]?.relativePath;
    if (first) {
      // Basename only — the path's leaf is the most legible hint. A folder
      // whose first file is "drafts/intro.md" shows as "intro.md".
      const leaf = first.split("/").pop() || first;
      if (leaf) resolved = leaf;
    }
  } catch {
    // Relay unreachable / manifest malformed — keep the id prefix.
  }
  displayNameCache.set(folderId, resolved);
  return resolved;
}

/** Builds and signs (does not publish) a kind-4292 folder-trace node. Mirrors
 *  the FileTraceNode shape: positional `tags[0]` = `["folder", folderId]`,
 *  `D` mirror, one `q` tag per active member in order, `e…prev` to the prior
 *  head (absent on genesis). No `d` tag — 4292 is NOT replaceable; ordering
 *  comes from the chain, so there is no forced-forward `created_at` rule.
 *
 *  Member `q` tags are emitted in the spec's full 4-element form
 *  `["q", nodeId, relayHint?, ownerPubkey?]` when `memberOwners` is provided
 *  (aligned to `members`), so ownership of each cited member is recoverable from
 *  the folder node alone — the property fork relies on (spec:141). When absent
 *  (the normal write path), members emit the bare `["q", nodeId]` form.
 *
 *  `deltas` carries the per-node change set (protocol §3.3): one or more
 *  FolderDelta entries. A node MAY carry several — a structural change (add/
 *  remove/rename) plus N focus observations drained from the buffer on the same
 *  seal (§8). Empty array on genesis/import nodes, in which case the field is
 *  omitted from the content entirely. */
function buildFolderNodeTemplate(
  folderId: string | null,
  members: ManifestFileEntry[],
  prevEventId: string | null,
  action: string,
  deltas: FolderDelta[],
  sealedAt: number,
  opts?: { forkedFrom?: string | null; memberOwners?: string[]; geohashes?: string[] },
): EventTemplate {
  const ownerByPath = opts?.memberOwners;
  const tags: string[][] = [
    // Reification discriminator (protocol §3.1: REQUIRED on every node).
    ["z", "folder"],
  ];
  // Spec §3.1: `f`/`D`/`folder` carry the folder's own genesis id on every node
  // EXCEPT genesis itself — an event can't know its own id before signing.
  // Genesis (folderId null) emits none; its event id becomes the identity every
  // later node references. This matches the harness (store.ts:556) and closes
  // the Phase 5 divergence: new folders adopt the genesis event id as identity.
  if (folderId) {
    tags.push(["folder", folderId], ["f", folderId], ["D", folderId]);
  }
  tags.push(
    ...members.map((m, i) => {
      const owner = ownerByPath?.[i];
      return owner ? (["q", m.latestNodeId, "", owner] as string[]) : (["q", m.latestNodeId] as string[]);
    }),
    ["action", action],
  );
  if (prevEventId) tags.push(["e", prevEventId, "", "prev"]);
  if (opts?.forkedFrom) tags.push(["e", opts.forkedFrom, "", "forked-from"]);
  // Spec §3.1 `g`: an arbitrary-length base-32 geohash the zine is pinned to
  // for Spaces. Length encodes precision; a node MAY carry several pins. The
  // current set is republished on the folder node — re-sealing supersedes
  // (the snapshot rehashes, as any structural change does). Geohashes do NOT
  // enter the canonical body hash (they're curation surface, not content).
  if (opts?.geohashes) {
    for (const h of opts.geohashes) {
      if (h) tags.push(["g", h]);
    }
  }

  const snapshot: FolderSnapshot = { members };
  return {
    // Spec §1/§R11.3: one TraceNode kind. The `z:folder` tag (emitted above)
    // discriminates folder-reified from file-reified nodes.
    kind: TRACE_NODE_KIND,
    created_at: Math.floor(sealedAt / 1000),
    tags,
    content: JSON.stringify({
      sealedAt,
      snapshot,
      ...(deltas.length > 0 ? { deltas } : {}),
      contentHash: "", // filled by caller after hashing the snapshot
    }),
  };
}

/** Hashes a folder snapshot to its contentHash. Body-only — same addressing
 *  axis as a file. Used as the integrity anchor on every 4292 node.
 *
 *  Canonical projection per protocol §2: `[[relativePath, memberContentHash], …]`
 *  in member order, JSON with no insignificant whitespace, `latestNodeId`
 *  excluded so independent content-identical folders hash identically (§R3). */
async function hashFolderSnapshot(members: ManifestFileEntry[]): Promise<string> {
  return sha256HexLocal(canonicalFolderBody(members));
}

/** The canonical folder body projection (protocol §2): the membership as
 *  `[[relativePath, kind, memberContentHash], …]` in member order, serialized
 *  as JSON with no insignificant whitespace. `latestNodeId` is excluded so two
 *  independently built, content-identical folders hash identically (§R3) —
 *  node ids are signed artifacts no two owners share.
 *
 *  Shallow-local Merkle-with-pointer: `kind` defaults to "file" for legacy
 *  members (pre-nesting); a folder member's `contentHash` is its own stored
 *  canonical-body hash, never recomputed here (no chain walk, no recursion,
 *  cycle-safe by construction). Widening the projection from two-tuple to
 *  three-tuple is a breaking change to contentHash/#x clustering — legacy
 *  folders rehash on their next seal; no integrity property is affected. */
function canonicalFolderBody(members: ManifestFileEntry[]): string {
  return JSON.stringify(members.map((m) => [m.relativePath, m.kind ?? "file", m.contentHash]));
}

// --- focus buffer (§R7) -------------------------------------------------
//
// Focus observations never mint their own nodes — they accumulate in this
// per-folder buffer and ride along on the NEXT folder-chain seal (any add/
// remove/rename) as additional `deltas` entries, or on an explicit session-
// close checkpoint (flushFocusCheckpoint). This is the load-bearing §R7
// mechanism: focus fires per click, and a focus node would re-serialize the
// full membership snapshot every time — the exact per-keystroke collapse §R1
// warns makes unconditional snapshots unaffordable. Buffering turns O(clicks)
// nodes into O(seals) deltas. Coalescing per panelIndex (the App.tsx writer
// dedupes against the last published key) keeps the buffer from growing
// unbounded under a flurry of selections.

const focusBuffer = new Map<string, FolderDelta[]>();

/** Append a focus observation to `folderId`'s pending buffer. Called from the
 *  press on selection/panel-mount (mount) and tab/panel close (unmount). Does
 *  not seal — the observation becomes durable when the next folder seal drains
 *  the buffer, or when session close flushes it explicitly. Safe to call before
 *  the folder has any chain; the buffer simply holds until the first seal. */
export function bufferFocus(folderId: string, delta: FolderDelta): void {
  const arr = focusBuffer.get(folderId);
  if (arr) arr.push(delta);
  else focusBuffer.set(folderId, [delta]);
}

/** Take and clear `folderId`'s pending focus buffer. Called by publishFolderNode
 *  so every folder-chain seal flushes whatever focus accumulated since the last
 *  one — the §7/§8 drain-on-seal rule. Returns the deltas in arrival order;
 *  empty array if nothing pending. */
function drainFocusBuffer(folderId: string): FolderDelta[] {
  const arr = focusBuffer.get(folderId);
  if (!arr || arr.length === 0) return [];
  const out = arr.splice(0, arr.length);
  return out;
}

/** Mint an `action: "focus"` node carrying any pending focus deltas for
 *  `folderId`, the §8 session-close checkpoint. No-op when the buffer is empty.
 *  Best-effort: callers (e.g. beforeunload) fire and forget; a relay failure
 *  just means those observations were never recorded — focus is telemetry, not
 *  provenance that gates integrity. Re-emits the current membership verbatim so
 *  `contentHash` is unaffected (same posture as a tag-change node). */
export async function flushFocusCheckpoint(folderId: string): Promise<void> {
  const pending = drainFocusBuffer(folderId);
  if (pending.length === 0) return;
  const previous = await fetchLatestFolderNode(folderId);
  const members = previous ? membersFromNode(previous) : await fetchLegacyManifestMembers(folderId);
  await publishFolderNode(folderId, members, {
    prevEventId: previous?.id ?? null,
    action: "focus",
    deltas: pending,
  });
}

/** Publishes a kind-4292 folder-trace node sealing `members` as the current
 *  snapshot. `prevEventId` null = genesis; otherwise the node chains off the
 *  prior head. `action`/`deltas` describe the change set (or `import` for
 *  genesis). Signs with `signer` or the active voice. Returns the signed event.
 *
 *  **Drains the focus buffer** (§8): any focus observations accumulated since
 *  the last folder seal are appended to `deltas`, so they ride along on a node
 *  that was sealing anyway rather than minting their own. This is the §R7
 *  mechanism — callers never need to flush focus explicitly on the seal path.
 *
 *  `forkedFrom` emits a `forked-from` lineage edge at genesis (see Forking);
 *  `memberOwners` (aligned to `members`) emits 4-element `q` tags carrying each
 *  cited member's owner pubkey, so a forked folder's node records who owns what. */
async function publishFolderNode(
  folderId: string | null,
  members: ManifestFileEntry[],
  opts: {
    prevEventId: string | null;
    action: string;
    deltas?: FolderDelta[];
    signer?: Uint8Array;
    forkedFrom?: string | null;
    memberOwners?: string[];
    geohashes?: string[];
  },
): Promise<Event> {
  const relays = await getWriteRelays();
  const key = opts.signer ?? loadOrCreateVoice().secretKey;
  const sealedAt = Date.now();
  // §8: drain any focus observations buffered since the last folder seal and
  // append them to this node's deltas. The structural delta (if any) stays
  // first so directory-log readers that take deltas[0] still see it.
  // Genesis (folderId null) has no focus buffer — it's the identity-minting
  // node, nothing to drain.
  const allDeltas = [...(opts.deltas ?? []), ...(folderId ? drainFocusBuffer(folderId) : [])];
  const template = buildFolderNodeTemplate(
    folderId,
    members,
    opts.prevEventId,
    opts.action,
    allDeltas,
    sealedAt,
    {
      forkedFrom: opts.forkedFrom ?? null,
      memberOwners: opts.memberOwners,
      geohashes: opts.geohashes,
    },
  );
  // Fill the integrity anchor (hash of the snapshot body) and emit it as the
  // `x` tag (spec §3.1: REQUIRED on folder nodes). `#x` content-identity
  // queries then cluster byte-identical folders across authors — the property
  // the canonical projection (no latestNodeId) was designed to enable (§R3).
  const parsed = JSON.parse(template.content) as { contentHash?: string };
  parsed.contentHash = await hashFolderSnapshot(members);
  template.content = JSON.stringify(parsed);
  template.tags.push(["x", parsed.contentHash!]);

  const signed = finalizeEvent(template, key);
  await publishToMany(relays, signed);
  // Spec §4: also publish a TraceHead (kind 34290) head-pointer cache so the
  // folder's head resolves as one bounded fetch for O(1) consumers. `d` = trace
  // identity. Genesis (folderId null) IS the identity — nothing to point at yet,
  // so no TraceHead (matches the harness at store.ts:588: if (folderId)). The
  // first non-genesis seal caches it.
  if (folderId) {
    await publishTraceHead(folderId, signed.id, key, relays);
  }
  return signed;
}

/** Publishes a kind-34290 TraceHead pointing at a trace's current nucleus.
 *  Spec §4: `d` = trace identity, content `{ head }`, written on every seal.
 *  Reuses the already-connected write relays and the same signer key as the
 *  triggering seal. The legacy manifest read path tolerates these (it checks
 *  for `content.files` and falls through when absent). */
async function publishTraceHead(
  traceIdentity: string,
  headEventId: string,
  signer: Uint8Array,
  relays: Relay[],
): Promise<void> {
  const template: EventTemplate = {
    kind: TRACE_HEAD_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags: [["d", traceIdentity]],
    content: JSON.stringify({ head: headEventId }),
  };
  const signed = finalizeEvent(template, signer);
  await publishToMany(relays, signed);
}

/** Publishes a folder-trace node with the given full membership. Genesis if no
 *  prior head exists, else chained off it with `action: "edit"`. The membership
 *  is taken verbatim — the delta is the caller's responsibility to compute; this
 *  path is used by callers that already have the full next member list (the
 *  three backends' seal/import/delete paths). Kept under the old `publishManifest`
 *  name so those backends compile unchanged. */
export async function publishManifest(
  folderId: string,
  entries: ManifestFileEntry[],
  signer?: Uint8Array,
): Promise<Event> {
  const previous = await fetchLatestFolderNode(folderId);
  // If no 4292 chain exists but a legacy 34290 manifest does, seed the genesis
  // snapshot from it so the chain doesn't lose history on first write.
  const seed = previous ? null : await fetchLegacyManifestMembers(folderId);
  const members = entries.length > 0 || !seed ? entries : seed;
  return publishFolderNode(folderId, members, {
    prevEventId: previous?.id ?? null,
    action: previous ? "edit" : "import",
    signer,
    // Carry the folder's existing geohash pins forward so a routine membership
    // seal (edit/delete/LLM) doesn't silently wipe a prior Spaces pin. Pin
    // updates go through `setFolderGeohashes`, which passes the new set
    // explicitly and overrides this carry-forward.
    geohashes: previous ? geohashesFromNode(previous) : undefined,
  });
}

/** The `["g", geohash]` tags on a folder node, in tag order. Empty array for
 *  nodes with no pins (the common case). */
function geohashesFromNode(event: Event): string[] {
  return event.tags.filter((t) => t[0] === "g" && typeof t[1] === "string").map((t) => t[1] as string);
}

/** Read the folder's current geohash pins from its latest 4292 node. Empty array
 *  if the folder has no chain or no pins. One bounded `#f` fetch — the same
 *  shape `fetchManifest` uses. Spaces reads pins lazily per visible cell rather
 *  than folding this into `fetchFolderIndex` (which scans file nodes only). */
export async function fetchFolderGeohashes(folderId: string): Promise<string[]> {
  const head = await fetchLatestFolderNode(folderId);
  return head ? geohashesFromNode(head) : [];
}

/** Set the folder's geohash pins to `geohashes` exactly, by republishing the
 *  current membership on a new folder node carrying the new `g` tags. The Press
 *  "pin to map" affordance calls this. A no-op when the set is unchanged. */
export async function setFolderGeohashes(folderId: string, geohashes: string[]): Promise<Event | null> {
  const previous = await fetchLatestFolderNode(folderId);
  const members = previous
    ? membersFromNode(previous)
    : await fetchLegacyManifestMembers(folderId);
  const current = previous ? geohashesFromNode(previous) : [];
  const next = Array.from(new Set(geohashes.filter((h) => typeof h === "string" && h.length > 0)));
  // Equal (order-insensitive) → no node needed.
  if (current.length === next.length && current.every((h) => next.includes(h))) return null;
  return publishFolderNode(folderId, members, {
    prevEventId: previous?.id ?? null,
    action: previous ? "edit" : "import",
    geohashes: next,
  });
}

/** One zine pin: the folder and the (length-L) geohash it's pinned to. The
 *  Spaces view plots these as markers at the cell center. */
export interface ZinePin {
  folderId: string;
  geohash: string;
}

/** Find zines pinned to any of `cells` (geohash strings of one length L) by
 *  querying folder nodes (`z:folder`) filtered by `#g`. Head-resolves each
 *  folder so a zine plots once at its CURRENT pin set — a superseded node's
 *  stale pins never show. Returns only pins whose geohash exactly matches one
 *  of the requested cells (no prefix fan-out: the caller already enumerated
 *  the cells covering the viewport at length L). */
export async function fetchPinsByGeohash(cells: string[]): Promise<ZinePin[]> {
  if (cells.length === 0) return [];
  const relays = await getReadRelays();
  const events = await queryMany(relays, { kinds: [TRACE_NODE_KIND], "#g": cells });
  // Bucket by folderId, then head-resolve each folder's chain (a node nobody
  // cites as prev is the head). Only the head's pins are current.
  const byFolder = new Map<string, Event[]>();
  for (const e of events) {
    if (!e.tags.some((t) => t[0] === "z" && t[1] === "folder")) continue;
    const fid = e.tags.find((t) => t[0] === "f")?.[1] ?? e.tags.find((t) => t[0] === "D")?.[1];
    if (!fid) continue;
    let arr = byFolder.get(fid);
    if (!arr) {
      arr = [];
      byFolder.set(fid, arr);
    }
    arr.push(e);
  }
  const cellSet = new Set(cells);
  const pins: ZinePin[] = [];
  for (const [fid, evs] of byFolder) {
    const head = resolveHead(evs);
    if (!head) continue;
    for (const h of geohashesFromNode(head)) {
      if (cellSet.has(h)) pins.push({ folderId: fid, geohash: h });
    }
  }
  return pins;
}

/** Publish a folder genesis node (empty membership, no prev, no `f`/`D`/`folder`
 *  tags — an event can't know its own id before signing) and return its event
 *  id — the folder's permanent identity (spec §3.1: trace identity IS the
 *  genesis node id).
 *
 *  This is the Phase 5 mint, replacing the pre-Phase-5 pattern of minting a
 *  UUID then calling `createEmptyFolder(uuid)`. Callers (attachFolder,
 *  webCreateFolder, forkCurrentFolder) adopt the returned id as `FolderRef.id`.
 *  Legacy UUID-keyed folders keep working unchanged via the `#D` arm of
 *  `fetchFolderNodes`. */
export async function createFolderGenesis(opts?: {
  signer?: Uint8Array;
  forkedFrom?: string | null;
  members?: ManifestFileEntry[];
  memberOwners?: string[];
  action?: string;
}): Promise<string> {
  const event = await publishFolderNode(null, opts?.members ?? [], {
    prevEventId: null,
    action: opts?.action ?? "import",
    signer: opts?.signer,
    forkedFrom: opts?.forkedFrom ?? null,
    memberOwners: opts?.memberOwners,
  });
  return event.id;
}

/** Publish an empty folder-trace genesis for a fresh folderId. Used by the
 *  webapp's "create new folder" path: there's no disk to make a directory on,
 *  so the folder is born as an empty kind-4292 node on the relay. Returns true
 *  if the folder was created, false if a folder-trace node (or legacy manifest)
 *  already exists for this id (caller should attach to the existing one).
 *
 *  Legacy: this is the pre-Phase-5 path — it stamps `folderId` (a UUID) onto
 *  the genesis node's `f`/`D`/`folder` tags, so the folder's identity is the
 *  UUID, not the genesis event id. New callers should use `createFolderGenesis`
 *  instead, which publishes genesis with no identity tags and adopts the event
 *  id as the identity. Kept for backward compatibility with existing UUID-keyed
 *  folders. */
export async function createEmptyFolder(folderId: string): Promise<boolean> {
  const existing = await fetchLatestFolderNode(folderId);
  if (existing) return false;
  // A legacy 34290 manifest also counts as "exists" — don't clobber it with a
  // competing empty genesis.
  const legacy = await fetchLegacyManifestMembers(folderId);
  if (legacy.length > 0) return false;
  await publishFolderNode(folderId, [], {
    prevEventId: null,
    action: "import",
  });
  return true;
}

/** Reads the current membership, replaces the single entry for
 *  `entry.relativePath` (or appends it), and publishes the next 4292 node.
 *  Called from every seal/import path so the folder chain never drifts from
 *  the actual file-chain heads. For deletes, use `removeManifestEntry` —
 *  spec-clean tombstones drop the member rather than tombstoning it. */
export async function upsertManifestEntry(
  folderId: string,
  entry: ManifestFileEntry,
  signer?: Uint8Array,
): Promise<void> {
  const previous = await fetchLatestFolderNode(folderId);
  // Current membership: from the 4292 head if one exists, else from the legacy
  // 34290 manifest (lazy migration seeds the first 4292 node from it).
  const current = previous ? membersFromNode(previous) : await fetchLegacyManifestMembers(folderId);
  const next = current.filter((f) => f.relativePath !== entry.relativePath);
  next.push(entry);
  await publishFolderNode(folderId, next, {
    prevEventId: previous?.id ?? null,
    action: previous ? "edit" : "import",
    deltas: [{ type: "add", relativePath: entry.relativePath, nodeId: entry.latestNodeId, timestamp: Date.now() }],
    signer,
  });
}

/** Removes the member for `relativePath` from the folder snapshot and publishes
 *  the next 4292 node with a `remove` delta. This is the spec-clean tombstone:
 *  the file's own 4290 chain (whose head is now the delete node) retains
 *  history; the folder snapshot just reflects "no longer a member." Used by the
 *  three backends' `markDeleted` helpers. */
export async function removeManifestEntry(
  folderId: string,
  relativePath: string,
  signer?: Uint8Array,
): Promise<void> {
  const previous = await fetchLatestFolderNode(folderId);
  const current = previous ? membersFromNode(previous) : await fetchLegacyManifestMembers(folderId);
  const next = current.filter((f) => f.relativePath !== relativePath);
  await publishFolderNode(folderId, next, {
    prevEventId: previous?.id ?? null,
    action: previous ? "edit" : "import",
    deltas: [{ type: "remove", relativePath, timestamp: Date.now() }],
    signer,
  });
}

/** Renames a member's `relativePath` from `fromPath` to `toPath` and publishes
 *  the next 4292 node with a single `rename` delta — one replayable event for
 *  one user gesture, instead of the pre-rename decomposition into add+remove
 *  (which orphaned the file's history from its new path). The member's
 *  `latestNodeId` and `contentHash` are carried over unchanged: the file's own
 *  4290 chain is untouched, only the folder's addressing of it moves. The new
 *  file node at `toPath` (sealed by the caller before this) is the `nodeId`.
 *  The folder's `contentHash`/`x` DOES change — correct, since the §2 canonical
 *  projection is the ordered `(relativePath, memberContentHash)` list and a path
 *  moved is a different projection. */
export async function renameManifestEntry(
  folderId: string,
  fromPath: string,
  toPath: string,
  nodeId: string,
  signer?: Uint8Array,
): Promise<void> {
  const previous = await fetchLatestFolderNode(folderId);
  const current = previous ? membersFromNode(previous) : await fetchLegacyManifestMembers(folderId);
  // Repoint the renamed member's path; carry over latestNodeId/contentHash.
  // If the member isn't found (e.g. the rename raced with a concurrent remove),
  // fall back to upserting the entry at toPath so the chain stays consistent.
  const existing = current.find((f) => f.relativePath === fromPath);
  let next: ManifestFileEntry[];
  if (existing) {
    // Repoint fromPath → toPath, carrying latestNodeId/contentHash; the caller
    // already sealed the new file node at toPath, so latestNodeId becomes that.
    const renamed: ManifestFileEntry = { ...existing, relativePath: toPath, latestNodeId: nodeId };
    next = current
      .filter((f) => f.relativePath !== fromPath && f.relativePath !== toPath)
      .concat(renamed);
  } else {
    // Member not found (rename raced a concurrent remove): upsert at toPath so
    // the chain stays consistent rather than dropping the rename entirely.
    next = current
      .filter((f) => f.relativePath !== toPath)
      .concat({ relativePath: toPath, latestNodeId: nodeId, contentHash: "" });
  }
  await publishFolderNode(folderId, next, {
    prevEventId: previous?.id ?? null,
    action: previous ? "edit" : "import",
    // Carry the member's kind onto the rename delta (spec §3.3 — kind mirrors
    // the member entry). Absent on legacy members, defaulting to "file".
    deltas: [{ type: "rename", kind: existing?.kind, fromPath, toPath, nodeId, timestamp: Date.now() }],
    signer,
  });
}

// --- focus deltas (action: focus) ---------------------------------------
//
// Focus is panel-occupancy telemetry (§3.3): it records what trace was in which
// panel, so a reading session can be replayed in the press editor. The WRITE
// path never mints its own node — focus observations go through bufferFocus
// (above) and ride along on the next folder-chain seal as additional `deltas`
// entries, or on an explicit session-close checkpoint (flushFocusCheckpoint).
// This is §R7: focus fires per click, and a per-click focus node would
// re-serialize the full membership snapshot every time — the exact per-keystroke
// collapse §R1 warns against.
//
// A focus node therefore exists on the chain only as the session-close flush
// (when nothing else sealed while focus was pending), OR carrying it as extra
// deltas on a real seal. Either way it re-emits `snapshot.members` verbatim —
// `contentHash` and `q` edges are byte-identical to the prior head. A
// genesis-with-focus (a brand-new folder opened before any file is added) is
// allowed: members = [], action stays "focus". Rare, but valid.

/** One replayable focus event on the folder's 4292 chain. `sealedAt` is the
 *  node's content-level ms timestamp (chain order, never `created_at`); the
 *  op/selection/panelIndex fields come straight off the focus delta. `op` is
 *  `"mount"` when present, `"unmount"` for the panel-empties case, and undefined
 *  for older focus deltas written before `op` existed (treat as mount). */
export interface FocusEntry {
  sealedAt: number;
  op?: "mount" | "unmount";
  selection: FocusSelection;
  panelIndex: number;
}

/** The folder's kind-4292 focus chain, oldest-first — every `focus` delta the
 *  folder has emitted, in chain order. This is the replay script: walking it
 *  reconstructs what trace was mounted into which panel over the folder's
 *  lifetime. Non-focus nodes (membership changes, genesis) are skipped, but a
 *  node that carries BOTH a membership delta and flushed focus deltas yields one
 *  FocusEntry per focus delta — readers iterate the `deltas` array, not `[0]`.
 *  A folder written before focus deltas existed returns []. */
export async function focusTimeline(folderId: string): Promise<FocusEntry[]> {
  const all = await fetchFolderNodes(folderId);
  // Walk the `e...prev` chain oldest-first — same rule as fetchChain (never
  // trust created_at; order comes from the chain). A folder with no 4292
  // chain yet yields [].
  const byId = new Map(all.map((e) => [e.id, e]));
  const head = resolveHead(all);
  if (!head) return [];
  const chain: Event[] = [];
  let cursor: string | undefined = head.id;
  const guard = new Set<string>();
  while (cursor && !guard.has(cursor)) {
    guard.add(cursor);
    const event = byId.get(cursor);
    if (!event) break;
    chain.push(event);
    cursor = event.tags.find((t) => t[0] === "e" && t[3] === "prev")?.[1];
  }
  chain.reverse();

  const out: FocusEntry[] = [];
  for (const event of chain) {
    try {
      const content = JSON.parse(event.content) as {
        sealedAt: number;
        deltas?: FolderDelta[];
      };
      // §8: a node MAY carry several deltas (one structural + N flushed focus).
      // Iterate, push one FocusEntry per focus delta — order preserved.
      if (!content.deltas) continue;
      for (const delta of content.deltas) {
        if (delta.type !== "focus") continue;
        out.push({
          sealedAt: content.sealedAt,
          op: delta.op,
          selection: delta.selection,
          panelIndex: delta.panelIndex,
        });
      }
    } catch {
      continue;
    }
  }
  return out;
}

// --- orchestration timeline (folder-level replay) -----------------------
//
// The merged folder-orchestration view: every delta on the folder chain
// (membership add/remove/rename + focus mount/unmount) as one chronological
// stream, for the replay UI that reconstructs not just file actions but the
// orchestration of files at the folder level — which traces entered/left, which
// were renamed, which were mounted in which panel. Built by walking the same
// chain as focusTimeline/folderTimeline but emitting one entry PER DELTA rather
// than per node (a node may carry one structural + N flushed focus deltas).

/** One folder-chain delta as an orchestration event. `sealedAt` is the node's
 *  content-level ms timestamp; `action` is the node-level advisory action
 *  (always `"focus"` for a focus-only node, `"edit"`/`"import"` otherwise); the
 *  `delta` payload is the individual FolderDelta this entry represents. */
export interface FolderTimelineEntry {
  sealedAt: number;
  action: string;
  delta: FolderDelta;
}

/** The folder's full chain as one delta-per-entry timeline, oldest-first.
 *  Genesis/import nodes with no delta are dropped — they carry no orchestration
 *  signal. A node with multiple deltas (structural + N flushed focus) yields one
 *  entry per delta, in array order (structural first, then focus in arrival
 *  order). This is the reader the orchestration-replay UI consumes. */
export async function folderTimelineWithDeltas(folderId: string): Promise<FolderTimelineEntry[]> {
  const all = await fetchFolderNodes(folderId);
  const byId = new Map(all.map((e) => [e.id, e]));
  const head = resolveHead(all);
  if (!head) return [];
  const chain: Event[] = [];
  let cursor: string | undefined = head.id;
  const guard = new Set<string>();
  while (cursor && !guard.has(cursor)) {
    guard.add(cursor);
    const event = byId.get(cursor);
    if (!event) break;
    chain.push(event);
    cursor = event.tags.find((t) => t[0] === "e" && t[3] === "prev")?.[1];
  }
  chain.reverse();

  const out: FolderTimelineEntry[] = [];
  for (const event of chain) {
    try {
      const content = JSON.parse(event.content) as { sealedAt: number; deltas?: FolderDelta[] };
      const action = event.tags.find((t) => t[0] === "action")?.[1] ?? "import";
      if (!content.deltas) continue;
      for (const delta of content.deltas) {
        out.push({ sealedAt: content.sealedAt, action, delta });
      }
    } catch {
      continue;
    }
  }
  return out;
}

/** The merged orchestration timeline: every folder-chain delta interleaved with
 *  nothing else (focus deltas are already in the chain's `deltas` arrays, so
 *  this is just folderTimelineWithDeltas — kept as a named entry point so the
 *  replay UI has a single fetch call that reads as "the orchestration stream").
 *  Stable order by sealedAt then array position; ties keep chain order. */
export async function fetchOrchestrationTimeline(folderId: string): Promise<FolderTimelineEntry[]> {
  return folderTimelineWithDeltas(folderId);
}

// --- forking (action: fork) ---------------------------------------------
//
// Opening a folder owned by someone else: a shallow fork seeds a new folder
// under the user's key, citing the source's members (not copying them). Editing
// a cited (foreign) member triggers fork-on-write: a new file trace seeded from
// the source member's snapshot, under the user's key. This is the "quote that
// isn't preserved but is still a quote" — lineage recorded, ongoing link
// severed. See protocol/trace-provenance.md §Forking.
//
// The signer plumbing is already threaded through publishFolderNode/
// publishEdit; these primitives add only the fork-specific tags (`forked-from`,
// `action: fork`) and the member-owner `q` tags.

/** Fetch a single event by id across all read relays. Returns the first match
 *  (events are content-addressable — same id = same event). Used for ownership
 *  checks (a member's owner is its latest node's signer) without walking a full
 *  chain. Returns null if no relay has it. */
export async function fetchEventById(nodeId: string): Promise<Event | null> {
  const relays = await getReadRelays();
  const filter: Filter = { ids: [nodeId] };
  for (const relay of relays) {
    try {
      const events = await withTimeout(queryOnce(relay, filter), 4000, `fetchById ${nodeId}`);
      if (events.length > 0) return events[0];
    } catch {
      // best-effort — try the next relay
    }
  }
  return null;
}

/** Returns the owner (signer pubkey) of a node, or null if the node can't be
 *  fetched from any read relay. This is the ownership test: a member is "mine"
 *  iff its latestNodeId resolves to an event signed by the active voice. */
export async function fetchNodeOwner(nodeId: string): Promise<string | null> {
  const event = await fetchEventById(nodeId);
  return event?.pubkey ?? null;
}

/** Returns the owner (signer pubkey) of a folder — the signer of its latest
 *  4292 head. This is the folder-level ownership test: a folder is "foreign"
 *  iff its head's signer isn't the active voice. Returns null if the folder
 *  has no 4292 chain (a fresh/local-only folder — not foreign). */
export async function fetchFolderOwner(folderId: string): Promise<string | null> {
  const head = await fetchLatestFolderNode(folderId);
  return head?.pubkey ?? null;
}

/** Seeds a shallow folder fork under the user's key. Reads the source folder's
 *  latest 4292 node (or legacy 34290 manifest as a fallback), mints a new
 *  `destFolderId`, and publishes a 4292 genesis: `action: "fork"`,
 *  `forked-from` the source node, `snapshot.members` copied verbatim from the
 *  source (each member still points at the source owner's node — a citation,
 *  not a copy), member `q` tags carrying the source owner's pubkey so ownership
 *  is recoverable from the fork node alone. Returns the genesis event.
 *
 *  The caller mints `destFolderId` (via newFolderId) so this module stays free
 *  of a folders.ts dependency. */
export async function forkFolder(
  sourceFolderId: string,
  destFolderId: string | null,
  opts?: { signer?: Uint8Array },
): Promise<Event> {
  const sourceNode = await fetchLatestFolderNode(sourceFolderId);
  let members: ManifestFileEntry[];
  let forkedFrom: string;
  let sourceOwner: string | null;

  if (sourceNode) {
    members = membersFromNode(sourceNode);
    forkedFrom = sourceNode.id;
    sourceOwner = sourceNode.pubkey;
  } else {
    // Legacy 34290 fallback: reconstruct members from the replaceable manifest.
    // The forked-from points at the 34290 event id (best available lineage).
    const relays = await getReadRelays();
    const legacy = await queryLatestMany(relays, { kinds: [FOLDER_MANIFEST_KIND], "#d": [sourceFolderId] });
    if (!legacy) {
      throw new Error(
        `Cannot fork folder ${sourceFolderId}: no 4292 chain or 34290 manifest found on any read relay.`,
      );
    }
    const parsed = JSON.parse(legacy.content) as { files: ManifestFileEntry[] };
    members = parsed.files ?? [];
    forkedFrom = legacy.id;
    sourceOwner = legacy.pubkey;
  }

  // One owner for all initially-cited members (the source folder's signer).
  // A forked folder's membership may later mix owners (after fork-on-write),
  // but at genesis every member is the source owner's.
  const memberOwners = sourceOwner ? members.map(() => sourceOwner!) : undefined;

  return publishFolderNode(destFolderId, members, {
    prevEventId: null, // genesis under a new owner — a fresh chain
    action: "fork",
    forkedFrom,
    memberOwners,
    signer: opts?.signer,
  });
}

/** Fork-on-write: seeds a new file trace under the user's key from a source
 *  member's current node. The fork's genesis carries `action: "fork"`,
 *  `forked-from` the source node, `snapshot` = the source snapshot verbatim,
 *  `contentHash` = the source contentHash (same body → same hash → correct
 *  content-hash clustering per spec §Content-hash clustering). The fork is a
 *  genesis under a new owner — `prevEventId: null` — its history begins here,
 *  not replayed from the source (spec: "seeds from body, not history").
 *
 *  Returns the signed genesis event; `event.id` is the new file trace's head.
 *  The caller repoints the folder membership at it via upsertManifestEntry. */
export async function forkFile(
  sourceFolderId: string,
  relativePath: string,
  destFolderId: string,
  opts?: { signer?: Uint8Array },
): Promise<Event> {
  const sourceNodeId = await fetchLatestEventId(sourceFolderId, relativePath);
  if (!sourceNodeId) {
    throw new Error(
      `Cannot fork file ${relativePath} from folder ${sourceFolderId}: no trace node found.`,
    );
  }
  const sourceEvent = await fetchEventById(sourceNodeId);
  if (!sourceEvent) {
    throw new Error(`Cannot fork file ${relativePath}: source node ${sourceNodeId} not fetchable.`);
  }
  const parsed = JSON.parse(sourceEvent.content) as {
    snapshot?: string;
    contentHash?: string;
  };
  const snapshot = typeof parsed.snapshot === "string" ? parsed.snapshot : "";
  const contentHash = parsed.contentHash ?? (await sha256HexLocal(snapshot));

  return publishEdit({
    prevEventId: null, // genesis under a new owner
    relativePath,
    folderId: destFolderId,
    deltas: [],
    snapshot,
    contentHash,
    action: "fork",
    summary: `forked from ${sourceNodeId.slice(0, 8)}`,
    signer: opts?.signer,
    forkedFrom: sourceNodeId,
  });
}

// --- merging (action: merge) --------------------------------------------
//
// Spec §3.8 Merging: unilateral acceptance by the owner of the *receiving*
// chain. One regular 4290 with `prev` (continuity) + one or more
// `merge-parent` edges (foreign heads being pulled in). Parent chains
// persist; selective acceptance is the ordinary snapshot. No co-sign, no
// notify. Endorsement is a separate optional speech act if ever shipped.
//
// The common no-conflict path: fork advanced, source did not →
// `snapshot = parent.snapshot`, authors = one run attributed to the parent
// signer with `src` = parent node id (verifies one merge-parent edge away).

/** Build the default `authors` map for a merge that adopts a parent
 *  snapshot wholesale (or any snapshot whose body is entirely that parent's
 *  contribution). One run: parent pubkey + full text + `src` = parent node
 *  id — the clean §3.6 seam case. Callers with selective acceptance pass
 *  their own multi-run map instead. */
export function authorsFromMergeParent(parentPubkey: string, parentNodeId: string, snapshot: string): Run[] {
  if (snapshot.length === 0) return [];
  return [{ voice: parentPubkey, text: snapshot, src: parentNodeId }];
}

/**
 * Unilateral merge of one or more foreign file-trace heads into *this*
 * file's chain (protocol §3.8 Merging).
 *
 * - Signed by the receiving chain's owner (`signer` / active voice).
 * - `prevEventId` is this chain's current head (required — merge is not genesis).
 * - `mergeParentIds` are the foreign node ids being accepted (fork heads, etc.).
 * - `snapshot` defaults to the first parent's snapshot (no-conflict adopt).
 *   Pass an explicit reconciled body for selective acceptance.
 * - `authors` defaults to a single parent-attributed run with `src` when the
 *   adopted snapshot equals the first parent's body; otherwise omit or pass
 *   a caller-built map.
 *
 * Returns the signed merge node. Parent chains are not modified.
 */
export async function mergeFile(input: {
  folderId: string;
  relativePath: string;
  /** This chain's current head — the node the merge extends. */
  prevEventId: string;
  /** Foreign heads being accepted (at least one). */
  mergeParentIds: string[];
  /** Reconciled body. Defaults to first parent's snapshot. */
  snapshot?: string;
  /** Per-character attribution. Defaults when snapshot equals first parent. */
  authors?: Run[];
  summary?: string | null;
  signer?: Uint8Array;
}): Promise<Event> {
  if (!input.prevEventId) {
    throw new Error("mergeFile requires prevEventId — merge extends an existing chain, it is not genesis.");
  }
  if (!input.mergeParentIds?.length) {
    throw new Error("mergeFile requires at least one mergeParentId.");
  }

  const prevEvent = await fetchEventById(input.prevEventId);
  if (!prevEvent) {
    throw new Error(`mergeFile: prev node ${input.prevEventId} not fetchable on any read relay.`);
  }
  const prevParsed = JSON.parse(prevEvent.content) as { snapshot?: string };
  const prevSnapshot = typeof prevParsed.snapshot === "string" ? prevParsed.snapshot : "";

  const parentId = input.mergeParentIds[0];
  const parentEvent = await fetchEventById(parentId);
  if (!parentEvent) {
    throw new Error(`mergeFile: merge-parent ${parentId} not fetchable on any read relay.`);
  }
  const parentParsed = JSON.parse(parentEvent.content) as { snapshot?: string };
  const parentSnapshot = typeof parentParsed.snapshot === "string" ? parentParsed.snapshot : "";

  const snapshot = input.snapshot ?? parentSnapshot;
  const contentHash = await sha256HexLocal(snapshot);
  const deltas = diffToDeltas(prevSnapshot, snapshot);

  // Default authors: full adopt of first parent → one verified-attributed run.
  // Selective/custom bodies leave authors to the caller (or signer-only).
  let authors = input.authors;
  if (authors === undefined && snapshot === parentSnapshot && snapshot.length > 0) {
    authors = authorsFromMergeParent(parentEvent.pubkey, parentEvent.id, snapshot);
  }

  return publishEdit({
    prevEventId: input.prevEventId,
    relativePath: input.relativePath,
    folderId: input.folderId,
    deltas,
    snapshot,
    contentHash,
    action: "merge",
    summary: input.summary ?? `merged ${parentId.slice(0, 8)}`,
    authors,
    mergeParents: input.mergeParentIds,
    signer: input.signer,
  });
}

// --- palette (kind 34291 = TraceOpinion) ---------------------------------
//
// The palette is the user's curated set of minted spans — the "module of
// trace-nodes" the protocol flags as an open question (spec §OQ). Each item
// points at a minted kind-4290 node by id and caches its text for display;
// the node itself (with its own snapshot) is the source of truth.
//
// Per spec §1/§5, kind 34291 is TraceOpinion — a parameterized-replaceable,
// per-author opinion. The palette rides on this kind as a client convention:
// `d = pubkey` keys the whole curated set as one replaceable index per author.
// This is the same PR-as-index posture the spec endorses for mutable
// current-state (§R2): the palette is not immutable history, so replaceable
// semantics are correct. (Alpha opinions use the same kind with `d = "x:…"`.)

const TRACE_OPINION_KIND = 34291;

/** One entry in a voice's palette. `text` is a cache of the minted span's
 *  inner content for display; the authoritative content is the referenced
 *  node's snapshot. `label` is an optional user-authored display name set by
 *  "rename tag" in the panel — it lives only on the palette index, never on
 *  the minted node, so the snapshot body stays fixed. */
export interface PaletteItem {
  nodeId: string;
  text: string;
  originPath: string;
  mintedAt: number;
  label?: string;
}

/** Read the current palette for the active voice. Empty if none published. */
export async function fetchPalette(): Promise<PaletteItem[]> {
  const relays = await getReadRelays();
  const voice = loadOrCreateVoice();
  const event = await queryLatestMany(relays, { kinds: [TRACE_OPINION_KIND], "#d": [voice.publicKey] });
  if (!event) return [];
  const parsed = JSON.parse(event.content) as { items: PaletteItem[] };
  return parsed.items ?? [];
}

/** Publish a fresh palette (replaces the whole list). Applies the same
 *  forced-forward `created_at` rule as the manifest (spec:112) — two appends
 *  in the same wall-clock second must still order deterministically. */
export async function publishPalette(items: PaletteItem[]): Promise<Event> {
  const relays = await getWriteRelays();
  const voice = loadOrCreateVoice();
  const previous = await fetchPaletteEvent(voice.publicKey);
  const createdAt = Math.max(Math.floor(Date.now() / 1000), (previous?.created_at ?? 0) + 1);

  const template: EventTemplate = {
    kind: TRACE_OPINION_KIND,
    created_at: createdAt,
    tags: [["d", voice.publicKey], ...items.map((i) => ["e", i.nodeId])],
    content: JSON.stringify({ items }),
  };
  const signed = finalizeEvent(template, voice.secretKey);
  await publishToMany(relays, signed);
  return signed;
}

async function fetchPaletteEvent(pubkey: string): Promise<Event | null> {
  const relays = await getReadRelays();
  return queryLatestMany(relays, { kinds: [TRACE_OPINION_KIND], "#d": [pubkey] });
}

/** Append `item` to the palette (deduped by nodeId). Called from the minting
 *  pass — every resolved bracket lands here — so minting = palette add. */
export async function appendToPalette(item: PaletteItem): Promise<void> {
  const current = await fetchPalette();
  if (current.some((i) => i.nodeId === item.nodeId)) return; // idempotent
  await publishPalette([...current, item]);
}

/** Remove the item with `nodeId` from the palette. The minted node itself is
 *  untouched (it's immutable) — only the curated reference is dropped. */
export async function removeFromPalette(nodeId: string): Promise<void> {
  const current = await fetchPalette();
  await publishPalette(current.filter((i) => i.nodeId !== nodeId));
}

/** Rename the palette entry for `nodeId` by publishing a fresh kind-34291
 *  event with the item's `label` updated — the "rename tag = a new tag event"
 *  posture, since the palette is NIP-33 replaceable-as-a-whole. The minted
 *  node and its cached `text`/`originPath` are never touched, so the body
 *  stays fixed. An empty `label` clears the field (back to unlabeled). */
export async function renameInPalette(nodeId: string, label: string): Promise<void> {
  const current = await fetchPalette();
  const trimmed = label.trim();
  const next = current.map((i) =>
    i.nodeId === nodeId
      ? trimmed
        ? { ...i, label: trimmed }
        : { ...i, label: undefined }
      : i,
  );
  await publishPalette(next);
}

// --- alpha (kind 4293) ---------------------------------------------------
//
// A trace's alpha is a signed, per-author opinion of that body's visibility —
// the lever an operator (anyone running a press) tunes to make a body more
// likely to surface in a relevant sample (say, a sample of traces bearing an
// intersecting tag). It is an exact sibling of TraceName (kind 4291): same
// chain shape, same (pubkey, contentHash) key, same non-replaceable posture.
// See protocol/trace-provenance.md §TraceAlpha.
//
// The wire format carries only the opinion. How a reader turns the set of
// per-author alpha heads into a single weight is client policy — `effectiveAlpha`
// below is one reasonable default (author + curator + operator opinions summed
// with the reader's own weighting), not a protocol rule. The relay stays a dumb
// pipe: "operator-as-chief-curator" means an operator running their own press
// under a known pubkey and signing alpha events like any other author.

/** Build, sign, and publish a TraceOpinion (kind 34291) carrying an `alpha`
 *  visibility weight for a body. Spec §5: one replaceable event per
 *  `(pubkey, subject)`, `d = "x:" + contentHash` (the immutable-body axis),
 *  content `{ alpha }`, last-write-wins. The `prevEventId` parameter is
 *  accepted for caller compatibility but ignored — TraceOpinion is
 *  replaceable, so "current" is the latest `created_at`, not a prev-chain.
 *  (Pre-spec code used a non-replaceable kind-4293 chain; readers still query
 *  that as a legacy fallback — see `fetchAlphaHeads`.) */
export async function publishTraceAlpha(input: {
  contentHash: string;
  alpha: number;
  prevEventId?: string | null;
  signer?: Uint8Array;
}): Promise<Event> {
  const relays = await getWriteRelays();
  const signer = input.signer ?? loadOrCreateVoice().secretKey;
  const sealedAt = Date.now();

  const template: EventTemplate = {
    kind: TRACE_OPINION_KIND,
    created_at: Math.floor(sealedAt / 1000),
    tags: [["d", `x:${input.contentHash}`]],
    content: JSON.stringify({ alpha: input.alpha, sealedAt }),
  };

  const signed = finalizeEvent(template, signer);
  await publishToMany(relays, signed);
  return signed;
}

/** All uncited heads in a prev-graph: events whose id no other event in the
 *  set cites as `prev`. Zero → empty set; one → linear chain; two+ → concurrent
 *  branches (protocol open question: branch detection). Pure — used by
 *  `resolveHead`, `findMergeCandidates`, and tests. */
export function listUncitedHeads(events: Event[]): Event[] {
  if (events.length === 0) return [];
  const citedAsPrev = new Set<string>();
  for (const e of events) {
    const prevTag = e.tags.find((t) => t[0] === "e" && t[3] === "prev");
    if (prevTag) citedAsPrev.add(prevTag[1]);
  }
  return events.filter((e) => !citedAsPrev.has(e.id));
}

/** Resolve the uncited head of a prev-chain: the event whose id no other event
 *  in the set cites as `prev`. Shared by `fetchChain` (4290) and `fetchAlphaHeads`
 *  (4293); the same rule the spec states for file-trace, folder-trace, TraceName,
 *  and TraceAlpha heads (protocol §Open questions). Returns null on an empty
 *  set. Multiple uncited heads (a concurrent-write fork) are left to the caller
 *  — the protocol carries head disambiguation as an open question and we resolve
 *  no tie-break here beyond taking the first. */
function resolveHead(events: Event[]): Event | null {
  return listUncitedHeads(events)[0] ?? null;
}

// --- branch detection + merge candidates (§3.8 / open questions) --------

/** A foreign (or sibling) head the owner of `our` chain may unilaterally
 *  incorporate via `mergeFile`. Detected by:
 *  - **incoming-fork**: genesis with `forked-from` pointing at a node on our
 *    file's chain (someone forked our work); head is that fork's current tip.
 *  - **sibling-head**: another uncited head under our own (folder, path) —
 *    multi-device concurrent split on the same identity.
 *
 *  `noConflict` is true only for the clean path: our current head is still
 *  the fork point (we did not edit after they forked). Sibling heads are
 *  never noConflict — both sides advanced. */
export interface MergeCandidate {
  kind: "incoming-fork" | "sibling-head";
  /** Foreign (or sibling) tip to pass as merge-parent. */
  headId: string;
  head: Event;
  /** Our node they forked from (incoming-fork only). */
  forkedFromId: string | null;
  ownerPubkey: string;
  relativePath: string;
  /** Folder id of the candidate chain (theirs for forks; ours for siblings). */
  sourceFolderId: string;
  snapshot: string;
  /** True → safe full-adopt via mergeFile without three-way UI. */
  noConflict: boolean;
}

function fileTag(e: Event, name: string): string | undefined {
  return e.tags.find((t) => t[0] === name)?.[1];
}

function isFileNode(e: Event): boolean {
  const z = fileTag(e, "z");
  // Legacy pre-`z` file nodes: kind 4290 without z:folder counts as file.
  return z !== "folder";
}

function snapshotOf(e: Event): string {
  try {
    const parsed = JSON.parse(e.content) as { snapshot?: unknown };
    return typeof parsed.snapshot === "string" ? parsed.snapshot : "";
  } catch {
    return "";
  }
}

/** True when our head is still the fork point — no concurrent edit on our
 *  side since they forked. Pure helper for tests + candidate classification. */
export function isNoConflictMerge(ourHeadId: string | null, forkedFromId: string | null): boolean {
  return ourHeadId != null && forkedFromId != null && ourHeadId === forkedFromId;
}

/** Batch `#e` queries so large chains don't blow filter size limits. */
async function queryReferencing(nodeIds: string[]): Promise<Event[]> {
  if (nodeIds.length === 0) return [];
  const relays = await getReadRelays();
  const chunkSize = 40;
  const byId = new Map<string, Event>();
  for (let i = 0; i < nodeIds.length; i += chunkSize) {
    const chunk = nodeIds.slice(i, i + chunkSize);
    const hits = await queryMany(relays, {
      kinds: [FILE_TRACE_NODE_KIND, FOLDER_TRACE_NODE_KIND],
      "#e": chunk,
    });
    for (const e of hits) byId.set(e.id, e);
  }
  return [...byId.values()];
}

/**
 * Branch detection for one file: sibling uncited heads on our chain, plus
 * incoming forks (geneses with `forked-from` → one of our nodes).
 *
 * Pure detection — does not merge. The press calls this to surface candidates
 * and only auto-offers Incorporate on `noConflict` ones (spec: three-way UI
 * still deferred for the conflict case).
 */
export async function findMergeCandidates(
  folderId: string,
  relativePath: string,
): Promise<MergeCandidate[]> {
  const relays = await getReadRelays();
  const oursRaw = await queryMany(relays, {
    kinds: [FILE_TRACE_NODE_KIND],
    "#F": [relativePath],
    "#D": [folderId],
  });
  const ours = oursRaw.filter(isFileNode);
  const ourIds = new Set(ours.map((e) => e.id));
  const ourHeads = listUncitedHeads(ours);
  // Prefer TraceHead cache when present; else first uncited (resolveHead).
  const mainHead = resolveHead(ours);
  const ourHeadId = mainHead?.id ?? null;

  const out: MergeCandidate[] = [];
  const seenHeads = new Set<string>();

  // Sibling heads under the same folder+path (multi-device concurrent split).
  for (const h of ourHeads) {
    if (h.id === ourHeadId) continue;
    if (seenHeads.has(h.id)) continue;
    seenHeads.add(h.id);
    out.push({
      kind: "sibling-head",
      headId: h.id,
      head: h,
      forkedFromId: null,
      ownerPubkey: h.pubkey,
      relativePath,
      sourceFolderId: folderId,
      snapshot: snapshotOf(h),
      noConflict: false,
    });
  }

  // Incoming forks: any event that cites one of our nodes as forked-from.
  const refs = await queryReferencing([...ourIds]);
  const geneses: { genesis: Event; forkedFromId: string }[] = [];
  for (const e of refs) {
    if (!isFileNode(e)) continue;
    // Only count genesis-shaped nodes (no prev) with forked-from → our chain.
    const hasPrev = e.tags.some((t) => t[0] === "e" && t[3] === "prev");
    if (hasPrev) continue;
    const ff = e.tags.find((t) => t[0] === "e" && t[3] === "forked-from");
    if (!ff || !ourIds.has(ff[1])) continue;
    // Skip self-forks (our own re-seed) — not an incoming proposal.
    if (mainHead && e.pubkey === mainHead.pubkey) continue;
    geneses.push({ genesis: e, forkedFromId: ff[1] });
  }

  for (const { genesis, forkedFromId } of geneses) {
    const theirFolder =
      fileTag(genesis, "D") ?? fileTag(genesis, "f") ?? fileTag(genesis, "folder");
    const theirPath = fileTag(genesis, "F") ?? fileTag(genesis, "file") ?? relativePath;
    if (!theirFolder) continue;

    let theirHead = genesis;
    try {
      const theirChain = await fetchChain(theirFolder, theirPath);
      if (theirChain.length > 0) theirHead = theirChain[theirChain.length - 1];
    } catch {
      // Fall back to genesis if their chain is unreadable.
    }
    if (seenHeads.has(theirHead.id)) continue;
    // Don't list a head that's already on our chain (already merged / same node).
    if (ourIds.has(theirHead.id)) continue;
    seenHeads.add(theirHead.id);

    out.push({
      kind: "incoming-fork",
      headId: theirHead.id,
      head: theirHead,
      forkedFromId,
      ownerPubkey: theirHead.pubkey,
      relativePath: theirPath,
      sourceFolderId: theirFolder,
      snapshot: snapshotOf(theirHead),
      noConflict: isNoConflictMerge(ourHeadId, forkedFromId),
    });
  }

  return out;
}

/** Batch `#q` queries so large chains don't blow filter size limits. Mirror of
 *  `queryReferencing` but for the composition edge (`q`), used to find traces
 *  that *cite* or *tag* one of `nodeIds` — the inbound fan-in direction. A
 *  citation/tag pins a nucleus (a specific node version, spec §3.3/§6), so the
 *  caller passes every id on the subject trace's chain, not just the head. */
async function queryReferencingByQ(nodeIds: string[]): Promise<Event[]> {
  if (nodeIds.length === 0) return [];
  const relays = await getReadRelays();
  const chunkSize = 40;
  const byId = new Map<string, Event>();
  for (let i = 0; i < nodeIds.length; i += chunkSize) {
    const chunk = nodeIds.slice(i, i + chunkSize);
    const hits = await queryMany(relays, {
      kinds: [FILE_TRACE_NODE_KIND, FOLDER_TRACE_NODE_KIND],
      "#q": chunk,
    });
    for (const e of hits) byId.set(e.id, e);
  }
  return [...byId.values()];
}

/** One inbound signal on this trace: another trace that forks it, tags it, or
 *  cites it (spec §3.8 forks, §6 tags, §3.3 cites). `sourceEventId` is the
 *  forking/tagging/citing trace's node to open; `fromNodeId` is our node they
 *  pointed at (the pinned version); `name` is resolved lazily by the press. */
export interface TraceInbound {
  kind: "fork" | "tag" | "cite";
  /** The inbound trace's node (its genesis for a fork, or the citing node). */
  sourceEventId: string;
  /** Our node the inbound trace points at (forked-from / cited source). */
  fromNodeId: string;
  /** Signer of the inbound trace — for display when no name resolves. */
  ownerPubkey: string;
  /** Resolved later by the press via `resolveNodeName`; undefined until then. */
  name?: string;
}

/** A raw delta parsed out of an event's content for inbound scanning. The cite
 *  role (inline/live/tag/reply, spec §3.3) distinguishes a tag from a quote
 *  from a reply; `sourceEventId` is the pinned nucleus the cite points at. All
 *  fields optional — `findInbound` guards each before use. */
export interface RawDeltaInbound {
  type: string;
  role?: string;
  op?: string;
  sourceEventId?: string;
}

/** Pull the `cite` deltas out of an event's content, ignoring everything else
 *  (body edits, membership, focus). The cite role (inline/live/tag/reply, spec
 *  §3.3) is what distinguishes a tag from a quote from a reply. Exported so the
 *  unit test can assert the parse without a relay. */
export function citeDeltasOf(e: Event): RawDeltaInbound[] {
  try {
    const parsed = JSON.parse(e.content) as { deltas?: RawDeltaInbound[] };
    if (!parsed.deltas) return [];
    return parsed.deltas.filter((d) => d && d.type === "cite");
  } catch {
    return [];
  }
}

/** Map a cite delta's `role` (spec §3.3) to the inbound kind surfaced by the
 *  tracker, or null when the role is not an inbound signal: `tag` → tagger,
 *  `inline`/`reply` → citer, `live` → null (reserved/deferred — spec §3.3 marks
 *  it "not yet specified beyond the delta shape"). Pure — unit-tested. */
export function classifyCite(role: string | undefined): TraceInbound["kind"] | null {
  if (role === "tag") return "tag";
  if (role === "inline" || role === "reply") return "cite";
  return null;
}

/**
 * The inbound tracker for one file: every other trace that forks it, tags it,
 * or cites it (spec §3.8 forks via `forked-from`; §6 tags and §3.3 cites via
 * `q` edges). Pure detection — read-only, no merge.
 *
 * Distinct from `findMergeCandidates`: that is the *action* surface (Incorporate
 * / Reconcile, scoped to actionable forks, skipping self-forks); this is the
 * *tracker* (every inbound signal, including self-forks, for click-to-open).
 * The same fork may appear in both; the merge-banner says "act," the tag section
 * says "this trace has forks."
 *
 * Tags vs cites: the `q` tag is the single composition edge (spec §R4) — a `q`
 * into our chain IS a citation, the same fact the outbound reader
 * (`eventMeta.citationTargets`) reads off every `q`. We exclude the two
 * non-citation `q` sources (folder membership on `z:folder` nodes; LLM scope on
 * `scope:llm`-marked nodes), then classify each remaining edge: "tag" if the
 * citing node has an active `cite role:"tag"` delta for our node, else "cite"
 * — which covers inline bracket quotes (emitted as `q` + body insert, with no
 * cite delta) and replies. Relying on the cite delta to *detect* the edge would
 * silently miss every minted span quoted in a body, since the write path only
 * emits cite deltas for `tag` and `reply`, not `inline`.
 */
export async function findInbound(
  folderId: string,
  relativePath: string,
): Promise<TraceInbound[]> {
  const relays = await getReadRelays();
  const oursRaw = await queryMany(relays, {
    kinds: [FILE_TRACE_NODE_KIND],
    "#F": [relativePath],
    "#D": [folderId],
  });
  const ours = oursRaw.filter(isFileNode);
  const ourIds = new Set(ours.map((e) => e.id));
  if (ourIds.size === 0) return [];

  const out: TraceInbound[] = [];
  const seen = new Set<string>();

  // Forks: geneses (no prev) with `forked-from` → our chain. Same post-filter
  // as findMergeCandidates (provenance.ts ~2501) but WITHOUT the self-fork skip
  // — the tracker shows all forks; the merge-banner keeps its own skip.
  const forkRefs = await queryReferencing([...ourIds]);
  for (const e of forkRefs) {
    if (!isFileNode(e)) continue;
    const hasPrev = e.tags.some((t) => t[0] === "e" && t[3] === "prev");
    if (hasPrev) continue;
    const ff = e.tags.find((t) => t[0] === "e" && t[3] === "forked-from");
    if (!ff || !ourIds.has(ff[1])) continue;
    // Walk the fork's own chain to its tip for a stable id (a fork's genesis
    // is rarely its head — the fork has likely advanced since seeding).
    const theirFolder = fileTag(e, "D") ?? fileTag(e, "f") ?? fileTag(e, "folder");
    const theirPath = fileTag(e, "F") ?? fileTag(e, "file") ?? relativePath;
    let tipId = e.id;
    if (theirFolder) {
      try {
        const theirChain = await fetchChain(theirFolder, theirPath);
        if (theirChain.length > 0) tipId = theirChain[theirChain.length - 1].id;
      } catch {
        // Fall back to the genesis id if the fork's chain is unreadable.
      }
    }
    if (seen.has(tipId)) continue;
    seen.add(tipId);
    out.push({ kind: "fork", sourceEventId: tipId, fromNodeId: ff[1], ownerPubkey: e.pubkey });
  }

  // Tags + cites: events with a `q` edge pinning one of our nodes. The `q` tag
  // is the single composition edge (spec §R4) — a `q` into our chain IS a
  // citation, the same fact the outbound reader `eventMeta.citationTargets`
  // reads off every `q`. We do NOT rely on the cite delta to *detect* the edge:
  // the write path only emits `cite` deltas for `tag` and `reply`, NOT for
  // `inline` bracket quotes (which emit a `q` + a body insert, no cite delta).
  // So a cite-delta-only approach would silently miss every minted span
  // quoted in someone's body — the common case. Instead: exclude the two
  // non-citation `q` sources (folder membership, LLM scope), then classify each
  // remaining edge by whether it carries a `role:"tag"` cite delta.
  const qRefs = await queryReferencingByQ([...ourIds]);
  for (const e of qRefs) {
    for (const targetId of ourIds) {
      const kind = classifyQEdge(e, targetId);
      if (!kind) continue;
      const key = `${kind}:${e.id}:${targetId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ kind, sourceEventId: e.id, fromNodeId: targetId, ownerPubkey: e.pubkey });
    }
  }

  return out;
}

/** Classify one `q` edge from event `e` into our node `targetId` as an inbound
 *  signal: `"tag"` if the citing node has an active `cite role:"tag"` delta for
 *  it, `"cite"` otherwise (covers inline bracket quotes and replies, which emit
 *  a `q` but no `tag` delta), or `null` when the edge is not an inbound
 *  citation — folder membership (`z:folder`), LLM scope (`scope:llm`), or the
 *  node simply doesn't `q`-cite `targetId`. Pure — unit-tested.
 *
 *  This mirrors the outbound reader (`eventMeta.citationTargets` reads every
 *  `q` as a citation); it does NOT rely on the cite delta to *detect* the edge,
 *  because the write path emits cite deltas only for `tag` and `reply`, not for
 *  `inline` bracket quotes. See `findInbound` for the rationale. */
export function classifyQEdge(e: Event, targetId: string): TraceInbound["kind"] | null {
  // Folder nodes: their `q` edges are membership entries (spec §3.1), not
  // citations. A folder that includes this file as a member is composition at
  // the folder level — out of scope for a per-file inbound tracker.
  if (!isFileNode(e)) return null;
  // LLM-scope nodes: their `q` edges name the call's in-scope traces (spec
  // §3.7), flagged with a `scope:llm` marker. An LLM call that had this trace
  // in context is provenance about the call, not a citation of the content.
  if (e.tags.some((t) => t[0] === "scope" && t[1] === "llm")) return null;
  // Does this event actually q-cite targetId?
  const cites = e.tags.some((t) => t[0] === "q" && t[1] === targetId);
  if (!cites) return null;
  // A tag, specifically? An active `cite role:"tag"` add for targetId. A
  // removed tag (op:"remove") is no longer an inbound edge → falls through to
  // "cite" only if the q edge still exists; in practice a removed tag drops the
  // q too, so this is defensive.
  const isTagged = citeDeltasOf(e).some(
    (c) => c.role === "tag" && c.op !== "remove" && c.sourceEventId === targetId,
  );
  return isTagged ? "tag" : "cite";
}

/**
 * Unilateral incorporate: merge a candidate into *our* file chain and repoint
 * folder membership (protocol §3.8).
 *
 * - noConflict candidates: snapshot defaults to theirs (full adopt).
 * - Conflict / forced: pass `opts.snapshot` from the three-way UI (or any
 *   reconciled body). `force` is implied when `snapshot` is provided.
 * - Authors: full-adopt of theirs → parent run with `src`; otherwise omit
 *   (signer attribution) unless `opts.authors` is supplied.
 *
 * Returns the signed merge node.
 */
export async function incorporateMergeCandidate(
  folderId: string,
  relativePath: string,
  candidate: MergeCandidate,
  opts?: {
    force?: boolean;
    signer?: Uint8Array;
    /** Reconciled body from three-way UI. Defaults to candidate.snapshot. */
    snapshot?: string;
    authors?: import("./workspace-core.js").Run[];
  },
): Promise<Event> {
  const snapshot = opts?.snapshot ?? candidate.snapshot;
  const hasCustomSnapshot = opts?.snapshot !== undefined;
  if (!candidate.noConflict && !opts?.force && !hasCustomSnapshot) {
    throw new Error(
      "Cannot auto-incorporate: you edited after this fork. Open the reconcile panel or pass a resolved snapshot.",
    );
  }
  const ourHeadId = await fetchLatestEventId(folderId, relativePath);
  if (!ourHeadId) {
    throw new Error(`incorporate: no head on our chain for ${relativePath}`);
  }

  // Full-adopt of their body → verified attribution; selective/reconciled
  // bodies leave authors to the caller or fall back to signer.
  let authors = opts?.authors;
  if (authors === undefined && snapshot === candidate.snapshot && snapshot.length > 0) {
    authors = authorsFromMergeParent(candidate.ownerPubkey, candidate.headId, snapshot);
  }

  const event = await mergeFile({
    folderId,
    relativePath,
    prevEventId: ourHeadId,
    mergeParentIds: [candidate.headId],
    snapshot,
    authors,
    summary:
      candidate.kind === "incoming-fork"
        ? `incorporated fork ${candidate.headId.slice(0, 8)}`
        : `merged sibling branch ${candidate.headId.slice(0, 8)}`,
    signer: opts?.signer,
  });

  await upsertManifestEntry(
    folderId,
    {
      relativePath,
      latestNodeId: event.id,
      contentHash: await sha256HexLocal(snapshot),
      isDeleted: false,
    },
    opts?.signer,
  );

  return event;
}

/** Load the three bodies needed for a conflict merge UI: base (fork point or
 *  empty), ours (current head snapshot), theirs (candidate.snapshot). */
export async function loadMergeSides(
  folderId: string,
  relativePath: string,
  candidate: MergeCandidate,
): Promise<{ base: string; ours: string; theirs: string }> {
  const oursChain = await fetchChain(folderId, relativePath);
  const oursEvent = oursChain.length > 0 ? oursChain[oursChain.length - 1] : null;
  const ours = oursEvent ? snapshotOf(oursEvent) : "";

  let base = "";
  if (candidate.forkedFromId) {
    const baseEvent = await fetchEventById(candidate.forkedFromId);
    if (baseEvent) base = snapshotOf(baseEvent);
  } else if (candidate.kind === "sibling-head") {
    // Best-effort common ancestor: latest node on our chain that also appears
    // on theirs (shared history under the same folder+path).
    const theirsChain = await fetchChain(candidate.sourceFolderId, candidate.relativePath);
    const theirIds = new Set(theirsChain.map((e) => e.id));
    for (let i = oursChain.length - 1; i >= 0; i--) {
      if (theirIds.has(oursChain[i].id)) {
        base = snapshotOf(oursChain[i]);
        break;
      }
    }
    // If no shared node, base stays "" (independent roots).
  }

  return { base, ours, theirs: candidate.snapshot };
}

/** One author's current alpha for one body. The authoritative value is on the
 *  referenced event's content; `alpha` is parsed out for convenience. */
export interface AlphaHead {
  pubkey: string;
  alpha: number;
  event: Event;
}

/** Fetch the current alpha head per (pubkey, contentHash) for every hash in
 *  `contentHashes`, in a single batched query. One round-trip covers a whole
 *  sample's worth of bodies. The filter is NIP-01 multi-value on `#d`, which
 *  returns every alpha event for any of the hashes; we then head-resolve per
 *  pubkey+hash client-side (the relay can't, because "current" depends on the
 *  prev-graph, not on created_at).
 *
 *  Returns a Map keyed by contentHash → the set of distinct-author heads for
 *  that body. Absent hashes have no opinions. */
export async function fetchAlphaHeads(
  contentHashes: string[],
): Promise<Map<string, AlphaHead[]>> {
  const out = new Map<string, AlphaHead[]>();
  if (contentHashes.length === 0) return out;
  const relays = await getReadRelays();
  // Spec §5: opinions are keyed on `x:<bodyHash>` subjects (the immutable-body
  // axis). Also query legacy kind-4293 (bare-hash, non-replaceable) so old
  // alpha events keep reading.
  const xSubjects = contentHashes.map((h) => `x:${h}`);
  const [modern, legacy] = await Promise.all([
    queryMany(relays, { kinds: [TRACE_OPINION_KIND], "#d": xSubjects }),
    queryMany(relays, { kinds: [TRACE_ALPHA_KIND], "#d": contentHashes }),
  ]);

  // Bucket by bare contentHash (the caller's key), reconciling both sources.
  // For modern (34291, replaceable): current = latest created_at per pubkey.
  // For legacy (4293, non-replaceable): current = uncited-head per pubkey.
  const byHash = new Map<string, Map<string, Event[]>>();
  const record = (bareHash: string, e: Event) => {
    let perPubkey = byHash.get(bareHash);
    if (!perPubkey) {
      perPubkey = new Map();
      byHash.set(bareHash, perPubkey);
    }
    let arr = perPubkey.get(e.pubkey);
    if (!arr) {
      arr = [];
      perPubkey.set(e.pubkey, arr);
    }
    arr.push(e);
  };
  for (const e of modern) {
    const dTag = e.tags.find((t) => t[0] === "d");
    if (!dTag || typeof dTag[1] !== "string") continue;
    const subject = dTag[1];
    if (!subject.startsWith("x:")) continue;
    record(subject.slice(2), e);
  }
  for (const e of legacy) {
    const dTag = e.tags.find((t) => t[0] === "d");
    if (!dTag || typeof dTag[1] !== "string") continue;
    record(dTag[1], e);
  }

  for (const [hash, perPubkey] of byHash) {
    const heads: AlphaHead[] = [];
    for (const evs of perPubkey.values()) {
      // Mixed sources: prefer the modern (replaceable) latest; fall back to
      // the legacy uncited-head resolution only when no modern event exists.
      const modern = evs.filter((e) => e.kind === TRACE_OPINION_KIND);
      const legacy = evs.filter((e) => e.kind === TRACE_ALPHA_KIND);
      let head: Event | null;
      if (modern.length > 0) {
        head = modern.reduce((a, b) => (b.created_at > a.created_at ? b : a));
      } else {
        head = resolveHead(legacy);
      }
      if (!head) continue;
      const parsed = safeParse(head.content);
      const alpha =
        parsed && typeof parsed === "object" && typeof (parsed as { alpha?: unknown }).alpha === "number"
          ? (parsed as { alpha: number }).alpha
          : 0;
      heads.push({ pubkey: head.pubkey, alpha, event: head });
    }
    out.set(hash, heads);
  }
  return out;
}

/** Per-reader weights for aggregating alpha opinions. Defaults live in
 *  alpha-config.ts; this is the pure shape the aggregator consumes. An author's
 *  own alpha on their own body counts at `authorWeight`; any other pubkey at
 *  `curatorWeight`; pubkeys in `operatorPubkeys` at `operatorWeight` (the
 *  "relay-operator-as-chief-curator" default, expressed as a client-side
 *  multiplier, not a protocol role). */
export interface AlphaAggOpts {
  /** The reader's own pubkey — alpha events signed by this key count as author
   *  self-tuning. */
  authorPubkey?: string;
  operatorPubkeys?: string[];
  authorWeight?: number;
  curatorWeight?: number;
  operatorWeight?: number;
}

/** The default multiplier for an operator's alpha opinion. Mirrors the default
 *  in alpha-config.ts; duplicated here so the aggregator is usable with an
 *  empty opts object (zero-config regression-safe behavior). */
const DEFAULT_OPERATOR_WEIGHT = 3.0;

/** Sum the weighted alpha opinions for one body. Pure function: given the heads
 *  for one contentHash and the reader's weighting, returns the effective alpha.
 *  Empty heads → 0 (baseline, not exclusion — a body with no opinions is still
 *  sampleable on its other merits). */
export function effectiveAlpha(heads: AlphaHead[], opts: AlphaAggOpts = {}): number {
  const author = opts.authorPubkey;
  const operators = new Set(opts.operatorPubkeys ?? []);
  const authorWeight = opts.authorWeight ?? 1.0;
  const curatorWeight = opts.curatorWeight ?? 1.0;
  const operatorWeight = opts.operatorWeight ?? DEFAULT_OPERATOR_WEIGHT;
  let total = 0;
  for (const h of heads) {
    const w =
      h.pubkey === author
        ? authorWeight
        : operators.has(h.pubkey)
          ? operatorWeight
          : curatorWeight;
    total += h.alpha * w;
  }
  return total;
}

// --- trace rank (manual arrangement of folders) -------------------------

/** The synthetic contentHash a folder's manual stack-position is addressed on.
 *  A *separate* namespace from `folderHash` (which carries promote/demote
 *  verdicts): `rank:<folderId>` keeps stack-position opinions on their own
 *  relay `#d` axis, so they never collide with verdict alpha and a reader can
 *  query one without the other. Same client-convention stance as `folderHash`
 *  — needs no protocol change, every press that arranges the same project
 *  addresses the same rank chain. */
export async function rankHash(folderId: string): Promise<string> {
  return sha256HexLocal(`rank:${folderId}`);
}

/** One author's current manual rank for one folder. `rank` is a position
 *  integer (lower = earlier in the stack), parsed from the head event's
 *  content; the authoritative value lives on `event`. Sibling of `AlphaHead`
 *  for a different wire payload (rank, not alpha). */
export interface RankHead {
  pubkey: string;
  rank: number;
  event: Event;
}

/** Build, sign, and publish a kind-4293 TraceAlpha event carrying a *rank*
 *  payload instead of an alpha one. The kind and tags are identical to
 *  `publishTraceAlpha`; only the content differs (`{ rank, sealedAt }`), and
 *  the separation comes from the `rank:<folderId>` contentHash namespace
 *  (callers pass `rankHash(folderId)`), not from any wire-level discriminator.
 *  Structurally a near-clone of `publishTraceAlpha`.
 *
 *  `prevEventId` is the current head for (this signer, rankHash); null on the
 *  first arrangement. Now a TraceOpinion (kind 34291, replaceable) keyed on
 *  `d = "r:" + contentHash` — the rank subject namespace, a client convention
 *  parallel to alpha's `x:` axis. `prevEventId` accepted but ignored. */
export async function publishTraceRank(input: {
  contentHash: string;
  rank: number;
  prevEventId?: string | null;
  signer?: Uint8Array;
}): Promise<Event> {
  const relays = await getWriteRelays();
  const signer = input.signer ?? loadOrCreateVoice().secretKey;
  const sealedAt = Date.now();

  const template: EventTemplate = {
    kind: TRACE_OPINION_KIND,
    created_at: Math.floor(sealedAt / 1000),
    tags: [["d", `r:${input.contentHash}`]],
    content: JSON.stringify({ rank: input.rank, sealedAt }),
  };

  const signed = finalizeEvent(template, signer);
  await publishToMany(relays, signed);
  return signed;
}

/** Fetch the current rank head per (pubkey, rankHash) for every hash in
 *  `rankHashes`, in a single batched query. Queries both TraceOpinion (34291,
 *  `r:`-prefixed) and legacy TraceAlpha (4293, bare hash) and reconciles.
 *  Modern: current = latest created_at per pubkey. Legacy: uncited-head scan.
 *  Absent hashes have no opinions. */
export async function fetchRankHeads(
  rankHashes: string[],
): Promise<Map<string, RankHead[]>> {
  const out = new Map<string, RankHead[]>();
  if (rankHashes.length === 0) return out;
  const relays = await getReadRelays();
  const rSubjects = rankHashes.map((h) => `r:${h}`);
  const [modern, legacy] = await Promise.all([
    queryMany(relays, { kinds: [TRACE_OPINION_KIND], "#d": rSubjects }),
    queryMany(relays, { kinds: [TRACE_ALPHA_KIND], "#d": rankHashes }),
  ]);

  // Bucket by bare rankHash (the caller's key), reconciling both sources.
  const byHash = new Map<string, Map<string, Event[]>>();
  const record = (bareHash: string, e: Event) => {
    let perPubkey = byHash.get(bareHash);
    if (!perPubkey) {
      perPubkey = new Map();
      byHash.set(bareHash, perPubkey);
    }
    let arr = perPubkey.get(e.pubkey);
    if (!arr) {
      arr = [];
      perPubkey.set(e.pubkey, arr);
    }
    arr.push(e);
  };
  for (const e of modern) {
    const dTag = e.tags.find((t) => t[0] === "d");
    if (!dTag || typeof dTag[1] !== "string") continue;
    const subject = dTag[1];
    if (!subject.startsWith("r:")) continue;
    record(subject.slice(2), e);
  }
  for (const e of legacy) {
    const dTag = e.tags.find((t) => t[0] === "d");
    if (!dTag || typeof dTag[1] !== "string") continue;
    record(dTag[1], e);
  }
  for (const [hash, perPubkey] of byHash) {
    const heads: RankHead[] = [];
    for (const evs of perPubkey.values()) {
      const modernEvs = evs.filter((e) => e.kind === TRACE_OPINION_KIND);
      const legacyEvs = evs.filter((e) => e.kind === TRACE_ALPHA_KIND);
      let head: Event | null;
      if (modernEvs.length > 0) {
        head = modernEvs.reduce((a, b) => (b.created_at > a.created_at ? b : a));
      } else {
        head = resolveHead(legacyEvs);
      }
      if (!head) continue;
      const parsed = safeParse(head.content);
      const rank =
        parsed && typeof parsed === "object" && typeof (parsed as { rank?: unknown }).rank === "number"
          ? (parsed as { rank: number }).rank
          : 0;
      heads.push({ pubkey: head.pubkey, rank, event: head });
    }
    out.set(hash, heads);
  }
  return out;
}

// --- named stacks (the editorial output of Stacks) ----------------------
//
// A "stack" is a named section in the Stacks view — the editorial presentation
// of zines arranged by the operator + curator team. It is NOT a new protocol
// kind: it rides on TraceOpinion (34291) as two more `d`-tag axes, parallel to
// alpha (`x:`) and rank (`r:`). Same client-convention stance as `folderHash`
// and `rankHash` — every press addressing the same project hits the same
// subject, needs no relay-side support.
//
//   sd:<pubkey>           — an author's stack DEFINITIONS (one replaceable
//                           event holding `{ defs: [{id, title, order}] }`).
//   sa:<stackId>:<folder> — an author's ASSIGNMENT of one zine to one stack,
//                           content `{ rank, sealedAt }` (lower = earlier in
//                           the section, same convention as `r:`).
//
// Aggregation is non-normative, like alpha: the team's definitions merge with
// the operator's order/titles winning; the team's assignments average into one
// effective rank per (stackId, folderId). Crowd assignment (non-team signers)
// is intentionally ignored — Stacks is the operator's editorial output, not a
// popularity contest. Crowd signal lives in alpha (the +alpha opinion axis).

/** One named stack definition. `id` is a stable opaque slug; `order` is the
 *  author's preferred section order; `title` is the section heading. */
export interface StackDef {
  id: string;
  title: string;
  order: number;
}

/** Build, sign, and publish the author's stack definitions as one replaceable
 *  kind-34291 event (`d = "sd:" + pubkey`). Last-write-wins per author. The
 *  whole set is republished on any change (the same posture as `publishPalette`
 *  — NIP-33 replaceable-as-a-whole). */
export async function publishStackDefs(defs: StackDef[]): Promise<Event> {
  const relays = await getWriteRelays();
  const signer = loadOrCreateVoice();
  const sealedAt = Date.now();
  const template: EventTemplate = {
    kind: TRACE_OPINION_KIND,
    created_at: Math.floor(sealedAt / 1000),
    tags: [["d", `sd:${signer.publicKey}`]],
    content: JSON.stringify({
      defs: defs.map((d, i) => ({ id: d.id, title: d.title, order: typeof d.order === "number" ? d.order : i })),
      sealedAt,
    }),
  };
  const signed = finalizeEvent(template, signer.secretKey);
  await publishToMany(relays, signed);
  return signed;
}

/** Read and merge the team's stack definitions. The operator's order and titles
 *  win on conflict; curators may contribute additional stacks the operator
 *  hasn't defined (those appear after the operator's, in curator pubkey order).
 *  `teamPubkeys` is `[author, ...operators]` — the curation team. Empty input →
 *  no stacks. */
export async function fetchStackDefs(teamPubkeys: string[]): Promise<StackDef[]> {
  if (teamPubkeys.length === 0) return [];
  const relays = await getReadRelays();
  const sdSubjects = teamPubkeys.map((k) => `sd:${k}`);
  const events = await queryMany(relays, { kinds: [TRACE_OPINION_KIND], "#d": sdSubjects });
  // Latest created_at per pubkey wins (replaceable).
  const latestByPubkey = new Map<string, Event>();
  for (const e of events) {
    const cur = latestByPubkey.get(e.pubkey);
    if (!cur || e.created_at > cur.created_at) latestByPubkey.set(e.pubkey, e);
  }
  // Order teams by the caller's input: author first, then operators in the
  // order they were given. An unknown pubkey (e.g. a stale operator) lands last.
  const rankOf = (k: string) => {
    const i = teamPubkeys.indexOf(k);
    return i < 0 ? teamPubkeys.length : i;
  };
  const parsed: { pubkey: string; defs: StackDef[] }[] = [];
  for (const [pubkey, e] of latestByPubkey) {
    const c = safeParse(e.content);
    const defs =
      c && typeof c === "object" && Array.isArray((c as { defs?: unknown }).defs)
        ? ((c as { defs: StackDef[] }).defs)
            .filter(
              (d) => d && typeof d.id === "string" && typeof d.title === "string",
            )
            .map((d, i) => ({
              id: d.id,
              title: d.title,
              order: typeof d.order === "number" ? d.order : i,
            }))
        : [];
    if (defs.length > 0) parsed.push({ pubkey, defs });
  }
  parsed.sort((a, b) => rankOf(a.pubkey) - rankOf(b.pubkey));
  // Merge: the first (operator-most) author's defs set the canonical ids/order;
  // later authors only contribute NEW ids (their order applies within their
  // own additions, appended after the operator's set).
  const seen = new Set<string>();
  const merged: StackDef[] = [];
  for (const { defs } of parsed) {
    for (const d of defs) {
      if (seen.has(d.id)) continue;
      seen.add(d.id);
      merged.push(d);
    }
  }
  return merged;
}

/** Build, sign, and publish a stack ASSIGNMENT: "zine `folderId` belongs in
 *  stack `stackId` at position `rank`." One replaceable kind-34291 event per
 *  `(pubkey, stackId, folderId)`, `d = "sa:" + stackId + ":" + folderId`,
 *  content `{ rank, sealedAt }`. Mirrors `publishTraceRank`'s shape on a
 *  different subject namespace. */
export async function publishStackAssignment(input: {
  stackId: string;
  folderId: string;
  rank: number;
  signer?: Uint8Array;
}): Promise<Event> {
  const relays = await getWriteRelays();
  const signer = input.signer ?? loadOrCreateVoice().secretKey;
  const sealedAt = Date.now();
  const template: EventTemplate = {
    kind: TRACE_OPINION_KIND,
    created_at: Math.floor(sealedAt / 1000),
    tags: [["d", `sa:${input.stackId}:${input.folderId}`]],
    content: JSON.stringify({ rank: input.rank, sealedAt }),
  };
  const signed = finalizeEvent(template, signer);
  await publishToMany(relays, signed);
  return signed;
}

/** One author's rank for one (stackId, folderId), parsed from their head event. */
interface StackAssignmentHead {
  pubkey: string;
  rank: number;
  event: Event;
}

/** Fetch every team member's stack-assignment heads in one batched query, then
 *  return them grouped as `Map<stackId, Map<folderId, StackAssignmentHead[]>>`.
 *
 *  NIP `#d` is exact-match, so we can't prefix-filter `sa:` at the relay. We
 *  over-fetch the team's kind-34291 events by author (bounded by team size)
 *  and partition by `d`-prefix client-side — discarding alpha/rank/defs events.
 *  This is the same over-fetch-then-partition shape rank/alpha would use if
 *  they shared a prefix. */
export async function fetchStackAssignments(
  teamPubkeys: string[],
): Promise<Map<string, Map<string, StackAssignmentHead[]>>> {
  const out = new Map<string, Map<string, StackAssignmentHead[]>>();
  if (teamPubkeys.length === 0) return out;
  const relays = await getReadRelays();
  // `authors` is the bounding filter; we accept the team's whole 34291 set and
  // filter client-side. A large team would need per-author pagination; a
  // curator team is small, so this is fine.
  const events = await queryMany(relays, {
    kinds: [TRACE_OPINION_KIND],
    authors: teamPubkeys,
  });
  // Latest created_at per (pubkey, subject) wins (replaceable).
  const latest = new Map<string, Event>();
  for (const e of events) {
    const dTag = e.tags.find((t) => t[0] === "d");
    if (!dTag || typeof dTag[1] !== "string") continue;
    const subject = dTag[1];
    if (!subject.startsWith("sa:")) continue;
    const key = `${e.pubkey}\0${subject}`;
    const cur = latest.get(key);
    if (!cur || e.created_at > cur.created_at) latest.set(key, e);
  }
  for (const e of latest.values()) {
    const dTag = e.tags.find((t) => t[0] === "d");
    const subject = dTag![1] as string;
    // "sa:<stackId>:<folderId>" — split from the first colon after sa:.
    const rest = subject.slice(3); // drop "sa:"
    const sep = rest.indexOf(":");
    if (sep <= 0) continue;
    const stackId = rest.slice(0, sep);
    const folderId = rest.slice(sep + 1);
    if (!stackId || !folderId) continue;
    const parsed = safeParse(e.content);
    const rank =
      parsed && typeof parsed === "object" && typeof (parsed as { rank?: unknown }).rank === "number"
        ? (parsed as { rank: number }).rank
        : 0;
    let perStack = out.get(stackId);
    if (!perStack) {
      perStack = new Map();
      out.set(stackId, perStack);
    }
    let heads = perStack.get(folderId);
    if (!heads) {
      heads = [];
      perStack.set(folderId, heads);
    }
    heads.push({ pubkey: e.pubkey, rank, event: e });
  }
  return out;
}

/** Average the team's signed ranks for one (stackId, folderId). +∞ when the
 *  team hasn't placed the zine in this stack, so unassigned zines sort after
 *  everything. Identical heuristic to `effectiveRank` in the old ListingsView.
 *  Pass the full assignment map from `fetchStackAssignments` plus the team
 *  pubkey set (in case the map carries non-team signers from a wide fetch). */
export function effectiveStackRank(
  assignments: Map<string, Map<string, StackAssignmentHead[]>>,
  teamPubkeys: Set<string>,
  stackId: string,
  folderId: string,
): number {
  const perStack = assignments.get(stackId);
  if (!perStack) return Number.POSITIVE_INFINITY;
  const heads = (perStack.get(folderId) ?? []).filter((h) => teamPubkeys.has(h.pubkey));
  if (heads.length === 0) return Number.POSITIVE_INFINITY;
  return heads.reduce((sum, h) => sum + h.rank, 0) / heads.length;
}

/** Reorder sample hits by rank = citationCount + effectiveAlpha. Deterministic:
 *  same query → same order. Stable sort preserves the sampler's first-seen
 *  insertion order as the tiebreak, so equal-rank hits keep sampleRelays'
 *  output order rather than reshuffling on refresh.
 *
 *  Alpha is fetched in a single batched query keyed by every hit's contentHash
 *  (the `x` tag for 4290 minted-span nodes, hashed snapshot as a fallback for
 *  named file traces that don't emit `x`). With no alpha opinions present, every
 *  effectiveAlpha is 0 and the order collapses to citationCount-only — exactly
 *  today's behavior, so this is a safe drop-in for runSample. */
export async function rankSampleHits(
  hits: SampleHit[],
  opts: AlphaAggOpts = {},
): Promise<SampleHit[]> {
  // Gather content hashes. `x` is authoritative for minted spans; fall back to
  // hashing the snapshot so named file traces (which don't emit x) still rank.
  const hashes = new Set<string>();
  const hashFor = new Map<Event, string>();
  for (const hit of hits) {
    const xTag = hit.event.tags.find((t) => t[0] === "x");
    let hash: string | undefined;
    if (xTag && typeof xTag[1] === "string") {
      hash = xTag[1];
    } else if (hit.event.kind === FILE_TRACE_NODE_KIND) {
      const parsed = safeParse(hit.event.content);
      if (parsed && typeof parsed === "object" && typeof (parsed as { snapshot?: unknown }).snapshot === "string") {
        hash = await sha256HexLocal((parsed as { snapshot: string }).snapshot);
      }
    }
    if (hash) {
      hashes.add(hash);
      hashFor.set(hit.event, hash);
    }
  }

  const alphaByHash = hashes.size > 0 ? await fetchAlphaHeads([...hashes]) : new Map<string, AlphaHead[]>();

  // Decorate each hit with a score, then stable-sort descending by score.
  const scored = hits.map((hit, i) => {
    const meta = eventMeta(hit.event);
    const hash = hashFor.get(hit.event);
    const alpha = hash ? effectiveAlpha(alphaByHash.get(hash) ?? [], opts) : 0;
    return { hit, score: meta.citationCount + alpha, i };
  });
  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  return scored.map((s) => s.hit);
}

/** Reconstructs file content as of a single seal, by replaying the chain
 *  from genesis through `throughIndex` (inclusive). Used by folder-wide
 *  replay, which steps seal-by-seal rather than always landing on the head.
 *  Equivalent to `reconstructFromChain(chain.slice(0, throughIndex + 1))`;
 *  exposed so callers don't reach past `reconstructFromChain` to fold deltas
 *  themselves. Out-of-range indices clamp to the chain ends. */
export function reconstructUpTo(chain: Event[], throughIndex: number): string {
  const end = Math.max(0, Math.min(throughIndex + 1, chain.length));
  return reconstructFromChain(chain.slice(0, end));
}

/** Reconstructs file content by replaying deltas along the chain. */
export function reconstructFromChain(chain: Event[]): string {
  let content = "";
  for (const event of chain) {
    const parsed = JSON.parse(event.content) as { snapshot?: string; deltas?: Array<{ type: string; position: { start: number; end: number }; newValue: string | null }> };
    if (typeof parsed.snapshot === "string") {
      content = parsed.snapshot; // snapshot is authoritative when present
      continue;
    }
    if (parsed.deltas) {
      for (const d of parsed.deltas) {
        content =
          content.slice(0, d.position.start) + (d.newValue ?? "") + content.slice(d.position.end);
      }
    }
  }
  return content;
}

/** Reconstruct per-author runs by replaying the chain. Attribution is sourced
 *  in three tiers, per node in order — the first tier that fires wins:
 *
 *  1. **`authors` field present and valid** (concatenates to this node's
 *     `snapshot`) → adopt the run list directly. This is the authoritative
 *     per-character truth a live editor sealed; it never collapses surrounding
 *     attribution to one voice. A multi-author document edited by B keeps
 *     A's spans attributed to A on reload, instead of the whole block snapping
 *     to B (the bug `authors` exists to fix).
 *  2. **Position-bearing content deltas** → splice each delta's insert into the
 *     running run-list, attributed to this node's signer (`event.pubkey`). This
 *     is the legacy path for nodes sealed without an `authors` map: it
 *     preserves per-char attribution of the unchanged regions and only
 *     reattributes the edited span.
 *  3. **Snapshot with no deltas and no `authors`** → the signer authored the
 *     whole snapshot (a wholesale reset — genesis/import on older data, or a
 *     node that shed its deltas). This is the only honest attribution when no
 *     delta or map describes the change. A tag/reply-only node (snapshot
 *     unchanged) falls through here too and correctly preserves attribution.
 *
 *  Deltas whose `position` is out of range are clamped to the bounds — a
 *  corrupted/abnormal chain degrades to the closest valid splice rather than
 *  throwing. Non-content deltas (`reply-to`, `tag-add`, `tag-remove`) carry
 *  no position/newValue and are skipped (they don't touch text). Adjacent
 *  same-voice ranges collapse into single runs at the end. */
export function reconstructRunsFromChain(chain: Event[]): Run[] {
  let chars: { ch: string; voice: string }[] = [];
  // Dev-only attribution accounting, surfaced when localStorage flag
  // `zine.debug.attribution` is set. Tallies per-chain how many nodes hit each
  // tier (authors map adopted / wholesale-signer reset / delta-signer insert /
  // no-op) so the replay-collapse bug can be diagnosed without guessing which
  // path lost the authors map. See auditAttribution() to read the totals.
  const dbg = debugAttributionActive() ? { tiers: [0, 0, 0, 0], signers: new Set<string>() } : null;
  for (const event of chain) {
    const signer = event.pubkey;
    const parsed = JSON.parse(event.content) as {
      snapshot?: string;
      authors?: unknown;
      deltas?: Array<{
        type?: string;
        position?: { start: number; end: number };
        newValue?: string | null;
      }>;
    };
    // Tier 1: an `authors` map that aligns with this node's snapshot is the
    // authoritative per-char truth — adopt it verbatim. parseAuthors returns
    // null on absence/malformation/mismatch, so a forged or stale map degrades
    // cleanly to the tiers below. This is the fix: a node written with live
    // editor attribution carries the exact run list forward through reload,
    // instead of collapsing to the signer.
    if (typeof parsed.snapshot === "string") {
      const fromAuthors = parseAuthors(parsed.authors, parsed.snapshot);
      if (fromAuthors) {
        chars = runsToChars(fromAuthors);
        if (dbg) dbg.tiers[0]++;
        continue;
      }
    }
    // Position-bearing content deltas only (spec §3.3: a delta changes the
    // body iff it carries a `position`). Citation deltas with role tag/reply
    // have no position and never touch text — skip them so they don't trip
    // the clamp math below. (An inline citation DOES carry a position and is
    // handled here as a body edit, which is correct.)
    const contentDeltas = (parsed.deltas ?? []).filter(
      (d) => d.position && (d.type === "insert" || d.type === "delete" || d.type === "replace"),
    );
    if (contentDeltas.length === 0) {
      // No content deltas on this seal. Two sub-cases:
      //  (a) a bare snapshot that differs from the running content — a
      //      wholesale reset with no delta info (genesis/import on older
      //      harness data). The only honest attribution is the whole snapshot
      //      to this signer.
      //  (b) a tag/reply-only edit — the snapshot matches the current text,
      //      so attribution is preserved (the signer touched metadata, not
      //      text). Re-attributing here would hand the whole document to the
      //      tagger, which is exactly the mis-attribution this is fixing.
      if (typeof parsed.snapshot === "string" && parsed.snapshot !== chars.map((c) => c.ch).join("")) {
        chars = [...parsed.snapshot].map((ch) => ({ ch, voice: signer }));
        if (dbg) {
          dbg.tiers[1]++;
          dbg.signers.add(signer);
        }
      } else if (dbg) {
        dbg.tiers[3]++; // tag/reply-only or snapshot-stable — attribution preserved
      }
      continue;
    }
    // Apply deltas last-to-first so earlier positions stay valid within one
    // seal (a seal's deltas share one signer, so order only affects position
    // math, not attribution).
    for (let i = contentDeltas.length - 1; i >= 0; i--) {
      const d = contentDeltas[i];
      const start = Math.max(0, Math.min(d.position!.start, chars.length));
      const end = Math.max(start, Math.min(d.position!.end, chars.length));
      const insertChars = [...(d.newValue ?? "")].map((ch) => ({ ch, voice: signer }));
      chars = [...chars.slice(0, start), ...insertChars, ...chars.slice(end)];
      if (dbg) {
        dbg.tiers[2]++;
        dbg.signers.add(signer);
      }
    }
  }
  // Collapse adjacent same-voice chars into runs, mirroring charsToRuns.
  const runs: Run[] = [];
  for (const c of chars) {
    const last = runs[runs.length - 1];
    if (last && last.voice === c.voice) last.text += c.ch;
    else runs.push({ voice: c.voice, text: c.ch });
  }
  if (dbg) recordAttributionAudit(dbg.tiers, dbg.signers, runs);
  return runs;
}

/** Whether attribution debugging is on. Set `localStorage.setItem("zine.debug
 *  .attribution","1")` (any truthy value) and reload to enable; off by default
 *  so it never adds overhead or noise to normal use. */
function debugAttributionActive(): boolean {
  try {
    return typeof localStorage !== "undefined" && !!localStorage.getItem("zine.debug.attribution");
  } catch {
    return false;
  }
}

/** Per-chain attribution breakdown, accumulated while the debug flag is on.
 *  `tiers`: [authors-adopted, wholesale-signer-reset, delta-signer-insert,
 *  no-op]. `collapsedSigners`: signers that swallowed a whole snapshot/insert —
 *  the mis-attribution source. `resultingVoices`: distinct voices in the final
 *  run list (1 means the reconstruction collapsed to a single author). */
export interface AttributionAudit {
  chains: number;
  tiers: [number, number, number, number];
  collapsedSigners: string[];
  voices: string[];
}

let attributionAudit: AttributionAudit = {
  chains: 0,
  tiers: [0, 0, 0, 0],
  collapsedSigners: [],
  voices: [],
};

function recordAttributionAudit(
  tiers: number[],
  signers: Set<string>,
  runs: Run[],
): void {
  attributionAudit = {
    chains: attributionAudit.chains + 1,
    tiers: [
      attributionAudit.tiers[0] + tiers[0],
      attributionAudit.tiers[1] + tiers[1],
      attributionAudit.tiers[2] + tiers[2],
      attributionAudit.tiers[3] + tiers[3],
    ],
    collapsedSigners: [...new Set([...attributionAudit.collapsedSigners, ...signers])],
    voices: [...new Set([...attributionAudit.voices, ...runs.map((r) => r.voice)])],
  };
}

/** Read and reset the accumulated attribution audit. Returns null when the
 *  debug flag is off (no data collected). Call from a UI hook (e.g. after
 *  `beginReplay`) to see which tier your chain hit, then `console.log` it or
 *  surface in devtools. */
export function auditAttribution(): AttributionAudit | null {
  if (!debugAttributionActive()) return null;
  const snapshot = attributionAudit;
  attributionAudit = { chains: 0, tiers: [0, 0, 0, 0], collapsedSigners: [], voices: [] };
  return snapshot;
}

/** Per-author runs as of a single seal — the run-replay counterpart of
 *  reconstructUpTo. Out-of-range indices clamp to the chain ends. */
export function reconstructRunsUpTo(chain: Event[], throughIndex: number): Run[] {
  const end = Math.max(0, Math.min(throughIndex + 1, chain.length));
  return reconstructRunsFromChain(chain.slice(0, end));
}

function queryOnce(relay: Relay, filter: Filter): Promise<Event[]> {
  return new Promise((resolve) => {
    const found: Event[] = [];
    const sub = relay.subscribe([filter], {
      onevent(evt: Event) {
        found.push(evt);
      },
      oneose() {
        sub.close();
        resolve(found);
      },
    });
  });
}

/**
 * Query many relays in parallel and merge results by event id (dedup). One
 * slow/dead relay can't stall the merge — each relay gets its own timeout
 * (inherited from the sampler's posture). Empty/failed relays contribute
 * nothing. This is the read-side equivalent of publishToMany: the local
 * sidecar and external relays are treated as a federated set.
 */
async function queryMany(relays: Relay[], filter: Filter, perRelayMs = 4000): Promise<Event[]> {
  if (relays.length === 0) return [];
  // Every relay gets its own timeout so a half-open WS (sub accepted, EOSE
  // never arrives) can't hang forever — without that, baselineScan → doAttach
  // leaves the folder picker stuck loading. Timeouts/failures are best-effort:
  // a down relay contributes nothing. Single-relay (desktop default = home
  // sidecar) MUST share this posture — previously it rethrew the timeout,
  // which surfaced as Unhandled Promise Rejection from auto-beginReplay on
  // folder load when the sidecar was slow/unreachable.
  const byId = new Map<string, Event>();
  await Promise.all(
    relays.map(async (relay) => {
      try {
        const events = await withTimeout(queryOnce(relay, filter), perRelayMs, "query");
        for (const e of events) byId.set(e.id, e);
      } catch {
        // best-effort: a down/slow relay just contributes no events
      }
    }),
  );
  return [...byId.values()];
}

/** Latest across many relays by `created_at`, or null if none matched. */
async function queryLatestMany(relays: Relay[], filter: Filter): Promise<Event | null> {
  const events = await queryMany(relays, filter);
  if (events.length === 0) return null;
  return events.reduce((latest, e) => (e.created_at > latest.created_at ? e : latest));
}

// --- sampler: federated read across a set of relays ---------------------

/** One deduped result of a sample, with every relay that returned it. */
export interface SampleHit {
  event: Event;
  relays: string[];
}

/**
 * Fan `filter` out to every URL in `urls` in parallel. Each relay gets its own
 * timeout so one slow/dead host can't stall the whole sample; failures are
 * collected rather than thrown. Events are deduped by id across relays, with
 * each contributing relay recorded on the hit. This is the read surface that
 * turns the local-only sidecar into a federated query — no events published.
 */
export async function sampleRelays(
  urls: string[],
  filter: Filter,
  perRelayMs = 4000,
): Promise<{ hits: SampleHit[]; errors: { url: string; error: string }[] }> {
  const errors: { url: string; error: string }[] = [];
  const byId = new Map<string, SampleHit>();

  await Promise.all(
    urls.map(async (url) => {
      let relay: Relay | null = null;
      try {
        relay = await withTimeout(Relay.connect(url), perRelayMs, `connect ${url}`);
        const events = await withTimeout(queryOnce(relay, filter), perRelayMs, `query ${url}`);
        for (const event of events) {
          const existing = byId.get(event.id);
          if (existing) {
            if (!existing.relays.includes(url)) existing.relays.push(url);
          } else {
            byId.set(event.id, { event, relays: [url] });
          }
        }
      } catch (e) {
        errors.push({ url, error: e instanceof Error ? e.message : String(e) });
      } finally {
        try {
          await relay?.close();
        } catch {
          // ignore — best-effort cleanup
        }
      }
    }),
  );

  return { hits: [...byId.values()], errors };
}

/** Rejects with `msg` after `ms` if `p` hasn't settled. */
function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms: ${msg}`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * Turn a sample hit into a readable document. The body is human-legible text
 * ONLY — never raw event JSON, never a frontmatter block — and the origin
 * metadata (relays, event id, author, kind, created_at) is returned separately
 * as `eventMeta` so the editor can show it in a metadata strip rather than
 * smearing it into the prose. That keeps a sampled file from reading like the
 * raw Nostr event it came from.
 *
 * Body extraction by kind:
 *  - 4290 FileTraceNode — `snapshot` is authoritative; deltas replayed as a
 *    fallback for older harness output that shed the snapshot.
 *  - 4291 TraceName — the name chain carries a `name` field; rendered as a
 *    heading so the body reads as the trace's current name.
 *  - 4292 FolderTraceNode — `snapshot.members` rendered as an unordered list.
 *  - anything else — a foreign event. If its content parses as JSON, show it
 *    pretty-printed in a fenced block (legible, clearly delimited); otherwise
 *    take the content as plain prose (the kind-1 text-note case).
 */
export function hitToDocument(hit: SampleHit): {
  body: string;
  suggestedName: string;
  eventMeta: SampleEventMeta;
} {
  const { event, relays } = hit;
  const compatible = TRACE_KINDS.has(event.kind);
  const inner = extractBody(event);

  // Exactly one trailing newline; the editor treats the body as a normal doc.
  const body = inner + (inner.endsWith("\n") ? "" : "\n");

  const pubkeyPrefix = event.pubkey.slice(0, 8);
  const idSlice = event.id.slice(0, 8);
  return {
    body,
    suggestedName: `samples/${pubkeyPrefix}-${idSlice}.md`,
    eventMeta: {
      eventId: event.id,
      pubkey: event.pubkey,
      kind: event.kind,
      createdAt: event.created_at,
      relays: [...relays],
      compatible,
    },
  };
}

/** Pull the readable body out of a sampled event's content. Never returns
 *  event metadata — only the text the user should see in the editor. */
function extractBody(event: Event): string {
  // Spec §R11.3: file and folder share kind 4290, discriminated by `z`. A
  // 4290 with z:folder renders its membership list; a 4290 with z:file (or a
  // legacy 4290 with no z) renders its snapshot text. Legacy 4292 also renders
  // as a folder membership list.
  const isFolder =
    event.tags.some((t) => t[0] === "z" && t[1] === "folder") ||
    event.kind === FOLDER_TRACE_NODE_KIND;
  if (isFolder) {
    const parsed = safeParse(event.content);
    const snapshot = isObject(parsed) ? parsed.snapshot : undefined;
    const members = isObject(snapshot) ? snapshot.members : undefined;
    if (Array.isArray(members) && members.length > 0) {
      const lines = members
        .map((m: unknown) => {
          const path = isObject(m) && typeof m.relativePath === "string" ? m.relativePath : null;
          return `- ${path ?? "(unnamed member)"}`;
        })
        .join("\n");
      return `${lines}\n`;
    }
    return "";
  }
  switch (event.kind) {
    case FILE_TRACE_NODE_KIND: {
      const parsed = safeParse(event.content);
      if (isObject(parsed) && typeof parsed.snapshot === "string") return parsed.snapshot;
      if (isObject(parsed) && Array.isArray(parsed.deltas)) {
        const replayed = replayDeltas(parsed.deltas);
        if (replayed) return replayed;
      }
      // A 4290 with neither snapshot nor usable deltas — the protocol says
      // snapshot is unconditional, so this shouldn't happen, but don't dump
      // raw JSON if it does.
      return "";
    }
    case TRACE_NAME_KIND: {
      const parsed = safeParse(event.content);
      if (isObject(parsed) && typeof parsed.name === "string") {
        // A name event's body is the name; keep it minimal and scannable.
        return `# ${parsed.name}\n`;
      }
      return "";
    }
    default: {
      // Foreign kind. Try to render content legibly; fall back to prose.
      const parsed = safeParse(event.content);
      if (isObject(parsed)) {
        return "```json\n" + JSON.stringify(parsed, null, 2) + "\n```\n";
      }
      return event.content;
    }
  }
}

/** `JSON.parse` that returns `null` on failure instead of throwing, so the
 *  body extractor can branch on parseability without try/catch noise. */
function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/** Narrow an unknown parse result to a record type, so property access stays
 *  typed instead of scattering `any` casts through the body extractor. */
type ParsedRecord = { [key: string]: unknown };
function isObject(v: unknown): v is ParsedRecord {
  return typeof v === "object" && v !== null;
}

// Replay a single event's deltas onto an empty string. Used only when a 4290
// node lacks a snapshot (non-normative but seen in older harness output).
function replayDeltas(
  deltas: Array<{ type: string; position: { start: number; end: number }; newValue: string | null }>,
): string {
  let content = "";
  for (const d of deltas) {
    content =
      content.slice(0, d.position.start) + (d.newValue ?? "") + content.slice(d.position.end);
  }
  return content;
}

// --- tag browsing (protocol §Tagging vs. bracketing) --------------------
//
// A tag always names a zine (a folder-trace), never a bare string. Browsing a
// tag is a three-channel union — lexical (#t), content-identity (#x on the
// zine's own contentHash), and transitive (one hop through the zine's own q
// out-edges) — resolved against whichever zine the caller picks when a name
// matches more than one folder-trace head (a folderId isn't a globally
// unique namespace). Ranking is untouched: results still feed the existing
// rankSampleHits (citationCount + alpha), same as any other sample. Hop
// depth is fixed at one — deeper, recursive fan-out is deliberately deferred
// (interaction-gated, not eager, per the protocol's Client UX note).

/** One candidate zine for a typed tag name — one per distinct owner whose
 *  current folder-trace head uses this folderId. Disambiguation surface for
 *  "type a name, pick which zine you mean". */
export interface TagCandidate {
  folderId: string;
  ownerPubkey: string;
  headEvent: Event;
  memberCount: number;
}

/** Resolve every current folder-trace head across `urls` whose folderId is
 *  `name` — one candidate per distinct owner, head-resolved the same way
 *  `fetchLatestFolderNode` does for a single known folder. Queries both the
 *  new kind-4290-with-`z:folder` form and legacy kind-4292 (spec §R11.3).
 *  Returns [] for a blank name or no matches. */
export async function resolveTagCandidates(name: string, urls: string[]): Promise<TagCandidate[]> {
  const trimmed = name.trim();
  if (!trimmed) return [];
  const [modern, legacy] = await Promise.all([
    sampleRelays(urls, { kinds: [TRACE_NODE_KIND], "#D": [trimmed] }),
    sampleRelays(urls, { kinds: [FOLDER_TRACE_NODE_KIND], "#D": [trimmed] }),
  ]);
  // Merge by event id; post-filter modern (4290) to folder-discriminated nodes.
  const byId = new Map<string, Event>();
  for (const hit of modern.hits) {
    if (hit.event.tags.some((t) => t[0] === "z" && t[1] === "folder")) byId.set(hit.event.id, hit.event);
  }
  for (const hit of legacy.hits) byId.set(hit.event.id, hit.event);
  const hits = [...byId.values()];
  const byOwner = new Map<string, Event[]>();
  for (const event of hits) {
    if (!byOwner.has(event.pubkey)) byOwner.set(event.pubkey, []);
    byOwner.get(event.pubkey)!.push(event);
  }
  const out: TagCandidate[] = [];
  for (const [ownerPubkey, events] of byOwner) {
    const head = resolveHead(events);
    if (!head) continue;
    out.push({ folderId: trimmed, ownerPubkey, headEvent: head, memberCount: membersFromNode(head).length });
  }
  return out;
}

/** Browse a tag: the three-channel union against a chosen zine.
 *  - lexical: `#t` = the zine's folderId
 *  - contentIdentity: `#x` = the zine's own contentHash (read off its head node)
 *  - transitive: `ids` = the zine's own `q`-tag targets (one hop, no recursion)
 *  Merges by event id across channels; each hit records which channel(s)
 *  surfaced it. Callers still run the result through `rankSampleHits` exactly
 *  as any other sample — channel membership is filter-only, not a scoring
 *  input. */
export async function browseTag(
  zine: TagCandidate,
  urls: string[],
): Promise<{
  hits: (SampleHit & { channels: Set<"lexical" | "contentIdentity" | "transitive"> })[];
  errors: { url: string; error: string }[];
}> {
  const parsed = safeParse(zine.headEvent.content);
  const contentHash =
    isObject(parsed) && typeof parsed.contentHash === "string" ? parsed.contentHash : undefined;
  const qIds = zine.headEvent.tags.filter((t) => t[0] === "q").map((t) => t[1]);

  const calls: { channel: "lexical" | "contentIdentity" | "transitive"; p: ReturnType<typeof sampleRelays> }[] = [
    { channel: "lexical", p: sampleRelays(urls, { "#t": [zine.folderId] }) },
  ];
  if (contentHash) {
    calls.push({ channel: "contentIdentity", p: sampleRelays(urls, { "#x": [contentHash] }) });
  }
  if (qIds.length > 0) {
    calls.push({ channel: "transitive", p: sampleRelays(urls, { ids: qIds }) });
  }

  const results = await Promise.all(calls.map((c) => c.p));
  const errors: { url: string; error: string }[] = [];
  const merged = new Map<string, SampleHit & { channels: Set<"lexical" | "contentIdentity" | "transitive"> }>();
  results.forEach((res, i) => {
    errors.push(...res.errors);
    const channel = calls[i].channel;
    for (const hit of res.hits) {
      const existing = merged.get(hit.event.id);
      if (existing) {
        existing.channels.add(channel);
        for (const r of hit.relays) if (!existing.relays.includes(r)) existing.relays.push(r);
      } else {
        merged.set(hit.event.id, { ...hit, channels: new Set([channel]) });
      }
    }
  });
  return { hits: [...merged.values()], errors };
}

// --- LLM call reconstruction (§3.7 read side) ---------------------------
//
// Given an `action: llm` node, reconstruct the { systemPrompt, userPrompt } the
// producing press assembled, by: reading `injectRule` + `llm` + `prompt` off
// the node content; fetching the rule manifest trace; fetching every cited
// nucleus (the q-tagged scope); and running the named algorithm over them.
// Degrades gracefully — unknown algorithm, missing rule, or unresolvable scope
// → returns `{ reconstructable: false, reason, scope }` so a reader still sees
// what was in scope even when the prompt can't be rebuilt.

/** The result of reconstructing an LLM call. On success, `systemPrompt` and
 *  `userPrompt` are byte-identical to what the press handed to the provider. On
 *  degradation, `scope` still lists what was cited (path/nodeId) so the call's
 *  inputs are visible even when the assembly isn't rebuildable. */
export interface ReconstructedCall {
  reconstructable: boolean;
  /** Present iff reconstructable. */
  systemPrompt?: string;
  userPrompt?: string;
  /** The typed instruction (`prompt`), present in both branches. */
  prompt: string;
  /** The model configuration that answered, if the node carried `llm`. */
  llm?: { model: string; temperature: number | null; maxTokens: number; provider: string };
  /** The manifest the rule trace carried, if resolved. */
  manifest?: { algorithm: string; params: Record<string, unknown> };
  /** Why reconstruction degraded, when it did. */
  reason?: "no-inject-rule" | "rule-unresolvable" | "unknown-algorithm" | "algorithm-failed";
  /** The cited scope (everything the node q-tags), resolved best-effort. */
  scope: { nodeId: string; relativePath?: string; action?: string }[];
}

/** Reconstruct the submitted prompts for an `action: llm` node. Fetches the
 *  rule trace + every cited nucleus across read relays (each is self-sufficient
 *  per §3.9 — one bounded fetch per id). Never throws: any failure degrades.
 *
 *  `node` is the raw kind-4290 LLM event. Returns the reconstruction result;
 *  `reconstructable: false` is a normal outcome (pre-§3.7 nodes, unknown
 *  algorithm, unreachable relay) and carries the scope where possible. */
export async function reconstructLlmCall(node: Event): Promise<ReconstructedCall> {
  let parsed: {
    prompt?: string;
    injectRule?: string;
    llm?: { model: string; temperature: number | null; maxTokens: number; provider: string };
  };
  try {
    parsed = JSON.parse(node.content);
  } catch {
    return { reconstructable: false, prompt: "", reason: "algorithm-failed", scope: [] };
  }
  const prompt = parsed.prompt ?? "";
  const scopeNodeIds = node.tags.filter((t) => t[0] === "q").map((t) => t[1]);

  // Fetch every cited nucleus best-effort. Each is self-sufficient, so a
  // missing one degrades rather than breaks — we still reconstruct off the
  // ones that resolved.
  const nuclei = new Map<string, { nodeId: string; snapshot: string; relativePath?: string; action?: string }>();
  const scope: { nodeId: string; relativePath?: string; action?: string }[] = [];
  for (const id of scopeNodeIds) {
    const ev = await fetchEventById(id).catch(() => null);
    if (!ev) {
      scope.push({ nodeId: id });
      continue;
    }
    let snapshot = "";
    try {
      const c = JSON.parse(ev.content) as { snapshot?: string };
      if (typeof c.snapshot === "string") snapshot = c.snapshot;
    } catch {
      /* non-JSON — snapshot stays "" */
    }
    const relativePath = ev.tags.find((t) => t[0] === "F")?.[1];
    const action = ev.tags.find((t) => t[0] === "action")?.[1];
    nuclei.set(id, { nodeId: id, snapshot, relativePath, action });
    scope.push({ nodeId: id, relativePath, action });
  }

  // Resolve the rule manifest trace.
  if (!parsed.injectRule) {
    return { reconstructable: false, prompt, llm: parsed.llm, reason: "no-inject-rule", scope };
  }
  const ruleEvent = await fetchEventById(parsed.injectRule).catch(() => null);
  if (!ruleEvent) {
    return { reconstructable: false, prompt, llm: parsed.llm, reason: "rule-unresolvable", scope };
  }
  // The manifest lives in the rule trace's `snapshot` body (the rule trace is
  // a minted span whose body IS the manifest JSON). Unwrap: parse the event
  // content, read `snapshot`, parse THAT as the manifest.
  let manifest: { algorithm: string; params: Record<string, unknown> };
  try {
    const ruleContent = JSON.parse(ruleEvent.content) as { snapshot?: string };
    manifest = JSON.parse(ruleContent.snapshot ?? "{}") as { algorithm: string; params: Record<string, unknown> };
  } catch {
    return { reconstructable: false, prompt, llm: parsed.llm, reason: "rule-unresolvable", scope };
  }
  if (!manifest?.algorithm) {
    return { reconstructable: false, prompt, llm: parsed.llm, manifest, reason: "rule-unresolvable", scope };
  }

  // Run the named algorithm. Dynamic import avoids pulling the algorithm
  // registry into every caller of this module (it's only needed on reconstruct).
  const { ALGORITHMS } = await import("./inject-algorithms.js");
  const fn = ALGORITHMS[manifest.algorithm];
  if (!fn) {
    return { reconstructable: false, prompt, llm: parsed.llm, manifest, reason: "unknown-algorithm", scope };
  }
  const result = fn({ prompt, nuclei, manifest });
  if (!result) {
    return { reconstructable: false, prompt, llm: parsed.llm, manifest, reason: "algorithm-failed", scope };
  }
  return {
    reconstructable: true,
    prompt,
    llm: parsed.llm,
    manifest,
    systemPrompt: result.systemPrompt,
    userPrompt: result.userPrompt,
    scope,
  };
}

export {
  FILE_TRACE_NODE_KIND,
  TRACE_NAME_KIND,
  FOLDER_TRACE_NODE_KIND,
  TRACE_ALPHA_KIND,
  FOLDER_MANIFEST_KIND,
};

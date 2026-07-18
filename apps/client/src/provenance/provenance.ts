import { finalizeEvent, getPublicKey, verifyEvent } from "nostr-tools/pure";
import type { Event, EventTemplate } from "nostr-tools";
import type { Filter } from "nostr-tools";
import { vaultStorage as localStorage } from "../storage/vault-storage.js";
import { Relay } from "nostr-tools/relay";
import {
  createTraceOperationId,
  isTraceOperationId,
  parseKEditsFromContent,
  synthesizeKEditTransition,
  traceOperationIdFromEvent,
  validateKEditTransition,
  verifyFolderTraceChain,
  type FolderCheckpoint,
  type KEdit,
} from "@zine/protocol";

export type { KEdit, KEditIntent } from "@zine/protocol";

import { loadOrCreateVoice, resolveRelayUrl } from "../identity/identity.js";
import {
  isLoopbackRelayUrl,
  publicationRelays,
  readRelays,
  writeRelays,
} from "../networking/relay-config.js";
import type { Run } from "../workspace/workspace-core.js";
import {
  dominantVoiceInRegion,
  flattenRuns,
} from "../workspace/workspace-core.js";
import { authorSecretKey, nodeSecretKey } from "../identity/keys-store.js";
import {
  enqueueLocalEvent,
  pendingLocalEventById,
  pendingLocalEvents,
  pendingLocalEventsMatching,
  removeLocalEvent,
} from "./event-outbox.js";

/**
 * Bridge between the editor and the local relay. Publishes and fetches the
 * wire shapes defined by the protocol (trace-provenance.md) — a kind-4290
 * stepped here is readable by any spec-compliant reader (other presses, the
 * MCP headless press, the hosted relay).
 *
 * `oldValue` is intentionally omitted on delta serialization because it is
 * recoverable from the preceding snapshot.
 */

/** The single TraceNode kind; `z` discriminates file and folder nodes. */
export const TRACE_NODE_KIND = 4290;
const HEX_64 = /^[0-9a-f]{64}$/;
/** Spec §5A: append-only endorsement of one published TraceNode. This is a
 *  separate regular kind because an endorsement is not a body revision and
 *  therefore cannot truthfully carry TraceNode snapshot/delta/prev fields. */
const TRACE_ATTESTATION_KIND = 4294;
/** Spec §4: TraceHead — parameterized replaceable head-pointer cache. `d` =
 *  trace identity, content `{ head }`, written on every step. */
const TRACE_HEAD_KIND = 34290;

function authoringVoice(): { secretKey: Uint8Array; publicKey: string } {
  const secretKey = authorSecretKey();
  if (secretKey) return { secretKey, publicKey: getPublicKey(secretKey) };
  // The headless press owns a separate authoring session and does not use the
  // desktop key-profile bootstrap.
  return loadOrCreateVoice();
}

/** The trace-provenance kinds. Used to decide whether a sampled event is
 *  zine/trace-compatible (renders as a body) or foreign (renders with a "not a
 *  zine trace" badge). Per spec §1 the canonical set is {4290, 34290, 34291};
 *  only the body-carrying kind 4290 renders as a trace here (the replaceable
 *  kinds are current-state caches, not bodies). See protocol/trace-provenance.md
 *  §Event kinds. */
const TRACE_KINDS = new Set<number>([
  TRACE_NODE_KIND, // 4290 — file AND folder nodes (z tag discriminates)
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
  /** True for kind 4290 — drives the kind badge. */
  compatible: boolean;
}

/** One file's entry in its folder's membership (`snapshot.members` on a
 *  folder-reified 4290 node). Shape is fixed by the protocol so a folder node
 *  written here is readable by any spec-compliant reader. Under spec-clean
 *  tombstones (protocol §FolderTraceNode), a deleted file leaves the snapshot
 *  via a `remove` delta rather than staying as a tombstoned entry — so this
 *  type carries no tombstone field. */
export interface ManifestFileEntry {
  /** "file" or "folder". Mirrors the member entry (spec §3.2): a folder member
   *  is itself a folder trace. */
  kind: "file" | "folder";
  relativePath: string;
  latestNodeId: string;
  contentHash: string;
}

export interface EditorDelta {
  type: "insert" | "delete" | "replace";
  positionStart: number;
  positionEnd: number;
  newValue: string | null;
  timestamp: number;
}

/** How an immutable Coin entered the Mint. The content envelope is the
 * durable Coin discriminator: extracted Coins additionally retain a queryable
 * `extracted-from` edge, while direct Coins intentionally have no source
 * claim. */
export interface DirectCoinOrigin {
  kind: "direct";
}

export interface ExtractedCoinOrigin {
  kind: "extracted";
  /** Exact source nucleus whose snapshot contained the coined bytes. */
  sourceNodeId: string;
  /** SHA-256 of that source node's complete snapshot. */
  sourceContentHash: string;
  /** UTF-16 range of the Coin body inside the source snapshot. */
  range: { start: number; end: number };
}

export type CoinOrigin = DirectCoinOrigin | ExtractedCoinOrigin;

/**
 * Minimal common-prefix/suffix diff. Returns the deltas that turn `oldText`
 * into `newText`. For the debounce-level publish path this is enough: a run
 * of consecutive typing produces one contiguous change region, which this
 * captures exactly. Finer granularity (merging adjacent delete+insert into
 * replace) isn't needed here because the editor's own transactions are
 * already the per-op granularity — this diff is only to summarize the
 * accumulated change since last step.
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
 * gives the footprint of *this step's* deltas without re-parsing event JSON.
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
// per node. That's enough to say *who stepped* a checkpoint, but it collapses
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
  // let the caller attribute by signer.
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

/**
 * Attribute each delta to its dominant voice and build the node-local voices
 * table (protocol §3.3, §3.6). For each insert/replace delta, find the dominant
 * voice in the delta's region of the post-edit runs. If it's the signer, no
 * authorIndex is set. If it's a non-signer
 * voice, the voices table is built with the signer at [0] and the delta gets
 * authorIndex pointing into it.
 *
 * Returns the (possibly annotated) deltas and the voices table. An empty voices
 * table means the caller omits the field — pure mono-author nodes stay compact.
 */
export function attributeDeltas(
  deltas: EditorDelta[],
  runs: Run[],
  signerPubkey: string,
): { deltas: (EditorDelta & { authorIndex?: number })[]; voices: string[] } {
  // Collect all non-signer voices that appear in any delta's dominant region.
  // The voices table is [signer, ...non-signers in first-seen order].
  const nonSignerVoices: string[] = [];
  const voiceIndex = new Map<string, number>();
  voiceIndex.set(signerPubkey, 0);

  // First pass: determine which deltas need attribution and collect voices.
  const annotated = deltas.map((d) => {
    if (d.type === "delete" || !d.newValue) return { ...d }; // no inserted text
    const regionLen = d.newValue.length;
    if (regionLen === 0) return { ...d };
    // The delta's region in the post-edit snapshot is [positionStart, positionStart + regionLen].
    const dominant = dominantVoiceInRegion(runs, d.positionStart, d.positionStart + regionLen);
    if (!dominant || dominant === signerPubkey) return { ...d }; // signer — no index
    // Non-signer voice — add to the table if not already present.
    if (!voiceIndex.has(dominant)) {
      nonSignerVoices.push(dominant);
      voiceIndex.set(dominant, nonSignerVoices.length); // signer is [0], so first non-signer is [1]
    }
    return { ...d, authorIndex: voiceIndex.get(dominant) };
  });

  const voices = nonSignerVoices.length > 0 ? [signerPubkey, ...nonSignerVoices] : [];
  return { deltas: annotated, voices };
}

export interface PublishEditInput {
  prevEventId: string | null;
  /** The exact signed snapshot of `prevEventId`, or the empty string for
   * genesis. Required so the publisher can prove `kedits` reproduces this
   * transition before signing it. */
  previousSnapshot: string;
  /** Stable identity of the file trace being extended. Genesis callers may
   * omit it: the signed genesis event id becomes the identity. Existing-chain
   * callers SHOULD pass it so a file TraceHead can be refreshed without a
   * path-keyed chain scan. */
  traceId?: string;
  /** Causal transaction shared with folder roll-ups from this Step. A caller
   * may provide one when coordinating a larger gesture; standalone writers
   * receive a fresh cryptographically random id. */
  operationId?: string;
  relativePath: string;
  folderId: string;
  deltas: EditorDelta[];
  snapshot: string;
  contentHash: string;
  /** When true, step to the home relay only — don't fan out to external write
   *  relays. This is the Step gesture (protocol §8): a local checkpoint that
   *  doesn't leave the machine. The user later Sends (pushToExternalRelays)
   *  if they want the node reachable by others. Default false. */
  localOnly?: boolean;
  /** Per-character attribution for `snapshot`, serialized into the node's
   *  `authors` field (protocol §FileTraceNode Content). Concatenating the runs'
   *  text in order MUST reproduce `snapshot` exactly; readers validate this and
   *  fall back to per-node-signer attribution on mismatch. Absent → the node is
   *  stepped with signer-only attribution. This is the durable, reconstructable-from-chain carrier
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
   *  nodeId ]]` it contains on each step (spec:189). The read side
   *  (`eventMeta.citationCount`) and the Times view already count `q` tags; this
   *  is the emission half that was missing. Absent on minted-span genesis
   *  (those nodes are the *cited* thing) and on delete tombstones (empty
   *  snapshot, nothing to cite). */
  citations?: string[];
  /** Inline coin occurrences newly installed by this Step. Unlike `citations`
   * (the cumulative current q-set), these are gesture-local and become
   * `cite role:inline` deltas with the quote bytes, range, pinned coin id, and
   * quote hash. Omitted when the Step installs no inline citation. */
  inlineCitations?: {
    sourceEventId: string;
    newValue: string;
    positionStart: number;
    positionEnd: number;
    sourceContentHash?: string;
  }[];
  /** Optional override signer (secret key bytes). Defaults to the keychain's
   *  manual (pen) key via loadOrCreateVoice() — the posture every existing step
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
  /** Coin discriminator and origin receipt (spec §3.8). Extracted Coins emit
   *  the queryable `extracted-from` edge in addition to this content envelope;
   *  direct Coins carry no source edge. Absent on every mutable file trace. */
  coinOrigin?: CoinOrigin;
  /** Body hash for the `x` tag (spec §3.1: REQUIRED on minted-span nodes and
   *  folder nodes, OPTIONAL on named file nodes — an open question). When set,
   *  emits `["x", bodyHashTag]`, enabling `#x` content-identity queries that
   *  find every trace with an identical body whoever minted it. For a minted
   *  span this is `sha256(snapshot)`; for a folder, the canonical folder body
   *  hash. Named files leave this unset (opting out of cross-folder copy
   *  detection per the spec's open question). */
  bodyHashTag?: string;
  /** The stepped node id this whole document is replying to (the Reply
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
  citationIds?: string[];
  /** The complete editor-action log since the previous Step: one `KEdit` per discrete
   *  editor transaction change (every backspace, highlight-delete, type-over,
   *  undo, redo, IME commit, streamed LLM token). Non-editor transitions such
   *  as an import or fork use one explicitly synthetic atomic transaction.
   *  This field is REQUIRED on file nodes and MUST replay `previousSnapshot`
   *  exactly to `snapshot`; `[]` is valid only when the body is unchanged. */
  kedits: KEdit[];
  /** `action: llm` only — the op-specific instruction/body supplied by the
   *  press, excluding reconstructable folder context. Required by §3.7. */
  prompt?: string;
  /** `action: llm` only — the event id of the minted rule-manifest trace
   *  whose body names the expansion algorithm + params (protocol §3.7). Each
   *  LLM step cites its rule so a reader can reconstruct the submitted prompt.
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

export interface ResolvedInlineCitation {
  sourceEventId: string;
  newValue: string;
  positionStart: number;
  positionEnd: number;
  sourceContentHash: string;
}

/** Build the gesture-local wire deltas paired with cumulative q tags for newly
 * installed coin citations. Kept pure so the provenance contract is directly
 * regression-testable without a relay. */
export function inlineCitationDeltas(
  citations: ResolvedInlineCitation[],
  timestamp: number,
): Record<string, unknown>[] {
  return citations.map((citation) => ({
    type: "cite",
    role: "inline",
    op: "add",
    position: {
      start: citation.positionStart,
      end: citation.positionEnd,
    },
    newValue: citation.newValue,
    sourceEventId: citation.sourceEventId,
    sourceContentHash: citation.sourceContentHash,
    timestamp,
  }));
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
 *  of `PublishEditInput.citationIds`: on attach, a file's tagged traces are
 *  recovered as (head q-tags) minus (body brackets), so a tag survives reload
 *  without being re-added. `bracketNodeIds` is the caller's
 *  `findResolvedBrackets(content).map(b => b.nodeId)` — kept a parameter so this
 *  helper stays free of a brackets.js import. Returns [] for an empty chain. */
export function headCitationIds(chain: Event[], bracketNodeIds: string[]): string[] {
  if (chain.length === 0) return [];
  const targets = eventMeta(chain[chain.length - 1]).citationTargets;
  const bracket = new Set(bracketNodeIds);
  // Preserve head order; drop only ids the body already cites (those are
  // recovered from the body on every step, not stored as tagged traces).
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
 *  js:3620-3634). In networked mode (transport.md §5) the sidecar challenges
 *  every connection; this handler signs the kind-22242 AUTH event with the
 *  NODE key so the relay recognizes the press as owner. In local mode the
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
 *  complete. In networked mode the relay rejects every event/filter with
 *  "auth-required:" until AUTH is processed. We bridge this by tracking the
 *  auth completion as a promise and awaiting it (with a short timeout) before
 *  returning the relay. In local mode the relay never challenges, so the
 *  promise never resolves — the timeout (1.5s) handles that gracefully. */
async function connectWithAuth(url: string): Promise<Relay> {
  const relay = new Relay(url);
  let authResolve: (() => void) | undefined;
  const authDone = new Promise<void>((resolve) => {
    authResolve = resolve;
  });
  relay.onauth = async (evt) => {
    // The AUTH challenge is signed with the NODE (owner) key — the identity the
    // relay recognizes as owner (the `owner` field in peers.json). Before the
    // Route through the NODE role so AUTH stays consistent with onion derivation
    // and the owner record. Headless/browser presses use their session authoring
    // identity because they do not have the desktop role keychain.
    const secret = nodeSecretKey() ?? authoringVoice().secretKey;
    const signed = finalizeEvent(evt, secret) as unknown as
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
// each spawning their own. Without this, N step/fetch sites calling
// getWriteRelays/getReadRelays at slightly offset times run N overlapping retry
// loops; with a flat delay those rounds interleave into a reconnect burst that
// a rate-limiting proxy (or a freshly-booting sidecar) sees as one big spike —
// and 429s. Coalescing means one Relay.connect per round, no matter how many
// callers are waiting on the same URL.
const retryingCache = new Map<string, Promise<Relay | null>>();
const relayUnavailableUntil = new Map<string, number>();

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
  if ((relayUnavailableUntil.get(url) ?? 0) > Date.now()) return null;
  const existing = retryingCache.get(url);
  if (existing) return existing;
  const p = (async (): Promise<Relay | null> => {
    try {
      let lastErr: unknown;
      for (let i = 0; i < maxAttempts; i++) {
        try {
          const relay = await getRelay(url);
          relayUnavailableUntil.delete(url);
          return relay;
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
      relayUnavailableUntil.set(url, Date.now() + 5_000);
      return null;
    } finally {
      retryingCache.delete(url);
    }
  })();
  retryingCache.set(url, p);
  return p;
}

/** Connect to every write-enabled relay. Order matches the user's list. */
export async function getWriteRelays(): Promise<Relay[]> {
  const urls = writeRelays().map((e) => e.url);
  const out: Relay[] = [];
  for (const url of urls) {
    if (out.some((r) => r.url === url)) continue;
    const r = await getRelayRetrying(url);
    if (r) out.push(r);
  }
  return out;
}

/** Connect to each configured destination that crosses the machine boundary. */
export async function getPublicationRelays(): Promise<Relay[]> {
  const urls = publicationRelays().map((entry) => entry.url);
  const out: Relay[] = [];
  for (const url of urls) {
    if (out.some((relay) => relay.url === url)) continue;
    const relay = await getRelayRetrying(url);
    if (relay) out.push(relay);
  }
  return out;
}

/** Connect to every read-enabled relay. Order matches the user's list. */
export async function getReadRelays(): Promise<Relay[]> {
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
 * retry pattern here so networked-mode relays accept our writes. The relay's
 * onauth handler (set in connectWithAuth) signs the AUTH event with the NODE
 * owner key.
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
export async function publishToMany(relays: Relay[], event: Event): Promise<void> {
  if (relays.length === 0) {
    throw new Error("no relays available to publish to");
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

// --- Voice identity declarations (kind 34292) ----------------------------
//
// A voice's visual identity (font, hue, sat) is a personal choice, not a hash.
// kind-34292 is a NIP-33 replaceable parameterized event: the `d` tag is the
// owner's pubkey, content is the JSON { font, hue, sat }. Foreign readers fetch
// it so they see the author's chosen colors instead of the deterministic hash
// fallback. Published best-effort by KeysView.updateIdentity; fetched by
// keys-store.identityForPubkey when resolving colors for a pubkey the local
// keychain doesn't own (e.g. the Times chart minters).

/** Fetch the latest kind-34292 voice-identity declaration for a pubkey from the
 *  read relays. Returns null if none is found (caller falls back to the hash).
 *  Best-effort: a down relay contributes nothing. */
export async function fetchVoiceIdentity(pubkey: string): Promise<{ font: string; hue: number; sat: number } | null> {
  const relays = await getReadRelays();
  const events = await queryMany(relays, {
    kinds: [34292],
    authors: [pubkey],
    "#d": [pubkey],
    limit: 1,
  });
  if (events.length === 0) return null;
  // Pick the newest (queryMany dedupes by id; multiple relays may return the
  // same event, or different replacements — newest wins).
  const newest = events.sort((a, b) => b.created_at - a.created_at)[0];
  try {
    const parsed = JSON.parse(newest.content);
    if (
      typeof parsed === "object" && parsed !== null &&
      typeof parsed.font === "string" &&
      typeof parsed.hue === "number" &&
      typeof parsed.sat === "number"
    ) {
      return { font: parsed.font, hue: parsed.hue, sat: parsed.sat };
    }
  } catch {
    // Malformed content — fall through to null.
  }
  return null;
}

/** Publish a kind-34292 voice-identity declaration so foreign readers see the
 *  author's chosen colors. NIP-33 replaceable: `d` tag = the voice's pubkey.
 *  Fire-and-forget from KeysView — a publish failure only means a foreign
 *  reader sees the hash fallback. */
export async function publishVoiceIdentity(
  identity: { font: string; hue: number; sat: number },
  signer: Uint8Array,
  pubkey: string,
): Promise<void> {
  const template = {
    kind: 34292,
    created_at: Math.floor(Date.now() / 1000),
    tags: [["d", pubkey]],
    content: JSON.stringify(identity),
  };
  const signed = finalizeEvent(template, signer);
  const relays = await getWriteRelays();
  await publishToMany(relays, signed);
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

export interface LlmStepMeta {
  prompt: string;
  injectRule: string;
  scopeCitations: string[];
  llm: { model: string; temperature: number | null; maxTokens: number; provider: string };
  /** Reply pins its source now but publishes only on the later explicit Step. */
  replyingTo?: string;
}

/** §3.7 metadata waiting for the write-back Step, isolated by destination
 * path so concurrent panel operations cannot consume one another's call data. */
const pendingLlmMeta = new Map<string, LlmStepMeta>();

/** Set the metadata consumed by the next publishEdit for this exact path. */
export function setPendingLlmMeta(relativePath: string, meta: LlmStepMeta): void {
  pendingLlmMeta.set(relativePath, meta);
}

export function takePendingLlmMeta(relativePath: string): LlmStepMeta | undefined {
  const meta = pendingLlmMeta.get(relativePath);
  pendingLlmMeta.delete(relativePath);
  return meta;
}

export function clearPendingLlmMeta(relativePath: string): void {
  pendingLlmMeta.delete(relativePath);
}

export function applyPendingLlmMeta(input: PublishEditInput): void {
  const llmMeta = takePendingLlmMeta(input.relativePath);
  if (!llmMeta) return;
  input.action = "llm";
  input.prompt = llmMeta.prompt;
  input.injectRule = llmMeta.injectRule;
  input.scopeCitations = [
    ...(input.scopeCitations ?? []),
    ...llmMeta.scopeCitations,
  ];
  if (llmMeta.replyingTo) input.replyingTo = llmMeta.replyingTo;
  if (!input.llm) input.llm = llmMeta.llm;
}

/** Builds, signs, and publishes a kind-4290 FileTraceNode. Returns the signed
 *  event (its `id` is the new node id the caller should track as prevEventId). */
export async function publishEdit(input: PublishEditInput): Promise<Event> {
  if (!Array.isArray(input.kedits)) {
    throw new Error("cannot publish a file Step without its required KEdit array");
  }
  if (input.prevEventId === null && input.previousSnapshot !== "") {
    throw new Error("file-trace genesis KEdits must start from the empty snapshot");
  }
  const keditValidation = validateKEditTransition(
    input.previousSnapshot,
    input.snapshot,
    input.kedits,
  );
  if (!keditValidation.valid) {
    throw new Error(`cannot publish a file Step with invalid KEdits: ${keditValidation.reason}`);
  }
  // §3.7: consume path-keyed, single-use LLM metadata. The client's generic
  // write-back path defaults to action:edit; this exact-path entry marks the
  // corresponding Step as action:llm without crossing concurrent panels.
  applyPendingLlmMeta(input);
  const inlineCitations = await Promise.all(
    (input.inlineCitations ?? []).map(async (citation) => ({
      ...citation,
      sourceContentHash:
        citation.sourceContentHash ?? await sha256HexLocal(citation.newValue),
    })),
  );
  // Advisory action follows the protocol precedence: a Step whose ordinary
  // body edit installs a coin is primarily a citation. Higher-order callers
  // (LLM, merge, fork, …) retain their explicit action.
  if (inlineCitations.length > 0 && (!input.action || input.action === "edit")) {
    input.action = "cite";
  }
  // Sign as the override signer when provided (per-voice Send/zine), else the
  // keychain's manual (pen) key — the posture used by background Steps.
  const signer = input.signer ?? authoringVoice().secretKey;
  const steppedAt = Date.now();
  const operationId = input.operationId ?? createTraceOperationId();
  if (!isTraceOperationId(operationId)) {
    throw new Error("cannot publish a file Step with a malformed operation id");
  }

  const tags: string[][] = [
    // Reification discriminator (protocol §3.1: REQUIRED on every node).
    ["z", "file"],
    ["F", input.relativePath],
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
  // Extraction lineage remains a queryable tag for extracted Coins. Direct
  // Coins deliberately omit it: the signer minted these exact bytes without
  // claiming they came from another node.
  if (input.coinOrigin?.kind === "extracted") {
    tags.push(["e", input.coinOrigin.sourceNodeId, "", "extracted-from"]);
  }
  // Body hash (spec §3.1: REQUIRED on minted-span nodes). Enables `#x`
  // content-identity queries. Named files omit it (spec open question — opting
  // out of cross-folder copy detection for byte-identical files).
  if (input.bodyHashTag) tags.push(["x", input.bodyHashTag]);

  // t-tags: topical labels only — no folder-name tag is derived or prepended.
  for (const tag of buildTTags(input.tags ?? [])) {
    tags.push(["t", tag]);
  }

  // q-tags: one per coin this trace cites (spec:189 — the origin doc's
  // cite of each minted node, mirrored at top level), the Reply source
  // (replyingTo), and the tagged zines (citationIds) — all the same
  // "composition" edge, folded into one dedup so a trace cited more than one way
  // (quoted AND tagged, or tagged AND replied-to) never emits two q-tags.
  // NIP-18 quote shape, read back by `eventMeta` (citationCount +
  // citationTargets) and ranked on by the Times view.
  const qTargets = [
    ...(input.citations ?? []),
    ...(input.replyingTo ? [input.replyingTo] : []),
    ...(input.citationIds ?? []),
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
  const attributed: {
    deltas: (EditorDelta & { authorIndex?: number })[];
    voices: string[];
  } = input.authors && authors
    ? attributeDeltas(input.deltas, input.authors, getPublicKey(signer))
    : { deltas: input.deltas, voices: [] };

  const template: EventTemplate = {
    kind: TRACE_NODE_KIND,
    created_at: Math.floor(steppedAt / 1000),
    tags,
    content: JSON.stringify({
      steppedAt,
      // Spec-compliant: no `oldValue` (recoverable from prev.snapshot).
      deltas: [
        ...attributed.deltas.map((d) => ({
          type: d.type,
          position: { start: d.positionStart, end: d.positionEnd },
          newValue: d.newValue,
          timestamp: d.timestamp,
          ...(d.authorIndex !== undefined ? { author: d.authorIndex } : {}),
        })),
        // Gesture-local inline coin citations. The body-edit delta still
        // carries the literal bracket insertion for replay/integrity; this
        // companion delta says where those bytes came from.
        ...inlineCitationDeltas(inlineCitations, steppedAt),
        // Citation deltas (spec §3.3: one `cite` delta type, five roles).
        // `role: "reply"` — this document replies to another stepped trace: no
        // position/newValue; body untouched. The pinned source is the paired
        // `q` tag above; this marks *which* q-tag is "this doc's subject".
        ...(input.replyingTo
          ? [{ type: "cite", role: "reply", op: "add", sourceEventId: input.replyingTo, timestamp: steppedAt }]
          : []),
        // `role: "tag"` — a zine tagged onto this trace: no position/newValue;
        // body untouched. One entry per tagged zine; the pinned source is the
        // paired `q` tag above. `snapshot`/`contentHash` are untouched (a tag
        // never alters the body), so these are observations, like reply.
        ...(input.citationIds ?? []).map((nodeId) => ({
          type: "cite",
          role: "tag",
          op: "add",
          sourceEventId: nodeId,
          timestamp: steppedAt,
        })),
      ],
      snapshot: input.snapshot,
      contentHash: input.contentHash,
      operationId,
      // Explicit discriminator shared by direct and extracted Coins. Readers
      // no longer have to infer "Coin" solely from an extraction edge.
      ...(input.coinOrigin
        ? { coin: { version: 1, origin: input.coinOrigin } }
        : {}),
      // Per-character attribution, validated against snapshot above. Absent on
      // nodes whose caller had no run list (genesis from plain text or deletes)
      // — readers fall back to per-node-signer.
      ...(authors && authors.length > 0 ? { authors } : {}),
      ...(attributed.voices.length > 0 ? { voices: attributed.voices } : {}),
      // Required process log for this exact file transition. Metadata-only and
      // forced checkpoints carry an explicit empty array; content-changing
      // transitions were replay-validated before signing above.
      kedits: input.kedits,
      ...(input.summary ? { summary: input.summary } : {}),
      // §3.7: action:llm nodes name their expansion rule + call configuration.
      // `injectRule` is the event id of the minted rule-manifest trace; `llm`
      // records the model/temperature/maxTokens/provider that answered. Both
      // absent on non-LLM nodes (readers treat as "not an LLM call").
      ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
      ...(input.injectRule ? { injectRule: input.injectRule } : {}),
      ...(input.llm ? { llm: input.llm } : {}),
    }),
  };

  const signed = finalizeEvent(template, signer);
  // Step (localOnly): publish to the home relay only — the node is recorded but
  // hasn't left the machine. A newly-created Step under Send fans out to all
  // write-enabled relays. Sending unchanged state uses sendStep on the existing
  // node instead of creating another checkpoint.
  let publishedRelays: Relay[];
  if (input.localOnly) {
    // localStorage is the first durability boundary. Queue the exact signed
    // event before touching the relay so an offline Step can return a stable id
    // and later synchronization publishes those same bytes rather than minting
    // a sibling replacement.
    enqueueLocalEvent(signed);
    const homeUrl = resolveRelayUrl();
    const homeRelay = await getRelayRetrying(homeUrl, 1);
    if (homeRelay) {
      await flushLocalEventOutboxThrough(homeRelay);
      publishedRelays = pendingLocalEventById(signed.id) ? [] : [homeRelay];
    } else {
      publishedRelays = [];
    }
  } else {
    const relays = await getWriteRelays();
    await publishToMany(relays, signed);
    publishedRelays = relays;
  }

  // File traces use the same TraceHead cache as folder traces (§4). The
  // genesis event id is the identity; later callers pass it explicitly. A
  // cache publish failure must not turn an already-durable Step into a retry
  // that creates a sibling branch, so this remains best-effort and the signed
  // prev-chain stays authoritative.
  const traceIdentity = input.traceId ?? (input.prevEventId ? null : signed.id);
  // Coins are immutable one-node traces; §4 needs no mutable head cache for
  // them. A fork promoted from a coin has `forkedFrom` (not `coinOrigin`)
  // and is mutable, so it still receives TraceHead normally.
  if (traceIdentity && !input.coinOrigin && publishedRelays.length > 0) {
    try {
      await publishTraceHead(traceIdentity, signed.id, signer, publishedRelays);
    } catch (error) {
      console.warn(`[provenance] TraceHead publish failed for ${traceIdentity}:`, error);
    }
  }
  return signed;
}

/** Parse the signed Coin envelope. `extracted-from` is only a query index; it
 * never makes an otherwise ordinary file event into a Coin. */
export function coinOriginFromEvent(event: Event): CoinOrigin | null {
  try {
    const parsed = JSON.parse(event.content) as {
      snapshot?: unknown;
      contentHash?: unknown;
      coin?: { version?: unknown; origin?: unknown };
    };
    const tags = (name: string) => event.tags.filter((tag) => tag[0] === name);
    const z = tags("z");
    const fileName = tags("F");
    const folder = tags("f");
    const bodyHash = tags("x");
    const action = tags("action");
    const previous = event.tags.filter(
      (tag) => tag[0] === "e" && tag[3] === "prev",
    );
    const extractedFrom = event.tags.filter(
      (tag) => tag[0] === "e" && tag[3] === "extracted-from",
    );
    if (
      event.kind !== TRACE_NODE_KIND ||
      z.length !== 1 || z[0]?.[1] !== "file" ||
      fileName.length !== 1 || !fileName[0]?.[1] || fileName[0][1].includes("/") ||
      folder.length !== 1 || !HEX_64.test(folder[0]?.[1] ?? "") ||
      bodyHash.length !== 1 || !HEX_64.test(bodyHash[0]?.[1] ?? "") ||
      action.length !== 1 || action[0]?.[1] !== "import" ||
      previous.length !== 0 ||
      typeof parsed.snapshot !== "string" ||
      typeof parsed.contentHash !== "string" ||
      parsed.contentHash !== bodyHash[0]?.[1]
    ) {
      return null;
    }
    const origin = parsed.coin?.origin;
    if (parsed.coin?.version === 1 && origin && typeof origin === "object") {
      const candidate = origin as Record<string, unknown>;
      if (candidate.kind === "direct" && extractedFrom.length === 0) {
        return { kind: "direct" };
      }
      const range = candidate.range && typeof candidate.range === "object"
        ? candidate.range as Record<string, unknown>
        : null;
      if (
        candidate.kind === "extracted" &&
        typeof candidate.sourceNodeId === "string" && HEX_64.test(candidate.sourceNodeId) &&
        typeof candidate.sourceContentHash === "string" &&
        HEX_64.test(candidate.sourceContentHash) &&
        extractedFrom.length === 1 &&
        extractedFrom[0]?.[1] === candidate.sourceNodeId &&
        range &&
        Number.isInteger(range.start) &&
        Number.isInteger(range.end) &&
        (range.start as number) >= 0 &&
        (range.end as number) >= (range.start as number)
      ) {
        return {
          kind: "extracted",
          sourceNodeId: candidate.sourceNodeId,
          sourceContentHash: candidate.sourceContentHash,
          range: { start: range.start as number, end: range.end as number },
        };
      }
    }
  } catch {
    // Invalid or non-JSON content is not a Coin.
  }
  return null;
}

/** True only when the event carries a valid current Coin envelope. */
export function isCoinEvent(event: Event): boolean {
  return coinOriginFromEvent(event) !== null;
}

/** Send: push an already-stepped node to all write-enabled external relays.
 *  This is the deliberate "let this leave my machine" gesture (protocol §8) —
 *  the node was stepped locally (by a Step), and now the author chooses to make
 *  it reachable by others. Idempotent: re-sending a node that's already on a
 *  relay is a no-op (the relay dedupes by event id). */
export async function sendStep(event: Event, signer?: Uint8Array): Promise<void> {
  const relays = await getPublicationRelays();
  if (relays.length === 0) {
    throw new Error(
      "no publication relays available — configure a non-loopback write relay before Send",
    );
  }
  await publishToMany(relays, event);
  if (isCoinEvent(event)) return;
  try {
    const traceId = await resolveTraceIdentity(event.id);
    if (traceId) {
      await publishTraceHead(
        traceId,
        event.id,
        signer ?? authoringVoice().secretKey,
        relays,
      );
    }
  } catch (error) {
    // The immutable Step has already been sent. As in publishEdit, a head-cache
    // failure must not turn successful distribution into a duplicate Step.
    console.warn(`[provenance] sent Step ${event.id} without TraceHead:`, error);
  }
}

/** Publish one exact historical node without moving the trace's replaceable
 * head. Replay may expose an ancestor while the live trace has advanced; using
 * the ordinary Send path there would incorrectly advertise that ancestor as
 * current. Relay publication remains idempotent by event id. */
export async function sendHistoricalStep(event: Event): Promise<void> {
  const relays = await getPublicationRelays();
  if (relays.length === 0) {
    throw new Error(
      "no publication relays available — configure a non-loopback write relay before Send",
    );
  }
  await publishToMany(relays, event);
}

/** Publish the ordered local signed-event outbox to the current home relay.
 * Stops at the first failed event so file/folder dependency order is retained.
 * TraceHead events are caches; the immutable queued nodes remain authoritative
 * and the next online Step refreshes the cache normally. */
export async function flushLocalEventOutbox(): Promise<{
  pending: number;
  published: number;
}> {
  const records = pendingLocalEvents();
  if (records.length === 0) return { pending: 0, published: 0 };
  const relay = await getRelayRetrying(resolveRelayUrl());
  if (!relay) return { pending: records.length, published: 0 };
  return flushLocalEventOutboxThrough(relay);
}

let localOutboxFlushQueue: Promise<unknown> = Promise.resolve();

/** Serialize every outbox drain, including foreground Steps and the MCP
 * background timer, so concurrent tool calls cannot overtake older events. */
function flushLocalEventOutboxThrough(relay: Relay): Promise<{
  pending: number;
  published: number;
}> {
  const task = localOutboxFlushQueue.then(async () => {
    const records = pendingLocalEvents();
    let published = 0;
    for (const record of records) {
      try {
        await publishWithAuth(relay, record.event);
        removeLocalEvent(record.event.id);
        published++;
      } catch (error) {
        console.warn(`[provenance] outbox sync stopped at ${record.event.id}:`, error);
        break;
      }
    }
    return { pending: pendingLocalEvents().length, published };
  });
  localOutboxFlushQueue = task.then(() => undefined, () => undefined);
  return task;
}

// Kept as a provenance export for callers/tests that learned the helper here.
export { isLoopbackRelayUrl };

/** Fetch a target from a configured, write-enabled non-loopback relay. Attest
 *  uses this rather than the ordinary read set so a local home-relay hit cannot
 *  masquerade as the protocol's required prior Send. */
async function fetchSentTraceNode(nodeId: string): Promise<Event | null> {
  const urls = publicationRelays().map((entry) => entry.url);
  for (const url of urls) {
    const relay = await getRelayRetrying(url);
    if (!relay) continue;
    try {
      const [event] = await queryOnce(relay, { ids: [nodeId], kinds: [TRACE_NODE_KIND] });
      if (event) return event;
    } catch {
      // Best effort per relay; another configured destination may have it.
    }
  }
  return null;
}

/** Whether a node satisfies Attest's prior-Send requirement right now. */
export async function isTraceNodeSent(nodeId: string): Promise<boolean> {
  return !!(await fetchSentTraceNode(nodeId));
}

/** Pure wire builder for a TraceAttestation (protocol §5A). Exported so the
 *  provisional event shape is directly testable without relay I/O. */
export function buildAttestationTemplate(
  citedNodeId: string,
  citedOwnerPubkey: string | undefined,
  input: { createdAtSec: number; message?: string; geohash?: string },
): EventTemplate {
  return {
    kind: TRACE_ATTESTATION_KIND,
    created_at: input.createdAtSec,
    tags: [
      ["e", citedNodeId, "", "target"],
      ["k", String(TRACE_NODE_KIND)],
      ...(citedOwnerPubkey ? [["p", citedOwnerPubkey] as string[]] : []),
      ...(input.geohash ? [["g", input.geohash] as string[]] : []),
    ],
    content: JSON.stringify(input.message ? { message: input.message } : {}),
  };
}

/** Roll up reachable TraceAttestation events by their exact target node. The
 *  count is event-count, not unique-author count: attestations are append-only
 *  statements, and one author may deliberately make more than one over time. */
export function attestationCountsFromEvents(
  events: Event[],
  targetNodeIds?: Iterable<string>,
): Map<string, number> {
  const counts = new Map<string, number>();
  if (targetNodeIds) {
    for (const nodeId of targetNodeIds) counts.set(nodeId, 0);
  }
  for (const event of events) {
    if (event.kind !== TRACE_ATTESTATION_KIND) continue;
    const target = event.tags.find(
      (tag) => tag[0] === "e" && tag[1] && tag[3] === "target",
    )?.[1];
    if (!target || (targetNodeIds && !counts.has(target))) continue;
    counts.set(target, (counts.get(target) ?? 0) + 1);
  }
  return counts;
}

/** Count attestations visible from the configured read relays. These are
 *  intentionally reachable/partial counts, never claims about the whole
 *  network: Kademlia routes event pointers but does not maintain aggregates. */
export async function fetchAttestationCounts(
  targetNodeIds: string[],
): Promise<Map<string, number>> {
  const targets = [...new Set(targetNodeIds.filter(Boolean))];
  if (targets.length === 0) return new Map();
  const relays = await getReadRelays();
  const events = await queryMany(relays, {
    kinds: [TRACE_ATTESTATION_KIND],
    "#e": targets,
    limit: Math.max(500, targets.length * 50),
  });
  return attestationCountsFromEvents(events, targets);
}

/** Attest: append an immutable endorsement of a published TraceNode
 *  (protocol §5A/§8). An attestation is deliberately not a kind-4290 revision:
 *  it has no snapshot, deltas, trace identity, or `prev` edge to fabricate. */
export async function attestNode(
  citedNodeId: string,
  citedOwnerPubkey: string | undefined,
  input: {
    signer?: Uint8Array;
    message?: string;
    geohash?: string;
  },
): Promise<Event> {
  const target = await fetchSentTraceNode(citedNodeId);
  if (!target) {
    throw new Error(
      `cannot attest ${citedNodeId}: it is not fetchable from a configured external relay; Send it first`,
    );
  }
  if (citedOwnerPubkey && citedOwnerPubkey !== target.pubkey) {
    throw new Error(
      `cannot attest ${citedNodeId}: target signer does not match the supplied pubkey`,
    );
  }
  const signer = input.signer ?? authoringVoice().secretKey;
  const template = buildAttestationTemplate(citedNodeId, target.pubkey, {
    createdAtSec: Math.floor(Date.now() / 1000),
    ...(input.message ? { message: input.message } : {}),
    ...(input.geohash ? { geohash: input.geohash } : {}),
  });
  const signed = finalizeEvent(template, signer);
  await publishToMany(await getWriteRelays(), signed);
  // §R11.22: Attest no longer stamps on its own behalf. The load-bearing
  // anteriority has moved to Step (the frequent gesture builds distributed
  // anteriority — see protocol/rendezvous.md §3); the attest node's
  // anteriority is inherited transitively from the cited node, which was
  // stepped by a Step that stamps. Attest MAY carry its own stamp later for a
  // distinct "when endorsed" claim, but that is not wired here.
  return signed;
}

/** Strike one permanently-addressable, immutable kind-4290 Coin (protocol
 *  §3.8). `coin.origin` is the durable discriminator shared by direct and
 *  extracted Coins; extracted Coins additionally retain their queryable edge.
 */
export async function publishCoin(input: {
  folderId: string;
  relativePath: string;
  phrase: string;
  origin: CoinOrigin;
  signer?: Uint8Array;
  /** Direct-composer edit history. Genesis still has no prev/delta history. */
  kedits?: KEdit[];
  /** Mint is local speech until Send. Defaults true for the authoring gesture. */
  localOnly?: boolean;
  operationId?: string;
}): Promise<Event> {
  if (!input.phrase) throw new Error("A Coin cannot have an empty body.");
  if (input.origin.kind === "extracted") {
    const { range, sourceContentHash, sourceNodeId } = input.origin;
    if (!sourceNodeId) throw new Error("An extracted Coin requires a source node id.");
    if (!/^[0-9a-f]{64}$/.test(sourceContentHash)) {
      throw new Error("An extracted Coin requires the source snapshot hash.");
    }
    if (
      !Number.isInteger(range.start) ||
      !Number.isInteger(range.end) ||
      range.start < 0 ||
      range.end < range.start ||
      range.end - range.start !== input.phrase.length
    ) {
      throw new Error("An extracted Coin requires an exact UTF-16 source range.");
    }
  }

  const signer = input.signer ?? authoringVoice().secretKey;
  const contentHash = await sha256HexLocal(input.phrase);
  const kedits = input.kedits ?? synthesizeKEditTransition(
    "",
    input.phrase,
    getPublicKey(signer),
  );
  return publishEdit({
    prevEventId: null,
    previousSnapshot: "",
    relativePath: input.relativePath,
    folderId: input.folderId,
    deltas: [],
    snapshot: input.phrase,
    contentHash,
    action: "import",
    summary: "coin",
    signer,
    localOnly: input.localOnly ?? true,
    bodyHashTag: contentHash,
    coinOrigin: input.origin,
    authors: [{ voice: getPublicKey(signer), text: input.phrase }],
    kedits,
    operationId: input.operationId,
  });
}

/** Harden a bracketed phrase into its own permanently-addressable kind-4290
 *  node (protocol §3.8). The span's text becomes an immutable, citable
 *  snapshot:
 *
 *  - `action: "import"` (spec §3.4 — "a coin just struck").
 *  - `snapshot` = the phrase text; `deltas: []` (no prev — immutable genesis);
 *    `contentHash` = sha256(phrase).
 *  - A caller-supplied, timestamp-prefixed single-segment name in the
 *    dedicated Mint folder, so it is a named first-class member instead of a
 *    hidden synthetic path.
 *  - `["x", contentHash]` (spec §3.1: REQUIRED) — enables `#x` content-
 *    identity clustering so independent mints of the same words find
 *    each other.
 *  - `coin.origin` stores the source node, source snapshot hash, and exact
 *    UTF-16 range; `extracted-from` mirrors the node id for relay queries.
 *
 *  The caller rewrites the bracket `[[ phrase ]]` → `[[ phrase | newNodeId ]]`
 *  in the origin document; that rewrite is itself an ordinary cite delta on
 *  the origin doc's next step (role: "inline", q-tagged at newNodeId) —
 *  produced by the normal step path, not here.
 *
 *  Returns the signed event; `event.id` is the citable, immutable node id. */
export async function publishHardenedSpan(input: {
  folderId: string;
  relativePath: string;
  phrase: string;
  /** REQUIRED: the origin document's current nucleus (node-version the span was
   *  pulled out of). Emitted as the `extracted-from` edge. */
  originNodeId: string;
  /** REQUIRED: SHA-256 of the origin node's complete snapshot. */
  sourceContentHash: string;
  /** REQUIRED: exact UTF-16 range occupied by `phrase` in that snapshot. */
  sourceRange: { start: number; end: number };
  signer?: Uint8Array;
  /** Mint is local speech until Send. Defaults true for the authoring gesture. */
  localOnly?: boolean;
  operationId?: string;
}): Promise<Event> {
  return publishCoin({
    relativePath: input.relativePath,
    folderId: input.folderId,
    phrase: input.phrase,
    origin: {
      kind: "extracted",
      sourceNodeId: input.originNodeId,
      sourceContentHash: input.sourceContentHash,
      range: input.sourceRange,
    },
    signer: input.signer,
    localOnly: input.localOnly ?? true,
    operationId: input.operationId,
  });
}

/** Mint signer-authored text directly, without asserting a source trace. */
export async function publishDirectCoin(input: {
  folderId: string;
  relativePath: string;
  phrase: string;
  signer?: Uint8Array;
  kedits?: KEdit[];
  localOnly?: boolean;
}): Promise<Event> {
  return publishCoin({
    ...input,
    origin: { kind: "direct" },
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

/** Canonicalize quote text for the rendezvous content hash `H`
 *  (protocol/rendezvous.md §1.2). Exact, not fuzzy: NFC normalize, collapse all
 *  whitespace runs to a single space, trim. Deliberately NO case-folding — case
 *  can carry meaning ("The" vs "the"), and `H` must stay a single value so the
 *  "hash is the address of the room" property holds. Fuzzy matching is a
 *  client-side layer above the coordinate, never part of `H` itself. */
export function canonicalQuoteText(text: string): string {
  return text.normalize("NFC").replace(/\s+/g, " ").trim();
}

/** The rendezvous coordinate: the content hash of a quote
 *  (protocol/rendezvous.md §1.1). `H = sha256(canonical(quoteText))`. Not a
 *  node id; an addressable property of the text shared by everyone who quoted
 *  the same passage. */
export async function quoteHash(quoteText: string): Promise<string> {
  return sha256HexLocal(canonicalQuoteText(quoteText));
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
 *  minting a new rule trace on every LLM step when the config hasn't changed.
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
 *  press folder at a synthetic path (`<press>#rule-<shortHash>`), is stepped as
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
  const signer = authoringVoice().secretKey;
  const event = await publishEdit({
    prevEventId: null,
    previousSnapshot: "",
    relativePath: syntheticPath,
    folderId,
    deltas: [],
    snapshot: body,
    contentHash,
    action: "import",
    summary: `inject rule: ${manifest.algorithm}`,
    bodyHashTag: contentHash,
    signer,
    kedits: synthesizeKEditTransition("", body, getPublicKey(signer)),
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
    kinds: [TRACE_NODE_KIND],
    "#F": [relativePath],
    "#f": [folderId],
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

/** Result of resolving a mutable file trace by its stable genesis identity.
 * TraceHead is only a cache: every candidate is accepted only when its signed
 * `prev` walk reaches `traceId`. Two incomparable maximal candidates are a
 * real branch and are never collapsed by relay order. */
export type TraceChainResolution =
  | { status: "resolved"; traceId: string; chain: Event[]; source: "trace-head" | "exact-head" }
  | { status: "missing" | "broken"; traceId: string; chain: []; candidateHeadIds: string[] }
  | { status: "conflict"; traceId: string; chain: []; candidateHeadIds: string[] };

export type TraceEventBatchLoader = (ids: readonly string[]) => Promise<Event[]>;

async function loadTraceEventsByIds(ids: readonly string[]): Promise<Event[]> {
  if (ids.length === 0) return [];
  const relays = await getReadRelays();
  const out = await queryMany(relays, {
    kinds: [TRACE_NODE_KIND],
    ids: [...new Set(ids)],
  });
  return out.filter(isFileNode);
}

/** Pure-with-injected-loader resolver used by the relay path and unit tests.
 * It walks all candidates one frontier at a time, batching same-depth event-id
 * reads and sharing immutable events across candidates. */
export async function resolveTraceChainCandidates(
  traceId: string,
  candidateHeadIds: readonly string[],
  loadEvents: TraceEventBatchLoader,
): Promise<TraceChainResolution> {
  const heads = [...new Set(candidateHeadIds.filter(Boolean))];
  if (heads.length === 0) {
    return { status: "missing", traceId, chain: [], candidateHeadIds: [] };
  }

  type Walk = {
    headId: string;
    cursor: string | null;
    newestFirst: Event[];
    seen: Set<string>;
    complete: boolean;
    broken: boolean;
  };
  const walks: Walk[] = heads.map((headId) => ({
    headId,
    cursor: headId,
    newestFirst: [],
    seen: new Set(),
    complete: false,
    broken: false,
  }));
  const byId = new Map<string, Event>();

  for (let depth = 0; depth < 10_000; depth++) {
    const active = walks.filter((walk) => !walk.complete && !walk.broken && walk.cursor);
    if (active.length === 0) break;
    const needed = [...new Set(active.map((walk) => walk.cursor!).filter((id) => !byId.has(id)))];
    if (needed.length > 0) {
      for (const event of await loadEvents(needed)) byId.set(event.id, event);
    }

    for (const walk of active) {
      const cursor = walk.cursor!;
      if (walk.seen.has(cursor)) {
        walk.broken = true;
        continue;
      }
      walk.seen.add(cursor);
      const event = byId.get(cursor);
      if (!event || !isFileNode(event)) {
        walk.broken = true;
        continue;
      }
      walk.newestFirst.push(event);
      if (event.id === traceId) {
        // A stable identity is a genesis. Accepting a non-genesis as identity
        // would let a malformed TraceHead silently truncate history.
        const prev = event.tags.find((tag) => tag[0] === "e" && tag[3] === "prev")?.[1];
        if (prev) walk.broken = true;
        else walk.complete = true;
        walk.cursor = null;
        continue;
      }
      const prev = event.tags.find((tag) => tag[0] === "e" && tag[3] === "prev")?.[1];
      if (!prev) {
        walk.broken = true;
        walk.cursor = null;
      } else {
        walk.cursor = prev;
      }
    }
  }

  const valid = walks
    .filter((walk) => walk.complete && !walk.broken)
    .map((walk) => ({ headId: walk.headId, chain: [...walk.newestFirst].reverse() }));
  if (valid.length === 0) {
    return { status: "broken", traceId, chain: [], candidateHeadIds: heads };
  }

  // A stale TraceHead from another signer/relay is harmless when its head is
  // an ancestor of another valid candidate. Only incomparable maxima conflict.
  const maximal = valid.filter(
    (candidate) =>
      !valid.some(
        (other) =>
          other.headId !== candidate.headId &&
          other.chain.some((event) => event.id === candidate.headId),
      ),
  );
  if (maximal.length !== 1) {
    return {
      status: "conflict",
      traceId,
      chain: [],
      candidateHeadIds: maximal.map((candidate) => candidate.headId),
    };
  }
  return { status: "resolved", traceId, chain: maximal[0].chain, source: "trace-head" };
}

/** Rebuild one exact immutable head's ancestry by id. Folder membership names
 *  an exact latest node, so this remains valid when a TraceHead cache is stale
 *  or unavailable. */
export async function resolveTraceChainAtHead(
  traceId: string,
  headId: string,
  loadEvents: TraceEventBatchLoader = loadTraceEventsByIds,
): Promise<TraceChainResolution> {
  const resolved = await resolveTraceChainCandidates(traceId, [headId], loadEvents);
  return resolved.status === "resolved"
    ? { ...resolved, source: "exact-head" }
    : resolved;
}

const traceIdentityByNode = new Map<string, string>();

/** Resolve any immutable node id back to its genesis trace identity. */
export async function resolveTraceIdentity(
  nodeId: string,
  loadEvents: TraceEventBatchLoader = loadTraceEventsByIds,
): Promise<string | null> {
  if (loadEvents === loadTraceEventsByIds) {
    const cached = traceIdentityByNode.get(nodeId);
    if (cached) return cached;
  }
  const newestFirst: Event[] = [];
  const seen = new Set<string>();
  let cursor: string | null = nodeId;
  for (let depth = 0; cursor && depth < 10_000; depth++) {
    if (seen.has(cursor)) return null;
    seen.add(cursor);
    const loaded: Event[] = await loadEvents([cursor]);
    const event: Event | undefined = loaded.find((candidate: Event) => candidate.id === cursor);
    if (!event || !isFileNode(event)) return null;
    newestFirst.push(event);
    const prev: string | null =
      event.tags.find((tag: string[]) => tag[0] === "e" && tag[3] === "prev")?.[1] ?? null;
    if (!prev) {
      const traceId = event.id;
      if (loadEvents === loadTraceEventsByIds) {
        for (const member of newestFirst) traceIdentityByNode.set(member.id, traceId);
      }
      return traceId;
    }
    cursor = prev;
  }
  return null;
}

async function traceHeadCandidateIds(traceId: string): Promise<string[]> {
  const relays = await getReadRelays();
  const heads = await queryMany(relays, {
    kinds: [TRACE_HEAD_KIND],
    "#d": [traceId],
  });
  const ids = new Set<string>();
  for (const event of heads) {
    try {
      const parsed = JSON.parse(event.content) as { head?: unknown };
      if (typeof parsed.head === "string" && parsed.head) ids.add(parsed.head);
    } catch {
      // Malformed caches are ignored. The chain remains authoritative.
    }
  }
  return [...ids];
}

/** Resolve a file chain by stable identity and, when supplied, one exact
 * immutable head id from current folder membership. */
export async function resolveTraceChain(
  traceId: string,
  exactHeadId?: string,
): Promise<TraceChainResolution> {
  let candidates: string[] = [];
  try {
    candidates = await traceHeadCandidateIds(traceId);
    if (candidates.length > 0) {
      const resolved = await resolveTraceChainCandidates(traceId, candidates, loadTraceEventsByIds);
      if (resolved.status === "resolved" || resolved.status === "conflict") return resolved;
    }
  } catch {
    // An exact folder-member head may still resolve the signed chain.
  }
  if (exactHeadId) {
    try {
      const resolved = await resolveTraceChainAtHead(traceId, exactHeadId);
      if (resolved.status === "resolved") return resolved;
    } catch {
      // Fall through to a typed missing/broken result.
    }
  }
  return {
    status: candidates.length > 0 ? "broken" : "missing",
    traceId,
    chain: [],
    candidateHeadIds: candidates,
  };
}

/** Returns the latest event id for a file, or null if none published yet. */
export async function fetchLatestEventId(folderId: string, relativePath: string): Promise<string | null> {
  const chain = await fetchChain(folderId, relativePath);
  return chain.length > 0 ? chain[chain.length - 1].id : null;
}

export interface TraceRevocationPlan {
  traceId: string;
  totalNodeCount: number;
  requestedNodeIds: string[];
  skippedNodeIds: string[];
  tags: string[][];
}

/** Build the honest portion of a NIP-09 request for one trace. A deletion
 * request can only affect events signed by the same key as the request; foreign
 * voice/model Steps are reported as skipped instead of being presented as
 * revoked. The signer's replaceable file TraceHead is addressed separately. */
export function planTraceRevocation(
  traceId: string,
  chain: readonly Event[],
  signerPubkey: string,
): TraceRevocationPlan {
  const requestedNodeIds = [
    ...new Set(chain.filter((event) => event.pubkey === signerPubkey).map((event) => event.id)),
  ];
  const requested = new Set(requestedNodeIds);
  const skippedNodeIds = [...new Set(chain.map((event) => event.id).filter((id) => !requested.has(id)))];
  return {
    traceId,
    totalNodeCount: new Set(chain.map((event) => event.id)).size,
    requestedNodeIds,
    skippedNodeIds,
    tags: [
      ...requestedNodeIds.map((id) => ["e", id, ""]),
      ["a", `${TRACE_HEAD_KIND}:${signerPubkey}:${traceId}`],
    ],
  };
}

export interface TraceRevocationResult extends TraceRevocationPlan {
  request: Event;
}

/** Publish a relay revocation request without deleting the local workspace
 * copy. This is deliberately separate from Oblivion/local deletion. Stable
 * identity keeps the operation valid after rename, move into Oblivion, or
 * restore. */
export async function revokeTrace(
  traceId: string,
  reason: string,
  opts?: {
    signer?: Uint8Array;
    exactHeadId?: string;
  },
): Promise<TraceRevocationResult> {
  const signer = opts?.signer ?? authoringVoice().secretKey;
  const signerPubkey = getPublicKey(signer);
  const resolution = await resolveTraceChain(traceId, opts?.exactHeadId);
  if (resolution.status !== "resolved") {
    throw new Error(
      resolution.status === "conflict"
        ? "Cannot revoke a conflicted trace until its current head is reconciled."
        : "Cannot revoke this trace because its signed chain is unavailable.",
    );
  }
  const plan = planTraceRevocation(traceId, resolution.chain, signerPubkey);
  const template: EventTemplate = {
    kind: 5,
    created_at: Math.floor(Date.now() / 1000),
    tags: plan.tags,
    content: reason,
  };
  const request = finalizeEvent(template, signer);
  await publishToMany(await getWriteRelays(), request);
  return { ...plan, request };
}

// --- folder activity (Times view) ---------------------------------------
//
// A read-only aggregation surface: pull every kind-4290 node for a folder
// within an optional time window, then let the caller bucket/count tags
// client-side. Like fetchChain this fans out to every read relay and merges by
// event id, but it does NOT walk the prev-chain — every node counts as its own
// activity sample, which is what the Times graph wants (step events over time,
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
    kinds: [TRACE_NODE_KIND],
    "#f": [folderId],
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
 *  across all folders. Unlike `fetchFolderActivity`, no `#f` filter — the relay
 *  is treated as the whole database, so Times can show something even with no
 *  folder attached. Each event's folder id is recoverable from its `#f` tag
 *  (see `eventMeta().folderId`). */
export async function fetchRelayActivity(
  opts: { since?: number; until?: number; limit?: number; authors?: string[] } = {},
): Promise<Event[]> {
  if (opts.authors && opts.authors.length === 0) return [];
  const relays = await getReadRelays();
  const filter: Filter = {
    kinds: [TRACE_NODE_KIND],
    ...(opts.authors ? { authors: opts.authors } : {}),
    ...(opts.since != null ? { since: opts.since } : {}),
    ...(opts.until != null ? { until: opts.until } : {}),
    limit: opts.limit ?? 2000,
  };
  // Spec §R11.3: file and folder share kind 4290. Post-filter to file nodes.
  return (await queryMany(relays, filter)).filter((e) =>
    e.tags.some((t) => t[0] === "z" && t[1] === "file"),
  );
}

// --- folder index (Listings) ---------------------------------------------
//
// The Listings view needs an enumeration of every distinct folder on the relay
// with rolled-up stats per folder (the inbox/kept/cut lists are per-folder) —
// something fetchRelayActivity alone doesn't give it.

/** One folder's rolled-up activity, the unit of the Listings inbox. Built by
 *  `fetchFolderIndex` from a relay-wide scan; never stored, always recomputed.
 *  `topTags` is the most frequent author tags (capped), for display + doctrine
 *  alignment; `authorPubkeys` is the set of distinct step signers (a liveness
 *  signal — a project worked on by many voices is usually worth keeping). */
export interface FolderIndexEntry {
  folderId: string;
  eventCount: number;
  citationTotal: number;
  /** ms — the most recent step's steppedAt (falls back to created_at*1000). */
  lastSeenMs: number;
  /** Top author tags by occurrence, capped at 8, most frequent first. */
  topTags: string[];
  authorPubkeys: Set<string>;
}

/** Enumerate every distinct folder the read relays hold, with per-folder
 *  rollups. A relay-wide scan (no `#f` filter) grouped by `eventMeta().folderId`
 *  — the same shape TimesView groups ad-hoc, lifted into a reusable read so
 *  the inbox reads one source of truth. Folders with no `#f` tag (foreign or
 *  malformed events) are skipped, not counted under a synthetic bucket. */
export async function fetchFolderIndex(
  opts: { since?: number; until?: number; limit?: number; authors?: string[] } = {},
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
    if (meta.steppedAtMs > entry.lastSeenMs) entry.lastSeenMs = meta.steppedAtMs;
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
 *  directly. `steppedAtMs` falls back to `created_at*1000` when the content
 *  lacks the ms-resolution field. `userTags` is every `t` tag —
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
  /** The folder this event belongs to, from its `#f` tag. Present on every
   *  non-genesis folder-scoped TraceNode. Used by Times to group relay-
   *  wide activity by folder when no single folder is attached. */
  folderId?: string;
  /** Reification discriminator from the `z` tag (protocol §3.1): `"file"` or
   *  `"folder"`. */
  z?: "file" | "folder";
  /** Causal gesture id shared by the source checkpoint and derived roll-ups. */
  operationId?: string;
  /** Folder-only checkpoint classification used to collapse derived replay. */
  folderCheckpoint?: FolderCheckpoint;
  citationCount: number;
  /** Every `q` tag's target node id, in declared (tag) order — the traces this
   *  node composes. Mirrors the emission order in `publishEdit`, so the
   *  citation-chip list reads body-quotes first, then Reply source, then
   *  tagged zines. Empty for a leaf. */
  citationTargets: string[];
  steppedAtMs: number;
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
      case "F":
        if (typeof tag[1] === "string") relativePath = tag[1];
        break;
      case "f":
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

  let steppedAtMs = (event.created_at ?? 0) * 1000;
  let operationId: string | undefined;
  let folderCheckpoint: FolderCheckpoint | undefined;
  try {
    const parsed = JSON.parse(event.content) as {
      steppedAt?: number;
      operationId?: unknown;
      folderCheckpoint?: Partial<FolderCheckpoint>;
    };
    if (typeof parsed.steppedAt === "number") steppedAtMs = parsed.steppedAt;
    if (isTraceOperationId(parsed.operationId)) operationId = parsed.operationId;
    const checkpoint = parsed.folderCheckpoint;
    if (
      checkpoint?.version === 1 &&
      (
        checkpoint.cause === "genesis" ||
        checkpoint.cause === "explicit-step" ||
        checkpoint.cause === "structure-change" ||
        checkpoint.cause === "child-advance" ||
        checkpoint.cause === "metadata-change"
      ) &&
      (checkpoint.sourceNodeId === undefined || typeof checkpoint.sourceNodeId === "string")
    ) {
      folderCheckpoint = {
        version: 1,
        cause: checkpoint.cause,
        ...(checkpoint.sourceNodeId ? { sourceNodeId: checkpoint.sourceNodeId } : {}),
      };
    }
  } catch {
    // non-JSON or absent content — fall back to created_at resolution
  }
  return {
    userTags,
    action,
    relativePath,
    folderId,
    z,
    operationId,
    folderCheckpoint,
    citationCount,
    citationTargets,
    steppedAtMs,
    createdAtSec: event.created_at ?? 0,
  };
}

// --- cited-trace name resolution (for the citation-chip row) -------------
//
// A `q` edge points at another trace's nucleus by event id. To render it as a
// chip in the tag row we need that trace's *name*: a named trace shows its
// structural basename. Coins are named members of Mint and recognized only by
// their `content.coin` envelope. The same cited trace can appear from many
// documents, so the resolution is cached per node id for the session
// (mirroring `displayNameCache`).

/** One resolved cited-trace chip. `kind` distinguishes editable files from
 *  immutable file-reified coins so CSS can give each a distinct affordance. */
export interface CitationChip {
  nodeId: string;
  /** Stable genesis identity of the cited trace, when resolvable. Lets a
   * retained local Oblivion copy open without re-fetching the pinned
   * historical node. */
  traceId?: string;
  name: string;
  kind: "file" | "coin";
  /** How many later Steps exist on this trace's currently resolved chain.
   *  Zero means the citation already pins the current head. Undefined means
   *  the target chain could not be resolved (offline, unavailable, or foreign). */
  stepsBehind?: number;
  /** Reachability/lifecycle of the pinned target. `in-oblivion` is added only
   * when this press has the local retained copy; a signed deletion observed
   * remotely is `deleted`. `revoked` requires a valid kind-5 request signed by
   * the target event's author; absence alone is only `unavailable`. */
  availability?: "available" | "in-oblivion" | "deleted" | "unavailable" | "revoked";
  /** The pubkey of the event that minted this node — the minter's identity,
   *  used by TimesView's voice mode to resolve each minter's published color.
   *  Optional: absent when the node couldn't be fetched (null chip) or on
   *  callers that don't need it. */
  pubkey?: string;
}

const nodeNameCache = new Map<string, CitationChip | null>();
// The cited event itself is immutable and supplies the target chain coordinate
// needed by `resolveCitationChip`; retain it with the cached name so progress
// refreshes only refetch the moving chain, not the pinned event.
const citedEventCache = new Map<string, Event>();

/** Resolve a cited node id to a display name + kind, caching for the session.
 *  Fetches the node (once, then cached), reads its `F` tag (`relativePath`),
 *  and identifies Coins exclusively through the `content.coin` envelope.
 *  Returns null when the node can't be fetched from any read relay (a citation
 *  the source has since deleted, or an offline relay) — the caller renders a
 *  fallback id-abbrev chip rather than blocking the row. */
export async function resolveNodeName(nodeId: string): Promise<CitationChip | null> {
  const cached = nodeNameCache.get(nodeId);
  if (cached !== undefined) return cached;
  const event = await fetchEventById(nodeId);
  if (!event) {
    // Unavailability is not immutable. Do not cache a miss: the relay may be
    // offline now and reachable on the next citation refresh.
    return null;
  }
  citedEventCache.set(nodeId, event);
  const meta = eventMeta(event);
  const path = meta.relativePath;
  const coin = isCoinEvent(event);
  const name = path ? path.split("/").pop() || path : nodeId.slice(0, 8);
  const chip: CitationChip = {
    nodeId,
    name,
    kind: coin ? "coin" : "file",
    pubkey: event.pubkey,
  };
  nodeNameCache.set(nodeId, chip);
  return chip;
}

/** Count the Steps after `citedNodeId` in a resolved genesis→head chain.
 *  Citation edges pin an immutable event id, so this is display metadata only:
 *  advancing the cited trace never retargets the citation itself. Returns null
 *  when the cited event is not on the selected head chain (for example, a
 *  sibling branch) rather than presenting a misleading distance. */
export function citationStepsBehind(
  chain: readonly { id: string }[],
  citedNodeId: string,
): number | null {
  const citedIndex = chain.findIndex((event) => event.id === citedNodeId);
  return citedIndex < 0 ? null : chain.length - citedIndex - 1;
}

/** True only for a cryptographically valid NIP-09 request signed by the cited
 * event's own author. A missing cited event without this evidence remains
 * merely unavailable; an unrelated signer cannot label it revoked. */
export function hasVerifiedRevocationRequest(
  nodeId: string,
  ownerPubkey: string,
  requests: readonly Event[],
): boolean {
  return requests.some(
    (request) =>
      request.kind === 5 &&
      request.pubkey === ownerPubkey &&
      request.tags.some((tag) => tag[0] === "e" && tag[1] === nodeId) &&
      verifyEvent(request),
  );
}

const verifiedRevokedNodes = new Set<string>();

async function citationRevoked(nodeId: string, ownerPubkey?: string): Promise<boolean> {
  if (verifiedRevokedNodes.has(nodeId)) return true;
  if (!ownerPubkey) return false;
  try {
    const requests = await queryMany(await getReadRelays(), {
      kinds: [5],
      "#e": [nodeId],
    });
    if (hasVerifiedRevocationRequest(nodeId, ownerPubkey, requests)) {
      verifiedRevokedNodes.add(nodeId);
      return true;
    }
  } catch {
    // Relay failure is not revocation evidence.
  }
  return false;
}

/** Resolve a citation-row chip, including its distance from the cited trace's
 *  current head. Unlike `resolveNodeName`, the progress value is deliberately
 *  not cached: a citation stays pinned while the target trace can keep taking
 *  Steps. Name resolution remains cached independently. */
export async function resolveCitationChip(nodeId: string): Promise<CitationChip | null> {
  const chip = await resolveNodeName(nodeId);
  // Fetch on every refresh even when the immutable name is cached: reachability
  // can change after a NIP-09 request or a transient relay outage.
  const liveEvent = await fetchEventById(nodeId);
  const knownEvent = liveEvent ?? citedEventCache.get(nodeId);
  if (liveEvent) citedEventCache.set(nodeId, liveEvent);
  const revoked = await citationRevoked(nodeId, knownEvent?.pubkey ?? chip?.pubkey);
  let traceId: string | null = null;
  try {
    traceId = await resolveTraceIdentity(nodeId);
  } catch {
    // Availability is reported below; a missing identity must not drop the
    // pinned citation chip.
  }
  const base: CitationChip = {
    ...(chip ?? {
    nodeId,
    name: `${nodeId.slice(0, 8)}…`,
    kind: "file",
    }),
    ...(traceId ? { traceId } : {}),
  };
  if (revoked) return { ...base, availability: "revoked" };
  if (!liveEvent) return { ...base, availability: "unavailable" };

  if (!traceId) return { ...base, availability: "available" };

  try {
    // Resolve the mutable current head. The cited node remains the pinned
    // nucleus used only to compute distance within that verified chain.
    const resolution = await resolveTraceChain(traceId);
    if (resolution.status !== "resolved") {
      return { ...base, availability: "unavailable" };
    }
    const chain = resolution.chain;
    const stepsBehind = citationStepsBehind(chain, nodeId);
    const head = chain[chain.length - 1];
    const availability = head && eventMeta(head).action === "delete" ? "deleted" : "available";
    return stepsBehind == null
      ? { ...base, availability }
      : { ...base, stepsBehind, availability };
  } catch {
    // Citation identity/name still render when its live chain is unavailable.
    return { ...base, availability: "unavailable" };
  }
}

// --- folder trace nodes (kind 4290, z:folder) ----------------------------
//
// A folder is a trace whose body is an ordered membership list — a folder-
// reified TraceNode (kind 4290 with a `z:folder` tag), non-replaceable, carried
// on an `e…prev` chain exactly like a file. Every node carries its full
// `snapshot.members`, so resolving "what's in this folder now" is one bounded
// fetch (the uncited head of the chain), not a fan-out to members. This is the
// property SEND, ZINE, and forking lean on: a cited folder must be
// self-contained. See protocol/trace-provenance.md §FolderTraceNode.
//
// The public API keeps the `*Manifest*` names shared by the disk and
// local-primary workspace backends.

/** The membership body of a folder-trace node — `snapshot.members` on the wire. */
interface FolderSnapshot {
  members: ManifestFileEntry[];
}

/** The selection recorded by a `focus` folder delta (protocol §FolderTraceNode
 *  Content — focus selection payload). Mirrors the protocol's three reifications:
 *  a file, a folder, or a coin (an immutable quotation trace). */
export type FocusSelection =
  | { kind: "file"; path: string; nodeId?: string }
  | { kind: "folder"; path: string; nodeId?: string }
  | { kind: "coin"; nodeId: string; phrase: string; originPath: string };

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
 *  `focus` is an observation, not membership: it records foreground panel
 *  occupancy (`op: 'mount'` = a trace became the visible tab in a panel;
 *  `op: 'unmount'` = it stopped being the visible tab), so a reading session
 *  can be replayed in the press editor. A background tab can remain open after
 *  its focus unmount; these operations do not describe tab-strip membership.
 *  `op` is required. A `focus` node re-emits the
 *  *same* `snapshot.members` as `prev` — `contentHash` is unaffected, exactly
 *  as a `quote`/`tag-add` delta never alters the file snapshot's text. */
export type FolderDelta =
  | { type: "add" | "remove"; kind: "file" | "folder"; relativePath: string; nodeId?: string; timestamp: number }
  | { type: "rename"; kind: "file" | "folder"; fromPath: string; toPath: string; nodeId: string; timestamp: number }
  | { type: "advance"; kind: "file" | "folder"; relativePath: string; previousNodeId: string; nodeId: string; timestamp: number }
  | { type: "focus"; op: "mount" | "unmount"; selection: FocusSelection; panelIndex: number; timestamp: number };

export function isFocusSelection(value: unknown): value is FocusSelection {
  if (!value || typeof value !== "object") return false;
  const selection = value as Record<string, unknown>;
  if (selection.kind === "file" || selection.kind === "folder") {
    return (
      typeof selection.path === "string" &&
      (selection.nodeId === undefined || typeof selection.nodeId === "string")
    );
  }
  return (
    selection.kind === "coin" &&
    typeof selection.nodeId === "string" &&
    typeof selection.phrase === "string" &&
    typeof selection.originPath === "string"
  );
}

function isFocusDelta(value: unknown): value is Extract<FolderDelta, { type: "focus" }> {
  if (!value || typeof value !== "object") return false;
  const delta = value as Record<string, unknown>;
  return (
    delta.type === "focus" &&
    (delta.op === "mount" || delta.op === "unmount") &&
    isFocusSelection(delta.selection) &&
    Number.isInteger(delta.panelIndex) &&
    (delta.panelIndex as number) >= 0 &&
    Number.isFinite(delta.timestamp)
  );
}

/** Fetches every folder-reified trace node for `folderId` across all read
 *  relays, merged by event id. The genesis is queried by id because it cannot
 *  carry its own `f` identity tag. Does not resolve the chain — returns the raw
 *  node set for `fetchLatestFolderNode` to head-resolve, and for the context-
 *  block directory log to read every membership event (add/remove). */
export async function fetchFolderNodes(folderId: string): Promise<Event[]> {
  const relays = await getReadRelays();
  const [byF, genesis] = await Promise.all([
    queryMany(relays, { kinds: [TRACE_NODE_KIND], "#f": [folderId] }),
    queryMany(relays, { ids: [folderId] }),
  ]);
  const isFolderNode = (e: Event) => e.tags.some((t) => t[0] === "z" && t[1] === "folder");
  const byIdMap = new Map<string, Event>();
  for (const e of byF) if (isFolderNode(e)) byIdMap.set(e.id, e);
  for (const e of genesis) if (isFolderNode(e)) byIdMap.set(e.id, e);
  return [...byIdMap.values()];
}

/** Read only folder nodes the home relay has accepted. Unlike `queryMany`, this
 * deliberately excludes the durable local outbox and every federated read
 * relay: an interrupted local Step may be resumed only from a node the home has
 * actually acknowledged. */
async function fetchHomeFolderNodes(folderId: string): Promise<Event[]> {
  const home = await getRelayRetrying(resolveRelayUrl(), 1);
  if (!home) throw new Error(`cannot verify folder ${folderId} on the home relay`);
  const [byFolder, genesis] = await Promise.all([
    queryOnce(home, { kinds: [TRACE_NODE_KIND], "#f": [folderId] }),
    queryOnce(home, { kinds: [TRACE_NODE_KIND], ids: [folderId] }),
  ]);
  const nodes = [...byFolder, ...genesis].filter(
    (event) => event.tags.some((tag) => tag[0] === "z" && tag[1] === "folder"),
  );
  return [...new Map(nodes.map((event) => [event.id, event])).values()];
}

function folderChainAtHead(
  folderId: string,
  head: Event,
  nodes: readonly Event[],
): Event[] | null {
  const byId = new Map(nodes.map((event) => [event.id, event]));
  const newestFirst: Event[] = [];
  const seen = new Set<string>();
  let cursor: string | null = head.id;
  while (cursor) {
    if (seen.has(cursor)) return null;
    seen.add(cursor);
    const event = byId.get(cursor);
    if (!event) return null;
    newestFirst.push(event);
    if (event.id === folderId) return newestFirst.reverse();
    cursor = event.tags.find(
      (tag) => tag[0] === "e" && tag[3] === "prev",
    )?.[1] ?? null;
  }
  return null;
}

async function requireValidFolderChain(
  folderId: string,
  head: Event,
  nodes: readonly Event[],
  expectedOwnerPubkey: string,
): Promise<Event[]> {
  const chain = folderChainAtHead(folderId, head, nodes);
  if (!chain) {
    throw new Error(`folder ${folderId} head ${head.id} does not reach its fixed identity`);
  }
  const verdict = await verifyFolderTraceChain(chain, verifyEvent, {
    expectedOwnerPubkey,
    expectedNucleusId: head.id,
    expectedTraceId: folderId,
  });
  if (verdict.status !== "full") {
    throw new Error(
      `folder ${folderId} head ${head.id} is unsafe: ${
        verdict.issues.map((issue) => issue.message).join("; ") || "nonconforming chain"
      }`,
    );
  }
  return chain;
}

async function requireCurrentFolderChain(
  folderId: string,
  nodes: readonly Event[],
  expectedOwnerPubkey: string,
): Promise<{ chain: Event[]; head: Event }> {
  const ownerNodes = nodes.filter((event) => event.pubkey === expectedOwnerPubkey);
  const heads = listUncitedHeads(ownerNodes);
  if (heads.length !== 1) {
    throw new Error(
      `folder ${folderId} has ${heads.length} accepted owner heads; reconcile before Step`,
    );
  }
  const head = heads[0]!;
  return {
    chain: await requireValidFolderChain(folderId, head, nodes, expectedOwnerPubkey),
    head,
  };
}

/** Resolves the latest (uncited-as-prev) folder-trace node for `folderId`, or
 *  null if the folder has no folder chain yet. Same head-finding rule as file
 *  chains (`resolveHead`): a node nobody else cites as `prev` is the head. */
export async function fetchLatestFolderNode(folderId: string): Promise<Event | null> {
  const all = await fetchFolderNodes(folderId);
  return resolveHead(all);
}

/** Parses `snapshot.members` out of a folder-reified 4290 node's content. Returns [] on
 *  malformed/empty content. */
export function membersFromNode(event: Event): ManifestFileEntry[] {
  try {
    const parsed = JSON.parse(event.content) as { snapshot?: { members?: unknown[] } };
    if (!Array.isArray(parsed.snapshot?.members)) return [];
    return parsed.snapshot.members.filter((member): member is ManifestFileEntry => {
      if (!member || typeof member !== "object") return false;
      const entry = member as Partial<ManifestFileEntry>;
      return (
        (entry.kind === "file" || entry.kind === "folder") &&
        typeof entry.relativePath === "string" &&
        typeof entry.latestNodeId === "string" &&
        typeof entry.contentHash === "string"
      );
    });
  } catch {
    return [];
  }
}

/** Reads the current file set for a folder from its latest 4290-z:folder node's
 *  `snapshot.members`. Empty array for a fresh folder. */
export async function fetchManifest(folderId: string): Promise<ManifestFileEntry[]> {
  const head = await fetchLatestFolderNode(folderId);
  return head ? membersFromNode(head) : [];
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

/** Builds and signs (does not publish) a folder-reified 4290 node. Mirrors
 *  the FileTraceNode shape: `z` discriminator, `f` folder identity, one `q`
 *  tag per active member in order, `e…prev` to the prior
 *  head (absent on genesis). No `d` tag — folder-reified 4290 is NOT replaceable; ordering
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
 *  step (§8). Empty array on genesis/import nodes, in which case the field is
 *  omitted from the content entirely. */
function buildFolderNodeTemplate(
  folderId: string | null,
  members: ManifestFileEntry[],
  prevEventId: string | null,
  action: string,
  deltas: FolderDelta[],
  steppedAt: number,
  operationId: string,
  folderCheckpoint: FolderCheckpoint,
  opts?: { forkedFrom?: string | null; memberOwners?: string[]; geohashes?: string[] },
): EventTemplate {
  const ownerByPath = opts?.memberOwners;
  const tags: string[][] = [
    // Reification discriminator (protocol §3.1: REQUIRED on every node).
    ["z", "folder"],
  ];
  // Spec §3.1: `f` carries the folder's own genesis id on every node
  // EXCEPT genesis itself — an event can't know its own id before signing.
  // Genesis (folderId null) emits none; its event id becomes the identity every
  // later node references. This closes the genesis-identity question: new
  // folders adopt the genesis event id as identity.
  if (folderId) {
    tags.push(["f", folderId]);
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
  // current set is republished on the folder node — re-stepping supersedes
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
    created_at: Math.floor(steppedAt / 1000),
    tags,
    content: JSON.stringify({
      steppedAt,
      snapshot,
      ...(deltas.length > 0 ? { deltas } : {}),
      contentHash: "", // filled by caller after hashing the snapshot
      operationId,
      folderCheckpoint,
    }),
  };
}

/** Hashes a folder snapshot to its contentHash. Body-only — same addressing
 *  axis as a file. Used as the integrity anchor on every folder node.
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
 *  Shallow-local Merkle-with-pointer: a folder member's `contentHash` is its own stored
 *  canonical-body hash, never recomputed here (no chain walk, no recursion,
 *  cycle-safe by construction). Widening the projection from two-tuple to
 *  three-tuple is part of the current wire contract. */
function canonicalFolderBody(members: ManifestFileEntry[]): string {
  return JSON.stringify(members.map((m) => [m.relativePath, m.kind, m.contentHash]));
}

// --- focus buffer (§R7) -------------------------------------------------
//
// Focus observations never mint their own nodes — they accumulate in this
// per-folder buffer and ride along on the NEXT folder-chain step (any add/
// remove/rename) as additional `deltas` entries. The buffer is mirrored to
// localStorage so closing the press never needs to manufacture a focus-only
// Step and observations survive until a real folder Step drains them. This is
// the load-bearing §R7
// mechanism: focus fires per click, and a focus node would re-serialize the
// full membership snapshot every time — the exact per-keystroke collapse §R1
// warns makes unconditional snapshots unaffordable. Buffering turns O(clicks)
// nodes into O(steps) deltas. Coalescing per panelIndex (the App.tsx writer
// dedupes against the last published key) keeps the buffer from growing
// unbounded under a flurry of selections.

const focusBuffer = new Map<string, FolderDelta[]>();
const FOCUS_BUFFER_PREFIX = "zine.pending-folder-focus.";

function storedFocus(folderId: string): FolderDelta[] {
  const cached = focusBuffer.get(folderId);
  if (cached) return cached;
  let loaded: FolderDelta[] = [];
  try {
    if (typeof localStorage !== "undefined") {
      const raw = localStorage.getItem(FOCUS_BUFFER_PREFIX + folderId);
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      if (Array.isArray(parsed)) loaded = parsed.filter(isFocusDelta);
    }
  } catch {
    // Focus is observational; an unavailable/corrupt local buffer must not
    // block authoring or a structural folder Step.
  }
  focusBuffer.set(folderId, loaded);
  return loaded;
}

function persistFocus(folderId: string, entries: FolderDelta[]): void {
  try {
    if (typeof localStorage === "undefined") return;
    if (entries.length === 0) localStorage.removeItem(FOCUS_BUFFER_PREFIX + folderId);
    else localStorage.setItem(FOCUS_BUFFER_PREFIX + folderId, JSON.stringify(entries));
  } catch {
    // Best-effort observation buffer; the in-memory copy remains authoritative
    // for the current session when storage is unavailable.
  }
}

/** Append a focus observation to `folderId`'s pending buffer. Called from the
 *  press on selection/panel-mount (mount) and tab/panel close (unmount). Does
 *  not step — the observation becomes durable when the next folder Step drains
 *  the persisted buffer. Safe to call before the folder has any chain; the
 *  buffer simply holds until the first Step. */
export function bufferFocus(folderId: string, delta: FolderDelta): void {
  const arr = storedFocus(folderId);
  arr.push(delta);
  persistFocus(folderId, arr);
}

/** Take and clear `folderId`'s pending focus buffer. Called by publishFolderNode
 *  so every folder-chain step flushes whatever focus accumulated since the last
 *  one — the §7/§8 drain-on-step rule. Returns the deltas in arrival order;
 *  empty array if nothing pending. */
function drainFocusBuffer(folderId: string): FolderDelta[] {
  const arr = storedFocus(folderId);
  if (arr.length === 0) return [];
  const out = arr.splice(0, arr.length);
  persistFocus(folderId, arr);
  return out;
}

function restoreFocusBuffer(folderId: string, entries: FolderDelta[]): void {
  if (entries.length === 0) return;
  const current = storedFocus(folderId);
  current.unshift(...entries);
  persistFocus(folderId, current);
}

/** Publishes a folder-reified 4290 node stepping `members` as the current
 *  snapshot. `prevEventId` null = genesis; otherwise the node chains off the
 *  prior head. `action`/`deltas` describe the change set (or `import` for
 *  genesis). Signs with `signer` or the active voice. Returns the signed event.
 *
 *  **Drains the focus buffer** (§8): any focus observations accumulated since
 *  the last folder step are appended to `deltas`, so they ride along on a node
 *  that was stepping anyway rather than minting their own. This is the §R7
 *  mechanism — callers never need to flush focus explicitly on the step path.
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
    operationId?: string;
    folderCheckpoint: FolderCheckpoint;
    /** Step the folder manifest only to the home relay. Used when a local
     *  file Step changes membership but has not been Sent. */
    localOnly?: boolean;
  },
): Promise<Event> {
  const key = opts.signer ?? authoringVoice().secretKey;
  const steppedAt = Date.now();
  const operationId = opts.operationId ?? createTraceOperationId();
  if (!isTraceOperationId(operationId)) {
    throw new Error("cannot publish a folder checkpoint with a malformed operation id");
  }
  // §8: drain any focus observations buffered since the last folder step and
  // append them to this node's deltas. The structural delta (if any) stays
  // first so directory-log readers that take deltas[0] still see it.
  // Genesis (folderId null) has no focus buffer — it's the identity-minting
  // node, nothing to drain.
  const drainedFocus = folderId ? drainFocusBuffer(folderId) : [];
  const allDeltas = [...(opts.deltas ?? []), ...drainedFocus];
  const template = buildFolderNodeTemplate(
    folderId,
    members,
    opts.prevEventId,
    opts.action,
    allDeltas,
    steppedAt,
    operationId,
    opts.folderCheckpoint,
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
  let nodePublished = false;
  try {
    const parsed = JSON.parse(template.content) as { contentHash?: string };
    parsed.contentHash = await hashFolderSnapshot(members);
    template.content = JSON.stringify(parsed);
    template.tags.push(["x", parsed.contentHash!]);

    const signed = finalizeEvent(template, key);
    let relays: Relay[] = [];
    if (opts.localOnly) {
      enqueueLocalEvent(signed);
      nodePublished = true;
      const home = await getRelayRetrying(resolveRelayUrl(), 1);
      if (home) {
        await flushLocalEventOutboxThrough(home);
        if (!pendingLocalEventById(signed.id)) relays = [home];
      }
    } else {
      relays = await getWriteRelays();
      await publishToMany(relays, signed);
      nodePublished = true;
    }
    // Spec §4: also publish a TraceHead (kind 34290) head-pointer cache so the
    // folder's head resolves as one bounded fetch for O(1) consumers. `d` = trace
    // identity. Genesis (folderId null) IS the identity — nothing to point at yet,
    // so no TraceHead. The first non-genesis step caches it.
    if (folderId && relays.length > 0) {
      await publishTraceHead(folderId, signed.id, key, relays);
    }
    return signed;
  } catch (error) {
    // If the node itself never landed, put its observations back at the front so
    // the next real folder Step can carry them. A TraceHead-cache failure happens
    // after the node is durable and must not duplicate the deltas.
    if (folderId && !nodePublished) restoreFocusBuffer(folderId, drainedFocus);
    throw error;
  }
}

/** Publishes a kind-34290 TraceHead pointing at a trace's current nucleus.
 *  Spec §4: `d` = trace identity, content `{ head }`, written on every step.
 *  Reuses the already-connected write relays and the same signer key as the
 *  triggering step. */
export function nextReplaceableCreatedAt(
  nowSec: number,
  priorCreatedAt?: number,
): number {
  return priorCreatedAt == null ? nowSec : Math.max(nowSec, priorCreatedAt + 1);
}

const traceHeadCreatedAt = new Map<string, number>();
const traceHeadPublishQueue = new Map<string, Promise<void>>();

async function publishTraceHead(
  traceIdentity: string,
  headEventId: string,
  signer: Uint8Array,
  relays: Relay[],
): Promise<void> {
  const signerPubkey = getPublicKey(signer);
  const key = `${signerPubkey}:${traceIdentity}`;
  const previous = traceHeadPublishQueue.get(key) ?? Promise.resolve();
  const pending = previous.catch(() => {}).then(async () => {
    let priorCreatedAt = traceHeadCreatedAt.get(key);
    if (priorCreatedAt == null) {
      try {
        const existing = await queryMany(relays, {
          kinds: [TRACE_HEAD_KIND],
          authors: [signerPubkey],
          "#d": [traceIdentity],
        });
        for (const event of existing) {
          priorCreatedAt = Math.max(priorCreatedAt ?? -1, event.created_at);
        }
      } catch {
        // Best effort. The in-process clock still prevents the common rapid
        // Step/Oblivion/restore collision when a relay read is unavailable.
      }
    }
    const createdAt = nextReplaceableCreatedAt(
      Math.floor(Date.now() / 1000),
      priorCreatedAt,
    );
    traceHeadCreatedAt.set(key, createdAt);
    const template: EventTemplate = {
      kind: TRACE_HEAD_KIND,
      created_at: createdAt,
      tags: [["d", traceIdentity]],
      content: JSON.stringify({ head: headEventId }),
    };
    const signed = finalizeEvent(template, signer);
    await publishToMany(relays, signed);
  });
  traceHeadPublishQueue.set(key, pending);
  try {
    await pending;
  } finally {
    if (traceHeadPublishQueue.get(key) === pending) traceHeadPublishQueue.delete(key);
  }
}

/** The `["g", geohash]` tags on a folder node, in tag order. Empty array for
 *  nodes with no pins (the common case). */
function geohashesFromNode(event: Event): string[] {
  return event.tags.filter((t) => t[0] === "g" && typeof t[1] === "string").map((t) => t[1] as string);
}

/** Read the folder's current geohash pins from its latest folder node. Empty array
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
  const members = previous ? membersFromNode(previous) : [];
  const current = previous ? geohashesFromNode(previous) : [];
  const next = Array.from(new Set(geohashes.filter((h) => typeof h === "string" && h.length > 0)));
  // Equal (order-insensitive) → no node needed.
  if (current.length === next.length && current.every((h) => next.includes(h))) return null;
  return publishFolderNode(folderId, members, {
    prevEventId: previous?.id ?? null,
    action: previous ? "edit" : "import",
    geohashes: next,
    folderCheckpoint: { version: 1, cause: "metadata-change" },
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
    const fid = e.tags.find((t) => t[0] === "f")?.[1];
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

/** Publish a folder genesis node (empty membership, no prev, no `f`
 *  tags — an event can't know its own id before signing) and return its event
 *  id — the folder's permanent identity (spec §3.1: trace identity IS the
 *  genesis node id).
 *  Callers adopt the returned id as `FolderRef.id`. */
export async function createFolderGenesis(opts?: {
  signer?: Uint8Array;
  forkedFrom?: string | null;
  members?: ManifestFileEntry[];
  memberOwners?: string[];
  action?: string;
  operationId?: string;
  /** Keep the new folder identity on the home relay until an explicit Send. */
  localOnly?: boolean;
}): Promise<string> {
  const event = await publishFolderNode(null, opts?.members ?? [], {
    prevEventId: null,
    action: opts?.action ?? "import",
    signer: opts?.signer,
    forkedFrom: opts?.forkedFrom ?? null,
    memberOwners: opts?.memberOwners,
    localOnly: opts?.localOnly,
    operationId: opts?.operationId,
    folderCheckpoint: { version: 1, cause: "genesis" },
  });
  return event.id;
}

/** Reads the current membership, replaces the single entry for
 *  `entry.relativePath` (or appends it), and publishes the next folder node.
 *  Called from every step/import path so the folder chain never drifts from
 *  the actual file-chain heads. For deletes, use `removeManifestEntry` —
 *  spec-clean tombstones drop the member rather than tombstoning it. */
export function planManifestUpsert(
  current: readonly ManifestFileEntry[],
  entry: ManifestFileEntry,
  timestamp: number,
):
  | { unchanged: true }
  | {
      unchanged: false;
      members: ManifestFileEntry[];
      deltas: FolderDelta[];
      folderCheckpoint: FolderCheckpoint;
    } {
  const existing = current.find((member) => member.relativePath === entry.relativePath);
  if (
    existing &&
    existing.kind === entry.kind &&
    existing.latestNodeId === entry.latestNodeId &&
    existing.contentHash === entry.contentHash
  ) {
    return { unchanged: true };
  }
  const members = existing
    ? current.map((member) => member.relativePath === entry.relativePath ? entry : member)
    : [...current, entry];
  if (existing?.kind === entry.kind) {
    return {
      unchanged: false,
      members,
      deltas: [{
        type: "advance",
        kind: entry.kind,
        relativePath: entry.relativePath,
        previousNodeId: existing.latestNodeId,
        nodeId: entry.latestNodeId,
        timestamp,
      }],
      folderCheckpoint: {
        version: 1,
        cause: "child-advance",
        sourceNodeId: entry.latestNodeId,
      },
    };
  }
  return {
    unchanged: false,
    members,
    deltas: [
      ...(existing
        ? [{
            type: "remove" as const,
            kind: existing.kind,
            relativePath: existing.relativePath,
            nodeId: existing.latestNodeId,
            timestamp,
          }]
        : []),
      {
        type: "add",
        kind: entry.kind,
        relativePath: entry.relativePath,
        nodeId: entry.latestNodeId,
        timestamp,
      },
    ],
    folderCheckpoint: { version: 1, cause: "structure-change" },
  };
}

export async function upsertManifestEntry(
  folderId: string,
  entry: ManifestFileEntry,
  signer?: Uint8Array,
  opts?: { localOnly?: boolean; operationId?: string },
): Promise<Event> {
  const previous = await fetchLatestFolderNode(folderId);
  const current = previous ? membersFromNode(previous) : [];
  const plan = planManifestUpsert(current, entry, Date.now());
  if (plan.unchanged && previous) return previous;
  if (plan.unchanged) {
    throw new Error(`cannot preserve ${entry.relativePath} without a folder head`);
  }
  return publishFolderNode(folderId, plan.members, {
    prevEventId: previous?.id ?? null,
    action: previous ? "edit" : "import",
    deltas: plan.deltas,
    signer,
    localOnly: opts?.localOnly,
    operationId: opts?.operationId,
    folderCheckpoint: plan.folderCheckpoint,
  });
}

/** Removes the member for `relativePath` from the folder snapshot and publishes
 *  the next folder node with a `remove` delta. This is the spec-clean tombstone:
 *  the file's own 4290 chain (whose head is now the delete node) retains
 *  history; the folder snapshot just reflects "no longer a member." Used by the
 *  three backends' `markDeleted` helpers. */
export async function removeManifestEntry(
  folderId: string,
  relativePath: string,
  signer?: Uint8Array,
  opts?: { localOnly?: boolean; operationId?: string },
): Promise<Event | null> {
  const previous = await fetchLatestFolderNode(folderId);
  const current = previous ? membersFromNode(previous) : [];
  const existing = current.find((entry) => entry.relativePath === relativePath);
  if (!existing) return null;
  const next = current.filter((f) => f.relativePath !== relativePath);
  return publishFolderNode(folderId, next, {
    prevEventId: previous?.id ?? null,
    action: previous ? "edit" : "import",
    deltas: [{ type: "remove", kind: existing.kind, relativePath, timestamp: Date.now() }],
    signer,
    localOnly: opts?.localOnly,
    operationId: opts?.operationId,
    folderCheckpoint: { version: 1, cause: "structure-change" },
  });
}

/** Renames a member's `relativePath` from `fromPath` to `toPath` and publishes
 *  the next folder node with a single `rename` delta — one replayable event for
 *  one user gesture, instead of the pre-rename decomposition into add+remove
 *  (which orphaned the file's history from its new path). The member's
 *  `latestNodeId` and `contentHash` are carried over unchanged: the file's own
 *  4290 chain is untouched, only the folder's addressing of it moves. The new
 *  file node at `toPath` (stepped by the caller before this) is the `nodeId`.
 *  The folder's `contentHash`/`x` DOES change — correct, since the §2 canonical
 *  projection is the ordered `(relativePath, memberContentHash)` list and a path
 *  moved is a different projection. */
export async function renameManifestEntry(
  folderId: string,
  fromPath: string,
  toPath: string,
  nodeId: string,
  signer?: Uint8Array,
  opts?: { localOnly?: boolean; operationId?: string },
): Promise<Event> {
  const previous = await fetchLatestFolderNode(folderId);
  const current = previous ? membersFromNode(previous) : [];
  // Repoint the renamed member's path; carry over latestNodeId/contentHash.
  // Races and target collisions are rejected so the writer cannot emit a node
  // that the strict folder-chain verifier would reject.
  const existing = current.find((f) => f.relativePath === fromPath);
  if (!existing) {
    throw new Error(`cannot rename missing folder member ${fromPath}`);
  }
  if (fromPath !== toPath && current.some((member) => member.relativePath === toPath)) {
    throw new Error(`cannot rename folder member ${fromPath}: target ${toPath} already exists`);
  }
  const renamed: ManifestFileEntry = { ...existing, relativePath: toPath, latestNodeId: nodeId };
  const next = current
    .filter((member) => member.relativePath !== toPath)
    .map((member) => member.relativePath === fromPath ? renamed : member);
  return publishFolderNode(folderId, next, {
    prevEventId: previous?.id ?? null,
    action: previous ? "edit" : "import",
    // Carry the member's kind onto the rename delta (spec §3.3 — kind mirrors
    // the member entry).
    deltas: [{ type: "rename", kind: existing.kind, fromPath, toPath, nodeId, timestamp: Date.now() }],
    signer,
    localOnly: opts?.localOnly,
    operationId: opts?.operationId,
    folderCheckpoint: { version: 1, cause: "structure-change" },
  });
}

const folderStepManifestFlights = new Map<string, Promise<Event>>();

async function stepFolderManifestOnce(
  folderId: string,
  signer: Uint8Array,
  opts: { localOnly?: boolean; operationId: string },
): Promise<Event> {
  const expectedOwnerPubkey = getPublicKey(signer);
  const federatedNodes = await fetchFolderNodes(folderId);
  const acceptedNodes = opts.localOnly
    ? await fetchHomeFolderNodes(folderId)
    : federatedNodes;
  const observedNodes = [...new Map(
    [...federatedNodes, ...acceptedNodes].map((event) => [event.id, event]),
  ).values()];
  const current = await requireCurrentFolderChain(
    folderId,
    acceptedNodes,
    expectedOwnerPubkey,
  );

  const matchingExplicit = observedNodes.filter((event) => {
    const meta = eventMeta(event);
    return meta.operationId === opts.operationId &&
      meta.folderCheckpoint?.cause === "explicit-step";
  });
  if (matchingExplicit.length > 1) {
    throw new Error(
      `folder Step operation ${opts.operationId} already has multiple explicit checkpoints`,
    );
  }
  const acceptedExplicit = matchingExplicit[0];
  if (acceptedExplicit) {
    await requireValidFolderChain(
      folderId,
      acceptedExplicit,
      observedNodes,
      expectedOwnerPubkey,
    );
    if (!acceptedNodes.some((event) => event.id === acceptedExplicit.id)) {
      throw new Error(
        `folder Step operation ${opts.operationId} is not accepted by the home relay`,
      );
    }
    if (acceptedExplicit.id !== current.head.id) {
      throw new Error(
        `cannot resume folder Step operation ${opts.operationId}: folder head advanced after its explicit checkpoint`,
      );
    }
    return current.head;
  }

  return publishFolderNode(folderId, membersFromNode(current.head), {
    prevEventId: current.head.id,
    action: "edit",
    signer,
    localOnly: opts.localOnly,
    operationId: opts.operationId,
    folderCheckpoint: { version: 1, cause: "explicit-step" },
  });
}

/** Append the deliberate landmark for an already-materialized folder frontier.
 * Same-operation callers share the complete check/publish flight, so two local
 * retries cannot both observe the same prior head and mint sibling Steps. */
export async function stepFolderManifest(
  folderId: string,
  signer?: Uint8Array,
  opts?: { localOnly?: boolean; operationId?: string },
): Promise<Event> {
  const key = signer ?? authoringVoice().secretKey;
  const operationId = opts?.operationId ?? createTraceOperationId();
  if (!isTraceOperationId(operationId)) {
    throw new Error("cannot Step a folder with a malformed operation id");
  }
  const publicationScope = opts?.localOnly ? "home" : "federated";
  const flightKey = `${getPublicKey(key)}:${folderId}:${operationId}:${publicationScope}`;
  const existing = folderStepManifestFlights.get(flightKey);
  if (existing) return existing;

  const pending = stepFolderManifestOnce(folderId, key, {
    localOnly: opts?.localOnly,
    operationId,
  });
  folderStepManifestFlights.set(flightKey, pending);
  try {
    return await pending;
  } finally {
    if (folderStepManifestFlights.get(flightKey) === pending) {
      folderStepManifestFlights.delete(flightKey);
    }
  }
}

/** Expose the shared operation id on a signed node to transaction coordinators. */
export function operationIdFromNode(event: Pick<Event, "content">): string {
  const operationId = traceOperationIdFromEvent(event as Event);
  if (!operationId) throw new Error("signed TraceNode is missing its operation id");
  return operationId;
}

// --- buffered focus deltas ----------------------------------------------
//
// Focus is panel-occupancy telemetry (§3.3): it records what trace was in which
// panel, so a reading session can be replayed in the press editor. The WRITE
// path never mints its own node — focus observations go through bufferFocus
// (above) and ride along on the next folder-chain step as additional `deltas`
// entries. The local buffer persists across press sessions until a structural
// folder Step drains it. This is §R7: focus fires per click, and a per-click node would
// re-serialize the full membership snapshot every time — the exact per-keystroke
// collapse §R1 warns against.
//
// Focus therefore exists on the chain only as extra deltas carried by a real
// folder Step. It never changes `snapshot.members`, `contentHash`, or `q` edges.

/** One replayable focus event on the folder's folder chain. `steppedAt` is the
 *  node's content-level ms timestamp (chain order, never `created_at`); the
 *  op/selection/panelIndex fields come straight off the focus delta. */
export interface FocusEntry {
  steppedAt: number;
  /** Original observation time retained inside the later carrying Step. */
  observedAt: number;
  op: "mount" | "unmount";
  selection: FocusSelection;
  panelIndex: number;
}

/** The folder's folder focus chain, oldest-first — every `focus` delta the
 *  folder has emitted, in chain order. This is the replay script: walking it
 *  reconstructs what trace was mounted into which panel over the folder's
 *  lifetime. Non-focus nodes (membership changes, genesis) are skipped, but a
 *  node that carries BOTH a membership delta and flushed focus deltas yields one
 *  FocusEntry per focus delta — readers iterate the `deltas` array, not `[0]`.
 *  A folder with no focus observations returns []. */
export async function focusTimeline(folderId: string): Promise<FocusEntry[]> {
  const all = await fetchFolderNodes(folderId);
  // Walk the `e...prev` chain oldest-first — same rule as fetchChain (never
  // trust created_at; order comes from the chain). A folder with no
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
        steppedAt: number;
        deltas?: unknown[];
      };
      // §8: a node MAY carry several deltas (one structural + N flushed focus).
      // Iterate, push one FocusEntry per focus delta — order preserved.
      if (!content.deltas) continue;
      for (const delta of content.deltas) {
        if (!isFocusDelta(delta)) continue;
        out.push({
          steppedAt: content.steppedAt,
          observedAt: delta.timestamp,
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
  const pending = pendingLocalEventById(nodeId);
  if (pending) return pending;
  const relays = await getReadRelays();
  const filter: Filter = { ids: [nodeId] };
  for (const relay of relays) {
    try {
      const events = await queryOnce(relay, filter);
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

/** Resolve the fixed owner of a folder trace. Genesis is authoritative because
 * a trace has one owner for its whole lifetime; a malformed later node signed
 * by another key must never redefine ownership. */
export function folderOwnerFromNodes(folderId: string, nodes: readonly Event[]): string | null {
  const genesis = nodes.find(
    (event) =>
      event.id === folderId &&
      event.tags.some((tag) => tag[0] === "z" && tag[1] === "folder"),
  );
  return genesis?.pubkey ?? null;
}

/** Returns the fixed owner (signer pubkey) of a folder, or null when no folder
 * chain can be verified on the configured read relays. */
export async function fetchFolderOwner(folderId: string): Promise<string | null> {
  return folderOwnerFromNodes(folderId, await fetchFolderNodes(folderId));
}

/** Seeds a shallow folder fork under the user's key. Reads the source folder's
 *  latest folder node (or its genesis as a fallback) and publishes a folder
 *  genesis: `action: "fork"`,
 *  `forked-from` the source node, `snapshot.members` copied verbatim from the
 *  source (each member still points at the source owner's node — a citation,
 *  not a copy), member `q` tags carrying the source owner's pubkey so ownership
 *  is recoverable from the fork node alone. Returns the genesis event. */
export async function forkFolder(
  sourceFolderId: string,
  opts?: { signer?: Uint8Array; localOnly?: boolean; operationId?: string },
): Promise<Event> {
  const sourceNode =
    await fetchLatestFolderNode(sourceFolderId) ??
    await fetchEventById(sourceFolderId);
  if (!sourceNode) {
    throw new Error(`Cannot fork folder ${sourceFolderId}: no folder chain found on any read relay.`);
  }
  const members = membersFromNode(sourceNode);
  const forkedFrom = sourceNode.id;
  const sourceOwner = sourceNode.pubkey;

  // One owner for all initially-cited members (the source folder's signer).
  // A forked folder's membership may later mix owners (after fork-on-write),
  // but at genesis every member is the source owner's.
  const memberOwners = sourceOwner ? members.map(() => sourceOwner!) : undefined;

  return publishFolderNode(null, members, {
    prevEventId: null, // genesis under a new owner — a fresh chain
    action: "fork",
    forkedFrom,
    memberOwners,
    signer: opts?.signer,
    localOnly: opts?.localOnly,
    operationId: opts?.operationId,
    folderCheckpoint: { version: 1, cause: "genesis" },
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
  opts?: { signer?: Uint8Array; operationId?: string },
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
  const signer = opts?.signer ?? authoringVoice().secretKey;

  return publishEdit({
    prevEventId: null, // genesis under a new owner
    previousSnapshot: "",
    relativePath,
    folderId: destFolderId,
    deltas: [],
    snapshot,
    contentHash,
    action: "fork",
    summary: `forked from ${sourceNodeId.slice(0, 8)}`,
    signer,
    forkedFrom: sourceNodeId,
    kedits: synthesizeKEditTransition("", snapshot, getPublicKey(signer)),
    operationId: opts?.operationId,
  });
}

/** Fork a specific historical node (by id) into a new file trace under the
 *  destination folder. Unlike `forkFile` (which forks the *latest* node of a
 *  folder+path), this forks an arbitrary node — used by the stepper's
 *  "fork from this step" gesture, where the user picks a historical checkpoint
 *  to branch from. The snapshot is taken verbatim from the source node. */
export async function forkFileFromNode(
  sourceNodeId: string,
  destFolderId: string,
  destRelativePath: string,
  opts?: { signer?: Uint8Array; localOnly?: boolean; operationId?: string },
): Promise<Event> {
  const sourceEvent = await fetchEventById(sourceNodeId);
  if (!sourceEvent) {
    throw new Error(`Cannot fork: source node ${sourceNodeId} not fetchable.`);
  }
  const parsed = JSON.parse(sourceEvent.content) as {
    snapshot?: string;
    contentHash?: string;
  };
  const snapshot = typeof parsed.snapshot === "string" ? parsed.snapshot : "";
  const contentHash = parsed.contentHash ?? (await sha256HexLocal(snapshot));
  const signer = opts?.signer ?? authoringVoice().secretKey;

  return publishEdit({
    prevEventId: null, // genesis under a new owner
    previousSnapshot: "",
    relativePath: destRelativePath,
    folderId: destFolderId,
    deltas: [],
    snapshot,
    contentHash,
    action: "fork",
    summary: `forked from ${sourceNodeId.slice(0, 8)}`,
    signer,
    localOnly: opts?.localOnly,
    forkedFrom: sourceNodeId,
    kedits: synthesizeKEditTransition("", snapshot, getPublicKey(signer)),
    operationId: opts?.operationId,
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
  const signer = input.signer ?? authoringVoice().secretKey;

  // Default authors: full adopt of first parent → one verified-attributed run.
  // Selective/custom bodies leave authors to the caller (or signer-only).
  let authors = input.authors;
  if (authors === undefined && snapshot === parentSnapshot && snapshot.length > 0) {
    authors = authorsFromMergeParent(parentEvent.pubkey, parentEvent.id, snapshot);
  }

  return publishEdit({
    prevEventId: input.prevEventId,
    previousSnapshot: prevSnapshot,
    relativePath: input.relativePath,
    folderId: input.folderId,
    deltas,
    snapshot,
    contentHash,
    action: "merge",
    summary: input.summary ?? `merged ${parentId.slice(0, 8)}`,
    authors,
    mergeParents: input.mergeParentIds,
    signer,
    kedits: synthesizeKEditTransition(prevSnapshot, snapshot, getPublicKey(signer)),
  });
}

// --- palette (kind 34291 = TraceOpinion) ---------------------------------
//
// The palette is the user's curated set of coins — the "module of
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

/** One entry in a voice's palette. `text` is a cache of the coin's
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
  const voice = authoringVoice();
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
  const voice = authoringVoice();
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
  return e.kind === TRACE_NODE_KIND && fileTag(e, "z") === "file";
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
      kinds: [TRACE_NODE_KIND],
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
    kinds: [TRACE_NODE_KIND],
    "#F": [relativePath],
    "#f": [folderId],
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
    const theirFolder = fileTag(genesis, "f");
    const theirPath = fileTag(genesis, "F") ?? relativePath;
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
      kinds: [TRACE_NODE_KIND],
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
  /** Stable genesis identity of the inbound trace. Unlike sourceEventId, this
   * survives edits, moves into Oblivion, and restore. */
  sourceTraceId: string;
  /** The inbound trace's node (its genesis for a fork, or the citing node). */
  sourceEventId: string;
  /** Current path advertised by the verified source head, when present. */
  sourcePath?: string;
  /** Our node the inbound trace points at (forked-from / cited source). */
  fromNodeId: string;
  /** Signer of the inbound trace — for display when no name resolves. */
  ownerPubkey: string;
  /** Resolved later by the press via `resolveNodeName`; undefined until then. */
  name?: string;
}

/** Remove inbound entries whose current source node is locally hidden. The
 *  press uses this while a move into Oblivion is still being published: the
 *  in-memory file has already moved, but the relay may still report its old
 *  head for a moment. Returning the original array when nothing is removed
 *  avoids needless React churn. */
export function excludeInboundSources(
  inbound: TraceInbound[],
  hiddenSourceIds: ReadonlySet<string>,
): TraceInbound[] {
  if (hiddenSourceIds.size === 0) return inbound;
  const visible = inbound.filter(
    (entry) => !hiddenSourceIds.has(entry.sourceTraceId),
  );
  return visible.length === inbound.length ? inbound : visible;
}

/** A raw delta parsed out of an event's content for inbound scanning. The cite
 *  role (inline/live/tag/reply, spec §3.3) distinguishes a tag from a quote
 *  from a reply; `sourceEventId` is the pinned nucleus the cite points at. All
 *  fields optional — `findInboundSnapshot` guards each before use. */
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

export interface ResolvedInboundHead {
  traceId: string;
  head: Event;
}

export interface InboundHeadSnapshot {
  heads: ResolvedInboundHead[];
  /** False means at least one historical source could not be resolved to a
   * verified current head. Consumers must retain their last verified row. */
  complete: boolean;
}

type TraceIdentityResolver = (nodeId: string) => Promise<string | null>;
type StableTraceResolver = (
  traceId: string,
  exactHeadId?: string,
) => Promise<TraceChainResolution>;

/** Resolve historical inbound hits through stable trace identity. No failed
 * lookup falls back to a historical event: that would resurrect citations
 * removed by a later edit/delete. */
export async function resolveInboundHeadSnapshot(
  refs: readonly Event[],
  identityResolver: TraceIdentityResolver = resolveTraceIdentity,
  traceResolver: StableTraceResolver = resolveTraceChain,
): Promise<InboundHeadSnapshot> {
  const grouped = new Set<string>();
  let complete = true;

  for (const ref of refs) {
    let traceId: string | null = null;
    try {
      traceId = await identityResolver(ref.id);
    } catch {
      // Treat relay failures as an incomplete observation, never as proof that
      // the historical hit is still current.
    }
    if (!traceId) {
      complete = false;
      continue;
    }
    grouped.add(traceId);
  }

  const heads: ResolvedInboundHead[] = [];
  for (const traceId of grouped) {
    try {
      // A historical ref's coordinate or node id is not proof of the current
      // head. Follow the stable TraceHead and fail closed if it is unavailable.
      const resolution = await traceResolver(traceId);
      if (resolution.status !== "resolved" || resolution.chain.length === 0) {
        complete = false;
        continue;
      }
      heads.push({ traceId, head: resolution.chain[resolution.chain.length - 1] });
    } catch {
      complete = false;
    }
  }
  return { heads, complete };
}

/** Classify verified current heads of citing traces. `action:delete` is the
 * relay-visible lifecycle signal; a path that happens to contain "oblivion"
 * is not, because Oblivion is a local workspace convention. */
export function inboundCitationsFromResolvedHeads(
  sources: readonly ResolvedInboundHead[],
  targetIds: ReadonlySet<string>,
): TraceInbound[] {
  const out: TraceInbound[] = [];
  const seen = new Set<string>();
  for (const { traceId, head } of sources) {
    if (fileTag(head, "action") === "delete") continue;
    const sourcePath = fileTag(head, "F");
    for (const targetId of targetIds) {
      const kind = classifyQEdge(head, targetId);
      if (!kind) continue;
      const key = `${kind}:${traceId}:${targetId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        kind,
        sourceTraceId: traceId,
        sourceEventId: head.id,
        ...(sourcePath ? { sourcePath } : {}),
        fromNodeId: targetId,
        ownerPubkey: head.pubkey,
      });
    }
  }
  return out;
}

export interface InboundSnapshot {
  entries: TraceInbound[];
  /** True only when the target and every discovered source resolved to a
   * current, signed head. False is an offline/conflict/stale observation. */
  complete: boolean;
}

/** Keep only historical `q` hits that could represent an inbound citation.
 * Structural folder-membership and LLM-scope edges are deliberately removed
 * before current-head resolution so they cannot make an otherwise complete
 * zero-citation observation look unavailable. */
export function filterInboundCitationRefs(
  refs: readonly Event[],
  targetIds: ReadonlySet<string>,
): Event[] {
  return refs.filter((ref) => {
    for (const targetId of targetIds) {
      if (classifyQEdge(ref, targetId)) return true;
    }
    return false;
  });
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
 * silently miss every coin quoted in a body, since the write path only
 * emits cite deltas for `tag` and `reply`, not `inline`.
 */
export async function findInboundSnapshot(
  targetTraceId: string,
): Promise<InboundSnapshot> {
  let complete = true;
  let ours: Event[] = [];
  try {
    const resolution = await resolveTraceChain(targetTraceId);
    if (resolution.status !== "resolved") {
      return { entries: [], complete: false };
    }
    ours = resolution.chain;
  } catch {
    return { entries: [], complete: false };
  }
  const ourIds = new Set(ours.map((e) => e.id));
  if (ourIds.size === 0) return { entries: [], complete: false };

  const out: TraceInbound[] = [];
  const seen = new Set<string>();

  // Forks: geneses (no prev) with `forked-from` → our chain. Same post-filter
  // as findMergeCandidates (provenance.ts ~2501) but WITHOUT the self-fork skip
  // — the tracker shows all forks; the merge-banner keeps its own skip.
  let forkRefs: Event[] = [];
  try {
    forkRefs = await queryReferencing([...ourIds]);
  } catch {
    complete = false;
  }
  const forkGenesisByTrace = new Map<string, { genesis: Event; fromNodeId: string }>();
  for (const event of forkRefs) {
    if (!isFileNode(event)) continue;
    const hasPrev = event.tags.some((tag) => tag[0] === "e" && tag[3] === "prev");
    if (hasPrev) continue;
    const forkedFrom = event.tags.find(
      (tag) => tag[0] === "e" && tag[3] === "forked-from",
    )?.[1];
    if (!forkedFrom || !ourIds.has(forkedFrom)) continue;
    forkGenesisByTrace.set(event.id, { genesis: event, fromNodeId: forkedFrom });
  }
  const forkSnapshot = await resolveInboundHeadSnapshot(
    [...forkGenesisByTrace.values()].map((entry) => entry.genesis),
    async (nodeId) => nodeId,
  );
  complete = complete && forkSnapshot.complete;
  for (const { traceId, head } of forkSnapshot.heads) {
    const origin = forkGenesisByTrace.get(traceId);
    if (!origin || fileTag(head, "action") === "delete") continue;
    const key = `fork:${traceId}:${origin.fromNodeId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const sourcePath = fileTag(head, "F");
    out.push({
      kind: "fork",
      sourceTraceId: traceId,
      sourceEventId: head.id,
      ...(sourcePath ? { sourcePath } : {}),
      fromNodeId: origin.fromNodeId,
      ownerPubkey: head.pubkey,
    });
  }

  // Tags + cites: events with a `q` edge pinning one of our nodes. The `q` tag
  // is the single composition edge (spec §R4) — a `q` into our chain IS a
  // citation, the same fact the outbound reader `eventMeta.citationTargets`
  // reads off every `q`. We do NOT rely on the cite delta to *detect* the edge:
  // the write path only emits `cite` deltas for `tag` and `reply`, NOT for
  // `inline` bracket quotes (which emit a `q` + a body insert, no cite delta).
  // So a cite-delta-only approach would silently miss every coin
  // quoted in someone's body — the common case. Instead: exclude the two
  // non-citation `q` sources (folder membership, LLM scope), then classify each
  // remaining edge by whether it carries a `role:"tag"` cite delta.
  let qRefs: Event[] = [];
  try {
    qRefs = await queryReferencingByQ([...ourIds]);
  } catch {
    complete = false;
  }
  // Resolve only citation-shaped historical hits. Folder membership and LLM
  // scope use the same `q` wire edge but are not citation sources, and their
  // inability to resolve as file traces must not poison snapshot freshness.
  const sourceSnapshot = await resolveInboundHeadSnapshot(
    filterInboundCitationRefs(qRefs, ourIds),
  );
  complete = complete && sourceSnapshot.complete;
  for (const entry of inboundCitationsFromResolvedHeads(sourceSnapshot.heads, ourIds)) {
    const key = `${entry.kind}:${entry.sourceTraceId}:${entry.fromNodeId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }

  return { entries: out, complete };
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
 *  `inline` bracket quotes. See `findInboundSnapshot` for the rationale. */
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
    authors?: import("../workspace/workspace-core.js").Run[];
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
      kind: "file",
      relativePath,
      latestNodeId: event.id,
      contentHash: await sha256HexLocal(snapshot),
    },
    opts?.signer,
    { operationId: operationIdFromNode(event) },
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
//                           content `{ rank, steppedAt }` (lower = earlier in
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
  const signer = authoringVoice();
  const steppedAt = Date.now();
  const template: EventTemplate = {
    kind: TRACE_OPINION_KIND,
    created_at: Math.floor(steppedAt / 1000),
    tags: [["d", `sd:${signer.publicKey}`]],
    content: JSON.stringify({
      defs: defs.map((d, i) => ({ id: d.id, title: d.title, order: typeof d.order === "number" ? d.order : i })),
      steppedAt,
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
 *  content `{ rank, steppedAt }`. Mirrors `publishTraceRank`'s shape on a
 *  different subject namespace. */
export async function publishStackAssignment(input: {
  stackId: string;
  folderId: string;
  rank: number;
  signer?: Uint8Array;
}): Promise<Event> {
  const relays = await getWriteRelays();
  const signer = input.signer ?? authoringVoice().secretKey;
  const steppedAt = Date.now();
  const template: EventTemplate = {
    kind: TRACE_OPINION_KIND,
    created_at: Math.floor(steppedAt / 1000),
    tags: [["d", `sa:${input.stackId}:${input.folderId}`]],
    content: JSON.stringify({ rank: input.rank, steppedAt }),
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

/** Reorder sample hits by citation count (which folds in attests — an attest
 *  is a `q`-tag citation). Deterministic: same query → same order. Stable sort
 *  preserves the sampler's first-seen insertion order as the tiebreak, so
 *  equal-rank hits keep sampleRelays' output order rather than reshuffling on
 *  refresh. (The former effectiveAlpha signal was removed — it had no
 *  publishers, so citation count is now the sole visibility weight.) */
export async function rankSampleHits(hits: SampleHit[]): Promise<SampleHit[]> {
  // Decorate each hit with a score, then stable-sort descending by score.
  const scored = hits.map((hit, i) => {
    const meta = eventMeta(hit.event);
    return { hit, score: meta.citationCount, i };
  });
  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  return scored.map((s) => s.hit);
}

/** Reconstructs file content as of a single step, by replaying the chain
 *  from genesis through `throughIndex` (inclusive). Used by folder-wide
 *  replay, which steps step-by-step rather than always landing on the head.
 *  Equivalent to `reconstructFromChain(chain.slice(0, throughIndex + 1))`;
 *  exposed so callers don't reach past `reconstructFromChain` to fold deltas
 *  themselves. Out-of-range indices clamp to the chain ends. */
export function reconstructUpTo(chain: Event[], throughIndex: number): string {
  const end = Math.max(0, Math.min(throughIndex + 1, chain.length));
  return reconstructFromChain(chain.slice(0, end));
}

/** Reconstruct file content from each unconditional snapshot. */
export function reconstructFromChain(chain: Event[]): string {
  let content = "";
  for (const event of chain) {
    const parsed = JSON.parse(event.content) as { snapshot?: string };
    if (typeof parsed.snapshot !== "string") {
      throw new Error(`TraceNode ${event.id} is missing its required snapshot`);
    }
    content = parsed.snapshot;
  }
  return content;
}

/** Read structurally valid KEdits from one node. This tolerant extractor
 * returns `[]` for an explicit empty log and for missing/malformed input; use
 * `traceProcessFromEvent` when conformance must distinguish those cases and
 * validate the full transition. */
export function keditsFromEvent(event: Event): KEdit[] {
  return parseKEditsFromContent(event.content);
}

/** Reconstruct per-author runs by replaying the chain. Attribution is sourced
 *  from three current carriers, per node in order — the first path that fires wins:
 *
 *  1. **Position-bearing content deltas** → splice each delta's insert into the
 *     running run-list, resolving its optional `author` index through the
 *     node-local `voices` table and defaulting to the signer.
 *  2. **`authors` field present and valid** (concatenates to this node's
 *     `snapshot`) → adopt the run list when no body delta describes the change.
 *     This is the secondary carrier for bare snapshots.
 *  3. **Snapshot with no deltas and no `authors`** → the signer authored the
 *     whole snapshot (for example, genesis/import or delete). This is the only
 *     honest attribution when no
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
      voices?: unknown;
      deltas?: Array<{
        type?: string;
        position?: { start: number; end: number };
        newValue?: string | null;
        author?: unknown;
      }>;
    };
    if (typeof parsed.snapshot !== "string") {
      throw new Error(`TraceNode ${event.id} is missing its required snapshot`);
    }
    // Position-bearing content deltas only (spec §3.3: a delta changes the
    // body iff it carries a `position`). Citation deltas with role tag/reply
    // have no position and never touch text — skip them so they don't trip
    // the clamp math below. (An inline citation DOES carry a position and is
    // handled here as a body edit, which is correct.)
    const contentDeltas = (parsed.deltas ?? []).filter(
      (d) => d.position && (d.type === "insert" || d.type === "delete" || d.type === "replace"),
    );
    const fromAuthors = parseAuthors(parsed.authors, parsed.snapshot);
    if (contentDeltas.length === 0) {
      // Secondary carrier: a valid authors map describes the complete
      // snapshot when no more precise body delta is present.
      if (fromAuthors) {
        chars = runsToChars(fromAuthors);
        if (dbg) dbg.tiers[0]++;
        continue;
      }
      // No content deltas on this step. Two sub-cases:
      //  (a) a bare snapshot that differs from the running content — a
      //      wholesale reset with no delta info (for example, genesis/import
      //      or delete). The only honest attribution is the whole
      //      snapshot to this signer.
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
    // step (a step's deltas share one signer, so order only affects position
    // math, not attribution).
    for (let i = contentDeltas.length - 1; i >= 0; i--) {
      const d = contentDeltas[i];
      const start = Math.max(0, Math.min(d.position!.start, chars.length));
      const end = Math.max(start, Math.min(d.position!.end, chars.length));
      const voices = Array.isArray(parsed.voices)
        ? parsed.voices.filter((voice): voice is string => typeof voice === "string")
        : [];
      const author =
        Number.isInteger(d.author) &&
        (d.author as number) >= 0 &&
        (d.author as number) < voices.length
          ? voices[d.author as number]
          : signer;
      const insertChars = [...(d.newValue ?? "")].map((ch) => ({ ch, voice: author }));
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

/** Per-author runs as of a single step — the run-replay counterpart of
 *  reconstructUpTo. Out-of-range indices clamp to the chain ends. */
export function reconstructRunsUpTo(chain: Event[], throughIndex: number): Run[] {
  const end = Math.max(0, Math.min(throughIndex + 1, chain.length));
  return reconstructRunsFromChain(chain.slice(0, end));
}

function queryAttempt(
  relay: Relay,
  filter: Filter,
  perRelayMs: number,
): Promise<{ events: Event[]; closeReason: string }> {
  return new Promise((resolve) => {
    const found: Event[] = [];
    // Always settle: on EOSE we close + resolve immediately, and a safety
    // timer closes + resolves with whatever landed. The timer is the whole
    // point — without it a half-open WS (sub accepted, EOSE never arrives)
    // left the subscription open forever on the session-cached relay. Each
    // leaked sub piles onto the one persistent WebSocket per URL, and after a
    // few such leaks the UI freezes; closing here bounds it to one sub in
    // flight per query no matter what the relay does.
    const sub = relay.subscribe([filter], {
      onevent(evt: Event) {
        found.push(evt);
      },
      oneose() {
        sub.close();
      },
    });
    const timer = setTimeout(() => sub.close("timeout"), perRelayMs);
    // onclose fires exactly once for either close() path (EOSE or timeout);
    // clean the timer up and resolve with what we have so the queryMany/
    // fetchEventById callers never wait past perRelayMs for any relay.
    sub.onclose = (reason) => {
      clearTimeout(timer);
      resolve({ events: found, closeReason: reason });
    };
  });
}

/**
 * Query one relay, replaying the subscription once after NIP-42 AUTH.
 *
 * Khatru challenges only after the first protected REQ. nostr-tools answers
 * that challenge through `onauth`, but a bare Relay does not replay the REQ
 * that was closed as auth-required (its pool wrapper does). Without this
 * retry, a freshly-connected authorized writer sees an empty relay on its
 * first read — exactly the MCP startup path when it inspects a human folder
 * before it has published anything.
 */
async function queryOnce(relay: Relay, filter: Filter, perRelayMs = 4000): Promise<Event[]> {
  const first = await queryAttempt(relay, filter, perRelayMs);
  if (!first.closeReason.startsWith("auth-required:") || !relay.onauth) {
    return first.events;
  }

  // AUTH and CLOSED can arrive in either order. auth() coalesces onto
  // nostr-tools' in-flight authPromise; briefly retry only while the challenge
  // frame has not arrived yet.
  let authenticated = false;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await relay.auth(relay.onauth);
      authenticated = true;
      break;
    } catch (error) {
      if (!String(error).includes("no challenge was received")) return first.events;
      await delay(25 * (attempt + 1));
    }
  }
  if (!authenticated) return first.events;
  return (await queryAttempt(relay, filter, perRelayMs)).events;
}

/**
 * Query many relays in parallel and merge results by event id (dedup). One
 * slow/dead relay can't stall the merge — each relay gets its own timeout
 * (inherited from the sampler's posture). Empty/failed relays contribute
 * nothing. This is the read-side equivalent of publishToMany: the local
 * sidecar and external relays are treated as a federated set.
 */
export async function queryMany(relays: Relay[], filter: Filter, perRelayMs = 4000): Promise<Event[]> {
  const local = pendingLocalEventsMatching(filter);
  if (relays.length === 0) return local;
  // Each relay gets its own perRelayMs timeout inside queryOnce, and the
  // subscription is always closed (on EOSE or on timeout) so no sub leaks onto
  // the session-cached WebSocket. Timeouts/failures are best-effort: a down
  // relay contributes nothing. Single-relay (desktop default = home sidecar)
  // MUST share this posture — previously it rethrew the timeout, which
  // surfaced as Unhandled Promise Rejection from auto-beginReplay on folder
  // load when the sidecar was slow/unreachable.
  const byId = new Map<string, Event>(local.map((event) => [event.id, event]));
  await Promise.all(
    relays.map(async (relay) => {
      try {
        const events = await queryOnce(relay, filter, perRelayMs);
        for (const e of events) byId.set(e.id, e);
      } catch {
        // best-effort: a down relay just contributes no events
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
        const events = await queryOnce(relay, filter, perRelayMs);
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
 *  - 4290 FileTraceNode — `snapshot` is authoritative.
 *  - 4291 TraceName — the name chain carries a `name` field; rendered as a
 *    heading so the body reads as the trace's current name.
 *  - folder-reified 4290 node — `snapshot.members` rendered as an unordered list.
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
  const reification = event.tags.find((tag) => tag[0] === "z")?.[1];
  if (event.kind === TRACE_NODE_KIND && reification === "folder") {
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
    case TRACE_NODE_KIND: {
      if (reification !== "file") return "";
      const parsed = safeParse(event.content);
      if (isObject(parsed) && typeof parsed.snapshot === "string") return parsed.snapshot;
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
 *  `fetchLatestFolderNode` does for a single known folder. Queries kind 4290
 *  and post-filters to folder-discriminated nodes (`z:folder`). Returns [] for
 *  a blank name or no matches. */
export async function resolveTagCandidates(name: string, urls: string[]): Promise<TagCandidate[]> {
  const trimmed = name.trim();
  if (!trimmed) return [];
  const current = await sampleRelays(urls, { kinds: [TRACE_NODE_KIND], "#f": [trimmed] });
  // Merge by event id; post-filter to folder-discriminated nodes.
  const byId = new Map<string, Event>();
  for (const hit of current.hits) {
    if (hit.event.tags.some((t) => t[0] === "z" && t[1] === "folder")) byId.set(hit.event.id, hit.event);
  }
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

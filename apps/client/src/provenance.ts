import { finalizeEvent } from "nostr-tools/pure";
import type { Event, EventTemplate } from "nostr-tools";
import type { Filter } from "nostr-tools";
import type { Relay } from "nostr-tools/relay";

import { loadOrCreateVoice, connectRelay } from "./identity.js";

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
const FOLDER_MANIFEST_KIND = 34290;

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

export interface PublishEditInput {
  prevEventId: string | null;
  relativePath: string;
  folderId: string;
  deltas: EditorDelta[];
  snapshot: string;
  contentHash: string;
  action?: string;
  summary?: string | null;
}

let relayPromise: Promise<Relay> | null = null;

/** Lazily connects to the sidecar relay (shared across all publishes). */
function getRelay(): Promise<Relay> {
  if (!relayPromise) relayPromise = connectRelay();
  return relayPromise;
}

/** Builds, signs, and publishes a kind-4290 FileTraceNode. Returns the signed
 *  event (its `id` is the new node id the caller should track as prevEventId). */
export async function publishEdit(input: PublishEditInput): Promise<Event> {
  const relay = await getRelay();
  const voice = loadOrCreateVoice();
  const sealedAt = Date.now();

  const tags: string[][] = [
    ["file", input.relativePath],
    ["folder", input.folderId],
    ["F", input.relativePath],
    ["D", input.folderId],
    ["action", input.action ?? "edit"],
  ];
  if (input.prevEventId) tags.push(["e", input.prevEventId, "", "prev"]);

  const template: EventTemplate = {
    kind: FILE_TRACE_NODE_KIND,
    created_at: Math.floor(sealedAt / 1000),
    tags,
    content: JSON.stringify({
      sealedAt,
      // Spec-compliant: no `oldValue` (recoverable from prev.snapshot).
      deltas: input.deltas.map((d) => ({
        type: d.type,
        position: { start: d.positionStart, end: d.positionEnd },
        newValue: d.newValue,
        timestamp: d.timestamp,
      })),
      snapshot: input.snapshot,
      contentHash: input.contentHash,
      ...(input.summary ? { summary: input.summary } : {}),
    }),
  };

  const signed = finalizeEvent(template, voice.secretKey);
  await relay.publish(signed);
  return signed;
}

/** Fetches the full prev-chain for a file, ordered genesis→latest. Mirrors
 *  store.ts:fetchChain — never trusts created_at; walks `e...prev` links. */
export async function fetchChain(folderId: string, relativePath: string): Promise<Event[]> {
  const relay = await getRelay();
  const filter: Filter = {
    kinds: [FILE_TRACE_NODE_KIND],
    "#F": [relativePath],
    "#D": [folderId],
  };
  const all = await queryOnce(relay, filter);
  const byId = new Map(all.map((e) => [e.id, e]));

  // Find the latest: a node nobody else cites as prev. With no manifest yet,
  // that's the head. (Manifest wiring is a later step.)
  const citedAsPrev = new Set<string>();
  for (const e of all) {
    const prevTag = e.tags.find((t) => t[0] === "e" && t[3] === "prev");
    if (prevTag) citedAsPrev.add(prevTag[1]);
  }
  const heads = all.filter((e) => !citedAsPrev.has(e.id));
  if (heads.length === 0) return [];

  const chain: Event[] = [];
  let cursor: string | undefined = heads[0].id;
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

export { FILE_TRACE_NODE_KIND, FOLDER_MANIFEST_KIND };

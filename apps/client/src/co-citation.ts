/**
 * Mutual-peer co-citation detector (protocol/rendezvous.md §4).
 *
 * The v1 rendezvous mechanism: client-side set intersection over chains the
 * introducer is already authorized to read. For each pair of peers (A, B) that
 * you — the introducer C — mutually trust, compute the intersection of their
 * Q-tag sets (rendezvous coordinates H). If they share any, surface an
 * introduction: "A and B both quoted the same passage(s) — introduce?"
 *
 * This is trust-bounded by construction: C sees the coincidence only because C
 * is the one node already authorized to read both chains. C brokers the
 * introduction (surfaces it to a human, who nods) but does NOT write to either
 * peers.json — each of A and B opts to add the other. That is how real
 * introductions work, and the only shape that respects "peers.json is a private
 * local ACL, never a published event" (transport.md §2).
 *
 * No DHT required — this works the moment two peers share a mutual, before any
 * DHT density exists. The DHT (rendezvous.md §2) is the global path for
 * non-mutual discovery; co-citation is the trust-bounded v1.
 *
 * Two layers, split for testability (following the provenance.inbound.test.ts
 * convention — pure logic is unit-tested, relay fetches are excluded):
 *   - `intersectQHashes` (pure): given two peers' event sets, compute shared H.
 *   - `detectCoCitations` (relay-bound): enumerate peers, fetch each one's
 *     recent events from relays C already reads, feed to the pure layer.
 */

import type { Event } from "nostr-tools";

import { eventMeta, queryMany, getReadRelays } from "./provenance.js";

/** A co-citation match between two peers on one or more shared quotes.
 *  `hashes` are the shared H values; `samples` carries up to 2 verbatim quote
 *  bytes per H (one per peer, when available) so the human vetting the intro
 *  can read what they actually share without re-fetching. */
export interface CoCitation {
  peerA: string;
  peerB: string;
  hashes: string[];
  samples: { hash: string; quoteA?: string; quoteB?: string }[];
}

/** Extract the set of Q-tag hashes (rendezvous coordinates) from a set of
 *  events — the union of every `contentCiteHashes` across every event. Pure,
 *  no IO. This is H_X in the rendezvous.md §4.1 algorithm. */
export function qHashSet(events: Event[]): Set<string> {
  const hashes = new Set<string>();
  for (const ev of events) {
    for (const h of eventMeta(ev).contentCiteHashes) {
      hashes.add(h);
    }
  }
  return hashes;
}

/** Extract a hash → quote-bytes map from a set of events, by reading the
 *  `role: "content"` cite deltas (rendezvous.md §1.1: the delta carries the
 *  verbatim `quote` field). Pure. Used to populate `samples` so the
 *  introducer can show what the shared passage actually says. */
export function quoteBytesByHash(events: Event[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const ev of events) {
    try {
      const parsed = JSON.parse(ev.content) as { deltas?: unknown[] };
      if (!Array.isArray(parsed.deltas)) continue;
      for (const d of parsed.deltas) {
        if (
          d &&
          typeof d === "object" &&
          (d as { type?: string }).type === "cite" &&
          (d as { role?: string }).role === "content"
        ) {
          const c = d as { hash?: string; quote?: string };
          if (typeof c.hash === "string" && typeof c.quote === "string" && !out.has(c.hash)) {
            out.set(c.hash, c.quote);
          }
        }
      }
    } catch {
      // malformed/non-JSON content — skip this event
    }
  }
  return out;
}

/** Compute the co-citation intersections across a set of peers, given each
 *  peer's fetched events. Pure — no IO, fully unit-testable. This is the core
 *  of the rendezvous.md §4.1 algorithm: for each pair (A, B), intersect H_A
 *  and H_B; if non-empty, emit a CoCitation.
 *
 *  O(P² × E) where P = peer count, E = avg events per peer. Fine for the small
 *  peer graphs this system is designed for (peers.json is a hand-curated ACL,
 *  not a social graph — tens of peers, not thousands). */
export function intersectQHashes(
  eventsByPeer: Map<string, Event[]>,
): CoCitation[] {
  // Pre-compute each peer's hash set + quote map once (not per-pair).
  const hashSets = new Map<string, Set<string>>();
  const quoteMaps = new Map<string, Map<string, string>>();
  for (const [peer, events] of eventsByPeer) {
    hashSets.set(peer, qHashSet(events));
    quoteMaps.set(peer, quoteBytesByHash(events));
  }

  const peers = [...eventsByPeer.keys()];
  const results: CoCitation[] = [];
  for (let i = 0; i < peers.length; i++) {
    for (let j = i + 1; j < peers.length; j++) {
      const a = peers[i];
      const b = peers[j];
      const hA = hashSets.get(a)!;
      const hB = hashSets.get(b)!;
      const shared: string[] = [];
      // Iterate the smaller set for efficiency.
      const [smaller, larger] = hA.size <= hB.size ? [hA, hB] : [hB, hA];
      for (const h of smaller) {
        if (larger.has(h)) shared.push(h);
      }
      if (shared.length === 0) continue;
      const qA = quoteMaps.get(a)!;
      const qB = quoteMaps.get(b)!;
      results.push({
        peerA: a,
        peerB: b,
        hashes: shared,
        samples: shared.map((h) => ({
          hash: h,
          quoteA: qA.get(h),
          quoteB: qB.get(h),
        })),
      });
    }
  }
  return results;
}

/** Fetch each peer's recent file-trace nodes from the relays the introducer
 *  already reads (getReadRelays). Relay-bound — excluded from unit tests by the
 *  codebase convention (see provenance.inbound.test.ts header).
 *
 *  The precondition (rendezvous.md §4): a peer's chain is readable only if
 *  replicated to a relay C already reads. We do NOT open per-peer connections
 *  to their derived .onion — that path doesn't exist yet. This is the honest v1
 *  boundary: co-citation works among peers who share a common seed/super-peer
 *  with C, which is the common case for a trust-bounded introduction graph.
 *
 *  `limit` bounds the per-peer fetch (default 100 recent nodes) so a prolific
 *  peer doesn't dominate the sweep. Returns a Map keyed by pubkey. */
export async function fetchPeerEvents(
  pubkeys: string[],
  limit = 100,
): Promise<Map<string, Event[]>> {
  const relays = await getReadRelays();
  if (relays.length === 0 || pubkeys.length === 0) return new Map();

  const out = new Map<string, Event[]>();
  // Fetch each peer's events in parallel — they're independent.
  await Promise.all(
    pubkeys.map(async (pk) => {
      try {
        const events = await queryMany(relays, {
          kinds: [4290],
          authors: [pk],
          limit,
        });
        out.set(pk, events);
      } catch {
        // A failed fetch for one peer shouldn't abort the others.
        out.set(pk, []);
      }
    }),
  );
  return out;
}

/** The full detection sweep: fetch each peer's recent events, compute
 *  intersections, return co-citation matches sorted by shared-hash count
 *  (most overlap first — the strongest signal for a human vetting intros). */
export async function detectCoCitations(
  pubkeys: string[],
  limit = 100,
): Promise<CoCitation[]> {
  const eventsByPeer = await fetchPeerEvents(pubkeys, limit);
  const matches = intersectQHashes(eventsByPeer);
  // Sort by number of shared hashes descending — rare/strong matches first.
  return matches.sort((a, b) => b.hashes.length - a.hashes.length);
}

/**
 * Mutual-peer co-citation detector (protocol/rendezvous.md §4).
 *
 * The v1 rendezvous mechanism: client-side set intersection over chains the
 * introducer is already authorized to read. For each pair of peers (A, B) that
 * you — the introducer C — mutually trust, compute the intersection of their
 * ordinary `q` citation targets. If they share any, surface an introduction:
 * "A and B both cited the same trace(s) — introduce?"
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
 *   - `intersectCitationTargets` (pure): compute shared cited trace ids.
 *   - `detectCoCitations` (relay-bound): enumerate peers, fetch each one's
 *     recent events from relays C already reads, feed to the pure layer.
 */

import type { Event } from "nostr-tools";

import { eventMeta, fetchEventById, queryMany, getReadRelays } from "./provenance.js";

/** A co-citation match between two peers on one or more shared trace targets. */
export interface CoCitation {
  peerA: string;
  peerB: string;
  targetIds: string[];
  samples: { nodeId: string; text?: string }[];
}

/** Extract ordinary trace-citation targets from current heads only. Reverse
 * relay scans return historical nodes too; unioning every q edge would keep a
 * removed citation socially active forever. Within the fetched peer window, a
 * node is historical whenever another fetched node names it as `prev`.
 * `action:delete` heads emit no active signal. Folder membership and LLM scope
 * q-tags remain structural/context edges, not social citations. */
export function citationTargetSet(events: Event[]): Set<string> {
  const targets = new Set<string>();
  const historicalIds = new Set<string>();
  for (const event of events) {
    const prev = event.tags.find((tag) => tag[0] === "e" && tag[3] === "prev")?.[1];
    if (prev) historicalIds.add(prev);
  }
  for (const ev of events) {
    if (historicalIds.has(ev.id)) continue;
    if (!ev.tags.some((tag) => tag[0] === "z" && tag[1] === "file")) continue;
    if (ev.tags.some((tag) => tag[0] === "scope" && tag[1] === "llm")) continue;
    if (ev.tags.some((tag) => tag[0] === "action" && tag[1] === "delete")) continue;
    for (const nodeId of eventMeta(ev).citationTargets) targets.add(nodeId);
  }
  return targets;
}

/** Compute the co-citation intersections across a set of peers, given each
 *  peer's fetched events. Pure — no IO, fully unit-testable. This is the core
 *  of the rendezvous.md §4.1 algorithm: for each pair (A, B), intersect their
 *  ordinary q-tag targets; if non-empty, emit a CoCitation.
 *
 *  O(P² × E) where P = peer count, E = avg events per peer. Fine for the small
 *  peer graphs this system is designed for (peers.json is a hand-curated ACL,
 *  not a social graph — tens of peers, not thousands). */
export function intersectCitationTargets(
  eventsByPeer: Map<string, Event[]>,
): CoCitation[] {
  const targetSets = new Map<string, Set<string>>();
  for (const [peer, events] of eventsByPeer) {
    targetSets.set(peer, citationTargetSet(events));
  }

  const peers = [...eventsByPeer.keys()];
  const results: CoCitation[] = [];
  for (let i = 0; i < peers.length; i++) {
    for (let j = i + 1; j < peers.length; j++) {
      const a = peers[i];
      const b = peers[j];
      const targetsA = targetSets.get(a)!;
      const targetsB = targetSets.get(b)!;
      const shared: string[] = [];
      // Iterate the smaller set for efficiency.
      const [smaller, larger] =
        targetsA.size <= targetsB.size ? [targetsA, targetsB] : [targetsB, targetsA];
      for (const nodeId of smaller) {
        if (larger.has(nodeId)) shared.push(nodeId);
      }
      if (shared.length === 0) continue;
      results.push({
        peerA: a,
        peerB: b,
        targetIds: shared,
        samples: shared.map((nodeId) => ({ nodeId })),
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
 *  intersections, return co-citation matches sorted by shared-target count
 *  (most overlap first — the strongest signal for a human vetting intros). */
export async function detectCoCitations(
  pubkeys: string[],
  limit = 100,
): Promise<CoCitation[]> {
  const eventsByPeer = await fetchPeerEvents(pubkeys, limit);
  const matches = intersectCitationTargets(eventsByPeer);
  const targetIds = [...new Set(matches.flatMap((match) => match.targetIds))];
  const textByTarget = new Map<string, string>();
  await Promise.all(targetIds.map(async (nodeId) => {
    const event = await fetchEventById(nodeId).catch(() => null);
    if (!event) return;
    try {
      const parsed = JSON.parse(event.content) as { snapshot?: unknown };
      if (typeof parsed.snapshot === "string") textByTarget.set(nodeId, parsed.snapshot);
    } catch {
      // A shared target remains useful even if its preview cannot be decoded.
    }
  }));
  for (const match of matches) {
    match.samples = match.targetIds.map((nodeId) => ({ nodeId, text: textByTarget.get(nodeId) }));
  }
  return matches.sort((a, b) => b.targetIds.length - a.targetIds.length);
}

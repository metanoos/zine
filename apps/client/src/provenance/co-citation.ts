/**
 * Mutual-peer co-citation detector (protocol/rendezvous.md §4).
 *
 * The v1 rendezvous mechanism: client-side set intersection over chains the
 * introducer is already authorized to read. For each pair of peers (A, B) that
 * you — the introducer C — mutually trust, compute the intersection of their
 * ordinary `q` citation targets, then retain only targets that verify as
 * completed Coins. If they share any, surface an introduction: "A and B both
 * cited the same Coin(s) — introduce?"
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
 * Three layers, split for testability (following the provenance.inbound.test.ts
 * convention — pure logic is unit-tested, relay fetches are excluded):
 *   - `intersectCitationTargets` (pure): compute shared cited trace ids.
 *   - `retainCompletedCoinCoCitations`: enforce the Coin/minter-attestation
 *     admission boundary.
 *   - `detectCoCitations` (relay-bound): enumerate peers, fetch each one's
 *     current events and Coin proofs from relays C already reads, then feed
 *     both pure layers.
 */

import type { Event, Filter } from "nostr-tools";
import { verifyEvent } from "nostr-tools/pure";

import {
  createBoundedRelaySampleCollector,
  queryMany,
  getReadRelays,
  resolveTraceChainCandidates,
  socialCitationTargets,
  type RelaySampleBounds,
} from "./provenance.js";
import {
  isValidMinterAttestation,
  verifiedCoinCoordinate,
  verifiedCoinGenesisCoordinate,
} from "./rendezvous.js";

const HEX_64 = /^[0-9a-f]{64}$/;
const MAX_COCITATION_PEERS = 64;
const MAX_EVENTS_PER_PEER = 100;
const MAX_TARGETS_PER_EVENT = 128;
const MAX_TARGETS_PER_PEER = 512;
const MAX_TARGETS_PER_SWEEP = 1_024;
const MAX_CONCURRENT_PEER_FETCHES = 4;
const MAX_CONCURRENT_TARGET_FETCHES = 8;
const TRACE_HEAD_KIND = 34290;
const MAX_HEAD_CANDIDATES_PER_TRACE = 8;
const MAX_PEER_EVENT_BYTES = 2 * 1024 * 1024;
const MAX_PEER_SAMPLE_BYTES = 16 * 1024 * 1024;
const MAX_PEER_EVENT_CONTENT = 2 * 1024 * 1024;
const MAX_PEER_EVENT_TAGS = 4_096;
const MAX_PEER_TAG_VALUES = 32;
const MAX_PEER_TAG_VALUE_LENGTH = 16_384;
const MAX_ATTESTATIONS_PER_TARGET = 128;
const MAX_COCITATION_SWEEP_BYTES = 64 * 1024 * 1024;
const MAX_COCITATION_SWEEP_MS = 20_000;
const MAX_ATTESTATION_EVENT_BYTES = 64 * 1024;
const MAX_ATTESTATION_CONTENT = 16 * 1024;
const MAX_ATTESTATION_SAMPLE_BYTES = 2 * 1024 * 1024;

function eventVerifies(event: Event): boolean {
  try {
    return verifyEvent(event);
  } catch {
    return false;
  }
}

function coCitationBounds(
  maxUniqueEvents: number,
  maxTotalBytes: number,
  signal?: AbortSignal,
) {
  return {
    maxUniqueEvents,
    maxTotalBytes,
    maxEventBytes: MAX_PEER_EVENT_BYTES,
    maxContentLength: MAX_PEER_EVENT_CONTENT,
    maxTags: MAX_PEER_EVENT_TAGS,
    maxTagValues: MAX_PEER_TAG_VALUES,
    maxTagValueLength: MAX_PEER_TAG_VALUE_LENGTH,
    signal,
  };
}

function coCitationAttestationBounds(signal?: AbortSignal) {
  return {
    ...coCitationBounds(MAX_ATTESTATIONS_PER_TARGET, MAX_ATTESTATION_SAMPLE_BYTES, signal),
    maxEventBytes: MAX_ATTESTATION_EVENT_BYTES,
    maxContentLength: MAX_ATTESTATION_CONTENT,
  };
}

export interface CoCitationSweepBudget {
  readonly signal: AbortSignal;
  consume(events: readonly Event[]): void;
  assertActive(): void;
  dispose(): void;
}

const coCitationEncoder = new TextEncoder();

/** One byte/deadline budget shared by peer reads, target reads, and
 * attestations. Per-query bounds cap transient allocations; this cap prevents
 * a sweep from retaining or processing their Cartesian sum. */
export function createCoCitationSweepBudget(
  parent?: AbortSignal,
  options: { maxBytes?: number; deadlineMs?: number } = {},
): CoCitationSweepBudget {
  const controller = new AbortController();
  const maxBytes = options.maxBytes ?? MAX_COCITATION_SWEEP_BYTES;
  const deadlineMs = options.deadlineMs ?? MAX_COCITATION_SWEEP_MS;
  let totalBytes = 0;
  const abortFromParent = () => controller.abort(parent?.reason);
  if (parent?.aborted) abortFromParent();
  else parent?.addEventListener("abort", abortFromParent, { once: true });
  const timer = setTimeout(() => {
    controller.abort(new Error(`co-citation sweep timed out after ${deadlineMs}ms`));
  }, deadlineMs);
  const assertActive = () => {
    if (!controller.signal.aborted) return;
    if (controller.signal.reason instanceof Error) throw controller.signal.reason;
    const error = new Error("co-citation sweep aborted");
    error.name = "AbortError";
    throw error;
  };
  return {
    signal: controller.signal,
    consume(events) {
      assertActive();
      for (const event of events) {
        totalBytes += coCitationEncoder.encode(JSON.stringify(event)).byteLength;
        if (totalBytes > maxBytes) {
          const error = new Error(`co-citation sweep exceeded its ${maxBytes}-byte budget`);
          controller.abort(error);
          throw error;
        }
      }
    },
    assertActive,
    dispose() {
      clearTimeout(timer);
      parent?.removeEventListener("abort", abortFromParent);
    },
  };
}

function createLimiter(concurrency: number): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0;
  const queue: (() => void)[] = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active >= concurrency) await new Promise<void>((resolve) => queue.push(resolve));
    active++;
    try {
      return await task();
    } finally {
      active--;
      queue.shift()?.();
    }
  };
}

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
  const boundedEvents = createBoundedRelaySampleCollector(
    coCitationBounds(MAX_EVENTS_PER_PEER, MAX_PEER_SAMPLE_BYTES),
  );
  for (const event of events.slice(0, MAX_EVENTS_PER_PEER)) boundedEvents.accept(event);
  const acceptedEvents = boundedEvents.events();
  for (const event of acceptedEvents) {
    const prev = event.tags.find((tag) => tag[0] === "e" && tag[3] === "prev")?.[1];
    if (prev && HEX_64.test(prev)) historicalIds.add(prev);
  }
  for (const ev of acceptedEvents) {
    if (historicalIds.has(ev.id)) continue;
    if (!ev.tags.some((tag) => tag[0] === "z" && tag[1] === "file")) continue;
    if (ev.tags.some((tag) => tag[0] === "action" && tag[1] === "delete")) continue;
    let eventTargets = 0;
    for (const nodeId of socialCitationTargets(ev)) {
      if (!HEX_64.test(nodeId)) continue;
      targets.add(nodeId);
      eventTargets++;
      if (eventTargets >= MAX_TARGETS_PER_EVENT || targets.size >= MAX_TARGETS_PER_PEER) break;
    }
    if (targets.size >= MAX_TARGETS_PER_PEER) break;
  }
  return targets;
}

/** Compute raw co-citation intersections across a set of peers, given each
 *  peer's fetched events. Pure — no IO, fully unit-testable. This is the first
 *  stage of the rendezvous.md §4.1 algorithm: for each pair (A, B), intersect
 *  ordinary q-tag targets. The completed-Coin gate below decides whether any
 *  raw intersection may become a returned CoCitation.
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

/** Admit raw exact-target intersections only when the target is a signed Coin
 * genesis completed by a valid same-minter TraceAttestation. This boundary is
 * shared by the relay sweep and pure regression tests so an ordinary q target
 * can never become a mutual-peer introduction. */
export async function retainCompletedCoinCoCitations(
  matches: readonly CoCitation[],
  targets: ReadonlyMap<string, Event>,
  attestations: ReadonlyMap<string, readonly Event[]>,
): Promise<CoCitation[]> {
  const completed = new Set<string>();
  const runLimited = createLimiter(MAX_CONCURRENT_TARGET_FETCHES);
  const targetIds = [...new Set(matches.flatMap((match) => match.targetIds))]
    .filter((targetId) => HEX_64.test(targetId))
    .slice(0, MAX_TARGETS_PER_SWEEP);
  await Promise.all(targetIds.map(
    (targetId) => runLimited(async () => {
      const target = targets.get(targetId);
      if (!target) return;
      if (await verifiedCoinCoordinate(target, attestations.get(targetId) ?? [])) {
        completed.add(targetId);
      }
    }),
  ));
  return matches.flatMap((match) => {
    const targetIds = match.targetIds.filter((targetId) => completed.has(targetId));
    return targetIds.length > 0
      ? [{ ...match, targetIds, samples: targetIds.map((nodeId) => ({ nodeId })) }]
      : [];
  });
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
  sweep?: CoCitationSweepBudget,
  queryOverride?: (filter: Filter, bounds: RelaySampleBounds) => Promise<Event[]>,
): Promise<Map<string, Event[]>> {
  sweep?.assertActive();
  const relays = queryOverride ? [] : await getReadRelays();
  const peers = [...new Set(pubkeys.filter((pubkey) => HEX_64.test(pubkey)))]
    .slice(0, MAX_COCITATION_PEERS);
  if ((!queryOverride && relays.length === 0) || peers.length === 0) return new Map();
  const requestedLimit = Number.isFinite(limit) ? Math.floor(limit) : MAX_EVENTS_PER_PEER;
  const boundedLimit = Math.max(1, Math.min(requestedLimit, MAX_EVENTS_PER_PEER));
  const query = queryOverride ?? ((filter: Filter, bounds: RelaySampleBounds) =>
    queryMany(relays, filter, 4_000, bounds));

  const parseTraceHead = (event: Event, expectedAuthor?: string) => {
    if (
      event.kind !== TRACE_HEAD_KIND ||
      (expectedAuthor !== undefined && event.pubkey !== expectedAuthor) ||
      !eventVerifies(event)
    ) return null;
    const dTags = event.tags.filter((tag) => tag[0] === "d");
    if (
      dTags.length !== 1 ||
      !HEX_64.test(dTags[0]?.[1] ?? "") ||
      event.tags.some((tag) => tag[0] !== "d")
    ) return null;
    try {
      const content = JSON.parse(event.content) as unknown;
      if (!content || typeof content !== "object" || Array.isArray(content)) return null;
      const record = content as Record<string, unknown>;
      if (
        Object.keys(record).length !== 1 ||
        typeof record.head !== "string" ||
        !HEX_64.test(record.head)
      ) return null;
      return { traceId: dTags[0]![1]!, headId: record.head };
    } catch {
      return null;
    }
  };

  const out = new Map<string, Event[]>();
  const runLimited = createLimiter(MAX_CONCURRENT_PEER_FETCHES);
  await Promise.all(
    peers.map((pk) => runLimited(async () => {
      try {
        sweep?.assertActive();
        // A bounded reverse node scan cannot prove currentness: a successor
        // can fall outside the window or share its second-resolution time.
        // Start from this peer's signed TraceHead identities, then reconcile
        // every valid head candidate through its verified prev-chain.
        const peerHeadEvents = await query({
          kinds: [TRACE_HEAD_KIND],
          authors: [pk],
          limit: boundedLimit,
        }, coCitationBounds(
          boundedLimit,
          MAX_PEER_SAMPLE_BYTES,
          sweep?.signal,
        ));
        sweep?.assertActive();
        sweep?.consume(peerHeadEvents);
        const traceIds = [...new Set(peerHeadEvents.flatMap((event) => {
          const parsed = parseTraceHead(event, pk);
          return parsed ? [parsed.traceId] : [];
        }))].slice(0, boundedLimit);
        if (traceIds.length === 0) {
          out.set(pk, []);
          return;
        }

        const candidatesByTrace = new Map<string, string[]>();
        const admittedTraceIds = new Set(traceIds);
        const admitHeadCandidate = (event: Event) => {
          const parsed = parseTraceHead(event, pk);
          if (!parsed || !admittedTraceIds.has(parsed.traceId)) return;
          const candidates = candidatesByTrace.get(parsed.traceId) ?? [];
          if (
            candidates.length < MAX_HEAD_CANDIDATES_PER_TRACE &&
            !candidates.includes(parsed.headId)
          ) candidates.push(parsed.headId);
          candidatesByTrace.set(parsed.traceId, candidates);
        };
        // Preserve the authenticated discovery result even if the broader
        // replaceable-event query is truncated or a relay ignores its author
        // filter. TraceHead identity is (author, d), never d alone.
        for (const event of peerHeadEvents) admitHeadCandidate(event);

        const candidateLimit = traceIds.length * MAX_HEAD_CANDIDATES_PER_TRACE;
        const allHeadEvents = await query({
          kinds: [TRACE_HEAD_KIND],
          authors: [pk],
          "#d": traceIds,
          limit: candidateLimit,
        }, coCitationBounds(
          candidateLimit,
          MAX_PEER_SAMPLE_BYTES,
          sweep?.signal,
        ));
        sweep?.assertActive();
        sweep?.consume(allHeadEvents);
        for (const event of allHeadEvents) admitHeadCandidate(event);

        const loadEvents = async (ids: readonly string[]) => {
          sweep?.assertActive();
          const requestedIds = [...new Set(ids.filter((id) => HEX_64.test(id)))];
          if (requestedIds.length === 0) return [];
          const events = await query({
            kinds: [4290],
            ids: requestedIds,
            limit: requestedIds.length,
          }, {
            ...coCitationBounds(
              requestedIds.length,
              MAX_PEER_SAMPLE_BYTES,
              sweep?.signal,
            ),
            requestedIds,
          });
          sweep?.assertActive();
          sweep?.consume(events);
          return events.filter((event) =>
            requestedIds.includes(event.id) &&
            event.kind === 4290 &&
            event.tags.some((tag) => tag[0] === "z" && tag[1] === "file") &&
            eventVerifies(event)
          );
        };

        const current: Event[] = [];
        const resolveLimited = createLimiter(MAX_CONCURRENT_PEER_FETCHES);
        await Promise.all(traceIds.map((traceId) => resolveLimited(async () => {
          sweep?.assertActive();
          const resolved = await resolveTraceChainCandidates(
            traceId,
            candidatesByTrace.get(traceId) ?? [],
            loadEvents,
          );
          sweep?.assertActive();
          if (resolved.status !== "resolved") return;
          const head = resolved.chain[resolved.chain.length - 1];
          if (head?.pubkey === pk) current.push(head);
        })));
        out.set(pk, current.slice(0, boundedLimit));
      } catch (error) {
        if (sweep?.signal.aborted) throw error;
        // A failed fetch for one peer shouldn't abort the others.
        out.set(pk, []);
      }
    })),
  );
  return out;
}

/** The full detection sweep: fetch each peer's recent events, compute
 *  intersections, return co-citation matches sorted by shared-target count
 *  (most overlap first — the strongest signal for a human vetting intros). */
export async function detectCoCitations(
  pubkeys: string[],
  limit = 100,
  signal?: AbortSignal,
): Promise<CoCitation[]> {
  const sweep = createCoCitationSweepBudget(signal);
  try {
    const eventsByPeer = await fetchPeerEvents(pubkeys, limit, sweep);
    sweep.assertActive();
    const candidates = intersectCitationTargets(eventsByPeer);
    const targetIds = [...new Set(candidates.flatMap((match) => match.targetIds))]
      .slice(0, MAX_TARGETS_PER_SWEEP);
    const admittedTargets = new Set(targetIds);
    const boundedCandidates = candidates.flatMap((match) => {
      const retained = match.targetIds.filter((targetId) => admittedTargets.has(targetId));
      return retained.length > 0
        ? [{ ...match, targetIds: retained, samples: retained.map((nodeId) => ({ nodeId })) }]
        : [];
    });
    const relays = await getReadRelays();
    const targetEvents = new Map<string, Event>();
    const attestations = new Map<string, Event[]>();
    const runLimited = createLimiter(MAX_CONCURRENT_TARGET_FETCHES);
    await Promise.all(targetIds.map((nodeId) => runLimited(async () => {
      sweep.assertActive();
      const targetBounds = {
        ...coCitationBounds(1, MAX_PEER_EVENT_BYTES, sweep.signal),
        requestedIds: [nodeId],
      };
      const [event] = await queryMany(
        relays,
        { ids: [nodeId], limit: 1 },
        4_000,
        targetBounds,
      ).catch(() => []);
      sweep.assertActive();
      if (!event || event.id !== nodeId) return;
      sweep.consume([event]);
      // Reject malformed, unsigned, non-Coin, or hash-inconsistent targets
      // before issuing the more expensive attestation query.
      if (!await verifiedCoinGenesisCoordinate(event)) return;
      sweep.assertActive();
      const events = await queryMany(relays, {
        kinds: [4294],
        authors: [event.pubkey],
        "#e": [nodeId],
        limit: MAX_ATTESTATIONS_PER_TARGET,
      }, 4_000, coCitationAttestationBounds(sweep.signal)).catch(() => []);
      sweep.assertActive();
      const sampled = events.slice(0, MAX_ATTESTATIONS_PER_TARGET);
      sweep.consume(sampled);
      const completion = sampled.find((candidate) =>
        isValidMinterAttestation(event, candidate)
      );
      if (!completion) return;
      // Retain only fully verified, completed Coins and the single proof needed
      // downstream; rejected samples become collectible at the end of this task.
      targetEvents.set(nodeId, event);
      attestations.set(nodeId, [completion]);
    })));
    sweep.assertActive();
    const matches = await retainCompletedCoinCoCitations(
      boundedCandidates,
      targetEvents,
      attestations,
    );
    sweep.assertActive();
    const textByTarget = new Map<string, string>();
    for (const nodeId of new Set(matches.flatMap((match) => match.targetIds))) {
      const event = targetEvents.get(nodeId);
      if (!event) continue;
      try {
        const parsed = JSON.parse(event.content) as { snapshot?: unknown };
        if (typeof parsed.snapshot === "string") textByTarget.set(nodeId, parsed.snapshot);
      } catch {
        // A shared target remains useful even if its preview cannot be decoded.
      }
    }
    for (const match of matches) {
      match.samples = match.targetIds.map((nodeId) => ({ nodeId, text: textByTarget.get(nodeId) }));
    }
    return matches.sort((a, b) => b.targetIds.length - a.targetIds.length);
  } finally {
    sweep.dispose();
  }
}

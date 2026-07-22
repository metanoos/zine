/**
 * Mutual-peer co-Mint detector (protocol/rendezvous.md §4).
 *
 * The introducer reads bounded recent events signed by each peer, admits only
 * immutable Coin geneses completed by a valid same-minter TraceAttestation,
 * derives H from each verified Coin body, and intersects H across peers. Two
 * independently minted Coin ids can therefore match. Ordinary q citations are
 * separate usage evidence and never enter this membership set.
 */

import type { Event, Filter } from "nostr-tools";
import { verifyEvent } from "nostr-tools/pure";

import {
  coinOriginFromEvent,
  getReadRelays,
  queryMany,
  type RelaySampleBounds,
} from "./provenance.js";
import {
  isValidMinterAttestation,
  validTraceAttestationTargetId,
  verifiedCoinCoordinate,
  verifiedCoinGenesisCoordinate,
  verifiedExtractedCoinSourceEvidence,
} from "./rendezvous.js";

const HEX_64 = /^[0-9a-f]{64}$/;
const TRACE_NODE_KIND = 4290;
const TRACE_ATTESTATION_KIND = 4294;
const MAX_COMINT_PEERS = 64;
const MAX_EVENTS_PER_PEER = 100;
const MAX_COINS_PER_PEER = 32;
const MAX_COINS_PER_SWEEP = 1_024;
const MAX_CONCURRENT_PEER_FETCHES = 4;
const MAX_ATTESTATIONS_PER_PEER = 128;
const MAX_ATTESTATIONS_PER_COIN = 4;
const MAX_RELAY_BATCH_IDS = 128;
const MAX_PEER_EVENT_BYTES = 2 * 1024 * 1024;
const MAX_PEER_SAMPLE_BYTES = 16 * 1024 * 1024;
const MAX_PEER_EVENT_CONTENT = 2 * 1024 * 1024;
const MAX_PEER_EVENT_TAGS = 4_096;
const MAX_PEER_TAG_VALUES = 32;
const MAX_PEER_TAG_VALUE_LENGTH = 16_384;
const MAX_COMINT_SWEEP_BYTES = 64 * 1024 * 1024;
const MAX_COMINT_SWEEP_MS = 20_000;
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

function coMintBounds(
  maxUniqueEvents: number,
  maxTotalBytes: number,
  signal?: AbortSignal,
): RelaySampleBounds {
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

function attestationBounds(maxUniqueEvents: number, signal?: AbortSignal): RelaySampleBounds {
  return {
    ...coMintBounds(maxUniqueEvents, MAX_ATTESTATION_SAMPLE_BYTES, signal),
    maxEventBytes: MAX_ATTESTATION_EVENT_BYTES,
    maxContentLength: MAX_ATTESTATION_CONTENT,
  };
}

export interface CoMintSweepBudget {
  readonly signal: AbortSignal;
  consume(events: readonly Event[]): void;
  assertActive(): void;
  dispose(): void;
}

const coMintEncoder = new TextEncoder();

/** One byte/deadline budget shared by peer, attestation, and optional source reads. */
export function createCoMintSweepBudget(
  parent?: AbortSignal,
  options: { maxBytes?: number; deadlineMs?: number } = {},
): CoMintSweepBudget {
  const controller = new AbortController();
  const maxBytes = options.maxBytes ?? MAX_COMINT_SWEEP_BYTES;
  const deadlineMs = options.deadlineMs ?? MAX_COMINT_SWEEP_MS;
  let totalBytes = 0;
  const abortFromParent = () => controller.abort(parent?.reason);
  if (parent?.aborted) abortFromParent();
  else parent?.addEventListener("abort", abortFromParent, { once: true });
  const timer = setTimeout(() => {
    controller.abort(new Error(`co-Mint sweep timed out after ${deadlineMs}ms`));
  }, deadlineMs);
  const assertActive = () => {
    if (!controller.signal.aborted) return;
    if (controller.signal.reason instanceof Error) throw controller.signal.reason;
    const error = new Error("co-Mint sweep aborted");
    error.name = "AbortError";
    throw error;
  };
  return {
    signal: controller.signal,
    consume(events) {
      assertActive();
      for (const event of events) {
        totalBytes += coMintEncoder.encode(JSON.stringify(event)).byteLength;
        if (totalBytes > maxBytes) {
          const error = new Error(`co-Mint sweep exceeded its ${maxBytes}-byte budget`);
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

function batches<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let offset = 0; offset < values.length; offset += size) {
    result.push(values.slice(offset, offset + size));
  }
  return result;
}

export interface CompletedPeerMint {
  coinNodeId: string;
  coordinate: string;
  text: string;
  originKind: "direct" | "extracted";
  sourceEvidenceVerified: boolean;
}

export interface CoMintMatch {
  peerA: string;
  peerB: string;
  coordinates: string[];
  samples: Array<CompletedPeerMint & { peer: string }>;
}

/** Pure cryptographic admission boundary for relay results. */
export async function completedMintsFromEvents(
  events: readonly Event[],
  attestations: ReadonlyMap<string, readonly Event[]>,
  sources: ReadonlyMap<string, Event> = new Map(),
): Promise<CompletedPeerMint[]> {
  const completed: CompletedPeerMint[] = [];
  for (const event of events.slice(0, MAX_COINS_PER_PEER)) {
    const coordinate = await verifiedCoinCoordinate(
      event,
      attestations.get(event.id) ?? [],
    );
    if (!coordinate) continue;
    const origin = coinOriginFromEvent(event);
    if (!origin) continue;
    let text: string;
    try {
      const content = JSON.parse(event.content) as { snapshot?: unknown };
      if (typeof content.snapshot !== "string") continue;
      text = content.snapshot;
    } catch {
      continue;
    }
    completed.push({
      coinNodeId: event.id,
      coordinate,
      text,
      originKind: origin.kind,
      sourceEvidenceVerified: origin.kind === "extracted" &&
        await verifiedExtractedCoinSourceEvidence(
          event,
          sources.get(origin.sourceNodeId),
        ),
    });
  }
  return completed;
}

/** Intersect completed-Mint H coordinates, not concrete Coin ids. */
export function intersectCompletedMintCoordinates(
  mintsByPeer: ReadonlyMap<string, readonly CompletedPeerMint[]>,
): CoMintMatch[] {
  const byPeer = new Map<string, Map<string, CompletedPeerMint>>();
  for (const [peer, mints] of mintsByPeer) {
    const byCoordinate = new Map<string, CompletedPeerMint>();
    for (const mint of mints) {
      if (!byCoordinate.has(mint.coordinate)) byCoordinate.set(mint.coordinate, mint);
    }
    byPeer.set(peer, byCoordinate);
  }

  const peers = [...byPeer.keys()];
  const matches: CoMintMatch[] = [];
  for (let i = 0; i < peers.length; i++) {
    for (let j = i + 1; j < peers.length; j++) {
      const peerA = peers[i]!;
      const peerB = peers[j]!;
      const a = byPeer.get(peerA)!;
      const b = byPeer.get(peerB)!;
      const [smaller, larger] = a.size <= b.size ? [a, b] : [b, a];
      const coordinates = [...smaller.keys()].filter((coordinate) => larger.has(coordinate)).sort();
      if (coordinates.length === 0) continue;
      matches.push({
        peerA,
        peerB,
        coordinates,
        samples: coordinates.flatMap((coordinate) => [
          { ...a.get(coordinate)!, peer: peerA },
          { ...b.get(coordinate)!, peer: peerB },
        ]),
      });
    }
  }
  return matches;
}

/** Fetch bounded recent verified Coin geneses for each peer. Completion
 * attestations identify exact candidate ids first, so unrelated kind-4290
 * activity never consumes the relay's Coin result window. */
export async function fetchPeerMintEvents(
  pubkeys: string[],
  limit = MAX_EVENTS_PER_PEER,
  sweep?: CoMintSweepBudget,
  queryOverride?: (filter: Filter, bounds: RelaySampleBounds) => Promise<Event[]>,
): Promise<Map<string, Event[]>> {
  sweep?.assertActive();
  const relays = queryOverride ? [] : await getReadRelays(sweep?.signal);
  const peers = [...new Set(pubkeys.filter((pubkey) => HEX_64.test(pubkey)))]
    .slice(0, MAX_COMINT_PEERS);
  if ((!queryOverride && relays.length === 0) || peers.length === 0) return new Map();
  const requestedLimit = Number.isFinite(limit) ? Math.floor(limit) : MAX_EVENTS_PER_PEER;
  const boundedLimit = Math.max(1, Math.min(requestedLimit, MAX_EVENTS_PER_PEER));
  const rawQuery = queryOverride ?? ((filter: Filter, bounds: RelaySampleBounds) =>
    queryMany(relays, filter, 4_000, bounds));
  const runLimited = createLimiter(MAX_CONCURRENT_PEER_FETCHES);
  const out = new Map<string, Event[]>();
  await Promise.all(peers.map((peer) => runLimited(async () => {
    try {
      sweep?.assertActive();
      const maxAttestations = Math.min(
        MAX_ATTESTATIONS_PER_PEER,
        Math.max(MAX_ATTESTATIONS_PER_COIN, boundedLimit * MAX_ATTESTATIONS_PER_COIN),
      );
      const completionProofs = (await rawQuery({
        kinds: [TRACE_ATTESTATION_KIND],
        authors: [peer],
        limit: maxAttestations,
      }, attestationBounds(maxAttestations, sweep?.signal)))
        .filter((event) =>
          event.pubkey === peer && validTraceAttestationTargetId(event) !== null
        )
        .slice(0, maxAttestations);
      sweep?.consume(completionProofs);
      const targetIds = [...new Set(completionProofs.flatMap((event) => {
        const targetId = validTraceAttestationTargetId(event);
        return targetId ? [targetId] : [];
      }))];
      const events: Event[] = [];
      for (const targetBatch of batches(targetIds, MAX_RELAY_BATCH_IDS)) {
        if (events.length >= boundedLimit) break;
        sweep?.assertActive();
        const requested = new Set(targetBatch);
        const sampled = (await rawQuery({
          kinds: [TRACE_NODE_KIND],
          authors: [peer],
          ids: targetBatch,
          limit: targetBatch.length,
        }, {
          ...coMintBounds(targetBatch.length, MAX_PEER_SAMPLE_BYTES, sweep?.signal),
          requestedIds: targetBatch,
        }))
          .filter((event) =>
            event.kind === TRACE_NODE_KIND &&
            event.pubkey === peer &&
            requested.has(event.id) &&
            eventVerifies(event)
          )
          .slice(0, targetBatch.length);
        sweep?.consume(sampled);
        const byId = new Map(sampled.map((event) => [event.id, event]));
        for (const targetId of targetBatch) {
          const event = byId.get(targetId);
          if (event && await verifiedCoinGenesisCoordinate(event)) events.push(event);
          if (events.length >= boundedLimit) break;
        }
      }
      out.set(peer, events);
    } catch (error) {
      if (sweep?.signal.aborted) throw error;
      out.set(peer, []);
    }
  })));
  return out;
}

/** Full trust-bounded sweep over peers already readable by the introducer. */
export async function detectCoMints(
  pubkeys: string[],
  limit = MAX_EVENTS_PER_PEER,
  signal?: AbortSignal,
): Promise<CoMintMatch[]> {
  const sweep = createCoMintSweepBudget(signal);
  try {
    const relays = await getReadRelays(sweep.signal);
    sweep.assertActive();
    if (relays.length === 0) return [];
    const query = (filter: Filter, bounds: RelaySampleBounds) =>
      queryMany(relays, filter, 4_000, bounds);
    const eventsByPeer = await fetchPeerMintEvents(pubkeys, limit, sweep, query);
    sweep.assertActive();
    const peerCount = Math.max(1, eventsByPeer.size);
    const perPeerCoinLimit = Math.max(
      1,
      Math.min(MAX_COINS_PER_PEER, Math.floor(MAX_COINS_PER_SWEEP / peerCount)),
    );
    const mintsByPeer = new Map<string, CompletedPeerMint[]>();
    const runLimited = createLimiter(MAX_CONCURRENT_PEER_FETCHES);

    await Promise.all([...eventsByPeer].map(([peer, events]) => runLimited(async () => {
      sweep.assertActive();
      const candidateCoins: Event[] = [];
      for (const event of events) {
        if (candidateCoins.length >= perPeerCoinLimit) break;
        if (await verifiedCoinGenesisCoordinate(event)) candidateCoins.push(event);
      }
      if (candidateCoins.length === 0) {
        mintsByPeer.set(peer, []);
        return;
      }

      const attestations = new Map<string, Event[]>();
      for (const coin of candidateCoins) {
        sweep.assertActive();
        const events = await query({
          kinds: [TRACE_ATTESTATION_KIND],
          authors: [peer],
          "#e": [coin.id],
          limit: MAX_ATTESTATIONS_PER_COIN,
        }, attestationBounds(MAX_ATTESTATIONS_PER_COIN, sweep.signal)).catch(() => []);
        sweep.assertActive();
        const sampled = events.slice(0, MAX_ATTESTATIONS_PER_COIN);
        sweep.consume(sampled);
        for (const attestation of sampled) {
          if (!isValidMinterAttestation(coin, attestation)) continue;
          const forCoin = attestations.get(coin.id) ?? [];
          forCoin.push(attestation);
          attestations.set(coin.id, forCoin);
        }
      }

      const completedWithoutSources = await completedMintsFromEvents(candidateCoins, attestations);
      const completedIds = new Set(completedWithoutSources.map((mint) => mint.coinNodeId));
      const extractedCoins = candidateCoins.filter((coin) => {
        const origin = coinOriginFromEvent(coin);
        return completedIds.has(coin.id) && origin?.kind === "extracted";
      });
      const sourceIds = [...new Set(extractedCoins.flatMap((coin) => {
        const origin = coinOriginFromEvent(coin);
        return origin?.kind === "extracted" ? [origin.sourceNodeId] : [];
      }))].slice(0, MAX_RELAY_BATCH_IDS);
      const sources = new Map<string, Event>();
      if (sourceIds.length > 0) {
        try {
          const sourceEvents = await query({
            kinds: [TRACE_NODE_KIND],
            ids: sourceIds,
            limit: sourceIds.length,
          }, {
            ...coMintBounds(sourceIds.length, MAX_PEER_SAMPLE_BYTES, sweep.signal),
            requestedIds: sourceIds,
          });
          sweep.assertActive();
          const sampled = sourceEvents.slice(0, sourceIds.length);
          sweep.consume(sampled);
          for (const source of sampled) sources.set(source.id, source);
        } catch (error) {
          if (sweep.signal.aborted) throw error;
          // Supplemental evidence only; absence does not exclude the Mint.
        }
      }
      mintsByPeer.set(
        peer,
        await completedMintsFromEvents(candidateCoins, attestations, sources),
      );
    })));
    sweep.assertActive();
    return intersectCompletedMintCoordinates(mintsByPeer)
      .sort((a, b) => b.coordinates.length - a.coordinates.length);
  } finally {
    sweep.dispose();
  }
}

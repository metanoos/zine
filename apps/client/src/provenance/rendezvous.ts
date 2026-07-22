import { verifyEvent } from "nostr-tools/pure";
import type { Event, Filter } from "nostr-tools";

import { isTauri } from "../identity/identity.js";
import {
  loadKademliaConfig,
  lookupRendezvousPointers,
  publishRendezvousPointer,
  type RendezvousPointer,
} from "../networking/kademlia.js";
import {
  isLoopbackRelayUrl,
  publicationRelays,
} from "../networking/relay-config.js";
import { sampleRendezvousRelays } from "../networking/rendezvous-relay.js";
import {
  coinOriginFromEvent,
  isCoinEvent,
  quoteHash,
  republishExactMintPairToRelays,
  sha256HexLocal,
  TRACE_NODE_KIND,
  verifiedFileSourceSnapshot,
  type RelaySampleBounds,
  type SampleHit,
} from "./provenance.js";
import { verifyFileTraceChain } from "./trace-conformance.js";

const HEX_64 = /^[0-9a-f]{64}$/;
const TRACE_ATTESTATION_KIND = 4294;
const MAX_RAW_POINTERS = 64;
const MAX_RELAY_BATCH_IDS = 128;
const MAX_ATTESTATIONS_PER_COIN = 4;
const MAX_CONCURRENT_RELAY_VERIFICATIONS = 4;
const RELAY_QUERY_TIMEOUT_MS = 4_000;
const POINTER_PUT_TIMEOUT_MS = 4_000;
const PUBLICATION_DEADLINE_MS = 20_000;
const LOOKUP_TIMEOUT_MS = 8_000;
const DISCOVERY_DEADLINE_MS = 15_000;
export const MAX_RENDEZVOUS_EVENT_BYTES = 2 * 1024 * 1024;
const MAX_RENDEZVOUS_SAMPLE_BYTES = 4 * 1024 * 1024;
export const MAX_RENDEZVOUS_CONTENT_LENGTH = 1024 * 1024;
export const MAX_RENDEZVOUS_TAGS = 4_096;
export const MAX_RENDEZVOUS_TAG_VALUES = 32;
export const MAX_RENDEZVOUS_TAG_VALUE_LENGTH = 16_384;

export interface VerifiedRendezvousCandidate extends RendezvousPointer {
  signerPubkey: string;
  coinNodeId: string;
  /** Every public relay that yielded this same completed Coin. */
  relayUrls: string[];
  coordinate: string;
  originKind: "direct" | "extracted";
  /** Supplemental evidence only. A missing private source never excludes a Mint. */
  sourceEvidenceVerified: boolean;
}

export interface RendezvousPublishReport {
  /**
   * True when the durable outbox may forget this row: either at least one
   * public Coin pointer landed, or the local Coin/attestation is permanently
   * unindexable (`pointersPublished === 0` with a terminal failure). Callers
   * must not treat this alone as a successful H publication; check
   * `pointersPublished` (and log terminal abandons).
   */
  complete: boolean;
  coordinates: string[];
  pointersPublished: number;
  skippedRelays: string[];
  failures: RendezvousPublishFailure[];
}

export interface RendezvousPublishFailure {
  relayUrl?: string;
  coinNodeId?: string;
  coordinate?: string;
  stage: "relay-publish" | "relay-fetch" | "coin-missing" | "pointer-put" | "configuration" | "pair-invalid";
  error: string;
}

interface RelaySampleResult {
  hits: SampleHit[];
  errors: { url: string; error: string }[];
}

export interface RendezvousAdapters {
  enabled(): boolean;
  publicationRelayUrls(): string[];
  sample(
    urls: string[],
    filter: Filter,
    perRelayMs: number,
    bounds: RelaySampleBounds,
  ): Promise<RelaySampleResult>;
  publishPointer(
    coordinate: string,
    pointer: RendezvousPointer,
    signal?: AbortSignal,
  ): Promise<void>;
  publishPair(
    relayUrls: string[],
    coin: Event,
    attestation: Event,
    signal?: AbortSignal,
  ): Promise<string[]>;
  lookupPointers(coordinate: string, signal?: AbortSignal): Promise<RendezvousPointer[]>;
}

export interface RendezvousOperationOptions {
  signal?: AbortSignal;
  /** Optional shorter local budget, primarily for bounded UI/test callers. */
  deadlineMs?: number;
  completionAttestation?: Event;
  adapters?: Partial<RendezvousAdapters>;
}

const defaultAdapters: RendezvousAdapters = {
  enabled: () => isTauri() && loadKademliaConfig().enabled,
  publicationRelayUrls: () => publicationRelays().map((entry) => entry.url),
  sample: sampleRendezvousRelays,
  publishPair: republishExactMintPairToRelays,
  publishPointer: publishRendezvousPointer,
  lookupPointers: lookupRendezvousPointers,
};

function adaptersFor(overrides?: Partial<RendezvousAdapters>): RendezvousAdapters {
  return { ...defaultAdapters, ...overrides };
}

function ipv4Bytes(host: string): number[] | null {
  const parts = host.split(".");
  if (parts.length !== 4 || !parts.every((part) => /^\d{1,3}$/.test(part))) return null;
  const bytes = parts.map(Number);
  return bytes.some((byte) => byte > 255) ? null : bytes;
}

function mappedIpv4Bytes(host: string): number[] | null {
  if (!host.startsWith("::ffff:")) return null;
  const suffix = host.slice("::ffff:".length);
  const dotted = ipv4Bytes(suffix);
  if (dotted) return dotted;
  const groups = suffix.split(":");
  if (groups.length !== 2 || !groups.every((group) => /^[0-9a-f]{1,4}$/.test(group))) {
    return null;
  }
  const high = Number.parseInt(groups[0]!, 16);
  const low = Number.parseInt(groups[1]!, 16);
  return [high >>> 8, high & 0xff, low >>> 8, low & 0xff];
}

/** Decode the deprecated IPv4-compatible IPv6 form (`::a.b.c.d`, first 96 bits
 * zero) as its trailing IPv4 bytes. Returns null for the mapped prefix
 * (`::ffff:0:0/96`, handled by {@link mappedIpv4Bytes}) and for the all-zero
 * unspecified address `::` (so it is not silently treated as 0.0.0.0). */
function ipv4CompatibleBytes(host: string): number[] | null {
  if (!host.startsWith("::")) return null;
  const suffix = host.slice(2);
  if (suffix.length === 0) return null;
  const dotted = ipv4Bytes(suffix);
  if (dotted) return dotted;
  const groups = suffix.split(":");
  if (groups.length !== 2 || !groups.every((group) => /^[0-9a-f]{1,4}$/.test(group))) {
    return null;
  }
  const high = Number.parseInt(groups[0]!, 16);
  const low = Number.parseInt(groups[1]!, 16);
  return [high >>> 8, high & 0xff, low >>> 8, low & 0xff];
}

/** Reject every IPv4 range the native dialer (`rendezvous_relay.rs::is_public_ipv4`)
 * rejects, so the application-level filter and the dialer agree. This is layered
 * defense — the dialer re-validates at TCP-connect — but keeping the two reject
 * lists in sync prevents a pointer naming a TEST-NET or CGNAT literal from being
 * accepted into the DHT only to fail every downstream fetch. */
function isPrivateIpv4(bytes: number[]): boolean {
  const [a, b, c] = bytes;
  return (
    a === 0 || // 0.0.0.0/8 "this host"
    a === 10 || // RFC1918
    a === 127 || // loopback
    (a === 169 && b === 254) || // link-local
    (a === 172 && b! >= 16 && b! <= 31) || // RFC1918
    (a === 192 && b === 168) || // RFC1918
    // Special-purpose ranges the dialer also blocks:
    (a === 100 && b! >= 64 && b! <= 127) || // RFC6598 CGNAT
    (a === 192 && b === 0 && (c === 0 || c === 2)) || // TEST-NET-adjacent / doc
    (a === 192 && b === 88 && c === 99) || // 6to4 anycast (deprecated)
    (a === 198 && (b === 18 || b === 19)) || // RFC2544 benchmarking
    (a === 198 && b === 51 && c === 100) || // TEST-NET-2
    (a === 203 && b === 0 && c === 113) || // TEST-NET-3
    a! >= 240 // reserved (class E) + broadcast 255.255.255.255
  );
}

function isPrivateIpLiteral(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const bytes =
    ipv4Bytes(host) ?? mappedIpv4Bytes(host) ?? ipv4CompatibleBytes(host);
  if (bytes) return isPrivateIpv4(bytes);
  return (
    host === "::" ||
    host === "::1" ||
    /^f[cd][0-9a-f]*:/.test(host) ||
    /^fe[89ab][0-9a-f]*:/.test(host) ||
    /^ff[0-9a-f]{1,2}:/.test(host)
  );
}

/** The DHT may name only a stranger-readable clearnet WebSocket relay. */
export function isPublicRendezvousRelayUrl(url: string): boolean {
  if (isLoopbackRelayUrl(url)) return false;
  try {
    const parsed = new URL(url);
    return (
      (parsed.protocol === "ws:" || parsed.protocol === "wss:") &&
      !parsed.username &&
      !parsed.password &&
      !parsed.hostname.toLowerCase().endsWith(".onion") &&
      !isPrivateIpLiteral(parsed.hostname)
    );
  } catch {
    return false;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function operationAborted(signal?: AbortSignal): Error {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error("operation aborted");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw operationAborted(signal);
}

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
  signal?: AbortSignal,
): Promise<T> {
  throwIfAborted(signal);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  const aborted = new Promise<never>((_, reject) => {
    if (!signal) return;
    abort = () => reject(operationAborted(signal));
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([promise, timeout, aborted]);
  } finally {
    if (timer) clearTimeout(timer);
    if (abort) signal?.removeEventListener("abort", abort);
  }
}

function sampleBounds(ids: readonly string[], signal?: AbortSignal): RelaySampleBounds {
  return {
    requestedIds: ids,
    maxUniqueEvents: ids.length,
    maxTotalBytes: MAX_RENDEZVOUS_SAMPLE_BYTES,
    maxEventBytes: MAX_RENDEZVOUS_EVENT_BYTES,
    maxContentLength: MAX_RENDEZVOUS_CONTENT_LENGTH,
    maxTags: MAX_RENDEZVOUS_TAGS,
    maxTagValues: MAX_RENDEZVOUS_TAG_VALUES,
    maxTagValueLength: MAX_RENDEZVOUS_TAG_VALUE_LENGTH,
    signal,
  };
}

function attestationSampleBounds(
  signal?: AbortSignal,
  maxUniqueEvents = MAX_ATTESTATIONS_PER_COIN,
): RelaySampleBounds {
  return {
    maxUniqueEvents,
    maxTotalBytes: MAX_RENDEZVOUS_SAMPLE_BYTES,
    maxEventBytes: MAX_RENDEZVOUS_EVENT_BYTES,
    maxContentLength: MAX_RENDEZVOUS_CONTENT_LENGTH,
    maxTags: MAX_RENDEZVOUS_TAGS,
    maxTagValues: MAX_RENDEZVOUS_TAG_VALUES,
    maxTagValueLength: MAX_RENDEZVOUS_TAG_VALUE_LENGTH,
    signal,
  };
}

function deadlineSignal(parent: AbortSignal | undefined, ms: number, label: string): {
  signal: AbortSignal;
  dispose(): void;
} {
  const controller = new AbortController();
  const onAbort = () => controller.abort(parent?.reason);
  if (parent?.aborted) onAbort();
  else parent?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => {
    const error = new Error(`rendezvous ${label} timed out after ${ms}ms`);
    error.name = "TimeoutError";
    controller.abort(error);
  }, ms);
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onAbort);
    },
  };
}

function childOperationSignal(parent?: AbortSignal): {
  controller: AbortController;
  dispose(): void;
} {
  const controller = new AbortController();
  const onAbort = () => controller.abort(parent?.reason);
  if (parent?.aborted) onAbort();
  else parent?.addEventListener("abort", onAbort, { once: true });
  return {
    controller,
    dispose() {
      parent?.removeEventListener("abort", onAbort);
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

type VerifiedCoinGenesis = {
  coordinate: string;
  snapshot: string;
  origin: NonNullable<ReturnType<typeof coinOriginFromEvent>>;
};

async function verifiedCoinGenesis(event: Event): Promise<VerifiedCoinGenesis | null> {
  if (!verifyEvent(event) || !isCoinEvent(event)) return null;
  const conformance = await verifyFileTraceChain([event]);
  if (conformance.status !== "full") return null;
  const origin = coinOriginFromEvent(event);
  if (!origin) return null;
  const xTags = event.tags.filter((tag) => tag[0] === "x");
  if (xTags.length !== 1 || !HEX_64.test(xTags[0]?.[1] ?? "")) return null;
  try {
    const content = JSON.parse(event.content) as {
      snapshot?: unknown;
      contentHash?: unknown;
    };
    if (typeof content.snapshot !== "string" || typeof content.contentHash !== "string") {
      return null;
    }
    const exactHash = await sha256HexLocal(content.snapshot);
    if (exactHash !== content.contentHash || exactHash !== xTags[0][1]) return null;
    return { coordinate: await quoteHash(content.snapshot), snapshot: content.snapshot, origin };
  } catch {
    return null;
  }
}

/** Verify an extracted Coin's exact signed source slice as supplemental vetting
 * evidence. Membership itself depends only on the completed Coin envelope. */
export async function verifiedExtractedCoinSourceEvidence(
  coinEvent: Event,
  sourceEvent?: Event,
): Promise<boolean> {
  const coin = await verifiedCoinGenesis(coinEvent);
  if (!coin || coin.origin.kind !== "extracted") return false;
  const sourceSnapshot = await verifiedFileSourceSnapshot(
    sourceEvent,
    coin.origin.sourceNodeId,
  );
  if (sourceSnapshot === null) return false;
  try {
    const sourceHash = await sha256HexLocal(sourceSnapshot);
    return (
      sourceHash === coin.origin.sourceContentHash &&
      coin.origin.range.end <= sourceSnapshot.length &&
      sourceSnapshot.slice(coin.origin.range.start, coin.origin.range.end) === coin.snapshot
    );
  } catch {
    return false;
  }
}

/** Validate the immutable Full Trace Coin genesis and derive its H coordinate.
 * Extracted-source reachability is deliberately not a membership condition. */
export async function verifiedCoinGenesisCoordinate(event: Event): Promise<string | null> {
  return (await verifiedCoinGenesis(event))?.coordinate ?? null;
}

export function validTraceAttestationTargetId(attestation: Event): string | null {
  if (
    attestation.kind !== TRACE_ATTESTATION_KIND ||
    !verifyEvent(attestation)
  ) return null;

  const targetTags = attestation.tags.filter((tag) => tag[0] === "e");
  const kindTags = attestation.tags.filter((tag) => tag[0] === "k");
  const authorTags = attestation.tags.filter((tag) => tag[0] === "p");
  const geohashTags = attestation.tags.filter((tag) => tag[0] === "g");
  if (
    targetTags.length !== 1 ||
    !HEX_64.test(targetTags[0]?.[1] ?? "") ||
    targetTags[0]?.[2] !== "" ||
    targetTags[0]?.[3] !== "target" ||
    kindTags.length !== 1 ||
    kindTags[0]?.[1] !== String(TRACE_NODE_KIND) ||
    authorTags.length > 1 ||
    (authorTags.length === 1 && !HEX_64.test(authorTags[0]?.[1] ?? "")) ||
    geohashTags.length > 1 ||
    attestation.tags.some((tag) => !["e", "k", "p", "g"].includes(tag[0] ?? ""))
  ) return null;

  try {
    const content = JSON.parse(attestation.content) as unknown;
    if (!content || typeof content !== "object" || Array.isArray(content)) return null;
    const record = content as Record<string, unknown>;
    const keys = Object.keys(record);
    return (
      keys.every((key) => key === "message") &&
      (record.message === undefined || typeof record.message === "string")
    ) ? targetTags[0]![1]! : null;
  } catch {
    return null;
  }
}

/** Bind a structurally valid attestation to the fetched target. The optional
 * p tag names the target signer, not necessarily the attester. */
export function isValidTraceAttestationForTarget(
  target: Event,
  attestation: Event,
): boolean {
  const authorTags = attestation.tags.filter((tag) => tag[0] === "p");
  return target.kind === TRACE_NODE_KIND &&
    validTraceAttestationTargetId(attestation) === target.id &&
    (authorTags.length === 0 || authorTags[0]?.[1] === target.pubkey);
}

export function isValidMinterAttestation(coin: Event, attestation: Event): boolean {
  return attestation.pubkey === coin.pubkey &&
    isValidTraceAttestationForTarget(coin, attestation);
}

/** Verify exact Coin identity and the same-key TraceAttestation that completes Mint. */
export async function verifiedCoinCoordinate(
  event: Event,
  attestations: Iterable<Event> = [],
): Promise<string | null> {
  const coordinate = await verifiedCoinGenesisCoordinate(event);
  if (!coordinate) return null;
  for (const attestation of attestations) {
    if (isValidMinterAttestation(event, attestation)) return coordinate;
  }
  return null;
}

async function fetchMinterAttestations(
  adapters: RendezvousAdapters,
  relayUrl: string,
  coins: readonly Event[],
  signal: AbortSignal,
  sample: RendezvousAdapters["sample"] = adapters.sample,
): Promise<Map<string, Event[]>> {
  const byTarget = new Map<string, Event[]>();
  // Keep one relay in one verification slot, but give each Coin its own relay
  // result window. One minter therefore cannot fill a shared batch with newer
  // attestations and suppress another minter's completion proof.
  for (const coin of coins) {
    throwIfAborted(signal);
    const result = await sample(
      [relayUrl],
      {
        kinds: [TRACE_ATTESTATION_KIND],
        authors: [coin.pubkey],
        "#e": [coin.id],
        limit: MAX_ATTESTATIONS_PER_COIN,
      },
      RELAY_QUERY_TIMEOUT_MS,
      attestationSampleBounds(signal),
    );
    if (result.errors.length > 0) continue;
    for (const hit of result.hits) {
      const events = byTarget.get(coin.id) ?? [];
      events.push(hit.event);
      byTarget.set(coin.id, events);
    }
  }
  return byTarget;
}

async function settleDiscoveryWorkers(
  workers: readonly Promise<void>[],
  internalSignal: AbortSignal,
  parentSignal?: AbortSignal,
): Promise<void> {
  const results = await Promise.allSettled(workers);
  if (parentSignal?.aborted) throw operationAborted(parentSignal);
  const internalTimeout = internalSignal.aborted &&
    (internalSignal.reason as { name?: unknown } | undefined)?.name === "TimeoutError";
  if (internalTimeout) return;
  const failure = results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failure) throw failure.reason;
  throwIfAborted(internalSignal);
}

/** Verify that one hostile DHT pointer names this completed Coin under H. */
export async function verifiedCandidateFromEvents(
  pointer: RendezvousPointer,
  coin: Event,
  coordinate: string,
  attestations: Iterable<Event> = [],
  sourceEvent?: Event,
): Promise<VerifiedRendezvousCandidate | null> {
  if (
    pointer.eventId !== coin.id ||
    !HEX_64.test(coordinate) ||
    await verifiedCoinCoordinate(coin, attestations) !== coordinate
  ) return null;
  const origin = coinOriginFromEvent(coin);
  if (!origin) return null;
  return {
    ...pointer,
    signerPubkey: coin.pubkey,
    coinNodeId: coin.id,
    relayUrls: [pointer.relayUrl],
    coordinate,
    originKind: origin.kind,
    sourceEvidenceVerified: origin.kind === "extracted" &&
      await verifiedExtractedCoinSourceEvidence(coin, sourceEvent),
  };
}

/**
 * Mint-side rendezvous publication. A relay is eligible only when a fresh,
 * unauthenticated connection can fetch the Coin genesis and its exact same-key
 * completion attestation. No containing citation or source publication is
 * required. DHT failure never invalidates the already-complete public Mint.
 */
export async function publishCompletedCoinMint(
  coin: Event,
  options: RendezvousOperationOptions = {},
): Promise<RendezvousPublishReport> {
  const adapters = adaptersFor(options.adapters);
  const report: RendezvousPublishReport = {
    complete: false,
    coordinates: [],
    pointersPublished: 0,
    skippedRelays: [],
    failures: [],
  };
  // Leave the row queued while Coins/Kademlia is off; the drain path already
  // refuses to act when disabled, and a false complete must not clear work.
  if (!adapters.enabled()) return report;
  const localGenesis = await verifiedCoinGenesis(coin);
  // Corrupt queue rows are terminal: retry cannot turn them into completed Coins.
  // complete=true still means "forget the outbox row", not "pointer published".
  if (!localGenesis) {
    report.complete = true;
    report.failures.push({
      coinNodeId: coin.id,
      stage: "pair-invalid",
      error: "local event is not a verified Full Trace Coin genesis; abandoning indexing",
    });
    return report;
  }
  const completionAttestation = options.completionAttestation;
  if (
    completionAttestation &&
    !isValidMinterAttestation(coin, completionAttestation)
  ) {
    report.complete = true;
    report.failures.push({
      coinNodeId: coin.id,
      coordinate: localGenesis.coordinate,
      stage: "pair-invalid",
      error: "durable Mint completion attestation does not match the Coin genesis",
    });
    return report;
  }

  const relayUrls = [...new Set(adapters.publicationRelayUrls())];
  const eligibleRelays = relayUrls.filter((url) => {
    if (isPublicRendezvousRelayUrl(url)) return true;
    report.skippedRelays.push(url);
    return false;
  });
  if (eligibleRelays.length === 0) {
    report.complete = false;
    report.failures.push({
      coinNodeId: coin.id,
      coordinate: localGenesis.coordinate,
      stage: "configuration",
      error: "no public publication relay can prove completed-Mint reachability",
    });
    return report;
  }

  const deadline = deadlineSignal(options.signal, PUBLICATION_DEADLINE_MS, "publication");
  const signal = deadline.signal;
  const limit = createLimiter(MAX_CONCURRENT_RELAY_VERIFICATIONS);
  try {
    await Promise.all(eligibleRelays.map((relayUrl) => limit(async () => {
      throwIfAborted(signal);
      if (completionAttestation) {
        try {
          const published = await adapters.publishPair(
            [relayUrl],
            coin,
            completionAttestation,
            signal,
          );
          if (!published.includes(relayUrl)) {
            throw new Error("relay did not accept both exact Mint events");
          }
        } catch (error) {
          report.failures.push({
            relayUrl,
            coinNodeId: coin.id,
            coordinate: localGenesis.coordinate,
            stage: "relay-publish",
            error: errorMessage(error),
          });
          return;
        }
      }
      let sampled: RelaySampleResult;
      try {
        sampled = await adapters.sample(
          [relayUrl],
          { ids: [coin.id], limit: 1 },
          RELAY_QUERY_TIMEOUT_MS,
          sampleBounds([coin.id], signal),
        );
      } catch (error) {
        report.failures.push({
          relayUrl,
          coinNodeId: coin.id,
          stage: "relay-fetch",
          error: errorMessage(error),
        });
        return;
      }
      if (sampled.errors.length > 0) {
        report.failures.push(...sampled.errors.map((failure) => ({
          relayUrl: failure.url,
          coinNodeId: coin.id,
          stage: "relay-fetch" as const,
          error: failure.error,
        })));
        return;
      }
      const fetchedCoin = sampled.hits.find((hit) => hit.event.id === coin.id)?.event;
      const fetchedGenesis = fetchedCoin ? await verifiedCoinGenesis(fetchedCoin) : null;
      if (
        !fetchedCoin ||
        !fetchedGenesis ||
        fetchedCoin.pubkey !== coin.pubkey ||
        fetchedGenesis.coordinate !== localGenesis.coordinate
      ) {
        report.failures.push({
          relayUrl,
          coinNodeId: coin.id,
          coordinate: localGenesis.coordinate,
          stage: "coin-missing",
          error: "completed Coin genesis was not cryptographically resolved from the public relay",
        });
        return;
      }
      const attestations = await fetchMinterAttestations(
        adapters,
        relayUrl,
        [fetchedCoin],
        signal,
        adapters.sample,
      );
      if (!(attestations.get(coin.id) ?? []).some(
        (attestation) => isValidMinterAttestation(fetchedCoin, attestation),
      )) {
        report.failures.push({
          relayUrl,
          coinNodeId: coin.id,
          coordinate: localGenesis.coordinate,
          stage: "coin-missing",
          error: "valid same-minter completion attestation is not fetchable from the public relay",
        });
        return;
      }

      const operation = childOperationSignal(signal);
      try {
        if (!adapters.enabled()) {
          throw new Error("Coins were disabled before pointer publication");
        }
        await withTimeout(
          adapters.publishPointer(
            localGenesis.coordinate,
            { eventId: coin.id, relayUrl },
            operation.controller.signal,
          ),
          POINTER_PUT_TIMEOUT_MS,
          `pointer Put for ${localGenesis.coordinate}`,
          signal,
        );
        if (!adapters.enabled()) {
          throw new Error("Coins were disabled during pointer publication");
        }
        report.pointersPublished++;
      } catch (error) {
        report.failures.push({
          relayUrl,
          coinNodeId: coin.id,
          coordinate: localGenesis.coordinate,
          stage: "pointer-put",
          error: errorMessage(error),
        });
      } finally {
        operation.controller.abort(new Error(`pointer Put for ${localGenesis.coordinate} finished`));
        operation.dispose();
      }
    })));
    report.complete = report.pointersPublished > 0;
    report.coordinates = report.complete ? [localGenesis.coordinate] : [];
    return report;
  } finally {
    deadline.dispose();
  }
}

/**
 * Read-side lookup. Raw DHT values are attacker-controlled; candidates are
 * re-fetched without relay authentication and admitted only as completed Coins
 * whose verified H matches. Ordinary q citations are never considered.
 */
export async function discoverCompletedCoinMints(
  phrase: string,
  options: RendezvousOperationOptions = {},
): Promise<VerifiedRendezvousCandidate[]> {
  const adapters = adaptersFor(options.adapters);
  if (!adapters.enabled()) return [];
  const requestedDeadline = Number.isFinite(options.deadlineMs)
    ? options.deadlineMs!
    : DISCOVERY_DEADLINE_MS;
  const discoveryDeadlineMs = Math.max(
    1,
    Math.min(DISCOVERY_DEADLINE_MS, Math.floor(requestedDeadline)),
  );
  const deadline = deadlineSignal(options.signal, discoveryDeadlineMs, "discovery");
  try {
    const coordinate = await quoteHash(phrase);
    const operation = childOperationSignal(deadline.signal);
    const raw = (await withTimeout(
      adapters.lookupPointers(coordinate, operation.controller.signal),
      LOOKUP_TIMEOUT_MS,
      "Kademlia lookup",
      deadline.signal,
    ).finally(() => {
      operation.controller.abort(new Error(`Kademlia lookup for ${coordinate} finished`));
      operation.dispose();
    }))
      .filter((pointer) =>
        HEX_64.test(pointer.eventId) && isPublicRendezvousRelayUrl(pointer.relayUrl))
      .slice(0, MAX_RAW_POINTERS);

    const byRelay = new Map<string, RendezvousPointer[]>();
    for (const pointer of raw) {
      const pointers = byRelay.get(pointer.relayUrl) ?? [];
      if (!pointers.some((existing) => existing.eventId === pointer.eventId)) {
        pointers.push(pointer);
        byRelay.set(pointer.relayUrl, pointers);
      }
    }

    const verified: VerifiedRendezvousCandidate[] = [];
    const relayGroups = [...byRelay];
    const relaySampleLimit = createLimiter(MAX_CONCURRENT_RELAY_VERIFICATIONS);
    const sample: RendezvousAdapters["sample"] = (...args) =>
      relaySampleLimit(() => adapters.sample(...args));
    let nextRelay = 0;
    async function verifyNextRelays(): Promise<void> {
      while (nextRelay < relayGroups.length) {
        throwIfAborted(deadline.signal);
        const [relayUrl, pointers] = relayGroups[nextRelay++]!;
        const coinIds = pointers.map((pointer) => pointer.eventId);
        const first = await sample(
          [relayUrl],
          { ids: coinIds },
          RELAY_QUERY_TIMEOUT_MS,
          sampleBounds(coinIds, deadline.signal),
        );
        if (first.errors.length > 0) continue;

        const coins = new Map<string, { event: Event; genesis: VerifiedCoinGenesis }>();
        for (const hit of first.hits) {
          const genesis = await verifiedCoinGenesis(hit.event);
          if (genesis?.coordinate === coordinate) {
            coins.set(hit.event.id, { event: hit.event, genesis });
          }
        }
        const attestations = await fetchMinterAttestations(
          adapters,
          relayUrl,
          [...coins.values()].map(({ event }) => event),
          deadline.signal,
          sample,
        );

        // Public source evidence is opportunistic. Failure or absence never
        // excludes the completed Mint or triggers publication of the source.
        const sourceIds = [...new Set([...coins.values()].flatMap(({ genesis }) =>
          genesis.origin.kind === "extracted" ? [genesis.origin.sourceNodeId] : []
        ))].slice(0, MAX_RELAY_BATCH_IDS);
        const sources = new Map<string, Event>();
        if (sourceIds.length > 0) {
          try {
            const sourceSample = await sample(
              [relayUrl],
              { ids: sourceIds },
              RELAY_QUERY_TIMEOUT_MS,
              sampleBounds(sourceIds, deadline.signal),
            );
            if (sourceSample.errors.length === 0) {
              for (const hit of sourceSample.hits) sources.set(hit.event.id, hit.event);
            }
          } catch {
            // Supplemental evidence only.
          }
        }

        for (const pointer of pointers) {
          const entry = coins.get(pointer.eventId);
          if (!entry) continue;
          const source = entry.genesis.origin.kind === "extracted"
            ? sources.get(entry.genesis.origin.sourceNodeId)
            : undefined;
          const candidate = await verifiedCandidateFromEvents(
            pointer,
            entry.event,
            coordinate,
            attestations.get(entry.event.id) ?? [],
            source,
          );
          if (candidate) verified.push(candidate);
        }
      }
    }
    await settleDiscoveryWorkers(
      Array.from(
        { length: Math.min(MAX_CONCURRENT_RELAY_VERIFICATIONS, relayGroups.length) },
        () => verifyNextRelays(),
      ),
      deadline.signal,
      options.signal,
    );

    const byEvent = new Map<string, VerifiedRendezvousCandidate>();
    for (const candidate of verified) {
      const existing = byEvent.get(candidate.eventId);
      if (!existing) {
        byEvent.set(candidate.eventId, candidate);
        continue;
      }
      const relayUrls = [...new Set([...existing.relayUrls, ...candidate.relayUrls])].sort();
      byEvent.set(candidate.eventId, {
        ...existing,
        relayUrl: relayUrls[0]!,
        relayUrls,
        sourceEvidenceVerified:
          existing.sourceEvidenceVerified || candidate.sourceEvidenceVerified,
      });
    }
    return [...byEvent.values()].sort((a, b) =>
      a.signerPubkey.localeCompare(b.signerPubkey) || a.eventId.localeCompare(b.eventId)
    );
  } finally {
    deadline.dispose();
  }
}

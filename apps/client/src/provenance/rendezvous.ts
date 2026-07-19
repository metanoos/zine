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
  isCoinEvent,
  quoteHash,
  sha256HexLocal,
  socialCitationTargets,
  TRACE_NODE_KIND,
  type RelaySampleBounds,
  type SampleHit,
} from "./provenance.js";

const HEX_64 = /^[0-9a-f]{64}$/;
const TRACE_ATTESTATION_KIND = 4294;
const MAX_RAW_POINTERS = 64;
const MAX_RELAY_BATCH_IDS = 128;
const MAX_ATTESTATIONS_PER_QUERY = 128;
const MAX_CONCURRENT_RELAY_VERIFICATIONS = 4;
const RELAY_QUERY_TIMEOUT_MS = 4_000;
const POINTER_PUT_TIMEOUT_MS = 4_000;
const PUBLICATION_DEADLINE_MS = 20_000;
const LOOKUP_TIMEOUT_MS = 8_000;
const DISCOVERY_DEADLINE_MS = 15_000;
const MAX_RENDEZVOUS_EVENT_BYTES = 2 * 1024 * 1024;
const MAX_RENDEZVOUS_SAMPLE_BYTES = 4 * 1024 * 1024;
const MAX_RENDEZVOUS_CONTENT_LENGTH = 1024 * 1024;
const MAX_RENDEZVOUS_TAGS = 4_096;
const MAX_RENDEZVOUS_TAG_VALUES = 32;
const MAX_RENDEZVOUS_TAG_VALUE_LENGTH = 16_384;

export interface VerifiedRendezvousCandidate extends RendezvousPointer {
  signerPubkey: string;
  targetNodeId: string;
  /** Every public relay that yielded this same signed carrying event. */
  relayUrls: string[];
  /** Every matching Coin genesis cited by this carrying event. */
  targetNodeIds: string[];
  coordinate: string;
}

export interface RendezvousPublishReport {
  /** True when every resolved valid Coin citation has one persisted pointer. */
  complete: boolean;
  coordinates: string[];
  pointersPublished: number;
  skippedRelays: string[];
  failures: RendezvousPublishFailure[];
}

export interface RendezvousPublishFailure {
  relayUrl?: string;
  targetNodeId?: string;
  coordinate?: string;
  stage: "relay-fetch" | "target-missing" | "pointer-put" | "configuration";
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
  lookupPointers(coordinate: string, signal?: AbortSignal): Promise<RendezvousPointer[]>;
}

export interface RendezvousOperationOptions {
  signal?: AbortSignal;
  adapters?: Partial<RendezvousAdapters>;
}

const defaultAdapters: RendezvousAdapters = {
  enabled: () => isTauri() && loadKademliaConfig().enabled,
  publicationRelayUrls: () => publicationRelays().map((entry) => entry.url),
  sample: sampleRendezvousRelays,
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

function ordinaryCitationTargets(event: Event): string[] {
  return socialCitationTargets(event).filter((id) => HEX_64.test(id));
}

function batches<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let offset = 0; offset < values.length; offset += size) {
    result.push(values.slice(offset, offset + size));
  }
  return result;
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

function attestationSampleBounds(signal?: AbortSignal): RelaySampleBounds {
  return {
    maxUniqueEvents: MAX_ATTESTATIONS_PER_QUERY,
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

function isSocialCarryingEvent(event: Event): boolean {
  return (
    event.kind === TRACE_NODE_KIND &&
    verifyEvent(event) &&
    event.tags.some((tag) => tag[0] === "z" && tag[1] === "file") &&
    !event.tags.some((tag) => tag[0] === "action" && tag[1] === "delete")
  );
}

/** Validate the immutable Coin genesis before checking compound-Mint completion. */
export async function verifiedCoinGenesisCoordinate(event: Event): Promise<string | null> {
  if (!verifyEvent(event) || !isCoinEvent(event)) return null;
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
    return quoteHash(content.snapshot);
  } catch {
    return null;
  }
}

export function isValidMinterAttestation(coin: Event, attestation: Event): boolean {
  if (
    attestation.kind !== TRACE_ATTESTATION_KIND ||
    attestation.pubkey !== coin.pubkey ||
    !verifyEvent(attestation)
  ) return false;

  const targetTags = attestation.tags.filter((tag) => tag[0] === "e");
  const kindTags = attestation.tags.filter((tag) => tag[0] === "k");
  const authorTags = attestation.tags.filter((tag) => tag[0] === "p");
  const geohashTags = attestation.tags.filter((tag) => tag[0] === "g");
  if (
    targetTags.length !== 1 ||
    targetTags[0]?.[1] !== coin.id ||
    targetTags[0]?.[2] !== "" ||
    targetTags[0]?.[3] !== "target" ||
    kindTags.length !== 1 ||
    kindTags[0]?.[1] !== String(TRACE_NODE_KIND) ||
    authorTags.length > 1 ||
    (authorTags.length === 1 && authorTags[0]?.[1] !== coin.pubkey) ||
    geohashTags.length > 1 ||
    attestation.tags.some((tag) => !["e", "k", "p", "g"].includes(tag[0] ?? ""))
  ) return false;

  try {
    const content = JSON.parse(attestation.content) as unknown;
    if (!content || typeof content !== "object" || Array.isArray(content)) return false;
    const record = content as Record<string, unknown>;
    const keys = Object.keys(record);
    return (
      keys.every((key) => key === "message") &&
      (record.message === undefined || typeof record.message === "string")
    );
  } catch {
    return false;
  }
}

/**
 * Verify exact Coin identity and the required same-key TraceAttestation that
 * completes the compound Mint gesture before deriving the coarser H cluster.
 */
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
  const limit = createLimiter(MAX_CONCURRENT_RELAY_VERIFICATIONS);
  await Promise.all(coins.map((coin) => limit(async () => {
    throwIfAborted(signal);
    const result = await sample(
      [relayUrl],
      {
        kinds: [TRACE_ATTESTATION_KIND],
        authors: [coin.pubkey],
        "#e": [coin.id],
        limit: MAX_ATTESTATIONS_PER_QUERY,
      },
      RELAY_QUERY_TIMEOUT_MS,
      attestationSampleBounds(signal),
    );
    if (result.errors.length > 0) return;
    for (const hit of result.hits) {
      const target = hit.event.tags.find(
        (tag) => tag[0] === "e" && tag[3] === "target" && tag[1] === coin.id,
      )?.[1];
      if (!target) continue;
      const events = byTarget.get(target) ?? [];
      events.push(hit.event);
      byTarget.set(target, events);
    }
  })));
  return byTarget;
}

/** Verify that one signed carrying event really cites a Coin in coordinate H. */
export async function verifiedCandidateFromEvents(
  pointer: RendezvousPointer,
  carrying: Event,
  targets: Map<string, Event>,
  coordinate: string,
  attestations: Map<string, Event[]> = new Map(),
): Promise<VerifiedRendezvousCandidate | null> {
  if (
    pointer.eventId !== carrying.id ||
    !isSocialCarryingEvent(carrying) ||
    !HEX_64.test(coordinate)
  ) {
    return null;
  }
  const targetIds = ordinaryCitationTargets(carrying);
  const verifiedTargetIds: string[] = [];
  for (const targetNodeId of targetIds) {
    const target = targets.get(targetNodeId);
    if (!target) continue;
    if (await verifiedCoinCoordinate(target, attestations.get(targetNodeId) ?? []) !== coordinate) {
      continue;
    }
    verifiedTargetIds.push(targetNodeId);
  }
  if (verifiedTargetIds.length === 0) return null;
  return {
    ...pointer,
    signerPubkey: carrying.pubkey,
    targetNodeId: verifiedTargetIds[0]!,
    relayUrls: [pointer.relayUrl],
    targetNodeIds: verifiedTargetIds,
    coordinate,
  };
}

/**
 * Send-side rendezvous publication. A relay is eligible only when a fresh,
 * unauthenticated connection can fetch the carrying node, cited Coin genesis,
 * and the exact same-key minter attestation that completes Mint. That proves
 * the pointer does not strand strangers behind the author's private ACL. DHT
 * failure never rolls back a successful Send.
 */
export async function publishSentCoinCitations(
  carrying: Event,
  options: RendezvousOperationOptions = {},
): Promise<RendezvousPublishReport> {
  const adapters = adaptersFor(options.adapters);
  const report: RendezvousPublishReport = {
    complete: true,
    coordinates: [],
    pointersPublished: 0,
    skippedRelays: [],
    failures: [],
  };
  if (!adapters.enabled() || !isSocialCarryingEvent(carrying)) return report;

  const targetIds = ordinaryCitationTargets(carrying);
  if (targetIds.length === 0) return report;

  const relayUrls = [...new Set(adapters.publicationRelayUrls())];
  const eligibleRelays = relayUrls.filter((url) => {
    if (isPublicRendezvousRelayUrl(url)) return true;
    report.skippedRelays.push(url);
    return false;
  });
  if (eligibleRelays.length === 0) {
    report.complete = false;
    report.failures.push({
      stage: "configuration",
      error: "no public publication relay can prove rendezvous reachability",
    });
    return report;
  }
  const deadline = deadlineSignal(options.signal, PUBLICATION_DEADLINE_MS, "publication");
  const signal = deadline.signal;

  const states = new Map(targetIds.map((targetNodeId) => [targetNodeId, {
    resolved: false,
    validCoordinates: new Set<string>(),
    pointerPublished: false,
  }]));
  const coordinates = new Set<string>();
  const pointerPuts = new Map<string, Promise<boolean>>();
  const limit = createLimiter(MAX_CONCURRENT_RELAY_VERIFICATIONS);

  async function persistPointer(relayUrl: string, coordinate: string): Promise<boolean> {
    const key = `${relayUrl}\n${coordinate}`;
    const existing = pointerPuts.get(key);
    if (existing) return existing;
    const promise = limit(async () => {
      const operation = childOperationSignal(signal);
      try {
        if (!adapters.enabled()) {
          throw new Error("Kademlia rendezvous was disabled before pointer publication");
        }
        await withTimeout(
          adapters.publishPointer(
            coordinate,
            { eventId: carrying.id, relayUrl },
            operation.controller.signal,
          ),
          POINTER_PUT_TIMEOUT_MS,
          `pointer Put for ${coordinate}`,
          signal,
        );
        if (!adapters.enabled()) {
          throw new Error("Kademlia rendezvous was disabled during pointer publication");
        }
        report.pointersPublished++;
        coordinates.add(coordinate);
        return true;
      } catch (error) {
        report.failures.push({
          relayUrl,
          coordinate,
          stage: "pointer-put",
          error: errorMessage(error),
        });
        return false;
      } finally {
        // If the Promise race ended on timeout/parent abort, propagate that
        // result through the IPC adapter so native Kademlia work is cancelled.
        operation.controller.abort(new Error(`pointer Put for ${coordinate} finished`));
        operation.dispose();
      }
    });
    pointerPuts.set(key, promise);
    return promise;
  }

  await Promise.all(eligibleRelays.map(async (relayUrl) => {
    for (const targetBatch of batches(targetIds, MAX_RELAY_BATCH_IDS)) {
      if (signal.aborted) break;
      const requestedIds = [carrying.id, ...targetBatch];
      let sampled: RelaySampleResult;
      try {
        sampled = await limit(() => adapters.sample(
          [relayUrl],
          { ids: requestedIds },
          RELAY_QUERY_TIMEOUT_MS,
          sampleBounds(requestedIds, signal),
        ));
      } catch (error) {
        report.failures.push({ relayUrl, stage: "relay-fetch", error: errorMessage(error) });
        continue;
      }
      if (sampled.errors.length > 0) {
        report.failures.push(...sampled.errors.map((failure) => ({
          relayUrl: failure.url,
          stage: "relay-fetch" as const,
          error: failure.error,
        })));
        continue;
      }

      const events = new Map(sampled.hits.map((hit) => [hit.event.id, hit.event]));
      const fetchedCarrying = events.get(carrying.id);
      const carryingVerified = !!fetchedCarrying && isSocialCarryingEvent(fetchedCarrying);
      const coinGenesis = new Map<string, { event: Event; coordinate: string }>();
      for (const targetNodeId of targetBatch) {
        const target = events.get(targetNodeId);
        if (!target || !verifyEvent(target)) continue;
        const state = states.get(targetNodeId)!;
        state.resolved = true;
        const coordinate = await verifiedCoinGenesisCoordinate(target);
        if (!coordinate) continue;
        // A structurally valid bare genesis is a pending Mint, not a terminal
        // non-Coin. Leave it unresolved until its same-key attestation lands.
        state.resolved = false;
        coinGenesis.set(targetNodeId, { event: target, coordinate });
      }
      const attestations = await fetchMinterAttestations(
        adapters,
        relayUrl,
        [...coinGenesis.values()].map((coin) => coin.event),
        signal,
        (urls, filter, timeout, bounds) =>
          limit(() => adapters.sample(urls, filter, timeout, bounds)),
      );
      const relayCoordinates = new Map<string, string[]>();
      for (const [targetNodeId, coin] of coinGenesis) {
        const state = states.get(targetNodeId)!;
        const coordinate = await verifiedCoinCoordinate(
          coin.event,
          attestations.get(targetNodeId) ?? [],
        );
        if (!coordinate) continue;
        state.resolved = true;
        state.validCoordinates.add(coordinate);
        if (!carryingVerified) continue;
        const ids = relayCoordinates.get(coordinate) ?? [];
        ids.push(targetNodeId);
        relayCoordinates.set(coordinate, ids);
      }

      await Promise.all([...relayCoordinates].map(async ([coordinate, ids]) => {
        if (await persistPointer(relayUrl, coordinate)) {
          for (const targetNodeId of ids) states.get(targetNodeId)!.pointerPublished = true;
        }
      }));
    }
  }));

  for (const [targetNodeId, state] of states) {
    if (state.validCoordinates.size > 0 && state.pointerPublished) continue;
    if (state.validCoordinates.size === 0 && state.resolved) continue;
    report.complete = false;
    report.failures.push({
      targetNodeId,
      stage: "target-missing",
      error: state.validCoordinates.size > 0
        ? "valid Coin citation has no successfully persisted public pointer"
        : "cited target and its minter attestation were not cryptographically resolved from a public relay",
    });
  }
  report.coordinates = [...coordinates].sort();
  deadline.dispose();
  return report;
}

/**
 * Read-side lookup. Raw DHT values are attacker-controlled; this function
 * returns only candidates re-fetched without relay authentication and proven
 * to carry a signed ordinary `q` edge to a valid Coin whose H matches.
 */
export async function discoverCoinCitations(
  phrase: string,
  options: RendezvousOperationOptions = {},
): Promise<VerifiedRendezvousCandidate[]> {
  const adapters = adaptersFor(options.adapters);
  const deadline = deadlineSignal(options.signal, DISCOVERY_DEADLINE_MS, "discovery");
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
    let nextRelay = 0;
    async function verifyNextRelays(): Promise<void> {
      while (nextRelay < relayGroups.length) {
        throwIfAborted(deadline.signal);
        const [relayUrl, pointers] = relayGroups[nextRelay++]!;
        const carryingIds = pointers.map((pointer) => pointer.eventId);
        const first = await adapters.sample(
          [relayUrl],
          { ids: carryingIds },
          RELAY_QUERY_TIMEOUT_MS,
          sampleBounds(carryingIds, deadline.signal),
        );
        if (first.errors.length > 0) continue;
        const carryingById = new Map(
          first.hits
            .map((hit) => hit.event)
            .filter(isSocialCarryingEvent)
            .map((event) => [event.id, event]),
        );
        const targetIds = new Set<string>();
        for (const pointer of pointers) {
          const carrying = carryingById.get(pointer.eventId);
          if (!carrying) continue;
          for (const targetNodeId of ordinaryCitationTargets(carrying)) {
            targetIds.add(targetNodeId);
          }
        }

        const verifiedTargets = new Map<string, Event>();
        const verifiedAttestations = new Map<string, Event[]>();
        for (const targetBatch of batches([...targetIds], MAX_RELAY_BATCH_IDS)) {
          throwIfAborted(deadline.signal);
          const second = await adapters.sample(
            [relayUrl],
            { ids: targetBatch },
            RELAY_QUERY_TIMEOUT_MS,
            sampleBounds(targetBatch, deadline.signal),
          );
          if (second.errors.length > 0) continue;
          const coinGenesis = new Map<string, Event>();
          for (const hit of second.hits) {
            if (await verifiedCoinGenesisCoordinate(hit.event) !== coordinate) continue;
            coinGenesis.set(hit.event.id, hit.event);
          }
          const attestations = await fetchMinterAttestations(
            adapters,
            relayUrl,
            [...coinGenesis.values()],
            deadline.signal,
          );
          for (const [targetNodeId, target] of coinGenesis) {
            if (
              await verifiedCoinCoordinate(
                target,
                attestations.get(targetNodeId) ?? [],
              ) !== coordinate
            ) continue;
            verifiedTargets.set(targetNodeId, target);
            verifiedAttestations.set(targetNodeId, attestations.get(targetNodeId) ?? []);
          }
        }
        for (const pointer of pointers) {
          const carrying = carryingById.get(pointer.eventId);
          if (!carrying) continue;
          const candidate = await verifiedCandidateFromEvents(
            pointer,
            carrying,
            verifiedTargets,
            coordinate,
            verifiedAttestations,
          );
          if (candidate) verified.push(candidate);
        }
      }
    }
    await Promise.all(
      Array.from(
        { length: Math.min(MAX_CONCURRENT_RELAY_VERIFICATIONS, relayGroups.length) },
        () => verifyNextRelays(),
      ),
    );
    throwIfAborted(deadline.signal);
    const byEvent = new Map<string, VerifiedRendezvousCandidate>();
    for (const candidate of verified) {
      const existing = byEvent.get(candidate.eventId);
      if (!existing) {
        byEvent.set(candidate.eventId, candidate);
        continue;
      }
      const relayUrls = [...new Set([...existing.relayUrls, ...candidate.relayUrls])].sort();
      const targetNodeIds = [
        ...new Set([...existing.targetNodeIds, ...candidate.targetNodeIds]),
      ].sort();
      byEvent.set(candidate.eventId, {
        ...existing,
        relayUrl: relayUrls[0]!,
        targetNodeId: targetNodeIds[0]!,
        relayUrls,
        targetNodeIds,
      });
    }
    return [...byEvent.values()].sort((a, b) =>
      a.signerPubkey.localeCompare(b.signerPubkey) || a.eventId.localeCompare(b.eventId)
    );
  } finally {
    deadline.dispose();
  }
}

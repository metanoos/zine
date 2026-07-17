import type { Event } from "nostr-tools";
import { verifyEvent } from "nostr-tools/pure";

import {
  eventMeta,
  resolveTraceChainAtHead,
  sampleRelays,
  sha256HexLocal,
} from "./provenance.js";
import { parseTraceLocator, type TraceLocator } from "./trace-locator.js";

export interface OpenedTraceStep {
  event: Event;
  action: string;
  steppedAtMs: number | null;
  snapshot: string;
  contentHash: string | null;
  payload: Record<string, unknown>;
}

export interface OpenedTrace {
  locator: TraceLocator;
  steps: OpenedTraceStep[];
  historyComplete: boolean;
}

export type TraceLocatorEventLoader = (ids: readonly string[]) => Promise<Event[]>;

async function parseStep(event: Event): Promise<OpenedTraceStep> {
  let payload: Record<string, unknown>;
  try {
    const parsed = JSON.parse(event.content) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("payload is not an object");
    }
    payload = parsed as Record<string, unknown>;
  } catch {
    throw new Error(`trace node ${event.id} has malformed JSON content`);
  }
  if (typeof payload.snapshot !== "string") {
    throw new Error(`trace node ${event.id} has no file snapshot`);
  }
  if (typeof payload.contentHash !== "string") {
    throw new Error(`trace node ${event.id} has no snapshot content hash`);
  }
  if (await sha256HexLocal(payload.snapshot) !== payload.contentHash) {
    throw new Error(`trace node ${event.id} has a snapshot hash mismatch`);
  }
  const meta = eventMeta(event);
  return {
    event,
    action: meta.action ?? "unspecified",
    steppedAtMs: Number.isFinite(meta.steppedAtMs) ? meta.steppedAtMs : null,
    snapshot: payload.snapshot,
    contentHash: payload.contentHash,
    payload,
  };
}

async function defaultLoader(locator: TraceLocator, ids: readonly string[]): Promise<Event[]> {
  const { hits } = await sampleRelays(
    locator.relayHints,
    { kinds: [4290], ids: [...new Set(ids)] },
    4_000,
  );
  return hits.map((hit) => hit.event);
}

function verifyLocatedEvent(event: Event, locator: TraceLocator): void {
  if (!verifyEvent({
    id: event.id,
    pubkey: event.pubkey,
    created_at: event.created_at,
    kind: event.kind,
    tags: event.tags.map((tag) => [...tag]),
    content: event.content,
    sig: event.sig,
  })) {
    throw new Error(`trace node ${event.id} has an invalid id or signature`);
  }
  if (event.pubkey !== locator.ownerPubkey) {
    throw new Error(`trace node ${event.id} is signed by an unexpected owner`);
  }
  const reifications = event.tags.filter((tag) => tag[0] === "z");
  if (
    event.kind !== 4290 ||
    reifications.length !== 1 ||
    reifications[0]?.[1] !== "file"
  ) {
    throw new Error(`trace node ${event.id} is not a file TraceNode`);
  }
}

function verifyNucleus(event: Event, locator: TraceLocator): void {
  const meta = eventMeta(event);
  if (event.id !== locator.nodeId) throw new Error("trace locator resolved the wrong nucleus");
  if (meta.folderId !== locator.rootId) throw new Error("trace locator Root does not match the nucleus");
  if (meta.relativePath !== locator.relativePath) {
    throw new Error("trace locator path does not match the nucleus");
  }
}

/** Fetch and verify the exact single-file nucleus named by a headless locator.
 * Its complete history is shown when available, but is not required: Send
 * deliberately publishes only the selected node and may keep ancestry private.
 * No event is imported into the desktop Root and no new trace is minted. */
export async function openTraceLocator(
  input: string | TraceLocator,
  loadEvents?: TraceLocatorEventLoader,
): Promise<OpenedTrace> {
  const locator = typeof input === "string" ? parseTraceLocator(input) : input;
  const loader = loadEvents ?? ((ids) => defaultLoader(locator, ids));
  const exact = (await loader([locator.nodeId])).find((event) => event.id === locator.nodeId);
  if (!exact) throw new Error("could not fetch the trace locator nucleus");
  verifyLocatedEvent(exact, locator);
  verifyNucleus(exact, locator);

  const resolution = await resolveTraceChainAtHead(locator.traceId, locator.nodeId, loader);
  if (resolution.status !== "resolved") {
    return { locator, steps: [await parseStep(exact)], historyComplete: false };
  }
  for (const event of resolution.chain) {
    verifyLocatedEvent(event, locator);
  }
  const head = resolution.chain[resolution.chain.length - 1]!;
  verifyNucleus(head, locator);
  return {
    locator,
    steps: await Promise.all(resolution.chain.map(parseStep)),
    historyComplete: true,
  };
}

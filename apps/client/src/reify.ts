import type { Event } from "nostr-tools";
import { verifyEvent } from "nostr-tools/pure";

const TRACE_NODE_KIND = 4290;

export interface ReifyTarget {
  relativePath: string;
  nucleusId: string;
}

export interface ReifyTraceTarget {
  relativePath: string;
  traceId: string;
  nucleusId: string;
  eventIds: string[];
}

/**
 * Portable application-level container for raw signed protocol events.
 *
 * This does not introduce another trace wire shape: every member of `events`
 * is the original Nostr event, unchanged. The target index only maps ordinary
 * exported paths to the exact nucleus and ancestry that materialized them.
 */
export interface ReifyTraceBundle {
  format: "zine-trace";
  version: 1;
  targets: ReifyTraceTarget[];
  events: Event[];
}

export interface ReifyExport {
  entries: { relativePath: string; content: string }[];
  trace?: ReifyTraceBundle;
}

export type ReifyEventLoader = (nodeId: string) => Promise<Event | null>;

interface ParsedFileNode {
  event: Event;
  snapshot: string;
}

async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 12)}…` : id;
}

function markdownCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function markdownCode(value: string): string {
  return value.replace(/`/g, "\\`");
}

function eventAction(event: Event): string {
  return event.tags.find((tag) => tag[0] === "action")?.[1] ?? "unspecified";
}

function eventContentHash(event: Event): string {
  try {
    const parsed = JSON.parse(event.content) as { contentHash?: unknown };
    return typeof parsed.contentHash === "string" ? parsed.contentHash : "unavailable";
  } catch {
    return "unavailable";
  }
}

/** Verify a field-only copy so a library verification cache attached to an
 * Event object cannot survive later mutation of that object. */
function verifyRawEvent(event: Event): boolean {
  return verifyEvent({
    id: event.id,
    pubkey: event.pubkey,
    created_at: event.created_at,
    kind: event.kind,
    tags: event.tags.map((tag) => [...tag]),
    content: event.content,
    sig: event.sig,
  });
}

async function loadFileNode(
  nodeId: string,
  loadEvent: ReifyEventLoader,
): Promise<ParsedFileNode> {
  const event = await loadEvent(nodeId);
  if (!event || event.id !== nodeId) {
    throw new Error(`Reify could not fetch nucleus ${shortId(nodeId)}`);
  }
  if (!verifyRawEvent(event)) {
    throw new Error(`Reify refused nucleus ${shortId(nodeId)}: invalid id or signature`);
  }
  if (
    event.kind !== TRACE_NODE_KIND ||
    event.tags.filter((tag) => tag[0] === "z").length !== 1 ||
    event.tags.find((tag) => tag[0] === "z")?.[1] !== "file"
  ) {
    throw new Error(`Reify refused nucleus ${shortId(nodeId)}: not a file TraceNode`);
  }

  let parsed: { snapshot?: unknown; contentHash?: unknown };
  try {
    parsed = JSON.parse(event.content) as typeof parsed;
  } catch {
    throw new Error(`Reify refused nucleus ${shortId(nodeId)}: malformed event content`);
  }
  if (typeof parsed.snapshot !== "string" || typeof parsed.contentHash !== "string") {
    throw new Error(`Reify refused nucleus ${shortId(nodeId)}: missing snapshot or content hash`);
  }
  const actualHash = await sha256Hex(parsed.snapshot);
  if (actualHash !== parsed.contentHash) {
    throw new Error(`Reify refused nucleus ${shortId(nodeId)}: snapshot hash mismatch`);
  }
  return { event, snapshot: parsed.snapshot };
}

/** Walk one exact immutable nucleus back through `prev`, newest to genesis. */
async function loadExactChain(
  nucleus: ParsedFileNode,
  loadEvent: ReifyEventLoader,
): Promise<ParsedFileNode[]> {
  const newestFirst = [nucleus];
  const seen = new Set<string>([nucleus.event.id]);
  let cursor = nucleus.event.tags.find(
    (tag) => tag[0] === "e" && tag[3] === "prev",
  )?.[1];

  while (cursor) {
    if (seen.has(cursor)) {
      throw new Error(`Reify refused nucleus ${shortId(nucleus.event.id)}: cyclic prev chain`);
    }
    seen.add(cursor);
    const previous = await loadFileNode(cursor, loadEvent);
    if (previous.event.pubkey !== nucleus.event.pubkey) {
      throw new Error(
        `Reify refused nucleus ${shortId(nucleus.event.id)}: prev chain changes owner`,
      );
    }
    newestFirst.push(previous);
    cursor = previous.event.tags.find(
      (tag) => tag[0] === "e" && tag[3] === "prev",
    )?.[1];
  }
  return newestFirst.reverse();
}

/**
 * Materialize exact signed nuclei. Live editor text is deliberately absent
 * from this API, so callers cannot accidentally substitute an unstepped
 * buffer for the authoritative snapshot carried by the chosen event.
 */
export async function prepareReifyExport(
  targets: readonly ReifyTarget[],
  loadEvent: ReifyEventLoader,
  includeTrace = false,
): Promise<ReifyExport> {
  const seenPaths = new Set<string>();
  for (const target of targets) {
    if (!target.relativePath || seenPaths.has(target.relativePath)) {
      throw new Error(`Reify needs unique, non-empty output paths`);
    }
    if (!target.nucleusId) {
      throw new Error(`${target.relativePath} has no Step to reify`);
    }
    seenPaths.add(target.relativePath);
  }

  const materialized = await Promise.all(
    targets.map(async (target) => {
      const nucleus = await loadFileNode(target.nucleusId, loadEvent);
      const chain = includeTrace
        ? await loadExactChain(nucleus, loadEvent)
        : [nucleus];
      return { target, nucleus, chain };
    }),
  );

  const entries = materialized.map(({ target, nucleus }) => ({
    relativePath: target.relativePath,
    content: nucleus.snapshot,
  }));
  if (!includeTrace) return { entries };

  const eventsById = new Map<string, Event>();
  const traceTargets = materialized.map(({ target, chain }) => {
    for (const node of chain) eventsById.set(node.event.id, node.event);
    return {
      relativePath: target.relativePath,
      traceId: chain[0].event.id,
      nucleusId: target.nucleusId,
      eventIds: chain.map((node) => node.event.id),
    };
  });
  return {
    entries,
    trace: {
      format: "zine-trace",
      version: 1,
      targets: traceTargets,
      events: [...eventsById.values()],
    },
  };
}

/** Human-readable projection. Raw events in the bundle remain authoritative. */
export function renderTraceReport(bundle: ReifyTraceBundle): string {
  const byId = new Map(bundle.events.map((event) => [event.id, event]));
  const summaryRows = bundle.targets.map((target) => {
    const nucleus = byId.get(target.nucleusId);
    const stepped = nucleus
      ? new Date(nucleus.created_at * 1000).toISOString()
      : "unavailable";
    return `| ${markdownCell(target.relativePath)} | \`${shortId(target.nucleusId)}\` | \`${shortId(nucleus?.pubkey ?? "unavailable")}\` | ${target.eventIds.length} | ${stepped} |`;
  });
  const traceSections = bundle.targets.flatMap((target) => {
    const stepRows = target.eventIds.map((eventId, index) => {
      const event = byId.get(eventId);
      if (!event) {
        return `| ${index} | \`${shortId(eventId)}\` | unavailable | unavailable | unavailable | unavailable |`;
      }
      return `| ${index} | \`${shortId(event.id)}\` | \`${shortId(event.pubkey)}\` | ${markdownCell(eventAction(event))} | ${new Date(event.created_at * 1000).toISOString()} | \`${shortId(eventContentHash(event))}\` |`;
    });
    return [
      `## \`${markdownCode(target.relativePath)}\``,
      "",
      `Trace identity: \`${target.traceId}\`  `,
      `Chosen nucleus: \`${target.nucleusId}\``,
      "",
      "| Step | Event | Signer | Action | Time (declared) | Snapshot hash |",
      "|---:|---|---|---|---|---|",
      ...stepRows,
      "",
    ];
  });

  return [
    "# Zine Trace Report",
    "",
    "This is a readable projection of `.zine/trace.json`. The raw signed events are authoritative; this report is not a substitute for signature, id, snapshot-hash, or lineage verification.",
    "",
    "| File | Nucleus | Signer | Steps included | Nucleus time (declared) |",
    "|---|---|---|---:|---|",
    ...summaryRows,
    "",
    ...traceSections,
    "",
    "The exported ordinary files contain only the chosen nuclei's snapshots. Provenance is kept separate so it cannot change those files' content hashes.",
    "",
  ].join("\n");
}

export function traceSidecarEntries(
  bundle: ReifyTraceBundle,
): { relativePath: string; content: string }[] {
  return [
    {
      relativePath: ".zine/trace.json",
      content: `${JSON.stringify(bundle, null, 2)}\n`,
    },
    {
      relativePath: ".zine/report.md",
      content: renderTraceReport(bundle),
    },
  ];
}

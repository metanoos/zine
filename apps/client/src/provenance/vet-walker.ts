/**
 * Vet chain-walker — extracts CheckpointMeta from real trace events.
 *
 * The bridge between the wire (kind-4290 TraceNode events on a chain) and the
 * pure vet signals in vet.ts. Walks a chain of events, reads each node's
 * steppedAt + deltas + OTS anchor presence, and produces the CheckpointMeta[]
 * that vetTrace consumes.
 *
 * Pure — no IO. Takes events as input (already fetched by whatever relay path
 * the caller has). The anchor-presence check is a filter query against a set
 * of anchored event ids (the caller fetches kind-1040 events separately and
 * passes the set of attested ids — this keeps the walker relay-free).
 */

import type { Event } from "nostr-tools";

import { eventMeta } from "./provenance.js";
import type { CheckpointMeta } from "./vet.js";

/** A parsed body-edit delta (the shape publishEdit emits in the content JSON). */
interface BodyEditDelta {
  type: "insert" | "delete" | "replace";
  position: {
    start: number;
    end: number;
  };
  newValue: string | null;
}

/** Parsed TraceNode content (the JSON payload inside event.content). */
interface TraceNodeContent {
  steppedAt?: number;
  deltas?: unknown[];
}

/** Extract CheckpointMeta[] from a chain of kind-4290 events.
 *
 *  @param chain  The trace's events (any order — sorted by steppedAt internally).
 *  @param anchoredIds  A Set of event ids that carry a valid OTS anchor
 *                       (kind-1040 proof resolved to a Bitcoin block). The caller
 *                       obtains this by querying their own kind-1040 events.
 *                       Empty set = no anchors known (all checkpoints score
 *                       unstamped — the safe default).
 *
 *  Each checkpoint gets:
 *  - steppedAtMs: from eventMeta (steppedAt in content, falling back to created_at)
 *  - anchored: true if the event's id is in anchoredIds
 *  - charDelta: net chars changed (sum of newValue.length - region length across
 *    body-edit deltas). Positive = insert-heavy, negative = delete-heavy.
 *  - deltaCount: number of body-edit deltas (complexity signal). */
export function checkpointsFromChain(
  chain: Event[],
  anchoredIds: Set<string> = new Set(),
): CheckpointMeta[] {
  const metas = chain.map((ev) => {
    const meta = eventMeta(ev);
    let charDelta = 0;
    let deltaCount = 0;
    try {
      const parsed = JSON.parse(ev.content) as TraceNodeContent;
      if (Array.isArray(parsed.deltas)) {
        for (const d of parsed.deltas) {
          if (isBodyEdit(d)) {
            const regionLen = d.position.end - d.position.start;
            const insertedLen = d.newValue?.length ?? 0;
            charDelta += insertedLen - regionLen;
            deltaCount++;
          }
        }
      }
    } catch {
      // malformed/non-JSON content — no delta info extractable
    }
    return {
      steppedAtMs: meta.steppedAtMs,
      anchored: anchoredIds.has(ev.id) || undefined,
      charDelta,
      deltaCount,
    } satisfies CheckpointMeta;
  });

  // Sort oldest-first so timing intervals are chronological.
  return metas.sort((a, b) => a.steppedAtMs - b.steppedAtMs);
}

/** Type guard for body-edit deltas (insert/delete/replace with position). */
function isBodyEdit(d: unknown): d is BodyEditDelta {
  if (!d || typeof d !== "object") return false;
  const obj = d as Record<string, unknown>;
  return (
    (obj.type === "insert" || obj.type === "delete" || obj.type === "replace") &&
    !!obj.position &&
    typeof obj.position === "object" &&
    typeof (obj.position as Record<string, unknown>).start === "number" &&
    typeof (obj.position as Record<string, unknown>).end === "number"
  );
}

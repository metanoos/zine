/** A folder attached for tracing. Purely local bookkeeping (which paths on
 * this machine are watched) — not itself a relay/provenance concept, so it
 * lives in the local registry, not as a Nostr event. */
export interface AttachedFolder {
  id: string;
  path: string;
  attachedAt: number;
}

/** A file's current tracked state, as read from its folder's manifest event.
 * Identity is (folderId, relativePath) — there's no synthetic file id
 * anymore, since real trace nodes are tagged directly with folder+file. */
export interface WatchedFile {
  folderId: string;
  relativePath: string;
  absolutePath: string;
  latestNodeId: string | null;
  isDeleted: boolean;
}

export type Action =
  | 'import'
  | 'edit'
  | 'paste'
  | 'quote'
  | 'embed'
  | 'llm'
  | 'merge'
  | 'delete'
  | 'sign';

/** One sealed checkpoint for a file — a real signed Nostr event (kind 4290)
 * once published to the local relay. `id` is the event id. `sealedAt` is
 * the content-level ms-precision timestamp (the event's own `created_at`
 * is seconds-resolution, per NIP-01, so it's not precise enough to carry
 * rhythm data on its own). */
export interface TraceNode {
  id: string;
  prevNodeId: string | null;
  action: Action;
  sealedAt: number;
  contentHash: string;
  /** Present only on action: "llm" nodes. */
  prompt: string | null;
  /** Optional short human-readable description of this node (spec: `summary`).
   * Currently used to record pin-enforcement outcomes ("pins: 2 survived, 1
   * restored"). Null when the producer had nothing to say. */
  summary: string | null;
}

export type DeltaType = 'insert' | 'delete' | 'replace';

/** A raw positional edit span, as produced by diffing two snapshots — no
 * timestamp yet, since a diff alone can't know when within its window each
 * span happened. */
export interface DeltaSpan {
  type: DeltaType;
  positionStart: number;
  positionEnd: number;
  oldValue: string | null;
  newValue: string | null;
}

/** A delta as persisted: a span plus the epoch-ms moment it happened. For
 * diff-sourced spans this is the enclosing node's sealedAt (all spans in
 * one diff share it, honestly, since that's all a snapshot diff can know);
 * an in-app editor recording real edit operations would give each delta
 * its own genuine timestamp instead. */
export interface DeltaRecord extends DeltaSpan {
  timestamp: number;
}

export interface TraceNodeWithDeltas {
  node: TraceNode;
  deltas: DeltaRecord[];
}

/** One file's entry in its folder's manifest (kind 34290 content). Deleted
 * files stay listed with isDeleted: true rather than being dropped, so a
 * file that reappears can be relinked to its prior history instead of
 * starting a disconnected new chain. */
export interface ManifestFileEntry {
  relativePath: string;
  latestNodeId: string;
  isDeleted: boolean;
  contentHash: string;
}

/** A folder attached for tracing. Purely local bookkeeping (which paths on
 * this machine are watched) — not itself a relay/provenance concept, so it
 * lives in the local registry, not as a Nostr event. */
export interface AttachedFolder {
  id: string;
  path: string;
  attachedAt: number;
}

/** A file's current tracked state, as read from its folder's FolderTraceNode
 * (kind 4292) membership snapshot. Identity is (folderId, relativePath) —
 * there's no synthetic file id anymore, since real trace nodes are tagged
 * directly with folder+file. `isDeleted` is always false in the 4292 path
 * (deleted files leave the snapshot); it stays on the shape for legacy
 * callers and the 34290 fallback read.
 *
 * Under nesting (spec §3.2), `folderId` is the IMMEDIATE folder trace (the
 * leaf), and `relativePath` is the single-segment leaf name (no slash). The
 * slash-joined tree coordinate lives in `displayPath` — reconstructed by
 * `listFiles`/`collectFiles` from the folder-member descent. Provenance ops
 * (`fetchChain`, `recordSnapshot`, `timelineForFile`, `reconstructContent`)
 * consume `folderId` + `relativePath`; display/listing consumers use
 * `displayPath`. For a top-level file, `displayPath === relativePath`. */
export interface WatchedFile {
  folderId: string;
  relativePath: string;
  /** Slash-joined tree coordinate (e.g. 'blog/draft.md'). Equal to
   *  `relativePath` for a top-level file. This is a display/reconstruction
   *  field, NOT a provenance coordinate — provenance is (folderId, relativePath). */
  displayPath: string;
  absolutePath: string;
  latestNodeId: string | null;
  isDeleted: boolean;
}

// Action values per protocol §3.4 precedence list:
//   sign > merge > fork > delete > llm > import > cite > paste > edit > focus
// `quote`/`embed` are retired (collapsed into `cite` per §R11.5).
export type Action =
  | 'import'
  | 'edit'
  | 'paste'
  | 'llm'
  | 'merge'
  | 'fork'
  | 'cite'
  | 'delete'
  | 'affirm'
  | 'focus';

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
   * Currently used to record bracket-enforcement outcomes ("brackets: 2
   * survived, 1 restored"). Null when the producer had nothing to say. */
  summary: string | null;
}

export type DeltaType = 'insert' | 'delete' | 'replace';

/** A raw positional edit span, as produced by diffing two snapshots — no
 * timestamp yet, since a diff alone can't know when within its window each
 * span happened. Carries no `oldValue` (protocol §3.3): the old text is
 * recoverable as `prev.snapshot.slice(start, end)` and `applyDeltas` never
 * reads it. */
export interface DeltaSpan {
  type: DeltaType;
  positionStart: number;
  positionEnd: number;
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

/** One file's entry in its folder's membership — the `snapshot.members` of a
 * kind-4292 FolderTraceNode. Under spec-clean tombstones, a deleted file leaves
 * the snapshot via a `remove` delta (see FolderDelta) rather than staying as an
 * isDeleted entry, so this type has no tombstone field. `isDeleted` is kept
 * optional purely so the legacy 34290 fallback read and the `WatchedFile` shape
 * still type-check during the migration; the 4292 path always omits it. */
export interface ManifestFileEntry {
  /** "file" or "folder". Absent on legacy entries (pre-nesting) — readers
   *  default "file", the only member kind before this revision (spec §3.2). */
  kind?: 'file' | 'folder';
  relativePath: string;
  latestNodeId: string;
  contentHash: string;
  /** Always absent from the 4292 path. Optional only so the legacy 34290
   *  fallback read and `WatchedFile` still type-check during the migration;
   *  treat as false if present. */
  isDeleted?: boolean;
}

/** The selection recorded by a `focus` folder delta (protocol §FolderTraceNode
 *  Content — focus selection payload). Mirrors the protocol's three reifications:
 *  a file, a folder, or a minted span (a quotation living inside a file). */
export type FocusSelection =
  | { kind: 'file'; path: string; nodeId?: string }
  | { kind: 'folder'; path: string; nodeId?: string }
  | { kind: 'span'; nodeId: string; phrase: string; originPath: string };

/** A single change since `prev.snapshot` on a FolderTraceNode (protocol §3.3).
 *  Membership deltas (`add`/`remove`/`rename`) are the three structural facts a
 *  folder asserts about its members: a member appeared, a member left, a member
 *  moved to a new path. There is no `reorder` — ordering is fully recoverable
 *  from `snapshot.members` (the §2 canonical projection *is* the ordered list),
 *  so a dedicated ordering delta would carry no information the snapshot didn't.
 *  `remove` is how spec-clean tombstones are expressed — the member leaves the
 *  snapshot, so a later re-add relinks to the file's own chain head rather than
 *  reading an isDeleted entry. `rename` carries `fromPath`/`toPath` so one user
 *  gesture is one replayable event (the pre-rename path decomposed into add+
 *  remove, which orphaned the file's history from its new path). It is the
 *  structural path axis — folder-owned addressing — explicitly distinct from
 *  `TraceOpinion`'s display `name` (§5/§R6), which is author-scoped and
 *  deliberately history-less.
 *
 *  `focus` is an observation, not membership: it records panel occupancy
 *  (`op: 'mount'` = a trace entered a panel; `op: 'unmount'` = the trace that was
 *  there left), so a reading session can be replayed in the press editor.
 *  `op` defaults to `'mount'` and MAY be omitted. A `focus` node re-emits the
 *  *same* `snapshot.members` as `prev` — `contentHash` is unaffected. */
export type FolderDelta =
  | { type: 'add' | 'remove'; kind?: 'file' | 'folder'; relativePath: string; nodeId?: string; timestamp: number }
  | { type: 'rename'; kind?: 'file' | 'folder'; fromPath: string; toPath: string; nodeId: string; timestamp: number }
  | { type: 'focus'; op?: 'mount' | 'unmount'; selection: FocusSelection; panelIndex: number; timestamp: number };

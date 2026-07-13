# Trace Provenance Protocol (draft)

Status: draft, unpublished, breaking changes expected. Kind numbers below are provisional.

## Goal

Files and folders are traced as Nostr events, so any traced document can quote or import an exact version of another — across files, folders, relays — with the reference pinned to an immutable snapshot. Composability is the point; deltas, actions, and timestamps exist to support it and to drive writer-facing analytics (rewrite counts, edit rhythm, fixed-vs-fluid ratio).

Wire format only. Storage/retention policy, relay operator controls, and client UX are layered on top and marked non-normative where they appear here.

## Why FileTraceNode isn't replaceable

An earlier draft put it at kind `31234` (parameterized-replaceable, `30000`–`39999`). A relay is entitled to keep only the latest event per `(kind, pubkey, d-tag)`; relying on fresh `d` values never colliding to protect immutable history is fragile. Fixed: `FileTraceNode` is a regular event, no `d` tag — the event id, assigned at signing, is the node's identity.

`FolderManifest` is the one thing here that legitimately wants replaceable semantics ("current folder state," recoverable from the nodes underneath), so it keeps a kind in that range.

## Event kinds

| Kind (provisional) | Name | Replaceable? |
|---|---|---|
| `4290` | `FileTraceNode` | No |
| `34290` | `FolderManifest` | Yes, `d = folderId` |

## FileTraceNode

One sealed checkpoint for one file — or one hardened span, see Composability — at a save/seal boundary.

### Tags

| Tag | Meaning |
|---|---|
| `["file", relativePath]` | Path relative to the owning folder. Human-readable, not guaranteed filterable — multi-letter tag name, see `F`/`D` below. |
| `["folder", folderId]` | Owning folder's id, matches a `FolderManifest`'s `d`. |
| `["F", relativePath]` | Single-letter mirror of `file`. `#<tag>` filters are only guaranteed to work on single-letter names — this is what queries actually use. |
| `["D", folderId]` | Single-letter mirror of `folder`, same reason. |
| `["e", prevEventId, relayHint, "prev"]` | Node this one supersedes. Absent only on genesis. |
| `["e", parentEventId, relayHint, "merge-parent"]` | Zero or more, `action: merge` only — one per branch reconciled. |
| `["e", originEventId, relayHint, "extracted-from"]` | Optional, hardened-span nodes only — the node this span was pulled out of. |
| `["q", sourceEventId, relayHint, sourcePubkey]` | Zero or more. Cites a hardened node this one quotes or embeds. NIP-18 quote-tag shape. |
| `["action", actionType]` | See Action types. |
| `["actor", pubkey]` | Present when a non-human contributor needs distinguishing from the signer (see `contributors`). |

### Content

```json
{
  "snapshot": "…",
  "deltas": [
    {
      "type": "insert | delete | replace | quote",
      "position": { "start": 42, "end": 42 },
      "newValue": "…",
      "sourceEventId": "…",
      "sourceContentHash": "sha256:…",
      "timestamp": 1730000000000
    }
  ],
  "contentHash": "sha256:…",
  "summary": "optional",
  "prompt": "action: llm only",
  "contributors": [ { "type": "human | llm | agent", "pubkey": "…" } ]
}
```

- `snapshot` — full resulting content. Present on every node this protocol seals (see Save/seal triggers for why that's affordable unconditionally, not a per-node space tradeoff). O(1) read, integrity anchor.
- `deltas` — optional. Positional, computed against `prev.snapshot`; applying them in order reproduces `snapshot` exactly (see Integrity). No `oldValue` field — recoverable as `prev.snapshot.slice(start, end)`, and `applyDeltas` never reads it anyway. Absent on genesis, on any node whose producer has nothing to say about *how* it arrived, or one that's shed its log under retention.
- `deltas[].type: "quote"` — `newValue` came from a hardened node, not typing. `sourceEventId` must also appear as a top-level `q` tag. `sourceContentHash`, if present, is the hash of the cited span as it appears in the source — lets a verifier catch a wrong or fabricated citation without reconstructing the source (see Composability).
- `contentHash` = `hash(snapshot)`. O(content), no replay — already how no-op-touch detection works in the current harness.

### Integrity

For any non-genesis node: `applyDeltas(prev.snapshot, deltas) === snapshot`, checkable against a single prior node — not the whole chain.

- **Cheap:** `hash(snapshot) === contentHash`.
- **Full:** apply `deltas` to `prev.snapshot`, compare to `snapshot`. O(content), independent of chain depth — a delta-only history can't offer this, since verifying node N there means replaying from genesis through N.

### Action types

| Action | Meaning | Required tags |
|---|---|---|
| `import` | Genesis — first-observed content, or a span just hardened into its own node | none |
| `edit` | Ordinary change | `e...prev` |
| `paste` | Pasted content, possibly itself hardened elsewhere | `e...prev`, `q` if sourced |
| `quote` | Primary purpose is inserting a pinned citation | `e...prev`, `q` |
| `embed` | Live wikilink/transclusion — tracks its source, not frozen | `e...prev`, `q` |
| `llm` | Checkpoint around an LLM call | `e...prev`, `prompt` |
| `merge` | Reconciles concurrent edits | `e...merge-parent` × N |
| `delete` | File removed, history retained | `e...prev` |
| `sign` | Affirms current manifest/node, e.g. publication | `e...prev` or manifest ref; deferred |

`[[ ]]` bracket syntax (see Composability) is the concrete authoring surface for `quote`: hardening a span always produces `action: import` on the new node and `action: quote` on the citing delta, never `embed` — a live-tracking reference is a distinct, not-yet-specified use of the same tags.

## FolderManifest

Current file set for a folder. Replaceable, `d = folderId`.

### Tags

| Tag | Meaning |
|---|---|
| `["d", folderId]` | Replaceable-event key |
| `["e", latestFileNodeId]` | One per file currently in the folder |

### Content

```json
{ "files": [ { "relativePath": "essay.md", "latestNodeId": "…" } ] }
```

Derived, not authored directly — republished whenever any file in the folder seals a node.

**`created_at` must be forced strictly forward, not read off the clock.** NIP-33 ties break on event id, effectively random with respect to publish order — two manifest publishes landing in the same wall-clock second (an import right after an edit, two quick saves) can leave the relay holding the older manifest. Every publish sets `created_at = max(now_seconds, prevManifest.created_at + 1)`, which means reading the previous manifest event, not just its parsed content, before republishing. `FileTraceNode` doesn't have this problem — order comes from the `e...prev` chain, never from `created_at`.

**Cache, not sole index.** Every node is self-sufficient (`snapshot`), so losing the manifest degrades "find the latest version" from a lookup to a scan (`#F`/`#D`-tagged nodes, find ones no other node cites as `prev`) rather than stranding content. Unsolved: multiple uncited candidates — a fork, concurrent writers — have no tie-break rule yet beyond preferring an `action: sign` node when one exists. See Open questions.

## Composability

Two primitives. **Hardening** turns a bracketed span — in any tracked document — into its own permanently addressable node. **Citing** references a hardened node's id, from the same document or any other. Cross-document quoting and same-document "this paragraph is done, don't touch it" are the same mechanism; the only difference is whose document the bracket started in.

### Bracket syntax

```
[[ some phrase ]]              unresolved — protected from the next rewrite pass, not yet a node
[[ some phrase | eventId ]]    resolved — hardened, permanently addressable, frozen
```

Everything outside brackets is fluid by default — fair game for a rewrite. A bare bracket pauses that locally: if you delete the paragraph, brackets and all, nothing persists, no node was ever minted. Resolving it is what makes it survive independent of the document around it.

### Hardening

A hardening pass — client- or CLI-triggered — scans a document for unresolved brackets and, for each:

1. Reads the current span text.
2. Seals a new `FileTraceNode`, `action: import`, `snapshot` = that text, no `prev`. Path is synthetic (`<originDoc>#<spanId>`) in the same folder as the origin document, so it stays discoverable via a normal `#D` scan rather than needing an orphan-node category. Optionally tags `["e", originNodeId, "", "extracted-from"]`.
3. Rewrites the bracket in place to `[[ text | newNodeId ]]`. That edit is itself an ordinary delta on the origin document's next seal — `type: "quote"`, `sourceEventId: newNodeId`, mirrored as a top-level `q` tag.

Once resolved, a bracket's id is stable — later rounds cite the same node rather than re-minting one for unchanged fixed text. Hardening captures whatever's there *now* as a single fresh node; it doesn't reconstruct a pre-hardening edit history for that span.

### Citing

To quote or embed a hardened node from anywhere, write `[[ text | thatEventId ]]`, producing a `q` tag plus a `quote` (frozen) or `embed` (live) delta pointing at it. Because the reference is an immutable event id, it stays pinned to the exact version cited even as everything else changes; "is this stale" is just comparing `thatEventId` against whatever the source now resolves to.

### Resilience across edits

Bracket instances aren't durable objects the harness tracks through splits and merges — continuity falls out of the same diff every seal already computes, not a separate tracking layer.

On every seal, the harness has (or computes) `computeDeltas(oldContent, newContent)` — the ordinary insert/delete/replace span list that already drives `deltas`. A resolved bracket `[[ text | eventId ]]` at some position in `oldContent` **survives unedited** iff its old-content position range doesn't overlap any span in that list. That's the whole check: an interval-overlap test against data already being computed, not a new diffing pass and not a fetch of `eventId`'s source.

This gets split and merge for free, with no case-specific logic:

- **Split.** `[[ AB | id ]]` becomes `[[ A | id ]] [[ B | id ]]` because new content was inserted in the middle. Both `A`'s and `B`'s old-position ranges individually avoid every changed span, so both survive and both keep citing `id` — two citations now, same source, no new node.
- **Merge.** The gap between `[[ A | idA ]]` and `[[ B | idB ]]` is deleted so they read as one contiguous span. Each of `A` and `B` still individually avoids every changed span (only the gap between them was touched), so both survive as-is — still two citations, `idA` and `idB`, just textually adjacent now. No "multi-source" delta shape needed; `deltas` is already an array and citation is already per-span.
- **Destroyed.** Any edit whose changed-span range overlaps a bracket's position — reworded, blended with something else — fails the check. The `| eventId` suffix drops, the text reverts to fluid. The original node isn't touched or deleted, just no longer cited from here. Re-hardening mints a fresh node when the author's ready.

This only establishes **local continuity** — did this document's own previously-resolved content survive this document's own edit — and it's deliberately cheap: no network fetch, no dependency on whether `eventId` even resolves right now. It's a different concern from whether a citation was *honest to begin with*, which is what Verifying a citation (below) is for — that's fetch-based and reader-triggered, not something re-run on every seal. A citation that's survived every local edit since it was made can still be independently checked against its source whenever someone wants to, but resilience doesn't require doing that check continuously.

One deliberate asymmetry survives this reframe too: a *bare* `[[ text ]]` never gets auto-resolved by matching its text against some existing node by coincidence, even an exact one. Resolution only happens via an explicit hardening pass or an explicit paste of existing `[[ text | id ]]` syntax.

### Pins vs hardening (orthogonal, one-directional backing)

"Preserve this block" is two different questions that this protocol keeps distinct:

- **Hardening** (`[[ ]]`) preserves the **snapshot** — an immutable, signed, citable node. It does *not* preserve the live text: as above, an edit whose changed span overlaps a resolved bracket drops the `| eventId` suffix and reverts that span to fluid. The cited node is still recoverable; the live copy is not frozen. That is intentional — you harden a passage to quote it elsewhere, not to forbid improving the original.
- **Pinning** (non-normative; client/editor state, not a trace event) preserves the **live text** — a pinned span's canonical content wins over an agent rewrite, enforced after-the-fact by text-identity matching. It is unsigned and local today; the deferred `sign` action is the path to making a backed pin durable and composable.

The two are **orthogonal**: hardening a region does not pin it, and pinning a region does not harden it. Three real modes fall out — harden-only (recoverable+citable, live-editable), pin-only (live-protected, unrecoverable if a conflict is lost — today's behavior), harden+pin (both). Bundling them would break the normal harden-to-quote case, where the live original must stay editable.

**Backing is one-directional and optional:** a pin *may* be backed by a hardened node — so that if the agent wins a conflict and the live text is lost, the prior content still exists as a citable, recoverable node — but a hardened node is *not* inherently pinned (citing a frozen version ≠ forbidding edits to the live copy). Backing is strictly additive: it turns a destructive pin-loss into a recoverable one without changing pin-only behavior.

A pin's canonical text, when it overlaps a bracketed region, is the **inner content** — not the raw `[[ text | id ]]` markup. Text-identity matching (`restorePins` in the reference harness) locates the inner text inside the bracketed span, so enforcement works unchanged over hardened regions without the restore path needing to understand bracket syntax.

### Verifying a citation

A cited node carries its own `snapshot`, so confirming a quote is real is O(source snapshot), not O(source chain) — bounded and cacheable where it wasn't before. `sourceContentHash` sharpens it further: check the citing delta's `newValue` hashes to the claimed value (O(span), no fetch), then check that hash against the source's snapshot (one fetch) — a fabricated or stale citation is cheaply detectable without full reconstruction in the common case. Not trustless: a determined liar can still cite a real hash for text that isn't really at that position in their own document, so full verification still means reading the citing document too. But it's bounded and cacheable instead of requiring full reconstruction just to check.

## Save/seal triggers

A node is sealed — signed immediately, written to the local relay — at:

- **External write.** File changed outside the traced editor; deltas computed by diffing last-known content against disk.
- **Explicit checkpoint.** Client-facing "save" (e.g. Cmd+S), framed to read as deliberate, not autosave.
- **LLM invocation.** Sealed immediately (`action: llm`) with the prompt, before any write-back becomes its own subsequent node.
- **Hardening.** Each resolved bracket seals its own node (see Composability).
- **Publish/sign.** Pushes an already-sealed local node — or, for a folder, every file's latest node — to an external relay. Already signed at seal time; this step is about destination, not signature.

**Local vs. published is about destination, not signing.** Local storage is itself a relay, bound to 127.0.0.1 only; every event needs a valid signature to be accepted at all, so every trigger above signs immediately with the active local voice. What's opt-in is whether a sealed node ever leaves the machine.

**Every trigger above is discrete and bounded-frequency — none fire per-keystroke or continuously.** That's why `snapshot` can be unconditional rather than a space tradeoff: the high-frequency case (continuous typing) is handled entirely outside this protocol, as a raw, unsigned, non-eventful local buffer for crash recovery. This protocol only ever sees checkpoints a human or agent chose to make.

## Reconstruction

Every node has `snapshot` — reading content as of any node is O(1), no replay. `deltas` still matter for per-span provenance, edit-rhythm analytics, and as a fallback if a node has shed its snapshot under retention:

```
node = target
while node.snapshot is undefined: node = node.prev
content = node.snapshot
for n in chain(node.next … target): content = applyDeltas(content, n.deltas)
```

In the common case — every node has a snapshot — this loop never runs.

## Retention

`snapshot` is required on every node this protocol's own triggers produce; `deltas` isn't. So retention is one-directional: an old node can shed `deltas` to save space, keeping content fully readable via `snapshot`. Downstream integrity is unaffected — later nodes check their own deltas against *this* node's snapshot, never the reverse.

Left as operator/client policy, not a protocol requirement: recent nodes might keep full delta logs, older ones compress to snapshot-only, and a producer can ship snapshot-only from the start if a delta carries no meaningful provenance (a wholesale LLM rewrite with no citations, say).

## Client UX (non-normative)

- Bracket rendering is a display concern — raw `[[ ]]` stays in the file, so any external editor still sees valid plain text. The client can render resolved spans with distinct styling and hide the `| eventId` suffix.
- Pinning is a separate, orthogonal layer from hardening (see Pins vs hardening). A pinned region's decoration must be visually distinct from a hardened/cited one: pinning says "the agent's rewrite of this live span will be reverted," hardening says "this span's content exists as an immutable, citable node." The two can overlap on the same span; render them as independent layers, not as variants of one marker. A pin's canonical text is the inner content, not the surrounding bracket markup, so a pin over a hardened region is defined on what the reader sees, not on the raw `[[ ]]`.
- The "checkpoint" framing (Save/seal triggers) has to actually read as deliberate for unconditional snapshotting to be affordable: copy should say plainly that it's a signed, permanent event, distinct from continuous local autosave that never becomes one.
- A relative usage indicator — checkpoint weight vs. other files in the same folder, normalized per length rather than raw bytes — is planned but needs a defined peer population and a cold-start fallback (a single-file folder has no peers yet).

## Open questions (deferred)

- **Head disambiguation without a manifest.** Manifest-as-cache recovery can surface multiple uncited heads with no tie-break beyond "prefer a `sign` node if one exists."
- **Citing into unresolved/unpublished nodes.** Works mechanically — every node has a snapshot — but whether it should be encouraged, or restricted to signed/hardened nodes, is unsettled.
- **`sign` / zine publication.** Folder manifest + geohash + ≥1 signature isn't specified — revisit with the relay/operator layer.
- **Merge conflict resolution.** `merge` cites multiple parents; reconciling overlapping-span conflicts (last-writer-wins vs. manual vs. CRDT) isn't decided.
- **Relay-side validation policy.** Rejection rules (malformed content, missing required tags, unresolvable `q`) are relay-operator policy, but a reference policy should still ship with the relay.
- **Kind number registration.** `4290`/`34290` are placeholders.
- **Position-only deltas.** Non-citation deltas could carry two spans instead of `newValue` text, resolvable entirely from snapshots — near-zero marginal delta cost. Deferred for simplicity.
- **`sourceContentHash` granularity.** Span-level (specified here) vs. whole-snapshot-level, which would additionally let a verifier ask "is the source itself intact."
- **Module of trace-nodes.** A `q` tag cites a single hardened node; a folder manifest groups files. Neither expresses a *named set* of nodes — possibly across files — treated as one addressable unit (cite collectively, pin as a group, version together). This is an extension *of* hardening (a collection of hardened nodes), not a sibling mechanism. Whether it needs a new event kind or composes from existing tags is undecided; it surfaced from the pins-vs-hardening split and is not yet designed.

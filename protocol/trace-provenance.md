# Trace Provenance Protocol (draft)

Status: draft, unpublished, breaking changes expected. Kind numbers are provisional.

**Reading guide.** Part I is normative; RFC-2119 keywords bind implementations.
`transport.md` owns network identity, access, and reachability.
`rendezvous.md` owns quote discovery and process vetting. Part II records
non-binding rationale and design history. Deferred questions appear last.

## Vocabulary

A **trace** is the append-only chain of signed checkpoints belonging to one
stably identified body. Its body is either a **file** (text) or a **folder**
(an ordered membership list). A **zine** is that body together with its trace:
file zines and folder zines are the same protocol primitive at different
structural shapes. The press's **Root** is the topmost folder zine, not a
separate project object.

A **checkpoint** is any signed `TraceNode`. A **Step** is the deliberate author
gesture that creates an explicit checkpoint. Folder checkpoints created only
to advance a parent to a new direct-child head are **derived checkpoints**, not
additional deliberate Steps. Readers MUST preserve that distinction instead of
presenting one file Step as a stack of independent author gestures.

A **coin** is an immutable, single-node file trace. It is either **extracted**
from an exact span of another trace or minted **directly** as signer-authored
text with no source-trace claim. File describes its wire shape, not an editable
workspace file, so the reification discriminator remains
`z: "file" | "folder"` with no third value; the REQUIRED `content.coin`
envelope (§3.2) distinguishes a Coin genesis from mutable file traces. Mint is
complete only when that genesis and the same minter's `TraceAttestation` are
published (§3.8); an unfinished local genesis is a pending Mint attempt, not an
unpublished Coin.

A **press** is the authoring interface, not a server. A **relay** is the local
or remote Nostr server to which a press writes traces. Publication and
attestation change a zine's reachability and the signer's stance; neither is
what makes the underlying file or folder a zine. Running your own press means
writing in your own copy of the interface, backed by your own local relay.

Two identity terms recur throughout:

- **Trace identity** — the event id of the trace's **genesis node**, fixed for the trace's whole life. Globally unique with no separate namespace to manage. Folders have no other id: what an earlier draft called `folderId` *is* the folder trace's genesis node id.
- **Nucleus** — the trace's current head node: the latest node on the `e…prev` chain for a mutable trace, or the one fixed node of a coin. Citations pin a nucleus (a specific version); identity names the chain.

---

# Part I — Specification

## 1. Event kinds

| Kind (provisional) | Name | Class |
|---|---|---|
| `4290` | `TraceNode` | Regular (non-replaceable) |
| `34290` | `TraceHead` | Parameterized replaceable |
| `34291` | `TraceOpinion` | Parameterized replaceable |
| `4293` | `TraceAnnotation` (deferred — §11) | Regular (non-replaceable) |
| `4294` | `TraceAttestation` | Regular (non-replaceable) |

`TraceNode` chains are the **source of truth** and are never replaceable.
`TraceHead` and `TraceOpinion` carry current state, so last-write-wins is
intentional. `TraceAttestation` is an append-only speech act about one node,
not part of that node's revision chain (§5A). Losing a replaceable event never
loses trace history (§9). `TraceAnnotation` remains deferred (§11); its number
is reserved, not committed.

**Kind-number ranges (NIP-01).** Regular kinds use `1000-9999`; parameterized
replaceable kinds use `30000-39999`. This places regular `TraceNode`,
`TraceAnnotation`, and `TraceAttestation` in 4xxx, and replaceable `TraceHead`
and `TraceOpinion` in 34xxx. Kind `34292` already belongs to parameterized
replaceable Voice Identity (`d` = pubkey), so `TraceAnnotation` cannot use it.

## 2. Conventions

- **Hashes** are SHA-256, encoded as lowercase bare hex, in tags and content alike. No `sha256:` prefix anywhere.
- **Delta timestamps** are integer milliseconds since the Unix epoch.
- **Offsets and lengths** (delta positions, `authors[].len`) count UTF-16 code units of the snapshot string — JavaScript string-index semantics.
- **Ordering** always comes from the `e…prev` chain, never from `created_at` (NIP-01's second resolution is too coarse; see Part II §R2).
- **Canonical folder body** is
  `[[relativePath, kind, memberContentHash], …]` in member order, serialized as
  compact JSON and UTF-8 encoded. `kind` is `"file"` or `"folder"`. A file
  member's hash covers its snapshot; a folder member's hash is its stored
  canonical folder hash (§3.2). Hashing is **shallow-local**: an outer folder
  reads only its immediate members' stored hashes. `latestNodeId` is excluded,
  so independently built, content-identical folders hash identically (§R3).

## 3. TraceNode (kind `4290`)

One signed checkpoint of one zine's trace. Every node is self-sufficient: it
MUST carry its full `snapshot` (§3.2), so resolving any cited node is one
bounded fetch, never a chain replay. Every file node also carries the complete
node-local `kedits` transition needed to replay how its text moved from the
prior snapshot to this one. Not every checkpoint is an explicit Step: folder
nodes declare why they exist through `folderCheckpoint` (§3.2).

### 3.1 Tags

| Tag | Meaning |
|---|---|
| `["z", "file" \| "folder"]` | Reification discriminator. REQUIRED on every node. |
| `["f", folderGenesisId]` | The folder this trace resides in. REQUIRED on file nodes (coins included — they reside in the Press's dedicated Mint folder). On folder nodes it carries the folder's **own** genesis id and is REQUIRED on every node except genesis itself (an event cannot know its own id before signing). `#f=[id]` returns every node **directly** in a folder — the folder's own chain and its immediate members' nodes; `#z` splits them. A folder member's own members are NOT found transitively: reading a whole tree is bounded fan-out (one `#f` query per folder member, recursing by depth). |
| `["F", relativePath]` | Structural name for named file **and folder member** traces: the member's name within its immediate parent folder. Single-segment (no `/`) — hierarchy is expressed via folder-members, not slash-joined paths. Coins receive an automatic structural name (§3.8). Absent only on a folder's own genesis. |
| `["e", prevNodeId, relayHint, "prev"]` | Node this one supersedes. Absent only on genesis. |
| `["e", parentNodeId, relayHint, "merge-parent"]` | Zero or more, merge nodes only — one per branch reconciled. |
| `["e", originNodeId, relayHint, "extracted-from"]` | REQUIRED on **extracted** coins — mirrors `content.coin.origin.sourceNodeId` for relay-side fan-out queries. MUST be absent on direct coins, which make no source claim, and on whole-file genesis imports. |
| `["e", sourceNodeId, relayHint, "forked-from"]` | REQUIRED on fork-genesis nodes (§3.8) — the exact node-version the trace was seeded from. |
| `["x", bodyHashHex]` | Body hash (per §2). REQUIRED on coins and on folder nodes; OPTIONAL on named file nodes (open question). `#x` finds every trace with an identical body, whoever minted it. |
| `["q", nucleusId, relayHint, ownerPubkey]` | Out-edges: the traces this node composes. NIP-18 quote-tag shape. The list is the full **current** set of active out-edges — cumulative, not incremental. On folder nodes, one per member; **`q`-tag order MUST equal `snapshot.members` order** — member ordering is stated once, in two places that MUST agree. |
| `["t", label]` | Lexical mirror, emitted only alongside a `role: "tag"` cite (§3.3): the tagged zine's name, giving generic Nostr clients zero-resolution `#t` discoverability. |
| `["action", actionType]` | Advisory summary; see §3.4. |
| `["g", geohash]` | OPTIONAL, folder nodes only. A base-32 geohash the zine is pinned to for spatial browsing (Spaces view). **Arbitrary length** — length encodes precision (a length-2 cell is ~continental, length-8 is ~street-level); cells are prefix-hierarchical, so a coarser pin's cell contains every finer pin that shares its prefix. A node MAY carry several `g` tags. The current set is republished on the folder node; `g` does NOT enter the canonical body hash (curation surface, not content). `#g` gives relay-side cell filtering. Precision is disclosure: a fine-grained pin, republished on every folder step of a Sent trace, is a durable location record — presses SHOULD treat pin precision as a deliberate choice and surface it as such, never as a default. |

### 3.2 Content

```json
{
  "snapshot": "…file text…",
  "deltas": [ … ],
  "contentHash": "…hex…",
  "operationId": "…hex…",
  "folderCheckpoint": { "version": 1, "cause": "genesis | explicit-step | structure-change | child-advance | metadata-change", "sourceNodeId": "…" },
  "coin": { "version": 1, "origin": { "kind": "direct" } },
  "voices": [ "<signer pubkey>", "<other voice pubkey>", … ],
  "authors": [ { "v": "<pubkey>", "len": 42, "src": "<nodeId>" } ],
  "kedits": [ { "op": "ins | del | repl", "from": 42, "to": 42, "text": "…", "voice": "<pubkey>", "t": 1730000000000, "tx": 7, "intent": "undo | redo" } ],
  "summary": "optional",
  "prompt": "action: llm only — the instruction itself",
  "injectRule": "<event id of a minted rule trace — action: llm only>",
  "llm": { "model": "…", "temperature": 0.7, "maxTokens": 4096, "provider": "openai | anthropic | …" },
  "contributors": [ { "type": "human | llm | agent", "pubkey": "…" } ]
}
```

`coin` is REQUIRED on Coins and MUST be absent on mutable file traces. Version
1 has exactly two origin forms:

```json
{ "version": 1, "origin": { "kind": "direct" } }
{ "version": 1, "origin": { "kind": "extracted", "sourceNodeId": "…", "sourceContentHash": "…hex…", "range": { "start": 10, "end": 24 } } }
```

For an extracted Coin, `sourceNodeId` pins the exact source nucleus,
`sourceContentHash` is the SHA-256 hash of that nucleus's complete text
snapshot, and `range` is the UTF-16 half-open interval whose bytes MUST equal
the Coin's `snapshot`. The paired `extracted-from` tag MUST name the same node.
A direct Coin has no source fields and MUST NOT carry an `extracted-from` edge:
its claim is only that the event signer minted these exact bytes. Readers MUST
use the envelope as the sole Coin discriminator; an `extracted-from` tag without
the envelope does not make an event a Coin.

`operationId` is REQUIRED on every node and is 32 cryptographically random
bytes encoded as 64 lowercase hex characters. Every checkpoint created by one
logical gesture or recovery transaction carries the same id, including the
originating file checkpoint and derived ancestor checkpoints. A standalone
checkpoint receives a fresh id. Recovery MUST reuse the original id. It joins
causal records; it is not a trace identity, event id, or ordering mechanism.

`folderCheckpoint` is REQUIRED on every folder node and MUST be absent on file
nodes. No legacy omission is defined. Folder genesis uses `cause: "genesis"`
and omits `sourceNodeId`.

- `cause: "genesis"` means this node creates the folder zine's stable identity.
- `cause: "explicit-step"` means the writer deliberately Stepped this folder
  or Root. It MAY carry no membership delta when the recursive frontier is
  already current; the deliberate landmark is itself the signal.
- `cause: "structure-change"` means a direct member was added, removed, or
  renamed. Cross-parent movement produces a remove and add under one shared
  `operationId`.
- `cause: "child-advance"` means a direct member acquired a new checkpoint.
  `sourceNodeId` is REQUIRED and MUST equal that member's new `latestNodeId`.
  This is a derived checkpoint, not another explicit Step.
- `cause: "metadata-change"` means folder metadata changed without changing
  membership.

For folder nodes, `snapshot` is instead:

```json
{ "members": [ { "kind": "file", "relativePath": "essay.md", "latestNodeId": "…", "contentHash": "…hex…" } ] }
```

`kind` is `"file"` or `"folder"`. `relativePath` is single-segment (no `/`); it names the member within its immediate parent only — hierarchy is expressed via folder-members, not slash-joined paths. `contentHash` semantics are per-kind: the file body hash (SHA-256 of the snapshot text) for `kind: "file"`; the folder's own canonical folder body hash (§2) for `kind: "folder"`. The folder-member's hash is precomputed at its own step and stored on the parent's entry, never recomputed by walking the member's chain (shallow-local, §2).

- `snapshot` — REQUIRED on every node this protocol's triggers produce. Full file text, or full ordered membership. It is the materialized body used for bounded reads; the required file-node KEdit replay is its process-integrity check, not a replacement storage format.
- `contentHash` — REQUIRED. Files: SHA-256 of the UTF-8 snapshot text. Folders: SHA-256 of the canonical folder body (§2) — the projection, not the raw snapshot, so resolution metadata (`latestNodeId`) never perturbs the hash. `contentHash` MUST NOT incorporate any name or path.
- `authors` — OPTIONAL per-character attribution; see §3.6.
- `voices` — OPTIONAL symbol table for per-delta attribution (§3.3, §3.6). An array of pubkeys; the node signer SHOULD be `voices[0]` so a delta that omits `author` (defaults to signer) and one that carries `"author": 0` resolve to the same key. A delta's `"author": <index>` resolves as `voices[index]`. It is absent on mono-author nodes. The table is local to this node — every node that needs it carries its own — so a reader never resolves across events.
- `kedits` — REQUIRED on every file node and MUST be absent on folder nodes.
  It is the complete sequence of content-changing transactions recorded by the
  press since the previous Step. Genesis replays from the empty string. An
  unchanged metadata-only or forced checkpoint carries the explicit array
  `[]`; a file node whose snapshot changes MUST carry at least one entry.
  Imports, forks, scans, headless tool writes, and other transitions that do
  not originate in an interactive editor are represented as one atomic KEdit
  for the discrete operation. That honestly records the transition the press
  performed without inventing physical keystrokes. Each entry carries one
  changed range from a transaction. `op` is `ins`
  when `from == to`, `del` when `text` is empty, and `repl` otherwise; `from`
  and `to` are UTF-16 offsets into the pre-transaction document; `text` is the
  inserted replacement; `voice` is the asserted author pubkey; and `t` is the
  transaction time in Unix milliseconds. `tx` is a non-negative integer
  scoped to this node: consecutive entries with the same `tx` are ranges from
  one transaction and MUST be applied atomically against the same pre-state.
  Writers MUST emit `tx`; invalid entries invalidate the node's process log.
  `intent` is OPTIONAL and may be only
  `undo` or `redo`; when present, every entry in that transaction MUST carry
  the same value. Its absence means only "no recorded history intent," not
  "ordinary typing." Applying the complete KEdit array to `prev.snapshot`
  (or `""` for genesis) MUST reproduce `snapshot` exactly. A reader MAY still
  display the self-contained signed snapshot when this check fails or the
  field is missing, but MUST label the file node nonconforming and MUST NOT
  present it as a complete or valid Full Trace. KEdits expose timing and
  intermediate states, including work later undone. Step keeps them local;
  Send publishes them with the node.
  Published timing is also a **behavioral biometric**: inter-edit rhythm
  (keystroke dynamics) can fingerprint an author and link pseudonymous keys
  across traces, defeating the transport layer's metadata privacy
  (`transport.md` §4) from the content layer. Publishing `kedits` is an
  identity-relevant disclosure, not merely a content one, and presses SHOULD
  present it that way.
- `prompt` / `injectRule` / `llm` — `action: llm` only; see §3.7. `llm` records the call params (`model`, `temperature`, `maxTokens`, `provider`) so a reader knows not just what was asked and what was in scope, but which model configuration answered. `temperature` is `number | null`: the actual value sent, or `null` when the caller sent none (the provider applied its own default) — never a placeholder `0`, which would falsely claim deterministic decoding.
- `contributors` — OPTIONAL roster of participants in this checkpoint, each `{ type, pubkey }`. This is the single carrier for "a non-signer contributed here" (an earlier `actor` tag is retired — see §R11).

### 3.3 Deltas

`deltas` is OPTIONAL: it may be absent on genesis or on nodes whose producer
has nothing to say about *how* the body arrived. When present, applying the
deltas in order to `prev.snapshot` MUST reproduce `snapshot` exactly (§3.5).
A signed event is immutable; retention may discard the whole event but cannot
strip this field while preserving the event identity (§9).

Body-edit types (file nodes):

```json
{ "type": "insert | delete | replace", "position": { "start": 42, "end": 42 }, "newValue": "…", "author": 1, "timestamp": 1730000000000 }
```

No `oldValue` field — it is recoverable as `prev.snapshot.slice(start, end)` and `applyDeltas` never reads it.

`author` is an OPTIONAL integer index into the node's `voices` table (§3.2).
The delta's text belongs to `voices[author]`; without the field, it belongs to
the node signer. `voices[0]` SHOULD therefore be the signer.

This is the primary per-delta attribution path (§3.6). It needs no
reconstruction or cross-event lookup. Like `authors`, it remains a claim by
the Step signer and cannot seam-verify in-session co-authorship (§R5).

Mono-author Steps SHOULD omit `author` and `voices`. If `author` is missing,
not an integer, or outside the table, a reader MUST attribute that delta to the
signer rather than reject the node. Only body-edit deltas carry `author`;
`cite`, `focus`, and membership deltas do not contain attributed text.

Membership types (folder nodes):

```json
{ "type": "add | remove", "kind": "file | folder", "relativePath": "essay.md", "nodeId": "…", "timestamp": 1730000000000 }
{ "type": "rename", "kind": "file | folder", "fromPath": "essay.md", "toPath": "draft.md", "nodeId": "…", "timestamp": 1730000000000 }
{ "type": "advance", "kind": "file | folder", "relativePath": "essay.md", "previousNodeId": "…", "nodeId": "…", "timestamp": 1730000000000 }
```

No `reorder` delta: member ordering is fully recoverable from `snapshot.members`
(and from the canonical body of §2, whose projection is the ordered
`(relativePath, kind, memberContentHash)` list), so a dedicated ordering delta
would be redundant provenance color. `add`/`remove`/`rename` are the three
structural facts a folder asserts about its membership. `advance` changes
neither membership nor structural name; it moves one existing member from
`previousNodeId` to `nodeId`. The prior id MUST equal the previous folder
snapshot's `latestNodeId`, and the new id MUST equal the next snapshot's value.
The `kind` field mirrors the member entry (§3.2): `"file"` or `"folder"`.

Writers MUST NOT encode an existing member's new head as `add`. A direct-child
checkpoint produces one `advance`; each ancestor then produces its own
`child-advance` checkpoint naming the newly advanced immediate child. This
keeps Root's recursive frontier exact without claiming that membership changed.

`rename` is a structural path change — a folder-owned fact about where a member lives, the same class of event as add/remove. It is distinct from `TraceOpinion`'s `name` (§5/§R6): an opinion is an author-scoped display label (replaceable, deliberately history-less), whereas `rename` is a folder-chain event with full history. A member can be structurally renamed zero or many times and independently carry any number of per-author opinion-names; the two axes never interact. Renaming a `kind: "folder"` member changes its name in the **parent** only — it does not rewrite the renamed folder's own chain (its members' `relativePath`s are names within *it*, unaffected).

Citation type (both reifications) — **one delta type, four roles**:

```json
{
  "type": "cite",
  "role": "inline | live | tag | reply",
  "op": "add | remove",
  "position": { "start": 10, "end": 52 },
  "newValue": "…",
  "sourceEventId": "…",
  "sourceContentHash": "…hex…",
  "timestamp": 1730000000000
}
```

- `role: "inline"` — a frozen quote: `newValue` came from a coin, not typing; `position`/`newValue` present. It accompanies the ordinary body-edit delta that installed the bracket; it does not apply a second body mutation.
- `role: "live"` — a transclusion that tracks its source's head. Reserved; not yet specified beyond the delta shape.
- `role: "tag"` — a zine tagged onto this trace: no `position`, no `newValue`; body untouched. The only role for which `op: "remove"` is meaningful (untagging).
- `role: "reply"` — this whole document replies to another stepped trace: no `position`, no `newValue`; body untouched.
- `op` defaults to `"add"` and MAY be omitted.
- Every `cite` with `op: "add"` MUST have a matching top-level `q` tag pinning `sourceEventId`; `op: "remove"` removes the corresponding `q` from the current set. `sourceEventId` is pinned to the source's nucleus **at the moment of citing**, even if the source's chain moves on. This lowercase `q` edge is the only social citation primitive. Text cannot be cited until it is a trace: `[[text]]` is draft syntax; Mint first strikes a coin, after which an inline bracket or bodyless tag may cite its node id.
- `sourceContentHash`, if present, is the hash of the cited span/body as it appears in the source — lets a verifier catch a fabricated citation without reconstructing the source (§3.9). The hash is SHA-256 of the exact UTF-8 bytes of the span, per §2 — **no normalization**. It is NOT the rendezvous coordinate `H`, which NFC-normalizes and collapses whitespace (`rendezvous.md` §1.2); the two induce different equivalence classes on the same text.

Only `insert`, `delete`, and `replace` participate in `applyDeltas`. Citation and observation deltas describe why or how a body/relationship changed; readers MUST NOT splice their `position`/`newValue` into the snapshot a second time.

Observation type (folder nodes):

```json
{ "type": "focus", "op": "mount | unmount", "selection": { … }, "panelIndex": 1, "timestamp": 1730000000000 }
```

A `focus` delta records **foreground panel occupancy** — session-replay data, not membership. `op: "mount"` means a trace became the visible, active tab in an edit panel; `op: "unmount"` means it stopped being that panel's visible tab. These operations do not describe tab-strip membership: selecting another tab emits an unmount/mount transition even though both tabs may remain open. It MUST NOT alter `snapshot` or `contentHash`. **Focus deltas never mint their own Steps**: they accumulate in a persisted local per-folder buffer and ride along on the next structural folder Step. Closing and reopening the press does not create a checkpoint or discard the observations. The `selection` payload names what was focused, mirroring the reifications:

```json
{ "kind": "file",   "path": "essay.md", "nodeId": "…" }
{ "kind": "folder", "path": ".",        "nodeId": "…" }
{ "kind": "coin",   "nodeId": "…", "phrase": "the cited words", "originPath": "essay.md" }
```

Press-local selection and mounting remain separate from this observation. An Explorer selection chooses one or more traces for an action such as replay. Exactly one context mount may be active at a time; mounting another file or folder replaces it, and a mounted folder contributes its descendants. Neither gesture changes tab focus by itself and neither is serialized as a `focus` delta. Tab focus is singular per panel: bringing one tab to the front is the event recorded here. The field name `selection` inside the delta names that focused trace; it is not the press's multi-selection state.

### 3.4 Action (advisory)

`["action", actionType]` is a one-word summary for indexing and display. It is **derived, advisory metadata**: readers MUST NOT treat it as authoritative — the deltas and edge tags are. When a node qualifies for more than one (a checkpoint capturing typed text *and* a paste since the last step), the action is chosen by precedence:

`merge > fork > delete > llm > import > cite > paste > edit > external > focus`

| Action | Meaning | Distinguishing tags |
|---|---|---|
| `import` | Genesis — first-observed content, or a coin just struck | no `prev`; `content.coin` + `x` if a coin; `extracted-from` only for extracted coins |
| `fork` | Genesis seeded from another trace's node under a different owner | `forked-from`, no `prev` |
| `edit` | Ordinary change | `prev` |
| `external` | File changed outside the traced editor — disk drift detected at next app open or poll, or an external process / MCP tool wrote it. Signed by the external actor's voice (a per-machine reconciler key for bare drift, a per-actor key for MCP callers), never the authoring key. The authoring key only signs changes the editor's own transactions produced. `authors` is omitted, so reconstruction attributes the bytes to the external voice's pubkey (Tier-2 signer attribution, §3.6) — honestly low-trust: the signer claims only "the machine's state moved," not "the human typed this." Per-actor distinction is carried by the signer pubkey, not this tag. | `prev`; signed by the external voice |
| `paste` | Pasted content, possibly minted elsewhere | `prev`, `q` if sourced |
| `cite` | Primary purpose is a citation — inline quote, tag, or reply | `prev`, `q` |
| `llm` | Checkpoint around an LLM call | `prev`, `prompt` |
| `merge` | Owner accepts content from one or more other chains into this one | `merge-parent` × N |
| `delete` | Trace removed, history retained | `prev` |

**Oblivion, restore, and relay removal are separate axes.** A press MAY keep a
local recycle-bin copy in Oblivion, but that path/name is never a network
lifecycle signal. Moving a mutable file to Oblivion extends its existing
identity with `action: "delete"` and removes its folder membership; active
inbound/fork/co-citation readers therefore emit no current social signal from
that trace. Restoring extends the same `prev` chain again, refreshes the
`TraceHead`, and adds membership at the chosen structural name — it MUST NOT
mint a new genesis merely because the path changed. Citations remain pinned to
their original immutable nuclei throughout: an active trace may still cite a
deleted target, and a local press may open its retained Oblivion copy read-only.

This vocabulary is shared by the protocol, reference implementation, and UI:
**to Oblivion** names the local move, **in Oblivion** means this press retains
the copy, **deleted** names the signed network state, and **restore from
Oblivion** names the return gesture. `archive` is not a lifecycle synonym.

Permanently deleting the retained local Oblivion copy is local storage policy
and does not publish NIP-09. Relay removal is the separate §10 gesture; it can
request removal only for events signed by the request key and must not be
presented as successful removal of Steps signed by other voices.

### 3.5 Integrity

For any non-genesis node **that carries `deltas`**:
`applyDeltas(prev.snapshot, deltas) === snapshot`, checkable against a single
prior node — never the whole chain. A node that legitimately omits or has shed
`deltas` remains cheaply checkable by its snapshot hash but has no full delta
replay check.

- **Cheap:** `hash(body) === contentHash` (per §2).
- **Full Trace (file nodes):** validate every KEdit and atomically apply each
  transaction to `prev.snapshot` (or the empty string for genesis); the result
  MUST equal `snapshot`. Missing, malformed, overlapping, out-of-range, or
  mismatched KEdits make the process record nonconforming even when the signed
  snapshot remains readable. O(content + KEdits), independent of chain depth.
- **Delta cross-check (when `deltas` are present):** apply them to
  `prev.snapshot`, compare to `snapshot`. O(content), independent of chain
  depth. Deltas remain an optional semantic summary; they do not substitute
  for the required file-process log.

Reader surfaces use one derived verdict vocabulary; these labels are not new
wire fields:

- **FULL TRACE** — event ids/signatures, snapshot hashes, ownership/`prev`
  lineage, every required KEdit transition, and every present body-delta summary
  validate.
- **SNAPSHOT ONLY** — the signed, hash-valid snapshot is readable, but its
  KEdit transition is missing, malformed, mismatched, or cannot be checked
  because the previous private snapshot is unavailable. Readers MUST NOT use
  the absent process as evidence or animate invented intermediate states.
- **INVALID** — signed-artifact integrity or lineage fails (for example an
  invalid id/signature, snapshot-hash mismatch, ambiguous `prev`, or owner
  change). A reader MUST NOT present this as a verified snapshot or Full Trace.

### 3.6 Attribution

Attribution is carried at two layers, in priority order: per-delta (primary) and node-snapshot (secondary). A reader reconstructs authorship by reading each delta's `author` index, resolving it through the node's `voices` table (§3.2), and defaulting to the node signer (`event.pubkey`) when the index is absent or out of range. The result is a per-character attribution of `snapshot` recoverable in one forward pass over a single node's deltas — O(content), independent of chain depth — without an `authors` map, a sum-check, or a separate reconstruction tier.

`authors` — OPTIONAL, now the secondary carrier. An ordered run list covering `snapshot`: run *k* attributes the slice beginning at the sum of all prior `len` values, for `len` UTF-16 code units, to pubkey `v`. The `len` values MUST sum to exactly the snapshot's length; on any mismatch a reader MUST treat `authors` as absent and fall back to per-delta + signer attribution. Runs carry no text — the body is stored once, in `snapshot`.

- `v` — the author's pubkey.
- `len` — run length in UTF-16 code units.
- `src` — OPTIONAL: the event id of a node **signed by `v`** in which this run's text appears, making verification a single fetch.

`authors` is the carrier on bare-snapshot resets (genesis/import from plain text, deletes) and a redundant cross-check when both layers are present. A node MAY carry both; when they disagree, per-delta is authoritative for the deltas it covers and `authors` is treated as stale. `src` verification (below) operates on `authors` runs, which carry corroborating-node pointers that per-delta `author` does not.

**Per-delta is the right layer for in-session co-authorship; `authors` is the right layer for verified cross-authorship.** The two solve different problems. Per-delta `author` records who produced each span during a step — the human–AI loop, multiple in-process voices, any case where text enters the buffer without crossing a chain seam. It is O(1) per delta, independent per delta (one corrupted delta doesn't poison the rest), and needs no reconstruction. `authors` runs carry `src`, the corroborating-node pointer, so a run attributed to pubkey P can be **verified** when its text is derivable from a node signed by P reachable via the seam edges: `merge-parent`, `extracted-from`, `forked-from`, or `q`. That verification is meaningless for in-session co-authorship (the AI's text enters via a function call, not a seam edge — §R5), which is exactly why per-delta attribution is the primary path and `authors`' verification machinery is reserved for the case it actually serves.

**Trust posture, unchanged.** All attribution signals on a node — signer, per-delta `author`, `authors`, `contributors` — are claims by the node's signer. A run that can be corroborated via a seam edge + `src` is **verified**; otherwise it is **asserted**, and clients SHOULD render the two states distinguishably. This is the same epistemic status citation already holds (§3.9): asserted, cheaply checkable, degradable — never silently trusted, never requiring the attributed author's cooperation to step. Per-delta `author` is asserted-attributed by construction; it cannot be seam-verified, because the spans it points at were never signed by their attributed author as standalone nodes. That is the honest status for the no-seam case, and §R5 argues it is the right one.

**Multi-author means multi-chain — for verified attribution.** Concurrent authorship that you want to *verify* happens under distinct keys on distinct chains, joined by `merge` — which is what makes every legitimate cross-author run corroborable in principle (the merge-parent *is* a node the other author signed). In-session co-authorship (a human and an AI under keys the human controls, multiple voices on one chain) is *asserted*-attributable via per-delta `author` but not seam-verifiable; the spec says so rather than pretending otherwise.

### 3.7 LLM checkpoints and injection

An `action: llm` node's `prompt` is the instruction only — what a human typed or an agent decided to ask. Everything else the model saw (folder content, a roster, pinned traces) is NOT duplicated into the node: the node's `q` tags cite whatever was in scope, each cited node already self-sufficient, and `injectRule` names the deterministic procedure that expands those citations into the literal submitted prompt. The `llm` field records the model configuration (`model`, `temperature`, `maxTokens`, `provider`) so a reader knows which call answered.

**A rule is an immutable single-node trace carrying a named-algorithm manifest.** `injectRule` carries the event id of a rule trace whose body is a JSON manifest `{ "algorithm": "<name>-v<n>", "params": { … } }` — NOT executable code. The algorithm is a named, versioned, deterministic procedure shipped in the reader's binary (e.g. `ctx-block-v1`); the manifest names which one and its parameters (which context-block variant, whether sibling text is included, the role preamble). Rule immutability is guaranteed by the protocol itself, not by registry discipline: evolving a rule means stepping a new rule trace carrying a new manifest and citing the new id. Two readers implementing the same algorithm version produce byte-identical reconstruction; a reader that doesn't know the algorithm degrades — the scope `q`-tags still show *what* was in scope, but the assembled prompt can't be rebuilt. There is no executable code on the relay: execution-from-relay is rejected on the same trust posture as §3.9/§R5 (verifiable, not trustless).

Given `prompt` + the rule manifest + the cited nuclei, a reader whose binary implements `algorithm` can reconstruct the exact context a past call received: memetic lineage as a simulation, not a stored transcript. The manifest MAY cite a Query spec (§R9) as one of its params, so a rule can draw its scope from a query rather than a fixed folder.

### 3.8 Coining, brackets, forking

**Bracket syntax** (in file bodies):

```
[[ some phrase ]]              unresolved — rewrite-protected, not yet a trace
[[ some phrase | eventId ]]    resolved — coined, permanently addressable, frozen
```

Everything outside brackets is fluid by default. A bare bracket is rewrite protection only: it shields a span from silent drift across LLM rounds without minting anything. A selection deletion that fully contains brackets removes the loose text but spares each complete bracket; Cut and paste/type-over operate on the complete selection. Clicking bracketed text selects the whole occurrence, and Backspace twice unwraps it to ordinary text (dropping any resolved citation suffix without deleting the visible phrase). A bare bracket is NEVER auto-resolved by coincidental text match — resolution is always an explicit act.

**Extracted coining pass** (client- or CLI-triggered), for each unresolved bracket:

1. Read the current span text.
2. Step a new file-reified `TraceNode`, `action: import`, `snapshot` = that text, no `prev`, addressed to the Press's dedicated **Mint folder**. A coin never gains a later `prev` node. The Mint folder is an independent folder trace mounted beside Root by the press; it is not a member of Root and therefore cannot leak its inventory when Root is Sent. Mint folder genesis and membership Steps remain local. The Coin genesis has a single-segment `F` name. The reference naming policy is `<YYYY-MM-DD_HHmmss>-<smart-title>.md` in the Press's local time, at second precision, with a numeric collision suffix when necessary. `content.coin.origin` MUST be `kind: "extracted"` and carry the exact source node, full source-snapshot hash, and UTF-16 span range. Tags `extracted-from` (mirroring the source node) and `x` (Coin body hash) are both REQUIRED.
3. Publish that exact signed genesis to at least one configured external relay.
4. Publish a `TraceAttestation` targeting that genesis under the same minter key. The Mint gesture MUST NOT report success until both public writes succeed. Republishing the exact signed pair is idempotent; a press SHOULD retain that pair while completion is pending instead of minting a sibling.
5. After completion, record the Coin as a local Mint-folder member and rewrite the bracket in place to `[[ text | newNodeId ]]`. An unfinished attempt MUST NOT appear in Coin inventory. The rewrite is an ordinary `cite` delta (`role: "inline"`, `sourceEventId: newNodeId`) on the origin document's next step, mirrored as a top-level `q` tag.

**Direct coining.** A press MAY expose a Mint composer that strikes signer-
authored text without first creating a mutable source trace. It follows the
same one-node, `action: import`, named Mint-member, compound Mint, and `x` rules,
but its `content.coin.origin` is `{ "kind": "direct" }` and it MUST NOT emit
`extracted-from`. The node MUST carry the composer's KEdits applied from the
empty string. If the phrase entered through a single non-editor operation, the
node carries that one atomic insertion. Those KEdits do not create a `prev`
history; they validate the genesis transition to the final snapshot.

Coining captures what's there *now* as a fresh trace; it does not reconstruct a pre-mint chain for the text. Once struck, the coin's identity and sole nucleus are stable — later rounds cite the same trace. **Mint is one deliberate compound gesture: Step, Publish, and minter-Attest.** The Coin genesis is public; the private Mint folder and its membership checkpoints are not recursively published. A Sent container carrying a `q` citation is still the separate rendezvous-interest signal (§8 and `rendezvous.md` §1). A coin MAY be reified as a plain text file, but that is an exported materialization, not another Step or a conversion of the coin into a mutable file trace. A cosmetic alias MAY still be attached via `TraceOpinion` (§5); it does not replace the structural `F` name.

**Provenance-aware copy.** Copying never mints. Unminted text stays ordinary `text/plain` on the clipboard and pastes as ordinary text. When a selection already denotes a resolved Coin citation, a press MAY additionally carry a private reference to that existing Coin; pasting it into another traced file installs `[[ text | coinId ]]`, and the target's next Step carries both the cumulative `q` edge and a gesture-local `cite role: "inline"` delta. If the private reference is missing, stale, unverifiable, or stripped by another application, paste degrades to ordinary text and MUST NOT assert source provenance. Creating a new Coin always requires the explicit compound Mint gesture above.

**Resilience across edits.** A resolved bracket survives an edit iff its old-content position range overlaps no span in the diff the step already computes — an interval-overlap test, no fetch. Splits survive (both halves keep citing the same id), textual merges survive (two adjacent citations), and any overlapping edit destroys the bracket: the `| eventId` suffix drops, the text reverts to fluid, the cited trace itself is untouched. This is local continuity only — whether a citation was honest is §3.9's separate, reader-triggered check.

**Rewrite protection.** In the LLM loop a bracket is an explicit instruction that the span is fixed: the harness restores canonical bracket markup over the model's version before stepping. Restored text diffs as equal, so the resilience check sees the bracket as untouched — the two layers compose without special-casing. There is no separate pin mechanism; brackets are the single protection marker, read from content.

**Forking.** A trace has exactly one owner — the key that signs its nodes. To work on someone else's trace, seed a new trace under your own key from the source's current node: genesis `action: fork`, `snapshot` verbatim (hence colliding `x` — deliberately, see §R3), `forked-from` the exact source node-version, **no `q` to the source**. Fork is derivation, not composition — the fork diverges freely and the source owes it nothing. Fork identity is the fork's own genesis id. The same rule turns a coin into editable work: dragging or otherwise promoting it into Root creates a new mutable file trace with `forked-from` pointing to the coin; the coin itself remains untouched and may seed any number of forks.

| relationship | source preserved? | lineage edge | result |
|---|---|---|---|
| `cite role: inline` | yes — frozen, pinned | `q` + `sourceEventId` | a citation inside the citing trace |
| `cite role: live` (deferred) | yes — tracks source head | `q` | a transclusion |
| `fork` | no — copy diverges | `forked-from` | a new mutable trace, new owner |
| `merge` | yes — source chain untouched | `merge-parent` | a new node on *this* chain incorporating the parent |

**Merging.** A merge is a unilateral editorial act by the owner of the chain being extended. To incorporate work from another chain (typically a fork of this trace, or an upstream head when re-syncing a fork): step one `TraceNode` on *this* chain, signed by this chain's owner, with `["e", prev, …, "prev"]` to the current head, one or more `["e", parentNodeId, …, "merge-parent"]` tags naming the foreign head(s) being pulled in, `action: merge`, and a `snapshot` that is the reconciled body the owner chooses to publish. Integrity is unchanged (§3.5): deltas applied to `prev.snapshot` MUST reproduce `snapshot`. Attribution of foreign runs verifies via the merge-parent seam (§3.6) when `src` names a parent-signed node that carries the text.

Normative constraints:

- **Only this chain's owner signs the merge node.** The owner of a merge-parent chain does not sign, approve, or need to be notified. Merge validity requires no cooperation from any parent author — the same posture as citation (§R5).
- **Identity stays this chain's.** The merge extends the existing genesis; it does not create a new trace and does not reassign ownership.
- **Parents persist.** A merge does not consume, close, or retract any merge-parent chain. The parent remains a first-class, addressable trace; further work on it and later re-merges are ordinary.
- **Selective acceptance is native.** The merge `snapshot` is whatever the owner steps. Taking only some of a parent's content, rewriting the rest, or adopting the parent snapshot wholesale are the same gesture — not distinct protocol modes. Overlapping concurrent edits (both sides advanced past a common ancestor) are a client/UI concern; the wire only requires a self-consistent node.
- **Either direction is the same shape.** Pulling a fork into the source, or re-syncing a fork with a newer source head, are both `action: merge` on the *receiving* chain under that chain's owner. Unilateral means per receiving chain, not "only the original author forever."
- **Endorsement is not merge.** Social reconciliation ("the parent author attests their words in this new context") is a separate, optional speech act if ever specified; it is NOT required for a merge to be valid or for attribution to verify.

| relationship | who signs | other party needed? | result |
|---|---|---|---|
| `fork` | new owner (B) | no | B proposes under B's key |
| `merge` | receiving chain's owner (A) | no | A accepts under A's key |

**Folder forks are shallow, with fork-on-write.** A forked folder node (your key, `forked-from` the source folder node, fresh identity) carries `q` tags at the *source's* member nodes. Editing a member you don't own first forks that member (verbatim snapshot, `forked-from`), then repoints the membership entry at your fork. Untouched members remain ordinary citations to the source owner's traces — stable, attributable, uncoupled. Ownership is read off each cited node's signer, never off the folder: the folder owns its membership list, not its members.

**Folder members under fork (specified, implementation deferred).** A forked folder's `kind: "folder"` members stay cited to the source's folder node at fork time, same shallow-cite rule as file members. Editing anything *inside* a folder member requires recursive fork-on-write: mint a new subfolder genesis under your key (`forked-from` the source folder node), recursively fork-on-write each of *its* members, repoint the new subfolder's membership at your forks, then repoint the outer folder's membership entry at the new subfolder. **Cycle guard required**: a folder that contains itself transitively would infinite-loop the recursion, so step-time enforcement forbids `q`-tag cycles — a folder member's cited nucleus MUST NOT be an ancestor of the citing folder. The wire shape (member `kind`, the `forked-from` edge on a folder member's genesis) is in this revision; the recursive fork-on-write write-path is implementation-deferred.

### 3.9 Verifying a citation

A cited node carries its own `snapshot`, so confirming a quote is real is O(source snapshot), never O(source chain). `sourceContentHash` sharpens it: hash the citing delta's `newValue` (O(span), no fetch), then check that hash against the source's snapshot (one fetch). Not trustless — full verification still means reading the citing document — but bounded and cacheable. Missing cited events **degrade rather than break**: the citing document renders from its own snapshot (the quoted text is already inlined); only verification fails. A missing npm dependency breaks a build; a missing cited event leaves an unverifiable but readable document. A reader that observes a kind-5 deletion request (§10) referencing a cited node SHOULD treat the node as withdrawn — its cryptographic integrity is unchanged, but its availability is not guaranteed, and the citation SHOULD be flagged as revoked rather than verified.

## 4. TraceHead (kind `34290`)

Parameterized replaceable. `d` = trace identity (genesis node id). Content:

```json
{ "head": "<current nucleus event id>" }
```

A pure cache, written by the trace's owner on every step, giving O(1) head lookup and a write-time tie-break for multi-device races. It MUST yield to the chain wherever they disagree; losing it degrades head lookup to a scan (`#f` for the folder, then the uncited head) — the recovery path that was previously the only path. Meaningful only for mutable traces; a coin's nucleus never moves.

## 5. TraceOpinion (kind `34291`)

Parameterized replaceable. One event per `(pubkey, subject)`: a signed, per-author, subjective opinion of a body or trace — no canonical owner, no registry, last-write-wins by design (an opinion's correct semantics is "my current view"; multi-device races self-heal). `d` = the subject, one of two axes:

- `"x:<bodyHashHex>"` — an **immutable body**. The opinion covers every mint of those exact words, whoever minted them: a body worth seeing is worth seeing regardless of who minted it.
- `"n:<traceGenesisId>"` — a **mutable trace** (file or folder). The opinion survives every edit, because it keys on identity, not content.

Content — any subset of:

```json
{ "name": "…", "alpha": 1.0, "reaction": "👍" }
```

- `name` — what this author calls the subject. Structural file paths (`F` tag) are addressing; opinion-names are labeling. You and I naming the same passage differently is two parallel records, not a conflict. Readers see their own name first, others' as alternates.
- `alpha` — a visibility weight, the lever an operator tunes to make a subject more likely to surface in a relevant sample. A number, no fixed range; `0` is baseline, not exclusion. **Aggregation is non-normative**: how a reader combines per-author opinions into one weight is client policy. The relay stays a dumb pipe — "operator-as-chief-curator" means an operator signing opinions under a known pubkey, never relay-side ranking.
- `reaction` — a single-token reaction: a like, star, emoji, or short string. Optional, arbitrary UTF-8, no length guarantee beyond "short"; the relay does not validate it. A reaction is **an opinion in the strict sense** (§R6) — one per `(pubkey, subject)`, last-write-wins, re-emitting overwrites or unlikes. It rides on `TraceOpinion` rather than its own kind for exactly the reasons a like has nowhere else to live: it is per-author, singular-current, no-cooperation, and subjective. It is distinct from `name`/`alpha` only because a like cannot be spelled as a label or a weight. A reaction is NOT an annotation (§11): an annotation accumulates (many per author, addressable, version-pinned); a reaction does not, because its correct semantics is "my current view," not a stream of gestures.

Replacement is whole-event: an author retuning `alpha` re-emits `name` alongside it; the same holds for `reaction`. Rename/retune/*react* history is not guaranteed (the accepted trade — see §R6).

## 5A. TraceAttestation (kind `4294`)

A regular, append-only event meaning **"I stand behind this exact published
TraceNode."** It is a speech act about a revision, not itself a revision. It
therefore MUST NOT carry `z`, `f`, `F`, `action`, `prev`, `snapshot`, `deltas`,
or `contentHash`; those fields belong to `TraceNode` and would invent a body or
chain relationship that the endorsement does not have.

| Tag | Meaning |
|---|---|
| `["e", nodeId, "", "target"]` | Exact kind-4290 node endorsed. REQUIRED, exactly one. |
| `["k", "4290"]` | Target-kind index. REQUIRED. |
| `["p", targetAuthorPubkey]` | Target node's signer. OPTIONAL; when present it MUST equal the fetched target event's `pubkey`. |
| `["g", geohash]` | Optional spatial discovery metadata. |

Content is JSON with one optional field:

```json
{ "message": "I stand behind this edition." }
```

The empty object `{}` is valid. Any author MAY attest a target: attesting one's
own node is publication commitment; attesting another author's node is
third-party endorsement. Multiple attestations accumulate and never overwrite
one another. A producer MUST have observed the target on at least one external
relay before emitting the event; local-only fetchability is insufficient. This
is a publication-time validity rule, not a permanent availability guarantee:
a later-missing target makes verification unavailable, not the attestation's
signature invalid. A reader MUST verify the target is kind 4290 and, when `p`
is present, that its signer matches.

For a Coin genesis, the first attestation signed by that same genesis key is
the completion record of Mint. Third-party attestations remain ordinary
endorsements and cannot complete another key's Mint. Readers MUST NOT count a
bare `content.coin` genesis without its minter attestation as Coin supply.

## 6. Tagging

A tag and a bracket are the same `q` out-edge, differing only in manifestation: a resolved bracket is a `cite role: "inline"` — rendered, part of the body; a tag is a `cite role: "tag"` — real, discoverable, never touching the body. A tag always names a zine, never a bare string, and tagging emits **both** tags in one gesture:

- `["q", Z's current nucleus, relayHint, Z's ownerPubkey]` + the `cite role: "tag"` delta — the resolved, pinned edge.
- `["t", Z's name]` — the plain lexical mirror (the tagger's name for Z), free `#t` discoverability for generic clients.

Typing a tag label is a query, not a direct reference — `#t` plus the reader's own opinions surface candidate zines; the author picks one, and resolution pins it.

**Browsing a tag is a three-way union**, computed live off whatever Z's current head resolves to:

1. **Lexical** — `#t=[label]`: everything carrying the literal string.
2. **Content-identity** — `#x=[Z's body hash]`: every body-identical trace, independent of author or name.
3. **Transitive, one hop** — Z's own current `q` list: everything Z has itself tagged or bracketed. O(1) (Z's node is self-sufficient); the hop stops at one — bounded fan-out, no recursion.

## 7. Composite traces

A document that is nothing but a sequence of citations — `[[ q1 | id1 ]] [[ q2 | id2 ]] …` — is already a composite trace: an anthology, ordered by its author, addressable and citable like anything else. Its `snapshot` already inlines what it quotes (rendering needs no fetches — document-level self-sufficiency), and its `cite` deltas already are per-member provenance in order. A composite is an ordinary mutable trace: adding a quote next year is just an edit; the immutable leaves it cites are untouched. No coordination or permission is needed to curate one — citing has never needed the source's cooperation — so parallel, unrelated anthologies under the same informal name are expected, not a conflict.

## 8. Checkpoint triggers and the Step gesture

A checkpoint appends one signed trace node to its chain. Only an explicit Step
is presented as the writer's rhythm-layer gesture; structural and derived
folder checkpoints remain visible evidence with their actual cause.

Checkpoints are produced by:

- **External write (file).** File changed outside the traced editor; deltas computed by diffing last-known content against disk. Stepped as `action: "external"` (§3.4) under the external actor's voice — a per-machine reconciler key for bare disk drift, or a per-actor key for an MCP tool — not under the authoring key. A brand-new file is still `action: "import"` (genesis is honest provenance vocabulary), but signed by the reconciler voice so the attribution is honest. The authoring key signs only changes the editor's own transactions produced; this trigger is the one place it never does.
- **Step (file).** A deliberate author action — the Cmd+S "save" gesture. A
  Step is the rhythm-layer unit: frequent and local. **Every explicit Step
  appends exactly one checkpoint**, even when the snapshot is unchanged; that
  discrete choice is the process signal. The word "save" is deliberately retired
  from the protocol vocabulary to avoid implying that every save is a publish
  — saves are steps, not sends.

  **Distributed anteriority (experimental NIP-03 overlay on Step).** Step MAY
  submit its node id to OpenTimestamps. The step returns
  immediately and a pending receipt stays local. Only after the receipt gains
  a Bitcoin attestation does the press publish a new NIP-03 kind-1040 event
  containing the complete `.ots` proof, an `e` tag naming the Step, and a `k`
  tag naming kind `4290`. Kind 1040 is regular and immutable: a completed proof
  is a new event, never an in-place upgrade, and a pending receipt MUST NOT be
  published as NIP-03. NIP-03 is currently unrecommended, so this overlay is
  optional and readers MUST treat a missing anchor as "unproven time," not an
  invalid Step. The prototype uses a public OTS calendar; a configurable or
  self-hosted calendar is planned (`transport.md` §2). See `rendezvous.md` §3.
- **Step (folder or Root).** A deliberate recursive checkpoint. Before signing
  the selected folder's `explicit-step` checkpoint, the press MUST durably
  checkpoint every dirty descendant needed to represent the exact visible
  subtree, propagate each new direct-child head, and recover or fail the whole
  operation without presenting a partial frontier as complete. All resulting
  checkpoints share one `operationId`. The selected folder gets exactly one
  final `explicit-step` checkpoint even when its membership and child heads are
  already current. Root follows the same rule because it is an ordinary folder
  zine. A reader SHOULD collapse the derived checkpoints beneath the one
  deliberate gesture while allowing them to be expanded and verified.
- **Membership change (folder).** A direct member is added, removed, or renamed.
  The directly affected folder records `structure-change`; every affected
  ancestor records `child-advance`. A cross-parent move uses one `operationId`
  across the source removal, target addition, and both ancestor cascades so a
  reader can expose incomplete recovery rather than invent atomicity.
- **Child checkpoint (folder).** A direct child acquired a new head, including
  a content-stable explicit Step. The parent records an `advance` delta and
  `cause: "child-advance"`; propagation repeats through every ancestor to Root.
  This automatic roll-up is required because a folder zine pins both its
  content tree and the exact descendant trace frontier.
- **Tag change (file or folder).** `snapshot` unchanged from `prev`; deltas carry the `cite role: "tag"`; `q` tags updated; `contentHash` unaffected.
- **LLM invocation.** Stepped immediately (`action: llm`) with the prompt, before any write-back becomes its own node.
- **MINT.** Each explicit Mint Steps one immutable genesis, Publishes that exact
  node, and Attests it under the minter key before reporting success (§3.8).
  This deliberate compound gesture is the exception to the ordinary separation
  between local Step, discussion-oriented Send, and optional Attest below.
- **Fork.** Opening another owner's folder, or fork-on-write of a member (§3.8).
- **SEND (the discussion stance).** Send means "I want to talk about this" — not "I stand behind this" (that's Attest). If the working state has changed since the latest Step, Send first appends one Step carrying those changes. If the state is already current, Send reuses the latest Step. It then fans that node out to all write-enabled external relays. Sending unchanged state never manufactures a checkpoint.

  What Send changes is reachability: the node leaves the author's machine and becomes fetchable by others. Step alone stays local (drafts, experiments, dead ends, things recorded but not yet worth discussing). The author curates what leaves their machine through the Step/Send distinction — but the filter is "is this ready to discuss," not "is this finished." Most of what is Sent is never Attested; discussion is common, commitment is rare.

  When Coins are enabled, global rendezvous indexing is a durable side effect,
  not part of Send's relay-publication transaction. After relay publication
  succeeds, the reference press queues the exact signed carrying event in a
  durable outbox and retries incomplete indexing with backoff, after startup,
  and on network recovery. It
  processes every ordinary social `q` target in bounded batches; one failed
  coordinate or relay does not starve later targets or events. DHT failure
  never revokes or rolls back the already-Sent node. `rendezvous.md` §2.2 owns
  the queue bound, public-relay proof, and pointer publication semantics.

- **ATTEST (the commitment stance).** Attest means "I stand behind this" — a deliberate commitment, distinct from Send's "let's discuss." It is a separate speech act, not a downstream stage of Send: an author Sends freely (discussion is common) and Attests rarely (commitment is deliberate). Most Sent content is never Attested, and that is healthy — most discussions shouldn't become positions. Attest emits one append-only `TraceAttestation` (kind 4294) targeting the exact sent node; it does not step or mutate either author's trace chain (§5A).

  The Send→Attest gap is the structural distinction between tentative and committed, not just an opportunity for feedback. An author Sends to open discussion, a peer reads and responds, and the author Attests only if and when the work earns commitment. Attesting a node that was never Sent would be claiming a public position for something no one can fetch — a lie by construction. Attest without prior Send is therefore invalid. Mint is the deliberate exception that composes Step, publication, and minter-Attest into one gesture; the Mint attestation declares Coin supply, not rendezvous interest. A carrying trace's ordinary `q` edges become discoverable only when that trace is Sent (`rendezvous.md` §1, §6).

  **Anteriority anchor (optional, inherited).** Attest's process anteriority is
  inherited transitively from the cited Step. An implementation MAY also
  submit the Attest event id to OTS to prove when endorsement occurred, but it
  MUST follow the same completed-proof-only publication rule above. See
  §R11.20 and `rendezvous.md` §3.4.

**Focus buffer drain.** The focus buffer is per-folder and persisted locally.
Any folder checkpoint drains that folder's pending mount/unmount deltas into
its `deltas` array after the membership or advance delta. Focus never creates a
checkpoint by itself, but an explicit folder/Root Step and publication
preflight MUST flush applicable buffers even when no structural change occurs.
Because focus can accumulate, a node's `deltas` array MAY contain several
entries; readers iterate the array rather than reading `deltas[0]`.

**Local vs. published is destination, not signing.** Local storage is itself a relay, bound to 127.0.0.1; every event needs a valid signature to be accepted at all. What's opt-in is whether a stepped trace ever leaves the machine.

**Every trigger is discrete and bounded-frequency — none fires per keystroke or
per click.** Continuous typing and its KEdit journal stay in a raw local buffer
until a Step. A file Step MUST fold that journal into its required `kedits`
field, but it never creates per-keystroke events; focus observations likewise
batch into the triggers above. Derived folder checkpoints occur only when a
bounded direct-child checkpoint changes the recursive frontier. This is the
load-bearing fact behind unconditional snapshots (§R1).

## 9. Reconstruction and retention

Every node has `snapshot` — reading any version's body is O(1), no replay. A
TraceNode without a valid snapshot is non-conforming and MUST NOT be
reconstructed from deltas. `deltas` remain useful for per-span provenance and
edit-rhythm analytics.

**Retention is event-granular:** a signed regular event is immutable bytes. A
relay or archive MAY discard a whole node under its retention policy, but MUST
NOT expose a field-stripped rewrite as that node: removing `snapshot`,
`deltas`, or `kedits` changes the event id and invalidates its signature. A
store that advertises Full Trace retention therefore preserves every retained
file node's required KEdit array. Derived indexes and caches remain operator
territory and may be rebuilt or discarded freely.

## 10. Relay requirements

Any NIP-01 relay that also implements parameterized-replaceable handling (NIP-33, for `TraceHead`/`TraceOpinion`) suffices. The protocol depends on no tag-ordering guarantees and defines no special relay class. In the citation-verification path, folder placement is display metadata only — integrity rests on pubkey + contentHash + snapshot, never on folder.

**Removal request (NIP-09).** An author MAY request removal of their published events by publishing a standard NIP-09 kind-5 event under the same key: `["e", eventId]` for each regular `TraceNode` (kind 4290) or `TraceAttestation` (kind 4294), `["a", "34290:<pubkey>:<d>"]` for the `TraceHead`, and `["a", "34291:<pubkey>:<d>"]` for each owned `TraceOpinion`. NIP-09 says compatible relays SHOULD delete or stop publishing matching events whose author matches the request. It does not guarantee deletion, require a tombstone, or require permanent refusal of the same event id. Advertising NIP-09 describes relay capability, not a universal retention outcome. A relay that never received or chose not to act on the kind-5 MAY retain the event, and a reader that cached it keeps a cryptographically intact copy. The request does not touch the trace chain; it asks relays to change *retention*, which §10 keeps non-normative. Only the event author can make an effective request for that event, so third-party opinions and attestations persist unless their respective authors request removal too.

Non-normative, reserved for later: relay-side validation policy (rejection rules for malformed content, missing required tags, unresolvable `q`), retention, operator/staff admin layer.

## 11. TraceAnnotation (deferred)

A reader's gesture that is **lighter than a fork/quote but heavier than a reaction** — a comment, a marginal note, a SoundCloud-style timed reply. The gap it fills is genuine: `TraceOpinion` is opinion-shaped (one per author+subject, last-write-wins — §5/§R6), and `cite role: "reply"` is authorship-shaped (the reply itself is a whole chained trace). Neither hosts an *accumulating*, *per-gesture*, *version-pinned* annotation. This section argues the shape; nothing here is required to implement, and the kind number is held, not burned.

**Why a new kind, not a variant of an existing one.** The three rejection pressures are structural:

- *Not a TraceOpinion.* An opinion is one-per-`(pubkey, subject)` by design; its whole value is "my current view" collapsing across re-emissions. An annotation's value is the opposite — many per author, each a separate speech act. Stretching TraceOpinion to multi-event breaks §R6's central trade (replaceable = multi-device race dissolves; history not guaranteed). An annotation cannot trade away history because its history IS its payload.
- *Not a `cite role: "reply"` delta.* A reply cite makes the responding document a full trace — genesis, chain, self-sufficient snapshot, ownership. That is the correct weight for a long-form response; it is the wrong weight for "nice paragraph." Forcing a marginal note into authorship is the over-heavy path that leaves the middle empty.
- *Not an opinion variant.* §R6 fought for exactly two subject axes (`x:`/`n:`) on clean lines; a third for annotation would dilute the addressing-vs-identity split, and the multi-event semantics still wouldn't fit the replaceable class.

**Why regular (non-replaceable), like TraceNode.** An annotation's history is its payload (same as TraceNode, opposite of TraceOpinion). It accumulates by chaining or by flat emission; it does not collapse on re-emit. Ordering is therefore `created_at`-independent — if chained, via `prev`; if flat, via relay event order with reader-side reconciliation.

**Target an immutable anchor — the §R4 rule, inherited.** Annotation does not introduce a new passage-addressing mode. It inherits the rule citations already follow (§R4): nothing addresses a passage without first striking a coin. A whole node is already stepped, immutable, and self-sufficient, so a whole-savepoint annotation cites the node directly. A passage-level annotation cites a **coin** — the reader first strikes it under their own key (`extracted-from` the source node, exactly the §3.8 coining pass), then annotates that coin's sole nucleus. There is no bare `(node, position)` coordinate pointer: such a pointer would be the one weak-addressing exception in a protocol that has refused cheap shortcuts at every turn (no auto-resolve on text match §3.8; no positional `tags[0]` §R11.4; no executable rules §R11.2). Coining keeps §R4 pure — one way to address a passage, whether you cite it, quote it, or annotate it.

**Why `e target`, not `q`.** Annotation is commentary, not composition. `q` is the single composition edge (§R4); an annotation does not combine the target into its body. `e target` puts annotation in the family of non-`q` lineage edges alongside `forked-from` and `extracted-from` — all `e`-tagged, all denoting "points at" rather than "composes."

**Sketch (argument, not commitment):**

```json
{
  "kind": 4293,
  "tags": [
    ["e", targetNodeId, relayHint, "target"],
    ["x", sourceContentHashHex]
  ],
  "content": { "text": "this is the SoundCloud-timed-comment case" }
}
```

- `["e", targetNodeId, …, "target"]` — NIP-18 quote shape. `targetNodeId` is an **immutable anchor**: either the source node itself (whole-savepoint annotation) or a coin extracted from it (passage-level). Either way the anchor is stepped, self-sufficient (§R1), and permanent (§9 — retention sheds deltas, never snapshot). The annotation pins to that version even if the source trace's nucleus moves on — the same version-pinning `sourceEventId` already does for citations (§3.3). Citing a non-head node is already wire-legal (the spec describes the common case as head, forbids nothing; `extracted-from` does the same for coins).
- `["x", sourceContentHashHex]` — OPTIONAL. The content hash of the cited target's body, letting a verifier confirm the annotation addresses what it claims without reconstructing the target — the §3.9 `sourceContentHash` pattern, reapplied. For a whole-node target this is the node's own `contentHash`; for a coin target it is the coin's body hash. Absent → the annotation is still readable, just unverifiable (the degrade-don't-break posture).
- `content.text` — the annotation body. Arbitrary text; no integrity claim against the cited body (the annotation is a speech act about the snapshot, not a mutation of it).

**What is deliberately NOT solved here:**

- **Head-following vs version-pinning.** A coin-anchored annotation does not travel to the live nucleus. If you annotate a coin struck from checkpoint N and the author Steps N+1, the annotation stays on that coin — correct (you said it about that version), but a reader on the head won't see it unless the reader walks prior nodes or the coin's `x:` cluster. Whether to render annotations at-their-version (faithful, live reader misses old ones) or aggregate them onto the head (losing version context) is reader policy, not wire.
- **Thread nesting.** Replies-to-annotations (a thread hanging off a savepoint) are unspecified. The natural shape is an annotation whose `target` is another annotation, but whether to allow arbitrary depth or flatten is deferred.
- **Retention.** Unlike TraceNode (snapshot permanent), an annotation has no integrity payload — a relay MAY shed old annotations freely. Aggregation/display is entirely reader-side.

**Relation to reaction (§5).** A reaction and an annotation are non-interacting: a reaction is a singular-current opinion (one emoji, overwrites); an annotation is an accumulating speech act (many, each addressable). A reader who 👍 a passage strikes a coin then emits a `TraceOpinion` on its `x:`; a reader who writes "this assumes X" strikes a coin then annotates its nucleus. Both require the coin; they differ in what rides on top — a replaceable singular token vs an accumulating speech act. Forcing either into the other's shape breaks its core trade — so they stay separate kinds despite surface similarity.

---

# Part II — Rationale

Nothing in this part is normative. Each argument appears once.

## R1. Unconditional snapshots buy bounded resolution

`snapshot` is required on every node because a cited node must resolve as one fetch against a self-contained object — O(source snapshot), not a replay through the source's chain. Everything the protocol offers as an import/composite/package story rests on that guarantee, not on the delta log. The cost is affordable because explicit checkpoints and direct-child advances are discrete, bounded-frequency events (§8). The high-frequency case — continuous typing — is journaled locally and batched as required `kedits` on the next file Step; it never drives event cadence. If checkpoints ever became per-keystroke, unconditional snapshotting would collapse; that is why both KEdits and `focus` observations batch rather than mint (§R7).

The same trade shows up one level up in injection (§3.7): don't store a manufactured artifact (the assembled prompt), store what's needed to remanufacture it — the same move `deltas` makes by omitting `oldValue`.

## R2. Chains, not clocks; immutable nodes, replaceable current-state

An earlier draft put file nodes at a parameterized-replaceable kind and folder state in a replaceable manifest. Both were reversed: a relay is entitled to keep only the latest replaceable event, which is fatal when history *is* the payload, and a replaceable manifest carries no snapshot, so a cited folder couldn't resolve as a bounded fetch. Ordering by `created_at` also breaks at second resolution — two publishes in the same wall-clock second can leave a relay holding the older event. Hence: trace nodes are regular events, ordering comes from `e…prev`, and the protocol never trusts `created_at`.

The reversal is deliberately asymmetric. `TraceHead` and `TraceOpinion` are replaceable because for them last-write-wins is not a hazard but the correct semantics: a head pointer's only meaning is "current," and an opinion's only meaning is "my current view." A replaceable *pointer* whose loss degrades to a scan is categorically different from replaceable *content* whose loss is loss. This split resolves most of what was previously an open head-disambiguation problem: the pointer provides O(1) lookup and a write-time tie-break, while the chain stays the source of truth.

## R3. contentHash is addressing, not identity

`contentHash` never includes a name, and never serves as trace identity. Identity is the genesis id; version identity is the nucleus id. Two traces with byte-identical bodies share an `x` and remain distinct traces — deliberately, because collapsing them would make two people independently minting the same words indistinguishable from one citing the other. The memetic split — deliberate reuse vs. convergent evolution — is the thing being measured. Same body + different genesis → same `x`, different trace, no conflict.

This is also why a folder's hashable body is the `(relativePath, memberContentHash)` projection (§2): membership entries carry `latestNodeId` for resolution, but node ids are signed artifacts no two owners share — hashing them in would make independent identical folders never cluster, silently killing `#x` for zines. The projection hashes what the folder *is* (which bodies, in what order, under what names) and excludes how to fetch it.

A trace's full extent, around its nucleus: **back** — the `prev` chain, identity-through-change; **out** — `q` edges to what it composes; **in** — three distinct signals, none implying another: citation fan-in (`q`, deliberate reuse), extraction fan-out (`extracted-from` in reverse — coins struck from this node), and content-hash clustering (`x`, independent recognition of the same words). They answer different questions and stay separate axes for the same reason contentHash and identity do.

Coining never auto-resolves against an existing trace, even on exact text match — so independent highlights of the same passage strike fresh coins, and `x` is what lets them find each other afterward. Note the grouping asymmetry: the coins pulled *from* one source group by `extracted-from` (different passages, different hashes), while `x` only ever collides on byte-identical text.

## R4. Composition is the single combining edge; fork is not composition

A folder containing a file, an anthology composing quotes, and a document citing a span are one edge — a `q` from composer's nucleus to component's. A folder is simply a trace whose body *is* its out-edge list; there is no separate membership relation. What varies is only whether the composer's body is a set, a sequence, or interspersed prose.

Two asymmetric primitives underpin it: **coining** (striking an addressable coin from a passage) and **citing** (referencing its sole nucleus). A citation requires a resolved bracket; a bracket does not require a citation — bare brackets protect without coining. Nothing cites passage text without first striking a coin.

Fork sits outside composition on purpose: a fork is *seeded from* a source once, not *built from* it, so it emits no `q` — lineage flows through `forked-from`. Conflating them would pollute `q`'s fan-in signal (deliberate reuse) with derivation lineage. "Composition is the single relationship by which traces *combine*" survives because a fork doesn't combine; it spawns. `extracted-from` and `forked-from` are the same shape at two granularities: span → immutable leaf; whole node → mutable trace under a new owner.

## R5. Attribution: asserted and verifiable, not co-signed; per-delta on one step, not per-delta events

Deltas are unsigned sub-fields of a signed node; the signature lives at the step boundary. Per-delta **attribution** rides inside that already-stepped node as an `author` field on each body-edit delta (§3.3, §3.6) — it is *not* a per-delta event. The distinction is load-bearing: an earlier draft of this rationale conflated "attribution at delta granularity" with "signing at delta granularity" and rejected the package. They are unbound. Per-delta signing was rejected and stays rejected (below); per-delta attribution was adopted in §R11.21.

Cross-author text legitimately enters a document by exactly three routes — quote (`extracted-from` a node the author signed), merge (the merge-parent *is* a node the author signed), fork (`forked-from`, same) — so every honest *cross-author* run has signed corroboration one seam edge away. The `authors` map is a denormalized reading aid over lineage that already exists in signed form, and its `src` pointer gives that verification a single-fetch shortcut. The only genuine forgery is a run with no corresponding lineage, and that is *detectable* rather than *preventable* — hence the verification rule (§3.6), which gives attribution precisely the epistemic status citations already have: asserted, cheaply checkable, degradable. The protocol already rejected trustlessness for citations in favor of bounded verification; attribution holds itself to the same standard, not a stronger one.

**But the seam model does not cover the human–AI loop.** The strongest motivation for per-delta attribution is the case `authors`' verification model cannot touch: in-session co-authorship, where the human types, invokes an LLM, and the model's output is spliced into the buffer and stepped on the *same* chain under a key the same human controls. There is no merge-parent, no `extracted-from`, no seam to walk. The AI's text enters via an in-process function call, not via incorporation from a foreign chain. For that case — which is the default for any tool whose premise is human+AI co-authorship — `authors`' verification machinery offers no advantage over plain per-delta `author`: both are signer-asserted, neither is seam-verifiable, and per-delta is cheaper (O(1) per delta, independent per delta, no sum-check, no reconstruction). The earlier draft's reasoning preferred the heavy reconstruction over simple attribution on the grounds that reconstruction preserved verifiability; that preference is sound *where seams exist* and unsound *where they don't*. The human–AI loop is the latter, and it is the common case.

**Co-signing was rejected** for two reasons beyond coordination cost. Semantically, an author already attested their words when stepping their own node; co-signing someone else's step is really *endorsement of a new context* — a different speech act, and conflating them invites "Bob signed a document quoting him out of context." Structurally, it hands every quoted author a veto over your step, contradicting a load-bearing principle: citing has never needed the source's cooperation. If context-endorsement is wanted it fits as an asynchronous, optional `attest`-flavored event later — never a step blocker.

**Per-delta events were rejected** and stay rejected. Signatures at delta granularity within one author add nothing (same signer) — the marginal value exists only at cross-author seams, which are exactly the edges already signed. Per-keystroke event volume abandons bounded-frequency stepping (§R1), publishes partial state before an author-chosen checkpoint, and multiplies signatures without adding evidence. Required node-local `kedits` (§3.2, §R11.28) take the narrower path: high-resolution actions ride inside one chosen Step and remain local until Send. Per-delta `author` likewise adds no events, signatures, or cadence. The earlier rejection of per-delta *events* is exactly why a batched process log inside the Step is the right boundary.

What remains genuinely uncoverable: two humans under one key in one session — no chain, no seam, no `author` distinction (the step sees one signer, one buffer). That case is *asserted*-attributable only if the two humans take turns under distinct in-app voices that the editor tracks; otherwise it is permanently attributed to the single signer. Multi-author that you can *verify* still means multi-chain, joined by merge; in-session co-authorship is asserted-attributed via per-delta `author` and the spec says so rather than pretending otherwise.

## R6. One opinion kind, two subject axes

`TraceName` and `TraceAlpha` began as separate non-replaceable chains keyed by `(pubkey, contentHash)`. Two problems: they were byte-for-byte the same structure with one content field swapped, and contentHash keying is coherent only for immutable bodies — a zine (a folder, mutable) gets a new hash on every membership edit, silently orphaning every accumulated name and alpha, which contradicted alpha's motivating use case (surfacing zines in samples). The merge into `TraceOpinion` fixes the duplication; the two-axis subject (`x:` for immutable bodies, `n:` for mutable traces) fixes the keying, mirroring the addressing-vs-identity split the protocol already had (§R3).

Going replaceable trades away guaranteed rename/retune history. Accepted deliberately: for trace *content*, history is the payload; for an opinion, "my current view" is the payload and last-write-wins is the correct semantics — it also dissolves the multi-device concurrent-retune race that chained opinions inherited.

The `reaction` field (§5) leans on this argument unchanged. A like is structurally an opinion — per-author, singular-current, no-cooperation — and inherits the two-axis subject because it keys on the *same* `(pubkey, subject)`. Adding a content field for the token does not widen the axis design: a reaction is still one-per-`(pubkey, subject)`, still last-write-wins, still without history. It is the place a like had nowhere else to live, not a third subject axis. What it cannot host — accumulating gestures, many per author — is the §11 annotation's problem, not the opinion's; the two stay separate kinds precisely so the opinion's singular-current trade survives intact.

## R7. The telemetry boundary

An earlier draft let each focus event (panel mount, selection) create its own folder node. That violated the protocol's own frequency argument — focus fires per click, and a 1,000-member folder would re-serialize its full membership per click. The fix draws the line cleanly: session-replay observations are telemetry riding on provenance checkpoints, not checkpoint triggers of their own. They persist in the local buffer until the next folder checkpoint, explicit folder/Root Step, or publication preflight drains them. Closing the press neither steps nor discards them. A folder with no focus deltas behaves exactly as before; readers ignore delta types they do not understand.

## R8. Tag and bracket: one edge, two visibilities

Tagging composes a zine into a trace's out-edges the same way a quote does — it "imports" the zine for discovery and citation — without inlining its text. Requiring resolution up front loses nothing, because the casual affordance of a plain hashtag survives as the paired `t` mirror, a byproduct rather than a separate mechanism. The three-way union (§6) stays live-computed at query time — a tag's neighborhood grows as the tagged zine accrues its own edges — while the pinned `q` edge itself stays fixed. One hop of transitivity, no recursion: the same bounded-fan-out posture as everywhere else.

## R9. Query specs and the reader's dial

A query/sample definition step (a modal, conceptually) is where a reader dials: scope (a folder, a pubkey, an `x` cluster, a tag), which of the three union channels to include, hop depth (default 1), ordering (`recency` / `references` / a future alpha-weighted `sample`), and a result bound. This is reader-side construction over filters the protocol already defines (`#t`, `#x`, `#f`, `q`-walks, `TraceOpinion`) — no new wire primitive. Since injection rules are immutable single-node traces (§3.7), a rule can *be* a Query spec, and a spec's scope terms compose conjunctively — which is how one LLM call draws on several sources without a multi-rule mechanism. Only `recency`/`references` need to work today; alpha-weighted sampling waits on an aggregation policy.

The reference press exposes one persistent social query as three co-equal
projections: **Stacks** is the grouped/list projection, **Times** is the
time-series projection, and **Spaces** is the geohash projection. Text, social
scope, and time window are shared bounds; view-specific controls such as list
ordering or line-versus-stacked-area rendering do not mutate the result set.
Times' trace-usage series counts ordinary social `q` targets plus explicit
lineage targets (`forked-from`, `merge-parent`, `extracted-from`), deduped per
carrying event; structural `scope:llm` q-tags are excluded because prompt
context is not social use. Attestations remain a separately labeled count.
Current aggregates are explicitly partial: they cover events reachable from
configured read relays (including any super-peer configured for reads), not a
global population. The Kademlia component inside the enabled Coins package
returns event pointers for exact rendezvous keys; it does not compute
popularity totals, rankings, or map clusters. Those remain reader-side
reductions over fetched, verified events.

## R10. Known costs, accepted

- **Folder snapshots grow with membership.** A 1,000-member folder carries 1,000 entries per node. Membership changes and direct-child checkpoints are bounded-frequency, but a flat high-fan-out Root can still amplify one leaf Step into expensive ancestor snapshots. V1 accepts the simple self-contained encoding; content-addressed structural sharing, sharding, or incremental snapshots may be needed at scale without weakening the logical recursive frontier. Under nesting, per-node snapshot size stays bounded (immediate members only), but **transitive node count is multiplicative** — a 50-member folder where 10 members are 50-member folders is 550 transitive nodes. Any "walk the whole tree" reader (injection rules, sample queries) pays the full depth. The shallow-local `contentHash` (§2) keeps *hashing* O(immediate members); the cost moves to *traversal*, which is bounded fan-out per level.
- **Cumulative `q` sets grow with citation count.** The `q` list is the full current out-edge set (§3.1), so a heavily-citing trace — a 500-quote anthology — re-carries all 500 `q` tags on every step. Same class of cost as folder snapshots, accepted for the same bounded-frequency reason, and the same sharding caveat applies at scale.
- **UTF-16 offsets bind the wire to JavaScript string semantics.** Every offset and length (§2) counts UTF-16 code units, so a non-JS implementation (the Go relay, the Rust shell, any future reader) must do UTF-16 offset math over text it likely holds as UTF-8. Accepted deliberately — the Nostr ecosystem and both reference presses are JS, and a mixed-unit wire would be worse — but it is a permanent interop tax on second implementations, recorded here as a decision rather than an accident.
- **Verification is bounded, not trustless.** A determined liar can cite a real hash for text not really at that position; full verification reads the citing document too. The protocol optimizes the honest path and makes the dishonest one cheap to expose, not impossible.
- **`z`/`F`/`f` are provisional single-letter choices**, like the kind numbers; collision review against NIP tag conventions belongs to registration.

## R12. Deltas earn their cost: derived observations that suppress narration fabrication

`deltas` is OPTIONAL (§3.3) — a node can shed it under retention without losing
integrity, since `snapshot` alone reconstructs content. The cheap integrity
argument (§3.5) could suggest deltas are disposable once `snapshot` is present.
They are not. A controlled A/B/C run (2026-07-14, `research/narration-rubric.md`)
measured what the deltas' *derived observations* — the per-span content payloads
and the summed `(+N/−M)` character delta, rendered by `context-block.ts` into
every LLM op's context block — actually do when an LLM narrates how a document
was composed.

**The `(+N/−M)` character delta suppresses bulk-insert fabrication.** On a trace
containing three single-span inserts of +1222, +958, and +836 characters, an A/B/C
dose-response (5 draws per condition, glm-5.2) showed: with labels + span content
present, 5/5 narrations stayed bound, characterizing the inserts as large
replacements or compressions; with labels stripped (span content still visible),
3/5 drifted into "gradual composition" language (2/5 bound); with both stripped,
0/5 stayed bound — the model narrated the +1222 insert as "small final
adjustments" and "administrative." The summary magnitude is the anchor that
prevents a bulk paste from being dressed up as deliberate composition — exactly
the paste-tell the system preamble (`system-preamble.ts`) warns against. At this
N the contrasts differ sharply in strength: labels+spans vs bare log (5/5 vs
0/5, Fisher exact p ≈ 0.004 one-tailed) is solid, while the marginal value of
the summary label over span content alone (5/5 vs 2/5, p ≈ 0.08) is directional
but not statistically separable at five draws.

**The per-span content payloads suppress content fabrication.** With span
content stripped (condition C), every draw hallucinated entirely new content:
invented philosophical arguments (Nāgārjuna's two-truths doctrine, bracketed
citations) where the file actually contained nonsense vocalizations ("wooooo,"
"yessss"). The span text is what gives the model something concrete to cite
instead of inventing — the same role `snapshot` plays for content resolution
(§R1), but at the per-edit granularity narration needs.

**The two signals appear to contribute independently** — but this is the
study's weakest cell. The summary gives magnitude at a glance; the span content
gives the model something to anchor on. Removing either degraded fidelity;
removing both produced outright fabrication. The independence claim rests on
the middle (B) condition, the one contrast that is not statistically separable
at N=5, so read it as suggestive, not settled. What retention needs to know is
carried by the strong contrast: shedding `deltas` loses both signals at once —
the node's content is still resolvable, but the material from which honest
narration is derived is gone, and that shed state is exactly the study's
condition C.

**The `ΔNm/Nh/Nd` interval label is inert for this model.** Across two traces
(one with a self-evident Δ6h gap, one with ambiguous Δ32m/Δ1h gaps), no
condition produced a gap-as-mindset-shift narration — the model computes
durations from timestamps itself, or ignores the gap. The interval annotation
appears redundant for glm-5.2; whether it is load-bearing for other models is
an open question (a model-swap test, not a design change). The preamble's
second prohibition is retained on the expectation that the failure class is
model-dependent, not because it was observed.

This is the empirical case for treating `deltas` as more than an integrity
fallback: they are the substrate from which derived observations prevent a
specific, measurable narration failure. Shedding them under retention is safe
for verification and — for the one model tested — fatal for honest narration.
The evidence limits cut both ways: every finding here is single-model
(glm-5.2), 5 draws per condition, hand-scored by one scorer who was not blind
to condition (the pre-registered binary criteria bound but do not remove that
risk). The model-dependence caveat below applies to the positive char-delta
finding no less than to the inert interval label; a model-swap replication
would strengthen both.

## R11. Design history (reversals)

Entry numbers are **stable and never renumbered** — normative sections and
`rendezvous.md` cite entries as §R11.N. Entries 29 down to 15 carry stable
numbers and are listed newest first; the block numbered 1–14 below them is the
original list, retained with its original numbers rather than reordered into
the newer scheme.

29. **One reader verdict vocabulary adopted across human and machine surfaces.** The KEdit invariant in §R11.28 was easy to weaken accidentally if Replay called a malformed log “replayable,” Analyze called it “invalid evidence,” and handoff merely said “signature valid.” Readers now derive one of `FULL TRACE`, `SNAPSHOT ONLY`, or `INVALID` (§3.5). The middle state is load-bearing: missing or uncheckable process never destroys a self-contained signed snapshot, while a readable snapshot never promotes absent process into evidence. This adds no event field and changes no wire format; it standardizes the derived result exposed by Replay, Analyze, handoff/Reify, and machine inspection.

28. **KEdit storage made mandatory for every file Step.** The optional-log posture in §R11.27 contradicted the product invariant: a file with a polished snapshot but no process transition is readable content, not a Full Trace. File nodes now carry an explicit KEdit array whose atomic replay from the previous snapshot (or the empty string at genesis) MUST produce the signed snapshot. Empty arrays are valid only for unchanged text. Discrete non-editor operations use one atomic transition rather than fabricating physical keystrokes. Writers fail before signing on mismatch; readers may render the snapshot but must mark missing or invalid logs nonconforming. Retention is event-granular because a relay cannot remove a signed field without changing the event id and invalidating the signature. This supersedes §R11.27's optional and retention-sheddable posture while preserving its batching, transaction grouping, undo/redo, privacy-warning, and no-per-keystroke-events decisions.

27. **High-resolution KEdit logs adopted as optional Step metadata; undo/redo intent made explicit (optional/retention posture superseded by §R11.28).** The earlier telemetry boundary correctly rejected a signed event per keystroke, but stated the privacy consequence too broadly: it also ruled out batching editor actions inside a checkpoint the author deliberately chose. This revision first introduced `kedits` as optional, retention-sheddable process evidence on one Step without changing event cadence. §R11.28 later made the field mandatory and non-sheddable for conforming file nodes. The disclosure trade remains: Send publishes intermediate states and timing along with the node, including work later undone. The timing half of the trade is biometric, not just informational — see §3.2's keystroke-dynamics warning.

  History actions need semantic identity as well as their concrete inverse mutations. Without `intent`, Cmd/Ctrl+Z is indistinguishable from manually deleting the same range, and redo is indistinguishable from retyping it. Writers therefore preserve the editor's direct `undo`/`redo` transaction annotation. A node-local `tx` groups every range in one editor transaction because multi-cursor and grouped history changes share one pre-state coordinate space; replay applies the group atomically. KEdits without `tx` are invalid and discarded. This supersedes only the blanket rejection of batched keystroke metadata in §R5/§R11.21; per-keystroke events remain rejected.

26. **Citations unified on trace-targeting `q`; orphan-text `Q` retired.** A citation now always targets a first-class trace node with lowercase `q`. `[[text]]` by itself is draft syntax and emits no social signal. Mint creates a trace for the selected text and records its `x` content hash plus `extracted-from` origin; explicit inline quotation and tacit/bodyless tagging are two manifestations of the same `q` edge, not two citation types. Send controls reachability of the carrying trace and therefore of its citations. The prior uppercase-`Q`/`role: "content"` design in §R11.22(b) is superseded; writers MUST NOT emit it and readers MUST ignore it. When Coins are enabled, the DHT component derives a content-addressed rendezvous key from the cited target's verified `x` hash; that key is an index coordinate, not a second citation primitive. See `rendezvous.md` §1–§2.

25. **Attest separated from the revision chain as `TraceAttestation` (kind 4294).** The prior encoding made Attest an `action: "attest"` kind-4290 node. That reused an append-only class, but violated what that class means: a TraceNode MUST carry a real body, content hash, trace identity, and (for non-genesis nodes) an ownership-consistent `prev` edge. Attesting a folder or another author's node had no truthful snapshot or `prev`, while self-attestation created a no-content revision and accidentally moved the very head it was describing. The fix keeps the correct half of the old decision — attestations are regular and append-only because their history is the payload — while separating the wrong half: kind 4294 targets the exact sent node with an `e` edge and carries only endorsement metadata (§5A). It neither joins nor advances the target chain. This also lands the asynchronous cross-author endorsement deferred in §R5 without making merge bilateral.

24. **Send is the discussion stance; Attest is the commitment stance.** Three stances share one foundation:

  | | Meaning | Weight |
  |---|---|---|
  | **Step** | record for yourself | local, rhythm |
  | **Send** | "I want to discuss this" | tentative, shareable, open to revision |
  | **Attest** | "I stand behind this" | committed, deliberate |

  Three changes follow:

  (a) **Send is a speech act, not plumbing.** Send means "I want to talk about this." Pending changes become one Step before distribution; unchanged state reuses the latest Step. The "drafted but not committed" boundary does not live between Step and Send; it lives between Send and Attest. You Send freely (discuss), you Attest rarely (commit). See §8 SEND.

  (b) **Attest is independent of Send in intent, not just in time.** Previously Attest was framed as a later stage in a prerequisite chain (Step → Send → Attest). Under the reframe, Send and Attest are two different relationships to the same content, branching from Step in different directions: Send = tentative/discuss, Attest = committed/stand-behind. Most Sent content is never Attested, and that is healthy — most discussions shouldn't become positions. The Send→Attest gap is the structural distinction between tentative and committed, not just an opportunity for feedback. The prerequisite (Attest requires prior Send) still holds: you can't commit to something nobody can fetch. See §8 ATTEST.

  (c) **The "attest interest" gesture is retired from the rendezvous pipeline.** `rendezvous.md` §6 had a three-rung escalating attest verb (attest a node / attest interest / attest a peer), with "attest interest" as a separate opt-in gesture for publishing to the DHT. That middle rung duplicates Send: a carrying trace's `q` edges become reachable when that trace is Sent (Step = local only, Send = fans out). A separate "signal interest" gesture asks the user to say twice what Send already said once. The pipeline collapses to: mint/cite → Send (auto-signals) → match → vet → add peer. See `rendezvous.md` §6, §R5.

23. **`affirm` renamed to `attest`; NIP-03 artifact renamed to `anchor` (noun/verb split).** Lands `rendezvous.md` §R7. The publication gesture is now `attest` (was `affirm`, was `sign` — see §R11.19 for the earlier steps). Semantic case: *attest* connotes outward bearing-witness, putting on the record — which is what the gesture does (cite + optional geohash + declare). *Affirm* connoted inward agreement. The rename also resolves a collision the gesture's old name created once it owned the clean word: NIP-03 calls kind-1040 an "attestation," so to keep the gesture word and the artifact word distinct, the artifact became the `anchor` (`stampAndPublishAttestation` → `submitAnchor`, `attestation.ts` → `anchor.ts`, `OTS_ATTESTATION_KIND` → `OTS_ANCHOR_KIND`, `upgradePendingAttestations` → `upgradePendingAnchors`). The gesture owns `attest`; the OTS sub-mechanism owns `anchor`. At this point the existing kind-4290 action value was renamed; §R11.25 later corrected that wire shape to dedicated kind 4294. Sweep covered the `attestNode`/`canAttest`/`attestAsVoice` client symbols, `AttestModal.tsx`, `.op-attest` CSS, and `zine_attest` MCP tool.

22. **Anteriority moved from Attest to Step; an earlier content-cite rendezvous design was introduced.** Three coupled changes were introduced by the rendezvous companion doc (`rendezvous.md`). Part (a) remains current; part (b) was later superseded by §R11.26; part (c) moved into implementation after this decision with the revised trace-target derivation and remains in progress.

  (a) **Distributed anteriority on Step (reverses §R11.20(b)).** The anteriority submission moves from Attest to Step. The step remains immediate; a pending OTS receipt stays local until a later sweep obtains a completed Bitcoin-attested proof, at which point a new kind-1040 event may be published. This makes dense time evidence possible without blocking Cmd+S. The evidence raises the cost of fabricating an old process; it does not prove humanness. See §8 (Step trigger), `rendezvous.md` §3 + §R3. Attest's anteriority is inherited transitively from the cited Step; Attest MAY keep its own completed-proof anchor for "when endorsed" as distinct from "when content existed."

  (b) **Superseded by §R11.26.** The earlier fifth `role: "content"` and uppercase `Q` tag tried to cite unminted text directly. It is retained here only as design history; current writers MUST NOT emit it.

  (c) **Rendezvous layer (companion doc; under implementation).** A Kademlia DHT inside the opt-in Coins package answers "which Sent events cite a trace whose verified content coordinate is `H`?" It carries fetchable event pointers (`H → {eventId, relayUrl}`), never content or a private-ACL onion. A querier verifies the carrying event's `q` edge and the cited target's `x`/body hash before its signer enters the process-evidence admission filter. Mutual-peer exact-target co-citation remains the trust-bounded path; the global path publishes pointers as a side effect of Send, with no separate "attest interest" gesture and no separate Kademlia opt-in. See `rendezvous.md` Parts I/II.

21. **Per-delta attribution adopted; per-delta signing stays rejected.** Body-edit deltas now carry an OPTIONAL `author` index naming the voice that produced that span's text (§3.3), resolved through a node-local `voices` table (§3.2); when absent or out of range, the delta defaults to the node signer (`event.pubkey`). This makes per-character attribution recoverable in one forward pass over a single node's deltas — O(content), independent of chain depth — without an `authors` map, a sum-check, or a reconstruction tier. Per-delta is the primary attribution path; `authors` (§3.6) is the secondary carrier retained for `src`-pointer verification of cross-author runs (merge/fork/quote seam edges).

  **Why the reversal.** §R5's earlier draft rejected "attribution at delta granularity" but its objections were aimed at per-delta *events* (new signed events per delta): event volume and cadence destruction. Those objections hold and per-delta signing stays rejected. The broader rejection of a batched keystroke stream was first superseded by §R11.27's KEdit log and then tightened to the required file-node invariant in §R11.28. Per-delta `author` reintroduces none of the event-level costs — it is one field on an already-batched, already-stepped event. The earlier draft conflated the two and rejected the package; they are unbound.

  The clincher is the human–AI loop. `authors`' verification model (corroborate a run via a seam edge to a node the attributed author signed) has no purchase on in-session co-authorship: the AI's text enters the buffer through an in-process function call, not via incorporation from a foreign chain, so there is no seam to walk. For the case that is zine's center of gravity — human + AI co-authorship on one chain under keys the human controls — `authors`' machinery offers no advantage over plain per-delta `author`, and per-delta is cheaper, per-delta-independent (one bad delta doesn't poison the whole map, unlike the all-or-nothing `authors` sum-check), and needs no reconstruction. The verification model is retained for the case it actually serves (verifiable cross-authorship via merge); the common case gets the O(1) path.

  **Compactness.** On mono-author steps (the common case — an LLM Extend steps all-inject deltas; human auto-save steps all-pen deltas), every delta is the signer's, so the `author` field is omitted and there is no `voices` table. Attribution overhead appears only on steps that mix voices within one checkpoint: one `voices` array per node (each full pubkey stored once) plus one digit per non-signer delta, instead of repeating a 64-char pubkey on every delta. The table is node-local — every node that needs one carries its own — so a reader never resolves across events. Considered and rejected: storing an 8-char (4-byte) pubkey prefix instead of an index, which would save more bytes but be ambiguous to a cold reader (which full key?) and lossy in principle; and storing the full inline pubkey per delta, which is self-sufficient but verbose. The index form is lossless, self-sufficient (the table rides in the same node), and pays for itself at the third non-signer delta.

20. **NIP-03 anteriority anchor layered on Attest.** *Decision as made at entry 20; the load-bearing stamp has since moved to Step (§R11.22). Attest keeps an OPTIONAL own stamp; the text below records the original argument.* Attest is the one gesture that may reach for a trustless third-party anchor, via a NIP-03 kind-1040 event stamping the attest node's event id against Bitcoin (OpenTimestamps). Three questions, answered once:

  (a) **Why trustless here, when the protocol has refused it everywhere else?** Anteriority — proof that a commitment existed *before* some time T — is the one property that cannot be made self-sovereign. The author cannot prove to a third party that they didn't backdate their own claim without a third party attesting to it. Everywhere else the protocol's "asserted, cheaply checkable, degradable — never trustless" posture (§R5, §3.9, §3.7) suffices because the property under verification is recoverable from signed graph structure: lineage walks the `prev`/`merge-parent`/`forked-from`/`q` edges; authorship corroborates via `src`; citation honesty hashes the span. Anteriority has no signed-graph recovery path, so it earns the trustless tool — the single exception, and on the single gesture where commitment is the payload.

  (b) **Why Attest and not Step? — REVERSED in §R11.22.** Step is the local rhythm-layer gesture ("saves are steps, not sends" — §8). Dense Step commitments provide stronger process evidence than a single Attest-time anchor, and the async workflow keeps calendar work off the Cmd+S critical path. **When the optional overlay is enabled, Step is the submission hook; the pending receipt remains local; only a completed Bitcoin-attested proof becomes a kind-1040 event. Attest inherits any available anteriority transitively.** Attest MAY keep its own completed-proof anchor for "when endorsed," distinct from "when content existed."

  (c) **Why stamp the attest node's id, not the attested node's?** The attested node was already Sent — its existence was public on the relay, so proving "this content existed by block N" adds nothing. The attest node's id is the new, local-to-this-gesture artifact: the moment the author stood behind the work. Stamping *that* id is what makes "I committed to this by block N" a real claim rather than a restatement of "this content was already fetchable."

  **The anchor is a strictly-additive overlay, not a modification to Attest.**
  The target node steps immediately. Calendar submission produces a pending
  receipt, which the implementation keeps locally and retries in the
  background. Once it contains a Bitcoin attestation, the press publishes a
  kind-1040 event with the full proof. Readers check it or ignore it; the
  target node's signing, content, and reachability are identical with or
  without it. Pending receipts are valid OpenTimestamps working state but are
  not valid NIP-03 events; kind 1040 is regular, so publishing a later proof is
  a new signed event, not an in-place upgrade. The anchor is signed by the same
  key as the target node.

  **NIP-03 status, carried honestly.** The canonical NIP-03 spec is `draft unrecommended optional` — it carries a warning of a known vulnerability needing an update. The anchor here stamps a Nostr event id (itself a SHA-256 hash that verifiers re-derive from the serialized event), not attacker-controlled content, which is the posture that keeps the cited attack class from biting. Implementations SHOULD track upstream NIP-03 revisions. Reader-side verification (resolving an anchor to a Bitcoin block height) is out of scope for this revision.

19. **Attest decoupled from Send; vocabulary clarified: Step / Send / Attest.**

  (a) **`action: "sign"` renamed (eventually) to `action: "attest"`.** "Sign" appeared in two senses: crypto-signing (mechanical, every step does it) and publication-signing (a deliberate social act). "Is it signed?" was unanswerable without knowing which. The publication act was first renamed to `affirm` — no collision with crypto-signing — and then (§R11.23, `rendezvous.md` §R7) to `attest`, on the semantic case that *attest* connotes outward bearing-witness / putting on the record (which is what the gesture does: cite + geohash + declare), where *affirm* connoted inward agreement. The rename also clears a noun/verb collision: the NIP-03/OTS artifact is the `anchor`, so `attest` owns the gesture word cleanly.

  (b) **Attest decoupled from Send.** Step records locally; Send distributes the current Step, first appending one only when changes are pending; a Sent node may later be Attested as a committed position. Most Steps are never Sent and most Sends are never Attested. Attest-without-Send remains invalid by construction. See §8 and §3.4.

  The vocabulary is: **Step** (append one signed checkpoint to a trace),
  **nucleus** (the current head node), **Send** (distribute the current Step,
  first stepping pending changes), and **Attest** (publication act on a sent node). "Save" is retired from
  the protocol vocabulary (Step replaces it); "ZINE" as a combined gesture is
  retired (Send and Attest are separate).

18. **Removal uses a NIP-09 kind-5 request at the relay layer, not a `TraceNode` action.** A removal request for a published zine is the trace author publishing a standard NIP-09 event (§10) signed by the same key, carrying `e`/`a` tags for the author's nodes. Compatible relays SHOULD delete or stop publishing matching events, but NIP-09 does not guarantee deletion, mandate tombstones, or require permanent refusal of re-publication. The request is deliberately *not* a new `action` row in §3.4: the action table describes chain nodes, while retention is orthogonal to the append-only chain and belongs in the non-normative relay/operator layer. Rejected alternative: a custom replaceable `revoke` marker kind. It would create a second protocol representation for a request Nostr already carries, while still being unable to erase reader caches or compel other relays. Same-author authority matches the single-owner-per-trace model (§3.8); non-author moderation remains in the operator/admin layer. See §R13.

17. **`reaction` field on `TraceOpinion`; `TraceAnnotation` deferred as §11.** Two adjacent product questions — "can a reader react lighter than fork/quote?" and "can a reader reply to a specific passage, SoundCloud-timed?" — resolved in two different places because the protocol already separates the two underlying classes. (a) A like/star/emoji is structurally an opinion: per-author, singular-current, no-cooperation, last-write-wins. It inherits `TraceOpinion`'s two-axis subject unchanged; the only gap was a content field for the token, so `reaction` (§5) is an additive field, not a new kind or axis. Rejected alternatives: a new reaction *kind* (duplicates the opinion class for one extra field), or a third opinion subject axis (dilutes the §R6 split). (b) A comment/marginal note/reply is NOT an opinion — it accumulates (many per author) and is version-pinned, so it cannot ride the replaceable singular-current class without breaking §R6's central trade. It also shouldn't be forced into `cite role: "reply"`, which makes the reply itself a whole chained trace (genesis + ownership + snapshot) — correct weight for a long-form response, wrong weight for "nice paragraph." `TraceAnnotation` (§11) is sketched as a regular (non-replaceable) kind holding the middle ground: cites an **immutable anchor** (a whole node, or a coin for passage-level), carries an optional `sourceContentHash` for verifiability, accumulates freely. It inherits §R4's rule — nothing addresses a passage without first striking a coin — so there is no bare `(node, position)` coordinate pointer; passage-level annotation strikes the coin first, exactly as citation does. The `e target` edge (not `q`) places annotation in the non-composition lineage family alongside `forked-from` and `extracted-from`. Its shape is argued here and the kind number held; implementation is deferred alongside head-following-vs-version-pinning, thread nesting, and retention policy.

16. **Merge is unilateral by the receiving chain's owner.** Closed the product-semantic half of the merge open questions: a merge node is signed only by the owner of the chain being extended; the merge-parent author neither co-signs nor is notified; parent chains persist (merge does not consume the fork); selective acceptance is the ordinary snapshot, not a cherry-pick special case; either direction (source←fork or fork←upstream) is the same shape. Endorsement stays a separate optional event if wanted later — never a merge prerequisite. Rationale: same load-bearing principle as citation and attribution (§R5) — incorporating content has never needed the source's cooperation; forcing bilateral reconciliation onto the wire would reintroduce co-sign coordination and break "merge while they're asleep." What remains deferred is client-side three-way conflict UI and branch detection, not wire semantics. See §3.8 **Merging**.

15. **Geohash pinning on folder nodes.** The long-deferred open question "Folder node + geohash + ≥1 signature" is split. Spatial pinning is now specified: folder nodes carry OPTIONAL `["g", geohash]` tags (§3.1) — base-32, arbitrary length, prefix-hierarchical, `#g`-filterable — and the spatial browser (Spaces) renders a pin only at the zoom whose cell-width matches the pin's geohash length, so the "various levels" emerge from the precision the author chose rather than a separate tiering field. Geohash is deliberately a *curation surface* tag: it does NOT enter the canonical body hash (`contentHash`/`#x` are unchanged), it is republished verbatim on every folder step (carry-forward in the client), and any signer who can republish the folder node can re-pin. The signature half became the independent Attest gesture; its first chain-node encoding was later corrected to the dedicated kind-4294 event in §R11.25. Geohash pinning shipped without it because a pin is an authoring act on the folder node, not a publication gate; the attest mechanism layers on independently.

1. **Folder nesting — folders as members of folders.** Closes the long-deferred open question. A folder's `snapshot.members` entries carry `kind: "file" | "folder"`; the canonical folder body projection is `[relativePath, kind, memberContentHash]`; the `F` tag applies to folder members as well as files; `relativePath` is single-segment (no `/`) — hierarchy is expressed via folder-members, not slash-joined paths. The `#f=[id]` "one-query returns the whole folder" property is weakened to "one-query returns every node **directly** in a folder"; reading a whole tree is bounded fan-out (one `#f` per folder member, recursing by depth). The canonical-body hash is **shallow-local Merkle-with-pointer**: each folder member's recursive hash is precomputed at its own step and stored on the parent's entry, so an outer hash is O(immediate members) regardless of depth — no chain walk at hash time, no recursion, cycle-safe by construction. Fork's shallow-cite rule extends to folder members at fork time; recursive fork-on-write *inside* a folder member (with its cycle guard) is specified but implementation-deferred.
2. **`injectRule` built as a named-algorithm version manifest, not an executable rule.** An earlier form of §3.7 left the rule trace's body unspecified — it could have been prose describing the expansion, or executable code (JS/WASM) that literally IS the procedure. Prose was rejected: two readers with different interpreters reconstruct differently, so the "deterministic procedure" the spec promises isn't actually deterministic across implementations, only per-interpreter-version — weak. Executable rules were rejected for the same trust reason the protocol rejects trustless attribution (§R5) and trustless citation (§3.9): a provenance layer whose whole posture is "verifiable, not trustless" should not execute code pulled from a relay event during reconstruction. The chosen form: a rule trace's body is a JSON manifest naming a versioned algorithm shipped in the reader's binary (`{ "algorithm": "ctx-block-v1", "params": {…} }`). Two readers implementing the same algorithm version produce byte-identical reconstruction; a reader that doesn't know the algorithm degrades to "scope visible via `q`-tags, prompt not rebuildable" — strictly better than no rule. The algorithm registry lives in code, not on the relay; evolving an algorithm means shipping a new named version, not mutating an old one. This is the same "name-and-version, don't embed the procedure" move the §R9 Query spec makes for scope construction.
3. **Folder-delta vocabulary — `reorder` deleted, `rename` added, `focus` given an `op`.** `reorder` was redundant with `snapshot.members` order (the §2 canonical projection *is* the ordered list); a dedicated ordering delta carried no information the snapshot didn't. `rename` was added as the third structural membership fact alongside add/remove: renaming a member used to decompose into add+remove on the chain, which broke replay (one user gesture → two unrelated events, the file's history orphaned from its new path). As a single delta it carries `fromPath`/`toPath` and replays as one move. Crucially `rename` is the *structural* path axis — folder-owned addressing — explicitly separated from `TraceOpinion`'s display `name` (§5/§R6), which is author-scoped and history-less; conflating them would re-introduce the §R6 conflict (an opinion's correct semantics is "current view," but rename replay needs history). `focus` gained `op: "mount" | "unmount"` for entry/exit symmetry: under single-occupancy panels most unmounts are inferable from the next mount, but a panel going empty (tab closed, no successor) is otherwise uncapturable — the gap replay most wants. Together add/remove/rename (membership entry/exit/move) and focus mount/unmount (panel entry/exit) close the folder-orchestration vocabulary at two levels.
4. **Positional `tags[0]` locator and the zine-relay class — deleted.** The locator was duplicated by its own filterable mirror, and tag-order preservation — the sole requirement distinguishing a zine-relay — existed only to protect the positional form. Any NIP-01+NIP-33 relay now suffices.
5. **`folderId` namespace — deleted.** Trace identity is the genesis node id, universally; folders have no separate id, which also removed the "folderId isn't globally unique" ambiguity from tagging.
6. **`FileTraceNode`/`FolderTraceNode` — converged** into one `TraceNode` kind with a `z` discriminator, after their parallel tag tables drifted (`f`/`F` vs `D`).
7. **`TraceName`/`TraceAlpha` — merged and made replaceable** as `TraceOpinion`, keyed by a two-axis subject; see §R6.
8. **`quote`/`embed`/`tag-add`/`tag-remove`/`reply-to` deltas — collapsed** into `cite {role, op}`; a fifth relationship now costs a string, not a spec section.
9. **`authors` runs — de-duplicated** from `{v, t}` (which stored the body twice) to `{v, len, src?}`, and given a verification rule; see §R5.
10. **Per-focus folder nodes — retired**; focus batches into real steps (§R7).
11. **Injection-rule registry — retired**; rules are immutable single-node traces (§3.7).
12. **`actor` tag — retired**; `contributors` is the single non-signer-participation carrier. Reintroduce a filterable mirror only if a real query needs it.
13. **Per-delta signing and co-signed `authors` — considered and rejected.** Per-delta *signing* (a new event per delta) was rejected and stays rejected; per-delta *attribution* (an `author` field inside an already-stepped node) was later adopted — see §R11.21. The distinction is load-bearing; see §R5.
14. Older reversals retained from earlier drafts: replaceable file nodes and the replaceable `FolderManifest` (see §R2); a separate local "pin" layer beside brackets (collapsed — brackets are the single protection marker).

## R13. Removal is a NIP-09 relay request, not a chain action

A request to "take down my published zine" concerns relay retention, not chain integrity. The chain stays append-only: every `TraceNode` is a signed regular event (kind 4290), and the protocol guarantees integrity of bytes a reader possesses, never erasure from every relay or cache. §10 therefore keeps relay retention and operator administration non-normative. NIP-09 kind-5 is the standard request vehicle: the event author asks relays to delete or stop publishing matching events.

- **Same-author authority matches the model.** A trace has exactly one signing owner (§3.8). NIP-09 relays act only when the deletion request and target share that author. No delegation, multi-signature rule, or new authority primitive is needed.
- **The chain is untouched.** A kind-5 request does not mint a trace node, mutate a `prev` pointer, or move a `TraceHead`. Readers who cached the target keep a cryptographically intact copy. A failed fetch means "unavailable from this relay," not proof of universal deletion.
- **Retention remains relay policy.** NIP-09 says relays SHOULD delete or stop publishing; it does not mandate a tombstone or permanent rejection of re-publication. Advertising NIP-09 signals support for the mechanism, not a guaranteed outcome on every relay.

The rejected alternative, a custom replaceable `revoke` marker, would add a second protocol representation for the same removal request without gaining erasure power. It could not compel other relays or remove cached copies. Zine therefore uses NIP-09 for advisory relay removal and makes no stronger cross-relay promise. See §R11.18 for the decision record.

## R14. Folder zines pin recursive trace frontiers

Treating folders as mere organization loses the cross-file process that makes
Root and subtree replay useful. A folder zine therefore pins the exact head of
each direct child; recursively, those heads define one complete content tree
and descendant trace frontier. A child's new checkpoint must advance every
ancestor to Root even when the child's body hash is unchanged.

That logical rule does not turn the automatic cascade into many author
gestures. `folderCheckpoint.cause` separates the selected explicit Step or
structural operation from derived `child-advance` checkpoints, and
`operationId` lets a reader collapse or expand the signed cascade. The
`advance` delta exists because overloading `add` for an already-present member
would falsely claim a membership change and make replay semantically wrong.

Only immediate-member snapshots are duplicated at each level. A press may use
content-addressed structural sharing and bundle compression physically, but it
must preserve the same logical recursive frontier and bounded verification.

---

# Open questions

- **Branch detection.** `TraceHead` resolves head *lookup* and races, but two live branches (a true concurrent split) still need surfacing and a merge nudge; detection is the old scan for multiple uncited heads. Unilateral merge (§3.8) is useless if the owner never notices a fork worth incorporating.
- **Merge conflict resolution (client/UI only).** Wire semantics of merge are fixed (§3.8): unilateral, owner-signed, selective acceptance native. The reference press ships a line-based three-way UI (base / ours / theirs with per-hunk ours|theirs|both|base choices) for file content; folder membership three-way and CRDT helpers remain open. Not a protocol change.
- **Upstream re-sync into a fork.** Mechanically the same unilateral merge as any other (§3.8): `action: merge` on the fork chain with the source's newer node as a merge-parent. Deferred only for the conflict-UI question above, not for missing wire shape.
- **Relay-side validation policy.** Operator policy, but a reference policy should ship with the relay.
- **Kind and tag registration.** Kinds
  `4290`/`34290`/`34291`/`4293`/`4294` and tags `z`/`f`/`F` remain
  provisional. A 2026-07-15 scan found no collision for the five kinds in the
  current NIPs table, but that is not registration. Kind `34292` remains the
  parameterized replaceable Voice Identity kind, not a trace kind. Retired
  uppercase `Q` is outside the current registration surface (§R11.26).
- **Folder snapshot growth.** See §R10.
- **Position-only deltas.** Non-citation deltas could carry two spans instead of `newValue`, resolvable entirely from snapshots. Deferred for simplicity.
- **`sourceContentHash` granularity.** Span-level (specified) vs. whole-snapshot-level, which would also let a verifier ask "is the source itself intact."
- **Named-file `x` participation.** Whether named files emit `x` for cross-folder copy detection, or opt out so byte-identical files aren't surfaced as duplicates.
- **Tag cap.** Whether a trace bounds how many zines it can tag (an earlier system settled on 1–7) or is unbounded.
- **Citing unpublished traces.** Works mechanically (every node has a snapshot); whether to encourage it, or restrict citation to signed/stepped traces, is unsettled.
- **Model-dependence of the `Δ` interval label.** The A/B/C (§R12) found the `ΔNm/Nh/Nd` annotation inert for glm-5.2 — the model computes durations from timestamps itself. Whether it is load-bearing for other models is untested. If confirmed redundant across models, the interval can be trimmed from the context block to reduce prompt noise.
- **`TraceAnnotation` (§11).** The accumulating comment/marginal-note primitive — wire shape sketched around a minted-anchor target (§R4 inherited; no bare position pointer). Open sub-questions are head-following vs version-pinning (reader policy, not wire), thread nesting depth, and retention. The reaction-token case (§5) is closed; this is the remaining open half.
- **Reachability after a removal request.** NIP-09 does not standardize tombstones or re-publication behavior. One relay may accept the same event id again while another keeps suppressing it. Zine therefore makes no "revive under the same id" guarantee. Minting a new genesis provides a fresh address when renewed reachability matters, while the old id remains subject to each relay's retention policy.

# Trace Provenance Protocol (draft)

Status: draft, unpublished, breaking changes expected. Kind numbers are provisional.

**Reading guide.** Part I is the normative specification — what an implementation MUST do, each requirement stated once, RFC-2119 keywords binding. Part II is rationale and design history — why the spec is shaped this way, argued once, binding no one. Open questions close the document.

## Vocabulary

A **trace** is the protocol's single primitive — a body carried on an append-only chain of signed checkpoints. It is reified as a **file** (body = text) or a **folder** (body = an ordered membership list); a **minted span** is an immutable single-node file trace minted from a span of another trace. A **press** is the client interface a trace is authored in — the editor, not a server. A **relay** is the Nostr server a press seals traces to, local (every press seals to at least one, bound to the author's own machine) or remote. A **zine** is a published trace, most often a folder. "Run your own press" = write in your own copy of the interface, sovereign by default since it already seals to a relay of its own. "Hit ZINE" = publish + sign a trace.

Two identity terms recur throughout:

- **Trace identity** — the event id of the trace's **genesis node**, fixed for the trace's whole life. Globally unique with no separate namespace to manage. Folders have no other id: what an earlier draft called `folderId` *is* the folder trace's genesis node id.
- **Nucleus** — the trace's current head node: the latest node on the `e…prev` chain for a mutable trace, or the one fixed node of an immutable span. Citations pin a nucleus (a specific version); identity names the chain.

---

# Part I — Specification

## 1. Event kinds

| Kind (provisional) | Name | Class |
|---|---|---|
| `4290` | `TraceNode` | Regular (non-replaceable) |
| `34290` | `TraceHead` | Parameterized replaceable |
| `34291` | `TraceOpinion` | Parameterized replaceable |
| `4293` | `TraceAnnotation` (deferred — §11) | Regular (non-replaceable) |

`TraceNode` chains are the **source of truth**; they are never replaceable. The two replaceable kinds carry current-state only: `TraceHead` is a pure cache and `TraceOpinion` is a per-author opinion whose correct semantics is last-write-wins. Losing either never loses history (§9). `TraceAnnotation` is deferred (§11) — its shape is argued here so the placeholder sits in the kind table, but no implementation is required and the kind number is held, not burned.

**Kind-number ranges (NIP-01).** Regular kinds live in `1000-9999`; parameterized-replaceable kinds live in `30000-39999`. `TraceNode` (4290) and `TraceAnnotation` (4293) are regular → 4xxx; `TraceHead`/`TraceOpinion` (34290/34291) are replaceable → 34xxx. This is why `TraceAnnotation` is 4293, not 34292: `34292` is already in use as the Voice Identity kind (parameterized-replaceable, `d` = pubkey — see `provenance.ts`), and a non-replaceable kind has no business in the replaceable range. (`34292` was briefly listed here for TraceAnnotation before the range rule was applied; that was the bug this note replaces.)

## 2. Conventions

- **Hashes** are SHA-256, encoded as lowercase bare hex, in tags and content alike. No `sha256:` prefix anywhere.
- **Delta timestamps** are integer milliseconds since the Unix epoch.
- **Offsets and lengths** (delta positions, `authors[].len`) count UTF-16 code units of the snapshot string — JavaScript string-index semantics.
- **Ordering** always comes from the `e…prev` chain, never from `created_at` (NIP-01's second resolution is too coarse; see Part II §R2).
- **Canonical folder body** — a folder's hashable body is the projection `[[relativePath, kind, memberContentHash], …]` in member order, serialized as JSON with no insignificant whitespace, UTF-8 encoded. `kind` is `"file"` or `"folder"`. `memberContentHash` is the member's own canonical-body hash: for a file member, the SHA-256 of its snapshot text; for a folder member, its own canonical folder body hash (recursively defined, but read off the member's stored `contentHash` field — see §3.2). The projection is **shallow-local**: hashing an outer folder reads only its immediate members' stored hashes, never their chains. This is the Merkle-with-pointer rule — each member's recursive hash is precomputed at its own seal and stored on the parent's member entry, so the outer hash is O(immediate members) regardless of depth. `latestNodeId` is **excluded**, so two independently built, content-identical folders hash identically (see Part II §R3).

## 3. TraceNode (kind `4290`)

One sealed checkpoint of one trace. Every node is self-sufficient: it MUST carry its full `snapshot` (§3.2), so resolving any cited node is one bounded fetch, never a chain replay.

### 3.1 Tags

| Tag | Meaning |
|---|---|
| `["z", "file" \| "folder"]` | Reification discriminator. REQUIRED on every node. |
| `["f", folderGenesisId]` | The folder this trace resides in. REQUIRED on file nodes (minted spans included — their path is synthetic). On folder nodes it carries the folder's **own** genesis id and is REQUIRED on every node except genesis itself (an event cannot know its own id before signing). `#f=[id]` returns every node **directly** in a folder — the folder's own chain and its immediate members' nodes; `#z` splits them. A folder member's own members are NOT found transitively: reading a whole tree is bounded fan-out (one `#f` query per folder member, recursing by depth). |
| `["F", relativePath]` | Structural name for named file **and folder member** traces: the member's name within its immediate parent folder. Single-segment (no `/`) — hierarchy is expressed via folder-members, not slash-joined paths. Absent on nameless spans and on a folder's own genesis. |
| `["e", prevNodeId, relayHint, "prev"]` | Node this one supersedes. Absent only on genesis. |
| `["e", parentNodeId, relayHint, "merge-parent"]` | Zero or more, merge nodes only — one per branch reconciled. |
| `["e", originNodeId, relayHint, "extracted-from"]` | REQUIRED on minted-span nodes — the exact node-version the span was pulled out of. Absent on whole-file genesis imports. |
| `["e", sourceNodeId, relayHint, "forked-from"]` | REQUIRED on fork-genesis nodes (§3.8) — the exact node-version the trace was seeded from. |
| `["x", bodyHashHex]` | Body hash (per §2). REQUIRED on minted-span nodes and on folder nodes; OPTIONAL on named file nodes (open question). `#x` finds every trace with an identical body, whoever minted it. |
| `["q", nucleusId, relayHint, ownerPubkey]` | Out-edges: the traces this node composes. NIP-18 quote-tag shape. The list is the full **current** set of active out-edges — cumulative, not incremental. On folder nodes, one per member; **`q`-tag order MUST equal `snapshot.members` order** — member ordering is stated once, in two places that MUST agree. |
| `["t", label]` | Lexical mirror, emitted only alongside a `role: "tag"` cite (§3.3): the tagged zine's name, giving generic Nostr clients zero-resolution `#t` discoverability. |
| `["action", actionType]` | Advisory summary; see §3.4. |
| `["g", geohash]` | OPTIONAL, folder nodes only. A base-32 geohash the zine is pinned to for spatial browsing (Spaces view). **Arbitrary length** — length encodes precision (a length-2 cell is ~continental, length-8 is ~street-level); cells are prefix-hierarchical, so a coarser pin's cell contains every finer pin that shares its prefix. A node MAY carry several `g` tags. The current set is republished on the folder node; `g` does NOT enter the canonical body hash (curation surface, not content). `#g` gives relay-side cell filtering. |

### 3.2 Content

```json
{
  "snapshot": "…file text…",
  "deltas": [ … ],
  "contentHash": "…hex…",
  "voices": [ "<signer pubkey>", "<other voice pubkey>", … ],
  "authors": [ { "v": "<pubkey>", "len": 42, "src": "<nodeId>" } ],
  "summary": "optional",
  "prompt": "action: llm only — the instruction itself",
  "injectRule": "<event id of a minted rule trace — action: llm only>",
  "llm": { "model": "…", "temperature": 0.7, "maxTokens": 4096, "provider": "openai | anthropic | …" },
  "contributors": [ { "type": "human | llm | agent", "pubkey": "…" } ]
}
```

For folder nodes, `snapshot` is instead:

```json
{ "members": [ { "kind": "file", "relativePath": "essay.md", "latestNodeId": "…", "contentHash": "…hex…" } ] }
```

`kind` is `"file"` or `"folder"`. Absent on legacy nodes (pre-nesting) — readers default `"file"`, the only member kind before this revision. `relativePath` is single-segment (no `/`); it names the member within its immediate parent only — hierarchy is expressed via folder-members, not slash-joined paths. `contentHash` semantics are per-kind: the file body hash (SHA-256 of the snapshot text) for `kind: "file"`; the folder's own canonical folder body hash (§2) for `kind: "folder"`. The folder-member's hash is precomputed at its own seal and stored on the parent's entry, never recomputed by walking the member's chain (shallow-local, §2).

- `snapshot` — REQUIRED on every node this protocol's triggers produce. Full file text, or full ordered membership. Retention may shed `deltas`, never `snapshot` (§9).
- `contentHash` — REQUIRED. Files: SHA-256 of the UTF-8 snapshot text. Folders: SHA-256 of the canonical folder body (§2) — the projection, not the raw snapshot, so resolution metadata (`latestNodeId`) never perturbs the hash. `contentHash` MUST NOT incorporate any name or path.
- `authors` — OPTIONAL per-character attribution; see §3.6.
- `voices` — OPTIONAL symbol table for per-delta attribution (§3.3, §3.6). An array of pubkeys; the node signer SHOULD be `voices[0]` so a delta that omits `author` (defaults to signer) and one that carries `"author": 0` resolve to the same key. A delta's `"author": <index>` resolves as `voices[index]`. Absent on mono-author nodes and on legacy nodes written before per-delta attribution; readers treat a delta with no `author` as signer-attributed regardless. The table is local to this node — every node that needs it carries its own — so a reader never resolves across events.
- `prompt` / `injectRule` / `llm` — `action: llm` only; see §3.7. `llm` records the call params (`model`, `temperature`, `maxTokens`, `provider`) so a reader knows not just what was asked and what was in scope, but which model configuration answered. `temperature` is `number | null`: the actual value sent, or `null` when the caller sent none (the provider applied its own default) — never a placeholder `0`, which would falsely claim deterministic decoding.
- `contributors` — OPTIONAL roster of participants in this checkpoint, each `{ type, pubkey }`. This is the single carrier for "a non-signer contributed here" (an earlier `actor` tag is retired — see §R11).

### 3.3 Deltas

`deltas` is OPTIONAL: absent on genesis, on nodes whose producer has nothing to say about *how* the body arrived, or shed under retention. When present, applying the deltas in order to `prev.snapshot` MUST reproduce `snapshot` exactly (§3.5).

Body-edit types (file nodes):

```json
{ "type": "insert | delete | replace", "position": { "start": 42, "end": 42 }, "newValue": "…", "author": 1, "timestamp": 1730000000000 }
```

No `oldValue` field — it is recoverable as `prev.snapshot.slice(start, end)` and `applyDeltas` never reads it.

`author` — OPTIONAL integer index into the node's `voices` table (§3.2): the delta's text is attributed to `voices[author]`. When omitted, the delta is attributed to the node's signer (`event.pubkey`), which is why `voices[0]` SHOULD be the signer — a delta with no `author` and one with `"author": 0` then resolve to the same key. This makes per-delta attribution the primary, O(1) attribution path (§3.6): a reader learns who wrote each inserted span straight off the delta + the node-local table, with no reconstruction and no cross-event resolution. The field is a signer claim, same trust posture as `authors` — forgeable by the sealer, never seam-verifiable for in-session co-authorship (the human–AI loop has no merge seam; §R5). Omit it on mono-author seals (where every delta is the signer's) and the default-to-signer rule keeps the wire compact: a mixed-voice seal pays one `voices` array per node and one digit per non-signer delta, instead of repeating a 64-char pubkey. A reader that finds an `author` index that is missing, non-integer, or out of range for `voices` MUST treat the delta as signer-attributed (default-to-signer), not as malformed — the node is still a valid node, just under-attributed for that delta. Present only on body-edit deltas — `cite`, `focus`, and membership deltas carry no `author` (their signer *is* the actor; there is no text to attribute).

Membership types (folder nodes):

```json
{ "type": "add | remove", "kind": "file | folder", "relativePath": "essay.md", "nodeId": "…", "timestamp": 1730000000000 }
{ "type": "rename", "kind": "file | folder", "fromPath": "essay.md", "toPath": "draft.md", "nodeId": "…", "timestamp": 1730000000000 }
```

No `reorder` delta: member ordering is fully recoverable from `snapshot.members` (and from the canonical body of §2, whose projection is the ordered `(relativePath, kind, memberContentHash)` list), so a dedicated ordering delta would be redundant provenance color. `add`/`remove`/`rename` are the three structural facts a folder asserts about its membership. The `kind` field mirrors the member entry (§3.2): `"file"` or `"folder"`, absent on legacy deltas (default `"file"`).

`rename` is a structural path change — a folder-owned fact about where a member lives, the same class of event as add/remove. It is distinct from `TraceOpinion`'s `name` (§5/§R6): an opinion is an author-scoped display label (replaceable, deliberately history-less), whereas `rename` is a folder-chain event with full history. A member can be structurally renamed zero or many times and independently carry any number of per-author opinion-names; the two axes never interact. Renaming a `kind: "folder"` member changes its name in the **parent** only — it does not rewrite the renamed folder's own chain (its members' `relativePath`s are names within *it*, unaffected).

Citation type (both reifications) — **one delta type, five roles**:

```json
{
  "type": "cite",
  "role": "inline | live | tag | reply | content",
  "op": "add | remove",
  "position": { "start": 10, "end": 52 },
  "newValue": "…",
  "sourceEventId": "…",
  "sourceContentHash": "…hex…",
  "hash": "…H, 64-char hex (role: content only)…",
  "source": { "work": "optional", "edition": "optional", "locator": "optional" },
  "relayHint": "ws://… (role: content only)",
  "timestamp": 1730000000000
}
```

- `role: "inline"` — a frozen quote: `newValue` came from a minted node, not typing; `position`/`newValue` present; body changes.
- `role: "live"` — a transclusion that tracks its source's head. Reserved; not yet specified beyond the delta shape.
- `role: "tag"` — a zine tagged onto this trace: no `position`, no `newValue`; body untouched. The only role for which `op: "remove"` is meaningful (untagging).
- `role: "reply"` — this whole document replies to another sealed trace: no `position`, no `newValue`; body untouched.
- `role: "content"` — a quote of **orphan text** with no origin node in the system (print, oral, sourceless). The rendezvous cite: keyed on `hash` (the content hash `H = sha256(canonical(quote))`), not on `sourceEventId`. Carries the verbatim bytes in the `quote` field (verification metadata, NOT body content — no `position`, so `snapshot`/`contentHash` are untouched), an OPTIONAL `source` (work/edition/locator — distinguishes readers from scrapers), and a `relayHint` for co-citer reachability. Derives a top-level `["Q", H, relayHint, "implicit"|"attested"]` tag — single-letter `Q` (not `cite-content`) so `#Q=H` queries work on standard NIP-01 relays; lowercase `q` is node-citation, uppercase `Q` is content-citation. See `rendezvous.md` §1. The only cite role without a `sourceEventId` or matching `q`: there is no node to dereference.
- `op` defaults to `"add"` and MAY be omitted.
- Every `cite` with `op: "add"` (other than `role: "content"`) MUST have a matching top-level `q` tag pinning `sourceEventId`; `op: "remove"` removes the corresponding `q` from the current set. `sourceEventId` is pinned to the source's nucleus **at the moment of citing**, even if the source's chain moves on.
- `sourceContentHash`, if present, is the hash of the cited span/body as it appears in the source — lets a verifier catch a fabricated citation without reconstructing the source (§3.9).

Observation type (folder nodes):

```json
{ "type": "focus", "op": "mount | unmount", "selection": { … }, "panelIndex": 1, "timestamp": 1730000000000 }
```

A `focus` delta records panel occupancy — session-replay data, not membership. `op: "mount"` (the default; MAY be omitted) means a trace was mounted into a panel; `op: "unmount"` means the trace that was there left (tab closed, panel collapsed, no successor selected). It MUST NOT alter `snapshot` or `contentHash`. **Focus deltas never mint their own nodes**: they accumulate in the press's local buffer — one entry per `panelIndex`, coalescing rapid changes — and ride along on the next node sealed for that folder chain, or on an explicit session-close checkpoint (§8). The `selection` payload names what was focused, mirroring the reifications:

```json
{ "kind": "file",   "path": "essay.md", "nodeId": "…" }
{ "kind": "folder", "path": ".",        "nodeId": "…" }
{ "kind": "span",   "nodeId": "…", "phrase": "the cited words", "originPath": "essay.md" }
```

### 3.4 Action (advisory)

`["action", actionType]` is a one-word summary for indexing and display. It is **derived, advisory metadata**: readers MUST NOT treat it as authoritative — the deltas and edge tags are. When a node qualifies for more than one (a checkpoint capturing typed text *and* a paste since the last seal), the action is chosen by precedence:

`affirm > merge > fork > delete > llm > import > cite > paste > edit > external > focus`

| Action | Meaning | Distinguishing tags |
|---|---|---|
| `import` | Genesis — first-observed content, or a span just minted | no `prev`; `extracted-from` + `x` if a minted span |
| `fork` | Genesis seeded from another trace's node under a different owner | `forked-from`, no `prev` |
| `edit` | Ordinary change | `prev` |
| `external` | File changed outside the traced editor — disk drift detected at next app open or poll, or an external process / MCP tool wrote it. Signed by the external actor's voice (a per-machine reconciler key for bare drift, a per-actor key for MCP callers), never the authoring key. The authoring key only signs changes the editor's own transactions produced. `authors` is omitted, so reconstruction attributes the bytes to the external voice's pubkey (Tier-2 signer attribution, §3.6) — honestly low-trust: the signer claims only "the machine's state moved," not "the human typed this." Per-actor distinction is carried by the signer pubkey, not this tag. | `prev`; signed by the external voice |
| `paste` | Pasted content, possibly minted elsewhere | `prev`, `q` if sourced |
| `cite` | Primary purpose is a citation — inline quote, tag, or reply | `prev`, `q` |
| `llm` | Checkpoint around an LLM call | `prev`, `prompt` |
| `merge` | Owner accepts content from one or more other chains into this one | `merge-parent` × N |
| `delete` | Trace removed, history retained | `prev` |
| `affirm` | Author affirms a sent node as their published position. Decoupled from Send (§8): the author Steps (seal locally), Sends (push to external relay), then Affirms *after* the node has been read and the author stands behind it. Named `affirm` (not `sign`) to avoid collision with crypto-signing: every seal is signed, but not every seal is affirmed. | `prev`; the affirmed node MUST have been Sent first |
| `focus` | Node exists only to flush batched focus deltas (session close) | `prev` |

### 3.5 Integrity

For any non-genesis node: `applyDeltas(prev.snapshot, deltas) === snapshot`, checkable against a single prior node — never the whole chain.

- **Cheap:** `hash(body) === contentHash` (per §2).
- **Full:** apply `deltas` to `prev.snapshot`, compare to `snapshot`. O(content), independent of chain depth.

### 3.6 Attribution

Attribution is carried at two layers, in priority order: per-delta (primary) and node-snapshot (legacy). A reader reconstructs authorship by reading each delta's `author` index, resolving it through the node's `voices` table (§3.2), and defaulting to the node signer (`event.pubkey`) when the index is absent or out of range. The result is a per-character attribution of `snapshot` recoverable in one forward pass over a single node's deltas — O(content), independent of chain depth — without an `authors` map, a sum-check, or a separate reconstruction tier.

`authors` — OPTIONAL, now the secondary carrier. An ordered run list covering `snapshot`: run *k* attributes the slice beginning at the sum of all prior `len` values, for `len` UTF-16 code units, to pubkey `v`. The `len` values MUST sum to exactly the snapshot's length; on any mismatch a reader MUST treat `authors` as absent and fall back to per-delta + signer attribution. Runs carry no text — the body is stored once, in `snapshot`.

- `v` — the author's pubkey.
- `len` — run length in UTF-16 code units.
- `src` — OPTIONAL: the event id of a node **signed by `v`** in which this run's text appears, making verification a single fetch.

`authors` predates per-delta attribution and remains the only carrier on legacy nodes (written before per-delta `author` existed), on bare-snapshot resets (genesis/import from plain text, deletes), and as a redundant cross-check when both are present. A node MAY carry both; when they disagree, per-delta is authoritative for the deltas it covers and `authors` is treated as stale. The field is retained, not deprecated — `src` verification (below) operates on `authors` runs, which carry corroborating-node pointers that per-delta `author` does not.

**Per-delta is the right layer for in-session co-authorship; `authors` is the right layer for verified cross-authorship.** The two solve different problems. Per-delta `author` records who produced each span during a seal — the human–AI loop, multiple in-process voices, any case where text enters the buffer without crossing a chain seam. It is O(1) per delta, independent per delta (one corrupted delta doesn't poison the rest), and needs no reconstruction. `authors` runs carry `src`, the corroborating-node pointer, so a run attributed to pubkey P can be **verified** when its text is derivable from a node signed by P reachable via the seam edges: `merge-parent`, `extracted-from`, `forked-from`, or `q`. That verification is meaningless for in-session co-authorship (the AI's text enters via a function call, not a seam edge — §R5), which is exactly why per-delta attribution is the primary path and `authors`' verification machinery is reserved for the case it actually serves.

**Trust posture, unchanged.** All attribution signals on a node — signer, per-delta `author`, `authors`, `contributors` — are claims by the node's signer. A run that can be corroborated via a seam edge + `src` is **verified**; otherwise it is **asserted**, and clients SHOULD render the two states distinguishably. This is the same epistemic status citation already holds (§3.9): asserted, cheaply checkable, degradable — never silently trusted, never requiring the attributed author's cooperation to seal. Per-delta `author` is asserted-attributed by construction; it cannot be seam-verified, because the spans it points at were never signed by their attributed author as standalone nodes. That is the honest status for the no-seam case, and §R5 argues it is the right one.

**Multi-author means multi-chain — for verified attribution.** Concurrent authorship that you want to *verify* happens under distinct keys on distinct chains, joined by `merge` — which is what makes every legitimate cross-author run corroborable in principle (the merge-parent *is* a node the other author signed). In-session co-authorship (a human and an AI under keys the human controls, multiple voices on one chain) is *asserted*-attributable via per-delta `author` but not seam-verifiable; the spec says so rather than pretending otherwise.

### 3.7 LLM checkpoints and injection

An `action: llm` node's `prompt` is the instruction only — what a human typed or an agent decided to ask. Everything else the model saw (folder content, a roster, pinned traces) is NOT duplicated into the node: the node's `q` tags cite whatever was in scope, each cited node already self-sufficient, and `injectRule` names the deterministic procedure that expands those citations into the literal submitted prompt. The `llm` field records the model configuration (`model`, `temperature`, `maxTokens`, `provider`) so a reader knows which call answered.

**A rule is a minted trace carrying a named-algorithm manifest.** `injectRule` carries the event id of an immutable minted span whose body is a JSON manifest `{ "algorithm": "<name>-v<n>", "params": { … } }` — NOT executable code. The algorithm is a named, versioned, deterministic procedure shipped in the reader's binary (e.g. `ctx-block-v1`); the manifest names which one and its parameters (which context-block variant, whether sibling text is included, the role preamble). Rule immutability is guaranteed by the protocol itself, not by registry discipline: evolving a rule means minting a new rule trace carrying a new manifest and citing the new id. Two readers implementing the same algorithm version produce byte-identical reconstruction; a reader that doesn't know the algorithm degrades — the scope `q`-tags still show *what* was in scope, but the assembled prompt can't be rebuilt. There is no executable code on the relay: execution-from-relay is rejected on the same trust posture as §3.9/§R5 (verifiable, not trustless).

Given `prompt` + the rule manifest + the cited nuclei, a reader whose binary implements `algorithm` can reconstruct the exact context a past call received: memetic lineage as a simulation, not a stored transcript. The manifest MAY cite a Query spec (§R9) as one of its params, so a rule can draw its scope from a query rather than a fixed folder.

### 3.8 Minting, brackets, forking

**Bracket syntax** (in file bodies):

```
[[ some phrase ]]              unresolved — rewrite-protected, not yet a trace
[[ some phrase | eventId ]]    resolved — minted, permanently addressable, frozen
```

Everything outside brackets is fluid by default. A bare bracket is rewrite protection only: it shields a span from silent drift across LLM rounds without minting anything, and vanishes if its paragraph is deleted. A bare bracket is NEVER auto-resolved by coincidental text match — resolution is always an explicit act.

**Minting pass** (client- or CLI-triggered), for each unresolved bracket:

1. Read the current span text.
2. Seal a new file-reified `TraceNode`, `action: import`, `snapshot` = that text, no `prev`. Path is synthetic (`<originDoc>#<spanId>`) in the origin document's folder (`f` tag), so it stays discoverable by folder scan. Tags `extracted-from` (the exact origin node-version) and `x` (body hash) — both REQUIRED.
3. Rewrite the bracket in place to `[[ text | newNodeId ]]`. That edit is an ordinary `cite` delta (`role: "inline"`, `sourceEventId: newNodeId`) on the origin document's next seal, mirrored as a top-level `q` tag.

Minting captures what's there *now* as a fresh trace; it does not reconstruct a pre-mint history for the span. Once resolved, the id is stable — later rounds cite the same trace. A minted span MAY be named at mint time via `TraceOpinion` (§5).

**Resilience across edits.** A resolved bracket survives an edit iff its old-content position range overlaps no span in the diff the seal already computes — an interval-overlap test, no fetch. Splits survive (both halves keep citing the same id), textual merges survive (two adjacent citations), and any overlapping edit destroys the bracket: the `| eventId` suffix drops, the text reverts to fluid, the cited trace itself is untouched. This is local continuity only — whether a citation was honest is §3.9's separate, reader-triggered check.

**Rewrite protection.** In the LLM loop a bracket is an explicit instruction that the span is fixed: the harness restores canonical bracket markup over the model's version before sealing. Restored text diffs as equal, so the resilience check sees the bracket as untouched — the two layers compose without special-casing. There is no separate pin mechanism; brackets are the single protection marker, read from content.

**Forking.** A trace has exactly one owner — the key that signs its nodes. To work on someone else's trace, seed a new trace under your own key from the source's current node: genesis `action: fork`, `snapshot` verbatim (hence colliding `x` — deliberately, see §R3), `forked-from` the exact source node-version, **no `q` to the source**. Fork is derivation, not composition — the fork diverges freely and the source owes it nothing. Fork identity is the fork's own genesis id.

| relationship | source preserved? | lineage edge | result |
|---|---|---|---|
| `cite role: inline` | yes — frozen, pinned | `q` + `sourceEventId` | a citation inside the citing trace |
| `cite role: live` (deferred) | yes — tracks source head | `q` | a transclusion |
| `fork` | no — copy diverges | `forked-from` | a new mutable trace, new owner |
| `merge` | yes — source chain untouched | `merge-parent` | a new node on *this* chain incorporating the parent |

**Merging.** A merge is a unilateral editorial act by the owner of the chain being extended. To incorporate work from another chain (typically a fork of this trace, or an upstream head when re-syncing a fork): seal one `TraceNode` on *this* chain, signed by this chain's owner, with `["e", prev, …, "prev"]` to the current head, one or more `["e", parentNodeId, …, "merge-parent"]` tags naming the foreign head(s) being pulled in, `action: merge`, and a `snapshot` that is the reconciled body the owner chooses to publish. Integrity is unchanged (§3.5): deltas applied to `prev.snapshot` MUST reproduce `snapshot`. Attribution of foreign runs verifies via the merge-parent seam (§3.6) when `src` names a parent-signed node that carries the text.

Normative constraints:

- **Only this chain's owner signs the merge node.** The owner of a merge-parent chain does not sign, approve, or need to be notified. Merge validity requires no cooperation from any parent author — the same posture as citation (§R5).
- **Identity stays this chain's.** The merge extends the existing genesis; it does not create a new trace and does not reassign ownership.
- **Parents persist.** A merge does not consume, close, or retract any merge-parent chain. The parent remains a first-class, addressable trace; further work on it and later re-merges are ordinary.
- **Selective acceptance is native.** The merge `snapshot` is whatever the owner seals. Taking only some of a parent's content, rewriting the rest, or adopting the parent snapshot wholesale are the same gesture — not distinct protocol modes. Overlapping concurrent edits (both sides advanced past a common ancestor) are a client/UI concern; the wire only requires a self-consistent node.
- **Either direction is the same shape.** Pulling a fork into the source, or re-syncing a fork with a newer source head, are both `action: merge` on the *receiving* chain under that chain's owner. Unilateral means per receiving chain, not "only the original author forever."
- **Endorsement is not merge.** Social reconciliation ("the parent author affirms their words in this new context") is a separate, optional speech act if ever specified; it is NOT required for a merge to be valid or for attribution to verify.

| relationship | who signs | other party needed? | result |
|---|---|---|---|
| `fork` | new owner (B) | no | B proposes under B's key |
| `merge` | receiving chain's owner (A) | no | A accepts under A's key |

**Folder forks are shallow, with fork-on-write.** A forked folder node (your key, `forked-from` the source folder node, fresh identity) carries `q` tags at the *source's* member nodes. Editing a member you don't own first forks that member (verbatim snapshot, `forked-from`), then repoints the membership entry at your fork. Untouched members remain ordinary citations to the source owner's traces — stable, attributable, uncoupled. Ownership is read off each cited node's signer, never off the folder: the folder owns its membership list, not its members.

**Folder members under fork (specified, implementation deferred).** A forked folder's `kind: "folder"` members stay cited to the source's folder node at fork time, same shallow-cite rule as file members. Editing anything *inside* a folder member requires recursive fork-on-write: mint a new subfolder genesis under your key (`forked-from` the source folder node), recursively fork-on-write each of *its* members, repoint the new subfolder's membership at your forks, then repoint the outer folder's membership entry at the new subfolder. **Cycle guard required**: a folder that contains itself transitively would infinite-loop the recursion, so seal-time enforcement forbids `q`-tag cycles — a folder member's cited nucleus MUST NOT be an ancestor of the citing folder. The wire shape (member `kind`, the `forked-from` edge on a folder member's genesis) is in this revision; the recursive fork-on-write write-path is implementation-deferred.

### 3.9 Verifying a citation

A cited node carries its own `snapshot`, so confirming a quote is real is O(source snapshot), never O(source chain). `sourceContentHash` sharpens it: hash the citing delta's `newValue` (O(span), no fetch), then check that hash against the source's snapshot (one fetch). Not trustless — full verification still means reading the citing document — but bounded and cacheable. Missing cited events **degrade rather than break**: the citing document renders from its own snapshot (the quoted text is already inlined); only verification fails. A missing npm dependency breaks a build; a missing cited event leaves an unverifiable but readable document. A reader that observes a kind-5 deletion request (§10) referencing a cited node SHOULD treat the node as withdrawn — its cryptographic integrity is unchanged, but its availability is not guaranteed, and the citation SHOULD be flagged as revoked rather than verified.

## 4. TraceHead (kind `34290`)

Parameterized replaceable. `d` = trace identity (genesis node id). Content:

```json
{ "head": "<current nucleus event id>" }
```

A pure cache, written by the trace's owner on every seal, giving O(1) head lookup and a write-time tie-break for multi-device races. It MUST yield to the chain wherever they disagree; losing it degrades head lookup to a scan (`#f` for the folder, then the uncited head) — the recovery path that was previously the only path. Meaningful only for mutable traces; an immutable span's nucleus never moves.

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

## 8. Seal triggers

A trace node is sealed — signed immediately, written to the local relay — at:

- **External write (file).** File changed outside the traced editor; deltas computed by diffing last-known content against disk. Sealed as `action: "external"` (§3.4) under the external actor's voice — a per-machine reconciler key for bare disk drift, or a per-actor key for an MCP tool — not under the authoring key. A brand-new file is still `action: "import"` (genesis is honest provenance vocabulary), but signed by the reconciler voice so the attribution is honest. The authoring key signs only changes the editor's own transactions produced; this trigger is the one place it never does.
- **Step (file).** A deliberate author action — the Cmd+S "save" gesture. A Step is the rhythm-layer unit: frequent, local, may not seal on its own (it can batch as a `checkpoint` delta onto the next seal, the same way `focus` observations do — §R7). When a Step does seal (the common case today), it mints an `action: "edit"` node carrying the snapshot. The word "save" is deliberately retired from the protocol vocabulary to avoid implying that every save is a publish — saves are steps, not sends.

  **Distributed anteriority (NIP-03 on Step).** Step is the one gesture that mints a trustless third-party timestamp, via a NIP-03 kind-1040 attestation stamping the Step node's event id against Bitcoin (OpenTimestamps). This reverses an earlier decision (§R11.20) that put anteriority on Affirm alone — one anchor is useless as a process signal; the sybil-filter that anteriority enables needs *density*, and density requires the frequent gesture to stamp. See `rendezvous.md` §3 (Step stamps, not Affirm) and §R11.20(b) for the reversal argument. The attestation is fire-and-forget: the Step seal returns immediately, the OTS proof resolves asynchronously against the author's self-hosted calendar and upgrades in place by a later sweep. Self-hosting on the author's super-peer (`transport.md` §2) preserves Step's sovereignty semantics — no third-party calendar sees the hash.
- **Membership change (folder).** A member added, removed, or reordered.
- **Tag change (file or folder).** `snapshot` unchanged from `prev`; deltas carry the `cite role: "tag"`; `q` tags updated; `contentHash` unaffected.
- **LLM invocation.** Sealed immediately (`action: llm`) with the prompt, before any write-back becomes its own node.
- **Minting.** Each resolved bracket seals its own trace (§3.8).
- **Fork.** Opening another owner's folder, or fork-on-write of a member (§3.8).
- **Session close.** Flushes batched `focus` deltas (§3.3) if any are pending and no other seal carried them.
- **SEND.** Pushes one already-sealed node to an external relay (a super-peer, a peer's relay, the wider network). Send is a destination act, not a signing act — the node was already signed when it was sealed. What Send changes is reachability: the node leaves the author's machine and becomes fetchable by others. Not every Step is Sent; most stay local (drafts, experiments, dead ends). The author curates what leaves their machine — the sovereignty filter.

- **AFFIRM.** A separate, later act: the author marks a *sent* node as their published position (`action: affirm`). Affirm is decoupled from Send — it comes *after* the node has been sent and read, not as a side effect of pressing publish. The Send→Affirm gap is where the work gets tested: the author Sends, a peer reads and responds, and only then does the author Affirm "this is my stand." Affirming a node that was never Sent would be claiming a public position for something no one can fetch — a lie by construction. Affirm without prior Send is therefore invalid. (Previously ZINE bundled send + affirm into one gesture; the decoupling makes Affirm a true post-hoc endorsement of a specific sent node, and aligns it with §R5's deferred endorsement event applied to one's own work.)

  **Anteriority attestation (NIP-03, optional, inherited).** Affirm's load-bearing anteriority is now inherited transitively from the cited node: the affirmed node was sealed by a Step, and Step stamps (§8, above), so an affirmed node is already anchored to Bitcoin by its own save history — no separate stamp on Affirm is needed for vetting. Affirm MAY still carry its own stamp, for a different purpose: proving *when the author endorsed* as a distinct claim from *when the content existed*. When present it is published asynchronously after the affirm node seals — it never blocks the gesture — and is strictly additive: the affirm node's signature, content, and reachability are unchanged whether or not the attestation lands. A partial proof (calendar submission confirmed, Bitcoin confirmation pending) is published immediately and upgraded in place by a later sweep once the digest lands in a block. See §R11.20 and `rendezvous.md` §3.4.

**Focus buffer drain.** The focus buffer is per-folder. Any folder-chain seal (the membership and tag triggers above) drains that folder's pending focus deltas into its `deltas` array, so the observations ride along as additional entries on a node that was sealing anyway. The session-close trigger exists only to cover the case where the session ends with focus pending and no further seal fires — it mints a dedicated `action: "focus"` node carrying the buffered deltas. Because focus can accumulate, a node's `deltas` array MAY contain several entries (one structural plus N focus); readers iterate the array rather than reading `deltas[0]`.

**Local vs. published is destination, not signing.** Local storage is itself a relay, bound to 127.0.0.1; every event needs a valid signature to be accepted at all. What's opt-in is whether a sealed trace ever leaves the machine.

**Every trigger is discrete and bounded-frequency — none fires per keystroke or per click.** Continuous typing lives outside the protocol as a raw, unsigned local buffer for crash recovery; focus observations batch into the triggers above. The protocol only ever sees checkpoints a human or agent chose to make. This is the load-bearing fact behind unconditional snapshots (§R1).

## 9. Reconstruction and retention

Every node has `snapshot` — reading any version's body is O(1), no replay. `deltas` remain useful for per-span provenance, edit-rhythm analytics, and as a fallback if an old node shed its snapshot under a non-conforming producer:

```
node = target
while node.snapshot is undefined: node = node.prev
content = node.snapshot
for n in chain(node.next … target): content = applyDeltas(content, n.deltas)
```

In the common case the loop never runs.

**Retention is one-directional:** an old node MAY shed `deltas`, never `snapshot`. Downstream integrity is unaffected — later nodes check their own deltas against *this* node's snapshot, never the reverse. Policy (keep full logs for recent nodes, compress older ones) is operator/client territory, not protocol.

## 10. Relay requirements

Any NIP-01 relay that also implements parameterized-replaceable handling (NIP-33, for `TraceHead`/`TraceOpinion`) suffices. The protocol depends on no tag-ordering guarantees and defines no special relay class. In the citation-verification path, folder placement is display metadata only — integrity rests on pubkey + contentHash + snapshot, never on folder.

**Revocation (NIP-09).** The owner of a trace MAY revoke published nodes by publishing a standard NIP-09 kind-5 deletion request signed by the same key that authored the target nodes — `["e", nodeId]` for each regular `TraceNode` (kind 4290), `["a", "34290:<pubkey>:<d>"]` for the `TraceHead`, and `["a", "34291:<pubkey>:<d>"]` for each owned `TraceOpinion`. A relay that advertises NIP-9 in `SupportedNIPs` MUST honor it per NIP-09: delete the referenced events and refuse their re-publication. Revocation is advisory across relays — a relay that never received the kind-5 MAY retain the node, and a reader that cached it before revocation keeps a cryptographically intact copy. Revocation does not touch the chain (nodes are immutable, history retained on-chain); it changes relay *retention*, which is the layer §10 reserves as non-normative. Only the author's own events are revocable; NIP-09 forbids deleting another author's events, so third-party `TraceOpinion`s about a revoked trace persist.

Non-normative, reserved for later: relay-side validation policy (rejection rules for malformed content, missing required tags, unresolvable `q`), retention, operator/staff admin layer.

## 11. TraceAnnotation (deferred)

A reader's gesture that is **lighter than a fork/quote but heavier than a reaction** — a comment, a marginal note, a SoundCloud-style timed reply. The gap it fills is genuine: `TraceOpinion` is opinion-shaped (one per author+subject, last-write-wins — §5/§R6), and `cite role: "reply"` is authorship-shaped (the reply itself is a whole chained trace). Neither hosts an *accumulating*, *per-gesture*, *version-pinned* annotation. This section argues the shape; nothing here is required to implement, and the kind number is held, not burned.

**Why a new kind, not a variant of an existing one.** The three rejection pressures are structural:

- *Not a TraceOpinion.* An opinion is one-per-`(pubkey, subject)` by design; its whole value is "my current view" collapsing across re-emissions. An annotation's value is the opposite — many per author, each a separate speech act. Stretching TraceOpinion to multi-event breaks §R6's central trade (replaceable = multi-device race dissolves; history not guaranteed). An annotation cannot trade away history because its history IS its payload.
- *Not a `cite role: "reply"` delta.* A reply cite makes the responding document a full trace — genesis, chain, self-sufficient snapshot, ownership. That is the correct weight for a long-form response; it is the wrong weight for "nice paragraph." Forcing a marginal note into authorship is the over-heavy path that leaves the middle empty.
- *Not an opinion variant.* §R6 fought for exactly two subject axes (`x:`/`n:`) on clean lines; a third for annotation would dilute the addressing-vs-identity split, and the multi-event semantics still wouldn't fit the replaceable class.

**Why regular (non-replaceable), like TraceNode.** An annotation's history is its payload (same as TraceNode, opposite of TraceOpinion). It accumulates by chaining or by flat emission; it does not collapse on re-emit. Ordering is therefore `created_at`-independent — if chained, via `prev`; if flat, via relay event order with reader-side reconciliation.

**Target a minted anchor — the §R4 rule, inherited.** Annotation does not introduce a new span-addressing mode. It inherits the rule citations already follow (§R4): nothing addresses a span without first minting it. A whole node is already minted (sealed, immutable, self-sufficient), so a whole-savepoint annotation cites the node directly. A passage-level annotation cites a **minted span** — the reader first mints the span under their own key (`extracted-from` the source node, exactly the §3.8 minting pass), then annotates that minted span's nucleus. There is no bare `(node, position)` coordinate pointer: such a pointer would be the one weak-addressing exception in a protocol that has refused cheap shortcuts at every turn (no auto-resolve on text match §3.8; no positional `tags[0]` §R11.4; no executable rules §R11.2). Minting keeps §R4 pure — one way to address a span, whether you cite it, quote it, or annotate it.

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

- `["e", targetNodeId, …, "target"]` — NIP-18 quote shape. `targetNodeId` is a **minted anchor**: either the source node itself (whole-savepoint annotation) or a minted span extracted from it (passage-level). Either way the anchor is sealed (immutable), self-sufficient (§R1), and permanent (§9 — retention sheds deltas, never snapshot). The annotation pins to that version even if the source trace's nucleus moves on — the same version-pinning `sourceEventId` already does for citations (§3.3). Citing a non-head node is already wire-legal (the spec describes the common case as head, forbids nothing; `extracted-from` does the same for spans).
- `["x", sourceContentHashHex]` — OPTIONAL. The content hash of the cited target's body, letting a verifier confirm the annotation addresses what it claims without reconstructing the target — the §3.9 `sourceContentHash` pattern, reapplied. For a whole-node target this is the node's own `contentHash`; for a minted-span target it is the span's body hash. Absent → the annotation is still readable, just unverifiable (the degrade-don't-break posture).
- `content.text` — the annotation body. Arbitrary text; no integrity claim against the cited body (the annotation is a speech act about the snapshot, not a mutation of it).

**What is deliberately NOT solved here:**

- **Head-following vs version-pinning.** A minted-anchor annotation does not travel to the live nucleus. If you annotate a span minted from checkpoint N and the author publishes N+1, the annotation stays on N's span — correct (you said it about that version), but a reader on the head won't see it unless the reader walks prior nodes or the minted span's `x:` cluster. Whether to render annotations at-their-version (faithful, live reader misses old ones) or aggregate them onto the head (losing version context) is reader policy, not wire.
- **Thread nesting.** Replies-to-annotations (a thread hanging off a savepoint) are unspecified. The natural shape is an annotation whose `target` is another annotation, but whether to allow arbitrary depth or flatten is deferred.
- **Retention.** Unlike TraceNode (snapshot permanent), an annotation has no integrity payload — a relay MAY shed old annotations freely. Aggregation/display is entirely reader-side.

**Relation to reaction (§5).** A reaction and an annotation are non-interacting: a reaction is a singular-current opinion (one emoji, overwrites); an annotation is an accumulating speech act (many, each addressable). A reader who 👍 a passage mints the span then emits a `TraceOpinion` on its `x:`; a reader who writes "this assumes X" mints the span then annotates its nucleus. Both require the mint; they differ in what rides on top — a replaceable singular token vs an accumulating speech act. Forcing either into the other's shape breaks its core trade — so they stay separate kinds despite surface similarity.

---

# Part II — Rationale

Nothing in this part is normative. Each argument appears once.

## R1. Unconditional snapshots buy bounded resolution

`snapshot` is required on every node because a cited node must resolve as one fetch against a self-contained object — O(source snapshot), not a replay through the source's chain. Everything the protocol offers as an import/composite/package story rests on that guarantee, not on the delta log. The cost is affordable for exactly one reason: seals are discrete, bounded-frequency events (§8). The high-frequency case — continuous typing — is handled entirely outside the protocol. If seals ever became per-keystroke, unconditional snapshotting would collapse; that is why `focus` observations batch rather than mint (§R7).

The same trade shows up one level up in injection (§3.7): don't store a manufactured artifact (the assembled prompt), store what's needed to remanufacture it — the same move `deltas` makes by omitting `oldValue`.

## R2. Chains, not clocks; immutable nodes, replaceable current-state

An earlier draft put file nodes at a parameterized-replaceable kind and folder state in a replaceable manifest. Both were reversed: a relay is entitled to keep only the latest replaceable event, which is fatal when history *is* the payload, and a replaceable manifest carries no snapshot, so a cited folder couldn't resolve as a bounded fetch. Ordering by `created_at` also breaks at second resolution — two publishes in the same wall-clock second can leave a relay holding the older event. Hence: trace nodes are regular events, ordering comes from `e…prev`, and the protocol never trusts `created_at`.

The reversal is deliberately asymmetric. `TraceHead` and `TraceOpinion` are replaceable because for them last-write-wins is not a hazard but the correct semantics: a head pointer's only meaning is "current," and an opinion's only meaning is "my current view." A replaceable *pointer* whose loss degrades to a scan is categorically different from replaceable *content* whose loss is loss. This split resolves most of what was previously an open head-disambiguation problem: the pointer provides O(1) lookup and a write-time tie-break, while the chain stays the source of truth.

## R3. contentHash is addressing, not identity

`contentHash` never includes a name, and never serves as trace identity. Identity is the genesis id; version identity is the nucleus id. Two traces with byte-identical bodies share an `x` and remain distinct traces — deliberately, because collapsing them would make two people independently minting the same words indistinguishable from one citing the other. The memetic split — deliberate reuse vs. convergent evolution — is the thing being measured. Same body + different genesis → same `x`, different trace, no conflict.

This is also why a folder's hashable body is the `(relativePath, memberContentHash)` projection (§2): membership entries carry `latestNodeId` for resolution, but node ids are signed artifacts no two owners share — hashing them in would make independent identical folders never cluster, silently killing `#x` for zines. The projection hashes what the folder *is* (which bodies, in what order, under what names) and excludes how to fetch it.

A trace's full extent, around its nucleus: **back** — the `prev` chain, identity-through-change; **out** — `q` edges to what it composes; **in** — three distinct signals, none implying another: citation fan-in (`q`, deliberate reuse), extraction fan-out (`extracted-from` in reverse — spans minted from this node), and content-hash clustering (`x`, independent recognition of the same words). They answer different questions and stay separate axes for the same reason contentHash and identity do.

Minting never auto-resolves against an existing trace, even on exact text match — so independent highlights of the same passage mint fresh traces, and `x` is what lets them find each other afterward. Note the grouping asymmetry: the quotes pulled *from* one source group by `extracted-from` (different spans, different hashes), while `x` only ever collides on byte-identical text.

## R4. Composition is the single combining edge; fork is not composition

A folder containing a file, an anthology composing quotes, and a document citing a span are one edge — a `q` from composer's nucleus to component's. A folder is simply a trace whose body *is* its out-edge list; there is no separate membership relation. What varies is only whether the composer's body is a set, a sequence, or interspersed prose.

Two asymmetric primitives underpin it: **minting** (striking an addressable trace from a span) and **citing** (referencing a minted nucleus). A citation requires a resolved bracket; a bracket does not require a citation — bare brackets protect without minting. Nothing cites without first being minted.

Fork sits outside composition on purpose: a fork is *seeded from* a source once, not *built from* it, so it emits no `q` — lineage flows through `forked-from`. Conflating them would pollute `q`'s fan-in signal (deliberate reuse) with derivation lineage. "Composition is the single relationship by which traces *combine*" survives because a fork doesn't combine; it spawns. `extracted-from` and `forked-from` are the same shape at two granularities: span → immutable leaf; whole node → mutable trace under a new owner.

## R5. Attribution: asserted and verifiable, not co-signed; per-delta on one seal, not per-delta events

Deltas are unsigned sub-fields of a signed node; the signature lives at the seal boundary. Per-delta **attribution** rides inside that already-sealed node as an `author` field on each body-edit delta (§3.3, §3.6) — it is *not* a per-delta event. The distinction is load-bearing: an earlier draft of this rationale conflated "attribution at delta granularity" with "signing at delta granularity" and rejected the package. They are unbound. Per-delta signing was rejected and stays rejected (below); per-delta attribution was adopted in §R11.21.

Cross-author text legitimately enters a document by exactly three routes — quote (`extracted-from` a node the author signed), merge (the merge-parent *is* a node the author signed), fork (`forked-from`, same) — so every honest *cross-author* run has signed corroboration one seam edge away. The `authors` map is a denormalized reading aid over lineage that already exists in signed form, and its `src` pointer gives that verification a single-fetch shortcut. The only genuine forgery is a run with no corresponding lineage, and that is *detectable* rather than *preventable* — hence the verification rule (§3.6), which gives attribution precisely the epistemic status citations already have: asserted, cheaply checkable, degradable. The protocol already rejected trustlessness for citations in favor of bounded verification; attribution holds itself to the same standard, not a stronger one.

**But the seam model does not cover the human–AI loop.** The strongest motivation for per-delta attribution is the case `authors`' verification model cannot touch: in-session co-authorship, where the human types, invokes an LLM, and the model's output is spliced into the buffer and sealed on the *same* chain under a key the same human controls. There is no merge-parent, no `extracted-from`, no seam to walk. The AI's text enters via an in-process function call, not via incorporation from a foreign chain. For that case — which is the default for any tool whose premise is human+AI co-authorship — `authors`' verification machinery offers no advantage over plain per-delta `author`: both are signer-asserted, neither is seam-verifiable, and per-delta is cheaper (O(1) per delta, independent per delta, no sum-check, no reconstruction). The earlier draft's reasoning preferred the heavy reconstruction over simple attribution on the grounds that reconstruction preserved verifiability; that preference is sound *where seams exist* and unsound *where they don't*. The human–AI loop is the latter, and it is the common case.

**Co-signing was rejected** for two reasons beyond coordination cost. Semantically, an author already attested their words when sealing their own node; co-signing someone else's seal is really *endorsement of a new context* — a different speech act, and conflating them invites "Bob signed a document quoting him out of context." Structurally, it hands every quoted author a veto over your seal, contradicting a load-bearing principle: citing has never needed the source's cooperation. If context-endorsement is wanted it fits as an asynchronous, optional `affirm`-flavored event later — never a seal blocker.

**Per-delta events were rejected** and stay rejected. Signatures at delta granularity within one author add nothing (same signer) — the marginal value exists only at cross-author seams, which are exactly the edges already signed. The global costs are real and unaddressed by per-delta attribution: per-keystroke event volume abandons bounded-frequency sealing (§R1), and a signed keystroke stream turns a private writing rhythm into a publishable permanent artifact by default. Per-delta `author` reintroduces none of these costs — it is a field on an already-batched, already-sealed event, adding no events, no signatures, no change to cadence. The earlier rejection of per-delta *events* is exactly why per-delta *attribution* (inside the seal) is the right place to carry authorship: it gets the attribution to O(1) without paying any of the event-volume cost that made per-delta signing wrong.

What remains genuinely uncoverable: two humans under one key in one session — no chain, no seam, no `author` distinction (the seal sees one signer, one buffer). That case is *asserted*-attributable only if the two humans take turns under distinct in-app voices that the editor tracks; otherwise it is permanently attributed to the single signer. Multi-author that you can *verify* still means multi-chain, joined by merge; in-session co-authorship is asserted-attributed via per-delta `author` and the spec says so rather than pretending otherwise.

## R6. One opinion kind, two subject axes

`TraceName` and `TraceAlpha` began as separate non-replaceable chains keyed by `(pubkey, contentHash)`. Two problems: they were byte-for-byte the same structure with one content field swapped, and contentHash keying is coherent only for immutable bodies — a zine (a folder, mutable) gets a new hash on every membership edit, silently orphaning every accumulated name and alpha, which contradicted alpha's motivating use case (surfacing zines in samples). The merge into `TraceOpinion` fixes the duplication; the two-axis subject (`x:` for immutable bodies, `n:` for mutable traces) fixes the keying, mirroring the addressing-vs-identity split the protocol already had (§R3).

Going replaceable trades away guaranteed rename/retune history. Accepted deliberately: for trace *content*, history is the payload; for an opinion, "my current view" is the payload and last-write-wins is the correct semantics — it also dissolves the multi-device concurrent-retune race that chained opinions inherited.

The `reaction` field (§5) leans on this argument unchanged. A like is structurally an opinion — per-author, singular-current, no-cooperation — and inherits the two-axis subject because it keys on the *same* `(pubkey, subject)`. Adding a content field for the token does not widen the axis design: a reaction is still one-per-`(pubkey, subject)`, still last-write-wins, still without history. It is the place a like had nowhere else to live, not a third subject axis. What it cannot host — accumulating gestures, many per author — is the §11 annotation's problem, not the opinion's; the two stay separate kinds precisely so the opinion's singular-current trade survives intact.

## R7. The telemetry boundary

An earlier draft let each focus event (panel mount, selection) seal its own folder node. That violated the protocol's own frequency argument — focus fires per click, and a 1,000-member folder would re-serialize its full membership per click — and focus wasn't even listed among the seal triggers. The fix draws the line cleanly: session-replay observations are telemetry riding on provenance checkpoints, not provenance events of their own. They batch in the local buffer and flush with the next real seal or at session close. A folder with no focus deltas behaves exactly as before; old readers ignore the type.

## R8. Tag and bracket: one edge, two visibilities

Tagging composes a zine into a trace's out-edges the same way a quote does — it "imports" the zine for discovery and citation — without inlining its text. Requiring resolution up front loses nothing, because the casual affordance of a plain hashtag survives as the paired `t` mirror, a byproduct rather than a separate mechanism. The three-way union (§6) stays live-computed at query time — a tag's neighborhood grows as the tagged zine accrues its own edges — while the pinned `q` edge itself stays fixed. One hop of transitivity, no recursion: the same bounded-fan-out posture as everywhere else.

## R9. Query specs and the reader's dial

A query/sample definition step (a modal, conceptually) is where a reader dials: scope (a folder, a pubkey, an `x` cluster, a tag), which of the three union channels to include, hop depth (default 1), ordering (`recency` / `references` / a future alpha-weighted `sample`), and a result bound. This is reader-side construction over filters the protocol already defines (`#t`, `#x`, `#f`, `q`-walks, `TraceOpinion`) — no new wire primitive. Since injection rules are minted traces (§3.7), a rule can *be* a Query spec, and a spec's scope terms compose conjunctively — which is how one LLM call draws on several sources without a multi-rule mechanism. Only `recency`/`references` need to work today; alpha-weighted sampling waits on an aggregation policy.

## R10. Known costs, accepted

- **Folder snapshots grow with membership.** A 1,000-member folder carries 1,000 entries per node. Acceptable for the same reason file snapshots are — membership changes are bounded-frequency — but noted, and a whole-folder injection rule compounds it by expanding member *content* into a prompt. Sharding or incremental snapshots may be needed at scale. Under nesting, per-node snapshot size stays bounded (immediate members only), but **transitive node count is multiplicative** — a 50-member folder where 10 members are 50-member folders is 550 transitive nodes. Any "walk the whole tree" reader (injection rules, sample queries) pays the full depth. The shallow-local `contentHash` (§2) keeps *hashing* O(immediate members); the cost moves to *traversal*, which is bounded fan-out per level.
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
present, 5/5 narrations characterized the inserts as large replacements or
compressions; with labels stripped (span content still visible), 2/5 drifted into
"gradual composition" language; with both stripped, 0/5 — the model narrated the
+1222 insert as "small final adjustments" and "administrative." The summary
magnitude is the anchor that prevents a bulk paste from being dressed up as
deliberate composition — exactly the paste-tell the system preamble
(`system-preamble.ts`) warns against.

**The per-span content payloads suppress content fabrication.** With span
content stripped (condition C), every draw hallucinated entirely new content:
invented philosophical arguments (Nāgārjuna's two-truths doctrine, bracketed
citations) where the file actually contained nonsense vocalizations ("wooooo,"
"yessss"). The span text is what gives the model something concrete to cite
instead of inventing — the same role `snapshot` plays for content resolution
(§R1), but at the per-edit granularity narration needs.

**The two signals contribute independently.** The summary gives magnitude at a
glance; the span content gives the model something to anchor on. Removing either
degrades fidelity; removing both produces outright fabrication. Retention that
sheds `deltas` loses both — the node's content is still resolvable, but the
material from which honest narration is derived is gone.

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
for verification and fatal for honest narration.

## R11. Design history (reversals, most recent first)

22. **Anteriority moved from Affirm to Step; `role: "content"` cite + rendezvous layer added.** Three coupled changes introduced by the rendezvous companion doc (`rendezvous.md`), together closing the "how do two people who quoted the same text find each other, and how does the recipient know the other is real" gap that the provenance + transport pair deliberately left open.

  (a) **Distributed anteriority on Step (reverses §R11.20(b)).** The trustless anteriority stamp moves from Affirm to Step. The original argument against — "OTS's calendar round-trip cannot hang off Cmd+S without destroying the gesture's frequency" — is dissolved by the fire-and-forget workflow (seal returns immediately; proof upgrades in background), which is the standard OpenTimestamps partial-proof path §R11.20 itself already specified for Affirm. The original argument against on sovereignty grounds — "a Step nobody else can see has no anteriority claim" — is reversed by the vetting layer the stamp now enables: a trace's save history becomes forgeable-in-theory-but-not-in-practice process material, and that is the strongest possible anteriority claim a local gesture can make. See §8 (Step trigger), `rendezvous.md` §3 + §R3. Affirm's anteriority is inherited transitively from the cited Step; Affirm MAY keep its own stamp for "when endorsed" as distinct from "when content existed."

  (b) **`role: "content"` cite (extends §3.3).** A fifth cite role for quoting **orphan text** with no origin node in the system (print, oral, sourceless). Keyed on `hash` (`H = sha256(canonical(quote))`), not `sourceEventId`; carries the verbatim bytes in the `quote` field (verification metadata — no `position`, so `snapshot`/`contentHash` are untouched) and an OPTIONAL `source` (work/edition/locator). Derives a top-level `["Q", H, relayHint, "implicit"|"attested"]` tag — single-letter `Q` for NIP-01 filterability (see §3.3 note above). The only cite role without a matching `q`: there is no node to dereference. See `rendezvous.md` §1.

  (c) **Rendezvous layer (companion doc).** A Kademlia DHT (libp2p in the Rust backend, bootstrapped off the author's own super-peer) answering "who else published interest in `H`?" — the discovery index Nostr deliberately lacks. Carries pointers (`H → {onion, pubkey}`), never content; composes with the access-policy mesh (`transport.md` §2), which answers "who may read *me*?" Two rendezvous paths: mutual-peer co-citation (v1, trust-bounded, client-side, zero DHT density required) and the global DHT (opt-in via the "attest interest" gesture). An automated process-vetting layer reads the timestamped save graph (§R11.22(a) material) as a machine-verifiable "captcha" — the corpus, not the prose, because prose is the attacked surface. See `rendezvous.md` Parts I/II.

21. **Per-delta attribution adopted; per-delta signing stays rejected.** Body-edit deltas now carry an OPTIONAL `author` index naming the voice that produced that span's text (§3.3), resolved through a node-local `voices` table (§3.2); when absent or out of range, the delta defaults to the node signer (`event.pubkey`). This makes per-character attribution recoverable in one forward pass over a single node's deltas — O(content), independent of chain depth — without an `authors` map, a sum-check, or a reconstruction tier. Per-delta is the new primary attribution path; `authors` (§3.6) becomes the secondary carrier, retained for `src`-pointer verification of cross-author runs (merge/fork/quote seam edges) and for legacy nodes written before this field existed.

  **Why the reversal.** §R5's earlier draft rejected "attribution at delta granularity" but its objections were aimed at per-delta *events* (new signed events per delta): event volume, cadence destruction, a permanent keystroke stream. Those objections hold and per-delta signing stays rejected. Per-delta `author` reintroduces none of those costs — it is one field on an already-batched, already-sealed event. The earlier draft conflated the two and rejected the package; they are unbound.

  The clincher is the human–AI loop. `authors`' verification model (corroborate a run via a seam edge to a node the attributed author signed) has no purchase on in-session co-authorship: the AI's text enters the buffer through an in-process function call, not via incorporation from a foreign chain, so there is no seam to walk. For the case that is zine's center of gravity — human + AI co-authorship on one chain under keys the human controls — `authors`' machinery offers no advantage over plain per-delta `author`, and per-delta is cheaper, per-delta-independent (one bad delta doesn't poison the whole map, unlike the all-or-nothing `authors` sum-check), and needs no reconstruction. The verification model is retained for the case it actually serves (verifiable cross-authorship via merge); the common case gets the O(1) path.

  **Compactness.** On mono-author seals (the common case — an LLM Extend seals all-inject deltas; human auto-save seals all-pen deltas), every delta is the signer's, so the `author` field is omitted and there is no `voices` table — the default-to-signer rule keeps the wire unchanged from the legacy form. Attribution overhead appears only on seals that mix voices within one checkpoint: one `voices` array per node (each full pubkey stored once) plus one digit per non-signer delta, instead of repeating a 64-char pubkey on every delta. The table is node-local — every node that needs one carries its own — so a reader never resolves across events. Considered and rejected: storing an 8-char (4-byte) pubkey prefix instead of an index, which would save more bytes but be ambiguous to a cold reader (which full key?) and lossy in principle; and storing the full inline pubkey per delta, which is self-sufficient but verbose. The index form is lossless, self-sufficient (the table rides in the same node), and pays for itself at the third non-signer delta. Backward compatible: old nodes without `author` or `voices` fall back to the signer, same as the legacy path.

20. **NIP-03 anteriority attestation layered on Affirm.** *Decision as made at entry 20; the load-bearing stamp has since moved to Step (§R11.22). Affirm keeps an OPTIONAL own stamp; the text below records the original argument.* Affirm is the one gesture that may reach for a trustless third-party anchor, via a NIP-03 kind-1040 event stamping the affirm node's event id against Bitcoin (OpenTimestamps). Three questions, answered once:

  (a) **Why trustless here, when the protocol has refused it everywhere else?** Anteriority — proof that a commitment existed *before* some time T — is the one property that cannot be made self-sovereign. The author cannot prove to a third party that they didn't backdate their own claim without a third party attesting to it. Everywhere else the protocol's "asserted, cheaply checkable, degradable — never trustless" posture (§R5, §3.9, §3.7) suffices because the property under verification is recoverable from signed graph structure: lineage walks the `prev`/`merge-parent`/`forked-from`/`q` edges; authorship corroborates via `src`; citation honesty hashes the span. Anteriority has no signed-graph recovery path, so it earns the trustless tool — the single exception, and on the single gesture where commitment is the payload.

  (b) **Why Affirm and not Step? — REVERSED in §R11.22.** Step is the local rhythm-layer gesture ("saves are steps, not sends" — §8); its meaning was argued as "I am checkpointing my own work on my own machine," for which anteriority seemed to add nothing, and OTS's calendar round-trip seemed structurally incompatible with Cmd+S's frequency. Both arguments are reversed by `rendezvous.md`: Step's anteriority is precisely what makes the automated process-vetting ("captcha") layer possible (a single Affirm-time anchor is useless as a process signal; the sybil filter needs *density*, and density requires the frequent gesture to stamp), and the fire-and-forget workflow dissolves the frequency incompatibility (the seal is instant, the proof upgrades in background). **Step now stamps; Affirm's load-bearing anteriority is inherited transitively from the cited Step (§8, `rendezvous.md` §3.4).** Affirm MAY keep its own stamp for "when endorsed," distinct from "when content existed." The original (b) text is retained above as decision history.

  (c) **Why stamp the affirm node's id, not the affirmed node's?** The affirmed node was already Sent — its existence was public on the relay, so proving "this content existed by block N" adds nothing. The affirm node's id is the new, local-to-this-gesture artifact: the moment the author stood behind the work. Stamping *that* id is what makes "I committed to this by block N" a real claim rather than a restatement of "this content was already fetchable."

  **The attestation is a strictly-additive overlay, not a modification to Affirm.** The affirm node seals and publishes immediately; the kind-1040 attestation publishes later, in the background, when the OTS proof resolves. Readers check it or ignore it; the affirm node's signing, content, and reachability are identical with or without it. A partial proof (calendar submission confirmed, Bitcoin confirmation pending) is published immediately and upgraded by a later sweep — the standard OpenTimestamps workflow, not a defect. The attestation is signed by the same key as the affirm node.

  **NIP-03 status, carried honestly.** The canonical NIP-03 spec is `draft unrecommended optional` — it carries a warning of a known vulnerability needing an update. The attestation here stamps a Nostr event id (itself a SHA-256 hash that verifiers re-derive from the serialized event), not attacker-controlled content, which is the posture that keeps the cited attack class from biting. Implementations SHOULD track upstream NIP-03 revisions. Reader-side verification (resolving an attestation to a Bitcoin block height) is out of scope for this revision.

19. **Affirm decoupled from Send; vocabulary clarified: Step / Seal / Send / Affirm.** The protocol's author-facing actions were a tangled set ("save/seal/sign/send" — four words, one collision). Two changes untangle them:

  (a) **`action: "sign"` renamed to `action: "affirm"`.** "Sign" appeared in two senses: crypto-signing (mechanical, every seal does it) and publication-signing (a deliberate social act). "Is it signed?" was unanswerable without knowing which. The publication act is now `affirm` — no collision with crypto-signing. The protocol's own prose already used "affirm" for this class of speech act (§R5: "the parent author affirms their words in this new context"); the action tag now matches.

  (b) **Affirm decoupled from Send.** ZINE previously bundled "send + affirm" into one gesture. The decoupling makes the prerequisite chain explicit and temporal: **Step** (seal locally — the rhythm-layer gesture, Cmd+S) → **Send** (push a sealed node to an external relay — reachability, not signing) → **Affirm** (mark a sent node as the author's published position — a post-hoc endorsement, after the node has been read and the author stands behind it). Each action consumes the prior's output: Send requires a sealed node; Affirm requires a Sent node. The Send→Affirm gap is where feedback happens — the author Sends, the network reads and responds, and only then does the author Affirm. Affirm-without-Send is invalid by construction (claiming a public position for a node no one can fetch). See §8 (SEND, AFFIRM as separate triggers) and §3.4 (`affirm` action).

  The vocabulary is now: **Step** (interface word for the author's save gesture; protocol: may batch as checkpoint delta or seal a node), **seal** (protocol word for the boundary act: sign + write to local relay), **nucleus** (the current head node), **Send** (push to external relay), **Affirm** (publication act on a sent node). The interface projects three — Step / Send / Affirm; the protocol carries six. "Save" is retired from the protocol vocabulary (Step replaces it); "ZINE" as a combined gesture is retired (Send and Affirm are now separate).

18. **Revocation specified as NIP-09 kind-5 at the relay layer, not a `TraceNode` action.** A "deletion request" for a published zine is the trace owner publishing a standard NIP-09 deletion request (§10) signed by the same key — it carries `e`/`a` tags for every owned node, and relays honoring NIP-09 delete those events and tombstone their ids. Revocation is deliberately *not* a new `action` row in §3.4: the action table describes chain nodes, and revocation is not a node on the chain — it is a relay-layer gesture orthogonal to the append-only chain, in exactly the space §10:339 reserves as non-normative ("relay-side… retention, operator/staff admin layer"). Rejected alternative: a custom replaceable `revoke` marker kind (a `TraceOpinion`-style flag that repudiates a trace while retaining bytes server-side). It would replicate NIP-09's job at greater cost, and the bytes it preserves on the relay are the bytes the local-first posture says needn't live there anyway — history is retained on the author's machine and readers' caches, not on the relay. Owner-only revocation matches the single-owner-per-trace model (§3.8); non-owner moderation is deferred to the operator/admin layer §10:339 reserves. See §R13.

17. **`reaction` field on `TraceOpinion`; `TraceAnnotation` deferred as §11.** Two adjacent product questions — "can a reader react lighter than fork/quote?" and "can a reader reply to a specific passage, SoundCloud-timed?" — resolved in two different places because the protocol already separates the two underlying classes. (a) A like/star/emoji is structurally an opinion: per-author, singular-current, no-cooperation, last-write-wins. It inherits `TraceOpinion`'s two-axis subject unchanged; the only gap was a content field for the token, so `reaction` (§5) is an additive field, not a new kind or axis. Rejected alternatives: a new reaction *kind* (duplicates the opinion class for one extra field), or a third opinion subject axis (dilutes the §R6 split). (b) A comment/marginal note/reply is NOT an opinion — it accumulates (many per author) and is version-pinned, so it cannot ride the replaceable singular-current class without breaking §R6's central trade. It also shouldn't be forced into `cite role: "reply"`, which makes the reply itself a whole chained trace (genesis + ownership + snapshot) — correct weight for a long-form response, wrong weight for "nice paragraph." `TraceAnnotation` (§11) is sketched as a regular (non-replaceable) kind holding the middle ground: cites a **minted anchor** (a whole node, or a minted span for passage-level), carries an optional `sourceContentHash` for verifiability, accumulates freely. It inherits §R4's rule — nothing addresses a span without first minting it — so there is no bare `(node, position)` coordinate pointer; passage-level annotation mints the span first, exactly as citation does. The `e target` edge (not `q`) places annotation in the non-composition lineage family alongside `forked-from` and `extracted-from`. Its shape is argued here and the kind number held; implementation is deferred alongside head-following-vs-version-pinning, thread nesting, and retention policy.

16. **Merge is unilateral by the receiving chain's owner.** Closed the product-semantic half of the merge open questions: a merge node is signed only by the owner of the chain being extended; the merge-parent author neither co-signs nor is notified; parent chains persist (merge does not consume the fork); selective acceptance is the ordinary snapshot, not a cherry-pick special case; either direction (source←fork or fork←upstream) is the same shape. Endorsement stays a separate optional event if wanted later — never a merge prerequisite. Rationale: same load-bearing principle as citation and attribution (§R5) — incorporating content has never needed the source's cooperation; forcing bilateral reconciliation onto the wire would reintroduce co-sign coordination and break "merge while they're asleep." What remains deferred is client-side three-way conflict UI and branch detection, not wire semantics. See §3.8 **Merging**.

15. **Geohash pinning on folder nodes.** The long-deferred open question "Folder node + geohash + ≥1 signature" is split. Spatial pinning is now specified: folder nodes carry OPTIONAL `["g", geohash]` tags (§3.1) — base-32, arbitrary length, prefix-hierarchical, `#g`-filterable — and the spatial browser (Spaces) renders a pin only at the zoom whose cell-width matches the pin's geohash length, so the "various levels" emerge from the precision the author chose rather than a separate tiering field. Geohash is deliberately a *curation surface* tag: it does NOT enter the canonical body hash (`contentHash`/`#x` are unchanged), it is republished verbatim on every folder seal (carry-forward in the client), and any signer who can republish the folder node can re-pin. The signature half of the open question — an `action: "affirm"` node affirming publication — is now resolved: affirm is a chain event citing the sent node (see the open-questions section and §R11.19). Geohash pinning shipped without it because a pin is an authoring act on the folder node, not a publication gate; the affirm mechanism layers on independently.

1. **Folder nesting — folders as members of folders.** Closes the long-deferred open question. A folder's `snapshot.members` entries now carry an optional `kind: "file" | "folder"` (default `"file"` for legacy nodes); the canonical folder body projection widens from `[relativePath, memberContentHash]` to `[relativePath, kind, memberContentHash]`; the `F` tag applies to folder members as well as files; `relativePath` is now single-segment (no `/`) — hierarchy is expressed via folder-members, not slash-joined paths. The `#f=[id]` "one-query returns the whole folder" property is weakened to "one-query returns every node **directly** in a folder"; reading a whole tree is bounded fan-out (one `#f` per folder member, recursing by depth). The canonical-body hash is **shallow-local Merkle-with-pointer**: each folder member's recursive hash is precomputed at its own seal and stored on the parent's entry, so an outer hash is O(immediate members) regardless of depth — no chain walk at hash time, no recursion, cycle-safe by construction. Fork's shallow-cite rule extends to folder members at fork time; recursive fork-on-write *inside* a folder member (with its cycle guard) is specified but implementation-deferred. The three-tuple projection is a breaking change to `contentHash`/`#x` clustering: legacy folders rehash on their next seal. No integrity property is affected — `snapshot` remains the source of truth, the projection is denormalized cache; no on-disk migration is performed.
2. **`injectRule` built as a named-algorithm version manifest, not an executable rule.** An earlier form of §3.7 left the rule trace's body unspecified — it could have been prose describing the expansion, or executable code (JS/WASM) that literally IS the procedure. Prose was rejected: two readers with different interpreters reconstruct differently, so the "deterministic procedure" the spec promises isn't actually deterministic across implementations, only per-interpreter-version — weak. Executable rules were rejected for the same trust reason the protocol rejects trustless attribution (§R5) and trustless citation (§3.9): a provenance layer whose whole posture is "verifiable, not trustless" should not execute code pulled from a relay event during reconstruction. The chosen form: a rule trace's body is a JSON manifest naming a versioned algorithm shipped in the reader's binary (`{ "algorithm": "ctx-block-v1", "params": {…} }`). Two readers implementing the same algorithm version produce byte-identical reconstruction; a reader that doesn't know the algorithm degrades to "scope visible via `q`-tags, prompt not rebuildable" — strictly better than no rule. The algorithm registry lives in code, not on the relay; evolving an algorithm means shipping a new named version, not mutating an old one. This is the same "name-and-version, don't embed the procedure" move the §R9 Query spec makes for scope construction.
3. **Folder-delta vocabulary — `reorder` deleted, `rename` added, `focus` given an `op`.** `reorder` was redundant with `snapshot.members` order (the §2 canonical projection *is* the ordered list); a dedicated ordering delta carried no information the snapshot didn't. `rename` was added as the third structural membership fact alongside add/remove: renaming a member used to decompose into add+remove on the chain, which broke replay (one user gesture → two unrelated events, the file's history orphaned from its new path). As a single delta it carries `fromPath`/`toPath` and replays as one move. Crucially `rename` is the *structural* path axis — folder-owned addressing — explicitly separated from `TraceOpinion`'s display `name` (§5/§R6), which is author-scoped and history-less; conflating them would re-introduce the §R6 conflict (an opinion's correct semantics is "current view," but rename replay needs history). `focus` gained `op: "mount" | "unmount"` for entry/exit symmetry: under single-occupancy panels most unmounts are inferable from the next mount, but a panel going empty (tab closed, no successor) is otherwise uncapturable — the gap replay most wants. Together add/remove/rename (membership entry/exit/move) and focus mount/unmount (panel entry/exit) close the folder-orchestration vocabulary at two levels.
4. **Positional `tags[0]` locator and the zine-relay class — deleted.** The locator was duplicated by its own filterable mirror, and tag-order preservation — the sole requirement distinguishing a zine-relay — existed only to protect the positional form. Any NIP-01+NIP-33 relay now suffices.
5. **`folderId` namespace — deleted.** Trace identity is the genesis node id, universally; folders have no separate id, which also removed the "folderId isn't globally unique" ambiguity from tagging.
6. **`FileTraceNode`/`FolderTraceNode` — converged** into one `TraceNode` kind with a `z` discriminator, after their parallel tag tables drifted (`f`/`F` vs `D`).
7. **`TraceName`/`TraceAlpha` — merged and made replaceable** as `TraceOpinion`, keyed by a two-axis subject; see §R6.
8. **`quote`/`embed`/`tag-add`/`tag-remove`/`reply-to` deltas — collapsed** into `cite {role, op}`; a fifth relationship now costs a string, not a spec section.
9. **`authors` runs — de-duplicated** from `{v, t}` (which stored the body twice) to `{v, len, src?}`, and given a verification rule; see §R5.
10. **Per-focus folder nodes — retired**; focus batches into real seals (§R7).
11. **Injection-rule registry — retired**; rules are minted traces (§3.7).
12. **`actor` tag — retired**; `contributors` is the single non-signer-participation carrier. Reintroduce a filterable mirror only if a real query needs it.
13. **Per-delta signing and co-signed `authors` — considered and rejected.** Per-delta *signing* (a new event per delta) was rejected and stays rejected; per-delta *attribution* (an `author` field inside an already-sealed node) was later adopted — see §R11.21. The distinction is load-bearing; see §R5.
14. Older reversals retained from earlier drafts: replaceable file nodes and the replaceable `FolderManifest` (see §R2); a separate local "pin" layer beside brackets (collapsed — brackets are the single protection marker).

## R13. Revocation is NIP-09 at the relay layer, not a chain action

A deletion request — "take down my published zine" — is a relay-retention concern, not a chain-integrity concern, and the spec separates those layers deliberately. The chain is append-only and immutable: every `TraceNode` is a signed regular event (kind 4290), history is retained (§3.4 `delete`), and the protocol guarantees integrity *on the chain*, never *on a relay*. §10:339 reserves "relay-side… retention, operator/staff admin layer" as non-normative precisely so that retention policy — including takedown — can evolve without touching the chain model. NIP-09 (kind-5 deletion requests) is the standard Nostr mechanism for exactly this: the owner publishes a signed request, conforming relays delete the referenced events and tombstone their ids against re-publication. It composes with the protocol at no cost:

- **Owner-only matches the model.** A trace has exactly one owner — the signing key (§3.8). NIP-09's authority rule (only the event's author may delete it) is the single-owner model verbatim. No delegation, no multi-sig, no new authority primitive.
- **The chain is untouched.** Revocation does not mint a node, mutate a `prev` pointer, or move a `TraceHead`. Readers who cached the revoked nodes keep cryptographically intact copies; the citation-verification path (§3.9) degrades to "revoked, not verified" rather than breaking.
- **The standard mechanism is already honored.** Any relay advertising NIP-9 honors kind-5 by definition; the protocol need not define a relay class (§10:337).

The rejected alternative — a custom replaceable `revoke` marker kind that repudiates a trace while retaining bytes server-side — fails on three counts: (a) it replicates NIP-09's deletion-tombstone semantics at greater spec and implementation cost; (b) the server-side history it preserves is not a guarantee the protocol makes or needs — local-first means the authoritative copy lives on the author's machine, and a relay is a cache, not an archive; (c) it would mint a new kind and a new addressing axis for a concern the spec has already placed outside the chain. Revocation is a relay-layer administrative act; NIP-09 is its vehicle; the chain is uninvolved by design. See §R11.18 for the decision record.

---

# Open questions (deferred)

- **Branch detection.** `TraceHead` resolves head *lookup* and races, but two live branches (a true concurrent split) still need surfacing and a merge nudge; detection is the old scan for multiple uncited heads. Unilateral merge (§3.8) is useless if the owner never notices a fork worth incorporating.
- **Merge conflict resolution (client/UI only).** Wire semantics of merge are fixed (§3.8): unilateral, owner-signed, selective acceptance native. The reference press ships a line-based three-way UI (base / ours / theirs with per-hunk ours|theirs|both|base choices) for file content; folder membership three-way and CRDT helpers remain open. Not a protocol change.
- **Upstream re-sync into a fork.** Mechanically the same unilateral merge as any other (§3.8): `action: merge` on the fork chain with the source's newer node as a merge-parent. Deferred only for the conflict-UI question above, not for missing wire shape.
- **`affirm` wire mechanics — RESOLVED.** Affirm is a **chain event**: a `TraceNode` (kind 4290) with `action: "affirm"` citing the sent node via a `q` tag, not a parameterized-replaceable side-channel. Rationale: affirmation is a point-in-time speech act ("I stand behind this version"), and its history is the payload — a later affirmation of a revised edition doesn't erase the earlier one, the same way §R2 argues that losing chain history is "fatal when history *is* the payload." Replaceable events (§R2: `TraceHead`, `TraceOpinion`) are reserved for current-state-only semantics where last-write-wins is correct; affirmation's correct semantics is not last-write-wins but append-only publication record. The no-content-change seal (`snapshot == prev.snapshot`) is a recognized pattern — tag-change seals already do this (§8). A reader checking "is this node affirmed?" walks the chain to the most recent `action: "affirm"` node, the same bounded chain walk every other operation does. The `affirmNode` implementation in `provenance.ts` already encodes this correctly.
- **Endorsement events.** An asynchronous "I affirm my words in this context" event (an `affirm` variant citing another owner's node) — the legitimate remainder of the co-signing idea (§R5). **Not required for merge:** merge is a unilateral acceptance speech act by the receiving chain's owner (§3.8); endorsement, if ever shipped, is optional bilateral buy-in layered on after, never a seal blocker.
- **Relay-side validation policy.** Operator policy, but a reference policy should ship with the relay.
- **Kind and tag registration.** `4290`/`34290`/`34291`/`4293` and the `z`/`f`/`F` letters are placeholders pending collision review. Collision check done 2026-07-14 against `nostr-protocol/registry-of-kinds`: none of the four appear in the registry (nearest neighbors: 4312/4454/4455 in 4xxx; 34128/34139/34235/34236/34550 in 34xxx), and `4293` is also clear of the prior internal "TraceAlpha" sketch, which was folded into `TraceOpinion` (`34291`, `d = "x:…"`). `34292` (Voice Identity) is intentionally NOT a trace kind — it is a parameterized-replaceable app kind used by the client for voice declarations; it appears here only to record that the earlier `34292`-for-TraceAnnotation assignment was a range-rule violation (non-replaceable kind placed in the replaceable band), now corrected. The `Q` top-level tag (§3.3 `role: "content"` — uppercase, distinct from lowercase `q` for node-citation) is a new single-letter tag name pending collision review against NIP conventions; chosen single-letter so `#Q=H` queries work on standard NIP-01 relays (multi-char tag names are not queryable).
- **Folder snapshot growth.** See §R10.
- **Position-only deltas.** Non-citation deltas could carry two spans instead of `newValue`, resolvable entirely from snapshots. Deferred for simplicity.
- **`sourceContentHash` granularity.** Span-level (specified) vs. whole-snapshot-level, which would also let a verifier ask "is the source itself intact."
- **Named-file `x` participation.** Whether named files emit `x` for cross-folder copy detection, or opt out so byte-identical files aren't surfaced as duplicates.
- **Tag cap.** Whether a trace bounds how many zines it can tag (an earlier system settled on 1–7) or is unbounded.
- **Citing unpublished traces.** Works mechanically (every node has a snapshot); whether to encourage it, or restrict citation to signed/minted traces, is unsettled.
- **Model-dependence of the `Δ` interval label.** The A/B/C (§R12) found the `ΔNm/Nh/Nd` annotation inert for glm-5.2 — the model computes durations from timestamps itself. Whether it is load-bearing for other models is untested. If confirmed redundant across models, the interval can be trimmed from the context block to reduce prompt noise.
- **`TraceAnnotation` (§11).** The accumulating comment/marginal-note primitive — wire shape sketched around a minted-anchor target (§R4 inherited; no bare position pointer). Open sub-questions are head-following vs version-pinning (reader policy, not wire), thread nesting depth, and retention. The reaction-token case (§5) is closed; this is the remaining open half.
- **`affirm` → `attest` rename.** Recommended in `rendezvous.md` §R6/§R7: the publication gesture should read "attest" (outward, bearing-witness, on-the-record) not "affirm" (inward stance), aligning the verb with the `zine = attested trace` noun. Creates a collision with the NIP-03 "attestation" sub-thing; resolution is to rename the sub-thing (`stampAndPublishAttestation` → e.g. `stampAndPublishAnchor`, "anteriority proof"/"OTS anchor"). Sweep is bounded — `trace-provenance.md` §3.4/§8/§R11.19–20, the wire `action: "affirm"` tag value, `OpKind`/`affirmNode`/`canAffirm`/`affirmAsVoice`, `AffirmModal.tsx` → `AttestModal.tsx`, `.op-affirm` CSS, `zine_affirm` MCP tool — and cheap pre-1.0. Decision pending; the docs currently use `affirm` as the live term with `attest` flagged as the recommended target.
- **Revive-after-revoke.** NIP-09 tombstones the event id, so re-publishing the same node id is refused by conforming relays. Reviving a revoked zine therefore requires minting a new genesis under a new id (a fresh chain). Accepted as the correct posture for a deletion request; documented here as a known cost. Whether a "revive under the same id" gesture is ever wanted is unsettled — it would require either deleting the kind-5 tombstone (defeating the point) or a non-NIP-09 mechanism.

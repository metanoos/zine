# Fork-on-write implementation plan

Status: **specified, not implemented** ([protocol §3.8](../../protocol/trace-provenance.md#38-coining-brackets-forking)).
This document records the current failure and the work needed to close it.

## Required behavior

Editing a foreign member must first create an owned fork. For a nested edit,
the press must fork and repoint each foreign folder on the path before forking
the file. It must reject folder cycles before recursion begins. Untouched
members remain citations to the source owner's traces.

## Current state (verified 2026-07-15)

| Piece | Current implementation |
|---|---|
| Shallow folder fork | `provenance.ts::forkFolder` creates a new folder genesis and cites the source members with owner-bearing `q` tags |
| File fork primitives | `provenance.ts::forkFile` and `forkFileFromNode` create an owned genesis with `forked-from` |
| Disk leaf-folder lookup | `workspace.ts::resolveLeafFolder` resolves nested display paths before writes |
| Local-primary leaf-folder lookup | `workspace-local.ts::pushToRelay` still looks in the root manifest with a slash-joined path |
| **Automatic fork-on-write ownership check** | **Not implemented in either write backend** |
| **Recursive fork-on-write inside folder members** | **Not implemented** |
| **Cycle guard** | **Not implemented** |

## Immediate bug: the write paths do not enforce fork-on-write

Neither `workspace.ts::writeFile` nor `workspace-local.ts::pushToRelay` checks
the current member's signer before editing foreign content.

The disk backend resolves a nested leaf correctly, but then uses the foreign
member as `prev` and signs the next node with the active local key. The
local-primary backend has the same ownership gap and an extra nesting bug: it
looks for `blog/draft.md` in the root manifest even though the root contains a
`blog` folder member.

As a result, any foreign member of a shallow folder fork can extend the source
chain under a different signer instead of creating an owned genesis with
`forked-from`. With nesting, the local-primary backend may not find the member
at all. Both outcomes violate the single-owner invariant.

## Implementation plan

### 1. Shared writable-member resolution

Add one helper shared by both backends. It must:

1. Resolves a slash-joined display path to its immediate folder genesis and
   single-segment member name.
2. Fetches the current member node and compares its signer with the active
   author key.
3. Returns the existing member when owned, or forks and repoints it before the
   edit when foreign.

Run this ownership barrier for both top-level and nested files. One shared
implementation keeps the backends aligned.

### 2. File-member fork-on-write

For a foreign file, call `forkFileFromNode` (or merge the two existing fork
helpers), place the new genesis in the immediate folder manifest, and apply the
edit to the new chain. The first owned node must carry `forked-from`; it must
not extend the foreign `prev` chain.

### 3. `forkSubfolder` primitive (provenance.ts, new)

```
async function forkSubfolder(
  sourceSubfolderNodeId: string,
  destParentFolderId: string,
  memberName: string,
): Promise<string>  // returns the new subfolder's genesis id
```

- Fetch the source subfolder's latest node and read its members.
- Mint a new subfolder genesis under the user's key (`forked-from` the source
  node, `action: "fork"`, fresh identity).
- For each file, cite the source node unchanged. Fork it only when edited.
- For each folder, call `forkSubfolder` recursively and repoint the new
  subfolder to that owned fork.
- Upsert the new subfolder as a `kind: "folder"` member of `destParentFolderId`.
- Before recursing, reject a member whose cited nucleus is an ancestor of the
  current folder. Such a source graph contains a cycle.

### 4. Cycle guard (provenance.ts, new)

```
async function assertNotAncestor(
  candidateAncestorId: string,
  folderId: string,
): Promise<void>
```

Walk the folder's `forked-from` and parent `e` edges backward. If
`candidateAncestorId` appears, reject the write. During fork-on-write, a fresh
genesis cannot yet be an ancestor, so check whether the source subfolder's
ancestry includes the destination parent.

### 5. Regression coverage

Exercise the same cases through both backends:

- top-level foreign file edit forks before writing;
- nested foreign file edit first forks the necessary folder path, then the
  file;
- owned members continue their existing chain without a redundant fork;
- a cyclic source folder is rejected before recursive genesis minting;
- the new manifest points only at owned forks along the edited path, while
  untouched source members remain cited.

## Risks and sequence

- Cycle detection adds a new graph invariant. A mistake can create an infinite
  walk or corrupt membership.
- Deep edits mint one owned genesis for every foreign folder on the path. File
  members remain shallow citations until edited.
- Disk and local-primary writes must use the same resolution and ownership
  logic.

Land this in two coherent changes:

1. Add shared leaf resolution and the file ownership barrier. This restores
   top-level fork-on-write and fixes local-primary nested lookup.
2. Add recursive subfolder fork-on-write and the cycle guard immediately
   afterward.

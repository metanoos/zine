# Recursive fork-on-write inside folder members (#3)

Status: **specified but implementation-deferred** (protocol §3.8:246). This doc
records the precise scope, the immediate bug, and the implementation plan so a
fresh session can pick it up with full context.

## What the spec requires (§3.8)

> "Editing anything *inside* a folder member requires recursive fork-on-write:
> mint a new subfolder genesis under your key (`forked-from` the source folder
> node), recursively fork-on-write each of *its* members, repoint the new
> subfolder's membership at your forks, then repoint the outer folder's
> membership entry at the new subfolder. **Cycle guard required**: a folder
> that contains itself transitively would infinite-loop the recursion, so
> seal-time enforcement forbids `q`-tag cycles — a folder member's cited
> nucleus MUST NOT be an ancestor of the citing folder."

## Current state (verified 2026-07-14)

| Piece | Client | Harness |
|---|---|---|
| `forkFolder` (top-level, shallow) | `provenance.ts:2338` — members cited verbatim, 4-elem `q` w/ owner | Not implemented (only wire-shape tests) |
| `forkFile` (file-member fork-on-write) | `provenance.ts:2392` | Not implemented |
| Fork-on-write trigger | `workspace-local.ts:148-184` (on edit push) | None |
| **Recursive fork-on-write inside folder member** | **Not implemented** | **Not implemented** |
| **Cycle guard** | **None** | **None** |

## Immediate bug: fork-on-write is broken under nesting (even for file members)

The trigger path (`workspace-local.ts:148-184`) is pre-nesting — it reads the
**top-level** forked folder's manifest and looks for the file's slash-joined
`relativePath` directly:

```ts
const manifest = await fetchManifest(folderId);           // top-level fork
let entry = manifest.find((m) => m.relativePath === relativePath);  // slash-joined path
```

Under nesting, a file at `blog/draft.md` in a forked folder is a member of the
`blog` subfolder (a `kind: "folder"` member of the top-level fork), NOT a
direct member of the top-level fork. So:
1. `fetchManifest(folderId)` returns the top-level manifest (contains `blog`
   as a folder-member, not `blog/draft.md` as a file-member).
2. `manifest.find(...)` returns undefined → `entry` is undefined.
3. The `if (entry && ref?.forkedFrom && prevId)` guard is skipped entirely.
4. The file is published as if it were the user's own — no fork-on-write, no
   `forked-from` edge, silently claiming authorship of foreign content.

**Fix needed:** the trigger path must `resolveLeafFolder(folderId, relativePath)`
(like the disk backend does) to find the file's immediate folder, then check
whether THAT folder's member is foreign-owned. If the immediate folder is
itself a folder-member of the fork (not yet forked-on-write), the recursive
fork-on-write must fire first (mint subfolder genesis, fork the file, repoint
the subfolder's membership, repoint the outer folder's membership).

## Implementation plan

### 1. `forkSubfolder` primitive (provenance.ts, new)

```
async function forkSubfolder(
  sourceSubfolderNodeId: string,
  destParentFolderId: string,
  memberName: string,
): Promise<string>  // returns the new subfolder's genesis id
```

- Fetch the source subfolder's latest node, read its members.
- Mint a new subfolder genesis under the user's key (`forked-from` the source
  node, `action: "fork"`, fresh identity).
- For each member:
  - `kind: "file"` → cite the source member's node verbatim (shallow-cite, same
    as top-level forkFolder). Fork-on-write happens later when the user edits.
  - `kind: "folder"` → **recursively** `forkSubfolder` (this is the recursive
    step). Repoint the new subfolder's membership at the recursively-forked
    subfolder.
- Upsert the new subfolder as a `kind: "folder"` member of `destParentFolderId`.
- **Cycle guard**: before recursing into a folder member, check that the
  member's cited nucleus is not an ancestor of the current folder (walk the
  `forked-from` / parent chain). If it is, throw — the source folder has a
  cycle (a spec violation that should have been caught at seal time).

### 2. Cycle guard (provenance.ts, new)

```
async function assertNotAncestor(
  candidateAncestorId: string,
  folderId: string,
): Promise<void>
```

Walk the folder's `forked-from` + parent-chain (the `e` tags) backward. If
`candidateAncestorId` appears, throw — the folder member would create a cycle.
This is the seal-time enforcement the spec requires. (For the fork-on-write
path the check is simpler: a fresh genesis can't be an ancestor of anything
yet, so the cycle can only arise from the SOURCE side — check the source
subfolder's ancestry doesn't include the dest parent.)

### 3. Fix the fork-on-write trigger (workspace-local.ts:148-184)

Replace the flat-manifest lookup with a leaf-folder resolution:

```ts
const { leafFolderId, leafMemberName } = await resolveLeafFolder(folderId, relativePath);
const manifest = await fetchManifest(leafFolderId);
let entry = manifest.find((m) => m.relativePath === leafMemberName);
```

Then, if the leaf folder is itself a folder-member of the fork (not yet
forked-on-write), call `forkSubfolder` to fork it first, then `forkFile` for
the edited file, then repoint memberships.

### 4. Disk backend fork-on-write (workspace.ts)

The disk backend currently has no fork-on-write — it owns its files. But a
forked folder on disk (via "Fork to edit") still cites foreign member nodes.
Editing a file in a forked folder-member needs the same leaf-folder resolution
+ fork-on-write. This is the same shape as #3 for the local backend, ported to
the disk backend's `writeFile` path.

## Why this is deferred

- **Cycle detection** across a folder genesis graph is a new invariant with no
  existing enforcement. Getting it wrong means infinite loops or corrupted
  membership graphs.
- **Recursive genesis minting** can be expensive (a deep folder forks every
  subfolder genesis, even untouched ones). The spec's shallow-cite rule
  mitigates this (file members are cited, not forked, until edited), but
  folder-members must be recursively forked to maintain the ownership invariant.
- **Multi-backend** — the logic must be consistent across disk (workspace.ts),
  local (workspace-local.ts), and relay (workspace-relay.ts) backends.
- The spec itself defers it: "the recursive fork-on-write write-path is
  implementation-deferred" (§3.8:246).

## Prerequisite: the immediate bug (#3a) should be fixed first

The fork-on-write trigger path is broken under nesting even for file members
(see "Immediate bug" above). This is a smaller, well-contained fix
(resolveLeafFolder + leaf-folder ownership check) that delivers the file-member
fork-on-write under nesting without the full recursive subfolder fork. It's the
right first step before tackling the recursive case.

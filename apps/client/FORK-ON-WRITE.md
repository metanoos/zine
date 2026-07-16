# Fork-on-write status

Status: **top-level files enforced; recursive folder forking deferred**
([protocol §3.8](../../protocol/trace-provenance.md#38-coining-brackets-forking)).

## Required invariant

A writer must never extend a trace owned by another signer. Editing a cited
foreign file first creates an owned genesis with `forked-from`, repoints the
folder membership, and then appends the edit to the owned chain. A write whose
ownership cannot be verified must fail closed.

For nested foreign folders, the eventual behavior is stricter: fork and
repoint every foreign folder on the edited path, reject cycles before minting,
then fork the file leaf. Untouched members remain citations to the source
owner's traces.

## Current implementation (verified 2026-07-15)

| Piece | State |
|---|---|
| Shallow folder fork | `provenance.ts::forkFolder` creates an owned folder genesis and cites source members with owner-bearing `q` tags. |
| File fork primitive | `provenance.ts::forkFileFromNode` creates an owned file genesis carrying `forked-from`. |
| Active write backend | The client and MCP press both use `workspace-local.ts::createLocalWorkspace`. |
| Owned file write | Continues the existing owned chain. |
| Top-level foreign file write | Resolves the source signer, forks the exact source node, repoints the manifest, and edits the owned fork. |
| Unverifiable file owner | Fails closed instead of guessing. |
| Foreign folder write | Fails closed with “fork the folder first”; it never cross-signs the foreign folder chain. |
| Recursive nested-folder fork | Not implemented. |
| Folder-cycle guard | Not implemented because recursive folder forking is not yet enabled. |
| Legacy disk workspace service | Removed. `workspace.ts` now contains only the native picker/scan/reify bridge. |

Regression coverage in `workspace-local-movement.test.ts` locks the ownership
decision (`owned`, `foreign`, `unverifiable`). The behavioral implementation
lives in `workspace-local.ts::pushToRelay`.

## Remaining work

### 1. Resolve an editable folder path

Walk a slash-joined display path from the root manifest to the immediate parent
folder. At every folder edge, resolve the current owner before mutating.

### 2. Fork foreign folders recursively

Add a `forkSubfolder` primitive that:

1. fetches the source folder head and members;
2. creates an owned folder genesis with `forked-from` and `action: "fork"`;
3. preserves untouched file members as citations;
4. recursively forks foreign folder members on the edited path only; and
5. repoints the destination parent's manifest to the owned folder.

### 3. Reject cycles before minting

Walk source ancestry and the destination parent chain with a visited set. If a
source folder is already an ancestor of the destination, reject before creating
any genesis nodes. The traversal must be bounded and fail closed on an
unresolvable edge.

### 4. Add end-to-end regression coverage

Exercise the same cases through the client and MCP press:

- top-level foreign file edits fork exactly once;
- owned members continue without redundant forks;
- unknown ownership publishes nothing;
- nested edits fork only the required folder path and file leaf;
- cyclic source graphs publish nothing; and
- untouched source members remain cited.

Until those cases land, nested foreign-folder writes intentionally stop with an
actionable error instead of violating the single-owner invariant.

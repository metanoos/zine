# zine

- Read `README.md` and `protocol/README.md` before architectural or protocol
  changes. The owning protocol specification is authoritative when documents
  disagree.
- Major areas:
  - `apps/client`: React/Tauri client.
  - `apps/mcp`: headless MCP press.
  - `relay`: Go relay and hosted peer.
  - `protocol`: wire-format, transport, and provenance specifications.
- Preserve unrelated work in this frequently dirty worktree. Do not rewrite or
  clean up files outside the requested change.
- Treat the live working tree as authoritative, not `HEAD` or the latest commit.
  Before editing, inspect current status and diffs and reread the affected files
  so uncommitted parallel progress can be preserved, reused, or reconciled.
  Recheck affected files before handoff when parallel work may still be landing;
  never overwrite a concurrent change merely because it is uncommitted.

## Verification

- Canonical full verification: `npm run verify`
- Fast all-area checks without the production build or live relay: `npm run check`
- Isolated real-relay protocol smoke: `npm run verify:relay`
- Client: `cd apps/client && npm test && npm run build`
- MCP: `cd apps/mcp && npm test && npm run build`
- Relay: `cd relay && go test ./...`
- Rust shell: `cd apps/client/src-tauri && cargo test`
- Run the checks for each affected area, starting with the narrowest relevant
  test. There is no root `npm test` script.
- For provenance, cryptography, storage, or networking behavior, add regression
  coverage and exercise a real relay when feasible; compilation alone is not
  sufficient verification.
- Ask before changing wire formats, key or trust semantics, framework
  boundaries, or other consequential architecture.

## GBrain (local knowledge brain)

This repo is indexed by gbrain on each developer's machine. CLAUDE.md's
"Brain-First Rule" makes querying the brain a hard requirement before
architecture changes; this section covers setup and worktree propagation.

**Setup (one-time per machine):** run `/setup-gbrain` (installs the CLI +
PGLite engine + embedding model) and `/sync-gbrain --full` once in this
worktree. That writes `.gbrain-source` (machine-specific source ID) at the
worktree toplevel and indexes the code into the local brain.

**Worktree propagation:** `.gbrain-source` is git-ignored (machine-specific),
so `git worktree add` does NOT copy it directly — but a `post-checkout` hook
in `.githooks/` auto-copies it from the main worktree on every new worktree
and branch checkout. The hook needs `core.hooksPath=.githooks` set once per
clone (one-liner, see below); after that, every `git worktree add zine-<name>`
gets the pin automatically with no manual `/sync-gbrain` needed for routing.
All zine worktrees share one gbrain source (`gstack-code-zine-<hash>`), so
code search from any worktree sees the whole codebase.

**One-time hook bootstrap (per clone):**
```
git config core.hooksPath .githooks
```
Required once after a fresh `git clone` (the `.githooks/` dir arrives via
git, but git won't execute hooks until you point `core.hooksPath` at it).
Already-set in the existing worktrees on this machine.

**Refreshing the index:** run `/sync-gbrain` (incremental, ~50ms steady-state)
after meaningful code changes. For ongoing auto-refresh across all worktrees,
run `gbrain autopilot --install` once per machine.

**Call graph (`code-callers`/`code-callees`):** populated by
`gbrain dream --source gstack-code-zine-<hash>`. Run after a full sync if
caller/callee queries return `count: 0`. Direct calls resolve well; dynamic
dispatch (Tauri `invoke('...')`, event handlers) may stay unresolved — that's
expected, not a bug.

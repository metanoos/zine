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

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

## Verification

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

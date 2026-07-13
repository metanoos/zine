You're picking up a project mid-build. Read this fully before touching anything — a lot of non-obvious decisions and two real protocol bugs got worked out along the way, and re-deriving them is wasted effort. This file is your context; the code and `protocol/trace-provenance.md` are ground truth if they ever disagree with this summary.

## What this is

An open, BYOK (bring-your-own-API-key) LLM harness for editing files/folders — think "Claude Code, but provider-agnostic and with every edit (human or LLM) traced as composable, cryptographically signed provenance." The trace protocol is Nostr-based: every save is a signed event, files quote/import from each other by pinning to a specific version, and the whole thing is meant to be self-hostable ("run your own relay like running your own press" — that's the "zine ethos").

Two audiences converge on one substrate: a writer using this like Obsidian, and an agent (any LLM, plugged in via API key) editing the same files, both producing the same kind of provenance trail.

## Repo layout

```
/Users/peterwei/wokshop/zine/
├── protocol/trace-provenance.md   — the protocol spec (NIP-style doc). Source of truth for wire shapes.
├── relay/                         — Go module, khatru-based local relay. Builds to relay/zine-relay.
├── apps/
│   ├── harness/                   — TypeScript/Node CLI ("tracer"). The actual BYOK agent harness. Active.
│   ├── tracer/                    — OLD Flutter/Dart macOS app. Superseded, left untouched, NOT deleted. Ignore unless asked to remove it.
│   └── web/                       — empty Next.js-ish scaffold. Untouched. Not yet built.
```

Not a git repo yet — nothing is committed. Check with the user before initializing one or assuming any git workflow.

## Architecture, and why (read this before changing any of it)

**Local storage IS a relay, not a bespoke schema.** `apps/harness` used to have its own sqlite schema (`db.ts`, now deleted) that got translated to Nostr events at publish time. That's gone. Every save publishes directly to a local relay (`relay/zine-relay`, khatru + sqlite, bound to `127.0.0.1` only, spawned automatically by the harness if not already running). There is no separate "local record" format — a trace node is a real signed Nostr event from the moment it's sealed. This was a deliberate simplification requested mid-session; don't reintroduce a parallel local store.

**Signing is not the local/published boundary — which relay the event reaches is.** Since local storage is itself a relay, every event needs a valid signature to be accepted at all (NIP-01 requires this). So everything is signed immediately with a local "voice" identity. Privacy comes from the local relay never accepting inbound connections from outside the machine and never being told to push events elsewhere — not from withholding signatures.

**Kind numbers (provisional, see protocol doc):**
- `4290` = `FileTraceNode` — regular, non-replaceable. This matters: an earlier draft put it at `31234`, inside Nostr's replaceable range (30000–39999), which would let relays silently garbage-collect history. Don't put trace nodes in the replaceable range.
- `34290` = `FolderManifest` — replaceable, `d = folderId`. This one legitimately wants replaceable semantics (it's "current folder state," history is recoverable from the file nodes underneath it).

**Two real protocol bugs were found and fixed — both are exactly the kind of thing that looks fine until you actually run it:**
1. NIP-01 `#<tag>` filters are only guaranteed to work for single-letter tag names. Tags are `file`/`folder` (descriptive, multi-letter) *plus* `F`/`D` (single-letter mirrors, used for actual filtering). If you add new filterable tag data, follow this pattern — don't filter on a multi-letter tag name and assume it'll work on relays other than khatru's specific (self-described as "very bad") loose-matching sqlite backend.
2. Replaceable events (`FolderManifest`) can lose "last write wins" if two publishes land in the same wall-clock second — NIP-33 tie-breaks on event id, not intent. `store.ts`'s `upsertManifestEntry` forces each manifest's `created_at` strictly past the previous manifest's own `created_at`, not just `Date.now()/1000`. This was caught by the test suite failing, not by inspection — if you touch manifest publishing, keep a test that does two rapid-fire updates and asserts the second one wins.

**Ordering within a file's history never trusts `created_at`** (it's second-resolution per NIP-01, too coarse). It's established by walking the explicit `e...prev` chain backward from the folder manifest's `latestNodeId`. Per-delta `timestamp` fields (ms-precision, inside the JSON content, not the event envelope) are what carry fine-grained rhythm data — see the protocol doc's note on why diff-sourced deltas all share one timestamp while editor-sourced deltas (once a real editor exists) would each get their own.

**"Voices" are named signing identities, not one global identity.** `apps/harness/src/voice.ts`. Two ways to get one: `createLocal(name)` generates a fresh keypair (only way local key material enters the system), or `connectRemote(name, bunkerUri)` wires up an external NIP-46 signer via `nostr-tools`'s `BunkerSigner`. **There is deliberately no import-existing-key path anywhere in the codebase.** This is a security posture the user was explicit about — don't add one, even as a convenience feature, without checking first.

**Client architecture (confirmed, not yet built):** one shared React codebase targets both web and desktop via Tauri (chosen over Electron — smaller footprint, Rust shell is a natural fit for spawning the relay sidecar). Desktop spins up its own local relay (the same `relay/zine-relay` binary) as a sidecar; the web app is a thin client of whatever relay is serving that deployment. Desktop never exposes its local relay to the internet — publishing to other relays is a client-initiated push action, never inbound. Main view: a two-panel layout like Cursor (editor/document surface + agent chat/instruction panel), Obsidian-ish in overall emphasis since this is fundamentally a tool for writers.

**Hosted/self-hosted relay (not yet built):** same khatru codebase as the local relay, Postgres-backed instead of sqlite, packaged as a docker-compose target (relay + Postgres + a web app that lets people download the desktop/mobile clients and connects to that instance) so people can self-host "their own press." Needs an operator/staff admin layer that khatru doesn't provide out of the box — that's custom work on top, not yet designed in detail.

## What's built and verified

Every piece below was actually run and checked, not just written — this session's working pattern was real end-to-end verification (spawn real processes, sign real events, read raw sqlite rows), not typecheck-and-hope. Keep that standard.

- **`protocol/trace-provenance.md`** — the spec. Keep it in sync with the code; it already documents both bugs above and several deliberately deferred questions (merge-conflict resolution, `sign`/zine-publication semantics, real kind-number registration).
- **`relay/main.go`** — builds with `cd relay && go build -o zine-relay .`. Verified via a real signed-event publish/query round-trip against the running binary (not just a build check).
- **`apps/harness`** — the CLI, built with `npm run build` (outputs `dist/cli.js`, also has a `bin: tracer` entry). Commands: `attach <folder>`, `run <instruction> --file <path> [--provider openai|anthropic] [--base-url ...]` (the agent loop — single-file, full-rewrite only, no tool-calling yet), `log <file>`, `watch <folder>` (external-edit detection), `voice create/connect/list`. Test suite (`npm test`, 4 tests) spins up a real relay instance per test. All verified live via manual CLI runs in this session, including a fake local OpenAI-compatible server for the LLM path.
- **`apps/tracer`** (Dart/Flutter) — fully working but superseded direction. Don't build on it; don't delete it without asking.

## What's explicitly NOT built — pick your next task from here

Roughly in the order this session was heading, but use judgment:

1. **The Tauri + React client.** This is the natural next major component — everything else (protocol, relay, harness, signing) exists to support it. Two-panel Cursor-style layout, confirmed direction. Nothing started yet — no scaffold, no dependency choices made beyond "React" and "Tauri."
2. **Sidecar-spawning from the desktop app** — trivial once the client exists, spawn `relay/zine-relay` the same way `apps/harness/src/relay-client.ts` already does for the CLI.
3. **Postgres-backed hosted relay + docker-compose packaging.**
4. **`q`-tag quoting/composability between files** — the protocol supports it (NIP-18-style `q` tags pinning to a specific source `FileTraceNode`), nothing publishes or resolves them yet.
5. **Multi-file / tool-calling agent loop** — current agent is deliberately scoped to single-file full-rewrite; going further (multi-file edits, tool calls) is real new scope, not a small extension.
6. **Merge-conflict resolution strategy** — flagged as an open question in the protocol doc, needed before multi-device sync means anything.
7. **Live-verify the NIP-46 external signer path** — implemented against `nostr-tools`'s real `BunkerSigner`, but there was no actual external signer app available in this environment to test the live handshake against. If one becomes available, verify it the way everything else here was verified.

## Rough edges to know about

- `apps/harness`'s default relay-binary lookup assumes the monorepo layout (`apps/harness/src/../../../relay/zine-relay`); override with `TRACER_RELAY_BIN` env var if that ever changes.
- The relay binary has to be built before harness tests or auto-spawn will work — `cd relay && go build -o zine-relay .`.
- TypeScript in this project is pinned to whatever `npm install typescript` resolved to at session time (showed up as `7.0.2`, likely a newer/different compiler than you're expecting) — if you hit `Cannot find name 'node:fs'`-style errors that look like missing `@types/node`, check `tsconfig.json`'s `types` field before assuming a dependency problem; it needed an explicit `"types": ["node"]` to resolve correctly under this compiler version.

## How to work in this codebase

Verify by actually running things — spawn the real relay, sign real events, read the raw sqlite rows, hit the real CLI. Don't stop at "it compiles" or "the test mocks it correctly." Ask before making consequential, hard-to-reverse architecture calls (language/framework choices, relay implementation approach, client shell) — several were explicitly confirmed with the user this session rather than assumed; keep that pattern for anything of similar weight.

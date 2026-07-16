# zine

Zine is an open, BYOK (bring-your-own-API-key) editor for files and folders.
Every human or LLM edit becomes composable, cryptographically signed
provenance. Its Nostr-based trace protocol stores each checkpoint as a signed
event. Copied passages become immutable **coins**, cited by an exact node id.

A **press** is the editor, not a server. Every press writes to its own relay,
even when that relay is the quiet local one on the author's machine. A shared
relay is optional, useful only when a press should serve a circle or the
public.

For the wire format and mechanics, read
[protocol documentation](protocol/README.md). Its index assigns authority by
domain; if anything here disagrees with an owning spec, that spec wins.

## Quickstart

```sh
git clone <repo> && cd zine
npm run dev
```

The script checks prerequisites, builds the relay sidecar, installs client
dependencies when needed, and launches the Tauri app. Later runs skip the
relay build when its sources have not changed.

**Prerequisites:** [Go](https://go.dev/dl/) ≥ 1.25, [Node](https://nodejs.org/) ≥ 20.19,
[Rust](https://rustup.rs/) (stable). On macOS run `xcode-select --install`
first; for other platforms see the
[Tauri prereqs](https://v2.tauri.app/start/prerequisites/).

**Tor is optional.** It is needed only for inbound peer reachability over onion
services. Local authoring and clearnet publishing work without it. Install it
later with `brew install tor` (macOS) or
`apt install tor` (Linux).

For a production bundle (per-platform installers), see
[the client release guide](apps/client/README.md#release-builds).

## Repo layout

```
/
├── protocol/                      — trace, transport, and rendezvous specs, plus the About tour
├── relay/                         — Go module, khatru-based relay (local sidecar + hosted super-peer)
├── Dockerfile, docker-compose.yml — the super-peer image: relay + webapp (apps/client built for the browser)
├── research/                      — completed narration A/B study (rubric, scoring, and raw outputs)
└── apps/
    ├── client/                    — React/Tauri press
    └── mcp/                       — headless MCP press
```

## Documentation map

- [Protocol index](protocol/README.md): authority and status language for the
  three specifications and the Director's Cut used by the app's About view.
- [Client development and releases](apps/client/README.md): frontend, Tauri,
  and per-platform bundle commands.
- [Headless MCP press](apps/mcp/README.md): tools, installation, and client
  configuration.
- [Deferred fork-on-write work](apps/client/FORK-ON-WRITE.md): the known nested
  ownership gap and implementation plan.
- Narration study: [pre-registration](research/narration-rubric.md) and
  [results](research/results.md), with raw model outputs preserved alongside
  them.

## Working in this codebase

Verify behavior against the real system: run the relay, sign events, inspect
the SQLite rows, and exercise the client. Compilation and mocked tests are not
enough for provenance, storage, or networking changes. Ask before changing
frameworks, relay architecture, the client shell, or other hard-to-reverse
boundaries.

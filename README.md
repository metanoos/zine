# zine

An open, BYOK (bring-your-own-API-key) LLM harness for editing files and
folders — every edit, human or LLM, is composable, cryptographically signed
provenance. The trace protocol is Nostr-based: every save is a signed event,
and files quote from each other by pinning to a specific version.

A **press** is the client interface itself (the editor), not a server —
every press already seals to a relay of its own, even if that's just the
quiet local one on the author's machine. Running a bigger, shared relay is a
separate, optional move for anyone who wants their press to serve a circle
or the public — that's not the bar for having your own press.

For the wire format and mechanics, read
[`protocol/trace-provenance.md`](protocol/trace-provenance.md) — it's the
source of truth; if anything here disagrees with it, the protocol doc wins.

## Quickstart

```sh
git clone <repo> && cd zine
npm run dev
```

That's it — the script checks prerequisites, builds the relay sidecar, installs
the client's deps if needed, and launches the Tauri app. Repeat runs are instant
(the relay build is skipped when the sources haven't changed).

**Prerequisites:** [Go](https://go.dev/dl/) ≥ 1.25, [Node](https://nodejs.org/) ≥ 20,
[Rust](https://rustup.rs/) (stable). On macOS run `xcode-select --install`
first; for other platforms see the
[Tauri prereqs](https://v2.tauri.app/start/prerequisites/).

**Tor is optional** — only needed for inbound peer reachability over onion
services. Without it everything else works (local authoring, clearnet
publishing). Install it later with `brew install tor` (macOS) or
`apt install tor` (Linux).

For a production bundle (per-platform installers), see
[`apps/client/src-tauri/BUILD.md`](apps/client/src-tauri/BUILD.md).

## Repo layout

```
/
├── protocol/trace-provenance.md   — the protocol spec (NIP-style doc)
├── relay/                         — Go module, khatru-based relay (local sidecar + hosted super-peer)
├── Dockerfile, docker-compose.yml — the super-peer image: relay + webapp (apps/client built for the browser)
├── research/                      — pre-registered narration A/B study (rubric + outputs)
└── apps/
    └── client/                    — Tauri + React desktop press: editor, palette, alpha tuning, sampler — see apps/client/README.md
```

## Working in this codebase

Verify by actually running things — spawn the real relay, sign real events,
read the raw sqlite rows, hit the real client. Don't stop at "it
compiles" or "the test mocks it correctly." Ask before making consequential,
hard-to-reverse architecture calls (language/framework choices, relay
implementation approach, client shell) rather than assuming.

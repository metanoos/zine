# Zine client

The React/Vite client powers both the Tauri desktop press and the hosted web
app. Tauri starts the local relay sidecar and gives the frontend access to the
filesystem, Tor, and native LLM commands.

This client is the reference authoring and review experience for the open
trace protocol. Zine's adoption wedge is teams tracing agent-written durable
files, while the current build focus is the trace-aware writing loop: prepare a
bounded account of text plus process, inspect its instruction/data boundary,
approve the exact request, and return accepted MODEL work to the trace. Native
multi-AI tasks and correspondence remain later operation families, not a
separate product center. The [headless MCP press](../mcp/README.md) remains the
outside-in interoperability path for MCP-capable harnesses, with claims limited
to what that integration observes. See the
[documentation hub](../../docs/README.md), [product framing](../../docs/PRODUCT.md),
[protocol tour](../../docs/PROTOCOL.md), [evidence ledger](../../docs/EVIDENCE.md),
and [roadmap](../../docs/ROADMAP.md) for the sequence around it. The app's
About view renders those same reader-facing Markdown sources directly.

## Develop

From the repository root, run the complete desktop stack:

```sh
npm run dev
```

For the browser frontend alone:

```sh
cd apps/client
npm ci
npm run dev
```

The browser build uses local storage and the configured web relay. Native
filesystem and sidecar behavior requires the Tauri stack.

The hosted browser surface is deliberately read-only and model-free: it cannot
sign, Send, Attest, or execute MODEL actions until the deferred encrypted
browser vault exists.

Nested paths are stored as recursive folder traces, not slash-joined file
names. Scanning a source tree preserves its directory hierarchy inside the
private Scan folder, and adopting or forking a file into Root creates any
missing destination folders and updates each ancestor manifest. Recursive
fork-on-write through an already-foreign folder remains the separate deferred
case documented below.

## Collaboration core

The first collaboration vertical slice is provider-neutral, durable, and
folder-scoped. A Collaboration copies the same singular mount plus shield
resolver used for MODEL context, then intersects that scope with default-deny
participant capabilities. It is not limited to one simultaneous editing
window: participants may disconnect, edit at different times, and catch up
from retained signed operation history. Connected peers additionally exchange
ephemeral live presence.

The directory is a typed Yjs document keyed by the workspace entries' existing
stable IDs; joining a Collaboration does not mint replacement file or folder
identities. Every readable file has its own Y.Doc/Y.Text boundary. Participant
identities sign edit batches and individual folder operations, while the
operation's actor pubkey remains voice attribution. Joining requires an
explicit `collaboration.join` grant. Initial directory/file snapshots are
recipient-bound and signed by the owner; unknown or unreadable file documents
are rejected at bootstrap and access time. Merged Yjs state is never used to
infer actor boundaries: the signed accepted-operation log stays parallel to it.

Remote cursors use ephemeral Awareness and Yjs-relative positions. Exact
before/after selections remain in signed editor transactions. CodeMirror
keeps a short same-file, same-actor run in an isolated local draft, then emits
`file.edit.batch`: one merged Yjs update and one signature over its causal base
snapshot plus the untouched ordered `editorTransactions` array. A receiver
reconstructs that base and rejects an update whose materialized text differs
from the signed transactions. The default flush window is 80 ms, bounded to 32
transactions or roughly 32 KiB, with immediate flushes at undo/redo, blur,
file/voice teardown, explicit Step preparation, and before an intervening
remote edit is applied. A failed or revoked commit never mutates shared Yjs;
the local draft becomes a private patch/fork. CodeMirror also uses incremental
remote deltas and actor-scoped undo, so Undo never removes a peer's work.
Concurrent same-name directory operations converge: the lowest stable ID keeps
the requested name and other entries receive deterministic hash suffixes in
the materialized workspace. A Step captures and acknowledges one exact
accepted batch prefix, leaving edits that arrived during signing pending. The
current in-memory peer link proves the transport boundary; production durable
storage, peer discovery, encrypted per-file transport, invitation/access UI,
and visible collaboration UI remain later slices. Overall panel layouts are
not Collaboration state.

## Stage core

Stage is a separate optional document inside one Collaboration, not a mode for the
whole workspace. Its shared state is a strict, versioned cluster of one or two
stable-ID panels containing resource, mode, active panel, arrangement,
selection, scroll/fold/preview anchors, and an optional Replay presentation.
Signed participant commands enforce the Collaboration's view/start/control/end
capabilities and readable mount boundary. The starter is the first Stage
Controller; passing control requires recipient acceptance. A disconnected
Controller freezes Stage during a short grace period, then leaves it vacant
for owner recovery or ending.

The workspace adapter keeps the rest of each layout private. Joining an active
Stage follows automatically; direct navigation, scroll, selection, or typing
inside a followed panel detaches locally first, while private-panel work does
not. Rejoin applies the complete latest snapshot. Ending Stage leaves its final
panels as ordinary private panels. In-place Replay suspension is an opaque
participant-private sidecar, so unstepped text, scroll pixels, and undo state
never enter shared Stage JSON. Production peer transport and visible Stage
controls are still deferred.

The first Replay-in-Stage presentation reducer is also implemented. It changes
exactly one stable panel in place, preserves the panel's slot and arrangement,
scopes playhead changes to that panel, and pauses/resets when its trace set
changes. Return to Work accepts only restored view fields; the opaque editor
suspension remains local. If a follower presses Play or scrubs, the same
transition first detaches and mutates only that participant's private
projection. The visible controls and concrete CodeMirror suspension/restore
binding are still deferred.

Two transport boundaries are intentionally not hidden by this core. Stage
projection gating is not plaintext confidentiality: a provider must avoid
delivering unreadable Stage commands, and production read privacy needs
encryption. Controller disconnect/vacancy transitions also require one ordered
provider-wide fence; independently inferred disconnects on an unordered mesh
can diverge. A production peer provider must supply that sequencer/epoch before
these transitions are wired to P2P.

## Trace-aware MODEL preparation

Direct single-shot MODEL gestures freeze their target revision, mounted
context, provider profile, voice, lens, and exact messages before approval.
Prompt Inspector shows that prepared request and its trace-context boundary.

Append (internal operation id `extend`) and Settle are the first operations using the shared
`@zine/trace-context` syntax kernel. `[[…]]` remains exact quoted data.
A complete `((…))` candidate becomes an instruction only when every byte was
typed directly by the acting local author during the current mounted editor
session and lies wholly inside the prepared operation range. Paste, drop,
MODEL, undo/redo restoration, reload, mixed origin, wrong-author, malformed,
and unknown bytes remain inert quoted data. Accepted Append/Settle results
validate protected content and remove consumed directives as part of the same
editor transaction.

Desktop Append adds a vault-scoped encrypted operation journal around that
prepared boundary. It durably records the exact approved request, selected
context, provider profile, attempt, provisional result, local application
intent, and exact crash-pad receipt. Recovery never redispatches a provider
request whose outcome may be unknown; retrying that state requires an explicit
possible-duplicate acknowledgement. Results remain provisional until the
writer accepts a compare-and-set application. Lock, reload recovery, and
factory reset close native registration, cancel and drain active HTTP work,
and verify the registry is empty before releasing the vault binding.

This is still a dogfood slice, not the finished context system. Directive
authority deliberately does not persist across reloads or moves; an expired
directive-bearing attempt must be re-prepared under current-session authority.
Explicit promotion, Inspector exclusions and corrections, task-specific
evidence selection, scoped memory, durable Settle and other operation adapters,
MCP parity, and portable signed result-to-context binding remain deferred. The
private journal is recovery state, not protocol provenance.

## Agent run recipes

The MODEL row's **Run** action supports one-off goals and browser-local saved
recipes. A recipe can be manual-only, hourly, or daily; scheduled recipes are
checked while Zine is open and the workspace is ready, and wait while another
model operation is active. Each save captures the workspace's permanent id and
its one mounted scope. An overdue recipe waits until that exact
workspace is open, and switching workspaces stops an in-flight run. A
browser-wide single-flight lock prevents two Zine windows from claiming the
same scheduler slot. Closing Zine stops the scheduler.

Every invocation uses the existing agent sandbox and can only read context and
write unstepped drafts. Its read/list tools are restricted to the saved scope
(plus its own run folder). It cannot Step, Send, Attest, delete, or change peers.
Each run writes a draft `run.json` beside `output.md` with its goal, safe model
metadata, trigger, scope, timestamps, and terminal status. Provider API keys
are never copied into the manifest.

## Verify

```sh
cd apps/client
npm test
npm run build

cd src-tauri
cargo test
```

### Cross-model prompt evaluation

The prompt eval compares role-name-only prompts, the built-in operation
contracts, and contracts plus operation-scoped lenses for Append, Settle,
Stir, Reply, and Receive. It requires at least two models and reads API keys
from named environment variables rather than from the config file:

```json
{
  "draws": 2,
  "models": [
    {
      "id": "model-a",
      "label": "Model A",
      "protocol": "openai",
      "baseUrl": "https://provider.example/v1",
      "modelId": "model-a",
      "apiKeyEnv": "MODEL_A_API_KEY"
    },
    {
      "id": "model-b",
      "label": "Model B",
      "protocol": "anthropic",
      "baseUrl": "https://api.anthropic.com",
      "modelId": "model-b",
      "apiKeyEnv": "MODEL_B_API_KEY"
    }
  ]
}
```

Run `npm run eval:prompts -- ./prompt-eval.config.json`. Raw outputs and
mechanical criterion scores are written under `research/prompt-evals/` by
default. Do not commit a config containing credentials.

See the [repository guide](../../README.md) and
[protocol index](../../protocol/README.md). The deferred nested fork-on-write
work is tracked in [FORK-ON-WRITE.md](FORK-ON-WRITE.md).

## Release builds

The current release target is a local macOS dogfood bundle, not a public
release. From a clean checkout on the Mac that will run the app:

```sh
npm run dogfood:macos
```

The command checks macOS and current-machine architecture, Node 24 LTS, npm,
Go 1.25 or newer with CGO, Rust/Cargo, and the Xcode CLI tools before it builds
anything. It runs locked `npm ci` when client dependencies are absent or stale;
it never installs system tools. Install Xcode's tools with
`xcode-select --install` and use the upstream Node, Go, and Rust installers if
a prerequisite check tells you one is missing.

The relay is always rebuilt directly from the current `relay/` Go sources into
the exact Tauri resource path. The command records source and binary SHA-256
provenance, proves the thin Mach-O architecture matches the host, then invokes
the existing production `tauri build` for the macOS app and DMG. Afterward it
inspects both copies of the app and fails if identity/version, executable mode,
architecture, the bounded relay help probe, signature structure, or the
unsafe-content scan is wrong.

All outputs are ignored build artifacts:

```text
apps/client/src-tauri/binaries/zine-relay
apps/client/src-tauri/target/dogfood/relay-provenance.json
apps/client/src-tauri/target/dogfood/report.json
apps/client/src-tauri/target/dogfood/<rust-target>/release/bundle/macos/client.app
apps/client/src-tauri/target/dogfood/<rust-target>/release/bundle/dmg/*.dmg
```

Temporary DMG mount state is removed after inspection. The command does not
delete the normal Tauri target directory or any user-supplied artifact.

### Install and open

Open the generated DMG and drag `client.app` to Applications, or open the
verified app in place:

```sh
open apps/client/src-tauri/target/dogfood/*/release/bundle/macos/client.app
```

This bundle uses a Tauri
[ad-hoc signature](https://v2.tauri.app/distribute/sign/macos/#ad-hoc-signing)
(`-`), with no Apple signing certificate, and is not notarized. macOS may
require Control-click → **Open**, or approval in System Settings → Privacy &
Security, on first launch. It is suitable only for dogfood on the current
machine and architecture.

Tor is deliberately not bundled or claimed. Local authoring and clearnet relay
publishing work without it; inbound onion reachability does not. Developers can
still test a system Tor install with `TRACER_TOR_BIN`, but packaging a portable
Tor runtime is separate release work.

### Explicit non-goals

- No Developer ID signing, notarization, publishing, registry action, or copy
  into `downloads/`.
- No public release workflow or GitHub release.
- No clean-machine Windows/Linux matrix or cross-compilation.
- No MCP package artifact; `zine-mcp` packaging is owned separately.

Signed and notarized public macOS releases and the Windows/Linux matrix remain
deferred roadmap work.

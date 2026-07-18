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

## Desktop vaults

Desktop startup lists the local vaults and unlocks exactly one for the session.
Each vault has its own passphrase, Stronghold snapshot and KDF salt, permanent
Root, encrypted workspace records, relay database, access-control list, public
key/model profiles, crash pads, layouts, recipes, and other local workspace
state. Logical webview keys and values are both hidden before unlock, while
per-record ciphertext keeps ordinary editor saves proportional to the record
that changed. Appearance preferences such as theme and navigation width remain
shared across the install. The **Vaults** view, immediately before **Keys**,
can lock the active vault, switch to another vault, or create a new one.
Locking is fail-closed: another vault is never selectable until Stronghold,
relay, and Tor reachability have all confirmed shutdown. Normal application
exit performs the same native shutdown; an unexpected stale listener blocks
the next unlock instead of being reused across vaults.

Installs created before multi-vault support are adopted in place as a vault
named **Personal**. Its Stronghold snapshot and KDF salt are neither moved nor
re-encrypted, so the existing passphrase continues to work. Its existing relay
database and ACL remain at `~/.tracer`; every newly-created vault keeps those
files in its own native directory. After the first successful legacy unlock,
plaintext webview workspace records are migrated into encrypted vault storage.
Factory reset remains the only operation that deletes every local vault.

Relay databases are physically partitioned and bound only after their vault
unlocks, but their canonical signed protocol events are not additionally
encrypted with the vault passphrase at rest.

Nested paths are stored as recursive folder traces, not slash-joined file
names. Scanning a source tree preserves its directory hierarchy inside the
private Scan folder, and adopting or forking a file into Root creates any
missing destination folders and updates each ancestor manifest. Recursive
fork-on-write through an already-foreign folder remains the separate deferred
case documented below.

## Trace-aware MODEL preparation

Direct single-shot MODEL gestures freeze their target revision, mounted
context, provider profile, voice, lens, and exact messages before approval.
Prompt Inspector shows that prepared request and its trace-context boundary.

Extend and Settle are the first operations using the shared
`@zine/trace-context` syntax kernel. `[[…]]` remains exact quoted data.
A complete `((…))` candidate becomes an instruction only when every byte was
typed directly by the acting local author during the current mounted editor
session and lies wholly inside the prepared operation range. Paste, drop,
MODEL, undo/redo restoration, reload, mixed origin, wrong-author, malformed,
and unknown bytes remain inert quoted data. Accepted Settle results validate
protected content and remove consumed directives as part of the same editor
transaction. Desktop Extend now uses the encrypted native operation journal,
explicit provisional-result review, and an idempotent local apply receipt.
Until that private envelope carries the exact directive-deletion plan, an
Extend request with active `((…))` directives fails closed before provider I/O.

This is a dogfood slice, not the finished context system. Plain Extend request,
response-review, and local-apply recovery are durable; directive authority is
not yet persisted across reloads or moves. Explicit promotion, recoverable
directive consumption, signed result-to-context binding, scoped memory,
Stir/Reply/Analyze/Run authoring adapters, and MCP parity are still deferred.

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
contracts, and contracts plus operation-scoped lenses for Extend, Settle,
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

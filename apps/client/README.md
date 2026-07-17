# Zine client

The React/Vite client powers both the Tauri desktop press and the hosted web
app. Tauri starts the local relay sidecar and gives the frontend access to the
filesystem, Tor, and native LLM commands.

This client is the reference authoring and review experience for the open
trace protocol. The initial product wedge is the
[headless MCP press](../mcp/README.md); see the
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

## Agent run recipes

The MODEL row's **Run** action supports one-off goals and browser-local saved
recipes. A recipe can be manual-only, hourly, or daily; scheduled recipes are
checked while Zine is open and the workspace is ready, and wait while another
model operation is active. Each save captures the workspace's permanent id and
the complete set of mounted scopes. An overdue recipe waits until that exact
workspace is open, and switching workspaces stops an in-flight run. A
browser-wide single-flight lock prevents two Zine windows from claiming the
same scheduler slot. Closing Zine stops the scheduler.

Every invocation uses the existing agent sandbox and can only read context and
write unstepped drafts. Its read/list tools are restricted to the saved scope
union (plus its own run folder). It cannot Step, Send, Attest, delete, or change peers.
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

The desktop app bundles a prebuilt `zine-relay` binary as a Tauri resource.
Users therefore need neither a repository checkout nor a separate relay
runtime. Build the relay for the target platform, then build the Tauri bundle.

> Tauri cannot produce all three platform installers from one host. Build each
> target on a matching machine or CI runner.

### Prerequisites

- Go ≥ 1.25 to build the relay
- Node 24 LTS for the Tauri frontend
- Rust stable plus the Tauri prerequisites for your platform:
  - **macOS:** Xcode CLI tools. `xcode-select --install`
  - **Windows:** WebView2 plus MSVC build tools
  - **Linux:** `webkit2gtk-4.1`, `libgtk-3`, `libappindicator`, `librsvg`
    (see [the Tauri Linux prerequisites](https://v2.tauri.app/start/prerequisites/))

### 1. Build the relay into the bundle resource path

From the repository root, for your current platform:

```sh
cd relay
go build -o ../apps/client/src-tauri/binaries/zine-relay .
cd ..
```

This creates `apps/client/src-tauri/binaries/zine-relay`, the path declared in
`tauri.conf.json` under `bundle.resources`. The Tauri build script checks that
the path exists, so step 2 fails loudly if you skip this.

> **Target architecture matters:** the relay uses a CGO-backed SQLite driver,
> so `GOOS` and `GOARCH` alone are not a complete cross-compilation setup.
> Build the relay on the same platform and architecture as the Tauri bundle,
> or provide an appropriate cross C toolchain.

### 1b. Source the Tor binary for networked reachability

Tor is an optional sidecar, needed only for inbound peer reachability over
onion services (see `protocol/transport.md`). In local mode, with no
`peers.json`, the app works without it. The repository's `binaries/tor` is an
intentional failing placeholder; replace it with a real executable before
testing a networked bundle.

| Platform | Local bundle smoke-test source |
|---|---|
| **macOS** | `brew install tor && cp "$(which tor)" apps/client/src-tauri/binaries/tor` |
| **Linux** | `apt install tor && cp "$(which tor)" apps/client/src-tauri/binaries/tor` |
| **Windows** | Download the [Tor Expert Bundle](https://www.torproject.org/download/tor/), then place `tor.exe` at `apps/client/src-tauri/binaries/tor.exe` |

These copy commands work for a local smoke test; they do not prove that the
Tor executable is portable. A release bundle must include its required
dynamic libraries and adjacent runtime files. Test the installed artifact on
a clean machine before publishing it.

> **Develop without bundling:** install Tor system-wide and set
> `TRACER_TOR_BIN` to its path. `resolve_tor_binary` in
> `src-tauri/src/lib.rs` also checks `PATH`, so a plain `brew install tor` may
> work without an environment variable.

> **Missing Tor is non-fatal:** `spawn_tor` returns an error if no binary is
> found, but the app continues without onion reachability. Peers cannot reach
> you, while local authoring and clearnet publishing keep working.

### 2. Build the Tauri bundle

From `apps/client`:

```sh
cd apps/client
npm ci
npm run tauri build
```

Output lands in `apps/client/src-tauri/target/release/bundle/`:

| Platform | Artifact |
|---|---|
| macOS | `bundle/dmg/*.dmg` plus `.app.tar.gz` |
| Windows | `bundle/msi/*.msi` and/or `nsis/*.exe` |
| Linux | `bundle/appimage/*.AppImage`, `bundle/deb/*.deb` |

### 3. Publish to the download page

Copy the artifacts into the hosted image's `downloads/` directory, the volume
mounted at `/app/downloads` in `docker-compose.yml`:

```sh
cp apps/client/src-tauri/target/release/bundle/dmg/*.dmg downloads/
cp apps/client/src-tauri/target/release/bundle/msi/*.msi downloads/
cp apps/client/src-tauri/target/release/bundle/appimage/*.AppImage downloads/
```

The server scans `downloads/` on every request to
`/downloads/manifest.json`, so the Download page sees the new build on reload.
No server rebuild or registry is involved.

### Artifact naming

The Download page infers platform and architecture from the filename. Tauri's
default output already matches. If you rename an artifact, retain these
substrings:

- **macOS:** `.dmg` or `.app.tar.gz`
- **Windows:** `.msi` or `.exe`
- **Linux:** `.AppImage`, `.deb`, or `.rpm`
- **Architecture:** `aarch64`/`arm64` for arm64;
  `x86_64`/`x64`/`amd64` for x64

### CI status

There is no release matrix yet. The intended GitHub Actions matrix uses
`macos-latest`, `windows-latest`, and `ubuntu-22.04`, runs steps 1 and 2 on
each platform, uploads the artifacts, and copies them into `downloads/`.

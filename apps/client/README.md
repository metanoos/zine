# zine client

The React/Vite client powers both the Tauri desktop press and the hosted web
app. Tauri starts the local relay sidecar and gives the frontend access to the
filesystem, Tor, and native LLM commands.

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

## Verify

```sh
cd apps/client
npm test
npm run build

cd src-tauri
cargo test
```

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
- Node ≥ 20.19 for the Tauri frontend
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

# Building the desktop app

The desktop app bundles a prebuilt `zine-relay` binary as a Tauri resource, so
the install you ship actually has a relay to talk to (no repo checkout, no
external download at runtime). That means the build is two steps: build the
relay for the host platform, then build the Tauri bundle.

> Tauri can't cross-build macOS / Windows / Linux installers in one container,
> so each target is built on a machine (or CI runner) of that platform. This
> file is the per-platform recipe.

## Prerequisites

- Go ≥ 1.25 (to build the relay)
- Node ≥ 20 (the webapp is the Tauri frontend)
- Rust (stable) + the Tauri prerequisites for your platform:
  - **macOS**: Xcode CLI tools. `xcode-select --install`
  - **Windows**: WebView2 + MSVC build tools
  - **Linux**: `webkit2gtk-4.1`, `libgtk-3`, `libappindicator`, `librsvg`
    (see [the Tauri Linux prereqs](https://v2.tauri.app/start/prerequisites/))

## 1. Build the relay into the bundle resource path

From the repo root, for your current platform:

```sh
cd relay
go build -o ../apps/client/src-tauri/binaries/zine-relay .
cd ..
```

This drops the binary at `apps/client/src-tauri/binaries/zine-relay`, which is
the path declared in `tauri.conf.json` → `bundle.resources`. The Tauri build
script checks this path exists, so step 2 below will fail loudly if you skip
this.

> **Cross-compiling the relay:** if you're building the desktop bundle on an
> x86-64 host for arm64 (or vice versa), set the Go target:
> `GOOS=darwin GOARCH=arm64 go build -o .../binaries/zine-relay .`

## 1b. Source the Tor binary (for friend-mode reachability)

Tor is an optional sidecar — only needed for inbound friend reachability over
onion services (see `protocol/transport.md`). In open mode (no `friends.json`),
the app works without it. The binary is bundled the same way as the relay, so
drop it at `apps/client/src-tauri/binaries/tor`:

| Platform | How to get a static tor binary |
|----------|-------------------------------|
| **macOS** | `brew install tor && cp "$(which tor)" apps/client/src-tauri/binaries/tor` |
| **Linux** | `apt install tor && cp "$(which tor)" apps/client/src-tauri/binaries/tor` |
| **Windows** | Download the [Tor Expert Bundle](https://www.torproject.org/download/tor/), place `tor.exe` at `apps/client/src-tauri/binaries/tor.exe` |

> **Dev without bundling:** if you don't want to bundle tor (e.g. during
> development), install it system-wide and set `TRACER_TOR_BIN` to its path.
> The `resolve_tor_binary` function in `src-tauri/src/lib.rs` also checks
> `PATH` as a fallback, so a plain `brew install tor` may work with no env var.

> **Missing tor is non-fatal:** `spawn_tor` returns an error if no binary is
> found, but the app continues without onion reachability — friends can't reach
> you, but local authoring and clearnet publishing work normally.

## 2. Build the Tauri bundle

From `apps/client`:

```sh
cd apps/client
npm ci          # first time only
npm run tauri build
```

Output lands in `apps/client/src-tauri/target/release/bundle/`:

| Platform | Artifact                             |
|----------|--------------------------------------|
| macOS    | `bundle/dmg/*.dmg` (+ `.app.tar.gz`) |
| Windows  | `bundle/msi/*.msi` and/or `nsis/*.exe` |
| Linux    | `bundle/appimage/*.AppImage`, `bundle/deb/*.deb` |

## 3. Publish to the download page

Copy the artifact(s) into the hosted image's `downloads/` directory (the
volume mounted at `/app/downloads` in `docker-compose.yml`):

```sh
cp apps/client/src-tauri/target/release/bundle/dmg/*.dmg   ../../downloads/
cp apps/client/src-tauri/target/release/bundle/msi/*.msi   ../../downloads/
cp apps/client/src-tauri/target/release/bundle/appimage/*.AppImage ../../downloads/
```

No rebuild, no registry — the server scans `downloads/` on every request to
`/downloads/manifest.json`, so the Download page picks the new build up on
reload.

## Naming convention for auto-classification

The download page infers platform/arch from the filename. Tauri's default
output already matches, but if you rename, keep these substrings so the
classifier works:

- **macOS**: `.dmg` or `.app.tar.gz`
- **Windows**: `.msi` or `.exe`
- **Linux**: `.AppImage`, `.deb`, or `.rpm`
- **arch**: `aarch64`/`arm64` → arm64; `x86_64`/`x64`/`amd64` → x64

## CI (follow-up, not done here)

The natural next step is a GitHub Actions matrix (`macos-latest`,
`windows-latest`, `ubuntu-22.04`) that runs steps 1–2 per platform and uploads
the artifacts to a release, then a small job drops them into `downloads/`. Not
wired in this change.

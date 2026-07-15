// Builds the Go relay (`relay/zine-relay`) — the binary the desktop app spawns
// as a sidecar on first publish. A fresh clone ships no binaries (they're
// gitignored: see `.gitignore` → `relay/zine-relay`), so this is the step that
// makes `tauri dev` actually run.
//
// Why the repo-root path and not `apps/client/src-tauri/binaries/`: the Rust
// resolver (apps/client/src-tauri/src/lib.rs → resolve_relay_binary) has a
// monorepo fallback that finds `relay/zine-relay` relative to
// CARGO_MANIFEST_DIR. That's the path dev uses; `binaries/` is only needed for
// a production bundle (see apps/client/src-tauri/BUILD.md).
//
// Staleness: if the built binary is newer than every relay source file
// (*.go + go.mod + go.sum), skip the rebuild — so re-running `npm run dev` is
// instant when nothing changed. A cold build is ~7s, which adds up when you
// relaunch the app often.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const relayDir = join(repoRoot, "relay");
// Windows executables need the .exe suffix or Go writes a file named literally
// `zine-relay` that won't execute, and existsSync misses it in the resolver.
const EXE = process.platform === "win32" ? ".exe" : "";
const relayBin = join(relayDir, `zine-relay${EXE}`);

// Source files whose modification should trigger a rebuild. *.go is obvious;
// go.mod/go.sum cover dependency bumps (a dep change won't touch *.go).
const SOURCE_SUFFIXES = [".go", ".mod", ".sum"];

/// Resolve `go` once; throw with an install hint if it's missing so the failure
/// is actionable instead of a cryptic spawn ENOENT.
function findGo() {
  try {
    execFileSync("go", ["version"], { stdio: "ignore" });
  } catch {
    console.error(
      "\n✗ Go is not installed (needed to build the relay).\n" +
        "  Install Go ≥ 1.25: https://go.dev/dl/\n"
    );
    process.exit(1);
  }
}

/// True if the relay binary is up-to-date relative to its sources. Used to make
/// repeat runs instant.
export function isRelayFresh() {
  if (!existsSync(relayBin)) return false;
  const binMtime = statSync(relayBin).mtimeMs;
  for (const name of readdirSync(relayDir)) {
    if (!SOURCE_SUFFIXES.some((s) => name.endsWith(s))) continue;
    if (statSync(join(relayDir, name)).mtimeMs > binMtime) return false;
  }
  return true;
}

/// Build the relay. Returns the binary path. Skips the build (and prints why)
/// when the existing binary is already newer than the sources, unless `force`.
export function buildRelay({ force = false } = {}) {
  findGo();
  if (!force && isRelayFresh()) {
    console.log("✓ relay up to date (skipping build)");
    return relayBin;
  }
  // Basename includes the platform suffix so the -o flag matches the path the
  // staleness check and the Rust resolver look for (`zine-relay` / `zine-relay.exe`).
  const outName = `zine-relay${EXE}`;
  console.log(`→ building relay (cd relay && go build -o ${outName} .)`);
  execFileSync("go", ["build", "-o", outName, "."], {
    cwd: relayDir,
    stdio: "inherit",
  });
  console.log("✓ relay built:", relayBin);
  return relayBin;
}

// Run directly via `npm run build:relay` / `node scripts/build-relay.mjs`.
// Comparing argv[1] against this module's path is the cross-platform ESM way
// to detect direct invocation.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  buildRelay({ force: process.argv.includes("--force") });
}

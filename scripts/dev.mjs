// The one-command dev entry point: `npm run dev` from the repo root.
//
// Goal: fresh clone → running app, no `cd`-ing, no manual relay build, no
// guessing what the prerequisites are. This script orchestrates the pieces so
// the developer never has to know the monorepo layout:
//
//   1. Check prerequisites (Go, Node, Rust required; Tor optional; warn only)
//   2. Build the relay if missing/stale (reuses build-relay.mjs's logic)
//   3. Install client deps if node_modules is absent
//   4. Hand off to `tauri dev`, inheriting stdio so logs/clicks flow through
//
// What this deliberately does NOT do: install system packages for you. Homebrew
// / apt / rustup / Xcode CLT installs are too presumptuous to automate — if a
// prereq is missing, it fails loud with the exact command to run.

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildRelay } from "./build-relay.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const clientDir = join(repoRoot, "apps", "client");
// npm ships as npm.cmd (a batch file) on Windows; spawn can't launch .cmd
// without a shell. Real binaries (node/go/cargo/tor) resolve directly, so this
// only needs to apply to the npm invocations below.
const IS_WIN = process.platform === "win32";

// --- version-gated prerequisites ---------------------------------------

// Node ≥ 20.19 — matches Vite's toolchain floor and the client release guide.
const MIN_NODE = [20, 19];
// Go ≥ 1.25 — relay/go.mod declares go 1.25.5; older toolchains reject it.
const MIN_GO = [1, 25];

/// Run a command, return trimmed stdout or null on failure (command missing).
function capture(cmd, args) {
  try {
    return spawnSync(cmd, args, { encoding: "utf8" }).stdout?.trim() || null;
  } catch {
    return null;
  }
}

/// Does `actual` (parsed [major, minor]) satisfy `min`? Numeric compare per
/// component — handles "go1.25.5" → [1,25] correctly, unlike a string compare.
function gte(actual, min) {
  for (let i = 0; i < min.length; i++) {
    if ((actual[i] ?? 0) > min[i]) return true;
    if ((actual[i] ?? 0) < min[i]) return false;
  }
  return true; // equal
}

/// Extract [major, minor] from a version string like "v25.2.1" / "go1.25.5".
function parseVersion(raw) {
  const m = raw.match(/(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

/// A required tool is present AND meets the version floor (if given).
function checkRequired(name, cmd, versionArgs, min, installHint) {
  const versionOut = capture(cmd, versionArgs);
  if (!versionOut) {
    console.error(`\n✗ ${name} not found.`);
    console.error(`  Install: ${installHint}`);
    return false;
  }
  const parsed = parseVersion(versionOut);
  if (parsed && min && !gte(parsed, min)) {
    console.error(`\n✗ ${name} ${parsed.join(".")} is too old (need ≥ ${min.join(".")}).`);
    console.error(`  Upgrade: ${installHint}`);
    return false;
  }
  return true;
}

/// Run all prerequisite checks. Hard-fails on a missing required tool; only
/// warns on the optional ones (Tor, Xcode CLT) so a missing onion path never
/// blocks local authoring.
function checkPrereqs() {
  const ok = [
    checkRequired(
      "Node",
      "node",
      ["--version"],
      MIN_NODE,
      "https://nodejs.org/ (or: brew install node)"
    ),
    checkRequired(
      "Go",
      "go",
      ["version"],
      MIN_GO,
      "https://go.dev/dl/ (≥ 1.25)"
    ),
    // No version gate on cargo — Tauri's own docs cover the rustup floor, and
    // a missing rustup surfaces loudly during `tauri dev` regardless.
    checkRequired(
      "Rust (cargo)",
      "cargo",
      ["--version"],
      null,
      "https://rustup.rs/ + Tauri prereqs: https://v2.tauri.app/start/prerequisites/"
    ),
  ].every(Boolean);
  if (!ok) process.exit(1);

  // Optional: Tor (onion reachability). Missing is non-fatal — the relay
  // sidecar and local authoring work without it; only inbound peer
  // reachability is lost. See apps/client/README.md, "Release builds," §1b.
  if (!capture("tor", ["--version"])) {
    console.log(
      "ℹ tor not found on PATH — optional (onion reachability only).\n" +
        "  Install later for inbound peers: brew install tor (macOS) / apt install tor (Linux)"
    );
  }

  // Optional: macOS Xcode CLI tools — Tauri needs them to compile the Rust
  // shell. Soft check (xcode-select -p prints the path if installed, exits 1
  // otherwise). The subsequent `tauri dev` will fail loudly anyway, so this is
  // just a better hint.
  if (process.platform === "darwin" && !capture("xcode-select", ["-p"])) {
    console.log(
      "ℹ Xcode CLI tools not detected — Tauri needs them.\n" +
        "  Install: xcode-select --install"
    );
  }
}

// --- bootstrap steps ---------------------------------------------------

/// Install the client's npm deps if node_modules is missing. Idempotent — if
/// it's there, skip (don't `npm install` every launch).
function ensureClientDeps() {
  if (existsSync(join(clientDir, "node_modules"))) return;
  console.log("→ installing client deps (first run only)…");
  const r = spawnSync("npm", ["install"], {
    cwd: clientDir,
    stdio: "inherit",
    shell: IS_WIN,
  });
  if (r.status !== 0) {
    console.error("\n✗ client npm install failed.");
    process.exit(1);
  }
  console.log("✓ client deps installed");
}

// --- launch ------------------------------------------------------------

/// Hand off to `tauri dev`/`tauri build`. Passes through any extra argv after
/// `--` so `npm run dev -- --release` etc. still works. Inherits stdio so the
/// app's logs and the relay sidecar's output stream live.
function launch(mode) {
  const extra = process.argv.slice(2).filter((a) => a !== "--" && a !== mode);
  const args = ["run", "tauri", mode, ...extra];
  console.log(`\n→ tauri ${mode} (cwd apps/client)\n`);
  const child = spawn("npm", args, { cwd: clientDir, stdio: "inherit", shell: IS_WIN });
  child.on("exit", (code) => process.exit(code ?? 0));
}

// --- main --------------------------------------------------------------

// First positional arg is the mode ("dev" | "build"). Set by the root
// package.json scripts; defaults to "dev" when invoked directly.
const [mode = "dev"] = process.argv.slice(2).filter((a) => !a.startsWith("-"));
if (mode !== "dev" && mode !== "build") {
  console.error(`unknown mode "${mode}" (expected "dev" or "build")`);
  process.exit(1);
}

checkPrereqs();
buildRelay();
ensureClientDeps();
launch(mode);

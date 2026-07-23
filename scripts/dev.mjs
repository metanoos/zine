// Source-install and development entry point from the repo root.
//
// `npm start` is the user-facing source installation: it safely updates a clean
// tracking branch before launch. `npm run dev` is the developer entry point: it
// runs the exact checkout without fetching or changing source. Both orchestrate
// the monorepo so nobody has to build the relay or install client dependencies
// by hand:
//
//   1. For `npm start` only, fast-forward a clean tracking branch
//   2. Check prerequisites (Go, Node, Rust required; Tor optional; warn only)
//   3. Build the relay if missing/stale (reuses build-relay.mjs's logic)
//   4. Synchronize client deps when package manifests change
//   5. Hand off to `tauri dev`, inheriting stdio so logs/clicks flow through
//
// What this deliberately does NOT do: install system packages for you. Homebrew
// / apt / rustup / Xcode CLT installs are too presumptuous to automate — if a
// prereq is missing, it fails loud with the exact command to run.

import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildRelay } from "./build-relay.mjs";
import { dependenciesCurrent, markDependenciesCurrent } from "./dependency-state.mjs";
import { updateSourceCheckout } from "./source-update.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const clientDir = join(repoRoot, "apps", "client");
// npm ships as npm.cmd (a batch file) on Windows; spawn can't launch .cmd
// without a shell. Real binaries (node/go/cargo/tor) resolve directly, so this
// only needs to apply to the npm invocations below.
const IS_WIN = process.platform === "win32";

// --- version-gated prerequisites ---------------------------------------

// Pin one supported LTS line rather than admitting EOL odd-numbered majors.
const MIN_NODE = [24, 0];
const MAX_NODE = [25, 0];
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
function checkRequired(name, cmd, versionArgs, min, installHint, maxExclusive = null) {
  const versionOut = capture(cmd, versionArgs);
  if (!versionOut) {
    console.error(`\n✗ ${name} not found.`);
    console.error(`  Install: ${installHint}`);
    return false;
  }
  const parsed = parseVersion(versionOut);
  if (parsed && min && (!gte(parsed, min) || (maxExclusive && gte(parsed, maxExclusive)))) {
    const required = maxExclusive
      ? `${min[0]}.x LTS`
      : `≥ ${min.join(".")}`;
    console.error(`\n✗ ${name} ${parsed.join(".")} is unsupported (need ${required}).`);
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
      "https://nodejs.org/ (install Node 24 LTS)",
      MAX_NODE,
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

/// Deterministically install client dependencies when either npm manifest has
/// changed. The hash stamp prevents a stale node_modules after a branch switch
/// while keeping ordinary launches fast.
function ensureClientDeps() {
  if (dependenciesCurrent(clientDir)) return;
  console.log("→ syncing client deps from package-lock.json…");
  const r = spawnSync("npm", ["ci"], {
    cwd: clientDir,
    stdio: "inherit",
    shell: IS_WIN,
  });
  if (r.status !== 0) {
    console.error("\n✗ client npm ci failed.");
    process.exit(1);
  }
  markDependenciesCurrent(clientDir);
  console.log("✓ client deps current");
}

// --- launch ------------------------------------------------------------

/// Hand off to `tauri dev`/`tauri build`. Passes through any extra argv after
/// `--` so `npm start -- --release` / `npm run dev -- --release` still work.
/// `start` uses Tauri's source runner after updating; it is not a separate
/// Tauri mode. Inherits stdio so the app and relay sidecar logs remain live.
function launch(mode) {
  const tauriMode = mode === "start" ? "dev" : mode;
  const extra = process.argv
    .slice(2)
    .filter((a) => a !== "--" && a !== mode && a !== "--no-update");
  const args = ["run", "tauri", tauriMode, ...extra];
  console.log(`\n→ tauri ${tauriMode} (cwd apps/client)\n`);
  const child = spawn("npm", args, { cwd: clientDir, stdio: "inherit", shell: IS_WIN });
  child.on("exit", (code) => process.exit(code ?? 0));
}

// --- main --------------------------------------------------------------

// First positional arg is the mode ("start" | "dev" | "build"). Set by the root
// package.json scripts; defaults to "dev" when invoked directly.
const [mode = "dev"] = process.argv.slice(2).filter((a) => !a.startsWith("-"));
if (mode !== "start" && mode !== "dev" && mode !== "build") {
  console.error(`unknown mode "${mode}" (expected "start", "dev", or "build")`);
  process.exit(1);
}

const sourceUpdate = mode === "start"
  ? updateSourceCheckout({ disabled: process.argv.includes("--no-update") })
  : { status: "current" };
if (sourceUpdate.status === "updated" && process.env.ZINE_SOURCE_UPDATE_RESTARTED !== "1") {
  // Reload the launcher after a fast-forward so changes to this script and its
  // imported bootstrap helpers take effect immediately, not one launch later.
  console.log("→ restarting with the updated source…");
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
    stdio: "inherit",
    env: { ...process.env, ZINE_SOURCE_UPDATE_RESTARTED: "1" },
  });
  child.on("exit", (code) => process.exit(code ?? 0));
} else {
  checkPrereqs();
  buildRelay();
  ensureClientDeps();
  launch(mode);
}

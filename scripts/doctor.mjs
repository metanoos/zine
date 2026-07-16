// Read-only development environment diagnostics. Required tool failures make
// the command non-zero; optional capabilities and generated artifacts warn.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isRelayFresh } from "./build-relay.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const problems = [];
const warnings = [];

function capture(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.error || result.status !== 0) return null;
  return (result.stdout || result.stderr).trim();
}

function versionTuple(raw) {
  const match = raw?.match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  return match ? match.slice(1).map((part) => Number(part ?? 0)) : null;
}

function atLeast(actual, required) {
  for (let i = 0; i < required.length; i++) {
    if ((actual[i] ?? 0) > required[i]) return true;
    if ((actual[i] ?? 0) < required[i]) return false;
  }
  return true;
}

function requiredVersion(label, command, args, minimum) {
  const raw = capture(command, args);
  if (!raw) {
    problems.push(`${label} is missing`);
    return;
  }
  const actual = versionTuple(raw);
  if (!actual || !atLeast(actual, minimum)) {
    problems.push(`${label} ${actual?.join(".") ?? raw} is below ${minimum.join(".")}`);
    return;
  }
  console.log(`✓ ${label}: ${raw.split("\n")[0]}`);
}

requiredVersion("Node", process.execPath, ["--version"], [20, 19]);
requiredVersion("npm", process.platform === "win32" ? "npm.cmd" : "npm", ["--version"], [0, 0]);
requiredVersion("Go", "go", ["version"], [1, 25]);

const cargo = capture("cargo", ["--version"]);
if (cargo) console.log(`✓ Rust: ${cargo}`);
else problems.push("Rust (cargo) is missing");

for (const [label, relativePath] of [
  ["client dependencies", "apps/client/node_modules"],
  ["MCP dependencies", "apps/mcp/node_modules"],
]) {
  if (existsSync(join(repoRoot, relativePath))) console.log(`✓ ${label}: installed`);
  else warnings.push(`${label} are not installed (run npm ci in that package)`);
}

if (isRelayFresh()) console.log("✓ relay binary: built and current");
else warnings.push("relay binary is missing or stale (run npm run build:relay)");

const tor = capture("tor", ["--version"]);
if (tor) console.log(`✓ Tor: ${tor.split("\n")[0]}`);
else warnings.push("Tor is not installed; local authoring works, onion reachability does not");

const bundleRelay = join(repoRoot, "apps", "client", "src-tauri", "binaries", `zine-relay${process.platform === "win32" ? ".exe" : ""}`);
if (!existsSync(bundleRelay)) warnings.push("release relay resource is absent; development uses relay/zine-relay instead");

for (const warning of warnings) console.log(`! ${warning}`);
for (const problem of problems) console.error(`✗ ${problem}`);

if (problems.length > 0) {
  console.error(`\ndoctor found ${problems.length} required environment problem${problems.length === 1 ? "" : "s"}`);
  process.exit(1);
}
console.log(`\n✓ doctor complete${warnings.length ? ` (${warnings.length} warning${warnings.length === 1 ? "" : "s"})` : ""}`);

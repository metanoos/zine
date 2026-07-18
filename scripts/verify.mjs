// Canonical repository verification entry point.
//
// `npm run check` runs the shared protocol kernel, dev automation tests, the
// client typecheck, and the area test suites in parallel. `npm run verify`
// adds the client production build and the isolated real-relay smoke test.
// Keeping orchestration here makes the documented command cross-platform and
// gives humans, Codex, and CI one definition of "green".

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const mode = process.argv[2] ?? "verify";

if (mode !== "check" && mode !== "verify") {
  console.error(`unknown verification mode "${mode}" (expected check or verify)`);
  process.exit(2);
}

const checks = [
  { label: "protocol package tests/coverage", command: npm, args: ["run", "test:coverage"], cwd: join(repoRoot, "packages", "protocol") },
  { label: "trace-context package tests/coverage", command: npm, args: ["run", "test:coverage"], cwd: join(repoRoot, "packages", "trace-context") },
  {
    label: "dev automation tests",
    command: process.execPath,
    args: [
      "--test",
      join(repoRoot, "scripts", "dependency-state.test.mjs"),
      join(repoRoot, "scripts", "check-go-coverage.test.mjs"),
      join(repoRoot, "scripts", "test-rust.test.mjs"),
    ],
    cwd: repoRoot,
  },
  { label: "dogfood tooling tests", command: process.execPath, args: ["--test", join(repoRoot, "scripts", "dogfood-macos.test.mjs")], cwd: repoRoot },
  { label: "client typecheck", command: npm, args: ["run", "typecheck"], cwd: join(repoRoot, "apps", "client") },
  { label: "client tests/coverage", command: npm, args: ["run", "test:coverage"], cwd: join(repoRoot, "apps", "client") },
  { label: "MCP tests/coverage/build/smoke", command: npm, args: ["run", "test:coverage"], cwd: join(repoRoot, "apps", "mcp") },
  { label: "relay tests/coverage", command: process.execPath, args: [join(repoRoot, "scripts", "check-go-coverage.mjs")], cwd: repoRoot },
  { label: "Rust shell tests", command: process.execPath, args: [join(repoRoot, "scripts", "test-rust.mjs")], cwd: repoRoot },
];

const fullVerification = [
  { label: "client production build", command: npm, args: ["run", "build"], cwd: join(repoRoot, "apps", "client") },
  { label: "real-relay protocol smoke", command: process.execPath, args: [join(repoRoot, "scripts", "verify-relay.mjs")], cwd: repoRoot },
];

const children = new Set();
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    for (const child of children) child.kill(signal);
  });
}

function run(step) {
  console.log(`\n→ ${step.label}`);
  return new Promise((resolve) => {
    const child = spawn(step.command, step.args, {
      cwd: step.cwd,
      env: process.env,
      stdio: "inherit",
      shell: process.platform === "win32" && step.command === npm,
    });
    children.add(child);
    let finished = false;
    child.on("error", (error) => {
      if (finished) return;
      finished = true;
      children.delete(child);
      console.error(`✗ ${step.label}: ${error.message}`);
      resolve({ label: step.label, code: 1 });
    });
    child.on("exit", (code, signal) => {
      if (finished) return;
      finished = true;
      children.delete(child);
      const status = code ?? (signal ? 1 : 0);
      console.log(`${status === 0 ? "✓" : "✗"} ${step.label}`);
      resolve({ label: step.label, code: status });
    });
  });
}

async function runBatch(label, steps) {
  console.log(`\n=== ${label} (${steps.length} parallel jobs) ===`);
  const results = await Promise.all(steps.map(run));
  const failed = results.filter((result) => result.code !== 0);
  if (failed.length > 0) {
    console.error(`\n${label} failed: ${failed.map((result) => result.label).join(", ")}`);
    process.exitCode = 1;
    return false;
  }
  return true;
}

if (await runBatch("checks", checks)) {
  if (mode === "verify") await runBatch("full verification", fullVerification);
}

if (!process.exitCode) {
  console.log(`\n✓ ${mode === "check" ? "checks" : "verification"} complete`);
}

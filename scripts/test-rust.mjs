// Run the Rust shell tests with the generated relay resource that Tauri's
// build script validates. The resource is intentionally absent from git, so a
// clean checkout must build it before Cargo compiles the client crate.

import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const defaultRepoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

export function rustTestPlan(repoRoot = defaultRepoRoot) {
  const relayDir = join(repoRoot, "relay");
  const tauriDir = join(repoRoot, "apps", "client", "src-tauri");
  const relayResource = join(tauriDir, "binaries", "zine-relay");
  return [
    {
      label: "build Tauri relay resource",
      command: "go",
      args: ["build", "-trimpath", "-buildvcs=true", "-o", relayResource, "."],
      cwd: relayDir,
      output: relayResource,
    },
    {
      label: "Rust shell tests",
      command: "cargo",
      args: ["test", "--locked"],
      cwd: tauriDir,
    },
  ];
}

export function runRustTests(repoRoot = defaultRepoRoot) {
  const plan = rustTestPlan(repoRoot);
  mkdirSync(dirname(plan[0].output), { recursive: true });
  for (const step of plan) {
    console.log(`\n→ ${step.label}`);
    const result = spawnSync(step.command, step.args, {
      cwd: step.cwd,
      env: process.env,
      stdio: "inherit",
    });
    if (result.error || result.status !== 0) {
      const detail = result.error?.message ?? `exit ${result.status}`;
      throw new Error(`${step.label} failed (${detail})`);
    }
    console.log(`✓ ${step.label}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    runRustTests();
  } catch (error) {
    console.error(`\n✗ Rust verification failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

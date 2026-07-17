import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { rustTestPlan } from "./test-rust.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

test("Rust verification builds the ignored Tauri relay resource before Cargo", () => {
  const plan = rustTestPlan("/repo");

  assert.equal(plan.length, 2);
  assert.deepEqual(plan[0], {
    label: "build Tauri relay resource",
    command: "go",
    args: [
      "build",
      "-trimpath",
      "-buildvcs=true",
      "-o",
      join("/repo", "apps", "client", "src-tauri", "binaries", "zine-relay"),
      ".",
    ],
    cwd: join("/repo", "relay"),
    output: join("/repo", "apps", "client", "src-tauri", "binaries", "zine-relay"),
  });
  assert.deepEqual(plan[1], {
    label: "Rust shell tests",
    command: "cargo",
    args: ["test", "--locked"],
    cwd: join("/repo", "apps", "client", "src-tauri"),
  });
});

test("GitHub Rust CI uses the same clean-checkout preflight", () => {
  const workflow = readFileSync(join(repoRoot, ".github", "workflows", "verify.yml"), "utf8");
  const rustJob = workflow.match(/\n  rust:\n([\s\S]*?)(?=\n  [a-z][a-z-]*:\n|$)/)?.[0] ?? "";

  assert.notEqual(rustJob, "");
  assert.match(rustJob, /actions\/setup-node@v4/);
  assert.match(rustJob, /actions\/setup-go@v5/);
  assert.match(rustJob, /node scripts\/test-rust\.mjs/);
  assert.doesNotMatch(rustJob, /working-directory: apps\/client\/src-tauri/);
});

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  dependenciesCurrent,
  dependencyFingerprint,
  markDependenciesCurrent,
} from "./dependency-state.mjs";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "zine-dependencies-"));
  writeFileSync(join(dir, "package.json"), '{"name":"fixture"}\n');
  writeFileSync(join(dir, "package-lock.json"), '{"lockfileVersion":3}\n');
  return dir;
}

test("dependency state requires node_modules and a matching install stamp", () => {
  const dir = fixture();
  try {
    assert.equal(dependenciesCurrent(dir), false);
    mkdirSync(join(dir, "node_modules"));
    assert.equal(dependenciesCurrent(dir), false);

    markDependenciesCurrent(dir);
    assert.equal(dependenciesCurrent(dir), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dependency state becomes stale when either npm input changes", () => {
  const dir = fixture();
  try {
    mkdirSync(join(dir, "node_modules"));
    markDependenciesCurrent(dir);
    const original = dependencyFingerprint(dir);

    writeFileSync(join(dir, "package.json"), '{"name":"changed"}\n');
    assert.notEqual(dependencyFingerprint(dir), original);
    assert.equal(dependenciesCurrent(dir), false);

    markDependenciesCurrent(dir);
    writeFileSync(join(dir, "package-lock.json"), '{"lockfileVersion":3,"changed":true}\n');
    assert.equal(dependenciesCurrent(dir), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const BABEL_COMPACT_THRESHOLD = 500_000;

for (const filename of ["App.tsx", "AppShell.tsx"]) {
  test(`${filename} stays below Babel's 500 KB compact-output threshold`, () => {
    const source = readFileSync(new URL(`./${filename}`, import.meta.url), "utf8");
    assert.ok(
      source.length < BABEL_COMPACT_THRESHOLD,
      `${filename} is ${source.length.toLocaleString()} characters; extract another cohesive module before Babel deoptimizes it`,
    );
  });
}

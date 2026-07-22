import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const appSource = [
  readFileSync(new URL("../app/AppShell.tsx", import.meta.url), "utf8"),
  readFileSync(new URL("../app/App.tsx", import.meta.url), "utf8"),
].join("\n");

test("Reify resolves signed snapshots instead of flattening live editor runs", () => {
  const start = appSource.indexOf("async function onReifyOp");
  const end = appSource.indexOf("function openInActivePanel", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const handler = appSource.slice(start, end);

  assert.match(handler, /prepareReifyExport/);
  assert.match(handler, /nucleusId: target\.nodeId/);
  assert.match(appSource, /scopedReifyTargets[\s\S]*?replayDisplay\.files/);
  assert.doesNotMatch(handler, /flatten\(/);
});

test("trace is an explicit unchecked sidecar option", () => {
  assert.match(appSource, /setReifyPrompt\(\{ includeTrace: false \}\)/);
  assert.match(appSource, />\s*Include trace\s*</);
  assert.match(appSource, /\.zine\/trace\.json \+ report\.md/);
  assert.match(appSource, /private Steps, prompts, context, timing, and intermediate text/);
});

test("pending working state must be stepped explicitly before Reify", () => {
  assert.match(appSource, /Step current &amp; Reify|Step current & Reify/);
  assert.match(appSource, /Reify latest Steps/);
  assert.match(appSource, /unsteppedPathSet\.has\(target\.path\)/);
});

test("tree context menus Reify an explicit file or recursive folder without mounting it", () => {
  assert.match(
    appSource,
    /onReify=\{\(target\) => setReifyPrompt\(\{ includeTrace: false, target \}\)\}/,
  );
  assert.match(appSource, /function scopedReifyTargets\(explicitTarget\?: ScopeRef\)/);
  assert.match(appSource, /explicitTarget\.kind === "file"\) return path === explicitTarget\.path/);
  assert.match(appSource, /return path\.startsWith\(`\$\{explicitTarget\.path\}\/`\)/);
  assert.match(appSource, /uniquePath\(target\.relativePath, usedRelativePaths\)/);
  assert.match(appSource, /const targets = scopedReifyTargets\(options\.target\)/);
  assert.match(appSource, /target: reifyPrompt\.target/);
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const app = readFileSync(new URL("../app/App.tsx", import.meta.url), "utf8");
const inspector = readFileSync(new URL("./PromptInspectorModal.tsx", import.meta.url), "utf8");

function functionBody(name: string, next: string): string {
  const start = app.indexOf(`function ${name}`);
  const end = app.indexOf(next, start);
  assert.ok(start >= 0 && end > start, `${name} source boundary`);
  return app.slice(start, end);
}

const operations = [
  ["extendLLM", "function settleDeDupeLLM"],
  ["settleLLM", "function stirLLM"],
  ["stirLLM", "function replyLLM"],
  ["replyLLM", "function analyzeLLM"],
  ["analyzeLLM", "function awaitViewMount"],
] as const;

test("all five MODEL actions use approved preparation, stale validation, and no direct write", () => {
  for (const [name, next] of operations) {
    const source = functionBody(name, next);
    assert.match(source, /approvedModelOperation\(/, name);
    assert.match(source, /executePreparedOperation\(/, name);
    assert.match(source, /readCurrentTarget: \(\) => readCurrentModelTarget\(prepared\)/, name);
    assert.match(source, /onStale: \(recovery\) => setStaleModelResult\(recovery\)/, name);
    assert.doesNotMatch(source, /\bcomplete\(|backendRef\.current\.writeFile|stepFile\(/, name);
  }
});

test("Inspector renders frozen PreparedOperation messages and owns explicit approval", () => {
  assert.match(inspector, /preparedOperation\?\.messages \?\? \[\]/);
  assert.match(inspector, /onApprove\(preparedOperation\)/);
  assert.doesNotMatch(inspector, /assembleOpMessages|prepareChatMessages|complete\(/);
});

test("stale session results expose inspect, copy, and retry recovery without mutation", () => {
  assert.match(app, /AI response held/);
  assert.match(app, /Copy response/);
  assert.match(app, /Inspect to retry/);
  assert.match(app, /setStaleModelResult\(null\)/);
});

test("Analyze produces an ordinary review with citations to every analyzed source head", () => {
  const source = functionBody("analyzeLLM", "function awaitViewMount");
  assert.match(source, /prepared\.contextSnapshot\.inputs/);
  assert.match(source, /editCitations\(newPath, sourceHeadIds\)/);
  assert.match(source, /openInPanel\(newPath, destIdx\)/);
});

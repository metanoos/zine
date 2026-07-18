import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const inspector = readFileSync(new URL("../ai/PromptInspectorModal.tsx", import.meta.url), "utf8");

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

test("all five MODEL actions delegate approved preparation and stale-safe execution", () => {
  for (const [name, next] of operations) {
    const source = functionBody(name, next);
    assert.match(source, /modelOperationControllerRef\.current!\.executeApproved\(/, name);
    assert.match(source, /onStale: \(recovery\) => setStaleModelResult\(recovery\)/, name);
    assert.doesNotMatch(source, /approvedModelOperation|executePreparedOperation|readCurrentModelTarget/, name);
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
  assert.match(source, /approved\.contextSnapshot\.inputs/);
  assert.match(source, /editCitations\(newPath, sourceHeadIds\)/);
  assert.match(source, /openInPanel\(newPath, destIdx\)/);
});

test("Extend and Settle alone use the current-session trace-authoring adapter", () => {
  const extend = functionBody("extendLLM", "function settleDeDupeLLM");
  const settle = functionBody("settleLLM", "function stirLLM");
  const stir = functionBody("stirLLM", "function replyLLM");
  assert.match(app, /const authoringAuthorityField = StateField\.define/);
  assert.match(app, /resetEditorAuthorityState\(authority, tr\.newDoc\.length\)/);
  assert.match(app, /paste: tr\.isUserEvent\("input\.paste"\)/);
  assert.match(app, /undoRedo: tr\.isUserEvent\("undo"\) \|\| tr\.isUserEvent\("redo"\)/);
  assert.match(app, /actingAuthorId: authorPubkeyRef\.current/);
  assert.match(extend, /sourceFrom/);
  assert.match(extend, /buildAcceptedExtendChanges/);
  assert.match(settle, /sourceFrom/);
  assert.match(settle, /validateTraceAuthoringResult/);
  assert.doesNotMatch(stir, /traceAuthoring|buildAcceptedExtendChanges|validateTraceAuthoringResult/);
});

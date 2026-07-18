import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const contextGather = readFileSync(new URL("../ai/context-gather.ts", import.meta.url), "utf8");
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

test("Inspector dispatches the frozen PreparedOperation through App's explicit approval boundary", () => {
  assert.match(inspector, /preparedOperation\?\.messages \?\? \[\]/);
  assert.match(inspector, /onDispatch\(preparedOperation\)/);
  assert.match(app, /onDispatch=\{\(prepared\) => \{[\s\S]*?\.approve\(prepared\);[\s\S]*?runOp\(opTargetPanel\(\), prepared\.operation, prepared\)/);
  assert.doesNotMatch(inspector, /assembleOpMessages|prepareChatMessages|complete\(/);
});

test("Inspector projects the selected prepared operation without replacing its exact messages", () => {
  assert.match(inspector, /adaptPreparedOperationForTraceContextInspector\(preparedOperation\)/);
  assert.match(inspector, /<TraceContextInspectorView/);
  assert.match(inspector, /presentation=\{traceContextPresentation\}/);
  assert.match(inspector, /className="prompt-inspector-trace-context"[\s\S]*tabIndex=\{0\}/);
  assert.match(inspector, /Exact prepared message stack/);
  assert.ok(
    inspector.indexOf("<TraceContextInspectorView") < inspector.indexOf('className="prompt-inspector-body"'),
    "trace context should precede, not replace, the exact message stack",
  );
  const invocation = inspector.slice(
    inspector.indexOf("<TraceContextInspectorView"),
    inspector.indexOf("/>", inspector.indexOf("<TraceContextInspectorView")) + 2,
  );
  assert.doesNotMatch(invocation, /onExclude|onPromote|onReactivate|onInspectSource/);
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

test("Inspector prepares local operations without waiting on ancillary relay reads", () => {
  const source = functionBody("openInspector", "/** Begin an in-place op");
  const hydrate = functionBody("hydrateInspectorInputs", "async function prepareInspectorSelection");
  assert.match(source, /setInspectOp\(defaultOperation\)[\s\S]*prepareInspectorSelection\(/);
  assert.doesNotMatch(source, /renderSteppedTraceReferences\(|focusTimeline\(|Promise\.allSettled/);
  assert.match(hydrate, /operation === "reply"[\s\S]*renderSteppedTraceReferences\(/);
  assert.match(hydrate, /operation === "analyze"[\s\S]*focusTimeline\(/);
  assert.match(source, /inspectOpenSequenceRef\.current/);
});

test("Inspector invalidates pending preparation when its prompt context changes", () => {
  assert.match(app, /if \(!inspectIsOpenRef\.current\) return;/);
  assert.match(app, /inspectOpenSequenceRef\.current\+\+;/);
  assert.match(app, /inspectInputsReadyRef\.current = \{[\s\S]*extend: false/);
  assert.match(app, /The file or prompt context changed/);
});

test("Reply freezes the selected source range into Inspector and execution inputs", () => {
  const derive = functionBody("deriveInspectInputs", "async function prepareInspectorOperation");
  const reply = functionBody("replyLLM", "function analyzeLLM");
  assert.match(derive, /reply: \{ source: stirText, sourceFrom: .*sourceTo:/s);
  assert.match(reply, /approvedRequest\?\.operation === "reply"[\s\S]*approvedRequest\.operationInputs/);
  assert.match(reply, /inputs = \{ source: sourceText, traces, sourceFrom, sourceTo \}/);
});

test("Reply exposes exact stepped traces independently of the Coins discovery opt-in", () => {
  const inventory = functionBody("renderSteppedTraceReferences", "async function hydrateInspectorInputs");
  const reply = functionBody("replyLLM", "function analyzeLLM");

  assert.match(inventory, /traceCandidates/);
  assert.match(inventory, /lastSteppedRef\.current\.get/);
  assert.match(inventory, /stepped\.slice\(0, 512\)/);
  assert.doesNotMatch(inventory, /kademliaEnabledSnapshot|coinsEnabled/);
  assert.match(reply, /const traces = renderSteppedTraceReferences\(srcRel\)/);
  assert.doesNotMatch(reply, /Coins were disabled|!kademliaEnabledSnapshot/);
  assert.doesNotMatch(app, /opLenses, coinsEnabled\]\);/);
  assert.doesNotMatch(app, /authorPubkey, modelPubkey, coinsEnabled\]\);/);
});

test("operation-specific citation inventory remains outside the prompt context tree", () => {
  assert.match(app, /function renderSteppedTraceReferences/);
  assert.match(contextGather, /request a local stepped-trace inventory/);
});

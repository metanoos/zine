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

const legacyOperations = [
  ["settleLLM", "function stirLLM"],
  ["stirLLM", "function replyLLM"],
  ["replyLLM", "function analyzeLLM"],
  ["analyzeLLM", "function awaitViewMount"],
] as const;

test("non-Extend MODEL actions retain approved preparation and stale-safe execution", () => {
  for (const [name, next] of legacyOperations) {
    const source = functionBody(name, next);
    assert.match(source, /modelOperationControllerRef\.current!\.executeApproved\(/, name);
    assert.match(source, /onStale: \(recovery\) => setStaleModelResult\(recovery\)/, name);
    assert.doesNotMatch(source, /approvedModelOperation|executePreparedOperation|readCurrentModelTarget/, name);
    assert.doesNotMatch(source, /\bcomplete\(|backendRef\.current\.writeFile|stepFile\(/, name);
  }
});

test("Extend persists and dispatches the exact Inspector-approved desktop request without auto-apply", () => {
  const extend = functionBody("extendLLM", "function settleDeDupeLLM");
  assert.match(extend, /approvedRequest\.traceContextSelection/);
  assert.match(extend, /runtime\.persistApprovedExtend\(\{[\s\S]*prepared: approvedRequest/);
  assert.match(extend, /runtime\.approve\(/);
  assert.match(extend, /runtime\.dispatch\(/);
  assert.doesNotMatch(extend, /executeApproved|view\.dispatch|buildAcceptedExtendChanges/);
  assert.doesNotMatch(extend, /stepFile\(|publish|mint/i);
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

test("Settle retains current-session authoring while durable Extend accepts through its local receipt", () => {
  const extend = functionBody("extendLLM", "function settleDeDupeLLM");
  const settle = functionBody("settleLLM", "function stirLLM");
  const stir = functionBody("stirLLM", "function replyLLM");
  assert.match(app, /const authoringAuthorityField = StateField\.define/);
  assert.match(app, /resetEditorAuthorityState\(authority, tr\.newDoc\.length\)/);
  assert.match(app, /paste: tr\.isUserEvent\("input\.paste"\)/);
  assert.match(app, /undoRedo: tr\.isUserEvent\("undo"\) \|\| tr\.isUserEvent\("redo"\)/);
  assert.match(app, /actingAuthorId: authorPubkeyRef\.current/);
  assert.match(extend, /persistApprovedExtend/);
  assert.match(settle, /sourceFrom/);
  assert.match(settle, /validateTraceAuthoringResult/);
  assert.doesNotMatch(stir, /traceAuthoring|buildAcceptedExtendChanges|validateTraceAuthoringResult/);
});

test("Inspector binds Extend to the fetched signed-chain selector boundary", () => {
  const prepare = functionBody("prepareInspectorOperation", "/** Render bounded, exact excerpts");
  assert.match(prepare, /operation === "extend"[\s\S]*fetchChain\(liveFolder\.id, activePath\)/);
  assert.match(prepare, /policy: "selected-trace-v1"/);
  assert.match(prepare, /verifyEvent/);
  assert.match(prepare, /\.prepare\(\{[\s\S]*traceContext/);
});

test("desktop Accept writes one exact crash-pad receipt before dispatching CodeMirror", () => {
  const apply = functionBody("applyDesktopArtifact", "function editFile");
  assert.match(apply, /prepareDesktopExtendApplyV1/);
  assert.match(apply, /transaction\.state\.field\(voiceField\)/);
  assert.match(apply, /transaction\.state\.field\(keditField\)/);
  assert.ok(apply.indexOf("mirrorPad(") < apply.indexOf("view.dispatch(transaction)"));
  assert.match(apply, /desktopOperationReceipt/);
  assert.doesNotMatch(apply, /stepFile\(|sendStep\(|publish|mint/i);
});

test("desktop recovery constructs the native frozen-session store only after App mounts", () => {
  assert.match(app, /createNativeDesktopOperationStoreV1\(\)/);
  assert.match(app, /desktopOperationRuntimeRef\.current = runtime/);
  assert.match(app, /bootState !== "ready"[\s\S]*desktopOperationRuntimeRef\.current!\.recover\(\)/);
  assert.doesNotMatch(app, /DesktopOperationStoreV1\([^)]*localStorage/);
});

test("desktop review refresh traverses the complete opaque journal", () => {
  const refresh = functionBody("refreshDesktopOperationEnvelopes", "async function dispatchDesktopOperationAttempt");
  assert.match(refresh, /while \(true\)/);
  assert.match(refresh, /repository\.listPage\(cursor, 16\)/);
  assert.match(refresh, /nextCursor === cursor \|\| seenCursors\.has\(nextCursor\)/);
  assert.doesNotMatch(refresh, /pageIndex|< 4/);
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

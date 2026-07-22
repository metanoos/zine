import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const app = [
  readFileSync(new URL("./AppShell.tsx", import.meta.url), "utf8"),
  readFileSync(new URL("./App.tsx", import.meta.url), "utf8"),
].join("\n");
const contextGather = readFileSync(new URL("../ai/context-gather.ts", import.meta.url), "utf8");
const inspector = readFileSync(new URL("../ai/PromptInspectorModal.tsx", import.meta.url), "utf8");
const desktopRuntime = readFileSync(new URL("../ai/desktop-operation-runtime.ts", import.meta.url), "utf8");

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

test("Extend binds to the fetched signed-chain selector boundary (shared by Inspector and autofire)", () => {
  // gatherExtendTraceContext is the single place the focused file's genesis-to-
  // head chain is fetched and framed as a selected-trace-v1 boundary. Both the
  // Inspector's prepare path and the Extend autofire branch call it, so the two
  // paths see byte-identical context.
  const gather = functionBody("gatherExtendTraceContext", "function prepareInspectorOperation");
  assert.match(gather, /fetchChain\(liveFolder\.id, activePath\)/);
  assert.match(gather, /policy: "selected-trace-v1"/);
  assert.match(gather, /verifyEvent/);
  const prepare = functionBody("prepareInspectorOperation", "function renderSteppedTraceReferences");
  assert.match(prepare, /operation === "extend"[\s\S]*gatherExtendTraceContext\(idx\)/);
  assert.match(prepare, /\.prepare\(\{[\s\S]*traceContext/);
  // The autofire branch in extendLLM prepares through the same controller with
  // the same trace context before handing off to the durable runtime.
  const extend = functionBody("extendLLM", "function settleDeDupeLLM");
  assert.match(extend, /gatherExtendTraceContext\(idx\)/);
  assert.match(extend, /\.prepare\(\{[\s\S]*operation: "extend"[\s\S]*traceContext/);
});

test("desktop Accept writes one exact crash-pad receipt before dispatching CodeMirror", () => {
  const apply = functionBody("applyDesktopArtifact", "function editFile");
  assert.match(apply, /prepareDesktopExtendApplyV1/);
  assert.match(apply, /prepared\.traceAuthoring/);
  assert.match(apply, /planned\.changes/);
  assert.match(apply, /transaction\.state\.field\(voiceField\)/);
  assert.match(apply, /transaction\.state\.field\(keditField\)/);
  assert.ok(apply.indexOf("mirrorPad(") < apply.indexOf("view.dispatch(transaction)"));
  assert.ok(
    apply.indexOf("receipt?.intentId === input.intent.intentId")
      < apply.indexOf("isDesktopOperationAuthorizedThisSessionV1"),
    "restart receipt reconciliation must precede ephemeral directive authority",
  );
  assert.match(apply, /createDesktopOperationCrashPadReceiptV1/);
  assert.match(apply, /prepared\.modelVoicePubkey/);
  assert.doesNotMatch(apply, /modelPubkeyRef\.current/);
  assert.doesNotMatch(apply, /stepFile\(|sendStep\(|publish|mint/i);
});

test("directive authority gates provider dispatch and apply across App activations", () => {
  const apply = functionBody("applyDesktopArtifact", "function editFile");
  const dispatch = functionBody("dispatchDesktopOperationAttempt", "async function retryDesktopOperation");
  assert.match(app, /desktopAuthorizedAttemptKeysRef = useRef\(new Set<string>\(\)\)/);
  assert.match(app, /isAttemptAuthorizedForCurrentEditorSession: \(envelope\) =>[\s\S]*isDesktopOperationAuthorizedThisSessionV1/);
  assert.match(dispatch, /runtime\.approve\(key\)/);
  assert.match(dispatch, /runtime\.dispatch\(key, \{ signal: controller\.signal \}\)/);
  assert.match(apply, /isDesktopOperationAuthorizedThisSessionV1/);
  assert.match(apply, /return \{ status: "stale" \}/);
  assert.match(app, /desktopOperationReviewQueueV1\([\s\S]*isDesktopOperationAuthorizedThisSessionV1/);
});

test("desktop recovery defers inactive workspaces and keeps review scoped to the live folder", () => {
  const apply = functionBody("applyDesktopArtifact", "function editFile");
  assert.match(apply, /liveFolder\.id !== target\.folderId/);
  assert.match(apply, /status: "deferred"/);
  assert.match(app, /targetRevision\.folderId === folder\?\.id/);
});

test("recovery errors stay generic and saved operations navigate exact bounded cursor pages", () => {
  const refresh = functionBody(
    "refreshDesktopOperationEnvelopes",
    "function loadMoreDesktopOperationEnvelopes",
  );
  const next = functionBody(
    "loadMoreDesktopOperationEnvelopes",
    "async function loadPreviousDesktopOperationEnvelopes",
  );
  const previous = functionBody(
    "loadPreviousDesktopOperationEnvelopes",
    "async function dispatchDesktopOperationAttempt",
  );
  assert.match(app, /result\.failureCount > 0/);
  assert.match(app, /saved AI operation\(s\) need recovery attention/);
  assert.doesNotMatch(app, /failureSamples\[/);
  assert.match(app, /result\.failureCount > 0[\s\S]*setDesktopOperationEnvelopes\(\[\]\)[\s\S]*setDesktopOperationPageLineageHeads\(\[\]\)[\s\S]*setDesktopOperationPageCursor\(null\)[\s\S]*setDesktopOperationNextCursor\(null\)[\s\S]*setDesktopOperationPreviousCursors\(\[\]\)[\s\S]*return;/);
  assert.match(app, /Saved AI history recovered\. Review the current page and use Previous \/ More \/ Next when available\./);
  assert.match(refresh, /repository\.listPage\(cursor, 16\)/);
  assert.match(refresh, /resolveDesktopOperationPageLineageV1\(/);
  assert.match(refresh, /page\.records,[\s\S]*pageSize: 16, isCancelled: cancelled/);
  assert.match(refresh, /setDesktopOperationEnvelopes\(\[\.\.\.page\.records\]\)/);
  assert.match(refresh, /setDesktopOperationPageLineageHeads\(\[\.\.\.lineageHeads\]\)/);
  assert.match(refresh, /setDesktopOperationPageCursor\(cursor\)/);
  assert.match(refresh, /setDesktopOperationNextCursor\(page\.nextCursor\)/);
  assert.match(next, /desktopOperationNextCursor/);
  assert.match(next, /\[\.\.\.desktopOperationPreviousCursors, desktopOperationPageCursor\]/);
  assert.match(previous, /desktopOperationPreviousCursors\[desktopOperationPreviousCursors\.length - 1\]/);
  assert.match(previous, /desktopOperationPreviousCursors\.slice\(0, -1\)/);
  assert.doesNotMatch(refresh, /\.\.\.current|slice\(-64\)/);
  assert.match(refresh, /setDesktopOperationEnvelopes\(\[\]\)[\s\S]*setDesktopOperationPageLineageHeads\(\[\]\)/);
  assert.match(refresh, /desktopOperationStoreRef\.current !== repository/);
  assert.match(app, /createDesktopOperationPinnedLineageFenceV1\(\)/);
  assert.match(app, /provenParent = desktopOperationPageLineageHeads\.find/);
  assert.match(app, /mergeDesktopOperationPinnedDescendantV1\([\s\S]*current,[\s\S]*provenParent,[\s\S]*envelope,[\s\S]*16,[\s\S]*desktopOperationPinnedLineageFenceRef\.current/);
  assert.match(app, /mergeDesktopOperationPinnedHeadsV1\([\s\S]*current,[\s\S]*\[envelope\],[\s\S]*16,[\s\S]*desktopOperationPinnedLineageFenceRef\.current/);
  assert.match(app, />Previous<\/button>/);
  assert.match(app, /"More \/ Next"/);
});

test("recovery never publishes partial pins and cancellation or vault replacement fences archive state", () => {
  const recoverStart = desktopRuntime.indexOf("private async recoverEnvelope");
  const recoverEnd = desktopRuntime.indexOf("private async requireEnvelope", recoverStart);
  assert.ok(recoverStart >= 0 && recoverEnd > recoverStart);
  assert.doesNotMatch(desktopRuntime.slice(recoverStart, recoverEnd), /this\.present\(/);
  assert.match(app, /if \(cancelled\) return;/);
  assert.match(app, /desktopOperationRefreshSequenceRef\.current \+= 1;[\s\S]*setDesktopOperationEnvelopes\(\[\]\)[\s\S]*setDesktopOperationPageLineageHeads\(\[\]\)[\s\S]*desktopOperationRuntimeRef\.current!\.recover\(\)/);
  assert.match(app, /sequence !== desktopOperationRefreshSequenceRef\.current/);
  assert.match(app, /desktopOperationStoreRef\.current !== repository/);
  assert.match(app, /return \(\) => \{[\s\S]*desktopOperationRefreshSequenceRef\.current \+= 1;[\s\S]*desktopAuthorizedAttemptKeysRef\.current\.clear\(\);[\s\S]*controller\.abort\(\);[\s\S]*desktopOperationRuntimeRef\.current = null;[\s\S]*desktopOperationStoreRef\.current = null;/);
});

test("vault cleanup owns and aborts every desktop Extend barrier before releasing runtime refs", () => {
  const extend = functionBody("extendLLM", "function settleDeDupeLLM");
  const dispatch = functionBody(
    "dispatchDesktopOperationAttempt",
    "async function retryDesktopOperation",
  );
  const retry = functionBody("retryDesktopOperation", "async function handleDesktopOperationAction");
  const freshRetry = functionBody("dispatchFreshDesktopRetry", "const [opLenses");

  assert.match(app, /desktopOperationAbortControllersRef = useRef\(new Set<AbortController>\(\)\)/);
  assert.match(app, /desktopAuthorizedAttemptKeysRef\.current\.clear\(\);[\s\S]*for \(const controller of desktopOperationAbortControllersRef\.current\)[\s\S]*controller\.abort\(\);[\s\S]*desktopOperationRuntimeRef\.current = null;/);
  assert.ok(
    extend.indexOf("desktopOperationAbortControllersRef.current.add(controller)")
      < extend.indexOf("runtime.persistApprovedExtend"),
    "the controller must be owned before private request persistence begins",
  );
  assert.ok(
    extend.indexOf("if (!controller.signal.aborted)")
      < extend.indexOf("desktopAuthorizedAttemptKeysRef.current.add"),
    "an unmounted continuation cannot recreate ephemeral directive authority",
  );
  assert.match(extend, /controller\.signal\.aborted[\s\S]*runtime\.cancel\(/);
  assert.match(dispatch, /desktopOperationAbortControllersRef\.current\.add\(controller\)[\s\S]*runtime\.approve\(key\)[\s\S]*controller\.signal\.aborted[\s\S]*runtime\.cancel\(key\)[\s\S]*runtime\.dispatch\(key, \{ signal: controller\.signal \}\)/);
  assert.ok(
    retry.indexOf("desktopOperationAbortControllersRef.current.add(controller)")
      < retry.indexOf("runtime.retry"),
  );
  assert.ok(
    freshRetry.indexOf("desktopOperationAbortControllersRef.current.add(controller)")
      < freshRetry.indexOf("runtime.retry"),
  );
});

test("stale re-prepare opens only the original workspace path and trace", () => {
  const action = functionBody("handleDesktopOperationAction", "function dispatchFreshDesktopRetry");
  assert.match(action, /liveFolder\.id !== target\.folderId/);
  assert.match(action, /liveFile\.traceId !== target\.traceId/);
  assert.match(action, /activateLiveTab\(target\.path\)/);
  assert.match(action, /Restore the original workspace and trace/);
});

test("expired terminal directive re-prepare distinguishes safe fresh operations from confirmed ambiguous linkage", () => {
  const dispatch = functionBody("dispatchFreshDesktopRetry", "const [opLenses");
  assert.match(dispatch, /ambiguous = prior\.lifecycle\.retryPolicy === "operator-confirmation-required"/);
  assert.match(dispatch, /ambiguous[\s\S]*window\.confirm\(/);
  assert.ok(dispatch.indexOf("window.confirm(") < dispatch.indexOf("await runtime.retry(staleKey"));
  assert.ok(
    dispatch.indexOf("await runtime.retry(staleKey")
      < dispatch.indexOf("dispatchDesktopOperationAttempt(retry, controller)"),
  );
  assert.match(dispatch, /possibleDuplicateAcknowledged: true as const/);
  assert.match(dispatch, /prior\.lifecycle\.status === "stale" \|\| ambiguous[\s\S]*runtime\.retry\(staleKey/);
  assert.match(dispatch, /: await runtime\.persistApprovedExtend\(/);
  assert.match(dispatch, /desktopOperationAttemptKeyV1\(retry\.operationId, retry\.attempt\.attemptId\)/);
  assert.match(app, /case "reprepare-possible-duplicate": return "Re-prepare \(may duplicate\)"/);
});

test("desktop recovery constructs the native frozen-session store only after App mounts", () => {
  assert.match(app, /createNativeDesktopOperationStoreV1\(\)/);
  assert.match(app, /desktopOperationRuntimeRef\.current = runtime/);
  assert.match(app, /bootState !== "ready"[\s\S]*desktopOperationRuntimeRef\.current!\.recover\(\)/);
  assert.doesNotMatch(app, /DesktopOperationStoreV1\([^)]*localStorage/);
});

test("Inspector prepares local operations without waiting on ancillary relay reads", () => {
  const source = functionBody("openInspector", "/** Begin an in-place op");
  const hydrate = functionBody("hydrateInspectorInputs", "async function prepareInspectorSelection");
  assert.match(source, /setInspectOp\(defaultOperation\)[\s\S]*prepareInspectorSelection\(/);
  assert.doesNotMatch(source, /renderSteppedTraceReferences\(|focusTimeline\(|Promise\.allSettled/);
  assert.match(hydrate, /operation === "reply"[\s\S]*renderReplyCitableTraces\(/);
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

test("Reply cites stepped traces and the local Mint inventory independently of the Coins discovery opt-in", () => {
  const inventory = functionBody("renderSteppedTraceReferences", "async function hydrateInspectorInputs");
  const reply = functionBody("replyLLM", "function analyzeLLM");

  assert.match(inventory, /traceCandidates/);
  assert.match(inventory, /lastSteppedRef\.current\.get/);
  assert.match(inventory, /stepped\.slice\(0, 512\)/);
  assert.doesNotMatch(inventory, /kademliaEnabledSnapshot|coinsEnabled/);
  // Reply's citable set combines stepped traces with the local Mint coin
  // inventory via renderReplyCitableTraces; both are pure local FileState reads
  // and stay independent of the network Coins discovery opt-in.
  assert.match(reply, /const traces = renderReplyCitableTraces\(srcRel\)/);
  assert.match(app, /listMintCoins\(filesRef\.current\)/);
  assert.doesNotMatch(reply, /Coins were disabled|!kademliaEnabledSnapshot/);
  assert.doesNotMatch(app, /opLenses, coinsEnabled\]\);/);
  assert.doesNotMatch(app, /authorPubkey, modelPubkey, coinsEnabled\]\);/);
});

test("operation-specific citation inventory remains outside the prompt context tree", () => {
  assert.match(app, /function renderSteppedTraceReferences/);
  assert.match(contextGather, /request a local stepped-trace inventory/);
});

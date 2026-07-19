import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const appSource = readFileSync(new URL("../app/App.tsx", import.meta.url), "utf8");
const workspaceSource = readFileSync(new URL("./workspace-local.ts", import.meta.url), "utf8");

function sourceBetween(start: string, end: string): string {
  const from = appSource.indexOf(start);
  const to = appSource.indexOf(end, from);
  assert.notEqual(from, -1, `missing ${start}`);
  assert.notEqual(to, -1, `missing ${end}`);
  return appSource.slice(from, to);
}

test("historical and Mint forks resolve recursive destination folders", () => {
  const replayFork = sourceBetween(
    "async function forkFromSnapshot()",
    "/** Dismiss the fork modal",
  );
  const mintFork = sourceBetween(
    "async function forkMintedNodes(",
    "/** Adopt selected Scan entries",
  );

  assert.match(replayFork, /forkFileIntoLocalTree\(/);
  assert.match(replayFork, /storagePath: ROOT/);
  assert.match(mintFork, /forkFileIntoLocalTree\(/);
  assert.match(mintFork, /storagePath: ROOT/);
  assert.doesNotMatch(replayFork, /forkFileFromNode|relativePath: forkPath/);
  assert.doesNotMatch(mintFork, /forkFileFromNode|relativePath: forkPath/);
});

test("nested Scan adoption retains explicit folder replay identities", () => {
  const adoption = sourceBetween(
    "async function adoptScannedNodes(",
    "// Move `src` (file or folder path)",
  );

  assert.match(adoption, /forkFileIntoLocalTree\(/);
  assert.match(adoption, /withPersistedFolderStates\(prev, sourceRootId\)/);
  assert.doesNotMatch(adoption, /forkFileFromNode|relativePath: destPath/);
  assert.doesNotMatch(adoption, /upsertManifestEntry\(\s*sourceRootId/);
});

test("attach resumes a journaled folder Step through its final explicit checkpoint", () => {
  assert.match(
    workspaceSource,
    /resumePendingFolderSteps\(attachedRootId,[\s\S]*resumePendingStructuralOperations\(attachedRootId/,
  );
  const recovery = workspaceSource.match(
    /async function completePendingFolderStepWithinRoot[\s\S]*?\n  async function completePendingFolderStepsWithinRoot/,
  )?.[0] ?? "";
  assert.match(recovery, /loadPad\(rootId\)/);
  assert.match(recovery, /pendingOperationId: operationId/);
  assert.match(recovery, /await stepFolderWithinRoot\(rootId, relativePath, operationId\)/);
  assert.match(recovery, /clearFolderStepOperation\(rootId, relativePath\)/);
});

test("nested local-only folder Steps keep ancestor acceptance on local authority", () => {
  const propagation = workspaceSource.match(
    /export async function propagateLocalTreeFolderHead[\s\S]*?\n}\n\n\/\*\* Ensure that every segment/,
  )?.[0] ?? "";
  assert.match(
    propagation,
    /requireAcceptedCurrentFolderCheckpoint\(\s*parentId,\s*head,\s*getPublicKey\(parentSigner\),\s*\{ localOnly \},\s*\)/,
  );
});

test("terminal move, rename, and delete failures reconcile from durable paths", () => {
  const reconciliation = sourceBetween(
    "function reconcileFailedPathMutation(",
    "// Move `src` (file or folder path)",
  );
  assert.match(reconciliation, /folderIdRef\.current !== operationFolderId/);
  assert.match(reconciliation, /loadLocalFolder\(operationFolderId\)/);
  assert.match(reconciliation, /localToFiles\(persisted\)/);
  assert.match(reconciliation, /setStructuralError/);
  assert.match(reconciliation, /deleteRollback\.tabs/);
  assert.match(reconciliation, /setTabModes/);
  assert.match(reconciliation, /setCollapsed/);
  assert.match(reconciliation, /revertShieldedPathChange/);
  assert.match(reconciliation, /deleteRollback\.shielded/);
  assert.match(reconciliation, /chooseDirectorySelection/);
  assert.match(reconciliation, /commitUiFocus\(deleteRollback\.focus\)/);
  assert.equal(
    (appSource.match(/reconcileFailedPathMutation\(/g) ?? []).length,
    4,
  );
});

test("retryable structural failures keep the optimistic projection for recovery", () => {
  const retryGate = sourceBetween(
    "function retainRetryablePathMutation(",
    "// Move `src` (file or folder path)",
  );
  assert.match(retryGate, /hasPendingStructuralPathMutation/);
  assert.match(retryGate, /pending retry/);
  assert.equal(
    (appSource.match(/retainRetryablePathMutation\(/g) ?? []).length,
    4,
  );
});

test("structural gestures persist shield rebases and scope refreshes stay Root-bound", () => {
  const move = sourceBetween(
    "function moveNodes(",
    "/** Step one recursive zine",
  );
  const hardDelete = sourceBetween(
    "function hardDelete(",
    "/** Relay revocation",
  );
  const rename = sourceBetween(
    "function renameNode(",
    "useEffect(() => {",
  );
  assert.match(move, /rebaseShieldedAfterMove/);
  assert.match(hardDelete, /removeDeletedShieldedPaths/);
  assert.match(rename, /rebaseShieldedPath/);
  assert.match(move, /projectShieldedForRoot/);
  assert.match(hardDelete, /projectShieldedForRoot/);
  assert.match(rename, /projectShieldedForRoot/);
  assert.match(workspaceSource, /structuralShieldJournal\(/);
  assert.match(move, /refreshMountedReplay\(operationFolderId\)/);
  assert.match(hardDelete, /refreshMountedReplay\(operationFolderId\)/);
  assert.match(rename, /refreshMountedReplay\(operationFolderId\)/);
});

test("structural checkpoints stay local and recovery is identity-guarded", () => {
  const recovery = workspaceSource.match(
    /async function removeStagedFolder[\s\S]*?async function completeStagedFolderCreation/,
  )?.[0] ?? "";
  assert.match(recovery, /expectedNodeId: expected\.nodeId/);
  assert.match(recovery, /expectedCurrentNodeId: expected\.nodeId/);
  assert.match(recovery, /monotonicFolderId: expected\.traceId/);
  assert.match(recovery, /localOnly: true/);
  assert.match(recovery, /propagateFolderHead\([\s\S]*?true,/);
});

test("an async replay load cannot commit after the mounted Root changes", () => {
  const loadReplay = sourceBetween(
    "async function loadReplay(sequence: number)",
    "/** Re-read the selected timeline",
  );
  assert.match(loadReplay, /const replayRootId = folder\.id/);
  assert.match(loadReplay, /folderIdRef\.current !== replayRootId/);
  assert.ok(
    loadReplay.indexOf("folderIdRef.current !== replayRootId") <
      loadReplay.indexOf("setReplay({ steps: visibleSteps"),
  );
});

test("recursive pull shares one absence index and one bulk deletion", () => {
  const pull = workspaceSource.match(
    /async function pullFromRelayUnlocked[\s\S]*?\n}\n\n\/\*\* Pull participates/,
  )?.[0] ?? "";
  assert.match(pull, /const absenceIndex = buildRemoteAbsenceIndex/);
  assert.match(pull, /planRemoteAbsenceReconciliation\([\s\S]*absenceIndex/);
  assert.equal((pull.match(/buildRemoteAbsenceIndex\(/g) ?? []).length, 1);
  assert.equal((pull.match(/deleteLocalFilesDurably\(/g) ?? []).length, 1);
  assert.match(pull, /localManifestProjectionMatches\(existing, entry\)/);
  assert.match(pull, /saveLocalFolderHead\(folderId, observedRootHeadId\)/);
});

test("attach surfaces staged merges and conflicts instead of discarding them", () => {
  assert.match(workspaceSource, /onPullResult\?: \(result: PullResult\) => void/);
  assert.equal((workspaceSource.match(/options\.onPullResult\?\.\(pulled\)/g) ?? []).length, 2);
  assert.match(appSource, /onPullResult: \(result: PullResult\)/);
  assert.match(appSource, /folderIdRef\.current !== result\.rootId/);
  assert.match(appSource, /setStagedMerges/);
  assert.match(appSource, /setMergeError/);
});

test("merge acceptance publishes and adopts one exact node through the workspace lane", () => {
  const appMerge = sourceBetween(
    "async function acceptMergeToWorkspace(",
    "/** Unilateral incorporate",
  );
  assert.match(appMerge, /backendRef\.current\.acceptMerge\(/);
  assert.doesNotMatch(appMerge, /backendRef\.current\.writeFile\(/);
  assert.match(appMerge, /local work changed after it was staged/);

  const backendMerge = workspaceSource.slice(
    workspaceSource.indexOf("async acceptMerge(input)"),
    workspaceSource.indexOf("async flushFile", workspaceSource.indexOf("async acceptMerge(input)")),
  );
  assert.match(backendMerge, /runWorkspaceRootMutation/);
  assert.match(backendMerge, /runResourceSerialized\(fileStepRuns/);
  assert.match(backendMerge, /const coordinate = localFolderCoordinate/);
  assert.match(backendMerge, /folderId: coordinate\.folderId/);
  assert.match(backendMerge, /relativePath: coordinate\.relativePath/);
  assert.match(backendMerge, /prevEventId: input\.expectedNodeId/);
  assert.match(backendMerge, /localOnly: true/);
  assert.match(backendMerge, /fetchNodeOwner\(traceId\)/);
  assert.match(backendMerge, /folderWriteSigner\(folderOwner, signer\)/);
  assert.match(backendMerge, /propagateFolderHead\(/);
  assert.match(backendMerge, /onSigned: persistSignedMerge/);
  assert.match(backendMerge, /citations: findResolvedBrackets\(input\.snapshot\)/);
  assert.match(backendMerge, /inlineCitations: findAddedInlineCitations/);
  assert.match(backendMerge, /citationIds,/);
  assert.match(backendMerge, /latestNodeId: event\.id/);
  assert.doesNotMatch(backendMerge, /voice: input\.mergeParentPubkey/);
});

test("clean pull merges do not claim the mixed snapshot came from the remote head", () => {
  assert.match(workspaceSource, /remoteOwnerPubkey: head\.pubkey/);
  assert.doesNotMatch(workspaceSource, /safeOwnerPubkey/);
  const stagedMerge = appSource.slice(
    appSource.indexOf("async function stepStagedMerge"),
    appSource.indexOf("useEffect", appSource.indexOf("async function stepStagedMerge")),
  );
  assert.doesNotMatch(stagedMerge, /src: staged\.remoteHeadId/);
  const accept = sourceBetween(
    "async function acceptMergeToWorkspace(",
    "/** Unilateral incorporate",
  );
  assert.match(accept, /diffChars\(input\.expectedContent, input\.snapshot\)/);
  assert.match(accept, /appendOurs\(oursCursor/);
  assert.match(accept, /src: input\.parentId/);
  assert.doesNotMatch(accept, /parentSnapshot\.includes/);
  assert.match(accept, /autoMergedText\(merge\) === input\.snapshot/);
});

test("recursive folder Steps remain bound to their originating Root", () => {
  const folderStep = sourceBetween(
    "function stepFolderPath(",
    "// Apply the Delete gesture",
  );
  assert.ok(
    (folderStep.match(/folderIdRef\.current !== operationFolderId/g) ?? []).length >= 3,
  );
  assert.match(folderStep, /backendRef\.current\.ref\?\.id !== operationFolderId/);
  assert.match(folderStep, /clearFolderStepOperation\(operationFolderId, path\)/);
});

test("structural gestures finish pending folder Steps before reading mutable paths", () => {
  for (const start of ["async deletePath(", "async movePath(", "async renamePath("]) {
    const from = workspaceSource.indexOf(start);
    const to = workspaceSource.indexOf("const local = loadLocalFolder(id);", from);
    assert.notEqual(from, -1, `missing ${start}`);
    assert.notEqual(to, -1, `missing local read after ${start}`);
    assert.match(
      workspaceSource.slice(from, to),
      /await completePendingFolderStepsWithinRoot\(id\)/,
    );
  }
});

test("ordinary Root mutations recover older folder Steps before new work", () => {
  const barrier = workspaceSource.slice(
    workspaceSource.indexOf("function runWorkspaceRootMutation"),
    workspaceSource.indexOf("return {", workspaceSource.indexOf("function runWorkspaceRootMutation")),
  );
  assert.match(barrier, /completePendingFolderStepsWithinRoot\(rootId, undefined, operationId\)/);
  assert.match(barrier, /resumePendingStructuralOperationsWithinRoot\(rootId\)/);
});

test("a new write recovers an earlier signed file Step before replacing its journal", () => {
  const write = workspaceSource.slice(
    workspaceSource.indexOf("async writeFile("),
    workspaceSource.indexOf("async acceptMerge(", workspaceSource.indexOf("async writeFile(")),
  );
  assert.match(write, /stageFileStepAfterPendingRecovery\(/);
  assert.ok(
    write.indexOf("stageFileStepAfterPendingRecovery(") <
      write.indexOf('saveLocalFileDurably("staged file Step"'),
  );
  assert.match(write, /const local = loadLocalFolder\(id\);[\s\S]*const prevNodeId = existing\?\.nodeId/);
});

test("persisted empty folders use folder move and rename semantics", () => {
  assert.match(appSource, /files\[src\]\?\.kind === "folder"/);
  assert.match(appSource, /files\[path\]\?\.kind === "folder"/);
});

test("pull distinguishes a missing local trace from a divergent empty trace", () => {
  assert.match(workspaceSource, /const localHeadIsOnRemoteChain = !!lf\?\.nodeId/);
  assert.match(workspaceSource, /!localHeadIsOnRemoteChain && localContent !== content/);
});

test("ready structural conflicts are restored and rendered outside the boot placeholder", () => {
  assert.match(appSource, /attached\.reconciled\.catch/);
  assert.match(appSource, /loadLocalFolder\(folder\.id\)\?\.structuralConflicts/);
  assert.match(appSource, /className="reconcile-banner structural-error-banner"/);
  assert.match(appSource, /role="alert"/);
});

test("context, Replay, and attach enforce individual trace-history ceilings", () => {
  const contextSource = readFileSync(new URL("../ai/context-gather.ts", import.meta.url), "utf8");
  assert.match(contextSource, /assertTraceTraversalBudget\(chain\)/);
  assert.match(appSource, /replayFileEventPromises\.size >= TRACE_TRAVERSAL_MAX_EVENTS/);
  assert.match(appSource, /replayFileSignedBytes > TRACE_TRAVERSAL_MAX_SIGNED_BYTES/);
  const provenanceSource = readFileSync(
    new URL("../provenance/provenance.ts", import.meta.url),
    "utf8",
  );
  assert.match(provenanceSource, /limit: TRACE_TRAVERSAL_MAX_EVENTS \+ 1/);
  assert.match(provenanceSource, /options: \{ complete\?: boolean \}/);
  assert.match(provenanceSource, /if \(!options\.complete\) assertTraceTraversalBudget\(nodes\)/);
  assert.match(provenanceSource, /fetchLatestFolderNode\([\s\S]*fetchFolderNodes\(folderId, options\)/);
  assert.match(
    provenanceSource,
    /"#f": \[folderId\],[\s\S]{0,120}"#z": \["folder"\],[\s\S]{0,120}limit: TRACE_TRAVERSAL_MAX_EVENTS \+ 1/,
  );
  assert.match(provenanceSource, /assertTraceTraversalBudget\(nodes\)/);
});

test("initial hydration rereads durable pull state after async crash-pad recovery", () => {
  const hydration = sourceBetween(
    "async function openScanned(",
    "/** Factory reset",
  );
  assert.match(hydration, /await getReconcilerVoice\(\)/);
  assert.match(hydration, /const latestLocal = loadLocalFolder\(folderId\)/);
  assert.ok(
    hydration.indexOf("await getReconcilerVoice()") <
      hydration.indexOf("loadLocalFolder(folderId)"),
  );
  assert.match(hydration, /folderIdRef\.current !== folderId/);
  assert.match(hydration, /setFiles\(merged\)/);
});

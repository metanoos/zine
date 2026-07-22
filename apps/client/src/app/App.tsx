import { Fragment, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { createTraceOperationId, isTraceOperationId } from "@zine/protocol";
import { vaultStorage, vaultStorage as localStorage, vaultStorageGeneration, vaultStorageSessionAcceptsWork, subscribeVaultStorage } from "../storage/vault-storage.js";
import { EditorView } from "@codemirror/view";
import { sampleRelays, hitToDocument, rankSampleHits, upsertManifestEntry, resolveTagCandidates, browseTag, fetchChain, fetchFolderNodes, fetchFolderOwner, fetchEventById, diffToDeltas, completeCoinMint, assertPublicationFence, publishEdit, publishDirectCoin, publishHardenedSpan, operationIdFromNode, sha256HexLocal, sendHistoricalStep, sendStep, reconstructRunsTimeline, auditAttribution, stepDeltaRange, parseAuthors, eventMeta, resolveNodeName, resolveCitationChip, bufferFocus, focusTimeline, getOrCreateRuleTrace, setPendingLlmMeta, fetchManifest, findMergeCandidates, loadMergeSides, type TagCandidate, type FocusSelection, type FocusEntry, type CitationChip, type MergeCandidate, type KEdit, type CoinOrigin, type PublicationFence, type LlmStepMeta, excludeInboundSources, findInboundSnapshot, resolveTraceChain, resolveTraceChainAtHead, resolveTraceIdentity, resolveVerifiedFolderTraceIdentityAtHead, TRACE_TRAVERSAL_MAX_EVENTS, TRACE_TRAVERSAL_MAX_SIGNED_BYTES, traceSignedEventBytes, revokeTrace, attestNode, fetchAttestationCounts, isTraceNodeSent, verifiedFileSourceSnapshot, type TraceInbound } from "../provenance/provenance.js";
import { MergePanel } from "../workspace/MergePanel.js";
import { MergePreviewModal } from "../workspace/MergePreviewModal.js";
import { threeWayMerge, autoMergedText } from "../workspace/three-way-merge.js";
import { AttestModal } from "../provenance/AttestModal.js";
import { coinMintOperationKey, completePendingCoinMint as completePendingCoinMintTransaction, createCoinMintRecoverySessionRegistry, createCoinMintSourceReservationRegistry, finalizedCoinMintSourceStepKEdits, retryCoinMintRecovery, resolvedFinalizedCoinMintSourceText, pendingCoinMints, pendingCoinMintBlockingSourceMutation, preparePendingCoinMint, rebaseFinalizedCoinMintSourceFile, resumePendingCoinMints, storedCoinMintAttestation, type CoinMintSourceFinalization, type PendingCoinMint } from "../provenance/coin-mint-journal.js";
import { OblivionModal } from "../workspace/OblivionModal.js";
import { RunModal } from "../ai/RunModal.js";
import { PromptInspectorModal } from "../ai/PromptInspectorModal.js";
import { SendFailureModal } from "../networking/SendFailureModal.js";
import { describeSendFailure, type SendFailureView } from "../networking/send-failure.js";
import { runAgentLoop, type AgentCtx } from "../ai/agent-loop.js";
import { AUTOMATION_STORAGE_KEY, dueAutomationRecipesForWorkspace, finishAgentRunManifest, loadAutomationRecipes, markAutomationRecipeStarted, removeAutomationRecipe, serializeAgentRunManifest, upsertAutomationRecipe, withAutomationSchedulerLock, type AgentRunManifest, type AgentRunTrigger, type AutomationRecipeDraft, type AutomationScopes } from "../ai/automation-store.js";
import { ensureModelVoice } from "../ai/model-voice.js";
import { ownerFolderOf, activeMount } from "../workspace/focus-routing.js";
import { focusDirectoryPath, focusReplayTarget, locateFocus, rebaseUiFocus, refreshFocusNode, sameUiFocus, type FocusRef, type UiFocus } from "../workspace/ui-focus.js";
import type { Event } from "nostr-tools";
import { diffChars } from "diff";
import { findCommands, findMintSelectionTarget, findPendingBrackets, findResolvedBrackets, iterBrackets, resolvedBracketMarkup, wrapSelectionCommand, type Mode } from "../provenance/brackets.js";
import { classifyPaletteSelection, type PaletteSelectionState } from "../editor/palette.js";
import { COIN_CLIPBOARD_MIME, parseCoinClipboardEnvelope, serializeCoinClipboardEnvelope } from "../provenance/coin-clipboard.js";
import { DownloadView } from "../networking/Download.js";
import { AboutView } from "./About.js";
import { VaultsView } from "./VaultsView.js";
import { OnboardingGuide, OnboardingWelcome } from "./Onboarding.js";
import { completedLessonsForStage, isOnboardingActive, loadOnboardingResume, reconcileModelOnboardingStage, reduceOnboardingStage, saveOnboardingStage, type ModelLessonResume, type OnboardingLessonId, type OnboardingStage } from "./onboarding-state.js";
import { aboutHashTarget } from "./about-documents.js";
import { NetworkingView } from "../networking/Networking.js";
import { kademliaEnabledSnapshot, subscribeKademliaConfig } from "../networking/kademlia.js";
import { ModelsView } from "../ai/ModelsView.js";
import { KeysView } from "../identity/KeysView.js";
import { GlobeView } from "../networking/Globe.js";
import { TimesView } from "../replay/TimesView.js";
import { ListingsView } from "../networking/ListingsView.js";
import { SocialQueryBar } from "../networking/SocialQueryBar.js";
import { loadSocialQuery, saveSocialQuery, type SocialQuery } from "../networking/social-query.js";
import { PinPanel } from "../provenance/PinPanel.js";
import { OperatorView } from "../networking/OperatorView.js";
import { TraceLocatorModal } from "../provenance/TraceLocatorModal.js";
import { isStaff, refreshOperatorState, getOperatorState, type OperatorState } from "../networking/operator-store.js";
import { loadKeys, authorVoice, modelSecretKey, secretKeyForVoice, type KeyEntry } from "../identity/keys-store.js";
import { formatPubkey } from "../identity/PubkeyDisplay.js";
import { loadWorkspaceLayout, saveWorkspaceLayout } from "../workspace/workspace-layout-store.js";
import { getVoiceProvider, setVoiceProvider } from "../ai/voice-provider-store.js";
import { getVoicePrompt } from "../ai/voice-prompt-store.js";
import { loadProviders, type ProviderConfig } from "../ai/models-store.js";
import type { PreparedOperation } from "../ai/prepared-operation.js";
import { contentFingerprint } from "../ai/context-snapshot.js";
import { providerProfileFingerprint } from "../ai/provider-fingerprint.js";
import type { RecoverableModelResult } from "../ai/model-operation-executor.js";
import { ModelOperationController } from "../ai/model-operation-controller.js";
import { validateTraceAuthoringResult } from "../ai/trace-authoring-adapter.js";
import { completePrepared } from "../ai/llm.js";
import { DesktopOperationRuntimeV1, type DesktopArtifactApplyInputV1, type DesktopOperationKeyV1 } from "../ai/desktop-operation-runtime.js";
import { createNativeDesktopOperationStoreV1, type DesktopOperationStoreV1 } from "../ai/desktop-operation-store.js";
import type { DesktopOperationEnvelopeV1 } from "../ai/desktop-operation-envelope.js";
import { createDesktopOperationPinnedLineageFenceV1, desktopOperationReviewQueueV1, mergeDesktopOperationPinnedDescendantV1, mergeDesktopOperationPinnedHeadsV1, resolveDesktopOperationPageLineageV1, type DesktopOperationReviewActionV1, type DesktopOperationReviewItemV1 } from "../ai/desktop-operation-review.js";
import { prepareDesktopExtendApplyV1 } from "../ai/desktop-operation-editor-apply.js";
import { desktopOperationAttemptKeyV1, isDesktopOperationAuthorizedThisSessionV1 } from "../ai/desktop-operation-authorization.js";
import { canSignWithSecrets } from "../identity/secret-store.js";
import { resetLocalApp } from "./factory-reset.js";
import { chooseFolder, chooseFile, scanExternal, reifyToDisk, type Run, type FileState, type ScannedFile, type AttachedFolder } from "../workspace/workspace.js";
import { listMintCoins, renderMintCoinReferences } from "../workspace/mint-inventory.js";
import { prepareReifyExport, traceSidecarEntries } from "../provenance/reify.js";
import { createLocalWorkspace, ensureLocalTreeFolderPath, forkFileIntoLocalTree, folderTraceIdentityFromNode, folderWriteSigner, localToFiles, localTreeFolderCoordinate, propagateLocalTreeFolderHead, type LocalFolderTree, type PullResult, type StagedMerge } from "../workspace/workspace-local.js";
import { clearStructuralConflict, clearFolderStepOperation, clearPadPath, createDesktopOperationCrashPadReceiptV1, failStructuralOperation, hasPendingStructuralPathMutation, isExactDesktopOperationCrashPadReceipt, loadLocalFolder, loadLocalShielded, loadPad, mirrorPad, pendingFolderStepOperation, pendingStructuralOperations, saveLocalFile, saveLocalShielded, stageFolderStepOperation } from "../workspace/local-store.js";
import { restoreCrashPadFile } from "../workspace/crash-pad-restore.js";
import { resolvePostWriteTraceId } from "../workspace/stepped-file-identity.js";
import { EMPTY_KEDIT_LOG, appendKEditLog, dropKEditLogPrefix, ensureMdExt, keditLogFromArray, keditLogToArray, minimalTextChange, nextKEditTx, reconcileRunsText, synthesizeKEditTransition, type KEditLog, type Workspace } from "../workspace/workspace-core.js";
import { getPublicKey, verifyEvent } from "nostr-tools/pure";
import { isTauri, resolveRelayUrl } from "../identity/identity.js";
import { getOrCreateMintFolder, getOrCreateScanFolder, getRootId, getRootLabel, mintRoot, setRootLabel, DEFAULT_ROOT_LABEL } from "../workspace/root.js";
import { planScanIntake } from "../workspace/scan-intake.js";
import { loadOnboardingDemo } from "./onboarding-demo.js";
import { modelContextLessonForFolder, planModelContextLesson, type ModelContextLesson } from "../ai/model-context-lesson.js";
import { getReconcilerVoice, getSubstrateVoice, getSubstrateSignerKeyId, setSubstrateSignerKeyId, getSubstrateBindingPubkey } from "../identity/external-voice-store.js";
import { gatherContextBlock, gatherContextSnapshot, clearChainMemo, renderLimelightLog } from "../ai/context-gather.js";
import { applyContextMount, pathInEffectiveScope, rebaseContextMountAfterMove, rebaseContextMountAfterRename, rebaseShieldedAfterMove, rebaseShieldedPath, rebaseTraceRefsAfterMove, removeDeletedShieldedPaths, revertShieldedPathChange, shieldedPathChange, traceRefsKey, type ContextMounts, type ShieldedPathChange, type ScopeRef, type TraceRef } from "../ai/scope-model.js";
import { appendReplayStepsAtLiveEnd, freshSelectedReplayHeads, replayHeadSignature } from "../replay/replay-live-sync.js";
import { planAttestation, planDelivery, type AttestationPlan } from "../provenance/step-policy.js";
import { occupancyTransitions } from "../replay/panel-occupancy.js";
import { createReplayPanels, replayLivePanelIndices, removeReplayPanels, type ReplayPanelPath } from "../replay/replay-panel-layout.js";
import { buildReplayTiming, formatReplayDuration, REPLAY_IDLE_THRESHOLD_MS, replayTransition, type ReplayTiming } from "../replay/replay-timing.js";
import { buildReplayTimeline, admitReplayFolderOccurrence, collapseDerivedFolderCheckpoints, derivedFolderCheckpointDetails, emptyReplayDisplay, historicalReplayMembers, memoizedReplayFolderNodeLoad, REPLAY_MAX_FOLDER_OCCURRENCES, replayFrameIndexAtOrBefore, orderReplayTraceChain, orderReplayTraceChainAtHead, orderReplayTimelineSteps, recursiveReplaySources, replayPathOccurrenceActiveAt, replayDisplayAt, replayDisplayThroughFrame, replayTimelineEventIds, replayDisplayWithFrame, type PlayFrame, type ReplayDisplay, type RecursiveReplayFileSource, type RecursiveReplayFolderSource } from "../replay/replay-timeline.js";
import { combineTraceConformance, traceConformanceLabel, verifyFileTraceChain, verifyFolderTraceChain, type TraceConformanceVerdict } from "../provenance/trace-conformance.js";
import { type OpKind as PromptOpKind, type OpInputs } from "../ai/op-prompts.js";
import { loadOpLensSelections, saveOpLensSelection, type OpLensId } from "../ai/op-lenses.js";
import { MINT, SCAN, OBLIVION, forkPathForMint, formatLocalSecondStamp, isMintPath as isMint, isScanPath as isScan, isOblivionPath as isOblivion, isSystemRootPath, mintedPath, slugifyFilename, systemPathDisplayName, uniquePath } from "../workspace/generated-paths.js";
import { closeDeletedTabs, type DeleteTabTarget } from "../workspace/delete-tabs.js";
import { buildDirectoryTree, type TreeEntry } from "../workspace/tree-model.js";
import { loadDirectorySort, saveDirectorySort, type DirectorySortOrder } from "../workspace/directory-sort.js";
import "./App.css";
import {
  ActionPalette,
  DIRECT_COIN_COMPOSER_TAB,
  DesktopExtendReviewStrip,
  MAX_PANELS,
  MintConsentModal,
  NavRail,
  OperatorSetupModal,
  Panel,
  RAIL_EXPANDED_KEY,
  REPLAY_LOAD_CONCURRENCY,
  ROOT,
  ReplayTransport,
  SIDEBAR_WIDTH_DEFAULT,
  SIDEBAR_WIDTH_KEY,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
  SUBSTRATES,
  SUBSTRATE_LABEL_KEY,
  SamplerPanel,
  Sidebar,
  TagBrowserPanel,
  VOICE_ATTRIBUTION_KEY,
  ViewErrorBoundary,
  ViewHeader,
  ViewPlaceholder,
  applyTheme,
  authoringAuthorityField,
  automationScopesFor,
  basename,
  canDrop,
  emptyDirectCoinDraft,
  encodeSettleAnchors,
  estimateTokens,
  flatten,
  folderReplayStep,
  folderTab,
  folderTabPath,
  hasChild,
  isCoinComposerTab,
  isCoinTab,
  isCompletedCoinFile,
  isCompletedCoinPath,
  isDescendantOrSelf,
  isFolderTab,
  isInScope,
  isRunningPaletteOp,
  isValidTagToken,
  keditField,
  mapPanel,
  mapReplayBounded,
  nextActive,
  opVoiceEffect,
  parentPath,
  parseReplyOutput,
  partitionDoc,
  pruneTabModes,
  readRailExpanded,
  readSidebarWidth,
  readTheme,
  readVoiceAttribution,
  rebaseFolderTab,
  rebasePath,
  reconcileLayout,
  removeAt,
  replayActionLabel,
  replayLoadFailure,
  replayNodeContentHash,
  replayStepIndexForPath,
  resolvedMode,
  reweaveAnchors,
  setKEditsEffect,
  setRunsEffect,
  spliceAt,
  stepDescription,
  stripRanges,
  useProvenance,
  voiceField,
  waitForMintRecoveryRetry,
  withPersistedFolderStates,
  type AttestTarget,
  type CoinClipboardCitation,
  type CoinClipboardTicket,
  type Creating,
  type DirectCoinDraft,
  type ForegroundMintLease,
  type GlobalCtxItem,
  type HistoricalActionPhase,
  type HistoricalActionStatus,
  type InboundFreshness,
  type MintConsentRequest,
  type MintRecoveryNotice,
  type OpKind,
  type PaletteStatusOp,
  type PanelOccupancy,
  type PanelState,
  type ReplayStep,
  type Substrate,
  type SummonStatus,
  type Theme,
  type TraceCandidate,
  type View,
} from "./AppShell.js";
export type { GlobalCtxItem, OpKind } from "./AppShell.js";

function App() {
  const coinsEnabled = useSyncExternalStore(
    subscribeKademliaConfig,
    kademliaEnabledSnapshot,
    () => false,
  );
  // The workspace is folder-driven: `files` starts empty and is populated by
  // the boot scan once a folder is attached. `folder` holds the attached
  // folder's stable id + absolute path (persisted in localStorage by
  // workspace.ts); null while the user hasn't picked one yet. On the webapp
  // `path` is undefined — the folder lives on the relay, addressed by `id`.
  const [folder, setFolder] = useState<AttachedFolder | null>(() => {
    const id = getRootId();
    if (!id) return null;
    const label = getRootLabel() ?? DEFAULT_ROOT_LABEL;
    return { id, label };
  });
  const folderRef = useRef<AttachedFolder | null>(folder);
  folderRef.current = folder;
  // The onboarding record is intentionally independent from Root state. A
  // missing record only means "fresh" when no Root existed at launch; profiles
  // created before onboarding shipped go straight to their ordinary workspace.
  const onboardingResumeAtBoot = useRef(loadOnboardingResume(folder !== null));
  const [onboardingStage, setOnboardingStage] = useState<OnboardingStage>(
    onboardingResumeAtBoot.current.stage,
  );
  const [modelLessonResume, setModelLessonResume] = useState<ModelLessonResume | undefined>(
    onboardingResumeAtBoot.current.lesson,
  );
  const [completedOnboardingLessons, setCompletedOnboardingLessons] = useState<OnboardingLessonId[]>(
    onboardingResumeAtBoot.current.completedLessons,
  );
  const completedOnboardingLessonsRef = useRef<OnboardingLessonId[]>(completedOnboardingLessons);
  completedOnboardingLessonsRef.current = completedOnboardingLessons;
  const [modelProbeSession, setModelProbeSession] = useState<{
    providerId: string;
    providerFingerprint: string;
  } | null>(null);
  const onboardingStageRef = useRef<OnboardingStage>(onboardingStage);
  onboardingStageRef.current = onboardingStage;

  function commitOnboardingStage(
    stage: OnboardingStage,
    lesson: ModelLessonResume | undefined = modelLessonResume,
  ): void {
    const nextCompletedLessons = completedLessonsForStage(
      completedOnboardingLessonsRef.current,
      stage,
    );
    onboardingStageRef.current = stage;
    completedOnboardingLessonsRef.current = nextCompletedLessons;
    saveOnboardingStage(stage, localStorage, lesson, nextCompletedLessons);
    setOnboardingStage(stage);
    setCompletedOnboardingLessons(nextCompletedLessons);
  }

  function advanceOnboarding(event: Parameters<typeof reduceOnboardingStage>[1]): void {
    const next = reduceOnboardingStage(onboardingStageRef.current, event);
    if (next !== onboardingStageRef.current) commitOnboardingStage(next);
  }

  async function beginOnboarding(): Promise<void> {
    if (!folder) return;
    if (replayRef.current) endReplay();
    const onboardingFolder = folder;
    const demo = await loadOnboardingDemo(onboardingFolder.id);
    setFiles((prev) => ({ ...prev, [demo.path]: demo.file }));
    // Re-attaching schedules the demo's empty genesis + starter-body Steps.
    // The callback advances React state after that background publication so
    // Replay can resolve the new trace without requiring a reload.
    void backendRef.current.attach(onboardingFolder, (path, file) => {
      if (folderIdRef.current !== onboardingFolder.id) return;
      setFiles((prev) => {
        if (file) return { ...prev, [path]: file };
        if (!(path in prev)) return prev;
        const next = { ...prev };
        delete next[path];
        return next;
      });
      if (file) seedSteppedRef.current({ [path]: file });
    }).catch((error) => {
      console.warn("[onboarding] demo attach failed:", error);
    });
    commitOnboardingStage("awaiting-edit");
    setActiveView("editor");
    selectFile(demo.path);
  }

  const [modelLessonError, setModelLessonError] = useState<string | null>(null);

  function beginModelOnboarding(): void {
    advanceOnboarding("start-model");
    setModelLessonError(null);
    selectView("models");
  }

  function beginScanOnboarding(): void {
    advanceOnboarding("start-scan");
    selectView("editor");
    void onScan("file");
  }

  async function ensureModelLesson(): Promise<ModelContextLesson> {
    if (!folder) throw new Error("Open a workspace before starting the AI lesson");
    const currentBodies = Object.fromEntries(
      Object.entries(filesRef.current).map(([path, state]) => [path, flatten(state.runs)]),
    );
    const lesson = planModelContextLesson(currentBodies);
    const signer = secretKeyForVoice(authorPubkey);
    if (!signer) throw new Error("Unlock the AUTHOR key before creating the AI lesson");
    await backendRef.current.createFolder(lesson.folderPath);
    const staged: Record<string, FileState> = {};
    for (const artifact of lesson.artifacts) {
      const existing = filesRef.current[artifact.path];
      if (existing?.nodeId && flatten(existing.runs) === artifact.body) {
        staged[artifact.path] = existing;
        continue;
      }
      const runs = [{ voice: authorPubkey, text: artifact.body }];
      const nodeId = await backendRef.current.writeFile(
        artifact.path,
        artifact.body,
        [],
        signer,
        runs,
      );
      staged[artifact.path] = {
        runs,
        nodeId,
        traceId: existing?.traceId ?? nodeId,
        tags: [],
        updatedAt: Date.now(),
      };
    }
    filesRef.current = { ...filesRef.current, ...staged };
    setFiles((current) => ({ ...current, ...staged }));
    seedSteppedRef.current(staged);
    const resume: ModelLessonResume = {
      folderPath: lesson.folderPath,
      targetPath: lesson.targetPath,
      sourcePath: lesson.sourcePath,
      excludedPath: lesson.excludedPath,
    };
    setModelLessonResume(resume);
    return lesson;
  }

  async function completeModelSetup(): Promise<void> {
    try {
      setModelLessonError(null);
      if (bootState !== "ready") throw new Error("Wait for the workspace to finish opening, then Test again");
      const lesson = await ensureModelLesson();
      const resume: ModelLessonResume = {
        folderPath: lesson.folderPath,
        targetPath: lesson.targetPath,
        sourcePath: lesson.sourcePath,
        excludedPath: lesson.excludedPath,
      };
      const next = reduceOnboardingStage(onboardingStageRef.current, "provider-probed");
      commitOnboardingStage(next, resume);
      scopeRef.current = [];
      shieldedRef.current = new Set();
      setScope([]);
      setShielded(new Set());
      if (folder) saveLocalShielded(folder.id, new Set());
      selectView("editor");
    } catch (error) {
      setModelLessonError(error instanceof Error ? error.message : String(error));
    }
  }

  function dismissOnboarding(): void {
    commitOnboardingStage("dismissed");
  }

  function restartOnboarding(): void {
    if (replayRef.current) endReplay();
    commitOnboardingStage("welcome");
    selectView("editor");
  }
  useEffect(() => {
    if (onboardingStage === "model-setup") selectView("models");
  }, [onboardingStage]); // eslint-disable-line react-hooks/exhaustive-deps
  // Incoming forks / sibling heads for the active file (branch detection).
  // Refreshed on folder/path change and after incorporate.
  const [mergeCandidates, setMergeCandidates] = useState<MergeCandidate[]>([]);
  const [mergeBusy, setMergeBusy] = useState(false);
  // Merge/reconcile failure surfaced inline (banner + MergePanel). The prior
  // code wrote these to bootError, which only renders on the boot placeholder
  // screen — so a failed Step merge flashed "Stepping…" then vanished with no
  // feedback. This is shown where the action lives.
  const [mergeError, setMergeError] = useState<string | null>(null);
  // Open three-way reconcile session (conflict / sibling candidates).
  const [mergeSession, setMergeSession] = useState<{
    candidate: MergeCandidate;
    base: string;
    ours: string;
    path: string;
  } | null>(null);
  // Clean-merge preview: an auto-resolved merge (no overlapping conflicts)
  // awaiting a confirm. Unlike mergeSession this is review-only — the merged
  // body is final, the user just green-lights the step.
  const [mergePreview, setMergePreview] = useState<{
    candidate: MergeCandidate;
    path: string;
    before: string;
    after: string;
  } | null>(null);
  // Background-pull merges that auto-resolved cleanly (no textual conflict) but
  // are staged for review rather than stepped blindly. Populated by the webapp
  // relay pull. Local is NOT modified while a merge is staged; Accept writes it
  // and steps the merge node, Close drops it.
  const [stagedMerges, setStagedMerges] = useState<StagedMerge[]>([]);
  const [stagedMergeBusy, setStagedMergeBusy] = useState(false);
  const [stagedMergeError, setStagedMergeError] = useState<string | null>(null);
  const [stagedMergeView, setStagedMergeView] = useState<StagedMerge | null>(null);
  // Structural move/delete retry and terminal-conflict status must remain
  // visible after the editor is ready (bootError renders only placeholders).
  const [structuralError, setStructuralError] = useState<string | null>(null);
  const [structuralConflictId, setStructuralConflictId] = useState<string | null>(null);
  // Latest Root identity. Async pull and mutation completions must prove they
  // still belong to this workspace before touching global React state.
  const folderIdRef = useRef<string | null>(folder?.id ?? null);
  folderIdRef.current = folder?.id ?? null;
  // Storage backend. The root is always pathless (relay + localStorage crash
  // pad; disk is touched only by Scan/Reify), so both desktop and webapp use
  // the local/relay arm — it boots from localStorage instantly and
  // background-pulls the relay, exactly the pathless-root contract. Held in a
  // ref so mutation call sites have a stable handle; it closes over the
  // attached folder, so callers drop the `folder` arg.
  const backendRef = useRef<Workspace>(createLocalWorkspace({
    onPullResult: (result: PullResult) => {
      if (folderIdRef.current !== result.rootId) return;
      setStagedMerges(result.staged);
      if (result.conflicts.size > 0) {
        setMergeError(
          `Remote changes conflict with local work at ${[...result.conflicts].sort().join(", ")}`,
        );
      }
    },
  }));
  // Opaque clipboard tickets live only in this press session. The system
  // clipboard carries the ticket alongside ordinary text; paste resolves it
  // here to a signed coin. Unknown/expired tickets degrade to native text.
  const coinClipboardTicketsRef = useRef<Map<string, CoinClipboardTicket>>(new Map());
  // Latest folder id, mirrored into a ref so async functions (rescan, ops)
  // can detect a folder switch that happened during their `await` and bail
  // before writing stale state. Without this, a rescan started under folder A
  // that resolves after a switch to B would clobber B's `files` with A's scan.
  const prevFolderIdRef = useRef<string | null>(folderIdRef.current);
  // Dedupe key for the last focus delta published to the folder chain, so the
  // debounced focus effect (below the selection mirror effect) doesn't emit a
  // node for a no-op re-selection. JSON of {focusSel, panelIndex}. Reset on
  // folder switch so the new folder's first focus isn't suppressed by a stale
  // key from the previous folder.
  const lastFocusKeyRef = useRef<string | null>(null);
  const panelOccupancyRef = useRef<(PanelOccupancy | null)[]>([]);
  if (prevFolderIdRef.current !== folderIdRef.current) {
    prevFolderIdRef.current = folderIdRef.current;
    lastFocusKeyRef.current = null;
  }
  useEffect(() => {
    setStagedMerges([]);
    setStagedMergeView(null);
    setStagedMergeError(null);
    setMergeError(null);
    setStructuralError(null);
  }, [folder?.id]);
  // Destructive local-app reset (opened from the directory tree's corner
  // control). Clears browser state plus the desktop sidecar.
  const [factoryResetOpen, setFactoryResetOpen] = useState(false);
  const [traceLocatorOpen, setTraceLocatorOpen] = useState(false);
  const [resetBusy, setResetBusy] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);
  const [reifyPrompt, setReifyPrompt] = useState<{
    includeTrace: boolean;
    /** An explicit tree target bypasses the prompt-context mount. */
    target?: ScopeRef;
  } | null>(null);
  const [files, setFiles] = useState<Record<string, FileState>>({});
  const [directCoinDraft, setDirectCoinDraft] = useState<DirectCoinDraft>(emptyDirectCoinDraft);
  const [directCoinBusy, setDirectCoinBusy] = useState(false);
  const [directCoinError, setDirectCoinError] = useState<string | null>(null);
  const [oblivionModalPath, setOblivionModalPath] = useState<string | null>(null);
  useEffect(() => {
    if (
      oblivionModalPath &&
      (!files[oblivionModalPath] || !isOblivion(oblivionModalPath))
    ) {
      setOblivionModalPath(null);
    }
  }, [oblivionModalPath, files]);
  // Per-node attestation totals visible from the configured read relays. The
    // map deliberately includes zeroes once loaded so every stepped trace gets a
    // stable tab-footer row; the row says "reachable", never "global".
  const [attestationCounts, setAttestationCounts] = useState<Record<string, number>>({});
  // Reachability of nodes considered by the Attest palette action. Missing
  // means unknown and is conservatively planned as requiring Send; a focused
  // node is checked against configured external write relays below.
  const [sentNodeStatus, setSentNodeStatus] = useState<Record<string, boolean>>({});
  const attestationNodeSig = useMemo(
    () => [...new Set(Object.values(files).map((file) => file.nodeId).filter(Boolean))].sort().join("\n"),
    [files],
  );
  useEffect(() => {
    const nodeIds = attestationNodeSig ? attestationNodeSig.split("\n") : [];
    if (nodeIds.length === 0) {
      setAttestationCounts({});
      return;
    }
    let cancelled = false;
    void fetchAttestationCounts(nodeIds).then((counts) => {
      if (!cancelled) setAttestationCounts(Object.fromEntries(counts));
    });
    return () => {
      cancelled = true;
    };
  }, [attestationNodeSig]);
  // Sibling traces available as citation-picker candidates: every file in the
  // current folder that has stepped a node this session (has a head nodeId to
  // cite). Built from `files` so it stays live as files step/rename. Used by
  // the citations-out label picker.
  const traceCandidates = useMemo<TraceCandidate[]>(() => {
    const out: TraceCandidate[] = [];
    for (const [path, f] of Object.entries(files)) {
      if (isCoinTab(path) && !isCompletedCoinFile(f)) continue;
      if (f.kind !== "folder" && f.nodeId) {
        out.push({ path, nodeId: f.nodeId, ...(f.traceId ? { traceId: f.traceId } : {}) });
      }
    }
    return out;
  }, [files]);
  const completedCoinPaths = useMemo(
    () => new Set(
      Object.entries(files)
        .filter(([path, file]) => isCoinTab(path) && isCompletedCoinFile(file))
        .map(([path]) => path),
    ),
    [files],
  );
  // Citation targets are immutable Steps, but the traces containing those
  // Steps keep advancing. A local head move refreshes progress immediately;
  // the epoch also checks relay-side advances made by another press while the
  // citation row is visible (and immediately when this window regains focus).
  const localTraceHeadVersion = useMemo(
    () =>
      Object.entries(files)
        .map(([path, file]) => `${path}:${file.traceId ?? ""}:${file.nodeId ?? ""}`)
        .sort()
        .join("\n"),
    [files],
  );
  const [citationRefreshEpoch, setCitationRefreshEpoch] = useState(0);
  const citationResolutionVersion = `${localTraceHeadVersion}\n${citationRefreshEpoch}`;
  // The workspace boots with a single panel that fills the row; the user opens
  // more by right-clicking "Open to side" or dragging a tab onto a panel's
  // right edge (up to MAX_PANELS). Empty panels collapse back out (see
  // closeTab/moveTab). Reply spawns a new column to the right of its source
  // (see replyLLM) so the reply always lands alongside the origin. All
  // parallel per-panel structures (panelViews, summonStatus, summonAbort,
  // panelWeights) stay length-locked to panels via spawnPanel / moveTabToNewPanel
  // / commitWithCollapse.
  const [panels, setPanels] = useState<PanelState[]>([{ tabs: [], active: "" }]);
  const panelsRef = useRef<PanelState[]>(panels);
  panelsRef.current = panels;
  const [activePanel, setActivePanel] = useState<number>(0);
  // Explorer operation selection is independent from focus. It exists only for
  // drag, right-click, and batch directory operations; author gestures and
  // replay never read it.
  const [directorySelection, setDirectorySelectionState] = useState<TraceRef[]>([]);
  const directorySelectionRef = useRef<readonly TraceRef[]>(directorySelection);
  directorySelectionRef.current = directorySelection;
  function chooseDirectorySelection(next: readonly TraceRef[]) {
    const deduped = next.filter(
      (item, index) => next.findIndex((other) => other.path === item.path) === index,
    );
    directorySelectionRef.current = deduped;
    setDirectorySelectionState(deduped);
  }
  // Focus is the one semantic subject routed to AUTHOR, MODEL, and replay.
  // Its locus is always a live tab: replay projections may become frontmost
  // for viewing, but never steal or rewrite this value.
  const [uiFocus, setUiFocusState] = useState<UiFocus | null>(null);
  const uiFocusRef = useRef<UiFocus | null>(uiFocus);
  uiFocusRef.current = uiFocus;
  function commitUiFocus(next: UiFocus | null) {
    if (sameUiFocus(uiFocusRef.current, next)) return;
    uiFocusRef.current = next;
    setUiFocusState(next);
  }
  // The cited traces for each open file — every `q` tag on the file's current
  // head node, resolved to a name and exact-step distance via
  // `resolveCitationChip`. This subsumes the old
  // single `reply-to` chip: a Reply is just one more cited trace here (its
  // source is a `q` tag on every step, folded into the same dedup as body
  // quotes). Keyed by relativePath; keyed-on-headNodeId is tracked in
  // `citationHeadByPath` so a new step re-resolves. Absent = not yet resolved.
  const [citationsByPath, setCitationsByPath] = useState<Record<string, CitationChip[]>>({});
  // The head node id each entry in `citationsByPath` was resolved against, so a
  // re-resolve only fires when the head actually moved (a new step changed the
  // citation set). Without this, every render would refetch.
  const [citationHeadByPath, setCitationHeadByPath] = useState<Record<string, string>>({});
  // Resolution version for each row. The citing head can stay unchanged while
  // a cited trace advances, so `citationHeadByPath` alone is not enough to keep
  // the behind-count current.
  const [citationResolutionByPath, setCitationResolutionByPath] = useState<Record<string, string>>({});
  // The tagged-trace chips for each open file — `file.citationIds` (the
  // `tag-add` subset of the head's `q` edges) resolved to named chips. Keyed on
  // the cited id set, NOT on the head node, so a fresh citation appears
  // instantly — before the debounce steps a new head (which is what the
  // `citationsByPath` effect above waits for). `resolveNodeName` caches per
  // node id, so this stays cheap even though it fires on every tag edit.
  const [taggedChipByPath, setTaggedChipByPath] = useState<Record<string, CitationChip[]>>({});
  const [taggedResolutionByPath, setTaggedResolutionByPath] = useState<Record<string, string>>({});
  const hasVisibleCitations = panels.some((panel) => {
    const path = panel.active;
    return (
      !!path &&
      !isFolderTab(path) &&
      !isCoinTab(path) &&
      !isCoinComposerTab(path) &&
      files[path]?.kind !== "folder"
    );
  });
  useEffect(() => {
    if (!hasVisibleCitations) return;
    const refresh = () => setCitationRefreshEpoch((epoch) => epoch + 1);
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, 30_000);
    window.addEventListener("focus", refresh);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", refresh);
    };
  }, [hasVisibleCitations]);
  // The inbound tracker for each open file — forks of it, traces that tag it,
  // and traces that cite it (spec §3.8 forks, §6 tags, §3.3 cites), the inverse
  // of the outbound `citationsByPath`/`taggedChipByPath`. Keyed on the head node
  // id so a re-resolve only fires when the head actually moved (a new step may
  // change the inbound set, since cites pin a specific nucleus). `name` on each
  // entry is filled in lazily by the name-resolution effect below.
  const [inboundByPath, setInboundByPath] = useState<Record<string, TraceInbound[]>>({});
  const [inboundResolutionByPath, setInboundResolutionByPath] = useState<Record<string, string>>({});
  const [inboundFreshnessByPath, setInboundFreshnessByPath] = useState<
    Record<string, InboundFreshness>
  >({});
  // A move into Oblivion updates `files` synchronously, while its relay-side
  // import+tombstone lands in the background. Hide those source heads from the
  // already-cached inbound rows during that window; findInboundSnapshot applies the
  // same lifecycle rule once the relay catches up.
  const oblivionInboundSourceIds = useMemo(
    () =>
      new Set(
        Object.entries(files)
          .filter(([path, file]) => isOblivion(path) && file.kind !== "folder" && !!file.nodeId)
          .map(([, file]) => file.traceId ?? file.nodeId),
      ),
    [files],
  );
  // The Steps history/diff modal (Part B): set when the user clicks a panel's
  // "Steps" button, or the "replying to ↑" chip (which additionally pins a
  // specific historical node). null when closed.
  // Folder-wide delta replay. Every cursor index names one real saved Step.
  // Historical content lives in `replayDisplay`, never in the live file store.
  const [replay, setReplay] = useState<{
    steps: ReplayStep[];
    index: number;
  } | null>(null);
  const [replayDisplay, setReplayDisplay] = useState<ReplayDisplay | null>(null);
  const [replayTiming, setReplayTiming] = useState<ReplayTiming | null>(null);
  const [replaySkipNotice, setReplaySkipNotice] = useState<string | null>(null);

  // Fork-from-snapshot modal: surfaced when the user tries to edit while
  // replay-frozen on a historical step. `stepIndex` is the replay step they're
  // viewing — the fork seeds from that step's event id (spec §3.8: forked-from
  // pins the exact node-version). null = modal dismissed.
  const [forkPrompt, setForkPrompt] = useState<{ stepIndex: number } | null>(null);
  // The trace target the Attest modal is endorsing. Null when the modal is
  // closed. A file target may not have a node id yet: confirmation composes
  // the first Step and Send before it appends the Attestation.
  const [attestTarget, setAttestTarget] = useState<AttestTarget | null>(null);
  const [historicalActionStatus, setHistoricalActionStatus] = useState<
    Record<string, HistoricalActionStatus>
  >({});
  // Run-modal open state. Opens from the MODEL row's Run button; onStart kicks
  // off startAgentRun with the composed goal + chosen root provider.
  const [runOpen, setRunOpen] = useState(false);
  // Browser-local run recipes. A small scheduler below checks these while the
  // app is open and re-enters the same draft-only startAgentRun path used by
  // the modal. The busy ref makes claiming single-flight across effect ticks.
  const [automationRecipes, setAutomationRecipes] = useState(() => loadAutomationRecipes());
  const automationSchedulerBusyRef = useRef(false);
  const activeAgentRunsRef = useRef<Map<
    AbortController,
    { workspaceId: string; stop: () => void }
  >>(new Map());
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key === null || event.key === AUTOMATION_STORAGE_KEY) {
        setAutomationRecipes(loadAutomationRecipes());
      }
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);
  useEffect(() => {
    const workspaceId = folder?.id ?? "";
    for (const run of activeAgentRunsRef.current.values()) {
      if (run.workspaceId !== workspaceId) run.stop();
    }
  }, [folder?.id]);
  // Per-tab view mode, keyed by file path. Each open file remembers which
  // surface (preview vs markdown) it was last shown on, so switching tabs
  // restores the surface you left it in rather than a single panel-wide mode.
  // Entries persist as long as at least one panel still holds the tab; once a
  // path has no open tab anywhere it's pruned (see setTabModes), so reopening a
  // closed file always starts fresh in preview — the default.
  const [tabModes, setTabModes] = useState<Record<string, Mode>>({});
  const [bootState, setBootState] = useState<"idle" | "scanning" | "ready" | "missing">("idle");
  const [bootError, setBootError] = useState<string | null>(null);
  // Operator layer (webapp only). `operatorState` is null until the first
  // /operator/state fetch resolves; `operatorSetup` opens the bind/rotate
  // modal. The boot effect below triggers the fetch so the setup modal can
  // appear before the editor lands. Desktop sidecar never sets these — it
  // doesn't serve /operator/*.
  const [operatorState, setOperatorState] = useState<OperatorState | null>(() =>
    getOperatorState(),
  );
  const [operatorSetup, setOperatorSetup] = useState<"off" | "boot" | "manual">("off");
  // Mirror of `replay` for use in imperative handlers (replayStepTo/endReplay)
  // and the stepFile guard, which must read replay-active state without
  // depending on a re-render. Kept in sync by the effect below.
  const replayRef = useRef<{
    steps: ReplayStep[];
    index: number;
  } | null>(null);
  // Each path's genesis→head chain, captured in beginReplay so keystroke
  // playback can expand edits without refetching. Cleared
  // in endReplay. Kept in a ref (not state) — it's read imperatively by the
  // play builder and doesn't drive render.
  const replayChainsRef = useRef<Record<string, Event[]>>({});
  // True only while the replay panel owns focus. The live file store remains
  // untouched, but this gates global authoring gestures so Cmd+S cannot turn a
  // read-only historical view into a new live Step.
  const replayActiveRef = useRef(false);
  // Per-keystroke playback has a separate cursor from the Step timeline. The
  // stepper/slider stay at save-point granularity while edit frames advance;
  // pausing snaps the step cursor to the current frame's enclosing step.
  const REPLAY_SPEEDS = [1, 2, 4, 8, 16] as const;
  const [replayLoading, setReplayLoading] = useState(false);
  const [replayConformance, setReplayConformance] = useState<TraceConformanceVerdict | null>(null);
  const replayLoadSequenceRef = useRef(0);
  const [playing, setPlaying] = useState(false);
  const [playSpeed, setPlaySpeed] = useState<number>(1);
  const [playTimeline, setPlayTimeline] = useState<PlayFrame[] | null>(null);
  const [playCursor, setPlayCursor] = useState(0);
  const playTimelineRef = useRef<PlayFrame[] | null>(null);
  const playCursorRef = useRef(0);
  const [replayPlayheadAt, setReplayPlayheadAt] = useState<number | undefined>();
  const replayDisplayRef = useRef<ReplayDisplay | null>(null);
  const replayPanelSignatureRef = useRef("");
  useEffect(() => {
    playTimelineRef.current = playTimeline;
  }, [playTimeline]);
  useEffect(() => {
    playCursorRef.current = playCursor;
  }, [playCursor]);
  useEffect(() => {
    replayDisplayRef.current = replayDisplay;
  }, [replayDisplay]);
  useEffect(() => {
    replayActiveRef.current = panels[activePanel]?.replayOwned === true;
  }, [panels, activePanel]);
  useEffect(() => {
    if (!replaySkipNotice) return;
    const id = window.setTimeout(() => setReplaySkipNotice(null), 1_800);
    return () => window.clearTimeout(id);
  }, [replaySkipNotice]);
  // The play tick uses the recorded KEdit/checkpoint timestamps. At 1× every
  // ordinary interval is literal wall time; inactivity over 20 seconds is the
  // sole exception and plays at 100× the selected speed with an aria-live notice.
  // The panel and transport advance together only when the next recorded frame
  // lands. There is no between-frame thumb position because no panel content
  // exists for one.
  useEffect(() => {
    if (!playing) return;
    const tl = playTimelineRef.current;
    if (!tl || tl.length === 0) return;
    if (playCursorRef.current >= tl.length - 1) {
      setPlaying(false);
      const lastFrame = tl[tl.length - 1];
      if (lastFrame) {
        setReplayPlayheadAt(lastFrame.at);
        setReplayCursor(lastFrame.stepIndex);
      }
      return;
    }
    const current = tl[playCursorRef.current];
    const nextFrame = tl[playCursorRef.current + 1];
    if (!current || !nextFrame) return;
    const transition = replayTransition(
      current.at,
      nextFrame.at,
      playSpeed,
      replayTiming?.idleThresholdMs ?? REPLAY_IDLE_THRESHOLD_MS,
    );
    const delayMs = transition.delayMs;
    if (transition.fastForwardedMs > 0) {
      setReplaySkipNotice(
        `Fast-forwarding ${formatReplayDuration(transition.fastForwardedMs)} of inactivity at 100×`,
      );
    }
    const id = setTimeout(() => {
      const next = playCursorRef.current + 1;
      const frame = tl[next];
      if (!frame) return;
      // The inactivity notice owns the gap only. The arriving action must get
      // its own pulse, especially when that frame is a saved Step marker.
      setReplaySkipNotice(null);
      renderPlayFrame(frame);
      setReplayPlayheadAt(frame.at);
      playCursorRef.current = next;
      setPlayCursor(next);
    }, delayMs);
    return () => clearTimeout(id);
  }, [playing, playCursor, playSpeed, playTimeline, replayTiming]); // eslint-disable-line react-hooks/exhaustive-deps
  // Completion is earned by reaching the end of a real replay. Pausing midway
  // leaves the coachmark in place and resumes from the same frame; no arbitrary
  // "Next" action can manufacture the activation moment.
  useEffect(() => {
    if (
      (onboardingStage !== "replaying" && onboardingStage !== "context-replay") ||
      playing ||
      !playTimeline ||
      playTimeline.length === 0 ||
      playCursor < playTimeline.length - 1
    ) {
      return;
    }
    if (onboardingStage === "replaying") {
      commitOnboardingStage("complete");
      return;
    }
    const lesson = modelLessonResume;
    const resultStep = lesson?.resultNodeId
      ? replayRef.current?.steps.find((step) => step.event.id === lesson.resultNodeId)
      : undefined;
    const spanVerified = Boolean(
      resultStep &&
      lesson?.resultSpanHash &&
      resultStep.runsUpToHere.some((run) =>
        contentFingerprint(run.text) === lesson.resultSpanHash ||
        contentFingerprint(run.text.replace(/^\n/, "")) === lesson.resultSpanHash),
    );
    if (
      resultStep &&
      spanVerified &&
      uiFocusRef.current?.path === lesson?.targetPath
    ) {
      commitOnboardingStage(
        reduceOnboardingStage(onboardingStageRef.current, "result-replayed"),
        lesson,
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onboardingStage, playing, playTimeline, playCursor, modelLessonResume]);
  const {
    stepFile,
    ready,
    setFilesRef,
    pendingPaths,
    writeRef,
    suppressStep,
    seedSteppedRef,
    authorSignerRef,
    lastSteppedRef,
    unsteppedPathSet,
    unsteppedEditCounts,
  } = useProvenance(folder, files, replayActiveRef);
  const mintSourceReservations = useRef(createCoinMintSourceReservationRegistry()).current;
  const unsteppedPathSetRef = useRef(unsteppedPathSet);
  unsteppedPathSetRef.current = unsteppedPathSet;
  const modelOperationControllerRef = useRef<ModelOperationController | null>(null);
  // Drop the context-block delta-log memo whenever the attached folder changes
  // (attach, switch, detach) — memoized chains are keyed by folder id + path,
  // so a stale folder id's entries must not survive into the new one.
  useEffect(() => {
    clearChainMemo();
    modelOperationControllerRef.current?.invalidate();
  }, [folder?.id]);
  // End replay when the folder changes (switch/detach): the replay steps and
  // snapshot are keyed to the prior folder's chains and would otherwise drive
  // the editor against stale content. endReplay restores live state first.
  const replayFolderIdRef = useRef<string | null>(null);
  useEffect(() => {
    const prev = replayFolderIdRef.current;
    replayFolderIdRef.current = folder?.id ?? null;
    if (replay && prev !== null && folder?.id !== prev) {
      endReplay();
    }
  }, [folder?.id]);
  // Auto-bootstrap replay metadata once the folder finishes loading, so the
  // stepper paints immediately at the newest real save point. No panel opens
  // and no live editor state changes until the user makes a replay gesture.
  // Fires once per folder attach: the `bootState === "ready"` edge arrives after
  // openScanned for every load path (the [folder?.id] re-attach), and the
  // folder-id guard dedupes across the boot's re-attach. A manual
  // endReplay keeps the ref set, so re-entering "ready" (e.g. a rescan that
  // flips bootState) won't re-bootstrap over the user's explicit teardown.
  const autoBootstrappedRef = useRef<string | null>(null);
  useEffect(() => {
    if (bootState !== "ready" || !folder) return;
    if (autoBootstrappedRef.current === folder.id) return;
    if (replay) return;
    autoBootstrappedRef.current = folder.id;
    // Best-effort: replay is a nicety on attach. A slow/down local relay must
    // not surface as Unhandled Promise Rejection and must not block editing.
    void beginReplay().catch((e) => {
      console.warn("[replay] auto-bootstrap failed:", e);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bootState, folder?.id]);
  // Follow-newest: while replay is parked on `last` (the live position), watch
  // for newly-stepped node ids. Each new step appends a step and the bar
  // advances to the new last, so the resting position always reflects current
  // state and the user can keep stepping back to verify each save point as it
  // lands. Only acts on `last` — on a historical step the guard blocks steps,
  // so nothing changes here. Runs O(files) on every content tick but the async
  // fetchEventById fires only when a nodeId is genuinely new to the timeline.
  useEffect(() => {
    if (!replay || !folder) return;
    if (replayDisplay) return;
    const last = replay.steps.length - 1;
    if (replay.index !== last) return;
    const knownIds = replayTimelineEventIds(replay.steps);
    // Discover only heads inside the focused replay subject. Directory
    // operation selection must never move this counter or slider.
    const target = focusReplayTarget(uiFocusRef.current);
    const selected = target ? [target] : [];
    const sourceByPath = new Map(
      recursiveReplaySources(
        folder.id,
        files,
        selected,
        loadLocalFolder(folder.id)?.nodeId,
      ).files.map((source) => [source.path, source]),
    );
    const fresh = freshSelectedReplayHeads(
      files,
      knownIds,
      selected,
      new Set(),
    );
    if (fresh.length === 0) return;
    let cancelled = false;
    void (async () => {
      const appended: ReplayStep[] = [];
      for (const { path, nodeId } of fresh) {
        if (cancelled) return;
        try {
          const source = sourceByPath.get(path);
          if (!source) continue;
          const event = await fetchEventById(nodeId);
          if (!event) continue;
          const meta = eventMeta(event);
          if (
            meta.folderId !== source.folderId ||
            meta.relativePath !== source.relativePath
          ) continue;
          appended.push({
            event,
            relativePath: path,
            meta,
            contentUpToHere: flatten(files[path]?.runs ?? []),
            // Live-document follow step: its runs ARE the live editor's, so the
            // latest step still shows the live per-voice attribution (these steps
            // sit on `last`, which is never frozen — only historical steps are).
            runsUpToHere: files[path]?.runs ?? [],
            // Follow steps rest on `last` and are never rendered as a frozen
            // historical frame, so their changeRange is never read for scroll-
            // into-view. null is the honest "not computed here" value.
            changeRange: null,
          });
        } catch {
          // best-effort: a failed fetch is retried on the next change tick.
        }
      }
      if (cancelled || appended.length === 0) return;
      setReplay((prev) => {
        if (!prev) return prev;
        const representedIds = replayTimelineEventIds(prev.steps);
        const next = appendReplayStepsAtLiveEnd(
          prev,
          appended.filter((step) => !representedIds.has(step.event.id)),
          (step) => step.event.id,
          (step) => step.meta.steppedAtMs,
        );
        if (next === prev) return prev;
        replayRef.current = next;
        return next;
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [files, replay, replayDisplay]); // eslint-disable-line react-hooks/exhaustive-deps
  // Bump the orchestration refresh key whenever the folder's membership set or
  // any file's nodeId changes. Those are exactly the signals that a new
  // FolderDelta (add/remove/rename/import) has landed on the folder chain and
  // been published — the node id is only written after `await backend…create/
  // writeFile` resolves, so the refetch this triggers never races the publish.
  // Focus deltas (panel mount/unmount) drain onto the *next* folder-node step,
  // which always accompanies a membership change, so they're covered too. We
  // compare only path + head identity, so editor content ticks do not refetch.
  // Unlike the old growth heuristic, head replacement, rename, and removal all
  // count: each can correspond to a newly-durable folder-chain Step.
  const prevFolderSigRef = useRef<string | null>(null);
  useEffect(() => {
    const sig = replayHeadSignature(files);
    if (sig === prevFolderSigRef.current) return;
    const initialized = prevFolderSigRef.current !== null;
    prevFolderSigRef.current = sig;
    if (!initialized) return;
    // A scope with no prior activity has no replay object yet. Its first
    // durable Step must bootstrap the timeline, not wait for a follow effect
    // that necessarily starts with `if (!replay) return`.
    if (!replayRef.current) {
      if (bootState === "ready" && folder) {
        void beginReplay().catch((error) => {
          console.warn("[replay] first live step bootstrap failed:", error);
        });
      }
      return;
    }
    setFolderReplayRefreshKey((k) => k + 1);
  }, [files]);
  // LLM ops suppress steps while streaming and release on finish; indirection
  // via a ref so the async op's finally always calls the latest closure (the
  // identity changes each render, but the op captured it at await time).
  const stepGateRef = useRef(suppressStep);
  stepGateRef.current = suppressStep;
  // Latest files snapshot for async closures (the agent loop reads/writes draft
  // FileState across multiple awaits; a ref avoids capturing a stale render).
  const filesRef = useRef<Record<string, FileState>>({});
  // Thread setFiles into the hook so stepFile can reflect stepped node ids.
  setFilesRef.current = setFiles;
  // Mirror files into a ref so async closures (the agent loop) read the latest
  // state across awaits without capturing a stale render-scope copy.
  filesRef.current = files;
  // Thread the backend's write fn into the hook so stepFile routes through the
  // right storage (disk on desktop, localStorage on webapp) instead of the
  // hardwired Tauri disk path.
  writeRef.current = (path, content, tags, signer, runs, citationIds, kedits, localOnly, force, operationId) => {
    return backendRef.current.writeFile(path, content, tags, signer, runs, undefined, citationIds, kedits, localOnly, force, operationId);
  };
  // Branch detection: rescan incoming forks / sibling heads for the active file.
  // Fires on folder switch, tab focus, foreign-flag change, and after steps that
  // advance the head (nodeId). Debounced slightly so rapid tab flips don't spam.
  const activePathForMerge = panels[activePanel]?.active ?? "";
  const activeHeadForMerge = activePathForMerge ? files[activePathForMerge]?.nodeId ?? "" : "";
  useEffect(() => {
    // Don't run branch detection while parked on a replay step — the stepper
    // focuses the replayed file, which would re-fire relay queries and pop the
    // reconcile banner over a read-only historical view. Merge detection is for
    // live editing; it re-runs when replay exits (replayActiveRef flips false).
    if (replayActiveRef.current) {
      setMergeCandidates([]);
      return;
    }
    if (!folder?.id || !activePathForMerge) {
      setMergeCandidates([]);
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      void findMergeCandidates(folder.id, activePathForMerge)
        .then((found) => {
          if (!cancelled) setMergeCandidates(found);
        })
        .catch(() => {
          if (!cancelled) setMergeCandidates([]);
        });
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [folder?.id, activePathForMerge, activeHeadForMerge]);
  // The active editor's live selection range, lifted so the SelectionMenu can
  // open anchored to its head. `{ panelIdx, from, to }` when the focused
  // panel's editor has a non-empty selection; null otherwise. Each panel's
  // FileEditor reports through onSelection (Panel → App) via setEditorSelection.
  const [editorSelection, setEditorSelection] = useState<{
    panelIdx: number;
    from: number;
    to: number;
  } | null>(null);
  // Global right-click menu. The tree (openContextMenu) and tab
  // (openTabContextMenu) surfaces stop propagation, so this handler only fires
  // for surfaces WITHOUT their own menu: the editor, modal text fields,
  // read-only <pre>, and empty chrome (NavRail/Globe/background). The native
  // browser menu is suppressed everywhere it catches; empty surfaces render no
  // menu at all. Items are plain actions + separators; the target (which CM6
  // view / textarea / pre was clicked) is captured at open time.
  const [globalCtx, setGlobalCtx] = useState<{
    x: number;
    y: number;
    items: GlobalCtxItem[];
  } | null>(null);
  const globalCtxRef = useRef<HTMLDivElement>(null);
  // Dismiss the global right-click menu on pointer-down outside or Escape —
  // same pattern as the tree/tab menus. Reuses the .ctx-menu CSS family.
  useEffect(() => {
    if (!globalCtx) return;
    function onPointerDown(e: MouseEvent) {
      if (globalCtxRef.current && !globalCtxRef.current.contains(e.target as Node)) {
        setGlobalCtx(null);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setGlobalCtx(null);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [globalCtx]);
  // Prompt context has at most one explicit mount. Effective scope is derived
  // from its folder closure minus shielded boundaries. Only tree
  // icon gestures change it; row/tab selection and playback are independent.
  const [scope, setScope] = useState<ContextMounts>(() =>
    folder ? [{ kind: "folder", path: ROOT }] : [],
  );
  // Imperative-handler mirror used by context gathering and operation dispatch.
  const scopeRef = useRef<ContextMounts>(scope);
  scopeRef.current = scope;
  // Shielded paths are persistent traversal boundaries. A shielded folder protects
  // its subtree from the active folder mount; mounting a path there replaces the
  // active root and clears the conflicting boundary.
  const [shielded, setShielded] = useState<Set<string>>(() =>
    folder ? loadLocalShielded(folder.id) : new Set(),
  );
  const shieldedRef = useRef<Set<string>>(shielded);
  shieldedRef.current = shielded;
  if (!modelOperationControllerRef.current) {
    modelOperationControllerRef.current = new ModelOperationController({
      capture: (panelIndex, modelVoicePubkey) => {
        const liveFolder = folderRef.current;
        const activePath = panelsRef.current[panelIndex]?.active ?? "";
        const liveFocus = uiFocusRef.current;
        const liveFile = filesRef.current[activePath];
        const liveAuthority = panelViews.current[panelIndex]?.state.field(
          authoringAuthorityField,
          false,
        );
        const liveBody = liveFile && liveFile.kind !== "folder"
          ? flatten(liveFile.runs)
          : "";
        const editorBody = panelViews.current[panelIndex]?.state.doc.toString();
        const exactAuthority = editorBody === liveBody ? liveAuthority?.spans ?? [] : [];
        return {
          workspaceId: liveFolder?.id ?? null,
          activePath,
          focus: liveFocus
            ? {
                kind: liveFocus.kind,
                path: liveFocus.path ?? "",
                nodeId: liveFocus.nodeId ?? null,
                panelIndex: liveFocus.panelIndex,
                tabPath: liveFocus.tabPath,
              }
            : null,
          target: liveFile && liveFile.kind !== "folder"
            ? {
                path: activePath,
                traceId: liveFile.traceId ?? null,
                headId: liveFile.nodeId || null,
                contentHash: contentFingerprint(liveBody),
                authoritySpans: exactAuthority,
              }
            : null,
          mount: scopeRef.current,
          shields: [...shieldedRef.current],
          voicePrompt: getVoicePrompt(modelVoicePubkey) ?? "",
          dirtyTarget: unsteppedPathSetRef.current.has(activePath),
          actingAuthorId: authorPubkeyRef.current,
          gatherContext: (signal) => {
            if (!liveFolder) {
              return Promise.reject(new Error("Open a workspace before running an AI operation"));
            }
            return gatherContextSnapshot(
              liveFolder,
              filesRef.current,
              scopeRef.current,
              activePath,
              shieldedRef.current,
              { signal },
            );
          },
        };
      },
      readCurrentTarget: (prepared) => {
        const liveFolder = folderRef.current;
        const liveFile = filesRef.current[prepared.targetRevision.path];
        if (!liveFolder || !liveFile || liveFile.kind === "folder") return null;
        const focus = uiFocusRef.current;
        return {
          folderId: liveFolder.id,
          path: prepared.targetRevision.path,
          traceId: liveFile.traceId ?? "",
          headId: liveFile.nodeId,
          contentHash: contentFingerprint(flatten(liveFile.runs)),
          focused: Boolean(
            focus?.kind === "file" &&
            focus.path === prepared.targetRevision.path &&
            panelsRef.current[focus.panelIndex]?.active === prepared.targetRevision.path &&
            !panelsRef.current[focus.panelIndex]?.replayOwned
          ),
        };
      },
    });
  }
  useEffect(() => {
    const lesson = modelLessonResume;
    if (!lesson) return;
    if (
      onboardingStage === "context-focus" &&
      uiFocus?.kind === "file" &&
      uiFocus.path === lesson.targetPath
    ) {
      advanceOnboarding("target-focused");
      return;
    }
    if (
      onboardingStage === "context-mount" &&
      scope[0]?.kind === "folder" &&
      scope[0].path === lesson.folderPath
    ) {
      advanceOnboarding("folder-mounted");
      return;
    }
    if (
      onboardingStage === "context-shield" &&
      shielded.has(lesson.excludedPath)
    ) {
      advanceOnboarding("note-shielded");
    }
  }, [onboardingStage, modelLessonResume, uiFocus, scope, shielded]);
  // Reset the context mount when the attached folder changes: a path into the old
  // folder's subtree is meaningless in the new one. Mounting the new root
  // restores the pre-split "scope = whole folder" behavior.
  // The shielded set reloads from the new folder's own record.
  useEffect(() => {
    setScope(folder ? [{ kind: "folder", path: ROOT }] : []);
    setShielded(folder ? loadLocalShielded(folder.id) : new Set());
    chooseDirectorySelection([]);
    commitUiFocus(null);
  }, [folder?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // The SUBSTRATE bar's currently-selected foreign substrate — the party a
  // scan reads from / a reify writes to. Persisted per-browser. Scan and reify
  // are instants against this substrate; the app has no continuous bond with it.
  const [substrate, setSubstrate] = useState<Substrate>(() => {
    const stored = localStorage.getItem(SUBSTRATE_LABEL_KEY);
    return stored && (SUBSTRATES as readonly string[]).includes(stored)
      ? (stored as Substrate)
      : "FILESYSTEM";
  });
  function chooseSubstrate(s: Substrate) {
    localStorage.setItem(SUBSTRATE_LABEL_KEY, s);
    setSubstrate(s);
  }
  // Re-bootstrap playback when focus changes. Context
  // mounts and shields intentionally do not participate in this key.
  const playbackBootRef = useRef("");
  useEffect(() => {
    const target = focusReplayTarget(uiFocus);
    const nextKey = traceRefsKey(target ? [target] : []);
    if (playbackBootRef.current === nextKey) return;
    playbackBootRef.current = nextKey;
    if (replay) endReplay();
    if (!folder || bootState !== "ready" || !target) return;
    void beginReplay().catch((e) => {
      console.warn("[replay] focus re-bootstrap failed:", e);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uiFocus]);
  // The keychain. There is no separate "active key" — the two user-facing
  // roles are the **AUTHOR** key and the **MODEL** key, each chosen in the
  // ActionPalette (the AUTHOR-row key and the MODEL-row key). Both default to the
  // first keychain key when the user hasn't picked one, and persist per-browser
  // so a chosen AUTHOR/MODEL survives reload.
  const [keys, setKeys] = useState<KeyEntry[]>(() => loadKeys());
  // The two voice roles: the **AUTHOR** key types new text and signs Save/
  // auto-save/send; the **MODEL** key runs the LLM ops (Extend/Settle/Stir/
  // Reply) and is the attribution for their streamed text. Each is an
  // independent key selection — they can overlap (same key for both) or
  // diverge. Both default to the first keychain key and persist per-browser.
  const [authorKeyId, setAuthorKeyId] = useState<string | null>(() => {
    const stored = localStorage.getItem("zine.roles.author");
    return stored && loadKeys().some((k) => k.id === stored) ? stored : loadKeys()[0]?.id ?? null;
  });
  const [modelKeyId, setModelKeyId] = useState<string | null>(() => {
    const stored = localStorage.getItem("zine.roles.model");
    return stored && loadKeys().some((k) => k.id === stored) ? stored : loadKeys()[0]?.id ?? null;
  });
  // The effective signer key id for the current substrate, for the bar's
  // pen/voice/key dropdown. If the user pinned a key, that's the id. If not but
  // a scan already auto-provisioned one, reflect *that* key's id so the dropdown
  // shows who is actually signing. Null when nothing is wired yet. Recomputed per
  // render from the store (the source of truth) so a substrate switch re-reads it.
  const substrateKeyId = (() => {
    const pinned = getSubstrateSignerKeyId(substrate);
    if (pinned) return pinned;
    const pubkey = getSubstrateBindingPubkey(substrate);
    return pubkey ? keys.find((k) => k.pubkey === pubkey)?.id ?? null : null;
  })();
  /** Pin which keychain key signs scans for the current substrate. Persisted per
   *  substrate in the external-voice store. Bumps `substrate` to re-render (the
   *  effective id above is read from the store, not React state). */
  function chooseSubstrateKey(id: string) {
    setSubstrateSignerKeyId(substrate, id);
    setSubstrate((s) => s); // force re-read of substrateKeyId
  }
  // Auto-assign the substrate voice at start (and on substrate switch) — the
  // same guarantee the AUTHOR/MODEL rows enjoy: the key cell is never empty.
  // getSubstrateVoice is idempotent (first call mints + persists the substrate's
  // key — e.g. EXTERNAL for FILESYSTEM; later calls look it up) and it respects
  // a user pin, so this never overrides a choice. Refresh the keychain state
  // afterwards so substrateKeyId (which reads React `keys`) reflects the entry.
  useEffect(() => {
    void getSubstrateVoice(substrate)
      .then(() => setKeys(loadKeys()))
      .catch((error) => console.error("[keys] could not provision substrate voice:", error));
  }, [substrate]);
  // The first keychain key's pubkey — the fallback both roles resolve to when
  // no AUTHOR/MODEL has been picked (or its key was deleted), then "author-1".
  const fallbackPubkey = keys[0]?.pubkey ?? "author-1";
  // Resolve each role's pubkey once per render. Falls back to the first
  // keychain key if the stored role id is gone (key deleted), then "author-1".
  const authorKey = keys.find((k) => k.id === authorKeyId) ?? null;
  const authorPubkey = authorKey?.pubkey ?? fallbackPubkey;
  const authorPubkeyRef = useRef(authorPubkey);
  authorPubkeyRef.current = authorPubkey;
  const modelKey = keys.find((k) => k.id === modelKeyId) ?? null;
  const modelPubkey = modelKey?.pubkey ?? fallbackPubkey;
  const modelPubkeyRef = useRef(modelPubkey);
  modelPubkeyRef.current = modelPubkey;
  // Hand the debounced auto-save a resolver for the AUTHOR key's secret, so
  // the 1500ms debounce step signs as the AUTHOR key — not a hidden active key.
  // Read at fire time (see scheduleStep), so an AUTHOR switch mid-debounce wins.
  authorSignerRef.current = () => secretKeyForVoice(authorPubkey) ?? undefined;
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  // Width of the directory sidebar, driven by the .sidebar-resizer
  // handle. Resting default 220px; persisted in localStorage on change.
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => readSidebarWidth());
  const sidebarDragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  // Persist sidebar width (debounced via storage write only on change).
  useEffect(() => {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth));
  }, [sidebarWidth]);
  // Whether per-voice text color is shown. Global (one switch for the whole
  // workspace) and orthogonal to the per-tab Preview/Markdown mode — it applies
  // to both surfaces. Default on; persisted in localStorage on change.
  const [voiceAttribution] = useState<boolean>(() => readVoiceAttribution());
  useEffect(() => {
    localStorage.setItem(VOICE_ATTRIBUTION_KEY, String(voiceAttribution));
  }, [voiceAttribution]);
  // Pointer-capture drag for the sidebar↔workspace divider. onPointerDown grabs
  // capture so subsequent move/up fire on the handle regardless of cursor
  // position; onPointerMove updates width live (clamped); onPointerUp releases.
  const onSidebarResizerPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    sidebarDragRef.current = { startX: e.clientX, startWidth: sidebarWidth };
    e.currentTarget.setPointerCapture(e.pointerId);
    document.body.classList.add("sidebar-resizing");
  };
  const onSidebarResizerPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = sidebarDragRef.current;
    if (!drag) return;
    const next = drag.startWidth + (e.clientX - drag.startX);
    setSidebarWidth(Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, Math.round(next))));
  };
  const onSidebarResizerPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!sidebarDragRef.current) return;
    sidebarDragRef.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
    document.body.classList.remove("sidebar-resizing");
  };
  const onSidebarResizerDoubleClick = () => setSidebarWidth(SIDEBAR_WIDTH_DEFAULT);
  // Panel flex weights: one per column, drives each `.panel`'s inline flexGrow.
  // Dragging a resizer between two columns transfers weight between just those
  // two neighbors (so resizing stays local regardless of column count). Persisted
  // per folder (along with the rest of the layout) via workspace-layout-store, so
  // the column split survives a reload.
  const [panelWeights, setPanelWeights] = useState<number[]>(() => [1]);
  // Persist the full workspace layout — which tabs are open in which panels, the
  // focused panel, per-tab Preview/Markdown surface, and column weights — so the
  // editor reopens exactly where the user left it. One effect over all four
  // values catches every mutation site (open/close/move tab, mode toggle, panel
  // resize, focus) without wiring a save into each setter. Gated on `ready` so
  // the initial restore in openScanned doesn't race the write, and on `folder`
  // so we never persist the pre-attach empty default. Mirrors the sidebarWidth
  // effect above (write-on-change to localStorage).
  useEffect(() => {
    if (!folder || !ready.current) return;
    // The replay panel is session-owned, not part of the user's workspace.
    // Project it out before saving while preserving live layout changes.
    const live = removeReplayPanels(panels, activePanel);
    const livePanels: PanelState[] =
      live.panels.length > 0 ? live.panels : [{ tabs: [], active: "" }];
    let liveWeights =
      live.keptIndices.length > 0
        ? live.keptIndices.map((i) => panelWeights[i] ?? 1)
        : [1];
    if (livePanels.length === 1) liveWeights = [1];
    saveWorkspaceLayout(folder.id, {
      // Strip the in-memory replay marker as an extra guard against a crashed
      // playback session leaking ephemeral columns into the next boot.
      panels: livePanels.map(({ tabs, active }) => ({ tabs, active })),
      tabModes: pruneTabModes(tabModes, livePanels),
      activePanel: live.activePanel,
      panelWeights: liveWeights,
    });
  }, [folder, panels, tabModes, activePanel, panelWeights]);
  // Flex-grow weights are relative shares: a column's pixel width is
  // weight_i / sum(allWeights) * totalWidth, so a Δx cursor move must transfer
  // Δx * sumWeights / totalWidth of weight between the two neighbors. Both
  // neighbors are anchored to their pointer-down weights and recomputed from
  // the same cumulative deltaW each move — this conserves their pair-sum
  // exactly (left + right == startLeft + startRight regardless of how many
  // move events fire), so the divider tracks the cursor 1:1 without the
  // runaway that happens if deltaW is subtracted from a value that's already
  // been reduced.
  const panelDragRef = useRef<{ startX: number; sumW: number; startLeft: number; startRight: number; width: number; gap: number } | null>(null);
  const onPanelResizerPointerDown = (e: React.PointerEvent<HTMLDivElement>, gap: number) => {
    const width = (e.currentTarget.parentElement as HTMLElement | null)?.clientWidth ?? 1;
    panelDragRef.current = {
      startX: e.clientX,
      sumW: panelWeights.reduce((a, b) => a + b, 0) || 1,
      startLeft: panelWeights[gap - 1] ?? 1,
      startRight: panelWeights[gap] ?? 1,
      width,
      gap,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
    document.body.classList.add("panel-resizing");
  };
  const onPanelResizerPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = panelDragRef.current;
    if (!drag || drag.width <= 0) return;
    const deltaW = ((e.clientX - drag.startX) * drag.sumW) / drag.width;
    setPanelWeights((prev) => {
      const next = [...prev];
      next[drag.gap - 1] = Math.max(0.05, drag.startLeft + deltaW);
      next[drag.gap] = Math.max(0.05, drag.startRight - deltaW);
      return next;
    });
  };
  const onPanelResizerPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!panelDragRef.current) return;
    panelDragRef.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
    document.body.classList.remove("panel-resizing");
  };
  const onPanelResizerDoubleClick = () => setPanelWeights((prev) => prev.map(() => 1));
  // Tab drag state: which tab is being dragged (panel + path), and where it
  // would land if dropped right now (`{ panel, path }` = "before this tab";
  // `{ panel, path: null }` = "at the end of this panel's tab list").
  // `dropTargetEdge` is a separate intent: dropping on a panel's right edge
  // inserts a brand-new column to that panel's right (rather than reordering
  // tabs within an existing list).
  const [draggingTab, setDraggingTab] = useState<{ fromPanel: number; path: string } | null>(null);
  const [dropTargetTab, setDropTargetTab] = useState<{ panel: number; path: string | null } | null>(null);
  const [dropTargetEdge, setDropTargetEdge] = useState<{ afterPanel: number } | null>(null);
  // Right-click context menu on a tab. Anchored at the cursor; the menu JSX is
  // rendered (portalled to document.body) once the panels map closes. Carries
  // the panel + path so Close/Close Others/Close to the Right know which tab
  // column to act on.
  const [tabCtxMenu, setTabCtxMenu] = useState<{
    x: number;
    y: number;
    panel: number;
    path: string;
  } | null>(null);
  const tabCtxMenuRef = useRef<HTMLDivElement>(null);
  const [emptyFolders, setEmptyFolders] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState<Creating | null>(null);
  // Validation message for the create-row input (e.g. an invalid folder name).
  // Set when createCommit rejects; cleared on a fresh create attempt or cancel.
  const [createError, setCreateError] = useState<string | null>(null);
  const [activeView, setActiveView] = useState<View>(() =>
    typeof window !== "undefined" && aboutHashTarget(window.location.hash)
      ? "about"
      : "editor",
  );
  function selectView(view: View) {
    if (view !== "about" && aboutHashTarget(window.location.hash)) {
      const url = new URL(window.location.href);
      url.hash = "";
      window.history.replaceState(null, "", url);
    }
    setActiveView(view);
  }
  const [sendFailure, setSendFailure] = useState<ReturnType<typeof describeSendFailure> | null>(null);
  const [mintConsentRequest, setMintConsentRequest] = useState<MintConsentRequest | null>(null);
  const mintConsentRequestRef = useRef<MintConsentRequest | null>(null);
  const [mintRecoveryNotice, setMintRecoveryNotice] = useState<MintRecoveryNotice | null>(null);
  const [mintRecoveryBusy, setMintRecoveryBusy] = useState(false);
  const [mintRecoveryEpoch, setMintRecoveryEpoch] = useState(0);
  const activeMintRecoveriesRef = useRef(createCoinMintRecoverySessionRegistry());

  function finishMintConsent(confirmed: boolean): void {
    const request = mintConsentRequestRef.current;
    if (!request) return;
    mintConsentRequestRef.current = null;
    setMintConsentRequest(null);
    request.resolve(confirmed);
  }

  function requestMintConsent(phrase: string): Promise<boolean> {
    if (mintConsentRequestRef.current) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const request = { phrase, resolve };
      mintConsentRequestRef.current = request;
      setMintConsentRequest(request);
    });
  }

  useEffect(() => {
    const request = mintConsentRequestRef.current;
    if (!request) return;
    mintConsentRequestRef.current = null;
    setMintConsentRequest(null);
    request.resolve(false);
  }, [coinsEnabled, folder?.id]);

  const [socialQuery, setSocialQuery] = useState<SocialQuery>(() => loadSocialQuery());
  useEffect(() => {
    saveSocialQuery(socialQuery);
  }, [socialQuery]);
  const [theme, setTheme] = useState<Theme>(() => readTheme());
  const [directorySort, setDirectorySort] = useState<DirectorySortOrder>(() =>
    loadDirectorySort(),
  );
  useEffect(() => {
    saveDirectorySort(directorySort);
  }, [directorySort]);
  const [railExpanded, setRailExpanded] = useState<boolean>(() => readRailExpanded());
  // Persist the nav rail's expanded/collapsed state across reloads.
  useEffect(() => {
    localStorage.setItem(RAIL_EXPANDED_KEY, String(railExpanded));
  }, [railExpanded]);

  // --- sampler state ---------------------------------------------------
  // Defaults mix the local sidecar (where the app's own 4290 trace nodes live)
  // with a couple of well-known general relays. Note: the draft trace kind
  // (4290) is unpublished, so public relays return nothing for it until zine
  // relays exist — switch the kind to 1 (text notes) to see the sampler pull
  // live federated events.
  const [samplerOpen, setSamplerOpen] = useState(false);
  // When non-null, the sampler writes sampled files under this folder relpath
  // instead of the attached folder's root. Set by a folder tab's "Sample into
  // this folder" button; null (root) is the sidebar-telescope default.
  const [samplerTarget, setSamplerTarget] = useState<string | null>(null);
  const [samplerUrls, setSamplerUrls] = useState(
    "ws://127.0.0.1:4869\nwss://relay.damus.io\nwss://nos.lol",
  );
  // Comma-separated kind list. Default is the draft trace kind (4290); add more
  // (e.g. "4290, 1") to sample several at once. Parsed to number[] in runSample.
  const [samplerKinds, setSamplerKinds] = useState("4290");
  const [samplerLimit, setSamplerLimit] = useState(50);
  // Optional filter bounds. Empty string leaves the field off the filter, so
  // the default (no time window, no search) is unchanged.
  const [samplerSince, setSamplerSince] = useState("");
  const [samplerUntil, setSamplerUntil] = useState("");
  const [samplerSearch, setSamplerSearch] = useState("");
  const [samplerStatus, setSamplerStatus] = useState<{
    state: "idle" | "sampling" | "done" | "error";
    msg?: string;
    count?: number;
  }>({ state: "idle" });

  // --- tag browser state ---------------------------------------------------
  // A tag always names a zine (protocol §Tagging vs. bracketing). Shares the
  // relay list with the sampler (samplerUrls) rather than duplicating it.
  const [tagBrowserOpen, setTagBrowserOpen] = useState(false);
  const [tagBrowserName, setTagBrowserName] = useState("");
  const [tagBrowserCandidates, setTagBrowserCandidates] = useState<TagCandidate[] | null>(null);
  const [tagBrowserSelected, setTagBrowserSelected] = useState<TagCandidate | null>(null);
  const [tagBrowserStatus, setTagBrowserStatus] = useState<{
    state: "idle" | "resolving" | "browsing" | "done" | "error";
    msg?: string;
    count?: number;
  }>({ state: "idle" });

  // --- palette state ----------------------------------------------------
  // The active editor view (lifted via FileEditor's onView) so the palette's
  // "insert citation" can dispatch into the focused CM6 doc directly. Held in
  // a ref rather than state because it's an imperative handle, not render data.
  const activeEditorView = useRef<EditorView | null>(null);
  // Every panel's editor view, indexed by panel — so a panel's Summon can
  // dispatch into its own CM6 doc regardless of which panel is focused.
  const panelViews = useRef<(EditorView | null)[]>([null]);
  // Per-panel Summon status only — the per-panel AUTHOR concept is gone (one
  // global active key drives both signing and editor attribution), so there's
  // no per-panel voice array to keep in sync anymore.
  const [summonStatus, setSummonStatus] = useState<SummonStatus[]>([{ state: "idle" }]);
  // Panel flash on a deliberate Step/Send step — a brief gold pulse on the
  // panel whose file was checkpointed, mirroring the agent-write flash. Cleared
  // by the CSS animation (1.4s) via a timeout; null = no panel flashing.
  const [flashPanel, setFlashPanel] = useState<number | null>(null);
  const flashPanelRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Pulse the panel flash for a successful deliberate step. Re-arming re-triggers
   *  the CSS animation (clearing then setting the class next tick) so two quick
   *  Steps both flash. The 1.4s clear matches the animation duration. */
  function flashPanelFn(idx: number) {
    if (flashPanelRef.current) clearTimeout(flashPanelRef.current);
    setFlashPanel(null);
    // Defer one frame so React commits the null (clearing the class) before
    // re-setting it — otherwise the class never toggles off and the animation
    // doesn't re-fire on a rapid second Step.
    requestAnimationFrame(() => {
      setFlashPanel(idx);
      flashPanelRef.current = setTimeout(() => setFlashPanel(null), 1400);
    });
  }
  const summonAbort = useRef<(AbortController | null)[]>([null]);
  // Per-panel operation contexts retain each target path and trace-owner signer
  // until the ref-counted gate releases every concurrently streaming panel.
  const opContextsRef = useRef<Map<number, { path: string; signer?: Uint8Array }>>(new Map());
  const activeOpPathsRef = useRef<Set<string>>(new Set());
  // When the active panel changes, point the palette's editor handle at the
  // newly-active panel's view. (onView only fires on mount/unmount, so without
  // this the palette would keep targeting the previously-active panel's editor
  // until a file switch forced a remount.)
  useEffect(() => {
    activeEditorView.current = panelViews.current[activePanel] ?? null;
  }, [activePanel]);
  // voiceProviderTick bumps after the MODEL voice's provider pin changes
  // (written to the localStorage-backed voice-provider-store). It re-renders
  // App so resolvedModelProviderId re-derives and flows down to ActionPalette as a
  // prop — mirroring how a substrate switch re-derives substrateKeyId.
  const [voiceProviderTick, setVoiceProviderTick] = useState(0);
  // Bumped when folder membership or a file head advances. The folder replay
  // follow effect uses it to discover newly published structural steps while
  // parked at the live end of the unified ReplayTransport timeline.
  const [folderReplayRefreshKey, setFolderReplayRefreshKey] = useState(0);
  const folderReplayRefreshSeenRef = useRef(0);

  // Follow-newest for selected folder traces. Re-running the same genesis-rooted
  // loader keeps initial selection and live refresh semantics identical,
  // including nested folder selections and one-real-node-per-Step numbering.
  useEffect(() => {
    if (!replay || !folder) return;
    if (replayDisplay) return;
    if (folderReplayRefreshKey === 0) return; // never bumped yet
    const last = replay.steps.length - 1;
    if (replay.index !== last) return;
    if (folderReplayRefreshSeenRef.current === folderReplayRefreshKey) return;
    folderReplayRefreshSeenRef.current = folderReplayRefreshKey;
    void beginReplay().catch((error) => {
      console.warn("[replay] selected trace refresh failed:", error);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folderReplayRefreshKey, replay, replayDisplay, folder?.id]);

  /** Wrap the active editor's current selection in `[[ ]]` (pending). The menu's
   *  bracket action and Cmd/Ctrl+S-over-a-selection both call this. Pure wrap —
   *  no publish. Protection from overwrite is immediate via bracketProtect; a
   *  bracket stays pending until send mints it. */
  function wrapSelection(view: EditorView): boolean {
    return wrapSelectionCommand()(view);
  }

  /** Flush the editor's current document to the home relay now. Ordinary edits
   *  remain debounced, but minting needs a signed source id before it can emit
   *  `extracted-from`, and a signed container id after resolving the bracket so
   *  its `q` citation is not left pending behind a temporary empty node id. */
  async function flushEditorLocally(
    path: string,
    view: EditorView,
    signer?: Uint8Array,
    operationId?: string,
    publicationFence?: PublicationFence,
  ): Promise<string> {
    assertPublicationFence(publicationFence);
    const file = filesRef.current[path] ?? files[path];
    if (!file) throw new Error(`Cannot step missing source trace ${path}.`);
    const content = view.state.doc.toString();
    if (
      file.nodeId &&
      !unsteppedPathSet.has(path) &&
      flatten(file.runs) === content
    ) {
      return file.nodeId;
    }
    // Non-throwing field read: a live CodeMirror view can briefly retain the
    // pre-HMR StateField identity (the same case FileEditor guards throughout
    // its sync/decorations path). Prefer its live runs, then React's mirrored
    // runs when they cover this exact buffer, and finally preserve integrity by
    // attributing the whole current snapshot to the active author.
    const liveRuns = view.state.field(voiceField, false);
    const runs = liveRuns && flatten(liveRuns) === content
      ? liveRuns
      : flatten(file.runs) === content
        ? file.runs
        : [{ voice: authorPubkey, text: content }];
    const citationIds = file.citationIds ?? [];
    const steppedKedits = view.state.field(keditField, false) ?? file.kedits ?? EMPTY_KEDIT_LOG;
    const kedits = keditLogToArray(steppedKedits);
    const nodeId = await backendRef.current.writeFile(
      path,
      content,
      file.tags,
      signer,
      runs,
      undefined,
      citationIds.length > 0 ? citationIds : undefined,
      kedits.length > 0 ? kedits : undefined,
      true,
      undefined,
      operationId,
      publicationFence,
    );
    assertPublicationFence(publicationFence);
    if (!nodeId) throw new Error(`The local source trace ${path} did not produce a node id.`);
    const traceId = await resolvePostWriteTraceId({
      nodeId,
      priorTraceId: file.traceId ?? null,
      readPersistedTraceId: () => folder
        ? loadLocalFolder(folder.id)?.files[path]?.traceId
        : null,
      resolveTraceIdentity,
    });
    assertPublicationFence(publicationFence);
    seedSteppedRef.current({
      [path]: { ...file, runs, nodeId, ...(traceId ? { traceId } : {}) },
    });
    const latest = filesRef.current[path];
    const latestRemaining = latest
      ? dropKEditLogPrefix(latest.kedits ?? EMPTY_KEDIT_LOG, steppedKedits)
      : EMPTY_KEDIT_LOG;
    const latestCitations = latest?.citationIds ?? [];
    const hasNewerBuffer = Boolean(latest) && (
      latestRemaining.length > 0 ||
      flatten(latest.runs) !== content ||
      latest.tags.length !== file.tags.length ||
      latest.tags.some((tag, index) => tag !== file.tags[index]) ||
      latestCitations.length !== citationIds.length ||
      latestCitations.some((id, index) => id !== citationIds[index])
    );
    if (folder && latest && hasNewerBuffer) {
      mirrorPad(folder.id, path, {
        content: flatten(latest.runs),
        tags: latest.tags,
        nodeId,
        ...(traceId ? { traceId } : {}),
        runs: latest.runs,
        citationIds: latest.citationIds,
        kedits: keditLogToArray(latestRemaining),
      });
    } else if (folder) {
      clearPadPath(folder.id, path);
    }
    setFiles((prev) => {
      const current = prev[path];
      if (!current) return prev;
      // Mint/Step may wait on a relay while the author keeps typing. Advance
      // only the stepped nucleus and drain exactly the KEdit prefix captured
      // above; never overwrite newer runs with the source snapshot.
      const remaining = dropKEditLogPrefix(current.kedits ?? EMPTY_KEDIT_LOG, steppedKedits);
      const { kedits: _stepped, ...rest } = current;
      return {
        ...prev,
        [path]: {
          ...rest,
          nodeId,
          ...(traceId ? { traceId } : {}),
          ...(remaining.length > 0 ? { kedits: remaining } : {}),
        },
      };
    });
    return nodeId;
  }

  async function finalizeStoredMintSource(
    record: PendingCoinMint,
    signer: Uint8Array,
    lease: {
      generation: number;
      folderId: string | null;
      workspace: Workspace;
      signal?: AbortSignal;
    } = {
      generation: vaultStorageGeneration(),
      folderId: folderIdRef.current,
      workspace: backendRef.current,
    },
  ): Promise<string> {
    const assertLease = () => {
      if (
        lease.signal?.aborted ||
        vaultStorageGeneration() !== lease.generation ||
        folderIdRef.current !== lease.folderId ||
        backendRef.current !== lease.workspace ||
        record.sourceFolderId !== lease.folderId
      ) {
        const reason = lease.signal?.reason;
        const error = reason instanceof Error
          ? reason
          : new Error("Mint source recovery no longer owns the active vault workspace");
        error.name = "AbortError";
        throw error;
      }
    };
    assertLease();
    const source = record.sourceFinalization;
    if (!source) throw new Error("cannot finalize a direct Mint source");
    if (folderIdRef.current !== record.sourceFolderId) {
      throw new Error(`cannot finalize Mint source outside its attached press: ${source.relativePath}`);
    }
    const localFile = loadLocalFolder(record.sourceFolderId)?.files[source.relativePath];
    const liveFile = filesRef.current[source.relativePath];
    const currentText = liveFile ? flatten(liveFile.runs) : localFile?.content;
    if (currentText === undefined) {
      throw new Error(`cannot finalize missing Mint source ${source.relativePath}`);
    }
    const capturedSourceEvent = await fetchEventById(source.sourceNodeId);
    assertLease();
    const capturedSourceText = capturedSourceEvent
      ? await verifiedFileSourceSnapshot(capturedSourceEvent, source.sourceNodeId)
      : null;
    assertLease();
    if (
      capturedSourceText === null ||
      await sha256HexLocal(capturedSourceText) !== source.sourceContentHash
    ) {
      throw new Error(`cannot verify captured Mint source ${source.relativePath}`);
    }
    assertLease();
    // Journal ranges may already sit in post-rebase live space after an
    // earlier same-source Mint completed. Prefer that space when the capture
    // no longer hosts the recorded bracket; otherwise translate concurrent
    // edits from the verified capture.
    const nextText = resolvedFinalizedCoinMintSourceText(
      record,
      capturedSourceText,
      currentText,
    );
    const currentNodeId = liveFile?.nodeId ?? localFile?.nodeId ?? "";
    if (nextText === currentText && currentNodeId) {
      const currentNode = await fetchEventById(currentNodeId);
      assertLease();
      if (currentNode && eventMeta(currentNode).citationTargets.includes(record.coin.id)) {
        return currentNode.id;
      }
    }
    const sourceRuns = liveFile?.runs && flatten(liveFile.runs) === currentText
      ? liveFile.runs
      : localFile?.runs && flatten(localFile.runs) === currentText
        ? localFile.runs
        : [{ voice: record.coin.pubkey, text: currentText }];
    const nextRuns = reconcileRunsText(sourceRuns, nextText, getPublicKey(signer));
    const sourceTags = liveFile?.tags ?? localFile?.tags ?? [];
    const citationIds = liveFile?.citationIds ?? localFile?.citationIds;
    const steppedKedits = liveFile?.kedits ?? EMPTY_KEDIT_LOG;
    const sourceStepKedits = finalizedCoinMintSourceStepKEdits(
      currentText,
      nextText,
      steppedKedits,
      getPublicKey(signer),
    );
    assertLease();
    const nodeId = await lease.workspace.writeFile(
      source.relativePath,
      nextText,
      sourceTags,
      signer,
      nextRuns,
      undefined,
      citationIds,
      sourceStepKedits,
      true,
      nextText === currentText,
      operationIdFromNode(record.coin),
      { signal: lease.signal, enabled: () => {
        try {
          assertLease();
          return true;
        } catch {
          return false;
        }
      } },
    );
    assertLease();
    if (!nodeId) throw new Error(`Mint source ${source.relativePath} did not produce a citation Step`);
    const currentFile = filesRef.current[source.relativePath] ?? liveFile ?? {
      runs: nextRuns,
      nodeId,
      tags: sourceTags,
      ...(citationIds ? { citationIds } : {}),
    };
    const concurrentKedits = dropKEditLogPrefix(
      currentFile.kedits ?? EMPTY_KEDIT_LOG,
      steppedKedits,
    );
    const nextFile = rebaseFinalizedCoinMintSourceFile(
      record,
      currentFile,
      currentText,
      nextText,
      nodeId,
      getPublicKey(signer),
      keditLogToArray(concurrentKedits),
    );
    assertLease();
    if (nextFile.kedits && nextFile.kedits.length > 0) {
      mirrorPad(record.sourceFolderId, source.relativePath, {
        content: flatten(nextFile.runs),
        tags: nextFile.tags,
        nodeId,
        ...(nextFile.traceId ? { traceId: nextFile.traceId } : {}),
        runs: nextFile.runs,
        citationIds: nextFile.citationIds,
        kedits: keditLogToArray(nextFile.kedits),
      });
    } else {
      clearPadPath(record.sourceFolderId, source.relativePath);
    }
    assertLease();
    filesRef.current = { ...filesRef.current, [source.relativePath]: nextFile };
    assertLease();
    setFiles((prev) => ({ ...prev, [source.relativePath]: nextFile }));
    return nodeId;
  }

  /** Strike one immutable Coin. Extracted Mints include a fourth durable phase
   * that resolves and Steps the source citation before the journal can clear. */
  function coinMintCompletionFor(
    signer: Uint8Array,
    finalizeSource?: (
      record: PendingCoinMint,
      publicationFence: PublicationFence,
    ) => Promise<string>,
    publicationSignal?: AbortSignal,
  ) {
    const generation = vaultStorageGeneration();
    const folderId = folderIdRef.current;
    const workspace = backendRef.current;
    const assertLease = () => {
      if (
        vaultStorageSessionAcceptsWork() &&
        vaultStorageGeneration() === generation &&
        folderIdRef.current === folderId &&
        backendRef.current === workspace
      ) return;
      const error = new Error("vault session changed during Mint completion");
      error.name = "AbortError";
      throw error;
    };
    const publicationFence: PublicationFence = {
      signal: publicationSignal,
      enabled: () => {
        try {
          assertLease();
          return kademliaEnabledSnapshot();
        } catch {
          return false;
        }
      },
    };
    const finalize = finalizeSource ?? ((record: PendingCoinMint) =>
      finalizeStoredMintSource(record, signer, {
        generation,
        folderId,
        workspace,
        signal: publicationSignal,
      }));
    return {
      publishPair: (coin: Event) => completeCoinMint(coin, signer, publicationFence),
      serializeAttestation: (attestation: Event) => attestation,
      restoreAttestation: storedCoinMintAttestation,
      persistMembership: async (record: PendingCoinMint) => {
        assertPublicationFence(publicationFence);
        const parsed = JSON.parse(record.coin.content) as { contentHash?: string };
        await upsertManifestEntry(
          record.mintFolderId,
          {
            kind: "file",
            relativePath: record.memberName,
            latestNodeId: record.coin.id,
            contentHash: parsed.contentHash ?? "",
          },
          signer,
          {
            localOnly: true,
            operationId: operationIdFromNode(record.coin),
            publicationFence,
          },
        );
        assertPublicationFence(publicationFence);
      },
      persistLocal: (record: PendingCoinMint) => {
        assertPublicationFence(publicationFence);
        const runs: Run[] = [{ voice: record.coin.pubkey, text: record.phrase }];
        const persisted = saveLocalFile(record.sourceFolderId, record.localPath, {
          content: record.phrase,
          tags: [],
          nodeId: record.coin.id,
          runs,
          voicePubkey: record.coin.pubkey,
          coinComplete: true,
        });
        if (!persisted) {
          throw new Error("Mint is public but its local inventory could not be persisted");
        }
        assertPublicationFence(publicationFence);
        seedSteppedRef.current({
          [record.localPath]: { runs, nodeId: record.coin.id, tags: [], coinComplete: true },
        });
        if (folderIdRef.current === record.sourceFolderId) {
          assertPublicationFence(publicationFence);
          const nextFile = { runs, nodeId: record.coin.id, tags: [], coinComplete: true };
          // Keep the allocator's imperative snapshot authoritative immediately;
          // React commits on a later turn and cannot be the reservation barrier.
          filesRef.current = { ...filesRef.current, [record.localPath]: nextFile };
          setFiles((prev) => ({ ...prev, [record.localPath]: nextFile }));
        }
      },
      finalizeSource: async (record: PendingCoinMint) => {
        assertPublicationFence(publicationFence);
        const nodeId = await finalize(record, publicationFence);
        assertPublicationFence(publicationFence);
        return nodeId;
      },
    };
  }

  function refreshMintRecoveryNotice(
    failures: readonly string[] = [],
    startError?: string,
  ): void {
    const sourceFolderId = folderIdRef.current;
    const pending = sourceFolderId
      ? pendingCoinMints().filter((record) => record.sourceFolderId === sourceFolderId).length
      : 0;
    const uniqueFailures = [...new Set(failures.filter(Boolean))];
    setMintRecoveryNotice(
      pending > 0 || uniqueFailures.length > 0 || startError
        ? { pending, failures: uniqueFailures, ...(startError ? { startError } : {}) }
        : null,
    );
  }

  /** Retry every durable Mint whose signing key remains in this press. Stored
   * path/source metadata makes recovery independent of the editor selection
   * that originally created the Coin. */
  async function recoverPendingCoinMints(
    exceptOperationKey?: string,
    publicationSignal?: AbortSignal,
  ) {
    const generation = vaultStorageGeneration();
    const sourceFolderId = folderIdRef.current;
    const workspace = backendRef.current;
    const result = await resumePendingCoinMints((pending) => {
      const signer = secretKeyForVoice(pending.coin.pubkey);
      if (!signer) {
        throw new Error(`the Coin signer ${formatPubkey(pending.coin.pubkey)} is unavailable`);
      }
      return coinMintCompletionFor(
        signer,
        (record) => finalizeStoredMintSource(record, signer, {
          generation,
          folderId: sourceFolderId,
          workspace,
          signal: publicationSignal,
        }),
        publicationSignal,
      );
    }, vaultStorage, (pending) =>
      pending.sourceFolderId === sourceFolderId &&
      (!exceptOperationKey || pending.operationKey !== exceptOperationKey),
    );
    if (publicationSignal?.aborted) {
      refreshMintRecoveryNotice();
      return {
        ...result,
        remaining: pendingCoinMints().filter(
          (pending) => pending.sourceFolderId === sourceFolderId,
        ).length,
      };
    }
    if (result.failures.length > 0) {
      console.warn("[mint] pending Mint recovery remains incomplete:", result.failures);
    }
    refreshMintRecoveryNotice(result.failures.map((failure) => failure.error));
    return {
      ...result,
      remaining: pendingCoinMints().filter(
        (pending) => pending.sourceFolderId === sourceFolderId,
      ).length,
    };
  }

  // Recovery is a workspace-start phase, not a side effect of the next Mint.
  // Include the available signer set so importing a missing key creates one
  // fresh recovery opportunity without replaying on ordinary React renders.
  useEffect(() => {
    if (bootState !== "ready" || !folder) {
      setMintRecoveryNotice(null);
      setMintRecoveryBusy(false);
      return;
    }
    refreshMintRecoveryNotice();
    if (!coinsEnabled) {
      setMintRecoveryBusy(false);
      return;
    }
    const generation = vaultStorageGeneration();
    const keyFingerprint = keys.map((key) => key.pubkey).sort().join(",");
    const session = `${generation}:${folder.id}:${keyFingerprint}`;
    const recovery = activeMintRecoveriesRef.current.acquire(session, async (signal) => {
      await retryCoinMintRecovery(
        async () => {
          if (vaultStorageGeneration() === generation && folderIdRef.current === folder.id) {
            setMintRecoveryBusy(true);
          }
          try {
            return await recoverPendingCoinMints(undefined, signal);
          } finally {
            if (vaultStorageGeneration() === generation && folderIdRef.current === folder.id) {
              setMintRecoveryBusy(false);
            }
          }
        },
        waitForMintRecoveryRetry,
        signal,
        (error) => {
          if (vaultStorageGeneration() !== generation || folderIdRef.current !== folder.id) return;
          const message = error instanceof Error ? error.message : String(error);
          console.warn("[mint] startup recovery failed:", error);
          refreshMintRecoveryNotice([], message);
        },
      );
    });
    void recovery.promise;
    return recovery.release;
  }, [bootState, coinsEnabled, folder?.id, keys, mintRecoveryEpoch]);

  function captureForegroundMintLease(sourceFolderId: string): ForegroundMintLease {
    const generation = vaultStorageGeneration();
    const workspace = backendRef.current;
    const controller = new AbortController();
    const abortIfInvalid = () => {
      if (
        vaultStorageSessionAcceptsWork() &&
        vaultStorageGeneration() === generation &&
        folderIdRef.current === sourceFolderId &&
        backendRef.current === workspace &&
        kademliaEnabledSnapshot()
      ) return;
      const error = new Error("vault session or Coins configuration changed during foreground Mint");
      error.name = "AbortError";
      controller.abort(error);
    };
    const unsubscribeVault = subscribeVaultStorage(abortIfInvalid);
    const unsubscribeConfig = subscribeKademliaConfig(abortIfInvalid);
    abortIfInvalid();
    const fence: PublicationFence = {
      signal: controller.signal,
      enabled: () =>
        !controller.signal.aborted &&
        vaultStorageSessionAcceptsWork() &&
        vaultStorageGeneration() === generation &&
        folderIdRef.current === sourceFolderId &&
        backendRef.current === workspace &&
        kademliaEnabledSnapshot(),
    };
    let released = false;
    return {
      sourceFolderId,
      generation,
      workspace,
      controller,
      fence,
      release() {
        if (released) return;
        released = true;
        unsubscribeVault();
        unsubscribeConfig();
      },
    };
  }

  async function mintCoinTrace(
    phrase: string,
    origin: CoinOrigin,
    signer?: Uint8Array,
    kedits?: KEdit[],
    sourceCompletion?: {
      metadata: CoinMintSourceFinalization;
      finalize: (
        record: PendingCoinMint,
        publicationFence: PublicationFence,
      ) => Promise<string>;
    },
    capturedLease?: ForegroundMintLease,
  ): Promise<{ path: string; nodeId: string; attestationId: string; runs: Run[] }> {
    if (!kademliaEnabledSnapshot()) {
      throw new Error("Enable Coins in Networking before minting a Coin.");
    }
    if (!folder) throw new Error("Cannot mint a coin without an attached press.");
    const ownsLease = capturedLease === undefined;
    const mintLease = capturedLease ?? captureForegroundMintLease(folder.id);
    const sourceFolderId = mintLease.sourceFolderId;
    const publicationController = mintLease.controller;
    const foregroundPublicationFence = mintLease.fence;
    if (sourceFolderId !== folder.id || publicationController.signal.aborted) {
      if (ownsLease) mintLease.release();
      throw publicationController.signal.reason ?? new Error("foreground Mint lease is stale");
    }
    try {
      const coinVoice = signer ? getPublicKey(signer) : authorPubkey;
      const mintSigner = signer ?? secretKeyForVoice(coinVoice);
      if (!mintSigner) throw new Error(`no key for voice ${formatPubkey(coinVoice)}`);
      const operationKey = coinMintOperationKey({
        sourceFolderId,
        signerPubkey: coinVoice,
        phrase,
        origin,
      });
      // Complete abandoned gestures directly from their stored records before a
      // new one consumes journal capacity. Exclude this gesture so its retry
      // returns the original exact Coin to the caller instead of completing it
      // invisibly and then creating a sibling.
      await recoverPendingCoinMints(operationKey, publicationController.signal);
      assertPublicationFence(foregroundPublicationFence);
      if (sourceCompletion) {
        // Recovery may itself Step this source and shift every later UTF-16
        // range. Revalidate the exact node, bytes, and target after recovery and
        // before signing or publishing a new Coin pair.
        const source = sourceCompletion.metadata;
        const localFile = loadLocalFolder(sourceFolderId)?.files[source.relativePath];
        const liveFile = filesRef.current[source.relativePath];
        const currentText = liveFile ? flatten(liveFile.runs) : localFile?.content;
        const currentNodeId = liveFile?.nodeId ?? localFile?.nodeId ?? "";
        if (currentText === undefined || currentNodeId !== source.sourceNodeId) {
          throw new Error(
            `Mint source ${source.relativePath} changed while pending Mints were recovered; select it again`,
          );
        }
        if (await sha256HexLocal(currentText) !== source.sourceContentHash) {
          throw new Error(
            `Mint source ${source.relativePath} no longer matches its captured snapshot; select it again`,
          );
        }
        const targetStillMatches = source.kind === "pending-bracket"
          ? findPendingBrackets(currentText).some((bracket) =>
              bracket.matchStart === source.bracketRange.start &&
              bracket.matchEnd === source.bracketRange.end &&
              bracket.phraseStart === source.range.start &&
              bracket.phraseEnd === source.range.end &&
              bracket.phrase === phrase
            )
          : currentText.slice(source.range.start, source.range.end) === phrase;
        if (!targetStillMatches) {
          throw new Error(
            `Mint source ${source.relativePath} selection moved while pending Mints were recovered; select it again`,
          );
        }
      }
      const pending = await preparePendingCoinMint(operationKey, async () => {
        assertPublicationFence(foregroundPublicationFence);
        const operationId = createTraceOperationId();
        const taken = new Set([
          ...Object.keys(filesRef.current),
          ...Object.keys(loadLocalFolder(sourceFolderId)?.files ?? {}),
          ...pendingPaths.current,
          ...pendingCoinMints()
            .filter((record) => record.sourceFolderId === sourceFolderId)
            .map((record) => record.localPath),
        ]);
        const localPath = mintedPath(phrase, new Date(), taken, operationId);
        const mintFolderId = await getOrCreateMintFolder(
          sourceFolderId,
          mintSigner,
          foregroundPublicationFence,
        );
        assertPublicationFence(foregroundPublicationFence);
        const memberName = localPath.slice(`${MINT}/`.length);
        const coin = origin.kind === "direct"
          ? await publishDirectCoin({
              folderId: mintFolderId,
              relativePath: memberName,
              phrase,
              signer: mintSigner,
              kedits,
              prepareOnly: true,
              operationId,
            })
          : await publishHardenedSpan({
              folderId: mintFolderId,
              relativePath: memberName,
              phrase,
              originNodeId: origin.sourceNodeId,
              sourceContentHash: origin.sourceContentHash,
              sourceRange: origin.range,
              signer: mintSigner,
              prepareOnly: true,
              operationId,
            });
        return {
          sourceFolderId,
          mintFolderId,
          localPath,
          memberName,
          phrase,
          coin,
          ...(sourceCompletion ? { sourceFinalization: sourceCompletion.metadata } : {}),
        };
      });
      pendingPaths.current.add(pending.localPath);
      try {
        // The transaction journal retains this exact signed Coin through every
        // public and local phase. A retry resumes it instead of minting a sibling.
        const receipt = await completePendingCoinMintTransaction(
          pending,
          coinMintCompletionFor(
            mintSigner,
            sourceCompletion?.finalize,
            publicationController.signal,
          ),
        );
        const runs: Run[] = [{ voice: pending.coin.pubkey, text: pending.phrase }];
        return {
          path: pending.localPath,
          nodeId: pending.coin.id,
          attestationId: receipt.attestation.id,
          runs,
        };
      } catch (error) {
        refreshMintRecoveryNotice([
          error instanceof Error ? error.message : String(error),
        ]);
        if (pendingCoinMints().some((record) => record.operationKey === operationKey)) {
          // Startup may have found an empty journal and settled already. Wake a
          // fresh vault/folder-scoped supervisor for work created by this failed
          // foreground gesture; its timer and online trigger own later retries.
          setMintRecoveryEpoch((epoch) => epoch + 1);
        }
        throw error;
      } finally {
        pendingPaths.current.delete(pending.localPath);
        if (!pendingCoinMints().some((record) => record.operationKey === operationKey)) {
          refreshMintRecoveryNotice();
        }
      }
    } finally {
      if (ownsLease) mintLease.release();
    }
  }

  /** Mint the text entered in the Mint header composer without claiming that
   * it was extracted from another trace, then open the immutable result. */
  async function mintDirectCoin(phrase: string, kedits: KEdit[]): Promise<void> {
    setDirectCoinBusy(true);
    setDirectCoinError(null);
    const signer = secretKeyForVoice(authorPubkey) ?? undefined;
    try {
      const coin = await mintCoinTrace(phrase, { kind: "direct" }, signer, kedits);
      setEditorSelection(null);
      const composerPanel = panelsRef.current.findIndex((panel) =>
        panel.tabs.includes(DIRECT_COIN_COMPOSER_TAB),
      );
      const focusPanel = composerPanel >= 0 ? composerPanel : Math.min(activePanel, panels.length - 1);
      replaceDirectCoinComposerTab(coin.path);
      chooseDirectorySelection([]);
      commitUiFocus(locateFocus(
        { kind: "coin", path: coin.path, nodeId: coin.nodeId, phrase },
        focusPanel,
        coin.path,
      ));
      setDirectCoinDraft(emptyDirectCoinDraft());
    } catch (error) {
      setDirectCoinError(error instanceof Error ? error.message : String(error));
    } finally {
      setDirectCoinBusy(false);
    }
  }

  /** Mint a selection as a named, immutable trace in the dedicated Mint folder,
   *  publishing and attesting it as part of the same gesture, then resolve the
   *  source bracket to cite it.
   *
   *  `from`/`to` are the current selection in `view`. If the selection is
   *  already inside a pending `[[ phrase ]]`, that phrase is used as-is;
   *  otherwise the selection is wrapped first and the just-wrapped phrase is
   *  used. The new Coin opens in a read-only tab. */
  async function zinePhrase(
    path: string,
    view: EditorView,
    from: number,
    to: number,
    stepSigner?: Uint8Array,
  ): Promise<boolean> {
    if (!kademliaEnabledSnapshot()) return false;
    if (!folder || isMint(path) || isScan(path) || isOblivion(path)) return false;
    // Step mints either a loose-text highlight or the entire unresolved bracket
    // containing the selection. Resolved/cross-boundary selections are not new
    // mint targets.
    const docText = view.state.doc.toString();
    const targetSelection = findMintSelectionTarget(docText, from, to);
    if (!targetSelection) return false;
    let phrase = targetSelection.phrase;
    if (!targetSelection.bracket) {
      if (!wrapSelection(view)) return false;
    }

    // The source receipt addresses the exact bytes in the exact snapshot that
    // flushEditorLocally captures synchronously below. Re-read after wrapping
    // so loose selections include their new bracket markup in the source hash.
    const sourceSnapshot = view.state.doc.toString();
    const expectedMatchStart = targetSelection.bracket?.matchStart ?? Math.min(from, to);
    const sourceBracket = findPendingBrackets(sourceSnapshot).find(
      (candidate) => candidate.matchStart === expectedMatchStart,
    );
    if (!sourceBracket) return false;
    phrase = sourceSnapshot.slice(sourceBracket.phraseStart, sourceBracket.phraseEnd);
    // Reserve the source synchronously, before hashing, flushing, recovery, or
    // signing can yield. Once Mint has journalled the Coin, the durable source
    // lock overlaps this one until the whole foreground gesture settles.
    const releaseSourceReservation = mintSourceReservations.reserve(folder.id, path);
    const mintLease = captureForegroundMintLease(folder.id);
    try {
      const sourceContentHashPromise = sha256HexLocal(sourceSnapshot);
      const signer = stepSigner ?? secretKeyForVoice(authorPubkey) ?? undefined;
      // Pin extraction to the exact source version that contains the selected
      // phrase. This flush is a no-op when the source is already current.
      const originNodeId = await flushEditorLocally(
        path,
        view,
        signer,
        undefined,
        mintLease.fence,
      );
      const sourceContentHash = await sourceContentHashPromise;
      const coin = await mintCoinTrace(
        phrase,
        {
          kind: "extracted",
          sourceNodeId: originNodeId,
          sourceContentHash,
          range: { start: sourceBracket.phraseStart, end: sourceBracket.phraseEnd },
        },
        signer,
        undefined,
        {
          metadata: {
            kind: "pending-bracket",
            relativePath: path,
            sourceNodeId: originNodeId,
            sourceContentHash,
            range: { start: sourceBracket.phraseStart, end: sourceBracket.phraseEnd },
            bracketRange: { start: sourceBracket.matchStart, end: sourceBracket.matchEnd },
          },
          finalize: async (record, publicationFence) => {
            assertPublicationFence(publicationFence);
            const afterWrite = view.state.doc.toString();
            // Same-source completions may have rebased this row into live
            // UTF-16 space while this gesture still holds the original
            // snapshot. resolvedFinalized picks the matching coordinate model.
            const resolved = resolvedFinalizedCoinMintSourceText(
              record,
              sourceSnapshot,
              afterWrite,
            );
            const change = minimalTextChange(afterWrite, resolved);
            if (change) view.dispatch({ changes: change });
            return flushEditorLocally(
              path,
              view,
              signer,
              operationIdFromNode(record.coin),
              publicationFence,
            );
          },
        },
        mintLease,
      );
      // Coins use the normal tab lifecycle but render a dedicated read-only
      // surface instead of mounting CodeMirror.
      setEditorSelection(null);
      chooseDirectorySelection([]);
      activateLiveTab(coin.path, {
        kind: "coin",
        path: coin.path,
        nodeId: coin.nodeId,
        phrase,
      });
      return true;
    } catch (e) {
      console.warn(`[mint] failed for phrase in ${path}:`, e);
      const originPanel = panels.findIndex((p) => p.tabs.includes(path));
      setOpStatus(originPanel === -1 ? activePanel : originPanel, "error", e instanceof Error ? e.message : String(e), "mint");
      // Leave the bracket pending — the user can retry.
      return false;
    } finally {
      mintLease.release();
      releaseSourceReservation();
    }
  }

  /** Copy can carry any exact stepped-source citation, but it never mints. */
  function copiedTraceCitation(
    path: string,
    view: EditorView,
    from: number,
    to: number,
    phrase: string,
  ): CoinClipboardCitation | null {
    const docText = view.state.doc.toString();
    const existing = findResolvedBrackets(docText).find(
      (bracket) =>
        bracket.phrase === phrase &&
        bracket.matchStart <= from &&
        bracket.matchEnd >= to,
    );
    if (existing) return { phrase, nodeId: existing.nodeId };
    const source = filesRef.current[path];
    const stepped = lastSteppedRef.current.get(path);
    return source?.nodeId && stepped?.content === docText
      ? { phrase, nodeId: source.nodeId }
      : null;
  }

  /** Carry an exact stepped citation across an intra-press Copy while
   * keeping `text/plain` on the system clipboard for every other app. */
  function copySelectionWithCoin(
    path: string,
    view: EditorView,
    event: ClipboardEvent,
  ): boolean {
    if (!folder || replayActiveRef.current || isOblivion(path)) return false;
    const { from, to } = view.state.selection.main;
    if (from === to) return false;
    const phrase = view.state.sliceDoc(from, to);
    if (!event.clipboardData) return false;
    const citation = copiedTraceCitation(path, view, from, to, phrase);
    if (!citation) return false;

    const ticket = typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const envelope = serializeCoinClipboardEnvelope(ticket);
    if (!envelope) return false;

    try {
      event.clipboardData.setData("text/plain", phrase);
      event.clipboardData.setData(COIN_CLIPBOARD_MIME, envelope);
    } catch {
      return false;
    }
    event.preventDefault();

    coinClipboardTicketsRef.current.set(ticket, { phrase, citation });
    // Bound session memory without time-based clipboard invalidation: the
    // newest 32 provenance copies remain pasteable, older envelopes safely
    // degrade to their `text/plain` payload.
    while (coinClipboardTicketsRef.current.size > 32) {
      const oldest = coinClipboardTicketsRef.current.keys().next().value;
      if (typeof oldest !== "string") break;
      coinClipboardTicketsRef.current.delete(oldest);
    }
    return true;
  }

  /** Resolve a clipboard ticket into `[[ phrase | sourceStepId ]]`. Unknown tickets,
   * text modified by another app, and unsupported custom MIME all fall through
   * to CodeMirror's native plain-text paste. */
  function pasteSelectionWithCoin(
    view: EditorView,
    event: ClipboardEvent,
  ): boolean {
    if (!event.clipboardData) return false;
    const envelope = parseCoinClipboardEnvelope(
      event.clipboardData.getData(COIN_CLIPBOARD_MIME),
    );
    if (!envelope) return false;
    const ticket = coinClipboardTicketsRef.current.get(envelope.ticket);
    const plainText = event.clipboardData.getData("text/plain");
    if (!ticket || ticket.phrase !== plainText) return false;

    event.preventDefault();
    const pasteState = view.state;
    const pasteSelection = pasteState.selection.main;
    const insert = (text: string) => {
      if (!view.dom.isConnected) return;
      // If the document changed while the source Step/coin was landing, honor
      // the author's current caret instead of overwriting an unrelated range.
      const selection = view.state === pasteState
        ? pasteSelection
        : view.state.selection.main;
      view.dispatch({
        changes: { from: selection.from, to: selection.to, insert: text },
        selection: { anchor: selection.from + text.length },
        scrollIntoView: true,
        userEvent: "input.paste",
      });
      view.focus();
    };

    insert(resolvedBracketMarkup(ticket.citation.phrase, ticket.citation.nodeId));
    return true;
  }

  // Resolve the right-click surface from the event target and build a sensible
  // menu of standard ops. The tree (openContextMenu) and tab
  // (openTabContextMenu) handlers call stopPropagation, so this only reaches
  // the editor, modal text fields, read-only <pre>, and empty chrome. The
  // native menu is suppressed everywhere it catches; empty surfaces get no menu.
  // Clipboard uses document.execCommand for native fields (textarea/input) and
  // CM6's selection/replace APIs for the editor.
  function openGlobalContextMenu(e: React.MouseEvent) {
    // Tree/tab surfaces already handled their own menus + stopPropagation; if we
    // still see one of their containers, skip (don't double-open).
    const target = e.target as HTMLElement;
    // Find a CM6 view whose content contains the target — the editor surface.
    const cmView = panelViews.current.find(
      (v) => v && v.contentDOM && v.contentDOM.contains(target),
    );
    const isEditableField =
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLInputElement ||
      target.isContentEditable;

    // Helper: read the current selection text from whatever surface was clicked.
    function selectedText(): string {
      if (cmView) {
        const sel = cmView.state.selection.main;
        return sel.from !== sel.to ? cmView.state.sliceDoc(sel.from, sel.to) : "";
      }
      if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) {
        return target.value.slice(target.selectionStart ?? 0, target.selectionEnd ?? 0);
      }
      const dsel = window.getSelection();
      return dsel && !dsel.isCollapsed ? dsel.toString() : "";
    }
    const hasSel = selectedText().length > 0;

    if (cmView) {
      // Editor canvas (CodeMirror). Resolved Coins are immutable, so this menu
      // deliberately contains only ordinary text operations.
      const items: GlobalCtxItem[] = [
        { kind: "action", label: "Cut", run: () => document.execCommand("cut"), disabled: !hasSel },
        { kind: "action", label: "Copy", run: () => document.execCommand("copy"), disabled: !hasSel },
        { kind: "action", label: "Paste", run: () => document.execCommand("paste") },
        { kind: "sep" },
        { kind: "action", label: "Select All", run: () => cmView.dispatch({ selection: { anchor: 0, head: cmView.state.doc.length } }) },
      ];
      e.preventDefault();
      setGlobalCtx({ x: e.clientX, y: e.clientY, items });
      return;
    }

    if (isEditableField) {
      // Modal text fields (AttestModal note, RunModal goal, SamplerPanel inputs,
      // etc.). Native editing ops via execCommand — the field retains focus.
      const items: GlobalCtxItem[] = [
        { kind: "action", label: "Cut", run: () => document.execCommand("cut"), disabled: !hasSel },
        { kind: "action", label: "Copy", run: () => document.execCommand("copy"), disabled: !hasSel },
        { kind: "action", label: "Paste", run: () => document.execCommand("paste") },
        { kind: "sep" },
        { kind: "action", label: "Select All", run: () => document.execCommand("selectAll") },
      ];
      e.preventDefault();
      setGlobalCtx({ x: e.clientX, y: e.clientY, items });
      return;
    }

    // Read-only text: <pre> (PromptInspector, MergePreview) and ListingsView
    // cards. Copy + Select All on whatever selection the browser made on click.
    const isReadOnlyText =
      target.closest("pre, code, .stack-card, article") != null;
    if (isReadOnlyText) {
      const items: GlobalCtxItem[] = [
        { kind: "action", label: "Copy", run: () => document.execCommand("copy"), disabled: !hasSel },
        { kind: "sep" },
        { kind: "action", label: "Select All", run: () => document.execCommand("selectAll") },
      ];
      e.preventDefault();
      setGlobalCtx({ x: e.clientX, y: e.clientY, items });
      return;
    }

    // Empty chrome (NavRail, Globe, ActionPalette, citation row, app background): suppress
    // the native menu but render nothing — right-click visibly does nothing.
    e.preventDefault();
  }

  // Provider catalog (Models view). Labels are the card names from Models —
  // kept live via ModelsView.onProvidersChange so the action-palette dropdown matches
  // renames. Re-read when entering Press in case storage changed elsewhere.
  // Which one ops use is chosen under Press model select (voice-provider-store).
  const [providers, setProviders] = useState<ProviderConfig[]>(() => loadProviders());
  const providersRef = useRef(providers);
  providersRef.current = providers;
  const desktopOperationStoreRef = useRef<DesktopOperationStoreV1 | null>(null);
  const desktopOperationRuntimeRef = useRef<DesktopOperationRuntimeV1 | null>(null);
  const [desktopRuntimeReady, setDesktopRuntimeReady] = useState(false);
  const [, setDesktopOperationEnvelopes] = useState<
    DesktopOperationEnvelopeV1[]
  >([]);
  const [desktopOperationPageLineageHeads, setDesktopOperationPageLineageHeads] = useState<
    DesktopOperationEnvelopeV1[]
  >([]);
  const [desktopOperationPinnedHeads, setDesktopOperationPinnedHeads] = useState<
    DesktopOperationEnvelopeV1[]
  >([]);
  const [desktopOperationPageCursor, setDesktopOperationPageCursor] = useState<string | null>(null);
  const [desktopOperationNextCursor, setDesktopOperationNextCursor] = useState<string | null>(null);
  const [desktopOperationPreviousCursors, setDesktopOperationPreviousCursors] = useState<
    Array<string | null>
  >([]);
  const [desktopOperationLoadingMore, setDesktopOperationLoadingMore] = useState(false);
  const [desktopOperationBusyKey, setDesktopOperationBusyKey] = useState<string | null>(null);
  const [desktopOperationError, setDesktopOperationError] = useState<string | null>(null);
  const [desktopOperationRecoveryNotice, setDesktopOperationRecoveryNotice] = useState<string | null>(null);
  const desktopOperationRefreshSequenceRef = useRef(0);
  const desktopOperationPinnedLineageFenceRef = useRef(
    createDesktopOperationPinnedLineageFenceV1(),
  );
  const desktopReprepareKeyRef = useRef<DesktopOperationKeyV1 | null>(null);
  // Directive authority is deliberately non-durable. Only attempts created or
  // linked from an authorized attempt during this App activation may consume
  // prepared one-shot directives.
  const desktopAuthorizedAttemptKeysRef = useRef(new Set<string>());
  // Desktop Extend requests outlive individual render frames, but never this
  // App/vault activation. Cleanup aborts the complete set before releasing the
  // native journal/runtime boundary.
  const desktopOperationAbortControllersRef = useRef(new Set<AbortController>());
  const desktopOperationQueue = useMemo(
    () => desktopOperationReviewQueueV1([
      ...desktopOperationPinnedHeads,
      ...desktopOperationPageLineageHeads,
    ].filter((envelope) =>
      envelope.prepared.targetRevision.folderId === folder?.id), (envelope) =>
      isDesktopOperationAuthorizedThisSessionV1(
        envelope,
        desktopAuthorizedAttemptKeysRef.current,
      )),
    [desktopOperationPageLineageHeads, desktopOperationPinnedHeads, folder?.id],
  );

  // SecurityBootstrap mounts App only after vault activation has captured the
  // native journal session. Construction freezes that session into this store;
  // it never follows a later vault switch or falls back to browser storage.
  useEffect(() => {
    if (!isTauri()) return;
    try {
      const repository = createNativeDesktopOperationStoreV1();
      const runtime = new DesktopOperationRuntimeV1({
        repository,
        clock: { nowMs: () => Date.now() },
        ids: { next: (kind) => `${kind}-${crypto.randomUUID()}` },
        resolveProvider: (providerId) => (
          providersRef.current.find((provider) => provider.id === providerId) ?? null
        ),
        readCurrentTarget: (captured) => readDesktopCurrentTarget(captured),
        completePrepared,
        applyArtifact: (input) => applyDesktopArtifact(input),
        isAttemptAuthorizedForCurrentEditorSession: (envelope) =>
          isDesktopOperationAuthorizedThisSessionV1(
            envelope,
            desktopAuthorizedAttemptKeysRef.current,
          ),
        presentResult: (envelope) => upsertDesktopOperationEnvelope(envelope),
      });
      desktopOperationStoreRef.current = repository;
      desktopOperationRuntimeRef.current = runtime;
      setDesktopRuntimeReady(true);
    } catch (error) {
      setDesktopOperationError(error instanceof Error ? error.message : String(error));
    }
    return () => {
      desktopOperationRefreshSequenceRef.current += 1;
      desktopAuthorizedAttemptKeysRef.current.clear();
      for (const controller of desktopOperationAbortControllersRef.current) {
        controller.abort();
      }
      desktopOperationAbortControllersRef.current.clear();
      desktopOperationRuntimeRef.current = null;
      desktopOperationStoreRef.current = null;
      setDesktopRuntimeReady(false);
    };
    // App's first mount is the frozen vault-session boundary.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Wait for crash-pad restoration before recovery: accepted intents must see
  // the restored exact target/receipt, never a transient empty workspace.
  useEffect(() => {
    if (!isTauri() || !desktopRuntimeReady || bootState !== "ready" || !folder) return;
    let cancelled = false;
    desktopOperationRefreshSequenceRef.current += 1;
    setDesktopOperationError(null);
    setDesktopOperationRecoveryNotice(null);
    setDesktopOperationEnvelopes([]);
    setDesktopOperationPageLineageHeads([]);
    setDesktopOperationPageCursor(null);
    setDesktopOperationNextCursor(null);
    setDesktopOperationPreviousCursors([]);
    void desktopOperationRuntimeRef.current!.recover()
      .then((result) => {
        if (cancelled) return;
        if (result.failureCount > 0) {
          const shown = Math.min(result.failureCount, 99);
          setDesktopOperationError(
            `${shown}${result.failureCount > shown ? "+" : ""} saved AI operation(s) need recovery attention.`,
          );
          setDesktopOperationEnvelopes([]);
          setDesktopOperationPageLineageHeads([]);
          setDesktopOperationPageCursor(null);
          setDesktopOperationNextCursor(null);
          setDesktopOperationPreviousCursors([]);
          return;
        }
        if (result.recoveredCount > 0) {
          setDesktopOperationRecoveryNotice(
            "Saved AI history recovered. Review the current page and use Previous / More / Next when available.",
          );
        }
        return refreshDesktopOperationEnvelopes(null, []);
      })
      .catch(() => {
        if (!cancelled) {
          setDesktopOperationError("Saved AI operation recovery could not finish.");
          setDesktopOperationRecoveryNotice(null);
          setDesktopOperationEnvelopes([]);
          setDesktopOperationPageLineageHeads([]);
          setDesktopOperationPageCursor(null);
          setDesktopOperationNextCursor(null);
          setDesktopOperationPreviousCursors([]);
        }
      });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [desktopRuntimeReady, bootState, folder?.id]);

  function upsertDesktopOperationEnvelope(envelope: DesktopOperationEnvelopeV1): void {
    const provenParent = desktopOperationPageLineageHeads.find((candidate) => (
      candidate.operationId === envelope.operationId
      && candidate.attempt.attemptId === envelope.attempt.retryOfAttemptId
    ));
    setDesktopOperationPinnedHeads((current) => [
      ...(provenParent
        ? mergeDesktopOperationPinnedDescendantV1(
            current,
            provenParent,
            envelope,
            16,
            desktopOperationPinnedLineageFenceRef.current,
          )
        : mergeDesktopOperationPinnedHeadsV1(
            current,
            [envelope],
            16,
            desktopOperationPinnedLineageFenceRef.current,
          )),
    ]);
    setDesktopOperationEnvelopes((current) => {
      const existing = current.findIndex((candidate) => (
        candidate.operationId === envelope.operationId
        && candidate.attempt.attemptId === envelope.attempt.attemptId
      ));
      if (existing >= 0) return current.map((candidate, index) => index === existing ? envelope : candidate);
      return current;
    });
    setDesktopOperationPageLineageHeads((current) => current.map((candidate) => (
      candidate.operationId === envelope.operationId
      && candidate.attempt.attemptId === envelope.attempt.attemptId
        ? envelope
        : candidate
    )));
  }

  async function refreshDesktopOperationEnvelopes(
    cursor: string | null = desktopOperationPageCursor,
    previousCursors: Array<string | null> = desktopOperationPreviousCursors,
  ): Promise<void> {
    const repository = desktopOperationStoreRef.current;
    if (!repository) return;
    const sequence = ++desktopOperationRefreshSequenceRef.current;
    const cancelled = () => (
      sequence !== desktopOperationRefreshSequenceRef.current
      || desktopOperationStoreRef.current !== repository
    );
    try {
      const page = await repository.listPage(cursor, 16);
      const lineageHeads = await resolveDesktopOperationPageLineageV1(
        repository,
        page.records,
        { pageSize: 16, isCancelled: cancelled },
      );
      if (cancelled()) return;
      setDesktopOperationEnvelopes([...page.records]);
      setDesktopOperationPageLineageHeads([...lineageHeads]);
      setDesktopOperationPageCursor(cursor);
      setDesktopOperationNextCursor(page.nextCursor);
      setDesktopOperationPreviousCursors(previousCursors);
    } catch (error) {
      if (cancelled()) return;
      // A partial/global lineage scan must never leave an older archived
      // attempt actionable from the previously rendered page.
      setDesktopOperationEnvelopes([]);
      setDesktopOperationPageLineageHeads([]);
      setDesktopOperationPageCursor(null);
      setDesktopOperationNextCursor(null);
      setDesktopOperationPreviousCursors([]);
      throw error;
    }
  }

  async function loadMoreDesktopOperationEnvelopes(): Promise<void> {
    if (!desktopOperationNextCursor || desktopOperationLoadingMore) return;
    setDesktopOperationLoadingMore(true);
    setDesktopOperationError(null);
    try {
      await refreshDesktopOperationEnvelopes(
        desktopOperationNextCursor,
        [...desktopOperationPreviousCursors, desktopOperationPageCursor],
      );
    } catch {
      setDesktopOperationError("More saved AI operations could not be loaded.");
    } finally {
      setDesktopOperationLoadingMore(false);
    }
  }

  async function loadPreviousDesktopOperationEnvelopes(): Promise<void> {
    if (desktopOperationPreviousCursors.length === 0 || desktopOperationLoadingMore) return;
    const previous = desktopOperationPreviousCursors[desktopOperationPreviousCursors.length - 1]!;
    setDesktopOperationLoadingMore(true);
    setDesktopOperationError(null);
    try {
      await refreshDesktopOperationEnvelopes(
        previous,
        desktopOperationPreviousCursors.slice(0, -1),
      );
    } catch {
      setDesktopOperationError("The previous saved AI operation page could not be loaded.");
    } finally {
      setDesktopOperationLoadingMore(false);
    }
  }

  async function dispatchDesktopOperationAttempt(
    envelope: DesktopOperationEnvelopeV1,
    providedController?: AbortController,
  ): Promise<DesktopOperationEnvelopeV1> {
    const runtime = desktopOperationRuntimeRef.current;
    if (!runtime) throw new Error("The desktop operation journal is unavailable");
    const controller = providedController ?? new AbortController();
    const alreadyTracked = desktopOperationAbortControllersRef.current.has(controller);
    desktopOperationAbortControllersRef.current.add(controller);
    const key = {
      operationId: envelope.operationId,
      attemptId: envelope.attempt.attemptId,
    };
    try {
      let current = envelope;
      if (controller.signal.aborted && (
        current.lifecycle.status === "prepared" || current.lifecycle.status === "approved"
      )) {
        current = await runtime.cancel(key);
        upsertDesktopOperationEnvelope(current);
        return current;
      }
      if (current.lifecycle.status === "prepared") {
        current = await runtime.approve(key);
        upsertDesktopOperationEnvelope(current);
      }
      if (controller.signal.aborted && current.lifecycle.status === "approved") {
        current = await runtime.cancel(key);
        upsertDesktopOperationEnvelope(current);
        return current;
      }
      if (current.lifecycle.status === "approved") {
        current = await runtime.dispatch(key, { signal: controller.signal });
        upsertDesktopOperationEnvelope(current);
      }
      return current;
    } finally {
      if (!alreadyTracked) desktopOperationAbortControllersRef.current.delete(controller);
    }
  }

  async function retryDesktopOperation(
    key: DesktopOperationKeyV1,
    possibleDuplicateAcknowledged = false,
  ): Promise<void> {
    const runtime = desktopOperationRuntimeRef.current;
    if (!runtime) throw new Error("The desktop operation journal is unavailable");
    const controller = new AbortController();
    desktopOperationAbortControllersRef.current.add(controller);
    try {
      const retry = await runtime.retry(key, possibleDuplicateAcknowledged
        ? { possibleDuplicateAcknowledged: true }
        : {});
      if (
        !controller.signal.aborted
        && desktopAuthorizedAttemptKeysRef.current.has(
          desktopOperationAttemptKeyV1(key.operationId, key.attemptId),
        )
      ) {
        desktopAuthorizedAttemptKeysRef.current.add(
          desktopOperationAttemptKeyV1(retry.operationId, retry.attempt.attemptId),
        );
      }
      upsertDesktopOperationEnvelope(retry);
      await dispatchDesktopOperationAttempt(retry, controller);
    } finally {
      desktopOperationAbortControllersRef.current.delete(controller);
    }
  }

  async function handleDesktopOperationAction(
    item: DesktopOperationReviewItemV1,
    action: DesktopOperationReviewActionV1,
  ): Promise<void> {
    const runtime = desktopOperationRuntimeRef.current;
    if (!runtime) {
      setDesktopOperationError("The desktop operation journal is unavailable");
      return;
    }
    if (action === "reprepare" || action === "reprepare-possible-duplicate") {
      const prior = await runtime.load(item.key);
      const target = prior?.prepared.targetRevision;
      const liveFolder = folderRef.current;
      const liveFile = target ? filesRef.current[target.path] : undefined;
      if (
        !prior || !target || !liveFolder || liveFolder.id !== target.folderId
        || !liveFile || liveFile.kind === "folder" || liveFile.traceId !== target.traceId
      ) {
        setDesktopOperationError(
          "Restore the original workspace and trace before re-preparing this stale draft.",
        );
        return;
      }
      desktopReprepareKeyRef.current = item.key;
      modelOperationControllerRef.current?.invalidate();
      setApprovedRequestHash(null);
      activateLiveTab(target.path);
      window.requestAnimationFrame(() => void openInspector("extend"));
      return;
    }
    if (
      action === "retry-possible-duplicate"
      && !window.confirm(
        "The provider may already have processed the previous request. Retry as a new attempt anyway?",
      )
    ) return;
    const busyKey = `${item.key.operationId}\0${item.key.attemptId}`;
    setDesktopOperationBusyKey(busyKey);
    setDesktopOperationError(null);
    try {
      if (action === "accept") {
        const accepted = await runtime.accept(item.key);
        upsertDesktopOperationEnvelope(accepted.envelope);
      } else if (action === "reject") {
        upsertDesktopOperationEnvelope(await runtime.reject(item.key));
      } else if (action === "abandon") {
        upsertDesktopOperationEnvelope(await runtime.abandon(item.key));
      } else if (action === "retry" || action === "retry-possible-duplicate") {
        await retryDesktopOperation(item.key, action === "retry-possible-duplicate");
      } else if (action === "resume") {
        const envelope = await runtime.load(item.key);
        if (!envelope) throw new Error("The saved Extend attempt is no longer available");
        await dispatchDesktopOperationAttempt(envelope);
      }
      await refreshDesktopOperationEnvelopes();
    } catch (error) {
      setDesktopOperationError(error instanceof Error ? error.message : String(error));
      await refreshDesktopOperationEnvelopes().catch(() => undefined);
    } finally {
      setDesktopOperationBusyKey(null);
    }
  }

  async function dispatchFreshDesktopRetry(
    staleKey: DesktopOperationKeyV1,
    prepared: PreparedOperation,
  ): Promise<void> {
    const runtime = desktopOperationRuntimeRef.current;
    const provider = providersRef.current.find((candidate) => candidate.id === prepared.providerId);
    if (!runtime || !provider) {
      setDesktopOperationError("The approved provider is no longer configured");
      return;
    }
    const busyKey = `${staleKey.operationId}\0${staleKey.attemptId}`;
    const controller = new AbortController();
    desktopOperationAbortControllersRef.current.add(controller);
    setDesktopOperationBusyKey(busyKey);
    setDesktopOperationError(null);
    try {
      const prior = await runtime.load(staleKey);
      if (!prior) throw new Error("The saved Extend attempt is no longer available");
      const ambiguous = prior.lifecycle.retryPolicy === "operator-confirmation-required";
      if (
        ambiguous
        && !window.confirm(
          "The provider may already have processed the previous request. Dispatching this re-prepared request may duplicate provider work. Continue?",
        )
      ) return;
      const retry = prior.lifecycle.status === "stale" || ambiguous
        ? await runtime.retry(staleKey, {
            freshPreparation: { prepared, provider, maxOutputTokens: 4096 },
            ...(ambiguous ? { possibleDuplicateAcknowledged: true as const } : {}),
          })
        : await runtime.persistApprovedExtend({
            prepared,
            provider,
            maxOutputTokens: 4096,
          });
      if (!controller.signal.aborted) {
        desktopAuthorizedAttemptKeysRef.current.add(
          desktopOperationAttemptKeyV1(retry.operationId, retry.attempt.attemptId),
        );
      }
      upsertDesktopOperationEnvelope(retry);
      await dispatchDesktopOperationAttempt(retry, controller);
      await refreshDesktopOperationEnvelopes();
    } catch (error) {
      setDesktopOperationError(error instanceof Error ? error.message : String(error));
      await refreshDesktopOperationEnvelopes().catch(() => undefined);
    } finally {
      desktopOperationAbortControllersRef.current.delete(controller);
      setDesktopOperationBusyKey(null);
    }
  }

  const [opLenses, setOpLenses] = useState(() => loadOpLensSelections());
  useEffect(() => {
    if (activeView === "editor") setProviders(loadProviders());
  }, [activeView]);

  function chooseOpLens(op: PromptOpKind, lensId: OpLensId) {
    const next = saveOpLensSelection(op, lensId);
    setOpLenses(next);
  }

  function saveAgentRecipe(input: AutomationRecipeDraft) {
    if (!folder) throw new Error("open a workspace before saving an automation recipe");
    const saved = upsertAutomationRecipe({
      ...input,
      workspaceId: folder.id,
      ...(folder.label ? { workspaceLabel: folder.label } : {}),
      scopes: automationScopesFor(scopeRef.current),
    });
    setAutomationRecipes(loadAutomationRecipes());
    return saved;
  }

  function deleteAgentRecipe(id: string) {
    setAutomationRecipes(removeAutomationRecipe(id));
  }

  function automationScopesAvailable(scopes: AutomationScopes): boolean {
    const current = filesRef.current;
    const paths = Object.keys(current);
    return scopes.length > 0 && scopes.every((item) => {
      if (isMint(item.path) || isScan(item.path) || isOblivion(item.path)) return false;
      if (item.kind === "file") return !!current[item.path] && current[item.path]?.kind !== "folder";
      return item.path === ROOT || current[item.path]?.kind === "folder" ||
        paths.some((path) => path.startsWith(`${item.path}/`));
    });
  }

  // App-open scheduler: claim at most one overdue recipe per tick, and wait
  // while the user has the composer open or any foreground model operation is
  // active. Scheduled work uses startAgentRun, so its capabilities remain
  // read + sandboxed draft writes; this timer cannot Step, Send, or Attest.
  useEffect(() => {
    let disposed = false;
    const tick = () => {
      if (
        disposed ||
        bootState !== "ready" ||
        !folder ||
        runOpen ||
        automationSchedulerBusyRef.current ||
        summonAbort.current.some(Boolean)
      ) return;
      automationSchedulerBusyRef.current = true;
      void withAutomationSchedulerLock(async () => {
        if (
          disposed ||
          !folder ||
          folderIdRef.current !== folder.id ||
          summonAbort.current.some(Boolean)
        ) return;
        const availableProviderIds = new Set(providers.map((provider) => provider.id));
        const recipe = dueAutomationRecipesForWorkspace(
          loadAutomationRecipes(),
          folder.id,
        ).find((item) =>
          availableProviderIds.has(item.providerId) && automationScopesAvailable(item.scopes),
        );
        if (!recipe) return;
        await startAgentRun(recipe.goal, recipe.providerId, {
          trigger: "schedule",
          recipeId: recipe.id,
          recipeLabel: recipe.label,
          workspaceId: recipe.workspaceId,
          scopes: recipe.scopes,
        });
      })
        .catch((error) => {
          console.warn("[automation] scheduled run failed before completion:", error);
        })
        .finally(() => {
          setAutomationRecipes(loadAutomationRecipes());
          automationSchedulerBusyRef.current = false;
        });
    };
    tick();
    const timer = window.setInterval(tick, 30_000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [automationRecipes, providers, runOpen, bootState, folder?.id]);

  // MODEL voice's pinned provider, derived here so ActionPalette's model select takes
  // it as a prop (same shape as substrateKeyId above) instead of re-reading the
  // store mid-render. Falls back to the first provider so the dropdown matches
  // what ops run (resolveVoiceProvider uses the same rule). `voiceProviderTick`
  // is the re-read signal — a pin change bumps it, re-running this derivation
  // (mirroring how a substrate switch re-derives substrateKeyId).
  void voiceProviderTick;
  const resolvedModelProviderId =
    providers.find((p) => p.id === getVoiceProvider(modelPubkey))?.id ?? providers[0]?.id ?? "";

  /** Set the AUTHOR (typing + Save/send) voice. Persisted per-browser. */
  function chooseAuthorKey(id: string) {
    setAuthorKeyId(id);
    localStorage.setItem("zine.roles.author", id);
  }

  /** Set the MODEL (LLM ops) voice. Persisted per-browser. */
  function chooseModelKey(id: string) {
    setModelKeyId(id);
    localStorage.setItem("zine.roles.model", id);
  }

  /** Resolve the provider a voice's ops should use. Sole source of truth:
   *  the MODEL model pin on that voice (voice-provider-store). If unset or
   *  dangling, fall back to the first configured provider so a single Models
   *  entry works without a separate "active" click. */
  function resolveVoiceProvider(pubkey: string): ProviderConfig | null {
    const vpId = getVoiceProvider(pubkey);
    if (vpId) {
      const pinned = providers.find((p) => p.id === vpId);
      if (pinned) return pinned;
    }
    return providers[0] ?? null;
  }

  /** Pin the MODEL model for the MODEL voice and re-render so the menu updates.
   *  Mirrors chooseModelKey / chooseSubstrateKey: a single id, App already knows
   *  the voice. The tick re-derives resolvedModelProviderId above (like substrate). */
  function selectVoiceProvider(providerId: string) {
    setVoiceProvider(modelPubkey, providerId || null);
    setVoiceProviderTick((k) => k + 1);
  }

  /** Set per-panel palette status. The operation identifies both the live stop
   *  button and the AUTHOR, MODEL, or substrate row that owns terminal feedback.
   *  Success auto-clears after a beat; errors persist so the user can read them. */
  function setOpStatus(
    idx: number,
    state: SummonStatus["state"],
    msg?: string,
    op?: PaletteStatusOp,
  ) {
    setSummonStatus((prev) => {
      const next = [...prev];
      // Terminal updates usually follow a running update. Preserve its owner so
      // success and error feedback stays in the row where the action started.
      const statusOp = op ?? prev[idx]?.op;
      next[idx] = state === "idle" || !statusOp
        ? { state, msg }
        : { state, msg, op: statusOp };
      return next;
    });
    // Auto-reset a "done" flash to idle so the success text doesn't linger.
    // Errors stay put — the user needs to read them.
    if (state === "done") {
      window.setTimeout(() => {
        setSummonStatus((prev) =>
          prev[idx]?.state === "done" ? spliceAt(prev, idx, { state: "idle" }) : prev,
        );
      }, 2500);
    }
  }

  /** Resolve + guard the provider for a voice's op (MODEL model select).
   *  Returns it or sets an error and null. */
  function resolveOpProvider(idx: number, pubkey: string, op: OpKind): ProviderConfig | null {
    const provider = resolveVoiceProvider(pubkey);
    if (!provider) {
      setOpStatus(idx, "error", "no provider — add one in Models", op);
      return null;
    }
    return provider;
  }

  // ─── Prompt inspector ──────────────────────────────────────────────────────
  // The per-op chevron on each MODEL action opens a modal showing exactly what
  // that op would send. `inspectOp` is null when closed; non-null is the op to
  // show first. The inputs + context block are gathered once on open (against
  // the op-target panel + scope, mirroring what the live ops gather) and held
  // in state so the modal can switch op tabs without re-fetching the (memoized)
  // context block.
  const [inspectOp, setInspectOp] = useState<PromptOpKind | null>(null);
  const [inspectContext, setInspectContext] = useState("");
  const [inspectNotes, setInspectNotes] = useState<Partial<Record<PromptOpKind, string>>>({});
  const [inspectPrepared, setInspectPrepared] = useState<
    Partial<Record<PromptOpKind, PreparedOperation>>
  >({});
  const [inspectPreparing, setInspectPreparing] = useState<PromptOpKind | null>(null);
  const [inspectPreparationError, setInspectPreparationError] = useState<string | null>(null);
  const [approvedRequestHash, setApprovedRequestHash] = useState<string | null>(null);
  const [staleModelResult, setStaleModelResult] = useState<RecoverableModelResult | null>(null);
  const inspectInputsRef = useRef<Partial<Record<PromptOpKind, OpInputs>>>({});
  const inspectInputsReadyRef = useRef<Record<PromptOpKind, boolean>>({
    extend: false,
    settle: false,
    stir: false,
    reply: false,
    analyze: false,
  });
  const inspectRequestedOpRef = useRef<PromptOpKind>("extend");
  const inspectOpenSequenceRef = useRef(0);
  const inspectPreparationSequenceRef = useRef(0);
  const inspectIsOpenRef = useRef(false);
  const inspectLensSelectionsRef = useRef(opLenses);
  inspectLensSelectionsRef.current = opLenses;

  useEffect(() => {
    modelOperationControllerRef.current!.invalidate();
    setApprovedRequestHash(null);
    setInspectPrepared({});
  }, [folder?.id, files, panels, activePanel, uiFocus, scope, shielded, providers, authorPubkey, modelPubkey, opLenses]);

  useEffect(() => {
    if (!inspectIsOpenRef.current) return;
    inspectOpenSequenceRef.current++;
    inspectPreparationSequenceRef.current++;
    inspectInputsReadyRef.current = {
      extend: false,
      settle: false,
      stir: false,
      reply: false,
      analyze: false,
    };
    setInspectPreparing(null);
    setInspectPreparationError("The file or prompt context changed. Choose the action again to inspect a fresh request.");
  }, [folder?.id, files, panels, activePanel, uiFocus, scope, shielded, providers, authorPubkey, modelPubkey]);

  function recordModelLessonResult(prepared: PreparedOperation, response: string): void {
    const lesson = modelLessonResume;
    if (
      onboardingStageRef.current !== "context-run" ||
      !lesson ||
      (prepared.operation !== "extend" && prepared.operation !== "settle" && prepared.operation !== "stir") ||
      prepared.targetRevision.path !== lesson.targetPath
    ) return;
    const nextLesson: ModelLessonResume = {
      ...lesson,
      resultSpanHash: contentFingerprint(response),
    };
    setModelLessonResume(nextLesson);
    const nextStage = reduceOnboardingStage(onboardingStageRef.current, "result-applied");
    commitOnboardingStage(nextStage, nextLesson);
  }

  useEffect(() => {
    const lesson = modelLessonResume;
    if (!lesson || !onboardingStage.startsWith("context-") && onboardingStage !== "model-setup") return;
    const template = modelContextLessonForFolder(lesson.folderPath);
    const target = files[lesson.targetPath];
    const source = files[lesson.sourcePath];
    const excluded = files[lesson.excludedPath];
    const expectedSource = template.artifacts.find((artifact) => artifact.role === "source")!;
    const expectedExcluded = template.artifacts.find((artifact) => artifact.role === "excluded")!;
    const expectedTarget = template.artifacts.find((artifact) => artifact.role === "target")!;
    const lessonValid = Boolean(
      target?.nodeId && source?.nodeId && excluded?.nodeId &&
      flatten(source.runs) === expectedSource.body &&
      flatten(excluded.runs) === expectedExcluded.body &&
      (lesson.resultSpanHash || flatten(target.runs) === expectedTarget.body),
    );
    const testedProvider = modelProbeSession
      ? providers.find((provider) => provider.id === modelProbeSession.providerId)
      : undefined;
    const providerProbed = Boolean(
      testedProvider &&
      providerProfileFingerprint(testedProvider) === modelProbeSession?.providerFingerprint,
    );
    const resultBuffered = Boolean(
      lesson.resultSpanHash &&
      target &&
      unsteppedPathSet.has(lesson.targetPath) &&
      target.runs.some((run) =>
        contentFingerprint(run.text) === lesson.resultSpanHash ||
        contentFingerprint(run.text.replace(/^\n/, "")) === lesson.resultSpanHash),
    );
    const next = reconcileModelOnboardingStage(onboardingStage, {
      providerProbed,
      lessonValid,
      targetFocused: uiFocus?.kind === "file" && uiFocus.path === lesson.targetPath,
      folderMounted: scope[0]?.kind === "folder" && scope[0].path === lesson.folderPath,
      noteShielded: shielded.has(lesson.excludedPath),
      requestApproved: approvedRequestHash !== null,
      resultBuffered,
      resultStepped: Boolean(lesson.resultNodeId && target?.nodeId === lesson.resultNodeId),
    });
    if (next !== onboardingStage) {
      commitOnboardingStage(next, lesson);
      if (next === "model-setup") {
        setModelProbeSession(null);
        selectView("models");
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    onboardingStage,
    modelLessonResume,
    modelProbeSession,
    providers,
    files,
    uiFocus,
    scope,
    shielded,
    approvedRequestHash,
  ]);

  /** Derive the per-op `OpInputs` from the op-target panel's live editor state,
   *  the same way the ops themselves do. Extend seeds from the selection or doc
   *  tail; Settle/Stir use partitionDoc + findCommands + iterBrackets. Reply's
   *  stepped references and Analyze's limelight log are filled when Inspector
   *  opens so the captured preview matches a call made at the same moment. */
  function deriveInspectInputs(): Partial<Record<PromptOpKind, OpInputs>> {
    const idx = opTargetPanel();
    const path = panels[idx]?.active;
    const view = panelViews.current[idx];
    if (!path || !view) return {};
    const doc = view.state.doc.toString();
    const sel = view.state.selection.main;
    const hasSel = sel.from !== sel.to;
    // Extend: seed from selection, else doc tail (matches extendLLM).
    const seedFrom = hasSel ? sel.from : Math.max(0, doc.length - 4000);
    const seedTo = hasSel ? sel.to : doc.length;
    const seed = view.state.sliceDoc(seedFrom, seedTo);
    // Stir: gather commands + loose prose + anchor count over the selection
    // (or whole doc), mirroring shakeLLM.
    const stirText = hasSel ? view.state.sliceDoc(sel.from, sel.to) : doc;
    const cmds = findCommands(stirText);
    const stripped = stripRanges(stirText, cmds.map((c) => [c.matchStart, c.matchEnd] as [number, number]));
    const loose = partitionDoc(stripped).filter((p) => p.kind === "loose").map((p) => p.text).join("\n").trim();
    const anchorCount = [...iterBrackets(stirText)].length;
    const settlePrompt = encodeSettleAnchors(stirText).promptText;
    const operationFrom = hasSel ? sel.from : 0;
    const operationTo = hasSel ? sel.to : doc.length;
    return {
      extend: { seed, hasSelection: hasSel, rangeFrom: hasSel ? sel.to : doc.length, rangeTo: hasSel ? sel.to : doc.length, sourceFrom: seedFrom, sourceTo: seedTo },
      settle: { loose: settlePrompt, rangeFrom: hasSel ? sel.from : 0, rangeTo: hasSel ? sel.to : doc.length, sourceFrom: hasSel ? sel.from : 0, sourceTo: hasSel ? sel.to : doc.length },
      stir: { loose, anchorCount, commands: cmds.map((c) => c.command), rangeFrom: hasSel ? sel.from : 0, rangeTo: hasSel ? sel.to : doc.length },
      // Reply/Analyze relay-backed bodies are filled by openInspector.
      reply: { source: stirText, sourceFrom: operationFrom, sourceTo: operationTo },
      analyze: {},
    };
  }

  /** Gather the focused file's signed genesis-to-head chain as a trace-context
   *  boundary for Extend. Shared by the Inspector's prepare path and the
   *  Extend autofire branch so both see byte-identical context. Throws if no
   *  folder is attached, no file is focused, or the chain is empty/unstepped. */
  async function gatherExtendTraceContext(idx: number) {
    const liveFolder = folderRef.current;
    const activePath = panelsRef.current[idx]?.active ?? "";
    if (!liveFolder || !activePath) {
      throw new Error("Open and focus a stepped file before preparing Extend");
    }
    const chain = await fetchChain(liveFolder.id, activePath);
    if (chain.length === 0) {
      throw new Error("Extend needs the focused file's signed genesis-to-head chain");
    }
    return {
      version: 1 as const,
      policy: "selected-trace-v1" as const,
      chain,
      verifyEvent,
    };
  }

  async function prepareInspectorOperation(
    operation: PromptOpKind,
    inputs: Partial<Record<PromptOpKind, OpInputs>> = inspectInputsRef.current,
    lensId: OpLensId = inspectLensSelectionsRef.current[operation],
    openSequence = inspectOpenSequenceRef.current,
    requestedPreparationSequence?: number,
  ): Promise<void> {
    const preparationSequence = requestedPreparationSequence
      ?? ++inspectPreparationSequenceRef.current;
    const idx = opTargetPanel();
    const provider = resolveVoiceProvider(modelPubkey);
    if (!provider) {
      if (openSequence === inspectOpenSequenceRef.current) {
        setInspectPreparationError("No AI provider is configured.");
        setInspectPreparing(null);
      }
      return;
    }
    setInspectPreparing(operation);
    setInspectPreparationError(null);
    try {
      const traceContext = operation === "extend"
        ? await gatherExtendTraceContext(idx)
        : undefined;
      const prepared = await modelOperationControllerRef.current!.prepare({
        panelIndex: idx,
        operation,
        operationInputs: inputs[operation] ?? {},
        provider,
        modelVoicePubkey: modelPubkey,
        lensId,
        ...(traceContext ? { traceContext } : {}),
      });
      if (
        openSequence !== inspectOpenSequenceRef.current ||
        preparationSequence !== inspectPreparationSequenceRef.current ||
        inspectRequestedOpRef.current !== operation
      ) return;
      setInspectPrepared((current) => ({ ...current, [operation]: prepared }));
      setInspectContext(
        prepared.traceContextSelection?.renderedContext
        ?? prepared.contextSnapshot.renderedBlock,
      );
    } catch (error) {
      if (
        openSequence !== inspectOpenSequenceRef.current ||
        preparationSequence !== inspectPreparationSequenceRef.current ||
        inspectRequestedOpRef.current !== operation
      ) return;
      setInspectPrepared((current) => {
        const next = { ...current };
        delete next[operation];
        return next;
      });
      setInspectPreparationError(error instanceof Error ? error.message : String(error));
    } finally {
      if (
        openSequence === inspectOpenSequenceRef.current &&
        preparationSequence === inspectPreparationSequenceRef.current &&
        inspectRequestedOpRef.current === operation
      ) {
        setInspectPreparing((current) => current === operation ? null : current);
      }
    }
  }

  /** Render bounded, exact excerpts from local stepped heads for Reply. Live
   * unstepped buffers are never paired with an older node id. */
  function renderSteppedTraceReferences(excludePath?: string): string {
    return traceCandidates
      .filter((candidate) => candidate.path !== excludePath)
      .slice(0, 20)
      .flatMap((candidate) => {
        const stepped = lastSteppedRef.current.get(candidate.path)?.content;
        if (stepped === undefined) return [];
        return [
          `- ${JSON.stringify(stepped.slice(0, 512))} ` +
          `(nodeId ${candidate.nodeId}; path ${JSON.stringify(candidate.path)})`,
        ];
      })
      .join("\n");
  }

  /** Reply's citable trace set combines the recent stepped-trace inventory with
   *  the local Mint coin inventory. Both are pure local FileState reads — this
   *  is independent of the Coins rendezvous discovery opt-in (Kademlia), which
   *  governs network publication, not what the local Press can cite. Mint paths
   *  are deliberately excluded from promptContextFiles, so Coins reach the model
   *  only through this explicit request (context-gather §Mint exclusion). */
  function renderReplyCitableTraces(excludePath?: string): string {
    const stepped = renderSteppedTraceReferences(excludePath);
    const coins = renderMintCoinReferences(listMintCoins(filesRef.current));
    return [stepped, coins].filter(Boolean).join("\n");
  }

  /** Hydrate only the selected operation's ancillary input. Extend, Settle,
   * and Stir can prepare immediately from the local editor; Reply's stepped
   * trace inventory and Analyze's limelight history never delay those local
   * operations. */
  async function hydrateInspectorInputs(
    operation: PromptOpKind,
    openSequence: number,
  ): Promise<void> {
    if (inspectInputsReadyRef.current[operation]) return;
    const inputs = inspectInputsRef.current;
    if (operation === "reply") {
      if (openSequence !== inspectOpenSequenceRef.current) return;
      inputs.reply = {
        ...inputs.reply,
        traces: renderReplyCitableTraces(panels[opTargetPanel()]?.active),
      };
    } else if (operation === "analyze") {
      try {
        const focus = folder ? await focusTimeline(folder.id) : [];
        if (openSequence !== inspectOpenSequenceRef.current) return;
        inputs.analyze = {
          ...inputs.analyze,
          limelightLog: folder
            ? renderLimelightLog(focus, folder.label ?? DEFAULT_ROOT_LABEL)
            : "",
        };
      } catch {
        if (openSequence !== inspectOpenSequenceRef.current) return;
        inputs.analyze = { ...inputs.analyze, limelightLog: "" };
        setInspectNotes((current) => ({
          ...current,
          analyze: "The limelight fetch failed; Analyze will continue with the trace log, Step history, and file contents.",
        }));
      }
    }
    if (openSequence !== inspectOpenSequenceRef.current) return;
    inspectInputsRef.current = inputs;
    inspectInputsReadyRef.current[operation] = true;
  }

  async function prepareInspectorSelection(
    operation: PromptOpKind,
    lensId: OpLensId = inspectLensSelectionsRef.current[operation],
    openSequence = inspectOpenSequenceRef.current,
  ): Promise<void> {
    const preparationSequence = ++inspectPreparationSequenceRef.current;
    inspectRequestedOpRef.current = operation;
    setInspectPreparing(operation);
    setInspectPreparationError(null);
    await hydrateInspectorInputs(operation, openSequence);
    if (
      openSequence !== inspectOpenSequenceRef.current ||
      preparationSequence !== inspectPreparationSequenceRef.current ||
      inspectRequestedOpRef.current !== operation
    ) return;
    await prepareInspectorOperation(
      operation,
      inspectInputsRef.current,
      lensId,
      openSequence,
      preparationSequence,
    );
  }

  function closeInspector(): void {
    desktopReprepareKeyRef.current = null;
    inspectIsOpenRef.current = false;
    inspectOpenSequenceRef.current++;
    inspectPreparationSequenceRef.current++;
    inspectInputsReadyRef.current = {
      extend: false,
      settle: false,
      stir: false,
      reply: false,
      analyze: false,
    };
    setInspectPreparing(null);
    setInspectOp(null);
  }

  /** Open the inspector: gather the context block + derive inputs against the
   *  op-target panel, then show the modal. Async because the context block's
   *  directory-log fetch is async (memoized). */
  async function openInspector(defaultOperation: PromptOpKind = "extend") {
    const openSequence = ++inspectOpenSequenceRef.current;
    inspectIsOpenRef.current = true;
    const inputs = deriveInspectInputs();
    const notes: Partial<Record<PromptOpKind, string>> = {
      settle: "Bracket spans appear as protected anchor tokens in the request and are restored byte-for-byte after the complete response.",
    };
    inspectInputsRef.current = inputs;
    inspectInputsReadyRef.current = {
      extend: true,
      settle: true,
      stir: true,
      reply: false,
      analyze: false,
    };
    inspectRequestedOpRef.current = defaultOperation;
    setInspectContext("");
    setInspectNotes(notes);
    setInspectPrepared({});
    setInspectPreparationError(null);
    setInspectOp(defaultOperation);
    setInspectPreparing(defaultOperation);
    await prepareInspectorSelection(
      defaultOperation,
      inspectLensSelectionsRef.current[defaultOperation],
      openSequence,
    );
  }

  /** Begin an in-place op: mark running, reserve the focused path, arm
   * cancellation, and hold crash-pad observation until the one atomic apply.
   * The MODEL voice is carried by opVoiceEffect on that transaction; the
   * later explicit Step remains owned by the trace's AUTHOR key. */
  function beginOp(
    idx: number,
    signer: Uint8Array | undefined,
    op: "extend" | "settle" | "stir",
  ): { controller: AbortController } | null {
    const view = panelViews.current[idx];
    if (!view) {
      // Without a mounted editor view there is nowhere to apply the buffered
      // result. Surface this instead of
      // silently no-oping (the old `return null` left the button looking dead:
      // no "running", no "error", nothing). opTargetPanel normally steers ops
      // at a panel whose active tab is the file, but a stale layout, a folder
      // tab, or a not-yet-mounted editor (right after reload) can still miss.
      setOpStatus(idx, "error", "no editor mounted for this panel — click the file's tab first", op);
      return null;
    }
    const path = panels[idx]?.active ?? "";
    if (!path) {
      setOpStatus(idx, "error", "no file active in this panel", op);
      return null;
    }
    if (activeOpPathsRef.current.has(path)) {
      setOpStatus(idx, "error", "another model operation is already writing this file", op);
      return null;
    }
    setOpStatus(idx, "running", undefined, op);
    activeOpPathsRef.current.add(path);
    opContextsRef.current.set(idx, { path, signer });
    stepGateRef.current(true);
    const controller = new AbortController();
    summonAbort.current[idx] = controller;
    return { controller };
  }

  /** End an op after React commits its atomic transaction. Release mirrors the
   * complete unstepped buffer and pins MODEL metadata for the next explicit
   * Step; it never publishes on its own. */
  function endOp(idx: number, llmMeta?: LlmStepMeta | null) {
    summonAbort.current[idx] = null;
    const context = opContextsRef.current.get(idx);
    if (!context) return;
    setTimeout(() => {
      opContextsRef.current.delete(idx);
      activeOpPathsRef.current.delete(context.path);
      stepGateRef.current(false, context.signer, context.path, llmMeta);
    }, 0);
  }

  /** §3.7: prepare rule/scope/model metadata for the later explicit Step.
   * Scope is pinned to call time even though publication is deferred. */
  async function prepareLlmMeta(
    idx: number,
    op: "extend" | "settle" | "stir" | "reply" | "analyze",
    provider: ProviderConfig | null,
    prompt: string,
    maxTokens: number,
  ): Promise<LlmStepMeta | null> {
    if (!folder || !provider) return null;
    const activePath = panels[idx]?.active ?? "";
    try {
      const manifest = {
        algorithm: "ctx-block-v1",
        params: {
          op,
          folderLabel: folder.label ?? DEFAULT_ROOT_LABEL,
          activePath,
          promptProfile: "op-contract-v2",
          lens: opLenses[op],
        },
      };
      const injectRule = await getOrCreateRuleTrace(folder.id, manifest);
      const members = await fetchManifest(folder.id);
      const effectiveMembers = members.filter(
        (member) =>
          isInScope(scopeRef.current, shieldedRef.current, member.relativePath),
      );
      const activeNodeId =
        activePath && isInScope(scopeRef.current, shieldedRef.current, activePath)
          ? (files[activePath]?.nodeId ?? null)
          : null;
      const scopeCitations = [
        ...effectiveMembers.map((m) => m.latestNodeId).filter((id): id is string => !!id),
        ...(activeNodeId ? [activeNodeId] : []),
      ].filter((id, i, arr) => arr.indexOf(id) === i);
      return {
        prompt,
        injectRule,
        scopeCitations,
        llm: {
          model: provider.modelId,
          // null = "no temperature sent" (the client passes none → provider
          // default). NOT 0 — that would claim deterministic decoding. Records
          // the actual value once the ops grow real temperature control.
          temperature: null,
          maxTokens,
          provider: provider.label || provider.protocol,
        },
      };
    } catch {
      /* best-effort — scope pinning is telemetry, never blocks the op */
      return null;
    }
  }

  /** EXTEND — persist the exact Inspector-approved request before provider I/O.
   * Completion is provisional and never edits, Steps, mints, or publishes. */
  async function extendLLM(idx: number, approvedRequest?: PreparedOperation) {
    if (!approvedRequest || approvedRequest.operation !== "extend") {
      // Autofire (no pre-approved request from the Inspector): resolve the
      // provider, gather the focused file's trace context, and prepare the
      // request inline via the same controller the Inspector uses — then fall
      // through to the durable desktop runtime path below. The Inspector is
      // still reachable via the per-op chevron for an exact-prompt preview.
      const provider = resolveOpProvider(idx, modelPubkey, "extend");
      if (!provider) return;
      setOpStatus(idx, "running", undefined, "extend");
      try {
        const traceContext = await gatherExtendTraceContext(idx);
        const inputs = deriveInspectInputs().extend ?? {};
        const prepared = await modelOperationControllerRef.current!.prepare({
          panelIndex: idx,
          operation: "extend",
          operationInputs: inputs,
          provider,
          modelVoicePubkey: modelPubkey,
          lensId: opLenses.extend,
          traceContext,
        });
        approvedRequest = prepared;
      } catch (error) {
        setOpStatus(idx, "error", error instanceof Error ? error.message : String(error), "extend");
        return;
      }
    }
    const runtime = desktopOperationRuntimeRef.current;
    const provider = providersRef.current.find(
      (candidate) => candidate.id === approvedRequest.providerId,
    );
    if (!runtime || !provider) {
      setOpStatus(idx, "error", "The approved desktop provider is unavailable", "extend");
      return;
    }
    if (!approvedRequest.traceContextSelection) {
      setOpStatus(idx, "error", "Extend must be re-inspected with exact trace context", "extend");
      return;
    }
    const controller = new AbortController();
    desktopOperationAbortControllersRef.current.add(controller);
    summonAbort.current[idx] = controller;
    setOpStatus(idx, "running", undefined, "extend");
    try {
      let envelope = await runtime.persistApprovedExtend({
        prepared: approvedRequest,
        provider,
        maxOutputTokens: 4096,
      });
      if (!controller.signal.aborted) {
        desktopAuthorizedAttemptKeysRef.current.add(
          desktopOperationAttemptKeyV1(envelope.operationId, envelope.attempt.attemptId),
        );
      }
      upsertDesktopOperationEnvelope(envelope);
      if (controller.signal.aborted) {
        envelope = await runtime.cancel({
          operationId: envelope.operationId,
          attemptId: envelope.attempt.attemptId,
        });
        upsertDesktopOperationEnvelope(envelope);
        setOpStatus(idx, "idle");
        return;
      }
      envelope = await runtime.approve({
        operationId: envelope.operationId,
        attemptId: envelope.attempt.attemptId,
      });
      upsertDesktopOperationEnvelope(envelope);
      if (controller.signal.aborted && envelope.lifecycle.status === "approved") {
        envelope = await runtime.cancel({
          operationId: envelope.operationId,
          attemptId: envelope.attempt.attemptId,
        });
        upsertDesktopOperationEnvelope(envelope);
        setOpStatus(idx, "idle");
        return;
      }
      envelope = await runtime.dispatch({
        operationId: envelope.operationId,
        attemptId: envelope.attempt.attemptId,
      }, { signal: controller.signal });
      upsertDesktopOperationEnvelope(envelope);
      if (envelope.lifecycle.status === "response-completed") {
        setOpStatus(idx, "done", "AI draft ready for local review", "extend");
      } else if (envelope.lifecycle.status === "unknown") {
        setOpStatus(idx, "error", "Provider outcome unknown — review before retrying", "extend");
      } else if (envelope.lifecycle.status === "failed") {
        setOpStatus(idx, "error", "Extend failed — review the saved attempt", "extend");
      } else {
        setOpStatus(idx, "idle");
      }
      await refreshDesktopOperationEnvelopes();
    } catch (error) {
      setOpStatus(idx, "error", error instanceof Error ? error.message : String(error), "extend");
      await refreshDesktopOperationEnvelopes().catch(() => undefined);
    } finally {
      desktopOperationAbortControllersRef.current.delete(controller);
      if (summonAbort.current[idx] === controller) summonAbort.current[idx] = null;
    }
  }

  /** Settle (de-dupe mode): collapse near-duplicate files in the scope subtree
   *  into one voiced revision. Triggered when Settle runs with a FOLDER in scope
   *  (the whole-subtree target) rather than a single file focus. Candidate
   *  duplicates are grouped by a cheap content signature (normalized prefix);
   *  each group of 2+ is sent to the LLM to merge, the merged result overwrites
   *  the first (keeper) file, and the redundant copies are deleted.
   *
   *  This is the deliberate gesture that collapses adopted/imported
   *  redundancy after source material has entered Root. Nothing happens
   *  between gestures. */
  function settleDeDupeLLM(idx: number) {
    setOpStatus(
      idx,
      "error",
      "Folder focus is available for replay; AI Settle needs one focused, stepped file",
      "settle",
    );
  }

  /** SETTLE - condense the loose (non-bracketed) prose in place; preserve
   *  `[[ ]]` spans verbatim (never regenerate them). Repeated rounds drive the
   *  file toward only bracketed text. With a selection, condenses only the
   *  selected range (replacing it in place); otherwise the whole document.
   *  One CM6 transaction -> one undo restores. */
  async function settleLLM(idx: number) {
    const pubkey = modelPubkey;
    const provider = resolveOpProvider(idx, pubkey, "settle");
    if (!provider) return;
    const started = beginOp(idx, secretKeyForVoice(authorPubkey) ?? undefined, "settle");
    if (!started) return;
    const { controller } = started;
    let llmMeta: LlmStepMeta | null = null;
    const view = panelViews.current[idx]!;
    try {
      const sel = view.state.selection.main;
      const hasSel = sel.from !== sel.to;
      const from = hasSel ? sel.from : 0;
      const to = hasSel ? sel.to : view.state.doc.length;
      const text = view.state.sliceDoc(from, to);
      llmMeta = await prepareLlmMeta(idx, "settle", provider, text, 512);
      const encoded = encodeSettleAnchors(text);
      const inputs: OpInputs = {
        loose: encoded.promptText,
        rangeFrom: from,
        rangeTo: to,
        sourceFrom: from,
        sourceTo: to,
      };
      const { prepared, result } = await modelOperationControllerRef.current!.executeApproved({
        panelIndex: idx,
        operation: "settle",
        operationInputs: inputs,
        provider,
        modelVoicePubkey: pubkey,
        lensId: opLenses.settle,
        maxTokens: 512,
        signal: controller.signal,
        onStale: (recovery) => setStaleModelResult(recovery),
        apply: (response, approved) => {
          const authoring = approved.traceAuthoring;
          if (!authoring) throw new Error("Settle trace-authoring preparation is missing");
          const next = validateTraceAuthoringResult(authoring, response);
          if (next === text) return;
          view.dispatch({
            changes: {
              from: approved.operationInputs.rangeFrom ?? from,
              to: approved.operationInputs.rangeTo ?? to,
              insert: next,
            },
            effects: opVoiceEffect.of(pubkey),
          });
        },
      });
      if (result.status === "cancelled") {
        setOpStatus(idx, "idle");
        return;
      }
      if (result.status === "stale") {
        setOpStatus(idx, "error", "AI response held because focus or the file changed", "settle");
        return;
      }
      recordModelLessonResult(prepared, result.response);
      setOpStatus(idx, "done", undefined, "settle");
    } catch (e) {
      if (controller.signal.aborted) {
        setOpStatus(idx, "idle");
        return;
      }
      setOpStatus(idx, "error", e instanceof Error ? e.message : String(e), "settle");
    } finally {
      endOp(idx, llmMeta);
    }
  }

  /** SHAKE — preserve `[[ ]]` anchors verbatim, execute each `(( command ))`
   *  directive, reinvent the loose prose around the anchors, and drop the
   *  consumed commands. With a selection, reinvents only the selected range
   *  (replacing it in place); otherwise the whole document. One CM6
   *  transaction → one undo restores everything (loose prose, anchors, commands). */
  async function stirLLM(idx: number) {
    const pubkey = modelPubkey;
    const provider = resolveOpProvider(idx, pubkey, "stir");
    if (!provider) return;
    const started = beginOp(idx, secretKeyForVoice(authorPubkey) ?? undefined, "stir");
    if (!started) return;
    const { controller } = started;
    let llmMeta: LlmStepMeta | null = null;
    const view = panelViews.current[idx]!;
    try {
      const sel = view.state.selection.main;
      const hasSel = sel.from !== sel.to;
      const from = hasSel ? sel.from : 0;
      const to = hasSel ? sel.to : view.state.doc.length;
      const text = view.state.sliceDoc(from, to);
      llmMeta = await prepareLlmMeta(idx, "stir", provider, text, 1024);
      // One-step Stir: gather the (( commands )) + loose prose + anchor count,
      // hand them to the model in a single call, then re-weave the verbatim
      // bracket anchors back into the rewrite. Commands are stripped from the
      // loose prose the model sees and never appear in the output.
      const cmds = findCommands(text);
      // Strip command ranges (from the same parser that found them) out of the
      // full text, then partition what's left. Single source of truth for what
      // counts as a command — no second-match regex to drift from iterCommands.
      const stripped = stripRanges(text, cmds.map((c) => [c.matchStart, c.matchEnd] as [number, number]));
      const loose = partitionDoc(stripped)
        .filter((p) => p.kind === "loose")
        .map((p) => p.text)
        .join("\n")
        .trim();
      const anchorCount = [...iterBrackets(text)].length;
      const inputs: OpInputs = {
        loose,
        anchorCount,
        commands: cmds.map((c) => c.command),
        rangeFrom: from,
        rangeTo: to,
      };
      const { prepared, result } = await modelOperationControllerRef.current!.executeApproved({
        panelIndex: idx,
        operation: "stir",
        operationInputs: inputs,
        provider,
        modelVoicePubkey: pubkey,
        lensId: opLenses.stir,
        maxTokens: 1024,
        signal: controller.signal,
        onStale: (recovery) => setStaleModelResult(recovery),
        apply: (response, approved) => {
          const next = reweaveAnchors(response, text);
          view.dispatch({
            changes: {
              from: approved.operationInputs.rangeFrom ?? from,
              to: approved.operationInputs.rangeTo ?? to,
              insert: next,
            },
            effects: opVoiceEffect.of(pubkey),
          });
        },
      });
      if (result.status === "cancelled") {
        setOpStatus(idx, "idle");
        return;
      }
      if (result.status === "stale") {
        setOpStatus(idx, "error", "AI response held because focus or the file changed", "stir");
        return;
      }
      recordModelLessonResult(prepared, result.response);
      setOpStatus(idx, "done", undefined, "stir");
    } catch (e) {
      if (controller.signal.aborted) {
        setOpStatus(idx, "idle");
        return;
      }
      setOpStatus(idx, "error", e instanceof Error ? e.message : String(e), "stir");
    } finally {
      endOp(idx, llmMeta);
    }
  }

  /** RESPOND — buffer an AI response into a NEW unstepped sibling doc, citing available
   *  stepped traces via [[ phrase | nodeId ]], and citing the source itself
   *  via `replyingTo` (spec §reply-to delta type) so the reply chain
   *  stays legible from the trace alone. Placement: the sibling opens in a fresh
   *  column immediately to the right of the source panel (`idx`) — auto-spawning
   *  that column first so the reply always lands alongside its origin.
   *  The model names the file via a leading `TITLE:` line (see
   *  RESPOND_MESSAGES); the TITLE line is stripped before the atomic apply. */
  async function replyLLM(idx: number, approvedRequest?: PreparedOperation) {
    if (!folder) return;
    const modelVoice = modelPubkey;
    const provider = resolveOpProvider(idx, modelVoice, "reply");
    if (!provider) return;
    setOpStatus(idx, "running", undefined, "reply");
    const controller = new AbortController();
    summonAbort.current[idx] = controller;
    try {
      const view = panelViews.current[idx];
      const srcRel = panels[idx].active || "";
      let inputs: OpInputs;
      if (approvedRequest?.operation === "reply") {
        inputs = { ...approvedRequest.operationInputs };
      } else {
        const sel = view?.state.selection.main;
        const hasSel = !!sel && sel.from !== sel.to;
        const sourceText = hasSel
          ? view!.state.sliceDoc(sel!.from, sel!.to)
          : (srcRel && filesRef.current[srcRel] ? flatten(filesRef.current[srcRel].runs) : "");
        const sourceFrom = hasSel ? sel!.from : 0;
        const sourceTo = hasSel ? sel!.to : sourceText.length;
        const traces = renderReplyCitableTraces(srcRel);
        inputs = { source: sourceText, traces, sourceFrom, sourceTo };
      }
      const sourceText = inputs.source ?? "";
      const sourceNodeId = filesRef.current[srcRel]?.nodeId || undefined;
      let llmMeta: LlmStepMeta | null = null;
      const { prepared, result } = await modelOperationControllerRef.current!.executeApproved({
        panelIndex: idx,
        operation: "reply",
        operationInputs: inputs,
        provider,
        modelVoicePubkey: modelVoice,
        lensId: opLenses.reply,
        maxTokens: 1024,
        signal: controller.signal,
        beforeExecute: async () => {
          llmMeta = await prepareLlmMeta(idx, "reply", provider, sourceText, 1024);
          if (llmMeta && sourceNodeId) llmMeta.replyingTo = sourceNodeId;
        },
        onStale: (recovery) => setStaleModelResult(recovery),
        apply: (response) => {
          const parsed = parseReplyOutput(response, true);
          const sourceName = srcRel || "doc.md";
          const slash = sourceName.lastIndexOf("/");
          const srcDir = slash >= 0 ? sourceName.slice(0, slash + 1) : "";
          const stem = sourceName.replace(/\.md$/, "").split("/").pop() || "doc";
          const datePrefix = formatLocalSecondStamp(new Date());
          const label = parsed.title
            ? slugifyFilename(parsed.title.replace(/\.md$/i, ""))
            : `${stem}-reply`;
          const newPath = uniquePath(
            `${srcDir}${datePrefix}-${label}.md`,
            new Set(Object.keys(filesRef.current)),
          );
          const runs = [{ voice: modelVoice, text: parsed.body }];
          editFile(newPath, runs);
          if (llmMeta) setPendingLlmMeta(newPath, llmMeta);
          const destIdx = idx + 1;
          spawnPanel(destIdx);
          openInPanel(newPath, destIdx);
        },
      });
      if (result.status === "cancelled") {
        setOpStatus(idx, "idle");
        return;
      }
      if (result.status === "stale") {
        setOpStatus(idx, "error", "AI response held because focus or the source changed", "reply");
        return;
      }
      recordModelLessonResult(prepared, result.response);
      setOpStatus(idx, "done", undefined, "reply");
    } catch (e) {
      if (controller.signal.aborted) {
        setOpStatus(idx, "idle");
        return;
      }
      setOpStatus(idx, "error", e instanceof Error ? e.message : String(e), "reply");
    } finally {
      summonAbort.current[idx] = null;
    }
  }

  /** Analyze: read the validated editor-transaction trace, Step history, file
   *  contents, and limelight log into an ordinary cited review document. The
   *  prepared request freezes the exact trace log; the output cites every
   *  analyzed source head and remains an editable, unstepped Zine file so the
   *  human and AI can continue their review in the same traced medium. */
  async function analyzeLLM(idx: number, approvedRequest?: PreparedOperation) {
    if (!folder) return;
    const modelVoice = modelPubkey;
    const provider = resolveOpProvider(idx, modelVoice, "analyze");
    if (!provider) return;
    setOpStatus(idx, "running", undefined, "analyze");
    const controller = new AbortController();
    summonAbort.current[idx] = controller;
    try {
      const srcRel = panels[idx].active || "";
      let inputs: OpInputs;
      if (approvedRequest?.operation === "analyze") {
        inputs = { ...approvedRequest.operationInputs };
      } else {
        // Pull the folder's focus chain (panel-occupancy history) and render it
        // as the limelight log. An empty chain yields "" and the Analyze prompt
        // tells the AI to analyze only what it has.
        let limelightLog = "";
        try {
          const focus: FocusEntry[] = await focusTimeline(folder.id);
          limelightLog = renderLimelightLog(focus, folder.label ?? DEFAULT_ROOT_LABEL);
        } catch {
          /* no focus chain is fine — the persona covers the missing-data case */
        }
        inputs = { limelightLog };
      }
      const limelightLog = inputs.limelightLog ?? "";
      let llmMeta: LlmStepMeta | null = null;
      let sourceHeadIds: string[] = [];
      const { prepared, result } = await modelOperationControllerRef.current!.executeApproved({
        panelIndex: idx,
        operation: "analyze",
        operationInputs: inputs,
        provider,
        modelVoicePubkey: modelVoice,
        lensId: opLenses.analyze,
        maxTokens: 2048,
        signal: controller.signal,
        beforeExecute: async (approved) => {
          const traceLog = approved.operationInputs.traceLog ?? "";
          const analysisPrompt = [traceLog, limelightLog].filter(Boolean).join("\n\n");
          llmMeta = await prepareLlmMeta(idx, "analyze", provider, analysisPrompt, 2048);
          sourceHeadIds = approved.contextSnapshot.inputs
            .map((input) => input.headId)
            .filter((id): id is string => Boolean(id))
            .filter((id, index, ids) => ids.indexOf(id) === index);
        },
        onStale: (recovery) => setStaleModelResult(recovery),
        apply: (response) => {
          const parsed = parseReplyOutput(response, true);
          const sourceName = srcRel || "doc.md";
          const slash = sourceName.lastIndexOf("/");
          const srcDir = slash >= 0 ? sourceName.slice(0, slash + 1) : "";
          const stem = sourceName.replace(/\.md$/, "").split("/").pop() || "doc";
          const datePrefix = formatLocalSecondStamp(new Date());
          const label = parsed.title
            ? slugifyFilename(parsed.title.replace(/\.md$/i, ""))
            : `${stem}-analysis`;
          const newPath = uniquePath(
            `${srcDir}${datePrefix}-${label}.md`,
            new Set(Object.keys(filesRef.current)),
          );
          const runs = [{ voice: modelVoice, text: parsed.body }];
          editFile(newPath, runs);
          editCitations(newPath, sourceHeadIds);
          if (llmMeta) setPendingLlmMeta(newPath, llmMeta);
          const destIdx = idx + 1;
          spawnPanel(destIdx);
          openInPanel(newPath, destIdx);
        },
      });
      if (result.status === "cancelled") {
        setOpStatus(idx, "idle");
        return;
      }
      if (result.status === "stale") {
        setOpStatus(idx, "error", "AI response held because focus or the source changed", "analyze");
        return;
      }
      recordModelLessonResult(prepared, result.response);
      setOpStatus(idx, "done", undefined, "analyze");
    } catch (e) {
      if (controller.signal.aborted) {
        setOpStatus(idx, "idle");
        return;
      }
      setOpStatus(idx, "error", e instanceof Error ? e.message : String(e), "analyze");
    } finally {
      summonAbort.current[idx] = null;
    }
  }

  /** Wait for panel idx's CodeMirror EditorView to be mounted, polling on
   *  animation frames. FileEditor reports its view via onView only on mount
   *  (empty deps), so right after we activate a file tab in a panel that was
   *  showing its empty/folder state the view isn't up yet — this bridges that
   *  gap without racing on a fixed timeout. Returns null if nothing mounts in
   *  time (e.g. the panel was closed mid-wait), letting the caller fall back to
   *  the original "no editor mounted" error rather than silently no-oping. */
  async function awaitViewMount(idx: number, timeoutMs = 800): Promise<EditorView | null> {
    const start = performance.now();
    while (performance.now() - start < timeoutMs) {
      const v = panelViews.current[idx];
      if (v) return v;
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
    }
    return panelViews.current[idx] ?? null;
  }

  /** Resolve after two animation frames so React has committed a state update
   *  AND its passive effects (FileEditor's doc-swap setRuns effect) have run —
   *  used to let an already-mounted editor swap its doc to the newly-active
   *  file before an op reads view.state. */
  function nextPaint(): Promise<void> {
    return new Promise((r) =>
      requestAnimationFrame(() => requestAnimationFrame(() => r())),
    );
  }

  /** Dispatch a top-bar action to the op-target panel. MODEL ops apply dirty
   *  attributed buffers; Step/Send later checkpoint them as the AUTHOR owner.
   *
   *  Extend/Settle/Stir stream into the target panel's mounted CodeMirror view
   *  via view.dispatch, so they need that view live AND showing the selected
   *  file. opTargetPanel prefers a panel whose active tab is the file (view
   *  mounted there), but a file that's only a background tab — or a focused
   *  panel stuck on its empty/folder state — leaves no editor mounted, and
   *  beginOp would surface "no editor mounted for this panel — click the file's
   *  tab first". Instead of making the user click the tab, activate the file as
   *  the panel's active tab here and wait for FileEditor to mount / swap its doc
   *  before dispatching. Reply/Step/Send/Attest don't stream into the view
   *  (Reply writes a sibling file; the rest step), so they're left as-is. */
  async function runOp(idx: number, op: OpKind, approvedRequest?: PreparedOperation) {
    if (!canSignWithSecrets()) {
      setOpStatus(idx, "error", "authoring is available in the unlocked desktop press", op);
      return;
    }
    const target = panels[idx]?.active;
    if (target && isCoinTab(target) && !isCompletedCoinFile(files[target])) {
      setOpStatus(idx, "error", "This incomplete Mint artifact has no Coin actions", op);
      return;
    }
    // Mint, Scan, and Oblivion are read-only: no LLM/content op may write into
    // any of them
    // system region. Send is allowed for an immutable Mint coin because it
    // changes reachability, not content; Attest is also non-mutating.
    if (op !== "attest") {
      if (
        target &&
        !isFolderTab(target) &&
        (isScan(target) || isOblivion(target) || (isMint(target) && op !== "send"))
      ) {
        setOpStatus(idx, "error", "Scan and Oblivion are read-only — adopt, fork, or restore into Root first", op);
        return;
      }
    }
    if (op === "extend" || op === "settle" || op === "stir") {
      const path = uiFocus?.kind === "file" ? uiFocus.path : undefined;
      if (path && !isFolderTab(path) && panels[idx]?.tabs.includes(path)) {
        const needSwap = panels[idx].active !== path;
        if (needSwap) {
          setPanels((prev) => mapPanel(prev, idx, (p) => ({ ...p, active: path })));
        }
        if (!panelViews.current[idx]) {
          // Empty/folder panel: no editor yet — wait for the mount.
          const v = await awaitViewMount(idx);
          if (!v) {
            setOpStatus(idx, "error", "no editor mounted for this panel — click the file's tab first", op);
            return;
          }
        } else if (needSwap) {
          // Editor mounted for a different tab: let the doc-swap effect commit
          // before the op reads view.state.
          await nextPaint();
        }
      }
    }
    if (op === "extend") void extendLLM(idx, approvedRequest);
    // Settle has two modes. When the op-target panel focuses a FOLDER tab,
    // run de-dupe: collapse near-duplicate files in the scope subtree into one
    // voiced revision (the gesture that cleans up adopted/imported redundancy).
    // Otherwise the intra-file condenser (condense loose prose, keep brackets).
    else if (op === "settle") {
      const active = panels[idx]?.active;
      void (active && isFolderTab(active) ? settleDeDupeLLM(idx) : settleLLM(idx));
    }
    else if (op === "stir") void stirLLM(idx);
    else if (op === "reply") void replyLLM(idx, approvedRequest);
    else if (op === "analyze") void analyzeLLM(idx, approvedRequest);
    else if (op === "step" || op === "send") void deliverAsVoice(idx, op);
    else if (op === "attest") {
      // Attest opens the optional note/location modal before any prerequisite
      // runs. Confirmation may Step and/or Send, then targets that exact node
      // with the separate append-only endorsement event.
      const candidate = paletteAttestCandidate();
      const plan = paletteAttestationPlan(candidate);
      if (candidate && plan !== "unavailable") {
        setAttestTarget({ ...candidate, plan });
      }
    }
    else if (op === "run") {
      // Run opens the modal first: the user types a goal and picks a root
      // model. The modal calls back with both on Start. Like attest, the
      // gesture is two-step (compose → confirm) because it takes freeform input.
      setRunOpen(true);
    }
  }

  /**
   * Start an agent run from a composed goal + provider. Builds the AgentCtx
   * from the live app closures (scope, files, providers, nostr secret), picks
   * a sandbox subfolder under the current scope, and drives runAgentLoop.
   *
   * The loop never steps — it writes DRAFT FileState (nodeId "") into the run
   * subfolder; the per-render files effect mirrors those to the crash pad and
   * nothing more. The human author's Step is the only thing that freezes them.
   * Stop reuses the existing per-panel AbortController / op-status surface, so
   * the Run button re-renders as a stop control while the loop is in flight.
   */
  async function startAgentRun(
    goal: string,
    providerId: string,
    launch: {
      trigger: AgentRunTrigger;
      recipeId?: string;
      recipeLabel?: string;
      workspaceId?: string;
      scopes?: AutomationScopes;
    } = { trigger: "manual" },
  ) {
    const idx = opTargetPanel();
    const runWorkspaceId = launch.workspaceId ?? folderIdRef.current;
    if (!folder || !runWorkspaceId || folder.id !== runWorkspaceId) {
      setOpStatus(idx, "error", "open the recipe's bound workspace before running it", "run");
      return;
    }
    const sourceScope = launch.scopes?.[0] ?? scopeRef.current[0];
    const runScopes: AutomationScopes = sourceScope
      ? [{ kind: sourceScope.kind, path: sourceScope.path }]
      : [];
    if (!automationScopesAvailable(runScopes)) {
      setOpStatus(idx, "error", "the recipe's bound scope no longer exists — update the recipe", "run");
      return;
    }
    const provider = providers.find((p) => p.id === providerId) ?? null;
    if (!provider) {
      setOpStatus(idx, "error", "no provider — add one in Models", "run");
      return;
    }
    const startedAtMs = Date.now();
    if (launch.recipeId) {
      setAutomationRecipes(markAutomationRecipeStarted(launch.recipeId, startedAtMs));
    }
    if (launch.trigger === "manual") setRunOpen(false);
    setOpStatus(idx, "running", undefined, "run");
    const controller = new AbortController();
    summonAbort.current[idx] = controller;

    // Sandbox path: a subfolder under the current scope. If the scope is a
    // file, place it as a sibling in the file's parent. Leading underscore so
    // run folders sort away from the manuscript.
    const scopeSel = runScopes[0];
    const scopePath = scopeSel?.path ?? "";
    const parent =
      scopeSel?.kind === "file" && scopePath.includes("/")
        ? scopePath.slice(0, scopePath.lastIndexOf("/"))
        : scopeSel?.kind === "file"
          ? ""
          : scopePath;
    const slug = goal.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "run";
    const short = Math.random().toString(16).slice(2, 8);
    const runPath = `${parent ? parent + "/" : ""}_${slug}-${short}`;
    const runId = `run-${startedAtMs.toString(36)}-${short}`;
    const modelRootSecret = modelSecretKey();
    if (!modelRootSecret) {
      setOpStatus(idx, "error", "unlock an AI signing key before running", "run");
      return;
    }
    const modelVoice = ensureModelVoice(modelRootSecret, provider.modelId, provider.label);
    const runWorkspace = folder;
    const runShielded = new Set(shieldedRef.current);
    const isRunPath = (path: string) => path === runPath || path.startsWith(`${runPath}/`);
    const stillInWorkspace = () => folderIdRef.current === runWorkspaceId;
    const scopedRead = (path: string) =>
      isRunPath(path) || isInScope(runScopes, runShielded, path);
    // Agent tools mutate draft files without going through CodeMirror. Record
    // each tool write as one synthetic atomic KEdit and synchronously journal
    // it, so their process is as durable as a human editor transaction.
    const agentDrafts = new Map<string, FileState>();
    const stageAgentDraft = (path: string, runs: Run[], allowDetached = false): void => {
      if (!isRunPath(path)) return;
      if (!stillInWorkspace() && !allowDetached) {
        controller.abort();
        return;
      }
      const previous = agentDrafts.get(path) ?? filesRef.current[path];
      const previousText = previous ? flatten(previous.runs) : "";
      const nextText = flatten(runs);
      const baseLog = previous?.kedits ?? EMPTY_KEDIT_LOG;
      const voice = runs.find((run) => run.text.length > 0)?.voice ?? modelVoice.pubkey;
      const additions = synthesizeKEditTransition(
        previousText,
        nextText,
        voice,
        Date.now(),
        nextKEditTx(baseLog),
      );
      const nextLog = appendKEditLog(baseLog, additions);
      const next: FileState = {
        ...previous,
        runs,
        nodeId: previous?.nodeId ?? "",
        tags: previous?.tags ?? [],
        updatedAt: Date.now(),
        ...(nextLog.length > 0 ? { kedits: nextLog } : {}),
      };
      agentDrafts.set(path, next);
      mirrorPad(runWorkspaceId, path, {
        content: nextText,
        tags: next.tags,
        nodeId: next.nodeId,
        traceId: next.traceId,
        runs,
        citationIds: next.citationIds,
        kedits: keditLogToArray(nextLog),
        voicePubkey: voice,
      });
      if (!stillInWorkspace()) return;
      filesRef.current = { ...filesRef.current, [path]: next };
      setFilesRef.current((current) => ({
        ...current,
        [path]: { ...current[path], ...next },
      }));
    };

    const ctx: AgentCtx = {
      nostrSecret: modelRootSecret,
      resolveModel: (ref) =>
        providers.find((p) => p.id === ref || p.label === ref || p.modelId === ref) ?? provider,
      readFile: (p) => {
        if (!stillInWorkspace()) {
          controller.abort();
          return null;
        }
        if (!scopedRead(p)) return null;
        const f = filesRef.current[p];
        return f ? flatten(f.runs ?? []) : null;
      },
      listFiles: (prefix) => {
        if (!stillInWorkspace()) {
          controller.abort();
          return [];
        }
        return Object.keys(filesRef.current).filter((p) =>
          scopedRead(p) && (!prefix || p.startsWith(prefix)),
        );
      },
      writeDraft: (path, runs) => stageAgentDraft(path, runs),
      appendDraft: (path, voice, text) => {
        const existing = agentDrafts.get(path) ?? filesRef.current[path];
        stageAgentDraft(path, [...(existing?.runs ?? []), { voice, text }]);
      },
      runPath,
      seedContext: "",
    };

    const recipeLabel = launch.recipeLabel ?? automationRecipes.find((recipe) =>
      recipe.id === launch.recipeId,
    )?.label;
    let manifest: AgentRunManifest = {
      version: 1,
      runId,
      runPath,
      trigger: launch.trigger,
      ...(launch.recipeId
        ? { recipe: { id: launch.recipeId, label: recipeLabel ?? "Saved recipe" } }
        : {}),
      goal,
      workspace: {
        id: runWorkspaceId,
        ...(runWorkspace.label ? { label: runWorkspace.label } : {}),
      },
      scopes: runScopes,
      model: {
        providerId: provider.id,
        label: provider.label || provider.modelId || provider.id,
        modelId: provider.modelId,
        protocol: provider.protocol,
      },
      scope: scopeSel ? { kind: scopeSel.kind, path: scopeSel.path } : null,
      status: "running",
      startedAt: new Date(startedAtMs).toISOString(),
      outputPath: `${runPath}/output.md`,
    };
    const writeManifest = () => {
      const path = `${runPath}/run.json`;
      const text = serializeAgentRunManifest(manifest);
      const runs = [{ voice: modelVoice.pubkey, text }];
      // Detached terminal updates still land in the old workspace's pad so a
      // reopen shows both the final status and its exact transition.
      stageAgentDraft(path, runs, true);
    };
    writeManifest();
    const stopForWorkspaceChange = () => {
      controller.abort();
      if (manifest.status === "running") {
        manifest = finishAgentRunManifest(manifest, "stopped");
      }
      writeManifest();
    };
    activeAgentRunsRef.current.set(controller, {
      workspaceId: runWorkspaceId,
      stop: stopForWorkspaceChange,
    });

    // Gather the bound scope, not whatever the user happens to select while a
    // scheduled recipe is starting. Pick a scoped file as the ACTIVE anchor.
    const panelPath = panels[idx]?.active;
    const contextPath = panelPath &&
      !isFolderTab(panelPath) &&
      filesRef.current[panelPath]?.kind !== "folder" &&
      isInScope(runScopes, runShielded, panelPath)
      ? panelPath
      : Object.keys(filesRef.current).find((path) =>
        filesRef.current[path]?.kind !== "folder" &&
        isInScope(runScopes, runShielded, path),
      );
    if (contextPath && stillInWorkspace()) {
      ctx.seedContext = await gatherContextBlock(
        runWorkspace,
        filesRef.current,
        runScopes,
        contextPath,
        runShielded,
      ).catch(() => "");
    }
    if (!stillInWorkspace()) stopForWorkspaceChange();

    try {
      await runAgentLoop(ctx, { goal, model: provider, signal: controller.signal });
      if (controller.signal.aborted) {
        if (manifest.status === "running") {
          manifest = finishAgentRunManifest(manifest, "stopped");
        }
        if (stillInWorkspace()) setOpStatus(idx, "idle");
      } else {
        manifest = finishAgentRunManifest(manifest, "completed");
        if (stillInWorkspace()) setOpStatus(idx, "done", undefined, "run");
      }
      writeManifest();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (controller.signal.aborted) {
        if (manifest.status === "running") {
          manifest = finishAgentRunManifest(manifest, "stopped");
        }
        if (stillInWorkspace()) setOpStatus(idx, "idle");
      } else {
        manifest = finishAgentRunManifest(manifest, "failed", undefined, message);
        if (stillInWorkspace()) setOpStatus(idx, "error", message, "run");
      }
      writeManifest();
    } finally {
      activeAgentRunsRef.current.delete(controller);
      if (summonAbort.current[idx] === controller) summonAbort.current[idx] = null;
    }
  }

  /** Route every AUTHOR/MODEL gesture through the exact live focus locus.
   * Replay projections can be frontmost, but they never become op targets. */
  function opTargetPanel(): number {
    const focus = uiFocusRef.current;
    if (focus) {
      const panel = panels[focus.panelIndex];
      if (
        panel &&
        !panel.replayOwned &&
        panel.active === focus.tabPath &&
        panel.tabs.includes(focus.tabPath)
      ) {
        return focus.panelIndex;
      }
    }
    const live = removeReplayPanels(panels, activePanel);
    return live.panels.length > 0 ? live.activePanel : 0;
  }

  /** Derive the AUTHOR primary slot from the focused editor selection. Only a
   *  Mint entry carrying the durable completion marker is a Coin; incomplete
   *  artifacts remain inert. Otherwise a live range wins over older focus. */
  function paletteSelectionForAuthor(): PaletteSelectionState {
    const targetPanel = opTargetPanel();
    const targetPath = panels[targetPanel]?.active;
    if (targetPath && isCoinTab(targetPath)) {
      return isCompletedCoinFile(files[targetPath]) ? "coin" : "none";
    }
    if (editorSelection?.panelIdx === targetPanel) {
      const view = panelViews.current[targetPanel];
      if (view) {
        return classifyPaletteSelection(
          view.state.doc.toString(),
          editorSelection.from,
          editorSelection.to,
        );
      }
    }
    return uiFocus?.kind === "coin" ? "coin" : "none";
  }

  /** Resolve the selected Coin from either editor markup (Markdown or Preview)
   *  or a Coin selected elsewhere in the app. A live non-Coin range suppresses
   *  stale Coin focus from an earlier click. */
  function paletteSelectedCoin(): { nodeId: string; phrase: string; path: string } | null {
    const targetPanel = opTargetPanel();
    if (editorSelection?.panelIdx === targetPanel) {
      const view = panelViews.current[targetPanel];
      if (!view) return null;
      const bracket = findResolvedBrackets(view.state.doc.toString()).find(
        (candidate) =>
          candidate.matchStart <= editorSelection.from &&
          candidate.matchEnd >= editorSelection.to,
      );
      if (!bracket) return null;
      return {
        nodeId: bracket.nodeId,
        phrase: bracket.phrase,
        path: panels[targetPanel]?.active ?? "",
      };
    }
    if (uiFocus?.kind !== "coin" || !uiFocus.nodeId) return null;
    return {
      nodeId: uiFocus.nodeId,
      phrase: uiFocus.phrase ?? "",
      path: panels[targetPanel]?.active ?? "",
    };
  }

  /** Resolve the exact trace the palette would Attest. Unlike the old gate, a
   *  writable file may have no node yet: confirmation can create its first
   *  Step before Send and endorsement. Coins and folders still need an exact
   *  existing target. */
  function paletteAttestCandidate(): Omit<AttestTarget, "plan"> | null {
    const coin = paletteSelectedCoin();
    if (coin) {
      const label = coin.phrase ? `Coin: ${coin.phrase}` : `Coin ${coin.nodeId.slice(0, 8)}`;
      return { path: label, kind: "coin", nodeId: coin.nodeId };
    }
    if (uiFocus?.kind === "folder") {
      const path = uiFocus.path ?? ROOT;
      const nodeId = uiFocus.nodeId ?? files[path]?.nodeId;
      return nodeId ? { path, kind: "folder", nodeId } : null;
    }
    const path = panels[opTargetPanel()]?.active;
    const file = path ? files[path] : undefined;
    if (!path || !file || file.kind === "folder") return null;
    if (isCoinTab(path)) {
      return isCompletedCoinFile(file) && file.nodeId
        ? { path, kind: "coin", nodeId: file.nodeId }
        : null;
    }
    return { path, kind: "file", ...(file.nodeId ? { nodeId: file.nodeId } : {}) };
  }

  function paletteAttestationPlan(
    candidate = paletteAttestCandidate(),
  ): AttestationPlan {
    if (!candidate) return "unavailable";
    const pending =
      candidate.kind === "file" && unsteppedPathSet.has(candidate.path);
    const nodeId = candidate.nodeId ?? "";
    return planAttestation(pending, nodeId, !!nodeId && sentNodeStatus[nodeId] === true);
  }

  // Resolve the gold prerequisite cue from real external reachability rather
  // than assuming every local head was Sent. Unknown is intentionally shown as
  // auto-delivery until the check settles; confirmation verifies again.
  const paletteAttestNodeId = paletteAttestCandidate()?.nodeId ?? "";
  const paletteAttestNodeIsSent = sentNodeStatus[paletteAttestNodeId];
  useEffect(() => {
    if (!paletteAttestNodeId || paletteAttestNodeIsSent !== undefined) return;
    let cancelled = false;
    void isTraceNodeSent(paletteAttestNodeId)
      .then((sent) => {
        if (!cancelled) {
          setSentNodeStatus((prev) => ({ ...prev, [paletteAttestNodeId]: sent }));
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSentNodeStatus((prev) => ({ ...prev, [paletteAttestNodeId]: false }));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [paletteAttestNodeId, paletteAttestNodeIsSent]);

  /** Apply the palette's Preserve action only to loose prose. The editor command
   *  leaves the phrase selected, so the palette immediately advances to the
   *  pending-bracket state with Mint as its sole passage action. */
  function preservePaletteSelection(): void {
    const targetPanel = opTargetPanel();
    const view = panelViews.current[targetPanel];
    if (!view) return;
    const { from, to } = view.state.selection.main;
    if (classifyPaletteSelection(view.state.doc.toString(), from, to) !== "loose") return;
    wrapSelectionCommand()(view);
  }

  /** Use the delivery planner itself for Send's gold cue. This keeps the
   *  palette honest if the append-and-send policy changes later. */
  function paletteSendAutoSteps(): boolean {
    const path = panels[opTargetPanel()]?.active;
    const file = path ? files[path] : undefined;
    if (
      !path ||
      !file ||
      file.kind === "folder" ||
      isMint(path) ||
      isScan(path) ||
      isOblivion(path)
    ) {
      return false;
    }
    return planDelivery("send", unsteppedPathSet.has(path), file.nodeId) === "append-and-send";
  }

  /** Every writable trace permits an explicit Step. Even an unchanged buffer
   *  records a deliberate checkpoint, while a missing head creates genesis. */
  function paletteStepIsAvailable(): boolean {
    const path = panels[opTargetPanel()]?.active;
    const file = path ? files[path] : undefined;
    if (
      !path ||
      !file ||
      file.kind === "folder" ||
      isMint(path) ||
      isScan(path) ||
      isOblivion(path)
    ) {
      return false;
    }
    return planDelivery("step", unsteppedPathSet.has(path), file.nodeId) !== "unavailable";
  }

  /** Queue the optional anteriority overlay for any newly-created Step. */
  function queueStepAnchor(steppedId: string, signer: Uint8Array): void {
    void import("../provenance/anchor.js")
      .then(({ submitAnchor }) =>
        submitAnchor(steppedId, signer, resolveRelayUrl()),
      )
      .catch(() => {
        // Best-effort: the node is stepped regardless. Calendar/transport
        // failures log inside submitAnchor.
      });
  }

  /** Deliver the panel's active file under the selected stance.
   *
   *  Step appends when the trace has pending changes or needs its first node;
   *  the current palette state is unavailable. A mintable passage uses the same
   *  primary slot to create a Coin. Send appends a Step only when the working
   *  state differs from the latest Step; otherwise it distributes that existing
   *  node. Re-sending is idempotent because relays dedupe by event id. */
  async function deliverAsVoice(idx: number, op: "step" | "send") {
    const pubkey = authorPubkey;
    const path = panels[idx]?.active;
    if (!path || !files[path]) return;
    if (isCoinTab(path) && !isCompletedCoinFile(files[path])) {
      setOpStatus(idx, "error", "This incomplete Mint artifact has no Coin actions", op);
      return;
    }
    if (op === "send") setSendFailure(null);
    const signer = secretKeyForVoice(pubkey);
    if (!signer) {
      const error = new Error(`no key for voice ${formatPubkey(pubkey)}`);
      setOpStatus(idx, "error", error.message, op);
      if (op === "send") setSendFailure(describeSendFailure(error));
      return;
    }
    if (op === "step" && !isMint(path) && !isScan(path) && !isOblivion(path)) {
      const view = panelViews.current[idx];
      if (view) {
        const { from, to } = view.state.selection.main;
        const paletteState = classifyPaletteSelection(
          view.state.doc.toString(),
          from,
          to,
        );
        const mintTarget = findMintSelectionTarget(view.state.doc.toString(), from, to);
        if (mintTarget) {
          if (!kademliaEnabledSnapshot()) {
            setOpStatus(idx, "error", "Enable Coins in Networking before minting a Coin", op);
            return;
          }
          if (!(await requestMintConsent(mintTarget.phrase))) return;
          const confirmedTarget = findMintSelectionTarget(
            view.state.doc.toString(),
            from,
            to,
          );
          if (!confirmedTarget || confirmedTarget.phrase !== mintTarget.phrase) {
            setOpStatus(idx, "error", "The selected text changed before Mint was confirmed", "mint");
            return;
          }
          setOpStatus(idx, "running", undefined, "mint");
          const minted = await zinePhrase(path, view, from, to, signer);
          if (minted) {
            setOpStatus(idx, "done", undefined, "mint");
            flashPanelFn(idx);
          }
          return;
        }
        if (paletteState === "coin") {
          setOpStatus(idx, "error", "This passage is already an immutable Coin", op);
          return;
        }
        if (paletteState === "invalid") {
          setOpStatus(idx, "error", "Select loose text or one pending [[ bracket ]] to Mint", op);
          return;
        }
      }
      if (uiFocus?.kind === "coin") {
        setOpStatus(idx, "error", "This passage is already an immutable Coin", op);
        return;
      }
    }
    setOpStatus(idx, "running", undefined, op);
    try {
      if (isScan(path)) {
        throw new Error("Scanned sources are immutable; adopt into Root before authoring or sending");
      }
      if (isMint(path) && op === "step") {
        throw new Error("Mint coins are immutable; Send the existing trace or fork it into Root");
      }
      const plan = isMint(path)
        ? "send-latest"
        : planDelivery(op, unsteppedPathSet.has(path), files[path].nodeId);
      const createsStep = plan !== "send-latest";
      let steppedId: string | undefined;
      if (plan === "append-local-step") {
        steppedId = await stepFile(path, signer, true, true);
      } else if (plan === "append-and-send") {
        // Pending state is always made durable at home first. Publication is a
        // second, independently failing phase, so a dead external relay cannot
        // erase the Step the author just requested.
        steppedId = await stepFile(path, signer, true, false);
        if (!steppedId) throw new Error("Step did not produce a durable node");
        const event = await fetchEventById(steppedId);
        if (!event) throw new Error("new Step is unavailable on the home relay");
        await sendStep(event, signer);
      } else if (plan === "send-latest") {
        // Current state: Send the latest Step without manufacturing another.
        steppedId = files[path].nodeId;
        const event = steppedId ? await fetchEventById(steppedId) : null;
        if (!event) throw new Error("latest Step is unavailable on the home relay");
        await sendStep(event, signer);
      }
      // §R11.22: distributed anteriority. Every newly appended Step stamps.
      // Sending an unchanged latest Step does not submit another anchor. The
      // frequent gesture builds the
      // time-distributed process record the vet reads (rendezvous.md §3).
      // Strictly additive: the kind-1040 overlay never blocks the gesture.
      // Fire-and-forget; dynamic import avoids a circular module dep.
      if (steppedId && createsStep) {
        queueStepAnchor(steppedId, signer);
      }
      if (steppedId && op === "send") {
        void isTraceNodeSent(steppedId)
          .then((sent) => {
            setSentNodeStatus((prev) => ({ ...prev, [steppedId]: sent }));
          })
          .catch(() => {
            // The next palette focus or Attest confirmation re-checks.
          });
      }
      setOpStatus(idx, "done", undefined, op);
      flashPanelFn(idx);
      if (
        op === "step" &&
        steppedId &&
        onboardingStageRef.current === "awaiting-step"
      ) {
        commitOnboardingStage("awaiting-replay");
      } else if (
        op === "step" &&
        steppedId &&
        onboardingStageRef.current === "context-step" &&
        path === modelLessonResume?.targetPath
      ) {
        const nextLesson: ModelLessonResume = {
          ...modelLessonResume,
          resultNodeId: steppedId,
        };
        setModelLessonResume(nextLesson);
        commitOnboardingStage(
          reduceOnboardingStage(onboardingStageRef.current, "result-stepped"),
          nextLesson,
        );
      }
    } catch (e) {
      console.warn(`[deliver] step failed for ${path} as ${pubkey.slice(0, 8)}…:`, e);
      setOpStatus(idx, "error", e instanceof Error ? e.message : String(e), op);
      if (op === "send") setSendFailure(describeSendFailure(e));
    }
  }

  /** Compose Attest's reachability prerequisites, then append the immutable
   *  endorsement. A writable file with pending changes gets one exact Step;
   *  an existing local-only node is Sent without manufacturing a revision.
   *  The final Attestation remains a separate event targeting that exact id. */
  async function attestAsVoice(
    path: string,
    geohash?: string,
    message?: string,
    opts?: { kind?: "file" | "folder" | "coin"; nodeId?: string },
  ) {
    const pubkey = authorPubkey;
    // Op-status panel: the panel whose active tab is the attested path, else the
    // focused panel (a folder selection may have no tab).
    const idx = panels.findIndex((p) => p.active === path);
    const statusIdx = idx === -1 ? Math.min(activePanel, panels.length - 1) : idx;
    const signer = secretKeyForVoice(pubkey);
    if (!signer) {
      setOpStatus(statusIdx, "error", `no key for voice ${formatPubkey(pubkey)}`, "attest");
      return;
    }
    setOpStatus(statusIdx, "running", undefined, "attest");
    try {
      if (opts?.kind === "coin" && isCoinTab(path) && !isCompletedCoinFile(files[path])) {
        throw new Error("This incomplete Mint artifact has no Coin actions");
      }
      let citedId = opts?.nodeId;
      let createsStep = false;
      if ((opts?.kind ?? "file") === "file") {
        const file = files[path];
        if (!file) throw new Error("Attest target is no longer available");
        const delivery = planDelivery(
          "send",
          unsteppedPathSet.has(path),
          file.nodeId,
        );
        if (delivery === "append-and-send") {
          // Preserve the exact candidate locally before attempting Send.
          citedId = await stepFile(path, signer, true, false);
          createsStep = true;
        } else {
          citedId = file.nodeId;
        }
      }
      if (!citedId) throw new Error("Attest needs a trace version to endorse");

      // Re-check at confirmation time: the palette's reachability result is a
      // visual hint and may be stale. Sending an unchanged event is idempotent.
      if (!(await isTraceNodeSent(citedId))) {
        const event = await fetchEventById(citedId);
        if (!event) throw new Error("Attest target is unavailable on the home relay");
        await sendStep(event, signer);
      }
      if (createsStep) queueStepAnchor(citedId, signer);

      // attestNode verifies the target is present on a configured non-loopback
      // relay after the composed Send, so a failed distribution cannot
      // masquerade as the required prior Send.
      await attestNode(citedId, undefined, {
        signer,
        ...(message ? { message } : {}),
        ...(geohash ? { geohash } : {}),
      });
      setAttestationCounts((prev) => ({
        ...prev,
        [citedId]: (prev[citedId] ?? 0) + 1,
      }));
      setSentNodeStatus((prev) => ({ ...prev, [citedId]: true }));
      setOpStatus(statusIdx, "done", undefined, "attest");
    } catch (e) {
      console.warn(`[attest] failed for ${path} as ${pubkey.slice(0, 8)}…:`, e);
      setOpStatus(statusIdx, "error", e instanceof Error ? e.message : String(e), "attest");
    }
  }

  function updateHistoricalAction(
    nodeId: string,
    action: "send" | "attest",
    phase: HistoricalActionPhase,
    message?: string,
  ) {
    setHistoricalActionStatus((prev) => ({
      ...prev,
      [nodeId]: {
        send: prev[nodeId]?.send ?? "idle",
        attest: prev[nodeId]?.attest ?? "idle",
        [action]: phase,
        ...(message ? { message } : {}),
      },
    }));
  }

  /** Replay-local Send publishes the exact displayed immutable event. It does
   * not Step, move TraceHead, switch tabs, or alter UiFocus. */
  async function sendHistoricalNode(nodeId: string) {
    updateHistoricalAction(nodeId, "send", "running");
    try {
      if (!canSignWithSecrets()) {
        throw new Error("Historical Send is available in the unlocked desktop press");
      }
      const event = await fetchEventById(nodeId);
      if (!event) throw new Error("Historical Step is unavailable on the home relay");
      if (!secretKeyForVoice(event.pubkey)) {
        throw new Error("Historical Send is only available for a locally owned Step");
      }
      await sendHistoricalStep(event);
      setSentNodeStatus((prev) => ({ ...prev, [nodeId]: true }));
      updateHistoricalAction(nodeId, "send", "done");
    } catch (error) {
      updateHistoricalAction(
        nodeId,
        "send",
        "error",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  /** Historical Attest composes only the exact node's reachability prerequisite.
   * It can Send that old event, but it can never append a live Step. */
  async function attestHistoricalNode(
    nodeId: string,
    geohash?: string,
    message?: string,
  ) {
    updateHistoricalAction(nodeId, "attest", "running");
    const signer = secretKeyForVoice(authorPubkey);
    if (!signer) {
      updateHistoricalAction(
        nodeId,
        "attest",
        "error",
        `no key for voice ${formatPubkey(authorPubkey)}`,
      );
      return;
    }
    try {
      if (!(await isTraceNodeSent(nodeId))) {
        updateHistoricalAction(nodeId, "send", "running");
        const event = await fetchEventById(nodeId);
        if (!event) throw new Error("Historical Step is unavailable on the home relay");
        await sendHistoricalStep(event);
        setSentNodeStatus((prev) => ({ ...prev, [nodeId]: true }));
        updateHistoricalAction(nodeId, "send", "done");
      }
      await attestNode(nodeId, undefined, {
        signer,
        ...(message ? { message } : {}),
        ...(geohash ? { geohash } : {}),
      });
      setAttestationCounts((prev) => ({
        ...prev,
        [nodeId]: (prev[nodeId] ?? 0) + 1,
      }));
      updateHistoricalAction(nodeId, "attest", "done");
    } catch (error) {
      updateHistoricalAction(
        nodeId,
        "attest",
        "error",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  /** Stop an in-flight op for a panel. */
  function stopOp(idx: number) {
    summonAbort.current[idx]?.abort();
  }

  function toggleTheme() {
    // Toggle against the *resolved* mode, not the stored preference, so the
    // icon always reflects what the user is currently seeing. Flipping always
    // lands on an explicit light/dark (never back to auto) — predictable.
    const next = resolvedMode(theme) === "dark" ? "light" : "dark";
    applyTheme(next);
    setTheme(next);
  }

  // --- folder boot ------------------------------------------------------
  //
  // On mount: the permanent root is either already known (getRootId seeded
  // `folder`) or minted on first boot (mintRoot). Either way the backend
  // re-attaches it (the local/relay arm — pathless), opening the first file.

  /** Open the scanned file set in the workspace panels (shared tail of every
   *  attach path). The first file opens in a single panel that fills the row;
   *  further columns appear when the user drags a tab onto a panel's right
   *  edge, and empty panels collapse back out.
   *
   *  If a layout was saved for this folder (workspace-layout-store), restore it
   *  instead of opening just the first file — so the editor reopens exactly
   *  where the user left it after a reload. Restored file tabs are validated
   *  against the freshly scanned set: any path that no longer exists (deleted /
   *  moved on disk or relay) is pruned, so a stale layout never surfaces a dead
   *  tab. Folder tabs (`folder://…`) aren't file paths, so they survive as-is. */
  async function openScanned(scanned: Record<string, FileState>, folderId: string) {
    const firstPath = Object.keys(scanned).sort()[0] ?? "";
    const fallback: { panels: PanelState[]; activePanel: number; weights: number[]; tabModes: Record<string, Mode> } = {
      panels: [{ tabs: firstPath ? [firstPath] : [], active: firstPath }],
      activePanel: 0,
      weights: [1],
      // A fresh attach resets the remembered surfaces — everything starts in preview.
      tabModes: {},
    };

    const saved = loadWorkspaceLayout(folderId);
    const restored = saved ? reconcileLayout(saved, scanned) : null;
    const layout = restored ?? fallback;

    setPanels(layout.panels);
    setSummonStatus(layout.panels.map(() => ({ state: "idle" as const })));
    setPanelWeights(layout.weights);
    // Preserve already-mounted editor views: FileEditor mounts once per panel
    // slot (no key, [] mount deps) and reuses one EditorView across tab/folder
    // switches via its doc-swap effect — onView fires only on mount/unmount, so
    // nulling a slot whose editor is still mounted orphans the live view and
    // beginOp then sees null ("no editor mounted"). This bites the web-app's
    // re-attach: the [folder?.id] effect re-attaches and calls openScanned
    // again; the second pass wiped slots whose FileEditors never remounted.
    // Copy forward by index; new/extra slots stay null until their editor
    // mounts, and slots whose panel genuinely disappeared are dropped (their
    // FileEditor unmounts and onView(null) clears the stray entry harmlessly).
    const prevViews = panelViews.current;
    panelViews.current = layout.panels.map((_, i) => prevViews[i] ?? null);
    summonAbort.current = layout.panels.map(() => null);
    setTabModes(layout.tabModes);
    setActivePanel(layout.activePanel);
    // Crash-pad restore: if the last session left unstepped buffers in the pad
    // (app closed/crashed/refreshed mid-edit), overlay them onto the scanned
    // files so the user picks up exactly where they left off. Both platforms
    // use the pad now (typing never steps — see schedulePad), so both must
    // restore from it. The pad wins (it's the newer buffer); a file in the pad
    // but not on disk (newly created, never Stepped) is added fresh. We seed
    // lastSteppedRef from `scanned` (disk/relay truth), NOT the merged set — so
    // restored files correctly read as unstepped (their buffer differs from the
    // stepped state) and show a count until Stepped. A file only in the pad
    // (not scanned) is never seeded → unstepped → correct.
    const pad = loadPad(folderId);
    let recoveryVoice: Awaited<ReturnType<typeof getReconcilerVoice>> | null = null;
    if (pad && Object.keys(pad).length > 0) {
      recoveryVoice = await getReconcilerVoice();
    }
    // Re-read after the optional async key lookup: background attach pull may
    // already have advanced localStorage. Hydrate from that durable projection,
    // then overlay the crash pad, so the pre-pull `scanned` snapshot can never
    // erase a fast reconciliation that completed while this function awaited.
    const latestLocal = loadLocalFolder(folderId);
    const latestScanned = latestLocal ? localToFiles(latestLocal) : scanned;
    const merged = { ...latestScanned };
    const latestPad = recoveryVoice ? loadPad(folderId) ?? pad : pad;
    if (latestPad && recoveryVoice) {
      for (const [path, lf] of Object.entries(latestPad)) {
        merged[path] = restoreCrashPadFile(
          latestScanned[path],
          lf,
          authorVoice(),
          recoveryVoice.publicKey,
        );
      }
    }
    if (folderIdRef.current !== folderId) return;
    setFiles(merged);
    // Mark every scanned file as already-stepped so the first debounce tick
    // doesn't re-publish the whole folder (these files came from disk/relay
    // already published — their nodeId proves it). This is what stops the boot
    // fanout from tripping the relay rate-limit. Seeded from `scanned` (disk
    // truth) deliberately — see the pad-restore note above.
    seedSteppedRef.current(latestScanned);
    ready.current = true; // allow the debounce effect to publish subsequent edits
  }

  /** Factory reset is a first-run boundary, not a workspace preference reset.
   *  Desktop purges the local sidecar, releases and deletes every secure vault,
   *  clears the webview's entire localStorage, and reloads into vault creation.
   *  Clearing `zine.root` makes boot mint a new root genesis, and its virtual
   *  oblivion region therefore starts empty too. Remote relay copies are
   *  outside this machine and cannot be recalled. */
  async function factoryReset() {
    if (resetBusy) return;
    setResetBusy(true);
    setResetError(null);
    try {
      await resetLocalApp();
    } catch (e) {
      setResetError(e instanceof Error ? e.message : String(e));
      setResetBusy(false);
    }
  }

  /** Fork the active file from a replay snapshot (spec §3.8). Mints a new file
   *  trace under the user's key, seeded from the historical node at the replay
   *  step — `forked-from` pins the exact node-version. The fork lives at a
   *  synthetic path (`<original>#fork-<shortId>`) in the same folder so it's
   *  discoverable without clobbering the original. Ends replay and switches the
   *  editor to the forked trace (live, editable). */
  async function forkFromSnapshot() {
    const prompt = forkPrompt;
    if (!prompt || !folder || !replay) return;
    setForkPrompt(null);
    const step = replay.steps[prompt.stepIndex];
    if (!step) return;
    const shortId = step.event.id.slice(0, 8);
    const forkPath = `${step.relativePath}#fork-${shortId}`;
    setBootError(null);
    try {
      const signer = secretKeyForVoice(authorPubkey);
      if (!signer) throw new Error(`no key for voice ${formatPubkey(authorPubkey)}`);
      // Mint the fork: new file trace, genesis under our key, snapshot verbatim
      // from the historical node. forked-from = the step's event id.
      await forkFileIntoLocalTree(
        { storageRootId: folder.id, folderId: folder.id, storagePath: ROOT },
        step.event.id,
        forkPath,
        signer,
        { localOnly: true },
      );
      // End replay (restores live state) and re-scan so the fork appears.
      endReplay();
      const { files: scanned } = await backendRef.current.attach(folder);
      setFiles(scanned);
      selectFile(forkPath);
    } catch (e) {
      setBootError(e instanceof Error ? e.message : String(e));
    }
  }

  /** Dismiss the fork modal and seek replay to the latest step — the editor
   *  becomes live (no fork, no new trace). The user can then edit the final
   *  version directly. */
  function skipToLatest() {
    setForkPrompt(null);
    if (replay) replayStepTo(replay.steps.length - 1);
  }

  /** Branch detection for the active file: scan for incoming forks and sibling
   *  heads. No-op on foreign folders (we don't own the chain) or empty path. */
  async function refreshMergeCandidates(folderId: string, relativePath: string) {
    if (!relativePath) {
      setMergeCandidates([]);
      return;
    }
    try {
      const found = await findMergeCandidates(folderId, relativePath);
      setMergeCandidates(found);
    } catch (e) {
      console.warn("branch detection failed:", e);
      setMergeCandidates([]);
    }
  }

  /** Compare the local staged side, publish exactly one merge node through the
   * workspace's per-file mutation lane, and adopt that same node locally.
   * Newer typing that happens while the relay accepts the merge keeps its live
   * runs and becomes an unstepped draft rooted at the landed merge. */
  async function acceptMergeToWorkspace(input: {
    path: string;
    expectedNodeId: string;
    expectedContent: string;
    snapshot: string;
    parentId: string;
    parentPubkey: string;
    parentSnapshot: string;
    baseSnapshot?: string;
    summary?: string;
    runs?: Run[];
  }) {
    const before = filesRef.current[input.path];
    if (
      !before ||
      before.nodeId !== input.expectedNodeId ||
      flatten(before.runs) !== input.expectedContent
    ) {
      throw new Error(
        `Cannot accept merge for ${input.path}: local work changed after it was staged.`,
      );
    }
    const requestedRuns = input.runs ?? (() => {
      const out: Run[] = [];
      const append = (run: Run) => {
        if (!run.text) return;
        const last = out[out.length - 1];
        if (last && last.voice === run.voice && last.src === run.src) last.text += run.text;
        else out.push(run);
      };
      const appendOurs = (from: number, to: number) => {
        let cursor = 0;
        for (const run of before.runs) {
          const end = cursor + run.text.length;
          const left = Math.max(from, cursor);
          const right = Math.min(to, end);
          if (right > left) append({ ...run, text: run.text.slice(left - cursor, right - cursor) });
          cursor = end;
          if (cursor >= to) break;
        }
      };
      const parentMask: boolean[] = [];
      if (input.snapshot === input.parentSnapshot) {
        parentMask.push(...Array.from({ length: input.snapshot.length }, () => true));
      } else if (input.baseSnapshot !== undefined) {
        const merge = threeWayMerge(
          input.baseSnapshot,
          input.expectedContent,
          input.parentSnapshot,
        );
        if (autoMergedText(merge) === input.snapshot) {
          let firstLine = true;
          for (const chunk of merge.chunks) {
            if (chunk.type === "conflict") continue;
            for (const line of chunk.lines) {
              if (!firstLine) parentMask.push(chunk.type === "theirs");
              parentMask.push(...Array.from({ length: line.length }, () => chunk.type === "theirs"));
              firstLine = false;
            }
          }
        }
      }
      let oursCursor = 0;
      let mergedCursor = 0;
      for (const part of diffChars(input.expectedContent, input.snapshot)) {
        if (part.removed) {
          oursCursor += part.value.length;
        } else if (part.added) {
          const exactParentSpan = parentMask.length === input.snapshot.length &&
            parentMask.slice(mergedCursor, mergedCursor + part.value.length).every(Boolean);
          append(exactParentSpan
            ? { voice: input.parentPubkey, text: part.value, src: input.parentId }
            : { voice: authorVoice(), text: part.value });
          mergedCursor += part.value.length;
        } else {
          appendOurs(oursCursor, oursCursor + part.value.length);
          oursCursor += part.value.length;
          mergedCursor += part.value.length;
        }
      }
      return out;
    })();
    const event = await backendRef.current.acceptMerge({
      relativePath: input.path,
      expectedNodeId: input.expectedNodeId,
      expectedContent: input.expectedContent,
      mergeParentId: input.parentId,
      mergeParentPubkey: input.parentPubkey,
      snapshot: input.snapshot,
      tags: before.tags,
      runs: requestedRuns,
      citationIds: before.citationIds,
      summary: input.summary,
    });
    let authorsRaw: unknown;
    try {
      authorsRaw = (JSON.parse(event.content) as { authors?: unknown }).authors;
    } catch {
      authorsRaw = undefined;
    }
    const runs = parseAuthors(authorsRaw, input.snapshot) ?? requestedRuns;
    const steppedFile: FileState = {
      ...before,
      runs,
      nodeId: event.id,
    };
    seedSteppedRef.current({ [input.path]: steppedFile });
    setFiles((prev) => {
      const current = prev[input.path];
      if (!current) return prev;
      const stillExact = current.nodeId === input.expectedNodeId &&
        flatten(current.runs) === input.expectedContent;
      return {
        ...prev,
        [input.path]: stillExact
          ? steppedFile
          : { ...current, nodeId: event.id },
      };
    });
    await refreshMergeCandidates(folder!.id, input.path);
    return event;
  }

  /** Unilateral incorporate (protocol §3.8). No-conflict: full-adopt theirs.
   *  Conflict/sibling: open three-way reconcile panel. */
  async function incorporateCandidate(candidate: MergeCandidate) {
    if (!folder || mergeBusy) return;
    const path = panels[activePanel]?.active;
    if (!path) return;
    setMergeError(null);

    if (!candidate.noConflict) {
      // Topology says someone advanced past the fork point, but that alone
      // doesn't mean the content conflicts — the divergence can be a pure
      // chain-graph artifact (an unStepped checkpoint, or both sides holding
      // identical text). Load the three sides and run the merge: only open
      // the reconcile UI when there are genuine overlapping edits. Otherwise
      // the three-way merge auto-resolves, so step it directly.
      try {
        const sides = await loadMergeSides(folder.id, path, candidate);
        const merged = threeWayMerge(sides.base, sides.ours, candidate.snapshot);
        const auto = autoMergedText(merged);
        if (merged.clean && auto !== null) {
          // Auto-resolved — show the diff for review rather than stepping blind.
          setMergePreview({ candidate, path, before: sides.ours, after: auto });
          return;
        }
        setMergeSession({ candidate, base: sides.base, ours: sides.ours, path });
      } catch (e) {
        console.warn("[merge] loadMergeSides failed:", e);
        setMergeError(e instanceof Error ? e.message : String(e));
      }
      return;
    }

    setMergeBusy(true);
    try {
      const current = filesRef.current[path];
      if (!current) throw new Error(`Cannot merge missing trace ${path}.`);
      await acceptMergeToWorkspace({
        path,
        expectedNodeId: candidate.forkedFromId ?? current.nodeId,
        expectedContent: flatten(current.runs),
        snapshot: candidate.snapshot,
        parentId: candidate.headId,
        parentPubkey: candidate.ownerPubkey,
        parentSnapshot: candidate.snapshot,
        summary: `incorporated fork ${candidate.headId.slice(0, 8)}`,
      });
    } catch (e) {
      console.warn("[merge] incorporate failed:", e);
      setMergeError(e instanceof Error ? e.message : String(e));
    } finally {
      setMergeBusy(false);
    }
  }

  /** Step a three-way merge that auto-resolved with no overlapping conflicts.
   *  Same wiring as the manual step path, minus the UI state. */
  async function stepCleanMerge(
    candidate: MergeCandidate,
    path: string,
    resolvedSnapshot: string,
  ) {
    if (!folder || mergeBusy) return;
    setMergeBusy(true);
    setMergeError(null);
    try {
      const current = filesRef.current[path];
      if (!current) throw new Error(`Cannot merge missing trace ${path}.`);
      await acceptMergeToWorkspace({
        path,
        expectedNodeId: current.nodeId,
        expectedContent: mergePreview?.path === path
          ? mergePreview.before
          : flatten(current.runs),
        snapshot: resolvedSnapshot,
        parentId: candidate.headId,
        parentPubkey: candidate.ownerPubkey,
        parentSnapshot: candidate.snapshot,
        summary: `merged ${candidate.headId.slice(0, 8)}`,
      });
      setMergeError(null);
      setMergePreview(null);
    } catch (e) {
      console.warn("[merge] stepCleanMerge failed:", e);
      setMergeError(e instanceof Error ? e.message : String(e));
    } finally {
      setMergeBusy(false);
    }
  }

  /** Step from the three-way panel with a resolved snapshot. */
  async function stepReconciledMerge(resolvedSnapshot: string) {
    if (!folder || !mergeSession || mergeBusy) return;
    const { candidate, path } = mergeSession;
    setMergeBusy(true);
    setMergeError(null);
    try {
      const current = filesRef.current[path];
      if (!current) throw new Error(`Cannot merge missing trace ${path}.`);
      await acceptMergeToWorkspace({
        path,
        expectedNodeId: current.nodeId,
        expectedContent: mergeSession.ours,
        snapshot: resolvedSnapshot,
        parentId: candidate.headId,
        parentPubkey: candidate.ownerPubkey,
        parentSnapshot: candidate.snapshot,
        baseSnapshot: mergeSession.base,
        summary: `merged ${candidate.headId.slice(0, 8)}`,
      });
      setMergeSession(null);
      setMergeError(null);
    } catch (e) {
      console.warn("[merge] stepReconciledMerge failed:", e);
      setMergeError(e instanceof Error ? e.message : String(e));
    } finally {
      setMergeBusy(false);
    }
  }

  /** Accept a staged background-pull merge against the exact local head/body
   * observed by the pull. The workspace publishes and adopts one merge node;
   * it does not append a second ordinary edit. */
  async function stepStagedMerge(staged: StagedMerge) {
    if (!folder || stagedMergeBusy) return;
    setStagedMergeBusy(true);
    setStagedMergeError(null);
    try {
      await acceptMergeToWorkspace({
        path: staged.path,
        expectedNodeId: staged.localNodeId,
        expectedContent: staged.ours,
        snapshot: staged.merged,
        parentId: staged.remoteHeadId,
        parentPubkey: staged.remoteOwnerPubkey,
        parentSnapshot: staged.theirs,
        baseSnapshot: staged.base,
        summary: `merged ${staged.remoteHeadId.slice(0, 8)}`,
      });
      setStagedMerges((prev) => prev.filter((m) => m !== staged));
      setStagedMergeView(null);
    } catch (e) {
      console.warn("[merge] stepStagedMerge failed:", e);
      setStagedMergeError(e instanceof Error ? e.message : String(e));
    } finally {
      setStagedMergeBusy(false);
    }
  }

  useEffect(() => {
    if (!folder) {
      // First-ever boot (no root minted yet): mint the permanent root and set
      // it as the folder. The re-attach body below then opens it. Subsequent
      // boots find the root via getRootId() (folder state seed) and skip this.
      let cancelled = false;
      void mintRoot().then(
        (id) => {
          if (!cancelled) setFolder({ id });
        },
        (error) => {
          if (!cancelled) {
            setBootError(error instanceof Error ? error.message : String(error));
            setBootState("missing");
          }
        },
      );
      return () => { cancelled = true; };
    }
    let cancelled = false;
    (async () => {
      setBootState("scanning");
      try {
        // The root is always pathless: it lives on the relay, addressed by its
        // permanent genesis id. The local arm boots from localStorage
        // instantly and background-pulls the relay for any newer content. Disk
        // is never read here — it's touched only by Scan (acquire) and Reify
        // (emit) gestures, never on boot.
        const attached = await backendRef.current.attach(folder, (path, file) => {
            if (cancelled) return;
            setFiles((prev) => {
              if (file) return { ...prev, [path]: file };
              if (!(path in prev)) return prev;
              const next = { ...prev };
              delete next[path];
              return next;
            });
            if (file) seedSteppedRef.current({ [path]: file });
          });
        void attached.reconciled
          .then(() => {
            if (cancelled || folderIdRef.current !== folder.id) return;
            // Background relay pull can remove paths via remote-driven absence
            // reconciliation (pullFromRelayUnlocked → deleteLocalFileDurably).
            // The user may have mounted a sub-tree scope in the window between
            // attach returning and this promise resolving; if pull then removed
            // that sub-tree, the scope mount is left pointing at a path that no
            // longer exists — the same defect class the renameNode/hardDelete
            // scope rebase closes for user-initiated gestures. Writes already
            // follow focus (which is rebased separately), so this is a state-
            // machine fix: without it the scope UI lies and the next MODEL op
            // silently loses the scope subtree (activePath is still included,
            // but nothing else under scope is). Pull does not touch shields, so
            // there is no disclosure risk — only scope staleness.
            const mount = scopeRef.current[0];
            if (!mount || mount.path === ROOT) return;
            const loaded = loadLocalFolder(folder.id);
            const paths = loaded?.files ?? {};
            const stillPresent = mount.kind === "file"
              ? mount.path in paths
              : Object.keys(paths).some(
                  (p) => p === mount.path || p.startsWith(`${mount.path}/`),
                );
            if (!stillPresent) {
              setScope([{ kind: "folder", path: ROOT }]);
            }
          })
          .catch((error) => {
          if (cancelled || folderIdRef.current !== folder.id) return;
          const storedConflicts = Object.values(
            loadLocalFolder(folder.id)?.structuralConflicts ?? {},
          ).sort((left, right) => right.failedAt - left.failedAt);
          if (storedConflicts[0]) {
            setStructuralError(
              `A ${storedConflicts[0].operation.kind} could not be recovered: ${storedConflicts[0].reason}`,
            );
            setStructuralConflictId(storedConflicts[0].operation.operationId);
          } else {
            // Recovery threw without archiving a terminal conflict — a journal
            // entry is stuck in pendingStructuralOperations. Surface the reason
            // and let Dismiss force-clear it; otherwise every later Root
            // mutation re-throws on recovery and the workspace is bricked.
            setStructuralError(
              `Workspace recovery failed and a structural operation is stuck: ${error instanceof Error ? error.message : String(error)}. Dismiss abandons the stuck operation so new edits can proceed.`,
            );
            setStructuralConflictId(null);
          }
        });
        const scanned = attached.files;
        if (cancelled) return;
        await openScanned(scanned, folder.id);
        const storedConflicts = Object.values(
          loadLocalFolder(folder.id)?.structuralConflicts ?? {},
        ).sort((left, right) => right.failedAt - left.failedAt);
        if (storedConflicts[0]) {
          setStructuralConflictId(storedConflicts[0].operation.operationId);
          setStructuralError(
            `A ${storedConflicts[0].operation.kind} could not be recovered: ${storedConflicts[0].reason}`,
          );
        }
        setBootState("ready");
      } catch (e) {
        if (cancelled) return;
        // The root couldn't be read on boot — almost always a transient
        // relay/sidecar issue (the sidecar not yet up, or the relay briefly
        // unreachable). The root id is permanent (zine.root), so this is a
        // retry, never a re-pick: a reload reopens the same root.
        setBootError(e instanceof Error ? e.message : String(e));
        setBootState("missing");
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folder?.id]);

  // --- operator layer bootstrap (webapp only) -----------------------------
  //
  // Fetch /operator/state once on mount. If the relay has an operator enabled
  // but none bound yet, open the setup modal so the first visitor can claim it
  // with the bootstrap token. Desktop sidecar doesn't serve /operator/*, so
  // this whole effect is a no-op there. We can't tell "no operator bound" from
  // "operator not configured on this relay" until bind returns 503 — so the
  // modal is shown on a null operator state and rewords itself on bind failure.
  useEffect(() => {
    if (isTauri()) return;
    let cancelled = false;
    void (async () => {
      const st = await refreshOperatorState();
      if (cancelled) return;
      if (st) {
        setOperatorState(st);
        if (!st.operator && canSignWithSecrets()) setOperatorSetup("boot");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // NOTE: no background disk rescanner. The trace lives in the app; disk is a
  // substrate scanned from / reified to at an instant (a deliberate gesture),
  // never a continuously-authoritative source polled in the background. A
  // periodic scan reading stale disk over an un-reified buffer was what
  // silently overwrote edits — that class of bug cannot occur now because
  // nothing has standing to rewrite a held trace between gestures.

  // Window title mirrors the tab badges: total discrete edits waiting for Step,
  // `+` when only non-text changes are pending, plain "zine" when current.
  useEffect(() => {
    if (!isTauri()) return;
    let total = 0;
    for (const count of unsteppedEditCounts.values()) total += count;
    document.title = total > 0 ? `${total} · zine` : unsteppedPathSet.size > 0 ? "+ · zine" : "zine";
  }, [unsteppedEditCounts, unsteppedPathSet]);

  // NIP-03 anchor completion sweep (§8/§R11.20). Step keeps its pending OTS
  // receipt locally; this polls the calendar and publishes a kind-1040 only
  // once the digest lands in a Bitcoin block. 10min matches Bitcoin's
  // block cadence — tighter polling wastes calendar bandwidth without
  // improving latency. Desktop-only: the stamp_ots/upgrade_ots commands are
  // Tauri-hosted (the calendars don't send CORS headers, so a browser fetch
  // dies). Fire once on mount, then on the interval.
  useEffect(() => {
    if (!isTauri()) return;
    const run = () =>
      import("../provenance/anchor.js")
        .then(({ upgradePendingAnchors }) => upgradePendingAnchors())
        .catch(() => {
          // best-effort: a calendar failure just means we try again next round
        });
    void run();
    const interval = window.setInterval(run, 10 * 60 * 1000);
    return () => window.clearInterval(interval);
  }, []);

  // Dismiss the tab context menu on a pointer-down outside it, or on Escape —
  // same pattern as the sidebar's tree context menu.
  useEffect(() => {
    if (!tabCtxMenu) return;
    function onPointerDown(e: MouseEvent) {
      if (tabCtxMenuRef.current && !tabCtxMenuRef.current.contains(e.target as Node)) {
        setTabCtxMenu(null);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setTabCtxMenu(null);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [tabCtxMenu]);


  /** Scan: acquire a foreign snapshot into the private Scan inbox. A folder
   *  retains its picked outer directory and repeated scans suffix that wrapper
   *  as one batch. Every imported file is a new substrate-signed trace; Scan's
   *  membership remains author-owned and local-only, separate from Root. */
  async function onScan(kind: "file" | "folder") {
    if (!folder) return;
    const idx = opTargetPanel();
    const picked = kind === "file" ? await chooseFile() : await chooseFolder();
    if (!picked) return; // user cancelled
    let scanned: ScannedFile[];
    try {
      scanned = await scanExternal(picked);
    } catch (e) {
      setOpStatus(idx, "error", e instanceof Error ? e.message : String(e), "scan");
      return;
    }
    if (scanned.length === 0) return;
    // The substrate speaks with its own voice: content scanned in from it is
    // signed by its key, never the authoring key. Auto-provisions on first use.
    const substrateVoice = await getSubstrateVoice(substrate);
    const voice = substrateVoice.publicKey;
    const signer = substrateVoice.secretKey;
    const sourceRootId = folder.id;
    const created = planScanIntake(
      kind,
      picked,
      scanned,
      new Set([...Object.keys(filesRef.current), ...pendingPaths.current]),
    );
    // Optimistic insert: each new trace appears immediately, attributed to the
    // substrate voice, marked pending so any in-flight op's hold can't drop it.
    setFiles((prev) => {
      const next = { ...prev };
      for (const c of created) {
        pendingPaths.current.add(c.path);
        next[c.path] = { runs: [{ voice, text: c.content }], nodeId: "", tags: [] };
      }
      return next;
    });
    const completed = new Set<string>();
    try {
      const rootOwner = await fetchFolderOwner(sourceRootId);
      if (!rootOwner) throw new Error("cannot verify the Root owner for Scan intake");
      const rootSigner = folderWriteSigner(rootOwner, signer);
      if (!rootSigner) throw new Error("the Root owner key is unavailable for Scan intake");
      const scanFolderId = await getOrCreateScanFolder(sourceRootId, rootSigner);
      const scanOwner = await fetchFolderOwner(scanFolderId);
      if (!scanOwner) throw new Error("cannot verify the Scan folder owner");
      const folderSigner = folderWriteSigner(scanOwner, rootSigner);
      if (!folderSigner) throw new Error("the Scan folder owner key is unavailable");
      const scanTree: LocalFolderTree = {
        storageRootId: sourceRootId,
        folderId: scanFolderId,
        storagePath: SCAN,
      };
      for (const c of created) {
        const operationId = createTraceOperationId();
        await ensureLocalTreeFolderPath(
          scanTree,
          parentPath(c.path),
          folderSigner,
          { localOnly: true, operationId },
        );
        const coordinate = localTreeFolderCoordinate(scanTree, c.path);
        const directFolderOwner = await fetchFolderOwner(coordinate.folderId);
        const directFolderSigner = folderWriteSigner(directFolderOwner, folderSigner);
        if (!directFolderSigner) {
          throw new Error(`the Scan subfolder owner key is unavailable for ${c.path}`);
        }
        const contentHash = await sha256HexLocal(c.content);
        const runs: Run[] = c.content ? [{ voice, text: c.content }] : [];
        const event = await publishEdit({
          prevEventId: null,
          previousSnapshot: "",
          relativePath: coordinate.relativePath,
          folderId: coordinate.folderId,
          deltas: diffToDeltas("", c.content),
          snapshot: c.content,
          contentHash,
          action: "import",
          authors: runs,
          signer,
          localOnly: true,
          kedits: synthesizeKEditTransition("", c.content, voice),
          operationId,
        });
        const folderHead = await upsertManifestEntry(
          coordinate.folderId,
          {
            kind: "file",
            relativePath: coordinate.relativePath,
            latestNodeId: event.id,
            contentHash,
          },
          directFolderSigner,
          { localOnly: true, operationId },
        );
        await propagateLocalTreeFolderHead(
          scanTree,
          coordinate.folderPath,
          coordinate.folderId,
          folderHead,
          directFolderSigner,
          true,
        );
        saveLocalFile(sourceRootId, c.path, {
          content: c.content,
          tags: [],
          nodeId: event.id,
          runs,
          voicePubkey: voice,
        });
        seedSteppedRef.current({
          [c.path]: { runs, nodeId: event.id, tags: [] },
        });
        pendingPaths.current.delete(c.path);
        completed.add(c.path);
        if (folderIdRef.current === sourceRootId) {
          setFiles((prev) => ({
            ...prev,
            [c.path]: { runs, nodeId: event.id, tags: [] },
          }));
        }
      }
      setFiles((prev) => withPersistedFolderStates(prev, sourceRootId, SCAN));
      // Open the first imported file in the active panel.
      if (created.length > 0) openInActivePanel(created[0].path);
      setOpStatus(idx, "done", `${created.length} scanned`, "scan");
      if (onboardingStageRef.current === "scan-file") {
        advanceOnboarding("file-scanned");
      }
    } catch (e) {
      for (const c of created) {
        if (!completed.has(c.path)) pendingPaths.current.delete(c.path);
      }
      setFiles((prev) => {
        const next = { ...prev };
        for (const c of created) {
          if (!completed.has(c.path) && next[c.path]?.nodeId === "") delete next[c.path];
        }
        return next;
      });
      setOpStatus(idx, "error", e instanceof Error ? e.message : String(e), "scan");
    }
  }

  /** Reify: materialize exact stepped nuclei under ordinary paths. The inverse
   *  of Scan. Live editor runs are intentionally excluded: each file body is
   *  parsed from the signed node named by FileState.nodeId. Pending work can be
   *  stepped first as an explicit option, but is never folded into the export
   *  implicitly. Desktop-only.
   *
   *  Palette requests emit every scoped file and honor shielded descendants.
   *  Tree-menu requests emit the explicitly chosen file or recursive folder,
   *  including Scan and Mint. The trace is a separate opt-in .zine sidecar
   *  because it can disclose private Steps. */
  function scopedReifyTargets(explicitTarget?: ScopeRef): {
    path: string;
    relativePath: string;
    nodeId: string;
  }[] {
    // The palette Reifies the exact effective prompt scope. A context-menu
    // request instead targets the clicked tree item directly, including the
    // otherwise-unmountable Scan and Mint regions.
    const scopes = scopeRef.current;
    const soleFolder = explicitTarget?.kind === "folder"
      ? explicitTarget
      : !explicitTarget && scopes[0]?.kind === "folder"
        ? scopes[0]
        : null;
    const prefix = soleFolder && soleFolder.path !== ROOT ? `${soleFolder.path}/` : "";
    // A tree-menu target names the live directory row. Historical export stays
    // available through the palette while replay is active.
    const candidates = replayDisplay && !explicitTarget
      ? Object.entries(replayDisplay.files)
          // A global historical cursor may predate a file's genesis. Omit that
          // file rather than smuggling its live/future head into the export.
          .filter(([path, file]) => !isFolderTab(path) && !!file.nodeId)
          .map(([path, file]) => ({ path, nodeId: file.nodeId }))
      : Object.entries(files)
          .filter(([, file]) => file.kind !== "folder")
          .map(([path, file]) => ({ path, nodeId: file.nodeId }));
    const usedRelativePaths = new Set<string>();
    return candidates
      .filter(({ path }) => {
        if (!explicitTarget) return isInScope(scopes, shieldedRef.current, path);
        if (explicitTarget.kind === "file") return path === explicitTarget.path;
        if (explicitTarget.path === ROOT) {
          return !isMint(path) && !isScan(path) && !isOblivion(path);
        }
        return path.startsWith(`${explicitTarget.path}/`);
      })
      .map(({ path, nodeId }) => {
        const relativePath = explicitTarget?.kind === "file"
          ? systemPathDisplayName(path)
          : soleFolder && soleFolder.path !== ROOT
            ? path.slice(prefix.length)
            : path;
        return {
          path,
          // Mint's storage timestamp is identity metadata, not part of the
          // ordinary filename the user sees or Reifies.
          relativePath:
            explicitTarget && isMint(path) ? systemPathDisplayName(path) : relativePath,
          nodeId,
        };
      })
      .sort(
        (a, b) =>
          a.relativePath.localeCompare(b.relativePath) || a.path.localeCompare(b.path),
      )
      .map((target) => {
        const relativePath = uniquePath(target.relativePath, usedRelativePaths);
        usedRelativePaths.add(relativePath);
        return relativePath === target.relativePath ? target : { ...target, relativePath };
      });
  }

  async function onReifyOp(options: {
    stepCurrent: boolean;
    includeTrace: boolean;
    target?: ScopeRef;
  }) {
    if (!folder) return;
    const idx = opTargetPanel();
    const targets = scopedReifyTargets(options.target);
    if (targets.length === 0) {
      setOpStatus(
        idx,
        "error",
        options.target
          ? "Selected item has no files to reify"
          : "Scope folder has no files to reify",
        "reify",
      );
      return;
    }
    const dest = await chooseFolder();
    if (!dest) return; // user cancelled
    setReifyPrompt(null);
    setOpStatus(idx, "running", undefined, "reify");
    try {
      if (options.includeTrace) {
        const reserved = new Set([".zine/trace.json", ".zine/report.md"]);
        const collision = targets.find((target) =>
          reserved.has(target.relativePath.toLowerCase()),
        );
        if (collision) {
          throw new Error(`${collision.relativePath} conflicts with the trace sidecar`);
        }
      }

      if (options.stepCurrent) {
        const signer = secretKeyForVoice(authorPubkey);
        if (!signer) throw new Error(`no key for voice ${formatPubkey(authorPubkey)}`);
        for (const target of targets) {
          if (!unsteppedPathSet.has(target.path) && target.nodeId) continue;
          const steppedId = await stepFile(target.path, signer, true, false);
          if (!steppedId) throw new Error(`${target.path} did not produce a durable Step`);
          target.nodeId = steppedId;
          queueStepAnchor(steppedId, signer);
        }
      }

      const missingStep = targets.find((target) => !target.nodeId);
      if (missingStep) {
        throw new Error(`${missingStep.path} has no Step; choose “Step current & Reify”`);
      }
      const exported = await prepareReifyExport(
        targets.map((target) => ({
          relativePath: target.relativePath,
          nucleusId: target.nodeId,
        })),
        fetchEventById,
        options.includeTrace,
      );
      const entries = exported.trace
        ? [...exported.entries, ...traceSidecarEntries(exported.trace)]
        : exported.entries;
      await reifyToDisk(dest, entries);
      const reifyConformance = exported.conformance.some(
        (target) => target.status === "snapshot-only",
      )
        ? "snapshot-only"
        : "full";
      setOpStatus(
        idx,
        "done",
        `${exported.entries.length} reified${exported.trace ? " + trace" : ""} · ${traceConformanceLabel(reifyConformance)}`,
        "reify",
      );
    } catch (e) {
      setOpStatus(idx, "error", e instanceof Error ? e.message : String(e), "reify");
    }
  }

  // Open `path` in the active panel: add it as a tab if it isn't already,
  // then focus it. Re-opening an existing tab just activates it.
  function openInActivePanel(path: string) {
    setPanels((prev) =>
      mapPanel(prev, activePanel, (p) => {
        if (p.tabs.includes(path)) return { ...p, active: path };
        return { ...p, tabs: [...p.tabs, path], active: path };
      }),
    );
  }

  function focusRefForTab(path: string): FocusRef | null {
    if (!path || isCoinComposerTab(path)) return null;
    if (isFolderTab(path)) {
      const folderPath = folderTabPath(path);
      return { kind: "folder", path: folderPath, nodeId: files[folderPath]?.nodeId };
    }
    if (isCoinTab(path)) {
      const coin = files[path];
      if (!isCompletedCoinFile(coin)) return null;
      return {
        kind: "coin",
        path,
        nodeId: coin?.nodeId,
        phrase: coin ? flatten(coin.runs) : "",
      };
    }
    return { kind: "file", path, nodeId: files[path]?.nodeId };
  }

  /** Open a real tab and make it the sole focus. If replay projections are
   * mounted, compact them away first and target the corresponding live panel. */
  function activateLiveTab(path: string, trace = focusRefForTab(path)) {
    const current = panelsRef.current;
    const live = removeReplayPanels(current, activePanel);
    const targetPanel = live.panels.length > 0 ? live.activePanel : 0;
    if (current.some((panel) => panel.replayOwned)) endReplay();
    openInPanel(path, targetPanel);
    setActivePanel(targetPanel);
    commitUiFocus(trace ? locateFocus(trace, targetPanel, path) : null);
  }

  /** Open the one session-owned direct-Coin draft. Repeated activation focuses
   * the existing tab so switching away and back never discards typed bytes. */
  function openDirectCoinComposer() {
    if (!kademliaEnabledSnapshot()) return;
    const current = panelsRef.current;
    const existingPanel = current.findIndex((panel) =>
      panel.tabs.includes(DIRECT_COIN_COMPOSER_TAB),
    );
    const targetPanel = existingPanel >= 0
      ? existingPanel
      : Math.min(activePanel, current.length - 1);
    const next = mapPanel(current, targetPanel, (panel) => ({
      ...panel,
      tabs: panel.tabs.includes(DIRECT_COIN_COMPOSER_TAB)
        ? panel.tabs
        : [...panel.tabs, DIRECT_COIN_COMPOSER_TAB],
      active: DIRECT_COIN_COMPOSER_TAB,
    }));
    if (existingPanel < 0) {
      setDirectCoinDraft(emptyDirectCoinDraft());
      setDirectCoinError(null);
    }
    panelsRef.current = next;
    setPanels(next);
    setActivePanel(targetPanel);
    setEditorSelection(null);
    chooseDirectorySelection([]);
    commitUiFocus(null);
  }

  /** Keep direct-Coin KEdits in App state so the draft survives ordinary tab
   * switches even though Panel only mounts its active surface. */
  function editDirectCoinDraft(phrase: string) {
    setDirectCoinError(null);
    setDirectCoinDraft((draft) => {
      const deltas = diffToDeltas(draft.phrase, phrase);
      if (deltas.length === 0) return draft;
      const tx = draft.nextTx;
      const kedits = deltas.map((delta): KEdit => ({
        op: delta.type === "insert" ? "ins" : delta.type === "delete" ? "del" : "repl",
        from: delta.positionStart,
        to: delta.positionEnd,
        text: delta.newValue ?? "",
        voice: authorPubkey,
        t: delta.timestamp,
        tx,
      }));
      return {
        phrase,
        kedits: [...draft.kedits, ...kedits],
        nextTx: tx + 1,
      };
    });
  }

  /** Atomically turn the draft tab into the immutable Coin it produced. */
  function replaceDirectCoinComposerTab(path: string) {
    const current = panelsRef.current;
    const composerPanel = current.findIndex((panel) =>
      panel.tabs.includes(DIRECT_COIN_COMPOSER_TAB),
    );
    const targetPanel = composerPanel >= 0
      ? composerPanel
      : Math.min(activePanel, current.length - 1);
    const next = mapPanel(current, targetPanel, (panel) => {
      const draftIndex = panel.tabs.indexOf(DIRECT_COIN_COMPOSER_TAB);
      const withoutDraftOrCoin = panel.tabs.filter(
        (tab) => tab !== DIRECT_COIN_COMPOSER_TAB && tab !== path,
      );
      const at = draftIndex >= 0
        ? Math.min(draftIndex, withoutDraftOrCoin.length)
        : withoutDraftOrCoin.length;
      const tabs = [
        ...withoutDraftOrCoin.slice(0, at),
        path,
        ...withoutDraftOrCoin.slice(at),
      ];
      return { ...panel, tabs, active: path };
    });
    panelsRef.current = next;
    setPanels(next);
    setActivePanel(targetPanel);
  }

  // The four "make this the focused trace" entry points. Root files, folders,
  // and Mint Coins open in real tabs; Oblivion remains a read-only inspection
  // modal. The file's
  // kind-4290 nodeId is pulled from its FileState when present so ops can
  // address the nucleus.
  function selectFile(path: string) {
    const nodeId = files[path]?.nodeId;
    chooseDirectorySelection([]);
    activateLiveTab(path, isCoinTab(path) ? null : { kind: "file", path, nodeId });
  }
  function selectCoin(path: string) {
    const coin = files[path];
    if (!isCoinTab(path) || !isCompletedCoinFile(coin)) return;
    const phrase = flatten(coin.runs);
    setEditorSelection(null);
    chooseDirectorySelection([]);
    activateLiveTab(path, { kind: "coin", path, nodeId: coin.nodeId, phrase });
  }
  function selectOblivion(path: string) {
    const file = files[path];
    if (!file || file.kind === "folder" || !isOblivion(path)) return;
    setEditorSelection(null);
    chooseDirectorySelection([]);
    setOblivionModalPath(path);
  }
  function selectFolder(path: string) {
    // Under nesting (spec §3.2), a folder-member FileState carries the
    // subfolder's genesis as nodeId. Carrying it on the selection lets ops
    // (Send, tag, cite) address a folder-member nucleus, symmetric with
    // selectFile. Path-derived folders have no nodeId — undefined is fine.
    const nodeId = files[path]?.nodeId;
    const current = panelsRef.current;
    const live = removeReplayPanels(current, activePanel);
    const targetPanel = live.panels.length > 0 ? live.activePanel : 0;
    const targetTab = live.panels[targetPanel]?.active ?? "";
    if (current.some((panel) => panel.replayOwned)) endReplay();
    chooseDirectorySelection([]);
    setActivePanel(targetPanel);
    commitUiFocus(locateFocus({ kind: "folder", path, nodeId }, targetPanel, targetTab));
  }
  function openFolder(path: string) {
    const nodeId = files[path]?.nodeId;
    chooseDirectorySelection([]);
    activateLiveTab(folderTab(path), { kind: "folder", path, nodeId });
  }
  function commitShieldedForRoot(rootId: string, next: Set<string>): void {
    saveLocalShielded(rootId, next);
    if (folderIdRef.current !== rootId) return;
    shieldedRef.current = next;
    setShielded(next);
  }
  /** Optimistic structural projection only. The backend journals a union of
   * old/new shield paths with the durable mutation, then atomically commits
   * the final set or restores the old set. */
  function projectShieldedForRoot(rootId: string, next: Set<string>): void {
    if (folderIdRef.current !== rootId) return;
    shieldedRef.current = next;
    setShielded(next);
  }
  function selectSpan(nodeId: string, phrase: string) {
    // A node-only Coin has no directory row to highlight. Keep the semantic
    // focus, but clear path-backed Explorer focus so the UI does not imply that
    // the previously focused directory trace still owns it.
    chooseDirectorySelection([]);
    const host = uiFocusRef.current;
    if (!host) return;
    commitUiFocus(locateFocus({ kind: "coin", nodeId, phrase }, host.panelIndex, host.tabPath));
  }
  /** Replace, clear, or exclude within the one prompt-context mount. */
  function setContextMount(target: ScopeRef, mounted: boolean) {
    if (!folder) return;
    const next = applyContextMount(
      scopeRef.current,
      shieldedRef.current,
      target,
      mounted,
    );
    // Update refs at event time so a second rapid icon click observes the first
    // gesture even before React commits the render.
    scopeRef.current = next.mounts;
    shieldedRef.current = next.shielded;
    setScope(next.mounts);
    setShielded(next.shielded);
    saveLocalShielded(folder.id, next.shielded);
  }
  // Keep the focused path-backed trace's head fresh without changing its exact
  // live panel/tab locus.
  useEffect(() => {
    const focus = uiFocusRef.current;
    if (!focus?.path) return;
    const file = files[focus.path];
    const nodeId = file?.nodeId;
    const phrase = focus.kind === "coin"
      ? (file ? flatten(file.runs) : focus.phrase)
      : undefined;
    const next = refreshFocusNode(focus, nodeId);
    const currentPhrase = focus.kind === "coin" ? focus.phrase : undefined;
    if (next !== focus || phrase !== currentPhrase) {
      commitUiFocus({ ...next, ...(focus.kind === "coin" ? { phrase } : {}) });
    }
  }, [files]);

  // A live panel/tab switch is a focus gesture. Replay-owned panels are only
  // projections and therefore leave the live locus untouched. The locus key
  // also preserves a node-only Coin focus while its host tab remains stable.
  const liveTabFocusKeyRef = useRef("");
  useEffect(() => {
    const panel = panels[activePanel];
    const tab = panel?.active;
    if (!panel || panel.replayOwned) return;
    const nextKey = `${activePanel}:${tab}`;
    if (liveTabFocusKeyRef.current === nextKey) return;
    liveTabFocusKeyRef.current = nextKey;
    chooseDirectorySelection([]);
    const trace = focusRefForTab(tab);
    commitUiFocus(trace ? locateFocus(trace, activePanel, tab) : null);
  }, [activePanel, panels, files]); // eslint-disable-line react-hooks/exhaustive-deps

  // Coin focus remains a selection observation for replaying a reading session.
  // File/folder panel occupancy is
  // recorded by the transition effect below so switches and every close path
  // produce paired unmount/mount deltas exactly once.
  useEffect(() => {
    if (!uiFocus || uiFocus.kind !== "coin") return;
    const hostTab = uiFocus.tabPath;
    const focusSel: FocusSelection = {
      kind: "coin",
      nodeId: uiFocus.nodeId ?? "",
      phrase: uiFocus.phrase ?? "",
      originPath: isFolderTab(hostTab) ? "" : hostTab,
    };
    const focusPath = focusSel.originPath || null;
    const rootPaths = Object.keys(files).filter(
      (path) => !isMint(path) && !isScan(path) && !isOblivion(path),
    );
    const mounted = activeMount(folder?.id ?? null, rootPaths);
    const owner = focusPath ? ownerFolderOf(focusPath, mounted) : folderIdRef.current;
    if (!owner) return;
    const key = JSON.stringify({ focusSel, panelIndex: uiFocus.panelIndex });
    if (lastFocusKeyRef.current === key) return;
    lastFocusKeyRef.current = key;
    const handle = window.setTimeout(() => {
      const stillOwned = focusPath
        ? ownerFolderOf(focusPath, activeMount(folder?.id ?? null, rootPaths)) === owner
        : folderIdRef.current === owner;
      if (!stillOwned) return;
      bufferFocus(owner, {
        type: "focus",
        op: "mount",
        selection: focusSel,
        panelIndex: uiFocus.panelIndex,
        timestamp: Date.now(),
      });
    }, 1000);
    return () => window.clearTimeout(handle);
  }, [uiFocus, panels, files, folder]); // eslint-disable-line react-hooks/exhaustive-deps

  // Record the editor panels as folder-owned mount state. Comparing the whole
  // occupancy vector catches every way it can change—tab switch, individual or
  // bulk close, drag between panels, panel creation, and panel collapse—without
  // scattering provenance calls through UI handlers.
  useEffect(() => {
    const rootPaths = Object.keys(files).filter(
      (path) => !isMint(path) && !isScan(path) && !isOblivion(path),
    );
    const mounted = activeMount(folder?.id ?? null, rootPaths);
    const next: (PanelOccupancy | null)[] = panels.map((panel) => {
      const tab = panel.active;
      if (!tab || isCoinComposerTab(tab)) return null;
      if (isFolderTab(tab)) {
        const path = folderTabPath(tab);
        if (isMint(path) || isScan(path) || isOblivion(path)) return null;
        const ownerFolderId = folder?.id ?? "";
        if (!ownerFolderId) return null;
        const nodeId = path === ROOT ? folder?.id : files[path]?.nodeId;
        return {
          key: `folder:${path}`,
          ownerFolderId,
          selection: { kind: "folder", path, nodeId },
        };
      }
      const ownerFolderId = ownerFolderOf(tab, mounted);
      if (!ownerFolderId) return null;
      return {
        key: `file:${tab}`,
        ownerFolderId,
        selection: { kind: "file", path: tab, nodeId: files[tab]?.nodeId },
      };
    });
    const timestamp = Date.now();
    for (const transition of occupancyTransitions(panelOccupancyRef.current, next)) {
      bufferFocus(transition.entry.ownerFolderId, {
        type: "focus",
        op: transition.op,
        selection: transition.entry.selection,
        panelIndex: transition.panelIndex,
        timestamp,
      });
    }
    panelOccupancyRef.current = next;
  }, [panels, files, folder]);

  // On desktop, flush any unstepped buffers to the crash pad: the 800ms debounce
  // could miss the last keystrokes before close, and without this a close/reload
  // mid-edit would lose them. Synchronous localStorage writes land in
  // beforeunload on Chromium/WebView2 (Tauri's webview), so this is reliable
  // there; on the webapp there's no pad (localStorage IS the store).
  useEffect(() => {
    const handler = () => {
      const fid = folderIdRef.current;
      if (isTauri() && fid) {
        for (const path of unsteppedPathSet) {
          const f = files[path];
          if (f) {
            mirrorPad(fid, path, {
              content: flatten(f.runs),
              tags: f.tags,
              nodeId: f.nodeId,
              traceId: f.traceId,
              runs: f.runs,
              citationIds: f.citationIds,
              kedits: keditLogToArray(f.kedits),
            });
          }
        }
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Open a file as a tab in a specific panel (used by Reply to land the new
   *  doc in an adjacent pane). Modeled on openInActivePanel. */
  function openInPanel(path: string, idx: number) {
    setPanels((prev) =>
      mapPanel(prev, idx, (p) => {
        if (p.tabs.includes(path)) return { ...p, active: path };
        return { ...p, tabs: [...p.tabs, path], active: path };
      }),
    );
  }

  // Lazily resolve the cited traces for each currently-active file — every
  // `q` tag on the file's current head node (bracket quotes + Reply source +
  // tagged zines, all folded into one q-tag set at publish) — into named chips
  // with a count of later Steps via `resolveCitationChip`. This subsumes the
  // old single reply-to resolution:
  // a Reply is one more cited trace, not a special case. Re-resolves only
  // when the head node id actually moved (a new step changed the citation
  // set). Names cache per node id; Step distance deliberately refreshes because
  // the cited id stays fixed while that trace's head advances.
  useEffect(() => {
    if (!folder) return;
    const activePaths = panels
      .map((p) => p.active)
      .filter((p): p is string => !!p && !isFolderTab(p));
    // A path needs resolution if it's new, or its head node changed since last
    // resolve. file.nodeId is "" before the first step this session — skip
    // those; there's no head to read citations off yet.
    const pending = [...new Set(activePaths)].filter((p) => {
      const headId = files[p]?.nodeId ?? "";
      if (!headId) return false;
      return (
        citationHeadByPath[p] !== headId ||
        citationResolutionByPath[p] !== citationResolutionVersion
      );
    });
    if (pending.length === 0) return;
    let cancelled = false;
    void (async () => {
      const updates: Record<string, CitationChip[]> = {};
      const headUpdates: Record<string, string> = {};
      const resolutionUpdates: Record<string, string> = {};
      for (const path of pending) {
        const headId = files[path]?.nodeId ?? "";
        if (!headId) continue;
        try {
          const head = await fetchEventById(headId);
          const targets = head ? eventMeta(head).citationTargets : [];
          const chips = (await Promise.all(targets.map(resolveCitationChip))).filter(
            (chip): chip is CitationChip => chip != null,
          );
          updates[path] = chips;
          headUpdates[path] = headId;
          resolutionUpdates[path] = citationResolutionVersion;
        } catch {
          updates[path] = [];
          headUpdates[path] = headId;
          resolutionUpdates[path] = citationResolutionVersion;
        }
      }
      if (cancelled) return;
      if (Object.keys(updates).length > 0) {
        setCitationsByPath((prev) => ({ ...prev, ...updates }));
        setCitationHeadByPath((prev) => ({ ...prev, ...headUpdates }));
        setCitationResolutionByPath((prev) => ({ ...prev, ...resolutionUpdates }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    panels,
    folder,
    files,
    citationHeadByPath,
    citationResolutionByPath,
    citationResolutionVersion,
  ]);

  // Resolve the live local citation set for each active file: explicit
  // `citationIds` plus body brackets. Unlike `citationsByPath` (which reads the
  // stepped relay head), this keeps pinned citations visible while the relay is
  // offline and before the debounce publishes a new head.
  // A cited trace may be an unpublished local savepoint or a published zine —
  // both are stepped nodes and resolve uniformly via `resolveCitationChip`.
  useEffect(() => {
    const activePaths = panels
      .map((p) => p.active)
      .filter((p): p is string => !!p && !isFolderTab(p));
    const pending = [...new Set(activePaths)].filter((p) => {
      const file = files[p];
      const ids = [
        ...new Set([
          ...(file?.citationIds ?? []),
          ...findResolvedBrackets(flatten(file?.runs ?? [])).map((bracket) => bracket.nodeId),
        ].filter(Boolean)),
      ];
      const resolved = taggedChipByPath[p] ?? [];
      if (taggedResolutionByPath[p] !== citationResolutionVersion) return true;
      const want = new Set(ids);
      const have = new Set(resolved.map((c) => c.nodeId));
      // Need work if the sets differ (a tag was added or removed).
      if (want.size !== have.size) return true;
      for (const id of want) if (!have.has(id)) return true;
      return false;
    });
    if (pending.length === 0) return;
    let cancelled = false;
    void (async () => {
      const updates: Record<string, CitationChip[]> = {};
      const resolutionUpdates: Record<string, string> = {};
      for (const path of pending) {
        const file = files[path];
        const ids = [
          ...new Set([
            ...(file?.citationIds ?? []),
            ...findResolvedBrackets(flatten(file?.runs ?? [])).map((bracket) => bracket.nodeId),
          ].filter(Boolean)),
        ];
        const chips = (await Promise.all(ids.map(resolveCitationChip))).filter(
          (chip): chip is CitationChip => chip != null,
        );
        updates[path] = chips;
        resolutionUpdates[path] = citationResolutionVersion;
      }
      if (cancelled) return;
      if (Object.keys(updates).length > 0) {
        setTaggedChipByPath((prev) => ({ ...prev, ...updates }));
        setTaggedResolutionByPath((prev) => ({ ...prev, ...resolutionUpdates }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    panels,
    files,
    taggedChipByPath,
    taggedResolutionByPath,
    citationResolutionVersion,
  ]);

  // Resolve the inbound tracker for each currently-active file. Every relay
  // observation is keyed by the target's stable identity plus the periodic
  // citation epoch, because the citing trace can advance while this target's
  // own head stays fixed. An incomplete observation never replaces verified
  // data: the row remains visible and is explicitly marked stale/offline.
  useEffect(() => {
    if (!folder) return;
    const activePaths = panels
      .map((p) => p.active)
      .filter((p): p is string => !!p && !isFolderTab(p));
    const pending = [...new Set(activePaths)].filter((p) => {
      const file = files[p];
      const headId = file?.nodeId ?? "";
      if (!headId) return false;
      const resolutionKey = `${file?.traceId ?? headId}:${headId}:${citationResolutionVersion}`;
      return inboundResolutionByPath[p] !== resolutionKey;
    });
    if (pending.length === 0) return;
    let cancelled = false;
    void (async () => {
      const verifiedUpdates: Record<string, TraceInbound[]> = {};
      const resolutionUpdates: Record<string, string> = {};
      const freshnessUpdates: Record<string, InboundFreshness> = {};
      for (const path of pending) {
        const file = files[path];
        const headId = file?.nodeId ?? "";
        const resolutionKey = `${file?.traceId ?? headId}:${headId}:${citationResolutionVersion}`;
        resolutionUpdates[path] = resolutionKey;
        try {
          const traceId = file?.traceId ?? (headId ? await resolveTraceIdentity(headId) : null);
          if (!traceId) {
            freshnessUpdates[path] = "unavailable";
            continue;
          }
          const snapshot = await findInboundSnapshot(traceId);
          if (snapshot.complete) {
            const entries = [...snapshot.entries];
            // A local Oblivion/restore move runs ahead of its debounced relay Step.
            // Preserve a previously verified local source while its current
            // local state still supports the edge: sources in Oblivion stay
            // cached-but-render-hidden; restored sources reappear immediately
            // when their body/tag set still cites this pinned nucleus.
            for (const cached of inboundByPath[path] ?? []) {
              const localSource = Object.entries(files).find(
                ([, candidate]) =>
                  candidate.kind !== "folder" &&
                  (candidate.traceId ?? candidate.nodeId) ===
                    cached.sourceTraceId,
              );
              if (!localSource) continue;
              const [sourcePath, sourceFile] = localSource;
              const stillSupports =
                cached.kind === "fork" ||
                isOblivion(sourcePath) ||
                (sourceFile.citationIds ?? []).includes(cached.fromNodeId) ||
                findResolvedBrackets(flatten(sourceFile.runs ?? [])).some(
                  (bracket) => bracket.nodeId === cached.fromNodeId,
                );
              if (!stillSupports) continue;
              const key = `${cached.kind}:${cached.sourceTraceId}:${cached.fromNodeId}`;
              if (
                entries.some(
                  (entry) =>
                    `${entry.kind}:${entry.sourceTraceId}:${entry.fromNodeId}` ===
                    key,
                )
              ) continue;
              entries.push(cached);
            }
            verifiedUpdates[path] = entries;
            freshnessUpdates[path] = "fresh";
          } else {
            freshnessUpdates[path] = Object.prototype.hasOwnProperty.call(inboundByPath, path)
              ? "stale"
              : "unavailable";
          }
        } catch {
          freshnessUpdates[path] = Object.prototype.hasOwnProperty.call(inboundByPath, path)
            ? "stale"
            : "unavailable";
        }
      }
      if (cancelled) return;
      if (Object.keys(verifiedUpdates).length > 0) {
        setInboundByPath((prev) => ({ ...prev, ...verifiedUpdates }));
      }
      setInboundResolutionByPath((prev) => ({ ...prev, ...resolutionUpdates }));
      setInboundFreshnessByPath((prev) => ({ ...prev, ...freshnessUpdates }));
    })();
    return () => {
      cancelled = true;
    };
  }, [
    panels,
    folder,
    files,
    inboundByPath,
    inboundResolutionByPath,
    citationResolutionVersion,
  ]);

  // Resolve names for inbound entries whose `sourceEventId` has no name yet —
  // forks/taggers/citers all surface a node id, and `resolveNodeName` caches per
  // id, so a trace forking many docs resolves once for the session. Mirrors the
  // tagged-traces name resolution: keyed on the set of ids that still lack a
  // name, so a newly discovered inbound signal gets a label without a refetch.
  useEffect(() => {
    const activePaths = panels
      .map((p) => p.active)
      .filter((p): p is string => !!p && !isFolderTab(p));
    let needsWork = false;
    const wantByName: Record<string, Set<string>> = {};
    for (const path of [...new Set(activePaths)]) {
      const entries = inboundByPath[path] ?? [];
      const unnamed = entries.filter((e) => e.name === undefined).map((e) => e.sourceEventId);
      if (unnamed.length > 0) {
        needsWork = true;
        wantByName[path] = new Set(unnamed);
      }
    }
    if (!needsWork) return;
    let cancelled = false;
    void (async () => {
      const updates: Record<string, TraceInbound[]> = {};
      for (const [path, want] of Object.entries(wantByName)) {
        const entries = inboundByPath[path] ?? [];
        if (entries.length === 0) continue;
        const names = new Map<string, string>();
        for (const nodeId of want) {
          const chip = await resolveNodeName(nodeId);
          if (chip) names.set(nodeId, chip.name);
        }
        // Only write if something actually resolved — avoids a churn loop.
        const next = entries.map((e) =>
          e.name === undefined && names.has(e.sourceEventId)
            ? { ...e, name: names.get(e.sourceEventId)! }
            : e,
        );
        if (next.some((e, i) => e.name !== entries[i]?.name)) {
          updates[path] = next;
        }
      }
      if (cancelled) return;
      if (Object.keys(updates).length > 0) {
        setInboundByPath((prev) => ({ ...prev, ...updates }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [panels, inboundByPath]);

  /** Fetch a file's full step chain and open the Steps modal on it.
   *  `pinnedEventId`, when given, seeds the modal's selected index at that
   *  exact node (used by a cited-trace chip) rather than the head. */
  /** A cited/tagged-trace chip's click handler: resolve the cited node's own
   *  path (from its `file`/`F` tag, via eventMeta) and open that file in the
   *  press. The chronological Steps modal that used to open here is gone — the
   *  step-to-step review now happens in Diff mode while scrubbing the stepper.
   *  A malformed node with no `F` path cannot open as a document, so its chip
   *  remains display-only. */
  async function openCitedTrace(nodeId: string) {
    let traceId: string | null = null;
    for (const chips of [
      ...Object.values(citationsByPath),
      ...Object.values(taggedChipByPath),
    ]) {
      const cached = chips.find((chip) => chip.nodeId === nodeId && chip.traceId);
      if (cached?.traceId) {
        traceId = cached.traceId;
        break;
      }
    }
    if (!traceId) {
      try {
        traceId = await resolveTraceIdentity(nodeId);
      } catch {
        // A locally mounted exact node may still open below.
      }
    }
    const localPath = Object.entries(files).find(
      ([, file]) =>
        file.nodeId === nodeId ||
        (!!traceId && (file.traceId ?? file.nodeId) === traceId),
    )?.[0];
    if (localPath) {
      if (isCompletedCoinPath(localPath, files)) selectCoin(localPath);
      else selectFile(localPath);
      return;
    }
    if (!traceId) return;
    try {
      const resolution = await resolveTraceChain(traceId);
      if (resolution.status === "resolved") {
        const head = resolution.chain[resolution.chain.length - 1];
        const currentPath = head ? eventMeta(head).relativePath : undefined;
        if (currentPath) {
          if (isCompletedCoinPath(currentPath, files)) selectCoin(currentPath);
          else selectFile(currentPath);
        }
      }
    } catch {
      // The current trace chain is unavailable.
    }
  }

  // --- folder-wide delta replay (step-to-step) ---------------------------
  //
  // One interleaved sequence spans every selected trace and folder membership
  // event. Every cursor index is a real Step. Historical runs are projected
  // into a session-owned read-only panel, so the live editor remains untouched
  // and manual scrubbing follows the same routing as Play.

  /** Resolve selected replay while exposing one transport-level loading state.
   *  The sequence guard prevents an older request from hiding the spinner while
   *  a newer mount is still resolving. */
  async function beginReplay(): Promise<boolean> {
    const sequence = ++replayLoadSequenceRef.current;
    setReplayLoading(true);
    try {
      return await loadReplay(sequence);
    } finally {
      if (replayLoadSequenceRef.current === sequence) setReplayLoading(false);
    }
  }

  /** Load replay for the focused recursive zine. Resolve every flattened UI
   *  path to its direct folder trace, fetch each selected file/folder chain
   *  once, and precompute content so stepping is O(1). Best-effort: a
   *  slow/unreachable relay yields an empty timeline rather than throwing —
   *  auto-bootstrap on folder load must never reject unhandled. */
  async function loadReplay(sequence: number): Promise<boolean> {
    if (!folder) return false;
    const replayRootId = folder.id;
    const target = focusReplayTarget(uiFocusRef.current);
    const playbackScopes = target ? [target] : [];
    if (playbackScopes.length === 0) return false;
    const sources = recursiveReplaySources(
      folder.id,
      filesRef.current,
      playbackScopes,
      loadLocalFolder(folder.id)?.nodeId,
    );
    const steps: ReplayStep[] = [];
    const replayStepByEventId = new Map<string, ReplayStep>();
    const addReplayProjection = (projection: ReplayStep) => {
      const existing = replayStepByEventId.get(projection.event.id);
      if (!existing) {
        replayStepByEventId.set(projection.event.id, projection);
        steps.push(projection);
        return;
      }
      const projectionPath = projection.folder?.path ?? projection.relativePath;
      const existingPaths = new Set([
        existing.folder?.path ?? existing.relativePath,
        ...(existing.occurrenceProjections ?? []).map(
          (candidate) => candidate.folder?.path ?? candidate.relativePath,
        ),
      ]);
      if (existingPaths.has(projectionPath)) return;
      existing.occurrenceProjections = [
        ...(existing.occurrenceProjections ?? []),
        projection,
      ];
    };
    const chains: Record<string, Event[]> = {};
    const conformanceVerdicts: TraceConformanceVerdict[] = [];
    const collapsibleNodeIds = new Set<string>();
    type ReplayFileSource = RecursiveReplayFileSource & {
      contentHash?: string;
      observedAtMs?: number;
      removedAtMs?: number;
    };
    type ReplayFolderSource = RecursiveReplayFolderSource & {
      contentHash?: string;
      ancestors: string[];
    };
    const replayFileEventPromises = new Map<string, Promise<Event | null>>();
    const replayFileEvents = new Map<string, Event>();
    let replayFileSignedBytes = 0;
    const loadReplayFileEvents = async (ids: readonly string[]): Promise<Event[]> => {
      const loaded = await Promise.all(ids.map(async (id) => {
        let pending = replayFileEventPromises.get(id);
        if (!pending) {
          if (replayFileEventPromises.size >= TRACE_TRAVERSAL_MAX_EVENTS) {
            throw new Error(
              `Replay file history exceeds ${TRACE_TRAVERSAL_MAX_EVENTS} signed events`,
            );
          }
          pending = fetchEventById(id).then((event) => event ?? null);
          replayFileEventPromises.set(id, pending);
        }
        const event = await pending;
        if (event && !replayFileEvents.has(event.id)) {
          replayFileSignedBytes += traceSignedEventBytes(event);
          if (replayFileSignedBytes > TRACE_TRAVERSAL_MAX_SIGNED_BYTES) {
            throw new Error(
              `Replay file history exceeds ${TRACE_TRAVERSAL_MAX_SIGNED_BYTES} signed bytes`,
            );
          }
          replayFileEvents.set(event.id, event);
        }
        return event;
      }));
      return loaded.filter((event): event is Event => event !== null);
    };
    const identityByNode = new Map<string, { traceId: string; depth: number }>();
    const resolveReplayFileIdentity = async (
      nodeId: string,
    ): Promise<{ traceId: string; depth: number }> => {
      const cached = identityByNode.get(nodeId);
      if (cached) return cached;
      const trail: Event[] = [];
      const seen = new Set<string>();
      let cursor: string | null = nodeId;
      let base: { traceId: string; depth: number } | null = null;
      while (cursor) {
        const known = identityByNode.get(cursor);
        if (known) {
          base = known;
          break;
        }
        if (seen.has(cursor)) throw new Error(`file ancestry cycle at ${cursor}`);
        seen.add(cursor);
        const event: Event | undefined = (await loadReplayFileEvents([cursor]))[0];
        if (
          !event ||
          event.kind !== 4290 ||
          !event.tags.some((tag) => tag[0] === "z" && tag[1] === "file")
        ) {
          throw new Error(`cannot resolve file identity at ${cursor}`);
        }
        trail.push(event);
        cursor = event.tags.find((tag) => tag[0] === "e" && tag[3] === "prev")?.[1] ?? null;
        if (!cursor) base = { traceId: event.id, depth: 0 };
      }
      if (!base) throw new Error(`cannot resolve file identity at ${nodeId}`);
      for (let index = trail.length - 1; index >= 0; index -= 1) {
        const event = trail[index]!;
        if (event.id === base.traceId && base.depth === 0) {
          identityByNode.set(event.id, base);
          continue;
        }
        base = { traceId: base.traceId, depth: base.depth + 1 };
        identityByNode.set(event.id, base);
      }
      return identityByNode.get(nodeId) ?? base;
    };
    const loadPinnedFile = async (
      source: ReplayFileSource,
      historical: boolean,
      selectedByPath: boolean,
    ) => {
      try {
        const { traceId } = await resolveReplayFileIdentity(source.nodeId);
        const resolution = await resolveTraceChainAtHead(
          traceId,
          source.nodeId,
          loadReplayFileEvents,
        );
        if (resolution?.status !== "resolved") {
          throw new Error(`cannot resolve exact file head ${source.nodeId}`);
        }
        const chain = resolution.chain;
        const head = chain[chain.length - 1];
        if (!head || head.id !== source.nodeId) {
          throw new Error(`file chain does not end at membership pin ${source.nodeId}`);
        }
        if (source.contentHash && replayNodeContentHash(head) !== source.contentHash) {
          throw new Error(`file membership hash does not match ${source.nodeId}`);
        }
        return {
          ok: true as const,
          source,
          chain,
          pinnedChainLength: chain.length,
          traceId,
          historical,
          selectedByPath,
          verdict: await verifyFileTraceChain(chain, {
            expectedNucleusId: source.nodeId,
            expectedTraceId: traceId,
          }),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[replay] file trace failed for ${source.path}:`, error);
        return {
          ok: false as const,
          verdict: replayLoadFailure("recursive-file-unavailable", message, source.nodeId),
        };
      }
    };

    // Resolve the selected file identities first. Their exact chains name every
    // historical direct folder coordinate, allowing folder discovery to follow
    // moved files without downloading unrelated sibling file histories.
    const currentFileResults = await mapReplayBounded(
      sources.files,
      REPLAY_LOAD_CONCURRENCY,
      (source) => loadPinnedFile(source, false, true),
    );
    const currentFiles = currentFileResults.flatMap((result) => {
      if (result.ok) return [result];
      conformanceVerdicts.push(result.verdict);
      return [];
    });
    const selectedFileNodeIds = new Set(
      currentFiles.flatMap((result) => result.chain.map((event) => event.id)),
    );
    const requiredFolderIds = new Set(
      currentFiles.flatMap((result) =>
        result.chain.flatMap((event) => {
          const folderId = event.tags.find((tag) => tag[0] === "f")?.[1];
          return folderId ? [folderId] : [];
        })
      ),
    );
    const prefetchedFolderNodes = new Map<string, Promise<Event[]>>();
    const requiredFolderIdByNodeId = new Map<string, string>();
    const loadReplayFolderNodes = (folderId: string): Promise<Event[]> =>
      memoizedReplayFolderNodeLoad(
        prefetchedFolderNodes,
        folderId,
        async () => {
          try {
            const nodes = await fetchFolderNodes(folderId);
            for (const event of nodes) requiredFolderIdByNodeId.set(event.id, folderId);
            return nodes;
          } catch {
            return [];
          }
        },
      );
    await mapReplayBounded(
      [...requiredFolderIds],
      REPLAY_LOAD_CONCURRENCY,
      loadReplayFolderNodes,
    );

    const historicalFiles = new Map<string, ReplayFileSource>();
    const historicalFilesSelectedByPath = new Set<string>();
    const includeDescendantsByFolderId = new Map(
      sources.folders.map((source) => [
        source.folderId,
        playbackScopes.some((scope) =>
          scope.kind === "folder" &&
          (scope.path === "" ||
            source.path === scope.path ||
            source.path.startsWith(`${scope.path}/`)),
        ),
      ]),
    );
    const currentFolderIdByPath = new Map(
      sources.folders.map((source) => [source.path, source.folderId]),
    );
    const currentAncestors = (path: string): string[] => {
      if (!path) return [];
      const ancestors = [folder.id];
      const segments = path.split("/");
      for (let index = 1; index < segments.length; index++) {
        const ancestorPath = segments.slice(0, index).join("/");
        const ancestorId = currentFolderIdByPath.get(ancestorPath);
        if (ancestorId) ancestors.push(ancestorId);
      }
      return [...new Set(ancestors)];
    };
    const initialFolderSources: ReplayFolderSource[] = sources.folders.map((source) => ({
      ...source,
      ancestors: currentAncestors(source.path),
    })).sort((left, right) =>
      left.path.split("/").length - right.path.split("/").length ||
      left.path.localeCompare(right.path)
    );
    const folderOccurrenceKey = (source: ReplayFolderSource) =>
      `${source.folderId}\u0000${source.path}\u0000${source.nodeId ?? ""}`;
    const queuedFolderOccurrences = new Set<string>();
    const folderQueue: ReplayFolderSource[] = [];
    for (const source of initialFolderSources) {
      const admission = admitReplayFolderOccurrence(
        queuedFolderOccurrences,
        folderOccurrenceKey(source),
        source.path,
      );
      if (admission.error) {
        conformanceVerdicts.push(replayLoadFailure(
          "recursive-folder-budget-exceeded",
          admission.error,
          source.nodeId,
        ));
      } else if (admission.admitted) {
        folderQueue.push(source);
      }
    }
    const inspectedHistoricalFolderPins = new Set<string>();
    let historicalFolderDiscoverySlots = Math.max(
      0,
      REPLAY_MAX_FOLDER_OCCURRENCES - queuedFolderOccurrences.size,
    );
    let historicalFolderBudgetReported = false;

    // Folder history is the index for descendants that no longer exist in the
    // live local tree. Walk verified historical folder members breadth-first;
    // current descendants are already queued, while removed folders are found
    // through the pinned checkpoint stored in their former parent snapshot.
    while (folderQueue.length > 0) {
      // Process ancestors before descendants. Historical path occurrences
      // discovered from a parent are inserted ahead of the current projection,
      // so immutable child Steps are emitted at the path where they happened.
      const depth = folderQueue[0]!.path.split("/").filter(Boolean).length;
      const batch: ReplayFolderSource[] = [];
      while (
        folderQueue.length > 0 &&
        folderQueue[0]!.path.split("/").filter(Boolean).length === depth
      ) {
        batch.push(folderQueue.shift()!);
      }
      const loaded = await mapReplayBounded(
        batch,
        REPLAY_LOAD_CONCURRENCY,
        async (source) => {
          try {
            const folderNodes = await loadReplayFolderNodes(source.folderId);
            const chain = source.nodeId
              ? orderReplayTraceChainAtHead(
                  folderNodes,
                  source.folderId,
                  source.nodeId,
                )
              : orderReplayTraceChain(folderNodes, source.folderId);
            if (chain.length === 0) {
              throw new Error(`cannot resolve exact folder head ${source.nodeId ?? source.folderId}`);
            }
            const head = chain[chain.length - 1];
            if (source.contentHash && replayNodeContentHash(head) !== source.contentHash) {
              throw new Error(`folder membership hash does not match ${source.nodeId}`);
            }
            const verdict = await verifyFolderTraceChain(chain, {
              ...(source.nodeId ? { expectedNucleusId: source.nodeId } : {}),
              expectedTraceId: source.folderId,
            });
            return { ok: true as const, source, chain, verdict };
          } catch (error) {
            console.warn(`[replay] folder trace failed for ${source.path || "Root"}:`, error);
            return {
              ok: false as const,
              source,
              verdict: replayLoadFailure(
                "recursive-folder-unavailable",
                error instanceof Error ? error.message : String(error),
                source.nodeId,
              ),
            };
          }
        },
      );
      const historicalFolders = new Map<string, {
        member: ReturnType<typeof historicalReplayMembers>[number];
        parent: ReplayFolderSource;
      }>();
      for (const result of loaded) {
        if (!result.ok) {
          conformanceVerdicts.push(result.verdict);
          continue;
        }
        const { source, chain, verdict } = result;
        const includeDescendants = includeDescendantsByFolderId.get(source.folderId) ?? false;
        conformanceVerdicts.push(verdict);
        if (verdict.status === "full") {
          for (const checked of verdict.steps) collapsibleNodeIds.add(checked.nodeId);
          for (const member of historicalReplayMembers(source.folderId, source.path, chain)) {
            if (member.kind === "file") {
              const memberKey = `${member.path}\u0000${member.nodeId}`;
              const selectedCurrent = currentFiles.find((result) =>
                result.source.path === member.path && result.source.nodeId === member.nodeId
              );
              if (
                selectedCurrent &&
                replayNodeContentHash(selectedCurrent.chain[selectedCurrent.chain.length - 1]) !==
                  member.contentHash
              ) {
                conformanceVerdicts.push(replayLoadFailure(
                  "recursive-file-pin-invalid",
                  `file membership hash does not match ${member.nodeId}`,
                  member.nodeId,
                ));
              }
              historicalFiles.set(memberKey, {
                path: member.path,
                folderId: member.parentFolderId,
                relativePath: member.relativePath,
                nodeId: member.nodeId,
                contentHash: member.contentHash,
                observedAtMs: member.observedAtMs,
                removedAtMs: member.removedAtMs,
              });
              if (
                includeDescendants ||
                playbackScopes.some((scope) =>
                  scope.kind === "file" && scope.path === member.path
                )
              ) {
                historicalFilesSelectedByPath.add(memberKey);
              }
            } else {
              const pinKey = `${member.path}\u0000${member.nodeId}`;
              if (inspectedHistoricalFolderPins.has(pinKey)) continue;
              inspectedHistoricalFolderPins.add(pinKey);
              // Charge the occurrence before fetching the pinned node or
              // resolving its identity. Otherwise one large historical folder
              // snapshot can perform unbounded relay work before admission.
              if (historicalFolderDiscoverySlots <= 0) {
                if (!historicalFolderBudgetReported) {
                  conformanceVerdicts.push(replayLoadFailure(
                    "recursive-folder-budget-exceeded",
                    `recursive Replay folder occurrences exceed ${REPLAY_MAX_FOLDER_OCCURRENCES}`,
                    member.nodeId,
                  ));
                  historicalFolderBudgetReported = true;
                }
                continue;
              }
              historicalFolderDiscoverySlots--;
              historicalFolders.set(pinKey, {
                member,
                parent: source,
              });
            }
          }
        }
        const chainKey = `folder:${source.folderId}`;
        if ((chains[chainKey]?.length ?? 0) < chain.length) chains[chainKey] = chain;
        for (const event of chain) {
          addReplayProjection(folderReplayStep(event, source.path));
        }
      }

      const discoveredFolders = await mapReplayBounded(
        [...historicalFolders.values()],
        REPLAY_LOAD_CONCURRENCY,
        async ({ member, parent }) => {
          try {
            const checkpoint = await fetchEventById(member.nodeId);
            const claimedFolderId = folderTraceIdentityFromNode(checkpoint) ??
              requiredFolderIdByNodeId.get(member.nodeId) ?? null;
            const folderId = await resolveVerifiedFolderTraceIdentityAtHead(checkpoint);
            if (
              !folderId ||
              replayNodeContentHash(checkpoint) !== member.contentHash
            ) {
              return { member, parent, claimedFolderId, source: null };
            }
            return {
              member,
              parent,
              claimedFolderId: folderId,
              source: {
                path: member.path,
                folderId,
                nodeId: member.nodeId,
                contentHash: member.contentHash,
                ancestors: [...parent.ancestors, parent.folderId],
              } satisfies ReplayFolderSource,
            };
          } catch {
            return { member, parent, claimedFolderId: null, source: null };
          }
        },
      );
      const newlyDiscovered: ReplayFolderSource[] = [];
      for (const discovered of discoveredFolders) {
        const { parent, member, claimedFolderId, source } = discovered;
        const parentIncludesDescendants = includeDescendantsByFolderId.get(
          parent.folderId,
        ) ?? false;
        const required = claimedFolderId ? requiredFolderIds.has(claimedFolderId) : false;
        const selectedFolder = claimedFolderId
          ? includeDescendantsByFolderId.has(claimedFolderId)
          : false;
        if (!source) {
          if (parentIncludesDescendants || required || selectedFolder) {
            conformanceVerdicts.push(replayLoadFailure(
              "recursive-folder-pin-invalid",
              `cannot verify pinned folder member ${member.nodeId}`,
              member.nodeId,
            ));
          }
          continue;
        }
        if (source.ancestors.includes(source.folderId)) {
          conformanceVerdicts.push(replayLoadFailure(
            "recursive-folder-cycle",
            `folder ${source.folderId} recursively contains itself`,
            source.nodeId,
          ));
          continue;
        }
        if (
          !parentIncludesDescendants &&
          !includeDescendantsByFolderId.has(source.folderId) &&
          !requiredFolderIds.has(source.folderId)
        ) {
          continue;
        }
        if (parentIncludesDescendants) {
          includeDescendantsByFolderId.set(source.folderId, true);
        }
        const key = folderOccurrenceKey(source);
        const admission = admitReplayFolderOccurrence(
          queuedFolderOccurrences,
          key,
          source.path,
        );
        if (admission.error) {
          conformanceVerdicts.push(replayLoadFailure(
            "recursive-folder-budget-exceeded",
            admission.error,
            source.nodeId,
          ));
        } else if (admission.admitted) {
          newlyDiscovered.push(source);
        }
      }
      folderQueue.unshift(...newlyDiscovered);
    }

    const currentFileHeads = new Set(
      sources.files.map((source) => `${source.path}\u0000${source.nodeId}`),
    );
    const fileRequests = [
      ...[...historicalFiles.values()]
        .filter((source) => !currentFileHeads.has(`${source.path}\u0000${source.nodeId}`))
        .filter((source) => {
          const key = `${source.path}\u0000${source.nodeId}`;
          return historicalFilesSelectedByPath.has(key) || selectedFileNodeIds.has(source.nodeId);
        })
        .map((source) => ({
          source,
          historical: true,
          selectedByPath: historicalFilesSelectedByPath.has(
            `${source.path}\u0000${source.nodeId}`,
          ),
        })),
    ];
    const identifiedHistoricalRequests = await mapReplayBounded(
      fileRequests,
      REPLAY_LOAD_CONCURRENCY,
      async (request) => {
        try {
          return {
            ok: true as const,
            request,
            identity: await resolveReplayFileIdentity(request.source.nodeId),
          };
        } catch (error) {
          return {
            ok: false as const,
            verdict: replayLoadFailure(
              "recursive-file-unavailable",
              error instanceof Error ? error.message : String(error),
              request.source.nodeId,
            ),
          };
        }
      },
    );
    const historicalFileResults: Awaited<ReturnType<typeof loadPinnedFile>>[] = [];
    const requestsByTrace = new Map<
      string,
      Array<Extract<typeof identifiedHistoricalRequests[number], { ok: true }>>
    >();
    for (const identified of identifiedHistoricalRequests) {
      if (!identified.ok) {
        historicalFileResults.push({ ok: false, verdict: identified.verdict });
        continue;
      }
      const group = requestsByTrace.get(identified.identity.traceId) ?? [];
      group.push(identified);
      requestsByTrace.set(identified.identity.traceId, group);
    }
    for (const group of requestsByTrace.values()) {
      // Identity walks above populated every prev edge once. Only maximal pins
      // need exact-chain resolution; all other occurrence prefixes are slices
      // of one verified maximal chain rather than fresh O(N) relay walks.
      const candidatesByNodeId = new Map(
        group.map((candidate) => [candidate.request.source.nodeId, candidate]),
      );
      const dominated = new Set<string>();
      const traversed = new Set<string>();
      const maxima: typeof group = [];
      for (const candidate of [...candidatesByNodeId.values()].sort(
        (left, right) => right.identity.depth - left.identity.depth,
      )) {
        const headId = candidate.request.source.nodeId;
        if (dominated.has(headId)) continue;
        maxima.push(candidate);
        let cursor: string | undefined = headId;
        while (cursor && !traversed.has(cursor)) {
          traversed.add(cursor);
          const event = replayFileEvents.get(cursor);
          const previous = event?.tags.find(
            (tag) => tag[0] === "e" && tag[3] === "prev",
          )?.[1];
          if (previous && candidatesByNodeId.has(previous)) dominated.add(previous);
          cursor = previous;
        }
      }
      const assigned = new Set<typeof group[number]>();
      for (const maximal of maxima) {
        const loaded = await loadPinnedFile(
          maximal.request.source,
          true,
          maximal.request.selectedByPath,
        );
        if (!loaded.ok) {
          historicalFileResults.push(loaded);
          continue;
        }
        const indexById = new Map(loaded.chain.map((event, index) => [event.id, index]));
        for (const candidate of group) {
          if (assigned.has(candidate)) continue;
          const index = indexById.get(candidate.request.source.nodeId);
          if (index === undefined) continue;
          const head = loaded.chain[index];
          if (
            candidate.request.source.contentHash &&
            (!head || replayNodeContentHash(head) !== candidate.request.source.contentHash)
          ) {
            historicalFileResults.push({
              ok: false,
              verdict: replayLoadFailure(
                "recursive-file-unavailable",
                `file membership hash does not match ${candidate.request.source.nodeId}`,
                candidate.request.source.nodeId,
              ),
            });
            assigned.add(candidate);
            continue;
          }
          historicalFileResults.push({
            ...loaded,
            source: candidate.request.source,
            // Share the verified maximal chain. The pinned length bounds this
            // occurrence without materializing every O(N) prefix.
            pinnedChainLength: index + 1,
            selectedByPath: candidate.request.selectedByPath,
          });
          assigned.add(candidate);
        }
      }
    }
    const historicalFileResultsAvailable = historicalFileResults.flatMap((result) => {
      if (result.ok) return [result];
      conformanceVerdicts.push(result.verdict);
      return [];
    });
    const availableFiles = [...historicalFileResultsAvailable, ...currentFiles];
    const selectedTraceIds = new Set(
      availableFiles.filter((result) => !result.historical).map((result) => result.traceId),
    );
    const orderedFiles = availableFiles
      .filter((result) =>
        !result.historical ||
        result.selectedByPath ||
        selectedTraceIds.has(result.traceId)
      )
      .sort((left, right) =>
        left.traceId.localeCompare(right.traceId) ||
        left.pinnedChainLength - right.pinnedChainLength ||
        (left.source.observedAtMs ?? Number.MAX_SAFE_INTEGER) -
          (right.source.observedAtMs ?? Number.MAX_SAFE_INTEGER) ||
        left.source.path.localeCompare(right.source.path),
      );
    const longestByTrace = new Map<string, typeof orderedFiles[number]>();
    for (const result of orderedFiles) longestByTrace.set(result.traceId, result);
    type TemporalFileOccurrence = {
      path: string;
      observedAtMs: number;
      removedAtMs?: number;
    };
    const occurrencesByTrace = new Map<string, TemporalFileOccurrence[]>();
    for (const result of orderedFiles) {
      const membership = historicalFiles.get(
        `${result.source.path}\u0000${result.source.nodeId}`,
      );
      const observedAtMs = result.source.observedAtMs ??
        membership?.observedAtMs ?? Number.MIN_SAFE_INTEGER;
      const removedAtMs = result.source.removedAtMs ?? membership?.removedAtMs;
      const occurrences = occurrencesByTrace.get(result.traceId) ?? [];
      const previous = [...occurrences].reverse().find(
        (candidate) => candidate.path === result.source.path,
      );
      if (previous && previous.removedAtMs === observedAtMs) {
        previous.removedAtMs = removedAtMs;
      } else if (
        !previous ||
        previous.observedAtMs !== observedAtMs ||
        previous.removedAtMs !== removedAtMs
      ) {
        occurrences.push({
          path: result.source.path,
          observedAtMs,
          ...(removedAtMs !== undefined ? { removedAtMs } : {}),
        });
      }
      occurrencesByTrace.set(result.traceId, occurrences);
    }
    for (const { traceId, chain, verdict } of longestByTrace.values()) {
      chains[`file:${traceId}`] = chain;
      conformanceVerdicts.push(verdict);
      if (verdict.status === "full") {
        for (const checked of verdict.steps) collapsibleNodeIds.add(checked.nodeId);
      }
    }
    for (const { traceId, chain } of longestByTrace.values()) {
      const occurrences = occurrencesByTrace.get(traceId) ?? [];
      const firstObservedAt = Math.min(...occurrences.map((occurrence) => occurrence.observedAtMs));
      const runsTimeline = reconstructRunsTimeline(chain);
      let prevContent = "";
      for (const [idx, event] of chain.entries()) {
        const meta = eventMeta(event);
        const parsed = JSON.parse(event.content) as { snapshot?: unknown };
        if (typeof parsed.snapshot !== "string") {
          throw new Error(`TraceNode ${event.id} is missing its required snapshot`);
        }
        const contentUpToHere = parsed.snapshot;
        for (const occurrence of occurrences) {
          const isInitialOccurrence = occurrence.observedAtMs === firstObservedAt;
          if (!replayPathOccurrenceActiveAt(occurrence, meta.steppedAtMs, isInitialOccurrence)) {
            continue;
          }
          addReplayProjection({
            event,
            relativePath: occurrence.path,
            meta,
            contentUpToHere,
            runsUpToHere: runsTimeline[idx] ?? [],
            changeRange: stepDeltaRange(prevContent, contentUpToHere),
          });
        }
        prevContent = contentUpToHere;
      }
    }
    if (
      sequence !== replayLoadSequenceRef.current ||
      folderIdRef.current !== replayRootId ||
      steps.length === 0
    ) return false;
    // Step-time order, ascending. stable tie-break keeps same-ms steps in
    // their original activity order rather than shuffling them.
    const causallyOrderedSteps = orderReplayTimelineSteps(steps);
    const visibleSteps = collapseDerivedFolderCheckpoints(causallyOrderedSteps, {
      collapsibleNodeIds,
    });
    // Bootstrap the transport at the newest real Step. This does not open or
    // alter an editor tab; the replay panel is created only by a replay gesture.
    const last = visibleSteps.length - 1;
    setReplay({ steps: visibleSteps, index: last });
    replayRef.current = { steps: visibleSteps, index: last };
    replayChainsRef.current = chains;
    setReplayConformance(
      conformanceVerdicts.length > 0
        ? combineTraceConformance(conformanceVerdicts)
        : null,
    );
    setPlaying(false);
    const timingFrames = buildKeditTimeline() ?? [];
    const loadedTimeline = timingFrames.length > 0 ? timingFrames : null;
    const loadedCursor = Math.max(0, timingFrames.length - 1);
    playTimelineRef.current = loadedTimeline;
    setPlayTimeline(loadedTimeline);
    playCursorRef.current = loadedCursor;
    setPlayCursor(loadedCursor);
    setReplayTiming(
      buildReplayTiming([
        ...timingFrames.map((frame) => frame.at),
        ...visibleSteps.map((step) => step.meta.steppedAtMs),
      ], timingFrames.map((frame) => frame.at)),
    );
    // Attribution debug: with localStorage `zine.debug.attribution` set,
    // reconstructRunsFromChain tallies how many nodes per chain hit each tier
    // (authors-adopted / wholesale-signer-reset / delta-signer-insert / no-op).
    // Surface it once per replay entry so the replay-collapse bug can be
    // diagnosed without a debugger — if `tiers[0]` is low and `collapsedSigners`
    // is non-empty, the chain's nodes aren't carrying a faithful `authors` map
    // and coloring will collapse to those signers (the unrecoverable case for
    // already-stepped nodes). High `tiers[0]` with few `voices` means the map
    // itself is single-voice — the write side lost multi-author runs.
    const dbg = auditAttribution();
    if (dbg) {
      // eslint-disable-next-line no-console
      console.info(
        `[attribution] chains=${dbg.chains} ` +
          `tiers=[authors:${dbg.tiers[0]} wholesale:${dbg.tiers[1]} delta:${dbg.tiers[2]} noop:${dbg.tiers[3]}] ` +
          `collapsedSigners=${dbg.collapsedSigners.length} voices=${dbg.voices.length}`,
        { collapsedSigners: dbg.collapsedSigners, voices: dbg.voices },
      );
    }
    return true;
  }

  /** Re-read the selected timeline after a structural gesture becomes durable.
   *  Structural backends update paths optimistically, before their file/folder
   *  nodes exist on the relay, so the ordinary state signature can fire too
   *  early. The completion callback closes that race without disturbing a user
   *  who is deliberately parked on a historical step. */
  function refreshMountedReplay(expectedRootId = folder?.id) {
    if (!expectedRootId || folderIdRef.current !== expectedRootId) return;
    const current = replayRef.current;
    if (replayDisplay) return;
    if (current && current.index !== current.steps.length - 1) return;
    void beginReplay().catch((error) => {
      console.warn("[replay] live structural refresh failed:", error);
    });
  }

  function setReplayCursor(n: number) {
    const current = replayRef.current;
    if (!current || current.steps.length === 0) return;
    const index = Math.max(0, Math.min(n, current.steps.length - 1));
    if (current.index === index) return;
    const next = { ...current, index };
    replayRef.current = next;
    setReplay(next);
  }

  /** Seek to a real saved Step and render it in the shared replay panel. */
  function replayStepTo(n: number) {
    const r = replayRef.current;
    if (!r || r.steps.length === 0) return;
    const clamped = Math.max(0, Math.min(n, r.steps.length - 1));
    const display = replayDisplayAt(r.steps, clamped);
    replayDisplayRef.current = display;
    setReplayDisplay(display);
    const target = r.steps[clamped];
    const targetPath = target?.folder ? "" : target?.relativePath ?? "";
    syncReplayPanels(
      display,
      targetPath,
      targetPath ? display.panelIndexByPath[targetPath] : undefined,
    );
    const playheadAt = target?.meta.steppedAtMs;
    setReplayPlayheadAt(playheadAt);
    const timeline = playTimelineRef.current ?? buildKeditTimeline();
    if (timeline && timeline.length > 0 && playheadAt !== undefined) {
      const cursor = Math.max(0, replayFrameIndexAtOrBefore(timeline, playheadAt));
      playTimelineRef.current = timeline;
      setPlayTimeline(timeline);
      playCursorRef.current = cursor;
      setPlayCursor(cursor);
    }
    setReplayCursor(clamped);
  }

  /** Seek to an exact replay action and rebuild replay-only editor/focus state.
   *  The action index remains unambiguous when multiple events share a clock. */
  function seekReplayToAction(n: number) {
    const r = replayRef.current;
    if (!r || r.steps.length === 0) return;
    const timeline = playTimelineRef.current ?? buildKeditTimeline();
    if (!timeline || timeline.length === 0) return;
    const cursor = Math.max(0, Math.min(timeline.length - 1, Math.trunc(n)));
    const target = timeline[cursor];
    if (!target) return;
    const display = replayDisplayThroughFrame(timeline, cursor);

    setReplaySkipNotice(null);
    replayDisplayRef.current = display;
    setReplayDisplay(display);
    playTimelineRef.current = timeline;
    setPlayTimeline(timeline);
    playCursorRef.current = cursor;
    setPlayCursor(cursor);
    setReplayPlayheadAt(target.at);
    let checkpointFrame: PlayFrame | undefined;
    for (let i = cursor; i >= 0; i--) {
      const frame = timeline[i];
      if (frame?.kind === "focus") continue;
      checkpointFrame = frame;
      break;
    }
    if (checkpointFrame) setReplayCursor(checkpointFrame.stepIndex);

    if (target.kind === "file" && target.path) {
      syncReplayPanels(display, target.path, target.panelIndex);
    } else if (target.kind === "focus" && target.focus) {
      if (target.focus.op === "mount" && target.path) {
        syncReplayPanels(display, target.path, target.panelIndex);
      } else {
        syncReplayPanels(display, "", undefined, target.focus.panelIndex);
      }
    } else {
      syncReplayPanels(display);
    }
  }

  /** Activity-bubble clicks seek by wall clock to the last action at the bubble's
   * opening rather than snapping forward to the next save point. */
  function seekReplayToTime(at: number) {
    const timeline = playTimelineRef.current ?? buildKeditTimeline();
    if (!timeline || timeline.length === 0) return;
    seekReplayToAction(Math.max(0, replayFrameIndexAtOrBefore(timeline, at)));
  }

  /** Exit replay. Live files need no restoration because replay never mutates them. */
  function endReplay() {
    replayLoadSequenceRef.current += 1;
    replayRef.current = null;
    replayChainsRef.current = {};
    replayDisplayRef.current = null;
    setReplay(null);
    setReplayDisplay(null);
    setReplayPlayheadAt(undefined);
    setReplayTiming(null);
    setReplaySkipNotice(null);
    setReplayLoading(false);
    setReplayConformance(null);
    setHistoricalActionStatus({});
    setPlaying(false);
    setPlayTimeline(null);
    playTimelineRef.current = null;
    teardownReplayPanels();
  }

  /** Project replay-only files into columns. Folder checkpoints never enter
   *  this function as paths. Recorded focus slots group files into the panels
   *  they historically occupied; files without focus evidence each receive a
   *  fresh column. */
  function syncReplayPanels(
    display: ReplayDisplay,
    activePath = "",
    activeRecordedPanel?: number,
    clearRecordedPanel?: number,
  ) {
    const entries: ReplayPanelPath[] = Object.entries(display.files)
      .filter(([, file]) => !!file.nodeId)
      .map(([path]) => ({
        path,
        panelIndex: display.panelIndexByPath[path],
      }));
    const liveIndices = replayLivePanelIndices(panels, entries.length > 0);
    const livePanels = liveIndices.map((index) => panels[index]);
    let mounted = createReplayPanels(
      entries,
      Math.max(0, MAX_PANELS - livePanels.length),
    ) as PanelState[];

    mounted = mounted.map((panel) => {
      const occupied = panel.replayPanelIndex === undefined
        ? ""
        : display.panels[panel.replayPanelIndex] ?? "";
      const active = panel.tabs.includes(occupied) ? occupied : panel.active;
      return { ...panel, active };
    });
    const targetInMounted = (panel: PanelState) =>
      panel.tabs.includes(activePath) &&
      (activeRecordedPanel === undefined ||
        panel.replayPanelIndex === activeRecordedPanel);
    let targetMountedIndex = activePath
      ? mounted.findIndex(targetInMounted)
      : -1;
    if (targetMountedIndex < 0 && activePath) {
      targetMountedIndex = mounted.findIndex((panel) => panel.tabs.includes(activePath));
    }
    if (targetMountedIndex >= 0) {
      mounted[targetMountedIndex] = {
        ...mounted[targetMountedIndex],
        active: activePath,
      };
    }
    if (clearRecordedPanel !== undefined) {
      const clearAt = mounted.findIndex(
        (panel) => panel.replayPanelIndex === clearRecordedPanel,
      );
      if (clearAt >= 0) mounted[clearAt] = { ...mounted[clearAt], active: "" };
    }

    const signature = JSON.stringify(
      mounted.map((panel) => ({
        tabs: panel.tabs,
        replayPanelIndex: panel.replayPanelIndex,
      })),
    );
    const existingReplay = panels.filter((panel) => panel.replayOwned);
    if (
      signature === replayPanelSignatureRef.current &&
      existingReplay.length === mounted.length
    ) {
      if (targetMountedIndex >= 0) {
        let panelIndex = panels.findIndex(targetInMounted);
        if (panelIndex < 0) {
          panelIndex = panels.findIndex(
            (panel) => panel.replayOwned && panel.tabs.includes(activePath),
          );
        }
        if (panelIndex >= 0) {
          setPanels((prev) =>
            mapPanel(prev, panelIndex, (panel) => ({ ...panel, active: activePath })),
          );
          setActivePanel(panelIndex);
        }
      } else if (clearRecordedPanel !== undefined) {
        const panelIndex = panels.findIndex(
          (panel) =>
            panel.replayOwned && panel.replayPanelIndex === clearRecordedPanel,
        );
        if (panelIndex >= 0) {
          setPanels((prev) =>
            mapPanel(prev, panelIndex, (panel) => ({ ...panel, active: "" })),
          );
        }
      }
      return;
    }

    replayPanelSignatureRef.current = signature;
    const nextPanels: PanelState[] =
      livePanels.length > 0 || mounted.length > 0
        ? [...livePanels, ...mounted]
        : [{ tabs: [], active: "" }];
    const nextStatuses = [
      ...liveIndices.map((index) => summonStatus[index] ?? { state: "idle" as const }),
      ...mounted.map(() => ({ state: "idle" as const })),
    ];
    const nextViews = [
      ...liveIndices.map((index) => panelViews.current[index] ?? null),
      ...mounted.map(() => null),
    ];
    const nextAborts = [
      ...liveIndices.map((index) => summonAbort.current[index] ?? null),
      ...mounted.map(() => null),
    ];
    let nextWeights = [
      ...liveIndices.map((index) => panelWeights[index] ?? 1),
      ...mounted.map(() => 1),
    ];
    if (nextPanels.length === 1) nextWeights = [1];

    const previousLiveActive = liveIndices.indexOf(activePanel);
    const nextActivePanel = targetMountedIndex >= 0
      ? livePanels.length + targetMountedIndex
      : previousLiveActive >= 0
        ? previousLiveActive
        : mounted.length > 0
          ? livePanels.length
          : 0;
    setPanels(nextPanels);
    setSummonStatus(nextStatuses.length > 0 ? nextStatuses : [{ state: "idle" }]);
    panelViews.current = nextViews.length > 0 ? nextViews : [null];
    summonAbort.current = nextAborts.length > 0 ? nextAborts : [null];
    setPanelWeights(nextWeights.length > 0 ? nextWeights : [1]);
    setActivePanel(nextActivePanel);
  }

  /** Remove only the replay surface on explicit close/scope teardown. */
  function teardownReplayPanels() {
    replayPanelSignatureRef.current = "";
    const live = removeReplayPanels(panels, activePanel);
    if (live.keptIndices.length === panels.length) return;

    const hasLivePanels = live.panels.length > 0;
    const nextPanels: PanelState[] = hasLivePanels
      ? live.panels
      : [{ tabs: [], active: "" }];
    const nextStatuses = hasLivePanels
      ? live.keptIndices.map((i) => summonStatus[i] ?? { state: "idle" as const })
      : [{ state: "idle" as const }];
    const nextViews = hasLivePanels
      ? live.keptIndices.map((i) => panelViews.current[i] ?? null)
      : [null];
    const nextAborts = hasLivePanels
      ? live.keptIndices.map((i) => summonAbort.current[i] ?? null)
      : [null];
    let nextWeights = hasLivePanels
      ? live.keptIndices.map((i) => panelWeights[i] ?? 1)
      : [1];
    if (nextPanels.length === 1) nextWeights = [1];

    setPanels(nextPanels);
    setSummonStatus(nextStatuses);
    panelViews.current = nextViews;
    summonAbort.current = nextAborts;
    setPanelWeights(nextWeights);
    setTabModes((m) => pruneTabModes(m, nextPanels));
    setActivePanel(hasLivePanels ? live.activePanel : 0);
  }

  /** Expand the scope-filtered chains into one wall-clock replay. */
  function buildKeditTimeline(): PlayFrame[] | null {
    const r = replayRef.current;
    if (!r) return null;
    return buildReplayTimeline(r.steps, replayChainsRef.current);
  }

  /** Start replay after the selected traces have resolved. Kept as one shared
   *  path so an empty-state Play click can await beginReplay and immediately
   *  continue into playback instead of requiring a second click. */
  function startReplayPlayback(): boolean {
    if (!replayRef.current) return false;
    const existing = playTimelineRef.current;
    if (existing && playCursorRef.current < existing.length - 1 && replayDisplay) {
      setPlaying(true);
      if (onboardingStageRef.current === "awaiting-replay") {
        commitOnboardingStage("replaying");
      }
      return true;
    }
    const tl = buildKeditTimeline();
    if (!tl || tl.length === 0) return false;
    const initialDisplay = emptyReplayDisplay();
    replayDisplayRef.current = initialDisplay;
    setReplayDisplay(initialDisplay);
    syncReplayPanels(initialDisplay);
    const steps = replayRef.current.steps;
    setReplayTiming(
      buildReplayTiming([
        ...tl.map((frame) => frame.at),
        ...steps.map((step) => step.meta.steppedAtMs),
      ], tl.map((frame) => frame.at)),
    );
    const first = tl[0];
    if (first) {
      renderPlayFrame(first);
      setReplayPlayheadAt(first.at);
    }
    playTimelineRef.current = tl;
    setPlayTimeline(tl);
    playCursorRef.current = 0;
    setPlayCursor(0);
    setPlaying(true);
    if (onboardingStageRef.current === "awaiting-replay") {
      commitOnboardingStage("replaying");
    }
    return true;
  }

  /** Pause on the exact rendered edit frame. The replay panel stays mounted. */
  function pauseReplayPlayback() {
    const frame = playTimelineRef.current?.[playCursorRef.current];
    if (frame) setReplayPlayheadAt(frame.at);
    setPlaying(false);
  }

  /** Render one play frame into replay-only state, never the live file store. */
  function renderPlayFrame(frame: PlayFrame) {
    const r = replayRef.current;
    if (!r) return;
    // Focus observations ride on a later structural checkpoint but retain
    // their earlier session timestamp. They animate panel occupancy without
    // pretending to be their own Step or jumping the save-point cursor ahead.
    if (frame.kind !== "focus") setReplayCursor(frame.stepIndex);
    const nextDisplay = replayDisplayWithFrame(
      replayDisplayRef.current ?? emptyReplayDisplay(),
      frame,
    );
    replayDisplayRef.current = nextDisplay;
    setReplayDisplay(nextDisplay);
    if (frame.kind === "file" && frame.path) {
      // Editing is the strongest focus signal: the affected tab is always
      // brought to the front, using the recorded slot when one exists.
      syncReplayPanels(nextDisplay, frame.path, frame.panelIndex);
    } else if (frame.kind === "focus" && frame.focus) {
      if (frame.focus.op === "mount" && frame.path) {
        syncReplayPanels(nextDisplay, frame.path, frame.panelIndex);
      } else {
        // Folder focus and explicit unmounts empty the recorded slot without
        // inventing a synthetic folder tab.
        syncReplayPanels(nextDisplay, "", undefined, frame.focus.panelIndex);
      }
    }
  }

  /** Insert a fresh empty column at index `at` and reconcile all five parallel
   *  per-panel structures in lockstep — the single spawn primitive the
   *  "always open to the side" paths (openToSide, replyLLM) build on. Mirrors
   *  the reconciliation half of moveTabToNewPanel without its source-removal /
   *  collapse half. The caller is responsible for opening a tab into the new
   *  column (openInPanel) and focusing it (setActivePanel). */
  function spawnPanel(at: number) {
    if (panels.length >= MAX_PANELS) return;
    const i = Math.min(at, panels.length);
    setPanels((prev) => spliceAt(prev, i, { tabs: [], active: "" }));
    setSummonStatus((s) => spliceAt(s, i, { state: "idle" }));
    panelViews.current = spliceAt(panelViews.current, i, null);
    summonAbort.current = spliceAt(summonAbort.current, i, null);
    setPanelWeights((w) => spliceAt(w, i, 1));
  }

  /** Move `path` out of `fromPanel` and into a brand-new column inserted
   *  immediately after `afterIdx`. The source removal, the empty-source
   *  collapse, and the column insert compose in one pass so every parallel
   *  structure stays index-aligned. The new column always holds `path`, so the
   *  collapse sweep never removes it. */
  function moveTabToNewPanel(fromPanel: number, path: string, afterIdx: number) {
    if (panels.length >= MAX_PANELS) return;
    const src = panels[fromPanel];
    if (!src || !src.tabs.includes(path)) return;
    // Source after the tab leaves it. If it empties, the panel collapses.
    const srcTabs = src.tabs.filter((t) => t !== path);
    const sourceEmpties = srcTabs.length === 0 && panels.length > 1;
    // Post-collapse panel array: drop the source if it emptied, else keep it
    // with its remaining tabs (focus falls to a neighbor).
    const collapsed = sourceEmpties
      ? removeAt(panels, fromPanel)
      : mapPanel(panels, fromPanel, () => ({
          ...src,
          tabs: srcTabs,
          active: path === src.active ? nextActive(srcTabs, path) : src.active,
        }));
    // Where the new column lands in the post-collapse array. If the empty
    // source sat before the insert point, the collapse shifts it left by one.
    let at = Math.min(afterIdx + 1, collapsed.length + 1);
    if (sourceEmpties && fromPanel < at) at -= 1;
    const nextPanels = spliceAt(collapsed, at, {
      tabs: [path],
      active: path,
    } satisfies PanelState);
    // Reconcile each parallel structure: drop the source slot if it emptied,
    // then splice the new column's default slot at `at`.
    setSummonStatus((s) =>
      spliceAt(sourceEmpties ? removeAt(s, fromPanel) : s, at, { state: "idle" }),
    );
    panelViews.current = spliceAt(
      sourceEmpties ? removeAt(panelViews.current, fromPanel) : panelViews.current,
      at,
      null,
    );
    summonAbort.current = spliceAt(
      sourceEmpties ? removeAt(summonAbort.current, fromPanel) : summonAbort.current,
      at,
      null,
    );
    setPanelWeights((w) => spliceAt(sourceEmpties ? removeAt(w, fromPanel) : w, at, 1));
    setActivePanel(at);
    setPanels(nextPanels);
    // `path` is still open (it just moved), so its mode entry survives — but a
    // moved-to-new-column tab may have been the last copy of some *other* path
    // that collapsed with the source, so prune to be safe.
    setTabModes((m) => pruneTabModes(m, nextPanels));
  }

  /** Commit a freshly-computed `nextPanels` and reconcile the five parallel
   *  per-panel structures to match, then sweep empty panels out of the layout:
   *  any column that lost its last tab collapses, rightmost-first so earlier
   *  indices stay valid as we splice. The last standing panel is always kept.
   *  `activate` is the desired active index before the sweep; it's adjusted if a
   *  collapse removes it or shifts it. This is the single place panel remove +
   *  collapse side-effects happen for closeTab/moveTab. (New-column adds go
   *  through moveTabToNewPanel, which composes insert + collapse itself.) */
  function commitWithCollapse(nextPanels: PanelState[], activate: number) {
    let statuses = summonStatus;
    let views = panelViews.current;
    let aborts = summonAbort.current;
    let weights = panelWeights;
    let active = activate;
    for (let i = nextPanels.length - 1; i >= 0; i--) {
      if (nextPanels.length > 1 && nextPanels[i].tabs.length === 0) {
        nextPanels = removeAt(nextPanels, i);
        statuses = removeAt(statuses, i);
        views = removeAt(views, i);
        aborts = removeAt(aborts, i);
        weights = removeAt(weights, i);
        if (active === i) active = Math.max(0, i - 1);
        else if (active > i) active -= 1;
      }
    }
    // Lone survivor: reset weight so flex-grow < 1 from a prior resize can't
    // leave empty space (Σ(grow) < 1 distributes only that fraction of the row).
    if (nextPanels.length === 1) weights = [1];
    setPanels(nextPanels);
    setSummonStatus(statuses);
    panelViews.current = views;
    summonAbort.current = aborts;
    setPanelWeights(weights);
    // A closed tab may have been the last copy of a path anywhere in the
    // layout; drop its mode entry so reopening it later resets to preview.
    setTabModes((m) => pruneTabModes(m, nextPanels));
    setActivePanel(active);
  }

  // Sample the relay set: fan the filter out to every URL, dedupe by event id,
  // and write each distinct hit to a new file under samples/ — on disk now, via
  // workspace.writeFile, so a sampled document lands as a real file with its
  // own provenance node. The first one is opened as a tab. Requires a folder
  // to be attached (disk is the source of truth; sampling into the void would
  // lose everything on reload).
  async function runSample(target: string | null = samplerTarget) {
    if (!folder) {
      setSamplerStatus({ state: "error", msg: "attach a folder first" });
      return;
    }
    const urls = samplerUrls
      .split("\n")
      .map((u) => u.trim())
      .filter((u) => u.length > 0);
    if (urls.length === 0) {
      setSamplerStatus({ state: "error", msg: "add at least one relay URL" });
      return;
    }
    // Parse the comma-separated kinds list; ignore blanks/non-numbers so a
    // stray comma or space can't poison the filter. Falls back to [] which
    // sampleRelays treats as "any kind".
    const kinds = samplerKinds
      .split(/[\s,]+/)
      .map((s) => Number(s))
      .filter((n) => Number.isFinite(n));
    // datetime-local strings ("YYYY-MM-DDTHH:mm") -> unix seconds. "" = unset.
    const sinceSec = samplerSince ? Math.floor(new Date(samplerSince).getTime() / 1000) : undefined;
    const untilSec = samplerUntil ? Math.floor(new Date(samplerUntil).getTime() / 1000) : undefined;
    const search = samplerSearch.trim() || undefined;
    setSamplerStatus({ state: "sampling" });
    try {
      const { hits, errors } = await sampleRelays(urls, {
        kinds,
        limit: samplerLimit,
        ...(sinceSec !== undefined && { since: sinceSec }),
        ...(untilSec !== undefined && { until: untilSec }),
        ...(search !== undefined && { search }),
      });
      // Rank by citationCount + aggregated alpha (deterministic). With no alpha
      // opinions present this collapses to citationCount-only — today's order.
      const ranked = await rankSampleHits(hits);
      // Uniquify against the current file set + across this batch. `target`
      // scopes sampled files into a subfolder (null/"" = root) — the suggested
      // name is prefixed with the target relpath before uniquification.
      const taken = new Set(Object.keys(files));
      let firstOpened: string | null = null;
      for (const hit of ranked) {
        const { body, suggestedName, eventMeta } = hitToDocument(hit);
        const path = uniquePath(target ? `${target}/${suggestedName}` : suggestedName, taken);
        taken.add(path);
        if (files[path]) continue;
        // Optimistically show the file, then persist to disk + step a node.
        // eventMeta is in-memory only — it drives the editor's metadata strip
        // and is dropped on reload (the persisted file is clean text).
        setFiles((prev) =>
          prev[path]
            ? prev
            : {
                ...prev,
                [path]: {
                  runs: [{ voice: hit.relays[0], text: body }],
                  nodeId: "",
                  tags: [],
                  eventMeta,
                },
              },
        );
        if (firstOpened === null) firstOpened = path;
        try {
          const nodeId = await backendRef.current.writeFile(path, body);
          setFiles((prev) =>
            prev[path] ? { ...prev, [path]: { ...prev[path], nodeId } } : prev,
          );
        } catch (e) {
          console.warn(`[sampler] write failed for ${path}:`, e);
        }
      }
      if (firstOpened) openInActivePanel(firstOpened);
      setSamplerStatus({
        state: "done",
        count: hits.length,
        msg:
          errors.length > 0
            ? `${errors.length} relay(s) failed: ${errors.map((e) => e.url).join(", ")}`
            : undefined,
      });
    } catch (e) {
      setSamplerStatus({
        state: "error",
        msg: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // Resolve every zine matching the typed name (shares samplerUrls as the
  // relay list). Auto-selects when exactly one candidate matched — no
  // ambiguity to show — otherwise surfaces the list for the user to pick
  // (protocol §Tagging vs. bracketing: a folderId isn't a globally unique
  // namespace).
  async function findTagCandidates() {
    const urls = samplerUrls
      .split("\n")
      .map((u) => u.trim())
      .filter((u) => u.length > 0);
    if (urls.length === 0) {
      setTagBrowserStatus({ state: "error", msg: "add at least one relay URL in Sample relays" });
      return;
    }
    setTagBrowserStatus({ state: "resolving" });
    setTagBrowserCandidates(null);
    setTagBrowserSelected(null);
    try {
      const candidates = await resolveTagCandidates(tagBrowserName, urls);
      if (candidates.length === 0) {
        setTagBrowserStatus({ state: "error", msg: "no zine found with that name" });
        return;
      }
      if (candidates.length === 1) {
        setTagBrowserStatus({ state: "idle" });
        void runTagBrowse(candidates[0]);
      } else {
        setTagBrowserCandidates(candidates);
        setTagBrowserStatus({ state: "idle" });
      }
    } catch (e) {
      setTagBrowserStatus({ state: "error", msg: e instanceof Error ? e.message : String(e) });
    }
  }

  // Run the three-channel union against a chosen zine. Ranks + writes results
  // through the same pipeline as runSample (rankSampleHits + samples/) so a
  // tag-browse hit is a real file with provenance, not a second code path.
  async function runTagBrowse(zine: TagCandidate) {
    if (!folder) {
      setTagBrowserStatus({ state: "error", msg: "attach a folder first" });
      return;
    }
    const urls = samplerUrls
      .split("\n")
      .map((u) => u.trim())
      .filter((u) => u.length > 0);
    setTagBrowserSelected(zine);
    setTagBrowserStatus({ state: "browsing" });
    try {
      const { hits, errors } = await browseTag(zine, urls);
      const ranked = await rankSampleHits(hits);
      const taken = new Set(Object.keys(files));
      let firstOpened: string | null = null;
      for (const hit of ranked) {
        const { body, suggestedName, eventMeta } = hitToDocument(hit);
        const path = uniquePath(suggestedName, taken);
        taken.add(path);
        if (files[path]) continue;
        setFiles((prev) =>
          prev[path]
            ? prev
            : {
                ...prev,
                [path]: {
                  runs: [{ voice: hit.relays[0], text: body }],
                  nodeId: "",
                  tags: [],
                  eventMeta,
                },
              },
        );
        if (firstOpened === null) firstOpened = path;
        try {
          const nodeId = await backendRef.current.writeFile(path, body);
          setFiles((prev) => (prev[path] ? { ...prev, [path]: { ...prev[path], nodeId } } : prev));
        } catch (e) {
          console.warn(`[tag-browser] write failed for ${path}:`, e);
        }
      }
      if (firstOpened) openInActivePanel(firstOpened);
      setTagBrowserStatus({
        state: "done",
        count: hits.length,
        msg:
          errors.length > 0
            ? `${errors.length} relay(s) failed: ${errors.map((e) => e.url).join(", ")}`
            : undefined,
      });
    } catch (e) {
      setTagBrowserStatus({ state: "error", msg: e instanceof Error ? e.message : String(e) });
    }
  }

  // Close `path` in panel `idx`. If it was the active tab, move focus to the
  // neighboring tab (right preferred, else left). If this empties a panel (and
  // others remain), that panel collapses out of the layout.
  function closeTab(idx: number, path: string) {
    if (isCoinComposerTab(path) && directCoinBusy) return;
    if (panels[idx]?.replayOwned) {
      setPlaying(false);
      setPlayTimeline(null);
      playTimelineRef.current = null;
      replayDisplayRef.current = null;
      setReplayDisplay(null);
      setReplaySkipNotice(null);
      teardownReplayPanels();
      return;
    }
    const next = mapPanel(panels, idx, (p) => {
      const i = p.tabs.indexOf(path);
      if (i === -1) return p;
      const tabs = p.tabs.filter((t) => t !== path);
      const active = path === p.active ? nextActive(tabs, path) : p.active;
      return { ...p, tabs, active };
    });
    if (next === panels) return;
    commitWithCollapse(next, activePanel);
  }

  // Close every tab in panel `idx` except `keep` (right-click → Close Others).
  // `keep` becomes active so the panel doesn't lose focus to a neighbor that's
  // about to disappear. An empty-after panel collapses like closeTab.
  function closeOthers(idx: number, keep: string) {
    const panel = panels[idx];
    if (!panel || !panel.tabs.includes(keep)) return;
    if (
      directCoinBusy &&
      keep !== DIRECT_COIN_COMPOSER_TAB &&
      panel.tabs.includes(DIRECT_COIN_COMPOSER_TAB)
    ) return;
    const next = mapPanel(panels, idx, (p) => ({ ...p, tabs: [keep], active: keep }));
    if (next === panels) return;
    commitWithCollapse(next, activePanel);
  }

  // Close every tab to the right of `path` in panel `idx` (right-click → Close
  // to the Right). `path` stays open and, if a rightward tab was active, becomes
  // the new active tab so focus lands on the kept divider rather than nowhere.
  function closeToRight(idx: number, path: string) {
    const panel = panels[idx];
    if (!panel) return;
    const i = panel.tabs.indexOf(path);
    if (i === -1) return;
    if (
      directCoinBusy &&
      panel.tabs.slice(i + 1).includes(DIRECT_COIN_COMPOSER_TAB)
    ) return;
    const tabs = panel.tabs.slice(0, i + 1);
    if (tabs.length === panel.tabs.length) return; // nothing to the right
    const active = panel.tabs.slice(i + 1).includes(panel.active) ? path : panel.active;
    const next = mapPanel(panels, idx, (p) => ({ ...p, tabs, active }));
    commitWithCollapse(next, activePanel);
  }

  // Close every tab in panel `idx` (right-click → Close All). If other panels
  // remain, this column collapses; otherwise it's left as an empty single panel
  // (commitWithCollapse always keeps the last panel standing).
  function closeAllInPanel(idx: number) {
    if (directCoinBusy && panels[idx]?.tabs.includes(DIRECT_COIN_COMPOSER_TAB)) return;
    const next = mapPanel(panels, idx, (p) => ({ ...p, tabs: [], active: "" }));
    if (next === panels) return;
    commitWithCollapse(next, activePanel);
  }

  /** Discard a file's unstepped buffer and revert to what's on disk. Desktop-only
   *  conceptually (the webapp writes through): re-reads
   *  the disk file, rebuilds a clean single-run FileState, seeds it as the last-
   *  stepped baseline (so the unstepped count clears), and drops the crash-pad entry.
   *  A file that exists only in the pad (never Stepped, not on disk) reverts to
   *  empty. Best-effort: a read failure logs and leaves the buffer as-is. */
  async function discardBuffer(path: string) {
    if (!folder) return;
    try {
      const content = await backendRef.current.readFile(path).catch(() => "");
      const runs = reconcileRunsText(files[path]?.runs ?? [], content, authorVoice());
      const rebuilt: FileState = {
        runs,
        nodeId: files[path]?.nodeId ?? "",
        tags: [],
      };
      setFiles((prev) => ({ ...prev, [path]: { ...prev[path], ...rebuilt } }));
      seedSteppedRef.current({ [path]: rebuilt });
      clearPadPath(folder.id, path);
    } catch (e) {
      console.warn(`[discard] failed to revert ${path}:`, e);
    }
  }

  // Right-click on a tab opens the tab context menu at the cursor. Mirrors the
  // sidebar's openContextMenu: preventDefault to suppress the browser menu,
  // stopPropagation so it doesn't also bubble into panel focus handlers.
  function openTabContextMenu(e: React.MouseEvent, panel: number, path: string) {
    e.preventDefault();
    e.stopPropagation();
    setTabCtxMenu({ x: e.clientX, y: e.clientY, panel, path });
  }

  // Move/drop the tab `path` (currently in `fromPanel`) so it lands at `toIndex`
  // in `toPanel`. `toPanel === fromPanel` is a plain reorder; across panels the
  // tab leaves its origin (and focus there falls to a neighbor). The dropped
  // tab becomes active in its new home (matches "I just grabbed this tab").
  // Duplicate tabs in the destination are removed in favor of the move. A no-op
  // drop (same panel & slot) leaves state untouched. If the source ends up
  // empty and other panels remain, it collapses.
  function moveTab(
    fromPanel: number,
    path: string,
    toPanel: number,
    toIndex: number,
  ) {
    const src = panels[fromPanel];
    const dst = panels[toPanel];
    if (!src || !dst || !src.tabs.includes(path)) return;

    const cleanedDst = dst.tabs.filter((t) => t !== path);
    const clamped = Math.max(0, Math.min(toIndex, cleanedDst.length));
    const newDstTabs = [...cleanedDst.slice(0, clamped), path, ...cleanedDst.slice(clamped)];

    // No-op: same panel and the tab would land exactly where it already is.
    if (
      fromPanel === toPanel &&
      src.tabs.length === newDstTabs.length &&
      src.tabs.join("\u0000") === newDstTabs.join("\u0000")
    ) {
      return;
    }

    const next = [...panels];
    if (fromPanel === toPanel) {
      next[toPanel] = { ...src, tabs: newDstTabs, active: path };
    } else {
      const srcTabs = src.tabs.filter((t) => t !== path);
      next[fromPanel] = {
        ...src,
        tabs: srcTabs,
        active: path === src.active ? nextActive(srcTabs, path) : src.active,
      };
      next[toPanel] = { ...dst, tabs: newDstTabs, active: path };
    }
    commitWithCollapse(next, toPanel);
  }

  function toggleFolder(path: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  function readDesktopCurrentTarget(
    captured: DesktopOperationEnvelopeV1["prepared"]["targetRevision"],
  ) {
    const liveFolder = folderRef.current;
    const liveFile = filesRef.current[captured.path];
    if (!liveFolder || !liveFile || liveFile.kind === "folder") return null;
    const focus = uiFocusRef.current;
    const panel = focus ? panelsRef.current[focus.panelIndex] : undefined;
    return {
      folderId: liveFolder.id,
      path: captured.path,
      traceId: liveFile.traceId ?? "",
      headId: liveFile.nodeId,
      contentHash: contentFingerprint(flatten(liveFile.runs)),
      focused: Boolean(
        focus?.kind === "file"
        && focus.path === captured.path
        && panel?.active === captured.path
        && !panel.replayOwned
      ),
    };
  }

  function desktopTargetView(path: string): EditorView | null {
    const focus = uiFocusRef.current;
    if (focus?.kind !== "file" || focus.path !== path) return null;
    const panel = panelsRef.current[focus.panelIndex];
    if (!panel || panel.active !== path || panel.replayOwned) return null;
    return panelViews.current[focus.panelIndex] ?? null;
  }

  async function restoreAppliedDesktopPad(
    path: string,
    intentId: string,
    modelVoicePubkey: string,
  ): Promise<boolean> {
    const liveFolder = folderRef.current;
    const padFile = liveFolder ? loadPad(liveFolder.id)?.[path] : undefined;
    if (
      !liveFolder || !padFile || padFile.desktopOperationReceipt?.intentId !== intentId
      || padFile.desktopOperationReceipt.modelVoicePubkey !== modelVoicePubkey
      || !isExactDesktopOperationCrashPadReceipt(padFile)
      || !padFile.runs || !padFile.kedits
    ) {
      return false;
    }
    const current = filesRef.current[path];
    if (!current || current.kind === "folder") return false;
    const restored: FileState = {
      ...current,
      runs: padFile.runs,
      tags: padFile.tags,
      nodeId: padFile.nodeId,
      ...(padFile.traceId ? { traceId: padFile.traceId } : {}),
      ...(padFile.citationIds ? { citationIds: padFile.citationIds } : {}),
      kedits: keditLogFromArray(padFile.kedits),
    };
    filesRef.current = { ...filesRef.current, [path]: restored };
    setFiles((state) => ({ ...state, [path]: restored }));
    const view = desktopTargetView(path);
    if (view) {
      view.dispatch({
        ...(view.state.doc.toString() === padFile.content
          ? {}
          : { changes: { from: 0, to: view.state.doc.length, insert: padFile.content } }),
        effects: [
          setRunsEffect.of(padFile.runs),
          setKEditsEffect.of(keditLogFromArray(padFile.kedits)),
        ],
      });
      const verified = createDesktopOperationCrashPadReceiptV1({
        intentId,
        content: view.state.doc.toString(),
        runs: view.state.field(voiceField),
        kedits: keditLogToArray(view.state.field(keditField)),
        modelVoicePubkey,
      });
      if (
        verified.resultingContentHash !== padFile.desktopOperationReceipt.resultingContentHash
        || verified.resultingRunsSha256 !== padFile.desktopOperationReceipt.resultingRunsSha256
        || verified.resultingKEditsSha256 !== padFile.desktopOperationReceipt.resultingKEditsSha256
      ) return false;
    }
    return true;
  }

  async function applyDesktopArtifact(
    input: DesktopArtifactApplyInputV1,
  ): Promise<
    { status: "applied" | "already-applied"; resultingContentHash: string }
    | { status: "stale" | "deferred" }
  > {
    const target = input.intent.targetRevision;
    const liveFolder = folderRef.current;
    if (!liveFolder || liveFolder.id !== target.folderId) return { status: "deferred" };
    const modelVoicePubkey = input.envelope.prepared.modelVoicePubkey;
    const padFile = loadPad(liveFolder.id)?.[target.path];
    const receipt = padFile?.desktopOperationReceipt;
    if (receipt?.intentId === input.intent.intentId) {
      const expected = prepareDesktopExtendApplyV1(
        input.envelope.selectedContext.manifest.operation.target.currentText,
        input.intent,
        input.responseText,
        input.envelope.prepared.traceAuthoring,
      );
      if (
        receipt.resultingContentHash !== expected.resultingContentHash
        || receipt.modelVoicePubkey !== modelVoicePubkey
        || !padFile || !isExactDesktopOperationCrashPadReceipt(padFile)
        || padFile.traceId !== target.traceId || padFile.nodeId !== target.headId
      ) {
        throw new Error("Accepted Extend receipt does not match the durable response intent");
      }
      if (await restoreAppliedDesktopPad(target.path, receipt.intentId, modelVoicePubkey)) {
        return { status: "already-applied", resultingContentHash: receipt.resultingContentHash };
      }
      throw new Error("Accepted Extend receipt exists without its exact crash-pad buffer");
    }

    // An exact crash-pad receipt above proves the accepted mutation already
    // happened. Only a genuinely new mutation needs live directive authority.
    if (!isDesktopOperationAuthorizedThisSessionV1(
      input.envelope,
      desktopAuthorizedAttemptKeysRef.current,
    )) return { status: "stale" };

    const current = readDesktopCurrentTarget(target);
    if (
      !current?.focused
      || current.folderId !== target.folderId
      || current.path !== target.path
      || current.traceId !== target.traceId
      || current.headId !== target.headId
      || current.contentHash !== target.contentHash
    ) return { status: "stale" };

    const view = desktopTargetView(target.path);
    const file = filesRef.current[target.path];
    if (!view || !file || file.kind === "folder") return { status: "stale" };
    const targetText = view.state.doc.toString();
    if (targetText !== flatten(file.runs)) return { status: "stale" };
    let planned;
    try {
      planned = prepareDesktopExtendApplyV1(
        targetText,
        input.intent,
        input.responseText,
        input.envelope.prepared.traceAuthoring,
      );
    } catch {
      return { status: "stale" };
    }
    const transaction = view.state.update({
      changes: planned.changes,
      effects: opVoiceEffect.of(modelVoicePubkey),
    });
    const nextText = transaction.state.doc.toString();
    const nextRuns = transaction.state.field(voiceField);
    const nextKedits = transaction.state.field(keditField);
    if (
      nextText !== planned.resultingText
      || contentFingerprint(nextText) !== planned.resultingContentHash
      || flatten(nextRuns) !== nextText
    ) {
      throw new Error("Accepted Extend transaction no longer matches its precomputed buffer");
    }
    const desktopOperationReceipt = createDesktopOperationCrashPadReceiptV1({
      intentId: input.intent.intentId,
      content: nextText,
      runs: nextRuns,
      kedits: keditLogToArray(nextKedits),
      modelVoicePubkey,
    });
    const persisted = mirrorPad(target.folderId, target.path, {
      content: nextText,
      tags: file.tags,
      nodeId: file.nodeId,
      traceId: file.traceId,
      runs: nextRuns,
      citationIds: file.citationIds,
      kedits: keditLogToArray(nextKedits),
      voicePubkey: modelVoicePubkey,
      desktopOperationReceipt,
    });
    if (!persisted) {
      throw new Error("Could not durably save the accepted local AI draft");
    }
    // The exact transaction whose text/runs/KEdits were just persisted is the
    // only mutation. Its update listener lifts the same state into React.
    view.dispatch(transaction);
    return { status: "applied", resultingContentHash: planned.resultingContentHash };
  }

  function editFile(path: string, runs: Run[], kedits?: KEditLog) {
    const previous = filesRef.current[path];
    const previousText = previous ? flatten(previous.runs) : "";
    const nextText = flatten(runs);
    const baseLog = previous?.kedits ?? EMPTY_KEDIT_LOG;
    const synthetic = kedits === undefined
      ? synthesizeKEditTransition(
          previousText,
          nextText,
          runs.find((run) => run.text.length > 0)?.voice ?? authorVoice(),
          Date.now(),
          nextKEditTx(baseLog),
        )
      : [];
    const nextLog = kedits ?? appendKEditLog(baseLog, synthetic);
    if (
      onboardingStageRef.current === "awaiting-edit" &&
      previous &&
      previousText !== nextText
    ) {
      commitOnboardingStage("awaiting-step");
    }
    const nextFile: FileState = {
      // Preserve any existing nodeId/tags; for a brand-new path (e.g. Reply)
      // fill the required fields explicitly.
      ...previous,
      runs,
      updatedAt: Date.now(),
      nodeId: previous?.nodeId ?? "",
      tags: previous?.tags ?? [],
      ...(nextLog.length > 0 ? { kedits: nextLog } : {}),
    };
    // Journal the exact content+process transaction before waiting for React's
    // render or the 800ms metadata refresh. A crash after this line can restore
    // both the buffer and the KEdits that produced it.
    filesRef.current = { ...filesRef.current, [path]: nextFile };
    if (folder) {
      mirrorPad(folder.id, path, {
        content: nextText,
        tags: nextFile.tags,
        nodeId: nextFile.nodeId,
        traceId: nextFile.traceId,
        runs,
        citationIds: nextFile.citationIds,
        kedits: keditLogToArray(nextLog),
        voicePubkey: runs.find((run) => run.text.length > 0)?.voice,
      });
    }
    setFiles((prev) => ({ ...prev, [path]: { ...prev[path], ...nextFile } }));
  }

  // Explicit citation edits land in FileState.citationIds — a `q` edge with no
  // body quote. A pure citation
  // change (content unchanged) still
  // steps because unsteppedPaths and each backend's no-op gate include the
  // citation set in their change check.
  // Each id is a sibling file's current head nodeId (resolved from `files`).
  function editCitations(path: string, ids: string[]) {
    const previous = filesRef.current[path];
    if (!previous) return;
    const next: FileState = {
      ...previous,
      updatedAt: Date.now(),
      citationIds: ids.length > 0 ? ids : undefined,
    };
    filesRef.current = { ...filesRef.current, [path]: next };
    if (folder) {
      mirrorPad(folder.id, path, {
        content: flatten(next.runs),
        tags: next.tags,
        nodeId: next.nodeId,
        traceId: next.traceId,
        runs: next.runs,
        citationIds: next.citationIds,
        kedits: keditLogToArray(next.kedits),
      });
    }
    setFiles((prev) => prev[path] ? { ...prev, [path]: { ...prev[path], ...next } } : prev);
  }

  /** Open an ordinary tree item (file or folder) into a fresh column inserted
   *  immediately to the right of the active panel. This is the tree context
   *  menu's "Open to side": a folder is opened as a folder tab, a file as a
   *  normal editor tab. Always spawns a new column (up to the MAX_PANELS safety
   *  cap) so the user can open as many side-by-side panels as the row will fit;
   *  spawnPanel reconciles all parallel per-panel structures. */
  function openToSide(relPath: string) {
    if (isOblivion(relPath)) {
      selectOblivion(relPath);
      return;
    }
    const tab =
      relPath === ROOT || isSystemRootPath(relPath) || folderPaths.has(relPath)
        ? folderTab(relPath)
        : relPath;
    const at = activePanel + 1;
    spawnPanel(at);
    openInPanel(tab, at);
    setActivePanel(at);
  }

  function createStart(kind: "file" | "folder", parent = "") {
    setCreateError(null);
    if (isMint(parent) || isScan(parent) || isOblivion(parent)) return;
    setCreating({ kind, parent });
    // Make sure the parent folder is expanded so the inline phantom row (the
    // name input) is visible while typing. Includes ROOT: the synthetic root
    // can be collapsed, and CreateRow only renders under open folders.
    setCollapsed((prev) => {
      if (!prev.has(parent)) return prev;
      const next = new Set(prev);
      next.delete(parent);
      return next;
    });
  }

  function createCancel() {
    setCreating(null);
    setCreateError(null);
  }

  function createCommit(name: string) {
    const active = creating;
    if (!active) return;
    const kind = active.kind;
    const parent = active.parent;
    const cleanName = name.replace(/^\/+|\/+$/g, "");
    if (!cleanName) {
      setCreating(null);
      setCreateError(null);
      return;
    }
    if (!folder) return;

    // Every FOLDER segment of the path must be a valid tag token, because the
    // folder name becomes the file's first nostr `t` tag and we don't slugify.
    // For a folder, all segments are folders; for a file, all but the last
    // (the basename may contain `.` for the extension). On rejection, keep the
    // input open with an error rather than committing. The parent prefix (when
    // creating inside a right-clicked folder) is already known-good — it came
    // from an existing folder path — so only the typed segments are checked.
    const segments = cleanName.split("/").filter(Boolean);
    const folderSegments =
      kind === "folder" ? segments : segments.slice(0, -1);
    const bad = folderSegments.find((seg) => !isValidTagToken(seg));
    if (bad !== undefined) {
      setCreateError(
        `"${bad}" isn't a valid folder name. Use letters, digits, _ and - only (no spaces).`,
      );
      return; // keep `creating` set so the input stays open
    }

    // Compose the full path: parent prefix (if scoped via context menu) + the
    // typed name. The disk layer (write_text_file / create_folder) already
    // creates intermediate dirs via create_dir_all, so nested paths just work.
    const fullName = parent ? `${parent}/${cleanName}` : cleanName;
    // Mint, Scan, and Oblivion are system-managed. Their contents arrive only
    // through mint, scan, and delete/restore gestures respectively.
    if (
      isMint(parent) ||
      isMint(fullName) ||
      isScan(parent) ||
      isScan(fullName) ||
      isOblivion(parent) ||
      isOblivion(fullName)
    ) {
      setCreateError("Mint, Scan, and Oblivion are managed by their own gestures.");
      return;
    }

    setCreating(null);
    setCreateError(null);

    if (kind === "file") {
      const path = ensureMdExt(fullName);
      if (!files[path]) {
        // Optimistically add an empty file so the editor is immediately
        // usable; the disk write + import node happen via createFile below.
        setFiles((prev) => ({
          ...prev,
          [path]: { runs: [], nodeId: "", tags: [], updatedAt: Date.now() },
        }));
        void (async () => {
          try {
            const nodeId = await backendRef.current.createFile(path);
            setFiles((prev) =>
              prev[path]
                ? { ...prev, [path]: { ...prev[path], nodeId, traceId: nodeId } }
                : prev,
            );
          } catch (e) {
            console.warn(`[workspace] createFile failed for ${path}:`, e);
          }
        })();
      }
      // make sure no stale empty-folder marker lingers at this path
      setEmptyFolders((prev) => {
        if (!prev.has(path)) return prev;
        const next = new Set(prev);
        next.delete(path);
        return next;
      });
      openInActivePanel(path);
    } else {
      setEmptyFolders((prev) => {
        const next = new Set(prev);
        next.add(fullName);
        // ensure the new folder is visible
        setCollapsed((c) => {
          if (!c.has(fullName)) return c;
          const n = new Set(c);
          n.delete(fullName);
          return n;
        });
        return next;
      });
      void (async () => {
        try {
          const nodeId = await backendRef.current.createFolder(fullName);
          setFiles((prev) => ({
            ...prev,
            [fullName]: { kind: "folder", runs: [], nodeId, traceId: nodeId, tags: [] },
          }));
          setEmptyFolders((prev) => {
            if (!prev.has(fullName)) return prev;
            const next = new Set(prev);
            next.delete(fullName);
            return next;
          });
        } catch (e) {
          console.warn(`[workspace] createFolder failed for ${fullName}:`, e);
        }
      })();
    }
  }

  /** Dragging a Coin out of Mint is a copy-by-lineage operation, never a
   *  reparent. Each successful fork gets a fresh editable genesis in the
   *  destination, `forked-from` the immutable Mint node; the original remains
   *  in Mint and every existing citation keeps resolving to it. */
  async function forkMintedNodes(srcs: string[], destFolder: string) {
    if (!folder || isMint(destFolder) || isScan(destFolder) || isOblivion(destFolder)) return;
    const signer = secretKeyForVoice(authorPubkey);
    if (!signer) {
      setOpStatus(activePanel, "error", `no key for voice ${formatPubkey(authorPubkey)}`, "fork");
      return;
    }
    const rootTree: LocalFolderTree = {
      storageRootId: folder.id,
      folderId: folder.id,
      storagePath: ROOT,
    };
    const taken = new Set(Object.keys(files));
    let lastForkPath = "";
    try {
      for (const src of srcs) {
        const source = files[src];
        if (!source?.nodeId || !isMint(src) || src === MINT || !isCompletedCoinFile(source)) {
          continue;
        }
        const forkPath = forkPathForMint(src, destFolder, taken);
        const content = flatten(source.runs);
        const event = await forkFileIntoLocalTree(
          rootTree,
          source.nodeId,
          forkPath,
          signer,
          { localOnly: true },
        );
        const runs: Run[] = content
          ? [{ voice: authorPubkey, text: content, src: source.nodeId }]
          : [];
        saveLocalFile(folder.id, forkPath, {
          content,
          tags: [],
          nodeId: event.id,
          runs,
          voicePubkey: authorPubkey,
        });
        seedSteppedRef.current({
          [forkPath]: { runs, nodeId: event.id, tags: [] },
        });
        setFiles((prev) => ({
          ...withPersistedFolderStates(prev, folder.id),
          [forkPath]: { runs, nodeId: event.id, tags: [] },
        }));
        taken.add(forkPath);
        lastForkPath = forkPath;
      }
      if (lastForkPath) {
        openInActivePanel(lastForkPath);
        setOpStatus(activePanel, "done", "forked coin", "fork");
      }
    } catch (error) {
      console.warn("[mint] fork-on-drop failed:", error);
      setOpStatus(activePanel, "error", error instanceof Error ? error.message : String(error), "fork");
    }
  }

  /** Adopt selected Scan entries into Root by forking their exact imported
   *  nuclei under the active AUTHOR. The private substrate-signed originals
   *  remain in Scan; folder selections preserve their wrapper and subtree. */
  async function adoptScannedNodes(srcs: string[], destFolder: string) {
    if (
      !folder ||
      isMint(destFolder) ||
      isScan(destFolder) ||
      isOblivion(destFolder)
    ) return;
    const signer = secretKeyForVoice(authorPubkey);
    if (!signer) {
      setOpStatus(activePanel, "error", `no key for voice ${formatPubkey(authorPubkey)}`, "fork");
      return;
    }
    const sourceRootId = folder.id;
    const rootTree: LocalFolderTree = {
      storageRootId: sourceRootId,
      folderId: sourceRootId,
      storagePath: ROOT,
    };
    const topSources = srcs.filter(
      (path) =>
        isScan(path) &&
        path !== SCAN &&
        !srcs.some((other) => other !== path && isDescendantOrSelf(other, path)),
    );
    let lastForkPath = "";
    try {
      for (const src of topSources) {
        const descendants = Object.entries(filesRef.current)
          .filter(([path, file]) =>
            file.kind !== "folder" &&
            (path === src || path.startsWith(`${src}/`)),
          )
          .sort(([a], [b]) => a.localeCompare(b));
        if (descendants.length === 0) continue;
        const sourceIsFolder = descendants.some(([path]) => path !== src);
        const destinationRoot = destFolder === ROOT
          ? basename(src)
          : `${destFolder}/${basename(src)}`;
        const destinationOccupied = [
          ...Object.keys(filesRef.current),
          ...emptyFolders,
        ].some((path) =>
          path === destinationRoot || path.startsWith(`${destinationRoot}/`),
        );
        if (destinationOccupied) continue;

        for (const [sourcePath, source] of descendants) {
          if (!source.nodeId) continue;
          const destPath = sourceIsFolder
            ? destinationRoot + sourcePath.slice(src.length)
            : destinationRoot;
          const content = flatten(source.runs);
          const event = await forkFileIntoLocalTree(
            rootTree,
            source.nodeId,
            destPath,
            signer,
            { localOnly: true },
          );
          const runs: Run[] = content
            ? [{ voice: authorPubkey, text: content, src: source.nodeId }]
            : [];
          saveLocalFile(sourceRootId, destPath, {
            content,
            tags: [],
            nodeId: event.id,
            runs,
            voicePubkey: authorPubkey,
          });
          seedSteppedRef.current({
            [destPath]: { runs, nodeId: event.id, tags: [] },
          });
          setFiles((prev) => ({
            ...withPersistedFolderStates(prev, sourceRootId),
            [destPath]: { runs, nodeId: event.id, tags: [] },
          }));
          lastForkPath = destPath;
        }
      }
      if (lastForkPath) {
        openInActivePanel(lastForkPath);
        setOpStatus(activePanel, "done", "adopted scan", "fork");
      }
    } catch (error) {
      console.warn("[scan] adopt-on-drop failed:", error);
      setOpStatus(
        activePanel,
        "error",
        error instanceof Error ? error.message : String(error),
        "fork",
      );
    }
  }

  function reconcileFailedPathMutation(
    operationFolderId: string,
    sourcePath: string,
    destinationPath: string | null,
    isFolderMutation: boolean,
    error: unknown,
    deleteRollback?: {
      tabs: Array<{ panelIndex: number; tab: string; wasActive: boolean }>;
      tabModes: Record<string, Mode>;
      emptyFolders: string[];
      collapsed: string[];
      shielded: string[];
      selection: TraceRef[];
      focus: UiFocus | null;
    },
    shieldRollback?: ShieldedPathChange,
  ): void {
    if (folderIdRef.current !== operationFolderId) return;
    const persisted = loadLocalFolder(operationFolderId);
    const durableFiles = persisted ? localToFiles(persisted) : {};
    const roots = destinationPath ? [sourcePath, destinationPath] : [sourcePath];
    const inAffectedSubtree = (path: string) => roots.some(
      (root) => path === root || path.startsWith(`${root}/`),
    );
    setFiles((current) => {
      const next = Object.fromEntries(
        Object.entries(current).filter(([path]) => !inAffectedSubtree(path)),
      );
      for (const [path, file] of Object.entries(durableFiles)) {
        if (inAffectedSubtree(path)) next[path] = file;
      }
      return next;
    });

    const durableHasSource = Object.keys(durableFiles).some(
      (path) => path === sourcePath || (isFolderMutation && path.startsWith(`${sourcePath}/`)),
    );
    const durableHasDestination = destinationPath !== null && Object.keys(durableFiles).some(
      (path) => path === destinationPath ||
        (isFolderMutation && path.startsWith(`${destinationPath}/`)),
    );
    if (destinationPath && durableHasSource && !durableHasDestination) {
      const reverse = (path: string): string => {
        if (path === destinationPath) return sourcePath;
        if (isFolderMutation && path.startsWith(`${destinationPath}/`)) {
          return sourcePath + path.slice(destinationPath.length);
        }
        return path;
      };
      const reverseTab = (path: string): string =>
        isFolderTab(path) ? folderTab(reverse(folderTabPath(path))) : reverse(path);
      setEmptyFolders((current) => new Set([...current].map(reverse)));
      setPanels((current) => current.map((panel) => ({
        tabs: panel.tabs.map(reverseTab),
        active: reverseTab(panel.active),
      })) as [PanelState, PanelState]);
      setTabModes((current) => Object.fromEntries(
        Object.entries(current).map(([path, mode]) => [reverse(path), mode]),
      ));
      setCollapsed((current) => new Set([...current].map(reverse)));
      setScope((current) => current.map((mount) => ({ ...mount, path: reverse(mount.path) })) as ContextMounts);
      if (shieldRollback) {
        commitShieldedForRoot(
          operationFolderId,
          revertShieldedPathChange(shieldedRef.current, shieldRollback),
        );
      }
      chooseDirectorySelection(
        directorySelectionRef.current.map((item) => ({ ...item, path: reverse(item.path) })),
      );
      commitUiFocus(rebaseUiFocus(uiFocusRef.current, reverse, reverseTab));
    }
    if (!destinationPath && deleteRollback && durableHasSource) {
      setPanels((current) => {
        const next = current.map((panel) => ({ ...panel, tabs: [...panel.tabs] }));
        for (const saved of deleteRollback.tabs) {
          if (next.some((panel) => panel.tabs.includes(saved.tab))) continue;
          const panelIndex = Math.min(saved.panelIndex, Math.max(0, next.length - 1));
          const panel = next[panelIndex];
          if (!panel) continue;
          panel.tabs.push(saved.tab);
          if (saved.wasActive && !panel.active) panel.active = saved.tab;
        }
        panelsRef.current = next;
        return next;
      });
      setTabModes((current) => ({ ...deleteRollback.tabModes, ...current }));
      setEmptyFolders((current) => new Set([
        ...current,
        ...deleteRollback.emptyFolders,
      ]));
      setCollapsed((current) => new Set([
        ...current,
        ...deleteRollback.collapsed,
      ]));
      commitShieldedForRoot(
        operationFolderId,
        new Set([...shieldedRef.current, ...deleteRollback.shielded]),
      );
      chooseDirectorySelection([
        ...directorySelectionRef.current,
        ...deleteRollback.selection.filter((saved) =>
          !directorySelectionRef.current.some((current) => current.path === saved.path)
        ),
      ]);
      if (!uiFocusRef.current && deleteRollback.focus) {
        commitUiFocus(deleteRollback.focus);
      }
    }
    setStructuralError(
      `${destinationPath ? "Move" : "Delete"} failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  function retainRetryablePathMutation(
    operationFolderId: string,
    sourcePath: string,
    destinationPath: string | null,
    error: unknown,
  ): boolean {
    if (!hasPendingStructuralPathMutation(
      operationFolderId,
      sourcePath,
      destinationPath,
    )) return false;
    if (folderIdRef.current === operationFolderId) {
      setStructuralError(
        `${destinationPath ? "Move" : "Delete"} pending retry: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    return true;
  }

  function blocksPendingMintSourceMutation(path: string, isFolder: boolean): boolean {
    if (!folder) return false;
    return Boolean(
      pendingCoinMintBlockingSourceMutation(folder.id, path, isFolder) ||
      mintSourceReservations.blocks(folder.id, path, isFolder),
    );
  }

  // Move `src` (file or folder path) into `destFolder` ("" = root). Rewrites
  // every file and empty-folder path under src, plus any open panels and
  // collapsed-folder state, so nothing dangles. Guards against illegal moves
  // a second time (the Sidebar already checks, but this is the trust boundary).
  // The storage move + identity-preserving provenance step happens
  // asynchronously via workspace.movePath.
  // Move one or more sources (files or folders) into `destFolder` ("" = root).
  // A single coherent state pass: a unified rebaser maps every affected path
  // (each source plus, for folder sources, its descendants) to its destination
  // in one walk, so panels/tab-modes/collapsed stay consistent without
  // sequential single-move reads racing the staged updates. Sources that would
  // collide or move into themselves/descendants are filtered out up front, and
  // a path nested beneath another selected source is dropped (the ancestor
  // carries it) so we never move the same subtree twice.
  function moveNodes(srcs: string[], destFolder: string) {
    if (!folder) return;
    const operationFolderId = folder.id;
    if (isMint(destFolder) || isScan(destFolder)) return;
    const mintedSources = srcs.filter((src) => isMint(src) && src !== MINT);
    if (mintedSources.length > 0) void forkMintedNodes(mintedSources, destFolder);
    const scannedSources = srcs.filter((src) => isScan(src) && src !== SCAN);
    if (scannedSources.length > 0) void adoptScannedNodes(scannedSources, destFolder);
    srcs = srcs.filter((src) => !isMint(src) && !isScan(src));
    if (srcs.length === 0) return;
    // The synthetic root (the mounted folder) can never be a move source.
    // The UI never offers it as draggable, but this is the trust boundary.
    if (srcs.some((s) => s === ROOT)) return;
    const fileSet = new Set(Object.keys(files));
    const folderSet = new Set(emptyFolders);

    // Drop any source nested beneath another source, then keep only those that
    // can legally land in destFolder given the pre-move path set. Also guard
    // against two sources colliding at the *destination* (e.g. a/x.md and
    // b/x.md both dropped into root → both would rebase to "x.md"): process in
    // order and skip a source whose destination is already claimed by an
    // earlier source in this batch — canDrop only checks the pre-move set.
    const tops = srcs.filter(
      (p) => !srcs.some((q) => q !== p && isDescendantOrSelf(q, p)),
    );
    const blockedSource = tops.find((src) => {
      const isFolderMove = folderSet.has(src) || hasChild(fileSet, folderSet, src);
      return blocksPendingMintSourceMutation(src, isFolderMove);
    });
    if (blockedSource) {
      setOpStatus(
        activePanel,
        "error",
        `Finish or retry the pending Mint before moving its source ${blockedSource}.`,
        "mint",
      );
      return;
    }
    const movable: string[] = [];
    const takenDest = new Set<string>();
    for (const src of tops) {
      if (!canDrop(src, destFolder, fileSet, folderSet)) continue;
      const dest = destFolder === ROOT ? basename(src) : `${destFolder}/${basename(src)}`;
      if (takenDest.has(dest)) continue;
      takenDest.add(dest);
      movable.push(src);
    }
    if (movable.length === 0) return;

    // Rebase a path under any moving source. A path is affected iff it is a
    // source itself or a descendant of a folder source; the first matching
    // (top-most) source wins. `destFolder` is the same for every source this
    // call, so each source's destination is `${destFolder}/${basename(src)}`.
    const rebaser = (p: string): string => {
      for (const src of movable) {
        const isFolderMove = folderSet.has(src) || hasChild(fileSet, folderSet, src);
        if (p === src || (isFolderMove && p.startsWith(src + "/"))) {
          return rebasePath(p, src, destFolder);
        }
      }
      return p;
    };
    const affected = (p: string) => rebaser(p) !== p;

    /** Rebase a folder-tab sentinel when its underlying folder moves: find the
     *  (unique) moving source that covers the sentinel's inner relpath, and
     *  rebase against that source. File tabs and uncovered folder tabs pass
     *  through unchanged. */
    const tabRebaser = (p: string): string => {
      if (!isFolderTab(p)) return rebaser(p);
      const rel = folderTabPath(p);
      for (const src of movable) {
        const isFolderMove = folderSet.has(src) || hasChild(fileSet, folderSet, src);
        if (rel === src || (isFolderMove && rel.startsWith(src + "/"))) {
          return rebaseFolderTab(p, src, destFolder);
        }
      }
      return p; // no moving source covers this folder tab
    };

    setFiles((prev) => {
      const next: Record<string, FileState> = {};
      for (const [path, state] of Object.entries(prev)) {
        next[affected(path) ? rebaser(path) : path] = state;
      }
      return next;
    });

    setEmptyFolders((prev) => {
      const next = new Set<string>();
      for (const path of prev) next.add(affected(path) ? rebaser(path) : path);
      // Moving the last child out of a folder would empty it — record the source
      // folder so it survives instead of vanishing. Walk up from each moved
      // source's original path and add any ancestor that now has no surviving
      // files or empty-folders beneath it (stopping at the first non-empty
      // ancestor). Don't record a source that is itself moving into destFolder —
      // it's no longer at its old location.
      const postFiles = new Set<string>();
      for (const p of Object.keys(files)) {
        postFiles.add(affected(p) ? rebaser(p) : p);
      }
      const candidates = new Set<string>();
      for (const src of movable) {
        let cur = parentPath(src);
        while (cur !== ROOT) {
          if (hasChild(postFiles, next, cur)) break; // still has content
          if (candidates.has(cur)) break; // already seen
          candidates.add(cur);
          cur = parentPath(cur);
        }
      }
      for (const c of candidates) {
        let deeper = false;
        for (const d of candidates) {
          if (d !== c && d.startsWith(c + "/")) {
            deeper = true;
            break;
          }
        }
        if (!deeper) next.add(c);
      }
      return next;
    });

    // follow open panels: rebase every tab path and each panel's active path.
    // Folder-tab sentinels rebase against the moving source that covers them.
    setPanels((prev) =>
      prev.map((panel) => ({
        tabs: panel.tabs.map(tabRebaser),
        active: tabRebaser(panel.active),
      })) as [PanelState, PanelState],
    );

    // Rebase remembered view modes so a moved file keeps the surface it had.
    // (Folder tabs never write a tabModes entry — guarded at the write site.)
    setTabModes((prev) => {
      const next: Record<string, Mode> = {};
      for (const [p, mode] of Object.entries(prev)) next[rebaser(p)] = mode;
      return next;
    });

    // collapse state follows folders; expand the destination so the move is visible
    setCollapsed((prev) => {
      const next = new Set<string>();
      for (const path of prev) next.add(affected(path) ? rebaser(path) : path);
      if (destFolder !== ROOT) next.delete(destFolder);
      return next;
    });

    // Context, directory operation selection, and semantic focus all follow
    // the same trace identities through a move.
    setScope((prev) => rebaseContextMountAfterMove(prev, movable, destFolder));
    const shieldedBeforeMove = shieldedRef.current;
    const shieldRollbackBySource = new Map<string, ShieldedPathChange>();
    for (const source of movable) {
      const destination = destFolder === ROOT
        ? basename(source)
        : `${destFolder}/${basename(source)}`;
      shieldRollbackBySource.set(
        source,
        shieldedPathChange(
          shieldedBeforeMove,
          rebaseShieldedPath(shieldedBeforeMove, source, destination),
        ),
      );
    }
    projectShieldedForRoot(
      operationFolderId,
      rebaseShieldedAfterMove(shieldedBeforeMove, movable, destFolder),
    );
    chooseDirectorySelection(
      rebaseTraceRefsAfterMove(directorySelectionRef.current, movable, destFolder),
    );
    commitUiFocus(rebaseUiFocus(uiFocusRef.current, rebaser, tabRebaser));

    // Storage + provenance: extend each file's existing trace at the new path
    // and update membership. Carry user tags through so they survive the
    // reparent. Each
    // top-level source is a separate backend move (movePath already rebases a
    // folder's descendants), so they're independent and tolerate partial
    // failures — a failed move reconciles every affected path from the durable
    // store and surfaces the conflict.
    for (const src of movable) {
      const isFolderMove = files[src]?.kind === "folder" ||
        folderSet.has(src) || hasChild(fileSet, folderSet, src);
      const userTagsByPath: Record<string, string[]> = {};
      for (const [p, st] of Object.entries(files)) {
        if (p === src || (isFolderMove && p.startsWith(src + "/"))) {
          userTagsByPath[p] = st.tags;
        }
      }
      void backendRef.current.movePath(src, destFolder, isFolderMove, userTagsByPath)
        .then(() => refreshMountedReplay(operationFolderId))
        .catch((error) => {
          console.warn(`[workspace] movePath failed for ${src}:`, error);
          const destinationPath = destFolder === ROOT
            ? basename(src)
            : `${destFolder}/${basename(src)}`;
          if (retainRetryablePathMutation(
            operationFolderId,
            src,
            destinationPath,
            error,
          )) return;
          reconcileFailedPathMutation(
            operationFolderId,
            src,
            destinationPath,
            isFolderMove,
            error,
            undefined,
            shieldRollbackBySource.get(src),
          );
        });
    }
  }

  /** Step one recursive zine. Dirty descendant file buffers land first under
   * one durable operation id; the selected folder then receives the final
   * explicit landmark and its ancestors receive derived roll-ups. */
  function stepFolderPath(path: string): void {
    if (!folder || replayActiveRef.current) return;
    const operationFolderId = folder.id;
    const pending = pendingFolderStepOperation(folder.id, path);
    const operationId = isTraceOperationId(pending)
      ? pending
      : createTraceOperationId();
    stageFolderStepOperation(folder.id, path, operationId);
    const dirtyDescendants = [...unsteppedPathSetRef.current]
      .filter((candidate) =>
        path === ROOT ? true : candidate.startsWith(`${path}/`),
      )
      .sort((left, right) => left.localeCompare(right));
    void (async () => {
      for (const descendant of dirtyDescendants) {
        if (folderIdRef.current !== operationFolderId) return;
        await stepFile(descendant, undefined, true, false, operationId);
        if (folderIdRef.current !== operationFolderId) return;
      }
      if (
        folderIdRef.current !== operationFolderId ||
        backendRef.current.ref?.id !== operationFolderId
      ) return;
      await backendRef.current.stepFolder(path, undefined, operationId);
      if (folderIdRef.current !== operationFolderId) return;
      clearFolderStepOperation(operationFolderId, path);
      refreshMountedReplay(operationFolderId);
    })().catch((error) => {
      console.warn(`[provenance] folder Step failed for ${path || "Root"}:`, error);
    });
  }

  // Apply the Delete gesture to one or more files/folders. Root items move into
  // Oblivion while Oblivion items are removed permanently, but both outcomes
  // close every corresponding file/folder tab before mutating the tree.
  function deleteNodes(paths: string[]) {
    if (!folder) return;
    // Split by location: deleting something in Root moves it to Oblivion
    // (not a tombstone — it survives reload and can be dragged back out).
    // Deleting something already in Oblivion is a real hard delete (emptying
    // the bin). This keeps the recycle-bin contract: root→oblivion is
    // reversible, oblivion→nothing is permanent.
    const inRoot = paths.filter(
      (path) =>
        !isMint(path) &&
        !isScan(path) &&
        !isOblivion(path) &&
        path !== ROOT &&
        path !== OBLIVION,
    );
    const inOblivion = paths.filter((p) => isOblivion(p));
    const fileSet = new Set(Object.keys(files));
    const folderSet = new Set(emptyFolders);
    const deleteTargets: DeleteTabTarget[] = [...inRoot, ...inOblivion].map((path) => ({
      path,
      isFolder:
        folderSet.has(path) ||
        files[path]?.kind === "folder" ||
        hasChild(fileSet, folderSet, path),
    }));
    const deleteRollback = new Map(inOblivion.map((path) => {
      const target = deleteTargets.find((candidate) => candidate.path === path)!;
      const under = (candidate: string) =>
        candidate === path || (target.isFolder && candidate.startsWith(`${path}/`));
      const tabs = panelsRef.current.flatMap((panel, panelIndex) =>
        panel.tabs.flatMap((tab) => {
          const tabPath = isFolderTab(tab) ? folderTabPath(tab) : tab;
          return under(tabPath)
            ? [{ panelIndex, tab, wasActive: panel.active === tab }]
            : [];
        })
      );
      return [path, {
        tabs,
        tabModes: Object.fromEntries(
          Object.entries(tabModes).filter(([candidate]) => under(candidate)),
        ),
        emptyFolders: [...emptyFolders].filter(under),
        collapsed: [...collapsed].filter(under),
        shielded: [...shieldedRef.current].filter(under),
        selection: directorySelectionRef.current.filter((item) => under(item.path)) as TraceRef[],
        focus: uiFocusRef.current?.path && under(uiFocusRef.current.path)
          ? uiFocusRef.current
          : null,
      }] as const;
    }));
    const blockedSource = deleteTargets.find((target) =>
      blocksPendingMintSourceMutation(target.path, target.isFolder),
    );
    if (blockedSource) {
      setOpStatus(
        activePanel,
        "error",
        `Finish or retry the pending Mint before deleting its source ${blockedSource.path}.`,
        "mint",
      );
      return;
    }
    const nextPanels = closeDeletedTabs(panels, deleteTargets, (tab) =>
      isFolderTab(tab) ? folderTabPath(tab) : tab,
    );
    if (nextPanels !== panels) commitWithCollapse(nextPanels, activePanel);

    if (inRoot.length > 0) {
      // Move each gesture into its own timestamped folder under Oblivion:
      // `oblivion/<YYYY-MM-DD_HHMMSS>/<items>`. Solves name collisions (deleting
      // `draft.md` twice never overwrites the first retained copy) and records when
      // each deletion happened. Second precision means two gestures in the same
      // clock-second could collide on the folder name, so a `-N` suffix bumps
      // until the name is free. The folder is virtual — once every item under
      // it is restored out, buildTree stops rendering it (no files, no explicit
      // empty-folder entry), so emptied timestamps vanish on their own.
      const base = formatLocalSecondStamp(new Date());
      let stamp = base;
      let n = 2;
      const taken = (p: string) =>
        Object.keys(files).some((f) => f.startsWith(p + "/")) || emptyFolders.has(p);
      while (taken(`${OBLIVION}/${stamp}`)) stamp = `${base}-${n++}`;
      moveNodes(inRoot, `${OBLIVION}/${stamp}`);
    }
    if (inOblivion.length > 0) hardDelete(inOblivion, deleteRollback);
  }

  /** Permanent delete: tombstone off disk + relay. Used only for items already
   *  in oblivion (emptying the recycle bin) — root deletions go through
   *  moveNodes(_, OBLIVION) instead. */
  function hardDelete(
    paths: string[],
    rollbackByPath: ReadonlyMap<string, {
      tabs: Array<{ panelIndex: number; tab: string; wasActive: boolean }>;
      tabModes: Record<string, Mode>;
      emptyFolders: string[];
      collapsed: string[];
      shielded: string[];
      selection: TraceRef[];
      focus: UiFocus | null;
    }> = new Map(),
  ) {
    if (!folder) return;
    const operationFolderId = folder.id;
    const fileSet = new Set(Object.keys(files));
    const folderSet = new Set(emptyFolders);
    // Prune to top-level: drop any path nested beneath another deleted path.
    // The synthetic root (the mounted folder) is never deletable — the UI
    // hides Delete from its context menu, but this is the trust boundary.
    const tops = paths
      .filter((p) => p !== ROOT && p !== OBLIVION)
      .filter((p) => !paths.some((q) => q !== p && isDescendantOrSelf(q, p)));
    if (tops.length === 0) return;
    projectShieldedForRoot(
      operationFolderId,
      removeDeletedShieldedPaths(shieldedRef.current, tops),
    );
    const blockedSource = tops.find((path) => {
      const isFolderDelete = folderSet.has(path) || hasChild(fileSet, folderSet, path);
      return blocksPendingMintSourceMutation(path, isFolderDelete);
    });
    if (blockedSource) {
      setOpStatus(
        activePanel,
        "error",
        `Finish or retry the pending Mint before deleting its source ${blockedSource}.`,
        "mint",
      );
      return;
    }
    // A path is removed iff it is a deleted top-level path itself or a
    // descendant of a deleted folder.
    const under = (p: string) =>
      tops.some((t) => {
        if (t === p) return true;
        const isFolderDelete = folderSet.has(t) || hasChild(fileSet, folderSet, t);
        return isFolderDelete && p.startsWith(t + "/");
      });

    setFiles((prev) => {
      const next: Record<string, FileState> = {};
      for (const [p, state] of Object.entries(prev)) {
        if (!under(p)) next[p] = state;
      }
      return next;
    });

    setEmptyFolders((prev) => {
      const next = new Set<string>();
      for (const p of prev) if (!under(p)) next.add(p);
      // A folder whose last child was just deleted should survive as an empty
      // folder rather than vanishing from the tree. For each deleted top, if its
      // immediate parent now has nothing beneath it (no surviving files, no
      // surviving empty-folders) and isn't itself being deleted, record it.
      // Ancestors above the immediate parent don't need recording — buildTree
      // renders them as intermediate folder nodes off the empty-folder entry.
      // Candidates are collected first and filtered against one another so the
      // result is order-independent: e.g. deleting a/b/c.md and a/d.md together
      // yields a/b (empty) and a (non-empty — a/b survives beneath it), so only
      // a/b is added regardless of iteration order.
      const survivingFiles = new Set(Object.keys(files).filter((p) => !under(p)));
      const candidates = new Set<string>();
      for (const top of tops) {
        const parent = parentPath(top);
        if (parent === ROOT || under(parent) || next.has(parent)) continue;
        candidates.add(parent);
      }
      for (const c of candidates) {
        if (hasChild(survivingFiles, next, c)) continue; // has surviving content
        // Skip if another candidate sits beneath this one — that deeper empty
        // folder keeps this one populated, so it mustn't be recorded as empty.
        let deeper = false;
        for (const d of candidates) {
          if (d !== c && d.startsWith(c + "/")) {
            deeper = true;
            break;
          }
        }
        if (!deeper) next.add(c);
      }
      return next;
    });

    // Drop remembered view modes for the deleted path(s).
    setTabModes((prev) => {
      const next: Record<string, Mode> = {};
      for (const [p, mode] of Object.entries(prev)) if (!under(p)) next[p] = mode;
      return next;
    });

    setCollapsed((prev) => {
      const next = new Set<string>();
      for (const p of prev) if (!under(p)) next.add(p);
      return next;
    });

    chooseDirectorySelection(directorySelectionRef.current.filter((item) => !under(item.path)));
    if (uiFocusRef.current?.path && under(uiFocusRef.current.path)) {
      commitUiFocus(null);
    }
    // A scope mount sitting on or beneath a deleted subtree is now dangling.
    // Drop it and fall back to the whole-folder mount, matching the reset on
    // folder switch. Writes already follow the rebased focus, so this is a
    // state-machine fix — without it the scope UI keeps pointing at a path
    // that no longer exists and the next MODEL op silently loses the scope
    // subtree (activePath is still included, but nothing else under scope is).
    if (scopeRef.current.some((mount) => under(mount.path))) {
      setScope(folder ? [{ kind: "folder", path: ROOT }] : []);
    }

    // Disk delete + delete node + manifest tombstone. Each top-level path is an
    // independent backend delete, so partial failures don't block the rest.
    for (const path of tops) {
      const isFolderDelete = folderSet.has(path) || hasChild(fileSet, folderSet, path);
      void backendRef.current.deletePath(path, isFolderDelete)
        .then(() => refreshMountedReplay(operationFolderId))
        .catch((error) => {
          console.warn(`[workspace] deletePath failed for ${path}:`, error);
          if (retainRetryablePathMutation(
            operationFolderId,
            path,
            null,
            error,
          )) return;
          reconcileFailedPathMutation(
            operationFolderId,
            path,
            null,
            isFolderDelete,
            error,
            rollbackByPath.get(path),
          );
        });
    }
  }

  /** Relay revocation is intentionally independent of local deletion. The
   * workspace copy and its Oblivion state are untouched. */
  async function requestTraceRevocation(path: string): Promise<string> {
    if (!folder) throw new Error("No zine is attached.");
    const file = files[path];
    if (!file || file.kind === "folder" || !file.nodeId) {
      throw new Error("This trace has no published Step to revoke.");
    }
    const traceId = file.traceId ?? (await resolveTraceIdentity(file.nodeId));
    if (!traceId) throw new Error("The trace identity could not be verified.");
    const result = await revokeTrace(traceId, "Revoked by the author from zine", {
      exactHeadId: file.nodeId,
    });
    setCitationRefreshEpoch((epoch) => epoch + 1);
    const requested = result.requestedNodeIds.length;
    const skipped = result.skippedNodeIds.length;
    if (skipped === 0) {
      return `Relay revocation requested for all ${requested} Step${requested === 1 ? "" : "s"} signed by the current pen. Your local copy was not deleted.`;
    }
    return `Relay revocation requested for ${requested} of ${result.totalNodeCount} Steps. ${skipped} Step${skipped === 1 ? " was" : "s were"} signed by other voices and cannot be revoked by the current pen. Your local copy was not deleted.`;
  }

  // Rename `path` (a file or folder) to `newName`, staying in the same parent.
  // Structurally a move with a different destination formula: the parent is
  // kept and only the basename (and, for a folder, every descendant prefix) is
  // swapped. The Sidebar already validates the name, but this is the trust
  // boundary so it re-checks. Returns an error string on rejection so the
  // caller can keep the inline input open; returns null on success.
  //
  // ROOT is special: its path is always "" and member paths are relative to
  // it, so a "rename" only updates the mounted folder's display label — no
  // path rewrite, no disk rename, no provenance delta.
  function renameNode(path: string, newName: string): string | null {
    if (!folder) return null;
    const operationFolderId = folder.id;
    if (isMint(path) || isScan(path) || isOblivion(path)) {
      return "Mint, Scan, and Oblivion are read-only.";
    }
    const cleanName = newName.trim();
    if (!cleanName) return "Name cannot be empty.";
    if (cleanName.includes("/"))
      return "Name can't contain a path separator.";
    if (cleanName === "." || cleanName === "..")
      return `"${cleanName}" isn't a valid name.`;

    if (path === ROOT) {
      // Renaming the root only changes its cosmetic display label — the id is
      // permanent, no path/provenance rewrite. Persist it so the rename
      // survives reload, and update `folder` so the header + tree re-render.
      setRootLabel(cleanName);
      setFolder((prev) => (prev ? { ...prev, label: cleanName } : prev));
      return null;
    }

    const oldName = basename(path);
    if (cleanName === oldName) return null; // no-op

    const slash = path.lastIndexOf("/");
    const destPath = slash === -1 ? cleanName : path.slice(0, slash + 1) + cleanName;
    if (destPath !== path) {
      if (files[destPath] || emptyFolders.has(destPath))
        return `A file or folder named "${cleanName}" already exists here.`;
    }

    const fileSet = new Set(Object.keys(files));
    const folderSet = new Set(emptyFolders);
    const isFolderRename = files[path]?.kind === "folder" ||
      folderSet.has(path) || hasChild(fileSet, folderSet, path);
    if (blocksPendingMintSourceMutation(path, isFolderRename)) {
      return "Finish or retry the pending Mint before renaming its source.";
    }
    // Folder names become nostr tags, so the same tag-token rule as createCommit.
    if (isFolderRename && !isValidTagToken(cleanName))
      return `"${cleanName}" isn't a valid folder name. Use letters, digits, _ and - only (no spaces).`;

    const rebaser = (p: string): string => {
      if (p === path) return destPath;
      if (isFolderRename && p.startsWith(path + "/")) return destPath + p.slice(path.length);
      return p;
    };

    setFiles((prev) => {
      const next: Record<string, FileState> = {};
      for (const [p, state] of Object.entries(prev)) next[rebaser(p)] = state;
      return next;
    });

    setEmptyFolders((prev) => {
      const next = new Set<string>();
      for (const p of prev) next.add(rebaser(p));
      return next;
    });

    // follow open panels: rebase every tab path and each panel's active path.
    // Folder-tab sentinels rebase against the renamed path (same formula as the
    // file rebaser, applied to the inner relpath).
    const renameTabRebaser = (p: string): string =>
      isFolderTab(p) ? rebaseFolderTab(p, path, parentPath(destPath)) : rebaser(p);
    setPanels((prev) =>
      prev.map((panel) => ({
        tabs: panel.tabs.map(renameTabRebaser),
        active: renameTabRebaser(panel.active),
      })) as [PanelState, PanelState],
    );

    // Rebase remembered view modes so a renamed file keeps the surface it had.
    setTabModes((prev) => {
      const next: Record<string, Mode> = {};
      for (const [p, mode] of Object.entries(prev)) next[rebaser(p)] = mode;
      return next;
    });

    setCollapsed((prev) => {
      const next = new Set<string>();
      for (const p of prev) next.add(rebaser(p));
      // keep the renamed folder expanded so the change is visible
      if (isFolderRename) next.delete(destPath);
      return next;
    });

    const shieldedBeforeRename = shieldedRef.current;
    const renamedShielded = rebaseShieldedPath(shieldedBeforeRename, path, destPath);
    const renameShieldRollback = shieldedPathChange(shieldedBeforeRename, renamedShielded);
    projectShieldedForRoot(operationFolderId, renamedShielded);

    chooseDirectorySelection(
      directorySelectionRef.current.map((item) => ({ ...item, path: rebaser(item.path) })),
    );
    commitUiFocus(rebaseUiFocus(uiFocusRef.current, rebaser, renameTabRebaser));
    // The context mount follows the renamed path too, mirroring moveNodes.
    // Without this, renaming (or reparenting-under-rename) the scope mount
    // leaves scope pointing at a path that no longer exists. The rebase rule
    // (exact-match rewrite, plus prefix rewrite for folder renames) is the
    // pure helper in scope-model.ts, unit-tested for all four cases.
    setScope((current) =>
      rebaseContextMountAfterRename(current, path, destPath, isFolderRename),
    );

    // Storage rename + an identity-preserving provenance step. Carry each
    // affected file's user tags through, same as moveNodes.
    const userTagsByPath: Record<string, string[]> = {};
    for (const [p, st] of Object.entries(files)) {
      if (p === path || (isFolderRename && p.startsWith(path + "/"))) {
        userTagsByPath[p] = st.tags;
      }
    }
    void backendRef.current.renamePath(path, cleanName, isFolderRename, userTagsByPath)
      .then(() => refreshMountedReplay(operationFolderId))
      .catch((error) => {
        console.warn(`[workspace] renamePath failed for ${path}:`, error);
        if (retainRetryablePathMutation(
          operationFolderId,
          path,
          destPath,
          error,
        )) return;
        reconcileFailedPathMutation(
          operationFolderId,
          path,
          destPath,
          isFolderRename,
          error,
          undefined,
          renameShieldRollback,
        );
      });
    return null;
  }

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      // Cmd/Ctrl+S invokes the palette's AUTHOR primary action. With mintable
      // selected text it mints a new trace and resolves a citation in the source;
      // resolved or structurally mixed selections stay inert. With no selection
      // it saves the active file to disk and force-steps a checkpoint node signed
      // as the active voice — identical to clicking Step. On desktop this is the
      // gesture that writes the real
      // on-disk file; every other unstepped buffer lives in the crash pad until
      // the user Steps it. Cmd+B remains the protection-only bracket gesture.
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        void deliverAsVoice(opTargetPanel(), "step");
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  const filePaths = useMemo(
    () => new Set(Object.entries(files).filter(([, f]) => f.kind !== "folder").map(([p]) => p)),
    [files],
  );
  // Folder-members (kind: "folder" on FileState) are real folders under nesting
  // (spec §3.2), not just synthesized path prefixes — include them so the tree
  // and path-based mutation helpers treat them as folders.
  const folderPaths = useMemo(
    () => new Set([
      ...emptyFolders,
      ...Object.entries(files).filter(([, f]) => f.kind === "folder").map(([p]) => p),
    ]),
    [emptyFolders, files],
  );

  // Directory gold follows semantic focus, not whichever live or projected
  // panel happens to be frontmost.
  const focusedTabPath = focusDirectoryPath(uiFocus);

  // The root's display name — shown as the sidebar header and as the label of
  // the synthetic root node in the tree. The root is pathless, so the label is
  // the only name it has. It defaults to "root" and is user-renameable (the id
  // stays permanent; only this cosmetic label changes via setRootLabel).
  const rootLabel = useMemo(() => {
    if (!folder) return "Collection";
    return folder.label ?? DEFAULT_ROOT_LABEL;
  }, [folder]);

  const replayTargets = useMemo(
    () => {
      const target = focusReplayTarget(uiFocus);
      return target ? [{
        kind: target.kind,
        path: target.path,
        label: target.path === ROOT ? rootLabel : systemPathDisplayName(target.path),
        title: target.path === ROOT ? rootLabel : target.path,
      }] : [];
    },
    [uiFocus, rootLabel],
  );

  const tree = useMemo(() => {
    // Under nesting (spec §3.2), a FileState with kind: "folder" is a real
    // folder-member (a subfolder trace), not a file. Split the entries so the
    // tree renders folder-members as folders and files as files. Path-derived
    // directories remain implicit in the file entries.
    const fileEntries = Object.entries(files)
      .filter(([, f]) => f.kind !== "folder")
      .map(([p, f]) => ({
        path: p,
        type: "file" as const,
        updatedAt: f.updatedAt,
        coinComplete: f.coinComplete,
      }));
    const folderMemberEntries = Object.entries(files)
      .filter(([, f]) => f.kind === "folder")
      .map(([p, f]) => ({
        path: p,
        type: "folder" as const,
        updatedAt: f.updatedAt,
      }));
    const allEntries: TreeEntry[] = [
      ...fileEntries,
      ...folderMemberEntries,
      ...[...emptyFolders].map((p) => ({ path: p, type: "folder" as const })),
    ];
    return buildDirectoryTree(allEntries, rootLabel, directorySort);
  }, [files, emptyFolders, rootLabel, directorySort]);

  const currentReplayFrame = playTimeline?.[playCursor];
  const latestActionOutput = replaySkipNotice ?? (replay
    ? (() => {
        const stepIndex = currentReplayFrame?.stepIndex ?? replay.index;
        return replayActionLabel(
          currentReplayFrame,
          replay.steps[stepIndex],
          Math.max(0, replay.steps.length - 1),
          rootLabel,
          replayTargets[0]?.kind === "folder",
        );
      })()
    : undefined);

  return (
    <div className="app-shell" onContextMenu={openGlobalContextMenu}>
      <div className="body" style={{ "--sidebar-width": `${sidebarWidth}px` } as React.CSSProperties}>
        <NavRail
          activeView={activeView}
          onSelect={selectView}
          expanded={railExpanded}
          onToggleExpanded={() => setRailExpanded((v) => !v)}
          theme={theme}
          onToggleTheme={toggleTheme}
          showOperator={!isTauri() && isStaff()}
        />
        <div className="view-column">
          {activeView !== "editor" && <ViewHeader view={activeView} />}
          {(activeView === "listings" || activeView === "stats" || activeView === "globe") && (
            <SocialQueryBar query={socialQuery} onChange={setSocialQuery} />
          )}
          {activeView === "editor" ? (
          folder && bootState === "ready" ? (
            onboardingStage === "welcome" ? (
              <OnboardingWelcome
                completedLessons={completedOnboardingLessons}
                canScan={isTauri()}
                onStartTrace={beginOnboarding}
                onStartModel={beginModelOnboarding}
                onStartScan={beginScanOnboarding}
                onDismiss={dismissOnboarding}
              />
            ) : (
            <div className={`press-content onboarding-stage-${onboardingStage}`}>
              <div className="press-top">
              <Sidebar
                tree={tree}
                collapsed={collapsed}
                onToggleFolder={toggleFolder}
                focusedTabPath={focusedTabPath}
                selectedItems={directorySelection}
                onSelectionChange={chooseDirectorySelection}
                scopes={scope}
                shielded={shielded}
                onSetMountState={setContextMount}
                onActivateFile={selectFile}
                onActivateCoin={selectCoin}
                onActivateOblivion={selectOblivion}
                onActivateFolder={selectFolder}
                onOpenFolder={openFolder}
                onMintCoin={openDirectCoinComposer}
                coinsEnabled={coinsEnabled}
                onScan={(kind) => void onScan(kind)}
                onReify={(target) => setReifyPrompt({ includeTrace: false, target })}
                onStepFolder={stepFolderPath}
                creating={creating}
                createError={createError}
                onCreateStart={createStart}
                onCreateCommit={createCommit}
                onCreateCancel={createCancel}
                filePaths={filePaths}
                folderPaths={folderPaths}
                onMove={moveNodes}
                onDelete={deleteNodes}
                onRevoke={requestTraceRevocation}
                onRename={renameNode}
                folderId={folder?.id ?? null}
                samplerOpen={samplerOpen}
                onToggleSampler={() => {
                  // The sidebar telescope always targets the attached folder's
                  // root; a folder tab's scoped sample sets a target first.
                  setSamplerTarget(null);
                  setSamplerOpen((v) => !v);
                }}
                sampler={
                  <SamplerPanel
                    urls={samplerUrls}
                    onUrlsChange={setSamplerUrls}
                    kinds={samplerKinds}
                    onKindsChange={setSamplerKinds}
                    limit={samplerLimit}
                    onLimitChange={setSamplerLimit}
                    since={samplerSince}
                    onSinceChange={setSamplerSince}
                    until={samplerUntil}
                    onUntilChange={setSamplerUntil}
                    search={samplerSearch}
                    onSearchChange={setSamplerSearch}
                    status={samplerStatus}
                    onSample={runSample}
                    scope={samplerTarget ?? ""}
                  />
                }
                tagBrowserOpen={tagBrowserOpen}
                onToggleTagBrowser={() => setTagBrowserOpen((v) => !v)}
                tagBrowser={
                  <TagBrowserPanel
                    name={tagBrowserName}
                    onNameChange={setTagBrowserName}
                    candidates={tagBrowserCandidates}
                    selected={tagBrowserSelected}
                    onSelectCandidate={(c) => void runTagBrowse(c)}
                    status={tagBrowserStatus}
                    onFind={findTagCandidates}
                  />
                }
                onOpenToSide={openToSide}
                directorySort={directorySort}
                onDirectorySortChange={setDirectorySort}
                onOpenOnboarding={restartOnboarding}
                onOpenFactoryReset={() => {
                  setResetError(null);
                  setFactoryResetOpen(true);
                }}
              />
              {/* Horizontal resize handle for the press: drag to change the
                  directory sidebar width; double-click resets. */}
              <div
                className="sidebar-resizer"
                role="separator"
                aria-orientation="vertical"
                aria-label="Resize directory sidebar"
                aria-valuenow={sidebarWidth}
                aria-valuemin={SIDEBAR_WIDTH_MIN}
                aria-valuemax={SIDEBAR_WIDTH_MAX}
                title="Drag to resize · double-click to reset"
                onPointerDown={onSidebarResizerPointerDown}
                onPointerMove={onSidebarResizerPointerMove}
                onPointerUp={onSidebarResizerPointerUp}
                onDoubleClick={onSidebarResizerDoubleClick}
              />
              {reifyPrompt && (() => {
                const targets = scopedReifyTargets(reifyPrompt.target);
                const unsteppedCount = replayDisplay && !reifyPrompt.target
                  ? 0
                  : targets.filter((target) => unsteppedPathSet.has(target.path)).length;
                const missingStepCount = targets.filter((target) => !target.nodeId).length;
                const needsStep = unsteppedCount > 0 || missingStepCount > 0;
                const latestLabel = targets.length === 1
                  ? "Reify latest Step"
                  : "Reify latest Steps";
                return (
                  <div className="confirm-overlay" onClick={() => setReifyPrompt(null)}>
                    <div
                      className="confirm-dialog reify-export-dialog"
                      onClick={(event) => event.stopPropagation()}
                      role="dialog"
                      aria-modal="true"
                      aria-labelledby="reify-export-title"
                    >
                      <h2 id="reify-export-title" className="create-modal-title">
                        Reify stepped snapshot
                      </h2>
                      <p className="confirm-message reify-export-message">
                        Writes {targets.length} exact signed {targets.length === 1 ? "nucleus" : "nuclei"} to ordinary files. Provenance is never embedded in their Markdown.
                      </p>
                      {needsStep && (
                        <p className="reify-export-warning">
                          {unsteppedCount > 0
                            ? `${unsteppedCount} ${unsteppedCount === 1 ? "file has" : "files have"} changes outside the latest Step.`
                            : `${missingStepCount} ${missingStepCount === 1 ? "file has" : "files have"} no Step yet.`}
                          {missingStepCount === 0
                            ? " Reify the latest Steps as-is, or Step the current state first."
                            : " Step the current state before Reifying."}
                        </p>
                      )}
                      <label className="reify-trace-option">
                        <input
                          type="checkbox"
                          checked={reifyPrompt.includeTrace}
                          onChange={(event) =>
                            setReifyPrompt({
                              ...reifyPrompt,
                              includeTrace: event.target.checked,
                            })
                          }
                        />
                        <span>
                          Include trace
                          <small>.zine/trace.json + report.md</small>
                        </span>
                      </label>
                      <p className="reify-trace-privacy">
                        The trace can disclose private Steps, prompts, context, timing, and intermediate text.
                      </p>
                      <div className="confirm-actions reify-export-actions">
                        <button
                          type="button"
                          className="confirm-cancel"
                          onClick={() => setReifyPrompt(null)}
                        >
                          Cancel
                        </button>
                        {needsStep && missingStepCount === 0 && (
                          <button
                            type="button"
                            className="confirm-skip"
                            onClick={() => void onReifyOp({
                              stepCurrent: false,
                              includeTrace: reifyPrompt.includeTrace,
                              target: reifyPrompt.target,
                            })}
                          >
                            {latestLabel}
                          </button>
                        )}
                        <button
                          type="button"
                          className="confirm-fork"
                          disabled={targets.length === 0}
                          onClick={() => void onReifyOp({
                            stepCurrent: needsStep,
                            includeTrace: reifyPrompt.includeTrace,
                            target: reifyPrompt.target,
                          })}
                        >
                          {needsStep ? "Step current & Reify" : "Reify"}
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })()}
              {/* Fork-from-snapshot modal: the user tried to edit while viewing
                  a historical replay step. Offer to fork the file trace from
                  that snapshot (spec §3.8), skip to the latest version, or
                  cancel and stay on the snapshot. */}
              {forkPrompt && replay && (() => {
                const step = replay.steps[forkPrompt.stepIndex];
                if (!step) return null;
                const d = new Date(step.meta.steppedAtMs);
                const pad = (n: number) => String(n).padStart(2, "0");
                const when = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
                return (
                  <div className="confirm-overlay" onClick={() => setForkPrompt(null)}>
                    <div className="confirm-dialog" onClick={(e) => e.stopPropagation()}>
                      <p className="confirm-message">
                        You're viewing a snapshot from {when}, not the latest version.
                        Forking from here creates a new trace that diverges from this
                        point — the original is untouched.
                      </p>
                      <div className="confirm-actions">
                        <button type="button" className="confirm-cancel" onClick={() => setForkPrompt(null)}>
                          Cancel
                        </button>
                        <button type="button" className="confirm-skip" onClick={skipToLatest}>
                          Skip to latest
                        </button>
                        <button
                          type="button"
                          className="confirm-fork"
                          onClick={() => void forkFromSnapshot()}
                        >
                          Fork from here
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })()}
              {mergeSession && (
                <MergePanel
                  candidate={mergeSession.candidate}
                  base={mergeSession.base}
                  ours={mergeSession.ours}
                  path={mergeSession.path}
                  busy={mergeBusy}
                  error={mergeError}
                  onCancel={() => setMergeSession(null)}
                  onConfirm={(resolved) => void stepReconciledMerge(resolved)}
                />
              )}
              {mergePreview && (
                <MergePreviewModal
                  candidate={mergePreview.candidate}
                  path={mergePreview.path}
                  before={mergePreview.before}
                  after={mergePreview.after}
                  busy={mergeBusy}
                  error={mergeError}
                  onClose={() => {
                    setMergePreview(null);
                    setMergeError(null);
                  }}
                  onConfirm={() => void stepCleanMerge(mergePreview.candidate, mergePreview.path, mergePreview.after)}
                />
              )}
              {stagedMerges.length > 0 && (
                <div className="reconcile-banner staged-merges-banner" title="A peer edit merged cleanly with local changes and is waiting for review">
                  <span className="staged-merges-icon" aria-hidden="true">⤵</span>
                  <span>
                    {stagedMerges.length === 1
                      ? "1 merge ready"
                      : `${stagedMerges.length} merges ready`}
                  </span>
                  <button
                    type="button"
                    className="staged-merges-review"
                    disabled={stagedMergeBusy}
                    onClick={() => setStagedMergeView(stagedMerges[0])}
                  >
                    Review
                  </button>
                </div>
              )}
              {structuralError && (
                <div className="reconcile-banner structural-error-banner" role="alert">
                  <span>{structuralError}</span>
                  <button
                    type="button"
                    className="staged-merges-review"
                    onClick={() => {
                      if (folder && structuralConflictId) {
                        // Archived terminal conflict: dismiss clears the record.
                        clearStructuralConflict(folder.id, structuralConflictId);
                      } else if (folder) {
                        // Unclassified recovery throw left a journal entry
                        // stuck in pendingStructuralOperations without
                        // archiving it to structuralConflicts. Without a
                        // force-clear, every later Root mutation re-runs
                        // recovery and re-throws, bricking the workspace for
                        // new writes with no other in-app escape. Archive the
                        // oldest stuck entry via failStructuralOperation (NOT
                        // clearStructuralOperation): clearStructuralOperation
                        // rolls shields during->after, which is the SUCCESS
                        // semantic and would move shields to the destination
                        // even though the op never completed — unshielding
                        // content still sitting at the source (a shield leak
                        // / trust-boundary violation). failStructuralOperation
                        // rolls during->before, restoring the original shield
                        // set so source content stays protected. The user
                        // explicitly abandons the op; archiving also leaves an
                        // honest structuralConflicts audit trail.
                        const stuck = pendingStructuralOperations(folder.id)[0];
                        if (stuck) {
                          failStructuralOperation(
                            folder.id,
                            stuck,
                            "abandoned by user: recovery could not classify the failure",
                          );
                        }
                      }
                      setStructuralConflictId(null);
                      setStructuralError(null);
                    }}
                  >
                    Dismiss
                  </button>
                </div>
              )}
              {stagedMergeView && (
                <MergePreviewModal
                  candidate={{
                    headId: stagedMergeView.remoteHeadId,
                    ownerPubkey: stagedMergeView.remoteOwnerPubkey,
                  }}
                  path={stagedMergeView.path}
                  before={stagedMergeView.ours}
                  after={stagedMergeView.merged}
                  busy={stagedMergeBusy}
                  error={stagedMergeError}
                  onClose={() => {
                    setStagedMergeView(null);
                    setStagedMergeError(null);
                  }}
                  onConfirm={() => void stepStagedMerge(stagedMergeView)}
                />
              )}
              <main className="workspace">
                <div
                  className={"workspace-panels" + (draggingTab ? " tab-dragging" : "")}
                >
                  {panels.map((panel, idx) => {
                    const path = panel.active;
                    const citationReadOnly =
                      panel.replayOwned === true ||
                      isMint(path) ||
                      isScan(path) ||
                      isOblivion(path);
                    const replayFile = panel.replayOwned ? replayDisplay?.files[path] : undefined;
                    const panelFile = replayFile
                      ? {
                          ...(files[path] ?? { tags: [], nodeId: replayFile.nodeId }),
                          nodeId: replayFile.nodeId,
                          runs: replayFile.runs,
                        }
                      : files[path];
                    const replayFrozenHere = panel.replayOwned === true && !!replayFile && !!replay;
                    let replayStepText: string | null = null;
                    let replayPrevText: string | null = null;
                    let replayLiveText: string | null = null;
                    if (replayFrozenHere) {
                      replayStepText = flatten(replayFile.runs);
                      replayLiveText = flatten(files[path]?.runs ?? []);
                      const displayedStepIndex = replayStepIndexForPath(
                        replay.steps,
                        replay.index,
                        path,
                      );
                      for (let i = displayedStepIndex - 1; i >= 0; i--) {
                        const prev = replay.steps[i];
                        if (prev.relativePath !== path) continue;
                        replayPrevText = prev.contentUpToHere || null;
                        break;
                      }
                    }
                    return (
                      <Fragment key={idx}>
                        {idx > 0 ? (
                          // Horizontal resize handle between adjacent panels:
                          // drag to rebalance the two neighboring panes; double-
                          // click resets all columns to even. Drawn here so it
                          // sits on the inter-panel border regardless of content.
                          <div
                            className="panel-resizer"
                            role="separator"
                            aria-orientation="vertical"
                            aria-label="Resize editor panels"
                            title="Drag to resize · double-click to reset"
                            onPointerDown={(e) => onPanelResizerPointerDown(e, idx)}
                            onPointerMove={onPanelResizerPointerMove}
                            onPointerUp={onPanelResizerPointerUp}
                            onDoubleClick={onPanelResizerDoubleClick}
                          />
                        ) : null}
                        <div
                          className="panel-cell"
                          style={{ flexGrow: panelWeights[idx] ?? 1 }}
                        >
                          <Panel
                            panelIdx={idx}
                            tabs={panel.tabs}
                            activePath={path}
                            file={panelFile}
                            directCoinComposer={{
                              phrase: directCoinDraft.phrase,
                              enabled: coinsEnabled,
                              busy: directCoinBusy,
                              error: directCoinError,
                              onPhraseChange: editDirectCoinDraft,
                              onMint: () =>
                                void mintDirectCoin(directCoinDraft.phrase, directCoinDraft.kedits),
                              onClose: () => closeTab(idx, DIRECT_COIN_COMPOSER_TAB),
                            }}
                            folderId={folder?.id ?? ""}
                            replayStepText={replayStepText}
                            replayPrevText={replayPrevText}
                            replayLiveText={replayLiveText}
                            replayNodeId={replayFile?.nodeId}
                            replayActionStatus={
                              replayFile?.nodeId
                                ? historicalActionStatus[replayFile.nodeId]
                                : undefined
                            }
                            onReplaySend={
                              replayFile?.nodeId && canSignWithSecrets()
                                ? () => void sendHistoricalNode(replayFile.nodeId)
                                : undefined
                            }
                            onReplayAttest={
                              replayFile?.nodeId && canSignWithSecrets()
                                ? () => setAttestTarget({
                                    path: `${path} · historical ${replayFile.nodeId.slice(0, 8)}…`,
                                    kind: "file",
                                    nodeId: replayFile.nodeId,
                                    plan: sentNodeStatus[replayFile.nodeId] === true
                                      ? "attest-only"
                                      : "send-attest",
                                    historical: true,
                                    panelIndex: idx,
                                  })
                                : undefined
                            }
                            active={activePanel === idx}
                            focused={
                              panel.replayOwned !== true &&
                              uiFocus?.panelIndex === idx &&
                              uiFocus.tabPath === path
                            }
                            collapsed={collapsed}
                            onFocusPanel={() => setActivePanel(idx)}
                            onSelectTab={(p) => {
                              // An explicit click on a projected child exits
                              // replay and focuses that trace in a real tab.
                              if (panel.replayOwned) {
                                chooseDirectorySelection([]);
                                activateLiveTab(p, focusRefForTab(p));
                                return;
                              }
                              setPanels((prev) =>
                                mapPanel(prev, idx, (pp) => ({ ...pp, active: p })),
                              );
                              chooseDirectorySelection([]);
                              // The reconcile overlay is bound to a specific
                              // path. Switching to any other tab (folder, or a
                              // different file) leaves the panel pointing at a
                              // stale file, so dismiss it rather than leave it
                              // blocking the view over unrelated content.
                              if (mergeSession && (isFolderTab(p) || p !== mergeSession.path)) {
                                setMergeSession(null);
                                setMergeError(null);
                              }
                              // Selecting a tab makes it the active trace target.
                              // Folder, Coin, and ordinary file tabs retain their
                              // distinct action-palette semantics.
                              if (isCoinComposerTab(p)) {
                                setEditorSelection(null);
                                commitUiFocus(null);
                              } else if (isFolderTab(p)) {
                                commitUiFocus(locateFocus(
                                  { kind: "folder", path: folderTabPath(p), nodeId: files[folderTabPath(p)]?.nodeId },
                                  idx,
                                  p,
                                ));
                              } else if (isCoinTab(p) && completedCoinPaths.has(p)) {
                                const coin = files[p];
                                setEditorSelection(null);
                                commitUiFocus(locateFocus({
                                  kind: "coin",
                                  path: p,
                                  nodeId: coin?.nodeId,
                                  phrase: coin ? flatten(coin.runs) : "",
                                }, idx, p));
                              } else if (isCoinTab(p)) {
                                setEditorSelection(null);
                                commitUiFocus(null);
                              } else {
                                commitUiFocus(locateFocus(
                                  { kind: "file", path: p, nodeId: files[p]?.nodeId },
                                  idx,
                                  p,
                                ));
                              }
                            }}
                            onCloseTab={(p) => closeTab(idx, p)}
                            onContextMenuTab={(e, p) => openTabContextMenu(e, idx, p)}
                            onEdit={(runs, kedits) => editFile(path, runs, kedits)}
                            onRemoveCitation={(nodeId) => {
                              if (!path || citationReadOnly) return;
                              const cur = files[path]?.citationIds ?? [];
                              editCitations(path, cur.filter((i) => i !== nodeId));
                            }}
                            // Every panel's view is lifted into panelViews (so each
                            // panel's own Summon can target its editor); the active
                            // panel's view additionally feeds activeEditorView so the
                            // palette's insert always targets the focused editor.
                            onView={(v) => {
                              panelViews.current[idx] = v;
                              if (activePanel === idx) activeEditorView.current = v;
                            }}
                            onSelection={(sel) => {
                              // Only the focused panel drives the selection menu,
                              // so a background panel's stale range can't open it.
                              if (activePanel !== idx) return;
                              setEditorSelection(
                                sel ? { panelIdx: idx, from: sel.from, to: sel.to } : null,
                              );
                            }}
                            flash={flashPanel === idx}
                            readOnly={citationReadOnly}
                            // True only for the panel whose active file is the
                            // replay-stepped (frozen historical) one. Drives the
                            // provisional/out-of-date border. (The fork action
                            // itself lives in the AUTHOR row, not on the panel.)
                            replayFrozen={replayFrozenHere && !isFolderTab(path)}
                            replayMounted={panel.replayOwned === true}
                            voice={authorPubkey}
                            // Folder and Coin tabs have no editor mode surface;
                            // pass preview (ignored) and never persist a mode.
                            mode={
                              isFolderTab(path) || isCoinTab(path) || isCoinComposerTab(path)
                                ? "preview"
                                : tabModes[path] ?? "preview"
                            }
                            onSetMode={(m) => {
                              if (isFolderTab(path) || isCoinTab(path) || isCoinComposerTab(path)) return;
                              setTabModes((prev) => ({ ...prev, [path]: m }));
                            }}
                            voiceAttribution={voiceAttribution}
                            selectedNodeId={
                              uiFocus?.kind === "coin"
                                ? uiFocus.nodeId ?? ""
                                : ""
                            }
                            // Folder replay drives a per-panel scroll: only the
                            // panel whose active file is the step's file gets a
                            // target, so a background panel isn't yanked around.
                            scrollTarget={
                              replay &&
                              panel.replayOwned === true &&
                              !isFolderTab(path) &&
                              replay.steps[replay.index]?.relativePath === path
                                ? replay.steps[replay.index]?.changeRange ?? null
                                : null
                            }
                            onSelectSpan={(nodeId, phrase) => {
                              selectSpan(nodeId, phrase);
                            }}
                            onCopySelection={(view, event) =>
                              copySelectionWithCoin(path, view, event)
                            }
                            onPasteSelection={(view, event) =>
                              pasteSelectionWithCoin(view, event)
                            }
                            onReplayEditAttempt={() => {
                              if (
                                replay &&
                                panel.replayOwned === true &&
                                !isFolderTab(path) &&
                                replayStepIndexForPath(replay.steps, replay.index, path) >= 0
                              ) {
                                setForkPrompt({
                                  stepIndex: replayStepIndexForPath(replay.steps, replay.index, path),
                                });
                              }
                            }}
                            citations={isFolderTab(path) ? [] : (citationsByPath[path] ?? [])}
                            taggedChips={isFolderTab(path) ? [] : (taggedChipByPath[path] ?? [])}
                            inbound={
                              isFolderTab(path)
                                ? []
                                : excludeInboundSources(
                                    inboundByPath[path] ?? [],
                                    oblivionInboundSourceIds,
                                  )
                            }
                            inboundFreshness={
                              isFolderTab(path) ? undefined : inboundFreshnessByPath[path]
                            }
                            attestationCount={
                              !isFolderTab(path) && files[path]?.nodeId
                                ? attestationCounts[files[path].nodeId!] ?? 0
                                : undefined
                            }
                            onOpenCitation={(nodeId) => {
                              void openCitedTrace(nodeId);
                            }}
                            traceCandidates={traceCandidates}
                            pickerDisabled={
                              isFolderTab(path) ||
                              !path ||
                              !files[path]?.nodeId ||
                              citationReadOnly
                            }
                            onAddCitation={(nodeId) => {
                              if (!path || citationReadOnly) return;
                              const cur = files[path]?.citationIds ?? [];
                              if (cur.includes(nodeId)) return; // dedupe
                              editCitations(path, [...cur, nodeId]);
                            }}
                            citationDropAccept={(srcPath) => {
                              // Mirror the picker's gate, then reject the
                              // cases that don't apply to a name pick:
                              // self-drop, unstepped source, already cited.
                              if (
                                isFolderTab(path) ||
                                !path ||
                                !files[path]?.nodeId ||
                                citationReadOnly
                              )
                                return false;
                              if (srcPath === path) return false; // can't cite self
                              const src = files[srcPath];
                              if (!src || src.kind === "folder" || !src.nodeId)
                                return false; // only stepped files and Mint coins
                              if (isCoinTab(srcPath) && !isCompletedCoinFile(src)) return false;
                              const cur = files[path]?.citationIds ?? [];
                              if (cur.includes(src.nodeId)) return false; // already cited
                              return true;
                            }}
                            onAddCitationByPath={(srcPath) => {
                              if (!path || citationReadOnly) return;
                              const src = files[srcPath];
                              if (!src || src.kind === "folder" || !src.nodeId) return;
                              if (isCoinTab(srcPath) && !isCompletedCoinFile(src)) return;
                              const cur = files[path]?.citationIds ?? [];
                              if (cur.includes(src.nodeId)) return; // dedupe
                              editCitations(path, [...cur, src.nodeId]);
                            }}
                            citationBodyDropMarkup={(srcPath) => {
                              if (!isCoinTab(srcPath)) return null;
                              const src = files[srcPath];
                              if (!isCompletedCoinFile(src) || !src.nodeId) return null;
                              return resolvedBracketMarkup(flatten(src.runs), src.nodeId) || null;
                            }}
                            mergeCandidates={mergeCandidates}
                            mergeBusy={mergeBusy}
                            mergeSessionOpen={mergeSession !== null}
                            onIncorporateCandidate={(c) => void incorporateCandidate(c)}
                            mergeError={mergeError}
                            unsteppedPathSet={unsteppedPathSet}
                            unsteppedEditCounts={unsteppedEditCounts}
                            tabIsInScope={(tabPath) => {
                              if (isCoinComposerTab(tabPath)) return true;
                              const tracePath = isFolderTab(tabPath)
                                ? folderTabPath(tabPath)
                                : tabPath;
                              return (
                                !isOblivion(tracePath) &&
                                !isMint(tracePath) &&
                                !isScan(tracePath) &&
                                pathInEffectiveScope(scope, shielded, tracePath)
                              );
                            }}
                            completedCoinPaths={completedCoinPaths}
                            draggingTab={draggingTab}
                            dropTargetTab={dropTargetTab}
                            onTabDragStart={(p) => setDraggingTab({ fromPanel: idx, path: p })}
                            onTabDragEnterTarget={(p) => setDropTargetTab({ panel: idx, path: p })}
                            onTabDragLeaveTarget={(p) =>
                              setDropTargetTab((cur) =>
                                cur && cur.panel === idx && cur.path === p ? null : cur,
                              )
                            }
                            // drop before `targetPath` → land at that tab's index in
                            // the destination *after* the source is removed from it
                            // (so a same-panel drag's index accounts for the gap).
                            onDropOnTab={(targetPath) => {
                              const drag = draggingTab;
                              if (drag) {
                                const dstTabs = panels[idx].tabs.filter((t) => t !== drag.path);
                                const toIndex = Math.max(0, dstTabs.indexOf(targetPath));
                                moveTab(drag.fromPanel, drag.path, idx, toIndex);
                              }
                              setDraggingTab(null);
                              setDropTargetTab(null);
                              setDropTargetEdge(null);
                            }}
                            onDropOnListEnd={() => {
                              const drag = draggingTab;
                              if (drag) {
                                const toIndex = panels[idx].tabs.filter((t) => t !== drag.path).length;
                                moveTab(drag.fromPanel, drag.path, idx, toIndex);
                              }
                              setDraggingTab(null);
                              setDropTargetTab(null);
                              setDropTargetEdge(null);
                            }}
                            // Tab-bar right edge → spawn a new column to this
                            // panel's right. Offered whenever a tab drag is in
                            // progress (moveTabToNewPanel still honors the
                            // MAX_PANELS safety cap internally).
                            onDropOnRightEdge={() => {
                              const drag = draggingTab;
                              if (!drag) return;
                              moveTabToNewPanel(drag.fromPanel, drag.path, idx);
                              setDraggingTab(null);
                              setDropTargetTab(null);
                              setDropTargetEdge(null);
                            }}
                            edgeTargetActive={dropTargetEdge?.afterPanel === idx}
                            onEdgeEnter={() => setDropTargetEdge({ afterPanel: idx })}
                            onEdgeLeave={() =>
                              setDropTargetEdge((cur) =>
                                cur && cur.afterPanel === idx ? null : cur,
                              )
                            }
                            onTabDragEnd={() => {
                              setDraggingTab(null);
                              setDropTargetTab(null);
                              setDropTargetEdge(null);
                            }}
                          />
                          {/* Edge drop zone: dragging a tab onto this strip
                              inserts a new column immediately to this panel's
                              right, moving the tab into it. The element is
                              always present; CSS keeps it display:none unless a
                              tab drag is in progress (the .tab-dragging class on
                              .workspace-panels toggles it). moveTabToNewPanel
                              still honors the MAX_PANELS safety cap internally. */}
                          {(
                            <div
                              className={
                                "panel-edge-drop" +
                                (dropTargetEdge?.afterPanel === idx ? " active" : "")
                              }
                              aria-hidden={!draggingTab}
                              onDragEnter={(e) => {
                                if (!draggingTab) return;
                                e.preventDefault();
                                setDropTargetEdge({ afterPanel: idx });
                                // Entering the edge clears any tab-list target so
                                // the two drop intents don't both highlight.
                                setDropTargetTab(null);
                              }}
                              onDragOver={(e) => {
                                if (draggingTab) e.preventDefault();
                              }}
                              onDragLeave={(e) => {
                                if (
                                  dropTargetEdge?.afterPanel === idx &&
                                  !e.currentTarget.contains(e.relatedTarget as Node | null)
                                ) {
                                  setDropTargetEdge(null);
                                }
                              }}
                              onDrop={() => {
                                const drag = draggingTab;
                                if (!drag) return;
                                // Atomically move the tab out of its origin and
                                // into a new column to this panel's right.
                                moveTabToNewPanel(drag.fromPanel, drag.path, idx);
                                setDraggingTab(null);
                                setDropTargetTab(null);
                                setDropTargetEdge(null);
                              }}
                            />
                          )}
                        </div>
                      </Fragment>
                    );
                  })}
                </div>
                {globalCtx &&
                  createPortal(
                    <div
                      ref={globalCtxRef}
                      className="ctx-menu"
                      style={{
                        left: Math.min(globalCtx.x, window.innerWidth - 160),
                        top: Math.min(globalCtx.y, window.innerHeight - 200),
                      }}
                      onContextMenu={(e) => e.preventDefault()}
                    >
                      {globalCtx.items.map((item, i) =>
                        item.kind === "sep" ? (
                          <div key={i} className="ctx-menu-separator" />
                        ) : (
                          <button
                            key={i}
                            type="button"
                            className="ctx-menu-item"
                            disabled={item.disabled}
                            onMouseDown={(e) => {
                              // onMouseDown + preventDefault keeps the clicked
                              // surface's selection from collapsing before the
                              // action reads it (matches the old SelectionMenu).
                              e.preventDefault();
                            }}
                            onClick={() => {
                              setGlobalCtx(null);
                              item.run();
                            }}
                          >
                            {item.label}
                          </button>
                        ),
                      )}
                    </div>,
                    document.body,
                  )}
              </main>
              </div>
              {tabCtxMenu &&
                (() => {
                  const panel = panels[tabCtxMenu.panel];
                  const tabs = panel?.tabs ?? [];
                  const idx = tabs.indexOf(tabCtxMenu.path);
                  // Close is disabled when the tab is already gone (stale menu).
                  // Close Others is disabled when only this tab remains.
                  // Close to the Right is disabled when the clicked tab is the
                  // rightmost. Close All is disabled when the panel has no tabs.
                  const hasRight = idx !== -1 && idx < tabs.length - 1;
                  const others = tabs.length - 1;
                  const left = Math.min(tabCtxMenu.x, window.innerWidth - 160);
                  const top = Math.min(tabCtxMenu.y, window.innerHeight - 180);
                  return createPortal(
                    <div
                      ref={tabCtxMenuRef}
                      className="ctx-menu"
                      style={{ left, top }}
                      onContextMenu={(e) => e.preventDefault()}
                    >
                      <button
                        type="button"
                        className="ctx-menu-item"
                        disabled={idx === -1}
                        onClick={() => {
                          const { panel: pi, path } = tabCtxMenu;
                          setTabCtxMenu(null);
                          closeTab(pi, path);
                        }}
                      >
                        Close
                      </button>
                      <button
                        type="button"
                        className="ctx-menu-item"
                        disabled={others < 1}
                        onClick={() => {
                          const { panel: pi, path } = tabCtxMenu;
                          setTabCtxMenu(null);
                          closeOthers(pi, path);
                        }}
                      >
                        Close Others
                      </button>
                      <button
                        type="button"
                        className="ctx-menu-item"
                        disabled={!hasRight}
                        onClick={() => {
                          const { panel: pi, path } = tabCtxMenu;
                          setTabCtxMenu(null);
                          closeToRight(pi, path);
                        }}
                      >
                        Close to the Right
                      </button>
                      <div className="ctx-menu-separator" aria-hidden="true" />
                      <button
                        type="button"
                        className="ctx-menu-item danger"
                        disabled={tabs.length === 0}
                        onClick={() => {
                          const { panel: pi } = tabCtxMenu;
                          setTabCtxMenu(null);
                          closeAllInPanel(pi);
                        }}
                      >
                        Close All
                      </button>
                      <div className="ctx-menu-separator" aria-hidden="true" />
                      <button
                        type="button"
                        className="ctx-menu-item"
                        disabled={!unsteppedPathSet.has(tabCtxMenu.path)}
                        onClick={() => {
                          const { path } = tabCtxMenu;
                          setTabCtxMenu(null);
                          void discardBuffer(path);
                        }}
                      >
                        Discard
                      </button>
                    </div>,
                    document.body,
                  );
                })()}
              <DesktopExtendReviewStrip
                items={desktopOperationQueue}
                busyKey={desktopOperationBusyKey}
                error={desktopOperationError}
                notice={desktopOperationRecoveryNotice}
                hasPrevious={desktopOperationPreviousCursors.length > 0}
                hasMore={desktopOperationNextCursor !== null}
                loadingMore={desktopOperationLoadingMore}
                onAction={(item, action) => void handleDesktopOperationAction(item, action)}
                onPrevious={() => void loadPreviousDesktopOperationEnvelopes()}
                onMore={() => void loadMoreDesktopOperationEnvelopes()}
              />
              <ActionPalette
                replayTransport={
                  <ReplayTransport
                    targets={replayTargets}
                    index={replay?.index ?? -1}
                    count={replay?.steps.length ?? 0}
                    ready={replay !== null}
                    playing={playing}
                    playSpeed={playSpeed}
                    onBegin={() => {
                      if (replayLoading) return;
                      void beginReplay()
                        .then((ready) => {
                          if (ready) startReplayPlayback();
                        })
                        .catch((e) => console.warn("[replay] begin failed:", e));
                    }}
                    onStep={(n) => {
                      setReplaySkipNotice(null);
                      replayStepTo(n);
                    }}
                    onAction={seekReplayToAction}
                    onSeekAt={seekReplayToTime}
                    onTogglePlay={() => {
                      if (playing) {
                        pauseReplayPlayback();
                      } else {
                        // Resume a paused recording, or restart after it completed.
                        startReplayPlayback();
                      }
                    }}
                    onCycleSpeed={() =>
                      setPlaySpeed((s) => {
                        const i = REPLAY_SPEEDS.indexOf(s as (typeof REPLAY_SPEEDS)[number]);
                        return REPLAY_SPEEDS[(i + 1) % REPLAY_SPEEDS.length];
                      })
                    }
                    stepTimes={
                      replay ? replay.steps.map((s) => s.meta.steppedAtMs) : undefined
                    }
                    actionTimes={playTimeline?.map((frame) => frame.at)}
                    actionIndex={playCursor}
                    timing={replayTiming}
                    playheadAt={replayPlayheadAt}
                    loading={replayLoading}
                    latestActionOutput={latestActionOutput}
                    conformance={replayConformance}
                    derivedCheckpoints={derivedFolderCheckpointDetails(
                      replay?.steps[replay.index],
                    )}
                    containerTitle={
                      replay
                        ? (() => {
                            const step = replay.steps[replay.index];
                            if (!step) return undefined;
                            if (step.membership) {
                              return [
                                step.membership.type,
                                step.membership.path,
                                new Date(step.meta.steppedAtMs).toLocaleString(),
                              ]
                                .filter(Boolean)
                                .join(" · ");
                            }
                            return [
                              step.meta.action ?? "edit",
                              step.relativePath,
                              new Date(step.meta.steppedAtMs).toLocaleString(),
                              stepDescription(step.event).summary ??
                                stepDescription(step.event).prompt,
                            ]
                              .filter(Boolean)
                              .join(" · ");
                          })()
                        : undefined
                    }
                  />
                }
                keys={keys}
                authorKeyId={authorKeyId}
                modelKeyId={modelKeyId}
                onChooseAuthorKey={chooseAuthorKey}
                onChooseModelKey={chooseModelKey}
                providers={providers}
                resolvedModelProviderId={resolvedModelProviderId}
                onSelectProvider={selectVoiceProvider}
                selection={uiFocus}
                runningOp={(() => {
                  const s = summonStatus[opTargetPanel()] ?? { state: "idle" };
                  return s.state === "running" && isRunningPaletteOp(s.op) ? s.op : null;
                })()}
                onOp={(op) => runOp(opTargetPanel(), op)}
                onStop={() => stopOp(opTargetPanel())}
                opStatus={summonStatus[opTargetPanel()] ?? { state: "idle" }}
                onInspect={(operation) => void openInspector(operation)}
                onRouteToModels={() => selectView("models")}
                attestPlan={paletteAttestationPlan()}
                coinsEnabled={coinsEnabled}
                targetInScope={(() => {
                  const p = panels[opTargetPanel()]?.active;
                  return !!p && isInScope(scope, shielded, p);
                })()}
                authorSelectionState={paletteSelectionForAuthor()}
                sendAutoSteps={paletteSendAutoSteps()}
                stepAvailable={paletteStepIsAvailable()}
                onPreserve={preservePaletteSelection}
                substrate={substrate}
                onChooseSubstrate={chooseSubstrate}
                substrateKeyId={substrateKeyId}
                onChooseSubstrateKey={chooseSubstrateKey}
                onScan={(kind) => void onScan(kind)}
                onReifyOp={() => setReifyPrompt({ includeTrace: false })}
                onOpenTrace={() => setTraceLocatorOpen(true)}
                // The AUTHOR row's Fork action is live only when the op-target
                // panel is parked on a replay-frozen historical step — the one
                // way to turn a read-only historical view into an editable trace.
                replayFrozen={(() => {
                  const panel = panels[opTargetPanel()];
                  const p = panel?.active ?? "";
                  return (
                    panel?.replayOwned === true &&
                    !isFolderTab(p) &&
                    replay !== null &&
                    replayStepIndexForPath(replay.steps, replay.index, p) >= 0
                  );
                })()}
                onForkReplay={() => {
                  if (!replay) return;
                  const path = panels[opTargetPanel()]?.active ?? "";
                  if (isFolderTab(path)) return;
                  const stepIndex = replayStepIndexForPath(replay.steps, replay.index, path);
                  if (stepIndex >= 0) setForkPrompt({ stepIndex });
                }}
              />
              {attestTarget && (
                <AttestModal
                  path={attestTarget.path}
                  prerequisite={
                    attestTarget.plan === "append-send-attest"
                      ? "step-and-send"
                      : attestTarget.plan === "send-attest"
                        ? "send"
                        : null
                  }
                  onClose={() => setAttestTarget(null)}
                  onConfirm={(geohash, message) => {
                    const t = attestTarget;
                    setAttestTarget(null);
                    if (t.historical && t.nodeId) {
                      void attestHistoricalNode(t.nodeId, geohash, message);
                    } else {
                      void attestAsVoice(t.path, geohash, message, {
                        kind: t.kind,
                        nodeId: t.nodeId,
                      });
                    }
                  }}
                />
              )}
              {runOpen && (
                <RunModal
                  providers={providers}
                  recipes={automationRecipes}
                  currentWorkspace={folder ? { id: folder.id, ...(folder.label ? { label: folder.label } : {}) } : null}
                  currentScopes={automationScopesFor(scope)}
                  defaultProviderId={
                    getVoiceProvider(modelPubkey) ?? providers[0]?.id ?? null
                  }
                  onClose={() => setRunOpen(false)}
                  onSaveRecipe={saveAgentRecipe}
                  onDeleteRecipe={deleteAgentRecipe}
                  onStart={(goal, providerId, recipeId) => {
                    const recipe = automationRecipes.find((item) => item.id === recipeId);
                    void startAgentRun(goal, providerId, {
                      trigger: "manual",
                      ...(recipe ? {
                        recipeId: recipe.id,
                        recipeLabel: recipe.label,
                        workspaceId: recipe.workspaceId,
                        scopes: recipe.scopes,
                      } : {}),
                    });
                  }}
                />
              )}
              {staleModelResult && createPortal(
                <div className="compose-overlay" onClick={() => setStaleModelResult(null)}>
                  <div
                    className="compose-dialog prompt-inspector-dialog"
                    role="dialog"
                    aria-label="Held AI response"
                    onClick={(event) => event.stopPropagation()}
                  >
                    <div className="run-head">
                      <h2 className="run-title">AI response held</h2>
                      <button
                        type="button"
                        className="attest-close"
                        aria-label="Close"
                        onClick={() => setStaleModelResult(null)}
                      >×</button>
                    </div>
                    <p className="run-blurb">
                      Focus or the source revision changed while the provider was working, so nothing was edited.
                    </p>
                    <pre className="prompt-inspector-pre">{staleModelResult.response || "(No response was sent because the target was already stale.)"}</pre>
                    <div className="run-actions">
                      <button
                        type="button"
                        className="run-save"
                        disabled={!staleModelResult.response}
                        onClick={() => void navigator.clipboard.writeText(staleModelResult.response)}
                      >Copy response</button>
                      <button
                        type="button"
                        className="run-start"
                        onClick={() => {
                          const operation = staleModelResult.operation;
                          setStaleModelResult(null);
                          void openInspector(operation);
                        }}
                      >Inspect to retry</button>
                    </div>
                  </div>
                </div>,
                document.body,
              )}
              {inspectOp && (
                <PromptInspectorModal
                  defaultOp={inspectOp}
                  inputNotes={inspectNotes}
                  contextBlock={inspectContext}
                  activeFileStepped={(() => {
                    const p = panels[opTargetPanel()]?.active;
                    return !!(p && files[p]?.nodeId);
                  })()}
                  voicePrompt={getVoicePrompt(modelPubkey) ?? ""}
                  provider={resolveVoiceProvider(modelPubkey)}
                  lensSelections={opLenses}
                  onLensChange={(operation, lensId) => {
                    chooseOpLens(operation, lensId);
                    inspectLensSelectionsRef.current = {
                      ...inspectLensSelectionsRef.current,
                      [operation]: lensId,
                    };
                    modelOperationControllerRef.current!.invalidate();
                    setApprovedRequestHash(null);
                    setInspectPrepared({});
                    void prepareInspectorSelection(operation, lensId);
                  }}
                  preparedOperations={inspectPrepared}
                  preparingOp={inspectPreparing}
                  preparationError={inspectPreparationError}
                  onOperationChange={(operation) => {
                    inspectRequestedOpRef.current = operation;
                    setInspectOp(operation);
                    void prepareInspectorSelection(operation);
                  }}
                  onDispatch={(prepared) => {
                    modelOperationControllerRef.current!.approve(prepared);
                    setApprovedRequestHash(prepared.preparedRequestHash);
                    if (
                      onboardingStageRef.current === "context-inspect" &&
                      prepared.targetRevision.path === modelLessonResume?.targetPath
                    ) {
                      advanceOnboarding("request-approved");
                    }
                    const staleRetryKey = prepared.operation === "extend"
                      ? desktopReprepareKeyRef.current
                      : null;
                    closeInspector();
                    if (staleRetryKey) {
                      void dispatchFreshDesktopRetry(staleRetryKey, prepared);
                    } else {
                      void runOp(opTargetPanel(), prepared.operation, prepared);
                    }
                  }}
                  estimateTokens={estimateTokens}
                  onClose={closeInspector}
                />
              )}
              {isOnboardingActive(onboardingStage) && (
                <OnboardingGuide
                  stage={onboardingStage}
                  canScan={isTauri()}
                  onDismiss={dismissOnboarding}
                  onOpenLessons={() => {
                    if (replayRef.current) endReplay();
                    commitOnboardingStage("welcome");
                    selectView("editor");
                  }}
                  onScanFile={() => void onScan("file")}
                  lesson={modelLessonResume}
                />
              )}
            </div>
            )
          ) : folder && bootState === "scanning" ? (
            <section className="view-placeholder">
              <span className="press-loading-spinner" aria-hidden="true" />
              <p className="view-placeholder-blurb">
                Opening your workspace…
              </p>
            </section>
          ) : (
            <section className="view-placeholder">
              <span className="press-loading-spinner" aria-hidden="true" />
              <p className="view-placeholder-blurb">
                {bootError ?? "Opening your workspace…"}
              </p>
            </section>
          )
        ) : activeView === "download" ? (
          <ViewErrorBoundary view="download">
            <DownloadView />
          </ViewErrorBoundary>
        ) : activeView === "about" ? (
          <ViewErrorBoundary view="about">
            <AboutView />
          </ViewErrorBoundary>
        ) : activeView === "networking" ? (
          <ViewErrorBoundary view="networking">
            <NetworkingView />
          </ViewErrorBoundary>
        ) : activeView === "vaults" ? (
          <ViewErrorBoundary view="vaults">
            <VaultsView />
          </ViewErrorBoundary>
        ) : activeView === "keys" ? (
          <ViewErrorBoundary view="keys">
            <KeysView onKeysChange={setKeys} />
          </ViewErrorBoundary>
        ) : activeView === "models" ? (
          <ViewErrorBoundary view="models">
            <ModelsView
              onProvidersChange={setProviders}
              modelLessonActive={onboardingStage === "model-setup"}
              onProviderTested={(providerId, providerFingerprint) => {
                if (onboardingStageRef.current === "model-setup") {
                  setModelProbeSession({ providerId, providerFingerprint });
                  selectVoiceProvider(providerId);
                  void completeModelSetup();
                }
              }}
            />
            {modelLessonError ? (
              <p className="sampler-status error" role="alert">{modelLessonError}</p>
            ) : null}
          </ViewErrorBoundary>
        ) : activeView === "globe" ? (
          <ViewErrorBoundary view="globe">
            <GlobeView query={socialQuery} />
          </ViewErrorBoundary>
        ) : activeView === "listings" ? (
          <ViewErrorBoundary view="listings">
            <ListingsView query={socialQuery} />
          </ViewErrorBoundary>
        ) : activeView === "stats" ? (
          <ViewErrorBoundary view="stats">
            <TimesView query={socialQuery} />
          </ViewErrorBoundary>
        ) : activeView === "operator" ? (
          <ViewErrorBoundary view="operator">
            <OperatorView
              state={operatorState}
              onStateChange={setOperatorState}
              onOpenSetup={() => setOperatorSetup("manual")}
            />
          </ViewErrorBoundary>
        ) : (
          <ViewPlaceholder view={activeView} />
        )}
        </div>
      </div>
      <PinPanel />
      {mintConsentRequest && (
        <MintConsentModal
          phrase={mintConsentRequest.phrase}
          onCancel={() => finishMintConsent(false)}
          onConfirm={() => finishMintConsent(true)}
        />
      )}
      {mintRecoveryNotice && (
        <div className="mint-recovery-alert" role="alert">
          <div className="mint-recovery-alert-content">
            <strong>
              {mintRecoveryNotice.pending > 0
                ? `${mintRecoveryNotice.pending} pending Mint ${mintRecoveryNotice.pending === 1 ? "transaction remains" : "transactions remain"} incomplete and may already be public.`
                : "Pending Mint recovery could not start."}
            </strong>
            {!coinsEnabled && mintRecoveryNotice.pending > 0 && (
              <span> Coins are disabled, so recovery is paused.</span>
            )}
            {mintRecoveryNotice.startError && (
              <span className="mint-recovery-error"> {mintRecoveryNotice.startError}</span>
            )}
            {mintRecoveryNotice.failures.length > 0 && (
              <ul>
                {mintRecoveryNotice.failures.map((failure) => (
                  <li key={failure}>{failure}</li>
                ))}
              </ul>
            )}
          </div>
          {coinsEnabled ? (
            <button
              type="button"
              disabled={mintRecoveryBusy}
              onClick={() => {
                setMintRecoveryBusy(true);
                void recoverPendingCoinMints()
                  .catch((error) => {
                    refreshMintRecoveryNotice(
                      [],
                      error instanceof Error ? error.message : String(error),
                    );
                  })
                  .finally(() => setMintRecoveryBusy(false));
              }}
            >
              {mintRecoveryBusy ? "Retrying…" : "Retry"}
            </button>
          ) : (
            <button type="button" onClick={() => setActiveView("networking")}>
              Open Networking
            </button>
          )}
        </div>
      )}
      {oblivionModalPath && files[oblivionModalPath] && (
        <OblivionModal
          name={systemPathDisplayName(oblivionModalPath)}
          path={oblivionModalPath}
          content={flatten(files[oblivionModalPath].runs)}
          nodeId={files[oblivionModalPath].nodeId}
          onClose={() => setOblivionModalPath(null)}
        />
      )}
      {sendFailure && (
        <SendFailureModal
          failure={sendFailure}
          onClose={() => setSendFailure(null)}
          onNavigate={(view: SendFailureView) => {
            setSendFailure(null);
            setActiveView(view);
          }}
        />
      )}
      {factoryResetOpen && (
        <div
          className="confirm-overlay"
          onClick={() => {
            if (!resetBusy) setFactoryResetOpen(false);
          }}
        >
          <div
            className="confirm-dialog factory-reset-dialog"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="factory-reset-title"
            aria-describedby="factory-reset-description"
            aria-busy={resetBusy}
          >
            <h2 id="factory-reset-title" className="create-modal-title factory-reset-title">
              Factory Reset the Local App
            </h2>
            <p id="factory-reset-description" className="confirm-message factory-reset-message">
              Erases all local app state, including the root binding, crash pads, secure key
              vaults, AI credentials, relay config, voices, models, and layouts. On desktop it
              also deletes every event from the local sidecar and resets peer access. The app
              reloads into vault creation; the next vault then mints a new root with an empty oblivion. Events
              already sent to remote relays cannot be erased from those relays. There is no undo.
            </p>
            {resetError && <p className="create-error" role="alert">{resetError}</p>}
            <div className="confirm-actions">
              <button
                type="button"
                className="confirm-cancel"
                disabled={resetBusy}
                onClick={() => setFactoryResetOpen(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="confirm-delete"
                disabled={resetBusy}
                onClick={() => void factoryReset()}
              >
                {resetBusy ? "Erasing…" : "Erase everything"}
              </button>
            </div>
          </div>
        </div>
      )}
      {traceLocatorOpen && (
        <TraceLocatorModal onClose={() => setTraceLocatorOpen(false)} />
      )}
      {operatorSetup !== "off" && (
        <OperatorSetupModal
          mode={operatorSetup}
          onClose={() => setOperatorSetup("off")}
          onBound={(st) => {
            setOperatorState(st);
            setOperatorSetup("off");
          }}
        />
      )}
    </div>
  );
}

export default App;

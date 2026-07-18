import { Component, Fragment, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { CSSProperties, MutableRefObject, ReactNode } from "react";
import { createPortal } from "react-dom";
import { createTraceOperationId, isTraceOperationId } from "@zine/protocol";
import {
  vaultStorage,
  vaultStorage as localStorage,
  vaultStorageGeneration,
} from "../storage/vault-storage.js";
import {
  Compartment,
  EditorState,
  EditorSelection,
  Facet,
  StateEffect,
  StateField,
  type Extension,
  type Range,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  keymap,
  lineNumbers,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdownIndentExtensions } from "../editor/tab-indent.js";
import { RefCountedStepGate } from "../editor/ref-counted-step-gate.js";
import {
  sampleRelays,
  hitToDocument,
  rankSampleHits,
  upsertManifestEntry,
  resolveTagCandidates,
  browseTag,
  fetchChain,
  fetchFolderActivity,
  fetchFolderNodes,
  fetchFolderOwner,
  fetchEventById,
  diffToDeltas,
  completeCoinMint,
  publishEdit,
  publishDirectCoin,
  publishHardenedSpan,
  operationIdFromNode,
  sha256HexLocal,
  sendHistoricalStep,
  sendStep,
  flushRendezvousPublicationOutbox,
  reconstructUpTo,
  reconstructRunsUpTo,
  auditAttribution,
  stepDeltaRange,
  parseAuthors,
  eventMeta,
  resolveNodeName,
  resolveCitationChip,
  bufferFocus,
  focusTimeline,
  getOrCreateRuleTrace,
  setPendingLlmMeta,
  fetchManifest,
  findMergeCandidates,
  incorporateMergeCandidate,
  loadMergeSides,
  mergeFile,
  type TagCandidate,
  type EventMeta,
  type FocusSelection,
  type FocusEntry,
  type CitationChip,
  type MergeCandidate,
  type KEdit,
  type CoinOrigin,
  type LlmStepMeta,
  excludeInboundSources,
  findInboundSnapshot,
  resolveTraceChain,
  resolveTraceIdentity,
  revokeTrace,
  attestNode,
  fetchAttestationCounts,
  isTraceNodeSent,
  type TraceInbound,
} from "../provenance/provenance.js";
import { MergePanel } from "../workspace/MergePanel.js";
import { MergePreviewModal } from "../workspace/MergePreviewModal.js";
import { threeWayMerge, autoMergedText } from "../workspace/three-way-merge.js";
import { AttestModal } from "../provenance/AttestModal.js";
import { CoinView, DirectCoinComposerView, IncompleteMintView } from "../provenance/CoinModal.js";
import {
  coinMintOperationKey,
  completePendingCoinMint as completePendingCoinMintTransaction,
  finalizedCoinMintSourceText,
  pendingCoinMints,
  preparePendingCoinMint,
  resumePendingCoinMints,
  storedCoinMintAttestation,
  type CoinMintSourceFinalization,
  type PendingCoinMint,
} from "../provenance/coin-mint-journal.js";
import { OblivionModal } from "../workspace/OblivionModal.js";
import { RunModal } from "../ai/RunModal.js";
import { PromptInspectorModal } from "../ai/PromptInspectorModal.js";
import { SendFailureModal } from "../networking/SendFailureModal.js";
import { describeSendFailure, type SendFailureView } from "../networking/send-failure.js";
import { runAgentLoop, type AgentCtx } from "../ai/agent-loop.js";
import {
  AUTOMATION_STORAGE_KEY,
  dueAutomationRecipesForWorkspace,
  finishAgentRunManifest,
  loadAutomationRecipes,
  markAutomationRecipeStarted,
  removeAutomationRecipe,
  serializeAgentRunManifest,
  upsertAutomationRecipe,
  withAutomationSchedulerLock,
  type AgentRunManifest,
  type AgentRunTrigger,
  type AutomationRecipeDraft,
  type AutomationScopes,
} from "../ai/automation-store.js";
import { ensureModelVoice } from "../ai/model-voice.js";
import { ownerFolderOf, activeMount } from "../workspace/focus-routing.js";
import {
  focusDirectoryPath,
  focusReplayTarget,
  locateFocus,
  rebaseUiFocus,
  refreshFocusNode,
  sameUiFocus,
  type FocusRef,
  type UiFocus,
} from "../workspace/ui-focus.js";
import { activateTreeItem, type ActivatableTreeItem } from "../workspace/tree-routing.js";
import type { Event } from "nostr-tools";
import { diffLines } from "diff";
import {
  bracketExtensions,
  bracketVoiceResolverFacet,
  doubleBackspaceUnwrapCommand,
  findCommands,
  findMintSelectionTarget,
  findPendingBrackets,
  findResolvedBrackets,
  focusedVoiceFacet,
  iterBrackets,
  modeCompartment,
  modeFacet,
  onSelectSpanFacet,
  resolvedBracketMarkup,
  selectedNodeIdFacet,
  wrapSelectionCommand,
  type Mode,
} from "../provenance/brackets.js";
import { markdownPreviewExtensions } from "../editor/markdown-preview.js";
import {
  classifyPaletteSelection,
  palettePrimaryAction,
  paletteSecondaryActions,
  paletteStatusMessage,
  paletteStatusRow,
  type PaletteStatusRow,
  type PaletteSelectionState,
} from "../editor/palette.js";
import {
  COIN_CLIPBOARD_MIME,
  parseCoinClipboardEnvelope,
  serializeCoinClipboardEnvelope,
} from "../provenance/coin-clipboard.js";
import { DownloadView } from "../networking/Download.js";
import { AboutView } from "./About.js";
import { VaultsView } from "./VaultsView.js";
import { OnboardingGuide, OnboardingWelcome } from "./Onboarding.js";
import {
  completedLessonsForStage,
  isOnboardingActive,
  loadOnboardingResume,
  reconcileModelOnboardingStage,
  reduceOnboardingStage,
  saveOnboardingStage,
  type ModelLessonResume,
  type OnboardingLessonId,
  type OnboardingStage,
} from "./onboarding-state.js";
import { aboutHashTarget } from "./about-documents.js";
import { NetworkingView } from "../networking/Networking.js";
import {
  kademliaEnabledSnapshot,
  subscribeKademliaConfig,
} from "../networking/kademlia.js";
import { ModelsView } from "../ai/ModelsView.js";
import { KeysView } from "../identity/KeysView.js";
import { GlobeView } from "../networking/Globe.js";
import { TimesView } from "../replay/TimesView.js";
import { ListingsView } from "../networking/ListingsView.js";
import { SocialQueryBar } from "../networking/SocialQueryBar.js";
import {
  loadSocialQuery,
  saveSocialQuery,
  type SocialQuery,
} from "../networking/social-query.js";
import { PinPanel } from "../provenance/PinPanel.js";
import { OperatorView } from "../networking/OperatorView.js";
import { TraceLocatorModal } from "../provenance/TraceLocatorModal.js";
import {
  bindOperator,
  isStaff,
  refreshOperatorState,
  getOperatorState,
  type OperatorState,
} from "../networking/operator-store.js";
import {
  identityForPubkey,
  loadKeys,
  authorVoice,
  modelSecretKey,
  secretKeyForVoice,
  subscribeVoiceIdentities,
  voiceSpanStyle,
  type KeyEntry,
} from "../identity/keys-store.js";
import { VoiceLegend } from "../identity/VoiceLegend.js";
import { VoiceChip } from "../identity/VoiceChip.js";
import { formatPubkey, PubkeyDisplay } from "../identity/PubkeyDisplay.js";
import {
  loadWorkspaceLayout,
  saveWorkspaceLayout,
  type WorkspaceLayout,
} from "../workspace/workspace-layout-store.js";
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
import {
  DesktopOperationRuntimeV1,
  type DesktopArtifactApplyInputV1,
  type DesktopOperationKeyV1,
} from "../ai/desktop-operation-runtime.js";
import {
  createNativeDesktopOperationStoreV1,
  type DesktopOperationStoreV1,
} from "../ai/desktop-operation-store.js";
import type { DesktopOperationEnvelopeV1 } from "../ai/desktop-operation-envelope.js";
import {
  desktopOperationReviewQueueV1,
  mergeDesktopOperationPinnedHeadsV1,
  resolveDesktopOperationPageLineageV1,
  type DesktopOperationReviewActionV1,
  type DesktopOperationReviewItemV1,
} from "../ai/desktop-operation-review.js";
import { prepareDesktopExtendApplyV1 } from "../ai/desktop-operation-editor-apply.js";
import {
  desktopOperationAttemptKeyV1,
  isDesktopOperationAuthorizedThisSessionV1,
} from "../ai/desktop-operation-authorization.js";
import {
  applyEditorAuthorityChanges,
  classifyEditorTransaction,
  createEditorAuthorityState,
  resetEditorAuthorityState,
  type EditorAuthorityState,
} from "../editor/authoring-authority.js";
import {
  resolveAiPaletteRegistry,
  type AiPaletteActionId,
} from "../ai/palette-registry.js";
import { canSignWithSecrets } from "../identity/secret-store.js";
import { resetLocalApp } from "./factory-reset.js";
import { captureKEditTransaction } from "../provenance/kedit-capture.js";
import {
  captureStreamingScrollAnchor,
  restoreStreamingScrollTop,
} from "../editor/streaming-scroll.js";
import {
  chooseFolder,
  chooseFile,
  scanExternal,
  reifyToDisk,
  type Run,
  type FileState,
  type ScannedFile,
  type SampleEventMeta,
  type AttachedFolder,
} from "../workspace/workspace.js";
import {
  prepareReifyExport,
  traceSidecarEntries,
} from "../provenance/reify.js";
import {
  createLocalWorkspace,
  ensureLocalTreeFolderPath,
  forkFileIntoLocalTree,
  folderWriteSigner,
  localTreeFolderCoordinate,
  propagateLocalTreeFolderHead,
  type LocalFolderTree,
  type StagedMerge,
} from "../workspace/workspace-local.js";
import {
  clearFolderStepOperation,
  clearPadPath,
  createDesktopOperationCrashPadReceiptV1,
  isExactDesktopOperationCrashPadReceipt,
  loadLocalFolder,
  loadLocalShielded,
  loadPad,
  mirrorPad,
  pendingFolderStepOperation,
  saveLocalFile,
  saveLocalShielded,
  stageFolderStepOperation,
} from "../workspace/local-store.js";
import { restoreCrashPadFile } from "../workspace/crash-pad-restore.js";
import { resolvePostWriteTraceId } from "../workspace/stepped-file-identity.js";
import {
  EMPTY_KEDIT_LOG,
  appendKEditLog,
  dropKEditLogPrefix,
  ensureMdExt,
  fileHasUnsteppedChanges,
  keditLogFromArray,
  keditLogToArray,
  minimalTextChange,
  nextKEditTx,
  reconcileRunsText,
  spliceRuns,
  synthesizeKEditTransition,
  type FileStepBaseline,
  type KEditLog,
  type Workspace,
} from "../workspace/workspace-core.js";
import { getPublicKey, verifyEvent } from "nostr-tools/pure";
import { isTauri, resolveRelayUrl } from "../identity/identity.js";
import {
  getOrCreateMintFolder,
  getOrCreateScanFolder,
  getRootId,
  getRootLabel,
  mintRoot,
  setRootLabel,
  DEFAULT_ROOT_LABEL,
} from "../workspace/root.js";
import { planScanIntake } from "../workspace/scan-intake.js";
import { loadOnboardingDemo } from "./onboarding-demo.js";
import {
  modelContextLessonForFolder,
  planModelContextLesson,
  type ModelContextLesson,
} from "../ai/model-context-lesson.js";
import {
  getReconcilerVoice,
  getSubstrateVoice,
  getSubstrateSignerKeyId,
  setSubstrateSignerKeyId,
  getSubstrateBindingPubkey,
} from "../identity/external-voice-store.js";
import {
  gatherContextBlock,
  gatherContextSnapshot,
  clearChainMemo,
  renderLimelightLog,
} from "../ai/context-gather.js";
import {
  applyContextMount,
  applyScopeClick,
  contextMountState,
  pathInEffectiveScope,
  rebaseContextMountAfterMove,
  rebaseTraceRefsAfterMove,
  selectionForGroupAction,
  topLevelSelectedPaths,
  traceRefsKey,
  type ContextMounts,
  type ScopeRef,
  type TraceRef,
} from "../ai/scope-model.js";
import {
  appendReplayStepsAtLiveEnd,
  freshSelectedReplayHeads,
  replayHeadSignature,
} from "../replay/replay-live-sync.js";
import {
  planAttestation,
  planDelivery,
  type AttestationPlan,
} from "../provenance/step-policy.js";
import { occupancyTransitions, type OccupancyEntry } from "../replay/panel-occupancy.js";
import {
  createReplayPanels,
  replayLivePanelIndices,
  removeReplayPanels,
  type ReplayPanelPath,
} from "../replay/replay-panel-layout.js";
import {
  buildReplayTiming,
  formatReplayDuration,
  REPLAY_IDLE_THRESHOLD_MS,
  replayTimeFraction,
  replayTransition,
  type ReplayTiming,
} from "../replay/replay-timing.js";
import {
  buildReplayTimeline,
  collapseDerivedFolderCheckpoints,
  emptyReplayDisplay,
  folderReplayState,
  replayFrameIndexAtOrBefore,
  selectedReplayPaths,
  orderReplayTraceChain,
  replayDisplayAt,
  replayDisplayThroughFrame,
  replayDisplayWithFrame,
  type PlayFrame,
  type ReplayDisplay,
  type ReplayFolderState,
} from "../replay/replay-timeline.js";
import {
  combineTraceConformance,
  traceConformanceLabel,
  verifyFileTraceChain,
  verifyFolderTraceChain,
  type TraceConformanceVerdict,
} from "../provenance/trace-conformance.js";
import {
  type OpKind as PromptOpKind,
  type OpInputs,
} from "../ai/op-prompts.js";
import {
  loadOpLensSelections,
  saveOpLensSelection,
  type OpLensId,
} from "../ai/op-lenses.js";
import {
  ArrowUpDown,
  BarChart3,
  BookOpen,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  CircleDollarSign,
  Code,
  Cpu,
  Download,
  Eye,
  FileInput,
  FileText,
  FileX,
  Folder,
  FolderInput,
  FolderOpen,
  FolderX,
  GitCompare,
  GitFork,
  Globe,
  KeyRound,
  Layers3,
  Leaf,
  Megaphone,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Quote,
  Radio,
  Radiation,
  ScanLine,
  Sun,
  Trash2,
  Vault,
  type LucideIcon,
} from "lucide-react";
import {
  MINT,
  SCAN,
  OBLIVION,
  forkPathForMint,
  formatLocalSecondStamp,
  isMintPath as isMint,
  isScanPath as isScan,
  isOblivionPath as isOblivion,
  isSystemRootPath,
  mintedPath,
  slugifyFilename,
  systemPathDisplayName,
  uniquePath,
} from "../workspace/generated-paths.js";
import { directoryContextMenuCapabilities } from "../workspace/directory-context-menu.js";
import { deleteOutcomeMessage } from "../workspace/delete-confirmation.js";
import { closeDeletedTabs, type DeleteTabTarget } from "../workspace/delete-tabs.js";
import {
  buildDirectoryTree,
  treeNodeDisplayName,
  type TreeEntry,
  type TreeNode,
} from "../workspace/tree-model.js";
import {
  DIRECTORY_SORT_OPTIONS,
  loadDirectorySort,
  saveDirectorySort,
  type DirectorySortOrder,
} from "../workspace/directory-sort.js";
import "./App.css";

// Active new-file/new-folder creation. `parent` is the folder path the new
// item should be created inside ("" = workspace root). Set by the
// root row's New buttons (scoped to the selected trace's folder) and
// by the folder context menu (the right-clicked folder). While set, a phantom
// input row renders inline among `parent`'s children; the user types a name
// and hits Enter (or Esc to cancel) — no modal.
interface Creating {
  kind: "file" | "folder";
  parent: string;
}

// Each workspace panel holds its own list of open tabs (file paths) and the
// path of the tab currently shown in it. A panel can be empty (tabs: []) with
// active === "" to show its empty state. Which surface a file is shown on
// (preview vs markdown) is tracked per-path in `tabModes` below, not here — so
// each tab remembers its own surface as you switch between them.
interface PanelState {
  tabs: string[];
  active: string;
  /** Session-owned read-only replay panel, never persisted. */
  replayOwned?: boolean;
  /** Historical panel slot from a replay focus delta. */
  replayPanelIndex?: number;
}

type PanelOccupancy = OccupancyEntry<FocusSelection>;


// The unified "active trace" — there is always one once the user has selected
// anything, and it is what the action palette's ACTIONS row operates on. A trace is
// the protocol's single primitive (file | folder | coin), all
// realized as a kind-4290 nucleus. `path` is set for file/folder selections;
// `nodeId` is the trace nucleus id (file/folder chain head or coin id);
// `phrase` carries the visible text for a coin selection.
interface DirectCoinDraft {
  phrase: string;
  kedits: KEdit[];
  nextTx: number;
}

interface MintConsentRequest {
  phrase: string;
  resolve: (confirmed: boolean) => void;
}

interface MintRecoveryNotice {
  pending: number;
  failures: string[];
  startError?: string;
}

const emptyDirectCoinDraft = (): DirectCoinDraft => ({
  phrase: "",
  kedits: [],
  nextTx: 0,
});

interface AttestTarget {
  path: string;
  kind: "file" | "folder" | "coin";
  nodeId?: string;
  plan: Exclude<AttestationPlan, "unavailable">;
  /** Replay-local exact-node action; must never Step or retarget live focus. */
  historical?: true;
  panelIndex?: number;
}

type HistoricalActionPhase = "idle" | "running" | "done" | "error";
interface HistoricalActionStatus {
  send: HistoricalActionPhase;
  attest: HistoricalActionPhase;
  message?: string;
}

interface CoinClipboardCitation {
  phrase: string;
  nodeId: string;
}

interface CoinClipboardTicket {
  phrase: string;
  citation: CoinClipboardCitation;
}

// One step in a folder-wide replay timeline. `contentUpToHere` is the file's
// text as of this step (the chain replayed genesis→this node), precomputed at
// `beginReplay` so stepping is O(1) per step. The step list is ordered by
// `steppedAtMs` ascending and interleaves every file's steps AND every folder
// folder checkpoint (kind 4290: add/remove/rename/advance).
interface ReplayStep {
  event: Event;
  relativePath: string;
  meta: EventMeta;
  contentUpToHere: string;
  /** Per-author runs reconstructed from the chain's deltas up to this step.
   *  Each inserted range is attributed to the node's signer (event.pubkey), so
   *  the editor colors historical text by who actually wrote it — not by the
   *  session's latest signer. Drives `runs` in replayStepTo. */
  runsUpToHere: Run[];
  /** The footprint of *this step's* deltas in `contentUpToHere`'s coordinate
   *  space — the changed region vs the previous step of the same file (or the
   *  whole document for the file's genesis). Drives the editor's scroll-into-
   *  -view during replay so the action that produced each delta lands in view,
   *  not off-screen. `null` only when the step touched nothing (a tag/reply-
   *  -only edit on a non-first step). */
  changeRange: { from: number; to: number } | null;
  /** Present when this is a folder node carrying a structural membership
   *  change. It labels the Step without turning the folder into a document. */
  membership?: { type: "add" | "remove" | "rename" | "advance"; path: string };
  /** Signed folder membership plus buffered focus observations. Structural
   *  replay state only: folders never become panel tabs. */
  folder?: ReplayFolderState;
}

/** Latest content Step for one replay tab at a global cursor. */
function replayStepIndexForPath(
  steps: readonly ReplayStep[],
  index: number,
  path: string,
): number {
  for (let i = Math.min(index, steps.length - 1); i >= 0; i--) {
    const step = steps[i];
    if (step.relativePath === path) return i;
  }
  return -1;
}

// Views reachable from the nav rail. `editor` is the existing two-panel
// workspace; the rest are placeholders awaiting real implementations
// (globe → maplibre, keys/relays → nostr, models → LLM keys).
type View = "about" | "listings" | "editor" | "stats" | "globe" | "vaults" | "keys" | "networking" | "models" | "download" | "operator";

// Theme: "auto" follows prefers-color-scheme; "light"/"dark" are explicit
// overrides applied via <html data-theme>. main.tsx sets the attribute before
// React mounts to avoid a flash; these helpers keep the attribute + storage
// in sync as the user toggles.
const THEME_STORAGE_KEY = "zine-theme";
type Theme = "auto" | "light" | "dark";

function applyTheme(theme: Theme) {
  const el = document.documentElement;
  if (theme === "auto") el.removeAttribute("data-theme");
  else el.setAttribute("data-theme", theme);
  localStorage.setItem(THEME_STORAGE_KEY, theme);
}

function readTheme(): Theme {
  const stored = localStorage.getItem(THEME_STORAGE_KEY);
  return stored === "light" || stored === "dark" ? stored : "auto";
}

// Horizontal resize of the press: how wide the directory sidebar is.
// Persisted per-browser (zine.press.sidebarWidth); clamped to MIN..MAX on read.
const SIDEBAR_WIDTH_KEY = "zine.press.sidebarWidth";
const SIDEBAR_WIDTH_DEFAULT = 220;
// Floor matches the default: the replay stepper row (⏮ ◀ [n / total] ▶ ⏭ plus
// padding) needs ~200px to render without clipping, so 220 is the smallest width
// at which the whole transport stays visible.
const SIDEBAR_WIDTH_MIN = 220;
const SIDEBAR_WIDTH_MAX = 520;
function readSidebarWidth(): number {
  const stored = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
  if (!Number.isFinite(stored)) return SIDEBAR_WIDTH_DEFAULT;
  return Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, Math.round(stored)));
}

// Whether per-voice text color is shown. Orthogonal to the per-panel
// Preview/Markdown mode toggle: this is one global switch that applies to the
// same CodeMirror voice decorations in both modes (Preview and Markdown are
// two decoration configurations on one editor — see FileEditor/modeFacet).
// Default on — that's the press's reason for existing (attribution), but a
// reader who wants plain prose turns it off once for the whole workspace.
// Persisted per-browser.
const VOICE_ATTRIBUTION_KEY = "zine.voiceAttribution";
function readVoiceAttribution(): boolean {
  const stored = localStorage.getItem(VOICE_ATTRIBUTION_KEY);
  // Anything other than an explicit "false" → on (preserves the pre-toggle
  // behavior for existing installs and treats corrupt values as on).
  return stored !== "false";
}

// Whether the far-left nav rail is expanded (labels + wordmark visible) or
// collapsed (icon-only). Default open so first-time users see the labeled nav;
// once the user collapses it the choice is remembered across reloads.
const RAIL_EXPANDED_KEY = "zine.navRailExpanded";
function readRailExpanded(): boolean {
  const stored = localStorage.getItem(RAIL_EXPANDED_KEY);
  // Anything other than an explicit "false" → expanded (first-time users and
  // corrupt values both fall back to open).
  return stored !== "false";
}

// The resolved mode (what the user actually sees) drives which toggle icon to show.
function resolvedMode(theme: Theme): "light" | "dark" {
  if (theme === "light" || theme === "dark") return theme;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

// The workspace root is a logical folder trace, identified by `folder.id` and
// backed locally before relay synchronization. Disk is an explicit Scan/Reify
// substrate, not the editor's mutation backend. No hardcoded seed content —
// the sidebar is built from the attached local/relay workspace snapshot.

// --- run/text helpers -------------------------------------------------

function flatten(runs: Run[]): string {
  return runs.map((r) => r.text).join("");
}

/** Rough token estimate: ~4 chars/token for English/code prose. Good enough for
 *  a payload-size indicator — not billing. */
function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

/** Format a token count as "22.6k tokens" (≥1000) or "940 tokens". */
function formatTokens(n: number): string {
  return n >= 1000
    ? `${(n / 1000).toFixed(1)}k tokens`
    : `${n} tokens`;
}

// A valid tag/folder-name token: a letter/digit/underscore lead, then any of
// letters/digits/_/-. Same charset as a nostr hashtag body, and the rule the
// folder-name validation in createCommit enforces — keeps the derived folder
// tag and the folder path identical without any slugify step.
const TAG_TOKEN_RE = /^[\p{L}\p{N}_][\p{L}\p{N}_-]*$/u;
function isValidTagToken(name: string): boolean {
  return TAG_TOKEN_RE.test(name);
}

// The action-palette LLM operations. With a non-empty editor selection, each
// acts on just the selected text (continuing/condensing/reinventing/replying
// to that range in place); with no selection, each acts on the whole document.
export type OpKind = AiPaletteActionId | "step" | "send" | "attest";

/** Split flat doc text into preserved bracket spans (`[[ … ]]`, kept verbatim)
 *  and the loose prose between them. The substrate for Settle (condense loose)
 *  and Stir (reinvent loose + drop `(( ))`). Bracket text is the *whole*
 *  occurrence including markup, so it round-trips byte-for-byte when rebuilt. */
function partitionDoc(text: string): { kind: "bracket" | "loose"; text: string }[] {
  const parts: { kind: "bracket" | "loose"; text: string }[] = [];
  let cursor = 0;
  for (const b of iterBrackets(text)) {
    if (b.matchStart > cursor) {
      parts.push({ kind: "loose", text: text.slice(cursor, b.matchStart) });
    }
    parts.push({ kind: "bracket", text: text.slice(b.matchStart, b.matchEnd) });
    cursor = b.matchEnd;
  }
  if (cursor < text.length) parts.push({ kind: "loose", text: text.slice(cursor) });
  return parts;
}

/** Substitute the model's [[ANCHOR N]] markers with the real, verbatim bracket
 *  occurrences from the original doc, preserving anchor order. Any markers the
 *  model didn't place are appended at the end so no anchor is silently lost. */
function reweaveAnchors(reinvented: string, original: string): string {
  const anchors = [...iterBrackets(original)].map((b) => original.slice(b.matchStart, b.matchEnd));
  let i = 0;
  let out = reinvented.replace(/\[\[ANCHOR\s+(\d+)\]\]/g, () => {
    if (i < anchors.length) return anchors[i++];
    return "";
  });
  // Append any anchors the model didn't place.
  while (i < anchors.length) {
    out += "\n" + anchors[i++];
  }
  return out;
}

/** Encode Settle's immutable bracket spans as opaque tokens so the whole
 * selected range can be prepared and condensed in one atomic request. */
function encodeSettleAnchors(text: string): { promptText: string; anchors: string[] } {
  const anchors: string[] = [];
  let cursor = 0;
  let promptText = "";
  for (const bracket of iterBrackets(text)) {
    promptText += text.slice(cursor, bracket.matchStart);
    anchors.push(text.slice(bracket.matchStart, bracket.matchEnd));
    promptText += `__ZINE_ANCHOR_${anchors.length}__`;
    cursor = bracket.matchEnd;
  }
  promptText += text.slice(cursor);
  return { promptText, anchors };
}

/** Remove [start, end) ranges from `text`, in order, by absolute position.
 *  Used by Stir to drop `(( command ))` spans (sourced from `findCommands`)
 *  without a second regex match that could drift from the parser. Ranges must
 *  be non-overlapping and ascending; sort defensively anyway. */
function stripRanges(text: string, ranges: [number, number][]): string {
  if (ranges.length === 0) return text;
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  let out = "";
  let cursor = 0;
  for (const [start, end] of sorted) {
    if (start < cursor) continue; // overlap with a prior range — skip
    out += text.slice(cursor, start);
    cursor = end;
  }
  out += text.slice(cursor);
  return out;
}

/**
 * Split a Reply model stream into an optional TITLE header + body.
 * The model is asked to emit `TITLE: <name>` as its first line. Until that
 * first line is complete (`headerDone`), the body is withheld so the TITLE
 * line never lands in the editor. If the first line isn't a TITLE, the whole
 * raw string is treated as body (fallback when the model ignores the format).
 */
function parseReplyOutput(
  raw: string,
  streamDone = false,
): { title: string | null; body: string; headerDone: boolean } {
  const nl = raw.indexOf("\n");
  if (nl < 0) {
    if (!streamDone) return { title: null, body: "", headerDone: false };
    const m = raw.match(/^TITLE:\s*(.+?)\s*$/i);
    if (m) {
      const title = m[1].trim();
      return { title: title || null, body: "", headerDone: true };
    }
    return { title: null, body: raw, headerDone: true };
  }
  const first = raw.slice(0, nl);
  const rest = raw.slice(nl + 1).replace(/^\r?\n/, "");
  const m = first.match(/^TITLE:\s*(.+?)\s*$/i);
  if (m) {
    const title = m[1].trim();
    return { title: title || null, body: rest, headerDone: true };
  }
  return { title: null, body: raw, headerDone: true };
}

// --- tree moves (drag & drop) -----------------------------------------
//
// Tree rows publish `text/zine-path` plus a `text/plain` payload of
// `zine-path:<path>`. Some hosts (WKWebView / Tauri) keep the custom type in
// `.types` for dragover but strip it from `getData` at drop — the plain
// prefix is the recovery path. Tab drags use bare `text/plain` (no prefix),
// so the two gestures stay distinguishable.
function zinePathFromDataTransfer(dt: DataTransfer): string {
  const custom = dt.getData("text/zine-path");
  if (custom) return custom;
  const plain = dt.getData("text/plain");
  if (plain.startsWith("zine-path:")) return plain.slice("zine-path:".length);
  return "";
}

function isZinePathDrag(dt: DataTransfer): boolean {
  const types = Array.from(dt.types);
  if (types.includes("text/zine-path")) return true;
  // Custom MIME gone entirely — peek plain when the host allows (same-
  // document WebKit often does during dragover; Chrome returns "" until drop).
  const plain = dt.getData("text/plain");
  return plain.startsWith("zine-path:");
}

// Moves are "into folder" — dropping a node onto a folder (or onto the root
// area) reparents it. The tree stays alphabetically sorted by buildTree, so
// there's no positional/insertion-order state to maintain. "" means root.

const ROOT = "";

function basename(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
}

function parentPath(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? ROOT : path.slice(0, i);
}

/** Merge folder-trace placeholders written by recursive tree operations back
 * into the live path-indexed UI state. File paths already imply their visual
 * ancestors, but explicit folder states retain each folder's replay identity. */
function withPersistedFolderStates(
  current: Record<string, FileState>,
  rootId: string,
  subtree = ROOT,
): Record<string, FileState> {
  const local = loadLocalFolder(rootId);
  if (!local) return current;
  const next = { ...current };
  for (const [path, entry] of Object.entries(local.files)) {
    if (entry.kind !== "folder") continue;
    if (subtree && path !== subtree && !path.startsWith(`${subtree}/`)) continue;
    next[path] = {
      kind: "folder",
      runs: [],
      nodeId: entry.nodeId,
      ...(entry.traceId ? { traceId: entry.traceId } : {}),
      tags: [],
      updatedAt: entry.updatedAt,
    };
  }
  return next;
}

/** Effective scope is the one context mount with shielded traversal boundaries. */
function isInScope(
  scopes: ContextMounts,
  shielded: Set<string>,
  targetPath: string,
): boolean {
  return (
    !!targetPath &&
    !isOblivion(targetPath) &&
    !isMint(targetPath) &&
    !isScan(targetPath) &&
    pathInEffectiveScope(scopes, shielded, targetPath)
  );
}

function automationScopesFor(mounts: ContextMounts): AutomationScopes {
  const mount = mounts[0];
  return mount ? [{ kind: mount.kind, path: mount.path }] : [];
}

// Does `parent` contain any file or folder beneath it? Used by both move and
// delete to decide whether a path is a folder with descendants to sweep.
function hasChild(files: Set<string>, folders: Set<string>, parent: string): boolean {
  for (const f of files) if (f.startsWith(parent + "/")) return true;
  for (const f of folders) if (f.startsWith(parent + "/")) return true;
  return false;
}

// Is `descendant` the same as or nested inside `ancestor`?
function isDescendantOrSelf(ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  return descendant.startsWith(ancestor + "/");
}

// Can `src` be moved into `destFolder` ("" = root), given the current set of
// file and folder paths? Rejects: self/descendant moves, no-op moves, and
// name collisions at the destination.
function canDrop(
  src: string,
  destFolder: string,
  files: Set<string>,
  folders: Set<string>,
): boolean {
  // Mint and Scan are append-only system regions. Ordinary items cannot be
  // moved into either. Dragging one of their members out is an adoption/fork
  // gesture, so the source remains in its private system folder.
  if (
    isMint(destFolder) ||
    isScan(destFolder) ||
    (isOblivion(destFolder) && (isMint(src) || isScan(src)))
  ) return false;
  if (isMint(src)) {
    return src !== MINT && !isSystemRootPath(destFolder);
  }
  if (isScan(src)) {
    return src !== SCAN && !isSystemRootPath(destFolder);
  }
  if (destFolder === parentPath(src)) return false; // already here
  if (isDescendantOrSelf(src, destFolder)) return false; // can't move into self/descendant
  const name = basename(src);
  const destPath = destFolder === ROOT ? name : `${destFolder}/${name}`;
  if (files.has(destPath) || folders.has(destPath)) return false; // name collision
  return true;
}

function rebasePath(path: string, src: string, destFolder: string): string {
  const name = basename(src);
  const destPath = destFolder === ROOT ? name : `${destFolder}/${name}`;
  if (path === src) return destPath;
  return destPath + path.slice(src.length); // path.startsWith(src + "/")
}

// --- folder tabs --------------------------------------------------------
//
// A folder can be opened as a panel tab to attach tags and show a summary.
// Tabs are plain path strings (see PanelState), so a folder tab is encoded as
// the sentinel `folder://<relpath>`. This keeps open/close/move/drag/parallel
// per-panel arrays all working unchanged; only the few sites that assume a
// tab is a file path (the Panel body, tabModes, tab label/tooltip, and the
// move/rename/delete rebasers) need to know about the prefix.
const FOLDER_TAB_PREFIX = "folder://";
const isFolderTab = (p: string): boolean => p.startsWith(FOLDER_TAB_PREFIX);
const folderTab = (relPath: string): string => FOLDER_TAB_PREFIX + relPath;
const folderTabPath = (p: string): string => p.slice(FOLDER_TAB_PREFIX.length);
const DIRECT_COIN_COMPOSER_TAB = "coin-compose://direct";
const isCoinComposerTab = (p: string): boolean => p === DIRECT_COIN_COMPOSER_TAB;
/** Mint members are immutable Coin tabs, never editable file tabs. */
const isCoinTab = (p: string): boolean => !isFolderTab(p) && p !== MINT && isMint(p);
const isCompletedCoinFile = (file: FileState | undefined): boolean =>
  !!file && file.kind !== "folder" && file.coinComplete === true;
const isCompletedCoinPath = (
  path: string,
  files: Record<string, FileState>,
): boolean => isCoinTab(path) && isCompletedCoinFile(files[path]);
/** Tab label: the basename of a file, or the basename of a folder's relpath. */
const tabLabel = (p: string): string => {
  if (isCoinComposerTab(p)) return "New Coin";
  const path = isFolderTab(p) ? folderTabPath(p) : p;
  return path === ROOT ? "Root" : systemPathDisplayName(path);
};
/** Tab tooltip: a folder tab shows its relpath with a trailing slash to read
 *  as a folder; a file tab shows its raw path. */
const tabTitle = (p: string): string =>
  isCoinComposerTab(p) ? "New direct Coin" : isFolderTab(p) ? folderTabPath(p) + "/" : p;

function folderMembershipFromEvent(
  event: Event,
  mountedPath: string,
): ReplayStep["membership"] {
  let deltas: Array<{
    type?: string;
    relativePath?: string;
    fromPath?: string;
    toPath?: string;
  }>;
  try {
    const parsed = JSON.parse(event.content) as { deltas?: typeof deltas };
    deltas = Array.isArray(parsed.deltas) ? parsed.deltas : [];
  } catch {
    return undefined;
  }
  const delta = deltas.find(
    (candidate) =>
      candidate.type === "add" ||
      candidate.type === "remove" ||
      candidate.type === "rename" ||
      candidate.type === "advance",
  );
  if (
    !delta ||
    (
      delta.type !== "add" &&
      delta.type !== "remove" &&
      delta.type !== "rename" &&
      delta.type !== "advance"
    )
  ) {
    return undefined;
  }
  const relativePath = delta.type === "rename" ? delta.toPath : delta.relativePath;
  if (!relativePath) return undefined;
  const path =
    !mountedPath ||
    relativePath === mountedPath ||
    relativePath.startsWith(`${mountedPath}/`)
      ? relativePath
      : `${mountedPath}/${relativePath}`;
  return { type: delta.type, path };
}

function folderReplayStep(
  event: Event,
  mountedPath: string,
): ReplayStep {
  return {
    event,
    relativePath: "",
    meta: eventMeta(event),
    contentUpToHere: "",
    runsUpToHere: [],
    changeRange: null,
    membership: folderMembershipFromEvent(event, mountedPath),
    folder: folderReplayState(event, mountedPath),
  };
}

/** Folder trace identity is still its genesis id, but the shared file resolver
 * deliberately rejects folder-reified nodes. Walk the exact folder head here
 * so nested selected folders can replay their own chain too. */
async function resolveFolderTraceIdentity(nodeId: string): Promise<string | null> {
  const seen = new Set<string>();
  let cursor: string | undefined = nodeId;
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const event = await fetchEventById(cursor);
    if (!event || !event.tags.some((tag) => tag[0] === "z" && tag[1] === "folder")) {
      return null;
    }
    const prev = event.tags.find(
      (tag) => tag[0] === "e" && tag[3] === "prev",
    )?.[1];
    if (!prev) return event.id;
    cursor = prev;
  }
  return null;
}

/** Rebase a folder-tab sentinel when the underlying folder moves/renames.
 *  Applies the same path rebase to the inner relpath; returns the sentinel
 *  unchanged if it doesn't refer to `src` or a descendant. */
function rebaseFolderTab(tab: string, src: string, destFolder: string): string {
  if (!isFolderTab(tab)) return tab;
  return folderTab(rebasePath(folderTabPath(tab), src, destFolder));
}


// --- panel / tab helpers ------------------------------------------------
//
// Panels are an N-column array: the active doc plus as many sibling columns to
// the right as the user opens — via right-click "Open to side" or dragging a
// tab onto a panel's right edge. Empty panels collapse back out (see
// closeTab/moveTab). Updated immutably via small array helpers rather than
// hand-rolled spread at each site. MAX_PANELS is only a runaway-layout guard,
// not a real UX limit.
const MAX_PANELS = 64;

function mapPanel(
  panels: PanelState[],
  idx: number,
  fn: (p: PanelState) => PanelState,
): PanelState[] {
  const current = panels[idx];
  // A replay tick can remove an ephemeral panel between pointer-down and the
  // tab action. Treat that stale index as a no-op instead of calling `fn` with
  // undefined (the `p.tabs` crash reported by close/open handlers).
  if (!current) return panels;
  const updated = fn(current);
  if (updated === current) return panels;
  const next = [...panels];
  next[idx] = updated;
  return next;
}

// Drop the panel at `idx` from the array. Returns the spliced array.
function removeAt<T>(arr: T[], idx: number): T[] {
  if (idx < 0 || idx >= arr.length) return arr;
  return [...arr.slice(0, idx), ...arr.slice(idx + 1)];
}

// Insert `item` into the array at position `at` (clamped to the end). Returns
// a new array — the pure primitive the live moveTabToNewPanel/commitWithCollapse
// wrappers in App build on.
function spliceAt<T>(arr: T[], at: number, item: T): T[] {
  const i = Math.min(at, arr.length);
  return [...arr.slice(0, i), item, ...arr.slice(i)];
}

// Pick the next tab to activate after `removed` is closed: prefer the tab to
// the right, else the left, else "" when no tabs remain.
function nextActive(tabs: string[], removed: string): string {
  const idx = tabs.indexOf(removed);
  if (idx === -1) return tabs[tabs.length - 1] ?? "";
  return tabs[idx] ?? tabs[idx - 1] ?? "";
}

// Return only the per-tab mode entries whose path is still open as a tab in at
// least one panel. Anything else is stale (its tab was closed or its panel
// collapsed) and is dropped — so reopening a closed file defaults back to
// preview rather than recalling a surface the user abandoned. A pure function
// so callers can pass it straight to setTabModes.
function pruneTabModes(
  modes: Record<string, Mode>,
  panels: PanelState[],
): Record<string, Mode> {
  const open = new Set<string>();
  for (const p of panels) {
    for (const t of p.tabs) {
      if (!isFolderTab(t) && !isCoinTab(t) && !isCoinComposerTab(t)) open.add(t);
    }
  }
  if (open.size === 0) return {};
  const next: Record<string, Mode> = {};
  for (const [path, mode] of Object.entries(modes)) {
    if (open.has(path)) next[path] = mode;
  }
  return next;
}

// Validate a saved layout against a freshly scanned file set and return the
// restored state (or null when nothing usable survives). Each panel's file tabs
// are filtered to paths still present in `scanned`; folder tabs (`folder://…`)
// pass through since they aren't file paths. Panels that empty out are dropped;
// if all of them do, the whole layout is rejected (null) so openScanned falls
// back to the default first-file panel. The active tab is re-pointed via
// nextActive when its path was pruned, activePanel is clamped to the surviving
// panel count, and panelWeights reset to even when its length no longer matches.
// A pure function so openScanned can call it before any setState.
function reconcileLayout(
  saved: WorkspaceLayout,
  scanned: Record<string, FileState>,
): {
  panels: PanelState[];
  activePanel: number;
  weights: number[];
  tabModes: Record<string, Mode>;
} | null {
  const exists = (p: string): boolean => isFolderTab(p) || p in scanned;
  const panels: PanelState[] = [];
  for (const sp of saved.panels) {
    const tabs = sp.tabs.filter(exists);
    if (tabs.length === 0) continue; // panel fully stale — drop it
    const active = tabs.includes(sp.active) ? sp.active : nextActive(tabs, sp.active);
    panels.push({ tabs, active });
  }
  if (panels.length === 0) return null;
  const activePanel = Math.min(saved.activePanel, panels.length - 1);
  // Weights must line up 1:1 with the surviving panels; if pruning changed the
  // count (or the saved weights were empty/malformed), reset to even shares.
  // A lone panel always gets weight 1: flexbox only fills the row when
  // Σ(flex-grow) ≥ 1 (CSS Flexbox §9.7), so a leftover fractional weight from
  // a prior split would leave empty space beside the column.
  let weights =
    saved.panelWeights.length === panels.length
      ? saved.panelWeights
      : panels.map(() => 1);
  if (panels.length === 1) weights = [1];
  const tabModes = pruneTabModes(saved.tabModes, panels);
  return { panels, activePanel, weights, tabModes };
}

// --- components ---------------------------------------------------------

// The inline "new file/folder" phantom row. Rendered among a folder's
// children (or at the top level when parent === ROOT) while `creating` is
// active — instead of a modal. Behaves like the rename input: the user types a
// name directly over the placeholder, Enter commits, Escape/empty-blur cancels.
// A validation error from createCommit surfaces via `error` and keeps the input
// open. Indented to `depth` so it lines up with its future siblings.
function CreateRow({
  kind,
  depth,
  draft,
  error,
  inputRef,
  onChange,
  onKey,
  onCommit,
  onCancel,
}: {
  kind: "file" | "folder";
  depth: number;
  draft: string;
  error: string | null;
  inputRef: React.RefObject<HTMLInputElement | null>;
  onChange: (v: string) => void;
  onKey: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  const indent = { paddingLeft: depth * 14 + 10 };
  const placeholder = kind === "folder" ? "folder name…" : "file name…";
  return (
    <div
      className={"tree-row tree-folder tree-row-creating" + (error ? " tree-row-creating-error" : "")}
      style={indent}
    >
      {kind === "folder" ? (
        <Folder size={13} className="tree-icon" aria-hidden="true" />
      ) : (
        <FileText size={13} className="tree-icon" aria-hidden="true" />
      )}
      <input
        ref={inputRef}
        className={"create-input" + (error ? " invalid" : "")}
        type="text"
        // Filenames are identifiers, not prose — disable the mobile/IME
        // auto-capitalize + auto-complete + spellcheck so the typed casing is
        // preserved verbatim (e.g. lowercase "drafts" stays lowercase).
        autoCapitalize="off"
        autoComplete="off"
        spellCheck={false}
        value={draft}
        placeholder={placeholder}
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKey}
        onBlur={() => {
          // Empty on blur cancels; a non-empty value commits (and stays open
          // if commit returned an error), matching the rename input.
          if (!draft.trim() && !error) onCancel();
          else if (draft.trim()) onCommit();
          else onCancel();
        }}
        aria-invalid={!!error}
      />
      {error && <p className="create-error">{error}</p>}
    </div>
  );
}

function TreeItem({
  node,
  depth,
  collapsed,
  onToggleFolder,
  focusedTabPath,
  selectedPaths,
  scopes,
  shielded,
  onSetMountState,
  draggingPaths,
  dropTargetPath,
  onDragStart,
  onDragEnterTarget,
  onDragLeaveTarget,
  onDropOn,
  canDropOn,
  dragEffect,
  onContextMenuRow,
  renamingPath,
  renameInputRef,
  renameDraft,
  renameError,
  onRenameChange,
  onRenameKey,
  onRenameCommit,
  onRenameCancel,
  onRowActivate,
  onCreateStart,
  onMintCoin,
  coinsEnabled,
  onScan,
  creating,
  createDraft,
  createError,
  createInputRef,
  onCreateChange,
  onCreateKey,
  onCreateCommit,
  onCreateCancel,
}: {
  node: TreeNode;
  depth: number;
  collapsed: Set<string>;
  onToggleFolder: (path: string) => void;
  /** Tree path shown by the active tab in the focused panel. */
  focusedTabPath: string | null;
  /** Explorer-style row selection, kept separate from the context mount. */
  selectedPaths: ReadonlySet<string>;
  /** The one explicit context mount. A folder contributes its descendants. */
  scopes: ContextMounts;
  /** Shielded paths. A folder shields its entire subtree. */
  shielded: Set<string>;
  /** Replace, clear, or exclude within the one prompt-context mount. */
  onSetMountState: (target: ScopeRef, mounted: boolean) => void;
  /** Row click with modifier context. The Sidebar owns ordinary selection;
   *  plain click also activates the trace while modifier clicks select only. */
  onRowActivate: (item: ActivatableTreeItem, e: React.MouseEvent) => void;
  draggingPaths: Set<string>;
  dropTargetPath: string | null;
  onDragStart: (item: ActivatableTreeItem) => void;
  onDragEnterTarget: (path: string) => void;
  onDragLeaveTarget: (path: string) => void;
  onDropOn: (path: string) => void;
  canDropOn: (path: string) => boolean;
  dragEffect: () => "copy" | "move";
  onContextMenuRow: (e: React.MouseEvent, item: ActivatableTreeItem) => void;
  renamingPath: string | null;
  renameInputRef: React.RefObject<HTMLInputElement | null>;
  renameDraft: string;
  renameError: string | null;
  onRenameChange: (v: string) => void;
  onRenameKey: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  onRenameCommit: () => void;
  onRenameCancel: () => void;
  /** New file / New folder from the root row. Parent follows tree selection. */
  onCreateStart: (kind: "file" | "folder") => void;
  /** Open the direct-Coin composer from the Mint region header. */
  onMintCoin: () => void;
  coinsEnabled: boolean;
  /** Acquire a filesystem snapshot from the Scan region header. */
  onScan: (kind: "file" | "folder") => void;
  /** Active inline creation (null unless a New button/context-menu entry was
   *  just clicked). When set, a phantom input row renders among this folder's
   *  children iff `creating.parent === node.path`. */
  creating: Creating | null;
  createDraft: string;
  createError: string | null;
  createInputRef: React.RefObject<HTMLInputElement | null>;
  onCreateChange: (v: string) => void;
  onCreateKey: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  onCreateCommit: () => void;
  onCreateCancel: () => void;
}) {
  const indent = { paddingLeft: depth * 14 + 10 };
  const displayName = treeNodeDisplayName(node);
  const isDragging = draggingPaths.has(node.path);
  const isDropTarget = dropTargetPath === node.path;
  const isRenaming = renamingPath === node.path;
  const isTabFocused = focusedTabPath !== null && node.path === focusedTabPath;
  const isTreeSelected = selectedPaths.has(node.path);
  if (node.type === "folder") {
    const isOpen = !collapsed.has(node.path);
    const dropAllowed = canDropOn(node.path);
    const isRoot = node.isRoot === true;
    const isCappedSystemRegion =
      node.systemKind === "mint" ||
      node.systemKind === "scan" ||
      node.systemKind === "oblivion";
    const privateSystemItem =
      isMint(node.path) || isScan(node.path) || isOblivion(node.path);
    const folderMountState = privateSystemItem
      ? "unmounted"
      : contextMountState(scopes, shielded, node.path);
    const folderMounted = folderMountState === "mounted";
    const folderIncluded = folderMounted || folderMountState === "included";
    const folderIconClass =
      "tree-icon" +
      (isOblivion(node.path)
        ? " tree-icon-oblivion"
        : folderMounted
          ? " tree-icon-in-scope"
          : folderMountState === "included"
            ? " tree-icon-included"
            : folderMountState === "shielded"
              ? " tree-icon-shielded"
              : "");
    const rowClass =
      "tree-row tree-folder" +
      (isRoot ? " tree-row-root" : "") +
      (isTabFocused ? " tree-row-tab-focused" : "") +
      (isTreeSelected ? " tree-row-selected" : "") +
      (isDragging ? " tree-dragging" : "") +
      (isDropTarget && dropAllowed ? " tree-drop-target" : "") +
      (isDropTarget && !dropAllowed ? " tree-drop-denied" : "");
    const folderGlyph =
      node.systemKind === "mint" ? (
        <Leaf size={13} className="tree-icon tree-icon-mint" aria-hidden="true" />
      ) : node.systemKind === "scan" ? (
        <ScanLine size={13} className="tree-icon tree-icon-scan" aria-hidden="true" />
      ) : node.systemKind === "oblivion" ? (
        <Trash2 size={13} className="tree-icon" aria-hidden="true" />
      ) : folderMountState === "shielded" ? (
        <FolderX size={13} className={folderIconClass} aria-hidden="true" />
      ) : node.systemKind === "root" ? (
        <BookOpen size={13} className={folderIconClass} aria-hidden="true" />
      ) : isScan(node.path) ? (
        <FolderInput size={13} className="tree-icon tree-icon-scan" aria-hidden="true" />
      ) : isOpen ? (
        <FolderOpen size={13} className={folderIconClass} aria-hidden="true" />
      ) : (
        <Folder size={13} className={folderIconClass} aria-hidden="true" />
      );
    return (
      <div
        className={
          "tree-node" +
          (isRoot ? " tree-node-root" : "") +
          (isCappedSystemRegion ? " tree-node-system" : "")
        }
      >
        <div
          className={rowClass}
          style={indent}
          aria-current={isTabFocused ? "true" : undefined}
          draggable={!isRoot && !isRenaming}
          onDragStart={(e) => {
            // copyMove: tree reparent uses "move"; tag-strip drop uses "copy".
            // "move"-only rejects a link/copy dropEffect and the tag drop dies.
            e.dataTransfer.effectAllowed = "copyMove";
            e.dataTransfer.setData("text/zine-path", node.path);
            // text/plain fallback for hosts that strip custom MIME types
            // (WKWebView / some Tauri shells) on getData at drop time.
            e.dataTransfer.setData("text/plain", `zine-path:${node.path}`);
            onDragStart(node);
          }}
          onDragEnter={(e) => {
            if (canDropOn(node.path)) {
              e.preventDefault();
              onDragEnterTarget(node.path);
            }
          }}
          onDragOver={(e) => {
            // The root is always a drop target (drop on root = move to root);
            // other folders only when a drop is allowed and they're not the
            // dragged source.
            if (canDropOn(node.path)) {
              e.preventDefault();
              e.dataTransfer.dropEffect = dragEffect();
              // dragenter can race the dragstart render in WebKit. Reassert
              // the target from dragover so the valid-target ring still paints.
              onDragEnterTarget(node.path);
            }
          }}
          onDragLeave={(e) => {
            // only clear when leaving for a different row, not when entering a child
            if (e.currentTarget.contains(e.relatedTarget as Node)) return;
            onDragLeaveTarget(node.path);
          }}
          onDrop={(e) => {
            // Never let a folder-row drop fall through to the tree container's
            // "move to root" surface, even when this folder is invalid.
            e.stopPropagation();
            if (!canDropOn(node.path)) return;
            e.preventDefault();
            onDropOn(node.path);
          }}
          onContextMenu={(e) => onContextMenuRow(e, node)}
          onClick={(e) => {
            // The label focuses/opens the folder. Expansion belongs only to
            // the separate chevron below.
            if (!isRenaming) onRowActivate(node, e);
          }}
        >
          <button
            type="button"
            className="tree-expand-btn"
            aria-expanded={isOpen}
            aria-label={`${isOpen ? "Collapse" : "Expand"} ${displayName}`}
            title={isOpen ? "Collapse folder" : "Expand folder"}
            onClick={(e) => {
              e.stopPropagation();
              onToggleFolder(node.path);
            }}
          >
            {isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </button>
          {isCappedSystemRegion || isScan(node.path) ? (
            <span
              className="tree-icon-slot tree-system-icon"
              title={
                node.systemKind === "mint"
                  ? "Mint"
                  : node.systemKind === "scan"
                    ? "Scan"
                    : isScan(node.path)
                      ? "Scanned folder"
                    : "Oblivion"
              }
              aria-hidden="true"
            >
              {folderGlyph}
            </span>
          ) : (
            <button
              type="button"
              className="tree-icon-slot tree-icon-btn"
              data-mount-state={folderMountState}
              aria-pressed={folderIncluded}
              aria-label={
                folderIncluded
                  ? `Exclude ${displayName} from context`
                  : `Mount ${displayName} for context`
              }
              title={
                folderIncluded
                  ? "Exclude folder and descendants from prompt context"
                  : "Mount folder and descendants, replacing the current prompt context"
              }
              onClick={(e) => {
                e.stopPropagation();
                onSetMountState(
                  { kind: "folder", path: node.path },
                  !folderIncluded,
                );
              }}
            >
              {folderGlyph}
            </button>
          )}
          {isRenaming ? (
            <input
              ref={renameInputRef}
              className={"create-input" + (renameError ? " invalid" : "")}
              type="text"
              autoCapitalize="off"
              autoComplete="off"
              spellCheck={false}
              value={renameDraft}
              placeholder="folder name…"
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => onRenameChange(e.target.value)}
              onKeyDown={onRenameKey}
              onBlur={() => {
                // Empty on blur cancels; a non-empty value commits (and
                // stays open if commit returned an error).
                if (!renameDraft.trim() && !renameError) onRenameCancel();
                else if (renameDraft.trim()) onRenameCommit();
                else onRenameCancel();
              }}
              aria-invalid={!!renameError}
            />
          ) : (
            <span className="tree-name">{displayName}</span>
          )}
          {isRoot && node.systemKind === "root" && (
            <span
              className="tree-row-actions"
              onClick={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
            >
              <button
                className="icon-btn"
                type="button"
                title="New folder"
                aria-label="New folder"
                onClick={() => onCreateStart("folder")}
              >
                <Folder size={14} aria-hidden="true" />
              </button>
              <button
                className="icon-btn"
                type="button"
                title="New file"
                aria-label="New file"
                onClick={() => onCreateStart("file")}
              >
                <FileText size={14} aria-hidden="true" />
              </button>
            </span>
          )}
          {isRoot && node.systemKind === "mint" && (
            <span
              className="tree-row-actions"
              onClick={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
            >
              <button
                className="icon-btn"
                type="button"
                title={coinsEnabled ? "Mint a direct Coin" : "Enable Coins in Networking to Mint"}
                aria-label="Mint a direct Coin"
                disabled={!coinsEnabled}
                onClick={onMintCoin}
              >
                <CircleDollarSign size={14} aria-hidden="true" />
              </button>
            </span>
          )}
          {isRoot && node.systemKind === "scan" && (
            <span
              className="tree-row-actions"
              onClick={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
            >
              <button
                className="icon-btn"
                type="button"
                title="Scan folder"
                aria-label="Scan folder"
                onClick={() => onScan("folder")}
              >
                <FolderInput size={14} aria-hidden="true" />
              </button>
              <button
                className="icon-btn"
                type="button"
                title="Scan file"
                aria-label="Scan file"
                onClick={() => onScan("file")}
              >
                <FileInput size={14} aria-hidden="true" />
              </button>
            </span>
          )}
          {isRenaming && renameError && <p className="create-error">{renameError}</p>}
        </div>
        {isOpen && (
          <div
            className={
              "tree-children" +
              (isCappedSystemRegion ? " tree-system-children" : "")
            }
          >
            {node.children!.map((c) => (
              <TreeItem
                key={c.path}
                node={c}
                depth={depth + 1}
                collapsed={collapsed}
                onToggleFolder={onToggleFolder}
                focusedTabPath={focusedTabPath}
                selectedPaths={selectedPaths}
                scopes={scopes}
                shielded={shielded}
                onSetMountState={onSetMountState}
                draggingPaths={draggingPaths}
                dropTargetPath={dropTargetPath}
                onDragStart={onDragStart}
                onDragEnterTarget={onDragEnterTarget}
                onDragLeaveTarget={onDragLeaveTarget}
                onDropOn={onDropOn}
                canDropOn={canDropOn}
                dragEffect={dragEffect}
                onContextMenuRow={onContextMenuRow}
                renamingPath={renamingPath}
                renameInputRef={renameInputRef}
                renameDraft={renameDraft}
                renameError={renameError}
                onRenameChange={onRenameChange}
                onRenameKey={onRenameKey}
                onRenameCommit={onRenameCommit}
                onRenameCancel={onRenameCancel}
                onRowActivate={onRowActivate}
                onCreateStart={onCreateStart}
                onMintCoin={onMintCoin}
                coinsEnabled={coinsEnabled}
                onScan={onScan}
                creating={creating}
                createDraft={createDraft}
                createError={createError}
                createInputRef={createInputRef}
                onCreateChange={onCreateChange}
                onCreateKey={onCreateKey}
                onCreateCommit={onCreateCommit}
                onCreateCancel={onCreateCancel}
              />
            ))}
            {creating &&
              creating.parent === node.path &&
              CreateRow({
                kind: creating.kind,
                depth: depth + 1,
                draft: createDraft,
                error: createError,
                inputRef: createInputRef,
                onChange: onCreateChange,
                onKey: onCreateKey,
                onCommit: onCreateCommit,
                onCancel: onCreateCancel,
              })}
          </div>
        )}
      </div>
    );
  }

  const privateSystemItem =
    isMint(node.path) || isScan(node.path) || isOblivion(node.path);
  const fileMountState = privateSystemItem
    ? "unmounted"
    : contextMountState(scopes, shielded, node.path);
  const fileMounted = fileMountState === "mounted";
  const fileIncluded = fileMounted || fileMountState === "included";
  const fileIconClass =
    "tree-icon" +
    (isOblivion(node.path)
      ? " tree-icon-oblivion"
      : fileMounted
        ? " tree-icon-in-scope"
        : fileMountState === "included"
          ? " tree-icon-included"
          : fileMountState === "shielded"
            ? " tree-icon-shielded"
            : "");

  return (
    <div
      className={
        "tree-row tree-file" +
        (isTabFocused ? " tree-row-tab-focused" : "") +
        (isTreeSelected ? " tree-row-selected" : "") +
        (isDragging ? " tree-dragging" : "")
      }
      style={indent}
      aria-current={isTabFocused ? "true" : undefined}
      draggable={!isRenaming && node.systemKind !== "mint-pending"}
      onDragStart={(e) => {
        // copyMove: tree reparent uses "move"; tag-strip drop uses "copy".
        e.dataTransfer.effectAllowed = "copyMove";
        e.dataTransfer.setData("text/zine-path", node.path);
        e.dataTransfer.setData("text/plain", `zine-path:${node.path}`);
        onDragStart(node);
      }}
      onContextMenu={(e) => onContextMenuRow(e, node)}
      onClick={(e) => {
        // Don't open the file while its name is being edited. onRowActivate
        // handles plain (select-sole + open) and modifier (cmd/shift) clicks.
        if (!isRenaming) onRowActivate(node, e);
      }}
    >
      <span className="tree-expand-spacer" aria-hidden="true" />
      {node.systemKind === "minted" || node.systemKind === "mint-pending" || isScan(node.path) ? (
        <span
          className="tree-icon-slot tree-system-icon"
          title={
            node.systemKind === "minted"
              ? "Coin"
              : node.systemKind === "mint-pending"
                ? "Incomplete Mint artifact"
                : "Scanned file"
          }
          aria-hidden="true"
        >
          {node.systemKind === "minted" ? (
            <CircleDollarSign size={13} className="tree-icon tree-icon-coin" aria-hidden="true" />
          ) : node.systemKind === "mint-pending" ? (
            <FileX size={13} className="tree-icon tree-icon-mint-pending" aria-hidden="true" />
          ) : (
            <FileInput size={13} className="tree-icon tree-icon-scan" aria-hidden="true" />
          )}
        </span>
      ) : (
        <button
          type="button"
          className="tree-icon-slot tree-icon-btn"
          data-mount-state={fileMountState}
          aria-pressed={fileIncluded}
          aria-label={
            fileIncluded
              ? `Exclude ${displayName} from context`
              : `Mount ${displayName} for context`
          }
          title={
            fileIncluded
              ? "Exclude file from prompt context"
              : "Mount file, replacing the current prompt context"
          }
          onClick={(e) => {
            e.stopPropagation();
            onSetMountState(
              { kind: "file", path: node.path },
              !fileIncluded,
            );
          }}
        >
          {fileMountState === "shielded" ? (
            <FileX size={13} className={fileIconClass} aria-hidden="true" />
          ) : (
            <FileText size={13} className={fileIconClass} aria-hidden="true" />
          )}
        </button>
      )}
      {isRenaming ? (
        <input
          ref={renameInputRef}
          className={"create-input" + (renameError ? " invalid" : "")}
          type="text"
          autoCapitalize="off"
          autoComplete="off"
          spellCheck={false}
          value={renameDraft}
          placeholder="file name…"
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => onRenameChange(e.target.value)}
          onKeyDown={onRenameKey}
          onBlur={() => {
            if (!renameDraft.trim() && !renameError) onRenameCancel();
            else if (renameDraft.trim()) onRenameCommit();
            else onRenameCancel();
          }}
          aria-invalid={!!renameError}
        />
      ) : (
        <span className="tree-name">{displayName}</span>
      )}
      {isRenaming && renameError && <p className="create-error">{renameError}</p>}
    </div>
  );
}

function Sidebar({
  tree,
  collapsed,
  onToggleFolder,
  focusedTabPath,
  selectedItems,
  onSelectionChange,
  scopes,
  shielded,
  onSetMountState,
  onActivateFile,
  onActivateCoin,
  onActivateOblivion,
  onActivateFolder,
  onOpenFolder,
  onMintCoin,
  coinsEnabled,
  onScan,
  onReify,
  onStepFolder,
  creating,
  createError,
  onCreateStart,
  onCreateCommit,
  onCreateCancel,
  filePaths,
  folderPaths,
  onMove,
  onDelete,
  onRevoke,
  onRename,
  samplerOpen,
  onToggleSampler,
  sampler,
  tagBrowserOpen,
  onToggleTagBrowser,
  tagBrowser,
  folderId,
  onOpenToSide,
  directorySort,
  onDirectorySortChange,
  onOpenOnboarding,
  onOpenFactoryReset,
}: {
  tree: TreeNode[];
  collapsed: Set<string>;
  onToggleFolder: (path: string) => void;
  /** Tree path shown by the active tab in the focused panel, or null when no
   *  tab is active. Drives only the focus marker; it never mutates scope. */
  focusedTabPath: string | null;
  /** Explorer selection. This exact trace union supplies playback. */
  selectedItems: readonly TraceRef[];
  onSelectionChange: (items: TraceRef[]) => void;
  /** The one explicit context mount, owned by App. */
  scopes: ContextMounts;
  /** Shielded traversal boundaries, passed through to each row. */
  shielded: Set<string>;
  onSetMountState: (target: ScopeRef, mounted: boolean) => void;
  /** Open a file into the active panel and make it the active trace. Called on
   *  a plain (non-modifier) click of a file row. */
  onActivateFile: (path: string) => void;
  /** Inspect a Mint entry without opening its file-shaped storage node. */
  onActivateCoin: (path: string) => void;
  /** Inspect an Oblivion file from its explicit context-menu action. */
  onActivateOblivion: (path: string) => void;
  /** Make a folder the active trace (folders aren't editors, so nothing opens).
   *  Called on a plain (non-modifier) click of a folder row. Expand/collapse is
   *  toggled separately by the row's onClick. */
  onActivateFolder: (path: string) => void;
  /** Open a folder tab in the active panel from its context menu. */
  onOpenFolder: (path: string) => void;
  /** Open the direct-Coin composer from the Mint region header. */
  onMintCoin: () => void;
  coinsEnabled: boolean;
  /** Acquire a file or folder from the Scan region header. */
  onScan: (kind: "file" | "folder") => void;
  /** Reify one explicitly chosen tree file or folder to the filesystem. */
  onReify: (target: ScopeRef) => void;
  /** Recursively flush dirty descendants, then append one explicit folder Step. */
  onStepFolder: (path: string) => void;
  creating: Creating | null;
  createError: string | null;
  onCreateStart: (kind: "file" | "folder", parent?: string) => void;
  onCreateCommit: (name: string) => void;
  onCreateCancel: () => void;
  filePaths: Set<string>;
  folderPaths: Set<string>;
  onMove: (srcs: string[], destFolder: string) => void;
  onDelete: (paths: string[]) => void;
  /** Publish a NIP-09 request for one file trace without deleting it locally. */
  onRevoke: (path: string) => Promise<string>;
  onRename: (path: string, newName: string) => string | null;
  samplerOpen: boolean;
  onToggleSampler: () => void;
  sampler: React.ReactNode;
  tagBrowserOpen: boolean;
  onToggleTagBrowser: () => void;
  tagBrowser: React.ReactNode;
  /** Id of the attached folder. A change (switch/detach) clears the tree
   *  multi-selection so it never refers to paths that no longer exist. */
  folderId: string | null;
  /** Open a tree item into a fresh column to the right of the active panel
   *  (the context menu's "Open to side"). A folder opens as a folder tab, a
   *  file as an editor tab; a new column is always spawned. */
  onOpenToSide: (path: string) => void;
  /** One ordering preference shared by Root and every generated region. */
  directorySort: DirectorySortOrder;
  onDirectorySortChange: (order: DirectorySortOrder) => void;
  /** Restart the guided first-trace journey. */
  onOpenOnboarding: () => void;
  /** Open the destructive local-app factory-reset confirmation. */
  onOpenFactoryReset: () => void;
}) {
  // inline rename state. renamingPath is the node being edited; renameDraft is
  // the live input value; renameError keeps the input open on a bad name (same
  // UX as the new-file/new-folder row). Only one rename at a time.
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (renamingPath) {
      const el = renameInputRef.current;
      if (el) {
        el.focus();
        el.select();
      }
    }
  }, [renamingPath]);

  // Inline create draft — the live value of the phantom row's input. Mirrors
  // the rename draft: `creating` (owned by App) holds {kind, parent}; this
  // holds the typed name. On Enter/blur-commit it's passed to onCreateCommit;
  // Escape/empty-blur calls onCreateCancel. A validation error from
  // createCommit surfaces via createError and keeps the input open.
  const [createDraft, setCreateDraft] = useState("");
  const createInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (creating) {
      setCreateDraft("");
      // Focus on next paint so the input is mounted (the phantom row only
      // renders once `creating` is set).
      requestAnimationFrame(() => {
        const el = createInputRef.current;
        if (el) {
          el.focus();
          el.select();
        }
      });
    }
  }, [creating]);

  // Explorer selection is replay state owned by App. The context mount remains a
  // separate state path and only the icon buttons mutate them.
  const [anchorPath, setAnchorPath] = useState<string | null>(null);
  const selectedPaths = useMemo(
    () => new Set(selectedItems.map((item) => item.path)),
    [selectedItems],
  );

  // drag state lives here — the set of source paths being dragged (one or
  // many) and the currently-hovered drop target (a folder path, or "" for root).
  // The ref is the event-time authority: native dragenter/dragover can arrive
  // before dragstart's React state update renders, especially in WKWebView.
  // State exists for source/target paint only; acceptance and drop read the ref.
  const draggingPathsRef = useRef<Set<string>>(new Set());
  const [draggingPaths, setDraggingPaths] = useState<Set<string>>(() => new Set());
  const [dropTargetPath, setDropTargetPath] = useState<string | null>(null);

  // context menu + delete-confirm state. ctxMenu is positioned at the cursor;
  // confirmDelete holds the paths pending a Delete click.
  const [ctxMenu, setCtxMenu] = useState<{
    x: number;
    y: number;
    path: string;
    systemKind?: ActivatableTreeItem["systemKind"];
  } | null>(null);
  const [sortMenuOpen, setSortMenuOpen] = useState(false);
  const sortMenuRef = useRef<HTMLDivElement>(null);
  const [confirmDelete, setConfirmDelete] = useState<{
    paths: string[];
    name: string;
    isFolder: boolean;
    childCount: number;
  } | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState<{ path: string; name: string } | null>(null);
  const [revokeBusy, setRevokeBusy] = useState(false);
  const [revokeMessage, setRevokeMessage] = useState<string | null>(null);
  const [revokeError, setRevokeError] = useState<string | null>(null);

  useEffect(() => {
    if (!sortMenuOpen) return;
    function onPointerDown(e: MouseEvent) {
      if (!sortMenuRef.current?.contains(e.target as Node)) setSortMenuOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setSortMenuOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [sortMenuOpen]);

  // App clears the replay/tree selection when the attached folder changes;
  // the Sidebar only owns the range-selection anchor.
  const folderIdRef = useRef(folderId);
  useEffect(() => {
    if (folderIdRef.current !== folderId) {
      folderIdRef.current = folderId;
      setAnchorPath(null);
    }
  }, [folderId]);

  // A flat, ordered list of the currently-visible tree items (files + folders,
  // depth-first in display order). Shift-click ranges are computed over this so
  // collapsed subtrees are skipped, matching what the user sees.
  const visibleItems = useMemo(() => {
    const out: TraceRef[] = [];
    const walk = (nodes: TreeNode[]) => {
      for (const n of nodes) {
        out.push({ kind: n.type, path: n.path });
        if (n.type === "folder" && !collapsed.has(n.path) && n.children) walk(n.children);
      }
    };
    walk(tree);
    return out;
  }, [tree, collapsed]);

  // The folder the New file / New folder root-row buttons should create into:
  // the active trace's folder if it's a folder, else the parent of the active
  // file (a top-level file → root). Falls back to root when nothing is active.
  // Mirrors how a file explorer scopes "new" to the currently-focused location.
  function createParent(): string {
    // Prefer the sole selected folder: clicking a New button after selecting a
    // folder should nest inside it, regardless of which tab the focused panel
    // is showing. `focusedTabPath` follows open tabs, while row selection is
    // local to the explorer. Falls back to focused-panel location when there
    // is not exactly one selected folder.
    if (selectedItems.length === 1) {
      const selected = selectedItems[0];
      if (selected.kind === "folder") {
        return selected.path;
      }
    }
    const p = focusedTabPath;
    if (!p) return ROOT;
    if (folderPaths.has(p) || hasChild(filePaths, folderPaths, p)) return p;
    return parentPath(p);
  }

  // Modifier gestures edit the Explorer operation set without moving focus.
  // A plain click clears stale operation selection, then focuses/opens exactly
  // one trace. Context mounting remains exclusive to icon buttons.
  function onRowActivate(item: ActivatableTreeItem, e: React.MouseEvent) {
    if (!e.metaKey && !e.ctrlKey && !e.shiftKey) {
      onSelectionChange([]);
      setAnchorPath(null);
      activateTreeItem(item, {
        file: onActivateFile,
        folder: onActivateFolder,
        coin: onActivateCoin,
      });
      return;
    }
    const result = applyScopeClick(
      selectedItems,
      { kind: item.type, path: item.path },
      visibleItems,
      anchorPath,
      { additive: e.metaKey || e.ctrlKey, range: e.shiftKey },
    );
    onSelectionChange(result.scopes);
    setAnchorPath(result.anchorPath);
  }

  useEffect(() => {
    function clearOperationSelection(e: KeyboardEvent) {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const target = e.target as HTMLElement | null;
      if (
        target?.matches("input, textarea, select") ||
        target?.isContentEditable
      ) return;
      onSelectionChange([]);
      setAnchorPath(null);
    }
    document.addEventListener("keydown", clearOperationSelection);
    return () => document.removeEventListener("keydown", clearOperationSelection);
  }, [onSelectionChange]);

  // dismiss the context menu on any pointer-down outside the menu itself, or
  // on Escape. A single listener covers both the menu and the open-input row.
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ctxMenu) return;
    function onPointerDown(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setCtxMenu(null);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setCtxMenu(null);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [ctxMenu]);

  // Right-click selects only this row unless it already belongs to the current
  // explorer selection, in which case the menu acts on the whole selection.
  function openContextMenu(e: React.MouseEvent, item: ActivatableTreeItem) {
    e.preventDefault();
    e.stopPropagation();
    // Oblivion is a lifecycle boundary, not an actionable directory. Suppress
    // both the native menu and an empty custom popover for its header row.
    if (item.path === OBLIVION) {
      setCtxMenu(null);
      return;
    }
    const actionSelection = selectionForGroupAction(selectedItems, {
      kind: item.type,
      path: item.path,
    });
    if (!selectedPaths.has(item.path)) {
      onSelectionChange(actionSelection);
      setAnchorPath(item.path);
    }
    setCtxMenu({
      x: e.clientX,
      y: e.clientY,
      path: item.path,
      ...(item.systemKind ? { systemKind: item.systemKind } : {}),
    });
  }

  // The paths a Delete should act on: the current selection, pruned of any
  // path nested beneath another selected path (an ancestor carries its
  // descendants, so listing both would double-count).
  function topLevelSelected(): string[] {
    return topLevelSelectedPaths(selectedItems);
  }

  function requestDelete(paths: string[]) {
    setCtxMenu(null);
    // Summarize for the confirm dialog: total descendant count across the
    // selected top-level paths, plus a display name (the first path's).
    let childCount = 0;
    let anyFolder = false;
    for (const path of paths) {
      const isFolder = folderPaths.has(path) || hasChild(filePaths, folderPaths, path);
      if (isFolder) {
        anyFolder = true;
        for (const p of filePaths) if (p.startsWith(path + "/")) childCount++;
        for (const p of folderPaths) if (p.startsWith(path + "/")) childCount++;
      }
    }
    const single = paths.length === 1;
    const name = single ? basename(paths[0]) : `${paths.length} items`;
    setConfirmDelete({ paths, name, isFolder: anyFolder, childCount });
  }

  // Begin an inline rename of `path`. Prefills the input with the current
  // basename; the focus/select effect above selects it for overtype.
  function requestRename(path: string) {
    setCtxMenu(null);
    setRenamingPath(path);
    setRenameDraft(basename(path));
    setRenameError(null);
  }

  function cancelRename() {
    setRenamingPath(null);
    setRenameDraft("");
    setRenameError(null);
  }

  // Commit the rename from the live draft. Returns to the trust boundary
  // (App.renameNode); on a rejection keeps the input open with the error so
  // the user can fix it, exactly like CreateModal's blur-on-error behavior.
  function commitRename() {
    if (!renamingPath) return;
    const name = renameDraft.trim();
    if (!name) {
      cancelRename();
      return;
    }
    const err = onRename(renamingPath, name);
    if (err) {
      setRenameError(err);
      return;
    }
    cancelRename();
  }

  function onRenameKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      commitRename();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancelRename();
    }
  }

  // Inline create handlers — the phantom row's input. Enter/non-empty blur
  // commits the typed draft to the App-level createCommit (which validates and
  // creates on disk); Escape/empty blur cancels. A validation error leaves
  // `creating` set so the input stays open, exactly like the rename flow.
  function commitCreate() {
    const name = createDraft.trim();
    if (name) onCreateCommit(name);
    else onCreateCancel();
  }
  function onCreateKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      commitCreate();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onCreateCancel();
    }
  }

  // Can any of the dragging sources land in `destFolder`? Used to light the
  // drop target and gate preventDefault. A drop is offered as long as at least
  // one source can move there (the drop handler prunes the ones that can't).
  function canDropOn(destFolder: string): boolean {
    const current = draggingPathsRef.current;
    if (current.size === 0) return false;
    if (current.has(destFolder)) return false;
    for (const src of current) {
      if (canDrop(src, destFolder, filePaths, folderPaths)) return true;
    }
    return false;
  }

  function dragEffect(): "copy" | "move" {
    return [...draggingPathsRef.current].some(
      (path) =>
        (isMint(path) && path !== MINT) ||
        (isScan(path) && path !== SCAN),
    )
      ? "copy"
      : "move";
  }

  function clearDrag() {
    const empty = new Set<string>();
    draggingPathsRef.current = empty;
    setDraggingPaths(empty);
    setDropTargetPath(null);
  }

  return (
    <nav className="sidebar">
      <div className="sidebar-directory-tree">
        <div
          className={"tree" + (dropTargetPath === ROOT && canDropOn(ROOT) ? " tree-drop-target" : "")}
          onDragEnter={(e) => {
            if (e.target === e.currentTarget && canDropOn(ROOT)) {
              e.preventDefault();
              setDropTargetPath(ROOT);
            }
          }}
          onDragOver={(e) => {
            // allow dropping onto empty space inside the tree → move to root.
            // child rows stopPropagation on their own drops, so this only fires
            // for the bare container.
            if (e.target === e.currentTarget && canDropOn(ROOT)) {
              e.preventDefault();
              e.dataTransfer.dropEffect = dragEffect();
              setDropTargetPath(ROOT);
            }
          }}
          onDrop={(e) => {
            if (e.target !== e.currentTarget || !canDropOn(ROOT)) return;
            e.preventDefault();
            onMove([...draggingPathsRef.current], ROOT);
            clearDrag();
          }}
          onDragEnd={clearDrag}
        >
          {tree.map((node) => (
            <TreeItem
              key={node.path}
              node={node}
              depth={0}
              collapsed={collapsed}
              onToggleFolder={onToggleFolder}
              focusedTabPath={focusedTabPath}
              selectedPaths={selectedPaths}
              scopes={scopes}
              shielded={shielded}
              onSetMountState={onSetMountState}
              draggingPaths={draggingPaths}
              dropTargetPath={dropTargetPath}
              onDragStart={(item) => {
                const actionSelection = selectionForGroupAction(selectedItems, {
                  kind: item.type,
                  path: item.path,
                });
                // Dragging a selected row drags the selected group; dragging
                // any other row first selects it alone.
                if (!selectedPaths.has(item.path)) {
                  onSelectionChange(actionSelection);
                  setAnchorPath(item.path);
                }
                const nextDragging = new Set(topLevelSelectedPaths(actionSelection));
                draggingPathsRef.current = nextDragging;
                setDraggingPaths(nextDragging);
              }}
              onDragEnterTarget={setDropTargetPath}
              onDragLeaveTarget={(path) => {
                setDropTargetPath((cur) => (cur === path ? null : cur));
              }}
              onDropOn={(destFolder) => {
                onMove([...draggingPathsRef.current], destFolder);
                clearDrag();
              }}
              canDropOn={canDropOn}
              dragEffect={dragEffect}
              onContextMenuRow={openContextMenu}
              renamingPath={renamingPath}
              renameInputRef={renameInputRef}
              renameDraft={renameDraft}
              renameError={renameError}
              onRenameChange={setRenameDraft}
              onRenameKey={onRenameKey}
              onRenameCommit={commitRename}
              onRenameCancel={cancelRename}
              onRowActivate={onRowActivate}
              onCreateStart={(kind) => onCreateStart(kind, createParent())}
              onMintCoin={onMintCoin}
              coinsEnabled={coinsEnabled}
              onScan={onScan}
              creating={creating}
              createDraft={createDraft}
              createError={createError}
              createInputRef={createInputRef}
              onCreateChange={setCreateDraft}
              onCreateKey={onCreateKey}
              onCreateCommit={commitCreate}
              onCreateCancel={onCreateCancel}
            />
          ))}
        </div>
        <div className="sidebar-directory-footer">
          <div ref={sortMenuRef} className="sidebar-sort-control">
            <button
              type="button"
              className={`icon-btn sidebar-sort-btn${sortMenuOpen ? " active" : ""}`}
              title="Sort directory"
              aria-label="Sort directory"
              aria-expanded={sortMenuOpen}
              aria-controls="directory-sort-menu"
              onClick={() => setSortMenuOpen((open) => !open)}
            >
              <ArrowUpDown size={16} aria-hidden="true" />
            </button>
            {sortMenuOpen && (
              <div
                id="directory-sort-menu"
                className="sidebar-sort-menu"
                role="radiogroup"
                aria-label="Directory sort order"
              >
                <span className="sidebar-sort-label">Sort directory</span>
                {DIRECTORY_SORT_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    className="sidebar-sort-option"
                    role="radio"
                    aria-checked={directorySort === option.value}
                    onClick={() => {
                      onDirectorySortChange(option.value);
                      setSortMenuOpen(false);
                    }}
                  >
                    <span aria-hidden="true">
                      {directorySort === option.value ? "●" : "○"}
                    </span>
                    {option.label}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button
            type="button"
            className="icon-btn sidebar-help-btn"
            title="Onboarding"
            aria-label="Open onboarding guide"
            onClick={onOpenOnboarding}
          >
            <CircleHelp size={16} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="icon-btn sidebar-reset-btn"
            title="Factory reset"
            aria-label="Factory reset"
            onClick={onOpenFactoryReset}
          >
            <Radiation size={16} aria-hidden="true" />
          </button>
        </div>
      </div>
      {ctxMenu && (
        <div
          ref={menuRef}
          className="ctx-menu"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
          onContextMenu={(e) => e.preventDefault()}
        >
          {(() => {
            const path = ctxMenu.path;
            const isFolder =
              path === ROOT ||
              isSystemRootPath(path) ||
              folderPaths.has(path) ||
              hasChild(filePaths, folderPaths, path);
            const isCoin = !isFolder && ctxMenu.systemKind === "minted";
            const menu = directoryContextMenuCapabilities(
              path,
              isFolder,
              selectedPaths.size,
            );
            if (!menu.showMenu) return null;

            // Build capability groups first, then insert separators only
            // between non-empty groups. This avoids each item type growing its
            // own subtly different separator and trailing-divider rules.
            const groups: ReactNode[] = [];
            if (menu.openLabel) {
              groups.push(
                <Fragment key="open">
                  <button
                    type="button"
                    className="ctx-menu-item"
                    onClick={() => {
                      setCtxMenu(null);
                      if (isFolder) onOpenFolder(path);
                      else if (isCoin) onActivateCoin(path);
                      else if (isOblivion(path)) onActivateOblivion(path);
                      else onActivateFile(path);
                    }}
                  >
                    {menu.openLabel}
                  </button>
                  {menu.openToSide && (
                    <button
                      type="button"
                      className="ctx-menu-item"
                      onClick={() => {
                        setCtxMenu(null);
                        onOpenToSide(path);
                      }}
                    >
                      Open to side
                    </button>
                  )}
                </Fragment>,
              );
            }

            if (
              menu.newFile ||
              menu.newFolder ||
              menu.mintCoin ||
              menu.scanFolder ||
              menu.scanFile
            ) {
              groups.push(
                <Fragment key="create">
                  {menu.newFile && (
                    <button
                      type="button"
                      className="ctx-menu-item"
                      onClick={() => {
                        setCtxMenu(null);
                        onCreateStart("file", path);
                      }}
                    >
                      New File
                    </button>
                  )}
                  {menu.newFolder && (
                    <button
                      type="button"
                      className="ctx-menu-item"
                      onClick={() => {
                        setCtxMenu(null);
                        onCreateStart("folder", path);
                      }}
                    >
                      New Folder
                    </button>
                  )}
                  {menu.mintCoin && (
                    <button
                      type="button"
                      className="ctx-menu-item"
                      disabled={!coinsEnabled}
                      title={coinsEnabled ? "Mint a direct Coin" : "Enable Coins in Networking to Mint"}
                      onClick={() => {
                        setCtxMenu(null);
                        onMintCoin();
                      }}
                    >
                      Mint New Coin
                    </button>
                  )}
                  {menu.scanFolder && (
                    <button
                      type="button"
                      className="ctx-menu-item"
                      onClick={() => {
                        setCtxMenu(null);
                        onScan("folder");
                      }}
                    >
                      Scan Folder
                    </button>
                  )}
                  {menu.scanFile && (
                    <button
                      type="button"
                      className="ctx-menu-item"
                      onClick={() => {
                        setCtxMenu(null);
                        onScan("file");
                      }}
                    >
                      Scan File
                    </button>
                  )}
                </Fragment>,
              );
            }

            if (menu.reify) {
              groups.push(
                <button
                  key="reify"
                  type="button"
                  className="ctx-menu-item"
                  onClick={() => {
                    setCtxMenu(null);
                    onReify({ kind: isFolder ? "folder" : "file", path });
                  }}
                >
                  Reify…
                </button>,
              );
            }

            if (menu.stepFolder) {
              groups.push(
                <button
                  key="step-folder"
                  type="button"
                  className="ctx-menu-item"
                  onClick={() => {
                    setCtxMenu(null);
                    onStepFolder(path);
                  }}
                >
                  {path === ROOT ? "Step Root" : "Step Folder"}
                </button>,
              );
            }

            const inScan = topLevelSelected().filter(
              (path) => isScan(path) && path !== SCAN,
            );
            const inOblivion = topLevelSelected().filter(
              (p) => isOblivion(p) && p !== OBLIVION,
            );
            if (inScan.length > 0 || inOblivion.length > 0) {
              groups.push(
                <Fragment key="move">
                  {inScan.length > 0 && (
                    <button
                      type="button"
                      className="ctx-menu-item"
                      onClick={() => {
                        setCtxMenu(null);
                        onMove(inScan, ROOT);
                      }}
                    >
                      Adopt into Root{inScan.length > 1 ? ` (${inScan.length})` : ""}
                    </button>
                  )}
                  {inOblivion.length > 0 && (
                    <button
                      type="button"
                      className="ctx-menu-item"
                      onClick={() => {
                        setCtxMenu(null);
                        onMove(inOblivion, ROOT);
                      }}
                    >
                      Restore{inOblivion.length > 1 ? ` (${inOblivion.length})` : ""}
                    </button>
                  )}
                </Fragment>,
              );
            }

            if (menu.rename) {
              groups.push(
                <button
                  key="rename"
                  type="button"
                  className="ctx-menu-item"
                  disabled={menu.renameDisabled}
                  onClick={() => requestRename(path)}
                >
                  Rename
                </button>,
              );
            }

            const canRevoke =
              filePaths.has(path) &&
              isOblivion(path) &&
              topLevelSelected().length === 1;
            if (canRevoke || menu.delete) {
              groups.push(
                <Fragment key="danger">
                  {canRevoke && (
                    <button
                      type="button"
                      className="ctx-menu-item danger"
                      onClick={() => {
                        setCtxMenu(null);
                        setRevokeMessage(null);
                        setRevokeError(null);
                        setConfirmRevoke({ path, name: systemPathDisplayName(path) });
                      }}
                    >
                      Request relay revocation…
                    </button>
                  )}
                  {menu.delete && (
                    <button
                      type="button"
                      className="ctx-menu-item danger"
                      onClick={() => requestDelete(topLevelSelected())}
                    >
                      Delete{selectedPaths.size > 1 ? ` (${selectedPaths.size})` : ""}
                    </button>
                  )}
                </Fragment>,
              );
            }

            return groups.map((group, index) => (
              <Fragment key={index}>
                {index > 0 && <div className="ctx-menu-separator" aria-hidden="true" />}
                {group}
              </Fragment>
            ));
          })()}
        </div>
      )}
      {confirmDelete && (
        <div
          className="confirm-overlay"
          onClick={() => setConfirmDelete(null)}
        >
          <div className="confirm-dialog" onClick={(e) => e.stopPropagation()}>
            <p className="confirm-message">
              {confirmDelete.paths.length > 1
                ? confirmDelete.isFolder
                  ? confirmDelete.childCount > 0
                    ? `Delete ${confirmDelete.paths.length} items (including ${confirmDelete.childCount} item${confirmDelete.childCount === 1 ? "" : "s"} inside selected folders)?`
                    : `Delete ${confirmDelete.paths.length} items?`
                  : `Delete ${confirmDelete.paths.length} items?`
                : confirmDelete.isFolder
                  ? confirmDelete.childCount > 0
                    ? `Delete folder "${confirmDelete.name}" and ${confirmDelete.childCount} item${confirmDelete.childCount === 1 ? "" : "s"} inside it?`
                    : `Delete empty folder "${confirmDelete.name}"?`
                  : `Delete "${confirmDelete.name}"?`} {deleteOutcomeMessage(confirmDelete.paths)}
            </p>
            <div className="confirm-actions">
              <button type="button" className="confirm-cancel" onClick={() => setConfirmDelete(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="confirm-delete"
                onClick={() => {
                  onDelete(confirmDelete.paths);
                  setConfirmDelete(null);
                }}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
      {confirmRevoke && (
        <div
          className="confirm-overlay"
          onClick={() => {
            if (!revokeBusy) setConfirmRevoke(null);
          }}
        >
          <div className="confirm-dialog" onClick={(e) => e.stopPropagation()}>
            <p className="confirm-message">
              Request relay revocation for “{confirmRevoke.name}”? This publishes a NIP-09
              deletion request for Steps signed by your current pen. It does not delete the
              local copy, cannot revoke other voices’ Steps, and relays or caches may retain data.
            </p>
            {revokeMessage && <p className="confirm-message" role="status">{revokeMessage}</p>}
            {revokeError && <p className="create-error" role="alert">{revokeError}</p>}
            <div className="confirm-actions">
              <button
                type="button"
                className="confirm-cancel"
                disabled={revokeBusy}
                onClick={() => setConfirmRevoke(null)}
              >
                {revokeMessage ? "Close" : "Cancel"}
              </button>
              {!revokeMessage && (
                <button
                  type="button"
                  className="confirm-delete"
                  disabled={revokeBusy}
                  onClick={() => {
                    setRevokeBusy(true);
                    setRevokeError(null);
                    void onRevoke(confirmRevoke.path)
                      .then((message) => setRevokeMessage(message))
                      .catch((error) =>
                        setRevokeError(error instanceof Error ? error.message : String(error)),
                      )
                      .finally(() => setRevokeBusy(false));
                  }}
                >
                  {revokeBusy ? "Requesting…" : "Request revocation"}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
      {samplerOpen && <SampleModal onClose={onToggleSampler}>{sampler}</SampleModal>}
      {tagBrowserOpen && (
        <SampleModal title="Browse a tag" onClose={onToggleTagBrowser}>
          {tagBrowser}
        </SampleModal>
      )}
    </nav>
  );
}


// --- sample modal ------------------------------------------------------
//
// The Telescope (Sample relays) button opens this modal instead of expanding
// the SamplerPanel inline under the Collection header, so the listing doesn't
// shift while editing relay URLs. The body is the existing SamplerPanel — no
// logic changes — seated in a compose-style shell (wider, has a close button).
// Driven by the existing `samplerOpen` state. `title` defaults to "Sample
// relays" so the existing call site is unaffected; the tag-browser modal
// passes its own.
function SampleModal({
  children,
  onClose,
  title = "Sample relays",
  wide = false,
}: {
  children: React.ReactNode;
  onClose: () => void;
  title?: string;
  /** Widens the dialog for content that needs more than the default
   *  compose-dialog width (e.g. the Steps modal's side-by-side list+diff). */
  wide?: boolean;
}) {
  // Escape closes, matching CreateModal and the existing confirm dialogs.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return createPortal(
    <div className="compose-overlay sample-modal-overlay" onClick={onClose}>
      <div
        className={"compose-dialog sample-modal" + (wide ? " sample-modal-wide" : "")}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="compose-header sample-modal-header">
          <h2 className="compose-title">{title}</h2>
          <button
            type="button"
            className="compose-close"
            aria-label="Close sample dialog"
            onClick={onClose}
          >
            ×
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}

// --- step snapshot helpers ----------------------------------------------
//
// Every FileTraceNode carries its own full `snapshot` (protocol §Save/step
// triggers) — O(1) read of "content as of any step", no delta replay needed.
// The chronological Steps modal that used these helpers is gone; the
// step-to-step review now happens in Diff mode while scrubbing the stepper.
// stepSnapshot reads a single node's snapshot; stepDescription pulls an LLM
// step's prompt/summary for the replay summary line.

/** Pulls a kind-4290 event's `snapshot` string straight out of its content —
 *  same O(1) read every other provenance display already relies on (see
 *  reconstructFromChain, provenance.ts), just for a single node instead of
 *  replaying a whole chain. */
function stepSnapshot(event: Event): string {
  try {
    const parsed = JSON.parse(event.content) as { snapshot?: string };
    return typeof parsed.snapshot === "string" ? parsed.snapshot : "";
  } catch {
    return "";
  }
}

/** Pulls an LLM step's `prompt` and `summary` out of its content JSON for the
 *  replay summary line. Both are optional (only LLM-action steps carry them;
 *  edit/import steps have neither). Returns whatever is present. */
function stepDescription(event: Event): { prompt?: string; summary?: string } {
  try {
    const parsed = JSON.parse(event.content) as { prompt?: string; summary?: string };
    const out: { prompt?: string; summary?: string } = {};
    if (typeof parsed.prompt === "string" && parsed.prompt.trim()) out.prompt = parsed.prompt.trim();
    if (typeof parsed.summary === "string" && parsed.summary.trim()) out.summary = parsed.summary.trim();
    return out;
  } catch {
    return {};
  }
}

/** Make invisible editor input legible in the compact replay readout. Single
 * key-like characters stay exact; longer transactions get a bounded preview. */
function replayTextLabel(text: string): string {
  if (text === " ") return "Space";
  if (text === "\n") return "Enter";
  if (text === "\t") return "Tab";
  const visible = text.replace(/\r\n?|\n/g, "↵").replace(/\t/g, "⇥");
  const characters = [...visible];
  const preview = characters.slice(0, 24).join("");
  return `“${preview}${characters.length > 24 ? "…" : ""}”`;
}

function replayMutationLabel(
  action: NonNullable<PlayFrame["action"]>,
): string {
  const changes = action.changes;
  const concrete = changes.length === 1
    ? (() => {
        const change = changes[0];
        if (!change) return "Edit";
        if (!change.deleted) {
          const verb = [...change.inserted].length === 1 ? "Type" : "Insert";
          return `${verb} ${replayTextLabel(change.inserted)}`;
        }
        if (!change.inserted) return `Delete ${replayTextLabel(change.deleted)}`;
        return `Replace ${replayTextLabel(change.deleted)} → ${replayTextLabel(change.inserted)}`;
      })()
    : `${action.type === "delete" ? "Delete" : action.type === "insert" ? "Insert" : "Edit"} ${changes.length} ranges`;

  if (action.type === "undo") return `Undo · ${concrete}`;
  if (action.type === "redo") return `Redo · ${concrete}`;
  if (action.type === "snapshot") return `Snapshot · ${concrete}`;
  return concrete;
}

/** Genesis is structural: it is the one chain node without an `e…prev`
 * pointer, independent of whether its initial snapshot was empty or already
 * carried imported content. */
function isReplayGenesis(step: ReplayStep): boolean {
  return !step.event.tags.some(
    (tag) => tag[0] === "e" && tag[3] === "prev",
  );
}

/** One terse line for the replay transport's live action readout. Editor
 * transactions report their exact mutation; the exact frame that makes a
 * checkpoint durable adds the global Step counter. */
function replayActionLabel(
  frame: PlayFrame | undefined,
  step: ReplayStep | undefined,
  latestStepIndex: number,
  rootLabel: string,
  folderReplay: boolean,
): string | undefined {
  let detail: string | undefined;
  if (frame?.kind === "focus" && frame.focus) {
    const path = frame.path || rootLabel;
    const target = frame.focus.selection.kind === "folder" ? `${path}/` : path;
    detail = folderReplay
      ? `${target} · ${frame.focus.op}`
      : frame.focus.op;
  } else if (frame?.reachesStep && step && !step.folder && isReplayGenesis(step)) {
    const genesis = frame.action
      ? `Genesis · ${replayMutationLabel(frame.action)}`
      : "Genesis";
    detail = folderReplay ? `${step.relativePath} · ${genesis}` : genesis;
  } else if (frame?.action && frame.path) {
    const action = replayMutationLabel(frame.action);
    detail = folderReplay ? `${frame.path} · ${action}` : action;
  } else if (step?.folder) {
    if (step.membership) {
      detail = folderReplay
        ? `${step.membership.path} · ${step.membership.type}`
        : step.membership.type;
    } else {
      const path = step.folder.path === ROOT ? rootLabel : step.folder.path;
      const cause = step.meta.folderCheckpoint?.cause;
      const label = cause === "explicit-step"
        ? "Explicit Step"
        : cause === "metadata-change"
          ? "Metadata"
          : cause === "child-advance"
            ? "Child advance"
            : "Genesis";
      detail = folderReplay ? `${path}/ · ${label}` : label;
    }
  } else if (frame?.reachesStep && frame.path) {
    detail = folderReplay ? frame.path : undefined;
  } else if (step) {
    const action = step.meta.action ?? "edit";
    detail = folderReplay ? `${step.relativePath} · ${action}` : action;
  }

  if (!frame?.reachesStep) return detail;
  const marker = `Step ${frame.stepIndex} / ${latestStepIndex}`;
  return detail ? `${marker} · ${detail}` : marker;
}


// --- in-place diff pane --------------------------------------------------
//
// Replaces the editor surface in the panel when the active tab's mode is
// "diff" (the third surface alongside Preview/Markdown). The editor
// (FileEditor) stays mounted underneath — LLM ops, citation chips, and
// Cmd+S step all hold its view ref regardless of which surface is showing —
// this pane is just an absolute overlay that covers it visually. Reuses the
// same jsdiff + steps-diff-add/-remove/-same spans MergePreviewModal uses.
//
// Two modes of operation, selected by whether the replay stepper has frozen
// THIS file on a historical step (replayStepText != null):
//
// LIVE (not frozen) — "what have I changed since I stepped?"
//   • vs current (default): head step chain[last] vs the working buffer —
//     uncommitted edits since your last step.
//   • vs prev: chain[last−1] vs the working buffer — everything since the prior
//     step. Null at genesis → empty state.
//
// REPLAY (frozen on step #N) — "what did THIS step change?" This is the
// step-to-step review path that replaces the old chronological Steps modal:
// scope the file, scrub the stepper, and read each step's delta here. The
// replay panel receives step #N's snapshot without touching `files`; the live
// buffer is passed separately via replayLiveText.
//   • vs prev (default): the previous content-step of this file vs step #N —
//     the delta THIS step introduced.
//   • vs live: the live buffer (replayLiveText) vs step #N — how the live doc
//     has drifted from this checkpoint.
// The chain fetch is skipped entirely in replay mode (both sides are known).
function DiffPane({
  file,
  path,
  folderId,
  replayStepText,
  replayPrevText,
  replayLiveText,
  header,
  footer,
}: {
  file: FileState;
  path: string;
  folderId: string;
  /** The frozen replay step's content snapshot, or null when the stepper isn't
   *  frozen on this file. Presence selects replay mode. */
  replayStepText?: string | null;
  /** In replay mode, the previous content-step of this file (vs prev). Null at
   *  this file's genesis. Unused in live mode. */
  replayPrevText?: string | null;
  /** In replay mode, the live working buffer (vs live). Unused in live mode. */
  replayLiveText?: string | null;
  /** Scroll-native mode + outgoing-citation row. */
  header?: ReactNode;
  /** Incoming citations, encountered after the diff body. */
  footer?: ReactNode;
}) {
  const frozen = replayStepText != null;
  const workingText = flatten(file.runs ?? []);
  // The two stepped snapshots to diff against. Fetched on head/path change; null
  // while loading or when the chain is too short to have that comparison.
  const [headText, setHeadText] = useState<string | null>(null);
  const [prevText, setPrevText] = useState<string | null>(null);
  const [diffMode, setDiffMode] = useState<"current" | "prev">("current");

  useEffect(() => {
    // Replay mode knows both sides already — skip the fetch entirely.
    if (frozen) return;
    let cancelled = false;
    if (!folderId || !path) return;
    setHeadText(null);
    setPrevText(null);
    fetchChain(folderId, path).then((chain) => {
      if (cancelled) return;
      if (chain.length > 0) {
        setHeadText(stepSnapshot(chain[chain.length - 1]));
        setPrevText(chain.length >= 2 ? stepSnapshot(chain[chain.length - 2]) : null);
      } else {
        setHeadText(null);
        setPrevText(null);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [folderId, path, file.nodeId, frozen]);

  // Right side of the diff (the "as it is now" text). Replay → frozen step;
  // live → working buffer.
  const rightText = frozen ? replayStepText! : workingText;
  // Left side per toggle. Replay maps "current"→live buffer, "prev"→previous
  // same-file step; live maps "current"→head, "prev"→prev step.
  const diffTarget = frozen
    ? diffMode === "current"
      ? replayLiveText ?? null
      : replayPrevText ?? null
    : diffMode === "current"
      ? headText
      : prevText;
  const diffParts = useMemo(
    () => (diffTarget != null ? diffLines(diffTarget, rightText) : null),
    [diffTarget, rightText],
  );
  const isEmpty =
    diffParts !== null &&
    diffParts.length > 0 &&
    diffParts.every((p) => !p.added && !p.removed);

  // "current" relabels to "vs live" in replay mode so it names the real
  // comparison (the head isn't the right side when frozen on a step).
  const currentLabel = frozen ? "vs live" : "vs current";

  return (
    <div className="panel-diff-pane">
      {header}
      <div className="panel-diff-controls">
        <div className="steps-diff-toggle" role="group" aria-label="Diff against">
          <button
            type="button"
            className={"steps-diff-btn" + (diffMode === "current" ? " active" : "")}
            onClick={() => setDiffMode("current")}
          >
            {currentLabel}
          </button>
          <button
            type="button"
            className={"steps-diff-btn" + (diffMode === "prev" ? " active" : "")}
            onClick={() => setDiffMode("prev")}
          >
            vs prev
          </button>
        </div>
      </div>
      {diffTarget === null ? (
        <p className="panel-diff-empty">
          {diffMode === "prev"
            ? "No prior step to diff against."
            : "Not yet stepped — nothing to diff."}
        </p>
      ) : isEmpty ? (
        <p className="panel-diff-empty">No changes since last step.</p>
      ) : (
        <pre className="panel-diff">
          {diffParts!.map((part, i) => (
            <span
              key={i}
              className={part.added ? "steps-diff-add" : part.removed ? "steps-diff-remove" : "steps-diff-same"}
            >
              {part.value}
            </span>
          ))}
        </pre>
      )}
      {footer}
    </div>
  );
}

// --- operator setup modal ------------------------------------------------
//
// Shown on webapp boot when /operator/state reports no bound operator, and
// re-openable from the operator panel to rotate the bound key. The browser
// signs with its AUTHOR key — never typed or pasted — and the bootstrap
// token authorizes the relay to trust that pubkey. No secret key crosses the
// wire in either direction: only the pubkey goes to /operator/bind.
function OperatorSetupModal({
  mode,
  onClose,
  onBound,
}: {
  /** "boot" = first-run (relay may be unconfigured); "manual" = operator-
   *  triggered re-bind / key rotation. */
  mode: "boot" | "manual";
  onClose: () => void;
  onBound: (st: OperatorState) => void;
}) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isBoot = mode === "boot";
  const title = isBoot ? "Set up this press" : "Rotate operator key";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const st = await bindOperator(token);
      onBound(st);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("503") || msg.toLowerCase().includes("not configured")) {
        setError("This relay hasn't enabled an operator. Ask whoever runs it to set a bootstrap token.");
      } else if (msg.includes("401") || msg.toLowerCase().includes("invalid token")) {
        setError("That token wasn't accepted. Check it with whoever runs this relay.");
      } else {
        setError(msg);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <SampleModal title={title} onClose={onClose}>
      <form className="operator-setup" onSubmit={submit}>
        <p className="operator-setup-lede">
          {isBoot
            ? "No one has claimed this press yet. If you run it, enter the bootstrap token to bind your browser's key as the operator."
            : "Re-bind a new browser key as the operator. Enter the bootstrap token (the relay operator set it in the environment)."}
        </p>
        <label className="operator-setup-label" htmlFor="operator-token">
          Bootstrap token
        </label>
        <input
          id="operator-token"
          className="operator-setup-input"
          type="password"
          value={token}
          autoFocus
          autoComplete="off"
          placeholder="openssl rand -hex 32 …"
          onChange={(e) => setToken(e.target.value)}
        />
        <p className="operator-setup-hint">
          Your browser generates and holds the signing key — you never type it. The token only tells the relay to
          trust this browser's key as the operator.
        </p>
        {error && <p className="operator-setup-error">{error}</p>}
        <div className="operator-setup-actions">
          {isBoot && (
            <button type="button" className="confirm-cancel" onClick={onClose}>
              Skip
            </button>
          )}
          <button type="submit" className="confirm-delete" disabled={busy || !token.trim()}>
            {busy ? "Binding…" : isBoot ? "Bind this browser" : "Re-bind"}
          </button>
        </div>
      </form>
    </SampleModal>
  );
}

// --- folder-wide replay transport --------------------------------------
//
// Always-visible transport in the action palette's last row (no "Replay
// folder" gate):
//   TRACE/REPLAY: | selected traces | ⏮ · N× · ▶/⏸ · n/latest · ⏭ · [slider]
// Position 0 is the trace's real genesis node; every appended node increments
// the displayed Step. The live working document is never a pseudo-position.
// Manual seeks and Play share one persistent,
// read-only replay panel. While the selected trace resolves, a spinner replaces ▶.
// Once resolution finishes, ▶ is clickable even when Genesis is the trace's
// only node; the Step controls operate on the real node count.
//
// Step ticks, KEdit playback, thumb, activity bubbles, and idle bands all use
// one playback-time axis. Each recorded action is a bubble; actions at most
// five seconds apart merge into one burst. At 1× elapsed time remains literal.
// Idle gaps over 20 seconds play at 100×, occupy 1/100 of their recorded
// width, and announce their exact duration.

/** Pick the nearest real Step tick to a pointer fraction. Last wins on ties so
 *  dragging right monotonically advances. */
function fractionToStep(stepFractions: number[], f: number): number {
  const n = stepFractions.length;
  if (n < 2) return 0;
  const clamped = Math.max(0, Math.min(1, f));
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < n; i++) {
    const d = Math.abs(stepFractions[i] - clamped);
    if (d <= bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}

/** Position real Step ticks on the same playback-time axis as KEdit playback. */
function stepAxis(
  stepTimes: number[] | undefined,
  count: number,
  timing: ReplayTiming | null,
): (displayedStep: number) => number {
  if (stepTimes && stepTimes.length === count && count > 0) {
    if (timing) {
      return (displayedStep: number) =>
        replayTimeFraction(timing, stepTimes[Math.max(0, displayedStep)] ?? timing.startAt);
    }
    const start = stepTimes[0];
    const end = stepTimes[stepTimes.length - 1];
    const span = end - start;
    if (span > 0) {
      return (displayedStep: number) =>
        Math.max(0, Math.min(1, ((stepTimes[displayedStep] ?? start) - start) / span));
    }
  }
  return (displayedStep: number) =>
    count > 1 ? displayedStep / (count - 1) : 0;
}

const TRACE_ROW_LABEL_KEY = "zine.traceRowLabel";
const TRACE_ROW_LABELS = ["TRACE", "REPLAY", "ZINE"] as const;
type TraceRowLabel = (typeof TRACE_ROW_LABELS)[number];
function nextTraceRowLabel(current: TraceRowLabel): TraceRowLabel {
  const index = TRACE_ROW_LABELS.indexOf(current);
  return TRACE_ROW_LABELS[(index + 1) % TRACE_ROW_LABELS.length];
}

function ReplayTransport({
  targets,
  index,
  count,
  ready,
  playing,
  playSpeed,
  onBegin,
  onStep,
  onAction,
  onSeekAt,
  onTogglePlay,
  onCycleSpeed,
  containerTitle,
  stepTimes,
  actionTimes,
  actionIndex,
  timing,
  playheadAt,
  loading,
  latestActionOutput,
  conformance,
}: {
  /** The one focused tree/tab trace that supplies this timeline. */
  targets: readonly {
    kind: TraceRef["kind"];
    path: string;
    label: string;
    title: string;
  }[];
  index: number;
  count: number;
  /** Mounted traces have resolved. This is intentionally independent of the
   *  number of post-genesis Steps: Genesis alone is playable. */
  ready: boolean;
  /** Whether the auto-play timer is advancing. */
  playing: boolean;
  /** Current play speed multiplier. */
  playSpeed: number;
  /** Bootstrap replay (async fetch of the folder's steps). Called by ▶ when no
   *  timeline is loaded yet. */
  onBegin: () => void;
  /** Seek replay to displayed Step `n` (0…count - 1). */
  onStep: (n: number) => void;
  /** Seek replay to exact recorded action `n`, including same-time actions. */
  onAction: (n: number) => void;
  /** Seek replay to the last recorded action at or before wall-clock `at`. */
  onSeekAt: (at: number) => void;
  /** Toggle auto-play on/off. Starts at the current step; reaching last stops. */
  onTogglePlay: () => void;
  /** Advance to the next speed (wraps). */
  onCycleSpeed: () => void;
  /** Hover context for the whole block: the current step's action/file/time/(blurb).
   *  Lets the condensed layout still say where you are without a summary line. */
  containerTitle?: string;
  /** steppedAtMs per step, in step order. Drives the playback-time axis. */
  stepTimes?: number[];
  /** Timestamp of every replayable action. The track scrubs this cursor while
   * the separate Step controls continue to navigate saved checkpoints. */
  actionTimes?: number[];
  actionIndex: number;
  /** Shared KEdit/checkpoint axis with accelerated idle gaps compressed. */
  timing: ReplayTiming | null;
  /** Timestamp of the exact action currently rendered in the replay panels. */
  playheadAt?: number;
  /** True while an empty transport is fetching its first playable timeline. */
  loading: boolean;
  /** Current replay action or fast-forward notice, shown after the slider. */
  latestActionOutput?: string;
  /** Persistent reader verdict for every file chain in this replay scope. */
  conformance?: TraceConformanceVerdict | null;
}) {
  const [rowLabel, setRowLabel] = useState<TraceRowLabel>(() => {
    const stored = localStorage.getItem(TRACE_ROW_LABEL_KEY);
    return TRACE_ROW_LABELS.includes(stored as TraceRowLabel)
      ? (stored as TraceRowLabel)
      : "TRACE";
  });
  const hasActions = !!actionTimes && actionTimes.length > 0;
  const hasTimeline = count > 0 || hasActions;
  const hasFocus = targets.length > 0;
  const targetLabel = hasFocus
    ? targets.map((target) => target.label).join(", ")
    : "no trace focused";
  const targetTitle = targets.map((target) => target.title).join("");
  const latest = Math.max(0, count - 1);
  const first = index <= 0;
  const last = index >= latest;
  // The custom slider is positioned by replay time (stepAxis), not by index.
  // A native <input type="range"> can't map its thumb to anything but linear-
  // in-value, so this is a div + pointer/keyboard handler replicating the
  // native contract (drag, arrows, Home/End, a11y). The track snaps to actions;
  // the buttons below remain save-point controls.
  const tf = stepAxis(stepTimes, count, timing);
  const actionAxis = stepAxis(actionTimes, actionTimes?.length ?? 0, timing);
  const clampStep = (n: number) => Math.max(0, Math.min(latest, n));
  const latestAction = Math.max(0, (actionTimes?.length ?? 1) - 1);
  const currentAction = Math.max(0, Math.min(latestAction, actionIndex));
  const exactThumbFraction =
    timing && playheadAt !== undefined
      ? replayTimeFraction(timing, playheadAt)
      : tf(index);
  const nextActionAt = actionTimes?.[currentAction + 1];
  const thumbTransition =
    playing &&
    timing &&
    playheadAt !== undefined &&
    nextActionAt !== undefined &&
    nextActionAt > playheadAt
      ? replayTransition(
          playheadAt,
          nextActionAt,
          playSpeed,
          timing.idleThresholdMs,
        )
      : null;
  const thumbAdvancing = !!thumbTransition && thumbTransition.delayMs > 0;
  const thumbStyle = {
    left: `${exactThumbFraction * 100}%`,
    ...(thumbAdvancing && timing && nextActionAt !== undefined
      ? {
          "--replay-thumb-from": `${exactThumbFraction * 100}%`,
          "--replay-thumb-to": `${replayTimeFraction(timing, nextActionAt) * 100}%`,
          "--replay-thumb-duration": `${thumbTransition.delayMs}ms`,
        }
      : {}),
  } as CSSProperties;
  const seekAction = (n: number) => {
    if (!actionTimes || actionTimes.length === 0) return false;
    onAction(Math.max(0, Math.min(latestAction, n)));
    return true;
  };
  const seekFromClientX = (clientX: number, el: HTMLElement) => {
    const rect = el.getBoundingClientRect();
    const f = rect.width > 0 ? (clientX - rect.left) / rect.width : 0;
    if (actionTimes && actionTimes.length > 0) {
      const positions = Array.from(
        { length: actionTimes.length },
        (_, i) => actionAxis(i),
      );
      seekAction(fractionToStep(positions, f));
      return;
    }
    if (stepTimes && stepTimes.length === count) {
      const positions = Array.from({ length: count }, (_, i) => tf(i));
      onStep(fractionToStep(positions, f));
    } else {
      onStep(clampStep(Math.round(f * latest)));
    }
  };
  return (
    <div
      className={"action-palette-group action-palette-replay" + (playing ? " is-playing" : "")}
      role="group"
      aria-label={`Replay timeline for ${targetLabel}`}
      title={containerTitle}
    >
      <button
        type="button"
        className="action-palette-label action-palette-label-clickable"
        title="Click to update label in view; no effect on behavior"
        onClick={() => {
          const next = nextTraceRowLabel(rowLabel);
          localStorage.setItem(TRACE_ROW_LABEL_KEY, next);
          setRowLabel(next);
        }}
      >
        {rowLabel}:
      </button>
      <span
        className="action-palette-replay-targets"
        title={
          hasFocus
            ? `Focused replay trace: ${targetTitle}`
            : "Focus a trace for replay"
        }
      >
        {hasFocus ? (
          targets.map((target) => (
            <span
              key={`${target.kind}:${target.path}`}
              className="action-palette-replay-target"
              title={target.title}
            >
              {target.kind === "folder" ? (
                <FolderOpen size={12} className="tab-status" aria-hidden="true" />
              ) : (
                <FileText size={12} className="tab-status" aria-hidden="true" />
              )}
              <span className="action-palette-replay-target-label">{target.label}</span>
            </span>
          ))
        ) : (
          <span className="action-palette-replay-target-empty">Select traces</span>
        )}
      </span>
      <div className="action-palette-replay-controls">
        <div className="action-palette-replay-transport">
          {loading ? (
            <span
              className="action-palette-replay-loading"
              role="status"
              aria-label="Loading replay"
              title="Loading selected trace"
            >
              <span className="action-palette-replay-spinner" aria-hidden="true" />
            </span>
          ) : (
            <button
              type="button"
              className="steps-step-btn action-palette-replay-play"
              disabled={!hasFocus}
              onClick={() => (ready ? onTogglePlay() : onBegin())}
              title={
                !hasFocus
                  ? "Focus a trace for replay"
                  : playing
                  ? "Pause playback"
                  : ready
                    ? "Play the focused trace from Genesis"
                    : "Load the focused trace and play"
              }
            >
              {playing ? "⏸" : "▶"}
            </button>
          )}
          <button
            type="button"
            className="action-palette-replay-speed"
            onClick={onCycleSpeed}
            title="Cycle playback speed"
          >
            {playSpeed}×
          </button>
          <button
            type="button"
            className="steps-step-btn action-palette-replay-previous"
            disabled={!hasTimeline || first}
            onClick={() => onStep(index - 1)}
            title="Previous Step marker"
            aria-label="Previous Step"
          >
            ⏮
          </button>
          <button
            type="button"
            className="steps-step-btn action-palette-replay-next"
            disabled={!hasTimeline || last}
            onClick={() => onStep(index + 1)}
            title="Next Step marker"
            aria-label="Next Step"
          >
            ⏭
          </button>
          <span className="steps-position" title="Save point position in the folder timeline">
            {count > 0 ? `${index} / ${latest}` : "— / —"}
          </span>
          <div
            // Custom time-proportional slider. role=slider + aria-valu* gives
            // screen readers the same contract the old <input type="range"> had.
            // onPointerDown both seeks-and-begins-drag. Pointer capture keeps the
            // drag tracking outside the element without changing play/pause state.
            className="action-palette-replay-track"
            role="slider"
            aria-label="Replay position"
            aria-valuemin={0}
            aria-valuemax={hasActions ? latestAction : latest}
            aria-valuenow={hasActions ? currentAction : Math.max(0, index)}
            aria-valuetext={
              hasActions
                ? `Action ${currentAction + 1} of ${actionTimes.length}`
                : `Step ${index} of ${latest}`
            }
            aria-disabled={!hasTimeline}
            tabIndex={hasTimeline ? 0 : -1}
            onPointerDown={(e) => {
              if (!hasTimeline) return;
              (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
              const target = e.target instanceof Element ? e.target : null;
              const stepTick = target?.closest<HTMLElement>(
                ".action-palette-replay-tick",
              );
              if (stepTick) {
                onStep(Number(stepTick.dataset.stepIndex));
              } else if (!target?.closest(".action-palette-replay-activity-bubble")) {
                seekFromClientX(e.clientX, e.currentTarget);
              }
            }}
            onPointerMove={(e) => {
              // Only treat as a drag while the pointer is held (buttons pressed).
              if (e.buttons === 0) return;
              if (!hasTimeline) return;
              seekFromClientX(e.clientX, e.currentTarget);
            }}
            onPointerUp={(e) => {
              if (e.currentTarget.hasPointerCapture(e.pointerId)) {
                e.currentTarget.releasePointerCapture(e.pointerId);
              }
            }}
            onKeyDown={(e) => {
              if (!hasTimeline) return;
              switch (e.key) {
                case "ArrowRight":
                case "ArrowUp":
                  e.preventDefault();
                  if (!seekAction(currentAction + 1)) onStep(index + 1);
                  break;
                case "ArrowLeft":
                case "ArrowDown":
                  e.preventDefault();
                  if (!seekAction(currentAction - 1)) onStep(index - 1);
                  break;
                case "Home":
                  e.preventDefault();
                  if (!seekAction(0)) onStep(0);
                  break;
                case "End":
                  e.preventDefault();
                  if (!seekAction(latestAction)) onStep(latest);
                  break;
              }
            }}
          >
          {/* Track rule: the 3px baseline the ticks/thumb sit on. */}
          <span className="action-palette-replay-rule" aria-hidden="true" />
          {/* Accelerated inactivity is a muted hatched rail rather than an
              activity capsule. A CSS minimum keeps heavily compressed gaps
              visible without changing their time-axis coordinates. */}
          {(timing?.gaps ?? []).map((gap) => {
            const left = timing ? replayTimeFraction(timing, gap.startAt) : 0;
            const right = timing ? replayTimeFraction(timing, gap.endAt) : left;
            return (
              <span
                key={`${gap.startAt}:${gap.endAt}`}
                className="action-palette-replay-idle-band"
                style={{ left: `${left * 100}%`, width: `${(right - left) * 100}%` }}
                aria-hidden="true"
                title={`${formatReplayDuration(gap.durationMs)} inactive · fast-forwarded at 100×`}
              />
            );
          })}
          {/* Every replay action contributes one bubble. Adjacent bubbles
              merge when their timestamps are at most five seconds apart. */}
          {(timing?.activity ?? []).map((activity) => {
            const left = timing ? replayTimeFraction(timing, activity.startAt) : 0;
            const right = timing ? replayTimeFraction(timing, activity.endAt) : left;
            const isPoint = right <= left;
            const deltaLabel = `${activity.actionCount} ${
              activity.actionCount === 1 ? "delta" : "deltas"
            }`;
            const durationLabel = activity.durationMs <= 0
              ? ""
              : activity.durationMs < 1_000
                ? " over <1s"
                : ` over ${formatReplayDuration(activity.durationMs)}`;
            return (
              <button
                key={`${activity.startAt}:${activity.endAt}:${activity.actionCount}`}
                type="button"
                className={
                  "action-palette-replay-activity-bubble" +
                  (isPoint ? " is-point" : "")
                }
                style={
                  isPoint
                    ? { left: `${left * 100}%` }
                    : { left: `${left * 100}%`, width: `${(right - left) * 100}%` }
                }
                // A click seeks to the opening action. The event then bubbles to
                // the track so a drag can capture the pointer and continue.
                onPointerDown={() => {
                  onSeekAt(activity.startAt);
                }}
                aria-hidden="true"
                tabIndex={-1}
                title={`${deltaLabel}${durationLabel} · jump to burst start at ${new Date(activity.startAt).toLocaleString()}`}
              />
            );
          })}
          {/* Position ticks: exactly one per real saved Step. Each centered line
              has a wider, full-track-height pointer target for an exact seek. */}
          {count > 0 && (
            <div className="action-palette-replay-ticks" aria-hidden="true">
              {Array.from({ length: count }, (_, i) => (
                <span
                  key={i}
                  className="action-palette-replay-tick"
                  data-step-index={i}
                  style={{ left: `${tf(i) * 100}%` }}
                />
              ))}
            </div>
          )}
          {/* Thumb: panel content still changes only at real recorded actions,
              but the marker traverses the elapsed playback time between them. */}
          {count > 0 && (
            <span
              key={
                thumbAdvancing
                  ? `playing:${currentAction}:${playheadAt}:${nextActionAt}:${playSpeed}`
                  : `still:${playheadAt ?? index}`
              }
              className={
                "action-palette-replay-thumb" +
                (thumbAdvancing ? " is-advancing" : "")
              }
              aria-hidden="true"
              style={thumbStyle}
            />
          )}
          </div>
          <span
            className="action-palette-replay-status"
            title={[
              conformance ? traceConformanceLabel(conformance.status) : "",
              ...(conformance?.issues.map((issue) => issue.message) ?? []),
              latestActionOutput ?? "",
            ].filter(Boolean).join(" · ")}
            aria-live="polite"
            aria-atomic="true"
          >
            {conformance ? (
              <span
                className={`trace-conformance-badge is-${conformance.status}`}
              >
                {traceConformanceLabel(conformance.status)}
              </span>
            ) : null}
            {latestActionOutput ? (
              <span
                className={
                  "action-palette-replay-status-pulse" +
                  (latestActionOutput.startsWith("Step ") ? " is-step" : "")
                }
              >
                {latestActionOutput}
              </span>
            ) : null}
          </span>
        </div>
      </div>
    </div>
  );
}

// Telescope icon). Fans a Nostr filter out to a set of relays and writes the
// deduped results into samples/ as files — see App.runSample. Lives in the
// sidebar; the App owns the state and handler so they can touch files/panels.
function SamplerPanel({
  urls,
  onUrlsChange,
  kinds,
  onKindsChange,
  limit,
  onLimitChange,
  since,
  onSinceChange,
  until,
  onUntilChange,
  search,
  onSearchChange,
  status,
  onSample,
  scope,
}: {
  urls: string;
  onUrlsChange: (v: string) => void;
  // Comma-separated kind integers, e.g. "4290, 1, 30023". Parsed in runSample.
  kinds: string;
  onKindsChange: (v: string) => void;
  limit: number;
  onLimitChange: (n: number) => void;
  // datetime-local strings; "" leaves the bound unset on the filter.
  since: string;
  onSinceChange: (v: string) => void;
  until: string;
  onUntilChange: (v: string) => void;
  // Free-text NIP-50 search; "" omits it from the filter.
  search: string;
  onSearchChange: (v: string) => void;
  status: { state: "idle" | "sampling" | "done" | "error"; msg?: string; count?: number };
  onSample: () => void;
  /** Where sampled files will land. "" or undefined = root. Shown as a banner
   *  so a scoped sample (opened from a folder tab) makes its target visible. */
  scope?: string;
}) {
  const busy = status.state === "sampling";
  let statusText = "";
  if (status.state === "sampling") statusText = "sampling…";
  else if (status.state === "done")
    statusText = `imported ${status.count ?? 0} file${(status.count ?? 0) === 1 ? "" : "s"}${status.msg ? ` · ${status.msg}` : ""}`;
  else if (status.state === "error") statusText = status.msg ?? "error";

  return (
    <div className="sampler-panel">
      {scope && (
        <p className="sampler-scope">
          Sampling into <strong>{scope}/</strong>
        </p>
      )}
      <textarea
        className="sampler-urls"
        value={urls}
        onChange={(e) => onUrlsChange(e.target.value)}
        placeholder={"one relay URL per line\nws://…\nwss://…"}
        rows={4}
        spellCheck={false}
        disabled={busy}
      />
      <div className="sampler-controls">
        <label className="sampler-field sampler-field--grow">
          <span>kinds</span>
          <input
            type="text"
            value={kinds}
            onChange={(e) => onKindsChange(e.target.value)}
            placeholder={"e.g. 4290, 1, 30023"}
            spellCheck={false}
            disabled={busy}
          />
        </label>
        <label className="sampler-field">
          <span>limit</span>
          <input
            type="number"
            value={limit}
            min={1}
            onChange={(e) => onLimitChange(Number(e.target.value))}
            disabled={busy}
          />
        </label>
        <label className="sampler-field sampler-field--grow">
          <span>search</span>
          <input
            type="text"
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder={"optional NIP-50 text"}
            spellCheck={false}
            disabled={busy}
          />
        </label>
        <label className="sampler-field">
          <span>since</span>
          <input
            type="datetime-local"
            value={since}
            onChange={(e) => onSinceChange(e.target.value)}
            disabled={busy}
          />
        </label>
        <label className="sampler-field">
          <span>until</span>
          <input
            type="datetime-local"
            value={until}
            onChange={(e) => onUntilChange(e.target.value)}
            disabled={busy}
          />
        </label>
      </div>
      <button
        type="button"
        className={"run-agent-btn sampler-run" + (busy ? " running" : "")}
        onClick={onSample}
        disabled={busy}
      >
        {busy ? "sampling…" : "sample"}
      </button>
      {statusText && (
        <p className={"sampler-status" + (status.state === "error" ? " error" : "")}>{statusText}</p>
      )}
    </div>
  );
}

// --- tag browser panel ---------------------------------------------------
//
// A tag always names a zine (protocol §Tagging vs. bracketing) — this panel
// is the disambiguate-then-browse flow: type a folderId, resolve every
// current folder-trace head that claims it (one per owner), pick one if more
// than one matched, then run the three-channel union (lexical/content-
// identity/transitive) against the chosen zine. Reuses the same relay list as
// SamplerPanel (one shared "where do I read from" setting) rather than a
// second URL textarea. A distinct panel from SamplerPanel, not an extension
// of it — this is "browse this zine's neighborhood," a different mental model
// from "run an arbitrary NIP-01 filter."
function TagBrowserPanel({
  name,
  onNameChange,
  candidates,
  selected,
  onSelectCandidate,
  status,
  onFind,
}: {
  name: string;
  onNameChange: (v: string) => void;
  candidates: TagCandidate[] | null;
  selected: TagCandidate | null;
  onSelectCandidate: (c: TagCandidate) => void;
  status: { state: "idle" | "resolving" | "browsing" | "done" | "error"; msg?: string; count?: number };
  onFind: () => void;
}) {
  const busy = status.state === "resolving" || status.state === "browsing";
  let statusText = "";
  if (status.state === "resolving") statusText = "finding zines…";
  else if (status.state === "browsing") statusText = "browsing…";
  else if (status.state === "done")
    statusText = `imported ${status.count ?? 0} file${(status.count ?? 0) === 1 ? "" : "s"}${status.msg ? ` · ${status.msg}` : ""}`;
  else if (status.state === "error") statusText = status.msg ?? "error";

  return (
    <div className="sampler-panel">
      <div className="sampler-controls">
        <label className="sampler-field sampler-field--grow">
          <span>tag name</span>
          <input
            type="text"
            value={name}
            onChange={(e) => onNameChange(e.target.value)}
            placeholder={"the zine's folderId"}
            spellCheck={false}
            disabled={busy}
            onKeyDown={(e) => {
              if (e.key === "Enter") onFind();
            }}
          />
        </label>
      </div>
      <button
        type="button"
        className={"run-agent-btn sampler-run" + (busy ? " running" : "")}
        onClick={onFind}
        disabled={busy || !name.trim()}
      >
        {busy ? "working…" : "find"}
      </button>
      {candidates && candidates.length > 1 && (
        <div className="sampler-controls" style={{ flexDirection: "column", alignItems: "stretch" }}>
          <span>more than one zine claims this name — pick one:</span>
          {candidates.map((c) => (
            <button
              key={c.ownerPubkey}
              type="button"
              className={"ctx-menu-item" + (selected?.ownerPubkey === c.ownerPubkey ? " active" : "")}
              onClick={() => onSelectCandidate(c)}
            >
              {c.ownerPubkey.slice(0, 12)}… · {c.memberCount} member{c.memberCount === 1 ? "" : "s"}
            </button>
          ))}
        </div>
      )}
      {statusText && (
        <p className={"sampler-status" + (status.state === "error" ? " error" : "")}>{statusText}</p>
      )}
    </div>
  );
}

// --- icons -------------------------------------------------------------
//
// All UI icons come from lucide-react (uniform 1.5px stroke, 24×24, rounded
// caps), so the rail, the file tree, and the toggles read as one family.
// They render with currentColor, so hover/active states own hue via CSS.

// The brand glyph: the 👁️‍🗨️ emoji (eye in speech bubble), the app's mark.
// Used at the top of the rail and also as the About entry point.
const EYE_SPEECH = "👁️\u200d🗨️";

// --- editor (CodeMirror 6) --------------------------------------------
//
// Why CM6 and not a controlled contentEditable: the old editor re-rendered
// the DOM from `runs` on every keystroke and manually restored the caret,
// which drifted across voice-span (text-node) boundaries and made the caret
// jump. CM owns the document; React only seeds it on external changes
// (agent wrote the file, the file switched). The voice model lives in a
// StateField rendered as Decorations, so it never fights the doc.
//
// Each user transaction also maps cleanly onto the protocol's delta shape
// (trace-provenance.md): from===to → insert, inserted==="" → delete, else
// replace, stamped with its own Date.now() ms — the in-app-editor case the
// spec was written for. Publishing those deltas to the relay is the next
// task; this editor produces the right substrate.

// The voice new text is attributed to — resolved to the keychain's AUTHOR key
// pubkey at edit time (see keys-store.ts), so switching the AUTHOR key in the
// ActionPalette changes who subsequent edits are attributed to without a reload.
// Resolve live at each call site rather than capturing once at module load (a
// module-level const would freeze
// the attribution to whatever key was AUTHOR when the bundle loaded).
//
// Per-panel override: each editor also carries a `voiceFacet` set to that
// panel's chosen AUTHOR voice (a pubkey). When set, it wins over
// `authorVoice()` so the left and right panels can write under different
// voices at once; a panel that hasn't picked an AUTHOR voice still falls back
// to the global AUTHOR key. The facet lives in a Compartment so it can be
// reconfigured live (switching the AUTHOR key) without rebuilding the editor's
// extensions.

/** The AUTHOR voice for the editor that provides this facet. Empty string
 *  means "no AUTHOR key picked" — the editor falls back to the global active
 *  voice. */
const voiceFacet = Facet.define<string, string>({ combine: (v) => v[0] ?? "" });
/** Holds voiceFacet so it can be reconfigured on the fly (AUTHOR switch). */
const voiceCompartment = new Compartment();
/** Holds voiceDecorations so it can be dropped/re-added on the fly when the
 *  global voice-attribution toggle flips — without rebuilding the editor's
 *  whole extension set (which would reset doc state, history, etc.). */
const voiceAttributionCompartment = new Compartment();
/** Holds the legend's temporary voice isolation. Reconfiguring it rebuilds
 * ordinary run marks and Preview-mode citation widgets in one transaction. */
const focusedVoiceCompartment = new Compartment();
/** Hold the selected-span facet + chip-click handler so the bracket layer can
 *  re-ring the selected `[[ span ]]` and report chip clicks without rebuilding
 *  the editor. Reconfigured live from FileEditor when `selection` moves. */
const selectedNodeIdCompartment = new Compartment();
const onSelectSpanCompartment = new Compartment();
/** Holds the replay read-only gate so it can be reconfigured live (entering/
 *  leaving a frozen replay step) without rebuilding the editor. While armed it
 *  drops user keystrokes (a frozen historical view can't be edited) but flashes
 *  a red reject pulse so the refusal reads as deliberate, not a dead input. */
const readOnlyCompartment = new Compartment();

/** Build the replay read-only filter for one editor. `onReject` fires on each
 *  dropped user edit so that editor can arm its own reject flash; a stable ref
 *  (like onEditRef in FileEditor) keeps the closure current without rebuilding
 *  the extension. Programmatic content swaps carry setRunsEffect (tab switch,
 *  agent write, replay stepping, per-char playback) and pass through unchanged
 *  — the same convention liftRuns uses to ignore echoes. */
function replayReadOnlyFilter(
  onReject: () => void,
): Extension {
  return EditorState.transactionFilter.of((tr) => {
    if (!tr.docChanged) return [tr];
    if (tr.effects.some((e) => e.is(setRunsEffect))) return [tr];
    onReject();
    return [];
  });
}

/** Carries an externally-imposed Run[] (agent write / file switch). Tagged
 *  so the updateListener knows not to echo it back as a user edit. */
const setRunsEffect = StateEffect.define<Run[]>();
/** Triggers a decoration-only repaint after a foreign kind-34292 identity
 * resolves. Voice/bracket plugins already rebuild on arbitrary effects. */
const refreshVoiceStylesEffect = StateEffect.define<null>();

/** Tags a doc-change transaction with the exact voice an LLM op streamed under.
 *  Carried in the same transaction as the change, so attribution can't drift
 *  even when the editor facet is reconfigured mid-stream (AUTHOR switch, a
 *  prior op's restore). Absent on a change → the facet AUTHOR voice is used. */
const opVoiceEffect = StateEffect.define<string>();

const voiceField = StateField.define<Run[]>({
  create: () => [],
  update(runs, tr) {
    for (const e of tr.effects) if (e.is(setRunsEffect)) return e.value;
    if (!tr.docChanged) return runs;
    // Apply changes last-to-first so earlier positions stay valid.
    const changes: { fromA: number; toA: number; insert: string }[] = [];
    tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
      changes.push({ fromA, toA, insert: inserted.sliceString(0) });
    });
    // An op-tagged voice wins over the facet AUTHOR voice: it's the voice the
    // op was invoked under (the MODEL dropdown the user clicked), captured in
    // the change transaction itself rather than read from the live facet —
    // which may be reconfigured by a concurrent AUTHOR switch or a stale endOp
    // restore between dispatch and field update. Falls back to the facet
    // AUTHOR voice, then the AUTHOR key.
    const opVoice = tr.effects.find((e) => e.is(opVoiceEffect))?.value;
    const pen = opVoice || tr.state.facet(voiceFacet) || authorVoice();
    let out = runs;
    for (let i = changes.length - 1; i >= 0; i--) {
      const { fromA, toA, insert } = changes[i];
      out = spliceRuns(out, fromA, toA, insert, pen);
    }
    return out;
  },
});

/** Synchronizes the editor-owned KEdit log with FileState after a Step, tab
 *  switch, crash-pad restore, or agent write. */
const setKEditsEffect = StateEffect.define<KEditLog>();

/** The interactive process log: one `KEdit` per discrete editor change since the last
 *  step (or the last programmatic content swap). A parallel sink to
 *  `voiceField` — same `iterChanges` walk, same voice resolution, but appends
 *  to a log instead of splicing runs. CodeMirror suppresses transactions
 *  during IME composition, so a Chinese/Japanese/Korean commit lands as ONE
 *  entry (the committed text), never the intermediate pinyin — CJK is free.
 *  Undo/redo transactions retain CodeMirror's semantic history intent, and
 *  every range in a multi-range transaction shares one node-local `tx` id.
 *
 *  Synchronized after Step by `setKEditsEffect` and reset on programmatic
 *  repopulation (via the `setRunsEffect` gate, mirroring `voiceField`). Memory
 *  is bounded to the edits after the latest Step. */
const keditField = StateField.define<KEditLog>({
  create: () => EMPTY_KEDIT_LOG,
  update(buf, tr) {
    for (const e of tr.effects) {
      if (e.is(setKEditsEffect)) return e.value;
    }
    // Same gate as voiceField: a setRunsEffect-tagged transaction is a
    // programmatic content swap (file switch, agent write, replay restore) —
    // not a user edit, so the interactive log resets. The host records the
    // programmatic transition separately as one atomic KEdit when appropriate.
    for (const e of tr.effects) {
      if (e.is(setRunsEffect)) return EMPTY_KEDIT_LOG;
    }
    if (!tr.docChanged) return buf;
    // Same voice resolution as voiceField.update: op-tagged voice wins over
    // the facet AUTHOR voice, with authorVoice() as the final fallback.
    const opVoice = tr.effects.find((e) => e.is(opVoiceEffect))?.value;
    const pen = opVoice || tr.state.facet(voiceFacet) || authorVoice();
    const add = captureKEditTransaction(tr, pen, nextKEditTx(buf));
    return appendKEditLog(buf, add);
  },
});

/**
 * Exact current-session origin map for author directives. Unlike voiceField,
 * this field never infers authority from Runs. Reload/setRuns resets the whole
 * body to unknown; paste, drop, MODEL, undo/redo reinsertion, and unannotated
 * programmatic changes are retained as explicitly ineligible spans.
 */
const authoringAuthorityField = StateField.define<EditorAuthorityState>({
  create: (state) => createEditorAuthorityState(state.doc.length),
  update(authority, tr) {
    if (tr.effects.some((effect) => effect.is(setRunsEffect))) {
      return resetEditorAuthorityState(authority, tr.newDoc.length);
    }
    if (!tr.docChanged) return authority;
    const changes: Array<{ fromA: number; toA: number; fromB: number; toB: number }> = [];
    tr.changes.iterChanges((fromA, toA, fromB, toB) => {
      changes.push({ fromA, toA, fromB, toB });
    });
    const origin = classifyEditorTransaction({
      model: tr.effects.some((effect) => effect.is(opVoiceEffect)),
      paste: tr.isUserEvent("input.paste"),
      drop: tr.isUserEvent("input.drop"),
      manualType: tr.isUserEvent("input.type"),
      undoRedo: tr.isUserEvent("undo") || tr.isUserEvent("redo"),
    });
    const actorId = tr.state.facet(voiceFacet) || authorVoice();
    return applyEditorAuthorityChanges(authority, changes, origin, actorId);
  },
});

const voiceDecorations = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildVoiceDecorations(view);
    }
    update(update: import("@codemirror/view").ViewUpdate) {
      if (update.docChanged || update.transactions.some((t) => t.effects.length)) {
        this.decorations = buildVoiceDecorations(update.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

// Streaming scroll anchor: an external append captures one of two reader
// intents before CodeMirror redraws. Bottom means follow the growing document;
// fixed means restore the exact prior scrollTop after CM's wrapped-line and
// virtual-viewport measurements settle. Direct LLM edits carry opVoiceEffect;
// React-driven Reply/Analyze streams arrive as append-only setRuns updates.
// Ordinary typing and explicit scrollIntoView requests stay on CodeMirror's
// native cursor behavior.
function isStreamedChange(update: import("@codemirror/view").ViewUpdate): boolean {
  if (!update.docChanged) return false;

  const isDirectLlmChange = update.transactions.some((tr) =>
    tr.effects.some((effect) => effect.is(opVoiceEffect)),
  );
  if (isDirectLlmChange) return true;

  const isExternalRunsChange = update.transactions.some((tr) =>
    tr.effects.some((effect) => effect.is(setRunsEffect)),
  );
  if (!isExternalRunsChange) return false;

  const oldLength = update.startState.doc.length;
  let sawAppend = false;
  let appendOnly = true;
  update.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    if (fromA !== oldLength || toA !== oldLength || inserted.length === 0) {
      appendOnly = false;
    } else {
      sawAppend = true;
    }
  });
  return appendOnly && sawAppend;
}

const stickToBottom = ViewPlugin.fromClass(
  class {
    pending: number | null = null;
    userScrolling = false;
    userScrollVersion = 0;
    userScrollTimer: number | null = null;
    readonly view: EditorView;
    readonly win: Window;

    constructor(view: EditorView) {
      this.view = view;
      this.win = view.scrollDOM.ownerDocument.defaultView ?? window;
      view.scrollDOM.addEventListener("wheel", this.noteUserScrollIntent, { passive: true });
      view.scrollDOM.addEventListener("touchstart", this.noteUserScrollIntent, { passive: true });
      view.scrollDOM.addEventListener("pointerdown", this.noteScrollbarPointer, {
        passive: true,
      });
      view.scrollDOM.addEventListener("keydown", this.noteScrollKey);
      view.scrollDOM.addEventListener("scroll", this.noteUserScroll, { passive: true });
    }

    armUserScrollExpiry = () => {
      if (this.userScrollTimer !== null) this.win.clearTimeout(this.userScrollTimer);
      this.userScrollTimer = this.win.setTimeout(() => {
        this.userScrolling = false;
        this.userScrollTimer = null;
      }, 250);
    };

    noteUserScrollIntent = () => {
      this.userScrolling = true;
      this.userScrollVersion += 1;
      this.armUserScrollExpiry();
    };

    noteScrollbarPointer = (event: PointerEvent) => {
      // Pointer events targeting the scroller itself come from its scrollbar;
      // clicks inside the document target a content descendant.
      if (event.target === this.view.scrollDOM) this.noteUserScrollIntent();
    };

    noteScrollKey = (event: KeyboardEvent) => {
      if (
        event.key === "ArrowUp" ||
        event.key === "ArrowDown" ||
        event.key === "PageUp" ||
        event.key === "PageDown" ||
        event.key === "Home" ||
        event.key === "End"
      ) {
        this.noteUserScrollIntent();
      }
    };

    noteUserScroll = () => {
      if (!this.userScrolling) return;
      this.userScrollVersion += 1;
      this.armUserScrollExpiry();
    };

    update(update: import("@codemirror/view").ViewUpdate) {
      if (!isStreamedChange(update) || this.pending !== null || this.userScrolling) return;

      // Plugin updates run before CodeMirror redraws its DOM. These are the old
      // scroll metrics, which are exactly the state the reader chose.
      const view = update.view;
      const el = view.scrollDOM;
      const anchor = captureStreamingScrollAnchor(el);
      const userScrollVersion = this.userScrollVersion;

      // CodeMirror schedules its own measure frame before plugins are updated.
      // Our later frame restores the policy after CM has settled its height map.
      this.pending = this.win.requestAnimationFrame(() => {
        this.pending = null;
        if (this.userScrolling || this.userScrollVersion !== userScrollVersion) return;
        el.scrollTop = restoreStreamingScrollTop(anchor, el);
      });
    }

    destroy() {
      if (this.pending !== null) this.win.cancelAnimationFrame(this.pending);
      if (this.userScrollTimer !== null) this.win.clearTimeout(this.userScrollTimer);
      this.view.scrollDOM.removeEventListener("wheel", this.noteUserScrollIntent);
      this.view.scrollDOM.removeEventListener("touchstart", this.noteUserScrollIntent);
      this.view.scrollDOM.removeEventListener("pointerdown", this.noteScrollbarPointer);
      this.view.scrollDOM.removeEventListener("keydown", this.noteScrollKey);
      this.view.scrollDOM.removeEventListener("scroll", this.noteUserScroll);
    }
  },
);

// --- document chrome slots ---------------------------------------------
//
// The mode/citation controls belong to the document rather than the fixed
// panel frame: the outgoing row should leave the viewport as the reader moves
// down, and inbound citations should be encountered after the final line. Two
// block widgets provide stable React portal targets at offsets 0 and doc.length
// while leaving CodeMirror in charge of the one scroll surface. Mapping the
// decorations through each transaction keeps the bottom slot after appended or
// replaced text without remounting it during streamed writes.
type EditorChromeSlot = "top" | "bottom";
type EditorChromeSlotMount = (slot: EditorChromeSlot, element: HTMLElement | null) => void;

class EditorChromeSlotWidget extends WidgetType {
  constructor(
    readonly slot: EditorChromeSlot,
    readonly onMount: EditorChromeSlotMount,
  ) {
    super();
  }

  eq(other: EditorChromeSlotWidget): boolean {
    return other.slot === this.slot && other.onMount === this.onMount;
  }

  toDOM(): HTMLElement {
    const element = document.createElement("div");
    element.className = `editor-chrome-slot editor-chrome-${this.slot}`;
    this.onMount(this.slot, element);
    return element;
  }

  destroy(_element: HTMLElement): void {
    this.onMount(this.slot, null);
  }

  // Buttons, picker inputs, and citation links inside the portal own their
  // events. CodeMirror should not turn those gestures into text selections.
  ignoreEvent(): boolean {
    return true;
  }
}

function editorChromeSlots(onMount: EditorChromeSlotMount): Extension {
  const top = Decoration.widget({
    widget: new EditorChromeSlotWidget("top", onMount),
    block: true,
    side: -100,
  });
  const bottom = Decoration.widget({
    widget: new EditorChromeSlotWidget("bottom", onMount),
    block: true,
    side: 100,
  });
  return StateField.define<DecorationSet>({
    create(state) {
      return Decoration.set([top.range(0), bottom.range(state.doc.length)], true);
    },
    update(slots, transaction) {
      return transaction.docChanged ? slots.map(transaction.changes) : slots;
    },
    provide: (field) => EditorView.decorations.from(field),
  });
}

function buildVoiceDecorations(view: EditorView): DecorationSet {
  // Non-throwing field read (field(x, false) → undefined if absent): after a
  // Vite HMR swap, voiceField re-evaluates to a new identity while a live view
  // still holds state built from the prior identity. The throwing form would
  // crash the editor on the next decoration rebuild; the guarded form renders
  // nothing for one frame until the view remounts under the new extensions.
  const runs = view.state.field(voiceField, false);
  if (!runs) return Decoration.none;
  const focusedVoice = view.state.facet(focusedVoiceFacet);
  const decos: Range<Decoration>[] = [];
  let pos = 0;
  for (const r of runs) {
    const len = r.text.length;
    if (len > 0) {
      // Shared resolution: every pubkey gets a full identity (local,
      // relay-published, or deterministic fallback). Preview and Markdown are
      // the same CodeMirror doc, so a voice renders identically in both.
      const { className, style } = voiceSpanStyle(r.voice);
      const focusClass = focusedVoice
        ? r.voice === focusedVoice
          ? " voice-span--focused"
          : " voice-span--muted"
        : "";
      decos.push(
        Decoration.mark(
          style
            ? { class: className + focusClass, attributes: { style } }
            : { class: className + focusClass },
        ).range(pos, pos + len),
      );
      pos += len;
    }
  }
  return Decoration.set(decos, true);
}

/** Resolve a doc offset to the voice (pubkey) of the run covering it, by
 *  walking the live `voiceField` the same way `buildVoiceDecorations` does.
 *  Handed to `bracketVoiceResolverFacet` so the Preview-mode citation chip can
 *  adopt the writing voice's font + color. Reads the field in-pipeline (during
 *  a decoration rebuild) so it's never a tick behind — React's `file.runs`
 *  lags the transaction (`onEdit` → `setFiles` → re-render), but the field
 *  updates synchronously in the same CM transaction. Returns "" if the field
 *  is absent (stale view post-HMR) or the offset is past the end of runs. */
function voiceAtOffset(view: EditorView, offset: number): string {
  const runs = view.state.field(voiceField, false);
  if (!runs) return "";
  let pos = 0;
  for (const r of runs) {
    const len = r.text.length;
    if (len <= 0) continue;
    if (offset < pos + len) return r.voice;
    pos += len;
  }
  return "";
}

const editorTheme = EditorView.theme({
  "&": {
    flex: "1",
    backgroundColor: "var(--editor-surface, var(--surface-raised))",
    color: "var(--ink)",
    fontSize: "1.1rem",
    height: "100%",
  },
  ".cm-scroller": {
    fontFamily: "var(--font-body)",
    lineHeight: "1.75",
    // The citation widgets own the block-axis insets so their bars remain
    // flush with the tab/footer; the scroller owns the matching inline inset.
    padding: "0 var(--editor-content-inset-inline)",
    // CodeMirror defaults this axis to auto for unwrapped code. This press
    // always wraps, so transient widget overflow must not expose a scrollbar.
    overflowX: "hidden",
    overflowY: "auto",
  },
  // Every editor uses line wrapping, so the content flex item must be allowed
  // below its descendants' min-content width. Citation status labels otherwise
  // turn a narrow panel into a horizontally scrolling CodeMirror surface.
  ".cm-content": { caretColor: "var(--accent)", padding: "0", minWidth: "0" },
  "&.cm-focused": { outline: "none" },
  // Line-number gutter: blends with the panel surface so it reads as a margin
  // rather than a separate column. Top padding mirrors .cm-scroller so each
  // number sits level with its line; the counter itself is dim ink.
  ".cm-gutters": {
    backgroundColor: "transparent",
    borderRight: "none",
    color: "var(--ink-dim)",
    fontFamily: "var(--font-body)",
  },
  ".cm-gutter.cm-lineNumbers": { padding: "0 0.35rem" },
  // Match the content's lineHeight/fontSize so each number row is exactly as
  // tall as its line — otherwise the gutter uses CM's default and drifts out
  // of alignment with the text on line 1.
  ".cm-gutterElement": { minWidth: "1.5em", lineHeight: "1.75", fontSize: "1.1rem" },
});

function buildExtensions(
  onUserEdit: (runs: Run[], kedits: KEditLog) => void,
  voice: string,
  mode: Mode,
  voiceAttribution: boolean,
  focusedVoice: string,
  onSelection: (sel: { from: number; to: number } | null) => void,
  selectedNodeId: string,
  onSelectSpan: (nodeId: string, phrase: string) => void,
  onCopySelection: (view: EditorView, event: ClipboardEvent) => boolean,
  onPasteSelection: (view: EditorView, event: ClipboardEvent) => boolean,
  readOnly: boolean,
  onReject: () => void,
  onChromeSlotMount: EditorChromeSlotMount,
): Extension[] {
  const liftRuns = EditorView.updateListener.of((update) => {
    for (const tr of update.transactions) {
      if (tr.docChanged && !tr.effects.some((e) => e.is(setRunsEffect))) {
        // Non-throwing field read — see buildVoiceDecorations for the HMR
        // rationale. If the field is absent (stale view post-HMR), skip the
        // lift rather than throwing; the next legitimate render resyncs.
        const runs = update.state.field(voiceField, false);
        // Same non-throwing read for the keystroke log. Mirrors runs into
        // FileState.kedits on every edit so stepFile can drain it without
        // reaching into the editor view (which lives in a different scope).
        const kedits = update.state.field(keditField, false);
        if (runs) onUserEdit(runs, kedits ?? EMPTY_KEDIT_LOG);
      }
    }
  });
  // Track the editor's selection range (null when empty), so the selection
  // menu can open anchored to the head and voice ops can scope to the
  // selection vs. the whole document. Fires on mount (constructor update)
  // and on every selection/doc change.
  const trackSelection = EditorView.updateListener.of((update) => {
    if (update.selectionSet || update.docChanged || update.viewportChanged) {
      const { from, to } = update.state.selection.main;
      onSelection(from !== to ? { from, to } : null);
    }
  });
  return [
    history(),
    // Line-number gutter down the left edge of each panel — CM's built-in
    // counter, themed via editorTheme + the .cm-gutters rule in App.css.
    lineNumbers(),
    ...markdownIndentExtensions,
    keymap.of([
      // Backspace twice over one selected bracket to unwrap it into ordinary
      // text. This binding runs before CodeMirror's default deletion command;
      // broader selections still flow through bracketProtect below.
      { key: "Backspace", run: doubleBackspaceUnwrapCommand() },
      // One four-space unit nests both ordered and unordered CommonMark list
      // items. Shift+Tab removes the same unit; no literal tab is written.
      indentWithTab,
      ...defaultKeymap,
      ...historyKeymap,
      // Cmd/Ctrl+B: wrap the selection in `[[ ]]` (pending bracket; protected
      // from overwrite by bracketProtect, never auto-minted). Used to share
      // Cmd+S via a selection branch; now that Cmd+S == Step, wrapping gets its
      // own key. Falls through (returns false) on empty/markup/already-wrapped
      // selections, so Cmd+B is inert when there's nothing to wrap.
      { key: "Mod-b", run: wrapSelectionCommand() },
    ]),
    // Per-panel AUTHOR voice, reconfigurable via voiceCompartment (see FileEditor).
    voiceCompartment.of(voiceFacet.of(voice)),
    voiceField,
    // Keystroke log — parallel sink to voiceField, drained at step time.
    keditField,
    // Non-normative, current-session-only instruction-authority evidence.
    authoringAuthorityField,
    // Voice color decorations, gated by the global voice-attribution toggle.
    // Reconfigured live via voiceAttributionCompartment (see FileEditor) when
    // the user flips the rail toggle — drops to [] (no coloring) or restores
    // voiceDecorations without remounting the editor.
    voiceAttributionCompartment.of(voiceAttribution ? voiceDecorations : []),
    focusedVoiceCompartment.of(focusedVoiceFacet.of(focusedVoice)),
    // Preview/Markdown surface, reconfigurable via modeCompartment (see
    // FileEditor) — switches which decorations bracketExtensions() emits.
    modeCompartment.of(modeFacet.of(mode)),
    // Voice resolver for the Preview-mode citation chip: lets brackets.ts ask
    // "which voice wrote the run at this offset?" so the chip can adopt that
    // voice's font + color. Reads the live voiceField in-pipeline, so no
    // compartment is needed — the resolver closure is stateless and the field
    // it reads updates synchronously with each transaction.
    bracketVoiceResolverFacet.of(voiceAtOffset),
    // Selected-span ring + chip-click handler, each reconfigurable
    // live so a selection move re-rings the right `[[ span ]]` (and a chip
    // click/copy reports to App) without rebuilding the editor.
    selectedNodeIdCompartment.of(selectedNodeIdFacet.of(selectedNodeId)),
    onSelectSpanCompartment.of(onSelectSpanFacet.of(onSelectSpan)),
    // Replay read-only gate, reconfigured live via readOnlyCompartment (see
    // FileEditor). While frozen on a historical replay step (or mid-playback)
    // user keystrokes are dropped and pulse the reject flash; programmatic
    // content swaps (setRunsEffect) pass through. Empty (no-op) when live.
    readOnlyCompartment.of(readOnly ? replayReadOnlyFilter(onReject) : []),
    // Scroll-native React portal targets: outgoing citations before the first
    // line, inbound citations after the final line.
    editorChromeSlots(onChromeSlotMount),
    // Bracket layer (minting authoring surface + rewrite protection — the
    // single protection marker per trace-provenance.md "Rewrite protection").
    // Decoration marks `[[ ]]` / `(( ))` in Markdown mode, or collapses them
    // into atomic chip widgets in Preview mode (modeFacet); bracketProtect
    // spares fully-contained brackets from ordinary deletion in either mode,
    // while Cut and paste/type-over keep normal selection semantics. Wrapping
    // is opt-in via Cmd/Ctrl+B or selected-text Step, never a selection side
    // effect.
    ...bracketExtensions(),
    // Markdown preview pass — inert in Markdown mode (returns Decoration.none),
    // active only in Preview, where it hides/stylizes standard markdown symbols
    // (#, **, `, -, >, ~~, fences). Reads modeFacet so a mode switch
    // redecorates at once; mirrors the bracket layer's rebuild triggers.
    ...markdownPreviewExtensions(),
    EditorView.domEventHandlers({
      copy: (event, view) => onCopySelection(view, event),
      paste: (event, view) => onPasteSelection(view, event),
    }),
    liftRuns,
    trackSelection,
    editorTheme,
    EditorView.lineWrapping,
    // Stick-to-bottom: keep the viewport pinned to the bottom while content
    // streams in (LLM extend/reply), unless the reader has scrolled up.
    stickToBottom,
  ];
}

function runsEqual(a: Run[], b: Run[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].voice !== b[i].voice || a[i].text !== b[i].text) return false;
  }
  return true;
}

function FileEditor({
  file,
  path,
  onEdit,
  onView,
  onSelection,
  voice,
  mode,
  voiceAttribution,
  focusedVoice,
  selectedNodeId,
  scrollTarget,
  readOnly,
  onSelectSpan,
  onCopySelection,
  onPasteSelection,
  onReplayEditAttempt,
  topChrome,
  bottomChrome,
  citationDropMarkup,
  onCitationDrop,
}: {
  file: FileState;
  /** The file's path — the editor's identity for doc-sync. A tab switch changes
   *  `path` even when the new file's runs equal the editor's current voiceField
   *  (e.g. two files with identical content), so the swap is driven by path, not
   *  run equality — otherwise the body would stay on the old file while the
   *  sidebar (tracking the active tab) moved on. */
  path: string;
  onEdit: (runs: Run[], kedits: KEditLog) => void;
  onView?: (view: EditorView | null) => void;
  /** Notified with the editor's selection range (or null when empty), so the
   *  selection menu can anchor to the head and ops can scope to the selection. */
  onSelection?: (sel: { from: number; to: number } | null) => void;
  /** The AUTHOR voice (pubkey) for this panel. "" → fall back to global active. */
  voice: string;
  /** Which surface this editor renders as — see modeFacet in brackets.ts. */
  mode: Mode;
  /** Whether per-voice text color is shown. Global; reconfigured live. */
  voiceAttribution: boolean;
  /** Voice isolated from the document legend, or empty for the normal view. */
  focusedVoice: string;
  /** nodeId of the selected coin, or "" when none — rings the
   *  matching `[[ span ]]` in this editor. */
  selectedNodeId: string;
  /** A range to scroll into view in this editor's current doc — set by folder
   *  replay to the footprint of the current step's deltas so the action that
   *  produced them lands in view. Cleared (null) when not replaying this file.
   *  Runs as an effect after the doc-sync swap so its offsets are valid. */
  scrollTarget?: { from: number; to: number } | null;
  /** Read-only while replay is frozen on a historical step or mid-playback.
   *  User keystrokes are dropped and pulse the reject flash; programmatic
   *  content swaps (tab switch, agent write, replay stepping, playback) still
   *  land via setRunsEffect. Live (false) on the resting `last` step. */
  readOnly: boolean;
  /** Clicking a citation chip selects that coin as the active trace. */
  onSelectSpan: (nodeId: string, phrase: string) => void;
  /** Copy/paste hooks that preserve an existing resolved Coin citation.
   * Returning false preserves native clipboard behavior for ordinary text. */
  onCopySelection: (view: EditorView, event: ClipboardEvent) => boolean;
  onPasteSelection: (view: EditorView, event: ClipboardEvent) => boolean;
  /** Fired when the user tries to edit while replay-frozen (a keystroke the
   *  read-only filter drops). The reject flash still pulses; this callback lets
   *  the App surface the fork-from-snapshot modal. Only fires when `readOnly`
   *  is true (mid-replay on a historical step). */
  onReplayEditAttempt?: () => void;
  /** Controls mounted before the first document line. They live inside
   *  CodeMirror's scroll surface through a block-widget portal. */
  topChrome?: ReactNode;
  /** Read-only provenance mounted after the final document line. */
  bottomChrome?: ReactNode;
  /** Resolve an internal tree drag to bracket markup. Returning null rejects
   *  the drop; App currently accepts only immutable Mint coins here. */
  citationDropMarkup?: (srcPath: string) => string | null;
  /** Runs after a bracket drop lands, so the owning panel becomes focused. */
  onCitationDrop?: () => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const chromeSlotsAliveRef = useRef(true);
  const [chromeSlots, setChromeSlots] = useState<{
    top: HTMLElement | null;
    bottom: HTMLElement | null;
  }>({ top: null, bottom: null });
  const chromeSlotMountRef = useRef<EditorChromeSlotMount | null>(null);
  if (chromeSlotMountRef.current === null) {
    chromeSlotMountRef.current = (slot, element) => {
      if (!chromeSlotsAliveRef.current) return;
      setChromeSlots((current) =>
        current[slot] === element ? current : { ...current, [slot]: element },
      );
    };
  }

  // Stable callback into the latest onEdit without rebuilding extensions.
  const onEditRef = useRef(onEdit);
  onEditRef.current = onEdit;
  // Same ref-indirection for onSelection: the closure captured at extension
  // build time calls through the ref so a changing handler doesn't rebuild.
  const onSelectionRef = useRef(onSelection);
  onSelectionRef.current = onSelection;
  // And for the chip-click handler: a stale onSelectSpan would still build the
  // right widget, but indirection keeps it cheap (no rebuild on selection move).
  const onSelectSpanRef = useRef(onSelectSpan);
  onSelectSpanRef.current = onSelectSpan;
  const onCopySelectionRef = useRef(onCopySelection);
  onCopySelectionRef.current = onCopySelection;
  const onPasteSelectionRef = useRef(onPasteSelection);
  onPasteSelectionRef.current = onPasteSelection;
  const citationDropMarkupRef = useRef(citationDropMarkup);
  citationDropMarkupRef.current = citationDropMarkup;
  const onCitationDropRef = useRef(onCitationDrop);
  onCitationDropRef.current = onCitationDrop;
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;

  // Reject flash: a rejected keystroke (read-only replay gate) pulses the
  // editor red for 0.9s. Rapid rejects keep the pulse lit (the timer re-arms)
  // rather than thrashing the animation per key. useRef-stable so the build-
  // time closure in buildExtensions calls through it without rebuilding.
  // Also fires `onReplayEditAttempt` so the App can surface the fork-from-
  // snapshot modal — the reject flash alone is too subtle for "you're about
  // to fork from a historical version."
  const onReplayEditAttemptRef = useRef<(() => void) | null>(null);
  onReplayEditAttemptRef.current = onReplayEditAttempt ?? null;
  const [rejecting, setRejecting] = useState(false);
  const rejectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const triggerRejectRef = useRef<() => void>(() => {});
  triggerRejectRef.current = () => {
    setRejecting(true);
    if (rejectTimerRef.current) clearTimeout(rejectTimerRef.current);
    rejectTimerRef.current = setTimeout(() => setRejecting(false), 900);
    onReplayEditAttemptRef.current?.();
  };
  useEffect(() => {
    return () => {
      if (rejectTimerRef.current) clearTimeout(rejectTimerRef.current);
    };
  }, []);

  const extensionsRef = useRef<Extension[] | null>(null);
  if (extensionsRef.current === null) {
    extensionsRef.current = buildExtensions(
      (runs, kedits) => onEditRef.current(runs, kedits),
      voice,
      mode,
      voiceAttribution,
      focusedVoice,
      (has) => onSelectionRef.current?.(has),
      selectedNodeId,
      (nodeId, phrase) => onSelectSpanRef.current(nodeId, phrase),
      (view, event) => onCopySelectionRef.current(view, event),
      (view, event) => onPasteSelectionRef.current(view, event),
      readOnly,
      () => triggerRejectRef.current(),
      chromeSlotMountRef.current,
    );
  }

  // The path whose runs the editor currently holds. Seeded at mount and updated
  // on every doc swap below — drives the file-switch branch of the sync effect.
  const pathRef = useRef<string>(path);

  // Mount once.
  useEffect(() => {
    if (!hostRef.current) return;
    // React StrictMode runs this setup/cleanup pair twice in development.
    // Re-open slot delivery before constructing the replacement view.
    chromeSlotsAliveRef.current = true;
    pathRef.current = path;
    const view = new EditorView({
      state: EditorState.create({
        doc: flatten(file.runs ?? []),
        extensions: extensionsRef.current!,
      }),
      parent: hostRef.current,
    });
    // Install the run map synchronously in the same task as the document. The
    // passive prop-sync effect is too late for the first keystroke: an edit in
    // that gap starts from voiceField's empty default and hands the existing
    // document to the active AUTHOR voice.
    view.dispatch({
      effects: [
        setRunsEffect.of(file.runs ?? []),
        setKEditsEffect.of(file.kedits ?? EMPTY_KEDIT_LOG),
      ],
    });
    viewRef.current = view;
    onView?.(view);
    return () => {
      chromeSlotsAliveRef.current = false;
      view.destroy();
      viewRef.current = null;
      onView?.(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // CodeMirror mounts its document DOM imperatively beneath the React-owned
  // host. React's delegated drag events do not reliably recover the host Fiber
  // when the native target is one of those inner nodes, so a real drop on a
  // `.cm-line` can bypass JSX `onDropCapture` entirely. Native capture
  // listeners at the boundary see both CodeMirror content and the React
  // portals; chrome targets are excluded so the citation row keeps its own
  // drop semantics.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const dragHitsDocumentChrome = (target: EventTarget | null) =>
      target instanceof Element && target.closest(".editor-chrome-slot") !== null;

    const citationDragOver = (event: DragEvent) => {
      const resolveMarkup = citationDropMarkupRef.current;
      const dataTransfer = event.dataTransfer;
      if (!resolveMarkup || !dataTransfer || dragHitsDocumentChrome(event.target)) return;
      if (!isZinePathDrag(dataTransfer)) return;
      const srcPath = zinePathFromDataTransfer(dataTransfer);
      // WebKit may hide getData() until drop. Accept the known custom drag
      // during hover, then make the coin-only decision with the real path.
      if (srcPath && !resolveMarkup(srcPath)) return;
      event.preventDefault();
      dataTransfer.dropEffect = "copy";
    };

    const citationDrop = (event: DragEvent) => {
      const resolveMarkup = citationDropMarkupRef.current;
      const dataTransfer = event.dataTransfer;
      if (!resolveMarkup || !dataTransfer || dragHitsDocumentChrome(event.target)) return;
      const srcPath = zinePathFromDataTransfer(dataTransfer);
      if (!srcPath) return;
      event.preventDefault();
      event.stopPropagation();
      const markup = resolveMarkup(srcPath);
      if (!markup) return;
      if (readOnlyRef.current) {
        triggerRejectRef.current();
        return;
      }
      const view = viewRef.current;
      if (!view) return;
      const coords = { x: event.clientX, y: event.clientY };
      // Preserve the exact character under a visible pointer. Only fall back
      // to CodeMirror's estimate for blank line space or virtualized DOM.
      const pos = view.posAtCoords(coords) ?? view.posAtCoords(coords, false);
      view.dispatch({
        changes: { from: pos, insert: markup },
        selection: { anchor: pos + markup.length },
        scrollIntoView: true,
      });
      onCitationDropRef.current?.();
      view.focus();
    };

    host.addEventListener("dragover", citationDragOver, true);
    host.addEventListener("drop", citationDrop, true);
    return () => {
      host.removeEventListener("dragover", citationDragOver, true);
      host.removeEventListener("drop", citationDrop, true);
    };
  }, []);

  // FileState is the cross-component handoff boundary for the KEdit log. A
  // successful Step replaces its already-written prefix with only the edits
  // typed while the relay write was in flight; mirror that exact remainder
  // back into CodeMirror before another input event can land.
  useLayoutEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const expected = file.kedits ?? EMPTY_KEDIT_LOG;
    const current = view.state.field(keditField, false);
    if (current !== undefined && current !== expected) {
      view.dispatch({ effects: setKEditsEffect.of(expected) });
    }
  }, [path, file.kedits]);

  // Switching the AUTHOR key reconfigures the voice facet live — subsequent
  // keystrokes (and streamed LLM deltas) are attributed to the new voice
  // without remounting the editor. useLayoutEffect (not useEffect) so the
  // facet is updated synchronously during commit, before the browser
  // paints and before any user input can land — otherwise a fast keystroke
  // after the key switch can read the stale facet and attribute text to the
  // old voice.
  useLayoutEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ effects: voiceCompartment.reconfigure(voiceFacet.of(voice)) });
  }, [voice]);

  // Switching Preview/Markdown reconfigures the mode facet live — the bracket
  // decoration ViewPlugins in brackets.ts pick it up on their next rebuild
  // (triggered by this same reconfigure effect) without remounting the editor.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ effects: modeCompartment.reconfigure(modeFacet.of(mode)) });
  }, [mode]);

  // Flipping the global voice-attribution toggle reconfigures the decoration
  // plugin live — drops voiceDecorations to [] (no coloring) or restores it,
  // without remounting the editor or resetting doc state/history.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: voiceAttributionCompartment.reconfigure(voiceAttribution ? voiceDecorations : []),
    });
  }, [voiceAttribution]);

  // Hovering or pinning a legend chip isolates that voice without changing
  // the document or selection. The facet is shared with brackets.ts so
  // Preview-mode citation phrases participate in the same focus treatment.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: focusedVoiceCompartment.reconfigure(focusedVoiceFacet.of(focusedVoice)),
    });
  }, [focusedVoice]);

  // Resolve every real pubkey in the current document once. Text paints at
  // once with a deterministic identity; a published kind-34292 declaration
  // arriving later notifies the subscription below and causes a decoration-
  // only refresh, preserving editor state/history and the KEdit log.
  const voiceSetRef = useRef<Set<string>>(new Set());
  voiceSetRef.current = new Set((file.runs ?? []).map((run) => run.voice));
  const resolvableVoices = [...voiceSetRef.current]
    .filter((pubkey) => /^[0-9a-f]{64}$/i.test(pubkey))
    .sort()
    .join("\u0000");
  useEffect(() => {
    if (!resolvableVoices) return;
    for (const pubkey of resolvableVoices.split("\u0000")) {
      void identityForPubkey(pubkey);
    }
  }, [resolvableVoices]);
  useEffect(() => {
    return subscribeVoiceIdentities((pubkey) => {
      if (!voiceSetRef.current.has(pubkey)) return;
      viewRef.current?.dispatch({ effects: refreshVoiceStylesEffect.of(null) });
    });
  }, []);

  // Entering/leaving a frozen replay step reconfigures the read-only gate live
  // — user keystrokes start/stop being dropped without remounting the editor.
  // useLayoutEffect (like the voice reconfigure above) so the gate is in place
  // synchronously during commit, before a keystroke can land on the wrong side.
  useLayoutEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: readOnlyCompartment.reconfigure(
        readOnly ? replayReadOnlyFilter(() => triggerRejectRef.current()) : [],
      ),
    });
  }, [readOnly]);

  // Moving the active-trace selection onto/off a coin re-rings the
  // matching `[[ span ]]` live. The chip-click handler is stable via ref, so it
  // needs no matching effect.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: selectedNodeIdCompartment.reconfigure(selectedNodeIdFacet.of(selectedNodeId)),
    });
  }, [selectedNodeId]);

  // Push external Run[] changes (agent write, file switching) into CM. Tagged
  // with setRunsEffect so liftRuns doesn't echo them back. Two cases — see the
  // inline comments for the path-switch-first ordering (advancing pathRef and
  // swapping the doc before the voiceField-absent bail is what keeps a tab
  // switch from wedging on the old file post-HMR):
  useLayoutEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const switched = pathRef.current !== path;
    if (switched) {
      // Tab switch: always swap the doc to the new file's runs and advance
      // pathRef BEFORE anything else. The runsEqual guard below must NOT gate
      // this — two files can share identical runs, and skipping the swap (or
      // failing to advance pathRef) leaves the body on the old file while the
      // sidebar/active tab has already moved on ("stuck on the last file").
      // This also covers a stale view post-HMR where voiceField is absent: the
      // doc text still swaps (the change needs no field), and setRunsEffect is
      // silently ignored by the field-less state, so the editor is no longer
      // wedged on the pre-HMR file until a full reload. The non-throwing field
      // read below bails only on the same-file echo path, never on a switch.
      pathRef.current = path;
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: flatten(file.runs ?? []) },
        // A tab owns its own selection. Without an explicit cursor CodeMirror
        // remaps the previous file's highlighted range through this replacement;
        // equal-length text (notably a just-minted Coin) inherits the range and
        // makes the palette offer Mint again on an immutable trace.
        selection: EditorSelection.cursor(0),
        effects: [
          setRunsEffect.of(file.runs ?? []),
          setKEditsEffect.of(file.kedits ?? EMPTY_KEDIT_LOG),
        ],
      });
      return;
    }
    // Same file, external update (agent write to the open file): guard against
    // the runs the editor already holds so a user edit we just lifted doesn't
    // echo back and loop. See buildVoiceDecorations for the HMR rationale; if
    // the field is absent we bail here — but a path switch above already
    // handled the swap, so this only skips a redundant same-file push.
    const current = view.state.field(voiceField, false);
    if (current === undefined) return;
    if (runsEqual(current, file.runs ?? [])) return;
    const oldText = view.state.doc.toString();
    const newText = flatten(file.runs ?? []);
    // Append-only external update (e.g. a Reply stream writing the body
    // token-by-token): dispatch just the new tail as an incremental insert at
    // the doc end. A full-doc replace here would remap CM6's scroll anchor to
    // doc-top on every token and jitter the viewport when the reader is
    // scrolled up. Incremental inserts leave the anchored (visible) line's
    // position unchanged → no scroll; CM6's native scrolledToBottom path still
    // auto-follows when the reader is pinned to the bottom.
    if (newText.length > oldText.length && newText.startsWith(oldText)) {
      view.dispatch({
        changes: { from: oldText.length, insert: newText.slice(oldText.length) },
        effects: [
          setRunsEffect.of(file.runs ?? []),
          setKEditsEffect.of(file.kedits ?? EMPTY_KEDIT_LOG),
        ],
      });
      return;
    }
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: newText },
      effects: [
        setRunsEffect.of(file.runs ?? []),
        setKEditsEffect.of(file.kedits ?? EMPTY_KEDIT_LOG),
      ],
    });
  }, [path, file.runs]);

  // Folder replay hands the editor a doc range to bring into view — the
  // footprint of the current step's deltas (the action that produced them).
  // Runs AFTER the doc-sync effect above (declared later → flushes later within
  // the same commit), so its offsets are valid against the just-swapped doc.
  // The `path` dep makes a tab switch re-fire against the new file's doc, which
  // lines up with replay's selectFile() panel switch. Clamping guards against a
  // stale target whose offsets exceed a shorter-than-expected doc.
  useEffect(() => {
    const view = viewRef.current;
    if (!view || !scrollTarget) return;
    const len = view.state.doc.length;
    const from = Math.max(0, Math.min(scrollTarget.from, len));
    const to = Math.max(from, Math.min(scrollTarget.to, len));
    view.dispatch({
      effects: EditorView.scrollIntoView(to > from ? EditorSelection.range(from, to) : from, {
        y: "center",
      }),
    });
  }, [scrollTarget, path]);

  // Portal content changes independently of CodeMirror's document. Observe the
  // two slot boxes so citation wrapping, empty states, and inbound expansion
  // immediately update CM's block-height map and scroll range. CodeMirror lays
  // block widgets inside the padded text column (and, in Markdown mode, after
  // the line-number gutter), so measure those live insets and cancel them with
  // negative inline margins. The rows then meet the scrollport's side edges
  // while the document text keeps its reading padding.
  useEffect(() => {
    const view = viewRef.current;
    if (!view || typeof ResizeObserver === "undefined") return;

    const fitSlotToScrollport = (slot: HTMLElement | null) => {
      if (!slot) return;
      const scrollRect = view.scrollDOM.getBoundingClientRect();
      const slotRect = slot.getBoundingClientRect();
      const previousStart = Number(slot.dataset.chromeBleedStart ?? 0);
      const previousEnd = Number(slot.dataset.chromeBleedEnd ?? 0);
      const scrollStart = scrollRect.left;
      const scrollEnd = scrollRect.right;
      // Recover the un-bled slot edges from the currently applied margins so
      // repeated ResizeObserver passes remain stable instead of compounding.
      const naturalStart = slotRect.left + previousStart;
      const naturalEnd = slotRect.right - previousEnd;
      const nextStart = Math.max(0, naturalStart - scrollStart);
      const nextEnd = Math.max(0, scrollEnd - naturalEnd);

      if (Math.abs(nextStart - previousStart) > 0.1) {
        slot.dataset.chromeBleedStart = String(nextStart);
        slot.style.setProperty("--editor-chrome-bleed-start", `${nextStart}px`);
      }
      if (Math.abs(nextEnd - previousEnd) > 0.1) {
        slot.dataset.chromeBleedEnd = String(nextEnd);
        slot.style.setProperty("--editor-chrome-bleed-end", `${nextEnd}px`);
      }
    };
    const measureChrome = () => {
      fitSlotToScrollport(chromeSlots.top);
      fitSlotToScrollport(chromeSlots.bottom);
      view.requestMeasure();
    };
    const observer = new ResizeObserver(measureChrome);
    if (chromeSlots.top) observer.observe(chromeSlots.top);
    if (chromeSlots.bottom) observer.observe(chromeSlots.bottom);
    measureChrome();
    return () => observer.disconnect();
  }, [chromeSlots.top, chromeSlots.bottom, topChrome, bottomChrome]);

  return (
    <>
      <div
        ref={hostRef}
        className={"editor-host" + (rejecting ? " editor-host-reject" : "")}
      />
      {chromeSlots.top && topChrome ? createPortal(topChrome, chromeSlots.top) : null}
      {chromeSlots.bottom && bottomChrome ? createPortal(bottomChrome, chromeSlots.bottom) : null}
    </>
  );
}

// --- citation chips ----------------------------------------------------
//
// The named list of traces this one cites — every `q` edge on its current head,
// resolved to a name by `resolveNodeName`. Each chip explicitly says whether
// the target is quoted in the document body or cited without a body quote.
// `FileState.citationIds` stores the explicit no-body subset; the UI calls both
// forms citations.
// --- inbound tracker ---------------------------------------------------
//
// The traces that fork or cite this one — the INBOUND direction. Protocol-level
// `tag` and `cite` roles are deliberately grouped under the clearer reader term
// "citation". Each entry is a read-only click-to-open chip; merge actions stay
// in the workspace banner.
//
// The band stays mounted even when empty and lives at the end of the document,
// where it reads as a compact "who points here" footer.
type InboundFreshness = "fresh" | "stale" | "unavailable";

function InboundRow({
  inbound,
  freshness,
  onOpen,
}: {
  inbound: TraceInbound[];
  freshness?: InboundFreshness;
  onOpen: (nodeId: string) => void;
}) {
  // Expanded by default — it's a tracker; the user wants to see them. Survives
  // across this Panel's lifetime, not across files (a fresh mount resets to
  // expanded).
  const [expanded, setExpanded] = useState(true);
  const forks = inbound.filter((e) => e.kind === "fork");
  const incomingCitations = inbound.filter((e) => e.kind === "tag" || e.kind === "cite");

  // A short pubkey prefix for the fallback label when no name resolved.
  const fallback = (e: TraceInbound) => e.name ?? `${e.ownerPubkey.slice(0, 8)}…`;
  const hasInbound = inbound.length > 0;
  const freshnessLabel =
    freshness === "stale" ? "stale/offline" : freshness === "unavailable" ? "unavailable" : "";

  const renderGroup = (
    kind: TraceInbound["kind"],
    icon: LucideIcon,
    label: string,
    entries: TraceInbound[],
  ) => {
    if (entries.length === 0) return null;
    const Icon = icon;
    return (
      <span className="panel-inbound-group" data-kind={kind}>
        <Icon size={11} className="panel-inbound-icon" aria-hidden="true" />
        <span className="panel-inbound-group-label">{label}</span>
        {entries.map((e) => (
          <button
            key={`${e.kind}:${e.sourceTraceId}:${e.fromNodeId}`}
            type="button"
            className="panel-inbound-chip"
            title={
              kind === "fork"
                ? `forked from ${e.fromNodeId.slice(0, 8)}…\nby ${e.ownerPubkey.slice(0, 12)}…\ntrace ${e.sourceEventId}`
                : `cited by ${e.ownerPubkey.slice(0, 12)}…\ntrace ${e.sourceEventId}`
            }
            onMouseDown={(ev) => {
              ev.stopPropagation();
              onOpen(e.sourceTraceId);
            }}
          >
            <span className="panel-inbound-chip-name">{fallback(e)}</span>
          </button>
        ))}
      </span>
    );
  };

  return (
    <div className="panel-inbound-row" aria-label="Inbound citations and forks">
      <button
        type="button"
        className="panel-inbound-summary"
        title={
          freshnessLabel
            ? `Inbound result is ${freshnessLabel}`
            : hasInbound
              ? expanded
                ? "Collapse inbound traces"
                : "Expand inbound traces"
              : "No inbound traces or citations"
        }
        aria-expanded={hasInbound ? expanded : undefined}
        disabled={!hasInbound}
        onMouseDown={(e) => {
          e.stopPropagation();
          setExpanded((v) => !v);
        }}
      >
        <span>
          CITATIONS IN: {inbound.length}{freshnessLabel ? ` · ${freshnessLabel}` : ""}
        </span>
      </button>
      {hasInbound && expanded && (
        <>
          {renderGroup("fork", GitFork, "forked by", forks)}
          {renderGroup("cite", Quote, "cited by", incomingCitations)}
        </>
      )}
    </div>
  );
}

function AttestationRow({ count }: { count: number }) {
  const label = `${count} reachable attestation${count === 1 ? "" : "s"}`;
  return (
    <div className="panel-attestation-row" aria-label={label} title={label}>
      <span>ATTESTATIONS: {count}</span>
    </div>
  );
}

interface OutgoingCitation extends CitationChip {
  /** True when a resolved `[[ phrase | nodeId ]]` in the current body points here. */
  quoted: boolean;
  /** Explicit no-body citation; removable without editing document text. */
  removable: boolean;
}

function CitationChips({
  chips,
  readOnly,
  onOpen,
  onRemove,
}: {
  chips: OutgoingCitation[];
  readOnly: boolean;
  onOpen: (nodeId: string) => void;
  onRemove: (nodeId: string) => void;
}) {
  if (chips.length === 0) return null;
  return (
    <div className="panel-cites" aria-label="Outgoing citations">
      {chips.map((c) => {
        const stepsBehind = c.stepsBehind ?? 0;
        const behindLabel = stepsBehind > 999 ? "999+" : String(stepsBehind);
        let stepState = "Target trace head unavailable";
        if (c.availability === "revoked") {
          stepState = "Target has an author-signed relay revocation request";
        } else if (c.availability === "in-oblivion") {
          stepState = "Target is in Oblivion and opens read-only";
        } else if (c.availability === "deleted") {
          stepState = "Target trace is deleted; no retained Oblivion copy is known to this press";
        } else if (c.availability === "unavailable") {
          stepState = "Target Step is currently unavailable; revocation is not verified";
        } else if (c.stepsBehind != null) {
          stepState =
            stepsBehind > 0
              ? `${stepsBehind} Step${stepsBehind === 1 ? "" : "s"} behind current trace`
              : "Current trace Step";
        }
        const availabilityLabel =
          c.availability && c.availability !== "available"
            ? ` · ${c.availability === "in-oblivion" ? "in Oblivion" : c.availability}`
            : "";
        return (
          <span
            key={c.nodeId}
            className={
              "panel-cite" +
              (c.kind === "coin" ? " panel-cite-coin" : "") +
              (c.quoted ? " panel-cite-quoted" : "") +
              (c.availability ? ` panel-cite-${c.availability}` : "")
            }
            title={`${c.quoted ? "Quoted in text" : "Citation without a body quote"}\nCites Step ${c.nodeId}\n${stepState}`}
          >
            <button
              type="button"
              className="panel-cite-open"
              onMouseDown={(e) => {
                e.stopPropagation();
                onOpen(c.nodeId);
              }}
            >
              {stepsBehind > 0 ? (
                <span
                  className="panel-cite-behind-count"
                  aria-label={stepState}
                >
                  {behindLabel}
                </span>
              ) : null}
              {c.quoted ? <Quote size={11} aria-hidden="true" /> : <Layers3 size={11} aria-hidden="true" />}
              <span className="panel-cite-name">{c.name}</span>
              <span className="panel-cite-state">
                {c.quoted ? "quoted" : "cited"}{availabilityLabel}
              </span>
            </button>
            {c.removable && !readOnly && (
              <button
                type="button"
                className="panel-cite-remove"
                aria-label={`Remove citation to ${c.name}`}
                onMouseDown={(e) => {
                  e.stopPropagation();
                  onRemove(c.nodeId);
                }}
              >
                ×
              </button>
            )}
          </span>
        );
      })}
    </div>
  );
}

/** One candidate sibling trace for the citation picker: its path (for the
 *  autocomplete label) and its current head nodeId (the `q`-edge target). */
interface TraceCandidate {
  path: string;
  nodeId: string;
  traceId?: string;
}

// --- citation picker ---------------------------------------------------
//
// The button after the outgoing citation list opens an autocomplete over the
// current folder's file basenames; selecting one adds its head nodeId to
// FileState.citationIds, the protocol's no-body citation representation
// (`q` + `tag-add`).
//
// Disabled for read-only/foreign folders and for
// files that haven't stepped yet (no nodeId to cite). Candidates with no nodeId
// are filtered out — you can't cite what hasn't been stepped.
function CitationPicker({
  candidates,
  alreadyCited,
  disabled,
  disabledTitle,
  onActivate,
  onPick,
}: {
  candidates: TraceCandidate[];
  alreadyCited: string[];
  disabled: boolean;
  disabledTitle?: string;
  onActivate: () => void;
  onPick: (nodeId: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const [open, setOpen] = useState(false);
  const trimmed = draft.trim().toLowerCase();
  const cited = new Set(alreadyCited);
  const matches = trimmed
    ? candidates.filter(
        (c) =>
          c.path.toLowerCase().includes(trimmed) &&
          !cited.has(c.nodeId) &&
          // Don't suggest the basename of a path identical to the draft — the
          // picker is for citing *other* traces; typing the full current name
          // is the common miscue, so we still show it but the caller dedupes.
          true,
      )
    : [];
  function pick(c: TraceCandidate) {
    onPick(c.nodeId);
    setDraft("");
    setOpen(false);
  }

  return (
    <div className="panel-cite-picker">
      <button
        type="button"
        className="panel-cite-add"
        title={disabled ? disabledTitle ?? "Step this file before inserting citations" : "Insert citation"}
        aria-expanded={!disabled && open}
        disabled={disabled}
        onClick={() => {
          onActivate();
          setOpen((v) => !v);
        }}
      >
        Add Citation
      </button>
      {open && !disabled && (
        <div className="panel-cite-picker-pop">
          <input
            className="panel-tag-input"
            type="text"
            value={draft}
            placeholder="file name…"
            size={10}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                if (matches[0]) pick(matches[0]);
              } else if (e.key === "Escape") {
                e.preventDefault();
                setOpen(false);
                setDraft("");
              }
            }}
          />
          {matches.length > 0 && (
            <ul className="panel-cite-picker-list">
              {matches.slice(0, 8).map((c) => (
                <li key={c.nodeId}>
                  <button
                    type="button"
                    className="panel-cite-picker-item"
                    onClick={() => pick(c)}
                  >
                    {systemPathDisplayName(c.path)}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

// --- event metadata bar ------------------------------------------------
//
// Shows provenance for a freshly sampled event — a kind badge, author, created
// date, origin relays, and event id — as a chip row mirroring the tag bar.
// Rendered only when the open file carries `eventMeta`, i.e. it was sampled
// from a relay this session (the field is in-memory only, so it disappears on
// reload, where the file reads as a normal clean document). The kind badge is
// the one place that tells a zine/trace event (4290/4291/4292) apart from a
// foreign one (kind 1 text note, etc.) the sampler happened to pick up.
function EventMetaBar({ meta }: { meta: SampleEventMeta }) {
  const date = new Date(meta.createdAt * 1000).toISOString().slice(0, 10);
  const kindLabel = meta.compatible
    ? `zine trace · ${meta.kind}`
    : `not a zine trace · kind ${meta.kind}`;
  const title = `event ${meta.eventId}\nauthor ${meta.pubkey}\nsampled from ${meta.relays.join(", ")}`;
  return (
    <div className="event-meta-bar" title={title} aria-label="Sampled event metadata">
      <span className={"event-meta-chip event-kind" + (meta.compatible ? "" : " foreign")}>
        {kindLabel}
      </span>
      <PubkeyDisplay pubkey={meta.pubkey} className="event-meta-chip event-meta-pubkey" />
      <span className="event-meta-chip">{date}</span>
      {meta.relays.map((r) => (
        <span key={r} className="event-meta-chip event-relay">
          {r.replace(/^wss?:\/\//, "")}
        </span>
      ))}
      <span className="event-meta-chip event-id">{meta.eventId.slice(0, 8)}</span>
    </div>
  );
}

// --- action palette definitions ---------------------------------------
//
// The persistent bottom palette binds AUTHOR, MODEL, and substrate voices to
// their operations. The selected AUTHOR key is the "pen" new typed text is
// attributed to; MODEL operations run as the selected model voice.

type PaletteRunningOp = OpKind | "mint";
type PaletteStatusOp = PaletteRunningOp | "scan" | "reify" | "fork";
type SummonStatus = {
  state: "idle" | "running" | "done" | "error";
  msg?: string;
  op?: PaletteStatusOp;
};

function isRunningPaletteOp(op?: PaletteStatusOp): op is PaletteRunningOp {
  return op !== undefined && op !== "scan" && op !== "reify" && op !== "fork";
}

const AI_PALETTE_ROW = resolveAiPaletteRegistry()[0];

// Author ops (Step or Mint / Send / Attest) live in the palette's AUTHOR row
// but are not LLM ops — they step, mint, send, or attest the trace, signed as
// the selected voice. Split out so the palette doesn't provider-gate them (you
// can step with no model
// configured). Three stances toward content (protocol §8, §R11.24): Step is
// the local checkpoint (home relay only — "record for yourself"); Send is the
// discussion stance ("I want to talk about this" — Steps pending changes, then
// fans out; otherwise sends the latest Step); Attest is the commitment stance ("I stand behind this"
// — a rare, deliberate act marking a sent node as published position, opens a
// modal for geohash + timestamp acknowledgment). Per spec, Attest still targets
// a Sent node; the confirmation gesture composes Step and Send when required.
const PALETTE_DELIVER: { op: "send" | "attest"; label: string; title: string; cls: string }[] = [
  { op: "send", label: "Send", title: "Open this trace for discussion — Step pending changes, otherwise send the latest Step", cls: "op-send" },
  { op: "attest", label: "Attest", title: "Mark this sent node as your published position — pin a geohash + acknowledge the timestamp", cls: "op-attest" },
];

function PaletteStatus({
  row,
  status,
}: {
  row: PaletteStatusRow;
  status: SummonStatus;
}) {
  if (paletteStatusRow(status.op) !== row) return null;
  if (status.state === "error" && status.msg) {
    return (
      <span className="action-palette-action-error" title={status.msg} role="status">
        {status.msg}
      </span>
    );
  }
  if (status.state === "done") {
    const message = paletteStatusMessage(status.op, status.msg);
    return message ? (
      <span className="action-palette-action-done" title="Op completed" role="status">
        {message}
      </span>
    ) : null;
  }
  return null;
}

// The AUTHOR row's leftmost label is itself a control — click it to re-roll the
// alias that names the typing voice. Purely cosmetic (the underlying key is
// unaffected); a small piece of personality for the press. Clicking picks a
// random *other* alias from the set, so a click always changes it. Persisted
// per-browser so a chosen name survives reload.
const AUTHOR_LABEL_KEY = "zine.authorLabel";
const AUTHOR_ALIASES = ["AUTHOR", "USER", "OPERATOR", "WRITER", "MANUAL", "HUMAN", "YOU", "ME"] as const;
function rollAuthorAlias(excluding: string): string {
  const others = AUTHOR_ALIASES.filter((a) => a !== excluding);
  return others[Math.floor(Math.random() * others.length)];
}

function rollAlias(aliases: readonly string[], excluding: string): string {
  const others = aliases.filter((alias) => alias !== excluding);
  return others[Math.floor(Math.random() * others.length)];
}

// --- substrate bar -----------------------------------------------------
//
// The palette's lower row mirrors the AUTHOR row, but cycles the EXTERNAL
// substrate (the foreign party a scan reads from / a reify writes to) instead
// of the internal typing voice. The substrate is a peer with a voice: scanned
// content is attributed to it, same provenance shape as a mesh peer's
// contribution. Scan and reify are the two actions — acquisition and emission
// instants against a substrate the app has no continuous bond with.
//
// The labels cycle on click (FILESYSTEM → LAPTOP → DESKTOP → EXTERNAL → …).
// Persisted per-browser so the chosen substrate survives reload.
const SUBSTRATE_LABEL_KEY = "zine.substrateLabel";
const SUBSTRATES = ["FILESYSTEM", "LAPTOP", "DESKTOP", "EXTERNAL"] as const;
type Substrate = (typeof SUBSTRATES)[number];
function nextSubstrate(cur: Substrate): Substrate {
  const i = SUBSTRATES.indexOf(cur);
  return SUBSTRATES[(i + 1) % SUBSTRATES.length];
}

// --- voice key selector ------------------------------------------------
//
// Native <select> option rendering is controlled by the OS/browser, so an
// option's per-voice color and font are unreliable or ignored altogether.
// This listbox keeps the same compact closed control while rendering every
// prospective voice in its own visual identity. It is shared by the AUTHOR,
// MODEL, and substrate rows so all three role assignments behave identically.
function VoiceKeySelect({
  keys,
  selectedId,
  onSelect,
  ariaLabel,
}: {
  keys: KeyEntry[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  ariaLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const listboxId = useId();
  const selectedIndex = keys.findIndex((key) => key.id === selectedId);
  const selected = selectedIndex >= 0 ? keys[selectedIndex] : null;
  function openListbox(preferredIndex = selectedIndex >= 0 ? selectedIndex : 0) {
    if (keys.length === 0) return;
    setActiveIndex(Math.max(0, Math.min(preferredIndex, keys.length - 1)));
    setOpen(true);
  }

  function closeListbox({ restoreFocus = false } = {}) {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }

  function focusOption(index: number) {
    if (keys.length === 0) return;
    setActiveIndex(Math.max(0, Math.min(index, keys.length - 1)));
  }

  function choose(key: KeyEntry) {
    onSelect(key.id);
    closeListbox({ restoreFocus: true });
  }

  // Close on an outside press. Escape and Tab are handled on the focused
  // trigger/option so focus restoration follows the correct interaction.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        closeListbox();
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  // The options use roving tab focus. Focusing the selected option on open
  // makes Arrow/Home/End navigation work without introducing extra tab stops.
  useLayoutEffect(() => {
    if (open && activeIndex >= 0) optionRefs.current[activeIndex]?.focus();
  }, [activeIndex, open]);

  function onTriggerKeyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const fallback = event.key === "ArrowDown" ? 0 : keys.length - 1;
      openListbox(selectedIndex >= 0 ? selectedIndex : fallback);
    } else if (event.key === "Escape" && open) {
      event.preventDefault();
      closeListbox({ restoreFocus: true });
    }
  }

  function onOptionKeyDown(event: React.KeyboardEvent<HTMLButtonElement>, index: number) {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        focusOption(index + 1);
        break;
      case "ArrowUp":
        event.preventDefault();
        focusOption(index - 1);
        break;
      case "Home":
        event.preventDefault();
        focusOption(0);
        break;
      case "End":
        event.preventDefault();
        focusOption(keys.length - 1);
        break;
      case "Enter":
      case " ":
        event.preventDefault();
        choose(keys[index]);
        break;
      case "Escape":
        event.preventDefault();
        closeListbox({ restoreFocus: true });
        break;
      case "Tab":
        closeListbox();
        break;
      default: {
        // Preserve the native selector's quick letter navigation. Repeated
        // letters cycle through voices whose labels share that initial.
        if (event.key.length !== 1 || event.metaKey || event.ctrlKey || event.altKey) break;
        const needle = event.key.toLocaleLowerCase();
        const ordered = [...keys.slice(index + 1), ...keys.slice(0, index + 1)];
        const match = ordered.find((key) => key.label.trim().toLocaleLowerCase().startsWith(needle));
        if (!match) break;
        event.preventDefault();
        focusOption(keys.findIndex((key) => key.id === match.id));
      }
    }
  }

  return (
    <div
      ref={rootRef}
      className={`action-palette-key-picker${open ? " is-open" : ""}`}
    >
      <VoiceChip
        ref={triggerRef}
        className="action-palette-key-control"
        label={selected?.label || "choose voice…"}
        pubkey={selected?.pubkey}
        identity={selected?.identity}
        leading={<span className="action-palette-key-chevron" aria-hidden="true">▾</span>}
        actionProps={{
          "aria-label": ariaLabel,
          "aria-haspopup": "listbox",
          "aria-expanded": open,
          "aria-controls": listboxId,
          disabled: keys.length === 0,
          onClick: () => (open ? closeListbox() : openListbox()),
        }}
        actionClassName="action-palette-key-trigger"
        onKeyDown={onTriggerKeyDown}
      />
      {open && (
        <div
          id={listboxId}
          className="action-palette-key-listbox"
          role="listbox"
          aria-label={`${ariaLabel} choices`}
        >
          {keys.map((key, index) => {
            const isSelected = key.id === selectedId;
            return (
              <VoiceChip
                key={key.id}
                ref={(node) => { optionRefs.current[index] = node; }}
                className="action-palette-key-option"
                label={key.label || "Voice"}
                pubkey={key.pubkey}
                identity={key.identity}
                selected={isSelected}
                actionProps={{
                  role: "option",
                  "aria-selected": isSelected,
                  tabIndex: index === activeIndex ? 0 : -1,
                  onFocus: () => setActiveIndex(index),
                  onClick: () => choose(key),
                }}
                copyTabIndex={-1}
                onKeyDown={(event) => onOptionKeyDown(event, index)}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

// --- AI model selector -------------------------------------------------
//
// Mirrors VoiceKeySelect's chip + upward-opening listbox instead of falling
// back to browser-native <select> chrome. Models do not carry voice identity,
// but sharing VoiceChip keeps both palette selectors visually and behaviorally
// aligned.
function ModelProviderSelect({
  providers,
  selectedId,
  onSelect,
}: {
  providers: ProviderConfig[];
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const listboxId = useId();
  const selectedIndex = providers.findIndex((provider) => provider.id === selectedId);
  const selected = selectedIndex >= 0 ? providers[selectedIndex] : null;
  const providerLabel = (provider: ProviderConfig) =>
    provider.label || provider.modelId || provider.id;

  function openListbox(preferredIndex = selectedIndex >= 0 ? selectedIndex : 0) {
    if (providers.length === 0) return;
    setActiveIndex(Math.max(0, Math.min(preferredIndex, providers.length - 1)));
    setOpen(true);
  }

  function closeListbox({ restoreFocus = false } = {}) {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }

  function focusOption(index: number) {
    if (providers.length === 0) return;
    setActiveIndex(Math.max(0, Math.min(index, providers.length - 1)));
  }

  function choose(provider: ProviderConfig) {
    onSelect(provider.id);
    closeListbox({ restoreFocus: true });
  }

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        closeListbox();
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  useLayoutEffect(() => {
    if (open && activeIndex >= 0) optionRefs.current[activeIndex]?.focus();
  }, [activeIndex, open]);

  function onTriggerKeyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const fallback = event.key === "ArrowDown" ? 0 : providers.length - 1;
      openListbox(selectedIndex >= 0 ? selectedIndex : fallback);
    } else if (event.key === "Escape" && open) {
      event.preventDefault();
      closeListbox({ restoreFocus: true });
    }
  }

  function onOptionKeyDown(event: React.KeyboardEvent<HTMLButtonElement>, index: number) {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        focusOption(index + 1);
        break;
      case "ArrowUp":
        event.preventDefault();
        focusOption(index - 1);
        break;
      case "Home":
        event.preventDefault();
        focusOption(0);
        break;
      case "End":
        event.preventDefault();
        focusOption(providers.length - 1);
        break;
      case "Enter":
      case " ":
        event.preventDefault();
        choose(providers[index]);
        break;
      case "Escape":
        event.preventDefault();
        closeListbox({ restoreFocus: true });
        break;
      case "Tab":
        closeListbox();
        break;
      default: {
        if (event.key.length !== 1 || event.metaKey || event.ctrlKey || event.altKey) break;
        const needle = event.key.toLocaleLowerCase();
        const ordered = [
          ...providers.slice(index + 1),
          ...providers.slice(0, index + 1),
        ];
        const match = ordered.find((provider) =>
          providerLabel(provider).trim().toLocaleLowerCase().startsWith(needle),
        );
        if (!match) break;
        event.preventDefault();
        focusOption(providers.findIndex((provider) => provider.id === match.id));
      }
    }
  }

  return (
    <div
      ref={rootRef}
      className={`action-palette-key-picker action-palette-model-picker${open ? " is-open" : ""}`}
    >
      <VoiceChip
        ref={triggerRef}
        className="action-palette-key-control action-palette-model-control"
        label={selected ? providerLabel(selected) : "Choose a model…"}
        leading={<span className="action-palette-key-chevron" aria-hidden="true">▾</span>}
        actionProps={{
          "aria-label": "Model for AI ops",
          "aria-haspopup": "listbox",
          "aria-expanded": open,
          "aria-controls": listboxId,
          title: "Model for AI ops",
          disabled: providers.length === 0,
          onClick: () => (open ? closeListbox() : openListbox()),
        }}
        actionClassName="action-palette-key-trigger action-palette-model-trigger"
        onKeyDown={onTriggerKeyDown}
      />
      {open && (
        <div
          id={listboxId}
          className="action-palette-key-listbox action-palette-model-listbox"
          role="listbox"
          aria-label="Model for AI ops choices"
        >
          {providers.map((provider, index) => {
            const isSelected = provider.id === selectedId;
            return (
              <VoiceChip
                key={provider.id}
                ref={(node) => { optionRefs.current[index] = node; }}
                className="action-palette-key-option action-palette-model-option"
                label={providerLabel(provider)}
                selected={isSelected}
                actionProps={{
                  role: "option",
                  "aria-selected": isSelected,
                  tabIndex: index === activeIndex ? 0 : -1,
                  onFocus: () => setActiveIndex(index),
                  onClick: () => choose(provider),
                }}
                onKeyDown={(event) => onOptionKeyDown(event, index)}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}


// --- action palette ----------------------------------------------------
//
// The single always-visible palette at the bottom of the press. Three voice
// groups keep identity/model controls at the left and wrap their actions at the
// right; Replay follows them as the final row:
//   AUTHOR:    | pen | Step/Mint Send Attest · · | — | — | err | —
//   AI:        | inj | model▾ Analyze Reply Extend Stir Settle Run · 1.2k
//   FILESYSTEM | key | Scan File Scan Folder Reify Trace Open Trace | — | — | — | —
//   REPLAY:    | targets | ▶ N× [slider]
//              |         | ⏮ ◀ [n/latest] ▶ ⏭ · current frame
// The MODEL row leads with its role label, then its voice; the provider selector
// is the first inline control to the voice's right. Five equal action tracks;
// AUTHOR uses the first three, MODEL fills all five. An
// in-flight op re-renders its OWN button as the stop control (accent + pulse;
// click again to abort) instead of a separate Stop button, so the affordance
// stays where the click that started it landed. Ops gate on the outlined
// target.
function DesktopExtendReviewStrip({
  items,
  busyKey,
  error,
  hasPrevious,
  hasMore,
  loadingMore,
  onAction,
  onPrevious,
  onMore,
}: {
  items: readonly DesktopOperationReviewItemV1[];
  busyKey: string | null;
  error: string | null;
  hasPrevious: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  onAction: (
    item: DesktopOperationReviewItemV1,
    action: DesktopOperationReviewActionV1,
  ) => void;
  onPrevious: () => void;
  onMore: () => void;
}) {
  if (items.length === 0 && !error && !hasPrevious && !hasMore) return null;
  return (
    <section className="desktop-extend-review" aria-label="Local AI draft review">
      {error && <p className="desktop-extend-review-error">{error}</p>}
      {items.map((item) => {
        const key = `${item.key.operationId}\0${item.key.attemptId}`;
        const busy = key === busyKey;
        const preview = item.responseText?.replace(/\s+/g, " ").trim() ?? "";
        return (
          <div className="desktop-extend-review-row" data-status={item.status} key={key}>
            <span className="desktop-extend-review-local">LOCAL</span>
            <span className="desktop-extend-review-copy">
              <strong>{item.label}</strong>
              <span>{item.targetPath} · {item.detail}</span>
              {preview && (
                <details className="desktop-extend-review-response">
                  <summary>{preview}</summary>
                  <pre>{item.responseText}</pre>
                </details>
              )}
            </span>
            <span className="desktop-extend-review-actions">
              {item.actions.map((action) => (
                <button
                  type="button"
                  className={action === "accept"
                    ? "primary"
                    : action === "retry-possible-duplicate" || action === "reprepare-possible-duplicate"
                      ? "caution"
                      : ""}
                  disabled={busy}
                  key={action}
                  onClick={() => onAction(item, action)}
                >
                  {busy ? "Working…" : desktopReviewActionLabel(action)}
                </button>
              ))}
            </span>
          </div>
        );
      })}
      {(hasPrevious || hasMore) && (
        <span className="desktop-extend-review-actions">
          {hasPrevious && (
            <button type="button" disabled={loadingMore} onClick={onPrevious}>Previous</button>
          )}
          {hasMore && (
            <button type="button" disabled={loadingMore} onClick={onMore}>
              {loadingMore ? "Loading…" : "More / Next"}
            </button>
          )}
        </span>
      )}
    </section>
  );
}

function desktopReviewActionLabel(action: DesktopOperationReviewActionV1): string {
  switch (action) {
    case "accept": return "Accept locally";
    case "reject": return "Reject";
    case "retry": return "Retry";
    case "retry-possible-duplicate": return "Retry (may duplicate)";
    case "abandon": return "Abandon";
    case "reprepare": return "Re-prepare";
    case "reprepare-possible-duplicate": return "Re-prepare (may duplicate)";
    case "resume": return "Resume";
  }
}

function ActionPalette({
  replayTransport,
  keys,
  authorKeyId,
  modelKeyId,
  onChooseAuthorKey,
  onChooseModelKey,
  providers,
  resolvedModelProviderId,
  onSelectProvider,
  selection,
  runningOp,
  onOp,
  onStop,
  opStatus,
  tokenEstimate,
  /** Open the prompt inspector for a prepared MODEL operation. */
  onInspect,
  attestPlan,
  targetInScope,
  coinsEnabled,
  /** Semantic state of the focused editor passage. Mutates the AUTHOR primary
   *  slot between Step, Mint, disabled Coin, and disabled invalid Mint. */
  authorSelectionState,
  /** True when Send will append a Step before distributing it. */
  sendAutoSteps,
  /** True when Step has updates to record, or must create the first node. */
  stepAvailable,
  /** Wrap the selected loose passage in double square brackets. */
  onPreserve,
  substrate,
  onChooseSubstrate,
  substrateKeyId,
  onChooseSubstrateKey,
  onScan,
  onReifyOp,
  onOpenTrace,
  replayFrozen,
  onForkReplay,
}: {
  /** Replay slider + stepper, rendered as the palette's first row. */
  replayTransport: React.ReactNode;
  keys: KeyEntry[];
  /** The AUTHOR (typing + Save/send) voice's key id. */
  authorKeyId: string | null;
  /** The MODEL (LLM ops) voice's key id. */
  modelKeyId: string | null;
  onChooseAuthorKey: (id: string) => void;
  onChooseModelKey: (id: string) => void;
  /** Configured providers for the model select (MODEL-side mode cell). */
  providers: ProviderConfig[];
  /** Resolved provider id for the MODEL voice, derived in App and passed down
   *  (same shape as substrateKeyId) so the dropdown's value is always current. */
  resolvedModelProviderId: string;
  /** Pin which provider LLM ops run against (the MODEL voice's). */
  onSelectProvider: (providerId: string) => void;
  /** The currently-outlined trace, or null. Drives which actions are live. */
  selection: UiFocus | null;
  /** Which op kind is in flight on the target panel, or null when idle. The
   *  button for this op re-renders as the live stop control — click it again
   *  to abort — instead of spawning a separate Stop button. */
  runningOp: PaletteRunningOp | null;
  /** Run an op against the op-target panel. */
  onOp: (op: OpKind) => void;
  /** Stop the in-flight op on the target panel. */
  onStop: () => void;
  /** Status of the op-target panel, for the action row's stop/error. */
  opStatus: SummonStatus;
  /** Approximate prompt token count for an op on the target file, or null when
   *  prompt preparation is unavailable. Shown as optional detail inside the
   *  persistent prompt-inspector control. */
  tokenEstimate: number | null;
  /** Open the prompt inspector modal, optionally selecting an operation. */
  onInspect: (operation?: PromptOpKind) => void;
  /** Prerequisites the Attest gesture will compose before endorsement. */
  attestPlan: AttestationPlan;
  /** Whether the focused/target file is inside the scope subtree. When false,
   *  write ops (Step/Send/Extend/Stir/Settle/Reply) disable — content must not
   *  travel without its orchestration. Read actions are unaffected. Attest only
   *  requires scope when it must create a new Step;
   *  endorsing or ensuring reachability of an existing exact node does not
   *  write into the target content. */
  targetInScope: boolean;
  /** The Coins discovery opt-in gates Mint; ordinary citation remains core. */
  coinsEnabled: boolean;
  /** Semantic state of the focused editor passage presented by the palette. */
  authorSelectionState: PaletteSelectionState;
  /** Whether Send's delivery plan is append-and-send rather than send-latest. */
  sendAutoSteps: boolean;
  /** Whether the focused trace has work for an explicit Step. */
  stepAvailable: boolean;
  /** Preserve the live loose-text selection by wrapping it in `[[ ]]`. */
  onPreserve: () => void;
  /** The currently-selected external substrate (the lower bar). */
  substrate: Substrate;
  /** Cycle/pick the substrate. */
  onChooseSubstrate: (s: Substrate) => void;
  /** The keychain key id signing scans for the current substrate, or null when
   *  no signer is wired (the dropdown shows blank until the first scan
   *  auto-provisions one, or until the user picks one). */
  substrateKeyId: string | null;
  /** Pin which keychain key signs scans for the current substrate. */
  onChooseSubstrateKey: (id: string) => void;
  /** Open the matching native picker and acquire a foreign snapshot. */
  onScan: (kind: "file" | "folder") => void;
  /** Reify exact stepped snapshots to a picked destination folder. */
  onReifyOp: () => void;
  /** Open a signed trace locator for verified, read-only inspection. */
  onOpenTrace: () => void;
  /** True when the op-target panel is parked on a replay-frozen historical
   *  step. Gates the AUTHOR row's Fork action — the only way to edit a
   *  read-only historical version (seeds a new trace from that step). */
  replayFrozen: boolean;
  /** Fork the replayed snapshot into a new editable trace. */
  onForkReplay: () => void;
}) {
  // --- AUTHOR alias label -----------------------------------------------
  // Cosmetic click-to-reroll for the AUTHOR row's label. Persisted so a chosen
  // name survives reload; clicking jumps to a random *other* alias.
  const [authorAlias, setAuthorAlias] = useState<string>(() => {
    const stored = localStorage.getItem(AUTHOR_LABEL_KEY);
    return stored && (AUTHOR_ALIASES as readonly string[]).includes(stored) ? stored : "AUTHOR";
  });
  const [modelAlias, setModelAlias] = useState<string>(() => {
    const stored = localStorage.getItem(AI_PALETTE_ROW.label.storageKey);
    return stored && AI_PALETTE_ROW.label.aliases.includes(stored)
      ? stored
      : AI_PALETTE_ROW.label.defaultLabel;
  });

  // --- ACTIONS gating ---------------------------------------------------
  const kind = selection?.kind;
  const allowTextOps = kind === "file";
  const allowReply = kind === "file" || kind === "coin";
  const allowDeliver = kind === "file" || kind === "folder";
  const immutableMint = kind === "file" && !!selection?.path && isMint(selection.path);
  // Focus-∈-scope invariant: write ops need both the right selection KIND and
  // the target to be inside the scope subtree.
  const scopedText = allowTextOps && targetInScope;
  const scopedReply = allowReply && targetInScope;
  const scopedDeliver = allowDeliver && targetInScope;
  const hasProviders = providers.length > 0;
  const primaryAction = palettePrimaryAction(authorSelectionState);
  const secondaryActions = paletteSecondaryActions(authorSelectionState);
  const hasMintablePassage =
    authorSelectionState === "loose" || authorSelectionState === "pending";
  const attestCreatesStep = attestPlan === "append-send-attest";
  const attestAutoSends =
    attestPlan === "append-send-attest" || attestPlan === "send-attest";

  // Every group keeps label + voice in two stable columns, then places its
  // buttons in a wrapping flex region. An in-flight op re-renders its own
  // button as the live stop control (accent + pulse; click again to abort), so
  // the affordance stays where the click happened even after wrapping.
  return (
    <div className="action-palette">
      <div className="action-palette-group">
        <button
          type="button"
          className="action-palette-label action-palette-label-clickable"
          title="Click to update label in view; no effect on behavior"
          onClick={() => {
            const next = rollAuthorAlias(authorAlias);
            localStorage.setItem(AUTHOR_LABEL_KEY, next);
            setAuthorAlias(next);
          }}
        >
          {authorAlias}:
        </button>
        <VoiceKeySelect
          keys={keys}
          selectedId={authorKeyId}
          onSelect={onChooseAuthorKey}
          ariaLabel="Author voice"
        />
        <div className="action-palette-actions">
          {(() => {
            const isRunning = runningOp === "step" || runningOp === "mint";
            const enabled =
              !runningOp &&
                primaryAction.actionable &&
                (hasMintablePassage || stepAvailable) &&
                (hasMintablePassage ? targetInScope : scopedDeliver) &&
                (!hasMintablePassage || coinsEnabled) &&
                !immutableMint &&
                !replayFrozen;
            return (
              <button
                type="button"
                className={`action-palette-action op-save action-palette-primary action-palette-primary--${primaryAction.tone}${isRunning ? " running" : ""}`}
                data-palette-selection={authorSelectionState}
                disabled={isRunning || !enabled}
                title={
                  isRunning
                    ? runningOp === "mint"
                      ? "Mint public transaction in progress"
                      : "Step in progress"
                    : hasMintablePassage && !coinsEnabled
                      ? "Enable Coins in Networking to Mint this passage"
                    : primaryAction.title
                }
                onClick={() => onOp("step")}
              >
                {isRunning ? (runningOp === "mint" ? "Minting…" : "Stepping…") : primaryAction.label}
              </button>
            );
          })()}
          {PALETTE_DELIVER.map((v) => {
            if (v.op === "send" && secondaryActions.preserve) {
              return (
                <button
                  key="preserve"
                  type="button"
                  className="action-palette-action op-preserve"
                  disabled={!!runningOp || immutableMint || replayFrozen}
                  title="Wrap the selected passage in [[ ]] so it endures"
                  onClick={onPreserve}
                >
                  Preserve
                </button>
              );
            }
            const visible = v.op === "send" ? secondaryActions.send : secondaryActions.attest;
            if (!visible) return null;
            // This op is the one in flight: the button becomes the stop control.
            const isRunning = runningOp === v.op;
            // Attest can compose its own Step/Send prerequisites. A composed Step
            // still obeys the same scope and replay gates as the explicit action.
            const deliverGate =
              v.op === "attest"
                ? (allowDeliver || authorSelectionState === "coin") &&
                  (!attestCreatesStep || (scopedDeliver && !immutableMint && !replayFrozen))
                : v.op === "send" && immutableMint
                  ? true
                  : scopedDeliver && !immutableMint;
            const enabled =
              isRunning ||
              (!runningOp && deliverGate && (v.op !== "attest" || attestPlan !== "unavailable"));
            const createsStep =
              (v.op === "send" && sendAutoSteps) ||
              (v.op === "attest" && attestCreatesStep);
            const sends = v.op === "send" || (v.op === "attest" && attestAutoSends);
            return (
              <button
                key={v.op}
                type="button"
                className={`action-palette-action ${v.cls}${isRunning ? " running" : ""}${createsStep ? " action-palette-action--auto-step" : ""}${sends ? " action-palette-action--sends" : ""}`}
                disabled={!enabled}
                title={
                  isRunning
                    ? `${v.label} — running, click to stop`
                    : v.op === "send" && sendAutoSteps
                      ? "Step the pending trace, then Send it for discussion"
                      : v.op === "attest" && attestPlan === "append-send-attest"
                        ? "Step and Send this draft, then Attest that exact version"
                        : v.op === "attest" && attestPlan === "send-attest"
                          ? "Send this Step, then Attest that exact version"
                      : v.title
                }
                onClick={() => (isRunning ? onStop() : onOp(v.op))}
              >
                {v.label}
              </button>
            );
          })}
          {/* Fork is contextual: mounting it only on a replay-frozen step keeps
              the normal AUTHOR row to the same three fixed tracks as FILESYSTEM. */}
          {replayFrozen && (
            <button
              type="button"
              className="action-palette-action action-palette-action-fork"
              title="Fork this historical version into a new editable trace"
              onClick={onForkReplay}
            >
              Fork
            </button>
          )}
          <PaletteStatus row="author" status={opStatus} />
        </div>
      </div>

      <div className="action-palette-group action-palette-model-row">
        <button
          type="button"
          className="action-palette-label action-palette-label-clickable"
          title={AI_PALETTE_ROW.label.rerollTitle}
          onClick={() => {
            const next = rollAlias(AI_PALETTE_ROW.label.aliases, modelAlias);
            localStorage.setItem(AI_PALETTE_ROW.label.storageKey, next);
            setModelAlias(next);
          }}
        >
          {modelAlias}:
        </button>
        <VoiceKeySelect
          keys={keys}
          selectedId={modelKeyId}
          onSelect={onChooseModelKey}
          ariaLabel={AI_PALETTE_ROW.voice.ariaLabel}
        />
        <div className="action-palette-actions">
          {AI_PALETTE_ROW.providerSelection.capability === "voice-pinned" && (
            <div className="action-palette-model-cell">
              <ModelProviderSelect
                providers={providers}
                selectedId={resolvedModelProviderId}
                onSelect={onSelectProvider}
              />
            </div>
          )}
          <button
            type="button"
            className="action-palette-inspect"
            onClick={() => onInspect()}
            title={tokenEstimate == null
              ? "Inspect the exact prompt and any preparation blocker"
              : `Inspect the exact prompt · approximately ${formatTokens(tokenEstimate)}`}
          >
            Inspect
            {tokenEstimate != null && (
              <span className="action-palette-inspect-estimate">
                {formatTokens(tokenEstimate)}
              </span>
            )}
          </button>
          {AI_PALETTE_ROW.actions.map((action) => {
            const isRunning = runningOp === action.id;
            // extend/stir/settle write INTO the existing file, so they obey the
            // focus-∈-scope invariant (must not mutate content whose chain isn't
            // in context). analyze/reply/run create NEW docs/subfolders (analysis /
            // citing doc / agent run), so they're gated by kind only, not by scope.
            const createsDoc = action.id === "analyze" || action.id === "reply" || action.id === "run";
            const mutatesTarget = !createsDoc;
            const baseGate = action.id === "analyze" ? allowTextOps : mutatesTarget ? scopedText : scopedReply;
            const enabled =
              isRunning ||
              (!runningOp && hasProviders && baseGate);
            return (
              <button
                key={action.id}
                type="button"
                className={`action-palette-action ${action.className}${isRunning ? " running" : ""}`}
                disabled={!enabled}
                title={
                  isRunning
                    ? `${action.label} — running, click to stop`
                    : !hasProviders
                      ? "Configure a model in Models to use AI operations"
                      : action.title
                }
                onClick={() => {
                  if (isRunning) {
                    onStop();
                  } else if (action.kind === "operation") {
                    onInspect(action.id);
                  } else {
                    onOp(action.id);
                  }
                }}
              >
                {action.label}
              </button>
            );
          })}
          <PaletteStatus row="model" status={opStatus} />
        </div>
      </div>

      <div className="action-palette-group">
        {/* The SUBSTRATE row: mirrors the AUTHOR row but cycles the EXTERNAL
            substrate (the foreign party a scan reads from / a reify writes to)
            instead of the internal typing voice. Click the label to cycle
            (FILESYSTEM → LAPTOP → DESKTOP → EXTERNAL). Scan File, Scan
            Folder, and Reify Trace are desktop-only substrate actions. Open Trace
            verifies a signed locator without importing it. */}
        <button
          type="button"
          className="action-palette-label action-palette-label-clickable"
          title={`Click to cycle the substrate — currently ${substrate}`}
          onClick={() => onChooseSubstrate(nextSubstrate(substrate))}
        >
          {substrate}:
        </button>
        {/* The substrate's pen/voice/key: which keychain key signs scans from
            this substrate. Mirrors the AUTHOR row's voice selector. Null until the
            user picks one or the first scan auto-provisions. */}
        <VoiceKeySelect
          keys={keys}
          selectedId={substrateKeyId}
          onSelect={onChooseSubstrateKey}
          ariaLabel={`Signer for ${substrate}`}
        />
        <div className="action-palette-actions">
          <button
            type="button"
            className="action-palette-action op-scan op-scan-file"
            disabled={!isTauri()}
            title={isTauri() ? "Scan File: acquire one file as a new trace in the private Scan inbox; repeated scans add copies" : "Scanning is desktop-only (the substrate is the local disk)"}
            onClick={() => onScan("file")}
          >
            Scan File
          </button>
          <button
            type="button"
            className="action-palette-action op-scan"
            disabled={!isTauri()}
            title={isTauri() ? "Scan Folder: preserve one picked folder as a new batch in the private Scan inbox" : "Scanning is desktop-only (the substrate is the local disk)"}
            onClick={() => onScan("folder")}
          >
            Scan Folder
          </button>
          <button
            type="button"
            className="action-palette-action op-reify"
            disabled={!isTauri() || (opStatus.state === "running" && opStatus.op === "reify")}
            title={isTauri() ? "Reify exact stepped snapshots to ordinary files" : "Reifying is desktop-only (the substrate is the local disk)"}
            onClick={onReifyOp}
          >
            {opStatus.state === "running" && opStatus.op === "reify" ? "Reifying…" : "Reify Trace"}
          </button>
          <button
            type="button"
            className="action-palette-action op-open-trace"
            title="Open and verify a signed trace without importing it"
            onClick={onOpenTrace}
          >
            Open Trace
          </button>
          <PaletteStatus row="substrate" status={opStatus} />
        </div>
      </div>
      {replayTransport}
    </div>
  );
}

function Panel({
  panelIdx,
  tabs,
  activePath,
  file,
  directCoinComposer,
  folderId,
  replayStepText,
  replayPrevText,
  replayLiveText,
  replayNodeId,
  replayActionStatus,
  onReplaySend,
  onReplayAttest,
  active,
  focused,
  collapsed,
  onFocusPanel,
  onSelectTab,
  onCloseTab,
  onContextMenuTab,
  onEdit,
  onRemoveCitation,
  onView,
  onSelection,
  flash,
  draggingTab,
  dropTargetTab,
  onTabDragStart,
  onTabDragEnterTarget,
  onTabDragLeaveTarget,
  onDropOnTab,
  onDropOnListEnd,
  onDropOnRightEdge,
  edgeTargetActive,
  onEdgeEnter,
  onEdgeLeave,
  onTabDragEnd,
  voice,
  mode,
  onSetMode,
  voiceAttribution,
  selectedNodeId,
  scrollTarget,
  readOnly,
  replayFrozen,
  replayMounted,
  onSelectSpan,
  onCopySelection,
  onPasteSelection,
  onReplayEditAttempt,
  citations,
  taggedChips,
  inbound,
  inboundFreshness,
  attestationCount,
  onOpenCitation,
  traceCandidates,
  pickerDisabled,
  onAddCitation,
  citationDropAccept,
  onAddCitationByPath,
  citationBodyDropMarkup,
  mergeCandidates,
  mergeBusy,
  mergeSessionOpen,
  onIncorporateCandidate,
  mergeError,
  unsteppedPathSet,
  unsteppedEditCounts,
  tabIsInScope,
  completedCoinPaths,
}: {
  panelIdx: number;
  tabs: string[];
  activePath: string;
  file?: FileState;
  directCoinComposer: {
    phrase: string;
    enabled: boolean;
    busy: boolean;
    error: string | null;
    onPhraseChange: (phrase: string) => void;
    onMint: () => void;
    onClose: () => void;
  };
  /** The attached folder's id — needed to fetch this file's step chain for the
   *  in-place Diff surface. "" when no folder is attached. */
  folderId: string;
  /** When the replay stepper has frozen THIS file on a historical step, the
   *  step's content snapshot (else null). Drives replay-mode Diff. */
  replayStepText?: string | null;
  /** In replay mode, the previous content-step of this file (vs prev). */
  replayPrevText?: string | null;
  /** In replay mode, the untouched live working buffer. */
  replayLiveText?: string | null;
  /** Exact immutable node displayed by this replay tab. */
  replayNodeId?: string;
  replayActionStatus?: HistoricalActionStatus;
  onReplaySend?: () => void;
  onReplayAttest?: () => void;
  active: boolean;
  /** This live panel's active tab owns the singular semantic focus. */
  focused: boolean;
  /** The sidebar's collapsed-folder set, so a folder tab's icon can mirror the
   *  tree (open vs closed). Optional — omitted/empty reads as "all open". */
  collapsed?: Set<string>;
  onFocusPanel: () => void;
  onSelectTab: (path: string) => void;
  onCloseTab: (path: string) => void;
  /** Right-click on a tab in this panel opens the tab context menu. */
  onContextMenuTab: (e: React.MouseEvent, path: string) => void;
  onEdit: (runs: Run[], kedits: KEditLog) => void;
  onView?: (view: EditorView | null) => void;
  /** Reports this panel's editor selection range (or null when empty) up to
   *  App so the selection menu can open anchored to the selection head. */
  onSelection?: (sel: { from: number; to: number } | null) => void;
  flash: boolean;
  draggingTab: { fromPanel: number; path: string } | null;
  dropTargetTab: { panel: number; path: string | null } | null;
  onTabDragStart: (path: string) => void;
  onTabDragEnterTarget: (path: string | null) => void;
  onTabDragLeaveTarget: (path: string | null) => void;
  onDropOnTab: (path: string) => void;
  onDropOnListEnd: () => void;
  /** Drop on this panel's right edge → spawn a new column to its right. */
  onDropOnRightEdge: () => void;
  /** Whether this panel's right edge currently offers a new-column drop. */
  edgeTargetActive: boolean;
  onEdgeEnter: () => void;
  onEdgeLeave: () => void;
  onTabDragEnd: () => void;
  /** This panel's pen (pubkey); "" → editor uses the global active voice. */
  voice: string;
  /** Which surface the active file is shown on. */
  mode: Mode;
  /** Set the active file's surface explicitly (preview or markdown). */
  onSetMode: (mode: Mode) => void;
  /** Whether per-voice text color is shown. Global; passed through to the
   *  editor's voiceAttributionCompartment. Orthogonal to mode — applies in
   *  both preview and markdown. */
  voiceAttribution: boolean;
  /** nodeId of the selected coin, or "" when none — rings the matching
   *  `[[ span ]]` inside this panel's editor. */
  selectedNodeId: string;
  /** A doc range to scroll this panel's editor to — driven by folder replay so
   *  the action that produced the current step's deltas is brought into view.
   *  Pass null/undefined for panels not currently replaying. */
  scrollTarget?: { from: number; to: number } | null;
  /** Read-only while replay is frozen on a historical step or mid-playback —
   *  passed through to the editor's readOnlyCompartment. */
  readOnly: boolean;
  /** True only when this panel's active file is the replay-stepped (frozen
   *  historical) one. Drives the provisional/out-of-date border and the fork
   *  affordance. False at `last`, on membership steps, or when not replaying. */
  replayFrozen: boolean;
  /** True for panels spawned by kedit playback. Drives a soft accent border. */
  replayMounted: boolean;
  /** Clicking a citation chip in this editor selects that coin. */
  onSelectSpan: (nodeId: string, phrase: string) => void;
  onCopySelection: (view: EditorView, event: ClipboardEvent) => boolean;
  onPasteSelection: (view: EditorView, event: ClipboardEvent) => boolean;
  /** Fired when the user tries to edit while replay-frozen. The App surfaces
   *  the fork-from-snapshot modal. Passed through to FileEditor. */
  onReplayEditAttempt?: () => void;
  /** Every resolved `q` edge on this file's current head. */
  citations: CitationChip[];
  /** Explicit no-body citations stored in `citationIds`. Resolved from the
   *  live id set so additions appear
   *  before the next Step advances the head. */
  taggedChips: CitationChip[];
  /** Forks and citations that point into this trace. Rendered after the final
   *  document line as read-only click-to-open chips. */
  inbound: TraceInbound[];
  /** Verification state for the inbound row. */
  inboundFreshness?: InboundFreshness;
  /** Attestations on this tab's current Step that are reachable from the
   *  configured read relays. Absent until the trace has a Step. */
  attestationCount?: number;
  /** Clicking a cited-trace chip opens that trace's Steps modal pinned to the
   *  cited node. */
  onOpenCitation: (nodeId: string) => void;
  /** Sibling traces in the current folder, available to the citation picker
   *  candidates (path + current head nodeId). Built from `files` by the App. */
  traceCandidates: TraceCandidate[];
  /** Whether the citation picker is disabled (foreign/read-only folder, or the
   *  active file hasn't stepped yet). */
  pickerDisabled: boolean;
  /** Add/remove an explicit no-body citation. */
  onAddCitation: (nodeId: string) => void;
  onRemoveCitation: (nodeId: string) => void;
  /** Drag-from-tree → cite: gate whether a dragged tree file (by path) may be
   *  dropped onto this panel's citation row. Mirrors the picker's `disabled`
   *  gate (foreign folder, folder tab, unstepped target) and additionally
   *  rejects self-drops, unstepped sources, and existing citations. */
  citationDropAccept: (srcPath: string) => boolean;
  /** Drag-from-tree → cite through the same path as the picker. */
  onAddCitationByPath: (srcPath: string) => void;
  /** Resolve a dragged Mint coin to the bracket inserted into this editor. */
  citationBodyDropMarkup: (srcPath: string) => string | null;
  /** Incoming forks / sibling heads for the active file. The branch-detection
   *  effect (in App) is scoped to the focused panel's active path, so this is
   *  the same global candidate list passed to every panel — the banner renders
   *  only on the focused one (gated on `active`). */
  mergeCandidates: MergeCandidate[];
  mergeBusy: boolean;
  /** True while the three-way MergePanel overlay is open for this trace —
   *  suppresses the banner entry-point so the two don't stack. */
  mergeSessionOpen: boolean;
  onIncorporateCandidate: (c: MergeCandidate) => void;
  /** Inline failure from the last incorporate/step attempt, shown under the
   *  banner. Lifts merge errors out of bootError (which only renders on the
   *  placeholder screen) so a failed Step no longer flashes and vanishes. */
  mergeError?: string | null;
  /** Paths whose working state differs from the latest Step. */
  unsteppedPathSet: ReadonlySet<string>;
  /** Discrete editor changes waiting for the next Step, keyed by file path. */
  unsteppedEditCounts: ReadonlyMap<string, number>;
  /** Whether a tab's trace belongs to the current effective scope. Tab focus
   *  does not move scope, so the focused tab may legitimately return false. */
  tabIsInScope: (tabPath: string) => boolean;
  /** Mint paths whose full public transaction completed. Unmarked legacy
   * artifacts remain visible but never receive Coin semantics. */
  completedCoinPaths: ReadonlySet<string>;
}) {
  const coinComposerActive = isCoinComposerTab(activePath);
  const coinFile = isCoinTab(activePath) && isCompletedCoinFile(file) ? file : undefined;
  const coinActive = !!coinFile;
  const incompleteMintActive = isCoinTab(activePath) && !!file && !coinActive;
  // One outgoing list, regardless of the protocol path that created the `q`.
  // Current body brackets are the source of truth for the visible "quoted"
  // marker; this updates immediately while the head's resolved q-list catches
  // up on the next Step. Explicit no-body citations are removable in place.
  const quotedIds = new Set(
    (file ? findResolvedBrackets(flatten(file.runs ?? [])) : [])
      .map((bracket) => bracket.nodeId)
      .filter(Boolean),
  );
  const explicitCitationIds = new Set(file?.citationIds ?? []);
  const outgoingById = new Map<string, CitationChip>();
  for (const chip of [...citations, ...taggedChips]) {
    if (!outgoingById.has(chip.nodeId)) outgoingById.set(chip.nodeId, chip);
  }
  const outgoingCitations: OutgoingCitation[] = [...outgoingById.values()].map((chip) => {
    const retainedInOblivion = traceCandidates.some(
      (candidate) =>
        isOblivion(candidate.path) &&
        (candidate.nodeId === chip.nodeId ||
          (!!chip.traceId && candidate.traceId === chip.traceId)),
    );
    return {
      ...chip,
      ...(retainedInOblivion ? { availability: "in-oblivion" as const } : {}),
      quoted: quotedIds.has(chip.nodeId),
      removable: explicitCitationIds.has(chip.nodeId) && !quotedIds.has(chip.nodeId),
    };
  });
  // Hovering the bare space past the last tab → "drop at end of this list".
  const listIsEndTarget =
    !!draggingTab &&
    dropTargetTab?.panel === panelIdx &&
    dropTargetTab.path === null;
  const tabListRef = useRef<HTMLDivElement>(null);

  // A classic horizontal scrollbar consumes layout height; overlay scrollbars
  // do not. Measure what this browser actually subtracts from the tab list and
  // give precisely that space back to the bar, so the tab row stays header-h
  // tall in either case. ResizeObserver catches panel resizes that make the
  // list begin or stop overflowing.
  useLayoutEffect(() => {
    const list = tabListRef.current;
    const bar = list?.parentElement;
    if (!list || !bar) return;

    const measureScrollbar = () => {
      const scrollbarHeight = Math.max(0, list.offsetHeight - list.clientHeight);
      const next = `${scrollbarHeight}px`;
      if (bar.style.getPropertyValue("--tab-scrollbar-h") !== next) {
        bar.style.setProperty("--tab-scrollbar-h", next);
      }
    };

    measureScrollbar();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measureScrollbar);
    observer.observe(list);
    return () => observer.disconnect();
  }, [tabs, draggingTab]);

  // Drag-from-tree → citation: the citation row is a drop target for tree files
  // (which carry `text/zine-path` + a plain `zine-path:` fallback). This is a
  // third drag gesture, distinct from the tree's move-into-folder dnd and the
  // panel's tab-reorder dnd — we only react to the zine-path payload, so the
  // systems can't interfere. `citationDropActive` drives the highlight while a
  // valid source hovers the strip.
  const [citationDropActive, setCitationDropActive] = useState(false);
  // Merge banner: when there are multiple candidates, collapse them into a
  // single summary line that expands on click — otherwise a busy file with
  // several forks/siblings stacks a row per candidate and swallows the view.
  const [mergeBannerExpanded, setMergeBannerExpanded] = useState(false);
  // Temporary reader focus driven by the document's Voices legend. It is
  // panel-local and clears when the front tab changes.
  const [focusedVoice, setFocusedVoice] = useState("");
  useEffect(() => setFocusedVoice(""), [activePath]);
  function citationRowDragOver(e: React.DragEvent) {
    if (readOnly) return;
    if (!isZinePathDrag(e.dataTransfer)) return; // tab/other drag — leave it alone
    const path = zinePathFromDataTransfer(e.dataTransfer);
    // getData returns "" during dragover in some browsers until drop, so
    // also accept an empty payload as "a tree drag is in progress" and let
    // citationDropAccept makes the final call on drop.
    if (path && !citationDropAccept(path)) return;
    e.preventDefault();
    // Must be one of effectAllowed ("copyMove") — "link" is rejected and the
    // drop dies on WebKit even after preventDefault.
    e.dataTransfer.dropEffect = "copy";
    setCitationDropActive(true);
  }
  function citationRowDrop(e: React.DragEvent) {
    if (readOnly) return;
    const path = zinePathFromDataTransfer(e.dataTransfer);
    setCitationDropActive(false);
    if (!path) return;
    if (!citationDropAccept(path)) return;
    e.preventDefault();
    e.stopPropagation();
    onAddCitationByPath(path);
  }

  const modeToggle =
    !draggingTab && !isCoinTab(activePath) && !coinComposerActive && !isFolderTab(activePath) ? (
    <div className="tab-bar-mode" role="group" aria-label="View mode">
      <button
        type="button"
        className={"tab-bar-mode-btn" + (mode === "preview" ? " active" : "")}
        title="Rendered preview"
        aria-pressed={mode === "preview"}
        onMouseDown={(e) => {
          e.stopPropagation();
          onFocusPanel();
          if (mode !== "preview") onSetMode("preview");
        }}
      >
        <Eye size={13} aria-hidden="true" />
      </button>
      <button
        type="button"
        className={"tab-bar-mode-btn" + (mode === "markdown" ? " active" : "")}
        title="Markdown source"
        aria-pressed={mode === "markdown"}
        onMouseDown={(e) => {
          e.stopPropagation();
          onFocusPanel();
          if (mode !== "markdown") onSetMode("markdown");
        }}
      >
        <Code size={13} aria-hidden="true" />
      </button>
      <button
        type="button"
        className={"tab-bar-mode-btn" + (mode === "diff" ? " active" : "")}
        title="Diff against last step"
        aria-pressed={mode === "diff"}
        onMouseDown={(e) => {
          e.stopPropagation();
          onFocusPanel();
          if (mode !== "diff") onSetMode("diff");
        }}
      >
        <GitCompare size={13} aria-hidden="true" />
      </button>
    </div>
    ) : null;

  const citationBar = file ? (
    <div
      className={"panel-citation-bar" + (citationDropActive ? " citation-drop-active" : "")}
      aria-label="Outgoing citations"
      onDragOver={citationRowDragOver}
      onDragLeave={() => setCitationDropActive(false)}
      onDrop={citationRowDrop}
    >
      <div className="panel-citation-list">
        <span className="panel-outbound-summary">
          <span>CITATIONS OUT: {outgoingCitations.length}</span>
        </span>
        <CitationChips
          chips={outgoingCitations}
          readOnly={readOnly}
          onOpen={(nodeId) => {
            onFocusPanel();
            onOpenCitation(nodeId);
          }}
          onRemove={(nodeId) => {
            onFocusPanel();
            onRemoveCitation(nodeId);
          }}
        />
        <CitationPicker
          candidates={traceCandidates}
          alreadyCited={file.citationIds ?? []}
          disabled={pickerDisabled || readOnly}
          onActivate={onFocusPanel}
          onPick={onAddCitation}
        />
      </div>
    </div>
  ) : null;

  const provenanceHeader = file ? (
    <>
      <VoiceLegend runs={file.runs ?? []} onFocusVoice={setFocusedVoice} />
      {citationBar}
    </>
  ) : null;

  const inboundFooter = file ? (
    <>
      <InboundRow
        inbound={inbound}
        freshness={inboundFreshness}
        onOpen={(nodeId) => {
          onFocusPanel();
          onOpenCitation(nodeId);
        }}
      />
      {attestationCount !== undefined && <AttestationRow count={attestationCount} />}
    </>
  ) : null;

  // Replay is a mode, not a selection edge. Name the read-only state directly
  // in stable chrome so the top-scrollbar transform cannot invert or obscure
  // it. REPLAY remains the transport/action name; READONLY describes what the
  // mounted trace surface permits.
  const replayNotice = replayFrozen
    ? "Historical snapshot · Read-only · Fork to edit"
    : replayMounted
      ? "Playback in progress · Read-only"
      : null;

  return (
    <section
      className={
        "panel" +
        (flash ? " panel-flash" : "") +
        (active ? " panel-active" : "") +
        // panel-mode-preview/markdown drives CSS-only concerns (font face,
        // gutter visibility) — the surface itself is always the one
        // CodeMirror editor; mode instead reconfigures its decorations via
        // modeFacet (see FileEditor).
        (file ? " panel-mode-" + mode : "") +
        (replayFrozen ? " panel-replay-frozen" : "") +
        (replayMounted ? " panel-replay-mounted" : "")
      }
      onMouseDownCapture={onFocusPanel}
    >
      {/* The tab bar carries each open file as a draggable tab: switch by
          clicking, close via the × (or middle-click), and drag onto another
          tab/panel or a panel's right edge to move it or spawn a column. Always
          shown when files are open so even a lone tab is draggable. */}
      {tabs.length > 0 && (
      <div className="tab-bar">
        <div
          ref={tabListRef}
          className={"tab-list" + (listIsEndTarget ? " tab-list-drop-target" : "")}
          role="tablist"
          onDragEnter={(e) => {
            // entering the list itself (not a child tab) → "drop at end"
            if (draggingTab && e.target === e.currentTarget) {
              e.preventDefault();
              onTabDragEnterTarget(null);
            }
          }}
          onDragOver={(e) => {
            if (draggingTab) {
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
            }
          }}
          onDragLeave={(e) => {
            if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
            onTabDragLeaveTarget(null);
          }}
          onDrop={(e) => {
            // child tabs stopPropagation on their own drops, so this fires only
            // for drops on the bare list → land at the end.
            if (draggingTab && e.target === e.currentTarget) {
              e.preventDefault();
              onDropOnListEnd();
            }
          }}
          onDragEnd={onTabDragEnd}
        >
          {tabs.map((p) => {
            const isActive = p === activePath;
            // Every panel has a front tab, but only the exact live UiFocus
            // locus receives the gold top marker. Replay projections cannot.
            const isTraceActive = isActive && focused;
            const isInScope = tabIsInScope(p);
            const isDragging = draggingTab?.path === p && draggingTab.fromPanel === panelIdx;
            const isBeforeTarget =
              dropTargetTab?.panel === panelIdx && dropTargetTab.path === p;
            const unsteppedEdits = unsteppedEditCounts.get(p) ?? 0;
            const hasUnsteppedChanges = unsteppedPathSet.has(p);
            const pendingLabel = unsteppedEdits > 999 ? "999+" : String(unsteppedEdits);
            const scanTab = isScan(isFolderTab(p) ? folderTabPath(p) : p);
            const completedCoinTab = completedCoinPaths.has(p);
            const readOnlyTabDetail = isCoinTab(p)
              ? completedCoinTab
                ? "Immutable Coin"
                : "Incomplete Mint artifact"
              : scanTab
                ? "Scanned snapshot · Adopt to edit"
              : replayFrozen && isActive
                ? "Historical snapshot · Fork to edit"
                : replayMounted
                  ? "Playback in progress"
                  : null;
            return (
              <div
                key={p}
                className={
                  "tab" +
                  (isActive ? " active" : "") +
                  (isTraceActive ? " trace-active" : "") +
                  (replayMounted ? " tab-replay" : "") +
                  (isInScope ? " tab-in-scope" : " tab-out-of-scope") +
                  (isDragging ? " tab-dragging" : "") +
                  (isBeforeTarget ? " tab-drop-before" : "") +
                  (hasUnsteppedChanges ? " tab-unstepped" : "")
                }
                role="tab"
                aria-selected={isActive}
                title={tabTitle(p)}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = "move";
                  e.dataTransfer.setData("text/plain", p);
                  onTabDragStart(p);
                }}
                // mousedown (not click) so focus moves before the editor sees
                // the press; middle-click closes (browser convention).
                onMouseDown={(e) => {
                  if (e.button === 1) {
                    e.preventDefault();
                    onCloseTab(p);
                    return;
                  }
                  onFocusPanel();
                  // A tab press is also an explicit replay-selection gesture.
                  // Call through even when this tab is already active so a
                  // prior multi-selection in the tree is replaced by it.
                  onSelectTab(p);
                }}
                onAuxClick={(e) => {
                  if (e.button === 1) {
                    e.preventDefault();
                    onCloseTab(p);
                  }
                }}
                onContextMenu={(e) => onContextMenuTab(e, p)}
                onDragEnter={(e) => {
                  if (draggingTab && !(draggingTab.path === p && draggingTab.fromPanel === panelIdx)) {
                    e.preventDefault();
                    onTabDragEnterTarget(p);
                  }
                }}
                onDragOver={(e) => {
                  if (
                    draggingTab &&
                    !(draggingTab.path === p && draggingTab.fromPanel === panelIdx)
                  ) {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "move";
                  }
                }}
                onDragLeave={(e) => {
                  if (e.currentTarget.contains(e.relatedTarget as Node)) return;
                  onTabDragLeaveTarget(p);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onDropOnTab(p);
                }}
              >
                <span className="tab-label">
                  {readOnlyTabDetail ? (
                    <span
                      className="tab-readonly-badge"
                      aria-label={`Read-only: ${readOnlyTabDetail}`}
                      title={`Read-only · ${readOnlyTabDetail}`}
                    >
                      READONLY
                    </span>
                  ) : null}
                  {hasUnsteppedChanges && !isFolderTab(p) ? (
                    <span
                      className="tab-unstepped-count"
                      aria-label={
                        unsteppedEdits > 0
                          ? `${unsteppedEdits} edits waiting for Step`
                          : "Changes waiting for Step"
                      }
                      title={
                        unsteppedEdits > 0
                          ? `${unsteppedEdits} edit${unsteppedEdits === 1 ? "" : "s"} waiting for Step · ⌘S`
                          : "Non-text changes waiting for Step · ⌘S"
                      }
                    >
                      {unsteppedEdits > 0 ? pendingLabel : "+"}
                    </span>
                  ) : null}
                  {/* Scope icon to the left of the title. Ordinary folder tabs
                      mirror expanded/collapsed state; scanned folders and files
                      use the matching Input glyphs to identify their intake
                      origin. Scope—not tab selection—controls color. */}
                  {isFolderTab(p) ? (
                    scanTab ? (
                      <FolderInput size={12} className="tab-status tab-status-scan" aria-hidden="true" />
                    ) : collapsed?.has(folderTabPath(p)) ? (
                      <Folder size={12} className="tab-status tab-status-folder" aria-hidden="true" />
                    ) : (
                      <FolderOpen size={12} className="tab-status tab-status-folder" aria-hidden="true" />
                    )
                  ) : completedCoinTab || isCoinComposerTab(p) ? (
                    <CircleDollarSign size={12} className="tab-status tab-status-coin" aria-hidden="true" />
                  ) : isCoinTab(p) ? (
                    <FileX size={12} className="tab-status tab-status-mint-pending" aria-hidden="true" />
                  ) : scanTab ? (
                    <FileInput size={12} className="tab-status tab-status-scan" aria-hidden="true" />
                  ) : (
                    <FileText size={12} className="tab-status tab-status-file" aria-hidden="true" />
                  )}
                  {tabLabel(p)}
                </span>
                {replayMounted && isActive && replayNodeId && (onReplaySend || onReplayAttest) ? (
                  <span
                    className="replay-tab-actions"
                    role="group"
                    aria-label={`Historical actions for ${tabLabel(p)}`}
                  >
                    <button
                      type="button"
                      className="replay-tab-action replay-tab-send"
                      disabled={
                        replayActionStatus?.send === "running" ||
                        replayActionStatus?.attest === "running"
                      }
                      title={
                        replayActionStatus?.send === "error"
                          ? replayActionStatus.message
                          : `Send exact historical node ${replayNodeId.slice(0, 8)}…`
                      }
                      onMouseDown={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                      }}
                      onDragStart={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.stopPropagation();
                        onReplaySend?.();
                      }}
                    >
                      {replayActionStatus?.send === "running"
                        ? "Sending…"
                        : replayActionStatus?.send === "done"
                          ? "Sent"
                          : "Send"}
                    </button>
                    <button
                      type="button"
                      className="replay-tab-action replay-tab-attest"
                      disabled={
                        replayActionStatus?.send === "running" ||
                        replayActionStatus?.attest === "running"
                      }
                      title={
                        replayActionStatus?.attest === "error"
                          ? replayActionStatus.message
                          : `Attest exact historical node ${replayNodeId.slice(0, 8)}…`
                      }
                      onMouseDown={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                      }}
                      onDragStart={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.stopPropagation();
                        onReplayAttest?.();
                      }}
                    >
                      {replayActionStatus?.attest === "running"
                        ? "Attesting…"
                        : replayActionStatus?.attest === "done"
                          ? "Attested"
                          : "Attest"}
                    </button>
                  </span>
                ) : null}
                <button
                  type="button"
                  className="tab-close"
                  aria-label={`Close ${tabLabel(p)}`}
                  title={
                    isCoinComposerTab(p) && directCoinComposer.busy
                      ? "Minting Coin…"
                      : "Close tab"
                  }
                  disabled={isCoinComposerTab(p) && directCoinComposer.busy}
                  onMouseDown={(e) => e.stopPropagation()}
                  onDragStart={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    onCloseTab(p);
                  }}
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>
        {modeToggle}
        {/* Right-edge new-panel drop zone, pinned to the tab bar's right edge.
            This is the primary affordance for "drag a tab right to spawn a
            column": it sits where the user expects (the tab strip's right end)
            and claims the drop before the tab-list's bare-end handler can. The
            full-height .panel-edge-drop overlay (rendered by App on the cell)
            catches the same gesture lower down along the panel border. */}
        {draggingTab && (
          <div
            className={"tab-bar-edge" + (edgeTargetActive ? " active" : "")}
            onDragEnter={(e) => {
              e.preventDefault();
              onEdgeEnter();
            }}
            onDragOver={(e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
            }}
            onDragLeave={onEdgeLeave}
            onDrop={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onDropOnRightEdge();
            }}
          />
        )}
      </div>
      )}
      {replayNotice ? (
        <div
          className="panel-replay-notice"
          aria-label={`Read-only replay: ${replayNotice}`}
        >
          <span className="panel-replay-notice-label">READONLY</span>
          <span className="panel-replay-notice-detail">{replayNotice}</span>
        </div>
      ) : null}
      {/* Branch detection banner for this trace: incoming forks / sibling
          heads of the active file. Incorporate is offered on noConflict forks
          (you haven't edited past the fork point) — unilateral accept of their
          snapshot under your key (protocol §3.8); conflict candidates open the
          three-way MergePanel overlay. The
          reconcile entry point remains attached to the trace it concerns. The
          candidate list is scoped to the focused panel's active path, so this
          renders only on the focused panel; hidden while the MergePanel overlay
          is already open (and on read-only foreign folders). */}
      {file && !isCoinTab(activePath) && active && mergeCandidates.length > 0 && !mergeSessionOpen && (
        <div className="merge-banner">
          {(() => {
            const candidateLabel = (c: MergeCandidate) => {
              const short = c.headId.slice(0, 8);
              const who = c.ownerPubkey.slice(0, 8);
              return c.kind === "incoming-fork"
                ? c.noConflict
                  ? `Fork ${short} by ${who} — ready to incorporate`
                  : `Fork ${short} by ${who} — you edited after they forked`
                : `Concurrent branch ${short} on this file`;
            };
            const renderRow = (c: MergeCandidate) => (
              <div key={c.headId} className="merge-banner-row">
                <span className="merge-banner-text">{candidateLabel(c)}</span>
                <button
                  type="button"
                  className="merge-banner-incorporate"
                  disabled={mergeBusy}
                  onClick={() => {
                    onFocusPanel();
                    onIncorporateCandidate(c);
                  }}
                >
                  {mergeBusy
                    ? "Working…"
                    : c.noConflict
                      ? "Incorporate"
                      : "Reconcile"}
                </button>
              </div>
            );
            // Single candidate → show it inline as before, no toggle.
            if (mergeCandidates.length === 1) {
              return (
                <>
                  {renderRow(mergeCandidates[0])}
                  {mergeError && <p className="merge-error" role="alert">{mergeError}</p>}
                </>
              );
            }
            // Several candidates → one summary line that expands to the list,
            // so the banner can't stack rows and swallow the whole view.
            return (
              <>
                <div className="merge-banner-row merge-banner-summary">
                  <button
                    type="button"
                    className="merge-banner-toggle"
                    aria-expanded={mergeBannerExpanded}
                    onClick={() => setMergeBannerExpanded((v) => !v)}
                  >
                    <span className="merge-banner-caret" aria-hidden="true">
                      {mergeBannerExpanded ? "▾" : "▸"}
                    </span>
                    {mergeCandidates.length} branches awaiting review
                  </button>
                </div>
                {mergeBannerExpanded && mergeCandidates.map(renderRow)}
                {mergeError && <p className="merge-error" role="alert">{mergeError}</p>}
              </>
            );
          })()}
        </div>
      )}
      {!isCoinTab(activePath) && file?.eventMeta && <EventMetaBar meta={file.eventMeta} />}
      {coinComposerActive ? (
        <DirectCoinComposerView
          phrase={directCoinComposer.phrase}
          enabled={directCoinComposer.enabled}
          busy={directCoinComposer.busy}
          error={directCoinComposer.error}
          onPhraseChange={directCoinComposer.onPhraseChange}
          onMint={directCoinComposer.onMint}
          onClose={directCoinComposer.onClose}
        />
      ) : coinActive ? (
        <CoinView
          key={activePath}
          name={systemPathDisplayName(activePath)}
          phrase={flatten(coinFile.runs)}
          nodeId={coinFile.nodeId}
        />
      ) : incompleteMintActive ? (
        <IncompleteMintView
          key={activePath}
          name={systemPathDisplayName(activePath)}
          phrase={flatten(file.runs)}
        />
      ) : file ? (
        // .panel-body positions the one CodeMirror surface that now serves
        // all three modes — LLM ops, citation chips, and Cmd+S step all hold
        // its view ref regardless of which mode is active. Preview vs Markdown
        // is purely a decoration/CSS switch (see FileEditor/modeFacet), not a
        // second mounted component. Diff keeps the editor mounted (so the view
        // ref and unstepped-buffer tracking stay live) but hides it via
        // `.panel-body.diff-mode .editor-host { visibility: hidden }` and lays
        // the read-only DiffPane over it as an absolute overlay.
        <div className={"panel-body" + (mode === "diff" ? " diff-mode" : "")}>
          <FileEditor
            file={file}
            path={activePath}
            onEdit={onEdit}
            onView={onView}
            onSelection={onSelection}
            voice={voice}
            mode={mode}
            voiceAttribution={voiceAttribution}
            focusedVoice={focusedVoice}
            selectedNodeId={selectedNodeId}
            scrollTarget={scrollTarget}
            readOnly={readOnly}
            onSelectSpan={onSelectSpan}
            onCopySelection={onCopySelection}
            onPasteSelection={onPasteSelection}
            onReplayEditAttempt={onReplayEditAttempt}
            citationDropMarkup={citationBodyDropMarkup}
            onCitationDrop={onFocusPanel}
            topChrome={mode !== "diff" ? provenanceHeader : null}
            bottomChrome={mode !== "diff" ? inboundFooter : null}
          />
          {mode === "diff" && (
            <DiffPane
              file={file}
              path={activePath}
              folderId={folderId}
              replayStepText={replayStepText}
              replayPrevText={replayPrevText}
              replayLiveText={replayLiveText}
              header={provenanceHeader}
              footer={inboundFooter}
            />
          )}
        </div>
      ) : (
        <div className="panel-empty" />
      )}
    </section>
  );
}

// --- nav rail ----------------------------------------------------------

// The brand glyph (eye-in-speech-bubble) anchors the rail's head and is also
// the entry to the About page. Below it sit the work views (editor → globe);
// the bottom group holds management views (keys, relays, models). The top
// group flex-grows to push the bottom group to the rail's foot.
type RailItem = { view: View; Icon: LucideIcon; label: string };

const RAIL_TOP: RailItem[] = [
  { view: "editor", Icon: FileText, label: "The Press" },
];
const RAIL_LISTS: RailItem[] = [
  { view: "listings", Icon: Layers3, label: "Stacks" },
  { view: "stats", Icon: BarChart3, label: "Times" },
  { view: "globe", Icon: Globe, label: "Spaces" },
];
const RAIL_BOTTOM_TOP: RailItem[] = [
  { view: "download", Icon: Download, label: "Download" },
];
const RAIL_BOTTOM: RailItem[] = [
  { view: "vaults", Icon: Vault, label: "Vaults" },
  { view: "keys", Icon: KeyRound, label: "Keys" },
  { view: "models", Icon: Cpu, label: "Models" },
  { view: "networking", Icon: Radio, label: "Networks" },
];

function RailButton({
  item,
  active,
  onSelect,
  expanded,
}: {
  item: RailItem;
  active: boolean;
  onSelect: (v: View) => void;
  expanded: boolean;
}) {
  const { Icon, label } = item;
  return (
    <button
      type="button"
      className={"rail-item" + (active ? " active" : "")}
      aria-label={label}
      aria-current={active ? "page" : undefined}
      title={label}
      onClick={() => onSelect(item.view)}
    >
      <Icon size={20} strokeWidth={1.75} />
      {expanded && <span className="rail-item-label">{label}</span>}
    </button>
  );
}

function NavRail({
  activeView,
  onSelect,
  expanded,
  onToggleExpanded,
  theme,
  onToggleTheme,
  showOperator,
}: {
  activeView: View;
  onSelect: (v: View) => void;
  expanded: boolean;
  onToggleExpanded: () => void;
  theme: Theme;
  onToggleTheme: () => void;
  /** Web-only: show the operator entry when the current voice is operator or
   *  curation team. Driven by operator-store.isStaff(). */
  showOperator?: boolean;
}) {
  const mode = resolvedMode(theme);
  return (
    <nav className={"nav-rail" + (expanded ? " expanded" : "")} aria-label="Views">
      <button
        type="button"
        className={"rail-brand" + (activeView === "about" ? " active" : "")}
        aria-label="Docs"
        aria-current={activeView === "about" ? "page" : undefined}
        title="Docs"
        onClick={() => onSelect("about")}
      >
        <span className="rail-brand-emoji" aria-hidden="true">{EYE_SPEECH}</span>
        {expanded && <span className="rail-brand-wordmark">zine</span>}
      </button>
      <div className="rail-divider" aria-hidden="true" />
      <div className="nav-rail-top">
        {RAIL_TOP.map((item) => (
          <RailButton
            key={item.view}
            item={item}
            active={activeView === item.view}
            onSelect={onSelect}
            expanded={expanded}
          />
        ))}
      </div>
      <div className="rail-divider" aria-hidden="true" />
      <div className="nav-rail-lists">
        {RAIL_LISTS.map((item) => (
          <RailButton
            key={item.view}
            item={item}
            active={activeView === item.view}
            onSelect={onSelect}
            expanded={expanded}
          />
        ))}
      </div>
      <div className="rail-divider" aria-hidden="true" />
      <div className="nav-rail-bottom">
        {RAIL_BOTTOM.filter((item) => item.view !== "vaults" || isTauri()).map((item) => (
          <RailButton
            key={item.view}
            item={item}
            active={activeView === item.view}
            onSelect={onSelect}
            expanded={expanded}
          />
        ))}
        {!isTauri() && (
          <>
            <div className="rail-divider" aria-hidden="true" />
            <div className="nav-rail-bottom-bottom">
              {RAIL_BOTTOM_TOP.map((item) => (
                <RailButton
                  key={item.view}
                  item={item}
                  active={activeView === item.view}
                  onSelect={onSelect}
                  expanded={expanded}
                />
              ))}
              {showOperator && (
                <RailButton
                  item={{ view: "operator", Icon: Megaphone, label: "Operator" }}
                  active={activeView === "operator"}
                  onSelect={onSelect}
                  expanded={expanded}
                />
              )}
            </div>
          </>
        )}
      </div>
      <div className="rail-footer">
        <div className="rail-divider" aria-hidden="true" />
        <button
          type="button"
          className="rail-item"
          aria-label={mode === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          title={mode === "dark" ? "Light mode" : "Dark mode"}
          onClick={onToggleTheme}
        >
          {mode === "dark" ? (
            <Sun size={20} strokeWidth={1.75} />
          ) : (
            <Moon size={20} strokeWidth={1.75} />
          )}
          {expanded && (
            <span className="rail-item-label">{mode === "dark" ? "Light" : "Dark"}</span>
          )}
        </button>
        <button
          type="button"
          className="rail-item"
          aria-label={expanded ? "Collapse rail" : "Expand rail"}
          aria-expanded={expanded}
          title={expanded ? "Collapse" : "Expand"}
          onClick={onToggleExpanded}
        >
          {expanded ? (
            <PanelLeftClose size={20} strokeWidth={1.75} />
          ) : (
            <PanelLeftOpen size={20} strokeWidth={1.75} />
          )}
          {expanded && (
            <span className="rail-item-label">{expanded ? "Collapse" : "Expand"}</span>
          )}
        </button>
      </div>
    </nav>
  );
}

// --- view placeholder --------------------------------------------------

const VIEW_META: Record<Exclude<View, "editor">, { title: string; blurb: string }> = {
  about: { title: "Docs", blurb: "What zine is and how it fits together." },
  listings: { title: "Stacks", blurb: "An editorial selection of zines, arranged into named sections." },
  stats: { title: "Times", blurb: "Zines on this relay, ranked by metric per unit time." },
  globe: { title: "Spaces", blurb: "Zines pinned to geohashes, rendered at their level." },
  vaults: { title: "Vaults", blurb: "Parallel Roots, each protected by its own passphrase." },
  keys: { title: "Keys", blurb: "Nostr keypairs (voices) you sign and attribute text with." },
  networking: { title: "Networks", blurb: "Your node, your seeds, your peers — where your writing lives, where it's backed up, and who can reach you." },
  models: { title: "Models", blurb: "LLM providers for prompt injection." },
  download: { title: "Download", blurb: "Get the desktop app." },
  operator: { title: "Operator", blurb: "Relay operator: curation team and moderation." },
};

// Top-left title for every view. Sourced from the same labels the nav rail uses
// (RAIL_TOP/RAIL_LISTS/etc.) so a title and its rail entry can never drift.
// `editor` ("Press") is added here since VIEW_META intentionally excludes it.
const VIEW_TITLES: Record<View, string> = {
  editor: "The Press",
  about: VIEW_META.about.title,
  listings: VIEW_META.listings.title,
  stats: VIEW_META.stats.title,
  globe: VIEW_META.globe.title,
  vaults: VIEW_META.vaults.title,
  keys: VIEW_META.keys.title,
  networking: VIEW_META.networking.title,
  models: VIEW_META.models.title,
  download: VIEW_META.download.title,
  operator: VIEW_META.operator.title,
};

function viewTitle(view: View): string {
  return VIEW_TITLES[view];
}

// Shared header pinned to the top-left of every view. Renders once at the shell
// level so each view gets a consistent title without having to draw its own.
function ViewHeader({ view }: { view: View }) {
  return (
    <header className="view-header">
      <h1 className="view-header-title">{viewTitle(view)}</h1>
    </header>
  );
}

function ViewPlaceholder({ view }: { view: Exclude<View, "editor"> }) {
  const meta = VIEW_META[view];
  return (
    <section className="view-placeholder">
      <p className="view-placeholder-blurb">{meta.blurb}</p>
      <p className="view-placeholder-soon">Coming soon</p>
    </section>
  );
}

// --- view error boundary ------------------------------------------------
//
// A throw in any child view (e.g. a transient HMR module-cache inconsistency
// in keys-store.ts once crashed <KeysView> with "Cannot read properties of
// undefined" and unmounted the whole tree → blank app). React has no built-in
// recovery from a render-time throw without a boundary, so this keeps a
// single bad view from taking down the shell. The nav stays usable; the user
// can switch away and back. The error is logged for the console, matching
// how every other surface surfaces failure in this app (no global toast).
class ViewErrorBoundary extends Component<
  { children: ReactNode; view: string },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error): { error: Error | null } {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack: string }): void {
    console.error(`[view] ${this.props.view} crashed:`, error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <section className="view-placeholder">
          <p className="view-placeholder-blurb">
            {this.state.error.message || String(this.state.error)}
          </p>
          <p className="view-placeholder-blurb">
            The rest of the app is still usable — switch to another view from the
            sidebar. Details are in the console.
          </p>
        </section>
      );
    }
    return this.props.children;
  }
}

// --- provenance hook: editor → disk → relay ----------------------------
//
// On mount, asks Tauri to spawn the relay sidecar (no-op outside Tauri, e.g.
// plain `npm run dev` in a browser). Ordinary edits and MODEL results debounce
// only into the crash pad. Step/Send are the sole paths that write and publish
// a kind-4290 checkpoint; the diff/state bookkeeping lives in workspace.ts.

function useProvenance(
  folder: AttachedFolder | null,
  files: Record<string, FileState>,
  replayActiveRef: MutableRefObject<boolean>,
) {
  const liveFilesRef = useRef(files);
  liveFilesRef.current = files;
  const pendingTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  // Paths with a debounce step in flight. The external-change rescan reads
  // this to avoid clobbering a file the user is mid-edit on — their in-editor
  // content is newer than disk, so the pending step must win, not the rescan.
  const pendingPaths = useRef<Set<string>>(new Set());
  // MODEL-operation crash-pad gate. App applies a buffered result in one editor
  // transaction; the gate holds that render until endOp can attach the pending
  // provenance metadata and mirror the complete unstepped result once.
  const stepSuppressionGate = useRef(new RefCountedStepGate<Uint8Array, LlmStepMeta>());
  const pendingStepPaths = useRef<Set<string>>(new Set());
  // The AUTHOR-key resolver is retained for explicit Step ownership. It is
  // read at gesture time so a role switch never changes a captured operation.
  const authorSignerRef = useRef<(() => Uint8Array | undefined)>(() => undefined);
  // Content-stable dedup for stepFile: the last (content, tags) actually stepped
  // per path, so a no-change non-forced write short-circuits before the relay.
  const lastSteppedRef = useRef<Map<string, FileStepBaseline>>(new Map());
  // Step-on-mount hydration flag: once workspace attach has populated `files`,
  // we don't want the first render's debounce effect to re-publish content
  // that attach already loaded as current. Cleared by the boot effect in App().
  const ready = useRef(false);

  // App mounts only after SecurityBootstrap has activated the selected vault
  // and started its relay. Start the optional Coins rendezvous runtime at that
  // point, then retry the install-local publication outbox on boot/online.
  // Relay startup itself stays exclusively owned by the vault transaction.
  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    const flushRendezvous = () => {
      void flushRendezvousPublicationOutbox().catch((e: unknown) => {
        if (!cancelled) console.warn("[rendezvous] indexing outbox retry failed:", e);
      });
    };
    import("../networking/kademlia.js")
      .then(({ ensureKademliaStarted }) => ensureKademliaStarted())
      .then(() => {
        if (!cancelled) flushRendezvous();
      })
      .catch((e: unknown) => {
        if (!cancelled) console.warn("[rendezvous] Kademlia startup failed:", e);
      });
    window.addEventListener("online", flushRendezvous);
    return () => {
      cancelled = true;
      window.removeEventListener("online", flushRendezvous);
    };
  }, []);
  // Debounced crash-pad refresh for metadata and belt-and-suspenders recovery.
  // Content plus KEdits are journaled synchronously in editFile at transaction
  // time; this pass catches non-editor state changes such as tags.
  useEffect(() => {
    if (!ready.current || !folder) return;
    // Hold the MODEL transaction until its completion metadata is ready. Only
    // genuinely unstepped paths are remembered; unrelated file renders never
    // enter the operation's release set.
    if (stepSuppressionGate.current.suppressed) {
      for (const path of unsteppedPaths(files)) pendingStepPaths.current.add(path);
      return;
    }
    const unstepped = unsteppedPaths(files);
    // No implicit steps, ever. Typing NEVER steps on either platform — both
    // mirror unstepped buffers to the localStorage crash pad only (no step, no
    // relay). The buffer survives a crash/refresh (restored from the pad on the
    // next boot) but the timeline doesn't advance until a deliberate gesture:
    // Step/Send (file) or add/remove/rename (folder). This generalizes the
    // desktop contract ("typing never writes the disk file") to the webapp.
    for (const path of unstepped) schedulePad(path, 800);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files, folder]);

  /** Refresh an unstepped file's full crash-pad record after `ms` of quiet.
   * Typing itself is already journaled synchronously by editFile; this never
   * calls stepFile, so neither path creates an implicit Step. */
  function schedulePad(path: string, ms: number) {
    clearTimeout(pendingTimers.current[path]);
    pendingPaths.current.add(path);
    pendingTimers.current[path] = setTimeout(() => {
      pendingPaths.current.delete(path);
      const f = files[path];
      if (!f || !folder) return;
      mirrorPad(folder.id, path, {
        content: flatten(f.runs),
        tags: f.tags,
        nodeId: f.nodeId,
        traceId: f.traceId,
        runs: f.runs,
        citationIds: f.citationIds,
        kedits: keditLogToArray(f.kedits),
      });
    }, ms);
  }

  /** Paths whose content or tags differ from what was last stepped (or that have
   *  never been stepped this session). The debounce effect and the suppression
   *  buffer both consult this so only genuinely-changed files get stepped — the
   *  root fix for the relay rate-limit fanout where one edit re-stepped every
   *  file in the folder. */
  function unsteppedPaths(currentFiles: Record<string, FileState>): string[] {
    const out: string[] = [];
    for (const [path, file] of Object.entries(currentFiles)) {
      if (isMint(path) || isScan(path) || isOblivion(path)) continue;
      const last = lastSteppedRef.current.get(path);
      if (fileHasUnsteppedChanges(file, last)) out.push(path);
    }
    return out;
  }

  /** Gate crash-pad observation around one atomic MODEL apply. Release mirrors
   * the completed buffer and stores metadata for a later explicit Step. */
  function suppressStep(
    on: boolean,
    signer?: Uint8Array,
    path?: string,
    llmMeta?: LlmStepMeta | null,
  ) {
    if (on) {
      stepSuppressionGate.current.begin();
      return;
    }
    const releases = stepSuppressionGate.current.release(path, signer, llmMeta);
    if (!releases) return;
    // Snapshot the paths before another operation can begin.
    const paths = [...pendingStepPaths.current];
    pendingStepPaths.current.clear();
    for (const p of paths) {
      const release = releases.get(p);
      const pathLlmMeta = release?.meta;
      // MODEL output is always an unstepped local buffer. Preserve it in the
      // crash pad on desktop and web, but never publish implicitly; the next
      // explicit Step consumes the pending provenance metadata.
      const f = files[p];
      if (f && folder) {
        if (pathLlmMeta) setPendingLlmMeta(p, pathLlmMeta);
        mirrorPad(folder.id, p, {
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

  async function stepFile(
    path: string,
    signer?: Uint8Array,
    localOnly?: boolean,
    force?: boolean,
    operationId?: string,
  ): Promise<string | undefined> {
    if (!folder) return;
    // Private system entries are immutable in place. Mint and Scan become
    // editable only through a lineage-preserving fork into Root; Oblivion must
    // be restored before authoring.
    if (isMint(path) || isScan(path) || isOblivion(path)) {
      console.warn("step blocked: Mint, Scan, and Oblivion are read-only");
      return;
    }
    // Belt-and-suspenders: never step while replay is parked on a historical
    // step. That step's file is frozen with reconstructed content via a
    // setRunsEffect-tagged run (which liftRuns exempts, so editFile/debounce
    // never fire), but an explicit Cmd+S would otherwise step that frozen
    // content as a new node — polluting the trace. On `last` the editor is
    // live, so this ref is false and steps flow (the follow effect appends the
    // new step as a step and advances the bar to the new last).
    if (replayActiveRef.current) return;
    const file = files[path];
    if (!file) return;
    // Content-stable dedup: skip when nothing has changed since the last step
    // for this path. Explicit checkpoints may use `force` because choosing a
    // checkpoint is itself process evidence even when the body is unchanged.
    //
    // `force` bypasses this after the palette has authorized an explicit Step.
    // Explicit Step remains available on a current trace because the chosen
    // checkpoint is itself process evidence; force prevents that gesture from
    // being swallowed by this baseline dedup.
    if (!force) {
      const content = flatten(file.runs);
      const tags = file.tags;
      const citationIds = file.citationIds ?? [];
      const last = lastSteppedRef.current.get(path);
      if (
        last &&
        last.content === content &&
        last.tags.length === tags.length &&
        last.tags.every((t, i) => t === tags[i]) &&
        (last.citationIds ?? []).length === citationIds.length &&
        (last.citationIds ?? []).every((t, i) => t === citationIds[i])
      ) {
        return file.nodeId;
      }
    }
    // The caller chooses the trace signer. Do not replace it with the dominant
    // contributor voice: one trace has one owner, while mixed human/MODEL
    // authorship is carried by `runs` and encoded into per-delta attribution.
    // Substituting the MODEL key here makes fork-on-write correctly interpret
    // an ordinary Step as an ownership change.
    const runs = file.runs;
    const content = flatten(file.runs);
    try {
      // Pass the live runs to the backend so per-voice attribution persists
      // alongside the content (webapp → LocalFile.runs; desktop → .zine/attribution
      // sidecar). The backend validates runs against content on load and falls
      // back to a single run if they drift.
      // Pass `file.tags` so a tag-only edit still reaches writeFile with the
      // new labels — writeFile detects the content-hash match but tags-changed
      // case and steps anyway, so the new `t` tags land on the relay. Hardcoding
      // undefined here would drop the tags before publish, and writeFile's
      // content-hash no-op branch would swallow the change (the Times view would
      // never see #logos/#philos etc.).
      //
      // Pending `[[ ]]` brackets are left pending — minting (publishing a
      // span as its own trace node + resolving `| nodeId`) is opt-in via Mint,
      // never a side effect of step. Resolved brackets this doc already cites
      // are mirrored as `q` tags by writeFile (findResolvedBrackets), so a
      // send-created citation flows to the relay on the next step for free.
      // `citationIds` is the tagged-but-not-quoted set (the protocol's
      // `tag-add`); writeFile folds it into the same q-tag dedup and emits a
      // `tag-add` delta per id, so adding a trace to this list steps a new node
      // even when content is unchanged.
      const tags = file.tags;
      const citationIds = file.citationIds ?? [];
      // Drain the keystroke log accumulated in the editor's keditField (mirrored
      // into FileState.kedits by editFile on every change). One KEdit per
      // discrete editor change since the previous step — every backspace,
      // highlight-delete, type-over, and IME commit. Cleared after step below.
      const steppedKedits = file.kedits ?? EMPTY_KEDIT_LOG;
      const kedits = keditLogToArray(steppedKedits);
      const nodeId = await writeRef.current(
        path,
        content,
        tags,
        signer,
        runs,
        citationIds.length > 0 ? citationIds : undefined,
        kedits.length > 0 ? kedits : undefined,
        localOnly,
        force,
        operationId,
      );
      // The head and stable trace identity are distinct after Step 0. The
      // local workspace persists both before writeFile resolves; carry that
      // identity into live React state instead of advancing only the head.
      // A legacy/non-local backend may not expose the local record, so resolve
      // the signed chain as a fallback without guessing that the newest head
      // is the genesis.
      const traceId = await resolvePostWriteTraceId({
        nodeId,
        priorTraceId: file.traceId ?? null,
        readPersistedTraceId: () => loadLocalFolder(folder.id)?.files[path]?.traceId,
        resolveTraceIdentity,
      });
      lastSteppedRef.current.set(path, { content, tags: [...tags], citationIds: [...citationIds] });
      // If edits landed while the Step was in flight, immediately rebase their
      // crash-pad record onto the new head. Never clear a newer KEdit suffix.
      const liveFile = liveFilesRef.current[path];
      const liveRemaining = liveFile
        ? dropKEditLogPrefix(liveFile.kedits ?? EMPTY_KEDIT_LOG, steppedKedits)
        : EMPTY_KEDIT_LOG;
      const liveCitations = liveFile?.citationIds ?? [];
      const hasNewerBuffer = Boolean(liveFile) && (
        liveRemaining.length > 0 ||
        flatten(liveFile.runs) !== content ||
        liveFile.tags.length !== tags.length ||
        liveFile.tags.some((tag, index) => tag !== tags[index]) ||
        liveCitations.length !== citationIds.length ||
        liveCitations.some((id, index) => id !== citationIds[index])
      );
      if (folder && liveFile && hasNewerBuffer) {
        mirrorPad(folder.id, path, {
          content: flatten(liveFile.runs),
          tags: liveFile.tags,
          nodeId,
          ...(traceId ? { traceId } : {}),
          runs: liveFile.runs,
          citationIds: liveFile.citationIds,
          kedits: keditLogToArray(liveRemaining),
        });
      } else if (folder) {
        clearPadPath(folder.id, path);
      }
      // Reflect the freshly-stepped node id back into state so the next diff
      // is against the right baseline. Stable-identity update only. The
      // context-block delta-log memo is keyed by this nodeId, so advancing
      // the head auto-invalidates the stale chain — no manual hook here.
      // Also clear the keystroke log: the buffer has been drained into this
      // step's `kedits` content field, so the next step window starts fresh.
      setFilesRef.current((prev) => {
        if (!prev[path]) return prev;
        // Drain exactly the prefix this Step wrote. If the user typed while
        // the relay write was in flight, those newer chunks remain pending.
        const { kedits: _drained, ...rest } = prev[path];
        const remaining = dropKEditLogPrefix(prev[path].kedits ?? EMPTY_KEDIT_LOG, steppedKedits);
        const next: FileState = {
          ...rest,
          nodeId,
          ...(traceId ? { traceId } : {}),
          ...(remaining.length > 0 ? { kedits: remaining } : {}),
        };
        return { ...prev, [path]: next };
      });
      return nodeId;
    } catch (e) {
      console.warn(`[provenance] write+publish failed for ${path}:`, e);
      throw e;
    }
  }

  // setFiles is threaded in from App() so stepFile can update nodeId without
  // a re-render cycle through the debounce effect. Assigned in App()'s body.
  const setFilesRef = useRef<(updater: (prev: Record<string, FileState>) => Record<string, FileState>) => void>(
    () => {},
  );
  // Write function — threaded in from App() so stepFile uses the active backend
  // (disk on desktop, local-primary on webapp) instead of the hardwired disk
  // function. Without this, webapp edits go through the Tauri disk path and
  // silently fail (Tauri not available in a browser).
  const writeRef = useRef<
    (
      path: string,
      content: string,
      tags?: string[],
      signer?: Uint8Array,
      runs?: Run[],
      citationIds?: string[],
      kedits?: KEdit[],
      localOnly?: boolean,
      force?: boolean,
      operationId?: string,
    ) => Promise<string>
  >(async () => "");
  // Seed the last-stepped map for files loaded from disk/relay. Called from
  // App's openScanned tail so freshly-attached files are recognized as already
  // published (they are — that's why they have a nodeId) and don't trip a step
  // on the first debounce tick. Without this, unsteppedPaths would mark every
  // loaded file unstepped (lastSteppedRef is empty until a Step runs) and the boot
  // fanout would re-step the whole folder.
  const seedSteppedRef = useRef<(files: Record<string, FileState>) => void>(() => {});
  seedSteppedRef.current = (seedFiles: Record<string, FileState>) => {
    for (const [path, file] of Object.entries(seedFiles)) {
      lastSteppedRef.current.set(path, {
        content: flatten(file.runs),
        tags: [...file.tags],
        citationIds: [...(file.citationIds ?? [])],
      });
    }
  };

  // Unstepped set: paths whose buffer differs from what was last stepped.
  // Drives the per-tab KEdit count and the window title. Memoized on
  // `files` — correct because every step updates lastSteppedRef before its
  // setFiles, so the post-step re-render sees the path as clean. Replay lives in
  // panel-only state and therefore never enters this calculation.
  const unsteppedPathSet = useMemo(() => new Set(unsteppedPaths(files)), [files]);
  const unsteppedEditCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const path of unsteppedPathSet) counts.set(path, files[path]?.kedits?.length ?? 0);
    return counts;
  }, [files, unsteppedPathSet]);

  return {
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
  };
}

// A right-click menu entry. Either an action button or a visual separator.
// `disabled` is read by the CSS (faded/inert) — e.g. Cut with no selection.
export type GlobalCtxItem =
  | { kind: "action"; label: string; run: () => void; disabled?: boolean }
  | { kind: "sep" };

function MintConsentModal({
  phrase,
  onCancel,
  onConfirm,
}: {
  phrase: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onCancel();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onCancel]);

  return (
    <div className="confirm-overlay mint-consent-overlay" onClick={onCancel}>
      <div
        className="confirm-dialog mint-consent-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="mint-consent-title"
        aria-describedby="mint-consent-description"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id="mint-consent-title" className="create-modal-title mint-consent-title">
          Publish this selection as a Coin?
        </h2>
        <blockquote className="mint-consent-phrase">{phrase}</blockquote>
        <p id="mint-consent-description" className="confirm-message mint-consent-message">
          This exact selected text will be public through configured publication relays.
          Mint also publishes a same-minter attestation, making the result an immutable Coin.
          If you later Send a trace that cites it, the signer&apos;s interest can become globally
          discoverable through rendezvous.
        </p>
        <div className="confirm-actions">
          <button type="button" className="confirm-cancel" onClick={onCancel}>Cancel</button>
          <button type="button" className="coin-mint-submit" onClick={onConfirm}>
            Mint publicly
          </button>
        </div>
      </div>
    </div>
  );
}

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
  // Storage backend. The root is always pathless (relay + localStorage crash
  // pad; disk is touched only by Scan/Reify), so both desktop and webapp use
  // the local/relay arm — it boots from localStorage instantly and
  // background-pulls the relay, exactly the pathless-root contract. Held in a
  // ref so mutation call sites have a stable handle; it closes over the
  // attached folder, so callers drop the `folder` arg.
  const backendRef = useRef<Workspace>(createLocalWorkspace());
  // Opaque clipboard tickets live only in this press session. The system
  // clipboard carries the ticket alongside ordinary text; paste resolves it
  // here to a signed coin. Unknown/expired tickets degrade to native text.
  const coinClipboardTicketsRef = useRef<Map<string, CoinClipboardTicket>>(new Map());
  // Latest folder id, mirrored into a ref so async functions (rescan, ops)
  // can detect a folder switch that happened during their `await` and bail
  // before writing stale state. Without this, a rescan started under folder A
  // that resolves after a switch to B would clobber B's `files` with A's scan.
  const folderIdRef = useRef<string | null>(folder?.id ?? null);
  const prevFolderIdRef = useRef<string | null>(folderIdRef.current);
  folderIdRef.current = folder?.id ?? null;
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
    if (!replay) return;
    if (replayDisplay) return;
    const last = replay.steps.length - 1;
    if (replay.index !== last) return;
    const knownIds = new Set(replay.steps.map((s) => s.event.id));
    // Discover only heads inside the focused replay subject. Directory
    // operation selection must never move this counter or slider.
    const target = focusReplayTarget(uiFocusRef.current);
    const selected = target ? [target] : [];
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
          const event = await fetchEventById(nodeId);
          if (!event) continue;
          const meta = eventMeta(event);
          if (meta.relativePath !== path) continue; // id resolved to a different file; skip
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
        const next = appendReplayStepsAtLiveEnd(
          prev,
          appended,
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
  const recoveredMintSessionsRef = useRef(new Set<string>());

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
  ): Promise<string> {
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
    );
    if (!nodeId) throw new Error(`The local source trace ${path} did not produce a node id.`);
    const traceId = await resolvePostWriteTraceId({
      nodeId,
      priorTraceId: file.traceId ?? null,
      readPersistedTraceId: () => folder
        ? loadLocalFolder(folder.id)?.files[path]?.traceId
        : null,
      resolveTraceIdentity,
    });
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
  ): Promise<string> {
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
    const nextText = finalizedCoinMintSourceText(record, currentText);
    const currentNodeId = liveFile?.nodeId ?? localFile?.nodeId ?? "";
    if (nextText === currentText && currentNodeId) {
      const currentNode = await fetchEventById(currentNodeId);
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
    const nodeId = await backendRef.current.writeFile(
      source.relativePath,
      nextText,
      sourceTags,
      signer,
      nextRuns,
      undefined,
      citationIds,
      undefined,
      true,
      nextText === currentText,
      operationIdFromNode(record.coin),
    );
    if (!nodeId) throw new Error(`Mint source ${source.relativePath} did not produce a citation Step`);
    const nextFile = {
      ...(liveFile ?? { tags: sourceTags }),
      runs: nextRuns,
      nodeId,
      tags: sourceTags,
      ...(citationIds ? { citationIds } : {}),
    };
    filesRef.current = { ...filesRef.current, [source.relativePath]: nextFile };
    setFiles((prev) => ({ ...prev, [source.relativePath]: nextFile }));
    return nodeId;
  }

  /** Strike one immutable Coin. Extracted Mints include a fourth durable phase
   * that resolves and Steps the source citation before the journal can clear. */
  function coinMintCompletionFor(
    signer: Uint8Array,
    finalizeSource: (record: PendingCoinMint) => Promise<string> =
      (record) => finalizeStoredMintSource(record, signer),
  ) {
    return {
      publishPair: (coin: Event) => completeCoinMint(coin, signer),
      serializeAttestation: (attestation: Event) => attestation,
      restoreAttestation: storedCoinMintAttestation,
      persistMembership: async (record: PendingCoinMint) => {
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
          { localOnly: true, operationId: operationIdFromNode(record.coin) },
        );
      },
      persistLocal: (record: PendingCoinMint) => {
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
        seedSteppedRef.current({
          [record.localPath]: { runs, nodeId: record.coin.id, tags: [], coinComplete: true },
        });
        if (folderIdRef.current === record.sourceFolderId) {
          const nextFile = { runs, nodeId: record.coin.id, tags: [], coinComplete: true };
          // Keep the allocator's imperative snapshot authoritative immediately;
          // React commits on a later turn and cannot be the reservation barrier.
          filesRef.current = { ...filesRef.current, [record.localPath]: nextFile };
          setFiles((prev) => ({ ...prev, [record.localPath]: nextFile }));
        }
      },
      finalizeSource,
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
  async function recoverPendingCoinMints(exceptOperationKey?: string): Promise<void> {
    const result = await resumePendingCoinMints((pending) => {
      const signer = secretKeyForVoice(pending.coin.pubkey);
      if (!signer) {
        throw new Error(`the Coin signer ${formatPubkey(pending.coin.pubkey)} is unavailable`);
      }
      return coinMintCompletionFor(signer);
    }, vaultStorage, (pending) =>
      pending.sourceFolderId === folderIdRef.current &&
      (!exceptOperationKey || pending.operationKey !== exceptOperationKey),
    );
    if (result.failures.length > 0) {
      console.warn("[mint] pending Mint recovery remains incomplete:", result.failures);
    }
    refreshMintRecoveryNotice(result.failures.map((failure) => failure.error));
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
    if (recoveredMintSessionsRef.current.has(session)) return;
    recoveredMintSessionsRef.current.add(session);
    setMintRecoveryBusy(true);
    void recoverPendingCoinMints()
      .catch((error) => {
        if (vaultStorageGeneration() !== generation || folderIdRef.current !== folder.id) return;
        const message = error instanceof Error ? error.message : String(error);
        console.warn("[mint] startup recovery failed:", error);
        refreshMintRecoveryNotice([], message);
      })
      .finally(() => {
        if (vaultStorageGeneration() === generation && folderIdRef.current === folder.id) {
          setMintRecoveryBusy(false);
        }
      });
  }, [bootState, coinsEnabled, folder?.id, keys]);

  async function mintCoinTrace(
    phrase: string,
    origin: CoinOrigin,
    signer?: Uint8Array,
    kedits?: KEdit[],
    sourceCompletion?: {
      metadata: CoinMintSourceFinalization;
      finalize: (record: PendingCoinMint) => Promise<string>;
    },
  ): Promise<{ path: string; nodeId: string; attestationId: string; runs: Run[] }> {
    if (!kademliaEnabledSnapshot()) {
      throw new Error("Enable Coins in Networking before minting a Coin.");
    }
    if (!folder) throw new Error("Cannot mint a coin without an attached press.");
    const sourceFolderId = folder.id;
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
    await recoverPendingCoinMints(operationKey);
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
      const mintFolderId = await getOrCreateMintFolder(sourceFolderId, mintSigner);
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
        coinMintCompletionFor(mintSigner, sourceCompletion?.finalize),
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
      throw error;
    } finally {
      pendingPaths.current.delete(pending.localPath);
      if (!pendingCoinMints().some((record) => record.operationKey === operationKey)) {
        refreshMintRecoveryNotice();
      }
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
    const sourceContentHashPromise = sha256HexLocal(sourceSnapshot);

    const signer = stepSigner ?? secretKeyForVoice(authorPubkey) ?? undefined;
    try {
      // Pin extraction to the exact source version that contains the selected
      // phrase. This flush is a no-op when the source is already current.
      const originNodeId = await flushEditorLocally(path, view, signer);
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
          finalize: async (record) => {
            const afterWrite = view.state.doc.toString();
            const resolved = finalizedCoinMintSourceText(record, afterWrite);
            const change = minimalTextChange(afterWrite, resolved);
            if (change) view.dispatch({ changes: change });
            return flushEditorLocally(
              path,
              view,
              signer,
              operationIdFromNode(record.coin),
            );
          },
        },
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
  const desktopOperationRefreshSequenceRef = useRef(0);
  const desktopReprepareKeyRef = useRef<DesktopOperationKeyV1 | null>(null);
  // Directive authority is deliberately non-durable. Only attempts created or
  // linked from an authorized attempt during this App activation may consume
  // prepared one-shot directives.
  const desktopAuthorizedAttemptKeysRef = useRef(new Set<string>());
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
    setDesktopOperationError(null);
    void desktopOperationRuntimeRef.current!.recover()
      .then((result) => {
        if (!cancelled && result.failureCount > 0) {
          const shown = Math.min(result.failureCount, 99);
          setDesktopOperationError(
            `${shown}${result.failureCount > shown ? "+" : ""} saved AI operation(s) need recovery attention.`,
          );
        }
        return refreshDesktopOperationEnvelopes(null, []);
      })
      .catch(() => {
        if (!cancelled) {
          setDesktopOperationError("Saved AI operation recovery could not finish.");
        }
      });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [desktopRuntimeReady, bootState, folder?.id]);

  function upsertDesktopOperationEnvelope(envelope: DesktopOperationEnvelopeV1): void {
    setDesktopOperationPinnedHeads((current) => [
      ...mergeDesktopOperationPinnedHeadsV1(current, [envelope], 16),
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
    signal?: AbortSignal,
  ): Promise<DesktopOperationEnvelopeV1> {
    const runtime = desktopOperationRuntimeRef.current;
    if (!runtime) throw new Error("The desktop operation journal is unavailable");
    const key = {
      operationId: envelope.operationId,
      attemptId: envelope.attempt.attemptId,
    };
    let current = envelope;
    if (current.lifecycle.status === "prepared") {
      current = await runtime.approve(key);
      upsertDesktopOperationEnvelope(current);
    }
    if (current.lifecycle.status === "approved") {
      current = await runtime.dispatch(key, { signal });
      upsertDesktopOperationEnvelope(current);
    }
    return current;
  }

  async function retryDesktopOperation(
    key: DesktopOperationKeyV1,
    possibleDuplicateAcknowledged = false,
  ): Promise<void> {
    const runtime = desktopOperationRuntimeRef.current;
    if (!runtime) throw new Error("The desktop operation journal is unavailable");
    const retry = await runtime.retry(key, possibleDuplicateAcknowledged
      ? { possibleDuplicateAcknowledged: true }
      : {});
    if (desktopAuthorizedAttemptKeysRef.current.has(desktopOperationAttemptKeyV1(key.operationId, key.attemptId))) {
      desktopAuthorizedAttemptKeysRef.current.add(
        desktopOperationAttemptKeyV1(retry.operationId, retry.attempt.attemptId),
      );
    }
    upsertDesktopOperationEnvelope(retry);
    await dispatchDesktopOperationAttempt(retry);
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
      desktopAuthorizedAttemptKeysRef.current.add(
        desktopOperationAttemptKeyV1(retry.operationId, retry.attempt.attemptId),
      );
      upsertDesktopOperationEnvelope(retry);
      await dispatchDesktopOperationAttempt(retry);
      await refreshDesktopOperationEnvelopes();
    } catch (error) {
      setDesktopOperationError(error instanceof Error ? error.message : String(error));
      await refreshDesktopOperationEnvelopes().catch(() => undefined);
    } finally {
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

  // Approximate prompt-size estimate shown inside the persistent Inspect
  // control. The number reflects the payload an op would send against the
  // op-target panel's active file (the same target Extend/Settle/Stir/Reply
  // run against). The estimate uses the same assembler and provider-system
  // preparation as a live Extend call, with an empty seed; the context block
  // still dominates. Debounced so typing doesn't thrash the async gather.
  const [tokenEstimate, setTokenEstimate] = useState<number | null>(null);
  useEffect(() => {
    if (!folder) {
      setTokenEstimate(null);
      return;
    }
    const panelIdx = uiFocus?.panelIndex ?? Math.min(activePanel, panels.length - 1);
    const path = panelIdx >= 0 ? panels[panelIdx]?.active : undefined;
    if (!path) {
      setTokenEstimate(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const provider = resolveVoiceProvider(modelPubkey);
          if (!provider) throw new Error("No AI provider configured");
          const prepared = await modelOperationControllerRef.current!.prepare({
            panelIndex: panelIdx,
            operation: "extend",
            operationInputs: { seed: "", hasSelection: false },
            provider,
            modelVoicePubkey: modelPubkey,
            lensId: opLenses.extend,
          });
          if (!cancelled) setTokenEstimate(prepared.budget.estimatedTokens);
        } catch {
          if (!cancelled) setTokenEstimate(null);
        }
      })();
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folder, files, panels, activePanel, uiFocus, modelPubkey, scope, shielded, providers, opLenses]);

  // ─── Prompt inspector ──────────────────────────────────────────────────────
  // Clicking a single-shot MODEL action opens a modal showing exactly what that
  // op would send; the persistent Inspect control remains an optional entry
  // point that defaults to Extend. `inspectOp` is null when closed; non-null is
  // the op to show first. The inputs + context block are
  // gathered once on open (against the op-target panel + scope, mirroring what
  // the live ops gather) and held in state so the modal can switch op tabs
  // without re-fetching the (memoized) context block.
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
        ? await (async () => {
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
          })()
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
        traces: renderSteppedTraceReferences(panels[opTargetPanel()]?.active),
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
      await openInspector("extend");
      return;
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
    summonAbort.current[idx] = controller;
    setOpStatus(idx, "running", undefined, "extend");
    try {
      let envelope = await runtime.persistApprovedExtend({
        prepared: approvedRequest,
        provider,
        maxOutputTokens: 4096,
      });
      desktopAuthorizedAttemptKeysRef.current.add(
        desktopOperationAttemptKeyV1(envelope.operationId, envelope.attempt.attemptId),
      );
      upsertDesktopOperationEnvelope(envelope);
      envelope = await runtime.approve({
        operationId: envelope.operationId,
        attemptId: envelope.attempt.attemptId,
      });
      upsertDesktopOperationEnvelope(envelope);
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
        const traces = renderSteppedTraceReferences(srcRel);
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
    if (pad && Object.keys(pad).length > 0) {
      const recoveryVoice = await getReconcilerVoice();
      const merged = { ...scanned };
      for (const [path, lf] of Object.entries(pad)) {
        merged[path] = restoreCrashPadFile(
          scanned[path],
          lf,
          authorVoice(),
          recoveryVoice.publicKey,
        );
      }
      setFiles(merged);
    }
    // Mark every scanned file as already-stepped so the first debounce tick
    // doesn't re-publish the whole folder (these files came from disk/relay
    // already published — their nodeId proves it). This is what stops the boot
    // fanout from tripping the relay rate-limit. Seeded from `scanned` (disk
    // truth) deliberately — see the pad-restore note above.
    seedSteppedRef.current(scanned);
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

  /** Apply a stepped merge into editor + local store. Shared by no-conflict
   *  incorporate and the three-way panel's Step merge. */
  async function applyMergedToWorkspace(
    path: string,
    event: Event,
    snapshot: string,
    candidate: MergeCandidate,
  ) {
    let authorsRaw: unknown;
    try {
      authorsRaw = (JSON.parse(event.content) as { authors?: unknown }).authors;
    } catch {
      authorsRaw = undefined;
    }
    const runs =
      parseAuthors(authorsRaw, snapshot) ??
      (snapshot === candidate.snapshot
        ? [{ voice: candidate.ownerPubkey, text: snapshot, src: candidate.headId }]
        : [{ voice: authorVoice(), text: snapshot }]);
    const tags = files[path]?.tags ?? [];
    const citationIds = files[path]?.citationIds;
    const nextFile: FileState = {
      ...(files[path] ?? { tags: [], runs: [], nodeId: "" }),
      runs,
      nodeId: event.id,
      tags,
      citationIds,
    };
    setFiles((prev) => ({ ...prev, [path]: nextFile }));
    await backendRef.current.writeFile(path, snapshot, tags, undefined, runs, undefined, citationIds);
    const local = loadLocalFolder(folder!.id);
    const cur = local?.files[path];
    if (cur) {
      saveLocalFile(folder!.id, path, {
        content: snapshot,
        tags: cur.tags,
        nodeId: event.id,
        runs,
        voicePubkey: cur.voicePubkey,
        citationIds: cur.citationIds,
      });
    }
    seedSteppedRef.current({ [path]: nextFile });
    await refreshMergeCandidates(folder!.id, path);
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
      const event = await incorporateMergeCandidate(folder.id, path, candidate);
      await applyMergedToWorkspace(path, event, candidate.snapshot, candidate);
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
      const event = await incorporateMergeCandidate(folder.id, path, candidate, {
        snapshot: resolvedSnapshot,
        force: true,
      });
      await applyMergedToWorkspace(path, event, resolvedSnapshot, candidate);
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
      const event = await incorporateMergeCandidate(folder.id, path, candidate, {
        snapshot: resolvedSnapshot,
        force: true,
      });
      await applyMergedToWorkspace(path, event, resolvedSnapshot, candidate);
      setMergeSession(null);
      setMergeError(null);
    } catch (e) {
      console.warn("[merge] stepReconciledMerge failed:", e);
      setMergeError(e instanceof Error ? e.message : String(e));
    } finally {
      setMergeBusy(false);
    }
  }

  /** Accept a staged background-pull merge: step the merge node (using the
   *  raw ids from the pull, not a MergeCandidate — pull-path merges aren't
   *  fork/sibling candidates), write the merged body to editor + local store,
   *  and drop the record. Mirrors applyMergedToWorkspace's post-step sync. */
  async function stepStagedMerge(staged: StagedMerge) {
    if (!folder || stagedMergeBusy) return;
    setStagedMergeBusy(true);
    setStagedMergeError(null);
    try {
      const event = await mergeFile({
        folderId: folder.id,
        relativePath: staged.path,
        prevEventId: staged.localNodeId,
        mergeParentIds: [staged.remoteHeadId],
        snapshot: staged.merged,
        authors: [{ voice: staged.remoteOwnerPubkey, text: staged.merged, src: staged.remoteHeadId }],
      });
      const runs = parseAuthors(
        (JSON.parse(event.content) as { authors?: unknown }).authors,
        staged.merged,
      ) ?? [{ voice: authorVoice(), text: staged.merged }];
      const tags = files[staged.path]?.tags ?? [];
      const citationIds = files[staged.path]?.citationIds;
      const nextFile: FileState = {
        ...(files[staged.path] ?? { tags: [], runs: [], nodeId: "" }),
        runs,
        nodeId: event.id,
        tags,
        citationIds,
      };
      setFiles((prev) => ({ ...prev, [staged.path]: nextFile }));
      await backendRef.current.writeFile(staged.path, staged.merged, tags, undefined, runs, undefined, citationIds);
      const local = loadLocalFolder(folder.id);
      const cur = local?.files[staged.path];
      if (cur) {
        saveLocalFile(folder.id, staged.path, {
          content: staged.merged,
          tags: cur.tags,
          nodeId: event.id,
          runs,
          voicePubkey: cur.voicePubkey,
          citationIds: cur.citationIds,
        });
      }
      seedSteppedRef.current({ [staged.path]: nextFile });
      setStagedMerges((prev) => prev.filter((m) => m !== staged));
      setStagedMergeView(null);
      await refreshMergeCandidates(folder.id, staged.path);
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
        const scanned = (
          await backendRef.current.attach(folder, (path, file) => {
            if (cancelled) return;
            setFiles((prev) => {
              if (file) return { ...prev, [path]: file };
              if (!(path in prev)) return prev;
              const next = { ...prev };
              delete next[path];
              return next;
            });
            if (file) seedSteppedRef.current({ [path]: file });
          })
        ).files;
        if (cancelled) return;
        setFiles(scanned);
        await openScanned(scanned, folder.id);
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

  /** Load replay for the attached folder. Fetches every FileTraceNode in the
   *  folder, groups by file, fetches each file's chain once, and precomputes
   *  each step's reconstructed content so stepping is O(1). Best-effort: a
   *  slow/unreachable relay yields an empty timeline rather than throwing —
   *  auto-bootstrap on folder load must never reject unhandled. */
  async function loadReplay(sequence: number): Promise<boolean> {
    if (!folder) return false;
    let activity: Event[];
    try {
      activity = await fetchFolderActivity(folder.id);
    } catch (e) {
      console.warn("[replay] fetchFolderActivity failed:", e);
      activity = [];
    }
    const target = focusReplayTarget(uiFocusRef.current);
    const playbackScopes = target ? [target] : [];
    if (playbackScopes.length === 0) return false;
    // Aggregate activity can lag directly-addressed relay storage immediately
    // after the first Step. Backfill every novel selected live head by exact id
    // before deciding the timeline is empty, so the first durable Step paints
    // 1 / 1 without waiting for another edit or another click.
    const knownActivityIds = new Set(activity.map((event) => event.id));
    const liveHeads = freshSelectedReplayHeads(
      filesRef.current,
      knownActivityIds,
      playbackScopes,
      new Set(),
    );
    for (const { path, nodeId } of liveHeads) {
      try {
        const event = await fetchEventById(nodeId);
        if (!event) continue;
        const meta = eventMeta(event);
        if (meta.folderId !== folder.id || meta.relativePath !== path) continue;
        activity.push(event);
        knownActivityIds.add(event.id);
      } catch (e) {
        console.warn(`[replay] live-head fetch failed for ${path}:`, e);
      }
    }
    // Group events by relative path so each file's chain is fetched once.
    const byPath = new Map<string, Event[]>();
    for (const event of activity) {
      const path = eventMeta(event).relativePath;
      if (!path) continue;
      const list = byPath.get(path);
      if (list) list.push(event);
      else byPath.set(path, [event]);
    }
    // A selected file contributes only itself; a selected folder contributes
    // its complete subtree. Prompt-context shields do not affect playback.
    const sc = playbackScopes;
    const selectedPaths = new Set(
      selectedReplayPaths([...byPath.keys()], sc, new Set()),
    );
    for (const path of [...byPath.keys()]) {
      if (!selectedPaths.has(path)) {
        byPath.delete(path);
      }
    }
    // Per file: fetch the genesis→latest chain (authoritative order, never
    // created_at), then for each of that file's events find its index in the
    // chain and reconstruct content up to it. Retain each chain on a ref so
    // Keystroke playback can expand the recorded edits without refetching.
    const steps: ReplayStep[] = [];
    const chains: Record<string, Event[]> = {};
    const conformanceVerdicts: TraceConformanceVerdict[] = [];
    for (const [relativePath] of byPath) {
      let chain: Event[];
      try {
        chain = await fetchChain(folder.id, relativePath);
      } catch (e) {
        console.warn(`[replay] fetchChain failed for ${relativePath}:`, e);
        continue;
      }
      if (chain.length === 0) continue;
      chains[relativePath] = chain;
      conformanceVerdicts.push(await verifyFileTraceChain(chain));
      // The resolved genesis→head chain is authoritative for replay positions.
      // Aggregate folder activity can briefly expose only the directly-fetched
      // live head; filtering back through that lagging list would hide genesis
      // and make a real two-node, one-Step trace look unsteppable.
      for (const [idx, event] of chain.entries()) {
        const meta = eventMeta(event);
        const contentUpToHere = reconstructUpTo(chain, idx);
        // The footprint of *this step's* deltas: diff against the previous step
        // in chain order (genesis → "" via reconstructUpTo's clamp → the whole
        // imported doc). Computed per-step from the chain so the timeline's
        // file interleaving never crosses files' content. The range is in
        // `contentUpToHere`'s coordinate space — the doc the editor holds at
        // this step — so it's directly a CodeMirror scroll target.
        const prevContent = reconstructUpTo(chain, idx - 1);
        const changeRange = stepDeltaRange(prevContent, contentUpToHere);
        steps.push({
          event,
          relativePath,
          meta,
          contentUpToHere,
          runsUpToHere: reconstructRunsUpTo(chain, idx),
          changeRange,
        });
      }
    }
    // A selected folder is itself a trace. Include its complete
    // genesis-rooted chain, not just post-genesis membership deltas. That makes
    // an empty folder and a folder with no explicit user Step both playable at
    // Step 0, while descendants still contribute their own file timelines via
    // the effective-scope file loop above.
    const seenFolderTraceIds = new Set<string>();
    for (const mounted of sc) {
      if (mounted.kind !== "folder") continue;
      try {
        const state = mounted.path === ROOT ? undefined : filesRef.current[mounted.path];
        const traceId =
          mounted.path === ROOT
            ? folder.id
            : state?.traceId ??
              (state?.nodeId ? await resolveFolderTraceIdentity(state.nodeId) : null);
        if (!traceId || seenFolderTraceIds.has(traceId)) continue;
        seenFolderTraceIds.add(traceId);

        const folderNodes = await fetchFolderNodes(traceId);
        const chain = orderReplayTraceChain(folderNodes, traceId);
        if (chain.length === 0) continue;
        conformanceVerdicts.push(await verifyFolderTraceChain(chain, {
          expectedTraceId: traceId,
        }));
        chains[`folder:${traceId}`] = chain;
        for (const event of chain) {
          steps.push(folderReplayStep(event, mounted.path));
        }
      } catch (e) {
        // One unavailable selection must not suppress the other selected traces.
        console.warn(`[replay] folder trace failed for ${mounted.path || "Root"}:`, e);
      }
    }
    if (sequence !== replayLoadSequenceRef.current || steps.length === 0) return false;
    // Step-time order, ascending. stable tie-break keeps same-ms steps in
    // their original activity order rather than shuffling them.
    steps.sort((a, b) => a.meta.steppedAtMs - b.meta.steppedAtMs);
    const visibleSteps = collapseDerivedFolderCheckpoints(steps);
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
  function refreshMountedReplay() {
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
    const display = replayDisplayThroughFrame(
      timeline,
      cursor,
      r.steps.map((step) => step.event.id),
    );

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
      r.steps[frame.stepIndex]?.event.id ?? "",
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
    chooseDirectorySelection(
      rebaseTraceRefsAfterMove(directorySelectionRef.current, movable, destFolder),
    );
    commitUiFocus(rebaseUiFocus(uiFocusRef.current, rebaser, tabRebaser));

    // Storage + provenance: extend each file's existing trace at the new path
    // and update membership. Carry user tags through so they survive the
    // reparent. Each
    // top-level source is a separate backend move (movePath already rebases a
    // folder's descendants), so they're independent and tolerate partial
    // failures — a failed move logs and leaves the rest intact.
    for (const src of movable) {
      const isFolderMove = folderSet.has(src) || hasChild(fileSet, folderSet, src);
      const userTagsByPath: Record<string, string[]> = {};
      for (const [p, st] of Object.entries(files)) {
        if (p === src || (isFolderMove && p.startsWith(src + "/"))) {
          userTagsByPath[p] = st.tags;
        }
      }
      void backendRef.current.movePath(src, destFolder, isFolderMove, userTagsByPath)
        .then(refreshMountedReplay)
        .catch((e) =>
          console.warn(`[workspace] movePath failed for ${src}:`, e),
        );
    }
  }

  /** Step one recursive zine. Dirty descendant file buffers land first under
   * one durable operation id; the selected folder then receives the final
   * explicit landmark and its ancestors receive derived roll-ups. */
  function stepFolderPath(path: string): void {
    if (!folder || replayActiveRef.current) return;
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
        await stepFile(descendant, undefined, true, false, operationId);
      }
      await backendRef.current.stepFolder(path, undefined, operationId);
      clearFolderStepOperation(folder.id, path);
      refreshMountedReplay();
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
    if (inOblivion.length > 0) hardDelete(inOblivion);
  }

  /** Permanent delete: tombstone off disk + relay. Used only for items already
   *  in oblivion (emptying the recycle bin) — root deletions go through
   *  moveNodes(_, OBLIVION) instead. */
  function hardDelete(paths: string[]) {
    if (!folder) return;
    const fileSet = new Set(Object.keys(files));
    const folderSet = new Set(emptyFolders);
    // Prune to top-level: drop any path nested beneath another deleted path.
    // The synthetic root (the mounted folder) is never deletable — the UI
    // hides Delete from its context menu, but this is the trust boundary.
    const tops = paths
      .filter((p) => p !== ROOT && p !== OBLIVION)
      .filter((p) => !paths.some((q) => q !== p && isDescendantOrSelf(q, p)));
    if (tops.length === 0) return;
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

    // Disk delete + delete node + manifest tombstone. Each top-level path is an
    // independent backend delete, so partial failures don't block the rest.
    for (const path of tops) {
      const isFolderDelete = folderSet.has(path) || hasChild(fileSet, folderSet, path);
      void backendRef.current.deletePath(path, isFolderDelete)
        .then(refreshMountedReplay)
        .catch((e) =>
          console.warn(`[workspace] deletePath failed for ${path}:`, e),
        );
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
    const isFolderRename = folderSet.has(path) || hasChild(fileSet, folderSet, path);
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

    chooseDirectorySelection(
      directorySelectionRef.current.map((item) => ({ ...item, path: rebaser(item.path) })),
    );
    commitUiFocus(rebaseUiFocus(uiFocusRef.current, rebaser, renameTabRebaser));

    // Storage rename + an identity-preserving provenance step. Carry each
    // affected file's user tags through, same as moveNodes.
    const userTagsByPath: Record<string, string[]> = {};
    for (const [p, st] of Object.entries(files)) {
      if (p === path || (isFolderRename && p.startsWith(path + "/"))) {
        userTagsByPath[p] = st.tags;
      }
    }
    void backendRef.current.renamePath(path, cleanName, isFolderRename, userTagsByPath)
      .then(refreshMountedReplay)
      .catch((e) =>
        console.warn(`[workspace] renamePath failed for ${path}:`, e),
      );
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
                tokenEstimate={tokenEstimate}
                onInspect={(operation) => void openInspector(operation)}
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

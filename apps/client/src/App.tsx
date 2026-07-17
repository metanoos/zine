import { Component, Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { MutableRefObject, ReactNode } from "react";
import { createPortal } from "react-dom";
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
import { markdownIndentExtensions } from "./tab-indent.js";
import { RefCountedStepGate } from "./ref-counted-step-gate.js";
import {
  sampleRelays,
  hitToDocument,
  appendToPalette,
  fetchPalette,
  rankSampleHits,
  forkFileFromNode,
  upsertManifestEntry,
  resolveTagCandidates,
  browseTag,
  fetchChain,
  fetchFolderActivity,
  fetchFolderNodes,
  fetchEventById,
  publishHardenedSpan,
  sha256HexLocal,
  sendStep,
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
  clearPendingLlmMeta,
  setPendingLlmMeta,
  fetchManifest,
  findMergeCandidates,
  incorporateMergeCandidate,
  loadMergeSides,
  mergeFile,
  type PaletteItem,
  type TagCandidate,
  type EventMeta,
  type FocusSelection,
  type FocusEntry,
  type CitationChip,
  type MergeCandidate,
  type KEdit,
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
} from "./provenance.js";
import { MergePanel } from "./MergePanel.js";
import { MergePreviewModal } from "./MergePreviewModal.js";
import { threeWayMerge, autoMergedText } from "./three-way-merge.js";
import { AttestModal } from "./AttestModal.js";
import { RunModal } from "./RunModal.js";
import { PromptInspectorModal } from "./PromptInspectorModal.js";
import { SendFailureModal } from "./SendFailureModal.js";
import { describeSendFailure, type SendFailureView } from "./send-failure.js";
import { runAgentLoop, type AgentCtx } from "./agent-loop.js";
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
  type AutomationScope,
} from "./automation-store.js";
import { ensureModelVoice } from "./model-voice.js";
import { ownerFolderOf, activeMounted } from "./focus-routing.js";
import { activateTreeItem, type ActivatableTreeItem } from "./tree-routing.js";
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
  onCopySpanFacet,
  resolveBracket,
  resolvedBracketMarkup,
  selectedNodeIdFacet,
  wrapSelectionCommand,
  type Mode,
} from "./brackets.js";
import { markdownPreviewExtensions } from "./markdown-preview.js";
import {
  classifyPaletteSelection,
  palettePrimaryAction,
  paletteSecondaryActions,
  type PaletteSelectionState,
} from "./palette.js";
import {
  COIN_CLIPBOARD_MIME,
  canCoinText,
  parseCoinClipboardEnvelope,
  serializeCoinClipboardEnvelope,
} from "./coin-clipboard.js";

import { DownloadView } from "./Download.js";
import { AboutView } from "./About.js";
import { aboutHashTarget } from "./about-documents.js";
import { NetworkingView } from "./Networking.js";
import { ModelsView } from "./ModelsView.js";
import { KeysView } from "./KeysView.js";
import { GlobeView } from "./Globe.js";
import { TimesView } from "./TimesView.js";
import { ListingsView } from "./ListingsView.js";
import { SocialQueryBar } from "./SocialQueryBar.js";
import {
  loadSocialQuery,
  saveSocialQuery,
  type SocialQuery,
} from "./social-query.js";
import { PinPanel } from "./PinPanel.js";
import { OperatorView } from "./OperatorView.js";
import {
  bindOperator,
  isStaff,
  refreshOperatorState,
  getOperatorState,
  type OperatorState,
} from "./operator-store.js";
import {
  identityColors,
  identityForPubkey,
  loadKeys,
  authorVoice,
  modelSecretKey,
  secretKeyForVoice,
  subscribeVoiceIdentities,
  voiceSpanStyle,
  type KeyEntry,
} from "./keys-store.js";
import { VoiceLegend } from "./VoiceLegend.js";
import {
  loadWorkspaceLayout,
  saveWorkspaceLayout,
  type WorkspaceLayout,
} from "./workspace-layout-store.js";
import { getVoiceProvider, setVoiceProvider } from "./voice-provider-store.js";
import { getVoicePrompt } from "./voice-prompt-store.js";
import { loadProviders, type ProviderConfig } from "./models-store.js";
import {
  PREPARED_OPERATION_VERSION,
  PROMPT_LAYER_VERSIONS,
  PreparedOperationApproval,
  prepareOperation,
  type PreparedOperation,
} from "./prepared-operation.js";
import { contentFingerprint } from "./context-snapshot.js";
import { SnapshotCoordinator, type SnapshotDependencies } from "./snapshot-coordinator.js";
import { providerProfileFingerprint } from "./provider-fingerprint.js";
import {
  executePreparedOperation,
  type CurrentModelTarget,
  type RecoverableModelResult,
} from "./model-operation-executor.js";
import { captureKEditTransaction, groupKEditsByTransaction } from "./kedit-capture.js";
import {
  captureStreamingScrollAnchor,
  restoreStreamingScrollTop,
} from "./streaming-scroll.js";
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
} from "./workspace.js";
import { createLocalWorkspace, type StagedMerge } from "./workspace-local.js";
import { loadLocalFolder, saveLocalFile, mirrorPad, clearPadPath, loadPad, loadLocalShielded, saveLocalShielded, type LocalFile } from "./local-store.js";
import {
  EMPTY_KEDIT_LOG,
  applyKEditTransaction,
  appendKEditLog,
  changedRegion,
  dominantVoiceInRegion,
  dropKEditLogPrefix,
  ensureMdExt,
  fileHasUnsteppedChanges,
  keditLogFromArray,
  keditLogToArray,
  minimalTextChange,
  nextKEditTx,
  reconcileRunsText,
  spliceRuns,
  type FileStepBaseline,
  type KEditLog,
  type Workspace,
} from "./workspace-core.js";
import { getPublicKey } from "nostr-tools/pure";
import { isTauri, resolveRelayUrl } from "./identity.js";
import { canSignWithSecrets } from "./secret-store.js";
import {
  getOrCreateMintFolder,
  getRootId,
  getRootLabel,
  mintRoot,
  setRootLabel,
  DEFAULT_ROOT_LABEL,
} from "./root.js";
import {
  getSubstrateVoice,
  getSubstrateSignerKeyId,
  setSubstrateSignerKeyId,
  getSubstrateBindingPubkey,
} from "./external-voice-store.js";
import {
  gatherContextBlock,
  gatherContextSnapshot,
  clearChainMemo,
  renderLimelightLog,
  isShielded,
} from "./context-gather.js";
import {
  applyScopeClick,
  mountsForGroupAction,
  mountedScopeLabel,
  pathIsMounted,
  pathInEffectiveScopes,
  rebaseMountsAfterMove,
  scopeKey,
  topLevelMountedPaths,
  type ScopeRef,
} from "./scope-model.js";
import {
  appendReplayStepsAtLiveEnd,
  freshMountedReplayHeads,
  replayHeadSignature,
} from "./replay-live-sync.js";
import {
  planAttestation,
  planDelivery,
  type AttestationPlan,
} from "./step-policy.js";
import { occupancyTransitions, type OccupancyEntry } from "./panel-occupancy.js";
import {
  createReplayPanels,
  removeReplayPanels,
} from "./replay-panel-layout.js";
import {
  type OpKind as PromptOpKind,
  type OpInputs,
} from "./op-prompts.js";
import {
  loadOpLensSelections,
  saveOpLensSelection,
  type OpLensId,
} from "./op-lenses.js";
import {
  BarChart3,
  BookOpen,
  Code,
  Coins,
  Cpu,
  Download,
  Eye,
  FileText,
  Folder,
  FolderOpen,
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
  Settings,
  Sun,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import {
  MINT,
  OBLIVION,
  forkPathForMint,
  formatLocalSecondStamp,
  isMintPath as isMint,
  isOblivionPath as isOblivion,
  isSystemRootPath,
  mintedPath,
  slugifyFilename,
  uniquePath,
} from "./generated-paths.js";
import { deleteOutcomeMessage } from "./delete-confirmation.js";
import { closeDeletedTabs, type DeleteTabTarget } from "./delete-tabs.js";
import {
  buildDirectoryTree,
  type TreeEntry,
  type TreeNode,
} from "./tree-model.js";
import "./App.css";

// Active new-file/new-folder creation. `parent` is the folder path the new
// item should be created inside ("" = workspace root). Set by the
// mounted-folder row's New buttons (scoped to the active trace's folder) and
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
  /** Ephemeral column created for animated replay, never persisted. */
  replayOwned?: boolean;
}

type PanelOccupancy = OccupancyEntry<FocusSelection>;


// The unified "active trace" — there is always one once the user has selected
// anything, and it is what the action palette's ACTIONS row operates on. A trace is
// the protocol's single primitive (file | folder | coin), all
// realized as a kind-4290 nucleus. `path` is set for file/folder selections;
// `nodeId` is the trace nucleus id (file/folder chain head or coin id);
// `phrase` carries the visible text for a coin selection.
type SelectionKind = "file" | "folder" | "coin";
interface SelectionRef {
  kind: SelectionKind;
  path?: string;
  nodeId?: string;
  phrase?: string;
}

interface AttestTarget {
  path: string;
  kind: "file" | "folder" | "coin";
  nodeId?: string;
  plan: Exclude<AttestationPlan, "unavailable">;
}

interface CoinClipboardCitation {
  phrase: string;
  nodeId: string;
}

interface CoinClipboardTicket {
  phrase: string;
  citation: Promise<CoinClipboardCitation>;
}

// One step in a folder-wide replay timeline. `contentUpToHere` is the file's
// text as of this step (the chain replayed genesis→this node), precomputed at
// `beginReplay` so stepping is O(1) per step. The step list is ordered by
// `steppedAtMs` ascending and interleaves every file's steps AND every folder
// membership event (kind 4292: add/remove/rename).
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
  /** Present when this step is a FOLDER MEMBERSHIP event (kind 4292), not a file
   *  content step. A membership step has no `contentUpToHere`/`runsUpToHere`/
   *  `changeRange` (those are "" / [] / null) — it's a structural station on the
   *  timeline, labeled with the membership change (added/removed/renamed X) and
   *  shown only via the stepper's step label. Scrubbing onto a membership step
   *  does NOT freeze a file or swap tabs: there's no content to show, so scope
   *  stays sticky and focus stays put. `relativePath` still carries the affected
   *  path so the label can name it. */
  membership?: { type: "add" | "remove" | "rename"; path: string };
}

// One frame of keystroke playback — the file's runs after applying one editor
// transaction. `stepIndex` is the index into `replay.steps` of the Step whose
// transaction produced this frame, so a pause can snap the cursor to the right
// save point. Built once per play session and torn down on pause/stop; the Step
// timeline and its slider keep working at save-point granularity throughout.
interface PlayFrame {
  path: string;
  stepIndex: number;
  runs: Run[];
}

// Views reachable from the nav rail. `editor` is the existing two-panel
// workspace; the rest are placeholders awaiting real implementations
// (globe → maplibre, keys/relays → nostr, models → LLM keys).
type View = "about" | "listings" | "editor" | "stats" | "globe" | "keys" | "networking" | "models" | "download" | "operator";

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

// Horizontal resize of the press: how wide the collection/palette sidebar is.
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

/** Reconstruct a FileState from a crash-pad entry overlaid on the disk-scanned
 *  state. The pad entry carries the buffer's content (a flat string) and
 *  optionally the live per-voice run list. When runs are present and flatten to
 *  the stored content, they're reused (preserving voice attribution across the
 *  crash); otherwise the content becomes a single run under the stored voice
 *  pubkey (or the AUTHOR voice as fallback). `existing` contributes kind/eventMeta
 *  that the pad doesn't track. Desktop-only in practice (the webapp has no pad). */
function mergePadIntoFileState(existing: FileState | undefined, lf: LocalFile): FileState {
  const runs =
    lf.runs && lf.runs.length > 0 && flatten(lf.runs) === lf.content
      ? lf.runs
      : lf.content.length === 0
        ? []
        : [{ voice: lf.voicePubkey ?? authorVoice(), text: lf.content }];
  return {
    kind: existing?.kind,
    runs,
    nodeId: lf.nodeId || existing?.nodeId || "",
    tags: lf.tags ?? existing?.tags ?? [],
    taggedTraces: lf.taggedTraces ?? existing?.taggedTraces,
    // Carry the drained keystroke log so an unstepped buffer survives a
    // reload and lands on the next step.
    ...(lf.kedits && lf.kedits.length > 0 ? { kedits: keditLogFromArray(lf.kedits) } : {}),
    ...(existing?.eventMeta ? { eventMeta: existing.eventMeta } : {}),
  };
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

// The four action-palette LLM operations. With a non-empty editor selection, each
// acts on just the selected text (continuing/condensing/reinventing/replying
// to that range in place); with no selection, each acts on the whole document.
export type OpKind = "extend" | "settle" | "stir" | "reply" | "receive" | "step" | "send" | "attest" | "run";

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

function restoreSettleAnchors(response: string, anchors: readonly string[]): string {
  let restored = response;
  const used = new Set<number>();
  restored = restored.replace(/__ZINE_ANCHOR_(\d+)__/g, (_match, rawIndex: string) => {
    const index = Number(rawIndex) - 1;
    if (!Number.isInteger(index) || !anchors[index]) return "";
    used.add(index);
    return anchors[index];
  });
  for (let index = 0; index < anchors.length; index++) {
    if (!used.has(index)) restored += `${restored.endsWith("\n") ? "" : "\n"}${anchors[index]}`;
  }
  return restored;
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

/** Split a buffered Reply/Receive response into an optional TITLE header and
 * body. If the first line is not a TITLE, preserve the whole response. */
function parseReplyOutput(raw: string): { title: string | null; body: string } {
  const nl = raw.indexOf("\n");
  if (nl < 0) {
    const m = raw.match(/^TITLE:\s*(.+?)\s*$/i);
    if (m) {
      const title = m[1].trim();
      return { title: title || null, body: "" };
    }
    return { title: null, body: raw };
  }
  const first = raw.slice(0, nl);
  const rest = raw.slice(nl + 1).replace(/^\r?\n/, "");
  const m = first.match(/^TITLE:\s*(.+?)\s*$/i);
  if (m) {
    const title = m[1].trim();
    return { title: title || null, body: rest };
  }
  return { title: null, body: raw };
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

/** Effective scope is the selected union with shielded traversal boundaries. */
function isInScope(
  scopes: readonly ScopeRef[],
  shielded: Set<string>,
  targetPath: string,
): boolean {
  return (
    !!targetPath &&
    !isOblivion(targetPath) &&
    !isMint(targetPath) &&
    pathInEffectiveScopes(scopes, shielded, targetPath)
  );
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
  // Mint is a flat, append-only system region. Ordinary items cannot be moved
  // into it. Dragging one of its coins out is a Fork gesture, so the original
  // remains and basename collisions are resolved when the fork path is built.
  if (isMint(destFolder) || (isOblivion(destFolder) && isMint(src))) return false;
  if (isMint(src)) {
    return src !== MINT && !isSystemRootPath(destFolder);
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
/** Tab label: the basename of a file, or the basename of a folder's relpath. */
const tabLabel = (p: string): string => basename(isFolderTab(p) ? folderTabPath(p) : p);
/** Tab tooltip: a folder tab shows its relpath with a trailing slash to read
 *  as a folder; a file tab shows its raw path. */
const tabTitle = (p: string): string => (isFolderTab(p) ? folderTabPath(p) + "/" : p);

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
  for (const p of panels) for (const t of p.tabs) open.add(t);
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
  scopes,
  shielded,
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
  /** Tree path shown by the active tab in the focused panel. Kept separate
   *  from scope so switching tabs never changes which traces are mounted. */
  focusedTabPath: string | null;
  /** Explicit mounts. Their folder descendants belong to derived scope. */
  scopes: readonly ScopeRef[];
  /** Shielded paths. A folder shields its entire subtree. */
  shielded: Set<string>;
  /** Row click with modifier context. The Sidebar owns the selection model:
   *  plain click mounts-sole + activates (file opens, folder toggles);
   *  Cmd/Ctrl-click toggles a mount without activating; Shift-click ranges
   *  from the anchor. Folder expand/collapse is folded in here so a plain
   *  click both selects and toggles, matching the prior single-select UX. */
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
  /** New file / New folder from the mounted-folder row. Parent is chosen by
   *  the Sidebar (active-trace scope); only the root row renders the buttons. */
  onCreateStart: (kind: "file" | "folder") => void;
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
  const isDragging = draggingPaths.has(node.path);
  const isDropTarget = dropTargetPath === node.path;
  const isRenaming = renamingPath === node.path;
  const isTabFocused = focusedTabPath !== null && node.path === focusedTabPath;
  if (node.type === "folder") {
    const isOpen = !collapsed.has(node.path);
    const dropAllowed = canDropOn(node.path);
    const isRoot = node.isRoot === true;
    const isCappedSystemRegion =
      node.systemKind === "mint" || node.systemKind === "oblivion";
    // A directly mounted shielded trace starts a new inclusion root; shielded
    // descendants below that root remain traversal boundaries.
    const folderMounted = pathIsMounted(scopes, node.path);
    const folderShielded = isShielded(shielded, node.path);
    const folderInScope =
      !isOblivion(node.path) &&
      !isMint(node.path) &&
      pathInEffectiveScopes(scopes, shielded, node.path);
    const folderShownShielded = folderShielded && !folderInScope;
    const folderIconClass =
      "tree-icon" +
      (folderShownShielded ? " tree-icon-shielded" : folderInScope ? " tree-icon-in-scope" : "");
    const rowClass =
      "tree-row tree-folder" +
      (isRoot ? " tree-row-root" : "") +
      (isTabFocused ? " tree-row-tab-focused" : "") +
      (folderMounted ? " tree-row-mounted" : "") +
      (folderShownShielded ? " tree-row-shielded" : "") +
      (isDragging ? " tree-dragging" : "") +
      (isDropTarget && dropAllowed ? " tree-drop-target" : "") +
      (isDropTarget && !dropAllowed ? " tree-drop-denied" : "");
    const folderGlyph =
      node.systemKind === "mint" ? (
        <Leaf size={13} className="tree-icon" aria-hidden="true" />
      ) : node.systemKind === "oblivion" ? (
        <Trash2 size={13} className="tree-icon" aria-hidden="true" />
      ) : node.systemKind === "root" ? (
        <BookOpen size={13} className={folderIconClass} aria-hidden="true" />
      ) : isOpen ? (
        <FolderOpen size={13} className={folderIconClass} aria-hidden="true" />
      ) : (
        <Folder size={13} className={folderIconClass} aria-hidden="true" />
      );
    return (
      <div className={"tree-node" + (isCappedSystemRegion ? " tree-node-system" : "")}>
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
            // Don't toggle collapse when the rename input is mounted; clicking
            // into the field would otherwise yank the row open/closed. A plain
            // click both selects the folder (gold box) and toggles it; modifier
            // clicks (cmd/shift) are handled by onRowActivate, which only
            // toggles expand on a plain (non-modifier) click.
            if (!isRenaming) {
              onRowActivate(node, e);
              if (!e.metaKey && !e.ctrlKey && !e.shiftKey) onToggleFolder(node.path);
            }
          }}
        >
          {node.systemKind ? (
            <span
              className="tree-icon-slot tree-system-icon"
              title={node.systemKind === "mint" ? "Mint" : node.systemKind === "oblivion" ? "Oblivion" : "Root"}
              aria-hidden="true"
            >
              {folderGlyph}
            </span>
          ) : (
            <span className="tree-icon-slot" aria-hidden="true">
              {folderGlyph}
            </span>
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
            <span className="tree-name">{node.name}</span>
          )}
          {node.attestations !== undefined && (
            <span
              className="tree-attestation-badge"
              title={`${node.attestations} reachable attestation${node.attestations === 1 ? "" : "s"}`}
              aria-label={`${node.attestations} reachable attestation${node.attestations === 1 ? "" : "s"}`}
            >
              {node.attestations}
            </span>
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
                scopes={scopes}
                shielded={shielded}
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

  const fileMounted = pathIsMounted(scopes, node.path);
  const fileShielded = isShielded(shielded, node.path);
  const fileInScope =
    !isOblivion(node.path) &&
    !isMint(node.path) &&
    pathInEffectiveScopes(scopes, shielded, node.path);
  const fileShownShielded = fileShielded && !fileInScope;
  const fileIconClass =
    "tree-icon" +
    (fileShownShielded ? " tree-icon-shielded" : fileInScope ? " tree-icon-in-scope" : "");

  return (
    <div
      className={
        "tree-row tree-file" +
        (isTabFocused ? " tree-row-tab-focused" : "") +
        (fileMounted ? " tree-row-mounted" : "") +
        (fileShownShielded ? " tree-row-shielded" : "") +
        (isDragging ? " tree-dragging" : "")
      }
      style={indent}
      aria-current={isTabFocused ? "true" : undefined}
      draggable={!isRenaming}
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
      {node.systemKind === "minted" ? (
        <span
          className="tree-icon-slot tree-system-icon"
          title="Coin"
          aria-hidden="true"
        >
          <Coins size={13} className="tree-icon" aria-hidden="true" />
        </span>
      ) : (
        <span className="tree-icon-slot" aria-hidden="true">
          <FileText size={13} className={fileIconClass} aria-hidden="true" />
        </span>
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
        <span className="tree-name">{node.name}</span>
      )}
      {node.attestations !== undefined && (
        <span
          className="tree-attestation-badge"
          title={`${node.attestations} reachable attestation${node.attestations === 1 ? "" : "s"}`}
          aria-label={`${node.attestations} reachable attestation${node.attestations === 1 ? "" : "s"}`}
        >
          {node.attestations}
        </span>
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
  scopes,
  onScopesChange,
  shielded,
  onToggleShielded,
  onActivateFile,
  onActivateFolder,
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
  onBeginReplay,
  replayStep,
  replayIndex,
  replayCount,
  stepTimes,
  playing,
  playSpeed,
  replayActive,
  onStep,
  onTogglePlay,
  onCycleSpeed,
  playFraction,
  onOpenFolder,
  onOpenSettings,
}: {
  tree: TreeNode[];
  collapsed: Set<string>;
  onToggleFolder: (path: string) => void;
  /** Tree path shown by the active tab in the focused panel, or null when no
   *  tab is active. Drives only the focus marker; it never mutates scope. */
  focusedTabPath: string | null;
  /** Explicit mounts, owned by App. Effective scope is derived from this set. */
  scopes: readonly ScopeRef[];
  onScopesChange: (scopes: ScopeRef[]) => void;
  /** Shielded traversal boundaries, passed through to each row. */
  shielded: Set<string>;
  onToggleShielded: (path: string) => void;
  /** Open a file into the active panel and make it the active trace. Called on
   *  a plain (non-modifier) click of a file row. */
  onActivateFile: (path: string) => void;
  /** Make a folder the active trace (folders aren't editors, so nothing opens).
   *  Called on a plain (non-modifier) click of a folder row. Expand/collapse is
   *  toggled separately by the row's onClick. */
  onActivateFolder: (path: string) => void;
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
  /** Open a folder as a folder tab in the *active* panel (the context menu's
   *  "Open"). Mirrors onActivateFile but for folders: opens the special
   *  folder tab instead of leaving the folder as a selection-only trace. */
  onOpenFolder: (path: string) => void;
  /** Open the settings panel (factory reset lives here). */
  onOpenSettings: () => void;
  /** Bootstrap folder-wide replay (async fetch of the folder's steps). Called
   *  by the transport's ▶ when no timeline is loaded yet. */
  onBeginReplay: () => void;
  /** The current replay step (the one the editor is showing), or null when not
   *  replaying. Drives the transport's hover tooltip (action/file/time/blurb). */
  replayStep: ReplayStep | null;
  /** Current replay index (0-based). `replayCount - 1` is the sticky `last`.
   *  Display-only position for the transport: while keystroke playback runs
   *  this tracks the edit frame being shown (each PlayFrame carries its
   *  producing step's stepIndex) so the slider/stepper stay in sync with the
   *  visible typing; otherwise it's the committed `replay.index`. The committed
   *  `replay.index` itself drives the editor's frozen-content override + snapshot
   *  capture/restore, which must not thrash per edit — so the caller derives
   *  this display value without advancing the committed one. */
  replayIndex: number;
  /** Total replay steps in the folder timeline. */
  replayCount: number;
  /** steppedAtMs per step, in step order. Drives the time-proportional slider
   *  axis: large time gaps between adjacent steps render as translucent colored
   *  bands inside the track ("3d", "4h"), clickable to jump across idle spans
   *  instead of stepping one-by-one. `[]` (or omit) → index-linear fallback. */
  stepTimes?: number[];
  /** Whether the auto-play timer is advancing the timeline. */
  playing: boolean;
  /** Current play speed multiplier. */
  playSpeed: number;
  /** True while replay holds the editor read-only (historical step or playback).
   *  Highlights the ⏭ skip-to-live escape in the transport. */
  replayActive: boolean;
  /** Seek replay to step `n`. */
  onStep: (n: number) => void;
  /** Toggle auto-play on/off. */
  onTogglePlay: () => void;
  /** Advance to the next play speed (wraps). */
  onCycleSpeed: () => void;
  /** Sub-step progress (0..1) through the current save point during
   *  playback — drives the fractional readout (3.4 / 12) and thumb glide. */
  playFraction?: number;
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

  // The shift-range anchor is local interaction state. Mounts live in App;
  // panels and tabs cannot mutate them by changing focus.
  const [anchorPath, setAnchorPath] = useState<string | null>(null);
  const mountedPaths = useMemo(() => new Set(scopes.map((scope) => scope.path)), [scopes]);
  const replayMountedLabel = useMemo(
    () => mountedScopeLabel(scopes, tree.find((node) => node.path === ROOT)?.name ?? "Root"),
    [scopes, tree],
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
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; path: string } | null>(null);
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

  // Clear the range anchor when the attached folder changes.
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
    const out: ScopeRef[] = [];
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
    // is showing. `focusedTabPath` follows open tabs, while `scopes` changes
    // only through tree gestures. Falls back to focused-panel location when
    // there is not exactly one scoped folder.
    if (scopes.length === 1) {
      const selected = scopes[0];
      if (selected.kind === "folder") {
        return selected.path;
      }
    }
    const p = focusedTabPath;
    if (!p) return ROOT;
    if (folderPaths.has(p) || hasChild(filePaths, folderPaths, p)) return p;
    return parentPath(p);
  }

  // The tree is the sole mount-selection surface. Modifier clicks only update
  // mounts; a plain click also activates the trace (file opens, folder toggles).
  function onRowActivate(item: ActivatableTreeItem, e: React.MouseEvent) {
    const result = applyScopeClick(
      scopes,
      { kind: item.type, path: item.path },
      visibleItems,
      anchorPath,
      { additive: e.metaKey || e.ctrlKey, range: e.shiftKey },
    );
    onScopesChange(result.scopes);
    setAnchorPath(result.anchorPath);
    if (e.metaKey || e.ctrlKey || e.shiftKey) return;
    activateTreeItem(item, { file: onActivateFile, folder: onActivateFolder });
  }

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

  // Right-click mounts-sole if the row wasn't already mounted, otherwise keeps
  // the current mounts so the menu acts on the whole set.
  function openContextMenu(e: React.MouseEvent, item: ActivatableTreeItem) {
    e.preventDefault();
    e.stopPropagation();
    const actionMounts = mountsForGroupAction(scopes, {
      kind: item.type,
      path: item.path,
    });
    if (!mountedPaths.has(item.path)) {
      onScopesChange(actionMounts);
      setAnchorPath(item.path);
    }
    setCtxMenu({ x: e.clientX, y: e.clientY, path: item.path });
  }

  // The paths a Delete should act on: the current selection, pruned of any
  // path nested beneath another selected path (an ancestor carries its
  // descendants, so listing both would double-count).
  function topLevelSelected(): string[] {
    return topLevelMountedPaths(scopes);
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
  // basename; the focus/select effect above selects it for overtype. ROOT has
  // no basename — use the synthetic root node's display label instead.
  function requestRename(path: string) {
    setCtxMenu(null);
    setRenamingPath(path);
    setRenameDraft(path === ROOT ? (tree[0]?.name ?? "") : basename(path));
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
    return [...draggingPathsRef.current].some((path) => isMint(path) && path !== MINT)
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
      <div className="sidebar-settings-bar">
        <button
          type="button"
          className="icon-btn sidebar-settings-btn"
          title="Settings"
          aria-label="Settings"
          onClick={onOpenSettings}
        >
          <Settings size={16} aria-hidden="true" />
        </button>
      </div>
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
            scopes={scopes}
            shielded={shielded}
            draggingPaths={draggingPaths}
            dropTargetPath={dropTargetPath}
            onDragStart={(item) => {
              const actionMounts = mountsForGroupAction(scopes, {
                kind: item.type,
                path: item.path,
              });
              // Dragging an explicitly mounted row drags the mounted group;
              // dragging any other row first mounts it alone.
              if (!mountedPaths.has(item.path)) {
                onScopesChange(actionMounts);
                setAnchorPath(item.path);
              }
              const nextDragging = new Set(topLevelMountedPaths(actionMounts));
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
      {ctxMenu && (
        <div
          ref={menuRef}
          className="ctx-menu"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
          onContextMenu={(e) => e.preventDefault()}
        >
          {(() => {
            // Same folder-test as elsewhere: an explicit empty-folder entry, or
            // any file/folder nested beneath it. The synthetic root (path ===
            // ROOT) is always treated as a folder here so the mounted folder
            // offers the folder actions in its context menu too.
            const isFolder =
              ctxMenu.path === ROOT ||
              isSystemRootPath(ctxMenu.path) ||
              folderPaths.has(ctxMenu.path) ||
              hasChild(filePaths, folderPaths, ctxMenu.path);
            // Open actions are inherently single-target. Hide them for a
            // mounted group rather than silently applying them to one member.
            return !isFolder && mountedPaths.size === 1 ? (
              <>
                <button
                  type="button"
                  className="ctx-menu-item"
                  // Open the file as a tab in the active panel.
                  onClick={() => {
                    const p = ctxMenu.path;
                    setCtxMenu(null);
                    onOpenFolder(p);
                  }}
                >
                  Open
                </button>
                <button
                  type="button"
                  className="ctx-menu-item"
                  // Open this file into a fresh column immediately to the right
                  // of the active panel.
                  onClick={() => {
                    const p = ctxMenu.path;
                    setCtxMenu(null);
                    onOpenToSide(p);
                  }}
                >
                  Open to side
                </button>
                <div className="ctx-menu-separator" aria-hidden="true" />
              </>
            ) : null;
          })()}
          {(() => {
            // New File / New Folder target the right-clicked folder. Same
            // folder-test as elsewhere: an explicit empty-folder entry, or any
            // file/folder nested beneath it. The synthetic root (path === ROOT)
            // is always treated as a folder here so the mounted folder offers
            // "new" in its context menu too.
            const isFolder =
              ctxMenu.path === ROOT ||
              isSystemRootPath(ctxMenu.path) ||
              folderPaths.has(ctxMenu.path) ||
              hasChild(filePaths, folderPaths, ctxMenu.path);
            // Creation needs one destination folder, so it is not offered for
            // a multi-mount context action.
            return isFolder &&
              mountedPaths.size === 1 &&
              !isMint(ctxMenu.path) &&
              !isOblivion(ctxMenu.path) ? (
              <>
                <button
                  type="button"
                  className="ctx-menu-item"
                  onClick={() => {
                    const p = ctxMenu.path;
                    setCtxMenu(null);
                    onCreateStart("file", p);
                  }}
                >
                  New File
                </button>
                <button
                  type="button"
                  className="ctx-menu-item"
                  onClick={() => {
                    const p = ctxMenu.path;
                    setCtxMenu(null);
                    onCreateStart("folder", p);
                  }}
                >
                  New Folder
                </button>
                <div className="ctx-menu-separator" aria-hidden="true" />
              </>
            ) : null;
          })()}
          {(() => {
            // Restore: move an item in Oblivion (or selection) back to root. Only
            // offered on items INSIDE oblivion (not the oblivion root itself).
            const inOblivion = topLevelSelected().filter((p) => isOblivion(p) && p !== OBLIVION);
            return inOblivion.length > 0 ? (
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
            ) : null;
          })()}
          {ctxMenu.path !== ROOT && !isMint(ctxMenu.path) && !isOblivion(ctxMenu.path) && (
            <>
              <button
                type="button"
                className="ctx-menu-item"
                title={
                  shielded.has(ctxMenu.path)
                    ? "Include in command scope again"
                    : "Exclude from command scope"
                }
                onClick={() => {
                  const p = ctxMenu.path;
                  setCtxMenu(null);
                  onToggleShielded(p);
                }}
              >
                {shielded.has(ctxMenu.path)
                  ? "Unshield from command scope"
                  : "Shield from command scope"}
              </button>
              <div className="ctx-menu-separator" aria-hidden="true" />
            </>
          )}
          {!isMint(ctxMenu.path) && !isOblivion(ctxMenu.path) && (
            <button
              type="button"
              className="ctx-menu-item"
              // Rename is a single-item operation; disable it when the selection
              // spans more than one row so the affordance matches the behavior.
              // The synthetic root is renamable (display label only).
              disabled={mountedPaths.size > 1}
              onClick={() => requestRename(ctxMenu.path)}
            >
              Rename
            </button>
          )}
          {filePaths.has(ctxMenu.path) && topLevelSelected().length === 1 && (
            <button
              type="button"
              className="ctx-menu-item danger"
              onClick={() => {
                const path = ctxMenu.path;
                setCtxMenu(null);
                setRevokeMessage(null);
                setRevokeError(null);
                setConfirmRevoke({ path, name: basename(path) });
              }}
            >
              Request relay revocation…
            </button>
          )}
          {ctxMenu.path !== ROOT && !isSystemRootPath(ctxMenu.path) && !isMint(ctxMenu.path) && (
            <button
              type="button"
              className="ctx-menu-item danger"
              onClick={() => requestDelete(topLevelSelected())}
            >
              Delete{mountedPaths.size > 1 ? ` (${mountedPaths.size})` : ""}
            </button>
          )}
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
      <ReplayTransport
        mountedLabel={replayMountedLabel}
        index={replayIndex}
        count={replayCount}
        playing={playing}
        playSpeed={playSpeed}
        replayActive={replayActive}
        onBegin={onBeginReplay}
        onStep={onStep}
        onTogglePlay={onTogglePlay}
        onCycleSpeed={onCycleSpeed}
        stepTimes={stepTimes}
        playFraction={playFraction}
        // Hover context for the row: the current step's action, file, time,
        // and (for LLM steps) its summary or prompt. On `last` this is the
        // just-stepped node; on a historical step it's the save point being
        // verified. Only shown once replay is active.
        containerTitle={
          replayStep
            ? replayStep.membership
              ? // A membership step's label is the structural change itself —
                // "added notes/draft.md", "removed old.md" — not file prose.
                [
                  replayStep.membership.type,
                  replayStep.membership.path,
                  new Date(replayStep.meta.steppedAtMs).toLocaleString(),
                ]
                  .filter(Boolean)
                  .join(" · ")
              : [
                  replayStep.meta.action ?? "edit",
                  replayStep.relativePath,
                  new Date(replayStep.meta.steppedAtMs).toLocaleString(),
                  stepDescription(replayStep.event).summary ??
                    stepDescription(replayStep.event).prompt,
                ]
                  .filter(Boolean)
                  .join(" · ")
            : undefined
        }
      />
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


// --- in-place diff pane --------------------------------------------------
//
// Replaces the editor surface in the panel when the active tab's mode is
// "diff" (the third surface alongside Preview/Markdown). The editor
// (FileEditor) stays mounted underneath — LLM ops, palette citations, and
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
// replay stepper overwrites file.runs with step #N's snapshot (replayStepTo),
// so the working buffer is NOT flatten(file.runs) here — the live buffer is
// passed in via replayLiveText (parked in replay.snapshot[path]).
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
// Always-visible transport pinned at the bottom of the sidebar. Three rows,
// shown directly (no "Replay folder" gate):
//   row 1 — mounted scope:      MOUNTED drafts/ + final.md
//   row 2 — stepper + counter:  ⏮ ◀ [n / total] ▶ ⏭   (left-aligned)
//   row 3 — transport:          ▶/⏸  ·  N×  ·  [===== slider =====]
// The stepper + slider jump save-point to save-point. Play animates per
// character (typewriter). `last` is sticky (resting = live document): a new
// step while parked at the right end appends a step, the counter ticks up, and
// the slider's max grows to include it. Before replay is bootstrapped (count
// 0) the step buttons disable and ▶ becomes "load & play" — it bootstraps the
// timeline (beginReplay is async) then starts playback.
//
// Time-proportional axis: the slider is a custom control (a native <input
// type="range"> can't map its thumb to anything but linear-in-value). Ticks,
// thumb, and idle bands are all positioned by real steppedAtMs via stepAxis,
// so a 3-day gap reads wider than a 3-second one. Large idle spans (>3× the
// median inter-step interval) render as translucent COLORED BANDS inside the
// track, clickable to jump past the idle stretch (the old separate ribbon is
// gone — the bands are in-track now). The n / count readout goes fractional
// (e.g. 3.4 / 12) while playback is mid-way through a save point's char
// reveal, and the thumb interpolates between ticks during play. Playback
// itself advances one char per tick everywhere, so it never dwells on idle —
// the bands are "skipped" in wall-clock terms by construction.

/** Compact, human-readable duration for a gap label. Picks the largest unit
 *  that fits (days → hours → minutes → seconds), rounded. <1s renders as "" so
 *  the caller can drop it (a sub-second gap is never "large"). */
function formatGap(ms: number): string {
  const s = ms / 1000;
  if (s >= 86400) return `${Math.round(s / 86400)}d`;
  if (s >= 3600) return `${Math.round(s / 3600)}h`;
  if (s >= 60) return `${Math.round(s / 60)}m`;
  if (s >= 1) return `${Math.round(s)}s`;
  return "";
}

/** The large gaps in a timeline, for the scan ribbon. Each entry is positioned
 *  by its `afterIndex` (the step immediately before the gap) and carries its
 *  gap span in ms. "Large" = > 3× the median inter-step interval; with <3 steps
 *  there's no meaningful median, so nothing is flagged. */
function computeGaps(times: number[]): { afterIndex: number; ms: number }[] {
  if (times.length < 3) return [];
  const intervals: number[] = [];
  for (let i = 1; i < times.length; i++) {
    const d = times[i] - times[i - 1];
    if (d > 0) intervals.push(d);
  }
  if (intervals.length === 0) return [];
  const sorted = [...intervals].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const threshold = median * 3;
  const out: { afterIndex: number; ms: number }[] = [];
  for (let i = 1; i < times.length; i++) {
    const d = times[i] - times[i - 1];
    if (d > threshold) out.push({ afterIndex: i - 1, ms: d });
  }
  return out;
}

/** Fraction (0..1) of step `i` along a time-proportional axis — ticks/thumb/
 *  bands are spaced by real steppedAtMs instead of evenly by index. Falls back
 *  to index-linear when there are <2 steps or the timestamps aren't monotonic
 *  (e.g. all-equal/zero steppedAtMs), so a bad timeline can't collapse the axis. */
function timeFraction(stepTimes: number[], i: number): number {
  const n = stepTimes.length;
  if (n < 2 || i <= 0) return 0;
  if (i >= n - 1) return 1;
  const span = stepTimes[n - 1] - stepTimes[0];
  if (span <= 0) return i / (n - 1);
  return (stepTimes[i] - stepTimes[0]) / span;
}

/** Inverse of timeFraction for the slider's drag/keyboard handlers: pick the
 *  step whose time-fraction is nearest `f`. Last-wins on ties so dragging right
 *  monotonically advances. */
function fractionToStep(stepTimes: number[], f: number): number {
  const n = stepTimes.length;
  if (n < 2) return 0;
  const clamped = Math.max(0, Math.min(1, f));
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < n; i++) {
    const d = Math.abs(timeFraction(stepTimes, i) - clamped);
    if (d <= bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}

/** Position helper for ReplayTransport: time-proportional when we have a full
 *  timeline (one timestamp per step), index-linear otherwise. Centralizes the
 *  fallback so the slider, ticks, and bands all share one axis. */
function stepAxis(stepTimes: number[] | undefined, count: number): (i: number) => number {
  if (stepTimes && stepTimes.length === count && count > 1) {
    return (i: number) => timeFraction(stepTimes, i);
  }
  return (i: number) => (count > 1 ? i / (count - 1) : 0);
}

/** Sub-step progress (0..1) of the playback cursor through its enclosing
 *  save point — drives the fractional readout (3.4 / 12) and the thumb's
 *  interpolation between ticks. `timeline` is the per-char play frames,
 *  `cursor` the current frame index. Returns 0 when not mid-reveal (or when a
 *  step has only one frame, where there's nothing to sub-divide). */
function stepPlayFraction(timeline: PlayFrame[] | null, cursor: number): number {
  if (!timeline || cursor < 0 || cursor >= timeline.length) return 0;
  const step = timeline[cursor].stepIndex;
  let start = cursor;
  while (start > 0 && timeline[start - 1].stepIndex === step) start--;
  let end = cursor;
  while (end + 1 < timeline.length && timeline[end + 1].stepIndex === step) end++;
  const span = end - start;
  return span > 0 ? (cursor - start) / span : 0;
}

function ReplayTransport({
  mountedLabel,
  index,
  count,
  playing,
  playSpeed,
  replayActive,
  onBegin,
  onStep,
  onTogglePlay,
  onCycleSpeed,
  containerTitle,
  stepTimes,
  playFraction,
}: {
  /** Exact explicit mount union whose effective scope supplies this timeline. */
  mountedLabel: string;
  index: number;
  count: number;
  /** Whether the auto-play timer is advancing. */
  playing: boolean;
  /** Current play speed multiplier. */
  playSpeed: number;
  /** True while replay holds the editor read-only (a historical step, or
   *  mid-playback). Highlights the ⏭ skip-to-live escape as the way out —
   *  landing on `last` flips this false and lifts read-only. */
  replayActive: boolean;
  /** Bootstrap replay (async fetch of the folder's steps). Called by ▶ when no
   *  timeline is loaded yet. */
  onBegin: () => void;
  /** Seek replay to step `n`. Driven by the stepper buttons and the slider. */
  onStep: (n: number) => void;
  /** Toggle auto-play on/off. Starts at the current step; reaching last stops. */
  onTogglePlay: () => void;
  /** Advance to the next speed (wraps). */
  onCycleSpeed: () => void;
  /** Hover context for the whole block: the current step's action/file/time/(blurb).
   *  Lets the condensed layout still say where you are without a summary line. */
  containerTitle?: string;
  /** steppedAtMs per step, in step order. Drives the time-proportional axis. */
  stepTimes?: number[];
  /** Sub-step progress (0..1) through the current save point during
   *  playback — drives the fractional readout (3.4 / 12) and lets the thumb
   *  interpolate between ticks. 0 when parked/not playing. */
  playFraction?: number;
}) {
  const bootstrapped = count > 0;
  const first = index <= 0;
  const last = index >= count - 1;
  // The custom slider is positioned by absolute time (stepAxis), not by index.
  // A native <input type="range"> can't map its thumb to anything but linear-
  // in-value, so this is a div + pointer/keyboard handler replicating the
  // native contract (drag, arrows, Home/End, a11y). Seeking stays integer
  // (fractionToStep snaps to the nearest save point).
  const tf = stepAxis(stepTimes, count);
  const gaps = stepTimes && stepTimes.length > 0 ? computeGaps(stepTimes) : [];
  const frac = playFraction ?? 0;
  // The readout goes fractional only mid-reveal: parked = "3 / 12", playing
  // between steps 3→4 = "3.4 / 12". toFixed(1) drops the decimal for .0.
  const shown = playing && frac > 0 ? (index + frac).toFixed(1) : String(index + 1);
  const clampStep = (n: number) => Math.max(0, Math.min(count - 1, n));
  const seekFromClientX = (clientX: number, el: HTMLElement) => {
    const rect = el.getBoundingClientRect();
    const f = rect.width > 0 ? (clientX - rect.left) / rect.width : 0;
    onStep(stepTimes && stepTimes.length === count ? fractionToStep(stepTimes, f) : clampStep(Math.round(f * (count - 1))));
  };
  return (
    <div
      className={"sidebar-replay" + (playing ? " is-playing" : "")}
      role="group"
      aria-label={`Replay timeline mounted on ${mountedLabel}`}
      title={containerTitle}
    >
      <div
        className="sidebar-replay-row sidebar-replay-scope"
        title={`Mounted timeline: ${mountedLabel}`}
      >
        <span className="sidebar-replay-scope-key">Mounted</span>
        <span className="sidebar-replay-scope-value">{mountedLabel}</span>
      </div>
      <div className="sidebar-replay-row sidebar-replay-stepper">
        <button
          type="button"
          className="steps-step-btn"
          disabled={!bootstrapped || first || playing}
          onClick={() => onStep(0)}
          title="First save point"
        >
          ⏮
        </button>
        <button
          type="button"
          className="steps-step-btn"
          disabled={!bootstrapped || first || playing}
          onClick={() => onStep(index - 1)}
          title="Previous save point"
        >
          ◀
        </button>
        <span className="steps-position" title="Save point position in the folder timeline">
          {count > 0 ? `${shown} / ${count}` : "— / —"}
        </span>
        <button
          type="button"
          className="steps-step-btn"
          disabled={!bootstrapped || last || playing}
          onClick={() => onStep(index + 1)}
          title="Next save point"
        >
          ▶
        </button>
        <button
          type="button"
          className={
            "steps-step-btn" + (replayActive && !last ? " sidebar-replay-skip" : "")
          }
          // ⏭ is the read-only escape: always enabled (even mid-playback) so
          // the highlighted button reliably drops you back on the live doc.
          // onStep tears down the edit timeline before seeking to `last`.
          disabled={!bootstrapped || last}
          onClick={() => onStep(count - 1)}
          title="Skip to live (latest save point)"
        >
          ⏭
        </button>
      </div>
      <div className="sidebar-replay-row sidebar-replay-transport">
        <button
          type="button"
          className="steps-step-btn sidebar-replay-play"
          disabled={playing}
          onClick={() => (bootstrapped ? onTogglePlay() : onBegin())}
          title={
            playing
              ? "Pause playback"
              : bootstrapped
                ? "Play through the timeline"
                : "Load this folder's steps and play"
          }
        >
          {playing ? "⏸" : "▶"}
        </button>
        <button
          type="button"
          className="sidebar-replay-speed"
          onClick={onCycleSpeed}
          title="Cycle playback speed"
        >
          {playSpeed}×
        </button>
        <div
          // Custom time-proportional slider. role=slider + aria-valu* gives
          // screen readers the same contract the old <input type="range"> had.
          // onPointerDown both seeks-and-begins-drag (pointer capture keeps the
          // drag tracking outside the element). Disabled while playing — seek
          // pauses playback anyway, and dragging during autoplay would fight it.
          className="sidebar-replay-track"
          role="slider"
          aria-label="Replay position"
          aria-valuemin={0}
          aria-valuemax={Math.max(0, count - 1)}
          aria-valuenow={index}
          aria-valuetext={`Save point ${index + 1} of ${count}`}
          aria-disabled={!bootstrapped || playing}
          tabIndex={bootstrapped && !playing ? 0 : -1}
          onPointerDown={(e) => {
            if (!bootstrapped || playing) return;
            (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
            seekFromClientX(e.clientX, e.currentTarget);
          }}
          onPointerMove={(e) => {
            // Only treat as a drag while the pointer is held (buttons pressed).
            if (e.buttons === 0) return;
            if (!bootstrapped || playing) return;
            seekFromClientX(e.clientX, e.currentTarget);
          }}
          onKeyDown={(e) => {
            if (!bootstrapped || playing) return;
            switch (e.key) {
              case "ArrowRight":
              case "ArrowUp":
                e.preventDefault();
                onStep(index + 1);
                break;
              case "ArrowLeft":
              case "ArrowDown":
                e.preventDefault();
                onStep(index - 1);
                break;
              case "Home":
                e.preventDefault();
                onStep(0);
                break;
              case "End":
                e.preventDefault();
                onStep(count - 1);
                break;
            }
          }}
        >
          {/* Track rule: the 3px baseline the ticks/thumb sit on. */}
          <span className="sidebar-replay-rule" aria-hidden="true" />
          {/* Idle bands: large time gaps (>3× median interval) rendered in-track
              as translucent colored spans, clickable to jump past the idle
              stretch. Replaces the old separate ScanGapRibbon. */}
          {gaps.map((g) => {
            const label = formatGap(g.ms);
            if (!label) return null;
            const left = tf(g.afterIndex);
            const width = tf(g.afterIndex + 1) - left;
            const target = g.afterIndex + 1;
            return (
              <button
                key={g.afterIndex}
                type="button"
                className={
                  "sidebar-replay-band" + (index === target ? " is-current" : "")
                }
                style={{ left: `${left * 100}%`, width: `${width * 100}%` }}
                // Stop propagation so clicking a band seeks instead of starting
                // a track drag; disabled mid-playback to match the rest.
                onPointerDown={(e) => {
                  e.stopPropagation();
                  if (!playing) onStep(target);
                }}
                aria-hidden="true"
                tabIndex={-1}
                title={`Skip ${label} idle → save point ${target + 1} of ${count}`}
              >
                {label}
              </button>
            );
          })}
          {/* Savepoint ticks: one per step, positioned along the time axis.
              Dim so the thumb reads as the live position; pointer-events:none
              so the track stays the only interactive layer. */}
          {count > 0 && (
            <div className="sidebar-replay-ticks" aria-hidden="true">
              {Array.from({ length: count }, (_, i) => (
                <span
                  key={i}
                  className="sidebar-replay-tick"
                  style={{ left: `${tf(i) * 100}%` }}
                />
              ))}
            </div>
          )}
          {/* Thumb: interpolates between the current tick and the next by
              `playFraction` during playback, so it glides across the time axis
              rather than snapping per save point. */}
          {count > 0 && (
            <span
              className="sidebar-replay-thumb"
              aria-hidden="true"
              style={{
                left: `${(tf(index) + (tf(Math.min(index + 1, count - 1)) - tf(index)) * frac) * 100}%`,
              }}
            />
          )}
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
// Pre-keychain this was the hardcoded "author-1". Resolved live at each call site
// rather than captured once at module load (a module-level const would freeze
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
const onCopySpanCompartment = new Compartment();
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

/** The keystroke log: one `KEdit` per discrete editor change since the last
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
    // not a user edit, so the keystroke log resets.
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
// React-driven Reply/Receive streams arrive as append-only setRuns updates.
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
  onCopySpan: (nodeId: string, phrase: string) => void,
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
    // Selected-span ring + chip-click/chip-copy handlers, each reconfigurable
    // live so a selection move re-rings the right `[[ span ]]` (and a chip
    // click/copy reports to App) without rebuilding the editor.
    selectedNodeIdCompartment.of(selectedNodeIdFacet.of(selectedNodeId)),
    onSelectSpanCompartment.of(onSelectSpanFacet.of(onSelectSpan)),
    onCopySpanCompartment.of(onCopySpanFacet.of(onCopySpan)),
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
  onCopySpan,
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
  /** Clicking a citation chip's copy button curates the span (clipboard +
   *  palette append). Mirrors onSelectSpan's ref-indirection so the chip's
   *  copy widget stays current without rebuilding the editor. */
  onCopySpan: (nodeId: string, phrase: string) => void;
  /** Copy/paste hooks that upgrade an intra-press text transfer into a
   * coin-backed resolved citation. Returning false preserves native clipboard
   * behavior for external/plain text. */
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
  // Same indirection for the chip's copy-curates side effect.
  const onCopySpanRef = useRef(onCopySpan);
  onCopySpanRef.current = onCopySpan;
  const onCopySelectionRef = useRef(onCopySelection);
  onCopySelectionRef.current = onCopySelection;
  const onPasteSelectionRef = useRef(onPasteSelection);
  onPasteSelectionRef.current = onPasteSelection;

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
      (nodeId, phrase) => onCopySpanRef.current(nodeId, phrase),
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

  const dragHitsDocumentChrome = (target: EventTarget | null) =>
    target instanceof Element && target.closest(".editor-chrome-slot") !== null;

  function citationDragOver(e: React.DragEvent<HTMLDivElement>) {
    if (!citationDropMarkup || dragHitsDocumentChrome(e.target)) return;
    if (!isZinePathDrag(e.dataTransfer)) return;
    const srcPath = zinePathFromDataTransfer(e.dataTransfer);
    // WebKit may hide getData() until drop. Accept the known custom drag during
    // hover, then make the coin-only decision with the real path at drop time.
    if (srcPath && !citationDropMarkup(srcPath)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }

  function citationDrop(e: React.DragEvent<HTMLDivElement>) {
    if (!citationDropMarkup || dragHitsDocumentChrome(e.target)) return;
    const srcPath = zinePathFromDataTransfer(e.dataTransfer);
    if (!srcPath) return;
    e.preventDefault();
    e.stopPropagation();
    const markup = citationDropMarkup(srcPath);
    if (!markup) return;
    if (readOnly) {
      triggerRejectRef.current();
      return;
    }
    const view = viewRef.current;
    if (!view) return;
    const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
    if (pos === null) return;
    view.dispatch({
      changes: { from: pos, insert: markup },
      selection: { anchor: pos + markup.length },
      scrollIntoView: true,
    });
    onCitationDrop?.();
    view.focus();
  }

  return (
    <>
      <div
        ref={hostRef}
        className={"editor-host" + (rejecting ? " editor-host-reject" : "")}
        onDragOverCapture={citationDragOver}
        onDropCapture={citationDrop}
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
// `FileState.taggedTraces` remains the compatibility storage name for the
// latter because changing that wire meaning is a protocol change; the UI calls
// both forms citations.
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
            key={`${e.kind}:${e.sourceTraceId ?? e.sourceEventId}:${e.fromNodeId}`}
            type="button"
            className="panel-inbound-chip"
            title={
              kind === "fork"
                ? `forked from ${e.fromNodeId.slice(0, 8)}…\nby ${e.ownerPubkey.slice(0, 12)}…\ntrace ${e.sourceEventId}`
                : `cited by ${e.ownerPubkey.slice(0, 12)}…\ntrace ${e.sourceEventId}`
            }
            onMouseDown={(ev) => {
              ev.stopPropagation();
              onOpen(e.sourceTraceId ?? e.sourceEventId);
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
// FileState.taggedTraces, the protocol's existing no-body citation
// representation (`q` + `tag-add`). The internal name is retained for wire
// compatibility; the reader-facing concept is a citation.
//
// Disabled for read-only/foreign folders and for
// files that haven't stepped yet (no nodeId to cite). Candidates with no nodeId
// are filtered out — you can't cite what hasn't been stepped.
function CitationPicker({
  candidates,
  alreadyCited,
  disabled,
  onActivate,
  onPick,
}: {
  candidates: TraceCandidate[];
  alreadyCited: string[];
  disabled: boolean;
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
        title={disabled ? "Step this file before inserting citations" : "Insert citation"}
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
                    {basename(c.path)}
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
      <span className="event-meta-chip">{meta.pubkey.slice(0, 8)}</span>
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

type SummonStatus = { state: "idle" | "running" | "done" | "error"; msg?: string; op?: OpKind };

const VOICE_OPS: { op: OpKind; label: string; title: string; cls: string }[] = [
  { op: "receive", label: "Receive", title: "Analyze the writing process from the delta + limelight logs into a new audit doc", cls: "op-receive" },
  { op: "reply", label: "Reply", title: "Write a response into a new doc in the other pane, citing traces", cls: "op-reply" },
  { op: "extend", label: "Extend", title: "Append an AI continuation to this file", cls: "op-extend" },
  { op: "stir", label: "Stir", title: "Reinvent loose prose, run (( commands )), preserve [[ anchors ]]", cls: "op-stir" },
  { op: "settle", label: "Settle", title: "File: condense loose prose, keep brackets. Folder: de-dupe near-duplicate scans into one", cls: "op-settle" },
  { op: "run", label: "Run", title: "Start an agent run — research and draft in a new subfolder under the current scope", cls: "op-run" },
];

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


// --- action palette ----------------------------------------------------
//
// The single always-visible palette at the bottom of the press. Three rows in
// a shared column grid — identity/model left, actions, then status right:
//   AUTHOR:    | pen | Step/Mint Send Attest · · | — | — | err | —
//   model▾     | inj | Receive Reply Extend Stir Settle Run | — | 1.2k | err | —
//   FILESYSTEM | key | Scan Reify · · · · | — | — | — | —
// The MODEL row's leftmost cell holds the model selector itself (the chosen
// model name reads as the row's label — no separate "MODEL:" text). Five equal
// action tracks; AUTHOR uses the first three, MODEL fills all five. An
// in-flight op re-renders its OWN button as the stop control (accent + pulse;
// click again to abort) instead of a separate Stop button, so the affordance
// stays where the click that started it landed. Ops gate on the outlined
// target.
function ActionPalette({
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
  /** Open the prompt inspector (click on the token-count indicator). */
  onInspect,
  attestPlan,
  targetInScope,
  /** Semantic state of the focused editor passage. Mutates the AUTHOR primary
   *  slot between Step, Mint, disabled Coin, and disabled invalid Mint. */
  authorSelectionState,
  /** True when Send will append a Step before distributing it. */
  sendAutoSteps,
  /** True when Step has updates to record, or must create the first node. */
  stepAvailable,
  /** Wrap the selected loose passage in double square brackets. */
  onPreserve,
  onScopeToTarget,
  substrate,
  onChooseSubstrate,
  substrateKeyId,
  onChooseSubstrateKey,
  onScan,
  onReifyOp,
  replayFrozen,
  onForkReplay,
}: {
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
  selection: SelectionRef | null;
  /** Which op kind is in flight on the target panel, or null when idle. The
   *  button for this op re-renders as the live stop control — click it again
   *  to abort — instead of spawning a separate Stop button. */
  runningOp: OpKind | null;
  /** Run an op against the op-target panel. */
  onOp: (op: OpKind) => void;
  /** Stop the in-flight op on the target panel. */
  onStop: () => void;
  /** Status of the op-target panel, for the action row's stop/error. */
  opStatus: SummonStatus;
  /** Approximate prompt token count for an op on the target file, or null when
   *  no folder/file is active. Shown beside the action buttons, and is the
   *  click target that opens the prompt inspector. */
  tokenEstimate: number | null;
  /** Open the prompt inspector modal (fired by clicking the token count). */
  onInspect: () => void;
  /** Prerequisites the Attest gesture will compose before endorsement. */
  attestPlan: AttestationPlan;
  /** Whether the focused/target file is inside the scope subtree. When false,
   *  write ops (Step/Send/Extend/Stir/Settle/Reply) disable — content must not
   *  travel without its orchestration — and the palette surfaces a "scope to this
   *  file's folder" affordance via `onScopeToTarget`. Read actions are
   *  unaffected. Attest only requires scope when it must create a new Step;
   *  endorsing or ensuring reachability of an existing exact node does not
   *  write into the target content. */
  targetInScope: boolean;
  /** Semantic state of the focused editor passage presented by the palette. */
  authorSelectionState: PaletteSelectionState;
  /** Whether Send's delivery plan is append-and-send rather than send-latest. */
  sendAutoSteps: boolean;
  /** Whether the focused trace has work for an explicit Step. */
  stepAvailable: boolean;
  /** Preserve the live loose-text selection by wrapping it in `[[ ]]`. */
  onPreserve: () => void;
  /** Scope the stepper/context to the focused file's parent folder, lifting the
   *  out-of-scope block on write ops. Wired to a one-click affordance shown when
   *  `targetInScope` is false. */
  onScopeToTarget: () => void;
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
  /** Reify: flush a trace out to a picked destination folder. */
  onReifyOp: () => void;
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

  // --- ACTIONS gating ---------------------------------------------------
  const kind = selection?.kind;
  const allowTextOps = kind === "file";
  const allowReply = kind === "file" || kind === "coin";
  const allowDeliver = kind === "file" || kind === "folder";
  const immutableMint = kind === "file" && !!selection?.path && isMint(selection.path);
  // Focus-∈-scope invariant: write ops need both the right selection KIND and
  // the target to be inside the scope subtree. Out-of-scope → the affordance
  // surfaces; the user re-scopes deliberately rather than having content
  // injected without its orchestration.
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

  // Key <select> for a row, styled in the chosen voice's font/color.
  function KeySelect({
    selectedId,
    onSelect,
    ariaLabel,
  }: {
    selectedId: string | null;
    onSelect: (id: string) => void;
    ariaLabel: string;
  }) {
    const entry = keys.find((k) => k.id === selectedId) ?? null;
    const { fg, bg } = entry
      ? identityColors(entry.identity, 0.22)
      : { fg: "var(--ink)", bg: "transparent" };
    return (
      <select
        className="action-palette-select action-palette-key-select"
        value={selectedId ?? ""}
        onChange={(e) => onSelect(e.target.value)}
        aria-label={ariaLabel}
        style={entry ? { color: fg, background: bg, fontFamily: entry.identity.font } : undefined}
      >
        <optgroup label="Keys">
          {keys.map((k) => (
            <option key={k.id} value={k.id} style={{ fontFamily: k.identity.font }}>
              {k.label}
            </option>
          ))}
        </optgroup>
      </select>
    );
  }

  // Model select — sole assignment for which provider LLM ops use. Option
  // text is the Models-card label (the editable name on each card), under a
  // Models optgroup. Not modelId — that's the API id field on the card.
  function ModelSelect() {
    return (
      <select
        className="action-palette-select action-palette-model-select"
        value={resolvedModelProviderId}
        onChange={(e) => onSelectProvider(e.target.value)}
        title="Model for AI ops"
        aria-label="Model for AI ops"
        disabled={providers.length === 0}
      >
        {providers.length === 0 ? (
          <option value="">add a model…</option>
        ) : (
          <optgroup label="Models">
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label || p.modelId || p.id}
              </option>
            ))}
          </optgroup>
        )}
      </select>
    );
  }

  // Columns: label | key | 5 action tracks | model | tokens | error | slot.
  // AUTHOR Step/Send/Attest occupy the first three tracks; MODEL ops fill all
  // five (Receive/Reply/Extend/Stir/Settle). An in-flight op re-renders its own
  // button as the live stop control (accent + pulse; click again to abort)
  // rather than spawning a separate Stop button — so the affordance stays
  // where the click happened.
  return (
    <div className="action-palette">
      <div className="action-palette-group">
        <button
          type="button"
          className="action-palette-label action-palette-label-clickable"
          title={`Click to rename the typing voice — currently ${authorAlias}`}
          onClick={() => {
            const next = rollAuthorAlias(authorAlias);
            localStorage.setItem(AUTHOR_LABEL_KEY, next);
            setAuthorAlias(next);
          }}
        >
          {authorAlias}:
        </button>
        <KeySelect
          selectedId={authorKeyId}
          onSelect={onChooseAuthorKey}
          ariaLabel="Author voice"
        />
        {(() => {
          const isRunning = runningOp === "step";
          const enabled =
            isRunning ||
            (!runningOp &&
              primaryAction.actionable &&
              (hasMintablePassage || stepAvailable) &&
              (hasMintablePassage ? targetInScope : scopedDeliver) &&
              !immutableMint);
          return (
            <button
              type="button"
              className={`action-palette-action op-save action-palette-primary action-palette-primary--${primaryAction.tone}${isRunning ? " running" : ""}`}
              data-palette-selection={authorSelectionState}
              disabled={!enabled}
              title={
                isRunning
                  ? `${primaryAction.label} — running, click to stop`
                  : authorSelectionState === "none" && !stepAvailable
                    ? "No updates since the last Step"
                    : primaryAction.title
              }
              onClick={() => (isRunning ? onStop() : onOp("step"))}
            >
              {primaryAction.label}
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
          if (!visible) {
            return <span key={v.op} className="action-palette-slot" aria-hidden="true" />;
          }
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
        {/* Fork: the AUTHOR row's escape hatch from a replay-frozen historical
            view. The panel is read-only while parked on a past step; Fork seeds
            a new editable trace from that step's node. Disabled (invisible to
            action) unless the op-target panel is frozen on a historical step. */}
        <button
          type="button"
          className="action-palette-action action-palette-action-fork"
          disabled={!replayFrozen}
          title={
            replayFrozen
              ? "Fork this historical version into a new editable trace"
              : "Fork is available when replay is paused on a past step"
          }
          onClick={onForkReplay}
        >
          Fork
        </button>
        <span className="action-palette-slot" aria-hidden="true" />
        <span className="action-palette-slot" aria-hidden="true" />
        <span className="action-palette-slot" aria-hidden="true" />
        <span className="action-palette-slot" aria-hidden="true" />
        <span className="action-palette-slot" aria-hidden="true" />
      </div>

      <div className="action-palette-group">
        {/* The model selector IS the row's label — the chosen model's name
            reads where the voice is declared, at the left edge. Moved from the
            row's end so the active model is visible at a glance instead of
            tucked after the op buttons. The grid cell it vacated becomes a
            action-palette-slot to keep the two rows' shared column template aligned.
            A trailing colon mirrors the AUTHOR: label on the row above. */}
        <span className="action-palette-model-cell">
          <ModelSelect />
          <span className="action-palette-model-colon" aria-hidden="true">:</span>
        </span>
        <KeySelect
          selectedId={modelKeyId}
          onSelect={onChooseModelKey}
          ariaLabel="Model voice"
        />
        {VOICE_OPS.map((v) => {
          const isRunning = runningOp === v.op;
          // extend/stir/settle write INTO the existing file, so they obey the
          // focus-∈-scope invariant (must not mutate content whose chain isn't
          // in context). receive/reply/run create NEW docs/subfolders (analysis /
          // citing doc / agent run), so they're gated by kind only, not by scope.
          const createsDoc = v.op === "receive" || v.op === "reply" || v.op === "run";
          const mutatesTarget = !createsDoc;
          const baseGate = v.op === "receive" ? allowReply : mutatesTarget ? scopedText : scopedReply;
          const enabled =
            isRunning ||
            (!runningOp && hasProviders && baseGate);
          return (
            <button
              key={v.op}
              type="button"
              className={`action-palette-action ${v.cls}${isRunning ? " running" : ""}`}
              disabled={!enabled}
              title={isRunning ? `${v.label} — running, click to stop` : v.title}
              onClick={() => (isRunning ? onStop() : onOp(v.op))}
            >
              {v.label}
            </button>
          );
        })}
        {/* Model selector moved to the row's label cell (left edge); this slot
            keeps the shared two-row grid template aligned. */}
        <span className="action-palette-slot" aria-hidden="true" />
        {!targetInScope && selection?.kind === "file" && !immutableMint && !isOblivion(selection.path ?? "") ? (
          // Out-of-scope nudge: write ops are blocked because the focused file
          // isn't in derived scope. One click mounts its folder (a deliberate
          // act — tab focus never silently changes mounts).
          <button
            type="button"
            className="action-palette-action action-palette-rescope"
            onClick={onScopeToTarget}
            title="Write ops need the target inside scope. Mount this file's folder."
          >
            Mount folder
          </button>
        ) : tokenEstimate != null ? (
          <button
            type="button"
            className="action-palette-token-count"
            onClick={onInspect}
            title="Click to inspect the prompt an op would send · approximate prompt size for an op on the selected file"
          >
            {formatTokens(tokenEstimate)}
          </button>
        ) : (
          <span className="action-palette-slot" aria-hidden="true" />
        )}
        {opStatus.state === "error" && opStatus.msg ? (
          <span className="action-palette-action-error" title={opStatus.msg}>
            {opStatus.msg}
          </span>
        ) : opStatus.state === "done" && opStatus.op ? (
          <span className="action-palette-action-done" title="Op completed">
            {opStatus.op === "step"
              ? "stepped"
              : opStatus.op === "send"
                ? "sent"
                : opStatus.op === "attest"
                  ? "attested"
                  : opStatus.op === "receive"
                    ? "received"
                    : "stepped"}
          </span>
        ) : (
          <span className="action-palette-slot" aria-hidden="true" />
        )}
        {/* Former Stop-button slot: now empty. The stop affordance lives on the
            running op's own button (see .running above), so this track is a
            permanent placeholder to keep the grid's column alignment. */}
        <span className="action-palette-slot" aria-hidden="true" />
      </div>

      <div className="action-palette-group">
        {/* The SUBSTRATE row: mirrors the AUTHOR row but cycles the EXTERNAL
            substrate (the foreign party a scan reads from / a reify writes to)
            instead of the internal typing voice. Click the label to cycle
            (FILESYSTEM → LAPTOP → DESKTOP → EXTERNAL). Scan and Reify are the
            two instants against it. Desktop-only conceptually; on the webapp
            there is no disk substrate, so both buttons are inert. */}
        <button
          type="button"
          className="action-palette-label action-palette-label-clickable"
          title={`Click to cycle the substrate — currently ${substrate}`}
          onClick={() => onChooseSubstrate(nextSubstrate(substrate))}
        >
          {substrate}:
        </button>
        {/* The substrate's pen/voice/key: which keychain key signs scans from
            this substrate. Mirrors the AUTHOR row's KeySelect. Null until the
            user picks one or the first scan auto-provisions. */}
        <KeySelect
          selectedId={substrateKeyId}
          onSelect={onChooseSubstrateKey}
          ariaLabel={`Signer for ${substrate}`}
        />
        <button
          type="button"
          className="action-palette-action op-scan"
          disabled={!isTauri()}
          title={isTauri() ? "Scan File: acquire one file as a new trace under the scope; repeated scans add copies" : "Scanning is desktop-only (the substrate is the local disk)"}
          onClick={() => onScan("file")}
        >
          Scan File
        </button>
        <button
          type="button"
          className="action-palette-action op-scan"
          disabled={!isTauri()}
          title={isTauri() ? "Scan Folder: recursively acquire a folder as new traces under the scope; repeated scans add copies" : "Scanning is desktop-only (the substrate is the local disk)"}
          onClick={() => onScan("folder")}
        >
          Scan Folder
        </button>
        <button
          type="button"
          className="action-palette-action op-reify"
          disabled={!isTauri()}
          title={isTauri() ? "Reify: flush a trace out to a picked destination folder" : "Reifying is desktop-only (the substrate is the local disk)"}
          onClick={onReifyOp}
        >
          Reify
        </button>
        <span className="action-palette-slot" aria-hidden="true" />
        <span className="action-palette-slot" aria-hidden="true" />
        <span className="action-palette-slot" aria-hidden="true" />
        <span className="action-palette-slot" aria-hidden="true" />
        <span className="action-palette-slot" aria-hidden="true" />
      </div>
    </div>
  );
}

function Panel({
  panelIdx,
  tabs,
  activePath,
  file,
  folderId,
  replayStepText,
  replayPrevText,
  replayLiveText,
  active,
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
  onCopySpan,
  onCopySelection,
  onPasteSelection,
  onReplayEditAttempt,
  citations,
  taggedChips,
  inbound,
  inboundFreshness,
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
}: {
  panelIdx: number;
  tabs: string[];
  activePath: string;
  file?: FileState;
  /** The attached folder's id — needed to fetch this file's step chain for the
   *  in-place Diff surface. "" when no folder is attached. */
  folderId: string;
  /** When the replay stepper has frozen THIS file on a historical step, the
   *  step's content snapshot (else null). Drives replay-mode Diff. */
  replayStepText?: string | null;
  /** In replay mode, the previous content-step of this file (vs prev). */
  replayPrevText?: string | null;
  /** In replay mode, the live working buffer parked in replay.snapshot. */
  replayLiveText?: string | null;
  active: boolean;
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
  onTabDragEnterTarget: (path: string) => void;
  onTabDragLeaveTarget: (path: string) => void;
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
  /** Clicking a citation chip's copy button curates the span (clipboard +
   *  palette append). */
  onCopySpan: (nodeId: string, phrase: string) => void;
  onCopySelection: (view: EditorView, event: ClipboardEvent) => boolean;
  onPasteSelection: (view: EditorView, event: ClipboardEvent) => boolean;
  /** Fired when the user tries to edit while replay-frozen. The App surfaces
   *  the fork-from-snapshot modal. Passed through to FileEditor. */
  onReplayEditAttempt?: () => void;
  /** Every resolved `q` edge on this file's current head. */
  citations: CitationChip[];
  /** Explicit no-body citations, still stored under the protocol-compatible
   *  `taggedTraces` field. Resolved from the live id set so additions appear
   *  before the next Step advances the head. */
  taggedChips: CitationChip[];
  /** Forks and citations that point into this trace. Rendered after the final
   *  document line as read-only click-to-open chips. */
  inbound: TraceInbound[];
  /** Verification state for the inbound row. */
  inboundFreshness?: InboundFreshness;
  /** Clicking a cited-trace chip opens that trace's Steps modal pinned to the
   *  cited node. */
  onOpenCitation: (nodeId: string) => void;
  /** Sibling traces in the current folder, available to the citation picker
   *  candidates (path + current head nodeId). Built from `files` by the App. */
  traceCandidates: TraceCandidate[];
  /** Whether the citation picker is disabled (foreign/read-only folder, or the
   *  active file hasn't stepped yet). */
  pickerDisabled: boolean;
  /** Add/remove an explicit no-body citation. The backing field retains its
   *  protocol name (`taggedTraces`) while the UI calls it a citation. */
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
}) {
  // One outgoing list, regardless of the protocol path that created the `q`.
  // Current body brackets are the source of truth for the visible "quoted"
  // marker; this updates immediately while the head's resolved q-list catches
  // up on the next Step. Explicit no-body citations are removable in place.
  const quotedIds = new Set(
    (file ? findResolvedBrackets(flatten(file.runs ?? [])) : [])
      .map((bracket) => bracket.nodeId)
      .filter(Boolean),
  );
  const explicitCitationIds = new Set(file?.taggedTraces ?? []);
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

  const modeToggle = !draggingTab ? (
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
          alreadyCited={file.taggedTraces ?? []}
          disabled={pickerDisabled || readOnly}
          onActivate={onFocusPanel}
          onPick={onAddCitation}
        />
      </div>
    </div>
  ) : null;

  const provenanceHeader = file ? (
    <>
      {citationBar}
      <VoiceLegend runs={file.runs ?? []} onFocusVoice={setFocusedVoice} />
    </>
  ) : null;

  const inboundFooter = file ? (
    <InboundRow
      inbound={inbound}
      freshness={inboundFreshness}
      onOpen={(nodeId) => {
        onFocusPanel();
        onOpenCitation(nodeId);
      }}
    />
  ) : null;

  // Replay is a mode, not a selection edge. Name the state directly in stable
  // chrome so the top-scrollbar transform cannot invert or obscure it.
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
              onDropOnListEnd();
            }
          }}
          onDragOver={(e) => {
            if (draggingTab) {
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
            }
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
            // The active trace is the single frontmost tab of the focused
            // panel. Every panel has a front tab (isActive), but only the
            // focused panel's front tab receives the top-border selection
            // marker (.tab.trace-active).
            const isTraceActive = isActive && active;
            const isInScope = tabIsInScope(p);
            const isDragging = draggingTab?.path === p && draggingTab.fromPanel === panelIdx;
            const isBeforeTarget =
              dropTargetTab?.panel === panelIdx && dropTargetTab.path === p;
            const unsteppedEdits = unsteppedEditCounts.get(p) ?? 0;
            const hasUnsteppedChanges = unsteppedPathSet.has(p);
            const pendingLabel = unsteppedEdits > 999 ? "999+" : String(unsteppedEdits);
            const replayTabDetail = replayFrozen && isActive
              ? "Historical snapshot · Read-only · Fork to edit"
              : replayMounted
                ? "Playback in progress · Read-only"
                : null;
            return (
              <div
                key={p}
                className={
                  "tab" +
                  (isActive ? " active" : "") +
                  (isTraceActive ? " trace-active" : "") +
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
                  if (!isActive) onSelectTab(p);
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
                  {replayTabDetail ? (
                    <span
                      className="tab-replay-badge"
                      aria-label={`Replay: ${replayTabDetail}`}
                      title={`Replay · ${replayTabDetail}`}
                    >
                      REPLAY
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
                  {/* Scope icon to the left of the title. A folder tab's icon
                      mirrors the tree state of that folder: open (FolderOpen)
                      when expanded, closed (Folder) when collapsed. A file tab
                      shows a file glyph. Scope—not tab selection—controls its
                      color: gold in scope, dulled outside it. */}
                  {isFolderTab(p) ? (
                    collapsed?.has(folderTabPath(p)) ? (
                      <Folder size={12} className="tab-status tab-status-folder" aria-hidden="true" />
                    ) : (
                      <FolderOpen size={12} className="tab-status tab-status-folder" aria-hidden="true" />
                    )
                  ) : (
                    <FileText size={12} className="tab-status tab-status-file" aria-hidden="true" />
                  )}
                  {tabLabel(p)}
                </span>
                <button
                  type="button"
                  className="tab-close"
                  aria-label={`Close ${tabLabel(p)}`}
                  title="Close tab"
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
          aria-label={`Replay: ${replayNotice}`}
        >
          <span className="panel-replay-notice-label">REPLAY</span>
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
      {file && active && mergeCandidates.length > 0 && !mergeSessionOpen && (
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
      {file?.eventMeta && <EventMetaBar meta={file.eventMeta} />}
      {file ? (
        // .panel-body positions the one CodeMirror surface that now serves
        // all three modes — LLM ops, palette citations, and Cmd+S step all hold
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
            onCopySpan={onCopySpan}
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
        {RAIL_BOTTOM.map((item) => (
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
// plain `npm run dev` in a browser). Then debounces edits: 1.5s after the
// last change to a file, or immediately on Cmd+S, it writes the file to disk
// via workspace.writeFile — which itself steps a kind-4290 node and republishes
// the kind-34290 manifest, so disk and provenance never drift. The diff/state
// bookkeeping lives in workspace.ts; this hook just owns the debounce timer.

function useProvenance(
  folder: AttachedFolder | null,
  files: Record<string, FileState>,
  replayActiveRef: MutableRefObject<boolean>,
  // The folder-wide replay snapshot lives in `App` (it drives the transport,
  // editor override, fork modal, …). `unsteppedPaths` needs it to skip the one
  // frozen-historical path, so it's threaded in here rather than captured from a
  // closure it can't see (the hook's own scope has no `replay`).
  replay: {
    steps: ReplayStep[];
    index: number;
    snapshot: Record<string, FileState>;
  } | null,
) {
  const pendingTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  // Paths with a debounce step in flight. The external-change rescan reads
  // this to avoid clobbering a file the user is mid-edit on — their in-editor
  // content is newer than disk, so the pending step must win, not the rescan.
  const pendingPaths = useRef<Set<string>>(new Set());
  // LLM-op step suppression. Set to true while an op (Extend/Settle/Stir/
  // Reply) is streaming into the editor: the step effect skips entirely, so
  // a burst of per-token state updates doesn't fire intermediate steps. Each
  // op calls suppressStep(false) in its finally, and if anything was deferred
  // it steps exactly once then — making the whole AI insert a single delta.
  // Without this, a stream whose quiet gap exceeds the debounce (1500ms —
  // model thinking, network hiccup) publishes a half-finished insert, then
  // more tokens arrive and publish again, and the relay's per-connection
  // rate-limit (khatru's ApplySaneDefaults) trips: "rate-limited: slow down".
  const stepSuppressionGate = useRef(new RefCountedStepGate<Uint8Array, LlmStepMeta>());
  const pendingStepPaths = useRef<Set<string>>(new Set());
  // The AUTHOR key's secret, threaded in from App() so the debounced auto-save
  // signs as the AUTHOR key (the ActionPalette AUTHOR control) rather than the hidden
  // active-key default. Read lazily inside scheduleStep's timeout so a
  // mid-debounce AUTHOR switch is honored at fire time. `undefined` means the
  // AUTHOR key isn't in the keychain (deleted) and stepFile falls back to its
  // signer default; the LLM-op catch-up step bypasses this ref and signs with
  // the MODEL key (passed explicitly via suppressStep).
  const authorSignerRef = useRef<(() => Uint8Array | undefined)>(() => undefined);
  // Content-stable dedup for stepFile: the last (content, tags) actually stepped
  // per path, so a no-change step short-circuits before the relay round-trip.
  // The motivating case is the trailing debounce after an LLM op's catch-up
  // step (see stepFile), but it also collapses any other redundant step.
  const lastSteppedRef = useRef<Map<string, FileStepBaseline>>(new Map());
  // Step-on-mount hydration flag: once workspace attach has populated `files`,
  // we don't want the first render's debounce effect to re-publish content
  // that attach already loaded as current. Cleared by the boot effect in App().
  const ready = useRef(false);

  // Spawn the relay sidecar once on mount. Desktop-only: the sidecar is a
  // Tauri command, so in a plain browser (`npm run dev` or the hosted webapp)
  // this is a real no-op — `isTauri()` short-circuits before the dynamic
  // import. Without that gate the import resolves but `invoke` reaches for
  // `window.__TAURI_INTERNALS__.invoke`, and `__TAURI_INTERNALS__` is
  // undefined in a browser, throwing "Cannot read properties of undefined
  // (reading 'invoke')" on every boot.
  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    import("@tauri-apps/api/core")
      .then(({ invoke }) => invoke("spawn_relay"))
      .catch((e: unknown) => {
        if (!cancelled) console.warn("[provenance] spawn_relay failed (relay may already be up):", e);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Debounced write+publish on file content changes.
  useEffect(() => {
    if (!ready.current || !folder) return;
    // Skip while an LLM op is mid-stream: those per-token state updates must
    // not trigger intermediate steps (see the ref-counted step gate). Remember the paths
    // so the op's release can step exactly once at the end — the AI insert
    // then lands as a single delta instead of N checkpoints. Only unstepped paths
    // (content/tags changed since last step) are buffered — a re-render that
    // touches `files` for an unrelated reason (nodeId reflection, panel swap)
    // must not drag every bystander file into the catch-up step, or the burst
    // of relay publishes trips the hosted relay's IP rate-limit.
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

  /** Mirror an unstepped file's buffer to the localStorage crash pad after `ms` of
   *  quiet. The ONLY persistence path for typing: never calls stepFile, so typing
   *  never steps. Both platforms use it (desktop's disk file is untouched until
   *  Step; webapp has no disk, so the pad IS its crash-safety). The buffer is
   *  restored on the next boot via loadPad in openScanned, read as unstepped until
   *  the user Steps. 800ms — tighter than the old 1500ms step debounce because a
   *  localStorage write is synchronous/cheap and crash loss stays capped low. */
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
        runs: f.runs,
        taggedTraces: f.taggedTraces,
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
    // The replay stepper overwrites one file's `runs` with historical content
    // (replayStepTo → setFiles). That historical content legitimately differs
    // from the live stepped baseline, but it is NOT a user edit — it must not
    // arm the step debounce (which would mirror stale history to the crash
    // pad) nor light the unstepped-count badge/title. Skip the one overridden
    // path while parked on a historical step.
    const replayFrozenPath =
      replay && replay.index < replay.steps.length - 1 && !replay.steps[replay.index]?.membership
        ? (replay.steps[replay.index]?.relativePath ?? null)
        : null;
    const out: string[] = [];
    for (const [path, file] of Object.entries(currentFiles)) {
      if (path === replayFrozenPath) continue;
      const last = lastSteppedRef.current.get(path);
      if (fileHasUnsteppedChanges(file, last)) out.push(path);
    }
    return out;
  }

  /** Gate the step pipeline while an LLM op is streaming (on = true) and
   *  release it when it finishes. On release, any path the suppressed effect
   *  deferred is stepped exactly once — the op's whole output becomes a single
   *  delta. Safe to call true→true or false→false; only the true→false edge
   *  triggers the catch-up step.
   *
   *  `signer` (used only on the release edge) is the voice that release step
   *  is signed as — the LLM op's MODEL key, so the AI insert steps as that
   *  voice instead of the AUTHOR key the user is typing under. The debounced
   *  auto-save (scheduleStep) separately resolves the AUTHOR key via
   *  authorSignerRef, so a non-op step also signs with the AUTHOR key. */
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
    // Step everything the suppressed window saw touched. Snapshot first —
    // stepFile is async and may interleave with a new suppression turn.
    const paths = [...pendingStepPaths.current];
    pendingStepPaths.current.clear();
    for (const p of paths) {
      const release = releases.get(p);
      const pathSigner = release?.signer;
      const pathLlmMeta = release?.meta;
      if (isTauri()) {
        // Desktop: the op's output buffers to the crash pad, same as a manual
        // edit — the real file stays clean until the user Steps. Mirroring
        // immediately (no debounce) so a mid-op crash isn't a total loss.
        const f = files[p];
        if (f && folder) {
          if (pathLlmMeta) setPendingLlmMeta(p, pathLlmMeta);
          mirrorPad(folder.id, p, {
            content: flatten(f.runs),
            tags: f.tags,
            nodeId: f.nodeId,
            runs: f.runs,
            taggedTraces: f.taggedTraces,
            kedits: keditLogToArray(f.kedits),
          });
        }
      } else {
        if (pathLlmMeta) setPendingLlmMeta(p, pathLlmMeta);
        void stepFile(p, pathSigner)
          .catch((e) =>
            console.warn(`[provenance] suppressed-step catch-up failed for ${p}:`, e),
          )
          .finally(() => clearPendingLlmMeta(p));
      }
    }
  }

  async function stepFile(path: string, signer?: Uint8Array, localOnly?: boolean, force?: boolean): Promise<string | undefined> {
    if (!folder) return;
    // Coins and Oblivion entries are immutable in place. A Mint coin
    // becomes editable only by forking it into Root; an Oblivion entry must be
    // restored before authoring.
    if (isMint(path) || isOblivion(path)) {
      console.warn("step blocked: Mint and Oblivion are read-only");
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
    // for this path. The tail of an LLM op is the motivating case — the op's
    // catch-up step (deferred in endOp) commits a new nodeId via setFiles,
    // which retriggers the debounce effect; without this guard that trailing
    // step re-runs writeFile, and on a laggy remote relay the manifest read
    // may not yet reflect the catch-up write, so the content-hash dedup in
    // writeFile misses and it republishes the same content. Short-circuiting
    // here makes the trailing step a true no-op for every caller, no relay hop.
    //
    // `force` bypasses this after the palette has authorized an explicit Step.
    // The palette itself disables Step on a current trace; force only prevents
    // a now-authorized user gesture from being swallowed by a baseline race.
    // Debounced auto-save does not pass force, so redundant trailing steps
    // still collapse.
    if (!force) {
      const content = flatten(file.runs);
      const tags = file.tags;
      const taggedTraces = file.taggedTraces ?? [];
      const last = lastSteppedRef.current.get(path);
      if (
        last &&
        last.content === content &&
        last.tags.length === tags.length &&
        last.tags.every((t, i) => t === tags[i]) &&
        (last.taggedTraces ?? []).length === taggedTraces.length &&
        (last.taggedTraces ?? []).every((t, i) => t === taggedTraces[i])
      ) {
        return file.nodeId;
      }
    }
    // Resolve the step's signer to match the voice that actually wrote the
    // net-new text in this commit, not just the caller's default. The
    // debounced auto-save always passes the AUTHOR key, but an LLM op's
    // streamed MODEL text has already landed in file.runs attributed to the
    // MODEL voice by the time this step fires. A step node carries one
    // `event.pubkey`; on reload, if the per-character `authors` map is ever
    // lost (empty runs, sidecar drift, a misordered fetchChain), the reader
    // falls back to attributing the node's whole net-new text to that single
    // signer — collapsing MODEL text to the AUTHOR's color. Picking a signer
    // that matches the new content's dominant voice means the signer-fallback
    // path also attributes truthfully, independent of whether `authors`
    // survives. The explicit signers from the op paths (pre-op baseline =
    // AUTHOR, the catch-up step = MODEL) already match their content, so this
    // only corrects a mismatch; when no secret is available for the dominant
    // voice (e.g. a foreign/sampled voice), the passed signer is kept — safe
    // degradation, no regression.
    const prevContent = lastSteppedRef.current.get(path)?.content ?? "";
    const runs = file.runs;
    const content = flatten(file.runs);
    const region = changedRegion(prevContent, content);
    let effectiveSigner = signer;
    if (region) {
      const dominant = dominantVoiceInRegion(runs, region.from, region.to);
      const signerPubkey = signer ? getPublicKey(signer) : null;
      if (dominant && dominant !== signerPubkey) {
        const resolved = secretKeyForVoice(dominant);
        if (resolved) effectiveSigner = resolved;
      }
    }
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
      // `taggedTraces` is the tagged-but-not-quoted set (the protocol's
      // `tag-add`); writeFile folds it into the same q-tag dedup and emits a
      // `tag-add` delta per id, so adding a trace to this list steps a new node
      // even when content is unchanged.
      const tags = file.tags;
      const taggedTraces = file.taggedTraces ?? [];
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
        effectiveSigner,
        runs,
        taggedTraces.length > 0 ? taggedTraces : undefined,
        kedits.length > 0 ? kedits : undefined,
        localOnly,
        force,
      );
      lastSteppedRef.current.set(path, { content, tags: [...tags], taggedTraces: [...taggedTraces] });
      // Desktop crash pad: the file is now committed to disk, so its buffered
      // copy in the pad is stale — drop it. This is the single chokepoint for
      // every disk write (Cmd+S/Step/Send/Attest/direct backend), so clearing
      // here covers every flush. stepFile is the only thing that reaches the pad
      // in reverse, so no other site needs to clear it.
      if (isTauri() && folder) clearPadPath(folder.id, path);
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
      taggedTraces?: string[],
      kedits?: KEdit[],
      localOnly?: boolean,
      force?: boolean,
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
        taggedTraces: [...(file.taggedTraces ?? [])],
      });
    }
  };

  // Unstepped set: paths whose buffer differs from what was last stepped.
  // Drives the per-tab KEdit count and the window title. Memoized on
  // `files` — correct because every step updates lastSteppedRef before its
  // setFiles, so the post-step re-render sees the path as clean. Also depends on
  // `replay`: stepping the timeline changes which (single) path is frozen and
  // must be skipped, without necessarily touching `files`.
  const unsteppedPathSet = useMemo(() => new Set(unsteppedPaths(files)), [files, replay]);
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
    unsteppedPathSet,
    unsteppedEditCounts,
  };
}

// A right-click menu entry. Either an action button or a visual separator.
// `disabled` is read by the CSS (faded/inert) — e.g. Cut with no selection.
export type GlobalCtxItem =
  | { kind: "action"; label: string; run: () => void; disabled?: boolean }
  | { kind: "sep" };

function App() {
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
  // Settings modal (opened from the sidebar's gear button). Holds the
  // factory-reset action — clears browser state plus the desktop sidecar.
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [resetBusy, setResetBusy] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);
  const [files, setFiles] = useState<Record<string, FileState>>({});
  // Per-node attestation totals visible from the configured read relays. The
  // map deliberately includes zeroes once loaded so every stepped trace gets a
  // stable badge; the badge says "reachable", never "global".
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
      if (f.kind !== "folder" && f.nodeId) {
        out.push({ path, nodeId: f.nodeId, ...(f.traceId ? { traceId: f.traceId } : {}) });
      }
    }
    return out;
  }, [files]);
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
  // The tagged-trace chips for each open file — `file.taggedTraces` (the
  // `tag-add` subset of the head's `q` edges) resolved to named chips. Keyed on
  // the cited id set, NOT on the head node, so a fresh citation appears
  // instantly — before the debounce steps a new head (which is what the
  // `citationsByPath` effect above waits for). `resolveNodeName` caches per
  // node id, so this stays cheap even though it fires on every tag edit.
  const [taggedChipByPath, setTaggedChipByPath] = useState<Record<string, CitationChip[]>>({});
  const [taggedResolutionByPath, setTaggedResolutionByPath] = useState<Record<string, string>>({});
  const hasVisibleCitations = panels.some((panel) => {
    const path = panel.active;
    return !!path && !isFolderTab(path) && files[path]?.kind !== "folder";
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
  // already-cached inbound rows during that window; findInbound applies the
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
  // Folder-wide delta replay (step-to-step), sticky at last. `index === last`
  // is the live editor (no override — edits and steps flow, and a new step
  // appends a step the follow effect advances to); `index < last` overrides
  // that one step's file with its reconstructed content (frozen — the override
  // is a setRunsEffect write `liftRuns` exempts, so no debounce arms) and gates
  // stepping off. `snapshot` captures the live FileState of a file the moment
  // it's frozen so stepping back to last (or exiting) can restore it; only the
  // active historical step's file is ever overridden at a time.
  const [replay, setReplay] = useState<{
    steps: ReplayStep[];
    index: number;
    snapshot: Record<string, FileState>;
  } | null>(null);

  // Fork-from-snapshot modal: surfaced when the user tries to edit while
  // replay-frozen on a historical step. `stepIndex` is the replay step they're
  // viewing — the fork seeds from that step's event id (spec §3.8: forked-from
  // pins the exact node-version). null = modal dismissed.
  const [forkPrompt, setForkPrompt] = useState<{ stepIndex: number } | null>(null);
  // The trace target the Attest modal is endorsing. Null when the modal is
  // closed. A file target may not have a node id yet: confirmation composes
  // the first Step and Send before it appends the Attestation.
  const [attestTarget, setAttestTarget] = useState<AttestTarget | null>(null);
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
    snapshot: Record<string, FileState>;
  } | null>(null);
  // Each path's genesis→head chain, captured in beginReplay so keystroke
  // playback can expand edits without refetching. Cleared
  // in endReplay. Kept in a ref (not state) — it's read imperatively by the
  // play builder and doesn't drive render.
  const replayChainsRef = useRef<Record<string, Event[]>>({});
  // Paths owned by the current kedit-playback mount. Replay panels themselves
  // carry `replayOwned`, so ownership survives live-panel closes and index shifts.
  // Null after playback teardown.
  const replayPlaybackPathsRef = useRef<Set<string> | null>(null);
  // True when the editor is showing a frozen (non-live) state: parked on a
  // historical Step, OR mid-keystroke-playback. Gates stepFile so a stray
  // Cmd+S can't step historical/partial content as a new node. On `last` with
  // play stopped the editor is live, so steps flow (the follow effect appends
  // them). The Sidebar's disabled state uses `replay !== null` directly.
  const replayActiveRef = useRef(false);
  // Per-keystroke playback has a separate cursor from the Step timeline. The
  // stepper/slider stay at save-point granularity while edit frames advance;
  // pausing snaps the step cursor to the current frame's enclosing step.
  const REPLAY_SPEEDS = [1, 2, 4, 8, 16] as const;
  const [playing, setPlaying] = useState(false);
  const [playSpeed, setPlaySpeed] = useState<number>(1);
  const [playTimeline, setPlayTimeline] = useState<PlayFrame[] | null>(null);
  const [playCursor, setPlayCursor] = useState(0);
  const playTimelineRef = useRef<PlayFrame[] | null>(null);
  const playCursorRef = useRef(0);
  useEffect(() => {
    playTimelineRef.current = playTimeline;
  }, [playTimeline]);
  useEffect(() => {
    playCursorRef.current = playCursor;
  }, [playCursor]);
  useEffect(() => {
    replayActiveRef.current =
      (replay !== null && replay.index < replay.steps.length - 1) || playing;
  }, [replay, playing]);
  // The play tick: one character per beat (60ms ÷ speed) via setTimeout. Each
  // tick advances the char cursor one frame and renders that frame's file. The
  // sentinel final frame restores the live document and stops playback.
  useEffect(() => {
    if (!playing) return;
    const tl = playTimelineRef.current;
    if (!tl) return;
    // Reached the end (sentinel/live frame already rendered): stop + teardown.
    if (playCursorRef.current >= tl.length - 1) {
      setPlaying(false);
      setPlayTimeline(null);
      playTimelineRef.current = null;
      // Snap the step cursor to the last real frame's step so the stepper/
      // slider rest at the final save point (one before live).
      const lastReal = tl[tl.length - 2];
      if (lastReal) replayStepTo(lastReal.stepIndex);
      // Remove only the ephemeral replay panels. Any live-layout changes made
      // during playback remain intact.
      teardownReplayPanels();
      return;
    }
    const id = setTimeout(() => {
      const next = playCursorRef.current + 1;
      const frame = tl[next];
      if (!frame) return;
      renderPlayFrame(frame, tl[playCursorRef.current] ?? null);
      playCursorRef.current = next;
      setPlayCursor(next);
      // One full edit per beat, scaled by the selected playback speed.
    }, 150 / playSpeed);
    return () => clearTimeout(id);
  }, [playing, playCursor, playSpeed, playTimeline]); // eslint-disable-line react-hooks/exhaustive-deps
  const {
    stepFile,
    ready,
    setFilesRef,
    pendingPaths,
    writeRef,
    suppressStep,
    seedSteppedRef,
    authorSignerRef,
    unsteppedPathSet,
    unsteppedEditCounts,
  } = useProvenance(folder, files, replayActiveRef, replay);
  const unsteppedPathSetRef = useRef(unsteppedPathSet);
  unsteppedPathSetRef.current = unsteppedPathSet;
  const snapshotCoordinatorRef = useRef(new SnapshotCoordinator());
  const preparedApprovalRef = useRef(new PreparedOperationApproval());
  // Drop the context-block delta-log memo whenever the attached folder changes
  // (attach, switch, detach) — memoized chains are keyed by folder id + path,
  // so a stale folder id's entries must not survive into the new one.
  useEffect(() => {
    clearChainMemo();
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
  // Auto-bootstrap the replay timeline once the folder finishes loading, so the
  // stepper isn't empty on page load — it lands on the very last save point
  // (beginReplay sets index: last, which is the live document, no freezing).
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
    const last = replay.steps.length - 1;
    if (replay.index !== last) return;
    const knownIds = new Set(replay.steps.map((s) => s.event.id));
    // Discover only heads inside the mounted effective scope. A background tab
    // can Step while replay is mounted elsewhere; that unrelated head must not
    // move this counter or slider.
    const fresh = freshMountedReplayHeads(
      files,
      knownIds,
      scopeRef.current,
      shieldedRef.current,
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
  }, [files, replay]); // eslint-disable-line react-hooks/exhaustive-deps
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
  writeRef.current = (path, content, tags, signer, runs, taggedTraces, kedits, localOnly, force) => {
    return backendRef.current.writeFile(path, content, tags, signer, runs, undefined, taggedTraces, kedits, localOnly, force);
  };
  const [activePanel, setActivePanel] = useState<number>(0);
  const activePanelRef = useRef(activePanel);
  activePanelRef.current = activePanel;
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
  // The unified "active trace" — the single thing the action palette operates
  // on. Sticky: it only moves when the user explicitly selects something else
  // (a file, a folder, a palette span, or an editor [[ span ]]); clicking empty
  // space never clears it, so "the last selected trace" is always available.
  const [selection, setSelection] = useState<SelectionRef | null>(null);
  const selectionRef = useRef<SelectionRef | null>(selection);
  selectionRef.current = selection;
  // This ordered set stores explicit tree mounts. Effective scope is derived
  // from their folder closures minus shielded boundaries. Mounts are independent
  // from panel/tab focus and change only through explicit mount gestures or
  // commands. Root is the default mount.
  const [scope, setScope] = useState<ScopeRef[]>(() =>
    folder ? [{ kind: "folder", path: ROOT }] : [],
  );
  // Imperative-handler mirror (same pattern as replayRef) so beginReplay and
  // op dispatchers can read the current mount roots without a stale closure.
  const scopeRef = useRef<readonly ScopeRef[]>(scope);
  scopeRef.current = scope;
  // Shielded paths are persistent traversal boundaries. A shielded folder protects
  // its subtree from a parent scope; an explicit mount at/inside it starts a
  // new inclusion root.
  const [shielded, setShielded] = useState<Set<string>>(() =>
    folder ? loadLocalShielded(folder.id) : new Set(),
  );
  const shieldedRef = useRef<Set<string>>(shielded);
  shieldedRef.current = shielded;
  // Reset mounts when the attached folder changes: paths pointing into the old
  // folder's subtree are meaningless in the new one. Mounting the new root
  // restores the pre-split "scope = whole folder" behavior.
  // The shielded set reloads from the new folder's own record.
  useEffect(() => {
    setScope(folder ? [{ kind: "folder", path: ROOT }] : []);
    setShielded(folder ? loadLocalShielded(folder.id) : new Set());
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
  // Re-bootstrap the timeline when scope/shielded membership changes so its
  // selected union is recomputed. Skip the initial mount (handled by the
  // auto-bootstrap above) and only fire when
  // a replay already exists or the folder is ready — otherwise the auto-
  // bootstrap covers it. endReplay first so live state is restored cleanly.
  const scopeBootRef = useRef(`${scopeKey(scope)}|${[...shielded].sort().join(",")}`);
  useEffect(() => {
    const nextKey = `${scopeKey(scope)}|${[...shielded].sort().join(",")}`;
    if (scopeBootRef.current === nextKey) return;
    scopeBootRef.current = nextKey;
    if (!folder || bootState !== "ready") return;
    if (replay) endReplay();
    void beginReplay().catch((e) => {
      console.warn("[replay] scope re-bootstrap failed:", e);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, shielded]);
  // The keychain. There is no separate "active key" — the two user-facing
  // roles are the **AUTHOR** key and the **MODEL** key, each chosen in the
  // ActionPalette (the AUTHOR-row key and the MODEL-row key). Both default to the
  // first keychain key when the user hasn't picked one, and persist per-browser
  // so a chosen AUTHOR/MODEL survives reload. The localStorage slot strings
  // keep their legacy pen/inject names (stable storage keys, not renamed).
  const [keys, setKeys] = useState<KeyEntry[]>(() => loadKeys());
  // The two voice roles: the **AUTHOR** key types new text and signs Save/
  // auto-save/send; the **MODEL** key runs the LLM ops (Extend/Settle/Stir/
  // Reply) and is the attribution for their streamed text. Each is an
  // independent key selection — they can overlap (same key for both) or
  // diverge. Both default to the first keychain key and persist per-browser.
  const [authorKeyId, setAuthorKeyId] = useState<string | null>(() => {
    const stored = localStorage.getItem("zine.roles.pen");
    return stored && loadKeys().some((k) => k.id === stored) ? stored : loadKeys()[0]?.id ?? null;
  });
  const [modelKeyId, setModelKeyId] = useState<string | null>(() => {
    const stored = localStorage.getItem("zine.roles.inject");
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
    getSubstrateVoice(substrate);
    setKeys(loadKeys());
  }, [substrate]);
  // The first keychain key's pubkey — the fallback both roles resolve to when
  // no AUTHOR/MODEL has been picked (or its key was deleted), then "author-1".
  const fallbackPubkey = keys[0]?.pubkey ?? "author-1";
  // Resolve each role's pubkey once per render. Falls back to the first
  // keychain key if the stored role id is gone (key deleted), then "author-1".
  const authorKey = keys.find((k) => k.id === authorKeyId) ?? null;
  const authorPubkey = authorKey?.pubkey ?? fallbackPubkey;
  const modelKey = keys.find((k) => k.id === modelKeyId) ?? null;
  const modelPubkey = modelKey?.pubkey ?? fallbackPubkey;
  const modelPubkeyRef = useRef(modelPubkey);
  modelPubkeyRef.current = modelPubkey;
  // Hand the debounced auto-save a resolver for the AUTHOR key's secret, so
  // the 1500ms debounce step signs as the AUTHOR key — not a hidden active key.
  // Read at fire time (see scheduleStep), so an AUTHOR switch mid-debounce wins.
  authorSignerRef.current = () => secretKeyForVoice(authorPubkey) ?? undefined;
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  // Width of the collection/palette sidebar, driven by the .sidebar-resizer
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
    // Replay columns are session-owned animation surfaces, not the user's
    // workspace. Project them out before saving while preserving any live tab
    // closes/resizes the user made alongside playback.
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
  const [socialQuery, setSocialQuery] = useState<SocialQuery>(() => loadSocialQuery());
  useEffect(() => {
    saveSocialQuery(socialQuery);
  }, [socialQuery]);
  const [theme, setTheme] = useState<Theme>(() => readTheme());
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
  // Per-panel operation contexts retain each target path and MODEL signer until
  // the ref-counted gate releases every concurrently streaming panel.
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

  // Follow-newest for FOLDER MEMBERSHIP events: the file-follow effect (above,
  // near the replay state) only sees file nodeIds. A folder's composition
  // history (add/remove/rename, kind 4292) advances on a separate chain with no
  // FileState.nodeId to watch, so without this a folder-scope mount parked on
  // `last` goes silent when a collaborator adds/removes a file — the broken
  // promise this closes. Piggybacks on `folderReplayRefreshKey` (bumped by the
  // effect above this block): when it bumps while parked on `last`, refetch the
  // folder nodes, walk the chain for structural deltas not already in the
  // timeline, and append them — same merge/sort/advance as the file follow.
  // Scope-filtered to match beginReplay, so a file/subfolder scope only appends
  // events touching its subtree.
  useEffect(() => {
    if (!replay || !folder) return;
    if (folderReplayRefreshKey === 0) return; // never bumped yet
    const last = replay.steps.length - 1;
    if (replay.index !== last) return;
    let cancelled = false;
    void (async () => {
      let nodes: Event[];
      try {
        nodes = await fetchFolderNodes(folder.id);
      } catch {
        return; // best-effort; the next refresh-key bump retries.
      }
      if (cancelled) return;
      const byId = new Map(nodes.map((e) => [e.id, e]));
      const citedAsPrev = new Set<string>();
      for (const e of nodes) {
        const pt = e.tags.find((t) => t[0] === "e" && t[3] === "prev");
        if (pt) citedAsPrev.add(pt[1]);
      }
      let cursor: string | undefined = nodes.find((e) => !citedAsPrev.has(e.id))?.id;
      const chain: Event[] = [];
      const guard = new Set<string>();
      while (cursor && !guard.has(cursor)) {
        guard.add(cursor);
        const ev = byId.get(cursor);
        if (!ev) break;
        chain.push(ev);
        cursor = ev.tags.find((t) => t[0] === "e" && t[3] === "prev")?.[1];
      }
      chain.reverse();
      const appended: ReplayStep[] = [];
      for (const event of chain) {
        const meta = eventMeta(event);
        let deltas: Array<{ type: string; relativePath?: string; fromPath?: string; toPath?: string }>;
        try {
          const parsed = JSON.parse(event.content) as { deltas?: typeof deltas };
          deltas = parsed.deltas ?? [];
        } catch {
          continue;
        }
        for (const d of deltas) {
          if (d.type !== "add" && d.type !== "remove" && d.type !== "rename") continue;
          const affected = d.type === "rename" ? d.toPath : d.relativePath;
          if (!affected) continue;
          const sc = scopeRef.current;
          if (!pathInEffectiveScopes(sc, shieldedRef.current, affected)) continue;
          appended.push({
            event,
            relativePath: affected,
            meta,
            contentUpToHere: "",
            runsUpToHere: [],
            changeRange: null,
            membership: { type: d.type, path: affected },
          });
        }
      }
      if (cancelled || appended.length === 0) return;
      setReplay((prev) => {
        if (!prev) return prev;
        const next = appendReplayStepsAtLiveEnd(
          prev,
          appended,
          (step) => step.membership
            ? `${step.event.id}:${step.membership.type}:${step.membership.path}`
            : step.event.id,
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folderReplayRefreshKey, replay, folder?.id]);

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
  async function flushEditorLocally(path: string, view: EditorView, signer?: Uint8Array): Promise<string> {
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
    const taggedTraces = file.taggedTraces ?? [];
    const steppedKedits = view.state.field(keditField, false) ?? file.kedits ?? EMPTY_KEDIT_LOG;
    const kedits = keditLogToArray(steppedKedits);
    const nodeId = await backendRef.current.writeFile(
      path,
      content,
      file.tags,
      signer,
      runs,
      undefined,
      taggedTraces.length > 0 ? taggedTraces : undefined,
      kedits.length > 0 ? kedits : undefined,
      true,
    );
    if (!nodeId) throw new Error(`The local source trace ${path} did not produce a node id.`);
    seedSteppedRef.current({
      [path]: { ...file, runs, nodeId },
    });
    if (isTauri() && folder) clearPadPath(folder.id, path);
    setFiles((prev) => {
      const current = prev[path];
      if (!current) return prev;
      // Copy/mint may wait on a relay while the author keeps typing. Advance
      // only the stepped nucleus and drain exactly the KEdit prefix captured
      // above; never overwrite newer runs with the source snapshot.
      const remaining = dropKEditLogPrefix(current.kedits ?? EMPTY_KEDIT_LOG, steppedKedits);
      const { kedits: _stepped, ...rest } = current;
      return {
        ...prev,
        [path]: {
          ...rest,
          nodeId,
          ...(remaining.length > 0 ? { kedits: remaining } : {}),
        },
      };
    });
    return nodeId;
  }

  /** Strike one immutable, single-Step coin without changing the source body.
   * The caller decides whether to resolve a bracket in the source (the Mint
   * gesture does; provenance-aware Copy deliberately does not). */
  async function mintCoinTrace(
    phrase: string,
    originNodeId: string,
    sourceContentHash: string,
    sourceRange: { start: number; end: number },
    signer?: Uint8Array,
  ): Promise<{ path: string; nodeId: string; runs: Run[] }> {
    if (!folder) throw new Error("Cannot mint a coin without an attached press.");
    const sourceFolderId = folder.id;
    const taken = new Set([
      ...Object.keys(filesRef.current),
      ...pendingPaths.current,
    ]);
    const newPath = mintedPath(phrase, new Date(), taken);
    pendingPaths.current.add(newPath);
    try {
      const mintFolderId = await getOrCreateMintFolder(sourceFolderId, signer);
      const mintMemberName = newPath.slice(`${MINT}/`.length);
      const coin = await publishHardenedSpan({
        folderId: mintFolderId,
        relativePath: mintMemberName,
        phrase,
        originNodeId,
        sourceContentHash,
        sourceRange,
        signer,
        localOnly: true,
      });
      const parsed = JSON.parse(coin.content) as { contentHash?: string };
      await upsertManifestEntry(
        mintFolderId,
        {
          kind: "file",
          relativePath: mintMemberName,
          latestNodeId: coin.id,
          contentHash: parsed.contentHash ?? "",
        },
        signer,
        { localOnly: true },
      );
      const coinVoice = signer ? getPublicKey(signer) : authorPubkey;
      const runs: Run[] = [{ voice: coinVoice, text: phrase }];
      saveLocalFile(sourceFolderId, newPath, {
        content: phrase,
        tags: [],
        nodeId: coin.id,
        runs,
        voicePubkey: coinVoice,
      });
      seedSteppedRef.current({
        [newPath]: { runs, nodeId: coin.id, tags: [] },
      });
      if (folderIdRef.current === sourceFolderId) {
        setFiles((prev) => ({
          ...prev,
          [newPath]: { runs, nodeId: coin.id, tags: [] },
        }));
      }
      return { path: newPath, nodeId: coin.id, runs };
    } finally {
      pendingPaths.current.delete(newPath);
    }
  }

  /** Mint a selection as a named, immutable trace in the dedicated Mint folder, then
   *  resolve the source bracket to cite it. Both source checkpoints and the
   *  new Mint member are stepped only to the home relay. Send remains a later,
   *  separate reachability gesture.
   *
   *  `from`/`to` are the current selection in `view`. If the selection is
   *  already inside a pending `[[ phrase ]]`, that phrase is used as-is;
   *  otherwise the selection is wrapped first and the just-wrapped phrase is
   *  used. The new coin opens in the adjacent panel (or the same one when only
   *  a single column is open). */
  async function zinePhrase(
    path: string,
    view: EditorView,
    from: number,
    to: number,
    stepSigner?: Uint8Array,
  ): Promise<boolean> {
    if (!folder || isMint(path) || isOblivion(path)) return false;
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
        originNodeId,
        sourceContentHash,
        { start: sourceBracket.phraseStart, end: sourceBracket.phraseEnd },
        signer,
      );

      // Resolve the bracket in the origin doc to cite the new file's node.
      // Dispatch only the changed id, so the bracket phrase and surrounding
      // model prose retain their existing voices.
      const afterWrite = view.state.doc.toString();
      // Bracket positions may have shifted if the user typed during the await;
      // re-find by phrase to be safe.
      const target = findPendingBrackets(afterWrite).find((b) => b.phrase === phrase);
      if (target) {
        const resolved = resolveBracket(afterWrite, target.matchStart, target.matchEnd, coin.nodeId);
        const change = minimalTextChange(afterWrite, resolved);
        if (change) view.dispatch({ changes: change });
      }
      // The source's next local checkpoint now carries the paired q edge.
      await flushEditorLocally(path, view, signer);
      // Open the new file in the panel immediately right of its origin if one
      // exists, else the origin panel itself. The reader sees the new trace
      // alongside its origin. (This reuses an existing neighbor — it does not
      // spawn a fresh column; only "Open to side" and tab edge-drop spawn.)
      const originPanel = panels.findIndex((p) => p.tabs.includes(path));
      const destPanel = originPanel === -1 ? activePanel : originPanel + 1;
      if (destPanel < panels.length) {
        openInPanel(coin.path, destPanel);
      } else {
        openInPanel(coin.path, Math.max(0, originPanel));
      }
      return true;
    } catch (e) {
      console.warn(`[mint] failed for phrase in ${path}:`, e);
      const originPanel = panels.findIndex((p) => p.tabs.includes(path));
      setOpStatus(originPanel === -1 ? activePanel : originPanel, "error", e instanceof Error ? e.message : String(e));
      // Leave the bracket pending — the user can retry.
      return false;
    }
  }

  /** Materialize a copied selection as a coin-backed citation. A clean source
   * reuses its current Step; a dirty source is locally stepped first. Copying
   * a whole existing coin reuses that coin instead of minting a duplicate. */
  async function prepareCopiedCoin(
    path: string,
    view: EditorView,
    from: number,
    to: number,
    phrase: string,
  ): Promise<CoinClipboardCitation> {
    const file = filesRef.current[path];
    if (!file) throw new Error(`Cannot copy from missing trace ${path}.`);
    const docText = view.state.doc.toString();

    // A phrase selected inside an existing resolved bracket already has the
    // strongest possible provenance. Reuse its coin rather than striking an
    // identical child coin.
    const existing = findResolvedBrackets(docText).find(
      (bracket) =>
        bracket.phrase === phrase &&
        bracket.matchStart <= from &&
        bracket.matchEnd >= to,
    );
    if (existing) return { phrase, nodeId: existing.nodeId };

    const signer = secretKeyForVoice(authorPubkey) ?? undefined;
    let originNodeId: string;
    if (isMint(path)) {
      if (!file.nodeId) throw new Error("The source coin has no stepped nucleus.");
      if (from === 0 && to === docText.length) {
        return { phrase, nodeId: file.nodeId };
      }
      originNodeId = file.nodeId;
    } else {
      originNodeId = await flushEditorLocally(path, view, signer);
    }

    const sourceContentHash = await sha256HexLocal(docText);
    const coin = await mintCoinTrace(
      phrase,
      originNodeId,
      sourceContentHash,
      { start: from, end: to },
      signer,
    );
    void appendToPalette({
      nodeId: coin.nodeId,
      text: phrase,
      originPath: path,
      mintedAt: Date.now(),
    }).catch((error) => console.warn("[coin-copy] palette append failed:", error));
    return { phrase, nodeId: coin.nodeId };
  }

  /** Upgrade a normal editor Copy into an intra-press coin transfer while
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
    if (!canCoinText(phrase) || !event.clipboardData) return false;

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

    const citation = prepareCopiedCoin(path, view, from, to, phrase);
    // Attach a rejection observer even if the user never pastes; paste itself
    // still receives the original promise and degrades to plain text on error.
    void citation.catch((error) => console.warn("[coin-copy] mint failed:", error));
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

  /** Resolve a clipboard ticket into `[[ phrase | coinId ]]`. Unknown tickets,
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

    void ticket.citation.then(
      (citation) => insert(resolvedBracketMarkup(citation.phrase, citation.nodeId)),
      (error) => {
        console.warn("[coin-paste] citation unavailable; pasted plain text:", error);
        insert(plainText);
      },
    );
    return true;
  }

  // Resolve the right-click surface from the event target and build a sensible
  // menu of standard ops. The tree (openContextMenu) and tab
  // (openTabContextMenu) handlers call stopPropagation, so this only reaches
  // the editor, modal text fields, read-only <pre>, and empty chrome. The
  // native menu is suppressed everywhere it catches; empty surfaces get no menu.
  // Clipboard uses document.execCommand for native fields (textarea/input) and
  // CM6's selection/replace APIs for the editor — the legacy execCommand path
  // still works inside CodeMirror's contentDOM.
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
  const [opLenses, setOpLenses] = useState(() => loadOpLensSelections());
  const providersRef = useRef(providers);
  providersRef.current = providers;
  const opLensesRef = useRef(opLenses);
  opLensesRef.current = opLenses;
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
      scopes: scopeRef.current.map((item) => ({ kind: item.kind, path: item.path })),
    });
    setAutomationRecipes(loadAutomationRecipes());
    return saved;
  }

  function deleteAgentRecipe(id: string) {
    setAutomationRecipes(removeAutomationRecipe(id));
  }

  function automationScopesAvailable(scopes: readonly AutomationScope[]): boolean {
    const current = filesRef.current;
    const paths = Object.keys(current);
    return scopes.length > 0 && scopes.every((item) => {
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
    localStorage.setItem("zine.roles.pen", id);
  }

  /** Set the MODEL (LLM ops) voice. Persisted per-browser. */
  function chooseModelKey(id: string) {
    setModelKeyId(id);
    localStorage.setItem("zine.roles.inject", id);
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

  /** Set the per-panel op status (shared by all four ops). The `op` kind is
   *  stashed when an op starts so the action button can re-render as the live
   *  stop control (click it again to abort); it's carried through to `done` so
   *  the status slot can show op-specific feedback ("stepped"/"sent"), then
   *  auto-clears to `idle` after a beat. Errors persist (no auto-reset) so the
   *  user sees what went wrong. */
  function setOpStatus(
    idx: number,
    state: SummonStatus["state"],
    msg?: string,
    op?: OpKind,
  ) {
    setSummonStatus((prev) => {
      const next = [...prev];
      // Carry the op kind through "running" and "done" (so the status slot can
      // render "stepped"/"sent"); drop it on idle/error.
      next[idx] = op && (state === "running" || state === "done") ? { state, msg, op } : { state, msg };
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
  function resolveOpProvider(idx: number, pubkey: string): ProviderConfig | null {
    const provider = resolveVoiceProvider(pubkey);
    if (!provider) {
      setOpStatus(idx, "error", "no provider — add one in Models");
      return null;
    }
    return provider;
  }

  /** Imperative counterpart of opTargetPanel for provider-time revalidation. */
  function liveOpTargetPanel(): number {
    const livePanels = panelsRef.current;
    const selectedPath = selectionRef.current?.path;
    if (selectedPath) {
      const activeHit = livePanels.findIndex((panel) => panel.active === selectedPath);
      if (activeHit !== -1) return activeHit;
      const tabHit = livePanels.findIndex((panel) => panel.tabs.includes(selectedPath));
      if (tabHit !== -1) return tabHit;
    }
    return Math.min(activePanelRef.current, livePanels.length - 1);
  }

  function liveTargetBody(idx: number, path: string, file: FileState): string {
    const view = panelViews.current[idx];
    return view && panelsRef.current[idx]?.active === path
      ? view.state.doc.toString()
      : flatten(file.runs);
  }

  function modelFocusIdentity(idx: number, path: string): string {
    return JSON.stringify({
      panelIndex: idx,
      activePanel: activePanelRef.current,
      path,
      selectionKind: selectionRef.current?.kind ?? null,
      selectionPath: selectionRef.current?.path ?? null,
    });
  }

  /** Gather and freeze the one request object shared by estimate, Inspector,
   * approval, and transport. The current multi-mount union remains the context
   * authority; panel/selection focus remains the write authority. */
  async function prepareModelOperation(
    idx: number,
    operation: PromptOpKind,
    operationInputs: OpInputs,
    provider: ProviderConfig,
    signal?: AbortSignal,
    lensId: OpLensId = opLenses[operation],
  ): Promise<PreparedOperation> {
    const liveFolder = folderRef.current;
    if (!liveFolder) throw new Error("Open a workspace before running a MODEL operation");
    const path = panelsRef.current[idx]?.active ?? "";
    if (
      !path ||
      isFolderTab(path) ||
      liveOpTargetPanel() !== idx ||
      replayActiveRef.current
    ) {
      throw new Error("Focus a live file before running a MODEL operation");
    }
    const file = filesRef.current[path];
    if (!file || file.kind === "folder") {
      throw new Error("The focused MODEL target is not an editable file");
    }
    const body = liveTargetBody(idx, path, file);
    const voicePrompt = getVoicePrompt(modelPubkey) ?? "";
    const mounts = scopeRef.current.map((scope) => `${scope.kind}:${scope.path}`).sort();
    const focusIdentity = modelFocusIdentity(idx, path);
    const dependencies: SnapshotDependencies = {
      focus: focusIdentity,
      targetRevision: JSON.stringify({
        folderId: liveFolder.id,
        path,
        traceId: file.traceId ?? null,
        headId: file.nodeId || null,
        contentHash: contentFingerprint(body),
      }),
      mounts,
      shields: [...shieldedRef.current].sort(),
      providerFingerprint: providerProfileFingerprint(provider),
      modelVoicePromptHash: contentFingerprint(voicePrompt),
      lensId,
      operation,
      operationInputsHash: contentFingerprint(JSON.stringify(operationInputs)),
      promptLayerVersions: [
        ...PROMPT_LAYER_VERSIONS,
        `prepared-operation:v${PREPARED_OPERATION_VERSION}`,
      ],
    };
    const snapshotFiles = filesRef.current;
    const snapshotScopes = scopeRef.current.map((scope) => ({ ...scope }));
    const snapshotShields = new Set(shieldedRef.current);
    const snapshot = await snapshotCoordinatorRef.current.request(
      dependencies,
      (gatherSignal) => gatherContextSnapshot(
        liveFolder,
        snapshotFiles,
        snapshotScopes,
        path,
        snapshotShields,
        { signal: gatherSignal },
      ),
      signal,
    );
    return prepareOperation({
      operation,
      operationInputs,
      contextSnapshot: snapshot,
      provider,
      modelVoicePubkey: modelPubkey,
      voicePrompt,
      lensId,
      focusFingerprint: contentFingerprint(focusIdentity),
      dirtyTarget: unsteppedPathSetRef.current.has(path),
    });
  }

  /** Re-prepare current dependencies only to locate the exact session object
   * approved in Inspector. Transport receives that object, never the freshly
   * rebuilt comparison object. */
  async function approvedModelOperation(
    idx: number,
    operation: PromptOpKind,
    operationInputs: OpInputs,
    provider: ProviderConfig,
    signal?: AbortSignal,
  ): Promise<PreparedOperation> {
    const current = await prepareModelOperation(idx, operation, operationInputs, provider, signal);
    const approved = preparedApprovalRef.current.get(
      current.provenance.dependencyFingerprint,
    );
    if (!approved || approved.operation !== operation) {
      throw new Error("Inspect and approve this MODEL request before running it");
    }
    return approved;
  }

  // Approximate prompt-size estimate for the token indicator beside the LLM
  // buttons. The number reflects the payload an op would send against the
  // op-target panel's active file. It uses the same prepared object path as
  // Inspector and transport, so fail-closed context or provenance state has no
  // misleading context-free estimate. Debounced so typing does not thrash the
  // async gather.
  const [tokenEstimate, setTokenEstimate] = useState<number | null>(null);
  useEffect(() => {
    if (!folder) {
      setTokenEstimate(null);
      return;
    }
    const panelIdx = opTargetPanel();
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
          if (!provider) throw new Error("No MODEL provider configured");
          const file = filesRef.current[path];
          if (!file || file.kind === "folder") throw new Error("No editable MODEL target");
          const view = panelViews.current[panelIdx];
          const doc = view?.state.doc.toString() ?? flatten(file.runs);
          const selection = view?.state.selection.main;
          const hasSelection = Boolean(selection && selection.from !== selection.to);
          const seed = hasSelection
            ? view!.state.sliceDoc(selection!.from, selection!.to)
            : doc.slice(-4000);
          const rangeFrom = hasSelection ? selection!.from : doc.length;
          const rangeTo = hasSelection ? selection!.to : doc.length;
          const prepared = await prepareModelOperation(
            panelIdx,
            "extend",
            { seed, hasSelection, rangeFrom, rangeTo },
            provider,
          );
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
  }, [folder, files, panels, activePanel, selection, modelPubkey, scope, shielded, providers, opLenses]);

  // ─── Prompt inspector ──────────────────────────────────────────────────────
  // Clicking the token-count indicator opens a modal showing exactly what a
  // single-shot op would send. `inspectOp` is null when closed; non-null is
  // the default op to show first (Extend). Each tab requests a frozen prepared
  // operation from the same path transport uses; the modal never rebuilds it.
  const [inspectOp, setInspectOp] = useState<PromptOpKind | null>(null);
  const [inspectContext, setInspectContext] = useState("");
  const [inspectInputs, setInspectInputs] = useState<Partial<Record<PromptOpKind, OpInputs>>>({});
  const [inspectNotes, setInspectNotes] = useState<Partial<Record<PromptOpKind, string>>>({});
  const [inspectPrepared, setInspectPrepared] = useState<
    Partial<Record<PromptOpKind, PreparedOperation>>
  >({});
  const [inspectPreparing, setInspectPreparing] = useState<PromptOpKind | null>(null);
  const [inspectPreparationError, setInspectPreparationError] = useState<string | null>(null);
  const [approvedRequestHash, setApprovedRequestHash] = useState<string | null>(null);
  const [staleModelResult, setStaleModelResult] = useState<RecoverableModelResult | null>(null);

  useEffect(() => {
    snapshotCoordinatorRef.current.invalidate();
    preparedApprovalRef.current.invalidate();
    setApprovedRequestHash(null);
    setInspectPrepared({});
  }, [folder?.id, files, panels, activePanel, selection, scope, shielded, providers, modelPubkey, opLenses]);

  function operationFocusMatches(prepared: PreparedOperation, idx: number): boolean {
    if (prepared.operation === "receive") return true;
    const file = filesRef.current[prepared.targetRevision.path];
    if (!file || file.kind === "folder") return false;
    const view = panelViews.current[idx];
    const body = liveTargetBody(idx, prepared.targetRevision.path, file);
    const selection = view?.state.selection.main;
    const hasSelection = Boolean(selection && selection.from !== selection.to);
    if (prepared.operation === "extend") {
      const from = hasSelection ? selection!.from : body.length;
      const to = hasSelection ? selection!.to : body.length;
      return prepared.operationInputs.hasSelection === hasSelection &&
        prepared.operationInputs.rangeFrom === from &&
        prepared.operationInputs.rangeTo === to;
    }
    const from = hasSelection ? selection!.from : 0;
    const to = hasSelection ? selection!.to : body.length;
    return prepared.operationInputs.rangeFrom === from &&
      prepared.operationInputs.rangeTo === to;
  }

  function preparedDependenciesStillCurrent(prepared: PreparedOperation, idx: number): boolean {
    if (
      contentFingerprint(modelFocusIdentity(idx, prepared.targetRevision.path)) !==
      prepared.provenance.focusFingerprint
    ) return false;
    if (modelPubkeyRef.current !== prepared.provenance.modelVoicePubkey) return false;
    if (opLensesRef.current[prepared.operation] !== prepared.provenance.lensId) return false;
    if (
      contentFingerprint(getVoicePrompt(modelPubkeyRef.current) ?? "") !==
      prepared.provenance.voicePromptHash
    ) return false;
    const pinnedProviderId = getVoiceProvider(modelPubkeyRef.current);
    const currentProvider = (
      pinnedProviderId
        ? providersRef.current.find((provider) => provider.id === pinnedProviderId)
        : undefined
    ) ?? providersRef.current[0];
    if (
      !currentProvider ||
      providerProfileFingerprint(currentProvider) !== prepared.providerFingerprint
    ) return false;

    const currentMounts = scopeRef.current
      .map((scope) => ({ ...scope }))
      .sort((left, right) => left.kind.localeCompare(right.kind) || left.path.localeCompare(right.path));
    if (JSON.stringify(currentMounts) !== JSON.stringify(prepared.contextSnapshot.mounts)) return false;

    const targetPath = prepared.targetRevision.path;
    const currentInputPaths = Object.keys(filesRef.current)
      .filter((path) => filesRef.current[path]?.kind !== "folder")
      .filter((path) =>
        path === targetPath ||
        pathInEffectiveScopes(scopeRef.current, shieldedRef.current, path))
      .sort();
    if (
      JSON.stringify(currentInputPaths) !==
      JSON.stringify(prepared.contextSnapshot.inputs.map((input) => input.path))
    ) return false;

    for (const input of prepared.contextSnapshot.inputs) {
      const state = filesRef.current[input.path];
      if (!state || state.kind === "folder" || unsteppedPathSetRef.current.has(input.path)) {
        return false;
      }
      const body = flatten(state.runs);
      const citations = [...new Set([
        ...(state.taggedTraces ?? []),
        ...findResolvedBrackets(body).map((citation) => citation.nodeId),
      ])].sort();
      if (
        (state.traceId ?? null) !== input.traceId ||
        (state.nodeId || null) !== input.headId ||
        contentFingerprint(body) !== input.contentHash ||
        JSON.stringify(citations) !== JSON.stringify(input.citations)
      ) return false;
    }
    return true;
  }

  function readCurrentModelTarget(
    prepared: PreparedOperation,
    idx: number,
  ): CurrentModelTarget | null {
    const liveFolder = folderRef.current;
    const liveFile = filesRef.current[prepared.targetRevision.path];
    if (!liveFolder || !liveFile || liveFile.kind === "folder") return null;
    return {
      folderId: liveFolder.id,
      path: prepared.targetRevision.path,
      traceId: liveFile.traceId ?? "",
      headId: liveFile.nodeId,
      contentHash: contentFingerprint(
        liveTargetBody(idx, prepared.targetRevision.path, liveFile),
      ),
      focused: Boolean(
        liveOpTargetPanel() === idx &&
        panelsRef.current[idx]?.active === prepared.targetRevision.path &&
        !panelsRef.current[idx]?.replayOwned &&
        !replayActiveRef.current &&
        operationFocusMatches(prepared, idx) &&
        preparedDependenciesStillCurrent(prepared, idx)
      ),
    };
  }

  /** Derive the per-op `OpInputs` from the op-target panel's live editor state,
   *  the same way the ops themselves do. Extend seeds from the selection or doc
   *  tail; Settle/Stir use partitionDoc + findCommands + iterBrackets. Reply's
   *  coins and Receive's limelight log are filled by openInspector's relay
   *  fetches so the captured preview matches a call made at the same moment. */
  function deriveInspectInputs(): Partial<Record<PromptOpKind, OpInputs>> {
    const idx = opTargetPanel();
    const path = panels[idx]?.active;
    const view = panelViews.current[idx];
    const state = path ? files[path] : null;
    if (!path || !state || state.kind === "folder") return {};
    const doc = view?.state.doc.toString() ?? flatten(state.runs);
    const sel = view?.state.selection.main;
    const hasSel = Boolean(sel && sel.from !== sel.to);
    // Extend: seed from selection, else doc tail (matches extendLLM).
    const seed = hasSel ? view!.state.sliceDoc(sel!.from, sel!.to) : doc.slice(-4000);
    // Stir: gather commands + loose prose + anchor count over the selection
    // (or whole doc), mirroring shakeLLM.
    const stirText = hasSel ? view!.state.sliceDoc(sel!.from, sel!.to) : doc;
    const cmds = findCommands(stirText);
    const stripped = stripRanges(stirText, cmds.map((c) => [c.matchStart, c.matchEnd] as [number, number]));
    const loose = partitionDoc(stripped).filter((p) => p.kind === "loose").map((p) => p.text).join("\n").trim();
    const anchorCount = [...iterBrackets(stirText)].length;
    const from = hasSel ? sel!.from : 0;
    const to = hasSel ? sel!.to : doc.length;
    const settlePrompt = encodeSettleAnchors(stirText).promptText;
    return {
      extend: { seed, hasSelection: hasSel, rangeFrom: hasSel ? from : doc.length, rangeTo: hasSel ? to : doc.length },
      settle: { loose: settlePrompt, rangeFrom: from, rangeTo: to },
      stir: { loose, anchorCount, commands: cmds.map((c) => c.command), rangeFrom: from, rangeTo: to },
      // Reply/Receive relay-backed bodies are filled by openInspector.
      reply: { source: stirText, rangeFrom: from, rangeTo: to },
      receive: {},
    };
  }

  async function prepareInspectorOperation(
    operation: PromptOpKind,
    inputs: Partial<Record<PromptOpKind, OpInputs>> = inspectInputs,
    lensId: OpLensId = opLenses[operation],
  ): Promise<void> {
    const idx = opTargetPanel();
    const provider = resolveVoiceProvider(modelPubkey);
    if (!provider) {
      setInspectPreparationError("No MODEL provider is configured.");
      return;
    }
    setInspectPreparing(operation);
    setInspectPreparationError(null);
    try {
      const prepared = await prepareModelOperation(
        idx,
        operation,
        inputs[operation] ?? {},
        provider,
        undefined,
        lensId,
      );
      setInspectPrepared((current) => ({ ...current, [operation]: prepared }));
      setInspectContext(prepared.contextSnapshot.renderedBlock);
    } catch (error) {
      setInspectPrepared((current) => {
        const next = { ...current };
        delete next[operation];
        return next;
      });
      setInspectPreparationError(error instanceof Error ? error.message : String(error));
    } finally {
      setInspectPreparing((current) => current === operation ? null : current);
    }
  }

  /** Open the inspector: gather the context block + derive inputs against the
   *  op-target panel, then show the modal. Async because the context block's
   *  directory-log fetch is async (memoized). */
  async function openInspector(defaultOperation: PromptOpKind = "extend") {
    const inputs = deriveInspectInputs();
    const notes: Partial<Record<PromptOpKind, string>> = {
      settle: "Bracket spans appear as protected anchor tokens in the request and are restored byte-for-byte after the complete response.",
    };
    const [paletteResult, focusResult] = await Promise.allSettled([
      fetchPalette(),
      folder ? focusTimeline(folder.id) : Promise.resolve([] as FocusEntry[]),
    ]);
    if (paletteResult.status === "fulfilled") {
      inputs.reply = {
        ...inputs.reply,
        traces: paletteResult.value
          .slice(0, 20)
          .map((item) => `- "${item.text}" (nodeId ${item.nodeId})`)
          .join("\n"),
      };
    } else {
      notes.reply = "The relay palette fetch failed; Reply would continue without citable traces.";
    }
    if (focusResult.status === "fulfilled" && folder) {
      inputs.receive = {
        limelightLog: renderLimelightLog(
          focusResult.value,
          folder.label ?? DEFAULT_ROOT_LABEL,
        ),
      };
    } else if (focusResult.status === "rejected") {
      notes.receive = "The limelight fetch failed; Receive would continue with the delta log and file contents only.";
    }
    setInspectInputs(inputs);
    setInspectContext("");
    setInspectNotes(notes);
    setInspectPrepared({});
    setInspectPreparationError(null);
    setInspectOp(defaultOperation);
    await prepareInspectorOperation(defaultOperation, inputs);
  }

  /** Begin an op: mark running and arm an AbortController. The op voice is
   *  NOT adopted on the editor facet here — each streamed change instead
   *  carries an `opVoiceEffect` with the exact voice (see voiceField), so
   *  attribution can't drift if the facet is reconfigured mid-stream (pen
   *  switch) or restored by a prior op. Returns the controller, or null if
   *  the editor isn't mounted.
   *
   *  `signer` is the voice the op's release step should be signed as — the
   *  MODEL key's secret for an LLM op, so the AI insert steps as that voice
   *  instead of the AUTHOR key the user is typing under. Stashed for
   *  endOp to pass through the gate's catch-up
   *  step. The op's pre-stream baseline step is signed by the AUTHOR key
   *  separately; this only governs the release step.
   *
   *  Also arms the step gate: while the op streams, the debounce step effect
   *  is suppressed (see useProvenance.suppressStep). Each streamed token's
   *  setFiles would otherwise re-arm the 1500ms step; a quiet gap mid-stream
   *  (model thinking, network hiccup) then fires an intermediate step,
   *  publishing a half-finished AI insert — and more tokens publish again,
   *  tripping the relay's per-connection rate-limit. The gate collapses the
   *  whole op to a single step, released in endOp. */
  function beginOp(
    idx: number,
    signer?: Uint8Array,
    op?: "extend" | "settle" | "stir",
  ): { controller: AbortController } | null {
    const view = panelViews.current[idx];
    if (!view) {
      // Without a mounted editor view there's nowhere to stream into — extend/
      // settle/stir all dispatch via view.dispatch. Surface this instead of
      // silently no-oping (the old `return null` left the button looking dead:
      // no "running", no "error", nothing). opTargetPanel normally steers ops
      // at a panel whose active tab is the file, but a stale layout, a folder
      // tab, or a not-yet-mounted editor (right after reload) can still miss.
      setOpStatus(idx, "error", "no editor mounted for this panel — click the file's tab first");
      return null;
    }
    const path = panels[idx]?.active ?? "";
    if (!path) {
      setOpStatus(idx, "error", "no file active in this panel");
      return null;
    }
    if (activeOpPathsRef.current.has(path)) {
      setOpStatus(idx, "error", "another model operation is already writing this file");
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

  /** End an op: clear the controller and release the step gate. The facet was
   *  never touched, so there's nothing to restore — terminal status is handled
   *  by the caller. Releasing the gate fires one catch-up step per path the
   *  suppressed window saw touched, signed with the voice beginOp armed, so
   *  the op's whole output steps as a single delta under the right voice.
   *
   *  Deferred one macrotask so React has committed the op's final setFiles
   *  before the catch-up step reads `files`. Without this, endOp's finally
   *  runs synchronously on await resume — the last token's state is still
   *  pending — so the catch-up step would publish partial content, then the
   *  debounce effect would re-step the remainder a beat later as the active
   *  key (scheduleStep always passes no signer). With the deferral the
   *  catch-up step sees complete content and the debounce dedups against it:
   *  one step, inject-signed, complete. */
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

  /** §3.7: prepare the LLM-call metadata (rule trace + scope citations + model
   *  config) for the op's path-keyed write-back Step. Called
   *  by every LLM op just before its provider call — the step happens after the
   *  model replies, but the scope is pinned to call time (what was in scope
   *  when the model was invoked), so gathering it here is correct. The scope is
   *  the folder's members' heads + the active file's head + the rule trace id. */
  async function prepareLlmMeta(
    idx: number,
    op: "extend" | "settle" | "stir" | "reply" | "receive",
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
          pathInEffectiveScopes(scopeRef.current, shieldedRef.current, member.relativePath),
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

  /** EXTEND — append an AI continuation. With a selection, seeds from the
   *  selected text and streams the continuation right after it; otherwise seeds
   *  from the end of the document and appends at doc.length. Each delta is
   *  attributed to `pubkey` via an op-voice effect carried on the change
   *  transaction (see voiceField) — not via the live editor facet, so the
   *  attribution can't drift if the AUTHOR key is switched mid-stream. */
  async function extendLLM(idx: number) {
    const pubkey = modelPubkey;
    const provider = resolveOpProvider(idx, pubkey);
    if (!provider) return;
    const started = beginOp(idx, secretKeyForVoice(pubkey) ?? undefined, "extend");
    if (!started) return;
    const { controller } = started;
    let llmMeta: LlmStepMeta | null = null;
    const view = panelViews.current[idx]!;
    try {
      const sel = view.state.selection.main;
      const hasSel = sel.from !== sel.to;
      const seed = hasSel
        ? view.state.sliceDoc(sel.from, sel.to)
        : view.state.doc.toString().slice(-4000);
      const anchor = hasSel ? sel.to : view.state.doc.length;
      const inputs: OpInputs = {
        seed,
        hasSelection: hasSel,
        rangeFrom: hasSel ? sel.from : anchor,
        rangeTo: anchor,
      };
      const prepared = await approvedModelOperation(
        idx,
        "extend",
        inputs,
        provider,
        controller.signal,
      );
      llmMeta = await prepareLlmMeta(idx, "extend", provider, seed, 4096);
      const result = await executePreparedOperation({
        prepared,
        provider,
        maxTokens: 4096,
        signal: controller.signal,
        readCurrentTarget: () => readCurrentModelTarget(prepared, idx),
        onStale: (recovery) => setStaleModelResult(recovery),
        apply: (response) => {
          const insertAt = prepared.operationInputs.rangeTo ?? anchor;
          const prefix = insertAt > 0 && view.state.doc.sliceString(insertAt - 1, insertAt) !== "\n"
            ? "\n"
            : "";
          view.dispatch({
            changes: { from: insertAt, insert: prefix + response },
            effects: opVoiceEffect.of(pubkey),
          });
        },
      });
      if (result.status === "cancelled") {
        setOpStatus(idx, "idle");
        return;
      }
      if (result.status === "stale") {
        setOpStatus(idx, "error", "MODEL response held because focus or the file changed");
        return;
      }
      setOpStatus(idx, "done", undefined, "extend");
    } catch (e) {
      if (controller.signal.aborted) {
        setOpStatus(idx, "idle");
        return;
      }
      setOpStatus(idx, "error", e instanceof Error ? e.message : String(e));
    } finally {
      endOp(idx, llmMeta);
    }
  }

  /** Folder Settle is withheld until one reviewed batch can capture every
   * provider call, keeper revision, and deletion before the first network hop. */
  function settleDeDupeLLM(idx: number) {
    setOpStatus(
      idx,
      "error",
      "Folder Settle needs a dedicated reviewed batch; focus one stepped file for now",
    );
  }

  /** SETTLE - condense the loose (non-bracketed) prose in place; preserve
   *  `[[ ]]` spans verbatim (never regenerate them). Repeated rounds drive the
   *  file toward only bracketed text. With a selection, condenses only the
   *  selected range (replacing it in place); otherwise the whole document.
   *  One CM6 transaction -> one undo restores. */
  async function settleLLM(idx: number) {
    const pubkey = modelPubkey;
    const provider = resolveOpProvider(idx, pubkey);
    if (!provider) return;
    const started = beginOp(idx, secretKeyForVoice(pubkey) ?? undefined, "settle");
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
      };
      const prepared = await approvedModelOperation(
        idx,
        "settle",
        inputs,
        provider,
        controller.signal,
      );
      const result = await executePreparedOperation({
        prepared,
        provider,
        maxTokens: 512,
        signal: controller.signal,
        readCurrentTarget: () => readCurrentModelTarget(prepared, idx),
        onStale: (recovery) => setStaleModelResult(recovery),
        apply: (response) => {
          const next = restoreSettleAnchors(response, encoded.anchors);
          if (next === text) return;
          view.dispatch({
            changes: {
              from: prepared.operationInputs.rangeFrom ?? from,
              to: prepared.operationInputs.rangeTo ?? to,
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
        setOpStatus(idx, "error", "MODEL response held because focus or the file changed");
        return;
      }
      setOpStatus(idx, "done", undefined, "settle");
    } catch (e) {
      if (controller.signal.aborted) {
        setOpStatus(idx, "idle");
        return;
      }
      setOpStatus(idx, "error", e instanceof Error ? e.message : String(e));
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
    const provider = resolveOpProvider(idx, pubkey);
    if (!provider) return;
    const started = beginOp(idx, secretKeyForVoice(pubkey) ?? undefined, "stir");
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
      const prepared = await approvedModelOperation(
        idx,
        "stir",
        inputs,
        provider,
        controller.signal,
      );
      const result = await executePreparedOperation({
        prepared,
        provider,
        maxTokens: 1024,
        signal: controller.signal,
        readCurrentTarget: () => readCurrentModelTarget(prepared, idx),
        onStale: (recovery) => setStaleModelResult(recovery),
        apply: (response) => {
          const next = reweaveAnchors(response, text);
          view.dispatch({
            changes: {
              from: prepared.operationInputs.rangeFrom ?? from,
              to: prepared.operationInputs.rangeTo ?? to,
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
        setOpStatus(idx, "error", "MODEL response held because focus or the file changed");
        return;
      }
      setOpStatus(idx, "done", undefined, "stir");
    } catch (e) {
      if (controller.signal.aborted) {
        setOpStatus(idx, "idle");
        return;
      }
      setOpStatus(idx, "error", e instanceof Error ? e.message : String(e));
    } finally {
      endOp(idx, llmMeta);
    }
  }

  /** RESPOND — buffer an AI response, then write it into a NEW sibling doc after
   * the approved source revision and focus are revalidated. It may cite existing
   *  coins via [[ phrase | nodeId ]], and citing the source itself
   *  via `replyingTo` (spec §reply-to delta type) so the reply chain
   *  stays legible from the trace alone. Placement: the sibling opens in a fresh
   *  column immediately to the right of the source panel (`idx`) — auto-spawning
   *  that column first so the reply always lands alongside its origin.
   *  The model names the file via a leading `TITLE:` line (see
   *  RESPOND_MESSAGES); the TITLE line is stripped from the stepped body. */
  async function replyLLM(idx: number) {
    if (!folder) return;
    // Reply writes into a new file (not the live editor) so there's no facet
    // to reconfigure — the MODEL voice's pubkey is baked into the run we write.
    const modelVoice = modelPubkey;
    const provider = resolveOpProvider(idx, modelVoice);
    if (!provider) return;
    setOpStatus(idx, "running", undefined, "reply");
    // The MODEL voice's secret — signs both the genesis writeFile below and
    // the release catch-up step, so the response lands on the relay as the
    // MODEL voice, not the keychain's active (AUTHOR) key.
    const signer = secretKeyForVoice(modelVoice) ?? undefined;
    const controller = new AbortController();
    summonAbort.current[idx] = controller;
    // Hoisted so the finally block can release the rescan-pending hold even
    // if we throw before assigning it. May be rebased mid-stream when the
    // model supplies a TITLE.
    let newPath = "";
    let llmMeta: LlmStepMeta | null = null;
    try {
      const view = panelViews.current[idx];
      const srcRel = panels[idx].active || "";
      // Reply to just the selected passage when there is one; otherwise the
      // whole document. The response always lands in a new sibling file.
      // Selection requires the live CM view; the whole-doc case reads from
      // `files` state so Reply still works when the view isn't mounted (the
      // model would otherwise see an empty source, then go fish in the context
      // block for something to answer).
      const sel = view?.state.selection.main;
      const hasSel = !!sel && sel.from !== sel.to;
      const sourceText = hasSel
        ? view!.state.sliceDoc(sel!.from, sel!.to)
        : (srcRel && files[srcRel] ? flatten(files[srcRel].runs) : "");
      // Pull the palette so the model can cite coins by nodeId.
      let palette: PaletteItem[] = [];
      try {
        palette = await fetchPalette();
      } catch {
        /* no palette is fine — the response just won't carry citations */
      }
      const traces = palette.slice(0, 20).map((p) => `- "${p.text}" (nodeId ${p.nodeId})`).join("\n");
      const inputs: OpInputs = {
        source: sourceText,
        traces,
        rangeFrom: hasSel ? sel!.from : 0,
        rangeTo: hasSel ? sel!.to : sourceText.length,
      };
      const prepared = await approvedModelOperation(
        idx,
        "reply",
        inputs,
        provider,
        controller.signal,
      );
      llmMeta = await prepareLlmMeta(idx, "reply", provider, sourceText, 1024);
      // Keep the source's directory so the response lands next to its origin
      // (e.g. notes/essay.md -> notes/<title>.md).
      const sourceName = srcRel || "doc.md";
      // The source's stepped head at the moment Reply runs — pinned into the
      // response's own genesis node via `replyingTo` below, so the citation
      // stays honest even if the source is edited further afterward.
      const sourceNodeId = prepared.targetRevision.headId || undefined;
      const slash = sourceName.lastIndexOf("/");
      const srcDir = slash >= 0 ? sourceName.slice(0, slash + 1) : "";
      const stem = sourceName.replace(/\.md$/, "").split("/").pop() || "doc";
      // Shared local second-precision prefix (YYYY-MM-DD_HHMMSS) so generated docs sort
      // chronologically and stay timestamped even after the LLM rewrites the
      // title below. Second precision (not minute) so two replies in the same
      // minute don't collide on the prefix. No colons to stay filesystem-safe.
      const datePrefix = formatLocalSecondStamp(new Date());

      const result = await executePreparedOperation({
        prepared,
        provider,
        maxTokens: 1024,
        signal: controller.signal,
        readCurrentTarget: () => readCurrentModelTarget(prepared, idx),
        onStale: (recovery) => setStaleModelResult(recovery),
        apply: async (response) => {
          const parsed = parseReplyOutput(response);
          const label = parsed.title
            ? slugifyFilename(parsed.title.replace(/\.md$/i, ""))
            : `${stem}-reply`;
          newPath = uniquePath(
            `${srcDir}${datePrefix}-${label}.md`,
            new Set(Object.keys(filesRef.current)),
          );
          const runs = [{ voice: modelVoice, text: parsed.body }];
          pendingPaths.current.add(newPath);
          editFile(newPath, runs);
          const destIdx = idx + 1;
          spawnPanel(destIdx);
          openInPanel(newPath, destIdx);
          try {
            if (llmMeta) setPendingLlmMeta(newPath, llmMeta);
            await backendRef.current.writeFile(
              newPath,
              parsed.body,
              [],
              signer,
              runs,
              sourceNodeId,
            );
          } catch (error) {
            console.warn(`[reply] writeFile failed for ${newPath}:`, error);
          } finally {
            clearPendingLlmMeta(newPath);
          }
        },
      });
      if (result.status === "cancelled") {
        setOpStatus(idx, "idle");
        return;
      }
      if (result.status === "stale") {
        setOpStatus(idx, "error", "MODEL response held because focus or the source changed");
        return;
      }
      setOpStatus(idx, "done", undefined, "reply");
    } catch (e) {
      if (controller.signal.aborted) {
        setOpStatus(idx, "idle");
        return;
      }
      setOpStatus(idx, "error", e instanceof Error ? e.message : String(e));
    } finally {
      summonAbort.current[idx] = null;
      // Release the rescan-pending hold once the stream + persist have
      // settled (success or abort/error). Subsequent rescans then reconcile
      // from disk normally.
      if (newPath) pendingPaths.current.delete(newPath);
    }
  }

  /** Receive: run the analyst persona over the folder's delta + limelight logs,
   *  buffer it, then create a sibling only after source revalidation. It is a
   *  trimmed Reply (no palette, no source citation, no `replyingTo`): the
   *  model reads the whole context block — delta log + file contents — plus a
   *  rendered limelight log (panel-occupancy history from focusTimeline, which
   *  lives on the folder's chain but is surfaced to a prompt nowhere else).
   *  Output is an audit doc the user can check, named via the model's `TITLE:`
   *  line, same convention as Reply. Stepped as the MODEL voice. */
  async function receiveLLM(idx: number) {
    if (!folder) return;
    const modelVoice = modelPubkey;
    const provider = resolveOpProvider(idx, modelVoice);
    if (!provider) return;
    setOpStatus(idx, "running", undefined, "receive");
    const signer = secretKeyForVoice(modelVoice) ?? undefined;
    const controller = new AbortController();
    summonAbort.current[idx] = controller;
    let newPath = "";
    let llmMeta: LlmStepMeta | null = null;
    try {
      const srcRel = panels[idx].active || "";
      // Pull the folder's focus chain (panel-occupancy history) and render it
      // as the limelight log. focusTimeline never throws; an empty chain (folder
      // predates focus deltas) yields "" and RECEIVE_MESSAGES tells the model
      // to analyze only what it has.
      let limelightLog = "";
      try {
        const focus: FocusEntry[] = await focusTimeline(folder.id);
        limelightLog = renderLimelightLog(focus, folder.label ?? DEFAULT_ROOT_LABEL);
      } catch {
        /* no focus chain is fine — the persona covers the missing-data case */
      }
      const inputs: OpInputs = { limelightLog };
      const prepared = await approvedModelOperation(
        idx,
        "receive",
        inputs,
        provider,
        controller.signal,
      );
      llmMeta = await prepareLlmMeta(idx, "receive", provider, limelightLog, 2048);
      const sourceName = srcRel || "doc.md";
      const slash = sourceName.lastIndexOf("/");
      const srcDir = slash >= 0 ? sourceName.slice(0, slash + 1) : "";
      const stem = sourceName.replace(/\.md$/, "").split("/").pop() || "doc";
      const datePrefix = formatLocalSecondStamp(new Date());

      const result = await executePreparedOperation({
        prepared,
        provider,
        maxTokens: 2048,
        signal: controller.signal,
        readCurrentTarget: () => readCurrentModelTarget(prepared, idx),
        onStale: (recovery) => setStaleModelResult(recovery),
        apply: async (response) => {
          const parsed = parseReplyOutput(response);
          const label = parsed.title
            ? slugifyFilename(parsed.title.replace(/\.md$/i, ""))
            : `${stem}-receive`;
          newPath = uniquePath(
            `${srcDir}${datePrefix}-${label}.md`,
            new Set(Object.keys(filesRef.current)),
          );
          const runs = [{ voice: modelVoice, text: parsed.body }];
          pendingPaths.current.add(newPath);
          editFile(newPath, runs);
          const destIdx = idx + 1;
          spawnPanel(destIdx);
          openInPanel(newPath, destIdx);
          try {
            if (llmMeta) setPendingLlmMeta(newPath, llmMeta);
            await backendRef.current.writeFile(
              newPath,
              parsed.body,
              [],
              signer,
              runs,
              undefined,
            );
          } catch (error) {
            console.warn(`[receive] writeFile failed for ${newPath}:`, error);
          } finally {
            clearPendingLlmMeta(newPath);
          }
        },
      });
      if (result.status === "cancelled") {
        setOpStatus(idx, "idle");
        return;
      }
      if (result.status === "stale") {
        setOpStatus(idx, "error", "MODEL response held because focus or the source changed");
        return;
      }
      setOpStatus(idx, "done", undefined, "receive");
    } catch (e) {
      if (controller.signal.aborted) {
        setOpStatus(idx, "idle");
        return;
      }
      setOpStatus(idx, "error", e instanceof Error ? e.message : String(e));
    } finally {
      summonAbort.current[idx] = null;
      if (newPath) pendingPaths.current.delete(newPath);
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

  /** Dispatch a top-bar action to the op-target panel. The LLM ops step their
   *  output as the MODEL voice; Save/zine step as the AUTHOR voice.
   *
   *  Extend/Settle/Stir apply into the target panel's mounted CodeMirror view,
   *  so they need that view live AND showing the selected
   *  file. opTargetPanel prefers a panel whose active tab is the file (view
   *  mounted there), but a file that's only a background tab — or a focused
   *  panel stuck on its empty/folder state — leaves no editor mounted, and
   *  beginOp would surface "no editor mounted for this panel — click the file's
   *  tab first". Instead of making the user click the tab, activate the file as
   *  the panel's active tab here and wait for FileEditor to mount / swap its doc
   *  before dispatching. Reply/Step/Send/Attest don't stream into the view
   *  (Reply writes a sibling file; the rest step), so they're left as-is. */
  async function runOp(idx: number, op: OpKind) {
    // Mint and Oblivion are read-only: no LLM/content op may write into either
    // system region. Send is allowed for an immutable Mint coin because it
    // changes reachability, not content; Attest is also non-mutating.
    if (op !== "attest") {
      const target = panels[idx]?.active;
      if (
        target &&
        !isFolderTab(target) &&
        (isOblivion(target) || (isMint(target) && op !== "send"))
      ) {
        setOpStatus(idx, "error", "Mint and Oblivion are read-only — fork or restore into Root first");
        return;
      }
    }
    if (op === "extend" || op === "settle" || op === "stir") {
      const path = selection?.path;
      if (path && !isFolderTab(path) && panels[idx]?.tabs.includes(path)) {
        const needSwap = panels[idx].active !== path;
        if (needSwap) {
          setPanels((prev) => mapPanel(prev, idx, (p) => ({ ...p, active: path })));
        }
        if (!panelViews.current[idx]) {
          // Empty/folder panel: no editor yet — wait for the mount.
          const v = await awaitViewMount(idx);
          if (!v) {
            setOpStatus(idx, "error", "no editor mounted for this panel — click the file's tab first");
            return;
          }
        } else if (needSwap) {
          // Editor mounted for a different tab: let the doc-swap effect commit
          // before the op reads view.state.
          await nextPaint();
        }
      }
    }
    if (op === "extend") void extendLLM(idx);
    // Settle has two modes. When the op-target panel focuses a FOLDER tab,
    // run de-dupe: collapse near-duplicate files in the scope subtree into one
    // voiced revision (the gesture that cleans up scan-introduced redundancy).
    // Otherwise the intra-file condenser (condense loose prose, keep brackets).
    else if (op === "settle") {
      const active = panels[idx]?.active;
      void (active && isFolderTab(active) ? settleDeDupeLLM(idx) : settleLLM(idx));
    }
    else if (op === "stir") void stirLLM(idx);
    else if (op === "reply") void replyLLM(idx);
    else if (op === "receive") void receiveLLM(idx);
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
      scopes?: readonly AutomationScope[];
    } = { trigger: "manual" },
  ) {
    const idx = opTargetPanel();
    const runWorkspaceId = launch.workspaceId ?? folderIdRef.current;
    if (!folder || !runWorkspaceId || folder.id !== runWorkspaceId) {
      setOpStatus(idx, "error", "open the recipe's bound workspace before running it", "run");
      return;
    }
    const runScopes: AutomationScope[] = (launch.scopes?.length
      ? launch.scopes
      : scopeRef.current
    ).map((item) => ({ kind: item.kind, path: item.path }));
    if (!automationScopesAvailable(runScopes)) {
      setOpStatus(idx, "error", "the recipe's bound scope no longer exists — update the recipe", "run");
      return;
    }
    const provider = providers.find((p) => p.id === providerId) ?? null;
    if (!provider) {
      setOpStatus(idx, "error", "no provider — add one in Models");
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
      setOpStatus(idx, "error", "unlock a MODEL signing key before running");
      return;
    }
    const modelVoice = ensureModelVoice(modelRootSecret, provider.modelId, provider.label);
    const runWorkspace = folder;
    const runShielded = new Set(shieldedRef.current);
    const isRunPath = (path: string) => path === runPath || path.startsWith(`${runPath}/`);
    const stillInWorkspace = () => folderIdRef.current === runWorkspaceId;
    const scopedRead = (path: string) =>
      isRunPath(path) || pathInEffectiveScopes(runScopes, runShielded, path);

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
      writeDraft: (path, runs) =>
        setFilesRef.current((prev) => {
          if (!stillInWorkspace() || !isRunPath(path)) {
            if (!stillInWorkspace()) controller.abort();
            return prev;
          }
          return {
            ...prev,
            [path]: { runs, nodeId: prev[path]?.nodeId ?? "", tags: prev[path]?.tags ?? [] },
          };
        }),
      appendDraft: (path, voice, text) =>
        setFilesRef.current((prev) => {
          if (!stillInWorkspace() || !isRunPath(path)) {
            if (!stillInWorkspace()) controller.abort();
            return prev;
          }
          const existing = prev[path];
          const runs = existing?.runs ?? [];
          return {
            ...prev,
            [path]: {
              runs: [...runs, { voice, text }],
              nodeId: existing?.nodeId ?? "",
              tags: existing?.tags ?? [],
            },
          };
        }),
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
      if (stillInWorkspace()) {
        ctx.writeDraft(path, runs);
      } else {
        // The old workspace is no longer in React state. Persist the terminal
        // manifest directly to its crash pad so reopening it shows "stopped"
        // instead of a stale forever-running record.
        mirrorPad(runWorkspaceId, path, {
          content: text,
          tags: [],
          nodeId: "",
          runs,
          voicePubkey: modelVoice.pubkey,
        });
      }
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
      pathInEffectiveScopes(runScopes, runShielded, panelPath)
      ? panelPath
      : Object.keys(filesRef.current).find((path) =>
        filesRef.current[path]?.kind !== "folder" &&
        pathInEffectiveScopes(runScopes, runShielded, path),
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

  /** Resolve which panel an op should target given the current selection.
   *  Prefer a panel where the selected file is the *active* tab — that's the
   *  panel whose CodeMirror view is actually mounted (FileEditor mounts only
   *  for a panel's active tab), so extend/settle/stir (which stream via
   *  view.dispatch) get a live editor. Only fall back to a panel that holds
   *  the file as a background tab, then to the focused panel. A folder/span
   *  selection has no file tab to match, so it goes straight to the focused
   *  panel. Clamped to a valid index. The action palette's ACTIONS row calls this to
   *  point ops at the selected trace. */
  function opTargetPanel(): number {
    const sp = selection?.path;
    if (sp) {
      // Active-tab match wins: the editor is mounted there.
      const activeHit = panels.findIndex((p) => p.active === sp);
      if (activeHit !== -1) return activeHit;
      // Otherwise any panel holding the file as a background tab. The view may
      // not be mounted here (the panel's active tab is something else), in
      // which case beginOp will surface a clear error rather than silently
      // no-oping — better than guessing wrong with no feedback.
      const tabHit = panels.findIndex((p) => p.tabs.includes(sp));
      if (tabHit !== -1) return tabHit;
    }
    return Math.min(activePanel, panels.length - 1);
  }

  /** Derive the AUTHOR primary slot from the focused editor selection. An
   *  opened Mint trace is always an immutable Coin; otherwise a live range
   *  wins over an older Coin focus. */
  function paletteSelectionForAuthor(): PaletteSelectionState {
    const targetPanel = opTargetPanel();
    const targetPath = panels[targetPanel]?.active;
    if (targetPath && isMint(targetPath)) return "coin";
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
    return selection?.kind === "coin" ? "coin" : "none";
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
    if (selection?.kind !== "coin" || !selection.nodeId) return null;
    return {
      nodeId: selection.nodeId,
      phrase: selection.phrase ?? "",
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
    if (selection?.kind === "folder") {
      const path = selection.path ?? ROOT;
      const nodeId = selection.nodeId ?? files[path]?.nodeId;
      return nodeId ? { path, kind: "folder", nodeId } : null;
    }
    const path = panels[opTargetPanel()]?.active;
    const file = path ? files[path] : undefined;
    if (!path || !file || file.kind === "folder") return null;
    if (isMint(path)) {
      return file.nodeId ? { path, kind: "coin", nodeId: file.nodeId } : null;
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
    if (!path || !file || file.kind === "folder" || isMint(path) || isOblivion(path)) {
      return false;
    }
    return planDelivery("send", unsteppedPathSet.has(path), file.nodeId) === "append-and-send";
  }

  /** A current trace has nothing for Step to record. A missing head remains
   *  Step-able because the gesture creates the trace's first node. */
  function paletteStepIsAvailable(): boolean {
    const path = panels[opTargetPanel()]?.active;
    const file = path ? files[path] : undefined;
    if (!path || !file || file.kind === "folder" || isMint(path) || isOblivion(path)) {
      return false;
    }
    return planDelivery("step", unsteppedPathSet.has(path), file.nodeId) !== "unavailable";
  }

  /** Queue the optional anteriority overlay for any newly-created Step. */
  function queueStepAnchor(steppedId: string, signer: Uint8Array): void {
    void import("./anchor.js")
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
    if (op === "send") setSendFailure(null);
    const signer = secretKeyForVoice(pubkey);
    if (!signer) {
      const error = new Error(`no key for voice ${pubkey.slice(0, 8)}…`);
      setOpStatus(idx, "error", error.message);
      if (op === "send") setSendFailure(describeSendFailure(error));
      return;
    }
    if (op === "step" && !isMint(path) && !isOblivion(path)) {
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
          setOpStatus(idx, "running", undefined, op);
          const minted = await zinePhrase(path, view, from, to, signer);
          if (minted) {
            setOpStatus(idx, "done", undefined, op);
            flashPanelFn(idx);
          }
          return;
        }
        if (paletteState === "coin") {
          setOpStatus(idx, "error", "This passage is already an immutable Coin");
          return;
        }
        if (paletteState === "invalid") {
          setOpStatus(idx, "error", "Select loose text or one pending [[ bracket ]] to Mint");
          return;
        }
      }
      if (selection?.kind === "coin") {
        setOpStatus(idx, "error", "This passage is already an immutable Coin");
        return;
      }
      if (planDelivery("step", unsteppedPathSet.has(path), files[path].nodeId) === "unavailable") {
        setOpStatus(idx, "error", "No updates since the last Step");
        return;
      }
    }
    setOpStatus(idx, "running", undefined, op);
    try {
      if (isMint(path) && op === "step") {
        throw new Error("Mint coins are immutable; Send the existing trace or fork it into Root");
      }
      const plan = isMint(path)
        ? "send-latest"
        : planDelivery(op, unsteppedPathSet.has(path), files[path].nodeId);
      if (plan === "unavailable") {
        throw new Error("No updates since the last Step");
      }
      const createsStep = plan !== "send-latest";
      let steppedId: string | undefined;
      if (plan === "append-local-step") {
        steppedId = await stepFile(path, signer, true, true);
      } else if (plan === "append-and-send") {
        // Pending state: append one Step and publish it to every write relay.
        steppedId = await stepFile(path, signer, false, false);
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
    } catch (e) {
      console.warn(`[deliver] step failed for ${path} as ${pubkey.slice(0, 8)}…:`, e);
      setOpStatus(idx, "error", e instanceof Error ? e.message : String(e));
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
      setOpStatus(statusIdx, "error", `no key for voice ${pubkey.slice(0, 8)}…`);
      return;
    }
    setOpStatus(statusIdx, "running", undefined, "attest");
    try {
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
          citedId = await stepFile(path, signer, false, false);
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
      setOpStatus(statusIdx, "done");
    } catch (e) {
      console.warn(`[attest] failed for ${path} as ${pubkey.slice(0, 8)}…:`, e);
      setOpStatus(statusIdx, "error", e instanceof Error ? e.message : String(e));
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
  function openScanned(scanned: Record<string, FileState>, folderId: string) {
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
      const merged = { ...scanned };
      for (const [path, lf] of Object.entries(pad)) {
        merged[path] = mergePadIntoFileState(scanned[path], lf);
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
   *  Desktop first purges the local sidecar's event store + old peer ACL; only
   *  after that succeeds do we clear the webview's entire localStorage and
   *  reload. Clearing `zine.root` makes boot mint a new root genesis, and its
   *  virtual oblivion region therefore starts empty too. Remote relay copies
   *  are outside this machine and cannot be recalled. */
  async function factoryReset() {
    if (resetBusy) return;
    setResetBusy(true);
    setResetError(null);
    try {
      if (isTauri()) {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("factory_reset");
      }
      localStorage.clear();
      window.location.reload();
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
      // Mint the fork: new file trace, genesis under our key, snapshot verbatim
      // from the historical node. forked-from = the step's event id.
      const event = await forkFileFromNode(step.event.id, folder.id, forkPath);
      // The forked node's contentHash is in its content JSON (same as the
      // source's — the snapshot is verbatim). Extract it for the manifest entry.
      const parsed = JSON.parse(event.content) as { contentHash?: string };
      const contentHash = parsed.contentHash ?? "";
      // Upsert the forked file into the folder manifest so it's discoverable
      // by the tree / listFiles on next scan.
      await upsertManifestEntry(folder.id, {
        kind: "file",
        relativePath: forkPath,
        latestNodeId: event.id,
        contentHash,
      });
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
    const taggedTraces = files[path]?.taggedTraces;
    const nextFile: FileState = {
      ...(files[path] ?? { tags: [], runs: [], nodeId: "" }),
      runs,
      nodeId: event.id,
      tags,
      taggedTraces,
    };
    setFiles((prev) => ({ ...prev, [path]: nextFile }));
    await backendRef.current.writeFile(path, snapshot, tags, undefined, runs, undefined, taggedTraces);
    const local = loadLocalFolder(folder!.id);
    const cur = local?.files[path];
    if (cur) {
      saveLocalFile(folder!.id, path, {
        content: snapshot,
        tags: cur.tags,
        nodeId: event.id,
        runs,
        voicePubkey: cur.voicePubkey,
        taggedTraces: cur.taggedTraces,
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
      const taggedTraces = files[staged.path]?.taggedTraces;
      const nextFile: FileState = {
        ...(files[staged.path] ?? { tags: [], runs: [], nodeId: "" }),
        runs,
        nodeId: event.id,
        tags,
        taggedTraces,
      };
      setFiles((prev) => ({ ...prev, [staged.path]: nextFile }));
      await backendRef.current.writeFile(staged.path, staged.merged, tags, undefined, runs, undefined, taggedTraces);
      const local = loadLocalFolder(folder.id);
      const cur = local?.files[staged.path];
      if (cur) {
        saveLocalFile(folder.id, staged.path, {
          content: staged.merged,
          tags: cur.tags,
          nodeId: event.id,
          runs,
          voicePubkey: cur.voicePubkey,
          taggedTraces: cur.taggedTraces,
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
      void mintRoot().then((id) => setFolder({ id }));
      return;
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
        const scanned = (await backendRef.current.attach(folder)).files;
        if (cancelled) return;
        setFiles(scanned);
        openScanned(scanned, folder.id);
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
      import("./anchor.js")
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


  /** Scan: acquire a foreign snapshot from a substrate. The user picks a file
   *  or folder (an external disk path); each scanned file lands as a NEW trace
   *  under the scope-folder. Always additive — scanning the same path twice
   *  yields two copies (counter-suffixed via uniquePath), never an overwrite.
   *  A held trace is never mutated by a scan; that's the whole point.
   *
   *  The picked snapshot is read OUTSIDE the attached root (scan_external does
   *  not confine to root — that's the substrate-acquisition contract). Each
   *  file is stepped to disk-under-root + the relay, attributed to the SUBSTRATE's
   *  own voice — the substrate is a peer with a keypair, so scanned content is
   *  signed by it, not the authoring key. Desktop-only. */
  async function onScan(kind: "file" | "folder") {
    if (!folder) return;
    const idx = opTargetPanel();
    const picked = kind === "file" ? await chooseFile() : await chooseFolder();
    if (!picked) return; // user cancelled
    let scanned: ScannedFile[];
    try {
      scanned = await scanExternal(picked);
    } catch (e) {
      setOpStatus(idx, "error", e instanceof Error ? e.message : String(e));
      return;
    }
    if (scanned.length === 0) return;
    // The substrate speaks with its own voice: content scanned in from it is
    // signed by its key, never the authoring key. Auto-provisions on first use.
    const substrateVoice = getSubstrateVoice(substrate);
    const voice = substrateVoice.publicKey;
    const signer = substrateVoice.secretKey;
    // Land under the primary scope item: inside a folder, beside a file, or at
    // ROOT when scope is empty. Multi-scope context remains a union, but Scan
    // needs one deterministic destination.
    const primaryScope = scopeRef.current[0];
    const destFolder =
      primaryScope?.kind === "folder"
        ? primaryScope.path
        : primaryScope?.kind === "file"
          ? parentPath(primaryScope.path)
          : ROOT;
    const taken = new Set(Object.keys(files));
    const created: { path: string; content: string }[] = [];
    for (const f of scanned) {
      // Clean the relative name so it satisfies the folder-name constraints
      // (folder segments must be valid nostr t-tags). Slugify each segment.
      const segs = f.relativePath.split("/").map((s) => slugifyFilename(s, s) || "file");
      const clean = segs.join("/");
      const candidate = destFolder === ROOT ? clean : `${destFolder}/${clean}`;
      const unique = uniquePath(candidate, taken);
      taken.add(unique);
      created.push({ path: unique, content: f.content });
    }
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
    // Step each: writes the file under the attached root (the import lands on
    // disk under root too, as a free reify-on-import) and steps the relay node,
    // signed by the substrate's key.
    try {
      for (const c of created) {
        await backendRef.current.writeFile(c.path, c.content, [], signer, [{ voice, text: c.content }]);
        pendingPaths.current.delete(c.path);
      }
      // Open the first imported file in the active panel.
      if (created.length > 0) openInActivePanel(created[0].path);
      setOpStatus(idx, "done", `${created.length} scanned`);
    } catch (e) {
      setOpStatus(idx, "error", e instanceof Error ? e.message : String(e));
    }
  }

  /** Reify: the emission instant — flush a trace out to a picked destination
   *  folder on disk. The inverse of scan. The trace's content (reconstructed
   *  from the in-memory runs the app holds) is written to the destination
   *  under its relative path. The app keeps its trace; reify serializes a copy
   *  out to a substrate. Desktop-only.
   *
   *  Every scoped file is emitted; scoped folders expand recursively; shielded
   *  descendants below each explicit scope root are omitted. */
  async function onReifyOp() {
    if (!folder) return;
    const idx = opTargetPanel();
    // Reify the exact effective-scope union. A sole folder keeps the prior
    // relative-to-folder output shape; mixed scopes keep workspace-relative
    // paths so distinct roots cannot collide.
    const scopes = scopeRef.current;
    const soleFolder = scopes.length === 1 && scopes[0].kind === "folder" ? scopes[0] : null;
    const prefix = soleFolder && soleFolder.path !== ROOT ? `${soleFolder.path}/` : "";
    const entries: { relativePath: string; content: string }[] = Object.entries(files)
      .filter(
        ([p, s]) =>
          s.kind !== "folder" &&
          pathInEffectiveScopes(scopes, shieldedRef.current, p),
      )
      .map(([p, s]) => ({
        relativePath: soleFolder && soleFolder.path !== ROOT ? p.slice(prefix.length) : p,
        content: flatten(s.runs),
      }));
    if (entries.length === 0) {
      setOpStatus(idx, "error", "Scope folder has no files to reify");
      return;
    }
    const dest = await chooseFolder();
    if (!dest) return; // user cancelled
    try {
      await reifyToDisk(dest, entries);
      setOpStatus(idx, "done", `${entries.length} reified`);
    } catch (e) {
      setOpStatus(idx, "error", e instanceof Error ? e.message : String(e));
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

  // The three "make this the active trace" entry points. Files additionally
  // open into the active panel so the editor can display them; folders and
  // coins just record the selection (folders are not editors; a coin
  // may belong to a file that is already open). The file's kind-4290 nodeId is
  // pulled from its FileState when present so ops can address the nucleus.
  function selectFile(path: string) {
    openInActivePanel(path);
    const nodeId = files[path]?.nodeId;
    setSelection({ kind: "file", path, nodeId });
  }
  /** Focus a file without moving scope, for non-tree navigation such as replay
   *  and citation links. The Sidebar owns tree scope gestures separately. */
  function focusFile(path: string) {
    openInActivePanel(path);
    setSelection({ kind: "file", path, nodeId: files[path]?.nodeId });
  }
  function selectFolder(path: string) {
    // Under nesting (spec §3.2), a folder-member FileState carries the
    // subfolder's genesis as nodeId. Carrying it on the selection lets ops
    // (Send, tag, cite) address a folder-member nucleus, symmetric with
    // selectFile. Legacy/synthesized folders have no nodeId — undefined is fine.
    const nodeId = files[path]?.nodeId;
    setSelection({ kind: "folder", path, nodeId });
  }
  function selectSpan(nodeId: string, phrase: string) {
    setSelection({ kind: "coin", nodeId, phrase });
  }
  /** Toggle a path's persistent shielded status. A folder excludes its subtree. */
  function toggleShielded(path: string) {
    if (!folder) return;
    setShielded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      saveLocalShielded(folder.id, next);
      return next;
    });
  }
  /** Curate a coin into the palette. Triggered by the copy button on
   *  a citation chip (Preview mode) — the chip still owns its own clipboard
   *  write (so copy stays a pasteable citation), and this is the "also save for
   *  reuse" side effect. `appendToPalette` is idempotent (deduped by nodeId), so
   *  re-copying an already-curated span is a no-op. Fire-and-forget; errors only
   *  log — the chip's own copy still succeeds either way. */
  function copySpan(nodeId: string, phrase: string, originPath: string) {
    appendToPalette({
      nodeId,
      text: phrase,
      originPath,
      mintedAt: Date.now(),
    }).catch((e) => console.warn("[zine] palette append failed:", e));
  }

  // Keep the selected *file* trace's nodeId fresh: a sampled file, for instance,
  // is selected before its FileState (and thus its kind-4290 nodeId) has loaded.
  // Once that state arrives, promote the selection so ops can address the
  // nucleus. Folder/span selections carry no path and are left untouched.
  useEffect(() => {
    if (selection?.kind !== "file" || !selection.path) return;
    const nodeId = files[selection.path]?.nodeId;
    if (nodeId && nodeId !== selection.nodeId) {
      setSelection({ ...selection, nodeId });
    }
  }, [selection, files]);

  // Mirror the focused panel's active tab into the trace selection so the
  // MODEL op buttons (Extend/Settle/Stir/Reply) follow what the user is
  // actually looking at. Selection is otherwise only set by explicit entry
  // points (sidebar, palette, tab click), so without this it desyncs from focus
  // — fresh boot left selection null (all ops disabled), and clicking into a
  // background panel left it pointing at a stale/folder trace. Scope remains
  // independently owned by the tree and is untouched by this effect.
  //
  // A span selection (from the palette) is preserved until the focused tab
  // actually changes — selecting a span does not move the focus, so it survives
  // here; the file/nodeId-freshness effect above keeps its host doc addressed.
  useEffect(() => {
    const tab = panels[activePanel]?.active;
    if (!tab) return;
    if (isFolderTab(tab)) {
      const folderPath = folderTabPath(tab);
      if (selection?.kind !== "folder" || selection.path !== folderPath) {
        setSelection({ kind: "folder", path: folderPath });
      }
    } else {
      const nodeId = files[tab]?.nodeId;
      if (
        selection?.kind !== "file" ||
        selection.path !== tab ||
        (nodeId && selection.nodeId !== nodeId)
      ) {
        setSelection({ kind: "file", path: tab, nodeId });
      }
    }
  }, [activePanel, panels, files]); // eslint-disable-line react-hooks/exhaustive-deps

  // Span focus remains a selection observation for replaying a reading session.
  // File/folder panel occupancy is
  // recorded by the transition effect below so switches and every close path
  // produce paired unmount/mount deltas exactly once.
  useEffect(() => {
    if (!selection || selection.kind !== "coin") return;
    const hostTab = panels[activePanel]?.active ?? "";
    const focusSel: FocusSelection = {
      // Legacy wire token retained for existing replay data; product language
      // and the live SelectionRef call this full trace a coin.
      kind: "span",
      nodeId: selection.nodeId ?? "",
      phrase: selection.phrase ?? "",
      originPath: isFolderTab(hostTab) ? "" : hostTab,
    };
    const focusPath = focusSel.originPath || null;
    const mounted = activeMounted(folder?.id ?? null, Object.keys(files));
    const owner = focusPath ? ownerFolderOf(focusPath, mounted) : folderIdRef.current;
    if (!owner) return;
    const key = JSON.stringify({ focusSel, panelIndex: activePanel });
    if (lastFocusKeyRef.current === key) return;
    lastFocusKeyRef.current = key;
    const handle = window.setTimeout(() => {
      const stillOwned = focusPath
        ? ownerFolderOf(focusPath, activeMounted(folder?.id ?? null, Object.keys(files))) === owner
        : folderIdRef.current === owner;
      if (!stillOwned) return;
      bufferFocus(owner, {
        type: "focus",
        op: "mount",
        selection: focusSel,
        panelIndex: activePanel,
        timestamp: Date.now(),
      });
    }, 1000);
    return () => window.clearTimeout(handle);
  }, [selection, activePanel, panels, files, folder]); // eslint-disable-line react-hooks/exhaustive-deps

  // Record the editor panels as folder-owned mount state. Comparing the whole
  // occupancy vector catches every way it can change—tab switch, individual or
  // bulk close, drag between panels, panel creation, and panel collapse—without
  // scattering provenance calls through UI handlers.
  useEffect(() => {
    const mounted = activeMounted(folder?.id ?? null, Object.keys(files));
    const next: (PanelOccupancy | null)[] = panels.map((panel) => {
      const tab = panel.active;
      if (!tab) return null;
      if (isFolderTab(tab)) {
        const path = folderTabPath(tab);
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
              runs: f.runs,
              taggedTraces: f.taggedTraces,
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
  // `taggedTraces` plus body brackets. Unlike `citationsByPath` (which reads the
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
          ...(file?.taggedTraces ?? []),
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
            ...(file?.taggedTraces ?? []),
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
          const snapshot = await findInboundSnapshot(folder!.id, path, file?.traceId);
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
                    (cached.sourceTraceId ?? cached.sourceEventId),
              );
              if (!localSource) continue;
              const [sourcePath, sourceFile] = localSource;
              const stillSupports =
                cached.kind === "fork" ||
                isOblivion(sourcePath) ||
                (sourceFile.taggedTraces ?? []).includes(cached.fromNodeId) ||
                findResolvedBrackets(flatten(sourceFile.runs ?? [])).some(
                  (bracket) => bracket.nodeId === cached.fromNodeId,
                );
              if (!stillSupports) continue;
              const key = `${cached.kind}:${cached.sourceTraceId ?? cached.sourceEventId}:${cached.fromNodeId}`;
              if (
                entries.some(
                  (entry) =>
                    `${entry.kind}:${entry.sourceTraceId ?? entry.sourceEventId}:${entry.fromNodeId}` ===
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
   *  A legacy nameless coin has no `file` path, so there's nothing
   *  to open as a document — the chip is display-only in that case. */
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
        // Fall through to exact-node/path compatibility below.
      }
    }
    const localPath = Object.entries(files).find(
      ([, file]) =>
        file.nodeId === nodeId ||
        (!!traceId && (file.traceId ?? file.nodeId) === traceId),
    )?.[0];
    if (localPath) {
      selectFile(localPath);
      return;
    }
    if (traceId) {
      try {
        const resolution = await resolveTraceChain(traceId);
        if (resolution.status === "resolved") {
          const head = resolution.chain[resolution.chain.length - 1];
          const currentPath = head ? eventMeta(head).relativePath : undefined;
          if (currentPath) {
            selectFile(currentPath);
            return;
          }
        }
      } catch {
        // Legacy exact-node fallback below.
      }
    }
    const event = await fetchEventById(nodeId);
    if (!event) return;
    const relativePath = eventMeta(event).relativePath;
    if (!relativePath) return;
    selectFile(relativePath);
  }

  // --- folder-wide delta replay (step-to-step) ---------------------------
  //
  // Mounts a single interleaved timeline across every file's steps and steps
  // the live editor through historical states. The timeline is "sticky at
  // last": the resting position (`index === last`) is the live, editable
  // document — new steps while on last append a step and the bar auto-advances
  // to the new last (the follow effect). Stepping back (`index < last`)
  // overrides that one step's file with its reconstructed content (the chain
  // replayed genesis→that node via reconstructUpTo) and freezes it: the user-
  // edit path is inert (the override is a setRunsEffect write `liftRuns`
  // exempts) and stepFile is gated on `replayActiveRef`, which is true only on a
  // historical step. At most one file is overridden at a time — the active
  // historical step's — so capture/restore is cheap and edits to other files
  // are never disturbed. `endReplay` restores the overridden path (if any).

  /** Begin replay for the attached folder. Fetches every FileTraceNode in the
   *  folder, groups by file, fetches each file's chain once, and precomputes
   *  each step's reconstructed content so stepping is O(1). Best-effort: a
   *  slow/unreachable relay yields an empty timeline rather than throwing —
   *  auto-bootstrap on folder load must never reject unhandled. */
  async function beginReplay() {
    if (!folder) return;
    let activity: Event[];
    try {
      activity = await fetchFolderActivity(folder.id);
    } catch (e) {
      console.warn("[replay] fetchFolderActivity failed:", e);
      return;
    }
    if (activity.length === 0) return;
    // Group events by relative path so each file's chain is fetched once.
    const byPath = new Map<string, Event[]>();
    for (const event of activity) {
      const path = eventMeta(event).relativePath;
      if (!path) continue;
      const list = byPath.get(path);
      if (list) list.push(event);
      else byPath.set(path, [event]);
    }
    // Narrow to the exact effective-scope union. Shielded descendants inherited
    // from a broader parent scope are absent unless explicitly scoped.
    const sc = scopeRef.current;
    for (const path of [...byPath.keys()]) {
      if (!pathInEffectiveScopes(sc, shieldedRef.current, path)) {
        byPath.delete(path);
      }
    }
    if (byPath.size === 0) return;
    // Per file: fetch the genesis→latest chain (authoritative order, never
    // created_at), then for each of that file's events find its index in the
    // chain and reconstruct content up to it. Retain each chain on a ref so
    // Keystroke playback can expand the recorded edits without refetching.
    const steps: ReplayStep[] = [];
    const chains: Record<string, Event[]> = {};
    for (const [relativePath, fileEvents] of byPath) {
      let chain: Event[];
      try {
        chain = await fetchChain(folder.id, relativePath);
      } catch (e) {
        console.warn(`[replay] fetchChain failed for ${relativePath}:`, e);
        continue;
      }
      if (chain.length === 0) continue;
      chains[relativePath] = chain;
      const indexById = new Map(chain.map((e, i) => [e.id, i]));
      for (const event of fileEvents) {
        const idx = indexById.get(event.id);
        if (idx === undefined) continue; // event not on the resolved head chain (forked/deleted)
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
    // Folder membership events (kind 4292): walk the folder's own chain and
    // emit one step per STRUCTURAL delta (add/remove/rename). Focus deltas are
    // observations, not membership, so they're skipped. A membership step has
    // no content/runs/changeRange — it's a labeled station ("added X") on the
    // same timeline, and scrubbing onto it doesn't freeze a file. This closes
    // the folder-scope promise: mounting a folder lets you step through its
    // composition history, not just its files' prose. Filtered to the scope
    // subtree so a file/subfolder scope only shows membership events touching
    // that subtree. (spec §3.3 — FolderDelta.)
    try {
      const folderNodes = await fetchFolderNodes(folder.id);
      const byId = new Map(folderNodes.map((e) => [e.id, e]));
      // Resolve the uncited head (the event nobody cites as `prev`) and walk
      // prev-pointers back, then reverse: genesis→head so deltas read in publish
      // order. This is the folder-chain counterpart to the file chain walk.
      const citedAsPrev = new Set<string>();
      for (const e of folderNodes) {
        const pt = e.tags.find((t) => t[0] === "e" && t[3] === "prev");
        if (pt) citedAsPrev.add(pt[1]);
      }
      let cursor: string | undefined = folderNodes.find((e) => !citedAsPrev.has(e.id))?.id;
      const chain: Event[] = [];
      const guard = new Set<string>();
      while (cursor && !guard.has(cursor)) {
        guard.add(cursor);
        const ev = byId.get(cursor);
        if (!ev) break;
        chain.push(ev);
        cursor = ev.tags.find((t) => t[0] === "e" && t[3] === "prev")?.[1];
      }
      chain.reverse();
      for (const event of chain) {
        const meta = eventMeta(event);
        let deltas: Array<{ type: string; relativePath?: string; fromPath?: string; toPath?: string }>;
        try {
          const parsed = JSON.parse(event.content) as { deltas?: typeof deltas };
          deltas = parsed.deltas ?? [];
        } catch {
          continue;
        }
        for (const d of deltas) {
          if (d.type !== "add" && d.type !== "remove" && d.type !== "rename") continue;
          // For rename, the affected path is toPath; for add/remove, relativePath.
          const affected = d.type === "rename" ? d.toPath : d.relativePath;
          if (!affected) continue;
          // Scope-union filter (mirror of the file byPath filter above).
          const sc = scopeRef.current;
          if (!pathInEffectiveScopes(sc, shieldedRef.current, affected)) continue;
          steps.push({
            event,
            relativePath: affected,
            meta,
            contentUpToHere: "",
            runsUpToHere: [],
            changeRange: null,
            membership: { type: d.type, path: affected },
          });
        }
      }
    } catch (e) {
      // Membership events are a nicety — a relay hiccup shouldn't block the
      // file-timeline build that already succeeded above.
      console.warn("[replay] fetchFolderNodes failed:", e);
    }
    if (steps.length === 0) return;
    // Step-time order, ascending. stable tie-break keeps same-ms steps in
    // their original activity order rather than shuffling them.
    steps.sort((a, b) => a.meta.steppedAtMs - b.meta.steppedAtMs);
    // `last` is sticky: the resting position is the most recent step, which is
    // the live editor (no override). Snapshot the live FileState of every path
    // so stepping back into history can capture/restore on demand — `last`
    // itself shows live content, and new steps while on last advance the bar to
    // the new last automatically (follow effect below).
    const snapshot: Record<string, FileState> = {};
    for (const path of byPath.keys()) {
      if (files[path]) snapshot[path] = files[path];
    }
    const last = steps.length - 1;
    setReplay({ steps, index: last, snapshot });
    // Land on `last` without overriding — show the live document. No file is
    // frozen at entry, so stepping stays enabled and edits flow normally.
    replayRef.current = { steps, index: last, snapshot };
    replayChainsRef.current = chains;
    setPlaying(false);
    setPlayTimeline(null);
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
  }

  /** Re-read the mounted timeline after a structural gesture becomes durable.
   *  Structural backends update paths optimistically, before their file/folder
   *  nodes exist on the relay, so the ordinary state signature can fire too
   *  early. The completion callback closes that race without disturbing a user
   *  who is deliberately parked on a historical step. */
  function refreshMountedReplay() {
    const current = replayRef.current;
    if (current && current.index !== current.steps.length - 1) return;
    void beginReplay().catch((error) => {
      console.warn("[replay] live structural refresh failed:", error);
    });
  }

  /** Advance/seek replay to step `n`. The step's file is shown when `n` points
   *  at a historical step: its reconstructed content overrides `file.runs`
   *  (frozen, read-only-ish — the sync effect writes it as a setRunsEffect run
   *  that `liftRuns` exempts, and `stepFile` is gated off while on a historical
   *  step). `n === last` shows the live document: no override, edits and steps
   *  flow, and the follow effect appends any new step as a step and re-points
   *  `last` at it.
   *
   *  Capture/restore is per-path and only ever touches the one file being left
   *  or entered: leaving a historical step restores its snapshot; entering a
   *  new historical file captures the live state into the snapshot first so a
   *  later return (to `last` or that step) restores it. Other files are never
   *  touched, so editing file B while stepping through historical-A is safe. */
  function replayStepTo(n: number) {
    const r = replayRef.current;
    if (!r) return;
    const last = r.steps.length - 1;
    const clamped = Math.max(0, Math.min(n, last));
    // Which file (if any) is currently frozen, and which will be after this
    // step. `last` is live → null. A historical FILE step → its file's path.
    // A historical MEMBERSHIP step → null too: there's no content to freeze,
    // so scrubbing onto one leaves the editor showing whatever it was showing
    // (scope stays sticky, focus stays put). This is the guard that makes a
    // membership step a labeled-only station, not a content-override target.
    const oldStep = r.index < last ? r.steps[r.index] : null;
    const newStep = clamped < last ? r.steps[clamped] : null;
    const oldOverridden = oldStep && !oldStep.membership ? oldStep.relativePath : null;
    const newOverridden = newStep && !newStep.membership ? newStep.relativePath : null;
    // Work on a snapshot copy so capture updates persist into replay state.
    const snapshot = { ...r.snapshot };
    setFiles((prev) => {
      const next = { ...prev };
      // Restore the file we're leaving, if it was frozen and we're not staying
      // on it. Its snapshot holds the live state captured before freezing.
      if (oldOverridden && oldOverridden !== newOverridden) {
        const snap = snapshot[oldOverridden];
        if (snap) next[oldOverridden] = snap;
      }
      // Capture the live state of the file we're about to freeze, unless it's
      // already frozen (historical→historical on the same file) — in that case
      // the snapshot is already correct and we must not overwrite it with the
      // frozen content currently in the editor.
      if (newOverridden && newOverridden !== oldOverridden) {
        const live = prev[newOverridden];
        if (live) snapshot[newOverridden] = live;
      }
      // Freeze the new historical step's file with its reconstructed content
      // and per-author runs. reconstructRunsUpTo prefers a node's `authors` map
      // (per-character attribution keyed by authors[].v) and only falls back to
      // per-node-signer attribution when a node carries no map or one that
      // fails the length-sum integrity check — so stepping colors text by who
      // actually authored each span when the chain records it. Foreign voices
      // receive their published identity or a stable per-pubkey fallback.
      // Any real edit after returning to `last` splices in the live voice.
      if (newOverridden) {
        const step = r.steps[clamped];
        const existing = next[newOverridden];
        if (step && existing) {
          next[newOverridden] = { ...existing, runs: step.runsUpToHere };
        }
      }
      return next;
    });
    // Switch the active panel to the step's file so the frozen content is the
    // thing the user sees (matches the old "land on this step" intent). On
    // `last`, prefer staying on whatever the user is viewing. A MEMBERSHIP step
    // never swaps tabs — it has no content to land on, so focus stays put and
    // the structural change is read from the stepper label instead.
    const step = r.steps[clamped];
    const activePath = panels[activePanel]?.active;
    if (clamped < last && step && !step.membership && activePath !== step.relativePath) {
      focusFile(step.relativePath);
    }
    setReplay((prev) => {
      if (!prev) return prev;
      const next = { ...prev, index: clamped, snapshot };
      replayRef.current = next;
      return next;
    });
  }

  /** Exit replay and restore the live `FileState` of the file currently frozen
   *  on a historical step (if any). On `last` there is nothing frozen — the
   *  editor already shows live content (possibly with unsaved edits) — so exit
   *  is a pure state teardown. Restoring only the overridden path means edits
   *  made to any other file while replay was open are preserved. */
  function endReplay() {
    const r = replayRef.current;
    if (r) {
      const last = r.steps.length - 1;
      // A membership step overrides nothing (no frozen file), so exit from one
      // restores nothing — same null as `last`.
      const step = r.index < last ? r.steps[r.index] : null;
      const overridden = step && !step.membership ? step.relativePath : null;
      const snap = overridden ? r.snapshot[overridden] : undefined;
      if (overridden && snap) {
        setFiles((prev) => ({ ...prev, [overridden]: snap }));
      }
    }
    replayRef.current = null;
    replayChainsRef.current = {};
    setReplay(null);
    setPlaying(false);
    setPlayTimeline(null);
    playTimelineRef.current = null;
    teardownReplayPanels();
  }

  /** Pre-mount involved files into replay-owned panels for kedit playback.
   *  Existing panels stay in place and usable. Up to REPLAY_PANEL_CAP animation
   *  columns are appended; extra paths share the last column as real tabs.
   *  Ownership lives on each panel instead of being inferred from its index, so
   *  manually closing live or replay tabs cannot corrupt the mapping. */
  function mountReplayPanels(tl: PlayFrame[]) {
    // Collect unique paths in first-appearance order.
    const pathsInOrder: string[] = [];
    const seen = new Set<string>();
    for (const f of tl) {
      if (f.path && !seen.has(f.path)) {
        seen.add(f.path);
        pathsInOrder.push(f.path);
      }
    }
    const REPLAY_PANEL_CAP = 3;
    replayPlaybackPathsRef.current = new Set(pathsInOrder);
    const available = Math.max(0, MAX_PANELS - panels.length);
    const mounted = createReplayPanels(
      pathsInOrder,
      Math.min(REPLAY_PANEL_CAP, available),
    ) as PanelState[];
    if (mounted.length === 0) return;

    const firstSpawnAt = panels.length;
    setPanels([...panels, ...mounted]);
    setSummonStatus([
      ...summonStatus,
      ...mounted.map(() => ({ state: "idle" as const })),
    ]);
    panelViews.current = [...panelViews.current, ...mounted.map(() => null)];
    summonAbort.current = [...summonAbort.current, ...mounted.map(() => null)];
    setPanelWeights([...panelWeights, ...mounted.map(() => 1)]);
    setActivePanel(firstSpawnAt);
  }

  /** Remove only replay-owned panels after playback. Live layout is read at
   *  teardown time, so manual tab closes and resizes made during replay persist. */
  function teardownReplayPanels() {
    replayPlaybackPathsRef.current = null;
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

  /** Build a per-keystroke play timeline: one frame per editor transaction, the
   *  document state after every discrete action (backspace, highlight-delete,
   *  type-over, undo, redo, IME commit) in the order the author made them.
   *  Multi-range transactions are grouped by `tx` and applied atomically because
   *  every member's from/to offsets address the same pre-transaction state.
   *
   *  The chains in `replayChainsRef` are already scope-filtered by `beginReplay`,
   *  so when scope is a single file this produces a single-path timeline (no
   *  multi-panel spawning needed); a folder scope interleaves every edited file.
   *  Legacy KEdits without `tx` replay as one-entry transactions. */
  function buildKeditTimeline(): PlayFrame[] | null {
    const r = replayRef.current;
    if (!r) return null;
    const chains = replayChainsRef.current;
    const stepIndexByEventId = new Map(r.steps.map((s, i) => [s.event.id, i]));
    const all: PlayFrame[] = [];
    for (const [path, chain] of Object.entries(chains)) {
      const frames: PlayFrame[] = [];
      // Running voiced state, carried across steps within this file (each
      // step's kedits build on the document state left by the prior step).
      let runs: Run[] = [];
      for (const event of chain) {
        const stepIndex = stepIndexByEventId.get(event.id);
        if (stepIndex === undefined) continue; // not a step (e.g. forked-off)
        const parsed = JSON.parse(event.content) as { snapshot?: string; kedits?: KEdit[] };
        const kedits = Array.isArray(parsed.kedits) ? parsed.kedits : [];
        if (kedits.length > 0) {
          // Replay each editor transaction. The helper clamps malformed offsets
          // and applies multi-range changes from high to low so their shared
          // pre-state coordinates remain valid.
          for (const transaction of groupKEditsByTransaction(kedits)) {
            runs = applyKEditTransaction(runs, transaction);
            frames.push({ path, stepIndex, runs });
          }
        } else if (typeof parsed.snapshot === "string") {
          // No kedits on this node (pre-kedits chain, forced no-op Step, or a
          // relay-pulled node with no buffer). Fall back to the snapshot as one
          // wholesale frame so older chains remain replayable.
          const snapText = parsed.snapshot;
          if (snapText !== flatten(runs)) {
            runs = snapText.length > 0 ? [{ voice: event.pubkey, text: snapText }] : [];
            frames.push({ path, stepIndex, runs });
          }
        }
      }
      if (frames.length > 0) all.push(...frames);
    }
    if (all.length === 0) return null;
    // Interleave every path's frames by enclosing-step timestamp; stable sort
    // preserves intra-step kedit order.
    all.sort((a, b) => {
      const ta = r.steps[a.stepIndex]?.meta.steppedAtMs ?? 0;
      const tb = r.steps[b.stepIndex]?.meta.steppedAtMs ?? 0;
      return ta - tb;
    });
    // Sentinel used by the playback tick as its stop signal.
    all.push({ path: "", stepIndex: r.steps.length, runs: [] });
    return all;
  }

  /** Render one play frame into the editor: override the frame's file runs,
   *  capturing live state first if that path isn't already frozen. If the frame
   *  is for a different path than the previous one, restore the previous path's
   *  live state so at most one file is frozen at a time. Sentinel frames (empty
   *  path) are a no-op render — the tick handles live restore on stop. */
  function renderPlayFrame(frame: PlayFrame, prev: PlayFrame | null) {
    const r = replayRef.current;
    if (!r) return;
    if (!frame.path) return; // sentinel — nothing to render
    const snapshot = { ...r.snapshot };
    // If switching files, restore the one we're leaving (if it was frozen).
    if (prev && prev.path && prev.path !== frame.path) {
      const snap = snapshot[prev.path];
      if (snap) {
        setFiles((p) => (p[prev.path] ? { ...p, [prev.path]: snap } : p));
      }
    }
    // Capture live state the first time we freeze this path.
    setFiles((prev) => {
      if (!prev[frame.path]) return prev;
      // Capture once: if the path isn't in the snapshot yet, it's still live.
      if (!snapshot[frame.path]) {
        snapshot[frame.path] = prev[frame.path];
      }
      return { ...prev, [frame.path]: { ...prev[frame.path], runs: frame.runs } };
    });
    // Focus the frame's file so the typed text is visible. Kedit mode resolves
    // the replay-owned panel from the CURRENT layout on every frame; closing a
    // panel therefore cannot leave a stale numeric index behind. If the user
    // closed that replay tab, respect the close and keep animating offscreen.
    if (replayPlaybackPathsRef.current) {
      const panelIdx = panels.findIndex(
        (panel) => panel.replayOwned && panel.tabs.includes(frame.path),
      );
      if (panelIdx >= 0) {
        if (panels[panelIdx].active !== frame.path) {
          setPanels((prev) =>
            mapPanel(prev, panelIdx, (panel) =>
              panel.tabs.includes(frame.path)
                ? { ...panel, active: frame.path }
                : panel,
            ),
          );
        }
        if (activePanel !== panelIdx) setActivePanel(panelIdx);
      }
    } else {
      // Character mode keeps its original tab-switch behavior.
      const activePath = panels[activePanel]?.active;
      if (activePath !== frame.path) focusFile(frame.path);
    }
    // Persist the refreshed snapshot so a later restore/endReplay can use it.
    replayRef.current = { ...r, snapshot };
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

  function editFile(path: string, runs: Run[], kedits?: KEditLog) {
    setFiles((prev) => ({
      ...prev,
      [path]: {
        // Preserve any existing nodeId/tags; for a brand-new path (e.g. the
        // reply flow's optimistic write) prev[path] is undefined, so spread
        // yields {} — fill the required FileState fields so consumers that
        // read file.tags / file.nodeId never see undefined.
        ...prev[path],
        runs,
        nodeId: prev[path]?.nodeId ?? "",
        tags: prev[path]?.tags ?? [],
        // Mirror the keystroke log into FileState so stepFile (in a different
        // scope with no editor view access) can drain it. Cleared after step.
        ...(kedits && kedits.length > 0 ? { kedits } : {}),
      },
    }));
  }

  // Explicit citation edits land in FileState.taggedTraces — the protocol's
  // compatibility name for a `q` edge with no body quote. A pure citation
  // change (content unchanged) still
  // steps because unsteppedPaths and each backend's no-op gate include the
  // citation set in their change check.
  // Each id is a sibling file's current head nodeId (resolved from `files`).
  function editCitations(path: string, ids: string[]) {
    setFiles((prev) =>
      prev[path]
        ? {
            ...prev,
            [path]: {
              ...prev[path],
              taggedTraces: ids.length > 0 ? ids : undefined,
            },
          }
        : prev,
    );
  }

  /** Open a tree item (file or folder) into a fresh column inserted
   *  immediately to the right of the active panel. This is the tree context
   *  menu's "Open to side": a folder is opened as a folder tab, a file as a
   *  normal editor tab. Always spawns a new column (up to the MAX_PANELS safety
   *  cap) so the user can open as many side-by-side panels as the row will fit;
   *  spawnPanel reconciles all parallel per-panel structures. */
  function openToSide(relPath: string) {
    const tab = folderPaths.has(relPath) ? folderTab(relPath) : relPath;
    const at = activePanel + 1;
    spawnPanel(at);
    openInPanel(tab, at);
    setActivePanel(at);
  }

  /** Open a folder as a folder tab in the *active* panel (the context menu's
   *  "Open"), not as a file tab. Mirrors selectFile for files: the folder://
   *  sentinel is added as a tab (or activated if already open) and becomes the
   *  active trace. Distinct from openToSide, which spawns a fresh column. */
  function openFolder(relPath: string) {
    openInActivePanel(folderTab(relPath));
    setSelection({ kind: "folder", path: relPath });
  }

  function createStart(kind: "file" | "folder", parent = "") {
    setCreateError(null);
    if (isMint(parent) || isOblivion(parent)) return;
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
    // Mint and Oblivion are system-managed. Mint receives only the mint
    // gesture; Oblivion receives only delete-moves and restores.
    if (isMint(parent) || isMint(fullName) || isOblivion(parent) || isOblivion(fullName)) {
      setCreateError("Mint and Oblivion are managed by their own gestures.");
      return;
    }

    setCreating(null);
    setCreateError(null);

    if (kind === "file") {
      const path = ensureMdExt(fullName);
      if (!files[path]) {
        // Optimistically add an empty file so the editor is immediately
        // usable; the disk write + import node happen via createFile below.
        setFiles((prev) => ({ ...prev, [path]: { runs: [], nodeId: "", tags: [] } }));
        void (async () => {
          try {
            const nodeId = await backendRef.current.createFile(path);
            setFiles((prev) =>
              prev[path] ? { ...prev, [path]: { ...prev[path], nodeId } } : prev,
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
      // Create the directory on disk too (no provenance node — folders are
      // implicit in file paths until they gain members).
      void backendRef.current.createFolder(fullName).catch((e) =>
        console.warn(`[workspace] createFolder failed for ${fullName}:`, e),
      );
    }
  }

  /** Dragging a Coin out of Mint is a copy-by-lineage operation, never a
   *  reparent. Each successful fork gets a fresh editable genesis in the
   *  destination, `forked-from` the immutable Mint node; the original remains
   *  in Mint and every existing citation keeps resolving to it. */
  async function forkMintedNodes(srcs: string[], destFolder: string) {
    if (!folder || isMint(destFolder) || isOblivion(destFolder)) return;
    const signer = secretKeyForVoice(authorPubkey) ?? undefined;
    const taken = new Set(Object.keys(files));
    let lastForkPath = "";
    try {
      for (const src of srcs) {
        const source = files[src];
        if (!source?.nodeId || !isMint(src) || src === MINT) continue;
        const forkPath = forkPathForMint(src, destFolder, taken);
        const content = flatten(source.runs);
        const event = await forkFileFromNode(source.nodeId, folder.id, forkPath, {
          signer,
          localOnly: true,
        });
        const parsed = JSON.parse(event.content) as { contentHash?: string };
        await upsertManifestEntry(
          folder.id,
          {
            kind: "file",
            relativePath: forkPath,
            latestNodeId: event.id,
            contentHash: parsed.contentHash ?? "",
          },
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
          ...prev,
          [forkPath]: { runs, nodeId: event.id, tags: [] },
        }));
        taken.add(forkPath);
        lastForkPath = forkPath;
      }
      if (lastForkPath) {
        openInActivePanel(lastForkPath);
        setOpStatus(activePanel, "done", "forked coin");
      }
    } catch (error) {
      console.warn("[mint] fork-on-drop failed:", error);
      setOpStatus(activePanel, "error", error instanceof Error ? error.message : String(error));
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
    if (isMint(destFolder)) return;
    const mintedSources = srcs.filter((src) => isMint(src) && src !== MINT);
    if (mintedSources.length > 0) void forkMintedNodes(mintedSources, destFolder);
    srcs = srcs.filter((src) => !isMint(src));
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

    // Mounts name tree coordinates, so they must follow the identities being
    // moved. Without this pass the files land in the destination but the gold
    // mounted rows disappear and scope keeps pointing at paths that no longer
    // exist. Descendant mounts under a moved folder follow that folder too.
    setScope((prev) => rebaseMountsAfterMove(prev, movable, destFolder));

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
    const inRoot = paths.filter((p) => !isMint(p) && !isOblivion(p) && p !== ROOT && p !== OBLIVION);
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
      fallback: { folderId: folder.id, relativePath: path },
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
    if (isMint(path) || isOblivion(path)) return "Mint and Oblivion are read-only.";
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
        void deliverAsVoice(activePanel, "step");
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

  // The focused panel's active tab mapped back to its directory-tree path. A
  // folder tab (`folder://<relpath>`) maps to the folder's relpath; null keeps
  // an empty panel from accidentally marking the synthetic root row.
  const activeTab = panels[activePanel]?.active ?? "";
  const focusedTabPath = activeTab
    ? (isFolderTab(activeTab) ? folderTabPath(activeTab) : activeTab)
    : null;

  // The root's display name — shown as the sidebar header and as the label of
  // the synthetic root node in the tree. The root is pathless, so the label is
  // the only name it has. It defaults to "root" and is user-renameable (the id
  // stays permanent; only this cosmetic label changes via setRootLabel).
  const rootLabel = useMemo(() => {
    if (!folder) return "Collection";
    return folder.label ?? DEFAULT_ROOT_LABEL;
  }, [folder]);

  const tree = useMemo(() => {
    // Under nesting (spec §3.2), a FileState with kind: "folder" is a real
    // folder-member (a subfolder trace), not a file. Split the entries so the
    // tree renders folder-members as folders and files as files. Legacy/flat
    // folders have no kind: "folder" entries, so this is byte-identical to the
    // old behavior for them.
    const fileEntries = Object.entries(files)
      .filter(([, f]) => f.kind !== "folder")
      .map(([p, f]) => ({
        path: p,
        type: "file" as const,
        ...(f.nodeId ? { attestations: attestationCounts[f.nodeId] ?? 0 } : {}),
      }));
    const folderMemberEntries = Object.entries(files)
      .filter(([, f]) => f.kind === "folder")
      .map(([p, f]) => ({
        path: p,
        type: "folder" as const,
        ...(f.nodeId ? { attestations: attestationCounts[f.nodeId] ?? 0 } : {}),
      }));
    const allEntries: TreeEntry[] = [
      ...fileEntries,
      ...folderMemberEntries,
      ...[...emptyFolders].map((p) => ({ path: p, type: "folder" as const })),
    ];
    return buildDirectoryTree(allEntries, rootLabel);
  }, [files, emptyFolders, rootLabel, attestationCounts]);

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
            <div className="press-content">
              <div className="press-top">
              <Sidebar
                tree={tree}
                collapsed={collapsed}
                onToggleFolder={toggleFolder}
                focusedTabPath={focusedTabPath}
                scopes={scope}
                onScopesChange={setScope}
                shielded={shielded}
                onToggleShielded={toggleShielded}
                onActivateFile={selectFile}
                onActivateFolder={selectFolder}
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
                onBeginReplay={() =>
                  void beginReplay().catch((e) => console.warn("[replay] begin failed:", e))
                }
                replayStep={replay ? replay.steps[replay.index] ?? null : null}
                replayIndex={
                  playing && playTimeline && playCursor < playTimeline.length
                    ? playTimeline[playCursor]?.stepIndex ?? replay?.index ?? 0
                    : replay?.index ?? 0
                }
                replayCount={replay?.steps.length ?? 0}
                stepTimes={
                  replay ? replay.steps.map((s) => s.meta.steppedAtMs) : undefined
                }
                playFraction={
                  playing && playTimeline ? stepPlayFraction(playTimeline, playCursor) : 0
                }
                playing={playing}
                playSpeed={playSpeed}
                replayActive={
                  (replay !== null && replay.index < replay.steps.length - 1) ||
                  playing
                }
                onStep={(n) => {
                  // Manual stepping pauses playback and tears down its
                  // timeline so the stepper lands on a clean step boundary.
                  setPlaying(false);
                  setPlayTimeline(null);
                  playTimelineRef.current = null;
                  teardownReplayPanels();
                  replayStepTo(n);
                }}
                onTogglePlay={() => {
                  if (!replay) return;
                  if (playing) {
                    // Pause: tear down the edit timeline and snap the step
                    // cursor to the last rendered frame's enclosing step, so
                    // the stepper/slider rest where playback stopped.
                    const tl = playTimelineRef.current;
                    const cur = playCursorRef.current;
                    const frame = tl?.[cur];
                    setPlaying(false);
                    setPlayTimeline(null);
                    playTimelineRef.current = null;
                    if (frame && frame.stepIndex < replay.steps.length) {
                      replayStepTo(frame.stepIndex);
                    }
                    // Remove only the ephemeral replay panels.
                    teardownReplayPanels();
                  } else {
                    // Build the keystroke timeline, render its first frame, and
                    // start the tick. Playback always
                    // animates the whole scope (genesis→live) — resuming mid-
                    // edit isn't supported.
                    const tl = buildKeditTimeline();
                    if (!tl || tl.length <= 1) return; // nothing to animate
                    // Pre-mount involved files into spawned panels so the tick
                    // can switch activePanel per-frame (one file per column)
                    // instead of cramming every file into one panel's tabs.
                    mountReplayPanels(tl);
                    const first = tl[0];
                    if (first) renderPlayFrame(first, null);
                    playTimelineRef.current = tl;
                    setPlayTimeline(tl);
                    playCursorRef.current = 0;
                    setPlayCursor(0);
                    setPlaying(true);
                  }
                }}
                onCycleSpeed={() =>
                  setPlaySpeed((s) => {
                    const i = REPLAY_SPEEDS.indexOf(s as (typeof REPLAY_SPEEDS)[number]);
                    return REPLAY_SPEEDS[(i + 1) % REPLAY_SPEEDS.length];
                  })
                }
                onOpenFolder={openFolder}
                onOpenSettings={() => {
                  setResetError(null);
                  setSettingsOpen(true);
                }}
              />
              {/* Horizontal resize handle for the press: drag to change the
                  collection/palette sidebar width; double-click resets. */}
              <div
                className="sidebar-resizer"
                role="separator"
                aria-orientation="vertical"
                aria-label="Resize collection sidebar"
                aria-valuenow={sidebarWidth}
                aria-valuemin={SIDEBAR_WIDTH_MIN}
                aria-valuemax={SIDEBAR_WIDTH_MAX}
                title="Drag to resize · double-click to reset"
                onPointerDown={onSidebarResizerPointerDown}
                onPointerMove={onSidebarResizerPointerMove}
                onPointerUp={onSidebarResizerPointerUp}
                onDoubleClick={onSidebarResizerDoubleClick}
              />
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
                    // Render-side mirror of replayActiveRef: true while replay
                    // is frozen on a historical step or mid-playback. Drives
                    // the per-panel read-only gate (the ⏭ button is the way out
                    // → seeking to `last` flips this false, lifting read-only).
                    const replayActive =
                      (replay !== null &&
                        replay.index < replay.steps.length - 1) ||
                      playing;
                    const citationReadOnly =
                      replayActive || isMint(path) || isOblivion(path);
                    // The single path whose content is currently overridden by
                    // the replay stepper (null on `last`, on membership steps,
                    // or when not replaying). The panel showing this path gets
                    // the provisional/read-only border; its tab gets a marker.
                    const replayFrozenPath =
                      replay !== null &&
                      replay.index < replay.steps.length - 1 &&
                      !replay.steps[replay.index]?.membership
                        ? (replay.steps[replay.index]?.relativePath ?? null)
                        : null;
                    // Replay-driven diff inputs, computed only when THIS panel's
                    // file is the one the stepper has frozen. replayStepText is
                    // the frozen step's snapshot; replayPrevText walks the timeline
                    // back to the previous content-step of the same file (skipping
                    // membership steps and other files) so "vs prev" shows what
                    // this step changed; replayLiveText is the live buffer parked
                    // in replay.snapshot (file.runs has been overwritten by the
                    // step snapshot, so flatten(file.runs) is NOT the live text).
                    // All three are null when not frozen on this path.
                    const replayFrozenHere = path === replayFrozenPath && replay !== null;
                    let replayStepText: string | null = null;
                    let replayPrevText: string | null = null;
                    let replayLiveText: string | null = null;
                    if (replayFrozenHere) {
                      const step = replay.steps[replay.index];
                      replayStepText = step?.contentUpToHere ?? null;
                      replayLiveText = replay.snapshot[path]
                        ? flatten(replay.snapshot[path].runs ?? [])
                        : flatten(files[path]?.runs ?? []);
                      for (let i = replay.index - 1; i >= 0; i--) {
                        const prev = replay.steps[i];
                        if (prev.membership) continue;
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
                            file={files[path]}
                            folderId={folder?.id ?? ""}
                            replayStepText={replayStepText}
                            replayPrevText={replayPrevText}
                            replayLiveText={replayLiveText}
                            active={activePanel === idx}
                            collapsed={collapsed}
                            onFocusPanel={() => setActivePanel(idx)}
                            onSelectTab={(p) => {
                              setPanels((prev) =>
                                mapPanel(prev, idx, (pp) => ({ ...pp, active: p })),
                              );
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
                              // A folder tab targets the folder (no nodeId —
                              // folders carry no provenance nucleus); a file tab
                              // targets the file as before.
                              if (isFolderTab(p)) {
                                setSelection({ kind: "folder", path: folderTabPath(p) });
                              } else {
                                setSelection({ kind: "file", path: p, nodeId: files[p]?.nodeId });
                              }
                            }}
                            onCloseTab={(p) => closeTab(idx, p)}
                            onContextMenuTab={(e, p) => openTabContextMenu(e, idx, p)}
                            onEdit={(runs, kedits) => editFile(path, runs, kedits)}
                            onRemoveCitation={(nodeId) => {
                              if (!path || citationReadOnly) return;
                              const cur = files[path]?.taggedTraces ?? [];
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
                            replayFrozen={!!replayFrozenPath && path === replayFrozenPath}
                            replayMounted={panel.replayOwned === true}
                            voice={authorPubkey}
                            // Folder tabs have no preview/markdown surface; pass
                            // "preview" (ignored by FolderView) and never persist a
                            // mode entry for a sentinel path.
                            mode={isFolderTab(path) ? "preview" : tabModes[path] ?? "preview"}
                            onSetMode={(m) => {
                              if (isFolderTab(path)) return;
                              setTabModes((prev) => ({ ...prev, [path]: m }));
                            }}
                            voiceAttribution={voiceAttribution}
                            selectedNodeId={
                              selection?.kind === "coin"
                                ? selection.nodeId ?? ""
                                : ""
                            }
                            // Folder replay drives a per-panel scroll: only the
                            // panel whose active file is the step's file gets a
                            // target, so a background panel isn't yanked around.
                            scrollTarget={
                              replay &&
                              !isFolderTab(path) &&
                              replay.steps[replay.index]?.relativePath === path
                                ? replay.steps[replay.index]?.changeRange ?? null
                                : null
                            }
                            onSelectSpan={(nodeId, phrase) => {
                              selectSpan(nodeId, phrase);
                            }}
                            onCopySpan={(nodeId, phrase) =>
                              copySpan(nodeId, phrase, path)
                            }
                            onCopySelection={(view, event) =>
                              copySelectionWithCoin(path, view, event)
                            }
                            onPasteSelection={(view, event) =>
                              pasteSelectionWithCoin(view, event)
                            }
                            onReplayEditAttempt={() => {
                              // Only surface the fork modal when actually frozen on
                              // a historical FILE step (not at `last`, where the
                              // editor is live; and not on a membership step, which
                              // freezes nothing — the editor is still live on
                              // whatever file was showing).
                              if (
                                replay &&
                                replay.index < replay.steps.length - 1 &&
                                !replay.steps[replay.index]?.membership
                              ) {
                                setForkPrompt({ stepIndex: replay.index });
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
                              const cur = files[path]?.taggedTraces ?? [];
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
                              const cur = files[path]?.taggedTraces ?? [];
                              if (cur.includes(src.nodeId)) return false; // already cited
                              return true;
                            }}
                            onAddCitationByPath={(srcPath) => {
                              if (!path || citationReadOnly) return;
                              const src = files[srcPath];
                              if (!src || src.kind === "folder" || !src.nodeId) return;
                              const cur = files[path]?.taggedTraces ?? [];
                              if (cur.includes(src.nodeId)) return; // dedupe
                              editCitations(path, [...cur, src.nodeId]);
                            }}
                            citationBodyDropMarkup={(srcPath) => {
                              if (!isMint(srcPath)) return null;
                              const src = files[srcPath];
                              if (!src || src.kind === "folder" || !src.nodeId) return null;
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
                              const tracePath = isFolderTab(tabPath)
                                ? folderTabPath(tabPath)
                                : tabPath;
                              return (
                                !isOblivion(tracePath) &&
                                pathInEffectiveScopes(scope, shielded, tracePath)
                              );
                            }}
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
              <ActionPalette
                keys={keys}
                authorKeyId={authorKeyId}
                modelKeyId={modelKeyId}
                onChooseAuthorKey={chooseAuthorKey}
                onChooseModelKey={chooseModelKey}
                providers={providers}
                resolvedModelProviderId={resolvedModelProviderId}
                onSelectProvider={selectVoiceProvider}
                selection={selection}
                runningOp={(() => {
                  const s = summonStatus[opTargetPanel()] ?? { state: "idle" };
                  return s.state === "running" ? (s.op ?? null) : null;
                })()}
                onOp={(op) => runOp(opTargetPanel(), op)}
                onStop={() => stopOp(opTargetPanel())}
                opStatus={summonStatus[opTargetPanel()] ?? { state: "idle" }}
                tokenEstimate={tokenEstimate}
                onInspect={() => void openInspector()}
                attestPlan={paletteAttestationPlan()}
                targetInScope={(() => {
                  const p = panels[opTargetPanel()]?.active;
                  return !!p && isInScope(scope, shielded, p);
                })()}
                authorSelectionState={paletteSelectionForAuthor()}
                sendAutoSteps={paletteSendAutoSteps()}
                stepAvailable={paletteStepIsAvailable()}
                onPreserve={preservePaletteSelection}
                onScopeToTarget={() => {
                  // Mount the focused file's parent folder; derived scope and
                  // stepper/context update from it automatically. A shielded file
                  // boundary remains shielded until the file itself is mounted.
                  const p = panels[opTargetPanel()]?.active;
                  if (!p) return;
                  const path = parentPath(p);
                  setScope([{ kind: "folder", path }]);
                  selectFolder(path);
                }}
                substrate={substrate}
                onChooseSubstrate={chooseSubstrate}
                substrateKeyId={substrateKeyId}
                onChooseSubstrateKey={chooseSubstrateKey}
                onScan={(kind) => void onScan(kind)}
                onReifyOp={() => void onReifyOp()}
                // The AUTHOR row's Fork action is live only when the op-target
                // panel is parked on a replay-frozen historical step — the one
                // way to turn a read-only historical view into an editable trace.
                replayFrozen={(() => {
                  const p = panels[opTargetPanel()]?.active;
                  return (
                    replay !== null &&
                    replay.index < replay.steps.length - 1 &&
                    !replay.steps[replay.index]?.membership &&
                    !!replay.steps[replay.index]?.relativePath &&
                    replay.steps[replay.index]!.relativePath === p
                  );
                })()}
                onForkReplay={() => replay && setForkPrompt({ stepIndex: replay.index })}
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
                    void attestAsVoice(t.path, geohash, message, {
                      kind: t.kind,
                      nodeId: t.nodeId,
                    });
                  }}
                />
              )}
              {runOpen && (
                <RunModal
                  providers={providers}
                  recipes={automationRecipes}
                  currentWorkspace={folder ? { id: folder.id, ...(folder.label ? { label: folder.label } : {}) } : null}
                  currentScopes={scope.map((item) => ({ kind: item.kind, path: item.path }))}
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
                    aria-label="Held MODEL response"
                    onClick={(event) => event.stopPropagation()}
                  >
                    <div className="run-head">
                      <h2 className="run-title">MODEL response held</h2>
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
                    <pre className="prompt-inspector-pre">
                      {staleModelResult.response || "(No response was sent because the target was already stale.)"}
                    </pre>
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
                    snapshotCoordinatorRef.current.invalidate();
                    preparedApprovalRef.current.invalidate();
                    setApprovedRequestHash(null);
                    setInspectPrepared({});
                    void prepareInspectorOperation(operation, inspectInputs, lensId);
                  }}
                  preparedOperations={inspectPrepared}
                  preparingOp={inspectPreparing}
                  preparationError={inspectPreparationError}
                  approvedRequestHash={approvedRequestHash}
                  onOperationChange={(operation) => {
                    setInspectOp(operation);
                    void prepareInspectorOperation(operation);
                  }}
                  onApprove={(prepared) => {
                    preparedApprovalRef.current.approve(prepared);
                    setApprovedRequestHash(prepared.preparedRequestHash);
                  }}
                  estimateTokens={estimateTokens}
                  onClose={() => setInspectOp(null)}
                />
              )}
            </div>
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
        ) : activeView === "keys" ? (
          <ViewErrorBoundary view="keys">
            <KeysView onKeysChange={setKeys} />
          </ViewErrorBoundary>
        ) : activeView === "models" ? (
          <ViewErrorBoundary view="models">
            <ModelsView onProvidersChange={setProviders} />
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
      {settingsOpen && (
        <div
          className="confirm-overlay"
          onClick={() => {
            if (!resetBusy) setSettingsOpen(false);
          }}
        >
          <div
            className="confirm-dialog settings-dialog"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="Settings"
          >
            <h2 className="settings-heading">Settings</h2>
            <section className="settings-section" aria-busy={resetBusy}>
              <h3 className="settings-section-heading">Factory reset</h3>
              <p className="settings-section-blurb">
                Erases all local app state, including the root binding, crash pads, keychain,
                relay config, voices, models, and layout. On desktop it also deletes every event
                from the local sidecar and resets peer access. The app reloads with a newly minted
                root and an empty oblivion. Events already sent to remote relays cannot be erased
                from those relays. There is no undo.
              </p>
              {resetError && <p className="create-error" role="alert">{resetError}</p>}
              <div className="confirm-actions">
                <button
                  type="button"
                  className="confirm-cancel"
                  disabled={resetBusy}
                  onClick={() => setSettingsOpen(false)}
                >
                  Close
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
            </section>
          </div>
        </div>
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

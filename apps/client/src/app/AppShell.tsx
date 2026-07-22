import { Component, Fragment, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, MutableRefObject, ReactNode } from "react";
import { createPortal } from "react-dom";
import { vaultStorage as localStorage } from "../storage/vault-storage.js";
import { Compartment, EditorState, EditorSelection, Facet, StateEffect, StateField, type Extension, type Range } from "@codemirror/state";
import { Decoration, EditorView, keymap, lineNumbers, ViewPlugin, WidgetType, type DecorationSet } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdownIndentExtensions } from "../editor/tab-indent.js";
import { RefCountedStepGate } from "../editor/ref-counted-step-gate.js";
import { fetchChain, flushRendezvousPublicationOutbox, eventMeta, setPendingLlmMeta, type TagCandidate, type EventMeta, type FocusSelection, type CitationChip, type MergeCandidate, type KEdit, type PublicationFence, type LlmStepMeta, resolveTraceIdentity, type TraceInbound } from "../provenance/provenance.js";
import { CoinView, DirectCoinComposerView, IncompleteMintView } from "../provenance/CoinModal.js";
import { type AutomationScopes } from "../ai/automation-store.js";
import { type UiFocus } from "../workspace/ui-focus.js";
import { activateTreeItem, type ActivatableTreeItem } from "../workspace/tree-routing.js";
import type { Event } from "nostr-tools";
import { diffLines } from "diff";
import { bracketExtensions, bracketVoiceResolverFacet, doubleBackspaceUnwrapCommand, findResolvedBrackets, focusedVoiceFacet, iterBrackets, modeCompartment, modeFacet, onSelectSpanFacet, selectedNodeIdFacet, wrapSelectionCommand, type Mode } from "../provenance/brackets.js";
import { markdownPreviewExtensions } from "../editor/markdown-preview.js";
import { palettePrimaryAction, paletteSecondaryActions, paletteStatusMessage, paletteStatusRow, type PaletteStatusRow, type PaletteSelectionState } from "../editor/palette.js";
import { bindOperator, type OperatorState } from "../networking/operator-store.js";
import { identityForPubkey, authorVoice, subscribeVoiceIdentities, voiceSpanStyle, type KeyEntry } from "../identity/keys-store.js";
import { VoiceLegend } from "../identity/VoiceLegend.js";
import { VoiceChip } from "../identity/VoiceChip.js";
import { PubkeyDisplay } from "../identity/PubkeyDisplay.js";
import { type WorkspaceLayout } from "../workspace/workspace-layout-store.js";
import { type ProviderConfig } from "../ai/models-store.js";
import { type DesktopOperationReviewActionV1, type DesktopOperationReviewItemV1 } from "../ai/desktop-operation-review.js";
import { applyEditorAuthorityChanges, classifyEditorTransaction, createEditorAuthorityState, resetEditorAuthorityState, type EditorAuthorityState } from "../editor/authoring-authority.js";
import { resolveAiPaletteRegistry, type AiPaletteActionId } from "../ai/palette-registry.js";
import { captureKEditTransaction } from "../provenance/kedit-capture.js";
import { captureStreamingScrollAnchor, restoreStreamingScrollTop } from "../editor/streaming-scroll.js";
import { type Run, type FileState, type SampleEventMeta, type AttachedFolder } from "../workspace/workspace.js";
import { clearPadPath, loadLocalFolder, mirrorPad } from "../workspace/local-store.js";
import { resolvePostWriteTraceId } from "../workspace/stepped-file-identity.js";
import { EMPTY_KEDIT_LOG, appendKEditLog, dropKEditLogPrefix, fileHasUnsteppedChanges, keditLogToArray, nextKEditTx, spliceRuns, type FileStepBaseline, type KEditLog, type Workspace } from "../workspace/workspace-core.js";
import { isTauri } from "../identity/identity.js";
import { applyScopeClick, contextMountState, pathInEffectiveScope, selectionForGroupAction, topLevelSelectedPaths, type ContextMounts, type ScopeRef, type TraceRef } from "../ai/scope-model.js";
import { type AttestationPlan } from "../provenance/step-policy.js";
import { type OccupancyEntry } from "../replay/panel-occupancy.js";
import { formatReplayDuration, replayTimeFraction, replayTransition, type ReplayTiming } from "../replay/replay-timing.js";
import { derivedFolderCheckpointDetails, folderReplayState, type PlayFrame, type ReplayFolderState } from "../replay/replay-timeline.js";
import { traceConformanceLabel, type TraceConformanceVerdict } from "../provenance/trace-conformance.js";
import { type OpKind as PromptOpKind } from "../ai/op-prompts.js";
import { ArrowUpDown, BarChart3, BookOpen, ChevronDown, ChevronRight, CircleHelp, CircleDollarSign, Code, Cpu, Download, Eye, FileInput, FileText, FileX, Folder, FolderInput, FolderOpen, FolderX, GitCompare, GitFork, Globe, KeyRound, Layers3, Leaf, Megaphone, Moon, PanelLeftClose, PanelLeftOpen, Plus, Quote, Radio, Radiation, ScanLine, Sun, Trash2, Vault, type LucideIcon } from "lucide-react";
import { MINT, SCAN, OBLIVION, isMintPath as isMint, isScanPath as isScan, isOblivionPath as isOblivion, isSystemRootPath, systemPathDisplayName } from "../workspace/generated-paths.js";
import { directoryContextMenuCapabilities } from "../workspace/directory-context-menu.js";
import { deleteOutcomeMessage } from "../workspace/delete-confirmation.js";
import { treeNodeDisplayName, type TreeNode } from "../workspace/tree-model.js";
import { DIRECTORY_SORT_OPTIONS, type DirectorySortOrder } from "../workspace/directory-sort.js";

/**
 * Stable press-shell components, editor extensions, and shared UI helpers.
 * The stateful workspace controller stays in App.tsx; keeping that orchestration
 * separate also keeps Babel from deoptimizing either compilation unit.
 */

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

interface ForegroundMintLease {
  sourceFolderId: string;
  generation: number;
  workspace: Workspace;
  controller: AbortController;
  fence: PublicationFence;
  release(): void;
}

/** Wake a failed Mint recovery either at its bounded backoff deadline or as
 * soon as the browser reports network recovery. Every listener belongs to the
 * captured vault/session signal and is removed before the next attempt. */
function waitForMintRecoveryRetry(
  delayMs: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      window.removeEventListener("online", onOnline);
      signal.removeEventListener("abort", onAbort);
      if (error !== undefined) reject(error);
      else resolve();
    };
    const onOnline = () => finish();
    const onAbort = () => finish(signal.reason);
    const timer = window.setTimeout(() => finish(), delayMs);
    window.addEventListener("online", onOnline, { once: true });
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
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
  /** Verified automatic ancestor roll-ups grouped under their source gesture. */
  derivedFolderCheckpoints?: ReplayStep[];
  /** Other mounted paths for the same signed immutable event. */
  occurrenceProjections?: ReplayStep[];
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
const REPLAY_LOAD_CONCURRENCY = 4;

function replayLoadFailure(
  code: string,
  message: string,
  nodeId?: string,
): TraceConformanceVerdict {
  return {
    status: "invalid",
    issues: [{ kind: "integrity", code, message, stepIndex: 0, ...(nodeId ? { nodeId } : {}) }],
    steps: [],
  };
}

function replayNodeContentHash(event: Event | null | undefined): string | null {
  if (!event) return null;
  try {
    const parsed = JSON.parse(event.content) as { contentHash?: unknown };
    return typeof parsed.contentHash === "string" ? parsed.contentHash : null;
  } catch {
    return null;
  }
}

async function mapReplayBounded<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from(
    { length: Math.min(Math.max(1, concurrency), items.length) },
    async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await worker(items[index]!);
      }
    },
  );
  await Promise.all(runners);
  return results;
}

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
  derivedCheckpoints,
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
  /** Verified signed automatic roll-ups grouped under the visible gesture. */
  derivedCheckpoints?: ReturnType<typeof derivedFolderCheckpointDetails>;
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
          <div
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
            {derivedCheckpoints && derivedCheckpoints.length > 0 ? (
              <details className="action-palette-replay-derived">
                <summary>{derivedCheckpoints.length} derived roll-up{derivedCheckpoints.length === 1 ? "" : "s"}</summary>
                <ul>
                  {derivedCheckpoints.map((checkpoint) => (
                    <li key={checkpoint.nodeId}>
                      <details>
                        <summary>{`${checkpoint.path || "Root"} · ${checkpoint.cause}`}</summary>
                        <div>Node <code>{checkpoint.nodeId}</code></div>
                        {checkpoint.operationId ? (
                          <div>Operation <code>{checkpoint.operationId}</code></div>
                        ) : null}
                        <div>Signer <code>{checkpoint.signerPubkey}</code></div>
                        <details>
                          <summary>Signed event</summary>
                          <pre>{checkpoint.signedEventJson}</pre>
                        </details>
                      </details>
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </div>
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
  notice,
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
  notice: string | null;
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
  if (items.length === 0 && !error && !notice && !hasPrevious && !hasMore) return null;
  return (
    <section className="desktop-extend-review" aria-label="Local AI draft review">
      {error && <p className="desktop-extend-review-error">{error}</p>}
      {notice && <p>{notice}</p>}
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
  /** Open the prompt inspector for a prepared MODEL operation. */
  onInspect,
  /** Switch the active view to Models. Fired when an AI op is clicked with no
   *  provider configured — the buttons stay clickable (not disabled) so the
   *  click is the trigger that routes the user to add a model. */
  onRouteToModels,
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
  /** Open the prompt inspector modal, optionally selecting an operation. */
  onInspect: (operation?: PromptOpKind) => void;
  /** Switch the active view to Models (no-provider click routing). */
  onRouteToModels: () => void;
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

  // --- "+" affordance (MODEL row) ---------------------------------------
  // Rightmost control of the LLM action row. The commands list is meant to be
  // extensible; this opens a stub dropdown (a greyed "Custom command…") until a
  // real add-command flow exists. Local state — no parent prop wiring needed.
  const [addCmdOpen, setAddCmdOpen] = useState(false);
  const addCmdRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!addCmdOpen) return;
    function onPointerDown(e: MouseEvent) {
      if (addCmdRef.current && !addCmdRef.current.contains(e.target as Node)) setAddCmdOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setAddCmdOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [addCmdOpen]);

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
          {AI_PALETTE_ROW.actions.map((action) => {
            const isRunning = runningOp === action.id;
            // extend/stir/settle write INTO the existing file, so they obey the
            // focus-∈-scope invariant (must not mutate content whose chain isn't
            // in context). analyze/reply/run create NEW docs/subfolders (analysis /
            // citing doc / agent run), so they're gated by kind only, not by scope.
            const createsDoc = action.id === "analyze" || action.id === "reply" || action.id === "run";
            const mutatesTarget = !createsDoc;
            const baseGate = action.id === "analyze" ? allowTextOps : mutatesTarget ? scopedText : scopedReply;
            // The op can actually run right now: not in flight, a provider is
            // configured, and the scope/kind gate is open.
            const canFire = !isRunning && !runningOp && hasProviders && baseGate;
            // No provider configured: the main button stays CLICKABLE (not
            // disabled) so the click routes the user to Models to add one.
            // Anything else blocking the op (scope/kind) needs editor action,
            // not a Models redirect, so those stay genuinely disabled.
            const missingProvider = !runningOp && !hasProviders && baseGate;
            const mainDisabled = !canFire && !missingProvider;
            // The chevron opens the Inspector focused on this op. It needs a
            // provider and a valid target to prepare a request against, so it
            // stays disabled when either is absent or any op is in flight.
            const isOperation = action.kind === "operation";
            const chevronDisabled = !!runningOp || !hasProviders || !baseGate;
            const main = (
              <button
                key={action.id}
                type="button"
                className={`action-palette-action ${action.className}${isRunning ? " running" : ""}${missingProvider ? " needs-model" : ""}`}
                disabled={mainDisabled}
                title={
                  isRunning
                    ? `${action.label} — running, click to stop`
                    : missingProvider
                      ? "No model configured — click to open Models"
                      : action.title
                }
                onClick={() => {
                  if (isRunning) {
                    onStop();
                  } else if (missingProvider) {
                    onRouteToModels();
                  } else {
                    onOp(action.id);
                  }
                }}
              >
                {action.label}
              </button>
            );
            return isOperation ? (
              <span key={action.id} className="action-palette-action-split">
                {main}
                <button
                  type="button"
                  className="action-palette-action-chevron"
                  aria-label={`Inspect the ${action.label} prompt`}
                  disabled={chevronDisabled}
                  title={
                    chevronDisabled
                      ? missingProvider
                        ? "Configure a model in Models to inspect a prompt"
                        : `${action.label} is running`
                      : "Inspect the exact prompt before running"
                  }
                  onClick={() => onInspect(action.id)}
                >
                  <ChevronDown size={12} strokeWidth={1.75} aria-hidden="true" />
                </button>
              </span>
            ) : (
              main
            );
          })}
          <div className="action-palette-add-wrap" ref={addCmdRef}>
            <button
              type="button"
              className="action-palette-action action-palette-add"
              onClick={() => setAddCmdOpen((v) => !v)}
              aria-label="Add an AI command"
              aria-haspopup="menu"
              aria-expanded={addCmdOpen}
              title="Add a command — the commands list is extensible"
            >
              <Plus size={14} strokeWidth={1.75} aria-hidden="true" />
            </button>
            {addCmdOpen && (
              <div className="action-palette-add-menu" role="menu">
                <button
                  type="button"
                  className="action-palette-add-item"
                  role="menuitem"
                  disabled
                  title="Custom commands are not configurable yet"
                >
                  <span className="action-palette-add-item-label">Custom command…</span>
                  <span className="action-palette-add-item-meta">soon</span>
                </button>
              </div>
            )}
          </div>
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
          The completed Coin is automatically indexed for content rendezvous; no later
          citation or Send is required. Mint does not publish the containing trace.
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

export {
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
};

export type {
  AttestTarget,
  CoinClipboardCitation,
  CoinClipboardTicket,
  Creating,
  DirectCoinDraft,
  ForegroundMintLease,
  HistoricalActionPhase,
  HistoricalActionStatus,
  InboundFreshness,
  MintConsentRequest,
  MintRecoveryNotice,
  PaletteStatusOp,
  PanelOccupancy,
  PanelState,
  ReplayStep,
  Substrate,
  SummonStatus,
  Theme,
  TraceCandidate,
  View,
};

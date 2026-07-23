import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { createPortal } from "react-dom";
import { vaultStorage as localStorage } from "../storage/vault-storage.js";
import { EditorView } from "@codemirror/view";
import { fetchChain, eventMeta, type TagCandidate, type FocusSelection, type CitationChip, type EditorTransaction, type MergeCandidate, type PublicationFence, type TraceInbound } from "../provenance/provenance.js";
import { CoinView, DirectCoinComposerView, IncompleteMintView } from "../provenance/CoinModal.js";
import { type AutomationScopes } from "../ai/automation-store.js";
import { type UiFocus } from "../workspace/ui-focus.js";
import type { Event } from "nostr-tools";
import { diffLines } from "diff";
import { findResolvedBrackets, iterBrackets, type Mode } from "../provenance/brackets.js";
import { palettePrimaryAction, paletteSecondaryActions, paletteStatusMessage, paletteStatusRow, type PaletteStatusRow, type PaletteSelectionState } from "../editor/palette.js";
import { bindOperator, type OperatorState } from "../networking/operator-store.js";
import { type KeyEntry } from "../identity/keys-store.js";
import { VoiceLegend } from "../identity/VoiceLegend.js";
import { VoiceChip } from "../identity/VoiceChip.js";
import { PubkeyDisplay } from "../identity/PubkeyDisplay.js";
import { type WorkspaceLayout } from "../workspace/workspace-layout-store.js";
import { type ProviderConfig } from "../ai/models-store.js";
import { type DesktopOperationReviewActionV1, type DesktopOperationReviewItemV1 } from "../ai/desktop-operation-review.js";
import { resolveAiPaletteRegistry, type AiPaletteActionId } from "../ai/palette-registry.js";
import { FileEditor as CurrentFileEditor } from "../editor/FileEditor.js";
import { type Run, type FileState, type SampleEventMeta } from "../workspace/workspace.js";
import { loadLocalFolder } from "../workspace/local-store.js";
import { type EditorTransactionLog, type Workspace } from "../workspace/workspace-core.js";
import { isTauri } from "../identity/identity.js";
import { pathInEffectiveScope, type ContextMounts, type TraceRef } from "../ai/scope-model.js";
import { type AttestationPlan } from "../provenance/step-policy.js";
import { type OccupancyEntry } from "../replay/panel-occupancy.js";
import { formatReplayDuration, replayTimeFraction, replayTransition, type ReplayTiming } from "../replay/replay-timing.js";
import { derivedFolderCheckpointDetails, folderReplayState, type PlayFrame, type ReplayStep as TimelineReplayStep } from "../replay/replay-timeline.js";
import { traceConformanceLabel, type TraceConformanceVerdict } from "../provenance/trace-conformance.js";
import { type OpKind as PromptOpKind } from "../ai/op-prompts.js";
import { ChevronDown, CircleDollarSign, Code, Eye, FileInput, FileText, FileX, Folder, FolderInput, FolderOpen, GitCompare, GitFork, Layers3, Plus, Quote, type LucideIcon } from "lucide-react";
import { MINT, SCAN, isMintPath as isMint, isScanPath as isScan, isOblivionPath as isOblivion, isSystemRootPath, systemPathDisplayName } from "../workspace/generated-paths.js";

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
  editorTransactions: EditorTransaction[];
  nextSequence: number;
}

interface MintConsentRequest {
  phrase: string;
  resolve: (confirmed: boolean) => void;
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
  editorTransactions: [],
  nextSequence: 0,
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

type ReplayStep = TimelineReplayStep;

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
// Step ticks, EditorTransaction playback, thumb, activity bubbles, and idle bands all use
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

/** Position real Step ticks on the same playback-time axis as EditorTransaction playback. */
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
  /** Shared EditorTransaction/checkpoint axis with accelerated idle gaps compressed. */
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
                <FolderOpen
                  size={12}
                  className="tab-status action-palette-replay-target-icon"
                  aria-hidden="true"
                />
              ) : (
                <FileText
                  size={12}
                  className="tab-status action-palette-replay-target-icon"
                  aria-hidden="true"
                />
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
  onEdit: (runs: Run[], editorTransactions: EditorTransactionLog) => void;
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
  /** True for panels spawned by transaction playback. Drives a soft accent border. */
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
          <CurrentFileEditor
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
  OperatorSetupModal,
  Panel,
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
  TagBrowserPanel,
  VOICE_ATTRIBUTION_KEY,
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
  mapPanel,
  mapReplayBounded,
  nextActive,
  parentPath,
  parseReplyOutput,
  partitionDoc,
  pruneTabModes,
  readSidebarWidth,
  readVoiceAttribution,
  rebaseFolderTab,
  rebasePath,
  reconcileLayout,
  removeAt,
  replayActionLabel,
  replayLoadFailure,
  replayNodeContentHash,
  replayStepIndexForPath,
  reweaveAnchors,
  spliceAt,
  stepDescription,
  stripRanges,
  waitForMintRecoveryRetry,
  withPersistedFolderStates,
};

export type {
  AttestTarget,
  CoinClipboardCitation,
  CoinClipboardTicket,
  DirectCoinDraft,
  ForegroundMintLease,
  HistoricalActionPhase,
  HistoricalActionStatus,
  InboundFreshness,
  MintConsentRequest,
  PaletteStatusOp,
  PanelOccupancy,
  PanelState,
  ReplayStep,
  Substrate,
  SummonStatus,
  TraceCandidate,
};

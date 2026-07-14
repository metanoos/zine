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
  type DecorationSet,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import {
  sampleRelays,
  hitToDocument,
  appendToPalette,
  fetchPalette,
  rankSampleHits,
  fetchFolderOwner,
  forkFolder,
  resolveTagCandidates,
  browseTag,
  fetchChain,
  fetchFolderActivity,
  fetchEventById,
  reconstructUpTo,
  reconstructRunsUpTo,
  auditAttribution,
  stepDeltaRange,
  parseAuthors,
  eventMeta,
  resolveNodeName,
  bufferFocus,
  flushFocusCheckpoint,
  getOrCreateRuleTrace,
  setPendingLlmMeta,
  createFolderGenesis,
  fetchManifest,
  findMergeCandidates,
  incorporateMergeCandidate,
  loadMergeSides,
  type PaletteItem,
  type TagCandidate,
  type EventMeta,
  type FocusSelection,
  type CitationChip,
  type MergeCandidate,
  findInbound,
  type TraceInbound,
} from "./provenance.js";
import { MergePanel } from "./MergePanel.js";
import { ownerFolderOf, activeMounted } from "./focus-routing.js";
import type { Event } from "nostr-tools";
import { diffLines } from "diff";
import { getAlphaOpts } from "./alpha-config.js";
import {
  bracketExtensions,
  bracketVoiceResolverFacet,
  findCommands,
  findPendingBrackets,
  iterBrackets,
  modeCompartment,
  modeFacet,
  onSelectSpanFacet,
  onCopySpanFacet,
  resolveBracket,
  selectedNodeIdFacet,
  wrapSelectionCommand,
  type Mode,
} from "./brackets.js";
import { markdownPreviewExtensions } from "./markdown-preview.js";
import { PalettePanel } from "./PalettePanel.js";
import { OrchestrationTimeline } from "./OrchestrationTimeline.js";
import { LlmReconstructPanel } from "./LlmReconstructPanel.js";
import { DownloadView } from "./Download.js";
import { AboutView } from "./About.js";
import { RelaysView } from "./Relays.js";
import { FriendsView } from "./Friends.js";
import { ModelsView } from "./ModelsView.js";
import { KeysView } from "./KeysView.js";
import { GlobeView } from "./Globe.js";
import { TimesView } from "./TimesView.js";
import { ListingsView } from "./ListingsView.js";
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
  loadKeys,
  manualVoice,
  secretKeyForVoice,
  voiceSpanStyle,
  type KeyEntry,
} from "./keys-store.js";
import {
  loadWorkspaceLayout,
  saveWorkspaceLayout,
  type WorkspaceLayout,
} from "./workspace-layout-store.js";
import { getVoiceProvider, setVoiceProvider } from "./voice-provider-store.js";
import { getVoicePrompt } from "./voice-prompt-store.js";
import { loadProviders, type ProviderConfig } from "./models-store.js";
import { complete, type ChatMessage } from "./llm.js";
import {
  attachFolder,
  chooseFolder,
  defaultFolder,
  detachFolder,
  getAttachedFolder,
  createDiskWorkspace,
  type Run,
  type FileState,
  type SampleEventMeta,
  type AttachedFolder,
} from "./workspace.js";
import { createLocalWorkspace, pullFromRelay } from "./workspace-local.js";
import { loadLocalFolder, saveLocalFile } from "./local-store.js";
import { saveAttachedFolder } from "./registry.js";
import type { Workspace } from "./workspace-core.js";
import { isTauri } from "./identity.js";
import { gatherContextBlock, clearChainMemo } from "./context-gather.js";
import { SYSTEM_PREAMBLE } from "./system-preamble.js";
import {
  listFolders,
  rememberFolder,
  forgetFolder,
  getActiveFolder,
  setActiveFolder,
  findFolder,
} from "./folders.js";
import {
  BarChart3,
  Code,
  CornerDownRight,
  Cpu,
  Download,
  Eye,
  FileText,
  Folder,
  FolderOpen,
  GitFork,
  Globe,
  History,
  KeyRound,
  Layers3,
  MapPin,
  Megaphone,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Quote,
  Radio,
  RotateCcw,
  Sun,
  Tag as TagIcon,
  Users,
  type LucideIcon,
} from "lucide-react";
import "./App.css";

interface TreeNode {
  name: string;
  path: string;
  type: "file" | "folder";
  children?: TreeNode[];
  /** True only for the synthetic top-level node representing the mounted
   *  folder (path === ROOT). Not draggable or deletable, but renamable
   *  (updates the folder's display label). Still selectable and a valid
   *  drop target. Set once when the tree is wrapped under the root in the
   *  App `tree` memo. */
  isRoot?: boolean;
}

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
}


// The unified "active trace" — there is always one once the user has selected
// anything, and it is what the top bar's ACTIONS row operates on. A trace is
// the protocol's single primitive (file | folder | minted [[ span ]]), all
// realized as a kind-4290 nucleus. `path` is set for file/folder selections;
// `nodeId` is the trace nucleus id (file/folder chain head or minted-span id);
// `phrase` carries the visible text for a span selection.
type SelectionKind = "file" | "folder" | "span";
interface SelectionRef {
  kind: SelectionKind;
  path?: string;
  nodeId?: string;
  phrase?: string;
}

// One seal in a folder-wide replay timeline. `contentUpToHere` is the file's
// text as of this seal (the chain replayed genesis→this node), precomputed at
// `beginReplay` so stepping is O(1) per step. The step list is ordered by
// `sealedAtMs` ascending and interleaves every file's seals.
interface ReplayStep {
  event: Event;
  relativePath: string;
  meta: EventMeta;
  contentUpToHere: string;
  /** Per-author runs reconstructed from the chain's deltas up to this seal.
   *  Each inserted range is attributed to the node's signer (event.pubkey), so
   *  the editor colors historical text by who actually wrote it — not by the
   *  session's latest signer. Drives `runs` in replayStepTo. */
  runsUpToHere: Run[];
  /** The footprint of *this seal's* deltas in `contentUpToHere`'s coordinate
   *  space — the changed region vs the previous seal of the same file (or the
   *  whole document for the file's genesis). Drives the editor's scroll-into-
   *  -view during replay so the action that produced each delta lands in view,
   *  not off-screen. `null` only when the seal touched nothing (a tag/reply-
   *  -only edit on a non-first seal). */
  changeRange: { from: number; to: number } | null;
}

// One frame of per-character typewriter playback — the file's runs after
// applying exactly one more character of one delta. `sealIndex` is the index
// into `replay.steps` of the seal whose delta produced this char, so a pause
// can snap the seal cursor to the right save point. Built once per play
// session (buildPlayTimeline) and torn down on pause/stop; the seal stepper
// and its slider keep working at save-point granularity the whole time.
interface PlayFrame {
  path: string;
  sealIndex: number;
  runs: Run[];
}

// Views reachable from the nav rail. `editor` is the existing two-panel
// workspace; the rest are placeholders awaiting real implementations
// (globe → maplibre, keys/relays → nostr, models → LLM keys).
type View = "about" | "listings" | "editor" | "stats" | "globe" | "keys" | "relays" | "friends" | "models" | "download" | "operator";

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

// The resolved mode (what the user actually sees) drives which toggle icon to show.
function resolvedMode(theme: Theme): "light" | "dark" {
  if (theme === "light" || theme === "dark") return theme;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

// The folder the workspace manages lives on real disk now; its identity and
// absolute path are held in `folder` state (sourced from workspace.ts, which
// persists them to localStorage). No hardcoded seed content — the sidebar is
// built entirely from what baselineScan reconstructs at boot.

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

function runsToChars(runs: Run[]): { ch: string; voice: string }[] {
  const out: { ch: string; voice: string }[] = [];
  for (const r of runs) for (const ch of r.text) out.push({ ch, voice: r.voice });
  return out;
}

function charsToRuns(chars: { ch: string; voice: string }[]): Run[] {
  const out: Run[] = [];
  for (const c of chars) {
    const last = out[out.length - 1];
    if (last && last.voice === c.voice) last.text += c.ch;
    else out.push({ voice: c.voice, text: c.ch });
  }
  return out;
}

function spliceRuns(runs: Run[], start: number, end: number, insertText: string, voice: string): Run[] {
  const chars = runsToChars(runs);
  const insertChars = [...insertText].map((ch) => ({ ch, voice }));
  return charsToRuns([...chars.slice(0, start), ...insertChars, ...chars.slice(end)]);
}

// The four topbar LLM operations. With a non-empty editor selection, each
// acts on just the selected text (continuing/condensing/reinventing/replying
// to that range in place); with no selection, each acts on the whole document.
export type OpKind = "extend" | "settle" | "stir" | "reply" | "save" | "zine";

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

/** Settle: condense a loose segment tersely. Never emit `[[ ]]` — brackets are
 *  authored by hand, not by the condenser. Repeated Settle rounds thus drive the
 *  file toward only bracketed text. */
function SETTLE_MESSAGES(loose: string): ChatMessage[] {
  return [
    {
      role: "system",
      content:
        `${SYSTEM_PREAMBLE}\n\n` +
        "YOUR ROLE — Settle: the condenser. You take one passage of loose prose " +
        "and return a terse, dense version: cut filler, tighten phrasing, keep " +
        "every load-bearing idea. You do NOT add new content, arguments, or " +
        "facts. You do NOT emit brackets of any kind (Settle never creates " +
        "sediment — only the human does, by hand). The passage after the " +
        "context block, under no header, is the text to condense. Return ONLY " +
        "the condensed prose — no preamble, no commentary, no fences.",
    },
    { role: "user", content: loose },
  ];
}

/** Stir: rewrite the loose prose freely, applying every `(( command ))`, while
 *  preserving the bracketed anchors verbatim. Single model call: the commands
 *  ARE the editing instructions, applied directly to the loose prose in one
 *  pass. The model places anchors via [[ANCHOR N]] markers; `reweaveAnchors`
 *  (below) substitutes the real anchor text for them afterward. */
function SHAKE_MESSAGES(loose: string, anchorCount: number, commands: string[]): ChatMessage[] {
  const cmdList = commands.length > 0
    ? commands.map((c, i) => `${i + 1}. (( ${c} ))`).join("\n")
    : "(no commands — reinvent freely in the same spirit)";
  const anchorLine = anchorCount > 0
    ? `The original prose contained ${anchorCount} bracketed anchor(s). Place each at the right spot in your rewrite via a \`[[ANCHOR N]]\` marker (1 through ${anchorCount}, in their original order). The system substitutes the real bracket text for each marker; keep the marker text exactly as written. Do not invent anchors beyond the ${anchorCount} given.`
    : "There were no bracketed anchors in the original. Do not introduce any.";
  return [
    {
      role: "system",
      content:
        `${SYSTEM_PREAMBLE}\n\n` +
        "YOUR ROLE — Stir: the reinventor. You rewrite loose prose freely while " +
        "applying the listed `(( command ))` directives and preserving the " +
        "bracketed anchors. The commands are editing instructions — rewrite the " +
        "prose so that each command is carried out, integrated naturally into " +
        "the flow. Treat the commands as authorial intent, not as text to quote " +
        "or acknowledge. Do NOT emit raw `((` or `))`. \n\n" +
        anchorLine + "\n\n" +
        "The text after the context block, under `--- loose prose ---`, is the " +
        "prose to rewrite. Return ONLY the rewritten prose (with any " +
        "`[[ANCHOR N]]` markers placed) — no preamble, no fences, no commentary.",
    },
    {
      role: "user",
      content:
        `--- commands ---\n${cmdList}\n\n` +
        `--- loose prose ---\n${loose || "(empty)"}`,
    },
  ];
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

/** Reply: write a response doc that may cite minted traces by nodeId. */
function RESPOND_MESSAGES(source: string, traces: string): ChatMessage[] {
  return [
    {
      role: "system",
      content:
        `${SYSTEM_PREAMBLE}\n\n` +
        "YOUR ROLE — Reply: the replier. You write a new response document " +
        "engaging with the source text. This op is the only one authorized to " +
        "EMIT new brackets: where you reference a minted passage from the " +
        "available traces, cite it inline as `[[ short quote | nodeId ]]` using " +
        "that trace's EXACT nodeId (copied from the list, never invented). " +
        "Citations should be accurate and sparing — one per load-bearing " +
        "reference, not decorative. The rest of your response is natural prose. " +
        "\n\n" +
        "FORMAT — first line MUST be exactly `TITLE: <short descriptive name>` " +
        "(3–8 words, no file extension, no path, no quotes). Then a blank line. " +
        "Then the response body only — no other preamble, no meta-commentary, " +
        "no fences. The TITLE line names the new document; it is stripped before " +
        "the body is saved.\n\n" +
        "After the context block you will see `--- available minted traces ---` " +
        "(the citable passages, with their nodeIds) and `--- source document ---` " +
        "(the text to reply to). Reply to the source; use the traces as " +
        "citable backing.",
    },
    {
      role: "user",
      content:
        (traces ? `--- available minted traces ---\n${traces}\n\n` : "") +
        `--- source document ---\n${source || "(empty)"}`,
    },
  ];
}

/** Slugify a human phrase into a filename stem (lowercase, hyphenated, ≤40). */
function slugifyFilename(phrase: string, fallback = "response"): string {
  return (
    phrase
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || fallback
  );
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

function buildTree(entries: { path: string; type: "file" | "folder" }[]): TreeNode[] {
  const root: TreeNode = { name: "", path: "", type: "folder", children: [] };
  for (const { path, type } of entries) {
    const parts = path.split("/").filter(Boolean);
    if (!parts.length) continue;
    let cur = root;
    let acc = "";
    parts.forEach((part, i) => {
      acc = acc ? `${acc}/${part}` : part;
      const isLast = i === parts.length - 1;
      const leafType: "file" | "folder" = isLast ? type : "folder";
      let child = cur.children!.find((c) => c.name === part);
      if (!child) {
        child = { name: part, path: acc, type: leafType, children: leafType === "folder" ? [] : undefined };
        cur.children!.push(child);
      }
      cur = child;
    });
  }
  function sortNode(node: TreeNode) {
    if (!node.children) return;
    node.children.sort((a, b) =>
      a.type !== b.type ? (a.type === "folder" ? -1 : 1) : a.name.localeCompare(b.name),
    );
    node.children.forEach(sortNode);
  }
  sortNode(root);
  return root.children!;
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
  const next = [...panels];
  next[idx] = fn(next[idx]);
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
  modes: Record<string, "preview" | "markdown">,
  panels: PanelState[],
): Record<string, "preview" | "markdown"> {
  const open = new Set<string>();
  for (const p of panels) for (const t of p.tabs) open.add(t);
  if (open.size === 0) return {};
  const next: Record<string, "preview" | "markdown"> = {};
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
  tabModes: Record<string, "preview" | "markdown">;
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

// Append `-2`, `-3`, … before the extension until `path` is free in `taken`.
// Used so two sampled events with the same pubkey/id prefix (or a re-sample)
// don't clobber an existing file. Also used when Reply titles a new doc.
function uniquePath(path: string, taken: Set<string>): string {
  if (!taken.has(path)) return path;
  const dot = path.lastIndexOf(".");
  const stem = dot > 0 ? path.slice(0, dot) : path;
  const ext = dot > 0 ? path.slice(dot) : "";
  for (let i = 2; ; i++) {
    const candidate = `${stem}-${i}${ext}`;
    if (!taken.has(candidate)) return candidate;
  }
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
  openTabs,
  draggingPaths,
  dropTargetPath,
  onDragStart,
  onDragEnterTarget,
  onDragLeaveTarget,
  onDropOn,
  canDropOn,
  onContextMenuRow,
  renamingPath,
  renameInputRef,
  renameDraft,
  renameError,
  onRenameChange,
  onRenameKey,
  onRenameCommit,
  onRenameCancel,
  selectedPaths,
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
  openTabs: string[];
  /** Set of tree paths in the current multi-selection. Drives the highlight
   *  on each row (a row is gold iff its path is in the set). */
  selectedPaths: Set<string>;
  /** Row click with modifier context. The Sidebar owns the selection model:
   *  plain click selects-sole + activates (file opens, folder toggles);
   *  Cmd/Ctrl-click toggles membership without activating; Shift-click ranges
   *  from the anchor. Folder expand/collapse is folded in here so a plain
   *  click both selects and toggles, matching the prior single-select UX. */
  onRowActivate: (path: string, e: React.MouseEvent) => void;
  draggingPaths: Set<string>;
  dropTargetPath: string | null;
  onDragStart: (path: string) => void;
  onDragEnterTarget: (path: string) => void;
  onDragLeaveTarget: (path: string) => void;
  onDropOn: (path: string) => void;
  canDropOn: (path: string) => boolean;
  onContextMenuRow: (e: React.MouseEvent, path: string) => void;
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

  if (node.type === "folder") {
    const isOpen = !collapsed.has(node.path);
    const dropAllowed = canDropOn(node.path);
    const folderSelected = selectedPaths.has(node.path);
    const isRoot = node.isRoot === true;
    const rowClass =
      "tree-row tree-folder" +
      (isRoot ? " tree-row-root" : "") +
      (folderSelected ? " tree-row-selected" : "") +
      (isDragging ? " tree-dragging" : "") +
      (isDropTarget && dropAllowed ? " tree-drop-target" : "") +
      (isDropTarget && !dropAllowed ? " tree-drop-denied" : "");
    return (
      <div>
        <div
          className={rowClass}
          style={indent}
          draggable={!isRoot && !isRenaming}
          onDragStart={(e) => {
            // copyMove: tree reparent uses "move"; tag-strip drop uses "copy".
            // "move"-only rejects a link/copy dropEffect and the tag drop dies.
            e.dataTransfer.effectAllowed = "copyMove";
            e.dataTransfer.setData("text/zine-path", node.path);
            // text/plain fallback for hosts that strip custom MIME types
            // (WKWebView / some Tauri shells) on getData at drop time.
            e.dataTransfer.setData("text/plain", `zine-path:${node.path}`);
            onDragStart(node.path);
          }}
          onDragEnter={(e) => {
            if (draggingPaths.size > 0 && !draggingPaths.has(node.path)) {
              e.preventDefault();
              onDragEnterTarget(node.path);
            }
          }}
          onDragOver={(e) => {
            // The root is always a drop target (drop on root = move to root);
            // other folders only when a drop is allowed and they're not the
            // dragged source.
            if (draggingPaths.size > 0 && !draggingPaths.has(node.path) && canDropOn(node.path)) {
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
            }
          }}
          onDragLeave={(e) => {
            // only clear when leaving for a different row, not when entering a child
            if (e.currentTarget.contains(e.relatedTarget as Node)) return;
            onDragLeaveTarget(node.path);
          }}
          onDrop={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onDropOn(node.path);
          }}
          onContextMenu={(e) => onContextMenuRow(e, node.path)}
          onClick={(e) => {
            // Don't toggle collapse when the rename input is mounted; clicking
            // into the field would otherwise yank the row open/closed. A plain
            // click both selects the folder (gold box) and toggles it; modifier
            // clicks (cmd/shift) are handled by onRowActivate, which only
            // toggles expand on a plain (non-modifier) click.
            if (!isRenaming) {
              onRowActivate(node.path, e);
              if (!e.metaKey && !e.ctrlKey && !e.shiftKey) onToggleFolder(node.path);
            }
          }}
        >
          {isOpen ? (
            <FolderOpen size={13} className="tree-icon" aria-hidden="true" />
          ) : (
            <Folder size={13} className="tree-icon" aria-hidden="true" />
          )}
          {isRenaming ? (
            <input
              ref={renameInputRef}
              className={"create-input" + (renameError ? " invalid" : "")}
              type="text"
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
          {isRoot && (
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
          <>
            {node.children!.map((c) => (
              <TreeItem
                key={c.path}
                node={c}
                depth={depth + 1}
                collapsed={collapsed}
                onToggleFolder={onToggleFolder}
                openTabs={openTabs}
                draggingPaths={draggingPaths}
                dropTargetPath={dropTargetPath}
                onDragStart={onDragStart}
                onDragEnterTarget={onDragEnterTarget}
                onDragLeaveTarget={onDragLeaveTarget}
                onDropOn={onDropOn}
                canDropOn={canDropOn}
                onContextMenuRow={onContextMenuRow}
                renamingPath={renamingPath}
                renameInputRef={renameInputRef}
                renameDraft={renameDraft}
                renameError={renameError}
                onRenameChange={onRenameChange}
                onRenameKey={onRenameKey}
                onRenameCommit={onRenameCommit}
                onRenameCancel={onRenameCancel}
                selectedPaths={selectedPaths}
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
          </>
        )}
      </div>
    );
  }

  // Is this file open as a tab in any panel? Tints the row icon gold (gold is
  // reserved for the *selected* row below — merely being open no longer fills
  // the whole row gold).
  const isOpen = openTabs.includes(node.path);
  const fileSelected = selectedPaths.has(node.path);

  return (
    <div
      className={
        "tree-row tree-file" +
        (fileSelected ? " tree-row-selected" : "") +
        (isDragging ? " tree-dragging" : "")
      }
      style={indent}
      draggable={!isRenaming}
      onDragStart={(e) => {
        // copyMove: tree reparent uses "move"; tag-strip drop uses "copy".
        e.dataTransfer.effectAllowed = "copyMove";
        e.dataTransfer.setData("text/zine-path", node.path);
        e.dataTransfer.setData("text/plain", `zine-path:${node.path}`);
        onDragStart(node.path);
      }}
      onContextMenu={(e) => onContextMenuRow(e, node.path)}
      onClick={(e) => {
        // Don't open the file while its name is being edited. onRowActivate
        // handles plain (select-sole + open) and modifier (cmd/shift) clicks.
        if (!isRenaming) onRowActivate(node.path, e);
      }}
    >
      <FileText size={13} className={"tree-icon" + (isOpen ? " tree-icon-open" : "")} aria-hidden="true" />
      {isRenaming ? (
        <input
          ref={renameInputRef}
          className={"create-input" + (renameError ? " invalid" : "")}
          type="text"
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
      {isRenaming && renameError && <p className="create-error">{renameError}</p>}
    </div>
  );
}

function Sidebar({
  tree,
  collapsed,
  onToggleFolder,
  openTabs,
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
  onRename,
  samplerOpen,
  onToggleSampler,
  sampler,
  tagBrowserOpen,
  onToggleTagBrowser,
  tagBrowser,
  palette,
  onSwitchFolder,
  folderId,
  orchestrationOpen,
  onToggleOrchestration,
  orchestrationRefreshKey,
  activeTracePath,
  onOpenToSide,
  onBeginReplay,
  replayStep,
  replayIndex,
  replayCount,
  playing,
  playSpeed,
  replayActive,
  onStep,
  onTogglePlay,
  onCycleSpeed,
  onOpenFolder,
}: {
  tree: TreeNode[];
  collapsed: Set<string>;
  onToggleFolder: (path: string) => void;
  openTabs: string[];
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
  onRename: (path: string, newName: string) => string | null;
  samplerOpen: boolean;
  onToggleSampler: () => void;
  sampler: React.ReactNode;
  tagBrowserOpen: boolean;
  onToggleTagBrowser: () => void;
  tagBrowser: React.ReactNode;
  palette: React.ReactNode;
  /** Detach the current press and return to the folder picker. */
  onSwitchFolder: () => void;
  /** Id of the attached folder. A change (switch/detach) clears the tree
   *  multi-selection so it never refers to paths that no longer exist. */
  folderId: string | null;
  /** Whether the orchestration-replay section is expanded. §3.3/§8. */
  orchestrationOpen: boolean;
  /** Toggle the orchestration-replay section. */
  onToggleOrchestration: () => void;
  /** Bumped by App() after a folder-chain mutation so the orchestration panel
   *  re-fetches its stream. Mirrors PalettePanel's `refreshKey`. */
  orchestrationRefreshKey: number;
  /** The focused panel's active trace path (a file path, or a folder relpath
   *  when its active tab is a folder sentinel; "" when the panel is empty).
   *  Drives the gold "selected" row so the sidebar reflects whichever tab the
   *  focused panel is showing — set whenever a panel is focused or a tab is
   *  selected, not only on a tree-row click. */
  activeTracePath: string;
  /** Open a tree item into a fresh column to the right of the active panel
   *  (the context menu's "Open to side"). A folder opens as a folder tab, a
   *  file as an editor tab; a new column is always spawned. */
  onOpenToSide: (path: string) => void;
  /** Open a folder as a folder tab in the *active* panel (the context menu's
   *  "Open"). Mirrors onActivateFile but for folders: opens the special
   *  folder tab instead of leaving the folder as a selection-only trace. */
  onOpenFolder: (path: string) => void;
  /** Bootstrap folder-wide replay (async fetch of the folder's seals). Called
   *  by the transport's ▶ when no timeline is loaded yet. */
  onBeginReplay: () => void;
  /** The current replay step (the one the editor is showing), or null when not
   *  replaying. Drives the transport's hover tooltip (action/file/time/blurb). */
  replayStep: ReplayStep | null;
  /** Current replay index (0-based). `replayCount - 1` is the sticky `last`.
   *  Display-only position for the transport: while the per-character typewriter
   *  plays this tracks the frame being typed (each PlayFrame carries its
   *  producing seal's sealIndex) so the slider/stepper stay in sync with the
   *  visible typing; otherwise it's the committed `replay.index`. The committed
   *  `replay.index` itself drives the editor's frozen-content override + snapshot
   *  capture/restore, which must not thrash per character — so the caller derives
   *  this display value without advancing the committed one. */
  replayIndex: number;
  /** Total replay steps in the folder timeline. */
  replayCount: number;
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

  // multi-selection state. selectedPaths is the set of tree rows the user has
  // highlighted (via plain/cmd/shift click); anchorPath is the pivot for
  // shift-click ranges. Cleared on a folder switch (below) so it never refers
  // to paths that no longer exist.
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(() => new Set());
  const [anchorPath, setAnchorPath] = useState<string | null>(null);

  // drag state lives here — the set of source paths being dragged (one or
  // many) and the currently-hovered drop target (a folder path, or "" for root).
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

  // Clear the tree selection when the attached folder changes — selected paths
  // from a previous press don't exist in the new one.
  const folderIdRef = useRef(folderId);
  useEffect(() => {
    if (folderIdRef.current !== folderId) {
      folderIdRef.current = folderId;
      setSelectedPaths(new Set());
      setAnchorPath(null);
    }
  }, [folderId]);

  // Mirror the focused panel's active tab into the tree selection so the gold
  // highlight follows whichever tab the user is viewing — whether they reached
  // it by clicking a tree row, selecting a panel tab, or focusing a panel. A
  // plain tree click already sets this same path, so the effect is a no-op
  // there; cmd/shift-clicks don't move the focused panel's active tab, so their
  // multi-select ranges survive (this only fires when activeTracePath changes).
  useEffect(() => {
    if (!activeTracePath) return;
    setSelectedPaths(new Set([activeTracePath]));
    setAnchorPath(activeTracePath);
  }, [activeTracePath]);

  // A flat, ordered list of the currently-visible tree paths (files + folders,
  // depth-first in display order). Shift-click ranges are computed over this so
  // collapsed subtrees are skipped, matching what the user sees.
  const visiblePaths = useMemo(() => {
    const out: string[] = [];
    const walk = (nodes: TreeNode[]) => {
      for (const n of nodes) {
        out.push(n.path);
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
    // is showing (selecting a folder via a plain click updates `selectedPaths`
    // but not `activeTracePath`, which only follows open tabs). Same folder-test
    // as the context menu: ROOT, an explicit empty-folder entry, or anything
    // with a nested child. Falls through to the active-trace scope otherwise.
    if (selectedPaths.size === 1) {
      const sel = [...selectedPaths][0];
      if (sel === ROOT || folderPaths.has(sel) || hasChild(filePaths, folderPaths, sel)) {
        return sel;
      }
    }
    const p = activeTracePath;
    if (!p) return ROOT;
    if (folderPaths.has(p) || hasChild(filePaths, folderPaths, p)) return p;
    return parentPath(p);
  }

  // The row-click router. Plain click selects `path` sole and activates it
  // (a file opens into the active panel; a folder's expand is toggled by the
  // caller). Cmd/Ctrl-click toggles membership without activating. Shift-click
  // selects the range from the anchor to `path` (inclusive), keeping the
  // anchor as-is so repeated shift-clicks adjust the far end.
  function onRowActivate(path: string, e: React.MouseEvent) {
    const additive = e.metaKey || e.ctrlKey;
    if (e.shiftKey && anchorPath != null) {
      const a = visiblePaths.indexOf(anchorPath);
      const b = visiblePaths.indexOf(path);
      if (a !== -1 && b !== -1) {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        const range = new Set(visiblePaths.slice(lo, hi + 1));
        // shift+cmd adds the range to the existing selection instead of replacing.
        setSelectedPaths(additive ? new Set([...selectedPaths, ...range]) : range);
        return;
      }
      // anchor not visible (collapsed/moved): fall through to a sole select.
    }
    if (additive) {
      setSelectedPaths((prev) => {
        const next = new Set(prev);
        if (next.has(path)) next.delete(path);
        else next.add(path);
        return next;
      });
      setAnchorPath(path);
      return;
    }
    // plain click (or shift-click with no anchor): select-sole + activate.
    // Files open into the active panel; folders become the active trace without
    // opening anything (their expand toggle is handled by the row's onClick).
    // The synthetic root (path === ROOT) is always a folder.
    setSelectedPaths(new Set([path]));
    setAnchorPath(path);
    if (path === ROOT || folderPaths.has(path) || hasChild(filePaths, folderPaths, path)) {
      onActivateFolder(path);
    } else {
      onActivateFile(path);
    }
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

  // Right-click selects-sole if the row wasn't already selected, otherwise
  // keeps the current selection so the menu acts on the whole set.
  function openContextMenu(e: React.MouseEvent, path: string) {
    e.preventDefault();
    e.stopPropagation();
    if (!selectedPaths.has(path)) {
      setSelectedPaths(new Set([path]));
      setAnchorPath(path);
    }
    setCtxMenu({ x: e.clientX, y: e.clientY, path });
  }

  // The paths a Delete should act on: the current selection, pruned of any
  // path nested beneath another selected path (an ancestor carries its
  // descendants, so listing both would double-count).
  function topLevelSelected(): string[] {
    const all = [...selectedPaths];
    return all.filter((p) => !all.some((q) => q !== p && isDescendantOrSelf(q, p)));
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
    if (draggingPaths.size === 0) return false;
    for (const src of draggingPaths) {
      if (canDrop(src, destFolder, filePaths, folderPaths)) return true;
    }
    return false;
  }

  function clearDrag() {
    setDraggingPaths(new Set());
    setDropTargetPath(null);
  }

  return (
    <nav className="sidebar">
      {/* Switch folder: detach this press and return to the desktop folder
          picker. Web has no on-disk folder to switch, so this is desktop-only
          — the webapp resets its relay folder via the rail's reset action. */}
      {isTauri() && (
        <button
          type="button"
          className="sidebar-switch"
          title="Switch or sync folder"
          onClick={onSwitchFolder}
        >
          <FolderOpen size={14} strokeWidth={1.75} aria-hidden="true" />
          <span>Switch folder</span>
        </button>
      )}
      {/* Pin the active zine to a geohash for Spaces. A folder-level authoring
          act (not a per-file seal), so it lives in the sidebar header rather
          than the TopBar's per-file ops. Opens the PinPanel via a decoupled
          event (PinPanel doesn't import the shell). */}
      {folderId && (
        <button
          type="button"
          className="sidebar-switch"
          title="Pin this zine to the map"
          onClick={() =>
            window.dispatchEvent(new CustomEvent("zine:open-pin", { detail: folderId }))
          }
        >
          <MapPin size={14} strokeWidth={1.75} aria-hidden="true" />
          <span>Pin to map</span>
        </button>
      )}
      <ReplayTransport
        index={replayIndex}
        count={replayCount}
        playing={playing}
        playSpeed={playSpeed}
        replayActive={replayActive}
        onBegin={onBeginReplay}
        onStep={onStep}
        onTogglePlay={onTogglePlay}
        onCycleSpeed={onCycleSpeed}
        // Hover context for the row: the current step's action, file, time,
        // and (for LLM seals) its summary or prompt. On `last` this is the
        // just-sealed node; on a historical step it's the save point being
        // verified. Only shown once replay is active.
        containerTitle={
          replayStep
            ? [
                replayStep.meta.action ?? "edit",
                replayStep.relativePath,
                new Date(replayStep.meta.sealedAtMs).toLocaleString(),
                sealDescription(replayStep.event).summary ??
                  sealDescription(replayStep.event).prompt,
              ]
                .filter(Boolean)
                .join(" · ")
            : undefined
        }
      />
      {/* Folder-orchestration replay (§3.3/§8): entry/exit/rename/selection
          over the folder's lifetime. Collapsible; independent of the content
          ReplayTransport above. Only meaningful with a folder attached. */}
      <div className="sidebar-orchestration">
        <button
          type="button"
          className="sidebar-orchestration-toggle"
          aria-expanded={orchestrationOpen}
          onClick={onToggleOrchestration}
        >
          <span>{orchestrationOpen ? "▾" : "▸"} Orchestration</span>
        </button>
        {orchestrationOpen && (
          <OrchestrationTimeline
            folderId={folderId}
            refreshKey={orchestrationRefreshKey}
          />
        )}
      </div>
      <div
        className={"tree" + (dropTargetPath === ROOT && canDropOn(ROOT) ? " tree-drop-target" : "")}
        onDragEnter={(e) => {
          if (draggingPaths.size > 0 && e.target === e.currentTarget) {
            e.preventDefault();
            setDropTargetPath(ROOT);
          }
        }}
        onDragOver={(e) => {
          // allow dropping onto empty space inside the tree → move to root.
          // child rows stopPropagation on their own drops, so this only fires
          // for the bare container.
          if (draggingPaths.size > 0 && canDropOn(ROOT)) {
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
          }
        }}
        onDrop={(e) => {
          e.preventDefault();
          onMove([...draggingPaths], ROOT);
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
            openTabs={openTabs}
            draggingPaths={draggingPaths}
            dropTargetPath={dropTargetPath}
            onDragStart={(path) => {
              // Dragging an unselected row drags just that row (and makes it
              // the sole selection, like a plain click); dragging a selected
              // row drags the whole selection.
              if (selectedPaths.has(path)) {
                setDraggingPaths(new Set(selectedPaths));
              } else {
                setSelectedPaths(new Set([path]));
                setAnchorPath(path);
                setDraggingPaths(new Set([path]));
              }
            }}
            onDragEnterTarget={setDropTargetPath}
            onDragLeaveTarget={(path) => {
              setDropTargetPath((cur) => (cur === path ? null : cur));
            }}
            onDropOn={(destFolder) => {
              onMove([...draggingPaths], destFolder);
              clearDrag();
            }}
            canDropOn={canDropOn}
            onContextMenuRow={openContextMenu}
            renamingPath={renamingPath}
            renameInputRef={renameInputRef}
            renameDraft={renameDraft}
            renameError={renameError}
            onRenameChange={setRenameDraft}
            onRenameKey={onRenameKey}
            onRenameCommit={commitRename}
            onRenameCancel={cancelRename}
            selectedPaths={selectedPaths}
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
              folderPaths.has(ctxMenu.path) ||
              hasChild(filePaths, folderPaths, ctxMenu.path);
            return isFolder ? (
              <button
                type="button"
                className="ctx-menu-item"
                // Open the folder as the special folder:// tab in the active
                // panel (not a file tab). Distinct from "Open to side", which
                // spawns a fresh column.
                onClick={() => {
                  const p = ctxMenu.path;
                  setCtxMenu(null);
                  onOpenFolder(p);
                }}
              >
                Open
              </button>
            ) : null;
          })()}
          <button
            type="button"
            className="ctx-menu-item"
            // Open this item into a fresh column immediately to the right of
            // the active panel. Replaces the per-row info button.
            onClick={() => {
              const p = ctxMenu.path;
              setCtxMenu(null);
              onOpenToSide(p);
            }}
          >
            Open to side
          </button>
          {(() => {
            // New File / New Folder target the right-clicked folder. Same
            // folder-test as elsewhere: an explicit empty-folder entry, or any
            // file/folder nested beneath it. The synthetic root (path === ROOT)
            // is always treated as a folder here so the mounted folder offers
            // "new" in its context menu too.
            const isFolder =
              ctxMenu.path === ROOT ||
              folderPaths.has(ctxMenu.path) ||
              hasChild(filePaths, folderPaths, ctxMenu.path);
            return isFolder ? (
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
          <button
            type="button"
            className="ctx-menu-item"
            // Rename is a single-item operation; disable it when the selection
            // spans more than one row so the affordance matches the behavior.
            // The synthetic root is renamable (display label only).
            disabled={selectedPaths.size > 1}
            onClick={() => requestRename(ctxMenu.path)}
          >
            Rename
          </button>
          {ctxMenu.path !== ROOT && (
            <button
              type="button"
              className="ctx-menu-item danger"
              onClick={() => requestDelete(topLevelSelected())}
            >
              Delete{selectedPaths.size > 1 ? ` (${selectedPaths.size})` : ""}
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
                    ? `Delete ${confirmDelete.paths.length} items (including ${confirmDelete.childCount} item${confirmDelete.childCount === 1 ? "" : "s"} inside selected folders)? This cannot be undone.`
                    : `Delete ${confirmDelete.paths.length} items? This cannot be undone.`
                  : `Delete ${confirmDelete.paths.length} items? This cannot be undone.`
                : confirmDelete.isFolder
                  ? confirmDelete.childCount > 0
                    ? `Delete folder "${confirmDelete.name}" and ${confirmDelete.childCount} item${confirmDelete.childCount === 1 ? "" : "s"} inside it? This cannot be undone.`
                    : `Delete empty folder "${confirmDelete.name}"? This cannot be undone.`
                  : `Delete "${confirmDelete.name}"? This cannot be undone.`}
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
      {samplerOpen && <SampleModal onClose={onToggleSampler}>{sampler}</SampleModal>}
      {tagBrowserOpen && (
        <SampleModal title="Browse a tag" onClose={onToggleTagBrowser}>
          {tagBrowser}
        </SampleModal>
      )}
      <div className="sidebar-header sidebar-header--palette">
        <span className="sidebar-title">PALETTE</span>
      </div>
      {palette}
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
   *  compose-dialog width (e.g. the Seals modal's side-by-side list+diff). */
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

// --- seals modal (history + diff) ---------------------------------------
//
// Every FileTraceNode carries its own full `snapshot` (protocol §Save/seal
// triggers) — O(1) read of "content as of any seal", no delta replay needed —
// so a history view is just a list over `fetchChain`'s result (genesis→latest,
// already fetched by App.openSeals). Reuses the SampleModal shell above for
// the overlay/close chrome. Read-only: view + step + diff, no restore.

/** Pulls a kind-4290 event's `snapshot` string straight out of its content —
 *  same O(1) read every other provenance display already relies on (see
 *  reconstructFromChain, provenance.ts), just for a single node instead of
 *  replaying a whole chain. */
function sealSnapshot(event: Event): string {
  try {
    const parsed = JSON.parse(event.content) as { snapshot?: string };
    return typeof parsed.snapshot === "string" ? parsed.snapshot : "";
  } catch {
    return "";
  }
}

/** Pulls an LLM seal's `prompt` and `summary` out of its content JSON for the
 *  replay summary line. Both are optional (only LLM-action seals carry them;
 *  edit/import seals have neither). Returns whatever is present. */
function sealDescription(event: Event): { prompt?: string; summary?: string } {
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

function SealsModal({
  relativePath,
  chain,
  pinnedEventId,
  onClose,
}: {
  relativePath: string;
  /** genesis → latest, as returned by fetchChain. */
  chain: Event[];
  /** Seeds the selected index at this exact node (the "replying to ↑" entry
   *  point) instead of the latest seal. */
  pinnedEventId?: string;
  onClose: () => void;
}) {
  const pinnedIndex = pinnedEventId ? chain.findIndex((e) => e.id === pinnedEventId) : -1;
  const [selectedIndex, setSelectedIndex] = useState(pinnedIndex >= 0 ? pinnedIndex : chain.length - 1);
  const [diffMode, setDiffMode] = useState<"prev" | "current" | "none">("prev");

  const selected = chain[selectedIndex];
  const selectedText = selected ? sealSnapshot(selected) : "";
  const currentText = chain.length > 0 ? sealSnapshot(chain[chain.length - 1]) : "";
  const prevText = selectedIndex > 0 ? sealSnapshot(chain[selectedIndex - 1]) : null;
  // "vs prev" has nothing to compare at genesis; "vs current" is a no-op at
  // the head; "no diff" always shows the plain content pane.
  const diffTarget =
    diffMode === "current" ? currentText : diffMode === "prev" ? prevText : null;
  const diffParts = useMemo(
    () => (diffTarget !== null ? diffLines(diffTarget, selectedText) : null),
    [diffTarget, selectedText],
  );

  return (
    <SampleModal title={`Seals · ${relativePath}`} onClose={onClose} wide>
      <div className="seals-modal">
        <div className="seals-list" role="listbox" aria-label="Seal history">
          {chain.map((event, idx) => {
            const meta = eventMeta(event);
            return (
              <button
                key={event.id}
                type="button"
                role="option"
                aria-selected={idx === selectedIndex}
                className={
                  "seals-row" +
                  (idx === selectedIndex ? " active" : "") +
                  (event.id === pinnedEventId ? " pinned" : "")
                }
                onClick={() => setSelectedIndex(idx)}
              >
                <span className="seals-row-date">{new Date(meta.sealedAtMs).toLocaleString()}</span>
                <span className="seals-row-action">{meta.action ?? "edit"}</span>
                <span className="seals-row-id">{event.id.slice(0, 8)}</span>
              </button>
            );
          }).reverse()}
        </div>
        <div className="seals-detail">
          <div className="seals-controls">
            <button
              type="button"
              className="seals-step-btn"
              disabled={selectedIndex <= 0}
              onClick={() => setSelectedIndex((i) => Math.max(0, i - 1))}
            >
              ← older
            </button>
            <span className="seals-position">
              {selectedIndex + 1} / {chain.length}
            </span>
            <button
              type="button"
              className="seals-step-btn"
              disabled={selectedIndex >= chain.length - 1}
              onClick={() => setSelectedIndex((i) => Math.min(chain.length - 1, i + 1))}
            >
              newer →
            </button>
            <div className="seals-diff-toggle" role="group" aria-label="Diff against">
              <button
                type="button"
                className={"seals-diff-btn" + (diffMode === "prev" ? " active" : "")}
                onClick={() => setDiffMode("prev")}
              >
                vs prev
              </button>
              <button
                type="button"
                className={"seals-diff-btn" + (diffMode === "current" ? " active" : "")}
                onClick={() => setDiffMode("current")}
              >
                vs current
              </button>
              <button
                type="button"
                className={"seals-diff-btn" + (diffMode === "none" ? " active" : "")}
                onClick={() => setDiffMode("none")}
              >
                no diff
              </button>
            </div>
          </div>
          {diffParts ? (
            <pre className="seals-diff">
              {diffParts.map((part, i) => (
                <span
                  key={i}
                  className={part.added ? "seals-diff-add" : part.removed ? "seals-diff-remove" : "seals-diff-same"}
                >
                  {part.value}
                </span>
              ))}
            </pre>
          ) : (
            <pre className="seals-content">{selectedText}</pre>
          )}
          {/* §3.7: when the selected seal is an LLM call, show the reconstructed
              submitted prompt (system + user) + scope + model config below the
              content. Renders nothing for non-LLM seals. */}
          {selected && <LlmReconstructPanel event={selected} />}
        </div>
      </div>
    </SampleModal>
  );
}

// --- operator setup modal ------------------------------------------------
//
// Shown on webapp boot when /operator/state reports no bound operator, and
// re-openable from the operator panel to rotate the bound key. The browser
// signs with its manual (pen) key — never typed or pasted — and the bootstrap
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
// Always-visible transport pinned at the top of the sidebar (under "Switch
// folder"). Two rows, shown directly (no "Replay folder" gate):
//   row 1 — stepper + counter:  ⏮ ◀ [n / total] ▶ ⏭   (left-aligned)
//   row 2 — transport:          ▶/⏸  ·  N×  ·  [===== slider =====]
// The stepper + slider jump save-point to save-point. Play animates per
// character (typewriter). `last` is sticky (resting = live document): a new
// seal while parked at the right end appends a step, the counter ticks up, and
// the slider's max grows to include it. Before replay is bootstrapped (count
// 0) the step buttons disable and ▶ becomes "load & play" — it bootstraps the
// timeline (beginReplay is async) then starts playback.
function ReplayTransport({
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
}: {
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
  /** Bootstrap replay (async fetch of the folder's seals). Called by ▶ when no
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
}) {
  const bootstrapped = count > 0;
  const first = index <= 0;
  const last = index >= count - 1;
  // The slider's discrete stops are the save points. With ≤1 step there's
  // nothing to scrub, so render a degenerate 0..0 range.
  const max = Math.max(0, count - 1);
  return (
    <div
      className={"sidebar-replay" + (playing ? " is-playing" : "")}
      role="group"
      aria-label="Folder replay"
      title={containerTitle}
    >
      <div className="sidebar-replay-row sidebar-replay-stepper">
        <button
          type="button"
          className="seals-step-btn"
          disabled={!bootstrapped || first || playing}
          onClick={() => onStep(0)}
          title="First save point"
        >
          ⏮
        </button>
        <button
          type="button"
          className="seals-step-btn"
          disabled={!bootstrapped || first || playing}
          onClick={() => onStep(index - 1)}
          title="Previous save point"
        >
          ◀
        </button>
        <span className="seals-position" title="Save point position in the folder timeline">
          {count > 0 ? `${index + 1} / ${count}` : "— / —"}
        </span>
        <button
          type="button"
          className="seals-step-btn"
          disabled={!bootstrapped || last || playing}
          onClick={() => onStep(index + 1)}
          title="Next save point"
        >
          ▶
        </button>
        <button
          type="button"
          className={
            "seals-step-btn" + (replayActive && !last ? " sidebar-replay-skip" : "")
          }
          // ⏭ is the read-only escape: always enabled (even mid-playback) so
          // the highlighted button reliably drops you back on the live doc.
          // onStep tears down the char timeline before seeking to `last`.
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
          className="seals-step-btn sidebar-replay-play"
          disabled={playing}
          onClick={() => (bootstrapped ? onTogglePlay() : onBegin())}
          title={
            playing
              ? "Pause playback"
              : bootstrapped
                ? "Play through the timeline"
                : "Load this folder's seals and play"
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
        <div className="sidebar-replay-slider-wrap">
          {/* Savepoint ticks: one per step, positioned at the same fraction the
              slider itself maps step i to (min=0, max=count-1 → i/(count-1)).
              Purely visual (aria-hidden) — the range input stays interactive.
              A positioned overlay rather than <datalist> because range tick
              rendering is inconsistent across UAs (WebKit/Chromium draw them,
              Firefox doesn't) and this gives full styling control. */}
          {count > 0 && (
            <div className="sidebar-replay-ticks" aria-hidden="true">
              {Array.from({ length: count }, (_, i) => (
                <span
                  key={i}
                  className="sidebar-replay-tick"
                  style={{ left: `${count > 1 ? (i / (count - 1)) * 100 : 0}%` }}
                />
              ))}
            </div>
          )}
          <input
            // Local key so React doesn't fight a drag in progress when `index`
            // updates from auto-play — without it the input can jump mid-drag.
            key={count}
            type="range"
            className="sidebar-replay-slider"
            min={0}
            max={max}
            value={Math.min(index, max)}
            onChange={(e) => onStep(Number(e.target.value))}
            title={`Save point ${index + 1} of ${count}`}
            aria-label="Replay position"
          />
        </div>
      </div>
    </div>
  );
}

// --- sampler panel -----------------------------------------------------
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

// The voice new text is attributed to — resolved to the keychain's manual
// (pen) key pubkey at edit time (see keys-store.ts), so switching the manual
// key in the TopBar changes who subsequent edits are attributed to without a
// reload. Pre-keychain this was the hardcoded "alice". Resolved live at each
// call site rather than captured once at module load (a module-level const
// would freeze the attribution to whatever key was manual when the bundle
// loaded).
//
// Per-panel override: each editor also carries a `voiceFacet` set to that
// panel's chosen "pen" (a pubkey). When set, it wins over `manualVoice()` so
// the left and right panels can write under different voices at once; a panel
// that hasn't picked a pen still falls back to the global manual (pen) key. The
// facet lives in a Compartment so it can be reconfigured live (switching pens) without
// rebuilding the editor's extensions.

/** The pen voice for the editor that provides this facet. Empty string means
 *  "no pen picked" — the editor falls back to the global active voice. */
const voiceFacet = Facet.define<string, string>({ combine: (v) => v[0] ?? "" });
/** Holds voiceFacet so it can be reconfigured on the fly (pen switch). */
const voiceCompartment = new Compartment();
/** Holds voiceDecorations so it can be dropped/re-added on the fly when the
 *  global voice-attribution toggle flips — without rebuilding the editor's
 *  whole extension set (which would reset doc state, history, etc.). */
const voiceAttributionCompartment = new Compartment();
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

/** Tags a doc-change transaction with the exact voice an LLM op streamed under.
 *  Carried in the same transaction as the change, so attribution can't drift
 *  even when the editor facet is reconfigured mid-stream (pen switch, a prior
 *  op's restore). Absent on a change → the facet pen / manual key is used. */
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
    // An op-tagged voice wins over the facet pen: it's the voice the op was
    // invoked under (the dropdown the user clicked), captured in the change
    // transaction itself rather than read from the live facet — which may be
    // reconfigured by a concurrent pen switch or a stale endOp restore between
    // dispatch and field update. Falls back to the facet pen, then the manual
    // (pen) key.
    const opVoice = tr.effects.find((e) => e.is(opVoiceEffect))?.value;
    const pen = opVoice || tr.state.facet(voiceFacet) || manualVoice();
    let out = runs;
    for (let i = changes.length - 1; i >= 0; i--) {
      const { fromA, toA, insert } = changes[i];
      out = spliceRuns(out, fromA, toA, insert, pen);
    }
    return out;
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

// Stick-to-bottom: when the scroller is parked near the bottom and a
// doc-changing transaction lands (an LLM streaming a delta, a relay push
// appending content), re-pin to the new bottom so the viewport follows the
// stream. CM6's own scrolledToBottom compensation only fires when the viewport
// didn't change and no measures are pending (the `else` branch in its measure
// loop) — a long document streaming content below the fold changes the
// viewport, so that path is skipped and the view drifts up a line per token.
//
// The re-pin is deferred to the next animation frame so it runs *after* CM6's
// own measure loop (also rAF-scheduled, registered before this callback) has
// applied its scroll-anchor compensation. Setting scrollTop synchronously in
// update() would race that loop and get overwritten. It never fights the
// reader: a scrolled-up position has wasAtBottom === false, so nothing happens
// and the scroll-anchor stability from the sync effect's append-only path
// keeps the visible line put. The threshold (24px) forgives a fraction-of-a-
// line drift mid-stream so "pinned" stays sticky across rapid tokens.
const STICK_BOTTOM_THRESHOLD = 24;
function isScrolledToBottom(view: EditorView): boolean {
  const el = view.scrollDOM;
  return el.scrollTop >= el.scrollHeight - el.clientHeight - STICK_BOTTOM_THRESHOLD;
}
const stickToBottom = ViewPlugin.fromClass(
  class {
    wasAtBottom = true;
    pending: number | null = null;
    constructor(view: EditorView) {
      this.wasAtBottom = isScrolledToBottom(view);
    }
    update(update: import("@codemirror/view").ViewUpdate) {
      // A re-pin is already in flight: leave wasAtBottom alone so the stream
      // keeps following — the transient mid-growth scroll position would read
      // as "not at bottom" and break the follow on the next token.
      if (this.pending !== null) return;
      if (update.docChanged && this.wasAtBottom) {
        // Re-pin on the next frame, after CM6's measure loop settles. Coalesce
        // rapid tokens (each schedules a dispatch) into one rAF via the guard.
        const view = update.view;
        this.pending = requestAnimationFrame(() => {
          this.pending = null;
          const el = view.scrollDOM;
          el.scrollTop = el.scrollHeight;
          // Re-read after re-pinning so wasAtBottom reflects the pinned state,
          // not the mid-growth position seen synchronously below.
          this.wasAtBottom = isScrolledToBottom(view);
        });
        return;
      }
      // Stash the post-update position for the next change's "was at bottom".
      this.wasAtBottom = isScrolledToBottom(update.view);
    }
    destroy() {
      // Cancel a pending re-pin so it doesn't fire on a destroyed view's
      // scrollDOM after a tab switch or editor teardown.
      if (this.pending !== null) cancelAnimationFrame(this.pending);
    }
  },
);

function buildVoiceDecorations(view: EditorView): DecorationSet {
  // Non-throwing field read (field(x, false) → undefined if absent): after a
  // Vite HMR swap, voiceField re-evaluates to a new identity while a live view
  // still holds state built from the prior identity. The throwing form would
  // crash the editor on the next decoration rebuild; the guarded form renders
  // nothing for one frame until the view remounts under the new extensions.
  const runs = view.state.field(voiceField, false);
  if (!runs) return Decoration.none;
  const decos: Range<Decoration>[] = [];
  let pos = 0;
  for (const r of runs) {
    const len = [...r.text].length;
    if (len > 0) {
      // Shared resolution: known keychain keys get their generative identity
      // (font + fg/bg); unknown pubkeys (sampled/federated text) fall back to
      // the 6-color hash bucket. Since Preview and Markdown are the same
      // CodeMirror doc (modeFacet just switches its decorations), a voice
      // renders the same color in both modes automatically.
      const { className, style } = voiceSpanStyle(r.voice);
      decos.push(
        Decoration.mark(
          style ? { class: className, attributes: { style } } : { class: className },
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
    const len = [...r.text].length;
    if (len <= 0) continue;
    if (offset < pos + len) return r.voice;
    pos += len;
  }
  return "";
}

const editorTheme = EditorView.theme({
  "&": {
    flex: "1",
    backgroundColor: "var(--surface-raised)",
    color: "var(--ink)",
    fontSize: "1.1rem",
    height: "100%",
  },
  ".cm-scroller": {
    fontFamily: "var(--font-body)",
    lineHeight: "1.75",
    padding: "2.25rem clamp(0.3125rem, 1.25vw, 1.25rem)",
    overflowY: "auto",
  },
  ".cm-content": { caretColor: "var(--accent)" },
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
  onUserEdit: (runs: Run[]) => void,
  voice: string,
  mode: Mode,
  voiceAttribution: boolean,
  onSelection: (sel: { from: number; to: number } | null) => void,
  selectedNodeId: string,
  onSelectSpan: (nodeId: string, phrase: string) => void,
  onCopySpan: (nodeId: string, phrase: string) => void,
  readOnly: boolean,
  onReject: () => void,
): Extension[] {
  const liftRuns = EditorView.updateListener.of((update) => {
    for (const tr of update.transactions) {
      if (tr.docChanged && !tr.effects.some((e) => e.is(setRunsEffect))) {
        // Non-throwing field read — see buildVoiceDecorations for the HMR
        // rationale. If the field is absent (stale view post-HMR), skip the
        // lift rather than throwing; the next legitimate render resyncs.
        const runs = update.state.field(voiceField, false);
        if (runs) onUserEdit(runs);
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
    keymap.of([
      ...defaultKeymap,
      ...historyKeymap,
    ]),
    // Per-panel pen voice, reconfigurable via voiceCompartment (see FileEditor).
    voiceCompartment.of(voiceFacet.of(voice)),
    voiceField,
    // Voice color decorations, gated by the global voice-attribution toggle.
    // Reconfigured live via voiceAttributionCompartment (see FileEditor) when
    // the user flips the rail toggle — drops to [] (no coloring) or restores
    // voiceDecorations without remounting the editor.
    voiceAttributionCompartment.of(voiceAttribution ? voiceDecorations : []),
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
    // Bracket layer (minting authoring surface + rewrite protection — the
    // single protection marker per trace-provenance.md "Rewrite protection").
    // Decoration marks `[[ ]]` / `(( ))` in Markdown mode, or collapses them
    // into atomic chip widgets in Preview mode (modeFacet); bracketProtect
    // spares fully-contained brackets from a delete in either mode. Wrapping
    // a selection is opt-in via the selection menu's bracket action or
    // Cmd/Ctrl+S over a selection (App's wrapSelection path), not a selection
    // side effect.
    ...bracketExtensions(),
    // Markdown preview pass — inert in Markdown mode (returns Decoration.none),
    // active only in Preview, where it hides/stylizes standard markdown symbols
    // (#, **, `, -, >, ~~, fences). Reads modeFacet so a mode switch
    // redecorates at once; mirrors the bracket layer's rebuild triggers.
    ...markdownPreviewExtensions(),
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
  selectedNodeId,
  scrollTarget,
  readOnly,
  onSelectSpan,
  onCopySpan,
}: {
  file: FileState;
  /** The file's path — the editor's identity for doc-sync. A tab switch changes
   *  `path` even when the new file's runs equal the editor's current voiceField
   *  (e.g. two files with identical content), so the swap is driven by path, not
   *  run equality — otherwise the body would stay on the old file while the
   *  sidebar (tracking the active tab) moved on. */
  path: string;
  onEdit: (runs: Run[]) => void;
  onView?: (view: EditorView | null) => void;
  /** Notified with the editor's selection range (or null when empty), so the
   *  selection menu can anchor to the head and ops can scope to the selection. */
  onSelection?: (sel: { from: number; to: number } | null) => void;
  /** The pen voice (pubkey) for this panel. "" → fall back to global active. */
  voice: string;
  /** Which surface this editor renders as — see modeFacet in brackets.ts. */
  mode: Mode;
  /** Whether per-voice text color is shown. Global; reconfigured live. */
  voiceAttribution: boolean;
  /** nodeId of the selected minted span, or "" when none — rings the
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
  /** Clicking a citation chip selects that minted span as the active trace. */
  onSelectSpan: (nodeId: string, phrase: string) => void;
  /** Clicking a citation chip's copy button curates the span (clipboard +
   *  palette append). Mirrors onSelectSpan's ref-indirection so the chip's
   *  copy widget stays current without rebuilding the editor. */
  onCopySpan: (nodeId: string, phrase: string) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);

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

  // Reject flash: a rejected keystroke (read-only replay gate) pulses the
  // editor red for 0.9s. Rapid rejects keep the pulse lit (the timer re-arms)
  // rather than thrashing the animation per key. useRef-stable so the build-
  // time closure in buildExtensions calls through it without rebuilding.
  const [rejecting, setRejecting] = useState(false);
  const rejectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const triggerRejectRef = useRef<() => void>(() => {});
  triggerRejectRef.current = () => {
    setRejecting(true);
    if (rejectTimerRef.current) clearTimeout(rejectTimerRef.current);
    rejectTimerRef.current = setTimeout(() => setRejecting(false), 900);
  };
  useEffect(() => {
    return () => {
      if (rejectTimerRef.current) clearTimeout(rejectTimerRef.current);
    };
  }, []);

  const extensionsRef = useRef<Extension[] | null>(null);
  if (extensionsRef.current === null) {
    extensionsRef.current = buildExtensions(
      (runs) => onEditRef.current(runs),
      voice,
      mode,
      voiceAttribution,
      (has) => onSelectionRef.current?.(has),
      selectedNodeId,
      (nodeId, phrase) => onSelectSpanRef.current(nodeId, phrase),
      (nodeId, phrase) => onCopySpanRef.current(nodeId, phrase),
      readOnly,
      () => triggerRejectRef.current(),
    );
  }

  // The path whose runs the editor currently holds. Seeded at mount and updated
  // on every doc swap below — drives the file-switch branch of the sync effect.
  const pathRef = useRef<string>(path);

  // Mount once.
  useEffect(() => {
    if (!hostRef.current) return;
    pathRef.current = path;
    const view = new EditorView({
      state: EditorState.create({
        doc: flatten(file.runs ?? []),
        extensions: extensionsRef.current!,
      }),
      parent: hostRef.current,
    });
    viewRef.current = view;
    onView?.(view);
    return () => {
      view.destroy();
      viewRef.current = null;
      onView?.(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Switching the manual (pen) key reconfigures the voice facet live —
  // subsequent keystrokes (and streamed LLM deltas) are attributed to the new
  // voice without remounting the editor. useLayoutEffect (not useEffect) so
  // the facet is updated synchronously during commit, before the browser
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

  // Moving the active-trace selection onto/off a minted span re-rings the
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
  useEffect(() => {
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
        effects: setRunsEffect.of(file.runs ?? []),
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
        effects: setRunsEffect.of(file.runs ?? []),
      });
      return;
    }
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: newText },
      effects: setRunsEffect.of(file.runs ?? []),
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

  return (
    <div
      ref={hostRef}
      className={"editor-host" + (rejecting ? " editor-host-reject" : "")}
    />
  );
}

// --- citation chips ----------------------------------------------------
//
// The named list of traces this one composes — every `q` edge on its current
// head (bracket quotes, the Reply source; tagged zines are filtered out and
// shown in the tag section via `TaggedTraces`), resolved to a name by
// `resolveNodeName`. A citation chip is a pinned reference to another trace,
// labeled by that trace's own name (a file's basename, or for a nameless
// minted span its phrase). Clicking opens the cited trace's Seals modal
// pinned to the exact node cited. This subsumes the old single "replying to
// ↑" chip: a Reply is just one more chip here, labeled with the source file's
// name.
// --- inbound tracker (the inverse tag section) -------------------------
//
// The traces that fork this one, tag it, or cite it (spec §3.8 forks, §6 tags,
// §3.3 cites) — the INBOUND direction, the inverse of CitationChips/
// TaggedTraces (which show what THIS trace composes). Each entry is a read-only
// click-to-open chip; the actions (Incorporate/Reconcile) stay in the workspace
// merge-banner, so a fork that's also an actionable candidate appears in both.
//
// Three grouped clusters, left to right: forks (GitFork), tagged-by (Tag),
// cited-by (Quote). Chips are muted/secondary so the outbound (what I tag) vs
// inbound (what tags me) split reads at a glance. Hidden entirely when there's
// no inbound traffic, preserving the existing layout.
function InboundRow({
  inbound,
  onOpen,
}: {
  inbound: TraceInbound[];
  onOpen: (nodeId: string) => void;
}) {
  // Expanded by default — it's a tracker; the user wants to see them. Collapsed
  // shows just the count summary. Survives across this Panel's lifetime, not
  // across files (a fresh mount resets to expanded).
  const [expanded, setExpanded] = useState(true);
  if (inbound.length === 0) return null;

  const forks = inbound.filter((e) => e.kind === "fork");
  const tags = inbound.filter((e) => e.kind === "tag");
  const cites = inbound.filter((e) => e.kind === "cite");

  // A short pubkey prefix for the fallback label when no name resolved.
  const fallback = (e: TraceInbound) => e.name ?? `${e.ownerPubkey.slice(0, 8)}…`;
  // Pluralize a count label, omitting zero-count groups from the summary.
  const sum = (n: number, label: string) => (n > 0 ? `${n} ${label}${n === 1 ? "" : "s"}` : "");
  const summary = [sum(forks.length, "fork"), sum(tags.length, "tag"), sum(cites.length, "cite")]
    .filter(Boolean)
    .join(" · ");

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
            key={`${kind}:${e.sourceEventId}:${e.fromNodeId}`}
            type="button"
            className="panel-inbound-chip"
            title={
              kind === "fork"
                ? `forked from ${e.fromNodeId.slice(0, 8)}…\nby ${e.ownerPubkey.slice(0, 12)}…\ntrace ${e.sourceEventId}`
                : `${kind === "tag" ? "tagged by" : "cited by"} ${e.ownerPubkey.slice(0, 12)}…\ntrace ${e.sourceEventId}`
            }
            onMouseDown={(ev) => {
              ev.stopPropagation();
              onOpen(e.sourceEventId);
            }}
          >
            <span className="panel-inbound-chip-name">{fallback(e)}</span>
          </button>
        ))}
      </span>
    );
  };

  return (
    <div className="panel-inbound-row" aria-label="Inbound — forks, tags, citations">
      <button
        type="button"
        className="panel-inbound-summary"
        title={expanded ? "Collapse" : "Expand"}
        onMouseDown={(e) => {
          e.stopPropagation();
          setExpanded((v) => !v);
        }}
      >
        <CornerDownRight size={11} aria-hidden="true" />
        <span>{summary}</span>
      </button>
      {expanded && (
        <>
          {renderGroup("fork", GitFork, "forked by", forks)}
          {renderGroup("tag", TagIcon, "tagged by", tags)}
          {renderGroup("cite", Quote, "cited by", cites)}
        </>
      )}
    </div>
  );
}

function CitationChips({
  chips,
  onOpen,
}: {
  chips: CitationChip[];
  onOpen: (nodeId: string) => void;
}) {
  if (chips.length === 0) return null;
  return (
    <div className="panel-cites" aria-label="Cited traces">
      {chips.map((c) => (
        <button
          key={c.nodeId}
          type="button"
          className={"panel-cite" + (c.kind === "span" ? " panel-cite-span" : "")}
          title={`trace ${c.nodeId}\n${c.kind === "file" ? "file" : "minted span"}`}
          onMouseDown={(e) => {
            e.stopPropagation();
            onOpen(c.nodeId);
          }}
        >
          <Layers3 size={11} aria-hidden="true" />
          <span className="panel-cite-name">{c.name}</span>
        </button>
      ))}
    </div>
  );
}

// --- tagged traces (the tag section) -----------------------------------
//
// The traces tagged onto this one — the `tag-add` subset of the head's `q`
// edges (those not also quoted in the body), each reified as a closable chip.
// Per the model, a "tag" names a trace (a sealed `q`-target — a published zine
// OR an unpublished local savepoint), never a bare string: this is the tag
// section, and it holds only traces. The free-floating `#text` authoring
// surface is gone from the panel; `FileState.tags` / `#t` Nostr emission stay
// intact behind the scenes for generic-client discoverability. Each chip opens
// the tagged trace's Seals modal on name-click and untags on the `×` — the
// first UI affordance to *remove* a tagged trace (editTaggedTraces always
// accepted a full list; nothing called it with a filtered one before).
function TaggedTraces({
  chips,
  onOpen,
  onRemove,
}: {
  chips: CitationChip[];
  onOpen: (nodeId: string) => void;
  onRemove: (nodeId: string) => void;
}) {
  if (chips.length === 0) return null;
  return (
    <div className="panel-tagged" aria-label="Tagged traces">
      {chips.map((c) => (
        <span
          key={c.nodeId}
          className={"panel-tag-trace" + (c.kind === "span" ? " panel-tag-trace-span" : "")}
          title={`trace ${c.nodeId}\n${c.kind === "file" ? "file" : "minted span"}`}
        >
          <button
            type="button"
            className="panel-tag-trace-name"
            onMouseDown={(e) => {
              e.stopPropagation();
              onOpen(c.nodeId);
            }}
          >
            <Layers3 size={11} aria-hidden="true" />
            <span className="panel-tag-trace-label">{c.name}</span>
          </button>
          <button
            type="button"
            className="panel-tag-trace-remove"
            aria-label={`Untag ${c.name}`}
            onMouseDown={(e) => {
              e.stopPropagation();
              onRemove(c.nodeId);
            }}
          >
            ×
          </button>
        </span>
      ))}
    </div>
  );
}

/** One candidate sibling trace for the tag-trace picker: its path (for the
 *  autocomplete label) and its current head nodeId (the `q`-edge target). */
interface TraceCandidate {
  path: string;
  nodeId: string;
}

// --- tag-trace picker --------------------------------------------------
//
// The "tag a trace by name" affordance — the protocol's `tag-add` authoring
// surface (spec §Tagging vs. bracketing). A small `+ trace` input that
// autocompletes over the current folder's file basenames; selecting one adds
// its head nodeId to FileState.taggedTraces, which the debounce picks up and
// seals as a `q` edge with a `tag-add` delta (no body change). Cross-folder or
// zine-tagging stays the Tag Browser's job; this is the in-folder fast path.
//
// Disabled for read-only/foreign folders (no editTaggedTraces wiring) and for
// files that haven't sealed yet (no nodeId to cite). Candidates with no nodeId
// are filtered out — you can't tag what hasn't been sealed.
function TagTracePicker({
  candidates,
  alreadyTagged,
  disabled,
  onPick,
}: {
  candidates: TraceCandidate[];
  alreadyTagged: string[];
  disabled: boolean;
  onPick: (nodeId: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const [open, setOpen] = useState(false);
  const trimmed = draft.trim().toLowerCase();
  const tagged = new Set(alreadyTagged);
  const matches = trimmed
    ? candidates.filter(
        (c) =>
          c.path.toLowerCase().includes(trimmed) &&
          !tagged.has(c.nodeId) &&
          // Don't suggest the basename of a path identical to the draft — the
          // picker is for tagging *other* traces; typing the full current name
          // is the common miscue, so we still show it but the caller dedupes.
          true,
      )
    : [];
  if (disabled) return null;

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
        title="Tag another trace into this one"
        onClick={() => setOpen((v) => !v)}
      >
        <Plus size={11} aria-hidden="true" />
        trace
      </button>
      {open && (
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

// --- voices bar --------------------------------------------------------
//
// The bottom strip of each panel: one chip per keychain voice (pubkey). The
// selected chip is the panel's "pen" — the voice new typed text is attributed
// to (per-panel, see voiceFacet). Each chip's ▾ menu offers four LLM ops
// (Extend/Settle/Stir/Reply) that run as that voice.

type SummonStatus = { state: "idle" | "running" | "done" | "error"; msg?: string };

const VOICE_OPS: { op: OpKind; label: string; title: string; cls: string }[] = [
  { op: "reply", label: "Reply", title: "Write a response into a new doc in the other pane, citing traces", cls: "op-reply" },
  { op: "extend", label: "Extend", title: "Append an AI continuation to this file", cls: "op-extend" },
  { op: "settle", label: "Settle", title: "Condense loose prose; keep brackets. Repeated rounds → only brackets", cls: "op-settle" },
  { op: "stir", label: "Stir", title: "Reinvent loose prose, run (( commands )), preserve [[ anchors ]]", cls: "op-stir" },
];

// Deliver ops (Save / zine) live in the same voice menu but are not LLM ops —
// they seal the trace, signed as the clicked voice. Split out so the menu
// doesn't provider-gate them (you can save with no model configured). Save is
// the deliberate checkpoint (spec §Save/seal triggers: "Client-facing 'save',
// framed to read as deliberate, not autosave") under a chosen voice's key.
// zine is reserved for the real publish+sign path (see open work below); for
// now both route through the same seal, but the buttons are distinct so the
// vocabulary stays honest.
const VOICE_DELIVER: { op: "save" | "zine"; label: string; title: string; cls: string }[] = [
  { op: "zine", label: "Send", title: "Sign and broadcast this trace under this voice's key", cls: "op-send" },
  { op: "save", label: "Save", title: "Seal this trace as a deliberate checkpoint, signed as this voice", cls: "op-save" },
];


// --- top bar -----------------------------------------------------------
//
// The single always-visible chrome at the bottom of the press. Two rows in a
// shared column grid — identity left, actions, then model + status right:
//   label  | key | a1 a2 a3 a4 | model | tokens | error | stop
//   AUTHOR | pen | Save SEND   |  —    |  —     |  —    |  —
//   MODEL  | inj | Ext Set Sti Rep | model▾ | 1.2k | err | Stop?
// Four equal action tracks; AUTHOR uses the first two at normal width.
// Ops gate on the outlined target.
function TopBar({
  keys,
  penKeyId,
  injectKeyId,
  onChoosePenKey,
  onChooseInjectKey,
  providers,
  onSelectProvider,
  selection,
  opRunning,
  onOp,
  onStop,
  opStatus,
  tokenEstimate,
}: {
  keys: KeyEntry[];
  /** The pen (typing + Save/send) voice's key id. */
  penKeyId: string | null;
  /** The inject (LLM ops) voice's key id. */
  injectKeyId: string | null;
  onChoosePenKey: (id: string) => void;
  onChooseInjectKey: (id: string) => void;
  /** Configured providers for the model select (automatic-side mode cell). */
  providers: ProviderConfig[];
  /** Pin which provider LLM ops run against (per inject voice). */
  onSelectProvider: (pubkey: string, providerId: string) => void;
  /** The currently-outlined trace, or null. Drives which actions are live. */
  selection: SelectionRef | null;
  /** Whether an op is currently running on the target panel. */
  opRunning: boolean;
  /** Run an op against the op-target panel. */
  onOp: (op: OpKind) => void;
  /** Stop the in-flight op on the target panel. */
  onStop: () => void;
  /** Status of the op-target panel, for the action row's stop/error. */
  opStatus: SummonStatus;
  /** Approximate prompt token count for an op on the target file, or null when
   *  no folder/file is active. Shown beside the action buttons. */
  tokenEstimate: number | null;
}) {
  // --- ACTIONS gating ---------------------------------------------------
  const kind = selection?.kind;
  const allowTextOps = kind === "file";
  const allowReply = kind === "file" || kind === "span";
  const allowDeliver = kind === "file" || kind === "folder";
  const hasProviders = providers.length > 0;
  // Inject voice's pinned provider for the model mode cell. When unset, the
  // first configured provider is the effective choice — same fallback
  // resolveOpProvider uses, so the dropdown matches what ops run.
  const injectPubkey = (keys.find((k) => k.id === injectKeyId) ?? null)?.pubkey ?? "";
  const injectProviderId = injectPubkey ? getVoiceProvider(injectPubkey) ?? "" : "";
  const resolvedProviderId =
    providers.find((p) => p.id === injectProviderId)?.id ?? providers[0]?.id ?? "";

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
        className="topbar-select topbar-key-select"
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
        className="topbar-select topbar-model-select"
        value={resolvedProviderId}
        onChange={(e) => injectPubkey && onSelectProvider(injectPubkey, e.target.value)}
        title="Model for automatic ops"
        aria-label="Model for automatic ops"
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

  // Columns: label | key | 4 action tracks | model | tokens | error | stop.
  // AUTHOR Save/SEND occupy the first two tracks at normal width; MODEL ops
  // fill all four.
  return (
    <div className="topbar">
      <div className="topbar-group">
        <span className="topbar-label">AUTHOR:</span>
        <KeySelect
          selectedId={penKeyId}
          onSelect={onChoosePenKey}
          ariaLabel="Author voice"
        />
        {VOICE_DELIVER.map((v) => (
          <button
            key={v.op}
            type="button"
            className={`topbar-action ${v.cls}`}
            disabled={opRunning || !allowDeliver}
            title={v.title}
            onClick={() => onOp(v.op)}
          >
            {v.label}
          </button>
        ))}
        <span className="topbar-slot" aria-hidden="true" />
        <span className="topbar-slot" aria-hidden="true" />
        <span className="topbar-slot" aria-hidden="true" />
        <span className="topbar-slot" aria-hidden="true" />
        <span className="topbar-slot" aria-hidden="true" />
        <span className="topbar-slot" aria-hidden="true" />
      </div>

      <div className="topbar-group">
        <span className="topbar-label">MODEL:</span>
        <KeySelect
          selectedId={injectKeyId}
          onSelect={onChooseInjectKey}
          ariaLabel="Automatic voice"
        />
        {VOICE_OPS.map((v) => {
          const enabled =
            !opRunning &&
            hasProviders &&
            (v.op === "reply" ? allowReply : allowTextOps);
          return (
            <button
              key={v.op}
              type="button"
              className={`topbar-action ${v.cls}`}
              disabled={!enabled}
              title={v.title}
              onClick={() => onOp(v.op)}
            >
              {v.label}
            </button>
          );
        })}
        <ModelSelect />
        {tokenEstimate != null ? (
          <span
            className="topbar-token-count"
            title="Approximate prompt size for an op on the selected file"
          >
            {formatTokens(tokenEstimate)}
          </span>
        ) : (
          <span className="topbar-slot" aria-hidden="true" />
        )}
        {opStatus.state === "error" && opStatus.msg ? (
          <span className="topbar-action-error" title={opStatus.msg}>
            {opStatus.msg}
          </span>
        ) : (
          <span className="topbar-slot" aria-hidden="true" />
        )}
        {opRunning ? (
          <button type="button" className="topbar-action stop" onClick={onStop}>
            Stop
          </button>
        ) : (
          <span className="topbar-slot" aria-hidden="true" />
        )}
      </div>
    </div>
  );
}

function Panel({
  panelIdx,
  tabs,
  activePath,
  file,
  active,
  collapsed,
  onFocusPanel,
  onSelectTab,
  onCloseTab,
  onContextMenuTab,
  onEdit,
  onUntagTrace,
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
  onSelectSpan,
  onCopySpan,
  citations,
  taggedChips,
  inbound,
  onOpenCitation,
  traceCandidates,
  pickerDisabled,
  onTagTrace,
  tagDropAccept,
  onTagTraceByPath,
  onOpenSeals,
}: {
  panelIdx: number;
  tabs: string[];
  activePath: string;
  file?: FileState;
  active: boolean;
  /** The sidebar's collapsed-folder set, so a folder tab's icon can mirror the
   *  tree (open vs closed). Optional — omitted/empty reads as "all open". */
  collapsed?: Set<string>;
  onFocusPanel: () => void;
  onSelectTab: (path: string) => void;
  onCloseTab: (path: string) => void;
  /** Right-click on a tab in this panel opens the tab context menu. */
  onContextMenuTab: (e: React.MouseEvent, path: string) => void;
  onEdit: (runs: Run[]) => void;
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
  /** nodeId of the selected minted span, or "" when none — rings the matching
   *  `[[ span ]]` inside this panel's editor. */
  selectedNodeId: string;
  /** A doc range to scroll this panel's editor to — driven by folder replay so
   *  the action that produced the current step's deltas is brought into view.
   *  Pass null/undefined for panels not currently replaying. */
  scrollTarget?: { from: number; to: number } | null;
  /** Read-only while replay is frozen on a historical step or mid-playback —
   *  passed through to the editor's readOnlyCompartment. */
  readOnly: boolean;
  /** Clicking a citation chip in this editor selects that minted span. */
  onSelectSpan: (nodeId: string, phrase: string) => void;
  /** Clicking a citation chip's copy button curates the span (clipboard +
   *  palette append). */
  onCopySpan: (nodeId: string, phrase: string) => void;
  /** The named traces this file composes — every `q` edge on its current head
   *  (bracket quotes + Reply source + tagged zines), resolved to chips by
   *  `resolveNodeName`. Empty/absent while still resolving or for a leaf. The
   *  tagged-trace subset is rendered separately in the tag section, so this
   *  list is filtered at the render site to drop those ids. */
  citations: CitationChip[];
  /** The tagged-trace chips — `file.taggedTraces` resolved via
   *  `resolveNodeName`, keyed on the tagged id set (not the head node) so a
   *  freshly tagged trace shows instantly, before the debounce seals a new
   *  head. Rendered in the tag section. */
  taggedChips: CitationChip[];
  /** The inbound tracker — forks of this trace, traces that tag it, and traces
   *  that cite it (spec §3.8/§6/§3.3), the inverse of the outbound chips above.
   *  Read-only click-to-open chips rendered in a second tag-section line. Empty
   *  when there is no inbound traffic (the band is hidden in that case). */
  inbound: TraceInbound[];
  /** Clicking a cited-trace chip opens that trace's Seals modal pinned to the
   *  cited node. */
  onOpenCitation: (nodeId: string) => void;
  /** Sibling traces in the current folder, available as tag-trace picker
   *  candidates (path + current head nodeId). Built from `files` by the App. */
  traceCandidates: TraceCandidate[];
  /** Whether the tag-trace picker is disabled (foreign/read-only folder, or the
   *  active file hasn't sealed yet). */
  pickerDisabled: boolean;
  /** Add a sibling trace's nodeId to the active file's taggedTraces (the
   *  protocol's `tag-add`). */
  onTagTrace: (nodeId: string) => void;
  /** Remove a tagged trace's nodeId from the active file's taggedTraces
   *  (untag). Counterpart to `onTagTrace`; the `×` on a tagged-trace chip. */
  onUntagTrace: (nodeId: string) => void;
  /** Drag-from-tree → tag: gate whether a dragged tree file (by path) may be
   *  dropped onto this panel's tag strip. Mirrors the picker's `disabled`
   *  gate (foreign folder, folder tab, unsealed target) and additionally
   *  rejects self-drops, unsealed sources, and already-tagged ids. */
  tagDropAccept: (srcPath: string) => boolean;
  /** Drag-from-tree → tag: resolve the dragged tree file's path to its head
   *  nodeId and add it to the active file's taggedTraces (same `tag-add`
   *  path as the picker). */
  onTagTraceByPath: (srcPath: string) => void;
  /** Clicking the "Seals" button (file tabs only). */
  onOpenSeals?: () => void;
}) {
  // Cited traces minus the tagged subset: tagged traces render in the tag
  // section above, so the CitationChips strip shows only what the body composes
  // (bracket quotes + the Reply source). `taggedChips` carries the resolved
  // ids; matching by nodeId keeps this robust to resolution ordering.
  const taggedIds = new Set(taggedChips.map((c) => c.nodeId));
  const citedChips = citations.filter((c) => !taggedIds.has(c.nodeId));
  // Hovering the bare space past the last tab → "drop at end of this list".
  const listIsEndTarget =
    !!draggingTab &&
    dropTargetTab?.panel === panelIdx &&
    dropTargetTab.path === null;

  // Drag-from-tree → tag: the tag strip is a drop target for tree file rows
  // (which carry `text/zine-path` + a plain `zine-path:` fallback). This is a
  // third drag gesture, distinct from the tree's move-into-folder dnd and the
  // panel's tab-reorder dnd — we only react to the zine-path payload, so the
  // systems can't interfere. `tagDropActive` drives the highlight while a
  // valid source hovers the strip.
  const [tagDropActive, setTagDropActive] = useState(false);
  function tagStripDragOver(e: React.DragEvent) {
    if (!isZinePathDrag(e.dataTransfer)) return; // tab/other drag — leave it alone
    const path = zinePathFromDataTransfer(e.dataTransfer);
    // getData returns "" during dragover in some browsers until drop, so
    // also accept an empty payload as "a tree drag is in progress" and let
    // tagDropAccept make the final call on drop.
    if (path && !tagDropAccept(path)) return;
    e.preventDefault();
    // Must be one of effectAllowed ("copyMove") — "link" is rejected and the
    // drop dies on WebKit even after preventDefault.
    e.dataTransfer.dropEffect = "copy";
    setTagDropActive(true);
  }
  function tagStripDrop(e: React.DragEvent) {
    const path = zinePathFromDataTransfer(e.dataTransfer);
    setTagDropActive(false);
    if (!path) return;
    if (!tagDropAccept(path)) return;
    e.preventDefault();
    e.stopPropagation();
    onTagTraceByPath(path);
  }

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
        (file ? " panel-mode-" + mode : "")
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
            // focused panel's front tab is the active trace — so the gold
            // accent (.tab.trace-active) is mutually exclusive across the
            // whole workspace, never on a background panel.
            const isTraceActive = isActive && active;
            const isDragging = draggingTab?.path === p && draggingTab.fromPanel === panelIdx;
            const isBeforeTarget =
              dropTargetTab?.panel === panelIdx && dropTargetTab.path === p;
            return (
              <div
                key={p}
                className={
                  "tab" +
                  (isActive ? " active" : "") +
                  (isTraceActive ? " trace-active" : "") +
                  (isDragging ? " tab-dragging" : "") +
                  (isBeforeTarget ? " tab-drop-before" : "")
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
                  {/* Status icon to the left of the title. A folder tab's icon
                      mirrors the tree state of that folder: open (FolderOpen)
                      when expanded, closed (Folder) when collapsed. A file tab
                      shows a file glyph. Color is gold only on the active
                      trace (.tab.trace-active in CSS), neutral otherwise. */}
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
      {file && (
        <div
          className={"panel-tags-row" + (tagDropActive ? " tag-drop-active" : "")}
          onDragOver={tagStripDragOver}
          onDragLeave={() => setTagDropActive(false)}
          onDrop={tagStripDrop}
        >
          {/* Tagged traces — the tag section. A "tag" names a trace (a sealed
              `q`-target: a published zine or an unpublished local savepoint),
              never a bare string, so this is what occupies the tag position.
              Each chip opens the tagged trace's Seals modal; the `×` untags
              (drops the id from FileState.taggedTraces). The free-floating
              `#text` authoring surface is intentionally gone from the panel. */}
          <TaggedTraces
            chips={taggedChips}
            onOpen={(nodeId) => {
              onFocusPanel();
              onOpenCitation(nodeId);
            }}
            onRemove={(nodeId) => {
              onFocusPanel();
              onUntagTrace(nodeId);
            }}
          />
          {/* Cited traces — the `q` edges this file *composes*: body bracket
              quotes and the Reply source. Tagged traces are rendered above
              (in the tag section), so they're filtered out of this list to
              avoid double-showing. Clicking opens the cited trace's Seals modal
              pinned to the cited node. */}
          <CitationChips
            chips={citedChips}
            onOpen={(nodeId) => {
              onFocusPanel();
              onOpenCitation(nodeId);
            }}
          />
          {/* Tag a trace by name (the protocol's `tag-add`) — autocomplete over
              the current folder's files; selecting one cites its head as a
              `q` edge with no body bracket. Disabled on foreign/read-only
              folders and before the active file's first seal. */}
          <TagTracePicker
            candidates={traceCandidates}
            alreadyTagged={file?.taggedTraces ?? []}
            disabled={pickerDisabled}
            onPick={onTagTrace}
          />
          {/* Preview / Markdown surface toggle. Lives in the tags row (below the
              tab bar) and acts on the active tab — each file remembers which
              surface it was left in, so switching tabs restores the surface you
              chose for that file. Pinned to the row's right edge. */}
          {!draggingTab && (
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
                className="tab-bar-mode-btn"
                title="View seal history"
                onMouseDown={(e) => {
                  e.stopPropagation();
                  onFocusPanel();
                  onOpenSeals?.();
                }}
              >
                <History size={13} aria-hidden="true" />
              </button>
            </div>
          )}
        </div>
      )}
      {file && (
        <InboundRow
          inbound={inbound}
          onOpen={(nodeId) => {
            onFocusPanel();
            onOpenCitation(nodeId);
          }}
        />
      )}
      {file?.eventMeta && <EventMetaBar meta={file.eventMeta} />}
      {file ? (
        // .panel-body positions the one CodeMirror surface that now serves
        // both modes — LLM ops, palette citations, and Cmd+S seal all hold
        // its view ref regardless of which mode is active. Preview vs
        // Markdown is purely a decoration/CSS switch (see FileEditor/modeFacet),
        // not a second mounted component.
        <div className="panel-body">
          <FileEditor
            file={file}
            path={activePath}
            onEdit={onEdit}
            onView={onView}
            onSelection={onSelection}
            voice={voice}
            mode={mode}
            voiceAttribution={voiceAttribution}
            selectedNodeId={selectedNodeId}
            scrollTarget={scrollTarget}
            readOnly={readOnly}
            onSelectSpan={onSelectSpan}
            onCopySpan={onCopySpan}
          />
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
  { view: "editor", Icon: FileText, label: "Press" },
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
  { view: "relays", Icon: Radio, label: "Relays" },
  { view: "friends", Icon: Users, label: "Friends" },
  { view: "models", Icon: Cpu, label: "Models" },
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
  onResetWorkspace,
  showOperator,
}: {
  activeView: View;
  onSelect: (v: View) => void;
  expanded: boolean;
  onToggleExpanded: () => void;
  theme: Theme;
  onToggleTheme: () => void;
  /** Web-only: open the reset-workspace confirm. Absent on desktop. */
  onResetWorkspace?: () => void;
  /** Web-only: show the operator entry when the current voice is operator or
   *  curation team. Driven by operator-store.isStaff(). */
  showOperator?: boolean;
}) {
  const mode = resolvedMode(theme);
  return (
    <nav className={"nav-rail" + (expanded ? " expanded" : "")} aria-label="Views">
      <div className="rail-brand">
        <button
          type="button"
          className={"rail-brand-icon" + (activeView === "about" ? " active" : "")}
          aria-label="About"
          aria-current={activeView === "about" ? "page" : undefined}
          title="About"
          onClick={() => onSelect("about")}
        >
          <span className="rail-brand-emoji" aria-hidden="true">{EYE_SPEECH}</span>
        </button>
        {expanded && <span className="rail-brand-wordmark">zine</span>}
      </div>
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
              {onResetWorkspace && (
                <button
                  type="button"
                  className="rail-item"
                  aria-label="Reset workspace"
                  title="Reset workspace"
                  onClick={onResetWorkspace}
                >
                  <RotateCcw size={20} strokeWidth={1.75} />
                  {expanded && <span className="rail-item-label">Reset</span>}
                </button>
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
  about: { title: "About", blurb: "What zine is and how it fits together." },
  listings: { title: "Stacks", blurb: "An editorial selection of zines, arranged into named sections." },
  stats: { title: "Times", blurb: "Zines on this relay, ranked by metric per unit time." },
  globe: { title: "Spaces", blurb: "Zines pinned to geohashes, rendered at their level." },
  keys: { title: "Keys", blurb: "Nostr keypairs (voices) with a generative font and color." },
  relays: { title: "Relays", blurb: "Read and write relay configuration." },
  friends: { title: "Friends", blurb: "Who can reach your relay. Activate friend mode for NIP-42 AUTH + Tor onion reachability." },
  models: { title: "Models", blurb: "LLM provider catalog. Ops pick a model under Press (opposite AUTHOR)." },
  download: { title: "Download", blurb: "Get the desktop app." },
  operator: { title: "Operator", blurb: "Relay operator: curation team and moderation." },
};

function ViewPlaceholder({ view }: { view: Exclude<View, "editor"> }) {
  const meta = VIEW_META[view];
  return (
    <section className="view-placeholder">
      <h1 className="view-placeholder-title">{meta.title}</h1>
      <p className="view-placeholder-blurb">{meta.blurb}</p>
      <p className="view-placeholder-soon">Coming soon</p>
    </section>
  );
}

// --- empty state: no folder attached -----------------------------------
//
// First-run / detached view. The workspace needs a real folder to manage
// (disk is the source of truth), so before one is chosen we prompt for it.
// Offers a one-click default ($HOME/zine) when it exists, plus the full
// native picker.

function EmptyFolderView({
  onChoose,
  defaultPath,
  onUseDefault,
  error,
}: {
  onChoose: () => void;
  defaultPath: string | null;
  onUseDefault: (path: string) => void;
  error: string | null;
}) {
  return (
    <section className="view-placeholder">
      <h1 className="view-placeholder-title">Manage a folder</h1>
      <p className="view-placeholder-blurb">
        zine manages a folder on disk and keeps a provenance record of every
        edit in the local relay. Choose a folder to start writing.
      </p>
      <div className="empty-actions">
        <button type="button" className="empty-primary-btn" onClick={onChoose}>
          Choose folder…
        </button>
        {defaultPath && (
          <button
            type="button"
            className="empty-secondary-btn"
            onClick={() => onUseDefault(defaultPath)}
          >
            Use {defaultPath}
          </button>
        )}
      </div>
      {error && <p className="empty-error">{error}</p>}
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
          <h1 className="view-placeholder-title">This view hit an error</h1>
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
// via workspace.writeFile — which itself seals a kind-4290 node and republishes
// the kind-34290 manifest, so disk and provenance never drift. The diff/state
// bookkeeping lives in workspace.ts; this hook just owns the debounce timer.

function useProvenance(
  folder: AttachedFolder | null,
  files: Record<string, FileState>,
  replayActiveRef: MutableRefObject<boolean>,
) {
  const pendingTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  // Paths with a debounce seal in flight. The external-change rescan reads
  // this to avoid clobbering a file the user is mid-edit on — their in-editor
  // content is newer than disk, so the pending seal must win, not the rescan.
  const pendingPaths = useRef<Set<string>>(new Set());
  // LLM-op seal suppression. Set to true while an op (Extend/Settle/Stir/
  // Reply) is streaming into the editor: the seal effect skips entirely, so
  // a burst of per-token state updates doesn't fire intermediate seals. Each
  // op calls suppressSeal(false) in its finally, and if anything was deferred
  // it seals exactly once then — making the whole AI insert a single delta.
  // Without this, a stream whose quiet gap exceeds the debounce (1500ms —
  // model thinking, network hiccup) publishes a half-finished insert, then
  // more tokens arrive and publish again, and the relay's per-connection
  // rate-limit (khatru's ApplySaneDefaults) trips: "rate-limited: slow down".
  const sealSuppressed = useRef(false);
  const pendingSealPaths = useRef<Set<string>>(new Set());
  // The manual (pen) key's secret, threaded in from App() so the debounced
  // auto-save signs as the pen key — the bottom-left MANUAL control — rather
  // than the hidden active-key default. Read lazily inside scheduleSeal's
  // timeout so a mid-debounce pen switch is honored at fire time. `undefined`
  // means the pen key isn't in the keychain (deleted) and sealNow falls back
  // to its signer default; the LLM-op catch-up seal bypasses this ref and
  // signs with the inject key (passed explicitly via suppressSeal).
  const manualSignerRef = useRef<(() => Uint8Array | undefined)>(() => undefined);
  // Content-stable dedup for sealNow: the last (content, tags) actually sealed
  // per path, so a no-change seal short-circuits before the relay round-trip.
  // The motivating case is the trailing debounce after an LLM op's catch-up
  // seal (see sealNow), but it also collapses any other redundant seal.
  const lastSealedRef = useRef<
    Map<string, { content: string; tags: string[]; taggedTraces: string[] }>
  >(new Map());
  // Seal-on-mount hydration flag: once the boot scan has populated `files`,
  // we don't want the first render's debounce effect to re-publish content
  // that baselineScan already sealed. Cleared by the boot effect in App().
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
    // not trigger intermediate seals (see sealSuppressed). Remember the paths
    // so the op's release can seal exactly once at the end — the AI insert
    // then lands as a single delta instead of N checkpoints. Only dirty paths
    // (content/tags changed since last seal) are buffered — a re-render that
    // touches `files` for an unrelated reason (nodeId reflection, panel swap)
    // must not drag every bystander file into the catch-up seal, or the burst
    // of relay publishes trips the hosted relay's IP rate-limit.
    if (sealSuppressed.current) {
      for (const path of dirtySealPaths(files)) pendingSealPaths.current.add(path);
      return;
    }
    for (const path of dirtySealPaths(files)) {
      scheduleSeal(path, 1500);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files, folder]);

  function scheduleSeal(path: string, ms: number) {
    clearTimeout(pendingTimers.current[path]);
    pendingPaths.current.add(path);
    pendingTimers.current[path] = setTimeout(() => {
      pendingPaths.current.delete(path);
      // Resolve the manual signer at fire time so a pen switch during the
      // debounce window is honored. Mirrors the explicit pre-op seals in
      // extendLLM/settleLLM/stirLLM/replyLLM, which sign the baseline with
      // secretKeyForVoice(penPubkey) — the debounced auto-save now matches.
      void sealNow(path, manualSignerRef.current());
    }, ms);
  }

  /** Paths whose content or tags differ from what was last sealed (or that have
   *  never been sealed this session). The debounce effect and the suppression
   *  buffer both consult this so only genuinely-changed files get sealed — the
   *  root fix for the relay rate-limit fanout where one edit re-sealed every
   *  file in the folder. */
  function dirtySealPaths(currentFiles: Record<string, FileState>): string[] {
    const out: string[] = [];
    for (const [path, file] of Object.entries(currentFiles)) {
      const content = flatten(file.runs);
      const tags = file.tags;
      const taggedTraces = file.taggedTraces ?? [];
      const last = lastSealedRef.current.get(path);
      if (
        !last ||
        last.content !== content ||
        last.tags.length !== tags.length ||
        last.tags.some((t, i) => t !== tags[i]) ||
        (last.taggedTraces ?? []).length !== taggedTraces.length ||
        (last.taggedTraces ?? []).some((t, i) => t !== taggedTraces[i])
      ) {
        out.push(path);
      }
    }
    return out;
  }

  /** Gate the seal pipeline while an LLM op is streaming (on = true) and
   *  release it when it finishes. On release, any path the suppressed effect
   *  deferred is sealed exactly once — the op's whole output becomes a single
   *  delta. Safe to call true→true or false→false; only the true→false edge
   *  triggers the catch-up seal.
   *
   *  `signer` (used only on the release edge) is the voice that release seal
   *  is signed as — the LLM op's inject key, so the AI insert seals as that
   *  voice instead of the manual (pen) key the user is typing under. The
   *  debounced auto-save (scheduleSeal) separately resolves the pen key via
   *  manualSignerRef, so a non-op seal also signs with the manual key. */
  function suppressSeal(on: boolean, signer?: Uint8Array) {
    if (on) {
      sealSuppressed.current = true;
      return;
    }
    sealSuppressed.current = false;
    // Seal everything the suppressed window saw touched. Snapshot first —
    // sealNow is async and may interleave with a new suppression turn.
    const paths = [...pendingSealPaths.current];
    pendingSealPaths.current.clear();
    for (const p of paths) {
      void sealNow(p, signer).catch((e) =>
        console.warn(`[provenance] suppressed-seal catch-up failed for ${p}:`, e),
      );
    }
  }

  async function sealNow(path: string, signer?: Uint8Array) {
    if (!folder) return;
    // Belt-and-suspenders: never seal while replay is parked on a historical
    // step. That step's file is frozen with reconstructed content via a
    // setRunsEffect-tagged run (which liftRuns exempts, so editFile/debounce
    // never fire), but an explicit Cmd+S would otherwise seal that frozen
    // content as a new node — polluting the trace. On `last` the editor is
    // live, so this ref is false and seals flow (the follow effect appends the
    // new seal as a step and advances the bar to the new last).
    if (replayActiveRef.current) return;
    const file = files[path];
    if (!file) return;
    // Content-stable dedup: skip when nothing has changed since the last seal
    // for this path. The tail of an LLM op is the motivating case — the op's
    // catch-up seal (deferred in endOp) commits a new nodeId via setFiles,
    // which retriggers the debounce effect; without this guard that trailing
    // seal re-runs writeFile, and on a laggy remote relay the manifest read
    // may not yet reflect the catch-up write, so the content-hash dedup in
    // writeFile misses and it republishes the same content. Short-circuiting
    // here makes the trailing seal a true no-op for every caller, no relay hop.
    const content = flatten(file.runs);
    const tags = file.tags;
    const taggedTraces = file.taggedTraces ?? [];
    const last = lastSealedRef.current.get(path);
    if (
      last &&
      last.content === content &&
      last.tags.length === tags.length &&
      last.tags.every((t, i) => t === tags[i]) &&
      (last.taggedTraces ?? []).length === taggedTraces.length &&
      (last.taggedTraces ?? []).every((t, i) => t === taggedTraces[i])
    ) {
      return;
    }
    try {
      // Pass the live runs to the backend so per-voice attribution persists
      // alongside the content (webapp → LocalFile.runs; desktop → .zine/attribution
      // sidecar). The backend validates runs against content on load and falls
      // back to a single run if they drift.
      // Pass `file.tags` so a tag-only edit still reaches writeFile with the
      // new labels — writeFile detects the content-hash match but tags-changed
      // case and seals anyway, so the new `t` tags land on the relay. Hardcoding
      // undefined here would drop the tags before publish, and writeFile's
      // content-hash no-op branch would swallow the change (the Times view would
      // never see #logos/#philos etc.).
      //
      // Pending `[[ ]]` brackets are left pending — minting (publishing a
      // span as its own trace node + resolving `| nodeId`) is opt-in via send,
      // never a side effect of seal. Resolved brackets this doc already cites
      // are mirrored as `q` tags by writeFile (findResolvedBrackets), so a
      // send-created citation flows to the relay on the next seal for free.
      // `taggedTraces` is the tagged-but-not-quoted set (the protocol's
      // `tag-add`); writeFile folds it into the same q-tag dedup and emits a
      // `tag-add` delta per id, so adding a trace to this list seals a new node
      // even when content is unchanged.
      const runs = file.runs;
      const nodeId = await writeRef.current(
        path,
        content,
        tags,
        signer,
        runs,
        taggedTraces.length > 0 ? taggedTraces : undefined,
      );
      lastSealedRef.current.set(path, { content, tags: [...tags], taggedTraces: [...taggedTraces] });
      // Reflect the freshly-sealed node id back into state so the next diff
      // is against the right baseline. Stable-identity update only. The
      // context-block delta-log memo is keyed by this nodeId, so advancing
      // the head auto-invalidates the stale chain — no manual hook here.
      setFilesRef.current((prev) =>
        prev[path] && prev[path].nodeId !== nodeId
          ? { ...prev, [path]: { ...prev[path], nodeId } }
          : prev,
      );
    } catch (e) {
      console.warn(`[provenance] write+publish failed for ${path}:`, e);
    }
  }

  // setFiles is threaded in from App() so sealNow can update nodeId without
  // a re-render cycle through the debounce effect. Assigned in App()'s body.
  const setFilesRef = useRef<(updater: (prev: Record<string, FileState>) => Record<string, FileState>) => void>(
    () => {},
  );
  // Write function — threaded in from App() so sealNow uses the active backend
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
    ) => Promise<string>
  >(async () => "");
  // Seed the last-sealed map for files loaded from disk/relay. Called from
  // App's openScanned tail so freshly-attached files are recognized as already
  // published (they are — that's why they have a nodeId) and don't trip a seal
  // on the first debounce tick. Without this, dirtySealPaths would mark every
  // loaded file dirty (lastSealedRef is empty until a seal runs) and the boot
  // fanout would re-seal the whole folder.
  const seedSealedRef = useRef<(files: Record<string, FileState>) => void>(() => {});
  seedSealedRef.current = (seedFiles: Record<string, FileState>) => {
    for (const [path, file] of Object.entries(seedFiles)) {
      lastSealedRef.current.set(path, {
        content: flatten(file.runs),
        tags: [...file.tags],
        taggedTraces: [...(file.taggedTraces ?? [])],
      });
    }
  };

  return { sealNow, ready, setFilesRef, pendingPaths, writeRef, suppressSeal, seedSealedRef, manualSignerRef };
}

// --- selection menu ----------------------------------------------------
//
// Opens above the editor's selection head when text is highlighted, offering
// the two trace-provenance gestures that act on a range:
//   bracket — wrap the selection in `[[ ]]` (pending; protected from
//                 overwrite by bracketProtect, never auto-minted).
//   send        — save the bracketed text as its own trace file and cite it.
//
// Portalled to document.body (same pattern as the tree's ctx-menu) so it floats
// above the editor's clipping containers. Reuses the .ctx-menu / .ctx-menu-item
// CSS family — mono, raised surface — so it reads as the same kind of surface.
// Dismiss on Escape or scroll (a pointer-down outside lands as a new selection,
// which re-anchors the menu via the live trackSelection listener).
function SelectionMenu({
  view,
  onBracket,
  onZine,
}: {
  view: EditorView;
  onBracket: () => void;
  onZine: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  // Anchor at the selection head (the `to` end), just below it. Re-measured on
  // each render via useLayoutEffect so the menu tracks the selection as the doc
  // changes; clamped to the viewport so it never opens off-screen.
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: 0, top: 0 });
  useLayoutEffect(() => {
    const sel = view.state.selection.main;
    try {
      const coords = view.coordsAtPos(sel.to);
      if (coords) {
        const left = Math.min(coords.left, window.innerWidth - 180);
        const top = Math.min(coords.bottom + 4, window.innerHeight - 60);
        setPos({ left: Math.max(8, left), top });
      }
    } catch {
      // coordsAtPos can throw if the position isn't currently rendered; the
      // menu just stays at its last known position until the next selection.
    }
  });

  // Dismiss handlers: Escape returns focus to the editor; scroll closes (the
  // anchor is stale after a scroll even if the selection survives). A pointer
  // down outside the menu is left to land as a normal editor click — that
  // moves the selection, and trackSelection re-opens the menu for the new range.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") view.focus();
    }
    function onScroll() {
      view.focus();
    }
    document.addEventListener("keydown", onKey);
    document.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("scroll", onScroll, true);
    };
  }, [view]);

  return createPortal(
    <div
      ref={menuRef}
      className="ctx-menu selection-menu"
      style={{ left: pos.left, top: pos.top }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <button
        type="button"
        className="ctx-menu-item"
        // onMouseDown (not onClick) + preventDefault keeps the editor from
        // losing focus / collapsing the selection before the action reads it.
        onMouseDown={(e) => {
          e.preventDefault();
          onBracket();
        }}
      >
        bracket
      </button>
      <button
        type="button"
        className="ctx-menu-item"
        onMouseDown={(e) => {
          e.preventDefault();
          onZine();
        }}
      >
        send
      </button>
    </div>,
    document.body,
  );
}

function App() {
  // The workspace is folder-driven: `files` starts empty and is populated by
  // the boot scan once a folder is attached. `folder` holds the attached
  // folder's stable id + absolute path (persisted in localStorage by
  // workspace.ts); null while the user hasn't picked one yet. On the webapp
  // `path` is undefined — the folder lives on the relay, addressed by `id`.
  const [folder, setFolder] = useState<AttachedFolder | null>(() => getAttachedFolder());
  // True when the attached folder's latest 4292 head is signed by someone other
  // than the active voice — i.e. a foreign folder opened for browsing. Writes
  // are gated until the user forks it into their own namespace (forkCurrentFolder).
  const [isForeignFolder, setIsForeignFolder] = useState(false);
  // Incoming forks / sibling heads for the active file (branch detection).
  // Refreshed on folder/path change and after incorporate.
  const [mergeCandidates, setMergeCandidates] = useState<MergeCandidate[]>([]);
  const [mergeBusy, setMergeBusy] = useState(false);
  // Open three-way reconcile session (conflict / sibling candidates).
  const [mergeSession, setMergeSession] = useState<{
    candidate: MergeCandidate;
    base: string;
    ours: string;
    path: string;
  } | null>(null);
  // Storage backend: disk on desktop, relay-only on webapp. Created once and
  // held in a ref so mutation call sites have a stable handle. The backend
  // closes over its attached folder, so callers drop the `folder` arg.
  const backendRef = useRef<Workspace>(isTauri() ? createDiskWorkspace() : createLocalWorkspace());
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
  if (prevFolderIdRef.current !== folderIdRef.current) {
    prevFolderIdRef.current = folderIdRef.current;
    lastFocusKeyRef.current = null;
  }
  // Webapp reset-workspace confirm: nukes the current folder and provisions a
  // fresh one. Gated by a dialog so the destructive action can't fire on a
  // stray click.
  const [confirmReset, setConfirmReset] = useState(false);
  const [files, setFiles] = useState<Record<string, FileState>>({});
  // Sibling traces available as tag-trace picker candidates: every file in the
  // current folder that has sealed a node this session (has a head nodeId to
  // cite). Built from `files` so it stays live as files seal/rename. Used only
  // by the in-folder "+ trace" picker (TagTracePicker); cross-folder tagging is
  // the Tag Browser's job.
  const traceCandidates = useMemo<TraceCandidate[]>(() => {
    const out: TraceCandidate[] = [];
    for (const [path, f] of Object.entries(files)) {
      if (f.nodeId) out.push({ path, nodeId: f.nodeId });
    }
    return out;
  }, [files]);
  // The workspace boots with a single panel that fills the row; the user opens
  // more by right-clicking "Open to side" or dragging a tab onto a panel's
  // right edge (up to MAX_PANELS). Empty panels collapse back out (see
  // closeTab/moveTab). Reply spawns a new column to the right of its source
  // (see replyLLM) so the reply always lands alongside the origin. All
  // parallel per-panel structures (panelViews, summonStatus, summonAbort,
  // panelWeights) stay length-locked to panels via spawnPanel / moveTabToNewPanel
  // / commitWithCollapse.
  const [panels, setPanels] = useState<PanelState[]>([{ tabs: [], active: "" }]);
  // The cited traces for each open file — every `q` tag on the file's current
  // head node, resolved to a name via `resolveNodeName`. This subsumes the old
  // single `reply-to` chip: a Reply is just one more cited trace here (its
  // source is a `q` tag on every seal, folded into the same dedup as body
  // quotes). Keyed by relativePath; keyed-on-headNodeId is tracked in
  // `citationHeadByPath` so a new seal re-resolves. Absent = not yet resolved.
  const [citationsByPath, setCitationsByPath] = useState<Record<string, CitationChip[]>>({});
  // The head node id each entry in `citationsByPath` was resolved against, so a
  // re-resolve only fires when the head actually moved (a new seal changed the
  // citation set). Without this, every render would refetch.
  const [citationHeadByPath, setCitationHeadByPath] = useState<Record<string, string>>({});
  // The tagged-trace chips for each open file — `file.taggedTraces` (the
  // `tag-add` subset of the head's `q` edges) resolved to named chips. Keyed on
  // the tagged id set, NOT on the head node, so a freshly tagged trace appears
  // instantly — before the debounce seals a new head (which is what the
  // `citationsByPath` effect above waits for). `resolveNodeName` caches per
  // node id, so this stays cheap even though it fires on every tag edit.
  const [taggedChipByPath, setTaggedChipByPath] = useState<Record<string, CitationChip[]>>({});
  // The inbound tracker for each open file — forks of it, traces that tag it,
  // and traces that cite it (spec §3.8 forks, §6 tags, §3.3 cites), the inverse
  // of the outbound `citationsByPath`/`taggedChipByPath`. Keyed on the head node
  // id so a re-resolve only fires when the head actually moved (a new seal may
  // change the inbound set, since cites pin a specific nucleus). `name` on each
  // entry is filled in lazily by the name-resolution effect below.
  const [inboundByPath, setInboundByPath] = useState<Record<string, TraceInbound[]>>({});
  const [inboundHeadByPath, setInboundHeadByPath] = useState<Record<string, string>>({});
  // The Seals history/diff modal (Part B): set when the user clicks a panel's
  // "Seals" button, or the "replying to ↑" chip (which additionally pins a
  // specific historical node). null when closed.
  const [sealsModal, setSealsModal] = useState<{
    relativePath: string;
    chain: Event[];
    pinnedEventId?: string;
  } | null>(null);
  // Folder-wide delta replay (seal-to-seal), sticky at last. `index === last`
  // is the live editor (no override — edits and seals flow, and a new seal
  // appends a step the follow effect advances to); `index < last` overrides
  // that one step's file with its reconstructed content (frozen — the override
  // is a setRunsEffect write `liftRuns` exempts, so no debounce arms) and gates
  // sealing off. `snapshot` captures the live FileState of a file the moment
  // it's frozen so stepping back to last (or exiting) can restore it; only the
  // active historical step's file is ever overridden at a time.
  const [replay, setReplay] = useState<{
    steps: ReplayStep[];
    index: number;
    snapshot: Record<string, FileState>;
  } | null>(null);
  // Per-tab view mode, keyed by file path. Each open file remembers which
  // surface (preview vs markdown) it was last shown on, so switching tabs
  // restores the surface you left it in rather than a single panel-wide mode.
  // Entries persist as long as at least one panel still holds the tab; once a
  // path has no open tab anywhere it's pruned (see setTabModes), so reopening a
  // closed file always starts fresh in preview — the default.
  const [tabModes, setTabModes] = useState<Record<string, "preview" | "markdown">>({});
  const [bootState, setBootState] = useState<"idle" | "scanning" | "ready" | "missing">("idle");
  const [bootError, setBootError] = useState<string | null>(null);
  const [defaultPath, setDefaultPath] = useState<string | null>(null);
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
  // and the sealNow guard, which must read replay-active state without
  // depending on a re-render. Kept in sync by the effect below.
  const replayRef = useRef<{
    steps: ReplayStep[];
    index: number;
    snapshot: Record<string, FileState>;
  } | null>(null);
  // Each path's genesis→head chain, captured in beginReplay so per-character
  // playback (buildPlayTimeline) can expand deltas without refetching. Cleared
  // in endReplay. Kept in a ref (not state) — it's read imperatively by the
  // play builder and doesn't drive render.
  const replayChainsRef = useRef<Record<string, Event[]>>({});
  // True when the editor is showing a frozen (non-live) state: parked on a
  // historical seal step, OR mid-character-playback. Gates sealNow so a stray
  // Cmd+S can't seal historical/partial content as a new node. On `last` with
  // play stopped the editor is live, so seals flow (the follow effect appends
  // them). The Sidebar's disabled state uses `replay !== null` directly.
  const replayActiveRef = useRef(false);
  // Per-character typewriter playback. Separate cursor from the seal stepper:
  // play animates every delta one character at a time (interleaved across
  // files by seal timestamp), while the stepper/slider stay at save-point
  // granularity. The frame list is built on play-start and torn down on
  // pause/stop; a pause snaps the seal cursor to the frame's enclosing seal.
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
      // Snap the seal cursor to the last real frame's seal so the stepper/
      // slider rest at the final save point (one before live).
      const lastReal = tl[tl.length - 2];
      if (lastReal) replayStepTo(lastReal.sealIndex);
      return;
    }
    const id = setTimeout(() => {
      const next = playCursorRef.current + 1;
      const frame = tl[next];
      if (!frame) return;
      renderPlayFrame(frame, tl[playCursorRef.current] ?? null);
      playCursorRef.current = next;
      setPlayCursor(next);
    }, 60 / playSpeed);
    return () => clearTimeout(id);
  }, [playing, playCursor, playSpeed, playTimeline]); // eslint-disable-line react-hooks/exhaustive-deps
  const { sealNow, ready, setFilesRef, pendingPaths, writeRef, suppressSeal, seedSealedRef, manualSignerRef } = useProvenance(folder, files, replayActiveRef);
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
  // openScanned for every load path (desktop attach, webapp auto-open, the
  // [folder?.id] re-attach), and the folder-id guard dedupes across the
  // webapp's double openScanned (webAutoOpen → [folder?.id] re-attach). A manual
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
  // for newly-sealed node ids. Each new seal appends a step and the bar
  // advances to the new last, so the resting position always reflects current
  // state and the user can keep stepping back to verify each save point as it
  // lands. Only acts on `last` — on a historical step the guard blocks seals,
  // so nothing changes here. Runs O(files) on every content tick but the async
  // fetchEventById fires only when a nodeId is genuinely new to the timeline.
  useEffect(() => {
    if (!replay) return;
    const last = replay.steps.length - 1;
    if (replay.index !== last) return;
    const knownIds = new Set(replay.steps.map((s) => s.event.id));
    // Collect (path, nodeId) pairs that aren't already steps and have a real id.
    const fresh: Array<{ path: string; nodeId: string }> = [];
    for (const [path, state] of Object.entries(files)) {
      const nodeId = state.nodeId;
      if (nodeId && !knownIds.has(nodeId)) {
        fresh.push({ path, nodeId });
      }
    }
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
            // latest seal still shows the live per-voice attribution (these steps
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
        // Re-check we're still on last and these ids are still novel — the
        // async fetch could have raced a manual step or another append.
        const stillLast = prev.index === prev.steps.length - 1;
        if (!stillLast) return prev;
        const known = new Set(prev.steps.map((s) => s.event.id));
        const merged = [...prev.steps, ...appended.filter((s) => !known.has(s.event.id))];
        merged.sort((a, b) => a.meta.sealedAtMs - b.meta.sealedAtMs);
        const next = { ...prev, steps: merged, index: merged.length - 1 };
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
  // Focus deltas (panel mount/unmount) drain onto the *next* folder-node seal,
  // which always accompanies a membership change, so they're covered too. We
  // only bump on growth, never on shrink, so closing a file's last bracket or
  // a transient editor tick doesn't thrash the panel with refetches. (This is
  // a sibling of the replay-follow effect above; both watch `files`.)
  const prevFolderSigRef = useRef<string>("");
  useEffect(() => {
    const paths = Object.keys(files).sort();
    const ids = paths.map((p) => files[p]?.nodeId ?? "");
    const sig = paths.join("\n") + "\n|\n" + ids.join("\n");
    if (sig === prevFolderSigRef.current) return;
    const grew =
      sig.length > prevFolderSigRef.current.length ||
      !prevFolderSigRef.current.startsWith(paths.join("\n"));
    prevFolderSigRef.current = sig;
    if (!grew) return;
    setOrchestrationRefreshKey((k) => k + 1);
  }, [files]);
  // LLM ops suppress seals while streaming and release on finish; indirection
  // via a ref so the async op's finally always calls the latest closure (the
  // identity changes each render, but the op captured it at await time).
  const sealGateRef = useRef(suppressSeal);
  sealGateRef.current = suppressSeal;
  // Thread setFiles into the hook so sealNow can reflect sealed node ids.
  setFilesRef.current = setFiles;
  // Thread the backend's write fn into the hook so sealNow routes through the
  // right storage (disk on desktop, localStorage on webapp) instead of the
  // hardwired Tauri disk path.
  writeRef.current = (path, content, tags, signer, runs, taggedTraces) => {
    // Gate writes to foreign folders — the user must fork first. The banner's
    // Fork button is the path out of read-only. Logging rather than throwing so
    // a stray keystroke-driven seal doesn't surface as an error toast.
    if (isForeignFolder) {
      console.warn("write blocked: viewing a foreign folder — fork it to edit");
      return Promise.resolve("");
    }
    return backendRef.current.writeFile(path, content, tags, signer, runs, undefined, taggedTraces);
  };
  const [activePanel, setActivePanel] = useState<number>(0);
  // Branch detection: rescan incoming forks / sibling heads for the active file.
  // Fires on folder switch, tab focus, foreign-flag change, and after seals that
  // advance the head (nodeId). Debounced slightly so rapid tab flips don't spam.
  const activePathForMerge = panels[activePanel]?.active ?? "";
  const activeHeadForMerge = activePathForMerge ? files[activePathForMerge]?.nodeId ?? "" : "";
  useEffect(() => {
    if (!folder?.id || !activePathForMerge || isForeignFolder) {
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
  }, [folder?.id, activePathForMerge, activeHeadForMerge, isForeignFolder]);
  // The active editor's live selection range, lifted so the SelectionMenu can
  // open anchored to its head. `{ panelIdx, from, to }` when the focused
  // panel's editor has a non-empty selection; null otherwise. Each panel's
  // FileEditor reports through onSelection (Panel → App) via setEditorSelection.
  const [editorSelection, setEditorSelection] = useState<{
    panelIdx: number;
    from: number;
    to: number;
  } | null>(null);
  // The unified "active trace" — the single thing the top bar operates
  // on. Sticky: it only moves when the user explicitly selects something else
  // (a file, a folder, a palette span, or an editor [[ span ]]); clicking empty
  // space never clears it, so "the last selected trace" is always available.
  const [selection, setSelection] = useState<SelectionRef | null>(null);
  // The keychain. There is no separate "active key" — the two user-facing
  // roles are the **manual** (pen) key and the **automatic** (inject) key,
  // each chosen in the TopBar (AUTHOR-row key and the automatic-row key).
  // Both default to the first keychain key when the user hasn't picked one,
  // and persist per-browser so a chosen pen/inject survives reload.
  const [keys, setKeys] = useState<KeyEntry[]>(() => loadKeys());
  // The two voice roles: the **pen** types new text and signs Save/auto-save/
  // send; the **inject** voice runs the LLM ops (Extend/Settle/Stir/Reply)
  // and is the attribution for their streamed text. Each is an independent key
  // selection — they can overlap (same key for both) or diverge. Both default
  // to the first keychain key and persist per-browser.
  const [penKeyId, setPenKeyId] = useState<string | null>(() => {
    const stored = localStorage.getItem("zine.roles.pen");
    return stored && loadKeys().some((k) => k.id === stored) ? stored : loadKeys()[0]?.id ?? null;
  });
  const [injectKeyId, setInjectKeyId] = useState<string | null>(() => {
    const stored = localStorage.getItem("zine.roles.inject");
    return stored && loadKeys().some((k) => k.id === stored) ? stored : loadKeys()[0]?.id ?? null;
  });
  // The first keychain key's pubkey — the fallback both roles resolve to when
  // no pen/inject has been picked (or its key was deleted), then "alice".
  const fallbackPubkey = keys[0]?.pubkey ?? "alice";
  // Resolve each role's pubkey once per render. Falls back to the first
  // keychain key if the stored role id is gone (key deleted), then "alice".
  const penKey = keys.find((k) => k.id === penKeyId) ?? null;
  const penPubkey = penKey?.pubkey ?? fallbackPubkey;
  const injectKey = keys.find((k) => k.id === injectKeyId) ?? null;
  const injectPubkey = injectKey?.pubkey ?? fallbackPubkey;
  // Hand the debounced auto-save a resolver for the pen key's secret, so the
  // 1500ms debounce seal signs as the manual key — not a hidden active key.
  // Read at fire time (see scheduleSeal), so a pen switch mid-debounce wins.
  manualSignerRef.current = () => secretKeyForVoice(penPubkey) ?? undefined;
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
    saveWorkspaceLayout(folder.id, {
      panels,
      tabModes,
      activePanel,
      panelWeights,
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
  const [activeView, setActiveView] = useState<View>("editor");
  const [theme, setTheme] = useState<Theme>(() => readTheme());
  const [railExpanded, setRailExpanded] = useState(false);

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

  // --- orchestration timeline state ----------------------------------------
  // Collapsible folder-orchestration replay view (entry/exit/rename/selection
  // over the folder's lifetime). Independent of the content ReplayTransport —
  // a separate lens on the same folder chain. §3.3/§8.
  const [orchestrationOpen, setOrchestrationOpen] = useState(false);

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
  // Per-panel Summon status only — the pen concept is gone (one global active
  // key drives both signing and editor attribution), so there's no per-panel
  // voice array to keep in sync anymore.
  const [summonStatus, setSummonStatus] = useState<SummonStatus[]>([{ state: "idle" }]);
  const summonAbort = useRef<(AbortController | null)[]>([null]);
  // The inject signer the in-flight op armed in beginOp, stashed so endOp can
  // hand it to the seal gate's catch-up seal. Undefined = the manual (pen) key
  // resolves at seal time (manual edits, no op running). See beginOp/endOp.
  const opSignerRef = useRef<Uint8Array | undefined>(undefined);
  // When the active panel changes, point the palette's editor handle at the
  // newly-active panel's view. (onView only fires on mount/unmount, so without
  // this the palette would keep targeting the previously-active panel's editor
  // until a file switch forced a remount.)
  useEffect(() => {
    activeEditorView.current = panelViews.current[activePanel] ?? null;
  }, [activePanel]);
  // paletteRefreshKey bumps after a palette mutation so PalettePanel re-fetches.
  const [paletteRefreshKey, setPaletteRefreshKey] = useState(0);
  // orchestrationRefreshKey bumps when the folder's membership set or any file's
  // node id changes, so the OrchestrationTimeline panel re-fetches its stream
  // after a folder-chain mutation (create/move/delete/rename/import). The bump
  // effect lives near the replay-follow effect below; it only fires on actual
  // growth, so typing in a file doesn't thrash it.
  const [orchestrationRefreshKey, setOrchestrationRefreshKey] = useState(0);

  /** Wrap the active editor's current selection in `[[ ]]` (pending). The menu's
   *  bracket action and Cmd/Ctrl+S-over-a-selection both call this. Pure wrap —
   *  no publish. Protection from overwrite is immediate via bracketProtect; a
   *  bracket stays pending until send mints it. */
  function wrapSelection(view: EditorView) {
    wrapSelectionCommand()(view);
  }

  /** send: mint a selection by saving its text as its own trace file in the
   *  folder, then resolve the bracket in the origin doc to cite the new file's
   *  node. The new file becomes a folder member (kind-4290, action: import);
   *  the origin's next seal emits the resolved `[[ phrase | nodeId ]]` as a
   *  `q`-tag citation (writeFile already does this via findResolvedBrackets), so
   *  the cross-file reference lands on the relay for free. This is the only
   *  path that mints a bracket.
   *
   *  `from`/`to` are the current selection in `view`. If the selection is
   *  already inside a pending `[[ phrase ]]`, that phrase is used as-is;
   *  otherwise the selection is wrapped first and the just-wrapped phrase is
   *  used. The new file opens in the adjacent panel (or the same one when only
   *  a single column is open). */
  async function zinePhrase(path: string, view: EditorView, from: number, to: number) {
    if (!folder) return;
    // Determine the phrase. If the selection is already a pending bracket, use
    // its text; otherwise wrap the selection and read the wrapped phrase.
    const docText = view.state.doc.toString();
    const insidePending = findPendingBrackets(docText).find(
      (b) => b.matchStart <= from && b.matchEnd >= to,
    );
    let phrase: string;
    if (insidePending) {
      phrase = insidePending.phrase;
    } else {
      phrase = docText.slice(from, to);
      if (!phrase || phrase.includes("[[") || phrase.includes("]]")) return;
      wrapSelection(view);
      // No need to capture the wrapped bracket's positions here — after the
      // writeFile await below, we re-find the bracket by phrase (positions may
      // have shifted if the user typed during the await).
    }

    // Slugify the phrase into a sibling filename. Same parent dir as the origin
    // so the new file sits beside it; .md extension; deduped against current
    // paths via uniquePath so two sends of the same phrase don't collide.
    const slug = slugifyFilename(phrase, "span");
    const parent = parentPath(path);
    const base = `${slug}.md`;
    const candidate = parent ? `${parent}/${base}` : base;
    const newPath = uniquePath(candidate, new Set(Object.keys(files)));

    const signer = secretKeyForVoice(penPubkey) ?? undefined;
    // Optimistic empty file so the editor opens immediately, then write + seal.
    // writeFile writes disk + publishes the kind-4290 node + updates the folder
    // manifest (the new file becomes a folder member).
    pendingPaths.current.add(newPath);
    editFile(newPath, [{ voice: penPubkey, text: "" }]);
    try {
      const newFileId = await backendRef.current.writeFile(newPath, phrase, [], signer);
      // Resolve the bracket in the origin doc to cite the new file's node. The
      // whole-doc dispatch keeps positions from drifting; liftRuns carries the
      // change into file.runs and the decoration flips to --resolved.
      const afterWrite = view.state.doc.toString();
      // Bracket positions may have shifted if the user typed during the await;
      // re-find by phrase to be safe.
      const target = findPendingBrackets(afterWrite).find((b) => b.phrase === phrase);
      if (target) {
        const resolved = resolveBracket(afterWrite, target.matchStart, target.matchEnd, newFileId);
        view.dispatch({ changes: { from: 0, to: afterWrite.length, insert: resolved } });
      }
      // Reflect the new file + its node id into state. The span is authored by
      // the pen key (it signs the genesis node above), so attribute its text to
      // penPubkey directly so the runs and the signer agree and the sealed
      // `authors` map is single-voice-faithful rather than mismatched.
      setFiles((prev) => ({
        ...prev,
        [newPath]: { runs: [{ voice: penPubkey, text: phrase }], nodeId: newFileId, tags: [] },
      }));
      // Open the new file in the panel immediately right of its origin if one
      // exists, else the origin panel itself. The reader sees the new trace
      // alongside its origin. (This reuses an existing neighbor — it does not
      // spawn a fresh column; only "Open to side" and tab edge-drop spawn.)
      const originPanel = panels.findIndex((p) => p.tabs.includes(path));
      const destPanel = originPanel === -1 ? activePanel : originPanel + 1;
      if (destPanel < panels.length) {
        openInPanel(newPath, destPanel);
      } else {
        openInPanel(newPath, Math.max(0, originPanel));
      }
    } catch (e) {
      console.warn(`[zine] publish failed for phrase in ${path}:`, e);
      // Leave the bracket pending — the user can retry.
    } finally {
      pendingPaths.current.delete(newPath);
    }
  }

  // Provider catalog (Models view). Labels are the card names from Models —
  // kept live via ModelsView.onProvidersChange so the topbar dropdown matches
  // renames. Re-read when entering Press in case storage changed elsewhere.
  // Which one ops use is chosen under Press model select (voice-provider-store).
  const [providers, setProviders] = useState<ProviderConfig[]>(() => loadProviders());
  useEffect(() => {
    if (activeView === "editor") setProviders(loadProviders());
  }, [activeView]);

  /** Set the pen (typing + Save/send) voice. Persisted per-browser. */
  function choosePenKey(id: string) {
    setPenKeyId(id);
    localStorage.setItem("zine.roles.pen", id);
  }

  /** Set the inject (LLM ops) voice. Persisted per-browser. */
  function chooseInjectKey(id: string) {
    setInjectKeyId(id);
    localStorage.setItem("zine.roles.inject", id);
  }

  /** Resolve the provider a voice's ops should use. Sole source of truth:
   *  the AUTOMATIC model pin on that voice (voice-provider-store). If unset or
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

  /** Pin the AUTOMATIC model for a voice and re-render so the menu updates. */
  function selectVoiceProvider(pubkey: string, providerId: string) {
    setVoiceProvider(pubkey, providerId || null);
    setPaletteRefreshKey((k) => k + 1); // cheap re-render trigger
  }

  /** Set the per-panel op status (shared by all four ops). */
  function setOpStatus(idx: number, state: SummonStatus["state"], msg?: string) {
    setSummonStatus((prev) => {
      const next = [...prev];
      next[idx] = { state, msg };
      return next;
    });
  }

  /** Resolve + guard the provider for a voice's op (AUTOMATIC model select).
   *  Returns it or sets an error and null. */
  function resolveOpProvider(idx: number, pubkey: string): ProviderConfig | null {
    const provider = resolveVoiceProvider(pubkey);
    if (!provider) {
      setOpStatus(idx, "error", "no provider — add one in Models");
      return null;
    }
    return provider;
  }

  /** Apply a voice's custom prompt (voice-prompt-store) to a message list: if
   *  the voice has a prompt, splice it in as the leading system message so the
   *  op's own system prompt follows it. No-op when the voice has no prompt. */
  function withVoicePrompt(pubkey: string, messages: ChatMessage[]): ChatMessage[] {
    const prompt = getVoicePrompt(pubkey);
    if (!prompt.trim()) return messages;
    return [{ role: "system", content: prompt.trim() }, ...messages];
  }

  /** Prepend the canonical context block (folder tree + sibling text + the
   *  active file's delta log) to the first user message in an op's message
   *  list. Gathered once per op invocation, shared across any inner steps.
   *  Call as `withContext(ctx, withVoicePrompt(pubkey, builderMessages))` —
   *  context lands inside the op's user message, voice prompt stays the
   *  leading system message, op-specific system prompt stays as-is. */
  function withContext(ctx: string, messages: ChatMessage[]): ChatMessage[] {
    if (!ctx) return messages;
    const idx = messages.findIndex((m) => m.role === "user");
    if (idx < 0) return [{ role: "user", content: ctx }, ...messages];
    const updated = [...messages];
    updated[idx] = { role: "user", content: `${ctx}\n\n${messages[idx].content}` };
    return updated;
  }

  /** Gather the canonical context block for the active doc in panel `idx`.
   *  Returns "" when no folder is attached or no file is active — ops then
   *  run unchanged from before (no context). Never throws: a chain-fetch
   *  failure inside drops just the delta-log section. */
  async function gatherContextForPanel(idx: number): Promise<string> {
    if (!folder) return "";
    const path = panels[idx]?.active;
    if (!path) return "";
    return gatherContextBlock(folder, files, path);
  }

  // Approximate prompt-size estimate for the token indicator beside the LLM
  // buttons. The number reflects the payload an op would send against the
  // op-target panel's active file (the same target Extend/Settle/Stir/Reply
  // run against): the canonical context block (which dominates), the shared
  // system preamble, the inject voice's voice prompt, and a small allowance for
  // the op-specific instruction + seed. Debounced so typing doesn't thrash the
  // async gather; the delta-log fetch inside is memoized (context-gather.ts).
  const [tokenEstimate, setTokenEstimate] = useState<number | null>(null);
  useEffect(() => {
    if (!folder) {
      setTokenEstimate(null);
      return;
    }
    const sp = selection?.path;
    const panelIdx = sp
      ? panels.findIndex((p) => p.tabs.includes(sp))
      : Math.min(activePanel, panels.length - 1);
    const path = panelIdx >= 0 ? panels[panelIdx]?.active : undefined;
    if (!path) {
      setTokenEstimate(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const block = await gatherContextBlock(folder, files, path);
          const voicePrompt = getVoicePrompt(injectPubkey) ?? "";
          // The op-specific overhead (op system instruction + seed/source) is
          // small vs. the context block; a flat allowance keeps this honest.
          const chars = block.length + SYSTEM_PREAMBLE.length + voicePrompt.length + 1500;
          if (!cancelled) setTokenEstimate(estimateTokens(chars));
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
  }, [folder, files, panels, activePanel, selection?.path, injectPubkey]);

  /** Begin an op: mark running and arm an AbortController. The op voice is
   *  NOT adopted on the editor facet here — each streamed change instead
   *  carries an `opVoiceEffect` with the exact voice (see voiceField), so
   *  attribution can't drift if the facet is reconfigured mid-stream (pen
   *  switch) or restored by a prior op. Returns the controller, or null if
   *  the editor isn't mounted.
   *
   *  `signer` is the voice the op's release seal should be signed as — the
   *  inject key's secret for an LLM op, so the AI insert seals as that voice
   *  instead of the manual (pen) key the user is typing under. Stashed for
   *  endOp to pass through the gate's catch-up
   *  seal. The op's pre-stream baseline seal is signed by the pen key
   *  separately; this only governs the release seal.
   *
   *  Also arms the seal gate: while the op streams, the debounce seal effect
   *  is suppressed (see useProvenance.suppressSeal). Each streamed token's
   *  setFiles would otherwise re-arm the 1500ms seal; a quiet gap mid-stream
   *  (model thinking, network hiccup) then fires an intermediate seal,
   *  publishing a half-finished AI insert — and more tokens publish again,
   *  tripping the relay's per-connection rate-limit. The gate collapses the
   *  whole op to a single seal, released in endOp. */
  function beginOp(
    idx: number,
    signer?: Uint8Array,
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
    setOpStatus(idx, "running");
    opSignerRef.current = signer;
    sealGateRef.current(true);
    const controller = new AbortController();
    summonAbort.current[idx] = controller;
    return { controller };
  }

  /** End an op: clear the controller and release the seal gate. The facet was
   *  never touched, so there's nothing to restore — terminal status is handled
   *  by the caller. Releasing the gate fires one catch-up seal per path the
   *  suppressed window saw touched, signed with the voice beginOp armed, so
   *  the op's whole output seals as a single delta under the right voice.
   *
   *  Deferred one macrotask so React has committed the op's final setFiles
   *  before the catch-up seal reads `files`. Without this, endOp's finally
   *  runs synchronously on await resume — the last token's state is still
   *  pending — so the catch-up seal would publish partial content, then the
   *  debounce effect would re-seal the remainder a beat later as the active
   *  key (scheduleSeal always passes no signer). With the deferral the
   *  catch-up seal sees complete content and the debounce dedups against it:
   *  one seal, inject-signed, complete. */
  function endOp(idx: number) {
    summonAbort.current[idx] = null;
    const signer = opSignerRef.current;
    opSignerRef.current = undefined;
    setTimeout(() => sealGateRef.current(false, signer), 0);
  }

  /** §3.7: prepare the LLM-call metadata (rule trace + scope citations + model
   *  config) and stash it via setPendingLlmMeta, so the op's write-back seal
   *  (through writeFile → publishEdit) carries it on the action:llm node. Called
   *  by every LLM op just before its provider call — the seal happens after the
   *  model replies, but the scope is pinned to call time (what was in scope
   *  when the model was invoked), so gathering it here is correct. The scope is
   *  the folder's members' heads + the active file's head + the rule trace id. */
  async function prepareLlmMeta(
    idx: number,
    op: "extend" | "settle" | "stir" | "reply",
    provider: ProviderConfig | null,
  ): Promise<void> {
    if (!folder || !provider) return;
    const activePath = panels[idx]?.active ?? "";
    try {
      const manifest = {
        algorithm: "ctx-block-v1",
        params: { op, folderLabel: folder.label ?? folder.id.slice(0, 8), activePath },
      };
      const injectRule = await getOrCreateRuleTrace(folder.id, manifest);
      const members = await fetchManifest(folder.id);
      const activeNodeId = activePath ? (files[activePath]?.nodeId ?? null) : null;
      const scopeCitations = [
        ...members.map((m) => m.latestNodeId).filter((id): id is string => !!id),
        ...(activeNodeId ? [activeNodeId] : []),
      ].filter((id, i, arr) => arr.indexOf(id) === i);
      setPendingLlmMeta({
        injectRule,
        scopeCitations,
        llm: {
          model: provider.modelId,
          // null = "no temperature sent" (the client passes none → provider
          // default). NOT 0 — that would claim deterministic decoding. Records
          // the actual value once the ops grow real temperature control.
          temperature: null,
          maxTokens: 0,
          provider: provider.label || provider.protocol,
        },
      });
    } catch {
      /* best-effort — scope pinning is telemetry, never blocks the op */
    }
  }

  /** EXTEND — append an AI continuation. With a selection, seeds from the
   *  selected text and streams the continuation right after it; otherwise seeds
   *  from the end of the document and appends at doc.length. Each delta is
   *  attributed to `pubkey` via an op-voice effect carried on the change
   *  transaction (see voiceField) — not via the live editor facet, so the
   *  attribution can't drift if the pen is switched mid-stream. */
  async function extendLLM(idx: number) {
    const pubkey = injectPubkey;
    const provider = resolveOpProvider(idx, pubkey);
    if (!provider) return;
    const started = beginOp(idx, secretKeyForVoice(pubkey) ?? undefined);
    if (!started) return;
    const { controller } = started;
    const view = panelViews.current[idx]!;
    // Summoning the model is a deliberate human gesture (a button click), so
    // the baseline it runs against is sealed first by the pen key — same path
    // as a manual Save. The write-back then lands as its own subsequent node
    // chained off this baseline (see sealGate / suppressSeal in endOp).
    {
      const signer = secretKeyForVoice(penPubkey);
      const path = panels[idx]?.active;
      if (path && files[path] && signer) await sealNow(path, signer);
    }
    // §3.7: pin the call's scope + rule + model config before invoking, so the
    // write-back seal carries them and a reader can reconstruct the prompt.
    await prepareLlmMeta(idx, "extend", provider);
    // With a selection, Extend seeds from the selected text and continues right
    // after it; otherwise it seeds from the end of the document and appends.
    const sel = view.state.selection.main;
    const hasSel = sel.from !== sel.to;
    const seed = hasSel
      ? view.state.sliceDoc(sel.from, sel.to)
      : view.state.doc.toString().slice(-4000);
    const messages: ChatMessage[] = withContext(
      await gatherContextForPanel(idx),
      withVoicePrompt(pubkey, [
        {
          role: "system",
          content:
            `${SYSTEM_PREAMBLE}\n\n` +
            "YOUR ROLE — Extend: the continuer. You pick up the document where it " +
            "leaves off and write ONLY the continuation. The text after the " +
            "context block is your SEED: " +
            (hasSel
              ? "a selected passage. Continue from the end of that passage as if the cursor sat right after it."
              : "the end of the document. Continue from there.") +
            " The seed is what the human is asking you to extend — it is NOT a " +
            "question to answer or a prompt to reply to. Match the seed's " +
            "voice, tense, register, and formatting. Do not repeat or restate " +
            "the seed; flow directly onward from its last line. Do not emit " +
            "brackets unless they already appear in the seed and clearly extend " +
            "an ongoing citation. No preamble, no acknowledgement, no fences, " +
            "no quotation marks wrapping the whole response.",
        },
        { role: "user", content: seed || "(empty document — begin writing.)" },
      ]),
    );
    const anchor = hasSel ? sel.to : view.state.doc.length;
    // Begin the continuation on its own line: if the char right before the
    // anchor isn't already a line break (and the anchor isn't the doc start),
    // prepend "\n" to the first inserted chunk. Skipped when the anchor already
    // sits at the head of a line, so an existing trailing newline isn't doubled.
    const prefix = anchor > 0 && view.state.doc.sliceString(anchor - 1, anchor) !== "\n"
      ? "\n"
      : "";
    let acc = "";
    let firstDelta = true;
    try {
      const full = await complete(provider, messages, {
        maxTokens: 4096,
        signal: controller.signal,
        onDelta: (delta) => {
          if (firstDelta) {
            delta = prefix + delta;
            firstDelta = false;
          }
          acc += delta;
          // Clamp to the live doc length: an external sync (relay push, a
          // concurrent write to this file, or the seal write-back) can swap the
          // doc to a shorter one mid-stream, leaving the captured `anchor`
          // past the end. Without this the dispatch throws
          // "Invalid change range … (in doc of length …)".
          const insertAt = Math.min(
            anchor + acc.length - delta.length,
            view.state.doc.length,
          );
          view.dispatch({
            changes: { from: insertAt, insert: delta },
            effects: opVoiceEffect.of(pubkey),
          });
        },
      });
      if (!acc && full)
        view.dispatch({
          changes: { from: Math.min(anchor, view.state.doc.length), insert: prefix + full },
          effects: opVoiceEffect.of(pubkey),
        });
      setOpStatus(idx, "done");
    } catch (e) {
      if (controller.signal.aborted) {
        setOpStatus(idx, "idle");
        return;
      }
      setOpStatus(idx, "error", e instanceof Error ? e.message : String(e));
    } finally {
      endOp(idx);
    }
  }

  /** SETTLE - condense the loose (non-bracketed) prose in place; preserve
   *  `[[ ]]` spans verbatim (never regenerate them). Repeated rounds drive the
   *  file toward only bracketed text. With a selection, condenses only the
   *  selected range (replacing it in place); otherwise the whole document.
   *  One CM6 transaction -> one undo restores. */
  async function settleLLM(idx: number) {
    const pubkey = injectPubkey;
    const provider = resolveOpProvider(idx, pubkey);
    if (!provider) return;
    const started = beginOp(idx, secretKeyForVoice(pubkey) ?? undefined);
    if (!started) return;
    const { controller } = started;
    const view = panelViews.current[idx]!;
    // Seal the baseline under the pen key before the model runs (see extendLLM).
    {
      const signer = secretKeyForVoice(penPubkey);
      const path = panels[idx]?.active;
      if (path && files[path] && signer) await sealNow(path, signer);
    }
    await prepareLlmMeta(idx, "settle", provider);
    try {
      const sel = view.state.selection.main;
      const hasSel = sel.from !== sel.to;
      const from = hasSel ? sel.from : 0;
      const to = hasSel ? sel.to : view.state.doc.length;
      const text = view.state.sliceDoc(from, to);
      const parts = partitionDoc(text);
      const ctx = await gatherContextForPanel(idx);
      // Condense each loose segment independently; brackets pass through.
      const rebuilt: string[] = [];
      for (const part of parts) {
        if (part.kind === "bracket") {
          rebuilt.push(part.text);
          continue;
        }
        if (part.text.trim().length === 0) {
          rebuilt.push(part.text);
          continue;
        }
        const condensed = await complete(provider, withContext(ctx, withVoicePrompt(pubkey, SETTLE_MESSAGES(part.text))), {
          maxTokens: 512,
          signal: controller.signal,
        });
        rebuilt.push(condensed);
      }
      const next = rebuilt.join("");
      if (next !== text) {
        // Clamp the stale selection range to the live doc: the await above can
        // span an external doc-sync that shrank the body (see extendLLM).
        const end = Math.min(to, view.state.doc.length);
        view.dispatch({
          changes: { from: Math.min(from, end), to: end, insert: next },
          effects: opVoiceEffect.of(pubkey),
        });
      }
      setOpStatus(idx, "done");
    } catch (e) {
      if (controller.signal.aborted) {
        setOpStatus(idx, "idle");
        return;
      }
      setOpStatus(idx, "error", e instanceof Error ? e.message : String(e));
    } finally {
      endOp(idx);
    }
  }

  /** SHAKE — preserve `[[ ]]` anchors verbatim, execute each `(( command ))`
   *  directive, reinvent the loose prose around the anchors, and drop the
   *  consumed commands. With a selection, reinvents only the selected range
   *  (replacing it in place); otherwise the whole document. One CM6
   *  transaction → one undo restores everything (loose prose, anchors, commands). */
  async function stirLLM(idx: number) {
    const pubkey = injectPubkey;
    const provider = resolveOpProvider(idx, pubkey);
    if (!provider) return;
    const started = beginOp(idx, secretKeyForVoice(pubkey) ?? undefined);
    if (!started) return;
    const { controller } = started;
    const view = panelViews.current[idx]!;
    // Seal the baseline under the pen key before the model runs (see extendLLM).
    {
      const signer = secretKeyForVoice(penPubkey);
      const path = panels[idx]?.active;
      if (path && files[path] && signer) await sealNow(path, signer);
    }
    await prepareLlmMeta(idx, "stir", provider);
    try {
      const sel = view.state.selection.main;
      const hasSel = sel.from !== sel.to;
      const from = hasSel ? sel.from : 0;
      const to = hasSel ? sel.to : view.state.doc.length;
      const text = view.state.sliceDoc(from, to);
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
      const ctx = await gatherContextForPanel(idx);
      const reinvented = await complete(
        provider,
        withContext(ctx, withVoicePrompt(pubkey, SHAKE_MESSAGES(loose, anchorCount, cmds.map((c) => c.command)))),
        { maxTokens: 1024, signal: controller.signal },
      );
      // Rebuild: reinvented loose prose, with the verbatim bracket anchors
      // re-inserted at the positions the model placed [[ANCHOR N]] markers. If
      // the model ignored the markers, fall back to appending anchors after.
      const next = reweaveAnchors(reinvented, text);
      // Clamp the stale selection range to the live doc (see extendLLM).
      const end = Math.min(to, view.state.doc.length);
      view.dispatch({
        changes: { from: Math.min(from, end), to: end, insert: next },
        effects: opVoiceEffect.of(pubkey),
      });
      setOpStatus(idx, "done");
    } catch (e) {
      if (controller.signal.aborted) {
        setOpStatus(idx, "idle");
        return;
      }
      setOpStatus(idx, "error", e instanceof Error ? e.message : String(e));
    } finally {
      endOp(idx);
    }
  }

  /** RESPOND — write an AI response into a NEW sibling doc, citing existing
   *  minted traces via [[ phrase | nodeId ]], and citing the source itself
   *  via `replyingTo` (spec §reply-to delta type) so the reply chain
   *  stays legible from the trace alone. The response is streamed into the
   *  new file's runs as it arrives. Placement: the sibling opens in a fresh
   *  column immediately to the right of the source panel (`idx`) — auto-spawning
   *  that column first so the reply always lands alongside its origin.
   *  The model names the file via a leading `TITLE:` line (see
   *  RESPOND_MESSAGES); we open under a temp path and rebase once the title
   *  arrives. The TITLE line is stripped from the sealed body. */
  async function replyLLM(idx: number) {
    if (!folder) return;
    // Reply writes into a new file (not the live editor) so there's no facet
    // to reconfigure — the inject voice's pubkey is baked into the run we write.
    const writeVoice = injectPubkey;
    const provider = resolveOpProvider(idx, writeVoice);
    if (!provider) return;
    setOpStatus(idx, "running");
    // The inject voice's secret — signs both the genesis writeFile below and
    // the release catch-up seal, so the response lands on the relay as the
    // inject voice, not the keychain's active (pen) key.
    const signer = secretKeyForVoice(writeVoice) ?? undefined;
    // Arm the seal gate: per-delta editFile calls would otherwise trigger
    // intermediate seals (same rate-limit pattern Extend hits). Released in
    // finally, which fires one catch-up seal for the final content, signed as
    // the inject voice via `signer`.
    opSignerRef.current = signer;
    sealGateRef.current(true);
    const controller = new AbortController();
    summonAbort.current[idx] = controller;
    // Hoisted so the finally block can release the rescan-pending hold even
    // if we throw before assigning it. May be rebased mid-stream when the
    // model supplies a TITLE.
    let newPath = "";
    try {
      const view = panelViews.current[idx];
      const srcRel = panels[idx].active || "";
      // Seal the source doc under the pen key before the model runs, so the
      // response is anchored to a signed baseline (see extendLLM). The source
      // is what the model replies to; Reply's own output writes to newPath.
      {
        const signer = secretKeyForVoice(penPubkey);
        if (srcRel && files[srcRel] && signer) await sealNow(srcRel, signer);
      }
      await prepareLlmMeta(idx, "reply", provider);
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
      // Pull the palette so the model can cite minted traces by nodeId.
      let palette: PaletteItem[] = [];
      try {
        palette = await fetchPalette();
      } catch {
        /* no palette is fine — the response just won't carry citations */
      }
      const traces = palette.slice(0, 20).map((p) => `- "${p.text}" (nodeId ${p.nodeId})`).join("\n");
      const ctx = await gatherContextForPanel(idx);
      const messages = withContext(ctx, withVoicePrompt(writeVoice, RESPOND_MESSAGES(sourceText, traces)));
      // Open under a temporary sibling name; rebase to the LLM TITLE once the
      // first line arrives. Keep the source's directory so the response lands
      // next to its origin (e.g. notes/essay.md -> notes/<title>.md).
      const sourceName = srcRel || "doc.md";
      // The source's sealed head at the moment Reply runs — pinned into the
      // response's own genesis node via `replyingTo` below, so the citation
      // stays honest even if the source is edited further afterward.
      const sourceNodeId = files[srcRel]?.nodeId || undefined;
      const slash = sourceName.lastIndexOf("/");
      const srcDir = slash >= 0 ? sourceName.slice(0, slash + 1) : "";
      const stem = sourceName.replace(/\.md$/, "").split("/").pop() || "doc";
      newPath = `${srcDir}${stem}-reply-${Date.now().toString(36)}.md`;
      const taken = new Set(Object.keys(files));
      taken.add(newPath);
      let titled = false;

      /** Rebase the optimistic in-memory path (not yet on disk) when the
       *  TITLE arrives. Disk write happens once at the end under final newPath. */
      const rebaseOptimisticPath = (from: string, to: string) => {
        if (from === to) return;
        pendingPaths.current.delete(from);
        pendingPaths.current.add(to);
        setFiles((prev) => {
          const next = { ...prev };
          if (next[from]) {
            next[to] = next[from];
            delete next[from];
          }
          return next;
        });
        setPanels((prev) =>
          prev.map((panel) => ({
            tabs: panel.tabs.map((p) => (p === from ? to : p)),
            active: panel.active === from ? to : panel.active,
          })),
        );
        setTabModes((prev) => {
          if (!(from in prev)) return prev;
          const next = { ...prev };
          next[to] = next[from];
          delete next[from];
          return next;
        });
        // Carry resolved-citation state across the rename so the cited-trace
        // chips reappear on the new path without a refetch.
        setCitationsByPath((prev) => {
          if (!(from in prev)) return prev;
          const next = { ...prev };
          next[to] = next[from];
          delete next[from];
          return next;
        });
        setCitationHeadByPath((prev) => {
          if (!(from in prev)) return prev;
          const next = { ...prev };
          next[to] = next[from];
          delete next[from];
          return next;
        });
      };

      const applyReplyText = (raw: string, streamDone: boolean) => {
        const parsed = parseReplyOutput(raw, streamDone);
        if (parsed.headerDone && parsed.title && !titled) {
          titled = true;
          const dest = uniquePath(
            `${srcDir}${slugifyFilename(parsed.title.replace(/\.md$/i, ""))}.md`,
            taken,
          );
          taken.add(dest);
          const from = newPath;
          newPath = dest;
          rebaseOptimisticPath(from, dest);
        }
        // While the TITLE line is still buffering, keep the editor empty so
        // the header never flashes into the document body.
        editFile(newPath, [{ voice: writeVoice, text: parsed.body }]);
      };

      // Mark this path as pending so a mid-stream rescan (5s interval or window
      // focus) doesn't drop the optimistic file before writeFile persists it —
      // same protection scheduleSeal gives to user edits. Cleared in finally.
      pendingPaths.current.add(newPath);
      // Optimistic empty file so the editor opens immediately.
      editFile(newPath, [{ voice: writeVoice, text: "" }]);
      // Land the response in a fresh column immediately to the right of the
      // source panel (`idx`) so the reply always appears alongside its origin,
      // not just when a spare column already exists. spawnPanel reconciles all
      // parallel per-panel structures; openInPanel fills the new column.
      const destIdx = idx + 1;
      spawnPanel(destIdx);
      openInPanel(newPath, destIdx);
      let acc = "";
      const full = await complete(provider, messages, {
        maxTokens: 1024,
        signal: controller.signal,
        onDelta: (delta) => {
          acc += delta;
          applyReplyText(acc, false);
        },
      });
      const rawFinal = acc || full || "";
      applyReplyText(rawFinal, true);
      // Persist + seal the new file, citing the source's sealed head via
      // `replyingTo` (spec §reply-to delta type) so the reply chain is
      // legible from the trace alone, not just from sibling placement.
      // Signed as the inject voice (`signer`) so the genesis node's author is
      // the replying voice, not the manual (pen) default.
      const finalText = parseReplyOutput(rawFinal, true).body;
      try {
        await backendRef.current.writeFile(newPath, finalText, [], signer, undefined, sourceNodeId);
      } catch (e) {
        console.warn(`[reply] writeFile failed for ${newPath}:`, e);
      }
      setOpStatus(idx, "done");
    } catch (e) {
      if (controller.signal.aborted) {
        setOpStatus(idx, "idle");
        return;
      }
      setOpStatus(idx, "error", e instanceof Error ? e.message : String(e));
    } finally {
      summonAbort.current[idx] = null;
      // Release the seal gate armed on entry. The catch-up seal fires once
      // for newPath, signed as the inject voice; the explicit writeFile above
      // already persisted, so this is de-duped by pushToRelay's content-hash
      // check (no double publish). Deferred one macrotask so React commits the
      // final setFiles first (same rationale as endOp) — otherwise the catch-up
      // seal reads stale content and the debounce re-seals the tail.
      const signer = opSignerRef.current;
      opSignerRef.current = undefined;
      setTimeout(() => sealGateRef.current(false, signer), 0);
      // Release the rescan-pending hold once the stream + persist have
      // settled (success or abort/error). Subsequent rescans then reconcile
      // from disk normally.
      if (newPath) pendingPaths.current.delete(newPath);
    }
  }

  /** Dispatch a top-bar action to the op-target panel. The LLM ops seal their
   *  output as the inject voice; Save/zine seal as the pen voice. */
  function runOp(idx: number, op: OpKind) {
    if (op === "extend") void extendLLM(idx);
    else if (op === "settle") void settleLLM(idx);
    else if (op === "stir") void stirLLM(idx);
    else if (op === "reply") void replyLLM(idx);
    else if (op === "save" || op === "zine") void deliverAsVoice(idx);
  }

  /** Resolve which panel an op should target given the current selection.
   *  Prefer a panel where the selected file is the *active* tab — that's the
   *  panel whose CodeMirror view is actually mounted (FileEditor mounts only
   *  for a panel's active tab), so extend/settle/stir (which stream via
   *  view.dispatch) get a live editor. Only fall back to a panel that holds
   *  the file as a background tab, then to the focused panel. A folder/span
   *  selection has no file tab to match, so it goes straight to the focused
   *  panel. Clamped to a valid index. The top bar's ACTIONS row calls this to
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

  /** Seal the panel's active file as a deliberate checkpoint, signed as `voice`.
   *  Save and zine share this path today — both flush the 1.5s debounce and
   *  seal the trace under the clicked voice's key. zine is destined to become a
   *  distinct publish+sign action (spec: send = full send), but until that
   *  wiring lands it routes here too; the buttons stay separate so the
   *  vocabulary doesn't drift. */
  async function deliverAsVoice(idx: number) {
    const pubkey = penPubkey;
    const path = panels[idx]?.active;
    if (!path || !files[path]) return;
    const signer = secretKeyForVoice(pubkey);
    if (!signer) {
      setOpStatus(idx, "error", `no key for voice ${pubkey.slice(0, 8)}…`);
      return;
    }
    setOpStatus(idx, "running");
    try {
      await sealNow(path, signer);
      setOpStatus(idx, "done");
    } catch (e) {
      console.warn(`[deliver] seal failed for ${path} as ${pubkey.slice(0, 8)}…:`, e);
      setOpStatus(idx, "error", e instanceof Error ? e.message : String(e));
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
  // On mount: if a folder is already attached (remembered in localStorage),
  // attach via the backend (disk+scan on desktop, relay read on webapp) and
  // open the first file. If not, show the empty state — the desktop offers a
  // native folder picker, the webapp offers create-new / join-by-id. Re-runs
  // when the user picks a new folder (doAttach / attachRef).

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
    const fallback: { panels: PanelState[]; activePanel: number; weights: number[]; tabModes: Record<string, "preview" | "markdown"> } = {
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
    // double openScanned: webAutoOpen → attachRef calls openScanned, then the
    // [folder?.id] effect re-attaches and calls openScanned again; the second
    // pass wiped slots whose FileEditors never remounted. Copy forward by
    // index; new/extra slots stay null until their editor mounts, and slots
    // whose panel genuinely disappeared are dropped (their FileEditor unmounts
    // and onView(null) clears the stray entry harmlessly).
    const prevViews = panelViews.current;
    panelViews.current = layout.panels.map((_, i) => prevViews[i] ?? null);
    summonAbort.current = layout.panels.map(() => null);
    setTabModes(layout.tabModes);
    setActivePanel(layout.activePanel);
    // Mark every scanned file as already-sealed so the first debounce tick
    // doesn't re-publish the whole folder (these files came from disk/relay
    // already published — their nodeId proves it). This is what stops the boot
    // fanout from tripping the relay rate-limit.
    seedSealedRef.current(scanned);
    ready.current = true; // allow the debounce effect to publish subsequent edits
  }

  /** Desktop attach: pick a disk path and baseline-scan it. */
  async function doAttach(absPath: string) {
    setBootState("scanning");
    setBootError(null);
    try {
      const { folder: attached, files: scanned } = await attachFolder(absPath);
      setFolder(attached);
      setFiles(scanned);
      openScanned(scanned, attached.id);
      setBootState("ready");
    } catch (e) {
      setBootError(e instanceof Error ? e.message : String(e));
      setBootState("idle");
    }
  }

  /**
   * Attach via a FolderRef using the active backend. Used by the webapp
   * (create-new / join-by-id) and as the re-scan path on boot. Records the
   * folder in the known-folders list and marks it active.
   */
  async function attachRef(ref: AttachedFolder) {
    setBootState("scanning");
    setBootError(null);
    try {
      const { files: scanned } = await backendRef.current.attach(ref);
      setFolder(ref);
      setFiles(scanned);
      openScanned(scanned, ref.id);
      rememberFolder(ref);
      setActiveFolder(ref.id);
      setBootState("ready");
      // Foreign-folder detection (webapp only): a folder is foreign when its
      // latest 4292 head is signed by someone other than the active voice. Such
      // a folder opens read-only until the user forks it. A forked folder
      // (ref.forkedFrom set) is the user's own — never foreign. Desktop folders
      // live on disk the user owns, so they're never foreign either.
      if (!isTauri() && !ref.forkedFrom) {
        void detectForeignFolder(ref.id).then(setIsForeignFolder);
      } else {
        setIsForeignFolder(false);
      }
      // Webapp: background relay pull. The editor is already usable from
      // localStorage (above); this merges in any newer remote content without
      // blocking. Desktop doesn't need this — its rescan handles disk/relay.
      if (!isTauri()) {
        void pullFromRelay(ref.id).then((updated) => {
          if (updated.size === 0) return;
          const fresh = loadLocalFolder(ref.id);
          if (!fresh) return;
          setFiles((prev) => {
            const next = { ...prev };
            for (const path of updated) {
              const lf = fresh.files[path];
              if (!lf) { delete next[path]; continue; }
              if (pendingPaths.current.has(path)) continue; // don't clobber mid-edit
              // Carry the per-author run list that `pullFromRelay` already
              // reconstructed from the chain (author-aware: adopts a node's
              // `authors` map, falls back to per-node-signer). The earlier form
              // rebuilt a single activeVoice() run from lf.content here, which
              // discarded that attribution — the next seal then serialized a
              // single-voice authors map and every prior author was gone, which
              // is what made replay collapse to one voice. Validating runs
              // against content (flatten == lf.content) guards against a stale
              // sidecar from an out-of-band edit; on mismatch we fall back to a
              // single run, same as baselineScan. Carry `taggedTraces` from the
              // relay-pulled local file so a tag-add survives the merge (the
              // scan re-derives it from the chain head via headTaggedTraces).
              const pulledRuns =
                lf.runs && lf.runs.length > 0 && flatten(lf.runs) === lf.content
                  ? lf.runs
                  : [{ voice: manualVoice(), text: lf.content }];
              next[path] = {
                runs: pulledRuns,
                nodeId: lf.nodeId,
                tags: lf.tags,
                ...(lf.taggedTraces && lf.taggedTraces.length > 0
                  ? { taggedTraces: lf.taggedTraces }
                  : {}),
              };
            }
            return next;
          });
        });
      }
    } catch (e) {
      setBootError(e instanceof Error ? e.message : String(e));
      setBootState("idle");
    }
  }

  /** Webapp: create a brand-new folder. Local-first — instant, no relay
   *  round-trip. The relay manifest is created lazily on the first file push
   *  (or the background pull creates it if needed). */
  async function webCreateFolder(label?: string) {
    setBootError(null);
    // Phase 5: publish genesis first, adopt its event id as the folder identity
    // (spec §3.1). Replaces the pre-Phase-5 UUID mint. Legacy UUID-keyed
    // folders in the registry keep working via the #D arm of fetchFolderNodes.
    const id = await createFolderGenesis();
    rememberFolder({ id, label: label?.trim() || undefined });
    await attachRef({ id, label: label?.trim() || undefined });
  }

  /** Webapp: nuke the current folder and provision a fresh one. The relay is
   *  append-only — the old folder's chain is immutable and stays under its old
   *  id, abandoned rather than deleted — so "reset" means minting a brand-new
   *  folderId (via webCreateFolder) and dropping the old one from the registry.
   *  attachRef/openScanned rebuild folder/files/panels, but several pieces of
   *  UI state aren't keyed by folder id and would otherwise carry over
   *  (selection, replay, citations, the seals modal, collapsed-tree rows) —
   *  clear them explicitly so the fresh folder starts clean. */
  async function resetWorkspace() {
    if (isTauri()) return; // desktop has no relay-folder concept to reset
    if (folder) forgetFolder(folder.id);
    setSelection(null);
    setEditorSelection(null);
    setCollapsed(new Set());
    setReplay(null);
    setPlaying(false);
    setSealsModal(null);
    setCitationsByPath({});
    setCitationHeadByPath({});
    setTaggedChipByPath({});
    setInboundByPath({});
    setInboundHeadByPath({});
    setEmptyFolders(new Set());
    setTabCtxMenu(null);
    await webCreateFolder();
  }

  /** Webapp: join an existing folder by id (e.g. copied from the desktop). */
  async function webJoinFolder(id: string) {
    setBootError(null);
    const trimmed = id.trim();
    if (!trimmed) return;
    try {
      await attachRef({ id: trimmed, label: findFolder(trimmed)?.label });
    } catch (e) {
      setBootError(e instanceof Error ? e.message : String(e));
    }
  }

  /** Open a folder from the Stacks index in the press. The index carries only
   *  a folderId (no disk path), so:
   *  - Webapp: attach directly from the relay by id (webJoinFolder).
   *  - Desktop: ask for the disk folder, then bind the relay id to that path
   *    (attachRef with the explicit id keeps provenance continuous — a fresh
   *    uuid would fork the folder). Either way, switch to the editor view. */
  async function openFromStacks(folderId: string) {
    try {
      if (isTauri()) {
        const picked = await chooseFolder();
        if (!picked) return; // user cancelled
        await attachRef({ id: folderId, path: picked });
      } else {
        await webJoinFolder(folderId);
      }
      setActiveView("editor");
    } catch (e) {
      setBootError(e instanceof Error ? e.message : String(e));
      setBootState("idle");
    }
  }

  /** Returns true if the folder's latest 4292 head is signed by someone other
   *  than the active voice — the read-only/foreign signal. False for folders
   *  with no published head yet (fresh, local-only — not foreign). */
  async function detectForeignFolder(folderId: string): Promise<boolean> {
    const owner = await fetchFolderOwner(folderId);
    return owner !== null && owner !== manualVoice();
  }

  /** Fork the currently-attached foreign folder into the user's own namespace.
   *  Seeds a shallow fork (cites the source's members), then attaches to the
   *  new fork — which is editable. Untouched members stay cited to the source
   *  owner until fork-on-write fires on first edit. See protocol §Forking. */
  async function forkCurrentFolder() {
    if (!folder || !isForeignFolder) return;
    setBootError(null);
    const sourceId = folder.id;
    const derivedLabel = folder.label ? `${folder.label} (fork)` : `Fork of ${sourceId.slice(0, 8)}`;
    try {
      // Phase 5: fork as genesis (destFolderId null) — forkFolder publishes the
      // fork's genesis node and returns it; its event id becomes the new folder
      // identity. Replaces the pre-Phase-5 UUID mint.
      const genesisEvent = await forkFolder(sourceId, null);
      await attachRef({ id: genesisEvent.id, label: derivedLabel, forkedFrom: sourceId });
    } catch (e) {
      setBootError(e instanceof Error ? e.message : String(e));
    }
  }

  /** Branch detection for the active file: scan for incoming forks and sibling
   *  heads. No-op on foreign folders (we don't own the chain) or empty path. */
  async function refreshMergeCandidates(folderId: string, relativePath: string) {
    if (!relativePath || isForeignFolder) {
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

  /** Apply a sealed merge into editor + local store. Shared by no-conflict
   *  incorporate and the three-way panel's Seal merge. */
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
        : [{ voice: manualVoice(), text: snapshot }]);
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
    seedSealedRef.current({ [path]: nextFile });
    await refreshMergeCandidates(folder!.id, path);
  }

  /** Unilateral incorporate (protocol §3.8). No-conflict: full-adopt theirs.
   *  Conflict/sibling: open three-way reconcile panel. */
  async function incorporateCandidate(candidate: MergeCandidate) {
    if (!folder || mergeBusy) return;
    const path = panels[activePanel]?.active;
    if (!path) return;
    setBootError(null);

    if (!candidate.noConflict) {
      // Open three-way UI with base / ours / theirs.
      try {
        const sides = await loadMergeSides(folder.id, path, candidate);
        setMergeSession({ candidate, base: sides.base, ours: sides.ours, path });
      } catch (e) {
        setBootError(e instanceof Error ? e.message : String(e));
      }
      return;
    }

    setMergeBusy(true);
    try {
      const event = await incorporateMergeCandidate(folder.id, path, candidate);
      await applyMergedToWorkspace(path, event, candidate.snapshot, candidate);
    } catch (e) {
      setBootError(e instanceof Error ? e.message : String(e));
    } finally {
      setMergeBusy(false);
    }
  }

  /** Seal from the three-way panel with a resolved snapshot. */
  async function sealReconciledMerge(resolvedSnapshot: string) {
    if (!folder || !mergeSession || mergeBusy) return;
    const { candidate, path } = mergeSession;
    setMergeBusy(true);
    setBootError(null);
    try {
      const event = await incorporateMergeCandidate(folder.id, path, candidate, {
        snapshot: resolvedSnapshot,
        force: true,
      });
      await applyMergedToWorkspace(path, event, resolvedSnapshot, candidate);
      setMergeSession(null);
    } catch (e) {
      setBootError(e instanceof Error ? e.message : String(e));
    } finally {
      setMergeBusy(false);
    }
  }

  /**
   * Webapp boot: open the most recently used folder if there is one, else
   * provision a fresh one. If the most-recent folder can't be opened (e.g. a
   * stale desktop folder that was never on the relay, or the relay is
   * unreachable), fall through to provisioning a new one rather than leaving
   * the user stuck on a loading/error screen. This is what makes the webapp
   * "just work" — you always land in the editor.
   */
  async function webAutoOpen() {
    const known = listFolders();
    const activeId = getActiveFolder();
    const ref = (activeId && findFolder(activeId)) || known[0];
    if (ref) {
      try {
        const { files: scanned } = await backendRef.current.attach(ref);
        setFolder(ref);
        setFiles(scanned);
        openScanned(scanned, ref.id);
        rememberFolder(ref);
        setActiveFolder(ref.id);
        setBootState("ready");
        return;
      } catch {
        // Stale or unreachable — forget it and provision fresh below.
        forgetFolder(ref.id);
      }
    }
    await webCreateFolder();
  }

  useEffect(() => {
    if (!folder) {
      if (isTauri()) {
        // Desktop: offer a default ($HOME/zine) so a user can start without
        // the picker.
        void defaultFolder().then(setDefaultPath);
      } else {
        // Webapp: drop straight into the editor. Open the most recent folder
        // (or provision one on first visit).
        void webAutoOpen();
      }
      return;
    }
    let cancelled = false;
    (async () => {
      setBootState("scanning");
      try {
        // Re-attach through the backend so both the disk path (desktop) and
        // the relay read (webapp) reconcile against the current manifest.
        const { files: scanned } = await backendRef.current.attach(folder);
        if (cancelled) return;
        setFiles(scanned);
        openScanned(scanned, folder.id);
        setBootState("ready");
      } catch (e) {
        if (cancelled) return;
        // The attached folder can no longer be read (disk path moved/deleted
        // on desktop, or the relay is unreachable). Forget it and let the
        // user pick / join again.
        detachFolder();
        setFolder(null);
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
        if (!st.operator) setOperatorSetup("boot");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // --- external-change detection (desktop) --------------------------------
  //
  // Disk edits made outside this app (another editor, git pull, a save from
  // the webapp syncing back) need to be detected and propagated to the relay.
  // Two triggers, both desktop-only (the webapp reads the relay directly, so
  // there's nothing external to watch):
  //   - window focus: catch changes made while we were backgrounded
  //   - a 5s interval poll: catch changes while we stay focused (e.g. a build
  //     tool rewriting files)
  //
  // The rescan re-runs `backend.attach` (baselineScan on desktop diffs disk
  // vs the relay manifest and seals import/edit/delete nodes for any drift).
  // Then it merges into `files` WITHOUT clobbering a file the user is mid-edit
  // on — the debounce effect's content-hash guard (writeFile no-ops on a match)
  // makes this safe even if it does fire.

  async function rescan() {
    if (!folder || bootState !== "ready") return;
    const startedAtFolderId = folder.id;
    try {
      const { files: scanned } = await backendRef.current.attach(folder);
      // Bail if the user switched folders while this rescan's attach was in
      // flight — otherwise folder A's scan would clobber folder B's freshly-
      // loaded `files` (the leak: "first folder's contents still injected").
      if (folderIdRef.current !== startedAtFolderId) return;
      setFiles((prev) => {
        // Double-guard inside the updater: a switch can land between the check
        // above and React flushing this update.
        if (folderIdRef.current !== startedAtFolderId) return prev;
        const next: Record<string, FileState> = {};
        // Carry over optimistic paths that live in memory but aren't on disk
        // yet — the prime case is a streaming reply file: replyLLM creates
        // it in React state (editFile) and only persists to disk after the
        // stream finishes (writeFile). The scan can't see it, so without this
        // pass a mid-stream rescan would drop it from `files` → the FileEditor
        // unmounts and the panel goes blank mid-stream ("types a few chars then
        // stops"). pendingPaths marks exactly these in-flight paths; mirror the
        // webapp pull's {...prev} protection (see pullFromRelay) for them.
        for (const [path, state] of Object.entries(prev)) {
          if (!(path in scanned) && pendingPaths.current.has(path)) {
            next[path] = state;
          }
        }
        for (const [path, state] of Object.entries(scanned)) {
          const prevPath = prev[path];
          if (prevPath && flatten(prevPath.runs) === flatten(state.runs)) {
            // Same content as what's in the editor — keep the live per-voice
            // attribution rather than the scan's reconstruction. Attribution IS
            // persisted now (LocalFile.runs on webapp, .zine/attribution.json
            // sidecar on desktop), so the scan usually carries the same runs —
            // but the live editor runs may be ahead (edited since the last seal
            // landed), so prefer them when content matches. Only refresh the
            // node id/tags the scan may have updated. Preserve the live
            // `taggedTraces` too: a tag-add-only seal (no content change) reads
            // back from the chain, but the relay echo lags the optimistic edit
            // by one rescan tick — taking the scan's value here would drop the
            // tag mid-flight, then the next seal would republish without it.
            next[path] = {
              runs: prevPath.runs,
              nodeId: state.nodeId,
              tags: state.tags,
              taggedTraces: prevPath.taggedTraces,
            };
          } else if (pendingPaths.current.has(path) && prevPath) {
            // Preserve an actively-edited file: if a seal is pending, the
            // user's in-editor content is newer than disk — keep it, let the
            // debounce path win.
            next[path] = prevPath;
          } else {
            // Genuine external edit: take the freshly-scanned state.
            next[path] = state;
          }
        }
        return next;
      });
    } catch {
      // A failed rescan (e.g. transient relay hiccup) shouldn't disrupt the
      // editor — the next focus/interval tick will retry.
    }
  }

  // Desktop-only watchers. The webapp has no disk; its source of truth is the
  // relay, polled on each open.
  useEffect(() => {
    if (!isTauri()) return;
    const onFocus = () => void rescan();
    window.addEventListener("focus", onFocus);
    const interval = window.setInterval(() => void rescan(), 5000);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folder?.id, bootState]);

  // Spaces (Globe) dispatches this when a zine pin is clicked — the Globe stays
  // decoupled from the shell (no App import), and this listener routes the
  // folder id through the same openFromStacks path the Stacks cards use.
  useEffect(() => {
    const onOpen = (e: globalThis.Event) => {
      const id = (e as globalThis.CustomEvent<string>).detail;
      if (typeof id === "string") void openFromStacks(id);
    };
    window.addEventListener("zine:open-folder", onOpen);
    return () => window.removeEventListener("zine:open-folder", onOpen);
    // eslint-disable-next-line react-hooks/exhaustive-deps
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


  // User chose a folder via the picker. Wrapped so a backend error (Tauri
  // command missing/failed) surfaces as bootError rather than an unhandled
  // rejection that looks like "the button did nothing."
  async function onChooseFolder() {
    try {
      const picked = await chooseFolder();
      if (!picked) return; // user cancelled
      await doAttach(picked);
    } catch (e) {
      setBootError(e instanceof Error ? e.message : String(e));
      setBootState("idle");
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
  // spans just record the selection (folders are not editors; a minted span
  // may belong to a file that is already open). The file's kind-4290 nodeId is
  // pulled from its FileState when present so ops can address the nucleus.
  function selectFile(path: string) {
    openInActivePanel(path);
    setSelection({ kind: "file", path, nodeId: files[path]?.nodeId });
  }
  function selectFolder(path: string) {
    // Under nesting (spec §3.2), a folder-member FileState carries the
    // subfolder's genesis as nodeId. Carrying it on the selection lets ops
    // (Send, tag, cite) address a folder-member nucleus, symmetric with
    // selectFile. Legacy/synthesized folders have no nodeId — undefined is fine.
    setSelection({ kind: "folder", path, nodeId: files[path]?.nodeId });
  }
  function selectSpan(nodeId: string, phrase: string) {
    setSelection({ kind: "span", nodeId, phrase });
  }
  /** Curate a minted span into the palette. Triggered by the copy button on
   *  a citation chip (Preview mode) — the chip still owns its own clipboard
   *  write (so copy stays a pasteable citation), and this is the "also save for
   *  reuse" side effect. `appendToPalette` is idempotent (deduped by nodeId), so
   *  re-copying an already-curated span is a no-op. Fire-and-forget; on success
   *  the refresh key bumps so PalettePanel re-fetches and surfaces the entry. */
  function copySpan(nodeId: string, phrase: string, originPath: string) {
    appendToPalette({
      nodeId,
      text: phrase,
      originPath,
      mintedAt: Date.now(),
    })
      .then(() => setPaletteRefreshKey((k) => k + 1))
      .catch((e) => console.warn("[zine] palette append failed:", e));
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
  // AUTOMATIC op buttons (Extend/Settle/Stir/Reply) follow what the user is
  // actually looking at. Selection is otherwise only set by explicit entry
  // points (sidebar, palette, tab click), so without this it desyncs from focus
  // — fresh boot left selection null (all ops disabled), and clicking into a
  // background panel left it pointing at a stale/folder trace. This mirrors the
  // gold-outline effect in Sidebar (which already follows activeTracePath), so
  // the buttons and the outline now agree.
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

  // Record selection/panel-mount as a `focus` delta — the replay primitive for
  // reconstructing a reading session in the press editor (protocol
  // §FolderTraceNode Content — focus). Debounced so a flurry of clicks collapses
  // to the resting focus, not one node per click; and deduped against the last
  // emitted focus so a no-op re-selection (e.g. the nodeId-freshness effect
  // above re-setting the same file) doesn't spam the chain. Each observation is
  // routed to the folder that OWNS the focused path (not "the active folder"),
  // so a file from one folder sitting in a panel never contaminates another
  // folder's replay. Unowned paths (scratch buffers, stale selections) are
  // dropped — focus is an observation, never worth blocking the UI (§3.3).
  useEffect(() => {
    if (!selection) return;
    // Build the wire selection. A span's originPath is the file the user was
    // viewing when they selected the quote — the focused panel's active tab.
    let focusSel: FocusSelection;
    if (selection.kind === "file") {
      focusSel = { kind: "file", path: selection.path ?? "", nodeId: selection.nodeId };
    } else if (selection.kind === "folder") {
      focusSel = { kind: "folder", path: selection.path ?? "", nodeId: selection.nodeId };
    } else {
      const hostTab = panels[activePanel]?.active ?? "";
      focusSel = {
        kind: "span",
        nodeId: selection.nodeId ?? "",
        phrase: selection.phrase ?? "",
        originPath: isFolderTab(hostTab) ? "" : hostTab,
      };
    }
    // Resolve the owner of what's focused. A folder selection IS the target —
    // it routes to the active folder. A file/span selection routes to whoever
    // owns the file's path. `activeMounted` builds the single-folder snapshot
    // today; multi-mount will generalize it at the caller (see focus-routing.ts).
    const rawFocusPath = selection.kind === "folder"
      ? null
      : selection.kind === "file" ? selection.path
      : focusSel.kind === "span" ? focusSel.originPath
      : null;
    const focusPath = rawFocusPath && rawFocusPath.length > 0 ? rawFocusPath : null;
    const mounted = activeMounted(folder?.id ?? null, Object.keys(files));
    const owner = focusPath === null
      ? folderIdRef.current   // folder focus → active folder (or null → dropped)
      : ownerFolderOf(focusPath, mounted);
    if (!owner) return;       // unowned → drop (advisory, legal)
    // Dedupe: skip if identical (by value) to the last focus we published.
    const key = JSON.stringify({ focusSel, panelIndex: activePanel });
    if (lastFocusKeyRef.current === key) return;
    lastFocusKeyRef.current = key;

    const handle = window.setTimeout(() => {
      // Re-check ownership survived the debounce window: the owner is still the
      // active folder (for a folder selection) or still owns the path (for a
      // file/span selection — the file may have been unmounted or the folder
      // detached during the 1s). Stale → drop, don't write a bogus observation.
      const stillOwned = focusPath === null
        ? folderIdRef.current === owner
        : ownerFolderOf(focusPath, activeMounted(folder?.id ?? null, Object.keys(files))) === owner;
      if (!stillOwned) return;
      // Queue a `focus` observation onto the OWNER's pending buffer; it is
      // drained onto the next folder seal (§7/§8), so no explicit publish here.
      bufferFocus(owner, {
        type: "focus",
        selection: focusSel,
        panelIndex: activePanel,
        timestamp: Date.now(),
      });
    }, 1000);
    return () => window.clearTimeout(handle);
  }, [selection, activePanel, panels, files, folder]); // eslint-disable-line react-hooks/exhaustive-deps

  // §8 session-close checkpoint: when the page unloads, flush any focus
  // observations still in the buffer (no real seal came along to drain them) as
  // a dedicated action:focus node. Browsers won't await async work in
  // beforeunload, so this is best-effort — focus is telemetry, not integrity;
  // a missed flush just means those observations were never recorded. Fires
  // once per unload regardless of which folder was prime, on the current one.
  useEffect(() => {
    const handler = () => {
      const fid = folderIdRef.current;
      if (fid) void flushFocusCheckpoint(fid).catch(() => {});
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
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
  // via `resolveNodeName`. This subsumes the old single reply-to resolution:
  // a Reply is one more cited trace, not a special case. Re-resolves only
  // when the head node id actually moved (a new seal changed the citation
  // set); `resolveNodeName` itself caches per node id across files, so a trace
  // cited from many docs resolves once for the session.
  useEffect(() => {
    if (!folder) return;
    const activePaths = panels
      .map((p) => p.active)
      .filter((p): p is string => !!p && !isFolderTab(p));
    // A path needs resolution if it's new, or its head node changed since last
    // resolve. file.nodeId is "" before the first seal this session — skip
    // those; there's no head to read citations off yet.
    const pending = [...new Set(activePaths)].filter((p) => {
      const headId = files[p]?.nodeId ?? "";
      if (!headId) return false;
      return citationHeadByPath[p] !== headId;
    });
    if (pending.length === 0) return;
    let cancelled = false;
    void (async () => {
      const updates: Record<string, CitationChip[]> = {};
      const headUpdates: Record<string, string> = {};
      for (const path of pending) {
        const headId = files[path]?.nodeId ?? "";
        if (!headId) continue;
        try {
          const head = await fetchEventById(headId);
          const targets = head ? eventMeta(head).citationTargets : [];
          const chips: CitationChip[] = [];
          for (const nodeId of targets) {
            const chip = await resolveNodeName(nodeId);
            if (chip) chips.push(chip);
          }
          updates[path] = chips;
          headUpdates[path] = headId;
        } catch {
          updates[path] = [];
          headUpdates[path] = headId;
        }
      }
      if (cancelled) return;
      if (Object.keys(updates).length > 0) {
        setCitationsByPath((prev) => ({ ...prev, ...updates }));
        setCitationHeadByPath((prev) => ({ ...prev, ...headUpdates }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [panels, folder, files, citationHeadByPath]);

  // Resolve the tagged traces for each currently-active file — `file.taggedTraces`
  // (the `tag-add` subset) — into named chips. Unlike `citationsByPath` (which
  // waits for a head move), this is keyed on the tagged id set itself, so a
  // just-tagged trace shows in the tag section immediately, before the debounce
  // seals a new head. Skips paths whose tagged set is already fully resolved.
  // A tagged trace may be an unpublished local savepoint or a published zine —
  // both are sealed nodes and resolve uniformly via `resolveNodeName`.
  useEffect(() => {
    const activePaths = panels
      .map((p) => p.active)
      .filter((p): p is string => !!p && !isFolderTab(p));
    const pending = [...new Set(activePaths)].filter((p) => {
      const ids = files[p]?.taggedTraces ?? [];
      const resolved = taggedChipByPath[p] ?? [];
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
      for (const path of pending) {
        const ids = files[path]?.taggedTraces ?? [];
        const chips: CitationChip[] = [];
        for (const nodeId of ids) {
          const chip = await resolveNodeName(nodeId);
          if (chip) chips.push(chip);
        }
        updates[path] = chips;
      }
      if (cancelled) return;
      if (Object.keys(updates).length > 0) {
        setTaggedChipByPath((prev) => ({ ...prev, ...updates }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [panels, files, taggedChipByPath]);

  // Resolve the inbound tracker for each currently-active file — forks of it,
  // traces that tag it, traces that cite it (the inverse of the outbound
  // citation/tag resolution above). Re-resolves only when the head node id
  // moved: cites/tags pin a specific nucleus, so a new seal can change the
  // inbound set. findInbound is two chunked reverse lookups (#e for forks, #q
  // for tags+cites) over the chain — fine for localhost, debounced by the
  // head-id gate, and never run per keystroke (only on a sealed head move).
  useEffect(() => {
    if (!folder) return;
    const activePaths = panels
      .map((p) => p.active)
      .filter((p): p is string => !!p && !isFolderTab(p));
    const pending = [...new Set(activePaths)].filter((p) => {
      const headId = files[p]?.nodeId ?? "";
      if (!headId) return false;
      return inboundHeadByPath[p] !== headId;
    });
    if (pending.length === 0) return;
    let cancelled = false;
      void (async () => {
        const updates: Record<string, TraceInbound[]> = {};
        const headUpdates: Record<string, string> = {};
        for (const path of pending) {
          // Same coords findMergeCandidates takes (line ~5281): the root folder
          // id + the slash-joined displayPath. findInbound does the same #F+#D
          // chain fetch internally, so it accepts the displayPath as-is.
          try {
            updates[path] = await findInbound(folder!.id, path);
            headUpdates[path] = files[path]?.nodeId ?? "";
          } catch {
            updates[path] = [];
            headUpdates[path] = files[path]?.nodeId ?? "";
          }
        }
      if (cancelled) return;
      if (Object.keys(updates).length > 0) {
        setInboundByPath((prev) => ({ ...prev, ...updates }));
        setInboundHeadByPath((prev) => ({ ...prev, ...headUpdates }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [panels, folder, files, inboundHeadByPath]);

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

  /** Fetch a file's full seal chain and open the Seals modal on it.
   *  `pinnedEventId`, when given, seeds the modal's selected index at that
   *  exact node (used by a cited-trace chip) rather than the head. */
  async function openSeals(relativePath: string, pinnedEventId?: string) {
    if (!folder) return;
    const chain = await fetchChain(folder.id, relativePath);
    if (chain.length === 0) return;
    setSealsModal({ relativePath, chain, pinnedEventId });
  }

  /** A cited-trace chip's click handler: resolve the cited node's own path
   *  (from its `file`/`F` tag, via eventMeta), open that file, and open its
   *  Seals modal pinned to the exact node this citation points at — which may
   *  not be the source's current head if it's been edited further since. A
   *  nameless trace (a minted span) has no `file` path, so there's nothing
   *  to open as a document — the chip is display-only in that case. */
  async function openCitedTrace(nodeId: string) {
    const event = await fetchEventById(nodeId);
    if (!event) return;
    const relativePath = eventMeta(event).relativePath;
    if (!relativePath) return;
    selectFile(relativePath);
    await openSeals(relativePath, nodeId);
  }

  // --- folder-wide delta replay (seal-to-seal) ---------------------------
  //
  // Mounts a single interleaved timeline across every file's seals and steps
  // the live editor through historical states. The timeline is "sticky at
  // last": the resting position (`index === last`) is the live, editable
  // document — new seals while on last append a step and the bar auto-advances
  // to the new last (the follow effect). Stepping back (`index < last`)
  // overrides that one step's file with its reconstructed content (the chain
  // replayed genesis→that node via reconstructUpTo) and freezes it: the user-
  // edit path is inert (the override is a setRunsEffect write `liftRuns`
  // exempts) and sealNow is gated on `replayActiveRef`, which is true only on a
  // historical step. At most one file is overridden at a time — the active
  // historical step's — so capture/restore is cheap and edits to other files
  // are never disturbed. `endReplay` restores the overridden path (if any).

  /** Begin replay for the attached folder. Fetches every FileTraceNode in the
   *  folder, groups by file, fetches each file's chain once, and precomputes
   *  each seal's reconstructed content so stepping is O(1). Best-effort: a
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
    // Per file: fetch the genesis→latest chain (authoritative order, never
    // created_at), then for each of that file's events find its index in the
    // chain and reconstruct content up to it. Retain each chain on a ref so
    // buildPlayTimeline (per-char playback) can expand deltas without refetch.
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
        // The footprint of *this seal's* deltas: diff against the previous seal
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
    if (steps.length === 0) return;
    // Seal-time order, ascending. stable tie-break keeps same-ms seals in
    // their original activity order rather than shuffling them.
    steps.sort((a, b) => a.meta.sealedAtMs - b.meta.sealedAtMs);
    // `last` is sticky: the resting position is the most recent seal, which is
    // the live editor (no override). Snapshot the live FileState of every path
    // so stepping back into history can capture/restore on demand — `last`
    // itself shows live content, and new seals while on last advance the bar to
    // the new last automatically (follow effect below).
    const snapshot: Record<string, FileState> = {};
    for (const path of byPath.keys()) {
      if (files[path]) snapshot[path] = files[path];
    }
    const last = steps.length - 1;
    setReplay({ steps, index: last, snapshot });
    // Land on `last` without overriding — show the live document. No file is
    // frozen at entry, so sealing stays enabled and edits flow normally.
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
    // already-sealed nodes). High `tiers[0]` with few `voices` means the map
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

  /** Advance/seek replay to step `n`. The step's file is shown when `n` points
   *  at a historical step: its reconstructed content overrides `file.runs`
   *  (frozen, read-only-ish — the sync effect writes it as a setRunsEffect run
   *  that `liftRuns` exempts, and `sealNow` is gated off while on a historical
   *  step). `n === last` shows the live document: no override, edits and seals
   *  flow, and the follow effect appends any new seal as a step and re-points
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
    // step. `last` is live → null. A historical step → its file's path.
    const oldOverridden = r.index < last ? r.steps[r.index]?.relativePath ?? null : null;
    const newOverridden = clamped < last ? r.steps[clamped]?.relativePath ?? null : null;
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
      // actually authored each span when the chain records it. identityForVoice
      // falls back to a stable hash-bucket color for voices not in the keychain.
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
    // `last`, prefer staying on whatever the user is viewing.
    const step = r.steps[clamped];
    const activePath = panels[activePanel]?.active;
    if (clamped < last && step && activePath !== step.relativePath) {
      selectFile(step.relativePath);
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
      const overridden = r.index < last ? r.steps[r.index]?.relativePath ?? null : null;
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
  }

  // --- per-character typewriter playback --------------------------------
  //
  // Distinct from the seal stepper: play animates every delta one character at
  // a time, interleaved across files by seal timestamp, so playback looks like
  // watching the folder being written live. buildPlayTimeline walks each path's
  // retained chain and expands content deltas into one frame per character,
  // maintaining a per-path {ch, voice}[] (the same model reconstructRunsFromChain
  // uses) so each emitted frame's runs carry correct per-author attribution.
  // A bare snapshot (genesis/import) with no positional deltas is emitted as a
  // single whole-text frame — it can't be sub-divided. The frame list ends with
  // a sentinel whose sealIndex points past the last step; the play tick stops
  // and restores live state when it reaches it.

  /** Build the per-character frame list for playback, interleaved across every
   *  file's seals by timestamp. Returns null if there's nothing to animate. */
  function buildPlayTimeline(): PlayFrame[] | null {
    const r = replayRef.current;
    if (!r) return null;
    const chains = replayChainsRef.current;
    // Map each seal (by event id) to its index in `steps`, so a frame can tag
    // itself with the enclosing sealIndex for pause-snap.
    const sealIndexByEventId = new Map(r.steps.map((s, i) => [s.event.id, i]));
    // Flat accumulator; frames carry their path + sealIndex so a cross-path
    // merge by sealedAtMs (below) can interleave them.
    const all: PlayFrame[] = [];
    for (const [path, chain] of Object.entries(chains)) {
      const frames: PlayFrame[] = [];
      // Running char→voice array, mirroring reconstructRunsFromChain's model.
      let chars: { ch: string; voice: string }[] = [];
      for (const event of chain) {
        const signer = event.pubkey;
        const sealIndex = sealIndexByEventId.get(event.id);
        if (sealIndex === undefined) continue; // not a step (e.g. forked-off)
        const parsed = JSON.parse(event.content) as {
          snapshot?: string;
          authors?: unknown;
          deltas?: Array<{
            type?: string;
            position?: { start: number; end: number };
            newValue?: string | null;
          }>;
        };
        // Tier 1: an `authors` map aligned to snapshot is authoritative — adopt
        // it wholesale as one frame (per-char breakdown isn't recoverable from
        // a run map). Matches reconstructRunsFromChain's tier-1 handling.
        if (typeof parsed.snapshot === "string") {
          const runs = parseAuthors(parsed.authors, parsed.snapshot);
          if (runs) {
            chars = runsToChars(runs);
            frames.push({ path, sealIndex, runs });
            continue;
          }
        }
        const contentDeltas = (parsed.deltas ?? []).filter(
          (d) => d.position && (d.type === "insert" || d.type === "delete" || d.type === "replace"),
        );
        if (contentDeltas.length === 0) {
          // Bare snapshot (genesis/import) or a tag/reply-only node. If the
          // snapshot differs from the running text it's a wholesale reset → one
          // frame attributed to the signer. Otherwise (metadata-only) no frame.
          if (
            typeof parsed.snapshot === "string" &&
            parsed.snapshot !== chars.map((c) => c.ch).join("")
          ) {
            chars = [...parsed.snapshot].map((ch) => ({ ch, voice: signer }));
            frames.push({ path, sealIndex, runs: charsToRuns(chars) });
          }
          continue;
        }
        // Expand each content delta one character at a time. Within a seal the
        // deltas share one signer; we apply them in listed order, clamping each
        // to the current bounds (a corrupted/abnormal chain degrades cleanly).
        for (const d of contentDeltas) {
          const start = Math.max(0, Math.min(d.position!.start, chars.length));
          const end = Math.max(start, Math.min(d.position!.end, chars.length));
          const insertChars = [...(d.newValue ?? "")].map((ch) => ({ ch, voice: signer }));
          if (insertChars.length === 0 && start === end) continue; // no-op
          if (insertChars.length > 0) {
            // Reveal the inserted text one char at a time (typewriter). Each
            // partial state is a frame.
            for (let k = 1; k <= insertChars.length; k++) {
              chars = [...chars.slice(0, start), ...insertChars.slice(0, k), ...chars.slice(end)];
              frames.push({ path, sealIndex, runs: charsToRuns(chars) });
            }
          } else {
            // Pure delete (no insertion): remove one char at a time from end→start.
            for (let k = end - 1; k >= start; k--) {
              chars = [...chars.slice(0, k), ...chars.slice(k + 1)];
              frames.push({ path, sealIndex, runs: charsToRuns(chars) });
            }
          }
        }
      }
      if (frames.length > 0) all.push(...frames);
    }
    if (all.length === 0) return null;
    // Interleave every path's frames into one list, ordered by the sealedAtMs
    // of each frame's enclosing seal. Array.prototype.sort is stable in modern
    // engines, so a path's intra-seal frame order is preserved.
    all.sort((a, b) => {
      const ta = r.steps[a.sealIndex]?.meta.sealedAtMs ?? 0;
      const tb = r.steps[b.sealIndex]?.meta.sealedAtMs ?? 0;
      return ta - tb;
    });
    // Sentinel: marks live state. The tick stops here and snaps to the last
    // real frame's seal. sealIndex = steps.length (one past last) so a snap
    // never accidentally picks it.
    all.push({ path: "", sealIndex: r.steps.length, runs: [] });
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
    // Focus the frame's file so the typed text is visible.
    const activePath = panels[activePanel]?.active;
    if (activePath !== frame.path) selectFile(frame.path);
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
      const ranked = await rankSampleHits(hits, getAlphaOpts());
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
        // Optimistically show the file, then persist to disk + seal a node.
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
      const ranked = await rankSampleHits(hits, getAlphaOpts());
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
    // Record an unmount observation (§3.3 op:unmount): the trace that was in
    // panel `idx` just left. Route to the path's OWNER — a folder-tab sentinel
    // has no owner (folder focus is handled on the mount side via selection
    // kind, not the tab string), so it falls out as null and is dropped. A file
    // owned by another folder would route there, not to the active folder —
    // same anti-contamination rule as the mount side. Best-effort, like it.
    const fid = isFolderTab(path)
      ? null
      : ownerFolderOf(path, activeMounted(folder?.id ?? null, Object.keys(files)));
    if (fid) {
      bufferFocus(fid, {
        type: "focus",
        op: "unmount",
        selection: { kind: "file", path },
        panelIndex: idx,
        timestamp: Date.now(),
      });
    }
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

  function editFile(path: string, runs: Run[]) {
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
      },
    }));
  }

  // Tagged-trace edits land in FileState.taggedTraces — the protocol's `tag-add`
  // (a `q` edge with no body bracket). A pure tag-add (content unchanged) still
  // seals because dirtySealPaths and each backend's no-op gate include the
  // citation set in their change check.
  // Each id is a sibling file's current head nodeId (resolved from `files`).
  function editTaggedTraces(path: string, ids: string[]) {
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

    setCreating(null);
    setCreateError(null);

    if (kind === "file") {
      const path = fullName.endsWith(".md") ? fullName : `${fullName}.md`;
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
      // implicit in file paths, same as the harness).
      void backendRef.current.createFolder(fullName).catch((e) =>
        console.warn(`[workspace] createFolder failed for ${fullName}:`, e),
      );
    }
  }

  // Move `src` (file or folder path) into `destFolder` ("" = root). Rewrites
  // every file and empty-folder path under src, plus any open panels and
  // collapsed-folder state, so nothing dangles. Guards against illegal moves
  // a second time (the Sidebar already checks, but this is the trust boundary).
  // The disk move + provenance (import-at-dest, delete-at-source) happens
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
      const next: Record<string, "preview" | "markdown"> = {};
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

    // Disk + provenance: import at the new path, tombstone at the old. Carry
    // each affected file's user tags through (the folder tag updates on its
    // own, being derived from the new path) so they survive the reparent. Each
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
      void backendRef.current.movePath(src, destFolder, userTagsByPath).catch((e) =>
        console.warn(`[workspace] movePath failed for ${src}:`, e),
      );
    }
  }

  // Remove one or more paths (files or folders) from local state. For a folder,
  // every descendant file and empty-folder is dropped too. Any open panel
  // pointing at a deleted file or inside a deleted folder is cleared to "" so
  // Panel shows its empty state instead of crashing on a dangling reference. A
  // path nested beneath another deleted path is a no-op extra (the ancestor
  // already sweeps it), so this prunes to top-level deletions first and makes a
  // single coherent pass — same shape as moveNodes.
  function deleteNodes(paths: string[]) {
    if (!folder) return;
    const fileSet = new Set(Object.keys(files));
    const folderSet = new Set(emptyFolders);
    // Prune to top-level: drop any path nested beneath another deleted path.
    // The synthetic root (the mounted folder) is never deletable — the UI
    // hides Delete from its context menu, but this is the trust boundary.
    const tops = paths
      .filter((p) => p !== ROOT)
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

    // Close any tabs whose file/folder was deleted, then collapse panels that
    // emptied as a result. Routed through commitWithCollapse (like closeTab /
    // moveTab) so an emptied panel is dropped and panelWeights stays length-
    // locked to the surviving panels — otherwise the lone remaining panel would
    // share the row with a phantom empty column and not fill the width.
    const tabUnder = (t: string): boolean =>
      isFolderTab(t) ? under(folderTabPath(t)) : under(t);
    const nextPanels = panels.map((panel) => {
      const oldTabs = panel.tabs;
      const tabs = oldTabs.filter((t) => !tabUnder(t));
      // if the active tab was removed, move focus to a surviving neighbor:
      // the tab now sitting at the old slot, else the one before it.
      let active = panel.active;
      if (tabUnder(active)) {
        const i = Math.max(0, oldTabs.indexOf(active) - 1);
        active = tabs[i] ?? "";
      }
      return { ...panel, tabs, active };
    });
    commitWithCollapse(nextPanels, activePanel);

    // Drop remembered view modes for the deleted path(s).
    setTabModes((prev) => {
      const next: Record<string, "preview" | "markdown"> = {};
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
      void backendRef.current.deletePath(path, isFolderDelete).catch((e) =>
        console.warn(`[workspace] deletePath failed for ${path}:`, e),
      );
    }
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
    const cleanName = newName.trim();
    if (!cleanName) return "Name cannot be empty.";
    if (cleanName.includes("/"))
      return "Name can't contain a path separator.";
    if (cleanName === "." || cleanName === "..")
      return `"${cleanName}" isn't a valid name.`;

    if (path === ROOT) {
      // Display label only. Not a tag token — free text (spaces ok), same as
      // the name given when creating a webapp folder.
      const current =
        folder.label ||
        (folder.path ? basename(folder.path) : folder.id.slice(0, 8));
      if (cleanName === current) return null; // no-op
      const updated: AttachedFolder = { ...folder, label: cleanName };
      setFolder(updated);
      rememberFolder(updated);
      saveAttachedFolder(updated);
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
      const next: Record<string, "preview" | "markdown"> = {};
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

    // Disk rename + provenance (import-at-dest, tombstone-at-source). Carry
    // each affected file's user tags through, same as moveNode.
    const userTagsByPath: Record<string, string[]> = {};
    for (const [p, st] of Object.entries(files)) {
      if (p === path || (isFolderRename && p.startsWith(path + "/"))) {
        userTagsByPath[p] = st.tags;
      }
    }
    void backendRef.current.renamePath(path, cleanName, userTagsByPath).catch((e) =>
      console.warn(`[workspace] renamePath failed for ${path}:`, e),
    );
    return null;
  }

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      // Cmd/Ctrl+S: wrap a selection in `[[ ]]` if one is active (pending
      // protection; minting is opt-in via send), otherwise flush pending
      // edits for the active panel — write to disk + seal a kind-4290 node +
      // republish the manifest. The two never both fire from one press.
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        const path = panels[activePanel].active;
        if (!path) return;
        const view = activeEditorView.current;
        const sel = view?.state.selection.main;
        if (view && sel && sel.from !== sel.to) {
          wrapSelection(view);
        } else {
          void sealNow(path);
        }
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
  // and the path-shape inference (hasChild, onRowActivate) treat them as folders.
  const folderPaths = useMemo(
    () => new Set([
      ...emptyFolders,
      ...Object.entries(files).filter(([, f]) => f.kind === "folder").map(([p]) => p),
    ]),
    [emptyFolders, files],
  );

  // The focused panel's active trace path — the file/folder its active tab is
  // showing. Drives the sidebar's gold "selected" row so clicking a panel or
  // selecting one of its tabs is reflected in the collection, not only tree-row
  // clicks. A folder tab (`folder://<relpath>`) maps to the folder's relpath.
  const activeTab = panels[activePanel]?.active ?? "";
  const activeTracePath = isFolderTab(activeTab) ? folderTabPath(activeTab) : activeTab;

  // The mounted folder's display name — shown as the sidebar header and as the
  // label of the synthetic root node in the tree. Desktop derives it from the
  // attached path's basename (label is unset on desktop attach); webapp uses
  // the stored label, falling back to the id prefix.
  const rootLabel = useMemo(() => {
    if (!folder) return "Collection";
    if (folder.label) return folder.label;
    if (folder.path) return basename(folder.path);
    return folder.id.slice(0, 8);
  }, [folder]);

  const tree = useMemo(() => {
    // Under nesting (spec §3.2), a FileState with kind: "folder" is a real
    // folder-member (a subfolder trace), not a file. Split the entries so the
    // tree renders folder-members as folders and files as files. Legacy/flat
    // folders have no kind: "folder" entries, so this is byte-identical to the
    // old behavior for them.
    const fileEntries = Object.entries(files)
      .filter(([, f]) => f.kind !== "folder")
      .map(([p]) => ({ path: p, type: "file" as const }));
    const folderMemberEntries = Object.entries(files)
      .filter(([, f]) => f.kind === "folder")
      .map(([p]) => ({ path: p, type: "folder" as const }));
    const entries: { path: string; type: "file" | "folder" }[] = [
      ...fileEntries,
      ...folderMemberEntries,
      ...[...emptyFolders].map((p) => ({ path: p, type: "folder" as const })),
    ];
    const built = buildTree(entries);
    // Wrap the built entries under a single synthetic root representing the
    // mounted folder, so it shows as a visible, selectable top-level node
    // (path === ROOT). All existing path semantics are unchanged — ROOT is
    // still "" and every real entry keeps its relpath.
    return [{ name: rootLabel, path: ROOT, type: "folder", isRoot: true, children: built }] as TreeNode[];
  }, [files, emptyFolders, rootLabel]);

  return (
    <div className="app-shell">
      <div className="body" style={{ "--sidebar-width": `${sidebarWidth}px` } as React.CSSProperties}>
        <NavRail
          activeView={activeView}
          onSelect={setActiveView}
          expanded={railExpanded}
          onToggleExpanded={() => setRailExpanded((v) => !v)}
          theme={theme}
          onToggleTheme={toggleTheme}
          onResetWorkspace={!isTauri() ? () => setConfirmReset(true) : undefined}
          showOperator={!isTauri() && isStaff()}
        />
        {activeView === "editor" ? (
          folder && bootState === "ready" ? (
            <div className="press-content">
              <div className="press-top">
              <Sidebar
                tree={tree}
                collapsed={collapsed}
                onToggleFolder={toggleFolder}
                openTabs={panels.flatMap((p) => p.tabs)}
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
                onRename={renameNode}
                folderId={folder?.id ?? null}
                orchestrationOpen={orchestrationOpen}
                onToggleOrchestration={() => setOrchestrationOpen((v) => !v)}
                orchestrationRefreshKey={orchestrationRefreshKey}
                activeTracePath={activeTracePath}
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
                palette={
                  <PalettePanel
                    refreshKey={paletteRefreshKey}
                    selectedNodeId={
                      selection?.kind === "span" ? selection.nodeId : undefined
                    }
                    onSelect={(item) => selectSpan(item.nodeId, item.text)}
                  />
                }
                onSwitchFolder={() => {
                  detachFolder();
                  setFolder(null);
                  setBootState("idle");
                }}
                onOpenToSide={openToSide}
                onBeginReplay={() =>
                  void beginReplay().catch((e) => console.warn("[replay] begin failed:", e))
                }
                replayStep={replay ? replay.steps[replay.index] ?? null : null}
                replayIndex={
                  playing && playTimeline && playCursor < playTimeline.length
                    ? playTimeline[playCursor]?.sealIndex ?? replay?.index ?? 0
                    : replay?.index ?? 0
                }
                replayCount={replay?.steps.length ?? 0}
                playing={playing}
                playSpeed={playSpeed}
                replayActive={
                  (replay !== null && replay.index < replay.steps.length - 1) ||
                  playing
                }
                onStep={(n) => {
                  // Manual step pauses char-playback and tears down its
                  // timeline so the stepper lands on a clean seal boundary.
                  setPlaying(false);
                  setPlayTimeline(null);
                  playTimelineRef.current = null;
                  replayStepTo(n);
                }}
                onTogglePlay={() => {
                  if (!replay) return;
                  if (playing) {
                    // Pause: tear down the char timeline and snap the seal
                    // cursor to the last rendered frame's enclosing seal, so
                    // the stepper/slider rest where playback stopped.
                    const tl = playTimelineRef.current;
                    const cur = playCursorRef.current;
                    const frame = tl?.[cur];
                    setPlaying(false);
                    setPlayTimeline(null);
                    playTimelineRef.current = null;
                    if (frame && frame.sealIndex < replay.steps.length) {
                      replayStepTo(frame.sealIndex);
                    }
                  } else {
                    // Play: build the per-char timeline, render its first frame,
                    // and start the tick. Always animates the whole folder
                    // (genesis→live) — resuming mid-char isn't supported.
                    const tl = buildPlayTimeline();
                    if (!tl || tl.length <= 1) return; // nothing to animate
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
              {/* Foreign-folder banner: the attached folder is owned by someone
                  else. Edits are gated until the user forks it into their own
                  namespace. The Fork action seeds a shallow fork (cites the
                  source's members) and re-attaches to the editable copy. */}
              {isForeignFolder && (
                <div className="foreign-banner">
                  <span className="foreign-banner-text">
                    You're viewing a folder owned by someone else. Fork it to edit.
                  </span>
                  <button
                    type="button"
                    className="foreign-banner-fork"
                    onClick={() => void forkCurrentFolder()}
                  >
                    Fork to edit
                  </button>
                </div>
              )}
              {/* Branch detection banner: incoming forks / sibling heads of the
                  active file. Incorporate is only offered on noConflict forks
                  (you haven't edited past the fork point) — unilateral accept
                  of their snapshot under your key (protocol §3.8). Conflict
                  candidates are listed but not auto-mergeable yet. */}
              {!isForeignFolder && mergeCandidates.length > 0 && !mergeSession && (
                <div className="merge-banner">
                  {mergeCandidates.map((c) => {
                    const short = c.headId.slice(0, 8);
                    const who = c.ownerPubkey.slice(0, 8);
                    const label =
                      c.kind === "incoming-fork"
                        ? c.noConflict
                          ? `Fork ${short} by ${who} — ready to incorporate`
                          : `Fork ${short} by ${who} — you edited after they forked`
                        : `Concurrent branch ${short} on this file`;
                    return (
                      <div key={c.headId} className="merge-banner-row">
                        <span className="merge-banner-text">{label}</span>
                        <button
                          type="button"
                          className="merge-banner-incorporate"
                          disabled={mergeBusy}
                          onClick={() => void incorporateCandidate(c)}
                        >
                          {mergeBusy
                            ? "Working…"
                            : c.noConflict
                              ? "Incorporate"
                              : "Reconcile"}
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
              {mergeSession && (
                <MergePanel
                  candidate={mergeSession.candidate}
                  base={mergeSession.base}
                  ours={mergeSession.ours}
                  path={mergeSession.path}
                  busy={mergeBusy}
                  onCancel={() => setMergeSession(null)}
                  onConfirm={(resolved) => void sealReconciledMerge(resolved)}
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
                            active={activePanel === idx}
                            collapsed={collapsed}
                            onFocusPanel={() => setActivePanel(idx)}
                            onSelectTab={(p) => {
                              setPanels((prev) =>
                                mapPanel(prev, idx, (pp) => ({ ...pp, active: p })),
                              );
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
                            onEdit={(runs) => editFile(path, runs)}
                            onUntagTrace={(nodeId) => {
                              if (!path) return;
                              const cur = files[path]?.taggedTraces ?? [];
                              editTaggedTraces(path, cur.filter((i) => i !== nodeId));
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
                            flash={false}
                            readOnly={replayActive}
                            voice={penPubkey}
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
                              selection?.kind === "span"
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
                            onSelectSpan={(nodeId, phrase) =>
                              selectSpan(nodeId, phrase)
                            }
                            onCopySpan={(nodeId, phrase) =>
                              copySpan(nodeId, phrase, path)
                            }
                            citations={isFolderTab(path) ? [] : (citationsByPath[path] ?? [])}
                            taggedChips={isFolderTab(path) ? [] : (taggedChipByPath[path] ?? [])}
                            inbound={isFolderTab(path) ? [] : (inboundByPath[path] ?? [])}
                            onOpenCitation={(nodeId) => {
                              void openCitedTrace(nodeId);
                            }}
                            traceCandidates={traceCandidates}
                            pickerDisabled={
                              isForeignFolder ||
                              isFolderTab(path) ||
                              !path ||
                              !files[path]?.nodeId
                            }
                            onTagTrace={(nodeId) => {
                              if (!path) return;
                              const cur = files[path]?.taggedTraces ?? [];
                              if (cur.includes(nodeId)) return; // dedupe
                              editTaggedTraces(path, [...cur, nodeId]);
                            }}
                            tagDropAccept={(srcPath) => {
                              // Mirror the picker's gate, then reject the
                              // cases that don't apply to a name pick:
                              // self-drop, unsealed source, already tagged.
                              if (
                                isForeignFolder ||
                                isFolderTab(path) ||
                                !path ||
                                !files[path]?.nodeId
                              )
                                return false;
                              if (srcPath === path) return false; // can't tag self
                              const srcId = files[srcPath]?.nodeId;
                              if (!srcId) return false; // source hasn't sealed
                              const cur = files[path]?.taggedTraces ?? [];
                              if (cur.includes(srcId)) return false; // already tagged
                              return true;
                            }}
                            onTagTraceByPath={(srcPath) => {
                              if (!path) return;
                              const srcId = files[srcPath]?.nodeId;
                              if (!srcId) return; // unsealed source — nothing to cite
                              const cur = files[path]?.taggedTraces ?? [];
                              if (cur.includes(srcId)) return; // dedupe
                              editTaggedTraces(path, [...cur, srcId]);
                            }}
                            onOpenSeals={() => {
                              if (!isFolderTab(path) && path) void openSeals(path);
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
                {editorSelection &&
                  panelViews.current[editorSelection.panelIdx] &&
                  panels[editorSelection.panelIdx]?.active &&
                  !isFolderTab(panels[editorSelection.panelIdx].active) &&
                  !isForeignFolder && (
                    <SelectionMenu
                      view={panelViews.current[editorSelection.panelIdx]!}
                      onBracket={() => {
                        const v = panelViews.current[editorSelection.panelIdx]!;
                        wrapSelection(v);
                        v.focus();
                      }}
                      onZine={() => {
                        const v = panelViews.current[editorSelection.panelIdx]!;
                        const p = panels[editorSelection.panelIdx].active;
                        setEditorSelection(null);
                        void zinePhrase(p, v, editorSelection.from, editorSelection.to);
                      }}
                    />
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
                    </div>,
                    document.body,
                  );
                })()}
              <TopBar
                keys={keys}
                penKeyId={penKeyId}
                injectKeyId={injectKeyId}
                onChoosePenKey={choosePenKey}
                onChooseInjectKey={chooseInjectKey}
                providers={providers}
                onSelectProvider={(pk, pid) => selectVoiceProvider(pk, pid)}
                selection={selection}
                opRunning={(summonStatus[opTargetPanel()] ?? { state: "idle" }).state === "running"}
                onOp={(op) => runOp(opTargetPanel(), op)}
                onStop={() => stopOp(opTargetPanel())}
                opStatus={summonStatus[opTargetPanel()] ?? { state: "idle" }}
                tokenEstimate={tokenEstimate}
              />
              {sealsModal && (
                <SealsModal
                  relativePath={sealsModal.relativePath}
                  chain={sealsModal.chain}
                  pinnedEventId={sealsModal.pinnedEventId}
                  onClose={() => setSealsModal(null)}
                />
              )}
            </div>
          ) : folder && bootState === "scanning" ? (
            <section className="view-placeholder">
              <h1 className="view-placeholder-title">Scanning…</h1>
              <p className="view-placeholder-blurb">
                {isTauri() ? `Reading ${folder.path ?? ""}` : "Reading folder from relay"}
              </p>
            </section>
          ) : !isTauri() ? (
            // Webapp boot: auto-provisioning or auto-opening a folder. Show a
            // loading state, never the "open a folder" picker — the user gets
            // dropped straight into the editor once the folder resolves.
            <section className="view-placeholder">
              <h1 className="view-placeholder-title">Connecting…</h1>
              <p className="view-placeholder-blurb">
                {bootError ?? "Opening your folder on the relay."}
              </p>
            </section>
          ) : (
            <EmptyFolderView
              onChoose={onChooseFolder}
              defaultPath={defaultPath}
              onUseDefault={(p) => void doAttach(p)}
              error={bootError}
            />
          )
        ) : activeView === "download" ? (
          <ViewErrorBoundary view="download">
            <DownloadView />
          </ViewErrorBoundary>
        ) : activeView === "about" ? (
          <ViewErrorBoundary view="about">
            <AboutView />
          </ViewErrorBoundary>
        ) : activeView === "relays" ? (
          <ViewErrorBoundary view="relays">
            <RelaysView />
          </ViewErrorBoundary>
        ) : activeView === "friends" ? (
          <ViewErrorBoundary view="friends">
            <FriendsView />
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
            <GlobeView />
          </ViewErrorBoundary>
        ) : activeView === "listings" ? (
          <ViewErrorBoundary view="listings">
            <ListingsView onOpenFolder={(id) => void openFromStacks(id)} />
          </ViewErrorBoundary>
        ) : activeView === "stats" ? (
          <ViewErrorBoundary view="stats">
            <TimesView />
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
      <PinPanel />
      {confirmReset && (
        <div className="confirm-overlay" onClick={() => setConfirmReset(false)}>
          <div className="confirm-dialog" onClick={(e) => e.stopPropagation()}>
            <p className="confirm-message">
              Reset workspace? This clears the current folder and starts a fresh one. The old folder's
              history stays on the relay under its old id.
            </p>
            <div className="confirm-actions">
              <button type="button" className="confirm-cancel" onClick={() => setConfirmReset(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="confirm-delete"
                onClick={() => {
                  setConfirmReset(false);
                  void resetWorkspace();
                }}
              >
                Reset workspace
              </button>
            </div>
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

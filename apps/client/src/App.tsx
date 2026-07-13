import { useEffect, useMemo, useRef, useState } from "react";
import { EditorState, StateEffect, StateField, type Extension, type Range } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  keymap,
  ViewPlugin,
  type DecorationSet,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import {
  BarChart3,
  Cpu,
  FileText,
  Folder,
  Globe,
  KeyRound,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Radio,
  Sun,
  type LucideIcon,
} from "lucide-react";
import "./App.css";

interface Run {
  voice: string;
  text: string;
}

interface FileState {
  runs: Run[];
  nodeId: string;
}

interface TreeNode {
  name: string;
  path: string;
  type: "file" | "folder";
  children?: TreeNode[];
}

// Views reachable from the nav rail. `editor` is the existing two-panel
// workspace; the rest are placeholders awaiting real implementations
// (globe → maplibre, keys/relays → nostr, models → LLM keys).
type View = "about" | "editor" | "stats" | "globe" | "keys" | "relays" | "models";

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

// The resolved mode (what the user actually sees) drives which toggle icon to show.
function resolvedMode(theme: Theme): "light" | "dark" {
  if (theme === "light" || theme === "dark") return theme;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

const INITIAL_FILES: Record<string, FileState> = {
  "README.md": { runs: [{ voice: "alice", text: "" }], nodeId: "1a2b3c4" },
  "essays/on-provenance.md": { runs: [{ voice: "alice", text: "" }], nodeId: "f6a221c" },
  "essays/on-self-hosting.md": { runs: [{ voice: "alice", text: "" }], nodeId: "b02e7a1" },
  "essays/drafts/untitled.md": { runs: [{ voice: "alice", text: "" }], nodeId: "0000000" },
  "assets/notes.md": { runs: [{ voice: "alice", text: "" }], nodeId: "9f8e7d6" },
};

// --- run/text helpers -------------------------------------------------

function flatten(runs: Run[]): string {
  return runs.map((r) => r.text).join("");
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

function hashVoice(voice: string): number {
  let h = 0;
  for (let i = 0; i < voice.length; i++) h = (h * 31 + voice.charCodeAt(i)) >>> 0;
  return h % 6;
}

function newNodeId(): string {
  // placeholder until the client is wired to the relay; real nodeIds come from the signed event id
  return Math.random().toString(16).slice(2, 9);
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

// --- components ---------------------------------------------------------

function TreeItem({
  node,
  depth,
  collapsed,
  onToggleFolder,
  openPaths,
  onOpenFile,
  draggingPath,
  dropTargetPath,
  onDragStart,
  onDragEnterTarget,
  onDragLeaveTarget,
  onDropOn,
  canDropOn,
}: {
  node: TreeNode;
  depth: number;
  collapsed: Set<string>;
  onToggleFolder: (path: string) => void;
  openPaths: [string, string];
  onOpenFile: (path: string) => void;
  draggingPath: string | null;
  dropTargetPath: string | null;
  onDragStart: (path: string) => void;
  onDragEnterTarget: (path: string) => void;
  onDragLeaveTarget: (path: string) => void;
  onDropOn: (path: string) => void;
  canDropOn: (path: string) => boolean;
}) {
  const indent = { paddingLeft: depth * 14 + 10 };
  const isDragging = draggingPath === node.path;
  const isDropTarget = dropTargetPath === node.path;

  if (node.type === "folder") {
    const isOpen = !collapsed.has(node.path);
    const dropAllowed = canDropOn(node.path);
    const rowClass =
      "tree-row tree-folder" +
      (isDragging ? " tree-dragging" : "") +
      (isDropTarget && dropAllowed ? " tree-drop-target" : "") +
      (isDropTarget && !dropAllowed ? " tree-drop-denied" : "");
    return (
      <div>
        <div
          className={rowClass}
          style={indent}
          draggable
          onDragStart={(e) => {
            e.dataTransfer.effectAllowed = "move";
            e.dataTransfer.setData("text/zine-path", node.path);
            onDragStart(node.path);
          }}
          onDragEnter={(e) => {
            if (draggingPath && draggingPath !== node.path) {
              e.preventDefault();
              onDragEnterTarget(node.path);
            }
          }}
          onDragOver={(e) => {
            if (draggingPath && draggingPath !== node.path && canDropOn(node.path)) {
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
          onClick={() => onToggleFolder(node.path)}
        >
          <span className="tree-chevron">{isOpen ? "▾" : "▸"}</span>
          <span className="tree-name">{node.name}</span>
        </div>
        {isOpen &&
          node.children!.map((c) => (
            <TreeItem
              key={c.path}
              node={c}
              depth={depth + 1}
              collapsed={collapsed}
              onToggleFolder={onToggleFolder}
              openPaths={openPaths}
              onOpenFile={onOpenFile}
              draggingPath={draggingPath}
              dropTargetPath={dropTargetPath}
              onDragStart={onDragStart}
              onDragEnterTarget={onDragEnterTarget}
              onDragLeaveTarget={onDragLeaveTarget}
              onDropOn={onDropOn}
              canDropOn={canDropOn}
            />
          ))}
      </div>
    );
  }

  const openIn = openPaths
    .map((p, i) => (p === node.path ? (i === 0 ? "L" : "R") : null))
    .filter((v) => v !== null) as string[];

  return (
    <div
      className={"tree-row tree-file" + (openIn.length ? " tree-file-open" : "") + (isDragging ? " tree-dragging" : "")}
      style={indent}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/zine-path", node.path);
        onDragStart(node.path);
      }}
      onClick={() => onOpenFile(node.path)}
    >
      <span className="tree-file-dot" aria-hidden="true" />
      <span className="tree-name">{node.name}</span>
      {openIn.length > 0 && <span className="tree-open-marker">{openIn.join("")}</span>}
    </div>
  );
}

function Sidebar({
  tree,
  collapsed,
  onToggleFolder,
  openPaths,
  onOpenFile,
  creating,
  onCreateStart,
  onCreateCommit,
  onCreateCancel,
  filePaths,
  folderPaths,
  onMove,
}: {
  tree: TreeNode[];
  collapsed: Set<string>;
  onToggleFolder: (path: string) => void;
  openPaths: [string, string];
  onOpenFile: (path: string) => void;
  creating: null | "file" | "folder";
  onCreateStart: (kind: "file" | "folder") => void;
  onCreateCommit: (name: string) => void;
  onCreateCancel: () => void;
  filePaths: Set<string>;
  folderPaths: Set<string>;
  onMove: (src: string, destFolder: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (creating) inputRef.current?.focus();
  }, [creating]);

  // drag state lives here — the source path and the currently-hovered drop
  // target (a folder path, or "" for root).
  const [draggingPath, setDraggingPath] = useState<string | null>(null);
  const [dropTargetPath, setDropTargetPath] = useState<string | null>(null);

  function canDropOn(destFolder: string): boolean {
    if (!draggingPath) return false;
    return canDrop(draggingPath, destFolder, filePaths, folderPaths);
  }

  function clearDrag() {
    setDraggingPath(null);
    setDropTargetPath(null);
  }

  function onKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      const name = inputRef.current?.value.trim() ?? "";
      if (name) onCreateCommit(name);
      else onCreateCancel();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onCreateCancel();
    }
  }

  return (
    <nav className="sidebar">
      <div className="sidebar-header">
        <span className="sidebar-title">field-notes/</span>
        <span className="sidebar-actions">
          <button
            className="icon-btn"
            type="button"
            title="New folder"
            aria-label="New folder"
            onClick={() => onCreateStart("folder")}
            disabled={creating !== null}
          >
            <Folder size={14} aria-hidden="true" />
          </button>
          <button
            className="icon-btn"
            type="button"
            title="New file"
            aria-label="New file"
            onClick={() => onCreateStart("file")}
            disabled={creating !== null}
          >
            <FileText size={14} aria-hidden="true" />
          </button>
        </span>
      </div>
      <div
        className={"tree" + (dropTargetPath === ROOT && canDropOn(ROOT) ? " tree-drop-target" : "")}
        onDragEnter={(e) => {
          if (draggingPath && e.target === e.currentTarget) {
            e.preventDefault();
            setDropTargetPath(ROOT);
          }
        }}
        onDragOver={(e) => {
          // allow dropping onto empty space inside the tree → move to root.
          // child rows stopPropagation on their own drops, so this only fires
          // for the bare container.
          if (draggingPath && canDropOn(ROOT)) {
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
          }
        }}
        onDrop={(e) => {
          e.preventDefault();
          onMove(draggingPath!, ROOT);
          clearDrag();
        }}
        onDragEnd={clearDrag}
      >
        {creating && (
          <CreateRow
            kind={creating}
            inputRef={inputRef}
            onKey={onKey}
            onCommit={onCreateCommit}
            onCancel={onCreateCancel}
          />
        )}
        {tree.map((node) => (
          <TreeItem
            key={node.path}
            node={node}
            depth={0}
            collapsed={collapsed}
            onToggleFolder={onToggleFolder}
            openPaths={openPaths}
            onOpenFile={onOpenFile}
            draggingPath={draggingPath}
            dropTargetPath={dropTargetPath}
            onDragStart={setDraggingPath}
            onDragEnterTarget={setDropTargetPath}
            onDragLeaveTarget={(path) => {
              setDropTargetPath((cur) => (cur === path ? null : cur));
            }}
            onDropOn={(destFolder) => {
              onMove(draggingPath!, destFolder);
              clearDrag();
            }}
            canDropOn={canDropOn}
          />
        ))}
      </div>
    </nav>
  );
}

function CreateRow({
  kind,
  inputRef,
  onKey,
  onCommit,
  onCancel,
}: {
  kind: "file" | "folder";
  inputRef: React.RefObject<HTMLInputElement | null>;
  onKey: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const placeholder = kind === "folder" ? "folder name…" : "file name…";
  function commitFromInput() {
    const name = inputRef.current?.value.trim() ?? "";
    if (name) onCommit(name);
    else onCancel();
  }
  return (
    <div className="tree-row create-row">
      <span className="tree-chevron" aria-hidden="true">
        {kind === "folder" ? "▸" : ""}
      </span>
      <span className="create-row-icon" aria-hidden="true">
        {kind === "folder" ? <Folder size={14} /> : <FileText size={14} />}
      </span>
      <input
        ref={inputRef}
        className="create-input"
        type="text"
        placeholder={placeholder}
        onKeyDown={onKey}
        onBlur={commitFromInput}
      />
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

const ACTIVE_VOICE = "alice";

/** Carries an externally-imposed Run[] (agent write / file switch). Tagged
 *  so the updateListener knows not to echo it back as a user edit. */
const setRunsEffect = StateEffect.define<Run[]>();

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
    let out = runs;
    for (let i = changes.length - 1; i >= 0; i--) {
      const { fromA, toA, insert } = changes[i];
      out = spliceRuns(out, fromA, toA, insert, ACTIVE_VOICE);
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

function buildVoiceDecorations(view: EditorView): DecorationSet {
  const runs = view.state.field(voiceField);
  const decos: Range<Decoration>[] = [];
  let pos = 0;
  for (const r of runs) {
    const len = [...r.text].length;
    if (len > 0) {
      decos.push(Decoration.mark({ class: `voice-span voice-${hashVoice(r.voice)}` }).range(pos, pos + len));
      pos += len;
    }
  }
  return Decoration.set(decos, true);
}

// --- pin layer ---------------------------------------------------------
//
// Orthogonal to voice: a pinned region is a live-text preserve marker
// (trace-provenance.md, "Pins vs hardening"). Stored as intervals and mapped
// through edits explicitly. Note the deliberate difference from bracket
// resilience: a bracket *breaks* when an edit's changed span overlaps it
// (trace-provenance.md:153), because the citation must pin an exact version.
// A pin is live-preserve, not snapshot-cite, so it *contracts* through an
// overlapping edit (endpoints mapped, collapsed-to-empty dropped) and stays
// active rather than rupturing. That behavioral split is the reconcile made
// concrete: same authoring surface feel, different guarantee.

interface PinRange {
  from: number;
  to: number;
}

const togglePinEffect = StateEffect.define<PinRange>();
const clearPinsEffect = StateEffect.define<void>();

const pinField = StateField.define<PinRange[]>({
  create: () => [],
  update(pins, tr) {
    // Explicit effects first.
    for (const e of tr.effects) {
      if (e.is(clearPinsEffect)) return [];
      if (e.is(togglePinEffect)) return togglePin(pins, e.value);
    }
    if (!tr.docChanged) return pins;
    // Map each pin through the changes; drop any that collapsed to empty.
    return pins
      .map(({ from, to }) => ({
        from: tr.changes.mapPos(from, 1),
        to: tr.changes.mapPos(to, 1),
      }))
      .filter((p) => p.to > p.from);
  },
});

/** Toggle a pin over [from,to]: if an existing pin fully covers it, remove;
 *  otherwise add. Keeps the common "select-then-pin" flow simple. */
function togglePin(pins: PinRange[], range: PinRange): PinRange[] {
  const covering = pins.find((p) => p.from <= range.from && p.to >= range.to);
  if (covering) return pins.filter((p) => p !== covering);
  return [...pins, { from: range.from, to: range.to }];
}

const pinDecorations = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildPinDecorations(view);
    }
    update(update: import("@codemirror/view").ViewUpdate) {
      if (update.docChanged || update.transactions.some((t) => t.effects.length)) {
        this.decorations = buildPinDecorations(update.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

function buildPinDecorations(view: EditorView): DecorationSet {
  const pins = view.state.field(pinField);
  if (pins.length === 0) return Decoration.none;
  const decos: Range<Decoration>[] = pins.map((p) =>
    Decoration.mark({ class: "pinned-span" }).range(p.from, p.to),
  );
  return Decoration.set(decos, true);
}

/** Keymap command: toggle a pin over the current selection, or the word at
 *  the cursor if there's no selection. */
function togglePinCommand(view: EditorView): boolean {
  const sel = view.state.selection.main;
  let from = sel.from;
  let to = sel.to;
  if (from === to) {
    // No selection — pin the whole line the cursor is on.
    const line = view.state.doc.lineAt(from);
    from = line.from;
    to = line.to;
  }
  if (to <= from) return false;
  view.dispatch({ effects: togglePinEffect.of({ from, to }) });
  return true;
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
    padding: "2.25rem clamp(1.25rem, 5vw, 5rem)",
    overflowY: "auto",
  },
  ".cm-content": { caretColor: "var(--accent)" },
  "&.cm-focused": { outline: "none" },
});

function buildExtensions(onUserEdit: (runs: Run[]) => void): Extension[] {
  const liftRuns = EditorView.updateListener.of((update) => {
    for (const tr of update.transactions) {
      if (tr.docChanged && !tr.effects.some((e) => e.is(setRunsEffect))) {
        onUserEdit(update.state.field(voiceField));
      }
    }
  });
  return [
    history(),
    keymap.of([
      ...defaultKeymap,
      ...historyKeymap,
      // Cmd/Ctrl-Alt-P: toggle pin. Avoids Cmd-P (print) and Cmd-Shift-P
      // (browser private window on macOS); Alt keeps it free in the editor.
      { key: "Mod-Alt-p", run: togglePinCommand, preventDefault: true },
    ]),
    voiceField,
    voiceDecorations,
    pinField,
    pinDecorations,
    liftRuns,
    editorTheme,
    EditorView.lineWrapping,
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
  onEdit,
}: {
  file: FileState;
  onEdit: (runs: Run[]) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);

  // Stable callback into the latest onEdit without rebuilding extensions.
  const onEditRef = useRef(onEdit);
  onEditRef.current = onEdit;
  const extensionsRef = useRef<Extension[] | null>(null);
  if (extensionsRef.current === null) {
    extensionsRef.current = buildExtensions((runs) => onEditRef.current(runs));
  }

  // Mount once.
  useEffect(() => {
    if (!hostRef.current) return;
    const view = new EditorView({
      state: EditorState.create({
        doc: flatten(file.runs),
        extensions: extensionsRef.current!,
      }),
      parent: hostRef.current,
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Push external Run[] changes (agent write, file switch) into CM. Tagged
  // with setRunsEffect so liftRuns doesn't echo them back. Guarded against
  // the case where CM already holds these exact runs (a user edit we just
  // lifted would otherwise loop).
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (runsEqual(view.state.field(voiceField), file.runs)) return;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: flatten(file.runs) },
      effects: setRunsEffect.of(file.runs),
    });
  }, [file.runs]);

  return <div ref={hostRef} className="editor-host" />;
}

function Panel({
  path,
  file,
  active,
  onFocusPanel,
  onEdit,
  flash,
}: {
  path: string;
  file: FileState;
  active: boolean;
  onFocusPanel: () => void;
  onEdit: (runs: Run[]) => void;
  flash: boolean;
}) {
  return (
    <section
      className={"panel" + (flash ? " panel-flash" : "") + (active ? " panel-active" : "")}
      onMouseDownCapture={onFocusPanel}
    >
      <div className="tab-bar">
        <span className="tab-path">{path}</span>
      </div>
      <FileEditor file={file} onEdit={onEdit} />
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
  { view: "editor", Icon: Pencil, label: "Editor" },
  { view: "stats", Icon: BarChart3, label: "Stats" },
  { view: "globe", Icon: Globe, label: "Globe" },
];
const RAIL_BOTTOM: RailItem[] = [
  { view: "keys", Icon: KeyRound, label: "Keys" },
  { view: "relays", Icon: Radio, label: "Relays" },
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
}: {
  activeView: View;
  onSelect: (v: View) => void;
  expanded: boolean;
  onToggleExpanded: () => void;
  theme: Theme;
  onToggleTheme: () => void;
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
          {mode === "dark" ? <SunIcon /> : <MoonIcon />}
        </button>
        <button
          type="button"
          className="rail-item"
          aria-label={expanded ? "Collapse rail" : "Expand rail"}
          aria-expanded={expanded}
          title={expanded ? "Collapse" : "Expand"}
          onClick={onToggleExpanded}
        >
          <PanelToggleIcon expanded={expanded} />
        </button>
      </div>
    </nav>
  );
}

// --- view placeholder --------------------------------------------------

const VIEW_META: Record<Exclude<View, "editor">, { title: string; blurb: string }> = {
  about: { title: "About", blurb: "What zine is and how it fits together." },
  stats: { title: "Stats", blurb: "Aggregates and activity for the relay." },
  globe: { title: "Globe", blurb: "A spherical maplibre view of the network." },
  keys: { title: "Keys", blurb: "Nostr keypair and signer management." },
  relays: { title: "Relays", blurb: "Read and write relay configuration." },
  models: { title: "Models", blurb: "LLM keys and injection management." },
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

function App() {
  const [files, setFiles] = useState<Record<string, FileState>>(INITIAL_FILES);
  const [panels, setPanels] = useState<[string, string]>([
    "essays/on-provenance.md",
    "essays/on-self-hosting.md",
  ]);
  const [activePanel, setActivePanel] = useState<0 | 1>(0);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [running, setRunning] = useState(false);
  const [flashPanel, setFlashPanel] = useState<number | null>(null);
  const [emptyFolders, setEmptyFolders] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState<null | "file" | "folder">(null);
  const [activeView, setActiveView] = useState<View>("editor");
  const [theme, setTheme] = useState<Theme>(() => readTheme());
  const [railExpanded, setRailExpanded] = useState(false);

  function toggleTheme() {
    // Toggle against the *resolved* mode, not the stored preference, so the
    // icon always reflects what the user is currently seeing. Flipping always
    // lands on an explicit light/dark (never back to auto) — predictable.
    const next = resolvedMode(theme) === "dark" ? "light" : "dark";
    applyTheme(next);
    setTheme(next);
  }

  function openInActivePanel(path: string) {
    setPanels((prev) => {
      const next = [...prev] as [string, string];
      next[activePanel] = path;
      return next;
    });
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
    setFiles((prev) => ({ ...prev, [path]: { ...prev[path], runs } }));
  }

  function createStart(kind: "file" | "folder") {
    setCreating(kind);
  }

  function createCancel() {
    setCreating(null);
  }

  function createCommit(name: string) {
    const kind = creating;
    setCreating(null);
    if (!kind) return;
    const cleanName = name.replace(/^\/+|\/+$/g, "");
    if (!cleanName) return;

    if (kind === "file") {
      const path = cleanName.endsWith(".md") ? cleanName : `${cleanName}.md`;
      if (!files[path]) {
        setFiles((prev) => ({ ...prev, [path]: { runs: [{ voice: "alice", text: "" }], nodeId: newNodeId() } }));
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
        next.add(cleanName);
        // ensure the new folder is visible
        setCollapsed((c) => {
          if (!c.has(cleanName)) return c;
          const n = new Set(c);
          n.delete(cleanName);
          return n;
        });
        return next;
      });
    }
  }

  function runAgent() {
    if (running) return;
    setRunning(true);
    window.setTimeout(() => {
      const newPath = "essays/colophon.md";
      setFiles((prev) => ({
        ...prev,
        [newPath]: { runs: [{ voice: "agent", text: "" }], nodeId: "3e0c9a4" },
      }));
      setPanels((prev) => {
        const next = [...prev] as [string, string];
        next[1] = newPath;
        return next;
      });
      setFlashPanel(1);
      setRunning(false);
      window.setTimeout(() => setFlashPanel(null), 1500);
    }, 700);
  }

  // Move `src` (file or folder path) into `destFolder` ("" = root). Rewrites
  // every file and empty-folder path under src, plus any open panels and
  // collapsed-folder state, so nothing dangles. Guards against illegal moves
  // a second time (the Sidebar already checks, but this is the trust boundary).
  function moveNode(src: string, destFolder: string) {
    const fileSet = new Set(Object.keys(files));
    const folderSet = new Set(emptyFolders);
    if (!canDrop(src, destFolder, fileSet, folderSet)) return;

    const isFolderMove = folderSet.has(src) || hasChild(fileSet, folderSet, src);

    setFiles((prev) => {
      const next: Record<string, FileState> = {};
      for (const [path, state] of Object.entries(prev)) {
        if (path === src || (isFolderMove && path.startsWith(src + "/"))) {
          next[rebasePath(path, src, destFolder)] = state;
        } else {
          next[path] = state;
        }
      }
      return next;
    });

    setEmptyFolders((prev) => {
      const next = new Set<string>();
      for (const path of prev) {
        if (path === src || (isFolderMove && path.startsWith(src + "/"))) {
          next.add(rebasePath(path, src, destFolder));
        } else {
          next.add(path);
        }
      }
      return next;
    });

    // follow open panels
    setPanels((prev) => {
      return prev.map((p) =>
        p === src || (isFolderMove && p.startsWith(src + "/"))
          ? rebasePath(p, src, destFolder)
          : p,
      ) as [string, string];
    });

    // collapse state follows folders; expand the destination so the move is visible
    setCollapsed((prev) => {
      const next = new Set<string>();
      for (const path of prev) {
        if (path === src || (isFolderMove && path.startsWith(src + "/"))) {
          next.add(rebasePath(path, src, destFolder));
        } else {
          next.add(path);
        }
      }
      if (destFolder !== ROOT) next.delete(destFolder);
      return next;
    });
  }

  function hasChild(files: Set<string>, folders: Set<string>, parent: string): boolean {
    for (const f of files) if (f.startsWith(parent + "/")) return true;
    for (const f of folders) if (f.startsWith(parent + "/")) return true;
    return false;
  }

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        runAgent();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  const filePaths = useMemo(() => new Set(Object.keys(files)), [files]);
  const folderPaths = useMemo(() => new Set(emptyFolders), [emptyFolders]);

  const tree = useMemo(() => {
    const entries: { path: string; type: "file" | "folder" }[] = [
      ...Object.keys(files).map((p) => ({ path: p, type: "file" as const })),
      ...[...emptyFolders].map((p) => ({ path: p, type: "folder" as const })),
    ];
    return buildTree(entries);
  }, [files, emptyFolders]);

  return (
    <div className="app-shell">
      <div className="body">
        <NavRail
          activeView={activeView}
          onSelect={setActiveView}
          expanded={railExpanded}
          onToggleExpanded={() => setRailExpanded((v) => !v)}
          theme={theme}
          onToggleTheme={toggleTheme}
        />
        {activeView === "editor" ? (
          <>
            <Sidebar
              tree={tree}
              collapsed={collapsed}
              onToggleFolder={toggleFolder}
              openPaths={panels}
              onOpenFile={openInActivePanel}
              creating={creating}
              onCreateStart={createStart}
              onCreateCommit={createCommit}
              onCreateCancel={createCancel}
              filePaths={filePaths}
              folderPaths={folderPaths}
              onMove={moveNode}
            />
            <main className="workspace">
              <div className="workspace-toolbar">
                <button
                  className={"run-agent-btn" + (running ? " running" : "")}
                  onClick={runAgent}
                  disabled={running}
                  type="button"
                >
                  {running ? "writing…" : "run agent"}
                </button>
              </div>
              <div className="workspace-panels">
                {panels.map((path, idx) => (
                  <Panel
                    key={idx}
                    path={path}
                    file={files[path]}
                    active={activePanel === idx}
                    onFocusPanel={() => setActivePanel(idx as 0 | 1)}
                    onEdit={(runs) => editFile(path, runs)}
                    flash={flashPanel === idx}
                  />
                ))}
              </div>
            </main>
          </>
        ) : (
          <ViewPlaceholder view={activeView} />
        )}
      </div>
    </div>
  );
}

export default App;

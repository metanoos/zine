import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import {
  Compartment,
  EditorSelection,
  EditorState,
  Facet,
  StateEffect,
  StateField,
  Transaction,
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
import type { ReactNode } from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import {
  applyEditorAuthorityChanges,
  classifyEditorTransaction,
  createEditorAuthorityState,
  resetEditorAuthorityState,
  type EditorAuthorityState,
} from "./authoring-authority.js";
import {
  captureFileUndoHistory,
  restoreFileUndoHistory,
  selectionAfterEditorTransactions,
  type FileUndoHistorySnapshot,
} from "./file-undo-history.js";
import { collaborationRemoteOperationAnnotation } from "./collaboration-codemirror.js";
import { markdownPreviewExtensions } from "./markdown-preview.js";
import {
  captureStreamingScrollAnchor,
  restoreStreamingScrollTop,
} from "./streaming-scroll.js";
import { markdownIndentExtensions } from "./tab-indent.js";
import {
  authorVoice,
  identityForPubkey,
  subscribeVoiceIdentities,
  voiceSpanStyle,
} from "../identity/keys-store.js";
import {
  bracketExtensions,
  bracketVoiceResolverFacet,
  doubleBackspaceReopenCommand,
  focusedVoiceFacet,
  modeCompartment,
  modeFacet,
  onSelectSpanFacet,
  selectedNodeIdFacet,
  wrapSelectionCommand,
  type Mode,
} from "../provenance/brackets.js";
import { captureEditorTransaction } from "../provenance/editor-transaction-capture.js";
import {
  appendEditorTransactionLog,
  editorTransactionLogToArray,
  EMPTY_EDITOR_TRANSACTION_LOG,
  nextEditorTransactionSequence,
  spliceRuns,
  type EditorTransactionLog,
} from "../workspace/workspace-core.js";
import type { FileState, Run } from "../workspace/workspace.js";
import {
  isZinePathDrag,
  zinePathFromDataTransfer,
} from "../workspace/zine-path-drag.js";

/**
 * The CodeMirror-backed file authoring surface. This module owns editor state,
 * attribution, EditorTransaction capture, replay read-only behavior, and document chrome;
 * AppShell only composes it into a panel.
 */

function flattenRuns(runs: Run[]): string {
  return runs.map((run) => run.text).join("");
}

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
// VoicePalette changes who subsequent edits are attributed to without a reload.
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

function remoteActorFromTransaction(tr: Transaction): string | undefined {
  return tr.annotation(collaborationRemoteOperationAnnotation)?.actorPubkey;
}

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
    const remoteVoice = remoteActorFromTransaction(tr);
    const pen = opVoice || remoteVoice || tr.state.facet(voiceFacet) || authorVoice();
    let out = runs;
    for (let i = changes.length - 1; i >= 0; i--) {
      const { fromA, toA, insert } = changes[i];
      out = spliceRuns(out, fromA, toA, insert, pen);
    }
    return out;
  },
});

/** Synchronizes the editor-owned EditorTransaction log with FileState after a Step, tab
 *  switch, crash-pad restore, or agent write. */
const setEditorTransactionsEffect = StateEffect.define<EditorTransactionLog>();

/** The interactive process log: one `EditorTransaction` per discrete text or
 *  selection action since the last Step (or programmatic content swap). It is
 *  a parallel sink to `voiceField`: text changes preserve the same actor
 *  resolution, while selection-only transactions carry no text changes.
 *  CodeMirror suppresses transactions during IME composition, so a
 *  Chinese/Japanese/Korean commit lands as one transaction containing the
 *  committed text, never the intermediate pinyin. Undo/redo transactions
 *  retain CodeMirror's semantic history intent.
 *
 *  Synchronized after Step by `setEditorTransactionsEffect` and reset on programmatic
 *  repopulation (via the `setRunsEffect` gate, mirroring `voiceField`). Memory
 *  is bounded to the edits after the latest Step. */
const editorTransactionField = StateField.define<EditorTransactionLog>({
  create: () => EMPTY_EDITOR_TRANSACTION_LOG,
  update(buf, tr) {
    for (const e of tr.effects) {
      if (e.is(setEditorTransactionsEffect)) return e.value;
    }
    // Same gate as voiceField: a setRunsEffect-tagged transaction is a
    // programmatic content swap (file switch, agent write, replay restore) —
    // not a user edit, so the interactive log resets. The host records the
    // programmatic transition separately as one atomic EditorTransaction when appropriate.
    for (const e of tr.effects) {
      if (e.is(setRunsEffect)) return EMPTY_EDITOR_TRANSACTION_LOG;
    }
    if (!tr.docChanged && tr.selection === undefined) return buf;
    // Same voice resolution as voiceField.update. A remote Collaboration
    // annotation carries its authenticated signer plus attributed actor, so
    // the receiving panel must never relabel those bytes as its local AUTHOR.
    const opVoice = tr.effects.find((e) => e.is(opVoiceEffect))?.value;
    const remoteOperation =
      tr.annotation(collaborationRemoteOperationAnnotation);
    const pen =
      opVoice || remoteOperation?.actorPubkey || tr.state.facet(voiceFacet) || authorVoice();
    const captured = captureEditorTransaction(
      tr,
      pen,
      nextEditorTransactionSequence(buf),
    );
    if (!captured) return buf;
    // The signed Collaboration operation retains the sender's exact before/after
    // selections. The receiving editor records its locally-applied CRDT
    // coordinates for replay, but uses null selections rather than pretending
    // its own caret was the remote actor's caret.
    const onlyRemoteTransaction =
      remoteOperation?.kind === "file.edit.batch" &&
      remoteOperation.payload.editorTransactions.length === 1
        ? remoteOperation.payload.editorTransactions[0]
        : null;
    const transaction = remoteOperation?.kind === "file.edit.batch"
      ? {
          ...captured,
          timestamp: remoteOperation.timestamp,
          selectionBefore: null,
          selectionAfter: null,
          ...(onlyRemoteTransaction?.intent
            ? { intent: onlyRemoteTransaction.intent }
            : {}),
        }
      : captured;
    return appendEditorTransactionLog(buf, [transaction]);
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
    const actorId =
      remoteActorFromTransaction(tr) ||
      tr.state.facet(voiceFacet) ||
      authorVoice();
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
    lineHeight: "1.55",
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
  ".cm-gutterElement": { minWidth: "1.5em", lineHeight: "1.55", fontSize: "1.1rem" },
});

function buildExtensions(
  onUserEdit: (runs: Run[], editorTransactions: EditorTransactionLog) => void,
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
      if (
        (tr.docChanged || tr.selection !== undefined)
        && !tr.effects.some((e) => e.is(setRunsEffect))
      ) {
        // Non-throwing field read — see buildVoiceDecorations for the HMR
        // rationale. If the field is absent (stale view post-HMR), skip the
        // lift rather than throwing; the next legitimate render resyncs.
        const runs = update.state.field(voiceField, false);
        // Same non-throwing read for the editor transaction log. Mirrors it
        // into FileState on every text or selection action so stepFile can drain it without
        // reaching into the editor view (which lives in a different scope).
        const editorTransactions = update.state.field(editorTransactionField, false);
        if (runs) onUserEdit(runs, editorTransactions ?? EMPTY_EDITOR_TRANSACTION_LOG);
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
      // Backspace twice over one selected bracket to reopen it as editable
      // `[[ …` text. This binding runs before CodeMirror's default deletion;
      // broader selections still flow through bracketProtect below.
      { key: "Backspace", run: doubleBackspaceReopenCommand() },
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
    editorTransactionField,
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
  onEdit: (runs: Run[], editorTransactions: EditorTransactionLog) => void;
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
      (runs, editorTransactions) => onEditRef.current(runs, editorTransactions),
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
  // CodeMirror keeps history inside EditorState. Because one EditorView serves
  // every tab in this panel, save only that field per path before replacing the
  // state. Reusing one state across paths makes Cmd/Ctrl+Z undo the tab switch
  // itself and write the previous file's text into the newly active file.
  const undoHistoryByPathRef = useRef<Map<string, FileUndoHistorySnapshot>>(new Map());

  // Mount once.
  useEffect(() => {
    if (!hostRef.current) return;
    // React StrictMode runs this setup/cleanup pair twice in development.
    // Re-open slot delivery before constructing the replacement view.
    chromeSlotsAliveRef.current = true;
    pathRef.current = path;
    const initialRuns = file.runs ?? [];
    const initialText = flattenRuns(initialRuns);
    const initialTransactions = file.editorTransactions ?? EMPTY_EDITOR_TRANSACTION_LOG;
    const view = new EditorView({
      state: EditorState.create({
        doc: initialText,
        selection: selectionAfterEditorTransactions(
          editorTransactionLogToArray(initialTransactions),
          initialText.length,
        ),
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
        setRunsEffect.of(initialRuns),
        setEditorTransactionsEffect.of(initialTransactions),
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

  // FileState is the cross-component handoff boundary for the EditorTransaction log. A
  // successful Step replaces its already-written prefix with only the edits
  // typed while the relay write was in flight; mirror that exact remainder
  // back into CodeMirror before another input event can land.
  useLayoutEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const expected = file.editorTransactions ?? EMPTY_EDITOR_TRANSACTION_LOG;
    const current = view.state.field(editorTransactionField, false);
    if (current !== undefined && current !== expected) {
      view.dispatch({ effects: setEditorTransactionsEffect.of(expected) });
    }
  }, [path, file.editorTransactions]);

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
  // only refresh, preserving editor state/history and the EditorTransaction log.
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
  // with setRunsEffect so liftRuns doesn't echo them back. A path switch
  // replaces EditorState instead of dispatching a document replacement into
  // the current state: history is a state field, so this is the boundary that
  // keeps each file's undo/redo branch independent.
  useLayoutEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const switched = pathRef.current !== path;
    if (switched) {
      // Save the outgoing file before changing pathRef. A same-text snapshot
      // restores that file's own history when the user returns; a file changed
      // externally while inactive starts clean because positional undo events
      // would no longer be safe against its new text.
      undoHistoryByPathRef.current.set(
        pathRef.current,
        captureFileUndoHistory(view.state),
      );
      pathRef.current = path;
      const nextText = flattenRuns(file.runs ?? []);
      const nextTransactions = file.editorTransactions ?? EMPTY_EDITOR_TRANSACTION_LOG;
      const nextSelection = selectionAfterEditorTransactions(
        editorTransactionLogToArray(nextTransactions),
        nextText.length,
      );
      const nextState = restoreFileUndoHistory(
        nextText,
        extensionsRef.current!,
        undoHistoryByPathRef.current.get(path),
        nextSelection,
      ).update({
        effects: [
          setRunsEffect.of(file.runs ?? []),
          setEditorTransactionsEffect.of(nextTransactions),
          voiceCompartment.reconfigure(voiceFacet.of(voice)),
          modeCompartment.reconfigure(modeFacet.of(mode)),
          voiceAttributionCompartment.reconfigure(
            voiceAttribution ? voiceDecorations : [],
          ),
          focusedVoiceCompartment.reconfigure(focusedVoiceFacet.of(focusedVoice)),
          selectedNodeIdCompartment.reconfigure(selectedNodeIdFacet.of(selectedNodeId)),
          readOnlyCompartment.reconfigure(
            readOnly ? replayReadOnlyFilter(() => triggerRejectRef.current()) : [],
          ),
        ],
        annotations: Transaction.addToHistory.of(false),
      }).state;
      view.setState(nextState);
      // setState does not emit a ViewUpdate, so mirror the selected file's own
      // restored range explicitly rather than retaining the outgoing tab's UI.
      const { from, to } = nextState.selection.main;
      onSelectionRef.current?.(from !== to ? { from, to } : null);
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
    const newText = flattenRuns(file.runs ?? []);
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
          setEditorTransactionsEffect.of(file.editorTransactions ?? EMPTY_EDITOR_TRANSACTION_LOG),
        ],
      });
      return;
    }
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: newText },
      effects: [
        setRunsEffect.of(file.runs ?? []),
        setEditorTransactionsEffect.of(file.editorTransactions ?? EMPTY_EDITOR_TRANSACTION_LOG),
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

export {
  FileEditor,
  authoringAuthorityField,
  editorTransactionField,
  opVoiceEffect,
  setEditorTransactionsEffect,
  setRunsEffect,
  voiceField,
};

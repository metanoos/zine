/**
 * Bracket layer — the authoring surface for minting (see protocol,
 * trace-provenance.md, Composability > Bracket syntax).
 *
 * Brackets are REAL document text: `[[ phrase ]]` (pending) or
 * `[[ phrase | nodeId ]]` (resolved/minted). External editors see valid
 * plain text; the ViewPlugin below only changes how the markup *renders*
 * (spec:211 — "raw `[[ ]]` stays in the file"). This is why brackets live as
 * document text, not a decoration-only overlay: a snapshot's inner content is
 * what the reader sees, and the on-disk bytes round-trip through any editor.
 *
 * Authoring: selecting text is non-destructive. A bracket is created only
 * when the author chooses Snapshot (Cmd/Ctrl+S over a selection), which both
 * wraps the phrase in `[[ ]]` and publishes it as a minted trace node.
 * `wrapSelectionCommand` is the shared wrap primitive the Snapshot path calls.
 *
 * Delete resilience (Markdown mode): a delete (Backspace/Delete/type-over)
 * that *fully contains* one or more `[[ … ]]` spans spares them — only the
 * loose text between/around the brackets is removed. The `bracketProtect`
 * filter rewrites such a transaction into gap-deletions so the brackets
 * survive. Edge-overlapping deletes still rupture brackets (consistent with
 * the pin-vs-bracket rupture model documented in App.tsx). In Preview mode
 * this filter is inert — a fully-contained delete there is exactly what a
 * one-keystroke atomic-chip Backspace produces, and it's meant to delete
 * the chip, not spare it.
 *
 * The bracketing is LITERAL: the `[[ ]]` characters render as plain document
 * text and stay visible — they are what marks a run as a trace component. The
 * `| nodeId` citation suffix, on the other hand, is hidden from view: the event
 * id is load-bearing in the bytes (the seal path mirrors it as a `q` tag) but
 * is noise in the prose, and the bracket alone is enough to mark the run. So a
 * resolved `[[ phrase | nodeId ]]` renders as `[[ phrase ]]`. This is a third
 * decoration layer, independent of `voiceField` and `pinField` in App.tsx — per
 * spec:212, "render them as independent layers, not as variants of one marker."
 *
 * The above describes Markdown mode. In Preview mode (`modeFacet`), a complete
 * bracket/command instead collapses into a single atomic chip widget
 * (`CitationWidget`/`DirectiveWidget`) — still the same on-disk bytes, still
 * the same editable doc, just a different render. Only the decoration layer
 * changes; nothing here alters what gets written to file.runs.
 */

import type { Extension, Range, TransactionSpec } from "@codemirror/state";
import { Compartment, EditorState, Facet, type Transaction } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type Command,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { voiceSpanStyle } from "./keys-store";

const BRACKET_OPEN = "[[ ";
const BRACKET_CLOSE = " ]]";

/** Which surface the editor is rendering as: raw markdown source, or the
 *  typeset "preview" where citation/directive marks collapse into atomic
 *  chip widgets. One editable CodeMirror doc serves both — this facet just
 *  switches which decorations `buildBracketDecorations`/`buildCommandDecorations`
 *  emit (see App.tsx's FileEditor for how it's wired to the mode toggle). */
export type Mode = "preview" | "markdown";
export const modeFacet = Facet.define<Mode, Mode>({ combine: (v) => v[0] ?? "markdown" });
/** Holds modeFacet so it can be reconfigured live on a mode switch, without
 *  rebuilding the editor's extensions (mirrors voiceCompartment in App.tsx). */
export const modeCompartment = new Compartment();

/** Resolve a doc offset to the voice (pubkey) of the run covering it, or "" if
 *  unknown. The resolver receives the live `EditorView` so it can read CM's own
 *  run state synchronously during a decoration rebuild — React's `file.runs`
 *  lags the transaction by a tick (`onEdit` → `setFiles` → re-render), which
 *  would leave a just-typed chip voiced-neutral for one frame. Reading the field
 *  in-pipeline avoids that. App.tsx supplies a closure over its `voiceField`;
 *  default "" → neutral chrome. */
export type BracketVoiceResolver = (view: EditorView, offset: number) => string;
export const bracketVoiceResolverFacet = Facet.define<BracketVoiceResolver, BracketVoiceResolver>({
  combine: (v) => v[0] ?? (() => ""),
});

/** The nodeId of the currently-selected minted span, or "" if no span (or a
 *  non-span trace) is selected. Drives the gold ring on the matching bracket in
 *  both Markdown (a `--selected` mark) and Preview (a chip class) modes. */
export const selectedNodeIdFacet = Facet.define<string, string>({ combine: (v) => v[0] ?? "" });

/** Click a preview-mode citation chip (or a markdown bracket) to make that
 *  minted span the active trace. App.tsx supplies a closure over its
 *  `selectSpan`. Default no-op. */
export type SelectSpanHandler = (nodeId: string, phrase: string) => void;
export const onSelectSpanFacet = Facet.define<SelectSpanHandler, SelectSpanHandler>({
  combine: (v) => v[0] ?? (() => {}),
});

/** Click the copy button on a citation chip. App.tsx supplies a closure over
 *  its `copySpan`, which writes the citation to the clipboard *and* appends the
 *  span to the palette (curating it for reuse). The chip still does its own
 *  clipboard write + check-flash here, so a missing handler degrades to plain
 *  copy; this callback is the "also curate" side effect. Default no-op. */
export type CopySpanHandler = (nodeId: string, phrase: string) => void;
export const onCopySpanFacet = Facet.define<CopySpanHandler, CopySpanHandler>({
  combine: (v) => v[0] ?? (() => {}),
});

// Inline copy of lucide-react's Copy/Check glyphs (24x24 viewBox, stroke
// paths) — the widget is built as raw DOM, not JSX, so the icons the app
// already uses for copy affordances (KeysView.tsx) are reproduced by hand
// rather than pulled in as React components.
const COPY_ICON_PATH =
  '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>';
const CHECK_ICON_PATH = '<path d="M20 6 9 17l-5-5"/>';

function makeIconSvg(inner: string): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "13");
  svg.setAttribute("height", "13");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = inner;
  return svg;
}

/** Preview-mode widget for a `[[ phrase ]]` / `[[ phrase | nodeId ]]` bracket:
 *  renders as a chip that keeps the literal `[[`/`]]` markup visible (styled,
 *  not hidden) with the 8-char abbrev of the cited nucleus and a copy button
 *  inside, next to the phrase. The full nodeId is carried on the chip's
 *  `title` (hover) and in the copy payload — never rendered inline, since the
 *  abbrev is enough to read and the full id is noise in the prose. The phrase
 *  itself renders in the **attributed voice's** font +
 *  color (the voice that wrote the run, resolved via `bracketVoiceResolverFacet`
 *  — same `voiceSpanStyle` resolver the in-doc voice layer uses), so a chip
 *  reads as that voice's contribution; the bracket/sep/node/copy chrome stays
 *  neutral. Hand-built DOM, not JSX — Atomic (see `EditorView.atomicRanges`
 *  below), so the whole span moves/deletes as one unit; editing the phrase
 *  or id requires switching to Markdown mode. */
class CitationWidget extends WidgetType {
  constructor(
    readonly phrase: string,
    readonly nodeId: string,
    readonly voice: string,
    readonly selected: boolean,
    readonly onSelect: SelectSpanHandler | null,
    readonly onCopy: CopySpanHandler | null,
  ) {
    super();
  }
  eq(other: CitationWidget): boolean {
    return (
      other.phrase === this.phrase &&
      other.nodeId === this.nodeId &&
      other.voice === this.voice &&
      other.selected === this.selected &&
      !!other.onSelect === !!this.onSelect &&
      !!other.onCopy === !!this.onCopy
    );
  }
  toDOM(): HTMLElement {
    const cite = document.createElement("cite");
    cite.className = "md-cite" + (this.selected ? " md-cite-selected" : "");
    cite.title = this.nodeId || "pending snapshot";
    // Clicking the chip (anywhere but the copy button) selects this minted
    // span as the active trace — accent-soft outline in the palette. ignoreEvent still
    // lets the copy button keep its own click; a chip without a nodeId can't be
    // selected (nothing to bind to) so it stays click-to-cursor only.
    if (this.nodeId && this.onSelect) {
      cite.addEventListener("click", (e) => {
        if (e.target instanceof Element && e.target.closest(".md-cite-copy")) return;
        this.onSelect!(this.nodeId, this.phrase);
      });
    }

    const openBracket = document.createElement("span");
    openBracket.className = "md-cite-bracket";
    openBracket.textContent = "[[";

    const phraseSpan = document.createElement("span");
    phraseSpan.className = "md-cite-phrase";
    phraseSpan.textContent = this.phrase;
    // Adopt the attributed voice's font + color so the phrase reads as that
    // voice's contribution — same resolver/inline-style the in-doc voice layer
    // uses (App.tsx's voiceDecorations), so the chip matches the run exactly.
    // Empty voice (unknown/unresolved) leaves the phrase in neutral chrome.
    if (this.voice) {
      const { className, style } = voiceSpanStyle(this.voice);
      // Voice bucket class (voice-0..5) appends; the known-key path returns the
      // base "voice-span" class, which is a no-op modifier here.
      phraseSpan.className = `md-cite-phrase ${className}`;
      if (style) phraseSpan.setAttribute("style", style);
    }

    const closeBracket = document.createElement("span");
    closeBracket.className = "md-cite-bracket";
    closeBracket.textContent = "]]";

    cite.append(openBracket, phraseSpan);

    if (this.nodeId) {
      const sep = document.createElement("span");
      sep.className = "md-cite-sep";
      sep.textContent = "|";

      const nodeSpan = document.createElement("span");
      nodeSpan.className = "md-cite-node";
      // Render only the 8-char abbrev of the cited nucleus inline; the full
      // id lives on `cite.title` (hover) and in the copy payload below. Same
      // slice(0,8) convention every shortId in the app uses.
      nodeSpan.textContent = this.nodeId.slice(0, 8);

      const copyBtn = document.createElement("button");
      copyBtn.type = "button";
      copyBtn.className = "md-cite-copy";
      // Copy the full bracket markup, not just the event id: pasting it into
      // another doc inserts `[[ phrase | nodeId ]]` as real text, and the next
      // seal's `findResolvedBrackets` pass turns the nodeId into a `q`-citation
      // edge on that doc's trace node — i.e. the paste installs a reference
      // and the save records the component trace for the insert (spec:189).
      copyBtn.title = "Copy bracket";
      const copyIcon = makeIconSvg(COPY_ICON_PATH);
      copyBtn.append(copyIcon);
      copyBtn.addEventListener("mousedown", (e) => e.preventDefault()); // don't steal editor focus
      copyBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const payload = `[[ ${this.phrase} | ${this.nodeId} ]]`;
        navigator.clipboard?.writeText(payload).then(() => {
          copyBtn.replaceChildren(makeIconSvg(CHECK_ICON_PATH));
          setTimeout(() => copyBtn.replaceChildren(makeIconSvg(COPY_ICON_PATH)), 1200);
        }, () => {
          /* clipboard unavailable — no-op, mirrors KeysView's copy handler */
        });
        // Also curate: append the span to the palette (idempotent — re-copying
        // an already-saved span is a no-op). Runs alongside the clipboard write
        // above, so copy = "pasteable citation" + "saved for reuse".
        this.onCopy?.(this.nodeId, this.phrase);
      });

      cite.append(sep, nodeSpan, copyBtn);
    }

    cite.append(closeBracket);
    return cite;
  }
  ignoreEvent(event: Event): boolean {
    // Let the copy button handle its own clicks (don't let CM reinterpret
    // them as a cursor-placement click); everything else in the chip keeps
    // the normal "click lands at the nearest edge" atomic-widget behavior.
    return event.target instanceof Element && event.target.closest(".md-cite-copy") !== null;
  }
}

/** Preview-mode widget for a `(( command ))` directive. Atomic, same as
 *  CitationWidget — the `::before`/`::after` CSS on `.md-directive` supplies
 *  the visual `(( `/` ))` framing, so the DOM here is just the command text. */
class DirectiveWidget extends WidgetType {
  constructor(readonly command: string) {
    super();
  }
  eq(other: DirectiveWidget): boolean {
    return other.command === this.command;
  }
  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "md-directive";
    span.textContent = this.command;
    return span;
  }
  ignoreEvent(): boolean {
    return false;
  }
}

/** One matched bracket occurrence, decomposed into visible-phrase + hidden-
 *  markup ranges. Computed from a regex match so the decoration step never
 *  re-parses. */
interface BracketMatch {
  /** Absolute doc position of the whole `[[ … ]]` occurrence (inclusive). */
  matchStart: number;
  matchEnd: number;
  /** Visible phrase range (inner text, trimmed of markup padding). */
  phraseStart: number;
  phraseEnd: number;
  resolved: boolean; // has a `| nodeId` suffix
}

const BRACKET_RE = /\[\[([\s\S]*?)\]\]/g;

/** Walk the document text, yielding one BracketMatch per `[[ … ]]`. Lazy
 *  matching + the `\]\]` terminator means an unterminated `[[` yields nothing
 *  (the author is mid-typed) and two brackets on one line parse independently. */
export function* iterBrackets(text: string): Generator<BracketMatch> {
  BRACKET_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = BRACKET_RE.exec(text)) !== null) {
    const matchStart = m.index;
    const matchEnd = matchStart + m[0].length;
    const innerStart = matchStart + 2; // after "[["
    const inner = m[1];

    // Split an optional `| nodeId` suffix. lastIndexOf so a phrase containing
    // a literal "|" (rare) still binds to the rightmost separator.
    const pipeRel = inner.lastIndexOf("|");
    const resolved = pipeRel !== -1;
    const left = resolved ? inner.slice(0, pipeRel) : inner;

    const firstNs = left.search(/\S/); // -1 if left is all whitespace
    const phraseStartRel = firstNs === -1 ? left.length : firstNs;
    const phraseEndRel = left.replace(/\s+$/, "").length;
    yield {
      matchStart,
      matchEnd,
      phraseStart: innerStart + phraseStartRel,
      phraseEnd: innerStart + phraseEndRel,
      resolved,
    };
  }
}

/** Build the decoration set. In Markdown mode, the whole `[[ … ]]` run is
 *  tinted with a mark, with one exception: on a resolved bracket, the
 *  ` | nodeId` citation suffix (from the pipe to just before the closing
 *  `]]`) is replaced with an inline 8-char abbrev widget — the full event id
 *  is noise in the prose, but the abbrev (the cited nucleus's `slice(0,8)`)
 *  stays visible so a minted span reads as a token, not as bare brackets.
 *  The full id is carried on the widget's `title` (hover). The `[[`, phrase,
 *  and `]]` stay literal in every case.
 *
 *  In Preview mode, a complete match (non-empty phrase) instead collapses
 *  into one atomic `CitationWidget` covering the whole occurrence — see
 *  `EditorView.atomicRanges` below for why it behaves as a single unit. An
 *  incomplete/empty match (`[[]]`, or `[[` still being typed) is left as
 *  literal text in both modes — "the author is mid-typed." */
function buildBracketDecorations(view: EditorView): DecorationSet {
  const text = view.state.doc.toString();
  const preview = view.state.facet(modeFacet) === "preview";
  const selectedNodeId = view.state.facet(selectedNodeIdFacet);
  const onSelect = view.state.facet(onSelectSpanFacet);
  const onCopy = view.state.facet(onCopySpanFacet);
  const decos: Range<Decoration>[] = [];
  for (const b of iterBrackets(text)) {
    if (b.matchEnd <= b.matchStart) continue;
    if (preview) {
      if (b.phraseEnd <= b.phraseStart) continue; // empty phrase stays literal
      const phrase = text.slice(b.phraseStart, b.phraseEnd);
      const nodeId = b.resolved ? findResolvedNodeId(text, b) : "";
      // Resolve the voice at the phrase start so the chip adopts the writing
      // voice's font + color. The resolver reads CM's voiceField in-pipeline.
      const voice = view.state.facet(bracketVoiceResolverFacet)(view, b.phraseStart);
      const selected = !!nodeId && nodeId === selectedNodeId;
      decos.push(
        Decoration.replace({
          widget: new CitationWidget(
            phrase,
            nodeId,
            voice,
            selected,
            onSelect ?? null,
            onCopy ?? null,
          ),
        }).range(b.matchStart, b.matchEnd),
      );
      continue;
    }
    const nodeId = b.resolved ? findResolvedNodeId(text, b) : "";
    const selected = !!nodeId && nodeId === selectedNodeId;
    const cls = b.resolved
      ? "bracketed-span bracketed-span--resolved"
      : "bracketed-span bracketed-span--pending";
    // Mark the entire occurrence — brackets, phrase, and (if present) the
    // `| nodeId` suffix region. The suffix bytes are hidden separately below.
    // The `--selected` modifier stacks a gold ring when this span is the active
    // trace (selectedNodeIdFacet), independent of resolved/pending.
    decos.push(
      Decoration.mark({ class: cls + (selected ? " bracketed-span--selected" : "") }).range(
        b.matchStart,
        b.matchEnd,
      ),
    );
    // Replace the ` | nodeId` citation suffix (from the end of the visible
    // phrase up to but excluding the closing `]]`) with the inline abbrev
    // widget. The phrase range already excludes trailing padding, so this
    // covers `| nodeId` + its surrounding spaces. Same range the old hidden-
    // suffix replace covered; now it surfaces the 8-char token instead of
    // blanking the region.
    if (b.resolved && b.matchEnd - 2 > b.phraseEnd) {
      decos.push(
        Decoration.replace({
          widget: new NodeAbbrevWidget(nodeId.slice(0, 8), nodeId),
        }).range(b.phraseEnd, b.matchEnd - 2),
      );
    }
  }
  return Decoration.set(decos, true);
}

/** Markdown-mode widget that replaces the hidden `| nodeId` suffix of a
 *  resolved bracket with an inline `| <8-char>` token — the cited nucleus's
 *  abbrev, never the full id. The full id is carried on the `title` so a hover
 *  still reveals it. Sibling to the Preview-mode `CitationWidget`'s node span;
 *  both render the same `slice(0,8)` abbrev, so a minted span reads as one
 *  token across modes. */
class NodeAbbrevWidget extends WidgetType {
  constructor(readonly abbrev: string, readonly fullNodeId: string) {
    super();
  }
  eq(other: NodeAbbrevWidget): boolean {
    return other.abbrev === this.abbrev && other.fullNodeId === this.fullNodeId;
  }
  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "bracketed-abbrev";
    span.title = this.fullNodeId;
    span.textContent = `| ${this.abbrev}`;
    return span;
  }
  ignoreEvent(): boolean {
    return false;
  }
}

/** Re-slice a resolved bracket's nodeId — `BracketMatch` only exposes
 *  `resolved`, not the id itself (mirrors `findResolvedBrackets`). */
function findResolvedNodeId(text: string, b: BracketMatch): string {
  const inner = text.slice(b.matchStart + 2, b.matchEnd - 2);
  const pipeRel = inner.lastIndexOf("|");
  return pipeRel === -1 ? "" : inner.slice(pipeRel + 1).trim();
}

const bracketDecorations = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildBracketDecorations(view);
    }
    update(update: ViewUpdate) {
      // Rebuild on any effect (not just docChanged/viewportChanged) so a
      // modeCompartment reconfigure — dispatched as an effect — redecorates
      // immediately. Mirrors voiceDecorations/pinDecorations in App.tsx. Also
      // rebuild when the selected-span or voice-resolver facets change, so a
      // pure selection move (no doc edit) still re-rings the right bracket.
      const selChanged =
        update.startState.facet(selectedNodeIdFacet) !==
        update.state.facet(selectedNodeIdFacet);
      if (
        update.docChanged ||
        update.viewportChanged ||
        update.transactions.some((t) => t.effects.length) ||
        selChanged
      ) {
        this.decorations = buildBracketDecorations(update.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

/** The whole span of a Preview-mode citation widget is one cursor-motion/
 *  backspace unit — click lands at an edge, Backspace/Delete removes the
 *  whole `[[ … ]]` occurrence rather than eating into it. In Markdown mode
 *  `bracketDecorations` never emits replace ranges, so this is a no-op. */
const bracketAtomicRanges = EditorView.atomicRanges.of(
  (view) => view.plugin(bracketDecorations)?.decorations ?? Decoration.none,
);

/** Wrap the current selection in `[[ ]]`, leaving it pending. This is the pure
 *  wrap primitive: it inserts the markup only and does NOT publish anything.
 *  Protection is immediate — `bracketProtect` (above) spares the resulting
 *  `[[ … ]]` from any later fully-contained delete. Hardening (publishing the
 *  phrase as its own trace node) is a separate, opt-in gesture (ZINE); a
 *  bracket stays pending across saves until ZINE resolves it.
 *
 *  Returns true only when it actually wrapped, so a keymap binding falls through
 *  to the editor otherwise. Same skip-conditions as always: empty selection, a
 *  selection that itself spans bracket markup (would nest/mangle), or a
 *  selection already wrapped. */
export function wrapSelectionCommand(): Command {
  return (view: EditorView): boolean => {
    const sel = view.state.selection.main;
    if (sel.from === sel.to) return false; // empty selection — nothing to capture
    const selected = view.state.sliceDoc(sel.from, sel.to);
    // Skip if the selection itself spans bracket markup (would nest/mangle).
    if (!selected || selected.includes("[[") || selected.includes("]]")) return false;
    // Skip if already wrapped — re-selecting a bracketed phrase is a no-op.
    const before = view.state.sliceDoc(Math.max(0, sel.from - BRACKET_OPEN.length), sel.from);
    const after = view.state.sliceDoc(sel.to, sel.to + BRACKET_CLOSE.length);
    if (before.endsWith(BRACKET_OPEN) || after.startsWith(BRACKET_CLOSE)) return false;
    // Both insert positions are original-doc coordinates; CM6 applies a
    // multi-change array as simultaneous, so the second `from` need not
    // account for the first insertion's shift. The selection maps through
    // automatically and stays on the phrase.
    view.dispatch({
      changes: [
        { from: sel.from, insert: BRACKET_OPEN },
        { from: sel.to, insert: BRACKET_CLOSE },
      ],
    });
    return true;
  };
}

/** A `transactionExtender` that makes a delete spare any `[[ … ]]` span it
 *  *fully contains*. A pure deletion spanning `[a, b)` is rewritten into the
 *  gaps between fully-contained brackets within `[a, b)`, so the brackets
 *  (and their bytes) survive while the loose text between them is removed.
 *  Edge-overlapping deletes are left untouched — a bracket the delete doesn't
 *  fully contain ruptures normally (consistent with the pin-vs-bracket rupture
 *  model in App.tsx).
 *
 *  Pure deletions only (inserted text is empty). A type-over (select + type)
 *  passes through unchanged: replacing the whole selection including brackets
 *  with the typed text is the predictable behavior, and splicing the insert
 *  into a gap would surprise. Runs as a `transactionFilter`, so the rewrite
 *  is a single undo entry — matching the app's "one transaction = one undo"
 *  convention. Returns the rewritten transaction, or `[tr]` to pass through.
 *
 *  Markdown mode only: in Preview mode a bracket is a single atomic chip
 *  (see `bracketAtomicRanges`), so a Backspace/Delete at its edge deletes
 *  the whole occurrence in one transaction that *exactly* spans the bracket
 *  — precisely the shape this filter would otherwise "spare" (fully
 *  contained, nothing left over). Sparing it there would silently turn
 *  "delete the chip" into a no-op, so this filter only runs in Markdown
 *  mode, where the same shape means something different: the author
 *  selected/typed-over exactly a bracket's raw text. */
function bracketProtect(tr: Transaction): TransactionSpec | readonly Transaction[] {
  if (!tr.docChanged) return [tr];
  if (tr.startState.facet(modeFacet) === "preview") return [tr];
  // Rebuilt change specs for the rewritten transaction (original-doc coords;
  // CM6 applies a multi-change array simultaneously, so positions don't shift).
  const newChanges: { from: number; to: number }[] = [];
  let anyRewrite = false;
  const text = tr.startState.doc.toString();

  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    if (toA <= fromA) return; // pure insert — nothing to protect
    if (inserted.length > 0) return; // type-over — let it replace normally
    // Pure deletion. Collect brackets fully contained in [fromA, toA).
    const spared: { matchStart: number; matchEnd: number }[] = [];
    for (const b of iterBrackets(text)) {
      if (b.matchStart >= fromA && b.matchEnd <= toA) {
        spared.push({ matchStart: b.matchStart, matchEnd: b.matchEnd });
      } else if (b.matchStart >= toA) {
        break; // iterBrackets is in document order; past the range, stop.
      }
    }
    if (spared.length === 0) return; // nothing to spare — original change stands
    anyRewrite = true;
    // Emit one deletion per gap between spared brackets. All in original-doc
    // coords (pre-change), so they compose into the same net deletion minus
    // the bracket bytes.
    let cursor = fromA;
    for (const s of spared) {
      if (s.matchStart > cursor) newChanges.push({ from: cursor, to: s.matchStart });
      cursor = s.matchEnd; // skip over the spared bracket
    }
    if (cursor < toA) newChanges.push({ from: cursor, to: toA });
  });

  if (!anyRewrite) return [tr]; // nothing rewritten — pass the tr through
  // Rebuild with the rewritten changes; carry selection and effects so
  // programmatic intent round-trips. (transactionFilter preserves the tr's
  // own annotations/userEvent automatically on the returned transaction via
  // `update` — we only override `changes` and `selection`.)
  return [
    tr.startState.update({
      changes: newChanges,
      selection: tr.selection,
      effects: tr.effects,
    }),
  ];
}

const bracketProtectFilter = EditorState.transactionFilter.of(bracketProtect);

/** Exposed for the minting pass (Phase 2): the list of *pending* (unresolved)
 *  brackets in `text`, each with its phrase text and the absolute position of
 *  the *whole* `[[ … ]]` occurrence (so the caller can locate and rewrite it).
 *  String-based — works on flatten(file.runs), no EditorView needed. */
/** Exposed for the minting pass (Phase 2): the list of *pending* (unresolved)
 *  brackets in `text`, each with its phrase text and the absolute position of
 *  the *whole* `[[ … ]]` occurrence (so the caller can locate and rewrite it).
 *  String-based — works on flatten(file.runs), no EditorView needed. */
export function findPendingBrackets(text: string): { phrase: string; matchStart: number; matchEnd: number }[] {
  const out: { phrase: string; matchStart: number; matchEnd: number }[] = [];
  for (const b of iterBrackets(text)) {
    if (b.resolved) continue;
    if (b.phraseEnd <= b.phraseStart) continue;
    out.push({ phrase: text.slice(b.phraseStart, b.phraseEnd), matchStart: b.matchStart, matchEnd: b.matchEnd });
  }
  return out;
}

/** The list of *resolved* (minted) brackets in `text`, each with its phrase
 *  text and the nodeId it cites. Sibling to `findPendingBrackets`: the citation
 *  is the load-bearing half of minting (spec:189 — the origin doc's cite of
 *  the minted node is mirrored as a top-level `q` tag on its next seal).
 *  String-based — works on a snapshot being published, no EditorView needed.
 *
 *  `iterBrackets` yields `resolved: true` for these but doesn't expose the
 *  nodeId on `BracketMatch` (only `resolved`), so it's re-sliced here from
 *  between `|` and `]]` — mirroring the write format `resolveBracket` emits
 *  (`${inner} | ${nodeId} ]]`). */
export function findResolvedBrackets(text: string): { phrase: string; nodeId: string; matchStart: number; matchEnd: number }[] {
  const out: { phrase: string; nodeId: string; matchStart: number; matchEnd: number }[] = [];
  for (const b of iterBrackets(text)) {
    if (!b.resolved) continue;
    if (b.phraseEnd <= b.phraseStart) continue;
    // `inner` = text between `[[` and `]]`; nodeId = everything after the
    // rightmost `|`, trimmed.
    const inner = text.slice(b.matchStart + 2, b.matchEnd - 2);
    const pipeRel = inner.lastIndexOf("|");
    if (pipeRel === -1) continue; // defensive — `resolved` already guarantees a `|`
    const nodeId = inner.slice(pipeRel + 1).trim();
    if (!nodeId) continue;
    out.push({
      phrase: text.slice(b.phraseStart, b.phraseEnd),
      nodeId,
      matchStart: b.matchStart,
      matchEnd: b.matchEnd,
    });
  }
  return out;
}

/** Rewrite the bare `[[ phrase ]]` at [matchStart, matchEnd) into a resolved
 *  `[[ phrase | nodeId ]]`. String-based — the caller applies the result to
 *  file.runs and lets FileEditor's setRunsEffect push it into the CM doc. */
export function resolveBracket(text: string, matchStart: number, matchEnd: number, nodeId: string): string {
  const occurrence = text.slice(matchStart, matchEnd);
  // occurrence is `[[ phrase ]]`; insert ` | nodeId` before the closing `]]`.
  const closeIdx = occurrence.lastIndexOf("]]");
  if (closeIdx === -1) return text; // defensive — shouldn't happen
  const inner = occurrence.slice(0, closeIdx).replace(/\s+$/, "");
  const rewritten = `${inner} | ${nodeId} ]]`;
  return text.slice(0, matchStart) + rewritten + text.slice(matchEnd);
}

// --- command layer (( )) ----------------------------------------------
//
// A *temp-lived* directive the author drops into the prose, e.g.
// `((rewrite this tighter))`. Unlike brackets — which are permanent,
// minted, citable document text — commands are consumed by the Stir op and
// then removed; they never reach a seal. So the layer is decoration-only: no
// trigger (the author types `(( ))` directly). The `(( ))` characters render
// literally; a mark just tints the run so the directive reads as transient.

const CMD_RE = /\(\(([\s\S]*?)\)\)/g;

/** One matched command occurrence. The visible inner-text range is the part a
 *  Stir call sees as the directive; the surrounding `(( ))` is hidden markup. */
export interface CommandMatch {
  matchStart: number;
  matchEnd: number;
  /** Visible inner range (the directive text, trimmed of markup padding). */
  cmdStart: number;
  cmdEnd: number;
}

/** Walk the document text, yielding one CommandMatch per `(( … ))`. Like
 *  iterBrackets, lazy matching means an unterminated `((` yields nothing. */
export function* iterCommands(text: string): Generator<CommandMatch> {
  CMD_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CMD_RE.exec(text)) !== null) {
    const matchStart = m.index;
    const matchEnd = matchStart + m[0].length;
    const innerStart = matchStart + 2; // after "(("
    const inner = m[1];
    const firstNs = inner.search(/\S/);
    const cmdStartRel = firstNs === -1 ? inner.length : firstNs;
    const cmdEndRel = inner.replace(/\s+$/, "").length;
    yield {
      matchStart,
      matchEnd,
      cmdStart: innerStart + cmdStartRel,
      cmdEnd: innerStart + cmdEndRel,
    };
  }
}

function buildCommandDecorations(view: EditorView): DecorationSet {
  const text = view.state.doc.toString();
  const preview = view.state.facet(modeFacet) === "preview";
  const decos: Range<Decoration>[] = [];
  for (const c of iterCommands(text)) {
    if (c.matchEnd <= c.matchStart) continue;
    if (preview) {
      if (c.cmdEnd <= c.cmdStart) continue; // empty command stays literal
      const command = text.slice(c.cmdStart, c.cmdEnd);
      decos.push(
        Decoration.replace({ widget: new DirectiveWidget(command) }).range(
          c.matchStart,
          c.matchEnd,
        ),
      );
      continue;
    }
    // Mark the whole `(( … ))` run — parens stay literal, just tinted.
    decos.push(Decoration.mark({ class: "command-span" }).range(c.matchStart, c.matchEnd));
  }
  return Decoration.set(decos, true);
}

const commandDecorations = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildCommandDecorations(view);
    }
    update(update: ViewUpdate) {
      // See bracketDecorations.update — rebuild on any effect so a mode
      // switch redecorates immediately.
      if (
        update.docChanged ||
        update.viewportChanged ||
        update.transactions.some((t) => t.effects.length)
      ) {
        this.decorations = buildCommandDecorations(update.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

/** See bracketAtomicRanges — same atomic-unit treatment for directive chips. */
const commandAtomicRanges = EditorView.atomicRanges.of(
  (view) => view.plugin(commandDecorations)?.decorations ?? Decoration.none,
);

/** Exposed for the Stir op: the list of `(( command ))` directives in `text`,
 *  each with its directive text and the absolute position of the whole
 *  occurrence (so the caller can locate and strip it). String-based. */
export function findCommands(text: string): { command: string; matchStart: number; matchEnd: number }[] {
  const out: { command: string; matchStart: number; matchEnd: number }[] = [];
  for (const c of iterCommands(text)) {
    if (c.cmdEnd <= c.cmdStart) continue;
    out.push({ command: text.slice(c.cmdStart, c.cmdEnd), matchStart: c.matchStart, matchEnd: c.matchEnd });
  }
  return out;
}

/** Build the bracket+command extension set: decorations for `[[ ]]` and
 *  `(( ))` (mode-aware — see modeFacet), the atomic-range wiring that makes
 *  Preview-mode chips act as one unit, plus the `bracketProtect` transaction
 *  filter that spares fully-contained brackets from a delete. Wrapping a
 *  selection is opt-in via `wrapSelectionCommand` (called from the selection
 *  menu and Cmd/Ctrl+S in App.tsx), not a side effect of selecting. The caller
 *  (App.tsx) is responsible for including `modeCompartment.of(modeFacet.of(mode))`
 *  separately, mirroring how it assembles `voiceCompartment.of(...)`. */
export function bracketExtensions(): Extension[] {
  return [
    bracketDecorations,
    commandDecorations,
    bracketAtomicRanges,
    commandAtomicRanges,
    bracketProtectFilter,
  ];
}

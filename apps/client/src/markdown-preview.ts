/**
 * Markdown preview layer — the second decoration pass that runs in Preview
 * mode alongside the bracket/command layer (brackets.ts).
 *
 * The press's editor is ONE CodeMirror doc; Preview vs Markdown is purely a
 * decoration/CSS switch (see FileEditor/modeFacet in App.tsx). The bracket
 * layer already collapses the press's own `[[ ]]` / `(( ))` marks into chips.
 * This layer does the same for STANDARD markdown symbols: in Preview mode it
 * hides the `#` / `**` / `` ` `` / `-` / `>` / `~~` markup characters and
 * styles the text beneath them (headings in the display face, bold/italic/
 * strike runs, code in mono, blockquoted lines with a border, lists with
 * markers, horizontal rules). The on-disk bytes are untouched — every char
 * stays in the doc, only its rendering changes. Switch to Markdown mode and
 * the raw source reappears, byte-for-byte.
 *
 * Same architecture as bracketDecorations/commandDecorations: a ViewPlugin
 * that reads modeFacet, returns Decoration.none in Markdown mode, and
 * rebuilds on any doc/effect change so a mode toggle redecorates at once.
 * No parser dependency (no @codemirror/lang-markdown / @lezer/markdown) — a
 * line+regex scan is enough for the construct set the press cares about, and
 * keeps the layer readable and decoupled from a grammar's tree shape.
 *
 * Coexistence with the bracket layer: brackets/commands use Decoration.replace
 * over their whole `[[ … ]]` / `(( … ))` match. Two replace ranges from
 * different plugins cannot overlap, so this layer computes the bracket/
 * command ranges up front (via the exported iterBrackets/iterCommands) and
 * refuses to emit any decoration that overlaps them — a heading whose text
 * contains `[[ phrase ]]` still gets its line styling and its `# ` hidden, but
 * the mark over the bracketed phrase is split around the bracket's range.
 *
 * Cursor-reveal: a hidden (replace→empty) marker whose span is adjacent to
 * the primary selection is left visible, so the user can edit markup near the
 * caret without flipping to Markdown mode. Mid-typed constructs (`**bold` with
 * no closer, an unterminated ```` ``` ```` fence) are left literal, mirroring
 * bracket.ts's unterminated-`[[` behavior.
 */

import type { Extension, Range } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { iterBrackets, iterCommands, modeFacet } from "./brackets.js";

/** A half-open absolute doc range. Local alias to keep signatures short. */
interface Span {
  from: number;
  to: number;
}

function overlaps(a: Span, b: Span): boolean {
  return a.from < b.to && b.from < a.to;
}

function overlapsAny(s: Span, list: Span[]): boolean {
  for (const r of list) if (overlaps(s, r)) return true;
  return false;
}

/** Push a `mark` decoration over [from,to), split around any reserved
 *  (bracket/command) range it would contain. A mark cannot wrap a replace
 *  widget emitted by another plugin without rendering oddly, so the mark is
 *  emitted per gap instead. `reserved` must be sorted ascending by `from`. */
function pushMarkSplit(
  decos: Range<Decoration>[],
  cls: string,
  from: number,
  to: number,
  reserved: Span[],
): void {
  let cursor = from;
  for (const r of reserved) {
    if (r.to <= cursor) continue;
    if (r.from >= to) break;
    if (r.from > cursor) decos.push(Decoration.mark({ class: cls }).range(cursor, r.from));
    cursor = Math.max(cursor, r.to);
    if (cursor >= to) return;
  }
  if (cursor < to) decos.push(Decoration.mark({ class: cls }).range(cursor, to));
}

/** Is the half-open range [start,end) within ±1 char of the primary selection?
 *  Used to keep markup markers visible while the caret edits them. */
function nearSelection(selFrom: number, selTo: number, start: number, end: number): boolean {
  return end >= selFrom - 1 && start <= selTo + 1;
}

// --- block-level recognizers ------------------------------------------

const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})/;
const FENCE_CLOSE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const HEADING_RE = /^(#{1,6})([ \t]+)(.*)$/;
const BLOCKQUOTE_RE = /^(>{1,})[ \t]?/;
const UL_RE = /^([*+-])[ \t]+/;
const OL_RE = /^(\d{1,9})[.)][ \t]+/;
const TASK_RE = /^\[([ xX])\][ \t]+/;

/** Is `line` (already stripped of leading indent) a thematic break (hr)?
 *  Three or more of `-`, `*`, or `_`, optionally space-separated, nothing
 *  else. CommonMark's rule, distilled: collapse whitespace, then the residue
 *  must be ≥3 of one allowed char. */
function isHr(line: string): boolean {
  const t = line.replace(/[ \t]/g, "");
  if (t.length < 3) return false;
  return /^-{3,}$/.test(t) || /^\*{3,}$/.test(t) || /^_{3,}$/.test(t);
}

// --- inline recognizers -----------------------------------------------
//
// Per-line (no `s` flag → `.` never crosses a newline), non-greedy, with
// lookbehind/ahead guards so opening markers aren't followed by whitespace
// and closing markers aren't preceded by it (CommonMark's "intraword" rules).
// Lookbehind is supported in the WebViews Tauri ships (Safari 16.4+, all
// Chromium); the guards keep `snake_case` and `2 * 3` from mis-emphasizing.

const INLINE_CODE_RE = /(`+)(.+?)\1/g;
const BOLD_STAR_RE = /\*\*(?!\s)(.+?)(?<!\s)\*\*/g;
const ITALIC_STAR_RE = /(?<!\*)\*(?!\s)(.+?)(?<!\s)\*(?!\*)/g;
const BOND_UNDER_RE = /__(?!\s)(.+?)(?<!\s)__/g;
const ITALIC_UNDER_RE = /(?<![\w])_(?!\s)(.+?)(?<!\s)_(?![\w])/g;
const STRIKE_RE = /~~(?!\s)(.+?)(?<!\s)~~/g;

/** Run one inline-markup pass over a single line's text. `exclude` is the
 *  accumulated set of ranges already consumed (inline code, earlier emphasis
 *  passes, reserved bracket/command ranges, hidden block markers) — any match
 *  overlapping it is skipped. Pushed decorations: hide the two markers (unless
 *  the caret is editing them) and mark the inner content. Returns the list of
 *  full match ranges consumed, so the caller can feed them to the next pass. */
function scanInline(
  decos: Range<Decoration>[],
  re: RegExp,
  cls: string,
  lineFrom: number,
  lineText: string,
  exclude: Span[],
  selFrom: number,
  selTo: number,
  reserved: Span[],
): Span[] {
  const consumed: Span[] = [];
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(lineText)) !== null) {
    const fullStart = lineFrom + m.index;
    const fullEnd = fullStart + m[0].length;
    // Inner group is m[1]; locate it within m[0] (it always starts after the
    // opening marker, which is everything before the captured group).
    const innerRel = m[0].indexOf(m[1]);
    const innerStart = fullStart + innerRel;
    const innerEnd = innerStart + m[1].length;
    const full: Span = { from: fullStart, to: fullEnd };
    if (overlapsAny(full, exclude)) {
      // Overlap with a prior/consumed range — leave literal and move on.
      if (re.lastIndex === m.index) re.lastIndex++;
      continue;
    }
    // Hide the opening marker [fullStart, innerStart) unless the caret is on it.
    if (innerStart > fullStart && !nearSelection(selFrom, selTo, fullStart, innerStart)) {
      decos.push(Decoration.replace({}).range(fullStart, innerStart));
    }
    // Hide the closing marker [innerEnd, fullEnd) unless the caret is on it.
    if (fullEnd > innerEnd && !nearSelection(selFrom, selTo, innerEnd, fullEnd)) {
      decos.push(Decoration.replace({}).range(innerEnd, fullEnd));
    }
    // Style the inner content, split around any reserved bracket/command span.
    if (innerEnd > innerStart) pushMarkSplit(decos, cls, innerStart, innerEnd, reserved);
    consumed.push(full);
    if (re.lastIndex === m.index) re.lastIndex++;
  }
  return consumed;
}

// --- widgets ----------------------------------------------------------

/** A horizontal rule rendered as a thin centered line. Replaces the `---`
 *  source text entirely in Preview. */
class HrWidget extends WidgetType {
  toDOM(): HTMLElement {
    const el = document.createElement("div");
    el.className = "md-hr";
    el.setAttribute("role", "separator");
    el.setAttribute("aria-label", "horizontal rule");
    return el;
  }
  ignoreEvent(): boolean {
    return false;
  }
}

/** A task-list checkbox glyph (`☐` / `☑`). Replaces the `- [ ]` / `- [x]`
 *  marker. Read-only display — the checkbox reflects doc state; toggling it
 *  is an edit (switch to Markdown, or edit the `[ ]` text). */
class TaskWidget extends WidgetType {
  constructor(readonly checked: boolean) {
    super();
  }
  eq(other: TaskWidget): boolean {
    return other.checked === this.checked;
  }
  toDOM(): HTMLElement {
    const el = document.createElement("span");
    el.className = "md-task" + (this.checked ? " checked" : "");
    el.textContent = this.checked ? "☑" : "☐";
    el.setAttribute("aria-label", this.checked ? "checked task" : "unchecked task");
    return el;
  }
  ignoreEvent(): boolean {
    return false;
  }
}

// --- main builder -----------------------------------------------------

function buildMarkdownDecorations(view: EditorView): DecorationSet {
  if (view.state.facet(modeFacet) !== "preview") return Decoration.none;

  const doc = view.state.doc;
  const text = doc.toString();
  const decos: Range<Decoration>[] = [];
  const sel = view.state.selection.main;

  // Reserved ranges = the press's own bracket/command marks. We never emit a
  // decoration overlapping these (they're already replaced by chips). Both
  // iterators yield in document order, so a sort-merge keeps this ascending.
  const reserved: Span[] = [];
  for (const b of iterBrackets(text)) reserved.push({ from: b.matchStart, to: b.matchEnd });
  for (const c of iterCommands(text)) reserved.push({ from: c.matchStart, to: c.matchEnd });
  reserved.sort((a, b) => a.from - b.from);

  let inFence = false;
  let fenceChar = ""; // "`" or "~"

  const lineCount = doc.lines;
  for (let i = 1; i <= lineCount; i++) {
    const line = doc.line(i);
    const lineText = line.text;
    const lineFrom = line.from;

    // --- fenced code blocks (toggle on ``` / ~~~) ----------------------
    const openM = FENCE_OPEN_RE.exec(lineText);
    if (!inFence && openM) {
      inFence = true;
      fenceChar = openM[1][0];
      decos.push(
        Decoration.line({ class: "md-code-fence-line md-code-fence-open" }).range(lineFrom, lineFrom),
      );
      // Hide the opening delimiter + optional language tag.
      const full = lineText.length;
      if (!nearSelection(sel.from, sel.to, lineFrom, lineFrom + full)) {
        decos.push(Decoration.replace({}).range(lineFrom, lineFrom + full));
      }
      continue;
    }
    if (inFence) {
      const closeM = FENCE_CLOSE_RE.exec(lineText);
      if (closeM && closeM[1][0] === fenceChar) {
        inFence = false;
        fenceChar = "";
        decos.push(
          Decoration.line({ class: "md-code-fence-line md-code-fence-close" }).range(lineFrom, lineFrom),
        );
        const full = lineText.length;
        if (!nearSelection(sel.from, sel.to, lineFrom, lineFrom + full)) {
          decos.push(Decoration.replace({}).range(lineFrom, lineFrom + full));
        }
        continue;
      }
      // Interior fence line — raw code; no inline scan, just style the line.
      decos.push(Decoration.line({ class: "md-code-fence-line" }).range(lineFrom, lineFrom));
      continue;
    }

    // --- per-line exclude set for inline scanning -----------------------
    // Starts with reserved ranges that touch this line; block markers and
    // inline-code spans are added as they're emitted so later emphasis passes
    // skip them. Kept unsorted — overlapsAny is linear, lines are short.
    const lineExclude: Span[] = reserved.filter(
      (r) => r.from < lineFrom + lineText.length && r.to > lineFrom,
    );

    // --- horizontal rule ------------------------------------------------
    if (isHr(lineText)) {
      decos.push(Decoration.line({ class: "md-hr-line" }).range(lineFrom, lineFrom));
      const full = lineText.length;
      // Replace the whole `---` text with the rule widget (unless the caret
      // is editing it — then leave the source visible).
      if (full > 0 && !nearSelection(sel.from, sel.to, lineFrom, lineFrom + full)) {
        decos.push(
          Decoration.replace({ widget: new HrWidget() }).range(lineFrom, lineFrom + full),
        );
      }
      continue;
    }

    // --- heading --------------------------------------------------------
    const hM = HEADING_RE.exec(lineText);
    if (hM) {
      const level = hM[1].length; // 1..6
      const markerLen = hM[1].length + hM[2].length; // `#`s + whitespace
      decos.push(
        Decoration.line({ class: `md-heading-line md-heading-${level}-line` }).range(lineFrom, lineFrom),
      );
      if (!nearSelection(sel.from, sel.to, lineFrom, lineFrom + markerLen)) {
        decos.push(Decoration.replace({}).range(lineFrom, lineFrom + markerLen));
      }
      lineExclude.push({ from: lineFrom, to: lineFrom + markerLen });
      pushMarkSplit(decos, "md-heading", lineFrom + markerLen, lineFrom + lineText.length, reserved);
      // Headings still allow inline emphasis/code on their text.
      scanLineInline(decos, lineFrom, lineText, markerLen, lineExclude, sel, reserved);
      continue;
    }

    // --- blockquote -----------------------------------------------------
    const qM = BLOCKQUOTE_RE.exec(lineText);
    if (qM) {
      const markerLen = qM[0].length;
      decos.push(Decoration.line({ class: "md-blockquote-line" }).range(lineFrom, lineFrom));
      if (!nearSelection(sel.from, sel.to, lineFrom, lineFrom + markerLen)) {
        decos.push(Decoration.replace({}).range(lineFrom, lineFrom + markerLen));
      }
      lineExclude.push({ from: lineFrom, to: lineFrom + markerLen });
      scanLineInline(decos, lineFrom, lineText, markerLen, lineExclude, sel, reserved);
      continue;
    }

    // --- unordered list (incl. task) ------------------------------------
    const ulM = UL_RE.exec(lineText);
    if (ulM) {
      const markerLen = ulM[0].length;
      const rest = lineText.slice(markerLen);
      const taskM = TASK_RE.exec(rest);
      if (taskM) {
        // Task list item: replace `- [ ] ` / `- [x] ` with a checkbox glyph.
        const fullMarkerLen = markerLen + taskM[0].length;
        const checked = taskM[1] !== " " && taskM[1] !== "";
        decos.push(
          Decoration.line({ class: "md-li-line md-task-line" }).range(lineFrom, lineFrom),
        );
        if (!nearSelection(sel.from, sel.to, lineFrom, lineFrom + fullMarkerLen)) {
          decos.push(
            Decoration.replace({ widget: new TaskWidget(checked) }).range(
              lineFrom,
              lineFrom + fullMarkerLen,
            ),
          );
        }
        lineExclude.push({ from: lineFrom, to: lineFrom + fullMarkerLen });
        scanLineInline(decos, lineFrom, lineText, fullMarkerLen, lineExclude, sel, reserved);
        continue;
      }
      // Plain unordered item: hide `- `/`* `/`+ `, CSS ::before draws `•`.
      decos.push(Decoration.line({ class: "md-li-line md-ul-line" }).range(lineFrom, lineFrom));
      if (!nearSelection(sel.from, sel.to, lineFrom, lineFrom + markerLen)) {
        decos.push(Decoration.replace({}).range(lineFrom, lineFrom + markerLen));
      }
      lineExclude.push({ from: lineFrom, to: lineFrom + markerLen });
      scanLineInline(decos, lineFrom, lineText, markerLen, lineExclude, sel, reserved);
      continue;
    }

    // --- ordered list (digit left visible as content) -------------------
    const olM = OL_RE.exec(lineText);
    if (olM) {
      decos.push(Decoration.line({ class: "md-li-line md-ol-line" }).range(lineFrom, lineFrom));
      // The `1.` is content — keep it. Scan inline over the whole line.
      scanLineInline(decos, lineFrom, lineText, 0, lineExclude, sel, reserved);
      continue;
    }

    // --- plain paragraph line ------------------------------------------
    scanLineInline(decos, lineFrom, lineText, 0, lineExclude, sel, reserved);
  }

  return Decoration.set(decos, true);
}

/** Inline code + emphasis scan for one line's text. `skipLen` is how many
 *  leading chars are already handled as a block marker (heading `# `, list
 *  `- `, etc.) — inline code is scanned over the whole line anyway because
 *  backtick runs don't collide with those markers, but emphasis respects the
 *  accumulated `lineExclude` (which includes the marker range). Passes run in
 *  precedence order: code → bold** → italic* → bold__ → italic_ → strike,
 *  each feeding its consumed ranges into the next pass's exclude set. */
function scanLineInline(
  decos: Range<Decoration>[],
  lineFrom: number,
  lineText: string,
  _skipLen: number,
  lineExclude: Span[],
  sel: { from: number; to: number },
  reserved: Span[],
): void {
  // Inline code first: its ranges become emphasis-excluded and its backticks
  // are hidden, inner text styled mono.
  const codeConsumed = scanInlineCode(decos, INLINE_CODE_RE, lineFrom, lineText, lineExclude, sel, reserved);
  const exclude = lineExclude.concat(codeConsumed);

  const boldStar = scanInline(decos, BOLD_STAR_RE, "md-bold", lineFrom, lineText, exclude, sel.from, sel.to, reserved);
  const italicStar = scanInline(decos, ITALIC_STAR_RE, "md-italic", lineFrom, lineText, exclude.concat(boldStar), sel.from, sel.to, reserved);
  const boldUnder = scanInline(decos, BOND_UNDER_RE, "md-bold", lineFrom, lineText, exclude.concat(boldStar, italicStar), sel.from, sel.to, reserved);
  const italicUnder = scanInline(decos, ITALIC_UNDER_RE, "md-italic", lineFrom, lineText, exclude.concat(boldStar, italicStar, boldUnder), sel.from, sel.to, reserved);
  scanInline(decos, STRIKE_RE, "md-strike", lineFrom, lineText, exclude.concat(boldStar, italicStar, boldUnder, italicUnder), sel.from, sel.to, reserved);
}

/** Inline-code scan: INLINE_CODE_RE has TWO capture groups (opening backtick
 *  run, inner text) plus a `\1` backreference, so it doesn't fit scanInline's
 *  single-group shape. Hides both backtick fences, marks the inner content
 *  `md-code-inline`. Returns the consumed match ranges so later emphasis
 *  passes skip code interiors. */
function scanInlineCode(
  decos: Range<Decoration>[],
  re: RegExp,
  lineFrom: number,
  lineText: string,
  exclude: Span[],
  sel: { from: number; to: number },
  reserved: Span[],
): Span[] {
  const consumed: Span[] = [];
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(lineText)) !== null) {
    const openTicks = m[1];
    const inner = m[2] ?? "";
    const fullStart = lineFrom + m.index;
    const openEnd = fullStart + openTicks.length;
    const innerStart = openEnd;
    const innerEnd = innerStart + inner.length;
    const closeStart = innerEnd;
    const fullEnd = closeStart + openTicks.length; // \1 == same length
    const full: Span = { from: fullStart, to: fullEnd };
    if (overlapsAny(full, exclude)) {
      if (re.lastIndex === m.index) re.lastIndex++;
      continue;
    }
    if (!nearSelection(sel.from, sel.to, fullStart, openEnd)) {
      decos.push(Decoration.replace({}).range(fullStart, openEnd));
    }
    if (!nearSelection(sel.from, sel.to, closeStart, fullEnd)) {
      decos.push(Decoration.replace({}).range(closeStart, fullEnd));
    }
    if (innerEnd > innerStart) {
      pushMarkSplit(decos, "md-code-inline", innerStart, innerEnd, reserved);
    }
    consumed.push(full);
    if (re.lastIndex === m.index) re.lastIndex++;
  }
  return consumed;
}

const markdownDecorations = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildMarkdownDecorations(view);
    }
    update(update: ViewUpdate) {
      // Rebuild on any effect (not just docChanged/viewportChanged) so a
      // modeCompartment reconfigure — dispatched as an effect — redecorates
      // immediately. Mirrors bracketDecorations/commandDecorations.
      if (
        update.docChanged ||
        update.viewportChanged ||
        update.selectionSet ||
        update.transactions.some((t) => t.effects.length)
      ) {
        this.decorations = buildMarkdownDecorations(update.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

/** The markdown-preview extension set. Inert in Markdown mode (the plugin
 *  returns Decoration.none), active only in Preview. The caller (App.tsx)
 *  includes this next to bracketExtensions() in buildExtensions(). */
export function markdownPreviewExtensions(): Extension[] {
  return [markdownDecorations];
}

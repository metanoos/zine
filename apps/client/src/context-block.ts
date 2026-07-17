import { renderTraceProcessSummary, type TraceProcessView } from "./trace-process.js";
import {
  traceConformanceLabel,
  type TraceConformanceStatus,
} from "./trace-conformance.js";

/**
 * Canonical LLM context block — rendered into every op's prompt so the model
 * sees the surrounding folder (structure + full text, recursively) and the
 * active file's full delta log alongside the op-specific instruction.
 *
 * Pure: no fs, no relay. This is the single source of the context renderer;
 * lift into `packages/protocol/` if a shared package is ever added.
 *
 * Format (what the model sees):
 *
 *   === CONTEXT ===
 *
 *   --- folder structure ---
 *   essays/
 *     notes.md
 *     draft.md
 *     refs/
 *       a.md
 *
 *   --- file contents ---
 *   ## essays/notes.md  (ACTIVE)
 *   <full text>
 *
 *   ## essays/draft.md
 *   <full text>
 *
 *   ## essays/refs/a.md
 *   (omitted — 14208 chars, over budget)
 *
 *   --- directory log: essays/ (3 actions across 1 file) ---
 *   [#1] import   2026-07-12 14:03         notes.md
 *   [#2] edit     2026-07-12 14:10 Δ7m     notes.md   (+12/−3)
 *   [#3] llm      2026-07-13 09:22 Δ19h    notes.md   (+48/−9)   «tighten the intro»   [brackets: 2 survived]
 *
 *   Each line carries two computed observations: a `Δ` interval (time since the
 *   previous action — absent on the first) and, for content edits, a
 *   `(+inserted/−deleted)` character delta. Both are mechanical measurements of
 *   pacing and magnitude, surfaced so the model cites them as structural facts
 *   instead of narrating past a flat action log (the paste-tell: a bulk insert
 *   dressed up as gradual composition collapses against a `(+1847/−22)`).
 *
 *   === END CONTEXT ===
 *
 * Budget: the active file's body and the whole delta log are ALWAYS included
 * and never count against the cap. Sibling file bodies (path-sorted) are then
 * added in full until the cumulative char budget is hit; the rest appear in
 * the tree and as `## path\n(omitted — N chars, over budget)` stubs in the
 * contents section. The tree and log are always full.
 */

/** One node in the gathered folder snapshot. A directory has `content === null`. */
export interface ContextEntry {
  /** POSIX-style relative path under the folder root (e.g. `refs/a.md`). */
  relativePath: string;
  /** Full UTF-8 text for a file; `null` for a directory. */
  content: string | null;
}

/** One positional content span for a delta log entry — the transport-neutral
 *  view the renderer consumes. Mirrors `DeltaSpan`/`DeltaRecord` from the
 *  protocol but stripped to just what the prompt needs. The client populates
 *  `oldValue` by replaying snapshots (see context-gather.ts); other producers
 *  could read it straight off a persisted event. The type is self-contained so
 *  it needs no shared package.
 *
 *  `oldValue` is the text that LEFT the surface at this step; `newValue` is
 *  what arrived. Either may be null: inserts have no oldValue, deletes have no
 *  newValue, and `quote`/`tag-add`/`reply-to` deltas carry only a newValue
 *  (or none at all — they render no span block). This is the payload that lets
 *  the model reconstruct prior states — the thing the bare action log lacked. */
export interface DeltaSpanView {
  type: string;
  positionStart: number;
  positionEnd: number;
  /** Text removed at this span. Null on pure inserts. The client derives it
   *  from the prior node's snapshot (it doesn't persist oldValue — spec-compliant,
   *  recoverable as prev.snapshot.slice(start, end)). */
  oldValue: string | null;
  /** Text inserted at this span. Null on pure deletes. */
  newValue: string | null;
}

/** One entry in the directory action log — a stepped node (file or folder),
 *  summarized. `source` discriminates per-file edit/llm/import actions from
 *  folder-membership add/remove actions; `relativePath` names which doc each
 *  line is about. `deltas` carries the per-span content payload for file
 *  events (so the model can read what changed, not just that something did);
 *  absent on folder events and on nodes with no content delta (genesis,
 *  reply-to, tag-add). */
export interface DeltaLogEntry {
  /** 1-based position in the merged, time-sorted log (oldest = 1). */
  seq: number;
  action: string;
  /** ms-epoch. */
  steppedAt: number;
  /** Relative path of the doc this action touched. For a file event, the doc
   *  being edited/imported/stepped; for a folder event, the member that joined
   *  or left the directory. */
  relativePath: string;
  /** Whether this is a per-file action ('file') or a folder-membership action
   *  ('folder'). Folder events render with a `+`/`-` prefix and a joined/left
   *  annotation so the model can distinguish structure changes from edits. */
  source: 'file' | 'folder';
  prompt: string | null;
  summary: string | null;
  /** Per-span content deltas for this node, when it carries any. Omitted on
   *  folder-membership events and on file nodes whose deltas are non-content
   *  (reply-to, tag-add) or empty (genesis). Rendered as `−`/`+` lines under
   *  the log line so the model can reconstruct prior states — the whole point
   *  of surfacing provenance in the prompt. */
  deltas?: DeltaSpanView[];
  /** Exact editor transactions recovered from this signed Step. `complete`
   *  means the transactions reproduce the Step snapshot; invalid logs fail
   *  closed and are surfaced as such rather than partially interpreted. */
  process?: TraceProcessView;
  /** Shared reader verdict for the signed file node. Folder entries omit it. */
  conformance?: TraceConformanceStatus;
  conformanceReason?: string;
  /** Signed node carrying this entry. Used by Analyze evidence anchors and
   *  by the resulting review's ordinary source citations. */
  nodeId?: string;
}

export interface ContextBlockInput {
  /** Display label for the folder root (e.g. basename of the attached path). */
  folderLabel: string;
  /** Every file/dir under the folder root, recursively. The active file must
   *  be present (the adapter guarantees this). */
  entries: ContextEntry[];
  /** Relative path of the active file — the one the op targets. Gets the
   *  `(ACTIVE)` tag and is always sent in full regardless of budget. */
  activePath: string;
  /** Aggregated action log for the active file's immediate parent directory:
   *  every direct-child file's chain plus the folder's membership events for
   *  that directory, interleaved by steppedAt. Empty array omits the section. */
  deltaLog: DeltaLogEntry[];
  /** Soft char budget for sibling file bodies. Defaults to
   * `DEFAULT_CONTEXT_BUDGET`. Active body + delta log + tree never count. */
  budget?: number;
  /** Strip the two computed observations — `ΔNm/Nh/Nd` interval and
   *  `(+N/−M)` char delta — from every delta-log line. The A/B rubric
   *  (`research/narration-rubric.md`) uses this as condition B: the same
   *  context block with only those two labels removed, so a narration's
   *  drift can be attributed to the labels rather than to the preamble.
   *  Defaults false (labels present — the shipping behavior). */
  stripLabels?: boolean;
  /** Strip the per-span content payloads — the indented `− (deleted)` / `+
   *  (inserted)` lines under each delta-log entry. Condition C of the A/B/C
   *  rubric: combined with `stripLabels`, this produces the bare action log
   *  (seq + action + timestamp + path) with no computed observations and no
   *  diff content — the "before" state the labels were designed to fix.
   *  Defaults false (spans present — the shipping behavior). */
  stripSpans?: boolean;
}

export const DEFAULT_CONTEXT_BUDGET = 60000;

/** Renders the canonical context block string. */
export function renderContextBlock(input: ContextBlockInput): string {
  const budget = input.budget ?? DEFAULT_CONTEXT_BUDGET;
  const stripLabels = input.stripLabels ?? false;
  const stripSpans = input.stripSpans ?? false;
  const active = input.entries.find((e) => e.relativePath === input.activePath);
  const activeContent = active?.content ?? "";
  const siblings = input.entries
    .filter((e) => e.relativePath !== input.activePath && e.content !== null)
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath));

  // Spend the budget over siblings in path order; mark the rest as omitted.
  let remaining = budget;
  const included = new Set<string>();
  const omitted: { relativePath: string; chars: number }[] = [];
  for (const s of siblings) {
    const chars = (s.content as string).length;
    if (remaining >= chars) {
      included.add(s.relativePath);
      remaining -= chars;
    } else {
      omitted.push({ relativePath: s.relativePath, chars });
    }
  }
  // Once the budget is blown, every later sibling is omitted too (preserve
  // path order; don't sprinkle inclusions after the first skip).
  if (omitted.length > 0) {
    const firstOmit = siblings.findIndex((s) => !included.has(s.relativePath));
    for (let i = firstOmit; i < siblings.length; i++) {
      const s = siblings[i];
      included.delete(s.relativePath);
      if (!omitted.some((o) => o.relativePath === s.relativePath)) {
        omitted.push({ relativePath: s.relativePath, chars: (s.content as string).length });
      }
    }
  }

  const lines: string[] = [];
  lines.push("=== CONTEXT ===", "");
  lines.push("--- folder structure ---");
  lines.push(renderTree(input.entries, input.activePath));
  lines.push("");
  lines.push("--- file contents ---");
  lines.push(renderFileHeader(input.activePath, true));
  lines.push(activeContent || "(empty)");
  for (const s of siblings) {
    if (included.has(s.relativePath)) {
      lines.push("", renderFileHeader(s.relativePath, false), s.content as string);
    }
  }
  for (const o of omitted) {
    lines.push("", renderFileHeader(o.relativePath, false), `(omitted — ${o.chars} chars, over budget)`);
  }
  if (input.deltaLog.length > 0) {
    lines.push("", renderDeltaLogHeader(parentDirectory(input.activePath), input.deltaLog));
    let prevSteppedAt: number | null = null;
    for (const d of input.deltaLog) {
      lines.push(renderDeltaLine(d, prevSteppedAt, stripLabels));
      // Per-span content payload, indented under the log line so the model
      // reads the node and its diff as one unit. Empty/absent deltas (genesis,
      // reply-to, tag-add, folder events) render nothing — same as before.
      // Skipped under `stripSpans` (condition C): the bare log line alone.
      if (!stripSpans && d.deltas && d.deltas.length > 0) {
        for (const rendered of renderDeltaSpans(d.deltas)) lines.push(rendered);
      }
      // Condition B deliberately strips every computed observation, including
      // the new mechanical process summary, so the research comparison stays
      // a clean bare-log control.
      if (!stripLabels) {
        const processSummary = renderTraceProcessSummary(d.process);
        if (processSummary) lines.push(`      ↳ ${processSummary}`);
      }
      prevSteppedAt = d.steppedAt;
    }
  }
  lines.push("", "=== END CONTEXT ===");
  return lines.join("\n");
}

/** One replayable panel-occupancy observation — what the "limelight log" is
 *  built from. Mirrors `FocusEntry` from provenance.ts (steppedAt, op,
 *  selection, panelIndex) but defined locally so this renderer stays
 *  self-contained, like `DeltaLogEntry` above. The caller adapts from
 *  `FocusEntry[]`; the shapes are structurally identical so TS accepts the
 *  assignment directly. `selection` is a union of file / folder / coin, same
 *  three reifications as `FocusSelection` — kept loose as a structural type
 *  here rather than importing the discriminated union. */
export interface LimelightEntry {
  /** ms-epoch, the node's content-level timestamp (chain order). */
  steppedAt: number;
  /** "mount" when present, "unmount" when the panel emptied. */
  op: "mount" | "unmount";
  /** The trace that was in the panel: file/folder carry a path; a coin carries
   *  a phrase + originPath + nodeId. */
  selection:
    | { kind: "file"; path: string; nodeId?: string }
    | { kind: "folder"; path: string; nodeId?: string }
    | { kind: "coin"; nodeId: string; phrase: string; originPath: string };
  /** 0-based panel column the trace occupied. */
  panelIndex: number;
}

/** Render the folder's panel-occupancy history as a compact log, mirroring the
 *  directory log's style (UTC stamp, `Δ` interval, aligned columns). Empty
 *  input yields "" so the caller omits the section. This is the "limelight
 *  log" — which file was mounted in which panel and when — surfaced for the
 *  Analyze op so its focus-pattern analysis has actual evidence rather than
 *  narration. */
export function renderLimelightLog(
  entries: LimelightEntry[],
  folderLabel: string,
): string {
  if (entries.length === 0) return "";
  const panels = new Set(entries.map((e) => e.panelIndex));
  const dirLabel = folderLabel === "" ? "/" : `${folderLabel}/`;
  const mountWord = panels.size === 1 ? "panel" : "panels";
  const lines: string[] = [];
  lines.push(
    `--- limelight log: ${dirLabel} (${entries.length} observations across ${panels.size} ${mountWord}) ---`,
  );
  let prevSteppedAt: number | null = null;
  let seq = 0;
  for (const e of entries) {
    seq += 1;
    const ts = formatTimestamp(e.steppedAt);
    const interval =
      prevSteppedAt === null ? "     " : formatInterval(e.steppedAt - prevSteppedAt).padStart(5);
    const action = e.op.padEnd(7);
    const panel = `panel ${e.panelIndex}`.padEnd(8);
    const target =
      e.selection.kind === "coin"
        ? `${e.selection.originPath} (coin)`
        : e.selection.path;
    lines.push(`[#${seq}] ${action} ${ts}${interval}   ${panel}   ${target}`);
    prevSteppedAt = e.steppedAt;
  }
  return lines.join("\n");
}

// --- renderers -------------------------------------------------------------

function renderTree(entries: ContextEntry[], activePath: string): string {
  // Build a nested structure from POSIX relative paths, then render with
  // indentation. Directories are implied by path prefixes; explicit directory
  // entries (content === null) are rendered as nodes too.
  type Node = { name: string; children: Map<string, Node>; file?: ContextEntry };
  const root: Node = { name: "", children: new Map() };
  for (const e of entries) {
    const parts = e.relativePath.split("/");
    let cur = root;
    for (let i = 0; i < parts.length; i++) {
      const name = parts[i];
      let child = cur.children.get(name);
      if (!child) {
        child = { name, children: new Map() };
        cur.children.set(name, child);
      }
      if (i === parts.length - 1) child.file = e;
      cur = child;
    }
  }
  const out: string[] = [];
  const render = (node: Node, indent: string): void => {
    const kids = [...node.children.values()].sort((a, b) => {
      // Directories first, then files, both alphabetical — stable, readable.
      const aDir = a.children.size > 0;
      const bDir = b.children.size > 0;
      if (aDir !== bDir) return aDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const k of kids) {
      const isDir = k.children.size > 0 || (k.file && k.file.content === null);
      const isActive = k.file && k.file.relativePath === activePath;
      const marker = isActive ? "  <- ACTIVE" : "";
      if (isDir) {
        out.push(`${indent}${k.name}/${marker}`);
        render(k, indent + "  ");
      } else {
        out.push(`${indent}${k.name}${marker}`);
      }
    }
  };
  render(root, "");
  return out.join("\n");
}

function renderFileHeader(relativePath: string, active: boolean): string {
  return `## ${relativePath}${active ? "  (ACTIVE)" : ""}`;
}

function renderDeltaLogHeader(directory: string, log: DeltaLogEntry[]): string {
  // Count distinct docs (file events only) so the model knows the log's scope.
  const files = new Set(log.filter((d) => d.source === 'file').map((d) => d.relativePath));
  const dirLabel = directory === '' ? '/' : `${directory}/`;
  const fileWord = files.size === 1 ? 'file' : 'files';
  const actWord = log.length === 1 ? 'action' : 'actions';
  return `--- directory log: ${dirLabel} (${log.length} ${actWord} across ${files.size} ${fileWord}) ---`;
}

function renderDeltaLine(d: DeltaLogEntry, prevSteppedAt: number | null, stripLabels: boolean): string {
  const ts = formatTimestamp(d.steppedAt);
  // Δ interval: time since the previous action in the merged log. Absent on the
  // first entry. A computed observation about pacing — cite, don't psychologize.
  // Dropped under `stripLabels` (condition B of the narration A/B): the interval
  // is one of the two labels whose effect the rubric isolates.
  const interval =
    stripLabels || prevSteppedAt === null ? '' : formatInterval(d.steppedAt - prevSteppedAt).padStart(5);
  const tsField = interval ? `${ts}${interval}` : `${ts}     `;
  if (d.source === 'folder') {
    // Membership events: +add / -remove, with a joined/left annotation so the
    // model reads structure changes distinctly from edits. No char delta —
    // membership events describe structure, not prose.
    const sign = d.action === 'remove' ? '-' : '+';
    const note = d.action === 'remove' ? '(left directory)' : '(joined directory)';
    const act = `${sign}${d.action}`.padEnd(7);
    return `[#${d.seq}] ${act} ${tsField}   ${d.relativePath}   ${note}`;
  }
  const action = d.action.padEnd(7);
  // Char delta: inserted/deleted summed across the node's spans. A computed
  // observation about magnitude — collapses the derivation that turns a bulk
  // paste into a "deliberate composition" claim. Folder/genesis/empty nodes
  // render without it (nothing to measure). Dropped under `stripLabels`
  // (condition B): the second of the two labels the rubric isolates.
  const chars = stripLabels ? '' : formatCharDelta(d.deltas);
  const charField = chars ? `   ${chars}` : "";
  const prompt = d.prompt ? `   «${d.prompt}»` : "";
  const summary = d.summary ? `   [${d.summary}]` : "";
  const conformance = d.conformance
    ? `   [${traceConformanceLabel(d.conformance)}]`
    : "";
  return `[#${d.seq}] ${action} ${tsField}   ${d.relativePath}${charField}${prompt}${summary}${conformance}`;
}

/** Sum a node's spans into a `(+ins/−del)` character delta. Returns '' for
 *  nodes with no measurable spans (folder events, genesis/import, empty
 *  deltas) — there's nothing to measure, so the magnitude is omitted rather
 *  than rendered as a misleading `(+0/−0)`. The numbers are UTF-16 code-unit
 *  counts ([...str].length) — fine for magnitude, not meant to be exact. */
function formatCharDelta(deltas: DeltaSpanView[] | undefined): string {
  if (!deltas || deltas.length === 0) return '';
  let ins = 0;
  let del = 0;
  for (const s of deltas) {
    if (s.newValue) ins += [...s.newValue].length;
    if (s.oldValue) del += [...s.oldValue].length;
  }
  if (ins === 0 && del === 0) return '';
  return `(+${ins}/−${del})`;
}

/** Render a millisecond interval as a compact, human-scoped duration:
 *  `ΔNm` (minutes), `ΔNh` (hours), or `ΔNd` (days). Sub-minute intervals round
 *  down to `Δ0m` — the model only needs relative pacing, not stopwatch
 *  precision, and whole-minute granularity is enough to make bursts and gaps
 *  legible without false precision. */
function formatInterval(ms: number): string {
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `Δ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Δ${hours}h`;
  return `Δ${Math.floor(hours / 24)}d`;
}

/** Hard cap on a single span's rendered payload. A pathological paste (a whole
 *  novel dropped in one span) would otherwise flatten the block and crowd out
 *  every other node's history. Truncated spans keep a `(…N more chars)` tail so
 *  the model still knows the magnitude. Generous — the whole point of this
 *  section is reconstructive fidelity, so we err on the side of showing more. */
const DELTA_SPAN_CHAR_CAP = 2000;

/** Render a node's content spans as indented `−`/`+` lines under its log line.
 *  Returns [] for a node with no renderable spans (so callers can spread the
 *  result unconditionally). Layout, one unit per span:
 *
 *    − (deleted) "…old text…"
 *    + (inserted) "…new text…"
 *
 *  A span renders the `−` line only when it carries an oldValue (delete,
 *  replace), and the `+` line only when it carries a newValue (insert, replace,
 *  quote). Newlines inside a payload become a quoted block (each line prefixed
 *  with the same indent + marker) rather than one runaway line, and payloads
 *  over the cap get truncated with a `(…N more chars)` tail. */
function renderDeltaSpans(deltas: DeltaSpanView[]): string[] {
  const out: string[] = [];
  for (const span of deltas) {
    // Non-content delta types (reply-to, tag-add) have no positional payload
    // — skip them. They're already named by the log line's action/prompt.
    if (span.newValue === null && span.oldValue === null) continue;
    if (span.oldValue !== null) renderSpanSide(out, '−', 'deleted', span.oldValue);
    if (span.newValue !== null) renderSpanSide(out, '+', 'inserted', span.newValue);
  }
  return out;
}

/** Render one side of a span (either the − or the +) into `out`. Single-line
 *  payloads go inline; multi-line payloads spread as a quoted block so the
 *  indent never breaks. Applies the char cap with a magnitude tail. */
function renderSpanSide(out: string[], marker: string, label: string, text: string): void {
  const indent = '      '; // 6 spaces: aligns under the [#seq] prefix
  const body = truncateWithTail(text, DELTA_SPAN_CHAR_CAP);
  const lines = body.split('\n');
  if (lines.length === 1) {
    out.push(`${indent}${marker} (${label}) ${quoteSpan(lines[0])}`);
    return;
  }
  // Multi-line: header line, then each payload line indented under it.
  out.push(`${indent}${marker} (${label}):`);
  for (const line of lines) {
    out.push(`${indent}  ${line}`);
  }
}

/** Quote a single-line span payload. Double-quotes wrap it; embedded quotes are
 *  left as-is (the wrapping is a visual delimiter, not escaping — the model
 *  reads prose, not code). */
function quoteSpan(text: string): string {
  return `"${text}"`;
}

/** Cap a payload at `cap` chars and append a `(…N more chars)` tail when it
 *  overflowed, so a truncated span still signals its magnitude. No-op under the
 *  cap. */
function truncateWithTail(text: string, cap: number): string {
  if (text.length <= cap) return text;
  return `${text.slice(0, cap)} (…${text.length - cap} more chars)`;
}

/** Immediate parent directory of a POSIX relative path. `notes/essay.md` →
 *  `notes`; `essay.md` → `""` (root). Used to label the directory log. */
function parentDirectory(relativePath: string): string {
  const slash = relativePath.lastIndexOf('/');
  return slash < 0 ? '' : relativePath.slice(0, slash);
}

function formatTimestamp(ms: number): string {
  // ISO-ish YYYY-MM-DD HH:MM in UTC. Keeps the log locale-independent and
  // compact; the model only needs relative order and rough time.
  const d = new Date(ms);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mi = String(d.getUTCMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
}

/**
 * Single source of truth for the per-op LLM message builders.
 *
 * Every single-shot LLM op (Extend / Settle / Stir / Reply / Receive, plus the
 * de-dupe and edit variants) assembles its `messages[]` here. The live actions
 * and the pre-send prompt inspector read these exact strings:
 *
 *   1. The live ops in App.tsx — `extendLLM` / `settleLLM` / `shakeLLM` /
 *      `respondLLM` / `receiveLLM` build their messages here, then wrap them
 *      with `withVoicePrompt` + `withContext` before calling `complete()`.
 *   2. PromptInspectorModal.tsx — `buildOpMessages()` previews the exact base
 *      message array before App adds the voice prompt and context block.
 *
 * Keeping the strings here prevents the live operation and preview from
 * drifting. `op-prompts.test.ts` snapshots role tails and variable infixes.
 *
 * On variable infixes: three ops (Extend, Stir, Receive) bake a runtime value
 * into the system prompt itself — Extend's seed-kind sentence depends on
 * whether there's a selection; Stir's anchor line depends on the bracket count;
 * Receive's limelight section depends on whether a log exists. The builders
 * accept those values explicitly, so both live calls and previews stay honest.
 *
 * What lives here: the per-op system-prompt composers + role preambles, and the
 * op-specific user-body builders. What does NOT live here: the shared
 * `SYSTEM_PREAMBLE` (system-preamble.ts), the voice-prompt splice
 * (`withVoicePrompt`, view-coupled), and the context-block injection
 * (`withContext`, view-coupled). Those compose around the builders; only the
 * builders themselves are shared.
 */

import type { ChatMessage } from "./llm.js";
import { SYSTEM_PREAMBLE } from "./system-preamble.js";

/** The closed set of op kinds the prompt assembly knows. Matches the
 *  `params.op` carried in the `ctx-block-v1` inject manifest, so the
 *  reconstructor can switch on the same values. */
export type OpKind = "extend" | "settle" | "stir" | "reply" | "receive";

/** Ops that have a dedicated tab in the prompt inspector, in display order. */
export const OP_ORDER: OpKind[] = ["extend", "settle", "stir", "reply", "receive"];

/** Tab labels for the inspector. Capitalized to match the action-palette op buttons. */
export const OP_LABELS: Record<OpKind, string> = {
  extend: "Extend",
  settle: "Settle",
  stir: "Stir",
  reply: "Reply",
  receive: "Receive",
};

// ─── per-op system-prompt composers ─────────────────────────────────────────
//
// Each composer returns the FULL system prompt (SYSTEM_PREAMBLE + role tail,
// with any variable infix baked in). Callers provide the real runtime inputs.

/** The seed-kind sentence baked into Extend's system prompt. */
function extendSeedKind(hasSelection: boolean): string {
  return hasSelection
    ? "a selected passage. Continue from the end of that passage as if the cursor sat right after it."
    : "the end of the document. Continue from there.";
}

function composeExtendSystem(hasSelection: boolean): string {
  return (
    `${SYSTEM_PREAMBLE}\n\n` +
    "YOUR ROLE — Extend: the continuer. You pick up the document where it " +
    "leaves off and write ONLY the continuation. The text after the " +
    "context block is your SEED: " +
    extendSeedKind(hasSelection) +
    " The seed is what the human is asking you to extend — it is NOT a " +
    "question to answer or a prompt to reply to. Match the seed's " +
    "voice, tense, register, and formatting. Do not repeat or restate " +
    "the seed; flow directly onward from its last line. Do not emit " +
    "brackets unless they already appear in the seed and clearly extend " +
    "an ongoing citation. No preamble, no acknowledgement, no fences, " +
    "no quotation marks wrapping the whole response."
  );
}

function composeSettleSystem(): string {
  return (
    `${SYSTEM_PREAMBLE}\n\n` +
    "YOUR ROLE — Settle: the condenser. You take one passage of loose prose " +
    "and return a terse, dense version: cut filler, tighten phrasing, keep " +
    "every load-bearing idea. You do NOT add new content, arguments, or " +
    "facts. You do NOT emit brackets of any kind (Settle never creates " +
    "sediment — only the human does, by hand). The passage after the " +
    "context block, under no header, is the text to condense. Return ONLY " +
    "the condensed prose — no preamble, no commentary, no fences."
  );
}

/** Settle (de-dupe) has its own distinct preamble — not a variable of Settle. */
function composeSettleDedupeSystem(): string {
  return (
    `${SYSTEM_PREAMBLE}\n\n` +
    "YOUR ROLE — Settle (de-dupe): the reconciler. You are given several " +
    "files that are near-duplicates of the same content (acquired by " +
    "repeated scans of the same source). Merge them into ONE coherent, " +
    "complete version: keep every load-bearing idea that appears in ANY " +
    "copy, reconcile differences by preferring the more specific/complete " +
    "reading, and drop pure redundancy. You do NOT add new content beyond " +
    "what the copies contain. You do NOT emit fences, headers, or preamble. " +
    "Return ONLY the merged text."
  );
}

/** The anchor line baked into Stir's system prompt. */
function stirAnchorLine(anchorCount: number): string {
  return anchorCount > 0
    ? `The original prose contained ${anchorCount} bracketed anchor(s). Place each at the right spot in your rewrite via a \`[[ANCHOR N]]\` marker (1 through ${anchorCount}, in their original order). The system substitutes the real bracket text for each marker; keep the marker text exactly as written. Do not invent anchors beyond the ${anchorCount} given.`
    : "There were no bracketed anchors in the original. Do not introduce any.";
}

function composeStirSystem(anchorCount: number): string {
  return (
    `${SYSTEM_PREAMBLE}\n\n` +
    "YOUR ROLE — Stir: the reinventor. You rewrite loose prose freely while " +
    "applying the listed `(( command ))` directives and preserving the " +
    "bracketed anchors. The commands are editing instructions — rewrite the " +
    "prose so that each command is carried out, integrated naturally into " +
    "the flow. Treat the commands as authorial intent, not as text to quote " +
    "or acknowledge. Do NOT emit raw `((` or `))`. \n\n" +
    stirAnchorLine(anchorCount) + "\n\n" +
    "The text after the context block, under `--- loose prose ---`, is the " +
    "prose to rewrite. Return ONLY the rewritten prose (with any " +
    "`[[ANCHOR N]]` markers placed) — no preamble, no fences, no commentary."
  );
}

function composeReplySystem(): string {
  return (
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
    "citable backing."
  );
}

/** The limelight section baked into Receive's system prompt. */
function receiveLimelightSection(limelightLog: string): string {
  return limelightLog
    ? `\n\nAfter the context block you will see \`--- limelight log: <folder>/ ---\` ` +
      "(which file was mounted in which panel and when). Read it as evidence " +
      "of focus: how long attention held, which files were touched briefly and " +
      "abandoned, what was visible when changes were made. Cite panel numbers " +
      "and timestamps as you would the delta log.\n\n"
    : "\n\nNo limelight log was provided for this folder (it predates panel-" +
      "occupancy tracking, or the focus chain is empty). Do not invent focus " +
      "observations; analyze only the delta log and file contents you do have, " +
      "and say so where that leaves a gap.\n\n";
}

function composeReceiveSystem(limelightLog: string): string {
  return (
    `${SYSTEM_PREAMBLE}\n\n` +
    "You are Receive. You observe the delta log of a zine folder and " +
    "produce an analysis of the author's writing process — rhythm, " +
    "emphasis, hesitation, revision intensity, and the relationships " +
    "between files over time.\n\n" +
    "You will receive:\n" +
    "- The directory action log (timestamped edits with character deltas and `Δ` intervals)\n" +
    "- The limelight log (which file was mounted in which panel and when)\n" +
    "- Access to the current contents of files for grounding\n\n" +
    "Your job is NOT to evaluate the writing. It is to characterize the " +
    "*process* that produced it.\n\n" +
    "Report on:\n" +
    "- **Rhythm**: bursts vs. steady flow; long gaps and what they might indicate structurally\n" +
    "- **Revision density**: where text was added once and left vs. where it was repeatedly modified\n" +
    "- **Retention and loss**: large deletions, what preceded them, what survived\n" +
    "- **Focus patterns**: which files held attention longest, which were touched briefly and abandoned\n" +
    "- **Cross-file relationships**: temporal sequences suggesting one file informed another\n" +
    "- **Limelight behavior**: what was visible when changes were made\n\n" +
    "Write as prose observations, not bullet points. Be specific — cite " +
    "timestamps and deltas as evidence. Acknowledge uncertainty rather " +
    "than narrate beyond the evidence. You are interpreting a footprint, " +
    "not describing the walker.\n\n" +
    "Your output is saved as a file the user can audit. Write accordingly: " +
    "with humility, with precision, and with the understanding that " +
    "someone will check your work.\n\n" +
    "FORMAT — first line MUST be exactly `TITLE: <short descriptive name>` " +
    "(3–8 words, no file extension, no path, no quotes). Then a blank line. " +
    "Then the analysis body only — no other preamble, no meta-commentary, " +
    "no fences. The TITLE line names the new document; it is stripped " +
    "before the body is saved." +
    receiveLimelightSection(limelightLog) +
    "The delta log and full file contents are in the context block above."
  );
}

function composeEditSystem(): string {
  return (
    `${SYSTEM_PREAMBLE}\n\n` +
    "YOUR ROLE — edit. You edit ONE file on the user's behalf. You will be " +
    "given the file's current full content and an instruction. Reply with " +
    "ONLY the file's complete new content after applying the instruction — no " +
    "commentary, no markdown code fences, no explanation. If the instruction " +
    "does not require changes, return the content unchanged. Spans wrapped in " +
    "[[ ]] brackets are minted sediment — preserve them verbatim."
  );
}

// ─── per-op message builders ────────────────────────────────────────────────
//
// Each builder returns the op's `messages[]` with the op-specific system + user
// body filled in, but WITHOUT the voice-prompt splice and WITHOUT the context
// block — those are applied by `withVoicePrompt` / `withContext` in App.tsx
// (they're view-coupled: the voice prompt reads localStorage for a pubkey, the
// context block reads the live files map + scope). Keeping them out keeps these
// builders pure and testable.

/** Extend messages. `seed` is the selected passage or the doc tail; `hasSelection`
 *  picks the seed-kind phrasing in the system prompt. */
export function extendMessages(seed: string, hasSelection: boolean): ChatMessage[] {
  return [
    { role: "system", content: composeExtendSystem(hasSelection) },
    { role: "user", content: seed || "(empty document — begin writing.)" },
  ];
}

/** Settle: condense one loose passage. */
export function settleMessages(loose: string): ChatMessage[] {
  return [
    { role: "system", content: composeSettleSystem() },
    { role: "user", content: loose },
  ];
}

/** Settle (de-dupe): collapse near-duplicate files into one. NOT an inspector
 *  tab op (it's a folder-scoped variant of Settle), but its preamble lives here
 *  so the live op and any future reconstructor agree. */
export function settleDedupeMessages(duplicates: { path: string; content: string }[]): ChatMessage[] {
  const body = duplicates
    .map((d, i) => `--- FILE ${i + 1}: ${d.path} ---\n${d.content}`)
    .join("\n\n");
  return [
    { role: "system", content: composeSettleDedupeSystem() },
    { role: "user", content: body },
  ];
}

/** Stir messages. `loose` is the prose to rewrite; `anchorCount` and `commands`
 *  are pre-parsed from the doc by the caller (via iterBrackets / findCommands). */
export function stirMessages(loose: string, anchorCount: number, commands: string[]): ChatMessage[] {
  const cmdList = commands.length > 0
    ? commands.map((c, i) => `${i + 1}. (( ${c} ))`).join("\n")
    : "(no commands — reinvent freely in the same spirit)";
  return [
    { role: "system", content: composeStirSystem(anchorCount) },
    {
      role: "user",
      content:
        `--- commands ---\n${cmdList}\n\n` +
        `--- loose prose ---\n${loose || "(empty)"}`,
    },
  ];
}

/** Reply: write a response doc that may cite minted traces by nodeId. `traces`
 *  is the pre-formatted citable-passages block (empty string when none). */
export function replyMessages(source: string, traces: string): ChatMessage[] {
  return [
    { role: "system", content: composeReplySystem() },
    {
      role: "user",
      content:
        (traces ? `--- available minted traces ---\n${traces}\n\n` : "") +
        `--- source document ---\n${source || "(empty)"}`,
    },
  ];
}

/** Receive messages. `limelightLog` is the pre-formatted panel-occupancy log. */
export function receiveMessages(limelightLog: string): ChatMessage[] {
  return [
    { role: "system", content: composeReceiveSystem(limelightLog) },
    {
      role: "user",
      content: limelightLog ? `--- limelight log ---\n${limelightLog}` : "(no limelight log for this folder)",
    },
  ];
}

/** edit op (invoked from a different code path, not an action-palette tab).
 *  The user body is the canonical file+instruction shape the edit op uses. */
export function editMessages(path: string, content: string, instruction: string): ChatMessage[] {
  return [
    { role: "system", content: composeEditSystem() },
    { role: "user", content: `File: ${path}\n\nCurrent content:\n${content}\n\nInstruction:\n${instruction}` },
  ];
}

// ─── dispatch helper for the inspector ──────────────────────────────────────

/** The inputs the inspector / dispatcher needs to build any op's messages. Not
 *  every field is used by every op; pass what you have. Fields the chosen op
 *  doesn't need are ignored. */
export interface OpInputs {
  /** Extend: selected passage or doc tail. */
  seed?: string;
  /** Extend: was there a live selection? */
  hasSelection?: boolean;
  /** Settle / Stir: the loose prose passage. */
  loose?: string;
  /** Stir: bracket-anchor count. */
  anchorCount?: number;
  /** Stir: parsed `(( command ))` directives. */
  commands?: string[];
  /** Reply: the source doc to reply to. */
  source?: string;
  /** Reply: pre-formatted citable traces block. */
  traces?: string;
  /** Receive: pre-formatted limelight log. */
  limelightLog?: string;
}

/** Build any op's `messages[]` from a uniform input bag. Used by the inspector
 *  to render a chosen op against the current panel+scope without duplicating
 *  the per-op assembly. */
export function buildOpMessages(op: OpKind, inputs: OpInputs): ChatMessage[] {
  switch (op) {
    case "extend":
      return extendMessages(inputs.seed ?? "", inputs.hasSelection ?? false);
    case "settle":
      return settleMessages(inputs.loose ?? "");
    case "stir":
      return stirMessages(inputs.loose ?? "", inputs.anchorCount ?? 0, inputs.commands ?? []);
    case "reply":
      return replyMessages(inputs.source ?? "", inputs.traces ?? "");
    case "receive":
      return receiveMessages(inputs.limelightLog ?? "");
  }
}

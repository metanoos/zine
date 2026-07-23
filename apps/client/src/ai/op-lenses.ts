import { vaultStorage as localStorage } from "../storage/vault-storage.js";

/**
 * Optional editorial lenses for the five single-shot LLM operations.
 *
 * A lens is deliberately narrower than a provider personality or a voice
 * prompt: it applies to one operation only, and it may shape judgment/style
 * without overriding zine's bracket, evidence, or output-format invariants.
 * Selections are browser-local workflow preferences.
 */

import type { OpKind } from "./op-prompts.js";

export type OpLensId =
  | "default"
  | "voice-mirror"
  | "bold-continuation"
  | "outside-perspective"
  | "conservative-line-editor"
  | "developmental-editor"
  | "skeptical-reader"
  | "psychoanalytic-reading"
  | "forensic-process-analyst";

export interface OpLens {
  id: OpLensId;
  label: string;
  description: string;
  instruction: string;
}

const DEFAULT_LENS: OpLens = {
  id: "default",
  label: "Built-in role",
  description: "Use the operation's built-in editorial contract without an additional lens.",
  instruction: "",
};

export const OP_LENSES: Record<OpKind, readonly OpLens[]> = {
  extend: [
    DEFAULT_LENS,
    {
      id: "voice-mirror",
      label: "Voice mirror",
      description: "Favor a nearly invisible seam with the seed's existing voice and structure.",
      instruction:
        "Favor continuity over novelty. Infer cadence, sentence length, diction, point of view, and paragraph shape from the seed, then continue with the smallest stylistic seam possible. Do not parody surface tics or explain the imitation.",
    },
    {
      id: "bold-continuation",
      label: "Bold continuation",
      description: "Advance the piece decisively while remaining faithful to its established premises.",
      instruction:
        "Advance the piece rather than circling its last claim. Introduce one consequential next move that follows from the seed's premises, while preserving its voice, tense, register, and factual commitments.",
    },
    {
      id: "outside-perspective",
      label: "Outside perspective",
      description: "Respond to the source from a distinct, external point of view.",
      instruction:
        "Respond to the seed from a distinct outside perspective rather than continuing in its voice. Engage its central idea directly, add a useful interpretation, question, or counterpoint, and write only the response that should be appended after the seed. Do not summarize the source mechanically or explain this instruction.",
    },
  ],
  settle: [
    DEFAULT_LENS,
    {
      id: "conservative-line-editor",
      label: "Conservative line editor",
      description: "Tighten syntax and redundancy without standardizing the author's voice.",
      instruction:
        "Act as a conservative line editor. Preserve every claim, uncertainty, tonal choice, tense, and paragraph relationship. Remove redundancy and repair syntax, but do not standardize the author's voice. If tightening would change meaning, leave the wording alone.",
    },
  ],
  stir: [
    DEFAULT_LENS,
    {
      id: "developmental-editor",
      label: "Developmental editor",
      description: "Prioritize argument, sequence, and reader comprehension during the rewrite.",
      instruction:
        "Work as a developmental editor: strengthen the governing idea, order material by dependency, make transitions earn their place, and remove digressions that obscure the intended through-line. Preserve the author's substantive commitments unless an explicit command changes them.",
    },
  ],
  reply: [
    DEFAULT_LENS,
    {
      id: "skeptical-reader",
      label: "Skeptical reader",
      description: "Test the source's assumptions and strongest inferential steps fairly.",
      instruction:
        "Respond as a rigorous skeptical reader. Reconstruct the source's strongest claim fairly, identify the assumption carrying the most weight, and test it with a concrete counterexample or alternative explanation. Do not manufacture weaknesses the source does not have.",
    },
    {
      id: "psychoanalytic-reading",
      label: "Psychoanalytic reading",
      description: "Interpret tensions in the text without diagnosing or claiming access to its author.",
      instruction:
        "Offer a psychoanalytic reading of the text, never a diagnosis of its author. Ground each interpretation in exact textual evidence, distinguish observation from conjecture, name at least one plausible alternative reading, and avoid claims about the author's actual motives or mental state.",
    },
  ],
  analyze: [
    DEFAULT_LENS,
    {
      id: "forensic-process-analyst",
      label: "Forensic process analyst",
      description: "Favor auditable event-to-claim reasoning and restrained inference.",
      instruction:
        "Adopt a forensic process-analysis stance. Lead with the recorded event, distinguish direct observation from inference, and prefer a narrower claim that the cited evidence fully supports over a vivid narrative that outruns the log.",
    },
  ],
};

export type OpLensSelections = Record<OpKind, OpLensId>;

const STORAGE_KEY = "zine.op.lenses.v1";

export const DEFAULT_OP_LENSES: OpLensSelections = {
  extend: "default",
  settle: "default",
  stir: "default",
  reply: "default",
  analyze: "default",
};

export function lensForOp(op: OpKind, id: OpLensId | undefined): OpLens {
  return OP_LENSES[op].find((lens) => lens.id === id) ?? OP_LENSES[op][0];
}

/** Load only lens ids that remain valid for their operation. */
export function loadOpLensSelections(): OpLensSelections {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return { ...DEFAULT_OP_LENSES };
    const parsed = JSON.parse(stored) as Partial<Record<OpKind, unknown>>;
    return Object.fromEntries(
      (Object.keys(DEFAULT_OP_LENSES) as OpKind[]).map((op) => {
        const id = typeof parsed[op] === "string" ? parsed[op] as OpLensId : "default";
        return [op, lensForOp(op, id).id];
      }),
    ) as OpLensSelections;
  } catch {
    return { ...DEFAULT_OP_LENSES };
  }
}

/** Persist one operation's lens and return the normalized full selection map. */
export function saveOpLensSelection(op: OpKind, id: OpLensId): OpLensSelections {
  const next = loadOpLensSelections();
  next[op] = lensForOp(op, id).id;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* storage unavailable — keep the live selection in React state */
  }
  return next;
}

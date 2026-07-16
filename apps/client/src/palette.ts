import { iterBrackets } from "./brackets.js";

/** Semantic state of the text target currently presented to the action palette. */
export type PaletteSelectionState =
  | "none"
  | "loose"
  | "pending"
  | "coin"
  | "invalid";

export interface PalettePrimaryAction {
  label: "Step" | "Mint" | "Coin";
  title: string;
  tone: "step" | "mint" | "coin" | "invalid";
  actionable: boolean;
}

export interface PaletteSecondaryActions {
  preserve: boolean;
  send: boolean;
  attest: boolean;
}

/** Secondary AUTHOR slots are mutually scoped to passage vs. whole-trace work. */
export function paletteSecondaryActions(
  state: PaletteSelectionState,
): PaletteSecondaryActions {
  if (state === "none") return { preserve: false, send: true, attest: true };
  if (state === "loose") return { preserve: true, send: false, attest: false };
  if (state === "coin") return { preserve: false, send: false, attest: true };
  return { preserve: false, send: false, attest: false };
}

/**
 * Classify a non-empty editor selection for the palette's AUTHOR primary slot.
 *
 * Loose prose and one pending bracket can be minted. A selection contained by
 * a resolved bracket points at an existing immutable Coin. Anything that
 * crosses bracket structure is invalid: the palette must not silently fall
 * back to stepping the whole document while the author sees highlighted text.
 */
export function classifyPaletteSelection(
  text: string,
  from: number,
  to: number,
): PaletteSelectionState {
  const start = Math.max(0, Math.min(from, to, text.length));
  const end = Math.max(start, Math.min(Math.max(from, to), text.length));
  if (start === end) return "none";

  for (const bracket of iterBrackets(text)) {
    const containsSelection = bracket.matchStart <= start && bracket.matchEnd >= end;
    if (containsSelection) {
      if (bracket.resolved) return "coin";
      return bracket.phraseEnd > bracket.phraseStart ? "pending" : "invalid";
    }

    const overlapsSelection = bracket.matchStart < end && bracket.matchEnd > start;
    if (overlapsSelection) return "invalid";
    if (bracket.matchStart >= end) break;
  }

  const phrase = text.slice(start, end);
  return phrase && !phrase.includes("[[") && !phrase.includes("]]")
    ? "loose"
    : "invalid";
}

/** Copy and visual treatment for the palette's mutating AUTHOR primary slot. */
export function palettePrimaryAction(state: PaletteSelectionState): PalettePrimaryAction {
  if (state === "loose" || state === "pending") {
    return {
      label: "Mint",
      title: "Mint the selected passage as an enduring Coin",
      tone: "mint",
      actionable: true,
    };
  }
  if (state === "coin") {
    return {
      label: "Coin",
      title: "This passage is already an immutable Coin",
      tone: "coin",
      actionable: false,
    };
  }
  if (state === "invalid") {
    return {
      label: "Mint",
      title: "Select loose text or one pending [[ bracket ]] to Mint",
      tone: "invalid",
      actionable: false,
    };
  }
  return {
    label: "Step",
    title: "Step this trace as a local checkpoint, signed as this voice",
    tone: "step",
    actionable: true,
  };
}

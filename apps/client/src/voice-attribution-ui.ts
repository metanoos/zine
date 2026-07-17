/**
 * Reader-facing helpers for the document voice legend.
 *
 * A Run's durable identity is its pubkey. Personal key labels and reader-made
 * nicknames are display affordances layered on top; neither changes
 * provenance or gets written into a trace. Keeping the aggregation/storage
 * logic outside React makes the legend deterministic and easy to test.
 */

import { npubEncode } from "nostr-tools/nip19";
import type { KeyEntry } from "./keys-store.js";
import type { Run } from "./workspace-core.js";

const VOICE_NICKNAMES_KEY = "zine.voiceNicknames";

export type VoiceNicknames = Record<string, string>;

export interface VoiceAttributionItem {
  pubkey: string;
  /** Local keychain label or reader-made nickname. Empty means key-only. */
  label: string;
  /** True when the reader owns this key in their personal keychain. */
  local: boolean;
  /** UTF-16 code units attributed to this voice in the current document. */
  charCount: number;
}

/** Convert a raw hex pubkey to its shareable NIP-19 form when possible. */
export function voiceNpub(pubkey: string): string {
  if (!/^[0-9a-f]{64}$/i.test(pubkey)) return pubkey;
  try {
    return npubEncode(pubkey.toLowerCase());
  } catch {
    return pubkey;
  }
}

/** The value copied for a voice. Raw protocol pubkeys are the default; npub is
 *  retained as an explicit secondary sharing format. */
export function voiceKeyForCopy(
  pubkey: string,
  format: "pubkey" | "npub" = "pubkey",
): string {
  return format === "npub" ? voiceNpub(pubkey) : pubkey;
}

/**
 * Collect distinct voices in first-appearance order. Adjacent and disjoint
 * runs from the same voice are folded into one legend entry and their coverage
 * is summed for the detail popover.
 */
export function collectVoiceAttributions(
  runs: readonly Run[],
  keys: readonly KeyEntry[],
  nicknames: VoiceNicknames = {},
): VoiceAttributionItem[] {
  const localByPubkey = new Map(keys.map((key) => [key.pubkey, key]));
  const byPubkey = new Map<string, VoiceAttributionItem>();
  for (const run of runs) {
    if (!run.voice || run.text.length === 0) continue;
    const existing = byPubkey.get(run.voice);
    if (existing) {
      existing.charCount += run.text.length;
      continue;
    }
    const local = localByPubkey.get(run.voice);
    byPubkey.set(run.voice, {
      pubkey: run.voice,
      label: local?.label.trim() || nicknames[run.voice]?.trim() || "",
      local: !!local,
      charCount: run.text.length,
    });
  }
  return [...byPubkey.values()];
}

/** Show attribution whenever the document contains at least one voiced run. */
export function shouldShowVoiceLegend(items: readonly VoiceAttributionItem[]): boolean {
  return items.length > 0;
}

export function loadVoiceNicknames(): VoiceNicknames {
  try {
    if (typeof localStorage === "undefined") return {};
    const stored = localStorage.getItem(VOICE_NICKNAMES_KEY);
    if (!stored) return {};
    const parsed = JSON.parse(stored) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const clean: VoiceNicknames = {};
    for (const [pubkey, label] of Object.entries(parsed)) {
      if (typeof label === "string" && label.trim()) clean[pubkey] = label.trim();
    }
    return clean;
  } catch {
    return {};
  }
}

/** Save or clear one reader-local nickname and return the complete next map. */
export function saveVoiceNickname(pubkey: string, label: string): VoiceNicknames {
  const next = loadVoiceNicknames();
  const trimmed = label.trim();
  if (trimmed) next[pubkey] = trimmed;
  else delete next[pubkey];
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(VOICE_NICKNAMES_KEY, JSON.stringify(next));
    }
  } catch {
    // A blocked/full storage area should not make the reader chrome unusable.
  }
  return next;
}

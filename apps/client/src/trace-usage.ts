import type { Event } from "nostr-tools";

/** Targets that count as social/lineage usage in Times. `q` remains the only
 * citation primitive; lineage edges are counted as a separate kind of use,
 * not reinterpreted as citations. One carrying event counts at most once per
 * target even if it both cites and forks the same node. Structural LLM-scope
 * q-tags are excluded, while real lineage on the same event remains visible. */
export function usageTargets(event: Event): Set<string> {
  const targets = new Set<string>();
  const isLlmScope = event.tags.some((tag) => tag[0] === "scope" && tag[1] === "llm");
  if (!isLlmScope) {
    for (const tag of event.tags) {
      if (tag[0] === "q" && tag[1]) targets.add(tag[1]);
    }
  }
  for (const tag of event.tags) {
    if (
      tag[0] === "e" &&
      tag[1] &&
      (tag[3] === "forked-from" || tag[3] === "merge-parent" || tag[3] === "extracted-from")
    ) {
      targets.add(tag[1]);
    }
  }
  return targets;
}

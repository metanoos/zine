/**
 * Provider-card generation controls shared by the single-shot and tool-calling
 * transports. Keeping the wire mapping here prevents the two LLM clients from
 * silently drifting as provider options evolve.
 */

import type { ProviderConfig, ReasoningEffort } from "./models-store.js";

const PERSONALITY_INSTRUCTIONS = {
  friendly: "Communicate in a warm, approachable, and collaborative style.",
  pragmatic: "Communicate concisely and practically, prioritizing clear, actionable output.",
} as const;

const ANTHROPIC_EFFORTS = new Set<ReasoningEffort>([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

/** System text contributed by the model card. `none` and an unset personality
 *  add no style instruction; free-form instructions still apply. */
export function modelSystemInstruction(cfg: ProviderConfig): string {
  const personality =
    cfg.personality && cfg.personality !== "none"
      ? PERSONALITY_INSTRUCTIONS[cfg.personality]
      : "";
  return [personality, cfg.instructions?.trim() ?? ""].filter(Boolean).join("\n\n");
}

/** OpenAI-compatible request fields. OpenAI's own endpoint uses the current
 *  `max_completion_tokens`; compatibility gateways retain `max_tokens`. */
export function openAIModelOptions(
  cfg: ProviderConfig,
  fallbackMaxTokens?: number,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const maxTokens = cfg.maxTokens ?? fallbackMaxTokens;
  if (maxTokens !== undefined) {
    out[usesOpenAIMaxCompletionTokens(cfg) ? "max_completion_tokens" : "max_tokens"] = maxTokens;
  }
  if (cfg.temperature !== undefined) out.temperature = cfg.temperature;
  if (cfg.reasoningEffort) out.reasoning_effort = cfg.reasoningEffort;
  if (cfg.verbosity) out.verbosity = cfg.verbosity;
  return out;
}

/** Anthropic Messages fields. Effort is nested under `output_config`; values
 *  unsupported by Anthropic are omitted defensively if a card changed protocol. */
export function anthropicModelOptions(
  cfg: ProviderConfig,
  fallbackMaxTokens = 4096,
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    max_tokens: cfg.maxTokens ?? fallbackMaxTokens,
  };
  if (cfg.temperature !== undefined) out.temperature = cfg.temperature;
  if (cfg.reasoningEffort && ANTHROPIC_EFFORTS.has(cfg.reasoningEffort)) {
    out.output_config = { effort: cfg.reasoningEffort };
  }
  return out;
}

export function isAnthropicEffort(effort: ReasoningEffort | undefined): boolean {
  return effort === undefined || ANTHROPIC_EFFORTS.has(effort);
}

function usesOpenAIMaxCompletionTokens(cfg: ProviderConfig): boolean {
  if (cfg.preset === "openai") return true;
  try {
    return new URL(cfg.baseUrl).hostname === "api.openai.com";
  } catch {
    return false;
  }
}

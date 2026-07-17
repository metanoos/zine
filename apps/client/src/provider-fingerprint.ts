import { contentFingerprint } from "./context-snapshot.js";
import type { ProviderConfig } from "./models-store.js";

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
    .join(",")}}`;
}

/** Hash every provider field that can change transport or output behavior.
 * The credential reference is identity metadata; secret bytes are never read. */
export function providerProfileFingerprint(provider: ProviderConfig): string {
  return contentFingerprint(canonical({
    id: provider.id,
    protocol: provider.protocol,
    baseUrl: provider.baseUrl,
    modelId: provider.modelId,
    credentialRef: provider.credentialRef,
    credentialConfigured: provider.credentialConfigured ?? false,
    reasoningEffort: provider.reasoningEffort ?? null,
    verbosity: provider.verbosity ?? null,
    personality: provider.personality ?? null,
    temperature: provider.temperature ?? null,
    maxTokens: provider.maxTokens ?? null,
    instructions: provider.instructions ?? "",
  }));
}

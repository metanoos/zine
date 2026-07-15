/**
 * Provider configuration for the LLM client. A localStorage-backed list of
 * the providers the user has actually added, plus a fixed menu of presets
 * (z.ai, Anthropic, OpenAI, OpenRouter, Ollama) offered as starting points
 * when adding a new provider. Presets are *not* seeded into the list — the
 * Models view only renders cards the user chose to add, so the surface starts
 * empty instead of stacked with unused preset stubs.
 *
 * SECURITY POSTURE: the API key is stored in localStorage as plaintext, the
 * same way `identity.ts` stores the app's Nostr secret key (the only other
 * secret in the client). This is a deliberate, documented choice: routing
 * *only* the LLM key through OS keychain would protect a throwaway credential
 * better than the app's own signing key — an odd asymmetry. The right move is
 * to move *both* secrets to a keychain layer together, as a separate
 * hardening pass. Until then, both live in localStorage, consistent and
 * honest about the limitation: any same-origin JS can read them.
 */

export type ProviderProtocol = "openai" | "anthropic";

export interface ProviderConfig {
  /** Stable id (so edits survive reordering). Ids derived from a preset carry
   *  the preset's slug; ad-hoc ones get timestamped ids. */
  id: string;
  label: string;
  protocol: ProviderProtocol;
  baseUrl: string;
  modelId: string;
  apiKey: string;
  /** The preset this provider was created from, if any. Pure bookkeeping —
   *  the entry is fully owned by the user and freely deletable/editable.
   *  Currently surfaced only to suppress the preset in the "add" menu once it
   *  has been added (so each preset is offered at most once). */
  preset?: string;
}

const STORAGE_KEY = "zine.models";

/** A preset offered as a starting point when adding a provider. The `slug`
 *  is recorded on the created entry (as `preset`) so each preset can be
 *  offered at most once — once added it belongs to the user. */
export interface ProviderPreset {
  slug: string;
  label: string;
  protocol: ProviderProtocol;
  baseUrl: string;
  modelId: string;
}

/** Built-in presets with sensible defaults. z.ai/GLM is first-class (the
 *  plan's named target) and supports both protocols; the rest cover the
 *  common hosted + local options. These are *not* persisted automatically —
 *  they're a menu the user picks from when adding a provider.
 *
 *  Base URLs verified against provider docs (z.ai: /api/anthropic and
 *  /api/paas/v4; Anthropic/OpenAI/OpenRouter: their canonical /v1 paths;
 *  Ollama: default local serve). */
export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    slug: "zai-anthropic",
    label: "z.ai (Anthropic)",
    protocol: "anthropic",
    baseUrl: "https://api.z.ai/api/anthropic",
    modelId: "glm-4.6",
  },
  {
    slug: "zai-openai",
    label: "z.ai (OpenAI)",
    protocol: "openai",
    baseUrl: "https://api.z.ai/api/paas/v4",
    modelId: "glm-4.6",
  },
  {
    slug: "anthropic",
    label: "Anthropic",
    protocol: "anthropic",
    baseUrl: "https://api.anthropic.com",
    modelId: "claude-sonnet-4-5",
  },
  {
    slug: "openai",
    label: "OpenAI",
    protocol: "openai",
    baseUrl: "https://api.openai.com/v1",
    modelId: "gpt-4o",
  },
  {
    slug: "openrouter",
    label: "OpenRouter",
    protocol: "openai",
    baseUrl: "https://openrouter.ai/api/v1",
    modelId: "anthropic/claude-sonnet-4.5",
  },
  {
    slug: "ollama",
    label: "Ollama (local)",
    protocol: "openai",
    baseUrl: "http://localhost:11434/v1",
    modelId: "llama3.1",
  },
];

/** Read the persisted provider list — only entries the user has actually
 *  added. Presets are surfaced separately via `availablePresets()`; nothing
 *  is auto-seeded. */
export function loadProviders(): ProviderConfig[] {
  let raw: ProviderConfig[] = [];
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) raw = JSON.parse(stored) as ProviderConfig[];
  } catch {
    raw = [];
  }
  if (!Array.isArray(raw)) raw = [];
  return raw;
}

/** Presets not yet represented in the saved list — what the "add provider"
 *  menu should offer. A preset is hidden once an entry with its slug exists. */
export function availablePresets(existing: ProviderConfig[] = loadProviders()): ProviderPreset[] {
  const used = new Set(existing.map((p) => p.preset).filter(Boolean) as string[]);
  return PROVIDER_PRESETS.filter((p) => !used.has(p.slug));
}

/** Persist the provider list. */
export function saveProviders(providers: ProviderConfig[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(providers));
}

/** Add a blank custom provider. Returns the new full list. */
export function addProvider(label?: string): ProviderConfig[] {
  const providers = loadProviders();
  const entry: ProviderConfig = {
    id: `p-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    label: label || "Custom",
    protocol: "openai",
    baseUrl: "",
    modelId: "",
    apiKey: "",
  };
  const next = [...providers, entry];
  saveProviders(next);
  return next;
}

/** Add a provider from a preset. Copies the preset's defaults, stamps its
 *  slug on `preset`, and returns the new full list. The entry is fully owned
 *  by the user after this — editable and deletable like any custom one. */
export function addProviderFromPreset(preset: ProviderPreset): ProviderConfig[] {
  const providers = loadProviders();
  const entry: ProviderConfig = {
    id: `p-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    label: preset.label,
    protocol: preset.protocol,
    baseUrl: preset.baseUrl,
    modelId: preset.modelId,
    apiKey: "",
    preset: preset.slug,
  };
  const next = [...providers, entry];
  saveProviders(next);
  return next;
}

/** Remove a provider. Returns the new full list. Every entry is deletable
 *  now — there are no undeletable built-ins. Which provider ops actually use
 *  is chosen under Press → MODEL (voice-provider-store), not here. */
export function removeProvider(id: string): ProviderConfig[] {
  const providers = loadProviders();
  const next = providers.filter((p) => p.id !== id);
  saveProviders(next);
  return next;
}

/** Patch a provider's fields (id matched). Used by the edit form on each
 *  field change. Persists immediately. Returns the new full list. */
export function patchProvider(id: string, patch: Partial<Omit<ProviderConfig, "id">>): ProviderConfig[] {
  const providers = loadProviders();
  const next = providers.map((p) => (p.id === id ? { ...p, ...patch } : p));
  saveProviders(next);
  return next;
}

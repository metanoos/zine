/**
 * Provider configuration for the LLM client. A localStorage-backed list of
 * the providers the user has actually added, plus a fixed menu of presets
 * (z.ai, Anthropic, OpenAI, OpenRouter, Ollama) offered as starting points
 * when adding a new provider. Presets are *not* seeded into the list — the
 * Models view only renders cards the user chose to add, so the surface starts
 * empty instead of stacked with unused preset stubs.
 *
 * SECURITY POSTURE: provider cards are public configuration only. Credentials
 * resolve through an opaque `credentialRef` in the unlocked SecretStore and
 * are materialized only at the transport boundary.
 */

import {
  canUseModelSecrets,
  deleteSecret,
  getSecretCached,
  putSecret,
} from "./secret-store.js";

export type ProviderProtocol = "openai" | "anthropic";

/** Provider-neutral reasoning levels. Individual models support subsets; an
 *  omitted value means "let the provider/model choose" and is always safe. */
export type ReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

/** OpenAI-compatible output-detail control. Other protocols simply omit it. */
export type ModelVerbosity = "low" | "medium" | "high";

/** Zine-owned communication presets. These are translated to a transparent
 *  system instruction because personality is not a portable provider field. */
export type ModelPersonality = "none" | "friendly" | "pragmatic";

export interface ProviderConfig {
  /** Stable id (so edits survive reordering). Ids derived from a preset carry
   *  the preset's slug; ad-hoc ones get timestamped ids. */
  id: string;
  label: string;
  protocol: ProviderProtocol;
  baseUrl: string;
  modelId: string;
  credentialRef: string;
  credentialConfigured: boolean;
  /** Optional generation controls. Missing means provider/model default. */
  reasoningEffort?: ReasoningEffort;
  verbosity?: ModelVerbosity;
  personality?: ModelPersonality;
  temperature?: number;
  maxTokens?: number;
  /** Provider-level system instructions, applied to both single-shot ops and
   *  agent runs. Voice prompts remain a separate per-voice layer. */
  instructions?: string;
  /** The preset this provider was created from, if any. Pure bookkeeping —
   *  the entry is fully owned by the user and freely deletable/editable.
   *  Currently surfaced only to suppress the preset in the "add" menu once it
   *  has been added (so each preset is offered at most once). */
  preset?: string;
}

const STORAGE_KEY = "zine.models";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function providerCredentialRef(id: string): string {
  return `model:provider:${id}:api-key`;
}

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
    modelId: "glm-5.2",
  },
  {
    slug: "zai-openai",
    label: "z.ai (OpenAI)",
    protocol: "openai",
    baseUrl: "https://api.z.ai/api/paas/v4",
    modelId: "glm-5.2",
  },
  {
    slug: "anthropic",
    label: "Anthropic",
    protocol: "anthropic",
    baseUrl: "https://api.anthropic.com",
    modelId: "claude-fable-5",
  },
  {
    slug: "openai",
    label: "OpenAI",
    protocol: "openai",
    baseUrl: "https://api.openai.com/v1",
    modelId: "gpt-5.6-sol",
  },
  {
    slug: "openrouter",
    label: "OpenRouter",
    protocol: "openai",
    baseUrl: "https://openrouter.ai/api/v1",
    modelId: "anthropic/claude-fable-5",
  },
  {
    slug: "ollama",
    label: "Ollama (local)",
    protocol: "openai",
    baseUrl: "http://localhost:11434/v1",
    modelId: "gpt-oss:20b",
  },
];

/** Read the persisted provider list — only entries the user has actually
 *  added. Presets are surfaced separately via `availablePresets()`; nothing
 *  is auto-seeded. */
export function loadProviders(): ProviderConfig[] {
  let raw: unknown[] = [];
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) raw = JSON.parse(stored) as unknown[];
  } catch {
    raw = [];
  }
  if (!Array.isArray(raw)) raw = [];
  return raw.flatMap((provider) => {
    const current = currentProvider(provider);
    return current ? [current] : [];
  });
}

function currentProvider(value: unknown): ProviderConfig | null {
  if (!value || typeof value !== "object") return null;
  const provider = value as Record<string, unknown>;
  if (
    typeof provider.id !== "string" ||
    !provider.id ||
    typeof provider.label !== "string" ||
    (provider.protocol !== "openai" && provider.protocol !== "anthropic") ||
    typeof provider.baseUrl !== "string" ||
    typeof provider.modelId !== "string" ||
    typeof provider.credentialRef !== "string" ||
    !provider.credentialRef ||
    typeof provider.credentialConfigured !== "boolean"
  ) return null;
  const reasoningEffort = provider.reasoningEffort;
  const verbosity = provider.verbosity;
  const personality = provider.personality;
  if (
    reasoningEffort !== undefined &&
    !["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(String(reasoningEffort))
  ) return null;
  if (verbosity !== undefined && !["low", "medium", "high"].includes(String(verbosity))) return null;
  if (personality !== undefined && !["none", "friendly", "pragmatic"].includes(String(personality))) return null;
  if (provider.temperature !== undefined && (typeof provider.temperature !== "number" || !Number.isFinite(provider.temperature))) return null;
  if (provider.maxTokens !== undefined && (typeof provider.maxTokens !== "number" || !Number.isInteger(provider.maxTokens) || provider.maxTokens <= 0)) return null;
  if (provider.instructions !== undefined && typeof provider.instructions !== "string") return null;
  if (provider.preset !== undefined && typeof provider.preset !== "string") return null;
  return {
    id: provider.id,
    label: provider.label,
    protocol: provider.protocol,
    baseUrl: provider.baseUrl,
    modelId: provider.modelId,
    credentialRef: provider.credentialRef,
    credentialConfigured: provider.credentialConfigured,
    ...(reasoningEffort === undefined ? {} : { reasoningEffort: reasoningEffort as ReasoningEffort }),
    ...(verbosity === undefined ? {} : { verbosity: verbosity as ModelVerbosity }),
    ...(personality === undefined ? {} : { personality: personality as ModelPersonality }),
    ...(provider.temperature === undefined ? {} : { temperature: provider.temperature as number }),
    ...(provider.maxTokens === undefined ? {} : { maxTokens: provider.maxTokens as number }),
    ...(provider.instructions === undefined ? {} : { instructions: provider.instructions }),
    ...(provider.preset === undefined ? {} : { preset: provider.preset }),
  };
}

/** Presets not yet represented in the saved list — what the "add provider"
 *  menu should offer. A preset is hidden once an entry with its slug exists. */
export function availablePresets(existing: ProviderConfig[] = loadProviders()): ProviderPreset[] {
  const used = new Set(existing.map((p) => p.preset).filter(Boolean) as string[]);
  return PROVIDER_PRESETS.filter((p) => !used.has(p.slug));
}

/** Persist the provider list. */
export function saveProviders(providers: ProviderConfig[]): void {
  const profiles = providers.map((provider) => ({
    id: provider.id,
    label: provider.label,
    protocol: provider.protocol,
    baseUrl: provider.baseUrl,
    modelId: provider.modelId,
    credentialRef: provider.credentialRef,
    credentialConfigured: provider.credentialConfigured,
    ...(provider.reasoningEffort === undefined ? {} : { reasoningEffort: provider.reasoningEffort }),
    ...(provider.verbosity === undefined ? {} : { verbosity: provider.verbosity }),
    ...(provider.personality === undefined ? {} : { personality: provider.personality }),
    ...(provider.temperature === undefined ? {} : { temperature: provider.temperature }),
    ...(provider.maxTokens === undefined ? {} : { maxTokens: provider.maxTokens }),
    ...(provider.instructions === undefined ? {} : { instructions: provider.instructions }),
    ...(provider.preset === undefined ? {} : { preset: provider.preset }),
  }));
  localStorage.setItem(STORAGE_KEY, JSON.stringify(profiles));
}

/** Add a blank custom provider. Returns the new full list. */
export function addProvider(label?: string): ProviderConfig[] {
  const providers = loadProviders();
  const id = `p-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const entry: ProviderConfig = {
    id,
    label: label || "Custom",
    protocol: "openai",
    baseUrl: "",
    modelId: "",
    credentialRef: providerCredentialRef(id),
    credentialConfigured: false,
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
  const id = `p-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const entry: ProviderConfig = {
    id,
    label: preset.label,
    protocol: preset.protocol,
    baseUrl: preset.baseUrl,
    modelId: preset.modelId,
    credentialRef: providerCredentialRef(id),
    credentialConfigured: false,
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
  const removed = providers.find((provider) => provider.id === id);
  const next = providers.filter((p) => p.id !== id);
  saveProviders(next);
  if (removed) {
    void deleteSecret(removed.credentialRef).catch((error) => {
      console.error(`[models] could not delete ${removed.credentialRef}:`, error);
    });
  }
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

/** Resolve a short-lived credential string immediately before transport. */
export function providerCredential(provider: ProviderConfig): string {
  if (!canUseModelSecrets()) {
    throw new Error("MODEL operations are unavailable in this read-only press");
  }
  const secret = getSecretCached(provider.credentialRef);
  if (!secret) {
    if (!provider.credentialConfigured) return "";
    throw new Error(`Credential unavailable for ${provider.label}`);
  }
  return decoder.decode(secret);
}

/** Store/clear a credential without ever adding it to React card state. */
export async function setProviderCredential(
  id: string,
  value: string,
): Promise<ProviderConfig[]> {
  const providers = loadProviders();
  const provider = providers.find((entry) => entry.id === id);
  if (!provider) return providers;
  const credential = value.trim();
  if (credential) await putSecret(provider.credentialRef, encoder.encode(credential));
  else await deleteSecret(provider.credentialRef);
  return patchProvider(id, { credentialConfigured: Boolean(credential) });
}

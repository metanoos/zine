import { test } from "node:test";
import assert from "node:assert/strict";

const store = new Map<string, string>();
// @ts-expect-error minimal localStorage shim for the provider store
globalThis.localStorage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, value),
  removeItem: (key: string) => void store.delete(key),
};

import {
  PROVIDER_PRESETS,
  addProviderFromPreset,
  loadProviders,
  patchProvider,
  setProviderCredential,
} from "./models-store.js";

test("built-in providers default to current strong models", () => {
  const models = Object.fromEntries(
    PROVIDER_PRESETS.map((preset) => [preset.slug, preset.modelId]),
  );

  assert.deepEqual(models, {
    "zai-anthropic": "glm-5.2",
    "zai-openai": "glm-5.2",
    anthropic: "claude-fable-5",
    openai: "gpt-5.6-sol",
    openrouter: "anthropic/claude-fable-5",
    ollama: "gpt-oss:20b",
  });
});

test("adding a preset copies its model default into the saved provider", () => {
  store.clear();
  const preset = PROVIDER_PRESETS.find((candidate) => candidate.slug === "zai-openai");
  assert.ok(preset);

  addProviderFromPreset(preset);

  const [provider] = loadProviders();
  assert.equal(provider.preset, "zai-openai");
  assert.equal(provider.modelId, "glm-5.2");
});

test("generation options round-trip while omitted controls use provider defaults", () => {
  store.clear();
  const preset = PROVIDER_PRESETS.find((candidate) => candidate.slug === "openai");
  assert.ok(preset);
  const [created] = addProviderFromPreset(preset);

  // Newly added cards omit optional controls so provider defaults continue to
  // apply until the user chooses an override.
  assert.equal(created.reasoningEffort, undefined);
  assert.equal(created.personality, undefined);
  assert.equal(created.maxTokens, undefined);

  patchProvider(created.id, {
    reasoningEffort: "high",
    personality: "pragmatic",
    verbosity: "low",
    temperature: 0.4,
    maxTokens: 8192,
    instructions: "Prefer small, reviewable patches.",
  });

  const [saved] = loadProviders();
  assert.equal(saved.reasoningEffort, "high");
  assert.equal(saved.personality, "pragmatic");
  assert.equal(saved.verbosity, "low");
  assert.equal(saved.temperature, 0.4);
  assert.equal(saved.maxTokens, 8192);
  assert.equal(saved.instructions, "Prefer small, reviewable patches.");
});

test("provider credentials never enter the serialized card profile", async () => {
  store.clear();
  const preset = PROVIDER_PRESETS.find((candidate) => candidate.slug === "anthropic");
  assert.ok(preset);
  const [created] = addProviderFromPreset(preset);
  await setProviderCredential(created.id, "sk-never-serialize");

  const persisted = store.get("zine.models") ?? "";
  assert.doesNotMatch(persisted, /sk-never-serialize|apiKey/);
  assert.match(persisted, /credentialRef/);
});

test("provider records without the current credential state are rejected", () => {
  store.clear();
  store.set("zine.models", JSON.stringify([{
    id: "old-provider",
    label: "Old",
    protocol: "openai",
    baseUrl: "https://example.com/v1",
    modelId: "example",
    credentialRef: "model:provider:old-provider:api-key",
  }]));
  assert.deepEqual(loadProviders(), []);
});

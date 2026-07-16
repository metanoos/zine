import { test } from "node:test";
import assert from "node:assert/strict";

import {
  anthropicModelOptions,
  modelSystemInstruction,
  openAIModelOptions,
} from "./model-config.js";
import type { ProviderConfig } from "./models-store.js";

const BASE: ProviderConfig = {
  id: "m1",
  label: "Model",
  protocol: "openai",
  baseUrl: "https://compatible.example/v1",
  modelId: "model-1",
  apiKey: "",
};

test("OpenAI-compatible options use card overrides and compatibility max_tokens", () => {
  assert.deepEqual(openAIModelOptions({
    ...BASE,
    reasoningEffort: "xhigh",
    verbosity: "low",
    temperature: 0.3,
    maxTokens: 8192,
  }, 1024), {
    max_tokens: 8192,
    temperature: 0.3,
    reasoning_effort: "xhigh",
    verbosity: "low",
  });
});

test("OpenAI's own endpoint uses max_completion_tokens", () => {
  assert.deepEqual(openAIModelOptions({
    ...BASE,
    preset: "openai",
    baseUrl: "https://api.openai.com/v1",
  }, 4096), {
    max_completion_tokens: 4096,
  });
});

test("Anthropic options use output_config effort and omit unsupported levels", () => {
  const anthropic = { ...BASE, protocol: "anthropic" as const };
  assert.deepEqual(anthropicModelOptions({
    ...anthropic,
    reasoningEffort: "high",
    temperature: 0.5,
    maxTokens: 16384,
  }), {
    max_tokens: 16384,
    temperature: 0.5,
    output_config: { effort: "high" },
  });
  assert.deepEqual(anthropicModelOptions({ ...anthropic, reasoningEffort: "none" }, 2048), {
    max_tokens: 2048,
  });
});

test("personality and free-form instructions compose into transparent system text", () => {
  assert.equal(
    modelSystemInstruction({
      ...BASE,
      personality: "pragmatic",
      instructions: "Prefer small, reviewable patches.  ",
    }),
    "Communicate concisely and practically, prioritizing clear, actionable output.\n\n" +
      "Prefer small, reviewable patches.",
  );
  assert.equal(modelSystemInstruction({ ...BASE, personality: "none" }), "");
});

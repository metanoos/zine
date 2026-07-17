import { test } from "node:test";
import assert from "node:assert/strict";

const store = new Map<string, string>();
// @ts-expect-error minimal localStorage shim for the voice-prompt store
globalThis.localStorage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, value),
  removeItem: (key: string) => void store.delete(key),
};

import { getVoicePrompt, setVoicePrompt } from "./voice-prompt-store.js";

test("voice prompts can be created, updated, and cleared", () => {
  store.clear();
  setVoicePrompt("voice-a", "  Write with clipped precision.  ");
  assert.equal(getVoicePrompt("voice-a"), "Write with clipped precision.");

  setVoicePrompt("voice-a", "Prefer long cadences.");
  assert.equal(getVoicePrompt("voice-a"), "Prefer long cadences.");

  setVoicePrompt("voice-a", "   ");
  assert.equal(getVoicePrompt("voice-a"), "");
});

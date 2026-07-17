import assert from "node:assert/strict";
import test from "node:test";

import {
  applyPendingLlmMeta,
  clearPendingLlmMeta,
  setPendingLlmMeta,
  takePendingLlmMeta,
  type LlmStepMeta,
  type PublishEditInput,
} from "./provenance.js";

function meta(model: string): LlmStepMeta {
  return {
    prompt: `prompt for ${model}`,
    injectRule: `rule-${model}`,
    scopeCitations: [`scope-${model}`],
    llm: { model, temperature: null, maxTokens: 1024, provider: "test" },
  };
}

test("pending LLM metadata is isolated by destination path", () => {
  setPendingLlmMeta("a.md", meta("a"));
  setPendingLlmMeta("b.md", meta("b"));

  assert.equal(takePendingLlmMeta("b.md")?.llm.model, "b");
  assert.equal(takePendingLlmMeta("a.md")?.llm.model, "a");
});

test("pending LLM metadata is single-use and explicitly clearable", () => {
  setPendingLlmMeta("a.md", meta("a"));
  assert.equal(takePendingLlmMeta("a.md")?.prompt, "prompt for a");
  assert.equal(takePendingLlmMeta("a.md"), undefined);

  setPendingLlmMeta("a.md", meta("stale"));
  clearPendingLlmMeta("a.md");
  assert.equal(takePendingLlmMeta("a.md"), undefined);
});

test("pending metadata marks only its matching write as an LLM Step", () => {
  const input: PublishEditInput = {
    prevEventId: null,
    previousSnapshot: "",
    relativePath: "a.md",
    folderId: "folder",
    deltas: [],
    snapshot: "answer",
    contentHash: "hash",
    kedits: [{
      op: "ins",
      from: 0,
      to: 0,
      text: "answer",
      voice: "voice",
      t: 1,
      tx: 0,
    }],
  };
  setPendingLlmMeta("a.md", meta("model-a"));

  applyPendingLlmMeta(input);

  assert.equal(input.action, "llm");
  assert.equal(input.prompt, "prompt for model-a");
  assert.equal(input.llm?.maxTokens, 1024);
  assert.deepEqual(input.scopeCitations, ["scope-model-a"]);
});

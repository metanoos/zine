import assert from "node:assert/strict";
import test from "node:test";
import { generateSecretKey } from "nostr-tools/pure";

import {
  applyPendingLlmMeta,
  clearPendingLlmMeta,
  publishEdit,
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

const answerTransaction = {
  sequence: 0,
  timestamp: 1,
  actor: "voice",
  changes: [{ op: "insert" as const, from: 0, to: 0, text: "answer" }],
  selectionBefore: null,
  selectionAfter: null,
};

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
    editorTransactions: [answerTransaction],
  };
  setPendingLlmMeta("a.md", meta("model-a"));

  applyPendingLlmMeta(input);

  assert.equal(input.action, "llm");
  assert.equal(input.prompt, "prompt for model-a");
  assert.equal(input.llm?.maxTokens, 1024);
  assert.deepEqual(input.scopeCitations, ["scope-model-a"]);
});

test("LLM writer preserves q edges and marks only structural-only targets", async () => {
  const social = "1".repeat(64);
  const bothRoles = "2".repeat(64);
  const privateScope = "3".repeat(64);
  const rule = "4".repeat(64);
  const event = await publishEdit({
    prevEventId: null,
    previousSnapshot: "",
    relativePath: "answer.md",
    folderId: "folder",
    deltas: [],
    snapshot: "answer",
    contentHash: "hash",
    editorTransactions: [answerTransaction],
    citations: [social, bothRoles],
    scopeCitations: [privateScope, bothRoles],
    injectRule: rule,
    action: "llm",
    prompt: "answer the question",
    llm: { model: "test", temperature: null, maxTokens: 1024, provider: "test" },
    signer: generateSecretKey(),
    prepareOnly: true,
  });

  assert.deepEqual(
    event.tags.filter((tag) => tag[0] === "q").map((tag) => tag[1]),
    [social, bothRoles, privateScope, rule],
  );
  assert.deepEqual(
    event.tags.filter((tag) => tag[0] === "scope" && tag[1] === "llm"),
    [
      ["scope", "llm"],
      ["scope", "llm", "targets-v1"],
      ["scope", "llm", privateScope],
      ["scope", "llm", rule],
    ],
  );
});

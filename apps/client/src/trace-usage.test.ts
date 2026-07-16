import assert from "node:assert/strict";
import test from "node:test";
import type { Event } from "nostr-tools";

import { usageTargets } from "./trace-usage.js";

function event(tags: string[][]): Event {
  return { id: "id", kind: 4290, tags, content: "{}", created_at: 1, pubkey: "author", sig: "sig" };
}

test("trace usage includes citations and provenance lineage", () => {
  assert.deepEqual([...usageTargets(event([
    ["q", "quoted"],
    ["e", "forked", "", "forked-from"],
    ["e", "merged", "", "merge-parent"],
    ["e", "origin", "", "extracted-from"],
    ["e", "previous", "", "prev"],
  ]))], ["quoted", "forked", "merged", "origin"]);
});

test("trace usage excludes structural LLM q edges but retains lineage", () => {
  assert.deepEqual([...usageTargets(event([
    ["scope", "llm"],
    ["q", "prompt-context"],
    ["e", "forked", "", "forked-from"],
  ]))], ["forked"]);
});

test("trace usage dedupes a target related in more than one way", () => {
  assert.deepEqual([...usageTargets(event([
    ["q", "same"],
    ["e", "same", "", "forked-from"],
  ]))], ["same"]);
});

/**
 * Three-way merge unit tests — pure, no relay.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  threeWayMerge,
  applyMergeChoices,
  autoMergedText,
  splitLines,
  joinLines,
  decidePullMerge,
} from "./three-way-merge.js";

test("splitLines / joinLines round-trip", () => {
  assert.equal(joinLines(splitLines("a\nb\nc")), "a\nb\nc");
  assert.equal(joinLines(splitLines("")), "");
  assert.equal(joinLines(splitLines("solo")), "solo");
});

test("clean: ours === theirs", () => {
  const r = threeWayMerge("base", "same", "same");
  assert.equal(r.clean, true);
  assert.equal(autoMergedText(r), "same");
});

test("clean: only they changed (ours === base)", () => {
  const r = threeWayMerge("line1\n", "line1\n", "line1\nfrom B\n");
  assert.equal(r.clean, true);
  assert.equal(autoMergedText(r), "line1\nfrom B\n");
});

test("clean: only we changed (theirs === base)", () => {
  const r = threeWayMerge("line1\n", "line1\nfrom A\n", "line1\n");
  assert.equal(r.clean, true);
  assert.equal(autoMergedText(r), "line1\nfrom A\n");
});

test("clean: independent line inserts on different regions", () => {
  const base = "a\nb\nc\n";
  const ours = "a\nA\nb\nc\n";
  const theirs = "a\nb\nC\nc\n";
  const r = threeWayMerge(base, ours, theirs);
  // Best-effort: if clean, both inserts should appear; if not, still applyable.
  const text = autoMergedText(r) ?? applyMergeChoices(r.chunks, {});
  assert.ok(text.includes("A"), `expected A in: ${JSON.stringify(text)}`);
  assert.ok(text.includes("C"), `expected C in: ${JSON.stringify(text)}`);
  assert.ok(text.includes("a"), "keeps shared lines");
});

test("conflict: both sides edit the same line differently", () => {
  const base = "hello world\n";
  const ours = "hello A\n";
  const theirs = "hello B\n";
  const r = threeWayMerge(base, ours, theirs);
  assert.ok(r.conflictCount >= 1, "should flag a conflict");
  assert.equal(autoMergedText(r), null);
  // Default choice = ours
  assert.equal(applyMergeChoices(r.chunks, {}), "hello A\n");
  // Explicit theirs
  assert.equal(applyMergeChoices(r.chunks, { 0: "theirs" }), "hello B\n");
  // Base
  assert.equal(applyMergeChoices(r.chunks, { 0: "base" }), "hello world\n");
  // Both
  assert.equal(applyMergeChoices(r.chunks, { 0: "both" }), "hello A\nhello B\n");
});

test("conflict: default choice is ours (receiving owner)", () => {
  const r = threeWayMerge("x", "mine", "theirs");
  assert.ok(r.conflictCount >= 1);
  assert.equal(applyMergeChoices(r.chunks, {}), "mine");
});

// --- decidePullMerge: background-pull decision helper ----------------------

test("decidePullMerge: identical ours/theirs is noop", () => {
  assert.deepEqual(decidePullMerge("base", "same", "same"), { outcome: "noop" });
});

test("decidePullMerge: ours === base (no local edits) is fastforward", () => {
  const r = decidePullMerge("line1\n", "line1\n", "line1\nfrom B\n");
  assert.deepEqual(r, { outcome: "fastforward" });
});

test("decidePullMerge: independent-region edits on both sides are clean", () => {
  const base = "a\nb\nc\n";
  const ours = "a\nA\nb\nc\n";
  const theirs = "a\nb\nC\nc\n";
  const r = decidePullMerge(base, ours, theirs);
  assert.equal(r.outcome, "clean");
  assert.ok(r.merged!.includes("A"), `expected A in: ${JSON.stringify(r.merged)}`);
  assert.ok(r.merged!.includes("C"), `expected C in: ${JSON.stringify(r.merged)}`);
});

test("decidePullMerge: same-line edits on both sides are conflict", () => {
  const r = decidePullMerge("hello world\n", "hello A\n", "hello B\n");
  assert.equal(r.outcome, "conflict");
  assert.equal(r.merged, undefined);
});

test("decidePullMerge: empty base with divergent content is conflict (independent roots)", () => {
  // With no shared ancestor, every line is a divergence → diff3 flags conflict.
  const r = decidePullMerge("", "mine\n", "theirs\n");
  assert.equal(r.outcome, "conflict");
});

test("decidePullMerge: only-ours-changed with theirs === base still reports noop (no remote change)", () => {
  // theirs didn't move relative to base, so there's nothing to pull.
  assert.deepEqual(decidePullMerge("x", "edited", "x"), { outcome: "noop" });
});

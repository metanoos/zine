/**
 * Tests for `stepDeltaRange`: the common-prefix/suffix diff folded to a single
 * `{from,to}` range in the NEW text's coordinate space. This is what folder
 * replay uses to scroll the editor to the footprint of a seal's deltas.
 *
 * The four cases that matter:
 *  1. insert → range spans the newly written text in the new doc.
 *  2. replace → range spans the replacement text in the new doc.
 *  3. delete → collapsed point at the deletion site (nothing was inserted).
 *  4. identical → null (no scroll target).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { stepDeltaRange } from "./provenance.js";

test("stepDeltaRange: insert returns the inserted span in the new doc", () => {
  // "hello world" → "hello brave world": inserted "brave " at offset 6.
  const range = stepDeltaRange("hello world", "hello brave world");
  assert.deepEqual(range, { from: 6, to: 12 });
});

test("stepDeltaRange: replace spans the replacement text", () => {
  // "hello world" → "hello there": replaced "world" (5 chars) with "there" (5).
  const range = stepDeltaRange("hello world", "hello there");
  assert.deepEqual(range, { from: 6, to: 11 });
});

test("stepDeltaRange: replace with different length spans the new length", () => {
  // "abc" → "aXYc": replaced 1 char with 2; the new span is the 2 inserted.
  const range = stepDeltaRange("abc", "aXYc");
  assert.deepEqual(range, { from: 1, to: 3 });
});

test("stepDeltaRange: delete is a collapsed point at the deletion site", () => {
  // "hello cruel world" → "hello world": deleted "cruel " (offsets 6..12).
  const range = stepDeltaRange("hello cruel world", "hello world");
  assert.deepEqual(range, { from: 6, to: 6 });
});

test("stepDeltaRange: identical strings return null", () => {
  assert.equal(stepDeltaRange("same", "same"), null);
});

test("stepDeltaRange: empty → content spans the whole new doc (genesis)", () => {
  // The file's first seal: prev is "" so the whole import is the footprint.
  const range = stepDeltaRange("", "first line\nsecond line");
  assert.deepEqual(range, { from: 0, to: "first line\nsecond line".length });
});

test("stepDeltaRange: change at the end has correct offsets", () => {
  // "foo" → "foobar": inserted "bar" at the tail.
  const range = stepDeltaRange("foo", "foobar");
  assert.deepEqual(range, { from: 3, to: 6 });
});

test("stepDeltaRange: change at the start has correct offsets", () => {
  // "bar" → "foobar": inserted "foo" at the head.
  const range = stepDeltaRange("bar", "foobar");
  assert.deepEqual(range, { from: 0, to: 3 });
});

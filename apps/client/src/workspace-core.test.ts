/**
 * Tests for the seal-signer resolution helpers: `dominantVoiceInRegion` and
 * `changedRegion`. These underpin the guard in sealNow (App.tsx) that picks a
 * signer matching the *new* text a seal commits, so a node's `event.pubkey`
 * attributes its net-new content truthfully even if the `authors` map is later
 * lost on reload (the "MODEL text collapsed to AUTHOR color" bug).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { changedRegion, dominantVoiceInRegion } from "./workspace-core.js";
import type { Run } from "./workspace-core.js";

const A = "aaaa".repeat(8); // the AUTHOR voice (pubkey)
const B = "bbbb".repeat(8); // the MODEL voice (pubkey)

// --- changedRegion --------------------------------------------------------

test("changedRegion: identical strings → null", () => {
  assert.equal(changedRegion("hello", "hello"), null);
});

test("changedRegion: pure append → the appended span", () => {
  assert.deepEqual(changedRegion("hello", "hello world"), { from: 5, to: 11 });
});

test("changedRegion: pure insert in the middle", () => {
  assert.deepEqual(changedRegion("hello world", "hello NEW world"), { from: 6, to: 10 });
});

test("changedRegion: pure delete", () => {
  // "hello world" → "world" deletes the prefix; the changed region in the new
  // text is a collapsed point at 0 (nothing new was written).
  assert.deepEqual(changedRegion("hello world", "world"), { from: 0, to: 0 });
});

test("changedRegion: replace", () => {
  assert.deepEqual(changedRegion("hello world", "hello earth"), { from: 6, to: 11 });
});

// --- dominantVoiceInRegion -----------------------------------------------

test("dominantVoiceInRegion: single voice in region → that voice", () => {
  const runs: Run[] = [{ voice: A, text: "hello " }, { voice: B, text: "world" }];
  // Region [6,11) is entirely B's run.
  assert.equal(dominantVoiceInRegion(runs, 6, 11), B);
});

test("dominantVoiceInRegion: MODEL text appended, region = appended span → MODEL", () => {
  // The motivating scenario: a doc was all AUTHOR text, then MODEL appended.
  const runs: Run[] = [
    { voice: A, text: "human wrote this" },
    { voice: B, text: " and the model continued" },
  ];
  const region = changedRegion("human wrote this", "human wrote this and the model continued")!;
  // The new region is entirely the MODEL's run.
  assert.equal(dominantVoiceInRegion(runs, region.from, region.to), B);
});

test("dominantVoiceInRegion: region spanning both voices picks the larger share", () => {
  const runs: Run[] = [
    { voice: A, text: "AAAAAAAA" }, // 8 chars
    { voice: B, text: "BB" }, // 2 chars
  ];
  // Whole doc: A dominates 8:2.
  assert.equal(dominantVoiceInRegion(runs, 0, 10), A);
  // Just the tail [8,10): B dominates.
  assert.equal(dominantVoiceInRegion(runs, 8, 10), B);
});

test("dominantVoiceInRegion: tie → first-seen wins (stable)", () => {
  const runs: Run[] = [
    { voice: A, text: "AA" },
    { voice: B, text: "BB" },
  ];
  // Equal share (2:2); the iteration order of Map preserves insertion, so A wins.
  assert.equal(dominantVoiceInRegion(runs, 0, 4), A);
});

test("dominantVoiceInRegion: empty / collapsed region → null", () => {
  const runs: Run[] = [{ voice: A, text: "hello" }];
  assert.equal(dominantVoiceInRegion(runs, 0, 0), null);
  assert.equal(dominantVoiceInRegion(runs, 3, 3), null);
});

test("dominantVoiceInRegion: offsets clamped to document bounds", () => {
  const runs: Run[] = [{ voice: A, text: "hi" }];
  // Negative start / past-end end are tolerated.
  assert.equal(dominantVoiceInRegion(runs, -5, 99), A);
});

test("dominantVoiceInRegion: empty run list → null", () => {
  assert.equal(dominantVoiceInRegion([], 0, 10), null);
});

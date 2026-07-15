/**
 * Fuzzy quote matching (MinHash + LSH) — unit tests (rendezvous.md §R2).
 *
 * Tests the three layers: shingling, MinHash signature + Jaccard estimation,
 * and LSH banding (the collision guarantee). The load-bearing property:
 * near-duplicate quotes collide on at least one band-prefix, while clearly
 * different quotes do not.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  shingle,
  minHashSignature,
  estimateJaccard,
  exactJaccard,
  lshBands,
  quoteFuzzyKeys,
  lshThreshold,
  SHINGLE_K,
} from "./quote-fuzzy.js";

// --- Shingling ---------------------------------------------------------

test("shingle: word trigrams of a sentence", () => {
  const s = shingle("the quick brown fox");
  assert.deepEqual(s, ["the quick brown", "quick brown fox"]);
});

test("shingle: text shorter than k → single element of all words", () => {
  assert.deepEqual(shingle("hello world", 3), ["hello world"]);
});

test("shingle: empty text → empty array", () => {
  assert.deepEqual(shingle(""), []);
  assert.deepEqual(shingle("   "), []);
});

test("shingle: collapses internal whitespace", () => {
  const a = shingle("one  two\tthree");
  const b = shingle("one two three");
  assert.deepEqual(a, b);
});

// --- MinHash + Jaccard estimation --------------------------------------

test("estimateJaccard: identical text → ~1.0", () => {
  const sig = minHashSignature(shingle("the same passage quoted verbatim here"));
  const sim = estimateJaccard(sig, sig);
  assert.ok(sim > 0.99, `identical signatures should match ~1.0, got ${sim}`);
});

test("estimateJaccard: completely different text → low", () => {
  const sigA = minHashSignature(shingle("alpha beta gamma delta epsilon zeta eta theta"));
  const sigB = minHashSignature(shingle("one two three four five six seven eight"));
  const sim = estimateJaccard(sigA, sigB);
  assert.ok(sim < 0.2, `disjoint text should be <0.2, got ${sim}`);
});

test("estimateJaccard: near-duplicate → high similarity", () => {
  const a = "it was the best of times it was the worst of times";
  const b = "it was the best of times and the worst of times"; // +1 word
  const sigA = minHashSignature(shingle(a));
  const sigB = minHashSignature(shingle(b));
  const est = estimateJaccard(sigA, sigB);
  const exact = exactJaccard(shingle(a), shingle(b));
  // The estimate should be close to the exact Jaccard.
  assert.ok(Math.abs(est - exact) < 0.2, `estimate ${est} should be close to exact ${exact}`);
  assert.ok(est > 0.5, `near-dup should be >0.5, got ${est}`);
});

test("exactJaccard: identical sets → 1.0", () => {
  assert.equal(exactJaccard(["a", "b", "c"], ["a", "b", "c"]), 1.0);
});

test("exactJaccard: disjoint sets → 0", () => {
  assert.equal(exactJaccard(["a", "b"], ["c", "d"]), 0);
});

test("exactJaccard: half overlap → 0.33 (1/3)", () => {
  // {a,b} ∩ {a,b,c} = {a,b} → 2/3 union overlap
  assert.equal(exactJaccard(["a", "b"], ["a", "b", "c"]), 2 / 3);
});

// --- LSH banding -------------------------------------------------------

test("lshBands: produces BANDS keys", () => {
  const sig = minHashSignature(shingle("some text here for testing"));
  const keys = lshBands(sig);
  assert.equal(keys.length, 32); // default BANDS
  assert.ok(keys.every((k) => k.startsWith("b")));
});

test("lshBands: identical signatures → identical keys (all bands collide)", () => {
  const sig = minHashSignature(shingle("the same passage quoted verbatim"));
  const keysA = lshBands(sig);
  const keysB = lshBands(sig);
  assert.deepEqual(keysA, keysB);
});

test("lshBands: near-duplicate → at least one band collision", () => {
  // Two versions of the same passage — should share at least one band.
  const a = "it was the best of times it was the worst of times " +
    "it was the age of wisdom it was the age of foolishness";
  const b = "it was the best of times and the worst of times " +
    "it was the age of wisdom and the age of foolishness";
  const keysA = new Set(lshBands(minHashSignature(shingle(a))));
  const keysB = lshBands(minHashSignature(shingle(b)));
  const shared = keysB.filter((k) => keysA.has(k));
  assert.ok(shared.length >= 1, `near-dup should collide on ≥1 band, got ${shared.length}`);
});

test("lshBands: completely different text → few or zero collisions", () => {
  const a = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda";
  const b = "red green blue yellow orange purple pink brown black white gray";
  const keysA = new Set(lshBands(minHashSignature(shingle(a))));
  const keysB = lshBands(minHashSignature(shingle(b)));
  const shared = keysB.filter((k) => keysA.has(k));
  // Disjoint texts might collide on a band by chance, but rarely more than 1-2.
  assert.ok(shared.length <= 3, `disjoint text should collide on ≤3 bands, got ${shared.length}`);
});

// --- quoteFuzzyKeys (convenience) --------------------------------------

test("quoteFuzzyKeys: returns band keys for arbitrary text", () => {
  const keys = quoteFuzzyKeys("a passage worth rendezvousing on");
  assert.ok(keys.length > 0);
  assert.ok(keys.every((k) => k.startsWith("b")));
});

test("quoteFuzzyKeys: same text → same keys (deterministic)", () => {
  const a = quoteFuzzyKeys("deterministic hashing test passage");
  const b = quoteFuzzyKeys("deterministic hashing test passage");
  assert.deepEqual(a, b);
});

// --- Threshold ---------------------------------------------------------

test("lshThreshold: returns a value in (0, 1)", () => {
  const t = lshThreshold();
  assert.ok(t > 0 && t < 1, `threshold should be in (0,1), got ${t}`);
  // With defaults (32 bands, 4 rows): (1/32)^(1/4) ≈ 0.42
  assert.ok(t > 0.3 && t < 0.5, `expected ~0.42, got ${t}`);
});

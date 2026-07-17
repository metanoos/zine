/**
 * canonicalQuoteText + quoteHash (protocol/rendezvous.md §1.1, §1.3). Pure unit
 * tests — no relay, no signing. The `H` coordinate is the load-bearing invariant
 * of the rendezvous layer: two people who quoted the same passage MUST hash to
 * the same `H`, and trivial whitespace differences MUST NOT break the match.
 *
 * What is NOT tested here: the publishEdit writer-side derivation (relay-bound,
 * follows the same exclusion convention as provenance.inbound.test.ts) and the
 * fuzzy/LSH layer above the coordinate (rendezvous.md §R2 — a client-side concern).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { canonicalQuoteText, quoteHash } from "./provenance.js";

// --- canonicalQuoteText: the coordinate-stability rules -----------------

test("canonicalQuoteText: collapses internal whitespace runs to single spaces", () => {
  // Two people pasting the same passage with different internal spacing must
  // canonicalize identically — this is the common case the coordinate exists for.
  const a = canonicalQuoteText("the   quick\tbrown\n\nfox");
  const b = canonicalQuoteText("the quick brown fox");
  assert.equal(a, b);
  assert.equal(a, "the quick brown fox");
});

test("canonicalQuoteText: trims leading and trailing whitespace", () => {
  assert.equal(canonicalQuoteText("  same passage  "), "same passage");
  assert.equal(canonicalQuoteText("\n\tsame passage\r\n"), "same passage");
});

test("canonicalQuoteText: NFC-normalizes unicode (composed == decomposed)", () => {
  // café as composed (NFC) vs decomposed (NFD) — must canonicalize to the same
  // bytes so two people quoting accented text rendezvous regardless of how their
  // input method encoded it.
  const composed = "caf\u00e9"; // é as single codepoint
  const decomposed = "cafe\u0301"; // e + combining acute
  assert.equal(canonicalQuoteText(composed), canonicalQuoteText(decomposed));
});

test("canonicalQuoteText: does NOT case-fold (case can carry meaning)", () => {
  // Deliberate: "The" (proper noun) and "the" (article) may be genuinely
  // different quotes. Let them miss each other rather than false-merge.
  assert.notEqual(canonicalQuoteText("The passage"), canonicalQuoteText("the passage"));
});

test("canonicalQuoteText: preserves punctuation (no stripping)", () => {
  // Punctuation is part of the quote; stripping it would make distinct passages
  // collide. Only whitespace is normalized.
  assert.equal(
    canonicalQuoteText("He said, \"hello!\" — and left."),
    "He said, \"hello!\" — and left.",
  );
});

// --- quoteHash: the rendezvous coordinate -------------------------------

test("quoteHash: identical bytes → identical H", async () => {
  const h1 = await quoteHash("the same passage");
  const h2 = await quoteHash("the same passage");
  assert.equal(h1, h2);
  assert.equal(h1.length, 64); // SHA-256 hex
  assert.match(h1, /^[0-9a-f]{64}$/); // lowercase hex, no prefix
});

test("quoteHash: whitespace-only differences produce the same H", async () => {
  // THE load-bearing rendezvous property: two people quoting the same passage
  // from different editions, with different line breaks / spacing, must meet.
  const h1 = await quoteHash(
    "It was the best of times,\nit was the worst of times.",
  );
  const h2 = await quoteHash(
    "It was the best of times, it was the worst of times.",
  );
  assert.equal(h1, h2);
});

test("quoteHash: different passages produce different H", async () => {
  const h1 = await quoteHash("one thing");
  const h2 = await quoteHash("another thing entirely");
  assert.notEqual(h1, h2);
});

test("quoteHash: case differences produce different H (no case-fold)", async () => {
  // Consistent with canonicalQuoteText's no-case-fold rule.
  const h1 = await quoteHash("The Beginning");
  const h2 = await quoteHash("the beginning");
  assert.notEqual(h1, h2);
});

test("quoteHash: NFC vs NFD accented text produces the same H", async () => {
  // The same word in precomposed (é as U+00E9) vs decomposed (e + U+0301 combining
  // acute) form must rendezvous — a French quoter with one input method and a
  // German quoter with another must meet on the same passage.
  const composed = "café";
  const decomposed = "cafe\u0301"; // e (U+0065) + combining acute (U+0301)
  const h1 = await quoteHash(composed);
  const h2 = await quoteHash(decomposed);
  assert.equal(h1, h2);
});

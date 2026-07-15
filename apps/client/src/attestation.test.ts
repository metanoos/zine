/**
 * Tests for the NIP-03 attestation builder (`buildAttestationTemplate`). Pure
 * wire-shape checks only — no relay, no calendar, no signing. The stamp /
 * upgrade / publish paths are relay- and HTTP-dependent and are deliberately
 * excluded, the same convention every provenance.*.test.ts file follows.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildAttestationTemplate } from "./attestation.js";

test("buildAttestationTemplate: kind is 1040 (NIP-03)", () => {
  const t = buildAttestationTemplate("abc".repeat(21), "proof", "", 1_700_000_000);
  assert.equal(t.kind, 1040);
});

test("buildAttestationTemplate: exactly one e tag pointing at the attested id", () => {
  const attestedId = "0".repeat(64);
  const t = buildAttestationTemplate(attestedId, "proof", "wss://relay", 1_700_000_000);
  const eTags = t.tags.filter((tag) => tag[0] === "e");
  assert.equal(eTags.length, 1);
  assert.deepEqual(eTags[0], ["e", attestedId, "wss://relay"]);
});

test("buildAttestationTemplate: content is the base64 proof, verbatim", () => {
  // A real .ots proof is binary; on the wire it rides as base64 in `content`.
  // The builder must not re-encode or wrap it.
  const proofB64 = "AAAB9wLNVkHkAAAA";
  const t = buildAttestationTemplate("1".repeat(64), proofB64, "", 1_700_000_000);
  assert.equal(t.content, proofB64);
});

test("buildAttestationTemplate: empty relay hint is preserved as empty string", () => {
  // NIP-03's `e` tag is [id, relay, marker?] — an empty hint is a valid
  // "no hint known," not an omission. The builder keeps it so the tag is
  // always a 3-element array (id, hint, absent marker).
  const t = buildAttestationTemplate("2".repeat(64), "proof", "", 1_700_000_000);
  const eTag = t.tags.find((tag) => tag[0] === "e");
  assert.ok(eTag);
  assert.equal(eTag?.length, 3);
  assert.equal(eTag?.[2], "");
});

test("buildAttestationTemplate: created_at is the injected seconds value", () => {
  // Pure: the caller owns the wall-clock, the builder never reads Date.now().
  const t = buildAttestationTemplate("3".repeat(64), "proof", "", 1_750_000_000);
  assert.equal(t.created_at, 1_750_000_000);
});

test("buildAttestationTemplate: no advisory k tag (the cited kind is self-describing)", () => {
  // NIP-03 lists an optional `["k", kind]` tag; we omit it because the cited
  // event's kind is recoverable from the event itself once fetched. Pinning
  // the absence guards against a future drive-by addition.
  const t = buildAttestationTemplate("4".repeat(64), "proof", "", 1_700_000_000);
  assert.equal(t.tags.find((tag) => tag[0] === "k"), undefined);
});

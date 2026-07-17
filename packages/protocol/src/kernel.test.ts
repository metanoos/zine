import assert from "node:assert/strict";
import test from "node:test";
import type { Event } from "nostr-tools";
import { verifyEvent } from "nostr-tools/pure";

import corpus from "../corpus/conformance-v1.json" with { type: "json" };
import {
  canonicalBytes,
  canonicalJson,
  encodeTraceLocator,
  parseTraceLocator,
  validateKEditTransition,
  validateTraceLocator,
  verifyFileTraceChain,
  type CanonicalJsonValue,
  type KEdit,
  type TraceConformanceStatus,
} from "./index.js";

test("the fixed corpus identifies this kernel version", () => {
  assert.equal(corpus.format, "zine-protocol-conformance");
  assert.equal(corpus.version, 1);
});

test("canonical encoding matches every fixed byte vector", () => {
  for (const vector of corpus.canonical) {
    const value = vector.value as CanonicalJsonValue;
    assert.equal(canonicalJson(value), vector.encoded, vector.name);
    assert.equal(Buffer.from(canonicalBytes(value)).toString("hex"), vector.utf8Hex, vector.name);
  }
  assert.throws(() => canonicalJson(Number.NaN as never), /non-finite/);
  assert.throws(() => canonicalJson("\ud800"), /unpaired Unicode surrogate/);
});

test("KEdit validation matches every fixed transition vector", () => {
  for (const vector of corpus.kedits) {
    const verdict = validateKEditTransition(
      vector.before,
      vector.after,
      vector.kedits as KEdit[],
    );
    assert.equal(verdict.valid, vector.valid, vector.name);
    if (vector.reasonIncludes) {
      assert.match(verdict.reason ?? "", new RegExp(vector.reasonIncludes), vector.name);
    }
  }
});

test("trace locator validation and encoding match every fixed vector", () => {
  for (const vector of corpus.locators) {
    if (!vector.valid) {
      assert.throws(
        () => validateTraceLocator(vector.value),
        new RegExp(vector.reasonIncludes ?? "invalid"),
        vector.name,
      );
      continue;
    }
    const locator = validateTraceLocator(vector.value);
    assert.deepEqual(parseTraceLocator(JSON.stringify(vector.value)), locator, vector.name);
    assert.equal(encodeTraceLocator(locator), vector.encoded, vector.name);
    assert.deepEqual(parseTraceLocator(vector.encoded ?? ""), locator, vector.name);
  }
});

test("trace conformance matches the fixed signed-event corpus", async () => {
  for (const vector of corpus.traces) {
    const verdict = await verifyFileTraceChain(vector.chain as Event[], verifyEvent);
    assert.equal(verdict.status, vector.status as TraceConformanceStatus, vector.name);
    assert.deepEqual(
      verdict.steps.map((step) => step.status),
      vector.stepStatuses as TraceConformanceStatus[],
      vector.name,
    );
  }
});

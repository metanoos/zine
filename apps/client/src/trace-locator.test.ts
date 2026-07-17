import assert from "node:assert/strict";
import test from "node:test";

import {
  encodeTraceLocator,
  parseTraceLocator,
  type TraceLocator,
} from "./trace-locator.js";

const LOCATOR: TraceLocator = {
  format: "zine-trace-locator",
  version: 1,
  kind: "file",
  rootId: "a".repeat(64),
  traceId: "b".repeat(64),
  nodeId: "c".repeat(64),
  relativePath: "reports/result.md",
  ownerPubkey: "d".repeat(64),
  relayHints: ["wss://relay.example.com"],
};

test("trace locators round-trip as compact text and plain JSON", () => {
  const encoded = encodeTraceLocator(LOCATOR);
  assert.match(encoded, /^zine-trace:/);
  assert.deepEqual(parseTraceLocator(encoded), LOCATOR);
  assert.deepEqual(parseTraceLocator(JSON.stringify(LOCATOR)), LOCATOR);
});

test("trace locators reject folder ambiguity and unsafe relay hints", () => {
  assert.throws(
    () => parseTraceLocator(JSON.stringify({ ...LOCATOR, kind: "folder" })),
    /unsupported trace locator/,
  );
  assert.throws(
    () => parseTraceLocator(JSON.stringify({ ...LOCATOR, relayHints: ["https://example.com"] })),
    /relayHints/,
  );
});

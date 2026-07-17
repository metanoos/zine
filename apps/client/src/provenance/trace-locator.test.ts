import assert from "node:assert/strict";
import test from "node:test";

import {
  encodeTraceLocator,
  parseTraceLocator,
  relayHintsRequiringApproval,
  relayHintRequiresApproval,
  unapprovedRelayHints,
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
  assert.throws(
    () => parseTraceLocator(JSON.stringify({
      ...LOCATOR,
      relayHints: Array.from({ length: 9 }, (_, index) => `wss://relay-${index}.example.com`),
    })),
    /at most 8/,
  );
  assert.throws(
    () => parseTraceLocator(JSON.stringify({
      ...LOCATOR,
      relayHints: ["wss://user:secret@relay.example.com"],
    })),
    /plain ws/,
  );
  assert.throws(
    () => parseTraceLocator(JSON.stringify({
      ...LOCATOR,
      relayHints: [" ws://127.0.0.1:4869 "],
    })),
    /invalid URL/,
  );
});

test("sensitive relay classification covers plaintext, local names, and private ranges", () => {
  for (const url of [
    "ws://localhost:4869",
    "ws://press.local:4869",
    "ws://relay.internal:4869",
    "ws://nas:4869",
    "ws://relay.example.com:4869",
    "wss://127.0.0.1.nip.io:4869",
    "wss://localtest.me:4869",
    "wss://2130706433:4869",
    "ws://10.0.0.5:4869",
    "ws://100.64.0.1:4869",
    "ws://127.12.0.1:4869",
    "ws://169.254.1.2:4869",
    "ws://172.31.0.1:4869",
    "ws://192.168.1.2:4869",
    "ws://[::1]:4869",
    "ws://[fd00::1]:4869",
    "ws://[fe80::1]:4869",
    "ws://[::ffff:127.0.0.1]:4869",
  ]) {
    assert.equal(relayHintRequiresApproval(url), true, url);
  }
  for (const url of [
    "wss://relay.example.com",
    "wss://127.attacker.example:4869",
    "ws://examplehiddenservice.onion",
    "wss://172.32.0.1:4869",
  ]) {
    assert.equal(relayHintRequiresApproval(url), false, url);
  }
});

test("approval is exact, one-shot, and limited to sensitive relay hints", () => {
  const locator: TraceLocator = {
    ...LOCATOR,
    relayHints: [
      "wss://relay.example.com",
      "ws://127.0.0.1:4869",
      "ws://192.168.1.7:4869",
    ],
  };
  assert.deepEqual(relayHintsRequiringApproval(locator), [
    "ws://127.0.0.1:4869",
    "ws://192.168.1.7:4869",
  ]);
  assert.deepEqual(
    unapprovedRelayHints(locator, ["ws://127.0.0.1:4869"]),
    ["ws://192.168.1.7:4869"],
  );
});

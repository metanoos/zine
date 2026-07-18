import assert from "node:assert/strict";
import test from "node:test";
import {
  COIN_CLIPBOARD_VERSION,
  parseCoinClipboardEnvelope,
  serializeCoinClipboardEnvelope,
} from "./coin-clipboard.js";

test("coin clipboard envelope round-trips an opaque session ticket", () => {
  assert.deepEqual(
    parseCoinClipboardEnvelope(serializeCoinClipboardEnvelope("ticket-1")),
    { v: COIN_CLIPBOARD_VERSION, ticket: "ticket-1" },
  );
});

test("coin clipboard envelope rejects malformed, stale-version, and empty tickets", () => {
  assert.equal(parseCoinClipboardEnvelope(""), null);
  assert.equal(parseCoinClipboardEnvelope("not json"), null);
  assert.equal(parseCoinClipboardEnvelope('{"v":2,"ticket":"ticket-1"}'), null);
  assert.equal(parseCoinClipboardEnvelope('{"v":1,"ticket":""}'), null);
});

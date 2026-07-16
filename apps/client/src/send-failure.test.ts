import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { describeSendFailure } from "./send-failure.js";

const appSource = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const modalSource = readFileSync(new URL("./SendFailureModal.tsx", import.meta.url), "utf8");

test("relay publication failures point Send recovery to Networks", () => {
  const failure = describeSendFailure(
    new Error("publish failed on every relay (ws://127.0.0.1:4869: connection closed)"),
  );

  assert.equal(failure.destination, "networking");
  assert.equal(failure.actionLabel, "Open Networks");
  assert.match(failure.summary, /home node and write-enabled relays/);
  assert.match(failure.detail, /publish failed on every relay/);
});

test("an unavailable home Step is explained as a network recovery", () => {
  const failure = describeSendFailure(
    new Error("latest Step is unavailable on the home relay"),
  );

  assert.equal(failure.destination, "networking");
});

test("a missing author key points Send recovery to Keys", () => {
  const failure = describeSendFailure(new Error("no key for voice a1b2c3d4…"));

  assert.equal(failure.title, "Send needs a signing key");
  assert.equal(failure.destination, "keys");
  assert.equal(failure.actionLabel, "Open Keys");
});

test("unknown failures remain actionable without guessing a destination", () => {
  const failure = describeSendFailure("unexpected serialization failure");

  assert.equal(failure.destination, null);
  assert.equal(failure.actionLabel, null);
  assert.match(failure.summary, /not sent/);
  assert.equal(failure.detail, "unexpected serialization failure");
});

test("Send promotes its caught error into an actionable alert dialog", () => {
  assert.match(
    appSource,
    /if \(op === "send"\) setSendFailure\(describeSendFailure\(e\)\);/,
  );
  assert.match(appSource, /<SendFailureModal/);
  assert.match(appSource, /setActiveView\(view\)/);
  assert.match(modalSource, /role="alertdialog"/);
  assert.match(modalSource, /Technical detail/);
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  isLoopbackRelayUrl,
  publicationRelays,
  type RelayEntry,
} from "./relay-config.js";

function relay(
  id: string,
  url: string,
  write = true,
  builtin = false,
): RelayEntry {
  return { id, url, read: true, write, ...(builtin ? { builtin: true } : {}) };
}

test("publication relays cross the machine boundary", () => {
  const entries = [
    relay("home", "ws://127.0.0.1:4869", true, true),
    relay("public", "wss://relay.example.com"),
    relay("read-only", "wss://read.example.com", false),
    relay("local-extra", "ws://localhost:7777"),
  ];

  assert.deepEqual(
    publicationRelays(entries).map((entry) => entry.id),
    ["public"],
  );
});

test("a hosted web home remains a publication destination", () => {
  const hostedHome = relay("home", "wss://zine.example.com/relay", true, true);
  assert.deepEqual(publicationRelays([hostedHome]), [hostedHome]);
});

test("loopback classification covers IPv4, IPv6, and invalid URLs", () => {
  assert.equal(isLoopbackRelayUrl("ws://localhost:4869"), true);
  assert.equal(isLoopbackRelayUrl("ws://127.12.0.1:4869"), true);
  assert.equal(isLoopbackRelayUrl("ws://127.attacker.example:4869"), false);
  assert.equal(isLoopbackRelayUrl("ws://[::1]:4869"), true);
  assert.equal(isLoopbackRelayUrl("ws://0.0.0.0:4869"), true);
  assert.equal(isLoopbackRelayUrl("wss://relay.example.com"), false);
  assert.equal(isLoopbackRelayUrl("not a relay URL"), true);
});

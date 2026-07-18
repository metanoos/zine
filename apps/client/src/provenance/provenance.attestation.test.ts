import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import type { Event } from "nostr-tools";
import type { Relay } from "nostr-tools/relay";

import {
  attestationCountsFromEvents,
  buildAttestationTemplate,
  isLoopbackRelayUrl,
  publishToMany,
} from "./provenance.js";

const provenanceSource = readFileSync(new URL("./provenance.ts", import.meta.url), "utf8");

function event(id: string, kind: number, tags: string[][]): Event {
  return { id, kind, tags, content: "{}", created_at: 1, pubkey: "author", sig: "sig" };
}

test("TraceAttestation is an append-only target event, not a fake TraceNode", () => {
  const template = buildAttestationTemplate("target-id", "target-author", {
    createdAtSec: 1_730_000_000,
    message: "I stand behind this edition.",
    geohash: "9q8yy",
  });

  assert.equal(template.kind, 4294);
  assert.equal(template.created_at, 1_730_000_000);
  assert.deepEqual(template.tags, [
    ["e", "target-id", "", "target"],
    ["k", "4290"],
    ["p", "target-author"],
    ["g", "9q8yy"],
  ]);
  assert.deepEqual(JSON.parse(template.content), {
    message: "I stand behind this edition.",
  });
  assert.equal(template.tags.some((tag) => tag[0] === "action"), false);
  assert.equal(template.tags.some((tag) => tag[3] === "prev"), false);
});

test("TraceAttestation may omit advisory author, note, and location", () => {
  const template = buildAttestationTemplate("target-id", undefined, {
    createdAtSec: 1,
  });

  assert.deepEqual(template.tags, [
    ["e", "target-id", "", "target"],
    ["k", "4290"],
  ]);
  assert.equal(template.content, "{}");
});

test("prior-Send verification excludes loopback relay URLs", () => {
  assert.equal(isLoopbackRelayUrl("ws://localhost:4869"), true);
  assert.equal(isLoopbackRelayUrl("ws://127.12.0.1:4869"), true);
  assert.equal(isLoopbackRelayUrl("ws://[::1]:4869"), true);
  assert.equal(isLoopbackRelayUrl("ws://0.0.0.0:4869"), true);
  assert.equal(isLoopbackRelayUrl("wss://relay.example.com"), false);
  assert.equal(isLoopbackRelayUrl("not a relay URL"), true);
});

test("attestation counts include zero targets and only exact target-role events", () => {
  const counts = attestationCountsFromEvents([
    event("a", 4294, [["e", "trace-1", "", "target"]]),
    event("b", 4294, [["e", "trace-1", "", "target"]]),
    event("wrong-role", 4294, [["e", "trace-2", "", "mention"]]),
    event("wrong-kind", 4290, [["e", "trace-2", "", "target"]]),
    event("outside", 4294, [["e", "trace-3", "", "target"]]),
  ], ["trace-1", "trace-2"]);

  assert.deepEqual([...counts], [["trace-1", 2], ["trace-2", 0]]);
});

test("Mint cannot accept disjoint Coin and attestation relay successes", async () => {
  const coinEvent = event("coin", 4290, []);
  const attestationEvent = event("attestation", 4294, []);
  const calls: string[] = [];
  const relayA = {
    url: "wss://relay-a.example",
    publish: async (candidate: Event) => {
      calls.push(`a:${candidate.id}`);
      if (candidate.id === attestationEvent.id) throw new Error("attestation rejected");
      return "ok";
    },
  } as unknown as Relay;
  const relayB = {
    url: "wss://relay-b.example",
    publish: async (candidate: Event) => {
      calls.push(`b:${candidate.id}`);
      if (candidate.id === coinEvent.id) throw new Error("Coin rejected");
      return "ok";
    },
  } as unknown as Relay;

  const coinRelays = await publishToMany([relayA, relayB], coinEvent);
  assert.deepEqual(coinRelays.map((relay) => relay.url), [relayA.url]);
  await assert.rejects(
    publishToMany(coinRelays, attestationEvent),
    /publish failed on every relay/,
  );
  assert.deepEqual(calls, ["a:coin", "b:coin", "a:attestation"]);
  assert.match(
    provenanceSource,
    /coinRelays = await sendStep\(coin, mintSigner\)[\s\S]*?attestNodeToRelays\([\s\S]*?coinRelays\)/,
  );
});

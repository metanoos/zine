import { test } from "node:test";
import assert from "node:assert/strict";
import type { Event } from "nostr-tools";
import { finalizeEvent, generateSecretKey } from "nostr-tools/pure";

import {
  nextReplaceableCreatedAt,
  ownerPinnedChainFromSet,
  resolveTraceChainAtHead,
  resolveTraceChainCandidates,
  resolveTraceIdentity,
} from "./provenance.js";

test("replaceable TraceHead timestamps advance across same-second writes", () => {
  assert.equal(nextReplaceableCreatedAt(100), 100);
  assert.equal(nextReplaceableCreatedAt(100, 100), 101);
  assert.equal(nextReplaceableCreatedAt(100, 105), 106);
  assert.equal(nextReplaceableCreatedAt(110, 105), 110);
});

const OWNER_SECRET = Uint8Array.from([...new Uint8Array(31), 7]);

function node(label: string, prev?: string, secret = OWNER_SECRET): Event {
  return finalizeEvent({
    created_at: 1,
    kind: 4290,
    tags: [
      ["z", "file"],
      ...(prev ? [["e", prev, "", "prev"]] : []),
    ],
    content: JSON.stringify({ snapshot: label }),
  }, secret);
}

function loader(events: Event[]) {
  const byId = new Map(events.map((event) => [event.id, event]));
  return async (ids: readonly string[]) => ids.flatMap((id) => byId.get(id) ?? []);
}

test("trace identity is the genesis reached through prev links", async () => {
  const genesis = node("g");
  const first = node("a1", genesis.id);
  const second = node("a2", first.id);
  const events = [genesis, first, second];
  assert.equal(await resolveTraceIdentity(second.id, loader(events)), genesis.id);
});

test("an exact folder-member head resolves a renamed chain without coordinates", async () => {
  const genesis = node("g");
  genesis.tags.push(["F", "old-name.md"]);
  const moved = node("a1", genesis.id);
  moved.tags.push(["F", "new-name.md"]);

  // Re-sign after adding the coordinate tags.
  const signedGenesis = finalizeEvent({
    kind: genesis.kind,
    created_at: genesis.created_at,
    tags: genesis.tags,
    content: genesis.content,
  }, OWNER_SECRET);
  const signedMoved = finalizeEvent({
    kind: moved.kind,
    created_at: moved.created_at,
    tags: moved.tags.map((tag) =>
      tag[0] === "e" && tag[3] === "prev" ? ["e", signedGenesis.id, "", "prev"] : tag
    ),
    content: moved.content,
  }, OWNER_SECRET);
  const resolved = await resolveTraceChainAtHead(
    signedGenesis.id,
    signedMoved.id,
    loader([signedGenesis, signedMoved]),
  );
  assert.equal(resolved.status, "resolved");
  if (resolved.status === "resolved") {
    assert.equal(resolved.source, "exact-head");
    assert.deepEqual(resolved.chain.map((event) => event.id), [signedGenesis.id, signedMoved.id]);
  }
});

test("newer valid TraceHead candidate supersedes an ancestor candidate", async () => {
  const genesis = node("g");
  const first = node("a1", genesis.id);
  const second = node("a2", first.id);
  const events = [genesis, first, second];
  const resolved = await resolveTraceChainCandidates(
    genesis.id,
    [first.id, second.id],
    loader(events),
  );
  assert.equal(resolved.status, "resolved");
  if (resolved.status === "resolved") {
    assert.deepEqual(resolved.chain.map((event) => event.id), events.map((event) => event.id));
  }
});

test("incomparable valid TraceHead candidates remain a conflict", async () => {
  const genesis = node("g");
  const left = node("left", genesis.id);
  const right = node("right", genesis.id);
  const events = [genesis, left, right];
  const resolved = await resolveTraceChainCandidates(
    genesis.id,
    [left.id, right.id],
    loader(events),
  );
  assert.equal(resolved.status, "conflict");
  if (resolved.status === "conflict") {
    assert.deepEqual(new Set(resolved.candidateHeadIds), new Set([left.id, right.id]));
  }
});

test("candidate that does not walk to the declared genesis is rejected", async () => {
  const other = node("other");
  const bad = node("bad", other.id);
  const resolved = await resolveTraceChainCandidates(
    "f".repeat(64),
    [bad.id],
    loader([other, bad]),
  );
  assert.equal(resolved.status, "broken");
});

test("injected loaders cannot promote an invalidly signed same-owner event", async () => {
  const genesis = node("g");
  const head = node("head", genesis.id);
  const forged: Event = {
    id: head.id,
    pubkey: head.pubkey,
    created_at: head.created_at,
    kind: head.kind,
    tags: head.tags.map((tag) => [...tag]),
    content: head.content,
    sig: "0".repeat(128),
  };
  assert.equal(await resolveTraceIdentity(forged.id, loader([genesis, forged])), null);
  const resolved = await resolveTraceChainCandidates(
    genesis.id,
    [forged.id],
    loader([genesis, forged]),
  );
  assert.equal(resolved.status, "broken");
});

test("ambiguous and malformed prev edges are never resolved", async () => {
  const genesis = node("g");
  const other = node("other");
  const ambiguous = finalizeEvent({
    kind: 4290,
    created_at: 2,
    tags: [
      ["z", "file"],
      ["e", genesis.id, "", "prev"],
      ["e", other.id, "", "prev"],
    ],
    content: JSON.stringify({ snapshot: "ambiguous" }),
  }, OWNER_SECRET);
  const malformed = finalizeEvent({
    kind: 4290,
    created_at: 2,
    tags: [["z", "file"], ["e", genesis.id, "relay-hint", "prev"]],
    content: JSON.stringify({ snapshot: "malformed" }),
  }, OWNER_SECRET);
  for (const head of [ambiguous, malformed]) {
    const events = [genesis, other, head];
    assert.equal(await resolveTraceIdentity(head.id, loader(events)), null);
    assert.equal(
      (await resolveTraceChainCandidates(genesis.id, [head.id], loader(events))).status,
      "broken",
    );
  }
});

test("a foreign signer cannot extend another owner's trace", async () => {
  const attackerSecret = generateSecretKey();
  const genesis = node("g");
  const ownerHead = node("owner-head", genesis.id);
  const attackerHead = node("attacker-head", ownerHead.id, attackerSecret);
  const events = [genesis, ownerHead, attackerHead];
  const resolved = await resolveTraceChainCandidates(
    genesis.id,
    [ownerHead.id, attackerHead.id],
    loader(events),
  );
  assert.equal(resolved.status, "resolved");
  if (resolved.status === "resolved") {
    assert.deepEqual(resolved.chain.map((event) => event.id), [genesis.id, ownerHead.id]);
  }
  assert.equal(await resolveTraceIdentity(attackerHead.id, loader(events)), null);
});

test("an exact folder frontier stays pinned when the loader also has a descendant", async () => {
  const genesis = node("g");
  const pinned = node("a1", genesis.id);
  const later = node("a2", pinned.id);
  const resolved = await resolveTraceChainAtHead(
    genesis.id,
    pinned.id,
    loader([genesis, pinned, later]),
  );
  assert.equal(resolved.status, "resolved");
  if (resolved.status === "resolved") {
    assert.deepEqual(resolved.chain.map((event) => event.id), [genesis.id, pinned.id]);
  }
});

test("relay scans ignore foreign file and folder prev extensions", () => {
  const ownerSecret = generateSecretKey();
  const attackerSecret = generateSecretKey();
  const signedNode = (
    discriminator: "file" | "folder",
    secret: Uint8Array,
    prev?: string,
    prevTag?: string[],
  ) => finalizeEvent({
    kind: 4290,
    created_at: 1,
    tags: [
      ["z", discriminator],
      ...(prevTag ? [prevTag] : prev ? [["e", prev, "", "prev"]] : []),
    ],
    content: JSON.stringify({ snapshot: discriminator === "file" ? "body" : { members: [] } }),
  }, secret);

  for (const discriminator of ["file", "folder"] as const) {
    const genesis = signedNode(discriminator, ownerSecret);
    const ownerHead = signedNode(discriminator, ownerSecret, genesis.id);
    const attackerHead = signedNode(discriminator, attackerSecret, ownerHead.id);
    assert.deepEqual(
      ownerPinnedChainFromSet(
        genesis.id,
        [genesis, ownerHead, attackerHead],
        discriminator,
      ).map((event) => event.id),
      [genesis.id, ownerHead.id],
    );
    for (const malformedPrev of [
      ["e", ownerHead.id, "wss://relay.example", "prev"],
      ["e", ownerHead.id, "", "prev", "extra"],
      ["e", "not-a-node-id", "", "prev"],
    ]) {
      const malformedHead = signedNode(
        discriminator,
        ownerSecret,
        undefined,
        malformedPrev,
      );
      assert.deepEqual(
        ownerPinnedChainFromSet(
          genesis.id,
          [genesis, ownerHead, malformedHead],
          discriminator,
        ).map((event) => event.id),
        [genesis.id, ownerHead.id],
      );
    }
  }
});

test("ownerPinnedChainFromSet fails closed on an ambiguous same-owner fork", () => {
  // Genesis g has two same-owner descendants (left, right) that are both heads
  // — neither reachable from the other via prev. The relay set is ambiguous, so
  // the resolver returns [] rather than trusting either branch.
  const g = node("g");
  const left = node("l", g.id);
  const right = node("r", g.id);
  assert.deepEqual(
    ownerPinnedChainFromSet(g.id, [g, left, right], "file").map((event) => event.id),
    [],
  );
});

test("ownerPinnedChainFromSet fails closed when an owner head never reaches the traceId", () => {
  // A relay-crafted set where the head's backward walk lands on a traceId event
  // that is not a genesis (its prev is non-null). The genesis gate excludes it
  // from admitted, so the walk cannot complete and returns [].
  const aSeed = finalizeEvent({
    created_at: 1,
    kind: 4290,
    tags: [["z", "file"], ["e", "0".repeat(64), "", "prev"]],
    content: JSON.stringify({ snapshot: "a" }),
  }, OWNER_SECRET);
  const b = node("b", aSeed.id);
  // a claims to be descended from b, forming a -> b -> (aSeed, not in set).
  // The walk starts at b (the only head), reaches a, then aSeed which is
  // missing — fail closed.
  const a = finalizeEvent({
    created_at: 1,
    kind: 4290,
    tags: [["z", "file"], ["e", b.id, "", "prev"]],
    content: JSON.stringify({ snapshot: "a" }),
  }, OWNER_SECRET);
  assert.deepEqual(
    ownerPinnedChainFromSet(a.id, [a, b], "file"),
    [],
  );
});

test("ownerPinnedChainFromSet fails closed when an owner head's prev is missing", () => {
  // Owner-signed head references an event id that is not in the set. The walk
  // cannot reach the trace id, so the resolver returns [].
  const g = node("g");
  const orphan = node("orphan", "e".repeat(64));
  assert.deepEqual(
    ownerPinnedChainFromSet(orphan.id, [g, orphan], "file").map((event) => event.id),
    [],
  );
});

test("ownerPinnedChainFromSet fails closed when the head descends from a different genesis", () => {
  // The set contains a valid chain, but it descends from a genesis other than
  // the requested traceId. The walk reaches a non-traceId genesis (prev=null)
  // and returns [].
  const requestedGenesis = node("requested");
  const otherGenesis = node("other");
  const head = node("head", otherGenesis.id);
  assert.deepEqual(
    ownerPinnedChainFromSet(requestedGenesis.id, [otherGenesis, head], "file").map((event) => event.id),
    [],
  );
});

import test from "node:test";
import assert from "node:assert/strict";
import type { Event } from "nostr-tools";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";

import { hasVerifiedRevocationRequest, planTraceRevocation } from "./provenance.js";

function node(id: string, pubkey: string): Event {
  return {
    id,
    pubkey,
    kind: 4290,
    created_at: 1,
    tags: [["z", "file"]],
    content: JSON.stringify({ snapshot: "" }),
    sig: "",
  };
}

test("trace revocation requests only nodes owned by the signing key", () => {
  const plan = planTraceRevocation(
    "genesis",
    [node("genesis", "pen"), node("model-step", "model"), node("pen-step", "pen")],
    "pen",
  );

  assert.equal(plan.totalNodeCount, 3);
  assert.deepEqual(plan.requestedNodeIds, ["genesis", "pen-step"]);
  assert.deepEqual(plan.skippedNodeIds, ["model-step"]);
  assert.deepEqual(plan.tags, [
    ["e", "genesis", ""],
    ["e", "pen-step", ""],
    ["a", "34290:pen:genesis"],
  ]);
});

test("trace revocation still addresses the signer's TraceHead when no Steps are owned", () => {
  const plan = planTraceRevocation("genesis", [node("genesis", "another-voice")], "pen");
  assert.deepEqual(plan.requestedNodeIds, []);
  assert.deepEqual(plan.skippedNodeIds, ["genesis"]);
  assert.deepEqual(plan.tags, [["a", "34290:pen:genesis"]]);
});

test("revoked status requires a valid request signed by the cited event owner", () => {
  const ownerKey = new Uint8Array(32);
  ownerKey[31] = 1;
  const otherKey = new Uint8Array(32);
  otherKey[31] = 2;
  const nodeId = "cited-node";
  const request = finalizeEvent(
    {
      kind: 5,
      created_at: 1,
      tags: [["e", nodeId, ""]],
      content: "author request",
    },
    ownerKey,
  );
  const unrelated = finalizeEvent(
    {
      kind: 5,
      created_at: 1,
      tags: [["e", nodeId, ""]],
      content: "not the author",
    },
    otherKey,
  );

  assert.equal(
    hasVerifiedRevocationRequest(nodeId, getPublicKey(ownerKey), [unrelated, request]),
    true,
  );
  assert.equal(
    hasVerifiedRevocationRequest(nodeId, getPublicKey(otherKey), [request]),
    false,
  );
  assert.equal(
    hasVerifiedRevocationRequest(nodeId, getPublicKey(ownerKey), [
      {
        id: request.id,
        pubkey: request.pubkey,
        created_at: request.created_at,
        kind: request.kind,
        tags: request.tags,
        content: "tampered after signing",
        sig: request.sig,
      },
    ]),
    false,
  );
});

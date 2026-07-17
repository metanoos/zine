import assert from "node:assert/strict";
import test from "node:test";
import type { Event } from "nostr-tools";

import { folderOwnerFromNodes } from "./provenance.js";

function folderNode(
  id: string,
  pubkey: string,
  prev?: string,
): Event {
  return {
    id,
    pubkey,
    kind: 4290,
    created_at: 1,
    content: "{}",
    sig: "",
    tags: [
      ["z", "folder"],
      ...(prev ? [["e", prev, "", "prev"]] : []),
    ],
  };
}

test("folder ownership stays pinned to genesis when a later signer differs", () => {
  const genesis = folderNode("folder-genesis", "author-owner");
  const malformedHead = folderNode("later-node", "other-voice", genesis.id);

  assert.equal(
    folderOwnerFromNodes(genesis.id, [genesis, malformedHead]),
    "author-owner",
  );
});

test("a folder without its genesis event has no verifiable owner", () => {
  const first = folderNode("first-node", "owner");
  const head = folderNode("head-node", "owner", first.id);

  assert.equal(
    folderOwnerFromNodes("missing-genesis", [first, head]),
    null,
  );
});

test("an unavailable folder chain has no verifiable owner", () => {
  assert.equal(folderOwnerFromNodes("missing", []), null);
});

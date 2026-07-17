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

test("legacy UUID-keyed folders fall back to the current head signer", () => {
  const first = folderNode("first-node", "legacy-owner");
  const head = folderNode("head-node", "legacy-owner", first.id);

  assert.equal(
    folderOwnerFromNodes("legacy-folder-uuid", [first, head]),
    "legacy-owner",
  );
});

test("an unavailable folder chain has no verifiable owner", () => {
  assert.equal(folderOwnerFromNodes("missing", []), null);
});

import test from "node:test";
import assert from "node:assert/strict";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";

// @ts-expect-error minimal localStorage shim for signer-resolution coverage
globalThis.localStorage = {
  values: new Map<string, string>(),
  getItem(key: string) {
    return this.values.get(key) ?? null;
  },
  setItem(key: string, value: string) {
    this.values.set(key, value);
  },
  removeItem(key: string) {
    this.values.delete(key);
  },
  clear() {
    this.values.clear();
  },
};

import {
  completeDeletion,
  completeStagedWrite,
  folderWriteSigner,
  localFileSigner,
  ownershipDisposition,
  pendingMoveForPath,
  previousStepCitationTargets,
} from "./workspace-local.js";
import { authorVoice, loadKeys } from "./keys-store.js";

test("active to Oblivion retains the active relay coordinate", () => {
  assert.deepEqual(
    pendingMoveForPath("draft.md", "oblivion/stamp/draft.md"),
    { kind: "to-oblivion", fromPath: "draft.md" },
  );
});

test("rapid restore before Oblivion sync remains one move from the original path", () => {
  assert.deepEqual(
    pendingMoveForPath(
      "oblivion/stamp/draft.md",
      "restored/draft.md",
      { kind: "to-oblivion", fromPath: "draft.md" },
    ),
    { kind: "move", fromPath: "draft.md" },
  );
});

test("restore after a completed move to Oblivion extends from its local copy", () => {
  assert.deepEqual(
    pendingMoveForPath("oblivion/stamp/draft.md", "restored/draft.md"),
    { kind: "restore", fromPath: "oblivion/stamp/draft.md" },
  );
});

test("several active moves retain the first relay coordinate", () => {
  assert.deepEqual(
    pendingMoveForPath("notes/draft.md", "final/draft.md", {
      kind: "move",
      fromPath: "draft.md",
    }),
    { kind: "move", fromPath: "draft.md" },
  );
});

test("an explicit write returns the newly published checkpoint", async () => {
  let retried = false;
  const nodeId = await completeStagedWrite(
    async () => "new-node-id",
    () => {
      retried = true;
    },
  );

  assert.equal(nodeId, "new-node-id");
  assert.equal(retried, false);
});

test("a failed explicit write is surfaced and scheduled for retry", async () => {
  const failure = new Error("relay unavailable");
  let retries = 0;

  await assert.rejects(
    completeStagedWrite(
      async () => {
        throw failure;
      },
      () => {
        retries++;
      },
    ),
    failure,
  );
  assert.equal(retries, 1);
});

test("an unavailable prior Step reports the broken history instead of reading event.tags", () => {
  assert.throws(
    () => previousStepCitationTargets("notes/draft.md", "prior-node", []),
    /cannot load the previous Step for notes\/draft\.md at prior-node/,
  );
});

test("deletion removes local copies only after every tombstone lands", async () => {
  const order: string[] = [];
  await completeDeletion(
    ["a.md", "b.md"],
    async (path) => {
      order.push(`remote:${path}`);
    },
    (path) => {
      order.push(`local:${path}`);
    },
  );

  assert.deepEqual(order.slice(0, 2).sort(), ["remote:a.md", "remote:b.md"]);
  assert.deepEqual(order.slice(2), ["local:a.md", "local:b.md"]);
});

test("failed tombstones leave local copies intact for retry", async () => {
  const deleted: string[] = [];
  await assert.rejects(
    completeDeletion(
      ["a.md"],
      async () => {
        throw new Error("relay unavailable");
      },
      (path) => deleted.push(path),
    ),
    /relay unavailable/,
  );
  assert.deepEqual(deleted, []);
});

test("ownership disposition distinguishes owned, foreign, and unverifiable nodes", () => {
  assert.equal(ownershipDisposition("alice", "alice"), "owned");
  assert.equal(ownershipDisposition("bob", "alice"), "foreign");
  assert.equal(ownershipDisposition(null, "alice"), "unverifiable");
});

test("folder membership keeps using a different locally held keychain owner", () => {
  localStorage.clear();
  const keys = loadKeys();
  const folderOwner = keys[0]!;
  const fileOwner = keys[1]!;
  const fileSigner = localFileSigner(fileOwner.pubkey);

  assert.ok(fileSigner);
  const signer = folderWriteSigner(folderOwner.pubkey, fileSigner);
  assert.ok(signer);
  assert.equal(getPublicKey(signer), folderOwner.pubkey);
});

test("folder membership can recover the already-held legacy Root owner", () => {
  localStorage.clear();
  loadKeys();
  const legacySigner = generateSecretKey();
  const legacyPubkey = getPublicKey(legacySigner);
  localStorage.setItem(
    "zine.voice.secretHex",
    Array.from(legacySigner, (byte) => byte.toString(16).padStart(2, "0")).join(""),
  );
  const fileSigner = localFileSigner(authorVoice());

  assert.ok(fileSigner);
  const signer = folderWriteSigner(legacyPubkey, fileSigner);
  assert.ok(signer);
  assert.equal(getPublicKey(signer), legacyPubkey);
});

test("a genuinely foreign folder still fails closed", () => {
  localStorage.clear();
  const fileSigner = localFileSigner(authorVoice());
  const foreignOwner = getPublicKey(generateSecretKey());

  assert.ok(fileSigner);
  assert.equal(folderWriteSigner(foreignOwner, fileSigner), null);
});

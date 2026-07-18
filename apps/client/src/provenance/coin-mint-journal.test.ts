import assert from "node:assert/strict";
import test from "node:test";
import { finalizeEvent } from "nostr-tools/pure";

import {
  coinMintOperationKey,
  completePendingCoinMint,
  pendingCoinMint,
  preparePendingCoinMint,
} from "./coin-mint-journal.js";

const SECRET = Uint8Array.from([...new Uint8Array(31), 1]);

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    values,
  };
}

function coin(createdAt: number) {
  return finalizeEvent({
    kind: 4290,
    created_at: createdAt,
    tags: [["z", "file"], ["x", "a".repeat(64)]],
    content: JSON.stringify({
      snapshot: "coin",
      coin: { version: 1, origin: { kind: "direct" } },
    }),
  }, SECRET);
}

test("Mint resumes the exact signed pair after post-public and post-membership failures", async () => {
  const store = storage();
  const signedCoin = coin(1);
  const key = coinMintOperationKey({
    sourceFolderId: "source",
    signerPubkey: signedCoin.pubkey,
    phrase: "coin",
    origin: { kind: "direct" },
  });
  let creates = 0;
  const create = async () => {
    creates++;
    return {
      sourceFolderId: "source",
      mintFolderId: "mint",
      localPath: "mint/coin.md",
      memberName: "coin.md",
      phrase: "coin",
      coin: signedCoin,
    };
  };

  const first = await preparePendingCoinMint(key, create, store, 10);
  await assert.rejects(
    completePendingCoinMint(first, {
      publishPair: async (event) => ({ eventId: event.id }),
      persistMembership: async () => {
        throw new Error("manifest unavailable");
      },
      persistLocal: () => undefined,
    }, store),
    /manifest unavailable/,
  );
  assert.equal(pendingCoinMint(key, store)?.coin.id, signedCoin.id);

  const second = await preparePendingCoinMint(key, create, store, 20);
  assert.equal(second.coin.id, signedCoin.id);
  assert.equal(creates, 1);
  await assert.rejects(
    completePendingCoinMint(second, {
      publishPair: async (event) => ({ eventId: event.id }),
      persistMembership: async () => undefined,
      persistLocal: () => {
        throw new Error("local inventory unavailable");
      },
    }, store),
    /local inventory unavailable/,
  );
  assert.equal(pendingCoinMint(key, store)?.coin.id, signedCoin.id);

  const third = await preparePendingCoinMint(key, create, store, 30);
  const attestation = await completePendingCoinMint(third, {
    publishPair: async (event) => ({ eventId: event.id }),
    persistMembership: async () => undefined,
    persistLocal: () => undefined,
  }, store);
  assert.deepEqual(attestation, { eventId: signedCoin.id });
  assert.equal(pendingCoinMint(key, store), null);
  assert.equal(creates, 1);
});

test("Mint journal rejects corrupt data instead of creating a sibling pair", async () => {
  const store = storage();
  store.values.set("zine.pending-coin-mints.v1", "not-json");
  await assert.rejects(
    preparePendingCoinMint("operation", async () => {
      throw new Error("must not create");
    }, store),
    /corrupt JSON/,
  );
});

test("concurrent preparation cannot create sibling Coin events for one gesture", async () => {
  const store = storage();
  const key = "same-gesture";
  let creates = 0;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const create = async () => {
    creates++;
    await blocked;
    return {
      sourceFolderId: "source",
      mintFolderId: "mint",
      localPath: "mint/coin.md",
      memberName: "coin.md",
      phrase: "coin",
      coin: coin(creates),
    };
  };
  const first = preparePendingCoinMint(key, create, store, 10);
  const second = preparePendingCoinMint(key, create, store, 20);
  release();
  const [left, right] = await Promise.all([first, second]);
  assert.equal(left.coin.id, right.coin.id);
  assert.equal(creates, 1);
});

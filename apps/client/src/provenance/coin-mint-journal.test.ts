import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { finalizeEvent } from "nostr-tools/pure";

import {
  activateVaultStorage,
  deactivateVaultStorage,
} from "../storage/vault-storage.js";

import {
  coinMintOperationKey,
  completePendingCoinMint,
  pendingCoinMint,
  preparePendingCoinMint,
} from "./coin-mint-journal.js";

const SECRET = Uint8Array.from([...new Uint8Array(31), 1]);
const VAULT_KEY_A = new Uint8Array(32).fill(0x51);
const VAULT_KEY_B = new Uint8Array(32).fill(0x52);
const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");

class FakeStorage implements Storage {
  private values = new Map<string, string>();

  get length(): number { return this.values.size; }
  clear(): void { this.values.clear(); }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string): void { this.values.delete(key); }
  setItem(key: string, value: string): void { this.values.set(key, String(value)); }
}

function installLocalStorage(value: Storage): void {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value,
    writable: true,
  });
}

afterEach(() => {
  deactivateVaultStorage();
  if (originalLocalStorage) {
    Object.defineProperty(globalThis, "localStorage", originalLocalStorage);
  } else {
    Reflect.deleteProperty(globalThis, "localStorage");
  }
});

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

function pendingContents(createdAt: number, phrase = `coin-${createdAt}`) {
  return {
    sourceFolderId: "source",
    mintFolderId: "mint",
    localPath: `mint/${phrase}.md`,
    memberName: `${phrase}.md`,
    phrase,
    coin: coin(createdAt),
  };
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

test("pending Mint records resume independently in vaults A and B", async () => {
  installLocalStorage(new FakeStorage());
  activateVaultStorage("vault-a", VAULT_KEY_A);
  const pendingA = await preparePendingCoinMint(
    "same-gesture",
    async () => pendingContents(100, "vault-a-coin"),
    undefined,
    10,
  );

  activateVaultStorage("vault-b", VAULT_KEY_B);
  assert.equal(pendingCoinMint("same-gesture"), null);
  const pendingB = await preparePendingCoinMint(
    "same-gesture",
    async () => pendingContents(200, "vault-b-coin"),
    undefined,
    20,
  );
  assert.notEqual(pendingA.coin.id, pendingB.coin.id);

  activateVaultStorage("vault-a", VAULT_KEY_A);
  assert.equal(pendingCoinMint("same-gesture")?.coin.id, pendingA.coin.id);
  let recreated = false;
  const resumedA = await preparePendingCoinMint("same-gesture", async () => {
    recreated = true;
    return pendingContents(300);
  });
  assert.equal(resumedA.coin.id, pendingA.coin.id);
  assert.equal(recreated, false);

  activateVaultStorage("vault-b", VAULT_KEY_B);
  assert.equal(pendingCoinMint("same-gesture")?.coin.id, pendingB.coin.id);
});

test("pending Mint capacity is enforced per vault", async () => {
  installLocalStorage(new FakeStorage());
  activateVaultStorage("vault-a", VAULT_KEY_A);

  for (let index = 0; index < 32; index++) {
    await preparePendingCoinMint(
      `vault-a-${index}`,
      async () => pendingContents(1_000 + index),
    );
  }
  await assert.rejects(
    preparePendingCoinMint("vault-a-over-capacity", async () => pendingContents(2_000)),
    /too many incomplete Mint gestures \(32\)/,
  );

  activateVaultStorage("vault-b", VAULT_KEY_B);
  const pendingB = await preparePendingCoinMint(
    "vault-b-first",
    async () => pendingContents(3_000),
  );
  assert.equal(pendingCoinMint("vault-b-first")?.coin.id, pendingB.coin.id);
});

test("a Mint created after vault A loses its lease is never journaled in vault B", async () => {
  installLocalStorage(new FakeStorage());
  activateVaultStorage("vault-a", VAULT_KEY_A);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let creationStarted!: () => void;
  const started = new Promise<void>((resolve) => { creationStarted = resolve; });

  const preparing = preparePendingCoinMint("delayed-vault-a", async () => {
    creationStarted();
    await gate;
    return pendingContents(4_000);
  });
  await started;
  const rejected = assert.rejects(preparing, /active vault changed/);
  activateVaultStorage("vault-b", VAULT_KEY_B);
  release();
  await rejected;

  assert.equal(pendingCoinMint("delayed-vault-a"), null);
});

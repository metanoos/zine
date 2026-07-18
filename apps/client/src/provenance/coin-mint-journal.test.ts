import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { finalizeEvent } from "nostr-tools/pure";

import {
  activateVaultStorage,
  deactivateVaultStorage,
  fenceVaultStorageSession,
} from "../storage/vault-storage.js";

import {
  coinMintOperationKey,
  completePendingCoinMint,
  pendingCoinMints,
  pendingCoinMint,
  preparePendingCoinMint,
  resumePendingCoinMints,
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

test("the pre-lock fence rejects newly submitted Mint work", async () => {
  installLocalStorage(new FakeStorage());
  activateVaultStorage("vault-a", VAULT_KEY_A);
  const durable = await preparePendingCoinMint(
    "durable-before-fence",
    async () => pendingContents(3_500),
  );
  let created = false;
  let published = false;

  fenceVaultStorageSession();
  await assert.rejects(
    preparePendingCoinMint("after-fence", async () => {
      created = true;
      return pendingContents(3_501);
    }),
    /active vault changed/,
  );
  await assert.rejects(
    completePendingCoinMint(durable, {
      publishPair: async () => {
        published = true;
        return "attestation";
      },
      persistMembership: async () => undefined,
      persistLocal: () => undefined,
    }),
    /active vault changed/,
  );
  await assert.rejects(
    resumePendingCoinMints(() => ({
      publishPair: async () => "attestation",
      persistMembership: async () => undefined,
      persistLocal: () => undefined,
    })),
    /active vault changed/,
  );
  assert.equal(created, false);
  assert.equal(published, false);
  assert.equal(pendingCoinMint("durable-before-fence")?.coin.id, durable.coin.id);
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
  const pendingB = await preparePendingCoinMint(
    "vault-b-does-not-wait",
    async () => pendingContents(4_001),
  );
  release();
  await rejected;

  assert.equal(pendingCoinMint("delayed-vault-a"), null);
  assert.equal(pendingCoinMint("vault-b-does-not-wait")?.coin.id, pendingB.coin.id);
});

test("pending Mint recovery resumes every durable record without recreating Coins", async () => {
  const store = storage();
  const records = [coin(11), coin(12)];
  for (const [index, signedCoin] of records.entries()) {
    await preparePendingCoinMint(`operation-${index}`, async () => ({
      sourceFolderId: "source",
      mintFolderId: "mint",
      localPath: `mint/coin-${index}.md`,
      memberName: `coin-${index}.md`,
      phrase: "coin",
      coin: signedCoin,
    }), store, index);
  }
  const published: string[] = [];
  const result = await resumePendingCoinMints(
    () => ({
      publishPair: async (event) => {
        published.push(event.id);
        return event.id;
      },
      persistMembership: async () => undefined,
      persistLocal: () => undefined,
    }),
    store,
  );

  assert.deepEqual(published, records.map((event) => event.id));
  assert.deepEqual(result, { completed: 2, remaining: 0, failures: [] });
  assert.deepEqual(pendingCoinMints(store), []);
});

test("pending Mint recovery leaves a failed record available for the next pass", async () => {
  const store = storage();
  const signedCoin = coin(13);
  await preparePendingCoinMint("operation", async () => ({
    sourceFolderId: "source",
    mintFolderId: "mint",
    localPath: "mint/coin.md",
    memberName: "coin.md",
    phrase: "coin",
    coin: signedCoin,
  }), store, 1);

  const result = await resumePendingCoinMints(
    () => ({
      publishPair: async () => {
        throw new Error("offline");
      },
      persistMembership: async () => undefined,
      persistLocal: () => undefined,
    }),
    store,
  );

  assert.equal(result.completed, 0);
  assert.equal(result.remaining, 1);
  assert.match(result.failures[0]?.error ?? "", /offline/);
  assert.equal(pendingCoinMints(store)[0]?.coin.id, signedCoin.id);
});

test("journal-wide preparation enforces capacity across distinct concurrent gestures", async () => {
  const store = storage();
  for (let index = 0; index < 31; index++) {
    await preparePendingCoinMint(
      `existing-${index}`,
      async () => pendingContents(5_000 + index),
      store,
    );
  }
  let creates = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const first = preparePendingCoinMint("first-new", async () => {
    creates++;
    await gate;
    return pendingContents(6_000);
  }, store);
  const second = preparePendingCoinMint("second-new", async () => {
    creates++;
    return pendingContents(6_001);
  }, store);
  release();

  await first;
  await assert.rejects(second, /too many incomplete Mint gestures \(32\)/);
  assert.equal(creates, 1);
  assert.equal(pendingCoinMints(store).length, 32);
});

test("same-vault completion coalesces one public transaction", async () => {
  const store = storage();
  const pending = await preparePendingCoinMint(
    "coalesced",
    async () => pendingContents(7_000),
    store,
  );
  let publishes = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const completion = {
    publishPair: async () => {
      publishes++;
      await gate;
      return "attestation";
    },
    persistMembership: async () => undefined,
    persistLocal: () => undefined,
  };

  const first = completePendingCoinMint(pending, completion, store);
  const second = completePendingCoinMint(pending, completion, store);
  release();
  assert.deepEqual(await Promise.all([first, second]), ["attestation", "attestation"]);
  assert.equal(publishes, 1);
  assert.equal(pendingCoinMint("coalesced", store), null);
});

test("vault B completion does not coalesce with an in-flight vault A gesture", async () => {
  installLocalStorage(new FakeStorage());
  activateVaultStorage("vault-a", VAULT_KEY_A);
  const pendingA = await preparePendingCoinMint(
    "same-operation",
    async () => pendingContents(8_000, "vault-a"),
  );
  let releaseA!: () => void;
  const gateA = new Promise<void>((resolve) => { releaseA = resolve; });
  let startedA!: () => void;
  const publishedA = new Promise<void>((resolve) => { startedA = resolve; });
  const completingA = completePendingCoinMint(pendingA, {
    publishPair: async () => {
      startedA();
      await gateA;
      return "attestation-a";
    },
    persistMembership: async () => undefined,
    persistLocal: () => undefined,
  });
  await publishedA;
  const rejectedA = assert.rejects(completingA, /active vault changed/);

  activateVaultStorage("vault-b", VAULT_KEY_B);
  const pendingB = await preparePendingCoinMint(
    "same-operation",
    async () => pendingContents(8_001, "vault-b"),
  );
  let publishesB = 0;
  const completedB = await completePendingCoinMint(pendingB, {
    publishPair: async () => {
      publishesB++;
      return "attestation-b";
    },
    persistMembership: async () => undefined,
    persistLocal: () => undefined,
  });
  assert.equal(completedB, "attestation-b");
  assert.equal(publishesB, 1);
  assert.equal(pendingCoinMint("same-operation"), null);

  releaseA();
  await rejectedA;
  activateVaultStorage("vault-a", VAULT_KEY_A);
  assert.equal(pendingCoinMint("same-operation")?.coin.id, pendingA.coin.id);
});

test("recovery aborts on a vault switch without reading vault B as its remaining set", async () => {
  installLocalStorage(new FakeStorage());
  activateVaultStorage("vault-a", VAULT_KEY_A);
  await preparePendingCoinMint("vault-a-recovery", async () => pendingContents(9_000));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let started!: () => void;
  const published = new Promise<void>((resolve) => { started = resolve; });
  const recovery = resumePendingCoinMints(() => ({
    publishPair: async () => {
      started();
      await gate;
      return "attestation-a";
    },
    persistMembership: async () => undefined,
    persistLocal: () => undefined,
  }));
  await published;
  const rejected = assert.rejects(recovery, /active vault changed/);

  activateVaultStorage("vault-b", VAULT_KEY_B);
  const pendingB = await preparePendingCoinMint(
    "vault-b-pending",
    async () => pendingContents(9_001),
  );
  release();
  await rejected;

  assert.equal(pendingCoinMint("vault-b-pending")?.coin.id, pendingB.coin.id);
});

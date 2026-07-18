import assert from "node:assert/strict";
import test from "node:test";

import {
  MemorySecretStore,
  closeSecretSession,
  deleteSecret,
  getSecretCached,
  initializeBrowserReadOnlySecretSession,
  isSecretSessionUnlocked,
  listSecretRefs,
  putSecret,
  putSecrets,
  secretSessionCapabilities,
  unlockSecretSession,
} from "./secret-store.js";

test("memory store copies values and lists stable references", async () => {
  const store = new MemorySecretStore();
  const input = new Uint8Array([1, 2, 3]);
  await store.set("key:b", input);
  input.fill(9);
  await store.set("key:a", new Uint8Array([4]));
  assert.deepEqual(await store.get("key:b"), new Uint8Array([1, 2, 3]));
  assert.deepEqual(await store.listRefs(), ["key:a", "key:b"]);
});

test("session writes are read-back verified and deletion clears resolution", async () => {
  const store = new MemorySecretStore({ persistent: true, signing: true, model: true });
  await unlockSecretSession(store);
  await putSecret("voice:1", new Uint8Array([7, 8]));
  assert.deepEqual(getSecretCached("voice:1"), new Uint8Array([7, 8]));
  assert.deepEqual(await listSecretRefs(), ["voice:1"]);
  await deleteSecret("voice:1");
  assert.equal(getSecretCached("voice:1"), null);
});

test("session batch writes use one durable store mutation and verify every value", async () => {
  class BatchStore extends MemorySecretStore {
    batches = 0;

    override async setMany(entries: ReadonlyArray<readonly [string, Uint8Array]>): Promise<void> {
      this.batches += 1;
      await super.setMany(entries);
    }
  }

  const store = new BatchStore({ persistent: true, signing: true, model: true });
  await unlockSecretSession(store);
  await putSecrets([
    ["voice:1", new Uint8Array([1, 2])],
    ["voice:2", new Uint8Array([3, 4])],
  ]);

  assert.equal(store.batches, 1);
  assert.deepEqual(getSecretCached("voice:1"), new Uint8Array([1, 2]));
  assert.deepEqual(getSecretCached("voice:2"), new Uint8Array([3, 4]));
});

test("closing a secret session releases its backend and clears cached material", async () => {
  class CloseableStore extends MemorySecretStore {
    closed = false;

    async close(): Promise<void> {
      this.closed = true;
    }
  }

  const store = new CloseableStore({ persistent: true, signing: true, model: true });
  await unlockSecretSession(store);
  await putSecret("voice:closing", new Uint8Array([9, 8, 7]));
  await closeSecretSession();

  assert.equal(store.closed, true);
  assert.equal(isSecretSessionUnlocked(), false);
  assert.equal(getSecretCached("voice:closing"), null);
  await assert.rejects(putSecret("voice:after-close", new Uint8Array([1])), /locked/);

  await unlockSecretSession(new MemorySecretStore());
});

test("a backend close failure still locks the JavaScript secret session", async () => {
  class FailingCloseStore extends MemorySecretStore {
    attempts = 0;

    async close(): Promise<void> {
      this.attempts += 1;
      if (this.attempts === 1) throw new Error("native unload failed");
    }
  }

  const store = new FailingCloseStore({ persistent: true, signing: true, model: true });
  await unlockSecretSession(store);
  await putSecret("voice:must-clear", new Uint8Array([4, 2]));

  await assert.rejects(closeSecretSession(), /native unload failed/);
  assert.equal(isSecretSessionUnlocked(), false);
  assert.equal(getSecretCached("voice:must-clear"), null);
  await assert.rejects(putSecret("voice:after-failure", new Uint8Array([1])), /locked/);
  await assert.rejects(
    unlockSecretSession(new MemorySecretStore()),
    /Finish locking the current vault/,
  );

  await closeSecretSession();
  assert.equal(store.attempts, 2);
  await unlockSecretSession(new MemorySecretStore());
});

test("browser session is explicitly non-authoring and non-persistent", async () => {
  await initializeBrowserReadOnlySecretSession();
  assert.deepEqual(secretSessionCapabilities(), {
    persistent: false,
    signing: false,
    model: false,
  });
  await assert.rejects(
    putSecret("must-not-land", new Uint8Array([1])),
    /read-only/,
  );
  // Leave the process-wide session in its normal Node test posture for any
  // later tests sharing this worker.
  await unlockSecretSession(new MemorySecretStore());
});

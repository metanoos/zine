import assert from "node:assert/strict";
import test from "node:test";

import {
  MemorySecretStore,
  deleteSecret,
  getSecretCached,
  initializeBrowserReadOnlySecretSession,
  listSecretRefs,
  putSecret,
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

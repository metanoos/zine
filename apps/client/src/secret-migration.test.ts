import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { getPublicKey } from "nostr-tools/pure";

const values = new Map<string, string>();
// @ts-expect-error migration-only localStorage shim
globalThis.localStorage = {
  getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => void values.set(key, value),
  removeItem: (key: string) => void values.delete(key),
};

import { initializeKeyStoreForAuthoring } from "./keys-store.js";
import {
  MemorySecretStore,
  getSecretCached,
  listSecretRefs,
  unlockSecretSession,
  type SecretStoreCapabilities,
} from "./secret-store.js";
import { JOURNAL_STORAGE, migrateLegacySecrets } from "./secret-migration.js";

const secretHex = "11".repeat(32);
const pubkey = getPublicKey(new Uint8Array(32).fill(0x11));

beforeEach(async () => {
  values.clear();
  await unlockSecretSession(new MemorySecretStore({
    persistent: true,
    signing: true,
    model: true,
  }));
});

test("fresh authoring bootstrap persists all starter keys in one vault batch", async () => {
  class CountingStore extends MemorySecretStore {
    batches = 0;

    override async setMany(entries: ReadonlyArray<readonly [string, Uint8Array]>): Promise<void> {
      this.batches += 1;
      await super.setMany(entries);
    }
  }

  const store = new CountingStore({ persistent: true, signing: true, model: true });
  await unlockSecretSession(store);
  const keys = await initializeKeyStoreForAuthoring();

  assert.equal(store.batches, 1);
  assert.equal(keys.length, 7);
  assert.equal((await listSecretRefs()).length, 7);
});

test("fresh vault retires dangling secure profiles before minting starter keys", async () => {
  const staleKeys = JSON.stringify([{
    id: "voice-a",
    label: "voice-1",
    secretRef: "nostr:key:voice-a",
    pubkey,
    identity: { font: '"Newsreader", serif', hue: 100, sat: 45 },
    createdAt: 1,
    schemaVersion: 1,
  }]);
  values.set("zine.keys", staleKeys);
  values.set("zine.roles.author", "voice-a");
  values.set("zine.roles.model", "voice-a");
  values.set("zine.roles.node", "voice-a");
  values.set("zine.models", JSON.stringify([{
    id: "provider-a",
    label: "Provider",
    protocol: "openai",
    baseUrl: "https://example.test/v1",
    modelId: "model-a",
    credentialRef: "model:provider:provider-a:api-key",
    credentialConfigured: true,
  }]));

  await assert.rejects(
    initializeKeyStoreForAuthoring(),
    /Secure key material is unavailable for voice-1/,
  );

  const result = await migrateLegacySecrets({ freshVault: true });
  const keys = await initializeKeyStoreForAuthoring();
  const keyIds = new Set(keys.map((key) => key.id));
  const providers = JSON.parse(values.get("zine.models")!) as Array<{
    credentialConfigured: boolean;
  }>;

  assert.equal(result.changed, true);
  assert.equal(keys.length, 7);
  assert.equal(keys.some((key) => key.id === "voice-a"), false);
  assert.equal(providers[0]?.credentialConfigured, false);
  assert.equal((await listSecretRefs()).length, 7);
  assert.equal(keyIds.has(values.get("zine.roles.author")!), true);
  assert.equal(keyIds.has(values.get("zine.roles.model")!), true);
  assert.equal(keyIds.has(values.get("zine.roles.node")!), true);
});

test("legacy profiles migrate into the vault and pass authoring bootstrap without reset", async () => {
  values.set("zine.keys", JSON.stringify([{
    id: "voice-a",
    label: "voice-1",
    secretHex,
    pubkey,
    identity: { font: '"Newsreader", serif', hue: 100, sat: 45 },
    createdAt: 1,
  }]));
  values.set("zine.roles.pen", "voice-a");
  values.set("zine.roles.inject", "voice-a");
  values.set("zine.models", JSON.stringify([{
    id: "provider-a",
    label: "Provider",
    protocol: "openai",
    baseUrl: "https://example.test/v1",
    modelId: "model-a",
    apiKey: "sk-private",
  }]));

  const result = await migrateLegacySecrets({ freshVault: true });
  const keys = await initializeKeyStoreForAuthoring();

  assert.equal(result.changed, true);
  assert.equal(keys[0]?.id, "voice-a");
  assert.equal(keys[0]?.schemaVersion, 1);
  const storedKeys = values.get("zine.keys")!;
  const storedModels = values.get("zine.models")!;
  assert.doesNotMatch(storedKeys, /secretHex|11111111/);
  assert.doesNotMatch(storedModels, /apiKey|sk-private/);
  assert.equal(values.get("zine.roles.author"), "voice-a");
  assert.equal(values.get("zine.roles.model"), "voice-a");
  assert.equal(values.get("zine.roles.node"), "voice-a");
  assert.equal(values.has("zine.roles.pen"), false);
  assert.equal(values.has("zine.roles.inject"), false);
  assert.deepEqual(getSecretCached("nostr:key:voice-a"), new Uint8Array(32).fill(0x11));
  assert.equal(
    new TextDecoder().decode(getSecretCached("model:provider:provider-a:api-key")!),
    "sk-private",
  );
});

test("a public voice-1 profile claims its matching pre-keychain secret", async () => {
  values.set("zine.voice.secretHex", secretHex);
  values.set("zine.keys", JSON.stringify([{
    id: "voice-a",
    label: "voice-1",
    pubkey,
    identity: { font: '"Newsreader", serif', hue: 100, sat: 45 },
    createdAt: 1,
    schemaVersion: 1,
  }]));

  await migrateLegacySecrets();
  const keys = await initializeKeyStoreForAuthoring();

  assert.equal(keys[0]?.id, "voice-a");
  assert.equal(keys[0]?.secretRef, "nostr:key:voice-a");
  assert.deepEqual(getSecretCached("nostr:key:voice-a"), new Uint8Array(32).fill(0x11));
  assert.equal(values.has("zine.voice.secretHex"), false);
});

test("the pre-keychain secret cannot attach to a different public profile", async () => {
  const original = JSON.stringify([{
    id: "voice-a",
    label: "voice-1",
    pubkey: "a".repeat(64),
    identity: { font: '"Newsreader", serif', hue: 100, sat: 45 },
    createdAt: 1,
    schemaVersion: 1,
  }]);
  values.set("zine.voice.secretHex", secretHex);
  values.set("zine.keys", original);

  await assert.rejects(migrateLegacySecrets(), /has no secure reference/);
  assert.equal(values.get("zine.keys"), original);
  assert.equal(getSecretCached("nostr:key:voice-a"), null);
});

test("a vault failure restores exact plaintext profiles and leaves a secret-free retry journal", async () => {
  class FailingStore extends MemorySecretStore {
    writes = 0;
    override async set(ref: string, value: Uint8Array): Promise<void> {
      this.writes += 1;
      if (this.writes === 2) throw new Error("injected vault failure");
      await super.set(ref, value);
    }
  }
  const caps: SecretStoreCapabilities = { persistent: true, signing: true, model: true };
  await unlockSecretSession(new FailingStore(caps));
  const originalKeys = JSON.stringify([{
    id: "voice-a", label: "voice-1", secretHex, pubkey,
    identity: { font: '"Newsreader", serif', hue: 100, sat: 45 }, createdAt: 1,
  }]);
  const originalModels = JSON.stringify([{
    id: "provider-a", label: "Provider", protocol: "openai",
    baseUrl: "x", modelId: "m", apiKey: "sk-private",
  }]);
  values.set("zine.keys", originalKeys);
  values.set("zine.models", originalModels);

  await assert.rejects(migrateLegacySecrets(), /injected vault failure/);
  assert.equal(values.get("zine.keys"), originalKeys);
  assert.equal(values.get("zine.models"), originalModels);
  const retry = values.get(JOURNAL_STORAGE)!;
  assert.match(retry, /failed/);
  assert.doesNotMatch(retry, /sk-private|11111111/);
});

test("mismatched public and private key material is rejected without rewriting profiles", async () => {
  const original = JSON.stringify([{
    id: "voice-a",
    label: "voice-1",
    secretHex,
    pubkey: "a".repeat(64),
    identity: { font: '"Newsreader", serif', hue: 100, sat: 45 },
    createdAt: 1,
    schemaVersion: 1,
  }]);
  values.set("zine.keys", original);

  await assert.rejects(migrateLegacySecrets(), /does not match its signing key/);
  assert.equal(values.get("zine.keys"), original);
  assert.equal(getSecretCached("nostr:key:voice-a"), null);
});

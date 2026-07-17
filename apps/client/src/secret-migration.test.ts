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

import {
  MemorySecretStore,
  getSecretCached,
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

test("plaintext key and provider secrets move only after verified vault writes", async () => {
  values.set("zine.keys", JSON.stringify([{
    id: "voice-a",
    label: "voice-1",
    secretHex,
    pubkey,
    identity: { font: '"Newsreader", serif', hue: 100, sat: 45 },
    createdAt: 1,
    schemaVersion: 1,
  }]));
  values.set("zine.voice.secretHex", secretHex);
  values.set("zine.models", JSON.stringify([{
    id: "provider-a",
    label: "Provider",
    protocol: "openai",
    baseUrl: "https://example.test/v1",
    modelId: "model-a",
    apiKey: "sk-private",
  }]));

  const result = await migrateLegacySecrets();
  assert.equal(result.changed, true);
  const storedKeys = values.get("zine.keys")!;
  const storedModels = values.get("zine.models")!;
  assert.doesNotMatch(storedKeys, /secretHex|11111111/);
  assert.doesNotMatch(storedModels, /apiKey|sk-private/);
  assert.equal(values.has("zine.voice.secretHex"), false);
  assert.deepEqual(getSecretCached("nostr:key:voice-a"), new Uint8Array(32).fill(0x11));
  assert.equal(
    new TextDecoder().decode(getSecretCached("model:provider:provider-a:api-key")!),
    "sk-private",
  );
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

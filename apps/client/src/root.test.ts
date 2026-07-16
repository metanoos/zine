import test from "node:test";
import assert from "node:assert/strict";

// @ts-expect-error minimal localStorage shim for Root's factory preload
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

import { loadLocalFolder, saveLocalFile } from "./local-store.js";
import { buildDirectoryTree } from "./tree-model.js";
import { authorVoice, getModelKeyId, loadKeys } from "./keys-store.js";
import {
  FACTORY_ROOT_FILE_CONTENT,
  FACTORY_ROOT_FILE_PATH,
  preloadFactoryRoot,
} from "./root.js";

test("preloadFactoryRoot adds the wokspace starter document", () => {
  localStorage.clear();
  preloadFactoryRoot("root-1");

  const file = loadLocalFolder("root-1")?.files[FACTORY_ROOT_FILE_PATH];
  assert.equal(FACTORY_ROOT_FILE_PATH, "wokspace/ayoo-world.md");
  assert.equal(file?.content, FACTORY_ROOT_FILE_CONTENT);
  assert.equal(file?.content, "ayoooo, world!\n\n");
  assert.equal(file?.content.endsWith("\n\n"), true);
  assert.equal(file?.nodeId, "");
  assert.ok(file?.voicePubkey);
  assert.notEqual(file?.voicePubkey, authorVoice());
  const starterVoice = loadKeys().find((key) => key.pubkey === file?.voicePubkey);
  assert.equal(starterVoice?.label, "voice-2");
  assert.notEqual(starterVoice?.id, getModelKeyId());
  assert.deepEqual(file?.runs, [
    { voice: file?.voicePubkey, text: FACTORY_ROOT_FILE_CONTENT },
  ]);

  const [root] = buildDirectoryTree(
    [{ path: FACTORY_ROOT_FILE_PATH, type: "file" }],
    "root",
  );
  assert.equal(root.children?.[0]?.name, "wokspace");
  assert.equal(root.children?.[0]?.children?.[0]?.name, "ayoo-world.md");
});

test("preloadFactoryRoot never overwrites an existing starter path", () => {
  localStorage.clear();
  saveLocalFile("root-2", FACTORY_ROOT_FILE_PATH, {
    content: "my draft",
    tags: ["personal"],
    nodeId: "existing-node",
  });

  preloadFactoryRoot("root-2");

  const file = loadLocalFolder("root-2")?.files[FACTORY_ROOT_FILE_PATH];
  assert.equal(file?.content, "my draft");
  assert.deepEqual(file?.tags, ["personal"]);
  assert.equal(file?.nodeId, "existing-node");
});

test("preloadFactoryRoot creates a non-Author voice for a legacy single-key profile", () => {
  localStorage.clear();
  localStorage.setItem("zine.voice.secretHex", "11".repeat(32));

  preloadFactoryRoot("root-legacy");

  const file = loadLocalFolder("root-legacy")?.files[FACTORY_ROOT_FILE_PATH];
  assert.ok(file?.voicePubkey);
  assert.notEqual(file?.voicePubkey, authorVoice());
});

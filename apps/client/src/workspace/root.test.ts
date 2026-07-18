import assert from "node:assert/strict";
import test from "node:test";

// @ts-expect-error minimal localStorage shim for Root and onboarding demo state
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
import { authorVoice, getModelKeyId, loadKeys } from "../identity/keys-store.js";
import { getPublicKey } from "nostr-tools/pure";
import { createRootMinter, getScanFolderId, rootAuthorSigner } from "./root.js";
import {
  loadOnboardingDemo,
  ONBOARDING_DEMO_FILE_CONTENT,
  ONBOARDING_DEMO_FILE_PATH,
} from "../app/onboarding-demo.js";

test("concurrent first-Root callers share one genesis publication", async () => {
  let creates = 0;
  let stored: string | null = null;
  let resolveGenesis!: (id: string) => void;
  const genesis = new Promise<string>((resolve) => { resolveGenesis = resolve; });
  const mint = createRootMinter({
    scope: () => "vault-a",
    existing: () => stored,
    async create() {
      creates += 1;
      return genesis;
    },
    persist(id) { stored = id; },
  });

  const first = mint();
  const strictModeReplay = mint();
  assert.equal(creates, 1);
  resolveGenesis("root-genesis");
  assert.equal(await first, "root-genesis");
  assert.equal(await strictModeReplay, "root-genesis");
  assert.equal(stored, "root-genesis");
  assert.equal(await mint(), "root-genesis");
  assert.equal(creates, 1);
});

test("failed Root creation clears the pending attempt for retry", async () => {
  let attempts = 0;
  const mint = createRootMinter({
    scope: () => "vault-a",
    existing: () => null,
    async create() {
      attempts += 1;
      if (attempts === 1) throw new Error("relay unavailable");
      return "root-after-retry";
    },
    persist() {},
  });

  await assert.rejects(mint(), /relay unavailable/);
  assert.equal(await mint(), "root-after-retry");
  assert.equal(attempts, 2);
});

test("a pending Root publication cannot cross a vault switch", async () => {
  let activeScope = "vault-a";
  const stored = new Map<string, string>();
  let resolveFirst!: (id: string) => void;
  const firstGenesis = new Promise<string>((resolve) => { resolveFirst = resolve; });
  const creates: string[] = [];
  const mint = createRootMinter({
    scope: () => activeScope,
    existing: () => stored.get(activeScope) ?? null,
    create: async () => {
      creates.push(activeScope);
      return activeScope === "vault-a" ? firstGenesis : "root-b";
    },
    persist(id) { stored.set(activeScope, id); },
  });

  const first = mint();
  activeScope = "vault-b";
  assert.equal(await mint(), "root-b");
  resolveFirst("root-a");
  await assert.rejects(first, /active vault changed/);

  assert.deepEqual(creates, ["vault-a", "vault-b"]);
  assert.equal(stored.get("vault-a"), undefined);
  assert.equal(stored.get("vault-b"), "root-b");
});

test("a fresh Root genesis uses the AUTHOR signing key", () => {
  localStorage.clear();
  assert.equal(getPublicKey(rootAuthorSigner()), authorVoice());
});

test("Scan keeps a per-Root local pointer separate from Root identity", () => {
  localStorage.clear();
  localStorage.setItem("zine.scan.root-a", "scan-folder-a");
  assert.equal(getScanFolderId("root-a"), "scan-folder-a");
  assert.equal(getScanFolderId("root-b"), null);
});

test("loadOnboardingDemo keeps AUTHOR ownership and spare-voice prose attribution", async () => {
  localStorage.clear();
  const demo = await loadOnboardingDemo("root-1");

  const file = loadLocalFolder("root-1")?.files[ONBOARDING_DEMO_FILE_PATH];
  assert.equal(demo.path, ONBOARDING_DEMO_FILE_PATH);
  assert.equal(ONBOARDING_DEMO_FILE_PATH, "hello-world.md");
  assert.equal(file?.content, ONBOARDING_DEMO_FILE_CONTENT);
  assert.equal(file?.content, "# Ayooo, world!\n\nThis is my first trace.\n");
  assert.equal(file?.content.endsWith("\n"), true);
  assert.equal(file?.nodeId, "");
  assert.equal(file?.pendingEmptyGenesis, true);
  assert.equal(file?.voicePubkey, authorVoice());
  const attributedVoice = file?.runs?.[0]?.voice;
  assert.ok(attributedVoice);
  assert.notEqual(attributedVoice, authorVoice());
  const starterVoice = loadKeys().find((key) => key.pubkey === attributedVoice);
  assert.equal(starterVoice?.label, "voice-2");
  assert.notEqual(starterVoice?.id, getModelKeyId());
  assert.deepEqual(file?.runs, [
    { voice: attributedVoice, text: ONBOARDING_DEMO_FILE_CONTENT },
  ]);
  assert.deepEqual(demo.file, { runs: file?.runs, nodeId: "", tags: [] });

  const [root] = buildDirectoryTree(
    [{ path: ONBOARDING_DEMO_FILE_PATH, type: "file" }],
    "root",
  );
  assert.equal(root.children?.[0]?.name, "hello-world.md");
});

test("repeating onboarding creates a fresh demo without replacing prior work", async () => {
  localStorage.clear();
  saveLocalFile("root-2", ONBOARDING_DEMO_FILE_PATH, {
    content: "my draft",
    tags: ["personal"],
    nodeId: "existing-node",
  });

  const second = await loadOnboardingDemo("root-2");
  const third = await loadOnboardingDemo("root-2");

  const files = loadLocalFolder("root-2")?.files;
  assert.equal(second.path, "hello-world-2.md");
  assert.equal(third.path, "hello-world-3.md");
  assert.equal(files?.[ONBOARDING_DEMO_FILE_PATH]?.content, "my draft");
  assert.deepEqual(files?.[ONBOARDING_DEMO_FILE_PATH]?.tags, ["personal"]);
  assert.equal(files?.[ONBOARDING_DEMO_FILE_PATH]?.nodeId, "existing-node");
  assert.equal(files?.[second.path]?.content, ONBOARDING_DEMO_FILE_CONTENT);
  assert.equal(files?.[third.path]?.content, ONBOARDING_DEMO_FILE_CONTENT);
});

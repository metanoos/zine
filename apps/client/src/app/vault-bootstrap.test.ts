import assert from "node:assert/strict";
import test from "node:test";

import { prepareVaultSelection } from "./vault-bootstrap.js";
import type { VaultSummary } from "./vaults.js";

const VAULT: VaultSummary = {
  id: "vault-test",
  name: "Test",
  createdAt: 1,
  legacy: false,
  snapshotExists: true,
};

test("a cancelled StrictMode bootstrap cannot consume the transition intent", async () => {
  let cancelled = false;
  let consumeCount = 0;
  let resolveVaults!: (vaults: VaultSummary[]) => void;
  let markListStarted!: () => void;
  const vaults = new Promise<VaultSummary[]>((resolve) => { resolveVaults = resolve; });
  const listStarted = new Promise<void>((resolve) => { markListStarted = resolve; });
  const operations = {
    async recoverWebviewReload() { return false; },
    async listVaults() {
      markListStarted();
      return vaults;
    },
    consumeTransitionIntent() {
      consumeCount += 1;
      return { selectedId: VAULT.id };
    },
  };
  const preparing = prepareVaultSelection({
    ...operations,
  }, () => cancelled);

  await listStarted;
  cancelled = true;
  resolveVaults([VAULT]);
  assert.equal(await preparing, null);
  assert.equal(consumeCount, 0);

  cancelled = false;
  const winner = await prepareVaultSelection(operations, () => cancelled);
  assert.equal(winner?.selectedId, VAULT.id);
  assert.equal(consumeCount, 1);
});

test("an active native vault restarts before the selector reads any state", async () => {
  let listed = false;
  const selection = await prepareVaultSelection({
    async recoverWebviewReload() { return true; },
    async listVaults() {
      listed = true;
      return [VAULT];
    },
    consumeTransitionIntent() { return {}; },
  }, () => false);

  assert.equal(selection, null);
  assert.equal(listed, false);
});

test("the winning bootstrap preserves switch and create intents", async () => {
  const selected = await prepareVaultSelection({
    async recoverWebviewReload() { return false; },
    async listVaults() { return [VAULT]; },
    consumeTransitionIntent() { return { selectedId: VAULT.id, message: "Locked" }; },
  }, () => false);
  assert.deepEqual(selected, {
    vaults: [VAULT],
    selectedId: VAULT.id,
    creating: false,
    message: "Locked",
  });

  const creating = await prepareVaultSelection({
    async recoverWebviewReload() { return false; },
    async listVaults() { return [VAULT]; },
    consumeTransitionIntent() { return { creating: true }; },
  }, () => false);
  assert.equal(creating?.creating, true);
});

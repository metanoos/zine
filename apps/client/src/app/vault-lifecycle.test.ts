import assert from "node:assert/strict";
import test from "node:test";

import { MemorySecretStore } from "../identity/secret-store.js";
import type { PeersState } from "../networking/peers-store.js";
import {
  closeVaultSession,
  openVaultSession,
  VaultSessionRollbackError,
  type VaultOpenOperations,
} from "./vault-lifecycle.js";
import type { VaultSummary } from "./vaults.js";

const VAULT: VaultSummary = {
  id: "vault-test",
  name: "Test",
  createdAt: 1,
  legacy: false,
  snapshotExists: true,
};

function peers(overrides: Partial<PeersState> = {}): PeersState {
  return {
    owner: "",
    peers: [],
    writers: [],
    networkedMode: false,
    ...overrides,
  };
}

function operations(log: string[]): VaultOpenOperations {
  return {
    async openSecretStore() {
      log.push("open-secrets");
      return new MemorySecretStore();
    },
    async unlockSecrets() { log.push("install-secrets"); },
    async ensureWorkspaceKey() {
      log.push("workspace-key");
      return new Uint8Array(32).fill(7);
    },
    activateStorage() { log.push("activate-storage"); },
    async migrateSecrets() { log.push("migrate-secrets"); },
    async initializeKeys() { log.push("initialize-keys"); },
    async activateRuntime() { log.push("activate-runtime"); },
    async listPeers() {
      log.push("list-peers");
      return peers();
    },
    async setOwner() {
      log.push("set-owner");
      return peers();
    },
    nodeVoice: () => "a".repeat(64),
    async listVaults() {
      log.push("refresh-vaults");
      return [{ ...VAULT, snapshotExists: true }];
    },
    async closeSecrets() { log.push("close-secrets"); },
    deactivateStorage() { log.push("deactivate-storage"); },
    async lockRuntime() { log.push("lock-runtime"); },
  };
}

test("open transaction publishes ready state only after every resource and refresh succeeds", async () => {
  const log: string[] = [];
  const result = await openVaultSession(VAULT, "password", operations(log));

  assert.equal(result.activeVault.id, VAULT.id);
  assert.deepEqual(log, [
    "open-secrets",
    "install-secrets",
    "workspace-key",
    "activate-storage",
    "activate-runtime",
    "migrate-secrets",
    "initialize-keys",
    "list-peers",
    "refresh-vaults",
  ]);
});

test("a post-unlock registry failure rolls back runtime, secrets, and storage", async () => {
  const log: string[] = [];
  const ops = operations(log);
  ops.listVaults = async () => {
    log.push("refresh-vaults");
    throw new Error("registry unavailable");
  };

  await assert.rejects(openVaultSession(VAULT, "password", ops), /registry unavailable/);
  assert.deepEqual(log.slice(-4), [
    "refresh-vaults",
    "lock-runtime",
    "close-secrets",
    "deactivate-storage",
  ]);
});

test("networked vault owner mismatch is repaired before the session becomes ready", async () => {
  const log: string[] = [];
  const ops = operations(log);
  ops.listPeers = async () => peers({
    owner: "b".repeat(64),
    networkedMode: true,
  });

  await openVaultSession(VAULT, "password", ops);
  assert.ok(log.indexOf("set-owner") < log.indexOf("refresh-vaults"));
});

test("only an explicitly designated first vault adopts legacy workspace records", async () => {
  const migrations: boolean[] = [];
  const ops = operations([]);
  ops.activateStorage = (_id, _key, migrateLegacy) => { migrations.push(migrateLegacy); };

  await openVaultSession(VAULT, "password", ops);
  await openVaultSession(VAULT, "password", ops, { migrateLegacyWorkspace: true });
  assert.deepEqual(migrations, [false, true]);
});

test("a failed rollback retains an exact cleanup retry and keeps storage active", async () => {
  const log: string[] = [];
  const ops = operations(log);
  let lockAttempts = 0;
  ops.listVaults = async () => { throw new Error("registry unavailable"); };
  ops.lockRuntime = async () => {
    log.push("lock-runtime");
    lockAttempts += 1;
    if (lockAttempts === 1) throw new Error("relay still running");
  };

  let failure: unknown;
  try {
    await openVaultSession(VAULT, "password", ops);
  } catch (error) {
    failure = error;
  }

  assert.ok(failure instanceof VaultSessionRollbackError);
  assert.equal(log.includes("deactivate-storage"), false);
  await failure.retryCleanup();
  assert.deepEqual(log.slice(-2), ["lock-runtime", "deactivate-storage"]);
});

test("close transaction never deactivates storage after a native lock failure", async () => {
  const log: string[] = [];
  await assert.rejects(
    closeVaultSession({
      async lockRuntime() {
        log.push("lock-runtime");
        throw new Error("relay still running");
      },
      async closeSecrets() { log.push("close-secrets"); },
      deactivateStorage() { log.push("deactivate-storage"); },
    }),
    /relay still running/,
  );
  assert.deepEqual(log, ["lock-runtime"]);
});

test("close transaction keeps the selector blocked after Stronghold unload failure", async () => {
  const log: string[] = [];
  await assert.rejects(
    closeVaultSession({
      async lockRuntime() { log.push("lock-runtime"); },
      async closeSecrets() {
        log.push("close-secrets");
        throw new Error("unload failed");
      },
      deactivateStorage() { log.push("deactivate-storage"); },
    }),
    /unload failed/,
  );
  assert.deepEqual(log, ["lock-runtime", "close-secrets"]);
});

import type { SecretStore } from "../identity/secret-store.js";
import type { PeersState } from "../networking/peers-store.js";
import type { VaultSummary } from "./vaults.js";

export interface VaultOpenOperations {
  openSecretStore(vault: VaultSummary, password: string): Promise<SecretStore>;
  unlockSecrets(store: SecretStore): Promise<void>;
  ensureWorkspaceKey(): Promise<Uint8Array>;
  activateStorage(id: string, key: Uint8Array, migrateLegacy: boolean): void;
  migrateSecrets(freshVault: boolean): Promise<unknown>;
  initializeKeys(): Promise<unknown>;
  activateRuntime(id: string, workspaceKey: Uint8Array): Promise<void>;
  startRelay(): Promise<void>;
  listPeers(): Promise<PeersState>;
  setOwner(pubkey: string): Promise<PeersState>;
  nodeVoice(): string;
  listVaults(): Promise<VaultSummary[]>;
  closeSecrets(): Promise<void>;
  deactivateStorage(): void;
  fenceStorageSession?(): void;
  lockRuntime(): Promise<void>;
}

export interface OpenVaultResult {
  activeVault: VaultSummary;
  vaults: VaultSummary[];
}

export interface OpenVaultOptions {
  /** Adopt pre-vault plaintext workspace records into the first completed
   * vault. Existing multi-vault sessions never set this for later vaults. */
  migrateLegacyWorkspace?: boolean;
}

/** The first vault remains the legacy-workspace migration target across
 * retries, even if a failed open already created its Stronghold snapshot. */
export function shouldMigrateLegacyWorkspace(
  vault: VaultSummary,
  vaults: readonly VaultSummary[],
): boolean {
  return vaults.every(
    (candidate) => candidate.id === vault.id || !candidate.snapshotExists,
  );
}

/** An open failed and at least one acquired resource could not be released.
 * The bootstrap must keep the selector hidden and retry this exact cleanup. */
export class VaultSessionRollbackError extends Error {
  constructor(
    cause: unknown,
    cleanupError: unknown,
    readonly retryCleanup: () => Promise<void>,
  ) {
    super(`${String(cause)}; vault rollback failed: ${String(cleanupError)}`);
    this.name = "VaultSessionRollbackError";
  }
}

/** Establish every secret, storage, and native resource as one transaction.
 * Any failure—including the final registry refresh—rolls the session back
 * before the vault selector can render again. */
export async function openVaultSession(
  vault: VaultSummary,
  password: string,
  operations: VaultOpenOperations,
  options: OpenVaultOptions = {},
): Promise<OpenVaultResult> {
  let store: SecretStore | null = null;
  let secretsInstalled = false;
  let storageActive = false;
  let runtimeActive = false;

  async function rollback(): Promise<void> {
    const cleanupErrors: string[] = [];
    if (runtimeActive) {
      operations.fenceStorageSession?.();
      await operations.lockRuntime().then(
        () => { runtimeActive = false; },
        (error) => { cleanupErrors.push(String(error)); },
      );
    }
    if (secretsInstalled) {
      await operations.closeSecrets().then(
        () => {
          secretsInstalled = false;
          store = null;
        },
        (error) => { cleanupErrors.push(String(error)); },
      );
    } else if (store?.close) {
      await store.close().then(
        () => { store = null; },
        (error) => { cleanupErrors.push(String(error)); },
      );
    }
    if (cleanupErrors.length) throw new Error(cleanupErrors.join("; "));
    if (storageActive) {
      operations.deactivateStorage();
      storageActive = false;
    }
  }

  try {
    store = await operations.openSecretStore(vault, password);
    await operations.unlockSecrets(store);
    secretsInstalled = true;

    const workspaceKey = await operations.ensureWorkspaceKey();
    try {
      operations.activateStorage(
        vault.id,
        workspaceKey,
        vault.legacy || options.migrateLegacyWorkspace === true,
      );
      storageActive = true;
      await operations.activateRuntime(vault.id, workspaceKey);
      runtimeActive = true;
    } finally {
      workspaceKey.fill(0);
    }
    await operations.startRelay();
    await operations.migrateSecrets(!vault.snapshotExists);
    await operations.initializeKeys();

    const peers = await operations.listPeers();
    if (peers.networkedMode && peers.owner !== operations.nodeVoice()) {
      await operations.setOwner(operations.nodeVoice());
    }

    const vaults = await operations.listVaults();
    const activeVault = vaults.find((candidate) => candidate.id === vault.id) ?? {
      ...vault,
      snapshotExists: true,
    };
    return { activeVault, vaults };
  } catch (error) {
    try {
      await rollback();
    } catch (cleanupError) {
      throw new VaultSessionRollbackError(error, cleanupError, rollback);
    }
    throw error;
  }
}

export interface VaultCloseOperations {
  fenceStorageSession?(): void;
  lockRuntime(): Promise<void>;
  closeSecrets(): Promise<void>;
  deactivateStorage(): void;
}

/** Fail closed: storage is not deactivated and the selector must not render
 * until native reachability and Stronghold have both confirmed shutdown. */
export async function closeVaultSession(operations: VaultCloseOperations): Promise<void> {
  operations.fenceStorageSession?.();
  await operations.lockRuntime();
  await operations.closeSecrets();
  operations.deactivateStorage();
}

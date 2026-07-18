import { appLocalDataDir, join } from "@tauri-apps/api/path";
import {
  Stronghold,
  type Client,
  type Store,
} from "@tauri-apps/plugin-stronghold";

import type {
  SecretStore,
  SecretStoreCapabilities,
} from "./secret-store.js";

const LEGACY_VAULT_FILENAME = "zine-secrets.hold";
const VAULTS_DIRNAME = "vaults";
const VAULT_SNAPSHOT_FILENAME = "secrets.hold";
const CLIENT_NAME = "zine";
const REFS_INDEX = "__zine_secret_refs_v1";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function kdfEnvelope(vault: { id: string; legacy: boolean }, passphrase: string): string {
  return JSON.stringify({
    version: 1,
    vaultId: vault.legacy ? null : vault.id,
    passphrase,
  });
}

/**
 * Desktop SecretStore backed by one Stronghold snapshot.
 *
 * Stronghold's key/value store intentionally has no key-enumeration API, so
 * the list of opaque references is itself an encrypted record. A mutation
 * updates the value and index before one snapshot save, keeping preload and
 * deletion deterministic across launches.
 */
export class StrongholdSecretStore implements SecretStore {
  private constructor(
    private readonly stronghold: Stronghold,
    private readonly store: Store,
  ) {}

  static async open(
    vault: { id: string; legacy: boolean },
    passphrase: string,
  ): Promise<StrongholdSecretStore> {
    if (!passphrase) throw new Error("Enter a vault passphrase");
    if (!/^[a-zA-Z0-9-]{1,96}$/.test(vault.id)) {
      throw new Error("The selected vault id is invalid");
    }
    const path = vault.legacy
      ? await join(await appLocalDataDir(), LEGACY_VAULT_FILENAME)
      : await join(
          await appLocalDataDir(),
          VAULTS_DIRNAME,
          vault.id,
          VAULT_SNAPSHOT_FILENAME,
        );
    const stronghold = await Stronghold.load(path, kdfEnvelope(vault, passphrase));
    let client: Client;
    try {
      client = await stronghold.loadClient(CLIENT_NAME);
    } catch {
      client = await stronghold.createClient(CLIENT_NAME);
    }
    return new StrongholdSecretStore(stronghold, client.getStore());
  }

  async get(ref: string): Promise<Uint8Array | null> {
    const value = await this.store.get(ref);
    return value ? new Uint8Array(value) : null;
  }

  async set(ref: string, value: Uint8Array): Promise<void> {
    await this.setMany([[ref, value]]);
  }

  async setMany(entries: ReadonlyArray<readonly [string, Uint8Array]>): Promise<void> {
    const refs = new Set(await this.readRefs());
    for (const [ref, value] of entries) {
      refs.add(ref);
      await this.store.insert(ref, Array.from(value));
    }
    await this.writeRefs([...refs].sort());
    await this.stronghold.save();
  }

  async delete(ref: string): Promise<void> {
    const refs = new Set(await this.readRefs());
    await this.store.remove(ref);
    refs.delete(ref);
    await this.writeRefs([...refs].sort());
    await this.stronghold.save();
  }

  async listRefs(): Promise<string[]> {
    return this.readRefs();
  }

  capabilities(): SecretStoreCapabilities {
    return { persistent: true, signing: true, model: true };
  }

  async close(): Promise<void> {
    await this.stronghold.unload();
  }

  private async readRefs(): Promise<string[]> {
    const raw = await this.store.get(REFS_INDEX);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(decoder.decode(raw)) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter((ref): ref is string => typeof ref === "string" && ref.length > 0)
        .sort();
    } catch {
      throw new Error("The secure vault's reference index is corrupt");
    }
  }

  private async writeRefs(refs: string[]): Promise<void> {
    await this.store.insert(REFS_INDEX, Array.from(encoder.encode(JSON.stringify(refs))));
  }
}

export { kdfEnvelope, LEGACY_VAULT_FILENAME, VAULTS_DIRNAME, VAULT_SNAPSHOT_FILENAME };

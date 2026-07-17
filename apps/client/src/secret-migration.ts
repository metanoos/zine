import { getPublicKey } from "nostr-tools/pure";

import {
  identityFromPubkey,
  keySecretRef,
  type KeyEntry,
} from "./keys-store.js";
import {
  providerCredentialRef,
  type ProviderConfig,
} from "./models-store.js";
import { getSecretCached, putSecret } from "./secret-store.js";

const KEYS_STORAGE = "zine.keys";
const MODELS_STORAGE = "zine.models";
const LEGACY_VOICE_STORAGE = "zine.voice.secretHex";
const JOURNAL_STORAGE = "zine.secret-migration.v1";
const encoder = new TextEncoder();

interface LegacyKeyEntry extends Omit<KeyEntry, "secretRef"> {
  secretRef?: string;
  secretHex?: string;
}

interface LegacyProvider extends Omit<ProviderConfig, "credentialRef"> {
  credentialRef?: string;
  apiKey?: string;
}

interface PlannedWrite {
  ref: string;
  value: Uint8Array;
}

export interface SecretMigrationResult {
  migratedKeys: number;
  migratedProviders: number;
  changed: boolean;
}

function parseArray<T>(raw: string | null, label: string): T[] {
  if (!raw) return [];
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) throw new Error(`${label} storage is not an array`);
  return parsed as T[];
}

function secretBytes(hex: string, label: string): Uint8Array {
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error(`${label} has an invalid secret key`);
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function journal(phase: string, detail: Record<string, unknown> = {}): void {
  localStorage.setItem(JOURNAL_STORAGE, JSON.stringify({
    version: 1,
    phase,
    updatedAt: Date.now(),
    ...detail,
  }));
}

function restore(key: string, value: string | null): void {
  if (value === null) localStorage.removeItem(key);
  else localStorage.setItem(key, value);
}

/**
 * Move legacy plaintext into the unlocked SecretStore as one recoverable
 * transaction:
 *
 *   discover -> encrypted writes -> read-back -> public-profile swap
 *            -> resolution verification -> legacy deletion
 *
 * A failure restores the exact old profile JSON and leaves a non-secret retry
 * journal. Successfully written encrypted orphans are harmless and are reused
 * by the next attempt; plaintext remains available until the final phase.
 */
export async function migrateLegacySecrets(): Promise<SecretMigrationResult> {
  const originalKeys = localStorage.getItem(KEYS_STORAGE);
  const originalModels = localStorage.getItem(MODELS_STORAGE);
  const originalLegacyVoice = localStorage.getItem(LEGACY_VOICE_STORAGE);
  const legacyKeys = parseArray<LegacyKeyEntry>(originalKeys, "key profile");
  const legacyProviders = parseArray<LegacyProvider>(originalModels, "provider profile");
  const writes: PlannedWrite[] = [];
  let migratedKeys = 0;
  let migratedProviders = 0;

  let keyProfiles: KeyEntry[] = legacyKeys.map((key) => {
    if (!key.id || !key.pubkey) throw new Error("A key profile is missing its public identity");
    const ref = key.secretRef || keySecretRef(key.id);
    if (key.secretHex) {
      writes.push({ ref, value: secretBytes(key.secretHex, key.label || key.id) });
      migratedKeys += 1;
    } else if (!key.secretRef) {
      throw new Error(`Key profile ${key.label || key.id} has no secure reference`);
    }
    const { secretHex: _plaintext, ...profile } = key;
    return { ...profile, secretRef: ref } as KeyEntry;
  });

  // Very old installs have only the single voice slot. Preserve that exact
  // pubkey by materializing the first public profile before deleting the slot.
  if (originalLegacyVoice) {
    const secret = secretBytes(originalLegacyVoice, "legacy voice");
    const pubkey = getPublicKey(secret);
    let profile = keyProfiles.find((key) => key.pubkey === pubkey);
    if (!profile) {
      const id = keyProfiles.length === 0 ? "builtin-voice-1" : `legacy-${pubkey.slice(0, 12)}`;
      profile = {
        id,
        label: keyProfiles.length === 0 ? "voice-1" : "legacy-voice",
        secretRef: keySecretRef(id),
        pubkey,
        identity: identityFromPubkey(pubkey),
        schemaVersion: 1,
        createdAt: Date.now(),
        builtin: keyProfiles.length === 0,
      };
      keyProfiles = [...keyProfiles, profile];
      migratedKeys += 1;
    }
    writes.push({ ref: profile.secretRef, value: secret });
  }

  const providerProfiles: ProviderConfig[] = legacyProviders.map((provider) => {
    if (!provider.id) throw new Error("A provider profile is missing its id");
    const ref = provider.credentialRef || providerCredentialRef(provider.id);
    const apiKey = provider.apiKey ?? "";
    if (apiKey) {
      writes.push({ ref, value: encoder.encode(apiKey) });
      migratedProviders += 1;
    }
    const { apiKey: _plaintext, ...profile } = provider;
    return {
      ...profile,
      credentialRef: ref,
      credentialConfigured: profile.credentialConfigured ?? Boolean(apiKey),
    } as ProviderConfig;
  });

  const changed = writes.length > 0 ||
    legacyKeys.some((key) => "secretHex" in key || !key.secretRef) ||
    legacyProviders.some((provider) => "apiKey" in provider || !provider.credentialRef);
  if (!changed) {
    localStorage.removeItem(JOURNAL_STORAGE);
    return { migratedKeys: 0, migratedProviders: 0, changed: false };
  }

  journal("discovered", {
    keyCount: keyProfiles.length,
    providerCount: providerProfiles.length,
  });
  try {
    // Last writer wins only when duplicate legacy slots contain identical
    // identities; `putSecret` independently verifies each encrypted value.
    for (const write of writes) await putSecret(write.ref, write.value);
    journal("encrypted");

    localStorage.setItem(KEYS_STORAGE, JSON.stringify(keyProfiles));
    localStorage.setItem(MODELS_STORAGE, JSON.stringify(providerProfiles));
    journal("profiles-swapped");

    for (const key of keyProfiles) {
      if (!getSecretCached(key.secretRef)) {
        throw new Error(`Secure key verification failed for ${key.label}`);
      }
    }
    for (const provider of providerProfiles) {
      if (provider.credentialConfigured && !getSecretCached(provider.credentialRef)) {
        throw new Error(`Secure credential verification failed for ${provider.label}`);
      }
    }

    localStorage.removeItem(LEGACY_VOICE_STORAGE);
    localStorage.removeItem(JOURNAL_STORAGE);
    return { migratedKeys, migratedProviders, changed: true };
  } catch (error) {
    restore(KEYS_STORAGE, originalKeys);
    restore(MODELS_STORAGE, originalModels);
    restore(LEGACY_VOICE_STORAGE, originalLegacyVoice);
    journal("failed", {
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export { JOURNAL_STORAGE };

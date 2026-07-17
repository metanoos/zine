import { getPublicKey } from "nostr-tools/pure";

import {
  identityFromPubkey,
  keySecretRef,
  sanitizeVoiceIdentity,
  type KeyEntry,
  type KeyIdentity,
} from "./keys-store.js";
import {
  providerCredentialRef,
  type ProviderConfig,
} from "./models-store.js";
import { getSecretCached, putSecrets } from "./secret-store.js";

const KEYS_STORAGE = "zine.keys";
const MODELS_STORAGE = "zine.models";
const LEGACY_VOICE_STORAGE = "zine.voice.secretHex";
const JOURNAL_STORAGE = "zine.secret-migration.v1";
const CURRENT_KEY_SCHEMA = 1;
const HEX_PUBKEY = /^[0-9a-f]{64}$/;
const encoder = new TextEncoder();

interface LegacyKeyEntry {
  id?: unknown;
  label?: unknown;
  secretRef?: unknown;
  secretHex?: unknown;
  pubkey?: unknown;
  identity?: unknown;
  createdAt?: unknown;
  schemaVersion?: unknown;
}

interface LegacyProvider extends Partial<ProviderConfig> {
  apiKey?: unknown;
}

interface PlannedWrite {
  ref: string;
  value: Uint8Array;
}

interface RoleMigration {
  current: string;
  legacy: string[];
}

const ROLE_MIGRATIONS: RoleMigration[] = [
  { current: "zine.roles.author", legacy: ["zine.roles.pen", "zine.keys.active"] },
  { current: "zine.roles.model", legacy: ["zine.roles.inject"] },
  { current: "zine.roles.node", legacy: [] },
];

export interface SecretMigrationOptions {
  /** The native snapshot did not exist before this unlock, so references that
   * cannot be resolved or populated belong to an unavailable older vault. */
  freshVault?: boolean;
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

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} is missing`);
  }
  return value;
}

function secretBytes(hex: string, label: string): Uint8Array {
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error(`${label} has an invalid secret key`);
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function secretAvailable(ref: string): boolean {
  const secret = getSecretCached(ref);
  if (!secret) return false;
  secret.fill(0);
  return true;
}

function normalizedIdentity(key: LegacyKeyEntry, pubkey: string): KeyIdentity {
  if (key.schemaVersion !== CURRENT_KEY_SCHEMA) return identityFromPubkey(pubkey);
  const identity = sanitizeVoiceIdentity((key.identity ?? null) as KeyIdentity | null);
  if (!identity) throw new Error(`Key profile ${String(key.label || key.id)} has an invalid identity`);
  return identity;
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

function candidateRole(role: RoleMigration, validIds: Set<string>): string | null {
  if (localStorage.getItem(role.current)) return null;
  for (const legacy of role.legacy) {
    const id = localStorage.getItem(legacy);
    if (id && validIds.has(id)) return id;
  }
  return null;
}

/**
 * Move legacy plaintext into the unlocked SecretStore as one recoverable
 * transaction:
 *
 *   discover -> encrypted writes -> read-back -> public-profile swap
 *            -> resolution verification -> legacy deletion
 *
 * A failure restores the exact old profile JSON and leaves a secret-free retry
 * journal. Successfully written encrypted orphans are harmless and are reused
 * by the next attempt; plaintext remains available until the final phase. When
 * native bootstrap is creating a genuinely new vault, public profiles whose
 * opaque references cannot resolve are retired before authoring is initialized.
 */
export async function migrateLegacySecrets(
  options: SecretMigrationOptions = {},
): Promise<SecretMigrationResult> {
  const originalKeys = localStorage.getItem(KEYS_STORAGE);
  const originalModels = localStorage.getItem(MODELS_STORAGE);
  const originalLegacyVoice = localStorage.getItem(LEGACY_VOICE_STORAGE);
  const originalRoles = new Map<string, string | null>();
  for (const role of ROLE_MIGRATIONS) {
    originalRoles.set(role.current, localStorage.getItem(role.current));
    for (const legacy of role.legacy) {
      originalRoles.set(legacy, localStorage.getItem(legacy));
    }
  }

  const legacyKeys = parseArray<LegacyKeyEntry>(originalKeys, "key profile");
  const legacyProviders = parseArray<LegacyProvider>(originalModels, "provider profile");
  const writes: PlannedWrite[] = [];
  let migratedKeys = 0;
  let migratedProviders = 0;
  let normalizedProfiles = false;
  const legacyVoiceSecret = originalLegacyVoice
    ? secretBytes(originalLegacyVoice, "legacy voice")
    : null;
  const legacyVoicePubkey = legacyVoiceSecret ? getPublicKey(legacyVoiceSecret) : null;
  let legacyVoiceWritePlanned = false;

  let keyProfiles: KeyEntry[] = legacyKeys.map((key) => {
    const id = requiredString(key.id, "A key profile id");
    const label = requiredString(key.label, `Key profile ${id} label`);
    const pubkey = requiredString(key.pubkey, `Key profile ${label} public identity`);
    if (!HEX_PUBKEY.test(pubkey)) throw new Error(`Key profile ${label} has an invalid public identity`);
    if (typeof key.createdAt !== "number" || !Number.isFinite(key.createdAt)) {
      throw new Error(`Key profile ${label} has an invalid creation time`);
    }

    const ref = typeof key.secretRef === "string" && key.secretRef
      ? key.secretRef
      : keySecretRef(id);
    if (typeof key.secretHex === "string" && key.secretHex) {
      const secret = secretBytes(key.secretHex, label);
      if (getPublicKey(secret) !== pubkey) {
        secret.fill(0);
        throw new Error(`Key profile ${label} does not match its signing key`);
      }
      writes.push({ ref, value: secret });
      migratedKeys += 1;
    } else if (!key.secretRef) {
      if (!legacyVoiceSecret || pubkey !== legacyVoicePubkey) {
        throw new Error(`Key profile ${label} has no secure reference`);
      }
      // Transitional keychains sometimes materialized the public voice-1
      // profile while leaving its matching secret in the pre-keychain slot.
      writes.push({ ref, value: legacyVoiceSecret });
      legacyVoiceWritePlanned = true;
      migratedKeys += 1;
    }

    const identity = normalizedIdentity(key, pubkey);
    normalizedProfiles ||= key.schemaVersion !== CURRENT_KEY_SCHEMA || key.secretRef !== ref;
    return {
      id,
      label,
      secretRef: ref,
      pubkey,
      identity,
      schemaVersion: CURRENT_KEY_SCHEMA,
      createdAt: key.createdAt,
    };
  });

  // Very old installs have only the single voice slot. Preserve that exact
  // pubkey by materializing the first public profile before deleting the slot.
  if (legacyVoiceSecret && legacyVoicePubkey) {
    const pubkey = legacyVoicePubkey;
    let profile = keyProfiles.find((key) => key.pubkey === pubkey);
    if (!profile) {
      const id = keyProfiles.length === 0 ? "builtin-voice-1" : `legacy-${pubkey.slice(0, 12)}`;
      profile = {
        id,
        label: keyProfiles.length === 0 ? "voice-1" : "legacy-voice",
        secretRef: keySecretRef(id),
        pubkey,
        identity: identityFromPubkey(pubkey),
        schemaVersion: CURRENT_KEY_SCHEMA,
        createdAt: Date.now(),
      };
      keyProfiles = [...keyProfiles, profile];
      migratedKeys += 1;
      normalizedProfiles = true;
    }
    if (!legacyVoiceWritePlanned) {
      writes.push({ ref: profile.secretRef, value: legacyVoiceSecret });
    }
  }

  let providerProfiles: ProviderConfig[] = legacyProviders.map((provider) => {
    const id = requiredString(provider.id, "A provider profile id");
    const label = requiredString(provider.label, `Provider profile ${id} label`);
    const ref = typeof provider.credentialRef === "string" && provider.credentialRef
      ? provider.credentialRef
      : providerCredentialRef(id);
    const apiKey = typeof provider.apiKey === "string" ? provider.apiKey : "";
    if (provider.apiKey !== undefined && typeof provider.apiKey !== "string") {
      throw new Error(`Provider profile ${label} has an invalid credential`);
    }
    if (apiKey) {
      writes.push({ ref, value: encoder.encode(apiKey) });
      migratedProviders += 1;
    }
    normalizedProfiles ||= provider.credentialRef !== ref || provider.credentialConfigured === undefined;
    const { apiKey: _plaintext, ...profile } = provider;
    return {
      ...profile,
      id,
      label,
      credentialRef: ref,
      credentialConfigured: profile.credentialConfigured ?? Boolean(apiKey || secretAvailable(ref)),
    } as ProviderConfig;
  });

  const plannedRefs = new Set(writes.map((write) => write.ref));
  if (options.freshVault) {
    const recoverableKeys = keyProfiles.filter((key) => (
      plannedRefs.has(key.secretRef) || secretAvailable(key.secretRef)
    ));
    normalizedProfiles ||= recoverableKeys.length !== keyProfiles.length;
    keyProfiles = recoverableKeys;

    providerProfiles = providerProfiles.map((provider) => {
      const credentialConfigured = plannedRefs.has(provider.credentialRef) ||
        secretAvailable(provider.credentialRef);
      normalizedProfiles ||= provider.credentialConfigured !== credentialConfigured;
      return { ...provider, credentialConfigured };
    });
  }

  const validIds = new Set(keyProfiles.map((key) => key.id));
  const roleUpdates = new Map<string, string | null>();
  for (const role of ROLE_MIGRATIONS) {
    const id = candidateRole(role, validIds);
    if (id) roleUpdates.set(role.current, id);
  }
  if (options.freshVault) {
    const fallback = keyProfiles[0]?.id ?? null;
    for (const role of ROLE_MIGRATIONS) {
      const current = roleUpdates.get(role.current) ?? localStorage.getItem(role.current);
      if ((!current || !validIds.has(current)) && current !== fallback) {
        roleUpdates.set(role.current, fallback);
      }
    }
  }
  const changed = writes.length > 0 ||
    normalizedProfiles ||
    legacyKeys.some((key) => "secretHex" in key || !key.secretRef) ||
    legacyProviders.some((provider) => "apiKey" in provider || !provider.credentialRef) ||
    roleUpdates.size > 0;
  if (!changed) {
    localStorage.removeItem(JOURNAL_STORAGE);
    return { migratedKeys: 0, migratedProviders: 0, changed: false };
  }

  journal("discovered", {
    keyCount: keyProfiles.length,
    providerCount: providerProfiles.length,
  });
  try {
    if (writes.length > 0) {
      await putSecrets(writes.map((write) => [write.ref, write.value] as const));
    }
    journal("encrypted");

    localStorage.setItem(KEYS_STORAGE, JSON.stringify(keyProfiles));
    localStorage.setItem(MODELS_STORAGE, JSON.stringify(providerProfiles));
    for (const [key, value] of roleUpdates) restore(key, value);
    journal("profiles-swapped");

    for (const key of keyProfiles) {
      if (!secretAvailable(key.secretRef)) {
        throw new Error(`Secure key verification failed for ${key.label}`);
      }
    }
    for (const provider of providerProfiles) {
      if (provider.credentialConfigured && !secretAvailable(provider.credentialRef)) {
        throw new Error(`Secure credential verification failed for ${provider.label}`);
      }
    }

    localStorage.removeItem(LEGACY_VOICE_STORAGE);
    for (const role of ROLE_MIGRATIONS) {
      for (const legacy of role.legacy) localStorage.removeItem(legacy);
    }
    localStorage.removeItem(JOURNAL_STORAGE);
    return { migratedKeys, migratedProviders, changed: true };
  } catch (error) {
    restore(KEYS_STORAGE, originalKeys);
    restore(MODELS_STORAGE, originalModels);
    restore(LEGACY_VOICE_STORAGE, originalLegacyVoice);
    for (const [key, value] of originalRoles) restore(key, value);
    journal("failed", {
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    for (const write of writes) write.value.fill(0);
  }
}

export { JOURNAL_STORAGE };

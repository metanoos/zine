import { randomBytes } from "@noble/ciphers/utils.js";

import { getSecretCached, putSecret } from "../identity/secret-store.js";

export const VAULT_WORKSPACE_KEY_REF = "zine:vault:workspace-key:v1";

/** Return the authenticated-encryption key sealed inside Stronghold, creating
 * it before any plaintext workspace state is adopted into the vault. */
export async function ensureVaultWorkspaceKey(): Promise<Uint8Array> {
  const existing = getSecretCached(VAULT_WORKSPACE_KEY_REF);
  if (existing) {
    if (existing.length !== 32) {
      existing.fill(0);
      throw new Error("The vault workspace key is corrupt");
    }
    return existing;
  }
  const created = randomBytes(32);
  await putSecret(VAULT_WORKSPACE_KEY_REF, created);
  return created;
}

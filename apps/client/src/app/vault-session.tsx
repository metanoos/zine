import { createContext, useContext } from "react";

import type { VaultSummary } from "./vaults.js";

export interface VaultSession {
  activeVault: VaultSummary | null;
  vaults: VaultSummary[];
  lockVault(): Promise<void>;
  switchVault(id: string): Promise<void>;
  createVault(): Promise<void>;
}

export const VaultSessionContext = createContext<VaultSession | null>(null);

export function useVaultSession(): VaultSession {
  const session = useContext(VaultSessionContext);
  if (!session) throw new Error("Vault session is unavailable");
  return session;
}

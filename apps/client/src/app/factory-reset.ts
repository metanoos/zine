import { isTauri } from "../identity/identity.js";
import { closeSecretSession } from "../identity/secret-store.js";
import { vaultStorage as localStorage } from "../storage/vault-storage.js";

export interface FactoryResetActions {
  resetDesktopState?: () => Promise<void>;
  closeSecrets?: () => Promise<void>;
  deleteDesktopVault?: () => Promise<void>;
  clearBrowserState: () => void;
  reload: () => void;
}

/** Execute the destructive reset in an order that cannot let Stronghold save
 * its old in-memory snapshot after native deletion. If a post-close operation
 * fails, reload immediately so the rendered app cannot keep authoring against
 * a released secret backend. */
export async function runFactoryReset(actions: FactoryResetActions): Promise<void> {
  if (!actions.resetDesktopState) {
    actions.clearBrowserState();
    actions.reload();
    return;
  }
  if (!actions.closeSecrets || !actions.deleteDesktopVault) {
    throw new Error("Desktop factory reset actions are incomplete");
  }

  await actions.resetDesktopState();
  try {
    await actions.closeSecrets();
  } catch (error) {
    actions.reload();
    throw error;
  }
  try {
    actions.clearBrowserState();
    await actions.deleteDesktopVault();
  } catch (error) {
    actions.reload();
    throw error;
  }
  actions.reload();
}

export async function resetLocalApp(): Promise<void> {
  if (!isTauri()) {
    await runFactoryReset({
      clearBrowserState: () => localStorage.clear(),
      reload: () => window.location.reload(),
    });
    return;
  }

  const { invoke } = await import("@tauri-apps/api/core");
  await runFactoryReset({
    resetDesktopState: () => invoke("factory_reset"),
    closeSecrets: closeSecretSession,
    deleteDesktopVault: () => invoke("factory_reset_vault"),
    clearBrowserState: () => localStorage.clear(),
    reload: () => window.location.reload(),
  });
}

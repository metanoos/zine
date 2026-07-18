import { invoke } from "@tauri-apps/api/core";

import {
  captureDesktopOperationJournalSessionV1,
  clearDesktopOperationJournalSessionV1,
} from "../ai/desktop-operation-journal-session.js";

export interface VaultSummary {
  id: string;
  name: string;
  createdAt: number;
  legacy: boolean;
  snapshotExists: boolean;
}

export type VaultNativeInvoke = (
  command: string,
  args?: Record<string, unknown>,
) => Promise<unknown>;

export async function listVaults(): Promise<VaultSummary[]> {
  return invoke<VaultSummary[]>("list_secret_vaults");
}

export async function createVaultRecord(name: string): Promise<VaultSummary> {
  return invoke<VaultSummary>("create_secret_vault", { name });
}

export async function discardEmptyVaultRecord(id: string): Promise<void> {
  await invoke("discard_empty_secret_vault", { id });
}

export async function activateVaultRuntime(
  id: string,
  workspaceKey: Uint8Array,
  nativeInvoke: VaultNativeInvoke = (command, args) => invoke(command, args),
): Promise<void> {
  const activation = await nativeInvoke("activate_vault_runtime", {
    id,
    workspaceKey: Array.from(workspaceKey),
  });
  try {
    captureDesktopOperationJournalSessionV1(activation);
  } catch (captureError) {
    clearDesktopOperationJournalSessionV1();
    try {
      await nativeInvoke("lock_vault_runtime");
    } catch (lockError) {
      const cleanupError = new Error(
        "Native vault activation returned an invalid journal session and could not be locked",
      ) as Error & { captureError: unknown; lockError: unknown };
      cleanupError.captureError = captureError;
      cleanupError.lockError = lockError;
      throw cleanupError;
    }
    throw captureError;
  }
}

export async function startVaultRelay(): Promise<void> {
  await invoke("spawn_relay");
}

export async function recoverWebviewReload(): Promise<boolean> {
  const restarting = await invoke<boolean>("recover_webview_reload");
  if (restarting) clearDesktopOperationJournalSessionV1();
  return restarting;
}

export async function lockVaultRuntime(): Promise<void> {
  await invoke("lock_vault_runtime");
  clearDesktopOperationJournalSessionV1();
}

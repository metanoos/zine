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

export async function listVaults(): Promise<VaultSummary[]> {
  return invoke<VaultSummary[]>("list_secret_vaults");
}

export async function createVaultRecord(name: string): Promise<VaultSummary> {
  return invoke<VaultSummary>("create_secret_vault", { name });
}

export async function discardEmptyVaultRecord(id: string): Promise<void> {
  await invoke("discard_empty_secret_vault", { id });
}

export async function activateVaultRuntime(id: string, workspaceKey: Uint8Array): Promise<void> {
  const activation = await invoke("activate_vault_runtime", {
    id,
    workspaceKey: Array.from(workspaceKey),
  });
  captureDesktopOperationJournalSessionV1(activation);
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

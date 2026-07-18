import type { VaultSummary } from "./vaults.js";

export interface VaultTransitionIntent {
  selectedId?: string;
  creating?: boolean;
  message?: string;
}

export interface VaultSelectionState {
  vaults: VaultSummary[];
  selectedId: string | null;
  creating: boolean;
  message?: string;
}

export interface VaultBootstrapOperations {
  recoverWebviewReload(): Promise<boolean>;
  listVaults(): Promise<VaultSummary[]>;
  consumeTransitionIntent(): VaultTransitionIntent;
}

/** Prepare the desktop selector without letting React StrictMode's cancelled
 * first effect consume a one-shot switch/create intent. A surviving native
 * vault triggers a process restart before either the list or selector appears. */
export async function prepareVaultSelection(
  operations: VaultBootstrapOperations,
  isCancelled: () => boolean,
): Promise<VaultSelectionState | null> {
  const restarting = await operations.recoverWebviewReload();
  if (restarting || isCancelled()) return null;

  const vaults = await operations.listVaults();
  if (isCancelled()) return null;

  const intent = operations.consumeTransitionIntent();
  const selectedId = intent.selectedId && vaults.some((vault) => vault.id === intent.selectedId)
    ? intent.selectedId
    : null;
  return {
    vaults,
    selectedId,
    creating: vaults.length === 0 || intent.creating === true,
    ...(intent.message ? { message: intent.message } : {}),
  };
}

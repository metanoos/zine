import { LockKeyhole, Plus, RotateCcw } from "lucide-react";
import { useState } from "react";

import { useVaultSession } from "./vault-session.js";
import { DEFAULT_ROOT_LABEL, getRootLabel } from "../workspace/root.js";

export function VaultsView() {
  const { activeVault, vaults, lockVault, switchVault, createVault } = useVaultSession();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(label: string, action: () => Promise<void>): Promise<void> {
    if (busy) return;
    setBusy(label);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(null);
    }
  }

  if (!activeVault) {
    return (
      <section className="view-placeholder vaults-view">
        <p className="view-placeholder-blurb">Vaults are available in the desktop press.</p>
      </section>
    );
  }

  const otherVaults = vaults.filter((vault) => vault.id !== activeVault.id);
  return (
    <section className="view-placeholder vaults-view">
      <p className="vaults-intro">
        Each vault has its own Root, signing keys, model credentials, and local workspace state.
        Only one vault is unlocked at a time.
      </p>

      <article className="settings-card vault-card vault-card-active">
        <div className="vault-card-main">
          <div>
            <div className="vault-card-heading">
              <h2>{activeVault.name}</h2>
              <span className="vault-active-badge">Active</span>
            </div>
            <p>Root: {getRootLabel() ?? DEFAULT_ROOT_LABEL}</p>
          </div>
          <button
            type="button"
            className="vault-secondary-action"
            disabled={busy !== null}
            onClick={() => void run("lock", lockVault)}
          >
            <LockKeyhole size={16} aria-hidden="true" />
            {busy === "lock" ? "Locking…" : "Lock vault"}
          </button>
        </div>
      </article>

      {otherVaults.length > 0 && (
        <div className="vault-list" aria-label="Other vaults">
          <h2 className="vault-section-title">Other vaults</h2>
          {otherVaults.map((vault) => (
            <div className="settings-row vault-row" key={vault.id}>
              <div>
                <strong>{vault.name}</strong>
                <span>Locked</span>
              </div>
              <button
                type="button"
                className="vault-row-action"
                disabled={busy !== null}
                onClick={() => void run(vault.id, () => switchVault(vault.id))}
              >
                <RotateCcw size={15} aria-hidden="true" />
                {busy === vault.id ? "Switching…" : "Switch"}
              </button>
            </div>
          ))}
        </div>
      )}

      {error && <p className="vault-error" role="alert">{error}</p>}
      <button
        type="button"
        className="settings-add-btn vault-add"
        disabled={busy !== null}
        onClick={() => void run("create", createVault)}
      >
        <Plus size={17} aria-hidden="true" />
        {busy === "create" ? "Locking…" : "Create vault"}
      </button>
    </section>
  );
}

import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";

import { isTauri } from "../identity/identity.js";
import { initializeKeyStoreForAuthoring, nodeVoice } from "../identity/keys-store.js";
import { migrateLegacySecrets } from "../identity/secret-migration.js";
import {
  closeSecretSession,
  initializeBrowserReadOnlySecretSession,
  unlockSecretSession,
} from "../identity/secret-store.js";
import { StrongholdSecretStore } from "../identity/stronghold-secret-store.js";
import { listPeers, setOwner } from "../networking/peers-store.js";
import {
  activateVaultStorage,
  deactivateVaultStorage,
} from "../storage/vault-storage.js";
import { VaultSessionContext, type VaultSession } from "./vault-session.js";
import {
  closeVaultSession,
  openVaultSession,
  VaultSessionRollbackError,
} from "./vault-lifecycle.js";
import { ensureVaultWorkspaceKey } from "./vault-workspace-key.js";
import {
  activateVaultRuntime,
  createVaultRecord,
  discardEmptyVaultRecord,
  listVaults,
  lockVaultRuntime,
  type VaultSummary,
} from "./vaults.js";

type BootstrapState =
  | { kind: "checking" }
  | { kind: "reader" }
  | {
      kind: "selecting";
      vaults: VaultSummary[];
      selectedId: string | null;
      creating: boolean;
      message?: string;
    }
  | { kind: "opening"; label: string }
  | { kind: "ready"; activeVault: VaultSummary; vaults: VaultSummary[] }
  | {
      kind: "locking";
      activeVault: VaultSummary;
      vaults: VaultSummary[];
      options: { selectedId?: string; creating?: boolean };
      retryCleanup?: () => Promise<void>;
      message?: string;
    };

interface VaultTransitionIntent {
  selectedId?: string;
  creating?: boolean;
  message?: string;
}

const VAULT_TRANSITION_KEY = "zine.vault-transition";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function nextPaint(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => resolve());
    } else {
      setTimeout(resolve, 0);
    }
  });
}

function consumeTransitionIntent(): VaultTransitionIntent {
  try {
    const raw = sessionStorage.getItem(VAULT_TRANSITION_KEY);
    sessionStorage.removeItem(VAULT_TRANSITION_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as VaultTransitionIntent;
    return {
      ...(typeof parsed.selectedId === "string" ? { selectedId: parsed.selectedId } : {}),
      ...(parsed.creating === true ? { creating: true } : {}),
      ...(typeof parsed.message === "string" ? { message: parsed.message } : {}),
    };
  } catch {
    return {};
  }
}

function saveTransitionIntent(intent: VaultTransitionIntent): void {
  try {
    sessionStorage.setItem(VAULT_TRANSITION_KEY, JSON.stringify(intent));
  } catch {
    // A reload still produces the ordinary vault list if sessionStorage is
    // unavailable; only the switcher's preselection is lost.
  }
}

/** Hold App behind an explicit desktop vault selection and unlock. Browser
 * deployments get the same reader UI with signing and MODEL capabilities
 * disabled. */
export function SecurityBootstrap({ children }: { children: ReactNode }) {
  const [state, setState] = useState<BootstrapState>({ kind: "checking" });
  const [name, setName] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [confirmation, setConfirmation] = useState("");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!isTauri()) {
        await initializeBrowserReadOnlySecretSession();
        if (!cancelled) setState({ kind: "reader" });
        return;
      }
      try {
        const vaults = await listVaults();
        const intent = consumeTransitionIntent();
        const selectedId = intent.selectedId && vaults.some((vault) => vault.id === intent.selectedId)
          ? intent.selectedId
          : null;
        if (!cancelled) {
          setState({
            kind: "selecting",
            vaults,
            selectedId,
            creating: vaults.length === 0 || intent.creating === true,
            ...(intent.message ? { message: intent.message } : {}),
          });
        }
      } catch (error) {
        if (!cancelled) {
          setState({
            kind: "selecting",
            vaults: [],
            selectedId: null,
            creating: false,
            message: errorMessage(error),
          });
        }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  async function establishSession(
    vault: VaultSummary,
    password: string,
    migrateLegacyWorkspace = false,
  ) {
    return openVaultSession(vault, password, {
      openSecretStore: StrongholdSecretStore.open,
      unlockSecrets: unlockSecretSession,
      ensureWorkspaceKey: ensureVaultWorkspaceKey,
      activateStorage: activateVaultStorage,
      migrateSecrets: (freshVault) => migrateLegacySecrets({ freshVault }),
      initializeKeys: initializeKeyStoreForAuthoring,
      activateRuntime: activateVaultRuntime,
      listPeers,
      setOwner,
      nodeVoice,
      listVaults,
      closeSecrets: closeSecretSession,
      deactivateStorage: deactivateVaultStorage,
      lockRuntime: lockVaultRuntime,
    }, { migrateLegacyWorkspace });
  }

  async function unlockSelected(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (state.kind !== "selecting" || state.creating) return;
    const vault = state.vaults.find((candidate) => candidate.id === state.selectedId);
    if (!vault) return;
    if (!passphrase) {
      setState({ ...state, message: "Enter a vault passphrase." });
      return;
    }
    if (!vault.snapshotExists && passphrase !== confirmation) {
      setState({ ...state, message: "The passphrases do not match." });
      return;
    }
    setState({ kind: "opening", label: vault.name });
    try {
      const opened = await establishSession(
        vault,
        passphrase,
        !vault.snapshotExists && state.vaults.every((candidate) => !candidate.snapshotExists),
      );
      setPassphrase("");
      setConfirmation("");
      setState({ kind: "ready", ...opened });
    } catch (error) {
      setPassphrase("");
      setConfirmation("");
      if (error instanceof VaultSessionRollbackError) {
        setState({
          kind: "locking",
          activeVault: vault,
          vaults: state.vaults,
          options: { selectedId: vault.id },
          retryCleanup: error.retryCleanup,
          message: errorMessage(error),
        });
        return;
      }
      const vaults = await listVaults().catch(() => state.vaults);
      setState({
        kind: "selecting",
        vaults,
        selectedId: vault.id,
        creating: false,
        message: errorMessage(error),
      });
    }
  }

  async function createVault(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (state.kind !== "selecting" || !state.creating) return;
    const trimmedName = name.trim();
    if (!trimmedName) {
      setState({ ...state, message: "Enter a vault name." });
      return;
    }
    if (!passphrase) {
      setState({ ...state, message: "Enter a vault passphrase." });
      return;
    }
    if (passphrase !== confirmation) {
      setState({ ...state, message: "The passphrases do not match." });
      return;
    }

    setState({ kind: "opening", label: trimmedName });
    let created: VaultSummary | null = null;
    try {
      created = await createVaultRecord(trimmedName);
      const opened = await establishSession(
        created,
        passphrase,
        state.vaults.every((candidate) => !candidate.snapshotExists),
      );
      setName("");
      setPassphrase("");
      setConfirmation("");
      setState({ kind: "ready", ...opened });
    } catch (error) {
      setPassphrase("");
      setConfirmation("");
      if (created && error instanceof VaultSessionRollbackError) {
        setState({
          kind: "locking",
          activeVault: created,
          vaults: [...state.vaults, created],
          options: { selectedId: created.id },
          retryCleanup: error.retryCleanup,
          message: errorMessage(error),
        });
        return;
      }
      if (created) {
        await discardEmptyVaultRecord(created.id).catch(() => undefined);
      }
      const vaults = await listVaults().catch(() => state.vaults);
      const reserved = created
        ? vaults.find((candidate) => candidate.id === created!.id) ?? null
        : null;
      setState({
        kind: "selecting",
        vaults,
        selectedId: reserved?.id ?? null,
        creating: !reserved,
        message: errorMessage(error),
      });
    }
  }

  async function finishLeavingVault(
    locking: Extract<BootstrapState, { kind: "locking" }>,
  ): Promise<void> {
    await nextPaint();
    try {
      if (locking.retryCleanup) {
        await locking.retryCleanup();
      } else {
        await closeVaultSession({
          lockRuntime: lockVaultRuntime,
          closeSecrets: closeSecretSession,
          deactivateStorage: deactivateVaultStorage,
        });
      }
    } catch (error) {
      setState({ ...locking, message: errorMessage(error) });
      return;
    }
    saveTransitionIntent({
      ...(locking.options.selectedId ? { selectedId: locking.options.selectedId } : {}),
      ...(locking.options.creating ? { creating: true } : {}),
    });
    // A reload is the security boundary: it drops React state, module caches,
    // provider responses, and any secret copies retained by completed call
    // frames before another vault can be selected.
    window.location.reload();
  }

  async function leaveVault(options: { selectedId?: string; creating?: boolean } = {}): Promise<void> {
    if (state.kind !== "ready") return;
    const locking: Extract<BootstrapState, { kind: "locking" }> = {
      kind: "locking",
      activeVault: state.activeVault,
      vaults: state.vaults,
      options,
    };
    setState(locking);
    await finishLeavingVault(locking);
  }

  const session = useMemo<VaultSession | null>(() => {
    if (state.kind === "reader") {
      const unavailable = async () => { throw new Error("Vaults are desktop-only"); };
      return {
        activeVault: null,
        vaults: [],
        lockVault: unavailable,
        switchVault: unavailable,
        createVault: unavailable,
      };
    }
    if (state.kind !== "ready") return null;
    return {
      activeVault: state.activeVault,
      vaults: state.vaults,
      lockVault: () => leaveVault(),
      switchVault: (id) => leaveVault({ selectedId: id }),
      createVault: () => leaveVault({ creating: true }),
    };
  }, [state]); // eslint-disable-line react-hooks/exhaustive-deps

  if (state.kind === "ready" || state.kind === "reader") {
    return <VaultSessionContext.Provider value={session!}>{children}</VaultSessionContext.Provider>;
  }
  if (state.kind === "checking") {
    return <main className="security-bootstrap"><p>Checking secure vaults…</p></main>;
  }
  if (state.kind === "opening") {
    return <main className="security-bootstrap"><p>Opening {state.label}…</p></main>;
  }
  if (state.kind === "locking") {
    return (
      <main className="security-bootstrap">
        <section className="security-bootstrap-card">
          <h1>Locking {state.activeVault.name}…</h1>
          {state.message && (
            <>
              <p className="security-bootstrap-error" role="alert">{state.message}</p>
              <p>Zine will not show another vault until this one is fully closed.</p>
              <button
                type="button"
                onClick={() => {
                  setState({ ...state, message: undefined });
                  void finishLeavingVault({ ...state, message: undefined });
                }}
              >
                Retry lock
              </button>
            </>
          )}
        </section>
      </main>
    );
  }

  const selectedVault = state.vaults.find((vault) => vault.id === state.selectedId) ?? null;
  const finishingSetup = !state.creating && selectedVault?.snapshotExists === false;
  if (!state.creating && !selectedVault) {
    return (
      <main className="security-bootstrap">
        <section className="security-bootstrap-card security-vault-picker">
          <p className="security-bootstrap-kicker">ZINE DESKTOP</p>
          <h1>Choose a vault</h1>
          <p>Unlock one Root and its keys, models, and workspace state for this session.</p>
          <div className="security-vault-list">
            {state.vaults.map((vault) => (
              <button
                type="button"
                className="security-vault-choice"
                key={vault.id}
                onClick={() => {
                  setPassphrase("");
                  setState({ ...state, selectedId: vault.id, message: undefined });
                }}
              >
                <span>{vault.name}</span>
                <small>{vault.snapshotExists ? "Locked" : "Finish setup"}</small>
              </button>
            ))}
          </div>
          {state.message && <p className="security-bootstrap-error" role="alert">{state.message}</p>}
          <button
            type="button"
            className="security-vault-create"
            onClick={() => {
              setName("");
              setPassphrase("");
              setConfirmation("");
              setState({ ...state, creating: true, message: undefined });
            }}
          >
            Create vault
          </button>
        </section>
      </main>
    );
  }

  return (
    <main className="security-bootstrap">
      <form
        className="security-bootstrap-card"
        onSubmit={(event) => void (state.creating ? createVault(event) : unlockSelected(event))}
      >
        <button
          type="button"
          className="security-vault-back"
          onClick={() => {
            setPassphrase("");
            setConfirmation("");
            setState({ ...state, selectedId: null, creating: false, message: undefined });
          }}
        >
          ← Vaults
        </button>
        <p className="security-bootstrap-kicker">ZINE DESKTOP</p>
        <h1>{
          state.creating
            ? (state.vaults.length ? "Create a vault" : "Create your first vault")
            : finishingSetup
              ? `Finish ${selectedVault!.name}`
              : `Unlock ${selectedVault!.name}`
        }</h1>
        <p>
          {state.creating
            ? "This vault gets its own Root, signing keys, provider credentials, and local workspace state. Its passphrase is never stored."
            : finishingSetup
              ? "Creation was interrupted before encrypted state existed. Choose and confirm the passphrase that will protect this vault."
              : "Enter this vault’s passphrase to decrypt its Root, workspace, and secure credentials."}
        </p>
        {state.creating && (
          <label>
            <span>Vault name</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              autoComplete="off"
              maxLength={64}
              autoFocus
            />
          </label>
        )}
        <label>
          <span>Vault passphrase</span>
          <input
              type="password"
              value={passphrase}
              onChange={(event) => setPassphrase(event.target.value)}
              autoComplete={state.creating || finishingSetup ? "new-password" : "current-password"}
              autoFocus={!state.creating}
          />
        </label>
        {(state.creating || finishingSetup) && (
          <label>
            <span>Confirm passphrase</span>
            <input
              type="password"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              autoComplete="new-password"
            />
          </label>
        )}
        {state.message && <p className="security-bootstrap-error" role="alert">{state.message}</p>}
        <button type="submit">
          {state.creating ? "Create vault" : finishingSetup ? "Finish setup" : "Unlock"}
        </button>
      </form>
    </main>
  );
}

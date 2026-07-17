import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";

import { isTauri } from "./identity.js";
import { initializeKeyStoreForAuthoring } from "./keys-store.js";
import { migrateLegacySecrets } from "./secret-migration.js";
import {
  initializeBrowserReadOnlySecretSession,
  unlockSecretSession,
} from "./secret-store.js";
import { StrongholdSecretStore } from "./stronghold-secret-store.js";

interface SecretVaultStatus {
  vaultExists: boolean;
}

type BootstrapState =
  | { kind: "checking" }
  | { kind: "reader" }
  | { kind: "locked"; vaultExists: boolean }
  | { kind: "unlocking"; vaultExists: boolean }
  | { kind: "ready" }
  | { kind: "error"; vaultExists: boolean; message: string };

/** Hold App behind an explicit desktop vault unlock. Browser deployments get
 * the same reader UI with signing and MODEL capabilities disabled. */
export function SecurityBootstrap({ children }: { children: ReactNode }) {
  const [state, setState] = useState<BootstrapState>({ kind: "checking" });
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
        const status = await invoke<SecretVaultStatus>("secret_vault_status");
        if (!cancelled) setState({ kind: "locked", vaultExists: status.vaultExists });
      } catch (error) {
        if (!cancelled) {
          setState({
            kind: "error",
            vaultExists: false,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (state.kind !== "locked" && state.kind !== "error") return;
    const vaultExists = state.vaultExists;
    if (!passphrase) {
      setState({ kind: "error", vaultExists, message: "Enter a vault passphrase." });
      return;
    }
    if (!vaultExists && passphrase !== confirmation) {
      setState({ kind: "error", vaultExists, message: "The passphrases do not match." });
      return;
    }
    setState({ kind: "unlocking", vaultExists });
    try {
      const store = await StrongholdSecretStore.open(passphrase);
      await unlockSecretSession(store);
      await migrateLegacySecrets();
      await initializeKeyStoreForAuthoring();
      setPassphrase("");
      setConfirmation("");
      setState({ kind: "ready" });
    } catch (error) {
      setState({
        kind: "error",
        vaultExists,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (state.kind === "ready" || state.kind === "reader") return <>{children}</>;
  if (state.kind === "checking") {
    return <main className="security-bootstrap"><p>Checking secure vault…</p></main>;
  }

  const vaultExists = state.vaultExists;
  return (
    <main className="security-bootstrap">
      <form className="security-bootstrap-card" onSubmit={(event) => void submit(event)}>
        <p className="security-bootstrap-kicker">ZINE DESKTOP</p>
        <h1>{vaultExists ? "Unlock your press" : "Create your secure vault"}</h1>
        <p>
          {vaultExists
            ? "Unlock signing keys and MODEL credentials for this session."
            : "Your signing keys and MODEL credentials will be encrypted by Stronghold. This passphrase is never stored."}
        </p>
        <label>
          <span>Vault passphrase</span>
          <input
            type="password"
            value={passphrase}
            onChange={(event) => setPassphrase(event.target.value)}
            autoComplete={vaultExists ? "current-password" : "new-password"}
            autoFocus
          />
        </label>
        {!vaultExists && (
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
        {state.kind === "error" && <p className="security-bootstrap-error">{state.message}</p>}
        <button type="submit" disabled={state.kind === "unlocking"}>
          {state.kind === "unlocking" ? "Opening…" : vaultExists ? "Unlock" : "Create vault"}
        </button>
      </form>
    </main>
  );
}

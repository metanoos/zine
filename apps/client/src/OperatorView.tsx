/**
 * The Operator view — relay operator controls for the hosted press. Webapp-only:
 * the desktop sidecar has no operator layer. Shown in the nav rail only when
 * the current browser voice is the bound operator or a member of the curation
 * team (operator-store.isStaff()).
 *
 * Foundation scope (this file): identity card, curation team management,
 * moderation (ban list). The press pillars — submission policy (open / invite /
 * fork-to-submit), the press manifest (name, tagline, aesthetic), and
 * relay-side syndication — drop in as additional <section>s in a follow-up,
 * which is why the file is structured as a stack of named sections rather than
 * a single dense block.
 *
 * All mutations go through operator-store's NIP-98-signed helpers; no secret
 * key is ever typed or sent. Async failures surface inline (no global toast).
 */

import { useState } from "react";
import { npubEncode } from "nostr-tools/nip19";
import { Megaphone, Plus, Trash2, ShieldAlert, UserPlus, UserMinus } from "lucide-react";
import {
  isOperator,
  setBan,
  setTeamMember,
  type OperatorState,
} from "./operator-store.js";
import { loadOrCreateVoice } from "./identity.js";

/** Render a 64-hex pubkey as a short npub (first 14 chars after the prefix),
 *  enough to recognize a key without flooding the row. */
function shortNpub(pubkey: string): string {
  try {
    return npubEncode(pubkey).slice(0, 24) + "…";
  } catch {
    // Shouldn't happen for a 64-hex string, but don't crash the view over it.
    return pubkey.slice(0, 12) + "…";
  }
}

export function OperatorView({
  state,
  onStateChange,
  onOpenSetup,
}: {
  /** The latest operator snapshot, or null if /operator/state hasn't resolved
   *  yet. A null state renders a loading shell. */
  state: OperatorState | null;
  /** Called with the new snapshot after each successful mutation. */
  onStateChange: (st: OperatorState) => void;
  /** Operator-only: re-open the bind modal for key rotation. */
  onOpenSetup: () => void;
}) {
  const me = loadOrCreateVoice().publicKey;
  const operator = isOperator();

  if (!state) {
    return (
      <section className="view-placeholder">
        <p className="view-placeholder-blurb">Loading relay state…</p>
      </section>
    );
  }

  return (
    <section className="view-placeholder operator-view">
      <header className="operator-header">
        <Megaphone size={28} strokeWidth={1.5} />
        <div>
          <p className="view-placeholder-blurb">
            {operator
              ? "You are the operator of this press. Manage your curation team and moderation."
              : "You are on the curation team. You can ban and curate, but can't change the team or rebind."}
          </p>
        </div>
      </header>

      <IdentitySection state={state} me={me} isOperator={operator} onOpenSetup={onOpenSetup} />
      <TeamSection state={state} canEdit={operator} onStateChange={onStateChange} />
      <ModerationSection state={state} onStateChange={onStateChange} />
    </section>
  );
}

// --- identity -------------------------------------------------------------

function IdentitySection({
  state,
  me,
  isOperator: op,
  onOpenSetup,
}: {
  state: OperatorState;
  me: string;
  isOperator: boolean;
  onOpenSetup: () => void;
}) {
  return (
    <section className="operator-section">
      <h3 className="operator-section-title">Identity</h3>
      <div className="operator-identity-row">
        <span className="operator-identity-label">Operator key</span>
        <code className="operator-pubkey">{shortNpub(state.operator || "(unbound)")}</code>
        {op && (
          <button type="button" className="operator-inline-btn" onClick={onOpenSetup}>
            Rotate key
          </button>
        )}
      </div>
      <p className="operator-hint">
        {state.operator === me
          ? "This browser's AUTHOR key is the operator. Signing promote/demote/reorder opinions in Stacks curates the press for every reader here."
          : "The operator curates by signing opinions in Stacks; those opinions shape every reader's ranking on this relay."}
      </p>
    </section>
  );
}

// --- curation team --------------------------------------------------------

function TeamSection({
  state,
  canEdit,
  onStateChange,
}: {
  state: OperatorState;
  canEdit: boolean;
  onStateChange: (st: OperatorState) => void;
}) {
  const [adding, setAdding] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    const pk = adding.trim();
    if (!pk || busy) return;
    setBusy(true);
    setError(null);
    try {
      const st = await setTeamMember(pk, "add");
      onStateChange(st);
      setAdding("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove(pubkey: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const st = await setTeamMember(pubkey, "remove");
      onStateChange(st);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="operator-section">
      <h3 className="operator-section-title">Curation team</h3>
      <p className="operator-hint">
        Team members can ban and curate. They shape every reader's Stacks page alongside the operator.
      </p>
      {state.curation_team.length === 0 ? (
        <p className="operator-empty">No curators yet.</p>
      ) : (
        <ul className="operator-list">
          {state.curation_team.map((pk) => (
            <li key={pk} className="operator-list-row">
              <code className="operator-pubkey">{shortNpub(pk)}</code>
              {canEdit && (
                <button
                  type="button"
                  className="operator-icon-btn"
                  title="Remove from team"
                  onClick={() => void remove(pk)}
                  disabled={busy}
                >
                  <UserMinus size={16} strokeWidth={1.75} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {canEdit && (
        <form className="operator-add" onSubmit={add}>
          <input
            className="operator-add-input"
            placeholder="pubkey (64-hex) to add"
            value={adding}
            onChange={(e) => setAdding(e.target.value)}
            disabled={busy}
          />
          <button type="submit" className="operator-add-btn" disabled={busy || !adding.trim()}>
            <UserPlus size={16} strokeWidth={1.75} />
            Add
          </button>
        </form>
      )}
      {error && <p className="operator-error">{error}</p>}
    </section>
  );
}

// --- moderation (ban list) ------------------------------------------------

function ModerationSection({
  state,
  onStateChange,
}: {
  state: OperatorState;
  onStateChange: (st: OperatorState) => void;
}) {
  const [adding, setAdding] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function ban(e: React.FormEvent) {
    e.preventDefault();
    const pk = adding.trim();
    if (!pk || busy) return;
    setBusy(true);
    setError(null);
    try {
      const st = await setBan(pk, "add");
      onStateChange(st);
      setAdding("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function unban(pubkey: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const st = await setBan(pubkey, "remove");
      onStateChange(st);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="operator-section">
      <h3 className="operator-section-title">
        <ShieldAlert size={16} strokeWidth={1.75} aria-hidden="true" /> Moderation
      </h3>
      <p className="operator-hint">
        Banned pubkeys are rejected on publish and their stored events are swept. Banning is reversible, but the sweep
        is immediate.
      </p>
      {state.banned.length === 0 ? (
        <p className="operator-empty">No one is banned.</p>
      ) : (
        <ul className="operator-list">
          {state.banned.map((pk) => (
            <li key={pk} className="operator-list-row">
              <code className="operator-pubkey">{shortNpub(pk)}</code>
              <button
                type="button"
                className="operator-icon-btn"
                title="Unban"
                onClick={() => void unban(pk)}
                disabled={busy}
              >
                <Trash2 size={16} strokeWidth={1.75} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <form className="operator-add" onSubmit={ban}>
        <input
          className="operator-add-input"
          placeholder="pubkey (64-hex) to ban"
          value={adding}
          onChange={(e) => setAdding(e.target.value)}
          disabled={busy}
        />
        <button type="submit" className="operator-add-btn operator-add-btn-danger" disabled={busy || !adding.trim()}>
          <Plus size={16} strokeWidth={1.75} />
          Ban
        </button>
      </form>
      {error && <p className="operator-error">{error}</p>}
    </section>
  );
}

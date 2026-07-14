import { useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import {
  listFriends,
  addFriend,
  removeFriend,
  setOwner,
  type FriendsState,
} from "./friends-store.js";
import { isTauri } from "./identity.js";
import { loadOrCreateVoice } from "./identity.js";
import { deriveOnionAddress } from "./onion-key.js";

/**
 * The friend-ACL management view (desktop only).
 *
 * The relay has two modes (see transport.md §5):
 *   - Open mode (default): no owner set, localhost trusted, no AUTH required.
 *   - Friend mode: owner pubkey set → relay requires NIP-42 AUTH, owner gets
 *     read+write, listed friends get read-only. This is the "serve your friends"
 *     posture — inbound via Tor, gated by pubkey.
 *
 * This view manages ~/.tracer/friends.json, which the relay polls every 5s.
 * Setting the owner (auto-filled with your manual-key pubkey) activates friend
 * mode. The .onion address shown is derived from the Nostr key (pure crypto —
 * no Tor needed to compute it; Tor just makes it reachable).
 */
export function FriendsView() {
  const [state, setState] = useState<FriendsState>({
    owner: "",
    friends: [],
    friendMode: false,
  });
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [onionAddress, setOnionAddress] = useState<string | null>(null);

  // Load friends state + derive the onion address (both desktop-only).
  useEffect(() => {
    if (!isTauri()) return;
    listFriends().then(setState).catch((e) => setError(String(e)));
    // The onion address is pure crypto — computable without Tor running.
    try {
      const { address } = deriveOnionAddress();
      setOnionAddress(address);
    } catch {
      // voice not yet generated — will compute on next render
    }
  }, []);

  async function onSetOwner() {
    setError(null);
    try {
      const pk = loadOrCreateVoice().publicKey;
      setState(await setOwner(pk));
    } catch (e) {
      setError(String(e));
    }
  }

  async function onAdd() {
    setError(null);
    const pk = draft.trim();
    if (!pk) return;
    try {
      setState(await addFriend(pk));
      setDraft("");
    } catch (e) {
      setError(String(e));
    }
  }

  async function onRemove(pubkey: string) {
    setError(null);
    try {
      setState(await removeFriend(pubkey));
    } catch (e) {
      setError(String(e));
    }
  }

  if (!isTauri()) {
    return (
      <section className="view-placeholder friends-view">
        <p className="view-placeholder-blurb">
          Friend management is desktop-only — it configures your local relay's
          access policy. Open this view in the desktop app.
        </p>
      </section>
    );
  }

  return (
    <section className="view-placeholder friends-view">
      <p className="view-placeholder-blurb">
        Who can reach your relay. In friend mode, the relay requires NIP-42 AUTH:
        you (the owner) get read+write, friends get read-only. Friends connect
        via your .onion address (Tor). See <code>protocol/transport.md</code>.
      </p>

      {onionAddress && (
        <div className="onion-address-display">
          <span className="onion-label">Your .onion address:</span>
          <code className="onion-addr">{onionAddress}</code>
          <span className="onion-hint">
            Derived from your Nostr key — no Tor needed to compute it. Start Tor
            to make it reachable.
          </span>
        </div>
      )}

      <div className="owner-section settings-row">
        <div className="owner-info">
          <span className="owner-label">Owner (you):</span>
          <code className="owner-pubkey" title={state.owner}>
            {state.owner ? `${state.owner.slice(0, 16)}…` : "(not set)"}
          </code>
        </div>
        <div className="owner-status">
          {state.friendMode ? (
            <span className="mode-badge active">friend mode active</span>
          ) : (
            <>
              <span className="mode-badge inactive">open mode</span>
              <button
                type="button"
                className="owner-activate-btn"
                onClick={onSetOwner}
              >
                Activate friend mode
              </button>
            </>
          )}
        </div>
      </div>

      {error && <div className="friends-error">{error}</div>}

      <ul className="friend-list">
        {state.friends.map((pk) => (
          <li key={pk} className="settings-row friend-row">
            <code className="friend-pubkey" title={pk}>
              {pk.slice(0, 24)}…{pk.slice(-8)}
            </code>
            <button
              type="button"
              className="friend-delete"
              title="Remove friend"
              onClick={() => onRemove(pk)}
            >
              <Trash2 size={16} strokeWidth={1.75} />
            </button>
          </li>
        ))}
        {state.friends.length === 0 && state.friendMode && (
          <li className="friend-empty">No friends yet — paste a pubkey below.</li>
        )}
      </ul>

      <form
        className="friend-add"
        onSubmit={(ev) => {
          ev.preventDefault();
          onAdd();
        }}
      >
        <input
          className="friend-add-input"
          type="text"
          placeholder="friend's pubkey (64 hex chars)"
          value={draft}
          onChange={(ev) => setDraft(ev.target.value)}
        />
        <button type="submit" className="friend-add-btn">
          <Plus size={16} strokeWidth={1.75} />
          <span>Add friend</span>
        </button>
      </form>
    </section>
  );
}

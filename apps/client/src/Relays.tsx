import { useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import {
  loadRelays,
  addRelay,
  removeRelay,
  setRelayRead,
  setRelayWrite,
  type RelayEntry,
} from "./relay-config.js";
import { isTauri } from "./identity.js";

/**
 * The relay configuration view.
 *
 * What this surfaces — and why:
 *
 *   - The "home" relay always leads the list and can never be removed — only
 *     toggled. What it is depends on the runtime: the bundled local sidecar
 *     (ws://127.0.0.1:4869) on desktop, the same-origin hosted relay the page
 *     is served from on the webapp. "Never removable" means exactly that: the
 *     delete button is disabled and removeRelay() refuses it, but the user can
 *     still turn off read, write, or both.
 *
 *   - Every relay — home or external — exposes two independent toggles: read
 *     and write. The two directions have different trust profiles (a relay you
 *     trust as a read source need not be a publish sink, and vice versa), so
 *     they're not folded into one role/on-off.
 *
 *   - External relays can be added/removed. This is the surface that makes
 *     writing "get out" — on desktop, add the hosted relay (or any Nostr
 *     relay) so saves sync off the machine; on the webapp, add third-party
 *     relays so writing federates beyond the host.
 *
 * The store is the source of truth (relay-config.ts persists to
 * localStorage); this component just renders + mutates it.
 */

export function RelaysView() {
  const [entries, setEntries] = useState<RelayEntry[]>(() => loadRelays());
  const [draftUrl, setDraftUrl] = useState("");

  // Re-sync if another view (or the same app in another tab) touched storage.
  useEffect(() => {
    const sync = () => setEntries(loadRelays());
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);

  function commit(next: RelayEntry[]) {
    setEntries(next);
  }

  function onAdd() {
    if (!draftUrl.trim()) return;
    commit(addRelay(draftUrl));
    setDraftUrl("");
  }

  return (
    <section className="view-placeholder relays-view">
      <p className="view-placeholder-blurb">
        Where your writing and its provenance get published. The home relay is{" "}
        {isTauri() ? "your machine" : "this site"}; external relays sync your
        work out to other devices and the network. Read and write are
        independent — turn either off per relay.
      </p>

      <p className="view-placeholder-blurb super-peer-note">
        {isTauri() && (
          <>
            A write-enabled external relay is your{" "}
            <strong>super-peer</strong> — a durable, always-online copy of your
            archive. When your desktop is offline, friends can still read your
            work from there. Any Nostr relay works; designate one you trust to
            hold your backup. See <code>protocol/transport.md</code> §2.
          </>
        )}
      </p>

      <ul className="relay-list">
        {entries.map((e) => (
          <li key={e.id} className={"settings-row relay-row" + (e.builtin ? " builtin" : "")}>
            <div className="relay-row-main">
              <span className="relay-url" title={e.url}>
                {e.url}
              </span>
              {e.builtin && (
                <span
                  className="relay-tag"
                  title={
                    isTauri()
                      ? "The bundled local sidecar relay on this machine"
                      : "The relay this site is hosted from"
                  }
                >
                  home
                </span>
              )}
            </div>
            <div className="relay-row-controls">
              <label className="relay-toggle">
                <input
                  type="checkbox"
                  checked={e.read}
                  onChange={(ev) => commit(setRelayRead(e.id, ev.target.checked))}
                />
                <span>read</span>
              </label>
              <label className="relay-toggle">
                <input
                  type="checkbox"
                  checked={e.write}
                  onChange={(ev) => commit(setRelayWrite(e.id, ev.target.checked))}
                />
                <span>write</span>
              </label>
              <button
                type="button"
                className="relay-delete"
                disabled={e.builtin}
                title={
                  e.builtin
                    ? "The home relay can be toggled but not removed"
                    : "Remove"
                }
                onClick={() => commit(removeRelay(e.id))}
              >
                <Trash2 size={16} strokeWidth={1.75} />
              </button>
            </div>
          </li>
        ))}
      </ul>

      <form
        className="relay-add"
        onSubmit={(ev) => {
          ev.preventDefault();
          onAdd();
        }}
      >
        <input
          className="relay-add-input"
          type="text"
          placeholder="wss://relay.example.com"
          value={draftUrl}
          onChange={(ev) => setDraftUrl(ev.target.value)}
        />
        <button type="submit" className="relay-add-btn">
          <Plus size={16} strokeWidth={1.75} />
          <span>Add</span>
        </button>
      </form>
    </section>
  );
}

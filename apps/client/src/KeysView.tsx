/**
 * The Keys view — the Nostr keychain. Promotes the `keys` nav entry from
 * placeholder to a real view, following the ModelsView.tsx precedent: a
 * self-contained <section className="view-placeholder"> that owns its hooks
 * and renders into the same shell CSS.
 *
 * Each key is a card showing its generative visual identity (the label set in
 * that key's font, on that key's bg, in that key's fg) plus its pubkey. This
 * view manages the keychain itself (create, restyle, copy, remove); which key
 * is the AUTHOR or MODEL voice is chosen in the ActionPalette, not here.
 *
 * Async state follows the sampler convention where applicable, but most actions
 * here are synchronous localStorage commits — there's no network round-trip, so
 * no `.sampler-status` is needed. No global toast system.
 */

import { useState } from "react";
import { Check, Copy, GripVertical, Palette, Plus, Trash2 } from "lucide-react";
import {
  addKey,
  fontCss,
  identityColors,
  KEYCHAIN_FONTS,
  keyNpub,
  keyNsec,
  loadKeys,
  patchKey,
  removeKey,
  rolesForKey,
  saveKeys,
  secretKeyForVoice,
  type KeyEntry,
  type KeyIdentity,
} from "./keys-store.js";
import { publishVoiceIdentity } from "./provenance.js";
import { loadDoors } from "./doors-store.js";

/** Alpha for the card swatch bg — denser than the editor-run bg (0.13). */
const CARD_BG_ALPHA = 0.22;

/** The four roles a key can hold, in display order. Role assignment lives at
 *  the point of use (the ActionPalette or Networking); this view only reports it. */
type RoleName = "NODE" | "AUTHOR" | "MODEL" | "DOOR";
const ALL_ROLES: RoleName[] = ["NODE", "AUTHOR", "MODEL", "DOOR"];

export function KeysView({
  onKeysChange,
}: {
  /** Called whenever the key list or a key's presentation changes. */
  onKeysChange: (keys: KeyEntry[]) => void;
}) {
  const [keys, setKeys] = useState<KeyEntry[]>(() => loadKeys());
  const [doors, setDoors] = useState(() => loadDoors());
  // The most-recently-copied value per card, for transient "copied" feedback.
  // Holds "npub" | "nsec"; clears on the next copy of either (or on timeout).
  const [copied, setCopied] = useState<Record<string, string>>({});
  // Which cards have their Style section unfolded. One toggle per card so a
  // user can compare two voices' settings side by side.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // The id of the key being dragged, or null. Held over the duration of a
  // drag-and-drop reorder so a card knows to dim itself while it's the source.
  const [dragId, setDragId] = useState<string | null>(null);

  /** The set of keyIds that are doors — passed to rolesForKey so it can badge
   *  keys without keys-store importing doors-store (which would be a cycle). */
  const doorKeyIds = new Set(doors.map((d) => d.keyId));

  // Move the key at `from` to `to`, persisting the new order through the same
  // saveKeys path add/remove use. The keychain's order is what the ActionPalette pen/
  // AUTHOR/MODEL selects render in, so a reorder there is reflected on next read.
  function reorderKeys(from: number, to: number) {
    if (from === to || from < 0 || to < 0 || from >= keys.length || to >= keys.length) return;
    const next = [...keys];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    saveKeys(next);
    setKeys(next);
    onKeysChange(next);
  }

  async function handleCopy(id: string, value: string, which: string) {
    // navigator.clipboard may be absent (insecure context) — fail quietly
    // rather than throwing; the value is still visible to copy manually.
    try {
      await navigator.clipboard?.writeText(value);
      setCopied((c) => ({ ...c, [id]: which }));
      setTimeout(() => {
        setCopied((c) => ({ ...c, [id]: "" }));
      }, 1200);
    } catch {
      /* clipboard unavailable — no-op */
    }
  }

  // Switching the AUTHOR/MODEL voice is done in the ActionPalette, not here — this view
  // only manages the keychain (create/restyle/copy/remove).

  function updateLabel(id: string, label: string) {
    // patchKey persists; refresh local state from its return and notify App.
    const next = patchKey(id, { label });
    setKeys(next);
    onKeysChange(next);
  }

  // Merge a partial identity patch onto the key's current identity and persist.
  // Same commit-on-each-change flow as updateLabel — the live preview swatch
  // reflects the change immediately because it reads from k.identity. The
  // schemaVersion gate in keys-store ensures manual identity edits survive
  // reloads (loadKeys only re-derives from the pubkey for pre-schema keys).
  // Restyling a key also broadcasts its identity as a kind-34292 replaceable
  // event so foreign readers render the chosen colors instead of the hash.
  // Fire-and-forget: the local swatch is already live; the relay publish is
  // best-effort and a failure only means a foreign reader sees the hash.
  function updateIdentity(id: string, partial: Partial<KeyIdentity>) {
    const cur = keys.find((k) => k.id === id)?.identity;
    if (!cur) return;
    const merged: KeyIdentity = { ...cur, ...partial };
    const next = patchKey(id, { identity: merged });
    setKeys(next);
    onKeysChange(next);
    const key = next.find((k) => k.id === id);
    const signer = key ? secretKeyForVoice(key.pubkey) : null;
    if (key && signer) {
      publishVoiceIdentity(merged, signer, key.pubkey).catch((e) =>
        console.warn(`[voice] identity publish failed for ${key.pubkey.slice(0, 8)}…:`, e),
      );
    }
  }

  function toggleStyle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function handleAdd() {
    const next = addKey();
    setKeys(next);
    onKeysChange(next);
  }

  function handleRemove(id: string) {
    const next = removeKey(id);
    setKeys(next);
    setDoors(loadDoors()); // prune any doors that referenced the deleted key
    onKeysChange(next);
  }

  return (
    <section className="view-placeholder keys-view">
      <p className="view-placeholder-blurb">
        Voices are different pens: each has its own visual style and Nostr signature.
      </p>

      <div className="keys-list">
        {keys.map((k) => {
          const isLast = keys.length <= 1;
          const isOpen = expanded.has(k.id);
          const { fg, bg } = identityColors(k.identity, CARD_BG_ALPHA);
          const npub = keyNpub(k);
          const nsec = keyNsec(k);
          const roles = rolesForKey(k.id, doorKeyIds);
          const activeRoles = ALL_ROLES.filter((role) =>
            role === "NODE" ? roles.node
            : role === "AUTHOR" ? roles.author
            : role === "MODEL" ? roles.model
            : roles.door,
          );
          return (
            <div
              key={k.id}
              className={"settings-card key-card" + (dragId === k.id ? " is-dragging" : "")}
              onDragOver={(e) => {
                // Allow a drop on this card; the reorder fires on drop using the
                // source index carried in dataTransfer.
                if (dragId !== null && dragId !== k.id) {
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                }
              }}
              onDrop={(e) => {
                const fromId = e.dataTransfer.getData("text/key-id");
                const from = keys.findIndex((x) => x.id === fromId);
                const to = keys.findIndex((x) => x.id === k.id);
                if (fromId && from !== -1 && to !== -1) reorderKeys(from, to);
              }}
            >
              <div
                className="drag-handle"
                title="Drag to reorder"
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = "move";
                  e.dataTransfer.setData("text/key-id", k.id);
                  setDragId(k.id);
                }}
                onDragEnd={() => setDragId(null)}
              >
                <GripVertical size={14} strokeWidth={1.75} aria-hidden="true" />
              </div>
              <div className="key-card-preview" style={{ color: fg, background: bg, fontFamily: k.identity.font }}>
                {k.label || "Voice"}
                <button
                  type="button"
                  className={"icon-btn key-style-toggle" + (isOpen ? " is-open" : "")}
                  title={isOpen ? "Hide style" : "Customize style"}
                  onClick={() => toggleStyle(k.id)}
                  aria-expanded={isOpen}
                >
                  <Palette size={13} aria-hidden="true" />
                </button>
              </div>
              <div className="key-card-meta">
                <div className="key-card-header">
                  <input
                    className="key-label-input"
                    value={k.label}
                    onChange={(e) => updateLabel(k.id, e.target.value)}
                    aria-label="Key label"
                  />
                  <div className="key-card-actions">
                    <button
                      type="button"
                      className="icon-btn key-delete"
                      title={isLast ? "Can't delete the last key" : "Remove key"}
                      onClick={() => handleRemove(k.id)}
                      disabled={isLast}
                    >
                      <Trash2 size={13} aria-hidden="true" />
                    </button>
                  </div>
                </div>
                {/* Role assignment is read-only here. Author/model are selected
                    in the ActionPalette; node/door assignments live in Networking. */}
                <div
                  className="key-card-roles"
                  aria-label={`Roles: ${activeRoles.length > 0 ? activeRoles.join(", ") : "none"}`}
                >
                  <span className="key-card-roles-label">roles</span>
                  {activeRoles.length > 0 ? activeRoles.map((role) => (
                    <span key={role} className="role-chip">{role}</span>
                  )) : (
                    <span className="key-card-roles-empty">none</span>
                  )}
                </div>
                <div className="key-value-row">
                  <span className="key-value-label">npub</span>
                  <code className="key-value-text" title={npub}>
                    {npub.slice(0, 16)}…{npub.slice(-8)}
                  </code>
                  <button
                    type="button"
                    className="icon-btn key-copy-btn"
                    title="Copy npub"
                    onClick={() => void handleCopy(k.id, npub, "npub")}
                  >
                    {copied[k.id] === "npub" ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
                  </button>
                </div>
                <div className="key-value-row">
                  <span className="key-value-label">nsec</span>
                  <code className="key-value-text" title={nsec}>
                    {"•".repeat(24)}
                  </code>
                  <button
                    type="button"
                    className="icon-btn key-copy-btn"
                    title="Copy nsec"
                    onClick={() => void handleCopy(k.id, nsec, "nsec")}
                  >
                    {copied[k.id] === "nsec" ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
                  </button>
                </div>
                {isOpen && (
                  <div className="key-card-style">
                    <div className="key-style-row">
                      <span className="key-style-label">font</span>
                      <select
                        className="key-style-select"
                        value={KEYCHAIN_FONTS.findIndex((f) => fontCss(f) === k.identity.font)}
                        onChange={(e) => {
                          const f = KEYCHAIN_FONTS[Number(e.target.value)];
                          if (f) updateIdentity(k.id, { font: fontCss(f) });
                        }}
                        style={{ fontFamily: k.identity.font }}
                        aria-label="Voice font"
                      >
                        {KEYCHAIN_FONTS.map((f, i) => (
                          <option key={f.family} value={i} style={{ fontFamily: fontCss(f) }}>
                            {f.family}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="key-style-row">
                      <span className="key-style-label">hue</span>
                      <input
                        type="range"
                        className="key-style-slider hue-slider"
                        min={0}
                        max={360}
                        value={k.identity.hue}
                        onChange={(e) => updateIdentity(k.id, { hue: Number(e.target.value) })}
                        aria-label="Voice hue"
                      />
                      <span className="key-style-value">{k.identity.hue}°</span>
                    </div>
                    <div className="key-style-row">
                      <span className="key-style-label">sat</span>
                      <input
                        type="range"
                        className="key-style-slider sat-slider"
                        min={0}
                        max={100}
                        value={k.identity.sat}
                        onChange={(e) => updateIdentity(k.id, { sat: Number(e.target.value) })}
                        aria-label="Voice saturation"
                      />
                      <span className="key-style-value">{k.identity.sat}%</span>
                    </div>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <button type="button" className="settings-add-btn keys-add" onClick={handleAdd}>
        <Plus size={14} strokeWidth={1.75} aria-hidden="true" />
        <span>Add voice</span>
      </button>
    </section>
  );
}

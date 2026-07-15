/**
 * The Keys view — the Nostr keychain. Promotes the `keys` nav entry from
 * placeholder to a real view, following the ModelsView.tsx precedent: a
 * self-contained <section className="view-placeholder"> that owns its hooks
 * and renders into the same shell CSS.
 *
 * Each key is a card showing its generative visual identity (the label set in
 * that key's font, on that key's bg, in that key's fg) plus its pubkey. This
 * view manages the keychain itself (create, restyle, copy, remove); which key
 * is the AUTHOR or MODEL voice is chosen in the TopBar, not here.
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
  setAuthorKeyId,
  setModelKeyId,
  setNodeKeyId,
  type KeyEntry,
  type KeyIdentity,
} from "./keys-store.js";
import { publishVoiceIdentity } from "./provenance.js";
import { loadDoors, addDoor, removeDoor } from "./doors-store.js";

/** Alpha for the card swatch bg — denser than the editor-run bg (0.13). */
const CARD_BG_ALPHA = 0.22;

/** The four roles a key can hold. NODE and AUTHOR changes are consequential
 *  (change your .onion / who signs new text) and are gated behind a confirm
 *  modal; MODEL and DOOR are safe to toggle freely. */
type RoleName = "NODE" | "AUTHOR" | "MODEL" | "DOOR";
const ALL_ROLES: RoleName[] = ["NODE", "AUTHOR", "MODEL", "DOOR"];

/** A pending role change awaiting user confirmation. Null when no modal open. */
interface PendingRoleChange {
  keyId: string;
  role: RoleName;
  /** The label of the key, for the confirm message. */
  keyLabel: string;
}

export function KeysView({
  onKeysChange,
}: {
  /** Called whenever the key list or role assignments change, so App re-reads. */
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
  // A pending consequential role change awaiting the confirm modal. Null when
  // no modal is open. MODEL and DOOR toggles don't set this — they're instant.
  const [pendingRole, setPendingRole] = useState<PendingRoleChange | null>(null);

  /** The set of keyIds that are doors — passed to rolesForKey so it can badge
   *  keys without keys-store importing doors-store (which would be a cycle). */
  const doorKeyIds = new Set(doors.map((d) => d.keyId));

  /** Refresh both keys and doors from storage, then notify App. Called after
   *  any role change so the TopBar selectors and the Networking view stay in
   *  sync with the new assignments. */
  function refreshAll() {
    const nextKeys = loadKeys();
    setKeys(nextKeys);
    setDoors(loadDoors());
    onKeysChange(nextKeys);
  }

  /** Apply a role change immediately (no confirm). Used for MODEL and DOOR, and
   *  as the "execute" step after the user confirms a NODE/AUTHOR change. */
  function applyRoleChange(keyId: string, role: RoleName, assign: boolean) {
    switch (role) {
      case "NODE":
        // Unassigning NODE isn't meaningful (it always falls back to the first
        // key), so "assign" means "set this key as NODE". We treat toggle-off
        // as a no-op rather than clearing the slot — there's always an owner.
        if (assign) setNodeKeyId(keyId);
        break;
      case "AUTHOR":
        if (assign) setAuthorKeyId(keyId);
        break;
      case "MODEL":
        if (assign) setModelKeyId(keyId);
        break;
      case "DOOR":
        if (assign) addDoor(keyId);
        else {
          const door = doors.find((d) => d.keyId === keyId);
          if (door) removeDoor(door.id);
        }
        break;
    }
    refreshAll();
  }

  /** Toggle a role on/off. Consequential roles (NODE, AUTHOR) route through the
   *  confirm modal; MODEL and DOOR are instant. */
  function toggleRole(keyId: string, role: RoleName, currentlyActive: boolean) {
    const keyLabel = keys.find((k) => k.id === keyId)?.label ?? "this key";
    const assign = !currentlyActive;
    // NODE and AUTHOR reassignment have provenance/reachability consequences —
    // gate behind the confirm modal.
    if ((role === "NODE" || role === "AUTHOR") && (currentlyActive || assign)) {
      // Only show the modal when *assigning* to a different key (reassigning)
      // or unassigning — both change behavior. First-time assign of NODE/AUTHOR
      // to a key that has no role is also consequential, so always gate.
      setPendingRole({ keyId, role, keyLabel });
      return;
    }
    applyRoleChange(keyId, role, assign);
  }

  /** The confirm message for a pending NODE/AUTHOR change. */
  function roleWarning(change: PendingRoleChange): string {
    if (change.role === "NODE") {
      return `Set "${change.keyLabel}" as the owner key (NODE)? This changes your .onion address — peers must re-share the new address to reach you. Existing zines keep their signatures.`;
    }
    // AUTHOR
    return `Set "${change.keyLabel}" as the author key (AUTHOR)? New text will be signed by this key. Existing zines keep their original signatures.`;
  }

  // Move the key at `from` to `to`, persisting the new order through the same
  // saveKeys path add/remove use. The keychain's order is what the TopBar pen/
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

  // Switching the AUTHOR/MODEL voice is done in the TopBar, not here — this view
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
    const next = addKey(`Voice ${keys.length + 1}`);
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
        Nostr keypairs (voices) you sign and attribute text with.
      </p>

      <div className="keys-list">
        {keys.map((k) => {
          const isLast = keys.length <= 1;
          const isOpen = expanded.has(k.id);
          const { fg, bg } = identityColors(k.identity, CARD_BG_ALPHA);
          const npub = keyNpub(k);
          const nsec = keyNsec(k);
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
                {/* Role chips — one per role, toggleable. Active roles are
                    filled; inactive are outlined. NODE/AUTHOR toggles route
                    through a confirm modal (consequential); MODEL/DOOR are
                    instant. */}
                <div className="key-card-roles">
                  {ALL_ROLES.map((role) => {
                    const roles = rolesForKey(k.id, doorKeyIds);
                    const active =
                      role === "NODE" ? roles.node
                      : role === "AUTHOR" ? roles.author
                      : role === "MODEL" ? roles.model
                      : roles.door;
                    return (
                      <button
                        key={role}
                        type="button"
                        className={"role-chip" + (active ? " active" : "")}
                        title={
                          role === "NODE"
                            ? active ? "Active owner key — click to change" : "Set as owner key (changes .onion)"
                            : role === "AUTHOR"
                              ? active ? "Active author key — click to change" : "Set as author key"
                              : role === "MODEL"
                                ? active ? "Active model key — click to change" : "Set as model key"
                                : active ? "Active door — click to remove" : "Add as door"
                        }
                        onClick={() => toggleRole(k.id, role, active)}
                      >
                        {role}
                      </button>
                    );
                  })}
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
        <span>Generate keypair</span>
      </button>

      {/* Confirm modal for consequential role changes (NODE / AUTHOR). Reuses
          the confirm-overlay/confirm-dialog classes from App.tsx so the style
          matches the existing delete-confirm modal. */}
      {pendingRole && (
        <div className="confirm-overlay" onClick={() => setPendingRole(null)}>
          <div className="confirm-dialog" onClick={(e) => e.stopPropagation()}>
            <p className="confirm-message">{roleWarning(pendingRole)}</p>
            <div className="confirm-actions">
              <button
                type="button"
                className="confirm-cancel"
                onClick={() => setPendingRole(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="confirm-delete"
                onClick={() => {
                  applyRoleChange(pendingRole.keyId, pendingRole.role, true);
                  setPendingRole(null);
                }}
              >
                Confirm
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

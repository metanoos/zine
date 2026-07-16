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
import {
  isTauri,
  resolveRelayUrl,
} from "./identity.js";
import {
  listPeers,
  addPeer,
  removePeer,
  addWriter,
  removeWriter,
  setOwner,
  type PeersState,
} from "./peers-store.js";
import { deriveOnionAddress, onionAddressForKey } from "./onion-key.js";
import {
  loadKeys,
  getNodeKeyId,
  setNodeKeyId,
  nodeVoice,
  getNodeKey,
  type KeyEntry,
} from "./keys-store.js";
import {
  loadDoors,
  addDoor,
  removeDoor,
  type DoorEntry,
} from "./doors-store.js";
import { detectCoCitations, type CoCitation } from "./co-citation.js";
import { addFollow, loadFollows, removeFollow, type FollowEntry } from "./follows-store.js";

type NetworkCategory = "node" | "seeds" | "following" | "peers" | "co-citations";

const NETWORK_CATEGORIES: Array<{
  id: NetworkCategory;
  label: string;
  description: string;
}> = [
  { id: "node", label: "Node", description: "This press and its doors" },
  { id: "seeds", label: "Seeds", description: "Durable relay copies" },
  { id: "following", label: "Following", description: "Whose work you read" },
  { id: "peers", label: "Peers", description: "Trusted access" },
  {
    id: "co-citations",
    label: "Co-citations",
    description: "Possible introductions",
  },
];

/**
 * The networking view — one surface for how this machine talks to the network.
 *
 * Five categories, one selected at a time:
 *
 *   - Node: this machine and every way to reach it. The owner-key picker
 *     (which keychain key owns the relay — signs NIP-42 AUTH, is the `owner`
 *     in peers.json), the local relay URL, the primary .onion, extra doors
 *     (additional .onion addresses, each from a different key, all forwarding
 *     to the same relay), and the Tor reachability gate.
 *
 *   - Seeds: the external relays your writing federates out to. Each keeps its
 *     independent read/write toggles. The Node is primary; seeds are durability
 *     backups — durable, always-online services peers can read when your
 *     desktop is offline.
 *
 *   - Peers (desktop only): who can reach your node — the networked-mode gate
 *     and the pubkey allowlist. On the webapp this is desktop-only, so the
 *     section shows a note instead.
 *
 *   - Following: a local, unilateral reader preference used by the shared
 *     Stacks/Times/Spaces query. It grants no access and publishes no ACL.
 *
 *   - Co-citations (desktop only): possible introductions between peers who
 *     quoted the same passages.
 *
 * An onion is a *door*, not an identity: the owner key is who you are (AUTH);
 * doors are where peers find you. Adding a door opens another address into the
 * same relay without granting owner privilege — so you can run several onions
 * at once and rotate without downtime.
 */
export function NetworkingView() {
  const [activeCategory, setActiveCategory] =
    useState<NetworkCategory>("node");

  // --- seeds (external relays) --------------------------------------------
  const [entries, setEntries] = useState<RelayEntry[]>(() => loadRelays());
  const [draftUrl, setDraftUrl] = useState("");

  useEffect(() => {
    const sync = () => setEntries(loadRelays());
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);

  function commitRelays(next: RelayEntry[]) {
    setEntries(next);
  }

  function onAddRelay() {
    if (!draftUrl.trim()) return;
    commitRelays(addRelay(draftUrl));
    setDraftUrl("");
  }

  const external = entries.filter((e) => !e.builtin);

  return (
    <section className="view-placeholder networking-view">
      <aside className="networking-categories">
        <p className="networking-intro">
          Where your writing lives, how it stays available, and who can reach
          it.
        </p>
        <nav className="networking-category-list" aria-label="Network categories">
          {NETWORK_CATEGORIES.map((category) => {
            const active = category.id === activeCategory;
            return (
              <button
                key={category.id}
                id={`network-category-${category.id}`}
                type="button"
                className={`networking-category${active ? " active" : ""}`}
                aria-current={active ? "page" : undefined}
                aria-controls={`network-panel-${category.id}`}
                onClick={() => setActiveCategory(category.id)}
              >
                <span className="networking-category-label">
                  {category.label}
                </span>
                <span className="networking-category-description">
                  {category.description}
                </span>
              </button>
            );
          })}
        </nav>
      </aside>

      <div className="networking-detail">
        <div className="networking-detail-inner">
          <div
            id="network-panel-node"
            role="region"
            aria-labelledby="network-category-node"
            hidden={activeCategory !== "node"}
          >
            {/* --- Node (the machine + all its addresses) --------------- */}
            <NodeSection />
          </div>

          <div
            id="network-panel-seeds"
            role="region"
            aria-labelledby="network-category-seeds"
            hidden={activeCategory !== "seeds"}
          >
            {/* --- Seeds (external relays) ------------------------------ */}
            <div className="networking-section">
              <h2 className="networking-section-title">Seeds</h2>
              <p className="networking-section-sub">
                Durable copies of your writing. Your node stays primary; seeds
                keep it readable while this desktop is offline.
              </p>

              {external.length === 0 ? (
                <p className="relay-empty">No seeds yet. Add one below.</p>
              ) : (
                <ul className="relay-list">
                  {external.map((e) => (
                    <li key={e.id} className="settings-row relay-row">
                      <div className="relay-row-main">
                        <span className="relay-url" title={e.url}>
                          {e.url}
                        </span>
                      </div>
                      <div className="relay-row-controls">
                        <label className="relay-toggle">
                          <input
                            type="checkbox"
                            checked={e.read}
                            onChange={(ev) =>
                              commitRelays(
                                setRelayRead(e.id, ev.target.checked),
                              )
                            }
                          />
                          <span>read</span>
                        </label>
                        <label className="relay-toggle">
                          <input
                            type="checkbox"
                            checked={e.write}
                            onChange={(ev) =>
                              commitRelays(
                                setRelayWrite(e.id, ev.target.checked),
                              )
                            }
                          />
                          <span>write</span>
                        </label>
                        <button
                          type="button"
                          className="relay-delete"
                          title="Remove"
                          onClick={() => commitRelays(removeRelay(e.id))}
                        >
                          <Trash2 size={16} strokeWidth={1.75} />
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}

              <form
                className="relay-add"
                onSubmit={(ev) => {
                  ev.preventDefault();
                  onAddRelay();
                }}
              >
                <input
                  className="relay-add-input"
                  type="text"
                  placeholder="wss://relay.example.com"
                  value={draftUrl}
                  onChange={(ev) => setDraftUrl(ev.target.value)}
                />
                <button type="submit" className="settings-add-btn">
                  <Plus size={16} strokeWidth={1.75} />
                  <span>Add seed</span>
                </button>
              </form>
            </div>
          </div>

          <div
            id="network-panel-following"
            role="region"
            aria-labelledby="network-category-following"
            hidden={activeCategory !== "following"}
          >
            <FollowingSection />
          </div>

          <div
            id="network-panel-peers"
            role="region"
            aria-labelledby="network-category-peers"
            hidden={activeCategory !== "peers"}
          >
            {/* --- Peers (desktop only) --------------------------------- */}
            <PeersSection />
          </div>

          <div
            id="network-panel-co-citations"
            role="region"
            aria-labelledby="network-category-co-citations"
            hidden={activeCategory !== "co-citations"}
          >
            {/* --- Co-citations (desktop only) -------------------------- */}
            <CoCitationsSection />
          </div>
        </div>
      </div>
    </section>
  );
}

/** Following answers "whose visible work do I want in my social views?" It is
 * intentionally independent from Peers, which answers "who may read my node?" */
function FollowingSection() {
  const [entries, setEntries] = useState<FollowEntry[]>(() => loadFollows());
  const [draft, setDraft] = useState("");
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const sync = () => setEntries(loadFollows());
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);

  function onAdd() {
    setError(null);
    if (!draft.trim()) return;
    try {
      setEntries(addFollow(draft, label));
      setDraft("");
      setLabel("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  return (
    <div className="networking-section">
      <h2 className="networking-section-title">Following</h2>
      <p className="networking-section-sub">
        A private reading list for Stacks, Times, and Spaces. Following someone does not make them a peer or let them read your node.
      </p>
      {error && <div className="peers-error">{error}</div>}
      <ul className="peer-list">
        {entries.map((entry) => (
          <li key={entry.pubkey} className="settings-row peer-row">
            <span>
              {entry.label && <strong className="follow-label">{entry.label}</strong>}
              <code className="peer-pubkey" title={entry.pubkey}>
                {entry.pubkey.slice(0, 24)}…{entry.pubkey.slice(-8)}
              </code>
            </span>
            <button
              type="button"
              className="peer-delete"
              title="Unfollow"
              onClick={() => setEntries(removeFollow(entry.pubkey))}
            >
              <Trash2 size={16} strokeWidth={1.75} />
            </button>
          </li>
        ))}
        {entries.length === 0 && <li className="peer-empty">Nobody followed yet.</li>}
      </ul>
      <form
        className="peer-add follow-add"
        onSubmit={(event) => {
          event.preventDefault();
          onAdd();
        }}
      >
        <input
          className="peer-add-input"
          type="text"
          placeholder="npub1… or hex pubkey"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        <input
          className="peer-add-input follow-label-input"
          type="text"
          placeholder="local label (optional)"
          value={label}
          onChange={(event) => setLabel(event.target.value)}
        />
        <button type="submit" className="settings-add-btn" disabled={!draft.trim()}>
          <Plus size={16} strokeWidth={1.75} />
          <span>Follow</span>
        </button>
      </form>
    </div>
  );
}

/**
 * Node section — this machine and every way to reach it. Owns the owner-key
 * picker, the local relay URL, the primary .onion, extra doors, and the Tor
 * reachability gate. Desktop only for the key/onion/Tor parts; the URL is
 * always shown.
 *
 * Two distinct concepts:
 *   - Owner key: who you ARE. Signs NIP-42 AUTH, is the `owner` in peers.json,
 *     owns networked mode. Single-valued.
 *   - Doors: where peers FIND you. Each is a .onion derived from a keychain
 *     key, forwarding to the same relay. Adding a door opens another address
 *     without granting owner privilege. See doors-store.ts.
 */
function NodeSection() {
  const desktop = isTauri();
  const homeUrl = resolveRelayUrl();

  const [error, setError] = useState<string | null>(null);
  const [onionAddress, setOnionAddress] = useState<string | null>(null);

  // Owner-key picker state.
  const [keys, setKeys] = useState<KeyEntry[]>(() => loadKeys());
  const [nodeKeyId, setNodeKeyIdState] = useState<string | null>(() => getNodeKeyId());

  // Doors state — extra .onion addresses, each derived from a different key.
  const [doors, setDoors] = useState<DoorEntry[]>(() => loadDoors());
  const [doorDraftKeyId, setDoorDraftKeyId] = useState<string>("");

  // Tor status tracks how many onions are live.
  const [torStatus, setTorStatus] = useState<
    { kind: "idle" } |
    { kind: "starting" } |
    { kind: "live"; addresses: string[] } |
    { kind: "error"; message: string }
  >({ kind: "idle" });

  useEffect(() => {
    // The owner's onion address is pure crypto — computable without Tor. It
    // follows the owner key, so recompute when the selection changes.
    try {
      const ownerKey = getNodeKey();
      const { address } = ownerKey
        ? deriveOnionAddress(ownerKey.secretHex)
        : deriveOnionAddress();
      setOnionAddress(address);
    } catch {
      // voice not yet generated — will compute on next render
    }
  }, [nodeKeyId]);

  /** Register one onion with Tor, verifying the reported address matches the
   *  crypto-derived one. Returns the address on success, throws on mismatch. */
  async function registerOnion(
    invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>,
    secretHex: string,
    expected: string,
  ): Promise<string> {
    const { seedBase64 } = onionAddressForKey(secretHex);
    const reported = (await invoke("setup_onion", { seedBase64 })) as string;
    if (reported !== expected) {
      throw new Error(
        `Tor reported ${reported} but the key derives ${expected}. Seed may be corrupted.`,
      );
    }
    return reported;
  }

  /** Changing the owner key re-derives the primary onion. In networked mode
   *  it also re-asserts the owner in peers.json so AUTH and the owner record
   *  agree with the new key — without this, onauth would sign with the new key
   *  while the relay still recognized the old one, locking you out of owner
   *  privilege. Doors are untouched: secondary .onions stay live, so this is
   *  zero-downtime rotation for the owner. */
  async function onNodeKeyChange(id: string) {
    setNodeKeyId(id);
    setNodeKeyIdState(id);
    setKeys(loadKeys());
    setError(null);
    try {
      const ownerKey = getNodeKey();
      const { address } = ownerKey
        ? deriveOnionAddress(ownerKey.secretHex)
        : deriveOnionAddress();
      setOnionAddress(address);
    } catch {
      setOnionAddress(null);
    }
    // The running primary onion (if any) was for the old key — reset so the
    // user re-starts to register the new one. Doors stay live.
    setTorStatus({ kind: "idle" });
    // Lockout fix: if networked mode is active, re-assert the owner so the
    // relay recognizes the new key. Without this onauth and peers.json diverge.
    // Read networkedMode from peers.json via listPeers.
    try {
      const ps = await listPeers();
      if (ps.networkedMode) {
        await setOwner(nodeVoice());
      }
    } catch {
      // non-Tauri or relay not up — best-effort
    }
  }

  /** Start Tor and register the owner's primary onion plus every door. */
  async function onStartTor() {
    setError(null);
    setTorStatus({ kind: "starting" });
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke<string>("spawn_tor");
      const ownerKey = getNodeKey();
      if (!ownerKey) throw new Error("no owner key set");
      const live: string[] = [];
      live.push(await registerOnion(invoke, ownerKey.secretHex, onionAddress ?? ""));
      const doorErrors: string[] = [];
      for (const door of doors) {
        const key = keys.find((k) => k.id === door.keyId);
        if (!key) continue;
        try {
          live.push(await registerOnion(invoke, key.secretHex, door.address));
        } catch (e) {
          doorErrors.push(`${key.label}: ${String(e)}`);
        }
      }
      if (doorErrors.length === doors.length && doors.length > 0) {
        setTorStatus({
          kind: "error",
          message: `Primary onion live, but all doors failed: ${doorErrors.join("; ")}`,
        });
        return;
      }
      setTorStatus({ kind: "live", addresses: live });
    } catch (e) {
      setTorStatus({ kind: "error", message: String(e) });
    }
  }

  /** Add a door: derive its onion from the chosen key, persist, and — if Tor
   *  is already live — register it on the fly. */
  async function onAddDoor() {
    if (!doorDraftKeyId) return;
    setError(null);
    const next = addDoor(doorDraftKeyId);
    setDoors(next);
    setDoorDraftKeyId("");
    if (torStatus.kind === "live") {
      const key = keys.find((k) => k.id === doorDraftKeyId);
      const door = next.find((d) => d.keyId === doorDraftKeyId);
      if (key && door) {
        try {
          const { invoke } = await import("@tauri-apps/api/core");
          const addr = await registerOnion(invoke, key.secretHex, door.address);
          setTorStatus({
            kind: "live",
            addresses: [...torStatus.addresses, addr],
          });
        } catch (e) {
          setError(`Door added but not yet reachable: ${String(e)}`);
        }
      }
    }
  }

  function onRemoveDoor(id: string) {
    setError(null);
    const removed = doors.find((d) => d.id === id);
    setDoors(removeDoor(id));
    if (torStatus.kind === "live" && removed) {
      setTorStatus({
        kind: "live",
        addresses: torStatus.addresses.filter((a) => a !== removed.address),
      });
    }
  }

  // Keys available to be added as doors: not the owner key, not already a door.
  const doorKeyIds = new Set(doors.map((d) => d.keyId));
  const availableDoorKeys = keys.filter(
    (k) => k.id !== nodeKeyId && !doorKeyIds.has(k.id),
  );
  const liveCount = torStatus.kind === "live" ? torStatus.addresses.length : 0;

  return (
    <div className="networking-section">
      <h2 className="networking-section-title">Node</h2>
      <p className="networking-section-sub">
        This press, its owner identity, and every address peers can use to find
        it.
      </p>

      {/* --- Local relay URL (always shown) ---------------------------- */}
      <div className="settings-row local-node-row">
        <div className="relay-row-main">
          <span className="relay-url" title={homeUrl}>
            {homeUrl}
          </span>
          <span
            className="relay-tag"
            title={
              desktop
                ? "The bundled local relay on this machine"
                : "The relay this site is hosted from"
            }
          >
            local
          </span>
        </div>
        <span className="local-node-hint">
          Always on — this is where your writing lives.
        </span>
      </div>

      {/* --- Owner key picker (desktop only) --------------------------- */}
      {desktop && (
        <>
          <div className="node-identity-section settings-row">
            <div className="node-identity-main">
              <label className="node-label" htmlFor="node-key-select">Owner key:</label>
              <select
                id="node-key-select"
                className="node-key-select"
                value={nodeKeyId ?? ""}
                onChange={(ev) => onNodeKeyChange(ev.target.value)}
              >
                {keys.map((k) => (
                  <option key={k.id} value={k.id}>
                    {k.label}
                  </option>
                ))}
              </select>
              <span className="node-hint">
                The key the relay recognizes as you — signs AUTH, owns networked mode.
                Doors (below) are extra addresses.
              </span>
            </div>
          </div>

          {/* --- Primary .onion + Tor reachability --------------------- */}
          {onionAddress && (
            <div className="onion-address-display">
              <span className="onion-label">Primary .onion (owner key):</span>
              <code className="onion-addr">{onionAddress}</code>
              <span className="onion-hint">
                Derived from the owner key — no Tor needed to compute it.
              </span>
              <div className="tor-status">
                {torStatus.kind === "idle" && (
                  <button
                    type="button"
                    className="tor-start-btn"
                    onClick={onStartTor}
                  >
                    Make reachable
                  </button>
                )}
                {torStatus.kind === "starting" && (
                  <span className="tor-badge starting">Starting Tor…</span>
                )}
                {torStatus.kind === "live" && (
                  <span className="tor-badge live" title={torStatus.addresses.join(", ")}>
                    ● Reachable — {liveCount} {liveCount === 1 ? "onion" : "onions"} live
                  </span>
                )}
                {torStatus.kind === "error" && (
                  <span className="tor-badge error" title={torStatus.message}>
                    Tor failed — {torStatus.message}
                  </span>
                )}
              </div>
            </div>
          )}

          {/* --- Doors (extra .onion addresses) ------------------------ */}
          <div className="doors-subsection">
            <h3 className="doors-subsection-title">Doors — extra .onion addresses</h3>
            <p className="networking-section-sub">
              Each door is another address into this same relay, derived from a different key. Add one before rotating the owner so peers can migrate without downtime.
            </p>
            {doors.length === 0 ? (
              <p className="relay-empty">No doors — the owner key's onion is the only address.</p>
            ) : (
              <ul className="door-list">
                {doors.map((d) => {
                  const key = keys.find((k) => k.id === d.keyId);
                  return (
                    <li key={d.id} className="settings-row door-row">
                      <div className="door-row-main">
                        <span className="door-label">{key?.label ?? "(deleted key)"}</span>
                        <code className="door-addr" title={d.address}>{d.address}</code>
                      </div>
                      <button
                        type="button"
                        className="door-delete"
                        title="Remove door"
                        onClick={() => onRemoveDoor(d.id)}
                      >
                        <Trash2 size={16} strokeWidth={1.75} />
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
            {availableDoorKeys.length > 0 && (
              <form
                className="door-add"
                onSubmit={(ev) => {
                  ev.preventDefault();
                  onAddDoor();
                }}
              >
                <select
                  className="door-add-select"
                  value={doorDraftKeyId}
                  onChange={(ev) => setDoorDraftKeyId(ev.target.value)}
                >
                  <option value="">Pick a key to add as a door…</option>
                  {availableDoorKeys.map((k) => (
                    <option key={k.id} value={k.id}>{k.label}</option>
                  ))}
                </select>
                <button type="submit" className="settings-add-btn" disabled={!doorDraftKeyId}>
                  <Plus size={16} strokeWidth={1.75} />
                  <span>Add door</span>
                </button>
              </form>
            )}
          </div>

          {error && <div className="peers-error">{error}</div>}
        </>
      )}
    </div>
  );
}

/**
 * Peers section — who can reach your node. Desktop only: it configures the
 * bundled relay's access policy via ~/.tracer/peers.json. On the webapp there
 * is no local node to gate, so it shows a note.
 */
function PeersSection() {
  const [state, setState] = useState<PeersState>({
    owner: "",
    peers: [],
    writers: [],
    networkedMode: false,
  });
  const [draft, setDraft] = useState("");
  const [writerDraft, setWriterDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isTauri()) return;
    listPeers().then(setState).catch((e) => setError(String(e)));
  }, []);

  async function onSetOwner() {
    setError(null);
    try {
      const pk = nodeVoice();
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
      setState(await addPeer(pk));
      setDraft("");
    } catch (e) {
      setError(String(e));
    }
  }

  async function onRemove(pubkey: string) {
    setError(null);
    try {
      setState(await removePeer(pubkey));
    } catch (e) {
      setError(String(e));
    }
  }

  async function onAddWriter() {
    setError(null);
    const pk = writerDraft.trim();
    if (!pk) return;
    try {
      setState(await addWriter(pk));
      setWriterDraft("");
    } catch (e) {
      setError(String(e));
    }
  }

  async function onRemoveWriter(pubkey: string) {
    setError(null);
    try {
      setState(await removeWriter(pubkey));
    } catch (e) {
      setError(String(e));
    }
  }

  if (!isTauri()) {
    return (
      <div className="networking-section">
        <h2 className="networking-section-title">Peers</h2>
        <p className="networking-section-sub">
          People allowed to connect directly to your node.
        </p>
        <p className="networking-desktop-note">
          Peer access is managed in the desktop app, where your local node is
          running.
        </p>
      </div>
    );
  }

  return (
    <div className="networking-section">
      <h2 className="networking-section-title">Peers</h2>
      <p className="networking-section-sub">
        Who can reach your node. Activate networked mode, then add the pubkeys you trust.
      </p>

      {/* --- Owner / networked-mode gate ---------------------------------- */}
      <div className="owner-section settings-row">
        <div className="owner-info">
          <span className="owner-label">Owner:</span>
          <code className="owner-pubkey" title={state.owner}>
            {state.owner ? `${state.owner.slice(0, 16)}…` : "(not set)"}
          </code>
        </div>
        <div className="owner-status">
          {state.networkedMode ? (
            <span className="mode-badge active">networked mode active</span>
          ) : (
            <>
              <span className="mode-badge inactive">local mode</span>
              <button
                type="button"
                className="owner-activate-btn"
                onClick={onSetOwner}
              >
                Activate networked mode
              </button>
            </>
          )}
        </div>
      </div>

      {error && <div className="peers-error">{error}</div>}

      <ul className="peer-list">
        {state.peers.map((pk) => (
          <li key={pk} className="settings-row peer-row">
            <code className="peer-pubkey" title={pk}>
              {pk.slice(0, 24)}…{pk.slice(-8)}
            </code>
            <button
              type="button"
              className="peer-delete"
              title="Remove peer"
              onClick={() => onRemove(pk)}
            >
              <Trash2 size={16} strokeWidth={1.75} />
            </button>
          </li>
        ))}
        {state.peers.length === 0 && state.networkedMode && (
          <li className="peer-empty">No peers yet — paste an npub or pubkey below.</li>
        )}
      </ul>

      <form
        className="peer-add"
        onSubmit={(ev) => {
          ev.preventDefault();
          onAdd();
        }}
      >
        <input
          className="peer-add-input"
          type="text"
          placeholder="Paste their npub1… or hex pubkey"
          value={draft}
          onChange={(ev) => setDraft(ev.target.value)}
        />
        <button type="submit" className="settings-add-btn">
          <Plus size={16} strokeWidth={1.75} />
          <span>Add peer</span>
        </button>
      </form>

      <h3 className="networking-subsection-title">Headless writers</h3>
      <p className="networking-section-sub">
        Agent presses that may read and publish only events signed by their own key.
      </p>
      <ul className="peer-list">
        {state.writers.map((pk) => (
          <li key={pk} className="settings-row peer-row">
            <code className="peer-pubkey" title={pk}>
              {pk.slice(0, 24)}…{pk.slice(-8)}
            </code>
            <button
              type="button"
              className="peer-delete"
              title="Remove writer"
              onClick={() => onRemoveWriter(pk)}
            >
              <Trash2 size={16} strokeWidth={1.75} />
            </button>
          </li>
        ))}
        {state.writers.length === 0 && state.networkedMode && (
          <li className="peer-empty">No headless writers authorized.</li>
        )}
      </ul>
      <form
        className="peer-add"
        onSubmit={(ev) => {
          ev.preventDefault();
          onAddWriter();
        }}
      >
        <input
          className="peer-add-input"
          type="text"
          placeholder="Paste the agent’s npub1… or hex pubkey"
          value={writerDraft}
          onChange={(ev) => setWriterDraft(ev.target.value)}
        />
        <button type="submit" className="settings-add-btn">
          <Plus size={16} strokeWidth={1.75} />
          <span>Add writer</span>
        </button>
      </form>
    </div>
  );
}

/**
 * Co-citations section — the v1 rendezvous surface (protocol/rendezvous.md §4).
 *
 * For each pair of peers who both cited the same trace,
 * shows an introduction card: the two pubkeys, how many passages they share,
 * and a sample of the shared text. The introducer brokers but does not admit —
 * adding either peer to the other's list stays a separate human act in the
 * Peers section above.
 *
 * Desktop-only (peers are desktop-only). Runs the detection sweep on mount and
 * every 5 minutes, mirroring the anchor-upgrade interval pattern. A peer's
 * chain is readable only if replicated to a seed this machine reads — the honest
 * v1 boundary noted in co-citation.ts.
 */
function CoCitationsSection() {
  const [matches, setMatches] = useState<CoCitation[]>([]);
  const [status, setStatus] = useState<"idle" | "scanning" | "done" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;

    const run = async () => {
      setStatus("scanning");
      setError(null);
      try {
        const { peers } = await listPeers();
        if (peers.length < 2) {
          if (!cancelled) {
            setMatches([]);
            setStatus("done");
          }
          return;
        }
        const results = await detectCoCitations(peers);
        if (!cancelled) {
          setMatches(results);
          setStatus("done");
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
          setStatus("error");
        }
      }
    };

    void run();
    const interval = window.setInterval(run, 5 * 60 * 1000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  if (!isTauri()) {
    return (
      <div className="networking-section">
        <h2 className="networking-section-title">Co-citations</h2>
        <p className="networking-section-sub">
          Possible introductions between peers who cited the same traces.
        </p>
        <p className="networking-desktop-note">
          Co-citations are scanned in the desktop app, where peer chains are
          available.
        </p>
      </div>
    );
  }

  return (
    <div className="networking-section">
      <h2 className="networking-section-title">Co-citations</h2>
      <p className="networking-section-sub">
        Pairs of your peers who cited the same traces — a signal they might
        know each other. You broker the intro; adding them stays your call in
        Peers above.
      </p>

      {status === "scanning" && (
        <p className="cocitation-status">Scanning peer chains…</p>
      )}
      {status === "error" && (
        <p className="cocitation-error" role="alert">
          Scan failed: {error}
        </p>
      )}
      {status === "done" && matches.length === 0 && (
        <p className="cocitation-empty">
          No co-citations found among your peers yet.
        </p>
      )}

      {matches.length > 0 && (
        <ul className="cocitation-list">
          {matches.map((m) => (
            <li key={`${m.peerA}-${m.peerB}`} className="cocitation-card settings-card">
              <div className="cocitation-pair">
                <span className="cocitation-pubkey" title={m.peerA}>
                  {m.peerA.slice(0, 12)}…
                </span>
                <span className="cocitation-shared-count">
                  {m.targetIds.length} shared {m.targetIds.length === 1 ? "trace" : "traces"}
                </span>
                <span className="cocitation-pubkey" title={m.peerB}>
                  {m.peerB.slice(0, 12)}…
                </span>
              </div>
              {m.samples.slice(0, 3).map((s) => (
                <blockquote key={s.nodeId} className="cocitation-sample">
                  {s.text ?? `trace ${s.nodeId.slice(0, 12)}…`}
                </blockquote>
              ))}
              {m.samples.length > 3 && (
                <p className="cocitation-more">
                  +{m.samples.length - 3} more
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

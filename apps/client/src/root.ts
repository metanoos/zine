/**
 * The install root — the single home for everything this install writes. One
 * root per browser/machine profile, minted on first boot and reopened on every
 * ordinary boot thereafter. It is never unmounted or switched away from. An
 * explicit factory reset is the one lifecycle boundary: it clears the whole
 * profile and the local relay, then the next boot mints a different root.
 *
 * Identity is the genesis node's event id (protocol §3.1: trace identity IS
 * the genesis node id), minted via `createFolderGenesis`. That id is stored
 * durably in TWO places:
 *   - the relay: the genesis + its append-only chain (the real record); and
 *   - this localStorage slot, the local pointer that lets every boot reopen
 *     the exact same root without re-minting.
 *
 * WRITE-ONCE within one install lifecycle. `mintRoot` guards against a
 * double-mint by refusing to overwrite an existing id. Factory reset is not a
 * mutation of that root: App.tsx erases the entire local profile and sidecar
 * history, so the following first-run boot creates a new lifecycle and a new
 * genesis id. The `label` field is the one ordinarily mutable field — it's the
 * cosmetic display name, changeable via `setRootLabel` (the sidebar's root
 * rename).
 *
 * The root is pathless: it has no disk directory. All writes go to the relay
 * + the localStorage crash pad (the local/relay workspace backend). Disk is
 * touched only by Scan (acquire) and Reify (emit) gestures.
 */

import { createFolderGenesis } from "./provenance.js";
import { loadLocalFolder, saveLocalFile } from "./local-store.js";
import { addKey, getAuthorKey, getModelKeyId, loadKeys, type KeyEntry } from "./keys-store.js";

const ROOT_KEY = "zine.root";
const MINT_KEY_PREFIX = "zine.mint.";
const pendingMintFolders = new Map<string, Promise<string>>();

/** The default display name for the root. The user can rename it (the label
 *  is mutable); only the id is permanent. */
export const DEFAULT_ROOT_LABEL = "root";

/** The small starter document installed into each newly minted Root. A slash-
 *  joined path is the local-primary workspace's folder representation, so this
 *  appears as `wokspace` containing `ayoo-world.md` in the tree. */
export const FACTORY_ROOT_FILE_PATH = "wokspace/ayoo-world.md";
export const FACTORY_ROOT_FILE_CONTENT = "ayoooo, world!\n\n";

/** Use a spare voice for system-provided starter prose, keeping the seed text
 *  distinct from both AUTHOR and MODEL. Older profiles without a spare fall
 *  back to MODEL; legacy single-key profiles mint an alternate neutral voice. */
function factoryRootVoice(): KeyEntry {
  const keys = loadKeys();
  const authorId = getAuthorKey()?.id;
  const modelId = getModelKeyId();
  const alternate = keys.find(
    (key) =>
      key.id !== authorId &&
      key.id !== modelId &&
      /^voice-\d+$/i.test(key.label.trim()),
  );
  if (alternate) return alternate;
  const model = keys.find((key) => key.id === modelId && key.id !== authorId);
  if (model) return model;
  const withAlternate = addKey();
  return withAlternate[withAlternate.length - 1]!;
}

/** Seed the starter document locally without ever replacing user content.
 *  Its empty node id marks it as not yet stepped; workspace attach resumes
 *  that initial relay publication while still allowing an offline first boot. */
export function preloadFactoryRoot(rootId: string): void {
  if (loadLocalFolder(rootId)?.files[FACTORY_ROOT_FILE_PATH]) return;
  const voice = factoryRootVoice();
  saveLocalFile(rootId, FACTORY_ROOT_FILE_PATH, {
    content: FACTORY_ROOT_FILE_CONTENT,
    tags: [],
    nodeId: "",
    runs: [{ voice: voice.pubkey, text: FACTORY_ROOT_FILE_CONTENT }],
    voicePubkey: voice.pubkey,
  });
}

/** The current install root's id, or null on first boot (including the first
 *  boot after factory reset). Never clears the key on malformed storage — a
 *  bad read is treated as absent so the next boot re-mints. */
export function getRootId(): string | null {
  const raw = localStorage.getItem(ROOT_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { id?: unknown };
    if (typeof parsed.id === "string" && parsed.id.length > 0) return parsed.id;
  } catch {
    // fall through — malformed entry is treated as absent.
  }
  return null;
}

/** The root's stored display label (the user may have renamed it), or null if
 *  unset — callers fall back to DEFAULT_ROOT_LABEL. The label is the only
 *  mutable field on the root record; the id is permanent. */
export function getRootLabel(): string | null {
  const raw = localStorage.getItem(ROOT_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { label?: unknown };
    if (typeof parsed.label === "string" && parsed.label.length > 0) return parsed.label;
  } catch {
    // fall through.
  }
  return null;
}

/** Mint the install root: publish its genesis node, persist the returned event
 *  id to `zine.root`, and return it. Idempotent within an install lifecycle —
 *  if a root already exists, returns the existing id without minting again
 *  (guards against a double-mint racing two boot paths). */
export async function mintRoot(): Promise<string> {
  const existing = getRootId();
  if (existing) return existing;
  const id = await createFolderGenesis();
  localStorage.setItem(ROOT_KEY, JSON.stringify({ id }));
  preloadFactoryRoot(id);
  return id;
}

/** The dedicated Mint folder mounted beside an install root. Mint is a real
 *  folder trace, but deliberately is not a member of Root: otherwise sending a
 *  later Root manifest could reveal the complete private Mint inventory. The
 *  pointer is local installation state; cited Mint members remain resolvable
 *  by node id if the author explicitly sends them. */
export function getMintFolderId(rootId: string): string | null {
  const id = localStorage.getItem(`${MINT_KEY_PREFIX}${rootId}`);
  return id && id.length > 0 ? id : null;
}

/** Return this Root's dedicated Mint folder, creating its local-only genesis
 *  once. The in-flight promise prevents two rapid mint gestures from creating
 *  competing folders before the pointer has been persisted. */
export async function getOrCreateMintFolder(
  rootId: string,
  signer?: Uint8Array,
): Promise<string> {
  const existing = getMintFolderId(rootId);
  if (existing) return existing;
  const pending = pendingMintFolders.get(rootId);
  if (pending) return pending;

  const creating = createFolderGenesis({ signer, localOnly: true })
    .then((id) => {
      localStorage.setItem(`${MINT_KEY_PREFIX}${rootId}`, id);
      return id;
    })
    .finally(() => {
      pendingMintFolders.delete(rootId);
    });
  pendingMintFolders.set(rootId, creating);
  return creating;
}

/** Rename the root's display label. The id is never touched — only the
 *  cosmetic `label` field on the stored record changes. Used by the sidebar's
 *  root-node rename action. */
export function setRootLabel(label: string): void {
  const id = getRootId();
  if (!id) return; // no root yet — nothing to label
  localStorage.setItem(ROOT_KEY, JSON.stringify({ id, label }));
}

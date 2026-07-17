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
import {
  getAuthorKey,
  secretKeyForVoice,
} from "./keys-store.js";

const ROOT_KEY = "zine.root";
const MINT_KEY_PREFIX = "zine.mint.";
const SCAN_KEY_PREFIX = "zine.scan.";
const pendingMintFolders = new Map<string, Promise<string>>();
const pendingScanFolders = new Map<string, Promise<string>>();

/** The default display name for the root. The user can rename it (the label
 *  is mutable); only the id is permanent. */
export const DEFAULT_ROOT_LABEL = "root";

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

/** Root is an AUTHOR-owned container. Resolve that role explicitly instead of
 * using the separate browser/headless session identity. */
export function rootAuthorSigner(): Uint8Array {
  const author = getAuthorKey();
  const signer = author ? secretKeyForVoice(author.pubkey) : null;
  if (!signer) throw new Error("Cannot mint Root: the AUTHOR signing key is unavailable.");
  return signer;
}

/** Mint the install root: publish its genesis node, persist the returned event
 *  id to `zine.root`, and return it. Idempotent within an install lifecycle —
 *  if a root already exists, returns the existing id without minting again
 *  (guards against a double-mint racing two boot paths). */
export async function mintRoot(): Promise<string> {
  const existing = getRootId();
  if (existing) return existing;
  const id = await createFolderGenesis({ signer: rootAuthorSigner() });
  localStorage.setItem(ROOT_KEY, JSON.stringify({ id }));
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

/** The dedicated Scan folder mounted beside Root. It is deliberately local
 * only and author-owned: imported file nodes retain the substrate's signature,
 * while the private intake inventory remains under the Root owner's control
 * and cannot leak through a later Root Send. */
export function getScanFolderId(rootId: string): string | null {
  const id = localStorage.getItem(`${SCAN_KEY_PREFIX}${rootId}`);
  return id && id.length > 0 ? id : null;
}

/** Return this Root's dedicated local-only Scan folder, creating its genesis
 * exactly once under the supplied Root-owner key. */
export async function getOrCreateScanFolder(
  rootId: string,
  signer?: Uint8Array,
): Promise<string> {
  const existing = getScanFolderId(rootId);
  if (existing) return existing;
  const pending = pendingScanFolders.get(rootId);
  if (pending) return pending;

  const creating = createFolderGenesis({
    signer: signer ?? rootAuthorSigner(),
    localOnly: true,
  })
    .then((id) => {
      localStorage.setItem(`${SCAN_KEY_PREFIX}${rootId}`, id);
      return id;
    })
    .finally(() => {
      pendingScanFolders.delete(rootId);
    });
  pendingScanFolders.set(rootId, creating);
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

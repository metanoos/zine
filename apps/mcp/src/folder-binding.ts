/**
 * Resolve the optional source-folder flow into a chain the headless agent may
 * own. The normal flow below mints/reopens a profile-owned Root instead.
 *
 * Protocol traces have one owner. A fresh MCP key therefore cannot append to
 * the human folder id copied from the desktop app. The first bind creates a
 * shallow, local-only folder fork under the agent key and remembers that
 * source→fork mapping in the MCP config's localStorage. Later runs reuse the
 * fork; a changed agent key invalidates the mapping and creates a new fork.
 */
import {
  createFolderGenesis,
  eventMeta,
  fetchEventById,
  forkFolder,
} from "../../client/src/provenance.js";

const FORK_PREFIX = "zine.mcp.folder-fork.";
const ROOT_KEY = "zine.mcp.root";

export interface FolderBinding {
  sourceFolderId: string;
  folderId: string;
  forked: boolean;
  reused: boolean;
}

interface StoredAgentRoot {
  id: string;
  ownerPubkey: string;
}

export function storedAgentRoot(): StoredAgentRoot | null {
  const raw = localStorage.getItem(ROOT_KEY);
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("the persisted headless Root pointer is corrupt JSON");
  }
  const root = parsed as Partial<StoredAgentRoot>;
  if (
    typeof root.id !== "string" ||
    !/^[0-9a-f]{64}$/.test(root.id) ||
    typeof root.ownerPubkey !== "string" ||
    !/^[0-9a-f]{64}$/.test(root.ownerPubkey)
  ) {
    throw new Error("the persisted headless Root pointer has an invalid shape");
  }
  return root as StoredAgentRoot;
}

function rememberAgentRoot(root: StoredAgentRoot): void {
  localStorage.setItem(ROOT_KEY, JSON.stringify(root));
}

export function storedFolderFork(sourceFolderId: string): string | null {
  const value = localStorage.getItem(FORK_PREFIX + sourceFolderId);
  return value && /^[0-9a-f]{64}$/.test(value) ? value : null;
}

export function rememberFolderFork(sourceFolderId: string, folderId: string): void {
  localStorage.setItem(FORK_PREFIX + sourceFolderId, folderId);
}

async function folderGenesisOwner(folderId: string): Promise<string | null> {
  const genesis = await fetchEventById(folderId);
  if (!genesis || genesis.kind !== 4290 || eventMeta(genesis).z !== "folder") return null;
  return genesis.pubkey;
}

export async function resolveFolderBinding(
  sourceFolderId: string,
  agentPubkey: string,
  signer: Uint8Array,
): Promise<FolderBinding> {
  const remembered = storedFolderFork(sourceFolderId);
  if (remembered) {
    const rememberedOwner = await folderGenesisOwner(remembered);
    if (rememberedOwner === agentPubkey) {
      return {
        sourceFolderId,
        folderId: remembered,
        forked: true,
        reused: true,
      };
    }
    localStorage.removeItem(FORK_PREFIX + sourceFolderId);
  }

  const sourceOwner = await folderGenesisOwner(sourceFolderId);
  if (!sourceOwner) {
    throw new Error(`cannot verify owner of source folder ${sourceFolderId} on the local home relay`);
  }
  if (sourceOwner === agentPubkey) {
    return {
      sourceFolderId,
      folderId: sourceFolderId,
      forked: false,
      reused: false,
    };
  }

  const fork = await forkFolder(sourceFolderId, {
    signer,
    localOnly: true,
  });
  rememberFolderFork(sourceFolderId, fork.id);
  return {
    sourceFolderId,
    folderId: fork.id,
    forked: true,
    reused: false,
  };
}

/** Resolve the headless press workspace. With no source, each persisted MCP
 * profile owns one pathless Root. Supplying a source preserves the explicit
 * fork-on-bind flow without making a human folder a startup prerequisite. */
export async function resolveWorkspaceBinding(
  sourceFolderId: string | undefined,
  agentPubkey: string,
  signer: Uint8Array,
): Promise<FolderBinding> {
  if (sourceFolderId) return resolveFolderBinding(sourceFolderId, agentPubkey, signer);

  const stored = storedAgentRoot();
  if (stored) {
    if (stored.ownerPubkey !== agentPubkey) {
      throw new Error(
        `the persisted Root ${stored.id} belongs to a different agent key; use another profile`,
      );
    }
    return {
      sourceFolderId: stored.id,
      folderId: stored.id,
      forked: false,
      reused: true,
    };
  }

  const id = await createFolderGenesis({ signer, localOnly: true });
  rememberAgentRoot({ id, ownerPubkey: agentPubkey });
  return {
    sourceFolderId: id,
    folderId: id,
    forked: false,
    reused: false,
  };
}

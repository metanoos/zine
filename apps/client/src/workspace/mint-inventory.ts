import { MINT, isMintPath } from "./generated-paths.js";
import { flattenRuns, type FileState } from "./workspace-core.js";

/** One immutable Coin currently materialized in the Press's Mint directory. */
export interface MintCoinReference {
  path: string;
  nodeId: string;
  text: string;
}

/**
 * Read the authoritative local Coin inventory from Mint-backed FileState.
 *
 * Generated Mint names begin with a fixed-width local timestamp, so reverse
 * lexical path order presents the newest Coins first without inventing a
 * second collection index. Folder placeholders, empty drafts, and unstepped
 * files are not citable Coins.
 */
export function listMintCoins(
  files: Readonly<Record<string, FileState>>,
): MintCoinReference[] {
  return Object.entries(files)
    .flatMap(([path, file]) => {
      const text = flattenRuns(file.runs);
      return path !== MINT &&
        isMintPath(path) &&
        file.kind !== "folder" &&
        file.nodeId.length > 0 &&
        text.length > 0
        ? [{ path, nodeId: file.nodeId, text }]
        : [];
    })
    .sort((a, b) => a.path === b.path ? 0 : a.path < b.path ? 1 : -1);
}

/** Format the bounded Mint inventory supplied to Reply as citable traces. */
export function renderMintCoinReferences(
  coins: readonly MintCoinReference[],
  limit = 20,
): string {
  return coins
    .slice(0, Math.max(0, limit))
    .map((coin) => `- "${coin.text}" (nodeId ${coin.nodeId})`)
    .join("\n");
}

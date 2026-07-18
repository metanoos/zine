/**
 * Pure directory-tree activation routing.
 *
 * A rendered tree node is the source of truth for whether a row is a file or
 * folder. Reconstructing that type from workspace membership loses synthetic
 * nodes, most visibly the always-present empty `oblivion` folder.
 */

import { isOblivionPath } from "./generated-paths.js";

export interface ActivatableTreeItem {
  path: string;
  type: "file" | "folder";
  /** Mint entries remain file-shaped in storage but activate as Coins in UI. */
  systemKind?: "root" | "mint" | "minted" | "mint-pending" | "scan" | "oblivion";
}

export interface TreeActivationHandlers {
  file: (path: string) => void;
  folder: (path: string) => void;
  coin: (path: string) => void;
}

/** Activate a working item from a plain row click using row metadata. */
export function activateTreeItem(
  item: ActivatableTreeItem,
  handlers: TreeActivationHandlers,
): void {
  if (item.systemKind === "minted") {
    handlers.coin(item.path);
    return;
  }
  if (item.type === "file" && isOblivionPath(item.path)) {
    // Oblivion rows are selection-only. Their read-only modal is an explicit
    // Inspect action in the context menu, not a side effect of selection.
    return;
  }
  handlers[item.type](item.path);
}

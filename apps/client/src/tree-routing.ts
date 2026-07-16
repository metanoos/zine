/**
 * Pure directory-tree activation routing.
 *
 * A rendered tree node is the source of truth for whether a row is a file or
 * folder. Reconstructing that type from workspace membership loses synthetic
 * nodes, most visibly the always-present empty `oblivion` folder.
 */

export interface ActivatableTreeItem {
  path: string;
  type: "file" | "folder";
}

export interface TreeActivationHandlers {
  file: (path: string) => void;
  folder: (path: string) => void;
}

/** Activate exactly one handler using the type already carried by the row. */
export function activateTreeItem(
  item: ActivatableTreeItem,
  handlers: TreeActivationHandlers,
): void {
  handlers[item.type](item.path);
}

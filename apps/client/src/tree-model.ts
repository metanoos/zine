/** Pure construction and ordering rules for the Press directory tree. */

import {
  MINT,
  OBLIVION,
  isMintPath,
  isOblivionPath,
} from "./generated-paths.js";

export interface TreeEntry {
  path: string;
  type: "file" | "folder";
  attestations?: number;
}

export interface TreeNode {
  name: string;
  path: string;
  type: "file" | "folder";
  children?: TreeNode[];
  /** True only for the three synthetic top-level region nodes. */
  isRoot?: boolean;
  /** Stable semantic glyph for system regions and immutable Mint children. */
  systemKind?: "root" | "mint" | "minted" | "oblivion";
  /** Attestation events currently reachable from this press's read relays. */
  attestations?: number;
}

function standardTreeOrder(a: TreeNode, b: TreeNode): number {
  return a.type !== b.type
    ? (a.type === "folder" ? -1 : 1)
    : a.name.localeCompare(b.name);
}

/**
 * Build one region's nested tree. Ordinary regions use folder-first A-Z at
 * every level. Generated regions put only their direct children newest-first:
 * their generated names begin with fixed-width local timestamps, so reverse
 * name order is reverse chronological without adding UI-only date state.
 */
export function buildTree(
  entries: readonly TreeEntry[],
  basePath = "",
  markFilesAsMinted = false,
  newestFirst = false,
): TreeNode[] {
  const root: TreeNode = { name: "", path: basePath, type: "folder", children: [] };
  for (const { path, type, attestations } of entries) {
    const relativePath = basePath && path.startsWith(basePath + "/")
      ? path.slice(basePath.length + 1)
      : path;
    const parts = relativePath.split("/").filter(Boolean);
    if (!parts.length) continue;
    let cur = root;
    let acc = basePath;
    parts.forEach((part, i) => {
      acc = acc ? `${acc}/${part}` : part;
      const isLast = i === parts.length - 1;
      const leafType: "file" | "folder" = isLast ? type : "folder";
      let child = cur.children!.find((candidate) => candidate.name === part);
      if (!child) {
        child = {
          name: part,
          path: acc,
          type: leafType,
          children: leafType === "folder" ? [] : undefined,
          ...(markFilesAsMinted && leafType === "file"
            ? { systemKind: "minted" as const }
            : {}),
        };
        cur.children!.push(child);
      }
      if (isLast) {
        if (attestations !== undefined) child.attestations = attestations;
      }
      cur = child;
    });
  }

  function sortNode(node: TreeNode, sortNewestHere: boolean): void {
    if (!node.children?.length) return;
    node.children.sort((a, b) =>
      sortNewestHere ? b.name.localeCompare(a.name) : standardTreeOrder(a, b),
    );
    for (const child of node.children) sortNode(child, false);
  }

  sortNode(root, newestFirst);
  return root.children!;
}

/** Build the three fixed top-level regions in their product-defined order. */
export function buildDirectoryTree(
  entries: readonly TreeEntry[],
  rootLabel: string,
): TreeNode[] {
  const mintEntries = entries.filter((entry) => isMintPath(entry.path));
  const oblivionEntries = entries.filter((entry) => isOblivionPath(entry.path));
  const rootEntries = entries.filter(
    (entry) => !isMintPath(entry.path) && !isOblivionPath(entry.path),
  );

  return [
    {
      name: rootLabel,
      path: "",
      type: "folder",
      isRoot: true,
      systemKind: "root",
      children: buildTree(rootEntries),
    },
    {
      name: MINT,
      path: MINT,
      type: "folder",
      isRoot: true,
      systemKind: "mint",
      children: buildTree(mintEntries, MINT, true, true),
    },
    {
      name: OBLIVION,
      path: OBLIVION,
      type: "folder",
      isRoot: true,
      systemKind: "oblivion",
      children: buildTree(oblivionEntries, OBLIVION, false, true),
    },
  ];
}

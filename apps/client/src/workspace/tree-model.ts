/** Pure construction and ordering rules for the Press directory tree. */

import {
  MINT,
  SCAN,
  OBLIVION,
  isMintPath,
  isScanPath,
  isOblivionPath,
} from "./generated-paths.js";
import type { DirectorySortOrder } from "./directory-sort.js";

export interface TreeEntry {
  path: string;
  type: "file" | "folder";
  /** Local-only activity timestamp; never part of trace identity. */
  updatedAt?: number;
  /** Mint files become Coin rows only after their transaction completed. */
  coinComplete?: boolean;
}

export interface TreeNode {
  name: string;
  /** Cosmetic label shown in the Press. `name` remains the path segment. */
  displayName?: string;
  path: string;
  type: "file" | "folder";
  children?: TreeNode[];
  /** True only for the four synthetic top-level region nodes. */
  isRoot?: boolean;
  /** Stable semantic glyph for system regions and immutable Mint children. */
  systemKind?: "root" | "mint" | "minted" | "mint-pending" | "scan" | "oblivion";
  /** Generated local timestamp retained for ordering but hidden from labels. */
  systemTimestamp?: string;
  /** Latest local activity at this node or anywhere beneath it. */
  activityAt?: number;
}

export type SystemRegionKind = "mint" | "scan" | "oblivion";
const naturalNameOrder = new Intl.Collator("en", {
  numeric: true,
  sensitivity: "base",
});
const LOCAL_SECOND_STAMP = /^\d{4}-\d{2}-\d{2}_\d{6}$/;
const OBLIVION_BUCKET = /^\d{4}-\d{2}-\d{2}_\d{6}(?:-\d+)?$/;
const MINT_NAME = /^(\d{4}-\d{2}-\d{2}_\d{6})-(.+)$/;

export function treeNodeDisplayName(node: TreeNode): string {
  return node.displayName ?? node.name;
}

function localSecondStampMs(stamp: string | undefined): number | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})(\d{2})(\d{2})/.exec(stamp ?? "");
  if (!match) return undefined;
  const value = new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6]),
  ).getTime();
  return Number.isFinite(value) ? value : undefined;
}

function nodeActivityAt(node: TreeNode): number | undefined {
  return node.activityAt ?? localSecondStampMs(node.systemTimestamp);
}

function directoryOrder(a: TreeNode, b: TreeNode, order: DirectorySortOrder): number {
  // Keep folders together above files in every mode, while applying the
  // selected order consistently within each group.
  if (a.type !== b.type) return a.type === "folder" ? -1 : 1;

  const byName =
    naturalNameOrder.compare(treeNodeDisplayName(a), treeNodeDisplayName(b)) ||
    naturalNameOrder.compare(a.path, b.path);
  if (order === "name-asc") return byName;
  if (order === "name-desc") return -byName;

  const aTime = nodeActivityAt(a);
  const bTime = nodeActivityAt(b);
  if (aTime !== undefined && bTime === undefined) return -1;
  if (aTime === undefined && bTime !== undefined) return 1;
  if (aTime === undefined || bTime === undefined) return byName;
  if (aTime !== bTime) return order === "newest" ? bTime - aTime : aTime - bTime;
  return byName;
}

/** Sort a directory level without mutating the identity-bearing nodes. */
export function sortDirectoryChildren(
  children: readonly TreeNode[],
  order: DirectorySortOrder,
): TreeNode[] {
  return [...children].sort((a, b) => directoryOrder(a, b, order));
}

/**
 * Build one region's nested tree. Ordinary regions use folder-first A-Z at
 * every level. Generated-region presentation is applied by
 * `buildDirectoryTree`, after their structural paths have been retained.
 */
export function buildTree(
  entries: readonly TreeEntry[],
  basePath = "",
  markFilesAsMinted = false,
  order: DirectorySortOrder = "name-asc",
): TreeNode[] {
  const root: TreeNode = { name: "", path: basePath, type: "folder", children: [] };
  for (const { path, type, updatedAt, coinComplete } of entries) {
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
            ? { systemKind: coinComplete ? "minted" as const : "mint-pending" as const }
            : {}),
        };
        cur.children!.push(child);
      }
      if (isLast && updatedAt !== undefined && Number.isFinite(updatedAt)) {
        child.activityAt = updatedAt;
      }
      cur = child;
    });
  }

  function aggregateAndSort(node: TreeNode): number | undefined {
    if (!node.children?.length) return node.activityAt;
    let latest = node.activityAt;
    for (const child of node.children) {
      const childActivity = aggregateAndSort(child);
      if (childActivity !== undefined && (latest === undefined || childActivity > latest)) {
        latest = childActivity;
      }
    }
    node.activityAt = latest;
    node.children = sortDirectoryChildren(node.children, order);
    return latest;
  }

  aggregateAndSort(root);
  return root.children!;
}

function buildMintTree(
  entries: readonly TreeEntry[],
  order: DirectorySortOrder,
): TreeNode[] {
  const children = buildTree(entries, MINT, true, order).map((node) => {
    const match = MINT_NAME.exec(node.name);
    if (!match || !LOCAL_SECOND_STAMP.test(match[1])) return node;
    return {
      ...node,
      displayName: match[2],
      systemTimestamp: match[1],
      activityAt: localSecondStampMs(match[1]) ?? node.activityAt,
    };
  });
  return sortDirectoryChildren(children, order);
}

/**
 * Oblivion uses a generated timestamp directory to avoid storage collisions.
 * That bucket is an implementation detail: present the retained item itself as
 * a direct child while keeping its full path as the row's stable identity.
 */
function buildOblivionTree(
  entries: readonly TreeEntry[],
  order: DirectorySortOrder,
): TreeNode[] {
  const unbucketedEntries: TreeEntry[] = [];
  const bucketEntries = new Map<string, TreeEntry[]>();

  for (const entry of entries) {
    const relativePath = entry.path.startsWith(OBLIVION + "/")
      ? entry.path.slice(OBLIVION.length + 1)
      : entry.path;
    const slash = relativePath.indexOf("/");
    const bucket = slash === -1 ? relativePath : relativePath.slice(0, slash);
    if (slash === -1 || !OBLIVION_BUCKET.test(bucket)) {
      unbucketedEntries.push(entry);
      continue;
    }
    const grouped = bucketEntries.get(bucket) ?? [];
    grouped.push(entry);
    bucketEntries.set(bucket, grouped);
  }

  const children = buildTree(unbucketedEntries, OBLIVION, false, order);
  for (const [bucket, grouped] of bucketEntries) {
    const bucketPath = `${OBLIVION}/${bucket}`;
    children.push(
      ...buildTree(grouped, bucketPath, false, order).map((node) => ({
        ...node,
        systemTimestamp: bucket,
        activityAt: localSecondStampMs(bucket) ?? node.activityAt,
      })),
    );
  }
  return sortDirectoryChildren(children, order);
}

/** Build the four fixed top-level regions in their product-defined order. */
export function buildDirectoryTree(
  entries: readonly TreeEntry[],
  rootLabel: string,
  order: DirectorySortOrder = "name-asc",
): TreeNode[] {
  const mintEntries = entries.filter((entry) => isMintPath(entry.path));
  const scanEntries = entries.filter((entry) => isScanPath(entry.path));
  const oblivionEntries = entries.filter((entry) => isOblivionPath(entry.path));
  const rootEntries = entries.filter(
    (entry) =>
      !isMintPath(entry.path) &&
      !isScanPath(entry.path) &&
      !isOblivionPath(entry.path),
  );

  return [
    {
      name: rootLabel,
      path: "",
      type: "folder",
      isRoot: true,
      systemKind: "root",
      children: buildTree(rootEntries, "", false, order),
    },
    {
      name: SCAN,
      path: SCAN,
      type: "folder",
      isRoot: true,
      systemKind: "scan",
      children: buildTree(scanEntries, SCAN, false, order),
    },
    {
      name: MINT,
      path: MINT,
      type: "folder",
      isRoot: true,
      systemKind: "mint",
      children: buildMintTree(mintEntries, order),
    },
    {
      name: OBLIVION,
      path: OBLIVION,
      type: "folder",
      isRoot: true,
      systemKind: "oblivion",
      children: buildOblivionTree(oblivionEntries, order),
    },
  ];
}

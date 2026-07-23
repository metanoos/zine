import type { FileState } from "./workspace-core.js";

/** Resolve a Stacks folder identity to its path inside the attached Root.
 *
 * Folder cards carry the folder trace's stable genesis id, while the live tree
 * is path-addressed. Root has no FileState entry, and older cached subfolders
 * may not have learned their stable `traceId` yet, so retain the current
 * `nodeId` fallback for those records. */
export function stackFolderPath(
  folderId: string,
  rootId: string | null,
  files: Readonly<Record<string, FileState>>,
): string | null {
  const target = folderId.trim();
  if (!target) return null;
  if (target === rootId) return "";

  for (const [path, file] of Object.entries(files)) {
    if (file.kind !== "folder") continue;
    if (file.traceId === target || file.nodeId === target) return path;
  }
  return null;
}

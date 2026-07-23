/**
 * Consumer-neutral workspace mounting.
 *
 * A mount has at most one explicit root. Folder roots include descendants,
 * file roots include only themselves, and shield boundaries remove complete
 * branches. LLM context and Collaboration sharing deliberately use this exact
 * resolver so the press has one answer to "what is in scope?"
 */

export interface MountRef {
  kind: "file" | "folder";
  path: string;
}

export interface MountScope {
  mount: MountRef | null;
  shields: readonly string[];
}

export type MountState = "mounted" | "included" | "shielded" | "unmounted";

export function containsMountedPath(ancestor: string, path: string): boolean {
  if (ancestor === "") return true;
  return path === ancestor || path.startsWith(`${ancestor}/`);
}

export function normalizeMountScope(scope: MountScope): MountScope {
  const shields = [...new Set(scope.shields)].sort();
  return {
    mount: scope.mount ? { ...scope.mount } : null,
    shields,
  };
}

export function mountScopeFromParts(
  mounts: readonly MountRef[],
  shields: ReadonlySet<string>,
): MountScope {
  return normalizeMountScope({
    mount: mounts[0] ?? null,
    shields: [...shields],
  });
}

export function mountScopeParts(scope: MountScope): {
  mounts: [] | [MountRef];
  shielded: Set<string>;
} {
  const normalized = normalizeMountScope(scope);
  return {
    mounts: normalized.mount ? [normalized.mount] : [],
    shielded: new Set(normalized.shields),
  };
}

export function pathInMountScope(scope: MountScope, path: string): boolean {
  const normalized = normalizeMountScope(scope);
  const mount = normalized.mount;
  if (!mount) return false;
  for (const boundary of normalized.shields) {
    if (containsMountedPath(boundary, path)) return false;
  }
  return mount.kind === "file"
    ? path === mount.path
    : containsMountedPath(mount.path, path);
}

export function mountStateForPath(scope: MountScope, path: string): MountState {
  const normalized = normalizeMountScope(scope);
  if (normalized.mount?.path === path && pathInMountScope(normalized, path)) {
    return "mounted";
  }
  if (pathInMountScope(normalized, path)) return "included";
  if (normalized.shields.includes(path)) {
    for (const boundary of normalized.shields) {
      if (boundary !== path && containsMountedPath(boundary, path)) return "unmounted";
    }
    return "shielded";
  }
  return "unmounted";
}

export function applyMountScope(
  current: MountScope,
  target: MountRef,
  mounted: boolean,
): MountScope {
  const normalized = normalizeMountScope(current);
  const shields = new Set(normalized.shields);

  if (mounted) {
    for (const boundary of shields) {
      if (
        containsMountedPath(boundary, target.path) ||
        containsMountedPath(target.path, boundary)
      ) {
        shields.delete(boundary);
      }
    }
    return normalizeMountScope({ mount: target, shields: [...shields] });
  }

  for (const boundary of shields) {
    if (containsMountedPath(target.path, boundary)) shields.delete(boundary);
  }
  if (normalized.mount?.path === target.path) {
    return normalizeMountScope({ mount: null, shields: [...shields] });
  }
  const withoutNewBoundary = normalizeMountScope({
    mount: normalized.mount,
    shields: [...shields],
  });
  if (pathInMountScope(withoutNewBoundary, target.path)) {
    shields.add(target.path);
  }
  return normalizeMountScope({ mount: normalized.mount, shields: [...shields] });
}

export function rebaseMountScopeAfterMove(
  scope: MountScope,
  movedRoots: readonly string[],
  destinationFolder: string,
): MountScope {
  const rebase = (path: string): string => {
    const source = movedRoots.find((root) => containsMountedPath(root, path));
    if (source === undefined) return path;
    const slash = source.lastIndexOf("/");
    const sourceName = slash === -1 ? source : source.slice(slash + 1);
    const destination = destinationFolder
      ? `${destinationFolder}/${sourceName}`
      : sourceName;
    return path === source ? destination : destination + path.slice(source.length);
  };
  const normalized = normalizeMountScope(scope);
  return normalizeMountScope({
    mount: normalized.mount
      ? { ...normalized.mount, path: rebase(normalized.mount.path) }
      : null,
    shields: normalized.shields.map(rebase),
  });
}

export function mountScopeKey(scope: MountScope): string {
  const normalized = normalizeMountScope(scope);
  const mount = normalized.mount
    ? `${normalized.mount.kind}:${normalized.mount.path}`
    : "";
  return `${mount}\u001e${normalized.shields.join("\u001f")}`;
}

export function mountScopeLabel(scope: MountScope, rootLabel = "Root"): string {
  const mount = normalizeMountScope(scope).mount;
  if (!mount) return "Nothing mounted";
  const label = mount.path === "" ? rootLabel : mount.path;
  return mount.kind === "folder" ? `${label}/` : label;
}

/**
 * Pure mount/scope model shared by the directory tree, context gatherer,
 * replay, and operation guards. The ordered refs are explicit mounts. Effective
 * scope is derived from them: a mounted folder includes itself and every
 * descendant; a mounted file includes only itself. The tree is the only UI
 * surface that applies click gestures to this model.
 */

/** An explicit tree mount that acts as a root for derived scope. */
export interface ScopeRef {
  kind: "file" | "folder";
  path: string;
}

export interface ScopeClickModifiers {
  additive: boolean;
  range: boolean;
}

export interface ScopeClickResult {
  /** Explicit mounts after applying the gesture. */
  scopes: ScopeRef[];
  anchorPath: string;
}

function containsPath(ancestor: string, path: string): boolean {
  if (ancestor === "") return true;
  return path === ancestor || path.startsWith(ancestor + "/");
}

function isStrictDescendant(ancestor: string, path: string): boolean {
  if (ancestor === "") return path !== "";
  return path.startsWith(ancestor + "/");
}

/** True only for a trace explicitly mounted by a tree gesture. */
export function pathIsMounted(mounts: readonly ScopeRef[], path: string): boolean {
  return mounts.some((mount) => mount.path === path);
}

/**
 * Resolve the explicit mounts targeted by a drag or context-menu gesture.
 * Gesturing on a mounted member keeps the group; gesturing on any other trace
 * replaces it with that trace alone, matching desktop file explorers.
 */
export function mountsForGroupAction(
  current: readonly ScopeRef[],
  target: ScopeRef,
): ScopeRef[] {
  return pathIsMounted(current, target.path) ? [...current] : [target];
}

/**
 * Drop redundant descendants before applying a recursive group operation.
 * Root is a permanent scope mount, not a movable tree item, so explicit child
 * mounts win when both are present. Otherwise Root would swallow the entire
 * drag group and the move trust boundary would correctly reject the gesture.
 */
export function topLevelMountedPaths(mounts: readonly ScopeRef[]): string[] {
  const paths = [...new Set(mounts.map((mount) => mount.path))];
  const actionable = paths.length > 1 ? paths.filter((path) => path !== "") : paths;
  return actionable.filter(
    (path) => !actionable.some((other) => other !== path && containsPath(other, path)),
  );
}

/**
 * Carry explicit mounts across a successful tree reparent.
 *
 * `movedRoots` contains only the top-level sources that passed the move
 * guards. A mounted descendant can still sit below one of those roots (for
 * example a mounted folder plus a directly mounted file inside it), so every
 * matching mount is rebased rather than only exact source paths.
 */
export function rebaseMountsAfterMove(
  mounts: readonly ScopeRef[],
  movedRoots: readonly string[],
  destFolder: string,
): ScopeRef[] {
  return mounts.map((mount) => {
    const source = movedRoots.find((root) => containsPath(root, mount.path));
    if (source === undefined) return mount;
    const slash = source.lastIndexOf("/");
    const sourceName = slash === -1 ? source : source.slice(slash + 1);
    const destination = destFolder ? `${destFolder}/${sourceName}` : sourceName;
    return {
      ...mount,
      path: mount.path === source
        ? destination
        : destination + mount.path.slice(source.length),
    };
  });
}

/** True when `path` is mounted or inherited from a mounted folder, before shielding. */
export function pathInScopes(scopes: readonly ScopeRef[], path: string): boolean {
  return scopes.some((scope) => {
    if (scope.kind === "file") return path === scope.path;
    return containsPath(scope.path, path);
  });
}

/**
 * True when `path` belongs to the effective scope union after shielded traversal
 * boundaries are applied.
 *
 * Mounting an item directly starts a new inclusion root, so a shielded boundary
 * at or above that root is ignored. A shielded file or folder strictly below a
 * mounted folder still blocks itself and its entire subtree. Evaluating each
 * mount independently lets a directly mounted shielded child override the
 * exclusion inherited from another, broader mount.
 */
export function pathInEffectiveScopes(
  scopes: readonly ScopeRef[],
  shielded: ReadonlySet<string>,
  path: string,
): boolean {
  return scopes.some((scope) => {
    const included =
      scope.kind === "file" ? path === scope.path : containsPath(scope.path, path);
    if (!included) return false;

    for (const boundary of shielded) {
      if (
        isStrictDescendant(scope.path, boundary) &&
        containsPath(boundary, path)
      ) {
        return false;
      }
    }
    return true;
  });
}

/** Stable identity used by effects that must react only to semantic changes. */
export function scopeKey(scopes: readonly ScopeRef[]): string {
  return scopes.map((scope) => `${scope.kind}:${scope.path}`).join("\u001f");
}

function mergeScopes(left: readonly ScopeRef[], right: readonly ScopeRef[]): ScopeRef[] {
  const next = [...left];
  const seen = new Set(left.map((scope) => scope.path));
  for (const scope of right) {
    if (seen.has(scope.path)) continue;
    seen.add(scope.path);
    next.push(scope);
  }
  return next;
}

/**
 * Apply Explorer/Finder-style tree mount semantics.
 *
 * - plain click replaces the mounts with the clicked trace;
 * - Cmd/Ctrl-click toggles the clicked mount;
 * - Shift-click mounts the visible range from the anchor;
 * - Cmd/Ctrl+Shift-click adds that range to the existing mounts.
 *
 * `visible` is depth-first display order, so collapsed descendants are not
 * accidentally swept into a range the user cannot see.
 */
export function applyScopeClick(
  current: readonly ScopeRef[],
  clicked: ScopeRef,
  visible: readonly ScopeRef[],
  anchorPath: string | null,
  modifiers: ScopeClickModifiers,
): ScopeClickResult {
  if (modifiers.range && anchorPath != null) {
    const anchorIndex = visible.findIndex((item) => item.path === anchorPath);
    const clickedIndex = visible.findIndex((item) => item.path === clicked.path);
    if (anchorIndex !== -1 && clickedIndex !== -1) {
      const [lo, hi] =
        anchorIndex < clickedIndex
          ? [anchorIndex, clickedIndex]
          : [clickedIndex, anchorIndex];
      const range = visible.slice(lo, hi + 1);
      return {
        scopes: modifiers.additive ? mergeScopes(current, range) : [...range],
        anchorPath,
      };
    }
  }

  if (modifiers.additive) {
    const exists = current.some((scope) => scope.path === clicked.path);
    return {
      scopes: exists
        ? current.filter((scope) => scope.path !== clicked.path)
        : [...current, clicked],
      anchorPath: clicked.path,
    };
  }

  return { scopes: [clicked], anchorPath: clicked.path };
}

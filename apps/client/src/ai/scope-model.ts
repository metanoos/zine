/**
 * Pure path-selection and context-scope algorithms. Replay selection and
 * context mounting share the TraceRef coordinate shape but remain separate
 * state. Explorer selection may contain many traces. Prompt context has at most
 * one explicit mount: a mounted folder includes every descendant and a mounted
 * file includes only itself.
 */

import {
  applyMountScope,
  containsMountedPath,
  mountScopeFromParts,
  mountScopeLabel,
  mountScopeParts,
  mountStateForPath,
  pathInMountScope,
  rebaseMountScopeAfterMove,
  type MountRef,
} from "../workspace/mount-scope.js";

/** A file or folder coordinate used by tree selection and context mounting. */
export type TraceRef = MountRef;

/** An explicit context mount that acts as a root for derived prompt scope. */
export type ScopeRef = TraceRef;

/** Prompt context is either empty or rooted at exactly one trace. The tuple
 * shape matches the serialized scope array while making parallel mounts
 * unrepresentable in live client state. */
export type ContextMounts = [] | [ScopeRef];

export interface ScopeClickModifiers {
  additive: boolean;
  range: boolean;
}

export interface ScopeClickResult {
  /** Selected trace refs after applying the Explorer gesture. */
  scopes: ScopeRef[];
  anchorPath: string;
}

export type ContextMountState = "mounted" | "included" | "shielded" | "unmounted";

export interface ContextMountResult {
  mounts: ContextMounts;
  shielded: Set<string>;
}

/**
 * Resolve the selection targeted by a drag or context-menu gesture. Gesturing
 * on a selected member keeps the group; gesturing on any other trace
 * replaces it with that trace alone, matching desktop file explorers.
 */
export function selectionForGroupAction(
  current: readonly TraceRef[],
  target: TraceRef,
): TraceRef[] {
  return current.some((item) => item.path === target.path) ? [...current] : [target];
}

/**
 * Drop redundant descendants before applying a recursive group operation.
 * Root is not movable, so selected children win when both Root and its
 * descendants are present. Otherwise Root would swallow the entire drag group.
 */
export function topLevelSelectedPaths(selection: readonly TraceRef[]): string[] {
  const paths = [...new Set(selection.map((item) => item.path))];
  const actionable = paths.length > 1 ? paths.filter((path) => path !== "") : paths;
  return actionable.filter(
    (path) =>
      !actionable.some(
        (other) => other !== path && containsMountedPath(other, path),
      ),
  );
}

/**
 * Carry trace coordinates across a successful tree reparent.
 *
 * `movedRoots` contains only the top-level sources that passed the move
 * guards. A selected descendant can still sit below one of those roots, so
 * every matching coordinate is rebased rather than only exact source paths.
 */
export function rebaseTraceRefsAfterMove(
  refs: readonly TraceRef[],
  movedRoots: readonly string[],
  destFolder: string,
): TraceRef[] {
  return refs.map((ref) => {
    const source = movedRoots.find((root) => containsMountedPath(root, ref.path));
    if (source === undefined) return ref;
    const slash = source.lastIndexOf("/");
    const sourceName = slash === -1 ? source : source.slice(slash + 1);
    const destination = destFolder ? `${destFolder}/${sourceName}` : sourceName;
    return {
      ...ref,
      path: ref.path === source
        ? destination
        : destination + ref.path.slice(source.length),
    };
  });
}

/** Carry the one context mount across a successful tree reparent. */
export function rebaseContextMountAfterMove(
  mounts: ContextMounts,
  movedRoots: readonly string[],
  destFolder: string,
): ContextMounts {
  return mountScopeParts(
    rebaseMountScopeAfterMove(
      mountScopeFromParts(mounts, new Set()),
      movedRoots,
      destFolder,
    ),
  ).mounts;
}

/** Carry the one context mount across an in-place rename. `path` is the
 * pre-rename node, `destPath` its post-rename path. A folder rename rewrites
 * every mount whose path is the renamed folder or sits beneath it; a file
 * rename rewrites only an exact-match mount. An ancestor-of-the-rename mount
 * and any unrelated mount pass through unchanged. Mirrors the path-rewrite
 * rule the storage layer applies to file keys, so scope stays consistent with
 * the live tree. */
export function rebaseContextMountAfterRename(
  mounts: ContextMounts,
  path: string,
  destPath: string,
  isFolderRename: boolean,
): ContextMounts {
  if (mounts.length === 0) return [];
  const mount = mounts[0];
  const p = mount.path;
  let nextPath: string;
  if (p === path) {
    nextPath = destPath;
  } else if (isFolderRename && p.startsWith(path + "/")) {
    nextPath = destPath + p.slice(path.length);
  } else {
    nextPath = p;
  }
  return nextPath === p ? mounts : [{ ...mount, path: nextPath }];
}

/** Carry shield boundaries through one exact path-prefix rewrite. If the moved
 * root inherited a broader shield that stays behind, install an explicit
 * boundary at the destination so moving sensitive content cannot unshield it. */
export function rebaseShieldedPath(
  shielded: ReadonlySet<string>,
  source: string,
  destination: string,
): Set<string> {
  const next = new Set<string>();
  let inherited = false;
  for (const boundary of shielded) {
    if (containsMountedPath(source, boundary)) {
      next.add(boundary === source
        ? destination
        : destination + boundary.slice(source.length));
    } else {
      next.add(boundary);
      if (containsMountedPath(boundary, source)) inherited = true;
    }
  }
  if (inherited) next.add(destination);
  return next;
}

/** Carry all shield boundaries through one multi-source reparent gesture. */
export function rebaseShieldedAfterMove(
  shielded: ReadonlySet<string>,
  movedRoots: readonly string[],
  destFolder: string,
): Set<string> {
  let next = new Set(shielded);
  for (const source of movedRoots) {
    const slash = source.lastIndexOf("/");
    const sourceName = slash === -1 ? source : source.slice(slash + 1);
    const destination = destFolder ? `${destFolder}/${sourceName}` : sourceName;
    next = rebaseShieldedPath(next, source, destination);
  }
  return next;
}

export interface ShieldedPathChange {
  added: readonly string[];
  removed: readonly string[];
}

/** Record and reverse only the boundaries changed by one optimistic mutation.
 * This is safer than applying the prefix rewrite backwards: a destination may
 * inherit an unrelated pre-existing shield that never belonged to the source. */
export function shieldedPathChange(
  before: ReadonlySet<string>,
  after: ReadonlySet<string>,
): ShieldedPathChange {
  return {
    added: [...after].filter((path) => !before.has(path)),
    removed: [...before].filter((path) => !after.has(path)),
  };
}

export function revertShieldedPathChange(
  current: ReadonlySet<string>,
  change: ShieldedPathChange,
): Set<string> {
  const next = new Set(current);
  for (const path of change.added) next.delete(path);
  for (const path of change.removed) next.add(path);
  return next;
}

/** Drop explicit boundaries contained by a permanently deleted subtree. */
export function removeDeletedShieldedPaths(
  shielded: ReadonlySet<string>,
  deletedRoots: readonly string[],
): Set<string> {
  return new Set([...shielded].filter((boundary) =>
    !deletedRoots.some((root) => containsMountedPath(root, boundary))
  ));
}

/** Resolve the path union contributed by an ordinary multi-selection. */
export function pathInTraceScopes(
  scopes: readonly TraceRef[],
  shielded: ReadonlySet<string>,
  path: string,
): boolean {
  for (const boundary of shielded) {
    if (containsMountedPath(boundary, path)) return false;
  }
  return scopes.some((scope) =>
    scope.kind === "file"
      ? path === scope.path
      : containsMountedPath(scope.path, path),
  );
}

/**
 * True when `path` belongs to the effective scope after shielded traversal
 * boundaries are applied.
 *
 * A shield is absolute for its complete subtree. Mounting a shielded trace
 * replaces the active mount and clears the conflicting shield.
 */
export function pathInEffectiveScope(
  mounts: ContextMounts,
  shielded: ReadonlySet<string>,
  path: string,
): boolean {
  return pathInMountScope(mountScopeFromParts(mounts, shielded), path);
}

/**
 * Resolve one item's categorical context state. Only the exact active root is
 * mounted; descendants of a folder mount are included. An effective explicit
 * shield boundary is blue, and everything blocked beneath it is unmounted.
 */
export function contextMountState(
  mounts: ContextMounts,
  shielded: ReadonlySet<string>,
  path: string,
): ContextMountState {
  return mountStateForPath(mountScopeFromParts(mounts, shielded), path);
}

/**
 * Mount or exclude one tree branch from context injection.
 *
 * Mounting always replaces the previous mount. Conflicting ancestor and
 * descendant shields are cleared so the new mount is effective. Activating an
 * included descendant excludes that branch with one shield; activating the
 * exact mount clears context entirely.
 */
export function applyContextMount(
  current: ContextMounts,
  shielded: ReadonlySet<string>,
  target: ScopeRef,
  mounted: boolean,
): ContextMountResult {
  return mountScopeParts(
    applyMountScope(
      mountScopeFromParts(current, shielded),
      target,
      mounted,
    ),
  );
}

/** Stable identity used by effects that must react only to semantic changes. */
export function traceRefsKey(refs: readonly TraceRef[]): string {
  return refs.map((ref) => `${ref.kind}:${ref.path}`).join("\u001f");
}

/** Human-readable identity for the one prompt-context mount. */
export function mountedScopeLabel(
  mounts: ContextMounts,
  rootLabel = "Root",
): string {
  return mountScopeLabel(mountScopeFromParts(mounts, new Set()), rootLabel);
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
 * Apply Explorer/Finder-style tree selection semantics.
 *
 * - plain click replaces the selection with the clicked trace;
 * - Cmd/Ctrl-click toggles the clicked selection;
 * - Shift-click selects the visible range from the anchor;
 * - Cmd/Ctrl+Shift-click adds that range to the existing selection.
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

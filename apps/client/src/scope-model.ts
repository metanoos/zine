/**
 * Pure path-selection and context-scope algorithms. Replay selection and
 * context mounting share the TraceRef coordinate shape but remain separate
 * state. Explorer selection may contain many traces. Prompt context has at most
 * one explicit mount: a mounted folder includes every descendant and a mounted
 * file includes only itself.
 */

/** A file or folder coordinate used by tree selection and context mounting. */
export interface TraceRef {
  kind: "file" | "folder";
  path: string;
}

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

function containsPath(ancestor: string, path: string): boolean {
  if (ancestor === "") return true;
  return path === ancestor || path.startsWith(ancestor + "/");
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
    (path) => !actionable.some((other) => other !== path && containsPath(other, path)),
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
    const source = movedRoots.find((root) => containsPath(root, ref.path));
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
  if (mounts.length === 0) return [];
  return [rebaseTraceRefsAfterMove(mounts, movedRoots, destFolder)[0]];
}

/** Resolve the path union contributed by an ordinary multi-selection. */
export function pathInTraceScopes(
  scopes: readonly TraceRef[],
  shielded: ReadonlySet<string>,
  path: string,
): boolean {
  for (const boundary of shielded) {
    if (containsPath(boundary, path)) return false;
  }
  return scopes.some((scope) =>
    scope.kind === "file" ? path === scope.path : containsPath(scope.path, path),
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
  return pathInTraceScopes(mounts, shielded, path);
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
  if (mounts[0]?.path === path && pathInEffectiveScope(mounts, shielded, path)) {
    return "mounted";
  }
  if (pathInEffectiveScope(mounts, shielded, path)) return "included";
  if (shielded.has(path)) {
    for (const boundary of shielded) {
      if (boundary !== path && containsPath(boundary, path)) return "unmounted";
    }
    return "shielded";
  }
  return "unmounted";
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
  const nextShielded = new Set(shielded);

  if (mounted) {
    for (const boundary of nextShielded) {
      if (
        containsPath(boundary, target.path) ||
        containsPath(target.path, boundary)
      ) {
        nextShielded.delete(boundary);
      }
    }
    return { mounts: [target], shielded: nextShielded };
  }

  // One blue boundary owns the complete branch. Drop older nested boundaries
  // before installing it so every descendant renders ordinary unmounted grey.
  for (const boundary of nextShielded) {
    if (containsPath(target.path, boundary)) nextShielded.delete(boundary);
  }
  if (current[0]?.path === target.path) {
    return { mounts: [], shielded: nextShielded };
  }
  if (pathInEffectiveScope(current, nextShielded, target.path)) {
    nextShielded.add(target.path);
  }
  return { mounts: current, shielded: nextShielded };
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
  const mount = mounts[0];
  if (!mount) return "Nothing mounted";
  const label = mount.path === "" ? rootLabel : mount.path;
  return mount.kind === "folder" ? `${label}/` : label;
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

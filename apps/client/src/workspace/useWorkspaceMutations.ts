import { useState, type Dispatch, type SetStateAction } from "react";
import {
  rebaseContextMountAfterMove,
  rebaseContextMountAfterRename,
  rebaseShieldedAfterMove,
  rebaseShieldedPath,
  rebaseTraceRefsAfterMove,
  removeDeletedShieldedPaths,
  revertShieldedPathChange,
  shieldedPathChange,
  type ContextMounts,
  type ShieldedPathChange,
  type TraceRef,
} from "../ai/scope-model.js";
import type { Mode } from "../provenance/brackets.js";
import { closeDeletedTabs, type DeleteTabTarget } from "./delete-tabs.js";
import { folderTab, folderTabPath, isFolderTab, rebaseFolderTab } from "./folder-tabs.js";
import {
  MINT,
  OBLIVION,
  SCAN,
  formatLocalSecondStamp,
  isMintPath as isMint,
  isOblivionPath as isOblivion,
  isScanPath as isScan,
} from "./generated-paths.js";
import type { PanelState } from "./panel-state.js";
import { hasPendingStructuralPathMutation, loadLocalFolder } from "./local-store.js";
import {
  ROOT,
  basename,
  canDrop,
  hasChild,
  isDescendantOrSelf,
  isValidTagToken,
  parentPath,
  rebasePath,
} from "./path-operations.js";
import { setRootLabel } from "./root.js";
import { rebaseUiFocus, type UiFocus } from "./ui-focus.js";
import { ensureMdExt, type Workspace } from "./workspace-core.js";
import type { AttachedFolder, FileState } from "./workspace.js";
import { localToFiles } from "./workspace-local.js";

type StateSetter<T> = Dispatch<SetStateAction<T>>;

export interface Creating {
  kind: "file" | "folder";
  parent: string;
}

const OBLIVION_BUCKET_PATH = /^oblivion\/\d{4}-\d{2}-\d{2}_\d{6}(?:-\d+)?$/;

/** Generated Oblivion containers are storage implementation details, not
 * user folders. Once their final retained item leaves, they must disappear. */
export function shouldPreserveEmptyParentAfterDelete(path: string): boolean {
  return path !== ROOT && path !== OBLIVION && !OBLIVION_BUCKET_PATH.test(path);
}

type WorkspaceMutationOptions = {
  folder: AttachedFolder | null;
  setFolder: StateSetter<AttachedFolder | null>;
  files: Record<string, FileState>;
  setFiles: StateSetter<Record<string, FileState>>;
  panels: PanelState[];
  panelsRef: { current: PanelState[] };
  activePanel: number;
  setPanels: StateSetter<PanelState[]>;
  tabModes: Record<string, Mode>;
  setTabModes: StateSetter<Record<string, Mode>>;
  backendRef: { current: Workspace };
  folderIdRef: { current: string | null };
  setScope: StateSetter<ContextMounts>;
  scopeRef: { current: ContextMounts };
  shieldedRef: { current: Set<string> };
  commitShieldedForRoot: (rootId: string, next: Set<string>) => void;
  projectShieldedForRoot: (rootId: string, next: Set<string>) => void;
  setStructuralError: (message: string | null) => void;
  blocksPendingMintSourceMutation: (path: string, isFolder: boolean) => boolean;
  reportPendingMintBlock: (message: string) => void;
  directorySelectionRef: { current: readonly TraceRef[] };
  chooseDirectorySelection: (next: readonly TraceRef[]) => void;
  uiFocusRef: { current: UiFocus | null };
  commitUiFocus: (next: UiFocus | null) => void;
  commitWithCollapse: (panels: PanelState[], activePanel: number) => void;
  openInActivePanel: (path: string) => void;
  refreshMountedReplay: (expectedRootId?: string) => void;
  forkMintedNodes: (sources: string[], destinationFolder: string) => Promise<void>;
  adoptScannedNodes: (sources: string[], destinationFolder: string) => Promise<void>;
};

/**
 * Owns workspace-tree UI state and the path mutations that must update files,
 * panels, focus, prompt context, and local storage as one coherent operation.
 * Signing-sensitive Coin forks and Scan adoptions stay outside this controller
 * and enter through explicit callbacks.
 */
export function useWorkspaceMutations(options: WorkspaceMutationOptions) {
  const {
    folder,
    setFolder,
    files,
    setFiles,
    panels,
    panelsRef,
    activePanel,
    setPanels,
    tabModes,
    setTabModes,
    backendRef,
    folderIdRef,
    setScope,
    scopeRef,
    shieldedRef,
    commitShieldedForRoot,
    projectShieldedForRoot,
    setStructuralError,
    blocksPendingMintSourceMutation,
    reportPendingMintBlock,
    directorySelectionRef,
    chooseDirectorySelection,
    uiFocusRef,
    commitUiFocus,
    commitWithCollapse,
    openInActivePanel,
    refreshMountedReplay,
    forkMintedNodes,
    adoptScannedNodes,
  } = options;

  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [emptyFolders, setEmptyFolders] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState<Creating | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);

  function toggleFolder(path: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  function createStart(kind: "file" | "folder", parent = "") {
    setCreateError(null);
    if (isMint(parent) || isScan(parent) || isOblivion(parent)) return;
    setCreating({ kind, parent });
    // Make sure the parent folder is expanded so the inline phantom row (the
    // name input) is visible while typing. Includes ROOT: the synthetic root
    // can be collapsed, and CreateRow only renders under open folders.
    setCollapsed((prev) => {
      if (!prev.has(parent)) return prev;
      const next = new Set(prev);
      next.delete(parent);
      return next;
    });
  }

  function createCancel() {
    setCreating(null);
    setCreateError(null);
  }

  function createCommit(name: string) {
    const active = creating;
    if (!active) return;
    const kind = active.kind;
    const parent = active.parent;
    const cleanName = name.replace(/^\/+|\/+$/g, "");
    if (!cleanName) {
      setCreating(null);
      setCreateError(null);
      return;
    }
    if (!folder) return;

    // Every FOLDER segment of the path must be a valid tag token, because the
    // folder name becomes the file's first nostr `t` tag and we don't slugify.
    // For a folder, all segments are folders; for a file, all but the last
    // (the basename may contain `.` for the extension). On rejection, keep the
    // input open with an error rather than committing. The parent prefix (when
    // creating inside a right-clicked folder) is already known-good — it came
    // from an existing folder path — so only the typed segments are checked.
    const segments = cleanName.split("/").filter(Boolean);
    const folderSegments =
      kind === "folder" ? segments : segments.slice(0, -1);
    const bad = folderSegments.find((seg) => !isValidTagToken(seg));
    if (bad !== undefined) {
      setCreateError(
        `"${bad}" isn't a valid folder name. Use letters, digits, _ and - only (no spaces).`,
      );
      return; // keep `creating` set so the input stays open
    }

    // Compose the full path: parent prefix (if scoped via context menu) + the
    // typed name. The disk layer (write_text_file / create_folder) already
    // creates intermediate dirs via create_dir_all, so nested paths just work.
    const fullName = parent ? `${parent}/${cleanName}` : cleanName;
    // Mint, Scan, and Oblivion are system-managed. Their contents arrive only
    // through mint, scan, and delete/restore gestures respectively.
    if (
      isMint(parent) ||
      isMint(fullName) ||
      isScan(parent) ||
      isScan(fullName) ||
      isOblivion(parent) ||
      isOblivion(fullName)
    ) {
      setCreateError("Mint, Scan, and Oblivion are managed by their own gestures.");
      return;
    }

    setCreating(null);
    setCreateError(null);

    if (kind === "file") {
      const path = ensureMdExt(fullName);
      if (!files[path]) {
        // Optimistically add an empty file so the editor is immediately
        // usable; the disk write + import node happen via createFile below.
        setFiles((prev) => ({
          ...prev,
          [path]: { runs: [], nodeId: "", tags: [], updatedAt: Date.now() },
        }));
        void (async () => {
          try {
            const nodeId = await backendRef.current.createFile(path);
            setFiles((prev) =>
              prev[path]
                ? { ...prev, [path]: { ...prev[path], nodeId, traceId: nodeId } }
                : prev,
            );
          } catch (e) {
            console.warn(`[workspace] createFile failed for ${path}:`, e);
          }
        })();
      }
      // make sure no stale empty-folder marker lingers at this path
      setEmptyFolders((prev) => {
        if (!prev.has(path)) return prev;
        const next = new Set(prev);
        next.delete(path);
        return next;
      });
      openInActivePanel(path);
    } else {
      setEmptyFolders((prev) => {
        const next = new Set(prev);
        next.add(fullName);
        // ensure the new folder is visible
        setCollapsed((c) => {
          if (!c.has(fullName)) return c;
          const n = new Set(c);
          n.delete(fullName);
          return n;
        });
        return next;
      });
      void (async () => {
        try {
          const nodeId = await backendRef.current.createFolder(fullName);
          setFiles((prev) => ({
            ...prev,
            [fullName]: { kind: "folder", runs: [], nodeId, traceId: nodeId, tags: [] },
          }));
          setEmptyFolders((prev) => {
            if (!prev.has(fullName)) return prev;
            const next = new Set(prev);
            next.delete(fullName);
            return next;
          });
        } catch (e) {
          console.warn(`[workspace] createFolder failed for ${fullName}:`, e);
        }
      })();
    }
  }

  function reconcileFailedPathMutation(
    operationFolderId: string,
    sourcePath: string,
    destinationPath: string | null,
    isFolderMutation: boolean,
    error: unknown,
    deleteRollback?: {
      tabs: Array<{ panelIndex: number; tab: string; wasActive: boolean }>;
      tabModes: Record<string, Mode>;
      emptyFolders: string[];
      collapsed: string[];
      shielded: string[];
      selection: TraceRef[];
      focus: UiFocus | null;
    },
    shieldRollback?: ShieldedPathChange,
  ): void {
    if (folderIdRef.current !== operationFolderId) return;
    const persisted = loadLocalFolder(operationFolderId);
    const durableFiles = persisted ? localToFiles(persisted) : {};
    const roots = destinationPath ? [sourcePath, destinationPath] : [sourcePath];
    const inAffectedSubtree = (path: string) => roots.some(
      (root) => path === root || path.startsWith(`${root}/`),
    );
    setFiles((current) => {
      const next = Object.fromEntries(
        Object.entries(current).filter(([path]) => !inAffectedSubtree(path)),
      );
      for (const [path, file] of Object.entries(durableFiles)) {
        if (inAffectedSubtree(path)) next[path] = file;
      }
      return next;
    });

    const durableHasSource = Object.keys(durableFiles).some(
      (path) =>
        path === sourcePath ||
        (isFolderMutation && path.startsWith(`${sourcePath}/`)),
    );
    const durableHasDestination =
      destinationPath !== null &&
      Object.keys(durableFiles).some(
        (path) =>
          path === destinationPath ||
          (isFolderMutation && path.startsWith(`${destinationPath}/`)),
      );
    if (destinationPath && durableHasSource && !durableHasDestination) {
      const reverse = (path: string): string => {
        if (path === destinationPath) return sourcePath;
        if (isFolderMutation && path.startsWith(`${destinationPath}/`)) {
          return sourcePath + path.slice(destinationPath.length);
        }
        return path;
      };
      const reverseTab = (path: string): string =>
        isFolderTab(path) ? folderTab(reverse(folderTabPath(path))) : reverse(path);
      setEmptyFolders((current) => new Set([...current].map(reverse)));
      setPanels((current) =>
        current.map((panel) => ({
          tabs: panel.tabs.map(reverseTab),
          active: reverseTab(panel.active),
        })) as [PanelState, PanelState],
      );
      setTabModes((current) =>
        Object.fromEntries(
          Object.entries(current).map(([path, mode]) => [reverse(path), mode]),
        ),
      );
      setCollapsed((current) => new Set([...current].map(reverse)));
      setScope(
        (current) =>
          current.map((mount) => ({ ...mount, path: reverse(mount.path) })) as ContextMounts,
      );
      if (shieldRollback) {
        commitShieldedForRoot(
          operationFolderId,
          revertShieldedPathChange(shieldedRef.current, shieldRollback),
        );
      }
      chooseDirectorySelection(
        directorySelectionRef.current.map((item) => ({
          ...item,
          path: reverse(item.path),
        })),
      );
      commitUiFocus(rebaseUiFocus(uiFocusRef.current, reverse, reverseTab));
    }
    if (!destinationPath && deleteRollback && durableHasSource) {
      setPanels((current) => {
        const next = current.map((panel) => ({
          ...panel,
          tabs: [...panel.tabs],
        }));
        for (const saved of deleteRollback.tabs) {
          if (next.some((panel) => panel.tabs.includes(saved.tab))) continue;
          const panelIndex = Math.min(
            saved.panelIndex,
            Math.max(0, next.length - 1),
          );
          const panel = next[panelIndex];
          if (!panel) continue;
          panel.tabs.push(saved.tab);
          if (saved.wasActive && !panel.active) panel.active = saved.tab;
        }
        panelsRef.current = next;
        return next;
      });
      setTabModes((current) => ({ ...deleteRollback.tabModes, ...current }));
      setEmptyFolders(
        (current) => new Set([...current, ...deleteRollback.emptyFolders]),
      );
      setCollapsed(
        (current) => new Set([...current, ...deleteRollback.collapsed]),
      );
      commitShieldedForRoot(
        operationFolderId,
        new Set([...shieldedRef.current, ...deleteRollback.shielded]),
      );
      chooseDirectorySelection([
        ...directorySelectionRef.current,
        ...deleteRollback.selection.filter(
          (saved) =>
            !directorySelectionRef.current.some(
              (current) => current.path === saved.path,
            ),
        ),
      ]);
      if (!uiFocusRef.current && deleteRollback.focus) {
        commitUiFocus(deleteRollback.focus);
      }
    }
    setStructuralError(
      `${destinationPath ? "Move" : "Delete"} failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  function retainRetryablePathMutation(
    operationFolderId: string,
    sourcePath: string,
    destinationPath: string | null,
    error: unknown,
  ): boolean {
    if (
      !hasPendingStructuralPathMutation(
        operationFolderId,
        sourcePath,
        destinationPath,
      )
    ) {
      return false;
    }
    if (folderIdRef.current === operationFolderId) {
      setStructuralError(
        `${destinationPath ? "Move" : "Delete"} pending retry: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    return true;
  }

  function moveNodes(srcs: string[], destFolder: string) {
    if (!folder) return;
    const operationFolderId = folder.id;
    if (isMint(destFolder) || isScan(destFolder)) return;
    const mintedSources = srcs.filter((src) => isMint(src) && src !== MINT);
    if (mintedSources.length > 0) void forkMintedNodes(mintedSources, destFolder);
    const scannedSources = srcs.filter((src) => isScan(src) && src !== SCAN);
    if (scannedSources.length > 0) void adoptScannedNodes(scannedSources, destFolder);
    srcs = srcs.filter((src) => !isMint(src) && !isScan(src));
    if (srcs.length === 0) return;
    // The synthetic root (the mounted folder) can never be a move source.
    // The UI never offers it as draggable, but this is the trust boundary.
    if (srcs.some((s) => s === ROOT)) return;
    const fileSet = new Set(Object.keys(files));
    const folderSet = new Set(emptyFolders);

    // Drop any source nested beneath another source, then keep only those that
    // can legally land in destFolder given the pre-move path set. Also guard
    // against two sources colliding at the *destination* (e.g. a/x.md and
    // b/x.md both dropped into root → both would rebase to "x.md"): process in
    // order and skip a source whose destination is already claimed by an
    // earlier source in this batch — canDrop only checks the pre-move set.
    const tops = srcs.filter(
      (p) => !srcs.some((q) => q !== p && isDescendantOrSelf(q, p)),
    );
    const movable: string[] = [];
    const takenDest = new Set<string>();
    for (const src of tops) {
      if (!canDrop(src, destFolder, fileSet, folderSet)) continue;
      const dest = destFolder === ROOT ? basename(src) : `${destFolder}/${basename(src)}`;
      if (takenDest.has(dest)) continue;
      takenDest.add(dest);
      movable.push(src);
    }
    if (movable.length === 0) return;
    const blockedSource = movable.find((src) => {
      const isFolderMove =
        files[src]?.kind === "folder" ||
        folderSet.has(src) ||
        hasChild(fileSet, folderSet, src);
      return blocksPendingMintSourceMutation(src, isFolderMove);
    });
    if (blockedSource) {
      reportPendingMintBlock(
        `Finish or retry the pending Mint before moving its source ${blockedSource}.`,
      );
      return;
    }

    // Rebase a path under any moving source. A path is affected iff it is a
    // source itself or a descendant of a folder source; the first matching
    // (top-most) source wins. `destFolder` is the same for every source this
    // call, so each source's destination is `${destFolder}/${basename(src)}`.
    const rebaser = (p: string): string => {
      for (const src of movable) {
        const isFolderMove = folderSet.has(src) || hasChild(fileSet, folderSet, src);
        if (p === src || (isFolderMove && p.startsWith(src + "/"))) {
          return rebasePath(p, src, destFolder);
        }
      }
      return p;
    };
    const affected = (p: string) => rebaser(p) !== p;

    /** Rebase a folder-tab sentinel when its underlying folder moves: find the
     *  (unique) moving source that covers the sentinel's inner relpath, and
     *  rebase against that source. File tabs and uncovered folder tabs pass
     *  through unchanged. */
    const tabRebaser = (p: string): string => {
      if (!isFolderTab(p)) return rebaser(p);
      const rel = folderTabPath(p);
      for (const src of movable) {
        const isFolderMove = folderSet.has(src) || hasChild(fileSet, folderSet, src);
        if (rel === src || (isFolderMove && rel.startsWith(src + "/"))) {
          return rebaseFolderTab(p, src, destFolder);
        }
      }
      return p; // no moving source covers this folder tab
    };

    setFiles((prev) => {
      const next: Record<string, FileState> = {};
      for (const [path, state] of Object.entries(prev)) {
        next[affected(path) ? rebaser(path) : path] = state;
      }
      return next;
    });

    setEmptyFolders((prev) => {
      const next = new Set<string>();
      for (const path of prev) next.add(affected(path) ? rebaser(path) : path);
      // Moving the last child out of a folder would empty it — record the source
      // folder so it survives instead of vanishing. Walk up from each moved
      // source's original path and add any ancestor that now has no surviving
      // files or empty-folders beneath it (stopping at the first non-empty
      // ancestor). Don't record a source that is itself moving into destFolder —
      // it's no longer at its old location.
      const postFiles = new Set<string>();
      for (const p of Object.keys(files)) {
        postFiles.add(affected(p) ? rebaser(p) : p);
      }
      const candidates = new Set<string>();
      for (const src of movable) {
        let cur = parentPath(src);
        while (cur !== ROOT) {
          if (hasChild(postFiles, next, cur)) break; // still has content
          if (shouldPreserveEmptyParentAfterDelete(cur)) {
            if (candidates.has(cur)) break; // already seen
            candidates.add(cur);
          }
          cur = parentPath(cur);
        }
      }
      for (const c of candidates) {
        let deeper = false;
        for (const d of candidates) {
          if (d !== c && d.startsWith(c + "/")) {
            deeper = true;
            break;
          }
        }
        if (!deeper) next.add(c);
      }
      return next;
    });

    // follow open panels: rebase every tab path and each panel's active path.
    // Folder-tab sentinels rebase against the moving source that covers them.
    setPanels((prev) =>
      prev.map((panel) => ({
        tabs: panel.tabs.map(tabRebaser),
        active: tabRebaser(panel.active),
      })) as [PanelState, PanelState],
    );

    // Rebase remembered view modes so a moved file keeps the surface it had.
    // (Folder tabs never write a tabModes entry — guarded at the write site.)
    setTabModes((prev) => {
      const next: Record<string, Mode> = {};
      for (const [p, mode] of Object.entries(prev)) next[rebaser(p)] = mode;
      return next;
    });

    // collapse state follows folders; expand the destination so the move is visible
    setCollapsed((prev) => {
      const next = new Set<string>();
      for (const path of prev) next.add(affected(path) ? rebaser(path) : path);
      if (destFolder !== ROOT) next.delete(destFolder);
      return next;
    });

    // Context, directory operation selection, and semantic focus all follow
    // the same trace identities through a move.
    setScope((prev) => rebaseContextMountAfterMove(prev, movable, destFolder));
    const shieldedBeforeMove = shieldedRef.current;
    const shieldRollbackBySource = new Map<string, ShieldedPathChange>();
    for (const source of movable) {
      const destination =
        destFolder === ROOT
          ? basename(source)
          : `${destFolder}/${basename(source)}`;
      shieldRollbackBySource.set(
        source,
        shieldedPathChange(
          shieldedBeforeMove,
          rebaseShieldedPath(shieldedBeforeMove, source, destination),
        ),
      );
    }
    projectShieldedForRoot(
      operationFolderId,
      rebaseShieldedAfterMove(shieldedBeforeMove, movable, destFolder),
    );
    chooseDirectorySelection(
      rebaseTraceRefsAfterMove(directorySelectionRef.current, movable, destFolder),
    );
    commitUiFocus(rebaseUiFocus(uiFocusRef.current, rebaser, tabRebaser));

    // Storage + provenance: extend each file's existing trace at the new path
    // and update membership. Carry user tags through so they survive the
    // reparent. Each
    // top-level source is a separate backend move (movePath already rebases a
    // folder's descendants), so they're independent and tolerate partial
    // failures — a failed move logs and leaves the rest intact.
    for (const src of movable) {
      const isFolderMove =
        files[src]?.kind === "folder" ||
        folderSet.has(src) ||
        hasChild(fileSet, folderSet, src);
      const userTagsByPath: Record<string, string[]> = {};
      for (const [p, st] of Object.entries(files)) {
        if (p === src || (isFolderMove && p.startsWith(src + "/"))) {
          userTagsByPath[p] = st.tags;
        }
      }
      void backendRef.current.movePath(src, destFolder, isFolderMove, userTagsByPath)
        .then(() => refreshMountedReplay(operationFolderId))
        .catch((error) => {
          console.warn(`[workspace] movePath failed for ${src}:`, error);
          const destinationPath =
            destFolder === ROOT
              ? basename(src)
              : `${destFolder}/${basename(src)}`;
          if (
            retainRetryablePathMutation(
              operationFolderId,
              src,
              destinationPath,
              error,
            )
          ) {
            return;
          }
          reconcileFailedPathMutation(
            operationFolderId,
            src,
            destinationPath,
            isFolderMove,
            error,
            undefined,
            shieldRollbackBySource.get(src),
          );
        });
    }
  }

  function deleteNodes(paths: string[]) {
    if (!folder) return;
    // Split by location: deleting something in Root moves it to Oblivion
    // (not a tombstone — it survives reload and can be dragged back out).
    // Deleting something already in Oblivion is a real hard delete (emptying
    // the bin). This keeps the recycle-bin contract: root→oblivion is
    // reversible, oblivion→nothing is permanent.
    const inRoot = paths.filter(
      (path) =>
        !isMint(path) &&
        !isScan(path) &&
        !isOblivion(path) &&
        path !== ROOT &&
        path !== OBLIVION,
    );
    const inOblivion = paths.filter((p) => isOblivion(p));
    const fileSet = new Set(Object.keys(files));
    const folderSet = new Set(emptyFolders);
    const deleteTargets: DeleteTabTarget[] = [...inRoot, ...inOblivion].map((path) => ({
      path,
      isFolder:
        folderSet.has(path) ||
        files[path]?.kind === "folder" ||
        hasChild(fileSet, folderSet, path),
    }));
    const deleteRollback = new Map(
      inOblivion.map((path) => {
        const target = deleteTargets.find((candidate) => candidate.path === path)!;
        const under = (candidate: string) =>
          candidate === path ||
          (target.isFolder && candidate.startsWith(`${path}/`));
        const tabs = panelsRef.current.flatMap((panel, panelIndex) =>
          panel.tabs.flatMap((tab) => {
            const tabPath = isFolderTab(tab) ? folderTabPath(tab) : tab;
            return under(tabPath)
              ? [{ panelIndex, tab, wasActive: panel.active === tab }]
              : [];
          }),
        );
        return [
          path,
          {
            tabs,
            tabModes: Object.fromEntries(
              Object.entries(tabModes).filter(([candidate]) => under(candidate)),
            ),
            emptyFolders: [...emptyFolders].filter(under),
            collapsed: [...collapsed].filter(under),
            shielded: [...shieldedRef.current].filter(under),
            selection: directorySelectionRef.current.filter((item) =>
              under(item.path),
            ) as TraceRef[],
            focus:
              uiFocusRef.current?.path && under(uiFocusRef.current.path)
                ? uiFocusRef.current
                : null,
          },
        ] as const;
      }),
    );
    const blockedSource = deleteTargets.find((target) =>
      blocksPendingMintSourceMutation(target.path, target.isFolder),
    );
    if (blockedSource) {
      reportPendingMintBlock(
        `Finish or retry the pending Mint before deleting its source ${blockedSource.path}.`,
      );
      return;
    }
    const nextPanels = closeDeletedTabs(panels, deleteTargets, (tab) =>
      isFolderTab(tab) ? folderTabPath(tab) : tab,
    );
    if (nextPanels !== panels) commitWithCollapse(nextPanels, activePanel);

    if (inRoot.length > 0) {
      // Move each gesture into its own timestamped folder under Oblivion:
      // `oblivion/<YYYY-MM-DD_HHMMSS>/<items>`. Solves name collisions (deleting
      // `draft.md` twice never overwrites the first retained copy) and records when
      // each deletion happened. Second precision means two gestures in the same
      // clock-second could collide on the folder name, so a `-N` suffix bumps
      // until the name is free. The folder is virtual — once every item under
      // it is restored out, buildTree stops rendering it (no files, no explicit
      // empty-folder entry), so emptied timestamps vanish on their own.
      const base = formatLocalSecondStamp(new Date());
      let stamp = base;
      let n = 2;
      const taken = (p: string) =>
        Object.keys(files).some((f) => f.startsWith(p + "/")) || emptyFolders.has(p);
      while (taken(`${OBLIVION}/${stamp}`)) stamp = `${base}-${n++}`;
      moveNodes(inRoot, `${OBLIVION}/${stamp}`);
    }
    if (inOblivion.length > 0) hardDelete(inOblivion, deleteRollback);
  }

  /** Permanently remove the retained local copy. Relay retention remains a
   * separate, optional NIP-09 request owned by the confirmation UI. */
  function hardDelete(
    paths: string[],
    rollbackByPath: ReadonlyMap<
      string,
      {
        tabs: Array<{ panelIndex: number; tab: string; wasActive: boolean }>;
        tabModes: Record<string, Mode>;
        emptyFolders: string[];
        collapsed: string[];
        shielded: string[];
        selection: TraceRef[];
        focus: UiFocus | null;
      }
    > = new Map(),
  ) {
    if (!folder) return;
    const operationFolderId = folder.id;
    const fileSet = new Set(Object.keys(files));
    const folderSet = new Set(emptyFolders);
    // Prune to top-level: drop any path nested beneath another deleted path.
    // The synthetic root (the mounted folder) is never deletable — the UI
    // hides Delete from its context menu, but this is the trust boundary.
    const tops = paths
      .filter((p) => p !== ROOT && p !== OBLIVION)
      .filter((p) => !paths.some((q) => q !== p && isDescendantOrSelf(q, p)));
    if (tops.length === 0) return;
    const blockedSource = tops.find((path) => {
      const isFolderDelete =
        files[path]?.kind === "folder" ||
        folderSet.has(path) ||
        hasChild(fileSet, folderSet, path);
      return blocksPendingMintSourceMutation(path, isFolderDelete);
    });
    if (blockedSource) {
      reportPendingMintBlock(
        `Finish or retry the pending Mint before deleting its source ${blockedSource}.`,
      );
      return;
    }
    projectShieldedForRoot(
      operationFolderId,
      removeDeletedShieldedPaths(shieldedRef.current, tops),
    );
    // A path is removed iff it is a deleted top-level path itself or a
    // descendant of a deleted folder.
    const under = (p: string) =>
      tops.some((t) => {
        if (t === p) return true;
        const isFolderDelete = folderSet.has(t) || hasChild(fileSet, folderSet, t);
        return isFolderDelete && p.startsWith(t + "/");
      });

    setFiles((prev) => {
      const next: Record<string, FileState> = {};
      for (const [p, state] of Object.entries(prev)) {
        if (!under(p)) next[p] = state;
      }
      return next;
    });

    setEmptyFolders((prev) => {
      const next = new Set<string>();
      for (const p of prev) if (!under(p)) next.add(p);
      // A folder whose last child was just deleted should survive as an empty
      // folder rather than vanishing from the tree. For each deleted top, if its
      // immediate parent now has nothing beneath it (no surviving files, no
      // surviving empty-folders) and isn't itself being deleted, record it.
      // Ancestors above the immediate parent don't need recording — buildTree
      // renders them as intermediate folder nodes off the empty-folder entry.
      // Candidates are collected first and filtered against one another so the
      // result is order-independent: e.g. deleting a/b/c.md and a/d.md together
      // yields a/b (empty) and a (non-empty — a/b survives beneath it), so only
      // a/b is added regardless of iteration order.
      const survivingFiles = new Set(Object.keys(files).filter((p) => !under(p)));
      const candidates = new Set<string>();
      for (const top of tops) {
        const parent = parentPath(top);
        if (
          !shouldPreserveEmptyParentAfterDelete(parent) ||
          under(parent) ||
          next.has(parent)
        ) continue;
        candidates.add(parent);
      }
      for (const c of candidates) {
        if (hasChild(survivingFiles, next, c)) continue; // has surviving content
        // Skip if another candidate sits beneath this one — that deeper empty
        // folder keeps this one populated, so it mustn't be recorded as empty.
        let deeper = false;
        for (const d of candidates) {
          if (d !== c && d.startsWith(c + "/")) {
            deeper = true;
            break;
          }
        }
        if (!deeper) next.add(c);
      }
      return next;
    });

    // Drop remembered view modes for the deleted path(s).
    setTabModes((prev) => {
      const next: Record<string, Mode> = {};
      for (const [p, mode] of Object.entries(prev)) if (!under(p)) next[p] = mode;
      return next;
    });

    setCollapsed((prev) => {
      const next = new Set<string>();
      for (const p of prev) if (!under(p)) next.add(p);
      return next;
    });
    chooseDirectorySelection(directorySelectionRef.current.filter((item) => !under(item.path)));
    if (uiFocusRef.current?.path && under(uiFocusRef.current.path)) {
      commitUiFocus(null);
    }
    if (scopeRef.current.some((mount) => under(mount.path))) {
      setScope([{ kind: "folder", path: ROOT }]);
    }

    // Local-only removal. Moving into Oblivion already recorded the trace's
    // signed delete state; relay retention changes only through an explicit
    // NIP-09 request. Each top-level path remains independently removable.
    for (const path of tops) {
      const isFolderDelete =
        files[path]?.kind === "folder" ||
        folderSet.has(path) ||
        hasChild(fileSet, folderSet, path);
      void backendRef.current.deleteLocalPath(path, isFolderDelete)
        .then(() => refreshMountedReplay(operationFolderId))
        .catch((error) => {
          console.warn(`[workspace] deleteLocalPath failed for ${path}:`, error);
          if (
            retainRetryablePathMutation(
              operationFolderId,
              path,
              null,
              error,
            )
          ) {
            return;
          }
          reconcileFailedPathMutation(
            operationFolderId,
            path,
            null,
            isFolderDelete,
            error,
            rollbackByPath.get(path),
          );
        });
    }
  }

  function renameNode(path: string, newName: string): string | null {
    if (!folder) return null;
    const operationFolderId = folder.id;
    if (isMint(path) || isScan(path) || isOblivion(path)) {
      return "Mint, Scan, and Oblivion are read-only.";
    }
    const cleanName = newName.trim();
    if (!cleanName) return "Name cannot be empty.";
    if (cleanName.includes("/"))
      return "Name can't contain a path separator.";
    if (cleanName === "." || cleanName === "..")
      return `"${cleanName}" isn't a valid name.`;

    if (path === ROOT) {
      // Renaming the root only changes its cosmetic display label — the id is
      // permanent, no path/provenance rewrite. Persist it so the rename
      // survives reload, and update `folder` so the header + tree re-render.
      setRootLabel(cleanName);
      setFolder((prev) => (prev ? { ...prev, label: cleanName } : prev));
      return null;
    }

    const oldName = basename(path);
    if (cleanName === oldName) return null; // no-op

    const slash = path.lastIndexOf("/");
    const destPath = slash === -1 ? cleanName : path.slice(0, slash + 1) + cleanName;
    if (destPath !== path) {
      if (files[destPath] || emptyFolders.has(destPath))
        return `A file or folder named "${cleanName}" already exists here.`;
    }

    const fileSet = new Set(Object.keys(files));
    const folderSet = new Set(emptyFolders);
    const isFolderRename =
      files[path]?.kind === "folder" ||
      folderSet.has(path) ||
      hasChild(fileSet, folderSet, path);
    if (blocksPendingMintSourceMutation(path, isFolderRename)) {
      return "Finish or retry the pending Mint before renaming its source.";
    }
    // Folder names become nostr tags, so the same tag-token rule as createCommit.
    if (isFolderRename && !isValidTagToken(cleanName))
      return `"${cleanName}" isn't a valid folder name. Use letters, digits, _ and - only (no spaces).`;

    const rebaser = (p: string): string => {
      if (p === path) return destPath;
      if (isFolderRename && p.startsWith(path + "/")) return destPath + p.slice(path.length);
      return p;
    };

    setFiles((prev) => {
      const next: Record<string, FileState> = {};
      for (const [p, state] of Object.entries(prev)) next[rebaser(p)] = state;
      return next;
    });

    setEmptyFolders((prev) => {
      const next = new Set<string>();
      for (const p of prev) next.add(rebaser(p));
      return next;
    });

    // follow open panels: rebase every tab path and each panel's active path.
    // Folder-tab sentinels rebase against the renamed path (same formula as the
    // file rebaser, applied to the inner relpath).
    const renameTabRebaser = (p: string): string =>
      isFolderTab(p) ? rebaseFolderTab(p, path, parentPath(destPath)) : rebaser(p);
    setPanels((prev) =>
      prev.map((panel) => ({
        tabs: panel.tabs.map(renameTabRebaser),
        active: renameTabRebaser(panel.active),
      })) as [PanelState, PanelState],
    );

    // Rebase remembered view modes so a renamed file keeps the surface it had.
    setTabModes((prev) => {
      const next: Record<string, Mode> = {};
      for (const [p, mode] of Object.entries(prev)) next[rebaser(p)] = mode;
      return next;
    });

    setCollapsed((prev) => {
      const next = new Set<string>();
      for (const p of prev) next.add(rebaser(p));
      // keep the renamed folder expanded so the change is visible
      if (isFolderRename) next.delete(destPath);
      return next;
    });

    const shieldedBeforeRename = shieldedRef.current;
    const renamedShielded = rebaseShieldedPath(
      shieldedBeforeRename,
      path,
      destPath,
    );
    const renameShieldRollback = shieldedPathChange(
      shieldedBeforeRename,
      renamedShielded,
    );
    projectShieldedForRoot(operationFolderId, renamedShielded);
    chooseDirectorySelection(
      directorySelectionRef.current.map((item) => ({ ...item, path: rebaser(item.path) })),
    );
    commitUiFocus(rebaseUiFocus(uiFocusRef.current, rebaser, renameTabRebaser));
    setScope((current) =>
      rebaseContextMountAfterRename(current, path, destPath, isFolderRename),
    );

    // Storage rename + an identity-preserving provenance step. Carry each
    // affected file's user tags through, same as moveNodes.
    const userTagsByPath: Record<string, string[]> = {};
    for (const [p, st] of Object.entries(files)) {
      if (p === path || (isFolderRename && p.startsWith(path + "/"))) {
        userTagsByPath[p] = st.tags;
      }
    }
    void backendRef.current.renamePath(path, cleanName, isFolderRename, userTagsByPath)
      .then(() => refreshMountedReplay(operationFolderId))
      .catch((error) => {
        console.warn(`[workspace] renamePath failed for ${path}:`, error);
        if (
          retainRetryablePathMutation(
            operationFolderId,
            path,
            destPath,
            error,
          )
        ) {
          return;
        }
        reconcileFailedPathMutation(
          operationFolderId,
          path,
          destPath,
          isFolderRename,
          error,
          undefined,
          renameShieldRollback,
        );
      });
    return null;
  }

  return {
    collapsed,
    emptyFolders,
    creating,
    createError,
    toggleFolder,
    createStart,
    createCancel,
    createCommit,
    moveNodes,
    deleteNodes,
    renameNode,
  };
}

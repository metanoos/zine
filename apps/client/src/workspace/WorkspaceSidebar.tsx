import {
  ArrowUpDown,
  BookOpen,
  ChevronDown,
  ChevronRight,
  CircleDollarSign,
  CircleHelp,
  FileInput,
  FileText,
  FileX,
  Folder,
  FolderInput,
  FolderOpen,
  FolderX,
  Leaf,
  Radiation,
  ScanLine,
  Trash2,
} from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  applyScopeClick,
  contextMountState,
  selectionForGroupAction,
  topLevelSelectedPaths,
  type ContextMounts,
  type ScopeRef,
  type TraceRef,
} from "../ai/scope-model.js";
import { SampleModal } from "../app/SampleModal.js";
import { deleteOutcomeMessage } from "./delete-confirmation.js";
import { directoryContextMenuCapabilities } from "./directory-context-menu.js";
import { DIRECTORY_SORT_OPTIONS, type DirectorySortOrder } from "./directory-sort.js";
import {
  isMintPath as isMint,
  isOblivionPath as isOblivion,
  isScanPath as isScan,
  isSystemRootPath,
  MINT,
  OBLIVION,
  SCAN,
  systemPathDisplayName,
} from "./generated-paths.js";
import { basename, canDrop, hasChild, parentPath, ROOT } from "./path-operations.js";
import { treeNodeDisplayName, type TreeNode } from "./tree-model.js";
import { activateTreeItem, type ActivatableTreeItem } from "./tree-routing.js";
import type { Creating } from "./useWorkspaceMutations.js";

// --- components ---------------------------------------------------------

// The inline "new file/folder" phantom row. Rendered among a folder's
// children (or at the top level when parent === ROOT) while `creating` is
// active — instead of a modal. Behaves like the rename input: the user types a
// name directly over the placeholder, Enter commits, Escape/empty-blur cancels.
// A validation error from createCommit surfaces via `error` and keeps the input
// open. Indented to `depth` so it lines up with its future siblings.
function CreateRow({
  kind,
  depth,
  draft,
  error,
  inputRef,
  onChange,
  onKey,
  onCommit,
  onCancel,
}: {
  kind: "file" | "folder";
  depth: number;
  draft: string;
  error: string | null;
  inputRef: React.RefObject<HTMLInputElement | null>;
  onChange: (v: string) => void;
  onKey: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  const indent = { paddingLeft: depth * 14 + 10 };
  const placeholder = kind === "folder" ? "folder name…" : "file name…";
  return (
    <div
      className={"tree-row tree-folder tree-row-creating" + (error ? " tree-row-creating-error" : "")}
      style={indent}
    >
      {kind === "folder" ? (
        <Folder size={13} className="tree-icon" aria-hidden="true" />
      ) : (
        <FileText size={13} className="tree-icon" aria-hidden="true" />
      )}
      <input
        ref={inputRef}
        className={"create-input" + (error ? " invalid" : "")}
        type="text"
        // Filenames are identifiers, not prose — disable the mobile/IME
        // auto-capitalize + auto-complete + spellcheck so the typed casing is
        // preserved verbatim (e.g. lowercase "drafts" stays lowercase).
        autoCapitalize="off"
        autoComplete="off"
        spellCheck={false}
        value={draft}
        placeholder={placeholder}
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKey}
        onBlur={() => {
          // Empty on blur cancels; a non-empty value commits (and stays open
          // if commit returned an error), matching the rename input.
          if (!draft.trim() && !error) onCancel();
          else if (draft.trim()) onCommit();
          else onCancel();
        }}
        aria-invalid={!!error}
      />
      {error && <p className="create-error">{error}</p>}
    </div>
  );
}

function TreeItem({
  node,
  depth,
  collapsed,
  onToggleFolder,
  focusedTabPath,
  selectedPaths,
  scopes,
  shielded,
  onSetMountState,
  draggingPaths,
  dropTargetPath,
  onDragStart,
  onDragEnterTarget,
  onDragLeaveTarget,
  onDropOn,
  canDropOn,
  dragEffect,
  onContextMenuRow,
  renamingPath,
  renameInputRef,
  renameDraft,
  renameError,
  onRenameChange,
  onRenameKey,
  onRenameCommit,
  onRenameCancel,
  onRowActivate,
  onCreateStart,
  onMintCoin,
  coinsEnabled,
  onScan,
  creating,
  createDraft,
  createError,
  createInputRef,
  onCreateChange,
  onCreateKey,
  onCreateCommit,
  onCreateCancel,
}: {
  node: TreeNode;
  depth: number;
  collapsed: Set<string>;
  onToggleFolder: (path: string) => void;
  /** Tree path shown by the active tab in the focused panel. */
  focusedTabPath: string | null;
  /** Explorer-style row selection, kept separate from the context mount. */
  selectedPaths: ReadonlySet<string>;
  /** The one explicit context mount. A folder contributes its descendants. */
  scopes: ContextMounts;
  /** Shielded paths. A folder shields its entire subtree. */
  shielded: Set<string>;
  /** Replace, clear, or exclude within the one prompt-context mount. */
  onSetMountState: (target: ScopeRef, mounted: boolean) => void;
  /** Row click with modifier context. The Sidebar owns ordinary selection;
   *  plain click also activates the trace while modifier clicks select only. */
  onRowActivate: (item: ActivatableTreeItem, e: React.MouseEvent) => void;
  draggingPaths: Set<string>;
  dropTargetPath: string | null;
  onDragStart: (item: ActivatableTreeItem) => void;
  onDragEnterTarget: (path: string) => void;
  onDragLeaveTarget: (path: string) => void;
  onDropOn: (path: string) => void;
  canDropOn: (path: string) => boolean;
  dragEffect: () => "copy" | "move";
  onContextMenuRow: (e: React.MouseEvent, item: ActivatableTreeItem) => void;
  renamingPath: string | null;
  renameInputRef: React.RefObject<HTMLInputElement | null>;
  renameDraft: string;
  renameError: string | null;
  onRenameChange: (v: string) => void;
  onRenameKey: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  onRenameCommit: () => void;
  onRenameCancel: () => void;
  /** New file / New folder from the root row. Parent follows tree selection. */
  onCreateStart: (kind: "file" | "folder") => void;
  /** Open the direct-Coin composer from the Mint region header. */
  onMintCoin: () => void;
  coinsEnabled: boolean;
  /** Acquire a filesystem snapshot from the Scan region header. */
  onScan: (kind: "file" | "folder") => void;
  /** Active inline creation (null unless a New button/context-menu entry was
   *  just clicked). When set, a phantom input row renders among this folder's
   *  children iff `creating.parent === node.path`. */
  creating: Creating | null;
  createDraft: string;
  createError: string | null;
  createInputRef: React.RefObject<HTMLInputElement | null>;
  onCreateChange: (v: string) => void;
  onCreateKey: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  onCreateCommit: () => void;
  onCreateCancel: () => void;
}) {
  const indent = { paddingLeft: depth * 14 + 10 };
  const displayName = treeNodeDisplayName(node);
  const isDragging = draggingPaths.has(node.path);
  const isDropTarget = dropTargetPath === node.path;
  const isRenaming = renamingPath === node.path;
  const isTabFocused = focusedTabPath !== null && node.path === focusedTabPath;
  const isTreeSelected = selectedPaths.has(node.path);
  if (node.type === "folder") {
    const isOpen = !collapsed.has(node.path);
    const dropAllowed = canDropOn(node.path);
    const isRoot = node.isRoot === true;
    const isSystemRegion =
      node.systemKind === "mint" ||
      node.systemKind === "scan" ||
      node.systemKind === "oblivion";
    const privateSystemItem =
      isMint(node.path) || isScan(node.path) || isOblivion(node.path);
    const folderMountState = privateSystemItem
      ? "unmounted"
      : contextMountState(scopes, shielded, node.path);
    const folderMounted = folderMountState === "mounted";
    const folderIncluded = folderMounted || folderMountState === "included";
    const folderIconClass =
      "tree-icon" +
      (isOblivion(node.path)
        ? " tree-icon-oblivion"
        : folderMounted
          ? " tree-icon-in-scope"
          : folderMountState === "included"
            ? " tree-icon-included"
            : folderMountState === "shielded"
              ? " tree-icon-shielded"
              : "");
    const rowClass =
      "tree-row tree-folder" +
      (isRoot ? " tree-row-root" : "") +
      (isTabFocused ? " tree-row-tab-focused" : "") +
      (isTreeSelected ? " tree-row-selected" : "") +
      (isDragging ? " tree-dragging" : "") +
      (isDropTarget && dropAllowed ? " tree-drop-target" : "") +
      (isDropTarget && !dropAllowed ? " tree-drop-denied" : "");
    const folderGlyph =
      node.systemKind === "mint" ? (
        <Leaf size={13} className="tree-icon tree-icon-mint" aria-hidden="true" />
      ) : node.systemKind === "scan" ? (
        <ScanLine size={13} className="tree-icon tree-icon-scan" aria-hidden="true" />
      ) : node.systemKind === "oblivion" ? (
        <Trash2 size={13} className="tree-icon" aria-hidden="true" />
      ) : folderMountState === "shielded" ? (
        <FolderX size={13} className={folderIconClass} aria-hidden="true" />
      ) : node.systemKind === "root" ? (
        <BookOpen size={13} className={folderIconClass} aria-hidden="true" />
      ) : isScan(node.path) ? (
        <FolderInput size={13} className="tree-icon tree-icon-scan" aria-hidden="true" />
      ) : isOpen ? (
        <FolderOpen size={13} className={folderIconClass} aria-hidden="true" />
      ) : (
        <Folder size={13} className={folderIconClass} aria-hidden="true" />
      );
    return (
      <div
        className={
          "tree-node" +
          (isRoot ? " tree-node-root" : "")
        }
      >
        <div
          className={rowClass}
          style={indent}
          aria-current={isTabFocused ? "true" : undefined}
          draggable={!isRoot && !isRenaming}
          onDragStart={(e) => {
            // copyMove: tree reparent uses "move"; tag-strip drop uses "copy".
            // "move"-only rejects a link/copy dropEffect and the tag drop dies.
            e.dataTransfer.effectAllowed = "copyMove";
            e.dataTransfer.setData("text/zine-path", node.path);
            // text/plain fallback for hosts that strip custom MIME types
            // (WKWebView / some Tauri shells) on getData at drop time.
            e.dataTransfer.setData("text/plain", `zine-path:${node.path}`);
            onDragStart(node);
          }}
          onDragEnter={(e) => {
            if (canDropOn(node.path)) {
              e.preventDefault();
              onDragEnterTarget(node.path);
            }
          }}
          onDragOver={(e) => {
            // The root is always a drop target (drop on root = move to root);
            // other folders only when a drop is allowed and they're not the
            // dragged source.
            if (canDropOn(node.path)) {
              e.preventDefault();
              e.dataTransfer.dropEffect = dragEffect();
              // dragenter can race the dragstart render in WebKit. Reassert
              // the target from dragover so the valid-target ring still paints.
              onDragEnterTarget(node.path);
            }
          }}
          onDragLeave={(e) => {
            // only clear when leaving for a different row, not when entering a child
            if (e.currentTarget.contains(e.relatedTarget as Node)) return;
            onDragLeaveTarget(node.path);
          }}
          onDrop={(e) => {
            // Never let a folder-row drop fall through to the tree container's
            // "move to root" surface, even when this folder is invalid.
            e.stopPropagation();
            if (!canDropOn(node.path)) return;
            e.preventDefault();
            onDropOn(node.path);
          }}
          onContextMenu={(e) => onContextMenuRow(e, node)}
          onClick={(e) => {
            // The label focuses/opens the folder. Expansion belongs only to
            // the separate chevron below.
            if (!isRenaming) onRowActivate(node, e);
          }}
        >
          <button
            type="button"
            className="tree-expand-btn"
            aria-expanded={isOpen}
            aria-label={`${isOpen ? "Collapse" : "Expand"} ${displayName}`}
            title={isOpen ? "Collapse folder" : "Expand folder"}
            onClick={(e) => {
              e.stopPropagation();
              onToggleFolder(node.path);
            }}
          >
            {isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </button>
          {isSystemRegion || isScan(node.path) ? (
            <span
              className="tree-icon-slot tree-system-icon"
              title={
                node.systemKind === "mint"
                  ? "Mint"
                  : node.systemKind === "scan"
                    ? "Scan"
                    : isScan(node.path)
                      ? "Scanned folder"
                    : "Oblivion"
              }
              aria-hidden="true"
            >
              {folderGlyph}
            </span>
          ) : (
            <button
              type="button"
              className="tree-icon-slot tree-icon-btn"
              data-mount-state={folderMountState}
              aria-pressed={folderIncluded}
              aria-label={
                folderIncluded
                  ? `Exclude ${displayName} from context`
                  : `Mount ${displayName} for context`
              }
              title={
                folderIncluded
                  ? "Exclude folder and descendants from prompt context"
                  : "Mount folder and descendants, replacing the current prompt context"
              }
              onClick={(e) => {
                e.stopPropagation();
                onSetMountState(
                  { kind: "folder", path: node.path },
                  !folderIncluded,
                );
              }}
            >
              {folderGlyph}
            </button>
          )}
          {isRenaming ? (
            <input
              ref={renameInputRef}
              className={"create-input" + (renameError ? " invalid" : "")}
              type="text"
              autoCapitalize="off"
              autoComplete="off"
              spellCheck={false}
              value={renameDraft}
              placeholder="folder name…"
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => onRenameChange(e.target.value)}
              onKeyDown={onRenameKey}
              onBlur={() => {
                // Empty on blur cancels; a non-empty value commits (and
                // stays open if commit returned an error).
                if (!renameDraft.trim() && !renameError) onRenameCancel();
                else if (renameDraft.trim()) onRenameCommit();
                else onRenameCancel();
              }}
              aria-invalid={!!renameError}
            />
          ) : (
            <span className="tree-name">{displayName}</span>
          )}
          {isRoot && node.systemKind === "root" && (
            <span
              className="tree-row-actions"
              onClick={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
            >
              <button
                className="icon-btn"
                type="button"
                title="New folder"
                aria-label="New folder"
                onClick={() => onCreateStart("folder")}
              >
                <Folder size={14} aria-hidden="true" />
              </button>
              <button
                className="icon-btn"
                type="button"
                title="New file"
                aria-label="New file"
                onClick={() => onCreateStart("file")}
              >
                <FileText size={14} aria-hidden="true" />
              </button>
            </span>
          )}
          {isRoot && node.systemKind === "mint" && (
            <span
              className="tree-row-actions"
              onClick={(event) => event.stopPropagation()}
              onMouseDown={(event) => event.stopPropagation()}
            >
              <button
                className="icon-btn"
                type="button"
                title={coinsEnabled
                  ? "Mint a direct Coin"
                  : "Enable Coins in Networking to Mint"}
                aria-label="Mint a direct Coin"
                disabled={!coinsEnabled}
                onClick={onMintCoin}
              >
                <CircleDollarSign size={14} aria-hidden="true" />
              </button>
            </span>
          )}
          {isRoot && node.systemKind === "scan" && (
            <span
              className="tree-row-actions"
              onClick={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
            >
              <button
                className="icon-btn"
                type="button"
                title="Scan folder"
                aria-label="Scan folder"
                onClick={() => onScan("folder")}
              >
                <FolderInput size={14} aria-hidden="true" />
              </button>
              <button
                className="icon-btn"
                type="button"
                title="Scan file"
                aria-label="Scan file"
                onClick={() => onScan("file")}
              >
                <FileInput size={14} aria-hidden="true" />
              </button>
            </span>
          )}
          {isRenaming && renameError && <p className="create-error">{renameError}</p>}
        </div>
        {isOpen && (
          <div className="tree-children">
            {node.children!.map((c) => (
              <TreeItem
                key={c.path}
                node={c}
                depth={depth + 1}
                collapsed={collapsed}
                onToggleFolder={onToggleFolder}
                focusedTabPath={focusedTabPath}
                selectedPaths={selectedPaths}
                scopes={scopes}
                shielded={shielded}
                onSetMountState={onSetMountState}
                draggingPaths={draggingPaths}
                dropTargetPath={dropTargetPath}
                onDragStart={onDragStart}
                onDragEnterTarget={onDragEnterTarget}
                onDragLeaveTarget={onDragLeaveTarget}
                onDropOn={onDropOn}
                canDropOn={canDropOn}
                dragEffect={dragEffect}
                onContextMenuRow={onContextMenuRow}
                renamingPath={renamingPath}
                renameInputRef={renameInputRef}
                renameDraft={renameDraft}
                renameError={renameError}
                onRenameChange={onRenameChange}
                onRenameKey={onRenameKey}
                onRenameCommit={onRenameCommit}
                onRenameCancel={onRenameCancel}
                onRowActivate={onRowActivate}
                onCreateStart={onCreateStart}
                onMintCoin={onMintCoin}
                coinsEnabled={coinsEnabled}
                onScan={onScan}
                creating={creating}
                createDraft={createDraft}
                createError={createError}
                createInputRef={createInputRef}
                onCreateChange={onCreateChange}
                onCreateKey={onCreateKey}
                onCreateCommit={onCreateCommit}
                onCreateCancel={onCreateCancel}
              />
            ))}
            {creating &&
              creating.parent === node.path &&
              CreateRow({
                kind: creating.kind,
                depth: depth + 1,
                draft: createDraft,
                error: createError,
                inputRef: createInputRef,
                onChange: onCreateChange,
                onKey: onCreateKey,
                onCommit: onCreateCommit,
                onCancel: onCreateCancel,
              })}
          </div>
        )}
      </div>
    );
  }

  const privateSystemItem =
    isMint(node.path) || isScan(node.path) || isOblivion(node.path);
  const fileMountState = privateSystemItem
    ? "unmounted"
    : contextMountState(scopes, shielded, node.path);
  const fileMounted = fileMountState === "mounted";
  const fileIncluded = fileMounted || fileMountState === "included";
  const fileIconClass =
    "tree-icon" +
    (isOblivion(node.path)
      ? " tree-icon-oblivion"
      : fileMounted
        ? " tree-icon-in-scope"
        : fileMountState === "included"
          ? " tree-icon-included"
          : fileMountState === "shielded"
            ? " tree-icon-shielded"
            : "");

  return (
    <div
      className={
        "tree-row tree-file" +
        (isTabFocused ? " tree-row-tab-focused" : "") +
        (isTreeSelected ? " tree-row-selected" : "") +
        (isDragging ? " tree-dragging" : "")
      }
      style={indent}
      aria-current={isTabFocused ? "true" : undefined}
      draggable={!isRenaming && node.systemKind !== "mint-pending"}
      onDragStart={(e) => {
        // copyMove: tree reparent uses "move"; tag-strip drop uses "copy".
        e.dataTransfer.effectAllowed = "copyMove";
        e.dataTransfer.setData("text/zine-path", node.path);
        e.dataTransfer.setData("text/plain", `zine-path:${node.path}`);
        onDragStart(node);
      }}
      onContextMenu={(e) => onContextMenuRow(e, node)}
      onClick={(e) => {
        // Don't open the file while its name is being edited. onRowActivate
        // handles plain (select-sole + open) and modifier (cmd/shift) clicks.
        if (!isRenaming) onRowActivate(node, e);
      }}
    >
      <span className="tree-expand-spacer" aria-hidden="true" />
      {node.systemKind === "minted" || node.systemKind === "mint-pending" || isScan(node.path) ? (
        <span
          className="tree-icon-slot tree-system-icon"
          title={
            node.systemKind === "minted"
              ? "Coin"
              : node.systemKind === "mint-pending"
                ? "Incomplete Mint artifact"
                : "Scanned file"
          }
          aria-hidden="true"
        >
          {node.systemKind === "minted" ? (
            <CircleDollarSign size={13} className="tree-icon tree-icon-coin" aria-hidden="true" />
          ) : node.systemKind === "mint-pending" ? (
            <FileX size={13} className="tree-icon tree-icon-mint-pending" aria-hidden="true" />
          ) : (
            <FileInput size={13} className="tree-icon tree-icon-scan" aria-hidden="true" />
          )}
        </span>
      ) : (
        <button
          type="button"
          className="tree-icon-slot tree-icon-btn"
          data-mount-state={fileMountState}
          aria-pressed={fileIncluded}
          aria-label={
            fileIncluded
              ? `Exclude ${displayName} from context`
              : `Mount ${displayName} for context`
          }
          title={
            fileIncluded
              ? "Exclude file from prompt context"
              : "Mount file, replacing the current prompt context"
          }
          onClick={(e) => {
            e.stopPropagation();
            onSetMountState(
              { kind: "file", path: node.path },
              !fileIncluded,
            );
          }}
        >
          {fileMountState === "shielded" ? (
            <FileX size={13} className={fileIconClass} aria-hidden="true" />
          ) : (
            <FileText size={13} className={fileIconClass} aria-hidden="true" />
          )}
        </button>
      )}
      {isRenaming ? (
        <input
          ref={renameInputRef}
          className={"create-input" + (renameError ? " invalid" : "")}
          type="text"
          autoCapitalize="off"
          autoComplete="off"
          spellCheck={false}
          value={renameDraft}
          placeholder="file name…"
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => onRenameChange(e.target.value)}
          onKeyDown={onRenameKey}
          onBlur={() => {
            if (!renameDraft.trim() && !renameError) onRenameCancel();
            else if (renameDraft.trim()) onRenameCommit();
            else onRenameCancel();
          }}
          aria-invalid={!!renameError}
        />
      ) : (
        <span className="tree-name">{displayName}</span>
      )}
      {isRenaming && renameError && <p className="create-error">{renameError}</p>}
    </div>
  );
}

export function Sidebar({
  tree,
  collapsed,
  onToggleFolder,
  focusedTabPath,
  selectedItems,
  onSelectionChange,
  scopes,
  shielded,
  onSetMountState,
  onActivateFile,
  onActivateCoin,
  onActivateOblivion,
  onActivateFolder,
  onOpenFolder,
  onMintCoin,
  coinsEnabled,
  onScan,
  onReify,
  onStepFolder,
  creating,
  createError,
  onCreateStart,
  onCreateCommit,
  onCreateCancel,
  filePaths,
  folderPaths,
  onMove,
  onDelete,
  onRevoke,
  onRename,
  samplerOpen,
  onToggleSampler,
  sampler,
  tagBrowserOpen,
  onToggleTagBrowser,
  tagBrowser,
  folderId,
  onOpenToSide,
  directorySort,
  onDirectorySortChange,
  onOpenOnboarding,
  onOpenFactoryReset,
}: {
  tree: TreeNode[];
  collapsed: Set<string>;
  onToggleFolder: (path: string) => void;
  /** Tree path shown by the active tab in the focused panel, or null when no
   *  tab is active. Drives only the focus marker; it never mutates scope. */
  focusedTabPath: string | null;
  /** Explorer selection. This exact trace union supplies playback. */
  selectedItems: readonly TraceRef[];
  onSelectionChange: (items: TraceRef[]) => void;
  /** The one explicit context mount, owned by App. */
  scopes: ContextMounts;
  /** Shielded traversal boundaries, passed through to each row. */
  shielded: Set<string>;
  onSetMountState: (target: ScopeRef, mounted: boolean) => void;
  /** Open a file into the active panel and make it the active trace. Called on
   *  a plain (non-modifier) click of a file row. */
  onActivateFile: (path: string) => void;
  /** Inspect a Mint entry without opening its file-shaped storage node. */
  onActivateCoin: (path: string) => void;
  /** Inspect an Oblivion file from its explicit context-menu action. */
  onActivateOblivion: (path: string) => void;
  /** Make a folder the active trace (folders aren't editors, so nothing opens).
   *  Called on a plain (non-modifier) click of a folder row. Expand/collapse is
   *  toggled separately by the row's onClick. */
  onActivateFolder: (path: string) => void;
  /** Open a folder tab in the active panel from its context menu. */
  onOpenFolder: (path: string) => void;
  /** Open the direct-Coin composer from the Mint region header. */
  onMintCoin: () => void;
  coinsEnabled: boolean;
  /** Acquire a file or folder from the Scan region header. */
  onScan: (kind: "file" | "folder") => void;
  /** Reify one explicitly chosen tree file or folder to the filesystem. */
  onReify: (target: ScopeRef) => void;
  /** Recursively flush dirty descendants, then append one explicit folder Step. */
  onStepFolder: (path: string) => void;
  creating: Creating | null;
  createError: string | null;
  onCreateStart: (kind: "file" | "folder", parent?: string) => void;
  onCreateCommit: (name: string) => void;
  onCreateCancel: () => void;
  filePaths: Set<string>;
  folderPaths: Set<string>;
  onMove: (srcs: string[], destFolder: string) => void;
  onDelete: (paths: string[]) => void;
  /** Publish a NIP-09 request for one file trace without deleting it locally. */
  onRevoke: (path: string) => Promise<string>;
  onRename: (path: string, newName: string) => string | null;
  samplerOpen: boolean;
  onToggleSampler: () => void;
  sampler: React.ReactNode;
  tagBrowserOpen: boolean;
  onToggleTagBrowser: () => void;
  tagBrowser: React.ReactNode;
  /** Id of the attached folder. A change (switch/detach) clears the tree
   *  multi-selection so it never refers to paths that no longer exist. */
  folderId: string | null;
  /** Open a tree item into a fresh column to the right of the active panel
   *  (the context menu's "Open to side"). A folder opens as a folder tab, a
   *  file as an editor tab; a new column is always spawned. */
  onOpenToSide: (path: string) => void;
  /** One ordering preference shared by Root and every generated region. */
  directorySort: DirectorySortOrder;
  onDirectorySortChange: (order: DirectorySortOrder) => void;
  /** Restart the guided first-trace journey. */
  onOpenOnboarding: () => void;
  /** Open the destructive local-app factory-reset confirmation. */
  onOpenFactoryReset: () => void;
}) {
  // inline rename state. renamingPath is the node being edited; renameDraft is
  // the live input value; renameError keeps the input open on a bad name (same
  // UX as the new-file/new-folder row). Only one rename at a time.
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (renamingPath) {
      const el = renameInputRef.current;
      if (el) {
        el.focus();
        el.select();
      }
    }
  }, [renamingPath]);

  // Inline create draft — the live value of the phantom row's input. Mirrors
  // the rename draft: `creating` (owned by App) holds {kind, parent}; this
  // holds the typed name. On Enter/blur-commit it's passed to onCreateCommit;
  // Escape/empty-blur calls onCreateCancel. A validation error from
  // createCommit surfaces via createError and keeps the input open.
  const [createDraft, setCreateDraft] = useState("");
  const createInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (creating) {
      setCreateDraft("");
      // Focus on next paint so the input is mounted (the phantom row only
      // renders once `creating` is set).
      requestAnimationFrame(() => {
        const el = createInputRef.current;
        if (el) {
          el.focus();
          el.select();
        }
      });
    }
  }, [creating]);

  // Explorer selection is replay state owned by App. The context mount remains a
  // separate state path and only the icon buttons mutate them.
  const [anchorPath, setAnchorPath] = useState<string | null>(null);
  const selectedPaths = useMemo(
    () => new Set(selectedItems.map((item) => item.path)),
    [selectedItems],
  );

  // drag state lives here — the set of source paths being dragged (one or
  // many) and the currently-hovered drop target (a folder path, or "" for root).
  // The ref is the event-time authority: native dragenter/dragover can arrive
  // before dragstart's React state update renders, especially in WKWebView.
  // State exists for source/target paint only; acceptance and drop read the ref.
  const draggingPathsRef = useRef<Set<string>>(new Set());
  const [draggingPaths, setDraggingPaths] = useState<Set<string>>(() => new Set());
  const [dropTargetPath, setDropTargetPath] = useState<string | null>(null);

  // context menu + delete-confirm state. ctxMenu is positioned at the cursor;
  // confirmDelete holds the paths pending a Delete click.
  const [ctxMenu, setCtxMenu] = useState<{
    x: number;
    y: number;
    path: string;
    systemKind?: ActivatableTreeItem["systemKind"];
  } | null>(null);
  const [sortMenuOpen, setSortMenuOpen] = useState(false);
  const sortMenuRef = useRef<HTMLDivElement>(null);
  const [confirmDelete, setConfirmDelete] = useState<{
    paths: string[];
    name: string;
    isFolder: boolean;
    childCount: number;
  } | null>(null);
  const [deleteWithRevocation, setDeleteWithRevocation] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState<{ path: string; name: string } | null>(null);
  const [revokeBusy, setRevokeBusy] = useState(false);
  const [revokeMessage, setRevokeMessage] = useState<string | null>(null);
  const [revokeError, setRevokeError] = useState<string | null>(null);

  useEffect(() => {
    if (!sortMenuOpen) return;
    function onPointerDown(e: MouseEvent) {
      if (!sortMenuRef.current?.contains(e.target as Node)) setSortMenuOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setSortMenuOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [sortMenuOpen]);

  // App clears the replay/tree selection when the attached folder changes;
  // the Sidebar only owns the range-selection anchor.
  const folderIdRef = useRef(folderId);
  useEffect(() => {
    if (folderIdRef.current !== folderId) {
      folderIdRef.current = folderId;
      setAnchorPath(null);
    }
  }, [folderId]);

  // A flat, ordered list of the currently-visible tree items (files + folders,
  // depth-first in display order). Shift-click ranges are computed over this so
  // collapsed subtrees are skipped, matching what the user sees.
  const visibleItems = useMemo(() => {
    const out: TraceRef[] = [];
    const walk = (nodes: TreeNode[]) => {
      for (const n of nodes) {
        out.push({ kind: n.type, path: n.path });
        if (n.type === "folder" && !collapsed.has(n.path) && n.children) walk(n.children);
      }
    };
    walk(tree);
    return out;
  }, [tree, collapsed]);

  // The folder the New file / New folder root-row buttons should create into:
  // the active trace's folder if it's a folder, else the parent of the active
  // file (a top-level file → root). Falls back to root when nothing is active.
  // Mirrors how a file explorer scopes "new" to the currently-focused location.
  function createParent(): string {
    // Prefer the sole selected folder: clicking a New button after selecting a
    // folder should nest inside it, regardless of which tab the focused panel
    // is showing. `focusedTabPath` follows open tabs, while row selection is
    // local to the explorer. Falls back to focused-panel location when there
    // is not exactly one selected folder.
    if (selectedItems.length === 1) {
      const selected = selectedItems[0];
      if (selected.kind === "folder") {
        return selected.path;
      }
    }
    const p = focusedTabPath;
    if (!p) return ROOT;
    if (folderPaths.has(p) || hasChild(filePaths, folderPaths, p)) return p;
    return parentPath(p);
  }

  // Modifier gestures edit the Explorer operation set without moving focus.
  // A plain click clears stale operation selection, then focuses/opens exactly
  // one trace. Context mounting remains exclusive to icon buttons.
  function onRowActivate(item: ActivatableTreeItem, e: React.MouseEvent) {
    if (!e.metaKey && !e.ctrlKey && !e.shiftKey) {
      onSelectionChange([]);
      setAnchorPath(null);
      activateTreeItem(item, {
        file: onActivateFile,
        folder: onActivateFolder,
        coin: onActivateCoin,
      });
      return;
    }
    const result = applyScopeClick(
      selectedItems,
      { kind: item.type, path: item.path },
      visibleItems,
      anchorPath,
      { additive: e.metaKey || e.ctrlKey, range: e.shiftKey },
    );
    onSelectionChange(result.scopes);
    setAnchorPath(result.anchorPath);
  }

  useEffect(() => {
    function clearOperationSelection(e: KeyboardEvent) {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const target = e.target as HTMLElement | null;
      if (
        target?.matches("input, textarea, select") ||
        target?.isContentEditable
      ) return;
      onSelectionChange([]);
      setAnchorPath(null);
    }
    document.addEventListener("keydown", clearOperationSelection);
    return () => document.removeEventListener("keydown", clearOperationSelection);
  }, [onSelectionChange]);

  // dismiss the context menu on any pointer-down outside the menu itself, or
  // on Escape. A single listener covers both the menu and the open-input row.
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ctxMenu) return;
    function onPointerDown(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setCtxMenu(null);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setCtxMenu(null);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [ctxMenu]);

  // Right-click selects only this row unless it already belongs to the current
  // explorer selection, in which case the menu acts on the whole selection.
  function openContextMenu(e: React.MouseEvent, item: ActivatableTreeItem) {
    e.preventDefault();
    e.stopPropagation();
    // Oblivion is a lifecycle boundary, not an actionable directory. Suppress
    // both the native menu and an empty custom popover for its header row.
    if (item.path === OBLIVION) {
      setCtxMenu(null);
      return;
    }
    const actionSelection = selectionForGroupAction(selectedItems, {
      kind: item.type,
      path: item.path,
    });
    if (!selectedPaths.has(item.path)) {
      onSelectionChange(actionSelection);
      setAnchorPath(item.path);
    }
    setCtxMenu({
      x: e.clientX,
      y: e.clientY,
      path: item.path,
      ...(item.systemKind ? { systemKind: item.systemKind } : {}),
    });
  }

  // The paths a Delete should act on: the current selection, pruned of any
  // path nested beneath another selected path (an ancestor carries its
  // descendants, so listing both would double-count).
  function topLevelSelected(): string[] {
    return topLevelSelectedPaths(selectedItems);
  }

  function requestDelete(paths: string[]) {
    setCtxMenu(null);
    setDeleteWithRevocation(false);
    setDeleteBusy(false);
    setDeleteError(null);
    // Summarize for the confirm dialog: total descendant count across the
    // selected top-level paths, plus a display name (the first path's).
    let childCount = 0;
    let anyFolder = false;
    for (const path of paths) {
      const isFolder = folderPaths.has(path) || hasChild(filePaths, folderPaths, path);
      if (isFolder) {
        anyFolder = true;
        for (const p of filePaths) if (p.startsWith(path + "/")) childCount++;
        for (const p of folderPaths) if (p.startsWith(path + "/")) childCount++;
      }
    }
    const single = paths.length === 1;
    const name = single ? basename(paths[0]) : `${paths.length} items`;
    setConfirmDelete({ paths, name, isFolder: anyFolder, childCount });
  }

  const deleteRevocationTargets = useMemo(() => {
    if (!confirmDelete) return [];
    return [...filePaths].filter(
      (path) =>
        isOblivion(path) &&
        confirmDelete.paths.some(
          (selected) => path === selected || path.startsWith(selected + "/"),
        ),
    );
  }, [confirmDelete, filePaths]);

  async function confirmPermanentDelete(): Promise<void> {
    if (!confirmDelete || deleteBusy) return;
    const confirmedPaths = confirmDelete.paths;
    if (deleteWithRevocation && deleteRevocationTargets.length > 0) {
      setDeleteBusy(true);
      setDeleteError(null);
      try {
        await Promise.all(deleteRevocationTargets.map(onRevoke));
      } catch (error) {
        setDeleteError(
          `Relay revocation failed; no local copies were deleted. ${error instanceof Error ? error.message : String(error)}`,
        );
        setDeleteBusy(false);
        return;
      }
    }
    onDelete(confirmedPaths);
    setDeleteBusy(false);
    setConfirmDelete(null);
  }

  // Begin an inline rename of `path`. Prefills the input with the current
  // basename; the focus/select effect above selects it for overtype.
  function requestRename(path: string) {
    setCtxMenu(null);
    setRenamingPath(path);
    setRenameDraft(basename(path));
    setRenameError(null);
  }

  function cancelRename() {
    setRenamingPath(null);
    setRenameDraft("");
    setRenameError(null);
  }

  // Commit the rename from the live draft. Returns to the trust boundary
  // (App.renameNode); on a rejection keeps the input open with the error so
  // the user can fix it, exactly like CreateModal's blur-on-error behavior.
  function commitRename() {
    if (!renamingPath) return;
    const name = renameDraft.trim();
    if (!name) {
      cancelRename();
      return;
    }
    const err = onRename(renamingPath, name);
    if (err) {
      setRenameError(err);
      return;
    }
    cancelRename();
  }

  function onRenameKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      commitRename();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancelRename();
    }
  }

  // Inline create handlers — the phantom row's input. Enter/non-empty blur
  // commits the typed draft to the App-level createCommit (which validates and
  // creates on disk); Escape/empty blur cancels. A validation error leaves
  // `creating` set so the input stays open, exactly like the rename flow.
  function commitCreate() {
    const name = createDraft.trim();
    if (name) onCreateCommit(name);
    else onCreateCancel();
  }
  function onCreateKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      commitCreate();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onCreateCancel();
    }
  }

  // Can any of the dragging sources land in `destFolder`? Used to light the
  // drop target and gate preventDefault. A drop is offered as long as at least
  // one source can move there (the drop handler prunes the ones that can't).
  function canDropOn(destFolder: string): boolean {
    const current = draggingPathsRef.current;
    if (current.size === 0) return false;
    if (current.has(destFolder)) return false;
    for (const src of current) {
      if (canDrop(src, destFolder, filePaths, folderPaths)) return true;
    }
    return false;
  }

  function dragEffect(): "copy" | "move" {
    return [...draggingPathsRef.current].some(
      (path) =>
        (isMint(path) && path !== MINT) ||
        (isScan(path) && path !== SCAN),
    )
      ? "copy"
      : "move";
  }

  function clearDrag() {
    const empty = new Set<string>();
    draggingPathsRef.current = empty;
    setDraggingPaths(empty);
    setDropTargetPath(null);
  }

  return (
    <nav className="sidebar">
      <div className="sidebar-directory-tree">
        <div
          className={"tree" + (dropTargetPath === ROOT && canDropOn(ROOT) ? " tree-drop-target" : "")}
          onDragEnter={(e) => {
            if (e.target === e.currentTarget && canDropOn(ROOT)) {
              e.preventDefault();
              setDropTargetPath(ROOT);
            }
          }}
          onDragOver={(e) => {
            // allow dropping onto empty space inside the tree → move to root.
            // child rows stopPropagation on their own drops, so this only fires
            // for the bare container.
            if (e.target === e.currentTarget && canDropOn(ROOT)) {
              e.preventDefault();
              e.dataTransfer.dropEffect = dragEffect();
              setDropTargetPath(ROOT);
            }
          }}
          onDrop={(e) => {
            if (e.target !== e.currentTarget || !canDropOn(ROOT)) return;
            e.preventDefault();
            onMove([...draggingPathsRef.current], ROOT);
            clearDrag();
          }}
          onDragEnd={clearDrag}
        >
          {tree.map((node) => (
            <TreeItem
              key={node.path}
              node={node}
              depth={0}
              collapsed={collapsed}
              onToggleFolder={onToggleFolder}
              focusedTabPath={focusedTabPath}
              selectedPaths={selectedPaths}
              scopes={scopes}
              shielded={shielded}
              onSetMountState={onSetMountState}
              draggingPaths={draggingPaths}
              dropTargetPath={dropTargetPath}
              onDragStart={(item) => {
                const actionSelection = selectionForGroupAction(selectedItems, {
                  kind: item.type,
                  path: item.path,
                });
                // Dragging a selected row drags the selected group; dragging
                // any other row first selects it alone.
                if (!selectedPaths.has(item.path)) {
                  onSelectionChange(actionSelection);
                  setAnchorPath(item.path);
                }
                const nextDragging = new Set(topLevelSelectedPaths(actionSelection));
                draggingPathsRef.current = nextDragging;
                setDraggingPaths(nextDragging);
              }}
              onDragEnterTarget={setDropTargetPath}
              onDragLeaveTarget={(path) => {
                setDropTargetPath((cur) => (cur === path ? null : cur));
              }}
              onDropOn={(destFolder) => {
                onMove([...draggingPathsRef.current], destFolder);
                clearDrag();
              }}
              canDropOn={canDropOn}
              dragEffect={dragEffect}
              onContextMenuRow={openContextMenu}
              renamingPath={renamingPath}
              renameInputRef={renameInputRef}
              renameDraft={renameDraft}
              renameError={renameError}
              onRenameChange={setRenameDraft}
              onRenameKey={onRenameKey}
              onRenameCommit={commitRename}
              onRenameCancel={cancelRename}
              onRowActivate={onRowActivate}
              onCreateStart={(kind) => onCreateStart(kind, createParent())}
              onMintCoin={onMintCoin}
              coinsEnabled={coinsEnabled}
              onScan={onScan}
              creating={creating}
              createDraft={createDraft}
              createError={createError}
              createInputRef={createInputRef}
              onCreateChange={setCreateDraft}
              onCreateKey={onCreateKey}
              onCreateCommit={commitCreate}
              onCreateCancel={onCreateCancel}
            />
          ))}
        </div>
        <div className="sidebar-directory-footer">
          <div ref={sortMenuRef} className="sidebar-sort-control">
            <button
              type="button"
              className={`icon-btn sidebar-sort-btn${sortMenuOpen ? " active" : ""}`}
              title="Sort directory"
              aria-label="Sort directory"
              aria-expanded={sortMenuOpen}
              aria-controls="directory-sort-menu"
              onClick={() => setSortMenuOpen((open) => !open)}
            >
              <ArrowUpDown size={16} aria-hidden="true" />
            </button>
            {sortMenuOpen && (
              <div
                id="directory-sort-menu"
                className="sidebar-sort-menu"
                role="radiogroup"
                aria-label="Directory sort order"
              >
                <span className="sidebar-sort-label">Sort directory</span>
                {DIRECTORY_SORT_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    className="sidebar-sort-option"
                    role="radio"
                    aria-checked={directorySort === option.value}
                    onClick={() => {
                      onDirectorySortChange(option.value);
                      setSortMenuOpen(false);
                    }}
                  >
                    <span aria-hidden="true">
                      {directorySort === option.value ? "●" : "○"}
                    </span>
                    {option.label}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button
            type="button"
            className="icon-btn sidebar-help-btn"
            title="Onboarding"
            aria-label="Open onboarding guide"
            onClick={onOpenOnboarding}
          >
            <CircleHelp size={16} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="icon-btn sidebar-reset-btn"
            title="Factory reset"
            aria-label="Factory reset"
            onClick={onOpenFactoryReset}
          >
            <Radiation size={16} aria-hidden="true" />
          </button>
        </div>
      </div>
      {ctxMenu && (
        <div
          ref={menuRef}
          className="ctx-menu"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
          onContextMenu={(e) => e.preventDefault()}
        >
          {(() => {
            const path = ctxMenu.path;
            const isFolder =
              path === ROOT ||
              isSystemRootPath(path) ||
              folderPaths.has(path) ||
              hasChild(filePaths, folderPaths, path);
            const isCoin = !isFolder && ctxMenu.systemKind === "minted";
            const menu = directoryContextMenuCapabilities(
              path,
              isFolder,
              selectedPaths.size,
            );
            if (!menu.showMenu) return null;

            // Build capability groups first, then insert separators only
            // between non-empty groups. This avoids each item type growing its
            // own subtly different separator and trailing-divider rules.
            const groups: ReactNode[] = [];
            if (menu.openLabel) {
              groups.push(
                <Fragment key="open">
                  <button
                    type="button"
                    className="ctx-menu-item"
                    onClick={() => {
                      setCtxMenu(null);
                      if (isFolder) onOpenFolder(path);
                      else if (isCoin) onActivateCoin(path);
                      else if (isOblivion(path)) onActivateOblivion(path);
                      else onActivateFile(path);
                    }}
                  >
                    {menu.openLabel}
                  </button>
                  {menu.openToSide && (
                    <button
                      type="button"
                      className="ctx-menu-item"
                      onClick={() => {
                        setCtxMenu(null);
                        onOpenToSide(path);
                      }}
                    >
                      Open to side
                    </button>
                  )}
                </Fragment>,
              );
            }

            if (
              menu.newFile ||
              menu.newFolder ||
              menu.mintCoin ||
              menu.scanFolder ||
              menu.scanFile
            ) {
              groups.push(
                <Fragment key="create">
                  {menu.newFile && (
                    <button
                      type="button"
                      className="ctx-menu-item"
                      onClick={() => {
                        setCtxMenu(null);
                        onCreateStart("file", path);
                      }}
                    >
                      New File
                    </button>
                  )}
                  {menu.newFolder && (
                    <button
                      type="button"
                      className="ctx-menu-item"
                      onClick={() => {
                        setCtxMenu(null);
                        onCreateStart("folder", path);
                      }}
                    >
                      New Folder
                    </button>
                  )}
                  {menu.mintCoin && (
                    <button
                      type="button"
                      className="ctx-menu-item"
                      disabled={!coinsEnabled}
                      onClick={() => {
                        setCtxMenu(null);
                        onMintCoin();
                      }}
                    >
                      Mint New Coin
                    </button>
                  )}
                  {menu.scanFolder && (
                    <button
                      type="button"
                      className="ctx-menu-item"
                      onClick={() => {
                        setCtxMenu(null);
                        onScan("folder");
                      }}
                    >
                      Scan Folder
                    </button>
                  )}
                  {menu.scanFile && (
                    <button
                      type="button"
                      className="ctx-menu-item"
                      onClick={() => {
                        setCtxMenu(null);
                        onScan("file");
                      }}
                    >
                      Scan File
                    </button>
                  )}
                </Fragment>,
              );
            }

            if (menu.reify) {
              groups.push(
                <button
                  key="reify"
                  type="button"
                  className="ctx-menu-item"
                  onClick={() => {
                    setCtxMenu(null);
                    onReify({ kind: isFolder ? "folder" : "file", path });
                  }}
                >
                  Reify…
                </button>,
              );
            }

            if (menu.stepFolder) {
              groups.push(
                <button
                  key="step-folder"
                  type="button"
                  className="ctx-menu-item"
                  onClick={() => {
                    setCtxMenu(null);
                    onStepFolder(path);
                  }}
                >
                  {path === ROOT ? "Step Root" : "Step Folder"}
                </button>,
              );
            }

            const inScan = topLevelSelected().filter(
              (path) => isScan(path) && path !== SCAN,
            );
            const inOblivion = topLevelSelected().filter(
              (p) => isOblivion(p) && p !== OBLIVION,
            );
            if (inScan.length > 0 || inOblivion.length > 0) {
              groups.push(
                <Fragment key="move">
                  {inScan.length > 0 && (
                    <button
                      type="button"
                      className="ctx-menu-item"
                      onClick={() => {
                        setCtxMenu(null);
                        onMove(inScan, ROOT);
                      }}
                    >
                      Adopt into Root{inScan.length > 1 ? ` (${inScan.length})` : ""}
                    </button>
                  )}
                  {inOblivion.length > 0 && (
                    <button
                      type="button"
                      className="ctx-menu-item"
                      onClick={() => {
                        setCtxMenu(null);
                        onMove(inOblivion, ROOT);
                      }}
                    >
                      Restore{inOblivion.length > 1 ? ` (${inOblivion.length})` : ""}
                    </button>
                  )}
                </Fragment>,
              );
            }

            if (menu.rename) {
              groups.push(
                <button
                  key="rename"
                  type="button"
                  className="ctx-menu-item"
                  disabled={menu.renameDisabled}
                  onClick={() => requestRename(path)}
                >
                  Rename
                </button>,
              );
            }

            const canRevoke =
              filePaths.has(path) &&
              isOblivion(path) &&
              topLevelSelected().length === 1;
            if (canRevoke || menu.delete) {
              groups.push(
                <Fragment key="danger">
                  {canRevoke && (
                    <button
                      type="button"
                      className="ctx-menu-item danger"
                      onClick={() => {
                        setCtxMenu(null);
                        setRevokeMessage(null);
                        setRevokeError(null);
                        setConfirmRevoke({ path, name: systemPathDisplayName(path) });
                      }}
                    >
                      Request relay revocation…
                    </button>
                  )}
                  {menu.delete && (
                    <button
                      type="button"
                      className="ctx-menu-item danger"
                      onClick={() => requestDelete(topLevelSelected())}
                    >
                      Delete{selectedPaths.size > 1 ? ` (${selectedPaths.size})` : ""}
                    </button>
                  )}
                </Fragment>,
              );
            }

            return groups.map((group, index) => (
              <Fragment key={index}>
                {index > 0 && <div className="ctx-menu-separator" aria-hidden="true" />}
                {group}
              </Fragment>
            ));
          })()}
        </div>
      )}
      {confirmDelete && (
        <div
          className="confirm-overlay"
          onClick={() => {
            if (!deleteBusy) setConfirmDelete(null);
          }}
        >
          <div className="confirm-dialog" onClick={(e) => e.stopPropagation()}>
            <p className="confirm-message">
              {confirmDelete.paths.length > 1
                ? confirmDelete.isFolder
                  ? confirmDelete.childCount > 0
                    ? `Delete ${confirmDelete.paths.length} items (including ${confirmDelete.childCount} item${confirmDelete.childCount === 1 ? "" : "s"} inside selected folders)?`
                    : `Delete ${confirmDelete.paths.length} items?`
                  : `Delete ${confirmDelete.paths.length} items?`
                : confirmDelete.isFolder
                  ? confirmDelete.childCount > 0
                    ? `Delete folder "${confirmDelete.name}" and ${confirmDelete.childCount} item${confirmDelete.childCount === 1 ? "" : "s"} inside it?`
                    : `Delete empty folder "${confirmDelete.name}"?`
                  : `Delete "${confirmDelete.name}"?`} {deleteOutcomeMessage(confirmDelete.paths)}
            </p>
            {deleteRevocationTargets.length > 0 && (
              <label className="confirm-message">
                <input
                  type="checkbox"
                  checked={deleteWithRevocation}
                  disabled={deleteBusy}
                  onChange={(event) => setDeleteWithRevocation(event.target.checked)}
                />{" "}
                Also request relay revocation from configured write relays for{" "}
                {deleteRevocationTargets.length} trace
                {deleteRevocationTargets.length === 1 ? "" : "s"}. Relays and caches may
                retain copies.
              </label>
            )}
            {deleteError && <p className="create-error" role="alert">{deleteError}</p>}
            <div className="confirm-actions">
              <button
                type="button"
                className="confirm-cancel"
                disabled={deleteBusy}
                onClick={() => setConfirmDelete(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="confirm-delete"
                disabled={deleteBusy}
                onClick={() => void confirmPermanentDelete()}
              >
                {deleteBusy ? "Requesting…" : "Delete"}
              </button>
            </div>
          </div>
        </div>
      )}
      {confirmRevoke && (
        <div
          className="confirm-overlay"
          onClick={() => {
            if (!revokeBusy) setConfirmRevoke(null);
          }}
        >
          <div className="confirm-dialog" onClick={(e) => e.stopPropagation()}>
            <p className="confirm-message">
              Request relay revocation for “{confirmRevoke.name}”? This publishes a NIP-09
              deletion request for Steps signed by your current pen. It does not delete the
              local copy, cannot revoke other voices’ Steps, and relays or caches may retain data.
            </p>
            {revokeMessage && <p className="confirm-message" role="status">{revokeMessage}</p>}
            {revokeError && <p className="create-error" role="alert">{revokeError}</p>}
            <div className="confirm-actions">
              <button
                type="button"
                className="confirm-cancel"
                disabled={revokeBusy}
                onClick={() => setConfirmRevoke(null)}
              >
                {revokeMessage ? "Close" : "Cancel"}
              </button>
              {!revokeMessage && (
                <button
                  type="button"
                  className="confirm-delete"
                  disabled={revokeBusy}
                  onClick={() => {
                    setRevokeBusy(true);
                    setRevokeError(null);
                    void onRevoke(confirmRevoke.path)
                      .then((message) => setRevokeMessage(message))
                      .catch((error) =>
                        setRevokeError(error instanceof Error ? error.message : String(error)),
                      )
                      .finally(() => setRevokeBusy(false));
                  }}
                >
                  {revokeBusy ? "Requesting…" : "Request revocation"}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
      {samplerOpen && <SampleModal onClose={onToggleSampler}>{sampler}</SampleModal>}
      {tagBrowserOpen && (
        <SampleModal title="Browse a tag" onClose={onToggleTagBrowser}>
          {tagBrowser}
        </SampleModal>
      )}
    </nav>
  );
}

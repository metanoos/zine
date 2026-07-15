/**
 * The Traces view — a directory tree of every chain your voice authored on the
 * relay.
 *
 * Where the Press sidebar shows one mount's working tree for editing, this view
 * shows the *structure* of all your chains for browsing: which files and
 * subfolders each chain holds, so you can see what a trace contains before
 * reifying it into a new directory or mounting it.
 *
 * Model:
 *   - A **chain** is an append-only node history identified by its genesis id.
 *     Its structure (which files/folders it holds) comes from `fetchManifest`.
 *   - Subfolders are themselves separate chains — a `kind:"folder"` manifest
 *     member's `latestNodeId` is the subfolder's chain head. Expanding a folder
 *     fetches that subfolder-chain's manifest (lazy, cached).
 *   - The chain root is an abstract container of all the folder/file traces in
 *     its store. Its children are the chain's top-level manifest members.
 *
 * Loading is lazy and on-demand because `fetchManifest` fans out (4 relay
 * queries × read relays per level, uncached): the chain list loads on view
 * open (one `fetchFolderIndex` scan); each chain's first level loads on
 * expand; each subfolder loads on its expand. Fetched children are cached per
 * node id for the view's life, so expand-once = fetch-once.
 */

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  ChevronDown,
  ChevronRight,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  GitFork,
  Search,
  X,
} from "lucide-react";
import type { AttachedFolder } from "./workspace.js";
import {
  fetchFolderDisplayName,
  fetchFolderIndex,
  fetchManifest,
} from "./provenance.js";
import { authorVoice } from "./keys-store.js";

/** A node in the trace tree. Files are leaves; folders/chain-roots have
 *  lazily-fetched children. `nodeId` is the fetch key (a chain head or a
 *  folder member's `latestNodeId`); `chainId` is the owning genesis id (used
 *  for reify/unmount actions, stable across the tree). */
interface TraceNode {
  name: string;
  /** Stable unique key for React + collapsed-set membership. The display
   *  path under the chain root, joined with `/`. */
  path: string;
  type: "file" | "folder";
  /** The genesis id of the chain this node belongs to. Present on every node
   *  (propagated down from the chain root) so any row can offer reify/unmount. */
  chainId?: string;
  /** The fetch key for this node's children: a chain head for chain roots, or
   *  a folder member's `latestNodeId` for subfolders. Absent on files. */
  nodeId?: string;
  /** Level-0 abstract container — the chain itself. Renders with chain-id
   *  subtitle + reify/unmount/open actions. */
  isChainRoot?: boolean;
}

/** Build a one-level tree (files + folders) from a manifest's members. Members
 *  carry single-segment `relativePath`s, so no slash-splitting is needed at one
 *  level; the slash-joining into display paths happens via the `prefix`. */
function buildLevel(
  members: { relativePath: string; kind?: "file" | "folder"; latestNodeId: string }[],
  chainId: string,
  prefix: string,
): TraceNode[] {
  const out: TraceNode[] = members
    .filter((m) => m.relativePath)
    .map((m) => {
      const path = prefix ? `${prefix}/${m.relativePath}` : m.relativePath;
      const type = m.kind === "folder" ? "folder" : "file";
      return {
        name: m.relativePath,
        path,
        type,
        chainId,
        // Folders recurse via their own chain head; files have no children.
        nodeId: type === "folder" ? m.latestNodeId : undefined,
      };
    });
  out.sort((a, b) =>
    a.type !== b.type ? (a.type === "folder" ? -1 : 1) : a.name.localeCompare(b.name),
  );
  return out;
}

export function TracesView({
  mounts,
  activeMountId,
  onSwitchToMount,
  onUnmountMount,
  onMountNew,
  onReify,
}: {
  /** The (chain, directory) pairs currently mounted — used to mark which chain
   *  roots are mounted + offer Open/Unmount on those. */
  mounts: AttachedFolder[];
  /** The chain id open in the Press right now (active-row highlight). */
  activeMountId: string | null;
  /** Open a mounted chain in the Press. */
  onSwitchToMount: (mount: AttachedFolder) => void;
  /** Drop a mount from the registry (unmount). The chain is untouched. */
  onUnmountMount: (id: string) => void;
  /** Open the native folder picker and mount a new chain. */
  onMountNew: () => void;
  /** Reify an existing chain into a new directory. App owns the workspace
   *  attach; TracesView owns the picker UI producing the genesis id. */
  onReify: (genesisId: string) => void;
}) {
  // Level-0 chain roots. null while the relay scan hasn't run; [] once it has
  // (even if empty). Loaded once on view mount.
  const [chains, setChains] = useState<TraceNode[] | null>(null);
  // nodeId → children, cached for the view's life so expand-once = fetch-once.
  const [children, setChildren] = useState<Map<string, TraceNode[]>>(new Map());
  // Expanded rows carry their path in this set; absent = collapsed.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  // nodeIds with an in-flight manifest fetch (inline "loading…" placeholder).
  const [loading, setLoading] = useState<Set<string>>(new Set());
  const [chainError, setChainError] = useState<string | null>(null);

  // Reify picker modal state (the paste-an-id / power-user path). The tree is
  // the primary browse surface; the modal is reached from chain-root actions
  // and the toolbar's "Reify a chain" button.
  const [reifyOpen, setReifyOpen] = useState(false);
  const [reifyGenesisId, setReifyGenesisId] = useState("");
  const [reifyChains, setReifyChains] = useState<{ id: string; label: string }[] | null>(null);
  const [reifyLoading, setReifyLoading] = useState(false);
  const [reifyError, setReifyError] = useState<string | null>(null);

  /** Load the level-0 chain list: every chain the active voice authored on the
   *  relay. One `fetchFolderIndex` scan on view open. */
  async function loadChains() {
    setChainError(null);
    try {
      const me = authorVoice();
      const index = await fetchFolderIndex({ limit: 500 });
      const mine = [...index.values()].filter((e) => e.authorPubkeys.has(me));
      const labeled = await Promise.all(
        mine.map(async (e) => ({
          id: e.folderId,
          label: await fetchFolderDisplayName(e.folderId, e.folderId.slice(0, 8)),
        })),
      );
      setChains(
        labeled.map((c) => ({
          name: c.label,
          path: c.id, // chain roots are keyed by their genesis id
          type: "folder" as const,
          chainId: c.id,
          nodeId: c.id,
          isChainRoot: true,
        })),
      );
    } catch (e) {
      setChainError(e instanceof Error ? e.message : String(e));
      setChains([]);
    }
  }

  // Load the chain list once on view mount.
  useEffect(() => {
    void loadChains();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Fetch one node's children from its chain's manifest, cache them, and mark
   *  loading in flight. Idempotent: a cached nodeId is not re-fetched. */
  async function expandNode(node: TraceNode) {
    if (!node.nodeId) return;
    if (children.has(node.nodeId)) return; // cached
    setLoading((prev) => new Set(prev).add(node.nodeId!));
    try {
      const members = await fetchManifest(node.nodeId);
      const built = buildLevel(members, node.chainId!, node.isChainRoot ? "" : node.path);
      setChildren((prev) => new Map(prev).set(node.nodeId!, built));
    } catch {
      // A failed fetch leaves the row empty-but-marked-loaded so a retry needs
      // a collapse+re-expand; the inline error is the absence of children.
      setChildren((prev) => new Map(prev).set(node.nodeId!, []));
    } finally {
      setLoading((prev) => {
        const next = new Set(prev);
        next.delete(node.nodeId!);
        return next;
      });
    }
  }

  /** Toggle a folder/chain row open-closed, fetching on first open. */
  function toggle(node: TraceNode) {
    const isOpen = !collapsed.has(node.path);
    if (isOpen) {
      setCollapsed((prev) => new Set(prev).add(node.path));
    } else {
      setCollapsed((prev) => {
        const next = new Set(prev);
        next.delete(node.path);
        return next;
      });
      if (!children.has(node.nodeId!) && !loading.has(node.nodeId!)) {
        void expandNode(node);
      }
    }
  }

  function openReifyFor(genesisId: string) {
    setReifyGenesisId(genesisId);
    setReifyChains(null);
    setReifyError(null);
    setReifyOpen(true);
  }
  function openReifyBlank() {
    setReifyGenesisId("");
    setReifyChains(null);
    setReifyError(null);
    setReifyOpen(true);
  }

  /** Reify picker's "List my chains" — same scan as loadChains, feeds the
   *  picker's flat list (kept for the paste-id power-user path). */
  async function loadMyChains() {
    setReifyLoading(true);
    setReifyError(null);
    try {
      const me = authorVoice();
      const index = await fetchFolderIndex({ limit: 500 });
      const mine = [...index.values()].filter((e) => e.authorPubkeys.has(me));
      setReifyChains(
        await Promise.all(
          mine.map(async (e) => ({
            id: e.folderId,
            label: await fetchFolderDisplayName(e.folderId, e.folderId.slice(0, 8)),
          })),
        ),
      );
    } catch (e) {
      setReifyError(e instanceof Error ? e.message : String(e));
    } finally {
      setReifyLoading(false);
    }
  }

  function confirmReify() {
    const id = reifyGenesisId.trim();
    if (!id) return;
    setReifyOpen(false);
    setReifyGenesisId("");
    setReifyChains(null);
    onReify(id);
  }

  return (
    <section className="view-placeholder traces-view">
      <p className="view-placeholder-blurb">
        Chains are append-only histories on the relay. Each is an abstract container of the
        folder/file traces in its store — expand one to browse its structure, then reify it into a
        new directory or mount it.
      </p>

      <div className="trace-toolbar">
        <button type="button" className="trace-btn primary" onClick={onMountNew}>
          <FolderPlus size={14} strokeWidth={1.75} aria-hidden="true" />
          Mount new folder
        </button>
        <button type="button" className="trace-btn" onClick={openReifyBlank}>
          <GitFork size={14} strokeWidth={1.75} aria-hidden="true" />
          Reify a chain
        </button>
        <button
          type="button"
          className="trace-btn"
          onClick={() => void loadChains()}
          disabled={chains === null}
        >
          <Search size={14} strokeWidth={1.75} aria-hidden="true" />
          Refresh
        </button>
      </div>

      <div className="trace-tree">
        {chains === null ? (
          <div className="trace-loading">Scanning relay for your chains…</div>
        ) : chainError ? (
          <div className="trace-error">{chainError}</div>
        ) : chains.length === 0 ? (
          <div className="trace-empty">
            No chains found for your voice. Mount a folder to start one.
          </div>
        ) : (
          chains.map((node) => (
            <TraceTreeItem
              key={node.path}
              node={node}
              depth={0}
              collapsed={collapsed}
              loading={loading}
              children={children}
              mounts={mounts}
              activeMountId={activeMountId}
              onToggle={toggle}
              onSwitchToMount={onSwitchToMount}
              onUnmountMount={onUnmountMount}
              onReify={openReifyFor}
            />
          ))
        )}
      </div>

      {reifyOpen &&
        createPortal(
          <div className="confirm-overlay" onClick={() => setReifyOpen(false)}>
            <div
              className="confirm-dialog reify-dialog"
              onClick={(e) => e.stopPropagation()}
              role="dialog"
              aria-modal="true"
              aria-label="Reify a chain into a new directory"
            >
              <p className="confirm-message">
                Mount an existing chain into a new directory. The chain stays on the relay —
                only a new working tree is created.
              </p>
              <input
                className="reify-input"
                type="text"
                placeholder="Paste a chain (genesis) id…"
                value={reifyGenesisId}
                onChange={(e) => setReifyGenesisId(e.target.value)}
                autoFocus
              />
              <div className="reify-chains">
                <button
                  type="button"
                  className="reify-list-btn"
                  disabled={reifyLoading}
                  onClick={() => void loadMyChains()}
                >
                  <Search size={12} strokeWidth={1.75} aria-hidden="true" />
                  {reifyLoading ? "Listing…" : "List my chains"}
                </button>
                {reifyError && <span className="reify-error">{reifyError}</span>}
                {reifyChains && (
                  <div className="reify-chain-list">
                    {reifyChains.length === 0 ? (
                      <span className="reify-chain-empty">No chains found for your voice.</span>
                    ) : (
                      reifyChains.map((c) => (
                        <button
                          key={c.id}
                          type="button"
                          className={
                            "reify-chain-row" +
                            (c.id === reifyGenesisId.trim() ? " selected" : "")
                          }
                          onClick={() => setReifyGenesisId(c.id)}
                        >
                          <span className="reify-chain-label">{c.label}</span>
                          <span className="reify-chain-id">{c.id.slice(0, 12)}</span>
                        </button>
                      ))
                    )}
                  </div>
                )}
              </div>
              <div className="confirm-actions">
                <button type="button" className="confirm-cancel" onClick={() => setReifyOpen(false)}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="confirm-delete"
                  disabled={!reifyGenesisId.trim()}
                  onClick={confirmReify}
                >
                  Pick directory…
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </section>
  );
}

/** A read-only recursive tree row. Folders toggle open/closed (fetching their
 *  manifest on first open); chain roots carry mount/reify/unmount actions;
 *  files are static leaves. */
function TraceTreeItem({
  node,
  depth,
  collapsed,
  loading,
  children,
  mounts,
  activeMountId,
  onToggle,
  onSwitchToMount,
  onUnmountMount,
  onReify,
}: {
  node: TraceNode;
  depth: number;
  collapsed: Set<string>;
  loading: Set<string>;
  children: Map<string, TraceNode[]>;
  mounts: AttachedFolder[];
  activeMountId: string | null;
  onToggle: (node: TraceNode) => void;
  onSwitchToMount: (mount: AttachedFolder) => void;
  onUnmountMount: (id: string) => void;
  onReify: (genesisId: string) => void;
}) {
  const isFolder = node.type === "folder";
  const isOpen = isFolder && !collapsed.has(node.path);
  const isLoading = node.nodeId ? loading.has(node.nodeId) : false;
  const nodeChildren = node.nodeId ? children.get(node.nodeId) : undefined;
  const mounted = node.isChainRoot ? mounts.find((m) => m.id === node.chainId) : undefined;
  const isActive = node.isChainRoot && node.chainId === activeMountId;

  const indent = { paddingLeft: `${depth * 14 + 10}px` };

  return (
    <div className="trace-tree-branch">
      <div
        className={
          "trace-tree-row" +
          (node.isChainRoot ? " chain-root" : "") +
          (isActive ? " active" : "")
        }
        style={indent}
      >
        {isFolder ? (
          <button
            type="button"
            className="trace-tree-toggle"
            onClick={() => onToggle(node)}
            aria-label={isOpen ? "Collapse" : "Expand"}
          >
            {isOpen ? (
              <ChevronDown size={13} strokeWidth={1.75} aria-hidden="true" />
            ) : (
              <ChevronRight size={13} strokeWidth={1.75} aria-hidden="true" />
            )}
          </button>
        ) : (
          <span className="trace-tree-toggle placeholder" aria-hidden="true" />
        )}
        <span className="trace-tree-icon" aria-hidden="true">
          {isFolder ? (
            isOpen ? (
              <FolderOpen size={13} strokeWidth={1.75} />
            ) : (
              <Folder size={13} strokeWidth={1.75} />
            )
          ) : (
            <FileText size={13} strokeWidth={1.75} />
          )}
        </span>
        <span className="trace-tree-name" title={node.name}>
          {node.name}
        </span>
        {node.isChainRoot && (
          <>
            <span className="trace-tree-id" title={node.chainId}>
              {node.chainId!.slice(0, 12)}…
            </span>
            <span className="trace-tree-actions">
              {mounted && (
                <>
                  {isActive ? (
                    <span className="trace-tree-tag">open in Press</span>
                  ) : (
                    <button
                      type="button"
                      className="trace-btn sm"
                      onClick={() => onSwitchToMount(mounted)}
                    >
                      Open
                    </button>
                  )}
                  <button
                    type="button"
                    className="trace-btn sm danger"
                    title="Unmount (chain stays on relay)"
                    onClick={() => onUnmountMount(mounted.id)}
                  >
                    <X size={11} strokeWidth={2} aria-hidden="true" />
                  </button>
                </>
              )}
              <button
                type="button"
                className="trace-btn sm"
                title="Reify this chain into a new directory"
                onClick={() => onReify(node.chainId!)}
              >
                <GitFork size={11} strokeWidth={1.75} aria-hidden="true" />
              </button>
            </span>
          </>
        )}
      </div>
      {isOpen && (
        <div className="trace-tree-children">
          {isLoading ? (
            <div className="trace-loading" style={indent}>
              Loading…
            </div>
          ) : nodeChildren && nodeChildren.length > 0 ? (
            nodeChildren.map((c) => (
              <TraceTreeItem
                key={c.path}
                node={c}
                depth={depth + 1}
                collapsed={collapsed}
                loading={loading}
                children={children}
                mounts={mounts}
                activeMountId={activeMountId}
                onToggle={onToggle}
                onSwitchToMount={onSwitchToMount}
                onUnmountMount={onUnmountMount}
                onReify={onReify}
              />
            ))
          ) : (
            <div className="trace-loading empty" style={indent}>
              empty
            </div>
          )}
        </div>
      )}
    </div>
  );
}

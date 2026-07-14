/**
 * Local-primary workspace backend (webapp).
 *
 * localStorage is the source of truth on the webapp: every read is
 * synchronous (instant boot, works offline), every write lands locally first.
 * The relay is a *background sync target* — pulls merge in newer remote
 * content, pushes propagate local edits out for cross-device sync. Neither
 * direction blocks the editor.
 *
 * Why not relay-primary (the old workspace-relay.ts)? A relay round-trip on
 * every boot means the editor can't render until the network resolves —
 * "Connecting…" forever if the relay is slow or unreachable (e.g. the :1420
 * dev server, which has no relay endpoint). Local-primary makes the webapp
 * feel like a native app: open → editor, immediately.
 *
 * Reconciliation: per-file last-writer-wins by timestamp.
 *   - local `updatedAt` (ms) vs relay `created_at` (sec, ×1000).
 *   - On pull: relay wins iff it's strictly newer → overwrite local + editor.
 *   - On push: local always pushes (the relay accepts later created_at).
 * Character-level merge is out of scope; the chain history preserves both.
 */

import {
  diffToDeltas,
  fetchChain,
  fetchManifest,
  fetchNodeOwner,
  eventMeta,
  forkFile,
  headUserTags,
  headTaggedTraces,
  publishEdit,
  reconstructFromChain,
  reconstructRunsFromChain,
  removeManifestEntry,
  renameManifestEntry,
  upsertManifestEntry,
  createEmptyFolder,
  type ManifestFileEntry,
} from "./provenance.js";
import { findResolvedBrackets } from "./brackets.js";
import { manualVoice, secretKeyForVoice } from "./keys-store.js";
import { getPublicKey } from "nostr-tools/pure";
import type {
  AttachResult,
  FileState,
  FolderRef,
  Run,
  Workspace,
} from "./workspace-core.js";
import { flattenRuns } from "./workspace-core.js";
import {
  deleteLocalFile,
  forgetLocalFolder,
  loadLocalFolder,
  loadLocalFolderTags,
  moveLocalFile,
  rememberLocalFolder,
  saveLocalFile,
  saveLocalFolderTags,
} from "./local-store.js";

function runsFromText(text: string): FileState["runs"] {
  // Resolves to the manual (pen) key's pubkey (not the old "alice" label) so
  // the run renders under that key's identity.
  return text.length === 0 ? [] : [{ voice: manualVoice(), text }];
}

function basename(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
}

async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Build FileState (what the editor consumes) from a local folder record.
 * Synchronous — no relay calls. When a file carries persisted `runs` that
 * still match its content, those runs survive (per-voice attribution persists
 * across reload); otherwise it collapses to a single run under the active
 * voice (legacy records, relay-pulled content, or stale attribution from an
 * external edit).
 */
function localToFiles(
  local: {
    files: Record<string, {
      kind?: "file" | "folder";
      content: string;
      tags: string[];
      nodeId: string;
      runs?: Run[];
      taggedTraces?: string[];
    }>;
  },
): Record<string, FileState> {
  const out: Record<string, FileState> = {};
  for (const [path, f] of Object.entries(local.files)) {
    if (f.kind === "folder") {
      // Folder-member placeholder: no body to reconstruct. Carry kind + nodeId.
      out[path] = { kind: "folder", runs: [], nodeId: f.nodeId, tags: [] };
      continue;
    }
    const runs = f.runs && flattenRuns(f.runs) === f.content ? f.runs : runsFromText(f.content);
    out[path] = {
      runs,
      nodeId: f.nodeId,
      tags: f.tags,
      ...(f.taggedTraces && f.taggedTraces.length > 0 ? { taggedTraces: f.taggedTraces } : {}),
    };
  }
  return out;
}

export function createLocalWorkspace(): Workspace {
  let ref: FolderRef | null = null;

  function requireId(): string {
    if (!ref) throw new Error("workspace not attached — call attach() first");
    return ref.id;
  }

  // Per-file debounce timers for relay pushes. Local writes are instant; the
  // relay push is coalesced so a burst of typing produces one seal, not N.
  const pushTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const PUSH_DEBOUNCE_MS = 1200;

  /** Schedule a background relay push for a file (debounced). Never throws —
   *  relay failures are non-fatal; the local write already succeeded. */
  function schedulePush(relativePath: string): void {
    const id = requireId();
    const existing = pushTimers.get(relativePath);
    if (existing) clearTimeout(existing);
    pushTimers.set(
      relativePath,
      setTimeout(() => {
        pushTimers.delete(relativePath);
        void pushToRelay(id, relativePath).catch((e) =>
          console.warn(`[local] relay push failed for ${relativePath}:`, e),
        );
      }, PUSH_DEBOUNCE_MS),
    );
  }

  async function pushToRelay(folderId: string, relativePath: string): Promise<void> {
    const local = loadLocalFolder(folderId);
    if (!local) return;
    const file = local.files[relativePath];
    if (!file) return; // was deleted locally — deletePath handles its own push
    const content = file.content;
    const contentHash = await sha256Hex(content);

    // prevEventId from the last sealed node (relay chain head). Reading the
    // relay here keeps the chain linear across authors/devices.
    const manifest = await fetchManifest(folderId);
    let entry = manifest.find((m) => m.relativePath === relativePath);

    // Fork-on-write (spec §Forking): if this folder is a fork and the member
    // being edited is still a citation to a foreign-owned node, seed the user's
    // own copy first. The edit then chains off the fork's genesis instead of
    // the foreign node. Untouched members stay cited to the source owner until
    // the user edits them — the shallow-fork property.
    let prevId: string | null = entry?.latestNodeId ?? (file.nodeId || null);
    if (entry && ref?.forkedFrom && prevId) {
      const owner = await fetchNodeOwner(prevId);
      const mine = owner === manualVoice();
      if (!mine) {
        const forkEvent = await forkFile(ref.forkedFrom, relativePath, folderId);
        // The fork's genesis is now this file's head under the user's key.
        // Repoint the folder membership at it, then chain the edit off it.
        await upsertManifestEntry(folderId, {
          relativePath,
          latestNodeId: forkEvent.id,
          contentHash,
        });
        prevId = forkEvent.id;
        // Re-read entry so the diff/action below sees the forked head.
        const refreshed = await fetchManifest(folderId);
        entry = refreshed.find((m) => m.relativePath === relativePath);
      }
    }

    // Diff against relay's last-known content so the node carries a real delta.
    const chain = entry ? await fetchChain(folderId, relativePath) : [];
    const prevContent = entry ? reconstructFromChain(chain) : "";

    // Skip if nothing changed since the last push. The no-op test covers
    // content hash, topical tags, AND the citation set (body brackets + reply
    // source + tagged traces) — otherwise a pure tag-add on an unchanged doc
    // would be swallowed and never reach the relay.
    const prevTags = headUserTags(chain);
    const tagsUnchanged =
      prevTags.length === file.tags.length && prevTags.every((t, i) => t === file.tags[i]);
    const prevCitations = entry ? eventMeta(chain[chain.length - 1]).citationTargets : [];
    const taggedTraces = file.taggedTraces ?? [];
    const nextCitations = [
      ...findResolvedBrackets(content).map((b) => b.nodeId),
      ...(file.pendingReplyingTo ? [file.pendingReplyingTo] : []),
      ...taggedTraces,
    ];
    const citationsUnchanged =
      prevCitations.length === nextCitations.length &&
      prevCitations.every((c, i) => c === nextCitations[i]);
    if (entry && entry.contentHash === contentHash && tagsUnchanged && citationsUnchanged) return;

    const deltas = diffToDeltas(prevContent, content);
    // Resolve the voice that authored this edit to its secret key, so the push
    // signs as that voice — not just the manual default. Falls back to the
    // manual (pen) key if the stored voice isn't in the keychain (defensive: a
    // voice deleted after the edit was authored).
    const signer = file.voicePubkey ? secretKeyForVoice(file.voicePubkey) ?? undefined : undefined;
    const event = await publishEdit({
      prevEventId: prevId,
      relativePath,
      folderId,
      deltas: deltas.length > 0
        ? deltas
        : [{ type: "insert", positionStart: 0, positionEnd: 0, newValue: content, timestamp: Date.now() }],
      snapshot: content,
      contentHash,
      action: entry ? "edit" : "import",
      tags: file.tags,
      // Per-character attribution: carry the live run list into the node's
      // `authors` field so it survives reload from the chain (the durable,
      // cross-device carrier) instead of collapsing to the signer on attach.
      // publishEdit validates the map against `snapshot` and drops it if stale.
      ...(file.runs && file.runs.length > 0 ? { authors: file.runs } : {}),
      // Cite every minted span this doc contains (spec:189). `content` is the
      // localStorage string; resolved `[[ phrase | nodeId ]]` live in it.
      citations: findResolvedBrackets(content).map((b) => b.nodeId),
      ...(file.pendingReplyingTo ? { replyingTo: file.pendingReplyingTo } : {}),
      ...(taggedTraces.length > 0 ? { taggedTraces } : {}),
      ...(file.pendingLocalOnly ? { localOnly: true } : {}),
      signer,
    });
    await upsertManifestEntry(folderId, {
      relativePath,
      latestNodeId: event.id,
      isDeleted: false,
      contentHash,
    }, signer);
    // Reflect the sealed node id back into local state so the next push's
    // prevId is correct. Preserve voicePubkey so re-pushes stay correctly signed,
    // and runs so the local record keeps the per-char attribution it just sealed
    // (avoids a needless reload-from-chain on next open). `pendingReplyingTo`
    // is deliberately NOT carried: it's one-shot (genesis-only), consumed by
    // this push. `taggedTraces` IS carried — tags are persistent across seals.
    saveLocalFile(folderId, relativePath, {
      content,
      tags: file.tags,
      nodeId: event.id,
      voicePubkey: file.voicePubkey,
      taggedTraces: file.taggedTraces,
      ...(file.runs && file.runs.length > 0 ? { runs: file.runs } : {}),
    });
  }

  return {
    get ref(): FolderRef | null {
      return ref ? { ...ref } : null;
    },

    /**
     * Instant boot from localStorage, then background relay pull.
     *
     * Returns the local file set synchronously-derived (step 1) so the editor
     * renders immediately. The relay pull (step 2) runs in the background and
     * calls `onRemoteUpdate` for any file the relay has newer than local —
     * the caller merges those into editor state without blocking.
     */
    async attach(folderRef: FolderRef): Promise<AttachResult> {
      ref = { ...folderRef };
      rememberLocalFolder(ref);
      const local = loadLocalFolder(ref.id);
      const files = local ? localToFiles(local) : {};
      // Kick off the background sync — don't await. The editor is already
      // usable from `files`.
      void pullFromRelay(ref.id);
      return { files };
    },

    async readFile(relativePath: string): Promise<string> {
      const id = requireId();
      const local = loadLocalFolder(id);
      return local?.files[relativePath]?.content ?? "";
    },

    async writeFile(
      relativePath,
      content,
      tags = [],
      signer?: Uint8Array,
      runs?: Run[],
      replyingTo?: string,
      taggedTraces?: string[],
      localOnly?: boolean,
    ): Promise<string> {
      // Capture the voice (by pubkey) that authored this edit, so the debounced
      // relay push signs with the correct key — not just the manual default.
      // This closes the per-voice signer gap that previously affected Send/zine
      // and that fork-on-write needs. The pubkey is persisted (never the
      // secret); pushToRelay resolves it to bytes via keys-store at push time.
      // A missing signer (the legacy/defensive path) falls back to the manual
      // (pen) voice; primary seal paths now always thread an explicit signer.
      const voicePubkey = signer ? getPublicKey(signer) : manualVoice();
      const id = requireId();
      // 1. Local write — synchronous, instant, survives reload/offline.
      const local = loadLocalFolder(id);
      const prevNodeId = local?.files[relativePath]?.nodeId ?? "";
      saveLocalFile(id, relativePath, {
        content,
        tags,
        nodeId: prevNodeId,
        runs,
        voicePubkey,
        pendingReplyingTo: replyingTo,
        taggedTraces: taggedTraces,
        pendingLocalOnly: localOnly || undefined,
      });
      // 2. Background relay push (debounced).
      schedulePush(relativePath);
      return prevNodeId;
    },

    async createFile(relativePath: string): Promise<string> {
      const id = requireId();
      const local = loadLocalFolder(id);
      if (local?.files[relativePath]) return local.files[relativePath].nodeId;
      saveLocalFile(id, relativePath, { content: "", tags: [], nodeId: "" });
      schedulePush(relativePath);
      return "";
    },

    async createFolder(_relativePath: string): Promise<void> {
      // Folders are implicit in file paths. Nothing to do until a file lands.
    },

    async deletePath(relativePath: string, isFolder: boolean): Promise<void> {
      const id = requireId();
      const local = loadLocalFolder(id);
      if (!local) return;
      const affected = isFolder
        ? Object.keys(local.files).filter(
            (p) => p === relativePath || p.startsWith(relativePath + "/"),
          )
        : [relativePath];
      for (const p of affected) {
        deleteLocalFile(id, p);
        // Relay-side tombstone (best effort).
        void tombstoneOnRelay(id, p).catch(() => {});
      }
    },

    async movePath(src, destFolder, _isFolder, _tagsByPath = {}): Promise<void> {
      const id = requireId();
      const local = loadLocalFolder(id);
      if (!local) return;
      const name = basename(src);
      const destPath = destFolder === "" ? name : `${destFolder}/${name}`;
      // Move every descendant too.
      const moves: { oldRel: string; newRel: string }[] = [];
      for (const p of Object.keys(local.files)) {
        if (p === src) moves.push({ oldRel: p, newRel: destPath });
        else if (p.startsWith(src + "/")) moves.push({ oldRel: p, newRel: destPath + p.slice(src.length) });
      }
      for (const { oldRel, newRel } of moves) {
        moveLocalFile(id, oldRel, newRel);
        schedulePush(newRel);
        void tombstoneOnRelay(id, oldRel).catch(() => {});
      }
    },

    async renamePath(src, newName, _isFolder): Promise<void> {
      const id = requireId();
      const local = loadLocalFolder(id);
      if (!local) return;
      const slash = src.lastIndexOf("/");
      const destPath = slash === -1 ? newName : src.slice(0, slash + 1) + newName;
      // Rename every descendant too.
      const moves: { oldRel: string; newRel: string }[] = [];
      for (const p of Object.keys(local.files)) {
        if (p === src) moves.push({ oldRel: p, newRel: destPath });
        else if (p.startsWith(src + "/")) moves.push({ oldRel: p, newRel: destPath + p.slice(src.length) });
      }
      for (const { oldRel, newRel } of moves) {
        moveLocalFile(id, oldRel, newRel);
        schedulePush(newRel);
        // Emit a `rename` folder delta (fromPath → toPath) instead of tombstoning
        // the old path — one replayable event per member, history preserved.
        void renameOnRelay(id, oldRel, newRel).catch(() => {});
      }
    },

    async readFolderTags(): Promise<Record<string, string[]>> {
      return loadLocalFolderTags(requireId());
    },

    async writeFolderTags(tags: Record<string, string[]>): Promise<void> {
      saveLocalFolderTags(requireId(), tags);
    },
  };
}

// --- background relay pull ------------------------------------------------

/**
 * Fetch the relay manifest + chains for the attached folder and merge any
 * files that are newer remotely than locally. Called on attach (non-blocking)
 * and could be called on focus/interval by the caller. Mutates localStorage
 * directly; the caller is responsible for refreshing editor state if needed.
 *
 * Reconciliation: relay file wins iff its created_at (sec × 1000) is strictly
 * greater than the local file's updatedAt (ms). Otherwise local (possibly an
 * unsaved draft) wins and will push on its next seal.
 */
export async function pullFromRelay(folderId: string): Promise<Set<string>> {
  const updatedPaths = new Set<string>();
  let manifest: ManifestFileEntry[];
  try {
    manifest = await fetchManifest(folderId);
  } catch {
    return updatedPaths; // relay unreachable — fine, local is primary
  }
  const local = loadLocalFolder(folderId);
  for (const entry of manifest) {
    if (entry.isDeleted) {
      // Remote deleted it — reflect locally if we don't have a newer draft.
      if (local?.files[entry.relativePath] && !isLocalNewer(local, entry)) {
        deleteLocalFile(folderId, entry.relativePath);
        updatedPaths.add(entry.relativePath);
      }
      continue;
    }
    if (!isLocalNewer(local, entry)) {
      if (entry.kind === "folder") {
        // Folder-member placeholder (spec §3.2 nesting): store it locally so
        // the tree renders the folder across reloads. No file chain to fetch.
        saveLocalFile(folderId, entry.relativePath, {
          kind: "folder",
          content: "",
          tags: [],
          nodeId: entry.latestNodeId,
        });
        updatedPaths.add(entry.relativePath);
        continue;
      }
      // Remote is newer (or local doesn't have it) → pull content.
      try {
        const chain = await fetchChain(folderId, entry.relativePath);
        const content = chain.length > 0 ? reconstructFromChain(chain) : "";
        const tags = headUserTags(chain);
        const head = chain.length > 0 ? chain[chain.length - 1] : null;
        // Recover tagged-but-not-quoted traces from the head, same as attach.
        const taggedTraces = headTaggedTraces(
          chain,
          findResolvedBrackets(content).map((b) => b.nodeId),
        );
        // Reconstruct per-char attribution from the chain (author-aware: adopts
        // an `authors` map when present, falls back to per-node-signer). Persist
        // it locally so the next open keeps the attribution without re-fetching.
        const runs = chain.length > 0 ? reconstructRunsFromChain(chain) : [];
        saveLocalFile(folderId, entry.relativePath, {
          content,
          tags,
          nodeId: head?.id ?? entry.latestNodeId,
          ...(runs.length > 0 ? { runs } : {}),
          ...(taggedTraces.length > 0 ? { taggedTraces } : {}),
        });
        updatedPaths.add(entry.relativePath);
      } catch {
        // per-file fetch failure — skip, keep local
      }
    }
  }
  return updatedPaths;
}

/** True if the local copy is newer than (or equal to) the relay entry. */
function isLocalNewer(local: { files: Record<string, { nodeId: string; updatedAt: number }> } | null, entry: ManifestFileEntry): boolean {
  if (!local) return false;
  const lf = local.files[entry.relativePath];
  if (!lf) return false;
  const sameHead = lf.nodeId !== "" && lf.nodeId === entry.latestNodeId;
  const recentLocal = Date.now() - lf.updatedAt < 5000;
  return sameHead || recentLocal;
}

/** Best-effort relay tombstone for a deleted file. */
async function tombstoneOnRelay(folderId: string, relativePath: string): Promise<void> {
  const manifest = await fetchManifest(folderId);
  const entry = manifest.find((m) => m.relativePath === relativePath);
  if (!entry) return; // already absent from the snapshot — nothing to tombstone
  await publishEdit({
    prevEventId: entry.latestNodeId,
    relativePath,
    folderId,
    deltas: [],
    snapshot: "",
    contentHash: entry.contentHash,
    action: "delete",
  });
  // Spec-clean tombstone: drop the member from the folder snapshot (remove
  // delta), not an isDeleted entry. The file's 4290 chain retains history.
  await removeManifestEntry(folderId, relativePath);
}

/** Relay-side companion to a local rename: seal the file node at its new path
 *  (the file's 4290 chain lives under its `F` tag, so a rename needs a fresh
 *  node at the new path), then emit one `rename` folder delta (fromPath →
 *  toPath) pointing at it. Mirrors tombstoneOnRelay's "do the relay half of a
 *  local mutation" posture — the local file move already happened in memory. */
async function renameOnRelay(folderId: string, oldRel: string, newRel: string): Promise<void> {
  const manifest = await fetchManifest(folderId);
  const entry = manifest.find((m) => m.relativePath === oldRel);
  if (!entry) return; // already absent — nothing to rename on the relay
  const chain = await fetchChain(folderId, oldRel);
  const content = chain.length > 0 ? reconstructFromChain(chain) : "";
  const event = await publishEdit({
    prevEventId: null,
    relativePath: newRel,
    folderId,
    deltas: content.length > 0
      ? [{ type: "insert", positionStart: 0, positionEnd: 0, newValue: content, timestamp: Date.now() }]
      : [],
    snapshot: content,
    contentHash: entry.contentHash,
    action: "import",
  });
  await renameManifestEntry(folderId, oldRel, newRel, event.id);
}

// Re-export for App.tsx's create-folder path.
export { createEmptyFolder, forgetLocalFolder };

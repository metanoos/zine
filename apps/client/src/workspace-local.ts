/**
 * Local-primary workspace backend (webapp).
 *
 * localStorage is the source of truth on the webapp: every read is
 * synchronous (instant boot, works offline), every write lands locally first.
 * The relay is a *background sync target* — pulls merge in newer remote
 * content, pushes propagate local edits out for cross-device sync. Neither
 * direction blocks the editor.
 *
 * A relay-primary backend would require a round-trip on
 * every boot means the editor can't render until the network resolves —
 * "Connecting…" forever if the relay is slow or unreachable (e.g. the :1420
 * dev server, which has no relay endpoint). Local-primary makes the webapp
 * feel like a native app: open → editor, immediately.
 *
 * Reconciliation (background pull): a 3-way merge keyed on the chain's common
 * ancestor, not last-write-wins.
 *   - noop       — ours and theirs identical (or remote didn't move off base).
 *   - fastforward— local still at the ancestor; theirs overwrites silently.
 *   - clean      — both sides changed, diff3 resolves; STAGED for review (not
 *                  stepped automatically): the caller surfaces a badge, the user accepts.
 *   - conflict   — overlapping edits; local untouched, surfaced in the banner.
 * Local stays primary on every path that isn't a clean fast-forward, so an
 * unsaved draft is never clobbered by remote activity.
 */

import {
  diffToDeltas,
  fetchChain,
  fetchEventById,
  fetchManifest,
  fetchNodeOwner,
  eventMeta,
  headUserTags,
  headTaggedTraces,
  publishEdit,
  resolveTraceChain,
  resolveTraceIdentity,
  reconstructFromChain,
  reconstructRunsFromChain,
  removeManifestEntry,
  renameManifestEntry,
  upsertManifestEntry,
  type KEdit,
  type ManifestFileEntry,
} from "./provenance.js";
import { findAddedInlineCitations, findResolvedBrackets } from "./brackets.js";
import { decidePullMerge } from "./three-way-merge.js";
import { authorVoice, secretKeyForVoice } from "./keys-store.js";
import { getPublicKey } from "nostr-tools/pure";
import type {
  AttachResult,
  FileState,
  FolderRef,
  Run,
  Workspace,
} from "./workspace-core.js";
import { ensureMdExt, flattenRuns } from "./workspace-core.js";
import {
  deleteLocalFile,
  loadLocalFolder,
  loadLocalFolderTags,
  moveLocalFile,
  rememberLocalFolder,
  saveLocalFile,
  saveLocalFolderTags,
  type LocalFile,
} from "./local-store.js";
import { isOblivionPath } from "./generated-paths.js";

function runsFromText(text: string): FileState["runs"] {
  // Resolves to the AUTHOR key's pubkey (not the old "author-1" label) so the
  // run renders under that key's identity.
  return text.length === 0 ? [] : [{ voice: authorVoice(), text }];
}

function basename(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
}

/** Classify a local path move while retaining the original relay coordinate
 * across rapid/multi-hop gestures. Pure so Oblivion/restore interruption cases
 * are regression-testable without a relay. */
export function pendingMoveForPath(
  oldPath: string,
  newPath: string,
  current?: LocalFile["pendingMove"],
): NonNullable<LocalFile["pendingMove"]> {
  const inheritedFrom = current?.fromPath ?? oldPath;
  if (isOblivionPath(newPath)) return { kind: "to-oblivion", fromPath: inheritedFrom };
  if (isOblivionPath(oldPath)) {
    return current?.kind === "to-oblivion"
      ? { kind: "move", fromPath: current.fromPath }
      : { kind: "restore", fromPath: oldPath };
  }
  return { kind: "move", fromPath: inheritedFrom };
}

/** Finish one explicit Step after its local state has been staged. Relay
 * failures remain retryable, but never masquerade as a completed checkpoint. */
export async function completeStagedWrite(
  publish: () => Promise<string>,
  scheduleRetry: () => void,
): Promise<string> {
  try {
    return await publish();
  } catch (error) {
    scheduleRetry();
    throw error;
  }
}

/** Complete provenance removals before deleting the retryable local copies. */
export async function completeDeletion(
  paths: readonly string[],
  tombstone: (path: string) => Promise<void>,
  deleteLocal: (path: string) => void,
): Promise<void> {
  await Promise.all(paths.map((path) => tombstone(path)));
  for (const path of paths) deleteLocal(path);
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
      traceId?: string;
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
      ...(f.traceId ? { traceId: f.traceId } : {}),
      tags: f.tags,
      ...(f.taggedTraces && f.taggedTraces.length > 0 ? { taggedTraces: f.taggedTraces } : {}),
    };
  }
  return out;
}

export interface LocalWorkspaceOptions {
  /** Require an exact folder-genesis fetch during attach. Headless presses use
   *  this to fail at startup instead of reporting a local cache as connected. */
  requireRelayOnAttach?: boolean;
}

export function createLocalWorkspace(options: LocalWorkspaceOptions = {}): Workspace {
  let ref: FolderRef | null = null;

  function requireId(): string {
    if (!ref) throw new Error("workspace not attached — call attach() first");
    return ref.id;
  }

  // Per-file debounce timers for relay pushes. Local writes are instant; the
  // relay push is coalesced so a burst of typing produces one step, not N.
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
        void pushToRelay(id, relativePath).catch((e) => {
          console.warn(`[local] relay push failed for ${relativePath}:`, e);
          // Movement has a durable journal and must converge without requiring
          // another edit or app restart. Retry while this folder remains
          // attached; switching away leaves attach() to resume the journal.
          const pendingMove = loadLocalFolder(id)?.files[relativePath]?.pendingMove;
          if (pendingMove && ref?.id === id) {
            setTimeout(() => {
              if (ref?.id === id) schedulePush(relativePath);
            }, 5_000);
          }
        });
      }, PUSH_DEBOUNCE_MS),
    );
  }

  async function pushToRelay(folderId: string, relativePath: string): Promise<string> {
    const local = loadLocalFolder(folderId);
    if (!local) return "";
    const file = local.files[relativePath];
    if (!file) return ""; // was deleted locally — deletePath handles its own push
    if (file.kind === "folder") return file.nodeId;
    const content = file.content;
    const contentHash = await sha256Hex(content);

    if (file.pendingMove?.kind === "to-oblivion") {
      const fromPath = file.pendingMove.fromPath;
      const manifest = await fetchManifest(folderId);
      const entry = manifest.find((candidate) => candidate.relativePath === fromPath);
      // A missing membership can mean either "the prior move to Oblivion already
      // landed" or merely "the relay observation is empty/offline". Clear the
      // durable journal only after the signed trace head proves action:delete;
      // otherwise throw so attach/debounce retries instead of silently leaving
      // the source socially active.
      if (!entry) {
        const traceId =
          file.traceId ?? (file.nodeId ? await resolveTraceIdentity(file.nodeId) : null);
        const resolution = traceId ? await resolveTraceChain(traceId) : null;
        const head = resolution?.status === "resolved"
          ? resolution.chain[resolution.chain.length - 1]
          : undefined;
        if (!head || eventMeta(head).action !== "delete") {
          throw new Error(`move to Oblivion from ${fromPath} is not yet verifiable`);
        }
        saveLocalFile(folderId, relativePath, {
          content,
          tags: file.tags,
          nodeId: head.id,
          traceId: traceId ?? head.id,
          voicePubkey: file.voicePubkey,
          taggedTraces: file.taggedTraces,
          ...(file.runs && file.runs.length > 0 ? { runs: file.runs } : {}),
        });
        return file.nodeId;
      }
      const traceId =
        file.traceId ??
        (file.nodeId ? await resolveTraceIdentity(file.nodeId) : null) ??
        (await resolveTraceIdentity(entry.latestNodeId));
      const signer = file.voicePubkey
        ? secretKeyForVoice(file.voicePubkey) ?? undefined
        : undefined;
      const event = await publishEdit({
        prevEventId: entry.latestNodeId,
        ...(traceId ? { traceId } : {}),
        relativePath: fromPath,
        folderId,
        deltas: [],
        snapshot: "",
        contentHash: await sha256Hex(""),
        action: "delete",
        signer,
      });
      await removeManifestEntry(folderId, fromPath, signer);
      saveLocalFile(folderId, relativePath, {
        content,
        tags: file.tags,
        nodeId: event.id,
        traceId: traceId ?? event.id,
        voicePubkey: file.voicePubkey,
        taggedTraces: file.taggedTraces,
        ...(file.runs && file.runs.length > 0 ? { runs: file.runs } : {}),
      });
      return event.id;
    }

    // prevEventId from the last stepped node (relay chain head). Reading the
    // relay here keeps the chain linear across authors/devices.
    const manifest = await fetchManifest(folderId);
    const entry = manifest.find((m) => m.relativePath === relativePath);
    const fromEntry = file.pendingMove
      ? manifest.find((candidate) => candidate.relativePath === file.pendingMove!.fromPath)
      : undefined;
    const prevId: string | null = entry?.latestNodeId ?? (file.nodeId || fromEntry?.latestNodeId || null);

    const traceId =
      file.traceId ??
      (prevId ? await resolveTraceIdentity(prevId) : null);

    // Diff against relay's last-known content so the node carries a real delta.
    let chain = [] as Awaited<ReturnType<typeof fetchChain>>;
    if (traceId) {
      const resolved = await resolveTraceChain(traceId, {
        folderId,
        relativePath: entry?.relativePath ?? fromEntry?.relativePath ?? relativePath,
      });
      if (resolved.status === "conflict") {
        throw new Error(`trace ${traceId} has multiple current heads`);
      }
      if (resolved.status === "resolved") chain = resolved.chain;
    }
    if (chain.length === 0 && (entry || fromEntry)) {
      chain = await fetchChain(folderId, entry?.relativePath ?? fromEntry!.relativePath);
    }
    const prevContent = prevId && chain.length > 0 ? reconstructFromChain(chain) : "";

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
    // A forced checkpoint (explicit Step gesture) appends a node even when
    // nothing changed — the deliberate rhythm path (§8). The non-forced path keeps the
    // no-op collapse so the trailing debounce after an edit doesn't re-publish.
    if (entry && !file.pendingMove && entry.contentHash === contentHash && tagsUnchanged && citationsUnchanged && !file.pendingForce) {
      return entry.latestNodeId;
    }

    const deltas = diffToDeltas(prevContent, content);
    // Resolve the voice that authored this edit to its secret key, so the push
    // signs as that voice — not just the AUTHOR default. Falls back to the
    // AUTHOR key if the stored voice isn't in the keychain (defensive: a voice
    // deleted after the edit was authored).
    const signer = file.voicePubkey ? secretKeyForVoice(file.voicePubkey) ?? undefined : undefined;
    const event = await publishEdit({
      prevEventId: prevId,
      ...(traceId ? { traceId } : {}),
      relativePath,
      folderId,
      // A forced checkpoint with no content change mints a clean `deltas: []`
      // node (§8: the rhythm-layer gesture — nothing changed, but the author
      // chose to checkpoint). The synthesized-insert fallback is only for the
      // non-forced path where content is identical but tags/citations changed.
      deltas: deltas.length > 0
        ? deltas
        : file.pendingForce
          ? []
          : [{ type: "insert", positionStart: 0, positionEnd: 0, newValue: content, timestamp: Date.now() }],
      snapshot: content,
      contentHash,
      action: prevId ? "edit" : "import",
      tags: file.tags,
      // Per-character attribution: carry the live run list into the node's
      // `authors` field so it survives reload from the chain (the durable,
      // cross-device carrier) instead of collapsing to the signer on attach.
      // publishEdit validates the map against `snapshot` and drops it if stale.
      ...(file.runs && file.runs.length > 0 ? { authors: file.runs } : {}),
      // Cite every minted span this doc contains (spec:189). `content` is the
      // localStorage string; resolved `[[ phrase | nodeId ]]` live in it.
      citations: findResolvedBrackets(content).map((b) => b.nodeId),
      inlineCitations: findAddedInlineCitations(prevContent, content),
      ...(file.pendingReplyingTo ? { replyingTo: file.pendingReplyingTo } : {}),
      ...(taggedTraces.length > 0 ? { taggedTraces } : {}),
      ...(file.pendingKedits && file.pendingKedits.length > 0 ? { kedits: file.pendingKedits } : {}),
      ...(file.pendingLocalOnly ? { localOnly: true } : {}),
      signer,
    });
    if (file.pendingMove?.kind === "move" && fromEntry) {
      await renameManifestEntry(
        folderId,
        file.pendingMove.fromPath,
        relativePath,
        event.id,
        signer,
      );
    } else {
      await upsertManifestEntry(folderId, {
        kind: "file",
        relativePath,
        latestNodeId: event.id,
        contentHash,
      }, signer, { localOnly: file.pendingLocalOnly });
    }
    // Reflect the stepped node id back into local state so the next push's
    // prevId is correct. Preserve voicePubkey so re-pushes stay correctly signed,
    // and runs so the local record keeps the per-char attribution it just stepped
    // (avoids a needless reload-from-chain on next open). `pendingReplyingTo`,
    // `pendingKedits`, `pendingLocalOnly`, and `pendingForce` are deliberately
    // NOT carried: all four are one-shot, consumed by this push.
    // `taggedTraces` IS carried — tags are persistent across steps.
    saveLocalFile(folderId, relativePath, {
      content,
      tags: file.tags,
      nodeId: event.id,
      traceId: traceId ?? event.id,
      voicePubkey: file.voicePubkey,
      taggedTraces: file.taggedTraces,
      ...(file.runs && file.runs.length > 0 ? { runs: file.runs } : {}),
    });
    return event.id;
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
    async attach(folderRef: FolderRef, _onReconciled?: (path: string, file: FileState | null) => void): Promise<AttachResult> {
      ref = { ...folderRef };
      if (options.requireRelayOnAttach) {
        const genesis = await fetchEventById(ref.id);
        if (!genesis || genesis.kind !== 4290 || eventMeta(genesis).z !== "folder") {
          throw new Error(`folder genesis ${ref.id} is unavailable on the configured relay`);
        }
      }
      rememberLocalFolder(ref);
      let local = loadLocalFolder(ref.id);
      let files = local ? localToFiles(local) : {};
      for (const [path, file] of Object.entries(local?.files ?? {})) {
        // Resume interrupted structural moves and first-time files that were
        // stored locally before their genesis reached the relay (including the
        // starter document installed with a factory-fresh Root).
        if (file.pendingMove || (file.kind !== "folder" && !file.nodeId)) {
          schedulePush(path);
        }
      }
      if (options.requireRelayOnAttach) {
        await pullFromRelay(ref.id, { strict: true });
        local = loadLocalFolder(ref.id);
        files = local ? localToFiles(local) : {};
        return { files, reconciled: Promise.resolve() };
      }
      // The GUI remains local-first and renders immediately, but expose the
      // real synchronization barrier to callers that choose to observe it.
      const reconciled = pullFromRelay(ref.id).then(() => undefined);
      return { files, reconciled };
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
      kedits?: KEdit[],
      localOnly?: boolean,
      force?: boolean,
    ): Promise<string> {
      relativePath = ensureMdExt(relativePath);
      // Capture the voice (by pubkey) that authored this edit, so the debounced
      // relay push signs with the correct key — not just the AUTHOR default.
      // This closes the per-voice signer gap that previously affected Send/zine
      // and that fork-on-write needs. The pubkey is persisted (never the
      // secret); pushToRelay resolves it to bytes via keys-store at push time.
      // A missing signer (the legacy/defensive path) falls back to the AUTHOR
      // voice; primary step paths now always thread an explicit signer.
      const voicePubkey = signer ? getPublicKey(signer) : authorVoice();
      const id = requireId();
      // 1. Local write — synchronous, instant, survives reload/offline.
      const local = loadLocalFolder(id);
      const existing = local?.files[relativePath];
      const prevNodeId = existing?.nodeId ?? "";
      saveLocalFile(id, relativePath, {
        content,
        tags,
        nodeId: prevNodeId,
        traceId: existing?.traceId,
        pendingMove: existing?.pendingMove,
        runs,
        voicePubkey,
        pendingReplyingTo: replyingTo,
        taggedTraces: taggedTraces,
        pendingKedits: kedits,
        pendingLocalOnly: localOnly || undefined,
        pendingForce: force || undefined,
      });
      // 2. An explicit write is a completed Step. The old implementation
      // returned prevNodeId and queued the publish, which made Step/Send point
      // at stale history. Retain local-first durability by scheduling a retry
      // if the synchronous relay barrier fails, but surface that failure now.
      return completeStagedWrite(
        () => pushToRelay(id, relativePath),
        () => schedulePush(relativePath),
      );
    },

    async flushFile(relativePath: string): Promise<string> {
      const timer = pushTimers.get(relativePath);
      if (timer) {
        clearTimeout(timer);
        pushTimers.delete(relativePath);
      }
      try {
        return await pushToRelay(requireId(), relativePath);
      } catch (error) {
        // Preserve local-first durability: a synchronous mint barrier may fail
        // while the home relay restarts, but the staged write must still retry
        // through the ordinary debounce instead of becoming a silent orphan.
        schedulePush(relativePath);
        throw error;
      }
    },

    async createFile(relativePath: string): Promise<string> {
      relativePath = ensureMdExt(relativePath);
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
      // The gesture is complete only after every signed tombstone and manifest
      // removal lands. Perform remote work first so a failure leaves the local
      // copy retryable instead of silently orphaning provenance.
      await completeDeletion(
        affected,
        (path) => tombstoneOnRelay(id, path),
        (path) => deleteLocalFile(id, path),
      );
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
        const file = loadLocalFolder(id)?.files[oldRel];
        if (!file || file.kind === "folder") continue;
        const pendingMove = pendingMoveForPath(oldRel, newRel, file.pendingMove);
        moveLocalFile(id, oldRel, newRel, pendingMove);
        schedulePush(newRel);
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
        const file = loadLocalFolder(id)?.files[oldRel];
        if (!file || file.kind === "folder") continue;
        moveLocalFile(id, oldRel, newRel, {
          kind: "move",
          fromPath: file.pendingMove?.fromPath ?? oldRel,
        });
        schedulePush(newRel);
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
 * A clean auto-merge from background pull — held for user review, not applied.
 * Local storage is NOT modified while a merge is staged: applying it is what
 * writes the merged snapshot and steps the merge node, so an edit between
 * stage and review can't silently lose provenance or clobber the draft.
 */
export interface StagedMerge {
  path: string;
  /** Common-ancestor snapshot (fork point body). */
  base: string;
  /** Local head body — what's in the editor right now. */
  ours: string;
  /** Remote head body — what the peer stepped. */
  theirs: string;
  /** Reconciled body produced by a clean diff3 (outcome === "clean"). */
  merged: string;
  /** Local node id at pull time; the merge node's `prev`. */
  localNodeId: string;
  /** Remote head event id; the merge node's `merge-parent`. */
  remoteHeadId: string;
  /** Pubkey of the remote head's signer, for attribution on step. */
  remoteOwnerPubkey: string;
}

/** Structured outcome of a background pull. */
export interface PullResult {
  /** Fast-forwards: silent overwrites (local was at the ancestor). Refresh UI. */
  updated: Set<string>;
  /** Clean merges awaiting review. Local untouched. */
  staged: StagedMerge[];
  /** Textual conflicts: local untouched; surfaced via the activation banner. */
  conflicts: Set<string>;
}

/**
 * Fetch the relay manifest + chains for the attached folder and reconcile each
 * remote entry against local. Called on attach (non-blocking). Mutates
 * localStorage directly for fast-forwards only; clean merges are staged and
 * left for the caller to surface.
 *
 * Reconciliation is a 3-way merge keyed on the chain's common ancestor:
 *   noop / fastforward / clean (staged) / conflict (untouched). See the module
 * header. The 5-second "recent local draft" guard from `isLocalNewer` still
 * defers any pull decision for a file mid-edit.
 */
export async function pullFromRelay(
  folderId: string,
  options: { strict?: boolean } = {},
): Promise<PullResult> {
  const result: PullResult = {
    updated: new Set<string>(),
    staged: [],
    conflicts: new Set<string>(),
  };
  let manifest: ManifestFileEntry[];
  try {
    manifest = await fetchManifest(folderId);
  } catch (error) {
    if (options.strict) throw error;
    return result; // relay unreachable — fine, local is primary
  }
  const local = loadLocalFolder(folderId);
  for (const entry of manifest) {
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
        result.updated.add(entry.relativePath);
        continue;
      }
      // Remote may have moved (or local doesn't have it) → pull + decide.
      try {
        const chain = await fetchChain(folderId, entry.relativePath);
        const content = chain.length > 0 ? reconstructFromChain(chain) : "";
        const head = chain.length > 0 ? chain[chain.length - 1] : null;
        const remoteHeadId = head?.id ?? entry.latestNodeId;
        const lf = local?.files[entry.relativePath];
        const localContent = lf?.content ?? "";

        // Decide how to reconcile against local. base = the snapshot at local's
        // nodeId on the fetched chain (the common ancestor), if present; else
        // empty (independent roots → diff3 will flag a conflict, which is safe).
        const base = ancestorSnapshot(chain, lf?.nodeId);
        const decision = localContent.length === 0
          ? { outcome: "fastforward" as const } // no local copy → accept remote
          : decidePullMerge(base, localContent, content);

        if (decision.outcome === "noop") continue;

        if (decision.outcome === "conflict") {
          // Leave local untouched; the activation-driven merge banner will
          // surface it when the user opens the file.
          result.conflicts.add(entry.relativePath);
          continue;
        }

        if (decision.outcome === "clean") {
          // Stage for review. Do NOT modify local — applying is what writes.
          result.staged.push({
            path: entry.relativePath,
            base,
            ours: localContent,
            theirs: content,
            merged: decision.merged!,
            localNodeId: lf?.nodeId ?? "",
            remoteHeadId,
            remoteOwnerPubkey: await safeOwnerPubkey(remoteHeadId),
          });
          continue;
        }

        // fastforward: accept the remote tip verbatim (local was at base).
        applyFastForward(
          folderId,
          entry.relativePath,
          chain,
          content,
          head,
          remoteHeadId,
        );
        result.updated.add(entry.relativePath);
      } catch (error) {
        if (options.strict) throw error;
        // per-file fetch failure — skip, keep local
      }
    }
  }
  return result;
}

/** Snapshot at `localNodeId` on the chain, or "" if the node isn't on it
 *  (true fork / multi-device split — caller falls back to best-effort). */
function ancestorSnapshot(chain: import("nostr-tools").Event[], localNodeId: string | undefined): string {
  if (!localNodeId || localNodeId === "" || chain.length === 0) return "";
  const idx = chain.findIndex((e) => e.id === localNodeId);
  if (idx === -1) return "";
  // Nodes are self-sufficient (spec §3.1): reconstructing the prefix up to the
  // ancestor yields its snapshot. (Slice copies; reconstructFromChain reads it.)
  return reconstructFromChain(chain.slice(0, idx + 1));
}

/** Best-effort remote-owner lookup; never throws (merge staging must not fail
 *  on a key-resolution blip — attribution falls back to the author voice). */
async function safeOwnerPubkey(remoteHeadId: string): Promise<string> {
  try {
    const owner = await fetchNodeOwner(remoteHeadId);
    return owner || authorVoice();
  } catch {
    return authorVoice();
  }
}

/** Apply a fast-forward: overwrite local with the remote tip, reconstructing
 *  tags / runs / tagged-traces exactly as the pre-merge pull did. */
function applyFastForward(
  folderId: string,
  relativePath: string,
  chain: import("nostr-tools").Event[],
  content: string,
  head: import("nostr-tools").Event | null,
  remoteHeadId: string,
): void {
  const tags = headUserTags(chain);
  const taggedTraces = headTaggedTraces(
    chain,
    findResolvedBrackets(content).map((b) => b.nodeId),
  );
  const runs = chain.length > 0 ? reconstructRunsFromChain(chain) : [];
  saveLocalFile(folderId, relativePath, {
    content,
    tags,
    nodeId: head?.id ?? remoteHeadId,
    ...(chain[0]?.id ? { traceId: chain[0].id } : {}),
    ...(runs.length > 0 ? { runs } : {}),
    ...(taggedTraces.length > 0 ? { taggedTraces } : {}),
  });
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
  const traceId = await resolveTraceIdentity(entry.latestNodeId);
  await publishEdit({
    prevEventId: entry.latestNodeId,
    ...(traceId ? { traceId } : {}),
    relativePath,
    folderId,
    deltas: [],
    snapshot: "",
    contentHash: await sha256Hex(""),
    action: "delete",
  });
  // Spec-clean tombstone: drop the member from the folder snapshot (remove
  // delta), not an isDeleted entry. The file's 4290 chain retains history.
  await removeManifestEntry(folderId, relativePath);
}

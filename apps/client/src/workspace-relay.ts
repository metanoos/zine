/**
 * Relay-only workspace backend (webapp).
 *
 * The webapp has no disk, so "home" is a folder on the hosted relay. This
 * backend reads the relay's kind-34290 manifest to list files and
 * reconstructs each file's content from its kind-4290 chain; writes publish
 * events directly with no disk step. It signs with the browser keypair
 * (identity.ts), so a webapp edit extends a desktop-started chain as a new
 * author — the chain is walked by `prev` links, not by signer.
 *
 * The relay is authoritative: there's no local cache, so what's on the relay
 * is exactly what the user sees.
 */

import {
  diffToDeltas,
  eventMeta,
  fetchChain,
  fetchManifest,
  headUserTags,
  headTaggedTraces,
  publishEdit,
  reconstructFromChain,
  reconstructRunsFromChain,
  removeManifestEntry,
  renameManifestEntry,
  upsertManifestEntry,
  type ManifestFileEntry,
} from "./provenance.js";
import { findResolvedBrackets } from "./brackets.js";
import { manualVoice } from "./keys-store.js";
import type {
  AttachResult,
  FileState,
  FolderRef,
  Run,
  Workspace,
} from "./workspace-core.js";

async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function runsFromText(text: string): FileState["runs"] {
  // The editor attributes baseline content to the manual (pen) voice as a
  // single run; finer-grained attribution happens through subsequent edits.
  // Resolves to the manual key's pubkey (not the old "alice" label) so the
  // run renders under that key's identity.
  return text.length === 0 ? [] : [{ voice: manualVoice(), text }];
}

function basename(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
}

/**
 * Create a relay-backed workspace. Unattached until `attach()` binds a
 * folderId. Used by the webapp (and as a fallback anywhere there's no disk).
 */
export function createRelayWorkspace(): Workspace {
  let ref: FolderRef | null = null;

  function requireId(): string {
    if (!ref) throw new Error("workspace not attached — call attach() first");
    return ref.id;
  }

  return {
    get ref(): FolderRef | null {
      return ref ? { ...ref } : null;
    },

    /**
     * Read the folder's current state from the relay: the manifest gives the
     * file list, and each non-deleted entry's chain is replayed to rebuild
     * content. This is the "sync read" — whatever's on the relay is what the
     * webapp shows.
     */
    async attach(folderRef: FolderRef): Promise<AttachResult> {
      ref = { ...folderRef };
      const manifest = await fetchManifest(ref.id);
      const files: Record<string, FileState> = {};

      for (const entry of manifest) {
        if (entry.isDeleted) continue; // tombstoned — not shown in the tree
        if (entry.kind === "folder") {
          // A folder-member (spec §3.2 nesting): its nodeId is the subfolder's
          // genesis. No file body, no file chain to reconstruct — store a
          // placeholder FileState so the tree renders it as a folder, and skip
          // fetchChain (which is relpath-keyed for files, not folder-id-keyed).
          files[entry.relativePath] = { kind: "folder", runs: [], nodeId: entry.latestNodeId, tags: [] };
          continue;
        }
        const chain = await fetchChain(ref.id, entry.relativePath);
        const content = chain.length > 0 ? reconstructFromChain(chain) : "";
        // Reconstruct per-char attribution from the chain. This is author-aware
        // now: a node carrying a valid `authors` map is adopted verbatim, so a
        // multi-author document survives reload instead of collapsing to the
        // opener's single run. Falls back to runsFromText for chains with no
        // attribution info (legacy / foreign nodes).
        const runs =
          chain.length > 0 ? reconstructRunsFromChain(chain) : runsFromText(content);
        // Recover the tagged-but-not-quoted traces from the head: the head's
        // q-tags minus the body's bracket citations. A tag survives reload this
        // way without being re-added; re-seal re-emits them.
        const taggedTraces = headTaggedTraces(
          chain,
          findResolvedBrackets(content).map((b) => b.nodeId),
        );
        files[entry.relativePath] = {
          runs,
          nodeId: entry.latestNodeId,
          tags: headUserTags(chain),
          ...(taggedTraces.length > 0 ? { taggedTraces } : {}),
        };
      }
      return { files };
    },

    async readFile(relativePath: string): Promise<string> {
      const id = requireId();
      const chain = await fetchChain(id, relativePath);
      return chain.length > 0 ? reconstructFromChain(chain) : "";
    },

    /**
     * Publish an edit/import node directly. Content lives in the event's
     * `snapshot` field (no disk). `prevEventId` is read from the relay's
     * current chain head — NOT from local memory — so a webapp edit extends
     * whatever the latest author left, keeping the chain linear across the
     * desktop and webapp.
     */
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
      const id = requireId();
      const manifest = await fetchManifest(id);
      const entry = manifest.find((m) => m.relativePath === relativePath);
      const contentHash = await sha256Hex(content);

      const chain = entry ? await fetchChain(id, relativePath) : [];
      const prevContent = entry ? reconstructFromChain(chain) : "";
      const prevTags = headUserTags(chain);
      const tagsUnchanged =
        prevTags.length === tags.length && prevTags.every((t, i) => t === tags[i]);

      // The set of citations (q-tags) the next node will emit = body brackets +
      // the reply source + tagged traces. Compare against the prev head's
      // q-tags so a pure tag-add (content + topical tags both unchanged) still
      // seals — without this, adding a tagged trace to an otherwise-unchanged
      // doc would be swallowed as a no-op touch.
      const prevCitations = entry ? eventMeta(chain[chain.length - 1]).citationTargets : [];
      const nextCitations = [
        ...findResolvedBrackets(content).map((b) => b.nodeId),
        ...(replyingTo ? [replyingTo] : []),
        ...(taggedTraces ?? []),
      ];
      const citationsUnchanged =
        prevCitations.length === nextCitations.length &&
        prevCitations.every((c, i) => c === nextCitations[i]);

      if (
        entry &&
        entry.contentHash === contentHash &&
        !entry.isDeleted &&
        tagsUnchanged &&
        citationsUnchanged
      ) {
        return entry.latestNodeId; // no-op touch
      }

      const deltas = diffToDeltas(prevContent, content);
      if (deltas.length === 0 && entry && tagsUnchanged && citationsUnchanged) {
        return entry.latestNodeId;
      }

      const event = await publishEdit({
        // prevEventId from the relay head, not local state → multi-author safe.
        prevEventId: entry?.latestNodeId ?? null,
        relativePath,
        folderId: id,
        deltas: deltas.length > 0
          ? deltas
          : [{ type: "insert", positionStart: 0, positionEnd: 0, newValue: content, timestamp: Date.now() }],
        snapshot: content,
        contentHash,
        action: entry ? "edit" : "import",
        tags,
        // Per-character attribution: carry the live run list into the node's
        // `authors` field so it survives reload from the chain. publishEdit
        // validates the map against `snapshot` and drops it if stale.
        ...(runs && runs.length > 0 ? { authors: runs } : {}),
        // Cite every minted span this doc contains (spec:189).
        citations: findResolvedBrackets(content).map((b) => b.nodeId),
        ...(replyingTo ? { replyingTo } : {}),
        ...(taggedTraces && taggedTraces.length > 0 ? { taggedTraces } : {}),
        ...(signer ? { signer } : {}),
        ...(localOnly ? { localOnly: true } : {}),
      });

      await upsertManifestEntry(
        id,
        {
          relativePath,
          latestNodeId: event.id,
          isDeleted: false,
          contentHash,
        },
        signer,
      );
      return event.id;
    },

    async createFile(relativePath: string): Promise<string> {
      // No disk to check for existence; if it's in the manifest, treat as
      // existing (re-write consolidates). Otherwise import empty content.
      const id = requireId();
      const manifest = await fetchManifest(id);
      const existing = manifest.find((m) => m.relativePath === relativePath && !m.isDeleted);
      if (existing) {
        return this.writeFile(relativePath, await this.readFile(relativePath));
      }
      return this.writeFile(relativePath, "");
    },

    async createFolder(_relativePath: string): Promise<void> {
      // Folders are implicit in file paths (no provenance node of their own,
      // same as the disk backend). Nothing to do on the relay until a file
      // lands under this path.
    },

    async deletePath(relativePath: string, isFolder: boolean): Promise<void> {
      const id = requireId();
      const manifest = await fetchManifest(id);
      const affected = isFolder
        ? manifest.filter(
            (m) =>
              m.relativePath === relativePath ||
              m.relativePath.startsWith(relativePath + "/"),
          )
        : manifest.filter((m) => m.relativePath === relativePath);
      for (const entry of affected) {
        if (entry.isDeleted) continue;
        await markDeleted(id, entry);
      }
    },

    async movePath(src, destFolder, _isFolder, tagsByPath = {}): Promise<void> {
      const id = requireId();
      const manifest = await fetchManifest(id);
      const name = basename(src);
      const destPath = destFolder === "" ? name : `${destFolder}/${name}`;

      const affected: { oldRel: string; newRel: string }[] = [];
      for (const entry of manifest) {
        if (entry.relativePath === src) {
          affected.push({ oldRel: entry.relativePath, newRel: destPath });
        } else if (entry.relativePath.startsWith(src + "/")) {
          affected.push({
            oldRel: entry.relativePath,
            newRel: destPath + entry.relativePath.slice(src.length),
          });
        }
      }

      for (const { oldRel, newRel } of affected) {
        const chain = await fetchChain(id, oldRel);
        const content = chain.length > 0 ? reconstructFromChain(chain) : "";
        const contentHash = await sha256Hex(content);
        const userTags = tagsByPath[oldRel] ?? headUserTags(chain);
        // Import at the new path (relay-only: no disk rename step).
        const event = await publishEdit({
          prevEventId: null,
          relativePath: newRel,
          folderId: id,
          deltas: content.length > 0
            ? [{ type: "insert", positionStart: 0, positionEnd: 0, newValue: content, timestamp: Date.now() }]
            : [],
          snapshot: content,
          contentHash,
          action: "import",
          tags: userTags,
        });
        await upsertManifestEntry(id, {
          relativePath: newRel,
          latestNodeId: event.id,
          isDeleted: false,
          contentHash,
        });
        // Tombstone at the old path.
        const oldEntry = manifest.find((m) => m.relativePath === oldRel);
        if (oldEntry && !oldEntry.isDeleted) await markDeleted(id, oldEntry);
      }
    },

    async renamePath(src, newName, _isFolder): Promise<void> {
      const id = requireId();
      const manifest = await fetchManifest(id);
      const slash = src.lastIndexOf("/");
      const destPath = slash === -1 ? newName : src.slice(0, slash + 1) + newName;

      const affected: { oldRel: string; newRel: string }[] = [];
      for (const entry of manifest) {
        if (entry.relativePath === src) {
          affected.push({ oldRel: entry.relativePath, newRel: destPath });
        } else if (entry.relativePath.startsWith(src + "/")) {
          affected.push({
            oldRel: entry.relativePath,
            newRel: destPath + entry.relativePath.slice(src.length),
          });
        }
      }

      for (const { oldRel, newRel } of affected) {
        const chain = await fetchChain(id, oldRel);
        const content = chain.length > 0 ? reconstructFromChain(chain) : "";
        const contentHash = await sha256Hex(content);
        const userTags = headUserTags(chain);
        // Seal the file node at the new path (relay-only: no disk rename step).
        // The file's 4290 chain lives under its `F` tag, so a rename mints a
        // fresh node at newRel rather than rewriting the old node's tag.
        const event = await publishEdit({
          prevEventId: null,
          relativePath: newRel,
          folderId: id,
          deltas: content.length > 0
            ? [{ type: "insert", positionStart: 0, positionEnd: 0, newValue: content, timestamp: Date.now() }]
            : [],
          snapshot: content,
          contentHash,
          action: "import",
          tags: userTags,
        });
        // One `rename` folder delta per member: fromPath → toPath. Replaces the
        // old upsert+markDeleted pair so one user gesture is one replayable
        // event and the file's history stays linked to its new path.
        await renameManifestEntry(id, oldRel, newRel, event.id);
      }
    },

    async readFolderTags(): Promise<Record<string, string[]>> {
      // The relay carries no folder-level metadata (folders are implicit in
      // file paths). Foreign/read-only folders expose no folder tags.
      return {};
    },

    async writeFolderTags(_tags: Record<string, string[]>): Promise<void> {
      // Read-only: foreign folders can't persist folder tags. No-op.
    },
  };
}

async function markDeleted(folderId: string, entry: ManifestFileEntry): Promise<void> {
  await publishEdit({
    prevEventId: entry.latestNodeId,
    relativePath: entry.relativePath,
    folderId,
    deltas: [],
    snapshot: "", // delete has no content snapshot
    contentHash: entry.contentHash,
    action: "delete",
  });
  // Spec-clean tombstone: drop the member from the folder snapshot (remove
  // delta), not an isDeleted entry. The file's 4290 chain retains history.
  await removeManifestEntry(folderId, entry.relativePath);
}

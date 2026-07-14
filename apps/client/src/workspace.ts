/**
 * The workspace service: ties a real folder on disk to its nostr provenance
 * records in the local relay. This is the single surface the UI calls; it
 * never lets disk and the relay drift — every mutation writes to disk AND
 * seals a kind-4290 node AND republishes the kind-34290 manifest.
 *
 * Disk is the source of truth for *what exists*; the relay is the source of
 * truth for *how it got there*. On open, `baselineScan` reconciles the two:
 * files new on disk get imported, files gone from disk get marked deleted,
 * changed files get an edit node. This mirrors the harness's
 * `ProvenanceStore` (apps/harness/src/store.ts) postures exactly, so the
 * same folder is interoperable between the desktop app and the CLI.
 *
 * All disk access goes through Tauri commands that resolve relative paths
 * against the attached folder root inside Rust and reject escapes — the
 * webview never touches an absolute path or a file outside the folder.
 */

import type { AttachedFolder } from "./registry.js";
import {
  clearAttachedFolder,
  loadAttachedFolder,
  saveAttachedFolder,
} from "./registry.js";
import {
  createFolderGenesis,
  diffToDeltas,
  eventMeta,
  fetchChain,
  fetchFolderNodes,
  fetchLatestFolderNode,
  fetchManifest,
  headUserTags,
  headTaggedTraces,
  publishEdit,
  reconstructFromChain,
  reconstructRunsFromChain,
  removeManifestEntry,
  renameManifestEntry,
  upsertManifestEntry,
  type EventMeta,
  type ManifestFileEntry,
  type SampleEventMeta,
} from "./provenance.js";
import { findResolvedBrackets } from "./brackets.js";
import { manualVoice } from "./keys-store.js";
import type { Event } from "nostr-tools";
import type {
  AttachResult,
  FileState,
  FolderRef,
  Run,
  Workspace,
} from "./workspace-core.js";
import { flattenRuns } from "./workspace-core.js";

// --- shared editor types ------------------------------------------------
//
// `Run` and `FileState` are defined in workspace-core.ts (the backend-neutral
// interface) and re-exported here so existing imports (`from "./workspace.js"`)
// keep working during the migration to the Workspace interface.

export type { Run, FileState, EventMeta, SampleEventMeta };

// --- Tauri invoke wrapper ----------------------------------------------
//
// Uses the official @tauri-apps/api/core invoke, which resolves to
// window.__TAURI_INTERNALS__.invoke — the internal the Tauri 2 webview always
// injects. The previous implementation read window.__TAURI__.core.invoke, a
// *global* wrapper that only exists when app.withGlobalTauri is set in the
// config (it isn't). That made every Tauri command — pick_folder, the file
// reads/writes, spawn_relay — silently no-op in the running desktop app,
// surfacing as "I click Choose folder; nothing happens." The isTauri() check
// in identity.ts uses __TAURI_INTERNALS__ (correct), so the UI believed it was
// in the desktop runtime while the command layer thought it wasn't.
import { invoke as tauriInvoke } from "@tauri-apps/api/core";

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return (await tauriInvoke(cmd as never, args as never)) as T;
}

interface DirEntry {
  relative_path: string;
  is_dir: boolean;
}

// --- hashing ------------------------------------------------------------

async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function runsFromText(text: string): Run[] {
  // The editor attributes all baseline/reconstructed content to the manual
  // (pen) voice as a single run. Finer-grained voice attribution happens
  // through subsequent edits, which splice in the editing voice. Resolves to
  // the manual key's pubkey so the run renders under that key's identity;
  // the old "alice" string-literal was a label, not a pubkey, and fell into
  // the decoration's hash-bucket fallback (wrong color) — see keys-store.ts
  // manualVoice() and buildVoiceDecorations in App.tsx.
  return text.length === 0 ? [] : [{ voice: manualVoice(), text }];
}

// --- attribution sidecar ------------------------------------------------
//
// Per-line voice attribution (the editor's run list) is persisted to a JSON
// sidecar at `.zine/attribution.json` inside the folder, keyed by relative
// path. The content file itself stays plain text (preserving harness-CLI /
// git / other-editor interop); the sidecar is the desktop's private mirror of
// the voice layer. `.zine` is in IGNORED_SEGMENTS so the walker never treats
// the sidecar as a content file.
//
// This is deliberately best-effort and never fatal: a read-only folder, a
// corrupt sidecar, or a missing sidecar all degrade to the single-run
// baseline (what the editor did before this existed). The relay carries no
// runs, so cross-device sync still collapses to one run — an accepted boundary
// matching the protocol doc's current scope.
const ATTRIBUTION_SIDECAR = ".zine/attribution.json";

/** Folder-level tags (the one piece of metadata folders carry — they're
 *  otherwise implicit in file paths) live in a sibling sidecar, keyed by
 *  folder relative path. Same best-effort posture as the attribution sidecar:
 *  `.zine` is gitignored + ignored by the walker, and a read-only or missing
 *  sidecar degrades to "no folder tags". */
const FOLDER_TAGS_SIDECAR = ".zine/folders.json";

/** Read the whole attribution sidecar. Returns {} on any failure (missing
 *  file, corrupt JSON, or no folder path) — callers fall back to single-run
 *  attribution. `root` is `string | undefined` because FolderRef.path is
 *  optional (undefined on the webapp); these helpers are desktop-only but stay
 *  total so call sites need no narrowing. */
async function readAttribution(root: string | undefined): Promise<Record<string, Run[]>> {
  if (!root) return {};
  try {
    const raw = await invoke<string>("read_text_file", {
      root,
      relativePath: ATTRIBUTION_SIDECAR,
    }).catch(() => null);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, Run[]>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** Persist the full attribution map. Best-effort — a read-only folder (or no
 *  folder path) must not fail a content save that already succeeded. */
async function writeAttribution(root: string | undefined, map: Record<string, Run[]>): Promise<void> {
  if (!root) return;
  try {
    await invoke<null>("write_text_file", {
      root,
      relativePath: ATTRIBUTION_SIDECAR,
      contents: JSON.stringify(map),
    });
  } catch {
    // Non-fatal: content + provenance are already saved; only the voice layer
    // is lost, which degrades to single-run on next load (today's baseline).
  }
}

/** Read the folder-tags sidecar. `{}` on any failure — folders simply show no
 *  tags, which is the pre-feature baseline. */
async function readFolderTagsFile(root: string | undefined): Promise<Record<string, string[]>> {
  if (!root) return {};
  try {
    const raw = await invoke<string>("read_text_file", {
      root,
      relativePath: FOLDER_TAGS_SIDECAR,
    }).catch(() => null);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, string[]>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** Persist the folder-tags map. Best-effort and non-fatal, like the
 *  attribution sidecar. */
async function writeFolderTagsFile(
  root: string | undefined,
  tags: Record<string, string[]>,
): Promise<void> {
  if (!root) return;
  try {
    await invoke<null>("write_text_file", {
      root,
      relativePath: FOLDER_TAGS_SIDECAR,
      contents: JSON.stringify(tags),
    });
  } catch {
    // Non-fatal: folder tags are UI metadata, not provenance.
  }
}

// --- attach + baseline --------------------------------------------------

/** Show a native folder picker and return the chosen absolute path, or null
 *  if the user cancelled. Also used by the empty-state "choose folder" UI. */
export async function chooseFolder(): Promise<string | null> {
  return invoke<string | null>("pick_folder");
}

/** A sensible default folder to offer on first run ($HOME/zine if it exists),
 *  so a user can start without navigating the picker. null if unavailable. */
export async function defaultFolder(): Promise<string | null> {
  try {
    return await invoke<string | null>("attached_folder_default");
  } catch {
    return null;
  }
}

/** Returns the currently attached folder from localStorage, or null. Does
 *  NOT verify the path still exists on disk — `attach` does that. */
export function getAttachedFolder(): AttachedFolder | null {
  return loadAttachedFolder();
}

/** Forget the currently attached folder (the user wants to pick a different
 *  one). Provenance records stay in the relay; only the local pointer is
 *  cleared. */
export function detachFolder(): void {
  clearAttachedFolder();
}

/** Attach (or re-attach) a folder: mint a stable folderId, persist it, and
 *  baseline the folder against the relay. Returns the reconstructed in-memory
 *  file state for the initial sidebar/editor. Throws if the path doesn't
 *  exist or can't be read. */
export async function attachFolder(absPath: string): Promise<{
  folder: AttachedFolder;
  files: Record<string, FileState>;
}> {
  // Reuse an existing folderId if this path was attached before — its
  // provenance chain is keyed on the id, so a new id would orphan it.
  const existing = loadAttachedFolder();
  if (existing && existing.path === absPath) {
    // Re-attach: keep the existing id (UUID for legacy, genesis id for new).
    const folder: AttachedFolder = { id: existing.id, path: absPath };
    saveAttachedFolder(folder);
    const files = await baselineScan(folder);
    return { folder, files };
  }
  // Phase 5: publish genesis first, adopt its event id as the folder identity
  // (spec §3.1: trace identity IS the genesis node id). This replaces the
  // pre-Phase-5 UUID mint. Legacy UUID-keyed folders (already in localStorage)
  // keep their UUIDs and stay findable via the #D arm of fetchFolderNodes.
  const genesisId = await createFolderGenesis();
  const folder: AttachedFolder = { id: genesisId, path: absPath };
  saveAttachedFolder(folder);

  const files = await baselineScan(folder);
  return { folder, files };
}

// --- nesting helpers (spec §3.2) ----------------------------------------
//
// Under nesting, a folder's subdirectories are themselves folder traces
// (own genesis, own chain, own membership). Files publish to their IMMEDIATE
// folder id with single-segment names; the slash-joined display path is
// reconstructed by listFiles/App.tsx's tree memo for display only. These
// helpers resolve the leaf folder for a display path and mint subfolder geneses.

/** Resolve the GENESIS id (the folder's permanent identity, spec §3.1) from any
 *  node id on the folder's chain. A folder member's `latestNodeId` is the
 *  current head (advances on every seal), but the identity that file nodes
 *  carry on their `f`/`D` tags is the genesis. Reads the node by id, returns
 *  its `f` tag; for a genesis node (no `f` tag) the input is returned as-is.
 *  Ports the harness's resolveFolderIdentity (store.ts). */
async function resolveFolderIdentity(nodeId: string): Promise<string> {
  const events = await fetchFolderNodes(nodeId);
  const event = events.find((e) => e.id === nodeId);
  if (!event) return nodeId;
  const fTag = event.tags.find((t) => t[0] === "f")?.[1];
  return fTag ?? nodeId;
}

/** Walk a slash-joined display path from the root folder to the leaf folder
 *  trace that owns the file. Under nesting, 'blog/refs/cite.md' resolves
 *  through two folder-members (blog, then refs) to find the folder trace that
 *  owns 'cite.md'. Returns the leaf folder's genesis id and the single-segment
 *  leaf member name. For a top-level file the leaf folder IS the root.
 *  Ports the harness's resolveLeafFolder (store.ts). */
async function resolveLeafFolder(
  rootFolderId: string,
  displayPath: string,
): Promise<{ leafFolderId: string; leafMemberName: string }> {
  const segments = displayPath.split("/");
  if (segments.length === 1) {
    return { leafFolderId: rootFolderId, leafMemberName: segments[0] };
  }
  let folderId = rootFolderId;
  for (let i = 0; i < segments.length - 1; i++) {
    const manifest = await fetchManifest(folderId);
    const sub = manifest.find((m) => m.relativePath === segments[i] && m.kind === "folder");
    if (!sub) {
      // Intermediate folder-member not found — the path doesn't exist in the
      // tree. Fall through to the root as the leaf (the caller will handle the
      // missing entry when it fails to find it in the manifest).
      return { leafFolderId: rootFolderId, leafMemberName: segments[segments.length - 1] };
    }
    folderId = await resolveFolderIdentity(sub.latestNodeId);
  }
  return { leafFolderId: folderId, leafMemberName: segments[segments.length - 1] };
}

/** Mint a subfolder genesis under `parentFolderId` and upsert a `kind: "folder"`
 *  member named `memberName`. Returns the new subfolder's genesis id (its
 *  permanent identity). Used by baselineScan's recursive descent and by
 *  createFolder. The entry's contentHash is the empty-folder canonical body
 *  hash at creation; refreshFolderMemberHash updates it after population. */
async function createSubfolder(parentFolderId: string, memberName: string): Promise<string> {
  const genesisId = await createFolderGenesis();
  const entry: ManifestFileEntry = {
    kind: "folder",
    relativePath: memberName,
    latestNodeId: genesisId,
    contentHash: "", // placeholder — refreshFolderMemberHash fills it after population
  };
  await upsertManifestEntry(parentFolderId, entry);
  return genesisId;
}

/** Refresh the parent's member-entry contentHash for subfolder `memberName`
 *  after the subfolder's own chain advanced (its membership was populated).
 *  Reads the subfolder's latest head, recomputes its canonical-body hash, and
 *  upserts the parent's entry. One folder-node read + one parent re-seal. */
async function refreshFolderMemberHash(
  parentFolderId: string,
  memberName: string,
  subfolderId: string,
): Promise<void> {
  const subHead = await fetchLatestFolderNode(subfolderId);
  if (!subHead) return;
  // Recompute the canonical body hash the same way publishFolderNode does:
  // [[relativePath, kind, contentHash], …] in member order. We can't call the
  // private hashFolderSnapshot, so we read the contentHash off the head node's
  // `x` tag (publishFolderNode stamps it there).
  const xTag = subHead.tags.find((t) => t[0] === "x")?.[1] ?? "";
  await upsertManifestEntry(parentFolderId, {
    kind: "folder",
    relativePath: memberName,
    latestNodeId: subHead.id,
    contentHash: xTag,
  });
}

/**
 * Reconcile the folder on disk with the relay's manifest, sealing nodes for
 * any drift, and return the current file set as in-memory state. Mirrors the
 * harness's baselineScan/importFile/markDeleted flow:
 *
 * - file on disk, unknown to manifest → seal an `import` node, upsert entry.
 * - file on disk, in manifest, content hash unchanged → no node; reconstruct
 *   content from the chain for the editor.
 * - file on disk, in manifest, content changed since last node → seal an
 *   `edit` node (disk is source of truth), upsert entry.
 * - file in manifest, missing from disk → seal a `delete` node, mark deleted.
 *
 * The hash check keeps the baseline idempotent: opening the app a second time
 * doesn't republish everything, only what actually changed.
 */
export async function baselineScan(folder: AttachedFolder): Promise<Record<string, FileState>> {
  const diskEntries = await invoke<DirEntry[]>("list_dir", { root: folder.path });
  // Voice attribution lives in the sidecar (one read for the whole folder).
  // Validated per-file against content below: external edits invalidate stale
  // attribution, which falls back to a single run.
  const attribution = await readAttribution(folder.path);

  /** Resolve runs for a file, in three tiers: (1) the persisted attribution
   *  sidecar when it still matches the content (it can be ahead of the chain
   *  mid-session), (2) author-aware reconstruction from the chain when one is
   *  available — adopts a node's `authors` map verbatim, falling back to per-
   *  node-signer attribution, so multi-author docs survive reload, (3) the
   *  single-run baseline (legacy / no chain). */
  const runsFor = (displayPath: string, content: string, chain?: Event[]): Run[] => {
    const stored = attribution[displayPath];
    if (stored && stored.length > 0 && flattenRuns(stored) === content) return stored;
    if (chain && chain.length > 0) {
      const fromChain = reconstructRunsFromChain(chain);
      if (fromChain.length > 0) return fromChain;
    }
    return runsFromText(content);
  };

  // Group the flat list_dir output by directory. Each directory becomes a level
  // in the nesting tree: its immediate file children publish to its folder id,
  // its subdirectories recurse as folder-members.
  // e.g. "blog/draft.md" → dir="blog", name="draft.md", isDir=false
  //      "blog"           → dir="",     name="blog",    isDir=true
  interface DiskChild { name: string; isDir: boolean; }
  const childrenByDir = new Map<string, DiskChild[]>();
  for (const e of diskEntries) {
    const rp = e.relative_path;
    const slash = rp.lastIndexOf("/");
    const dir = slash < 0 ? "" : rp.slice(0, slash);
    const name = slash < 0 ? rp : rp.slice(slash + 1);
    if (!childrenByDir.has(dir)) childrenByDir.set(dir, []);
    childrenByDir.get(dir)!.push({ name, isDir: e.is_dir });
  }

  const files: Record<string, FileState> = {};

  /** Recursive reconcile of one directory level. `dirPrefix` is the display
   *  path prefix (slash-joined, "" at root); `folderId` is the folder trace
   *  that owns this level's direct children. Files publish here with single-
   *  segment names; subdirectories mint/reuse a subfolder genesis and recurse.
   *  `manifestByPath` is consumed as entries are matched; leftovers are tomb-
   *  stoned at the end of each level. */
  async function scanDir(dirPrefix: string, folderId: string): Promise<void> {
    const children = childrenByDir.get(dirPrefix) ?? [];
    // For nested levels, the manifest is per-folder; for the root it's the
    // attached folder's manifest. fetchManifest is identity-agnostic.
    const manifest = await fetchManifest(folderId);
    // The manifest entries are single-segment names within THIS folder (under
    // nesting). But legacy flat folders have slash-joined paths. To handle
    // both, key the map by the member's relativePath and look up by leaf name
    // for files. For legacy compatibility, also check the display path.
    const manifestByName = new Map(manifest.map((m) => [m.relativePath, m]));

    for (const child of children) {
      const childDisplayPath = dirPrefix ? `${dirPrefix}/${child.name}` : child.name;

      if (child.isDir) {
        // Subdirectory → folder-member. Check if it already exists in the
        // manifest (re-attach); otherwise mint a new subfolder genesis.
        let subEntry = manifestByName.get(child.name);
        let subFolderId: string;
        if (subEntry && subEntry.kind === "folder") {
          subFolderId = await resolveFolderIdentity(subEntry.latestNodeId);
        } else {
          subFolderId = await createSubfolder(folderId, child.name);
          manifestByName.delete(child.name);
        }
        // Recurse into the subfolder.
        await scanDir(childDisplayPath, subFolderId);
        // Refresh the parent's contentHash for this subfolder (its membership
        // advanced during the recursion).
        if (!subEntry || subEntry.kind !== "folder") {
          await refreshFolderMemberHash(folderId, child.name, subFolderId);
        }
        // Record the folder-member as a placeholder FileState so the tree renders it.
        files[childDisplayPath] = { kind: "folder", runs: [], nodeId: subFolderId, tags: [] };
        continue;
      }

      // File: read content, reconcile against the manifest entry.
      const memberName = child.name;
      // Under nesting the entry is keyed by single-segment name; under legacy
      // flat folders it's keyed by the full display path. Check both.
      const entry = manifestByName.get(memberName) ?? manifestByName.get(childDisplayPath);
      const content = await invoke<string>("read_text_file", {
        root: folder.path,
        relativePath: childDisplayPath,
      }).catch(() => "");
      const contentHash = await sha256Hex(content);

      if (!entry) {
        // New on disk, unknown to the relay: import it.
        const event = await sealImport(folderId, memberName, content, contentHash, null, []);
        files[childDisplayPath] = { runs: runsFor(childDisplayPath, content), nodeId: event.id, tags: [] };
        manifestByName.delete(memberName);
        manifestByName.delete(childDisplayPath);
        continue;
      }

      if (entry.contentHash === contentHash && !entry.isDeleted) {
        // Unchanged since last seal: reconstruct from the chain (authoritative).
        const chain = await fetchChain(folderId, memberName);
        const reconstructed = chain.length > 0 ? reconstructFromChain(chain) : content;
        const taggedTraces = headTaggedTraces(
          chain,
          findResolvedBrackets(reconstructed).map((b) => b.nodeId),
        );
        files[childDisplayPath] = {
          runs: runsFor(childDisplayPath, reconstructed, chain),
          nodeId: entry.latestNodeId,
          tags: headUserTags(chain),
          ...(taggedTraces.length > 0 ? { taggedTraces } : {}),
        };
        manifestByName.delete(memberName);
        manifestByName.delete(childDisplayPath);
        continue;
      }

      // Changed on disk (or was marked deleted and reappeared): seal an edit.
      const priorChain = await fetchChain(folderId, memberName);
      const priorUserTags = headUserTags(priorChain);
      const event = await sealImport(
        folderId,
        memberName,
        content,
        contentHash,
        entry.latestNodeId,
        priorUserTags,
      );
      files[childDisplayPath] = { runs: runsFor(childDisplayPath, content), nodeId: event.id, tags: priorUserTags };
      manifestByName.delete(memberName);
      manifestByName.delete(childDisplayPath);
    }

    // Anything left in this folder's manifest has no file on disk → mark deleted.
    // Skip folder-members (they're handled by the recursion, not by disk files).
    for (const [, entry] of manifestByName) {
      if (entry.isDeleted) continue;
      if (entry.kind === "folder") continue; // subfolder — not a missing file
      await markDeleted(folderId, entry);
    }
  }

  await scanDir("", folder.id);
  return files;
}

// --- mutations ----------------------------------------------------------
//
// Each mutation writes to disk first (source of truth), then seals a node
// and updates the manifest. If the disk write fails, we don't touch the
// relay — provenance only records what actually landed on disk.

/** Persist `content` to disk and seal an edit/import node for it. Called by
 *  the debounced save path (Cmd-S or 1.5s idle) in the editor. No-op only when
 *  BOTH the content hash and the user tags match the last sealed node — a
 *  tag-only change still seals, so tag edits reach the relay. Returns the new
 *  nodeId, or the existing one if nothing changed. `runs`, when provided, is
 *  the live per-voice attribution to persist to the sidecar so it survives
 *  reload; omit it for callers with no attribution (LLM "reply" path). */
export async function writeFile(
  folder: AttachedFolder,
  relativePath: string,
  content: string,
  tags: string[] = [],
  signer?: Uint8Array,
  runs?: Run[],
  replyingTo?: string,
  taggedTraces?: string[],
  localOnly?: boolean,
): Promise<string> {
  await invoke<null>("write_text_file", { root: folder.path, relativePath, contents: content });
  // Under nesting (spec §3.2), resolve the leaf folder trace that owns this
  // file. A file at blog/draft.md publishes to the blog subfolder's genesis id
  // with the single-segment name 'draft.md'. For a top-level file the leaf IS
  // the root. Legacy flat folders (no folder-members) resolve to the root.
  const { leafFolderId, leafMemberName } = await resolveLeafFolder(folder.id, relativePath);
  const manifest = await fetchManifest(leafFolderId);
  const entry = manifest.find((f) => f.relativePath === leafMemberName);
  const contentHash = await sha256Hex(content);

  // Fetch the chain head once: it gives us both the prior content (to diff) and
  // the prior user tags (to detect a tag-only change). Without this, a tag-only
  // edit would hit the content-hash no-op branch and never seal.
  const chain = entry ? await fetchChain(leafFolderId, leafMemberName) : [];
  const prevContent = entry ? reconstructFromChain(chain) : "";
  const prevTags = headUserTags(chain);
  const tagsUnchanged =
    prevTags.length === tags.length && prevTags.every((t, i) => t === tags[i]);

  // The next node's q-tags = body brackets + reply source + tagged traces.
  // Compare against the prev head's citations so a pure tag-add (content and
  // topical tags both unchanged) still seals — otherwise it'd be swallowed by
  // the content-hash no-op branch.
  const prevCitations = entry ? eventMeta(chain[chain.length - 1]).citationTargets : [];
  const nextCitations = [
    ...findResolvedBrackets(content).map((b) => b.nodeId),
    ...(replyingTo ? [replyingTo] : []),
    ...(taggedTraces ?? []),
  ];
  const citationsUnchanged =
    prevCitations.length === nextCitations.length &&
    prevCitations.every((c, i) => c === nextCitations[i]);

  let nodeId: string;
  if (
    entry &&
    entry.contentHash === contentHash &&
    !entry.isDeleted &&
    tagsUnchanged &&
    citationsUnchanged
  ) {
    nodeId = entry.latestNodeId; // no-op touch
  } else {
    // Diff against the last sealed content so the node carries a real delta,
    // not a full replacement (matches the harness recordSnapshot path). When only
    // tags changed (deltas empty, content identical), still seal so the new `t`
    // tags land on the relay.
    const deltas = diffToDeltas(prevContent, content);
    if (deltas.length === 0 && entry && tagsUnchanged && citationsUnchanged) {
      nodeId = entry.latestNodeId;
    } else {
      const event = await publishEdit({
        prevEventId: entry?.latestNodeId ?? null,
        relativePath: leafMemberName,
        folderId: leafFolderId,
        deltas: deltas.length > 0 ? deltas : [{
          type: "insert",
          positionStart: 0,
          positionEnd: 0,
          newValue: content,
          timestamp: Date.now(),
        }],
        snapshot: content,
        contentHash,
        action: entry ? "edit" : "import",
        tags,
        // Per-character attribution: carry the live run list into the node's
        // `authors` field so it survives reload from the chain (the durable,
        // cross-device carrier), alongside the local .zine/attribution.json
        // sidecar (the live-edit fast path). publishEdit validates the map
        // against `snapshot` and drops it if stale.
        ...(runs && runs.length > 0 ? { authors: runs } : {}),
        // Cite every minted span this doc contains (spec:189) — one q-tag per
        // resolved `[[ phrase | nodeId ]]`. findResolvedBrackets returns the full
        // set each seal; publishEdit dedupes by nodeId.
        citations: findResolvedBrackets(content).map((b) => b.nodeId),
        ...(replyingTo ? { replyingTo } : {}),
        ...(taggedTraces && taggedTraces.length > 0 ? { taggedTraces } : {}),
        ...(signer ? { signer } : {}),
        ...(localOnly ? { localOnly: true } : {}),
      });

      await upsertManifestEntry(
        leafFolderId,
        {
          relativePath: leafMemberName,
          latestNodeId: event.id,
          isDeleted: false,
          contentHash,
        },
        signer,
      );
      nodeId = event.id;
    }
  }

  // Persist the voice layer to the sidecar (after content + provenance landed,
  // so a failed save never attributes text that didn't reach disk). Always
  // refresh — even on a no-op content seal — because the editor may have
  // re-attributed text without changing content (rare, but cheap to reflect).
  // Best-effort: a read-only folder degrades to single-run on next load.
  if (runs && runs.length > 0) {
    const map = await readAttribution(folder.path);
    map[relativePath] = runs;
    await writeAttribution(folder.path, map);
  }

  return nodeId;
}

/** Create a new file (empty) on disk + an import node. Returns its nodeId.
 *  If the file already exists on disk, just opens it (no overwrite). New files
 *  start with no user tags; the folder tag is derived from the path on seal. */
export async function createFile(folder: AttachedFolder, relativePath: string): Promise<string> {
  const existing = await invoke<string>("read_text_file", {
    root: folder.path,
    relativePath,
  }).catch(() => null);
  if (existing !== null) {
    // Already on disk — make sure it's tracked, then return its node.
    return writeFile(folder, relativePath, existing);
  }
  return writeFile(folder, relativePath, "", []);
}

/** Create a directory (including parents). Under nesting (spec §3.2), creating
 *  a subdirectory also mints a subfolder genesis trace under the parent folder,
 *  so the new folder is independently replayable and publishable. The folder-
 *  member entry is upserted into the parent's manifest. */
export async function createFolder(folder: AttachedFolder, relativePath: string): Promise<void> {
  await invoke<null>("create_folder", { root: folder.path, relativePath });
  // Resolve the parent folder trace and the new folder's member name. If the
  // path is nested (e.g. 'blog/refs'), resolve the leaf parent; otherwise the
  // parent is the root.
  const slash = relativePath.lastIndexOf("/");
  const parentDisplayPath = slash < 0 ? "" : relativePath.slice(0, slash);
  const memberName = slash < 0 ? relativePath : relativePath.slice(slash + 1);
  const parentId = parentDisplayPath
    ? (await resolveLeafFolder(folder.id, parentDisplayPath)).leafFolderId
    : folder.id;
  await createSubfolder(parentId, memberName);
  await refreshFolderMemberHash(parentId, memberName, (await fetchLatestFolderNode(folder.id))?.id ?? "");
}

/** Delete a file or folder from disk and record the provenance.
 *
 *  File: seals a `delete` node on the file's own 4290 chain, then removes the
 *  member from its leaf folder's manifest (spec-clean tombstone — no isDeleted
 *  flag; the chain retains the delete node as history).
 *
 *  Folder: removes the folder-member entry from its parent's manifest. Under
 *  nesting (spec §3.3), a folder member's name lives in the PARENT only —
 *  removing it does NOT rewrite the folder's own chain or tombstone its
 *  descendants. The folder's own genesis + membership chain (and every
 *  descendant file's chain) persist as addressable history; the folder simply
 *  leaves the parent's membership. This is the spec-clean posture: a `remove`
 *  delta on the parent, no recursive walk. (Recursive tombstoning would
 *  destroy descendant chains that a later re-attach or cross-press fork could
 *  still cite — the spec's append-only, history-retained model forbids it.) */
export async function deletePath(
  folder: AttachedFolder,
  relativePath: string,
  isFolder: boolean,
): Promise<void> {
  if (isFolder) {
    await invoke<null>("delete_folder", { root: folder.path, relativePath });
    const { leafFolderId, leafMemberName } = await resolveLeafFolder(folder.id, relativePath);
    // Remove the folder-member from the parent manifest with a `remove` delta.
    // The folder's own chain (and all descendant chains) are untouched — they
    // persist as history. No delete node is sealed on the folder's chain: a
    // folder trace isn't "deleted" as a trace, it leaves its parent's
    // membership. (markDeleted seals a delete node on a FILE's chain + removes
    // the manifest entry — wrong for a folder, which has no file chain to seal
    // a delete onto and whose identity is its genesis, not a path.)
    await removeManifestEntry(leafFolderId, leafMemberName);
  } else {
    await invoke<null>("delete_file", { root: folder.path, relativePath });
    const { leafFolderId, leafMemberName } = await resolveLeafFolder(folder.id, relativePath);
    const manifest = await fetchManifest(leafFolderId);
    const entry = manifest.find((m) => m.relativePath === leafMemberName);
    if (entry && !entry.isDeleted) await markDeleted(leafFolderId, entry);
  }
}

/** Move `src` (file or folder relative path) into `destFolder` ("" = root).
 *  Disk move first; provenance-wise a move is modeled as import-at-dest +
 *  remove-at-source.
 *
 *  File move: import at the dest leaf folder + tombstone at the source leaf
 *  folder (the file's own 4290 chain gets a delete node; the source manifest
 *  removes the member).
 *
 *  Folder move (spec §3.3): a folder member's name lives in the PARENT only,
 *  so moving a folder is O(1) at the parent — add the folder-member entry to
 *  the dest parent's manifest (preserving `kind: "folder"` + the subfolder's
 *  genesis id + contentHash), remove it from the source parent's manifest.
 *  The folder's own chain and all descendant chains are untouched — their
 *  provenance keys on the folder's permanent genesis id, not on any display
 *  path. (The slash-joined display path is reconstructed by listFiles at read
 *  time, never stored on a node.) No `read_text_file`, no file-node publish.
 *
 *  `userTagsByPath` carries each affected FILE's user tags so they survive the
 *  reparent (folder moves don't need it — folders carry no user tags). */
export async function movePath(
  folder: AttachedFolder,
  src: string,
  destFolder: string,
  isFolder: boolean,
  userTagsByPath: Record<string, string[]> = {},
): Promise<void> {
  await invoke<null>("move_path", {
    root: folder.path,
    srcRelative: src,
    destFolderRelative: destFolder,
  });

  const name = basename(src);
  const destDisplayPath = destFolder === "" ? name : `${destFolder}/${name}`;

  // Resolve leaf folders at both source and destination. Under nesting, a move
  // across directories crosses folder traces.
  const srcLeaf = await resolveLeafFolder(folder.id, src);
  const destLeaf = await resolveLeafFolder(folder.id, destDisplayPath);

  if (isFolder) {
    // Folder move (spec §3.3): reparent the folder-member entry only. Read the
    // source entry (carries kind: "folder", the subfolder genesis id, and its
    // contentHash), upsert it at the dest under the dest leaf name, then remove
    // it from the source. The subfolder's own chain + descendants are untouched.
    const srcManifest = await fetchManifest(srcLeaf.leafFolderId);
    const folderEntry = srcManifest.find((m) => m.relativePath === srcLeaf.leafMemberName);
    if (!folderEntry) return; // not tracked — baselineScan will reconcile on next attach

    if (srcLeaf.leafFolderId === destLeaf.leafFolderId) {
      // Same-parent move is a rename within the leaf folder: one `rename` delta,
      // carrying kind: "folder" + the existing genesis id (no new node).
      await renameManifestEntry(
        srcLeaf.leafFolderId,
        srcLeaf.leafMemberName,
        destLeaf.leafMemberName,
        folderEntry.latestNodeId,
      );
    } else {
      // Cross-folder move: add at dest (preserving kind + genesis + hash), then
      // remove at source. Two folder-node seals, one per parent.
      await upsertManifestEntry(destLeaf.leafFolderId, {
        kind: "folder",
        relativePath: destLeaf.leafMemberName,
        latestNodeId: folderEntry.latestNodeId,
        contentHash: folderEntry.contentHash,
      });
      await removeManifestEntry(srcLeaf.leafFolderId, srcLeaf.leafMemberName);
    }
    return;
  }

  // File move (the common case): import at dest + tombstone at source.
  const content = await invoke<string>("read_text_file", {
    root: folder.path,
    relativePath: destDisplayPath,
  }).catch(() => "");
  const contentHash = await sha256Hex(content);
  const userTags = userTagsByPath[src] ?? [];

  // Import at the destination leaf folder with the single-segment leaf name.
  const event = await publishEdit({
    prevEventId: null,
    relativePath: destLeaf.leafMemberName,
    folderId: destLeaf.leafFolderId,
    deltas: content.length > 0
      ? [{ type: "insert", positionStart: 0, positionEnd: 0, newValue: content, timestamp: Date.now() }]
      : [],
    snapshot: content,
    contentHash,
    action: "import",
    tags: userTags,
  });
  await upsertManifestEntry(destLeaf.leafFolderId, {
    relativePath: destLeaf.leafMemberName,
    latestNodeId: event.id,
    isDeleted: false,
    contentHash,
  });

  // Tombstone at the source leaf folder.
  const srcManifest = await fetchManifest(srcLeaf.leafFolderId);
  const oldEntry = srcManifest.find((m) => m.relativePath === srcLeaf.leafMemberName);
  if (oldEntry && !oldEntry.isDeleted) await markDeleted(srcLeaf.leafFolderId, oldEntry);
}

/** Rename `src` (file or folder) to `newName`, staying in the same parent.
 *  Provenance shape is a single `rename` folder delta (fromPath → toPath).
 *
 *  File rename: the file's own 4290 chain needs a node at the new path (the `F`
 *  tag is addressing), so publishEdit at the new name runs first; the folder
 *  delta then repoints the membership.
 *
 *  Folder rename (spec §3.3): "Renaming a `kind: "folder"` member changes its
 *  name in the parent only — it does not rewrite the renamed folder's own
 *  chain." So a folder rename is ONE `rename` delta on the parent manifest,
 *  carrying the folder's existing genesis id (latestNodeId) — no new node, no
 *  descendant walk. The folder's identity is its genesis, not its name.
 *
 *  `userTagsByPath` carries the file's user tags (folder renames don't need it). */
export async function renamePath(
  folder: AttachedFolder,
  src: string,
  newName: string,
  isFolder: boolean,
  userTagsByPath: Record<string, string[]> = {},
): Promise<void> {
  await invoke<null>("rename_path", {
    root: folder.path,
    srcRelative: src,
    newName,
  });

  // Resolve the leaf folder (same parent → same leaf folder for both old and new).
  const leaf = await resolveLeafFolder(folder.id, src);
  const oldName = leaf.leafMemberName;

  if (isFolder) {
    // Folder rename (spec §3.3): one `rename` delta on the parent, carrying the
    // folder's existing genesis id. renameManifestEntry preserves kind +
    // contentHash + latestNodeId (provenance.ts), repointing only the path. No
    // new node — the folder's identity (genesis id) is unchanged by a rename.
    const manifest = await fetchManifest(leaf.leafFolderId);
    const entry = manifest.find((m) => m.relativePath === oldName);
    if (!entry) return; // not tracked — baselineScan reconciles on next attach
    await renameManifestEntry(leaf.leafFolderId, oldName, newName, entry.latestNodeId);
    return;
  }

  // File rename (the common case): publish at new name + rename delta.
  const slash = src.lastIndexOf("/");
  const destDisplayPath = slash === -1 ? newName : src.slice(0, slash + 1) + newName;
  const content = await invoke<string>("read_text_file", {
    root: folder.path,
    relativePath: destDisplayPath,
  }).catch(() => "");
  const contentHash = await sha256Hex(content);
  const userTags = userTagsByPath[src] ?? [];

  const event = await publishEdit({
    prevEventId: null,
    relativePath: newName,
    folderId: leaf.leafFolderId,
    deltas: content.length > 0
      ? [{ type: "insert", positionStart: 0, positionEnd: 0, newValue: content, timestamp: Date.now() }]
      : [],
    snapshot: content,
    contentHash,
    action: "import",
    tags: userTags,
  });
  // One `rename` folder delta: fromPath → toPath, pointing at the new node.
  await renameManifestEntry(leaf.leafFolderId, oldName, newName, event.id);
}

// --- internal helpers ---------------------------------------------------

async function sealImport(
  folderId: string,
  relativePath: string,
  content: string,
  contentHash: string,
  prevEventId: string | null,
  userTags: string[],
) {
  const event = await publishEdit({
    prevEventId,
    relativePath,
    folderId,
    deltas: content.length > 0
      ? [{ type: "insert", positionStart: 0, positionEnd: 0, newValue: content, timestamp: Date.now() }]
      : [],
    snapshot: content,
    contentHash,
    action: prevEventId ? "edit" : "import",
    tags: userTags,
  });
  await upsertManifestEntry(folderId, {
    relativePath,
    latestNodeId: event.id,
    isDeleted: false,
    contentHash,
  });
  return event;
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
  // Spec-clean tombstone: drop the member from the folder snapshot via a
  // `remove` delta, rather than leaving it as an isDeleted entry. The file's
  // own 4290 chain retains the delete node as history.
  await removeManifestEntry(folderId, entry.relativePath);
}

function basename(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
}

// Re-export for App.tsx's typing convenience.
export type { AttachedFolder };

// --- Workspace factory (disk backend) ------------------------------------
//
// Binds the standalone functions above into the backend-neutral `Workspace`
// interface, closing over the attached folder so mutation call sites in
// App.tsx can drop the `folder` argument. Disk remains the desktop's private
// mirror; the relay is the sync target via publishToMany (provenance.ts).

/**
 * Create a disk-backed workspace (desktop / Tauri only). The returned object
 * starts unattached; call `attach()` to bind a folder and baseline-scan it.
 */
export function createDiskWorkspace(): Workspace & { detach(): void } {
  let folder: AttachedFolder | null = null;

  function requireFolder(): AttachedFolder {
    if (!folder) {
      throw new Error("workspace not attached — call attach() first");
    }
    return folder;
  }

  return {
    get ref(): FolderRef | null {
      return folder ? { id: folder.id, path: folder.path, label: folder.label } : null;
    },

    async attach(ref: FolderRef): Promise<AttachResult> {
      if (!ref.path) {
        throw new Error("disk workspace requires a FolderRef with a path");
      }
      // Reuse an existing folderId if this path was attached before — its
      // provenance chain is keyed on the id, so a new id would orphan it.
      const existing = loadAttachedFolder();
      const id = existing && existing.path === ref.path ? existing.id : ref.id;
      const attached: AttachedFolder = { id, path: ref.path, label: ref.label };
      saveAttachedFolder(attached);
      folder = attached;
      const files = await baselineScan(attached);
      return { files };
    },

    /** Forget the attached folder (provenance records stay in the relay). */
    detach(): void {
      clearAttachedFolder();
      folder = null;
    },

    async readFile(relativePath: string): Promise<string> {
      const f = requireFolder();
      return invoke<string>("read_text_file", { root: f.path, relativePath });
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
      return writeFile(requireFolder(), relativePath, content, tags, signer, runs, replyingTo, taggedTraces, localOnly);
    },

    async createFile(relativePath: string): Promise<string> {
      return createFile(requireFolder(), relativePath);
    },

    async createFolder(relativePath: string): Promise<void> {
      return createFolder(requireFolder(), relativePath);
    },

    async deletePath(relativePath: string, isFolder: boolean): Promise<void> {
      return deletePath(requireFolder(), relativePath, isFolder);
    },

    async movePath(src, destFolder, isFolder, tagsByPath = {}): Promise<void> {
      return movePath(requireFolder(), src, destFolder, isFolder, tagsByPath);
    },

    async renamePath(src, newName, isFolder, tagsByPath = {}): Promise<void> {
      return renamePath(requireFolder(), src, newName, isFolder, tagsByPath);
    },

    async readFolderTags(): Promise<Record<string, string[]>> {
      return readFolderTagsFile(requireFolder().path);
    },

    async writeFolderTags(tags: Record<string, string[]>): Promise<void> {
      return writeFolderTagsFile(requireFolder().path, tags);
    },
  };
}

/**
 * The workspace service: ties a real folder on disk to its nostr provenance
 * records in the local relay. This is the single surface the UI calls; it
 * never lets disk and the relay drift — every mutation writes to disk AND
 * steps a kind-4290 node AND republishes the kind-34290 manifest.
 *
 * Disk is the source of truth for *what exists*; the relay is the source of
 * truth for *how it got there*. On open, `baselineScan` reconciles the two:
 * files new on disk get imported, files gone from disk get marked deleted,
 * changed files get an edit node. The reconcile postures follow the protocol
 * (trace-provenance.md), so the same folder is interoperable across any
 * conforming press.
 *
 * All disk access goes through Tauri commands that resolve relative paths
 * against the attached folder root inside Rust and reject escapes — the
 * webview never touches an absolute path or a file outside the folder.
 */

import type { AttachedFolder } from "./registry.js";
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
  resolveTraceIdentity,
  reconstructFromChain,
  reconstructRunsFromChain,
  removeManifestEntry,
  renameManifestEntry,
  upsertManifestEntry,
  type EventMeta,
  type KEdit,
  type ManifestFileEntry,
  type SampleEventMeta,
} from "./provenance.js";
import { findAddedInlineCitations, findResolvedBrackets } from "./brackets.js";
import { authorVoice } from "./keys-store.js";
import { getReconcilerVoice } from "./external-voice-store.js";
import type { Event } from "nostr-tools";
import type {
  FileState,
  Run,
} from "./workspace-core.js";
import { ensureMdExt, flattenRuns } from "./workspace-core.js";

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
  // The editor attributes all baseline/reconstructed content to the AUTHOR
  // voice as a single run. Finer-grained voice attribution happens through
  // subsequent edits, which splice in the editing voice. Resolves to the
  // AUTHOR key's pubkey so the run renders under that key's identity; the
  // old "author-1" string-literal was a label, not a pubkey, and fell into the
  // decoration's hash-bucket fallback (wrong color) — see keys-store.ts
  // authorVoice() and buildVoiceDecorations in App.tsx.
  return text.length === 0 ? [] : [{ voice: authorVoice(), text }];
}

// --- attribution sidecar ------------------------------------------------
//
// Per-line voice attribution (the editor's run list) is persisted to a JSON
// sidecar at `.zine/attribution.json` inside the folder, keyed by relative
// path. The content file itself stays plain text (preserving git /
// other-editor interop); the sidecar is the desktop's private mirror of
// the voice layer. `.zine` is in IGNORED_SEGMENTS so the walker never treats
// the sidecar as a content file.
//
// This is deliberately best-effort and never fatal: a read-only folder, a
// corrupt sidecar, or a missing sidecar all degrade to the single-run
// baseline (what the editor did before this existed). The relay carries no
// runs, so cross-device sync still collapses to one run — an accepted boundary
// matching the protocol doc's current scope.
const ATTRIBUTION_SIDECAR = ".zine/attribution.json";

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

// --- attach + baseline --------------------------------------------------

/** Show a native folder picker and return the chosen absolute path, or null
 *  if the user cancelled. Also used by the empty-state "choose folder" UI. */
export async function chooseFolder(): Promise<string | null> {
  return invoke<string | null>("pick_folder");
}

/** Show a native single-file picker and return the chosen absolute path, or
 *  null if the user cancelled. Used by the Scan op. Mirrors chooseFolder. */
export async function chooseFile(): Promise<string | null> {
  return invoke<string | null>("pick_file");
}

/** A foreign snapshot acquired from a substrate: each scanned file as
 *  (relativePath, content). For a single file, one entry named after it; for
 *  a folder, one entry per file under it, relative to the picked folder. */
export interface ScannedFile {
  relativePath: string;
  content: string;
}

/** Read an external file or folder at an absolute path the user explicitly
 *  picked. Unlike read_text_file/list_dir this reads OUTSIDE the attached root
 *  — that's the whole point of scan (acquire a foreign snapshot from a
 *  substrate). Desktop-only (no substrate on the webapp). */
export async function scanExternal(absPath: string): Promise<ScannedFile[]> {
  return invoke<ScannedFile[]>("scan_external", { absPath });
}

/** Reify (emit) a set of traces out to a picked destination folder on disk —
 *  the emission instant, the inverse of scan. Each trace's content (reconstructed
 *  from the in-memory runs the app holds) is written to `destRoot` under its
 *  relative path, reusing write_text_file with the destination as root (the
 *  containment check passes naturally). Desktop-only.
 *
 *  The trace lives in the app; reify serializes it to a substrate at an instant.
 *  It does not unmount or detach anything — the app keeps its trace. A reify is
 *  idempotent in content (same bytes → same files) and additive in the
 *  destination (existing files there are overwritten with the trace's content,
 *  which is the point of emission: make this disk folder match the trace). */
export async function reifyToDisk(
  destRoot: string,
  entries: { relativePath: string; content: string }[],
): Promise<void> {
  for (const { relativePath, content } of entries) {
    await invoke<null>("write_text_file", { root: destRoot, relativePath, contents: content });
  }
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
 *  current head (advances on every step), but the identity that file nodes
 *  carry on their `f`/`D` tags is the genesis. Reads the node by id, returns
 *  its `f` tag; for a genesis node (no `f` tag) the input is returned as-is. */
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
 *  leaf member name. For a top-level file the leaf folder IS the root. */
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
 *  upserts the parent's entry. One folder-node read + one parent re-step. */
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

/** Group the flat list_dir output by directory. Each directory becomes a level
 *  in the nesting tree: its immediate file children publish to its folder id,
 *  its subdirectories recurse as folder-members. Shared by the skeleton and the
 *  reconcile passes so they see the same tree.
 *  e.g. "blog/draft.md" → dir="blog", name="draft.md", isDir=false
 *       "blog"           → dir="",     name="blog",    isDir=true
 */
interface DiskChild { name: string; isDir: boolean; }
function groupByDir(diskEntries: DirEntry[]): Map<string, DiskChild[]> {
  const childrenByDir = new Map<string, DiskChild[]>();
  for (const e of diskEntries) {
    const rp = e.relative_path;
    const slash = rp.lastIndexOf("/");
    const dir = slash < 0 ? "" : rp.slice(0, slash);
    const name = slash < 0 ? rp : rp.slice(slash + 1);
    if (!childrenByDir.has(dir)) childrenByDir.set(dir, []);
    childrenByDir.get(dir)!.push({ name, isDir: e.is_dir });
  }
  return childrenByDir;
}

/**
 * Fast skeleton pass: render the folder from the RELAY ONLY (manifest + chains),
 * with zero disk reads. This is what the editor actually displays on the
 * unchanged-file path anyway — `reconstructFromChain` is the authoritative
 * content, and the disk read in `reconcileScan` exists purely to detect drift.
 * So we skip the disk entirely here and let the drift scan happen in the
 * background.
 *
 * Cost: one fetchManifest per directory level + one fetchChain per file — all
 * relay reads, no file I/O. This is the boot critical path; `reconcileScan`
 * runs after it to step import/edit/delete nodes for any disk drift.
 *
 * Files missing from the manifest (brand-new on disk, never stepped) are
 * invisible here — they appear when the background reconcile imports them.
 */
export async function skeletonScan(folder: AttachedFolder): Promise<Record<string, FileState>> {
  const files: Record<string, FileState> = {};

  async function walk(folderId: string, dirPrefix: string): Promise<void> {
    const manifest = await fetchManifest(folderId);
    for (const entry of manifest) {
      const childDisplayPath = dirPrefix ? `${dirPrefix}/${entry.relativePath}` : entry.relativePath;
      if (entry.kind === "folder") {
        // Subfolder: record the placeholder and recurse into its manifest.
        files[childDisplayPath] = { kind: "folder", runs: [], nodeId: entry.latestNodeId, tags: [] };
        await walk(entry.latestNodeId, childDisplayPath);
        continue;
      }
      // File: reconstruct content + attribution straight from the chain. This is
      // the same path reconcileScan takes for an unchanged file — the chain is
      // the source of truth for what the editor shows.
      const chain = await fetchChain(folderId, entry.relativePath);
      const content = chain.length > 0 ? reconstructFromChain(chain) : "";
      const runs = chain.length > 0 ? reconstructRunsFromChain(chain) : runsFromText(content);
      const taggedTraces = headTaggedTraces(
        chain,
        findResolvedBrackets(content).map((b) => b.nodeId),
      );
      files[childDisplayPath] = {
        runs,
        nodeId: entry.latestNodeId,
        ...(chain[0]?.id ? { traceId: chain[0].id } : {}),
        tags: headUserTags(chain),
        ...(taggedTraces.length > 0 ? { taggedTraces } : {}),
      };
    }
  }

  await walk(folder.id, "");
  return files;
}

/**
 * Reconcile the folder on disk with the relay's manifest, stepping nodes for
 * any drift. The reconcile flow (same as the pre-split baselineScan):
 *
 * - file on disk, unknown to manifest → step an `import` node, upsert entry.
 * - file on disk, in manifest, content hash unchanged → no node; reconstruct
 *   content from the chain for the editor.
 * - file on disk, in manifest, content changed since last node → step an
 *   `edit` node (disk is source of truth), upsert entry.
 * - file in manifest, missing from disk → step a `delete` node, mark deleted.
 *
 * The hash check keeps the reconcile idempotent: opening the app a second time
 * doesn't republish everything, only what actually changed.
 *
 * Two modes:
 * - `onReconciled` omitted → runs to completion and returns the fully-
 *   reconciled map (back-compat for callers that need the whole result).
 * - `onReconciled` provided → emits each reconciled FileState via the callback
 *   and returns an empty map. The caller merges results incrementally; this is
 *   the background path so the press can render from the skeleton first.
 */
export async function reconcileScan(
  folder: AttachedFolder,
  onReconciled?: (path: string, file: FileState | null) => void,
): Promise<Record<string, FileState>> {
  const diskEntries = await invoke<DirEntry[]>("list_dir", { root: folder.path });
  // Voice attribution lives in the sidecar (one read for the whole folder).
  // Validated per-file against content below: external edits invalidate stale
  // attribution, which falls back to a single run.
  const attribution = await readAttribution(folder.path);
  // Disk drift detected here means a process other than the traced editor moved
  // the machine's state. Such nodes step under the reconciler voice — a distinct
  // per-machine key — never the authoring key, so the authoring key only ever
  // signs changes the editor's own transactions produced (§3.4 `external`, §8).
  const reconciler = getReconcilerVoice();
  const childrenByDir = groupByDir(diskEntries);

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

  const files: Record<string, FileState> = {};
  const emit = (path: string, file: FileState | null) => {
    if (onReconciled) onReconciled(path, file);
    else if (file) files[path] = file;
  };

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
        emit(childDisplayPath, { kind: "folder", runs: [], nodeId: subFolderId, tags: [] });
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
        // New on disk, unknown to the relay: import it. Signed by the
        // reconciler voice — the file appeared from outside the traced editor,
        // so its genesis is honestly attributed to that voice, not the authoring
        // key. `action: "import"` stays: a brand-new file's first node is
        // genuinely a genesis; the signer is the honest part. (§8)
        const event = await stepImport(
          folderId,
          memberName,
          content,
          contentHash,
          null,
          [],
          { signer: reconciler.secretKey },
        );
        emit(childDisplayPath, {
          runs: runsFor(childDisplayPath, content),
          nodeId: event.id,
          traceId: event.id,
          tags: [],
        });
        manifestByName.delete(memberName);
        manifestByName.delete(childDisplayPath);
        continue;
      }

      if (entry.contentHash === contentHash) {
        // Unchanged since last step. On the background path the skeleton already
        // rendered this exact state from the chain, so skip the re-emit (the
        // merge would be a no-op anyway). On the inline path we still need it —
        // no skeleton ran, so this is the first time the caller sees the file.
        if (!onReconciled) {
          const chain = await fetchChain(folderId, memberName);
          const reconstructed = chain.length > 0 ? reconstructFromChain(chain) : content;
          const taggedTraces = headTaggedTraces(
            chain,
            findResolvedBrackets(reconstructed).map((b) => b.nodeId),
          );
          emit(childDisplayPath, {
            runs: runsFor(childDisplayPath, reconstructed, chain),
            nodeId: entry.latestNodeId,
            ...(chain[0]?.id ? { traceId: chain[0].id } : {}),
            tags: headUserTags(chain),
            ...(taggedTraces.length > 0 ? { taggedTraces } : {}),
          });
        }
        manifestByName.delete(memberName);
        manifestByName.delete(childDisplayPath);
        continue;
      }

      // Changed on disk (or was marked deleted and reappeared): step an edit.
      // The change came from outside the traced editor, so it steps as
      // `action: "external"` under the reconciler voice — not the authoring key
      // (§3.4, §8). `authors` is omitted on this path, so reconstruction
      // attributes the bytes to the reconciler's pubkey (Tier-2 signer
      // attribution) rather than the human's voice.
      const priorChain = await fetchChain(folderId, memberName);
      const priorUserTags = headUserTags(priorChain);
      const event = await stepImport(
        folderId,
        memberName,
        content,
        contentHash,
        entry.latestNodeId,
        priorUserTags,
        {
          signer: reconciler.secretKey,
          action: "external",
          ...(priorChain[0]?.id ? { traceId: priorChain[0].id } : {}),
        },
      );
      emit(childDisplayPath, {
        runs: runsFor(childDisplayPath, content),
        nodeId: event.id,
        ...(priorChain[0]?.id ? { traceId: priorChain[0].id } : {}),
        tags: priorUserTags,
      });
      manifestByName.delete(memberName);
      manifestByName.delete(childDisplayPath);
    }

    // Anything left in this folder's manifest has no file on disk → mark deleted.
    // Skip folder-members (they're handled by the recursion, not by disk files).
    for (const [name, entry] of manifestByName) {
      if (entry.kind === "folder") continue; // subfolder — not a missing file
      await markDeleted(folderId, entry);
      // On the background path the skeleton still shows this file (it came from
      // the manifest); signal the caller to drop it from the tree.
      const childDisplayPath = dirPrefix ? `${dirPrefix}/${name}` : name;
      emit(childDisplayPath, null);
    }
  }

  await scanDir("", folder.id);
  return files;
}

// --- mutations ----------------------------------------------------------
//
// Each mutation writes to disk first (source of truth), then steps a node
// and updates the manifest. If the disk write fails, we don't touch the
// relay — provenance only records what actually landed on disk.

/** Persist `content` to disk and step an edit/import node for it. Called by
 *  the debounced save path (Cmd-S or 1.5s idle) in the editor. No-op only when
 *  BOTH the content hash and the user tags match the last stepped node — a
 *  tag-only change still steps, so tag edits reach the relay. Returns the new
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
  kedits?: KEdit[],
  localOnly?: boolean,
  force?: boolean,
): Promise<string> {
  relativePath = ensureMdExt(relativePath);
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
  // edit would hit the content-hash no-op branch and never step.
  const chain = entry ? await fetchChain(leafFolderId, leafMemberName) : [];
  const prevContent = entry ? reconstructFromChain(chain) : "";
  const prevTags = headUserTags(chain);
  const tagsUnchanged =
    prevTags.length === tags.length && prevTags.every((t, i) => t === tags[i]);

  // The next node's q-tags = body brackets + reply source + tagged traces.
  // Compare against the prev head's citations so a pure tag-add (content and
  // topical tags both unchanged) still steps — otherwise it'd be swallowed by
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
    tagsUnchanged &&
    citationsUnchanged &&
    !force
  ) {
    nodeId = entry.latestNodeId; // no-op touch
  } else {
    // Diff against the last stepped content so the node carries a real delta,
    // not a full replacement. When only tags changed (deltas empty, content
    // identical), still step so the new `t` tags land on the relay.
    const deltas = diffToDeltas(prevContent, content);
    if (deltas.length === 0 && entry && tagsUnchanged && citationsUnchanged && !force) {
      nodeId = entry.latestNodeId;
    } else {
      const event = await publishEdit({
        prevEventId: entry?.latestNodeId ?? null,
        ...(chain[0]?.id ? { traceId: chain[0].id } : {}),
        relativePath: leafMemberName,
        folderId: leafFolderId,
        // A forced checkpoint with no content change mints a clean `deltas: []`
        // node — the rhythm-layer gesture (§8: "saves are steps"). The
        // synthesized-insert fallback below is for the tag/citation-only step
        // (where content is identical but metadata changed), not for a forced
        // no-op step; a checkpoint that claims the whole body was just
        // inserted would misrepresent the edit rhythm.
        deltas: deltas.length > 0
          ? deltas
          : force
            ? []
            : [{
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
        // set each step; publishEdit dedupes by nodeId.
        citations: findResolvedBrackets(content).map((b) => b.nodeId),
        inlineCitations: findAddedInlineCitations(prevContent, content),
        ...(replyingTo ? { replyingTo } : {}),
        ...(taggedTraces && taggedTraces.length > 0 ? { taggedTraces } : {}),
        ...(kedits && kedits.length > 0 ? { kedits } : {}),
        ...(signer ? { signer } : {}),
        ...(localOnly ? { localOnly: true } : {}),
      });

      await upsertManifestEntry(
        leafFolderId,
        {
          kind: "file",
          relativePath: leafMemberName,
          latestNodeId: event.id,
          contentHash,
        },
        signer,
      );
      nodeId = event.id;
    }
  }

  // Persist the voice layer to the sidecar (after content + provenance landed,
  // so a failed save never attributes text that didn't reach disk). Always
  // refresh — even on a no-op content step — because the editor may have
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
 *  start with no user tags; the folder tag is derived from the path on step. */
export async function createFile(folder: AttachedFolder, relativePath: string): Promise<string> {
  relativePath = ensureMdExt(relativePath);
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
 *  File: steps a `delete` node on the file's own 4290 chain, then removes the
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
    // persist as history. No delete node is stepped on the folder's chain: a
    // folder trace isn't "deleted" as a trace, it leaves its parent's
    // membership. (markDeleted steps a delete node on a FILE's chain + removes
    // the manifest entry — wrong for a folder, which has no file chain to step
    // a delete onto and whose identity is its genesis, not a path.)
    await removeManifestEntry(leafFolderId, leafMemberName);
  } else {
    await invoke<null>("delete_file", { root: folder.path, relativePath });
    const { leafFolderId, leafMemberName } = await resolveLeafFolder(folder.id, relativePath);
    const manifest = await fetchManifest(leafFolderId);
    const entry = manifest.find((m) => m.relativePath === leafMemberName);
    if (entry) await markDeleted(leafFolderId, entry);
  }
}

/** Move `src` (file or folder relative path) into `destFolder` ("" = root).
 *  Disk move first; provenance-wise a file move extends the same trace at the
 *  destination address and updates folder membership.
 *
 *  File move: one new node with `prev` on the existing trace, then a same-parent
 *  rename delta or cross-parent add/remove membership pair. No replacement
 *  genesis and no source tombstone.
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
      // remove at source. Two folder-node steps, one per parent.
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

  // File move: extend the SAME trace at its destination coordinate. Path is
  // structural addressing; identity remains the genesis event id.
  const srcManifest = await fetchManifest(srcLeaf.leafFolderId);
  const oldEntry = srcManifest.find((m) => m.relativePath === srcLeaf.leafMemberName);
  if (!oldEntry) return; // not tracked — reconcile will import it later
  const sourceChain = await fetchChain(srcLeaf.leafFolderId, srcLeaf.leafMemberName);
  const traceId = sourceChain[0]?.id ?? await resolveTraceIdentity(oldEntry.latestNodeId);
  const content = await invoke<string>("read_text_file", {
    root: folder.path,
    relativePath: destDisplayPath,
  }).catch(() => "");
  const contentHash = await sha256Hex(content);
  const userTags = userTagsByPath[src] ?? [];

  // Extend at the destination leaf folder with the single-segment leaf name.
  const event = await publishEdit({
    prevEventId: oldEntry.latestNodeId,
    ...(traceId ? { traceId } : {}),
    relativePath: destLeaf.leafMemberName,
    folderId: destLeaf.leafFolderId,
    deltas: content.length > 0
      ? [{ type: "insert", positionStart: 0, positionEnd: 0, newValue: content, timestamp: Date.now() }]
      : [],
    snapshot: content,
    contentHash,
    action: "edit",
    tags: userTags,
  });
  if (srcLeaf.leafFolderId === destLeaf.leafFolderId) {
    await renameManifestEntry(
      srcLeaf.leafFolderId,
      srcLeaf.leafMemberName,
      destLeaf.leafMemberName,
      event.id,
    );
  } else {
    await upsertManifestEntry(destLeaf.leafFolderId, {
      kind: "file",
      relativePath: destLeaf.leafMemberName,
      latestNodeId: event.id,
      contentHash,
    });
    await removeManifestEntry(srcLeaf.leafFolderId, srcLeaf.leafMemberName);
  }
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

  // File rename: publish a new node on the same trace, then move the folder
  // member address with one rename delta.
  const slash = src.lastIndexOf("/");
  const destDisplayPath = slash === -1 ? newName : src.slice(0, slash + 1) + newName;
  const content = await invoke<string>("read_text_file", {
    root: folder.path,
    relativePath: destDisplayPath,
  }).catch(() => "");
  const contentHash = await sha256Hex(content);
  const userTags = userTagsByPath[src] ?? [];
  const manifest = await fetchManifest(leaf.leafFolderId);
  const oldEntry = manifest.find((entry) => entry.relativePath === oldName);
  if (!oldEntry) return;
  const chain = await fetchChain(leaf.leafFolderId, oldName);
  const traceId = chain[0]?.id ?? await resolveTraceIdentity(oldEntry.latestNodeId);

  const event = await publishEdit({
    prevEventId: oldEntry.latestNodeId,
    ...(traceId ? { traceId } : {}),
    relativePath: newName,
    folderId: leaf.leafFolderId,
    deltas: content.length > 0
      ? [{ type: "insert", positionStart: 0, positionEnd: 0, newValue: content, timestamp: Date.now() }]
      : [],
    snapshot: content,
    contentHash,
    action: "edit",
    tags: userTags,
  });
  // One `rename` folder delta: fromPath → toPath, pointing at the new node.
  await renameManifestEntry(leaf.leafFolderId, oldName, newName, event.id);
}

// --- internal helpers ---------------------------------------------------

async function stepImport(
  folderId: string,
  relativePath: string,
  content: string,
  contentHash: string,
  prevEventId: string | null,
  userTags: string[],
  opts?: { signer?: Uint8Array; action?: string; traceId?: string },
) {
  const event = await publishEdit({
    prevEventId,
    ...(opts?.traceId ? { traceId: opts.traceId } : {}),
    relativePath,
    folderId,
    deltas: content.length > 0
      ? [{ type: "insert", positionStart: 0, positionEnd: 0, newValue: content, timestamp: Date.now() }]
      : [],
    snapshot: content,
    contentHash,
    // An explicit action (e.g. "external" for disk drift reconciled under the
    // reconciler voice) overrides the import/edit default. §3.4 / §8.
    action: opts?.action ?? (prevEventId ? "edit" : "import"),
    tags: userTags,
    signer: opts?.signer,
  });
  await upsertManifestEntry(folderId, {
    kind: "file",
    relativePath,
    latestNodeId: event.id,
    contentHash,
  });
  return event;
}

async function markDeleted(folderId: string, entry: ManifestFileEntry): Promise<void> {
  const traceId = await resolveTraceIdentity(entry.latestNodeId);
  await publishEdit({
    prevEventId: entry.latestNodeId,
    ...(traceId ? { traceId } : {}),
    relativePath: entry.relativePath,
    folderId,
    deltas: [],
    snapshot: "", // delete has no content snapshot
    contentHash: await sha256Hex(""),
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

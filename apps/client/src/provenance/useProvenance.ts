import { useEffect, useMemo, useRef, type MutableRefObject } from "react";
import { RefCountedStepGate } from "../editor/ref-counted-step-gate.js";
import { isTauri } from "../identity/identity.js";
import {
  flushRendezvousPublicationOutbox,
  resolveTraceIdentity,
  setPendingLlmMeta,
  type LlmStepMeta,
} from "./provenance.js";
import type { EditorTransaction } from "@zine/protocol";
import {
  isMintPath as isMint,
  isOblivionPath as isOblivion,
  isScanPath as isScan,
} from "../workspace/generated-paths.js";
import { clearPadPath, loadLocalFolder, mirrorPad } from "../workspace/local-store.js";
import { resolvePostWriteTraceId } from "../workspace/stepped-file-identity.js";
import {
  dropEditorTransactionLogPrefix,
  EMPTY_EDITOR_TRANSACTION_LOG,
  fileHasUnsteppedChanges,
  flattenRuns,
  editorTransactionLogToArray,
  type FileStepBaseline,
} from "../workspace/workspace-core.js";
import {
  type AttachedFolder,
  type FileState,
  type Run,
} from "../workspace/workspace.js";

// --- provenance hook: editor → disk → relay ----------------------------
//
// On mount, asks Tauri to spawn the relay sidecar (no-op outside Tauri, e.g.
// plain `npm run dev` in a browser). Ordinary edits and MODEL results debounce
// only into the crash pad. Step/Send are the sole paths that write and publish
// a kind-4290 checkpoint; the diff/state bookkeeping lives in workspace.ts.

export function useProvenance(
  folder: AttachedFolder | null,
  files: Record<string, FileState>,
  replayActiveRef: MutableRefObject<boolean>,
) {
  const liveFilesRef = useRef(files);
  liveFilesRef.current = files;
  const pendingTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  // Paths with a debounce step in flight. The external-change rescan reads
  // this to avoid clobbering a file the user is mid-edit on — their in-editor
  // content is newer than disk, so the pending step must win, not the rescan.
  const pendingPaths = useRef<Set<string>>(new Set());
  // MODEL-operation crash-pad gate. App applies a buffered result in one editor
  // transaction; the gate holds that render until endOp can attach the pending
  // provenance metadata and mirror the complete unstepped result once.
  const stepSuppressionGate = useRef(new RefCountedStepGate<Uint8Array, LlmStepMeta>());
  const pendingStepPaths = useRef<Set<string>>(new Set());
  // The AUTHOR-key resolver is retained for explicit Step ownership. It is
  // read at gesture time so a role switch never changes a captured operation.
  const authorSignerRef = useRef<(() => Uint8Array | undefined)>(() => undefined);
  // Content-stable dedup for stepFile: the last (content, tags) actually stepped
  // per path, so a no-change non-forced write short-circuits before the relay.
  const lastSteppedRef = useRef<Map<string, FileStepBaseline>>(new Map());
  // Step-on-mount hydration flag: once workspace attach has populated `files`,
  // we don't want the first render's debounce effect to re-publish content
  // that attach already loaded as current. Cleared by the boot effect in App().
  const ready = useRef(false);

  // App mounts only after SecurityBootstrap has activated the selected vault
  // and started its relay. Start the optional Coins rendezvous runtime at that
  // point, then retry the install-local publication outbox on boot/online.
  // Relay startup itself stays exclusively owned by the vault transaction.
  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    const flushRendezvous = () => {
      void flushRendezvousPublicationOutbox().catch((e: unknown) => {
        if (!cancelled) console.warn("[rendezvous] indexing outbox retry failed:", e);
      });
    };
    import("../networking/kademlia.js")
      .then(({ ensureKademliaStarted }) => ensureKademliaStarted())
      .then(() => {
        if (!cancelled) flushRendezvous();
      })
      .catch((e: unknown) => {
        if (!cancelled) console.warn("[rendezvous] Kademlia startup failed:", e);
      });
    window.addEventListener("online", flushRendezvous);
    return () => {
      cancelled = true;
      window.removeEventListener("online", flushRendezvous);
    };
  }, []);
  // Debounced crash-pad refresh for metadata and belt-and-suspenders recovery.
  // Content plus EditorTransactions are journaled synchronously in editFile at transaction
  // time; this pass catches non-editor state changes such as tags.
  useEffect(() => {
    if (!ready.current || !folder) return;
    // Hold the MODEL transaction until its completion metadata is ready. Only
    // genuinely unstepped paths are remembered; unrelated file renders never
    // enter the operation's release set.
    if (stepSuppressionGate.current.suppressed) {
      for (const path of unsteppedPaths(files)) pendingStepPaths.current.add(path);
      return;
    }
    const unstepped = unsteppedPaths(files);
    // No implicit steps, ever. Typing NEVER steps on either platform — both
    // mirror unstepped buffers to the localStorage crash pad only (no step, no
    // relay). The buffer survives a crash/refresh (restored from the pad on the
    // next boot) but the timeline doesn't advance until a deliberate gesture:
    // Step/Send (file) or add/remove/rename (folder). This generalizes the
    // desktop contract ("typing never writes the disk file") to the webapp.
    for (const path of unstepped) schedulePad(path, 800);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files, folder]);

  /** Refresh an unstepped file's full crash-pad record after `ms` of quiet.
   * Typing itself is already journaled synchronously by editFile; this never
   * calls stepFile, so neither path creates an implicit Step. */
  function schedulePad(path: string, ms: number) {
    clearTimeout(pendingTimers.current[path]);
    pendingPaths.current.add(path);
    pendingTimers.current[path] = setTimeout(() => {
      pendingPaths.current.delete(path);
      const f = files[path];
      if (!f || !folder) return;
      mirrorPad(folder.id, path, {
        content: flattenRuns(f.runs),
        tags: f.tags,
        nodeId: f.nodeId,
        traceId: f.traceId,
        runs: f.runs,
        citationIds: f.citationIds,
        editorTransactions: editorTransactionLogToArray(f.editorTransactions),
      });
    }, ms);
  }

  /** Paths whose content or tags differ from what was last stepped (or that have
   *  never been stepped this session). The debounce effect and the suppression
   *  buffer both consult this so only genuinely-changed files get stepped — the
   *  root fix for the relay rate-limit fanout where one edit re-stepped every
   *  file in the folder. */
  function unsteppedPaths(currentFiles: Record<string, FileState>): string[] {
    const out: string[] = [];
    for (const [path, file] of Object.entries(currentFiles)) {
      if (isMint(path) || isScan(path) || isOblivion(path)) continue;
      const last = lastSteppedRef.current.get(path);
      if (fileHasUnsteppedChanges(file, last)) out.push(path);
    }
    return out;
  }

  /** Gate crash-pad observation around one atomic MODEL apply. Release mirrors
   * the completed buffer and stores metadata for a later explicit Step. */
  function suppressStep(
    on: boolean,
    signer?: Uint8Array,
    path?: string,
    llmMeta?: LlmStepMeta | null,
  ) {
    if (on) {
      stepSuppressionGate.current.begin();
      return;
    }
    const releases = stepSuppressionGate.current.release(path, signer, llmMeta);
    if (!releases) return;
    // Snapshot the paths before another operation can begin.
    const paths = [...pendingStepPaths.current];
    pendingStepPaths.current.clear();
    for (const p of paths) {
      const release = releases.get(p);
      const pathLlmMeta = release?.meta;
      // MODEL output is always an unstepped local buffer. Preserve it in the
      // crash pad on desktop and web, but never publish implicitly; the next
      // explicit Step consumes the pending provenance metadata.
      const f = files[p];
      if (f && folder) {
        if (pathLlmMeta) setPendingLlmMeta(p, pathLlmMeta);
        mirrorPad(folder.id, p, {
          content: flattenRuns(f.runs),
          tags: f.tags,
          nodeId: f.nodeId,
          traceId: f.traceId,
          runs: f.runs,
          citationIds: f.citationIds,
          editorTransactions: editorTransactionLogToArray(f.editorTransactions),
        });
      }
    }
  }

  async function stepFile(
    path: string,
    signer?: Uint8Array,
    localOnly?: boolean,
    force?: boolean,
    operationId?: string,
  ): Promise<string | undefined> {
    if (!folder) return;
    // Private system entries are immutable in place. Mint and Scan become
    // editable only through a lineage-preserving fork into Root; Oblivion must
    // be restored before authoring.
    if (isMint(path) || isScan(path) || isOblivion(path)) {
      console.warn("step blocked: Mint, Scan, and Oblivion are read-only");
      return;
    }
    // Belt-and-suspenders: never step while replay is parked on a historical
    // step. That step's file is frozen with reconstructed content via a
    // setRunsEffect-tagged run (which liftRuns exempts, so editFile/debounce
    // never fire), but an explicit Cmd+S would otherwise step that frozen
    // content as a new node — polluting the trace. On `last` the editor is
    // live, so this ref is false and steps flow (the follow effect appends the
    // new step as a step and advances the bar to the new last).
    if (replayActiveRef.current) return;
    const file = files[path];
    if (!file) return;
    // Content-stable dedup: skip when nothing has changed since the last step
    // for this path. Explicit checkpoints may use `force` because choosing a
    // checkpoint is itself process evidence even when the body is unchanged.
    //
    // `force` bypasses this after the palette has authorized an explicit Step.
    // Explicit Step remains available on a current trace because the chosen
    // checkpoint is itself process evidence; force prevents that gesture from
    // being swallowed by this baseline dedup.
    if (!force) {
      const content = flattenRuns(file.runs);
      const tags = file.tags;
      const citationIds = file.citationIds ?? [];
      const last = lastSteppedRef.current.get(path);
      if (
        last &&
        last.content === content &&
        last.tags.length === tags.length &&
        last.tags.every((t, i) => t === tags[i]) &&
        (last.citationIds ?? []).length === citationIds.length &&
        (last.citationIds ?? []).every((t, i) => t === citationIds[i])
      ) {
        return file.nodeId;
      }
    }
    // The caller chooses the trace signer. Do not replace it with the dominant
    // contributor voice: one trace has one owner, while mixed human/MODEL
    // authorship is carried by `runs` and encoded into per-delta attribution.
    // Substituting the MODEL key here makes fork-on-write correctly interpret
    // an ordinary Step as an ownership change.
    const runs = file.runs;
    const content = flattenRuns(file.runs);
    try {
      // Pass the live runs to the backend so per-voice attribution persists
      // alongside the content (webapp → LocalFile.runs; desktop → .zine/attribution
      // sidecar). The backend validates runs against content on load and falls
      // back to a single run if they drift.
      // Pass `file.tags` so a tag-only edit still reaches writeFile with the
      // new labels — writeFile detects the content-hash match but tags-changed
      // case and steps anyway, so the new `t` tags land on the relay. Hardcoding
      // undefined here would drop the tags before publish, and writeFile's
      // content-hash no-op branch would swallow the change (the Times view would
      // never see #logos/#philos etc.).
      //
      // Pending `[[ ]]` brackets are left pending — minting (publishing a
      // span as its own trace node + resolving `| nodeId`) is opt-in via Mint,
      // never a side effect of step. Resolved brackets this doc already cites
      // are mirrored as `q` tags by writeFile (findResolvedBrackets), so a
      // send-created citation flows to the relay on the next step for free.
      // `citationIds` is the tagged-but-not-quoted set (the protocol's
      // `tag-add`); writeFile folds it into the same q-tag dedup and emits a
      // `tag-add` delta per id, so adding a trace to this list steps a new node
      // even when content is unchanged.
      const tags = file.tags;
      const citationIds = file.citationIds ?? [];
      // Drain the keystroke log accumulated in the editor's editorTransactionField (mirrored
      // into FileState.editorTransactions by editFile on every change). One EditorTransaction per
      // discrete editor change since the previous step — every backspace,
      // highlight-delete, type-over, and IME commit. Cleared after step below.
      const steppedTransactions = file.editorTransactions ?? EMPTY_EDITOR_TRANSACTION_LOG;
      const editorTransactions = editorTransactionLogToArray(steppedTransactions);
      const nodeId = await writeRef.current(
        path,
        content,
        tags,
        signer,
        runs,
        citationIds.length > 0 ? citationIds : undefined,
        editorTransactions.length > 0 ? editorTransactions : undefined,
        localOnly,
        force,
        operationId,
      );
      // The head and stable trace identity are distinct after Step 0. The
      // local workspace persists both before writeFile resolves; carry that
      // identity into live React state instead of advancing only the head.
      // A legacy/non-local backend may not expose the local record, so resolve
      // the signed chain as a fallback without guessing that the newest head
      // is the genesis.
      const traceId = await resolvePostWriteTraceId({
        nodeId,
        priorTraceId: file.traceId ?? null,
        readPersistedTraceId: () => loadLocalFolder(folder.id)?.files[path]?.traceId,
        resolveTraceIdentity,
      });
      lastSteppedRef.current.set(path, { content, tags: [...tags], citationIds: [...citationIds] });
      // If edits landed while the Step was in flight, immediately rebase their
      // crash-pad record onto the new head. Never clear a newer EditorTransaction suffix.
      const liveFile = liveFilesRef.current[path];
      const liveRemaining = liveFile
        ? dropEditorTransactionLogPrefix(liveFile.editorTransactions ?? EMPTY_EDITOR_TRANSACTION_LOG, steppedTransactions)
        : EMPTY_EDITOR_TRANSACTION_LOG;
      const liveCitations = liveFile?.citationIds ?? [];
      const hasNewerBuffer = Boolean(liveFile) && (
        liveRemaining.length > 0 ||
        flattenRuns(liveFile.runs) !== content ||
        liveFile.tags.length !== tags.length ||
        liveFile.tags.some((tag, index) => tag !== tags[index]) ||
        liveCitations.length !== citationIds.length ||
        liveCitations.some((id, index) => id !== citationIds[index])
      );
      if (folder && liveFile && hasNewerBuffer) {
        mirrorPad(folder.id, path, {
          content: flattenRuns(liveFile.runs),
          tags: liveFile.tags,
          nodeId,
          ...(traceId ? { traceId } : {}),
          runs: liveFile.runs,
          citationIds: liveFile.citationIds,
          editorTransactions: editorTransactionLogToArray(liveRemaining),
        });
      } else if (folder) {
        clearPadPath(folder.id, path);
      }
      // Reflect the freshly-stepped node id back into state so the next diff
      // is against the right baseline. Stable-identity update only. The
      // context-block delta-log memo is keyed by this nodeId, so advancing
      // the head auto-invalidates the stale chain — no manual hook here.
      // Also clear the keystroke log: the buffer has been drained into this
      // step's `editorTransactions` content field, so the next step window starts fresh.
      setFilesRef.current((prev) => {
        if (!prev[path]) return prev;
        // Drain exactly the prefix this Step wrote. If the user typed while
        // the relay write was in flight, those newer chunks remain pending.
        const { editorTransactions: _drained, ...rest } = prev[path];
        const remaining = dropEditorTransactionLogPrefix(prev[path].editorTransactions ?? EMPTY_EDITOR_TRANSACTION_LOG, steppedTransactions);
        const next: FileState = {
          ...rest,
          nodeId,
          ...(traceId ? { traceId } : {}),
          ...(remaining.length > 0 ? { editorTransactions: remaining } : {}),
        };
        return { ...prev, [path]: next };
      });
      return nodeId;
    } catch (e) {
      console.warn(`[provenance] write+publish failed for ${path}:`, e);
      throw e;
    }
  }

  // setFiles is threaded in from App() so stepFile can update nodeId without
  // a re-render cycle through the debounce effect. Assigned in App()'s body.
  const setFilesRef = useRef<(updater: (prev: Record<string, FileState>) => Record<string, FileState>) => void>(
    () => {},
  );
  // Write function — threaded in from App() so stepFile uses the active backend
  // (disk on desktop, local-primary on webapp) instead of the hardwired disk
  // function. Without this, webapp edits go through the Tauri disk path and
  // silently fail (Tauri not available in a browser).
  const writeRef = useRef<
    (
      path: string,
      content: string,
      tags?: string[],
      signer?: Uint8Array,
      runs?: Run[],
      citationIds?: string[],
      editorTransactions?: EditorTransaction[],
      localOnly?: boolean,
      force?: boolean,
      operationId?: string,
    ) => Promise<string>
  >(async () => "");
  // Seed the last-stepped map for files loaded from disk/relay. Called from
  // App's openScanned tail so freshly-attached files are recognized as already
  // published (they are — that's why they have a nodeId) and don't trip a step
  // on the first debounce tick. Without this, unsteppedPaths would mark every
  // loaded file unstepped (lastSteppedRef is empty until a Step runs) and the boot
  // fanout would re-step the whole folder.
  const seedSteppedRef = useRef<(files: Record<string, FileState>) => void>(() => {});
  seedSteppedRef.current = (seedFiles: Record<string, FileState>) => {
    for (const [path, file] of Object.entries(seedFiles)) {
      lastSteppedRef.current.set(path, {
        content: flattenRuns(file.runs),
        tags: [...file.tags],
        citationIds: [...(file.citationIds ?? [])],
      });
    }
  };

  // Unstepped set: paths whose buffer differs from what was last stepped.
  // Drives the per-tab EditorTransaction count and the window title. Memoized on
  // `files` — correct because every step updates lastSteppedRef before its
  // setFiles, so the post-step re-render sees the path as clean. Replay lives in
  // panel-only state and therefore never enters this calculation.
  const unsteppedPathSet = useMemo(() => new Set(unsteppedPaths(files)), [files]);
  const unsteppedEditCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const path of unsteppedPathSet) counts.set(path, files[path]?.editorTransactions?.length ?? 0);
    return counts;
  }, [files, unsteppedPathSet]);

  return {
    stepFile,
    ready,
    setFilesRef,
    pendingPaths,
    writeRef,
    suppressStep,
    seedSteppedRef,
    authorSignerRef,
    lastSteppedRef,
    unsteppedPathSet,
    unsteppedEditCounts,
  };
}

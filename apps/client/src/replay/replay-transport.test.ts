import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { Event } from "nostr-tools";

import { gatherContextSnapshot } from "../ai/context-gather.js";
import {
  folderHeadRelation,
  planManifestUpsert,
  type ManifestFileEntry,
} from "../provenance/provenance.js";
import type { FileState } from "../workspace/workspace-core.js";
import {
  classifyLocalFolderIdentity,
  completeDurableFileStep,
  completeRecoveredFilePropagation,
  extendFolderTraversal,
  fileStepCanRepairMembership,
  isFileStepForOperation,
  isForkStepForOperation,
  localFolderReplacementIsSafe,
  runFolderStepSingleFlight,
  runResourceSerialized,
  runRootMutationAfterRecovery,
  runRootMutationSerialized,
  runStructuralOperationSerialized,
  type FolderStepRun,
  type RootMutationRun,
  type StructuralOperationRun,
} from "../workspace/workspace-local.js";
import {
  buildReplayTimeline,
  collapseDerivedFolderCheckpoints,
  derivedFolderCheckpointDetails,
  recursiveReplaySources,
  type ReplayTimelineStep,
} from "./replay-timeline.js";

const source = readFileSync(new URL("../app/App.tsx", import.meta.url), "utf8");
const styles = readFileSync(new URL("../app/App.css", import.meta.url), "utf8");
const timelineSource = readFileSync(
  new URL("./replay-timeline.ts", import.meta.url),
  "utf8",
);
const workspaceSource = readFileSync(
  new URL("../workspace/workspace-local.ts", import.meta.url),
  "utf8",
);
const provenanceSource = readFileSync(
  new URL("../provenance/provenance.ts", import.meta.url),
  "utf8",
);

test("file signing invokes the durable callback before publication", () => {
  const start = provenanceSource.indexOf("export async function publishEdit(");
  const end = provenanceSource.indexOf("export async function republishSignedEdit", start);
  const publish = provenanceSource.slice(start, end);
  // prepareOnly returns the exact signed node without recording it (Mint preflight).
  // onSigned is the durability boundary for every real publish path.
  assert.match(
    publish,
    /const signed = finalizeEvent\(template, signer\);\s*if \(input\.prepareOnly\) return signed;\s*await input\.onSigned\?\.\(signed\);/,
  );
  assert.ok(publish.indexOf("await input.onSigned?.(signed)") < publish.indexOf("if (input.localOnly)"));
  assert.match(workspaceSource, /pendingSignedEvent: event/);
  assert.match(workspaceSource, /republishSignedEdit\(file\.pendingSignedEvent/);
});

test("folder checkpoints enter the exact-event outbox before every relay write", () => {
  const start = provenanceSource.indexOf("async function publishFolderNode(");
  const end = provenanceSource.indexOf("/** Publishes a kind-34290 TraceHead", start);
  const publish = provenanceSource.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(publish, /await opts\.onSigned\?\.\(signed\);[\s\S]*enqueueLocalEvent\(signed\)/);
  assert.ok(publish.indexOf("enqueueLocalEvent(signed)") < publish.indexOf("if (opts.localOnly)"));
  assert.match(
    publish,
    /await flushLocalEventOutboxThrough\(home, opts\.publicationFence\)/,
  );
  assert.match(workspaceSource, /action: "delete",[\s\S]*operationId,[\s\S]*onSigned: persistDelete/);
  assert.match(workspaceSource, /republishSignedEdit\(landedDelete, true\)/);
});

test("folder checkpoints acknowledge focus records only after durable enqueue", () => {
  const start = provenanceSource.indexOf("async function publishFolderNode");
  const end = provenanceSource.indexOf("export function nextReplaceableCreatedAt", start);
  const publish = provenanceSource.slice(start, end);
  assert.ok(publish.indexOf("enqueueLocalEvent(signed)") >= 0);
  assert.ok(publish.indexOf("acknowledgeFocusRecords(") > publish.indexOf("enqueueLocalEvent(signed)"));
  assert.doesNotMatch(publish, /drainFocusBuffer\(folderId\)/);
});

test("folder creation recovery keeps its journal until home accepts its exact events", () => {
  const start = workspaceSource.indexOf("async function completeStagedFolderCreation");
  const end = workspaceSource.indexOf("function runStructuralOperation", start);
  const recovery = workspaceSource.slice(start, end);
  assert.match(recovery, /await flushLocalEventOutbox\(\)/);
  assert.match(recovery, /\[operation\.genesisId, parentHead\.id\]/);
  assert.match(recovery, /pendingLocalEventById\(eventId\)/);
  assert.match(recovery, /cannot finish folder recovery before home accepts/);
});

test("historical replay resolves maximal file heads once and shares occurrence prefixes", () => {
  assert.match(source, /const replayFileEventPromises = new Map/);
  assert.match(source, /const identityByNode = new Map/);
  assert.match(source, /right\.identity\.depth - left\.identity\.depth/);
  assert.match(source, /while \(cursor && !traversed\.has\(cursor\)\)/);
  assert.match(source, /pinnedChainLength: index \+ 1/);
  assert.doesNotMatch(source, /chain: loaded\.chain\.slice\(0, index \+ 1\)/);
});

test("Play loads and starts in one click, then remains reachable as Pause", () => {
  const playButton = source.match(
    /className="steps-step-btn action-palette-replay-play"([\s\S]*?)<\/button>/,
  );
  assert.ok(playButton, "missing replay Play button");
  assert.doesNotMatch(playButton[1], /disabled=\{playing\}/);
  assert.match(playButton[1], /ready \? onTogglePlay\(\) : onBegin\(\)/);
  assert.doesNotMatch(playButton[1], /count|hasTimeline/);

  assert.match(source, /if \(ready\) startReplayPlayback\(\)/);
  assert.match(source, /if \(playing\) \{\s*pauseReplayPlayback\(\)/);
  assert.match(playButton[1], /disabled=\{!hasFocus\}/);
  assert.match(source, /className="action-palette-replay-loading"/);
  assert.match(source, /className="action-palette-replay-spinner"/);
  assert.match(playButton[1], /\{playing \? "⏸" : "▶"\}/);
});

test("the first Step reports its in-flight state instead of accepting fake retries", () => {
  assert.match(source, /disabled=\{isRunning \|\| !enabled\}/);
  assert.match(
    source,
    /\{isRunning \? \(runningOp === "mint" \? "Minting…" : "Stepping…"\) : primaryAction\.label\}/,
  );
  assert.match(source, /onClick=\{\(\) => onOp\("step"\)\}/);
});

test("new live heads resolve through their direct recursive trace coordinates", () => {
  assert.match(source, /const fresh = freshSelectedReplayHeads\(/);
  assert.match(source, /recursiveReplaySources\([\s\S]*?loadLocalFolder\(folder\.id\)\?\.nodeId/);
  assert.match(source, /for \(const \{ path, nodeId \} of fresh\)/);
  assert.match(source, /const source = sourceByPath\.get\(path\)/);
  assert.match(source, /const event = await fetchEventById\(nodeId\)/);
  assert.match(source, /meta\.folderId !== source\.folderId/);
  assert.match(source, /meta\.relativePath !== source\.relativePath/);
});

test("selected recursive folders contribute structural traces without becoming document tabs", () => {
  assert.match(source, /const sources = recursiveReplaySources\(/);
  assert.match(source, /const initialFolderSources: ReplayFolderSource\[\] = sources\.folders\.map/);
  assert.match(source, /const folderQueue: ReplayFolderSource\[\] = \[\]/);
  assert.match(source, /const batch: ReplayFolderSource\[\] = \[\]/);
  assert.match(source, /mapReplayBounded\(/);
  assert.match(source, /await loadReplayFolderNodes\(source\.folderId\)/);
  assert.match(source, /admitReplayFolderOccurrence\(/);
  assert.match(source, /recursive-folder-budget-exceeded/);
  assert.match(source, /addReplayProjection\(folderReplayStep\(event, source\.path\)\)/);
  assert.match(source, /relativePath: ""/);
  assert.match(source, /folder: folderReplayState\(event, mountedPath\)/);
  assert.match(source, /ready=\{replay !== null\}/);
});

test("creating a folder mints the folder genesis that replay uses as Step 0", () => {
  assert.match(workspaceSource, /async createFolder\(relativePath: string\): Promise<string>/);
  assert.match(workspaceSource, /createFolderGenesis\(\{[\s\S]*?onSigned: \(event\) =>/);
  assert.match(workspaceSource, /genesisEvent: event/);
  assert.match(workspaceSource, /enqueueLocalEvent\(operation\.genesisEvent\)/);
  assert.match(workspaceSource, /kind: "create-folder"/);
  assert.match(workspaceSource, /stageStructuralOperation\(id, creation\)/);
  assert.match(workspaceSource, /completePendingStructuralOperationWithinRoot\(id, creation\)/);
  assert.match(workspaceSource, /const parent = localFolderCoordinate\(id, relativePath\)/);
  assert.match(source, /const nodeId = await backendRef\.current\.createFolder\(fullName\)/);
  assert.match(source, /\[fullName\]: \{ kind: "folder", runs: \[\], nodeId, traceId: nodeId, tags: \[\] \}/);
});

test("transport numbers the real genesis as Step 0 and keeps a one-Step trace navigable", () => {
  assert.match(source, /const clamped = Math\.max\(0, Math\.min\(n, r\.steps\.length - 1\)\)/);
  assert.match(source, /replayStepTo\(n\)/);
  assert.match(source, /const latest = Math\.max\(0, count - 1\)/);
  assert.match(source, /const first = index <= 0/);
  assert.match(source, /const last = index >= latest/);
  assert.match(source, /className="steps-step-btn action-palette-replay-previous"[\s\S]*?onClick=\{\(\) => onStep\(index - 1\)\}[\s\S]*?⏮/);
  assert.match(source, /className="steps-step-btn action-palette-replay-next"[\s\S]*?onClick=\{\(\) => onStep\(index \+ 1\)\}[\s\S]*?⏭/);
  assert.match(source, /aria-valuemin=\{0\}/);
  assert.match(source, /`\$\{index\} \/ \$\{latest\}`/);
  assert.match(source, /Array\.from\(\{ length: count \}/);
  assert.doesNotMatch(source, /Empty start/);
});

test("manual seeks preserve the current play/pause state", () => {
  const transport = source.slice(
    source.indexOf('<div className="action-palette-replay-transport">'),
    source.indexOf("// Telescope icon"),
  );
  assert.doesNotMatch(transport, /disabled=\{[^}]*playing/);
  assert.match(transport, /onClick=\{\(\) => onStep\(index - 1\)\}/);
  assert.match(transport, /onClick=\{\(\) => onStep\(index \+ 1\)\}/);

  const stepSeek = source.match(/onStep=\{\(n\) => \{([\s\S]*?)replayStepTo\(n\);/);
  assert.ok(stepSeek, "missing Step seek callback");
  assert.doesNotMatch(stepSeek[1], /setPlaying\(/);

  const actionSeek = source.slice(
    source.indexOf("function seekReplayToAction("),
    source.indexOf("function seekReplayToTime("),
  );
  assert.doesNotMatch(actionSeek, /setPlaying\(/);
  assert.match(source, /onAction=\{seekReplayToAction\}/);
  assert.match(source, /onSeekAt=\{seekReplayToTime\}/);
});

test("keystroke playback can begin blank without creating a pseudo-step", () => {
  assert.match(timelineSource, /const firstContentIndex = all\.findIndex\(/);
  assert.match(timelineSource, /frame\.kind === "file"/);
  assert.match(timelineSource, /flattenRuns\(frame\.runs\)\.length > 0/);
  assert.match(timelineSource, /stepIndex: firstContent\.stepIndex/);
  assert.match(timelineSource, /runs: \[\]/);
  assert.doesNotMatch(timelineSource, /stepIndex: -1/);
});

test("manual seek and Play share structural display state and panel routing", () => {
  assert.match(source, /syncReplayPanels\(\s*display,\s*targetPath/);
  assert.match(source, /syncReplayPanels\(nextDisplay, frame\.path, frame\.panelIndex\)/);
  assert.match(source, /function renderPlayFrame\(frame: PlayFrame\)/);
  assert.match(source, /replayDisplayWithFrame\(/);
  assert.match(source, /setReplayDisplay\(nextDisplay\)/);
  assert.doesNotMatch(source, /function renderPlayFrame[\s\S]{0,1200}setFiles\(/);
});

test("folder replay remains structural and only file paths reach replay panels", () => {
  assert.match(source, /relativePath: ""/);
  assert.match(source, /folder: folderReplayState\(event, mountedPath\)/);
  assert.match(timelineSource, /folders\[folder\.path\] = folder/);
  assert.match(timelineSource, /detached\[key\] =/);
  assert.match(source, /const target = focusReplayTarget\(uiFocusRef\.current\)/);
  assert.match(source, /step\.folder\.path === ROOT/);
  assert.match(source, /frame\.kind !== "focus"\) setReplayCursor/);
  assert.doesNotMatch(source, /relativePath: folderTab\(mountedPath\)/);
});

test("file edits focus their recorded panel and unrecorded files get new columns", () => {
  assert.match(timelineSource, /lastPanelByPath\.get\(frame\.path\)/);
  assert.match(source, /display\.panelIndexByPath\[path\]/);
  assert.match(source, /syncReplayPanels\(nextDisplay, frame\.path, frame\.panelIndex\)/);
  assert.match(source, /createReplayPanels\(\s*entries,/);
});

test("file replay leaves foreground-tab moments on the owning folder trace", () => {
  assert.doesNotMatch(source, /focusSourcesForPaths/);
  assert.doesNotMatch(source, /replayFocusSourcesRef/);
  assert.match(source, /buildReplayTimeline\(r\.steps, replayChainsRef\.current\)/);
  assert.doesNotMatch(timelineSource, /supplementalFocus/);
});

test("playback uses recorded time and announces accelerated inactivity", () => {
  assert.match(source, /replayTransition\(/);
  assert.match(source, /replayTimeFraction\(timing, playheadAt\)/);
  assert.match(source, /Fast-forwarding \$\{formatReplayDuration\(transition\.fastForwardedMs\)\} of inactivity at 100×/);
  assert.match(source, /className="action-palette-replay-status"[\s\S]*?aria-live="polite"/);
  assert.match(source, /const latestActionOutput = replaySkipNotice \?\?/);
});

test("Replay keeps the shared reader verdict visible beside every action", () => {
  assert.match(source, /verdict: await verifyFileTraceChain\(chain, \{/);
  assert.match(source, /conformanceVerdicts\.push\(result\.verdict\)/);
  assert.match(source, /replayLoadFailure\(\s*"recursive-folder-unavailable"/);
  assert.match(source, /traceConformanceLabel\(conformance\.status\)/);
  assert.match(source, /className=\{`trace-conformance-badge is-\$\{conformance\.status\}`\}/);
  assert.match(styles, /\.trace-conformance-badge\.is-full/);
  assert.match(styles, /\.trace-conformance-badge\.is-snapshot-only/);
  assert.match(styles, /\.trace-conformance-badge\.is-invalid/);
});

test("the slider thumb advances continuously between rendered replay frames", () => {
  const transport = source.slice(
    source.indexOf("function ReplayTransport("),
    source.indexOf("// Telescope icon"),
  );
  assert.match(
    transport,
    /const nextActionAt = actionTimes\?\.\[currentAction \+ 1\]/,
  );
  assert.match(
    transport,
    /const thumbTransition =[\s\S]*replayTransition\(\s*playheadAt,\s*nextActionAt,\s*playSpeed/,
  );
  assert.match(
    transport,
    /--replay-thumb-from[\s\S]*--replay-thumb-to[\s\S]*--replay-thumb-duration/,
  );
  assert.match(
    styles,
    /@keyframes replay-thumb-advance\s*\{[\s\S]*left:\s*var\(--replay-thumb-from\)[\s\S]*left:\s*var\(--replay-thumb-to\)/,
  );
  assert.match(
    styles,
    /\.action-palette-replay-thumb\.is-advancing\s*\{[^}]*animation:\s*replay-thumb-advance var\(--replay-thumb-duration\) linear forwards/s,
  );
  assert.match(
    styles,
    /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.action-palette-replay-thumb\.is-advancing/,
  );
  assert.match(
    source,
    /renderPlayFrame\(frame\);\s*setReplayPlayheadAt\(frame\.at\)/,
  );
});

test("the replay track drags through actions while playback remains available", () => {
  assert.match(source, /actionTimes\?: number\[\]/);
  assert.match(source, /seekAction\(fractionToStep\(positions, f\)\)/);
  assert.match(source, /onAction\(Math\.max\(0, Math\.min\(latestAction, n\)\)\)/);
  assert.match(source, /setPointerCapture\(e\.pointerId\)/);
  assert.match(source, /releasePointerCapture\(e\.pointerId\)/);
  assert.match(source, /closest\("\.action-palette-replay-activity-bubble"\)/);
  assert.match(source, /if \(!hasTimeline\) return;/);
  assert.doesNotMatch(source, /if \(!hasTimeline \|\| playing\) return;/);
  assert.match(source, /aria-valuetext=\{[\s\S]*?`Action \$\{currentAction \+ 1\} of \$\{actionTimes\.length\}`/);
  assert.match(source, /actionTimes=\{playTimeline\?\.map\(\(frame\) => frame\.at\)\}/);
  assert.match(source, /onAction=\{seekReplayToAction\}/);
  assert.match(source, /function seekReplayToAction\(n: number\)/);
  assert.match(source, /replayDisplayThroughFrame\(/);

  const trackRule = styles.match(/\.action-palette-replay-track\s*\{([^}]*)\}/s);
  assert.ok(trackRule, "missing replay track styles");
  assert.match(trackRule[1], /cursor:\s*grab/);
  assert.match(styles, /\.action-palette-replay-track:active\s*\{[^}]*cursor:\s*grabbing/s);
});

test("savepoint lines have tall, wide hit targets that seek their exact Step", () => {
  assert.match(source, /data-step-index=\{i\}/);
  assert.match(
    source,
    /const stepTick = target\?\.closest<HTMLElement>\([\s\S]*?"\.action-palette-replay-tick"[\s\S]*?onStep\(Number\(stepTick\.dataset\.stepIndex\)\)/,
  );
  assert.match(
    styles,
    /\.action-palette-replay-tick\s*\{[^}]*top:\s*0;[^}]*bottom:\s*0;[^}]*width:\s*0\.75rem;[^}]*pointer-events:\s*auto;/s,
  );
  assert.match(
    styles,
    /\.action-palette-replay-tick::before\s*\{[^}]*width:\s*2px;[^}]*height:\s*14px;/s,
  );
});

test("the focused replay trace uses a tab icon and monospace label", () => {
  assert.match(source, /className="action-palette-replay-target"/);
  assert.match(source, /<FolderOpen size=\{12\} className="tab-status"/);
  assert.match(source, /<FileText size=\{12\} className="tab-status"/);
  assert.match(source, /const target = focusReplayTarget\(uiFocus\)/);
  assert.match(source, /label: target\.path === ROOT \? rootLabel : systemPathDisplayName\(target\.path\)/);
  assert.match(source, /targets\.map\(\(target\) => \(/);
  assert.doesNotMatch(source, /className="action-palette-replay-scope-key"/);

  const targetRule = styles.match(/\.action-palette-replay-target\s*\{([^}]*)\}/s);
  assert.ok(targetRule, "missing playback target styles");
  assert.match(targetRule[1], /font-family:\s*var\(--font-mono\)/);
  assert.match(targetRule[1], /width:\s*var\(--action-palette-voice-width\)/);
  assert.match(targetRule[1], /box-sizing:\s*border-box/);
});

test("playback identity follows focus instead of operation selection or context mounts", () => {
  assert.match(source, /targets=\{replayTargets\}/);
  assert.match(source, /Focused replay trace:/);
  assert.match(source, /Focus a trace for replay/);
  assert.match(source, /const playbackScopes = target \? \[target\] : \[\]/);
  assert.doesNotMatch(source, /playbackScopes = \[\.\.\.directorySelectionRef\.current\]/);
  assert.doesNotMatch(source, /action-palette-replay-mount-remove/);
  assert.doesNotMatch(source, /aria-label=\{`Unmount \$\{item\.label\}`\}/);
});

test("the replay palette integrates previous and next Step controls into the slider row", () => {
  const transportAt = source.indexOf('<div className="action-palette-replay-transport">');
  assert.ok(transportAt >= 0, "missing slider player row");
  const transport = source.slice(transportAt, source.indexOf("// Telescope icon"));
  const previousAt = transport.indexOf("action-palette-replay-previous");
  const playAt = transport.indexOf("action-palette-replay-play");
  const speedAt = transport.indexOf("action-palette-replay-speed");
  const trackAt = transport.indexOf("action-palette-replay-track");
  const positionAt = transport.indexOf('className="steps-position"');
  const nextAt = transport.indexOf("action-palette-replay-next");
  assert.ok(playAt < speedAt, "Play must precede speed");
  assert.ok(speedAt < previousAt, "speed must precede previous Step");
  assert.ok(previousAt < nextAt, "previous Step must precede next Step");
  assert.ok(nextAt < positionAt, "next Step must precede the Step position");
  assert.ok(positionAt < trackAt, "the slider must sit to the right of every control");
  assert.doesNotMatch(source, /action-palette-replay-position|action-palette-replay-stepper/);
  assert.match(
    styles,
    /\.action-palette-replay-transport\s*\{[^}]*display:\s*flex;[^}]*align-items:\s*center;/s,
  );
  assert.match(
    styles,
    /\.action-palette-replay \.steps-position\s*\{[^}]*margin-right:\s*0;/s,
  );
});

test("replay controls align to the palette's action-button grid", () => {
  assert.match(
    styles,
    /\.action-palette-replay-play,\s*\.action-palette-replay-speed,\s*\.action-palette-replay-previous,\s*\.action-palette-replay-next,\s*\.action-palette-replay-loading\s*\{[^}]*box-sizing:\s*border-box;[^}]*flex:\s*0 0 2\.6rem;[^}]*width:\s*2\.6rem;[^}]*min-width:\s*2\.6rem;[^}]*max-width:\s*2\.6rem;[^}]*height:\s*var\(--action-palette-control-height\);/s,
  );
  assert.match(styles, /\.action-palette-replay-transport\s*\{[^}]*gap:\s*0\.3rem;/s);
  assert.match(styles, /\.action-palette-action\s*\{[^}]*width:\s*5\.5rem;/s);
  assert.match(
    styles,
    /\.action-palette-replay \.steps-position\s*\{[^}]*flex:\s*0 0 5\.5rem;[^}]*width:\s*5\.5rem;[^}]*min-width:\s*5\.5rem;[^}]*max-width:\s*5\.5rem;/s,
  );
});

test("the current replay action follows a four-button-wide slider in the TRACE row", () => {
  const transport = source.slice(
    source.indexOf("function ReplayTransport("),
    source.indexOf("// Telescope icon"),
  );
  const trackAt = transport.indexOf('className="action-palette-replay-track"');
  const statusAt = transport.indexOf('className="action-palette-replay-status"');
  assert.ok(trackAt >= 0 && trackAt < statusAt, "replay status must follow the slider");
  assert.match(transport, /\{latestActionOutput \? \([\s\S]*?\{latestActionOutput\}[\s\S]*?\) : null\}/);
  assert.match(source, /latestActionOutput=\{latestActionOutput\}/);
  assert.match(
    styles,
    /\.action-palette-replay-track\s*\{[^}]*flex:\s*0 1 22\.9rem;[^}]*width:\s*22\.9rem;[^}]*max-width:\s*22\.9rem;/s,
  );
  assert.match(styles, /\.action-palette-replay-status\s*\{[^}]*text-overflow:\s*ellipsis;/s);
  assert.doesNotMatch(source, /sidebar-latest-action-output/);
});

test("the current replay action names the exact recorded mutation with left breathing room", () => {
  assert.match(source, /function replayTextLabel\(text: string\)/);
  assert.match(source, /if \(text === " "\) return "Space"/);
  assert.match(source, /function replayMutationLabel\(/);
  assert.match(source, /return `\$\{verb\} \$\{replayTextLabel\(change\.inserted\)\}`/);
  assert.match(source, /return `Delete \$\{replayTextLabel\(change\.deleted\)\}`/);
  assert.match(
    source,
    /return `Replace \$\{replayTextLabel\(change\.deleted\)\} → \$\{replayTextLabel\(change\.inserted\)\}`/,
  );
  assert.match(source, /if \(action\.type === "undo"\) return `Undo · \$\{concrete\}`/);
  assert.match(source, /if \(action\.type === "redo"\) return `Redo · \$\{concrete\}`/);
  assert.match(source, /function replayActionLabel\(/);
  assert.match(source, /const currentReplayFrame = playTimeline\?\.\[playCursor\]/);
  assert.match(
    source,
    /else if \(frame\?\.action && frame\.path\) \{[\s\S]*?const action = replayMutationLabel\(frame\.action\)/,
  );
  assert.doesNotMatch(source, /\(\+\$\{inserted\}\/−\$\{deleted\}\)/);
  assert.match(
    styles,
    /\.action-palette-replay-status\s*\{[^}]*padding-left:\s*0\.25rem;/s,
  );
});

test("a file's first signed checkpoint is labeled Genesis at Step 0", () => {
  assert.match(source, /function isReplayGenesis\(step: ReplayStep\)/);
  assert.match(
    source,
    /else if \(frame\?\.reachesStep && step && !step\.folder && isReplayGenesis\(step\)\)/,
  );
  assert.match(
    source,
    /const genesis = frame\.action\s*\? `Genesis · \$\{replayMutationLabel\(frame\.action\)\}`\s*: "Genesis"/,
  );
  assert.match(
    source,
    /detail = folderReplay \? `\$\{step\.relativePath\} · \$\{genesis\}` : genesis/,
  );
});

test("only folder replay puts the affected path before its action", () => {
  assert.match(source, /folderReplay: boolean/);
  assert.match(
    source,
    /detail = folderReplay \? `\$\{frame\.path\} · \$\{action\}` : action/,
  );
  assert.match(source, /detail = folderReplay \? frame\.path : undefined/);
  assert.match(source, /replayTargets\[0\]\?\.kind === "folder"/);
});

test("replay actions stay steady while checkpoints post their Step index", () => {
  assert.doesNotMatch(source, /action-palette-replay-status-pulse is-flashing/);
  assert.doesNotMatch(styles, /replay-action-flash/);
  assert.match(source, /if \(!frame\?\.reachesStep\) return detail;/);
  assert.match(
    source,
    /const marker = `Step \$\{frame\.stepIndex\} \/ \$\{latestStepIndex\}`/,
  );
  assert.match(
    source,
    /setReplaySkipNotice\(null\);\s*renderPlayFrame\(frame\);/,
  );
});

test("timeline bubbles distinguish delta bursts from compressed inactivity", () => {
  assert.match(source, /\(timing\?\.activity \?\? \[\]\)\.map/);
  assert.match(source, /\(timing\?\.gaps \?\? \[\]\)\.map/);
  assert.match(source, /className="action-palette-replay-idle-band"/);
  assert.match(source, /inactive · fast-forwarded at 100×/);
  assert.match(
    styles,
    /\.action-palette-replay-activity-bubble\s*\{[^}]*min-width:\s*7px;[^}]*height:\s*7px;[^}]*outline:\s*1px solid var\(--accent\);/s,
  );
  assert.match(
    styles,
    /\.action-palette-replay-activity-bubble\.is-point\s*\{[^}]*width:\s*7px;[^}]*translate\(-50%, -50%\)/s,
  );
  assert.match(
    styles,
    /\.action-palette-replay-activity-bubble:hover\s*\{[^}]*background:\s*var\(--accent\);/s,
  );
  assert.match(
    styles,
    /\.action-palette-replay-idle-band\s*\{[^}]*min-width:\s*3px;[^}]*repeating-linear-gradient/s,
  );
});

test("clicking an activity bubble restores its opening action", () => {
  assert.match(source, /onPointerDown=\{\(\) => \{\s*onSeekAt\(activity\.startAt\)/);
  assert.match(source, /onSeekAt=\{seekReplayToTime\}/);
  assert.match(source, /replayFrameIndexAtOrBefore\(timeline, at\)/);
  assert.match(source, /replayDisplayThroughFrame\(/);
  assert.doesNotMatch(source, /if \(!playing\) onStep\(target\)/);
});

test("replay is an action palette row and no longer belongs to the sidebar", () => {
  assert.match(source, /function ActionPalette\([\s\S]*?\{replayTransport\}[\s\S]*?<\/div>\s*\);/);
  const sidebar = source.slice(source.indexOf("function Sidebar("), source.indexOf("function ActionPalette("));
  assert.doesNotMatch(sidebar, /<ReplayTransport/);
  assert.doesNotMatch(source, /sidebar-replay/);
  assert.doesNotMatch(styles, /sidebar-replay/);
});

test("the first-row label cycles through TRACE, REPLAY, and ZINE", () => {
  assert.match(source, /TRACE_ROW_LABELS = \["TRACE", "REPLAY", "ZINE"\]/);
  assert.match(source, /nextTraceRowLabel\(rowLabel\)/);
  assert.match(source, /localStorage\.setItem\(TRACE_ROW_LABEL_KEY, next\)/);
  assert.match(source, /className="action-palette-label action-palette-label-clickable"/);
  assert.doesNotMatch(source, /replayActive:\s*boolean|replayActive=\{replayDisplay !== null\}/);
});

test("the TRACE row has the same minimum height as the other palette rows", () => {
  assert.match(
    styles,
    /\.action-palette\s*\{[^}]*--action-palette-control-height:\s*1\.75rem;[^}]*--action-palette-row-height:\s*calc\(var\(--action-palette-control-height\) \+ 0\.45rem \+ 1px\);/s,
  );
  assert.match(
    styles,
    /\.action-palette-group\s*\{[^}]*box-sizing:\s*border-box;[^}]*min-height:\s*var\(--action-palette-row-height\);/s,
  );
  assert.match(
    styles,
    /\.action-palette-replay-target\s*\{[^}]*min-height:\s*var\(--action-palette-control-height\);/s,
  );
});

const ROOT_OPERATION = "1".repeat(64);

function recursiveFileState(path: string): FileState {
  return {
    runs: [{ voice: "author", text: `body:${path}` }],
    nodeId: `head:${path}`,
    traceId: `trace:${path}`,
    tags: [],
  };
}

function recursiveTraceEvent(
  id: string,
  folderId: string,
  relativePath: string,
): Event {
  return {
    id,
    pubkey: "a".repeat(64),
    created_at: 1,
    kind: 4290,
    tags: [
      ["z", "file"],
      ["f", folderId],
      ["F", relativePath],
      ["action", "edit"],
    ],
    content: JSON.stringify({
      steppedAt: 1_000,
      snapshot: `body:notes/${relativePath}`,
      contentHash: "b".repeat(64),
      operationId: ROOT_OPERATION,
      deltas: [],
      kedits: [],
    }),
    sig: "c".repeat(128),
  };
}

function recursiveReplayStep(
  id: string,
  operationId: string,
  cause?: "child-advance" | "explicit-step",
  sourceNodeId?: string,
): ReplayTimelineStep {
  return {
    event: {
      id,
      pubkey: "a".repeat(64),
      created_at: 1,
      kind: 4290,
      tags: [],
      content: "{}",
      sig: "b".repeat(128),
    },
    relativePath: cause ? "" : "notes/draft.md",
    meta: {
      steppedAtMs: 1_000,
      operationId,
      ...(cause ? { folderCheckpoint: { cause, sourceNodeId } } : {}),
    },
    runsUpToHere: [],
    ...(cause ? { folder: { path: "notes", members: [], focus: [] } } : {}),
  };
}

function folderLineageEvent(id: string, previous?: string): Event {
  return {
    id,
    pubkey: "a".repeat(64),
    created_at: 1,
    kind: 4290,
    tags: [
      ["z", "folder"],
      ["f", "child-folder"],
      ...(previous ? [["e", previous, "", "prev"]] : []),
    ],
    content: "{}",
    sig: "b".repeat(128),
  };
}

test("active AI context fetches nested files and folder logs by recursive trace coordinate", async () => {
  const files: Record<string, FileState> = {
    notes: {
      kind: "folder",
      runs: [],
      nodeId: "notes-head",
      traceId: "notes-trace",
      tags: [],
    },
    "notes/draft.md": recursiveFileState("notes/draft.md"),
  };
  const fileFetches: Array<[string, string]> = [];
  const folderFetches: string[] = [];

  await gatherContextSnapshot(
    { id: "root-trace", label: "Root" },
    files,
    [{ kind: "folder", path: "" }],
    "notes/draft.md",
    new Set(),
    {
      fetchChain: async (folderId, relativePath) => {
        fileFetches.push([folderId, relativePath]);
        return [recursiveTraceEvent("head:notes/draft.md", folderId, relativePath)];
      },
      fetchFolderNodes: async (folderId) => {
        folderFetches.push(folderId);
        return [];
      },
    },
  );

  assert.deepEqual(fileFetches, [["notes-trace", "draft.md"]]);
  assert.deepEqual(folderFetches.sort(), ["notes-trace", "root-trace"]);
});

test("Replay never hides an unverified derived folder checkpoint", () => {
  const fileStep = recursiveReplayStep("file-step", ROOT_OPERATION);
  const derived = recursiveReplayStep(
    "folder-rollup",
    ROOT_OPERATION,
    "child-advance",
    fileStep.event.id,
  );

  assert.deepEqual(
    collapseDerivedFolderCheckpoints([fileStep, derived], {
      collapsibleNodeIds: new Set([fileStep.event.id]),
    }).map((step) => step.event.id),
    [fileStep.event.id, derived.event.id],
  );
});

test("recursive Replay sources address nested files directly and include descendant folders", () => {
  const files: Record<string, FileState> = {
    notes: {
      kind: "folder",
      runs: [],
      nodeId: "notes-head",
      traceId: "notes-trace",
      tags: [],
    },
    "notes/drafts": {
      kind: "folder",
      runs: [],
      nodeId: "drafts-head",
      traceId: "drafts-trace",
      tags: [],
    },
    "notes/draft.md": recursiveFileState("notes/draft.md"),
    "notes/drafts/idea.md": recursiveFileState("notes/drafts/idea.md"),
  };
  assert.deepEqual(
    recursiveReplaySources("root-trace", files, [{ kind: "folder", path: "notes" }]),
    {
      files: [
        {
          path: "notes/draft.md",
          folderId: "notes-trace",
          relativePath: "draft.md",
          nodeId: "head:notes/draft.md",
        },
        {
          path: "notes/drafts/idea.md",
          folderId: "drafts-trace",
          relativePath: "idea.md",
          nodeId: "head:notes/drafts/idea.md",
        },
      ],
      folders: [
        { path: "", folderId: "root-trace" },
        { path: "notes", folderId: "notes-trace", nodeId: "notes-head" },
        { path: "notes/drafts", folderId: "drafts-trace", nodeId: "drafts-head" },
      ],
    },
  );

  assert.deepEqual(
    recursiveReplaySources(
      "root-trace",
      files,
      [{ kind: "file", path: "notes/drafts/idea.md" }],
    ).folders,
    [
      { path: "", folderId: "root-trace" },
      { path: "notes", folderId: "notes-trace", nodeId: "notes-head" },
      { path: "notes/drafts", folderId: "drafts-trace", nodeId: "drafts-head" },
    ],
  );
  assert.deepEqual(
    recursiveReplaySources(
      "root-trace",
      files,
      [{ kind: "folder", path: "notes" }],
      "root-checkpoint",
    ).folders[0],
    { path: "", folderId: "root-trace", nodeId: "root-checkpoint" },
  );
});

test("recursive Replay keeps the selected occurrence of a repeated folder identity", () => {
  const sharedFolder: FileState = {
    kind: "folder",
    runs: [],
    nodeId: "shared-head",
    traceId: "shared-trace",
    tags: [],
  };
  const sources = recursiveReplaySources(
    "root",
    {
      a: sharedFolder,
      b: sharedFolder,
      "a/leaf.md": { runs: [], nodeId: "a-leaf", tags: [] },
      "b/leaf.md": { runs: [], nodeId: "b-leaf", tags: [] },
    },
    [{ kind: "folder", path: "b" }],
  );
  assert.deepEqual(sources.folders.map((folder) => folder.path), ["", "b"]);
  assert.deepEqual(sources.files.map((file) => file.path), ["b/leaf.md"]);
});

test("derived Replay roll-ups remain available as inspectable signed details", () => {
  const fileStep = recursiveReplayStep("file-step", ROOT_OPERATION);
  const derived = recursiveReplayStep(
    "folder-rollup",
    ROOT_OPERATION,
    "child-advance",
    fileStep.event.id,
  );
  const [collapsed] = collapseDerivedFolderCheckpoints([fileStep, derived], {
    collapsibleNodeIds: new Set([fileStep.event.id, derived.event.id]),
  });
  assert.deepEqual(derivedFolderCheckpointDetails(collapsed), [{
    nodeId: "folder-rollup",
    path: "notes",
    cause: "child-advance",
    operationId: ROOT_OPERATION,
    signerPubkey: "a".repeat(64),
    signedEventJson: JSON.stringify(derived.event, null, 2),
  }]);
});

test("a recovered file Step cannot clear pending state before ancestor propagation succeeds", async () => {
  let cleared = false;
  let propagationAttempts = 0;
  const attempt = async () => {
    await completeRecoveredFilePropagation(
      async () => "direct-folder-head",
      async () => {
        propagationAttempts += 1;
        if (propagationAttempts === 1) throw new Error("ancestor unavailable");
      },
    );
    cleared = true;
  };

  await assert.rejects(attempt(), /ancestor unavailable/);
  assert.equal(cleared, false);
  await attempt();
  assert.equal(cleared, true);
});

test("a landed file Step is persisted before propagation and reused on retry", async () => {
  const persisted: Event[] = [];
  let appends = 0;
  let propagationAttempts = 0;
  const landed = recursiveTraceEvent("landed-file-head", "notes-trace", "draft.md");
  const attempt = () => completeDurableFileStep(
    persisted[0] ?? null,
    async () => {
      appends += 1;
      return landed;
    },
    async (event) => {
      persisted[0] = event;
    },
    async () => {
      propagationAttempts += 1;
      if (propagationAttempts === 1) throw new Error("ancestor unavailable");
    },
  );

  await assert.rejects(attempt(), /ancestor unavailable/);
  assert.equal(persisted[0]?.id, landed.id);
  assert.equal(appends, 1);
  assert.equal((await attempt()).id, landed.id);
  assert.equal(appends, 1);
});

test("a persisted fork phase is recovered as a fork, never mistaken for the requested edit", () => {
  const fork = recursiveTraceEvent("owned-fork", "notes-trace", "draft.md");
  fork.tags = fork.tags
    .filter((tag) => tag[0] !== "action")
    .concat([
      ["action", "fork"],
      ["e", "foreign-head", "", "forked-from"],
    ]);

  assert.equal(
    isFileStepForOperation(
      fork,
      ROOT_OPERATION,
      "body:notes/draft.md",
      "b".repeat(64),
    ),
    false,
  );
  assert.equal(
    isForkStepForOperation(
      fork,
      ROOT_OPERATION,
      "notes-trace",
      "draft.md",
      "foreign-head",
    ),
    true,
  );
  assert.equal(
    isForkStepForOperation(
      fork,
      ROOT_OPERATION,
      "notes-trace",
      "draft.md",
      "other-head",
    ),
    false,
  );

  const start = workspaceSource.indexOf("// Shallow folder forks deliberately cite foreign file members");
  const end = workspaceSource.indexOf("const deltas = diffToDeltas", start);
  const recovery = workspaceSource.slice(start, end);
  const durableFork = recovery.indexOf('saveLocalFileDurably("owned fork genesis"');
  const manifestWrite = recovery.indexOf("await upsertManifestEntry(", durableFork);
  assert.notEqual(durableFork, -1);
  assert.ok(manifestWrite > durableFork, "fork genesis must be persisted before manifest propagation");
  assert.match(recovery, /isForkStepForOperation\(/);
});

test("a delayed ancestor cascade cannot roll a child folder pointer backward", () => {
  const genesis = folderLineageEvent("child-folder");
  const first = folderLineageEvent("child-head-1", genesis.id);
  const second = folderLineageEvent("child-head-2", first.id);
  const relation = folderHeadRelation([genesis, first, second], second.id, first.id);
  assert.equal(relation, "current-newer");

  const current: ManifestFileEntry = {
    kind: "folder",
    relativePath: "notes",
    latestNodeId: second.id,
    contentHash: "22".repeat(32),
  };
  const stale: ManifestFileEntry = {
    ...current,
    latestNodeId: first.id,
    contentHash: "11".repeat(32),
  };
  assert.deepEqual(planManifestUpsert([current], stale, 50, relation), { unchanged: true });
  assert.match(workspaceSource, /monotonicFolderId: folderId/);
  assert.match(workspaceSource, /operationId = operationIdFromNode\(head\)/);
});

test("a recovered file Step cannot roll a membership back from a later node", () => {
  const landed = recursiveTraceEvent("landed-file-head", "notes-trace", "draft.md");
  landed.tags.push(["e", "prior-file-head", "", "prev"]);

  assert.equal(fileStepCanRepairMembership(landed, null), true);
  assert.equal(fileStepCanRepairMembership(landed, "prior-file-head"), true);
  assert.equal(fileStepCanRepairMembership(landed, landed.id), true);
  assert.equal(fileStepCanRepairMembership(landed, "later-file-head"), false);
});

test("a recovered delete cannot skip ancestor propagation after membership removal", () => {
  const start = workspaceSource.indexOf("async function tombstoneStagedFile(");
  const end = workspaceSource.indexOf("async function removeStagedFolder(", start);
  const tombstone = workspaceSource.slice(start, end);

  assert.doesNotMatch(tombstone, /if \(!entry\) return/);
  assert.match(tombstone, /if \(!entry && !landedDelete\)/);
  assert.match(
    tombstone,
    /removeManifestEntry\([\s\S]*?\?\? await fetchLatestFolderNode\(coordinate\.folderId, \{ complete: true \}\)/,
  );
  assert.match(tombstone, /await propagateFolderHead\(/);
});

test("equal-time Replay frames follow the signed child-to-ancestor cascade", () => {
  const fileStep = recursiveReplayStep("file-step", ROOT_OPERATION);
  const child = {
    ...recursiveReplayStep(
      "child-folder-step",
      ROOT_OPERATION,
      "child-advance",
      fileStep.event.id,
    ),
    folder: { path: "notes", members: [], focus: [] },
  };
  const root = {
    ...recursiveReplayStep(
      "root-folder-step",
      ROOT_OPERATION,
      "child-advance",
      child.event.id,
    ),
    folder: { path: "", members: [], focus: [] },
  };
  const grouped = {
    ...fileStep,
    derivedFolderCheckpoints: [{
      ...child,
      derivedFolderCheckpoints: [root],
    }],
  };

  const timeline = buildReplayTimeline([grouped], {
    "notes/draft.md": [fileStep.event],
    "": [root.event],
    notes: [child.event],
  });
  assert.ok(timeline);
  assert.deepEqual(
    timeline.filter((frame) => frame.kind === "folder").map((frame) => frame.folder?.path),
    ["notes", ""],
  );
});

test("duplicate folder Step calls share one in-flight append", async () => {
  const runs = new Map<string, FolderStepRun<string>>();
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  const task = async () => {
    calls += 1;
    await blocked;
    return "explicit-head";
  };

  const first = runFolderStepSingleFlight(runs, "folder-trace", ROOT_OPERATION, task);
  const second = runFolderStepSingleFlight(runs, "folder-trace", ROOT_OPERATION, task);
  assert.equal(calls, 1);
  release();
  assert.deepEqual(await Promise.all([first, second]), ["explicit-head", "explicit-head"]);
  assert.equal(calls, 1);
});

test("distinct folder Step operations queue instead of forking one previous head", async () => {
  const runs = new Map<string, FolderStepRun<string>>();
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const order: string[] = [];
  const first = runFolderStepSingleFlight(
    runs,
    "folder-trace",
    ROOT_OPERATION,
    async () => {
      order.push("first:start");
      await blocked;
      order.push("first:end");
      return "first-head";
    },
  );
  const second = runFolderStepSingleFlight(
    runs,
    "folder-trace",
    "2".repeat(64),
    async () => {
      order.push("second:start");
      return "second-head";
    },
  );

  assert.deepEqual(order, ["first:start"]);
  release();
  assert.deepEqual(await Promise.all([first, second]), ["first-head", "second-head"]);
  assert.deepEqual(order, ["first:start", "first:end", "second:start"]);
});

test("writes to one file serialize while different files can proceed", async () => {
  const runs = new Map<string, Promise<unknown>>();
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const order: string[] = [];
  const first = runResourceSerialized(runs, "root:draft.md", async () => {
    order.push("first:start");
    await blocked;
    order.push("first:end");
    return "head-1";
  });
  const second = runResourceSerialized(runs, "root:draft.md", async () => {
    order.push("second");
    return "head-2";
  });
  const independent = runResourceSerialized(runs, "root:other.md", async () => {
    order.push("other");
    return "other-head";
  });

  assert.deepEqual(order, ["first:start", "other"]);
  assert.equal(await independent, "other-head");
  release();
  assert.deepEqual(await Promise.all([first, second]), ["head-1", "head-2"]);
  assert.deepEqual(order, ["first:start", "other", "first:end", "second"]);
});

test("distinct structural journals serialize across one root", async () => {
  const runs = new Map<string, StructuralOperationRun>();
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const order: string[] = [];
  const first = runStructuralOperationSerialized(
    runs,
    "root",
    ROOT_OPERATION,
    async () => {
      order.push("delete:start");
      await blocked;
      order.push("delete:end");
    },
  );
  const second = runStructuralOperationSerialized(
    runs,
    "root",
    "2".repeat(64),
    async () => { order.push("move"); },
  );
  assert.deepEqual(order, ["delete:start"]);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["delete:start", "delete:end", "move"]);
});

test("file and structural mutations share one Root-wide order", async () => {
  const runs = new Map<string, RootMutationRun>();
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const order: string[] = [];
  const write = runRootMutationSerialized(
    runs,
    "root",
    ROOT_OPERATION,
    async () => {
      order.push("write:start");
      await blocked;
      order.push("write:end");
    },
  );
  const rename = runStructuralOperationSerialized(
    runs,
    "root",
    "2".repeat(64),
    async () => { order.push("rename"); },
  );
  assert.deepEqual(order, ["write:start"]);
  release();
  await Promise.all([write, rename]);
  assert.deepEqual(order, ["write:start", "write:end", "rename"]);
});

test("failed structural recovery blocks new work until a later retry recovers", async () => {
  const runs = new Map<string, RootMutationRun>();
  const order: string[] = [];
  let recoveryAttempts = 0;
  const recover = async () => {
    recoveryAttempts += 1;
    order.push(`recover:${recoveryAttempts}`);
    if (recoveryAttempts === 1) throw new Error("journal still blocked");
  };
  const task = async () => {
    order.push("task");
    return "done";
  };

  await assert.rejects(
    runRootMutationAfterRecovery(runs, "root", ROOT_OPERATION, recover, task),
    /journal still blocked/,
  );
  assert.deepEqual(order, ["recover:1"]);
  assert.equal(
    await runRootMutationAfterRecovery(runs, "root", "2".repeat(64), recover, task),
    "done",
  );
  assert.deepEqual(order, ["recover:1", "recover:2", "task"]);
});

test("the active folder Step path uses the shared Root lane and verified propagation", () => {
  const start = workspaceSource.indexOf("async stepFolder(");
  const end = workspaceSource.indexOf("async deletePath(", start);
  const stepFolder = workspaceSource.slice(start, end);
  const helperStart = workspaceSource.indexOf("async function stepFolderWithinRoot(");
  const helperEnd = workspaceSource.indexOf("async function resumePendingFolderStepsWithinRoot", helperStart);
  const stepFolderWithinRoot = workspaceSource.slice(helperStart, helperEnd);

  assert.match(stepFolder, /runWorkspaceRootMutation\(rootId, operationId/);
  assert.match(stepFolder, /recursiveFolderStepFlights/);
  assert.match(stepFolder, /stepFolderWithinRoot\(rootId, relativePath, operationId/);
  assert.match(
    stepFolderWithinRoot,
    /await propagateFolderHead\([\s\S]*?true,\s*undefined,\s*true,/,
  );
  assert.doesNotMatch(stepFolder, /completeExplicitFolderStep/);
});

test("one nested fork gesture carries one operation id through every checkpoint", () => {
  const start = workspaceSource.indexOf("export async function forkFileIntoLocalTree(");
  const end = workspaceSource.indexOf("export function previousStepCitationTargets", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const fork = workspaceSource.slice(start, end);

  assert.match(fork, /const operationId = opts\?\.operationId \?\? createTraceOperationId\(\)/);
  assert.match(fork, /ensureLocalTreeFolderPath\([\s\S]*operationId/);
  assert.doesNotMatch(fork, /operationId: createTraceOperationId\(\)/);
});

test("the active Replay loader consumes recursive sources instead of Root activity", () => {
  const start = source.indexOf("async function loadReplay(");
  const end = source.indexOf("async function beginReplayPlayback", start);
  const loader = source.slice(start, end === -1 ? undefined : end);

  assert.match(loader, /recursiveReplaySources\(/);
  assert.match(
    loader,
    /resolveTraceChainAtHead\(\s*traceId,\s*source\.nodeId,\s*loadReplayFileEvents/,
  );
  assert.match(loader, /selectedFileNodeIds\.has\(source\.nodeId\)/);
  assert.doesNotMatch(loader, /fetchChain\(source\.folderId, source\.relativePath\)/);
  assert.doesNotMatch(loader, /fetchFolderActivity\(/);
  assert.match(loader, /occurrencesByTrace/);
  assert.match(loader, /replayPathOccurrenceActiveAt/);
  assert.match(loader, /reconstructRunsTimeline\(chain\)/);
  assert.doesNotMatch(loader, /reconstruct(?:Runs)?UpTo\(chain, idx/);
});

test("the Replay transport exposes grouped roll-ups through an expansion control", () => {
  const start = source.indexOf("function ReplayTransport(");
  const end = source.indexOf("// Telescope icon", start);
  const transport = source.slice(start, end);

  assert.match(transport, /<details className="action-palette-replay-derived">/);
  assert.match(transport, /<code>\{checkpoint\.nodeId\}<\/code>/);
  assert.match(transport, /checkpoint\.operationId/);
  assert.match(transport, /checkpoint\.signerPubkey/);
  assert.match(transport, /checkpoint\.signedEventJson/);
});

test("cold recursive pull verifies signed folder identity and exact membership pins", () => {
  const start = workspaceSource.indexOf("async function pullFromRelayUnlocked(");
  const end = workspaceSource.indexOf("function ancestorSnapshot", start);
  const pull = workspaceSource.slice(start, end);
  const folderStart = pull.indexOf("async function pullFolder(");
  const folderEnd = pull.indexOf("await pullFolder(folderId", folderStart);
  const folder = pull.slice(folderStart, folderEnd);

  // Folder identity is memoized through resolvePullFolderIdentity, which always
  // verifies the signed head via resolveVerifiedFolderTraceIdentityAtHead.
  assert.match(pull, /resolveVerifiedFolderTraceIdentityAtHead\(\s*head,/);
  assert.match(folder, /resolvePullFolderIdentity\(folderNode\)/);
  assert.match(folder, /signedNodeContentHash\(folderNode\) !== entry\.contentHash/);
  assert.match(folder, /resolvePullFileChain\(entry\.latestNodeId\)/);
  assert.match(folder, /verifyFileTraceChain\(chain, \{/);
  assert.doesNotMatch(folder, /existing\?\.traceId \?\?/);
});

test("pull shares the Root lane and file replacement removes the old folder projection", () => {
  const start = workspaceSource.indexOf("export function pullFromRelay(");
  const end = workspaceSource.indexOf("function ancestorSnapshot", start);
  const pull = workspaceSource.slice(start, end);
  const unlockedStart = workspaceSource.indexOf("async function pullFromRelayUnlocked(");
  const unlockedEnd = workspaceSource.indexOf("export function pullFromRelay(", unlockedStart);
  const unlocked = workspaceSource.slice(unlockedStart, unlockedEnd);

  assert.match(pull, /runRootMutationSerialized\(\s*workspaceRootMutationRuns/);
  assert.match(unlocked, /const replacingFolder = existing\?\.kind === "folder"/);
  assert.match(unlocked, /deleteLocalFileDurably\(folderId, oldPath\)/);
  assert.match(workspaceSource, /saveLocalFileDurably\("pulled file"[\s\S]*?kind: "file"/);
});

test("cold pull distinguishes head advancement, cache repair, and identity replacement", () => {
  const folder = {
    kind: "folder" as const,
    content: "",
    tags: [],
    nodeId: "cached-head",
    traceId: "stale-cache",
    updatedAt: 1,
  };
  assert.deepEqual(
    classifyLocalFolderIdentity(folder, "cached-head", "signed-trace", "signed-trace"),
    { replacement: false, metadataRepair: true },
  );
  assert.deepEqual(
    classifyLocalFolderIdentity(
      { ...folder, traceId: "signed-trace" },
      "new-head",
      "signed-trace",
      "signed-trace",
    ),
    { replacement: false, metadataRepair: false },
  );
  assert.deepEqual(
    classifyLocalFolderIdentity(folder, "new-head", "new-trace", "old-trace"),
    { replacement: true, metadataRepair: true },
  );
  assert.deepEqual(
    classifyLocalFolderIdentity(folder, "new-head", "stale-cache", null),
    { replacement: true, metadataRepair: false },
  );
  assert.deepEqual(
    classifyLocalFolderIdentity(
      { ...folder, kind: "file", pendingOperationId: ROOT_OPERATION },
      "folder-head",
      "folder-trace",
      null,
    ),
    { replacement: true, metadataRepair: false },
  );
});

test("recursive folder identity replacement preserves pending local work", () => {
  const clean = {
    id: "root",
    files: {
      notes: {
        kind: "folder" as const,
        content: "",
        tags: [],
        nodeId: "old-folder-head",
        traceId: "old-folder",
        updatedAt: 1,
      },
      "notes/draft.md": {
        kind: "file" as const,
        content: "stepped",
        tags: [],
        nodeId: "file-head",
        updatedAt: 1,
      },
    },
  };
  assert.equal(localFolderReplacementIsSafe(clean, "notes"), true);
  assert.equal(localFolderReplacementIsSafe({
    ...clean,
    files: {
      ...clean.files,
      "notes/draft.md": {
        ...clean.files["notes/draft.md"],
        pendingOperationId: ROOT_OPERATION,
      },
    },
  }, "notes"), false);
  assert.equal(localFolderReplacementIsSafe({
    ...clean,
    pendingFolderSteps: { notes: ROOT_OPERATION },
  }, "notes"), false);
});

test("recursive folder identity replacement preserves a newer crash-pad draft", () => {
  const stepped = {
    id: "root",
    files: {
      notes: {
        kind: "folder" as const,
        content: "",
        tags: [],
        nodeId: "folder-head",
        traceId: "folder-trace",
        updatedAt: 1,
      },
      "notes/draft.md": {
        kind: "file" as const,
        content: "stepped",
        tags: [],
        nodeId: "file-head",
        traceId: "file-trace",
        updatedAt: 1,
      },
    },
  };
  const pad = {
    "notes/draft.md": {
      ...stepped.files["notes/draft.md"],
      content: "unstepped",
      updatedAt: 2,
    },
  };
  assert.equal(localFolderReplacementIsSafe(stepped, "notes", pad), false);
  assert.equal(localFolderReplacementIsSafe(stepped, "notes", {
    "notes/draft.md": { ...stepped.files["notes/draft.md"], updatedAt: 2 },
  }), true);
});

test("folder traversal rejects only active-ancestry cycles, not sibling aliases", () => {
  const rootBranch = extendFolderTraversal([], "root");
  const firstAlias = extendFolderTraversal(rootBranch, "shared-child");
  const secondAlias = extendFolderTraversal(rootBranch, "shared-child");
  assert.deepEqual(firstAlias, ["root", "shared-child"]);
  assert.deepEqual(secondAlias, ["root", "shared-child"]);
  assert.throws(
    () => extendFolderTraversal(firstAlias, "root"),
    /recursive folder cycle/,
  );
});

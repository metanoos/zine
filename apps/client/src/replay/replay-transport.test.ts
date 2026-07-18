import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

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

test("the first selected live head backfills an empty aggregate replay query", () => {
  assert.match(source, /const liveHeads = freshSelectedReplayHeads\(/);
  assert.match(source, /for \(const \{ path, nodeId \} of liveHeads\)/);
  assert.match(source, /const event = await fetchEventById\(nodeId\)/);
  assert.doesNotMatch(source, /if \(activity\.length === 0\) return false/);
  assert.match(source, /for \(const \[idx, event\] of chain\.entries\(\)\)/);
  assert.match(source, /const chain = orderReplayTraceChain\(folderNodes, traceId\)/);
  assert.doesNotMatch(source, /for \(const event of fileEvents\)/);
});

test("selected folders contribute structural genesis without becoming document tabs", () => {
  assert.match(source, /for \(const mounted of sc\)/);
  assert.match(source, /mounted\.path === ROOT\s*\? folder\.id/);
  assert.match(source, /steps\.push\(folderReplayStep\(event, mounted\.path\)\)/);
  assert.match(source, /relativePath: ""/);
  assert.match(source, /folder: folderReplayState\(event, mountedPath\)/);
  assert.match(source, /ready=\{replay !== null\}/);
});

test("creating a folder mints the folder genesis that replay uses as Step 0", () => {
  assert.match(workspaceSource, /async createFolder\(relativePath: string\): Promise<string>/);
  assert.match(
    workspaceSource,
    /createFolderGenesis\(\{\s*signer,\s*localOnly: true,\s*operationId,\s*\}\)/,
  );
  assert.match(workspaceSource, /const parent = localFolderCoordinate\(id, relativePath\)/);
  assert.match(workspaceSource, /kind: "folder",\s*relativePath: parent\.relativePath,\s*latestNodeId: genesisId/);
  assert.match(workspaceSource, /await propagateFolderHead\(/);
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
  assert.match(timelineSource, /folders: \{ \.\.\.display\.folders/);
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
  assert.match(source, /conformanceVerdicts\.push\(await verifyFileTraceChain\(chain\)\)/);
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

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  ONBOARDING_STORAGE_KEY,
  completedLessonsForStage,
  isOnboardingActive,
  loadOnboardingStage,
  loadOnboardingResume,
  reconcileModelOnboardingStage,
  reduceOnboardingStage,
  saveOnboardingStage,
} from "./onboarding-state.js";

const onboardingSource = readFileSync(new URL("./Onboarding.tsx", import.meta.url), "utf8");
const appSource = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const rootSource = readFileSync(new URL("../workspace/root.ts", import.meta.url), "utf8");
const styles = readFileSync(new URL("./App.css", import.meta.url), "utf8");

function storage(initial?: string) {
  const values = new Map<string, string>();
  if (initial !== undefined) values.set(ONBOARDING_STORAGE_KEY, initial);
  return {
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
  };
}

test("fresh profiles start at welcome while existing Roots remain unblocked", () => {
  assert.equal(loadOnboardingStage(false, storage()), "welcome");
  assert.equal(loadOnboardingStage(true, storage()), "dismissed");
});

test("reopening dismisses an onboarding journey interrupted after welcome", () => {
  const interruptedStages = [
    "awaiting-edit",
    "awaiting-step",
    "awaiting-replay",
    "replaying",
    "complete",
  ] as const;

  for (const stage of interruptedStages) {
    const store = storage();
    saveOnboardingStage(stage, store);
    assert.equal(loadOnboardingStage(true, store), "dismissed", stage);
  }
});

test("reopening preserves welcome and explicit dismissal", () => {
  assert.equal(
    loadOnboardingStage(true, storage(JSON.stringify({ version: 2, stage: "welcome" }))),
    "welcome",
  );
  assert.equal(
    loadOnboardingStage(true, storage(JSON.stringify({ version: 2, stage: "dismissed" }))),
    "dismissed",
  );
});

test("malformed or future records follow the safe Root-aware default", () => {
  assert.equal(loadOnboardingStage(false, storage("not json")), "welcome");
  assert.equal(
    loadOnboardingStage(true, storage(JSON.stringify({ version: 1, stage: "welcome" }))),
    "dismissed",
  );
  assert.equal(
    loadOnboardingStage(true, storage(JSON.stringify({ version: 4, stage: "welcome" }))),
    "dismissed",
  );
});

test("lesson completion persists independently from the open guide stage", () => {
  const store = storage();
  saveOnboardingStage("complete", store);
  const afterTrace = loadOnboardingResume(true, store);
  assert.deepEqual(afterTrace.completedLessons, ["trace"]);
  assert.equal(afterTrace.stage, "dismissed");

  saveOnboardingStage("dismissed", store, undefined, afterTrace.completedLessons);
  assert.deepEqual(loadOnboardingResume(true, store).completedLessons, ["trace"]);

  assert.deepEqual(
    completedLessonsForStage(["trace"], "model-complete"),
    ["trace", "ai-context"],
  );
  assert.deepEqual(
    completedLessonsForStage(["trace", "ai-context"], "scan-complete"),
    ["trace", "ai-context", "scan"],
  );
});

test("legacy completion migrates without restoring an interrupted tour", () => {
  assert.deepEqual(
    loadOnboardingResume(
      true,
      storage(JSON.stringify({ version: 2, stage: "complete" })),
    ),
    { version: 3, stage: "dismissed", completedLessons: ["trace"] },
  );
  assert.deepEqual(
    loadOnboardingResume(
      true,
      storage(JSON.stringify({ version: 2, stage: "model-complete" })),
    ),
    { version: 3, stage: "model-complete", completedLessons: ["trace", "ai-context"] },
  );
});

test("only dismissal ends the onboarding lifecycle", () => {
  assert.equal(isOnboardingActive("welcome"), true);
  assert.equal(isOnboardingActive("complete"), true);
  assert.equal(isOnboardingActive("dismissed"), false);
});

test("the optional AI chapter advances only through guarded production events", () => {
  const events = [
    "start-model",
    "provider-probed",
    "target-focused",
    "folder-mounted",
    "note-shielded",
    "request-approved",
    "result-applied",
    "result-stepped",
    "result-replayed",
  ] as const;
  let stage: Parameters<typeof reduceOnboardingStage>[0] = "complete";
  const observed: string[] = [];
  for (const event of events) {
    stage = reduceOnboardingStage(stage, event);
    observed.push(stage);
  }
  assert.deepEqual(observed, [
    "model-setup",
    "context-focus",
    "context-mount",
    "context-shield",
    "context-inspect",
    "context-run",
    "context-step",
    "context-replay",
    "model-complete",
  ]);
  assert.equal(reduceOnboardingStage("context-focus", "request-approved"), "context-focus");
});

test("the lesson index starts AI and Scan directly without faking completion", () => {
  assert.equal(reduceOnboardingStage("welcome", "start-model"), "model-setup");
  assert.equal(reduceOnboardingStage("welcome", "start-scan"), "scan-file");
  assert.equal(reduceOnboardingStage("scan-file", "start-model"), "scan-file");
  assert.equal(reduceOnboardingStage("scan-file", "file-scanned"), "scan-complete");
});

test("AI resume persists only safe coordinates and returns to a neutral probe", () => {
  const store = storage();
  const lesson = {
    folderPath: "MODEL-context-lesson",
    targetPath: "MODEL-context-lesson/brief.md",
    sourcePath: "MODEL-context-lesson/interview-source.md",
    excludedPath: "MODEL-context-lesson/private-reviewer-note.md",
    resultNodeId: "b".repeat(64),
    resultSpanHash: "a".repeat(64),
  };
  saveOnboardingStage("context-replay", store, lesson);
  assert.deepEqual(loadOnboardingResume(true, store), {
    version: 3,
    stage: "model-setup",
    completedLessons: [],
    lesson,
  });
  const raw = store.getItem(ONBOARDING_STORAGE_KEY) ?? "";
  assert.doesNotMatch(raw, /api.?key|prompt|response|message/i);
});

test("AI reconciliation walks back to the first missing real artifact", () => {
  const all = {
    providerProbed: true,
    lessonValid: true,
    targetFocused: true,
    folderMounted: true,
    noteShielded: true,
    requestApproved: true,
    resultBuffered: true,
    resultStepped: true,
  };
  assert.equal(reconcileModelOnboardingStage("context-replay", all), "context-replay");
  assert.equal(reconcileModelOnboardingStage("context-replay", { ...all, resultStepped: false }), "context-step");
  assert.equal(reconcileModelOnboardingStage("context-run", { ...all, requestApproved: false }), "context-inspect");
  assert.equal(reconcileModelOnboardingStage("context-inspect", { ...all, noteShielded: false }), "context-shield");
  assert.equal(reconcileModelOnboardingStage("context-shield", { ...all, folderMounted: false }), "context-mount");
  assert.equal(reconcileModelOnboardingStage("context-mount", { ...all, targetFocused: false }), "context-focus");
  assert.equal(reconcileModelOnboardingStage("context-focus", { ...all, providerProbed: false }), "model-setup");
});

test("AI setup creates the lesson folder trace before writing nested files", () => {
  const start = appSource.indexOf("async function ensureModelLesson()");
  const end = appSource.indexOf("async function completeModelSetup()", start);
  const setup = appSource.slice(start, end);
  const createFolderAt = setup.indexOf(
    "await backendRef.current.createFolder(lesson.folderPath)",
  );
  const writeFileAt = setup.indexOf("await backendRef.current.writeFile(");

  assert.notEqual(createFolderAt, -1);
  assert.notEqual(writeFileAt, -1);
  assert.ok(createFolderAt < writeFileAt);
});

test("the help control reopens the persistent lesson index", () => {
  const sidebarFooter = appSource.slice(
    appSource.indexOf('<div className="sidebar-directory-footer">'),
    appSource.indexOf("{ctxMenu &&"),
  );
  const navRail = appSource.slice(
    appSource.indexOf("function NavRail("),
    appSource.indexOf("// --- view placeholder"),
  );
  assert.match(sidebarFooter, /aria-label="Open onboarding guide"[\s\S]*<CircleHelp size=\{16\}[\s\S]*aria-label="Factory reset"/);
  assert.doesNotMatch(navRail, /CircleHelp|Open onboarding guide/);
  assert.match(appSource, /onOpenOnboarding=\{restartOnboarding\}/);
  assert.match(appSource, /function restartOnboarding\(\)[\s\S]*commitOnboardingStage\("welcome"\);[\s\S]*selectView\("editor"\);/);
  assert.match(appSource, /completedLessons=\{completedOnboardingLessons\}/);
  assert.match(onboardingSource, /Make my own trace/);
  assert.match(onboardingSource, /Add AI, learn context/);
  assert.match(onboardingSource, /Scan a file/);
  assert.match(onboardingSource, /Complete · Revisit/);
});

test("the guide explains why process is richer AI writing context", () => {
  assert.match(onboardingSource, /how you rewrote it/);
  assert.match(onboardingSource, /richer[\s\S]*evidence of your style and values than final prose alone/);
  assert.match(onboardingSource, /what you[\s\S]*tried, removed, and rewrote/);
  assert.match(onboardingSource, /help an AI infer[\s\S]*style and values/);
});

test("the onboarding field guide teaches trace-shaped writing", () => {
  assert.match(onboardingSource, /How to write Zines/);
  assert.match(onboardingSource, /Markdown plus an exact, replayable trace/);
  assert.match(onboardingSource, /lossy compression of the writing process/);
  assert.match(onboardingSource, /Hit newline, not backspace/);
  assert.match(onboardingSource, /Do not backspace into it;[\s\S]*do not edit it/);
  assert.match(onboardingSource, /trace and text nearly identical/);
  assert.match(onboardingSource, /make the distance between them small/);
  assert.match(onboardingSource, /route through files and tabs[\s\S]*player piano/);
  assert.match(onboardingSource, /If you can name the transition an em dash replaces/);
  assert.match(onboardingSource, /An em dash is not an emphasis mark/);
  assert.match(onboardingSource, /Parentheses lower a thought beneath the main line/);
  assert.match(onboardingSource, /Evaluate the writer, not just the writing/);
  assert.match(styles, /\.onboarding-writing-guide/);
  assert.match(styles, /\.onboarding-punctuation-key/);
});

test("the writing guide link, semantics, theme, and responsive layouts stay connected", () => {
  assert.match(
    onboardingSource,
    /href="#onboarding-writing-guide"[\s\S]*id="onboarding-writing-guide"/,
  );
  assert.match(
    onboardingSource,
    /aria-labelledby="onboarding-writing-guide-title"[\s\S]*id="onboarding-writing-guide-title"/,
  );
  assert.match(
    onboardingSource,
    /className="onboarding-text-button" onClick=\{onDismiss\}[\s\S]*Close guide/,
  );
  assert.match(
    styles,
    /\.onboarding-text-link:hover,[\s\S]*\.onboarding-text-link:focus-visible/,
  );
  assert.match(
    styles,
    /\.onboarding-writing-guide\s*\{[^}]*color: var\(--ink\);[^}]*background: var\(--surface-raised\);/s,
  );
  assert.match(
    styles,
    /\.onboarding-writing-rules\s*\{[^}]*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\);/s,
  );
  assert.match(
    styles,
    /@media \(max-width: 960px\)[\s\S]*\.onboarding-writing-rules\s*\{[^}]*grid-template-columns: 1fr;/,
  );
  assert.match(
    styles,
    /@media \(max-width: 800px\)[\s\S]*\.onboarding-writing-guide-head,[\s\S]*\.onboarding-writing-guide-foot\s*\{[^}]*grid-template-columns: 1fr;/,
  );
});

test("Scan completion is recorded only after a file is imported", () => {
  const scan = appSource.slice(
    appSource.indexOf('async function onScan(kind: "file" | "folder")'),
    appSource.indexOf("/** Reify:", appSource.indexOf('async function onScan(kind: "file" | "folder")')),
  );
  assert.match(scan, /if \(!picked\) return; \/\/ user cancelled/);
  assert.match(scan, /setOpStatus\(idx, "done", `\$\{created\.length\} scanned`, "scan"\);[\s\S]*advanceOnboarding\("file-scanned"\)/);
});

test("the hello-world demo is loaded by onboarding, not Root boot", () => {
  const beginOnboarding = appSource.slice(
    appSource.indexOf("function beginOnboarding()"),
    appSource.indexOf("function dismissOnboarding()"),
  );
  const mintRoot = rootSource.slice(
    rootSource.indexOf("export async function mintRoot()"),
    rootSource.indexOf("export function getMintFolderId"),
  );
  assert.match(beginOnboarding, /loadOnboardingDemo\(onboardingFolder\.id\)/);
  assert.match(beginOnboarding, /selectFile\(demo\.path\)/);
  assert.doesNotMatch(mintRoot, /OnboardingDemo|hello-world|saveLocalFile/);
});

test("the replay proof connects focus to the action palette", () => {
  assert.match(onboardingSource, /Actions follow focus/);
  assert.match(onboardingSource, /focused in the directory tree is mirrored in the action palette/);
  assert.match(styles, /\.onboarding-stage-awaiting-replay \.tree-row-tab-focused/);
  assert.match(styles, /\.onboarding-stage-awaiting-replay \.action-palette-replay/);
});

test("completion omits the selection and mounting field note", () => {
  assert.doesNotMatch(onboardingSource, /Learn selection &amp; context|Select to act|Mount to include|onShowContext|context-note/);
  assert.doesNotMatch(appSource, /onShowContext|commitOnboardingStage\("context-note"\)/);
  assert.doesNotMatch(styles, /onboarding-(?:context|stage-context-note)/);
});

test("the palette shows selected traces without a prompt-context summary", () => {
  assert.match(appSource, /className="action-palette-replay-targets"/);
  assert.doesNotMatch(appSource, /action-palette-context-(?:status|value)|promptContextStatus/);
  assert.doesNotMatch(styles, /action-palette-context-(?:status|value)/);
});

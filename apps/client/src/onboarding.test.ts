import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  ONBOARDING_STORAGE_KEY,
  isOnboardingActive,
  loadOnboardingStage,
  loadOnboardingResume,
  reconcileModelOnboardingStage,
  reduceOnboardingStage,
  saveOnboardingStage,
} from "./onboarding-state.js";

const onboardingSource = readFileSync(new URL("./Onboarding.tsx", import.meta.url), "utf8");
const appSource = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const rootSource = readFileSync(new URL("./root.ts", import.meta.url), "utf8");
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
    loadOnboardingStage(true, storage(JSON.stringify({ version: 3, stage: "welcome" }))),
    "dismissed",
  );
});

test("only dismissal ends the onboarding lifecycle", () => {
  assert.equal(isOnboardingActive("welcome"), true);
  assert.equal(isOnboardingActive("complete"), true);
  assert.equal(isOnboardingActive("dismissed"), false);
});

test("the optional MODEL chapter advances only through guarded production events", () => {
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

test("MODEL resume persists only safe coordinates and returns to a neutral probe", () => {
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
    version: 2,
    stage: "model-setup",
    lesson,
  });
  const raw = store.getItem(ONBOARDING_STORAGE_KEY) ?? "";
  assert.doesNotMatch(raw, /api.?key|prompt|response|message/i);
});

test("MODEL reconciliation walks back to the first missing real artifact", () => {
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

test("the help control sits beside factory reset and restarts onboarding", () => {
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

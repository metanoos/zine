// Keep the v2 key so the v3 completion schema can migrate existing records in place.
export const ONBOARDING_STORAGE_KEY = "zine.onboarding.v2";

export const ONBOARDING_LESSONS = ["trace", "ai-context", "scan"] as const;
export type OnboardingLessonId = typeof ONBOARDING_LESSONS[number];

export type OnboardingStage =
  | "welcome"
  | "awaiting-edit"
  | "awaiting-step"
  | "awaiting-replay"
  | "replaying"
  | "complete"
  | "model-setup"
  | "context-focus"
  | "context-mount"
  | "context-shield"
  | "context-inspect"
  | "context-run"
  | "context-step"
  | "context-replay"
  | "model-complete"
  | "scan-file"
  | "scan-complete"
  | "dismissed";

export interface ModelLessonResume {
  folderPath: string;
  targetPath: string;
  sourcePath: string;
  excludedPath: string;
  resultNodeId?: string;
  resultSpanHash?: string;
}

export interface OnboardingResumeRecord {
  version: 3;
  stage: OnboardingStage;
  completedLessons: OnboardingLessonId[];
  lesson?: ModelLessonResume;
}

type OnboardingStorage = Pick<Storage, "getItem" | "setItem">;

const STAGES = new Set<OnboardingStage>([
  "welcome",
  "awaiting-edit",
  "awaiting-step",
  "awaiting-replay",
  "replaying",
  "complete",
  "model-setup",
  "context-focus",
  "context-mount",
  "context-shield",
  "context-inspect",
  "context-run",
  "context-step",
  "context-replay",
  "model-complete",
  "scan-file",
  "scan-complete",
  "dismissed",
]);

const RESUMABLE_MODEL_STAGES = new Set<OnboardingStage>([
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

function safePath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512 &&
    !value.startsWith("/") && !value.includes("..") && !value.includes("\\");
}

function parseLesson(value: unknown): ModelLessonResume | undefined {
  if (!value || typeof value !== "object") return undefined;
  const lesson = value as Record<string, unknown>;
  if (
    !safePath(lesson.folderPath) ||
    !safePath(lesson.targetPath) ||
    !safePath(lesson.sourcePath) ||
    !safePath(lesson.excludedPath)
  ) return undefined;
  return {
    folderPath: lesson.folderPath,
    targetPath: lesson.targetPath,
    sourcePath: lesson.sourcePath,
    excludedPath: lesson.excludedPath,
    ...(typeof lesson.resultNodeId === "string" && /^[0-9a-f]{64}$/.test(lesson.resultNodeId)
      ? { resultNodeId: lesson.resultNodeId }
      : {}),
    ...(typeof lesson.resultSpanHash === "string" && /^[0-9a-f]{64}$/.test(lesson.resultSpanHash)
      ? { resultSpanHash: lesson.resultSpanHash }
      : {}),
  };
}

function parseCompletedLessons(value: unknown): OnboardingLessonId[] {
  if (!Array.isArray(value)) return [];
  return ONBOARDING_LESSONS.filter((lesson) => value.includes(lesson));
}

function legacyCompletedLessons(
  stage: OnboardingStage,
  lesson: ModelLessonResume | undefined,
): OnboardingLessonId[] {
  if (stage === "model-complete") return ["trace", "ai-context"];
  if (RESUMABLE_MODEL_STAGES.has(stage) || lesson) return ["trace"];
  if (stage === "complete") return ["trace"];
  return [];
}

export function completedLessonsForStage(
  completedLessons: readonly OnboardingLessonId[],
  stage: OnboardingStage,
): OnboardingLessonId[] {
  const completed = new Set(completedLessons);
  if (stage === "complete") completed.add("trace");
  if (stage === "model-complete") completed.add("ai-context");
  if (stage === "scan-complete") completed.add("scan");
  return ONBOARDING_LESSONS.filter((lesson) => completed.has(lesson));
}

export function loadOnboardingResume(
  hasExistingRoot: boolean,
  storage: OnboardingStorage = localStorage,
): OnboardingResumeRecord {
  try {
    const raw = storage.getItem(ONBOARDING_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as {
        version?: unknown;
        stage?: unknown;
        completedLessons?: unknown;
        lesson?: unknown;
      };
      if (typeof parsed.stage === "string" && STAGES.has(parsed.stage as OnboardingStage)) {
        const stage = parsed.stage as OnboardingStage;
        if (parsed.version === 2 || parsed.version === 3) {
          const lesson = parseLesson(parsed.lesson);
          const completedLessons = parsed.version === 3
            ? parseCompletedLessons(parsed.completedLessons)
            : legacyCompletedLessons(stage, lesson);
          if (RESUMABLE_MODEL_STAGES.has(stage)) {
            // Provider probe success is session-only. A resumed AI lesson
            // returns to setup unless it was already complete.
            return {
              version: 3,
              stage: stage === "model-complete" ? stage : "model-setup",
              completedLessons,
              ...(lesson ? { lesson } : {}),
            };
          }
          return {
            version: 3,
            stage: stage === "welcome" || stage === "dismissed" ? stage : "dismissed",
            completedLessons,
            ...(lesson ? { lesson } : {}),
          };
        }
      }
    }
  } catch {
    // Fall through to the Root-aware default.
  }
  return {
    version: 3,
    stage: hasExistingRoot ? "dismissed" : "welcome",
    completedLessons: [],
  };
}

/**
 * Resolve the first-run journey without surprising an existing profile. A
 * profile that already has a Root but no onboarding record predates the tour,
 * so it opens the ordinary Press. A genuinely fresh profile starts at Welcome.
 * Once the journey has started, its coachmarks are session-owned: closing the
 * app ends an interrupted journey instead of restoring it on the next launch.
 */
export function loadOnboardingStage(
  hasExistingRoot: boolean,
  storage: OnboardingStorage = localStorage,
): OnboardingStage {
  return loadOnboardingResume(hasExistingRoot, storage).stage;
}

export function saveOnboardingStage(
  stage: OnboardingStage,
  storage: OnboardingStorage = localStorage,
  lesson?: ModelLessonResume,
  completedLessons: readonly OnboardingLessonId[] = [],
): void {
  const safeLesson = parseLesson(lesson);
  const safeCompletedLessons = completedLessonsForStage(
    parseCompletedLessons(completedLessons),
    stage,
  );
  storage.setItem(
    ONBOARDING_STORAGE_KEY,
    JSON.stringify({
      version: 3,
      stage,
      completedLessons: safeCompletedLessons,
      ...(safeLesson ? { lesson: safeLesson } : {}),
    }),
  );
}

export type OnboardingEvent =
  | "start-model"
  | "start-scan"
  | "provider-probed"
  | "target-focused"
  | "folder-mounted"
  | "note-shielded"
  | "request-approved"
  | "result-applied"
  | "result-stepped"
  | "result-replayed"
  | "file-scanned";

/** Guarded progression; UI clicks cannot skip a missing production artifact. */
export function reduceOnboardingStage(
  stage: OnboardingStage,
  event: OnboardingEvent,
): OnboardingStage {
  const transitions: Partial<Record<OnboardingStage, Partial<Record<OnboardingEvent, OnboardingStage>>>> = {
    welcome: { "start-model": "model-setup", "start-scan": "scan-file" },
    complete: { "start-model": "model-setup" },
    "model-setup": { "provider-probed": "context-focus" },
    "context-focus": { "target-focused": "context-mount" },
    "context-mount": { "folder-mounted": "context-shield" },
    "context-shield": { "note-shielded": "context-inspect" },
    "context-inspect": { "request-approved": "context-run" },
    "context-run": { "result-applied": "context-step" },
    "context-step": { "result-stepped": "context-replay" },
    "context-replay": { "result-replayed": "model-complete" },
    "scan-file": { "file-scanned": "scan-complete" },
  };
  return transitions[stage]?.[event] ?? stage;
}

export interface ModelOnboardingGuards {
  providerProbed: boolean;
  lessonValid: boolean;
  targetFocused: boolean;
  folderMounted: boolean;
  noteShielded: boolean;
  requestApproved: boolean;
  resultBuffered: boolean;
  resultStepped: boolean;
}

/** Reconcile persisted intent against current production artifacts. The first
 * missing prerequisite wins, so a resumed or edited lesson moves backward to
 * the control that can repair it. */
export function reconcileModelOnboardingStage(
  stage: OnboardingStage,
  guards: ModelOnboardingGuards,
): OnboardingStage {
  if (!RESUMABLE_MODEL_STAGES.has(stage) || stage === "model-complete") return stage;
  if (stage === "model-setup") return stage;
  if (!guards.providerProbed || !guards.lessonValid) return "model-setup";
  if (stage === "context-focus") return stage;
  if (!guards.targetFocused) return "context-focus";
  if (stage === "context-mount") return stage;
  if (!guards.folderMounted) return "context-mount";
  if (stage === "context-shield") return stage;
  if (!guards.noteShielded) return "context-shield";
  if (stage === "context-inspect") return stage;
  if (stage === "context-run") {
    return guards.requestApproved ? stage : "context-inspect";
  }
  if (stage === "context-step") {
    return guards.resultBuffered ? stage : "context-run";
  }
  if (!guards.resultStepped) return "context-step";
  return stage;
}

export function isOnboardingActive(stage: OnboardingStage): boolean {
  return stage !== "dismissed";
}

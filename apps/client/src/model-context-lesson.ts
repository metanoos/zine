import { contentFingerprint } from "./context-snapshot.js";
import type { ModelLessonResume } from "./onboarding-state.js";

export const MODEL_CONTEXT_LESSON_VERSION = 1;

const TARGET_BODY = `# 24-hour working interview

Draft a concise invitation for a candidate. Continue below with the schedule and what the candidate should expect.`;

const SOURCE_BODY = `# Interview source

The working interview lasts 24 hours from kickoff to handoff. It is paid. The candidate receives a small, realistic content brief, may use AI tools, and submits both the finished piece and its replayable trace. Reviewers evaluate judgment, revision, source use, and honest attribution—not typing speed.`;

const EXCLUDED_BODY = `# Private reviewer note

Internal compensation ceiling and reviewer calibration notes. This file is deliberately shielded and must not enter the AI request.`;

export interface ModelContextLesson extends ModelLessonResume {
  artifacts: readonly {
    path: string;
    body: string;
    contentHash: string;
    role: "target" | "source" | "excluded";
  }[];
  manifestHash: string;
}

function artifactsFor(folderPath: string): ModelContextLesson["artifacts"] {
  const entries = [
    { path: `${folderPath}/brief.md`, body: TARGET_BODY, role: "target" as const },
    { path: `${folderPath}/interview-source.md`, body: SOURCE_BODY, role: "source" as const },
    { path: `${folderPath}/private-reviewer-note.md`, body: EXCLUDED_BODY, role: "excluded" as const },
  ];
  return Object.freeze(entries.map((entry) => Object.freeze({
    ...entry,
    contentHash: contentFingerprint(entry.body),
  })));
}

export function modelContextLessonForFolder(folderPath: string): ModelContextLesson {
  const artifacts = artifactsFor(folderPath);
  const targetPath = artifacts.find((entry) => entry.role === "target")!.path;
  const sourcePath = artifacts.find((entry) => entry.role === "source")!.path;
  const excludedPath = artifacts.find((entry) => entry.role === "excluded")!.path;
  const manifestHash = contentFingerprint(JSON.stringify({
    version: MODEL_CONTEXT_LESSON_VERSION,
    artifacts: artifacts.map(({ path, contentHash, role }) => ({ path, contentHash, role })),
  }));
  return Object.freeze({
    folderPath,
    targetPath,
    sourcePath,
    excludedPath,
    artifacts,
    manifestHash,
  });
}

/** Reuse an exact lesson; otherwise choose the first collision-free folder. */
export function planModelContextLesson(existing: Readonly<Record<string, string>>): ModelContextLesson {
  for (let suffix = 1; suffix < 10_000; suffix++) {
    const folderPath = suffix === 1 ? "MODEL-context-lesson" : `MODEL-context-lesson-${suffix}`;
    const candidate = modelContextLessonForFolder(folderPath);
    const occupied = Object.keys(existing).some(
      (path) => path === folderPath || path.startsWith(`${folderPath}/`),
    );
    if (!occupied) return candidate;
    if (candidate.artifacts.every((artifact) => existing[artifact.path] === artifact.body)) {
      return candidate;
    }
  }
  throw new Error("Unable to allocate a collision-free MODEL lesson folder");
}

export function validateModelContextLesson(
  lesson: ModelContextLesson,
  existing: Readonly<Record<string, string>>,
): boolean {
  const rebuilt = modelContextLessonForFolder(lesson.folderPath);
  return rebuilt.manifestHash === lesson.manifestHash &&
    lesson.artifacts.every((artifact) =>
      existing[artifact.path] === artifact.body &&
      contentFingerprint(existing[artifact.path] ?? "") === artifact.contentHash,
    );
}

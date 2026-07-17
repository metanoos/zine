import assert from "node:assert/strict";
import test from "node:test";

import {
  planModelContextLesson,
  validateModelContextLesson,
} from "./model-context-lesson.js";

test("lesson material is deterministic, exact, and teaches the 24-hour interview", () => {
  const first = planModelContextLesson({});
  const second = planModelContextLesson({});
  assert.equal(first.manifestHash, second.manifestHash);
  assert.deepEqual(first.artifacts, second.artifacts);
  assert.match(first.artifacts.map((artifact) => artifact.body).join("\n"), /24 hours/);
  assert.equal(validateModelContextLesson(
    first,
    Object.fromEntries(first.artifacts.map((artifact) => [artifact.path, artifact.body])),
  ), true);
});

test("a conflicting folder gets a collision-safe suffix while an exact lesson resumes", () => {
  const exact = planModelContextLesson({});
  const bodies = Object.fromEntries(exact.artifacts.map((artifact) => [artifact.path, artifact.body]));
  assert.equal(planModelContextLesson(bodies).folderPath, exact.folderPath);
  const conflict = planModelContextLesson({ [`${exact.folderPath}/brief.md`]: "my file" });
  assert.equal(conflict.folderPath, "MODEL-context-lesson-2");
});

test("artifact drift fails manifest validation", () => {
  const lesson = planModelContextLesson({});
  const bodies = Object.fromEntries(lesson.artifacts.map((artifact) => [artifact.path, artifact.body]));
  bodies[lesson.sourcePath] += " changed";
  assert.equal(validateModelContextLesson(lesson, bodies), false);
});

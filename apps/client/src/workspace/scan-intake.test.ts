import test from "node:test";
import assert from "node:assert/strict";

import { planScanIntake } from "./scan-intake.js";

test("a scanned file lands directly in Scan and stays additive", () => {
  const entries = [{ relativePath: "Draft Notes.md", content: "one" }];
  assert.deepEqual(
    planScanIntake("file", "/tmp/Draft Notes.md", entries, new Set()),
    [{ relativePath: "Draft Notes.md", content: "one", path: "scan/draft-notes.md" }],
  );
  assert.deepEqual(
    planScanIntake("file", "/tmp/Draft Notes.md", entries, new Set(["scan/draft-notes.md"])),
    [{ relativePath: "Draft Notes.md", content: "one", path: "scan/draft-notes-2.md" }],
  );
});

test("a scanned folder retains its outer wrapper on POSIX and Windows paths", () => {
  const entries = [
    { relativePath: "README.md", content: "readme" },
    { relativePath: "src\\Main.ts", content: "main" },
  ];
  assert.deepEqual(
    planScanIntake("folder", "C:\\work\\My Project", entries, new Set()),
    [
      { relativePath: "README.md", content: "readme", path: "scan/my-project/readme.md" },
      { relativePath: "src\\Main.ts", content: "main", path: "scan/my-project/src/main-ts.md" },
    ],
  );
});

test("a repeated folder scan suffixes the wrapper, not every leaf", () => {
  const entries = [
    { relativePath: "a.md", content: "a" },
    { relativePath: "nested/b.md", content: "b" },
  ];
  const taken = new Set([
    "scan/project/a.md",
    "scan/project/nested/b.md",
  ]);
  assert.deepEqual(
    planScanIntake("folder", "/tmp/project", entries, taken).map((entry) => entry.path),
    ["scan/project-2/a.md", "scan/project-2/nested/b.md"],
  );
});

test("slug collisions inside one scan remain distinct", () => {
  const entries = [
    { relativePath: "A B.md", content: "a" },
    { relativePath: "a-b.md", content: "b" },
  ];
  assert.deepEqual(
    planScanIntake("folder", "/tmp/project", entries, new Set()).map((entry) => entry.path),
    ["scan/project/a-b.md", "scan/project/a-b-2.md"],
  );
});

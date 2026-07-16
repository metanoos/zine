import test from "node:test";
import assert from "node:assert/strict";

import { closeDeletedTabs } from "./delete-tabs.js";

const tabPath = (tab: string) =>
  tab.startsWith("folder://") ? tab.slice("folder://".length) : tab;

test("deleting a file closes every matching tab and keeps unrelated tabs", () => {
  const panels = [
    { tabs: ["draft.md", "keep.md"], active: "draft.md" },
    { tabs: ["draft.md", "other.md"], active: "other.md" },
  ];

  assert.deepEqual(
    closeDeletedTabs(panels, [{ path: "draft.md", isFolder: false }], tabPath),
    [
      { tabs: ["keep.md"], active: "keep.md" },
      { tabs: ["other.md"], active: "other.md" },
    ],
  );
});

test("deleting a folder closes its tab and every descendant file tab", () => {
  const panels = [
    {
      tabs: ["before.md", "folder://notes", "notes/idea.md", "notes2/keep.md", "after.md"],
      active: "notes/idea.md",
    },
  ];

  assert.deepEqual(
    closeDeletedTabs(panels, [{ path: "notes", isFolder: true }], tabPath),
    [
      {
        tabs: ["before.md", "notes2/keep.md", "after.md"],
        active: "notes2/keep.md",
      },
    ],
  );
});

test("deleting the only open tab leaves an empty panel for layout collapse", () => {
  assert.deepEqual(
    closeDeletedTabs(
      [{ tabs: ["draft.md"], active: "draft.md" }],
      [{ path: "draft.md", isFolder: false }],
      tabPath,
    ),
    [{ tabs: [], active: "" }],
  );
});

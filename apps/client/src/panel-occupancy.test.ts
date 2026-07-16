import { test } from "node:test";
import assert from "node:assert/strict";

import { occupancyTransitions, type OccupancyEntry } from "./panel-occupancy.js";

const entry = (key: string, ownerFolderId = "folder"): OccupancyEntry<string> => ({
  key,
  ownerFolderId,
  selection: key,
});

test("switching a panel emits unmount before mount", () => {
  assert.deepEqual(occupancyTransitions([entry("a")], [entry("b")]), [
    { op: "unmount", panelIndex: 0, entry: entry("a") },
    { op: "mount", panelIndex: 0, entry: entry("b") },
  ]);
});

test("closing several panels emits every unmount", () => {
  assert.deepEqual(occupancyTransitions([entry("a"), entry("b"), entry("c")], [entry("a")]), [
    { op: "unmount", panelIndex: 1, entry: entry("b") },
    { op: "unmount", panelIndex: 2, entry: entry("c") },
  ]);
});

test("a head-id refresh with the same occupancy key emits nothing", () => {
  assert.deepEqual(
    occupancyTransitions(
      [{ ...entry("a"), selection: "old head" }],
      [{ ...entry("a"), selection: "new head" }],
    ),
    [],
  );
});

test("moving the same trace to a new owner is an unmount and mount", () => {
  assert.equal(occupancyTransitions([entry("a", "one")], [entry("a", "two")]).length, 2);
});

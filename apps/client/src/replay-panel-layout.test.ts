import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createReplayPanels,
  removeReplayPanels,
  type ReplayPanelState,
} from "./replay-panel-layout.js";

const live = (tabs: string[], active = tabs[0] ?? ""): ReplayPanelState => ({
  tabs,
  active,
});

test("replay panels contain every animated path without empty placeholders", () => {
  assert.deepEqual(createReplayPanels(["a.md", "b.md", "c.md", "d.md"], 3), [
    { tabs: ["a.md"], active: "a.md", replayOwned: true },
    { tabs: ["b.md"], active: "b.md", replayOwned: true },
    { tabs: ["c.md", "d.md"], active: "c.md", replayOwned: true },
  ]);
});

test("replay teardown preserves live tab changes made during playback", () => {
  const manuallyEditedLivePanel = live(["notes.md"], "notes.md");
  const panels: ReplayPanelState[] = [
    manuallyEditedLivePanel,
    { tabs: ["animated.md"], active: "animated.md", replayOwned: true },
  ];

  assert.deepEqual(removeReplayPanels(panels, 1), {
    panels: [manuallyEditedLivePanel],
    keptIndices: [0],
    activePanel: 0,
  });
});

test("replay teardown remaps focus after live panels were manually closed", () => {
  const panels: ReplayPanelState[] = [
    { tabs: ["animated.md"], active: "animated.md", replayOwned: true },
    live(["draft.md"]),
  ];

  assert.deepEqual(removeReplayPanels(panels, 1), {
    panels: [live(["draft.md"])],
    keptIndices: [1],
    activePanel: 0,
  });
});

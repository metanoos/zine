import { test } from "node:test";
import assert from "node:assert/strict";

import {
  replayLivePanelIndices,
  removeReplayPanels,
  type ReplayPanelState,
} from "./replay-panel-layout.js";

const live = (tabs: string[], active = tabs[0] ?? ""): ReplayPanelState => ({
  tabs,
  active,
});

test("replay can occupy panel 1 when the main panel is an empty placeholder", () => {
  assert.deepEqual(replayLivePanelIndices([live([])], true), []);
});

test("retained live panels compact left instead of preserving empty gaps", () => {
  const panels: ReplayPanelState[] = [
    live([]),
    live(["notes.md"]),
    { tabs: ["animated.md"], active: "animated.md", replayOwned: true },
  ];

  assert.deepEqual(replayLivePanelIndices(panels, true), [1]);
});

test("empty live placeholders remain when replay has nothing to mount", () => {
  assert.deepEqual(replayLivePanelIndices([live([])], false), [0]);
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

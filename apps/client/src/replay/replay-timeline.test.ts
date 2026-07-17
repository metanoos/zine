import assert from "node:assert/strict";
import test from "node:test";
import type { Event } from "nostr-tools";

import { createReplayPanels } from "./replay-panel-layout.js";
import {
  buildReplayTimeline,
  folderReplayState,
  replayFrameIndexAtOrBefore,
  selectedReplayPaths,
  orderReplayTraceChain,
  replayDisplayAt,
  replayDisplayThroughFrame,
  type PlayFrame,
  type ReplayTimelineStep,
} from "./replay-timeline.js";
import { reconstructRunsFromChain, type KEdit } from "../provenance/provenance.js";
import type { Run } from "../workspace/workspace-core.js";

const VOICE = "author";

function insert(from: number, text: string, at: number): KEdit {
  return { op: "ins", from, to: from, text, voice: VOICE, t: at, tx: at };
}

function replace(from: number, to: number, text: string, at: number, tx = at): KEdit {
  return { op: "repl", from, to, text, voice: VOICE, t: at, tx };
}

function event(id: string, path: string, snapshot: string, kedits: KEdit[]): Event {
  return {
    id,
    pubkey: VOICE,
    created_at: 0,
    kind: 4290,
    tags: [["z", "file"], ["F", path]],
    content: JSON.stringify({ snapshot, kedits }),
    sig: "",
  };
}

function runs(text: string): Run[] {
  return text ? [{ voice: VOICE, text }] : [];
}

function step(
  node: Event,
  path: string,
  steppedAtMs: number,
  text: string,
): ReplayTimelineStep {
  return {
    event: node,
    relativePath: path,
    meta: { steppedAtMs },
    runsUpToHere: runs(text),
  };
}

function folderEvent(
  id: string,
  prev: string | null,
  members: Array<{ kind: "file" | "folder"; relativePath: string }>,
  createdAt: number,
  deltas: unknown[] = [],
): Event {
  return {
    id,
    pubkey: VOICE,
    created_at: createdAt,
    kind: 4290,
    tags: [
      ["z", "folder"],
      ...(prev ? [["e", prev, "", "prev"]] : []),
    ],
    content: JSON.stringify({ snapshot: { members }, deltas }),
    sig: "",
  };
}

function folderStep(
  node: Event,
  folderPath: string,
  steppedAtMs: number,
): ReplayTimelineStep {
  return {
    event: node,
    relativePath: "",
    meta: { steppedAtMs },
    runsUpToHere: [],
    folder: folderReplayState(node, folderPath),
  };
}

test("two selected traces share one global Step cursor and timestamp-interleaved playback", () => {
  const selectedPaths = selectedReplayPaths(
    ["a.md", "b.md", "outside.md"],
    [
      { kind: "file", path: "a.md" },
      { kind: "file", path: "b.md" },
    ],
    new Set(),
  );
  assert.deepEqual(selectedPaths, ["a.md", "b.md"]);

  const a1 = event("a1", "a.md", "A", [insert(0, "A", 1_000)]);
  const b1 = event("b1", "b.md", "B", [insert(0, "B", 2_000)]);
  const a2 = event("a2", "a.md", "A2", [insert(1, "2", 3_000)]);
  const steps = [
    step(a1, "a.md", 4_000, "A"),
    step(b1, "b.md", 5_000, "B"),
    step(a2, "a.md", 6_000, "A2"),
  ];

  const atSecondStep = replayDisplayAt(steps, 1);
  assert.equal(atSecondStep.files["a.md"].runs.map((run) => run.text).join(""), "A");
  assert.equal(atSecondStep.files["b.md"].runs.map((run) => run.text).join(""), "B");

  const timeline = buildReplayTimeline(steps, {
    "a.md": [a1, a2],
    "b.md": [b1],
  });
  assert.ok(timeline);
  const contentFrames = timeline.filter(
    (frame) => frame.at < 4_000 && frame.runs.length > 0,
  );
  assert.deepEqual(
    contentFrames.map((frame) => frame.path),
    ["a.md", "b.md", "a.md"],
  );
  assert.deepEqual(
    contentFrames.map((frame) => frame.runs.map((run) => run.text).join("")),
    ["A", "B", "A2"],
  );

  assert.deepEqual(
    createReplayPanels([...selectedPaths, "c.md"].map((path) => ({ path })), 2),
    [
      { tabs: ["a.md"], active: "a.md", replayOwned: true },
      { tabs: ["b.md", "c.md"], active: "b.md", replayOwned: true },
    ],
  );
});

test("single-file replay numbers the signed genesis as Step 0, not its blank opening frame", () => {
  const genesis = event("file-genesis", "draft.md", "A", [insert(0, "A", 1_000)]);
  const timeline = buildReplayTimeline(
    [step(genesis, "draft.md", 1_000, "A")],
    { "draft.md": [genesis] },
  );

  assert.ok(timeline);
  assert.deepEqual(
    timeline.map((frame) => ({
      stepIndex: frame.stepIndex,
      content: frame.runs.map((run) => run.text).join(""),
      reachesStep: frame.reachesStep ?? false,
    })),
    [
      { stepIndex: 0, content: "", reachesStep: false },
      { stepIndex: 0, content: "A", reachesStep: true },
    ],
  );
});

test("replay frames expose the exact action's inserted and deleted character delta", () => {
  const first = event("first", "notes.md", "hello", [insert(0, "hello", 1_000)]);
  const second = event("second", "notes.md", "hallo!", [
    replace(1, 2, "a", 2_000, 0),
    { ...insert(5, "!", 2_000), tx: 0 },
  ]);
  const timeline = buildReplayTimeline(
    [step(first, "notes.md", 1_500, "hello"), step(second, "notes.md", 2_500, "hallo!")],
    { "notes.md": [first, second] },
  );

  assert.ok(timeline);
  const changed = timeline.find((frame) => frame.at === 2_000);
  assert.deepEqual(changed?.delta, { inserted: 2, deleted: 1 });
  assert.deepEqual(changed?.action, {
    type: "replace",
    changes: [
      { inserted: "a", deleted: "e" },
      { inserted: "!", deleted: "" },
    ],
  });
  assert.equal(changed?.reachesStep, undefined);
  const checkpoint = timeline.find((frame) => frame.stepIndex === 1 && frame.at === 2_500);
  assert.deepEqual(checkpoint?.delta, { inserted: 2, deleted: 1 });
  assert.equal(checkpoint?.reachesStep, true);
});

test("replay actions recover the exact text removed by a deletion", () => {
  const first = event("first", "notes.md", "a", [insert(0, "a", 1_000)]);
  const deletion: KEdit = {
    op: "del",
    from: 0,
    to: 1,
    text: "",
    voice: VOICE,
    t: 2_000,
    tx: 2_000,
  };
  const second = event("second", "notes.md", "", [deletion]);
  const timeline = buildReplayTimeline(
    [step(first, "notes.md", 1_500, "a"), step(second, "notes.md", 2_500, "")],
    { "notes.md": [first, second] },
  );

  assert.ok(timeline);
  const deleted = timeline.find((frame) => frame.at === 2_000);
  assert.deepEqual(deleted?.action, {
    type: "delete",
    changes: [{ inserted: "", deleted: "a" }],
  });
});

test("an edit recorded at checkpoint time is the Step-reaching frame", () => {
  const first = event("first", "notes.md", "A", [insert(0, "A", 1_000)]);
  const timeline = buildReplayTimeline(
    [step(first, "notes.md", 1_000, "A")],
    { "notes.md": [first] },
  );

  assert.ok(timeline);
  const checkpoint = timeline.find(
    (frame) => frame.runs.map((run) => run.text).join("") === "A",
  );
  assert.equal(checkpoint?.reachesStep, true);
});

test("snapshot-only replay frames expose a compact changed-middle delta", () => {
  const first = event("first", "notes.md", "hello", []);
  const second = event("second", "notes.md", "help!", []);
  const timeline = buildReplayTimeline(
    [step(first, "notes.md", 1_000, "hello"), step(second, "notes.md", 2_000, "help!")],
    { "notes.md": [first, second] },
  );

  assert.ok(timeline);
  const changed = timeline.find((frame) => frame.stepIndex === 1);
  assert.deepEqual(changed?.delta, { inserted: 2, deleted: 2 });
});

test("snapshot playback preserves the Step's reconstructed voice runs", () => {
  const human = VOICE;
  const model = "model";
  const node = event("mixed-voice", "draft.md", "written together", []);
  node.content = JSON.stringify({
    snapshot: "written together",
    authors: [
      { v: human, len: 8 },
      { v: model, len: 8 },
    ],
  });
  const mixedRuns = reconstructRunsFromChain([node]);
  const timeline = buildReplayTimeline(
    [
      {
        event: node,
        relativePath: "draft.md",
        meta: { steppedAtMs: 1_000 },
        runsUpToHere: mixedRuns,
      },
    ],
    { "draft.md": [node] },
  );

  assert.ok(timeline);
  const savedFrame = timeline.findLast(
    (frame) => frame.kind === "file" && frame.runs.length > 0,
  );
  assert.deepEqual(savedFrame?.runs, mixedRuns);
});

test("replay discards KEdits without a valid transaction id", () => {
  const node = event("invalid-kedit", "draft.md", "signed snapshot", []);
  node.content = JSON.stringify({
    snapshot: "signed snapshot",
    kedits: [{ op: "ins", from: 0, to: 0, text: "wrong", voice: VOICE, t: 500 }],
  });
  const timeline = buildReplayTimeline(
    [step(node, "draft.md", 1_000, "signed snapshot")],
    { "draft.md": [node] },
  );

  assert.ok(timeline);
  assert.equal(
    timeline.at(-1)?.runs.map((run) => run.text).join(""),
    "signed snapshot",
  );
  assert.equal(timeline.at(-1)?.action?.type, "snapshot");
});

test("replay discards valid KEdits that do not reproduce the signed snapshot", () => {
  const node = event(
    "mismatched-kedit",
    "draft.md",
    "authoritative",
    [insert(0, "advisory", 500)],
  );
  const timeline = buildReplayTimeline(
    [step(node, "draft.md", 1_000, "authoritative")],
    { "draft.md": [node] },
  );

  assert.ok(timeline);
  assert.equal(
    timeline.at(-1)?.runs.map((run) => run.text).join(""),
    "authoritative",
  );
  assert.equal(timeline.some((frame) => frame.at === 500), false);
});

test("replay does not animate a KEdit with a dishonest operation label", () => {
  const node = event("wrong-op", "draft.md", "A", [{
    op: "repl",
    from: 0,
    to: 0,
    text: "A",
    voice: VOICE,
    t: 500,
    tx: 0,
  }]);
  const timeline = buildReplayTimeline(
    [step(node, "draft.md", 1_000, "A")],
    { "draft.md": [node] },
  );

  assert.ok(timeline);
  assert.equal(timeline.some((frame) => frame.at === 500), false);
  assert.equal(timeline.at(-1)?.action?.type, "snapshot");
});

test("an empty folder genesis is a structural Step 0, never a document tab", () => {
  const genesis = folderEvent("folder-genesis", null, [], 1);
  const steps = [folderStep(genesis, "", 1_000)];

  assert.deepEqual(orderReplayTraceChain([genesis], genesis.id), [genesis]);
  assert.deepEqual(folderReplayState(genesis, ""), {
    path: "",
    members: [],
    focus: [],
  });
  assert.deepEqual(buildReplayTimeline(steps, { "folder:folder-genesis": [genesis] }), [
    {
      kind: "folder",
      path: "",
      stepIndex: 0,
      runs: [],
      at: 1_000,
      reachesStep: true,
      folder: { path: "", members: [], focus: [] },
    },
  ]);
  assert.deepEqual(replayDisplayAt(steps, 0).files, {});
});

test("folder membership snapshots animate as structure, not Markdown", () => {
  const genesis = folderEvent("folder-genesis", null, [], 1);
  const add = folderEvent(
    "folder-add",
    genesis.id,
    [
      { kind: "file", relativePath: "notes.md" },
      { kind: "folder", relativePath: "drafts" },
    ],
    2,
  );
  const chain = orderReplayTraceChain([add, genesis], genesis.id);
  assert.deepEqual(chain.map((event) => event.id), [genesis.id, add.id]);

  const steps = [
    folderStep(genesis, "work", 1_000),
    {
      ...folderStep(add, "work", 2_000),
      membership: { type: "add", path: "notes.md" },
    },
  ];
  assert.deepEqual(
    replayDisplayAt(steps, 1).folders.work.members,
    [
      { kind: "file", relativePath: "notes.md" },
      { kind: "folder", relativePath: "drafts" },
    ],
  );
  assert.deepEqual(replayDisplayAt(steps, 1).files, {});
  const timeline = buildReplayTimeline(steps, { "folder:folder-genesis": chain });
  assert.ok(timeline);
  assert.equal(timeline.at(-1)?.kind, "folder");
  assert.equal(timeline.at(-1)?.path, "");
  assert.deepEqual(timeline.at(-1)?.folder?.members, [
    { kind: "file", relativePath: "notes.md" },
    { kind: "folder", relativePath: "drafts" },
  ]);
});

test("folder focus deltas route later file edits to their recorded panel", () => {
  const genesis = folderEvent("folder-genesis", null, [], 1);
  const carrier = folderEvent(
    "folder-add",
    genesis.id,
    [{ kind: "file", relativePath: "notes.md" }],
    3,
    [
      {
        type: "focus",
        op: "mount",
        selection: { kind: "file", path: "notes.md" },
        panelIndex: 2,
        timestamp: 2_000,
      },
    ],
  );
  const first = event("notes-1", "notes.md", "A", [insert(0, "A", 1_500)]);
  const second = event("notes-2", "notes.md", "AB", [insert(1, "B", 2_500)]);
  second.tags.push(["e", first.id, "", "prev"]);
  const steps = [
    folderStep(genesis, "", 1_000),
    step(first, "notes.md", 1_800, "A"),
    step(second, "notes.md", 2_800, "AB"),
    folderStep(carrier, "", 3_000),
  ];

  const timeline = buildReplayTimeline(steps, {
    "notes.md": [first, second],
    "folder:folder-genesis": [genesis, carrier],
  });
  assert.ok(timeline);
  assert.deepEqual(replayDisplayAt(steps, 3).panels, { 2: "notes.md" });
  assert.equal(replayDisplayAt(steps, 3).panelIndexByPath["notes.md"], 2);
  const focus = timeline.find((frame) => frame.kind === "focus");
  assert.equal(focus?.path, "notes.md");
  assert.equal(focus?.panelIndex, 2);
  const edited = timeline.find(
    (frame) =>
      frame.kind === "file" &&
      frame.runs.map((run) => run.text).join("") === "AB",
  );
  assert.equal(edited?.panelIndex, 2);
  assert.deepEqual(
    createReplayPanels(
      [
        { path: "other.md", panelIndex: 0 },
        { path: "notes.md", panelIndex: edited?.panelIndex },
        { path: "later.md", panelIndex: 2 },
      ],
      3,
    ),
    [
      {
        tabs: ["other.md"],
        active: "other.md",
        replayOwned: true,
        replayPanelIndex: 0,
      },
      {
        tabs: ["notes.md", "later.md"],
        active: "notes.md",
        replayOwned: true,
        replayPanelIndex: 2,
      },
    ],
  );
});

test("folder replay discards malformed focus selections", () => {
  const malformed = folderEvent(
    "folder-malformed-focus",
    null,
    [],
    1,
    [
      {
        type: "focus",
        op: "mount",
        selection: { kind: "file" },
        panelIndex: 0,
        timestamp: 1_000,
      },
      {
        type: "focus",
        op: "mount",
        selection: { kind: "coin", nodeId: "coin", phrase: "missing origin" },
        panelIndex: 1,
        timestamp: 1_001,
      },
    ],
  );

  assert.deepEqual(folderReplayState(malformed, "").focus, []);
});

test("file-only replay excludes its owning folder's foreground-tab moments", () => {
  const carrier = folderEvent(
    "folder-focus",
    null,
    [{ kind: "file", relativePath: "notes.md" }],
    3,
    [
      {
        type: "focus",
        op: "mount",
        selection: { kind: "file", path: "notes.md" },
        panelIndex: 2,
        timestamp: 1_000,
      },
    ],
  );
  const first = event("notes-1", "notes.md", "A", [insert(0, "A", 1_500)]);
  const second = event("notes-2", "notes.md", "AB", [insert(1, "B", 2_500)]);
  second.tags.push(["e", first.id, "", "prev"]);
  const steps = [
    folderStep(carrier, "", 3_000),
    step(first, "notes.md", 1_800, "A"),
    step(second, "notes.md", 2_800, "AB"),
  ];
  const timeline = buildReplayTimeline(
    steps,
    { "notes.md": [first, second] },
  );
  assert.ok(timeline);
  assert.equal(timeline.filter((frame) => frame.kind === "focus").length, 0);
  assert.equal(Math.min(...timeline.map((frame) => frame.at)), 1_500);
  const edited = timeline.find(
    (frame) =>
      frame.kind === "file" &&
      frame.runs.map((run) => run.text).join("") === "AB",
  );
  assert.equal(edited?.panelIndex, undefined);
});

test("action scrubbing reconstructs content and focus in either direction", () => {
  const frames = [
    {
      kind: "file",
      path: "notes.md",
      stepIndex: 0,
      runs: runs("A"),
      at: 1_000,
    },
    {
      kind: "focus",
      path: "notes.md",
      stepIndex: 0,
      runs: [],
      at: 1_500,
      panelIndex: 2,
      focus: {
        type: "focus",
        op: "mount",
        selection: { kind: "file", path: "notes.md" },
        panelIndex: 2,
        timestamp: 1_500,
      },
    },
    {
      kind: "file",
      path: "notes.md",
      stepIndex: 1,
      runs: runs("AB"),
      at: 2_000,
      panelIndex: 2,
    },
  ] satisfies PlayFrame[];

  const forward = replayDisplayThroughFrame(frames, 2, ["node-a", "node-ab"]);
  assert.equal(forward.files["notes.md"].runs.map((run) => run.text).join(""), "AB");
  assert.equal(forward.files["notes.md"].nodeId, "node-ab");
  assert.deepEqual(forward.panels, { 2: "notes.md" });

  const backward = replayDisplayThroughFrame(frames, 0, ["node-a", "node-ab"]);
  assert.equal(backward.files["notes.md"].runs.map((run) => run.text).join(""), "A");
  assert.equal(backward.files["notes.md"].nodeId, "node-a");
  assert.deepEqual(backward.panels, {});
});

test("band-start seeks choose the last action at the opening timestamp", () => {
  const frames = [
    { kind: "file" as const, path: "notes.md", stepIndex: 0, runs: [], at: 1_000 },
    { kind: "focus" as const, path: "notes.md", stepIndex: 0, runs: [], at: 2_000 },
    { kind: "file" as const, path: "notes.md", stepIndex: 1, runs: [], at: 2_000 },
    { kind: "file" as const, path: "notes.md", stepIndex: 2, runs: [], at: 5_000 },
  ];
  assert.equal(replayFrameIndexAtOrBefore(frames, 999), -1);
  assert.equal(replayFrameIndexAtOrBefore(frames, 2_000), 2);
  assert.equal(replayFrameIndexAtOrBefore(frames, 4_000), 2);
});

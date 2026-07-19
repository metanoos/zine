import assert from "node:assert/strict";
import test from "node:test";
import type { Event } from "nostr-tools";

import { createReplayPanels } from "./replay-panel-layout.js";
import {
  buildReplayTimeline,
  admitReplayFolderOccurrence,
  collapseDerivedFolderCheckpoints,
  folderReplayState,
  historicalReplayMembers,
  memoizedReplayFolderNodeLoad,
  replayFrameIndexAtOrBefore,
  replayPathOccurrenceActiveAt,
  selectedReplayPaths,
  orderReplayTraceChain,
  orderReplayTraceChainAtHead,
  orderReplayTimelineSteps,
  replayDisplayAt,
  replayDisplayThroughFrame,
  replayTimelineEventIds,
  type PlayFrame,
  type ReplayTimelineStep,
} from "./replay-timeline.js";
import { reconstructRunsFromChain, type KEdit } from "../provenance/provenance.js";
import { flattenRuns, type Run } from "../workspace/workspace-core.js";

const VOICE = "author";

test("repeated folder occurrences share one in-flight history load", async () => {
  const cache = new Map<string, Promise<Event[]>>();
  let fetches = 0;
  let release!: (events: Event[]) => void;
  const pending = new Promise<Event[]>((resolve) => {
    release = resolve;
  });
  const load = async () => {
    fetches += 1;
    return pending;
  };

  const occurrences = Array.from({ length: 8 }, () =>
    memoizedReplayFolderNodeLoad(cache, "shared-folder", load)
  );
  assert.equal(fetches, 1);
  release([]);
  await Promise.all(occurrences);
  assert.equal(fetches, 1);
});

test("recursive Replay rejects alias fan-out beyond its occurrence and depth budgets", () => {
  const seen = new Set<string>();
  for (let index = 0; index < 4; index++) {
    assert.deepEqual(
      admitReplayFolderOccurrence(seen, `folder:${index}`, `level/${index}`, {
        maxOccurrences: 4,
        maxDepth: 3,
      }),
      { admitted: true },
    );
  }
  assert.match(
    admitReplayFolderOccurrence(seen, "folder:overflow", "level/overflow", {
      maxOccurrences: 4,
      maxDepth: 3,
    }).error ?? "",
    /occurrences exceed 4/,
  );
  assert.match(
    admitReplayFolderOccurrence(new Set(), "folder:deep", "a/b/c/d", {
      maxOccurrences: 4,
      maxDepth: 3,
    }).error ?? "",
    /depth 4 exceeds 3/,
  );
});

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

test("one signed Step applies every repeated file occurrence", () => {
  const node = event("shared", "a/x.md", "shared", []);
  const primary = step(node, "a/x.md", 1_000, "shared");
  primary.occurrenceProjections = [step(node, "b/x.md", 1_000, "shared")];

  const display = replayDisplayAt([primary], 0);
  assert.equal(flattenRuns(display.files["a/x.md"]?.runs ?? []), "shared");
  assert.equal(flattenRuns(display.files["b/x.md"]?.runs ?? []), "shared");
  const timeline = buildReplayTimeline([primary], { shared: [node] });
  assert.deepEqual(
    timeline?.filter((frame) =>
      frame.kind === "file" && flattenRuns(frame.runs).length > 0
    ).map((frame) => frame.path).sort(),
    ["a/x.md", "b/x.md"],
  );
  assert.equal(timeline?.filter((frame) => frame.reachesStep).length, 1);
});

test("pre-move file events stay on the old path until the structural checkpoint", () => {
  const oldPath = { observedAtMs: 1_000, removedAtMs: 3_000 };
  const newPath = { observedAtMs: 3_000 };
  assert.equal(replayPathOccurrenceActiveAt(oldPath, 2_500, true), true);
  assert.equal(replayPathOccurrenceActiveAt(newPath, 2_500, false), false);
  assert.equal(replayPathOccurrenceActiveAt(oldPath, 3_000, true), false);
  assert.equal(replayPathOccurrenceActiveAt(newPath, 3_000, false), true);
});

test("one signed folder Step applies every repeated folder occurrence", () => {
  const node = folderEvent("shared-folder", null, [{
    kind: "file",
    relativePath: "x.md",
  }], 1);
  const primary = folderStep(node, "a", 1_000);
  primary.occurrenceProjections = [folderStep(node, "b", 1_000)];

  const display = replayDisplayAt([primary], 0);
  assert.ok(display.folders.a);
  assert.ok(display.folders.b);
});

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
      eventId: genesis.id,
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

test("historical folder members remain discoverable after removal", () => {
  const present = folderEvent(
    "folder-present",
    null,
    [{ kind: "file", relativePath: "old.md" }],
    1,
  );
  present.content = JSON.stringify({
    snapshot: {
      members: [{
        kind: "file",
        relativePath: "old.md",
        latestNodeId: "old-file-head",
        contentHash: "hash",
      }],
    },
    deltas: [],
  });
  const removed = folderEvent("folder-removed", present.id, [], 2);
  assert.deepEqual(historicalReplayMembers("root", "", [present, removed]), [{
    kind: "file",
    path: "old.md",
    parentFolderId: "root",
    relativePath: "old.md",
    nodeId: "old-file-head",
    contentHash: "hash",
    observedAtMs: 1_000,
    removedAtMs: 2_000,
  }]);

  const file = step(event("old-file-head", "old.md", "old", []), "old.md", 1_000, "old");
  const display = replayDisplayAt([
    folderStep(present, "", 900),
    file,
    folderStep(removed, "", 1_100),
  ], 2);
  assert.equal(display.files["old.md"], undefined);
});

test("historical membership timestamps bound a moved file's path occurrences", () => {
  const oldPath = folderEvent("old-path", null, [], 1);
  oldPath.content = JSON.stringify({
    snapshot: { members: [{
      kind: "file",
      relativePath: "old.md",
      latestNodeId: "file-head",
      contentHash: "file-hash",
    }] },
    deltas: [],
  });
  const renamed = folderEvent("renamed", oldPath.id, [], 2);
  renamed.content = JSON.stringify({
    snapshot: { members: [{
      kind: "file",
      relativePath: "new.md",
      latestNodeId: "file-head",
      contentHash: "file-hash",
    }] },
    deltas: [{
      type: "rename",
      kind: "file",
      fromPath: "old.md",
      toPath: "new.md",
      nodeId: "file-head",
      timestamp: 2_000,
    }],
  });
  assert.deepEqual(
    historicalReplayMembers("root", "", [oldPath, renamed]).map((member) => ({
      path: member.path,
      observedAtMs: member.observedAtMs,
      removedAtMs: member.removedAtMs,
    })),
    [
      { path: "old.md", observedAtMs: 1_000, removedAtMs: 2_000 },
      { path: "new.md", observedAtMs: 2_000, removedAtMs: undefined },
    ],
  );
});

test("a removed and recreated path retains both immutable file traces", () => {
  const oldPresent = folderEvent("old-present", null, [], 1);
  oldPresent.content = JSON.stringify({
    snapshot: { members: [{
      kind: "file",
      relativePath: "draft.md",
      latestNodeId: "old-head",
      contentHash: "old-hash",
    }] },
    deltas: [],
  });
  const removed = folderEvent("removed", oldPresent.id, [], 2);
  const recreated = folderEvent("recreated", removed.id, [], 3);
  recreated.content = JSON.stringify({
    snapshot: { members: [{
      kind: "file",
      relativePath: "draft.md",
      latestNodeId: "new-head",
      contentHash: "new-hash",
    }] },
    deltas: [],
  });
  assert.deepEqual(
    historicalReplayMembers("root", "", [oldPresent, removed, recreated])
      .map((member) => member.nodeId),
    ["old-head", "new-head"],
  );
});

test("a same-path file identity seam retains both historical pins", () => {
  const foreign = folderEvent("foreign", null, [], 1);
  foreign.content = JSON.stringify({
    snapshot: { members: [{
      kind: "file",
      relativePath: "draft.md",
      latestNodeId: "foreign-head",
      contentHash: "foreign-hash",
    }] },
    deltas: [],
  });
  const forked = folderEvent("forked", foreign.id, [], 2);
  forked.content = JSON.stringify({
    snapshot: { members: [{
      kind: "file",
      relativePath: "draft.md",
      latestNodeId: "owned-fork-genesis",
      contentHash: "fork-hash",
    }] },
    deltas: [],
  });
  const edited = folderEvent("edited", forked.id, [], 3);
  edited.content = JSON.stringify({
    snapshot: { members: [{
      kind: "file",
      relativePath: "draft.md",
      latestNodeId: "owned-head",
      contentHash: "owned-hash",
    }] },
    deltas: [],
  });

  assert.deepEqual(
    historicalReplayMembers("root", "", [foreign, forked, edited])
      .map((member) => member.nodeId),
    ["foreign-head", "owned-fork-genesis", "owned-head"],
  );
});

test("a same-path folder replacement retains both identities while advances coalesce", () => {
  const initial = folderEvent("root-initial", null, [], 1);
  initial.content = JSON.stringify({
    snapshot: { members: [{
      kind: "folder",
      relativePath: "slot",
      latestNodeId: "old-folder-genesis",
      contentHash: "old-genesis-hash",
    }] },
    deltas: [],
  });
  const advanced = folderEvent("root-advanced", initial.id, [], 2);
  advanced.content = JSON.stringify({
    snapshot: { members: [{
      kind: "folder",
      relativePath: "slot",
      latestNodeId: "old-folder-head",
      contentHash: "old-head-hash",
    }] },
    deltas: [{
      type: "advance",
      kind: "folder",
      relativePath: "slot",
      previousNodeId: "old-folder-genesis",
      nodeId: "old-folder-head",
      timestamp: 2_000,
    }],
  });
  const replaced = folderEvent("root-replaced", advanced.id, [], 3);
  replaced.content = JSON.stringify({
    snapshot: { members: [{
      kind: "folder",
      relativePath: "slot",
      latestNodeId: "new-folder-genesis",
      contentHash: "new-genesis-hash",
    }] },
    deltas: [{
      type: "remove",
      kind: "folder",
      relativePath: "slot",
      nodeId: "old-folder-head",
      timestamp: 3_000,
    }, {
      type: "add",
      kind: "folder",
      relativePath: "slot",
      nodeId: "new-folder-genesis",
      timestamp: 3_000,
    }],
  });

  assert.deepEqual(
    historicalReplayMembers("root", "", [initial, advanced, replaced])
      .map(({ nodeId, contentHash }) => ({ nodeId, contentHash })),
    [
      { nodeId: "old-folder-head", contentHash: "old-head-hash" },
      { nodeId: "new-folder-genesis", contentHash: "new-genesis-hash" },
    ],
  );
  assert.deepEqual(folderReplayState(replaced, "").identityReplacements, [{
    kind: "folder",
    relativePath: "slot",
    previousNodeId: "old-folder-head",
    nodeId: "new-folder-genesis",
  }]);
});

test("a same-path folder identity replacement detaches the old replay subtree", () => {
  const rootInitial = folderEvent("root-initial", null, [], 1);
  rootInitial.content = JSON.stringify({
    snapshot: { members: [{
      kind: "folder",
      relativePath: "slot",
      latestNodeId: "old-folder-genesis",
      contentHash: "old-folder-hash",
    }] },
    deltas: [],
  });
  const oldFolderGenesis = folderEvent("old-folder-genesis", null, [], 2);
  oldFolderGenesis.content = JSON.stringify({
    snapshot: { members: [{
      kind: "file",
      relativePath: "leaf.md",
      latestNodeId: "old-leaf",
      contentHash: "old-leaf-hash",
    }] },
    deltas: [],
  });
  const oldFolderHead = folderEvent(
    "old-folder-head",
    oldFolderGenesis.id,
    [],
    3,
  );
  oldFolderHead.content = oldFolderGenesis.content;
  const rootAdvanced = folderEvent("root-advanced", rootInitial.id, [], 4);
  rootAdvanced.content = JSON.stringify({
    snapshot: { members: [{
      kind: "folder",
      relativePath: "slot",
      latestNodeId: oldFolderHead.id,
      contentHash: "old-folder-head-hash",
    }] },
    deltas: [{
      type: "advance",
      kind: "folder",
      relativePath: "slot",
      previousNodeId: oldFolderGenesis.id,
      nodeId: oldFolderHead.id,
      timestamp: 4_000,
    }],
  });
  const newFolderGenesis = folderEvent("new-folder-genesis", null, [], 5);
  newFolderGenesis.content = JSON.stringify({
    snapshot: { members: [{
      kind: "file",
      relativePath: "leaf.md",
      latestNodeId: "new-leaf",
      contentHash: "new-leaf-hash",
    }] },
    deltas: [],
  });
  const rootReplaced = folderEvent("root-replaced", rootAdvanced.id, [], 6);
  rootReplaced.content = JSON.stringify({
    snapshot: { members: [{
      kind: "folder",
      relativePath: "slot",
      latestNodeId: newFolderGenesis.id,
      contentHash: "new-folder-hash",
    }] },
    deltas: [{
      type: "remove",
      kind: "folder",
      relativePath: "slot",
      nodeId: oldFolderHead.id,
      timestamp: 6_000,
    }, {
      type: "add",
      kind: "folder",
      relativePath: "slot",
      nodeId: newFolderGenesis.id,
      timestamp: 6_000,
    }],
  });
  const oldLeaf = step(
    event("old-leaf", "slot/leaf.md", "old descendant", []),
    "slot/leaf.md",
    2_500,
    "old descendant",
  );
  const newLeaf = step(
    event("new-leaf", "slot/leaf.md", "new descendant", []),
    "slot/leaf.md",
    7_000,
    "new descendant",
  );
  const steps = [
    folderStep(rootInitial, "", 1_000),
    folderStep(oldFolderGenesis, "slot", 2_000),
    oldLeaf,
    folderStep(oldFolderHead, "slot", 3_000),
    folderStep(rootAdvanced, "", 4_000),
    folderStep(rootReplaced, "", 6_000),
    folderStep(newFolderGenesis, "slot", 6_500),
    newLeaf,
  ];

  const beforeReplacement = replayDisplayAt(steps, 4);
  assert.equal(beforeReplacement.files["slot/leaf.md"]?.nodeId, "old-leaf");
  const atReplacement = replayDisplayAt(steps, 5);
  assert.equal(atReplacement.files["slot/leaf.md"], undefined);
  assert.equal(atReplacement.folders.slot, undefined);
  const afterReplacement = replayDisplayAt(steps, 7);
  assert.equal(afterReplacement.files["slot/leaf.md"]?.nodeId, "new-leaf");
  assert.equal(
    flattenRuns(afterReplacement.files["slot/leaf.md"]?.runs ?? []),
    "new descendant",
  );
});

test("a removed immutable file is restored when membership re-adds the same node", () => {
  const present = folderEvent("present", null, [], 1);
  present.content = JSON.stringify({
    snapshot: { members: [{
      kind: "file",
      relativePath: "draft.md",
      latestNodeId: "file-head",
      contentHash: "hash",
    }] },
    deltas: [],
  });
  const removed = folderEvent("removed", present.id, [], 2);
  const readded = folderEvent("readded", removed.id, [], 3);
  readded.content = present.content;
  const file = step(event("file-head", "draft.md", "restored", []), "draft.md", 1_000, "restored");

  const display = replayDisplayAt([
    folderStep(present, "", 900),
    file,
    folderStep(removed, "", 1_100),
    folderStep(readded, "", 1_200),
  ], 3);
  assert.equal(display.files["draft.md"]?.nodeId, "file-head");
  assert.equal(flattenRuns(display.files["draft.md"]?.runs ?? []), "restored");
});

test("a folder rename rebases its replay-only subtree by immutable member identity", () => {
  const before = folderEvent("root-before", null, [], 1);
  before.content = JSON.stringify({
    snapshot: { members: [{
      kind: "folder",
      relativePath: "old",
      latestNodeId: "child-head",
      contentHash: "child-hash",
    }] },
    deltas: [],
  });
  const child = folderEvent("child-head", null, [], 2);
  child.content = JSON.stringify({
    snapshot: { members: [{
      kind: "file",
      relativePath: "leaf.md",
      latestNodeId: "leaf-head",
      contentHash: "leaf-hash",
    }] },
    deltas: [{
      type: "focus",
      op: "mount",
      selection: { kind: "file", path: "old/leaf.md" },
      panelIndex: 0,
      timestamp: 900,
    }],
  });
  const renamed = folderEvent("root-renamed", before.id, [], 3);
  renamed.content = JSON.stringify({
    snapshot: { members: [{
      kind: "folder",
      relativePath: "new",
      latestNodeId: "child-head",
      contentHash: "child-hash",
    }] },
    deltas: [],
  });
  const leaf = step(
    event("leaf-head", "old/leaf.md", "moved", []),
    "old/leaf.md",
    1_000,
    "moved",
  );

  const display = replayDisplayAt([
    folderStep(before, "", 800),
    folderStep(child, "old", 900),
    leaf,
    folderStep(renamed, "", 1_100),
  ], 3);
  assert.equal(display.files["old/leaf.md"], undefined);
  assert.equal(display.files["new/leaf.md"]?.nodeId, "leaf-head");
  assert.equal(display.folders.new?.path, "new");
  assert.deepEqual(display.panels, { 0: "new/leaf.md" });
});

test("target-add before source-remove preserves a cross-parent moved subtree", () => {
  const state = (
    id: string,
    members: Array<{
      kind: "file" | "folder";
      relativePath: string;
      latestNodeId: string;
      contentHash: string;
    }>,
    at: number,
  ) => {
    const node = folderEvent(id, null, [], at);
    node.content = JSON.stringify({ snapshot: { members }, deltas: [] });
    return node;
  };
  const childMember = {
    kind: "folder" as const,
    relativePath: "child",
    latestNodeId: "child-head",
    contentHash: "child-hash",
  };
  const leafMember = {
    kind: "file" as const,
    relativePath: "leaf.md",
    latestNodeId: "leaf-head",
    contentHash: "leaf-hash",
  };
  const leaf = step(
    event("leaf-head", "a/child/leaf.md", "moved", []),
    "a/child/leaf.md",
    1_000,
    "moved",
  );
  const display = replayDisplayAt([
    folderStep(state("a-has-child", [childMember], 1), "a", 800),
    folderStep(state("child-has-leaf", [leafMember], 2), "a/child", 900),
    leaf,
    folderStep(state("b-adds-child", [childMember], 3), "b", 1_100),
    folderStep(state("a-removes-child", [], 4), "a", 1_200),
  ], 4);

  assert.equal(display.files["a/child/leaf.md"], undefined);
  assert.equal(display.files["b/child/leaf.md"]?.nodeId, "leaf-head");
  assert.equal(display.folders["b/child"]?.path, "b/child");
});

test("one file trace can replay through its historical paths", () => {
  const beforeMove = event("before-move", "old.md", "old", []);
  const afterMove = event("after-move", "new.md", "new", []);
  const timeline = buildReplayTimeline([
    step(beforeMove, "old.md", 1_000, "old"),
    step(afterMove, "new.md", 2_000, "new"),
  ], { "file:trace": [beforeMove, afterMove] });
  assert.ok(timeline);
  assert.equal(timeline.find((frame) => frame.eventId === beforeMove.id)?.path, "old.md");
  assert.equal(timeline.find((frame) => frame.eventId === afterMove.id)?.path, "new.md");
});

test("Replay refuses to choose one branch from an ambiguous folder trace", () => {
  const genesis = folderEvent("folder-genesis", null, [], 1);
  const left = folderEvent("folder-left", genesis.id, [], 2);
  const right = folderEvent("folder-right", genesis.id, [], 3);
  assert.deepEqual(orderReplayTraceChain([right, genesis, left], genesis.id), []);
});

test("an exact historical folder pin remains resolvable below later branches", () => {
  const genesis = folderEvent("folder-genesis", null, [], 1);
  const pinned = folderEvent("folder-pinned", genesis.id, [], 2);
  const left = folderEvent("folder-left", pinned.id, [], 3);
  const right = folderEvent("folder-right", pinned.id, [], 4);
  assert.deepEqual(
    orderReplayTraceChainAtHead(
      [right, genesis, left, pinned],
      genesis.id,
      pinned.id,
    ).map((node) => node.id),
    [genesis.id, pinned.id],
  );
  assert.deepEqual(orderReplayTraceChain([right, genesis, left, pinned], genesis.id), []);
});

test("replay collapses derived folder roll-ups only when their source is present", () => {
  const file = step(event("file-step", "notes.md", "A", []), "notes.md", 1_000, "A");
  file.meta.operationId = "11".repeat(32);
  const derived = folderStep(folderEvent("folder-rollup", null, [], 2), "", 1_001);
  derived.meta.operationId = file.meta.operationId;
  derived.meta.folderCheckpoint = { cause: "child-advance", sourceNodeId: file.event.id };
  const ancestor = folderStep(folderEvent("ancestor-rollup", null, [], 3), "Root", 1_002);
  ancestor.meta.operationId = file.meta.operationId;
  ancestor.meta.folderCheckpoint = {
    cause: "child-advance",
    sourceNodeId: derived.event.id,
  };
  const explicit = folderStep(folderEvent("folder-explicit", null, [], 3), "", 2_000);
  explicit.meta.operationId = "22".repeat(32);
  explicit.meta.folderCheckpoint = { cause: "explicit-step" };
  const orphanDerived = folderStep(folderEvent("orphan-rollup", null, [], 4), "", 3_000);
  orphanDerived.meta.operationId = "33".repeat(32);
  orphanDerived.meta.folderCheckpoint = { cause: "child-advance" };

  const collapsed = collapseDerivedFolderCheckpoints([
    file,
    derived,
    ancestor,
    explicit,
    orphanDerived,
  ]);
  assert.deepEqual(
    collapsed.map((item) => item.event.id),
    ["file-step", "folder-explicit", "orphan-rollup"],
  );
  assert.deepEqual(
    collapsed[0]?.derivedFolderCheckpoints?.map((item) => item.event.id),
    ["folder-rollup"],
  );
  assert.deepEqual(
    collapsed[0]?.derivedFolderCheckpoints?.[0]?.derivedFolderCheckpoints?.map(
      (item) => item.event.id,
    ),
    ["ancestor-rollup"],
  );
  assert.ok(replayDisplayAt(collapsed, 0).folders.Root);
});

test("one explicit folder operation is one visible Replay gesture", () => {
  const operationId = "44".repeat(32);
  const file = step(event("file-step", "notes.md", "A", []), "notes.md", 1_000, "A");
  file.meta.operationId = operationId;
  const rollup = folderStep(folderEvent("folder-rollup", null, [], 2), "notes", 1_000);
  rollup.meta.operationId = operationId;
  rollup.meta.folderCheckpoint = { cause: "child-advance", sourceNodeId: file.event.id };
  const explicit = folderStep(folderEvent("folder-explicit", null, [], 3), "notes", 1_001);
  explicit.meta.operationId = operationId;
  explicit.meta.folderCheckpoint = { cause: "explicit-step" };

  const collapsed = collapseDerivedFolderCheckpoints([file, rollup, explicit]);
  assert.deepEqual(collapsed.map((item) => item.event.id), ["folder-explicit"]);
  assert.deepEqual(
    collapsed[0]?.derivedFolderCheckpoints?.map((item) => item.event.id),
    ["file-step", "folder-rollup"],
  );
  assert.equal(replayDisplayAt(collapsed, 0).files["notes.md"]?.nodeId, "file-step");
  assert.ok(replayDisplayAt(collapsed, 0).folders.notes);
  assert.deepEqual(
    [...replayTimelineEventIds(collapsed)].sort(),
    ["file-step", "folder-explicit", "folder-rollup"].sort(),
  );
  const frames = buildReplayTimeline(collapsed, { "notes.md": [file.event] });
  assert.ok(frames);
  assert.equal(frames.at(-1)?.eventId, "file-step");
  assert.equal(
    replayDisplayThroughFrame(frames, frames.length - 1).files["notes.md"]?.nodeId,
    "file-step",
  );
});

test("same-time operation grouping applies causal prerequisites before its explicit endpoint", () => {
  const operationId = "55".repeat(32);
  const file = step(event("file-step-same-time", "notes.md", "A", []), "notes.md", 1_000, "A");
  file.meta.operationId = operationId;
  const rollup = folderStep(folderEvent(
    "folder-rollup-same-time",
    null,
    [{ kind: "file", relativePath: "old.md" }],
    2,
  ), "notes", 1_000);
  rollup.meta.operationId = operationId;
  rollup.meta.folderCheckpoint = { cause: "child-advance", sourceNodeId: file.event.id };
  const explicit = folderStep(folderEvent(
    "folder-explicit-same-time",
    null,
    [{ kind: "file", relativePath: "final.md" }],
    3,
  ), "notes", 1_000);
  explicit.meta.operationId = operationId;
  explicit.meta.folderCheckpoint = { cause: "explicit-step" };

  const collapsed = collapseDerivedFolderCheckpoints([explicit, rollup, file]);
  assert.deepEqual(collapsed.map((item) => item.event.id), [explicit.event.id]);
  assert.deepEqual(replayDisplayAt(collapsed, 0).folders.notes.members, [
    { kind: "file", relativePath: "final.md" },
  ]);
});

test("global replay ordering preserves prev causality across clock rollback", () => {
  const parent = step(event("clock-parent", "notes.md", "A", []), "notes.md", 2_000, "A");
  const childEvent = event("clock-child", "notes.md", "AB", []);
  childEvent.tags.push(["e", parent.event.id, "", "prev"]);
  const child = step(childEvent, "notes.md", 1_000, "AB");
  assert.deepEqual(
    orderReplayTimelineSteps([child, parent]).map((item) => item.event.id),
    [parent.event.id, child.event.id],
  );
});

test("explicit folder Step precedes its downstream ancestor roll-up", () => {
  const operationId = "66".repeat(32);
  const file = step(event("op-file", "notes.md", "A", []), "notes.md", 3_000, "A");
  file.meta.operationId = operationId;
  const explicit = folderStep(folderEvent("op-explicit", null, [], 2), "notes", 2_000);
  explicit.meta.operationId = operationId;
  explicit.meta.folderCheckpoint = { cause: "explicit-step" };
  const parent = folderStep(folderEvent("op-parent", null, [], 3), "", 1_000);
  parent.meta.operationId = operationId;
  parent.meta.folderCheckpoint = { cause: "child-advance", sourceNodeId: explicit.event.id };
  assert.deepEqual(
    orderReplayTimelineSteps([parent, explicit, file]).map((item) => item.event.id),
    [file.event.id, explicit.event.id, parent.event.id],
  );
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

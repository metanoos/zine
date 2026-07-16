/**
 * Inbound tracker helpers (protocol §3.8 forks, §6 tags, §3.3 cites).
 * Pure unit tests — no relay. The relay-dependent resolver `findInbound`
 * (which issues the chunked `#e` / `#q` reverse lookups) is the same shape as
 * `findMergeCandidates` and, like it, is not unit-tested here; what IS testable
 * without a relay is the delta-parse + role classification — the logic that
 * decides whether an incoming `q` edge is a fork, a tag, a cite, or nothing.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  citeDeltasOf,
  classifyCite,
  classifyQEdge,
  excludeInboundSources,
  filterInboundCitationRefs,
  inboundCitationsFromHeads,
  inboundCitationsFromResolvedHeads,
  resolveInboundHeadSnapshot,
  resolveInboundSourceHeads,
} from "./provenance.js";
import type { Event } from "nostr-tools";

function fakeEvent(content: unknown): Event {
  return {
    id: "x",
    pubkey: "pk",
    created_at: 0,
    kind: 4290,
    tags: [],
    content: typeof content === "string" ? content : JSON.stringify(content),
    sig: "",
  };
}

/** Build a file-node event with arbitrary tags + content. Mirrors the wire shape
 *  publishEdit emits: kind 4290, `z:file`, the given tags, JSON content. */
function fileEvent(tags: string[][], content: unknown): Event {
  return {
    id: "x",
    pubkey: "pk",
    created_at: 0,
    kind: 4290,
    tags: [["z", "file"], ...tags],
    content: JSON.stringify(content),
    sig: "",
  };
}

/** A folder-node event — its `q` edges are membership, not citation. */
function folderEvent(tags: string[][], content: unknown): Event {
  return {
    id: "x",
    pubkey: "pk",
    created_at: 0,
    kind: 4290,
    tags: [["z", "folder"], ...tags],
    content: JSON.stringify(content),
    sig: "",
  };
}

function sourceEvent(
  id: string,
  path: string,
  qTargets: string[],
  prev?: string,
  action = "edit",
): Event {
  return {
    id,
    pubkey: "source-pk",
    created_at: 0,
    kind: 4290,
    tags: [
      ["z", "file"],
      ["file", path],
      ["folder", "source-folder"],
      ["F", path],
      ["D", "source-folder"],
      ["action", action],
      ...(prev ? [["e", prev, "", "prev"]] : []),
      ...qTargets.map((target) => ["q", target, ""]),
    ],
    content: JSON.stringify({ snapshot: action === "delete" ? "" : "source", deltas: [] }),
    sig: "",
  };
}

// --- classifyCite: role → inbound kind ----------------------------------

test("classifyCite: tag role → tag", () => {
  assert.equal(classifyCite("tag"), "tag");
});

test("classifyCite: inline role → cite", () => {
  assert.equal(classifyCite("inline"), "cite");
});

test("classifyCite: reply role → cite", () => {
  assert.equal(classifyCite("reply"), "cite");
});

test("classifyCite: live role → null (reserved/deferred, spec §3.3)", () => {
  assert.equal(classifyCite("live"), null);
});

test("classifyCite: unknown role → null", () => {
  assert.equal(classifyCite("nope"), null);
});

test("classifyCite: undefined role → null", () => {
  assert.equal(classifyCite(undefined), null);
});

// --- citeDeltasOf: parse + filter ---------------------------------------

test("citeDeltasOf: returns only cite deltas, drops body/membership/focus", () => {
  // A mix of delta types as a real node's content carries — only the two cite
  // entries should survive.
  const e = fakeEvent({
    deltas: [
      { type: "insert", position: { start: 0, end: 0 }, newValue: "hi", timestamp: 1 },
      { type: "cite", role: "tag", sourceEventId: "abc", timestamp: 2 },
      { type: "cite", role: "inline", sourceEventId: "def", timestamp: 3 },
      { type: "add", kind: "file", relativePath: "f.md", nodeId: "g", timestamp: 4 },
      { type: "focus", op: "mount", selection: {}, panelIndex: 0, timestamp: 5 },
    ],
  });
  const cites = citeDeltasOf(e);
  assert.equal(cites.length, 2);
  assert.equal(cites[0].role, "tag");
  assert.equal(cites[0].sourceEventId, "abc");
  assert.equal(cites[1].role, "inline");
  assert.equal(cites[1].sourceEventId, "def");
});

test("citeDeltasOf: no deltas field → empty", () => {
  assert.deepEqual(citeDeltasOf(fakeEvent({ steppedAt: 1 })), []);
});

test("citeDeltasOf: empty deltas array → empty", () => {
  assert.deepEqual(citeDeltasOf(fakeEvent({ deltas: [] })), []);
});

test("citeDeltasOf: only non-cite deltas → empty", () => {
  const e = fakeEvent({
    deltas: [{ type: "insert", position: { start: 0, end: 0 }, newValue: "x", timestamp: 1 }],
  });
  assert.deepEqual(citeDeltasOf(e), []);
});

test("citeDeltasOf: malformed JSON content → empty (no throw)", () => {
  const e = fakeEvent("not json at all");
  // Must not throw — a malformed event from a non-conforming producer degrades
  // to "no cites," same posture as citation verification (spec §3.9).
  assert.deepEqual(citeDeltasOf(e), []);
});

test("citeDeltasOf: null-ish delta entries are skipped", () => {
  // Defensive: a non-conforming producer might emit a sparse/null entry. The
  // filter guards with `d &&` so it doesn't throw on access.
  const e = fakeEvent({
    deltas: [null, { type: "cite", role: "tag", sourceEventId: "z" }, undefined],
  });
  const cites = citeDeltasOf(e);
  assert.equal(cites.length, 1);
  assert.equal(cites[0].sourceEventId, "z");
});

// --- classifyQEdge: the q-edge → inbound kind (the load-bearing logic) ----
//
// This is where the write/read asymmetry lives: the write path emits cite
// deltas only for `tag` and `reply`, NOT for `inline` bracket quotes (those
// emit a `q` tag + a body insert, no cite delta). So detection must treat any
// `q` edge into our chain as a citation, then split tag-vs-cite by the cite
// delta. Relying on the cite delta to detect the edge would silently miss every
// minted span quoted in a body — the bug this suite locks against regression.

test("classifyQEdge: inline bracket quote (q + no cite delta) → cite", () => {
  // A minted span quoted in a body: q-tag emitted, body insert carries the
  // [[ phrase | id ]] markup, NO cite delta. This is the common case that a
  // cite-delta-only approach would miss.
  const e = fileEvent([["q", "ourNode", ""]], {
    deltas: [{ type: "insert", position: { start: 0, end: 0 }, newValue: "[[ x | ourNode ]]", timestamp: 1 }],
  });
  assert.equal(classifyQEdge(e, "ourNode"), "cite");
});

test("classifyQEdge: active tag (q + cite role:tag) → tag", () => {
  const e = fileEvent([["q", "ourNode", ""]], {
    deltas: [{ type: "cite", role: "tag", op: "add", sourceEventId: "ourNode", timestamp: 1 }],
  });
  assert.equal(classifyQEdge(e, "ourNode"), "tag");
});

test("classifyQEdge: reply (q + cite role:reply, no tag delta) → cite", () => {
  const e = fileEvent([["q", "ourNode", ""]], {
    deltas: [{ type: "cite", role: "reply", op: "add", sourceEventId: "ourNode", timestamp: 1 }],
  });
  assert.equal(classifyQEdge(e, "ourNode"), "cite");
});

test("classifyQEdge: removed tag (op:remove) falls back to cite if q persists", () => {
  // A removed tag with the q edge still present classifies as cite (defensive —
  // in practice a removed tag drops the q too). The point: it must NOT be "tag".
  const e = fileEvent([["q", "ourNode", ""]], {
    deltas: [{ type: "cite", role: "tag", op: "remove", sourceEventId: "ourNode", timestamp: 1 }],
  });
  assert.equal(classifyQEdge(e, "ourNode"), "cite");
});

test("classifyQEdge: folder node q-citing our node → null (membership, not citation)", () => {
  // A folder that includes our file as a member: its q edge is composition at
  // the folder level, out of scope for a per-file inbound tracker.
  const e = folderEvent([["q", "ourNode", ""]], { snapshot: { members: [] } });
  assert.equal(classifyQEdge(e, "ourNode"), null);
});

test("classifyQEdge: LLM-scope node q-citing our node → null (in-context, not citation)", () => {
  // An action:llm node that had our trace in scope: flagged scope:llm. Provenance
  // about the call, not a citation of the content.
  const e = fileEvent(
    [["q", "ourNode", ""], ["scope", "llm"], ["action", "llm"]],
    { deltas: [], prompt: "rewrite this" },
  );
  assert.equal(classifyQEdge(e, "ourNode"), null);
});

test("structural q refs do not make an empty inbound snapshot incomplete", async () => {
  const targetIds = new Set(["ourNode"]);
  const refs = [
    {
      ...folderEvent([["q", "ourNode", ""]], { name: "workspace" }),
      id: "folder-ref",
    },
    {
      ...fileEvent(
        [
          ["q", "ourNode", ""],
          ["scope", "llm"],
        ],
        { snapshot: "prompt scope", deltas: [] },
      ),
      id: "scope-ref",
    },
  ];

  const citationRefs = filterInboundCitationRefs(refs, targetIds);
  let identityCalls = 0;
  const snapshot = await resolveInboundHeadSnapshot(citationRefs, async () => {
    identityCalls += 1;
    return null;
  });

  assert.deepEqual(citationRefs, []);
  assert.equal(identityCalls, 0);
  assert.deepEqual(snapshot, { heads: [], complete: true });
});

test("classifyQEdge: no q edge to targetId → null", () => {
  const e = fileEvent([["q", "otherNode", ""]], { deltas: [] });
  assert.equal(classifyQEdge(e, "ourNode"), null);
});

test("classifyQEdge: tag for a DIFFERENT node, q to ours → cite (not tag)", () => {
  // The cite delta's sourceEventId must match targetId. A node that tags X and
  // quotes our node should classify our edge as cite, not tag.
  const e = fileEvent(
    [["q", "ourNode", ""], ["q", "xNode", ""]],
    {
      deltas: [{ type: "cite", role: "tag", op: "add", sourceEventId: "xNode", timestamp: 1 }],
    },
  );
  assert.equal(classifyQEdge(e, "ourNode"), "cite");
  assert.equal(classifyQEdge(e, "xNode"), "tag");
});

// --- current-source filtering -------------------------------------------

test("historical q hits resolve to the source tombstone instead of staying visible", async () => {
  const cited = sourceEvent("a1", "A.md", ["b1"]);
  const removed = sourceEvent("a2", "A.md", [], "a1", "delete");

  const heads = await resolveInboundSourceHeads([cited], async (folderId, path) => {
    assert.equal(folderId, "source-folder");
    assert.equal(path, "A.md");
    return [cited, removed];
  });

  assert.deepEqual(heads.map((event) => event.id), ["a2"]);
  assert.deepEqual(inboundCitationsFromHeads(heads, new Set(["b1"])), []);
});

test("historical q hits collapse to one current citing head", async () => {
  const first = sourceEvent("a1", "A.md", ["b1"]);
  const current = sourceEvent("a2", "A.md", ["b1"], "a1");
  const heads = await resolveInboundSourceHeads([first, current], async () => [first, current]);

  assert.deepEqual(
    inboundCitationsFromHeads(heads, new Set(["b1"])).map((entry) => entry.sourceEventId),
    ["a2"],
  );
});

test("a remote path named Oblivion is not treated as a lifecycle signal", () => {
  const oblivionNamedSource = sourceEvent("a-oblivion", "oblivion/2026-07-15_120000/A.md", ["b1"]);
  assert.deepEqual(
    inboundCitationsFromHeads([oblivionNamedSource], new Set(["b1"])).map((entry) => entry.sourceEventId),
    ["a-oblivion"],
  );
});

test("stable source resolution follows a moved trace to its current head", async () => {
  const cited = sourceEvent("a1", "A.md", ["b1"]);
  const moved = sourceEvent("a2", "Elsewhere/A.md", ["b1"], "a1");
  const snapshot = await resolveInboundHeadSnapshot(
    [cited],
    async () => "a1",
    async (traceId, fallback) => {
      assert.equal(traceId, "a1");
      assert.deepEqual(fallback, { folderId: "source-folder", relativePath: "A.md" });
      return { status: "resolved", traceId, chain: [cited, moved], source: "trace-head" };
    },
  );

  assert.equal(snapshot.complete, true);
  assert.deepEqual(
    inboundCitationsFromResolvedHeads(snapshot.heads, new Set(["b1"])).map((entry) => ({
      traceId: entry.sourceTraceId,
      head: entry.sourceEventId,
      path: entry.sourcePath,
    })),
    [{ traceId: "a1", head: "a2", path: "Elsewhere/A.md" }],
  );
});

test("failed current-head resolution is incomplete and never falls back historically", async () => {
  const cited = sourceEvent("a1", "A.md", ["b1"]);
  const snapshot = await resolveInboundHeadSnapshot(
    [cited],
    async () => "a1",
    async (traceId) => ({ status: "missing", traceId, chain: [], candidateHeadIds: [] }),
  );
  assert.equal(snapshot.complete, false);
  assert.deepEqual(snapshot.heads, []);
});

test("cached inbound rows hide a source as soon as its local head enters Oblivion", () => {
  const inbound = [
    {
      kind: "cite" as const,
      sourceTraceId: "a-genesis",
      sourceEventId: "a2",
      fromNodeId: "b1",
      ownerPubkey: "pk-a",
    },
    { kind: "cite" as const, sourceEventId: "c1", fromNodeId: "b1", ownerPubkey: "pk-c" },
  ];
  assert.deepEqual(excludeInboundSources(inbound, new Set(["a-genesis"])), [inbound[1]]);
});

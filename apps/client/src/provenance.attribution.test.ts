/**
 * Tests for the per-character attribution path: the `authors` field on a
 * FileTraceNode and `reconstructRunsFromChain`'s three-tier attribution.
 *
 * The motivating bug: editing attributed text, then reloading, collapsed the
 * whole block to a single voice (the stepping signer) because the protocol
 * carried one author per node. The `authors` field is the additive fix — a
 * run list aligned to `snapshot` that survives reload anywhere the chain is
 * read. These tests pin the three behaviors that matter:
 *
 *  1. buildAuthors / parseAuthors round-trip (and rejection of mismatches).
 *  2. reconstructRunsFromChain adopts a valid `authors` map verbatim, so a
 *     multi-author document keeps its attribution instead of collapsing.
 *  3. A node without `authors` uses per-node-signer attribution.
 *
 * Wire shape is `{v, len, src?}` per protocol §3.6: runs carry NO text (the
 * body lives once, in `snapshot`), only a UTF-16 length. parseAuthors
 * validates by partitioning `snapshot` at the accumulated offsets.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  authorsFromMergeParent,
  attributeDeltas,
  buildAuthors,
  parseAuthors,
  reconstructRunsFromChain,
} from "./provenance.js";
import type { EditorDelta } from "./provenance.js";
import type { Run } from "./workspace-core.js";

// Minimal fake-event shape — only the fields reconstructRunsFromChain reads.
type FakeEvent = {
  id: string;
  pubkey: string;
  content: string;
};

/** Build a kind-4290-style content body for a node. */
function nodeContent(opts: {
  snapshot: string;
  deltas?: unknown[];
  authors?: unknown;
  voices?: string[];
}): string {
  return JSON.stringify({
    snapshot: opts.snapshot,
    deltas: opts.deltas ?? [],
    contentHash: "unused-by-these-tests",
    ...(opts.authors !== undefined ? { authors: opts.authors } : {}),
    ...(opts.voices !== undefined ? { voices: opts.voices } : {}),
  });
}

const A = "aaaa".repeat(8); // pubkey A
const B = "bbbb".repeat(8); // pubkey B

// --- buildAuthors / parseAuthors round-trip -------------------------------

test("buildAuthors serializes runs to {v,len} entries (no text, per §3.6)", () => {
  const runs: Run[] = [
    { voice: A, text: "hello " },
    { voice: B, text: "world" },
  ];
  assert.deepEqual(buildAuthors(runs), [
    { v: A, len: 6 },
    { v: B, len: 5 },
  ]);
});

test("buildAuthors preserves src on merge-parent runs (§3.6 verification)", () => {
  // Merge nodes attribute foreign text to B with src = the merge-parent node.
  const parentNodeId = "f2".repeat(32);
  const runs: Run[] = [
    { voice: A, text: "mine ", src: "n3".repeat(32) },
    { voice: B, text: "theirs", src: parentNodeId },
  ];
  assert.deepEqual(buildAuthors(runs), [
    { v: A, len: 5, src: "n3".repeat(32) },
    { v: B, len: 6, src: parentNodeId },
  ]);
});

test("buildAuthors merges adjacent same-voice runs defensively", () => {
  // A caller can hand us a list with adjacent duplicates (e.g. after a slice).
  const runs: Run[] = [
    { voice: A, text: "he" },
    { voice: A, text: "llo" },
    { voice: B, text: "!" },
  ];
  assert.deepEqual(buildAuthors(runs), [
    { v: A, len: 5 },
    { v: B, len: 1 },
  ]);
});

test("buildAuthors does not merge adjacent same-voice runs with different src", () => {
  // Two contributions from the same pubkey via different parent nodes stay
  // distinct so verification can name each corroborating node.
  const runs: Run[] = [
    { voice: B, text: "aa", src: "p1".repeat(32) },
    { voice: B, text: "bb", src: "p2".repeat(32) },
  ];
  assert.deepEqual(buildAuthors(runs), [
    { v: B, len: 2, src: "p1".repeat(32) },
    { v: B, len: 2, src: "p2".repeat(32) },
  ]);
});

test("buildAuthors drops empty runs", () => {
  const runs: Run[] = [
    { voice: A, text: "" },
    { voice: A, text: "x" },
  ];
  assert.deepEqual(buildAuthors(runs), [{ v: A, len: 1 }]);
});

test("parseAuthors round-trips buildAuthors output", () => {
  const runs: Run[] = [
    { voice: A, text: "one " },
    { voice: B, text: "two" },
  ];
  const snapshot = "one two";
  const parsed = parseAuthors(buildAuthors(runs), snapshot);
  assert.deepEqual(parsed, runs);
});

test("parseAuthors round-trips src and keeps different-src runs separate", () => {
  const p1 = "p1".repeat(32);
  const p2 = "p2".repeat(32);
  const runs: Run[] = [
    { voice: B, text: "aa", src: p1 },
    { voice: B, text: "bb", src: p2 },
  ];
  const parsed = parseAuthors(buildAuthors(runs), "aabb");
  assert.deepEqual(parsed, runs);
});

test("parseAuthors returns null when lengths don't sum to snapshot (integrity)", () => {
  // A forged/stale map whose run lengths don't cover the snapshot is treated
  // as missing — the caller falls back to per-node-signer attribution.
  const authors = [{ v: A, len: 99 }];
  assert.equal(parseAuthors(authors, "actual text"), null);
});

test("parseAuthors returns null for absent or malformed input", () => {
  assert.equal(parseAuthors(undefined, "x"), null);
  assert.equal(parseAuthors(null, "x"), null);
  assert.equal(parseAuthors("not-an-array", "x"), null);
  assert.equal(parseAuthors([{ v: A }], "x"), null); // missing len
  assert.equal(parseAuthors([{ len: 1 }], "x"), null); // missing v
  assert.equal(parseAuthors([{ v: 123, len: 1 }], "x"), null); // wrong type
  assert.equal(parseAuthors([{ v: A, len: 1.5 }], "x"), null); // non-integer len
  assert.equal(parseAuthors([{ v: A, len: -1 }], "x"), null); // negative len
});

test("parseAuthors partitions snapshot by accumulated lengths", () => {
  // The core of the §3.6 shape: runs carry length only, and parseAuthors
  // recovers the text by slicing snapshot at the cumulative offsets.
  const authors = [
    { v: A, len: 2 },
    { v: A, len: 3 },
    { v: B, len: 1 },
  ];
  assert.deepEqual(parseAuthors(authors, "hello!"), [
    { voice: A, text: "hello" },
    { voice: B, text: "!" },
  ]);
});

test("authorsFromMergeParent attributes the whole body to the parent with src", () => {
  const parentNodeId = "f2".repeat(32);
  const snapshot = "text from B's fork";
  assert.deepEqual(authorsFromMergeParent(B, parentNodeId, snapshot), [
    { voice: B, text: snapshot, src: parentNodeId },
  ]);
  assert.deepEqual(authorsFromMergeParent(B, parentNodeId, ""), []);
  // Wire shape: one run, full length, src names the merge-parent for §3.6.
  assert.deepEqual(buildAuthors(authorsFromMergeParent(B, parentNodeId, snapshot)), [
    { v: B, len: snapshot.length, src: parentNodeId },
  ]);
});

// --- reconstructRunsFromChain: the authors-aware path (the fix) -----------

test("reconstructRunsFromChain adopts a valid authors map verbatim", () => {
  // A node authored half by A, half by B, carrying its authors map. On reload
  // the attribution is preserved — NOT collapsed to the signer.
  const snapshot = "hello world";
  const chain: FakeEvent[] = [
    {
      id: "n1",
      pubkey: B, // signer is B (the step key)
      content: nodeContent({
        snapshot,
        authors: [
          { v: A, len: 6 }, // but A wrote the first half
          { v: B, len: 5 },
        ],
      }),
    },
  ];
  const runs = reconstructRunsFromChain(chain as never);
  assert.deepEqual(runs, [
    { voice: A, text: "hello " },
    { voice: B, text: "world" },
  ]);
});

test("reconstructRunsFromChain: a later node with authors snaps to its truth", () => {
  // Genesis by A, then an edit by B that inserts into the middle. B's node
  // carries an authors map describing the *resulting* multi-author document.
  // Without authors, the old code attributed the whole insert (and on the
  // no-delta branch, the whole snapshot) to B — collapsing A's contribution.
  const chain: FakeEvent[] = [
    {
      id: "g1",
      pubkey: A,
      content: nodeContent({ snapshot: "hello world" }),
    },
    {
      id: "e1",
      pubkey: B,
      content: nodeContent({
        snapshot: "hello NEW world",
        authors: [
          { v: A, len: 6 },
          { v: B, len: 4 },
          { v: A, len: 5 },
        ],
      }),
    },
  ];
  const runs = reconstructRunsFromChain(chain as never);
  assert.deepEqual(runs, [
    { voice: A, text: "hello " },
    { voice: B, text: "NEW " },
    { voice: A, text: "world" },
  ]);
});

test("reconstructRunsFromChain: tag-only node with authors preserves attribution", () => {
  // The bug's no-delta branch: a node whose snapshot matches prev but carries
  // no content deltas (a tag/reply-only edit) used to wholesale-reset to the
  // signer IF the snapshot string-compare tripped. With authors present, the
  // map is adopted instead — the tagger never steals the document.
  const chain: FakeEvent[] = [
    {
      id: "g1",
      pubkey: A,
      content: nodeContent({
        snapshot: "hello world",
        authors: [{ v: A, len: 11 }],
      }),
    },
    {
      id: "t1",
      pubkey: B, // B tags the doc, doesn't touch text
      content: nodeContent({
        snapshot: "hello world",
        authors: [{ v: A, len: 11 }], // still all A's text
      }),
    },
  ];
  const runs = reconstructRunsFromChain(chain as never);
  assert.deepEqual(runs, [{ voice: A, text: "hello world" }]);
});

test("reconstructRunsFromChain: a stale/mismatched authors map falls back to signer", () => {
  // If authors lengths don't sum to snapshot, parseAuthors returns null and
  // the node degrades to per-node-signer attribution. This
  // is the integrity guard: a forged or drifted map can't mis-attribute.
  const chain: FakeEvent[] = [
    {
      id: "n1",
      pubkey: B,
      content: nodeContent({
        snapshot: "actual content",
        authors: [{ v: A, len: 99 }], // doesn't match (14 != 99)
      }),
    },
  ];
  const runs = reconstructRunsFromChain(chain as never);
  assert.deepEqual(runs, [{ voice: B, text: "actual content" }]);
});

// --- reconstructRunsFromChain: signer-default path ------------------------

test("reconstructRunsFromChain: nodes without authors attribute by signer", () => {
  // A genesis by A, then an edit by B that
  // inserts text — B's insert is attributed to B, A's surrounding text to A.
  const chain: FakeEvent[] = [
    {
      id: "g1",
      pubkey: A,
      content: nodeContent({ snapshot: "hello world" }),
    },
    {
      id: "e1",
      pubkey: B,
      content: nodeContent({
        snapshot: "hello B world",
        deltas: [
          {
            type: "insert",
            position: { start: 6, end: 6 },
            newValue: "B ",
          },
        ],
      }),
    },
  ];
  const runs = reconstructRunsFromChain(chain as never);
  assert.deepEqual(runs, [
    { voice: A, text: "hello " },
    { voice: B, text: "B " },
    { voice: A, text: "world" },
  ]);
});

test("reconstructRunsFromChain: empty chain yields []", () => {
  assert.deepEqual(reconstructRunsFromChain([]), []);
});

test("reconstructRunsFromChain: a later authors snapshot replaces signer-default attribution", () => {
  // A signer-attributed genesis, then an edit node carrying authors. The later
  // authors map is adopted verbatim — it describes the whole resulting document,
  // so the genesis's attribution is
  // superseded by the map at the point the map arrives.
  const chain: FakeEvent[] = [
    {
      id: "g1",
      pubkey: A,
      content: nodeContent({ snapshot: "hello world" }),
    },
    {
      id: "e1",
      pubkey: B,
      content: nodeContent({
        snapshot: "hello brave world",
        authors: [
          { v: A, len: 6 },
          { v: B, len: 6 },
          { v: A, len: 5 },
        ],
      }),
    },
  ];
  const runs = reconstructRunsFromChain(chain as never);
  assert.deepEqual(runs, [
    { voice: A, text: "hello " },
    { voice: B, text: "brave " },
    { voice: A, text: "world" },
  ]);
});

test("reconstructRunsFromChain: body deltas take priority over an authors map", () => {
  // Current nodes treat per-delta attribution as primary. An unannotated body
  // delta belongs to the signer even if a conflicting authors map is present.
  const chain: FakeEvent[] = [
    {
      id: "g1",
      pubkey: A,
      content: nodeContent({
        snapshot: "human ",
        deltas: [
          { type: "insert", position: { start: 0, end: 0 }, newValue: "human ", timestamp: 1 },
        ],
      }),
    },
    {
      id: "e1",
      pubkey: A,
      content: nodeContent({
        snapshot: "human model",
        authors: [
          { v: A, len: 6 },
          { v: B, len: 5 },
        ],
        deltas: [
          { type: "insert", position: { start: 6, end: 6 }, newValue: "model", timestamp: 2 },
        ],
      }),
    },
  ];

  assert.deepEqual(reconstructRunsFromChain(chain as never), [
    { voice: A, text: "human model" },
  ]);
});

// --- per-delta attribution (§3.3, §3.6 — the voices table + author index) --
//
// Body-edit deltas now carry an OPTIONAL `author` index into a node-local
// `voices` table. Reconstruction's Tier-2 (delta-insert path) resolves each
// delta's voice through that table, defaulting to the signer when the index is
// absent, missing, or out of range. These tests pin the per-delta path and its
// priority over the node-snapshot carrier.

test("attributeDeltas: mono-author delta (signer) leaves authorIndex unset, no voices", () => {
  // A delta whose dominant voice is the signer emits no authorIndex and no
  // voices table, keeping mono-author nodes compact.
  const deltas: EditorDelta[] = [
    { type: "insert", positionStart: 0, positionEnd: 0, newValue: "hello", timestamp: 1 },
  ];
  const runs: Run[] = [{ voice: A, text: "hello" }];
  const { deltas: out, voices } = attributeDeltas(deltas, runs, A);
  assert.deepEqual(out, deltas); // unchanged — no authorIndex added
  assert.deepEqual(voices, []); // empty → caller omits the field
});

test("attributeDeltas: non-signer delta gets authorIndex + voices table with signer at [0]", () => {
  const deltas: EditorDelta[] = [
    { type: "insert", positionStart: 0, positionEnd: 0, newValue: "world", timestamp: 1 },
  ];
  const runs: Run[] = [{ voice: B, text: "world" }];
  const { deltas: out, voices } = attributeDeltas(deltas, runs, A);
  assert.deepEqual(voices, [A, B]); // signer first, then the non-signer voice
  assert.equal(out[0].authorIndex, 1); // B is at index 1
});

test("attributeDeltas: mixed-voice region attributes to the dominant voice", () => {
  // A region split 4 chars A / 2 chars B → dominantVoiceInRegion returns A (the
  // signer), so no authorIndex is set. This is the honest call: the delta's
  // net content is majority-signer.
  const deltas: EditorDelta[] = [
    { type: "insert", positionStart: 0, positionEnd: 0, newValue: "aabbbb", timestamp: 1 },
  ];
  const runs: Run[] = [
    { voice: A, text: "aa" },
    { voice: B, text: "bbbb" },
  ];
  const { deltas: out, voices } = attributeDeltas(deltas, runs, A);
  // B dominates (4 vs 2) → authorIndex 1, voices [A, B]
  assert.equal(out[0].authorIndex, 1);
  assert.deepEqual(voices, [A, B]);
});

test("attributeDeltas: pure delete (no inserted text) leaves authorIndex unset", () => {
  const deltas: EditorDelta[] = [
    { type: "delete", positionStart: 0, positionEnd: 5, newValue: "", timestamp: 1 },
  ];
  const runs: Run[] = [{ voice: B, text: "" }]; // post-delete, nothing inserted
  const { deltas: out, voices } = attributeDeltas(deltas, runs, A);
  assert.deepEqual(out, deltas);
  assert.deepEqual(voices, []);
});

test("reconstructRunsFromChain: per-delta author attributes insert to the named voice", () => {
  // A node signed by A (signer = voices[0]) with a delta authored by B (index 1),
  // no authors map. The inserted chars should attribute to B, not A.
  const chain: FakeEvent[] = [
    {
      id: "g1",
      pubkey: A,
      content: nodeContent({ snapshot: "" }),
    },
    {
      id: "e1",
      pubkey: A, // signer is A
      content: nodeContent({
        snapshot: "world",
        voices: [A, B], // B is index 1
        deltas: [
          { type: "insert", position: { start: 0, end: 0 }, newValue: "world", author: 1, timestamp: 1 },
        ],
      }),
    },
  ];
  const runs = reconstructRunsFromChain(chain as never);
  assert.deepEqual(runs, [{ voice: B, text: "world" }]);
});

test("reconstructRunsFromChain: delta with no author field defaults to signer", () => {
  // The default-to-signer rule: a delta without `author` attributes to
  // event.pubkey.
  const chain: FakeEvent[] = [
    {
      id: "e1",
      pubkey: A,
      content: nodeContent({
        snapshot: "hi",
        voices: [A], // table present but delta doesn't use it
        deltas: [
          { type: "insert", position: { start: 0, end: 0 }, newValue: "hi", timestamp: 1 },
        ],
      }),
    },
  ];
  const runs = reconstructRunsFromChain(chain as never);
  assert.deepEqual(runs, [{ voice: A, text: "hi" }]);
});

test("reconstructRunsFromChain: out-of-range author index degrades to signer", () => {
  // author: 99 on a 2-element voices table → signer, not malformed. The node
  // is still valid; only that delta is under-attributed.
  const chain: FakeEvent[] = [
    {
      id: "e1",
      pubkey: A,
      content: nodeContent({
        snapshot: "hi",
        voices: [A, B],
        deltas: [
          { type: "insert", position: { start: 0, end: 0 }, newValue: "hi", author: 99, timestamp: 1 },
        ],
      }),
    },
  ];
  const runs = reconstructRunsFromChain(chain as never);
  assert.deepEqual(runs, [{ voice: A, text: "hi" }]);
});

test("reconstructRunsFromChain: missing voices table with author field degrades to signer", () => {
  // A node that references author: 1 but carries no voices table at all (e.g.
  // a reader that strips unknown fields). Default-to-signer.
  const chain: FakeEvent[] = [
    {
      id: "e1",
      pubkey: A,
      content: nodeContent({
        snapshot: "hi",
        deltas: [
          { type: "insert", position: { start: 0, end: 0 }, newValue: "hi", author: 1, timestamp: 1 },
        ],
      }),
    },
  ];
  const runs = reconstructRunsFromChain(chain as never);
  assert.deepEqual(runs, [{ voice: A, text: "hi" }]);
});

test("reconstructRunsFromChain: per-delta author wins over the secondary authors map", () => {
  // Protocol §3.6: per-delta attribution is primary. When a node carries both
  // forms and they disagree, the delta owns the span it covers; `authors` is a
  // secondary carrier for nodes without body deltas.
  const chain: FakeEvent[] = [
    {
      id: "e1",
      pubkey: A,
      content: nodeContent({
        snapshot: "hello world",
        voices: [A, B],
        authors: [
          { v: A, len: 6 }, // authors says A wrote "hello "
          { v: B, len: 5 }, // and B wrote "world"
        ],
        deltas: [
          // Per-delta says B authored the whole insert.
          { type: "insert", position: { start: 0, end: 0 }, newValue: "hello world", author: 1, timestamp: 1 },
        ],
      }),
    },
  ];
  const runs = reconstructRunsFromChain(chain as never);
  assert.deepEqual(runs, [{ voice: B, text: "hello world" }]);
});

test("reconstructRunsFromChain: mixed chain — authors on one node, per-delta on next", () => {
  // Node 1 has an authors map (Tier 1); node 2 has per-delta only (Tier 2).
  // Reconstruction should adopt authors for node 1, per-delta for node 2.
  const chain: FakeEvent[] = [
    {
      id: "g1",
      pubkey: A,
      content: nodeContent({
        snapshot: "hello",
        authors: [{ v: A, len: 5 }],
      }),
    },
    {
      id: "e1",
      pubkey: A,
      content: nodeContent({
        snapshot: "hello world",
        voices: [A, B],
        deltas: [
          { type: "insert", position: { start: 5, end: 5 }, newValue: " world", author: 1, timestamp: 1 },
        ],
      }),
    },
  ];
  const runs = reconstructRunsFromChain(chain as never);
  assert.deepEqual(runs, [
    { voice: A, text: "hello" },
    { voice: B, text: " world" },
  ]);
});

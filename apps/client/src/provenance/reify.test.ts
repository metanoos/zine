import assert from "node:assert/strict";
import test from "node:test";

import type { Event, EventTemplate } from "nostr-tools";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";

import {
  prepareReifyExport,
  renderTraceReport,
  traceSidecarEntries,
} from "./reify.js";

const SECRET = Uint8Array.from([
  0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 1,
]);
const OTHER_SECRET = Uint8Array.from([
  0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 2,
]);
const ROOT = "f".repeat(64);
const TEST_OPERATION_ID = "1".repeat(64);

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Buffer.from(digest).toString("hex");
}

async function fileNode(
  snapshot: string,
  createdAt: number,
  previous?: Event,
  contentHash?: string,
  secret = SECRET,
): Promise<Event> {
  const previousSnapshot = previous
    ? (JSON.parse(previous.content) as { snapshot: string }).snapshot
    : "";
  const voice = getPublicKey(secret);
  const tags = [
    ["z", "file"],
    ["F", "essay.md"],
    ["f", ROOT],
    ["action", previous ? "edit" : "import"],
  ];
  if (previous) tags.push(["e", previous.id, "", "prev"]);
  const template: EventTemplate = {
    kind: 4290,
    created_at: createdAt,
    tags,
    content: JSON.stringify({
      snapshot,
      contentHash: contentHash ?? await sha256Hex(snapshot),
      operationId: TEST_OPERATION_ID,
      editorTransactions: previousSnapshot === snapshot
        ? []
        : [{
            sequence: 0,
            timestamp: createdAt * 1000,
            actor: voice,
            changes: [{
              op: previousSnapshot.length === 0 ? "insert" : snapshot.length === 0 ? "delete" : "replace",
              from: 0,
              to: previousSnapshot.length,
              text: snapshot,
            }],
            selectionBefore: null,
            selectionAfter: null,
          }],
    }),
  };
  return finalizeEvent(template, secret);
}

function loader(events: readonly Event[]) {
  const byId = new Map(events.map((event) => [event.id, event]));
  return async (nodeId: string): Promise<Event | null> => byId.get(nodeId) ?? null;
}

test("Reify writes the chosen signed snapshot, never caller-owned working text", async () => {
  const genesis = await fileNode("first stepped version\n", 1_700_000_000);
  const head = await fileNode("exact nucleus\n", 1_700_000_100, genesis);

  const exported = await prepareReifyExport(
    [{ relativePath: "essay.md", nucleusId: head.id }],
    loader([genesis, head]),
  );

  assert.deepEqual(exported.entries, [
    { relativePath: "essay.md", content: "exact nucleus\n" },
  ]);
  assert.equal(exported.trace, undefined);
  assert.deepEqual(exported.conformance.map((target) => target.status), ["full"]);
});

test("optional trace keeps raw signed events separate and reports from the bundle", async () => {
  const genesis = await fileNode("draft\n", 1_700_000_000);
  const head = await fileNode("finished\n", 1_700_000_100, genesis);

  const exported = await prepareReifyExport(
    [{ relativePath: "essay.md", nucleusId: head.id }],
    loader([genesis, head]),
    true,
  );
  assert.ok(exported.trace);
  assert.equal(exported.trace.format, "zine-trace");
  assert.deepEqual(exported.trace.targets, [
    {
      relativePath: "essay.md",
      traceId: genesis.id,
      nucleusId: head.id,
      eventIds: [genesis.id, head.id],
      conformance: "full",
      conformanceIssues: [],
    },
  ]);
  assert.deepEqual(exported.trace.events, [genesis, head]);

  const sidecars = traceSidecarEntries(exported.trace);
  assert.deepEqual(sidecars.map((entry) => entry.relativePath), [
    ".zine/trace.json",
    ".zine/report.md",
  ]);
  const parsed = JSON.parse(sidecars[0].content) as { events: Event[] };
  assert.equal(parsed.events[1].content, head.content);
  assert.equal(parsed.events[1].id, head.id);
  assert.equal(parsed.events[1].sig, head.sig);

  const report = renderTraceReport(exported.trace);
  assert.match(report, /raw signed events are authoritative/i);
  assert.match(report, /FULL TRACE/);
  assert.match(report, /essay\.md/);
  assert.match(report, /\| 0 \|.*import/);
  assert.match(report, /\| 1 \|.*edit/);
  assert.doesNotMatch(report, /finished/);
});

test("ordinary Reify preserves a readable nucleus while labeling private ancestry snapshot-only", async () => {
  const genesis = await fileNode("private draft\n", 1_700_000_000);
  const head = await fileNode("shared result\n", 1_700_000_100, genesis);
  const exported = await prepareReifyExport(
    [{ relativePath: "essay.md", nucleusId: head.id }],
    loader([head]),
  );

  assert.equal(exported.entries[0]?.content, "shared result\n");
  assert.equal(exported.conformance[0]?.status, "snapshot-only");
  assert.ok(exported.conformance[0]?.issues.some((issue) => issue.code === "history-incomplete"));
});

test("Reify rejects an invalid signature and a signed snapshot-hash mismatch", async () => {
  const valid = await fileNode("valid\n", 1_700_000_000);
  const tampered = { ...valid, sig: "0".repeat(128) };
  await assert.rejects(
    prepareReifyExport(
      [{ relativePath: "essay.md", nucleusId: valid.id }],
      loader([tampered]),
    ),
    /invalid id or signature/,
  );

  const wrongHash = await fileNode(
    "signed but inconsistent\n",
    1_700_000_001,
    undefined,
    "0".repeat(64),
  );
  await assert.rejects(
    prepareReifyExport(
      [{ relativePath: "essay.md", nucleusId: wrongHash.id }],
      loader([wrongHash]),
    ),
    /snapshot hash mismatch/,
  );
});

test("Reify requires an explicit file discriminator", async () => {
  const snapshot = "untyped\n";
  const untyped = finalizeEvent({
    kind: 4290,
    created_at: 1_700_000_000,
    tags: [["F", "essay.md"], ["action", "import"]],
    content: JSON.stringify({ snapshot, contentHash: await sha256Hex(snapshot) }),
  }, SECRET);

  await assert.rejects(
    prepareReifyExport(
      [{ relativePath: "essay.md", nucleusId: untyped.id }],
      loader([untyped]),
    ),
    /not a file TraceNode/,
  );
});

test("Reify rejects a prev chain that changes owner", async () => {
  const genesis = await fileNode("foreign draft\n", 1_700_000_000, undefined, undefined, OTHER_SECRET);
  const head = await fileNode("owned result\n", 1_700_000_100, genesis);

  await assert.rejects(
    prepareReifyExport(
      [{ relativePath: "essay.md", nucleusId: head.id }],
      loader([genesis, head]),
      true,
    ),
    /prev chain changes owner/,
  );
});

test("trace ancestry must be complete and acyclic", async () => {
  const genesis = await fileNode("draft\n", 1_700_000_000);
  const head = await fileNode("finished\n", 1_700_000_100, genesis);

  await assert.rejects(
    prepareReifyExport(
      [{ relativePath: "essay.md", nucleusId: head.id }],
      loader([head]),
      true,
    ),
    /could not fetch nucleus/,
  );
});

import assert from "node:assert/strict";
import test from "node:test";

import type { Event, EventTemplate } from "nostr-tools";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";

import {
  combineTraceConformance,
  inspectFileTraceNucleus,
  traceConformanceLabel,
  verifyFileTraceChain,
} from "./trace-conformance.js";

const SECRET = Uint8Array.from([...new Uint8Array(31), 1]);
const OTHER_SECRET = Uint8Array.from([...new Uint8Array(31), 2]);
const OWNER = getPublicKey(SECRET);
const ROOT = "f".repeat(64);

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Buffer.from(digest).toString("hex");
}

async function fileNode(
  before: string,
  snapshot: string,
  previous?: Event,
  options: {
    secret?: Uint8Array;
    kedits?: unknown;
    contentHash?: string;
    deltas?: unknown;
    prevTarget?: string;
  } = {},
): Promise<Event> {
  const voice = getPublicKey(options.secret ?? SECRET);
  const hasPrevious = previous !== undefined || options.prevTarget !== undefined;
  const previousId = options.prevTarget ?? previous?.id;
  const kedits = options.kedits ?? (before === snapshot
    ? []
    : [{
        op: before.length === 0 ? "ins" : snapshot.length === 0 ? "del" : "repl",
        from: 0,
        to: before.length,
        text: snapshot,
        voice,
        t: 1_700_000_000_000 + (hasPrevious ? 1 : 0),
        tx: 0,
      }]);
  const template: EventTemplate = {
    kind: 4290,
    created_at: 1_700_000_000 + (hasPrevious ? 1 : 0),
    tags: [
      ["z", "file"],
      ["F", "essay.md"],
      ["f", ROOT],
      ["action", hasPrevious ? "edit" : "import"],
      ...(hasPrevious ? [["e", previousId ?? "", "", "prev"]] : []),
    ],
    content: JSON.stringify({
      snapshot,
      contentHash: options.contentHash ?? await sha256Hex(snapshot),
      ...(options.deltas !== undefined ? { deltas: options.deltas } : {}),
      ...(options.kedits === null ? {} : { kedits }),
    }),
  };
  return finalizeEvent(template, options.secret ?? SECRET);
}

test("shared verifier distinguishes Full Trace from readable snapshot-only process", async () => {
  const genesis = await fileNode("", "draft");
  const head = await fileNode("draft", "final", genesis);
  const full = await verifyFileTraceChain([genesis, head]);
  assert.equal(full.status, "full");
  assert.deepEqual(full.steps.map((step) => step.status), ["full", "full"]);
  assert.equal(traceConformanceLabel(full.status), "FULL TRACE");

  const missingProcess = await fileNode("", "readable", undefined, { kedits: null });
  const snapshotOnly = await verifyFileTraceChain([missingProcess]);
  assert.equal(snapshotOnly.status, "snapshot-only");
  assert.equal(snapshotOnly.issues[0]?.kind, "process");
  assert.equal(traceConformanceLabel(snapshotOnly.status), "SNAPSHOT ONLY");
});

test("a mismatched KEdit log downgrades process without invalidating signed text", async () => {
  const event = await fileNode("", "signed snapshot", undefined, {
    kedits: [{
      op: "ins",
      from: 0,
      to: 0,
      text: "different",
      voice: OWNER,
      t: 1,
      tx: 0,
    }],
  });
  const verdict = await verifyFileTraceChain([event]);
  assert.equal(verdict.status, "snapshot-only");
  assert.match(verdict.issues[0]?.message ?? "", /do not reproduce/);
});

test("invalid signatures, hashes, and lineage are invalid rather than snapshot-only", async () => {
  const genesis = await fileNode("", "draft");
  const head = await fileNode("draft", "final", genesis);
  const badSignature = { ...genesis, sig: "0".repeat(128) };
  assert.equal((await verifyFileTraceChain([badSignature])).status, "invalid");

  const badHash = await fileNode("", "body", undefined, { contentHash: "0".repeat(64) });
  const badHashVerdict = await verifyFileTraceChain([badHash]);
  assert.equal(badHashVerdict.status, "invalid");
  assert.ok(badHashVerdict.issues.some((issue) => issue.code === "snapshot-hash-mismatch"));

  const foreign = await fileNode("draft", "foreign", genesis, { secret: OTHER_SECRET });
  const ownerVerdict = await verifyFileTraceChain([genesis, foreign]);
  assert.equal(ownerVerdict.status, "invalid");
  assert.ok(ownerVerdict.issues.some((issue) => issue.code === "owner-changed"));

  const broken = await verifyFileTraceChain([head]);
  assert.equal(broken.status, "invalid");
  assert.ok(broken.issues.some((issue) => issue.code === "non-genesis-start"));
  assert.equal(traceConformanceLabel(broken.status), "INVALID");
});

test("private missing ancestry leaves an exact nucleus snapshot-only", async () => {
  const genesis = await fileNode("", "private");
  const head = await fileNode("private", "shared", genesis);
  const inspection = await inspectFileTraceNucleus(head, async () => null);
  assert.equal(inspection.historyComplete, false);
  assert.equal(inspection.missingPreviousNodeId, genesis.id);
  assert.equal(inspection.verdict.status, "snapshot-only");
  assert.ok(inspection.verdict.issues.some((issue) => issue.code === "history-incomplete"));
});

test("malformed prev targets are invalid rather than private history", async () => {
  for (const prevTarget of ["", "not-a-node-id"]) {
    let loads = 0;
    const event = await fileNode("private", "shared", undefined, { prevTarget });
    const inspection = await inspectFileTraceNucleus(event, async () => {
      loads += 1;
      return null;
    });
    assert.equal(inspection.verdict.status, "invalid");
    assert.ok(inspection.verdict.issues.some((issue) => issue.code === "malformed-prev"));
    assert.equal(loads, 0);
  }
});

test("signed deltas must reproduce the snapshot before a node is Full Trace", async () => {
  const genesis = await fileNode("", "draft");
  const head = await fileNode("draft", "final", genesis, {
    deltas: [{
      type: "replace",
      position: { start: 0, end: 5 },
      newValue: "forged",
      timestamp: 1_700_000_000_001,
    }],
  });
  const verdict = await verifyFileTraceChain([genesis, head]);
  assert.equal(verdict.status, "invalid");
  assert.ok(verdict.issues.some((issue) => issue.code === "nonconforming-deltas"));
  assert.equal(verdict.steps[1]?.status, "invalid");
});

test("combined reader verdict keeps integrity precedence", async () => {
  const full = await verifyFileTraceChain([await fileNode("", "full")]);
  const snapshotOnly = await verifyFileTraceChain([
    await fileNode("", "snapshot", undefined, { kedits: null }),
  ]);
  const invalid = await verifyFileTraceChain([
    { ...(await fileNode("", "invalid")), sig: "0".repeat(128) },
  ]);
  assert.equal(combineTraceConformance([full, snapshotOnly]).status, "snapshot-only");
  assert.equal(combineTraceConformance([full, snapshotOnly, invalid]).status, "invalid");
});

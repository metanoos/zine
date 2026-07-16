/**
 * Tests for op-prompts.ts — the single source of truth for per-op LLM message
 * builders. Two things matter here:
 *
 *   1. The role tails don't drift silently; representative strings are
 *      snapshotted from the actual message builders.
 *   2. Runtime-dependent infixes and the inspector dispatcher keep matching
 *      the dedicated builders.
 *
 * Pure string/shape checks — no LLM, no relay, no React. Same convention as the
 * other *.test.ts files (node:test, no external runner).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  extendMessages,
  settleMessages,
  settleDedupeMessages,
  stirMessages,
  replyMessages,
  receiveMessages,
  editMessages,
  buildOpMessages,
  OP_ORDER,
  type OpKind,
} from "./op-prompts.js";
import { SYSTEM_PREAMBLE } from "./system-preamble.js";

type AnyOp = OpKind | "edit";
const ALL_OPS: AnyOp[] = ["extend", "settle", "stir", "reply", "receive", "edit"];

function defaultSystem(op: AnyOp): string {
  switch (op) {
    case "extend": return extendMessages("", false)[0].content;
    case "settle": return settleMessages("")[0].content;
    case "stir": return stirMessages("", 0, [])[0].content;
    case "reply": return replyMessages("", "")[0].content;
    case "receive": return receiveMessages("")[0].content;
    case "edit": return editMessages("", "", "")[0].content;
  }
}

// ─── preamble sanity ────────────────────────────────────────────────────────

test("every op yields a non-empty system prompt", () => {
  for (const op of ALL_OPS) {
    const p = defaultSystem(op);
    assert.ok(p.length > 0, `${op} preamble is empty`);
  }
});

test("every op includes the shared SYSTEM_PREAMBLE prefix", () => {
  for (const op of ALL_OPS) {
    assert.ok(
      defaultSystem(op).startsWith(SYSTEM_PREAMBLE),
      `${op} preamble missing SYSTEM_PREAMBLE prefix`,
    );
  }
});

test("the \\n\\n join separates preamble from role tail exactly once", () => {
  for (const op of ALL_OPS) {
    const p = defaultSystem(op);
    const joinCount = (p.match(/You operate inside zine[\s\S]*?\n\nYOUR ROLE/) ? 1 : 0)
      + (p.match(/You operate inside zine[\s\S]*?\n\nYou are Receive/) ? 1 : 0);
    assert.ok(joinCount === 1, `${op} preamble join is malformed`);
    // The role tail begins right after the single "\n\n" that follows the preamble.
    const tail = p.slice(SYSTEM_PREAMBLE.length + 2);
    assert.ok(tail.length > 0, `${op} role tail is empty after the join`);
  }
});

test("each op's role tail carries its distinctive role marker", () => {
  // A cheap, readable fingerprint per op — catches a copy-paste swap.
  const markers: Record<AnyOp, string> = {
    extend: "YOUR ROLE — Extend: the continuer",
    settle: "YOUR ROLE — Settle: the condenser",
    stir: "YOUR ROLE — Stir: the reinventor",
    reply: "YOUR ROLE — Reply: the replier",
    receive: "You are Receive",
    edit: "YOUR ROLE — edit",
  };
  for (const op of ALL_OPS) {
    assert.ok(
      defaultSystem(op).includes(markers[op]),
      `${op} preamble missing marker "${markers[op]}"`,
    );
  }
});

// ─── preamble snapshots (the drift-killer) ──────────────────────────────────
//
// Each op's role TAIL (system prompt minus the shared SYSTEM_PREAMBLE prefix)
// is snapshotted. Editing a role tail without updating the snapshot here fails
// the test — that's the point. The preamble prefix is excluded so a
// system-preamble.ts edit doesn't trip every op's snapshot.

test("extend system tail snapshot", () => {
  const tail = defaultSystem("extend").slice(SYSTEM_PREAMBLE.length + 2);
  assert.equal(
    tail,
    "YOUR ROLE — Extend: the continuer. You pick up the document where it " +
      "leaves off and write ONLY the continuation. The text after the " +
      "context block is your SEED: the end of the document. Continue from there." +
      " The seed is what the human is asking you to extend — it is NOT a " +
      "question to answer or a prompt to reply to. Match the seed's " +
      "voice, tense, register, and formatting. Do not repeat or restate " +
      "the seed; flow directly onward from its last line. Do not emit " +
      "brackets unless they already appear in the seed and clearly extend " +
      "an ongoing citation. No preamble, no acknowledgement, no fences, " +
      "no quotation marks wrapping the whole response.",
  );
});

test("settle system tail snapshot", () => {
  const tail = defaultSystem("settle").slice(SYSTEM_PREAMBLE.length + 2);
  assert.ok(tail.startsWith("YOUR ROLE — Settle: the condenser."));
  assert.ok(tail.includes("Return ONLY the condensed prose"));
  assert.ok(tail.includes("Settle never creates sediment"));
});

test("reply system tail snapshot", () => {
  const tail = defaultSystem("reply").slice(SYSTEM_PREAMBLE.length + 2);
  assert.ok(tail.startsWith("YOUR ROLE — Reply: the replier."));
  assert.ok(tail.includes("TITLE: <short descriptive name>"));
  assert.ok(tail.includes("--- available minted traces ---"));
});

test("edit system tail snapshot", () => {
  const tail = defaultSystem("edit").slice(SYSTEM_PREAMBLE.length + 2);
  assert.ok(tail.startsWith("YOUR ROLE — edit."));
  assert.ok(tail.includes("minted sediment — preserve them verbatim"));
});

// ─── variable infix behavior ────────────────────────────────────────────────

test("extendMessages: selection flips the seed-kind sentence", () => {
  const withSel = extendMessages("seed", true)[0].content;
  const noSel = extendMessages("seed", false)[0].content;
  assert.notEqual(withSel, noSel, "selection should change the system prompt");
  assert.ok(withSel.includes("a selected passage. Continue from the end"));
  assert.ok(noSel.includes("the end of the document. Continue from there."));
});

test("extendMessages: empty seed falls back to the begin-writing placeholder", () => {
  assert.equal(extendMessages("", false)[1].content, "(empty document — begin writing.)");
});

test("stirMessages: anchor count changes the anchor line", () => {
  const withAnchors = stirMessages("loose", 3, [])[0].content;
  const noAnchors = stirMessages("loose", 0, [])[0].content;
  assert.ok(withAnchors.includes("contained 3 bracketed anchor(s)"));
  assert.ok(noAnchors.includes("There were no bracketed anchors in the original"));
});

test("stirMessages: commands are numbered in the user body", () => {
  const body = stirMessages("loose", 0, ["tighten", "shorten"])[1].content;
  assert.ok(body.includes("1. (( tighten ))"));
  assert.ok(body.includes("2. (( shorten ))"));
});

test("stirMessages: no commands yields the reinvent-freely note", () => {
  const body = stirMessages("loose", 0, [])[1].content;
  assert.ok(body.includes("(no commands — reinvent freely in the same spirit)"));
});

test("receiveMessages: limelight log presence flips the limelight section", () => {
  const withLog = receiveMessages("PANEL 1 …")[0].content;
  const noLog = receiveMessages("")[0].content;
  assert.ok(withLog.includes("--- limelight log: <folder>/ ---"));
  assert.ok(noLog.includes("No limelight log was provided for this folder"));
});

test("replyMessages: traces block is omitted when empty", () => {
  const withTraces = replyMessages("src", "TRACE1")[1].content;
  const noTraces = replyMessages("src", "")[1].content;
  assert.ok(withTraces.startsWith("--- available minted traces ---\nTRACE1"));
  assert.ok(!noTraces.includes("available minted traces"));
});

test("settleDedupeMessages: each file is numbered and headered", () => {
  const body = settleDedupeMessages([
    { path: "a.md", content: "AAA" },
    { path: "b.md", content: "BBB" },
  ])[1].content;
  assert.ok(body.includes("--- FILE 1: a.md ---\nAAA"));
  assert.ok(body.includes("--- FILE 2: b.md ---\nBBB"));
});

// ─── dispatch helper ────────────────────────────────────────────────────────

test("buildOpMessages: dispatches every op and matches the dedicated builder", () => {
  // The inspector routes through buildOpMessages; it must produce byte-identical
  // output to calling the named builder directly.
  const cases: Array<{ op: OpKind; inputs: Parameters<typeof buildOpMessages>[1] }> = [
    { op: "extend", inputs: { seed: "s", hasSelection: true } },
    { op: "settle", inputs: { loose: "L" } },
    { op: "stir", inputs: { loose: "L", anchorCount: 2, commands: ["c"] } },
    { op: "reply", inputs: { source: "S", traces: "T" } },
    { op: "receive", inputs: { limelightLog: "LL" } },
  ];
  for (const { op, inputs } of cases) {
    const viaDispatch = buildOpMessages(op, inputs);
    switch (op) {
      case "extend":
        assert.deepEqual(viaDispatch, extendMessages(inputs.seed!, inputs.hasSelection!));
        break;
      case "settle":
        assert.deepEqual(viaDispatch, settleMessages(inputs.loose!));
        break;
      case "stir":
        assert.deepEqual(viaDispatch, stirMessages(inputs.loose!, inputs.anchorCount!, inputs.commands!));
        break;
      case "reply":
        assert.deepEqual(viaDispatch, replyMessages(inputs.source!, inputs.traces!));
        break;
      case "receive":
        assert.deepEqual(viaDispatch, receiveMessages(inputs.limelightLog!));
        break;
    }
  }
});

test("OP_ORDER: covers exactly the five single-shot ops in display order", () => {
  assert.deepEqual(OP_ORDER, ["extend", "settle", "stir", "reply", "receive"]);
});

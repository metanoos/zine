import assert from "node:assert/strict";
import test from "node:test";

import corpusJson from "../corpus/authoring-syntax-v1.json" with { type: "json" };
import {
  TraceContextCompilationError,
  assertCompiledAuthoringSyntax,
  compileAuthoringSyntax,
  scanAuthoringSyntax,
  validateProtectedOutput,
  type CompileAuthoringSyntaxInputV1,
  type TraceContextErrorCode,
} from "./index.js";

interface GoldenExpected {
  ok: boolean;
  errors: TraceContextErrorCode[];
  protectedRanges: Array<{ id: string; range: [number, number] }>;
  candidates: Array<{
    id: string;
    range: [number, number];
    instructionRange: [number, number];
    instruction: string;
  }>;
  decisions: string[];
  directives: Array<{
    id: string;
    marker: string;
    range: [number, number];
    excerptId: string;
  }>;
  excerpts: Array<{
    id: string;
    sourceRange: [number, number];
    text: string;
    byteLength: number;
    mode: string;
  }>;
  renderedText: string;
}

interface GoldenCase {
  name: string;
  input: CompileAuthoringSyntaxInputV1;
  expected: GoldenExpected;
}

const corpus = corpusJson as { version: 1; cases: GoldenCase[] };

test("authoring-syntax corpus has a supported version", () => {
  assert.equal(corpus.version, 1);
  assert.ok(corpus.cases.length >= 10);
});

for (const fixture of corpus.cases) {
  test(`golden: ${fixture.name}`, () => {
    const result = compileAuthoringSyntax(fixture.input);
    assert.deepEqual(summarize(result), fixture.expected);
  });
}

test("scanner gives protected ranges lexical precedence", () => {
  const result = scanAuthoringSyntax("[[ literal ((not an instruction)) and [[ too ]] tail");
  assert.deepEqual(result.errors, []);
  assert.equal(result.protectedRanges.length, 1);
  assert.equal(result.directiveCandidates.length, 0);
});

test("scanner reports nested and unexpected active delimiters with typed ranges", () => {
  const nested = scanAuthoringSyntax("((outer ((inner)) tail))");
  assert.deepEqual(
    nested.errors.map((error) => error.code),
    ["NESTED_DIRECTIVE", "UNEXPECTED_DIRECTIVE_CLOSE"],
  );
  assert.deepEqual(nested.errors[0]?.range, { fromUtf16: 8, toUtf16: 10 });

  const unexpected = scanAuthoringSyntax("text ]] and ))");
  assert.deepEqual(
    unexpected.errors.map((error) => error.code),
    ["UNEXPECTED_PROTECTED_CLOSE", "UNEXPECTED_DIRECTIVE_CLOSE"],
  );
});

test("same-origin adjacent authority spans may jointly authorize a directive", () => {
  const result = compileAuthoringSyntax({
    text: "((tighten))",
    operation: "stir",
    actingAuthorId: "author-a",
    authoritySpans: [
      {
        id: "manual-a",
        actorId: "author-a",
        origin: "manual",
        instructionEligible: true,
        fromUtf16: 0,
        toUtf16: 5,
      },
      {
        id: "manual-b",
        actorId: "author-a",
        origin: "manual",
        instructionEligible: true,
        fromUtf16: 5,
        toUtf16: 11,
      },
    ],
  });
  assert.equal(result.ok, true);
  assert.equal(result.decisions[0]?.reason, "authorized");
  assert.deepEqual(result.directives[0]?.authority.spanIds, ["manual-a", "manual-b"]);
});

test("authority gaps, wrong actors, and uniform ineligible origins stay inert", () => {
  const base = {
    text: "((tighten))",
    operation: "stir",
    actingAuthorId: "author-a",
  } as const;
  const gap = compileAuthoringSyntax({
    ...base,
    authoritySpans: [{
      id: "partial",
      actorId: "author-a",
      origin: "manual",
      instructionEligible: true,
      fromUtf16: 0,
      toUtf16: 5,
    }],
  });
  const wrongActor = compileAuthoringSyntax({
    ...base,
    authoritySpans: [{
      id: "other",
      actorId: "author-b",
      origin: "manual",
      instructionEligible: true,
      fromUtf16: 0,
      toUtf16: 11,
    }],
  });
  const paste = compileAuthoringSyntax({
    ...base,
    authoritySpans: [{
      id: "paste",
      actorId: "author-a",
      origin: "paste",
      instructionEligible: false,
      fromUtf16: 0,
      toUtf16: 11,
    }],
  });
  assert.equal(gap.decisions[0]?.reason, "missing-authority");
  assert.equal(wrongActor.decisions[0]?.reason, "wrong-actor");
  assert.equal(paste.decisions[0]?.reason, "ineligible-authority");
});

test("invalid authority ranges fail closed, including surrogate boundaries", () => {
  const result = compileAuthoringSyntax({
    text: "😀 ((go))",
    operation: "run",
    actingAuthorId: "author-a",
    authoritySpans: [{
      id: "bad",
      actorId: "author-a",
      origin: "manual",
      instructionEligible: true,
      fromUtf16: 1,
      toUtf16: 9,
    }],
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors.map((error) => error.code), ["RANGE_SPLITS_SURROGATE_PAIR"]);
  assert.equal(result.renderedText, "😀 ((go))");
});

test("standalone directive anchors prefer preceding non-empty block", () => {
  const text = "Prior paragraph.\n\n((use above))\n\nFollowing paragraph.";
  const result = compileAuthoringSyntax({
    text,
    operation: "analyze",
    actingAuthorId: "author-a",
    authoritySpans: [{
      id: "manual",
      actorId: "author-a",
      origin: "manual",
      instructionEligible: true,
      fromUtf16: 18,
      toUtf16: 31,
    }],
  });
  assert.equal(result.ok, true);
  assert.equal(result.directives[0]?.localAnchor.relation, "preceding");
  assert.equal(result.excerpts[0]?.text, "Prior paragraph.");
});

test("oversized anchors use balanced UTF-8 windows without splitting Unicode", () => {
  const text = `${"😀".repeat(30)} before ((do it)) after ${"🧠".repeat(30)}`;
  const start = text.indexOf("((");
  const end = text.indexOf("))", start) + 2;
  const result = compileAuthoringSyntax({
    text,
    operation: "settle",
    actingAuthorId: "author-a",
    localAnchorMaxBytes: 64,
    authoritySpans: [{
      id: "manual",
      actorId: "author-a",
      origin: "manual",
      instructionEligible: true,
      fromUtf16: start,
      toUtf16: end,
    }],
  });
  assert.equal(result.ok, true);
  assert.equal(result.excerpts[0]?.mode, "balanced-window");
  assert.ok((result.excerpts[0]?.byteLength ?? 0) <= 64);
  assert.ok(result.excerpts[0]?.text.includes(result.directives[0]!.marker));
  assert.equal(hasUnpairedSurrogate(result.excerpts[0]!.text), false);
  assert.equal(result.excerpts[0]?.omittedBefore, true);
  assert.equal(result.excerpts[0]?.omittedAfter, true);
});

test("anchor ceiling smaller than its marker is a typed fail-closed error", () => {
  const result = compileAuthoringSyntax({
    text: "((go))",
    operation: "run",
    actingAuthorId: "author-a",
    localAnchorMaxBytes: 8,
    authoritySpans: [{
      id: "manual",
      actorId: "author-a",
      origin: "manual",
      instructionEligible: true,
      fromUtf16: 0,
      toUtf16: 6,
    }],
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors.map((error) => error.code), ["ANCHOR_BUDGET_TOO_SMALL"]);
  assert.equal(result.renderedText, "((go))");
});

test("compiled records retain exact instruction bytes and one-shot-ready identity", () => {
  const result = compileAuthoringSyntax({
    text: "Lead ((  keep spacing 🧠  )) tail",
    operation: "reply",
    actingAuthorId: "author-a",
    sourceRevision: { traceId: "trace-1", headId: "head-1", path: "draft.md" },
    authoritySpans: [{
      id: "promotion",
      actorId: "author-a",
      origin: "explicit-promotion",
      instructionEligible: true,
      fromUtf16: 5,
      toUtf16: 28,
    }],
  });
  const directive = result.directives[0]!;
  assert.equal(directive.instruction, "  keep spacing 🧠  ");
  assert.deepEqual(directive.lifecycle, { mode: "one-shot", state: "pending" });
  assert.deepEqual(directive.sourceRevision, {
    traceId: "trace-1",
    headId: "head-1",
    path: "draft.md",
  });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(directive), true);
});

test("protected-output validation requires every exact fragment in source order", () => {
  const scan = scanAuthoringSyntax("A [[ first ]] B [[ second ]] C");
  const valid = validateProtectedOutput(
    scan.protectedRanges,
    "Rewritten [[ first ]] then [[ second ]] done",
  );
  assert.equal(valid.valid, true);
  assert.deepEqual(valid.matches.map((match) => match.outputRange), [
    { fromUtf16: 10, toUtf16: 21 },
    { fromUtf16: 27, toUtf16: 39 },
  ]);

  const reversed = validateProtectedOutput(
    scan.protectedRanges,
    "Rewritten [[ second ]] then [[ first ]] done",
  );
  assert.equal(reversed.valid, false);
  assert.deepEqual(
    reversed.violations.map((violation) => violation.protectedRangeId),
    [scan.protectedRanges[1]!.id],
  );
});

test("assert helper exposes all typed compilation errors", () => {
  const result = compileAuthoringSyntax({
    text: "(( ))",
    operation: "extend",
    actingAuthorId: "author-a",
  });
  assert.throws(
    () => assertCompiledAuthoringSyntax(result),
    (error) => error instanceof TraceContextCompilationError
      && error.errors[0]?.code === "EMPTY_DIRECTIVE",
  );
});

function summarize(result: ReturnType<typeof compileAuthoringSyntax>): GoldenExpected {
  return {
    ok: result.ok,
    errors: result.errors.map((error) => error.code),
    protectedRanges: result.scan.protectedRanges.map((protectedRange) => ({
      id: protectedRange.id,
      range: [protectedRange.range.fromUtf16, protectedRange.range.toUtf16],
    })),
    candidates: result.scan.directiveCandidates.map((candidate) => ({
      id: candidate.id,
      range: [candidate.range.fromUtf16, candidate.range.toUtf16],
      instructionRange: [candidate.instructionRange.fromUtf16, candidate.instructionRange.toUtf16],
      instruction: candidate.instruction,
    })),
    decisions: result.decisions.map((decision) => decision.reason),
    directives: result.directives.map((directive) => ({
      id: directive.id,
      marker: directive.marker,
      range: [directive.sourceRange.fromUtf16, directive.sourceRange.toUtf16],
      excerptId: directive.localAnchor.excerptId,
    })),
    excerpts: result.excerpts.map((excerpt) => ({
      id: excerpt.id,
      sourceRange: [excerpt.sourceRange.fromUtf16, excerpt.sourceRange.toUtf16],
      text: excerpt.text,
      byteLength: excerpt.byteLength,
      mode: excerpt.mode,
    })),
    renderedText: result.renderedText,
  };
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

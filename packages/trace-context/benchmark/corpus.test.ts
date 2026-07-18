import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import manifestJson from "../corpus/authoring-scale-v1.json" with { type: "json" };
import { compileAuthoringSyntax } from "../src/index.js";
import {
  AUTHORING_SCALE_SIZES,
  buildAuthoringScaleFixture,
  summarizeAuthoringScaleFixture,
  type AuthoringScaleSummaryV1,
} from "./corpus.js";

interface ManifestEntry {
  eventCount: number;
  bounded: AuthoringScaleSummaryV1;
  degraded: AuthoringScaleSummaryV1;
}

interface ScaleManifestV1 {
  version: 1;
  generator: "authoring-scale-v1";
  note: string;
  sizes: ManifestEntry[];
}

const manifest = manifestJson as unknown as ScaleManifestV1;

test("scale corpus pins the intended authoring-syntax sizes", () => {
  assert.equal(manifest.version, 1);
  assert.equal(manifest.generator, "authoring-scale-v1");
  assert.deepEqual(
    manifest.sizes.map((entry) => entry.eventCount),
    AUTHORING_SCALE_SIZES,
  );
  assert.match(manifest.note, /not trace-manifest transactions or latency claims/);
});

for (const entry of manifest.sizes) {
  for (const mode of ["bounded", "degraded"] as const) {
    test(`generated ${entry.eventCount}/${mode} fixture matches pinned hashes, counts, and ranges`, () => {
      const fixture = buildAuthoringScaleFixture(entry.eventCount, mode);
      const result = compileAuthoringSyntax(fixture.input);
      const summary = summarizeAuthoringScaleFixture(fixture, result);

      assert.deepEqual(summary, entry[mode]);
      assert.equal(result.scan.directiveCandidates.length, entry.eventCount);
      assert.deepEqual(
        result.scan.directiveCandidates.map((candidate) => candidate.range),
        fixture.candidateRanges,
      );
      assert.ok(fixture.input.text.includes("🧠") || entry.eventCount === 0);
      assert.ok(result.scan.protectedRanges.every((range) => range.text.includes("((shadow")));
      assert.ok(result.scan.directiveCandidates.every(
        (candidate) => !candidate.instruction.includes("shadow"),
      ));
      assert.equal(
        fixture.input.sourceRevision?.contentHash,
        createHash("sha256").update(fixture.input.text).digest("hex"),
      );
      assert.equal(Object.isFrozen(fixture), true);
      assert.equal(Object.isFrozen(result), true);

      if (mode === "bounded") {
        assert.equal(result.ok, true);
        assert.deepEqual(result.errors, []);
        if (entry.eventCount > 0) {
          assert.deepEqual(
            result.decisions.slice(0, 2).map((decision) => decision.reason),
            ["outside-operation-range", "crosses-operation-range"],
          );
          assert.deepEqual(
            result.decisions.slice(-2).map((decision) => decision.reason),
            ["crosses-operation-range", "outside-operation-range"],
          );
          assert.ok(result.scan.errors.some((error) => error.code === "UNTERMINATED_DIRECTIVE"));
          assert.ok(result.decisions.some((decision) => decision.reason === "missing-authority"));
          assert.ok(result.decisions.some((decision) => decision.reason === "ineligible-authority"));
          assert.ok(result.decisions.some((decision) => decision.reason === "wrong-actor"));
          assert.ok(result.decisions.some((decision) => decision.reason === "mixed-authority"));
          assert.ok(result.excerpts.some((excerpt) => excerpt.mode === "balanced-window"));
          assert.ok(result.excerpts.every((excerpt) => excerpt.byteLength <= 256));
        }
      } else {
        assert.equal(result.ok, false);
        assert.equal(result.renderedText, fixture.input.text);
        assert.deepEqual(result.directives, []);
        assert.deepEqual(result.excerpts, []);
        assert.ok(result.errors.some((error) => error.code === "UNEXPECTED_DIRECTIVE_CLOSE"));
        assert.deepEqual(
          result.errors.find((error) => error.code === "UNEXPECTED_DIRECTIVE_CLOSE")?.range,
          fixture.degradedErrorRange,
        );
        assert.ok(result.decisions.every((decision) => decision.reason === "blocked-by-errors"));
      }
    });
  }
}

test("generated input and observable output surfaces stay linearly bounded", () => {
  const nonEmpty = manifest.sizes.filter((entry) => entry.eventCount > 0);
  for (const entry of nonEmpty) {
    const count = entry.eventCount;
    assert.ok(entry.bounded.inputUtf8Bytes <= 100 * count);
    assert.ok(entry.bounded.resultUtf8Bytes <= 850 * count);
    assert.ok(entry.degraded.resultUtf8Bytes <= 650 * count);
    assert.ok(entry.bounded.observableUnitCount <= 140 * count);
    assert.ok(entry.degraded.observableUnitCount <= 140 * count);
    assert.ok(entry.bounded.authoritySpanCount <= 2 * count);
    assert.equal(entry.bounded.candidateCount, count);
    assert.equal(entry.degraded.candidateCount, count);
  }

  const generated = nonEmpty.map((entry) => buildAuthoringScaleFixture(entry.eventCount, "bounded"));
  const firstHundredRanges = generated[0]!.candidateRanges;
  for (const fixture of generated.slice(1)) {
    assert.deepEqual(fixture.candidateRanges.slice(0, 100), firstHundredRanges);
  }
});

test("fixture generator rejects ambiguous unsupported small non-empty scales", () => {
  assert.throws(() => buildAuthoringScaleFixture(-1, "bounded"), /non-negative integer/);
  assert.throws(() => buildAuthoringScaleFixture(1, "bounded"), /at least four events/);
});

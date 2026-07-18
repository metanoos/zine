import { performance } from "node:perf_hooks";

import { compileAuthoringSyntax } from "../src/index.js";
import {
  AUTHORING_SCALE_SIZES,
  buildAuthoringScaleFixture,
  summarizeAuthoringScaleFixture,
  type AuthoringScaleMode,
} from "./corpus.js";

const options = parseOptions(process.argv.slice(2));

if (options.manifest) {
  const sizes = options.sizes.map((eventCount) => ({
    eventCount,
    bounded: summarize(eventCount, "bounded"),
    degraded: summarize(eventCount, "degraded"),
  }));
  process.stdout.write(`${JSON.stringify({
    version: 1,
    generator: "authoring-scale-v1",
    note: "Pinned deterministic authoring-syntax summaries; these are not trace-manifest transactions or latency claims.",
    sizes,
  }, null, 2)}\n`);
} else {
  const cases = [];
  for (const eventCount of options.sizes) {
    for (const mode of ["bounded", "degraded"] as const) {
      const generationStart = performance.now();
      const fixture = buildAuthoringScaleFixture(eventCount, mode);
      const generationMs = performance.now() - generationStart;

      const firstStart = performance.now();
      const firstResult = compileAuthoringSyntax(fixture.input);
      const coldishFirstCompileMs = performance.now() - firstStart;
      const summary = summarizeAuthoringScaleFixture(fixture, firstResult);

      const warmishSamplesMs: number[] = [];
      for (let iteration = 0; iteration < options.iterations; iteration += 1) {
        const start = performance.now();
        const result = compileAuthoringSyntax(fixture.input);
        warmishSamplesMs.push(performance.now() - start);
        const repeated = summarizeAuthoringScaleFixture(fixture, result);
        if (repeated.resultSha256 !== summary.resultSha256) {
          throw new Error(`non-deterministic ${eventCount}/${mode} result`);
        }
      }

      cases.push({
        eventCount,
        mode,
        generationMs: round(generationMs),
        coldishFirstCompileMs: round(coldishFirstCompileMs),
        warmish: summarizeSamples(warmishSamplesMs),
        bytes: {
          inputUtf8: summary.inputUtf8Bytes,
          renderedUtf8: summary.renderedUtf8Bytes,
          serializedResultUtf8: summary.resultUtf8Bytes,
        },
        counts: {
          candidates: summary.candidateCount,
          directives: summary.directiveCount,
          excerpts: summary.excerptCount,
          errors: summary.compileErrorCodes.length,
        },
        hashes: {
          inputSha256: summary.inputSha256,
          resultSha256: summary.resultSha256,
        },
      });
    }
  }

  process.stdout.write(`${JSON.stringify({
    version: 1,
    diagnosticOnly: true,
    disclaimer: "Local wall-clock observations are not CI gates, product latency claims, or future trace-manifest preparation budgets.",
    definitions: {
      coldishFirstCompileMs: "First synchronous compile after this fixture is generated in the current process.",
      warmish: "Repeated synchronous compiles of the same immutable input in the current process; no compiler cache exists.",
    },
    runtime: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    iterationsPerWarmishCase: options.iterations,
    cases,
    deferred: [
      "cancellable manifest compilation",
      "cache-cold and cache-warm manifest selection",
      "candidate quota and incomplete-manifest behavior",
      "rendered-context and envelope ceilings",
    ],
  }, null, 2)}\n`);
}

function summarize(eventCount: number, mode: AuthoringScaleMode) {
  const fixture = buildAuthoringScaleFixture(eventCount, mode);
  const result = compileAuthoringSyntax(fixture.input);
  return summarizeAuthoringScaleFixture(fixture, result);
}

function summarizeSamples(samples: readonly number[]) {
  const sorted = [...samples].sort((left, right) => left - right);
  const total = samples.reduce((sum, sample) => sum + sample, 0);
  return {
    iterations: samples.length,
    minMs: round(sorted[0] ?? 0),
    medianMs: round(sorted[Math.floor(sorted.length / 2)] ?? 0),
    meanMs: round(samples.length === 0 ? 0 : total / samples.length),
    maxMs: round(sorted.at(-1) ?? 0),
  };
}

function parseOptions(args: readonly string[]): {
  iterations: number;
  manifest: boolean;
  sizes: number[];
} {
  let iterations = 3;
  let manifest = false;
  let sizes = [...AUTHORING_SCALE_SIZES] as number[];

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--manifest") {
      manifest = true;
      continue;
    }
    if (argument === "--iterations") {
      iterations = parsePositiveInteger(args[++index], "--iterations");
      continue;
    }
    if (argument.startsWith("--iterations=")) {
      iterations = parsePositiveInteger(argument.slice("--iterations=".length), "--iterations");
      continue;
    }
    if (argument === "--sizes") {
      sizes = parseSizes(args[++index]);
      continue;
    }
    if (argument.startsWith("--sizes=")) {
      sizes = parseSizes(argument.slice("--sizes=".length));
      continue;
    }
    throw new Error(`unknown argument: ${argument}`);
  }

  return { iterations, manifest, sizes };
}

function parsePositiveInteger(value: string | undefined, option: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${option} requires a positive integer`);
  }
  return parsed;
}

function parseSizes(value: string | undefined): number[] {
  if (!value) throw new Error("--sizes requires a comma-separated list");
  const sizes = value.split(",").map((part) => Number(part));
  if (sizes.some((size) => !AUTHORING_SCALE_SIZES.includes(size as never))) {
    throw new Error(`--sizes must use supported values: ${AUTHORING_SCALE_SIZES.join(",")}`);
  }
  return sizes;
}

function round(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

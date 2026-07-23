import assert from "node:assert/strict";
import test from "node:test";

import type { Event, EventTemplate } from "nostr-tools";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";

import { verifyReifyTraceBundle } from "./reify-bundle-reader.js";
import { verifyFileTraceChain } from "./trace-conformance.js";

const SECRET = Uint8Array.from([...new Uint8Array(31), 1]);
const OTHER_SECRET = Uint8Array.from([...new Uint8Array(31), 2]);
const ROOT = "f".repeat(64);
const ABSENT_ID = "a".repeat(64);
const TEST_OPERATION_ID = "1".repeat(64);

interface NodeOptions {
  secret?: Uint8Array;
  kind?: number;
  discriminator?: string | null;
  contentHash?: string;
  editorTransactions?: unknown;
  prevTarget?: string;
  createdAt?: number;
}

interface BundleTarget {
  relativePath: string;
  traceId: string;
  nucleusId: string;
  eventIds: string[];
  conformance: "full" | "snapshot-only" | "invalid";
  conformanceIssues: unknown[];
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Buffer.from(digest).toString("hex");
}

async function fileNode(
  before: string,
  snapshot: string,
  previous?: Event,
  options: NodeOptions = {},
): Promise<Event> {
  const secret = options.secret ?? SECRET;
  const voice = getPublicKey(secret);
  const previousId = options.prevTarget ?? previous?.id;
  const hasPrevious = previousId !== undefined;
  const tags: string[][] = [
    ...(options.discriminator === null
      ? []
      : [["z", options.discriminator ?? "file"]]),
    ["F", "essay.md"],
    ["f", ROOT],
    ["action", hasPrevious ? "edit" : "import"],
    ...(hasPrevious ? [["e", previousId, "", "prev"]] : []),
  ];
  const defaultEditorTransactions = before === snapshot
    ? []
    : [{
        sequence: 0,
        timestamp: (options.createdAt ?? 1_700_000_000) * 1_000,
        actor: voice,
        changes: [{
          op: before.length === 0 ? "insert" : snapshot.length === 0 ? "delete" : "replace",
          from: 0,
          to: before.length,
          text: snapshot,
        }],
        selectionBefore: null,
        selectionAfter: null,
      }];
  const template: EventTemplate = {
    kind: options.kind ?? 4290,
    created_at: options.createdAt ?? 1_700_000_000 + (hasPrevious ? 1 : 0),
    tags,
    content: JSON.stringify({
      snapshot,
      contentHash: options.contentHash ?? await sha256Hex(snapshot),
      operationId: TEST_OPERATION_ID,
      ...(options.editorTransactions === null ? {} : { editorTransactions: options.editorTransactions ?? defaultEditorTransactions }),
    }),
  };
  return finalizeEvent(template, secret);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

async function makeTarget(
  relativePath: string,
  chain: readonly Event[],
  overrides: Partial<BundleTarget> = {},
): Promise<BundleTarget> {
  const verdict = await verifyFileTraceChain(chain);
  return {
    relativePath,
    traceId: chain[0]!.id,
    nucleusId: chain[chain.length - 1]!.id,
    eventIds: chain.map((event) => event.id),
    conformance: verdict.status,
    conformanceIssues: verdict.issues.map((issue) => ({ ...issue })),
    ...overrides,
  };
}

function makeBundle(targets: readonly BundleTarget[], events: readonly Event[]): unknown {
  return cloneJson({
    format: "zine-trace",
    version: 1,
    targets,
    events,
  });
}

function issueCodes(result: Awaited<ReturnType<typeof verifyReifyTraceBundle>>): string[] {
  return result.issues.map((issue) => issue.code);
}

test("verifies a full two-step bundle and exact ordinary file", async () => {
  const genesis = await fileNode("", "draft\n");
  const nucleus = await fileNode("draft\n", "final\n", genesis);
  const target = await makeTarget("reports/essay.md", [genesis, nucleus]);

  const result = await verifyReifyTraceBundle(
    makeBundle([target], [genesis, nucleus]),
    new Map([["reports/essay.md", "final\n"]]),
  );

  assert.equal(result.valid, true);
  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.events.map((event) => event.eventId), [genesis.id, nucleus.id]);
  assert.deepEqual(result.events.map((event) => event.cryptographicallyValid), [true, true]);
  assert.equal(result.targets[0]?.recomputedConformance?.status, "full");
  assert.equal(result.targets[0]?.declarationMatches, true);
  assert.deepEqual(result.targets[0]?.materializedFile, {
    status: "verified",
    matchesSnapshot: true,
    matchesSignedContentHash: true,
  });
  assert.match(result.trustStatement, /do not prove identity, truth, humanness, originality/i);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.targets), true);
  assert.equal(Object.isFrozen(result.targets[0]?.recomputedConformance?.steps), true);
});

test("allows targets to share ancestry and events while preserving declared order", async () => {
  const genesis = await fileNode("", "shared draft");
  const nucleus = await fileNode("shared draft", "shared result", genesis);
  const targets = [
    await makeTarget("z-last.md", [genesis, nucleus]),
    await makeTarget("a-first.md", [genesis, nucleus]),
  ];
  const bundle = makeBundle(targets, [nucleus, genesis]);

  const result = await verifyReifyTraceBundle(bundle, async (path) =>
    path === "z-last.md" || path === "a-first.md" ? "shared result" : undefined,
  );

  assert.equal(result.valid, true);
  assert.deepEqual(result.targets.map((target) => target.relativePath), ["z-last.md", "a-first.md"]);
  assert.deepEqual(result.events.map((event) => event.eventId), [nucleus.id, genesis.id]);
  assert.deepEqual(result.targets.map((target) => target.eventIds), [
    [genesis.id, nucleus.id],
    [genesis.id, nucleus.id],
  ]);
});

test("verifies one shared ordered chain only once across multiple targets", async () => {
  const event = await fileNode("", "shared result");
  const targets = [
    await makeTarget("first.md", [event]),
    await makeTarget("second.md", [event]),
  ];
  const subtle = crypto.subtle;
  const originalDigest = subtle.digest;
  let digestCalls = 0;
  subtle.digest = ((algorithm: AlgorithmIdentifier, data: BufferSource) => {
    digestCalls += 1;
    return originalDigest.call(subtle, algorithm, data);
  }) as SubtleCrypto["digest"];

  try {
    const result = await verifyReifyTraceBundle(
      makeBundle(targets, [event]),
      {},
    );

    assert.equal(digestCalls, 1);
    assert.deepEqual(
      result.targets.map((target) => target.recomputedConformance?.status),
      ["full", "full"],
    );
  } finally {
    subtle.digest = originalDigest;
  }
});

test("rejects a bundle whose target indexes exceed the global reference budget", async () => {
  const event = await fileNode("", "bounded");
  const validTarget = await makeTarget("valid.md", [event]);
  const oversizedTarget = await makeTarget("oversized.md", [event], {
    eventIds: Array.from({ length: 10_000 }, () => event.id),
  });

  const result = await verifyReifyTraceBundle(
    makeBundle([validTarget, oversizedTarget], [event]),
    { "valid.md": "bounded" },
  );

  assert.equal(result.valid, false);
  assert.ok(issueCodes(result).includes("event-reference-budget-exceeded"));
  assert.deepEqual(result.targets[1]?.eventIds, []);
  assert.equal(result.targets[1]?.recomputedConformance, null);
});

test("rejects duplicate target event ids before trace conformance", async () => {
  const event = await fileNode("", "bounded duplicate");
  const target = await makeTarget("duplicate.md", [event], {
    eventIds: Array.from({ length: 10_000 }, () => event.id),
  });
  const subtle = crypto.subtle;
  const originalDigest = subtle.digest;
  let digestCalls = 0;
  subtle.digest = ((algorithm: AlgorithmIdentifier, data: BufferSource) => {
    digestCalls += 1;
    return originalDigest.call(subtle, algorithm, data);
  }) as SubtleCrypto["digest"];

  try {
    const result = await verifyReifyTraceBundle(
      makeBundle([target], [event]),
      { "duplicate.md": "bounded duplicate" },
    );

    assert.equal(result.valid, false);
    assert.equal(
      issueCodes(result).filter((code) => code === "duplicate-indexed-event-id").length,
      1,
    );
    assert.deepEqual(result.targets[0]?.eventIds, [event.id]);
    assert.equal(result.targets[0]?.recomputedConformance, null);
    assert.equal(result.targets[0]?.materializedFile.status, "match-unverified");
    assert.equal(digestCalls, 1);
  } finally {
    subtle.digest = originalDigest;
  }
});

test("malformed containers and unsupported versions fail closed without throwing", async () => {
  const cases: { name: string; input: unknown; code: string }[] = [
    { name: "null", input: null, code: "invalid-container" },
    { name: "array", input: [], code: "invalid-container" },
    {
      name: "wrong format",
      input: { format: "other", version: 1, targets: [], events: [] },
      code: "unsupported-format",
    },
    {
      name: "wrong version",
      input: { format: "zine-trace", version: 2, targets: [], events: [] },
      code: "unsupported-version",
    },
    {
      name: "wrong arrays",
      input: { format: "zine-trace", version: 1, targets: null, events: {} },
      code: "invalid-targets",
    },
  ];

  for (const fixture of cases) {
    const result = await verifyReifyTraceBundle(fixture.input, {});
    assert.equal(result.valid, false, fixture.name);
    assert.ok(issueCodes(result).includes(fixture.code), fixture.name);
  }
});

test("strictly validates target paths, indexes, references, and event coverage", async () => {
  const genesis = await fileNode("", "draft");
  const nucleus = await fileNode("draft", "final", genesis);
  const extra = await fileNode("", "extra", undefined, { createdAt: 1_700_000_100 });
  const validTarget = await makeTarget("essay.md", [genesis, nucleus]);

  const duplicateEvents = await verifyReifyTraceBundle(
    makeBundle([await makeTarget("essay.md", [genesis])], [genesis, genesis]),
    { "essay.md": "draft" },
  );
  assert.ok(issueCodes(duplicateEvents).includes("duplicate-event-id"));
  assert.ok(issueCodes(duplicateEvents).includes("ambiguous-event-reference"));

  const duplicatePaths = await verifyReifyTraceBundle(
    makeBundle([
      validTarget,
      await makeTarget("essay.md", [genesis, nucleus]),
    ], [genesis, nucleus]),
    { "essay.md": "final" },
  );
  assert.ok(issueCodes(duplicatePaths).includes("duplicate-target-path"));

  for (const unsafePath of [
    "/absolute.md",
    "../escape.md",
    "nested/../escape.md",
    ".zine/trace.json",
    ".ZINE/report.md",
    "nested\\windows.md",
    "C:/drive.md",
  ]) {
    const unsafeTarget = await makeTarget(unsafePath, [genesis, nucleus]);
    const result = await verifyReifyTraceBundle(
      makeBundle([unsafeTarget], [genesis, nucleus]),
      {},
    );
    assert.ok(issueCodes(result).includes("unsafe-target-path"), unsafePath);
  }

  const danglingTarget = await makeTarget("essay.md", [genesis], {
    nucleusId: ABSENT_ID,
    eventIds: [genesis.id, ABSENT_ID],
  });
  const dangling = await verifyReifyTraceBundle(
    makeBundle([danglingTarget], [genesis]),
    { "essay.md": "draft" },
  );
  assert.ok(issueCodes(dangling).includes("dangling-event-reference"));

  const reversedTarget = await makeTarget("essay.md", [genesis, nucleus], {
    eventIds: [nucleus.id, genesis.id],
  });
  const reversed = await verifyReifyTraceBundle(
    makeBundle([reversedTarget], [genesis, nucleus]),
    { "essay.md": "final" },
  );
  assert.ok(issueCodes(reversed).includes("wrong-trace-endpoint"));
  assert.ok(issueCodes(reversed).includes("wrong-nucleus-endpoint"));

  const wrongEndpointsTarget = await makeTarget("essay.md", [genesis, nucleus], {
    traceId: nucleus.id,
    nucleusId: genesis.id,
  });
  const wrongEndpoints = await verifyReifyTraceBundle(
    makeBundle([wrongEndpointsTarget], [genesis, nucleus]),
    { "essay.md": "final" },
  );
  assert.ok(issueCodes(wrongEndpoints).includes("wrong-trace-endpoint"));
  assert.ok(issueCodes(wrongEndpoints).includes("wrong-nucleus-endpoint"));

  const omittedTarget = await makeTarget("essay.md", [nucleus], {
    traceId: nucleus.id,
    nucleusId: nucleus.id,
    eventIds: [nucleus.id],
  });
  const omitted = await verifyReifyTraceBundle(
    makeBundle([omittedTarget], [nucleus]),
    { "essay.md": "final" },
  );
  assert.ok(issueCodes(omitted).includes("dangling-prev-reference"));
  assert.ok(issueCodes(omitted).includes("non-genesis-start"));

  const unindexed = await verifyReifyTraceBundle(
    makeBundle([validTarget], [genesis, nucleus, extra]),
    { "essay.md": "final" },
  );
  assert.ok(issueCodes(unindexed).includes("unindexed-event"));
});

test("rejects malformed event primitives before cryptographic verification", async () => {
  const valid = await fileNode("", "body");
  const fixtures: { name: string; event: unknown; code: string }[] = [
    { name: "null event", event: null, code: "invalid-event-shape" },
    { name: "uppercase id", event: { ...valid, id: "A".repeat(64) }, code: "invalid-event-id" },
    { name: "fractional time", event: { ...valid, created_at: 1.5 }, code: "invalid-event-created-at" },
    { name: "bad tag value", event: { ...valid, tags: [["z", 1]] }, code: "invalid-event-tag-value" },
    { name: "object content", event: { ...valid, content: {} }, code: "invalid-event-content" },
  ];

  for (const fixture of fixtures) {
    const result = await verifyReifyTraceBundle({
      format: "zine-trace",
      version: 1,
      targets: [],
      events: [fixture.event],
    }, {});
    assert.equal(result.valid, false, fixture.name);
    assert.ok(issueCodes(result).includes(fixture.code), fixture.name);
    assert.equal(result.events[0]?.cryptographicallyValid, false, fixture.name);
  }

  const target = await makeTarget("essay.md", [valid]);
  const referencedMalformed = await verifyReifyTraceBundle(
    makeBundle([target], [{ ...valid, created_at: 1.5 }]),
    { "essay.md": "body" },
  );
  assert.ok(issueCodes(referencedMalformed).includes("invalid-event-reference"));
  assert.equal(referencedMalformed.targets[0]?.valid, false);
});

test("independently detects tampered event signatures, ids, and content", async () => {
  const valid = await fileNode("", "signed\n");
  const declared = await makeTarget("essay.md", [valid]);
  const fixtures: { name: string; event: Event; target: BundleTarget; codes: string[] }[] = [
    {
      name: "signature",
      event: { ...valid, sig: "0".repeat(128) },
      target: declared,
      codes: ["invalid-event"],
    },
    {
      name: "id",
      event: { ...valid, id: "0".repeat(64) },
      target: {
        ...declared,
        traceId: "0".repeat(64),
        nucleusId: "0".repeat(64),
        eventIds: ["0".repeat(64)],
      },
      codes: ["invalid-event"],
    },
    {
      name: "content",
      event: {
        ...valid,
        content: JSON.stringify({
          ...(JSON.parse(valid.content) as object),
          snapshot: "tampered\n",
        }),
      },
      target: declared,
      codes: ["invalid-event", "snapshot-hash-mismatch"],
    },
  ];

  for (const fixture of fixtures) {
    const result = await verifyReifyTraceBundle(
      makeBundle([fixture.target], [fixture.event]),
      { "essay.md": "signed\n" },
    );
    assert.equal(result.valid, false, fixture.name);
    assert.equal(result.events[0]?.cryptographicallyValid, false, fixture.name);
    for (const code of fixture.codes) {
      assert.ok(issueCodes(result).includes(code), `${fixture.name}: ${code}`);
    }
  }
});

test("uses shared conformance for kind, discriminator, lineage, owner, hash, and EditorTransaction failures", async () => {
  const genesis = await fileNode("", "draft");
  const wrongKind = await fileNode("", "body", undefined, { kind: 1 });
  const wrongDiscriminator = await fileNode("", "body", undefined, { discriminator: "folder" });
  const brokenPrev = await fileNode("draft", "final", genesis, { prevTarget: ABSENT_ID });
  const foreign = await fileNode("draft", "foreign", genesis, { secret: OTHER_SECRET });
  const wrongHash = await fileNode("", "body", undefined, { contentHash: "0".repeat(64) });
  const badReplay = await fileNode("", "body", undefined, {
    editorTransactions: [{
      sequence: 0,
      timestamp: 1,
      actor: getPublicKey(SECRET),
      changes: [{ op: "insert", from: 0, to: 0, text: "different" }],
      selectionBefore: null,
      selectionAfter: null,
    }],
  });
  const fixtures: {
    name: string;
    chain: Event[];
    files: Record<string, string>;
    code: string;
    status: "snapshot-only" | "invalid";
  }[] = [
    { name: "wrong kind", chain: [wrongKind], files: { "wrong-kind.md": "body" }, code: "not-file-node", status: "invalid" },
    { name: "wrong discriminator", chain: [wrongDiscriminator], files: { "wrong-z.md": "body" }, code: "not-file-node", status: "invalid" },
    { name: "broken prev", chain: [genesis, brokenPrev], files: { "broken.md": "final" }, code: "broken-prev", status: "invalid" },
    { name: "owner change", chain: [genesis, foreign], files: { "owner.md": "foreign" }, code: "owner-changed", status: "invalid" },
    { name: "snapshot hash", chain: [wrongHash], files: { "hash.md": "body" }, code: "snapshot-hash-mismatch", status: "invalid" },
    { name: "EditorTransaction replay", chain: [badReplay], files: { "replay.md": "body" }, code: "nonconforming-editor-transactions", status: "snapshot-only" },
  ];

  for (const fixture of fixtures) {
    const path = Object.keys(fixture.files)[0]!;
    const target = await makeTarget(path, fixture.chain);
    const result = await verifyReifyTraceBundle(
      makeBundle([target], fixture.chain),
      fixture.files,
    );
    assert.equal(result.valid, false, fixture.name);
    assert.equal(result.targets[0]?.recomputedConformance?.status, fixture.status, fixture.name);
    assert.ok(
      result.issues.some((issue) =>
        issue.category === "trace-conformance" && issue.code === fixture.code,
      ),
      fixture.name,
    );
    assert.equal(result.targets[0]?.declarationMatches, true, fixture.name);
  }
});

test("treats false stored conformance labels or issues as bundle-integrity failures", async () => {
  const event = await fileNode("", "body");
  const validTarget = await makeTarget("essay.md", [event]);
  const falseIssue = {
    kind: "process",
    code: "invented",
    message: "invented stored issue",
    stepIndex: 0,
    nodeId: event.id,
  };
  const fixtures: { name: string; target: BundleTarget }[] = [
    {
      name: "false label",
      target: { ...validTarget, conformance: "invalid" },
    },
    {
      name: "false issues",
      target: { ...validTarget, conformanceIssues: [falseIssue] },
    },
  ];

  for (const fixture of fixtures) {
    const result = await verifyReifyTraceBundle(
      makeBundle([fixture.target], [event]),
      { "essay.md": "body" },
    );
    assert.equal(result.valid, false, fixture.name);
    assert.equal(result.targets[0]?.recomputedConformance?.status, "full", fixture.name);
    assert.equal(result.targets[0]?.declarationMatches, false, fixture.name);
    assert.ok(issueCodes(result).includes("declared-conformance-mismatch"), fixture.name);
  }
});

test("requires exact materialized ordinary file text, including newlines", async () => {
  const event = await fileNode("", "exact bytes\n");
  const target = await makeTarget("essay.md", [event]);
  const bundle = makeBundle([target], [event]);
  const fixtures: {
    name: string;
    files: Record<string, unknown>;
    code: string;
    status: "missing" | "mismatch";
  }[] = [
    { name: "missing", files: {}, code: "missing-file", status: "missing" },
    { name: "missing newline", files: { "essay.md": "exact bytes" }, code: "file-content-mismatch", status: "mismatch" },
    { name: "extra newline", files: { "essay.md": "exact bytes\n\n" }, code: "file-content-mismatch", status: "mismatch" },
    { name: "non-string", files: { "essay.md": new Uint8Array([1]) }, code: "invalid-file-content", status: "mismatch" },
  ];

  for (const fixture of fixtures) {
    const result = await verifyReifyTraceBundle(bundle, fixture.files);
    assert.equal(result.valid, false, fixture.name);
    assert.equal(result.targets[0]?.materializedFile.status, fixture.status, fixture.name);
    assert.ok(
      result.issues.some((issue) =>
        issue.category === "materialized-file" && issue.code === fixture.code,
      ),
      fixture.name,
    );
  }

  const loaderFailure = await verifyReifyTraceBundle(bundle, async () => {
    throw new Error("untrusted loader failure");
  });
  assert.equal(loaderFailure.valid, false);
  assert.ok(issueCodes(loaderFailure).includes("file-load-failed"));
});

test("verification results are deterministic and detached from later caller mutation", async () => {
  const genesis = await fileNode("", "draft");
  const nucleus = await fileNode("draft", "final", genesis);
  const targets = [
    await makeTarget("z.md", [genesis, nucleus]),
    await makeTarget("a.md", [genesis, nucleus]),
  ];
  const bundle = makeBundle(targets, [nucleus, genesis]) as {
    targets: BundleTarget[];
    events: Event[];
  };
  const files = new Map<string, unknown>([["z.md", "final"], ["a.md", "final"]]);

  const first = await verifyReifyTraceBundle(bundle, files);
  const second = await verifyReifyTraceBundle(cloneJson(bundle), new Map(files));
  assert.deepEqual(first, second);
  assert.equal(first.valid, true);

  bundle.targets[0]!.relativePath = "mutated.md";
  bundle.targets[0]!.eventIds.reverse();
  bundle.events[0]!.content = "mutated";
  files.set("z.md", "mutated");
  files.delete("a.md");

  assert.equal(first.valid, true);
  assert.deepEqual(first.targets.map((target) => target.relativePath), ["z.md", "a.md"]);
  assert.deepEqual(first.targets[0]?.eventIds, [genesis.id, nucleus.id]);
  assert.deepEqual(first.events.map((event) => event.eventId), [nucleus.id, genesis.id]);
  assert.equal(first.targets[0]?.materializedFile.status, "verified");
  assert.equal(Object.isFrozen(first.targets[0]?.eventIds), true);
});

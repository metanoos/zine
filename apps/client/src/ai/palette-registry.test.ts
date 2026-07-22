import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { OP_ORDER, type OpKind } from "./op-prompts.js";
import {
  BUILTIN_AI_PALETTE_REGISTRY,
  resolveAiPaletteRegistry,
  validateAiPaletteRegistry,
  type AiPaletteActionDescription,
} from "./palette-registry.js";

const appSource = [
  readFileSync(new URL("../app/AppShell.tsx", import.meta.url), "utf8"),
  readFileSync(new URL("../app/App.tsx", import.meta.url), "utf8"),
].join("\n");

function mutableBuiltinCopy(): Array<Record<string, unknown>> {
  return JSON.parse(JSON.stringify(BUILTIN_AI_PALETTE_REGISTRY)) as Array<Record<string, unknown>>;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function immutableCopy(
  mutate: (rows: Array<Record<string, unknown>>) => void,
): readonly unknown[] {
  const rows = mutableBuiltinCopy();
  mutate(rows);
  return deepFreeze(rows);
}

function rowActions(row: Record<string, unknown>): Array<Record<string, unknown>> {
  return row.actions as Array<Record<string, unknown>>;
}

test("the built-in registry exposes exactly the current single AI row", () => {
  assert.equal(BUILTIN_AI_PALETTE_REGISTRY.length, 1);
  const [row] = BUILTIN_AI_PALETTE_REGISTRY;
  assert.equal(row.id, "ai-default");
  assert.equal(row.participantRole, "ai");
  assert.deepEqual(row.voice, { binding: "model", ariaLabel: "AI voice" });
  assert.deepEqual(row.providerSelection, {
    capability: "voice-pinned",
    requiredForActions: true,
  });
  assert.deepEqual(row.label, {
    defaultLabel: "AI",
    aliases: ["AI", "ASSISTANT", "AUTOMATIC", "AUTOMATON", "LLM"],
    storageKey: "zine.modelLabel",
    rerollTitle: "Click to update label in view; no effect on behavior",
  });
});

test("the five prepared operations and Run preserve today's row order and labels", () => {
  const actions = BUILTIN_AI_PALETTE_REGISTRY[0].actions;
  assert.deepEqual(
    actions.map(({ id, label }) => [id, label]),
    [
      ["analyze", "Analyze"],
      ["reply", "Reply"],
      ["extend", "Extend"],
      ["stir", "Stir"],
      ["settle", "Settle"],
      ["run", "Run"],
    ],
  );
  assert.deepEqual(
    actions.filter((action) => action.kind === "operation").map((action) => action.id),
    ["analyze", "reply", "extend", "stir", "settle"],
  );
});

test("every declared prepared operation belongs to the existing bounded union", () => {
  const declared = BUILTIN_AI_PALETTE_REGISTRY[0].actions
    .filter((action): action is Extract<AiPaletteActionDescription, { kind: "operation" }> =>
      action.kind === "operation")
    .map((action) => action.id);
  const bounded: OpKind[] = declared;
  assert.deepEqual([...bounded].sort(), [...OP_ORDER].sort());
});

test("registry objects are deeply immutable and normalize deterministically", () => {
  const first = validateAiPaletteRegistry(BUILTIN_AI_PALETTE_REGISTRY);
  const second = validateAiPaletteRegistry(BUILTIN_AI_PALETTE_REGISTRY);
  assert.deepEqual(first, second);
  assert.notStrictEqual(first, BUILTIN_AI_PALETTE_REGISTRY);
  assert.ok(Object.isFrozen(BUILTIN_AI_PALETTE_REGISTRY));
  assert.ok(Object.isFrozen(BUILTIN_AI_PALETTE_REGISTRY[0]));
  assert.ok(Object.isFrozen(BUILTIN_AI_PALETTE_REGISTRY[0].label.aliases));
  assert.ok(Object.isFrozen(BUILTIN_AI_PALETTE_REGISTRY[0].actions));
  assert.ok(BUILTIN_AI_PALETTE_REGISTRY[0].actions.every(Object.isFrozen));
  assert.throws(() => {
    (BUILTIN_AI_PALETTE_REGISTRY[0].label.aliases as string[]).push("MUTATED");
  }, TypeError);
});

test("validation rejects mutable data and duplicate row or operation ids", () => {
  assert.throws(
    () => validateAiPaletteRegistry(mutableBuiltinCopy()),
    /deeply immutable/,
  );
  assert.throws(
    () => validateAiPaletteRegistry(immutableCopy((rows) => rows.push({ ...rows[0] }))),
    /duplicate AI palette row id/,
  );
  assert.throws(
    () => validateAiPaletteRegistry(immutableCopy((rows) => {
      rowActions(rows[0]).push({ ...rowActions(rows[0])[0] });
    })),
    /duplicate AI palette operation id/,
  );
});

test("validation rejects unknown and missing operations", () => {
  assert.throws(
    () => validateAiPaletteRegistry(immutableCopy((rows) => {
      rowActions(rows[0])[0].id = "custom-prompt";
    })),
    /unknown AI palette operation id: custom-prompt/,
  );
  assert.throws(
    () => validateAiPaletteRegistry(immutableCopy((rows) => {
      rows[0].actions = rowActions(rows[0]).filter((action) => action.id !== "settle");
    })),
    /missing required AI palette operations: settle/,
  );
});

test("closed registry descriptions reject executable or prompt-bearing fields", () => {
  assert.throws(
    () => validateAiPaletteRegistry(immutableCopy((rows) => {
      rowActions(rows[0])[0].execute = "arbitrary callback";
    })),
    /unsupported fields: execute/,
  );
  assert.throws(
    () => validateAiPaletteRegistry(immutableCopy((rows) => {
      rowActions(rows[0])[0].prompt = "arbitrary prompt";
    })),
    /unsupported fields: prompt/,
  );
});

test("custom input fails closed to the built-in registry", () => {
  const validExternalCopy = immutableCopy(() => undefined);
  const invalidExternalCopy = immutableCopy((rows) => {
    rows[0].actions = [];
  });
  assert.strictEqual(resolveAiPaletteRegistry(validExternalCopy), BUILTIN_AI_PALETTE_REGISTRY);
  assert.strictEqual(resolveAiPaletteRegistry(invalidExternalCopy), BUILTIN_AI_PALETTE_REGISTRY);
  assert.strictEqual(resolveAiPaletteRegistry(), BUILTIN_AI_PALETTE_REGISTRY);
});

test("App consumes the registry instead of maintaining a second AI action list", () => {
  assert.match(appSource, /const AI_PALETTE_ROW = resolveAiPaletteRegistry\(\)\[0\]/);
  assert.match(appSource, /AI_PALETTE_ROW\.actions\.map\(\(action\) =>/);
  assert.doesNotMatch(appSource, /const VOICE_OPS|MODEL_ALIASES|MODEL_LABEL_KEY/);
  assert.doesNotMatch(appSource, /\{ op: "analyze", label: "Analyze"/);
});

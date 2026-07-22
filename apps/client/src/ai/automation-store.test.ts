import test from "node:test";
import assert from "node:assert/strict";

import {
  dueAutomationRecipes,
  dueAutomationRecipesForWorkspace,
  finishAgentRunManifest,
  loadAutomationRecipes,
  markAutomationRecipeStarted,
  nextAutomationRunAt,
  reconcileAutomationRecipes,
  releaseAutomationLease,
  removeAutomationRecipe,
  serializeAgentRunManifest,
  tryAcquireAutomationLease,
  upsertAutomationRecipe,
  type AgentRunManifest,
} from "./automation-store.js";

class MemoryStorage {
  private values = new Map<string, string>();
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
  removeItem(key: string): void {
    this.values.delete(key);
  }
}

const WORKSPACE_BINDING = {
  workspaceId: "workspace-a",
  workspaceLabel: "Research",
  scopes: [
    { kind: "folder" as const, path: "notes" },
  ] as [{ kind: "folder"; path: string }],
};

test("recipes persist, update in place, and remove", () => {
  const storage = new MemoryStorage();
  const created = upsertAutomationRecipe(
    {
      label: "Morning brief",
      goal: "  Summarize the open notes.  ",
      providerId: "model-a",
      ...WORKSPACE_BINDING,
      intervalMinutes: 1_440,
      enabled: true,
    },
    storage,
    1_000,
    () => "recipe-a",
  );
  assert.equal(created.goal, "Summarize the open notes.");
  assert.deepEqual(created.scopes, WORKSPACE_BINDING.scopes);
  assert.deepEqual(loadAutomationRecipes(storage, 1_000), [created]);

  const updated = upsertAutomationRecipe(
    { ...created, label: "Daily brief", intervalMinutes: null, enabled: false },
    storage,
    2_000,
  );
  assert.equal(updated.id, created.id);
  assert.equal(updated.createdAt, 1_000);
  assert.equal(updated.enabled, true, "manual-only recipes do not retain a misleading paused state");
  assert.deepEqual(removeAutomationRecipe(created.id, storage, 3_000), []);
});

test("due recipes wait one interval, sort by deadline, and are claimed before work", () => {
  const storage = new MemoryStorage();
  const hourly = upsertAutomationRecipe(
    {
      label: "Hourly",
      goal: "Check notes",
      providerId: "model-a",
      ...WORKSPACE_BINDING,
      intervalMinutes: 60,
      enabled: true,
    },
    storage,
    10_000,
    () => "hourly",
  );
  const frequent = upsertAutomationRecipe(
    {
      label: "Frequent",
      goal: "Check inbox",
      providerId: "model-a",
      ...WORKSPACE_BINDING,
      intervalMinutes: 15,
      enabled: true,
    },
    storage,
    20_000,
    () => "frequent",
  );
  assert.deepEqual(dueAutomationRecipes([hourly, frequent], 20_000), []);
  assert.deepEqual(
    dueAutomationRecipes([hourly, frequent], 3_620_000).map((recipe) => recipe.id),
    ["frequent", "hourly"],
  );

  const claimed = markAutomationRecipeStarted("frequent", 3_620_000, storage);
  const claimedFrequent = claimed.find((recipe) => recipe.id === "frequent")!;
  assert.equal(claimedFrequent.lastRunAt, 3_620_000);
  assert.equal(nextAutomationRunAt(claimedFrequent), 4_520_000);
  assert.deepEqual(
    dueAutomationRecipes(claimed, 3_620_000).map((recipe) => recipe.id),
    ["hourly"],
  );
  assert.deepEqual(
    dueAutomationRecipesForWorkspace(claimed, "workspace-a", 3_620_000).map((recipe) => recipe.id),
    ["hourly"],
  );
  assert.deepEqual(dueAutomationRecipesForWorkspace(claimed, "workspace-b", 3_620_000), []);
});

test("disabled and manual-only recipes are never due", () => {
  const storage = new MemoryStorage();
  const paused = upsertAutomationRecipe(
    {
      label: "Paused",
      goal: "Do not run",
      providerId: "model-a",
      ...WORKSPACE_BINDING,
      intervalMinutes: 5,
      enabled: false,
    },
    storage,
    0,
    () => "paused",
  );
  const manual = upsertAutomationRecipe(
    {
      label: "Manual",
      goal: "Run on demand",
      providerId: "model-a",
      ...WORKSPACE_BINDING,
      intervalMinutes: null,
      enabled: true,
    },
    storage,
    0,
    () => "manual",
  );
  assert.deepEqual(dueAutomationRecipes([paused, manual], Number.MAX_SAFE_INTEGER), []);
});

test("scheduler recipe refresh preserves state identity when storage is unchanged", () => {
  const storage = new MemoryStorage();
  upsertAutomationRecipe(
    {
      label: "Morning brief",
      goal: "Summarize notes",
      providerId: "model-a",
      ...WORKSPACE_BINDING,
      intervalMinutes: 60,
      enabled: true,
    },
    storage,
    1_000,
    () => "recipe-a",
  );
  const current = loadAutomationRecipes(storage, 2_000);

  assert.strictEqual(reconcileAutomationRecipes(current, storage, 2_000), current);

  markAutomationRecipeStarted("recipe-a", 3_000, storage);
  const refreshed = reconcileAutomationRecipes(current, storage, 3_000);
  assert.notStrictEqual(refreshed, current);
  assert.equal(refreshed[0]?.lastRunAt, 3_000);
  assert.strictEqual(reconcileAutomationRecipes(refreshed, storage, 3_000), refreshed);

  removeAutomationRecipe("recipe-a", storage, 4_000);
  assert.deepEqual(reconcileAutomationRecipes(refreshed, storage, 4_000), []);
});

test("corrupt recipe storage fails closed", () => {
  const storage = new MemoryStorage();
  storage.setItem("zine.automations.v1", "not json");
  assert.deepEqual(loadAutomationRecipes(storage, 1_000), []);
});

test("recipes without a workspace binding are rejected", () => {
  const storage = new MemoryStorage();
  storage.setItem("zine.automations.v1", JSON.stringify([{
    id: "unbound",
    label: "Unbound",
    goal: "Unbound scheduled goal",
    providerId: "model-a",
    intervalMinutes: 60,
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
  }]));
  assert.deepEqual(loadAutomationRecipes(storage, 1_000), []);
});

test("recipes with parallel mounts are rejected", () => {
  const storage = new MemoryStorage();
  storage.setItem("zine.automations.v1", JSON.stringify([{
    id: "parallel",
    label: "Old parallel recipe",
    goal: "Summarize",
    providerId: "model-a",
    workspaceId: "workspace-a",
    scopes: [
      { kind: "folder", path: "notes" },
      { kind: "file", path: "brief.md" },
    ],
    intervalMinutes: 60,
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
  }]));

  assert.deepEqual(loadAutomationRecipes(storage, 1_000), []);
});

test("new recipes cannot silently save without a workspace scope binding", () => {
  const storage = new MemoryStorage();
  assert.throws(() => upsertAutomationRecipe({
    label: "Unsafe",
    goal: "Run somewhere",
    providerId: "model-a",
    workspaceId: "",
    scopes: [],
    intervalMinutes: 60,
    enabled: true,
  }, storage), /workspace and at least one scope/);
});

test("fallback scheduler lease is single-owner, expiring, and owner-released", () => {
  const storage = new MemoryStorage();
  assert.equal(tryAcquireAutomationLease("window-a", storage, 1_000, 5_000), true);
  assert.equal(tryAcquireAutomationLease("window-b", storage, 2_000, 5_000), false);
  releaseAutomationLease("window-b", storage);
  assert.equal(tryAcquireAutomationLease("window-b", storage, 6_001, 5_000), true);
  releaseAutomationLease("window-b", storage);
  assert.equal(tryAcquireAutomationLease("window-a", storage, 6_002, 5_000), true);
});

test("run manifests serialize only safe model metadata and record completion", () => {
  const running: AgentRunManifest = {
    version: 1,
    runId: "run-a",
    runPath: "_brief-run-a",
    trigger: "schedule",
    recipe: { id: "recipe-a", label: "Brief" },
    goal: "Draft a brief",
    workspace: { id: "workspace-a", label: "Research" },
    scopes: WORKSPACE_BINDING.scopes,
    model: {
      providerId: "provider-a",
      label: "Hosted model",
      modelId: "model-a",
      protocol: "openai",
    },
    scope: { kind: "folder", path: "notes" },
    status: "running",
    startedAt: "2026-07-15T10:00:00.000Z",
    outputPath: "_brief-run-a/output.md",
  };
  const completed = finishAgentRunManifest(
    running,
    "completed",
    "2026-07-15T10:01:00.000Z",
  );
  const parsed = JSON.parse(serializeAgentRunManifest(completed));
  assert.equal(parsed.status, "completed");
  assert.equal(parsed.completedAt, "2026-07-15T10:01:00.000Z");
  assert.equal(parsed.workspace.id, "workspace-a");
  assert.deepEqual(parsed.scopes, WORKSPACE_BINDING.scopes);
  assert.equal(parsed.model.apiKey, undefined);
});

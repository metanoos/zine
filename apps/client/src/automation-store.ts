/**
 * Local automation recipes and durable agent-run manifests.
 *
 * Recipes are a browser-local convenience: they are not protocol events and
 * never grant an agent any capability it does not already have. Each recipe is
 * bound to a permanent workspace id and explicit scope mounts. The scheduler
 * only re-enters App's existing draft-only `startAgentRun` path while Zine is
 * open. Run manifests live inside each run's sandbox folder as `run.json`, so
 * the goal, model, trigger, binding, and outcome survive the in-memory loop.
 */

export const AUTOMATION_STORAGE_KEY = "zine.automations.v1";
const AUTOMATION_LOCK_KEY = "zine.automations.scheduler-lock.v1";
const AUTOMATION_WEB_LOCK = "zine-automation-scheduler";
const FALLBACK_LEASE_MS = 8 * 60 * 60 * 1_000;

export type AutomationStorage = Pick<Storage, "getItem" | "setItem">;
export type AutomationLeaseStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export interface AutomationScope {
  kind: "file" | "folder";
  path: string;
}

export interface AutomationRecipe {
  id: string;
  label: string;
  goal: string;
  providerId: string;
  /** Permanent folder genesis id. Empty only on a legacy, not-yet-rebound recipe. */
  workspaceId: string;
  workspaceLabel?: string;
  /** Exact explicit mounts captured when the recipe was saved. */
  scopes: AutomationScope[];
  /** null means manual-only; otherwise the interval between starts. */
  intervalMinutes: number | null;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  lastRunAt?: number;
}

export interface AutomationRecipeDraft {
  id?: string;
  label: string;
  goal: string;
  providerId: string;
  intervalMinutes: number | null;
  enabled: boolean;
}

export interface AutomationRecipeInput extends AutomationRecipeDraft {
  workspaceId: string;
  workspaceLabel?: string;
  scopes: AutomationScope[];
}

export type AgentRunTrigger = "manual" | "schedule";
export type AgentRunStatus = "running" | "completed" | "stopped" | "failed";

export interface AgentRunManifest {
  version: 1;
  runId: string;
  runPath: string;
  trigger: AgentRunTrigger;
  recipe?: {
    id: string;
    label: string;
  };
  goal: string;
  workspace: {
    id: string;
    label?: string;
  };
  scopes: AutomationScope[];
  model: {
    providerId: string;
    label: string;
    modelId: string;
    protocol: string;
  };
  scope: {
    kind: "file" | "folder";
    path: string;
  } | null;
  status: AgentRunStatus;
  startedAt: string;
  completedAt?: string;
  outputPath: string;
  error?: string;
}

function defaultRecipeId(): string {
  return `automation-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function finiteTimestamp(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function interval(value: unknown): number | null | undefined {
  if (value === null) return null;
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

function normalizeScopes(value: unknown): AutomationScope[] {
  if (!Array.isArray(value)) return [];
  const scopes: AutomationScope[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const scope = raw as Record<string, unknown>;
    const kind = scope.kind;
    const path = scope.path;
    if ((kind !== "file" && kind !== "folder") || typeof path !== "string") continue;
    const key = `${kind}:${path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    scopes.push({ kind, path });
  }
  return scopes;
}

function normalizeRecipes(value: unknown, now: number): AutomationRecipe[] {
  if (!Array.isArray(value)) return [];
  const recipes: AutomationRecipe[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const id = typeof item.id === "string" ? item.id.trim() : "";
    const goal = typeof item.goal === "string" ? item.goal.trim() : "";
    const providerId = typeof item.providerId === "string" ? item.providerId.trim() : "";
    // Legacy v1 recipes had no workspace binding. Preserve them as unbound so
    // the UI can rebind on Update, but never let the scheduler guess a folder.
    const workspaceId = typeof item.workspaceId === "string" ? item.workspaceId.trim() : "";
    const workspaceLabel = typeof item.workspaceLabel === "string" && item.workspaceLabel.trim()
      ? item.workspaceLabel.trim()
      : undefined;
    const scopes = normalizeScopes(item.scopes);
    const every = interval(item.intervalMinutes);
    if (!id || seen.has(id) || !goal || !providerId || every === undefined) continue;
    seen.add(id);
    const label = typeof item.label === "string" && item.label.trim()
      ? item.label.trim()
      : goal.slice(0, 64);
    const createdAt = finiteTimestamp(item.createdAt) ?? now;
    const updatedAt = finiteTimestamp(item.updatedAt) ?? createdAt;
    const lastRunAt = finiteTimestamp(item.lastRunAt);
    recipes.push({
      id,
      label,
      goal,
      providerId,
      workspaceId,
      ...(workspaceLabel ? { workspaceLabel } : {}),
      scopes,
      intervalMinutes: every,
      enabled: every === null ? true : item.enabled !== false,
      createdAt,
      updatedAt,
      ...(lastRunAt === undefined ? {} : { lastRunAt }),
    });
  }
  return recipes;
}

export function loadAutomationRecipes(
  storage: AutomationStorage = localStorage,
  now = Date.now(),
): AutomationRecipe[] {
  try {
    const raw = storage.getItem(AUTOMATION_STORAGE_KEY);
    return raw ? normalizeRecipes(JSON.parse(raw), now) : [];
  } catch {
    return [];
  }
}

export function saveAutomationRecipes(
  recipes: readonly AutomationRecipe[],
  storage: AutomationStorage = localStorage,
  now = Date.now(),
): AutomationRecipe[] {
  const normalized = normalizeRecipes(recipes, now);
  storage.setItem(AUTOMATION_STORAGE_KEY, JSON.stringify(normalized));
  return normalized;
}

export function upsertAutomationRecipe(
  input: AutomationRecipeInput,
  storage: AutomationStorage = localStorage,
  now = Date.now(),
  createId: () => string = defaultRecipeId,
): AutomationRecipe {
  const current = loadAutomationRecipes(storage, now);
  const existing = input.id ? current.find((recipe) => recipe.id === input.id) : undefined;
  const goal = input.goal.trim();
  const providerId = input.providerId.trim();
  const workspaceId = input.workspaceId.trim();
  const scopes = normalizeScopes(input.scopes);
  if (!goal || !providerId) throw new Error("automation recipes require a goal and model");
  if (!workspaceId || scopes.length === 0) {
    throw new Error("automation recipes require a workspace and at least one scope");
  }
  const every = interval(input.intervalMinutes);
  if (every === undefined) throw new Error("automation interval must be a positive whole number of minutes");
  const recipe: AutomationRecipe = {
    id: existing?.id ?? createId(),
    label: input.label.trim() || goal.slice(0, 64),
    goal,
    providerId,
    workspaceId,
    ...(input.workspaceLabel?.trim() ? { workspaceLabel: input.workspaceLabel.trim() } : {}),
    scopes,
    intervalMinutes: every,
    enabled: every === null ? true : input.enabled,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    ...(existing?.lastRunAt === undefined ? {} : { lastRunAt: existing.lastRunAt }),
  };
  saveAutomationRecipes(
    existing
      ? current.map((item) => item.id === existing.id ? recipe : item)
      : [...current, recipe],
    storage,
    now,
  );
  return recipe;
}

export function removeAutomationRecipe(
  id: string,
  storage: AutomationStorage = localStorage,
  now = Date.now(),
): AutomationRecipe[] {
  return saveAutomationRecipes(
    loadAutomationRecipes(storage, now).filter((recipe) => recipe.id !== id),
    storage,
    now,
  );
}

/** Record the start before awaiting the model, preventing the same overdue
 * recipe from being claimed by the next scheduler tick. */
export function markAutomationRecipeStarted(
  id: string,
  startedAt = Date.now(),
  storage: AutomationStorage = localStorage,
): AutomationRecipe[] {
  return saveAutomationRecipes(
    loadAutomationRecipes(storage, startedAt).map((recipe) =>
      recipe.id === id
        ? { ...recipe, lastRunAt: startedAt, updatedAt: startedAt }
        : recipe,
    ),
    storage,
    startedAt,
  );
}

export function nextAutomationRunAt(recipe: AutomationRecipe): number | null {
  if (!recipe.enabled || recipe.intervalMinutes === null) return null;
  return (recipe.lastRunAt ?? recipe.createdAt) + recipe.intervalMinutes * 60_000;
}

/** Overdue recipes, oldest deadline first. The scheduler still checks that
 * each recipe's provider exists and that no foreground operation is active. */
export function dueAutomationRecipes(
  recipes: readonly AutomationRecipe[],
  now = Date.now(),
): AutomationRecipe[] {
  return recipes
    .map((recipe) => ({ recipe, dueAt: nextAutomationRunAt(recipe) }))
    .filter((entry): entry is { recipe: AutomationRecipe; dueAt: number } =>
      entry.dueAt !== null && entry.dueAt <= now,
    )
    .sort((a, b) => a.dueAt - b.dueAt || a.recipe.id.localeCompare(b.recipe.id))
    .map((entry) => entry.recipe);
}

/** Only a recipe explicitly bound to this workspace may be considered. Legacy
 * unbound recipes remain visible for manual rebinding but never auto-run. */
export function dueAutomationRecipesForWorkspace(
  recipes: readonly AutomationRecipe[],
  workspaceId: string,
  now = Date.now(),
): AutomationRecipe[] {
  return dueAutomationRecipes(
    recipes.filter((recipe) => recipe.workspaceId === workspaceId && recipe.scopes.length > 0),
    now,
  );
}

interface AutomationLease {
  owner: string;
  expiresAt: number;
}

function readLease(storage: AutomationLeaseStorage): AutomationLease | null {
  try {
    const raw = storage.getItem(AUTOMATION_LOCK_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<AutomationLease>;
    if (
      typeof parsed.owner !== "string" ||
      !parsed.owner ||
      typeof parsed.expiresAt !== "number" ||
      !Number.isFinite(parsed.expiresAt)
    ) return null;
    return { owner: parsed.owner, expiresAt: parsed.expiresAt };
  } catch {
    return null;
  }
}

/** Portable fallback for webviews without Web Locks. The write-then-verify
 * step makes the last contender authoritative; an expiry recovers crashes. */
export function tryAcquireAutomationLease(
  owner: string,
  storage: AutomationLeaseStorage = localStorage,
  now = Date.now(),
  leaseMs = FALLBACK_LEASE_MS,
): boolean {
  const current = readLease(storage);
  if (current && current.owner !== owner && current.expiresAt > now) return false;
  try {
    storage.setItem(AUTOMATION_LOCK_KEY, JSON.stringify({ owner, expiresAt: now + leaseMs }));
    return readLease(storage)?.owner === owner;
  } catch {
    return false;
  }
}

export function releaseAutomationLease(
  owner: string,
  storage: AutomationLeaseStorage = localStorage,
): void {
  try {
    if (readLease(storage)?.owner === owner) storage.removeItem(AUTOMATION_LOCK_KEY);
  } catch {
    // A lease expires even if storage becomes unavailable during cleanup.
  }
}

/** Hold a browser-wide single-flight lock for one scheduled run. Web Locks is
 * authoritative when available; localStorage supplies a crash-expiring lease
 * for older embedded webviews. Returns false when another window owns it. */
export async function withAutomationSchedulerLock(
  work: () => Promise<void>,
  storage: AutomationLeaseStorage = localStorage,
): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.locks) {
    let acquired = false;
    await navigator.locks.request(
      AUTOMATION_WEB_LOCK,
      { ifAvailable: true },
      async (lock) => {
        if (!lock) return;
        acquired = true;
        await work();
      },
    );
    return acquired;
  }
  const owner = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `window-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  if (!tryAcquireAutomationLease(owner, storage)) return false;
  try {
    // Give a racing window one task turn to publish its contender, then verify
    // ownership again. The final writer is the only one that enters `work`.
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    if (readLease(storage)?.owner !== owner) return false;
    await work();
    return true;
  } finally {
    releaseAutomationLease(owner, storage);
  }
}

export function finishAgentRunManifest(
  manifest: AgentRunManifest,
  status: Exclude<AgentRunStatus, "running">,
  completedAt = new Date().toISOString(),
  error?: string,
): AgentRunManifest {
  return {
    ...manifest,
    status,
    completedAt,
    ...(error ? { error } : {}),
  };
}

export function serializeAgentRunManifest(manifest: AgentRunManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

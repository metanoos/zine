/**
 * Run — kick off an in-app agent loop.
 *
 * The modal the MODEL row's Run button opens. An agent run takes a freeform
 * goal, creates a sandboxed subfolder under the current scope, and works there
 * via a tool-calling loop — think/act/write, with optional fan-out to
 * subagents running different models (each a distinct voice/color). Everything
 * it writes is DRAFT until the human author Steps it; nothing steps here.
 *
 * The modal is the entry surface for one-off runs and browser-local recipes.
 * Scheduled recipes re-enter the exact same draft-only path while Zine is
 * open; the actual loop lives in agent-loop.ts and is invoked via `onStart`.
 */

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  nextAutomationRunAt,
  type AutomationRecipe,
  type AutomationRecipeDraft,
  type AutomationScope,
} from "./automation-store.js";
import type { ProviderConfig } from "./models-store.js";

export interface RunModalProps {
  /** Configured providers, for the root-model dropdown. */
  providers: ProviderConfig[];
  /** The currently active provider id (default selection). */
  defaultProviderId: string | null;
  recipes: AutomationRecipe[];
  currentWorkspace: { id: string; label?: string } | null;
  currentScopes: AutomationScope[];
  /** Called with the goal + chosen provider when the user clicks Run now. */
  onStart: (goal: string, providerId: string, recipeId?: string) => void;
  onSaveRecipe: (input: AutomationRecipeDraft) => AutomationRecipe;
  onDeleteRecipe: (id: string) => void;
  onClose: () => void;
}

function scopeSummary(scopes: readonly AutomationScope[]): string {
  if (scopes.length === 0) return "no scope selected";
  if (scopes.length <= 2) {
    return scopes.map((scope) => scope.path || "root").join(" + ");
  }
  return `${scopes.length} mounted scopes`;
}

/** Modal overlay + dialog for composing an agent-run goal. Mirrors the
 *  compose-overlay / compose-dialog shell AttestModal uses. */
export function RunModal({
  providers,
  defaultProviderId,
  recipes,
  currentWorkspace,
  currentScopes,
  onStart,
  onSaveRecipe,
  onDeleteRecipe,
  onClose,
}: RunModalProps) {
  const [goal, setGoal] = useState("");
  const [providerId, setProviderId] = useState(
    defaultProviderId && providers.some((p) => p.id === defaultProviderId)
      ? defaultProviderId
      : providers[0]?.id ?? "",
  );
  const [selectedRecipeId, setSelectedRecipeId] = useState("");
  const [label, setLabel] = useState("");
  const [intervalMinutes, setIntervalMinutes] = useState<number | null>(null);
  const [enabled, setEnabled] = useState(true);
  const ref = useRef<HTMLTextAreaElement>(null);
  const selectedRecipe = recipes.find((recipe) => recipe.id === selectedRecipeId) ?? null;
  const providerAvailable = providers.some((provider) => provider.id === providerId);
  const recipeMatchesDraft = !!selectedRecipe &&
    selectedRecipe.goal === goal.trim() &&
    selectedRecipe.providerId === providerId;
  const recipeBoundHere = !!selectedRecipe &&
    !!currentWorkspace &&
    selectedRecipe.workspaceId === currentWorkspace.id &&
    selectedRecipe.scopes.length > 0;
  const canRun = !!goal.trim() && providerAvailable && (!recipeMatchesDraft || recipeBoundHere);

  // Autofocus the textarea on open, so typing begins immediately.
  useEffect(() => {
    ref.current?.focus();
  }, []);

  // Enter starts (Shift+Enter for newline); Escape closes.
  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      commit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  }

  function commit() {
    const trimmed = goal.trim();
    if (!trimmed || !canRun) return;
    onStart(trimmed, providerId, recipeMatchesDraft && recipeBoundHere ? selectedRecipe?.id : undefined);
  }

  function chooseRecipe(id: string) {
    setSelectedRecipeId(id);
    const recipe = recipes.find((item) => item.id === id);
    if (!recipe) {
      setLabel("");
      setIntervalMinutes(null);
      setEnabled(true);
      return;
    }
    setLabel(recipe.label);
    setGoal(recipe.goal);
    setProviderId(recipe.providerId);
    setIntervalMinutes(recipe.intervalMinutes);
    setEnabled(recipe.enabled);
    requestAnimationFrame(() => ref.current?.focus());
  }

  function saveRecipe() {
    const trimmed = goal.trim();
    if (!trimmed || !providerId) return;
    const saved = onSaveRecipe({
      ...(selectedRecipe ? { id: selectedRecipe.id } : {}),
      label,
      goal: trimmed,
      providerId,
      intervalMinutes,
      enabled,
    });
    setSelectedRecipeId(saved.id);
    setLabel(saved.label);
    setEnabled(saved.enabled);
  }

  function deleteRecipe() {
    if (!selectedRecipe) return;
    onDeleteRecipe(selectedRecipe.id);
    setSelectedRecipeId("");
    setLabel("");
    setIntervalMinutes(null);
    setEnabled(true);
  }

  const nextRunAt = selectedRecipe ? nextAutomationRunAt(selectedRecipe) : null;

  return createPortal(
    <div className="compose-overlay run-overlay" onClick={onClose}>
      <div className="compose-dialog run-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="run-head">
          <h2 className="run-title">Run an agent</h2>
          <button type="button" className="attest-close" aria-label="Close" onClick={onClose}>×</button>
        </div>
        <p className="run-blurb">
          Describe a goal. The agent creates a subfolder under the current scope, works there
          (reading, writing, thinking), and can fan out to subagents on other models. Everything
          it writes stays draft until you Step it.
        </p>
        <div className="run-recipe-row">
          <label className="run-field">
            <span>Recipe</span>
            <select
              className="run-recipe-select"
              value={selectedRecipeId}
              onChange={(e) => chooseRecipe(e.target.value)}
            >
              <option value="">New recipe…</option>
              {recipes.map((recipe) => (
                <option key={recipe.id} value={recipe.id}>
                  {recipe.label}
                  {!recipe.workspaceId
                    ? " · needs binding"
                    : currentWorkspace && recipe.workspaceId !== currentWorkspace.id
                      ? ` · ${recipe.workspaceLabel || recipe.workspaceId.slice(0, 8)}`
                      : ""}
                </option>
              ))}
            </select>
          </label>
          <label className="run-field run-label-field">
            <span>Name</span>
            <input
              className="run-label-input"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="From the goal if blank"
            />
          </label>
        </div>
        <textarea
          ref={ref}
          className="run-goal-input"
          placeholder="e.g. Research the trade-offs between CRDTs and operation logs for local-first apps, then draft a comparison."
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          onKeyDown={onKeyDown}
          rows={6}
        />
        <div className="run-schedule-row">
          <label className="run-field">
            <span>Schedule</span>
            <select
              className="run-schedule-select"
              value={intervalMinutes ?? "manual"}
              onChange={(e) => {
                const value = e.target.value;
                setIntervalMinutes(value === "manual" ? null : Number(value));
                if (value === "manual") setEnabled(true);
              }}
            >
              <option value="manual">Manual only</option>
              <option value="60">Every hour</option>
              <option value="1440">Every day</option>
            </select>
          </label>
          {intervalMinutes !== null && (
            <label className="run-enabled-toggle">
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)}
              />
              Enabled
            </label>
          )}
          <span className="run-schedule-note">
            {enabled && nextRunAt
              ? `Next due ${new Date(nextRunAt).toLocaleString()}`
              : intervalMinutes === null
                ? "Runs on demand"
                : !enabled
                  ? "Paused"
                  : "Timer begins when saved"}
          </span>
        </div>
        <p className="run-binding-note">
          {!currentWorkspace
            ? "Open a workspace before saving a recipe."
            : !selectedRecipe
              ? `Will bind to ${currentWorkspace.label || currentWorkspace.id.slice(0, 8)} · ${scopeSummary(currentScopes)}`
              : !selectedRecipe.workspaceId
                ? "Legacy recipe · Update recipe to bind it to this workspace and scope."
                : recipeBoundHere
                  ? `Bound to ${selectedRecipe.workspaceLabel || selectedRecipe.workspaceId.slice(0, 8)} · ${scopeSummary(selectedRecipe.scopes)}`
                  : `Bound to ${selectedRecipe.workspaceLabel || selectedRecipe.workspaceId.slice(0, 8)} · open that workspace to run, or Update recipe to rebind here.`}
        </p>
        <div className="run-foot">
          <select
            className="run-model-select"
            value={providerId}
            onChange={(e) => setProviderId(e.target.value)}
            disabled={providers.length === 0}
            title="Root model for the agent run"
          >
            {providers.length === 0 ? (
              <option value="">add a model…</option>
            ) : (
              <>
                {providerId && !providerAvailable && (
                  <option value={providerId}>missing model ({providerId})</option>
                )}
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>{p.label || p.modelId || p.id}</option>
                ))}
              </>
            )}
          </select>
          <div className="run-actions">
            {selectedRecipe && (
              <button type="button" className="run-delete" onClick={deleteRecipe}>
                Delete
              </button>
            )}
            <button
              type="button"
              className="run-save"
              onClick={saveRecipe}
              disabled={!goal.trim() || !providerId || !currentWorkspace || currentScopes.length === 0}
            >
              {selectedRecipe ? "Update recipe" : "Save recipe"}
            </button>
            <button
              type="button"
              className="run-start"
              onClick={commit}
              disabled={!canRun}
              title="Start the agent run (Enter)"
            >
              Run now
            </button>
          </div>
        </div>
        <p className="run-hint">
          Scheduled recipes run only while Zine is open · all output remains draft · Enter to run
        </p>
      </div>
    </div>,
    document.body,
  );
}

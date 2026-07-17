/**
 * The Models view — provider configuration for the LLM client. Promotes the
 * `models` nav entry from placeholder to real view, following the Download.tsx
 * precedent: a self-contained <section className="view-placeholder"> that owns
 * its hooks and renders into the same shell CSS.
 *
 * Each provider is a row with editable label / protocol / base URL / model /
 * key fields, plus a test-connection control. The list starts empty: instead
 * of seeding cards for every built-in preset, the "Add provider" button opens
 * a small menu of presets (z.ai, Anthropic, OpenAI, OpenRouter, Ollama) plus a
 * blank "Custom" entry; picking one adds a card pre-filled with that
 * provider's defaults. Any OpenAI/Anthropic-compatible endpoint can also be
 * added by hand via "Custom".
 *
 * There is no "active" provider here. Which model LLM ops run against is
 * chosen in Press via the top-bar model select (automatic-side mode cell,
 * opposite AUTHOR). This view only manages the provider catalog.
 *
 * Async state follows the sampler convention: a `{ state, msg }` tagged union
 * surfaced inline via `.sampler-status` (+ `.error`). No global toast system.
 */

import { useEffect, useRef, useState } from "react";
import { ChevronDown, GripVertical, Plus, Trash2 } from "lucide-react";
import {
  addProvider,
  addProviderFromPreset,
  availablePresets,
  loadProviders,
  patchProvider,
  removeProvider,
  saveProviders,
  setProviderCredential,
  type ModelPersonality,
  type ModelVerbosity,
  type ProviderConfig,
  type ProviderProtocol,
  type ReasoningEffort,
} from "./models-store.js";
import { probeProvider } from "./llm.js";
import { isAnthropicEffort } from "./model-config.js";
import { canUseModelSecrets } from "./secret-store.js";
import { providerProfileFingerprint } from "./provider-fingerprint.js";

type TestState = Record<string, { state: "idle" | "testing" | "ok" | "error"; msg?: string }>;

const OPENAI_EFFORTS: ReasoningEffort[] = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];
const ANTHROPIC_EFFORTS: ReasoningEffort[] = ["low", "medium", "high", "xhigh", "max"];

export function ModelsView({
  onProvidersChange,
  modelLessonActive = false,
  onProviderTested,
}: {
  /** Called whenever the provider list changes (add/remove/patch) so App can
   *  refresh the Press model dropdown with the same card labels. */
  onProvidersChange?: (providers: ProviderConfig[]) => void;
  modelLessonActive?: boolean;
  onProviderTested?: (providerId: string, providerFingerprint: string) => void;
}) {
  const [providers, setProviders] = useState<ProviderConfig[]>(() => loadProviders());
  const [test, setTest] = useState<TestState>({});
  const [addOpen, setAddOpen] = useState(false);
  const [credentialDrafts, setCredentialDrafts] = useState<Record<string, string>>({});
  // The id of the provider being dragged, or null. Held over the duration of a
  // drag-and-drop reorder so a card knows to dim itself while it's the source.
  const [dragId, setDragId] = useState<string | null>(null);

  // The presets still available to add — recomputed from the current list so
  // a preset drops out of the menu as soon as it's been added.
  const presets = availablePresets(providers);

  function commit(next: ProviderConfig[]) {
    saveProviders(next);
    setProviders(next);
    onProvidersChange?.(next);
  }

  // Move the provider at `from` to `to` through the same commit() path
  // add/remove use, so the Press top-bar model dropdown picks up the new order
  // on its next read. One-based index: a no-op when the positions match.
  function reorderProviders(from: number, to: number) {
    if (from === to || from < 0 || to < 0 || from >= providers.length || to >= providers.length) return;
    const next = [...providers];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    commit(next);
  }

  function updateField(id: string, patch: Partial<Omit<ProviderConfig, "id">>) {
    // patchProvider already persists; refresh local state from its return and
    // push to App so the action-palette model select shows the card label live.
    const next = patchProvider(id, patch);
    setProviders(next);
    onProvidersChange?.(next);
  }

  async function commitCredential(id: string): Promise<void> {
    if (!(id in credentialDrafts)) return;
    const next = await setProviderCredential(id, credentialDrafts[id] ?? "");
    setProviders(next);
    onProvidersChange?.(next);
    setCredentialDrafts((current) => {
      const copy = { ...current };
      delete copy[id];
      return copy;
    });
  }

  async function runTest(cfg: ProviderConfig) {
    if (!cfg.baseUrl || !cfg.modelId) {
      setTest((t) => ({ ...t, [cfg.id]: { state: "error", msg: "set base URL + model first" } }));
      return;
    }
    setTest((t) => ({ ...t, [cfg.id]: { state: "testing" } }));
    try {
      await commitCredential(cfg.id);
      const testedProvider = loadProviders().find((provider) => provider.id === cfg.id) ?? cfg;
      const reply = await probeProvider(testedProvider);
      setTest((t) => ({
        ...t,
        [cfg.id]: { state: "ok", msg: reply ? reply.slice(0, 60) : "(empty reply)" },
      }));
      onProviderTested?.(testedProvider.id, providerProfileFingerprint(testedProvider));
    } catch (e) {
      setTest((t) => ({
        ...t,
        [cfg.id]: { state: "error", msg: e instanceof Error ? e.message : String(e) },
      }));
    }
  }

  // dismiss the Add menu on outside pointer-down or Escape, mirroring the
  // context-menu pattern in App.tsx.
  const addRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!addOpen) return;
    function onPointerDown(e: MouseEvent) {
      if (addRef.current && !addRef.current.contains(e.target as Node)) setAddOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setAddOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [addOpen]);

  if (!canUseModelSecrets()) {
    return (
      <section className="view-placeholder models-view">
        <p className="view-placeholder-blurb">
          This hosted press is model-free. AI providers are available only in an unlocked desktop vault.
        </p>
      </section>
    );
  }

  return (
    <section className="view-placeholder models-view">
      {modelLessonActive ? (
        <aside className="models-onboarding" role="status" aria-live="polite">
          <strong>AI CONTEXT · 1 OF 7</strong>
          <span>Add or choose an AI provider, save its credential, then use Test. The probe is synthetic and never includes workspace text; the next steps show how a trace gives the AI richer, inspectable context.</span>
        </aside>
      ) : null}
      <p className="view-placeholder-blurb">
        LLM providers for prompt injection — add from a preset or configure a
        custom endpoint.
      </p>

      <div className="models-list">
        {providers.map((p) => {
          const t = test[p.id] ?? { state: "idle" };
          const isLocal = p.baseUrl.startsWith("http://localhost") || p.baseUrl.startsWith("http://127.");
          const efforts = p.protocol === "anthropic" ? ANTHROPIC_EFFORTS : OPENAI_EFFORTS;
          const selectedEffort =
            p.protocol === "anthropic" && !isAnthropicEffort(p.reasoningEffort)
              ? ""
              : p.reasoningEffort ?? "";
          const temperatureMax = p.protocol === "anthropic" || p.baseUrl.includes("api.z.ai") ? 1 : 2;
          return (
            <div
              key={p.id}
              className={"settings-card models-card" + (dragId === p.id ? " is-dragging" : "")}
              onDragOver={(e) => {
                // Allow a drop on this card; the reorder fires on drop using the
                // source id carried in dataTransfer.
                if (dragId !== null && dragId !== p.id) {
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                }
              }}
              onDrop={(e) => {
                const fromId = e.dataTransfer.getData("text/provider-id");
                const from = providers.findIndex((x) => x.id === fromId);
                const to = providers.findIndex((x) => x.id === p.id);
                if (fromId && from !== -1 && to !== -1) reorderProviders(from, to);
              }}
            >
              <div className="models-card-header">
                <div
                  className="drag-handle"
                  title="Drag to reorder"
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.effectAllowed = "move";
                    e.dataTransfer.setData("text/provider-id", p.id);
                    setDragId(p.id);
                  }}
                  onDragEnd={() => setDragId(null)}
                >
                  <GripVertical size={14} strokeWidth={1.75} aria-hidden="true" />
                </div>
                <input
                  className="models-label-input"
                  value={p.label}
                  onChange={(e) => updateField(p.id, { label: e.target.value })}
                  aria-label="Provider label"
                />
                <div className="models-card-actions">
                  <button
                    type="button"
                    className="icon-btn models-delete"
                    title="Remove provider"
                    onClick={() => commit(removeProvider(p.id))}
                  >
                    <Trash2 size={13} aria-hidden="true" />
                  </button>
                </div>
              </div>
              <div className="models-fields">
                <label className="models-field">
                  <span>protocol</span>
                  <select
                    value={p.protocol}
                    onChange={(e) => updateField(p.id, { protocol: e.target.value as ProviderProtocol })}
                  >
                    <option value="openai">openai</option>
                    <option value="anthropic">anthropic</option>
                  </select>
                </label>
                <label className="models-field">
                  <span>base url</span>
                  <input
                    type="text"
                    value={p.baseUrl}
                    onChange={(e) => updateField(p.id, { baseUrl: e.target.value })}
                    placeholder="https://…"
                    spellCheck={false}
                  />
                </label>
                <label className="models-field">
                  <span>model</span>
                  <input
                    type="text"
                    value={p.modelId}
                    onChange={(e) => updateField(p.id, { modelId: e.target.value })}
                    placeholder="model id"
                    spellCheck={false}
                  />
                </label>
                <label className="models-field">
                  <span>api key</span>
                  <input
                    type="password"
                    value={credentialDrafts[p.id] ?? ""}
                    onChange={(e) => setCredentialDrafts((current) => ({
                      ...current,
                      [p.id]: e.target.value,
                    }))}
                    onBlur={() => void commitCredential(p.id)}
                    placeholder={
                      p.credentialConfigured
                        ? "stored securely — type to replace"
                        : isLocal ? "(not required)" : "sk-…"
                    }
                    spellCheck={false}
                    autoComplete="off"
                  />
                </label>
              </div>
              <details className="models-advanced">
                <summary>
                  <span>generation options</span>
                  <span className="models-advanced-hint">provider defaults unless set</span>
                </summary>
                <div className="models-fields models-advanced-fields">
                  <label
                    className="models-field"
                    title="Zine adds a system style instruction; personality is not a portable provider API field."
                  >
                    <span>personality</span>
                    <select
                      value={p.personality ?? ""}
                      onChange={(e) => updateField(p.id, {
                        personality: (e.target.value || undefined) as ModelPersonality | undefined,
                      })}
                    >
                      <option value="">model default</option>
                      <option value="none">none</option>
                      <option value="friendly">friendly</option>
                      <option value="pragmatic">pragmatic</option>
                    </select>
                  </label>
                  <label className="models-field" title="Only sent when set and supported by the selected model.">
                    <span>reasoning effort</span>
                    <select
                      value={selectedEffort}
                      onChange={(e) => updateField(p.id, {
                        reasoningEffort: (e.target.value || undefined) as ReasoningEffort | undefined,
                      })}
                    >
                      <option value="">provider default</option>
                      {efforts.map((effort) => (
                        <option key={effort} value={effort}>{effort}</option>
                      ))}
                    </select>
                  </label>
                  {p.protocol === "openai" && (
                    <label className="models-field" title="OpenAI-compatible output detail control; omitted by default.">
                      <span>verbosity</span>
                      <select
                        value={p.verbosity ?? ""}
                        onChange={(e) => updateField(p.id, {
                          verbosity: (e.target.value || undefined) as ModelVerbosity | undefined,
                        })}
                      >
                        <option value="">provider default</option>
                        <option value="low">low</option>
                        <option value="medium">medium</option>
                        <option value="high">high</option>
                      </select>
                    </label>
                  )}
                  <label className="models-field">
                    <span>temperature</span>
                    <input
                      type="number"
                      min={0}
                      max={temperatureMax}
                      step={0.1}
                      value={p.temperature ?? ""}
                      onChange={(e) => updateField(p.id, {
                        temperature: Number.isFinite(e.currentTarget.valueAsNumber)
                          ? e.currentTarget.valueAsNumber
                          : undefined,
                      })}
                      placeholder="provider default"
                    />
                  </label>
                  <label className="models-field">
                    <span>max output tokens</span>
                    <input
                      type="number"
                      min={1}
                      step={1}
                      value={p.maxTokens ?? ""}
                      onChange={(e) => updateField(p.id, {
                        maxTokens: Number.isFinite(e.currentTarget.valueAsNumber)
                          ? Math.max(1, Math.floor(e.currentTarget.valueAsNumber))
                          : undefined,
                      })}
                      placeholder="operation default"
                    />
                  </label>
                  <label
                    className="models-field models-field-wide"
                    title="Prepended for both ordinary ops and agent runs. Use this for model-specific compatibility guidance; operation personas belong in editorial lenses."
                  >
                    <span>model-specific instructions</span>
                    <textarea
                      value={p.instructions ?? ""}
                      onChange={(e) => updateField(p.id, { instructions: e.target.value || undefined })}
                      placeholder="optional compatibility guidance for this model…"
                      rows={3}
                      spellCheck={true}
                    />
                  </label>
                </div>
              </details>
              <div className="models-card-footer">
                <button
                  type="button"
                  className={"run-agent-btn models-test" + (t.state === "testing" ? " running" : "")}
                  onClick={() => runTest(p)}
                  disabled={t.state === "testing"}
                >
                  {t.state === "testing" ? "testing…" : "test"}
                </button>
                {t.state !== "idle" && t.state !== "testing" && (
                  <p className={"sampler-status" + (t.state === "error" ? " error" : "")}>
                    {t.state === "ok" ? `ok · ${t.msg}` : t.msg}
                  </p>
                )}
              </div>
            </div>
          );
        })}
        {providers.length === 0 && (
          <p className="models-empty">No providers yet — add one below.</p>
        )}
      </div>

      <div className="models-add-wrap" ref={addRef}>
        <button
          type="button"
          className="settings-add-btn models-add"
          onClick={() => setAddOpen((v) => !v)}
          aria-haspopup="menu"
          aria-expanded={addOpen}
        >
          <Plus size={14} strokeWidth={1.75} aria-hidden="true" />
          <span>Add model</span>
          <ChevronDown size={12} strokeWidth={1.75} aria-hidden="true" />
        </button>
        {addOpen && (
          <div className="models-add-menu" role="menu">
            {presets.map((preset) => (
              <button
                key={preset.slug}
                type="button"
                className="models-add-item"
                role="menuitem"
                onClick={() => {
                  commit(addProviderFromPreset(preset));
                  setAddOpen(false);
                }}
              >
                <span className="models-add-item-label">{preset.label}</span>
                <span className="models-add-item-meta">{preset.modelId}</span>
              </button>
            ))}
            {presets.length > 0 && <div className="models-add-sep" />}
            <button
              type="button"
              className="models-add-item"
              role="menuitem"
              onClick={() => {
                commit(addProvider("Custom"));
                setAddOpen(false);
              }}
            >
              <span className="models-add-item-label">Custom…</span>
              <span className="models-add-item-meta">blank</span>
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

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
  type ProviderConfig,
  type ProviderProtocol,
} from "./models-store.js";
import { complete } from "./llm.js";

type TestState = Record<string, { state: "idle" | "testing" | "ok" | "error"; msg?: string }>;

export function ModelsView({
  onProvidersChange,
}: {
  /** Called whenever the provider list changes (add/remove/patch) so App can
   *  refresh the Press model dropdown with the same card labels. */
  onProvidersChange?: (providers: ProviderConfig[]) => void;
}) {
  const [providers, setProviders] = useState<ProviderConfig[]>(() => loadProviders());
  const [test, setTest] = useState<TestState>({});
  const [addOpen, setAddOpen] = useState(false);
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
    // push to App so the topbar model select shows the card label live.
    const next = patchProvider(id, patch);
    setProviders(next);
    onProvidersChange?.(next);
  }

  async function runTest(cfg: ProviderConfig) {
    if (!cfg.baseUrl || !cfg.modelId) {
      setTest((t) => ({ ...t, [cfg.id]: { state: "error", msg: "set base URL + model first" } }));
      return;
    }
    setTest((t) => ({ ...t, [cfg.id]: { state: "testing" } }));
    try {
      const reply = await complete(
        cfg,
        [{ role: "user", content: "Reply with the single word: ok" }],
        { maxTokens: 8 },
      );
      setTest((t) => ({
        ...t,
        [cfg.id]: { state: "ok", msg: reply ? reply.slice(0, 60) : "(empty reply)" },
      }));
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

  return (
    <section className="view-placeholder models-view">
      <p className="view-placeholder-blurb">
        LLM providers for prompt injection — add from a preset or configure a
        custom endpoint.
      </p>

      <div className="models-list">
        {providers.map((p) => {
          const t = test[p.id] ?? { state: "idle" };
          const isLocal = p.baseUrl.startsWith("http://localhost") || p.baseUrl.startsWith("http://127.");
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
                    value={p.apiKey}
                    onChange={(e) => updateField(p.id, { apiKey: e.target.value })}
                    placeholder={isLocal ? "(not required)" : "sk-…"}
                    spellCheck={false}
                    autoComplete="off"
                  />
                </label>
              </div>
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

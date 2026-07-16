/**
 * §3.7 reconstruction panel: surfaces `reconstructLlmCall` in the Steps modal.
 * When the selected step is an `action: llm` node, this panel fetches the rule
 * manifest + every cited nucleus and rebuilds the { systemPrompt, userPrompt }
 * the producing press assembled at call time — so a reader can see exactly what
 * the model was handed, not just the typed instruction.
 *
 * Degrades visibly: unknown algorithm, unresolvable rule, or missing scope →
 * the panel shows the reason + whatever scope resolved, rather than hiding the
 * failure. A non-LLM step renders nothing.
 */

import { useEffect, useState } from "react";
import type { Event } from "nostr-tools";
import { reconstructLlmCall, type ReconstructedCall } from "./provenance.js";

export function LlmReconstructPanel({ event }: { event: Event }) {
  const [result, setResult] = useState<ReconstructedCall | null>(null);
  const [loading, setLoading] = useState(false);

  const isLlm = event.tags.some((t) => t[0] === "action" && t[1] === "llm");

  useEffect(() => {
    if (!isLlm) {
      setResult(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    reconstructLlmCall(event)
      .then((r) => {
        if (!cancelled) setResult(r);
      })
      .catch(() => {
        if (!cancelled) setResult(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [event, isLlm]);

  if (!isLlm) return null;
  if (loading) return <div className="llm-recon llm-recon-loading">Reconstructing LLM call…</div>;
  if (!result) return <div className="llm-recon llm-recon-error">Couldn’t reconstruct this LLM call.</div>;

  return (
    <div className="llm-recon" role="group" aria-label="LLM call reconstruction">
      <div className="llm-recon-header">
        <span className="llm-recon-title">LLM call</span>
        {result.llm && (
          <span className="llm-recon-model">
            {result.llm.provider} / {result.llm.model} · temp{" "}
            {result.llm.temperature === null ? "default" : result.llm.temperature} · {result.llm.maxTokens} tok
          </span>
        )}
      </div>
      {result.reconstructable ? (
        <>
          {result.systemPrompt && (
            <section className="llm-recon-section">
              <span className="llm-recon-label">System prompt</span>
              <pre className="llm-recon-pre">{result.systemPrompt}</pre>
            </section>
          )}
          {result.userPrompt && (
            <section className="llm-recon-section">
              <span className="llm-recon-label">User prompt</span>
              <pre className="llm-recon-pre">{result.userPrompt}</pre>
            </section>
          )}
        </>
      ) : (
        <div className="llm-recon-degraded">
          Prompt not rebuildable: {result.reason ?? "unknown reason"}.
          {result.manifest && (
            <span className="llm-recon-manifest"> Algorithm: {result.manifest.algorithm}.</span>
          )}
        </div>
      )}
      <section className="llm-recon-section">
        <span className="llm-recon-label">Scope ({result.scope.length})</span>
        <ul className="llm-recon-scope">
          {result.scope.length === 0 ? <li className="muted">nothing cited</li> : null}
          {result.scope.map((s) => (
            <li key={s.nodeId} title={s.nodeId}>
              {s.relativePath ?? s.nodeId.slice(0, 12)}
              {s.action ? <span className="llm-recon-scope-action"> · {s.action}</span> : null}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

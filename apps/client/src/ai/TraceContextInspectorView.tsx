import {
  TRACE_CONTEXT_INSPECTOR_CLASSIFICATION_LABELS,
  TRACE_CONTEXT_INSPECTOR_EVIDENCE_KIND_LABELS,
  TRACE_CONTEXT_INSPECTOR_INERT_REASON_LABELS,
  TRACE_CONTEXT_INSPECTOR_OPERATION_LABELS,
  TRACE_CONTEXT_INSPECTOR_POLICY_LABELS,
  formatTraceContextInspectorRange,
  groupTraceContextInspectorPresentationV1,
  type TraceContextInspectorCandidateIntentV1,
  type TraceContextInspectorClassificationV1,
  type TraceContextInspectorDirectiveIntentV1,
  type TraceContextInspectorEvidenceSourceV1,
  type TraceContextInspectorExcludeIntentV1,
  type TraceContextInspectorPresentationV1,
  type TraceContextInspectorRangeV1,
  type TraceContextInspectorSourceIntentV1,
} from "./trace-context-inspector-presentation.js";

export interface TraceContextInspectorViewProps {
  readonly presentation: TraceContextInspectorPresentationV1;
  readonly headingId?: string;
  readonly onExcludeForOperation?: (intent: TraceContextInspectorExcludeIntentV1) => void;
  readonly onPromoteDirective?: (intent: TraceContextInspectorCandidateIntentV1) => void;
  readonly onReactivateDirective?: (intent: TraceContextInspectorDirectiveIntentV1) => void;
  readonly onInspectSource?: (intent: TraceContextInspectorSourceIntentV1) => void;
}

function ClassificationBadge({
  classification,
}: {
  readonly classification: TraceContextInspectorClassificationV1;
}) {
  return (
    <span
      className={`trace-context-inspector-classification trace-context-inspector-classification-${classification}`}
      data-classification={classification}
    >
      {TRACE_CONTEXT_INSPECTOR_CLASSIFICATION_LABELS[classification]}
    </span>
  );
}

function RangeValue({ range }: { readonly range: TraceContextInspectorRangeV1 }) {
  return <code className="trace-context-inspector-range">{formatTraceContextInspectorRange(range)}</code>;
}

function EmptyState({ children }: { readonly children: string }) {
  return <p className="trace-context-inspector-empty">{children}</p>;
}

function InspectSourceButton({
  intent,
  onInspectSource,
}: {
  readonly intent: TraceContextInspectorSourceIntentV1;
  readonly onInspectSource?: (intent: TraceContextInspectorSourceIntentV1) => void;
}) {
  if (!onInspectSource) return null;
  return (
    <button
      type="button"
      className="trace-context-inspector-action trace-context-inspector-inspect-source"
      onClick={() => onInspectSource(intent)}
    >
      Inspect source
    </button>
  );
}

function EvidenceSource({ source }: { readonly source: TraceContextInspectorEvidenceSourceV1 }) {
  return (
    <dl className="trace-context-inspector-source">
      <div>
        <dt>Source</dt>
        <dd>{source.displayLabel}</dd>
      </div>
      {source.traceId ? (
        <div>
          <dt>Trace</dt>
          <dd><code>{source.traceId}</code></dd>
        </div>
      ) : null}
      {source.headId ? (
        <div>
          <dt>Head</dt>
          <dd><code>{source.headId}</code></dd>
        </div>
      ) : null}
      {source.nodeId ? (
        <div>
          <dt>Step</dt>
          <dd><code>{source.nodeId}</code></dd>
        </div>
      ) : null}
      {source.transactionId ? (
        <div>
          <dt>Transaction</dt>
          <dd><code>{source.transactionId}</code></dd>
        </div>
      ) : null}
      {source.sourceRange ? (
        <div>
          <dt>Range</dt>
          <dd><RangeValue range={source.sourceRange} /></dd>
        </div>
      ) : null}
    </dl>
  );
}

/**
 * Pure trace-context presentation. It does not prepare requests, resolve
 * payloads, mutate authoring state, dispatch providers, or persist UI actions.
 * Optional callbacks are intents for the future integration adapter.
 */
export function TraceContextInspectorView({
  presentation,
  headingId = "trace-context-inspector-title",
  onExcludeForOperation,
  onPromoteDirective,
  onReactivateDirective,
  onInspectSource,
}: TraceContextInspectorViewProps) {
  const groups = groupTraceContextInspectorPresentationV1(presentation);
  const { targetRevision, metadata } = presentation;
  const budgetMax = Math.max(1, metadata.budget.effectiveContextBytes);
  const budgetValue = Math.min(metadata.budget.usedContextBytes, budgetMax);

  return (
    <article className="trace-context-inspector-view" aria-labelledby={headingId}>
      <header className="trace-context-inspector-header">
        <div>
          <p className="trace-context-inspector-eyebrow">Prepared AI context</p>
          <h2 id={headingId}>Trace context inspector</h2>
        </div>
        <p className="trace-context-inspector-summary">
          Review what is instruction-authoritative, what remains quoted data, and which trace
          evidence this exact operation selected.
        </p>
      </header>

      <section className="trace-context-inspector-section trace-context-inspector-prepared" aria-labelledby={`${headingId}-prepared`}>
        <h3 id={`${headingId}-prepared`}>Prepared operation</h3>
        <dl className="trace-context-inspector-metadata">
          <div>
            <dt>Policy</dt>
            <dd>{TRACE_CONTEXT_INSPECTOR_POLICY_LABELS[presentation.policy]} <code>{presentation.policy}</code></dd>
          </div>
          <div>
            <dt>Operation</dt>
            <dd>{TRACE_CONTEXT_INSPECTOR_OPERATION_LABELS[presentation.operation]} <code>{presentation.operation}</code></dd>
          </div>
          {targetRevision.displayPath ? (
            <div>
              <dt>Target</dt>
              <dd>{targetRevision.displayPath}</dd>
            </div>
          ) : null}
          <div>
            <dt>Trace</dt>
            <dd><code>{targetRevision.traceId}</code></dd>
          </div>
          <div>
            <dt>Exact prepared head</dt>
            <dd><code>{targetRevision.headId}</code></dd>
          </div>
          <div>
            <dt>Content hash</dt>
            <dd><code>{targetRevision.contentHash}</code></dd>
          </div>
          <div>
            <dt>Operation range</dt>
            <dd><RangeValue range={targetRevision.operationRange} /></dd>
          </div>
        </dl>
      </section>

      <section className="trace-context-inspector-section trace-context-inspector-classifications" aria-labelledby={`${headingId}-classifications`}>
        <h3 id={`${headingId}-classifications`}>Instruction boundary</h3>
        <div className="trace-context-inspector-legend">
          <p>
            <ClassificationBadge classification="instruction" />
            May guide only this approved operation; it cannot grant tools or broader access.
          </p>
          <p>
            <ClassificationBadge classification="quoted-data" />
            Evidence or document text for interpretation, never an instruction by resemblance.
          </p>
        </div>
      </section>

      <section className="trace-context-inspector-section trace-context-inspector-directives" aria-labelledby={`${headingId}-directives`}>
        <h3 id={`${headingId}-directives`}>Authorized directives</h3>
        {groups.directives.length === 0 ? (
          <EmptyState>No authorized directives are available for this operation.</EmptyState>
        ) : (
          <ol className="trace-context-inspector-list trace-context-inspector-directive-list">
            {groups.directives.map((directive) => (
              <li key={directive.id} className="trace-context-inspector-card trace-context-inspector-directive">
                <header className="trace-context-inspector-card-header">
                  <span className="trace-context-inspector-marker"><code>{directive.marker}</code></span>
                  <ClassificationBadge classification={directive.classification} />
                  <span
                    className={`trace-context-inspector-state trace-context-inspector-state-${directive.state ?? "unsupplied"}`}
                  >
                    {directive.state === "pending"
                      ? "Pending"
                      : directive.state === "consumed"
                        ? "Consumed"
                        : "Lifecycle not supplied"}
                  </span>
                </header>
                <dl className="trace-context-inspector-card-metadata">
                  <div>
                    <dt>Source range</dt>
                    <dd><RangeValue range={directive.sourceRange} /></dd>
                  </div>
                  {directive.instructionRange ? (
                    <div>
                      <dt>Instruction range</dt>
                      <dd><RangeValue range={directive.instructionRange} /></dd>
                    </div>
                  ) : null}
                </dl>
                <div className="trace-context-inspector-instruction">
                  <h4>Exact instruction</h4>
                  <pre>{directive.displayInstruction || "(empty instruction)"}</pre>
                </div>
                <div className="trace-context-inspector-excerpt">
                  <h4>Bounded local excerpt</h4>
                  <p className="trace-context-inspector-excerpt-meta">
                    {directive.localExcerpt.relation} · <RangeValue range={directive.localExcerpt.sourceRange} /> · {directive.localExcerpt.byteLength.toLocaleString()} bytes
                  </p>
                  <blockquote>
                    {directive.localExcerpt.omittedBefore ? <span aria-label="Earlier text omitted">… </span> : null}
                    {directive.localExcerpt.displayText || "(empty excerpt)"}
                    {directive.localExcerpt.omittedAfter ? <span aria-label="Later text omitted"> …</span> : null}
                  </blockquote>
                  <p className="trace-context-inspector-excerpt-classification">
                    <ClassificationBadge classification="quoted-data" /> Local excerpts locate a directive; they do not inherit instruction authority.
                  </p>
                </div>
                {directive.consumptionReceiptLabel || directive.cleanupStatusLabel ? (
                  <dl className="trace-context-inspector-receipt">
                    {directive.consumptionReceiptLabel ? (
                      <div>
                        <dt>Consumption receipt</dt>
                        <dd>{directive.consumptionReceiptLabel}</dd>
                      </div>
                    ) : null}
                    {directive.cleanupStatusLabel ? (
                      <div>
                        <dt>Cleanup</dt>
                        <dd>{directive.cleanupStatusLabel}</dd>
                      </div>
                    ) : null}
                  </dl>
                ) : null}
                <div className="trace-context-inspector-actions">
                  {directive.canExclude && onExcludeForOperation ? (
                    <button
                      type="button"
                      className="trace-context-inspector-action trace-context-inspector-exclude"
                      onClick={() => onExcludeForOperation({ kind: "directive", id: directive.id })}
                    >
                      Exclude for this operation
                    </button>
                  ) : null}
                  {directive.state === "consumed" && directive.canReactivate && onReactivateDirective ? (
                    <button
                      type="button"
                      className="trace-context-inspector-action trace-context-inspector-reactivate"
                      onClick={() => onReactivateDirective({ directiveId: directive.id })}
                    >
                      Reactivate as a new directive
                    </button>
                  ) : null}
                  <InspectSourceButton
                    onInspectSource={onInspectSource}
                    intent={{ kind: "directive", id: directive.id, sourceRange: directive.sourceRange }}
                  />
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className="trace-context-inspector-section trace-context-inspector-protected" aria-labelledby={`${headingId}-protected`}>
        <h3 id={`${headingId}-protected`}>Protected ranges</h3>
        {groups.protectedRanges.length === 0 ? (
          <EmptyState>No compiled protected ranges are available for this operation.</EmptyState>
        ) : (
          <ul className="trace-context-inspector-list trace-context-inspector-protected-list">
            {groups.protectedRanges.map((protectedRange) => (
              <li key={protectedRange.id} className="trace-context-inspector-card trace-context-inspector-protected-range">
                <header className="trace-context-inspector-card-header">
                  <RangeValue range={protectedRange.sourceRange} />
                  <ClassificationBadge classification={protectedRange.classification} />
                </header>
                <pre>{protectedRange.displayText || "(empty protected range)"}</pre>
                <div className="trace-context-inspector-actions">
                  <InspectSourceButton
                    onInspectSource={onInspectSource}
                    intent={{ kind: "protected-range", id: protectedRange.id, sourceRange: protectedRange.sourceRange }}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="trace-context-inspector-section trace-context-inspector-inert" aria-labelledby={`${headingId}-inert`}>
        <h3 id={`${headingId}-inert`}>Inert directive candidates</h3>
        {groups.inertDirectives.length === 0 ? (
          <EmptyState>No compiled inert directive candidates are available.</EmptyState>
        ) : (
          <ol className="trace-context-inspector-list trace-context-inspector-inert-list">
            {groups.inertDirectives.map((candidate) => (
              <li key={candidate.id} className="trace-context-inspector-card trace-context-inspector-inert-directive">
                <header className="trace-context-inspector-card-header">
                  <RangeValue range={candidate.sourceRange} />
                  <ClassificationBadge classification={candidate.classification} />
                </header>
                <pre>{candidate.displayCandidate || "(empty candidate)"}</pre>
                <p className="trace-context-inspector-reason" data-reason={candidate.reason}>
                  {TRACE_CONTEXT_INSPECTOR_INERT_REASON_LABELS[candidate.reason]}
                </p>
                <div className="trace-context-inspector-actions">
                  {candidate.canPromote && onPromoteDirective ? (
                    <button
                      type="button"
                      className="trace-context-inspector-action trace-context-inspector-promote"
                      onClick={() => onPromoteDirective({ candidateId: candidate.id })}
                    >
                      Promote for this revision
                    </button>
                  ) : null}
                  <InspectSourceButton
                    onInspectSource={onInspectSource}
                    intent={{ kind: "inert-directive", id: candidate.id, sourceRange: candidate.sourceRange }}
                  />
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className="trace-context-inspector-section trace-context-inspector-errors" aria-labelledby={`${headingId}-errors`}>
        <h3 id={`${headingId}-errors`}>Compilation errors</h3>
        {groups.compilationErrors.length === 0 ? (
          <EmptyState>No authoring-syntax compilation errors are available for this operation.</EmptyState>
        ) : (
          <ul className="trace-context-inspector-list trace-context-inspector-error-list">
            {groups.compilationErrors.map((error) => (
              <li key={error.id} className="trace-context-inspector-card trace-context-inspector-error">
                <p><code>{error.code}</code> · {error.displayMessage}</p>
                <dl className="trace-context-inspector-card-metadata">
                  <div>
                    <dt>Range</dt>
                    <dd><RangeValue range={error.sourceRange} /></dd>
                  </div>
                  {error.relatedRange ? (
                    <div>
                      <dt>Related range</dt>
                      <dd><RangeValue range={error.relatedRange} /></dd>
                    </div>
                  ) : null}
                </dl>
                <div className="trace-context-inspector-actions">
                  <InspectSourceButton
                    onInspectSource={onInspectSource}
                    intent={{ kind: "compilation-error", id: error.id, sourceRange: error.sourceRange }}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="trace-context-inspector-section trace-context-inspector-evidence" aria-labelledby={`${headingId}-evidence`}>
        <h3 id={`${headingId}-evidence`}>Selected context evidence</h3>
        {groups.selectedEvidence.length === 0 ? (
          <EmptyState>No trace evidence was selected for this operation.</EmptyState>
        ) : (
          <ol className="trace-context-inspector-list trace-context-inspector-evidence-list">
            {groups.selectedEvidence.map((evidence) => (
              <li key={evidence.id} className="trace-context-inspector-card trace-context-inspector-evidence-item">
                <header className="trace-context-inspector-card-header">
                  <span className="trace-context-inspector-evidence-kind">
                    {TRACE_CONTEXT_INSPECTOR_EVIDENCE_KIND_LABELS[evidence.kind]}
                  </span>
                  <ClassificationBadge classification={evidence.classification} />
                  <span className="trace-context-inspector-byte-cost">
                    {evidence.byteCost.toLocaleString()} {evidence.byteCostLabel}
                  </span>
                </header>
                <p className="trace-context-inspector-claim">{evidence.displayClaim}</p>
                <EvidenceSource source={evidence.source} />
                <dl className="trace-context-inspector-card-metadata">
                  {evidence.scope ? (
                    <div>
                      <dt>Scope</dt>
                      <dd>{evidence.scope}</dd>
                    </div>
                  ) : null}
                  <div>
                    <dt>Sensitivity</dt>
                    <dd>{evidence.sensitivity}</dd>
                  </div>
                  <div>
                    <dt>Selected because</dt>
                    <dd>{evidence.selectionReasons.length > 0 ? evidence.selectionReasons.join(" · ") : "No reason supplied"}</dd>
                  </div>
                </dl>
                <div className="trace-context-inspector-actions">
                  {evidence.canExclude && onExcludeForOperation ? (
                    <button
                      type="button"
                      className="trace-context-inspector-action trace-context-inspector-exclude"
                      onClick={() => onExcludeForOperation({ kind: "evidence", id: evidence.id })}
                    >
                      Exclude for this operation
                    </button>
                  ) : null}
                  <InspectSourceButton
                    onInspectSource={onInspectSource}
                    intent={{ kind: "evidence", id: evidence.id, source: evidence.source }}
                  />
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className="trace-context-inspector-section trace-context-inspector-exclusions" aria-labelledby={`${headingId}-exclusions`}>
        <h3 id={`${headingId}-exclusions`}>Excluded context summary</h3>
        {groups.excludedEvidence.length === 0 ? (
          <EmptyState>No context candidates were excluded.</EmptyState>
        ) : (
          <ul className="trace-context-inspector-list trace-context-inspector-exclusion-list">
            {groups.excludedEvidence.map((summary) => (
              <li key={`${summary.reason}-${summary.displayLabel}`} className="trace-context-inspector-exclusion" data-reason={summary.reason}>
                <span>{summary.displayLabel}</span>
                <strong>{summary.count.toLocaleString()}</strong>
                {summary.firstRejectedSource ? (
                  <>
                    <span className="trace-context-inspector-first-rejected">First: {summary.firstRejectedSource.displayLabel}</span>
                    <InspectSourceButton
                      onInspectSource={onInspectSource}
                      intent={{
                        kind: "excluded-evidence",
                        id: `${summary.reason}-first`,
                        source: summary.firstRejectedSource,
                      }}
                    />
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="trace-context-inspector-section trace-context-inspector-status" aria-labelledby={`${headingId}-status`}>
        <h3 id={`${headingId}-status`}>Preparation status</h3>
        <p
          className={`trace-context-inspector-completeness ${metadata.completeness.complete ? "complete" : "incomplete"}`}
          role="status"
        >
          {metadata.completeness.complete ? "Context gathering complete" : "Context gathering incomplete"}
        </p>
        {metadata.completeness.failures.length > 0 ? (
          <ul className="trace-context-inspector-completeness-failures">
            {metadata.completeness.failures.map((failure) => (
              <li key={`${failure.code}-${failure.displayLabel}`}><code>{failure.code}</code> · {failure.displayLabel}</li>
            ))}
          </ul>
        ) : null}
        <div className="trace-context-inspector-budget">
          <label htmlFor={`${headingId}-budget`}>Context budget</label>
          <progress id={`${headingId}-budget`} max={budgetMax} value={budgetValue} />
          <span>
            {metadata.budget.usedContextBytes.toLocaleString()} / {metadata.budget.effectiveContextBytes.toLocaleString()} bytes
            {metadata.budget.truncated ? " · truncated" : " · not truncated"}
          </span>
          <span>
            {metadata.budget.selectedCount.toLocaleString()} selected from {metadata.budget.candidateCount.toLocaleString()} candidates
          </span>
        </div>
        <dl className="trace-context-inspector-metadata trace-context-inspector-version-metadata">
          <div>
            <dt>Compiler</dt>
            <dd><code>{metadata.versions.compiler}</code></dd>
          </div>
          <div>
            <dt>Selector</dt>
            <dd><code>{metadata.versions.selector}</code></dd>
          </div>
          <div>
            <dt>Renderer</dt>
            <dd><code>{metadata.versions.renderer}</code></dd>
          </div>
          <div>
            <dt>Prompt layers</dt>
            <dd>{metadata.versions.promptLayers.length > 0 ? metadata.versions.promptLayers.join(" · ") : "None"}</dd>
          </div>
          <div>
            <dt>Frozen-input fingerprint</dt>
            <dd><code>{metadata.fingerprint}</code></dd>
          </div>
          {metadata.selectionIdentities ? (
            <>
              <div>
                <dt>Rendered-context identity</dt>
                <dd><code>{metadata.selectionIdentities.renderedContextSha256}</code></dd>
              </div>
              <div>
                <dt>Package manifest identity</dt>
                <dd><code>{metadata.selectionIdentities.manifestSha256}</code></dd>
              </div>
            </>
          ) : null}
        </dl>
      </section>
    </article>
  );
}

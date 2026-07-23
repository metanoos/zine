# Trace-aware writing outcomes — preregistration

**Stable path:** `research/trace-writing-preregistration.md`

**Protocol version:** `trace-writing-outcomes-v1`

**Status:** draft, not yet enrolled

**Companion scoring manual:**
[`trace-writing-rubric.md`](trace-writing-rubric.md)

This document fixes the confirmatory design for testing Zine's trace-aware
writing thesis before outcome telemetry or participant enrollment begins. A
dated amendment and a new protocol version are required to change a locked
field after this version is frozen. The enrollment timestamp, repository
commit, frozen fixture hashes, model versions, power calculation, and analysis
code hash must be appended to the registration record before the first
assignment is generated.

## Evidence boundary at registration

Zine currently has narrow evidence about **narration fidelity**, not writing
quality. In one hand-scored study using one model (`glm-5.2`), five draws per
condition, and two source traces, structured process evidence reduced a
specific failure when a model described how a document had been made. The
strongest cell was labels-plus-spans versus a bare action log: 5/5 versus 0/5
bound narrations. Scoring was not blind, no writer outcome was measured, and
the middle contrasts were not statistically separable at that sample size.
See [`narration-rubric.md`](narration-rubric.md) and
[`results.md`](results.md).

That study supports the claim that structured trace evidence can improve the
fidelity of machine narration for the tested failure class. It does **not**
show that trace-aware assistance produces better prose, reduces writer effort,
preserves intent, generalizes across models, creates durable memory value, or
causes product demand. Every one of those remains unproven at registration.

## Research questions and locked hypotheses

The core study asks whether assistance grounded in selected, structured trace
evidence helps writers reach acceptable results more effectively than
assistance grounded in the current text alone, and whether selection adds
value beyond a bounded chronological history.

Confirmatory contrasts are ordered:

1. **Selected trace versus text only.** This is the primary product-thesis
   contrast.
2. **Selected trace versus bounded chronological trace.** This isolates the
   value of task-specific compilation from the value of history generally.
3. **Bounded chronological trace versus text only.** This estimates whether a
   bounded history helps before selection.

The primary hypotheses are:

- **H1, author choice:** in blinded frozen-task comparisons, selected-trace
  output is preferred to text-only output more often than the reverse.
- **H2, work to acceptance:** in live use, selected trace reduces normalized
  edit burden relative to text only.
- **H3, selector contribution:** selected trace improves at least one of H1 or
  H2 relative to bounded chronological trace without crossing a harm gate.

H1 and H2 are co-primary. A broad writing-assistance claim requires the
promotion rules below; a positive H3 alone supports only a selector-specific
claim. All other outcomes are secondary or guardrails unless explicitly named
otherwise.

## Study structure

The core protocol has two complementary components. Results are reported both
separately and together; one component is never substituted for the other.

### A. Blinded frozen-task comparison

For an eligible operation opportunity, an immutable copy of the prepared
target, exact instruction, declared constraints, context inputs, provider
configuration, and provider seed when supported is frozen before generation.
The runtime generates one output under each of the three conditions. Generation
order is counterbalanced independently of presentation order. The writer sees
the outputs as `Option 1`, `Option 2`, and `Option 3`, with formatting
normalized and presentation order counterbalanced. Condition names, context
explanations, latency, and cost remain hidden until the writer records a
ranking, an optional tie, and a short reason.

These outputs are research artifacts. Unless the writer explicitly selects an
output for ordinary result review, none changes the live document. Choosing to
apply one does not alter the already-recorded blind ranking.

This component estimates blind author preference. It incurs three provider
calls and therefore requires specific consent immediately before assignment.

### B. Randomized live-operation comparison

Each eligible live operation is assigned to exactly one condition. The writer
receives one result through the ordinary review and acceptance flow. The same
live target opportunity is never exposed to another condition, and no shadow
request is sent. This component estimates edit burden, time to acceptable
result, acceptance, partial use, later reversion, recurrence, control, latency,
tokens, and cost under realistic use.

The assignment is concealed until the operation is complete or abandoned. The
Prompt Inspector still shows the exact evidence required for informed approval;
it uses neutral labels such as “included context” rather than the research
condition name. Concealment never hides content, provider, cost, privacy, or
capability information from the writer.

## Experimental conditions

All conditions are emitted by the same frozen manifest runtime, provider
adapter, operation prompt, and result-review path. They use the same exact
target revision, explicit current instruction, operation range, protected
spans, deliberately cited source bodies, model configuration, sampling
parameters, tool policy, reserved prompt bytes, and hard context-byte ceiling.
The ceiling is equal; conditions are not padded to equal actual length. Exact
rendered UTF-8 bytes, provider-reported tokens, and cost are recorded so any
resource difference remains visible.

### T — text only

Includes only:

- the exact current target text or operation range;
- the exact current operation instruction, including authorized current-target
  directives;
- exact protected spans; and
- source bodies explicitly cited for the current operation.

It excludes every trace-derived field: delta logs, timestamps from history,
Step or transaction summaries, inserted/deleted historical payloads, origin or
voice labels, prior prompts or results, selector reasons, corrections,
preferences, memory, and inclusion metadata.

### B — bounded chronological trace

Includes everything in T plus the newest complete conforming suffix of the
validated target process log that fits the same hard ceiling. Selection starts
at the prepared head and walks backward by complete Step; rendering is then
oldest to newest. It may not split a Step to win budget. The manifest records
included bounds and counts plus the commitment to the omitted prefix.

No task-specific relevance selection or durable memory is allowed. This
condition distinguishes “history helps” from “the compiler helps.”

### S — selected trace, memory disabled

Includes everything in T plus deterministic Selector V1 evidence under the
same ceiling. Candidate generation and selection must be mechanical and
versioned; an unfrozen model may not select its own context. The manifest
records every included item, reason, source, byte cost, and compact exclusion
summary.

Durable file, folder, and user memory are disabled in the core study. Current
operation instructions, protected spans, operation-only exclusions, and
explicit citations are not memory and remain active in every condition. This
restriction prevents the core trace contrast from becoming a memory contrast.

## Eligibility

### Writers and artifacts

A participant must:

- be at least 18 and capable of consenting;
- be the owner or authorized editor of the studied material;
- opt into the named study and its retention policy;
- use a root where the studied files may lawfully be processed by the chosen
  provider; and
- complete the pre-study privacy and provider disclosure.

Eligible artifacts are durable prose whose quality the writer can judge:
reports, essays, research notes, policies, editorial work, correspondence, and
comparable documents. Synthetic tasks may be used for instrument validation
but are not pooled with real-writing confirmatory results.

Exclude source code, generated test fixtures, secrets, credentials, medical or
legal records without separately approved governance, documents containing
third-party material the participant may not submit to the provider, and tasks
whose sole goal is exact mechanical transformation. A participant may mark any
file or operation ineligible without explanation.

### Operations

Confirmatory operations are:

- **Append:** continue a target from its current head (internal operation id `extend`); and
- **Settle:** revise a declared range toward an explicit instruction.

Each must use a closed, frozen operation descriptor and pass the same
preparation, approval, and acceptance lifecycle. Stir, Reply, Analyze, Run,
and future operations may be reported as exploratory cohorts only until a
dated amendment fixes their eligible ranges, result shapes, outcomes, and
consumption semantics. They are never silently pooled with Append or Settle.

An operation is eligible only when the target and all mandatory context fit the
hard ceiling, the trace reader reaches a valid declared condition, the exact
model version is available, and the user has not already seen another
condition for that target opportunity.

### Models

The confirmatory sample includes at least two capable model families from
different providers or independently trained lineages. Before enrollment, the
registration record freezes provider, exact model identifier and dated
version, adapter version, sampling parameters, maximum output, tool policy,
system prompt layers, and retry policy. Silent provider aliases or rolling
versions are ineligible.

If a provider changes a model behind a frozen identifier, operations after the
change enter a new version cohort. A cross-model claim requires the result in
each preregistered family; pooling may not hide a null or harmful family.

## Assignment and counterbalancing

The randomization seed is generated and committed before enrollment. An
independent script produces assignments; application code consumes them but
does not choose a condition adaptively.

For the live study, randomization is blocked within writer by operation and
model family using permuted blocks of six containing two assignments to each
condition. Incomplete final blocks remain incomplete and are not rerandomized.
A writer's next assignment is not revealed before the operation is irreversibly
prepared. The primary analysis follows assigned condition even if preparation
or dispatch later fails.

For frozen tasks, the six possible generation orders and six possible
presentation orders are allocated as separate balanced Latin-style schedules
within writer, operation, and model family. The schedules are independent of
each other and of output content. A failure to generate one option makes the
comparison incomplete; the remaining options are not presented as a
confirmatory three-way task.

The same exact target opportunity appears once per study component. Prior
exposure to trace-context UI, experimental conditions, or outputs from the
other component is recorded. A frozen comparison must precede any live use of
its outputs; otherwise it is excluded from blind-preference analysis and
retained as a protocol deviation.

## Sample size and enrollment

Before enrollment, a simulation-based power calculation uses the locked mixed
models, a two-sided familywise alpha of 0.05, the minimally important effects
below, writer clustering, three conditions, and expected missingness. The
calculation may raise but never lower these floors:

- at least 30 evaluable live operations in every operation-by-model-family
  cell, allocated as evenly as possible across T, B, and S;
- at least 120 evaluable live operations total;
- at least 12 writers, with no writer contributing more than 20% of evaluable
  operations; and
- at least 30 complete frozen-task rankings in every
  operation-by-model-family cell.

An “evaluable” operation follows the definitions in the scoring manual. The
registration record must publish the simulation, assumptions, raised target,
and maximum enrollment before the first assignment.

## Outcomes

### Co-primary outcomes

1. **Blind author preference:** selected trace versus text only in complete
   frozen-task rankings. Ties remain ties; they are not broken after unblinding.
2. **Normalized edits to acceptance:** UTF-16 insertions plus deletions between
   the generated result and the accepted stepped form, divided by the
   generated result's UTF-16 length, for live operations reaching acceptance.

The scoring manual defines tracking across partial use, multiple spans, and
abandonment. Acceptance-conditioned edit burden is accompanied by an
assignment-level composite sensitivity analysis so a condition cannot appear
good merely because difficult outputs were rejected.

### Secondary writing outcomes

- time from result-ready to acceptable result;
- zero-edit acceptance, partial use, rejection, and abandonment;
- preservation of byte-protected text and predeclared semantic intent;
- recurrence of a direction previously marked rejected;
- removal or reversion of accepted AI text within three Steps or 24 hours;
- writer-rated usefulness and confidence in the result;
- irrelevant repetition, over-personalization, and sycophancy; and
- task completion at the next deliberate Step.

### Control, explanation, and resource outcomes

- writer-rated control over included context;
- ability to identify which evidence was used and why;
- correction actions and time spent inspecting/correcting context;
- preparation, provider, and end-to-end latency at p50 and p95;
- exact rendered bytes, provider input/output tokens, and provider cost; and
- provider failures, retries, cancellations, stale results, and condition
  validation failures.

Model-graded quality may be reported as an exploratory proxy only. It cannot
replace author preference, edit burden, blind human labels, or safety gates.

## Leakage and instrument validation

Before enrollment, fixed fixtures must prove:

1. T contains none of the excluded trace-derived fields, values, labels, source
   IDs, selector reasons, preferences, memory, or condition names.
2. B contains only the conforming newest suffix permitted by its byte budget,
   rendered chronologically, with no selected-only reason or memory field.
3. S contains only Selector V1 outputs and no durable memory in the core study.
4. All conditions share exact target, instruction, citation, protection,
   provider, model, sampling, output, tool, and prompt-layer configuration.
5. Condition assignment and display order do not enter model-visible messages.
6. Provider adapters do not append history, memory, or account-level context
   outside the frozen request.
7. UI labels, filenames, timing displays, and option formatting do not reveal
   condition before blind ranking.
8. Directives inside protected, pasted, MODEL, historical, or unauthorized
   spans remain quoted data in every condition.

The validator compares exact rendered request bytes against golden fixtures and
fails closed. A leakage failure before dispatch invalidates preparation. A
leakage failure discovered after dispatch pauses enrollment, quarantines the
affected cohort, and triggers the modification rules below.

## Consent, privacy, and retention

- Enrollment is opt-in. Ordinary product use never enrolls a writer or sends a
  shadow/frozen comparison request.
- Consent separately names live randomization, three-call frozen comparisons,
  provider disclosure, local outcome capture, optional redacted export, and
  retention period. Refusing one does not block ordinary Zine use.
- Exact text, trace payloads, prompts, outputs, preferences, corrections, and
  assignments remain local and encrypted by default. Application logs and
  analytics receive only redacted typed events; no prompt or document bytes.
- Research payloads default to deletion 30 days after their operation. The
  participant may choose immediate deletion after scoring or a shorter period.
  Extension or contribution of a redacted case requires a separate explicit
  action.
- Export is deny-by-default and previews every field. Aggregate export uses
  pseudonymous study IDs and excludes trace IDs, paths, keys, document bodies,
  exact prompts, and private manifest payloads.
- Withdrawal stops future assignment immediately and deletes all deletable
  private research payloads and unexported row-level outcomes. It cannot alter
  already published aggregates or material the participant deliberately sent.
- Provider retention and training policies are outside Zine's local guarantee
  and must be shown before consent. A study may use only provider settings
  approved in the registration record.
- Any serious confidentiality, authority, or cross-participant data exposure
  pauses enrollment immediately.

## Exclusions, deviations, and missingness

Pre-randomization ineligibility is excluded before assignment and tallied by
reason. After assignment, no observation is deleted for poor output, long
latency, large edits, participant dissatisfaction, or condition imbalance.

The following remain in the intention-to-treat ledger:

- provider timeout, refusal, malformed or empty result;
- preparation or leakage-validator failure;
- cancellation and outcome unknown;
- stale target or compare-and-set failure;
- result rejection, abandonment, or no deliberate Step; and
- protocol deviation discovered after assignment.

They receive typed outcome states rather than fabricated preference or edit
scores. The primary edit-burden estimand uses accepted results; a sensitivity
analysis assigns rejection/abandonment the preregistered worst score and treats
provider/preparation failure separately. Missing writer questionnaires are
never inferred from behavior. Withdrawal is reported as withdrawal and handled
according to consent, not coded as a loss.

No numeric outlier is removed. Duplicate event delivery is deduplicated by the
frozen operation/attempt identity. A retry remains linked to its initial
assignment and cannot draw a new condition.

## Analysis plan

All confirmatory analysis is intention-to-treat by assigned condition and uses
two-sided 95% confidence intervals. Writers are the clustering unit.

- Blind rankings are analyzed with a mixed-effects paired-comparison model
  containing condition contrast, operation, model family, and presentation
  order as fixed effects and writer and frozen task as random intercepts. The
  preregistered primary coefficient is S versus T. A writer-clustered exact
  sign test with ties reported separately is the sensitivity analysis.
- Normalized edit burden is analyzed with median mixed-effects quantile
  regression containing condition, operation, model family, trace-length band,
  generated length, and protocol version, with writer random intercepts.
  Writer-cluster bootstrap intervals are the robustness analysis.
- Time, tokens, cost, and correction burden use the same median estimand.
  Binary outcomes use mixed-effects logistic regression. Count outcomes use a
  negative-binomial model when overdispersion is present; otherwise Poisson.
- The S-versus-T co-primary family uses Holm correction across H1 and H2.
  H3 and the remaining pairwise contrasts are tested only after at least one
  co-primary endpoint passes, and use Holm correction within their family.
- Operation- and model-family-specific estimates are always shown. A pooled
  coefficient cannot establish an effect in a family whose estimate is null or
  harmful.
- Missingness is reported by condition and reason. Multiple imputation may be
  exploratory but never replaces the locked complete-case and worst-score
  sensitivity analyses.

Code reads the frozen outcome table without access to document bodies.
Unblinded qualitative review happens only after the confirmatory table and
figures have been generated and hashed.

## Benefit, noninferiority, and harm gates

The minimally important broad-product benefit is either:

- at least a 10-percentage-point S-over-T blind preference advantage; or
- at least a 15% relative reduction in median normalized edit burden.

For a broad claim, the adjusted 95% interval must exclude no improvement for at
least one co-primary endpoint, and that endpoint must meet its minimally
important threshold separately in both Append and Settle. The point estimate
for the other co-primary endpoint must not be negative in either operation.
Both model families must remain on the beneficial side of every material-harm
boundary. A cross-model claim additionally requires a positive family-specific
interval in each preregistered family rather than a favorable pooled estimate
alone.

The following noninferiority margins are locked for S versus T and S versus B:

- protected-intent failure: no more than 2 percentage points worse;
- recurrence of a rejected direction: no more than 5 points worse;
- later reversion: no more than 5 points worse;
- perceived control: lower confidence bound no worse than 0.5 on a 7-point
  scale;
- median context-inspection/correction time: no more than 60 seconds worse;
- median end-to-end latency: no more than 25% or 5 seconds worse, whichever
  permits the larger absolute difference; and
- median provider cost per accepted result: no more than 50% worse.

Passing requires the relevant one-sided 95% interval to remain within the
margin. An imprecise interval that crosses a margin is “gate not passed,” not
proof of harm. Any accepted mutation of a byte-protected span, unauthorized
instruction activation, undisclosed provider request, cross-participant
exposure, or repeated external tool effect is a serious incident with a margin
of zero and pauses the study.

## Stopping and modification rules

Enrollment stops only when the preregistered evaluable target and maximum
attempt target are reached. There is no early efficacy stop and no extension
based on a promising p-value. Aggregate outcomes are hidden from the product
team until the locked target is reached. Operational dashboards may show
enrollment, missingness, provider failures, resource use, and serious incidents
without condition-separated writing outcomes.

Enrollment pauses for a serious incident, systematic leakage, corrupted
assignment, model/version drift, or inability to reconstruct exact requests.
An independent safety review may stop the study for privacy or authority harm.
Provider outage alone pauses the affected model cell; it does not reassign
conditions.

Every change is a dated append-only amendment stating whether it was made
before enrollment, before unblinding, or after unblinding. A post-enrollment
change creates a new protocol-version cohort; original analyses remain
reported. Thresholds, outcomes, exclusions, or models may not be retroactively
redefined to improve a result.

## Evidence promotion rules

- The existing narration study remains described only as narration-fidelity
  evidence.
- A positive S-versus-T result in one operation and one family supports only a
  narrow operation/family claim.
- “Selected trace improves writing assistance” requires the broad benefit and
  harm gates above across both operations and both model families.
- B versus T supports or weakens “bounded history helps”; S versus B supports or
  weakens “task-specific compilation helps.” Neither is relabeled as the other.
- Preference alone does not establish lower effort; edit burden alone does not
  establish preferred or higher-quality prose.
- Null and harmful results are promoted to the evidence ledger under the same
  rules as positive results and must change selectors, budgets, supported
  operations, or rollout when indicated.
- Product demand, retention, willingness to pay, and reviewer value require
  separate evidence and are not inferred from this study.

## Separate longitudinal file-memory study

This study is not part of the core trace comparison and may not begin until
selected trace clears the core benefit gate for at least one operation with no
serious privacy or correction gap.

It compares:

- **S0:** selected trace with all durable memory disabled; and
- **S1:** the identical selected-trace compiler with explicit file-local memory
  enabled.

Compiler, selector, operation descriptor, model family and version, prompt,
context ceiling, and provider settings remain fixed. Folder and user memory are
forbidden. Only preferences explicitly created by the participant for the
studied file are eligible; no inferred or silently promoted memory enters S1.

Eligible files must have at least three later operation opportunities after a
memory record is created. Assignments are blocked within writer, file,
operation, and model family in balanced S0/S1 pairs. Because earlier outputs
can alter later trace, the estimand is the **incremental current-operation
effect** of exposing file memory in a real longitudinal trajectory, not a
carryover-free artifact effect. Assignment history and lagged S1 exposure are
reported; a first-exposure-only analysis is mandatory. The same live target
opportunity is never repeated.

Co-primary memory outcomes are recurrence of an explicitly rejected direction
and normalized edits to acceptance. Secondary outcomes are time, preference in
separately frozen comparisons, later reversion, repeated instruction burden,
over-personalization, irrelevant memory, sycophancy, correction/revocation
burden, control, latency, tokens, and cost. The scoring manual applies without
change.

The same simulation method, missingness rules, stopping rules, and harm gates
apply, with a floor of 30 evaluable operations in each
operation-by-model-family cell, balanced between S0 and S1, from at least 12
writers. S1 must reduce recurrence or median edit burden with an adjusted 95%
interval excluding no improvement, while not crossing any core harm margin.
Observational use, self-selected memory activation, or the core trace result
cannot unlock folder or user memory.

## Limitations fixed in advance

- Writers cannot be blind to whether an Inspector contains more context, even
  when condition names are concealed.
- Frozen-task blinding conceals assignment and presentation cues; an output may
  itself reveal that it used historical evidence, which is part of the
  treatment rather than a removable display leak.
- Live operation outcomes are affected by self-editing skill, task difficulty,
  provider stochasticity, and prior artifact history.
- Equal byte ceilings do not produce equal tokens, latency, cost, or useful
  information density.
- Frozen comparisons estimate preference among generated options, while live
  use estimates behavior with one option; neither alone captures the full
  product effect.
- Explicit acceptance and Steps may not coincide with an internal feeling that
  prose is “done.”
- Longitudinal memory has unavoidable artifact carryover; the registered
  estimand is narrower than a clean parallel-world memory effect.
- Two model families cannot establish universal model independence, and model
  versions age quickly.
- Participants who consent to trace-aware research may value process evidence
  differently from other writers.
- Signed trace is evidence of recorded edits, not proof of motive, attention,
  identity, originality, or truth.

## Registration record

Complete this block before enrollment; append rather than overwrite it later.

```text
status: NOT_FROZEN
frozen_at_utc:
repository_commit:
protocol_version: trace-writing-outcomes-v1
assignment_seed_commitment:
fixture_manifest_hash:
analysis_code_hash:
provider_model_versions:
context_byte_ceiling:
power_simulation_path_and_hash:
minimum_evaluable_target:
maximum_assigned_target:
retention_default_days: 30
serious_incident_reviewers:
```

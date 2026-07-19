# Desktop operation lifecycle

This note defines the private, local Phase 2 contract that can make one desktop
Extend operation recoverable without changing the Zine protocol. It is an
integration boundary for the desktop UI and native operation store, not a wire
format, signed provenance claim, or completed product capability.

## Boundary

The existing `PreparedOperation` owns the exact provider-adjusted messages,
operation inputs, provider fingerprint, and captured target revision. The
trace-context selector owns its package-local selected-context manifest and
identities. The desktop operation envelope freezes both outputs into one
versioned, vault-local record before approval or network activity.

```text
PreparedOperation + SelectedTraceContextManifestV1
                         |
                         v
          private desktop operation envelope
                         |
                         v
                pure lifecycle reducer
                         |
                 persist new envelope
                         |
                         v
              interpret returned effects
```

The envelope does not read credentials. It records a provider id, provider
fingerprint, protocol, model id, and a hash of credential-free transport
configuration. Provider credentials continue to resolve only at the transport
boundary.

## Identity and exact bytes

An operation has a stable `operationId`. Every provider attempt has a distinct
`attemptId`; a retry retains the operation id and points to its predecessor with
`retryOfAttemptId`. An ambiguous retry additionally records when the operator
acknowledged possible duplicate dispatch. A retry child id is not caller-
selected: it is the domain-separated canonical hash of the operation id and
parent attempt id. The encrypted native `create` is therefore the durable
cross-runtime claim for exactly one child per parent. A restart also scans for
legacy linked children before creating the deterministic id; compatible callers
converge on the existing child, while a different preparation,
acknowledgement, retention duration, explicit id, or second legacy child fails
closed. Retry time must strictly advance beyond the parent attempt's last
durable update.

The envelope retains, as private local data:

- the exact ordered provider-neutral messages and operation inputs;
- the exact prepared Extend authoring/apply contract, including staged
  directive deletions, while its authority remains valid only for the current
  editor activation;
- the approved public MODEL voice key (never its credential or signing key);
- the exact prepared target revision and apply range;
- generation limits and credential-free provider identity;
- the exact selected-context manifest and selected source range, rendered
  context, and its message index plus UTF-16 range in the prepared request;
- the exact completed response, if one exists;
- an ordered receipt of transition type, from/to status, stable id, timestamp,
  and action hash; and
- domain-separated SHA-256 identities for the request, selected context,
  response, and complete envelope.

Serialization uses deterministic UTF-8 key ordering, finite safe I-JSON
integers, and exact strings. Unpaired UTF-16 surrogates, undefined values,
cycles, invalid hashes, inconsistent targets, invalid context placement,
impossible transition histories, oversized responses, and oversized envelopes
fail closed. Strings are not normalized because prompt and result identity is
byte-exact.

## Lifecycle and dispatch certainty

The lifecycle is deliberately more conservative than a normal request state
machine:

```text
prepared -> approved -> dispatch-intent -> provider-io
    |          |
    +----------+-- expired directive authority --> stale (known not dispatched)
                              |                  |   |   +-> unknown -> abandoned
                              |                  |   +-----> failed
                              |                  +---------> response-completed
                              |                                    |    |    |
                              |                                    v    v    v
                              |                             accepted  stale  rejected
                              |                                 |
                              |                                 +------> stale
                              |
                              +-- recovered -----------------> unknown -> abandoned
```

Prepared and approved records are known not to have reached a provider. During
one uninterrupted activation, `dispatch-intent` is the persisted pre-I/O
handshake and `provider-io` means provider I/O may have started. A live reducer
transition into `provider-io` emits the single provider-dispatch effect, but
only after the caller durably stores the new envelope. Replaying the same
transition is idempotent and emits no effect.

Every live desktop Extend owns an `AbortController` from before private-envelope
persistence through provider completion. App teardown first clears ephemeral
directive authority, then aborts every controller, and only then releases the
vault-frozen runtime and repository references. An async persistence or
approval continuation therefore cannot recreate authority or begin provider
I/O after vault unmount. The runtime rechecks both cancellation and current-
session authorization immediately before the `provider-io` compare-and-set. A
cancellation that wins before that marker is durably `cancelled` and
known-not-dispatched. A cancellation observed after the marker is durably
`unknown` and may-have-dispatched, even when the runtime suppresses the pending
transport call: the durable recovery contract cannot use local scheduling to
prove that an external billable request did not start.

The Tauri provider proxy carries an opaque lowercase UUID and the current
native vault generation, both unrelated to prompt, credential, provider, or
response bytes. A bounded native registry makes cancel idempotent across pre-
registration, active, and recently completed states. It selects cancellation
against request send, error and non-stream body reads, and each streaming read,
then rechecks immediately before every IPC response delivery. The webview
clears buffered frames and ignores later channel events as soon as its
AbortSignal fires. Pre-registration cancellation uses a bounded five-minute
monotonic tombstone; registry saturation fails closed for new registrations
rather than evicting a cancellation that may still arrive out of IPC order.
Every native exit removes active and tombstone state synchronously. The webview
always reports cancellation as a generic `AbortError` and neither side logs raw
provider failures or response bytes from the cancellation race.

The registry starts closed and opens only when native vault activation has
successfully bound it to that exact vault generation. Native lock and webview-
reload recovery atomically stop new registrations, cancel every request in the
generation, and wait for the registry to drain before releasing the vault
binding. A drain failure leaves both the registry and vault generation closed
to new provider work. Tombstones and completed ids are cleared only after the
old generation drains; no request or late cancellation from one activation can
enter the next. Both single-shot and agent-loop provider calls use this same
request-id and shutdown boundary.

Across a process or activation recovery boundary, both `dispatch-intent` and
`provider-io` are ambiguous: a later marker could have rolled back after I/O
began. Recovery never emits provider dispatch for either state. It emits only
an instruction to record the attempt as `unknown`. Retrying an unknown or
provider-completed-without-result attempt requires explicit operator
confirmation and creates a newly linked attempt. This may spend another model
call, but it cannot silently duplicate one.

If current-session directive authority has expired on that ambiguous attempt,
the compact review uses a distinct **Re-prepare (may duplicate)** path. It
focuses the exact stable target, captures a fresh prepared request, and asks for
confirmation again at the final dispatch boundary. Only confirmation creates
the linked retry, with both `retryOfAttemptId` and
`possibleDuplicateAcknowledgedAtMs`; declining performs no provider I/O and
persists no retry. An ambiguous attempt is never converted into an unlinked
bare operation.

An operator may instead permanently abandon an `unknown` attempt. Abandonment
retains `may-have-dispatched` certainty and the structured dispatch-unknown
fault; it never rewrites ambiguous history as known not dispatched, and
recovery treats the record as terminal.

A completed response is presented for review. Rejection never creates an
artifact intent. Acceptance creates one local, idempotent artifact intent bound
to the operation, attempt, exact target revision, apply range, request,
selected-context manifest, and response. Recording a local application receipt
does not create, sign, or publish a MODEL Step; durable signed provenance remains
Phase 3 work.

Accept applies the validated result and every prepared one-shot directive
deletion in one CodeMirror transaction. It never inserts raw provider output.
Directive authority is intentionally not persisted across App activations: the
App keeps a per-mount authorization set for locally created attempt ids. The
same centralized predicate gates review, approval, provider dispatch, retry,
and application. A recovered or directly resumed directive-bearing prepared or
approved attempt without that same-mount authorization is durably marked stale
with known-not-dispatched certainty before any provider effect. It carries no
response and can only focus the exact target for re-preparation. If that
reconciliation cannot win its compare-and-set, the UI still exposes only exact-
target re-preparation. Unauthorized safe failed, cancelled, or rejected
attempts start a fresh operation rather than reusing the expired request.
Unauthorized ambiguous failed or unknown attempts use the confirmed linked
fresh-preparation path described above. Directive-free attempts remain
recoverable across activations.

The public MODEL voice key frozen in the prepared request is the sole identity
used for CodeMirror attribution, local runs, KEdits, crash-pad metadata, and
recovery verification. The crash-pad receipt binds the intent id to canonical
content, canonical runs, canonical KEdits, and that public MODEL key. A missing
or tampered component cannot produce `already-applied`; recovery never
synthesizes attribution or KEdits as a fallback. On restart, exact crash-pad
receipt recognition and restoration precede the ephemeral directive-authority
check: converging an already-applied receipt records no new editor mutation and
must not be rewritten as target-stale merely because the App activation
changed. Applied and abandoned terminal records are suppressed before the
authorization-expired review override.

The caller rechecks the captured target before acceptance and uses compare-and-
set when applying an accepted intent. A failed recheck moves
`response-completed` to durable `stale` with a `TARGET_STALE` review fault. A
compare-and-set race after persisted acceptance moves `accepted` to `stale`
with an apply fault and clears the accepted intent and receipt, so recovery can
never reapply it. Both paths preserve the recorded response, emit no automatic
effect, and offer review, discard, or a safe linked retry without a
duplicate-dispatch acknowledgement. An explicitly rejected recorded response
has the same safe linked-retry policy.

A stale retry cannot reuse the stale request or selector output or move to a
different document. It requires a
new `PreparedOperation`, new selected-context manifest/rendered bytes captured
from the current editor state, a new request id, and a new attempt id. The target
must retain the exact prior folder id, path, and stable trace id; head and
content may advance. The UI opens and focuses that exact target before
preparation, or refuses the retry. A different target begins a new operation.
The target revision may be byte-identical after focus-only staleness and
refocus. The operation id and `retryOfAttemptId` linkage remain stable; the new attempt starts
with an empty transition chain, and its caller must issue new transition ids.
Other retry states cannot replace their frozen request through this path.

## Fault and recovery contract

`OperationFaultV1` is redacted by construction. It carries only a closed code,
closed stage, timestamp, and optional opaque local diagnostic reference.
Arbitrary exception messages, provider payloads, headers, URLs, and credential
material have no field in the record.

The recovery projection gives native and UI integrations closed effects for:

- converting a recovered dispatch intent or may-have-started attempt to unknown;
- presenting a completed result for review;
- presenting a stale result for operator review without applying it;
- replaying an accepted but unreceipted local artifact intent; and
- deleting the expired private operation envelope.

Every reduction returns `mustPersistBeforeEffects: true`. An interpreter that
executes an effect before committing the new envelope violates this contract.
The one artifact receipt is also bound back to its sole
`record-artifact-applied` transition: receipt and transition timestamps must
match, and the transition action hash is recomputed from its transition id,
receipt id, resulting content hash, and exact timestamp during parsing.

Recovery scans the vault-wide journal, but the editor can apply only to the
currently restored workspace. An accepted intent for another workspace returns
the private local `deferred` outcome and remains accepted and unreceipted. A
later recovery after that exact workspace is restored may apply it. The compact
review strip filters records to the current workspace without deleting hidden
records.

Per-record recovery failures are counted and bounded. The App exposes only a
generic count/error; it never displays diagnostic samples or raw provider
exceptions. Raw `dispatch-intent` and `provider-io` projections expose no
operator actions while recovery reconciles them to durable `unknown`. Only
durable `unknown` offers the explicit duplicate-risk retry or abandon choices.
The runtime does not call the result presenter while walking recovery records:
durable reconciliation is separate from UI publication. Only after recovery
and a complete lineage scan both succeed does the App replace the visible
archive page. A later corrupt page, record failure, cancelled refresh, or vault-
session replacement clears recovery-derived archive actions instead of leaving
an incrementally recovered pin. Proven current-activation pins are a separate
overlay and may remain; recovery never adds to it. The success notice directs
the operator through the bounded **Previous** and **More / Next** archive
controls so recovered actionable heads remain reachable without pretending a
partial scan succeeded.

## Private retention

Exact requests, selected context, responses, hashes, and lifecycle metadata are
one disposable `vault-local-private` envelope in Phase 2. Each attempt carries a
deletion deadline: seven days by default and never more than thirty days in this
version. Terminal records are eligible for earlier deletion. At deletion, the
native store removes the entire envelope; Phase 2 keeps no tombstone or retained
hashes. The native store must keep vaults isolated and must not copy the envelope
to relay events, logs, crash reports, or analytics.

The desktop now has a native journal substrate for this contract. Each active
vault owns a separate `press.sqlite3`, never the relay's `relay.sqlite3`. The
native runtime derives a domain-separated journal key from the workspace key at
activation, keeps only zeroizing derived key material, and encrypts the whole
canonical envelope with authenticated encryption before SQLite sees it. A
keyed opaque record id hides operation and attempt ids; only its CAS revision
and deletion deadline remain plaintext for coordination and expiry. The
database uses WAL, full synchronous commits, a busy timeout, serialized native
mutations, and private directory/database permissions.

The narrow TypeScript adapter validates the strict V1 contract before writes
and after reads. It exposes create/update CAS, recovery load/list,
whole-envelope deletion, and expiry deletion. Production construction names the
native authority explicitly; browser tests may inject a backend, but there is
no silent local-storage fallback. The app now routes desktop Extend through
this substrate: Inspector approval persists the request before
provider I/O, completion enters explicit local review, Accept performs the
idempotent local editor/crash-pad transaction, and recovery resumes only safe
local effects. The compact UI reads one bounded page at a time, retains the
opaque current and next cursors plus a previous-cursor stack, and replaces its
view with exactly one native page of at most 16 records. Compact **Previous**
and **More / Next** actions move backward and forward without accumulating
earlier pages in memory. Because encrypted native rows are intentionally
ordered only by opaque keyed record ids, every archive load streams the journal
in bounded pages and retains lineage heads only for the operations on the
visible page. Superseded attempts therefore never regain actions when a linked
head lands on another page. A separate bounded 16-operation current-head
overlay keeps newly completed work visible regardless of record-id order and
deduplicates it against the archive head. Lineage keys are the composite
operation-plus-attempt identity, so identical attempt ids in different
operations cannot collide. Reduction uses retry-parent edges rather than
timestamps or opaque ids, accepts only the newest durable snapshot of one
attempt, and requires exactly one unambiguous head. Disconnected attempts,
siblings, cycles, or equal-version byte conflicts are archive-only and fail
closed. A malformed current-session lineage reserves only its operation id in a
bounded activation fence; it consumes none of the 16 visible pins and a later
partial callback cannot resurrect it. Fence overflow hides the entire overlay.
Scan failure or vault-session change clears archive actions rather than
projecting a partial lineage. The deterministic retry claim reuses the existing
encrypted envelope and opaque keyed row id; no operation id, attempt id,
parent id, or timing field is added to plaintext native metadata.
Selective portable commitments and
disclosure belong to Phase 3 after the trust/schema review.

## Not included

This contract intentionally does not:

- change protocol or relay schemas;
- create or encode signed Steps;
- add Settle, Stir, Reply, Analyze, Run, or multi-provider orchestration; or
- claim that selected trace improves writing.

The current integration is desktop-only and Extend-only. It does not Step,
Mint, attest, publish, or produce portable provenance when a draft is accepted.
The separate accepted MODEL Step transaction remains Phase 3 work. Settle
should reuse the lifecycle rather than invent a second one; mobile and
multi-provider orchestration remain explicitly postponed.

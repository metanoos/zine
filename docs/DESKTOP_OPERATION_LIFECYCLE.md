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
acknowledged possible duplicate dispatch.

The envelope retains, as private local data:

- the exact ordered provider-neutral messages and operation inputs;
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
                                             |   |   +-> unknown -> abandoned
                                             |   +-----> failed
                                             +---------> response-completed
                                                               |    |    |
                                                               v    v    v
                                                        accepted  stale  rejected
                                                            |
                                                            +------> stale
```

Prepared, approved, and dispatch-intent records are known not to have reached a
provider. `provider-io` means provider I/O may have started. A live reducer
transition into that state emits the single provider-dispatch effect, but only
after the caller durably stores the new envelope. Replaying the same transition
is idempotent and emits no effect.

Recovery from `provider-io` never emits provider dispatch. It emits only an
instruction to record the attempt as `unknown`. Retrying an unknown or
provider-completed-without-result attempt requires explicit operator
confirmation and creates a newly linked attempt. This may spend another model
call, but it cannot silently duplicate one.

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

The caller rechecks the captured target before acceptance and uses compare-and-
set when applying an accepted intent. A failed recheck moves
`response-completed` to durable `stale` with a `TARGET_STALE` review fault. A
compare-and-set race after persisted acceptance moves `accepted` to `stale`
with an apply fault and clears the accepted intent and receipt, so recovery can
never reapply it. Both paths preserve the recorded response, emit no automatic
effect, and offer review, discard, or a safe linked retry without a
duplicate-dispatch acknowledgement. An explicitly rejected recorded response
has the same safe linked-retry policy.

## Fault and recovery contract

`OperationFaultV1` is redacted by construction. It carries only a closed code,
closed stage, timestamp, and optional opaque local diagnostic reference.
Arbitrary exception messages, provider payloads, headers, URLs, and credential
material have no field in the record.

The recovery projection gives native and UI integrations closed effects for:

- resuming the pre-I/O dispatch handshake;
- converting a may-have-started attempt to unknown;
- presenting a completed result for review;
- presenting a stale result for operator review without applying it;
- replaying an accepted but unreceipted local artifact intent; and
- deleting the expired private operation envelope.

Every reduction returns `mustPersistBeforeEffects: true`. An interpreter that
executes an effect before committing the new envelope violates this contract.

## Private retention

Exact requests, selected context, responses, hashes, and lifecycle metadata are
one disposable `vault-local-private` envelope in Phase 2. Each attempt carries a
deletion deadline: seven days by default and never more than thirty days in this
version. Terminal records are eligible for earlier deletion. At deletion, the
native store removes the entire envelope; Phase 2 keeps no tombstone or retained
hashes. The native store must keep vaults isolated and must not copy the envelope
to relay events, logs, crash reports, or analytics.

The current TypeScript envelope describes this policy and emits an expiry
effect; durable encrypted storage and whole-envelope deletion are owned by the
later native store lane. Selective portable commitments and disclosure belong
to Phase 3 after the trust/schema review.

## Not included

This contract intentionally does not:

- change protocol or relay schemas;
- create or encode signed Steps;
- dispatch a provider request itself;
- apply text to the editor;
- perform compare-and-set or directive-consumption transactions;
- add Settle, Stir, Reply, Analyze, Run, or multi-provider orchestration; or
- claim that selected trace improves writing.

The next integration can wire Extend through this contract, a vault-scoped
native store, explicit result review, compare-and-set application, and the
separate accepted MODEL Step transaction. Settle should reuse the lifecycle
rather than invent a second one.

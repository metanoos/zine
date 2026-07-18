# Evidence

Zine asks readers to check claims, not to trust them. This page separates
exercised implementation, measured research, protocol assertions, and open
hypotheses. Last updated 2026-07-17.

## What works today

| Capability | State | How to check |
|---|---|---|
| Signed, self-contained file and folder checkpoints | Implemented | Client provenance tests and real-relay smoke |
| Mandatory replay-valid KEdit process log on every file Step | Implemented | Publisher rejects mismatches; editor, AI, import/fork, MCP, replay, and real-relay regression coverage exercise the invariant |
| Step, Send, Attest, Mint, and Cite | Implemented | `npm run verify:relay` exercises temporary ACL-protected relays |
| Desktop press with local relay sidecar | Implemented | React/Tauri client, Rust sidecar lifecycle, Go relay |
| Desktop Stronghold storage for signing and provider secrets | Implemented on desktop; browser remains read-only | `secret-store.test.ts`, `secret-migration.test.ts`, key/model store tests, and the Tauri Stronghold shell |
| Headless MCP press with its own voice key and permanent profile Root | Implemented | Offline stdio smoke proves zero-folder cold start, exact signed-event outbox, raw node reads, and Root/key reuse; isolated real-relay integration flushes a queued event unchanged, preserves optional source forks, and exercises external Send |
| Prepared desktop MODEL operations and approval gating | Implemented for direct single-shot gestures; not yet enforced on every live model call | `prepared-operation.test.ts`, `context-snapshot.test.ts`, `model-operation-executor.test.ts`, and `llm-prepared.test.ts`; the separate agent loop still uses its own transport, and `preparedRequestHash` is not yet stored in Step metadata |
| Per-delta human/model attribution | Implemented | Attribution regression suite; trust status remains asserted unless corroborated through a signed seam |
| Fork and merge | Implemented for owned recursive destinations and current top-level foreign flows | Nested Scan/adoption/fork tests plus merge and ownership tests; recursive fork-on-write through an already-foreign folder remains deferred |
| Mutual-peer co-citation and process vet | Implemented and tested | `co-citation.ts`, `vet.ts`, `vet-walker.ts`, and their tests |
| Exact and fuzzy quote matching | Implemented with uncalibrated defaults | SHA-256 coordinate plus MinHash/LSH client layer |
| Raw-file Reify with optional trace bundle and report | Implemented on desktop | `reify.ts` materializes signed snapshots and keeps raw events under `.zine/` |
| Global Kademlia rendezvous | Not implemented | Design sketch in the [rendezvous specification](../protocol/rendezvous.md) |
| No-install public verifier | Not implemented | On the [roadmap](ROADMAP.md) |
| Managed organization service | Not implemented | Hosted relay code exists; no paid service or SLA is claimed |

Desktop vault caveat: Stronghold's password and snapshot KDFs are
intentionally expensive. A fully unoptimized development build can appear to
stall for minutes; the current development profile optimizes only the
cryptographic hot paths. Release KDF parameters and the application security
contract are unchanged.

Reify writes each chosen Step's authoritative `snapshot` to its ordinary file
path. It never substitutes the live unstepped editor buffer and never embeds
provenance in the file. “Include trace” is explicit and off by default; when
enabled it adds raw signed events at `.zine/trace.json` and a derived readable
projection at `.zine/report.md`. The JSON, not the report, preserves the fields
needed to verify event ids and signatures.

Nothing above needs to be taken on faith. From a repository checkout:

```sh
npm run check          # client, MCP, relay, and Rust tests
npm run verify         # check + client build + isolated relay smoke
npm run verify:relay   # real Step/Send/Attest/Mint/Cite flow
```

## What we have measured

The pre-registered narration study asked whether structured edit evidence
changes how an LLM describes the creation of a document.

For the bulk-insert failure class, bound narration fell from 5/5 with
character-magnitude labels and span payloads, to 2/5 with spans only, to 0/5
with neither. On the second trace, all five bare-log draws invented content
that was not in the file. The exact results and raw draws are preserved in
[`research/results.md`](../research/results.md).

The strongest comparison is labels-plus-spans versus bare log, 5/5 versus 0/5
bound. The repository records an approximate one-tailed Fisher exact
`p ~= 0.004`. The marginal contribution of the summary label over span content
alone is directional but not statistically separable at five draws.

Limits:

- one model (`glm-5.2`);
- five draws per condition;
- one hand scorer who was not blind to condition;
- two source traces; and
- no customer outcome measured.

This study supports one technical claim: structured process evidence can make
machine narration of an artifact more faithful. It does not demonstrate
market demand or a general model-independent effect.

## What the evidence can and cannot establish

| Evidence | Supports | Does not establish |
|---|---|---|
| Valid TraceNode signature | The named pubkey signed this exact event | Legal identity, humanness, truth, or exclusive authorship |
| Snapshot hash and replay-valid KEdit transition | The stored body is internally consistent with the signed process record | That the press observed activity outside its own editor/tool boundaries, or that a signer did not deliberately fabricate a trace |
| Per-delta voice index | The node signer asserted that voice for the changed span | Independent proof that the attributed person or model produced it |
| Cross-author seam plus signed source node | The attributed text is corroborated by a node under the source key | Consent, originality, or copyright ownership |
| Completed OpenTimestamps proof | The committed event id existed no later than the Bitcoin attestation | The truth of `created_at`, author identity, or uninterrupted human work |
| Timing and revision-graph signals | A declared admission policy found the process more or less consistent with its reference model | Proof of a human author; a patient generator can reproduce the signals |
| Content-hash co-citation | Two reachable traces cite identical or canonical-equivalent content | Shared intent, agreement, or a meaningful social relationship |

The normative trust posture is in
[`protocol/trace-provenance.md`](../protocol/trace-provenance.md) and
[`protocol/rendezvous.md`](../protocol/rendezvous.md).

## What we have not proven yet

- That, across representative writing tasks and providers, supplying selected
  trace plus text improves context adherence, writing quality, unsupported
  inference, correction burden, or reviewer preference over text alone.
- That independently minting the same distinctive coin type predicts broader
  corpus affinity better than chance after controlling for topic and
  popularity.
- That longitudinal style, process, and conditional-compression features add
  calibrated vetting value beyond lexical overlap without being mistaken for
  proof of humanity or identity.
- Named teams returning week after week to multi-AI task and correspondence
  work on real artifacts.
- A cross-model handoff whose trace answers a consequential question that
  ordinary files plus provider logs could not.
- Willingness to pay for a hosted or organization layer.
- A no-install verifier used outside the authoring environment.
- Kind and tag registration in the Nostr ecosystem.
- A second independent implementation of the wire format.
- A consented corpus large enough to calibrate timing, revision-shape, and
  fuzzy-match models.
- Organic co-citation density sufficient to justify global rendezvous work.
- Clean-machine release installation on every supported desktop platform.

These gaps are roadmap gates, not details to hide. A claim moves off this
list only when its evidence is linked here.

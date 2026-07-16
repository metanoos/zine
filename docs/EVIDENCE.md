# Evidence

Zine asks readers to check claims, not to trust them. This page separates
exercised implementation, measured research, protocol assertions, and open
hypotheses. Last updated 2026-07-15.

## What works today

| Capability | State | How to check |
|---|---|---|
| Signed, self-contained file and folder checkpoints | Implemented | Client provenance tests and real-relay smoke |
| Step, Send, Attest, Mint, and Cite | Implemented | `npm run verify:relay` exercises temporary ACL-protected relays |
| Desktop press with local relay sidecar | Implemented | React/Tauri client, Rust sidecar lifecycle, Go relay |
| Headless MCP press with its own voice key | Implemented | MCP unit/build smoke plus isolated relay integration |
| Per-delta human/model attribution | Implemented | Attribution regression suite; trust status remains asserted unless corroborated through a signed seam |
| Fork and merge | Implemented for current top-level flows | Merge and ownership tests; recursive nested-folder fork-on-write remains deferred |
| Mutual-peer co-citation and process vet | Implemented and tested | `co-citation.ts`, `vet.ts`, `vet-walker.ts`, and their tests |
| Exact and fuzzy quote matching | Implemented with uncalibrated defaults | SHA-256 coordinate plus MinHash/LSH client layer |
| Global Kademlia rendezvous | Not implemented | Design sketch in the [rendezvous specification](../protocol/rendezvous.md) |
| Public proof report and no-install verifier | Not implemented | On the [roadmap](ROADMAP.md) |
| Managed organization service | Not implemented | Hosted relay code exists; no paid service or SLA is claimed |

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
| Snapshot hash and valid delta replay | The stored body is internally consistent with the signed record | That every real-world edit was captured |
| Per-delta voice index | The node signer asserted that voice for the changed span | Independent proof that the attributed person or model produced it |
| Cross-author seam plus signed source node | The attributed text is corroborated by a node under the source key | Consent, originality, or copyright ownership |
| Completed OpenTimestamps proof | The committed event id existed no later than the Bitcoin attestation | The truth of `created_at`, author identity, or uninterrupted human work |
| Timing and revision-graph signals | A declared admission policy found the process more or less consistent with its reference model | Proof of a human author; a patient generator can reproduce the signals |
| Content-hash co-citation | Two reachable traces cite identical or canonical-equivalent content | Shared intent, agreement, or a meaningful social relationship |

The normative trust posture is in
[`protocol/trace-provenance.md`](../protocol/trace-provenance.md) and
[`protocol/rendezvous.md`](../protocol/rendezvous.md).

## What we have not proven yet

- Named teams using Zine on real work, week after week.
- Willingness to pay for a hosted or organization layer.
- A public verification artifact used outside the authoring environment.
- Kind and tag registration in the Nostr ecosystem.
- A second independent implementation of the wire format.
- A consented corpus large enough to calibrate timing, revision-shape, and
  fuzzy-match models.
- Organic co-citation density sufficient to justify global rendezvous work.
- Clean-machine release installation on every supported desktop platform.

These gaps are roadmap gates, not details to hide. A claim moves off this
list only when its evidence is linked here.

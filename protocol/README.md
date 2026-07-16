# Protocol documents

This directory is the protocol source of truth. Use the table below to resolve
conflicts and to keep wire rules, implementation status, and explanation
separate.

| Document | Authority |
|---|---|
| [`trace-provenance.md`](trace-provenance.md) | Trace events, integrity, composition, attribution, and author gestures |
| [`transport.md`](transport.md) | Node identity, relay access policy, reachability, and onion derivation |
| [`rendezvous.md`](rendezvous.md) | Content-hash discovery and process-evidence admission policy |
| [`../docs/PROTOCOL.md`](../docs/PROTOCOL.md) | Non-normative reader-facing tour of the three specs |

The client About view imports the five reader-facing documents in `docs/` at
build time. Each document begins with one `#` title and uses `##` headings for
its section navigation. Do not duplicate that prose in React.

Product positioning, validation, and commercial sequencing are non-normative.
They are indexed by [`docs/README.md`](../docs/README.md) and live in
[`docs/PRODUCT.md`](../docs/PRODUCT.md),
[`docs/PROTOCOL.md`](../docs/PROTOCOL.md),
[`docs/EVIDENCE.md`](../docs/EVIDENCE.md),
[`docs/ROADMAP.md`](../docs/ROADMAP.md), and
[`docs/COMPANY.md`](../docs/COMPANY.md). Those documents may package or defer a
capability, but they never change its wire semantics.

## Status language

- **Specified** means a normative shape exists; it does not imply code exists.
- **Implemented** means the repository contains an exercised implementation.
- **Planned** or **sketch** means the design is non-shipping and may change.
- Rationale records superseded decisions as history, but must label them as
  superseded and point to the current normative rule.

When documents conflict, follow the owning specification above. Cross-domain
behavior must satisfy every applicable specification. Reader-facing documents
never override a normative rule.

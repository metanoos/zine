# Protocol documents

This directory is the protocol source of truth. Use the table below to resolve
conflicts and to keep wire rules, implementation status, and explanation
separate.

| Document | Authority |
|---|---|
| [`trace-provenance.md`](trace-provenance.md) | Trace events, integrity, composition, attribution, and author gestures |
| [`transport.md`](transport.md) | Node identity, relay access policy, reachability, and onion derivation |
| [`rendezvous.md`](rendezvous.md) | Content-hash discovery and process-evidence admission policy |
| [`directors-cut.md`](directors-cut.md) | Non-normative seven-page guided tour of the three specs |

The client About view imports the seven `## Page N — Title` sections from
`directors-cut.md` at build time. Do not duplicate that prose in React. The
heading shape and page count are a build contract; changing either requires a
corresponding navigation change.

## Status language

- **Specified** means a normative shape exists; it does not imply code exists.
- **Implemented** means the repository contains an exercised implementation.
- **Planned** or **sketch** means the design is non-shipping and may change.
- Rationale records superseded decisions as history, but must label them as
  superseded and point to the current normative rule.

When documents conflict, follow the owning document above. Cross-domain
behavior must satisfy every applicable spec. The Director's Cut never
overrides a normative rule.

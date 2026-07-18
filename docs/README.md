# Documentation

These documents explain Zine from product, protocol, evidence, roadmap, and
company perspectives. They are the shared reader-facing source for this
repository and the app's About view.

The organizing product thesis is that final text discards information useful
to both collaborators and reviewers. Zine preserves a trace so an AI can work
with selected, inspectable process context while people retain portable evidence
of what happened. The [Evidence](EVIDENCE.md) page distinguishes that
foundational bet from what the repository has actually demonstrated.

| Document | Question it answers |
|---|---|
| [Product](PRODUCT.md) | How trace-aware writing works, who needs it, and where adoption starts |
| [Protocol](PROTOCOL.md) | How traces, gestures, attribution, transport, and vetting work |
| [Evidence](EVIDENCE.md) | What is implemented, measured, asserted, and still unknown |
| [Roadmap](ROADMAP.md) | How the trace-context runtime, evaluation, and later team layers are sequenced |
| [Company](COMPANY.md) | How an open sovereign protocol can support an optional paid layer |

## Authority

These documents package the product for readers; they do not define the wire.
The normative specifications remain in [`protocol/`](../protocol/README.md).
When a reader-facing document conflicts with an owning specification, the
specification wins.

## About view

The client bundles these same five Markdown files at build time. Each file has
one `#` title and uses `##` headings for its in-app section navigation. Keep
reader-facing prose here rather than duplicating it in React.

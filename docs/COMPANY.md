# Company

Zine's protocol and presses are open source, and self-hosting is a complete
path, not a trial. This page explains how an optional paid layer can exist
without compromising that — and what stays free no matter what. No paid
service is shipping today.

## The framing

Zine separates local history from hosted coordination the way Git separates a
repository from a remote. The protocol is the commons. A company can sell the
operational layer that teams want but the wire deliberately does not require.

In that analogy Zine is the Git, and an optional managed service can play the
GitHub role: durable coordination, organization controls, review, and
distribution around a portable open format.

> Everyone runs their own press. The company is where presses meet.

This is compatible with sovereignty because the paid layer is optional. A
press can write to its local relay, self-host a remote, and verify events
without phoning home.

## What is open, what is paid

| Always open | Optional paid layer |
|---|---|
| Signed trace events and verification rules | Managed always-on remote with backups and SLA |
| Local desktop and MCP presses | Organization onboarding, support, and policy controls |
| Self-hosted compatible relays | Team key, writer, peer, and ACL management |
| Step, Send, Attest, Mint, Cite, fork, and merge | Hosted anchoring cadence and proof retention |
| Reader-side verification algorithms | No-install verification portal and exportable reports |
| Self-hosted process evidence | Opt-in calibration service over a consented corpus |
| Future open rendezvous wire | Operated bootstrap infrastructure, if usage justifies it |

The protocol deliberately says that any compatible NIP-01 and NIP-33 relay
can store published traces. The commercial value is not a special relay
class. It is reliable operation, organization controls, verification
workflow, and calibrated interpretation around commodity storage.

## Where a paid layer could grow

| Open need | Product opportunity | Today |
|---|---|---|
| A super-peer keeps a published corpus reachable | Managed remote, backup, retention policy, and SLA | Hosted relay code exists; no paid service or SLA is claimed |
| Self-hosted OTS calendar is the target, not current behavior | Managed anchoring with declared cadence and proof availability | Current prototype can use a public calendar |
| Peer-list portability across devices is unsettled | Organization key and ACL control plane | Not implemented |
| DHT bootstrap needs operator-provided super-peers | Operated bootstrap | Deferred with the global DHT |
| Verification is bounded and reader-side | Public verifier and exportable evidence report | Local bundle/report implemented; public verifier is not |
| Timing and graph models need real calibration | Opt-in research corpus and calibrated policy models | Defaults exist; calibration does not |

## How pricing would work

The free product includes everything required to author, self-host, and
verify a trace. Paid plans charge for operational outcomes:

- availability and durable retention;
- organization identity and access administration;
- policy, review, and evidence-export workflows;
- managed anchoring and proof maintenance;
- support and deployment assurance; and
- calibrated interpretation built from an opt-in, consented corpus.

The first paid conversion should come from a team asking for reliable remote
operation, organization control, or review evidence. Charging for the local
press, or making verification depend on a proprietary endpoint, would weaken
the thesis rather than strengthen the business.

## Why openness is the strategy

Cryptographic primitives and relay storage are not what makes this durable.
If the company earns a lasting position, it compounds in this order:

1. Integration into real agent-to-artifact workflows.
2. A growing corpus of portable, independently verifiable traces.
3. Review and organization workflows that make the evidence useful.
4. A consented dataset for calibrated process interpretation.
5. A network of authors, reviewers, and citations, if density emerges.

Open verification strengthens each step: every shared proof can bring a new
reviewer into the product without asking anyone to trust a sales claim.

## Commitments

These hold regardless of business model:

- BYOK remains supported.
- Local-first remains the default.
- The open specification remains open.
- Self-hosting remains a complete path, not a crippled community tier.
- Attribution remains asserted or verified according to available evidence.
- Zine never claims to prove humanness, truth, or copyright ownership.
- Contribution to calibration datasets is explicit and opt-in.
- The press does not require a company account to create or verify core
  trace events.

## What would prove us wrong

The strategy fails if teams do not care enough about agent-written artifacts
to change their workflow, if ordinary version control plus model logs answer
the review question well enough, or if reviewers will not open a shared
proof. The network thesis fails if real corpora do not produce useful
co-citations.

The [roadmap](ROADMAP.md) sequences the work so those questions are answered
before the expensive layers are built.

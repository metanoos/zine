# Transport & Reachability (draft)

Status: draft. This document is authoritative for network identity, access,
and reachability. `trace-provenance.md` owns the trace data model.

## 1. Key roles

The press has one local keychain and assigns keys to explicit roles. A fresh
install SHOULD use distinct keys so rotating an author or model voice cannot
silently change the relay's owner or network address. An installation MAY
intentionally assign one key to several roles.

| Role | Responsibility | Rotation posture |
|---|---|---|
| **NODE** | Relay owner, NIP-42 AUTH signer, source of the primary onion key (§3) | Stable per machine; rotation changes address and ACL owner |
| **AUTHOR** | Signs trace nodes and publication gestures | May switch between author voices |
| **MODEL** | Identifies model-produced edits | May switch independently |
| **DOOR** | Optional additional onion into the same relay | Add before rotating NODE so peers can migrate |

Each onion is still derived deterministically from its assigned NODE or DOOR
Nostr key; there is no separately persisted Tor credential. The load-bearing
invariant is narrower and clearer: **NODE determines relay ownership and the
primary address; AUTHOR determines who signed a trace.** Implementations MUST
NOT infer one role from the other.

## 2. Architecture: access-policy mesh

Each relay serves **only events authorized by its NODE owner**. The
NODE-authenticated owner may submit valid events for the press's AUTHOR and
MODEL keys. An authorized writer may submit only events signed by that writer.
Peers are read-only. Nothing arrives through gossip or transitive forwarding;
storing a writer's events is an explicit delegation by the NODE owner.

This follows from the trace protocol's self-sufficiency rule: a cited node
resolves in one bounded fetch from its author. Relays therefore need not cache
peer traces. Gossip would add anti-entropy, deduplication, backfill, and
unbounded storage without improving correctness. It would also introduce an
intermediary that attribution seams do not model. The access-policy mesh keeps
verification end to end.

**Amplification is citation, not replication.** To amplify a peer, publish a
`TraceOpinion` with a high `alpha`, cite the work in a composite trace, or tag
it. Do not rebroadcast their content. The relay remains a dumb pipe, and local
storage stays limited to events the NODE policy authorized.

### Roles

| Pubkey | Connect | Read | Write |
|---|---|---|---|
| **Owner** (the NODE key) | always | ✅ | ✅ valid events accepted by relay policy |
| **Writer** (in the ACL) | allowed | ✅ | ✅ only events signed by that writer key |
| **Peer** (in the ACL) | allowed | ✅ read-only | ❌ |
| **Unknown** | challenged (NIP-42) | ❌ until authed | ❌ |

The owner, writers, and peers live in a **private local ACL**
(`~/.tracer/peers.json`), never a public Nostr event. A future kind-3 contact
list may support reader-side discovery, but it MUST NOT control relay access.
"Whose work do I follow?" and "who may read my relay?" are different questions.

**Following is local reader preference.** It filters Stacks, Times, and Spaces,
but grants no access, implies no reciprocity, and is not an attestation. The
current client stores follows locally. If kind-3 publication is added later, it
MUST remain separate from `peers.json`: Follows control what I read; Peers
control who can read me; Writers control who may publish under their own key.

### Super-peers

A **super-peer** is an always-online relay holding a replica of *your published corpus*.
It keeps cited traces reachable while a desktop is offline; it is not a
discovery platform or a network reader. Any NIP-01+NIP-33 relay suffices. Add
one to the relay set with `write: true`; `publishToMany` already fans each
stepped trace to it.

Two super-peer extensions belong to the rendezvous layer (`rendezvous.md`):

- **OTS calendar host.** The prototype currently submits Step ids to a public
  OpenTimestamps calendar. A configurable self-hosted calendar on the
  super-peer is the intended sovereignty-preserving deployment, but the
  protocol must not claim hashes remain on author-owned infrastructure until
  that configuration exists.
- **Coins rendezvous bootstrap.** The Kademlia component inside the opt-in
  Coins package remains under implementation (`rendezvous.md` §2.3). Its
  current desktop path accepts operator-provided libp2p multiaddrs. The
  author's own super-peer(s) serve as bootstrap, keeping the network's trust
  character coherent: you join through the same infra that already holds a
  replica of your published corpus. Applying a replacement configuration is
  transactional: the native runtime validates it before persistence and
  restores the prior runtime/configuration on failure. The current DHT server
  also applies bounded connection and idle-time limits; record filtering,
  cache reservation, and publication semantics belong to `rendezvous.md`
  §2.2. No public bootstrap network is operated here.

The third slot of a `q` or `e` tag carries a relay hint. It can name the
author's `.onion` while the desktop is online or a durable super-peer URL. A
reader tries the onion, then the super-peer. The existing field already
expresses the degradation ladder.

## 3. NODE/DOOR onion derivation scheme (normative)

A Tor v3 onion address is a deterministic, one-way function of the assigned
NODE or DOOR secp256k1 secret. The secret holder reproduces the onion; an
npub-holder cannot. AUTHOR and MODEL keys do not affect reachability unless
the user explicitly assigns one of those same key records to NODE/DOOR too.

### 3.1 Derive the ed25519 seed

```
onionSeed = HKDF-SHA256(
  ikm   = secp256k1_secret,      // 32-byte Nostr private key
  salt  = "zine-onion-v1",       // 14 bytes, ASCII
  info  = "tor-ed25519-seed",    // 16 bytes, ASCII
  L     = 32,                    // output length
)
```

Per RFC 5869: PRK = HMAC-SHA256(salt, ikm); OKM =
HMAC-SHA256(PRK, info || 0x01), truncated to 32 bytes.
`@noble/hashes/hkdf` implements this directly.

The domain-separation strings (`"zine-onion-v1"`, `"tor-ed25519-seed"`) are
versioned and named so two implementations agree, and so a future scheme change
(`-v2`) produces a different onion without colliding with the old.

### 3.2 Derive the ed25519 public key

```
onionPubkey = ed25519.getPublicKey(onionSeed)   // 32 bytes
```

`@noble/curves/ed25519`. The seed is a valid ed25519 private key directly — no
clamping step is needed from the caller; `getPublicKey` handles it internally.

### 3.3 Construct the .onion address (Tor v3)

Per the [Tor onion-address encoding specification](https://spec.torproject.org/rend-spec/encoding-onion-addresses.html),
an onion address is the base32 encoding of a 35-byte payload:

```
[32 bytes: ed25519 pubkey] [2 bytes: checksum] [1 byte: version (0x03)]
```

where the checksum is:

```
checksum = SHA3-256(".onion checksum" || pubkey || version)[:2]
```

`".onion checksum"` is the exact 15-byte ASCII literal, with one space between
`onion` and `checksum`.

The 35-byte payload is base32-encoded (RFC 4648, no padding), lowercase, and
the suffix `.onion` is appended, yielding a 56-character address + `.onion` =
62 characters total.

### 3.4 The key never touches disk

Tor's control-port `ADD_ONION` command accepts the key inline, but expects the
**64-byte expanded private key** (not the 32-byte seed):

```
ADD_ONION ED25519-V3:<base64-of-64-byte-expanded-key> Port=80,127.0.0.1:4869
```

The expanded key is `SHA-512(seed)` split into two 32-byte halves: the first
half clamped (the ed25519 scalar — bits 0-2 cleared, bit 254 set, bit 255
cleared), the second half unmodified (the prefix/PRF nonce). This is the same
format libsodium's `crypto_sign_seed_keypair` produces internally. Passing only
the 32-byte seed fails with "Failed to decode ED25519-V3 key."

The press derives the seed, expands it to 64 bytes, passes it through Tor's
control port, and receives an in-memory onion service. On the next launch it
derives and registers the same service again. There is no
`~/.tracer/onion-key`; the assigned NODE or DOOR secret is the source.

This makes a door portable across networks: the same assigned secret, on a new
machine, reproduces the same address. It does not collapse author identity,
relay ownership, and reachability into one protocol role.

## 4. The degradation ladder

| Rung | Transport | NODE identity | Reachability | Privacy |
|---|---|---|---|---|
| 1 (default) | Clearnet relay | npub (invariant) | requires IP/URL known | none |
| 2 | Tor onion service | npub (invariant) | stable .onion, inbound | metadata privacy |
| 3 | Super-peer replica | npub (invariant) | durable, always online | none (clearnet) |

The NODE npub is **invariant across all rungs** — the load-bearing fact.
If a corporate firewall drops Tor handshakes, the press falls back to rung 1 or
3 and *keeps its identity*; it loses metadata privacy (rung 1) or durability
(rung 3 vs. 2), not sovereignty. The trade is always reachability/privacy, never
identity. This is the honest reading of "stable across networks."

### Why Tor is the listener, not an IP-policy exception

Tor forwards inbound peer connections to the relay, and they appear to
originate from localhost. The relay cannot distinguish "the owner's own desktop
app" from "a peer arriving via Tor" by IP address. This is why access control
**must** be pubkey-based (NIP-42 AUTH), not IP-based: the IP-based trust model
the sidecar previously relied on (localhost = trusted) breaks entirely once Tor
is the listener. Everyone authenticates — including the owner.

## 5. Access control mechanics (NIP-42)

khatru cannot reject a WebSocket connection by pubkey because NIP-42 reveals
the key only after connection. The allowlist therefore gates events and
filters:

- **`RejectEvent`**: an unauthenticated caller receives an `"auth-required:"`
  challenge. The NODE owner may write under relay policy. A listed writer may
  write only when the event's `pubkey` matches the authenticated writer key.
  Peers are read-only, so an authenticated peer's write is rejected without a
  second challenge.
- **`RejectFilter` / `RejectCountFilter`**: if `GetAuthed(ctx)` is empty → reject
  with `"auth-required:"`. If authenticated as owner, writer, or peer → allow
  reads.

The owner is the stable NODE key, not the current AUTHOR or MODEL key.
`peers.json`'s `owner` field must match the NODE pubkey or the press cannot
authenticate as relay owner. Writer entries remain distinct author identities;
the write gate never lets a writer impersonate another key.

### What changed in the relay's security posture

The relay's prior header rationale (limiting connections is "pure friction" for a
localhost sidecar) inverts when the relay accepts inbound from peers. The
connection rate limiter is reinstated, and the access policy is a real security
boundary, not friction. This is the change from "embedded server for one" to
"actual server."

## Open questions

- **Outbound Tor reads.** Reading a peer's `.onion` from the browser requires a
  SOCKS-proxied WebSocket; the browser `WebSocket` API can't do SOCKS directly.
  First pass: Tor is inbound-only (peers reach you); outbound reads go via
  clearnet/super-peer. A Rust-side relay proxy or a WebSocket-to-SOCKS bridge is
  the later path.
- **Iroh/libp2p direct sync.** An optional P2P fast lane for when two presses are
  mutually online — a latency/privacy optimization, not a correctness
  requirement (self-sufficiency §R1 makes it unnecessary for correctness).
  The in-progress Coins rendezvous component introduces libp2p in the Rust
  backend (`rendezvous.md` §2.2); a direct-sync fast lane could later reuse it.
  Direct sync remains deferred.
- **Peer-list portability across devices.** The private local ACL is per-device.
  Multi-device sync of the peer list (not the key — that's NIP-46's job) is
  unsettled; a stepped trace on the owner's own relay is the likely vehicle.

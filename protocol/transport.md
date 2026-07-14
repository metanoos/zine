# Transport & Reachability (draft)

Status: draft. Companion to `trace-provenance.md`. This document specifies how
traces are *reached* across the network — identity, access, and reachability —
not the trace data model itself (which lives in the provenance protocol).

## 1. The single credential

Every cryptographic fact about a press derives from one secret: the owner's
**Nostr secp256k1 private key**. Three roles, one key:

| Role | What it is | How it's derived |
|---|---|---|
| **Identity** | The npub (Nostr public key) | secp256k1 — already shipped |
| **Relay access** | NIP-42 AUTH challenge response | the same secp256k1 key signs kind-22242 |
| **Reachability** | The .onion address (Tor v3) | HKDF-SHA256 → ed25519 seed (§3) |

There is no second credential. Lose the Nostr secret, lose the onion. Have the
Nostr secret, reproduce both identity and reachability on any machine. This
property — *the onion address is derived from the Nostr key, not an independent
credential* — is load-bearing: it is what makes identity stable across networks,
and it is what makes the medium honestly describe itself (your sovereignty is one
key, not three).

## 2. Architecture: access-policy mesh

Each press's relay serves **only that press owner's authored traces**. This is
not gossip (SSB-style epidemic replication), and not a shared data plane. It is
an **access-policy mesh**: friends are who may *connect and read*, never what you
*cache or forward*. You host your words; your friends host theirs; nobody carries
speech they did not sign.

This is the design the trace protocol was built for. The load-bearing claim of
`trace-provenance.md` §R1 is that "a cited node must resolve as one fetch against
a self-contained object" — node self-sufficiency means you never need to cache a
friend's trace, because any cited node resolves in one bounded fetch from its
author. Gossip exists to solve a problem this protocol already solved. Adopting
it would re-import the transitive-replication cost (anti-entropy, dedup,
backfill, unbounded storage of others' words) that self-sufficiency was designed
to eliminate, and would re-introduce an attribution-verification seam (§3.6:
attribution verifies via "a node signed by P reachable from this node via the
seam edges" — a gossip relay's cached copy is an intermediary that seam has no
concept of). The access-policy mesh keeps the chain verifiable end-to-end.

**Amplification is citation, not replication.** When you want to amplify a
friend's work, you publish a `TraceOpinion` (provenance §5) with a high `alpha`
— a signed, per-author visibility weight — or you cite it in a composite trace
(§7) or tag it (§6). You do not re-broadcast their content. The relay stays a
dumb pipe (§5: "the relay stays a dumb pipe — operator-as-chief-curator means an
operator signing opinions under a known pubkey, never relay-side ranking"), and
your storage stays your own words only.

### Roles

| Pubkey | Connect | Read | Write |
|---|---|---|---|
| **Owner** (the manual/pen key) | always | ✅ own authored traces | ✅ |
| **Friend** (in the ACL) | allowed | ✅ read-only | ❌ |
| **Unknown** | challenged (NIP-42) | ❌ until authed | ❌ |

Friends are stored in a **private local ACL** (`~/.tracer/friends.json`), never
published as a Nostr event. The friend list is a security boundary, and a
security boundary must not be a public artifact. A public kind-3 contact list is
deferred as a *reader-side discovery feature* that never touches access control —
it answers "whose recent work do I want to see," a different question from "who
may connect to my relay."

### Super-peers

A **super-peer** is a durable, always-online relay that holds a replica of *your*
archive — your second copy for offline readability. It is not a discovery
platform and not a place you go to read the network. When a friend's desktop is
offline (laptop closed), their cited traces are still reachable from their
super-peer. Any NIP-01+NIP-33 relay suffices (provenance §10), including the
hosted docker-compose relay. Designating one as *your* super-peer is a config
choice (add it to your relay set with `write: true`); the existing `publishToMany`
fan-out already replicates every sealed trace there in parallel.

The `q`-tag relay hint (provenance §3.1, 3rd slot of the `e` tag) is the network
primitive: it carries the author's address. It can name the author's `.onion`
(direct, when their desktop is up) or their super-peer URL (durable). The reader
tries the onion, falls back to the super-peer. The degradation ladder is
expressible in a field that ships today.

## 3. Onion derivation scheme (normative)

The Tor v3 onion address is a deterministic, one-way function of the Nostr
secp256k1 secret. The seed holder reproduces the onion; an npub-holder cannot.

### 3.1 Derive the ed25519 seed

```
onionSeed = HKDF-SHA256(
  ikm   = secp256k1_secret,      // 32-byte Nostr private key
  salt  = "zine-onion-v1",       // 14 bytes, ASCII
  info  = "tor-ed25519-seed",    // 16 bytes, ASCII
  L     = 32,                    // output length
)
```

Per RFC 5869: PRK = HMAC-SHA256(salt, ikm); OKM = HMAC-SHA256(PRK, info || 0x01),
truncated to 32 bytes. `@noble/hashes/hkdf` implements this directly.

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

Per the [Tor v3 onion-service spec](https://gitweb.torproject.org/torspec.git/tree/rend-spec-v3.txt),
an onion address is the base32 encoding of a 35-byte payload:

```
[32 bytes: ed25519 pubkey] [2 bytes: checksum] [1 byte: version (0x03)]
```

where the checksum is:

```
checksum = SHA3-256(".onion checksum" || pubkey || version)[:2]
```

(`".onion checksum"` is the 15-byte ASCII literal, including the leading space
*after* "checksum"? No — it is the exact bytes `".onion checksum"` with a space
between "onion" and "checksum".)

The 35-byte payload is base32-encoded (RFC 4648, no padding), lowercase, and
the suffix `.onion` is appended, yielding a 56-character address + `.onion` =
62 characters total.

### 3.4 The key never touches disk

Tor's control-port `ADD_ONION` command accepts the key inline:

```
ADD_ONION ED25519-V3:<base64-of-32-byte-seed> Port=80,127.0.0.1:4869
```

The flow: the press derives the seed (pure crypto, §3.1) → passes it to the Tor
sidecar via the control port → Tor creates the onion service in memory → on next
launch, re-derived and re-registered. There is no `~/.tracer/onion-key` file. The
Nostr secret in the keychain is the single source; the onion is a projection of
it, not a sibling credential.

This is the property that makes identity portable across networks: the same
secret, on a new machine, reproduces the same identity *and* the same reachability.

## 4. The degradation ladder

| Rung | Transport | Identity | Reachability | Privacy |
|---|---|---|---|---|
| 1 (default) | Clearnet relay | npub (invariant) | requires IP/URL known | none |
| 2 | Tor onion service | npub (invariant) | stable .onion, inbound | metadata privacy |
| 3 | Super-peer replica | npub (invariant) | durable, always online | none (clearnet) |

Identity (the npub) is **invariant across all rungs** — the load-bearing fact.
If a corporate firewall drops Tor handshakes, the press falls back to rung 1 or
3 and *keeps its identity*; it loses metadata privacy (rung 1) or durability
(rung 3 vs. 2), not sovereignty. The trade is always reachability/privacy, never
identity. This is the honest reading of "stable across networks."

### Why Tor is the listener, not an IP-policy exception

Tor forwards inbound friend connections to the relay, and they appear to
originate from localhost. The relay cannot distinguish "the owner's own desktop
app" from "a friend arriving via Tor" by IP address. This is why access control
**must** be pubkey-based (NIP-42 AUTH), not IP-based: the IP-based trust model
the sidecar previously relied on (localhost = trusted) breaks entirely once Tor
is the listener. Everyone authenticates — including the owner.

## 5. Access control mechanics (NIP-42)

khatru cannot reject a WebSocket *connection* by pubkey — at connection-acceptance
time, the client's pubkey is unknown (it arrives later, via the NIP-42 AUTH
challenge/response). So the allowlist gates at the event/filter level, not the
connection level:

- **`RejectEvent`**: if `GetAuthed(ctx)` is not the owner → reject with
  `"auth-required: friends-only"` (the `"auth-required:"` prefix triggers khatru
  to send the AUTH challenge). Friends are read-only, so an authed friend's
  write attempt is rejected without the challenge prefix.
- **`RejectFilter` / `RejectCountFilter`**: if `GetAuthed(ctx)` is empty → reject
  with `"auth-required:"`. If authed as owner or friend → allow reads.

The owner is the manual (pen) key. `friends.json`'s `owner` field must match the
manual key's pubkey, or the owner cannot write to their own relay.

### What changed in the relay's security posture

The relay's prior header rationale (limiting connections is "pure friction" for a
localhost sidecar) inverts when the relay accepts inbound from friends. The
connection rate limiter is reinstated, and the friend ACL is a real security
boundary, not friction. This is the change from "embedded server for one" to
"actual server."

## Open questions

- **Outbound Tor reads.** Reading a friend's `.onion` from the browser requires a
  SOCKS-proxied WebSocket; the browser `WebSocket` API can't do SOCKS directly.
  First pass: Tor is inbound-only (friends reach you); outbound reads go via
  clearnet/super-peer. A Rust-side relay proxy or a WebSocket-to-SOCKS bridge is
  the later path.
- **Iroh/libp2p direct sync.** An optional P2P fast lane for when two presses are
  mutually online — a latency/privacy optimization, not a correctness
  requirement (self-sufficiency §R1 makes it unnecessary for correctness).
  Deferred.
- **Friend-list portability across devices.** The private local ACL is per-device.
  Multi-device sync of the friend list (not the key — that's NIP-46's job) is
  unsettled; a sealed trace on the owner's own relay is the likely vehicle.

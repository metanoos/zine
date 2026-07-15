/**
 * NIP-03 (OpenTimestamps) attestations for Step — distributed anteriority.
 * Anteriority (proof that a commitment existed *before* some Bitcoin block)
 * cannot be made self-sovereign: the author can't prove they didn't backdate
 * their own claim without a third party attesting to it. Everywhere else the
 * protocol's "asserted, cheaply checkable, degradable" posture suffices
 * because lineage/authorship/citation are recoverable from signed graph
 * structure; anteriority isn't, so it gets the trustless tool.
 *
 * The attestation is a strictly-additive overlay on Step, not a modification
 * to it. The Step node seals immediately; the kind-1040 event is published
 * later, in the background, when the OTS proof resolves. The Step stands on
 * its own either way; readers check the attestation or ignore it.
 *
 * We stamp the STEP node's id (the content checkpoint), because the power of
 * anteriority as a sybil filter is *density* — dozens of checkpoints provably
 * committed across weeks at human rhythms — and density requires the frequent
 * gesture to stamp. Step is frequent and time-distributed; an attest/publish
 * is rare. Stamping the rare gesture gives one anchor (useless as a process
 * signal); stamping Step builds the material the vet reads. See
 * `protocol/rendezvous.md` §3 and `trace-provenance.md` §R11.22.
 *
 * Affirm no longer stamps on its own behalf — its anteriority is inherited
 * transitively from the cited node (which was sealed by a Step, which stamps).
 * Affirm MAY keep its own stamp later for a distinct "when endorsed" claim;
 * that is not wired here.
 *
 * Hosted in Rust (stamp_ots / upgrade_ots commands) because the public OTS
 * calendars don't send CORS headers — a browser fetch dies. reqwest is already
 * a Tauri dep; the command shape mirrors llm_fetch. See src-tauri/src/lib.rs.
 */

import { finalizeEvent } from "nostr-tools/pure";
import type { EventTemplate } from "nostr-tools";

import {
  getReadRelays,
  getWriteRelays,
  publishToMany,
  queryMany,
} from "./provenance.js";
import { loadOrCreateVoice } from "./identity.js";

/** NIP-03: kind-1040 carries an OpenTimestamps proof for another event. */
const OTS_ATTESTATION_KIND = 1040;

/** Build a NIP-03 kind-1040 attestation template (pure — no IO, no signing).
 *
 *  Per NIP-03: `content` is the base64-encoded .ots proof; tags carry one `e`
 *  pointing at the attested event id with an optional relay hint. We omit the
 *  advisory `k` tag (the attested kind): NIP-03 lists it as optional, and the
 *  cited event's kind is self-describing once fetched.
 *
 *  `createdAtSec` is injected (not read from the clock) so this stays pure and
 *  unit-testable — the caller owns the wall-clock, the same way publishEdit
 *  computes its own `sealedAt`. */
export function buildAttestationTemplate(
  attestedId: string,
  proofB64: string,
  relayHint: string,
  createdAtSec: number,
): EventTemplate {
  return {
    kind: OTS_ATTESTATION_KIND,
    created_at: createdAtSec,
    tags: [["e", attestedId, relayHint]],
    content: proofB64,
  };
}

/** Stamp a sealed node against Bitcoin and publish the kind-1040 attestation.
 *
 *  Best-effort and fire-and-forget from the Step path: a calendar failure, a
 *  network drop, or a Tauri absence (browser dev mode) logs and exits — the
 *  Step node has already sealed by the time this runs, so the attestation layer
 *  failing can never block or corrupt the Step gesture. Mirrors the focus-buffer
 *  / workspace-push posture (`void … .catch(() => {})`).
 *
 *  `attestedId` is the sealed node's Nostr event id — already a 64-char SHA-256
 *  hex digest, which is exactly what the OTS calendar expects (no extra
 *  hashing).
 *
 *  The proof returned by the calendar is typically *partial* (proves
 *  submission, upgradeable to a full Bitcoin anchor once a block lands). We
 *  publish it immediately — a partial proof is a valid OTS state, and
 *  `upgradePendingAttestations` will republish an upgraded one later. */
export async function stampAndPublishAttestation(
  attestedId: string,
  signer: Uint8Array,
  relayHint: string,
): Promise<void> {
  // Nostr event ids are already SHA-256 (hex, 64 chars), which is exactly the
  // digest the OTS calendar expects — no extra hashing.
  let proofB64: string;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    proofB64 = await invoke<string>("stamp_ots", { digestHex: attestedId });
  } catch (e) {
    console.warn("[attestation] OTS stamp failed (node still sealed):", e);
    return;
  }

  const template = buildAttestationTemplate(
    attestedId,
    proofB64,
    relayHint,
    Math.floor(Date.now() / 1000),
  );
  const signed = finalizeEvent(template, signer);
  await publishToMany(await getWriteRelays(), signed);
}

/** Upgrade still-pending attestations and republish the upgraded proofs.
 *
 *  On a schedule (App.tsx polling) this sweeps our own kind-1040 events, asks
 *  the calendar to upgrade each partial proof, and — if the proof grew (a
 *  Bitcoin attestation landed) — publishes a new kind-1040 carrying the full
 *  proof. Kind 1040 is regular (non-replaceable), so an upgrade is a new
 *  event, not a replacement; readers take the longest proof they see.
 *
 *  Idempotent: a proof that's still pending (no growth) publishes nothing; a
 *  fully-upgraded proof that can't grow further is a no-op. Safe to call
 *  repeatedly. */
export async function upgradePendingAttestations(): Promise<void> {
  const pubkey = loadOrCreateVoice().publicKey;
  const relays = await getReadRelays();
  if (relays.length === 0) return;

  const ours = await queryMany(relays, {
    kinds: [OTS_ATTESTATION_KIND],
    authors: [pubkey],
  });

  const writeRelays = await getWriteRelays();
  if (writeRelays.length === 0) return;

  for (const ev of ours) {
    const proofB64 = ev.content;
    let upgraded: string | null;
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      upgraded = await invoke<string | null>("upgrade_ots", { proofB64 });
    } catch (e) {
      // Transport failure on one event shouldn't abort the sweep.
      console.warn("[attestation] OTS upgrade failed:", e);
      continue;
    }
    if (upgraded === null) continue; // still pending — try again next round

    // Republish with the same `e` target but the upgraded proof. created_at
    // advances so readers can order partial→full by recency.
    const relayHint = ev.tags.find((t) => t[0] === "e")?.[2] ?? "";
    const attestedId = ev.tags.find((t) => t[0] === "e")?.[1];
    if (!attestedId) continue;
    const template = buildAttestationTemplate(
      attestedId,
      upgraded,
      relayHint,
      Math.floor(Date.now() / 1000),
    );
    const signed = finalizeEvent(template, loadOrCreateVoice().secretKey);
    await publishToMany(writeRelays, signed);
  }
}

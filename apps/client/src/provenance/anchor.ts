/**
 * NIP-03 (OpenTimestamps) anchors for Step — optional anteriority evidence.
 * A completed proof establishes that a Step event id existed no later than a
 * Bitcoin attestation. It does not validate the event's own timestamp,
 * authorship, or humanness; readers treat absence as "unproven time."
 *
 * The anchor is a strictly-additive overlay on Step, not a modification
 * to it. The Step node steps immediately; the kind-1040 event is published
 * later, in the background, when the OTS proof resolves. The Step stands on
 * its own either way; readers check the anchor or ignore it.
 *
 * We stamp the STEP node's id because repeated commitments provide more
 * process evidence than one publish-time point. That raises the cost of an
 * instant fabricated history without making process evidence an identity
 * proof. See
 * `protocol/rendezvous.md` §3 and `trace-provenance.md` §R11.22.
 *
 * Attest no longer stamps on its own behalf. It inherits whatever anteriority
 * evidence exists on the cited Step; a target without an anchor remains valid
 * with unproven time. Attest MAY keep its own stamp later for a distinct "when
 * endorsed" claim; that is not wired here.
 *
 * Hosted in Rust (stamp_ots / upgrade_ots commands) because the public OTS
 * calendars don't send CORS headers — a browser fetch dies. reqwest is already
 * a Tauri dep; the command shape mirrors llm_fetch. See src-tauri/src/lib.rs.
 *
 * Naming: NIP-03 calls kind-1040 an "attestation," but the protocol gesture
 * owns that word now (attest = the publish act). The artifact is the `anchor`
 * — the noun/verb split `rendezvous.md` §R7 lands. Nostr-level vocabulary is
 * unchanged on the wire (still kind-1040); only our internal symbol changes.
 */

import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import type { EventTemplate } from "nostr-tools";

import { getWriteRelays, publishToMany } from "./provenance.js";
import { secretKeyForVoice } from "../identity/keys-store.js";

/** NIP-03: kind-1040 carries an OpenTimestamps proof for another event. */
const OTS_ANCHOR_KIND = 1040;
const TRACE_NODE_KIND = 4290;
const PENDING_ANCHORS_KEY = "zine.ots.pending.v1";

interface PendingAnchor {
  anchoredId: string;
  proofB64: string;
  relayHint: string;
  signerPubkey: string;
}

function loadPendingAnchors(): PendingAnchor[] {
  try {
    const value = JSON.parse(localStorage.getItem(PENDING_ANCHORS_KEY) ?? "[]");
    return Array.isArray(value) ? (value as PendingAnchor[]) : [];
  } catch {
    return [];
  }
}

function savePendingAnchors(anchors: PendingAnchor[]): void {
  localStorage.setItem(PENDING_ANCHORS_KEY, JSON.stringify(anchors));
}

function pendingKey(anchor: PendingAnchor): string {
  return `${anchor.signerPubkey}:${anchor.anchoredId}`;
}

/** Build a NIP-03 kind-1040 anchor template (pure — no IO, no signing).
 *
 *  Per NIP-03: `content` is the base64-encoded complete .ots proof; tags carry
 *  one `e` pointing at the anchored event id and a `k` naming its event kind.
 *
 *  `createdAtSec` is injected (not read from the clock) so this stays pure and
 *  unit-testable — the caller owns the wall-clock, the same way publishEdit
 *  computes its own `steppedAt`. */
export function buildAnchorTemplate(
  anchoredId: string,
  proofB64: string,
  relayHint: string,
  createdAtSec: number,
): EventTemplate {
  return {
    kind: OTS_ANCHOR_KIND,
    created_at: createdAtSec,
    tags: [
      ["e", anchoredId, relayHint],
      ["k", String(TRACE_NODE_KIND)],
    ],
    content: proofB64,
  };
}

/** Submit a stepped node to OTS and retain its pending receipt locally.
 *
 *  Best-effort and fire-and-forget from the Step path: a calendar failure, a
 *  network drop, or a Tauri absence (browser dev mode) logs and exits — the
 *  Step node has already stepped by the time this runs, so the anchor layer
 *  failing can never block or corrupt the Step gesture. Mirrors the focus-buffer
 *  / workspace-push posture (`void … .catch(() => {})`).
 *
 *  `anchoredId` is the stepped node's Nostr event id — already a 64-char SHA-256
 *  hex digest, which is exactly what the OTS calendar expects (no extra
 *  hashing).
 *
 *  The proof returned by the calendar is typically pending. That is valid OTS
 *  working state but is not a valid NIP-03 event: NIP-03 requires at least one
 *  Bitcoin attestation and no pending attestations. `upgradePendingAnchors`
 *  publishes only after the calendar returns a completed proof. */
export async function submitAnchor(
  anchoredId: string,
  signer: Uint8Array,
  relayHint: string,
): Promise<void> {
  // Nostr event ids are already SHA-256 (hex, 64 chars), which is exactly the
  // digest the OTS calendar expects — no extra hashing.
  let proofB64: string;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    proofB64 = await invoke<string>("stamp_ots", { digestHex: anchoredId });
  } catch (e) {
    console.warn("[anchor] OTS stamp failed (node still stepped):", e);
    return;
  }

  const pending = loadPendingAnchors();
  const next: PendingAnchor = {
    anchoredId,
    proofB64,
    relayHint,
    signerPubkey: getPublicKey(signer),
  };
  const existing = pending.findIndex(
    (item) =>
      item.anchoredId === next.anchoredId &&
      item.signerPubkey === next.signerPubkey,
  );
  if (existing >= 0) pending[existing] = next;
  else pending.push(next);
  savePendingAnchors(pending);
}

/** Upgrade locally pending receipts and publish completed NIP-03 proofs.
 *
 *  On a schedule (App.tsx polling) this sweeps local receipts, asks the
 *  calendar to upgrade each one, and — if a Bitcoin anchor landed — publishes
 *  one new kind-1040 carrying the full proof. No pending kind-1040 event is
 *  emitted, so there is nothing on Nostr to replace or "upgrade in place."
 *
 *  Idempotent: a proof that's still pending (no growth) publishes nothing; a
 *  fully-upgraded proof that can't grow further is a no-op. Safe to call
 *  repeatedly. */
export async function upgradePendingAnchors(): Promise<void> {
  const pending = loadPendingAnchors();
  if (pending.length === 0) return;
  const sweptKeys = new Set(pending.map(pendingKey));
  const writeRelays = await getWriteRelays();
  if (writeRelays.length === 0) return;

  const remaining: PendingAnchor[] = [];
  for (const item of pending) {
    let upgraded: string | null;
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      upgraded = await invoke<string | null>("upgrade_ots", {
        proofB64: item.proofB64,
      });
    } catch (e) {
      // Transport failure on one event shouldn't abort the sweep.
      console.warn("[anchor] OTS upgrade failed:", e);
      remaining.push(item);
      continue;
    }
    if (upgraded === null) {
      remaining.push(item); // still pending — try again next round
      continue;
    }

    const signer = secretKeyForVoice(item.signerPubkey);
    if (!signer) {
      // Keep the receipt: the key may be restored or re-imported later.
      remaining.push(item);
      continue;
    }
    const template = buildAnchorTemplate(
      item.anchoredId,
      upgraded,
      item.relayHint,
      Math.floor(Date.now() / 1000),
    );
    const signed = finalizeEvent(template, signer);
    try {
      await publishToMany(writeRelays, signed);
    } catch (e) {
      console.warn("[anchor] completed proof publish failed:", e);
      remaining.push(item);
    }
  }
  // `submitAnchor` can add a different receipt while this async sweep is in
  // flight. Merge those late arrivals back instead of overwriting the queue
  // with the sweep's older snapshot.
  const lateArrivals = loadPendingAnchors().filter(
    (item) => !sweptKeys.has(pendingKey(item)),
  );
  savePendingAnchors([...remaining, ...lateArrivals]);
}

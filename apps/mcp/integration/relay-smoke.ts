import assert from "node:assert/strict";
import type { KEdit } from "../../client/src/provenance/provenance.js";

import { installNodeStorage } from "../src/storage-node.js";
import { setHomeRelay } from "../src/relay-config-override.js";

const homeRelay = process.env.ZINE_TEST_HOME_RELAY_URL;
const externalRelay = process.env.ZINE_TEST_EXTERNAL_RELAY_URL;
const configPath = process.env.ZINE_TEST_CONFIG_PATH;
const expectedAgent = process.env.ZINE_TEST_AGENT_PUBKEY;
const expectedRelayOwner = process.env.ZINE_TEST_RELAY_OWNER_PUBKEY;
const relayOwnerSecretHex = process.env.ZINE_TEST_RELAY_OWNER_SECRET_HEX;

if (!homeRelay || !configPath || !expectedAgent || !expectedRelayOwner || !relayOwnerSecretHex) {
  throw new Error(
    "relay smoke requires ZINE_TEST_HOME_RELAY_URL, ZINE_TEST_CONFIG_PATH, " +
      "ZINE_TEST_AGENT_PUBKEY, ZINE_TEST_RELAY_OWNER_PUBKEY, and " +
      "ZINE_TEST_RELAY_OWNER_SECRET_HEX",
  );
}
const homeRelayUrl = homeRelay;
const ownerSecretHex = relayOwnerSecretHex;

installNodeStorage(configPath);
setHomeRelay(homeRelayUrl);

async function main(): Promise<void> {
  // Dynamic imports are load-bearing: relay URL and localStorage must be
  // installed before the shared browser modules evaluate under Node.
  const { loadOrCreateVoice } = await import("../../client/src/identity/identity.js");
  const { nodeVoice } = await import("../../client/src/identity/keys-store.js");
  const { initializeMcpKeySession } = await import("../src/tools.js");
  const { replaceExternalRelays } = await import("../../client/src/networking/relay-config.js");
  const {
    attestNode,
    coinOriginFromEvent,
    diffToDeltas,
    eventMeta,
    fetchAttestationCounts,
    fetchChain,
    fetchEventById,
    fetchManifest,
    flushLocalEventOutbox,
    publishEdit,
    publishDirectCoin,
    publishHardenedSpan,
    sendStep,
    sha256HexLocal,
    upsertManifestEntry,
  } = await import("../../client/src/provenance/provenance.js");
  const {
    enqueueLocalEvent,
    pendingLocalEventCount,
  } = await import("../../client/src/provenance/event-outbox.js");
  const { resolveFolderBinding, resolveWorkspaceBinding } = await import("../src/folder-binding.js");
  const { finalizeEvent, getPublicKey, verifyEvent } = await import("nostr-tools/pure");
  const { Relay } = await import("nostr-tools/relay");
  const {
    synthesizeKEditTransition,
    validateKEditTransition,
  } = await import("../../client/src/workspace/workspace-core.js");

  const voice = loadOrCreateVoice();
  await initializeMcpKeySession(voice);
  assert.equal(voice.publicKey, expectedAgent, "seeded agent key changed");
  assert.equal(nodeVoice(), expectedAgent, "NODE role must authenticate as the authorized writer");
  assert.notEqual(voice.publicKey, expectedRelayOwner, "agent must be distinct from relay owner");
  replaceExternalRelays(externalRelay ? [externalRelay] : []);

  // A normal headless boot needs no desktop folder id. It owns one permanent,
  // pathless Root per persisted profile and reuses it on restart.
  const automaticRoot = await resolveWorkspaceBinding(undefined, voice.publicKey, voice.secretKey);
  assert.equal(automaticRoot.forked, false);
  assert.equal(automaticRoot.reused, false);
  const reopenedRoot = await resolveWorkspaceBinding(undefined, voice.publicKey, voice.secretKey);
  assert.equal(reopenedRoot.folderId, automaticRoot.folderId);
  assert.equal(reopenedRoot.reused, true);

  // Exercise the delayed-delivery path independently of the normal online
  // publisher: an exact signed event already in the durable outbox must be
  // flushed unchanged and then become queryable from the real home relay.
  const queuedSnapshot = "durable outbox relay probe\n";
  const queuedHash = await sha256HexLocal(queuedSnapshot);
  const queuedAt = Date.now();
  const queuedProbe = finalizeEvent({
    kind: 4290,
    created_at: Math.floor(queuedAt / 1_000),
    tags: [
      ["z", "file"],
      ["F", "outbox-probe.md"],
      ["f", automaticRoot.folderId],
      ["action", "import"],
      ["x", queuedHash],
    ],
    content: JSON.stringify({
      steppedAt: queuedAt,
      snapshot: queuedSnapshot,
      contentHash: queuedHash,
      deltas: diffToDeltas("", queuedSnapshot),
    }),
  }, voice.secretKey);
  enqueueLocalEvent(queuedProbe);
  assert.equal(pendingLocalEventCount(), 1);
  const flushed = await flushLocalEventOutbox();
  assert.equal(flushed.published, 1);
  assert.equal(flushed.pending, 0);
  assert.equal((await fetchEventById(queuedProbe.id))?.id, queuedProbe.id);

  // Seed a human/relay-owner folder, then exercise the MCP onboarding rule:
  // the distinct agent must create and persist its own shallow folder fork.
  const ownerSecret = Uint8Array.from(Buffer.from(ownerSecretHex, "hex"));
  assert.equal(getPublicKey(ownerSecret), expectedRelayOwner, "relay owner secret changed");
  const steppedAt = Date.now();
  const emptyFolderHash = await sha256HexLocal(JSON.stringify([]));
  const sourceFolder = finalizeEvent({
    kind: 4290,
    created_at: Math.floor(steppedAt / 1000),
    tags: [["z", "folder"], ["action", "import"], ["x", emptyFolderHash]],
    content: JSON.stringify({
      steppedAt,
      snapshot: { members: [] },
      contentHash: emptyFolderHash,
    }),
  }, ownerSecret);
  const ownerRelay = new Relay(homeRelayUrl);
  ownerRelay.onauth = async (template) => finalizeEvent(template, ownerSecret) as never;
  await ownerRelay.connect();
  try {
    await ownerRelay.publish(sourceFolder);
  } catch (error) {
    if (!String(error).includes("auth-required") || !ownerRelay.onauth) throw error;
    await ownerRelay.auth(ownerRelay.onauth);
    await ownerRelay.publish(sourceFolder);
  }
  const ownerCanReadSource = await new Promise<boolean>((resolve) => {
    let found = false;
    const sub = ownerRelay.subscribe([{ ids: [sourceFolder.id] }], {
      onevent: () => {
        found = true;
      },
      oneose: () => sub.close(),
    });
    const timer = setTimeout(() => sub.close("timeout"), 4_000);
    sub.onclose = () => {
      clearTimeout(timer);
      resolve(found);
    };
  });
  ownerRelay.close();
  assert.equal(ownerCanReadSource, true, "owner folder genesis was not durably queryable");

  const binding = await resolveFolderBinding(sourceFolder.id, voice.publicKey, voice.secretKey);
  assert.equal(binding.forked, true, "foreign source folder must fork");
  assert.equal(binding.reused, false, "first bind must create the fork");
  assert.notEqual(binding.folderId, sourceFolder.id, "agent must not extend the source folder id");
  const rebound = await resolveFolderBinding(sourceFolder.id, voice.publicKey, voice.secretKey);
  assert.equal(rebound.folderId, binding.folderId, "source→fork binding must persist");
  assert.equal(rebound.reused, true, "second bind must reuse the persisted fork");
  const forkEvent = await fetchEventById(binding.folderId);
  assert.equal(forkEvent?.pubkey, expectedAgent, "folder fork must be owned by the agent");
  assert.ok(
    forkEvent?.tags.some((tag) => tag[0] === "e" && tag[1] === sourceFolder.id && tag[3] === "forked-from"),
    "folder fork must preserve its source lineage",
  );

  const folderId = binding.folderId;
  assert.match(folderId, /^[0-9a-f]{64}$/);

  const path = "smoke.md";
  const firstText = "hello relay";
  const firstHash = await sha256HexLocal(firstText);
  const first = await publishEdit({
    prevEventId: null,
    previousSnapshot: "",
    relativePath: path,
    folderId,
    deltas: diffToDeltas("", firstText),
    snapshot: firstText,
    contentHash: firstHash,
    action: "import",
    signer: voice.secretKey,
    localOnly: true,
    kedits: synthesizeKEditTransition("", firstText, voice.publicKey),
  });
  assert.equal(verifyEvent(first), true, "first Step signature is invalid");
  const firstPayload = JSON.parse(first.content) as { kedits?: unknown };
  assert.ok(Array.isArray(firstPayload.kedits), "first Step is missing required KEdits");
  assert.equal(
    validateKEditTransition("", firstText, firstPayload.kedits as KEdit[]).valid,
    true,
    "first Step KEdits do not reproduce its snapshot",
  );
  assert.equal(first.pubkey, expectedAgent, "Step must be owned by the agent voice");
  await upsertManifestEntry(folderId, {
    kind: "file",
    relativePath: path,
    latestNodeId: first.id,
    contentHash: firstHash,
  }, voice.secretKey, { localOnly: true });

  const firstManifest = await fetchManifest(folderId);
  assert.deepEqual(firstManifest.map((entry) => entry.relativePath), [path]);
  assert.equal(firstManifest[0]?.latestNodeId, first.id);

  let attestationId: string | null = null;
  if (externalRelay) {
    await assert.rejects(
      () => attestNode(first.id, voice.publicKey, { signer: voice.secretKey }),
      /Send it first/,
      "a home-only Step must not be attestable",
    );
    await sendStep(first, voice.secretKey);
    const attestation = await attestNode(first.id, voice.publicKey, {
      signer: voice.secretKey,
      message: "real-relay smoke",
    });
    assert.equal(verifyEvent(attestation), true, "Attest signature is invalid");
    attestationId = attestation.id;
  } else {
    await sendStep(first, voice.secretKey);
  }

  const secondText = "hello signed relay";
  const secondHash = await sha256HexLocal(secondText);
  const second = await publishEdit({
    prevEventId: first.id,
    previousSnapshot: firstText,
    traceId: first.id,
    relativePath: path,
    folderId,
    deltas: diffToDeltas(firstText, secondText),
    snapshot: secondText,
    contentHash: secondHash,
    action: "edit",
    signer: voice.secretKey,
    localOnly: true,
    kedits: synthesizeKEditTransition(firstText, secondText, voice.publicKey),
  });
  assert.equal(verifyEvent(second), true, "second Step signature is invalid");
  const secondPayload = JSON.parse(second.content) as { kedits?: unknown };
  assert.ok(Array.isArray(secondPayload.kedits), "second Step is missing required KEdits");
  assert.equal(
    validateKEditTransition(firstText, secondText, secondPayload.kedits as KEdit[]).valid,
    true,
    "second Step KEdits do not reproduce its snapshot",
  );
  assert.ok(second.tags.some((tag) => tag[0] === "e" && tag[1] === first.id && tag[3] === "prev"));
  await sendStep(second, voice.secretKey);
  await sendStep(second, voice.secretKey); // idempotent resend

  const coin = await publishHardenedSpan({
    folderId,
    relativePath: "2026-07-15-relay.md",
    phrase: "signed relay",
    originNodeId: second.id,
    sourceContentHash: secondHash,
    sourceRange: {
      start: secondText.indexOf("signed relay"),
      end: secondText.indexOf("signed relay") + "signed relay".length,
    },
    signer: voice.secretKey,
    localOnly: true,
  });
  assert.equal(verifyEvent(coin), true, "Mint signature is invalid");
  assert.ok(coin.tags.some((tag) => tag[0] === "x"), "Mint is missing its body hash");
  assert.ok(coin.tags.some((tag) => tag[0] === "e" && tag[1] === second.id && tag[3] === "extracted-from"));

  const directPhrase = "written directly in Mint";
  const directCoin = await publishDirectCoin({
    folderId,
    relativePath: "2026-07-15-direct.md",
    phrase: directPhrase,
    signer: voice.secretKey,
    kedits: [{
      op: "ins",
      from: 0,
      to: 0,
      text: directPhrase,
      voice: voice.publicKey,
      t: Date.now(),
      tx: 0,
    }],
    localOnly: true,
  });
  assert.equal(verifyEvent(directCoin), true, "direct Coin signature is invalid");
  assert.deepEqual(coinOriginFromEvent(directCoin), { kind: "direct" });
  assert.ok(directCoin.tags.some((tag) => tag[0] === "x"), "direct Coin is missing its body hash");
  assert.equal(
    directCoin.tags.some((tag) => tag[0] === "e" && tag[3] === "extracted-from"),
    false,
    "direct Coin must not claim an extraction source",
  );
  await sendStep(directCoin, voice.secretKey);
  assert.equal((await fetchEventById(directCoin.id))?.id, directCoin.id);

  const thirdText = `${secondText}\n\n[[ signed relay | ${coin.id} ]]`;
  const thirdHash = await sha256HexLocal(thirdText);
  const third = await publishEdit({
    prevEventId: second.id,
    previousSnapshot: secondText,
    traceId: first.id,
    relativePath: path,
    folderId,
    deltas: diffToDeltas(secondText, thirdText),
    snapshot: thirdText,
    contentHash: thirdHash,
    action: "cite",
    citations: [coin.id],
    signer: voice.secretKey,
    localOnly: true,
    kedits: synthesizeKEditTransition(secondText, thirdText, voice.publicKey),
  });
  assert.ok(eventMeta(third).citationTargets.includes(coin.id), "Cite target is missing");
  const thirdPayload = JSON.parse(third.content) as { kedits?: unknown };
  assert.ok(Array.isArray(thirdPayload.kedits), "Cite Step is missing required KEdits");
  assert.equal(
    validateKEditTransition(secondText, thirdText, thirdPayload.kedits as KEdit[]).valid,
    true,
    "Cite Step KEdits do not reproduce its snapshot",
  );
  assert.equal(verifyEvent(third), true, "Cite Step signature is invalid");
  await sendStep(third, voice.secretKey);
  await upsertManifestEntry(folderId, {
    kind: "file",
    relativePath: path,
    latestNodeId: third.id,
    contentHash: thirdHash,
  }, voice.secretKey, { localOnly: true });

  const chain = await fetchChain(folderId, path);
  assert.deepEqual(chain.map((event) => event.id), [first.id, second.id, third.id]);
  const currentManifest = await fetchManifest(folderId);
  assert.equal(currentManifest[0]?.latestNodeId, third.id);
  assert.equal(currentManifest[0]?.contentHash, thirdHash);

  if (externalRelay) {
    const counts = await fetchAttestationCounts([first.id]);
    assert.equal(counts.get(first.id), 1, "Attest was not durably queryable");
  }

  process.stdout.write(`${JSON.stringify({
    ok: true,
    sourceFolderId: sourceFolder.id,
    automaticRootId: automaticRoot.folderId,
    folderId,
    steps: chain.length,
    attestationId,
    coinId: coin.id,
    directCoinId: directCoin.id,
    externalRelayExercised: Boolean(externalRelay),
  })}\n`);
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
  },
);

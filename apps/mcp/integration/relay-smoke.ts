import assert from "node:assert/strict";

import { installNodeStorage } from "../src/storage-node.js";
import { installNodeWebSocket } from "../src/websocket-node.js";
import { setHomeRelay } from "../src/relay-config-override.js";

const homeRelay = process.env.ZINE_TEST_HOME_RELAY_URL;
const externalRelay = process.env.ZINE_TEST_EXTERNAL_RELAY_URL;
const configPath = process.env.ZINE_TEST_CONFIG_PATH;
const expectedOwner = process.env.ZINE_TEST_OWNER_PUBKEY;

if (!homeRelay || !configPath || !expectedOwner) {
  throw new Error("relay smoke requires ZINE_TEST_HOME_RELAY_URL, ZINE_TEST_CONFIG_PATH, and ZINE_TEST_OWNER_PUBKEY");
}

installNodeStorage(configPath);
installNodeWebSocket();
setHomeRelay(homeRelay);

async function main(): Promise<void> {
  // Dynamic imports are load-bearing: relay URL and localStorage must be
  // installed before the shared browser modules evaluate under Node.
  const { loadOrCreateVoice } = await import("../../client/src/identity.js");
  const { nodeVoice } = await import("../../client/src/keys-store.js");
  const { addRelay } = await import("../../client/src/relay-config.js");
  const {
    attestNode,
    createFolderGenesis,
    diffToDeltas,
    eventMeta,
    fetchAttestationCounts,
    fetchChain,
    fetchManifest,
    publishEdit,
    publishHardenedSpan,
    sendStep,
    sha256HexLocal,
    upsertManifestEntry,
  } = await import("../../client/src/provenance.js");
  const { verifyEvent } = await import("nostr-tools/pure");

  const voice = loadOrCreateVoice();
  assert.equal(voice.publicKey, expectedOwner, "seeded author key changed");
  assert.equal(nodeVoice(), expectedOwner, "NODE role must authenticate as relay owner");
  if (externalRelay) addRelay(externalRelay);

  const folderId = await createFolderGenesis({ signer: voice.secretKey, localOnly: true });
  assert.match(folderId, /^[0-9a-f]{64}$/);

  const path = "smoke.md";
  const firstText = "hello relay";
  const firstHash = await sha256HexLocal(firstText);
  const first = await publishEdit({
    prevEventId: null,
    relativePath: path,
    folderId,
    deltas: diffToDeltas("", firstText),
    snapshot: firstText,
    contentHash: firstHash,
    action: "import",
    signer: voice.secretKey,
    localOnly: true,
  });
  assert.equal(verifyEvent(first), true, "first Step signature is invalid");
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
    traceId: first.id,
    relativePath: path,
    folderId,
    deltas: diffToDeltas(firstText, secondText),
    snapshot: secondText,
    contentHash: secondHash,
    action: "edit",
    signer: voice.secretKey,
    localOnly: true,
  });
  assert.equal(verifyEvent(second), true, "second Step signature is invalid");
  assert.ok(second.tags.some((tag) => tag[0] === "e" && tag[1] === first.id && tag[3] === "prev"));
  await sendStep(second, voice.secretKey);
  await sendStep(second, voice.secretKey); // idempotent resend

  const coin = await publishHardenedSpan({
    folderId,
    relativePath: "2026-07-15-relay.md",
    phrase: "signed relay",
    originNodeId: second.id,
    signer: voice.secretKey,
    localOnly: true,
  });
  assert.equal(verifyEvent(coin), true, "Mint signature is invalid");
  assert.ok(coin.tags.some((tag) => tag[0] === "x"), "Mint is missing its body hash");
  assert.ok(coin.tags.some((tag) => tag[0] === "e" && tag[1] === second.id && tag[3] === "extracted-from"));

  const thirdText = `${secondText}\n\n[[ signed relay | ${coin.id} ]]`;
  const thirdHash = await sha256HexLocal(thirdText);
  const third = await publishEdit({
    prevEventId: second.id,
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
  });
  assert.ok(eventMeta(third).citationTargets.includes(coin.id), "Cite target is missing");
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
    folderId,
    steps: chain.length,
    attestationId,
    coinId: coin.id,
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

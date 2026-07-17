import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { KEdit } from "@zine/protocol";
import type { Event, Filter } from "nostr-tools";

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
const stateConfigPath = configPath;

installNodeStorage(stateConfigPath);
setHomeRelay(homeRelayUrl);

function jsonToolResult(result: unknown): Record<string, unknown> {
  const content = (result as { content?: unknown }).content;
  assert.ok(Array.isArray(content), "tool returned no content array");
  const block = content.find(
    (item: unknown): item is { type: "text"; text: string } =>
      !!item && typeof item === "object" &&
      (item as { type?: unknown }).type === "text" &&
      typeof (item as { text?: unknown }).text === "string",
  );
  assert.ok(block, "tool returned no JSON text block");
  return JSON.parse(block.text) as Record<string, unknown>;
}

function canonicalEvent(event: Event): Event {
  return JSON.parse(JSON.stringify(event)) as Event;
}

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
    pendingLocalEventCount,
    pendingLocalEvents,
  } = await import("../../client/src/provenance/event-outbox.js");
  const { resolveFolderBinding, resolveWorkspaceBinding } = await import("../src/folder-binding.js");
  const { finalizeEvent, getPublicKey, verifyEvent } = await import("nostr-tools/pure");
  const { Relay } = await import("nostr-tools/relay");
  const {
    synthesizeKEditTransition,
    validateKEditTransition,
  } = await import("@zine/protocol");

  const queryRelay = async (
    url: string,
    filter: Filter,
    signer: Uint8Array,
  ): Promise<Event[]> => {
    const relay = new Relay(url);
    relay.onauth = async (template) => finalizeEvent(template, signer) as never;
    await relay.connect();
    try {
      const attempt = () => new Promise<{ events: Event[]; closeReason: string }>((resolve) => {
        const events: Event[] = [];
        const sub = relay.subscribe([filter], {
          onevent: (event) => events.push(canonicalEvent(event)),
          oneose: () => sub.close(),
        });
        const timer = setTimeout(() => sub.close("timeout"), 4_000);
        sub.onclose = (reason) => {
          clearTimeout(timer);
          resolve({ events, closeReason: reason });
        };
      });
      const first = await attempt();
      if (!first.closeReason.startsWith("auth-required:") || !relay.onauth) {
        return first.events;
      }
      for (let retry = 0; retry < 5; retry += 1) {
        try {
          await relay.auth(relay.onauth);
          return (await attempt()).events;
        } catch (error) {
          if (!String(error).includes("no challenge was received")) throw error;
          await new Promise((resolve) => setTimeout(resolve, 25 * (retry + 1)));
        }
      }
      throw new Error(`relay authentication did not complete for ${url}`);
    } finally {
      relay.close();
    }
  };

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

  // Take a real file Step while home is unavailable. The publisher must first
  // retain the finalized event locally, then a later flush must deliver those
  // byte-identical signed fields rather than regenerate another event.
  const queuedSnapshots = [
    "durable outbox relay probe\n",
    "durable outbox relay probe, second exact Step\n",
  ];
  const queuedHash = await sha256HexLocal(queuedSnapshots[0]!);
  setHomeRelay("ws://127.0.0.1:1");
  const queuedGenesis = await publishEdit({
    prevEventId: null,
    previousSnapshot: "",
    relativePath: "outbox-probe.md",
    folderId: automaticRoot.folderId,
    deltas: diffToDeltas("", queuedSnapshots[0]!),
    snapshot: queuedSnapshots[0]!,
    contentHash: queuedHash,
    action: "import",
    signer: voice.secretKey,
    localOnly: true,
    kedits: synthesizeKEditTransition("", queuedSnapshots[0]!, voice.publicKey),
  });
  const queuedSecondHash = await sha256HexLocal(queuedSnapshots[1]!);
  const queuedSecond = await publishEdit({
    prevEventId: queuedGenesis.id,
    previousSnapshot: queuedSnapshots[0]!,
    traceId: queuedGenesis.id,
    relativePath: "outbox-probe.md",
    folderId: automaticRoot.folderId,
    deltas: diffToDeltas(queuedSnapshots[0]!, queuedSnapshots[1]!),
    snapshot: queuedSnapshots[1]!,
    contentHash: queuedSecondHash,
    action: "edit",
    signer: voice.secretKey,
    localOnly: true,
    kedits: synthesizeKEditTransition(queuedSnapshots[0]!, queuedSnapshots[1]!, voice.publicKey),
  });
  const queuedEvents = [queuedGenesis, queuedSecond].map(canonicalEvent);
  assert.equal(pendingLocalEventCount(), 2);
  assert.deepEqual(
    pendingLocalEvents().map((record) => canonicalEvent(record.event)),
    queuedEvents,
    "offline outbox changed signed bytes or insertion order",
  );
  setHomeRelay(homeRelayUrl);
  const flushed = await flushLocalEventOutbox();
  assert.equal(flushed.published, 2);
  assert.equal(flushed.pending, 0);
  const flushedEvents = await queryRelay(
    homeRelayUrl,
    { ids: queuedEvents.map((event) => event.id) },
    voice.secretKey,
  );
  const flushedById = new Map(flushedEvents.map((event) => [event.id, event]));
  assert.deepEqual(
    queuedEvents.map((event) => flushedById.get(event.id)),
    queuedEvents,
    "home relay did not receive the exact queued signed events",
  );
  assert.deepEqual(
    (await fetchChain(automaticRoot.folderId, "outbox-probe.md")).map((event) => event.id),
    queuedEvents.map((event) => event.id),
    "home relay did not preserve the queued prev-chain order",
  );

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
    // Drive the actual stdio MCP surface against both real relays. Two private
    // Steps establish ancestry; changed-state Send must append one valid Step,
    // return its exact locator, and publish only that immutable node.
    const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
    const tsx = join(packageRoot, "node_modules", ".bin", "tsx");
    const serverConfig = `${stateConfigPath}.stdio-server`;
    writeFileSync(serverConfig, JSON.stringify({
      "zine.headless.voice.secretHex": Buffer.from(voice.secretKey).toString("hex"),
    }), { mode: 0o600 });
    const serverEnv = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    );
    serverEnv.HOME = dirname(stateConfigPath);
    const transport = new StdioClientTransport({
      command: tsx,
      args: [
        join(packageRoot, "src", "server.ts"),
        "--profile",
        "relay-contract",
        "--home-relay",
        homeRelayUrl,
        "--publish-relay",
        externalRelay,
        "--config",
        serverConfig,
      ],
      env: serverEnv,
      stderr: "pipe",
    });
    const client = new Client({ name: "zine-relay-contract", version: "1.0.0" });
    await client.connect(transport);
    try {
      const info = jsonToolResult(await client.callTool({
        name: "zine_workspace_info",
        arguments: {},
      }));
      const exactRootId = String(info.rootId);
      assert.match(exactRootId, /^[0-9a-f]{64}$/);
      assert.equal(info.ownerPubkey, voice.publicKey);

      const exactPath = "exact-handoff.md";
      const exactSnapshots = [
        "private genesis\n",
        "private follow-up\n",
        "selected public handoff\n",
      ];
      const privateGenesis = jsonToolResult(await client.callTool({
        name: "zine_step",
        arguments: { relativePath: exactPath, content: exactSnapshots[0] },
      }));
      const privateFollowUp = jsonToolResult(await client.callTool({
        name: "zine_step",
        arguments: { relativePath: exactPath, content: exactSnapshots[1] },
      }));
      const sent = jsonToolResult(await client.callTool({
        name: "zine_send",
        arguments: { relativePath: exactPath, content: exactSnapshots[2] },
      }));
      const exactNodeIds = [
        String(privateGenesis.nodeId),
        String(privateFollowUp.nodeId),
        String(sent.nodeId),
      ];
      assert.equal(new Set(exactNodeIds).size, 3);
      assert.equal(sent.sent, true);

      const resent = jsonToolResult(await client.callTool({
        name: "zine_send",
        arguments: { relativePath: exactPath, content: exactSnapshots[2] },
      }));
      assert.equal(resent.nodeId, sent.nodeId, "unchanged Send must reuse the selected Step");

      const history = jsonToolResult(await client.callTool({
        name: "zine_get_history",
        arguments: { relativePath: exactPath },
      }));
      assert.equal((history.conformance as { status?: string }).status, "full");
      const rows = history.history as Array<{
        nodeId: string;
        payload: { snapshot?: string; kedits?: KEdit[] };
        event: Event;
      }>;
      assert.deepEqual(rows.map((row) => row.nodeId), exactNodeIds);
      let priorSnapshot = "";
      for (let index = 0; index < rows.length; index += 1) {
        const row = rows[index]!;
        const snapshot = exactSnapshots[index]!;
        assert.equal(row.payload.snapshot, snapshot);
        assert.ok(Array.isArray(row.payload.kedits));
        assert.equal(
          validateKEditTransition(priorSnapshot, snapshot, row.payload.kedits!).valid,
          true,
        );
        assert.equal(row.payload.kedits!.length, 1, "each changed MCP write is one KEdit");
        assert.equal(row.payload.kedits![0]!.voice, voice.publicKey);
        assert.equal(verifyEvent(canonicalEvent(row.event)), true);
        priorSnapshot = snapshot;
      }

      const node = jsonToolResult(await client.callTool({
        name: "zine_get_node",
        arguments: { nodeId: sent.nodeId },
      }));
      assert.equal(node.nodeId, sent.nodeId);
      assert.deepEqual(node.event, canonicalEvent(rows[2]!.event));
      assert.equal((node.conformance as { status?: string }).status, "full");
      assert.equal(node.historyComplete, true);

      const handoff = jsonToolResult(await client.callTool({
        name: "zine_get_handoff",
        arguments: { relativePath: exactPath },
      }));
      assert.equal(handoff.sent, true);
      assert.deepEqual(handoff.locator, sent.locator);
      assert.equal(handoff.encoded, sent.encoded);
      const locator = handoff.locator as Record<string, unknown>;
      assert.equal(locator.rootId, exactRootId);
      assert.equal(locator.traceId, exactNodeIds[0]);
      assert.equal(locator.nodeId, exactNodeIds[2]);
      assert.equal(locator.relativePath, exactPath);
      assert.equal(locator.ownerPubkey, voice.publicKey);

      const externallyVisible = await queryRelay(
        externalRelay,
        { ids: exactNodeIds },
        voice.secretKey,
      );
      assert.deepEqual(
        externallyVisible.map((event) => event.id),
        [exactNodeIds[2]],
        "Send leaked private ancestry to the publication relay",
      );
      assert.deepEqual(externallyVisible[0], node.event);
      const rootScoped = await queryRelay(
        externalRelay,
        { kinds: [4290], "#f": [exactRootId] },
        voice.secretKey,
      );
      assert.deepEqual(
        rootScoped.map((event) => event.id),
        [exactNodeIds[2]],
        "Send published another Root member or folder artifact",
      );
      const externalHeads = await queryRelay(
        externalRelay,
        { kinds: [34290], "#d": [exactNodeIds[0]!] },
        voice.secretKey,
      );
      assert.deepEqual(externalHeads, [], "MCP Send must not publish mutable TraceHead metadata");
    } finally {
      await client.close();
      await transport.close();
    }

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

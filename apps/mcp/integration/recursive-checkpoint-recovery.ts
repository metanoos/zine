import assert from "node:assert/strict";
import type { Event } from "nostr-tools";

import { installNodeStorage } from "../src/storage-node.js";
import { setHomeRelay } from "../src/relay-config-override.js";

const homeRelay = process.env.ZINE_TEST_HOME_RELAY_URL;
const configPath = process.env.ZINE_TEST_CONFIG_PATH;
const relayOwnerSecretHex = process.env.ZINE_TEST_RELAY_OWNER_SECRET_HEX;
const expectedRelayOwner = process.env.ZINE_TEST_RELAY_OWNER_PUBKEY;

if (!homeRelay || !configPath || !relayOwnerSecretHex || !expectedRelayOwner) {
  throw new Error(
    "recursive recovery requires ZINE_TEST_HOME_RELAY_URL, ZINE_TEST_CONFIG_PATH, " +
      "ZINE_TEST_RELAY_OWNER_SECRET_HEX, and ZINE_TEST_RELAY_OWNER_PUBKEY",
  );
}
const homeRelayUrl = homeRelay;
const stateConfigPath = configPath;
const ownerSecretHex = relayOwnerSecretHex;
const relayOwnerPubkey = expectedRelayOwner;

installNodeStorage(`${stateConfigPath}.recursive-recovery`);
setHomeRelay(homeRelayUrl);

function orderFolderChain(events: readonly Event[], traceId: string): Event[] {
  const byId = new Map(events.map((event) => [event.id, event]));
  const ordered: Event[] = [];
  let nodeId: string | undefined = traceId;
  while (nodeId) {
    const event = byId.get(nodeId);
    assert.ok(event, `folder chain is missing ${nodeId}`);
    ordered.push(event);
    const children = events.filter((candidate) =>
      candidate.tags.some((tag) =>
        tag[0] === "e" && tag[1] === nodeId && tag[3] === "prev"
      ),
    );
    assert.ok(children.length <= 1, `folder chain branches after ${nodeId}`);
    nodeId = children[0]?.id;
  }
  assert.equal(ordered.length, events.length, "folder chain contains disconnected nodes");
  return ordered;
}

function folderContentHash(event: Event): string {
  const parsed = JSON.parse(event.content) as { contentHash?: unknown };
  assert.match(String(parsed.contentHash), /^[0-9a-f]{64}$/);
  return String(parsed.contentHash);
}

function checkpoint(event: Event): { cause?: string; sourceNodeId?: string } {
  const parsed = JSON.parse(event.content) as {
    folderCheckpoint?: { cause?: string; sourceNodeId?: string };
  };
  return parsed.folderCheckpoint ?? {};
}

async function main(): Promise<void> {
  // Dynamic imports are load-bearing: the isolated localStorage profile and
  // relay override must be installed before shared browser modules evaluate.
  const { initializeMcpKeySession } = await import("../src/tools.js");
  const {
    createFolderGenesis,
    diffToDeltas,
    fetchEventById,
    fetchFolderNodes,
    fetchManifest,
    operationIdFromNode,
    publishEdit,
    sha256HexLocal,
    stepFolderManifest,
    upsertManifestEntry,
  } = await import("../../client/src/provenance/provenance.js");
  const {
    pendingLocalEventCount,
  } = await import("../../client/src/provenance/event-outbox.js");
  const {
    propagateLocalTreeFolderHead,
  } = await import("../../client/src/workspace/workspace-local.js");
  const {
    createTraceOperationId,
    synthesizeKEditTransition,
    verifyFolderTraceChain,
  } = await import("@zine/protocol");
  const { getPublicKey, verifyEvent } = await import("nostr-tools/pure");

  const signer = Uint8Array.from(Buffer.from(ownerSecretHex, "hex"));
  const ownerPubkey = getPublicKey(signer);
  assert.equal(ownerPubkey, relayOwnerPubkey, "relay owner fixture key changed");
  await initializeMcpKeySession({ publicKey: ownerPubkey, secretKey: signer });

  // Use a dedicated pathless Root and isolated localStorage profile. The
  // temporary relay database and its ACL are owned by scripts/verify-relay.mjs.
  const rootOperationId = createTraceOperationId();
  const rootId = await createFolderGenesis({
    signer,
    localOnly: true,
    operationId: rootOperationId,
  });
  const tree = { storageRootId: rootId, folderId: rootId, storagePath: "" };
  const selectedFolderPath = "drafts/chapters/scenes";
  const emptyFolderHash = await sha256HexLocal(JSON.stringify([]));

  const createNestedFolder = async (
    folderPath: string,
    parentPath: string,
    parentId: string,
  ): Promise<string> => {
    const operationId = createTraceOperationId();
    const childId = await createFolderGenesis({ signer, localOnly: true, operationId });
    const parentHead = await upsertManifestEntry(parentId, {
      kind: "folder",
      relativePath: folderPath.slice(parentPath ? parentPath.length + 1 : 0),
      latestNodeId: childId,
      contentHash: emptyFolderHash,
    }, signer, { localOnly: true, operationId });
    await propagateLocalTreeFolderHead(
      tree,
      parentPath,
      parentId,
      parentHead,
      signer,
      true,
    );
    return childId;
  };

  const draftsId = await createNestedFolder("drafts", "", rootId);
  const chaptersId = await createNestedFolder("drafts/chapters", "drafts", draftsId);
  const scenesId = await createNestedFolder(
    selectedFolderPath,
    "drafts/chapters",
    chaptersId,
  );
  const folderIds = [scenesId, chaptersId, draftsId, rootId];

  const folderChains = async (): Promise<Map<string, Event[]>> => new Map(
    await Promise.all(folderIds.map(async (id) => [
      id,
      orderFolderChain(await fetchFolderNodes(id), id),
    ] as const)),
  );
  const operationNodes = (
    chains: Map<string, Event[]>,
    operationId: string,
  ): Event[] => folderIds.flatMap((id) => chains.get(id) ?? []).filter(
    (event) => operationIdFromNode(event) === operationId,
  );

  const leafOperationId = createTraceOperationId();
  const leafText = "recursive recovery frontier\n";
  const leafHash = await sha256HexLocal(leafText);
  const leaf = await publishEdit({
    prevEventId: null,
    previousSnapshot: "",
    relativePath: "scene.md",
    folderId: scenesId,
    deltas: diffToDeltas("", leafText),
    snapshot: leafText,
    contentHash: leafHash,
    action: "import",
    signer,
    localOnly: true,
    operationId: leafOperationId,
    kedits: synthesizeKEditTransition("", leafText, ownerPubkey),
  });
  const fetchedLeaf = await fetchEventById(leaf.id);
  assert.ok(fetchedLeaf, "file Step was not durable");
  assert.deepEqual(
    JSON.parse(JSON.stringify(fetchedLeaf)),
    JSON.parse(JSON.stringify(leaf)),
    "relay changed the accepted signed file Step",
  );
  const scenesFileHead = await upsertManifestEntry(scenesId, {
    kind: "file",
    relativePath: "scene.md",
    latestNodeId: leaf.id,
    contentHash: leafHash,
  }, signer, { localOnly: true, operationId: leafOperationId });

  // Crash boundary 1: file + selected folder are durable, while all three
  // ancestors still pin the preceding scenes frontier.
  const beforeLeafRecovery = await folderChains();
  assert.notEqual(
    (await fetchManifest(chaptersId)).find(
      (entry) => entry.relativePath === "scenes",
    )?.latestNodeId,
    scenesFileHead.id,
  );
  await propagateLocalTreeFolderHead(
    tree,
    selectedFolderPath,
    scenesId,
    scenesFileHead,
    signer,
    true,
  );
  const afterLeafRecovery = await folderChains();
  assert.deepEqual(
    folderIds.map((id) =>
      afterLeafRecovery.get(id)!.length - beforeLeafRecovery.get(id)!.length
    ),
    [0, 1, 1, 1],
    "leaf recovery must complete only the missing ancestor frontier",
  );
  assert.deepEqual(
    operationNodes(afterLeafRecovery, leafOperationId)
      .map((event) => checkpoint(event).cause)
      .sort(),
    ["child-advance", "child-advance", "child-advance", "structure-change"],
  );
  const leafRecoveredHeads = folderIds.map(
    (id) => afterLeafRecovery.get(id)!.at(-1)!.id,
  );
  await propagateLocalTreeFolderHead(
    tree,
    selectedFolderPath,
    scenesId,
    scenesFileHead,
    signer,
    true,
  );
  const repeatedLeafRecovery = await folderChains();
  assert.deepEqual(
    folderIds.map((id) => repeatedLeafRecovery.get(id)!.at(-1)!.id),
    leafRecoveredHeads,
    "repeated leaf recovery regenerated an accepted checkpoint",
  );
  assert.deepEqual(
    folderIds.map((id) => repeatedLeafRecovery.get(id)!.length),
    folderIds.map((id) => afterLeafRecovery.get(id)!.length),
  );

  const explicitOperationId = createTraceOperationId();
  const beforeFreshExplicitStep = await folderChains();
  const explicitScenesHead = await stepFolderManifest(scenesId, signer, {
    localOnly: true,
    operationId: explicitOperationId,
  });
  const afterFreshExplicitStep = await folderChains();
  assert.equal(
    afterFreshExplicitStep.get(scenesId)!.length,
    beforeFreshExplicitStep.get(scenesId)!.length + 1,
    "a fresh operation id must append one deliberate explicit checkpoint",
  );
  assert.deepEqual(
    folderIds.slice(1).map((id) => afterFreshExplicitStep.get(id)!.length),
    folderIds.slice(1).map((id) => beforeFreshExplicitStep.get(id)!.length),
  );
  const partialChaptersHead = await upsertManifestEntry(chaptersId, {
    kind: "folder",
    relativePath: "scenes",
    latestNodeId: explicitScenesHead.id,
    contentHash: folderContentHash(explicitScenesHead),
  }, signer, { localOnly: true, operationId: explicitOperationId });

  // Crash boundary 2: the one explicit Step and nearest ancestor are durable;
  // retry must reuse both and advance only the remaining two ancestors.
  const beforeExplicitRecovery = await folderChains();
  assert.equal(beforeExplicitRecovery.get(chaptersId)!.at(-1)!.id, partialChaptersHead.id);
  assert.notEqual(
    (await fetchManifest(draftsId)).find(
      (entry) => entry.relativePath === "chapters",
    )?.latestNodeId,
    partialChaptersHead.id,
  );
  const retriedExplicitScenesHead = await stepFolderManifest(scenesId, signer, {
    localOnly: true,
    operationId: explicitOperationId,
  });
  assert.equal(
    retriedExplicitScenesHead.id,
    explicitScenesHead.id,
    "retry regenerated the already-accepted explicit folder checkpoint",
  );
  const afterSelectedRetry = await folderChains();
  assert.deepEqual(
    folderIds.map((id) => afterSelectedRetry.get(id)!.length),
    folderIds.map((id) => beforeExplicitRecovery.get(id)!.length),
    "retry changed a chain before recovering the missing ancestor frontier",
  );
  await propagateLocalTreeFolderHead(
    tree,
    selectedFolderPath,
    scenesId,
    retriedExplicitScenesHead,
    signer,
    true,
  );
  const afterExplicitRecovery = await folderChains();
  assert.deepEqual(
    folderIds.map((id) =>
      afterExplicitRecovery.get(id)!.length - beforeExplicitRecovery.get(id)!.length
    ),
    [0, 0, 1, 1],
    "explicit-Step recovery must complete only the missing cascade",
  );

  const explicitNodes = operationNodes(afterExplicitRecovery, explicitOperationId);
  assert.equal(explicitNodes.length, 4);
  assert.equal(
    explicitNodes.filter((event) => checkpoint(event).cause === "explicit-step").length,
    1,
    "one recursive Step must retain exactly one explicit folder checkpoint",
  );
  assert.equal(
    explicitNodes.filter((event) => checkpoint(event).cause === "child-advance").length,
    3,
  );
  const explicitByFolder = new Map(folderIds.map((id) => {
    const event = (afterExplicitRecovery.get(id) ?? []).find(
      (candidate) => operationIdFromNode(candidate) === explicitOperationId,
    );
    assert.ok(event, `operation ${explicitOperationId} is missing folder ${id}`);
    return [id, event] as const;
  }));
  assert.equal(checkpoint(explicitByFolder.get(chaptersId)!).sourceNodeId, explicitScenesHead.id);
  assert.equal(
    checkpoint(explicitByFolder.get(draftsId)!).sourceNodeId,
    explicitByFolder.get(chaptersId)!.id,
  );
  assert.equal(
    checkpoint(explicitByFolder.get(rootId)!).sourceNodeId,
    explicitByFolder.get(draftsId)!.id,
  );

  const explicitRecoveredHeads = folderIds.map(
    (id) => afterExplicitRecovery.get(id)!.at(-1)!.id,
  );
  const repeatedExplicitScenesHead = await stepFolderManifest(scenesId, signer, {
    localOnly: true,
    operationId: explicitOperationId,
  });
  assert.equal(repeatedExplicitScenesHead.id, explicitScenesHead.id);
  await propagateLocalTreeFolderHead(
    tree,
    selectedFolderPath,
    scenesId,
    repeatedExplicitScenesHead,
    signer,
    true,
  );
  const repeatedExplicitRecovery = await folderChains();
  assert.deepEqual(
    folderIds.map((id) => repeatedExplicitRecovery.get(id)!.at(-1)!.id),
    explicitRecoveredHeads,
    "repeated explicit-Step recovery changed the accepted frontier",
  );
  assert.deepEqual(
    folderIds.map((id) => repeatedExplicitRecovery.get(id)!.length),
    folderIds.map((id) => afterExplicitRecovery.get(id)!.length),
  );

  const scenesManifest = await fetchManifest(scenesId);
  const chaptersManifest = await fetchManifest(chaptersId);
  const draftsManifest = await fetchManifest(draftsId);
  const rootManifest = await fetchManifest(rootId);
  assert.deepEqual(scenesManifest, [{
    kind: "file",
    relativePath: "scene.md",
    latestNodeId: leaf.id,
    contentHash: leafHash,
  }]);
  assert.equal(chaptersManifest[0]?.latestNodeId, explicitScenesHead.id);
  assert.equal(chaptersManifest[0]?.contentHash, folderContentHash(explicitScenesHead));
  assert.equal(draftsManifest[0]?.latestNodeId, explicitByFolder.get(chaptersId)!.id);
  assert.equal(
    draftsManifest[0]?.contentHash,
    folderContentHash(explicitByFolder.get(chaptersId)!),
  );
  assert.equal(rootManifest[0]?.latestNodeId, explicitByFolder.get(draftsId)!.id);
  assert.equal(
    rootManifest[0]?.contentHash,
    folderContentHash(explicitByFolder.get(draftsId)!),
  );

  for (const folderId of folderIds) {
    const chain = repeatedExplicitRecovery.get(folderId)!;
    const verdict = await verifyFolderTraceChain(chain, verifyEvent, {
      expectedOwnerPubkey: ownerPubkey,
      expectedNucleusId: chain.at(-1)!.id,
      expectedTraceId: folderId,
    });
    assert.equal(
      verdict.status,
      "full",
      verdict.issues.map((issue) => issue.message).join("; "),
    );
  }
  assert.equal(pendingLocalEventCount(), 0, "recovery fixture left a signed event pending");

  process.stdout.write(`${JSON.stringify({
    ok: true,
    recursiveRecoveryRootId: rootId,
    folderSteps: folderIds.map((id) => repeatedExplicitRecovery.get(id)!.length),
    leafNodeId: leaf.id,
    explicitFolderNodeId: explicitScenesHead.id,
  })}\n`);
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
  },
);

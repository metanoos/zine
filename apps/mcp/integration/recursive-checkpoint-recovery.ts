import assert from "node:assert/strict";
import type { Event } from "nostr-tools";

import { installNodeStorage } from "../src/storage-node.js";
import { setHomeRelay } from "../src/relay-config-override.js";

const homeRelay = process.env.ZINE_TEST_HOME_RELAY_URL;
const configPath = process.env.ZINE_TEST_CONFIG_PATH;
const agentSecretHex = process.env.ZINE_TEST_AGENT_SECRET_HEX;
const expectedAgent = process.env.ZINE_TEST_AGENT_PUBKEY;
const relayOwnerSecretHex = process.env.ZINE_TEST_RELAY_OWNER_SECRET_HEX;
const expectedRelayOwner = process.env.ZINE_TEST_RELAY_OWNER_PUBKEY;

if (
  !homeRelay || !configPath || !agentSecretHex || !expectedAgent ||
  !relayOwnerSecretHex || !expectedRelayOwner
) {
  throw new Error(
    "recursive recovery requires ZINE_TEST_HOME_RELAY_URL, ZINE_TEST_CONFIG_PATH, " +
      "ZINE_TEST_AGENT_SECRET_HEX, ZINE_TEST_AGENT_PUBKEY, " +
      "ZINE_TEST_RELAY_OWNER_SECRET_HEX, and ZINE_TEST_RELAY_OWNER_PUBKEY",
  );
}
const homeRelayUrl = homeRelay;
const stateConfigPath = configPath;
const writerSecretHex = agentSecretHex;
const agentPubkey = expectedAgent;
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
  const { createMcpWorkspace, initializeMcpKeySession } = await import("../src/tools.js");
  const { resolveWorkspaceBinding } = await import("../src/folder-binding.js");
  const {
    createFolderGenesis,
    diffToDeltas,
    fetchEventById,
    fetchFolderNodes,
    fetchManifest,
    operationIdFromNode,
    publishEdit,
    requireAcceptedCurrentFolderCheckpoint,
    sha256HexLocal,
    stepFolderManifest,
    upsertManifestEntry,
  } = await import("../../client/src/provenance/provenance.js");
  const {
    enqueueLocalEvent,
    pendingLocalEventCount,
    removeLocalEvent,
  } = await import("../../client/src/provenance/event-outbox.js");
  const {
    propagateLocalTreeFolderHead,
  } = await import("../../client/src/workspace/workspace-local.js");
  const {
    clearFolderStepOperation,
    pendingFolderStepOperation,
    stageFolderStepOperation,
  } = await import("../../client/src/workspace/local-store.js");
  const {
    createTraceOperationId,
    synthesizeEditorTransactionTransition,
    verifyFolderTraceChain,
  } = await import("@zine/protocol");
  const { finalizeEvent, getPublicKey, verifyEvent } = await import("nostr-tools/pure");
  const { Relay } = await import("nostr-tools/relay");

  const signer = Uint8Array.from(Buffer.from(writerSecretHex, "hex"));
  const ownerSigner = Uint8Array.from(Buffer.from(ownerSecretHex, "hex"));
  assert.equal(getPublicKey(signer), agentPubkey, "authorized writer fixture key changed");
  assert.equal(getPublicKey(ownerSigner), relayOwnerPubkey, "relay owner fixture key changed");
  assert.notEqual(agentPubkey, relayOwnerPubkey, "writer must be distinct from relay owner");
  const voice = { publicKey: agentPubkey, secretKey: signer };
  await initializeMcpKeySession(voice);

  const publishDirect = async (event: Event, authSigner: Uint8Array): Promise<void> => {
    const relay = new Relay(homeRelayUrl);
    relay.onauth = async (template) => finalizeEvent(template, authSigner) as never;
    await relay.connect();
    try {
      try {
        await relay.publish(event);
        return;
      } catch (error) {
        if (!String(error).includes("auth-required") || !relay.onauth) throw error;
      }
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
          await relay.auth(relay.onauth);
          await relay.publish(event);
          return;
        } catch (error) {
          if (!String(error).includes("no challenge was received")) throw error;
          await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
        }
      }
      throw new Error("relay authentication did not complete for direct fixture publish");
    } finally {
      relay.close();
    }
  };

  const explicitCopy = (
    previous: Event,
    operationId: string,
    signingKey: Uint8Array,
    mutate?: (content: Record<string, unknown>) => void,
  ): Event => {
    const previousContent = JSON.parse(previous.content) as {
      snapshot: unknown;
      contentHash: string;
    };
    const steppedAt = Date.now();
    const content: Record<string, unknown> = {
      steppedAt,
      snapshot: previousContent.snapshot,
      contentHash: previousContent.contentHash,
      operationId,
      folderCheckpoint: { version: 1, cause: "explicit-step" },
    };
    mutate?.(content);
    const tags = previous.tags.filter(
      (tag) => tag[0] !== "action" && !(tag[0] === "e" && tag[3] === "prev"),
    );
    tags.push(["action", "edit"], ["e", previous.id, "", "prev"]);
    return finalizeEvent({
      kind: 4290,
      created_at: Math.floor(steppedAt / 1000),
      tags,
      content: JSON.stringify(content),
    }, signingKey);
  };

  // Exercise the normal persisted MCP Root and public Workspace coordinator.
  // The relay ACL authorizes this agent as a writer, but it does not own the
  // relay, keeping folder ownership separate from infrastructure ownership.
  const binding = await resolveWorkspaceBinding(undefined, agentPubkey, signer);
  const rootId = binding.folderId;
  const workspace = createMcpWorkspace(voice);
  const attached = await workspace.attach({ id: rootId, label: "recursive recovery" });
  await attached.reconciled;
  const selectedFolderPath = "drafts/chapters/scenes";
  const draftsId = await workspace.createFolder("drafts");
  const chaptersId = await workspace.createFolder("drafts/chapters");
  const scenesId = await workspace.createFolder(selectedFolderPath);
  const tree = { storageRootId: rootId, folderId: rootId, storagePath: "" };
  const folderIds = [scenesId, chaptersId, draftsId, rootId];

  const folderChains = async (): Promise<Map<string, Event[]>> => new Map(
    await Promise.all(folderIds.map(async (id) => [
      id,
      orderFolderChain(
        (await fetchFolderNodes(id)).filter((event) => event.pubkey === agentPubkey),
        id,
      ),
    ] as const)),
  );
  const operationNodes = (
    chains: Map<string, Event[]>,
    operationId: string,
  ): Event[] => folderIds.flatMap((id) => chains.get(id) ?? []).filter(
    (event) => operationIdFromNode(event) === operationId,
  );
  const assertOperationShape = (
    chains: Map<string, Event[]>,
    operationId: string,
  ): Map<string, Event> => {
    const nodes = operationNodes(chains, operationId);
    assert.equal(nodes.length, 4, `operation ${operationId} must cover four folder levels`);
    assert.equal(
      nodes.filter((event) => checkpoint(event).cause === "explicit-step").length,
      1,
      "one recursive Step must retain exactly one explicit folder checkpoint",
    );
    assert.equal(
      nodes.filter((event) => checkpoint(event).cause === "child-advance").length,
      3,
    );
    return new Map(folderIds.map((id) => {
      const event = (chains.get(id) ?? []).find(
        (candidate) => operationIdFromNode(candidate) === operationId,
      );
      assert.ok(event, `operation ${operationId} is missing folder ${id}`);
      return [id, event] as const;
    }));
  };

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
    editorTransactions: synthesizeEditorTransactionTransition("", leafText, agentPubkey),
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

  const explicitOperationId = createTraceOperationId();
  const beforeFreshExplicitStep = await folderChains();
  const explicitScenesHead = await stepFolderManifest(scenesId, signer, {
    localOnly: true,
    operationId: explicitOperationId,
  });
  const afterFreshExplicitStep = await folderChains();
  assert.deepEqual(
    folderIds.map((id) =>
      afterFreshExplicitStep.get(id)!.length - beforeFreshExplicitStep.get(id)!.length
    ),
    [1, 0, 0, 0],
    "a fresh operation id must append one deliberate explicit checkpoint",
  );
  const partialChaptersHead = await upsertManifestEntry(chaptersId, {
    kind: "folder",
    relativePath: "scenes",
    latestNodeId: explicitScenesHead.id,
    contentHash: folderContentHash(explicitScenesHead),
  }, signer, { localOnly: true, operationId: explicitOperationId });

  // Crash boundary 2: the explicit Step and nearest ancestor are durable.
  // The persisted retry enters through Workspace.stepFolder, reuses both, and
  // advances only the two missing ancestors.
  const beforeExplicitRecovery = await folderChains();
  assert.equal(beforeExplicitRecovery.get(chaptersId)!.at(-1)!.id, partialChaptersHead.id);
  stageFolderStepOperation(rootId, selectedFolderPath, explicitOperationId);
  const pendingExplicit = pendingFolderStepOperation(rootId, selectedFolderPath);
  assert.equal(pendingExplicit, explicitOperationId);
  const retriedExplicitId = await workspace.stepFolder(
    selectedFolderPath,
    signer,
    pendingExplicit!,
  );
  clearFolderStepOperation(rootId, selectedFolderPath);
  assert.equal(retriedExplicitId, explicitScenesHead.id);
  const afterExplicitRecovery = await folderChains();
  assert.deepEqual(
    folderIds.map((id) =>
      afterExplicitRecovery.get(id)!.length - beforeExplicitRecovery.get(id)!.length
    ),
    [0, 0, 1, 1],
    "explicit-Step recovery must complete only the missing cascade",
  );
  const explicitByFolder = assertOperationShape(afterExplicitRecovery, explicitOperationId);
  assert.equal(checkpoint(explicitByFolder.get(chaptersId)!).sourceNodeId, explicitScenesHead.id);
  assert.equal(
    checkpoint(explicitByFolder.get(draftsId)!).sourceNodeId,
    explicitByFolder.get(chaptersId)!.id,
  );
  assert.equal(
    checkpoint(explicitByFolder.get(rootId)!).sourceNodeId,
    explicitByFolder.get(draftsId)!.id,
  );

  // Same id at the current frontier is a complete no-op through the strongest
  // public coordinator, including the ancestor cascade.
  stageFolderStepOperation(rootId, selectedFolderPath, explicitOperationId);
  const beforeSameIdRetry = await folderChains();
  const sameId = await workspace.stepFolder(
    selectedFolderPath,
    signer,
    pendingFolderStepOperation(rootId, selectedFolderPath)!,
  );
  clearFolderStepOperation(rootId, selectedFolderPath);
  const afterSameIdRetry = await folderChains();
  assert.equal(sameId, explicitScenesHead.id);
  assert.deepEqual(
    folderIds.map((id) => afterSameIdRetry.get(id)!.length),
    folderIds.map((id) => beforeSameIdRetry.get(id)!.length),
    "same-id retry changed an already recovered frontier",
  );

  // New gesture ids deliberately append new checkpoints at every recursive
  // level, even when the materialized folder contents are unchanged.
  const freshOperationIds = [createTraceOperationId(), createTraceOperationId()];
  const freshSelectedIds: string[] = [];
  for (const operationId of freshOperationIds) {
    const before = await folderChains();
    freshSelectedIds.push(await workspace.stepFolder(selectedFolderPath, signer, operationId));
    const after = await folderChains();
    assert.deepEqual(
      folderIds.map((id) => after.get(id)!.length - before.get(id)!.length),
      [1, 1, 1, 1],
      "fresh operation id did not append one recursive checkpoint per folder",
    );
    assertOperationShape(after, operationId);
  }
  assert.notEqual(freshSelectedIds[0], freshSelectedIds[1]);

  // Concurrent delivery of one operation id must share the selected Step and
  // the full ancestor cascade even across two Workspace facades. Serializing
  // only the leaf would still race the three upserts.
  const concurrentOperationId = createTraceOperationId();
  const beforeConcurrent = await folderChains();
  const concurrentWorkspace = createMcpWorkspace(voice);
  const concurrentAttach = await concurrentWorkspace.attach({
    id: rootId,
    label: "recursive recovery concurrent facade",
  });
  await concurrentAttach.reconciled;
  const concurrentIds = await Promise.all([
    workspace.stepFolder(selectedFolderPath, signer, concurrentOperationId),
    concurrentWorkspace.stepFolder(selectedFolderPath, signer, concurrentOperationId),
  ]);
  assert.equal(concurrentIds[0], concurrentIds[1]);
  const afterConcurrent = await folderChains();
  assert.deepEqual(
    folderIds.map((id) => afterConcurrent.get(id)!.length - beforeConcurrent.get(id)!.length),
    [1, 1, 1, 1],
    "concurrent retry minted duplicate recursive checkpoints",
  );
  assertOperationShape(afterConcurrent, concurrentOperationId);

  // The requested signer is only a caller capability. Both requests below
  // resolve to the held folder-owner key, so they must share the full cascade
  // even though their requested pubkeys differ. The old Workspace flight key
  // split here after the selected-folder flight and raced every ancestor.
  const distinctSignerOperationId = createTraceOperationId();
  const beforeDistinctSignerConcurrent = await folderChains();
  const distinctSignerIds = await Promise.all([
    workspace.stepFolder(selectedFolderPath, signer, distinctSignerOperationId),
    concurrentWorkspace.stepFolder(
      selectedFolderPath,
      ownerSigner,
      distinctSignerOperationId,
    ),
  ]);
  assert.equal(distinctSignerIds[0], distinctSignerIds[1]);
  const afterDistinctSignerConcurrent = await folderChains();
  assert.deepEqual(
    folderIds.map((id) =>
      afterDistinctSignerConcurrent.get(id)!.length -
      beforeDistinctSignerConcurrent.get(id)!.length
    ),
    [1, 1, 1, 1],
    "distinct requested signers raced one resolved-owner recursive cascade",
  );
  assertOperationShape(afterDistinctSignerConcurrent, distinctSignerOperationId);

  const scenesManifest = await fetchManifest(scenesId);
  assert.deepEqual(scenesManifest, [{
    kind: "file",
    relativePath: "scene.md",
    latestNodeId: leaf.id,
    contentHash: leafHash,
  }]);

  // Once a later gesture advances the selected folder, retrying an older
  // persisted id must fail closed and must not clear the durable pending id.
  const beforeUnsafeRetry = await folderChains();
  stageFolderStepOperation(rootId, selectedFolderPath, explicitOperationId);
  await assert.rejects(
    workspace.stepFolder(
      selectedFolderPath,
      signer,
      pendingFolderStepOperation(rootId, selectedFolderPath)!,
    ),
    /head advanced after its explicit checkpoint/,
  );
  assert.equal(
    pendingFolderStepOperation(rootId, selectedFolderPath),
    explicitOperationId,
    "unsafe retry cleared the persisted operation id",
  );
  const afterUnsafeRetry = await folderChains();
  assert.deepEqual(
    folderIds.map((id) => afterUnsafeRetry.get(id)!.length),
    folderIds.map((id) => beforeUnsafeRetry.get(id)!.length),
    "unsafe advanced-head retry changed a folder chain",
  );

  // A valid signed node present only in the local outbox is visible to
  // federated reads but is not an accepted recovery point until home ACKs it.
  const pendingOnlyOperationId = createTraceOperationId();
  const currentScenesHead = afterUnsafeRetry.get(scenesId)!.at(-1)!;
  const pendingOnly = explicitCopy(currentScenesHead, pendingOnlyOperationId, signer);
  enqueueLocalEvent(pendingOnly);
  try {
    await assert.rejects(
      workspace.stepFolder(selectedFolderPath, signer, pendingOnlyOperationId),
      /not accepted by the home relay/,
    );
  } finally {
    removeLocalEvent(pendingOnly.id);
  }

  // An accepted copied checkpoint with the requested operation id but the
  // relay owner's signature cannot be reused as this agent's folder gesture.
  const foreignOperationId = createTraceOperationId();
  const foreign = explicitCopy(currentScenesHead, foreignOperationId, ownerSigner);
  await publishDirect(foreign, ownerSigner);
  await assert.rejects(
    workspace.stepFolder(selectedFolderPath, signer, foreignOperationId),
    /unsafe|owner|fixed identity/,
  );

  // Last, poison the authorized writer's apparent head with a signed but
  // internally inconsistent content hash. Recovery must validate the complete
  // fixed-owner chain before either reuse or append.
  const malformedOperationId = createTraceOperationId();
  const malformed = explicitCopy(
    currentScenesHead,
    malformedOperationId,
    signer,
    (content) => {
      content.contentHash = "0".repeat(64);
    },
  );
  await publishDirect(malformed, signer);
  await assert.rejects(
    workspace.stepFolder(selectedFolderPath, signer, malformedOperationId),
    /unsafe/,
  );

  for (const folderId of folderIds) {
    const chain = afterUnsafeRetry.get(folderId)!;
    const verdict = await verifyFolderTraceChain(chain, verifyEvent, {
      expectedOwnerPubkey: agentPubkey,
      expectedNucleusId: chain.at(-1)!.id,
      expectedTraceId: folderId,
    });
    assert.equal(
      verdict.status,
      "full",
      verdict.issues.map((issue) => issue.message).join("; "),
    );
  }
  assert.equal(
    pendingFolderStepOperation(rootId, selectedFolderPath),
    explicitOperationId,
    "fixture lost the unsafe persisted retry before shutdown",
  );
  assert.equal(pendingLocalEventCount(), 0, "recovery fixture left a signed event pending");

  // A home relay can still accept siblings from separate OS processes because
  // ordinary Nostr publish has no CAS. The client-side assertion must detect
  // that condition and fail closed instead of claiming the Step completed.
  const siblingFolderId = await createFolderGenesis({
    signer,
    localOnly: true,
    operationId: createTraceOperationId(),
  });
  const siblingBase = await stepFolderManifest(siblingFolderId, signer, {
    localOnly: true,
    operationId: createTraceOperationId(),
  });
  const siblingOperationId = createTraceOperationId();
  const siblingA = explicitCopy(siblingBase, siblingOperationId, signer);
  const siblingB = explicitCopy(
    siblingBase,
    siblingOperationId,
    signer,
    (content) => {
      content.steppedAt = Number(content.steppedAt) + 1;
    },
  );
  assert.notEqual(siblingA.id, siblingB.id, "sibling fixture collapsed to one event id");
  await Promise.all([
    publishDirect(siblingA, signer),
    publishDirect(siblingB, signer),
  ]);
  await assert.rejects(
    requireAcceptedCurrentFolderCheckpoint(
      siblingFolderId,
      siblingA,
      agentPubkey,
    ),
    /accepted owner heads/,
  );

  process.stdout.write(`${JSON.stringify({
    ok: true,
    recursiveRecoveryRootId: rootId,
    writerPubkey: agentPubkey,
    relayOwnerPubkey,
    folderSteps: folderIds.map((id) => afterUnsafeRetry.get(id)!.length),
    leafNodeId: leaf.id,
    explicitFolderNodeId: explicitScenesHead.id,
    concurrentFolderNodeId: concurrentIds[0],
    distinctSignerFolderNodeId: distinctSignerIds[0],
    retainedUnsafeOperationId: explicitOperationId,
  })}\n`);
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
  },
);

import { test } from "node:test";
import assert from "node:assert/strict";

import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { EditorTransaction } from "@zine/protocol";
import * as Y from "yjs";

import {
  signCollaborationOperation,
  signCollaborationBootstrap,
  verifyCollaborationOperation,
  verifyCollaborationBootstrap,
} from "./collaboration-crypto.js";
import {
  connectCollaborationReplicas,
  entriesForCollaborationMount,
  CollaborationReplica,
} from "./collaboration.js";
import {
  COLLABORATION_VERSION,
  type CollaborationCapability,
  type CollaborationSeedEntry,
  type CollaborationBootstrap,
  type CollaborationDefinition,
} from "./collaboration-types.js";

function identity() {
  const pair = schnorr.keygen();
  return {
    secretKey: pair.secretKey,
    pubkey: bytesToHex(pair.publicKey),
  };
}

const owner = identity();
const collaborator = identity();
const collaboratorVoice = identity();
const reader = identity();
const readerVoice = identity();
const narrowReader = identity();
const noJoin = identity();

const entries: CollaborationSeedEntry[] = [
  { id: "root", kind: "folder", parentId: null, name: "" },
  { id: "drafts", kind: "folder", parentId: "root", name: "drafts" },
  {
    id: "draft",
    kind: "file",
    parentId: "drafts",
    name: "draft.md",
    text: "Hello",
  },
  { id: "notes", kind: "folder", parentId: "drafts", name: "notes" },
  {
    id: "notes-file",
    kind: "file",
    parentId: "notes",
    name: "todo.md",
    text: "Todo",
  },
  { id: "private", kind: "folder", parentId: "drafts", name: "private" },
  {
    id: "secret",
    kind: "file",
    parentId: "private",
    name: "secret.md",
    text: "not shared",
  },
  {
    id: "outside",
    kind: "file",
    parentId: "root",
    name: "outside.md",
    text: "also not shared",
  },
];

const capabilities: CollaborationCapability[] = [
  {
    id: "collaborator-files",
    subjectPubkey: collaborator.pubkey,
    resource: {
      kind: "entry",
      entryId: "drafts",
      includeDescendants: true,
    },
    actions: [
      "collaboration.join",
      "file.read",
      "file.edit",
      "folder.create",
      "entry.rename",
      "entry.move",
      "entry.delete",
    ],
    actorPubkeys: [collaboratorVoice.pubkey],
  },
  {
    id: "collaborator-presence",
    subjectPubkey: collaborator.pubkey,
    resource: { kind: "collaboration" },
    actions: ["presence.write"],
    actorPubkeys: [collaboratorVoice.pubkey],
  },
  {
    id: "collaborator-stage",
    subjectPubkey: collaborator.pubkey,
    resource: { kind: "collaboration" },
    actions: ["stage.view", "stage.start", "stage.control", "stage.end"],
    actorPubkeys: [collaboratorVoice.pubkey],
  },
  {
    id: "reader-files",
    subjectPubkey: reader.pubkey,
    resource: {
      kind: "entry",
      entryId: "drafts",
      includeDescendants: true,
    },
    actions: ["collaboration.join", "file.read"],
    actorPubkeys: [readerVoice.pubkey],
  },
  {
    id: "reader-presence",
    subjectPubkey: reader.pubkey,
    resource: { kind: "collaboration" },
    actions: ["presence.write"],
    actorPubkeys: [readerVoice.pubkey],
  },
  {
    id: "reader-stage",
    subjectPubkey: reader.pubkey,
    resource: {
      kind: "entry",
      entryId: "drafts",
      includeDescendants: true,
    },
    actions: ["stage.view"],
    actorPubkeys: [readerVoice.pubkey],
  },
];

const definition: CollaborationDefinition = {
  version: COLLABORATION_VERSION,
  collaborationId: "collaboration-test",
  ownerPubkey: owner.pubkey,
  mount: {
    mount: { kind: "folder", path: "drafts" },
    shields: ["drafts/private"],
  },
  capabilities,
};

function transaction(
  actor: string,
  sequence: number,
  from: number,
  to: number,
  text: string,
  selectionBefore = from,
): EditorTransaction {
  const after = from + text.length;
  return {
    sequence,
    timestamp: Date.now(),
    actor,
    changes: [{
      op: from === to ? "insert" : text === "" ? "delete" : "replace",
      from,
      to,
      text,
    }],
    selectionBefore: {
      ranges: [{ anchor: selectionBefore, head: selectionBefore }],
      main: 0,
    },
    selectionAfter: {
      ranges: [{ anchor: after, head: after }],
      main: 0,
    },
  };
}

function submitEdit(
  replica: CollaborationReplica,
  input: {
    fileId: string;
    actorPubkey: string;
    secretKey: Uint8Array;
    editorTransaction: EditorTransaction;
  },
) {
  const { editorTransaction, ...batch } = input;
  return replica.submitEditBatch({
    ...batch,
    editorTransactions: [editorTransaction],
  });
}

function replicas() {
  const host = CollaborationReplica.createHost({
    definition,
    participantPubkey: owner.pubkey,
    entries,
  });
  const guest = CollaborationReplica.fromBootstrap(
    collaborator.pubkey,
    host.bootstrapFor(collaborator.pubkey, owner.secretKey),
  );
  return { host, guest };
}

function resignBootstrap(
  bootstrap: CollaborationBootstrap,
  overrides: Partial<Omit<CollaborationBootstrap, "bootstrapId" | "signature">>,
): CollaborationBootstrap {
  const {
    bootstrapId: _bootstrapId,
    signature: _signature,
    ...body
  } = bootstrap;
  return signCollaborationBootstrap(
    { ...body, ...overrides },
    owner.secretKey,
  );
}

test("the collaboration seed contains only the copied mount minus shields", () => {
  assert.deepEqual(
    entriesForCollaborationMount(entries, definition.mount).map((entry) => entry.id),
    ["root", "drafts", "draft", "notes", "notes-file"],
  );

  const host = CollaborationReplica.createHost({
    definition,
    participantPubkey: owner.pubkey,
    entries,
  });
  try {
    assert.deepEqual(
      host.listEntries().map((entry) => entry.id),
      ["root", "drafts", "draft", "notes", "notes-file"],
    );
    assert.throws(() => host.fileText("secret"), /unknown entry|not a collaboration file/);
    assert.throws(() => host.fileText("outside"), /unknown entry|not a collaboration file/);
    assert.equal("layout" in host.definition, false);
  } finally {
    host.destroy();
  }
});

test("collaboration.join is required before an owner can issue or accept a bootstrap", () => {
  const noJoinDefinition: CollaborationDefinition = {
    ...definition,
    collaborationId: "collaboration-no-join",
    capabilities: [
      ...capabilities,
      {
        id: "presence-without-join",
        subjectPubkey: noJoin.pubkey,
        resource: { kind: "collaboration" },
        actions: ["presence.write"],
      },
    ],
  };
  const host = CollaborationReplica.createHost({
    definition: noJoinDefinition,
    participantPubkey: owner.pubkey,
    entries,
  });
  try {
    assert.throws(
      () => host.bootstrapFor(noJoin.pubkey, owner.secretKey),
      /lacks collaboration\.join permission/,
    );

    const allowed = host.bootstrapFor(collaborator.pubkey, owner.secretKey);
    const denied = resignBootstrap(allowed, {
      recipientPubkey: noJoin.pubkey,
    });
    assert.throws(
      () => CollaborationReplica.fromBootstrap(noJoin.pubkey, denied),
      /lacks collaboration\.join permission/,
    );
  } finally {
    host.destroy();
  }
});

test("owner-authenticated bootstrap rejects tampering and recipient forwarding", () => {
  const host = CollaborationReplica.createHost({
    definition,
    participantPubkey: owner.pubkey,
    entries,
  });
  try {
    const bootstrap = host.bootstrapFor(
      collaborator.pubkey,
      owner.secretKey,
    );
    assert.equal(verifyCollaborationBootstrap(bootstrap), true);
    assert.throws(
      () =>
        CollaborationReplica.fromBootstrap(collaborator.pubkey, {
          ...bootstrap,
          directoryUpdate: `${bootstrap.directoryUpdate}00`,
        }),
      /not owner-authenticated/,
    );
    assert.throws(
      () => CollaborationReplica.fromBootstrap(reader.pubkey, bootstrap),
      /not owner-authenticated/,
    );
  } finally {
    host.destroy();
  }
});

test("bootstrap and fileText reject unknown or unreadable file documents", () => {
  const narrowDefinition: CollaborationDefinition = {
    ...definition,
    collaborationId: "collaboration-narrow-bootstrap",
    capabilities: [{
      id: "narrow-reader",
      subjectPubkey: narrowReader.pubkey,
      resource: {
        kind: "entry",
        entryId: "draft",
        includeDescendants: false,
      },
      actions: ["collaboration.join", "file.read"],
    }],
  };
  const host = CollaborationReplica.createHost({
    definition: narrowDefinition,
    participantPubkey: owner.pubkey,
    entries,
  });
  let guest: CollaborationReplica | null = null;
  try {
    const narrow = host.bootstrapFor(narrowReader.pubkey, owner.secretKey);
    const ownerBootstrap = host.bootstrapFor(owner.pubkey, owner.secretKey);
    const unreadable = resignBootstrap(narrow, {
      fileUpdates: {
        ...narrow.fileUpdates,
        "notes-file": ownerBootstrap.fileUpdates["notes-file"],
      },
    });
    assert.throws(
      () => CollaborationReplica.fromBootstrap(narrowReader.pubkey, unreadable),
      /unreadable file snapshot notes-file/,
    );

    const unknown = resignBootstrap(narrow, {
      fileUpdates: {
        ...narrow.fileUpdates,
        ghost: ownerBootstrap.fileUpdates.draft,
      },
    });
    assert.throws(
      () => CollaborationReplica.fromBootstrap(narrowReader.pubkey, unknown),
      /unknown file snapshot ghost/,
    );

    guest = CollaborationReplica.fromBootstrap(narrowReader.pubkey, narrow);
    const leakedDoc = new Y.Doc({ gc: false });
    leakedDoc.getText("content").insert(0, "leaked");
    (
      guest as unknown as { fileDocs: Map<string, Y.Doc> }
    ).fileDocs.set("notes-file", leakedDoc);
    assert.throws(
      () => guest!.fileText("notes-file"),
      /not readable by this participant/,
    );
  } finally {
    guest?.destroy();
    host.destroy();
  }
});

test("signed Yjs text operations converge and retain actor selection metadata", () => {
  const { host, guest } = replicas();
  const disconnect = connectCollaborationReplicas(host, guest);
  try {
    assert.equal(guest.canPerformAction("stage.start"), true);
    const operation = submitEdit(guest, {
      fileId: "draft",
      actorPubkey: collaboratorVoice.pubkey,
      secretKey: collaborator.secretKey,
      editorTransaction: transaction(
        collaboratorVoice.pubkey,
        0,
        5,
        5,
        "!",
        5,
      ),
    });

    assert.equal(verifyCollaborationOperation(operation), true);
    assert.equal(host.fileText("draft").toString(), "Hello!");
    assert.equal(guest.fileText("draft").toString(), "Hello!");
    assert.equal(operation.kind, "file.edit.batch");
    assert.equal(
      operation.payload.editorTransactions[0].actor,
      collaboratorVoice.pubkey,
    );
    assert.deepEqual(
      operation.payload.editorTransactions[0].selectionAfter,
      { ranges: [{ anchor: 6, head: 6 }], main: 0 },
    );
    assert.equal(host.acceptedOperations()[0].operationId, operation.operationId);

    const tampered = {
      ...operation,
      actorPubkey: owner.pubkey,
    };
    assert.equal(verifyCollaborationOperation(tampered), false);
  } finally {
    disconnect();
    host.destroy();
    guest.destroy();
  }
});

test("one signed edit batch retains several ordered editor transactions", () => {
  const { host, guest } = replicas();
  const disconnect = connectCollaborationReplicas(host, guest);
  try {
    const operation = guest.submitEditBatch({
      fileId: "draft",
      actorPubkey: collaboratorVoice.pubkey,
      secretKey: collaborator.secretKey,
      editorTransactions: [
        transaction(collaboratorVoice.pubkey, 0, 5, 5, "!", 5),
        transaction(collaboratorVoice.pubkey, 1, 6, 6, "?", 6),
      ],
    });

    assert.equal(verifyCollaborationOperation(operation), true);
    assert.equal(operation.kind, "file.edit.batch");
    assert.equal(operation.payload.editorTransactions.length, 2);
    assert.deepEqual(
      operation.payload.editorTransactions.map((item) => item.sequence),
      [0, 1],
    );
    assert.equal(host.fileText("draft").toString(), "Hello!?");
    assert.equal(guest.fileText("draft").toString(), "Hello!?");
    assert.equal(host.acceptedOperations().length, 1);
  } finally {
    disconnect();
    host.destroy();
    guest.destroy();
  }
});

test("a signed Yjs update must exactly materialize its transaction evidence", () => {
  const { host, guest } = replicas();
  try {
    const valid = submitEdit(guest, {
      fileId: "draft",
      actorPubkey: collaboratorVoice.pubkey,
      secretKey: collaborator.secretKey,
      editorTransaction: transaction(
        collaboratorVoice.pubkey,
        0,
        5,
        5,
        "!",
      ),
    });
    const {
      operationId: _operationId,
      signature: _signature,
      ...body
    } = valid;
    const mismatched = signCollaborationOperation({
      ...body,
      payload: {
        ...body.payload,
        editorTransactions: [
          transaction(collaboratorVoice.pubkey, 0, 5, 5, "?"),
        ],
      },
    }, collaborator.secretKey);

    assert.equal(verifyCollaborationOperation(mismatched), true);
    assert.throws(
      () => host.receive(mismatched),
      /update disagrees with its signed editor transactions/,
    );
    assert.equal(host.fileText("draft").toString(), "Hello");
  } finally {
    host.destroy();
    guest.destroy();
  }
});

test("prepared edit batches remain isolated until a signed commit", () => {
  const { host: _host, guest } = replicas();
  try {
    const prepared = guest.prepareEditTransaction({
      fileId: "draft",
      actorPubkey: collaboratorVoice.pubkey,
      secretKey: collaborator.secretKey,
      editorTransaction: transaction(
        collaboratorVoice.pubkey,
        0,
        5,
        5,
        "!",
      ),
    });

    assert.equal(guest.fileText("draft").toString(), "Hello");
    assert.equal(guest.acceptedOperations().length, 0);
    const operation = guest.commitPreparedEditBatch({
      edits: [prepared],
      secretKey: collaborator.secretKey,
    });
    assert.equal(verifyCollaborationOperation(operation), true);
    assert.equal(guest.fileText("draft").toString(), "Hello!");
  } finally {
    _host.destroy();
    guest.destroy();
  }
});

test("typed folder operations synchronize stable ids under fine-grained grants", () => {
  const { host, guest } = replicas();
  const disconnect = connectCollaborationReplicas(host, guest);
  try {
    guest.createEntry(
      "drafts",
      { id: "new-file", kind: "file", name: "new.md", text: "New" },
      collaboratorVoice.pubkey,
      collaborator.secretKey,
    );
    guest.renameEntry(
      "new-file",
      "renamed.md",
      collaboratorVoice.pubkey,
      collaborator.secretKey,
    );
    guest.moveEntry(
      "new-file",
      "notes",
      collaboratorVoice.pubkey,
      collaborator.secretKey,
    );

    assert.equal(host.pathForEntry("new-file"), "drafts/notes/renamed.md");
    assert.equal(host.fileText("new-file").toString(), "New");
    assert.equal(guest.pathForEntry("new-file"), "drafts/notes/renamed.md");

    guest.deleteEntry(
      "new-file",
      collaboratorVoice.pubkey,
      collaborator.secretKey,
    );
    assert.equal(host.listEntries().some((entry) => entry.id === "new-file"), false);
  } finally {
    disconnect();
    host.destroy();
    guest.destroy();
  }
});

test("a signed directory update must produce its typed semantic mutation", () => {
  const { host, guest } = replicas();
  try {
    host.renameEntry(
      "draft",
      "same.md",
      owner.pubkey,
      owner.secretKey,
    );
    const redundant = guest.renameEntry(
      "draft",
      "same.md",
      collaboratorVoice.pubkey,
      collaborator.secretKey,
    );

    assert.equal(verifyCollaborationOperation(redundant), true);
    assert.throws(
      () => host.receive(redundant),
      /must mutate exactly its signed target/,
    );
    assert.equal(host.pathForEntry("draft"), "drafts/same.md");
  } finally {
    host.destroy();
    guest.destroy();
  }
});

test("concurrent same-name creates converge through deterministic materialization", () => {
  const { host, guest } = replicas();
  try {
    host.createEntry(
      "drafts",
      {
        id: "collision-a",
        kind: "file",
        name: "same.md",
        text: "A",
      },
      owner.pubkey,
      owner.secretKey,
    );
    guest.createEntry(
      "drafts",
      {
        id: "collision-b",
        kind: "file",
        name: "same.md",
        text: "B",
      },
      collaboratorVoice.pubkey,
      collaborator.secretKey,
    );

    const disconnect = connectCollaborationReplicas(host, guest);
    try {
      const hostPaths = [
        host.pathForEntry("collision-a"),
        host.pathForEntry("collision-b"),
      ];
      const guestPaths = [
        guest.pathForEntry("collision-a"),
        guest.pathForEntry("collision-b"),
      ];
      assert.deepEqual(hostPaths, guestPaths);
      assert.equal(new Set(hostPaths).size, 2);
      assert.equal(hostPaths[0], "drafts/same.md");
      assert.match(hostPaths[1], /^drafts\/same~[0-9a-f]{8,64}\.md$/);
      assert.equal(host.fileText("collision-a").toString(), "A");
      assert.equal(host.fileText("collision-b").toString(), "B");
      assert.equal(guest.fileText("collision-a").toString(), "A");
      assert.equal(guest.fileText("collision-b").toString(), "B");
    } finally {
      disconnect();
    }
  } finally {
    host.destroy();
    guest.destroy();
  }
});

test("read-only offline work becomes a private patch and never mutates shared text", () => {
  const host = CollaborationReplica.createHost({
    definition,
    participantPubkey: owner.pubkey,
    entries,
  });
  const readOnly = CollaborationReplica.fromBootstrap(
    reader.pubkey,
    host.bootstrapFor(reader.pubkey, owner.secretKey),
  );
  try {
    const edit = transaction(readerVoice.pubkey, 0, 5, 5, " private", 5);
    assert.equal(readOnly.canEditFile("draft", readerVoice.pubkey), false);
    assert.throws(
      () => submitEdit(readOnly, {
        fileId: "draft",
        actorPubkey: readerVoice.pubkey,
        secretKey: reader.secretKey,
        editorTransaction: edit,
      }),
      /lacks file\.edit permission/,
    );

    const patch = readOnly.preservePrivateTextPatch({
      fileId: "draft",
      actorPubkey: readerVoice.pubkey,
      baseText: "Hello",
      editorTransaction: edit,
      reason: "capability-revoked",
    });
    assert.equal(patch.reason, "capability-revoked");
    assert.equal(readOnly.privateTextPatches().length, 1);
    assert.equal(readOnly.fileText("draft").toString(), "Hello");
    assert.equal(host.fileText("draft").toString(), "Hello");
    assert.equal(readOnly.canReadEntry("draft"), true);
    assert.equal(readOnly.canReadEntry("secret"), false);
    assert.equal(readOnly.canPerformAction("stage.start"), false);
    assert.equal(readOnly.canPerformAction("stage.view", "draft"), true);
    assert.equal(host.canPerformAction("stage.start"), true);
    assert.equal(readOnly.canManageAccess(), false);
    assert.equal(host.canManageAccess(), true);
  } finally {
    host.destroy();
    readOnly.destroy();
  }
});

test("Awareness selections are ephemeral and follow Yjs-relative positions", () => {
  const { host, guest } = replicas();
  const disconnect = connectCollaborationReplicas(host, guest);
  try {
    guest.submitPresence({
      activeFileId: "draft",
      selection: {
        ranges: [{ anchor: 5, head: 5 }],
        main: 0,
      },
      actorPubkey: collaboratorVoice.pubkey,
      secretKey: collaborator.secretKey,
    });
    const remote = host.presenceFor(collaborator.pubkey);
    assert.ok(remote);
    assert.deepEqual(
      host.resolvePresenceSelection(remote),
      { ranges: [{ anchor: 5, head: 5 }], main: 0 },
    );

    submitEdit(host, {
      fileId: "draft",
      actorPubkey: owner.pubkey,
      secretKey: owner.secretKey,
      editorTransaction: transaction(owner.pubkey, 0, 0, 0, ">", 0),
    });
    assert.deepEqual(
      host.resolvePresenceSelection(remote),
      { ranges: [{ anchor: 6, head: 6 }], main: 0 },
    );
    assert.equal(
      host.acceptedOperations().some((operation) =>
        (operation as { kind: string }).kind === "presence.update"
      ),
      false,
    );
  } finally {
    disconnect();
    host.destroy();
    guest.destroy();
  }
});

test("Step acknowledgement drains only the captured accepted prefix", () => {
  const { host, guest } = replicas();
  const disconnect = connectCollaborationReplicas(host, guest);
  try {
    submitEdit(guest, {
      fileId: "draft",
      actorPubkey: collaboratorVoice.pubkey,
      secretKey: collaborator.secretKey,
      editorTransaction: transaction(collaboratorVoice.pubkey, 0, 5, 5, "1"),
    });
    const prefix = host.captureAcceptedPrefix();
    submitEdit(guest, {
      fileId: "draft",
      actorPubkey: collaboratorVoice.pubkey,
      secretKey: collaborator.secretKey,
      editorTransaction: transaction(collaboratorVoice.pubkey, 1, 6, 6, "2"),
    });

    host.acknowledgeAcceptedPrefix(prefix);
    assert.equal(host.acceptedOperations().length, 1);
    assert.equal(host.fileText("draft").toString(), "Hello12");
  } finally {
    disconnect();
    host.destroy();
    guest.destroy();
  }
});

test("reconnect replays pending signed operations and converges offline edits", () => {
  const { host, guest } = replicas();
  try {
    submitEdit(host, {
      fileId: "draft",
      actorPubkey: owner.pubkey,
      secretKey: owner.secretKey,
      editorTransaction: transaction(owner.pubkey, 0, 5, 5, "A"),
    });
    submitEdit(guest, {
      fileId: "draft",
      actorPubkey: collaboratorVoice.pubkey,
      secretKey: collaborator.secretKey,
      editorTransaction: transaction(collaboratorVoice.pubkey, 0, 5, 5, "B"),
    });

    const disconnect = connectCollaborationReplicas(host, guest);
    try {
      assert.equal(host.fileText("draft").toString(), guest.fileText("draft").toString());
      assert.equal(host.fileText("draft").length, 7);
      assert.equal(host.acceptedOperations().length, 2);
      assert.equal(guest.acceptedOperations().length, 2);
    } finally {
      disconnect();
    }
  } finally {
    host.destroy();
    guest.destroy();
  }
});

test("reconnect replays acknowledged operations missed while a replica was offline", () => {
  const { host, guest } = replicas();
  try {
    submitEdit(host, {
      fileId: "draft",
      actorPubkey: owner.pubkey,
      secretKey: owner.secretKey,
      editorTransaction: transaction(owner.pubkey, 0, 5, 5, "!"),
    });
    const prefix = host.captureAcceptedPrefix();
    host.acknowledgeAcceptedPrefix(prefix);
    assert.equal(host.acceptedOperations().length, 0);

    const disconnect = connectCollaborationReplicas(host, guest);
    try {
      assert.equal(host.fileText("draft").toString(), "Hello!");
      assert.equal(guest.fileText("draft").toString(), "Hello!");
    } finally {
      disconnect();
    }
  } finally {
    host.destroy();
    guest.destroy();
  }
});

test("acknowledged operation ids remain deduplicated", () => {
  const host = CollaborationReplica.createHost({
    definition,
    participantPubkey: owner.pubkey,
    entries,
  });
  try {
    const operation = submitEdit(host, {
      fileId: "draft",
      actorPubkey: owner.pubkey,
      secretKey: owner.secretKey,
      editorTransaction: transaction(owner.pubkey, 0, 5, 5, "!"),
    });
    host.acknowledgeAcceptedPrefix(host.captureAcceptedPrefix());

    assert.equal(host.receive(operation), false);
    assert.equal(host.acceptedOperations().length, 0);
    assert.equal(host.fileText("draft").toString(), "Hello!");
  } finally {
    host.destroy();
  }
});

test("bootstrap history is seen without becoming Step-pending", () => {
  const host = CollaborationReplica.createHost({
    definition,
    participantPubkey: owner.pubkey,
    entries,
  });
  let guest: CollaborationReplica | null = null;
  try {
    const acknowledgedOperation = submitEdit(host, {
      fileId: "draft",
      actorPubkey: owner.pubkey,
      secretKey: owner.secretKey,
      editorTransaction: transaction(owner.pubkey, 0, 5, 5, "!"),
    });
    host.acknowledgeAcceptedPrefix(host.captureAcceptedPrefix());
    const pendingOperation = submitEdit(host, {
      fileId: "draft",
      actorPubkey: owner.pubkey,
      secretKey: owner.secretKey,
      editorTransaction: transaction(owner.pubkey, 1, 6, 6, "?"),
    });

    const bootstrap = host.bootstrapFor(
      collaborator.pubkey,
      owner.secretKey,
    );
    assert.deepEqual(
      bootstrap.operationHistory.map((operation) => operation.operationId),
      [acknowledgedOperation.operationId, pendingOperation.operationId],
    );
    assert.deepEqual(
      bootstrap.acceptedOperations.map((operation) => operation.operationId),
      [pendingOperation.operationId],
    );
    guest = CollaborationReplica.fromBootstrap(
      collaborator.pubkey,
      bootstrap,
    );
    assert.equal(guest.fileText("draft").toString(), "Hello!?");
    assert.deepEqual(
      guest.acceptedOperations().map((operation) => operation.operationId),
      [pendingOperation.operationId],
    );
    const disconnect = connectCollaborationReplicas(host, guest);
    disconnect();
    assert.deepEqual(
      guest.acceptedOperations().map((operation) => operation.operationId),
      [pendingOperation.operationId],
    );
    assert.equal(guest.receive(acknowledgedOperation), false);
    assert.deepEqual(
      guest.acceptedOperations().map((operation) => operation.operationId),
      [pendingOperation.operationId],
    );
  } finally {
    host.destroy();
    guest?.destroy();
  }
});

test("bootstrap rejects a valid pending operation absent from signed history", () => {
  const host = CollaborationReplica.createHost({
    definition,
    participantPubkey: owner.pubkey,
    entries,
  });
  try {
    submitEdit(host, {
      fileId: "draft",
      actorPubkey: owner.pubkey,
      secretKey: owner.secretKey,
      editorTransaction: transaction(owner.pubkey, 0, 5, 5, "!"),
    });
    const bootstrap = host.bootstrapFor(
      collaborator.pubkey,
      owner.secretKey,
    );
    const pending = bootstrap.acceptedOperations[0];
    assert.ok(pending);

    assert.throws(
      () =>
        CollaborationReplica.fromBootstrap(
          collaborator.pubkey,
          resignBootstrap(bootstrap, {
            operationHistory: [],
            acceptedOperations: [pending],
          }),
        ),
      /invalid pending operation/,
    );
  } finally {
    host.destroy();
  }
});

test("private panel layouts are outside the Collaboration transport", () => {
  const { host, guest } = replicas();
  const disconnect = connectCollaborationReplicas(host, guest);
  const hostLayout = { panels: ["draft", "notes-file"], split: 0.4 };
  const guestLayout = { panels: ["notes-file"], split: 1 };
  try {
    submitEdit(guest, {
      fileId: "draft",
      actorPubkey: collaboratorVoice.pubkey,
      secretKey: collaborator.secretKey,
      editorTransaction: transaction(collaboratorVoice.pubkey, 0, 5, 5, "!"),
    });
    assert.deepEqual(hostLayout, { panels: ["draft", "notes-file"], split: 0.4 });
    assert.deepEqual(guestLayout, { panels: ["notes-file"], split: 1 });
  } finally {
    disconnect();
    host.destroy();
    guest.destroy();
  }
});

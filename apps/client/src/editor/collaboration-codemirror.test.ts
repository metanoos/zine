import assert from "node:assert/strict";
import { test } from "node:test";

import {
  EditorState,
  Transaction,
  type Extension,
  type TransactionSpec,
} from "@codemirror/state";
import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex } from "@noble/hashes/utils.js";

import {
  connectCollaborationReplicas,
  CollaborationReplica,
} from "../collaboration/collaboration.js";
import {
  COLLABORATION_VERSION,
  type CollaborationCapability,
  type CollaborationSeedEntry,
  type CollaborationDefinition,
} from "../collaboration/collaboration-types.js";
import {
  createCollaborationCodeMirrorBinding,
  CollaborationCodeMirrorBinding,
  collaborationRemoteOperationAnnotation,
  type CollaborationCodeMirrorTarget,
  type CollaborationPrivateForkState,
  yTextDeltaToCodeMirrorChanges,
} from "./collaboration-codemirror.js";
import {
  setRunsEffect,
  voiceField,
} from "./FileEditor.js";

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
];

const capabilities: CollaborationCapability[] = [
  {
    id: "collaborator-file",
    subjectPubkey: collaborator.pubkey,
    resource: {
      kind: "entry",
      entryId: "draft",
      includeDescendants: false,
    },
    actions: ["collaboration.join", "file.read", "file.edit"],
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
    id: "reader-file",
    subjectPubkey: reader.pubkey,
    resource: {
      kind: "entry",
      entryId: "draft",
      includeDescendants: false,
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
];

const definition: CollaborationDefinition = {
  version: COLLABORATION_VERSION,
  collaborationId: "collaboration-codemirror-test",
  ownerPubkey: owner.pubkey,
  mount: {
    mount: { kind: "folder", path: "drafts" },
    shields: [],
  },
  capabilities,
};

function replicas(participant: "collaborator" | "reader" = "collaborator") {
  const host = CollaborationReplica.createHost({
    definition,
    participantPubkey: owner.pubkey,
    entries,
  });
  const participantIdentity =
    participant === "collaborator" ? collaborator : reader;
  const guest = CollaborationReplica.fromBootstrap(
    participantIdentity.pubkey,
    host.bootstrapFor(participantIdentity.pubkey, owner.secretKey),
  );
  return { host, guest };
}

class StateHarness implements CollaborationCodeMirrorTarget {
  state: EditorState;
  readonly transactions: Transaction[] = [];
  private binding: CollaborationCodeMirrorBinding | null = null;

  constructor(doc: string, extensions: Extension = []) {
    this.state = EditorState.create({ doc, extensions });
  }

  connect(binding: CollaborationCodeMirrorBinding): void {
    this.binding = binding;
    binding.attach(this);
  }

  dispatch(spec: TransactionSpec): void {
    const transaction = this.state.update(spec);
    this.state = transaction.state;
    this.transactions.push(transaction);
    this.binding?.handleTransactions([transaction], this);
  }
}

function bindingFor(
  replica: CollaborationReplica,
  target: StateHarness,
  identityInput: {
    secretKey: Uint8Array;
    actorPubkey: string;
  },
  extra: {
    onPrivateForkChange?: (fork: CollaborationPrivateForkState) => void;
    editBatchMs?: number;
    maxEditBatchTransactions?: number;
  } = {},
): CollaborationCodeMirrorBinding {
  const binding = createCollaborationCodeMirrorBinding({
    replica,
    fileId: "draft",
    actorPubkey: identityInput.actorPubkey,
    secretKey: identityInput.secretKey,
    presenceThrottleMs: 10_000,
    editBatchMs: extra.editBatchMs ?? 0,
    ...extra,
  });
  target.connect(binding);
  return binding;
}

test("Y.Text deltas remain incremental CodeMirror changes", () => {
  assert.deepEqual(
    yTextDeltaToCodeMirrorChanges([
      { retain: 1 },
      { delete: 2 },
      { insert: "XY" },
      { retain: 2 },
      { insert: "!" },
    ]),
    [
      { from: 1, to: 3, insert: "XY" },
      { from: 5, to: 5, insert: "!" },
    ],
  );
  assert.deepEqual(
    yTextDeltaToCodeMirrorChanges([
      { retain: 2 },
      { insert: "X" },
      { delete: 1 },
    ]),
    [{ from: 2, to: 3, insert: "X" }],
  );
});

test("two CodeMirror peers sync once and retain the signed remote actor metadata", () => {
  const { host, guest } = replicas();
  const disconnect = connectCollaborationReplicas(host, guest);
  const hostEditor = new StateHarness("Hello");
  const guestEditor = new StateHarness("Hello");
  const hostBinding = bindingFor(host, hostEditor, {
    secretKey: owner.secretKey,
    actorPubkey: owner.pubkey,
  });
  const guestBinding = bindingFor(guest, guestEditor, {
    secretKey: collaborator.secretKey,
    actorPubkey: collaboratorVoice.pubkey,
  });

  try {
    guestEditor.dispatch({
      changes: { from: 5, insert: "!" },
      selection: { anchor: 6 },
      annotations: [
        Transaction.userEvent.of("input.type"),
        Transaction.time.of(1_234),
      ],
    });

    assert.equal(guestEditor.state.doc.toString(), "Hello!");
    assert.equal(hostEditor.state.doc.toString(), "Hello!");
    assert.equal(guest.fileText("draft").toString(), "Hello!");
    assert.equal(host.fileText("draft").toString(), "Hello!");
    assert.equal(guest.acceptedOperations().length, 1);
    assert.equal(host.acceptedOperations().length, 1);

    const remoteTransaction = hostEditor.transactions.find((transaction) =>
      transaction.annotation(collaborationRemoteOperationAnnotation) !== undefined
    );
    assert.ok(remoteTransaction);
    const operation = remoteTransaction.annotation(
      collaborationRemoteOperationAnnotation,
    );
    assert.ok(operation);
    assert.equal(operation.kind, "file.edit.batch");
    assert.equal(operation.actorPubkey, collaboratorVoice.pubkey);
    if (operation.kind !== "file.edit.batch") {
      assert.fail("expected file.edit.batch");
    }
    assert.deepEqual(operation.payload.editorTransactions, [{
      sequence: 0,
      timestamp: 1_234,
      actor: collaboratorVoice.pubkey,
      changes: [{
        op: "insert",
        from: 5,
        to: 5,
        text: "!",
      }],
      selectionBefore: {
        ranges: [{ anchor: 0, head: 0 }],
        main: 0,
      },
      selectionAfter: {
        ranges: [{ anchor: 6, head: 6 }],
        main: 0,
      },
    }]);
  } finally {
    hostBinding.destroy();
    guestBinding.destroy();
    disconnect();
    host.destroy();
    guest.destroy();
  }
});

test("CodeMirror micro-batches local transactions behind one signature", () => {
  const { host, guest } = replicas();
  const disconnect = connectCollaborationReplicas(host, guest);
  const hostEditor = new StateHarness("Hello");
  const guestEditor = new StateHarness("Hello");
  const hostBinding = bindingFor(host, hostEditor, {
    secretKey: owner.secretKey,
    actorPubkey: owner.pubkey,
  });
  const guestBinding = bindingFor(
    guest,
    guestEditor,
    {
      secretKey: collaborator.secretKey,
      actorPubkey: collaboratorVoice.pubkey,
    },
    { editBatchMs: 10_000 },
  );

  try {
    guestEditor.dispatch({
      changes: { from: 5, insert: "!" },
      selection: { anchor: 6 },
      annotations: [
        Transaction.userEvent.of("input.type"),
        Transaction.time.of(1_000),
      ],
    });
    guestEditor.dispatch({
      changes: { from: 6, insert: "?" },
      selection: { anchor: 7 },
      annotations: [
        Transaction.userEvent.of("input.type"),
        Transaction.time.of(1_010),
      ],
    });

    assert.equal(guestBinding.pendingEditCount(), 2);
    assert.equal(guest.fileText("draft").toString(), "Hello");
    assert.equal(guestEditor.state.doc.toString(), "Hello!?");
    assert.equal(host.fileText("draft").toString(), "Hello");
    assert.equal(host.acceptedOperations().length, 0);

    const operation = guestBinding.flushEdits();
    assert.ok(operation);
    assert.equal(operation.kind, "file.edit.batch");
    if (operation.kind !== "file.edit.batch") {
      assert.fail("expected file.edit.batch");
    }
    assert.deepEqual(
      operation.payload.editorTransactions.map((transaction) =>
        transaction.sequence
      ),
      [0, 1],
    );
    assert.equal(guestBinding.pendingEditCount(), 0);
    assert.equal(host.fileText("draft").toString(), "Hello!?");
    assert.equal(hostEditor.state.doc.toString(), "Hello!?");
    assert.equal(host.acceptedOperations().length, 1);
  } finally {
    hostBinding.destroy();
    guestBinding.destroy();
    disconnect();
    host.destroy();
    guest.destroy();
  }
});

test("an intervening remote edit flushes the isolated local batch first", () => {
  const { host, guest } = replicas();
  const disconnect = connectCollaborationReplicas(host, guest);
  const hostEditor = new StateHarness("Hello");
  const guestEditor = new StateHarness("Hello");
  const hostBinding = bindingFor(host, hostEditor, {
    secretKey: owner.secretKey,
    actorPubkey: owner.pubkey,
  });
  const guestBinding = bindingFor(
    guest,
    guestEditor,
    {
      secretKey: collaborator.secretKey,
      actorPubkey: collaboratorVoice.pubkey,
    },
    { editBatchMs: 10_000 },
  );

  try {
    guestEditor.dispatch({
      changes: { from: 5, insert: "!" },
      annotations: [
        Transaction.userEvent.of("input.type"),
        Transaction.time.of(1_000),
      ],
    });
    assert.equal(guestBinding.pendingEditCount(), 1);
    assert.equal(guest.fileText("draft").toString(), "Hello");

    hostEditor.dispatch({
      changes: { from: 0, insert: ">" },
      annotations: [
        Transaction.userEvent.of("input.type"),
        Transaction.time.of(1_010),
      ],
    });

    assert.equal(guestBinding.pendingEditCount(), 0);
    assert.equal(host.fileText("draft").toString(), ">Hello!");
    assert.equal(guest.fileText("draft").toString(), ">Hello!");
    assert.equal(hostEditor.state.doc.toString(), ">Hello!");
    assert.equal(guestEditor.state.doc.toString(), ">Hello!");
    assert.equal(host.acceptedOperations().length, 2);
    assert.equal(guest.acceptedOperations().length, 2);
  } finally {
    hostBinding.destroy();
    guestBinding.destroy();
    disconnect();
    host.destroy();
    guest.destroy();
  }
});

test("a failed batch commit becomes a private fork without touching shared Yjs", () => {
  const { host, guest } = replicas();
  const editor = new StateHarness("Hello");
  let fork: ReturnType<CollaborationCodeMirrorBinding["privateFork"]> = null;
  const binding = bindingFor(
    guest,
    editor,
    {
      secretKey: collaborator.secretKey,
      actorPubkey: collaboratorVoice.pubkey,
    },
    {
      editBatchMs: 10_000,
      onPrivateForkChange: (nextFork) => {
        fork = nextFork;
      },
    },
  );

  try {
    editor.dispatch({
      changes: { from: 5, insert: "!" },
      annotations: [
        Transaction.userEvent.of("input.type"),
        Transaction.time.of(1_000),
      ],
    });
    const originalCommit = guest.commitPreparedEditBatch.bind(guest);
    guest.commitPreparedEditBatch = () => {
      throw new Error("simulated signing failure");
    };
    try {
      assert.throws(() => binding.flushEdits(), /simulated signing failure/);
    } finally {
      guest.commitPreparedEditBatch = originalCommit;
    }

    assert.equal(guest.fileText("draft").toString(), "Hello");
    assert.equal(host.fileText("draft").toString(), "Hello");
    assert.equal(editor.state.doc.toString(), "Hello!");
    assert.equal(binding.pendingEditCount(), 0);
    assert.equal(binding.privateFork()?.reason, "commit-conflict");
    assert.ok(fork);
    assert.equal((fork as CollaborationPrivateForkState).text, "Hello!");
    assert.equal(guest.privateTextPatches().length, 1);
    assert.equal(guest.acceptedOperations().length, 0);

    editor.dispatch({
      changes: { from: 6, insert: "?" },
      annotations: [
        Transaction.userEvent.of("input.type"),
        Transaction.time.of(1_010),
      ],
    });
    assert.equal(editor.state.doc.toString(), "Hello!?");
    assert.equal(guest.fileText("draft").toString(), "Hello");
    assert.equal(
      guest.privateTextPatches()[0].editorTransactions.length,
      2,
    );
  } finally {
    binding.destroy();
    host.destroy();
    guest.destroy();
  }
});

test("cursor-only presence is throttled, ephemeral, and stays relative through edits", () => {
  const { host, guest } = replicas();
  const disconnect = connectCollaborationReplicas(host, guest);
  const hostEditor = new StateHarness("Hello");
  const guestEditor = new StateHarness("Hello");
  const hostBinding = bindingFor(host, hostEditor, {
    secretKey: owner.secretKey,
    actorPubkey: owner.pubkey,
  });
  const guestBinding = bindingFor(guest, guestEditor, {
    secretKey: collaborator.secretKey,
    actorPubkey: collaboratorVoice.pubkey,
  });

  try {
    guestEditor.dispatch({ selection: { anchor: 5 } });
    assert.equal(host.presenceFor(collaborator.pubkey), null);
    assert.equal(host.acceptedOperations().length, 0);

    guestBinding.flushPresence();
    const remote = host.presenceFor(collaborator.pubkey);
    assert.ok(remote);
    assert.deepEqual(
      host.resolvePresenceSelection(remote),
      { ranges: [{ anchor: 5, head: 5 }], main: 0 },
    );
    assert.equal(host.acceptedOperations().length, 0);

    hostEditor.dispatch({
      changes: { from: 0, insert: ">" },
      selection: { anchor: 1 },
      annotations: Transaction.userEvent.of("input.type"),
    });
    assert.deepEqual(
      host.resolvePresenceSelection(remote),
      { ranges: [{ anchor: 6, head: 6 }], main: 0 },
    );
    assert.deepEqual(
      hostBinding.remoteSelections().map((selection) => selection.selection),
      [{ ranges: [{ anchor: 6, head: 6 }], main: 0 }],
    );
  } finally {
    hostBinding.destroy();
    guestBinding.destroy();
    disconnect();
    host.destroy();
    guest.destroy();
  }
});

test("Y.UndoManager undo is actor-scoped and submits a signed undo transaction", () => {
  const { host, guest } = replicas();
  const disconnect = connectCollaborationReplicas(host, guest);
  const hostEditor = new StateHarness("Hello");
  const guestEditor = new StateHarness("Hello");
  const hostBinding = bindingFor(host, hostEditor, {
    secretKey: owner.secretKey,
    actorPubkey: owner.pubkey,
  });
  const guestBinding = bindingFor(guest, guestEditor, {
    secretKey: collaborator.secretKey,
    actorPubkey: collaboratorVoice.pubkey,
  });

  try {
    guestEditor.dispatch({
      changes: { from: 5, insert: "A" },
      selection: { anchor: 6 },
      annotations: Transaction.userEvent.of("input.type"),
    });
    hostEditor.dispatch({
      changes: { from: 0, insert: "R" },
      selection: { anchor: 1 },
      annotations: Transaction.userEvent.of("input.type"),
    });
    assert.equal(guestEditor.state.doc.toString(), "RHelloA");
    assert.equal(guestBinding.canUndo(), true);

    assert.equal(guestBinding.undo(), true);
    assert.equal(guestEditor.state.doc.toString(), "RHello");
    assert.equal(hostEditor.state.doc.toString(), "RHello");
    assert.equal(host.fileText("draft").toString(), "RHello");
    const undoOperation = guest.acceptedOperations().at(-1);
    assert.ok(undoOperation);
    assert.equal(undoOperation.kind, "file.edit.batch");
    if (undoOperation.kind !== "file.edit.batch") {
      assert.fail("expected file.edit.batch");
    }
    assert.equal(undoOperation.payload.editorTransactions[0].intent, "undo");
    assert.equal(
      undoOperation.payload.editorTransactions[0].actor,
      collaboratorVoice.pubkey,
    );
    assert.equal(guestBinding.canRedo(), true);

    assert.equal(guestBinding.redo(), true);
    assert.equal(guestEditor.state.doc.toString(), "RHelloA");
    assert.equal(hostEditor.state.doc.toString(), "RHelloA");
    const redoOperation = guest.acceptedOperations().at(-1);
    assert.ok(redoOperation);
    assert.equal(redoOperation.kind, "file.edit.batch");
    if (redoOperation.kind !== "file.edit.batch") {
      assert.fail("expected file.edit.batch");
    }
    assert.equal(redoOperation.payload.editorTransactions[0].intent, "redo");
  } finally {
    hostBinding.destroy();
    guestBinding.destroy();
    disconnect();
    host.destroy();
    guest.destroy();
  }
});

test("Y.UndoManager preserves separated changes through signed undo and redo transactions", () => {
  const { host, guest } = replicas();
  const disconnect = connectCollaborationReplicas(host, guest);
  const hostEditor = new StateHarness("Hello", [voiceField]);
  hostEditor.dispatch({
    effects: setRunsEffect.of([{ voice: "host-initial", text: "Hello" }]),
  });
  const guestEditor = new StateHarness("Hello");
  const hostBinding = bindingFor(host, hostEditor, {
    secretKey: owner.secretKey,
    actorPubkey: owner.pubkey,
  });
  const guestBinding = bindingFor(guest, guestEditor, {
    secretKey: collaborator.secretKey,
    actorPubkey: collaboratorVoice.pubkey,
  });

  try {
    guestEditor.dispatch({
      changes: [
        { from: 0, to: 1, insert: "Y" },
        { from: 4, to: 5, insert: "!" },
      ],
      selection: { anchor: 5 },
      annotations: Transaction.userEvent.of("input.type"),
    });
    assert.equal(guestEditor.state.doc.toString(), "Yell!");

    assert.equal(guestBinding.undo(), true);
    assert.equal(guestEditor.state.doc.toString(), "Hello");
    assert.equal(hostEditor.state.doc.toString(), "Hello");
    const undoOperation = guest.acceptedOperations().at(-1);
    assert.ok(undoOperation);
    assert.equal(undoOperation.kind, "file.edit.batch");
    if (undoOperation.kind !== "file.edit.batch") {
      assert.fail("expected file.edit.batch");
    }
    assert.deepEqual(undoOperation.payload.editorTransactions[0].changes, [
      { op: "replace", from: 0, to: 1, text: "H" },
      { op: "replace", from: 4, to: 5, text: "o" },
    ]);
    assert.deepEqual(hostEditor.state.field(voiceField), [
      { voice: collaboratorVoice.pubkey, text: "H" },
      { voice: "host-initial", text: "ell" },
      { voice: collaboratorVoice.pubkey, text: "o" },
    ]);

    assert.equal(guestBinding.redo(), true);
    assert.equal(guestEditor.state.doc.toString(), "Yell!");
    assert.equal(hostEditor.state.doc.toString(), "Yell!");
    const redoOperation = guest.acceptedOperations().at(-1);
    assert.ok(redoOperation);
    assert.equal(redoOperation.kind, "file.edit.batch");
    if (redoOperation.kind !== "file.edit.batch") {
      assert.fail("expected file.edit.batch");
    }
    assert.deepEqual(redoOperation.payload.editorTransactions[0].changes, [
      { op: "replace", from: 0, to: 1, text: "Y" },
      { op: "replace", from: 4, to: 5, text: "!" },
    ]);
    assert.deepEqual(hostEditor.state.field(voiceField), [
      { voice: collaboratorVoice.pubkey, text: "Y" },
      { voice: "host-initial", text: "ell" },
      { voice: collaboratorVoice.pubkey, text: "!" },
    ]);
  } finally {
    hostBinding.destroy();
    guestBinding.destroy();
    disconnect();
    host.destroy();
    guest.destroy();
  }
});

test("denied edits become a private fork and ignore later shared text", () => {
  const { host, guest: readerReplica } = replicas("reader");
  const disconnect = connectCollaborationReplicas(host, readerReplica);
  const hostEditor = new StateHarness("Hello");
  const readerEditor = new StateHarness("Hello");
  const hostBinding = bindingFor(host, hostEditor, {
    secretKey: owner.secretKey,
    actorPubkey: owner.pubkey,
  });
  const forkEvents: CollaborationPrivateForkState[] = [];
  const readerBinding = bindingFor(
    readerReplica,
    readerEditor,
    {
      secretKey: reader.secretKey,
      actorPubkey: readerVoice.pubkey,
    },
    { onPrivateForkChange: (fork) => forkEvents.push(fork) },
  );

  try {
    assert.equal(
      readerReplica.canEditFile("draft", readerVoice.pubkey),
      false,
    );
    readerEditor.dispatch({
      changes: { from: 5, insert: "!" },
      selection: { anchor: 6 },
      annotations: Transaction.userEvent.of("input.type"),
    });

    assert.equal(readerEditor.state.doc.toString(), "Hello!");
    assert.equal(readerReplica.fileText("draft").toString(), "Hello");
    assert.equal(host.fileText("draft").toString(), "Hello");
    assert.equal(readerReplica.acceptedOperations().length, 0);
    assert.equal(readerReplica.privateTextPatches().length, 1);
    assert.equal(forkEvents.length, 1);
    assert.equal(forkEvents[0].reason, "permission-denied");
    assert.equal(forkEvents[0].baseText, "Hello");
    assert.equal(forkEvents[0].text, "Hello!");
    assert.deepEqual(
      forkEvents[0].patch.editorTransactions[0].selectionAfter,
      { ranges: [{ anchor: 6, head: 6 }], main: 0 },
    );

    hostEditor.dispatch({
      changes: { from: 0, insert: ">" },
      selection: { anchor: 1 },
      annotations: Transaction.userEvent.of("input.type"),
    });
    assert.equal(readerReplica.fileText("draft").toString(), ">Hello");
    assert.equal(readerEditor.state.doc.toString(), "Hello!");
    assert.equal(readerBinding.privateFork()?.text, "Hello!");
  } finally {
    hostBinding.destroy();
    readerBinding.destroy();
    disconnect();
    host.destroy();
    readerReplica.destroy();
  }
});

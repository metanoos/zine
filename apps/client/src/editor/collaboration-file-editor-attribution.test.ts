import test from "node:test";
import assert from "node:assert/strict";

import { EditorState } from "@codemirror/state";

import {
  COLLABORATION_VERSION,
  type CollaborationSignedOperationOf,
} from "../collaboration/collaboration-types.js";
import {
  editorTransactionLogToArray,
  EMPTY_EDITOR_TRANSACTION_LOG,
} from "../workspace/workspace-core.js";
import {
  editorTransactionField,
  setEditorTransactionsEffect,
  setRunsEffect,
  voiceField,
} from "./FileEditor.js";
import { collaborationRemoteOperationAnnotation } from "./collaboration-codemirror.js";

test("FileEditor attributes a remote CRDT delta without borrowing the local caret", () => {
  const remoteActor = "b".repeat(64);
  const operation: CollaborationSignedOperationOf<"file.edit.batch"> = {
    version: COLLABORATION_VERSION,
    collaborationId: "collaboration",
    nonce: "0".repeat(32),
    participantPubkey: "a".repeat(64),
    actorPubkey: remoteActor,
    timestamp: 1_000,
    kind: "file.edit.batch",
    payload: {
      fileId: "draft",
      baseSnapshot: "00",
      update: "00",
      editorTransactions: [{
        sequence: 7,
        timestamp: 999,
        actor: remoteActor,
        changes: [{
          op: "insert",
          from: 5,
          to: 5,
          text: "!",
        }],
        selectionBefore: {
          ranges: [{ anchor: 5, head: 5 }],
          main: 0,
        },
        selectionAfter: {
          ranges: [{ anchor: 6, head: 6 }],
          main: 0,
        },
      }],
    },
    operationId: "c".repeat(64),
    signature: "d".repeat(128),
  };

  let state = EditorState.create({
    doc: "Hello",
    extensions: [voiceField, editorTransactionField],
  });
  state = state.update({
    effects: [
      setRunsEffect.of([{ voice: "local", text: "Hello" }]),
      setEditorTransactionsEffect.of(EMPTY_EDITOR_TRANSACTION_LOG),
    ],
  }).state;
  state = state.update({
    changes: { from: 5, insert: "!" },
    annotations: collaborationRemoteOperationAnnotation.of(operation),
  }).state;

  assert.deepEqual(state.field(voiceField), [
    { voice: "local", text: "Hello" },
    { voice: remoteActor, text: "!" },
  ]);
  assert.deepEqual(
    editorTransactionLogToArray(state.field(editorTransactionField)),
    [{
      sequence: 0,
      timestamp: 1_000,
      actor: remoteActor,
      changes: [{
        op: "insert",
        from: 5,
        to: 5,
        text: "!",
      }],
      selectionBefore: null,
      selectionAfter: null,
    }],
  );
});

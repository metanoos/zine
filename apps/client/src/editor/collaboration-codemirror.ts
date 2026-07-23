import {
  Annotation,
  Transaction,
  type ChangeSpec,
  type EditorSelection,
  type EditorState,
  type Extension,
  type TransactionSpec,
} from "@codemirror/state";
import {
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import type {
  EditorSelectionState,
  EditorTransaction,
} from "@zine/protocol";
import * as Y from "yjs";

import {
  collaborationOperationFromYjsOrigin,
  type CollaborationPreparedEdit,
  type CollaborationReplica,
} from "../collaboration/collaboration.js";
import type {
  CollaborationPresenceState,
  CollaborationPrivateTextPatch,
  CollaborationSignedOperation,
} from "../collaboration/collaboration-types.js";
import { captureEditorTransaction } from "../provenance/editor-transaction-capture.js";

/** Lets the editor's provenance fields attribute a remote mutation to the
 * authenticated operation rather than to the local panel's selected voice. */
export const collaborationRemoteOperationAnnotation =
  Annotation.define<CollaborationSignedOperation>();

const collaborationHistoryAlreadyAppliedAnnotation = Annotation.define<boolean>();

interface ConcreteChange {
  from: number;
  to: number;
  insert: string;
}

interface YTextDeltaPart {
  retain?: number;
  insert?: string | object;
  delete?: number;
}

export interface CollaborationCodeMirrorTarget {
  readonly state: EditorState;
  dispatch(spec: TransactionSpec): void;
}

export interface CollaborationRemoteSelection {
  participantPubkey: string;
  actorPubkey: string;
  timestamp: number;
  selection: EditorSelectionState;
}

export interface CollaborationPrivateForkState {
  fileId: string;
  actorPubkey: string;
  reason: CollaborationPrivateTextPatch["reason"];
  baseText: string;
  text: string;
  patch: CollaborationPrivateTextPatch;
}

export interface CollaborationCodeMirrorBindingOptions {
  replica: CollaborationReplica;
  fileId: string;
  actorPubkey: string;
  secretKey: Uint8Array;
  /** Use the editor-owned Step log's sequence allocator at integration time. */
  takeNextSequence?: () => number;
  /** Cursor-only Awareness updates are trailing-edge throttled. */
  presenceThrottleMs?: number;
  /** Signed edit batches are flushed after this short idle window. */
  editBatchMs?: number;
  /** Hard bound on transaction evidence covered by one signature. */
  maxEditBatchTransactions?: number;
  /** Approximate UTF-8 evidence bound covered by one signature. */
  maxEditBatchBytes?: number;
  onRemoteSelectionsChange?: (
    selections: readonly CollaborationRemoteSelection[],
  ) => void;
  onPrivateForkChange?: (fork: CollaborationPrivateForkState) => void;
  onError?: (error: unknown) => void;
}

function selectionState(selection: EditorSelection): EditorSelectionState {
  return {
    ranges: selection.ranges.map(({ anchor, head }) => ({ anchor, head })),
    main: selection.mainIndex,
  };
}

function clonePrivatePatch(patch: CollaborationPrivateTextPatch): CollaborationPrivateTextPatch {
  return {
    ...patch,
    editorTransactions: [...patch.editorTransactions],
  };
}

function cloneFork(fork: CollaborationPrivateForkState): CollaborationPrivateForkState {
  return {
    ...fork,
    patch: clonePrivatePatch(fork.patch),
  };
}

function applyConcreteChanges(
  text: Y.Text,
  changes: readonly ConcreteChange[],
): void {
  for (const change of [...changes].sort(
    (left, right) => right.from - left.from || right.to - left.to,
  )) {
    if (change.to > change.from) {
      text.delete(change.from, change.to - change.from);
    }
    if (change.insert.length > 0) text.insert(change.from, change.insert);
  }
}

function editorTransactionChanges(
  transaction: EditorTransaction,
): ConcreteChange[] {
  return transaction.changes.map((change) => ({
    from: change.from,
    to: change.to,
    insert: change.text,
  }));
}

/**
 * Convert a Y.Text delta to CodeMirror's pre-transaction coordinate space.
 * Adjacent delete/insert pairs are coalesced so replacements remain one
 * incremental CodeMirror change instead of an overlapping pair.
 */
export function yTextDeltaToCodeMirrorChanges(
  delta: readonly YTextDeltaPart[],
): ConcreteChange[] {
  const changes: ConcreteChange[] = [];
  let oldPosition = 0;
  let pending: ConcreteChange | null = null;

  const flush = () => {
    if (pending) changes.push(pending);
    pending = null;
  };

  for (const part of delta) {
    if (part.retain !== undefined) {
      flush();
      oldPosition += part.retain;
    }
    if (part.delete !== undefined) {
      const amount = part.delete;
      if (
        pending &&
        (
          (pending.from === oldPosition && pending.to === oldPosition) ||
          pending.to === oldPosition
        )
      ) {
        pending.to = oldPosition + amount;
      } else {
        flush();
        pending = {
          from: oldPosition,
          to: oldPosition + amount,
          insert: "",
        };
      }
      oldPosition += amount;
    }
    if (part.insert !== undefined) {
      if (typeof part.insert !== "string") {
        throw new Error("Collaboration file text cannot contain Yjs embeds");
      }
      if (
        pending &&
        (
          pending.from === oldPosition ||
          pending.to === oldPosition
        )
      ) {
        pending.insert += part.insert;
      } else {
        flush();
        pending = {
          from: oldPosition,
          to: oldPosition,
          insert: part.insert,
        };
      }
    }
  }
  flush();
  return changes;
}

/**
 * Composable binding between one CodeMirror panel and one Collaboration file.
 *
 * Shared Y.Text is changed only through prepared replica edits, which are
 * micro-batched into signed operations before broadcast. A private mirror owns the
 * actor-scoped Y.UndoManager; undo/redo results are submitted as ordinary
 * signed editor transactions instead of allowing the UndoManager to mutate
 * the shared document directly.
 */
export class CollaborationCodeMirrorBinding {
  readonly extension: Extension;
  readonly undoManager: Y.UndoManager;

  private readonly replica: CollaborationReplica;
  private readonly fileId: string;
  private readonly actorPubkey: string;
  private readonly secretKey: Uint8Array;
  private readonly sharedOrigin = Object.freeze({
    kind: "collaboration-codemirror-local",
  });
  private readonly historyOrigin = Object.freeze({
    kind: "collaboration-codemirror-history",
  });
  private readonly remoteHistoryOrigin = Object.freeze({
    kind: "collaboration-codemirror-remote-history",
  });
  private readonly sharedText: Y.Text;
  private readonly historyDoc = new Y.Doc();
  private readonly historyText: Y.Text;
  private readonly takeNextSequence: () => number;
  private readonly presenceThrottleMs: number;
  private readonly editBatchMs: number;
  private readonly maxEditBatchTransactions: number;
  private readonly maxEditBatchBytes: number;
  private readonly onRemoteSelectionsChange?: (
    selections: readonly CollaborationRemoteSelection[],
  ) => void;
  private readonly onPrivateForkChange?: (fork: CollaborationPrivateForkState) => void;
  private readonly onError?: (error: unknown) => void;
  private readonly unsubscribePresence: () => void;
  private readonly unsubscribeBeforeRemoteOperation: () => void;

  private target: CollaborationCodeMirrorTarget | null = null;
  private presenceTimer: ReturnType<typeof setTimeout> | null = null;
  private editBatchTimer: ReturnType<typeof setTimeout> | null = null;
  private preparedEdits: CollaborationPreparedEdit[] = [];
  private preparedEditBytes = 0;
  private sequence = 0;
  private fork: CollaborationPrivateForkState | null = null;
  private destroyed = false;
  private wasEditable: boolean;

  constructor(options: CollaborationCodeMirrorBindingOptions) {
    this.replica = options.replica;
    this.fileId = options.fileId;
    this.actorPubkey = options.actorPubkey;
    this.secretKey = options.secretKey;
    this.takeNextSequence =
      options.takeNextSequence ?? (() => this.sequence++);
    this.presenceThrottleMs = Math.max(
      0,
      options.presenceThrottleMs ?? 80,
    );
    this.editBatchMs = Math.max(0, options.editBatchMs ?? 80);
    this.maxEditBatchTransactions = Math.max(
      1,
      Math.floor(options.maxEditBatchTransactions ?? 32),
    );
    this.maxEditBatchBytes = Math.max(
      1,
      Math.floor(options.maxEditBatchBytes ?? 32 * 1024),
    );
    this.onRemoteSelectionsChange = options.onRemoteSelectionsChange;
    this.onPrivateForkChange = options.onPrivateForkChange;
    this.onError = options.onError;
    this.wasEditable = this.replica.canEditFile(
      this.fileId,
      this.actorPubkey,
    );

    this.sharedText = this.replica.fileText(this.fileId);
    this.historyText = this.historyDoc.getText("content");
    const initialText = this.sharedText.toString();
    if (initialText.length > 0) this.historyText.insert(0, initialText);
    this.undoManager = new Y.UndoManager(this.historyText, {
      captureTimeout: 0,
      trackedOrigins: new Set([this.historyOrigin]),
    });
    this.sharedText.observe(this.handleSharedText);
    this.unsubscribePresence = this.replica.subscribePresence(
      this.handlePresence,
    );
    this.unsubscribeBeforeRemoteOperation =
      this.replica.subscribeBeforeRemoteOperation((operation) => {
        if (
          operation.kind === "file.edit.batch" &&
          operation.payload.fileId === this.fileId
        ) {
          try {
            this.flushEdits();
          } catch (error) {
            this.onError?.(error);
          }
        }
      });

    const binding = this;
    this.extension = [
      ViewPlugin.fromClass(
        class {
          constructor(readonly view: EditorView) {
            binding.attach(view);
          }

          update(update: ViewUpdate): void {
            binding.handleTransactions(update.transactions, update.view);
          }

          destroy(): void {
            binding.detach(this.view);
          }
        },
      ),
      EditorView.domEventHandlers({
        blur: () => {
          try {
            binding.flushEdits();
          } catch (error) {
            binding.onError?.(error);
          }
          return false;
        },
      }),
    ];
  }

  attach(target: CollaborationCodeMirrorTarget): void {
    if (this.destroyed) throw new Error("Collaboration CodeMirror binding is destroyed");
    if (this.target && this.target !== target) {
      throw new Error("Collaboration CodeMirror binding already belongs to another panel");
    }
    const shared = this.sharedText.toString();
    if (target.state.doc.toString() !== shared && !this.fork) {
      throw new Error("CodeMirror document does not match its Collaboration file");
    }
    this.target = target;
    this.schedulePresence();
  }

  detach(target?: CollaborationCodeMirrorTarget): void {
    if (!target || this.target === target) {
      try {
        this.flushEdits();
      } catch (error) {
        this.onError?.(error);
      }
      this.target = null;
    }
  }

  /**
   * Public for non-DOM editor hosts and focused unit tests. EditorView users
   * normally receive this through `extension`.
   */
  handleTransactions(
    transactions: readonly Transaction[],
    target: CollaborationCodeMirrorTarget = this.requireTarget(),
  ): void {
    for (const transaction of transactions) {
      const remote = transaction.annotation(collaborationRemoteOperationAnnotation);
      if (remote) continue;
      if (transaction.docChanged) {
        this.handleLocalTextTransaction(transaction, target);
        if (!this.fork && this.preparedEdits.length === 0) {
          this.publishPresence(transaction.newSelection);
        }
      } else if (transaction.selection !== undefined && !this.fork) {
        this.schedulePresence();
      }
    }
  }

  private requireTarget(): CollaborationCodeMirrorTarget {
    if (!this.target) throw new Error("Collaboration CodeMirror binding has no panel");
    return this.target;
  }

  private handleLocalTextTransaction(
    transaction: Transaction,
    target: CollaborationCodeMirrorTarget,
  ): void {
    const editorTransaction = captureEditorTransaction(
      transaction,
      this.actorPubkey,
      this.takeNextSequence(),
    );
    if (!editorTransaction || editorTransaction.changes.length === 0) return;

    const historyAlreadyApplied =
      transaction.annotation(collaborationHistoryAlreadyAppliedAnnotation) === true;
    if (!historyAlreadyApplied) {
      this.historyDoc.transact(() => {
        applyConcreteChanges(
          this.historyText,
          editorTransactionChanges(editorTransaction),
        );
      }, this.historyOrigin);
      this.undoManager.stopCapturing();
    }

    if (
      this.fork ||
      !this.replica.canEditFile(this.fileId, this.actorPubkey)
    ) {
      this.flushEdits();
      this.preservePrivateFork(transaction, editorTransaction, target);
      return;
    }

    try {
      if (editorTransaction.intent) this.flushEdits();
      if (this.presenceTimer !== null) {
        clearTimeout(this.presenceTimer);
        this.presenceTimer = null;
      }
      const prepared = this.replica.prepareEditTransaction({
        fileId: this.fileId,
        actorPubkey: this.actorPubkey,
        secretKey: this.secretKey,
        editorTransaction,
        origin: this.sharedOrigin,
      });
      this.preparedEdits.push(prepared);
      this.preparedEditBytes += new TextEncoder()
        .encode(JSON.stringify(editorTransaction))
        .byteLength;
      this.wasEditable = true;
      if (
        editorTransaction.intent ||
        this.preparedEdits.length >= this.maxEditBatchTransactions ||
        this.preparedEditBytes >= this.maxEditBatchBytes ||
        this.editBatchMs === 0
      ) {
        this.flushEdits();
      } else {
        this.scheduleEditBatch();
      }
    } catch (error) {
      if (
        this.fork ||
        !this.replica.canEditFile(this.fileId, this.actorPubkey)
      ) {
        this.preservePrivateFork(transaction, editorTransaction, target);
        return;
      }
      this.onError?.(error);
      throw error;
    }
  }

  private preservePrivateFork(
    transaction: Transaction,
    editorTransaction: EditorTransaction,
    target: CollaborationCodeMirrorTarget,
  ): void {
    const reason = this.fork?.reason ??
      (this.wasEditable ? "capability-revoked" : "permission-denied");
    const patch = this.replica.preservePrivateTextPatch({
      fileId: this.fileId,
      actorPubkey: this.actorPubkey,
      baseText: transaction.startState.doc.toString(),
      editorTransaction,
      reason,
    });
    this.fork = {
      fileId: this.fileId,
      actorPubkey: this.actorPubkey,
      reason,
      baseText: this.fork?.baseText ??
        transaction.startState.doc.toString(),
      text: target.state.doc.toString(),
      patch,
    };
    this.onPrivateForkChange?.(cloneFork(this.fork));
  }

  private handleSharedText = (
    event: Y.YTextEvent,
    yTransaction: Y.Transaction,
  ): void => {
    if (yTransaction.origin === this.sharedOrigin || this.fork) return;
    const operation = collaborationOperationFromYjsOrigin(yTransaction.origin);
    if (
      !operation ||
      operation.kind !== "file.edit.batch" ||
      operation.payload.fileId !== this.fileId
    ) {
      return;
    }

    const target = this.target;
    const changes = yTextDeltaToCodeMirrorChanges(
      event.delta as readonly YTextDeltaPart[],
    );
    if (changes.length === 0) return;
    this.historyDoc.transact(() => {
      applyConcreteChanges(this.historyText, changes);
    }, this.remoteHistoryOrigin);
    if (target) {
      target.dispatch({
        changes: changes satisfies ChangeSpec,
        annotations: [
          collaborationRemoteOperationAnnotation.of(operation),
          Transaction.addToHistory.of(false),
        ],
      });
    }
    this.emitRemoteSelections();
  };

  private handlePresence = (_presence: CollaborationPresenceState | null): void => {
    this.emitRemoteSelections();
  };

  private emitRemoteSelections(): void {
    if (!this.onRemoteSelectionsChange) return;
    this.onRemoteSelectionsChange(this.remoteSelections());
  }

  remoteSelections(): CollaborationRemoteSelection[] {
    return this.replica.allPresence().flatMap((presence) => {
      if (
        presence.participantPubkey === this.replica.participantPubkey ||
        presence.activeFileId !== this.fileId
      ) {
        return [];
      }
      const selection = this.replica.resolvePresenceSelection(presence);
      return selection
        ? [{
            participantPubkey: presence.participantPubkey,
            actorPubkey: presence.actorPubkey,
            timestamp: presence.timestamp,
            selection,
          }]
        : [];
    });
  }

  private schedulePresence(): void {
    if (this.fork || !this.target || this.presenceTimer !== null) return;
    this.presenceTimer = setTimeout(() => {
      this.presenceTimer = null;
      this.publishPresence(this.target?.state.selection ?? null);
    }, this.presenceThrottleMs);
  }

  private scheduleEditBatch(): void {
    if (this.preparedEdits.length === 0) return;
    if (this.editBatchTimer !== null) clearTimeout(this.editBatchTimer);
    this.editBatchTimer = setTimeout(() => {
      this.editBatchTimer = null;
      try {
        this.flushEdits();
      } catch (error) {
        this.onError?.(error);
      }
    }, this.editBatchMs);
  }

  /** Flush pending transaction evidence before Step, file/voice switch, or teardown. */
  flushEdits(): CollaborationSignedOperation | null {
    if (this.editBatchTimer !== null) {
      clearTimeout(this.editBatchTimer);
      this.editBatchTimer = null;
    }
    if (this.preparedEdits.length === 0) return null;
    const edits = this.preparedEdits;
    this.preparedEdits = [];
    this.preparedEditBytes = 0;
    let operation: CollaborationSignedOperation;
    try {
      operation = this.replica.commitPreparedEditBatch({
        edits,
        secretKey: this.secretKey,
      });
    } catch (error) {
      try {
        const reason = this.replica.canEditFile(
            this.fileId,
            this.actorPubkey,
          )
          ? "commit-conflict"
          : "capability-revoked";
        const patch = this.replica.abandonPreparedEditBatch(edits, reason);
        this.fork = {
          fileId: this.fileId,
          actorPubkey: this.actorPubkey,
          reason,
          baseText: patch.baseText,
          text: this.target?.state.doc.toString() ?? patch.baseText,
          patch,
        };
        this.onPrivateForkChange?.(cloneFork(this.fork));
      } catch {
        this.preparedEdits = [...edits, ...this.preparedEdits];
        this.preparedEditBytes = this.preparedEdits.reduce(
          (total, edit) =>
            total +
            new TextEncoder()
              .encode(JSON.stringify(edit.editorTransaction))
              .byteLength,
          0,
        );
      }
      throw error;
    }
    if (!this.fork && this.target) {
      this.publishPresence(this.target.state.selection);
    }
    return operation;
  }

  pendingEditCount(): number {
    return this.preparedEdits.length;
  }

  flushPresence(): void {
    if (this.presenceTimer !== null) {
      clearTimeout(this.presenceTimer);
      this.presenceTimer = null;
    }
    if (!this.fork) {
      this.publishPresence(this.target?.state.selection ?? null);
    }
  }

  private publishPresence(selection: EditorSelection | null): void {
    if (this.fork) return;
    try {
      this.replica.submitPresence({
        activeFileId: this.fileId,
        selection: selection ? selectionState(selection) : null,
        actorPubkey: this.actorPubkey,
        secretKey: this.secretKey,
      });
    } catch (error) {
      // Presence is optional and ephemeral; lack of presence.write must never
      // block an otherwise-authorized signed text edit.
      this.onError?.(error);
    }
  }

  canUndo(): boolean {
    return this.undoManager.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.undoManager.redoStack.length > 0;
  }

  undo(): boolean {
    return this.runHistoryAction("undo");
  }

  redo(): boolean {
    return this.runHistoryAction("redo");
  }

  private runHistoryAction(intent: "undo" | "redo"): boolean {
    const target = this.requireTarget();
    const before = this.historyText.toString();
    if (target.state.doc.toString() !== before) {
      const error = new Error(
        "CodeMirror and actor undo history are out of sync",
      );
      this.onError?.(error);
      return false;
    }
    let changes: ConcreteChange[] = [];
    const captureChanges = (event: Y.YTextEvent) => {
      changes = yTextDeltaToCodeMirrorChanges(
        event.delta as readonly YTextDeltaPart[],
      );
    };
    this.historyText.observe(captureChanges);
    try {
      if (intent === "undo") this.undoManager.undo();
      else this.undoManager.redo();
    } finally {
      this.historyText.unobserve(captureChanges);
    }
    if (changes.length === 0) return false;
    target.dispatch({
      changes: changes satisfies ChangeSpec,
      annotations: [
        Transaction.userEvent.of(intent),
        collaborationHistoryAlreadyAppliedAnnotation.of(true),
        Transaction.addToHistory.of(false),
      ],
    });
    return true;
  }

  privateFork(): CollaborationPrivateForkState | null {
    return this.fork ? cloneFork(this.fork) : null;
  }

  destroy(): void {
    if (this.destroyed) return;
    try {
      this.flushEdits();
    } catch (error) {
      this.onError?.(error);
    }
    this.destroyed = true;
    if (this.editBatchTimer !== null) clearTimeout(this.editBatchTimer);
    this.editBatchTimer = null;
    if (this.presenceTimer !== null) clearTimeout(this.presenceTimer);
    this.presenceTimer = null;
    this.sharedText.unobserve(this.handleSharedText);
    this.unsubscribePresence();
    this.unsubscribeBeforeRemoteOperation();
    this.undoManager.destroy();
    this.historyDoc.destroy();
    this.target = null;
  }
}

/**
 * Factory used by panel integrations. Put `binding.extension` in a CodeMirror
 * Compartment, destroy the prior binding, then reconfigure the compartment
 * with the next file's extension.
 */
export function createCollaborationCodeMirrorBinding(
  options: CollaborationCodeMirrorBindingOptions,
): CollaborationCodeMirrorBinding {
  return new CollaborationCodeMirrorBinding(options);
}

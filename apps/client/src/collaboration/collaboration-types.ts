import type { EditorTransaction } from "@zine/protocol";

import type { MountScope } from "../workspace/mount-scope.js";

export const COLLABORATION_VERSION = 1;

export type CollaborationPermissionAction =
  | "collaboration.join"
  | "presence.write"
  | "file.read"
  | "file.edit"
  | "folder.create"
  | "entry.rename"
  | "entry.move"
  | "entry.delete"
  | "stage.view"
  | "stage.start"
  | "stage.control"
  | "stage.end"
  | "access.manage";

export type CollaborationCapabilityResource =
  | { kind: "collaboration" }
  | {
      kind: "entry";
      entryId: string;
      includeDescendants: boolean;
    };

/**
 * A capability is additive and default-deny. The participant identity signs
 * operations; actorPubkeys names the writing voices that signer may attribute
 * those operations to. An omitted actorPubkeys list permits only the signer
 * itself, making multi-voice authority explicit instead of implicit.
 */
export interface CollaborationCapability {
  id: string;
  subjectPubkey: string;
  resource: CollaborationCapabilityResource;
  actions: readonly CollaborationPermissionAction[];
  actorPubkeys?: readonly string[];
}

/**
 * Immutable invitation metadata for one Collaboration. This deliberately has
 * no panel, split, tab, or layout state: those remain private unless a later
 * Stage document explicitly references this collaboration.
 */
export interface CollaborationDefinition {
  version: typeof COLLABORATION_VERSION;
  collaborationId: string;
  ownerPubkey: string;
  mount: MountScope;
  capabilities: readonly CollaborationCapability[];
}

export interface CollaborationEntry {
  id: string;
  kind: "file" | "folder";
  parentId: string | null;
  name: string;
}

export interface CollaborationSeedEntry extends CollaborationEntry {
  text?: string;
}

export interface CollaborationEditBatchPayload {
  fileId: string;
  /**
   * Encoded Yjs snapshot immediately before this batch. Receivers reconstruct
   * that causal base to prove the update materializes the signed transactions.
   */
  baseSnapshot: string;
  /** Merged Yjs updates, hex encoded for deterministic signed JSON. */
  update: string;
  /**
   * Ordered actor-owned transaction evidence. The Yjs update owns convergence;
   * batching changes signature/network granularity, never replay granularity.
   */
  editorTransactions: EditorTransaction[];
}

export interface CollaborationEntryCreatePayload {
  entryId: string;
  parentId: string;
  entryKind: "file" | "folder";
  name: string;
  update: string;
  /** Initial Y.Text state for a newly-created file. */
  fileUpdate?: string;
}

export interface CollaborationEntryRenamePayload {
  entryId: string;
  name: string;
  update: string;
}

export interface CollaborationEntryMovePayload {
  entryId: string;
  parentId: string;
  update: string;
}

export interface CollaborationEntryDeletePayload {
  entryId: string;
  update: string;
}

export interface CollaborationRelativeSelectionRange {
  anchor: string;
  head: string;
}

export interface CollaborationRelativeSelection {
  ranges: CollaborationRelativeSelectionRange[];
  main: number;
}

export interface CollaborationPresencePayload {
  activeFileId: string | null;
  /** Yjs relative positions keep remote selections attached through edits. */
  selection: CollaborationRelativeSelection | null;
}

export type CollaborationOperationBody =
  | {
      version: typeof COLLABORATION_VERSION;
      collaborationId: string;
      nonce: string;
      participantPubkey: string;
      actorPubkey: string;
      timestamp: number;
      kind: "file.edit.batch";
      payload: CollaborationEditBatchPayload;
    }
  | {
      version: typeof COLLABORATION_VERSION;
      collaborationId: string;
      nonce: string;
      participantPubkey: string;
      actorPubkey: string;
      timestamp: number;
      kind: "entry.create";
      payload: CollaborationEntryCreatePayload;
    }
  | {
      version: typeof COLLABORATION_VERSION;
      collaborationId: string;
      nonce: string;
      participantPubkey: string;
      actorPubkey: string;
      timestamp: number;
      kind: "entry.rename";
      payload: CollaborationEntryRenamePayload;
    }
  | {
      version: typeof COLLABORATION_VERSION;
      collaborationId: string;
      nonce: string;
      participantPubkey: string;
      actorPubkey: string;
      timestamp: number;
      kind: "entry.move";
      payload: CollaborationEntryMovePayload;
    }
  | {
      version: typeof COLLABORATION_VERSION;
      collaborationId: string;
      nonce: string;
      participantPubkey: string;
      actorPubkey: string;
      timestamp: number;
      kind: "entry.delete";
      payload: CollaborationEntryDeletePayload;
    };

export type SignedCollaborationOperation<Body extends CollaborationOperationBody> =
  Body extends CollaborationOperationBody
    ? Body & {
        operationId: string;
        signature: string;
      }
    : never;

export type CollaborationSignedOperation = SignedCollaborationOperation<CollaborationOperationBody>;

export type CollaborationSignedOperationOf<Kind extends CollaborationOperationBody["kind"]> =
  Extract<CollaborationSignedOperation, { kind: Kind }>;

export type CollaborationSignedEditBatch =
  CollaborationSignedOperationOf<"file.edit.batch">;

export interface CollaborationPresenceState extends CollaborationPresencePayload {
  participantPubkey: string;
  actorPubkey: string;
  timestamp: number;
}

export interface CollaborationPrivateTextPatch {
  patchId: string;
  fileId: string;
  participantPubkey: string;
  actorPubkey: string;
  createdAt: number;
  reason: "permission-denied" | "capability-revoked" | "commit-conflict";
  baseText: string;
  editorTransactions: EditorTransaction[];
}

export interface CollaborationAcceptedPrefix {
  operationIds: string[];
  operations: CollaborationSignedOperation[];
}

export interface CollaborationBootstrapBody {
  recipientPubkey: string;
  nonce: string;
  timestamp: number;
  definition: CollaborationDefinition;
  directoryUpdate: string;
  fileUpdates: Readonly<Record<string, string>>;
  /** Complete history already materialized in the bootstrap snapshots. */
  operationHistory: readonly CollaborationSignedOperation[];
  /** The exact unstepped prefix that remains pending after bootstrap. */
  acceptedOperations: readonly CollaborationSignedOperation[];
}

/**
 * Initial snapshots are trusted only after this recipient-bound envelope is
 * verified against the collaboration owner's key. Later mutations remain signed
 * individually by their participant identities.
 */
export interface CollaborationBootstrap extends CollaborationBootstrapBody {
  bootstrapId: string;
  signature: string;
}

export type CollaborationOperationSource = "local" | "remote";

export interface CollaborationAcceptedOperation {
  operation: CollaborationSignedOperation;
  source: CollaborationOperationSource;
}

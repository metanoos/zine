import type {
  CollaborationCapability,
  CollaborationPermissionAction,
  CollaborationDefinition,
} from "./collaboration-types.js";

export interface CollaborationPermissionDirectory {
  hasEntry(entryId: string): boolean;
  isDescendantOrSelf(entryId: string, ancestorId: string): boolean;
}

const ATTRIBUTED_ACTIONS = new Set<CollaborationPermissionAction>([
  "presence.write",
  "file.edit",
  "folder.create",
  "entry.rename",
  "entry.move",
  "entry.delete",
]);

function actorPermitted(
  capability: CollaborationCapability,
  participantPubkey: string,
  actorPubkey: string,
): boolean {
  if (capability.subjectPubkey !== participantPubkey) return false;
  return capability.actorPubkeys === undefined
    ? actorPubkey === participantPubkey
    : capability.actorPubkeys.includes(actorPubkey);
}

function resourcePermitted(
  capability: CollaborationCapability,
  entryId: string | null,
  directory: CollaborationPermissionDirectory,
): boolean {
  if (capability.resource.kind === "collaboration") return true;
  if (entryId === null || !directory.hasEntry(entryId)) return false;
  if (capability.resource.entryId === entryId) return true;
  return (
    capability.resource.includeDescendants &&
    directory.isDescendantOrSelf(entryId, capability.resource.entryId)
  );
}

export function permitsCollaborationAction(
  definition: CollaborationDefinition,
  directory: CollaborationPermissionDirectory,
  participantPubkey: string,
  actorPubkey: string,
  action: CollaborationPermissionAction,
  entryId: string | null,
): boolean {
  if (participantPubkey === definition.ownerPubkey) return true;
  return definition.capabilities.some(
    (capability) =>
      capability.subjectPubkey === participantPubkey &&
      capability.actions.includes(action) &&
      (
        !ATTRIBUTED_ACTIONS.has(action) ||
        actorPermitted(capability, participantPubkey, actorPubkey)
      ) &&
      resourcePermitted(capability, entryId, directory),
  );
}

export function permitsCollaborationRead(
  definition: CollaborationDefinition,
  directory: CollaborationPermissionDirectory,
  participantPubkey: string,
  entryId: string,
): boolean {
  if (participantPubkey === definition.ownerPubkey) return true;
  return definition.capabilities.some(
    (capability) =>
      capability.subjectPubkey === participantPubkey &&
      (
        capability.actions.includes("file.read") ||
        capability.actions.includes("file.edit")
      ) &&
      resourcePermitted(capability, entryId, directory),
  );
}

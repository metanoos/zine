import { isOblivionPath } from "./generated-paths.js";

/** Explain the lifecycle consequence behind the sidebar's Delete action. */
export function deleteOutcomeMessage(paths: readonly string[]): string {
  const oblivionCount = paths.filter(isOblivionPath).length;
  const outsideCount = paths.length - oblivionCount;

  if (outsideCount > 0 && oblivionCount > 0) {
    return "Items outside Oblivion will be moved there and can be restored. Items already in Oblivion will be permanently deleted.";
  }
  if (oblivionCount > 0) {
    return paths.length === 1
      ? "Deleting it from Oblivion is permanent and cannot be undone."
      : "Deleting them from Oblivion is permanent and cannot be undone.";
  }
  return paths.length === 1
    ? "It will be moved to Oblivion, where it can be restored."
    : "They will be moved to Oblivion, where they can be restored.";
}

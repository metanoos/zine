/**
 * The client's notion of which folder is attached — the workspace source of
 * truth. Stored in `localStorage` rather than a file on disk: the app remembers
 * one folder at a time, per browser/machine profile.
 *
 * `id` is a UUID minted on first attach and frozen thereafter, so a folder's
 * provenance chain (kind-4290/34290 events tagged `#D=[folderId]`) stays
 * stable across reloads — the same folder reopens to the same identity, and
 * its manifest is found by that id.
 *
 * `path` is the absolute disk path on the **desktop** (what the Tauri disk
 * commands resolve relative paths under). It is optional: the **webapp** has
 * no disk, so its attached folder carries only an `id` (the folder lives on
 * the relay). The path is NEVER sent to the relay — the relay only ever sees
 * the folderId + relative paths.
 *
 * `AttachedFolder` is now identical in shape to `FolderRef` from
 * workspace-core; this re-exports that type so existing call sites keep
 * working while the codebase migrates to the `Workspace` interface.
 */

import type { FolderRef } from "./workspace-core.js";

const STORAGE_KEY = "zine.attachedFolder";

/** The attached folder. `path` is present on desktop, undefined on webapp. */
export type AttachedFolder = FolderRef;

export function loadAttachedFolder(): AttachedFolder | null {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<AttachedFolder>;
    if (typeof parsed.id === "string") {
      return { id: parsed.id, path: parsed.path, label: parsed.label };
    }
  } catch {
    // fall through — malformed entry is treated as absent and cleared.
  }
  localStorage.removeItem(STORAGE_KEY);
  return null;
}

export function saveAttachedFolder(folder: AttachedFolder): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(folder));
}

export function clearAttachedFolder(): void {
  localStorage.removeItem(STORAGE_KEY);
}

export function uuid(): string {
  // crypto.randomUUID is available in all modern browsers and the Tauri webview.
  return crypto.randomUUID();
}


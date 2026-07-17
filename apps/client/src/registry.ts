/**
 * The attached-folder shape shared by the workspace layers.
 *
 * `id` is the signed folder genesis event id. It stays stable across reloads,
 * and later folder TraceNodes carry it in their `f` tag.
 *
 * `path` is the absolute disk path on the **desktop** (what the Tauri disk
 * commands resolve relative paths under). It is optional: the **webapp** has
 * no disk, so its attached folder carries only an `id` (the folder lives on
 * the relay). The path is NEVER sent to the relay — the relay only ever sees
 * the folderId + relative paths.
 *
 * `AttachedFolder` is identical in shape to `FolderRef` from workspace-core;
 * this module exposes the workspace-facing name.
 */

import type { FolderRef } from "./workspace-core.js";

/** The attached folder. `path` is present on desktop, undefined on webapp. */
export type AttachedFolder = FolderRef;

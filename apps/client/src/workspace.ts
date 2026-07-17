/**
 * Native filesystem bridge used by the React client.
 *
 * Workspace mutation and relay synchronization live in `workspace-local.ts`,
 * which is the active backend for both the client and MCP press. This module is
 * intentionally limited to the Tauri operations that still cross the native
 * boundary: choosing a source, scanning it, and reifying traces to disk.
 */

export type { AttachedFolder } from "./registry.js";
export type { Run, FileState } from "./workspace-core.js";
export type { EventMeta, SampleEventMeta } from "./provenance.js";

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke: tauriInvoke } = await import("@tauri-apps/api/core");
  return (await tauriInvoke(cmd as never, args as never)) as T;
}

/** Show a native folder picker and return the chosen absolute path, or null
 * if the user cancelled. */
export async function chooseFolder(): Promise<string | null> {
  return invoke<string | null>("pick_folder");
}

/** Show a native single-file picker and return the chosen absolute path, or
 * null if the user cancelled. */
export async function chooseFile(): Promise<string | null> {
  return invoke<string | null>("pick_file");
}

/** A foreign snapshot acquired from a substrate. */
export interface ScannedFile {
  relativePath: string;
  content: string;
}

/** Read an external file or folder that the user explicitly picked. */
export async function scanExternal(absPath: string): Promise<ScannedFile[]> {
  return invoke<ScannedFile[]>("scan_external", { absPath });
}

/** Emit already-materialized text entries to a chosen destination folder.
 * Callers resolve authoritative stepped snapshots before crossing this native
 * boundary; this writer never reconstructs or decorates trace content.
 * Existing files at matching relative paths are overwritten. */
export async function reifyToDisk(
  destRoot: string,
  entries: { relativePath: string; content: string }[],
): Promise<void> {
  for (const { relativePath, content } of entries) {
    await invoke<null>("write_text_file", {
      root: destRoot,
      relativePath,
      contents: content,
    });
  }
}

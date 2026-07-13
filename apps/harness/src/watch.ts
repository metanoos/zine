import * as fs from 'node:fs';
import * as path from 'node:path';

import type { AttachedFolder } from './models.js';
import type { ProvenanceStore } from './store.js';

const DEBOUNCE_MS = 400;
const IGNORED_SEGMENTS = new Set(['.git', 'node_modules', '.next', '.dart_tool', 'build', '.tracer', '.DS_Store']);

/**
 * External-edit watcher: any save made outside the harness (by hand, by
 * another editor) is diffed against the last traced content and sealed as
 * an action: "edit" node. Mirrors apps/tracer's Dart watcher — same
 * debounce + hash-compare approach, so a touch with no content change
 * doesn't spawn a spurious node, and atomic temp-file-swap saves (common in
 * editors) are handled by always diffing actual content rather than
 * trusting the fs event type.
 */
export function watchFolder(store: ProvenanceStore, folder: AttachedFolder): fs.FSWatcher {
  const timers = new Map<string, NodeJS.Timeout>();

  const watcher = fs.watch(folder.path, { recursive: true }, (_eventType, filename) => {
    if (!filename) return;
    const segments = filename.split(path.sep);
    if (segments.some((s) => IGNORED_SEGMENTS.has(s))) return;

    const absPath = path.join(folder.path, filename);
    const existingTimer = timers.get(absPath);
    if (existingTimer) clearTimeout(existingTimer);
    timers.set(
      absPath,
      setTimeout(() => {
        timers.delete(absPath);
        handleSettledChange(store, folder, absPath).catch((err) => console.error('watch error:', err));
      }, DEBOUNCE_MS),
    );
  });

  return watcher;
}

async function handleSettledChange(store: ProvenanceStore, folder: AttachedFolder, absPath: string): Promise<void> {
  if (!fs.existsSync(absPath)) {
    await store.markDeleted(folder, absPath);
    return;
  }
  let content: string;
  try {
    content = fs.readFileSync(absPath, 'utf8');
  } catch {
    return; // binary or transient read error mid-write
  }
  const file = await store.ensureFileTracked(folder, absPath);
  const node = await store.recordSnapshot(file, content, 'edit');
  if (node) {
    console.log(`${new Date(node.sealedAt).toISOString()}  [edit]  ${path.relative(folder.path, absPath)}`);
  }
}

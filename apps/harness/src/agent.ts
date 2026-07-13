import * as fs from 'node:fs';
import * as path from 'node:path';

import type { Provider } from './providers/types.js';
import type { ProvenanceStore } from './store.js';
import type { AttachedFolder, TraceNode } from './models.js';
import type { PinnedSpan } from './pins.js';
import { restorePins, type PinResult } from './pin-restore.js';

/**
 * v1 agent loop: single target file, full-rewrite edits. The model reads
 * the file's current content plus your instruction, returns the file's new
 * full content, the harness writes it to disk, and that write is sealed as
 * an action: "llm" TraceNode with the prompt captured — per the protocol's
 * seal-on-LLM-invocation trigger. No tool-calling or multi-file
 * orchestration yet; that's a larger scope than "plug in a key and edit a
 * file" and can build on this once this path is solid.
 *
 * Pinned spans: if `pins` is non-empty, the model still produces a
 * full-file rewrite (whole-document coherence preserved), then `restorePins`
 * enforces each pin against that output — survived pins are left alone,
 * altered ones are restored to their canonical text, and un-locatable ones
 * surface as conflicts. The restored (not raw model) content is what
 * reaches disk and the trace. Because `recordSnapshot` diffs pre-rewrite
 * against post-restore, a restored pin is `DIFF_EQUAL` → no delta; the
 * model's transient alteration never reaches the provenance layer, so a
 * pin's text is continuous across rounds. That is the "sediment accrues"
 * property, and it holds without any protocol change — `summary` (already
 * in the spec) carries the enforcement outcome for human legibility.
 */
export async function runLlmEdit(opts: {
  store: ProvenanceStore;
  folder: AttachedFolder;
  absPath: string;
  instruction: string;
  provider: Provider;
  pins?: PinnedSpan[];
}): Promise<{ node: TraceNode | null; newContent: string; pinResults: PinResult[] }> {
  const { store, folder, absPath, instruction, provider } = opts;
  const pins = opts.pins ?? [];

  const file = await store.ensureFileTracked(folder, absPath);
  const currentContent = await store.reconstructContent(file.folderId, file.relativePath);

  const systemPrompt =
    'You edit a single text file on the user\'s behalf. You will be given the ' +
    "file's current full content and an instruction. Respond with ONLY the " +
    "file's complete new content after applying the instruction — no commentary, " +
    'no markdown code fences, no explanation. If the instruction does not require ' +
    'changes, return the content unchanged.';

  const userPrompt = `File: ${file.relativePath}\n\nCurrent content:\n${currentContent}\n\nInstruction:\n${instruction}`;

  const modelOutput = await provider.complete({ systemPrompt, userPrompt });

  const { restored, results } = restorePins(currentContent, modelOutput, pins);

  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, restored, 'utf8');

  const summary = summarizePinResults(results);
  const node = await store.recordSnapshot(file, restored, 'llm', instruction, summary);
  return { node, newContent: restored, pinResults: results };
}

/** Builds the spec's `summary` field from pin enforcement. Null when there
 * were no pins (so pinless files behave exactly as before — no `summary`
 * on the event, matching the existing code path). */
function summarizePinResults(results: PinResult[]): string | null {
  if (results.length === 0) return null;
  const survived = results.filter((r) => r.outcome === 'survived').length;
  const restored = results.filter((r) => r.outcome === 'restored').length;
  const conflicts = results.filter((r) => r.outcome === 'conflict').length;
  const parts = [`${survived} survived`, `${restored} restored`];
  if (conflicts > 0) parts.push(`${conflicts} conflict(s)`);
  return `pins: ${parts.join(', ')}`;
}

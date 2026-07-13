import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * A span of a file marked "settled." The pin *is* its canonical `text` —
 * offsets are deliberately not stored, because they are meaningless after
 * any rewrite. Location is re-derived each round by matching `text`
 * (anchored on its neighborhood) against current content; see
 * `pin-restore.ts`. This is what lets a pin survive arbitrary rewrites and
 * lets sediment accrue: the pin's identity is its content, not where it sat.
 *
 * Pins are local editor/workflow state, in the same category as attached
 * folders (`Registry`) and voices (`VoiceRegistry`) — NOT relay data, NOT
 * signed, NOT synced. The "no parallel local content store" decision
 * (HANDOFF.md) was about edit *history*; pins are not history. The deferred
 * `sign` action (trace-provenance.md) is the path to making "fixed" a
 * durable, signed, composable fact — that's a protocol change, out of scope
 * for this first cut.
 */
export interface PinnedSpan {
  id: string;
  text: string;
  note?: string;
  pinnedAt: number;
}

interface FilePins {
  folderPath: string;
  relativePath: string;
  spans: PinnedSpan[];
}

interface PinsFile {
  files: FilePins[];
}

/**
 * Owns the local pins file (`~/.tracer/pins.json`). Mirrors `Registry`'s
 * shape: constructor reads the file (or seeds empty), methods mutate and
 * persist on every change. `overrideDir` exists for tests, same as
 * `Registry`.
 */
export class PinRegistry {
  private filePath: string;
  private data: PinsFile;

  constructor(overrideDir?: string) {
    const dir = overrideDir ?? path.join(os.homedir(), '.tracer');
    fs.mkdirSync(dir, { recursive: true });
    this.filePath = path.join(dir, 'pins.json');
    this.data = fs.existsSync(this.filePath) ? this.read() : { files: [] };
  }

  listPins(folderPath: string, relativePath: string): PinnedSpan[] {
    return this.findFile(folderPath, relativePath)?.spans ?? [];
  }

  addPin(folderPath: string, relativePath: string, text: string, note?: string): PinnedSpan {
    const normalized = text;
    const span: PinnedSpan = { id: randomUUID(), text: normalized, pinnedAt: Date.now() };
    if (note) span.note = note;
    const file = this.findOrCreateFile(folderPath, relativePath);
    file.spans.push(span);
    this.save();
    return span;
  }

  removePin(folderPath: string, relativePath: string, pinId: string): boolean {
    const file = this.findFile(folderPath, relativePath);
    if (!file) return false;
    const before = file.spans.length;
    file.spans = file.spans.filter((s) => s.id !== pinId);
    const removed = file.spans.length < before;
    if (removed) this.save();
    return removed;
  }

  private findFile(folderPath: string, relativePath: string): FilePins | undefined {
    return this.data.files.find(
      (f) => f.folderPath === folderPath && f.relativePath === relativePath,
    );
  }

  private findOrCreateFile(folderPath: string, relativePath: string): FilePins {
    let file = this.findFile(folderPath, relativePath);
    if (!file) {
      file = { folderPath, relativePath, spans: [] };
      this.data.files.push(file);
    }
    return file;
  }

  private read(): PinsFile {
    return JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as PinsFile;
  }

  private save(): void {
    fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
  }
}

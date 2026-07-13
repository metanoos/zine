import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { Event, EventTemplate } from 'nostr-tools';
import type { Relay } from 'nostr-tools/relay';
import type { Signer } from 'nostr-tools/signer';

import { applyDeltas, computeDeltas } from './diff.js';
import type {
  Action,
  AttachedFolder,
  DeltaRecord,
  DeltaSpan,
  ManifestFileEntry,
  TraceNode,
  TraceNodeWithDeltas,
  WatchedFile,
} from './models.js';
import { FILE_TRACE_NODE_KIND, FOLDER_MANIFEST_KIND } from './protocol-kinds.js';
import { queryEvents, queryLatest } from './relay-client.js';
import type { Registry } from './registry.js';

const IGNORED_SEGMENTS = new Set(['.git', 'node_modules', '.next', '.dart_tool', 'build', '.tracer', '.DS_Store']);

/**
 * Owns folder attachment and sealing of TraceNodes, but no longer owns its
 * own storage schema — local storage *is* the local relay now. Every seal
 * publishes a real signed kind-4290 event and republishes the folder's
 * kind-34290 manifest; reads walk the chain by fetching events from the
 * relay rather than querying a bespoke sqlite table. See
 * protocol/trace-provenance.md for the wire shapes.
 *
 * Signing goes through a `Signer` (nostr-tools) rather than a raw secret
 * key, so the same store works whether the active voice is a locally
 * generated keypair or an external NIP-46 signer — the store never sees
 * or needs to care which.
 */
export class ProvenanceStore {
  constructor(
    private relay: Relay,
    private signer: Signer,
    private registry: Registry,
  ) {}

  async attachFolder(folderPath: string): Promise<AttachedFolder> {
    const normalized = path.resolve(folderPath);
    const existing = this.registry.findFolderByPath(normalized);
    if (existing) return existing;

    const folder: AttachedFolder = { id: randomUUID(), path: normalized, attachedAt: Date.now() };
    this.registry.insertFolder(folder);
    await this.baselineScan(folder);
    return folder;
  }

  private async baselineScan(folder: AttachedFolder): Promise<void> {
    for (const absPath of walk(folder.path)) {
      await this.importFile(folder, absPath);
    }
  }

  private async importFile(folder: AttachedFolder, absPath: string): Promise<WatchedFile | null> {
    const content = tryReadText(absPath);
    if (content === null) return null;

    const relativePath = path.relative(folder.path, absPath);
    const sealedAt = Date.now();
    const spans: DeltaSpan[] =
      content.length > 0
        ? [{ type: 'insert', positionStart: 0, positionEnd: 0, oldValue: null, newValue: content }]
        : [];

    const event = await this.publishTraceNode(folder.id, relativePath, {
      prevEventId: null,
      action: 'import',
      deltas: stampTimestamps(spans, sealedAt),
      contentHash: hash(content),
      prompt: null,
      summary: null,
      sealedAt,
    });

    await this.upsertManifestEntry(folder.id, {
      relativePath,
      latestNodeId: event.id,
      isDeleted: false,
      contentHash: hash(content),
    });

    return { folderId: folder.id, relativePath, absolutePath: absPath, latestNodeId: event.id, isDeleted: false };
  }

  /** Finds the tracked file for absPath within folder, importing it first if it isn't tracked yet. */
  async ensureFileTracked(folder: AttachedFolder, absPath: string): Promise<WatchedFile> {
    const relativePath = path.relative(folder.path, absPath);
    const manifest = await this.fetchManifest(folder.id);
    const entry = manifest.find((f) => f.relativePath === relativePath);
    if (entry) {
      return {
        folderId: folder.id,
        relativePath,
        absolutePath: absPath,
        latestNodeId: entry.latestNodeId,
        isDeleted: entry.isDeleted,
      };
    }
    const imported = await this.importFile(folder, absPath);
    if (!imported) throw new Error(`Could not read ${absPath} as text`);
    return imported;
  }

  async reconstructContent(folderId: string, relativePath: string): Promise<string> {
    const chain = await this.fetchChain(folderId, relativePath);
    let content = '';
    for (const event of chain) {
      content = applyDeltas(content, parseDeltas(event));
    }
    return content;
  }

  /**
   * Diffs newContent against the file's last known (reconstructed)
   * content and seals + publishes a node if it changed. Used by both the
   * external-edit watcher and the agent loop after it writes a file back
   * to disk.
   */
  async recordSnapshot(
    file: WatchedFile,
    newContent: string,
    action: Action,
    prompt: string | null = null,
    summary: string | null = null,
  ): Promise<TraceNode | null> {
    const newHash = hash(newContent);
    const manifest = await this.fetchManifest(file.folderId);
    const entry = manifest.find((f) => f.relativePath === file.relativePath);
    if (entry && entry.contentHash === newHash) return null; // no-op touch, skip without reconstructing

    const oldContent = await this.reconstructContent(file.folderId, file.relativePath);
    const spans = computeDeltas(oldContent, newContent);
    if (spans.length === 0) return null;

    const sealedAt = Date.now();
    const event = await this.publishTraceNode(file.folderId, file.relativePath, {
      prevEventId: entry?.latestNodeId ?? file.latestNodeId,
      action,
      deltas: stampTimestamps(spans, sealedAt),
      contentHash: newHash,
      prompt,
      summary,
      sealedAt,
    });

    await this.upsertManifestEntry(file.folderId, {
      relativePath: file.relativePath,
      latestNodeId: event.id,
      isDeleted: false,
      contentHash: newHash,
    });

    return nodeFromEvent(event);
  }

  async markDeleted(folder: AttachedFolder, absPath: string): Promise<void> {
    const relativePath = path.relative(folder.path, absPath);
    const manifest = await this.fetchManifest(folder.id);
    const entry = manifest.find((f) => f.relativePath === relativePath);
    if (!entry || entry.isDeleted) return;

    const sealedAt = Date.now();
    const event = await this.publishTraceNode(folder.id, relativePath, {
      prevEventId: entry.latestNodeId,
      action: 'delete',
      deltas: [],
      contentHash: entry.contentHash,
      prompt: null,
      summary: null,
      sealedAt,
    });

    await this.upsertManifestEntry(folder.id, { ...entry, latestNodeId: event.id, isDeleted: true });
  }

  async listFiles(folder: AttachedFolder): Promise<WatchedFile[]> {
    const manifest = await this.fetchManifest(folder.id);
    return manifest
      .filter((f) => !f.isDeleted)
      .map((f) => ({
        folderId: folder.id,
        relativePath: f.relativePath,
        absolutePath: path.join(folder.path, f.relativePath),
        latestNodeId: f.latestNodeId,
        isDeleted: f.isDeleted,
      }));
  }

  async timelineForFile(folderId: string, relativePath: string): Promise<TraceNodeWithDeltas[]> {
    const chain = await this.fetchChain(folderId, relativePath);
    return chain.map((event) => ({ node: nodeFromEvent(event), deltas: parseDeltas(event) }));
  }

  // -- relay plumbing -------------------------------------------------------

  private async publishTraceNode(
    folderId: string,
    relativePath: string,
    opts: {
      prevEventId: string | null;
      action: Action;
      deltas: DeltaRecord[];
      contentHash: string;
      prompt: string | null;
      summary: string | null;
      sealedAt: number;
    },
  ): Promise<Event> {
    const tags: string[][] = [
      ['file', relativePath],
      ['folder', folderId],
      ['F', relativePath],
      ['D', folderId],
      ['action', opts.action],
    ];
    if (opts.prevEventId) tags.push(['e', opts.prevEventId, '', 'prev']);

    const template: EventTemplate = {
      kind: FILE_TRACE_NODE_KIND,
      created_at: Math.floor(opts.sealedAt / 1000),
      tags,
      content: JSON.stringify({
        sealedAt: opts.sealedAt,
        deltas: opts.deltas.map((d) => ({
          type: d.type,
          position: { start: d.positionStart, end: d.positionEnd },
          oldValue: d.oldValue,
          newValue: d.newValue,
          timestamp: d.timestamp,
        })),
        contentHash: opts.contentHash,
        ...(opts.prompt ? { prompt: opts.prompt } : {}),
        ...(opts.summary ? { summary: opts.summary } : {}),
      }),
    };

    const signed = await this.signer.signEvent(template);
    await this.relay.publish(signed);
    return signed;
  }

  private async fetchManifestEvent(folderId: string): Promise<Event | null> {
    return queryLatest(this.relay, { kinds: [FOLDER_MANIFEST_KIND], '#d': [folderId] });
  }

  private async fetchManifest(folderId: string): Promise<ManifestFileEntry[]> {
    const event = await this.fetchManifestEvent(folderId);
    if (!event) return [];
    const parsed = JSON.parse(event.content) as { files: ManifestFileEntry[] };
    return parsed.files;
  }

  private async upsertManifestEntry(folderId: string, entry: ManifestFileEntry): Promise<void> {
    const previous = await this.fetchManifestEvent(folderId);
    const currentFiles = previous ? (JSON.parse(previous.content) as { files: ManifestFileEntry[] }).files : [];
    const next = currentFiles.filter((f) => f.relativePath !== entry.relativePath);
    next.push(entry);

    // FolderManifest is a NIP-33 replaceable event: relays keep whichever
    // publish has the higher created_at (falling back to event id on a
    // tie). Two manifest publishes can easily land in the same
    // wall-clock second — successive saves, or an import immediately
    // followed by an edit — so created_at must be forced strictly forward
    // of the previous manifest, not just read off the clock, or "latest
    // wins" isn't actually guaranteed.
    const createdAt = Math.max(Math.floor(Date.now() / 1000), (previous?.created_at ?? 0) + 1);

    const template: EventTemplate = {
      kind: FOLDER_MANIFEST_KIND,
      created_at: createdAt,
      tags: [['d', folderId], ...next.map((f) => ['e', f.latestNodeId])],
      content: JSON.stringify({ files: next }),
    };
    const signed = await this.signer.signEvent(template);
    await this.relay.publish(signed);
  }

  /**
   * Fetches every trace node tagged with (folderId, relativePath) in one
   * relay round trip, then walks the prev-chain locally to establish exact
   * order — never trusting created_at (second-resolution, per NIP-01) for
   * ordering, since the chain's own e...prev links are authoritative.
   */
  private async fetchChain(folderId: string, relativePath: string): Promise<Event[]> {
    const manifest = await this.fetchManifest(folderId);
    const entry = manifest.find((f) => f.relativePath === relativePath);
    if (!entry) return [];

    const all = await queryEvents(this.relay, {
      kinds: [FILE_TRACE_NODE_KIND],
      '#F': [relativePath],
      '#D': [folderId],
    });
    const byId = new Map(all.map((e) => [e.id, e]));

    const chain: Event[] = [];
    let cursor: string | undefined = entry.latestNodeId;
    while (cursor) {
      const event: Event | undefined = byId.get(cursor);
      if (!event) break;
      chain.push(event);
      cursor = prevIdOf(event);
    }
    return chain.reverse();
  }
}

function prevIdOf(event: Event): string | undefined {
  return event.tags.find((t) => t[0] === 'e' && t[3] === 'prev')?.[1];
}

function nodeFromEvent(event: Event): TraceNode {
  const content = JSON.parse(event.content) as { sealedAt: number; contentHash: string; prompt?: string; summary?: string };
  return {
    id: event.id,
    prevNodeId: prevIdOf(event) ?? null,
    action: (event.tags.find((t) => t[0] === 'action')?.[1] ?? 'edit') as Action,
    sealedAt: content.sealedAt,
    contentHash: content.contentHash,
    prompt: content.prompt ?? null,
    summary: content.summary ?? null,
  };
}

interface RawDelta {
  type: DeltaRecord['type'];
  position: { start: number; end: number };
  oldValue: string | null;
  newValue: string | null;
  timestamp: number;
}

function parseDeltas(event: Event): DeltaRecord[] {
  const content = JSON.parse(event.content) as { deltas: RawDelta[] };
  return content.deltas.map((d) => ({
    type: d.type,
    positionStart: d.position.start,
    positionEnd: d.position.end,
    oldValue: d.oldValue,
    newValue: d.newValue,
    timestamp: d.timestamp,
  }));
}

function* walk(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (IGNORED_SEGMENTS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

function tryReadText(absPath: string): string | null {
  try {
    return fs.readFileSync(absPath, 'utf8');
  } catch {
    return null;
  }
}

function hash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/** All spans from one diff share a timestamp — a snapshot diff has no way
 * to know when within its window each span actually happened. */
function stampTimestamps(spans: DeltaSpan[], timestamp: number): DeltaRecord[] {
  return spans.map((s) => ({ ...s, timestamp }));
}

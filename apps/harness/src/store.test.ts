import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';

import { Relay } from 'nostr-tools/relay';

import { applyDeltas, computeDeltas } from './diff.js';
import { Registry } from './registry.js';
import { ProvenanceStore } from './store.js';
import { runLlmEdit } from './agent.js';
import { VoiceRegistry } from './voice.js';
import type { Provider } from './providers/types.js';

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function relayBinaryPath(): string {
  const p = path.join(__dirname, '..', '..', '..', 'relay', 'zine-relay');
  if (!fs.existsSync(p)) {
    throw new Error(`Relay binary not found at ${p} — build it first: cd relay && go build -o zine-relay .`);
  }
  return p;
}

/** Spins up a real relay instance (its own sqlite db, its own port) for a
 * single test — same real code path production uses, no mocking. */
async function withTestRelay<T>(fn: (relay: Relay) => Promise<T>): Promise<T> {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const dbPath = path.join(tmpDir('tracer-relay-db-'), 'relay.sqlite3');
  const child: ChildProcess = spawn(relayBinaryPath(), ['-port', String(port), '-db', dbPath], { stdio: 'ignore' });

  try {
    const url = `ws://127.0.0.1:${port}`;
    let relay: Relay | undefined;
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        relay = await Relay.connect(url);
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    if (!relay) throw new Error('test relay did not come up in time');
    try {
      return await fn(relay);
    } finally {
      relay.close();
    }
  } finally {
    child.kill();
  }
}

async function freshStore(relay: Relay): Promise<ProvenanceStore> {
  const voices = new VoiceRegistry(tmpDir('tracer-test-voices-'));
  const signer = await voices.loadOrDefault();
  const registry = new Registry(tmpDir('tracer-test-registry-'));
  return new ProvenanceStore(relay, signer, registry);
}

test('computeDeltas + applyDeltas round-trip', () => {
  const oldText = 'The quick brown fox jumps.';
  const newText = 'The quick red fox leaps quickly.';
  const deltas = computeDeltas(oldText, newText);
  assert.ok(deltas.length > 0);
  assert.equal(applyDeltas(oldText, deltas), newText);
});

test('attach folder imports existing file, external edits seal chained nodes on the relay', async () => {
  await withTestRelay(async (relay) => {
    const folderPath = tmpDir('tracer-test-');
    const essayPath = path.join(folderPath, 'essay.md');
    fs.writeFileSync(essayPath, 'First draft of the opening line.');

    const store = await freshStore(relay);
    const folder = await store.attachFolder(folderPath);

    const files = await store.listFiles(folder);
    assert.equal(files.length, 1);
    assert.equal(files[0].relativePath, 'essay.md');

    let timeline = await store.timelineForFile(folder.id, 'essay.md');
    assert.equal(timeline.length, 1);
    assert.equal(timeline[0].node.action, 'import');
    assert.equal(timeline[0].deltas[0].newValue, 'First draft of the opening line.');

    // Simulate an external save.
    const newContent = 'First draft of the opening line, now revised.';
    fs.writeFileSync(essayPath, newContent);
    const file = await store.ensureFileTracked(folder, essayPath);
    const node = await store.recordSnapshot(file, newContent, 'edit');
    assert.ok(node);
    assert.equal(node!.action, 'edit');
    assert.equal(node!.prevNodeId, timeline[0].node.id);

    timeline = await store.timelineForFile(folder.id, 'essay.md');
    assert.equal(timeline.length, 2);
    let reconstructed = '';
    for (const entry of timeline) reconstructed = applyDeltas(reconstructed, entry.deltas);
    assert.equal(reconstructed, newContent);

    // A no-op snapshot (identical content) must not seal a new node.
    const noop = await store.recordSnapshot(await store.ensureFileTracked(folder, essayPath), newContent, 'edit');
    assert.equal(noop, null);
    assert.equal((await store.timelineForFile(folder.id, 'essay.md')).length, 2);

    // Every delta carries a timestamp.
    for (const entry of timeline) {
      for (const d of entry.deltas) assert.ok(typeof d.timestamp === 'number' && d.timestamp > 0);
    }
  });
});

test('runLlmEdit seals an action:"llm" node carrying the prompt', async () => {
  await withTestRelay(async (relay) => {
    const folderPath = tmpDir('tracer-test-');
    const filePath = path.join(folderPath, 'notes.md');
    fs.writeFileSync(filePath, 'draft notes');

    const store = await freshStore(relay);
    const folder = await store.attachFolder(folderPath);

    const fakeProvider: Provider = {
      name: 'fake',
      async complete(req) {
        assert.ok(req.userPrompt.includes('draft notes'));
        return 'draft notes, now polished by the model';
      },
    };

    const { node, newContent } = await runLlmEdit({
      store,
      folder,
      absPath: filePath,
      instruction: 'polish this',
      provider: fakeProvider,
    });

    assert.equal(newContent, 'draft notes, now polished by the model');
    assert.equal(fs.readFileSync(filePath, 'utf8'), newContent);
    assert.ok(node);
    assert.equal(node!.action, 'llm');
    assert.equal(node!.prompt, 'polish this');

    const timeline = await store.timelineForFile(folder.id, 'notes.md');
    assert.equal(timeline.length, 2); // import, then llm edit
    assert.equal(timeline[1].node.action, 'llm');
  });
});

test('runLlmEdit restores pinned spans altered by the model, and the trace shows them continuous', async () => {
  await withTestRelay(async (relay) => {
    const folderPath = tmpDir('tracer-test-');
    const filePath = path.join(folderPath, 'essay.md');
    const current =
      'Lead paragraph introducing the essay.\n\n' +
      'The sentence that must not change.\n\n' +
      'Closing paragraph wrapping up.';
    fs.writeFileSync(filePath, current);

    const store = await freshStore(relay);
    const folder = await store.attachFolder(folderPath);

    // The model rewrites freely — including altering the pinned sentence.
    const fakeProvider: Provider = {
      name: 'fake',
      async complete() {
        return (
          'Lead paragraph introducing the essay, polished.\n\n' +
          'THE SENTENCE THAT MUST NOT CHANGE (model rewrote it).\n\n' +
          'Closing paragraph wrapping up, polished.'
        );
      },
    };

    const pins = [{ id: 'p1', text: 'The sentence that must not change.', pinnedAt: 0 }];
    const { node, newContent, pinResults } = await runLlmEdit({
      store,
      folder,
      absPath: filePath,
      instruction: 'polish this',
      provider: fakeProvider,
      pins,
    });

    // On-disk file carries the canonical pin text, not the model's version.
    assert.ok(newContent.includes('The sentence that must not change.'));
    assert.ok(!newContent.includes('THE SENTENCE THAT MUST NOT CHANGE (model rewrote it)'));
    assert.equal(fs.readFileSync(filePath, 'utf8'), newContent);

    // Pin outcome: restored, not survived (the model altered it) and not a conflict.
    assert.equal(pinResults.length, 1);
    assert.equal(pinResults[0].outcome, 'restored');

    assert.ok(node);
    assert.equal(node!.action, 'llm');
    // The spec's `summary` field records the enforcement outcome.
    assert.ok(node!.summary && node!.summary.includes('1 restored'));

    // Provenance continuity: the pin's text is present in BOTH the pre-rewrite
    // content and the post-restore content, so it contributes no delta — the
    // model's transient alteration never reaches the trace.
    const timeline = await store.timelineForFile(folder.id, 'essay.md');
    assert.equal(timeline.length, 2); // import, then llm
    const reconstructed = timeline.reduce(
      (acc, entry) => applyDeltas(acc, entry.deltas),
      '',
    );
    assert.equal(reconstructed, newContent);
    // The llm node's deltas should not touch the pinned sentence's span.
    const llmDeltas = timeline[1].deltas;
    assert.ok(
      !llmDeltas.some((d) => d.newValue?.includes('THE SENTENCE THAT MUST NOT CHANGE (model rewrote it)')),
      'transient model alteration must not appear in any delta',
    );
  });
});

test('deleting a watched file marks it deleted but retains history, and it can be revived', async () => {
  await withTestRelay(async (relay) => {
    const folderPath = tmpDir('tracer-test-');
    const notePath = path.join(folderPath, 'note.md');
    fs.writeFileSync(notePath, 'temporary note');

    const store = await freshStore(relay);
    const folder = await store.attachFolder(folderPath);

    fs.unlinkSync(notePath);
    await store.markDeleted(folder, notePath);

    const files = await store.listFiles(folder);
    assert.equal(files.length, 0); // deleted files don't show up in the active listing

    const timeline = await store.timelineForFile(folder.id, 'note.md');
    assert.equal(timeline.length, 2); // import, then delete — history retained
    assert.equal(timeline[1].node.action, 'delete');

    // File reappears — should relink to prior history, not start a fresh chain.
    fs.writeFileSync(notePath, 'the note is back');
    const revived = await store.ensureFileTracked(folder, notePath);
    assert.equal(revived.isDeleted, true); // not yet flipped back until a snapshot is recorded
    const node = await store.recordSnapshot(revived, 'the note is back', 'edit');
    assert.ok(node);
    assert.equal(node!.prevNodeId, timeline[1].node.id);

    const finalTimeline = await store.timelineForFile(folder.id, 'note.md');
    assert.equal(finalTimeline.length, 3);
  });
});

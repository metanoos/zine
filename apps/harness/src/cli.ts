#!/usr/bin/env node
import { Command } from 'commander';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { loadConfig } from './config.js';
import { createProvider } from './providers/index.js';
import { runLlmEdit } from './agent.js';
import { connectLocalRelay } from './relay-client.js';
import { Registry } from './registry.js';
import { ProvenanceStore } from './store.js';
import { VoiceRegistry } from './voice.js';
import { watchFolder } from './watch.js';
import { PinRegistry } from './pins.js';

async function createStore(voiceName?: string): Promise<{ store: ProvenanceStore; close: () => void }> {
  const relay = await connectLocalRelay();
  const signer = await new VoiceRegistry().loadOrDefault(voiceName);
  const registry = new Registry();
  const store = new ProvenanceStore(relay, signer, registry);
  return { store, close: () => relay.close() };
}

const program = new Command();
program.name('tracer').description('Open, BYOK LLM harness with Nostr-based provenance tracing').version('0.1.0');

const voiceOption = ['-V, --voice <name>', 'signing voice to use (default: "default", auto-created on first use)'] as const;

program
  .command('attach <folder>')
  .description('Attach a folder: baseline-import its files into the provenance log')
  .option(...voiceOption)
  .action(async (folderArg: string, cmdOpts) => {
    const { store, close } = await createStore(cmdOpts.voice);
    const folder = await store.attachFolder(folderArg);
    const files = await store.listFiles(folder);
    console.log(`Attached ${folder.path}`);
    console.log(`Tracked ${files.length} file(s):`);
    for (const f of files) console.log(`  ${f.relativePath}`);
    close();
  });

program
  .command('run <instruction>')
  .description('Send a file + instruction to your configured LLM, apply the result, and seal a traced node')
  .requiredOption('-f, --file <path>', 'target file (absolute or relative to cwd)')
  .option('-p, --provider <provider>', 'openai | anthropic')
  .option('-k, --api-key <key>', 'API key (overrides TRACER_API_KEY / config file)')
  .option('-m, --model <model>', 'model name')
  .option('-u, --base-url <url>', 'API base URL override (e.g. a local OpenAI-compatible server)')
  .option(...voiceOption)
  .action(async (instruction: string, cmdOpts) => {
    const config = loadConfig({
      provider: cmdOpts.provider,
      apiKey: cmdOpts.apiKey,
      model: cmdOpts.model,
      baseUrl: cmdOpts.baseUrl,
    });
    const provider = createProvider(config);

    const absPath = path.resolve(cmdOpts.file);
    if (!fs.existsSync(absPath)) {
      console.error(`No such file: ${absPath}`);
      process.exitCode = 1;
      return;
    }

    const { store, close } = await createStore(cmdOpts.voice);
    // The file's containing directory becomes its traced folder if not attached yet.
    const folder = await store.attachFolder(path.dirname(absPath));

    const pinRegistry = new PinRegistry();
    const relativePath = path.relative(folder.path, absPath);
    const pins = pinRegistry.listPins(folder.path, relativePath);

    console.log(`Asking ${provider.name} to edit ${relativePath}...`);
    if (pins.length > 0) console.log(`  (${pins.length} pin(s) active — will be restored if the model altered them)`);
    const { node, pinResults } = await runLlmEdit({ store, folder, absPath, instruction, provider, pins });

    if (!node) {
      console.log('No change (model returned identical content).');
    } else {
      console.log(`Sealed node ${node.id} (action: llm, ${node.sealedAt})`);
      if (node.summary) console.log(`  ${node.summary}`);
    }

    // Surface every pin outcome so sediment is legible. Conflicts are the one
    // case the harness couldn't silently fix — they need the user's eye, so
    // they also flip the exit code to non-zero.
    const conflicts = pinResults.filter((r) => r.outcome === 'conflict');
    if (pinResults.length > 0) {
      for (const r of pinResults) {
        const preview = r.pin.text.length > 50 ? `${r.pin.text.slice(0, 50)}…` : r.pin.text;
        const where = r.detail ? ` — ${r.detail}` : '';
        console.log(`  pin ${r.outcome}: ${JSON.stringify(preview)}${where}`);
      }
    }
    if (conflicts.length > 0) {
      console.error(`${conflicts.length} pin conflict(s) — the model restructured a pinned span too heavily to safely restore. Review and re-pin if needed.`);
      process.exitCode = 1;
    }

    close();
  });

program
  .command('log <file>')
  .description('Show the traced history for a file')
  .option(...voiceOption)
  .action(async (fileArg: string, cmdOpts) => {
    const absPath = path.resolve(fileArg);
    const { store, close } = await createStore(cmdOpts.voice);
    const folder = await store.attachFolder(path.dirname(absPath));
    const file = await store.ensureFileTracked(folder, absPath);
    const timeline = await store.timelineForFile(file.folderId, file.relativePath);

    if (timeline.length === 0) {
      console.log('No trace nodes yet.');
    } else {
      for (const entry of timeline) {
        const time = new Date(entry.node.sealedAt).toISOString();
        console.log(`${time}  [${entry.node.action}]  ${entry.deltas.length} delta(s)  ${entry.node.id}`);
        if (entry.node.prompt) console.log(`    prompt: ${entry.node.prompt}`);
        if (entry.node.summary) console.log(`    summary: ${entry.node.summary}`);
      }
    }
    close();
  });

program
  .command('watch <folder>')
  .description('Watch a folder and seal a trace node for every externally-detected save')
  .option(...voiceOption)
  .action(async (folderArg: string, cmdOpts) => {
    const { store } = await createStore(cmdOpts.voice); // left open for the life of the watch
    const folder = await store.attachFolder(folderArg);
    console.log(`Watching ${folder.path} (ctrl-C to stop)...`);
    watchFolder(store, folder);
  });

const voice = program.command('voice').description('Manage signing voices (identities)');

voice
  .command('create <name>')
  .description('Generate a brand-new local keypair for a voice')
  .action((name: string) => {
    const registry = new VoiceRegistry();
    const { meta } = registry.createLocal(name);
    console.log(`Created voice "${meta.name}" (local) — pubkey ${meta.publicKey}`);
  });

voice
  .command('connect <name> <bunker>')
  .description('Connect a voice to an external NIP-46 signer (bunker:// URL or NIP-05 identifier)')
  .action(async (name: string, bunker: string) => {
    const registry = new VoiceRegistry();
    const { meta } = await registry.connectRemote(name, bunker);
    console.log(`Connected voice "${meta.name}" (remote) — pubkey ${meta.publicKey}`);
  });

voice
  .command('list')
  .description('List configured voices')
  .action(() => {
    const registry = new VoiceRegistry();
    const voices = registry.list();
    if (voices.length === 0) {
      console.log('No voices yet. Create one: tracer voice create <name>');
      return;
    }
    for (const v of voices) console.log(`${v.name}  [${v.kind}]  ${v.publicKey}`);
  });

const pin = program.command('pin').description('Manage pinned (settled) spans — preserved across LLM rewrites');

pin
  .command('add <file>')
  .description('Pin a span of a file so the LLM rewrite path preserves it. Pin identity is the text itself.')
  .option('-t, --text <span>', 'pin this literal text')
  .option('-l, --lines <range>', 'pin lines from the file, e.g. "3-7" or "5"')
  .option('-n, --note <note>', 'short note for this pin')
  .action((fileArg: string, cmdOpts) => {
    const absPath = path.resolve(fileArg);
    if (!fs.existsSync(absPath)) {
      console.error(`No such file: ${absPath}`);
      process.exitCode = 1;
      return;
    }
    const text = resolvePinText(absPath, cmdOpts.text, cmdOpts.lines);
    if (text === null) return; // resolvePinText already printed the error

    const registry = new PinRegistry();
    const folderPath = path.dirname(absPath);
    const relativePath = path.relative(folderPath, absPath);
    const span = registry.addPin(folderPath, relativePath, text, cmdOpts.note);
    console.log(`Pinned ${span.id} in ${relativePath}`);
    console.log(`  text: ${JSON.stringify(text.length > 60 ? `${text.slice(0, 60)}…` : text)}`);
  });

pin
  .command('list <file>')
  .description('List pinned spans for a file')
  .action((fileArg: string) => {
    const absPath = path.resolve(fileArg);
    const registry = new PinRegistry();
    const folderPath = path.dirname(absPath);
    const relativePath = path.relative(folderPath, absPath);
    const spans = registry.listPins(folderPath, relativePath);
    if (spans.length === 0) {
      console.log(`No pins for ${relativePath}.`);
      return;
    }
    console.log(`${spans.length} pin(s) for ${relativePath}:`);
    for (const s of spans) {
      const preview = s.text.length > 60 ? `${s.text.slice(0, 60)}…` : s.text;
      const note = s.note ? `  (${s.note})` : '';
      console.log(`  ${s.id}  ${JSON.stringify(preview)}${note}`);
    }
  });

pin
  .command('remove <file> <pinId>')
  .description('Remove a pinned span by id')
  .action((fileArg: string, pinId: string) => {
    const absPath = path.resolve(fileArg);
    const registry = new PinRegistry();
    const folderPath = path.dirname(absPath);
    const relativePath = path.relative(folderPath, absPath);
    const removed = registry.removePin(folderPath, relativePath, pinId);
    if (removed) console.log(`Removed pin ${pinId}.`);
    else {
      console.error(`No pin ${pinId} for ${relativePath}.`);
      process.exitCode = 1;
    }
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});

/** Resolves the text to pin from either a literal `--text` arg or a
 * `--lines` range (1-indexed, inclusive) read from the current file.
 * Returns null on a usage error after printing it. */
function resolvePinText(
  absPath: string,
  text: string | undefined,
  lines: string | undefined,
): string | null {
  if (text && lines) {
    console.error('Pass either --text or --lines, not both.');
    process.exitCode = 1;
    return null;
  }
  if (!text && !lines) {
    console.error('Pass --text <span> or --lines <range> to specify what to pin.');
    process.exitCode = 1;
    return null;
  }
  if (text) return text;

  // --lines: 1-indexed, inclusive on both ends. "5" pins just line 5.
  const match = /^(\d+)(?:-(\d+))?$/.exec(lines!);
  if (!match) {
    console.error(`Invalid --lines range "${lines}" — use "3-7" or "5".`);
    process.exitCode = 1;
    return null;
  }
  const start = parseInt(match[1], 10);
  const end = match[2] ? parseInt(match[2], 10) : start;
  if (end < start) {
    console.error(`--lines range end (${end}) before start (${start}).`);
    process.exitCode = 1;
    return null;
  }
  const fileContent = fs.readFileSync(absPath, 'utf8');
  const fileLines = fileContent.split('\n');
  if (start > fileLines.length) {
    console.error(`--lines start ${start} is past end of file (${fileLines.length} line(s)).`);
    process.exitCode = 1;
    return null;
  }
  const clampedEnd = Math.min(end, fileLines.length);
  // Preserve original line content exactly, including any trailing newline
  // structure — the pin's canonical text is what must survive rewrites.
  return fileLines.slice(start - 1, clampedEnd).join('\n');
}

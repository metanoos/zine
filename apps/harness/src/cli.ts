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

async function createStore(voiceName?: string): Promise<{ store: ProvenanceStore; close: () => void }> {
  // Load the signer before connecting so its signEvent can be wired as the
  // NIP-42 AUTH handler — friend-mode relays challenge every connection
  // (transport.md §5). In open mode (no friends.json) the relay never
  // challenges, so the handler is dead code that costs nothing.
  const signer = await new VoiceRegistry().loadOrDefault(voiceName);
  const relay = await connectLocalRelay({ authSigner: signer });
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

    const relativePath = path.relative(folder.path, absPath);
    console.log(`Asking ${provider.name} to edit ${relativePath}...`);
    const { node, bracketResults } = await runLlmEdit({ store, folder, absPath, instruction, provider });

    if (!node) {
      console.log('No change (model returned identical content).');
    } else {
      console.log(`Sealed node ${node.id} (action: llm, ${node.sealedAt})`);
      if (node.summary) console.log(`  ${node.summary}`);
    }

    // Surface every bracket outcome so sediment is legible. Conflicts are the
    // one case the harness couldn't silently fix — they need the user's eye,
    // so they also flip the exit code to non-zero.
    const conflicts = bracketResults.filter((r) => r.outcome === 'conflict');
    if (bracketResults.length > 0) {
      for (const r of bracketResults) {
        const preview = r.text.length > 50 ? `${r.text.slice(0, 50)}…` : r.text;
        const where = r.detail ? ` — ${r.detail}` : '';
        console.log(`  bracket ${r.outcome}: ${JSON.stringify(preview)}${where}`);
      }
    }
    if (conflicts.length > 0) {
      console.error(`${conflicts.length} bracket conflict(s) — the model restructured a bracketed span too heavily to safely restore. Review and re-author the bracket if needed.`);
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

program
  .command('revoke <folderId>')
  .description('Revoke a published zine: publish a NIP-09 kind-5 deletion request for every owned node in the folder trace. Relays advertising NIP-9 delete the referenced events and refuse re-publication. The chain itself is untouched (history retained); only relay retention changes (spec §10).')
  .requiredOption('-r, --reason <text>', 'human-readable reason carried in the kind-5 content')
  .option(...voiceOption)
  .action(async (folderId: string, cmdOpts) => {
    const { store, close } = await createStore(cmdOpts.voice);
    const event = await store.revokeZine(folderId, cmdOpts.reason);
    console.log(`Published kind-5 deletion request ${event.id}`);
    const eTags = event.tags.filter((t) => t[0] === 'e');
    const aTags = event.tags.filter((t) => t[0] === 'a');
    console.log(`  ${eTags.length} node(s) targeted (e tags), ${aTags.length} replaceable address(es) (a tags)`);
    close();
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

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});

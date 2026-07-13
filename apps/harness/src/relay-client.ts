import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { Relay } from 'nostr-tools/relay';
import type { Event, Filter } from 'nostr-tools';

export interface RelayClientOptions {
  url?: string;
  relayBinaryPath?: string;
}

const DEFAULT_URL = 'ws://127.0.0.1:4869';

/**
 * Connects to the local relay, spawning it (detached, localhost-only) if
 * nothing is listening yet. The harness is meant to work standalone from a
 * terminal without a desktop app running, so it manages its own relay
 * process rather than assuming one is already up.
 */
export async function connectLocalRelay(opts: RelayClientOptions = {}): Promise<Relay> {
  const url = opts.url ?? process.env.TRACER_RELAY_URL ?? DEFAULT_URL;

  try {
    return await Relay.connect(url);
  } catch {
    // not reachable yet — fall through to spawning it
  }

  spawnLocalRelay(opts);

  for (let attempt = 0; attempt < 30; attempt++) {
    await delay(150);
    try {
      return await Relay.connect(url);
    } catch {
      // keep retrying while it boots
    }
  }
  throw new Error(
    `Could not connect to local relay at ${url}, and could not spawn one. ` +
      `Build it (cd relay && go build -o zine-relay .) and set TRACER_RELAY_BIN to the binary path, ` +
      `or start it manually.`,
  );
}

function spawnLocalRelay(opts: RelayClientOptions): void {
  const binPath = opts.relayBinaryPath ?? process.env.TRACER_RELAY_BIN ?? findDefaultRelayBinary();
  if (!binPath || !fs.existsSync(binPath)) {
    throw new Error(
      'No local relay binary found. Build it: cd relay && go build -o zine-relay . — then set TRACER_RELAY_BIN to its path.',
    );
  }
  const child = spawn(binPath, [], { detached: true, stdio: 'ignore' });
  child.unref();
}

function findDefaultRelayBinary(): string | null {
  // Monorepo default layout: apps/harness/src -> ../../../relay/zine-relay
  const candidate = path.join(__dirname, '..', '..', '..', 'relay', 'zine-relay');
  return fs.existsSync(candidate) ? candidate : null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function queryEvents(relay: Relay, filter: Filter): Promise<Event[]> {
  return new Promise((resolve) => {
    const found: Event[] = [];
    const sub = relay.subscribe([filter], {
      onevent(evt) {
        found.push(evt);
      },
      oneose() {
        sub.close();
        resolve(found);
      },
    });
  });
}

export async function queryLatest(relay: Relay, filter: Filter): Promise<Event | null> {
  const events = await queryEvents(relay, filter);
  if (events.length === 0) return null;
  return events.reduce((latest, e) => (e.created_at > latest.created_at ? e : latest));
}

#!/usr/bin/env node
/**
 * zine-mcp — a headless zine press over MCP stdio.
 *
 * Per the protocol (§Vocabulary), a "press" is "the client interface a trace
 * is authored in." The desktop app is a GUI press; this is a HEADLESS press —
 * the one LLM harnesses (Claude Desktop, ZCode, Cursor, Cline, custom agents)
 * write through. Every edit a harness makes here becomes a signed, traced,
 * citable kind-4290 node, attributable to the agent as a distinct contributor.
 *
 * Lifecycle:
 *   1. Parse argv (--profile, --source-folder, relay, and config overrides).
 *   2. Install the Node localStorage shim so shared browser modules can
 *      persist the agent voice. Node 24 supplies the WebSocket runtime.
 *   3. Pin the home relay via ZINE_RELAY_URL (relay-config-override.ts) so
 *      identity.ts::resolveRelayUrl() returns the operator's local home.
 *   4. Dynamic-import the workspace AFTER steps 2+3 — the shared modules read
 *      localStorage / resolveRelayUrl at module-eval time, so setup must
 *      be in place first. A static import would evaluate before main() runs.
 *   5. Install the exact external publication set, open the profile Root (or
 *      an explicit source-folder fork), register tools, and run stdio.
 *
 * No relay is spawned here. The desktop app or a standalone local zine-relay
 * owns private Steps; hosted relays are explicit Send destinations only.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { configPathForProfile, installNodeStorage } from "./storage-node.js";
import { setHomeRelay } from "./relay-config-override.js";

interface Args {
  sourceFolder: string | undefined;
  profile: string;
  homeRelay: string | undefined;
  publishRelays: string[];
  config: string | undefined;
}

/** Parse the flat --flag value form. No interactive prompts — a spawned stdio
 *  server that blocked on input would hang the MCP client. */
function parseArgs(argv: string[]): Args {
  const args: Args = {
    sourceFolder: undefined,
    profile: "default",
    homeRelay: undefined,
    publishRelays: [],
    config: undefined,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`missing value for ${a}`);
      return v;
    };
    if (a === "--source-folder") args.sourceFolder = next();
    else if (a === "--profile") args.profile = next();
    else if (a === "--home-relay") args.homeRelay = next();
    else if (a === "--publish-relay") args.publishRelays.push(next());
    else if (a === "--config") args.config = next();
    else if (a === "-h" || a === "--help") {
      process.stderr.write(USAGE);
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${a}\n\n${USAGE}`);
    }
  }
  return args;
}

const USAGE = `zine-mcp — a headless zine press over MCP stdio.

Usage:
  zine-mcp [--profile <name>] [--source-folder <folderId>]
           [--home-relay <wsUrl>]
           [--publish-relay <wsUrl> ...] [--config <path>]

Optional:
  --profile        isolated agent key, Root, and working state (default: default)
  --source-folder  explicitly fork/bind an existing folder trace; when omitted,
                   the profile mints or reopens its own pathless Root
  --home-relay     private, loopback home URL
                   (default ws://127.0.0.1:4869 — the desktop sidecar)
  --publish-relay  non-loopback Send destination; repeat for fan-out
  --config         explicit key/state file (overrides the profile path)
                   default profile: ~/.zine/mcp.json
                   named profiles: ~/.zine/profiles/<name>.json

The home relay is synchronized when available; offline Steps remain durable in
the profile's signed-event outbox. Send publishes the same signed node to every
--publish-relay destination. Without a publication relay, Step and read/history
tools work but Send and Attest fail explicitly.
`;

function relayUrl(raw: string, flag: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${flag} must be a valid ws:// or wss:// URL: ${raw}`);
  }
  if ((url.protocol !== "ws:" && url.protocol !== "wss:") || !url.hostname) {
    throw new Error(`${flag} must be a valid ws:// or wss:// URL: ${raw}`);
  }
  return url;
}

function isLoopback(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  return (
    host === "localhost" ||
    host === "0.0.0.0" ||
    /^127(?:\.\d{1,3}){3}$/.test(host) ||
    host === "::1" ||
    host === "[::1]"
  );
}

async function main(): Promise<void> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`);
    process.exit(2);
  }
  // The desktop app's local sidecar is always at 127.0.0.1:4869 — it's
  // hardcoded in src-tauri/src/lib.rs (spawn_relay) and identity.ts
  // (LOCAL_RELAY_URL), never configurable. Defaulting to it lets a desktop
  // user omit --home-relay entirely (the common case).
  const homeRelay = args.homeRelay ?? "ws://127.0.0.1:4869";
  try {
    configPathForProfile(args.profile, args.config);
    if (args.sourceFolder && !/^[0-9a-f]{64}$/.test(args.sourceFolder)) {
      throw new Error("--source-folder must be a 64-character lowercase hex genesis id");
    }
    if (!isLoopback(relayUrl(homeRelay, "--home-relay"))) {
      throw new Error(
        "--home-relay must be loopback: private Steps cannot use a hosted or LAN relay; " +
          "configure remote destinations with --publish-relay",
      );
    }
    for (const url of args.publishRelays) {
      if (isLoopback(relayUrl(url, "--publish-relay"))) {
        throw new Error(
          `--publish-relay must cross the machine boundary (got ${url}); ` +
            "use --home-relay for local storage",
        );
      }
    }
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n\n${USAGE}`);
    process.exit(2);
  }
  // Steps 2 & 3: install storage BEFORE importing the shared client modules.
  // The order matters: setHomeRelay only writes an env var, while the Node
  // storage installer only provides a browser global. Neither helper imports
  // the client, but the dynamic workspace import below must see both settings.
  const configPath = installNodeStorage(args.config, args.profile);
  setHomeRelay(homeRelay);

  // Steps 4 & 5: dynamic imports ensure shared modules see storage and the
  // local home. Replace, rather than append to, the external set so reusing a
  // config file cannot silently retain a stale publication destination.
  const { replaceExternalRelays } = await import("../../client/src/relay-config.js");
  replaceExternalRelays(args.publishRelays);
  const {
    createMcpWorkspace,
    registerTools,
    agentVoice,
    initializeMcpKeySession,
  } = await import("./tools.js");
  const { resolveWorkspaceBinding } = await import("./folder-binding.js");
  const { registerAgentWriter } = await import("./register-writer.js");
  const { flushLocalEventOutbox } = await import("../../client/src/provenance.js");
  const { pendingLocalEventCount } = await import("../../client/src/event-outbox.js");

  // Seed the agent voice key, then auto-register it as a writer on the local
  // relay BEFORE attach(). Networked-mode relays reject unregistered writers;
  // the relay polls peers.json every 5s, so registering now gives it time to
  // recognize the key while attach()'s retry loop tolerates the brief window.
  const voice = agentVoice();
  await initializeMcpKeySession(voice);
  const reg = registerAgentWriter(voice.publicKey);
  if (reg === "registered") {
    process.stderr.write(
      `zine-mcp: registered agent key as writer on the local relay (peers.json writers[]).\n` +
        `  The relay polls every 5s — if the first tool call fails with auth-required, retry shortly.\n`,
    );
  } else if (reg === "skipped") {
    process.stderr.write(
      `zine-mcp: could not write peers.json (corrupt or read-only). If the relay is in\n` +
        `  networked mode, add this key to writers[] manually: ${voice.publicKey}\n`,
    );
  }
  // "already" and "local-mode" stay silent — nothing to report.

  // A profile owns one pathless Root. An explicit foreign source is the opt-in
  // exception: bind to a persisted shallow fork rather than extending it.
  let binding: Awaited<ReturnType<typeof resolveWorkspaceBinding>>;
  try {
    binding = await resolveWorkspaceBinding(
      args.sourceFolder,
      voice.publicKey,
      voice.secretKey,
    );
  } catch (e) {
    const msg = (e as Error).message;
    process.stderr.write(args.sourceFolder
      ? `could not bind source folder ${args.sourceFolder} at ${homeRelay}: ${msg}\n` +
        `Is the local home relay running, and is the source folder available there?\n`
      : `could not open profile Root: ${msg}\n`);
    process.exit(3);
  }
  if (binding.forked && !binding.reused) {
    process.stderr.write(
      `zine-mcp: forked foreign source folder ${binding.sourceFolderId}\n` +
        `  agent folder: ${binding.folderId}\n`,
    );
  }

  // Bind localStorage immediately. Relay reconciliation is background work, so
  // an unavailable sidecar does not block machine-local Step/read operations.
  const workspace = createMcpWorkspace(voice);
  let attached: { files: Record<string, unknown> };
  try {
    attached = await workspace.attach({ id: binding.folderId });
  } catch (e) {
    const msg = (e as Error).message;
    process.stderr.write(
      `could not attach agent Root ${binding.folderId}: ${msg}\n`,
    );
    process.exit(3);
  }

  process.stderr.write(
    `zine-mcp bound: profile=${args.profile} root=${binding.folderId.slice(0, 12)}… ` +
      `source=${binding.sourceFolderId.slice(0, 12)}… home=${homeRelay} ` +
      `publish=${args.publishRelays.length} pending=${pendingLocalEventCount()}\n` +
      `agent voice: ${voice.publicKey.slice(0, 12)}… (${attached.files ? Object.keys(attached.files).length : 0} files)\n`,
  );

  // Step 5: register tools and run the stdio transport.
  const server = new McpServer({
    name: "zine",
    version: "0.1.0",
  });
  registerTools(server, workspace, {
    profile: args.profile,
    configPath,
    homeRelay,
    publishRelays: args.publishRelays,
    ownerPubkey: voice.publicKey,
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  let syncing = false;
  const syncOutbox = async () => {
    if (syncing || pendingLocalEventCount() === 0) return;
    syncing = true;
    try {
      const result = await flushLocalEventOutbox();
      if (result.published > 0) {
        process.stderr.write(
          `zine-mcp: synchronized ${result.published} queued event(s); ${result.pending} pending.\n`,
        );
      }
    } finally {
      syncing = false;
    }
  };
  void syncOutbox().catch((error) => {
    process.stderr.write(`zine-mcp: initial outbox sync failed: ${String(error)}\n`);
  });
  const syncTimer = setInterval(() => {
    void syncOutbox().catch((error) => {
      process.stderr.write(`zine-mcp: outbox sync failed: ${String(error)}\n`);
    });
  }, 5_000);
  syncTimer.unref();
  // The transport keeps the process alive; no explicit run loop needed.
}

main().catch((e) => {
  process.stderr.write(`zine-mcp fatal: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
  process.exit(1);
});

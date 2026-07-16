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
 *   1. Parse argv (--folder, --relay, --config).
 *   2. Install the Node localStorage and WebSocket shims so shared browser
 *      modules can persist the agent voice and connect to relays on Node 20.
 *   3. Pin the home relay via ZINE_RELAY_URL (relay-config-override.ts) so
 *      identity.ts::resolveRelayUrl() returns the operator's --relay.
 *   4. Dynamic-import the workspace AFTER steps 2+3 — the shared modules read
 *      localStorage / resolveRelayUrl at module-eval time, so the shims must
 *      be in place first. A static import would evaluate before main() runs.
 *   5. Attach the relay workspace to --folder, register tools, run stdio.
 *
 * No relay is spawned here. The desktop app (or a standalone zine-relay, or a
 * hosted super-peer) owns the relay; this connects to whatever --relay names.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { installNodeStorage } from "./storage-node.js";
import { installNodeWebSocket } from "./websocket-node.js";
import { setHomeRelay } from "./relay-config-override.js";

interface Args {
  folder: string | undefined;
  relay: string | undefined;
  config: string | undefined;
}

/** Parse the flat --flag value form. No interactive prompts — a spawned stdio
 *  server that blocked on input would hang the MCP client. */
function parseArgs(argv: string[]): Args {
  const args: Args = { folder: undefined, relay: undefined, config: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`missing value for ${a}`);
      return v;
    };
    if (a === "--folder") args.folder = next();
    else if (a === "--relay") args.relay = next();
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
  zine-mcp --folder <folderId> --relay <wsUrl> [--config <path>]

Required:
  --folder   folderId to bind (the folder trace's genesis event id, spec §3.1)

Optional:
  --relay    home relay URL (default ws://127.0.0.1:4869 — the desktop sidecar;
             override for a self-hosted/hosted relay)
  --config   path to the key store (default ~/.zine/mcp.json)

The relay must already be running — zine-mcp connects, never spawns. Desktop
users: pass ws://127.0.0.1:4869 and start the desktop app once (it spawns the
sidecar). Self-hosters: point at your hosted relay.
`;

async function main(): Promise<void> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`);
    process.exit(2);
  }
  if (!args.folder) {
    process.stderr.write(`--folder is required.\n\n${USAGE}`);
    process.exit(2);
  }
  // The desktop app's local sidecar is always at 127.0.0.1:4869 — it's
  // hardcoded in src-tauri/src/lib.rs (spawn_relay) and identity.ts
  // (LOCAL_RELAY_URL), never configurable. Defaulting to it lets a desktop
  // user omit --relay entirely (the common case); self-hosters override.
  if (!args.relay) args.relay = "ws://127.0.0.1:4869";

  // Steps 2 & 3: install shims BEFORE importing the shared client modules.
  // The order matters: setHomeRelay only writes an env var, while the Node
  // installers only provide browser globals. None imports the client, but the
  // dynamic workspace import below does and must see both shims already.
  installNodeStorage(args.config);
  installNodeWebSocket();
  setHomeRelay(args.relay);

  // Step 4: dynamic import so the shared modules evaluate against the shims.
  const { createMcpWorkspace, registerTools, agentVoice } = await import("./tools.js");
  const { registerAgentWriter } = await import("./register-writer.js");

  // Seed the agent voice key, then auto-register it as a writer on the local
  // relay BEFORE attach(). Networked-mode relays reject unregistered writers;
  // the relay polls peers.json every 5s, so registering now gives it time to
  // recognize the key while attach()'s retry loop tolerates the brief window.
  const voice = agentVoice();
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

  // Bind the relay workspace to --folder. attach() reads the relay manifest
  // and reconstructs each file — a round-trip that doubles as a connectivity
  // check; if the relay is down or the folder unknown, we fail boldly here
  // rather than on the first tool call.
  const workspace = createMcpWorkspace();
  let attached: { files: Record<string, unknown> };
  try {
    attached = await workspace.attach({ id: args.folder });
  } catch (e) {
    const msg = (e as Error).message;
    process.stderr.write(
      `could not attach folder ${args.folder} at ${args.relay}: ${msg}\n` +
        (msg.includes("auth") || msg.includes("restricted")
          ? `The relay rejected the agent key. If it's in networked mode, ensure\n` +
            `${voice.publicKey}\n` +
            `is in ~/.tracer/peers.json writers[] (the relay re-reads it every 5s).\n`
          : `Is the relay running and the folder id correct?\n`),
    );
    process.exit(3);
  }

  process.stderr.write(
    `zine-mcp bound: folder=${args.folder.slice(0, 12)}… relay=${args.relay}\n` +
      `agent voice: ${voice.publicKey.slice(0, 12)}… (${attached.files ? Object.keys(attached.files).length : 0} files)\n`,
  );

  // Step 5: register tools and run the stdio transport.
  const server = new McpServer({
    name: "zine",
    version: "0.1.0",
  });
  registerTools(server, workspace);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // The transport keeps the process alive; no explicit run loop needed.
}

main().catch((e) => {
  process.stderr.write(`zine-mcp fatal: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
  process.exit(1);
});

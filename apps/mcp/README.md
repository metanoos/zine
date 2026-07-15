# zine-mcp — a headless zine press over MCP

zine-mcp is a [Model Context Protocol](https://modelcontextprotocol.io) server that exposes zine's trace-provenance gestures as MCP tools. It lets any MCP-capable LLM harness — Claude Desktop, ZCode, Cursor, Cline, custom agents — write *through* zine, so every edit those tools make becomes a signed, traced, citable kind-4290 node automatically.

Per the [zine protocol](../../protocol/trace-provenance.md), a **press** is "the client interface a trace is authored in." The desktop app is a GUI press; zine-mcp is a **headless press**. It is not another editor — it is the provenance layer any tool can write through.

## What it does

An LLM connected via zine-mcp becomes a distinct, attributable **author** on your traces:

- It mints its own voice key on first run (never imports yours — zine's "no import-existing-key" posture holds).
- Every edit it makes is signed by that key, so its contributions render in the desktop editor under a distinct color and verify through the protocol's attribution machinery (§3.6/§R5) like any cross-author signer.
- Multi-author means multi-chain joined by merge — an agent editing your work is exactly the legitimate cross-author case zine's attribution design was built for.

The tools are the protocol's **gestures**, not raw file CRUD (a filesystem MCP server already does CRUD). zine-mcp's value is the trace-provenance layer:

| Tool | Gesture (spec §) | What it does |
|---|---|---|
| `zine_list_files` | — | List the folder manifest with each file's trace head |
| `zine_read_file` | — | Read a file's current text + its head node (action, when sealed) |
| `zine_get_history` | — | Walk a file's trace chain (genesis → head) |
| `zine_get_node` | §R1 | Fetch one node's full self-sufficient payload by id |
| `zine_step` | **Step** §8 | Seal a node locally (hasn't left the machine) |
| `zine_send` | **Send** §8 | Push a sealed node to external relays |
| `zine_affirm` | **Affirm** §8 | Mark a sent node as your published position |
| `zine_mint_span` | **Mint** §3.8 | Strike an immutable, addressable node from a span |
| `zine_delete` | §3.3 | Remove a file from the manifest (history retained) |

Step seals locally by default; Send is the deliberate "let this leave my machine" act. The sovereignty filter: not every step is sent.

## Prerequisites

1. **A running relay.** zine-mcp connects, never spawns. Options:
   - **Desktop users:** start the zine desktop app once — it spawns the local sidecar at `ws://127.0.0.1:4869`.
   - **Self-hosters:** run a standalone `zine-relay`, or point at your hosted super-peer.
2. **A folder id.** The folder trace's genesis event id (spec §3.1 — trace identity IS the genesis node id). Find it in the desktop app, or query your relay for kind-34290 manifests.
3. **Networked-mode relays only: add the agent key as a writer.** If your relay has an owner set (NIP-42 AUTH required), the headless press's voice key needs read+write access. On first run zine-mcp prints its agent pubkey to stderr — add it to the desktop app's peer list (or `~/.tracer/peers.json`). In local mode (no owner set) this step is unnecessary.

## Install

```bash
cd apps/mcp && npm install && npm run build
```

This produces `dist/server.js`, exposed as the `zine-mcp` bin.

## Configure your harness

All MCP clients use the same shape — a `command` + `args` they spawn over stdio. Drop the matching block into your client's config, substituting `<folderId>`. The `--relay` flag is omitted by default — it points at the desktop app's local sidecar (`ws://127.0.0.1:4869`), which is the same address every desktop install uses. Add `--relay <url>` only if you self-host or use a hosted super-peer.

### Claude Desktop

`~/Library/Application Support/Claude/claude_desktop_config.json` (macOS):

```json
{
  "mcpServers": {
    "zine": {
      "command": "node",
      "args": [
        "/absolute/path/to/zine/apps/mcp/dist/server.js",
        "--folder", "<folderId>"
      ]
    }
  }
}
```

### ZCode

`.zcode/mcp.json` (workspace) or the user-scope equivalent:

```json
{
  "mcpServers": {
    "zine": {
      "command": "node",
      "args": [
        "/absolute/path/to/zine/apps/mcp/dist/server.js",
        "--folder", "<folderId>"
      ]
    }
  }
}
```

### Cursor

`.cursor/mcp.json` in your project root:

```json
{
  "mcpServers": {
    "zine": {
      "command": "node",
      "args": [
        "/absolute/path/to/zine/apps/mcp/dist/server.js",
        "--folder", "<folderId>"
      ]
    }
  }
}
```

Restart your client after editing the config. The agent voice pubkey prints to stderr on first connect — add it as a writer if your relay is in networked mode.

## CLI

```
zine-mcp --folder <folderId> [--relay <wsUrl>] [--config <path>]
```

| Flag | Required | Default | Meaning |
|---|---|---|---|
| `--folder` | yes | — | folderId to bind (the folder trace's genesis event id) |
| `--relay` | no | `ws://127.0.0.1:4869` | home relay URL (the desktop sidecar; override for self-hosted) |
| `--config` | no | `~/.zine/mcp.json` | key store path (holds the agent voice key) |

No interactive prompts — the MCP client spawns this and reads stdio.

## Development

```bash
npm run dev    # run via tsx (transpile-on-the-fly)
npm run build  # tsc → dist/
npx tsc --noEmit  # typecheck
```

The package imports the shared client modules (`provenance.ts`, `workspace-relay.ts`, `identity.ts`, `keys-store.ts`) directly — no logic is duplicated. A Node `localStorage` shim (`storage-node.ts`) persists the agent key; the home relay is pinned via `ZINE_RELAY_URL` (`relay-config-override.ts`).

## What zine-mcp is NOT

- It does **not** spawn the relay. Relay-running is the desktop app's job (or a standalone relay, or a hosted one).
- It is **not** a filesystem MCP server. The tools are trace gestures.
- It does **not** import your key. It mints its own agent voice.

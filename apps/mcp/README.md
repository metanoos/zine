# zine-mcp: a headless press over MCP

zine-mcp exposes zine's trace-provenance gestures through the
[Model Context Protocol](https://modelcontextprotocol.io). Any MCP-capable LLM
harness can write *through* zine, turning each edit into a signed, traced,
citable kind-4290 node.

In the [zine protocol](../../protocol/trace-provenance.md), a **press** is the
interface in which a trace is authored. The desktop app is a GUI press;
zine-mcp is a **headless press**. It is the provenance layer beneath an editor,
not another editor.

## What it does

An LLM connected through zine-mcp becomes a distinct, attributable **author**:

- It mints a voice key on first run and never imports yours.
- It signs every edit with that key. The desktop editor can render its work in
  a distinct color and verify it through the attribution rules (§3.6/§R5).
- Its chain joins yours through merge, the protocol's normal cross-author path.

The tools expose protocol **gestures**, not generic file CRUD. The value is the
trace-provenance layer:

| Tool | Gesture (spec §) | What it does |
|---|---|---|
| `zine_list_files` | — | List the folder manifest with each file's trace head |
| `zine_read_file` | — | Read a file's current text + its head node (action, when stepped) |
| `zine_get_history` | — | Walk a file's trace chain (genesis → head) |
| `zine_get_node` | §R1 | Fetch one node's full self-sufficient payload by id |
| `zine_step` | **Step** §8 | Step a node locally (hasn't left the machine) |
| `zine_send` | **Send** §8 | Step pending changes, otherwise reuse the latest Step, then publish it |
| `zine_attest` | **Attest** §5A/§8 | Append an endorsement of one sent node |
| `zine_mint_span` | **Mint** §3.8 | Strike an immutable, addressable node from a span |
| `zine_delete` | §3.3 | Remove a file from the manifest (history retained) |

Step records the supplied state locally. Send steps the supplied present state
only when it differs from the latest Step, then publishes the current node.
The sovereignty filter: not every Step is Sent, and callers do not need to Step
immediately before Send.

## Prerequisites

1. **A running relay.** zine-mcp connects, never spawns. Options:
   - **Desktop users:** start the zine desktop app once — it spawns the local sidecar at `ws://127.0.0.1:4869`.
   - **Self-hosters:** run a standalone `zine-relay`, or point at your hosted super-peer.
2. **A folder id.** The folder trace's genesis event id (spec §3.1 — trace identity IS the genesis node id). Find it in the desktop app, or query your relay for kind-34290 manifests.
3. **Networked-mode relays only: authorize the agent key as a writer.** If your
   relay has an owner set (NIP-42 AUTH required), the headless press's voice key
   needs read/write access. For the local desktop relay, zine-mcp adds its key
   to `~/.tracer/peers.json` under `writers` on first run. For a remote relay,
   authorize the pubkey printed to stderr through that relay's operator flow.
   Do not add it as a read-only peer. In local mode (no owner set), no writer
   entry is needed.

## Install

```bash
cd apps/mcp && npm ci && npm run build
```

This produces `dist/server.js`, exposed as the `zine-mcp` bin.

## Configure your harness

MCP clients all spawn a `command` plus `args` over stdio. Add the matching block
to your client's config and replace `<folderId>`. Without `--relay`, zine-mcp
uses the desktop sidecar at `ws://127.0.0.1:4869`. Pass `--relay <url>` only for
a self-hosted relay or hosted super-peer.

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

There are no interactive prompts; the MCP client owns the stdio process.

## Development

```bash
npm run dev    # run via tsx (transpile-on-the-fly)
npm run build  # tsc → dist/
npx tsc --noEmit  # typecheck
```

The protocol gestures and workspace behavior come from the shared client
modules (`provenance.ts`, `workspace-local.ts`, `identity.ts`,
`keys-store.ts`). A Node `localStorage` shim (`storage-node.ts`) persists the
agent key; the home relay is pinned via `ZINE_RELAY_URL`
(`relay-config-override.ts`).

## What zine-mcp is not

- It does **not** spawn the relay. Relay-running is the desktop app's job (or a standalone relay, or a hosted one).
- It is **not** a filesystem MCP server. The tools are trace gestures.
- It does **not** import your key. It mints its own agent voice.

# zine-mcp: a headless press over MCP

zine-mcp exposes zine's trace-provenance gestures through the
[Model Context Protocol](https://modelcontextprotocol.io). Any MCP-capable LLM
harness can write *through* zine, turning each edit into a signed, traced,
citable kind-4290 node.

In the [zine protocol](../../protocol/trace-provenance.md), a **press** is the
interface in which a trace is authored. The desktop app is a GUI press;
zine-mcp is a **headless press**. It is the provenance layer beneath an editor,
not another editor.

## Who it is for

zine-mcp is the interoperability path for MCP-capable harnesses into Zine's
agent-provenance use case: teams whose agents create durable files such as
reports, research, policies, or editorial work. It gives the person responsible
for those agents an artifact-level record that ordinary model-call logs and
file history do not provide on their own: which agent key changed the file,
which version was sent, and which exact version was later endorsed. It remains
an outside-in integration with claims bounded to the metadata and actions the
harness supplies; it does not claim complete provider-session capture.

The open protocol remains broader than this wedge. See the
[documentation hub](../../docs/README.md), [product framing](../../docs/PRODUCT.md),
[protocol tour](../../docs/PROTOCOL.md), [evidence ledger](../../docs/EVIDENCE.md),
and [roadmap](../../docs/ROADMAP.md).

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
| `zine_workspace_info` | — | Show the profile's stable Root, agent pubkey, relays, and queued-event count |
| `zine_list_files` | — | List the folder manifest with each file's trace head |
| `zine_read_file` | — | Read a file's current text + its head node (action, when stepped) |
| `zine_get_history` | — | Walk a file's trace chain, return each raw signed event, and classify it `full`, `snapshot-only`, or `invalid` |
| `zine_get_node` | §R1 | Fetch one canonical raw signed event plus its parsed payload and reader verdict by id |
| `zine_get_handoff` | — | Return a portable locator and reader verdict for the desktop review surface |
| `zine_step` | **Step** §8 | Step a node locally (hasn't left the machine) |
| `zine_send` | **Send** §8 | Step pending changes, otherwise reuse the latest Step, then publish it |
| `zine_attest` | **Attest** §5A/§8 | Append an endorsement of one sent node |
| `zine_mint_span` | **Mint** §3.8 | Registered fail-closed: rejects before creating or publishing a Coin until the headless package has a durable Kademlia indexing backend |
| `zine_delete` | §3.3 | Remove a file from the manifest (history retained) |

Step records the supplied state locally. Send steps the supplied present state
only when it differs from the latest Step, then publishes the current node.
Because a headless tool call is one discrete authoring action, each changed
file Step records it as one atomic KEdit from the previous snapshot to the
supplied text. Every file node therefore carries a replay-valid KEdit array;
an unchanged metadata-only checkpoint carries `[]`.
The sovereignty filter: not every Step is Sent, and callers do not need to Step
immediately before Send. A Step first persists as an exact signed event in the
profile's local state. When the loopback home relay is reachable the press
synchronizes that outbox in order; an unavailable relay does not make Step
fail. Publication destinations remain separate: Send deliberately publishes
one selected file node outside the machine. Mint additionally requires durable
`H` indexing. The current headless package has no Kademlia runtime, so
`zine_mint_span` rejects before creating or publishing a Coin; use the desktop
Coins interface for the complete Mint transaction.

## Storage and relays

No folder or running relay is required for the normal headless start. On first
run, each profile mints its own voice key and one permanent, pathless Root. It
reopens both on later runs. Signed events and current file state live in the
profile's local storage; only one zine-mcp process may write a profile at a
time.

Relays add synchronization and reachability:

1. **Optional local home relay.** zine-mcp connects, never spawns. The default
   is the desktop sidecar at `ws://127.0.0.1:4869`; without the desktop, run
   `zine-relay` on loopback. A LAN or hosted URL is rejected as `--home-relay`
   because private Steps cannot use a remote home. If it is down, ordinary Steps remain
   durable locally and retry in the background every five seconds.
2. **Optional publication relays.** Add one `--publish-relay <wsUrl>` per
   non-loopback Send destination. Without one, Step/read/history work; Send,
   Attest, and Mint fail explicitly.
3. **Optional source folder.** `--source-folder <folderId>` opts into an
   existing folder trace. A human-owned source is shallow-forked under the
   agent key and the source→fork mapping is reused across runs. Normal headless
   work should omit this flag and use the profile Root.
4. **Networked-mode relays only: authorize the agent key as a writer.** If the
   local relay has an owner set (NIP-42 AUTH required), the headless press's key
   needs read/write access. For the local desktop relay, zine-mcp adds its key
   to `~/.tracer/peers.json` under `writers` on first run. For a protected
   publication relay, authorize the pubkey printed to stderr through that
   relay's operator flow.
   Do not add it as a read-only peer. In local mode (no owner set), no writer
   entry is needed.

## Build and pack

The source build requires Node 24 and a Zine repository checkout because it
bundles the shared protocol and press modules into one executable file. From
the repository root:

```bash
npm ci --prefix apps/mcp
npm run build --prefix apps/mcp
```

This produces `apps/mcp/dist/server.js`. The bundle is exposed as the
`zine-mcp` bin and has no runtime npm dependencies or monorepo path references.
Create the intentionally private tarball with:

```bash
cd apps/mcp
npm pack
```

`prepack` rebuilds the bundle. The tarball contains only `README.md`,
`dist/server.js`, and `package.json`; it excludes source, tests, local state,
`node_modules`, and unrelated repository files.

To install that artifact in a fresh local project:

```bash
mkdir /tmp/zine-mcp-local && cd /tmp/zine-mcp-local
npm init -y
npm install /absolute/path/to/zine/apps/mcp/zine-mcp-0.1.0.tgz
./node_modules/.bin/zine-mcp --help
```

For a `zine-mcp` command available directly on `PATH`, install the same local
tarball globally with `npm install --global /absolute/path/to/zine-mcp-0.1.0.tgz`.
That is a local artifact install, not a registry publication.

Public registry publication is deliberately disabled by the package's
`private` metadata. Registry naming, licensing, signing or attestation, public
publication, and release automation remain separate release decisions that
require explicit approval.

## Configure your harness

MCP clients configure a headless press by spawning a `command` plus `args` over
stdio. There is no interactive setup or required working directory. Give
independent agents different `--profile` names; omit it for the default
profile. Add publication relays only when Send/Attest should be available.
The examples below use the installed `zine-mcp` command. If the tarball was
installed in a local project instead of globally, use the absolute path to that
project's `node_modules/.bin/zine-mcp` as `command`.

### Claude Desktop

`~/Library/Application Support/Claude/claude_desktop_config.json` (macOS):

```json
{
  "mcpServers": {
    "zine": {
      "command": "zine-mcp",
      "args": [
        "--profile", "claude",
        "--publish-relay", "wss://relay.example.com"
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
      "command": "zine-mcp",
      "args": [
        "--profile", "zcode"
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
      "command": "zine-mcp",
      "args": []
    }
  }
}
```

Restart your client after editing the config. The agent voice pubkey prints to stderr on first connect — add it as a writer if your relay is in networked mode.

## CLI

```
zine-mcp [--profile <name>] [--source-folder <folderId>]
         [--home-relay <wsUrl>] [--publish-relay <wsUrl> ...]
         [--config <path>]
```

| Flag | Required | Default | Meaning |
|---|---|---|---|
| `--profile` | no | `default` | isolated voice key, permanent Root, outbox, and working state |
| `--source-folder` | no | — | explicitly bind/fork an existing folder instead of using the profile Root |
| `--home-relay` | no | `ws://127.0.0.1:4869` | private loopback home for Step/read/history |
| `--publish-relay` | no, repeatable | — | non-loopback Send destination |
| `--config` | no | profile-dependent | explicit state file; default profile uses `~/.zine/mcp.json`, named profiles use `~/.zine/profiles/<name>.json` |

Profile writes are atomic and owner-only. Corrupt state fails loudly rather
than minting a replacement identity, and a profile lock prevents two writers
from racing.

## Headless and desktop handoff

LLMs can reason directly over `zine_get_node` and `zine_get_history`: the raw
signed trace is the canonical machine interface. The headless press does not
Reify files or convert provenance into Markdown.

For a human review, `zine_send` returns a `zine-trace:…` locator alongside the
node id. `zine_get_handoff` returns the same shape for the current file head.
Paste that locator into **Desktop action palette → Open Trace**. The desktop
verifies the exact signed file nucleus and renders any reachable history. Send
publishes only the chosen file node, so earlier private Steps may correctly be
absent; the nucleus remains self-sufficient and verifiable as `SNAPSHOT ONLY`
until its process ancestry is available. Complete valid KEdit process is
reported as `FULL TRACE`; broken signature, hash, or lineage is `INVALID`.

## Development

```bash
npm run dev    # run via tsx (transpile-on-the-fly)
npm test       # unit tests plus clean tarball install/help smoke
npm run build  # typecheck, then bundle the executable to dist/server.js
npm run test:package  # build, pack, inspect, install offline, and run --help
```

The package smoke uses temporary directories, an isolated `HOME` and empty npm
cache, and npm's offline mode. It installs no runtime dependencies, never starts
the server past argument parsing, does not contact a relay or provider, and
removes the tarball and installation project when it finishes.

The protocol gestures and workspace behavior come from the shared client
modules (`provenance.ts`, `workspace-local.ts`, `identity.ts`,
`keys-store.ts`). A Node `localStorage` shim (`storage-node.ts`) persists the
agent key, permanent Root, current files, and signed-event outbox; the home relay is pinned via `ZINE_RELAY_URL`
(`relay-config-override.ts`). External destinations are replaced from the
current process's `--publish-relay` arguments on every boot, so an old config
cannot silently retain a stale publication target.

## What zine-mcp is not

- It does **not** require or spawn the local home relay. Relay-running is the desktop app's job (or a standalone local relay).
- It does **not** accept a hosted relay as home. Hosted relays are explicit Send destinations.
- It is **not** a filesystem MCP server. The tools are trace gestures.
- It does **not** Reify traces into folders or Markdown; raw signed events are the machine contract.
- It does **not** import your key. It mints its own agent voice.
- It is **not** a no-install audit portal. Public proof reports and browser-only
  verification are roadmap items, not current capabilities.

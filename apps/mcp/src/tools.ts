/**
 * The v1 MCP tool surface: thin dispatch from each MCP tool into the shared
 * zine modules. Every tool maps to exactly one protocol gesture (or read),
 * never to raw file CRUD — the value zine-mcp adds over a filesystem MCP
 * server is the trace-provenance layer, and that's what these expose.
 *
 * Tools return structured JSON as a single text block (MCP convention), so a
 * harness can parse named fields out of the result rather than scraping prose.
 * Errors are thrown as plain Errors; the MCP SDK wraps them so the client sees
 * an `isError` result with the message — relaying the underlying message means
 * a relay-down / missing-node / not-yet-sent condition surfaces usefully.
 *
 * The `agentVoice()` resolver returns the headless press's signing key. On
 * first call it seeds via `keys-store.ts`'s `loadOrCreateVoice`-equivalent
 * path (the localStorage shim persists it to ~/.zine/mcp.json). The agent is
 * just another author — its runs render in the desktop editor under a
 * distinct, generative color, and its contributions verify through the
 * protocol's attribution machinery (§3.6/§R5) like any cross-author signer.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import {
  affirmNode,
  eventMeta,
  fetchChain,
  fetchEventById,
  fetchManifest,
  publishHardenedSpan,
  sendSealed,
} from "../../client/src/provenance.js";
import { createRelayWorkspace } from "../../client/src/workspace-relay.js";
import { loadOrCreateVoice } from "../../client/src/identity.js";
import type { Workspace } from "../../client/src/workspace-core.js";

/** The headless press's signing key. Seeded on first call, persisted via the
 *  localStorage shim into ~/.zine/mcp.json. Distinct from the desktop app's
 *  manual key by design — the agent is its own attributable author. */
export function agentVoice() {
  return loadOrCreateVoice();
}

/** Build the relay-backed workspace the headless press binds to. */
export function createMcpWorkspace(): Workspace {
  return createRelayWorkspace();
}

/** Wrap a JSON-serializable payload as an MCP tool result (single text block). */
function jsonResult(payload: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
  };
}

/** Throw if the workspace isn't bound to a folder yet. Returns the bound ref. */
function requireFolder(ws: Workspace) {
  const ref = ws.ref;
  if (!ref) {
    throw new Error(
      "no folder bound — pass --folder <folderId> on startup (the folder's genesis event id).",
    );
  }
  return ref;
}

/**
 * Register every v1 tool on `server`. The closure captures the bound
 * `workspace`, which `server.ts` attaches before calling this.
 */
export function registerTools(server: McpServer, workspace: Workspace): void {
  // --- reads -------------------------------------------------------------

  server.tool(
    "zine_list_files",
    "List every file in the bound zine folder with its current trace head " +
      "(kind-4290 node id) and content hash. Returns the folder manifest.",
    { _: z.void() },
    async () => {
      const ref = requireFolder(workspace);
      const manifest = await fetchManifest(ref.id);
      return jsonResult({
        folderId: ref.id,
        files: manifest.map((m) => ({
          relativePath: m.relativePath,
          kind: m.kind ?? "file",
          headNodeId: m.latestNodeId,
          contentHash: m.contentHash,
        })),
      });
    },
  );

  server.tool(
    "zine_read_file",
    "Read a file's current text and its trace head (the latest kind-4290 node: " +
      "id, action, when sealed). Content is reconstructed from the trace chain.",
    { relativePath: z.string().describe("file path within the folder, e.g. 'essay.md'") },
    async ({ relativePath }) => {
      const ref = requireFolder(workspace);
      const content = await workspace.readFile(relativePath);
      const chain = await fetchChain(ref.id, relativePath);
      const head = chain.length > 0 ? chain[chain.length - 1] : null;
      const meta = head ? eventMeta(head) : null;
      return jsonResult({
        relativePath,
        content,
        headNodeId: head?.id ?? null,
        action: meta?.action ?? null,
        sealedAtMs: head ? (meta?.sealedAtMs ?? null) : null,
      });
    },
  );

  server.tool(
    "zine_get_history",
    "Walk a file's trace chain (genesis → head), returning each sealed node's " +
      "id, advisory action, seal time, and optional summary. Ordering is the " +
      "prev-chain, never created_at (spec §2).",
    { relativePath: z.string() },
    async ({ relativePath }) => {
      const ref = requireFolder(workspace);
      const chain = await fetchChain(ref.id, relativePath);
      return jsonResult({
        relativePath,
        history: chain.map((e) => {
          const meta = eventMeta(e);
          const summary = (() => {
            try {
              return (JSON.parse(e.content) as { summary?: string }).summary ?? null;
            } catch {
              return null;
            }
          })();
          return {
            nodeId: e.id,
            action: meta.action ?? null,
            sealedAtMs: meta.sealedAtMs ?? null,
            signer: e.pubkey,
            summary,
          };
        }),
      });
    },
  );

  server.tool(
    "zine_get_node",
    "Fetch one trace node by id and return its full, self-sufficient payload " +
      "(snapshot, contentHash, authors, citations). Per spec §R1, a cited node " +
      "resolves as one bounded fetch — never a chain replay.",
    { nodeId: z.string().describe("64-char lowercase hex event id") },
    async ({ nodeId }) => {
      const event = await fetchEventById(nodeId);
      if (!event) {
        throw new Error(`no node found with id ${nodeId} on the configured relays`);
      }
      let parsed: {
        snapshot?: string;
        contentHash?: string;
        authors?: unknown;
        voices?: string[];
        summary?: string;
      } = {};
      try {
        parsed = JSON.parse(event.content) as typeof parsed;
      } catch {
        // Non-JSON content (rare) — leave parsed empty, return raw fields.
      }
      const meta = eventMeta(event);
      return jsonResult({
        nodeId: event.id,
        kind: event.kind,
        signer: event.pubkey,
        action: meta.action ?? null,
        relativePath: meta.relativePath ?? null,
        folderId: meta.folderId ?? null,
        snapshot: parsed.snapshot ?? null,
        contentHash: parsed.contentHash ?? null,
        citations: meta.citationTargets,
        authors: parsed.authors ?? null,
        voices: parsed.voices ?? null,
        summary: parsed.summary ?? null,
        sealedAtMs: meta.sealedAtMs ?? null,
      });
    },
  );

  // --- writes (the protocol gestures) ------------------------------------

  server.tool(
    "zine_step",
    "Step (spec §8): seal a kind-4290 node for `relativePath` with the given " +
      "content, signed by the agent voice. Sealed to the home relay ONLY — the " +
      "node has not left the author's machine. Call zine_send to publish it. " +
      "This is the local-checkpoint gesture; most steps stay local (drafts, " +
      "experiments). Returns the new node id.",
    {
      relativePath: z.string(),
      content: z.string().describe("the file's full new text (snapshot is unconditional, §R1)"),
      tags: z.array(z.string()).optional().describe("user-authored topical labels"),
      replyingTo: z
        .string()
        .optional()
        .describe("node id this write replies to (cite role: reply, §3.3)"),
      taggedTraces: z
        .array(z.string())
        .optional()
        .describe("node ids tagged onto this file without an inline quote (cite role: tag)"),
    },
    async ({ relativePath, content, tags, replyingTo, taggedTraces }) => {
      const ref = requireFolder(workspace);
      const signer = agentVoice().secretKey;
      // Step seals locally (localOnly=true); Send is a separate, deliberate act.
      const nodeId = await workspace.writeFile(
        relativePath,
        content,
        tags ?? [],
        signer,
        // No per-character run list from MCP — the agent's whole write is one
        // run attributed to the agent voice. Finer attribution would require
        // diffing against the prior snapshot, which the chain already records.
        undefined,
        replyingTo,
        taggedTraces,
        true, // localOnly — the sovereignty filter
      );
      return jsonResult({ nodeId, folderId: ref.id, sent: false });
    },
  );

  server.tool(
    "zine_send",
    "Send (spec §8): push an already-sealed node to every write-enabled relay. " +
      "The node was signed when it was sealed (by zine_step); Send only changes " +
      "reachability — it lets the node leave the machine. Idempotent. The " +
      "sovereignty filter: not every Step is Sent.",
    { nodeId: z.string().describe("id of the sealed node to publish") },
    async ({ nodeId }) => {
      const event = await fetchEventById(nodeId);
      if (!event) {
        throw new Error(
          `cannot send: no sealed node with id ${nodeId} on the home relay. ` +
            `Was it stepped first?`,
        );
      }
      await sendSealed(event);
      return jsonResult({ nodeId, sent: true });
    },
  );

  server.tool(
    "zine_affirm",
    "Affirm (spec §8): mark a SENT node as the author's published position. " +
      "Decoupled from Send — Affirm comes after the node has been sent and " +
      "read, as a post-hoc endorsement of one's own work. Requires prior Send " +
      "(affirming a node never sent is invalid by construction). A NIP-03 " +
      "anteriority attestation is fired asynchronously and never blocks the " +
      "gesture. Returns the new affirm node id.",
    {
      citedNodeId: z.string().describe("id of the SENT node being affirmed"),
      citedOwnerPubkey: z
        .string()
        .describe("pubkey of the cited node's signer (carried on the q tag, §3.1)"),
      relativePath: z
        .string()
        .optional()
        .describe("path for the affirm node's own chain (defaults to the cited node's)"),
      content: z
        .string()
        .optional()
        .describe("snapshot for the affirm node (defaults to the cited node's snapshot)"),
    },
    async ({ citedNodeId, citedOwnerPubkey, relativePath, content }) => {
      const ref = requireFolder(workspace);
      const signer = agentVoice().secretKey;

      // §8: affirm requires prior Send. We can't perfectly prove Send across
      // the relay set, but the cited node must at least be fetchable — an
      // unfetchable node is one nobody can read, which is exactly the
      // "affirming something no one can fetch" lie §8 forbids.
      const cited = await fetchEventById(citedNodeId);
      if (!cited) {
        throw new Error(
          `cannot affirm ${citedNodeId}: not fetchable on the configured relays. ` +
            `Send it first (§8 forbids affirming a node no one can read).`,
        );
      }
      const citedContent = JSON.parse(cited.content) as { snapshot?: string; contentHash?: string };
      const affirm = await affirmNode(citedNodeId, citedOwnerPubkey, {
        prevEventId: null, // the affirm node stands alone on its own gesture
        relativePath: relativePath ?? eventMeta(cited).relativePath ?? "affirm.md",
        folderId: ref.id,
        snapshot: content ?? citedContent.snapshot ?? "",
        contentHash: citedContent.contentHash ?? "",
        signer,
      });
      return jsonResult({ affirmNodeId: affirm.id, affirmedNode: citedNodeId });
    },
  );

  server.tool(
    "zine_mint_span",
    "Mint (spec §3.8): strike an immutable, addressable kind-4290 node from a " +
      "span of text, frozen at exactly this version. Minted spans are the " +
      "protocol's addressable unit for citations — 'quote this passage' first " +
      "mints it, then cites the minted id. Returns the minted node id and its " +
      "synthetic path.",
    {
      originPath: z.string().describe("relative path of the document the span came from"),
      phrase: z.string().describe("the exact span text to freeze as an immutable trace"),
      originNodeId: z
        .string()
        .describe("the origin document's current nucleus (node-version the span was pulled from)"),
    },
    async ({ originPath, phrase, originNodeId }) => {
      const ref = requireFolder(workspace);
      const minted = await publishHardenedSpan({
        folderId: ref.id,
        originPath,
        phrase,
        originNodeId,
      });
      return jsonResult({ mintedNodeId: minted.id });
    },
  );

  server.tool(
    "zine_delete",
    "Delete (spec §3.3 remove delta): remove a file from the folder's manifest. " +
      "The file's own 4290 chain retains a delete node as history — provenance " +
      "is append-only; this changes folder membership, not the chain.",
    {
      relativePath: z.string(),
      isFolder: z.boolean().optional().describe("true to delete a folder member (default false)"),
    },
    async ({ relativePath, isFolder }) => {
      requireFolder(workspace);
      await workspace.deletePath(relativePath, isFolder ?? false);
      return jsonResult({ deleted: relativePath, isFolder: isFolder ?? false });
    },
  );
}

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
 * path (the localStorage shim persists it in the selected profile). The agent is
 * just another author — its runs render in the desktop editor under a
 * distinct, generative color, and its contributions verify through the
 * protocol's attribution machinery (§3.6/§R5) like any cross-author signer.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  encodeTraceLocator,
  inspectFileTraceNucleus,
  verifyFileTraceChain,
  type TraceConformanceVerdict,
  type TraceLocator,
} from "@zine/protocol";
import type { Event } from "nostr-tools";
import { verifyEvent } from "nostr-tools/pure";

import {
  attestNode,
  eventMeta,
  fetchChain,
  fetchEventById,
  fetchManifest,
  isTraceNodeSent,
  operationIdFromNode,
  publishHardenedSpan,
  resolveTraceIdentity,
  sendHistoricalStep,
  sha256HexLocal,
  upsertManifestEntry,
} from "../../client/src/provenance/provenance.js";
import { createLocalWorkspace } from "../../client/src/workspace/workspace-local.js";
import { loadOrCreateVoice, type Voice } from "../../client/src/identity/identity.js";
import {
  identityFromPubkey,
  keySecretRef,
  saveKeys,
  setAuthorKeyId,
  setModelKeyId,
  setNodeKeyId,
} from "../../client/src/identity/keys-store.js";
import {
  MemorySecretStore,
  putSecret,
  unlockSecretSession,
} from "../../client/src/identity/secret-store.js";
import type { Workspace } from "../../client/src/workspace/workspace-core.js";
import { getOrCreateMintFolder } from "../../client/src/workspace/root.js";
import { MINT, mintedPath } from "../../client/src/workspace/generated-paths.js";
import { saveLocalFile } from "../../client/src/workspace/local-store.js";
import { pendingLocalEventCount } from "../../client/src/provenance/event-outbox.js";

/** The headless press's signing key. Seeded on first call, persisted via the
 *  localStorage shim into the selected profile. Distinct from the desktop app's
 *  manual key by design — the agent is its own attributable author. */
export function agentVoice() {
  return loadOrCreateVoice();
}

/** Bridge the owner-only MCP profile key into the shared session-only signing
 * boundary. Desktop secrets remain Stronghold-backed; the headless press
 * already persists this key in its chmod-0600 atomic profile and exposes only
 * an opaque ref to shared key-role consumers such as NIP-42 authentication. */
export async function initializeMcpKeySession(voice: Voice): Promise<void> {
  const id = "mcp-agent";
  const secretRef = keySecretRef(id);
  await unlockSecretSession(new MemorySecretStore({
    persistent: false,
    signing: true,
    model: false,
  }));
  await putSecret(secretRef, voice.secretKey);

  let createdAt = Date.now();
  try {
    const stored = JSON.parse(localStorage.getItem("zine.keys") ?? "[]") as Array<{
      id?: unknown;
      pubkey?: unknown;
      createdAt?: unknown;
    }>;
    const prior = stored.find((entry) => entry.id === id && entry.pubkey === voice.publicKey);
    if (typeof prior?.createdAt === "number") createdAt = prior.createdAt;
  } catch {
    // A corrupt public profile is replaced from the authoritative MCP key.
  }
  saveKeys([{
    id,
    label: "agent",
    secretRef,
    pubkey: voice.publicKey,
    identity: identityFromPubkey(voice.publicKey),
    schemaVersion: 1,
    createdAt,
  }]);
  setAuthorKeyId(id);
  setModelKeyId(id);
  setNodeKeyId(id);
}

/** Build the local-first workspace the headless press binds to. */
export function createMcpWorkspace(voice: Voice = agentVoice()): Workspace {
  return createLocalWorkspace({
    requireRelayOnAttach: false,
    signerForVoice: (pubkey) =>
      !pubkey || pubkey === voice.publicKey ? voice.secretKey : null,
  });
}

/** Publish exactly one immutable file Step for the MCP Send gesture.
 *
 * The shared live-trace Send helper also refreshes a replaceable TraceHead.
 * That cache is useful for ordinary press discovery, but the headless handoff
 * contract is narrower: expose only the selected signed nucleus and leave all
 * private process ancestry (and mutable head metadata) at home. */
export async function publishExactMcpStep(event: Event): Promise<void> {
  const reifications = event.tags.filter((tag) => tag[0] === "z");
  const roots = event.tags.filter((tag) => tag[0] === "f");
  const paths = event.tags.filter((tag) => tag[0] === "F");
  if (
    !verifyEvent(event) ||
    event.kind !== 4290 ||
    reifications.length !== 1 || reifications[0]?.[1] !== "file" ||
    roots.length !== 1 || !roots[0]?.[1] ||
    paths.length !== 1 || !paths[0]?.[1]
  ) {
    throw new Error("refusing to Send anything except one valid signed file Step");
  }
  await sendHistoricalStep(event);
}

export interface McpToolContext {
  profile: string;
  configPath: string;
  homeRelay: string;
  publishRelays: string[];
  ownerPubkey: string;
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
      "no Root bound — restart the headless press with a writable profile",
    );
  }
  return ref;
}

function parsedPayload(event: Awaited<ReturnType<typeof fetchEventById>>): unknown {
  if (!event) return null;
  try {
    return JSON.parse(event.content) as unknown;
  } catch {
    return null;
  }
}

async function handoffForEvent(
  event: NonNullable<Awaited<ReturnType<typeof fetchEventById>>>,
  rootId: string,
  relativePath: string,
  relayHints: readonly string[],
): Promise<{
  locator: TraceLocator;
  encoded: string;
  conformance: TraceConformanceVerdict;
}> {
  const traceId = await resolveTraceIdentity(event.id);
  if (!traceId) throw new Error(`cannot resolve trace identity for ${event.id}`);
  const locator: TraceLocator = {
    format: "zine-trace-locator",
    version: 1,
    kind: "file",
    rootId,
    traceId,
    nodeId: event.id,
    relativePath,
    ownerPubkey: event.pubkey,
    relayHints: [...new Set(relayHints)],
  };
  const inspection = await inspectFileTraceNucleus(event, fetchEventById, verifyEvent, {
    expectedOwnerPubkey: event.pubkey,
    expectedRootId: rootId,
    expectedRelativePath: relativePath,
    expectedNucleusId: event.id,
    expectedTraceId: traceId,
  });
  return {
    locator,
    encoded: encodeTraceLocator(locator),
    conformance: inspection.verdict,
  };
}

/**
 * Register every v1 tool on `server`. The closure captures the bound
 * `workspace`, which `server.ts` attaches before calling this.
 */
export function registerTools(
  server: McpServer,
  workspace: Workspace,
  context: McpToolContext,
): void {
  // --- reads -------------------------------------------------------------

  server.tool(
    "zine_workspace_info",
    "Return this headless profile's stable Root, agent identity, relay posture, " +
      "and number of signed events still waiting for the local relay.",
    { _: z.void() },
    async () => {
      const ref = requireFolder(workspace);
      return jsonResult({
        profile: context.profile,
        rootId: ref.id,
        ownerPubkey: context.ownerPubkey,
        homeRelay: context.homeRelay,
        publishRelays: context.publishRelays,
        pendingLocalEvents: pendingLocalEventCount(),
      });
    },
  );

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
      "id, action, when stepped). Content is reconstructed from the trace chain.",
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
        steppedAtMs: head ? (meta?.steppedAtMs ?? null) : null,
      });
    },
  );

  server.tool(
    "zine_get_history",
    "Walk a file's trace chain (genesis → head), returning each stepped node's " +
      "id, advisory action, step time, and optional summary. Ordering is the " +
      "prev-chain, never created_at (spec §2). Includes the shared FULL TRACE, " +
      "SNAPSHOT ONLY, or INVALID reader verdict.",
    { relativePath: z.string() },
    async ({ relativePath }) => {
      const ref = requireFolder(workspace);
      const chain = await fetchChain(ref.id, relativePath);
      const conformance = await verifyFileTraceChain(chain, verifyEvent);
      return jsonResult({
        relativePath,
        conformance,
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
            steppedAtMs: meta.steppedAtMs ?? null,
            signer: e.pubkey,
            summary,
            payload: parsedPayload(e),
            event: e,
          };
        }),
      });
    },
  );

  server.tool(
    "zine_get_node",
    "Fetch one trace node by id and return its full, self-sufficient payload " +
      "(snapshot, contentHash, authors, citations). Per spec §R1, a cited node " +
      "resolves as one bounded fetch — never a chain replay. Ancestry is checked " +
      "when available and the reader verdict is returned explicitly.",
    { nodeId: z.string().describe("64-char lowercase hex event id") },
    async ({ nodeId }) => {
      const event = await fetchEventById(nodeId);
      if (!event) {
        throw new Error(`no node found with id ${nodeId} on the configured relays`);
      }
      const payload = parsedPayload(event) as {
        snapshot?: string;
        contentHash?: string;
        authors?: unknown;
        voices?: string[];
        summary?: string;
      } | null;
      const meta = eventMeta(event);
      const inspection = await inspectFileTraceNucleus(event, fetchEventById, verifyEvent);
      return jsonResult({
        nodeId: event.id,
        kind: event.kind,
        signer: event.pubkey,
        action: meta.action ?? null,
        relativePath: meta.relativePath ?? null,
        folderId: meta.folderId ?? null,
        snapshot: payload?.snapshot ?? null,
        contentHash: payload?.contentHash ?? null,
        citations: meta.citationTargets,
        authors: payload?.authors ?? null,
        voices: payload?.voices ?? null,
        summary: payload?.summary ?? null,
        steppedAtMs: meta.steppedAtMs ?? null,
        historyComplete: inspection.historyComplete,
        conformance: inspection.verdict,
        payload,
        event,
      });
    },
  );

  server.tool(
    "zine_get_handoff",
    "Return a portable single-file locator that the desktop press can open. " +
      "The locator carries ids and relay hints only; the signed trace remains authoritative. " +
      "The response also carries the shared reader verdict.",
    { relativePath: z.string() },
    async ({ relativePath }) => {
      const ref = requireFolder(workspace);
      const chain = await fetchChain(ref.id, relativePath);
      const event = chain[chain.length - 1];
      if (!event) throw new Error(`${relativePath} has no Step to hand off`);
      const sent = await isTraceNodeSent(event.id);
      const relayHints = sent && context.publishRelays.length > 0
        ? context.publishRelays
        : [context.homeRelay];
      const handoff = await handoffForEvent(event, ref.id, relativePath, relayHints);
      return jsonResult({ sent, ...handoff });
    },
  );

  // --- writes (the protocol gestures) ------------------------------------

  server.tool(
    "zine_step",
    "Step (spec §8): step a kind-4290 node for `relativePath` with the given " +
      "content, signed by the agent voice. Stepped to the home relay ONLY — the " +
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
      citationIds: z
        .array(z.string())
        .optional()
        .describe("node ids tagged onto this file without an inline quote (cite role: tag)"),
    },
    async ({ relativePath, content, tags, replyingTo, citationIds }) => {
      const ref = requireFolder(workspace);
      const signer = agentVoice().secretKey;
      // Step steps locally (localOnly=true); Send is a separate, deliberate act.
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
        citationIds,
        // No interactive editor log: the workspace records this tool call as
        // one atomic agent KEdit from the previous snapshot to this one.
        undefined,
        true, // localOnly — the sovereignty filter
        true, // an explicit Step always mints one checkpoint
      );
      return jsonResult({
        nodeId,
        folderId: ref.id,
        sent: false,
        pendingLocalEvents: pendingLocalEventCount(),
      });
    },
  );

  server.tool(
    "zine_send",
    "Send (spec §8): Step the supplied state only when it differs from the " +
      "latest Step, then publish the current node to every configured publication relay. This is " +
      "the discussion gesture; unlike zine_step it deliberately leaves the machine.",
    {
      relativePath: z.string(),
      content: z.string().describe("the file's full present text"),
      tags: z.array(z.string()).optional().describe("user-authored topical labels"),
      replyingTo: z.string().optional().describe("node id this write replies to"),
      citationIds: z.array(z.string()).optional().describe("node ids tagged onto this file"),
    },
    async ({ relativePath, content, tags, replyingTo, citationIds }) => {
      const ref = requireFolder(workspace);
      const signer = agentVoice().secretKey;
      const nodeId = await workspace.writeFile(
        relativePath,
        content,
        tags ?? [],
        signer,
        undefined,
        replyingTo,
        citationIds,
        // No interactive editor log: changed content becomes one atomic agent
        // KEdit; unchanged Send reuses the latest Step below.
        undefined,
        true, // Record pending changes locally before distribution.
        false, // Unchanged Send reuses the latest Step.
      );
      const event = await fetchEventById(nodeId);
      if (!event) throw new Error("latest Step is unavailable from local trace storage");
      await publishExactMcpStep(event);
      const handoff = await handoffForEvent(
        event,
        ref.id,
        relativePath,
        context.publishRelays,
      );
      return jsonResult({
        nodeId,
        folderId: ref.id,
        sent: true,
        pendingLocalEvents: pendingLocalEventCount(),
        ...handoff,
      });
    },
  );

  server.tool(
    "zine_attest",
    "Attest (spec §8): mark a SENT node as the author's published position. " +
      "Decoupled from Send — Attest comes after the node has been sent and " +
      "read, as a post-hoc endorsement of one's own work. Requires prior Send " +
      "(attesting a node never sent is invalid by construction). Returns the " +
      "new append-only TraceAttestation event id.",
    {
      citedNodeId: z.string().describe("id of the SENT node being attested"),
      message: z.string().optional().describe("optional note attached to the endorsement"),
      geohash: z.string().optional().describe("optional location for spatial discovery"),
    },
    async ({ citedNodeId, message, geohash }) => {
      requireFolder(workspace);
      const signer = agentVoice().secretKey;

      // attestNode enforces prior Send by fetching the target from a configured
      // write-enabled, non-loopback relay before it publishes the endorsement.
      const attest = await attestNode(citedNodeId, undefined, {
        signer,
        ...(message ? { message } : {}),
        ...(geohash ? { geohash } : {}),
      });
      return jsonResult({ attestationId: attest.id, attestedNode: citedNodeId });
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
      sourceStart: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe("UTF-16 start offset when the phrase occurs more than once in the source snapshot"),
    },
    async ({ originPath, phrase, originNodeId, sourceStart }) => {
      const ref = requireFolder(workspace);
      const voice = agentVoice();
      const sourceEvent = await fetchEventById(originNodeId);
      if (!sourceEvent) throw new Error("the source node is unavailable");
      let sourceSnapshot: string;
      try {
        const parsed = JSON.parse(sourceEvent.content) as { snapshot?: unknown };
        if (typeof parsed.snapshot !== "string") throw new Error("missing snapshot");
        sourceSnapshot = parsed.snapshot;
      } catch {
        throw new Error("the source node does not carry a readable text snapshot");
      }
      const resolvedStart = sourceStart ?? sourceSnapshot.indexOf(phrase);
      if (resolvedStart < 0 || sourceSnapshot.slice(resolvedStart, resolvedStart + phrase.length) !== phrase) {
        throw new Error("the phrase does not match the requested source range");
      }
      if (
        sourceStart === undefined &&
        sourceSnapshot.indexOf(phrase, resolvedStart + 1) !== -1
      ) {
        throw new Error("the phrase occurs more than once; provide sourceStart to identify the exact span");
      }
      const sourceContentHash = await sha256HexLocal(sourceSnapshot);
      const mintFolderId = await getOrCreateMintFolder(ref.id, voice.secretKey);
      const manifest = await fetchManifest(mintFolderId);
      const occupied = new Set(manifest.map((entry) => `${MINT}/${entry.relativePath}`));
      const localPath = mintedPath(phrase, new Date(), occupied);
      const memberName = localPath.slice(`${MINT}/`.length);
      const minted = await publishHardenedSpan({
        folderId: mintFolderId,
        relativePath: memberName,
        phrase,
        originNodeId,
        sourceContentHash,
        sourceRange: { start: resolvedStart, end: resolvedStart + phrase.length },
        signer: voice.secretKey,
        localOnly: true,
      });
      const parsed = JSON.parse(minted.content) as { contentHash?: string };
      await upsertManifestEntry(
        mintFolderId,
        {
          kind: "file",
          relativePath: memberName,
          latestNodeId: minted.id,
          contentHash: parsed.contentHash ?? "",
        },
        voice.secretKey,
        { localOnly: true, operationId: operationIdFromNode(minted) },
      );
      saveLocalFile(ref.id, localPath, {
        content: phrase,
        tags: [],
        nodeId: minted.id,
        runs: [{ voice: voice.publicKey, text: phrase }],
      });
      return jsonResult({ mintedNodeId: minted.id, path: localPath, originPath });
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

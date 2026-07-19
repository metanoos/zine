import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./tools.ts", import.meta.url), "utf8");
const serverSource = readFileSync(new URL("./server.ts", import.meta.url), "utf8");

test("Mint returns the citation Step from the shared completion receipt", () => {
  assert.match(source, /const receipt = await completePendingCoinMintTransaction/);
  assert.match(source, /const completedSourceNodeId = receipt\.sourceNodeId \?\? null/);
  assert.match(source, /attestationId: receipt\.attestation\.id/);
  assert.doesNotMatch(source, /citationNodeIds|let citationNodeId\s*:/);
});

test("MCP materializes a Coin only at the completed public boundary", () => {
  const persistLocal = source.match(
    /persistLocal: \(record\)[\s\S]*?(?=\n\s*finalizeSource:)/,
  )?.[0];
  assert.ok(persistLocal);
  assert.match(persistLocal, /coinComplete: true/);
});

test("headless Mint fails before publication when no Kademlia indexer exists", async () => {
  const {
    mcpMintIndexingBackendAvailable,
    requireMcpMintIndexingBackend,
  } = await import("./tools.js");
  assert.equal(mcpMintIndexingBackendAvailable(), false);
  assert.throws(
    () => requireMcpMintIndexingBackend(),
    /requires a headless Kademlia indexing backend/,
  );
  const mint = source.slice(source.indexOf('"zine_mint_span"'), source.indexOf('"zine_delete"'));
  assert.ok(
    mint.indexOf("requireMcpMintIndexingBackend()") < mint.indexOf("preparePendingCoinMint("),
  );
  assert.match(
    source,
    /publishPair: async \(\) => \{[\s\S]*?requireMcpMintIndexingBackend\(\)/,
  );
  assert.match(
    source,
    /restoreAttestation: \(\) => \{[\s\S]*?requireMcpMintIndexingBackend\(\)/,
  );
});

test("MCP installs startup Mint recovery only when an indexing backend is available", () => {
  assert.match(source, /export function mcpCoinMintCompletion/);
  assert.match(source, /export async function resumeMcpPendingCoinMints/);
  assert.match(
    source,
    /export async function resumeMcpPendingCoinMints\([\s\S]*?\) \{\s*requireMcpMintIndexingBackend\(\);\s*const ref = requireFolder/,
    "unsupported startup recovery must fail before it can read and mutate the Mint journal",
  );
  assert.match(source, /finalizeSource: async \(record\)/);
  assert.match(source, /persistMembership: async \(record\)/);
  assert.match(source, /persistLocal: \(record\)/);

  const attach = serverSource.indexOf("await workspace.attach");
  const recovery = serverSource.indexOf("const syncPendingMints = async");
  assert.ok(attach >= 0 && recovery > attach, "Mint recovery must start only after workspace attach");
  assert.match(serverSource, /pendingMcpCoinMintCount\(workspace\) === 0/);
  assert.match(
    serverSource,
    /const installMintRecovery = \(\) => \{[\s\S]*?if \(mcpMintIndexingBackendAvailable\(\)\) installMintRecovery\(\)/,
  );
  assert.match(
    serverSource,
    /await runMcpMintLifecycle\([\s\S]*?resumeMcpPendingCoinMints\(workspace, voice\)/,
  );
  assert.match(serverSource, /void runMintRecovery\("initial"\)/);
  assert.match(
    serverSource,
    /MINT_RECOVERY_MIN_MS = 5_000[\s\S]*?MINT_RECOVERY_MAX_MS = 5 \* 60_000/,
  );
  assert.match(serverSource, /mintRetryDelayMs = Math\.min\(MINT_RECOVERY_MAX_MS/);
  assert.match(serverSource, /mintRetryTimer = setTimeout/);
  assert.match(
    serverSource,
    /const mintJournalWatch = setInterval[\s\S]*?mintRetryTimer[\s\S]*?pendingMcpCoinMintCount\(workspace\) === 0[\s\S]*?runMintRecovery\("scheduled"\)/,
  );
  assert.match(serverSource, /mintJournalWatch\.unref\(\)/);
  assert.doesNotMatch(serverSource, /const mintSyncTimer = setInterval/);
  assert.match(source, /runMcpMintLifecycle\(async \(\) => \{/);
});

test("every mutating MCP handler shares the Mint recovery lifecycle queue", () => {
  for (const tool of ["zine_step", "zine_send", "zine_attest", "zine_mint_span", "zine_delete"]) {
    const start = source.indexOf(`"${tool}"`);
    const next = source.indexOf("server.tool(", start + 1);
    const handler = source.slice(start, next === -1 ? undefined : next);
    assert.match(handler, /=> runMcpMintLifecycle\(async \(\) => \{/);
  }
});

test("a concurrent Step waits for startup Mint recovery to release the mutation queue", async () => {
  const { runMcpMintLifecycle } = await import("./tools.js");
  let releaseRecovery!: () => void;
  const order: string[] = [];
  const recovery = runMcpMintLifecycle(async () => {
    order.push("recovery-start");
    await new Promise<void>((resolve) => { releaseRecovery = resolve; });
    order.push("recovery-end");
  });
  const step = runMcpMintLifecycle(async () => {
    order.push("step");
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["recovery-start"]);
  releaseRecovery();
  await Promise.all([recovery, step]);
  assert.deepEqual(order, ["recovery-start", "recovery-end", "step"]);
});

test("MCP authenticates an extracted source before deriving or journaling a Mint", () => {
  const mint = source.slice(source.indexOf('"zine_mint_span"'), source.indexOf('"zine_delete"'));
  const verified = mint.indexOf("verifiedFileSourceSnapshot(sourceEvent, originNodeId)");
  const hashed = mint.indexOf("sha256HexLocal(sourceSnapshot)");
  const prepared = mint.indexOf("preparePendingCoinMint(operationKey");
  assert.ok(verified >= 0 && verified < hashed && hashed < prepared);
});

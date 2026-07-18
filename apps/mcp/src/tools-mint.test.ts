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

test("MCP startup resumes durable Mint transactions without another tool call", () => {
  assert.match(source, /export function mcpCoinMintCompletion/);
  assert.match(source, /export async function resumeMcpPendingCoinMints/);
  assert.match(source, /finalizeSource: async \(record\)/);
  assert.match(source, /persistMembership: async \(record\)/);
  assert.match(source, /persistLocal: \(record\)/);

  const attach = serverSource.indexOf("await workspace.attach");
  const recovery = serverSource.indexOf("const syncPendingMints = async");
  assert.ok(attach >= 0 && recovery > attach, "Mint recovery must start only after workspace attach");
  assert.match(serverSource, /pendingMcpCoinMintCount\(workspace\) === 0/);
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

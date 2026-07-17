import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const appSource = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");

function sourceBetween(start: string, end: string): string {
  const from = appSource.indexOf(start);
  const to = appSource.indexOf(end, from);
  assert.notEqual(from, -1, `missing ${start}`);
  assert.notEqual(to, -1, `missing ${end}`);
  return appSource.slice(from, to);
}

test("historical and Mint forks resolve recursive destination folders", () => {
  const replayFork = sourceBetween(
    "async function forkFromSnapshot()",
    "/** Dismiss the fork modal",
  );
  const mintFork = sourceBetween(
    "async function forkMintedNodes(",
    "/** Adopt selected Scan entries",
  );

  assert.match(replayFork, /forkFileIntoLocalTree\(/);
  assert.match(replayFork, /storagePath: ROOT/);
  assert.match(mintFork, /forkFileIntoLocalTree\(/);
  assert.match(mintFork, /storagePath: ROOT/);
  assert.doesNotMatch(replayFork, /forkFileFromNode|relativePath: forkPath/);
  assert.doesNotMatch(mintFork, /forkFileFromNode|relativePath: forkPath/);
});

test("nested Scan adoption retains explicit folder replay identities", () => {
  const adoption = sourceBetween(
    "async function adoptScannedNodes(",
    "// Move `src` (file or folder path)",
  );

  assert.match(adoption, /forkFileIntoLocalTree\(/);
  assert.match(adoption, /withPersistedFolderStates\(prev, sourceRootId\)/);
  assert.doesNotMatch(adoption, /forkFileFromNode|relativePath: destPath/);
  assert.doesNotMatch(adoption, /upsertManifestEntry\(\s*sourceRootId/);
});

import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

const appSource = [
  readFileSync(new URL("../app/AppShell.tsx", import.meta.url), "utf8"),
  readFileSync(new URL("../app/App.tsx", import.meta.url), "utf8"),
].join("\n");

function functionSource(name: string, nextMarker: string): string {
  const start = appSource.indexOf(`function ${name}`);
  const end = appSource.indexOf(nextMarker, start);
  assert.ok(start >= 0, `missing ${name}`);
  assert.ok(end > start, `missing end marker for ${name}`);
  return appSource.slice(start, end);
}

test("Step keeps the requested trace signer when MODEL text dominates the edit", () => {
  const source = functionSource("stepFile", "// setFiles is threaded");

  assert.doesNotMatch(source, /effectiveSigner|dominantVoiceInRegion|changedRegion/);
  assert.match(
    source,
    /writeRef\.current\(\s*path,\s*content,\s*tags,\s*signer,\s*runs,/s,
  );
});

test("in-place Settle and Stir retain the AUTHOR ownership context for later Step", () => {
  for (const name of ["settleLLM", "stirLLM"]) {
    const source = functionSource(
      name,
      name === "settleLLM" ? "function stirLLM" : "function replyLLM",
    );
    assert.match(
      source,
      /beginOp\(idx, secretKeyForVoice\(authorPubkey\) \?\? undefined,/,
      name,
    );
    assert.doesNotMatch(
      source,
      /beginOp\(idx, secretKeyForVoice\(pubkey\) \?\? undefined,/,
      name,
    );
  }
});

test("durable Extend attributes local MODEL text without signing or stepping it", () => {
  const extend = functionSource("extendLLM", "function settleDeDupeLLM");
  const apply = functionSource("applyDesktopArtifact", "function editFile");

  assert.doesNotMatch(extend, /beginOp|secretKeyForVoice/);
  assert.match(
    apply,
    /const modelVoicePubkey = input\.envelope\.prepared\.modelVoicePubkey/,
  );
  assert.match(apply, /opVoiceEffect\.of\(modelVoicePubkey\)/);
  assert.doesNotMatch(apply, /stepFile\(|sendStep\(|publish|mint/i);
});

test("folder Settle never bypasses focused-file preparation or writes automatically", () => {
  const source = functionSource("settleDeDupeLLM", "/** SETTLE - condense");

  assert.match(source, /AI Settle needs one focused, stepped file/);
  assert.doesNotMatch(source, /complete\(|writeFile\(|deletePath\(/);
});

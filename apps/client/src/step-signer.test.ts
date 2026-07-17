import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

const appSource = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");

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

test("in-place MODEL operations retain the AUTHOR ownership context for later Step", () => {
  for (const name of ["extendLLM", "settleLLM", "stirLLM"]) {
    const source = functionSource(name, name === "extendLLM"
      ? "function settleDeDupeLLM"
      : name === "settleLLM"
        ? "function stirLLM"
        : "function replyLLM");
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

test("folder Settle never bypasses focused-file preparation or writes automatically", () => {
  const source = functionSource("settleDeDupeLLM", "/** SETTLE - condense");

  assert.match(source, /MODEL Settle needs one focused, stepped file/);
  assert.doesNotMatch(source, /complete\(|writeFile\(|deletePath\(/);
});

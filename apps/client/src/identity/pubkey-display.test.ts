import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { formatPubkey } from "./PubkeyDisplay.js";

const PUBKEY = "0123456789abcdef".repeat(4);

test("pubkeys use the canonical first-4...last-4 display", () => {
  assert.equal(formatPubkey(PUBKEY), "0123...cdef");
  assert.equal(formatPubkey("invalid-voice"), "invalid-voice");
});

test("all standalone pubkey surfaces use the shared display", () => {
  const expectedUses: Record<string, number> = {
    "./KeysView.tsx": 1,
    "./VoiceLegend.tsx": 1,
    "../networking/Networking.tsx": 4,
    "../networking/OperatorView.tsx": 3,
    "../app/App.tsx": 1,
  };

  for (const [path, expected] of Object.entries(expectedUses)) {
    const source = readFileSync(new URL(path, import.meta.url), "utf8");
    assert.equal(
      (source.match(/<PubkeyDisplay\b/g) ?? []).length,
      expected,
      `${path} should use PubkeyDisplay ${expected} time(s)`,
    );
  }
});

test("palette selectors and file voice bars reuse the canonical voice chip", () => {
  const appSource = readFileSync(new URL("../app/App.tsx", import.meta.url), "utf8");
  const legendSource = readFileSync(new URL("./VoiceLegend.tsx", import.meta.url), "utf8");
  const chipSource = readFileSync(new URL("./VoiceChip.tsx", import.meta.url), "utf8");

  assert.equal((appSource.match(/<VoiceChip/g) ?? []).length, 4);
  assert.equal((legendSource.match(/<VoiceChip/g) ?? []).length, 1);
  assert.match(chipSource, /className="voice-chip-label"/);
  assert.match(chipSource, /className="voice-chip-pubkey"[^\n]*formatPubkey\(pubkey\)/);
  assert.match(chipSource, /<PubkeyCopyButton[\s\S]*?className="voice-chip-copy"/);
  assert.match(appSource, /copyTabIndex=\{-1\}/);
  assert.doesNotMatch(appSource, /action-palette-key-(?:trigger|option)-(?:label|id|copy)/);
  assert.doesNotMatch(legendSource, /panel-voice-chip-(?:identity|name|key|copy)/);
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./KeysView.tsx", import.meta.url), "utf8");

test("key cards make raw hex the primary copy format", () => {
  assert.match(source, /<span className="key-value-label">pubkey<\/span>/);
  assert.match(source, /<PubkeyDisplay pubkey=\{k\.pubkey\}/);
  assert.match(source, /<span className="key-value-label">private<\/span>/);
  assert.match(source, /handleSecretCopy\(k\.id, privateHex, "private"\)/);
});

test("key cards retain npub and nsec as secondary copy formats", () => {
  assert.match(source, /className="key-format-copy-btn"[\s\S]*?Copy npub/);
  assert.match(source, /handleCopy\(k\.id, npub, "npub"\)/);
  assert.match(source, /className="key-format-copy-btn"[\s\S]*?Copy nsec/);
  assert.match(source, /handleSecretCopy\(k\.id, nsec, "nsec"\)/);
});

test("secret key values require confirmation and never appear in tooltips", () => {
  assert.match(source, /window\.confirm\(/);
  assert.doesNotMatch(source, /title=\{nsec\}/);
  assert.doesNotMatch(source, /title=\{privateHex\}/);
});

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";

const store = new Map<string, string>();
// @ts-expect-error minimal localStorage shim for the keychain
globalThis.localStorage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, value),
  removeItem: (key: string) => void store.delete(key),
};

import {
  addKey,
  DEFAULT_VOICE_PALETTE,
  fontCss,
  getAuthorKey,
  getModelKeyId,
  getNodeKey,
  KEYCHAIN_FONTS,
  loadKeys,
  sanitizeVoiceIdentity,
  shuffledDefaultVoicePalette,
  voiceSpanStyle,
} from "./keys-store.js";
import { getSubstrateVoice } from "./external-voice-store.js";

beforeEach(() => store.clear());

test("fresh keychains keep voices first and infrastructure identities at the tail", () => {
  const keys = loadKeys();
  assert.deepEqual(
    keys.map((key) => key.label),
    ["voice-1", "voice-2", "voice-3", "voice-4", "voice-5", "node-1", "external-1"],
  );
  assert.deepEqual(
    keys.map((key) => key.identity).sort((a, b) => a.hue - b.hue),
    [...DEFAULT_VOICE_PALETTE].sort((a, b) => a.hue - b.hue),
  );
});

test("fresh-install colors are shuffled without mutating the ROYGBIV palette", () => {
  const original = DEFAULT_VOICE_PALETTE.map((identity) => ({ ...identity }));
  const shuffled = shuffledDefaultVoicePalette(() => 0);
  assert.notDeepEqual(shuffled, original);
  assert.deepEqual(DEFAULT_VOICE_PALETTE, original);
  assert.deepEqual(
    shuffled.map((identity) => identity.hue).sort((a, b) => a - b),
    original.map((identity) => identity.hue).sort((a, b) => a - b),
  );
});

test("starter roles are independent of their neutral voice labels", () => {
  const keys = loadKeys();
  assert.equal(getAuthorKey()?.label, "voice-1");
  assert.equal(keys.find((key) => key.id === getModelKeyId())?.label, "voice-3");
  assert.equal(getNodeKey()?.label, "node-1");
});

test("new voices continue the voice sequence instead of counting infrastructure keys", () => {
  const keys = addKey();
  assert.equal(keys.at(-1)?.label, "voice-6");
});

test("filesystem scans reuse the seeded EXTERNAL identity", () => {
  const before = loadKeys();
  const external = before.find((key) => key.label === "external-1");
  assert.ok(external);

  const voice = getSubstrateVoice("FILESYSTEM");
  assert.equal(voice.publicKey, external.pubkey);
  assert.equal(loadKeys().length, before.length);
});

test("relay voice identities accept only curated fonts and bounded color channels", () => {
  const valid = { font: fontCss(KEYCHAIN_FONTS[0]), hue: 120, sat: 45 };
  assert.equal(sanitizeVoiceIdentity(valid), valid);
  assert.equal(
    sanitizeVoiceIdentity({ ...valid, font: `${valid.font};position:fixed` }),
    null,
  );
  assert.equal(sanitizeVoiceIdentity({ ...valid, hue: Number.NaN }), null);
  assert.equal(sanitizeVoiceIdentity({ ...valid, hue: 361 }), null);
  assert.equal(sanitizeVoiceIdentity({ ...valid, sat: -1 }), null);
});

test("foreign voices receive distinct full inline identities", () => {
  const first = voiceSpanStyle("a".repeat(64));
  const second = voiceSpanStyle("b".repeat(64));
  assert.equal(first.className, "voice-span");
  assert.equal(second.className, "voice-span");
  assert.match(first.style ?? "", /font-family:/);
  assert.notEqual(first.style, second.style);
});

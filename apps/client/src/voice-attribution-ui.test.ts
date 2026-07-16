import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import type { KeyEntry } from "./keys-store.js";
import {
  collectVoiceAttributions,
  loadVoiceNicknames,
  saveVoiceNickname,
  shortVoiceKey,
  shouldShowVoiceLegend,
  voiceNpub,
} from "./voice-attribution-ui.js";

const store = new Map<string, string>();
// @ts-expect-error minimal localStorage shim for reader nickname tests
globalThis.localStorage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, value),
  removeItem: (key: string) => void store.delete(key),
};

const LOCAL = "a".repeat(64);
const FOREIGN = "b".repeat(64);
const SECOND_FOREIGN = "c".repeat(64);
const localKey: KeyEntry = {
  id: "local",
  label: "Alice",
  secretHex: "1".repeat(64),
  pubkey: LOCAL,
  identity: { font: "serif", hue: 120, sat: 45 },
  createdAt: 1,
};

beforeEach(() => store.clear());

test("voice legend aggregates coverage in first-appearance order", () => {
  const items = collectVoiceAttributions(
    [
      { voice: FOREIGN, text: "foreign" },
      { voice: LOCAL, text: "local" },
      { voice: FOREIGN, text: " again" },
      { voice: SECOND_FOREIGN, text: "" },
    ],
    [localKey],
    { [FOREIGN]: "Researcher" },
  );

  assert.deepEqual(
    items.map(({ pubkey, label, local, charCount }) => ({ pubkey, label, local, charCount })),
    [
      { pubkey: FOREIGN, label: "Researcher", local: false, charCount: 13 },
      { pubkey: LOCAL, label: "Alice", local: true, charCount: 5 },
    ],
  );
});

test("personal key labels win over reader nicknames", () => {
  const [item] = collectVoiceAttributions(
    [{ voice: LOCAL, text: "hello" }],
    [localKey],
    { [LOCAL]: "Not Alice" },
  );
  assert.equal(item.label, "Alice");
  assert.equal(item.local, true);
});

test("legend shows every non-empty attributed document, including one personal voice", () => {
  const localOnly = collectVoiceAttributions([{ voice: LOCAL, text: "hello" }], [localKey]);
  const foreignOnly = collectVoiceAttributions([{ voice: FOREIGN, text: "hello" }], [localKey]);
  const mixed = collectVoiceAttributions(
    [{ voice: LOCAL, text: "hello" }, { voice: FOREIGN, text: "world" }],
    [localKey],
  );
  assert.equal(shouldShowVoiceLegend([]), false);
  assert.equal(shouldShowVoiceLegend(localOnly), true);
  assert.equal(shouldShowVoiceLegend(foreignOnly), true);
  assert.equal(shouldShowVoiceLegend(mixed), true);
});

test("voice keys render as shortened npubs with both ends retained", () => {
  const npub = voiceNpub(FOREIGN);
  const short = shortVoiceKey(FOREIGN);
  assert.match(npub, /^npub1/);
  assert.equal(short.startsWith(npub.slice(0, 13)), true);
  assert.equal(short.endsWith(npub.slice(-6)), true);
  assert.equal(voiceNpub("legacy-voice"), "legacy-voice");
});

test("foreign nicknames persist locally and an empty label clears them", () => {
  assert.deepEqual(saveVoiceNickname(FOREIGN, "  Bob  "), { [FOREIGN]: "Bob" });
  assert.deepEqual(loadVoiceNicknames(), { [FOREIGN]: "Bob" });
  assert.deepEqual(saveVoiceNickname(FOREIGN, "  "), {});
});

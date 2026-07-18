import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import {
  activateVaultStorage,
  activeVaultStorageId,
  deactivateVaultStorage,
  vaultStorage,
} from "./vault-storage.js";

class FakeStorage implements Storage {
  private values = new Map<string, string>();

  get length(): number { return this.values.size; }
  clear(): void { this.values.clear(); }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string): void { this.values.delete(key); }
  setItem(key: string, value: string): void { this.values.set(key, String(value)); }
}

let previousStorage: Storage | undefined;
const KEY_ONE = new Uint8Array(32).fill(0x11);
const KEY_TWO = new Uint8Array(32).fill(0x22);

beforeEach(() => {
  previousStorage = (globalThis as { localStorage?: Storage }).localStorage;
  Object.defineProperty(globalThis, "localStorage", {
    value: new FakeStorage(),
    configurable: true,
    writable: true,
  });
  deactivateVaultStorage();
});

afterEach(() => {
  deactivateVaultStorage();
  if (previousStorage) {
    Object.defineProperty(globalThis, "localStorage", {
      value: previousStorage,
      configurable: true,
      writable: true,
    });
  } else {
    delete (globalThis as { localStorage?: Storage }).localStorage;
  }
});

test("vault storage keeps profile state isolated and chrome preferences global", () => {
  activateVaultStorage("vault-one", KEY_ONE);
  vaultStorage.setItem("zine.root", "root-one");
  vaultStorage.setItem("zine-theme", "dark");
  const encrypted = localStorage.getItem("zine.vault-state.vault-one");
  assert.ok(encrypted);
  const encryptedState = Array.from({ length: localStorage.length }, (_, index) =>
    localStorage.getItem(localStorage.key(index)!),
  ).join("\n");
  assert.doesNotMatch(encryptedState, /root-one|zine\.root/);

  activateVaultStorage("vault-two", KEY_TWO);
  assert.equal(vaultStorage.getItem("zine.root"), null);
  assert.equal(vaultStorage.getItem("zine-theme"), "dark");
  vaultStorage.setItem("zine.root", "root-two");

  activateVaultStorage("vault-one", KEY_ONE);
  assert.equal(vaultStorage.getItem("zine.root"), "root-one");
  assert.equal(activeVaultStorageId(), "vault-one");
});

test("legacy adoption moves existing Zine profile records exactly once", () => {
  localStorage.setItem("zine.root", "legacy-root");
  localStorage.setItem("zine.keys", "legacy-keys");
  localStorage.setItem("zine-theme", "light");

  activateVaultStorage("legacy", KEY_ONE, true);

  assert.equal(vaultStorage.getItem("zine.root"), "legacy-root");
  assert.equal(vaultStorage.getItem("zine.keys"), "legacy-keys");
  assert.equal(localStorage.getItem("zine.root"), null);
  assert.equal(localStorage.getItem("zine.keys"), null);
  assert.equal(localStorage.getItem("zine-theme"), "light");
  assert.doesNotMatch(localStorage.getItem("zine.vault-state.legacy")!, /legacy-root|legacy-keys/);

  deactivateVaultStorage();
  activateVaultStorage("legacy", KEY_ONE, true);
  assert.equal(vaultStorage.getItem("zine.root"), "legacy-root");
});

test("the wrong workspace key cannot decrypt a vault", () => {
  activateVaultStorage("vault-one", KEY_ONE);
  vaultStorage.setItem("zine.root", "protected-root");
  deactivateVaultStorage();

  assert.throws(
    () => activateVaultStorage("vault-one", KEY_TWO),
    /encrypted workspace state.*cannot be opened/i,
  );
  assert.equal(activeVaultStorageId(), null);
});

test("plaintext state from the pre-encryption multi-vault build migrates into the blob", () => {
  localStorage.setItem("zine.vault-state.vault-one.zine.root", "work-in-progress-root");

  activateVaultStorage("vault-one", KEY_ONE);

  assert.equal(vaultStorage.getItem("zine.root"), "work-in-progress-root");
  assert.equal(localStorage.getItem("zine.vault-state.vault-one.zine.root"), null);
  assert.doesNotMatch(
    localStorage.getItem("zine.vault-state.vault-one")!,
    /work-in-progress-root/,
  );
});

test("updating one logical value does not rewrite the vault index or sibling records", () => {
  activateVaultStorage("vault-one", KEY_ONE);
  vaultStorage.setItem("zine.root", "root-one");
  vaultStorage.setItem("zine.keys", "keys-one");

  const indexBefore = localStorage.getItem("zine.vault-state.vault-one");
  const recordsBefore = new Map(
    Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index)!)
      .filter((key) => key.startsWith("zine.vault-record.vault-one."))
      .map((key) => [key, localStorage.getItem(key)]),
  );
  vaultStorage.setItem("zine.keys", "keys-two");
  const recordsAfter = new Map(
    [...recordsBefore.keys()].map((key) => [key, localStorage.getItem(key)]),
  );

  assert.equal(localStorage.getItem("zine.vault-state.vault-one"), indexBefore);
  assert.equal(
    [...recordsBefore.keys()].filter((key) => recordsBefore.get(key) !== recordsAfter.get(key)).length,
    1,
  );
});

test("late desktop callbacks cannot write plaintext after storage deactivation", () => {
  activateVaultStorage("vault-one", KEY_ONE);
  deactivateVaultStorage();

  assert.throws(
    () => vaultStorage.setItem("zine.root", "late-root"),
    /workspace is locked/i,
  );
  assert.equal(localStorage.getItem("zine.root"), null);
  vaultStorage.setItem("zine-theme", "dark");
  assert.equal(localStorage.getItem("zine-theme"), "dark");
});

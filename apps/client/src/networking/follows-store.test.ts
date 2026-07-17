import test from "node:test";
import assert from "node:assert/strict";

import { addFollow, loadFollows, removeFollow } from "./follows-store.js";

class MemoryStorage {
  private values = new Map<string, string>();
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

test("following is a deduped local reader list", () => {
  const storage = new MemoryStorage();
  const pubkey = "a".repeat(64);
  addFollow(pubkey, "Alice", storage);
  addFollow(pubkey, "Alice revised", storage);
  assert.deepEqual(loadFollows(storage), [{ pubkey, label: "Alice revised" }]);
  assert.deepEqual(removeFollow(pubkey, storage), []);
});


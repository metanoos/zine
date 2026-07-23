import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_REPLAY_SPEED,
  REPLAY_SPEED_STORAGE_KEY,
  REPLAY_SPEEDS,
  loadReplaySpeed,
  nextReplaySpeed,
  saveReplaySpeed,
} from "./replay-speed.js";

class MemoryStorage {
  values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, String(value));
  }
}

test("replay speed defaults to 4x when no valid preference is stored", () => {
  const storage = new MemoryStorage();
  assert.equal(DEFAULT_REPLAY_SPEED, 4);
  assert.equal(loadReplaySpeed(storage), 4);

  storage.setItem(REPLAY_SPEED_STORAGE_KEY, "3");
  assert.equal(loadReplaySpeed(storage), 4);
  storage.setItem(REPLAY_SPEED_STORAGE_KEY, "not-a-speed");
  assert.equal(loadReplaySpeed(storage), 4);
});

test("replay speed preferences round-trip for every supported speed", () => {
  const storage = new MemoryStorage();
  for (const speed of REPLAY_SPEEDS) {
    saveReplaySpeed(speed, storage);
    assert.equal(storage.getItem(REPLAY_SPEED_STORAGE_KEY), String(speed));
    assert.equal(loadReplaySpeed(storage), speed);
  }
});

test("replay speed cycles in order and wraps", () => {
  assert.deepEqual(
    REPLAY_SPEEDS.map(nextReplaySpeed),
    [2, 4, 8, 16, 1],
  );
});

test("replay speed storage failures leave the 4x default usable", () => {
  const storage = {
    getItem(): string | null {
      throw new Error("unavailable");
    },
    setItem(): void {
      throw new Error("unavailable");
    },
  };

  assert.equal(loadReplaySpeed(storage), 4);
  assert.doesNotThrow(() => saveReplaySpeed(8, storage));
});

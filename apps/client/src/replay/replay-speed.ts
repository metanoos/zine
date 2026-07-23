import { vaultStorage as localStorage } from "../storage/vault-storage.js";

export const REPLAY_SPEEDS = [1, 2, 4, 8, 16] as const;
export type ReplaySpeed = (typeof REPLAY_SPEEDS)[number];

export const DEFAULT_REPLAY_SPEED: ReplaySpeed = 4;
export const REPLAY_SPEED_STORAGE_KEY = "zine.press.replaySpeed";

type ReplaySpeedStorage = Pick<Storage, "getItem" | "setItem">;

export function loadReplaySpeed(
  storage: ReplaySpeedStorage = localStorage,
): ReplaySpeed {
  try {
    const stored = storage.getItem(REPLAY_SPEED_STORAGE_KEY);
    return REPLAY_SPEEDS.find((speed) => String(speed) === stored)
      ?? DEFAULT_REPLAY_SPEED;
  } catch {
    return DEFAULT_REPLAY_SPEED;
  }
}

export function saveReplaySpeed(
  speed: ReplaySpeed,
  storage: ReplaySpeedStorage = localStorage,
): void {
  try {
    storage.setItem(REPLAY_SPEED_STORAGE_KEY, String(speed));
  } catch {
    // Storage is a convenience. The in-memory setting still applies.
  }
}

export function nextReplaySpeed(speed: ReplaySpeed): ReplaySpeed {
  const index = REPLAY_SPEEDS.indexOf(speed);
  return REPLAY_SPEEDS[(index + 1) % REPLAY_SPEEDS.length];
}

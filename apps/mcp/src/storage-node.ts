/**
 * Node-side localStorage shim for zine-mcp.
 *
 * The shared client modules (`identity.ts`, `keys-store.ts`, `relay-config.ts`)
 * persist through `localStorage` — browser-only. zine-mcp runs under Node, so
 * there is no `localStorage`. The smallest fix that leaves those modules
 * untouched is to install a conformant shim onto `globalThis.localStorage`
 * before they import, backed by one JSON file on disk.
 *
 * Semantics that matter to the callers:
 *   - `getItem(k)` returns `null` for a missing key (NOT undefined, NOT "").
 *     This is what `keys-store.ts`'s `seedIfEmpty` relies on to detect a first
 *     run and mint the agent voice key — returning "" would skip seeding and
 *     leave zine-mcp with no signer.
 *   - `setItem(k, v)` accepts a string and persists immediately (write-through,
 *     synchronous from the caller's perspective). The shared modules never
 *     batch writes, so write-through is correct and avoids a flush-on-exit race.
 *   - `removeItem(k)` is a no-op when the key is absent.
 *
 * Concurrency: a profile lock enforces one writer per config file. Different
 * harnesses should use distinct `--profile` names; the desktop client uses a
 * separate browser localStorage store.
 */
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const DEFAULT_CONFIG_PATH = join(homedir(), ".zine", "mcp.json");
const PROFILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const heldLocks = new Map<string, number>();
let cleanupInstalled = false;

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  clear(): void;
}

/**
 * A localStorage-compatible store backed by a JSON map on disk. Reads lazily
 * on first access and writes through on every mutation. Constructed once and
 * assigned to `globalThis.localStorage` by `installNodeStorage`.
 */
class NodeLocalStorage implements StorageLike {
  private readonly path: string;
  /** Lazily loaded. `null` means "loaded and empty"; undefined means "not yet". */
  private map: Record<string, string> | undefined;

  constructor(path: string) {
    this.path = path;
  }

  private load(): Record<string, string> {
    if (this.map !== undefined) return this.map;
    if (!existsSync(this.path)) {
      this.map = {};
      return this.map;
    }
    try {
      // This file contains the headless press's signing key. Enforce private
      // permissions before reading any secret material.
      chmodSync(this.path, 0o600);
      const raw = readFileSync(this.path, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (
        !parsed ||
        typeof parsed !== "object" ||
        Array.isArray(parsed) ||
        Object.values(parsed).some((value) => typeof value !== "string")
      ) {
        throw new Error("profile state must be a JSON object of string values");
      }
      this.map = parsed as Record<string, string>;
    } catch (error) {
      throw new Error(
        `cannot read headless profile ${this.path}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return this.map;
  }

  private flush(): void {
    const dir = dirname(this.path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const temp = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    let fd: number | null = null;
    try {
      fd = openSync(temp, "wx", 0o600);
      writeFileSync(fd, JSON.stringify(this.map ?? {}, null, 2), "utf8");
      fsyncSync(fd);
      closeSync(fd);
      fd = null;
      renameSync(temp, this.path);
    } catch (error) {
      if (fd !== null) closeSync(fd);
      try {
        unlinkSync(temp);
      } catch {
        // The temp may not have been created or may already have been renamed.
      }
      throw error;
    }
    // Atomic rename preserves the old file until the replacement is complete.
    chmodSync(this.path, 0o600);
  }

  getItem(key: string): string | null {
    const v = this.load()[key];
    // localStorage.getItem returns null for missing keys and the string (even
    // "") for present ones. Returning `undefined` would break the
    // `if (existing)` checks the shared modules use.
    return v === undefined ? null : v;
  }

  setItem(key: string, value: string): void {
    const m = this.load();
    m[key] = String(value);
    this.flush();
  }

  removeItem(key: string): void {
    const m = this.load();
    if (key in m) {
      delete m[key];
      this.flush();
    }
  }

  clear(): void {
    this.map = {};
    this.flush();
  }
}

export function configPathForProfile(
  profile = "default",
  explicitPath?: string,
): string {
  if (!PROFILE_RE.test(profile)) {
    throw new Error(
      "--profile must be 1-64 characters using letters, numbers, dot, underscore, or dash",
    );
  }
  if (explicitPath) return explicitPath;
  return profile === "default"
    ? DEFAULT_CONFIG_PATH
    : join(homedir(), ".zine", "profiles", `${profile}.json`);
}

function processExists(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function releaseLocks(): void {
  for (const [path, fd] of heldLocks) {
    try {
      closeSync(fd);
    } catch {
      // Best-effort process-exit cleanup.
    }
    try {
      unlinkSync(`${path}.lock`);
    } catch {
      // A stale/missing lock is harmless at exit.
    }
  }
  heldLocks.clear();
}

function acquireProfileLock(path: string): void {
  if (heldLocks.has(path)) return;
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const lockPath = `${path}.lock`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockPath, "wx", 0o600);
      writeFileSync(fd, `${process.pid}\n`, "utf8");
      fsyncSync(fd);
      heldLocks.set(path, fd);
      if (!cleanupInstalled) {
        cleanupInstalled = true;
        process.once("exit", releaseLocks);
      }
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let ownerPid = 0;
      try {
        ownerPid = Number.parseInt(readFileSync(lockPath, "utf8").trim(), 10);
      } catch {
        // Treat an unreadable lock as stale and retry once.
      }
      if (processExists(ownerPid)) {
        throw new Error(
          `headless profile ${path} is already open by process ${ownerPid}; use another --profile`,
        );
      }
      unlinkSync(lockPath);
    }
  }
  throw new Error(`could not lock headless profile ${path}`);
}

/**
 * Install the disk-backed localStorage shim onto `globalThis` and return the
 * resolved config path. Must run BEFORE any import that touches the shared
 * client modules (`identity.ts`, `keys-store.ts`, `relay-config.ts`); in
 * practice that means calling it at the very top of `server.ts` before the
 * dynamic import of the workspace.
 *
 * If `globalThis.localStorage` is already defined (Node ≥22 ships a native one),
 * honor the caller's explicit path by *replacing* it with our disk-backed
 * instance — the native one is in-memory only and would lose the agent key on
 * every restart, defeating the whole point of a persisted voice.
 */
export function installNodeStorage(
  configPath: string | undefined,
  profile = "default",
): string {
  const path = configPathForProfile(profile, configPath);
  acquireProfileLock(path);
  const store = new NodeLocalStorage(path);
  (globalThis as { localStorage?: StorageLike }).localStorage = store;
  return path;
}

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
 * Concurrency: a single zine-mcp process owns its config file. Two presses
 * writing the same `~/.zine/mcp.json` (e.g. two harnesses spawned against the
 * same folder) would race — but the desktop client uses browser localStorage
 * (a different store), so in practice the only writer here is this process.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const DEFAULT_CONFIG_PATH = join(homedir(), ".zine", "mcp.json");

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
      const raw = readFileSync(this.path, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      this.map =
        parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as Record<string, string>)
          : {};
    } catch {
      // A corrupt config file is treated as empty — better to reseed a fresh
      // agent key than to crash on startup. The desktop app takes the same
      // posture (keys-store.ts: "Corrupt blob — fall through and reseed").
      this.map = {};
    }
    return this.map;
  }

  private flush(): void {
    const dir = dirname(this.path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.map ?? {}, null, 2), "utf8");
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
export function installNodeStorage(configPath: string | undefined): string {
  const path = configPath ?? DEFAULT_CONFIG_PATH;
  const store = new NodeLocalStorage(path);
  (globalThis as { localStorage?: StorageLike }).localStorage = store;
  return path;
}

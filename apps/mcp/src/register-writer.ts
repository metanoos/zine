/**
 * Auto-register the headless press's agent key as a writer on the local relay.
 *
 * This is the hassle-free piece. On boot, after seeding the agent voice key,
 * zine-mcp appends its own pubkey to ~/.tracer/peers.json's `writers` array
 * so the relay (which polls the file every 5s) grants it read+write-as-self
 * access. Without this, a networked-mode relay rejects every `zine_step` with
 * "auth-required" (peers are read-only by design — see relay/access-policy.go).
 *
 * Consent model: zine-mcp is a process the user explicitly installed and
 * configured in an MCP client. Registering its *own* key (never anyone else's)
 * to the local relay is the same posture as the desktop app seeding its owner
 * key. The owner can remove the writer via the desktop app at any time.
 *
 * Idempotent: if the key is already a writer, this is a no-op. The MCP server
 * and desktop shell share a short-lived peers.json.lock around the
 * read-modify-write, preventing either process from discarding the other's
 * ACL update. The relay polls every 5s, so the new writer is picked up without
 * a restart.
 *
 * If peers.json doesn't exist (local mode — no owner set), this is a no-op:
 * there's no ACL to join, the relay accepts everyone.
 */
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const PEERS_PATH = join(homedir(), ".tracer", "peers.json");
const LOCK_PATH = PEERS_PATH + ".lock";
const LOCK_TIMEOUT_MS = 2_000;
const STALE_LOCK_MS = 30_000;

interface PeersFile {
  owner?: string;
  peers?: string[];
  writers?: string[];
}

const sleepArray = new Int32Array(new SharedArrayBuffer(4));

/** Run one peers.json read-modify-write while holding the lock shared with the
 * desktop shell. Returns null when another healthy writer owns it too long. */
export function withExclusiveFileLock<T>(
  lockPath: string,
  fn: () => T,
  timeoutMs = LOCK_TIMEOUT_MS,
): T | null {
  const deadline = Date.now() + timeoutMs;
  let fd: number | null = null;
  while (fd === null) {
    try {
      fd = openSync(lockPath, "wx", 0o600);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") return null;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > STALE_LOCK_MS) {
          unlinkSync(lockPath);
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() >= deadline) return null;
      Atomics.wait(sleepArray, 0, 0, 10);
    }
  }
  try {
    return fn();
  } finally {
    closeSync(fd);
    try {
      unlinkSync(lockPath);
    } catch {
      // A stale-lock recovery may already have removed it.
    }
  }
}

/**
 * Ensure `pubkey` is in peers.json's `writers` array. No-op if it's already
 * there, or if the file doesn't exist (local mode). Logs what it did. Never
 * throws — a failure here degrades to the attach() retry surfacing the auth
 * error, which is the right place to report it.
 */
export function registerAgentWriter(pubkey: string): "registered" | "already" | "local-mode" | "skipped" {
  const dir = dirname(PEERS_PATH);
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  } catch {
    return "skipped";
  }
  return withExclusiveFileLock(LOCK_PATH, () => {
    if (!existsSync(PEERS_PATH)) {
      // Local mode — no ACL. The relay accepts all connections; nothing to join.
      return "local-mode";
    }
    let pf: PeersFile;
    try {
      pf = JSON.parse(readFileSync(PEERS_PATH, "utf8")) as PeersFile;
    } catch {
      // Corrupt file — don't risk clobbering it. Let the relay/owner fix it;
      // the attach failure will surface the auth problem.
      return "skipped";
    }
    // No owner set → local mode (same as missing file).
    if (!pf.owner || pf.owner.length !== 64) return "local-mode";

    const writers = pf.writers ?? [];
    if (writers.includes(pubkey)) return "already";

    pf.writers = [...writers, pubkey];
    try {
      // Atomic write (temp + rename), matching the Rust side's write_peers_file
      // so a crash mid-write never leaves a corrupt file.
      const tmp = PEERS_PATH + ".tmp";
      writeFileSync(tmp, JSON.stringify(pf, null, 2), { encoding: "utf8", mode: 0o600 });
      renameSync(tmp, PEERS_PATH);
    } catch {
      // Read-only home or permission issue. The attach() retry surfaces auth.
      return "skipped";
    }
    return "registered";
  }) ?? "skipped";
}

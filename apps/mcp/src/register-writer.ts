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
 * pointed at --folder/--relay. Registering its *own* key (never anyone else's)
 * to the local relay is the same posture as the desktop app seeding its owner
 * key. The owner can remove the writer via the desktop app at any time.
 *
 * Idempotent: if the key is already a writer, this is a no-op. Best-effort on
 * the write — if peers.json is being written concurrently by the desktop
 * app, a lost update here just means retrying on the next boot (the agent key
 * is re-added then). The relay polls every 5s, so the new writer is picked up
 * without a restart.
 *
 * If peers.json doesn't exist (local mode — no owner set), this is a no-op:
 * there's no ACL to join, the relay accepts everyone.
 *
 * Migration: if peers.json is absent but the legacy friends.json exists, this
 * renames it into place first (the relay and the Rust app run the same check,
 * so whichever process reads first wins). Tolerant of a `friends` JSON key.
 */
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const PEERS_PATH = join(homedir(), ".tracer", "peers.json");
const LEGACY_FRIENDS_PATH = join(homedir(), ".tracer", "friends.json");

interface PeersFile {
  owner?: string;
  peers?: string[];
  /** Legacy alias for `peers`, from before the rename. Tolerated on read. */
  friends?: string[];
  /** Absent on older files — treated as empty. */
  writers?: string[];
}

/**
 * One-shot migration: rename friends.json → peers.json (remapping the `friends`
 * JSON key to `peers`). No-op if peers.json already exists or friends.json is
 * absent. Idempotent across the three processes that read this file.
 */
function migrateLegacyFile(): void {
  if (existsSync(PEERS_PATH) || !existsSync(LEGACY_FRIENDS_PATH)) return;
  try {
    const raw = readFileSync(LEGACY_FRIENDS_PATH, "utf8");
    const generic = JSON.parse(raw) as Record<string, unknown>;
    if (generic.peers === undefined && generic.friends !== undefined) {
      generic.peers = generic.friends;
      delete generic.friends;
    }
    const dir = dirname(PEERS_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmp = PEERS_PATH + ".tmp";
    writeFileSync(tmp, JSON.stringify(generic, null, 2), "utf8");
    renameSync(tmp, PEERS_PATH);
  } catch {
    // Corrupt legacy file — leave it; the relay/Rust reader will try again,
    // and a failure here just degrades to the attach() auth error surfacing.
    return;
  }
}

/**
 * Ensure `pubkey` is in peers.json's `writers` array. No-op if it's already
 * there, or if the file doesn't exist (local mode). Logs what it did. Never
 * throws — a failure here degrades to the attach() retry surfacing the auth
 * error, which is the right place to report it.
 */
export function registerAgentWriter(pubkey: string): "registered" | "already" | "local-mode" | "skipped" {
  migrateLegacyFile();
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
    const dir = dirname(PEERS_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmp = PEERS_PATH + ".tmp";
    writeFileSync(tmp, JSON.stringify(pf, null, 2), "utf8");
    renameSync(tmp, PEERS_PATH);
  } catch {
    // Read-only home, permission issue, or concurrent write — the attach()
    // retry will surface the auth rejection. Not fatal on its own.
    return "skipped";
  }
  return "registered";
}

/** The path zine-mcp writes, exposed for logging + tests. */
export const peersPath = PEERS_PATH;

// Safe source-checkout updates for the default `git clone` installation.
//
// A source install should update through Git, not through Tauri's binary
// updater. We fetch and fast-forward only when the checkout is clean and the
// current branch has an upstream. Local work is never stashed, reset, or
// merged, and network/update failures do not stop `npm start` from launching
// the version already on disk.

import { spawnSync } from "node:child_process";
import { lstatSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const defaultRepoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_FETCH_TIMEOUT_MS = 15_000;
const DISABLED_VALUES = new Set(["0", "false", "no", "off"]);

function runGit(args, { repoRoot, timeoutMs = 5_000 } = {}) {
  return spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: timeoutMs,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
}

function output(result) {
  return result.stdout?.trim() ?? "";
}

function succeeded(result) {
  return !result.error && result.status === 0;
}

function shortRevision(revision) {
  return revision.slice(0, 8);
}

function pathExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    // If metadata cannot be inspected, treat the path as occupied. Updating is
    // optional; preserving an unreadable local path is not.
    return true;
  }
}

function incomingPathCollisions(repoRoot) {
  // Git is willing to replace ignored files when an incoming revision starts
  // tracking the same path. Limit the scan to paths that are absent from HEAD
  // and newly present upstream; `--no-renames` also exposes rename destinations
  // as additions.
  const addedResult = runGit(
    ["diff", "--name-only", "-z", "--no-renames", "--diff-filter=A", "HEAD", "@{upstream}"],
    { repoRoot },
  );
  if (!succeeded(addedResult)) return null;
  return addedResult.stdout
    .split("\0")
    .filter(Boolean)
    .filter((path) => pathExists(join(repoRoot, path)));
}

function autoUpdateDisabled(env) {
  const value = env.ZINE_AUTO_UPDATE?.trim().toLowerCase();
  return value ? DISABLED_VALUES.has(value) : false;
}

/**
 * Fetch and fast-forward a clean checkout's current tracking branch.
 *
 * The structured result lets the source launcher restart itself only after files
 * actually changed, while the standalone `npm run update` command can report a
 * useful exit status.
 */
export function updateSourceCheckout({
  repoRoot = defaultRepoRoot,
  disabled = false,
  env = process.env,
  logger = console,
  fetchTimeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
} = {}) {
  if (disabled || autoUpdateDisabled(env)) {
    logger.log("! source auto-update disabled; using the current checkout");
    return { status: "disabled" };
  }

  const inside = runGit(["rev-parse", "--is-inside-work-tree"], { repoRoot });
  if (!succeeded(inside) || output(inside) !== "true") {
    logger.log("! source update unavailable (not a Git checkout); using the current files");
    return { status: "not-checkout" };
  }

  const branchResult = runGit(["symbolic-ref", "--quiet", "--short", "HEAD"], { repoRoot });
  if (!succeeded(branchResult)) {
    logger.log("! source update skipped (detached HEAD); using the checked-out revision");
    return { status: "detached" };
  }
  const branch = output(branchResult);

  const upstreamResult = runGit(
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
    { repoRoot },
  );
  if (!succeeded(upstreamResult)) {
    logger.log(`! source update skipped (${branch} has no upstream branch)`);
    return { status: "no-upstream", branch };
  }
  const upstream = output(upstreamResult);

  const statusResult = runGit(["status", "--porcelain=v1", "--untracked-files=normal"], {
    repoRoot,
  });
  if (!succeeded(statusResult)) {
    logger.warn("! source update check failed; using the current checkout");
    return { status: "failed", branch, upstream };
  }
  if (output(statusResult)) {
    logger.log(
      "! source update skipped (checkout has local changes); " +
        "commit or stash them, then run npm run update",
    );
    return { status: "dirty", branch, upstream };
  }

  const remoteResult = runGit(["config", "--get", `branch.${branch}.remote`], { repoRoot });
  if (!succeeded(remoteResult) || !output(remoteResult)) {
    logger.log(`! source update skipped (cannot resolve the remote for ${upstream})`);
    return { status: "no-upstream", branch, upstream };
  }
  const remote = output(remoteResult);

  const beforeResult = runGit(["rev-parse", "HEAD"], { repoRoot });
  if (!succeeded(beforeResult)) {
    logger.warn("! source update check failed; using the current checkout");
    return { status: "failed", branch, upstream };
  }
  const before = output(beforeResult);

  logger.log(`→ checking ${upstream} for source updates…`);
  const fetchResult = runGit(["fetch", "--quiet", "--no-tags", "--", remote], {
    repoRoot,
    timeoutMs: fetchTimeoutMs,
  });
  if (!succeeded(fetchResult)) {
    logger.warn("! source update unavailable (offline or fetch failed); using the current checkout");
    return { status: "failed", branch, upstream, before };
  }

  const targetResult = runGit(["rev-parse", "@{upstream}"], { repoRoot });
  if (!succeeded(targetResult)) {
    logger.warn(`! source update check failed after fetching ${upstream}; using the current checkout`);
    return { status: "failed", branch, upstream, before };
  }
  const target = output(targetResult);

  if (target === before) {
    logger.log(`✓ source current (${upstream} at ${shortRevision(before)})`);
    return { status: "current", branch, upstream, before, after: before };
  }

  const canFastForward = runGit(["merge-base", "--is-ancestor", "HEAD", "@{upstream}"], {
    repoRoot,
  });
  if (!succeeded(canFastForward)) {
    const upstreamIsAncestor = runGit(
      ["merge-base", "--is-ancestor", "@{upstream}", "HEAD"],
      { repoRoot },
    );
    if (succeeded(upstreamIsAncestor)) {
      logger.log(`✓ source current (${branch} contains ${upstream})`);
      return { status: "current", branch, upstream, before, after: before };
    }
    logger.warn(
      `! source update skipped (${branch} and ${upstream} have diverged); ` +
        "reconcile them with Git before updating",
    );
    return { status: "diverged", branch, upstream, before };
  }

  const collisions = incomingPathCollisions(repoRoot);
  if (collisions === null) {
    logger.warn("! source update safety check failed; using the current checkout");
    return { status: "failed", branch, upstream, before };
  }
  if (collisions.length > 0) {
    logger.warn(
      `! source update skipped (incoming files would replace local paths: ${collisions.join(", ")})`,
    );
    return { status: "local-collision", branch, upstream, before };
  }

  const mergeResult = runGit(["merge", "--ff-only", "--quiet", "@{upstream}"], { repoRoot });
  if (!succeeded(mergeResult)) {
    logger.warn("! source fast-forward failed; using the current checkout");
    return { status: "failed", branch, upstream, before };
  }

  const afterResult = runGit(["rev-parse", "HEAD"], { repoRoot });
  const after = succeeded(afterResult) ? output(afterResult) : target;
  logger.log(`✓ source updated ${shortRevision(before)} → ${shortRevision(after)} (${upstream})`);
  return { status: "updated", branch, upstream, before, after };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = updateSourceCheckout();
  if (
    [
      "dirty",
      "diverged",
      "failed",
      "detached",
      "local-collision",
      "no-upstream",
      "not-checkout",
    ].includes(result.status)
  ) {
    process.exitCode = 1;
  }
}

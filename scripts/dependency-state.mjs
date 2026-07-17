import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const DEPENDENCY_STAMP = ".zine-dependencies.sha256";
const DEPENDENCY_MANIFESTS = ["package.json", "package-lock.json"];

/** Hash the exact npm inputs that `npm ci` installs from. */
export function dependencyFingerprint(packageDir) {
  const hash = createHash("sha256");
  for (const name of DEPENDENCY_MANIFESTS) {
    hash.update(name);
    hash.update("\0");
    hash.update(readFileSync(join(packageDir, name)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

/** True only when node_modules was installed from the current manifests. */
export function dependenciesCurrent(packageDir) {
  const modulesDir = join(packageDir, "node_modules");
  if (!existsSync(modulesDir)) return false;
  try {
    const installed = readFileSync(join(modulesDir, DEPENDENCY_STAMP), "utf8").trim();
    return installed === dependencyFingerprint(packageDir);
  } catch {
    return false;
  }
}

/** Record a successful deterministic install without touching package inputs. */
export function markDependenciesCurrent(packageDir) {
  writeFileSync(
    join(packageDir, "node_modules", DEPENDENCY_STAMP),
    `${dependencyFingerprint(packageDir)}\n`,
    "utf8",
  );
}

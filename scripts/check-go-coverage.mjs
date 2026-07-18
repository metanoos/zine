import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

export const GO_COVERAGE_FLOORS = Object.freeze({
  "github.com/zine/relay": 56,
  "github.com/zine/relay/cmd/hosted": 67,
});

export function parseGoCoverage(output) {
  const coverage = new Map();
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(
      /^ok\s+(\S+).*\bcoverage:\s+([0-9]+(?:\.[0-9]+)?)% of statements\s*$/,
    );
    if (match) coverage.set(match[1], Number(match[2]));
  }
  return coverage;
}

export function enforceGoCoverage(output, floors = GO_COVERAGE_FLOORS) {
  const actual = parseGoCoverage(output);
  const failures = [];
  for (const [packageName, floor] of Object.entries(floors)) {
    const measured = actual.get(packageName);
    if (measured === undefined) {
      failures.push(`${packageName}: no coverage result`);
    } else if (measured < floor) {
      failures.push(`${packageName}: ${measured.toFixed(1)}% is below ${floor.toFixed(1)}%`);
    }
  }
  if (failures.length > 0) {
    throw new Error(`Go coverage floor failed:\n${failures.join("\n")}`);
  }
  return actual;
}

export function runGoCoverage() {
  const result = spawnSync("go", ["test", "-cover", "./..."], {
    cwd: join(repoRoot, "relay"),
    encoding: "utf8",
    env: process.env,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`go test -cover ./... exited ${result.status ?? "without a status"}`);
  }
  enforceGoCoverage(result.stdout);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    runGoCoverage();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

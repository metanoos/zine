import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const tempRoot = mkdtempSync(join(tmpdir(), "zine-mcp-package-"));
const expectedFiles = ["README.md", "dist/server.js", "package.json"];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
  if (result.error || result.status !== 0) {
    const detail = [result.stdout, result.stderr, result.error?.message]
      .filter(Boolean)
      .join("\n");
    throw new Error(
      `${command} ${args.join(" ")} failed with status ${String(result.status)}\n${detail}`,
    );
  }
  return result;
}

function runNpm(args, options = {}) {
  if (process.env.npm_execpath) {
    return run(process.execPath, [process.env.npm_execpath, ...args], options);
  }
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  return run(npm, args, {
    ...options,
    shell: process.platform === "win32",
  });
}

function assertNoLocalDependencies(manifest) {
  assert.doesNotMatch(
    JSON.stringify(manifest),
    /(?:file|link):|\.\.[/\\]\.\.[/\\]/,
    "package metadata must not reference the repository",
  );
  for (const field of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ]) {
    for (const [name, specifier] of Object.entries(manifest[field] ?? {})) {
      assert.equal(
        typeof specifier,
        "string",
        `${field}.${name} must be a string`,
      );
      assert.doesNotMatch(
        specifier,
        /^(?:file|link):|(?:^|[/\\])\.\.(?:[/\\]|$)/,
        `${field}.${name} must not reference the repository`,
      );
    }
  }
}

try {
  const packDir = join(tempRoot, "pack");
  mkdirSync(packDir);

  runNpm(["run", "build"], { cwd: packageRoot });
  const packed = runNpm(
    ["pack", "--ignore-scripts", "--json", "--pack-destination", packDir],
    { cwd: packageRoot },
  );
  const packResults = JSON.parse(packed.stdout);
  assert.equal(packResults.length, 1, "npm pack must produce exactly one tarball");
  const packResult = packResults[0];
  assert.deepEqual(
    packResult.files.map((file) => file.path).sort(),
    expectedFiles,
    "tarball surface changed",
  );
  const packedBin = packResult.files.find((file) => file.path === "dist/server.js");
  assert.ok(packedBin, "tarball is missing dist/server.js");
  assert.notEqual(packedBin.mode & 0o111, 0, "packed CLI is not executable");

  const tarball = join(packDir, packResult.filename);
  const tarEntries = run("tar", ["-tzf", tarball]).stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((entry) => entry.replace(/^package\//, ""))
    .sort();
  assert.deepEqual(tarEntries, expectedFiles, "tar archive contains unexpected files");

  const manifest = JSON.parse(
    run("tar", ["-xOzf", tarball, "package/package.json"]).stdout,
  );
  assert.equal(manifest.name, "zine-mcp");
  assert.equal(manifest.version, "0.1.0");
  assert.equal(manifest.private, true, "registry publication must remain disabled");
  assert.deepEqual(manifest.files, ["dist/server.js", "README.md"]);
  assert.deepEqual(manifest.bin, { "zine-mcp": "dist/server.js" });
  assert.equal(
    manifest.dependencies,
    undefined,
    "the bundled CLI must have no runtime dependencies",
  );
  assertNoLocalDependencies(manifest);

  const packedSource = run(
    "tar",
    ["-xOzf", tarball, "package/dist/server.js"],
  ).stdout;
  assert.ok(
    packedSource.startsWith("#!/usr/bin/env node\n"),
    "packed CLI must retain its Node shebang",
  );
  assert.doesNotMatch(
    packedSource,
    /@zine\/protocol|\.\.[/\\]\.\.[/\\](?:apps|packages)[/\\]/,
    "packed CLI must not retain a monorepo module reference",
  );

  const projectDir = join(tempRoot, "install", "project");
  const homeDir = join(tempRoot, "home");
  const cacheDir = join(tempRoot, "npm-cache");
  const arbitraryCwd = join(tempRoot, "arbitrary", "working", "directory");
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(homeDir);
  mkdirSync(cacheDir);
  mkdirSync(arbitraryCwd, { recursive: true });
  const npmrc = join(tempRoot, "empty-npmrc");
  writeFileSync(npmrc, "", "utf8");
  writeFileSync(
    join(projectDir, "package.json"),
    `${JSON.stringify({ name: "zine-mcp-install-smoke", private: true }, null, 2)}\n`,
    "utf8",
  );

  const isolatedEnv = {
    ...process.env,
    HOME: homeDir,
    USERPROFILE: homeDir,
    npm_config_audit: "false",
    npm_config_cache: cacheDir,
    npm_config_fund: "false",
    npm_config_offline: "true",
    npm_config_package_lock: "false",
    npm_config_update_notifier: "false",
    npm_config_userconfig: npmrc,
  };
  runNpm(
    [
      "install",
      "--ignore-scripts",
      "--offline",
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
      tarball,
    ],
    { cwd: projectDir, env: isolatedEnv },
  );

  const installedManifest = JSON.parse(
    readFileSync(
      join(projectDir, "node_modules", "zine-mcp", "package.json"),
      "utf8",
    ),
  );
  assert.deepEqual(installedManifest.bin, { "zine-mcp": "dist/server.js" });
  assert.equal(installedManifest.dependencies, undefined);
  assertNoLocalDependencies(installedManifest);

  const binary = join(
    projectDir,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "zine-mcp.cmd" : "zine-mcp",
  );
  accessSync(binary, constants.X_OK);
  const help = run(binary, ["--help"], {
    cwd: arbitraryCwd,
    env: isolatedEnv,
    shell: process.platform === "win32",
  });
  assert.match(`${help.stdout}\n${help.stderr}`, /Usage:\s+zine-mcp/);
  assert.equal(
    existsSync(join(homeDir, ".zine")),
    false,
    "--help must not create profile state",
  );

  console.log(`packaged ${packResult.filename}`);
  console.log(`contents: ${expectedFiles.join(", ")}`);
  console.log(
    "verified offline install and zine-mcp --help from an arbitrary directory",
  );
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}

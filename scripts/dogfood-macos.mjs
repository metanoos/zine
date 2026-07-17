// Build and structurally inspect the current-machine macOS dogfood bundle.
// This command deliberately uses an ad-hoc signature, never notarizes or
// publishes, and keeps every generated artifact under ignored paths.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dependenciesCurrent, markDependenciesCurrent } from "./dependency-state.mjs";
import {
  assertExactArchitecture,
  detectUnsafeBundleContent,
  detectUnsafeBundlePath,
  isPathInside,
  macosTargetForHost,
  planDogfoodCommands,
  resolveDogfoodPaths,
  selectBundleArtifacts,
} from "./dogfood-macos-lib.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const tauriConfigPath = join(repoRoot, "apps", "client", "src-tauri", "tauri.conf.json");
const tauriConfig = JSON.parse(readFileSync(tauriConfigPath, "utf8"));

function fail(message) {
  throw new Error(message);
}

function capture(command, args, options = {}) {
  const { installHint, ...spawnOptions } = options;
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: 10_000,
    ...spawnOptions,
  });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message || result.stderr?.trim() || `exit ${result.status}`;
    fail(`${command} ${args.join(" ")} failed: ${detail}${installHint ? `\n  ${installHint}` : ""}`);
  }
  return (result.stdout || result.stderr || "").trim();
}

function versionTuple(raw) {
  const match = raw.match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  return match ? match.slice(1).map((part) => Number(part ?? 0)) : null;
}

function atLeast(actual, required) {
  for (let index = 0; index < required.length; index++) {
    if ((actual[index] ?? 0) > required[index]) return true;
    if ((actual[index] ?? 0) < required[index]) return false;
  }
  return true;
}

function checkPrerequisites(target, paths) {
  const node = versionTuple(process.version);
  if (!node || !atLeast(node, [24, 0]) || atLeast(node, [25, 0])) {
    fail(`Node ${process.version} is unsupported; install and select Node 24 LTS, then rerun npm run dogfood:macos`);
  }

  const npmVersion = capture("npm", ["--version"], {
    installHint: "Install Node 24 LTS, which includes npm: https://nodejs.org/",
  });
  const goVersion = capture("go", ["version"], {
    installHint: "Install Go >= 1.25: https://go.dev/dl/",
  });
  const go = versionTuple(goVersion);
  if (!go || !atLeast(go, [1, 25])) {
    fail(`Go ${go?.join(".") ?? goVersion} is unsupported; install Go >= 1.25 from https://go.dev/dl/`);
  }
  const cargoVersion = capture("cargo", ["--version"], {
    installHint: "Install Rust stable and Cargo: https://rustup.rs/",
  });
  const rustVersion = capture("rustc", ["--version"], {
    installHint: "Install Rust stable and Cargo: https://rustup.rs/",
  });

  const xcodeHint = "Install or select the Xcode CLI tools: xcode-select --install";
  const xcodePath = capture("xcode-select", ["-p"], { installHint: xcodeHint });
  capture("xcrun", ["--find", "clang"], { installHint: xcodeHint });
  capture("xcrun", ["--find", "codesign"], { installHint: xcodeHint });
  capture("xcrun", ["--sdk", "macosx", "--show-sdk-path"], { installHint: xcodeHint });

  const goEnvironment = capture("go", ["env", "GOOS", "GOARCH", "CGO_ENABLED"]).split(/\r?\n/);
  const [goos, goarch, cgoEnabled] = goEnvironment;
  if (goos !== "darwin" || goarch !== target.goArch || cgoEnabled !== "1") {
    fail(
      `Go target must be darwin/${target.goArch} with CGO_ENABLED=1; found ${goos}/${goarch}, CGO_ENABLED=${cgoEnabled}`,
    );
  }

  const rustHost = capture("rustc", ["-vV"]).match(/^host:\s+(.+)$/m)?.[1];
  if (rustHost !== target.rustTarget) {
    fail(`Rust host target must be ${target.rustTarget}; found ${rustHost ?? "unknown"}`);
  }

  if (!existsSync(join(paths.clientDir, "package-lock.json"))) {
    fail("client package-lock.json is missing; locked dependencies cannot be installed deterministically");
  }
  if (Object.values(tauriConfig.bundle?.resources ?? {}).some((destination) => /(^|\/)binaries\/tor(?:\.exe)?$/.test(destination))) {
    fail("the dogfood bundle must not claim the optional Tor sidecar in Tauri resources");
  }
  const worktreeStatus = capture("git", ["status", "--porcelain", "--untracked-files=all"], {
    cwd: repoRoot,
  });
  if (worktreeStatus) {
    fail("the macOS dogfood build requires a clean checkout; commit or stash tracked and untracked source changes first");
  }

  console.log(`✓ host: macOS ${target.hostArch} (${target.rustTarget})`);
  console.log(`✓ Node/npm: ${process.version} / ${npmVersion}`);
  console.log(`✓ Go: ${goVersion}; CGO enabled for darwin/${target.goArch}`);
  console.log(`✓ Rust: ${rustVersion}; ${cargoVersion}`);
  console.log(`✓ Xcode CLI tools: ${xcodePath}`);
}

function run(command, environment = process.env) {
  console.log(`\n→ ${command.label}`);
  const result = spawnSync(command.command, command.args, {
    cwd: command.cwd,
    env: environment,
    stdio: "inherit",
  });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message || `exit ${result.status}`;
    fail(`${command.label} failed (${detail})`);
  }
}

function relaySourceFiles(relayDir) {
  const files = [];
  function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else if (entry.isFile() && (entry.name.endsWith(".go") || entry.name === "go.mod" || entry.name === "go.sum")) {
        files.push(path);
      }
    }
  }
  walk(relayDir);
  return files.sort((left, right) => relative(relayDir, left).localeCompare(relative(relayDir, right)));
}

function hashRelaySources(relayDir) {
  const hash = createHash("sha256");
  const files = relaySourceFiles(relayDir);
  for (const path of files) {
    hash.update(relative(relayDir, path));
    hash.update("\0");
    hash.update(readFileSync(path));
    hash.update("\0");
  }
  return { sha256: hash.digest("hex"), files: files.map((path) => relative(relayDir, path)) };
}

function hashFile(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function ensureClientDependencies(paths, installCommand) {
  const tauriCli = join(paths.clientDir, "node_modules", ".bin", "tauri");
  if (dependenciesCurrent(paths.clientDir) && existsSync(tauriCli)) {
    console.log("✓ client dependencies: installed from the current lockfile");
    return;
  }
  run(installCommand);
  markDependenciesCurrent(paths.clientDir);
  if (!existsSync(tauriCli)) {
    fail("npm ci completed but @tauri-apps/cli is unavailable; check apps/client/package-lock.json");
  }
  console.log("✓ client dependencies: installed from package-lock.json");
}

function binaryArchitecture(path, expected, label) {
  const description = capture("file", ["-b", path]);
  assertExactArchitecture(description, expected, label);
  return description;
}

function sensitiveEnvironmentValues() {
  return Object.entries(process.env)
    .filter(([name, value]) => value && /(?:API[_-]?KEY|PASSWORD|PRIVATE[_-]?KEY|SECRET|TOKEN)$/i.test(name))
    .map(([name, value]) => ({ name, value }));
}

function walkBundle(root) {
  const entries = [];
  function walk(path) {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const candidate = join(path, entry.name);
      entries.push(candidate);
      if (entry.isDirectory()) walk(candidate);
    }
  }
  walk(root);
  return entries;
}

function inspectUnsafeContent(appPath) {
  const findings = [];
  const secretValues = sensitiveEnvironmentValues();
  for (const path of walkBundle(appPath)) {
    const relativePath = relative(appPath, path);
    const pathFinding = detectUnsafeBundlePath(relativePath);
    if (pathFinding) findings.push(`${relativePath}: ${pathFinding}`);

    const metadata = lstatSync(path);
    if (metadata.isSymbolicLink()) {
      const target = resolve(dirname(path), readlinkSync(path));
      if (!isPathInside(appPath, target)) findings.push(`${relativePath}: symlink escapes app bundle`);
      continue;
    }
    if (!metadata.isFile()) continue;
    const contentFinding = detectUnsafeBundleContent(readFileSync(path), {
      secretValues,
    });
    if (contentFinding) findings.push(`${relativePath}: ${contentFinding}`);
  }
  if (findings.length > 0) {
    fail(`unsafe content found in ${appPath}:\n  ${findings.join("\n  ")}`);
  }
}

function readInfoPlist(appPath) {
  const plistPath = join(appPath, "Contents", "Info.plist");
  if (!existsSync(plistPath)) fail(`missing Info.plist: ${plistPath}`);
  return JSON.parse(capture("plutil", ["-convert", "json", "-o", "-", plistPath]));
}

function probeRelay(relayPath) {
  const probe = spawnSync(relayPath, ["-h"], {
    encoding: "utf8",
    timeout: 3_000,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
  });
  if (probe.error || probe.status !== 0) {
    fail(`embedded relay help probe failed: ${probe.error?.message || probe.stderr?.trim() || `exit ${probe.status}`}`);
  }
  const output = `${probe.stdout ?? ""}\n${probe.stderr ?? ""}`;
  if (!/Usage of .*zine-relay/.test(output) || !/-host\s/.test(output) || !/-port\s/.test(output)) {
    fail("embedded relay help probe did not return the bounded flag usage output");
  }
}

function inspectSignature(appPath) {
  capture("codesign", ["--verify", "--deep", "--strict", appPath]);
  const details = capture("codesign", ["-dv", "--verbose=4", appPath]);
  if (!/^Signature=adhoc$/m.test(details) || /^Authority=/m.test(details)) {
    fail(`expected an ad-hoc signature with no certificate authority: ${details}`);
  }
  return "ad-hoc (no signing certificate)";
}

function inspectApp(appPath, context) {
  if (!existsSync(appPath) || !statSync(appPath).isDirectory()) fail(`app bundle is missing: ${appPath}`);
  const plist = readInfoPlist(appPath);
  if (plist.CFBundleIdentifier !== tauriConfig.identifier) {
    fail(`bundle identifier mismatch: expected ${tauriConfig.identifier}, found ${plist.CFBundleIdentifier}`);
  }
  if (plist.CFBundleShortVersionString !== tauriConfig.version) {
    fail(`bundle version mismatch: expected ${tauriConfig.version}, found ${plist.CFBundleShortVersionString}`);
  }
  if (plist.CFBundlePackageType !== "APPL") {
    fail(`unexpected CFBundlePackageType: ${plist.CFBundlePackageType}`);
  }

  const executableName = plist.CFBundleExecutable;
  const appExecutable = join(appPath, "Contents", "MacOS", executableName);
  if (!existsSync(appExecutable) || (statSync(appExecutable).mode & 0o111) === 0) {
    fail(`main app executable is missing or not executable: ${appExecutable}`);
  }
  const appArchitecture = binaryArchitecture(appExecutable, context.target.hostArch === "arm64" ? "arm64" : "x86_64", "app executable");

  const relayPath = join(appPath, context.paths.relayResource.appRelativePath);
  if (!existsSync(relayPath) || !statSync(relayPath).isFile()) fail(`embedded relay is missing: ${relayPath}`);
  if ((statSync(relayPath).mode & 0o111) === 0) fail(`embedded relay is not executable: ${relayPath}`);
  const relayHash = hashFile(relayPath);
  if (relayHash !== context.provenance.binarySha256) {
    fail(`embedded relay hash does not match the freshly built resource: ${relayHash}`);
  }
  const relayArchitecture = binaryArchitecture(relayPath, context.target.goArch === "arm64" ? "arm64" : "x86_64", "embedded relay");
  probeRelay(relayPath);
  inspectUnsafeContent(appPath);
  const signature = inspectSignature(appPath);

  return {
    path: appPath,
    identifier: plist.CFBundleIdentifier,
    version: plist.CFBundleShortVersionString,
    executable: relative(appPath, appExecutable),
    appArchitecture,
    relay: relative(appPath, relayPath),
    relaySha256: relayHash,
    relayArchitecture,
    relayProbe: "bounded -h probe passed without entering listener startup",
    tor: "not bundled; optional onion reachability is not claimed",
    unsafeContent: "none detected",
    signature,
    structuralCodeSignVerification: "passed",
  };
}

function bundleCandidates(paths) {
  const entries = [];
  if (existsSync(paths.macosDir)) {
    for (const name of readdirSync(paths.macosDir)) {
      if (name.toLowerCase().endsWith(".app")) entries.push(join(paths.macosDir, name));
    }
  }
  if (existsSync(paths.dmgDir)) {
    for (const name of readdirSync(paths.dmgDir)) {
      if (name.toLowerCase().endsWith(".dmg")) entries.push(join(paths.dmgDir, name));
    }
  }
  return entries;
}

function inspectDmg(dmgPath, context) {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "zine-dogfood-inspect-"));
  const mountPoint = join(temporaryRoot, "mount");
  mkdirSync(mountPoint);
  let mounted = false;
  try {
    capture("hdiutil", ["attach", "-readonly", "-nobrowse", "-mountpoint", mountPoint, dmgPath], { timeout: 30_000 });
    mounted = true;
    const apps = readdirSync(mountPoint)
      .filter((name) => name.endsWith(".app"))
      .map((name) => join(mountPoint, name));
    if (apps.length !== 1 || basename(apps[0]) !== `${tauriConfig.productName}.app`) {
      fail(`DMG must contain exactly ${tauriConfig.productName}.app; found ${apps.map(basename).join(", ") || "none"}`);
    }
    const inspection = inspectApp(apps[0], context);
    return { ...inspection, path: `${dmgPath}::/${basename(apps[0])}` };
  } finally {
    if (mounted) {
      const detach = spawnSync("hdiutil", ["detach", mountPoint], { encoding: "utf8", timeout: 30_000 });
      if (detach.status !== 0) console.warn(`! could not detach temporary DMG mount ${mountPoint}: ${detach.stderr?.trim()}`);
    }
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function sanitizedBuildEnvironment(paths) {
  const environment = { ...process.env, APPLE_SIGNING_IDENTITY: "-", CARGO_TARGET_DIR: paths.cargoTargetDir };
  for (const name of [
    "APPLE_API_ISSUER",
    "APPLE_API_KEY",
    "APPLE_API_KEY_PATH",
    "APPLE_CERTIFICATE",
    "APPLE_CERTIFICATE_PASSWORD",
    "APPLE_DEVELOPMENT_TEAM",
    "APPLE_ID",
    "APPLE_PASSWORD",
    "APPLE_PROVIDER_SHORT_NAME",
    "APPLE_TEAM_ID",
  ]) {
    delete environment[name];
  }
  return environment;
}

async function main() {
  const target = macosTargetForHost(process.platform, process.arch);
  const paths = resolveDogfoodPaths(repoRoot, tauriConfig, target);
  checkPrerequisites(target, paths);

  const needsDependencies = !(dependenciesCurrent(paths.clientDir) && existsSync(join(paths.clientDir, "node_modules", ".bin", "tauri")));
  const commands = planDogfoodCommands(paths, target, { installDependencies: needsDependencies });
  if (needsDependencies) ensureClientDependencies(paths, commands.shift());

  mkdirSync(dirname(paths.relayResource.source), { recursive: true });
  mkdirSync(paths.cargoTargetDir, { recursive: true });
  const sourceBefore = hashRelaySources(paths.relayDir);
  const relayCommand = commands.shift();
  run(relayCommand);
  chmodSync(paths.relayResource.source, statSync(paths.relayResource.source).mode | 0o111);
  const sourceAfter = hashRelaySources(paths.relayDir);
  if (sourceBefore.sha256 !== sourceAfter.sha256) {
    fail("relay Go sources changed during the build; rerun to avoid a stale resource");
  }

  const relayArchitecture = binaryArchitecture(
    paths.relayResource.source,
    target.goArch === "arm64" ? "arm64" : "x86_64",
    "fresh relay resource",
  );
  const provenance = {
    schemaVersion: 1,
    gitHead: capture("git", ["rev-parse", "HEAD"], { cwd: repoRoot }),
    host: { platform: process.platform, architecture: process.arch, rustTarget: target.rustTarget },
    relaySourcesSha256: sourceAfter.sha256,
    relaySourceFiles: sourceAfter.files,
    binarySha256: hashFile(paths.relayResource.source),
    binaryArchitecture: relayArchitecture,
    resourcePath: relative(repoRoot, paths.relayResource.source),
    build: { command: relayCommand.command, args: relayCommand.args, cwd: relative(repoRoot, relayCommand.cwd) },
  };
  writeFileSync(paths.provenancePath, `${JSON.stringify(provenance, null, 2)}\n`);
  const persisted = JSON.parse(readFileSync(paths.provenancePath, "utf8"));
  if (persisted.relaySourcesSha256 !== hashRelaySources(paths.relayDir).sha256 || persisted.binarySha256 !== hashFile(paths.relayResource.source)) {
    fail("relay provenance no longer matches the source/resource bytes before Tauri bundling");
  }
  console.log(`✓ relay provenance: ${relative(repoRoot, paths.provenancePath)}`);

  const tauriCommand = commands.shift();
  run(tauriCommand, sanitizedBuildEnvironment(paths));

  const artifacts = selectBundleArtifacts(bundleCandidates(paths), {
    appPath: paths.appDir,
    productName: tauriConfig.productName,
    version: tauriConfig.version,
    goArch: target.goArch,
  });
  const context = { target, paths, provenance };
  const appInspection = inspectApp(artifacts.app, context);
  const dmgInspection = artifacts.dmg ? inspectDmg(artifacts.dmg, context) : null;

  const report = {
    schemaVersion: 1,
    status: "passed",
    expected: { productName: tauriConfig.productName, identifier: tauriConfig.identifier, version: tauriConfig.version },
    provenance,
    artifacts,
    appInspection,
    dmgInspection,
    limitations: [
      "current-machine architecture only",
      "ad-hoc signed without an Apple signing certificate",
      "not notarized and not suitable for public distribution",
      "Tor is not bundled; inbound onion reachability is unavailable",
      "Windows and Linux bundles are not built or verified",
    ],
  };
  writeFileSync(paths.reportPath, `${JSON.stringify(report, null, 2)}\n`);

  console.log("\n✓ macOS dogfood bundle built and structurally verified");
  console.log(`  app: ${artifacts.app}`);
  if (artifacts.dmg) console.log(`  dmg: ${artifacts.dmg}`);
  console.log(`  report: ${paths.reportPath}`);
}

main().catch((error) => {
  console.error(`\n✗ macOS dogfood bundle failed: ${error.message}`);
  process.exit(1);
});

import { basename, extname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";

const MACOS_TARGETS = new Map([
  ["arm64", { goArch: "arm64", rustTarget: "aarch64-apple-darwin" }],
  ["x64", { goArch: "amd64", rustTarget: "x86_64-apple-darwin" }],
]);

const MACH_O_ARCHITECTURES = ["arm64e", "arm64", "x86_64", "i386"];
const SECRET_FILENAMES = new Set([
  ".env",
  "credentials.json",
  "operator.json",
  "peers.json",
  "profile.json",
  "profiles.json",
  "zine-secrets.hold",
  "zine-secrets.salt",
]);
const LOCAL_STATE_EXTENSIONS = new Set([".db", ".sqlite", ".sqlite3"]);
const PRIVATE_KEY_EXTENSIONS = new Set([".key", ".mobileprovision", ".p12", ".pem", ".pfx"]);
const DEVELOPMENT_SEGMENTS = new Set([
  ".claude",
  ".codex",
  ".git",
  ".tracer",
  ".zine",
  "node_modules",
  "src-tauri",
]);

export function macosTargetForHost(platform, architecture) {
  if (platform !== "darwin") {
    throw new Error(`macOS dogfood bundles require a macOS host (found ${platform})`);
  }
  const target = MACOS_TARGETS.get(architecture);
  if (!target) {
    throw new Error(`unsupported macOS host architecture: ${architecture}`);
  }
  return { hostArch: architecture, ...target };
}

function normalizedResourceDestination(destination) {
  return normalize(destination).split(sep).join("/").replace(/^\.\//, "");
}

export function resolveRelayResource(tauriConfig, tauriDir) {
  const resources = tauriConfig?.bundle?.resources;
  if (!resources || Array.isArray(resources) || typeof resources !== "object") {
    throw new Error("tauri.conf.json must map the zine-relay bundle resource to binaries/zine-relay");
  }

  const matches = Object.entries(resources).filter(
    ([, destination]) => normalizedResourceDestination(destination) === "binaries/zine-relay",
  );
  if (matches.length !== 1) {
    throw new Error(
      `expected exactly one Tauri resource mapped to binaries/zine-relay (found ${matches.length})`,
    );
  }

  const [source, destination] = matches[0];
  return {
    source: resolve(tauriDir, source),
    destination: normalizedResourceDestination(destination),
    appRelativePath: join("Contents", "Resources", normalizedResourceDestination(destination)),
  };
}

export function resolveDogfoodPaths(repoRoot, tauriConfig, target) {
  const clientDir = join(repoRoot, "apps", "client");
  const tauriDir = join(clientDir, "src-tauri");
  const cargoTargetDir = join(tauriDir, "target", "dogfood");
  const releaseDir = join(cargoTargetDir, target.rustTarget, "release");
  const relayResource = resolveRelayResource(tauriConfig, tauriDir);

  return {
    repoRoot,
    relayDir: join(repoRoot, "relay"),
    clientDir,
    tauriDir,
    tauriConfigPath: join(tauriDir, "tauri.conf.json"),
    cargoTargetDir,
    reportPath: join(cargoTargetDir, "report.json"),
    provenancePath: join(cargoTargetDir, "relay-provenance.json"),
    bundleDir: join(releaseDir, "bundle"),
    macosDir: join(releaseDir, "bundle", "macos"),
    appDir: join(releaseDir, "bundle", "macos", `${tauriConfig.productName}.app`),
    dmgDir: join(releaseDir, "bundle", "dmg"),
    relayResource,
  };
}

export function planDogfoodCommands(paths, target, { installDependencies = false } = {}) {
  const commands = [];
  if (installDependencies) {
    commands.push({
      label: "install locked client dependencies",
      command: "npm",
      args: ["ci"],
      cwd: paths.clientDir,
    });
  }
  commands.push(
    {
      label: "build relay resource",
      command: "go",
      args: ["build", "-trimpath", "-buildvcs=true", "-o", paths.relayResource.source, "."],
      cwd: paths.relayDir,
    },
    {
      label: "build macOS app and DMG",
      command: "npm",
      args: [
        "run",
        "tauri",
        "--",
        "build",
        "--target",
        target.rustTarget,
        "--bundles",
        "app,dmg",
        "--config",
        JSON.stringify({ bundle: { macOS: { signingIdentity: "-" } } }),
      ],
      cwd: paths.clientDir,
    },
  );
  return commands;
}

export function parseMachOArchitectures(output) {
  const architectures = [];
  for (const architecture of MACH_O_ARCHITECTURES) {
    const escaped = architecture.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`(^|[^A-Za-z0-9_])${escaped}(?=$|[^A-Za-z0-9_])`);
    if (pattern.test(output)) architectures.push(architecture);
  }
  return architectures;
}

export function assertExactArchitecture(output, expectedArchitecture, label) {
  const architectures = parseMachOArchitectures(output);
  if (architectures.length !== 1 || architectures[0] !== expectedArchitecture) {
    throw new Error(
      `${label} architecture mismatch: expected ${expectedArchitecture}, found ${architectures.join(", ") || "unknown"} (${output.trim()})`,
    );
  }
  return architectures[0];
}

export function selectBundleArtifacts(entries, { appPath, productName, version, goArch }) {
  const apps = entries.filter((entry) => extname(entry).toLowerCase() === ".app");
  if (apps.length !== 1 || resolve(apps[0]) !== resolve(appPath)) {
    throw new Error(`expected exactly ${appPath}; found ${apps.length ? apps.join(", ") : "no .app"}`);
  }

  const dmgs = entries.filter((entry) => extname(entry).toLowerCase() === ".dmg");
  const productToken = productName.toLowerCase().replace(/[^a-z0-9]+/g, "_");
  const architectureTokens = goArch === "arm64" ? ["aarch64", "arm64"] : ["x86_64", "x64", "amd64"];
  const matchingDmgs = dmgs.filter((entry) => {
    const name = basename(entry).toLowerCase().replace(/[^a-z0-9.]+/g, "_");
    return name.includes(productToken) && name.includes(version.toLowerCase()) && architectureTokens.some((token) => name.includes(token));
  });
  if (dmgs.length > 0 && matchingDmgs.length !== 1) {
    throw new Error(
      `could not select one ${productName} ${version} ${goArch} DMG from: ${dmgs.join(", ")}`,
    );
  }

  return { app: apps[0], dmg: matchingDmgs[0] ?? null };
}

export function detectUnsafeBundlePath(relativePath) {
  const normalized = relativePath.split("\\").join("/");
  const segments = normalized.split("/").filter(Boolean);
  const lowerSegments = segments.map((segment) => segment.toLowerCase());
  const filename = lowerSegments.at(-1) ?? "";
  const extension = extname(filename);

  const developmentSegment = lowerSegments.find((segment) => DEVELOPMENT_SEGMENTS.has(segment));
  if (developmentSegment) return `development-only path segment: ${developmentSegment}`;
  if (filename === "tor" || filename === "tor.exe") return "unexpected Tor binary";
  if (filename === ".env" || filename.startsWith(".env.")) return "environment file";
  if (SECRET_FILENAMES.has(filename)) return `secret or local profile file: ${filename}`;
  if (LOCAL_STATE_EXTENSIONS.has(extension)) return `SQLite/local state file: ${filename}`;
  if (PRIVATE_KEY_EXTENSIONS.has(extension)) return `private credential file: ${filename}`;
  if (extension === ".map") return `source map: ${filename}`;
  return null;
}

export function detectUnsafeBundleContent(content, { secretValues = [] } = {}) {
  if (content.includes(Buffer.from("sourceMappingURL="))) {
    return "embedded source-map reference";
  }
  for (const { name, value } of secretValues) {
    if (value.length >= 8 && content.includes(Buffer.from(value))) {
      return `embedded value from sensitive environment variable ${name}`;
    }
  }
  return null;
}

export function isPathInside(parent, candidate) {
  const difference = relative(resolve(parent), resolve(candidate));
  return difference === "" || (!isAbsolute(difference) && difference !== ".." && !difference.startsWith(`..${sep}`));
}

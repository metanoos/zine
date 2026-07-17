import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  assertExactArchitecture,
  detectUnsafeBundleContent,
  detectUnsafeBundlePath,
  isPathInside,
  macosTargetForHost,
  parseMachOArchitectures,
  planDogfoodCommands,
  resolveDogfoodPaths,
  resolveRelayResource,
  selectBundleArtifacts,
} from "./dogfood-macos-lib.mjs";

const CONFIG = {
  productName: "client",
  version: "0.1.0",
  identifier: "com.peterwei.client",
  bundle: { resources: { "binaries/zine-relay": "binaries/zine-relay" } },
};

test("host targets resolve only supported current-machine macOS architectures", () => {
  assert.deepEqual(macosTargetForHost("darwin", "arm64"), {
    hostArch: "arm64",
    goArch: "arm64",
    rustTarget: "aarch64-apple-darwin",
  });
  assert.deepEqual(macosTargetForHost("darwin", "x64"), {
    hostArch: "x64",
    goArch: "amd64",
    rustTarget: "x86_64-apple-darwin",
  });
  assert.throws(() => macosTargetForHost("linux", "x64"), /macOS host/);
  assert.throws(() => macosTargetForHost("darwin", "ia32"), /unsupported/);
});

test("relay resource resolves to the exact Tauri source and installed app paths", () => {
  const tauriDir = join("/repo", "apps", "client", "src-tauri");
  assert.deepEqual(resolveRelayResource(CONFIG, tauriDir), {
    source: join(tauriDir, "binaries", "zine-relay"),
    destination: "binaries/zine-relay",
    appRelativePath: join("Contents", "Resources", "binaries", "zine-relay"),
  });
  assert.throws(
    () => resolveRelayResource({ bundle: { resources: [] } }, tauriDir),
    /must map the zine-relay/,
  );
  assert.throws(
    () => resolveRelayResource({ bundle: { resources: { relay: "somewhere-else" } } }, tauriDir),
    /exactly one/,
  );
});

test("checked-in Tauri resources include only the generated relay sidecar", () => {
  const actualConfig = JSON.parse(
    readFileSync(new URL("../apps/client/src-tauri/tauri.conf.json", import.meta.url), "utf8"),
  );
  assert.deepEqual(actualConfig.bundle.resources, {
    "binaries/zine-relay": "binaries/zine-relay",
  });
});

test("command plan builds the relay directly into the resource before Tauri", () => {
  const target = macosTargetForHost("darwin", "arm64");
  const paths = resolveDogfoodPaths("/repo", CONFIG, target);
  const commands = planDogfoodCommands(paths, target, { installDependencies: true });

  assert.deepEqual(commands.map((command) => command.label), [
    "install locked client dependencies",
    "build relay resource",
    "build macOS app and DMG",
  ]);
  assert.deepEqual(commands[1].args, [
    "build",
    "-trimpath",
    "-buildvcs=true",
    "-o",
    join("/repo", "apps", "client", "src-tauri", "binaries", "zine-relay"),
    ".",
  ]);
  assert.deepEqual(commands[2].args.slice(0, 9), [
    "run",
    "tauri",
    "--",
    "build",
    "--target",
    "aarch64-apple-darwin",
    "--bundles",
    "app,dmg",
    "--config",
  ]);
  assert.match(commands[2].args[9], /"signingIdentity":"-"/);
});

test("Mach-O architecture parsing rejects wrong and universal relay binaries", () => {
  assert.deepEqual(parseMachOArchitectures("Mach-O 64-bit executable arm64"), ["arm64"]);
  assert.deepEqual(
    parseMachOArchitectures("Mach-O universal binary with 2 architectures: [x86_64] [arm64]"),
    ["arm64", "x86_64"],
  );
  assert.equal(assertExactArchitecture("Mach-O 64-bit executable x86_64", "x86_64", "relay"), "x86_64");
  assert.throws(
    () => assertExactArchitecture("Mach-O 64-bit executable x86_64", "arm64", "relay"),
    /architecture mismatch/,
  );
  assert.throws(
    () => assertExactArchitecture("Mach-O universal binary arm64 x86_64", "arm64", "relay"),
    /architecture mismatch/,
  );
});

test("artifact selection requires the exact app and matching current-arch DMG", () => {
  const app = "/target/bundle/macos/client.app";
  const dmg = "/target/bundle/dmg/client_0.1.0_aarch64.dmg";
  assert.deepEqual(
    selectBundleArtifacts([app, dmg], {
      appPath: app,
      productName: "client",
      version: "0.1.0",
      goArch: "arm64",
    }),
    { app, dmg },
  );
  assert.throws(
    () => selectBundleArtifacts(["/target/bundle/macos/other.app"], {
      appPath: app,
      productName: "client",
      version: "0.1.0",
      goArch: "arm64",
    }),
    /expected exactly/,
  );
  assert.throws(
    () => selectBundleArtifacts([app, "/target/client_0.0.9_x64.dmg"], {
      appPath: app,
      productName: "client",
      version: "0.1.0",
      goArch: "arm64",
    }),
    /could not select/,
  );
});

test("unsafe bundle detection covers state, profiles, secrets, Tor, dependencies, maps, and dev paths", () => {
  const unsafePaths = [
    "Contents/Resources/node_modules/pkg/index.js",
    "Contents/Resources/profiles.json",
    "Contents/Resources/relay.sqlite3",
    "Contents/Resources/assets/app.js.map",
    "Contents/Resources/binaries/tor",
    "Contents/Resources/.env.production",
    "Contents/Resources/certificate.pem",
    "Contents/Resources/src-tauri/tauri.conf.json",
  ];
  for (const path of unsafePaths) assert.ok(detectUnsafeBundlePath(path), path);
  assert.equal(detectUnsafeBundlePath("Contents/Resources/binaries/zine-relay"), null);
  assert.equal(detectUnsafeBundlePath("Contents/MacOS/client"), null);

  assert.equal(
    detectUnsafeBundleContent(Buffer.from("//# sourceMappingURL=app.js.map")),
    "embedded source-map reference",
  );
  assert.equal(
    detectUnsafeBundleContent(Buffer.from("token-value-123"), {
      secretValues: [{ name: "PROVIDER_TOKEN", value: "token-value-123" }],
    }),
    "embedded value from sensitive environment variable PROVIDER_TOKEN",
  );
  assert.equal(detectUnsafeBundleContent(Buffer.from("ordinary production asset")), null);
});

test("bundle symlink boundary accepts internal targets and rejects prefix escapes", () => {
  assert.equal(isPathInside("/tmp/client.app", "/tmp/client.app/Contents/Resources/icon.icns"), true);
  assert.equal(isPathInside("/tmp/client.app", "/tmp/client.app-escaped/secret"), false);
  assert.equal(isPathInside("/tmp/client.app", "/Applications"), false);
});

// Start isolated ACL-protected relays with temporary SQLite databases, run the
// protocol smoke through the shared client/MCP provenance implementation, and
// tear everything down. No developer data or default ports are touched.

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildRelay } from "./build-relay.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const mcpDir = join(repoRoot, "apps", "mcp");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const tempRoot = mkdtempSync(join(tmpdir(), "zine-relay-smoke-"));
const relays = [];

function externalHost() {
  if (process.env.ZINE_TEST_EXTERNAL_HOST) return process.env.ZINE_TEST_EXTERNAL_HOST;
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal) return address.address;
    }
  }
  return null;
}

function freePort(host) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close((error) => {
        if (error) reject(error);
        else if (port === null) reject(new Error(`could not allocate a port on ${host}`));
        else resolve(port);
      });
    });
  });
}

function waitForPort(host, port, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = createConnection({ host, port });
      let finished = false;
      socket.setTimeout(500);
      socket.once("connect", () => {
        if (finished) return;
        finished = true;
        socket.destroy();
        resolve();
      });
      const retry = () => {
        if (finished) return;
        finished = true;
        socket.destroy();
        if (Date.now() >= deadline) reject(new Error(`relay did not listen on ${host}:${port}`));
        else setTimeout(attempt, 100);
      };
      socket.once("error", retry);
      socket.once("timeout", retry);
    };
    attempt();
  });
}

function spawnRelay(binary, label, host, port, dbPath) {
  const child = spawn(binary, ["--host", host, "--port", String(port), "--db", dbPath], {
    cwd: join(repoRoot, "relay"),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  const capture = (chunk) => {
    log = (log + chunk.toString()).slice(-16_000);
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  relays.push({ child, label, getLog: () => log });
  return child;
}

function runSmoke(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(npm, ["run", "test:relay"], {
      cwd: mcpDir,
      env: { ...process.env, ...env },
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`relay smoke exited ${code ?? signal ?? "unknown"}`));
    });
  });
}

async function stopRelays() {
  await Promise.all(relays.map(({ child }) => new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode) return resolve();
    const timer = setTimeout(() => child.kill("SIGKILL"), 2_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill("SIGTERM");
  })));
}

try {
  const requireFromMcp = createRequire(join(mcpDir, "package.json"));
  const { generateSecretKey, getPublicKey } = requireFromMcp("nostr-tools/pure");
  const ownerSecret = generateSecretKey();
  const ownerSecretHex = Buffer.from(ownerSecret).toString("hex");
  const ownerPubkey = getPublicKey(ownerSecret);
  const configPath = join(tempRoot, "mcp.json");
  writeFileSync(configPath, JSON.stringify({ "zine.voice.secretHex": ownerSecretHex }, null, 2), { mode: 0o600 });

  const binary = buildRelay();
  const homeHost = "127.0.0.1";
  const publicHost = externalHost();
  if (!publicHost && process.env.CI) {
    throw new Error("CI relay smoke requires a non-loopback IPv4 interface for Send/Attest verification");
  }
  const homePort = await freePort(homeHost);
  const publicPort = publicHost ? await freePort(publicHost) : null;

  const homeDir = join(tempRoot, "home");
  mkdirSync(homeDir, { recursive: true });
  writeFileSync(join(homeDir, "peers.json"), JSON.stringify({ owner: ownerPubkey, peers: [], writers: [] }), { mode: 0o600 });
  spawnRelay(binary, "home", homeHost, homePort, join(homeDir, "relay.sqlite3"));
  await waitForPort(homeHost, homePort);

  let externalUrl = "";
  if (publicHost && publicPort) {
    const publicDir = join(tempRoot, "external");
    mkdirSync(publicDir, { recursive: true });
    writeFileSync(join(publicDir, "peers.json"), JSON.stringify({ owner: ownerPubkey, peers: [], writers: [] }), { mode: 0o600 });
    spawnRelay(binary, "external", publicHost, publicPort, join(publicDir, "relay.sqlite3"));
    await waitForPort(publicHost, publicPort);
    externalUrl = `ws://${publicHost}:${publicPort}`;
  } else {
    console.warn("! no non-loopback IPv4 interface; Send/Attest external-relay assertions will be skipped");
  }

  await runSmoke({
    ZINE_TEST_HOME_RELAY_URL: `ws://${homeHost}:${homePort}`,
    ZINE_TEST_EXTERNAL_RELAY_URL: externalUrl,
    ZINE_TEST_CONFIG_PATH: configPath,
    ZINE_TEST_OWNER_PUBKEY: ownerPubkey,
  });
} catch (error) {
  for (const relay of relays) {
    const log = relay.getLog().trim();
    if (log) console.error(`\n--- ${relay.label} relay log ---\n${log}`);
  }
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
} finally {
  await stopRelays();
  rmSync(tempRoot, { recursive: true, force: true });
}

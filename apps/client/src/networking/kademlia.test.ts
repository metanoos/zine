import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";

import {
  activateVaultStorage,
  deactivateVaultStorage,
  fenceVaultStorageSession,
} from "../storage/vault-storage.js";

import {
  DEFAULT_KADEMLIA_LISTEN,
  applyKademliaConfig,
  ensureKademliaStarted,
  kademliaStatus,
  loadKademliaConfig,
  lookupRendezvousPointers,
  normalizeKademliaConfig,
  publishRendezvousPointer,
  restartKademlia,
  saveKademliaConfig,
  stopKademlia,
  subscribeKademliaConfig,
  type KademliaConfig,
  type KademliaStatus,
} from "./kademlia.js";

const STORAGE_KEY = "zine.kademlia.v1";
const networkingSource = readFileSync(new URL("./Networking.tsx", import.meta.url), "utf8");
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");

function restoreGlobal(name: "window" | "localStorage", descriptor?: PropertyDescriptor) {
  if (descriptor) {
    Object.defineProperty(globalThis, name, descriptor);
  } else {
    Reflect.deleteProperty(globalThis, name);
  }
}

function installTauriMock(
  handler: Parameters<typeof mockIPC>[0],
) {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {},
    writable: true,
  });
  mockIPC(handler);
}

function installLocalStorage(storage: object) {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: storage,
    writable: true,
  });
}

class FakeStorage implements Storage {
  private values = new Map<string, string>();

  get length(): number { return this.values.size; }
  clear(): void { this.values.clear(); }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string): void { this.values.delete(key); }
  setItem(key: string, value: string): void { this.values.set(key, String(value)); }
}

function memoryStorage(
  initial: Record<string, string> = {},
  onSet?: (key: string, value: string) => void,
) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      values.set(key, value);
      onSet?.(key, value);
    },
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function within<T>(promise: Promise<T>, ms = 250): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`operation did not start within ${ms}ms`)), ms);
    }),
  ]);
}

afterEach(() => {
  if (typeof window !== "undefined") clearMocks();
  restoreGlobal("window", originalWindow);
  restoreGlobal("localStorage", originalLocalStorage);
});

const RUNNING_STATUS: KademliaStatus = {
  running: true,
  peerId: "12D3KooWdesktop",
  listeners: ["/ip4/127.0.0.1/tcp/41000"],
  connectedPeers: 3,
  routingPeers: 2,
  storedCoordinates: 7,
  lastError: null,
};

const STOPPED_STATUS: KademliaStatus = {
  running: false,
  peerId: "",
  listeners: [],
  connectedPeers: 0,
  routingPeers: 0,
  storedCoordinates: 0,
  lastError: null,
};

const ENABLED_CONFIG: KademliaConfig = {
  enabled: true,
  listenAddress: "/ip4/127.0.0.1/tcp/4001",
  bootstrapPeers: [
    "/dns4/seed.example/tcp/4001/p2p/12D3KooWbootstrap",
  ],
};
const VAULT_KEY_A = new Uint8Array(32).fill(0x41);
const VAULT_KEY_B = new Uint8Array(32).fill(0x42);

test("Kademlia config defaults off and binds an ephemeral TCP port", () => {
  assert.deepEqual(normalizeKademliaConfig(null), {
    enabled: false,
    listenAddress: DEFAULT_KADEMLIA_LISTEN,
    bootstrapPeers: [],
  });
});

test("Kademlia config trims and deduplicates author-provided bootstrap peers", () => {
  const config = normalizeKademliaConfig({
    enabled: true,
    listenAddress: " /ip4/127.0.0.1/tcp/4001 ",
    bootstrapPeers: [" /dns4/seed.example/tcp/4001/p2p/peer ", "", "/dns4/seed.example/tcp/4001/p2p/peer"],
  });
  assert.deepEqual(config, {
    enabled: true,
    listenAddress: "/ip4/127.0.0.1/tcp/4001",
    bootstrapPeers: ["/dns4/seed.example/tcp/4001/p2p/peer"],
  });
});

test("Kademlia config persists through the storage boundary", () => {
  const storage = memoryStorage();
  const saved = saveKademliaConfig({
    enabled: true,
    listenAddress: DEFAULT_KADEMLIA_LISTEN,
    bootstrapPeers: ["/ip4/203.0.113.8/tcp/4001/p2p/peer"],
  }, storage);
  assert.deepEqual(loadKademliaConfig(storage), saved);
});

test("Coins config subscribers react to same-window commits and unsubscribe cleanly", () => {
  const storage = memoryStorage();
  installLocalStorage(storage);
  const snapshots: boolean[] = [];
  const unsubscribe = subscribeKademliaConfig(() => {
    snapshots.push(loadKademliaConfig().enabled);
  });

  saveKademliaConfig(ENABLED_CONFIG);
  unsubscribe();
  saveKademliaConfig({ ...ENABLED_CONFIG, enabled: false });

  assert.deepEqual(snapshots, [true]);
});

test("Coins is the sole user-facing opt-in and rendezvous addresses stay advanced", () => {
  const section = networkingSource.match(
    /function CoinsSection\(\)[\s\S]*?(?=\/\*\* Following answers)/,
  )?.[0];
  assert.ok(section);
  assert.equal((section.match(/type="checkbox"/g) ?? []).length, 1);
  assert.match(section, /useEffect\(\(\) => subscribeKademliaConfig/);
  assert.match(section, /<span>Enable Coins<\/span>/);
  assert.doesNotMatch(section, /Enable Kademlia|Enable rendezvous/);
  assert.match(
    section,
    /<details[^>]*>[\s\S]*?Advanced rendezvous configuration[\s\S]*?Listen multiaddr[\s\S]*?Super-peer bootstrap multiaddrs[\s\S]*?<\/details>/,
  );
});

test("Kademlia IPC uses the exact native commands and camelCase boundaries", async () => {
  const calls: Array<{ command: string; payload: unknown }> = [];
  const pointers = [{
    eventId: "a".repeat(64),
    relayUrl: "wss://relay.example",
  }];
  installTauriMock((command, payload) => {
    calls.push({ command, payload });
    switch (command) {
      case "kademlia_start":
      case "kademlia_status":
        return RUNNING_STATUS;
      case "kademlia_lookup":
        return pointers;
      case "kademlia_stop":
      case "kademlia_publish_pointer":
        return undefined;
      default:
        throw new Error(`Unexpected command: ${command}`);
    }
  });
  const storage = memoryStorage();
  saveKademliaConfig(ENABLED_CONFIG, storage);
  installLocalStorage(storage);

  assert.deepEqual(await ensureKademliaStarted(), RUNNING_STATUS);
  assert.deepEqual(await kademliaStatus(), RUNNING_STATUS);
  await stopKademlia();
  await publishRendezvousPointer("coin-coordinate", pointers[0]);
  assert.deepEqual(await lookupRendezvousPointers("coin-coordinate"), pointers);

  const publishOperationId = (calls[4]?.payload as { operationId?: string }).operationId;
  const lookupOperationId = (calls[6]?.payload as { operationId?: string }).operationId;
  assert.match(publishOperationId ?? "", /^[0-9a-f-]{36}$/);
  assert.match(lookupOperationId ?? "", /^[0-9a-f-]{36}$/);
  assert.notEqual(publishOperationId, lookupOperationId);

  assert.deepEqual(calls, [
    {
      command: "kademlia_start",
      payload: { config: ENABLED_CONFIG },
    },
    { command: "kademlia_status", payload: {} },
    { command: "kademlia_stop", payload: {} },
    {
      command: "kademlia_start",
      payload: { config: ENABLED_CONFIG },
    },
    {
      command: "kademlia_publish_pointer",
      payload: {
        coordinate: "coin-coordinate",
        pointer: pointers[0],
        operationId: publishOperationId,
      },
    },
    {
      command: "kademlia_start",
      payload: { config: ENABLED_CONFIG },
    },
    {
      command: "kademlia_lookup",
      payload: { coordinate: "coin-coordinate", operationId: lookupOperationId },
    },
  ]);
});

test("disabled Kademlia skips start and lookup IPC and rejects publication", async () => {
  const commands: string[] = [];
  installTauriMock((command) => {
    commands.push(command);
    throw new Error(`Disabled configuration invoked ${command}`);
  });
  const storage = memoryStorage();
  saveKademliaConfig({ ...ENABLED_CONFIG, enabled: false }, storage);
  installLocalStorage(storage);

  assert.equal(
    await ensureKademliaStarted(),
    null,
  );
  await assert.rejects(
    publishRendezvousPointer("coin-coordinate", {
      eventId: "b".repeat(64),
      relayUrl: "wss://relay.example",
    }),
    /disabled/,
  );
  assert.deepEqual(await lookupRendezvousPointers("coin-coordinate"), []);
  assert.deepEqual(commands, []);
});

test("independent Kademlia lookups are not serialized behind one slow query", async () => {
  const storage = memoryStorage();
  saveKademliaConfig(ENABLED_CONFIG, storage);
  installLocalStorage(storage);
  const firstStarted = deferred();
  const secondStarted = deferred();
  const release = deferred();
  let lookups = 0;
  installTauriMock((command) => {
    if (command === "kademlia_start") return RUNNING_STATUS;
    if (command === "kademlia_lookup") {
      lookups++;
      (lookups === 1 ? firstStarted : secondStarted).resolve();
      return release.promise.then(() => []);
    }
    return undefined;
  });

  const first = lookupRendezvousPointers("a".repeat(64));
  await within(firstStarted.promise);
  const second = lookupRendezvousPointers("b".repeat(64));
  await within(secondStarted.promise);
  release.resolve();
  await Promise.all([first, second]);
  assert.equal(lookups, 2);
});

test("aborting a Kademlia lookup cancels the exact native operation", async () => {
  const storage = memoryStorage();
  saveKademliaConfig(ENABLED_CONFIG, storage);
  installLocalStorage(storage);
  const lookupStarted = deferred();
  const cancelled = deferred();
  let lookupOperationId = "";
  installTauriMock((command, payload) => {
    if (command === "kademlia_start") return RUNNING_STATUS;
    if (command === "kademlia_lookup") {
      lookupOperationId = (payload as { operationId?: string } | undefined)?.operationId ?? "";
      lookupStarted.resolve();
      return new Promise(() => undefined);
    }
    if (command === "kademlia_cancel") {
      assert.equal(
        (payload as { operationId?: string } | undefined)?.operationId,
        lookupOperationId,
      );
      cancelled.resolve();
      return undefined;
    }
    return undefined;
  });
  const controller = new AbortController();
  const lookup = lookupRendezvousPointers("c".repeat(64), controller.signal);
  await within(lookupStarted.promise);
  controller.abort(new Error("selection changed"));
  await assert.rejects(lookup, /selection changed/);
  await within(cancelled.promise);
  assert.ok(lookupOperationId);
});

test("a synchronous lookup abort cancels the operation id dispatched to native", async () => {
  const storage = memoryStorage();
  saveKademliaConfig(ENABLED_CONFIG, storage);
  installLocalStorage(storage);
  const controller = new AbortController();
  const cancelled = deferred();
  let lookupOperationId = "";
  installTauriMock((command, payload) => {
    if (command === "kademlia_start") return RUNNING_STATUS;
    if (command === "kademlia_lookup") {
      lookupOperationId = (payload as { operationId?: string } | undefined)?.operationId ?? "";
      controller.abort(new Error("cancelled during native dispatch"));
      return new Promise(() => undefined);
    }
    if (command === "kademlia_cancel") {
      assert.equal(
        (payload as { operationId?: string } | undefined)?.operationId,
        lookupOperationId,
      );
      cancelled.resolve();
      return undefined;
    }
    throw new Error(`Unexpected command: ${command}`);
  });

  await assert.rejects(
    lookupRendezvousPointers("e".repeat(64), controller.signal),
    /cancelled during native dispatch/,
  );
  await within(cancelled.promise);
  assert.ok(lookupOperationId);
});

test("restart stops the current runtime before starting its replacement", async () => {
  const commands: string[] = [];
  const storage = memoryStorage();
  saveKademliaConfig(ENABLED_CONFIG, storage);
  installLocalStorage(storage);
  installTauriMock((command) => {
    commands.push(command);
    return command === "kademlia_start" ? RUNNING_STATUS : undefined;
  });

  assert.deepEqual(await restartKademlia(), RUNNING_STATUS);
  assert.deepEqual(commands, ["kademlia_stop", "kademlia_start"]);
});

test("a disable commits before a queued publish can restart stale configuration", async () => {
  const trace: string[] = [];
  const storage = memoryStorage({
    [STORAGE_KEY]: JSON.stringify(ENABLED_CONFIG),
  }, (_key, value) => {
    trace.push(`storage:${JSON.parse(value).enabled}`);
  });
  installLocalStorage(storage);
  const stopGate = deferred();
  const stopStarted = deferred();
  installTauriMock((command) => {
    if (command === "kademlia_stop") {
      trace.push("stop:begin");
      stopStarted.resolve();
      return stopGate.promise.then(() => {
        trace.push("stop:end");
      });
    }
    trace.push(command);
    if (command === "kademlia_status") return STOPPED_STATUS;
    if (command === "kademlia_start") return RUNNING_STATUS;
    return undefined;
  });

  const disabling = applyKademliaConfig({ ...ENABLED_CONFIG, enabled: false }, storage);
  await stopStarted.promise;
  const publishing = publishRendezvousPointer("coin-coordinate", {
    eventId: "c".repeat(64),
    relayUrl: "wss://relay.example",
  });
  await Promise.resolve();
  assert.deepEqual(trace, ["stop:begin"], "publish must wait behind config apply");
  stopGate.resolve();

  await disabling;
  await assert.rejects(publishing, /Coins rendezvous is disabled/);
  assert.deepEqual(loadKademliaConfig(storage).enabled, false);
  assert.deepEqual(trace, [
    "stop:begin",
    "stop:end",
    "kademlia_status",
    "storage:false",
  ]);
});

test("an in-flight start finishes before disable stops it and persists Coins off", async () => {
  const trace: string[] = [];
  const storage = memoryStorage({
    [STORAGE_KEY]: JSON.stringify(ENABLED_CONFIG),
  }, (_key, value) => {
    trace.push(`storage:${JSON.parse(value).enabled}`);
  });
  installLocalStorage(storage);
  const startGate = deferred();
  const startStarted = deferred();
  installTauriMock((command) => {
    if (command === "kademlia_start") {
      trace.push("start:begin");
      startStarted.resolve();
      return startGate.promise.then(() => {
        trace.push("start:end");
        return RUNNING_STATUS;
      });
    }
    trace.push(command);
    if (command === "kademlia_status") return STOPPED_STATUS;
    return undefined;
  });

  const starting = ensureKademliaStarted();
  await startStarted.promise;
  const disabling = applyKademliaConfig({ ...ENABLED_CONFIG, enabled: false }, storage);
  await Promise.resolve();
  assert.deepEqual(trace, ["start:begin"], "disable must wait for the active start");
  startGate.resolve();

  assert.deepEqual(await starting, RUNNING_STATUS);
  const disabled = await disabling;
  assert.equal(disabled.config.enabled, false);
  assert.equal(loadKademliaConfig(storage).enabled, false);
  assert.deepEqual(trace, [
    "start:begin",
    "start:end",
    "kademlia_stop",
    "kademlia_status",
    "storage:false",
  ]);
});

test("applying a configuration starts it before committing it", async () => {
  const previous = { ...ENABLED_CONFIG, listenAddress: "/ip4/127.0.0.1/tcp/4000" };
  const candidate = {
    ...ENABLED_CONFIG,
    listenAddress: " /ip4/127.0.0.1/tcp/5000 ",
    bootstrapPeers: [ENABLED_CONFIG.bootstrapPeers[0], ENABLED_CONFIG.bootstrapPeers[0]],
  };
  const trace: string[] = [];
  const storage = memoryStorage({
    [STORAGE_KEY]: JSON.stringify(previous),
  }, () => trace.push("storage:set"));
  installTauriMock((command, payload) => {
    trace.push(`ipc:${command}`);
    if (command === "kademlia_start") {
      assert.deepEqual(payload, {
        config: {
          ...ENABLED_CONFIG,
          listenAddress: "/ip4/127.0.0.1/tcp/5000",
        },
      });
      return RUNNING_STATUS;
    }
    return undefined;
  });

  const applied = await applyKademliaConfig(candidate, storage);

  assert.deepEqual(applied, {
    config: {
      ...ENABLED_CONFIG,
      listenAddress: "/ip4/127.0.0.1/tcp/5000",
    },
    status: RUNNING_STATUS,
  });
  assert.deepEqual(trace, [
    "ipc:kademlia_stop",
    "ipc:kademlia_start",
    "storage:set",
  ]);
  assert.deepEqual(loadKademliaConfig(storage), applied.config);
});

test("a failed replacement restores the previous runtime and persisted config", async () => {
  const previous = { ...ENABLED_CONFIG, listenAddress: "/ip4/127.0.0.1/tcp/4000" };
  const candidate = { ...ENABLED_CONFIG, listenAddress: "/invalid/listen/address" };
  const trace: string[] = [];
  const storage = memoryStorage({
    [STORAGE_KEY]: JSON.stringify(previous),
  }, () => trace.push("storage:restore"));
  installTauriMock((command, payload) => {
    trace.push(`ipc:${command}`);
    if (command !== "kademlia_start") return undefined;
    const config = (payload as { config?: KademliaConfig } | undefined)?.config!;
    if (config.listenAddress === candidate.listenAddress) {
      throw new Error("invalid Kademlia listen multiaddr");
    }
    assert.deepEqual(config, previous);
    return RUNNING_STATUS;
  });

  await assert.rejects(
    applyKademliaConfig(candidate, storage),
    /invalid Kademlia listen multiaddr/,
  );

  assert.deepEqual(trace, [
    "ipc:kademlia_stop",
    "ipc:kademlia_start",
    "ipc:kademlia_stop",
    "ipc:kademlia_start",
    "storage:restore",
  ]);
  assert.deepEqual(loadKademliaConfig(storage), previous);
});

test("a persistence failure stops the candidate and restores the previous runtime", async () => {
  const previous = { ...ENABLED_CONFIG, listenAddress: "/ip4/127.0.0.1/tcp/4000" };
  const candidate = { ...ENABLED_CONFIG, listenAddress: "/ip4/127.0.0.1/tcp/5000" };
  const trace: string[] = [];
  let persisted = JSON.stringify(previous);
  const storage = {
    getItem(key: string) {
      return key === STORAGE_KEY ? persisted : null;
    },
    setItem(key: string, value: string) {
      assert.equal(key, STORAGE_KEY);
      const attempted = JSON.parse(value) as KademliaConfig;
      if (attempted.listenAddress === candidate.listenAddress) {
        trace.push("storage:reject-candidate");
        throw new Error("storage quota exceeded");
      }
      trace.push("storage:restore");
      persisted = value;
    },
  };
  installTauriMock((command, payload) => {
    trace.push(`ipc:${command}`);
    if (command === "kademlia_start") {
      const config = (payload as { config?: KademliaConfig } | undefined)?.config!;
      return config.listenAddress === candidate.listenAddress
        ? { ...RUNNING_STATUS, peerId: "candidate" }
        : RUNNING_STATUS;
    }
    return undefined;
  });

  await assert.rejects(
    applyKademliaConfig(candidate, storage),
    /storage quota exceeded/,
  );

  assert.deepEqual(trace, [
    "ipc:kademlia_stop",
    "ipc:kademlia_start",
    "storage:reject-candidate",
    "ipc:kademlia_stop",
    "ipc:kademlia_start",
    "storage:restore",
  ]);
  assert.deepEqual(loadKademliaConfig(storage), previous);
});

test("disabling stops the runtime before committing and returns mapped status", async () => {
  const trace: string[] = [];
  const storage = memoryStorage({
    [STORAGE_KEY]: JSON.stringify(ENABLED_CONFIG),
  }, () => trace.push("storage:set"));
  installTauriMock((command) => {
    trace.push(`ipc:${command}`);
    if (command === "kademlia_status") return STOPPED_STATUS;
    return undefined;
  });

  const result = await applyKademliaConfig({
    ...ENABLED_CONFIG,
    enabled: false,
  }, storage);

  assert.deepEqual(result.status, STOPPED_STATUS);
  assert.deepEqual(result.config, { ...ENABLED_CONFIG, enabled: false });
  assert.deepEqual(trace, [
    "ipc:kademlia_stop",
    "ipc:kademlia_status",
    "storage:set",
  ]);
});

test("Coins opt-in migrates into vault A and remains isolated from vault B", () => {
  const rawStorage = new FakeStorage();
  rawStorage.setItem(STORAGE_KEY, JSON.stringify(ENABLED_CONFIG));
  installLocalStorage(rawStorage);
  const snapshots: boolean[] = [];
  const unsubscribe = subscribeKademliaConfig(() => {
    snapshots.push(loadKademliaConfig().enabled);
  });

  try {
    activateVaultStorage("vault-a", VAULT_KEY_A, true);
    assert.equal(loadKademliaConfig().enabled, true);
    assert.equal(rawStorage.getItem(STORAGE_KEY), null);

    activateVaultStorage("vault-b", VAULT_KEY_B);
    assert.equal(loadKademliaConfig().enabled, false);

    activateVaultStorage("vault-a", VAULT_KEY_A);
    assert.deepEqual(loadKademliaConfig(), ENABLED_CONFIG);
    assert.deepEqual(snapshots, [true, false, true]);
  } finally {
    unsubscribe();
    deactivateVaultStorage();
  }
});

test("the pre-lock fence rejects newly submitted Kademlia work", async () => {
  const rawStorage = new FakeStorage();
  installLocalStorage(rawStorage);
  activateVaultStorage("vault-a", VAULT_KEY_A);
  saveKademliaConfig(ENABLED_CONFIG);
  const trace: string[] = [];
  installTauriMock((command) => {
    trace.push(command);
    return command === "kademlia_start" ? RUNNING_STATUS : undefined;
  });

  try {
    fenceVaultStorageSession();
    await assert.rejects(ensureKademliaStarted(), /active vault changed/);
    await assert.rejects(
      applyKademliaConfig({ ...ENABLED_CONFIG, enabled: false }),
      /active vault changed/,
    );
    assert.deepEqual(trace, []);
    assert.equal(loadKademliaConfig().enabled, true);
  } finally {
    deactivateVaultStorage();
  }
});

test("switching vaults cancels an in-flight native lookup by operation id", async () => {
  const rawStorage = new FakeStorage();
  installLocalStorage(rawStorage);
  activateVaultStorage("vault-a", VAULT_KEY_A);
  saveKademliaConfig(ENABLED_CONFIG);
  const lookupStarted = deferred();
  const cancelled = deferred();
  let lookupOperationId = "";
  installTauriMock((command, payload) => {
    if (command === "kademlia_start") return RUNNING_STATUS;
    if (command === "kademlia_lookup") {
      lookupOperationId = (payload as { operationId?: string } | undefined)?.operationId ?? "";
      lookupStarted.resolve();
      return new Promise(() => undefined);
    }
    if (command === "kademlia_cancel") {
      assert.equal(
        (payload as { operationId?: string } | undefined)?.operationId,
        lookupOperationId,
      );
      cancelled.resolve();
      return undefined;
    }
    throw new Error(`Unexpected command: ${command}`);
  });

  try {
    const lookup = lookupRendezvousPointers("d".repeat(64));
    await within(lookupStarted.promise);
    const rejected = assert.rejects(lookup, /active vault changed/);
    activateVaultStorage("vault-b", VAULT_KEY_B);
    await rejected;
    await within(cancelled.promise);
    assert.ok(lookupOperationId);
  } finally {
    deactivateVaultStorage();
  }
});

test("a delayed vault-A start cannot stop or commit configuration into vault B", async () => {
  const rawStorage = new FakeStorage();
  installLocalStorage(rawStorage);
  activateVaultStorage("vault-a", VAULT_KEY_A);
  saveKademliaConfig(ENABLED_CONFIG);

  const trace: string[] = [];
  const startGate = deferred();
  const startStarted = deferred();
  installTauriMock((command) => {
    trace.push(command);
    if (command === "kademlia_start") {
      startStarted.resolve();
      return startGate.promise.then(() => RUNNING_STATUS);
    }
    if (command === "kademlia_status") return STOPPED_STATUS;
    return undefined;
  });

  try {
    const starting = ensureKademliaStarted();
    await startStarted.promise;
    const queuedApply = applyKademliaConfig({
      ...ENABLED_CONFIG,
      listenAddress: "/ip4/127.0.0.1/tcp/4999",
    });
    const startRejected = assert.rejects(starting, /active vault changed/);
    const applyRejected = assert.rejects(queuedApply, /active vault changed/);

    activateVaultStorage("vault-b", VAULT_KEY_B);
    startGate.resolve();
    await Promise.all([startRejected, applyRejected]);

    assert.deepEqual(trace, ["kademlia_start"]);
    assert.equal(loadKademliaConfig().enabled, false);
    assert.equal(await ensureKademliaStarted(), null);
    assert.deepEqual(trace, ["kademlia_start"]);
  } finally {
    startGate.resolve();
    deactivateVaultStorage();
  }
});

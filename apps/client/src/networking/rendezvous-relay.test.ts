import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";

import { sampleRendezvousRelays } from "./rendezvous-relay.js";

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");

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
      setTimeout(() => reject(new Error(`operation did not finish within ${ms}ms`)), ms);
    }),
  ]);
}

function sampleBounds(signal: AbortSignal) {
  return {
    requestedIds: ["a".repeat(64)],
    maxUniqueEvents: 1,
    maxTotalBytes: 4_096,
    maxEventBytes: 2_048,
    maxContentLength: 1_024,
    maxTags: 16,
    maxTagValues: 8,
    maxTagValueLength: 256,
    signal,
  };
}

afterEach(() => {
  clearMocks();
  if (originalWindow) {
    Object.defineProperty(globalThis, "window", originalWindow);
  } else {
    Reflect.deleteProperty(globalThis, "window");
  }
});

test("aborting relay sampling closes the exact native operation", async () => {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {},
    writable: true,
  });
  const started = deferred();
  const cancelled = deferred();
  let sampleOperationId = "";
  mockIPC((command, payload) => {
    if (command === "rendezvous_sample_relay") {
      sampleOperationId = (payload as {
        request?: { operationId?: string };
      } | undefined)?.request?.operationId ?? "";
      started.resolve();
      return new Promise(() => undefined);
    }
    if (command === "rendezvous_cancel_relay_sample") {
      assert.equal(
        (payload as { operationId?: string } | undefined)?.operationId,
        sampleOperationId,
      );
      cancelled.resolve();
      return undefined;
    }
    throw new Error(`Unexpected command: ${command}`);
  });

  const controller = new AbortController();
  const sample = sampleRendezvousRelays(
    ["wss://relay.example"],
    { ids: ["a".repeat(64)] },
    5_000,
    sampleBounds(controller.signal),
  );
  await within(started.promise);
  controller.abort(new Error("selection changed"));

  const report = await within(sample);
  await within(cancelled.promise);
  assert.match(report.errors[0]?.error ?? "", /selection changed/);
  assert.match(sampleOperationId, /^[0-9a-f-]{36}$/);
});

test("an abort during native dispatch still pre-cancels the exact operation", async () => {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {},
    writable: true,
  });
  const controller = new AbortController();
  const cancelled = deferred();
  let sampleOperationId = "";
  let cancelOperationId = "";
  mockIPC((command, payload) => {
    if (command === "rendezvous_sample_relay") {
      sampleOperationId = (payload as {
        request?: { operationId?: string };
      } | undefined)?.request?.operationId ?? "";
      // Tauri's mock invokes this callback synchronously while invoke() is
      // constructing its Promise, reproducing the dispatch/registration race.
      controller.abort(new Error("vault changed during dispatch"));
      return new Promise(() => undefined);
    }
    if (command === "rendezvous_cancel_relay_sample") {
      cancelOperationId = (payload as { operationId?: string } | undefined)?.operationId ?? "";
      cancelled.resolve();
      return undefined;
    }
    throw new Error(`Unexpected command: ${command}`);
  });

  const report = await within(sampleRendezvousRelays(
    ["wss://relay.example"],
    { ids: ["a".repeat(64)] },
    5_000,
    sampleBounds(controller.signal),
  ));
  await within(cancelled.promise);

  assert.match(report.errors[0]?.error ?? "", /vault changed during dispatch/);
  assert.match(sampleOperationId, /^[0-9a-f-]{36}$/);
  assert.equal(cancelOperationId, sampleOperationId);
});

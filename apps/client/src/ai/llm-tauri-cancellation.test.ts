import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  createCancellableTauriEventGateV1,
  invokeCancellableTauriLlmFetchV1,
} from "./llm.js";

const args = {
  requestId: "01234567-89ab-cdef-0123-456789abcdef",
  journalGeneration: 41,
  url: "https://provider.invalid/v1/messages",
  method: "POST" as const,
  headers: { authorization: "redacted-in-fixture" },
  body: "opaque request fixture",
  stream: false,
  onEvent: {},
};

test("a pre-aborted Tauri request never reaches either native command", async () => {
  const controller = new AbortController();
  controller.abort();
  const calls: string[] = [];

  await assert.rejects(
    invokeCancellableTauriLlmFetchV1(async (command) => {
      calls.push(command);
    }, args, controller.signal),
    { name: "AbortError", message: "The operation was aborted" },
  );
  assert.deepEqual(calls, []);
});

test("AbortSignal issues one native cancel and hides eventual provider failure", async () => {
  const controller = new AbortController();
  const calls: Array<{ command: string; requestId: unknown; journalGeneration: unknown }> = [];
  let rejectNative!: (error: Error) => void;
  const nativePending = new Promise<never>((_resolve, reject) => {
    rejectNative = reject;
  });
  const logged: unknown[] = [];
  const originalConsoleError = console.error;
  console.error = (...values: unknown[]) => { logged.push(values); };
  try {
    const pending = invokeCancellableTauriLlmFetchV1((command, invocationArgs) => {
      calls.push({
        command,
        requestId: invocationArgs?.requestId,
        journalGeneration: invocationArgs?.journalGeneration,
      });
      return command === "llm_fetch" ? nativePending : Promise.resolve();
    }, args, controller.signal);
    controller.abort();

    await assert.rejects(pending, {
      name: "AbortError",
      message: "The operation was aborted",
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(calls, [
      {
        command: "llm_fetch",
        requestId: args.requestId,
        journalGeneration: args.journalGeneration,
      },
      {
        command: "llm_cancel",
        requestId: args.requestId,
        journalGeneration: args.journalGeneration,
      },
    ]);

    rejectNative(new Error("raw provider body that must remain unobserved"));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(logged, []);
  } finally {
    console.error = originalConsoleError;
  }
});

test("completion removes the abort listener so a late abort cannot create a tombstone", async () => {
  const controller = new AbortController();
  const calls: string[] = [];
  await invokeCancellableTauriLlmFetchV1(async (command) => {
    calls.push(command);
  }, args, controller.signal);

  controller.abort();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["llm_fetch"]);
});

test("AbortSignal clears buffered frames and permanently fences queued channel events", () => {
  const controller = new AbortController();
  const frames: string[] = [];
  const gate = createCancellableTauriEventGateV1(
    controller.signal,
    (frame: string) => { frames.push(frame); },
    () => { frames.length = 0; },
  );
  gate.onEvent("delivered before cancellation");
  assert.deepEqual(frames, ["delivered before cancellation"]);

  controller.abort();
  gate.onEvent("queued after cancellation");
  gate.onEvent("another late frame");
  assert.deepEqual(frames, []);
  gate.dispose();
});

test("agent Tauri requests use the shared request-id, cancellation, and frame gate", () => {
  const source = readFileSync(new URL("./agent-llm.ts", import.meta.url), "utf8");
  const start = source.indexOf("async function rawRequest");
  const end = source.indexOf("function parseArgs", start);
  assert.ok(start >= 0 && end > start);
  const rawRequest = source.slice(start, end);
  assert.match(rawRequest, /createCancellableTauriEventGateV1\(/);
  assert.match(rawRequest, /invokeCancellableTauriLlmFetchV1\(invoke,/);
  assert.match(rawRequest, /requestId: crypto\.randomUUID\(\)/);
  assert.match(rawRequest, /journalGeneration: requireDesktopOperationJournalSessionV1\(\)\.journalGeneration/);
  assert.match(rawRequest, /signal/);
  assert.doesNotMatch(rawRequest, /invoke\("llm_fetch"/);
});

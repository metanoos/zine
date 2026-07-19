import assert from "node:assert/strict";
import test from "node:test";

import { invokeCancellableTauriLlmFetchV1 } from "./llm.js";

const args = {
  requestId: "01234567-89ab-cdef-0123-456789abcdef",
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
  const calls: Array<{ command: string; requestId: unknown }> = [];
  let rejectNative!: (error: Error) => void;
  const nativePending = new Promise<never>((_resolve, reject) => {
    rejectNative = reject;
  });
  const logged: unknown[] = [];
  const originalConsoleError = console.error;
  console.error = (...values: unknown[]) => { logged.push(values); };
  try {
    const pending = invokeCancellableTauriLlmFetchV1((command, invocationArgs) => {
      calls.push({ command, requestId: invocationArgs?.requestId });
      return command === "llm_fetch" ? nativePending : Promise.resolve();
    }, args, controller.signal);
    controller.abort();

    await assert.rejects(pending, {
      name: "AbortError",
      message: "The operation was aborted",
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(calls, [
      { command: "llm_fetch", requestId: args.requestId },
      { command: "llm_cancel", requestId: args.requestId },
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

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { runFactoryReset } from "./factory-reset.js";

const desktopCapability = JSON.parse(
  readFileSync(new URL("../../src-tauri/capabilities/default.json", import.meta.url), "utf8"),
) as { permissions?: unknown };

test("desktop factory reset can unload the Stronghold vault", () => {
  assert.ok(Array.isArray(desktopCapability.permissions));
  assert.ok(desktopCapability.permissions.includes("stronghold:allow-destroy"));
});

test("desktop factory reset unloads and deletes the vault before reloading", async () => {
  const calls: string[] = [];
  await runFactoryReset({
    resetDesktopState: async () => { calls.push("desktop"); },
    closeSecrets: async () => { calls.push("close"); },
    deleteDesktopVault: async () => { calls.push("vault"); },
    clearDurableBrowserState: async () => { calls.push("indexeddb"); },
    clearBrowserState: () => { calls.push("browser"); },
    reload: () => { calls.push("reload"); },
  });

  assert.deepEqual(calls, ["desktop", "close", "indexeddb", "browser", "vault", "reload"]);
});

test("browser factory reset clears browser state without desktop actions", async () => {
  const calls: string[] = [];
  await runFactoryReset({
    clearBrowserState: () => { calls.push("browser"); },
    reload: () => { calls.push("reload"); },
  });

  assert.deepEqual(calls, ["browser", "reload"]);
});

test("a vault deletion failure reloads instead of leaving a closed session rendered", async () => {
  const calls: string[] = [];
  await assert.rejects(
    runFactoryReset({
      resetDesktopState: async () => { calls.push("desktop"); },
      closeSecrets: async () => { calls.push("close"); },
      deleteDesktopVault: async () => {
        calls.push("vault");
        throw new Error("vault delete failed");
      },
      clearBrowserState: () => { calls.push("browser"); },
      reload: () => { calls.push("reload"); },
    }),
    /vault delete failed/,
  );

  assert.deepEqual(calls, ["desktop", "close", "browser", "vault", "reload"]);
});

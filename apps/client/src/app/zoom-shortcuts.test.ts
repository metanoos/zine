import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const tauriConfig = JSON.parse(
  readFileSync(new URL("../../src-tauri/tauri.conf.json", import.meta.url), "utf8"),
) as {
  app?: { windows?: Array<{ zoomHotkeysEnabled?: boolean }> };
};

const capabilities = JSON.parse(
  readFileSync(new URL("../../src-tauri/capabilities/default.json", import.meta.url), "utf8"),
) as { permissions?: string[] };

test("desktop zoom shortcuts scale the complete webview", () => {
  assert.equal(tauriConfig.app?.windows?.[0]?.zoomHotkeysEnabled, true);
  assert.ok(
    capabilities.permissions?.includes("core:webview:allow-set-webview-zoom"),
    "zoom hotkeys need permission to change the native webview scale",
  );
});

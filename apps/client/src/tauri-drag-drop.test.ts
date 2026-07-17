import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const config = JSON.parse(
  readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"),
) as {
  app?: { windows?: Array<{ dragDropEnabled?: boolean }> };
};

test("the desktop webview leaves HTML tab drag and drop enabled", () => {
  const windows = config.app?.windows ?? [];
  assert.ok(windows.length > 0, "missing Tauri window configuration");
  for (const window of windows) {
    assert.equal(window.dragDropEnabled, false);
  }
});

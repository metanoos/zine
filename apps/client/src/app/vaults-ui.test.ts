import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const appSource = [
  readFileSync(new URL("./AppNavigation.tsx", import.meta.url), "utf8"),
  readFileSync(new URL("./AppShell.tsx", import.meta.url), "utf8"),
  readFileSync(new URL("./App.tsx", import.meta.url), "utf8"),
].join("\n");
const bootstrapSource = readFileSync(new URL("./SecurityBootstrap.tsx", import.meta.url), "utf8");
const viewSource = readFileSync(new URL("./VaultsView.tsx", import.meta.url), "utf8");

test("Vaults is the first desktop management view ahead of Keys", () => {
  const management = appSource.slice(
    appSource.indexOf("const RAIL_BOTTOM: RailItem[]"),
    appSource.indexOf("function RailButton("),
  );
  assert.match(management, /view: "vaults"[\s\S]*view: "keys"[\s\S]*view: "models"[\s\S]*view: "networking"/);
  assert.match(appSource, /item\.view !== "vaults" \|\| isTauri\(\)/);
});

test("desktop bootstrap exposes named vault selection and confirmed setup", () => {
  assert.match(bootstrapSource, /listVaults\(\)/);
  assert.match(bootstrapSource, /createVaultRecord\(trimmedName\)/);
  assert.match(bootstrapSource, /openVaultSession\(vault, password/);
  assert.match(bootstrapSource, /<h1>Choose a vault<\/h1>/);
  assert.match(bootstrapSource, /Finish setup/);
  assert.match(bootstrapSource, /passphrase !== confirmation/);
  assert.match(bootstrapSource, /Retry lock/);
});

test("Vaults view exposes lock, switch, and create without calling them logout", () => {
  assert.match(viewSource, /"Lock vault"/);
  assert.match(viewSource, /"Switch"/);
  assert.match(viewSource, /"Create vault"/);
  assert.doesNotMatch(viewSource, /log\s*out/i);
});

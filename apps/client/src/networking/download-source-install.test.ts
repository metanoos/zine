import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./Download.tsx", import.meta.url), "utf8");

test("download view presents the source checkout as the default install", () => {
  const sourceInstall = source.indexOf("Run from source");
  const optionalInstallers = source.indexOf("Optional prebuilt installers");

  assert.ok(sourceInstall >= 0);
  assert.ok(optionalInstallers > sourceInstall);
  assert.match(source, /git clone https:\/\/github\.com\/metanoos\/zine\.git/);
  assert.match(source, /npm start/);
  assert.match(source, /npm run dev/);
  assert.match(source, /npm run update/);
  assert.match(source, /Local\s*changes are never overwritten/);
});

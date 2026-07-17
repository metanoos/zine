import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const css = readFileSync(new URL("../app/App.css", import.meta.url), "utf8");

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `missing CSS rule for ${selector}`);
  return match[1];
}

test("attestation note input follows the active theme", () => {
  const message = rule(".attest-message");
  assert.match(message, /background:\s*var\(--surface\)\s*;/);
  assert.match(message, /border:\s*1px solid var\(--rule\)\s*;/);
  assert.match(message, /color:\s*var\(--ink\)\s*;/);
});

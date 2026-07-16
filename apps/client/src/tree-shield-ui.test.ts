import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("./App.css", import.meta.url), "utf8");

test("directory tree icons use ordinary row activation instead of toggling shields", () => {
  assert.doesNotMatch(source, /onToggleShielded\(node\.path\)/);
  assert.doesNotMatch(source, /className="tree-icon-btn/);
  assert.match(source, /<span className="tree-icon-slot" aria-hidden="true">/);
});

test("shielding is explained and remains available from the context menu", () => {
  assert.match(source, /"Unshield from command scope"/);
  assert.match(source, /"Shield from command scope"/);
  assert.match(source, /onToggleShielded\(p\)/);
});

test("shielded directory tree icons remain blue", () => {
  assert.match(
    css,
    /\.tree-icon-shielded\s*\{[^}]*color:\s*var\(--shielded-fg\)/s,
  );
});

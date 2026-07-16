import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("./App.css", import.meta.url), "utf8");

test("tree drag acceptance reads the synchronous drag session", () => {
  assert.match(source, /const draggingPathsRef = useRef<Set<string>>/);
  assert.match(source, /draggingPathsRef\.current = nextDragging/);
  assert.match(source, /const current = draggingPathsRef\.current;\s*if \(current\.size === 0\)/s);
  assert.match(source, /onMove\(\[\.\.\.draggingPathsRef\.current\], destFolder\)/);
});

test("a valid folder target is visually stronger than an ordinary mount", () => {
  assert.match(
    css,
    /\.tree-row\.tree-drop-target\s*\{[^}]*box-shadow:\s*inset 0 0 0 2px var\(--accent\)/s,
  );
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");

test("coin body drops listen at the native CodeMirror DOM boundary", () => {
  const start = source.indexOf("// CodeMirror mounts its document DOM imperatively");
  const end = source.indexOf("// FileState is the cross-component handoff boundary", start);
  assert.ok(start >= 0 && end > start, "missing native coin-drop boundary");

  const dropBoundary = source.slice(start, end);
  assert.match(dropBoundary, /host\.addEventListener\("dragover", citationDragOver, true\)/);
  assert.match(dropBoundary, /host\.addEventListener\("drop", citationDrop, true\)/);
  assert.match(dropBoundary, /host\.removeEventListener\("drop", citationDrop, true\)/);
  assert.match(dropBoundary, /target\.closest\("\.editor-chrome-slot"\)/);
  assert.match(
    dropBoundary,
    /view\.posAtCoords\(coords\) \?\? view\.posAtCoords\(coords, false\)/,
  );
});

test("the React editor host does not rely on delegated drop capture", () => {
  const host = source.match(
    /<div\s+ref=\{hostRef\}\s+className=\{\"editor-host\"[\s\S]*?\/>/,
  );
  assert.ok(host, "missing editor host");
  assert.doesNotMatch(host[0], /onDragOverCapture|onDropCapture/);
});

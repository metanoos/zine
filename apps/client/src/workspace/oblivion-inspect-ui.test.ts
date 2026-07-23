import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = [
  readFileSync(new URL("../app/AppShell.tsx", import.meta.url), "utf8"),
  readFileSync(new URL("./WorkspaceSidebar.tsx", import.meta.url), "utf8"),
  readFileSync(new URL("../app/App.tsx", import.meta.url), "utf8"),
].join("\n");

test("Oblivion has no header menu while retained files route Inspect to the modal", () => {
  assert.match(
    source,
    /if \(item\.path === OBLIVION\) \{[\s\S]*?setCtxMenu\(null\);[\s\S]*?return;/,
  );
  assert.match(source, /else if \(isOblivion\(path\)\) onActivateOblivion\(path\)/);
  assert.match(source, /\{menu\.openLabel\}/);
});

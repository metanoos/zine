import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");

test("relay revocation is offered only for traces in Oblivion", () => {
  const action = source.match(
    /const canRevoke =([\s\S]*?)Request relay revocation…/,
  );

  assert.ok(action, "missing relay-revocation context-menu action");
  assert.match(action[0], /filePaths\.has\(path\)/);
  assert.match(action[0], /isOblivion\(path\)/);
});

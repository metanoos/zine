import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const app = readFileSync(new URL("../app/App.tsx", import.meta.url), "utf8");
function functionBody(name: string, next: string): string {
  const start = app.indexOf(`function ${name}`);
  const end = app.indexOf(next, start);
  assert.ok(start >= 0 && end > start, `${name} source boundary`);
  return app.slice(start, end);
}

test("historical Send and Attest operate on the exact immutable node without stepping", () => {
  const send = functionBody("sendHistoricalNode", "async function attestHistoricalNode");
  const attest = functionBody("attestHistoricalNode", "function stopOp");

  assert.match(send, /fetchEventById\(nodeId\)/);
  assert.match(send, /sendHistoricalStep\(event\)/);
  assert.doesNotMatch(send, /stepFile|setReplay|setPanels/);

  assert.match(attest, /isTraceNodeSent\(nodeId\)/);
  assert.match(attest, /fetchEventById\(nodeId\)/);
  assert.match(attest, /sendHistoricalStep\(event\)/);
  assert.match(attest, /attestNode\(nodeId/);
  assert.doesNotMatch(attest, /stepFile|setReplay|setPanels/);
});

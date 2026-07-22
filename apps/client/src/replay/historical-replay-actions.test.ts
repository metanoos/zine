import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const app = [
  readFileSync(new URL("../app/AppShell.tsx", import.meta.url), "utf8"),
  readFileSync(new URL("../app/App.tsx", import.meta.url), "utf8"),
].join("\n");
const provenance = readFileSync(new URL("../provenance/provenance.ts", import.meta.url), "utf8");
const css = readFileSync(new URL("../app/App.css", import.meta.url), "utf8");

function between(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(from, -1, `missing ${start}`);
  assert.notEqual(to, -1, `missing ${end}`);
  return source.slice(from, to);
}

test("replay tabs own exact historical Send and Attest controls", () => {
  assert.match(app, /replayMounted && isActive && replayNodeId/);
  assert.match(app, /className="replay-tab-action replay-tab-send"/);
  assert.match(app, /className="replay-tab-action replay-tab-attest"/);
  assert.match(app, /Send exact historical node/);
  assert.match(app, /Attest exact historical node/);
  assert.match(css, /\.replay-tab-actions\s*\{/);
});

test("historical Send publishes the displayed node without moving focus or stepping", () => {
  const send = between(
    app,
    "async function sendHistoricalNode(nodeId: string)",
    "/** Historical Attest",
  );
  assert.match(send, /fetchEventById\(nodeId\)/);
  assert.match(send, /sendHistoricalStep\(event\)/);
  assert.doesNotMatch(send, /stepFile|sendStep|setPanels|setActivePanel|commitUiFocus/);

  const exactPublisher = between(
    provenance,
    "export async function sendHistoricalStep(event: Event)",
    "/** Publish the ordered local signed-event outbox",
  );
  assert.match(exactPublisher, /publishToMany\(relays, event\)/);
  assert.doesNotMatch(exactPublisher, /publishTraceHead|resolveTraceIdentity/);
});

test("historical Attest may Send that exact node but never appends a live Step", () => {
  const attest = between(
    app,
    "async function attestHistoricalNode(",
    "/** Stop an in-flight op",
  );
  assert.match(attest, /isTraceNodeSent\(nodeId\)/);
  assert.match(attest, /sendHistoricalStep\(event\)/);
  assert.match(attest, /attestNode\(nodeId, undefined/);
  assert.doesNotMatch(attest, /stepFile|setPanels|setActivePanel|commitUiFocus/);
  assert.match(app, /if \(t\.historical && t\.nodeId\)[\s\S]*?attestHistoricalNode\(t\.nodeId/);
});

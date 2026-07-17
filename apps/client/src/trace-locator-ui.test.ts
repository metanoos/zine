import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./TraceLocatorModal.tsx", import.meta.url), "utf8");
const styles = readFileSync(new URL("./App.css", import.meta.url), "utf8");

test("sensitive locator destinations are shown before an explicit connection gesture", () => {
  assert.match(source, /const locator = parseTraceLocator\(input\)/);
  assert.match(source, /const relayHints = relayHintsRequiringApproval\(locator\)/);
  assert.match(source, /Private or unencrypted connection requested/);
  assert.match(source, /pendingApproval\.relayHints\.map/);
  assert.match(source, /Connect to listed relays/);
  assert.match(
    source,
    /loadLocator\([\s\S]*?pendingApproval\.locator,[\s\S]*?pendingApproval\.relayHints/,
  );
});

test("editing a locator clears its one-shot sensitive-relay approval", () => {
  assert.match(
    source,
    /onChange=\{\(event\) => \{[\s\S]*?setInput\(event\.target\.value\);[\s\S]*?setPendingApproval\(null\)/,
  );
  assert.match(styles, /\.trace-locator-approval\s*\{[^}]*border:[^;]*var\(--danger/s);
});

test("opened handoffs show the shared reader verdict", () => {
  assert.match(source, /traceConformanceLabel\(opened\.conformance\.status\)/);
  assert.match(source, /trace-conformance-badge/);
});

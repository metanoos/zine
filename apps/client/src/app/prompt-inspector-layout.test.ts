import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const css = readFileSync(new URL("./App.css", import.meta.url), "utf8");

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `missing CSS rule for ${selector}`);
  return match[1];
}

test("prompt inspector wraps within the tab without horizontal scrolling", () => {
  const body = rule(".prompt-inspector-body");
  assert.match(body, /min-width:\s*0\s*;/);
  assert.match(body, /overflow-x:\s*hidden\s*;/);

  const row = rule(".prompt-inspector-row");
  assert.match(row, /min-width:\s*0\s*;/);
  assert.match(row, /max-width:\s*100%\s*;/);

  const prompt = rule(".prompt-inspector-row .prompt-inspector-pre");
  assert.match(prompt, /min-width:\s*0\s*;/);
  assert.match(prompt, /max-width:\s*100%\s*;/);
  assert.match(prompt, /overflow-x:\s*hidden\s*;/);
  assert.match(prompt, /overflow-y:\s*auto\s*;/);
  assert.doesNotMatch(prompt, /overflow:\s*auto\s*;/);
});

test("trace context stays constrained and keyboard-scrollable inside the prompt modal", () => {
  const traceContext = rule(".prompt-inspector-trace-context");
  assert.match(traceContext, /min-width:\s*0\s*;/);
  assert.match(traceContext, /max-height:\s*42vh\s*;/);
  assert.match(traceContext, /overflow-x:\s*hidden\s*;/);
  assert.match(traceContext, /overflow-y:\s*auto\s*;/);

  const traceView = rule(".trace-context-inspector-view");
  assert.match(traceView, /min-width:\s*0\s*;/);
  assert.match(traceView, /flex-direction:\s*column\s*;/);
});

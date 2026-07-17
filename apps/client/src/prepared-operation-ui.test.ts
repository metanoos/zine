import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const inspector = readFileSync(
  new URL("./PromptInspectorModal.tsx", import.meta.url),
  "utf8",
);

function functionBody(name: string, nextName: string): string {
  const start = app.indexOf(`async function ${name}`);
  const end = app.indexOf(nextName, start + 1);
  assert.notEqual(start, -1, `${name} must exist`);
  assert.notEqual(end, -1, `${name} boundary must exist`);
  return app.slice(start, end);
}

test("every single-file MODEL operation uses approved buffered execution", () => {
  const operations = [
    ["extendLLM", "function settleDeDupeLLM"],
    ["settleLLM", "async function stirLLM"],
    ["stirLLM", "async function replyLLM"],
    ["replyLLM", "async function receiveLLM"],
    ["receiveLLM", "async function awaitViewMount"],
  ] as const;

  for (const [name, boundary] of operations) {
    const body = functionBody(name, boundary);
    assert.match(body, /approvedModelOperation\(/, `${name} must require approval`);
    assert.match(body, /executePreparedOperation\(\{/, `${name} must buffer and revalidate`);
    assert.match(body, /onStale:/, `${name} must preserve stale output`);
  }
  assert.doesNotMatch(app, /await complete\(/, "App must not bypass prepared transport");
  assert.match(app, /operationFocusMatches\(prepared, idx\)/);
  assert.match(app, /preparedDependenciesStillCurrent\(prepared, idx\)/);
});

test("Inspector renders and approves the exact frozen request", () => {
  assert.match(inspector, /preparedOperation\?\.messages/);
  assert.match(inspector, /onApprove\(preparedOperation\)/);
  assert.doesNotMatch(inspector, /assembleOpMessages|prepareChatMessages/);
  assert.match(app, /preparedApprovalRef\.current\.approve\(prepared\)/);
  assert.match(app, /MODEL response held/);
});

test("folder Settle fails closed until reviewed batch semantics exist", () => {
  const start = app.indexOf("function settleDeDupeLLM");
  const end = app.indexOf("async function settleLLM", start);
  const body = app.slice(start, end);
  assert.match(body, /dedicated reviewed batch/);
  assert.doesNotMatch(body, /executePreparedOperation|complete\(/);
});

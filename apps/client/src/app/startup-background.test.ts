import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
const main = readFileSync(new URL("../main.tsx", import.meta.url), "utf8");

test("the startup document resolves its theme and paints before React loads", () => {
  const themeBootstrapAt = html.indexOf('localStorage.getItem("zine-theme")');
  const criticalStyleAt = html.indexOf("data-startup-background");
  const reactEntryAt = html.indexOf('src="/src/main.tsx"');

  assert.ok(themeBootstrapAt >= 0, "missing the inline theme bootstrap");
  assert.ok(criticalStyleAt >= 0, "missing the critical startup background");
  assert.ok(reactEntryAt >= 0, "missing the React entry module");
  assert.ok(themeBootstrapAt < reactEntryAt, "theme must resolve before React loads");
  assert.ok(criticalStyleAt < reactEntryAt, "startup background must load before React");

  assert.match(html, /:root\s*\{[^}]*background-color:\s*#e5e2da;/s);
  assert.match(
    html,
    /@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*:root\s*\{[^}]*background-color:\s*#0a0a0b;/s,
  );
  assert.match(
    html,
    /:root\[data-theme="light"\]\s*\{[^}]*background-color:\s*#e5e2da;/s,
  );
  assert.match(
    html,
    /:root\[data-theme="dark"\]\s*\{[^}]*background-color:\s*#0a0a0b;/s,
  );
  assert.match(html, /body\s*\{[^}]*background-color:\s*inherit;/s);
});

test("theme resolution is not deferred to the React module", () => {
  assert.doesNotMatch(main, /localStorage\.getItem\("zine-theme"\)/);
});

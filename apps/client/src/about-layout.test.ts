import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const css = readFileSync(new URL("./App.css", import.meta.url), "utf8");

function mediaRange(start: string, end: string): string {
  const startIndex = css.indexOf(start);
  const endIndex = css.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `missing ${start}`);
  assert.notEqual(endIndex, -1, `missing ${end}`);
  return css.slice(startIndex, endIndex);
}

function rule(source: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `missing CSS rule for ${selector}`);
  return match[1];
}

test("Docs navigation uses a non-scrolling grid at the middle breakpoint", () => {
  const middle = mediaRange(
    "@media (max-width: 820px)",
    "@media (max-width: 560px)",
  );
  const list = rule(middle, ".about-category-list");

  assert.match(list, /display:\s*grid\s*;/);
  assert.match(
    list,
    /grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)\s*;/,
  );
  assert.match(list, /overflow-x:\s*visible\s*;/);
});

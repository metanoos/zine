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
    /grid-template-columns:\s*repeat\(5,\s*minmax\(0,\s*1fr\)\)\s*;/,
  );
  assert.match(list, /overflow-x:\s*visible\s*;/);
});

test("About article explicitly allows native text selection", () => {
  const detail = rule(css, ".about-telling");

  assert.match(detail, /-webkit-user-select:\s*text\s*;/);
  assert.match(detail, /(?:^|\s)user-select:\s*text\s*;/);
});

test("About document sections flow vertically instead of replacing one another", () => {
  const sections = rule(css, ".about-document-sections");

  assert.match(sections, /display:\s*flex\s*;/);
  assert.match(sections, /flex-direction:\s*column\s*;/);
});

test("About document descriptors wrap instead of truncating", () => {
  const description = rule(css, ".about-category .about-category-description");

  assert.match(description, /white-space:\s*normal\s*;/);
  assert.match(description, /overflow-wrap:\s*anywhere\s*;/);
  assert.doesNotMatch(description, /text-overflow:\s*ellipsis\s*;/);
});

test("About folio numbers stay visually separate from source titles", () => {
  const pageNumber = rule(css, ".about-title-number");
  const sectionNumber = rule(css, ".about-section-title-number");

  assert.match(pageNumber, /font-family:\s*var\(--font-mono\)\s*;/);
  assert.match(sectionNumber, /font-family:\s*var\(--font-mono\)\s*;/);
  assert.match(sectionNumber, /font-size:\s*0\.62rem\s*;/);
});

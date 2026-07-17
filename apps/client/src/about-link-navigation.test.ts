import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./About.tsx", import.meta.url), "utf8");

test("About owns a duplicated copy instead of importing repository Markdown", () => {
  assert.match(source, /import aboutCopy from "\.\/about-copy\.md\?raw"/);
  assert.doesNotMatch(source, /\.\.\/\.\.\/\.\.\/docs\//);
  assert.doesNotMatch(source, /dangerouslySetInnerHTML/);
});

test("internal prose references are React buttons with direct handlers", () => {
  assert.match(
    source,
    /case "link"[\s\S]*?aboutDocumentTarget\(link\.href, context\.document\.id\)/,
  );
  assert.match(
    source,
    /className="about-prose-link"[\s\S]*?onClick=\{\(\) => context\.navigate\(target\)\}/,
  );
});

test("section shortcuts use buttons instead of WebKit anchor activation", () => {
  assert.match(
    source,
    /document\.sections\.map[\s\S]*?<button[\s\S]*?className="about-section"[\s\S]*?navigateToDocument\(document\.id, candidate\.id\)/,
  );
  assert.doesNotMatch(source, /className="about-section"\s+href=/);
});

test("the rebuilt page has no delegated pointer or click interception", () => {
  assert.doesNotMatch(source, /onDetailPointerDown/);
  assert.doesNotMatch(source, /onDetailPointerUp/);
  assert.doesNotMatch(source, /onDetailClick/);
  assert.doesNotMatch(source, /anchorFromEventTarget/);
});

test("direct controls still update shareable hashes and selected content", () => {
  assert.match(source, /window\.history\.pushState\(null, "", hash\)/);
  assert.match(source, /selectDocument\(documentId, sectionId\)/);
  assert.match(
    source,
    /function navigateToTarget[\s\S]*?navigateToDocument\(target\.documentId, target\.sectionId\)/,
  );
});

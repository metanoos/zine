import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const appSource = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const styles = readFileSync(new URL("./App.css", import.meta.url), "utf8");

test("directory sorting sits left of onboarding and factory reset", () => {
  const footer = appSource.slice(
    appSource.indexOf('<div className="sidebar-directory-footer">'),
    appSource.indexOf("{ctxMenu &&"),
  );

  assert.match(footer, /aria-label="Sort directory"[\s\S]*<ArrowUpDown size=\{16\}/);
  assert.match(
    footer,
    /<ArrowUpDown size=\{16\}[\s\S]*<CircleHelp size=\{16\}[\s\S]*<Radiation size=\{16\}/,
  );
  assert.match(footer, /role="radiogroup"[\s\S]*aria-label="Directory sort order"/);
  assert.match(footer, /DIRECTORY_SORT_OPTIONS\.map/);
});

test("the shared preference drives all directory sections and persists", () => {
  assert.match(appSource, /loadDirectorySort\(\)/);
  assert.match(appSource, /saveDirectorySort\(directorySort\)/);
  assert.match(appSource, /buildDirectoryTree\(allEntries, rootLabel, directorySort\)/);
  assert.match(appSource, /directorySort=\{directorySort\}/);
  assert.match(appSource, /onDirectorySortChange=\{setDirectorySort\}/);
  assert.match(styles, /\.sidebar-sort-menu\s*\{/);
  assert.match(styles, /\.sidebar-help-btn\s*\{[^}]*margin-left:\s*auto;/s);
  assert.match(styles, /\.sidebar-sort-menu\s*\{[^}]*left:\s*0;/s);
  assert.match(styles, /\.sidebar-sort-option\[aria-checked="true"\]/);
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = [
  readFileSync(new URL("../app/AppShell.tsx", import.meta.url), "utf8"),
  readFileSync(new URL("../app/App.tsx", import.meta.url), "utf8"),
].join("\n");
const styles = readFileSync(new URL("../app/App.css", import.meta.url), "utf8");

test("replay and Coin tabs share an explicit read-only state", () => {
  assert.match(source, /const readOnlyTabDetail = isCoinTab\(p\)/);
  assert.match(source, /className="tab-readonly-badge"/);
  assert.match(source, /aria-label=\{`Read-only: \$\{readOnlyTabDetail\}`\}/);
  assert.match(source, />\s*READONLY\s*<\/span>/);
  assert.match(source, /className="panel-replay-notice"/);
  assert.match(source, /className="panel-replay-notice-label">READONLY<\/span>/);
  assert.match(source, /Historical snapshot · Read-only · Fork to edit/);
  assert.match(source, /Playback in progress · Read-only/);

  assert.doesNotMatch(styles, /\.tab\.tab-replay-(?:frozen|mounted)/);
  assert.doesNotMatch(styles, /\.panel\.panel-replay-(?:frozen|mounted)/);
});

test("Step is disabled while the focused file is read-only replay output", () => {
  assert.match(
    source,
    /const enabled =\s*!runningOp[\s\S]*?!replayFrozen;[\s\S]*?className=\{`action-palette-action op-save/,
  );
});

test("the read-only badge remains independent of the top-scrollbar transform", () => {
  const tabList = styles.match(/\.tab-list\s*\{([^}]*)\}/s);
  const badge = styles.match(/\.tab-readonly-badge\s*\{([^}]*)\}/s);

  assert.ok(tabList, "missing tab list styles");
  assert.match(tabList[1], /transform:\s*scaleY\(-1\)/);
  assert.ok(badge, "missing replay badge styles");
  assert.doesNotMatch(badge[1], /outline|box-shadow/);
});

test("non-editable trace surfaces use the raised read-only background", () => {
  assert.match(styles, /--readonly-surface:/);
  assert.match(
    styles,
    /\.panel-replay-frozen \.editor-host,\s*\.panel-replay-mounted \.editor-host\s*\{[^}]*--editor-surface:\s*var\(--readonly-surface\)/s,
  );
  assert.match(styles, /\.coin-view\s*\{[^}]*background:\s*var\(--readonly-surface\)/s);
  assert.match(styles, /\.coin-composer-view\s*\{[^}]*background:\s*var\(--surface\)/s);
});

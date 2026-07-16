import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const styles = readFileSync(new URL("./App.css", import.meta.url), "utf8");

test("replay state is named directly instead of encoded by inverted edges", () => {
  assert.match(source, /className="tab-replay-badge"/);
  assert.match(source, /className="panel-replay-notice"/);
  assert.match(source, /Historical snapshot · Read-only · Fork to edit/);
  assert.match(source, /Playback in progress · Read-only/);

  assert.doesNotMatch(styles, /\.tab\.tab-replay-(?:frozen|mounted)/);
  assert.doesNotMatch(styles, /\.panel\.panel-replay-(?:frozen|mounted)/);
});

test("the replay badge remains independent of the top-scrollbar transform", () => {
  const tabList = styles.match(/\.tab-list\s*\{([^}]*)\}/s);
  const badge = styles.match(/\.tab-replay-badge\s*\{([^}]*)\}/s);

  assert.ok(tabList, "missing tab list styles");
  assert.match(tabList[1], /transform:\s*scaleY\(-1\)/);
  assert.ok(badge, "missing replay badge styles");
  assert.doesNotMatch(badge[1], /outline|box-shadow/);
});

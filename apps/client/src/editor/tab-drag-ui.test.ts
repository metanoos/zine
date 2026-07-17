import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../app/App.tsx", import.meta.url), "utf8");

test("entering a panel tab bar targets its list end without committing the drop", () => {
  const tabListStart = source.indexOf('className={"tab-list"');
  const tabListEnd = source.indexOf("onDragEnd={onTabDragEnd}", tabListStart);
  assert.ok(tabListStart >= 0 && tabListEnd > tabListStart, "missing tab-list drag handlers");

  const tabList = source.slice(tabListStart, tabListEnd);
  const dragEnterStart = tabList.indexOf("onDragEnter=");
  const dragOverStart = tabList.indexOf("onDragOver=", dragEnterStart);
  const dropStart = tabList.indexOf("onDrop=", dragOverStart);
  assert.ok(dragEnterStart >= 0 && dragOverStart > dragEnterStart, "missing dragenter handler");
  assert.ok(dropStart > dragOverStart, "missing tab-list drop handler");

  const dragEnter = tabList.slice(dragEnterStart, dragOverStart);
  const drop = tabList.slice(dropStart);
  assert.match(dragEnter, /onTabDragEnterTarget\(null\)/);
  assert.doesNotMatch(dragEnter, /onDropOnListEnd/);
  assert.match(drop, /onDropOnListEnd\(\)/);
});

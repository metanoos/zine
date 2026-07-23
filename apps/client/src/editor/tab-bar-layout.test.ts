import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const styles = readFileSync(new URL("../app/App.css", import.meta.url), "utf8");

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = styles.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, "s"));
  assert.ok(match, `missing ${selector} styles`);
  return match[1];
}

test("view-mode buttons grow with the tab bar when a scrollbar appears", () => {
  const bar = rule(".tab-bar");
  const modeGroup = rule(".tab-bar-mode");

  assert.match(
    bar,
    /flex:\s*0 0 calc\(var\(--header-h\) \+ var\(--tab-scrollbar-h, 0px\)\)/,
  );
  assert.match(modeGroup, /align-items:\s*stretch/);
  assert.doesNotMatch(
    modeGroup,
    /padding-block(?:-start)?:\s*var\(--tab-scrollbar-h/,
    "scrollbar space must increase the buttons' height instead of becoming empty wrapper padding",
  );
});

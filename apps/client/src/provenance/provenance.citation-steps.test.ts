/**
 * Step distance for pinned citations. Citation edges always name one immutable
 * event; the row's badge reports how far that event is behind the resolved
 * head without changing the citation target.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { citationStepsBehind } from "./provenance.js";

const chain = ["genesis", "step-2", "step-3"].map((id) => ({ id }));

test("citationStepsBehind: head citation is current", () => {
  assert.equal(citationStepsBehind(chain, "step-3"), 0);
});

test("citationStepsBehind: counts later Steps after the cited event", () => {
  assert.equal(citationStepsBehind(chain, "step-2"), 1);
  assert.equal(citationStepsBehind(chain, "genesis"), 2);
});

test("citationStepsBehind: event outside the resolved branch has no distance", () => {
  assert.equal(citationStepsBehind(chain, "sibling-branch"), null);
});

test("citationStepsBehind: empty chain has no distance", () => {
  assert.equal(citationStepsBehind([], "genesis"), null);
});

import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_SOCIAL_QUERY,
  matchesSocialText,
  normalizeSocialQuery,
  socialWindowSince,
} from "./social-query.js";

test("normalizeSocialQuery repairs unknown persisted values", () => {
  assert.deepEqual(
    normalizeSocialQuery({ text: 4, window: "year", scope: "global" }),
    DEFAULT_SOCIAL_QUERY,
  );
});

test("socialWindowSince returns stable inclusive query bounds", () => {
  assert.equal(socialWindowSince("24h", 1_000_000), 913_600);
  assert.equal(socialWindowSince("all", 1_000_000), undefined);
});

test("matchesSocialText intersects words across name, id, and tags", () => {
  const item = { folderId: "abc123", name: "Field Notes", tags: ["ecology", "river"] };
  assert.equal(matchesSocialText("field #river", item), true);
  assert.equal(matchesSocialText("field desert", item), false);
  assert.equal(matchesSocialText("ABC123", item), true);
});


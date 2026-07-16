import test from "node:test";
import assert from "node:assert/strict";

import {
  MINT,
  OBLIVION,
  formatLocalSecondStamp,
  forkPathForMint,
  isMintPath,
  isOblivionPath,
  mintedPath,
  slugifyFilename,
  uniquePath,
} from "./generated-paths.js";

test("generated path timestamps use local second precision", () => {
  const date = new Date(2026, 6, 15, 14, 32, 10);
  assert.equal(formatLocalSecondStamp(date), "2026-07-15_143210");
});

test("mintedPath prefixes the smart title and stays inside Mint", () => {
  const date = new Date(2026, 6, 15, 14, 32, 10);
  assert.equal(
    mintedPath("The world is everything that is the case", date, new Set()),
    `${MINT}/2026-07-15_143210-the-world-is-everything-that-is-the-case.md`,
  );
});

test("mintedPath adds a suffix when an identical same-second name exists", () => {
  const date = new Date(2026, 6, 15, 14, 32, 10);
  const first = mintedPath("Same phrase", date, new Set());
  assert.equal(
    mintedPath("Same phrase", date, new Set([first])),
    `${MINT}/2026-07-15_143210-same-phrase-2.md`,
  );
});

test("forkPathForMint removes Mint's timestamp and avoids collisions", () => {
  const source = `${MINT}/2026-07-15_143210-same-phrase.md`;
  assert.equal(
    forkPathForMint(source, "notes", new Set(["notes/same-phrase.md"])),
    "notes/same-phrase-2.md",
  );
});

test("system path classifiers match only their own region", () => {
  assert.equal(isMintPath(MINT), true);
  assert.equal(isMintPath(`${MINT}/item.md`), true);
  assert.equal(isMintPath("minted/item.md"), false);
  assert.equal(isOblivionPath(OBLIVION), true);
  assert.equal(isOblivionPath(`${OBLIVION}/stamp/item.md`), true);
  assert.equal(isOblivionPath(`${MINT}/item.md`), false);
});

test("shared slug and collision helpers preserve generated-name conventions", () => {
  assert.equal(slugifyFilename("TITLE: A Small Zine.md"), "title-a-small-zine");
  assert.equal(uniquePath("reply.md", new Set(["reply.md", "reply-2.md"])), "reply-3.md");
});

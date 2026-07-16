import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

import { parseDirectorPages } from "./director-pages.js";

const directorCut = readFileSync(
  new URL("../../../protocol/directors-cut.md", import.meta.url),
  "utf8",
);

test("Director's Cut exposes the seven ordered About pages", () => {
  const pages = parseDirectorPages(directorCut);
  assert.deepEqual(
    pages.map(({ number, title }) => ({ number, title })),
    [
      { number: 1, title: "Pitch" },
      { number: 2, title: "Model" },
      { number: 3, title: "Gestures" },
      { number: 4, title: "Composition" },
      { number: 5, title: "Attribution & verification" },
      { number: 6, title: "Transport" },
      { number: 7, title: "Rendezvous & vetting" },
    ],
  );
  assert.ok(pages.every(({ title, markdown }) => title && markdown));
});

test("Director's Cut parser rejects an incomplete tour", () => {
  assert.throws(
    () => parseDirectorPages("## Page 1 — Only page\n\nIncomplete."),
    /exactly seven/,
  );
});

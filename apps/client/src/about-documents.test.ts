import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  aboutDocumentTarget,
  aboutHashTarget,
  aboutHeadingId,
  aboutRepositoryHref,
  aboutTargetHash,
  parseAboutDocuments,
  type AboutDocumentDefinition,
} from "./about-documents.js";

const sources: AboutDocumentDefinition[] = [
  ["product", "Product", "Who it serves and why.", "PRODUCT.md"],
  ["protocol", "Protocol", "How the machinery works.", "PROTOCOL.md"],
  ["evidence", "Evidence", "What the record supports.", "EVIDENCE.md"],
  ["roadmap", "Roadmap", "What evidence unlocks next.", "ROADMAP.md"],
  ["company", "Company", "How the open and paid layers meet.", "COMPANY.md"],
].map(([id, label, description, filename]) => ({
  id: id as AboutDocumentDefinition["id"],
  label,
  description,
  repositoryPath: `docs/${filename}`,
  markdown: readFileSync(new URL(`../../../docs/${filename}`, import.meta.url), "utf8"),
}));

test("About exposes the five reader-facing documents in product order", () => {
  const documents = parseAboutDocuments(sources);
  assert.deepEqual(
    documents.map(({ id, title, sections }) => ({ id, title, sections: sections.length })),
    [
      { id: "product", title: "Product", sections: 6 },
      { id: "protocol", title: "Protocol", sections: 7 },
      { id: "evidence", title: "Evidence", sections: 4 },
      { id: "roadmap", title: "Roadmap", sections: 8 },
      { id: "company", title: "Company", sections: 7 },
    ],
  );
  assert.ok(documents.every(({ sections }) => sections.every(({ id, title, markdown }) => id && title && markdown)));
});

test("the document parser rejects missing sections and an incomplete registry", () => {
  assert.throws(
    () => parseAboutDocuments(sources.slice(0, 4)),
    /must appear in this order/,
  );
  assert.throws(
    () => parseAboutDocuments([
      { ...sources[0], markdown: "# Product\n\nNo sections." },
      ...sources.slice(1),
    ]),
    /at least one/,
  );
});

test("About links resolve to documents, sections, and repository sources", () => {
  assert.equal(aboutHeadingId("Phase 4: Unlock network rendezvous"), "phase-4-unlock-network-rendezvous");
  assert.deepEqual(aboutDocumentTarget("ROADMAP.md#Phase-4:-Unlock-network-rendezvous"), {
    documentId: "roadmap",
    sectionId: "phase-4-unlock-network-rendezvous",
  });
  assert.deepEqual(aboutDocumentTarget("#The-problem", "product"), {
    documentId: "product",
    sectionId: "the-problem",
  });
  assert.equal(aboutDocumentTarget("../protocol/transport.md"), null);
  assert.equal(aboutDocumentTarget("https://example.com/ROADMAP.md"), null);
  assert.equal(
    aboutRepositoryHref("docs/PROTOCOL.md", "../protocol/transport.md"),
    "https://github.com/metanoos/zine/blob/main/protocol/transport.md",
  );
  assert.equal(aboutRepositoryHref("docs/PROTOCOL.md", "javascript:alert(1)"), "#");
});

test("About document and section hashes round-trip for browser navigation", () => {
  assert.equal(aboutTargetHash({ documentId: "protocol" }), "#about-protocol");
  assert.equal(
    aboutTargetHash({ documentId: "roadmap", sectionId: "phase-4-unlock-network-rendezvous" }),
    "#about-roadmap-phase-4-unlock-network-rendezvous",
  );
  assert.deepEqual(aboutHashTarget("#about-protocol"), { documentId: "protocol" });
  assert.deepEqual(aboutHashTarget("#about-product-the-problem"), {
    documentId: "product",
    sectionId: "the-problem",
  });
  assert.equal(aboutHashTarget("#settings-models"), null);
  assert.equal(aboutHashTarget("#about-unknown"), null);
});

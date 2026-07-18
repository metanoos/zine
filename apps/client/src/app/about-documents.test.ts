import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  aboutDocumentTarget,
  aboutFolio,
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
  markdown: readFileSync(new URL(`../../../../docs/${filename}`, import.meta.url), "utf8"),
}));
const aboutSource = readFileSync(new URL("./About.tsx", import.meta.url), "utf8");
const appCopy = readFileSync(new URL("./about-copy.md", import.meta.url), "utf8");

function copiedMarkdown(documentId: AboutDocumentDefinition["id"]): string {
  const startMarker = `<!-- zine-about-copy:${documentId}:start -->\n`;
  const endMarker = `<!-- zine-about-copy:${documentId}:end -->`;
  const start = appCopy.indexOf(startMarker);
  const end = appCopy.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `missing app copy for ${documentId}`);
  assert.notEqual(end, -1, `missing app copy terminator for ${documentId}`);
  return appCopy.slice(start + startMarker.length, end);
}

test("About exposes the five reader-facing documents in product order", () => {
  const documents = parseAboutDocuments(sources);
  assert.deepEqual(
    documents.map(({ id, title, sections }) => ({ id, title, sections: sections.length })),
    [
      { id: "product", title: "Product", sections: 8 },
      { id: "protocol", title: "Protocol", sections: 7 },
      { id: "evidence", title: "Evidence", sections: 5 },
      { id: "roadmap", title: "Roadmap", sections: 12 },
      { id: "company", title: "Company", sections: 7 },
    ],
  );
  assert.ok(documents.every(({ sections }) => sections.every(({ id, title, markdown }) => id && title && markdown)));
});

test("About's app-owned copy exactly matches the five repository documents", () => {
  for (const source of sources) {
    assert.equal(copiedMarkdown(source.id), source.markdown, source.repositoryPath);
  }
});

test("About folios number documents and their chapters without changing titles", () => {
  assert.equal(aboutFolio(0), "1");
  assert.equal(aboutFolio(4), "5");
  assert.equal(aboutFolio(0, 0), "1.1");
  assert.equal(aboutFolio(4, 6), "5.7");
});

test("About repeats section folios in shortcuts and destination headings", () => {
  assert.match(
    aboutSource,
    /className="about-section-number"[\s\S]*?aboutFolio\(documentIndex, sectionIndex\)/,
  );
  assert.match(
    aboutSource,
    /className="about-section-title-number"[\s\S]*?aboutFolio\(documentIndex, sectionIndex\)/,
  );
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
  for (const filename of ["trace-provenance.md", "transport.md", "rendezvous.md"]) {
    assert.equal(
      aboutRepositoryHref("docs/PROTOCOL.md", `../protocol/${filename}`),
      `https://github.com/metanoos/zine/blob/main/protocol/${filename}`,
    );
  }
  assert.equal(aboutRepositoryHref("docs/PROTOCOL.md", "javascript:alert(1)"), "#");
});

test("About sends external links through Tauri's configured URL opener", () => {
  assert.match(aboutSource, /import\("@tauri-apps\/plugin-opener"\)/);
  assert.match(aboutSource, /if \(isTauri\(\)\)/);
  assert.match(aboutSource, /onClick=\{\(\) => context\.openExternal\(href\)\}/);
});

test("About renders internal prose navigation as direct React controls", () => {
  assert.match(aboutSource, /className="about-prose-link"/);
  assert.match(aboutSource, /onClick=\{\(\) => context\.navigate\(target\)\}/);
  assert.doesNotMatch(aboutSource, /dangerouslySetInnerHTML/);
  assert.doesNotMatch(aboutSource, /data-about-document/);
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

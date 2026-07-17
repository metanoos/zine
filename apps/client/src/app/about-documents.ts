export const ABOUT_DOCUMENT_IDS = [
  "product",
  "protocol",
  "evidence",
  "roadmap",
  "company",
] as const;

export type AboutDocumentId = (typeof ABOUT_DOCUMENT_IDS)[number];

export interface AboutDocumentDefinition {
  id: AboutDocumentId;
  label: string;
  description: string;
  repositoryPath: string;
  markdown: string;
}

export interface AboutSection {
  id: string;
  title: string;
  markdown: string;
}

export interface AboutDocument extends Omit<AboutDocumentDefinition, "markdown"> {
  title: string;
  sections: AboutSection[];
}

export interface AboutDocumentTarget {
  documentId: AboutDocumentId;
  sectionId?: string;
}

/** Format zero-based document/section positions as editorial folios. */
export function aboutFolio(documentIndex: number, sectionIndex?: number): string {
  const documentNumber = String(documentIndex + 1);
  if (sectionIndex === undefined) return documentNumber;
  return `${documentNumber}.${sectionIndex + 1}`;
}

/** Find the visible folio for an internal About link target. */
export function aboutTargetFolio(
  documents: readonly AboutDocument[],
  target: AboutDocumentTarget,
): string | null {
  const documentIndex = documents.findIndex(({ id }) => id === target.documentId);
  if (documentIndex < 0) return null;
  if (!target.sectionId) return aboutFolio(documentIndex);

  const sectionIndex = documents[documentIndex].sections.findIndex(
    ({ id }) => id === target.sectionId,
  );
  return sectionIndex < 0
    ? aboutFolio(documentIndex)
    : aboutFolio(documentIndex, sectionIndex);
}

const DOCUMENT_BY_FILENAME: Record<string, AboutDocumentId> = {
  "PRODUCT.MD": "product",
  "PROTOCOL.MD": "protocol",
  "EVIDENCE.MD": "evidence",
  "ROADMAP.MD": "roadmap",
  "COMPANY.MD": "company",
};

/** Encode an About document or section as a browser-history-friendly hash. */
export function aboutTargetHash(target: AboutDocumentTarget): string {
  const section = target.sectionId ? `-${target.sectionId}` : "";
  return `#about-${target.documentId}${section}`;
}

/** Decode About hashes so direct links and browser Back/Forward drive the nav. */
export function aboutHashTarget(hash: string): AboutDocumentTarget | null {
  let fragment = hash.startsWith("#") ? hash.slice(1) : hash;
  try {
    fragment = decodeURIComponent(fragment);
  } catch {
    // Keep the literal fragment and fail closed if it does not match below.
  }
  if (!fragment.startsWith("about-")) return null;
  const route = fragment.slice("about-".length);
  const documentId = ABOUT_DOCUMENT_IDS.find(
    (id) => route === id || route.startsWith(`${id}-`),
  );
  if (!documentId) return null;
  const sectionId = route === documentId
    ? undefined
    : route.slice(documentId.length + 1);
  return sectionId ? { documentId, sectionId } : { documentId };
}

/** Match the stable, GitHub-compatible anchors generated from our headings. */
export function aboutHeadingId(heading: string): string {
  return heading
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

function withoutTrailingDivider(markdown: string): string {
  return markdown.replace(/\n---\s*$/, "").trim();
}

/** Parse one reader-facing Markdown source into About's document/section model. */
export function parseAboutDocument(
  definition: AboutDocumentDefinition,
): AboutDocument {
  const titleMatch = /^# (.+)$/m.exec(definition.markdown);
  if (!titleMatch || titleMatch.index !== 0) {
    throw new Error(`${definition.repositoryPath} must begin with one "# Title" heading.`);
  }

  const sectionHeading = /^## (.+)$/gm;
  const matches = [...definition.markdown.matchAll(sectionHeading)];
  if (matches.length === 0) {
    throw new Error(`${definition.repositoryPath} must contain at least one "## Section" heading.`);
  }

  const titleEnd = titleMatch[0].length;
  const prelude = withoutTrailingDivider(
    definition.markdown.slice(titleEnd, matches[0].index),
  );
  const seenIds = new Set<string>();

  const sections = matches.map((match, index): AboutSection => {
    const title = match[1].trim();
    const id = aboutHeadingId(title);
    if (!id || seenIds.has(id)) {
      throw new Error(`${definition.repositoryPath} has a duplicate or empty section id for "${title}".`);
    }
    seenIds.add(id);

    const bodyStart = (match.index ?? 0) + match[0].length;
    const bodyEnd = matches[index + 1]?.index ?? definition.markdown.length;
    const body = withoutTrailingDivider(definition.markdown.slice(bodyStart, bodyEnd));
    const markdown = index === 0 && prelude
      ? [prelude, body].filter(Boolean).join("\n\n")
      : body;

    if (!markdown) {
      throw new Error(`${definition.repositoryPath} section "${title}" is empty.`);
    }
    return { id, title, markdown };
  });

  return {
    id: definition.id,
    label: definition.label,
    description: definition.description,
    repositoryPath: definition.repositoryPath,
    title: titleMatch[1].trim(),
    sections,
  };
}

export function parseAboutDocuments(
  definitions: readonly AboutDocumentDefinition[],
): AboutDocument[] {
  const ids = definitions.map(({ id }) => id);
  if (
    ids.length !== ABOUT_DOCUMENT_IDS.length ||
    ABOUT_DOCUMENT_IDS.some((id, index) => ids[index] !== id)
  ) {
    throw new Error(`About documents must appear in this order: ${ABOUT_DOCUMENT_IDS.join(", ")}.`);
  }
  return definitions.map(parseAboutDocument);
}

/** Resolve links among the five bundled docs without navigating away from About. */
export function aboutDocumentTarget(
  href: string,
  currentDocumentId?: AboutDocumentId,
): AboutDocumentTarget | null {
  if (/^[a-z][a-z\d+.-]*:/i.test(href) || href.startsWith("//")) return null;
  const hashIndex = href.indexOf("#");
  const path = hashIndex >= 0 ? href.slice(0, hashIndex) : href;
  const rawHash = hashIndex >= 0 ? href.slice(hashIndex + 1) : "";
  const pathParts = path.split("/");
  const filename = pathParts[pathParts.length - 1]?.toUpperCase();
  const documentId = path.length === 0
    ? currentDocumentId
    : filename
      ? DOCUMENT_BY_FILENAME[filename]
      : undefined;
  if (!documentId) return null;

  let decodedHash = rawHash;
  try {
    decodedHash = decodeURIComponent(rawHash);
  } catch {
    // Keep the literal fragment; the heading normalizer still degrades safely.
  }
  const sectionId = decodedHash ? aboutHeadingId(decodedHash) : undefined;
  return sectionId ? { documentId, sectionId } : { documentId };
}

/** Turn non-About relative links into stable repository links for the app. */
export function aboutRepositoryHref(repositoryPath: string, href: string): string {
  if (/^(?:https?:|mailto:)/i.test(href)) return href;
  if (/^[a-z][a-z\d+.-]*:/i.test(href) || href.startsWith("//")) return "#";
  const base = new URL(`https://github.com/metanoos/zine/blob/main/${repositoryPath}`);
  return new URL(href, base).toString();
}

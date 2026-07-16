/**
 * About renders the five reader-facing documents from `docs/`. Repository
 * readers and app users therefore see the same product, protocol, evidence,
 * roadmap, and company narrative. The normative wire specs remain separate.
 */

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { marked, Renderer } from "marked";
import companyMarkdown from "../../../docs/COMPANY.md?raw";
import evidenceMarkdown from "../../../docs/EVIDENCE.md?raw";
import productMarkdown from "../../../docs/PRODUCT.md?raw";
import protocolMarkdown from "../../../docs/PROTOCOL.md?raw";
import roadmapMarkdown from "../../../docs/ROADMAP.md?raw";
import {
  aboutDocumentTarget,
  aboutHashTarget,
  aboutRepositoryHref,
  aboutTargetHash,
  parseAboutDocuments,
  type AboutDocument,
  type AboutDocumentDefinition,
  type AboutDocumentId,
} from "./about-documents.js";

const DEFINITIONS: AboutDocumentDefinition[] = [
  {
    id: "product",
    label: "Product",
    description: "Who needs Zine and where adoption starts.",
    repositoryPath: "docs/PRODUCT.md",
    markdown: productMarkdown,
  },
  {
    id: "protocol",
    label: "Protocol",
    description: "How traces, gestures, transport, and vetting work.",
    repositoryPath: "docs/PROTOCOL.md",
    markdown: protocolMarkdown,
  },
  {
    id: "evidence",
    label: "Evidence",
    description: "What is implemented, measured, and still unknown.",
    repositoryPath: "docs/EVIDENCE.md",
    markdown: evidenceMarkdown,
  },
  {
    id: "roadmap",
    label: "Roadmap",
    description: "Which evidence unlocks each product phase.",
    repositoryPath: "docs/ROADMAP.md",
    markdown: roadmapMarkdown,
  },
  {
    id: "company",
    label: "Company",
    description: "How the open protocol supports an optional paid layer.",
    repositoryPath: "docs/COMPANY.md",
    markdown: companyMarkdown,
  },
];

const DOCUMENTS = parseAboutDocuments(DEFINITIONS);

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function aboutSectionElementId(documentId: AboutDocumentId, sectionId: string): string {
  return aboutTargetHash({ documentId, sectionId }).slice(1);
}

function currentAboutTarget() {
  return typeof window === "undefined" ? null : aboutHashTarget(window.location.hash);
}

function renderAboutMarkdown(document: AboutDocument, markdown: string): string {
  const renderer = new Renderer();
  renderer.link = function renderLink({ href, tokens }) {
    const label = this.parser.parseInline(tokens);
    const target = aboutDocumentTarget(href, document.id);
    if (target) {
      const section = target.sectionId
        ? ` data-about-section="${escapeAttribute(target.sectionId)}"`
        : "";
      const targetHash = aboutTargetHash(target);
      return `<a href="${escapeAttribute(targetHash)}" data-about-document="${target.documentId}"${section}>${label}</a>`;
    }

    const resolved = aboutRepositoryHref(document.repositoryPath, href);
    if (resolved === "#") return label;
    return `<a href="${escapeAttribute(resolved)}" target="_blank" rel="noreferrer">${label}</a>`;
  };
  return marked.parse(markdown, { async: false, renderer }) as string;
}

export function AboutView() {
  const initialTargetRef = useRef(currentAboutTarget());
  const [activeDocumentId, setActiveDocumentId] = useState<AboutDocumentId>(
    initialTargetRef.current?.documentId ?? "product",
  );
  const document = DOCUMENTS.find(({ id }) => id === activeDocumentId) ?? DOCUMENTS[0];
  const detailRef = useRef<HTMLDivElement>(null);
  const pendingSectionIdRef = useRef<string | undefined>(initialTargetRef.current?.sectionId);
  const renderedSections = useMemo(
    () => document.sections.map((section) => ({
      ...section,
      html: renderAboutMarkdown(document, section.markdown),
    })),
    [document],
  );

  useEffect(() => {
    const requestedSectionId = pendingSectionIdRef.current;
    pendingSectionIdRef.current = undefined;
    if (requestedSectionId) {
      scrollToSection(requestedSectionId, "auto");
      return;
    }
    detailRef.current?.scrollTo({ top: 0 });
  }, [document.id]);

  useEffect(() => {
    function followAboutHistory() {
      const target = currentAboutTarget();
      if (target) {
        selectDocument(target.documentId, target.sectionId, "auto");
      } else if (!window.location.hash) {
        selectDocument("product", undefined, "auto");
      }
    }

    window.addEventListener("hashchange", followAboutHistory);
    window.addEventListener("popstate", followAboutHistory);
    return () => {
      window.removeEventListener("hashchange", followAboutHistory);
      window.removeEventListener("popstate", followAboutHistory);
    };
  }, [document.id]);

  function scrollToSection(sectionId: string, behavior: ScrollBehavior = "smooth") {
    const detail = detailRef.current;
    const target = detail?.querySelector<HTMLElement>(
      `#${aboutSectionElementId(document.id, sectionId)}`,
    );
    if (!detail || !target) return;
    const top = target.getBoundingClientRect().top
      - detail.getBoundingClientRect().top
      + detail.scrollTop;
    detail.scrollTo({ top, behavior });
  }

  function selectDocument(
    documentId: AboutDocumentId,
    requestedSectionId?: string,
    behavior: ScrollBehavior = "smooth",
  ) {
    const nextDocument = DOCUMENTS.find(({ id }) => id === documentId);
    if (!nextDocument) return;
    const nextSection = requestedSectionId
      ? nextDocument.sections.find(({ id }) => id === requestedSectionId)
      : undefined;
    if (nextDocument.id === document.id) {
      if (nextSection) {
        scrollToSection(nextSection.id, behavior);
      } else {
        detailRef.current?.scrollTo({ top: 0, behavior });
      }
      return;
    }
    pendingSectionIdRef.current = nextSection?.id;
    setActiveDocumentId(documentId);
  }

  function navigateToDocument(documentId: AboutDocumentId, requestedSectionId?: string) {
    const nextDocument = DOCUMENTS.find(({ id }) => id === documentId);
    if (!nextDocument) return;
    const sectionId = requestedSectionId && nextDocument.sections.some(
      ({ id }) => id === requestedSectionId,
    )
      ? requestedSectionId
      : undefined;
    const hash = aboutTargetHash({ documentId, ...(sectionId ? { sectionId } : {}) });
    if (window.location.hash !== hash) {
      window.history.pushState(null, "", hash);
    }
    selectDocument(documentId, sectionId);
  }

  function followDocumentLink(event: ReactMouseEvent<HTMLDivElement>) {
    const origin = event.target;
    if (!(origin instanceof Element)) return;
    const link = origin.closest<HTMLAnchorElement>("a[data-about-document]");
    if (!link) return;
    const documentId = link.dataset.aboutDocument as AboutDocumentId | undefined;
    if (!documentId) return;
    event.preventDefault();
    navigateToDocument(documentId, link.dataset.aboutSection);
  }

  return (
    <section className="view-placeholder about-view">
      <aside className="about-categories">
        <p className="about-intro">
          Five source documents. The same words here and in the repository.
        </p>
        <nav
          className="about-category-list"
          aria-label="About documents"
          role="tablist"
        >
          {DOCUMENTS.map((candidate) => (
            <button
              key={candidate.id}
              id={`about-document-${candidate.id}`}
              type="button"
              role="tab"
              aria-selected={document.id === candidate.id}
              aria-controls={aboutTargetHash({ documentId: candidate.id }).slice(1)}
              className={`about-category${document.id === candidate.id ? " active" : ""}`}
              onClick={() => navigateToDocument(candidate.id)}
            >
              <span className="about-category-label">{candidate.label}</span>
              <span className="about-category-description">{candidate.description}</span>
            </button>
          ))}
        </nav>
      </aside>

      <div className="about-detail" ref={detailRef} onClick={followDocumentLink}>
        <article
          id={aboutTargetHash({ documentId: document.id }).slice(1)}
          className="about-detail-inner about-telling"
          role="tabpanel"
          aria-labelledby={`about-document-${document.id}`}
        >
          <header className="about-document-header">
            <h1 className="about-title">{document.title}</h1>
            <nav className="about-section-list" aria-label={`${document.title} section shortcuts`}>
              {document.sections.map((candidate) => (
                <a
                  key={candidate.id}
                  className="about-section"
                  href={aboutTargetHash({ documentId: document.id, sectionId: candidate.id })}
                  onClick={(event) => {
                    event.preventDefault();
                    navigateToDocument(document.id, candidate.id);
                  }}
                >
                  {candidate.title}
                </a>
              ))}
            </nav>
          </header>
          <div className="about-document-sections">
            {renderedSections.map((section) => (
              <section
                key={section.id}
                id={aboutSectionElementId(document.id, section.id)}
                className="about-document-section"
              >
                <h2 className="about-section-title">{section.title}</h2>
                {/* Trusted, repository-owned Markdown bundled at build time. */}
                <div
                  className="about-prose"
                  dangerouslySetInnerHTML={{ __html: section.html }}
                />
              </section>
            ))}
          </div>
        </article>
      </div>
    </section>
  );
}

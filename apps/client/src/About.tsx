/**
 * About is an app-owned React reading surface. Its copy intentionally mirrors
 * the five reader-facing repository documents, but its elements and navigation
 * are rendered directly by React rather than injected as an HTML string.
 */

import {
  Fragment,
  createElement,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { marked, type Token, type Tokens } from "marked";
import aboutCopy from "./about-copy.md?raw";
import {
  aboutDocumentTarget,
  aboutFolio,
  aboutHashTarget,
  aboutRepositoryHref,
  aboutTargetHash,
  parseAboutDocuments,
  type AboutDocument,
  type AboutDocumentDefinition,
  type AboutDocumentId,
  type AboutDocumentTarget,
} from "./about-documents.js";
import { isTauri } from "./identity.js";

function appOwnedMarkdown(documentId: AboutDocumentId): string {
  const startMarker = `<!-- zine-about-copy:${documentId}:start -->\n`;
  const endMarker = `<!-- zine-about-copy:${documentId}:end -->`;
  const start = aboutCopy.indexOf(startMarker);
  const end = aboutCopy.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end < 0) {
    throw new Error(`App-owned About copy is missing ${documentId}.`);
  }
  return aboutCopy.slice(start + startMarker.length, end);
}

const DEFINITIONS: AboutDocumentDefinition[] = [
  {
    id: "product",
    label: "Product",
    description: "Who needs Zine and where adoption starts.",
    repositoryPath: "docs/PRODUCT.md",
    markdown: appOwnedMarkdown("product"),
  },
  {
    id: "protocol",
    label: "Protocol",
    description: "How traces, gestures, transport, and vetting work.",
    repositoryPath: "docs/PROTOCOL.md",
    markdown: appOwnedMarkdown("protocol"),
  },
  {
    id: "evidence",
    label: "Evidence",
    description: "What is implemented, measured, and still unknown.",
    repositoryPath: "docs/EVIDENCE.md",
    markdown: appOwnedMarkdown("evidence"),
  },
  {
    id: "roadmap",
    label: "Roadmap",
    description: "Which evidence unlocks each product phase.",
    repositoryPath: "docs/ROADMAP.md",
    markdown: appOwnedMarkdown("roadmap"),
  },
  {
    id: "company",
    label: "Company",
    description: "How the open protocol supports an optional paid layer.",
    repositoryPath: "docs/COMPANY.md",
    markdown: appOwnedMarkdown("company"),
  },
];

const DOCUMENTS = parseAboutDocuments(DEFINITIONS);

function aboutSectionElementId(documentId: AboutDocumentId, sectionId: string): string {
  return aboutTargetHash({ documentId, sectionId }).slice(1);
}

function currentAboutTarget() {
  return typeof window === "undefined" ? null : aboutHashTarget(window.location.hash);
}

async function openExternalAboutLink(href: string): Promise<void> {
  if (isTauri()) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(href);
    return;
  }
  window.open(href, "_blank", "noopener,noreferrer");
}

interface MarkdownRenderContext {
  document: AboutDocument;
  navigate: (target: AboutDocumentTarget) => void;
  openExternal: (href: string) => void;
}

function renderInlineTokens(
  tokens: Token[],
  context: MarkdownRenderContext,
  keyPrefix: string,
): ReactNode[] {
  return tokens.map((token, index) => {
    const key = `${keyPrefix}-${index}`;
    switch (token.type) {
      case "text": {
        const text = token as Tokens.Text;
        return text.tokens?.length
          ? <Fragment key={key}>{renderInlineTokens(text.tokens, context, key)}</Fragment>
          : <Fragment key={key}>{text.text}</Fragment>;
      }
      case "escape":
        return <Fragment key={key}>{(token as Tokens.Escape).text}</Fragment>;
      case "strong": {
        const strong = token as Tokens.Strong;
        return <strong key={key}>{renderInlineTokens(strong.tokens, context, key)}</strong>;
      }
      case "em": {
        const emphasis = token as Tokens.Em;
        return <em key={key}>{renderInlineTokens(emphasis.tokens, context, key)}</em>;
      }
      case "del": {
        const deleted = token as Tokens.Del;
        return <del key={key}>{renderInlineTokens(deleted.tokens, context, key)}</del>;
      }
      case "codespan":
        return <code key={key}>{(token as Tokens.Codespan).text}</code>;
      case "br":
        return <br key={key} />;
      case "link": {
        const link = token as Tokens.Link;
        const label = renderInlineTokens(link.tokens, context, `${key}-label`);
        const target = aboutDocumentTarget(link.href, context.document.id);
        if (target) {
          return (
            <button
              key={key}
              type="button"
              className="about-prose-link"
              title={link.title ?? undefined}
              onClick={() => context.navigate(target)}
            >
              {label}
            </button>
          );
        }
        const href = aboutRepositoryHref(context.document.repositoryPath, link.href);
        if (href === "#") return <Fragment key={key}>{label}</Fragment>;
        return (
          <button
            key={key}
            type="button"
            className="about-prose-link"
            title={link.title ?? href}
            onClick={() => context.openExternal(href)}
          >
            {label}
          </button>
        );
      }
      case "image": {
        const image = token as Tokens.Image;
        const href = aboutRepositoryHref(context.document.repositoryPath, image.href);
        return <img key={key} src={href} alt={image.text} title={image.title ?? undefined} />;
      }
      default:
        return <Fragment key={key}>{token.raw}</Fragment>;
    }
  });
}

function renderBlockTokens(
  tokens: Token[],
  context: MarkdownRenderContext,
  keyPrefix: string,
): ReactNode[] {
  return tokens.map((token, index) => {
    const key = `${keyPrefix}-${index}`;
    switch (token.type) {
      case "space":
      case "def":
        return null;
      case "paragraph": {
        const paragraph = token as Tokens.Paragraph;
        return <p key={key}>{renderInlineTokens(paragraph.tokens, context, key)}</p>;
      }
      case "text": {
        const text = token as Tokens.Text;
        return (
          <Fragment key={key}>
            {text.tokens?.length ? renderInlineTokens(text.tokens, context, key) : text.text}
          </Fragment>
        );
      }
      case "code": {
        const code = token as Tokens.Code;
        return (
          <pre key={key}>
            <code className={code.lang ? `language-${code.lang}` : undefined}>{code.text}</code>
          </pre>
        );
      }
      case "blockquote": {
        const quote = token as Tokens.Blockquote;
        return <blockquote key={key}>{renderBlockTokens(quote.tokens, context, key)}</blockquote>;
      }
      case "list": {
        const list = token as Tokens.List;
        const items = list.items.map((item, itemIndex) => (
          <li key={`${key}-item-${itemIndex}`}>
            {renderBlockTokens(item.tokens, context, `${key}-item-${itemIndex}`)}
          </li>
        ));
        return list.ordered
          ? <ol key={key} start={typeof list.start === "number" ? list.start : undefined}>{items}</ol>
          : <ul key={key}>{items}</ul>;
      }
      case "table": {
        const table = token as Tokens.Table;
        return (
          <table key={key}>
            <thead>
              <tr>
                {table.header.map((cell, cellIndex) => (
                  <th key={`${key}-head-${cellIndex}`} style={{ textAlign: cell.align ?? undefined }}>
                    {renderInlineTokens(cell.tokens, context, `${key}-head-${cellIndex}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((row, rowIndex) => (
                <tr key={`${key}-row-${rowIndex}`}>
                  {row.map((cell, cellIndex) => (
                    <td key={`${key}-row-${rowIndex}-${cellIndex}`} style={{ textAlign: cell.align ?? undefined }}>
                      {renderInlineTokens(cell.tokens, context, `${key}-row-${rowIndex}-${cellIndex}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        );
      }
      case "heading": {
        const heading = token as Tokens.Heading;
        const level = Math.min(6, Math.max(3, heading.depth));
        return createElement(
          `h${level}`,
          { key },
          renderInlineTokens(heading.tokens, context, key),
        );
      }
      case "hr":
        return <hr key={key} />;
      default:
        return <Fragment key={key}>{token.raw}</Fragment>;
    }
  });
}

function AboutMarkdown({
  document,
  markdown,
  onNavigate,
}: {
  document: AboutDocument;
  markdown: string;
  onNavigate: (target: AboutDocumentTarget) => void;
}) {
  const tokens = useMemo(() => marked.lexer(markdown), [markdown]);
  const context = useMemo<MarkdownRenderContext>(() => ({
    document,
    navigate: onNavigate,
    openExternal: (href) => {
      void openExternalAboutLink(href).catch((error) => {
        console.error(`Could not open About link ${href}`, error);
      });
    },
  }), [document, onNavigate]);
  return <>{renderBlockTokens(tokens, context, document.id)}</>;
}

export function AboutView() {
  const initialTargetRef = useRef(currentAboutTarget());
  const [activeDocumentId, setActiveDocumentId] = useState<AboutDocumentId>(
    initialTargetRef.current?.documentId ?? "product",
  );
  const document = DOCUMENTS.find(({ id }) => id === activeDocumentId) ?? DOCUMENTS[0];
  const documentIndex = Math.max(0, DOCUMENTS.findIndex(({ id }) => id === document.id));
  const documentFolio = aboutFolio(documentIndex);
  const detailRef = useRef<HTMLDivElement>(null);
  const pendingSectionIdRef = useRef<string | undefined>(initialTargetRef.current?.sectionId);

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

  function navigateToTarget(target: AboutDocumentTarget) {
    navigateToDocument(target.documentId, target.sectionId);
  }

  return (
    <section className="view-placeholder about-view">
      <aside className="about-categories">
        <p className="about-intro">
          Five source documents, rebuilt as an app-owned reading surface.
        </p>
        <nav
          className="about-category-list"
          aria-label="About documents"
          role="tablist"
        >
          {DOCUMENTS.map((candidate, candidateIndex) => (
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
              <span className="about-category-label">
                <span className="about-category-number">{aboutFolio(candidateIndex)}</span>
                <span>{candidate.label}</span>
              </span>
              <span className="about-category-description">{candidate.description}</span>
            </button>
          ))}
        </nav>
      </aside>

      <div className="about-detail" ref={detailRef}>
        <article
          id={aboutTargetHash({ documentId: document.id }).slice(1)}
          className="about-detail-inner about-telling"
          role="tabpanel"
          aria-labelledby={`about-document-${document.id}`}
        >
          <header className="about-document-header">
            <h1 className="about-title">
              <span className="about-title-number">{documentFolio}</span>
              <span>{document.title}</span>
            </h1>
            <nav className="about-section-list" aria-label={`${document.title} section shortcuts`}>
              {document.sections.map((candidate, sectionIndex) => (
                <button
                  key={candidate.id}
                  type="button"
                  className="about-section"
                  onClick={() => navigateToDocument(document.id, candidate.id)}
                >
                  <span className="about-section-number">
                    {aboutFolio(documentIndex, sectionIndex)}
                  </span>
                  <span>{candidate.title}</span>
                </button>
              ))}
            </nav>
          </header>
          <div className="about-document-sections">
            {document.sections.map((section, sectionIndex) => (
              <section
                key={section.id}
                id={aboutSectionElementId(document.id, section.id)}
                className="about-document-section"
              >
                <h2 className="about-section-title">
                  <span className="about-section-title-number">
                    {aboutFolio(documentIndex, sectionIndex)}
                  </span>
                  <span>{section.title}</span>
                </h2>
                <div className="about-prose">
                  <AboutMarkdown
                    document={document}
                    markdown={section.markdown}
                    onNavigate={navigateToTarget}
                  />
                </div>
              </section>
            ))}
          </div>
        </article>
      </div>
    </section>
  );
}

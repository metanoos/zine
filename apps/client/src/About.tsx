/**
 * About renders the seven-page guided tour from the protocol documentation.
 * Keeping prose out of this component makes `protocol/directors-cut.md` the
 * single source of truth for both readers of the repository and the app.
 */

import { useMemo, useState } from "react";
import { marked } from "marked";
import directorCut from "../../../protocol/directors-cut.md?raw";
import { parseDirectorPages, type PageNumber } from "./director-pages.js";

const ACTS: { label: string; pages: PageNumber[] }[] = [
  { label: "Intro", pages: [1] },
  { label: "Apparatus", pages: [2, 3, 4, 5] },
  { label: "Network", pages: [6, 7] },
];

const PAGES = parseDirectorPages(directorCut);

export function AboutView() {
  const [active, setActive] = useState<PageNumber>(1);
  const page = PAGES[active - 1];
  const pageHtml = useMemo(
    () => marked.parse(page.markdown, { async: false }) as string,
    [page.markdown],
  );

  return (
    <section className="view-placeholder about-view">
      <aside className="about-categories">
        <p className="about-intro">
          Seven pages on the press, its machinery, and the network it makes
          possible.
        </p>
        <nav
          className="about-category-list"
          aria-label="About pages"
          role="tablist"
        >
          {ACTS.map((act) => (
            <div className="about-category-group" key={act.label}>
              <span className="about-category-group-label">{act.label}</span>
              <div className="about-category-pages">
                {act.pages.map((number) => (
                  <button
                    key={number}
                    id={`about-category-${number}`}
                    type="button"
                    role="tab"
                    aria-selected={active === number}
                    aria-controls={`about-panel-${number}`}
                    className={`about-category${
                      active === number ? " active" : ""
                    }`}
                    onClick={() => setActive(number)}
                  >
                    <span className="about-category-label">
                      {String(number).padStart(2, "0")}
                    </span>
                    <span className="about-category-description">
                      {PAGES[number - 1].title}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </nav>
      </aside>

      <div className="about-detail">
        <article
          id={`about-panel-${active}`}
          className="about-detail-inner about-telling"
          role="tabpanel"
          aria-labelledby={`about-category-${active}`}
        >
          <h1 className="about-title">{page.title}</h1>
          {/* Trusted, repository-owned Markdown bundled at build time. */}
          <div
            className="about-prose"
            dangerouslySetInnerHTML={{ __html: pageHtml }}
          />
        </article>
      </div>
    </section>
  );
}

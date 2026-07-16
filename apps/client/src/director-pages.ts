export type PageNumber = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export interface DirectorPage {
  number: PageNumber;
  title: string;
  markdown: string;
}

/** Parse the docs-to-app contract used by the About view. */
export function parseDirectorPages(source: string): DirectorPage[] {
  const heading = /^## Page ([1-7]) — (.+)$/gm;
  const matches = [...source.matchAll(heading)];

  if (matches.length !== 7) {
    throw new Error(
      `Director's Cut must contain exactly seven "## Page N — Title" sections; found ${matches.length}.`,
    );
  }

  return matches.map((match, index): DirectorPage => {
    const number = Number(match[1]) as PageNumber;
    const expectedNumber = index + 1;
    if (number !== expectedNumber) {
      throw new Error(
        `Director's Cut page ${expectedNumber} is missing or out of order.`,
      );
    }

    const bodyStart = (match.index ?? 0) + match[0].length;
    const bodyEnd = matches[index + 1]?.index ?? source.length;
    const markdown = source
      .slice(bodyStart, bodyEnd)
      .replace(/\n---\s*$/, "")
      .trim();

    return { number, title: match[2].trim(), markdown };
  });
}

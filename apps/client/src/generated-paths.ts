/** Reserved top-level mount names in the Press tree. Mint is backed by its own
 *  protocol folder identity; Oblivion is a local lifecycle region. Neither is
 *  an ordinary user-created folder inside Root. */
export const MINT = "mint";
export const OBLIVION = "oblivion";

export function isMintPath(path: string): boolean {
  return path === MINT || path.startsWith(MINT + "/");
}

export function isOblivionPath(path: string): boolean {
  return path === OBLIVION || path.startsWith(OBLIVION + "/");
}

export function isSystemRootPath(path: string): boolean {
  return path === MINT || path === OBLIVION;
}

/** Filesystem-safe, fixed-width local timestamp used by every generated path.
 *  Lexical order is chronological within the creator's local timezone. Wire
 *  chronology still comes from the trace chain and signed event timestamps. */
export function formatLocalSecondStamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

/** Slugify a human phrase into a filename stem (lowercase, hyphenated, <=40).
 *  The helper stays deterministic and offline, so minting never depends on an
 *  LLM call. */
export function slugifyFilename(phrase: string, fallback = "response"): string {
  return (
    phrase
      .toLowerCase()
      .replace(/\.md$/i, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || fallback
  );
}

/** Append -2, -3, ... before the extension until the path is free. */
export function uniquePath(path: string, taken: ReadonlySet<string>): string {
  if (!taken.has(path)) return path;
  const dot = path.lastIndexOf(".");
  const stem = dot > 0 ? path.slice(0, dot) : path;
  const ext = dot > 0 ? path.slice(dot) : "";
  for (let i = 2; ; i++) {
    const candidate = `${stem}-${i}${ext}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export function mintedPath(
  phrase: string,
  date: Date,
  taken: ReadonlySet<string>,
): string {
  const title = slugifyFilename(phrase, "mint");
  return uniquePath(`${MINT}/${formatLocalSecondStamp(date)}-${title}.md`, taken);
}

const MINT_STAMP_PREFIX = /^\d{4}-\d{2}-\d{2}_\d{6}-/;

/** A Mint -> ordinary-folder drop creates an editable fork with an ordinary
 *  title. The timestamp belongs to the immutable Mint item, not its fork. */
export function forkPathForMint(
  sourcePath: string,
  destinationFolder: string,
  taken: ReadonlySet<string>,
): string {
  const sourceName = sourcePath.slice(sourcePath.lastIndexOf("/") + 1);
  const ordinaryName = sourceName.replace(MINT_STAMP_PREFIX, "") || "minted-trace.md";
  const candidate = destinationFolder
    ? `${destinationFolder}/${ordinaryName}`
    : ordinaryName;
  return uniquePath(candidate, taken);
}

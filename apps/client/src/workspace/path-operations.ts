import {
  isMintPath,
  isOblivionPath,
  isScanPath,
  isSystemRootPath,
  MINT,
  SCAN,
} from "./generated-paths.js";

/** The empty relative path represents the workspace root. */
export const ROOT = "";

const TAG_TOKEN_RE = /^[\p{L}\p{N}_][\p{L}\p{N}_-]*$/u;

/** Whether a folder name can be represented unchanged as its Nostr tag. */
export function isValidTagToken(name: string): boolean {
  return TAG_TOKEN_RE.test(name);
}

export function basename(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? path : path.slice(index + 1);
}

export function parentPath(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? ROOT : path.slice(0, index);
}

/** Whether a path has a file or explicit folder below it. */
export function hasChild(
  files: ReadonlySet<string>,
  folders: ReadonlySet<string>,
  parent: string,
): boolean {
  for (const file of files) if (file.startsWith(`${parent}/`)) return true;
  for (const folder of folders) if (folder.startsWith(`${parent}/`)) return true;
  return false;
}

export function isDescendantOrSelf(ancestor: string, descendant: string): boolean {
  return ancestor === descendant || descendant.startsWith(`${ancestor}/`);
}

/** Whether existing workspace paths allow moving `src` into `destFolder`. */
export function canDrop(
  src: string,
  destFolder: string,
  files: ReadonlySet<string>,
  folders: ReadonlySet<string>,
): boolean {
  if (
    isMintPath(destFolder) ||
    isScanPath(destFolder) ||
    (isOblivionPath(destFolder) && (isMintPath(src) || isScanPath(src)))
  ) {
    return false;
  }
  if (isMintPath(src)) return src !== MINT && !isSystemRootPath(destFolder);
  if (isScanPath(src)) return src !== SCAN && !isSystemRootPath(destFolder);
  if (destFolder === parentPath(src)) return false;
  if (isDescendantOrSelf(src, destFolder)) return false;

  const name = basename(src);
  const destination = destFolder === ROOT ? name : `${destFolder}/${name}`;
  return !files.has(destination) && !folders.has(destination);
}

export function rebasePath(path: string, src: string, destFolder: string): string {
  const name = basename(src);
  const destination = destFolder === ROOT ? name : `${destFolder}/${name}`;
  return path === src ? destination : destination + path.slice(src.length);
}

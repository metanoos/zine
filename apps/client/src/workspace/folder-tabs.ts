import { rebasePath } from "./path-operations.js";

const FOLDER_TAB_PREFIX = "folder://";

export const isFolderTab = (path: string): boolean => path.startsWith(FOLDER_TAB_PREFIX);

export const folderTab = (relativePath: string): string => FOLDER_TAB_PREFIX + relativePath;

export const folderTabPath = (path: string): string => path.slice(FOLDER_TAB_PREFIX.length);

/** Rebase a folder-tab sentinel when its underlying folder moves or is renamed. */
export function rebaseFolderTab(tab: string, src: string, destFolder: string): string {
  if (!isFolderTab(tab)) return tab;
  return folderTab(rebasePath(folderTabPath(tab), src, destFolder));
}

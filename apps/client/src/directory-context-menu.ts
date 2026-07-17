import {
  MINT,
  OBLIVION,
  SCAN,
  isMintPath,
  isOblivionPath,
  isScanPath,
  isSystemRootPath,
} from "./generated-paths.js";

export interface DirectoryContextMenuCapabilities {
  showMenu: boolean;
  openLabel: "Open" | "Inspect" | null;
  openToSide: boolean;
  newFile: boolean;
  newFolder: boolean;
  mintCoin: boolean;
  scanFile: boolean;
  scanFolder: boolean;
  reify: boolean;
  rename: boolean;
  renameDisabled: boolean;
  delete: boolean;
}

/**
 * Base context-menu capabilities for one directory row. Selection-dependent
 * movement actions (Adopt and Restore) are added by the Sidebar because they
 * can target several rows at once.
 */
export function directoryContextMenuCapabilities(
  path: string,
  isFolder: boolean,
  selectionSize: number,
): DirectoryContextMenuCapabilities {
  const singleTarget = selectionSize === 1;
  const isOblivionRoot = path === OBLIVION;
  const isOrdinaryFolder =
    isFolder &&
    !isMintPath(path) &&
    !isScanPath(path) &&
    !isOblivionPath(path);

  return {
    // The Oblivion header has no action of its own. Its retained descendants
    // still expose Inspect, Restore, revocation, and deletion where relevant.
    showMenu: !isOblivionRoot,
    openLabel:
      singleTarget && !isOblivionRoot
        ? isOblivionPath(path) && !isFolder
          ? "Inspect"
          : "Open"
        : null,
    openToSide: singleTarget && !isOblivionPath(path),
    newFile: singleTarget && isOrdinaryFolder,
    newFolder: singleTarget && isOrdinaryFolder,
    mintCoin: singleTarget && path === MINT,
    scanFile: singleTarget && path === SCAN,
    scanFolder: singleTarget && path === SCAN,
    // Reify is an explicit filesystem export, independent of prompt context.
    // Oblivion keeps its narrower inspect/restore lifecycle menu.
    reify: singleTarget && !isOblivionPath(path),
    // Root's cosmetic label is intentionally not a directory-menu mutation.
    rename:
      path !== "" &&
      !isMintPath(path) &&
      !isScanPath(path) &&
      !isOblivionPath(path),
    renameDisabled: selectionSize > 1,
    delete:
      path !== "" &&
      !isSystemRootPath(path) &&
      !isMintPath(path) &&
      !isScanPath(path),
  };
}

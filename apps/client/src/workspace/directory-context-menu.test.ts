import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { directoryContextMenuCapabilities } from "./directory-context-menu.js";

const appSource = readFileSync(new URL("../app/App.tsx", import.meta.url), "utf8");

test("Root opens and creates but cannot be renamed or deleted", () => {
  const menu = directoryContextMenuCapabilities("", true, 1);

  assert.equal(menu.showMenu, true);
  assert.equal(menu.openLabel, "Open");
  assert.equal(menu.openToSide, true);
  assert.equal(menu.newFile, true);
  assert.equal(menu.newFolder, true);
  assert.equal(menu.reify, true);
  assert.equal(menu.rename, false);
  assert.equal(menu.delete, false);
});

test("ordinary files and folders share Open, Open to side, rename, and delete", () => {
  const file = directoryContextMenuCapabilities("draft.md", false, 1);
  const folder = directoryContextMenuCapabilities("notes", true, 1);

  for (const menu of [file, folder]) {
    assert.equal(menu.openLabel, "Open");
    assert.equal(menu.openToSide, true);
    assert.equal(menu.rename, true);
    assert.equal(menu.delete, true);
    assert.equal(menu.reify, true);
  }
  assert.equal(file.newFile, false);
  assert.equal(folder.newFile, true);
  assert.equal(folder.newFolder, true);
});

test("Mint and its Coins expose creation, open, and Reify actions", () => {
  const mint = directoryContextMenuCapabilities("mint", true, 1);
  const coin = directoryContextMenuCapabilities("mint/coin.md", false, 1);

  assert.equal(mint.openLabel, "Open");
  assert.equal(mint.openToSide, true);
  assert.equal(mint.mintCoin, true);
  assert.equal(mint.reify, true);
  assert.equal(coin.openLabel, "Open");
  assert.equal(coin.openToSide, true);
  assert.equal(coin.rename, false);
  assert.equal(coin.delete, false);
  assert.equal(coin.reify, true);
});

test("Scan and its imported items expose scanning, open, and Reify actions", () => {
  const scan = directoryContextMenuCapabilities("scan", true, 1);
  const scannedFile = directoryContextMenuCapabilities("scan/imported.md", false, 1);

  assert.equal(scan.openLabel, "Open");
  assert.equal(scan.openToSide, true);
  assert.equal(scan.scanFolder, true);
  assert.equal(scan.scanFile, true);
  assert.equal(scan.reify, true);
  assert.equal(scannedFile.openLabel, "Open");
  assert.equal(scannedFile.openToSide, true);
  assert.equal(scannedFile.reify, true);
});

test("the Oblivion header has no menu while retained files remain inspectable", () => {
  const oblivion = directoryContextMenuCapabilities("oblivion", true, 1);
  const retained = directoryContextMenuCapabilities("oblivion/stamp/draft.md", false, 1);

  assert.equal(oblivion.showMenu, false);
  assert.equal(oblivion.openLabel, null);
  assert.equal(retained.showMenu, true);
  assert.equal(retained.openLabel, "Inspect");
  assert.equal(retained.openToSide, false);
  assert.equal(retained.reify, false);
  assert.equal(retained.rename, false);
  assert.equal(retained.delete, true);
});

test("the Sidebar wires the standardized capabilities to their existing flows", () => {
  assert.match(appSource, /if \(isFolder\) onOpenFolder\(path\)/);
  assert.match(appSource, /\{menu\.openLabel\}/);
  assert.match(appSource, /menu\.openToSide[\s\S]*?onOpenToSide\(path\)/);
  assert.doesNotMatch(appSource, /View Coin/);
  assert.match(appSource, /menu\.mintCoin[\s\S]*?onMintCoin\(\)[\s\S]*?Mint New Coin/);
  assert.match(appSource, /menu\.scanFolder[\s\S]*?onScan\("folder"\)[\s\S]*?Scan Folder/);
  assert.match(appSource, /menu\.scanFile[\s\S]*?onScan\("file"\)[\s\S]*?Scan File/);
  assert.match(appSource, /menu\.reify[\s\S]*?onReify\(\{ kind: isFolder \? "folder" : "file", path \}\)[\s\S]*?Reify/);
  assert.match(
    appSource,
    /relPath === ROOT \|\| isSystemRootPath\(relPath\) \|\| folderPaths\.has\(relPath\)/,
  );
});

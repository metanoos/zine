import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const appSource = [
  readFileSync(new URL("../app/AppShell.tsx", import.meta.url), "utf8"),
  readFileSync(new URL("../app/App.tsx", import.meta.url), "utf8"),
].join("\n");
const styles = readFileSync(new URL("../app/App.css", import.meta.url), "utf8");
const scanHandler = appSource.slice(
  appSource.indexOf("async function onScan("),
  appSource.indexOf("/** Reify:", appSource.indexOf("async function onScan(")),
);
const reifyTargets = appSource.slice(
  appSource.indexOf("function scopedReifyTargets("),
  appSource.indexOf("async function onReifyOp(", appSource.indexOf("function scopedReifyTargets(")),
);

test("Scan uses a dedicated ScanLine system header above Oblivion", () => {
  assert.match(appSource, /node\.systemKind === "scan"[\s\S]*?<ScanLine/);
  assert.match(appSource, /isCappedSystemRegion \|\| isScan\(node\.path\)/);
  assert.match(appSource, /\? "Scan"[\s\S]*?: "Oblivion"/);
});

test("the Scan header exposes file and folder intake actions", () => {
  const scanHeader = appSource.match(
    /isRoot && node\.systemKind === "scan"[\s\S]*?<\/span>/,
  )?.[0];
  assert.ok(scanHeader);
  assert.match(scanHeader, /className="tree-row-actions"/);
  assert.match(scanHeader, /aria-label="Scan folder"/);
  assert.match(scanHeader, /onScan\("folder"\)/);
  assert.match(scanHeader, /<FolderInput size=\{14\} aria-hidden="true"/);
  assert.match(scanHeader, /aria-label="Scan file"/);
  assert.match(scanHeader, /onScan\("file"\)/);
  assert.match(scanHeader, /<FileInput size=\{14\} aria-hidden="true"/);
  assert.doesNotMatch(scanHeader, /tree-icon-scan/);
  assert.match(appSource, /<Sidebar[\s\S]*?onScan=\{\(kind\) => void onScan\(kind\)\}/);
});

test("Scan intake targets its private folder instead of prompt context", () => {
  assert.match(scanHandler, /planScanIntake\(/);
  assert.match(scanHandler, /getOrCreateScanFolder\(/);
  assert.match(scanHandler, /const scanTree: LocalFolderTree/);
  assert.match(scanHandler, /ensureLocalTreeFolderPath\(/);
  assert.match(scanHandler, /localTreeFolderCoordinate\(scanTree, c\.path\)/);
  assert.match(scanHandler, /relativePath: coordinate\.relativePath/);
  assert.match(scanHandler, /folderId: coordinate\.folderId/);
  assert.match(scanHandler, /propagateLocalTreeFolderHead\(/);
  assert.match(scanHandler, /localOnly: true/);
  assert.doesNotMatch(scanHandler, /c\.path\.slice\(`\$\{SCAN\}\//);
  assert.doesNotMatch(scanHandler, /scopeRef|primaryScope|destFolder/);
  assert.doesNotMatch(scanHandler, /backendRef\.current\.writeFile/);
  assert.doesNotMatch(appSource, /Scan (?:File|Folder):[^\n]*under the scope/);
});

test("Scan entries are read-only and adopt into Root by lineage", () => {
  assert.match(appSource, /isMint\(path\) \|\| isScan\(path\) \|\| isOblivion\(path\)/);
  assert.match(appSource, /async function adoptScannedNodes\(/);
  assert.match(appSource, /forkFileIntoLocalTree\([\s\S]*?source\.nodeId,[\s\S]*?destPath/);
  assert.match(appSource, /withPersistedFolderStates\(prev, sourceRootId\)/);
  assert.match(appSource, /Adopt into Root/);
});

test("Scan files and folders use one read-only intake icon family", () => {
  assert.match(
    appSource,
    /const scanTab = isScan\(isFolderTab\(p\) \? folderTabPath\(p\) : p\);[\s\S]*?const readOnlyTabDetail = isCoinTab\(p\)[\s\S]*?: scanTab[\s\S]*?"Scanned snapshot · Adopt to edit"/,
  );
  assert.match(
    appSource,
    /isScan\(node\.path\) \? \([\s\S]*?<FolderInput size=\{13\} className="tree-icon tree-icon-scan"/,
  );
  assert.match(
    appSource,
    /<FileInput size=\{13\} className="tree-icon tree-icon-scan"/,
  );
  assert.match(
    appSource,
    /scanTab \? \([\s\S]*?<FolderInput size=\{12\} className="tab-status tab-status-scan"[\s\S]*?: scanTab \? \([\s\S]*?<FileInput size=\{12\} className="tab-status tab-status-scan"/,
  );
  assert.match(styles, /\.tree-icon-scan\s*\{[^}]*color:\s*var\(--scan-fg\)/s);
  assert.match(
    styles,
    /\.tab \.tab-status\.tab-status-scan\s*\{[^}]*color:\s*var\(--scan-fg\)[^}]*opacity:\s*1/s,
  );
});

test("Root Reify does not treat the synthetic Scan region as mounted content", () => {
  assert.match(reifyTargets, /isInScope\(scopes, shieldedRef\.current, path\)/);
  assert.doesNotMatch(reifyTargets, /pathInEffectiveScope/);
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = [
  readFileSync(new URL("../app/AppShell.tsx", import.meta.url), "utf8"),
  readFileSync(new URL("./WorkspaceSidebar.tsx", import.meta.url), "utf8"),
  readFileSync(new URL("../app/App.tsx", import.meta.url), "utf8"),
].join("\n");
const css = readFileSync(new URL("../app/App.css", import.meta.url), "utf8");
const model = readFileSync(new URL("../ai/scope-model.ts", import.meta.url), "utf8");
const mountModel = readFileSync(new URL("./mount-scope.ts", import.meta.url), "utf8");

test("directory tree icons mount context without activating their rows", () => {
  assert.match(source, /className="tree-icon-slot tree-icon-btn"/);
  assert.match(source, /data-mount-state=\{folderMountState\}/);
  assert.match(source, /e\.stopPropagation\(\);\s*onSetMountState\(/);
  assert.match(source, /aria-label=\{[\s\S]*Exclude \$\{displayName\} from context/);
  assert.match(source, /replacing the current prompt context/);
});

test("directory rows select replay traces without changing context mounts", () => {
  const rowHandler = source.match(
    /function onRowActivate\(item: ActivatableTreeItem, e: React\.MouseEvent\) \{([\s\S]*?)\n  \}/,
  );
  assert.ok(rowHandler, "missing row selection handler");
  assert.match(rowHandler[1], /applyScopeClick\(/);
  assert.match(rowHandler[1], /onSelectionChange\(result\.scopes\)/);
  assert.doesNotMatch(rowHandler[1], /onSetMountState|setContextMount/);
});

test("generated regions expose cosmetic labels without competing row controls", () => {
  assert.match(source, /const displayName = treeNodeDisplayName\(node\)/);
  assert.match(
    source,
    /node\.systemKind === "mint" \|\|[\s\S]*node\.systemKind === "scan" \|\|[\s\S]*node\.systemKind === "oblivion"/,
  );
  assert.doesNotMatch(source, /tree-system-sort|systemSorts|onSystemSortChange/);
  assert.doesNotMatch(css, /\.tree-system-sort/);
  assert.match(source, /walk\(tree\)/);
});

test("fixed top-level directory regions have gapless dividers and ordinary row heights", () => {
  assert.match(source, /isRoot \? " tree-node-root" : ""/);
  const dividerRule = css.match(
    /\.tree > \.tree-node-root \+ \.tree-node-root\s*\{([^}]*)\}/s,
  );
  assert.ok(dividerRule, "missing top-level directory divider rule");
  assert.match(dividerRule[1], /border-top:\s*1px solid var\(--rule-strong\)/);
  assert.doesNotMatch(dividerRule[1], /margin-top|padding-top/);
  assert.doesNotMatch(
    css,
    /\.tree > \.tree-node-root > \.tree-row\s*\{[^}]*padding/s,
  );
});

test("the directory tree is the only vertical scrollport", () => {
  assert.match(css, /\.tree\s*\{[^}]*overflow-y:\s*auto/s);
  assert.doesNotMatch(source, /tree-node-system|tree-system-children/);
  assert.doesNotMatch(css, /\.tree-node-system|\.tree-system-children/);
});

test("folder context mounting replaces the active root or shields an included subtree", () => {
  assert.match(source, /contextMountState\(scopes, shielded, node\.path\)/);
  assert.match(model, /applyMountScope\(/);
  assert.match(mountModel, /mount: target, shields: \[\.\.\.shields\]/);
  assert.match(mountModel, /normalized\.mount\?\.path === target\.path/);
  assert.match(mountModel, /shields\.add\(target\.path\)/);
});

test("context icons distinguish the exact mount from inherited inclusion", () => {
  assert.match(
    css,
    /\.tree-icon-included\s*\{[^}]*color:\s*var\(--context-included-fg\)/s,
  );
  assert.match(
    css,
    /\.tree-icon-in-scope\s*\{[^}]*color:\s*var\(--context-mounted-fg\)/s,
  );
  assert.match(
    css,
    /\.tree-icon-shielded\s*\{[^}]*color:\s*var\(--shielded-fg\)/s,
  );
  assert.match(
    css,
    /\.tree-icon,\s*\.action-palette-replay-target-icon\s*\{[^}]*color:\s*var\(--tree-icon-idle-fg\)/s,
  );
  assert.match(source, /const folderMounted = folderMountState === "mounted"/);
  assert.match(source, /folderMountState === "included"[\s\S]*tree-icon-included/);
  assert.match(source, /folderMountState === "shielded"[\s\S]*tree-icon-shielded/);
  assert.match(source, /fileMountState === "included"[\s\S]*tree-icon-included/);
  assert.match(source, /fileMountState === "shielded"[\s\S]*tree-icon-shielded/);
  assert.doesNotMatch(source, /tree-icon-mixed|MountCoverage|mountCoverage/);
  assert.doesNotMatch(css, /\.tree-icon-mixed/);
});

test("system-region icons keep their own neutral, blue, and green semantics", () => {
  assert.match(source, /isOblivion\(node\.path\)[\s\S]*tree-icon-oblivion/);
  assert.match(source, /className="tree-icon tree-icon-scan"/);
  assert.match(source, /className="tree-icon tree-icon-mint"/);
  assert.match(source, /className="tree-icon tree-icon-coin"/);
  assert.match(css, /\.tree-icon-oblivion\s*\{[^}]*color:\s*var\(--ink-dim\)/s);
  assert.match(css, /\.tree-icon-scan\s*\{[^}]*color:\s*var\(--scan-fg\)/s);
  assert.match(css, /\.tree-icon-mint\s*\{[^}]*color:\s*var\(--mint-fg\)/s);
  assert.match(css, /\.tree-icon-coin\s*\{[^}]*color:\s*var\(--coin-fg\)/s);
});

test("only the explicit shield boundary is red; its descendants are unmounted", () => {
  assert.match(css, /--shielded-fg:\s*var\(--reject-fg\)/);
  assert.equal(
    (css.match(/--reject-fg:\s*#c9182b(?:\s*!important)?;/g) ?? []).length,
    2,
  );
  assert.match(
    source,
    /folderMountState === "shielded" \? \([\s\S]*?<FolderX size=\{13\} className=\{folderIconClass\}/,
  );
  assert.match(
    source,
    /fileMountState === "shielded" \? \([\s\S]*?<FileX size=\{13\} className=\{fileIconClass\}/,
  );
  assert.match(mountModel, /normalized\.shields\.includes\(path\)/);
  assert.match(
    mountModel,
    /boundary !== path && containsMountedPath\(boundary, path\)\) return "unmounted"/,
  );
  assert.match(
    mountModel,
    /containsMountedPath\(target\.path, boundary\)\) shields\.delete\(boundary\)/,
  );
});

test("Lucide icons share a reinforced global stroke weight", () => {
  assert.match(css, /\.lucide\s*\{[^}]*stroke-width:\s*2\.25/s);
});

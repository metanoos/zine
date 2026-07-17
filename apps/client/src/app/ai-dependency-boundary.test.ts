import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import * as ts from "typescript";

const appDirectory = resolve(fileURLToPath(new URL(".", import.meta.url)));
const sourceDirectory = resolve(appDirectory, "..");
const aiDirectory = resolve(sourceDirectory, "ai");

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

test("AI modules never depend on the app composition root", () => {
  for (const file of sourceFiles(aiDirectory)) {
    const source = readFileSync(file, "utf8");
    const imports = ts.preProcessFile(source, true, true).importedFiles;
    for (const imported of imports) {
      if (!imported.fileName.startsWith(".")) continue;
      const target = resolve(dirname(file), imported.fileName);
      const entersApp = target === appDirectory || target.startsWith(`${appDirectory}${sep}`);
      assert.equal(
        entersApp,
        false,
        `${relative(sourceDirectory, file)} imports app-owned ${imported.fileName}`,
      );
    }
  }
});

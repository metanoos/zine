/** Pure naming rules for bringing filesystem snapshots into the Scan inbox. */

import {
  SCAN,
  slugifyFilename,
  uniquePath,
} from "./generated-paths.js";

export interface ScanIntakeEntry {
  relativePath: string;
  content: string;
}

export interface PlannedScanEntry extends ScanIntakeEntry {
  path: string;
}

function cleanSegments(path: string): string {
  const segments = path
    .split(/[\\/]+/)
    .filter(Boolean);
  return segments
    .map((segment, index) => {
      const clean = slugifyFilename(segment, segment) || "file";
      return index === segments.length - 1 ? `${clean}.md` : clean;
    })
    .join("/");
}

function pickedBasename(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const parts = trimmed.split(/[\\/]+/);
  return parts[parts.length - 1] ?? "folder";
}

/** Include implicit parent folders in an occupied-path set so a repeated
 * folder scan suffixes the whole wrapper (`project-2/`) instead of spraying
 * `-2` suffixes across individual leaves. */
function withAncestors(paths: ReadonlySet<string>): Set<string> {
  const occupied = new Set(paths);
  for (const path of paths) {
    let slash = path.lastIndexOf("/");
    while (slash > 0) {
      occupied.add(path.slice(0, slash));
      slash = path.lastIndexOf("/", slash - 1);
    }
  }
  return occupied;
}

export function planScanIntake(
  kind: "file" | "folder",
  pickedPath: string,
  entries: readonly ScanIntakeEntry[],
  takenPaths: ReadonlySet<string>,
): PlannedScanEntry[] {
  const taken = withAncestors(takenPaths);
  const planned: PlannedScanEntry[] = [];

  let wrapper = SCAN;
  if (kind === "folder") {
    const sourceName = slugifyFilename(pickedBasename(pickedPath), "folder");
    wrapper = uniquePath(`${SCAN}/${sourceName}`, taken);
    taken.add(wrapper);
  }

  for (const entry of entries) {
    const clean = cleanSegments(entry.relativePath) || "file.md";
    const candidate = `${wrapper}/${clean}`;
    const path = uniquePath(candidate, taken);
    taken.add(path);
    planned.push({ ...entry, path });
  }
  return planned;
}

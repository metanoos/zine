/** Local presentation preference for every section of the Press directory. */

export const DIRECTORY_SORT_STORAGE_KEY = "zine.press.directorySort";

export type DirectorySortOrder =
  | "name-asc"
  | "name-desc"
  | "newest"
  | "oldest";

export const DIRECTORY_SORT_OPTIONS: readonly {
  value: DirectorySortOrder;
  label: string;
}[] = [
  { value: "name-asc", label: "A → Z" },
  { value: "name-desc", label: "Z → A" },
  { value: "newest", label: "Recent" },
  { value: "oldest", label: "Oldest" },
];

type DirectorySortStorage = Pick<Storage, "getItem" | "setItem">;

export function isDirectorySortOrder(value: unknown): value is DirectorySortOrder {
  return DIRECTORY_SORT_OPTIONS.some((option) => option.value === value);
}

export function loadDirectorySort(
  storage: DirectorySortStorage = localStorage,
): DirectorySortOrder {
  try {
    const stored = storage.getItem(DIRECTORY_SORT_STORAGE_KEY);
    return isDirectorySortOrder(stored) ? stored : "name-asc";
  } catch {
    return "name-asc";
  }
}

export function saveDirectorySort(
  order: DirectorySortOrder,
  storage: DirectorySortStorage = localStorage,
): void {
  try {
    storage.setItem(DIRECTORY_SORT_STORAGE_KEY, order);
  } catch {
    // Storage is a convenience. The in-memory setting still applies.
  }
}

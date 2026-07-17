import test from "node:test";
import assert from "node:assert/strict";

import {
  DIRECTORY_SORT_STORAGE_KEY,
  loadDirectorySort,
  saveDirectorySort,
  type DirectorySortOrder,
} from "./directory-sort.js";

function storage(initial?: string): Pick<Storage, "getItem" | "setItem"> & {
  value: () => string | null;
} {
  let current = initial ?? null;
  return {
    getItem: (key) => key === DIRECTORY_SORT_STORAGE_KEY ? current : null,
    setItem: (key, value) => {
      if (key === DIRECTORY_SORT_STORAGE_KEY) current = value;
    },
    value: () => current,
  };
}

test("directory sorting defaults to A to Z and accepts every supported order", () => {
  assert.equal(loadDirectorySort(storage()), "name-asc");
  for (const order of ["name-asc", "name-desc", "newest", "oldest"] satisfies DirectorySortOrder[]) {
    assert.equal(loadDirectorySort(storage(order)), order);
  }
  assert.equal(loadDirectorySort(storage("unsupported")), "name-asc");
});

test("directory sorting persists as one app-wide preference", () => {
  const store = storage();
  saveDirectorySort("oldest", store);
  assert.equal(store.value(), "oldest");
  assert.equal(loadDirectorySort(store), "oldest");
});

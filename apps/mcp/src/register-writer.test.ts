import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { withExclusiveFileLock } from "./register-writer.js";

test("ACL file lock excludes a concurrent writer and cleans up", () => {
  const lockPath = join(mkdtempSync(join(tmpdir(), "zine-peers-lock-")), "peers.json.lock");
  const outer = withExclusiveFileLock(lockPath, () => {
    assert.equal(existsSync(lockPath), true);
    return withExclusiveFileLock(lockPath, () => "unexpected", 20);
  });

  assert.equal(outer, null);
  assert.equal(existsSync(lockPath), false);
  assert.equal(withExclusiveFileLock(lockPath, () => "acquired"), "acquired");
});

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { updateSourceCheckout } from "./source-update.mjs";

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "zine-source-update-"));
  const remote = join(root, "remote.git");
  const author = join(root, "author");
  const install = join(root, "install");

  git(root, "init", "--bare", "--initial-branch=main", remote);
  git(root, "init", "--initial-branch=main", author);
  git(author, "config", "user.name", "Zine test");
  git(author, "config", "user.email", "zine-test@example.invalid");
  writeFileSync(join(author, "version.txt"), "one\n");
  git(author, "add", "version.txt");
  git(author, "commit", "-m", "initial");
  git(author, "remote", "add", "origin", remote);
  git(author, "push", "-u", "origin", "main");
  git(root, "clone", remote, install);

  return { root, author, install };
}

function pushVersion(author, version) {
  writeFileSync(join(author, "version.txt"), `${version}\n`);
  git(author, "add", "version.txt");
  git(author, "commit", "-m", `version ${version}`);
  git(author, "push", "origin", "main");
}

function quietLogger(messages) {
  return {
    log(message) {
      messages.push(String(message));
    },
    warn(message) {
      messages.push(String(message));
    },
  };
}

test("source updater fast-forwards a clean tracking branch", () => {
  const { root, author, install } = fixture();
  try {
    pushVersion(author, "two");
    const messages = [];
    const result = updateSourceCheckout({ repoRoot: install, logger: quietLogger(messages) });

    assert.equal(result.status, "updated");
    assert.equal(readFileSync(join(install, "version.txt"), "utf8"), "two\n");
    assert.match(messages.join("\n"), /source updated/);

    const second = updateSourceCheckout({ repoRoot: install, logger: quietLogger([]) });
    assert.equal(second.status, "current");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("source updater preserves every dirty checkout", () => {
  const { root, author, install } = fixture();
  try {
    pushVersion(author, "two");
    writeFileSync(join(install, "local-note.txt"), "keep me\n");

    const result = updateSourceCheckout({ repoRoot: install, logger: quietLogger([]) });

    assert.equal(result.status, "dirty");
    assert.equal(readFileSync(join(install, "version.txt"), "utf8"), "one\n");
    assert.equal(readFileSync(join(install, "local-note.txt"), "utf8"), "keep me\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("source updater can be disabled for pinned or offline launches", () => {
  const { root, install } = fixture();
  try {
    const result = updateSourceCheckout({
      repoRoot: install,
      env: { ZINE_AUTO_UPDATE: "0" },
      logger: quietLogger([]),
    });
    assert.equal(result.status, "disabled");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("npm start owns source updates while npm run dev stays pinned", () => {
  const packageJson = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  const launcher = readFileSync(new URL("./dev.mjs", import.meta.url), "utf8");

  assert.equal(packageJson.scripts.start, "node scripts/dev.mjs start");
  assert.equal(packageJson.scripts.dev, "node scripts/dev.mjs dev");
  assert.match(launcher, /const sourceUpdate = mode === "start"/);
  assert.match(launcher, /const tauriMode = mode === "start" \? "dev" : mode/);
});

import test from "node:test";
import assert from "node:assert/strict";
import type { Event } from "nostr-tools";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";

// @ts-expect-error minimal localStorage shim for signer-resolution coverage
globalThis.localStorage = {
  values: new Map<string, string>(),
  getItem(key: string) {
    return this.values.get(key) ?? null;
  },
  setItem(key: string, value: string) {
    this.values.set(key, value);
  },
  removeItem(key: string) {
    this.values.delete(key);
  },
  clear() {
    this.values.clear();
  },
};

import {
  completeDeletion,
  completeBackgroundPush,
  completeStagedWrite,
  completedEmptyGenesisBootstrapHead,
  folderTraceIdentityFromNode,
  folderWriteSigner,
  localFolderCoordinate,
  localTreeFolderCoordinate,
  localFileSigner,
  ownershipDisposition,
  pendingMoveForPath,
  previousStepCitationTargets,
  publishEmptyGenesisIfNeeded,
} from "./workspace-local.js";
import { authorVoice, loadKeys } from "./keys-store.js";
import { saveLocalFile } from "./local-store.js";

test("flat local paths resolve to direct recursive folder coordinates", () => {
  localStorage.clear();
  saveLocalFile("root", "projects", {
    kind: "folder",
    content: "",
    tags: [],
    nodeId: "projects-head",
    traceId: "projects-genesis",
  });
  saveLocalFile("root", "projects/drafts", {
    kind: "folder",
    content: "",
    tags: [],
    nodeId: "drafts-head",
    traceId: "drafts-genesis",
  });

  assert.deepEqual(localFolderCoordinate("root", "readme.md"), {
    folderId: "root",
    folderPath: "",
    relativePath: "readme.md",
  });
  assert.deepEqual(localFolderCoordinate("root", "projects/plan.md"), {
    folderId: "projects-genesis",
    folderPath: "projects",
    relativePath: "plan.md",
  });
  assert.deepEqual(localFolderCoordinate("root", "projects/drafts/idea.md"), {
    folderId: "drafts-genesis",
    folderPath: "projects/drafts",
    relativePath: "idea.md",
  });
});

test("private Scan paths resolve inside their own recursive folder tree", () => {
  localStorage.clear();
  saveLocalFile("root", "scan/project", {
    kind: "folder",
    content: "",
    tags: [],
    nodeId: "project-head",
    traceId: "project-genesis",
  });
  saveLocalFile("root", "scan/project/src", {
    kind: "folder",
    content: "",
    tags: [],
    nodeId: "src-head",
    traceId: "src-genesis",
  });

  const scanTree = {
    storageRootId: "root",
    folderId: "scan-genesis",
    storagePath: "scan",
  };
  assert.deepEqual(localTreeFolderCoordinate(scanTree, "scan/readme.md"), {
    folderId: "scan-genesis",
    folderPath: "scan",
    relativePath: "readme.md",
  });
  assert.deepEqual(
    localTreeFolderCoordinate(scanTree, "scan/project/src/main-ts.md"),
    {
      folderId: "src-genesis",
      folderPath: "scan/project/src",
      relativePath: "main-ts.md",
    },
  );
  assert.throws(
    () => localTreeFolderCoordinate(scanTree, "outside/main.md"),
    /not a member inside scan/,
  );
});

test("folder heads recover their recursive trace identity without file-chain resolution", () => {
  const event = (id: string, tags: string[][]): Event => ({
    id,
    kind: 4290,
    pubkey: "owner",
    created_at: 1,
    content: "{}",
    sig: "",
    tags,
  });
  assert.equal(
    folderTraceIdentityFromNode(event("folder-genesis", [["z", "folder"]])),
    "folder-genesis",
  );
  assert.equal(
    folderTraceIdentityFromNode(event("folder-head", [
      ["z", "folder"],
      ["f", "folder-genesis"],
      ["e", "folder-genesis", "", "prev"],
    ])),
    "folder-genesis",
  );
  assert.equal(
    folderTraceIdentityFromNode(event("file-head", [["z", "file"]])),
    null,
  );
});

test("active to Oblivion retains the active relay coordinate", () => {
  assert.deepEqual(
    pendingMoveForPath("draft.md", "oblivion/stamp/draft.md"),
    { kind: "to-oblivion", fromPath: "draft.md" },
  );
});

test("rapid restore before Oblivion sync remains one move from the original path", () => {
  assert.deepEqual(
    pendingMoveForPath(
      "oblivion/stamp/draft.md",
      "restored/draft.md",
      { kind: "to-oblivion", fromPath: "draft.md" },
    ),
    { kind: "move", fromPath: "draft.md" },
  );
});

test("restore after a completed move to Oblivion extends from its local copy", () => {
  assert.deepEqual(
    pendingMoveForPath("oblivion/stamp/draft.md", "restored/draft.md"),
    { kind: "restore", fromPath: "oblivion/stamp/draft.md" },
  );
});

test("several active moves retain the first relay coordinate", () => {
  assert.deepEqual(
    pendingMoveForPath("notes/draft.md", "final/draft.md", {
      kind: "move",
      fromPath: "draft.md",
    }),
    { kind: "move", fromPath: "draft.md" },
  );
});

test("an explicit write returns the newly published checkpoint", async () => {
  let retried = false;
  const nodeId = await completeStagedWrite(
    async () => "new-node-id",
    () => {
      retried = true;
    },
  );

  assert.equal(nodeId, "new-node-id");
  assert.equal(retried, false);
});

test("a failed explicit write is surfaced and scheduled for retry", async () => {
  const failure = new Error("relay unavailable");
  let retries = 0;

  await assert.rejects(
    completeStagedWrite(
      async () => {
        throw failure;
      },
      () => {
        retries++;
      },
    ),
    failure,
  );
  assert.equal(retries, 1);
});

test("an unavailable prior Step reports the broken history instead of reading event.tags", () => {
  assert.throws(
    () => previousStepCitationTargets("notes/draft.md", "prior-node", []),
    /cannot load the previous Step for notes\/draft\.md at prior-node/,
  );
});

test("a scheduled first publish reports its persisted head to the UI", async () => {
  const order: string[] = [];
  const file = { runs: [], nodeId: "first-node", tags: [] };
  const nodeId = await completeBackgroundPush(
    async () => {
      order.push("publish");
      return "first-node";
    },
    () => {
      order.push("read");
      return file;
    },
    (persisted) => {
      order.push(`notify:${persisted?.nodeId}`);
    },
  );

  assert.equal(nodeId, "first-node");
  assert.deepEqual(order, ["publish", "read", "notify:first-node"]);
});

test("starter bootstrap persists an empty genesis before the body Step", async () => {
  const order: string[] = [];
  const genesis = await publishEmptyGenesisIfNeeded(
    true,
    null,
    async () => {
      order.push("publish-empty");
      return { id: "genesis" };
    },
    (node) => order.push(`persist:${node.id}`),
  );

  assert.equal(genesis?.id, "genesis");
  assert.deepEqual(order, ["publish-empty", "persist:genesis"]);
});

test("starter bootstrap resumes from an existing empty genesis", async () => {
  let publishes = 0;
  const genesis = await publishEmptyGenesisIfNeeded(
    true,
    "genesis",
    async () => {
      publishes++;
      return { id: "sibling" };
    },
    () => {},
  );

  assert.equal(genesis, null);
  assert.equal(publishes, 0);
});

test("starter bootstrap reuses a body Step whose manifest update failed", () => {
  assert.equal(
    completedEmptyGenesisBootstrapHead(
      true,
      null,
      [{ id: "genesis" }, { id: "body-step" }],
      "ayoooo, world!\n\n",
      "ayoooo, world!\n\n",
    ),
    "body-step",
  );
  assert.equal(
    completedEmptyGenesisBootstrapHead(
      true,
      null,
      [{ id: "genesis" }, { id: "old-body" }],
      "old",
      "new edit",
    ),
    null,
  );
});

test("deletion removes local copies only after every tombstone lands", async () => {
  const order: string[] = [];
  await completeDeletion(
    ["a.md", "b.md"],
    async (path) => {
      order.push(`remote:${path}`);
    },
    (path) => {
      order.push(`local:${path}`);
    },
  );

  assert.deepEqual(order.slice(0, 2).sort(), ["remote:a.md", "remote:b.md"]);
  assert.deepEqual(order.slice(2), ["local:a.md", "local:b.md"]);
});

test("failed tombstones leave local copies intact for retry", async () => {
  const deleted: string[] = [];
  await assert.rejects(
    completeDeletion(
      ["a.md"],
      async () => {
        throw new Error("relay unavailable");
      },
      (path) => deleted.push(path),
    ),
    /relay unavailable/,
  );
  assert.deepEqual(deleted, []);
});

test("ownership disposition distinguishes owned, foreign, and unverifiable nodes", () => {
  assert.equal(ownershipDisposition("alice", "alice"), "owned");
  assert.equal(ownershipDisposition("bob", "alice"), "foreign");
  assert.equal(ownershipDisposition(null, "alice"), "unverifiable");
});

test("folder membership keeps using a different locally held keychain owner", () => {
  localStorage.clear();
  const keys = loadKeys();
  const folderOwner = keys[0]!;
  const fileOwner = keys[1]!;
  const fileSigner = localFileSigner(fileOwner.pubkey);

  assert.ok(fileSigner);
  const signer = folderWriteSigner(folderOwner.pubkey, fileSigner);
  assert.ok(signer);
  assert.equal(getPublicKey(signer), folderOwner.pubkey);
});

test("a genuinely foreign folder still fails closed", () => {
  localStorage.clear();
  const fileSigner = localFileSigner(authorVoice());
  const foreignOwner = getPublicKey(generateSecretKey());

  assert.ok(fileSigner);
  assert.equal(folderWriteSigner(foreignOwner, fileSigner), null);
});

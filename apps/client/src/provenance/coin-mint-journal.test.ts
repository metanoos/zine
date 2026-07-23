import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { finalizeEvent } from "nostr-tools/pure";

import {
  activateVaultStorage,
  deactivateVaultStorage,
  fenceVaultStorageSession,
} from "../storage/vault-storage.js";

import {
  coinMintOperationKey,
  completePendingCoinMint,
  createCoinMintRecoverySessionRegistry,
  createCoinMintSourceReservationRegistry,
  finalizedCoinMintSourceText,
  finalizedCoinMintSourceStepEditorTransactions,
  pendingCoinMints,
  pendingCoinMint,
  pendingCoinMintBlockingSourceMutation,
  preparePendingCoinMint,
  rebasedFinalizedCoinMintSourceText,
  resolvedFinalizedCoinMintSourceText,
  rebaseFinalizedCoinMintSourceFile,
  retryCoinMintRecovery,
  resumePendingCoinMints,
} from "./coin-mint-journal.js";
import { resolvedBracketMarkup } from "./brackets.js";
import {
  applyEditorTransaction,
  editorTransactionLogFromArray,
  editorTransactionLogToArray,
  flattenRuns,
  validateEditorTransactionTransition,
} from "../workspace/workspace-core.js";
import type { EditorTransaction } from "@zine/protocol";

const SECRET = Uint8Array.from([...new Uint8Array(31), 1]);
const VAULT_KEY_A = new Uint8Array(32).fill(0x51);
const VAULT_KEY_B = new Uint8Array(32).fill(0x52);
const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");

function transaction(
  sequence: number,
  timestamp: number,
  actor: string,
  from: number,
  to: number,
  text: string,
  intent?: "undo" | "redo",
): EditorTransaction {
  return {
    sequence,
    timestamp,
    actor,
    changes: [{
      op: from === to ? "insert" : text === "" ? "delete" : "replace",
      from,
      to,
      text,
    }],
    selectionBefore: null,
    selectionAfter: null,
    ...(intent ? { intent } : {}),
  };
}

test("StrictMode replay reuses recovery while a real opt-out aborts it", async () => {
  const registry = createCoinMintRecoverySessionRegistry();
  let starts = 0;
  let finish!: () => void;
  const first = registry.acquire("strict-session", async () => {
    starts++;
    await new Promise<void>((resolve) => { finish = resolve; });
  });
  first.release();
  const replay = registry.acquire("strict-session", async () => {
    starts++;
  });
  await Promise.resolve();
  assert.equal(starts, 1);
  assert.equal(replay.signal.aborted, false);
  finish();
  await replay.promise;
  replay.release();

  const disabled = registry.acquire("disabled-session", async (signal) => {
    await new Promise<void>((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener("abort", () => resolve(), { once: true });
    });
  });
  disabled.release();
  await disabled.promise;
  assert.equal(disabled.signal.aborted, true);
  assert.equal(disabled.signal.reason?.name, "AbortError");

  let restartCount = 0;
  const initiallyEmpty = registry.acquire("restartable-session", async () => {
    restartCount++;
  });
  await initiallyEmpty.promise;
  initiallyEmpty.release();
  const laterWork = registry.acquire("restartable-session", async () => {
    restartCount++;
  });
  await laterWork.promise;
  laterWork.release();
  assert.equal(restartCount, 2, "a settled empty pass must not suppress later foreground work");
});

test("failed Mint recovery retries with bounded exponential backoff until empty", async () => {
  const controller = new AbortController();
  const delays: number[] = [];
  let attempts = 0;
  await retryCoinMintRecovery(
    async () => ({ remaining: ++attempts < 3 ? 1 : 0 }),
    async (delayMs) => { delays.push(delayMs); },
    controller.signal,
  );
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [5_000, 10_000]);
});

test("aborting a Mint recovery wait prevents another vault-scoped attempt", async () => {
  const controller = new AbortController();
  let attempts = 0;
  await retryCoinMintRecovery(
    async () => ({ remaining: ++attempts }),
    async (_delayMs, signal) => {
      controller.abort(new Error("vault changed"));
      throw signal.reason;
    },
    controller.signal,
  );
  assert.equal(attempts, 1);
});

class FakeStorage implements Storage {
  private values = new Map<string, string>();

  get length(): number { return this.values.size; }
  clear(): void { this.values.clear(); }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string): void { this.values.delete(key); }
  setItem(key: string, value: string): void { this.values.set(key, String(value)); }
}

function installLocalStorage(value: Storage): void {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value,
    writable: true,
  });
}

afterEach(() => {
  deactivateVaultStorage();
  if (originalLocalStorage) {
    Object.defineProperty(globalThis, "localStorage", originalLocalStorage);
  } else {
    Reflect.deleteProperty(globalThis, "localStorage");
  }
});

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    values,
  };
}

function coin(createdAt: number) {
  return finalizeEvent({
    kind: 4290,
    created_at: createdAt,
    tags: [["z", "file"], ["x", "a".repeat(64)]],
    content: JSON.stringify({
      snapshot: "coin",
      coin: { version: 1, origin: { kind: "direct" } },
    }),
  }, SECRET);
}

function pendingContents(createdAt: number, phrase = `coin-${createdAt}`) {
  return {
    sourceFolderId: "source",
    mintFolderId: "mint",
    localPath: `mint/${phrase}.md`,
    memberName: `${phrase}.md`,
    phrase,
    coin: coin(createdAt),
  };
}

async function completeTwoSourceBrackets(order: "earlier-first" | "later-first") {
  const store = storage();
  let sourceText = "[[ alpha ]] middle [[ omega ]]";
  const sourceNodeId = "b".repeat(64);
  const sourceContentHash = "c".repeat(64);
  const makePending = async (operationKey: string, phrase: string, createdAt: number) => {
    const bracket = `[[ ${phrase} ]]`;
    const matchStart = sourceText.indexOf(bracket);
    const phraseStart = matchStart + "[[ ".length;
    return preparePendingCoinMint(operationKey, async () => ({
      sourceFolderId: "source",
      mintFolderId: "mint",
      localPath: `Mint/${phrase}.md`,
      memberName: `${phrase}.md`,
      phrase,
      coin: coin(createdAt),
      sourceFinalization: {
        kind: "pending-bracket" as const,
        relativePath: "source.md",
        sourceNodeId,
        sourceContentHash,
        range: { start: phraseStart, end: phraseStart + phrase.length },
        bracketRange: { start: matchStart, end: matchStart + bracket.length },
      },
    }), store, createdAt);
  };
  const earlier = await makePending("earlier", "alpha", 20_001);
  const later = await makePending("later", "omega", 20_002);
  const published: string[] = [];
  const complete = (pending: typeof earlier) => completePendingCoinMint(pending, {
    publishPair: async (event) => {
      published.push(event.id);
      return event.id;
    },
    finalizeSource: async (record) => {
      sourceText = finalizedCoinMintSourceText(record, sourceText);
      return record.coin.id;
    },
    persistMembership: async () => undefined,
    persistLocal: () => undefined,
  }, store);
  const ordered = order === "earlier-first" ? [earlier, later] : [later, earlier];
  await Promise.all(ordered.map(complete));
  return { store, sourceText, published, earlier, later };
}

test("Mint resumes the exact signed pair after post-public and post-membership failures", async () => {
  const store = storage();
  const signedCoin = coin(1);
  const key = coinMintOperationKey({
    sourceFolderId: "source",
    signerPubkey: signedCoin.pubkey,
    phrase: "coin",
    origin: { kind: "direct" },
  });
  let creates = 0;
  const create = async () => {
    creates++;
    return {
      sourceFolderId: "source",
      mintFolderId: "mint",
      localPath: "mint/coin.md",
      memberName: "coin.md",
      phrase: "coin",
      coin: signedCoin,
    };
  };

  const first = await preparePendingCoinMint(key, create, store, 10);
  await assert.rejects(
    completePendingCoinMint(first, {
      publishPair: async (event) => ({ eventId: event.id }),
      persistMembership: async () => {
        throw new Error("manifest unavailable");
      },
      persistLocal: () => undefined,
    }, store),
    /manifest unavailable/,
  );
  assert.equal(pendingCoinMint(key, store)?.coin.id, signedCoin.id);

  const second = await preparePendingCoinMint(key, create, store, 20);
  assert.equal(second.coin.id, signedCoin.id);
  assert.equal(creates, 1);
  await assert.rejects(
    completePendingCoinMint(second, {
      publishPair: async (event) => ({ eventId: event.id }),
      persistMembership: async () => undefined,
      persistLocal: () => {
        throw new Error("local inventory unavailable");
      },
    }, store),
    /local inventory unavailable/,
  );
  assert.equal(pendingCoinMint(key, store)?.coin.id, signedCoin.id);

  const third = await preparePendingCoinMint(key, create, store, 30);
  const receipt = await completePendingCoinMint(third, {
    publishPair: async (event) => ({ eventId: event.id }),
    persistMembership: async () => undefined,
    persistLocal: () => undefined,
  }, store);
  assert.deepEqual(receipt, { attestation: { eventId: signedCoin.id } });
  assert.equal(pendingCoinMint(key, store), null);
  assert.equal(creates, 1);
});

test("extracted Mint stays journaled until its exact source citation Step succeeds", async () => {
  const store = storage();
  const signedCoin = coin(2);
  const sourceText = "before [[ cited phrase ]] after";
  const phraseStart = sourceText.indexOf("cited phrase");
  const pending = await preparePendingCoinMint("source-finalization", async () => ({
    sourceFolderId: "source",
    mintFolderId: "mint",
    localPath: "Mint/cited-phrase.md",
    memberName: "cited-phrase.md",
    phrase: "cited phrase",
    coin: signedCoin,
    sourceFinalization: {
      kind: "pending-bracket" as const,
      relativePath: "source.md",
      sourceNodeId: "b".repeat(64),
      sourceContentHash: "c".repeat(64),
      range: { start: phraseStart, end: phraseStart + "cited phrase".length },
      bracketRange: {
        start: sourceText.indexOf("[["),
        end: sourceText.indexOf("[[") + "[[ cited phrase ]]".length,
      },
    },
  }), store, 1);
  const phases: string[] = [];

  await assert.rejects(
    completePendingCoinMint(pending, {
      publishPair: async () => {
        phases.push("pair");
        return "attestation";
      },
      persistMembership: async () => { phases.push("membership"); },
      persistLocal: () => { phases.push("local"); },
      finalizeSource: async () => {
        phases.push("source");
        throw new Error("source Step unavailable");
      },
    }, store),
    /source Step unavailable/,
  );
  assert.equal(pendingCoinMint("source-finalization", store)?.coin.id, signedCoin.id);
  assert.deepEqual(
    phases,
    ["pair", "source"],
    "an extracted Coin must not enter membership or local inventory before its source Step",
  );

  let steppedSource = "";
  await assert.rejects(completePendingCoinMint(pending, {
    publishPair: async () => {
      phases.push("pair-retry");
      return "attestation";
    },
    persistMembership: async () => {
      phases.push("membership-retry");
      throw new Error("membership retry unavailable");
    },
    persistLocal: () => { phases.push("local-must-wait"); },
    finalizeSource: async (record) => {
      steppedSource = finalizedCoinMintSourceText(record, sourceText);
      phases.push("source-retry");
      return "2".repeat(64);
    },
  }, store), /membership retry unavailable/);

  assert.match(steppedSource, new RegExp(`\\[\\[ cited phrase \\| ${signedCoin.id} \\]\\]`));
  assert.equal(
    pendingCoinMint("source-finalization", store)?.sourceFinalization?.completedNodeId,
    "2".repeat(64),
  );
  await completePendingCoinMint(pending, {
    publishPair: async () => {
      phases.push("pair-final");
      return "attestation";
    },
    persistMembership: async () => { phases.push("membership-final"); },
    persistLocal: () => { phases.push("local-final"); },
    finalizeSource: async () => {
      phases.push("source-must-not-repeat");
      throw new Error("durable source phase was not skipped");
    },
  }, store);
  assert.deepEqual(phases, [
    "pair",
    "source",
    "pair-retry",
    "source-retry",
    "membership-retry",
    "pair-final",
    "membership-final",
    "local-final",
  ]);
  assert.equal(pendingCoinMint("source-finalization", store), null);
});

test("a durable public-pair receipt prevents network republication after source failure", async () => {
  const store = storage();
  const pending = await preparePendingCoinMint("durable-public-pair", async () => ({
    sourceFolderId: "source",
    mintFolderId: "mint",
    localPath: "Mint/durable.md",
    memberName: "durable.md",
    phrase: "durable",
    coin: coin(2_100),
    sourceFinalization: {
      kind: "span" as const,
      relativePath: "source.md",
      sourceNodeId: "1".repeat(64),
      sourceContentHash: "2".repeat(64),
      range: { start: 0, end: 7 },
    },
  }), store, 1);
  let publications = 0;
  const completion = (failSource: boolean) => ({
    publishPair: async () => {
      publications++;
      return "published-attestation";
    },
    serializeAttestation: (value: string) => value,
    restoreAttestation: (value: unknown) =>
      value === "published-attestation" ? value : null,
    finalizeSource: async () => {
      if (failSource) throw new Error("source is temporarily unavailable");
      return "3".repeat(64);
    },
    persistMembership: async () => undefined,
    persistLocal: () => undefined,
  });

  await assert.rejects(
    completePendingCoinMint(pending, completion(true), store),
    /source is temporarily unavailable/,
  );
  assert.equal(
    pendingCoinMint("durable-public-pair", store)?.publishedAttestation,
    "published-attestation",
  );
  assert.equal(
    pendingCoinMintBlockingSourceMutation("source", "source.md", false, store)?.operationKey,
    "durable-public-pair",
    "a public pair must keep its exact unfinished source path mutation-locked",
  );
  assert.equal(
    pendingCoinMintBlockingSourceMutation("source", "", true, store)?.operationKey,
    "durable-public-pair",
    "moving a containing folder must not strand source finalization",
  );
  assert.equal(
    pendingCoinMintBlockingSourceMutation("source", "sibling.md", false, store),
    null,
  );
  assert.equal(
    pendingCoinMintBlockingSourceMutation("another-root", "source.md", false, store),
    null,
  );

  const receipt = await completePendingCoinMint(pending, completion(false), store);
  assert.equal(publications, 1, "source retries must reuse the durable public pair");
  assert.deepEqual(receipt, {
    attestation: "published-attestation",
    sourceNodeId: "3".repeat(64),
  });
  assert.equal(
    pendingCoinMintBlockingSourceMutation("source", "source.md", false, store),
    null,
    "the source path unlocks after the durable transaction clears",
  );
});

test("source finalization is idempotent only at its recorded bracket target", async () => {
  const store = storage();
  const pending = await preparePendingCoinMint("rewrite", async () => ({
    sourceFolderId: "source",
    mintFolderId: "mint",
    localPath: "Mint/phrase.md",
    memberName: "phrase.md",
    phrase: "phrase",
    coin: coin(3),
    sourceFinalization: {
      kind: "pending-bracket" as const,
      relativePath: "source.md",
      sourceNodeId: "d".repeat(64),
      sourceContentHash: "e".repeat(64),
      range: { start: 3, end: 9 },
      bracketRange: { start: 0, end: "[[ phrase ]]".length },
    },
  }), store, 1);
  const rewritten = finalizedCoinMintSourceText(pending, "[[ phrase ]]");
  assert.equal(finalizedCoinMintSourceText(pending, rewritten), rewritten);
  const resolvedElsewhere = `[[ phrase ]] and [[ phrase | ${pending.coin.id} ]]`;
  assert.equal(
    finalizedCoinMintSourceText(pending, resolvedElsewhere),
    `[[ phrase | ${pending.coin.id} ]] and [[ phrase | ${pending.coin.id} ]]`,
  );
});

test("an in-flight extracted Mint reserves its source before a journal row exists", () => {
  const reservations = createCoinMintSourceReservationRegistry();
  const releaseFirst = reservations.reserve("source", "notes/source.md");
  const releaseSecond = reservations.reserve("source", "notes/source.md");

  assert.equal(reservations.blocks("source", "notes/source.md", false), true);
  assert.equal(reservations.blocks("source", "notes", true), true);
  assert.equal(reservations.blocks("source", "sibling.md", false), false);
  assert.equal(reservations.blocks("another-root", "notes", true), false);

  releaseFirst();
  assert.equal(
    reservations.blocks("source", "notes/source.md", false),
    true,
    "one completed gesture must not release another gesture's reservation",
  );
  releaseSecond();
  assert.equal(reservations.blocks("source", "notes/source.md", false), false);
});

test("a delayed source citation Step preserves and rebases newer editor text", async () => {
  const store = storage();
  const pending = await preparePendingCoinMint("delayed-source-step", async () => ({
    sourceFolderId: "source",
    mintFolderId: "mint",
    localPath: "Mint/phrase.md",
    memberName: "phrase.md",
    phrase: "phrase",
    coin: coin(31),
    sourceFinalization: {
      kind: "pending-bracket" as const,
      relativePath: "source.md",
      sourceNodeId: "d".repeat(64),
      sourceContentHash: "e".repeat(64),
      range: { start: 3, end: 9 },
      bracketRange: { start: 0, end: "[[ phrase ]]".length },
    },
  }), store, 1);
  const steppedText = finalizedCoinMintSourceText(pending, "[[ phrase ]]");
  const concurrentVoice = "b".repeat(64);
  const prefix = "typed before ";
  const suffix = " typed after";
  const concurrentTransactions = [
    transaction(7, 1_001, concurrentVoice, 0, 0, prefix),
    transaction(
      8,
      1_002,
      concurrentVoice,
      prefix.length + "[[ phrase ]]".length,
      prefix.length + "[[ phrase ]]".length,
      suffix,
      "redo",
    ),
  ];
  const rebased = rebaseFinalizedCoinMintSourceFile(
    pending,
    {
      runs: [
        { voice: concurrentVoice, text: prefix },
        { voice: pending.coin.pubkey, text: "[[ phrase ]]" },
        { voice: concurrentVoice, text: suffix },
      ],
      nodeId: pending.sourceFinalization!.sourceNodeId,
      tags: ["draft"],
      citationIds: ["c".repeat(64)],
    },
    "[[ phrase ]]",
    steppedText,
    "f".repeat(64),
    pending.coin.pubkey,
    concurrentTransactions,
  );
  const expected = `${prefix}${steppedText}${suffix}`;
  assert.equal(flattenRuns(rebased.runs), expected);
  assert.equal(rebased.nodeId, "f".repeat(64));
  assert.deepEqual(rebased.tags, ["draft"]);
  assert.deepEqual(rebased.citationIds, ["c".repeat(64)]);
  assert.deepEqual(editorTransactionLogToArray(rebased.editorTransactions), [
    concurrentTransactions[0],
    {
      ...concurrentTransactions[1],
      changes: [{
        ...concurrentTransactions[1]!.changes[0],
        from: prefix.length + steppedText.length,
        to: prefix.length + steppedText.length,
      }],
    },
  ]);
  const replayed = editorTransactionLogToArray(
    rebased.editorTransactions,
  ).reduce(
    (runs, editorTransaction) => applyEditorTransaction(runs, editorTransaction),
    [{ voice: pending.coin.pubkey, text: steppedText }],
  );
  assert.equal(
    flattenRuns(replayed),
    expected,
  );
});

test("source recovery Steps preserve pending EditorTransaction metadata before the citation transaction", async () => {
  const store = storage();
  const pending = await preparePendingCoinMint("recovery-editor-transactions", async () => ({
    sourceFolderId: "source",
    mintFolderId: "mint",
    localPath: "Mint/phrase.md",
    memberName: "phrase.md",
    phrase: "phrase",
    coin: coin(32),
    sourceFinalization: {
      kind: "pending-bracket" as const,
      relativePath: "source.md",
      sourceNodeId: "d".repeat(64),
      sourceContentHash: "e".repeat(64),
      range: { start: 10, end: 16 },
      bracketRange: { start: 7, end: 19 },
    },
  }), store, 1);
  const priorText = "before [[ phrase ]]";
  const currentText = "typed before [[ phrase ]]";
  const captured = [
    transaction(
      9,
      5_001,
      "b".repeat(64),
      0,
      "before".length,
      "typed before",
      "redo",
    ),
  ];
  const finalizedText = rebasedFinalizedCoinMintSourceText(
    pending,
    priorText,
    currentText,
  );
  const composed = finalizedCoinMintSourceStepEditorTransactions(
    currentText,
    finalizedText,
    editorTransactionLogFromArray(captured),
    pending.coin.pubkey,
    5_002,
  );

  assert.deepEqual(composed[0], captured[0]);
  assert.equal(composed[1]?.sequence, 10);
  assert.equal(composed[1]?.timestamp, 5_002);
  assert.equal(composed[1]?.actor, pending.coin.pubkey);
  assert.equal(
    validateEditorTransactionTransition(priorText, finalizedText, composed).valid,
    true,
  );
});

test("headless span finalization replaces only its recorded UTF-16 source range", async () => {
  const store = storage();
  const pending = await preparePendingCoinMint("span-rewrite", async () => ({
    sourceFolderId: "source",
    mintFolderId: "mint",
    localPath: "Mint/public.md",
    memberName: "public.md",
    phrase: "selected public",
    coin: coin(4),
    sourceFinalization: {
      kind: "span" as const,
      relativePath: "source.md",
      sourceNodeId: "f".repeat(64),
      sourceContentHash: "1".repeat(64),
      range: { start: 0, end: "selected public".length },
    },
  }), store, 1);
  const rewritten = finalizedCoinMintSourceText(pending, "selected public handoff");
  assert.equal(
    rewritten,
    `[[ selected public | ${pending.coin.id} ]] handoff`,
  );
  assert.equal(finalizedCoinMintSourceText(pending, rewritten), rewritten);
  assert.throws(
    () => finalizedCoinMintSourceText(pending, "changed public handoff"),
    /selected span no longer matches/,
  );
});

test("same-source Mints rebase a later range after the earlier citation resolves", async () => {
  const { store, sourceText, published, earlier, later } =
    await completeTwoSourceBrackets("earlier-first");

  assert.equal(
    sourceText,
    `${resolvedBracketMarkup("alpha", earlier.coin.id)} middle ` +
      resolvedBracketMarkup("omega", later.coin.id),
  );
  assert.deepEqual(published, [earlier.coin.id, later.coin.id]);
  assert.deepEqual(pendingCoinMints(store), []);
});

test("desktop finalize uses live space after an earlier same-source Mint rebases ranges", async () => {
  const store = storage();
  const captured = "[[ alpha ]] middle [[ omega ]]";
  let live = captured;
  const sourceNodeId = "b".repeat(64);
  const sourceContentHash = "c".repeat(64);
  const makePending = async (operationKey: string, phrase: string, createdAt: number) => {
    const bracket = `[[ ${phrase} ]]`;
    const matchStart = captured.indexOf(bracket);
    const phraseStart = matchStart + "[[ ".length;
    return preparePendingCoinMint(operationKey, async () => ({
      sourceFolderId: "source",
      mintFolderId: "mint",
      localPath: `Mint/${phrase}.md`,
      memberName: `${phrase}.md`,
      phrase,
      coin: coin(createdAt),
      sourceFinalization: {
        kind: "pending-bracket" as const,
        relativePath: "source.md",
        sourceNodeId,
        sourceContentHash,
        range: { start: phraseStart, end: phraseStart + phrase.length },
        bracketRange: { start: matchStart, end: matchStart + bracket.length },
      },
    }), store, createdAt);
  };
  const earlier = await makePending("earlier", "alpha", 20_101);
  const later = await makePending("later", "omega", 20_102);

  await completePendingCoinMint(earlier, {
    publishPair: async (event) => event.id,
    finalizeSource: async (record) => {
      live = finalizedCoinMintSourceText(record, live);
      return record.coin.id;
    },
    persistMembership: async () => undefined,
    persistLocal: () => undefined,
  }, store);

  const rebasedLater = pendingCoinMint("later", store);
  assert.ok(rebasedLater?.sourceFinalization);
  assert.throws(
    () => rebasedFinalizedCoinMintSourceText(rebasedLater!, captured, live),
    /pending bracket is missing/,
  );
  assert.equal(
    resolvedFinalizedCoinMintSourceText(rebasedLater!, captured, live),
    `${resolvedBracketMarkup("alpha", earlier.coin.id)} middle ` +
      resolvedBracketMarkup("omega", later.coin.id),
  );
});

test("same-source Mints preserve an earlier range after the later citation resolves", async () => {
  const { store, sourceText, published, earlier, later } =
    await completeTwoSourceBrackets("later-first");

  assert.equal(
    sourceText,
    `${resolvedBracketMarkup("alpha", earlier.coin.id)} middle ` +
      resolvedBracketMarkup("omega", later.coin.id),
  );
  assert.deepEqual(published, [later.coin.id, earlier.coin.id]);
  assert.deepEqual(pendingCoinMints(store), []);
});

test("a later overlapping same-source Mint is rejected before either pair is published", async () => {
  const store = storage();
  const makePending = (
    operationKey: string,
    phrase: string,
    range: { start: number; end: number },
    createdAt: number,
  ) => preparePendingCoinMint(operationKey, async () => ({
    sourceFolderId: "source",
    mintFolderId: "mint",
    localPath: `Mint/${operationKey}.md`,
    memberName: `${operationKey}.md`,
    phrase,
    coin: coin(createdAt),
    sourceFinalization: {
      kind: "span" as const,
      relativePath: "source.md",
      sourceNodeId: "d".repeat(64),
      sourceContentHash: "e".repeat(64),
      range,
    },
  }), store, createdAt);
  const first = await makePending("first-overlap", "bcd", { start: 1, end: 4 }, 21_001);
  await assert.rejects(
    makePending("second-overlap", "de", { start: 3, end: 5 }, 21_002),
    /overlaps another pending Mint/,
  );
  let published = false;
  let finalized = false;

  const receipt = await completePendingCoinMint(first, {
    publishPair: async () => {
      published = true;
      return "attestation";
    },
    finalizeSource: async () => {
      finalized = true;
      return "f".repeat(64);
    },
    persistMembership: async () => undefined,
    persistLocal: () => undefined,
  }, store);

  assert.deepEqual(receipt, { attestation: "attestation", sourceNodeId: "f".repeat(64) });
  assert.equal(published, true);
  assert.equal(finalized, true);
  assert.equal(pendingCoinMints(store).length, 0);
});

test("legacy overlapping records deterministically keep only the oldest unpublished gesture", async () => {
  const store = storage();
  const base = {
    sourceFolderId: "source",
    mintFolderId: "mint",
    relativePath: "source.md",
    sourceNodeId: "7".repeat(64),
    sourceContentHash: "8".repeat(64),
  };
  const older = {
    operationKey: "older-overlap",
    sourceFolderId: base.sourceFolderId,
    mintFolderId: base.mintFolderId,
    localPath: "Mint/older.md",
    memberName: "older.md",
    phrase: "abc",
    coin: coin(21_100),
    sourceFinalization: {
      kind: "span" as const,
      relativePath: base.relativePath,
      sourceNodeId: base.sourceNodeId,
      sourceContentHash: base.sourceContentHash,
      range: { start: 0, end: 3 },
    },
    queuedAt: 1,
  };
  const newer = {
    ...older,
    operationKey: "newer-overlap",
    localPath: "Mint/newer.md",
    memberName: "newer.md",
    phrase: "bc",
    coin: coin(21_101),
    sourceFinalization: { ...older.sourceFinalization, range: { start: 1, end: 3 } },
    queuedAt: 2,
  };
  store.values.set("zine.pending-coin-mints.v1", JSON.stringify([older, newer]));
  let newerPublished = false;
  await assert.rejects(completePendingCoinMint(newer, {
    publishPair: async () => {
      newerPublished = true;
      return "newer-attestation";
    },
    finalizeSource: async () => "9".repeat(64),
    persistMembership: async () => undefined,
    persistLocal: () => undefined,
  }, store), /earlier pending Mint overlaps/);
  assert.equal(newerPublished, false);

  let sourceText = "abcdef";
  const receipt = await completePendingCoinMint(older, {
    publishPair: async () => "older-attestation",
    finalizeSource: async (record) => {
      sourceText = finalizedCoinMintSourceText(record, sourceText);
      return "a".repeat(64);
    },
    persistMembership: async () => undefined,
    persistLocal: () => undefined,
  }, store);
  assert.deepEqual(receipt, {
    attestation: "older-attestation",
    sourceNodeId: "a".repeat(64),
  });
  assert.equal(sourceText, `${resolvedBracketMarkup("abc", older.coin.id)}def`);
  assert.deepEqual(pendingCoinMints(store), []);
});

test("a durable source reservation rejects an overlapping prepare during publication", async () => {
  const store = storage();
  const first = await preparePendingCoinMint("reserved-first", async () => ({
    sourceFolderId: "source",
    mintFolderId: "mint",
    localPath: "Mint/ab.md",
    memberName: "ab.md",
    phrase: "ab",
    coin: coin(22_001),
    sourceFinalization: {
      kind: "span" as const,
      relativePath: "source.md",
      sourceNodeId: "1".repeat(64),
      sourceContentHash: "2".repeat(64),
      range: { start: 0, end: 2 },
    },
  }), store, 1);
  let releasePublish!: () => void;
  const publishGate = new Promise<void>((resolve) => { releasePublish = resolve; });
  let publicationStarted!: () => void;
  const started = new Promise<void>((resolve) => { publicationStarted = resolve; });
  let sourceText = "abcdef";
  const completing = completePendingCoinMint(first, {
    publishPair: async () => {
      publicationStarted();
      await publishGate;
      return "attestation";
    },
    finalizeSource: async (record) => {
      sourceText = finalizedCoinMintSourceText(record, sourceText);
      return "3".repeat(64);
    },
    persistMembership: async () => undefined,
    persistLocal: () => undefined,
  }, store);
  await started;
  assert.equal(
    pendingCoinMint("reserved-first", store)?.sourceFinalization?.publicationReserved,
    true,
  );

  await assert.rejects(preparePendingCoinMint("reserved-overlap", async () => ({
    sourceFolderId: "source",
    mintFolderId: "mint",
    localPath: "Mint/bc.md",
    memberName: "bc.md",
    phrase: "bc",
    coin: coin(22_002),
    sourceFinalization: {
      kind: "span" as const,
      relativePath: "source.md",
      sourceNodeId: "1".repeat(64),
      sourceContentHash: "2".repeat(64),
      range: { start: 1, end: 3 },
    },
  }), store, 2), /overlaps another pending Mint/);
  assert.equal(pendingCoinMint("reserved-overlap", store), null);

  releasePublish();
  assert.deepEqual(await completing, {
    attestation: "attestation",
    sourceNodeId: "3".repeat(64),
  });
  assert.equal(sourceText, `${resolvedBracketMarkup("ab", first.coin.id)}cdef`);
  assert.deepEqual(pendingCoinMints(store), []);
});

test("Mint journal rejects corrupt data instead of creating a sibling pair", async () => {
  const store = storage();
  store.values.set("zine.pending-coin-mints.v1", "not-json");
  await assert.rejects(
    preparePendingCoinMint("operation", async () => {
      throw new Error("must not create");
    }, store),
    /corrupt JSON/,
  );
});

test("concurrent preparation cannot create sibling Coin events for one gesture", async () => {
  const store = storage();
  const key = "same-gesture";
  let creates = 0;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const create = async () => {
    creates++;
    await blocked;
    return {
      sourceFolderId: "source",
      mintFolderId: "mint",
      localPath: "mint/coin.md",
      memberName: "coin.md",
      phrase: "coin",
      coin: coin(creates),
    };
  };
  const first = preparePendingCoinMint(key, create, store, 10);
  const second = preparePendingCoinMint(key, create, store, 20);
  release();
  const [left, right] = await Promise.all([first, second]);
  assert.equal(left.coin.id, right.coin.id);
  assert.equal(creates, 1);
});

test("pending Mint records resume independently in vaults A and B", async () => {
  installLocalStorage(new FakeStorage());
  activateVaultStorage("vault-a", VAULT_KEY_A);
  const pendingA = await preparePendingCoinMint(
    "same-gesture",
    async () => pendingContents(100, "vault-a-coin"),
    undefined,
    10,
  );

  activateVaultStorage("vault-b", VAULT_KEY_B);
  assert.equal(pendingCoinMint("same-gesture"), null);
  const pendingB = await preparePendingCoinMint(
    "same-gesture",
    async () => pendingContents(200, "vault-b-coin"),
    undefined,
    20,
  );
  assert.notEqual(pendingA.coin.id, pendingB.coin.id);

  activateVaultStorage("vault-a", VAULT_KEY_A);
  assert.equal(pendingCoinMint("same-gesture")?.coin.id, pendingA.coin.id);
  let recreated = false;
  const resumedA = await preparePendingCoinMint("same-gesture", async () => {
    recreated = true;
    return pendingContents(300);
  });
  assert.equal(resumedA.coin.id, pendingA.coin.id);
  assert.equal(recreated, false);

  activateVaultStorage("vault-b", VAULT_KEY_B);
  assert.equal(pendingCoinMint("same-gesture")?.coin.id, pendingB.coin.id);
});

test("pending Mint capacity is enforced per vault", async () => {
  installLocalStorage(new FakeStorage());
  activateVaultStorage("vault-a", VAULT_KEY_A);

  for (let index = 0; index < 32; index++) {
    await preparePendingCoinMint(
      `vault-a-${index}`,
      async () => pendingContents(1_000 + index),
    );
  }
  await assert.rejects(
    preparePendingCoinMint("vault-a-over-capacity", async () => pendingContents(2_000)),
    /too many incomplete Mint gestures \(32\)/,
  );

  activateVaultStorage("vault-b", VAULT_KEY_B);
  const pendingB = await preparePendingCoinMint(
    "vault-b-first",
    async () => pendingContents(3_000),
  );
  assert.equal(pendingCoinMint("vault-b-first")?.coin.id, pendingB.coin.id);
});

test("the pre-lock fence rejects newly submitted Mint work", async () => {
  installLocalStorage(new FakeStorage());
  activateVaultStorage("vault-a", VAULT_KEY_A);
  const durable = await preparePendingCoinMint(
    "durable-before-fence",
    async () => pendingContents(3_500),
  );
  let created = false;
  let published = false;

  fenceVaultStorageSession();
  await assert.rejects(
    preparePendingCoinMint("after-fence", async () => {
      created = true;
      return pendingContents(3_501);
    }),
    /active vault changed/,
  );
  await assert.rejects(
    completePendingCoinMint(durable, {
      publishPair: async () => {
        published = true;
        return "attestation";
      },
      persistMembership: async () => undefined,
      persistLocal: () => undefined,
    }),
    /active vault changed/,
  );
  await assert.rejects(
    resumePendingCoinMints(() => ({
      publishPair: async () => "attestation",
      persistMembership: async () => undefined,
      persistLocal: () => undefined,
    })),
    /active vault changed/,
  );
  assert.equal(created, false);
  assert.equal(published, false);
  assert.equal(pendingCoinMint("durable-before-fence")?.coin.id, durable.coin.id);
});

test("a Mint created after vault A loses its lease is never journaled in vault B", async () => {
  installLocalStorage(new FakeStorage());
  activateVaultStorage("vault-a", VAULT_KEY_A);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let creationStarted!: () => void;
  const started = new Promise<void>((resolve) => { creationStarted = resolve; });

  const preparing = preparePendingCoinMint("delayed-vault-a", async () => {
    creationStarted();
    await gate;
    return pendingContents(4_000);
  });
  await started;
  const rejected = assert.rejects(preparing, /active vault changed/);
  activateVaultStorage("vault-b", VAULT_KEY_B);
  const pendingB = await preparePendingCoinMint(
    "vault-b-does-not-wait",
    async () => pendingContents(4_001),
  );
  release();
  await rejected;

  assert.equal(pendingCoinMint("delayed-vault-a"), null);
  assert.equal(pendingCoinMint("vault-b-does-not-wait")?.coin.id, pendingB.coin.id);
});

test("pending Mint recovery resumes every durable record without recreating Coins", async () => {
  const store = storage();
  const records = [coin(11), coin(12)];
  for (const [index, signedCoin] of records.entries()) {
    await preparePendingCoinMint(`operation-${index}`, async () => ({
      sourceFolderId: "source",
      mintFolderId: "mint",
      localPath: `mint/coin-${index}.md`,
      memberName: `coin-${index}.md`,
      phrase: "coin",
      coin: signedCoin,
    }), store, index);
  }
  const published: string[] = [];
  const result = await resumePendingCoinMints(
    () => ({
      publishPair: async (event) => {
        published.push(event.id);
        return event.id;
      },
      persistMembership: async () => undefined,
      persistLocal: () => undefined,
    }),
    store,
  );

  assert.deepEqual(published, records.map((event) => event.id));
  assert.deepEqual(result, { completed: 2, remaining: 0, failures: [] });
  assert.deepEqual(pendingCoinMints(store), []);
});

test("pending Mint recovery leaves a failed record available for the next pass", async () => {
  const store = storage();
  const signedCoin = coin(13);
  await preparePendingCoinMint("operation", async () => ({
    sourceFolderId: "source",
    mintFolderId: "mint",
    localPath: "mint/coin.md",
    memberName: "coin.md",
    phrase: "coin",
    coin: signedCoin,
  }), store, 1);

  const result = await resumePendingCoinMints(
    () => ({
      publishPair: async () => {
        throw new Error("offline");
      },
      persistMembership: async () => undefined,
      persistLocal: () => undefined,
    }),
    store,
  );

  assert.equal(result.completed, 0);
  assert.equal(result.remaining, 1);
  assert.match(result.failures[0]?.error ?? "", /offline/);
  assert.equal(pendingCoinMints(store)[0]?.coin.id, signedCoin.id);
});

test("journal-wide preparation enforces capacity across distinct concurrent gestures", async () => {
  const store = storage();
  for (let index = 0; index < 31; index++) {
    await preparePendingCoinMint(
      `existing-${index}`,
      async () => pendingContents(5_000 + index),
      store,
    );
  }
  let creates = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const first = preparePendingCoinMint("first-new", async () => {
    creates++;
    await gate;
    return pendingContents(6_000);
  }, store);
  const second = preparePendingCoinMint("second-new", async () => {
    creates++;
    return pendingContents(6_001);
  }, store);
  release();

  await first;
  await assert.rejects(second, /too many incomplete Mint gestures \(32\)/);
  assert.equal(creates, 1);
  assert.equal(pendingCoinMints(store).length, 32);
});

test("same-vault completion coalesces one public transaction", async () => {
  const store = storage();
  const pending = await preparePendingCoinMint(
    "coalesced",
    async () => pendingContents(7_000),
    store,
  );
  let publishes = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const completion = {
    publishPair: async () => {
      publishes++;
      await gate;
      return "attestation";
    },
    persistMembership: async () => undefined,
    persistLocal: () => undefined,
  };

  const first = completePendingCoinMint(pending, completion, store);
  const second = completePendingCoinMint(pending, completion, store);
  release();
  assert.deepEqual(await Promise.all([first, second]), [
    { attestation: "attestation" },
    { attestation: "attestation" },
  ]);
  assert.equal(publishes, 1);
  assert.equal(pendingCoinMint("coalesced", store), null);
});

test("coalesced extracted Mint callers share the completed source node receipt", async () => {
  const store = storage();
  const pending = await preparePendingCoinMint("coalesced-source", async () => ({
    sourceFolderId: "source",
    mintFolderId: "mint",
    localPath: "Mint/source.md",
    memberName: "source.md",
    phrase: "source",
    coin: coin(7_050),
    sourceFinalization: {
      kind: "span" as const,
      relativePath: "source.md",
      sourceNodeId: "b".repeat(64),
      sourceContentHash: "c".repeat(64),
      range: { start: 0, end: 6 },
    },
  }), store);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let firstFinalizations = 0;
  let secondCallbacks = 0;
  const first = completePendingCoinMint(pending, {
    publishPair: async () => {
      await gate;
      return "attestation";
    },
    finalizeSource: async () => {
      firstFinalizations++;
      return "d".repeat(64);
    },
    persistMembership: async () => undefined,
    persistLocal: () => undefined,
  }, store);
  const second = completePendingCoinMint(pending, {
    publishPair: async () => {
      secondCallbacks++;
      return "wrong-attestation";
    },
    finalizeSource: async () => {
      secondCallbacks++;
      return "e".repeat(64);
    },
    persistMembership: async () => { secondCallbacks++; },
    persistLocal: () => { secondCallbacks++; },
  }, store);
  release();
  const expected = { attestation: "attestation", sourceNodeId: "d".repeat(64) };
  assert.deepEqual(await Promise.all([first, second]), [expected, expected]);
  assert.equal(firstFinalizations, 1);
  assert.equal(secondCallbacks, 0);
});

test("different Mints in one folder serialize membership and journal cleanup", async () => {
  const store = storage();
  const firstPending = await preparePendingCoinMint(
    "first-folder-member",
    async () => pendingContents(7_100, "first"),
    store,
  );
  const secondPending = await preparePendingCoinMint(
    "second-folder-member",
    async () => pendingContents(7_101, "second"),
    store,
  );
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let firstMembershipStarted!: () => void;
  const firstMembership = new Promise<void>((resolve) => { firstMembershipStarted = resolve; });
  const phases: string[] = [];

  const first = completePendingCoinMint(firstPending, {
    publishPair: async () => {
      phases.push("first:publish");
      return "first-attestation";
    },
    persistMembership: async () => {
      phases.push("first:membership");
      firstMembershipStarted();
      await firstGate;
    },
    persistLocal: () => { phases.push("first:local"); },
  }, store);
  const second = completePendingCoinMint(secondPending, {
    publishPair: async () => {
      phases.push("second:publish");
      return "second-attestation";
    },
    persistMembership: async () => { phases.push("second:membership"); },
    persistLocal: () => { phases.push("second:local"); },
  }, store);

  await firstMembership;
  await Promise.resolve();
  assert.deepEqual(phases, ["first:publish", "first:membership"]);
  assert.equal(pendingCoinMints(store).length, 2);
  releaseFirst();
  assert.deepEqual(await Promise.all([first, second]), [
    { attestation: "first-attestation" },
    { attestation: "second-attestation" },
  ]);
  assert.deepEqual(phases, [
    "first:publish",
    "first:membership",
    "first:local",
    "second:publish",
    "second:membership",
    "second:local",
  ]);
  assert.deepEqual(pendingCoinMints(store), []);
});

test("vault B completion does not coalesce with an in-flight vault A gesture", async () => {
  installLocalStorage(new FakeStorage());
  activateVaultStorage("vault-a", VAULT_KEY_A);
  const pendingA = await preparePendingCoinMint(
    "same-operation",
    async () => pendingContents(8_000, "vault-a"),
  );
  let releaseA!: () => void;
  const gateA = new Promise<void>((resolve) => { releaseA = resolve; });
  let startedA!: () => void;
  const publishedA = new Promise<void>((resolve) => { startedA = resolve; });
  const completingA = completePendingCoinMint(pendingA, {
    publishPair: async () => {
      startedA();
      await gateA;
      return "attestation-a";
    },
    persistMembership: async () => undefined,
    persistLocal: () => undefined,
  });
  await publishedA;
  const rejectedA = assert.rejects(completingA, /active vault changed/);

  activateVaultStorage("vault-b", VAULT_KEY_B);
  const pendingB = await preparePendingCoinMint(
    "same-operation",
    async () => pendingContents(8_001, "vault-b"),
  );
  let publishesB = 0;
  const completedB = await completePendingCoinMint(pendingB, {
    publishPair: async () => {
      publishesB++;
      return "attestation-b";
    },
    persistMembership: async () => undefined,
    persistLocal: () => undefined,
  });
  assert.deepEqual(completedB, { attestation: "attestation-b" });
  assert.equal(publishesB, 1);
  assert.equal(pendingCoinMint("same-operation"), null);

  releaseA();
  await rejectedA;
  activateVaultStorage("vault-a", VAULT_KEY_A);
  assert.equal(pendingCoinMint("same-operation")?.coin.id, pendingA.coin.id);
});

test("recovery aborts on a vault switch without reading vault B as its remaining set", async () => {
  installLocalStorage(new FakeStorage());
  activateVaultStorage("vault-a", VAULT_KEY_A);
  await preparePendingCoinMint("vault-a-recovery", async () => pendingContents(9_000));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let started!: () => void;
  const published = new Promise<void>((resolve) => { started = resolve; });
  const recovery = resumePendingCoinMints(() => ({
    publishPair: async () => {
      started();
      await gate;
      return "attestation-a";
    },
    persistMembership: async () => undefined,
    persistLocal: () => undefined,
  }));
  await published;
  const rejected = assert.rejects(recovery, /active vault changed/);

  activateVaultStorage("vault-b", VAULT_KEY_B);
  const pendingB = await preparePendingCoinMint(
    "vault-b-pending",
    async () => pendingContents(9_001),
  );
  release();
  await rejected;

  assert.equal(pendingCoinMint("vault-b-pending")?.coin.id, pendingB.coin.id);
});

test("Mint journal refuses to persist a record whose coin is not cryptographically verifiable", async () => {
  installLocalStorage(new FakeStorage());
  activateVaultStorage("vault-a", VAULT_KEY_A);
  // An unsigned coin (verifyEvent returns false) trips isPendingCoinMint, so
  // preparePendingCoinMint must reject with the "refusing to journal" guard
  // rather than persisting a structurally invalid record.
  const unsignedCoin = {
    kind: 4290,
    created_at: 1_234,
    tags: [["z", "file"], ["x", "a".repeat(64)]],
    content: JSON.stringify({ snapshot: "coin", coin: { version: 1, origin: { kind: "direct" } } }),
    id: "0".repeat(64),
    pubkey: "0".repeat(64),
    sig: "0".repeat(128),
  };
  await assert.rejects(
    preparePendingCoinMint("invalid-coin", async () => ({
      sourceFolderId: "source",
      mintFolderId: "mint",
      localPath: "mint/invalid.md",
      memberName: "invalid.md",
      phrase: "invalid",
      coin: unsignedCoin as unknown as ReturnType<typeof coin>,
    })),
    /refusing to journal an invalid pending Mint/,
  );
  assert.equal(pendingCoinMint("invalid-coin"), null);
});

// Negative paths for the EditorTransaction rebase. The happy-path test above covers clean
// prefix/suffix concurrent edits; these exercise the three fail-closed guards
// inside rebaseCoinMintSourceEditorTransactions (reached through
// rebaseFinalizedCoinMintSourceFile when concurrent transactions exist).
// Each must throw instead of silently
// producing a corrupted source Step.

async function pendingBracketMint(operationKey: string) {
  const store = storage();
  return preparePendingCoinMint(operationKey, async () => ({
    sourceFolderId: "source",
    mintFolderId: "mint",
    localPath: `Mint/${operationKey}.md`,
    memberName: `${operationKey}.md`,
    phrase: "phrase",
    coin: coin(101),
    sourceFinalization: {
      kind: "pending-bracket" as const,
      relativePath: "source.md",
      sourceNodeId: "d".repeat(64),
      sourceContentHash: "e".repeat(64),
      range: { start: 3, end: 9 },
      bracketRange: { start: 0, end: "[[ phrase ]]".length },
    },
  }), store, 1);
}

test("rebase rejects concurrent EditorTransactions that do not reconstruct currentText", async () => {
  const pending = await pendingBracketMint("rebase-invalid-editor-transaction");
  const sourceText = "[[ phrase ]]";
  const steppedText = finalizedCoinMintSourceText(pending, sourceText);
  const current = {
    runs: [{ voice: pending.coin.pubkey, text: sourceText }],
    nodeId: pending.sourceFinalization!.sourceNodeId,
    tags: [],
    citationIds: [],
  };
  // The transaction claims an insert at [0,0), but the resulting text would
  // not equal currentText (it would have the prefix).
  const bogusTransactions = [
    transaction(1, 1, "b".repeat(64), 0, 0, "typed before "),
  ];
  assert.throws(
    () => rebaseFinalizedCoinMintSourceFile(
      pending,
      current,
      sourceText,
      steppedText,
      "f".repeat(64),
      pending.coin.pubkey,
      bogusTransactions,
    ),
    /invalid concurrent EditorTransaction log/,
  );
});

test("rebase rejects a concurrent EditorTransaction that overlaps the citation range", async () => {
  const pending = await pendingBracketMint("rebase-overlap");
  const sourceText = "[[ phrase ]]";
  const steppedText = finalizedCoinMintSourceText(pending, sourceText);
  // minimalTextChange(sourceText, steppedText) returns a citation envelope
  // bounded by the divergence of "[[ phrase ]]" from "[[ phrase | <id> ]]" —
  // roughly {from=10, to=9} (the closing "]]" is shared, so the inner edit
  // boundary inverts). A concurrent transaction whose [from, to] straddles that
  // envelope (from < citationTo AND to > citationFrom) must fail closed
  // instead of letting the citation rewrite and the editor transaction both
  // claim the same bytes.
  const overlappingFrom = 8;
  const overlappingTo = 11;
  const replacedSlice = sourceText.slice(overlappingFrom, overlappingTo);
  const current = {
    runs: [{ voice: pending.coin.pubkey, text: sourceText }],
    nodeId: pending.sourceFinalization!.sourceNodeId,
    tags: [],
    citationIds: [],
  };
  const overlappingTransactions = [
    transaction(
      1,
      1,
      "b".repeat(64),
      overlappingFrom,
      overlappingTo,
      replacedSlice,
    ),
  ];
  assert.throws(
    () => rebaseFinalizedCoinMintSourceFile(
      pending,
      current,
      sourceText,
      steppedText,
      "f".repeat(64),
      pending.coin.pubkey,
      overlappingTransactions,
    ),
    /overlaps a concurrent editor transaction/,
  );
});

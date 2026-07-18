import assert from "node:assert/strict";
import test from "node:test";

import {
  captureDesktopOperationJournalSessionV1,
  clearDesktopOperationJournalSessionV1,
  requireDesktopOperationJournalSessionV1,
} from "../ai/desktop-operation-journal-session.js";
import { activateVaultRuntime } from "./vaults.js";

test("malformed native activation response clears the session and locks native runtime", async () => {
  captureDesktopOperationJournalSessionV1({
    journalSessionId: "a".repeat(64),
    journalGeneration: 41,
  });
  const calls: string[] = [];
  const nativeInvoke = async (command: string): Promise<unknown> => {
    calls.push(command);
    if (command === "activate_vault_runtime") return { journalSessionId: "malformed" };
    if (command === "lock_vault_runtime") return null;
    throw new Error(`unexpected command ${command}`);
  };

  await assert.rejects(
    () => activateVaultRuntime("vault-test", new Uint8Array(32), nativeInvoke),
    /invalid journal session/,
  );
  assert.deepEqual(calls, ["activate_vault_runtime", "lock_vault_runtime"]);
  assert.throws(() => requireDesktopOperationJournalSessionV1(), /Unlock a vault/);
  clearDesktopOperationJournalSessionV1();
});

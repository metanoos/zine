import assert from "node:assert/strict";
import test from "node:test";
import { finalizeEvent } from "nostr-tools/pure";

import {
  enqueueLocalEvent,
  pendingLocalEventById,
  pendingLocalEventCount,
  pendingLocalEventsMatching,
  removeLocalEvent,
} from "./event-outbox.js";

const values = new Map<string, string>();
// @ts-expect-error minimal storage surface for the pure outbox tests
globalThis.localStorage = {
  getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => values.set(key, value),
  removeItem: (key: string) => values.delete(key),
  clear: () => values.clear(),
};

const SECRET = Uint8Array.from([...new Uint8Array(31), 1]);

function event(path: string, previous?: string) {
  return finalizeEvent({
    kind: 4290,
    created_at: 1_700_000_000,
    tags: [
      ["z", "file"],
      ["F", path],
      ["f", "a".repeat(64)],
      ...(previous ? [["e", previous, "", "prev"]] : []),
    ],
    content: JSON.stringify({ snapshot: path }),
  }, SECRET);
}

test("signed outbox preserves exact events, order, and Nostr filtering", () => {
  values.clear();
  const first = event("first.md");
  const second = event("second.md", first.id);
  enqueueLocalEvent(first);
  enqueueLocalEvent(second);
  enqueueLocalEvent(first);

  assert.equal(pendingLocalEventCount(), 2);
  assert.deepEqual(
    pendingLocalEventsMatching({ kinds: [4290], "#F": ["second.md"] }).map((item) => item.id),
    [second.id],
  );
  assert.deepEqual(pendingLocalEventById(first.id), first);

  removeLocalEvent(first.id);
  assert.equal(pendingLocalEventCount(), 1);
  assert.equal(pendingLocalEventById(first.id), null);
});

test("corrupt outbox data fails loudly instead of dropping signed Steps", () => {
  values.set("zine.pending-trace-events", "not-json");
  assert.throws(() => pendingLocalEventCount(), /corrupt JSON/);
  values.clear();
});

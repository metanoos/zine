import assert from "node:assert/strict";
import test from "node:test";
import {
  captureStreamingScrollAnchor,
  restoreStreamingScrollTop,
} from "./streaming-scroll.js";

test("a reader at or near the bottom follows streamed growth", () => {
  const exact = captureStreamingScrollAnchor({
    scrollTop: 700,
    scrollHeight: 1000,
    clientHeight: 300,
  });
  const near = captureStreamingScrollAnchor({
    scrollTop: 680,
    scrollHeight: 1000,
    clientHeight: 300,
  });

  assert.deepEqual(exact, { kind: "bottom" });
  assert.deepEqual(near, { kind: "bottom" });
  assert.equal(
    restoreStreamingScrollTop(exact, { scrollHeight: 1125, clientHeight: 300 }),
    825,
  );
});

test("a reader away from the bottom keeps the exact pixel offset", () => {
  const anchor = captureStreamingScrollAnchor({
    scrollTop: 412.75,
    scrollHeight: 1000,
    clientHeight: 300,
  });

  assert.deepEqual(anchor, { kind: "fixed", scrollTop: 412.75 });
  assert.equal(
    restoreStreamingScrollTop(anchor, { scrollHeight: 1600, clientHeight: 300 }),
    412.75,
  );
});

test("a document shorter than its viewport is treated as bottom-pinned", () => {
  const anchor = captureStreamingScrollAnchor({
    scrollTop: 0,
    scrollHeight: 180,
    clientHeight: 300,
  });

  assert.deepEqual(anchor, { kind: "bottom" });
  assert.equal(
    restoreStreamingScrollTop(anchor, { scrollHeight: 240, clientHeight: 300 }),
    0,
  );
});

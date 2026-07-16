import assert from "node:assert/strict";
import test from "node:test";

import WebSocket from "ws";

import { installNodeWebSocket } from "./websocket-node.js";

test("installNodeWebSocket supplies WebSocket when Node has no native implementation", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
  try {
    assert.equal(Reflect.deleteProperty(globalThis, "WebSocket"), true);
    installNodeWebSocket();
    assert.equal(globalThis.WebSocket, WebSocket);
  } finally {
    Reflect.deleteProperty(globalThis, "WebSocket");
    if (original) Object.defineProperty(globalThis, "WebSocket", original);
  }
});

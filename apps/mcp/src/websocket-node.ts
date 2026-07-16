import WebSocket from "ws";

/**
 * Install the browser-compatible WebSocket constructor used by nostr-tools.
 *
 * Node 20, the minimum runtime supported by zine, does not expose WebSocket on
 * globalThis. The shared provenance modules are also used by the browser and
 * capture that global when they evaluate, so this must run before their
 * dynamic import in the headless press.
 */
export function installNodeWebSocket(): void {
  if (typeof globalThis.WebSocket !== "undefined") return;
  (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = WebSocket;
}

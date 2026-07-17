/**
 * Pin the headless press's home relay.
 *
 * The shared client modules resolve "my home relay" through
 * `identity.ts::resolveRelayUrl()`, which checks (in order) the Node env var
 * `ZINE_RELAY_URL`, the Vite build-time `import.meta.env.VITE_RELAY_URL`, the
 * Tauri global, and the browser `location`. Only the first of those is
 * available under Node, and it has to be set BEFORE any shared module imports
 * `resolveRelayUrl` — `relay-config.ts`'s `builtinEntry()` calls it at
 * `loadRelays()` time, and the provenance layer holds the URL for the whole
 * process.
 *
 * This is the single place the `--home-relay` CLI arg crosses into the shared
 * modules' resolution path. `relay-config.ts` then rebuilds its home entry
 * from this URL on every `loadRelays()`, so the headless press reads from and
 * writes to exactly the relay the operator named — no stored-list override
 * needed (and `loadRelays` would ignore one anyway: it always rebuilds the
 * home entry against the current `resolveRelayUrl()`).
 *
 * Must be called at the very top of `server.ts`, before any dynamic import of
 * `workspace-local.ts` / `provenance.ts`.
 */
export function setHomeRelay(relayUrl: string): void {
  process.env.ZINE_RELAY_URL = relayUrl;
}

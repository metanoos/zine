## Wire editor → relay: browser-side signing + Tauri-spawned sidecar

### Architecture (decided last turn)
- **Signing in the browser** with a locally-generated keypair (`nostr-tools/pure`, stored in `localStorage`). Two-worlds cost (CLI voices vs browser voice) accepted; NIP-46 unification is later.
- **Tauri spawns `relay/zine-relay` as a sidecar** (confirmed direction per HANDOFF + `main.go:3-10`). Browser connects over `ws://127.0.0.1:4869`.
- `nostr-tools/relay` uses native browser `WebSocket` (`abstract-relay.js:138` falls back to global `WebSocket`) — no polyfill.
- `nostr-tools/pure` is browser-safe (no Node `crypto`/`fs`).

### The one real obstacle: relay origin policy
Khatru's `ApplySaneDefaults` (`relay/main.go:39`) rejects cross-origin browser WS — the Tauri webview's origin (`tauri://localhost` or `http://localhost:1420` in dev) isn't `127.0.0.1:4869`. **Chosen:** add a permissive origin policy for localhost in `relay/main.go`. Localhost-only relay, never internet-reachable by design — accepting localhost browser origins doesn't widen attack surface. Rejected: a custom Tauri protocol handler proxying WS — more moving parts, no benefit for a localhost sidecar.

### Steps

**1. Relay: accept localhost browser origins (`relay/main.go`)**
Add an origin-acceptance policy alongside `ApplySaneDefaults` allowing `127.0.0.1`, `localhost`, and the Tauri scheme. Verify with a browser-side WS handshake against the running binary before touching the client. Keep `--host 127.0.0.1` bind.

**2. Client: browser identity + relay client (`apps/client/src/identity.ts`, new)**
- `loadOrCreateVoice()`: reads `localStorage` for secret-key hex; if absent, `generateSecretKey()` (`nostr-tools/pure`), stores it. Returns `{ secretKey, publicKey }`. Mirrors `voice.ts`'s `createLocal` posture — fresh local generation only, never a paste.
- `connectRelay()`: wraps `Relay.connect(ws://127.0.0.1:4869)`, retrying briefly while the sidecar boots.

**3. Client: provenance bridge (`apps/client/src/provenance.ts`, new)**
Thin adapter owning relay+signer singletons:
- `publishEdit({prevEventId, relativePath, folderId, deltas, snapshot, contentHash})` — builds the kind-4290 template (mirrors `store.ts:publishTraceNode` exactly: same tags `file/folder/F/D/action/e...prev`, same content JSON), signs via `finalizeEvent` from `nostr-tools/pure`, publishes.
- `fetchChain(folderId, relativePath)` / `fetchLatest(relativePath)` — query helpers mirroring `store.ts:fetchChain`.
Folder/file identity is synthetic for now (client isn't attached to real disk) — a hardcoded `folderId`/path per open file, same as `INITIAL_FILES` is already synthetic.

**4. Client: Tauri sidecar spawn (`apps/client/src-tauri/src/lib.rs`, `tauri.conf.json`)**
- A `spawn_relay` Tauri command: locates `relay/zine-relay` (dev: relative to workspace; fallback `TRACER_RELAY_BIN` env), spawns via Tauri 2's `Command` API (detached, stdio piped), waits until `127.0.0.1:4869` accepts TCP.
- Invoke `spawn_relay` on mount before `connectRelay`; guard against double-spawn.
- `tauri.conf.json`: whitelist the shell permission for the relay binary.

**5. Client: hook editor deltas → bridge (`apps/client/src/App.tsx`)**
Today `FileEditor` lifts new `Run[]` to `onEdit` on every transaction but publishes nothing. Add: on a debounce (1.5s idle, or explicit Cmd+S), call `provenance.publishEdit(...)` with accumulated deltas since last seal. Track `lastSealedEventId` per file. This is where the "in-app editor gives each delta its own timestamp" case (spec `:124-134`) finally gets exercised for real.

### Verification (project standard: run real things)
- **Relay origin:** start `relay/zine-relay`, browser console `new WebSocket('ws://127.0.0.1:4869')` connects without close. Then a signed kind-4290 round-trip from the browser, read back via `sqlite3 ~/.tracer/relay.sqlite3`.
- **Client:** `npm run build` clean. `tauri dev` → confirm sidecar spawns, type in editor, Cmd+S, verify signed event lands in relay (sqlite row). Reload → chain reconstructs, prior content reappears.
- **No regression:** voice colors, pin toggle (`Cmd-Alt-P`), `runAgent` flow still work.

### Out of scope
- Identity unification (browser ↔ CLI voices separate — accepted cost).
- Real disk attach (sidebar stays synthetic `INITIAL_FILES`).
- Publish-to-external-relay (local sidecar only).
- Hardening / `[[ ]]` (spec-only).
- Pin persistence across reload.

### Files touched
- `relay/main.go` (origin policy)
- `apps/client/package.json` (add `nostr-tools`)
- `apps/client/src/identity.ts`, `provenance.ts` (new)
- `apps/client/src-tauri/src/lib.rs`, `tauri.conf.json` (sidecar spawn + shell perm)
- `apps/client/src/App.tsx` (wire debounce+publish on edit)
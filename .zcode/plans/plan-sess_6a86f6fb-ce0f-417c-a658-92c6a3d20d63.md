## Reconcile pins ↔ hardening: orthogonal, one-directional backing

### The decision (architecture call, recorded in spec)
**Hardening and pinning stay orthogonal.** Hardening = snapshot preservation (immutable citable node; live text intentionally stays editable — `trace-provenance.md:153`). Pinning = live-text preservation (canonical text wins over the agent; local/unsigned today). The two answer different questions and must not be bundled.

**One-directional optional backing:** a pin *may* be backed by a hardened node (so a lost `conflict` is recoverable — the old text exists as a citable node), but a hardened node is *not* inherently pinned (citing a frozen version ≠ forbidding edits to the live copy). Three honest modes fall out: harden-only (recoverable+citable, editable), pin-only (live-protected, unrecoverable if lost — today's behavior), harden+pin (both). This is the dependency direction `pins.ts:18-20` deferred; picking it unblocks the client surface.

### Why this direction (not pin⇒harden or harden⇒pin bundling)
- Harden⇒pin would force every citation to also be a no-edit zone — breaks the normal "harden to quote elsewhere, keep improving the original" case the spec already relies on.
- Pin⇒harden-for-free is appealing but changes today's pin semantics (currently unsignable/local) — keep it optional so pin-only behavior is unchanged.
- Backing a pin with a node is strictly additive: a lost conflict becomes recoverable instead of destructive. No existing test breaks.

### Spec change — `protocol/trace-provenance.md`
1. **Composability §**: add a short "Pins vs hardening" subsection stating the orthogonality + one-directional backing rule. Cite `trace-provenance.md:153` for "hardening tolerates live-text loss." Note the third mode (harden+pin) and that backing is optional. Cross-ref to `pins.ts`'s deferred-`sign` note as the path to making a backed pin durable/signed.
2. **Client UX §**: record that bracket markup is hidden in rendering (already implied at `:198`), and that a pin's canonical text is the *inner* content, not the raw `[[ ]]` — so `restorePins`'s text-identity match works unchanged over bracketed regions.
3. **Open questions §**: add "module of trace-nodes" — a *collection* of hardened nodes as an addressable unit (cite collectively / pin as a group) — flagged as an extension *of* hardening, not a sibling. This is the germ from the conversation; it stays open, not implemented.
4. No new action types, no new tags, no new event kinds. This is a clarification + a relationship rule, not a wire-format change.

### Client change — `apps/client/src/App.tsx` (the CM6 editor just built)
Surface the reconcile in the one place it's visible: let an author mark a region as **pinned**, rendered distinctly from **hardened**. Concretely:
- Add a `pinned: boolean` to the in-memory `Run` model (client-side only, mirroring how `Run[]` voice attribution is already client-side — same boundary reasoning as the last change).
- A CM6 `Decoration.mark` for pinned ranges (distinct visual — e.g. a left border / different background than voice colors), derived from a `StateField` the same way `voiceField` is.
- A keybinding / command to toggle pin on the current selection (e.g. Cmd-Shift-P). Toggling flips `pinned` on the affected runs.
- **No hardening implementation in the client yet** (the harness has none either — `[[ ]]` is spec-only). The reconcile is expressed as: pin decoration is independent of voice decoration, and the spec records that a future hardened region *may* also carry a pin. The client shows the two as orthogonal layers now, so adding hardening later doesn't rework this.

### Out of scope (explicit)
- No `[[ ]]` hardening implementation (still spec-only across the whole repo).
- No `sign` path (the deferred durable-promotion — separate, larger).
- No harness changes (`pin-restore.ts` works unchanged — its text-identity match handles bracketed inner text already).
- No protocol wire-format change (no new tags/kinds/actions).

### Verification
- Spec: re-read after edit for internal consistency (the `:153` claim, the Client UX `:198` claim, the deferred-`sign` note in `pins.ts`).
- Client: `npm run build` (tsc strict + vite); manual `npm run dev` — toggle pin on a selection, confirm decoration renders and is independent of voice color; type across a pinned region, confirm caret stable (the CM6 rewrite's guarantee holds).

### Files touched
- `protocol/trace-provenance.md` (3 edits: Composability subsection, Client UX note, Open questions item)
- `apps/client/src/App.tsx` (pin StateField + Decoration + toggle command; `pinned` on Run)
- `apps/client/src/App.css` (pinned decoration style)
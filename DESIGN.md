# Design System — Zine

## Product Context

- **What this is:** Zine is a local-first, AI-native writing instrument that
  records how text is made. The text is the arrangement; its trace is the
  process or performance that produced it. Zine uses selected trace evidence
  to help the AI collaborate with more than the final text while keeping that
  context inspectable and correctable.
- **Who it is for:** Authors, AI-assisted teams, agents, collaborators, and
  later readers who want to write, replay, interpret, cite, and extend a
  composition without surrendering its history to one hosted editor.
- **Space/industry:** Editorial software, creative tools, local-first
  collaboration, AI workbenches, and signed process provenance.
- **Project type:** A dense desktop authoring application with a read-only web
  surface and headless interoperability through MCP.
- **Memorable quality:** Zine should feel like an instrument for text: exact
  enough for serious provenance, expressive enough that the process itself can
  become art.

### Authority and status

This document governs product language and visual or interaction decisions. It
does not change wire formats, trust semantics, or implementation status. The
owning specifications under `protocol/` remain authoritative for those areas.
Some product grammar below describes the intended experience rather than a
claim that every behavior already ships.

## Product Grammar

### Write and Replay

Zine has two primary modes:

- **Write** is where people and AIs create and shape text while Zine records
  the process.
- **Replay** is where people and AIs experience, inspect, analyze, and cite
  that process.

Use **Write**, not **Edit**, in user-facing mode labels. Writing includes
invention, revision, correspondence, arrangement, and AI contribution; editing
describes only part of that activity.

### Content tree, Zine, Trace, and Step

- **Text** is a file zine's Markdown arrangement: the composed state a reader
  encounters.
- **Content tree** is a folder zine's recursive arrangement of child zines.
- A **zine** is one file or folder together with its trace. The **Root zine**
  is the topmost folder; there is no separate project object.
- **Trace** is the process or performance: keystrokes, pauses, deletions,
  rewrites, pasted material, structural changes, descendant activity, voice
  changes, AI interactions, and other observable actions that produced the
  file or folder state.
- **Replay** is the interface for experiencing a trace. Do not use Replay and
  Trace as interchangeable names.
- A **checkpoint** is any signed durable landmark within the trace. **Step** is
  the deliberate checkpoint gesture; automatic ancestor roll-ups remain
  visible derived checkpoints and must not masquerade as additional Steps.
- An **edition** is an immutable publication at one exact Step. **Publish** is
  the disclosure/reachability gesture; **Attest** is the separate commitment
  to stand behind that edition. Publish is the product term now; the wire and
  implementation keep the name Send until the coordinated schema cut.

Folder replay reconstructs the descendant tree and interactions across it, not
just a list of current names. Rename and move preserve zine identity. An
explicit folder or Root Step checkpoints dirty descendants and then creates one
deliberate scoped landmark; derived child advances are collapsed beneath that
gesture by default and remain expandable for verification.

The trace is a creative medium, not an audit screen hidden behind the final
document. Interfaces may reveal compositional patterns such as hesitation,
repetition, revision, discarded paths, external pastes, or accepted AI
suggestions. Pattern displays must remain inspectable and must not present an
inference as a fact.

### AI and origin

Use **AI** as the normal user-facing term. Avoid **Model** as a top-level
product concept; reserve provider, model, and configuration terminology for
technical detail. Existing protocol or internal implementation names do not
need opportunistic renaming.

Origin and voice are related but distinct:

- **AUTHOR / MANUAL** — directly authored inside Zine.
- **AI / LLM** — inserted by an AI operation.
- **EXTERNAL** — pasted or imported from outside the press.
- **FILESYSTEM** — observed through scans or filesystem reification.

Zine should distinguish internal Zine copies from externally sourced pastes.
An origin class may choose a default voice, but it must not erase the specific
key or voice attribution carried by the source.

When Zine sends context to an AI, show and preserve the context Zine actually
sent when available. Never imply that Zine can prove everything an external
provider or harness may have seen.

### Trace-aware AI collaboration

AI context is part of the writing instrument, not invisible prompt plumbing.
The primary loop stays in the authored text:

1. choose an operation in relation to the current text;
2. inspect the exact text and trace evidence Zine selected;
3. exclude, correct, forget, or explicitly authorize context;
4. approve the frozen request;
5. accept, revise, reject, or recover the result in place; and
6. extend the trace with the accepted outcome and its context receipt.

Prompt Inspector should expose each evidence item as a concrete record: source
Step or span, file/folder/user scope, classification, selection reason,
sensitivity, and byte cost. Quoted document material must remain visually and
semantically distinct from instruction-authority segments. Do not reduce this
to one opaque prompt textarea.

Memory follows the zine tree rather than a separate project abstraction:

- **operation** is ephemeral;
- **file** follows one stable file trace;
- **folder** applies to the current descendant subtree, including the Root as
  the topmost folder zine; and
- **user** crosses Roots only through an explicit author choice.

More specific memory wins. Equal-scope conflicts block preparation and ask the
writer to supersede, narrow, revoke, or exclude one choice. Nothing promotes
itself upward. Folder inheritance changes when containment changes; file memory
survives a move through stable trace identity.

Two inline forms express local intent:

- `[[…]]` is protected quoted data. Preserve its exact bytes through eligible
  transformations. Directive-looking text inside it remains inert.
- `((…))` is a one-shot directive candidate for any prepared AI operation. A
  position-aware parser replaces an authorized directive with a stable marker
  in quoted text and presents its exact instruction plus bounded local anchor
  in a dedicated Inspector section. It disappears only after accepted success.

Only complete bytes manually authored by the acting local AUTHOR, or explicitly
promoted in Inspector, may become directive authority. Paste, import,
filesystem, AI, another author, mixed, historical, malformed, and unknown-origin
forms remain quoted data. A directive may steer an approved operation but never
grant tools, filesystem access, network access, or broader scope.

Consumed directives remain one-shot across undo. If their bytes reappear, show
them as consumed and inert with a deliberate Reactivate action. If textual
cleanup fails after accepted success, keep the result, display the cleanup
state, and never repeat the operation.

### People, peers, and nodes

- **People** are human collaborators who receive access or participate in the
  work.
- **Peers** are connected devices or nodes participating in transport or sync.
- A person may control several peers. A peer is therefore not a synonym for a
  person.

Prefer People in ordinary collaboration surfaces. Reveal Peer, Node, keys,
and routing in networking details where the technical distinction matters.

### Human–AI review

A review of a trace should itself be composed in Zine by a human–AI team. The
review is an ordinary file or folder zine that:

- records the reviewers' own back-and-forth in its trace;
- cites exact source text or trace spans through the ordinary citation
  machinery;
- can be replayed, stepped, published, and reviewed like other zines.

Do not introduce reviewer-only composition language when ordinary quotation
and citation controls suffice. Quoting does not require coining. An inline
quotation should be automatically bracketed and should retain the source
text's voice and color, with an accessible citation affordance in addition to
color.

## Aesthetic Direction

- **Direction:** Trace-native editorial instrument.
- **Decoration level:** Intentional but restrained.
- **Mood:** Clean, dense, exact, literary, and polyphonic. The app should feel
  serious without becoming institutional, and powerful without looking like a
  dashboard or generic AI chat.
- **Layout approach:** Grid-disciplined desktop instrument.
- **Color approach:** Restrained chrome with expressive attributed voices.
- **Motion approach:** Minimal and functional.
- **Reference sites:** [iA Writer](https://ia.net/writer/) for focused authorship
  and visible origin; [Granola](https://www.granola.ai/) for human/AI source
  distinction; [Obsidian](https://obsidian.md/) for local, durable work;
  [GitButler](https://gitbutler.com/) and [Cursor](https://www.cursor.com/) for
  dense change-oriented tools; and [Ableton Live](https://www.ableton.com/en/live/what-is-live/)
  for treating recorded process as manipulable creative material.

The Ableton reference is conceptual, not a mandate to copy its modes, controls,
transport hierarchy, or visual skin. Preserve Zine's existing layout.

### Visual non-goals

- Do not redesign Zine as an AI chat interface.
- Do not turn provenance into a separate dashboard that competes with the
  writing surface.
- Do not use crypto, surveillance, or compliance aesthetics as the default.
- Do not introduce decorative gradients, excessive cards, bubbly radii, or
  generic purple AI branding.
- Do not make the interface sparse at the expense of useful density.

## Typography

- **Display/Hero:** Big Shoulders Display, weights 600 and 800 — condensed,
  editorial emphasis for titles and exceptional display moments.
- **Body:** Newsreader, weights 400 and 500 with italic 400 — the primary
  reading and writing face.
- **UI/Labels:** IBM Plex Mono, weights 200, 400, and 500 — compact chrome,
  actions, labels, identifiers, and technical state.
- **Data/Tables:** IBM Plex Mono with tabular numerals — hashes, timestamps,
  keys, paths, measurements, and trace coordinates.
- **Code:** IBM Plex Mono by default; JetBrains Mono is available to attributed
  voices.
- **Voice text:** A voice may use its key's curated typographic identity. The
  current pool is Newsreader, Fraunces, Lora, Spectral, Inter, Atkinson
  Hyperlegible, IBM Plex Mono, and JetBrains Mono. Big Shoulders Display is
  chrome-only and must not be assigned to paragraph voices.
- **Loading:** The current client loads the curated families through the Google
  Fonts imports in `apps/client/src/app/App.css`. Keep all loaded families declared
  together so voice text does not flash into an unintended identity.

### Type scale

The interface uses a functional compact scale rather than a marketing-page
modular scale:

- **Micro evidence:** `0.56–0.62rem`
- **Compact chrome:** `0.68–0.78rem`
- **Controls and secondary prose:** `0.82–0.95rem`
- **Body:** `1rem`
- **Section display:** `1.3rem`
- **Major display:** `1.85–2rem`

Use size, weight, family, case, and spacing together. Do not solve hierarchy by
adding more colors.

## Color

- **Approach:** Neutral editorial chrome; color is meaningful and comparatively
  rare outside attributed text.
- **Primary accent:** `#b87d05` in light mode and `#f5a919` in dark mode — Step,
  selection, focus, and press actions.
- **Light neutrals:** paper `#e5e2da`, raised paper `#f2efe7`, sunken paper
  `#d3cfc5`, ink `#17171a`, dim ink `#5b5a56`.
- **Dark neutrals:** surface `#0a0a0b`, raised surface `#171719`, sunken surface
  `#050506`, ink `#ecebe6`, dim ink `#a6a39c`.
- **Semantic success:** `#2d6a2f` light / `#82cf85` dark.
- **Semantic warning:** use the gold accent.
- **Semantic error:** `#c9182b` light / `#e06577` dark.
- **Semantic info and filesystem scan:** `#2563eb` light / `#6ea8ff` dark.
- **Rules:** translucent current ink, using the existing `--rule` and
  `--rule-strong` tokens.

Gold is reserved for chrome and must not be generated as a voice identity.
Voice colors derive from a key's stable identity, use moderate saturation, and
change lightness between themes. The same voice must remain recognizable across
Write, Replay, quotations, citations, devices, and published traces.

Color must never be the only carrier of attribution or state. Pair it with
brackets, labels, rules, icons, type identity, or position as appropriate.
Dark mode is a deliberate surface system, not a mechanical inversion.

## Spacing

- **Base unit:** 4px, with 2px optical half-steps where dense chrome requires
  them.
- **Density:** Compact around the document; comfortable within authored prose.
- **Scale:** 2xs (2px), xs (4px), sm (8px), compact (12px), md (16px), lg
  (24px), xl (32px), 2xl (48px), 3xl (64px).

Preserve useful density. Prefer alignment, rules, and contained scrolling over
padding every element into a card. Small optical deviations in the existing
CSS are valid when they improve icon or baseline alignment.

## Layout

- **Approach:** Grid-disciplined, desktop-first, and panel-based.
- **App shell:** Full viewport with contained scrolling; individual panes own
  their overflow.
- **Navigation rail:** 52px collapsed, expandable for labels.
- **Header band:** `2.5rem` shared across views.
- **Collection sidebar:** 220px default and horizontally resizable.
- **Workspace:** Flexible horizontal panels. Writing and replay surfaces share
  the application's spatial grammar rather than becoming separate products.
- **Settings measure:** 35rem for focused configuration columns.
- **Reading measure:** Approximately 42rem where long-form explanatory prose
  needs a calmer column.
- **Rules:** 1px dividers establish most grouping.
- **Border radius:** Primarily 3–5px for controls and rows, 6–8px only where a
  larger container or grab target benefits. Full radii are reserved for true
  dots, status pills, and continuous tracks.

The current layout is the baseline. Future design changes should be surgical:

- make every action that creates a Step visibly carry the Step icon or mark;
- distinguish an explicit Step from structural and derived folder checkpoints,
  collapsing a recursive roll-up beneath its originating gesture;
- add replay layers for trace patterns without obscuring the text;
- make selected AI context, scope, conflicts, and correction legible in the
  existing Prompt Inspector rather than adding a second application shell;
- let reviews cite text and trace spans through existing citation language;
- adopt AI terminology in user-facing surfaces;
- distinguish People from technical Peers and Nodes progressively.

Do not add a permanent generic chat pane. Human–AI correspondence belongs in
the authored text and its replayable trace.

## Motion

- **Approach:** Minimal-functional.
- **Easing:** Ease-out for appearance, ease-in for disappearance, and
  ease-in-out for movement or resize feedback.
- **Duration:** Micro 50–100ms, short 100–160ms, medium 160–250ms. Longer motion
  requires a direct replay or onboarding purpose.
- **Replay:** Transport movement should be temporally honest and interruptible.
- **Reduced motion:** Disable nonessential animation under
  `prefers-reduced-motion` while preserving state changes.

Motion should clarify selection, focus, drag, resize, progress, or replay. Do
not add ambient shimmer, theatrical page transitions, or animation that makes
an unsigned/provisional state appear accepted.

## Interaction Principles

1. **The process is first-class.** A reader can move from text to the process
   that produced it without leaving the work.
2. **Attribution survives transformation.** Copying, quoting, replaying,
   accepting AI work, and moving between devices must preserve visible origin
   and voice wherever the underlying data supports it.
3. **Durable gestures are explicit.** Continue and Reply may be direct, but if
   they Step, the interface must say so before activation and show the Step
   mark.
4. **AI inference remains inspectable.** An AI may use trace patterns to infer
   needs and preferences; the human–AI team must be able to review the exact
   selected evidence, correct or forget it, and compose a response in Zine.
5. **Local-first state is legible.** Show whether work is local, stepped, published,
   reachable, or synchronized without turning networking details into the
   primary writing experience.
6. **Progressive disclosure beats simplification.** Keep the clean lines and
   density; reveal keys, hashes, context, and routing when the task calls for
   them.

## Accessibility

- Maintain visible keyboard focus in the gold action language.
- Do not rely on hue alone for voice, origin, replay position, or status.
- Preserve readable contrast for every generated voice in light and dark
  themes.
- Keep authored text selectable and quotations machine-readable.
- Use labels or tooltips for unfamiliar provenance and Step icons.
- Respect reduced-motion preferences and maintain full keyboard operation for
  Write, Replay, palettes, panels, and citations.

## Decisions Log

| Date | Decision | Rationale |
|---|---|---|
| 2026-07-17 | Preserve the current visual layout | The existing clean lines, density, editorial palette, and panel structure already fit the product. |
| 2026-07-17 | Use Write and Replay as the primary modes | Write covers invention and revision; Replay is the action performed on the trace. |
| 2026-07-17 | Define text as arrangement and trace as process/performance | The final text and the process are related creative materials, not a document plus an audit attachment. |
| 2026-07-17 | Use AI rather than Model in ordinary interface language | AI describes the participant users recognize; provider/model detail remains available when needed. |
| 2026-07-17 | Make review an ordinary Zine composition | Human–AI analysis should cite the source trace while recording and exposing its own process. |
| 2026-07-17 | Separate People from Peers | People hold collaborative relationships; peers are the devices or nodes that route and synchronize work. |
| 2026-07-17 | Treat trace as a creative medium | Replay and analysis should support interpretation, intuition, and art as well as provenance. |
| 2026-07-17 | Skip redesign mockups | The user explicitly approved documenting the live design rather than replacing it with generated directions. |
| 2026-07-17 | Make trace-aware writing the daily product loop | Process evidence should improve collaboration during writing while remaining useful for later verification. |
| 2026-07-17 | Use one universal inline directive grammar | `[[…]]` is protected data; authorized `((…))` is a one-shot instruction across operation-specific adapters. |
| 2026-07-17 | Keep AI memory scoped and correctable | Operation, file, folder, and explicit user scopes follow the actual folder tree and block unresolved equal-scope conflicts. |
| 2026-07-17 | Treat every file and folder as a zine | A zine is content plus its scoped trace; Root is the topmost folder zine and can replay the whole descendant interaction history. |
| 2026-07-17 | Separate Steps from derived checkpoints | A deliberate file/folder/Root Step is one author gesture even when signed child-head roll-ups propagate through ancestors. |
| 2026-07-17 | Present in-session voices by ID, not key | In-session co-authorship is asserted attribution; key language implies an independent verification that only cross-key seams provide. |
| 2026-07-17 | Frame review as "evaluate the writer, not just the writing" | As finished prose grows more uniform, the writer's judgment survives in the trace; review surfaces should foreground process evidence over prose judgment. |
| 2026-07-17 | Adopt Publish as the product term ahead of the wire cut | Publish names the disclosure gesture on every reader-facing surface; Send remains the wire and implementation identifier until the coordinated schema cut renames it. |

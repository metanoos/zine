# CLAUDE.md

Repository-wide engineering instructions live in `AGENTS.md`.

## Design System

Always read `DESIGN.md` before making any visual or UI decisions.
All font choices, colors, spacing, and aesthetic direction are defined there.
Do not deviate without explicit user approval.
In QA mode, flag any code that does not match `DESIGN.md`.

## Brain-First Rule (zine worktrees only)

Before proposing architecture changes, refactors, new features, or reversals
of past decisions in this repo or any of its git worktrees, **query gbrain
first** for prior context. This is a hard rule, not a suggestion.

Required before these actions (run via the `gbrain` CLI; Bash tool is fine):
- **Architecture / design changes** — `gbrain search "<topic>" --source default`
  and `~/.claude/skills/gstack/bin/gstack-decision-search "<topic>"`
- **"Why is X like this?" / intent recovery** — `gbrain query "<question>" --source default`
- **"Where is symbol Y?" / "Who calls Y?"** — `gbrain code-def <symbol>`,
  `gbrain code-refs <symbol>`, `gbrain code-callers <symbol>`
- **"Has this been tried before?"** — `gbrain search "<approach>" --source default`

If the brain returns relevant prior decisions or plans, surface them in your
reply *before* proposing the new direction. Treat prior settled decisions as
binding unless the user explicitly reopens them. If you're about to reverse
one, say so out loud and log the reversal with
`~/.claude/skills/gstack/bin/gstack-decision-log --supersede <id>`.

Scope: this rule fires in `zine/` and its git worktrees
(`zine-integrated`, `zine-frontend-work`, `zine-folder-zines-mainline`,
`zine-desktop-loop-release`, `zine-kademlia-main-integration`). Each worktree
needs a `.gbrain-source` pin at its toplevel for the code queries to scope
correctly; run `/sync-gbrain` once in any worktree that lacks the pin.

Fallback: if gbrain returns nothing relevant, proceed normally — the rule is
"check first", not "block on the brain". Grep + Read are still right for
known exact strings, regex, and reading specific files.

## GBrain Search Guidance (configured by /sync-gbrain)
<!-- gstack-gbrain-search-guidance:start -->

GBrain is set up and synced on this machine. The agent should prefer gbrain
over Grep when the question is semantic or when you don't know the exact
identifier yet.

**This worktree is pinned to a worktree-scoped code source** via the
`.gbrain-source` file in the repo root (kubectl-style context).
`gbrain code-def`, `code-refs`, `code-callers`, `code-callees`, `search`, and
`query` from anywhere under this worktree route to that source by default —
no `--source` flag needed (gbrain >= 0.41.38.0; on older gbrain the call-graph
commands need `--source "$(cat .gbrain-source)"`). Conductor sibling worktrees
of the same repo each have their own pin and their own indexed pages, so
semantic results match the code on disk here.

Call-graph queries (`code-callers`/`code-callees`) also need the graph to be
built first — run `/sync-gbrain --dream` (or `--full`) if they return
`count: 0`. This only works if this source's gbrain schema pack extracts code
symbols; on a non-code-aware pack `--dream` completes but the graph stays empty
and reports a WARN. `code-def`/`code-refs` need the same extraction.

Two indexed corpora available via the `gbrain` CLI:
- This worktree's code (auto-pinned via `.gbrain-source`).
- `~/.gstack/` curated memory (registered as `gstack-brain-<user>` source via
  the existing federation pipeline).

Prefer gbrain when:
- "Where is X handled?" / semantic intent, no exact string yet:
    `gbrain search "<terms>"` or `gbrain query "<question>"`
- "Where is symbol Y defined?" / symbol-based code questions:
    `gbrain code-def <symbol>` or `gbrain code-refs <symbol>`
- "What calls Y?" / "What does Y depend on?":
    `gbrain code-callers <symbol>` / `gbrain code-callees <symbol>`
- "What did we decide last time?" / past plans, retros, learnings:
    `gbrain search "<terms>" --source gstack-brain-<user>`

Grep is still right for known exact strings, regex, multiline patterns, and
file globs. Run `/sync-gbrain` after meaningful code changes; for ongoing
auto-sync across all worktrees, run `gbrain autopilot --install` once per
machine — gbrain's daemon handles incremental refresh on a schedule.

Safety: don't run `/sync-gbrain` while `gbrain autopilot` is active — the
orchestrator refuses destructive source ops when it detects a running autopilot
to avoid racing it (#1734). Prefer registering user repos with `gbrain sources
add --path <dir>` (no `--url`): URL-managed sources can auto-reclone, and the
sync code walk for them requires an explicit `--allow-reclone` opt-in.

<!-- gstack-gbrain-search-guidance:end -->

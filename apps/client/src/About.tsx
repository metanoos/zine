/**
 * About view — the pitch.
 *
 * A lede, three narrative beats (voices, trace, publishing), and a closing
 * litany. Vision, not a build log — status lives in git history and the
 * protocol doc, not here.
 */

export function AboutView() {
  return (
    <section className="view-placeholder about-view">
      <div className="about-view-inner">
        <h1 className="about-heading">Run your own press.</h1>

        <div className="about-beats">
          <p className="about-beat">
            <strong>The trace is the material.</strong> Zine keeps the full
            record of composition, not just the final text — each action
            signed and timestamped. This gives your LLM the ability to see
            that you rewrote a passage three times. It notices what you
            lingered on, what you cut, what
            you kept returning to. The rhythm of revision — everything that
            vanishes in an ordinary chat window — becomes fuel for the next
            draft.
          </p>

          <p className="about-beat">
            <strong>Every voice in its own ink.</strong> Your writing
            interleaves with other voices across parallel surfaces — each
            voice distinguished by its own color, so you always know who said
            what.
            Your LLM can add to the existing text, or it can overwrite a
            surface in place. Preserve a piece of text across LLM rewrites by
            typing{' '}
            <span className="about-mark">[[</span>{' '}
            <span className="about-mark-text">square brackets</span>{' '}
            <span className="about-mark">]]</span> around it, or using
            highlight-and-click.
          </p>

          <p className="about-beat">
            <strong>Publishing is yours too.</strong> Zine is built on a
            peer-to-peer mesh variant of Nostr — distribution doesn&apos;t
            route through a platform. Run your own node and you decide how
            widely, and at what pace, your work spreads. Browse across the
            mesh, and tags — real names you chose, not an algorithm&apos;s
            guess — organize what you find.
          </p>

          <p className="about-beat">
            <strong>Replay the writing as it happened.</strong> Every revision
            is captured as a step-point — a sealed, timestamped beat in the
            trace. Scrub forward to watch a draft assemble itself word by word,
            or step back to revisit a passage exactly as it was before you
            changed your mind. The history isn&apos;t a log you scroll; it&apos;s
            an instrument you play.
          </p>
        </div>

        <p className="about-closer">
          Your traces over your own node. Your voice on your own press. A
          permanent, searchable record of how ideas are born — not just what
          you wrote, but how it came to be written. The future of your
          thinking doesn&apos;t have to live in someone else&apos;s vault.
        </p>
      </div>
    </section>
  );
}

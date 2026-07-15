/**
 * About view — the pitch, told three ways.
 *
 * A tab row (1 · 2 · 3) across the top picks one telling at a time; one is
 * always selected.
 *   1 — the manifesto (raw).
 *   2 — the four beats (the original structured pitch).
 *   3 — in plain terms (a short, declarative take).
 *
 * Vision, not a build log — status lives in git history and the protocol doc,
 * not here.
 */

import { useState } from "react";

type Variant = 1 | 2 | 3;

const VARIANTS: Variant[] = [1, 2, 3];
const VARIANT_CAPTION: Record<Variant, string> = {
  1: "Manifesto",
  2: "In four beats",
  3: "In plain terms",
};

export function AboutView() {
  const [active, setActive] = useState<Variant>(1);

  return (
    <section className="view-placeholder about-view">
      <div className="about-view-inner">
        <div className="about-variants" role="tablist" aria-label="About — choose a telling">
          {VARIANTS.map((n) => (
            <button
              key={n}
              type="button"
              role="tab"
              aria-selected={active === n}
              className={"about-variant" + (active === n ? " active" : "")}
              onClick={() => setActive(n)}
            >
              <span className="about-variant-num">{n}</span>
              <span className="about-variant-cap">{VARIANT_CAPTION[n]}</span>
            </button>
          ))}
        </div>

        {active === 1 && <VariantManifesto />}
        {active === 2 && <VariantBeats />}
        {active === 3 && <VariantPlain />}
      </div>
    </section>
  );
}

/* 1 — the manifesto, raw. */
function VariantManifesto() {
  return (
    <div className="about-telling">
      <h1 className="about-heading">Zine: run the press</h1>

      <div className="about-prose">
        <p>
          Your AI text editor isn&apos;t a black box. It ships as source.{" "}
          <code className="about-code">git clone</code>,{" "}
          <code className="about-code">npm run dev</code>, and you&apos;re
          cooking — a p2p node, running a trace editor.
        </p>

        <p>
          A trace is a file or folder that keeps its edit history in high
          fidelity. You can play a trace back like a record. The editor opens
          its panels and types, like it&apos;s a piano in Westworld.
        </p>

        <p>
          A human audience would be lovely, but an LLM audience should be quite
          delightful as well.
        </p>

        <p>
          How do you explain your taste in phrasing — for a sentence you keep
          taking apart and putting back together — without actually telling it?
          You can&apos;t. So you let it watch you rewrite the thing over and
          over, and it intuits something, given the opportunity.
        </p>

        <p>
          That&apos;s the thesis. Everything underneath is the apparatus that
          makes it possible.
        </p>

        <p>
          The LLM writes directly into the same files you do, so it&apos;s in
          the record too. As different sources of writing interleave, each is
          distinguished by its own font and color. You can see who wrote what,
          and how the thing actually came to be.
        </p>

        <p>
          Your friends and admirers can step through the research and
          development of your writing — an animated experience, with rhythm
          measured by your deft placement of step-markers into the log (
          <code className="about-code">Ctrl/Cmd+S</code>).
        </p>

        <p>It is simply a richer expression of thought than plain text.</p>

        <p>
          Place text into <span className="about-mark">[[</span>{" "}
          <span className="about-mark-text">double square brackets</span>{" "}
          <span className="about-mark">]]</span> and it&apos;s durable — your
          LLM co-authors respect it. These get coined into the elementary
          traces, called tags. To use a tag in your text is to put yourself
          within a hop or two of conversation with someone nearby in idea space.
        </p>

        <p>
          Conversations happen in Zine in many ways at many paces. A Zine is a
          trace you&apos;ve signed with an attestation — a geo-hash, a
          Bitcoin-anchored timestamp, a final note — and sent. You write Zines
          back and forth.
        </p>

        <p>
          To fork a Zine is easy: you just edit the file, and it keeps accruing
          history. To fork is to propose; to merge is to accept.
        </p>

        <p>Everyone now runs their own press.</p>
      </div>

      <p className="about-footnote">
        Under the hood, a variant of Nostr runs peer-to-peer instead of over
        WebSockets — same signed-event model, <code className="about-code">SHA-256</code>{" "}
        ids, Schnorr signatures. <code className="about-code">NIP-01</code> if
        you want the seven fields.
      </p>
    </div>
  );
}

/* 2 — the four beats (the original structured pitch). */
function VariantBeats() {
  return (
    <div className="about-telling">
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
  );
}

/* 3 — in plain terms (a short, declarative take). */
function VariantPlain() {
  return (
    <div className="about-telling">
      <h1 className="about-heading">Zine, plainly.</h1>

      <div className="about-prose">
        <p>
          Zine is a text editor that keeps how you wrote something, not only
          what you wrote. Each edit becomes a step — sealed and timestamped —
          and you can play the steps back like a recording.
        </p>

        <p>
          You write alongside an LLM. Both of you edit the same files, so every
          voice ends up in the record, each in its own color. Wrap a phrase in{" "}
          <span className="about-mark">[[</span>{" "}
          <span className="about-mark-text">square brackets</span>{" "}
          <span className="about-mark">]]</span> and it holds — the model
          won&apos;t write over it. Those same brackets become tags, and a tag
          is how you find work, and people, a hop or two away in an idea.
        </p>

        <p>
          It runs on your own machine as a peer-to-peer node. No platform sits
          in the middle. To publish, you sign a trace and send it; to fork, you
          edit; to merge, you accept. That is the whole loop.
        </p>

        <p>
          <code className="about-code">git clone</code>, then{" "}
          <code className="about-code">npm run dev</code>, and the press is
          running — your editor and your node, the same thing.
        </p>
      </div>
    </div>
  );
}

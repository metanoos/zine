import {
  ONBOARDING_LESSONS,
  type ModelLessonResume,
  type OnboardingLessonId,
  type OnboardingStage,
} from "./onboarding-state.js";

export function OnboardingWelcome({
  completedLessons,
  canScan,
  onStartTrace,
  onStartModel,
  onStartScan,
  onDismiss,
}: {
  completedLessons: readonly OnboardingLessonId[];
  canScan: boolean;
  onStartTrace: () => void;
  onStartModel: () => void;
  onStartScan: () => void;
  onDismiss: () => void;
}) {
  const completed = new Set(completedLessons);
  const completeCount = ONBOARDING_LESSONS.filter((lesson) => completed.has(lesson)).length;
  const lessons: Array<{
    id: OnboardingLessonId;
    number: string;
    title: string;
    summary: string;
    onStart: () => void;
    available: boolean;
  }> = [
    {
      id: "trace",
      number: "01",
      title: "Make my own trace",
      summary:
        "Rewrite one line, Step it, then Replay the change. Learn how text becomes a process you can inspect.",
      onStart: onStartTrace,
      available: true,
    },
    {
      id: "ai-context",
      number: "02",
      title: "Add AI, learn context",
      summary:
        "Choose exactly what the AI can see, inspect the request, then make its contribution replayable.",
      onStart: onStartModel,
      available: true,
    },
    {
      id: "scan",
      number: "03",
      title: "Scan a file",
      summary:
        "Bring outside writing into a private, read-only inbox while keeping its external origin visible.",
      onStart: onStartScan,
      available: canScan,
    },
  ];
  const autofocusLesson = lessons.find((lesson) => lesson.available && !completed.has(lesson.id))
    ?? lessons.find((lesson) => lesson.available);

  return (
    <section className="onboarding-welcome" aria-labelledby="onboarding-welcome-title">
      <div className="onboarding-welcome-copy">
        <p className="onboarding-kicker">LEARN ZINE · THREE SHORT CHAPTERS</p>
        <h1 id="onboarding-welcome-title">The final text is only half the story.</h1>
        <p className="onboarding-welcome-lede">
          Text shows what survived. A trace preserves the rewrites, pauses,
          deletions, pastes, and AI contributions that produced it.
        </p>
        <p className="onboarding-welcome-thesis">
          That process can make AI a better writing assistant. It can see that
          you rewrote a sentence, how you rewrote it, and what you rejected—richer
          evidence of your style and values than final prose alone.
        </p>
        <div className="onboarding-trace-proof" aria-hidden="true">
          <span>draft</span>
          <span className="onboarding-trace-proof-change">rewrite</span>
          <span>Step</span>
          <span className="onboarding-trace-proof-result">Replay</span>
        </div>
      </div>

      <div className="onboarding-curriculum" aria-label="Onboarding lessons">
        <div className="onboarding-curriculum-head">
          <div>
            <p className="onboarding-kicker">CHOOSE A CHAPTER</p>
            <h2>Start anywhere.</h2>
          </div>
          <span className="onboarding-progress">
            {completeCount} / {ONBOARDING_LESSONS.length} complete
          </span>
        </div>
        <div className="onboarding-lesson-list">
          {lessons.map((lesson) => {
            const isComplete = completed.has(lesson.id);
            return (
              <button
                key={lesson.id}
                type="button"
                className={`onboarding-lesson${isComplete ? " is-complete" : ""}`}
                onClick={lesson.onStart}
                disabled={!lesson.available}
                autoFocus={autofocusLesson?.id === lesson.id}
              >
                <span className="onboarding-lesson-number">{lesson.number}</span>
                <span className="onboarding-lesson-copy">
                  <strong>{lesson.title}</strong>
                  <span>{lesson.summary}</span>
                </span>
                <span className="onboarding-lesson-status">
                  {!lesson.available
                    ? "Desktop only"
                    : isComplete
                      ? "Complete · Revisit"
                      : "Start"}
                </span>
              </button>
            );
          })}
        </div>
        <div className="onboarding-curriculum-foot">
          <p>No account required. Drafts stay on this computer until you Send them.</p>
          <div className="onboarding-curriculum-links">
            <a className="onboarding-text-link" href="#onboarding-writing-guide">
              How to write Zines ↓
            </a>
            <button type="button" className="onboarding-text-button" onClick={onDismiss}>
              Close guide
            </button>
          </div>
        </div>
      </div>

      <article
        id="onboarding-writing-guide"
        className="onboarding-writing-guide"
        aria-labelledby="onboarding-writing-guide-title"
      >
        <header className="onboarding-writing-guide-head">
          <div>
            <p className="onboarding-kicker">HOW TO WRITE ZINES · A FIELD GUIDE</p>
            <h2 id="onboarding-writing-guide-title">Keep the route inside the prose.</h2>
          </div>
          <p>
            A zine is its Markdown plus an exact, replayable trace. The text is
            one snapshot—a useful but lossy compression of the writing process.
          </p>
        </header>

        <div className="onboarding-writing-rules">
          <section>
            <p className="onboarding-writing-rule-number">01 · RICHER TEXT</p>
            <h3>Let the choices remain visible.</h3>
            <p>
              Make small, legible edits. Keep the turns in thought as bridges,
              clauses, and deliberate side-lines instead of polishing every sign
              of decision away. The trace will preserve what you tried, removed,
              restored, and kept.
            </p>
            <p className="onboarding-writing-aside">
              Replay should feel like the Press opening the files and tabs that
              shaped a sentence—not a player piano performing every keystroke.
            </p>
          </section>

          <section>
            <p className="onboarding-writing-rule-number">02 · THE EM DASH</p>
            <h3>Name the bridge.</h3>
            <blockquote>
              If you can name the transition an em dash replaces, the dash is
              doing real work. If you cannot, use a comma.
            </blockquote>
            <p>
              Try <em>but</em>, <em>because</em>, <em>therefore</em>, or
              {" "}<em>meanwhile</em>. An em dash is not an emphasis mark. It
              creates a rest and a light bridge while keeping both clauses at
              equal weight.
            </p>
          </section>

          <section>
            <p className="onboarding-writing-rule-number">03 · SIDE THOUGHTS</p>
            <h3>Subordinate on purpose.</h3>
            <p>
              Parentheses lower a thought beneath the main line. Use them when
              that hierarchy is intentional; use an em dash when an interjection
              should meet its surrounding clauses as an equal.
            </p>
            <dl className="onboarding-punctuation-key">
              <div>
                <dt>—</dt>
                <dd>rest or named transition</dd>
              </div>
              <div>
                <dt>( )</dt>
                <dd>deliberate subordination</dd>
              </div>
              <div>
                <dt>–</dt>
                <dd>range or relationship</dd>
              </div>
            </dl>
          </section>
        </div>

        <footer className="onboarding-writing-guide-foot">
          <strong>Evaluate the writer, not just the writing.</strong>
          <span>
            The finished sentence shows the result. Its trace reveals what the
            writer noticed, resisted, revised, and valued—the richer signal a
            reader or AI can actually learn from.
          </span>
        </footer>
      </article>
    </section>
  );
}

export function OnboardingGuide({
  stage,
  onDismiss,
  onOpenLessons,
  onScanFile,
  canScan,
  lesson,
}: {
  stage: OnboardingStage;
  onDismiss: () => void;
  onOpenLessons: () => void;
  onScanFile: () => void;
  canScan: boolean;
  lesson?: ModelLessonResume;
}) {
  if (stage === "model-complete") {
    return (
      <div className="onboarding-complete-overlay">
        <section
          className="onboarding-complete-card"
          role="dialog"
          aria-modal="true"
          aria-labelledby="model-onboarding-complete-title"
        >
          <p className="onboarding-kicker">AI CONTEXT COMPLETE</p>
          <h2 id="model-onboarding-complete-title">You gave the AI a process, not just prose.</h2>
          <p>
            Focus chose the target. Mounting included the source. Shielding kept
            the private note out. The Inspector showed the exact request, and
            Replay made the AI contribution inspectable alongside your own choices.
          </p>
          <div className="onboarding-complete-actions">
            <button type="button" className="onboarding-primary" onClick={onOpenLessons} autoFocus>
              Back to lessons
            </button>
            <button type="button" className="onboarding-text-button" onClick={onDismiss}>
              Keep writing
            </button>
          </div>
        </section>
      </div>
    );
  }

  if (stage === "scan-complete") {
    return (
      <div className="onboarding-complete-overlay">
        <section
          className="onboarding-complete-card"
          role="dialog"
          aria-modal="true"
          aria-labelledby="scan-onboarding-complete-title"
        >
          <p className="onboarding-kicker">SCAN COMPLETE</p>
          <h2 id="scan-onboarding-complete-title">The file arrived with its origin intact.</h2>
          <p>
            The outside file now lives in the private, read-only Scan inbox. Use
            it as source material, or adopt it into Root when you want to make it
            your own.
          </p>
          <div className="onboarding-complete-actions">
            <button type="button" className="onboarding-primary" onClick={onOpenLessons} autoFocus>
              Back to lessons
            </button>
            <button type="button" className="onboarding-text-button" onClick={onDismiss}>
              Inspect the file
            </button>
          </div>
        </section>
      </div>
    );
  }

  if (stage === "complete") {
    return (
      <div className="onboarding-complete-overlay">
        <section
          className="onboarding-complete-card"
          role="dialog"
          aria-modal="true"
          aria-labelledby="onboarding-complete-title"
        >
          <p className="onboarding-kicker">TRACE COMPLETE</p>
          <h2 id="onboarding-complete-title">The rewrite is now part of the work.</h2>
          <p>
            The final line shows what survived. The trace also preserves what you
            tried, removed, and rewrote. That richer process can help an AI infer
            your style and values without making you spell out every rule.
          </p>
          <dl className="onboarding-gestures">
            <div>
              <dt>Step</dt>
              <dd>Make a private checkpoint.</dd>
            </div>
            <div>
              <dt>Send</dt>
              <dd>Open one exact version for discussion.</dd>
            </div>
            <div>
              <dt>Attest</dt>
              <dd>Stand behind a sent version.</dd>
            </div>
          </dl>
          <div className="onboarding-complete-actions">
            <button type="button" className="onboarding-primary" onClick={onOpenLessons} autoFocus>
              Back to lessons
            </button>
            <button type="button" className="onboarding-text-button" onClick={onDismiss}>
              Keep writing
            </button>
          </div>
        </section>
      </div>
    );
  }

  if (stage === "scan-file") {
    return (
      <aside
        className="onboarding-coachmark onboarding-coachmark--scan"
        role="status"
        aria-live="polite"
      >
        <button
          type="button"
          className="onboarding-coachmark-dismiss"
          aria-label="End onboarding"
          title="End onboarding"
          onClick={onDismiss}
        >
          ×
        </button>
        <p className="onboarding-kicker">SCAN · 1 OF 1</p>
        <h2>Choose one outside file</h2>
        <p className="onboarding-coachmark-body">
          Scan keeps the source read-only and visibly external. It does not
          silently turn someone else’s text into your own.
        </p>
        <button
          type="button"
          className="onboarding-primary onboarding-coachmark-action"
          onClick={onScanFile}
          disabled={!canScan}
        >
          {canScan ? "Choose a file" : "Desktop only"}
        </button>
      </aside>
    );
  }

  const content =
    stage === "awaiting-edit"
      ? {
          step: "PROOF 1 OF 3",
          title: "Change one line",
          body: "Rewrite a sentence rather than only adding one. The path from the old words to the new ones is useful context, and it stays local until you Step it.",
          placement: "editor",
        }
      : stage === "awaiting-step"
        ? {
            step: "PROOF 2 OF 3",
            title: "Step this version",
            body: "Step signs a checkpoint and keeps it on your local press. Click Step or press Ctrl/Cmd+S.",
            placement: "step",
          }
        : stage === "awaiting-replay"
          ? {
              step: "PROOF 3 OF 3",
              title: "Actions follow focus",
              body: "The trace focused in the directory tree is mirrored in the action palette, so Replay loads its history. Press Play.",
              placement: "replay",
            }
          : stage === "replaying"
            ? {
                step: "PLAYING YOUR TRACE",
                title: "Watch the work form",
                body: "Replay shows the edit as an event, not just a before-and-after snapshot. This is the richer process an AI writing assistant can learn from.",
                placement: "replaying",
              }
            : stage === "context-focus"
              ? {
                  step: "AI CONTEXT · 2 OF 7",
                  title: "Focus the interview brief",
                  body: `Click ${lesson?.targetPath ?? "the lesson brief"} in the directory. Its gold left bar means AI actions target that file; focusing does not add it to an operation selection.`,
                  placement: "model-focus",
                }
              : stage === "context-mount"
                ? {
                    step: "AI CONTEXT · 3 OF 7",
                    title: "Mount the lesson folder",
                    body: `Use the context icon beside ${lesson?.folderPath ?? "the lesson folder"}. The mount decides which neighboring files enter the request; it never changes focus.`,
                    placement: "model-mount",
                  }
                : stage === "context-shield"
                  ? {
                      step: "AI CONTEXT · 4 OF 7",
                      title: "Shield the private note",
                      body: `Use the context icon beside ${lesson?.excludedPath ?? "the private note"} to exclude it. The source stays mounted; the note becomes an explicit boundary.`,
                      placement: "model-shield",
                    }
                  : stage === "context-inspect"
                    ? {
                        step: "AI CONTEXT · 5 OF 7",
                        title: "Inspect and approve",
                        body: "Click the chevron beside Extend in the AI row. It shows the prompt you write and the context it processes so you can mount files to inject into the request—then Approve.",
                        placement: "model-inspect",
                      }
                    : stage === "context-run"
                      ? {
                          step: "AI CONTEXT · 6 OF 7",
                          title: "Run the approved request",
                          body: "Click Extend. The complete response is buffered, the focused revision is checked again, and only then is the result applied once.",
                          placement: "model-run",
                        }
                      : stage === "context-step"
                        ? {
                            step: "AI CONTEXT · 7 OF 7",
                            title: "Step the AI contribution",
                            body: "The result is still local, dirty work. Click Step now to make the AI-authored span a signed checkpoint; AI execution never Steps automatically.",
                            placement: "model-step",
                          }
                        : stage === "context-replay"
                          ? {
                              step: "AI CONTEXT · REPLAY",
                              title: "Replay the exact result",
                              body: "Press Play. Completion is earned only when Replay reaches the Step containing the exact AI span you just approved and applied.",
                              placement: "model-replay",
                            }
            : null;

  if (!content) return null;

  return (
    <aside
      className={`onboarding-coachmark onboarding-coachmark--${content.placement}`}
      role="status"
      aria-live="polite"
    >
      <button
        type="button"
        className="onboarding-coachmark-dismiss"
        aria-label="End onboarding"
        title="End onboarding"
        onClick={onDismiss}
      >
        ×
      </button>
      <p className="onboarding-kicker">{content.step}</p>
      <h2>{content.title}</h2>
      <p>{content.body}</p>
    </aside>
  );
}

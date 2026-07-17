import type { OnboardingStage } from "./onboarding-state.js";
import type { ModelLessonResume } from "./onboarding-state.js";

export function OnboardingWelcome({
  onStart,
  onDismiss,
}: {
  onStart: () => void;
  onDismiss: () => void;
}) {
  return (
    <section className="onboarding-welcome" aria-labelledby="onboarding-welcome-title">
      <div className="onboarding-welcome-proof" aria-hidden="true">
        <span className="onboarding-proof-line" />
        <span className="onboarding-proof-node is-first" />
        <span className="onboarding-proof-node is-second" />
        <span className="onboarding-proof-node is-third" />
        <span className="onboarding-proof-stamp">STEP</span>
      </div>
      <div className="onboarding-welcome-copy">
        <p className="onboarding-kicker">YOUR FIRST TRACE</p>
        <h1 id="onboarding-welcome-title">Make the work inspectable.</h1>
        <p className="onboarding-welcome-lede">
          A trace is a document with signed, replayable history. See who changed
          it, what changed, and which version was shared.
        </p>
        <p className="onboarding-welcome-local">
          Your drafts stay on this computer until you Send them.
        </p>
        <div className="onboarding-welcome-actions">
          <button
            type="button"
            className="onboarding-primary"
            onClick={onStart}
            autoFocus
          >
            Create my first trace
          </button>
          <button type="button" className="onboarding-secondary" onClick={onDismiss}>
            Explore on my own
          </button>
        </div>
        <p className="onboarding-reassurance">
          No account or AI model required.
        </p>
      </div>
    </section>
  );
}

export function OnboardingGuide({
  stage,
  onDismiss,
  onBringFile,
  onConfigureModel,
  canBringFile,
  lesson,
}: {
  stage: OnboardingStage;
  onDismiss: () => void;
  onBringFile: () => void;
  onConfigureModel: () => void;
  canBringFile: boolean;
  lesson?: ModelLessonResume;
}) {
  if (stage === "model-complete") {
    return (
      <div className="onboarding-complete-overlay">
        <section className="onboarding-complete-card" role="dialog" aria-modal="true" aria-labelledby="model-onboarding-complete-title">
          <p className="onboarding-kicker">MODEL CONTEXT COMPLETE</p>
          <h2 id="model-onboarding-complete-title">You controlled what the model knew.</h2>
          <p>
            Focus chose the target. Mounting included the lesson folder. Shielding excluded the private note. Inspector showed the exact request, and the later Step made the MODEL contribution replayable.
          </p>
          <button type="button" className="onboarding-primary" onClick={onDismiss} autoFocus>
            Continue writing
          </button>
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
          <h2 id="onboarding-complete-title">You made a trace.</h2>
          <p>
            Your edit is now a signed local checkpoint. If you later Send this
            version, its recipient can inspect the same history.
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
            {canBringFile && (
              <button type="button" className="onboarding-primary" onClick={onBringFile} autoFocus>
                Bring in a real file
              </button>
            )}
            <button
              type="button"
              className={canBringFile ? "onboarding-secondary" : "onboarding-primary"}
              onClick={onConfigureModel}
              autoFocus={!canBringFile}
            >
              Add an AI model
            </button>
            <button type="button" className="onboarding-text-button" onClick={onDismiss}>
              Keep exploring
            </button>
          </div>
        </section>
      </div>
    );
  }

  const content =
    stage === "awaiting-edit"
      ? {
          step: "PROOF 1 OF 3",
          title: "Change one line",
          body: "Make it yours—rewrite the sentence or add something new. Your edit stays buffered locally until you Step it.",
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
                body: "The replay is reading the signed checkpoints and editor actions you just created.",
                placement: "replaying",
              }
            : stage === "context-focus"
              ? {
                  step: "MODEL CONTEXT · 2 OF 7",
                  title: "Focus the interview brief",
                  body: `Click ${lesson?.targetPath ?? "the lesson brief"} in the directory. Its gold left bar means MODEL actions target that file; focusing does not add it to an operation selection.`,
                  placement: "model-focus",
                }
              : stage === "context-mount"
                ? {
                    step: "MODEL CONTEXT · 3 OF 7",
                    title: "Mount the lesson folder",
                    body: `Use the context icon beside ${lesson?.folderPath ?? "the lesson folder"}. The mount decides which neighboring files enter the request; it never changes focus.`,
                    placement: "model-mount",
                  }
                : stage === "context-shield"
                  ? {
                      step: "MODEL CONTEXT · 4 OF 7",
                      title: "Shield the private note",
                      body: `Use the context icon beside ${lesson?.excludedPath ?? "the private note"} to exclude it. The source stays mounted; the note becomes an explicit boundary.`,
                      placement: "model-shield",
                    }
                  : stage === "context-inspect"
                    ? {
                        step: "MODEL CONTEXT · 5 OF 7",
                        title: "Inspect and approve",
                        body: "Click the token count in the MODEL row. In Extend, verify the focused brief, mounted interview source, shield decision, provider, and exact messages—then Approve.",
                        placement: "model-inspect",
                      }
                    : stage === "context-run"
                      ? {
                          step: "MODEL CONTEXT · 6 OF 7",
                          title: "Run the approved request",
                          body: "Click Extend. The complete response is buffered, the focused revision is checked again, and only then is the result applied once.",
                          placement: "model-run",
                        }
                      : stage === "context-step"
                        ? {
                            step: "MODEL CONTEXT · 7 OF 7",
                            title: "Step the MODEL contribution",
                            body: "The result is still local, dirty work. Click Step now to make the MODEL-authored span a signed checkpoint; MODEL execution never Steps automatically.",
                            placement: "model-step",
                          }
                        : stage === "context-replay"
                          ? {
                              step: "MODEL CONTEXT · REPLAY",
                              title: "Replay the exact result",
                              body: "Press Play. Completion is earned only when Replay reaches the Step containing the exact MODEL span you just approved and applied.",
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

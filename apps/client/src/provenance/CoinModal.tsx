import {
  type FormEvent,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import {
  coinOriginFromEvent,
  fetchEventById,
  type CoinOrigin,
} from "./provenance.js";

export interface CoinViewProps {
  name: string;
  phrase: string;
  nodeId: string;
}

/** Read-only tab surface for an immutable passage in Mint. */
export function CoinView({ name, phrase, nodeId }: CoinViewProps) {
  const titleId = useId();
  const descriptionId = useId();
  const [origin, setOrigin] = useState<CoinOrigin | null | undefined>(undefined);

  useEffect(() => {
    if (!nodeId) {
      setOrigin(null);
      return;
    }
    let cancelled = false;
    setOrigin(undefined);
    void fetchEventById(nodeId)
      .then((event) => {
        if (!cancelled) setOrigin(event ? coinOriginFromEvent(event) : null);
      })
      .catch(() => {
        if (!cancelled) setOrigin(null);
      });
    return () => {
      cancelled = true;
    };
  }, [nodeId]);

  const originLabel = origin === undefined
    ? "Loading…"
    : origin?.kind === "direct"
      ? "Direct"
      : origin?.kind === "extracted"
        ? "Extracted"
        : "Unavailable";

  return (
    <article
      className="coin-view"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
    >
      <div className="coin-view-content">
        <header className="coin-view-header">
          <p className="coin-modal-kicker">
            {origin?.kind === "direct"
              ? "Direct Coin"
              : origin?.kind === "extracted"
                ? "Extracted Coin"
                : "Immutable Coin"}
          </p>
          <h2 id={titleId} className="coin-view-title">{name}</h2>
        </header>

        <blockquote id={descriptionId} className="coin-modal-phrase">
          {phrase}
        </blockquote>

        <dl className="coin-modal-meta">
          <div>
            <dt>Origin</dt>
            <dd>{originLabel}</dd>
          </div>
          {origin?.kind === "extracted" && (
            <div>
              <dt>Source node</dt>
              <dd><code>{origin.sourceNodeId}</code></dd>
            </div>
          )}
          {origin?.kind === "extracted" && (
            <>
              <div>
                <dt>Source range</dt>
                <dd>{origin.range.start}–{origin.range.end}</dd>
              </div>
              <div>
                <dt>Source hash</dt>
                <dd><code>{origin.sourceContentHash}</code></dd>
              </div>
            </>
          )}
          <div>
            <dt>Signed node</dt>
            <dd><code>{nodeId}</code></dd>
          </div>
        </dl>

        <p className="coin-modal-hint">
          Coins are read-only. Drag this Coin from Mint into Root to fork an editable copy.
        </p>
      </div>
    </article>
  );
}

export interface DirectCoinComposerViewProps {
  phrase: string;
  busy: boolean;
  error: string | null;
  onPhraseChange: (phrase: string) => void;
  onMint: () => void;
  onClose: () => void;
}

/** Session-owned direct-Coin draft rendered inside a normal panel tab. */
export function DirectCoinComposerView({
  phrase,
  busy,
  error,
  onPhraseChange,
  onMint,
  onClose,
}: DirectCoinComposerViewProps) {
  const titleId = useId();
  const hintId = useId();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const canMint = phrase.trim().length > 0 && !busy;

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (canMint) onMint();
  }

  return (
    <section
      className="coin-view coin-composer-view"
      aria-labelledby={titleId}
      aria-describedby={hintId}
    >
      <div className="coin-view-content">
        <header className="coin-view-header">
          <p className="coin-modal-kicker">Direct Coin</p>
          <h2 id={titleId} className="coin-view-title">Mint a Coin</h2>
        </header>
        <form className="coin-composer-form" onSubmit={submit}>
          <textarea
            ref={inputRef}
            className="coin-modal-phrase coin-composer-input"
            value={phrase}
            placeholder="Write the exact passage to mint…"
            rows={7}
            disabled={busy}
            aria-label="Coin text"
            aria-invalid={!!error}
            onChange={(event) => onPhraseChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                if (canMint) onMint();
              }
            }}
          />
          <p id={hintId} className="coin-modal-hint">
            This mints the text as one immutable Coin signed by the active pen. It makes no source-trace claim.
          </p>
          {error && <p className="create-error" role="alert">{error}</p>}
          <div className="coin-modal-actions">
            <button type="button" className="confirm-cancel" disabled={busy} onClick={onClose}>
              Close tab
            </button>
            <button type="submit" className="coin-mint-submit" disabled={!canMint}>
              {busy ? "Minting…" : "Mint Coin"}
            </button>
          </div>
        </form>
      </div>
    </section>
  );
}

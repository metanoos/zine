import {
  type FormEvent,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import {
  coinOriginFromEvent,
  fetchEventById,
  type CoinOrigin,
} from "./provenance.js";
import {
  discoverCoinCitations,
  type VerifiedRendezvousCandidate,
} from "./rendezvous.js";
import {
  kademliaEnabledSnapshot,
  subscribeKademliaConfig,
} from "../networking/kademlia.js";
import { isTauri } from "../identity/identity.js";

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
  const coinsEnabled = useSyncExternalStore(
    subscribeKademliaConfig,
    kademliaEnabledSnapshot,
    () => false,
  );
  const rendezvousEnabled = isTauri() && coinsEnabled;
  const [candidates, setCandidates] = useState<VerifiedRendezvousCandidate[]>([]);
  const [rendezvousState, setRendezvousState] = useState<"off" | "loading" | "done" | "error">(
    rendezvousEnabled ? "loading" : "off",
  );

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

  useEffect(() => {
    if (!rendezvousEnabled || !phrase) {
      setCandidates([]);
      setRendezvousState("off");
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    setRendezvousState("loading");
    void discoverCoinCitations(phrase, { signal: controller.signal })
      .then((next) => {
        if (!cancelled) {
          setCandidates(next);
          setRendezvousState("done");
        }
      })
      .catch(() => {
        if (!cancelled) {
          setCandidates([]);
          setRendezvousState("error");
        }
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [phrase, rendezvousEnabled]);

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
          <div>
            <dt>Rendezvous</dt>
            <dd>
              {rendezvousState === "off"
                ? "Off"
                : rendezvousState === "loading"
                  ? "Searching…"
                  : rendezvousState === "error"
                    ? "Unavailable"
                    : `${candidates.length} verified ${candidates.length === 1 ? "candidate" : "candidates"}`}
            </dd>
          </div>
        </dl>

        {candidates.length > 0 && (
          <ul className="coin-rendezvous-list" aria-label="Verified global citation candidates">
            {candidates.map((candidate) => (
              <li key={candidate.eventId}>
                <code title={candidate.signerPubkey}>{candidate.signerPubkey.slice(0, 12)}…</code>
                <span>
                  {candidate.targetNodeIds.includes(nodeId)
                    ? "cited this exact Coin"
                    : "cited matching Coin text"}
                </span>
                <code title={candidate.relayUrls.join("\n")}>
                  via {candidate.relayUrls.length} {candidate.relayUrls.length === 1 ? "relay" : "relays"}
                </code>
              </li>
            ))}
          </ul>
        )}

        <p className="coin-modal-hint">
          Coins are read-only. Drag this Coin from Mint into Root to fork an editable copy.
          {rendezvousEnabled && " Rendezvous candidates are discovery pointers, not Coin supply, trust, or reputation."}
        </p>
      </div>
    </article>
  );
}

/** Read-only quarantine surface for Mint-path files created before (or left
 * behind by) the transactional publication boundary. They are deliberately
 * not described as Coins and never start rendezvous discovery. */
export function IncompleteMintView({ name, phrase }: Pick<CoinViewProps, "name" | "phrase">) {
  const titleId = useId();
  const descriptionId = useId();
  return (
    <article
      className="coin-view incomplete-mint-view"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
    >
      <div className="coin-view-content">
        <header className="coin-view-header">
          <p className="coin-modal-kicker">Incomplete Mint artifact</p>
          <h2 id={titleId} className="coin-view-title">{name}</h2>
        </header>
        <blockquote id={descriptionId} className="coin-modal-phrase">{phrase}</blockquote>
        <p className="coin-modal-hint">
          This local artifact has no durable record that its signed genesis and same-minter
          attestation were published. It is not a Coin and is excluded from citation and
          rendezvous. Mint the passage again to complete the public transaction.
        </p>
      </div>
    </article>
  );
}

export interface DirectCoinComposerViewProps {
  phrase: string;
  enabled: boolean;
  busy: boolean;
  error: string | null;
  onPhraseChange: (phrase: string) => void;
  onMint: () => void;
  onClose: () => void;
}

/** Session-owned direct-Coin draft rendered inside a normal panel tab. */
export function DirectCoinComposerView({
  phrase,
  enabled,
  busy,
  error,
  onPhraseChange,
  onMint,
  onClose,
}: DirectCoinComposerViewProps) {
  const titleId = useId();
  const hintId = useId();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const canMint = enabled && phrase.trim().length > 0 && !busy;

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
            disabled={busy || !enabled}
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
            {enabled
              ? "Mint, publish, and attest this exact text as a public immutable Coin signed by the active pen. The text will be public through configured publication relays. It makes no source-trace claim."
              : "Enable Coins in Networking to mint this passage."}
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

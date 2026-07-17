import { useState } from "react";
import { Check, Copy } from "lucide-react";

const RAW_PUBKEY = /^[0-9a-f]{64}$/i;

/** Canonical user-facing pubkey form. Invalid values remain visible for diagnostics. */
export function formatPubkey(pubkey: string): string {
  if (!RAW_PUBKEY.test(pubkey)) return pubkey;
  return `${pubkey.slice(0, 4)}...${pubkey.slice(-4)}`;
}

export function PubkeyCopyButton({
  pubkey,
  className = "",
  style,
  tabIndex,
}: {
  pubkey: string;
  className?: string;
  style?: React.CSSProperties;
  tabIndex?: number;
}) {
  const [copied, setCopied] = useState(false);

  if (!RAW_PUBKEY.test(pubkey)) return null;

  async function copy(event: React.MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    try {
      if (!navigator.clipboard) return;
      await navigator.clipboard.writeText(pubkey);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      setCopied(false);
    }
  }

  return (
    <button
      type="button"
      className={`pubkey-copy-btn${className ? ` ${className}` : ""}`}
      title="Copy pubkey (hex)"
      aria-label="Copy pubkey (hex)"
      style={style}
      tabIndex={tabIndex}
      onClick={(event) => void copy(event)}
    >
      {copied ? <Check size={12} aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}
    </button>
  );
}

/** Standard standalone pubkey: first four, three dots, last four, copy. */
export function PubkeyDisplay({
  pubkey,
  className = "",
}: {
  pubkey: string;
  className?: string;
}) {
  return (
    <span className={`pubkey-display${className ? ` ${className}` : ""}`}>
      <code className="pubkey-display-code" title={pubkey}>{formatPubkey(pubkey)}</code>
      <PubkeyCopyButton pubkey={pubkey} />
    </span>
  );
}

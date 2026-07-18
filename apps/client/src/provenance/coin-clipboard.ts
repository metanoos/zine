/**
 * Session-local clipboard envelope for provenance-aware copy/paste.
 *
 * The system clipboard still carries ordinary `text/plain`, so copying out of
 * Zine behaves like every other editor. This private MIME value carries only
 * an opaque ticket for an exact stepped-source citation already known to the press that
 * performed the copy. A foreign/stale/stripped ticket therefore degrades to
 * plain text instead of becoming an asserted citation. Copy never mints.
 */

export const COIN_CLIPBOARD_MIME = "application/x-zine-coin-ref+json";
export const COIN_CLIPBOARD_VERSION = 1 as const;

export interface CoinClipboardEnvelope {
  v: typeof COIN_CLIPBOARD_VERSION;
  ticket: string;
}

export function serializeCoinClipboardEnvelope(ticket: string): string {
  if (!ticket) return "";
  return JSON.stringify({ v: COIN_CLIPBOARD_VERSION, ticket });
}

export function parseCoinClipboardEnvelope(raw: string): CoinClipboardEnvelope | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as { v?: unknown; ticket?: unknown };
    if (
      value.v !== COIN_CLIPBOARD_VERSION ||
      typeof value.ticket !== "string" ||
      value.ticket.length === 0
    ) {
      return null;
    }
    return { v: COIN_CLIPBOARD_VERSION, ticket: value.ticket };
  } catch {
    return null;
  }
}

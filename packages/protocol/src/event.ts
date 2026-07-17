/** Minimal NIP-01 event shape consumed by the protocol kernel. */
export interface ProtocolEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

/** Cryptographic event verification remains a caller-owned trust dependency. */
export type TraceEventVerifier = (event: ProtocolEvent) => boolean;

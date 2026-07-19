/**
 * Fuzzy quote matching via MinHash + LSH (protocol/rendezvous.md §R2).
 *
 * The exact coordinate `H` (quoteHash) only collides on byte-identical text
 * (after canonicalization). Two people quoting slightly different excerpts of
 * the same passage — one a sentence, the other the surrounding paragraph —
 * produce different H values and miss each other. This module is the
 * client-side layer that makes near-duplicates addressable.
 *
 * The technique: shingle the text → MinHash signature → LSH banding. The
 * pigeonhole theorem guarantees any two quotes above a similarity threshold
 * collide on at least one band-prefix, so a querier computes their own
 * band-prefixes, does one lookup per band, and gathers candidates — then
 * verifies by actual Jaccard similarity.
 *
 * Pure — no IO, no relay. This layer sits above the exact coordinate (H) and
 * below the DHT/co-Mint discovery layer. The protocol coordinate is always
 * exact; this is recall-maximizing client logic.
 *
 * Tunable parameters (rendezvous.md open questions — need real corpora):
 *   - SHINGLE_K: word-level k (default 3 — word trigrams)
 *   - SIGNATURE_LEN: number of hash functions (default 128)
 *   - BANDS: LSH band count (default 32)
 *   - These yield a similarity threshold S ≈ (1/BANDS)^(1/(SIGNATURE_LEN/BANDS))
 *     ≈ (1/32)^(1/4) ≈ 0.42 — quotes above ~42% Jaccard similarity collide.
 */

// --- Parameters --------------------------------------------------------

/** Shingle size in words. Word trigrams capture local phrase structure. */
export const SHINGLE_K = 3;
/** Number of hash functions in the MinHash signature. Higher = more precise
 *  similarity estimate, more bytes per signature. */
export const SIGNATURE_LEN = 128;
/** LSH band count. More bands = lower threshold (more collisions, more recall,
 *  more false positives to verify). SIGNATURE_LEN must be divisible by BANDS. */
export const BANDS = 32;
/** Rows per band = SIGNATURE_LEN / BANDS. */
const ROWS = SIGNATURE_LEN / BANDS;

// --- Shingling ---------------------------------------------------------

/** Split text into word-level k-shingles (overlapping n-grams of k words).
 *  Whitespace-normalized first (same spirit as canonicalQuoteText, but simpler
 *  — the canonical H already handles NFC; this just needs word boundaries). */
export function shingle(text: string, k: number = SHINGLE_K): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length < k) return words.length > 0 ? [words.join(" ")] : [];
  const out: string[] = [];
  for (let i = 0; i <= words.length - k; i++) {
    out.push(words.slice(i, i + k).join(" "));
  }
  return out;
}

// --- MinHash -----------------------------------------------------------

/** A simple deterministic hash for shingles (FNV-1a 32-bit). Returns a uint32.
 *  Used as the base hash for MinHash — the signature is built by applying
 *  SIGNATURE_LEN different seed-augmented hashes. */
function fnv1a32(str: string, seed: number): number {
  let hash = 2166136261 ^ seed;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** Compute the MinHash signature of a set of shingles. Each of the SIGNATURE_LEN
 *  positions holds the minimum hash value across all shingles under that
 *  position's seed. The signature approximates the Jaccard similarity: the
 *  fraction of matching positions between two signatures ≈ Jaccard(shingleA, shingleB). */
export function minHashSignature(shingles: string[]): Uint32Array {
  const sig = new Uint32Array(SIGNATURE_LEN);
  // Initialize to max so any real hash is smaller.
  sig.fill(0xffffffff);
  for (const s of shingles) {
    for (let i = 0; i < SIGNATURE_LEN; i++) {
      const h = fnv1a32(s, i);
      if (h < sig[i]) sig[i] = h;
    }
  }
  return sig;
}

/** Estimate Jaccard similarity from two MinHash signatures (fraction of
 *  matching positions). 0 = disjoint, 1 = identical. */
export function estimateJaccard(a: Uint32Array, b: Uint32Array): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) matches++;
  }
  return matches / a.length;
}

/** Exact Jaccard similarity between two shingle sets (for verification — the
 *  ground truth the LSH candidates are checked against). */
export function exactJaccard(setA: string[], setB: string[]): number {
  const a = new Set(setA);
  const b = new Set(setB);
  let intersection = 0;
  for (const s of a) if (b.has(s)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// --- LSH banding -------------------------------------------------------

/** Compute the LSH band-prefixes for a MinHash signature. Each band is a
 *  string key (the concatenation of its ROWS hash values). Two signatures
 *  that agree on all ROWS values in any band collide on that band's key.
 *
 *  Returns BANDS keys. A querier publishes/looks-up under each key; any
 *  candidate that shares at least one band-prefix is a potential near-duplicate. */
export function lshBands(sig: Uint32Array, bands: number = BANDS): string[] {
  const rows = sig.length / bands;
  const keys: string[] = [];
  for (let b = 0; b < bands; b++) {
    const slice = sig.subarray(b * rows, (b + 1) * rows);
    keys.push(`b${b}:${[...slice].join(",")}`);
  }
  return keys;
}

/** Compute the LSH lookup keys for a quote (shingle → signature → bands).
 *  These are the keys a querier would publish under / look up in addition to
 *  the exact H coordinate. */
export function quoteFuzzyKeys(text: string, bands: number = BANDS): string[] {
  return lshBands(minHashSignature(shingle(text)), bands);
}

// --- The similarity threshold (for documentation / tuning) -------------

/** The approximate Jaccard threshold above which LSH banding guarantees a
 *  collision. S ≈ (1/BANDS)^(1/ROWS). Quotes above this similarity WILL
 *  collide on at least one band; quotes below MAY or MAY NOT. */
export function lshThreshold(bands: number = BANDS, rows: number = ROWS): number {
  return Math.pow(1 / bands, 1 / rows);
}

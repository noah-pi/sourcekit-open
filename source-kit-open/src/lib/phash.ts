// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * DCT perceptual hash.
 *
 * The classic pHash: 32×32 grayscale → DCT-II → the 8×8 lowest-frequency
 * coefficients → one bit per coefficient against their median (DC excluded
 * from the median, per the reference algorithm) → 64 bits, 8 bytes.
 *
 * WHY: near-duplicate detection and sidecar re-association. Two photos
 * of the same scene — or one photo and its recompressed/cropped derivative —
 * land within a few bits of each other; unrelated photos sit ~32 bits apart.
 *
 * HONESTY: a pHash match is a LEAD, never a verdict. It says "these look
 * alike", nothing more — cropping, collages, and coincidental similarity all
 * produce matches, and an adversary can engineer them. Distance thresholds
 * are corpus-calibrated before any UI leans on them.
 *
 * PRIVACY: the hash lives in the vault index (app-sandbox plaintext, like
 * the exact sha256 already stored there). It is a coarse perceptual
 * fingerprint — a holder of a known-image hash list could approximate-match
 * it. Never embedded in the signed record, never transmitted.
 */

export const PHASH_SIZE = 32;
export const PHASH_LOW = 8;
export const PHASH_HEX_LEN = 16; // 64 bits

// Precomputed cosine table: COS[u][x] = cos((2x+1)uπ / 64)
const COS: number[][] = (() => {
  const t: number[][] = [];
  for (let u = 0; u < PHASH_LOW; u++) {
    const row: number[] = [];
    for (let x = 0; x < PHASH_SIZE; x++) {
      row.push(Math.cos(((2 * x + 1) * u * Math.PI) / (2 * PHASH_SIZE)));
    }
    t.push(row);
  }
  return t;
})();

/**
 * 64-bit pHash of a 32×32 grayscale image (row-major, one byte per pixel).
 * Returns null on malformed input — never throws.
 */
export function pHashFromGray32(gray: ArrayLike<number>): string | null {
  if (!gray || gray.length !== PHASH_SIZE * PHASH_SIZE) return null;

  // DCT-II, keeping only the 8×8 lowest-frequency coefficients.
  const coeff = new Float64Array(PHASH_LOW * PHASH_LOW);
  for (let v = 0; v < PHASH_LOW; v++) {
    for (let u = 0; u < PHASH_LOW; u++) {
      let sum = 0;
      const cosU = COS[u];
      const cosV = COS[v];
      for (let y = 0; y < PHASH_SIZE; y++) {
        const rowBase = y * PHASH_SIZE;
        const cv = cosV[y];
        for (let x = 0; x < PHASH_SIZE; x++) {
          sum += gray[rowBase + x] * cosU[x] * cv;
        }
      }
      const cu = u === 0 ? Math.SQRT1_2 : 1;
      const cv = v === 0 ? Math.SQRT1_2 : 1;
      coeff[v * PHASH_LOW + u] = 0.25 * cu * cv * sum;
    }
  }

  // Median of the 63 non-DC coefficients (DC only carries brightness).
  const rest = Array.from(coeff.subarray(1)).sort((a, b) => a - b);
  const median = rest[Math.floor(rest.length / 2)];

  // One bit per coefficient (DC included in the comparison, per reference).
  const out = new Uint8Array(8);
  for (let i = 0; i < 64; i++) {
    if (coeff[i] > median) out[i >> 3] |= 0x80 >> (i & 7);
  }
  return Array.from(out, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Hamming distance between two 16-hex-char pHashes. Null on malformed input
 * — callers must treat null as "incomparable", never as zero distance.
 */
export function hammingDistanceHex(a: string, b: string): number | null {
  if (!/^[0-9a-f]{16}$/.test(a) || !/^[0-9a-f]{16}$/.test(b)) return null;
  let dist = 0;
  for (let i = 0; i < 8; i++) {
    let x = parseInt(a.slice(i * 2, i * 2 + 2), 16) ^ parseInt(b.slice(i * 2, i * 2 + 2), 16);
    while (x) {
      dist += x & 1;
      x >>= 1;
    }
  }
  return dist;
}

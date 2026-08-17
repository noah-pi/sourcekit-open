// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * pHash — the soft binding for proof↔media recovery (docs/RECOVERY.md).
 *
 * 64-bit DCT perceptual hash. The DCT, bit order, and hex encoding are the
 * SHARED implementation (@exhibit/lib/phash) — the same module the camera
 * app uses for its vault-index hashes — so a hash computed
 * here is bit-comparable with a hash computed on-device. This file is only
 * the browser adapter (canvas → 32×32 grayscale) plus the desk's grading.
 * The luma rounding matches the device path exactly (ITU-R 601, rounded
 * to bytes) — residual distance comes from resampling alone.
 *
 * Honesty rule, enforced by every UI that consumes this: a pHash match is
 * a LEAD ("likely match — confirm visually"), never a verdict. Only an
 * exact SHA-256 match is certain.
 */

import { pHashFromGray32, hammingDistanceHex, PHASH_SIZE } from '@exhibit/lib/phash';

/** Compute the 64-bit pHash of an image element/bitmap. Returns hex (16 chars). */
export async function pHashFromImage(source: CanvasImageSource, width: number, height: number): Promise<string> {
  const canvas = document.createElement('canvas');
  canvas.width = PHASH_SIZE;
  canvas.height = PHASH_SIZE;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('no 2d context');
  ctx.drawImage(source, 0, 0, width, height, 0, 0, PHASH_SIZE, PHASH_SIZE);
  const data = ctx.getImageData(0, 0, PHASH_SIZE, PHASH_SIZE).data;

  // ITU-R 601 luma, rounded to bytes — bit-identical to the device path.
  const gray = new Uint8Array(PHASH_SIZE * PHASH_SIZE);
  for (let i = 0; i < gray.length; i++) {
    const o = i * 4;
    gray[i] = Math.round(0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2]);
  }
  const hex = pHashFromGray32(gray);
  if (!hex) throw new Error('phash failed');
  return hex;
}

/** Hamming distance between two 64-bit pHashes (hex). Throws on malformed input. */
export function hammingDistance(aHex: string, bHex: string): number {
  const d = hammingDistanceHex(aHex, bHex);
  if (d === null) throw new Error('malformed pHash');
  return d;
}

export type MatchGrade = 'exact' | 'likely' | 'possible' | 'none';

/**
 * The two-grade honesty model from docs/RECOVERY.md: exact is certain;
 * everything else is a lead with a stated confidence. Thresholds are
 * tuning parameters (desk-configurable), not science — they get
 * corpus-calibrated before any prominence.
 */
export function gradeMatch(shaMatch: boolean, distance: number | null, likelyMax = 6, possibleMax = 10): MatchGrade {
  if (shaMatch) return 'exact';
  if (distance === null) return 'none';
  if (distance <= likelyMax) return 'likely';
  if (distance <= possibleMax) return 'possible';
  return 'none';
}

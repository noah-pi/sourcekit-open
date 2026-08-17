// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * grayMatch — the shared on-device image math for the forensic cards.
 *
 * Everything here is MEASUREMENT, never verdict: decode two frames to small
 * grayscale planes and compare them with normalized cross-correlation (NCC)
 * or sum-of-absolute-differences (SAD) block matching. The cards report the
 * numbers; a person weighs them.
 *
 * Hermes constraints (do not relax):
 *  - jpeg-js MUST be called with { useTArray: true } — its default path
 *    allocates via Buffer.alloc, which does not exist under Hermes.
 *  - Downscale BEFORE decode: jpeg-js reads baseline JPEG at full
 *    resolution, so a 12 MP source is first resized to a tiny JPEG by
 *    expo-image-manipulator (native) and only then decoded in JS.
 */

import * as FileSystem from 'expo-file-system/legacy';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import { decode as jpegDecode } from 'jpeg-js';

import { base64ToBytes } from '../../lib/bytes';
import { writeFileBytes } from '../../lib/fileHash';

export interface GrayPlane {
  width: number;
  height: number;
  /** One luma byte per pixel, row-major (ITU-R 601). */
  gray: Uint8Array;
}

/** Sealed evidence paths carry no file:// prefix — the file APIs want one. */
export function toFileUri(path: string): string {
  return path.startsWith('file://') || path.startsWith('content://') ? path : `file://${path}`;
}

/** RGBA → luma plane (ITU-R 601, the same conversion the vault pHash uses). */
export function rgbaToGray(rgba: Uint8Array, width: number, height: number): Uint8Array {
  const gray = new Uint8Array(width * height);
  for (let i = 0; i < gray.length; i++) {
    const o = i * 4;
    gray[i] = Math.round(rgba[o] * 0.299 + rgba[o + 1] * 0.587 + rgba[o + 2] * 0.114);
  }
  return gray;
}

/**
 * Decode an on-disk image to a grayscale plane of exactly width × height.
 * Both dimensions are forced so two sources with different aspect ratios
 * land on the same comparison grid; the caller states the grid size.
 * Throws on any failure — callers render the neutral "could not be
 * computed on this device" state.
 */
export async function decodeUriToGray(uri: string, width: number, height: number): Promise<GrayPlane> {
  const out = await manipulateAsync(
    toFileUri(uri),
    [{ resize: { width, height } }],
    { compress: 0.9, format: SaveFormat.JPEG, base64: true },
  );
  if (!out.base64) throw new Error('resize produced no bytes');
  const decoded = jpegDecode(base64ToBytes(out.base64), { maxMemoryUsageInMB: 2, useTArray: true });
  if (decoded.width !== width || decoded.height !== height) throw new Error('unexpected decode size');
  return { width, height, gray: rgbaToGray(decoded.data as Uint8Array, width, height) };
}

/** Decode in-memory JPEG bytes (e.g. a committed secondary frame) the same way. */
export async function decodeBytesToGray(bytes: Uint8Array, width: number, height: number, tmpName: string): Promise<GrayPlane> {
  const tmp = `${FileSystem.cacheDirectory}${tmpName}`;
  try {
    await writeFileBytes(tmp, bytes);
    return await decodeUriToGray(tmp, width, height);
  } finally {
    await FileSystem.deleteAsync(tmp, { idempotent: true }).catch(() => {});
  }
}

/** Normalized cross-correlation of two equal-length sample vectors, -1..1. */
export function ncc(a: Uint8Array, aOff: number, b: Uint8Array, bOff: number, len: number): number {
  let sa = 0;
  let sb = 0;
  for (let i = 0; i < len; i++) {
    sa += a[aOff + i];
    sb += b[bOff + i];
  }
  const ma = sa / len;
  const mb = sb / len;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < len; i++) {
    const xa = a[aOff + i] - ma;
    const xb = b[bOff + i] - mb;
    num += xa * xb;
    da += xa * xa;
    db += xb * xb;
  }
  const den = Math.sqrt(da * db);
  return den > 0 ? num / den : 0;
}

/** Median of a small numeric array (0 for empty). */
export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((x, y) => x - y);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export interface ParallaxResult {
  /** Patches whose best NCC met the threshold. */
  matched: number;
  /** Patches tested. */
  total: number;
  /** Median best-match horizontal offset (secondary relative to primary), px. */
  medianDisparityPx: number;
  /** The NCC a patch had to reach to count as matched — stated in the UI. */
  matchThreshold: number;
}

/**
 * Patch-grid parallax: sample a grid of patches on the primary view and
 * NCC-match each against the secondary view within a horizontal search
 * window at the same row (a two-lens phone rig is horizontally offset).
 * Returns ONLY counts and the median disparity — interpretation is left
 * to the reader, by design.
 */
export function measureParallax(
  primary: GrayPlane,
  secondary: GrayPlane,
  opts?: { patch?: number; stride?: number; search?: number; threshold?: number },
): ParallaxResult {
  const patch = opts?.patch ?? 10;
  const stride = opts?.stride ?? 14;
  const search = opts?.search ?? 14;
  const threshold = opts?.threshold ?? 0.75;
  const w = Math.min(primary.width, secondary.width);
  const h = Math.min(primary.height, secondary.height);

  const disparities: number[] = [];
  let matched = 0;
  let total = 0;
  for (let y = search; y + patch <= h - 2; y += stride) {
    for (let x = search; x + patch <= w - search; x += stride) {
      total++;
      let best = -2;
      let bestDx = 0;
      for (let dx = -search; dx <= search; dx += 1) {
        let score = 0;
        // Row-wise NCC accumulation across the patch's rows.
        let num = 0;
        let da = 0;
        let db = 0;
        let sa = 0;
        let sb = 0;
        const len = patch * patch;
        for (let r = 0; r < patch; r++) {
          const aOff = (y + r) * primary.width + x;
          const bOff = (y + r) * secondary.width + (x + dx);
          for (let c = 0; c < patch; c++) {
            sa += primary.gray[aOff + c];
            sb += secondary.gray[bOff + c];
          }
        }
        const ma = sa / len;
        const mb = sb / len;
        for (let r = 0; r < patch; r++) {
          const aOff = (y + r) * primary.width + x;
          const bOff = (y + r) * secondary.width + (x + dx);
          for (let c = 0; c < patch; c++) {
            const xa = primary.gray[aOff + c] - ma;
            const xb = secondary.gray[bOff + c] - mb;
            num += xa * xb;
            da += xa * xa;
            db += xb * xb;
          }
        }
        const den = Math.sqrt(da * db);
        score = den > 0 ? num / den : 0;
        if (score > best) {
          best = score;
          bestDx = dx;
        }
      }
      if (best >= threshold) {
        matched++;
        disparities.push(bestDx);
      }
    }
  }
  return { matched, total, medianDisparityPx: median(disparities), matchThreshold: threshold };
}

export interface FrameShift {
  dx: number;
  dy: number;
}

/**
 * Whole-frame translation estimate between two same-size gray planes:
 * SAD over a search square, best (dx, dy) wins. One number pair per frame
 * pair — deliberately crude, and stated as such where shown.
 */
export function measureFrameShift(a: GrayPlane, b: GrayPlane, search = 6): FrameShift {
  const w = Math.min(a.width, b.width);
  const h = Math.min(a.height, b.height);
  let bestCost = Number.POSITIVE_INFINITY;
  let best: FrameShift = { dx: 0, dy: 0 };
  for (let dy = -search; dy <= search; dy++) {
    for (let dx = -search; dx <= search; dx++) {
      let cost = 0;
      let n = 0;
      for (let y = search; y < h - search; y += 2) {
        const aRow = y * a.width;
        const bRow = (y + dy) * b.width;
        for (let x = search; x < w - search; x += 2) {
          cost += Math.abs(a.gray[aRow + x] - b.gray[bRow + x + dx]);
          n++;
        }
      }
      if (n > 0 && cost / n < bestCost) {
        bestCost = cost / n;
        best = { dx, dy };
      }
    }
  }
  return best;
}

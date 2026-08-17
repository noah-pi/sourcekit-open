// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Stereo feature extraction front end — the matcher that feeds
 * verifyStereoCommitment.
 *
 * The desk never trusts a device-computed verdict; it trusts committed
 * PIXELS plus committed CALIBRATION. This module is the bridge: given the
 * decoded primary frame (full resolution) and the committed secondary frame
 * (~640×480), it extracts corners in both, describes them, matches them,
 * and pre-filters the matches with the epipolar geometry the committed
 * calibration implies — so downstream (planarity.ts) sees correspondences
 * the desk derived itself, not labels the device attached.
 *
 * Pipeline (all constants at the top of the file):
 *
 *   1. Grayscale (Rec.601 luma) + downscale to a FOCAL-NORMALIZED working
 *      plane. The wide ↔ ultra-wide rig has a ~2:1 focal mismatch, which is
 *      a ~2:1 image-space scale difference for the same scene structure.
 *      Fixed-patch binary descriptors are NOT scale invariant, so instead of
 *      a scale pyramid we resample each frame so both have the same focal
 *      length in pixels (WORKING_FOCAL_PX): scene structure then appears at
 *      the same pixel scale in both working images and one patch size works.
 *      The scale factors come from the COMMITTED intrinsics, not from
 *      anything estimated, and a hard cap (LONG_SIDE_CAP) bounds runtime on
 *      12MP primaries. Output coordinates are upscaled back into the
 *      ORIGINAL pixel grids of both frames, so nothing downstream changes.
 *
 *   2. FAST-9 corners (circle of 16, 9 contiguous above/below the center by
 *      FAST_THRESHOLD), Harris structure-tensor score filtering (rejects
 *      noise and near-edge responses), spatial non-max suppression, and a
 *      per-grid-cell cap. The grid cap matters for the DOWNSTREAM fit, not
 *      cosmetics: a homography RANSAC fed corners clumped on one textured
 *      patch is a badly conditioned measurement of the whole frame.
 *
 *   3. rBRIEF-style 256-bit binary descriptors: intensity comparisons of a
 *      fixed, deterministic set of Gaussian-sampled point pairs inside a
 *      31×31 patch, sampled on a box-smoothed image, with orientation
 *      correction from the patch intensity centroid (as in ORB). ROTATION
 *      ASSUMPTION: the two lenses of a phone rig are mounted on one rigid
 *      plate, so the relative rotation between views is small (a few
 *      degrees of mounting tolerance + user tilt at the moment of capture).
 *      Centroid orientation handles that regime. It is NOT advertised as
 *      handling large in-plane rotation; a rig with large relative roll
 *      will degrade honestly (few matches → 'insufficient-geometry'
 *      downstream), never invent matches.
 *
 *   4. Matching: brute-force Hamming nearest neighbor with a Lowe-style
 *      ratio test, then mutual cross-check (both directions must agree).
 *      RATIO CHOICE: 0.8. For 256-bit binary descriptors the correct-match
 *      Hamming distance clusters around ~30–80 bits while the
 *      second-best/random distance clusters near the 128-bit mean of the
 *      binomial null; 0.8 (≈102 bits) sits between them. It is looser than
 *      the classic 0.7 SIFT ratio because binary descriptors are coarser —
 *      and it does not have to carry the outlier load alone, because of
 *      step 5.
 *
 *   5. Geometric pre-filter with the COMMITTED calibration: the
 *      intrinsics+extrinsics define the essential matrix E = [t]×R, hence a
 *      hard epipolar constraint between the two views. Matches whose
 *      Sampson distance (in normalized pinhole coordinates, threshold in
 *      focal-averaged pixel-equivalents) exceeds EPIPOLAR_SAMPSON_PX are
 *      rejected BEFORE RANSAC ever sees them. This is why the calibration
 *      is committed: the desk does not have to trust unlabeled matches —
 *      geometry labels them. THRESHOLD CHOICE: 2.5 px ≈ 3σ at the assumed
 *      matcher noise floor (σ ≈ 0.5 px/coordinate/view inflating to
 *      ≈ 0.85 focal-averaged px under the ~2:1 focal mismatch, the same
 *      noise model planarity.ts documents). Note what the epipolar filter
 *      does NOT reject: a correctly-matched point at a DIFFERENT DEPTH
 *      still lies on its epipolar line (disparity runs along the line).
 *      Depth structure is downstream's job (single-homography RANSAC);
 *      this filter only removes correspondence errors.
 *
 * Everything is deterministic: fixed seeds for descriptor sampling, no
 * Date/random anywhere. Given the same committed frames and calibration the
 * desk MUST produce the same correspondences every run.
 */

import type { Correspondence, StereoCommitment } from './types';
import { undistortPixel } from './undistort';
import { mat3Mul } from './homography';

export const MATCH_METHOD_VERSION = '0.1.0-p4-matcher';

// ---------------------------------------------------------------------------
// Constants (see the header for the justification of each family).
// ---------------------------------------------------------------------------

/**
 * Focal length in pixels both frames are resampled to before detection.
 * Chosen ≈ the ultra-wide's committed focal (~560 px at 640×480) so the
 * secondary passes through unscaled and the wide shrinks to meet it.
 */
export const WORKING_FOCAL_PX = 560;

/** Hard cap on the working-plane long side (runtime bound for 12MP frames). */
export const LONG_SIDE_CAP = 1280;

/** FAST intensity threshold on 0–255 luma. */
export const FAST_THRESHOLD = 20;

/** Contiguous circle pixels required (FAST-9). */
export const FAST_CONTIGUOUS = 9;

/** Harris structure-tensor constant k. */
export const HARRIS_K = 0.06;

/**
 * Minimum Harris score (Σ-window 5×5 over Sobel gradients on 0–255 luma).
 * A flat gradient gives scores orders of magnitude below this; blob/noise
 * texture sits above it. It exists to stop FAST firing on codec noise in
 * flat regions (JPEG blocking at q≈85 still lands under it — verified by
 * fixture (d) of test-stereo-match.mts).
 */
export const HARRIS_MIN_SCORE = 1.0e8;

/** Non-max suppression radius in working-plane pixels. */
export const NMS_RADIUS_PX = 6;

/** Spatial-distribution grid: cell size and per-cell corner cap. */
export const GRID_CELL_PX = 40;
export const GRID_CELL_MAX = 8;

/** Hard cap on corners per frame (descriptor/match runtime bound). */
export const MAX_CORNERS_PER_FRAME = 3000;

/** Descriptor patch: 31×31 (radius 15), box-smoothed with radius 2 (5×5). */
export const PATCH_RADIUS = 15;
export const SMOOTH_RADIUS = 2;

/** Descriptor size in bits (8 × uint32). */
export const DESCRIPTOR_BITS = 256;

/** Orientation quantization for the rotated sampling tables. */
export const ORIENTATION_BINS = 30;

/** Ratio test: accept best match only if best < RATIO_TEST × second-best. */
export const RATIO_TEST = 0.8;

/**
 * Epipolar Sampson-distance ceiling, in focal-averaged pixel-equivalents
 * (same units planarity.ts uses for its RANSAC gate).
 */
export const EPIPOLAR_SAMPSON_PX = 2.5;

// ---------------------------------------------------------------------------
// Public types.
// ---------------------------------------------------------------------------

/** Decoded frame as jpeg-js produces it: interleaved RGBA. */
export interface DecodedFrame {
  data: Uint8Array | Uint8ClampedArray;
  width: number;
  height: number;
}

export interface FrameMatchReport {
  /** Original frame size (committed pixels). */
  width: number;
  height: number;
  /** Focal-normalized working-plane size detection ran on. */
  workingWidth: number;
  workingHeight: number;
  /** working = scale × original. */
  workingScale: number;
  /** FAST-9 responses before Harris filtering and NMS. */
  rawFastCorners: number;
  /** Corners that survived Harris + NMS + grid cap and got descriptors. */
  keptCorners: number;
}

/**
 * Committed-style evidence: counts, not adjectives. Every stage reports its
 * survivor count so the desk's dossier shows WHERE the correspondences
 * thinned out (detection, cross-check, ratio, epipolar) instead of a bare
 * verdict-shaped number.
 */
export interface MatchReport {
  methodVersion: string;
  primary: FrameMatchReport;
  secondary: FrameMatchReport;
  matchesAfterCrossCheck: number;
  matchesAfterRatio: number;
  matchesAfterEpipolar: number;
  finalCorrespondences: number;
  /**
   * Epipolar survival rate: the fraction of putative matches (mutual
   * cross-check survivors offered to the epipolar gate) whose Sampson
   * distance under the committed essential matrix fell below the inlier
   * threshold EPIPOLAR_SAMPSON_PX. A measurement of geometric consistency —
   * characterization, never a verdict; absence is not suspicion. A LOW value
   * means the putative matches were geometrically inconsistent with the
   * committed calibration (mismatching, wrong calibration, or a scene the
   * rig could not measure); it says nothing about tampering on its own.
   * When `total` is 0 there was nothing to measure — `value` is 0 by
   * convention, not by evidence (low texture is a data limit, not a flag).
   */
  epipolarSurvivalRate: {
    /** inliers / total; 0 by convention when total is 0 (see above). */
    value: number;
    /** The inlier threshold applied, in focal-averaged pixel-equivalents. */
    threshold: number;
    /** Putative matches under the threshold (=== matchesAfterEpipolar). */
    inliers: number;
    /** Putative matches offered to the epipolar gate (mutual survivors). */
    total: number;
  };
  timingsMs: {
    grayscale: number;
    detect: number;
    describe: number;
    match: number;
    epipolar: number;
    total: number;
  };
}

export interface MatchResult {
  /** In ORIGINAL pixel coordinates of both frames (upscaled back). */
  correspondences: Correspondence[];
  report: MatchReport;
}

// ---------------------------------------------------------------------------
// Deterministic PRNG (descriptor sampling pattern must be fixed forever).
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const nowMs = (): number =>
  typeof globalThis.performance?.now === 'function' ? globalThis.performance.now() : Date.now();

// ---------------------------------------------------------------------------
// Step 1: grayscale + focal-normalized downscale.
// ---------------------------------------------------------------------------

interface GrayPlane {
  px: Uint8Array;
  width: number;
  height: number;
  /** working = scale × original. */
  scale: number;
}

function toWorkingGray(frame: DecodedFrame, focalPx: number): GrayPlane {
  const { width: w, height: h, data } = frame;
  const scale = Math.min(WORKING_FOCAL_PX / focalPx, LONG_SIDE_CAP / Math.max(w, h), 1);
  const ww = Math.max(1, Math.round(w * scale));
  const wh = Math.max(1, Math.round(h * scale));
  const out = new Uint8Array(ww * wh);
  if (scale >= 1) {
    for (let i = 0; i < w * h; i++) {
      const o = i * 4;
      out[i] = (77 * data[o] + 150 * data[o + 1] + 29 * data[o + 2]) >> 8;
    }
    return { px: out, width: ww, height: wh, scale };
  }
  // Integral image (Uint32: 255·12MP < 2^32) → O(1) area-average box samples,
  // which is the anti-aliased downsample (plain point sampling would alias
  // high-frequency texture into fake corners).
  const luma = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    luma[i] = (77 * data[o] + 150 * data[o + 1] + 29 * data[o + 2]) >> 8;
  }
  const iw = w + 1;
  const integ = new Uint32Array(iw * (h + 1));
  for (let y = 0; y < h; y++) {
    let run = 0;
    const ro = (y + 1) * iw;
    const rp = y * w;
    const ra = y * iw;
    for (let x = 0; x < w; x++) {
      run += luma[rp + x];
      integ[ro + x + 1] = integ[ra + x + 1] + run;
    }
  }
  for (let oy = 0; oy < wh; oy++) {
    const y0 = Math.floor(oy / scale);
    const y1 = Math.min(h, Math.max(y0 + 1, Math.round((oy + 1) / scale)));
    for (let ox = 0; ox < ww; ox++) {
      const x0 = Math.floor(ox / scale);
      const x1 = Math.min(w, Math.max(x0 + 1, Math.round((ox + 1) / scale)));
      const sum =
        integ[y1 * iw + x1] - integ[y0 * iw + x1] - integ[y1 * iw + x0] + integ[y0 * iw + x0];
      out[oy * ww + ox] = Math.round(sum / ((x1 - x0) * (y1 - y0)));
    }
  }
  return { px: out, width: ww, height: wh, scale };
}

// ---------------------------------------------------------------------------
// Step 2: FAST-9 + Harris + NMS + grid cap.
// ---------------------------------------------------------------------------

// Circle of radius 3, clockwise from the top.
const CIRCLE_X = [0, 1, 2, 3, 3, 3, 2, 1, 0, -1, -2, -3, -3, -3, -2, -1];
const CIRCLE_Y = [-3, -3, -2, -1, 0, 1, 2, 3, 3, 3, 2, 1, 0, -1, -2, -1];

function isFastCorner(px: Uint8Array, w: number, x: number, y: number, t: number): boolean {
  const c = px[y * w + x];
  const hi = c + t;
  const lo = c - t;
  // High-speed reject: cardinal points 0, 4, 8, 12 — need ≥3 on one side.
  let nBright = 0;
  let nDark = 0;
  const card = [0, 4, 8, 12];
  for (const k of card) {
    const v = px[(y + CIRCLE_Y[k]) * w + x + CIRCLE_X[k]];
    if (v > hi) nBright++;
    else if (v < lo) nDark++;
  }
  if (nBright < 3 && nDark < 3) return false;
  // Full test: FAST_CONTIGUOUS contiguous circle pixels on one side.
  const state = new Int8Array(16);
  for (let k = 0; k < 16; k++) {
    const v = px[(y + CIRCLE_Y[k]) * w + x + CIRCLE_X[k]];
    state[k] = v > hi ? 1 : v < lo ? -1 : 0;
  }
  for (const side of [1, -1]) {
    let run = 0;
    for (let k = 0; k < 16 + FAST_CONTIGUOUS - 1; k++) {
      run = state[k % 16] === side ? run + 1 : 0;
      if (run >= FAST_CONTIGUOUS) return true;
    }
  }
  return false;
}

/** Harris structure-tensor score at (x, y), 5×5 window over Sobel gradients. */
function harrisScore(px: Uint8Array, w: number, h: number, x: number, y: number): number {
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (let dy = -2; dy <= 2; dy++) {
    const yy = Math.min(h - 2, Math.max(1, y + dy));
    for (let dx = -2; dx <= 2; dx++) {
      const xx = Math.min(w - 2, Math.max(1, x + dx));
      const ix =
        px[(yy - 1) * w + xx + 1] + 2 * px[yy * w + xx + 1] + px[(yy + 1) * w + xx + 1] -
        (px[(yy - 1) * w + xx - 1] + 2 * px[yy * w + xx - 1] + px[(yy + 1) * w + xx - 1]);
      const iy =
        px[(yy + 1) * w + xx - 1] + 2 * px[(yy + 1) * w + xx] + px[(yy + 1) * w + xx + 1] -
        (px[(yy - 1) * w + xx - 1] + 2 * px[(yy - 1) * w + xx] + px[(yy - 1) * w + xx + 1]);
      sxx += ix * ix;
      syy += iy * iy;
      sxy += ix * iy;
    }
  }
  const tr = sxx + syy;
  return sxx * syy - sxy * sxy - HARRIS_K * tr * tr;
}

interface Corner {
  x: number; // subpixel, working-plane
  y: number;
  score: number;
}

/**
 * Detect corners: FAST-9 over the interior, Harris filter, NMS by
 * descending score on a spatial hash, per-grid-cell cap. Deterministic:
 * ties break by scan order because the sort is stable.
 */
function detectCorners(g: GrayPlane): { corners: Corner[]; rawFast: number } {
  const { px, width: w, height: h } = g;
  const margin = PATCH_RADIUS + 2; // descriptor patch must fit
  const candidates: Array<{ x: number; y: number; score: number }> = [];
  let rawFast = 0;
  for (let y = margin; y < h - margin; y++) {
    for (let x = margin; x < w - margin; x++) {
      if (!isFastCorner(px, w, x, y, FAST_THRESHOLD)) continue;
      rawFast++;
      const score = harrisScore(px, w, h, x, y);
      if (score >= HARRIS_MIN_SCORE) candidates.push({ x, y, score });
    }
  }
  // Stable sort by descending score.
  const ordered = candidates
    .map((c, i) => ({ ...c, i }))
    .sort((a, b) => b.score - a.score || a.i - b.i);

  // NMS via spatial hash: accept in score order, reject near a better one.
  const hash = new Map<number, Array<{ x: number; y: number }>>();
  const nmsed: Array<{ x: number; y: number; score: number }> = [];
  const hk = (cx: number, cy: number): number => cy * 65536 + cx;
  for (const c of ordered) {
    const cx = Math.floor(c.x / NMS_RADIUS_PX);
    const cy = Math.floor(c.y / NMS_RADIUS_PX);
    let suppressed = false;
    for (let ay = cy - 1; ay <= cy + 1 && !suppressed; ay++) {
      for (let ax = cx - 1; ax <= cx + 1 && !suppressed; ax++) {
        const bucket = hash.get(hk(ax, ay));
        if (!bucket) continue;
        for (const o of bucket) {
          if (Math.abs(o.x - c.x) < NMS_RADIUS_PX && Math.abs(o.y - c.y) < NMS_RADIUS_PX) {
            suppressed = true;
            break;
          }
        }
      }
    }
    if (suppressed) continue;
    const key = hk(cx, cy);
    const bucket = hash.get(key);
    if (bucket) bucket.push(c);
    else hash.set(key, [c]);
    nmsed.push(c);
  }

  // Per-cell cap (spatial distribution for the downstream fit), then a
  // global cap; both applied in score order.
  const cellCount = new Map<number, number>();
  const corners: Corner[] = [];
  for (const c of nmsed) {
    const key = hk(Math.floor(c.x / GRID_CELL_PX), Math.floor(c.y / GRID_CELL_PX));
    const n = cellCount.get(key) ?? 0;
    if (n >= GRID_CELL_MAX) continue;
    cellCount.set(key, n + 1);
    corners.push(subpixelRefine(g, c.x, c.y, c.score));
    if (corners.length >= MAX_CORNERS_PER_FRAME) break;
  }
  return { corners, rawFast };
}

/**
 * Subpixel refinement: parabolic interpolation of the Harris score along
 * each axis. This is not cosmetic — a working-plane pixel is ~2 original
 * pixels on the primary, and the downstream planar ceiling is 1.5
 * focal-averaged px, so integer corner positions would spend most of the
 * noise budget on quantization alone.
 */
function subpixelRefine(g: GrayPlane, x: number, y: number, score: number): Corner {
  const { px, width: w, height: h } = g;
  const refineAxis = (sPrev: number, sNext: number): number => {
    const denom = sPrev - 2 * score + sNext;
    if (Math.abs(denom) < 1e-9) return 0;
    const d = 0.5 * (sPrev - sNext) / denom;
    return Math.abs(d) <= 1 ? d : 0;
  };
  const dx = refineAxis(harrisScore(px, w, h, x - 1, y), harrisScore(px, w, h, x + 1, y));
  const dy = refineAxis(harrisScore(px, w, h, x, y - 1), harrisScore(px, w, h, x, y + 1));
  return { x: x + dx, y: y + dy, score };
}

// ---------------------------------------------------------------------------
// Step 3: rBRIEF-style descriptors with intensity-centroid orientation.
// ---------------------------------------------------------------------------

/** One sampling test: compare smoothed intensity at offset a vs offset b. */
interface BriefTest {
  ax: number;
  ay: number;
  bx: number;
  by: number;
}

/**
 * Deterministic Gaussian sampling pattern (rBRIEF's Gaussian variant):
 * both points of each test ~ N(0, (S/5)²) clamped to the patch, seed fixed.
 * The pattern is part of the method version — change it and old evidence
 * cannot be recomputed identically.
 */
function buildBaseTests(): BriefTest[] {
  const rnd = mulberry32(0xb91eef);
  const gauss = (): number => {
    const u = Math.max(rnd(), 1e-12);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd());
  };
  const sigma = ((PATCH_RADIUS * 2 + 1) / 5);
  const sample = (): number => {
    const v = Math.round(gauss() * sigma);
    return Math.max(-PATCH_RADIUS, Math.min(PATCH_RADIUS, v));
  };
  const tests: BriefTest[] = [];
  for (let i = 0; i < DESCRIPTOR_BITS; i++) {
    tests.push({ ax: sample(), ay: sample(), bx: sample(), by: sample() });
  }
  return tests;
}

const BASE_TESTS = buildBaseTests();

/**
 * Rotated sampling tables, one per orientation bin. Quantizing orientation
 * to ORIENTATION_BINS and pre-rotating the integer offsets keeps the
 * descriptor loop branch-free and exact (no interpolation at sample time;
 * the box-smoothed plane supplies the anti-aliasing).
 */
const ROTATED_TESTS: BriefTest[][] = (() => {
  const tables: BriefTest[][] = [];
  for (let b = 0; b < ORIENTATION_BINS; b++) {
    const theta = (b * 2 * Math.PI) / ORIENTATION_BINS;
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);
    tables.push(
      BASE_TESTS.map(({ ax, ay, bx, by }) => ({
        ax: Math.max(-PATCH_RADIUS, Math.min(PATCH_RADIUS, Math.round(ax * cos - ay * sin))),
        ay: Math.max(-PATCH_RADIUS, Math.min(PATCH_RADIUS, Math.round(ax * sin + ay * cos))),
        bx: Math.max(-PATCH_RADIUS, Math.min(PATCH_RADIUS, Math.round(bx * cos - by * sin))),
        by: Math.max(-PATCH_RADIUS, Math.min(PATCH_RADIUS, Math.round(bx * sin + by * cos))),
      })),
    );
  }
  return tables;
})();

/** Integral image of the working plane for O(1) box-smoothed samples. */
function buildIntegral(px: Uint8Array, w: number, h: number): Uint32Array {
  const iw = w + 1;
  const integ = new Uint32Array(iw * (h + 1));
  for (let y = 0; y < h; y++) {
    let run = 0;
    const ro = (y + 1) * iw;
    const rp = y * w;
    const ra = y * iw;
    for (let x = 0; x < w; x++) {
      run += px[rp + x];
      integ[ro + x + 1] = integ[ra + x + 1] + run;
    }
  }
  return integ;
}

/** Box-smoothed intensity at integer (x, y), SMOOTH_RADIUS window. */
function smoothAt(integ: Uint32Array, w: number, h: number, x: number, y: number): number {
  const r = SMOOTH_RADIUS;
  const x0 = Math.max(0, x - r);
  const y0 = Math.max(0, y - r);
  const x1 = Math.min(w, x + r + 1);
  const y1 = Math.min(h, y + r + 1);
  const iw = w + 1;
  const sum = integ[y1 * iw + x1] - integ[y0 * iw + x1] - integ[y1 * iw + x0] + integ[y0 * iw + x0];
  return sum / ((x1 - x0) * (y1 - y0));
}

/**
 * Patch intensity-centroid orientation. A flat patch has no centroid; the
 * moments then collapse toward zero and the bin falls back to 0 — the
 * descriptor degrades to unrotated rBRIEF rather than inventing an angle.
 */
function orientationBin(integ: Uint32Array, w: number, h: number, cx: number, cy: number): number {
  let m10 = 0;
  let m01 = 0;
  for (let dy = -PATCH_RADIUS; dy <= PATCH_RADIUS; dy++) {
    for (let dx = -PATCH_RADIUS; dx <= PATCH_RADIUS; dx++) {
      const v = smoothAt(integ, w, h, cx + dx, cy + dy);
      m10 += dx * v;
      m01 += dy * v;
    }
  }
  if (Math.hypot(m10, m01) < 1e-6) return 0;
  const theta = Math.atan2(m01, m10);
  const bin = Math.round((theta * ORIENTATION_BINS) / (2 * Math.PI)) % ORIENTATION_BINS;
  return (bin + ORIENTATION_BINS) % ORIENTATION_BINS;
}

/**
 * Descriptors for all corners, packed into one flat Uint32Array
 * (DESCRIPTOR_BITS/32 words per corner). Corner positions are subpixel but
 * the patch is sampled at the nearest integer lattice: at working-plane
 * scale the centroid orientation and the smoothing absorb the sub-half-pixel
 * offset, and the ratio+epipolar stages absorb the rest.
 */
function describeCorners(
  g: GrayPlane,
  integ: Uint32Array,
  corners: Corner[],
): Uint32Array {
  const { width: w, height: h } = g;
  const words = DESCRIPTOR_BITS / 32;
  const out = new Uint32Array(corners.length * words);
  for (let ci = 0; ci < corners.length; ci++) {
    const cx = Math.round(corners[ci].x);
    const cy = Math.round(corners[ci].y);
    const bin = orientationBin(integ, w, h, cx, cy);
    const tests = ROTATED_TESTS[bin];
    const base = ci * words;
    for (let t = 0; t < DESCRIPTOR_BITS; t++) {
      const { ax, ay, bx, by } = tests[t];
      const va = smoothAt(integ, w, h, cx + ax, cy + ay);
      const vb = smoothAt(integ, w, h, cx + bx, cy + by);
      if (va < vb) out[base + (t >> 5)] |= 1 << (t & 31);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Step 4: brute-force Hamming matching, ratio test, mutual cross-check.
// ---------------------------------------------------------------------------

function hamming(a: Uint32Array, ai: number, b: Uint32Array, bi: number, words: number): number {
  let d = 0;
  for (let k = 0; k < words; k++) {
    let v = a[ai + k] ^ b[bi + k];
    v -= (v >> 1) & 0x55555555;
    v = (v & 0x33333333) + ((v >> 2) & 0x33333333);
    d += (((v + (v >> 4)) & 0x0f0f0f0f) * 0x01010101) >> 24;
  }
  return d;
}

interface RawMatch {
  a: number; // index into primary corners
  b: number; // index into secondary corners
  dist: number;
}

/**
 * For each descriptor in A: best and second-best in B; keep when
 * best < RATIO_TEST × second. Then the same from B's side, and keep only
 * pairs both directions name each other (mutual cross-check).
 */
function matchDescriptors(
  descA: Uint32Array,
  descB: Uint32Array,
  nA: number,
  nB: number,
): { mutual: RawMatch[]; afterCrossCheck: number; afterRatio: number } {
  const words = DESCRIPTOR_BITS / 32;
  const bestForA = new Int32Array(nA).fill(-1);
  const distForA = new Float64Array(nA).fill(Infinity);
  for (let i = 0; i < nA; i++) {
    let d1 = Infinity;
    let d2 = Infinity;
    let j1 = -1;
    const ai = i * words;
    for (let j = 0; j < nB; j++) {
      const d = hamming(descA, ai, descB, j * words, words);
      if (d < d1) {
        d2 = d1;
        d1 = d;
        j1 = j;
      } else if (d < d2) {
        d2 = d;
      }
    }
    if (j1 >= 0 && d1 < RATIO_TEST * d2) {
      bestForA[i] = j1;
      distForA[i] = d1;
    }
  }
  const bestForB = new Int32Array(nB).fill(-1);
  for (let j = 0; j < nB; j++) {
    let d1 = Infinity;
    let d2 = Infinity;
    let i1 = -1;
    const bi = j * words;
    for (let i = 0; i < nA; i++) {
      const d = hamming(descB, bi, descA, i * words, words);
      if (d < d1) {
        d2 = d1;
        d1 = d;
        i1 = i;
      } else if (d < d2) {
        d2 = d;
      }
    }
    if (i1 >= 0 && d1 < RATIO_TEST * d2) bestForB[j] = i1;
  }
  let afterCrossCheck = 0;
  for (let i = 0; i < nA; i++) if (bestForA[i] >= 0 && bestForB[bestForA[i]] === i) afterCrossCheck++;
  const mutual: RawMatch[] = [];
  for (let i = 0; i < nA; i++) {
    const j = bestForA[i];
    if (j >= 0 && bestForB[j] === i) mutual.push({ a: i, b: j, dist: distForA[i] });
  }
  // afterRatio counts one-directional ratio survivors (A side) for the report.
  let afterRatio = 0;
  for (let i = 0; i < nA; i++) if (bestForA[i] >= 0) afterRatio++;
  return { mutual, afterCrossCheck, afterRatio };
}

// ---------------------------------------------------------------------------
// Step 5: epipolar pre-filter from the committed calibration.
// ---------------------------------------------------------------------------

function representativeFocalPx(c: StereoCommitment['calibration']): number {
  const a = (c.intrinsicsWide.fx + c.intrinsicsWide.fy) / 2;
  const b = (c.intrinsicsUltraWide.fx + c.intrinsicsUltraWide.fy) / 2;
  return (a + b) / 2;
}

/**
 * Sampson distance of a normalized correspondence under the essential
 * matrix E = [t]×R (row-major 3×3), in normalized pinhole units. Squared
 * form from Hartley & Zisserman §11.4.3, reported as a distance.
 */
function sampsonDistance(
  E: number[],
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): number {
  // Ex1 and Eᵀx2.
  const ex0 = E[0] * x1 + E[1] * y1 + E[2];
  const ex1 = E[3] * x1 + E[4] * y1 + E[5];
  const ex2 = E[6] * x1 + E[7] * y1 + E[8];
  const et0 = E[0] * x2 + E[3] * y2 + E[6];
  const et1 = E[1] * x2 + E[4] * y2 + E[7];
  const num = x2 * ex0 + y2 * ex1 + ex2;
  const den = ex0 * ex0 + ex1 * ex1 + et0 * et0 + et1 * et1;
  if (den < 1e-24) return Infinity;
  return Math.abs(num) / Math.sqrt(den);
}

// ---------------------------------------------------------------------------
// Public entry point.
// ---------------------------------------------------------------------------

/**
 * Extract correspondences between the two committed frames.
 *
 * @param primary   decoded full-resolution primary frame (RGBA, jpeg-js shape)
 * @param secondary decoded committed secondary frame (RGBA)
 * @param calibration the COMMITTED calibration block (intrinsics, extrinsics,
 *                  optional distortion LUT) — used for focal normalization,
 *                  LUT-aware undistortion in the epipolar filter, and the
 *                  essential matrix. Nothing is estimated that the
 *                  calibration already commits.
 *
 * Returns correspondences in ORIGINAL pixel coordinates of both frames plus
 * a count-only evidence report. Never throws on weird frames: a frame too
 * small to describe simply yields zero corners, which downstream reports as
 * 'insufficient-geometry' — the honest state for "nothing measurable here".
 */
export function matchFrames(
  primary: DecodedFrame,
  secondary: DecodedFrame,
  calibration: StereoCommitment['calibration'],
): MatchResult {
  const t0 = nowMs();
  const f1 = (calibration.intrinsicsWide.fx + calibration.intrinsicsWide.fy) / 2;
  const f2 = (calibration.intrinsicsUltraWide.fx + calibration.intrinsicsUltraWide.fy) / 2;

  const g1 = toWorkingGray(primary, f1);
  const g2 = toWorkingGray(secondary, f2);
  const tGray = nowMs();

  const det1 = detectCorners(g1);
  const det2 = detectCorners(g2);
  const tDetect = nowMs();

  const integ1 = buildIntegral(g1.px, g1.width, g1.height);
  const integ2 = buildIntegral(g2.px, g2.width, g2.height);
  const desc1 = describeCorners(g1, integ1, det1.corners);
  const desc2 = describeCorners(g2, integ2, det2.corners);
  const tDescribe = nowMs();

  const { mutual, afterCrossCheck, afterRatio } = matchDescriptors(
    desc1,
    desc2,
    det1.corners.length,
    det2.corners.length,
  );
  const tMatch = nowMs();

  // Essential matrix E = [t]×R from the committed extrinsics.
  const [tx, ty, tz] = calibration.extrinsics.translationM;
  const tCross = [0, -tz, ty, tz, 0, -tx, -ty, tx, 0];
  const E = mat3Mul(tCross, calibration.extrinsics.rotation);
  const lut = calibration.distortionLut;
  const fRep = representativeFocalPx(calibration);
  const sampsonCeiling = EPIPOLAR_SAMPSON_PX / fRep;

  const correspondences: Correspondence[] = [];
  let epipolarInliers = 0;
  for (const m of mutual) {
    const c1 = det1.corners[m.a];
    const c2 = det2.corners[m.b];
    // Back to ORIGINAL pixel coordinates of each frame.
    const p1x = c1.x / g1.scale;
    const p1y = c1.y / g1.scale;
    const p2x = c2.x / g2.scale;
    const p2y = c2.y / g2.scale;
    // Undistort to normalized pinhole coords for the epipolar test — the
    // SAME function downstream uses, so the filter and the fit agree.
    const [n1x, n1y] = undistortPixel(p1x, p1y, calibration.intrinsicsWide, lut);
    const [n2x, n2y] = undistortPixel(p2x, p2y, calibration.intrinsicsUltraWide, lut);
    if (sampsonDistance(E, n1x, n1y, n2x, n2y) > sampsonCeiling) continue;
    epipolarInliers++;
    correspondences.push({ primary: [p1x, p1y], secondary: [p2x, p2y] });
  }
  const tEpi = nowMs();

  return {
    correspondences,
    report: {
      methodVersion: MATCH_METHOD_VERSION,
      primary: {
        width: primary.width,
        height: primary.height,
        workingWidth: g1.width,
        workingHeight: g1.height,
        workingScale: g1.scale,
        rawFastCorners: det1.rawFast,
        keptCorners: det1.corners.length,
      },
      secondary: {
        width: secondary.width,
        height: secondary.height,
        workingWidth: g2.width,
        workingHeight: g2.height,
        workingScale: g2.scale,
        rawFastCorners: det2.rawFast,
        keptCorners: det2.corners.length,
      },
      matchesAfterCrossCheck: afterCrossCheck,
      matchesAfterRatio: afterRatio,
      matchesAfterEpipolar: correspondences.length,
      finalCorrespondences: correspondences.length,
      epipolarSurvivalRate: {
        value: mutual.length === 0 ? 0 : epipolarInliers / mutual.length,
        threshold: EPIPOLAR_SAMPSON_PX,
        inliers: epipolarInliers,
        total: mutual.length,
      },
      timingsMs: {
        grayscale: tGray - t0,
        detect: tDetect - tGray,
        describe: tDescribe - tDetect,
        match: tMatch - tDescribe,
        epipolar: tEpi - tMatch,
        total: tEpi - t0,
      },
    },
  };
}

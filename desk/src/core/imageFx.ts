// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * imageFx.ts — Tier-2 in-browser image analyses (ARCHITECTURE §5.3, r3
 * algorithm set): clone detection (Haar-wavelet fuzzy block matching),
 * noise analysis (separable median residual), Error Level Analysis (gated,
 * caveated), and the viewing aids (level sweep, luminance gradient,
 * magnifier contrast modes).
 *
 * Purity contract: everything here is typed-array in, typed-array out. NO
 * DOM at module top level, no network, no new dependencies — the module is
 * safe under node:test and importable by the CLI. The ONE browser-dependent
 * helper (reencodeJpeg — ELA's canvas re-encode) is guarded behind an
 * explicit DOM check that fails with a plain-language error, never an
 * opaque crash.
 *
 * Responsiveness contract: every long analysis is async and CHUNKED — it
 * yields to the event loop between row batches so the tab never blocks
 * hard, reports literal progress, and honours an AbortSignal (cancellation
 * discards partial work; nothing partial is ever presented as a result).
 *
 * Honesty contract: these are measurements and viewing aids, never
 * verdicts (r3's deliberate-exclusion guidance). Clone detection reports
 * what the matcher found AT THESE SETTINGS and shows the quantized debug
 * view of exactly what the matcher saw. Noise analysis ABSTAINS with a
 * stated reason on flat/small/too-smooth inputs rather than guessing. ELA
 * refuses non-JPEG input with its gate reason; its misleading-results
 * caveat is UI law (fx.ela.caveat, non-dismissible). The level sweep,
 * luminance gradient, and magnifier modes are labeled viewing aids — they
 * show the picture differently and claim nothing.
 */

import { sniffFormat, type ByteFormat } from './byteReads';

/* ================================================================== */
/* Shared types and the responsiveness plumbing                       */
/* ================================================================== */

/** An RGBA pixel raster. Structured-clone safe (caches on the item). */
export interface FxRaster {
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
}

export interface FxProgress {
  stage: string;
  /** 0..1 */
  fraction: number;
}

/** Thrown when an analysis is cancelled. Partial work is discarded. */
export class FxCancelled extends Error {
  constructor() {
    super('The run was cancelled — partial work was discarded, nothing was kept.');
    this.name = 'FxCancelled';
  }
}

/**
 * The yield channel: a MessageChannel post is a macrotask that is NOT
 * throttled in background tabs (setTimeout(0) degrades to ~1 s when the tab
 * is hidden, which would stall a long analysis to a crawl). Falls back to
 * setTimeout where MessageChannel does not exist.
 */
const yieldChannel: MessageChannel | null =
  typeof MessageChannel !== 'undefined' ? new MessageChannel() : null;

/** Yield to the event loop between work batches; honour cancellation. */
async function breathe(signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) throw new FxCancelled();
  await new Promise<void>((resolve) => {
    if (yieldChannel) {
      yieldChannel.port1.onmessage = () => {
        /* In Node, a MessageChannel's ports keep the event loop alive, so a
           ref'd channel would hang process exit after the work is done (the
           node:test runner never returns). unref both ports AFTER delivery:
           assigning onmessage re-refs port1 for the next yield, so the
           channel stays reusable while owing the loop nothing in between.
           Browsers have no unref on MessagePort — the ?. makes it a no-op,
           so the unthrottled background-tab behavior is unchanged. */
        (yieldChannel.port1 as unknown as { unref?: () => void }).unref?.();
        (yieldChannel.port2 as unknown as { unref?: () => void }).unref?.();
        resolve();
      };
      yieldChannel.port2.postMessage(null);
    } else {
      setTimeout(resolve, 0);
    }
  });
  if (signal?.aborted) throw new FxCancelled();
}

/** ITU-R 601 luma plane from an RGBA raster. */
export function toLuma(img: FxRaster): Float64Array {
  const n = img.width * img.height;
  const gray = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    gray[i] = 0.299 * img.rgba[o] + 0.587 * img.rgba[o + 1] + 0.114 * img.rgba[o + 2];
  }
  return gray;
}

/**
 * Bilinear downscale of a luma plane so its long side is ≤ maxLongSide.
 * The cap is STATED in every result (cost grows with the square of size).
 */
function downscaleLuma(
  gray: Float64Array,
  width: number,
  height: number,
  maxLongSide: number,
): { gray: Float64Array; width: number; height: number } {
  const scale = Math.min(1, maxLongSide / Math.max(width, height));
  if (scale >= 1) return { gray, width, height };
  const w = Math.max(8, Math.round(width * scale));
  const h = Math.max(8, Math.round(height * scale));
  const out = new Float64Array(w * h);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(height - 1, (y + 0.5) / scale - 0.5);
    const y0 = Math.max(0, Math.floor(sy));
    const y1 = Math.min(height - 1, y0 + 1);
    const fy = sy - y0;
    for (let x = 0; x < w; x++) {
      const sx = Math.min(width - 1, (x + 0.5) / scale - 0.5);
      const x0 = Math.max(0, Math.floor(sx));
      const x1 = Math.min(width - 1, x0 + 1);
      const fx = sx - x0;
      out[y * w + x] =
        gray[y0 * width + x0] * (1 - fx) * (1 - fy) + gray[y0 * width + x1] * fx * (1 - fy) +
        gray[y1 * width + x0] * (1 - fx) * fy + gray[y1 * width + x1] * fx * fy;
    }
  }
  return { gray: out, width: w, height: h };
}

function lumaToRaster(gray: Float64Array | Float32Array, width: number, height: number): FxRaster {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const v = Math.max(0, Math.min(255, Math.round(gray[i])));
    rgba[i * 4] = v;
    rgba[i * 4 + 1] = v;
    rgba[i * 4 + 2] = v;
    rgba[i * 4 + 3] = 255;
  }
  return { width, height, rgba };
}

/* ================================================================== */
/* Clone detection — Haar-wavelet fuzzy block matching (r3 §2)         */
/* ================================================================== */

export const CLONE_METHOD_VERSION = '1.0.0-w4';

export interface CloneParams {
  /**
   * Long-side cap of the analysis raster. Cost grows with the SQUARE of
   * image size, which is why the cap exists and is stated (fx.clone.sizecap).
   */
  maxSizePx: number;
  /** Sliding-window block edge, px (power of two — Haar needs it). */
  blockSize: number;
  /**
   * Key fuzziness: quantized Haar coefficients are bucketed into ±levels.
   * FEWER levels = fuzzier keys = more matches (the "similarity" knob).
   */
  quantLevels: number;
  /**
   * Minimum high-frequency energy (RMS of the fine Haar bands, luma
   * 0–255 scale) for a block to be considered at all. Flat blocks clone
   * legitimately (sky, walls) and are filtered out, honestly.
   */
  minDetail: number;
  /** Minimum source→destination distance for a pair, px at the analysis raster. */
  minDistancePx: number;
  /** A shared-offset cluster needs at least this many pairs to be reported. */
  minClusterSize: number;
  /**
   * Safety cap: a colliding bucket larger than this is stride-subsampled
   * deterministically before pair matching (a pathological bucket is O(k²)).
   * The skipped pairs are COUNTED and reported (pairsTruncated) — matching
   * that was truncated is stated, never hidden.
   */
  maxPairsPerBucket: number;
  /**
   * Safety cap: total pair comparisons across all buckets. Past this the
   * matcher stops comparing and reports the truncation honestly.
   */
  maxTotalPairs: number;
}

export const CLONE_DEFAULTS: CloneParams = {
  maxSizePx: 512,
  blockSize: 16,
  quantLevels: 4,
  minDetail: 2.5,
  minDistancePx: 48,
  minClusterSize: 4,
  maxPairsPerBucket: 512,
  maxTotalPairs: 400_000,
};

export interface CloneCluster {
  /** Shared source→destination offset of the cluster, px at analysis raster. */
  dx: number;
  dy: number;
  pairs: number;
}

export interface CloneDetectionMeasured {
  state: 'measured';
  params: CloneParams;
  analyzedWidth: number;
  analyzedHeight: number;
  /** Blocks whose keys were computed (after the low-detail filter). */
  blocksConsidered: number;
  /** Blocks filtered out by the min-detail rule — stated, not hidden. */
  blocksFilteredLowDetail: number;
  /** Distinct fuzzy keys that bucketed more than one block. */
  collidingBuckets: number;
  /** Pairs surviving the min source–destination distance rule. */
  candidatePairs: number;
  /** Pair comparisons actually performed (bounded by params.maxTotalPairs). */
  pairsConsidered: number;
  /**
   * Pair comparisons SKIPPED by the safety caps (bucket subsampling + the
   * total cap). Zero in ordinary runs; when non-zero the UI must say
   * "matching was truncated" — a truncated match can miss clones and the
   * result must not read as a clean sweep.
   */
  pairsTruncated: number;
  /** Offset clusters surviving the min-cluster-size rule. */
  clusters: CloneCluster[];
  /** Block positions marked as part of a reported cluster. */
  matchedBlocks: number;
  /** Overlay: dimmed analysis raster, matched blocks tinted, offsets linked. */
  overlay: FxRaster;
  /**
   * The quantized debug view — exactly what the matcher saw: each block
   * re-rendered from its QUANTIZED Haar key. Transparency, not decoration.
   */
  debugView: FxRaster;
  methodVersion: typeof CLONE_METHOD_VERSION;
  computedAt: string;
}

export interface CloneDetectionInsufficient {
  state: 'insufficient';
  reason: string;
  analyzedWidth: number;
  analyzedHeight: number;
  methodVersion: typeof CLONE_METHOD_VERSION;
  computedAt: string;
}

export type CloneDetectionResult = CloneDetectionMeasured | CloneDetectionInsufficient;

/** Normalized 2D Haar transform of a B×B block (B a power of two), in place. */
function haarForward(c: Float64Array, B: number, tmp: Float64Array): void {
  const SQ = Math.SQRT1_2;
  for (let len = B; len > 1; len >>= 1) {
    const half = len >> 1;
    // rows
    for (let y = 0; y < len; y++) {
      const row = y * B;
      for (let i = 0; i < half; i++) {
        const a = c[row + 2 * i];
        const b = c[row + 2 * i + 1];
        tmp[i] = (a + b) * SQ;
        tmp[half + i] = (a - b) * SQ;
      }
      for (let i = 0; i < len; i++) c[row + i] = tmp[i];
    }
    // columns
    for (let x = 0; x < len; x++) {
      for (let i = 0; i < half; i++) {
        const a = c[2 * i * B + x];
        const b = c[(2 * i + 1) * B + x];
        tmp[i] = (a + b) * SQ;
        tmp[half + i] = (a - b) * SQ;
      }
      for (let i = 0; i < len; i++) c[i * B + x] = tmp[i];
    }
  }
}

/** Inverse of haarForward (same normalization), in place. */
function haarInverse(c: Float64Array, B: number, tmp: Float64Array): void {
  const SQ = Math.SQRT1_2;
  for (let len = 2; len <= B; len <<= 1) {
    const half = len >> 1;
    // columns
    for (let x = 0; x < len; x++) {
      for (let i = 0; i < half; i++) {
        const a = c[i * B + x];
        const b = c[(half + i) * B + x];
        tmp[2 * i] = (a + b) * SQ;
        tmp[2 * i + 1] = (a - b) * SQ;
      }
      for (let i = 0; i < len; i++) c[i * B + x] = tmp[i];
    }
    // rows
    for (let y = 0; y < len; y++) {
      const row = y * B;
      for (let i = 0; i < half; i++) {
        const a = c[row + i];
        const b = c[row + half + i];
        tmp[2 * i] = (a + b) * SQ;
        tmp[2 * i + 1] = (a - b) * SQ;
      }
      for (let i = 0; i < len; i++) c[row + i] = tmp[i];
    }
  }
}

interface BlockKey {
  x: number;
  y: number;
  key: string;
  /**
   * DEQUANTIZED coefficients (quantized level × step; DC verbatim) — kept
   * for the debug view's reconstruction of what the matcher saw.
   */
  q: Int16Array;
}

/**
 * The fuzzy key of one block: Haar coefficients quantized against the
 * block's own largest coefficient into ±levels. Per-block normalization
 * makes the key contrast-tolerant (a copy pasted at a different brightness
 * still keys alike); low-detail blocks return null and are filtered.
 */
function blockKey(
  gray: Float64Array, W: number, x: number, y: number, B: number,
  params: CloneParams, scratch: Float64Array, tmp: Float64Array,
): BlockKey | null {
  for (let j = 0; j < B; j++) {
    const row = (y + j) * W + x;
    for (let i = 0; i < B; i++) scratch[j * B + i] = gray[row + i];
  }
  haarForward(scratch, B, tmp);

  // Detail: RMS energy of the fine bands (outside the coarse B/4 × B/4
  // corner). Flat blocks clone legitimately — filter them, and count them.
  const coarse = B >> 2;
  let hf = 0;
  let hfN = 0;
  for (let j = 0; j < B; j++) {
    for (let i = 0; i < B; i++) {
      if (i >= coarse || j >= coarse) {
        hf += scratch[j * B + i] * scratch[j * B + i];
        hfN++;
      }
    }
  }
  const detail = hfN > 0 ? Math.sqrt(hf / hfN) : 0;

  // Normalization and the key EXCLUDE the DC coefficient (index 0): DC is
  // the block's mean brightness and dwarfs the texture coefficients, so
  // normalizing by it would quantize every block to the same empty key.
  // Excluding it also makes the key brightness-tolerant — a copy pasted at
  // a different exposure still keys alike.
  let maxAc = 0;
  for (let i = 1; i < B * B; i++) {
    const v = Math.abs(scratch[i]);
    if (v > maxAc) maxAc = v;
  }
  if (detail < params.minDetail || maxAc <= 0) return null;

  const step = maxAc / params.quantLevels;
  const q = new Int16Array(B * B);
  q[0] = Math.round(scratch[0]); // DC verbatim — the debug view needs it
  const parts: string[] = [];
  for (let i = 1; i < B * B; i++) {
    let qi = Math.round(scratch[i] / step);
    if (qi > params.quantLevels) qi = params.quantLevels;
    if (qi < -params.quantLevels) qi = -params.quantLevels;
    q[i] = Math.round(qi * step);
    if (qi !== 0) parts.push(`${i}:${qi}`);
  }
  if (parts.length === 0) return null;
  return { x, y, key: parts.join(','), q };
}

/**
 * Clone (copy-move) detection. Chunked + cancellable: the per-row block
 * pass is the expensive stage (cost ∝ size², which is why the size cap
 * exists); it yields between row batches and reports literal progress.
 */
export async function detectClones(
  img: FxRaster,
  paramsIn: Partial<CloneParams> = {},
  signal?: AbortSignal,
  onProgress?: (p: FxProgress) => void,
): Promise<CloneDetectionResult> {
  const params: CloneParams = { ...CLONE_DEFAULTS, ...paramsIn };
  const computedAt = new Date().toISOString();
  const luma = toLuma(img);
  const a = downscaleLuma(luma, img.width, img.height, params.maxSizePx);
  const W = a.width;
  const H = a.height;
  let B = params.blockSize;
  if (B !== 8 && B !== 16 && B !== 32) B = 16;

  const insufficient = (reason: string): CloneDetectionInsufficient => ({
    state: 'insufficient', reason, analyzedWidth: W, analyzedHeight: H,
    methodVersion: CLONE_METHOD_VERSION, computedAt,
  });

  if (W < B * 2 || H < B * 2) {
    return insufficient(
      `the analysis raster is ${W}×${H} — smaller than two ${B}px blocks; there is no room to match. Abstaining rather than guessing.`,
    );
  }

  const scratch = new Float64Array(B * B);
  const tmp = new Float64Array(B);
  const blocks: BlockKey[] = [];
  let lowDetail = 0;

  // Stage 1: fuzzy keys for every block position (the size² stage).
  const rowsTotal = H - B + 1;
  for (let y = 0; y <= H - B; y++) {
    for (let x = 0; x <= W - B; x++) {
      const bk = blockKey(a.gray, W, x, y, B, params, scratch, tmp);
      if (bk) blocks.push(bk);
      else lowDetail++;
    }
    // 4-row batches: ~70 ms at the 512px cap — the tab never blocks >100 ms.
    if (y % 4 === 3) {
      onProgress?.({ stage: `Hashing blocks… row ${y + 1} of ${rowsTotal}`, fraction: (0.7 * (y + 1)) / rowsTotal });
      await breathe(signal);
    }
  }
  onProgress?.({ stage: 'Hashing blocks…', fraction: 0.7 });
  await breathe(signal);

  // Stage 2: hash-bucket matching + min source–destination distance.
  const buckets = new Map<string, number[]>();
  for (let i = 0; i < blocks.length; i++) {
    const arr = buckets.get(blocks[i].key);
    if (arr) arr.push(i);
    else buckets.set(blocks[i].key, [i]);
  }
  const minDist2 = params.minDistancePx * params.minDistancePx;
  interface Pair { i: number; j: number; dx: number; dy: number }
  const pairs: Pair[] = [];
  let colliding = 0;
  let pairsConsidered = 0;
  let pairsTruncated = 0;
  let exhausted = false;
  const pairCount = (n: number) => (n * (n - 1)) / 2;
  /** Deterministic stride subsample — same input, same subset, every run. */
  const strideSample = (idxs: number[], cap: number): number[] => {
    const out: number[] = [];
    for (let i = 0; i < cap; i++) out.push(idxs[Math.floor((i * idxs.length) / cap)]);
    return out;
  };
  for (const idxs of buckets.values()) {
    if (idxs.length < 2) continue;
    colliding++;
    // F2: a pathological bucket (thousands of identical keys — a patterned
    // surface, a tiled texture) is O(k²). Subsample it deterministically
    // and count the skipped pairs so the result states the truncation.
    const members = idxs.length > params.maxPairsPerBucket
      ? strideSample(idxs, params.maxPairsPerBucket)
      : idxs;
    pairsTruncated += pairCount(idxs.length) - pairCount(members.length);
    if (exhausted) {
      pairsTruncated += pairCount(members.length);
      continue;
    }
    // Yield every few buckets — bucket matching is the second O(n²) stage.
    if (colliding % 8 === 0) await breathe(signal);
    let consideredInBucket = 0;
    for (let a1 = 0; a1 < members.length && !exhausted; a1++) {
      for (let a2 = a1 + 1; a2 < members.length; a2++) {
        if (pairsConsidered >= params.maxTotalPairs) {
          exhausted = true;
          break;
        }
        pairsConsidered++;
        consideredInBucket++;
        const p = blocks[members[a1]];
        const q = blocks[members[a2]];
        const dx = p.x - q.x;
        const dy = p.y - q.y;
        if (dx * dx + dy * dy >= minDist2) pairs.push({ i: members[a1], j: members[a2], dx, dy });
      }
    }
    pairsTruncated += pairCount(members.length) - consideredInBucket;
  }
  onProgress?.({ stage: 'Matching blocks…', fraction: 0.85 });
  await breathe(signal);

  // Stage 3: offset clustering — a real copy-move shares one offset.
  const byOffset = new Map<string, Pair[]>();
  for (const p of pairs) {
    const k = `${p.dx},${p.dy}`;
    const arr = byOffset.get(k);
    if (arr) arr.push(p);
    else byOffset.set(k, [p]);
  }
  const clusters: CloneCluster[] = [];
  const matched = new Set<number>();
  const keptPairs: Pair[] = [];
  for (const [k, arr] of byOffset) {
    if (arr.length < params.minClusterSize) continue;
    const [dx, dy] = k.split(',').map(Number);
    clusters.push({ dx, dy, pairs: arr.length });
    for (const p of arr) {
      matched.add(p.i);
      matched.add(p.j);
      keptPairs.push(p);
    }
  }
  clusters.sort((c1, c2) => c2.pairs - c1.pairs);
  await breathe(signal);

  // Stage 4: overlay + the quantized debug view (what the matcher saw).
  const overlay = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    const v = Math.max(0, Math.min(255, Math.round(a.gray[i] * 0.45)));
    overlay[i * 4] = v;
    overlay[i * 4 + 1] = v;
    overlay[i * 4 + 2] = v;
    overlay[i * 4 + 3] = 255;
  }
  // Matched blocks tinted slate (--info #3D6B8E — informational, never a
  // signal color). Both ends of every reported pair are tinted.
  for (const bi of matched) {
    const b = blocks[bi];
    for (let j = 0; j < B; j++) {
      const row = (b.y + j) * W + b.x;
      for (let i = 0; i < B; i++) {
        const o = (row + i) * 4;
        overlay[o] = Math.round(overlay[o] * 0.35 + 61 * 0.65);
        overlay[o + 1] = Math.round(overlay[o + 1] * 0.35 + 107 * 0.65);
        overlay[o + 2] = Math.round(overlay[o + 2] * 0.35 + 142 * 0.65);
      }
    }
  }
  // Offset links: up to 6 sample lines per cluster, block center → center.
  const line = (x0: number, y0: number, x1: number, y1: number) => {
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
    for (let s = 0; s <= steps; s++) {
      const x = Math.round(x0 + ((x1 - x0) * s) / steps);
      const y = Math.round(y0 + ((y1 - y0) * s) / steps);
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const o = (y * W + x) * 4;
      overlay[o] = 235;
      overlay[o + 1] = 245;
      overlay[o + 2] = 250;
    }
  };
  const drawnPerCluster = new Map<string, number>();
  for (const p of keptPairs) {
    const k = `${p.dx},${p.dy}`;
    const n = drawnPerCluster.get(k) ?? 0;
    if (n >= 6) continue;
    drawnPerCluster.set(k, n + 1);
    const half = B >> 1;
    line(blocks[p.i].x + half, blocks[p.i].y + half, blocks[p.j].x + half, blocks[p.j].y + half);
  }

  // Debug view: every CONSIDERED block re-rendered from its quantized key
  // (dequantized coefficients → inverse Haar ≈ the block as the matcher
  // saw it). Overlapping blocks overwrite laterally — that is the view.
  const debug = new Float64Array(W * H).fill(128);
  const rec = new Float64Array(B * B);
  for (const b of blocks) {
    for (let i = 0; i < B * B; i++) rec[i] = b.q[i];
    haarInverse(rec, B, tmp);
    for (let j = 0; j < B; j++) {
      const row = (b.y + j) * W + b.x;
      for (let i = 0; i < B; i++) debug[row + i] = rec[j * B + i];
    }
  }

  onProgress?.({ stage: 'Drawing overlays…', fraction: 1 });

  return {
    state: 'measured',
    params: { ...params, blockSize: B },
    analyzedWidth: W,
    analyzedHeight: H,
    blocksConsidered: blocks.length,
    blocksFilteredLowDetail: lowDetail,
    collidingBuckets: colliding,
    candidatePairs: pairs.length,
    pairsConsidered,
    pairsTruncated,
    clusters,
    matchedBlocks: matched.size,
    overlay: { width: W, height: H, rgba: overlay },
    debugView: lumaToRaster(debug, W, H),
    methodVersion: CLONE_METHOD_VERSION,
    computedAt,
  };
}

/* ================================================================== */
/* Noise analysis — separable median residual (r3 §4)                  */
/* ================================================================== */

export const NOISE_METHOD_VERSION = '1.0.0-w4';

export interface NoiseParams {
  /** Median radius (separable: a 2r+1 tap row pass, then column pass). */
  radius: number;
  /** Residual amplitude stretch for display. */
  amplitude: number;
  /** Long-side cap of the analysis raster. */
  maxSizePx: number;
}

export const NOISE_DEFAULTS: NoiseParams = { radius: 2, amplitude: 8, maxSizePx: 1024 };

export interface NoiseMeasured {
  state: 'measured';
  image: FxRaster;
  meanAbsResidual: number;
  p95AbsResidual: number;
  lumaStd: number;
  radius: number;
  amplitude: number;
  analyzedWidth: number;
  analyzedHeight: number;
  methodVersion: typeof NOISE_METHOD_VERSION;
  computedAt: string;
}

export interface NoiseInsufficient {
  state: 'insufficient';
  reason: string;
  analyzedWidth: number;
  analyzedHeight: number;
  lumaStd: number;
  methodVersion: typeof NOISE_METHOD_VERSION;
  computedAt: string;
}

export type NoiseAnalysisResult = NoiseMeasured | NoiseInsufficient;

/** Rows [yStart, yEnd) of a separable median pass (chunkable). */
function medianInto(
  src: Float64Array, dst: Float64Array, W: number, H: number, radius: number, horizontal: boolean,
  yStart = 0, yEnd = H,
): void {
  const win = new Float64Array(2 * radius + 1);
  if (horizontal) {
    for (let y = yStart; y < yEnd; y++) {
      for (let x = 0; x < W; x++) {
        let n = 0;
        for (let k = -radius; k <= radius; k++) {
          const xx = Math.min(W - 1, Math.max(0, x + k));
          win[n++] = src[y * W + xx];
        }
        const sorted = win.subarray(0, n).slice().sort((p, q) => p - q);
        dst[y * W + x] = sorted[n >> 1];
      }
    }
  } else {
    for (let y = yStart; y < yEnd; y++) {
      for (let x = 0; x < W; x++) {
        let n = 0;
        for (let k = -radius; k <= radius; k++) {
          const yy = Math.min(H - 1, Math.max(0, y + k));
          win[n++] = src[yy * W + x];
        }
        const sorted = win.subarray(0, n).slice().sort((p, q) => p - q);
        dst[y * W + x] = sorted[n >> 1];
      }
    }
  }
}

/**
 * "Reverse denoising": separable median filter, keep the residual,
 * amplitude-stretched for display. Reveals retouching patterns ELA and
 * clone detection miss — and ABSTAINS with a stated reason on flat, tiny,
 * or already-smoother-than-the-filter inputs rather than guessing.
 */
export async function analyzeNoise(
  img: FxRaster,
  paramsIn: Partial<NoiseParams> = {},
  signal?: AbortSignal,
  onProgress?: (p: FxProgress) => void,
): Promise<NoiseAnalysisResult> {
  const params: NoiseParams = { ...NOISE_DEFAULTS, ...paramsIn };
  const computedAt = new Date().toISOString();
  const luma = toLuma(img);
  const a = downscaleLuma(luma, img.width, img.height, params.maxSizePx);
  const W = a.width;
  const H = a.height;

  // Luma spread — the flat-input gate.
  let mean = 0;
  for (let i = 0; i < W * H; i++) mean += a.gray[i];
  mean /= W * H;
  let varSum = 0;
  for (let i = 0; i < W * H; i++) {
    const d = a.gray[i] - mean;
    varSum += d * d;
  }
  const lumaStd = Math.sqrt(varSum / (W * H));

  const insufficient = (reason: string): NoiseInsufficient => ({
    state: 'insufficient', reason, analyzedWidth: W, analyzedHeight: H, lumaStd,
    methodVersion: NOISE_METHOD_VERSION, computedAt,
  });

  if (W < 64 || H < 64) {
    return insufficient(
      `the analysis raster is ${W}×${H} — a median residual needs more area to mean anything. Abstaining rather than guessing.`,
    );
  }
  if (lumaStd < 4) {
    return insufficient(
      `the raster is essentially flat (luma spread σ ≈ ${lumaStd.toFixed(1)}) — there is no texture for a noise residual to measure. Abstaining rather than showing noise that is not there.`,
    );
  }

  const radius = Math.max(1, Math.min(4, Math.round(params.radius)));
  const tmp = new Float64Array(W * H);
  const filt = new Float64Array(W * H);

  // Both median passes run in row batches with yields between — the tab
  // never blocks hard (each batch is well under 100 ms at the 1024px cap).
  const BATCH = 96;
  for (let y = 0; y < H; y += BATCH) {
    medianInto(a.gray, tmp, W, H, radius, true, y, Math.min(H, y + BATCH));
    onProgress?.({ stage: 'Median filter — row pass…', fraction: 0.1 + (0.3 * y) / H });
    await breathe(signal);
  }
  for (let y = 0; y < H; y += BATCH) {
    medianInto(tmp, filt, W, H, radius, false, y, Math.min(H, y + BATCH));
    onProgress?.({ stage: 'Median filter — column pass…', fraction: 0.4 + (0.4 * y) / H });
    await breathe(signal);
  }

  const res = new Float64Array(W * H);
  let sum = 0;
  for (let i = 0; i < W * H; i++) {
    res[i] = Math.abs(a.gray[i] - filt[i]);
    sum += res[i];
  }
  const meanAbs = sum / (W * H);
  const sorted = res.slice().sort((p, q) => p - q);
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(0.95 * sorted.length))];

  if (p95 < 0.75) {
    return insufficient(
      `the median residual is near zero (p95 ≈ ${p95.toFixed(2)} of 255) — the image is already smoother than the filter (flat, synthetic, or heavily processed). Abstaining rather than presenting a black square as a finding.`,
    );
  }

  const amp = params.amplitude;
  const out = new Float64Array(W * H);
  for (let i = 0; i < W * H; i++) out[i] = Math.min(255, res[i] * amp);
  onProgress?.({ stage: 'Stretching residual…', fraction: 1 });

  return {
    state: 'measured',
    image: lumaToRaster(out, W, H),
    meanAbsResidual: meanAbs,
    p95AbsResidual: p95,
    lumaStd,
    radius,
    amplitude: amp,
    analyzedWidth: W,
    analyzedHeight: H,
    methodVersion: NOISE_METHOD_VERSION,
    computedAt,
  };
}

/* ================================================================== */
/* Error Level Analysis — JPEG-gated, caveated (r3 §3 + exclusions)    */
/* ================================================================== */

export const ELA_METHOD_VERSION = '1.0.0-w4';

/** Deck fx.ela.gate — the normative refusal line. */
export const ELA_GATE_REASON = 'JPEG only — not applicable to this file.';

/**
 * The format gate. ELA responds to JPEG recompression history; on anything
 * else it is meaningless, so the tool refuses with the deck's reason (r3:
 * "if included, gate behind format check + prominent caveat").
 */
export function elaGate(format: ByteFormat): { ok: true } | { ok: false; reason: string } {
  return format === 'jpeg' ? { ok: true } : { ok: false, reason: ELA_GATE_REASON };
}

/** Convenience gate on raw bytes (same rule, one call). */
export function elaGateForBytes(bytes: Uint8Array): { ok: true } | { ok: false; reason: string } {
  return elaGate(sniffFormat(bytes));
}

export interface ElaDiffResult {
  state: 'measured';
  /** Amplified per-channel difference, as a viewable raster. */
  image: FxRaster;
  meanAbsDiff: number;
  maxAbsDiff: number;
  quality: number;
  amplification: number;
  analyzedWidth: number;
  analyzedHeight: number;
  methodVersion: typeof ELA_METHOD_VERSION;
  computedAt: string;
}

/**
 * The pure half of ELA: per-channel |orig − resaved|, amplified. The
 * resaved raster MUST come from a JPEG re-encode of the original (the
 * browser half below); dims must match or this throws an honest error the
 * caller renders as a could-not-run state.
 */
export function elaDiff(orig: FxRaster, resaved: FxRaster, quality: number, amplification = 16): ElaDiffResult {
  if (orig.width !== resaved.width || orig.height !== resaved.height) {
    throw new Error(
      `the re-encoded copy came back at ${resaved.width}×${resaved.height}, not ${orig.width}×${orig.height} — the comparison is undefined; not run.`,
    );
  }
  const n = orig.width * orig.height * 4;
  const out = new Uint8ClampedArray(n);
  let sum = 0;
  let max = 0;
  for (let i = 0; i < n; i += 4) {
    for (let c = 0; c < 3; c++) {
      const d = Math.abs(orig.rgba[i + c] - resaved.rgba[i + c]);
      if (d > max) max = d;
      sum += d;
      out[i + c] = Math.min(255, Math.round(d * amplification));
    }
    out[i + 3] = 255;
  }
  return {
    state: 'measured',
    image: { width: orig.width, height: orig.height, rgba: out },
    meanAbsDiff: sum / ((n / 4) * 3),
    maxAbsDiff: max,
    quality,
    amplification,
    analyzedWidth: orig.width,
    analyzedHeight: orig.height,
    methodVersion: ELA_METHOD_VERSION,
    computedAt: new Date().toISOString(),
  };
}

/**
 * The browser half of ELA: re-encode a raster as JPEG at quality q via a
 * canvas, decode it back. DOM-GUARDED: outside a browser this fails with a
 * plain-language error (the CLI/tests never call it — they exercise the
 * pure elaDiff and the gate instead).
 */
export async function reencodeJpeg(img: FxRaster, quality: number): Promise<FxRaster> {
  if (typeof document === 'undefined' || typeof createImageBitmap === 'undefined') {
    throw new Error('JPEG re-encoding needs a browser canvas — not available in this environment.');
  }
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('this browser gave no 2D canvas — the re-encode could not run.');
  const data = new ImageData(new Uint8ClampedArray(img.rgba), img.width, img.height);
  ctx.putImageData(data, 0, 0);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
  if (!blob) throw new Error('the browser refused to encode JPEG — the re-encode could not run.');
  const bmp = await createImageBitmap(blob);
  const back = document.createElement('canvas');
  back.width = bmp.width;
  back.height = bmp.height;
  const bctx = back.getContext('2d', { willReadFrequently: true });
  if (!bctx) {
    bmp.close();
    throw new Error('this browser gave no 2D canvas — the re-encode could not run.');
  }
  bctx.drawImage(bmp, 0, 0);
  bmp.close();
  const px = bctx.getImageData(0, 0, back.width, back.height);
  return { width: back.width, height: back.height, rgba: px.data };
}

/* ================================================================== */
/* Viewing aids — level sweep, luminance gradient, magnifier modes     */
/* (r3: "cheap viewing aids, low evidentiary value" — labeled as aids,  */
/* they show the picture differently and claim nothing)                */
/* ================================================================== */

export const VIEWING_AID_METHOD_VERSION = '1.0.0-w4';

/**
 * Level sweep: a narrow luminance slice stretched to the full range;
 * everything outside the slice goes black. `position` and `width` are
 * 0–1 fractions of the luminance range. Pasted edges appear as
 * discontinuities against the swept band.
 */
export function levelSweep(img: FxRaster, position: number, width: number): FxRaster {
  const w = Math.max(0.01, Math.min(1, width));
  const lo = Math.max(0, Math.min(1, position)) * 255 - (w * 255) / 2;
  const hi = lo + w * 255;
  const gray = toLuma(img);
  const out = new Float64Array(gray.length);
  for (let i = 0; i < gray.length; i++) {
    const v = gray[i];
    out[i] = v < lo || v > hi ? 0 : ((v - lo) / (hi - lo)) * 255;
  }
  return lumaToRaster(out, img.width, img.height);
}

/**
 * Luminance gradient: per-pixel brightness-gradient magnitude (central
 * differences), normalized by the p99 magnitude so the display spans the
 * range. Illumination-direction anomalies and pasted edges stand out.
 */
export function luminanceGradient(img: FxRaster): FxRaster {
  const W = img.width;
  const H = img.height;
  const gray = toLuma(img);
  const mag = new Float64Array(W * H);
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const gx = (gray[y * W + x + 1] - gray[y * W + x - 1]) / 2;
      const gy = (gray[(y + 1) * W + x] - gray[(y - 1) * W + x]) / 2;
      mag[y * W + x] = Math.hypot(gx, gy);
    }
  }
  const sorted = mag.slice().sort((a, b) => a - b);
  const p99 = sorted[Math.min(sorted.length - 1, Math.floor(0.99 * sorted.length))] || 1;
  const out = new Float64Array(W * H);
  for (let i = 0; i < mag.length; i++) out[i] = Math.min(255, (mag[i] / p99) * 255);
  return lumaToRaster(out, W, H);
}

export type MagnifierMode = 'none' | 'auto' | 'auto-channels' | 'equalize';

export const MAGNIFIER_MODES: readonly { id: MagnifierMode; label: string }[] = [
  { id: 'none', label: 'None' },
  { id: 'auto', label: 'Auto contrast' },
  { id: 'auto-channels', label: 'Auto contrast by channel' },
  { id: 'equalize', label: 'Histogram equalization' },
];

/**
 * Magnifier contrast modes — applied to the zoom window only, in the UI.
 * Pure per-raster transforms: no claims, just a different look.
 */
export function applyMagnifierMode(img: FxRaster, mode: MagnifierMode): FxRaster {
  if (mode === 'none') return { width: img.width, height: img.height, rgba: new Uint8ClampedArray(img.rgba) };
  const n = img.width * img.height;
  const out = new Uint8ClampedArray(img.rgba);

  if (mode === 'auto' || mode === 'auto-channels') {
    const lo = [255, 255, 255];
    const hi = [0, 0, 0];
    for (let i = 0; i < n; i++) {
      if (mode === 'auto') {
        const o = i * 4;
        const v = 0.299 * out[o] + 0.587 * out[o + 1] + 0.114 * out[o + 2];
        if (v < lo[0]) lo[0] = v;
        if (v > hi[0]) hi[0] = v;
      } else {
        for (let c = 0; c < 3; c++) {
          const v = out[i * 4 + c];
          if (v < lo[c]) lo[c] = v;
          if (v > hi[c]) hi[c] = v;
        }
      }
    }
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      if (mode === 'auto') {
        const range = hi[0] - lo[0] || 1;
        for (let c = 0; c < 3; c++) {
          out[o + c] = Math.max(0, Math.min(255, Math.round(((out[o + c] - lo[0]) / range) * 255)));
        }
      } else {
        for (let c = 0; c < 3; c++) {
          const range = hi[c] - lo[c] || 1;
          out[o + c] = Math.max(0, Math.min(255, Math.round(((out[o + c] - lo[c]) / range) * 255)));
        }
      }
    }
    return { width: img.width, height: img.height, rgba: out };
  }

  // Histogram equalization on luma, hue-preserving-ish (scale each pixel by
  // the ratio of its equalized to original luma).
  const hist = new Array<number>(256).fill(0);
  const luma = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const v = Math.round(0.299 * out[o] + 0.587 * out[o + 1] + 0.114 * out[o + 2]);
    luma[i] = v;
    hist[v]++;
  }
  const cdf = new Array<number>(256).fill(0);
  let acc = 0;
  for (let i = 0; i < 256; i++) {
    acc += hist[i];
    cdf[i] = acc;
  }
  const cdfMin = cdf.find((v) => v > 0) ?? 0;
  const denom = n - cdfMin || 1;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const eq = Math.max(0, Math.round(((cdf[luma[i]] - cdfMin) / denom) * 255));
    const ratio = luma[i] > 0 ? eq / luma[i] : 1;
    for (let c = 0; c < 3; c++) {
      out[o + c] = Math.max(0, Math.min(255, Math.round(out[o + c] * ratio)));
    }
  }
  return { width: img.width, height: img.height, rgba: out };
}

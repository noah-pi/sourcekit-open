// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Desk-side rolling-shutter skew vs IMU analyzer.
 *
 * Input: sampled video frames (CLI: ffmpeg rasterization; browser: the
 * videoMotion adapter) plus, optionally, the session's sensor log
 * (JSONL — the same parser the parallax analyzer uses).
 *
 * Method — PURE DETERMINISTIC GEOMETRY (G1 design rules, locked: no ML
 * score, no metadata-statistical score, no combined probability, no
 * per-frame aggregation into a verdict):
 *  1. Per frame pair, the frame is split into BANDS horizontal strips; the
 *     SAME SAD block matcher as the global-motion estimator finds the
 *     median displacement per strip. A rolling-shutter sensor reads rows
 *     at staggered times, so under rotation the vertical displacement
 *     varies LINEARLY with row: dy(row) ≈ dy0 + ω·f·τ_row·row.
 *  2. The skew estimate is the least-squares slope of per-band vertical
 *     displacement vs band row, px/row at the analysis raster. Absolute
 *     row-time τ_row is NOT recoverable without intrinsics (focal length)
 *     — stated, not faked; the measured quantity is the geometric slope.
 *  3. When a gyro log is present, the rotation rate integrated over each
 *     pair's interval (the axis whose series best matches the slope series
 *     is resolved ONCE from the data, exactly like the parallax analyzer's
 *     roll-axis resolution) is compared against the per-pair slope series:
 *     a SHAPE correlation and a sign agreement, reported raw with sample
 *     counts. The gyro is a consistency reference, never a scored second
 *     trajectory fed into any model.
 *
 * OUTPUT: an evidence object — measured skew slope per pair, the series
 * correlation against gyro rotation rate, and the honest note that sign/
 * shape consistency is what is measured. Never a verdict, never a gate.
 * Insufficient data reports 'insufficient' with the specific reason —
 * never a number dressed up as evidence. Without a gyro the skew is still
 * measured and the consistency check reports not-available with the reason.
 */

import { estimateGlobalMotion, matchBlock } from '@exhibit/lib/opticalflow';
import { integrateRate } from '@exhibit/lib/imuflow';
import type { GrayPlane, GyroLog } from './parallax';

export const SKEW_METHOD_VERSION = '1.0.0-ws5-t1';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SkewPairMeasurement {
  /** Index of the pair's second frame in the decoded frame list. */
  frameBIndex: number;
  /** Least-squares slope of per-band vertical displacement vs row, px/row. */
  bandGradientPxPerRow: number;
  /** Bands that produced a usable median displacement (of BANDS). */
  bandsUsed: number;
  /** Global-fit vertical translation for the pair, px (reference). */
  globalTyPx: number;
  /** Integrated gyro rotation rate over the pair interval, rad/s — null without a gyro. */
  gyroRateRadPerSec: number | null;
}

export interface SkewEvidence {
  status: 'measured' | 'insufficient';
  /** false, or the specific reason no measurement could be made. */
  insufficient: false | string;
  framesDecoded: number;
  pairsAnalyzed: number;
  /**
   * The rolling-shutter skew estimate: median per-pair slope of vertical
   * displacement across rows. px/row at the analysis raster — a geometric
   * quantity; absolute row-time needs intrinsics this analyzer never assumes.
   */
  skewEstimate: null | {
    value: number;
    unit: 'px-per-row-at-analysis-raster';
    note: string;
  };
  perPair: SkewPairMeasurement[];
  /**
   * Slope-series vs gyro-rate consistency. Null when no gyro log was
   * provided — reported as not-available with the reason in limitations,
   * never fabricated.
   */
  gyroConsistency: null | {
    /** Which gyro axis was resolved from the data (and its sign). */
    axisResolved: string;
    /** Pearson correlation of the per-pair slope series vs gyro rate series. */
    correlation: number | null;
    /** Sign agreement fraction where both magnitudes exceed the noise floor. */
    signAgreement: number | null;
    pairsUsed: number;
    note: string;
  };
  /**
   * Whether the gyro reference is authenticated under the capture signature.
   * Literal false in this build: the sensor log is an unauthenticated
   * sidecar — consistency with it is evidence, never a trust upgrade.
   */
  gyroPriorAuthenticated: false;
  methodVersion: typeof SKEW_METHOD_VERSION;
  computedAt: string;
  limitations: string[];
}

// ---------------------------------------------------------------------------
// Constants — stated, not hidden
// ---------------------------------------------------------------------------

const MIN_FRAMES = 4;
const MIN_PAIRS = 3;
/** Horizontal strips per frame for the per-band displacement series. */
const BANDS = 8;
/** Block-match grid stride within a band, px (analysis raster). */
const BAND_STRIDE = 16;
/** Per-pair search radius for the block matcher, px. */
const SEARCH_RADIUS = 10;
/** Usable displacement medians a band must have to count. */
const MIN_BAND_MATCHES = 4;
/** Slope/rate magnitudes below which sign comparison is noise. */
const SIGN_FLOOR_SLOPE = 0.002; // px/row
const SIGN_FLOOR_RATE = 0.02; // rad/s
/** Best-axis |correlation| below which the gyro is declared unrelatable. */
const MIN_AXIS_CORR = 0.5;

const FIXED_LIMITATIONS = [
  'corpus characterization pending; no error rates published',
  'a geometric measurement for human review — evidence a person weighs, never a verdict and never a gate',
  'G1 design rules: no ML score, no metadata-statistical score, no combined probability, no per-frame aggregation into any verdict — per-pair numbers are reported raw',
  'the skew estimate is a geometric slope (px/row at the analysis raster); absolute row-time in seconds needs focal length, which is never assumed — do not quote the slope as a time',
  'sensor log is an unauthenticated sidecar in this build; gyro consistency is evidence, never a trust upgrade — a crafted log can imitate a slope series',
  'a static or slowly translating camera produces near-zero slope AND near-zero gyro rate: consistency there is consistency of noise and proves nothing (the sign floor excludes trivial magnitudes, stated inline)',
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length)));
  return sorted[i];
}

const round3 = (v: number): number => Math.round(v * 1000) / 1000;

function pearson(a: number[], b: number[]): number | null {
  if (a.length !== b.length || a.length < 3) return null;
  const ma = a.reduce((s, v) => s + v, 0) / a.length;
  const mb = b.reduce((s, v) => s + v, 0) / b.length;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < a.length; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  if (da < 1e-12 || db < 1e-12) return null;
  return num / Math.sqrt(da * db);
}

/** Least-squares slope of y vs x. */
function slope(xs: number[], ys: number[]): number {
  const n = xs.length;
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  return den > 1e-12 ? num / den : 0;
}

// ---------------------------------------------------------------------------
// The analyzer
// ---------------------------------------------------------------------------

export interface SkewOptions {
  /** Parsed sensor log; null/omitted → skew measured, consistency not available. */
  gyro?: GyroLog | null;
  /**
   * Frame interval of the sampled series, seconds (CLI: the rasterization
   * fps; ring: uniform spacing assumed — disclosed by the caller's note).
   */
  frameIntervalSec?: number;
  /** Origin note for the limitations list. */
  sourceNote?: string;
  /** Injection point for tests. */
  now?: Date;
}

export function analyzeRollingShutterSkew(
  framesIn: (GrayPlane | null)[] | null,
  opts: SkewOptions = {},
): SkewEvidence {
  const computedAt = (opts.now ?? new Date()).toISOString();
  const limitations: string[] = [...FIXED_LIMITATIONS];
  if (opts.sourceNote) limitations.push(`frame source: ${opts.sourceNote}`);

  const frames = (framesIn ?? []).filter((f): f is GrayPlane => f !== null);

  const insufficient = (reason: string): SkewEvidence => ({
    status: 'insufficient',
    insufficient: reason,
    framesDecoded: frames.length,
    pairsAnalyzed: 0,
    skewEstimate: null,
    perPair: [],
    gyroConsistency: null,
    gyroPriorAuthenticated: false,
    methodVersion: SKEW_METHOD_VERSION,
    computedAt,
    limitations,
  });

  if (framesIn === null) {
    return insufficient('frame series not available — the caller states why (video undecodable or never-recorded); no measurement offered');
  }
  if (frames.length < MIN_FRAMES) {
    return insufficient(`only ${frames.length} frames decodable (need ${MIN_FRAMES}) — clip too short or decode incomplete`);
  }
  const w = frames[0].width;
  const h = frames[0].height;
  if (!frames.every((f) => f.width === w && f.height === h)) {
    return insufficient('frames disagree on dimensions — not a uniform series');
  }
  limitations.push(`analysis raster ${w}×${h} px; slopes are px/row at this scale`);

  // ---- per-pair band displacement series -------------------------------------
  const bandRows: number[] = [];
  for (let b = 0; b < BANDS; b++) bandRows.push(((b + 0.5) * h) / BANDS);
  const margin = 4 + SEARCH_RADIUS + 2;

  interface PairRaw {
    frameBIndex: number;
    gradient: number;
    bandsUsed: number;
    globalTy: number;
  }
  const pairs: PairRaw[] = [];
  let pairsNoGlobal = 0;
  for (let k = 1; k < frames.length; k++) {
    const a = frames[k - 1];
    const b = frames[k];
    const global = estimateGlobalMotion(a.gray, b.gray, w, h);
    if (!global) {
      pairsNoGlobal++;
      continue;
    }
    const bandDy: (number | null)[] = bandRows.map(() => null);
    const bandCount = bandRows.map(() => 0);
    const bandVals: number[][] = bandRows.map(() => []);
    for (let y = margin; y <= h - margin; y += BAND_STRIDE) {
      const band = Math.min(BANDS - 1, Math.floor((y / h) * BANDS));
      for (let x = margin; x <= w - margin; x += BAND_STRIDE) {
        const m = matchBlock(a.gray, b.gray, w, h, x, y, { searchRadius: SEARCH_RADIUS });
        if (!m) continue;
        bandVals[band].push(m.dy);
      }
    }
    for (let i = 0; i < BANDS; i++) {
      if (bandVals[i].length >= MIN_BAND_MATCHES) {
        bandDy[i] = percentile([...bandVals[i]].sort((p, q) => p - q), 50);
        bandCount[i] = bandVals[i].length;
      }
    }
    const usableRows: number[] = [];
    const usableDy: number[] = [];
    let bandsUsed = 0;
    for (let i = 0; i < BANDS; i++) {
      if (bandDy[i] !== null) {
        usableRows.push(bandRows[i]);
        usableDy.push(bandDy[i]!);
        bandsUsed++;
      }
    }
    if (bandsUsed < BANDS / 2) {
      pairsNoGlobal++;
      continue; // featureless half the frame — no honest slope
    }
    pairs.push({
      frameBIndex: k,
      gradient: slope(usableRows, usableDy),
      bandsUsed,
      globalTy: global.ty,
    });
  }
  if (pairsNoGlobal > 0) {
    limitations.push(`${pairsNoGlobal} frame pair(s) produced no usable band-displacement series (featureless or motion too large) — dropped, disclosed, never interpolated`);
  }
  if (pairs.length < MIN_PAIRS) {
    return insufficient(
      `only ${pairs.length} usable frame pairs (need ${MIN_PAIRS}) — scene too featureless, too dark, or clip too short for a skew series`,
    );
  }

  const perPair: SkewPairMeasurement[] = pairs.map((p) => ({
    frameBIndex: p.frameBIndex,
    bandGradientPxPerRow: round3(p.gradient),
    bandsUsed: p.bandsUsed,
    globalTyPx: round3(p.globalTy),
    gyroRateRadPerSec: null,
  }));

  // ---- gyro consistency (when the log exists) ----------------------------------
  const gyro = opts.gyro ?? null;
  let gyroConsistency: SkewEvidence['gyroConsistency'] = null;
  if (gyro && gyro.tMs.length >= 2) {
    const dtMs = (opts.frameIntervalSec ?? 1 / 30) * 1000;
    const nFrames = frames.length;
    const tEnd = gyro.tMs[gyro.tMs.length - 1];
    const axes: { name: 'x' | 'y' | 'z'; rate: number[] }[] = [
      { name: 'x', rate: gyro.x },
      { name: 'y', rate: gyro.y },
      { name: 'z', rate: gyro.z },
    ];
    const slopes = pairs.map((p) => p.gradient);
    // Resolve the axis ONCE from the data: the axis whose per-pair
    // integrated rate best correlates with the per-pair slope series.
    let best: { desc: string; rates: number[]; r: number } | null = null;
    for (const ax of axes) {
      const rates: number[] = [];
      for (const p of pairs) {
        const t1 = tEnd - (nFrames - 1 - p.frameBIndex) * dtMs;
        const t0 = t1 - dtMs;
        rates.push(integrateRate(gyro.tMs, ax.rate, t0, t1) / (dtMs / 1000));
      }
      const r = pearson(slopes, rates);
      if (r === null) continue;
      if (!best || Math.abs(r) > Math.abs(best.r)) best = { desc: `gyro ${ax.name}-axis`, rates, r };
    }
    if (best && Math.abs(best.r) >= MIN_AXIS_CORR) {
      const sign = Math.sign(best.r);
      const rates = best.rates.map((v) => v * sign);
      for (let i = 0; i < pairs.length; i++) perPair[i].gyroRateRadPerSec = round3(rates[i]);
      // Sign agreement where BOTH sides exceed the noise floor.
      let signPairs = 0;
      let same = 0;
      for (let i = 0; i < pairs.length; i++) {
        if (Math.abs(slopes[i]) < SIGN_FLOOR_SLOPE || Math.abs(rates[i]) < SIGN_FLOOR_RATE) continue;
        signPairs++;
        if (Math.sign(slopes[i]) === Math.sign(rates[i])) same++;
      }
      const corr = pearson(slopes, rates);
      gyroConsistency = {
        axisResolved: `${best.desc}, sign ${sign > 0 ? '+' : '−'} (resolved once from the data)`,
        correlation: corr === null ? null : round3(corr),
        signAgreement: signPairs > 0 ? round3(same / signPairs) : null,
        pairsUsed: pairs.length,
        note:
          `per-pair skew slope vs integrated gyro rotation rate over ${pairs.length} pairs — shape correlation and sign agreement of two geometric series, ` +
          'reported raw; consistency of a crafted log with a fabricated video remains possible (sidecar unauthenticated)',
      };
      limitations.push(
        `gyro aligned by uniform ${(opts.frameIntervalSec ?? 1 / 30).toFixed(4)} s spacing ending at the last gyro sample (frames carry no per-frame timestamps); misalignment shows up as a weak correlation, stated not hidden`,
      );
    } else {
      limitations.push(
        `gyro log present but no axis related to the skew slope series (best |r|=${best ? round3(Math.abs(best.r)) : 'n/a'} < ${MIN_AXIS_CORR}) — consistency reported as not-measurable, gyro series NOT injected into the measurement`,
      );
    }
    for (const issue of gyro.issues) limitations.push(`sensor log: ${issue}`);
  } else if (gyro) {
    limitations.push('gyro log present but unusable (<2 samples) — skew measured, consistency not available');
  } else {
    limitations.push('no gyro log — skew slope measured; consistency vs rotation rate NOT AVAILABLE (log absent or never-recorded — the caller states which), nothing fabricated');
  }

  const med = percentile(pairs.map((p) => p.gradient).sort((a, b) => a - b), 50);
  return {
    status: 'measured',
    insufficient: false,
    framesDecoded: frames.length,
    pairsAnalyzed: pairs.length,
    skewEstimate: {
      value: round3(med),
      unit: 'px-per-row-at-analysis-raster',
      note:
        'median per-pair least-squares slope of vertical block displacement vs row; under rolling shutter this slope ≈ ω·f·τ_row ' +
        '(rotation rate × focal × row readout time) — a geometric quantity for a reviewer, NOT a time and NOT a verdict; ' +
        'compare its per-pair series against the gyro rate series in gyroConsistency when present',
    },
    perPair,
    gyroConsistency,
    gyroPriorAuthenticated: false,
    methodVersion: SKEW_METHOD_VERSION,
    computedAt,
    limitations,
  };
}

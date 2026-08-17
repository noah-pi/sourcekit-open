// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * P5 single-image physics: Poisson–PRNU independence profile
 * (Plan-0.13.0 P5 item 24).
 *
 * Photon shot noise is SIGNAL-DEPENDENT: in a linear-light readout its
 * variance grows with the local mean (Poisson: variance ∝ mean; in practice
 * variance = a·mean + b with read-noise floor b). A sensor's fixed pattern
 * (PRNU) is MULTIPLICATIVE and signal-independent in structure: the same
 * per-pixel gain pattern rides every exposure, so a high-pass residual
 * NORMALIZED by the local mean correlates with the committed reference
 * pattern (or across flat fields). Synthetic or reprocessed pixels break
 * this profile: added Gaussian noise is signal-INdependent (variance flat
 * in the mean), and no physical pattern exists to match.
 *
 * METHOD (pure, deterministic):
 *   1. High-pass residual: luma minus a separable box-blur local mean
 *      (radius 4). Edge-dominated pixels are trimmed per bin (MAD), never
 *      smoothed over.
 *   1b. Edge mask: only pixels below the 60th percentile of local gradient
 *      magnitude (measured on the BLURRED plane) are profiled. Misaligned-
 *      channel and blur-mismatch residual energy concentrates at gradients;
 *      shot noise is spatially uniform, so masking edges removes the former
 *      without biasing the latter (standard flat-region practice).
 *   2. Leg (a), the Poisson leg: bin pixels by local mean (20 quantile
 *      bins), robust variance per bin, least-squares fit v = a·μ + b.
 *      Report slope a, fit R², and slope significance t. A real linear
 *      readout shows a clearly positive slope with high R²; added uniform
 *      noise sits flat (a ≈ 0) with amplitude.
 *   3. Leg (b), the PRNU/reference leg: when a committed reference pattern
 *      is provided (same dimensions — a flat-field pattern the capture
 *      committed alongside), correlate the mean-normalized residual with
 *      it (Pearson). Without a reference there is NOTHING to match against
 *      — the leg reports 'not-applicable' rather than fabricating a
 *      self-referential pattern from the image itself.
 *
 * STATES:
 *   - 'expected-profile': significant noise amplitude AND a positive,
 *      well-fitting variance-vs-mean slope. Consistent with a real linear
 *      sensor readout — NOT clearance: a synthesizer can add Poisson-shaped
 *      noise, and heavy JPEG/noise-reduction reshapes the profile.
 *   - 'anomalous-profile': significant noise amplitude WITHOUT the
 *      signal-dependent growth (flat or negative slope). Consistent with
 *      added uniform noise / reprocessing — and also with aggressive
 *      noise reduction or tone-mapped (non-linear) pixels, so it is NOT
 *      suspicion by itself.
 *   - 'insufficient-data': too smooth or too small to profile.
 *
 * Error rates are UNCHARACTERIZED until the P6 corpus ROC lands; every
 * threshold below is a first-principles placeholder. This is a statistical
 * signal a person weighs, never a verdict.
 */

export const POISSON_PRNU_METHOD_VERSION = '0.1.0-p5-scaffold';

/** Bins for the variance-vs-mean fit. */
export const POISSON_BINS = 20;
/** Fit-quality floor for 'expected-profile' (placeholder, P6). */
export const POISSON_MIN_FIT_R2 = 0.6;
/** Slope-significance floor (t statistic) for 'expected-profile' (placeholder, P6). */
export const POISSON_MIN_SLOPE_T = 3;
/** |Pearson r| floor for the reference-pattern match (placeholder, P6). */
export const PRNU_MIN_REFERENCE_CORR = 0.3;

export type PoissonPrnuState = 'expected-profile' | 'anomalous-profile' | 'insufficient-data';
export type ReferenceLegState = 'reference-match' | 'no-reference-match' | 'not-applicable';

export interface PoissonPrnuOptions {
  /** Committed reference (flat-field) pattern — same length as the luma. */
  referencePattern?: ArrayLike<number>;
}

export interface ReferenceLeg {
  state: ReferenceLegState;
  correlation?: number;
  text: string;
}

export interface PoissonPrnuResult {
  state: PoissonPrnuState;
  /** R² of the variance-vs-mean linear fit (the leg-(a) score). */
  score?: number;
  poissonSlope?: number;
  varianceFitR2?: number;
  slopeT?: number;
  /** Robust residual stddev (noise amplitude) in luma units. */
  residualStd?: number;
  reference: ReferenceLeg;
  methodVersion: string;
  text: string;
}

const FRAMING =
  'This is a statistical signal a person weighs, never a verdict; its error rates are uncharacterized until the corpus benchmark lands.';

/** Separable box blur, radius r. */
function boxBlur(src: ArrayLike<number>, w: number, h: number, r: number): Float64Array {
  const tmp = new Float64Array(w * h);
  const out = new Float64Array(w * h);
  const win = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    let acc = 0;
    for (let x = -r; x <= r; x++) acc += src[y * w + Math.min(Math.max(x, 0), w - 1)];
    for (let x = 0; x < w; x++) {
      tmp[y * w + x] = acc / win;
      const xa = Math.min(x + r + 1, w - 1), xs = Math.max(x - r, 0);
      acc += src[y * w + xa] - src[y * w + xs];
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let y = -r; y <= r; y++) acc += tmp[Math.min(Math.max(y, 0), h - 1) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = acc / win;
      const ya = Math.min(y + r + 1, h - 1), ys = Math.max(y - r, 0);
      acc += tmp[ya * w + x] - tmp[ys * w + x];
    }
  }
  return out;
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function pearson(xs: ArrayLike<number>, ys: ArrayLike<number>, n: number): number {
  if (n < 3) return 0;
  let mx = 0, my = 0;
  for (let i = 0; i < n; i++) { mx += xs[i]; my += ys[i]; }
  mx /= n; my /= n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
  }
  return sxx <= 1e-12 || syy <= 1e-12 ? 0 : sxy / Math.sqrt(sxx * syy);
}

export function analyzePoissonPrnu(
  luma: ArrayLike<number>,
  width: number,
  height: number,
  opts: PoissonPrnuOptions = {},
): PoissonPrnuResult {
  const base = { methodVersion: POISSON_PRNU_METHOD_VERSION, text: '' };
  const n = width * height;
  if (width < 64 || height < 64) {
    return {
      ...base,
      state: 'insufficient-data',
      reference: { state: 'not-applicable', text: 'reference leg not reached — the image is too small to profile' },
      text: `Insufficient data: ${width}×${height} is too small for a noise profile (minimum 64×64). Nothing was measured. ${FRAMING}`,
    };
  }

  const mean = boxBlur(luma, width, height, 4);
  const residual = new Float64Array(n);
  for (let i = 0; i < n; i++) residual[i] = luma[i] - mean[i];

  // Edge mask: gradient magnitude on the BLURRED plane; keep the flattest
  // 60% of interior pixels. Misalignment/blur-mismatch residual concentrates
  // at gradients; shot noise is spatially uniform, so the mask removes the
  // former without biasing the latter.
  const grad = new Float64Array(n);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const gx = (mean[i + 1] - mean[i - 1]) / 2;
      const gy = (mean[i + width] - mean[i - width]) / 2;
      grad[i] = Math.hypot(gx, gy);
    }
  }
  const interiorAll: number[] = [];
  const B = 8;
  for (let y = B; y < height - B; y++) for (let x = B; x < width - B; x++) interiorAll.push(y * width + x);
  const gradSorted = interiorAll.map((i) => grad[i]).sort((a, b) => a - b);
  const gradCap = gradSorted[Math.floor(gradSorted.length * 0.6)] ?? Infinity;
  const interior = interiorAll.filter((i) => grad[i] <= gradCap);

  const absRes = interior.map((i) => Math.abs(residual[i]));
  const residualStd = 1.4826 * median(absRes);

  // Dynamic-range-scaled noise floor: below this the "residual" is
  // quantization and blur error, not a noise profile.
  let lo = Infinity, hi = -Infinity;
  for (const i of interior) { if (mean[i] < lo) lo = mean[i]; if (mean[i] > hi) hi = mean[i]; }
  const range = Math.max(hi - lo, 1e-9);
  if (residualStd < range * 1e-3) {
    return {
      ...base,
      state: 'insufficient-data',
      residualStd,
      reference: { state: 'not-applicable', text: 'reference leg not reached — no measurable noise residual' },
      text:
        `Insufficient data: the high-pass residual (robust σ ≈ ${residualStd.toExponential(1)}) is below the ` +
        'profiling floor for this dynamic range — the image is too smooth or too heavily processed to carry a ' +
        'measurable noise profile. Nothing was measured; that is not clearance. ' + FRAMING,
    };
  }

  // ---- Leg (a): variance vs local mean ------------------------------------
  const sorted = [...interior].sort((a, b) => mean[a] - mean[b]);
  const binCount = Math.min(POISSON_BINS, Math.floor(sorted.length / 200));
  const binMean: number[] = [];
  const binVar: number[] = [];
  const binN: number[] = [];
  for (let b = 0; b < binCount; b++) {
    const slice = sorted.slice(Math.floor((b * sorted.length) / binCount), Math.floor(((b + 1) * sorted.length) / binCount));
    if (slice.length < 50) continue;
    let mu = 0;
    for (const i of slice) mu += mean[i];
    mu /= slice.length;
    // MAD-trimmed variance: drop edge-dominated outliers, never smooth them in.
    const res = slice.map((i) => residual[i]);
    const med = median(res);
    const mad = 1.4826 * median(res.map((v) => Math.abs(v - med)));
    const kept = res.filter((v) => Math.abs(v - med) <= 5 * Math.max(mad, 1e-12));
    let v = 0, m2 = 0;
    for (const x of kept) m2 += x;
    m2 /= kept.length;
    for (const x of kept) v += (x - m2) * (x - m2);
    v /= kept.length;
    binMean.push(mu); binVar.push(v); binN.push(kept.length);
  }

  if (binMean.length < 5 || range < 1e-9) {
    return {
      ...base,
      state: 'insufficient-data',
      residualStd,
      reference: { state: 'not-applicable', text: 'reference leg not reached — too few mean bins' },
      text: 'Insufficient data: too few populated mean bins for a variance fit. Nothing was measured. ' + FRAMING,
    };
  }

  // Weighted least squares v = a·μ + b (weights = kept count).
  let sw = 0, swx = 0, swy = 0, swxx = 0, swxy = 0;
  for (let i = 0; i < binMean.length; i++) {
    const wgt = binN[i];
    sw += wgt; swx += wgt * binMean[i]; swy += wgt * binVar[i];
    swxx += wgt * binMean[i] * binMean[i]; swxy += wgt * binMean[i] * binVar[i];
  }
  const det = sw * swxx - swx * swx;
  const slope = det !== 0 ? (sw * swxy - swx * swy) / det : 0;
  const intercept = det !== 0 ? (swy - slope * swx) / sw : 0;
  // R² (unweighted, on the bin points) and slope t-statistic.
  const yMean = binVar.reduce((a, v) => a + v, 0) / binVar.length;
  let ssRes = 0, ssTot = 0;
  for (let i = 0; i < binMean.length; i++) {
    const fit = slope * binMean[i] + intercept;
    ssRes += (binVar[i] - fit) * (binVar[i] - fit);
    ssTot += (binVar[i] - yMean) * (binVar[i] - yMean);
  }
  const r2 = ssTot > 1e-12 ? Math.max(0, 1 - ssRes / ssTot) : 0;
  const dof = Math.max(binMean.length - 2, 1);
  const s2 = ssRes / dof;
  const seSlope = det !== 0 ? Math.sqrt((s2 * sw) / det) : Infinity;
  const slopeT = seSlope > 0 && Number.isFinite(seSlope) ? slope / seSlope : 0;

  const expected = slope > 0 && r2 >= POISSON_MIN_FIT_R2 && slopeT >= POISSON_MIN_SLOPE_T;

  // ---- Leg (b): committed reference pattern -------------------------------
  let reference: ReferenceLeg;
  if (opts.referencePattern && opts.referencePattern.length === n) {
    // Mean-normalized residual vs the committed pattern, interior only.
    const norm: number[] = [];
    const ref: number[] = [];
    for (const i of interior) {
      norm.push(residual[i] / Math.max(mean[i], range * 0.05));
      ref.push(opts.referencePattern[i]);
    }
    const corr = pearson(norm, ref, norm.length);
    const matched = Math.abs(corr) >= PRNU_MIN_REFERENCE_CORR;
    reference = {
      state: matched ? 'reference-match' : 'no-reference-match',
      correlation: corr,
      text: matched
        ? `Reference leg: the mean-normalized residual correlates with the committed reference pattern ` +
          `(Pearson r = ${corr.toFixed(3)}, floor ±${PRNU_MIN_REFERENCE_CORR}) — consistent with a stable ` +
          'multiplicative sensor pattern. A leaked or committed-by-the-same-source pattern produces this too; ' +
          'it is consistency, not clearance. ' + FRAMING
        : `Reference leg: no correlation with the committed reference pattern (Pearson r = ${corr.toFixed(3)}, ` +
          `floor ±${PRNU_MIN_REFERENCE_CORR}). Consistent with synthetic/reprocessed pixels — and with a ` +
          'mismatched, cropped, or re-registered reference, so this is not suspicion by itself. ' + FRAMING,
    };
  } else {
    reference = {
      state: 'not-applicable',
      text:
        'Reference leg not applicable: no committed reference pattern was provided' +
        (opts.referencePattern ? ' at the image dimensions' : '') +
        ' — there is nothing to match against, and this check never fabricates a self-referential pattern ' +
        'from the image itself. ' + FRAMING,
    };
  }

  const measured =
    `slope ${slope.toExponential(2)} (t = ${slopeT.toFixed(1)}, floor ${POISSON_MIN_SLOPE_T}), ` +
    `fit R² ${r2.toFixed(2)} (floor ${POISSON_MIN_FIT_R2}), residual σ ≈ ${residualStd.toFixed(3)} over ${binMean.length} bins`;

  if (expected) {
    return {
      ...base,
      state: 'expected-profile',
      score: r2,
      poissonSlope: slope,
      varianceFitR2: r2,
      slopeT,
      residualStd,
      reference,
      text:
        `Signal-dependent noise profile (${measured}): residual variance grows with the local mean, the Poisson ` +
        'shot-noise shape of a real linear readout. Consistency, not clearance: Poisson-shaped noise can be ' +
        'synthesized, and processing reshapes the profile either way. ' + FRAMING,
    };
  }
  return {
    ...base,
    state: 'anomalous-profile',
    score: r2,
    poissonSlope: slope,
    varianceFitR2: r2,
    slopeT,
    residualStd,
    reference,
    text:
      `Anomalous noise profile (${measured}): measurable noise whose variance does NOT grow with the local ` +
      'mean the way photon shot noise must — consistent with added signal-independent noise, heavy ' +
      'reprocessing, or noise reduction, none of which is distinguishable here. Not suspicion by itself. ' +
      FRAMING,
  };
}

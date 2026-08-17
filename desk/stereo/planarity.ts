// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * The stereo planarity signal.
 *
 * Pipeline: undistort both views through the committed calibration → fit a
 * single homography to the injected correspondences → measure the residual
 * and inlier ratio → decide, WITH THE DISTANCE GATE AS PART OF THE SIGNAL.
 *
 * Why the gate is not a footnote: disparity falls as 1/Z, and the DEPTH
 * DISCRIMINATION (what separates "flat" from "3D") falls as 1/Z² —
 * d(disparity)/dZ = f·B/Z². With a phone's ~10–12mm baseline, a depth
 * spread we care about (~0.5 m) stops moving pixels measurably beyond
 * roughly three meters. Beyond that range a flat screen and a real 3D scene
 * are geometrically indistinguishable to this signal, so the ONLY honest
 * output is 'insufficient-geometry' — never 'planar', never anything that
 * could be read as "passed".
 *
 * Why 'non-planar' is not a verdict either: it means the two views are not
 * explained by one homography at this scene depth. Real 3D structure does
 * that. So does a feature-matching failure. Neither says anything about
 * authenticity — and 'planar' says nothing about recapture: a genuine
 * photograph of a wall is planar too. Every text string below carries the
 * effective-range bound and the "signal, not a verdict" framing, because
 * absence of a flag must never read as proof of authenticity.
 *
 * Thresholds are first-principles placeholders derived from the matcher
 * noise floor (see constants). P6 replaces them with corpus-measured ROC
 * operating points before any of this surfaces in UI.
 */

import type { Correspondence, PlanaritySignal, StereoCommitment } from './types';
import { undistortPixel, frameDomainRadius } from './undistort';
import { fitHomographyRansac } from './homography';

export const STEREO_METHOD_VERSION = '0.1.0-p4-scaffold';

/**
 * Median symmetric-transfer-error ceiling for 'planar', in pixels.
 * Justification: at the assumed matcher noise floor σ ≈ 0.5 px, the
 * symmetric transfer error is a 4-dof chi variable with median ≈ 0.92 px
 * and p99 ≈ 1.7 px — 1.5 px accepts ordinary matcher noise on a true plane
 * while sitting far below the differential disparity real depth produces
 * inside range (at 2 m with a 12 mm baseline and f ≈ 1100 px, one meter of
 * depth spread moves a point ~3.3 px). A ROC-measured replacement is a P6
 * deliverable.
 */
export const PLANAR_MAX_RESIDUAL_PX = 1.5;

/**
 * RANSAC inlier gate, in focal-averaged pixel-equivalent units. This gate
 * is NOT the decision threshold — it exists only to keep honest
 * matcher-noise inliers available for the refit. Under σ = 0.5 px matcher
 * noise the symmetric transfer error is a 4-dof chi variable, and the
 * wide ↔ ultra-wide rig's ~2:1 focal mismatch inflates its scale to
 * ≈ 1.2 focal-averaged px; a 2 px gate would wrongly reject ~40% of true
 * inliers on a flat scene (measured, not guessed: fixture (d) in
 * test-stereo-planarity.mts). 3.5 px ≈ 2.9σ keeps ~93% of them while
 * staying far below the multi-pixel differential disparity a real 3D scene
 * produces inside range. The actual decision is median residual + inlier
 * ratio, below.
 */
export const RANSAC_INLIER_THRESHOLD_PX = 3.5;

/** Assumed per-coordinate matcher noise, σ in pixels — pending corpus characterization. */
export const MATCHER_NOISE_SIGMA_PX = 0.5;

/**
 * The smallest scene depth spread the signal claims to discriminate, in
 * meters. Combined with the noise floor this DEFINES the effective range:
 * Z_max = sqrt(f·B·ΔZ_min / ρ). It is a claim about physics, not a tuning
 * knob — raising it shrinks the honest range.
 */
export const MIN_DEPTH_DISCRIMINATION_M = 0.5;

/** Below this many correspondences no model can be supported at all. */
export const MIN_CORRESPONDENCES = 12;

/** Below this many RANSAC inliers the fit cannot be trusted as a measurement. */
export const MIN_INLIERS = 8;

/**
 * Minimum inlier ratio for a 'planar' reading. WHY this gate exists: RANSAC
 * can lock onto a planar SUBSET of a 3D scene (the far wall, the table top)
 * and report a tiny residual on that subset alone. The depth signal then
 * lives in the points it had to REJECT. A genuinely flat scene with matcher
 * noise puts ~all correspondences on one homography; a 3D scene cannot.
 * 0.75 leaves room for honest matching outliers without letting a
 * planar-subset fit masquerade as a flat scene.
 */
export const MIN_INLIER_RATIO_PLANAR = 0.75;

/** Below this baseline (meters) stereo geometry is decorative. */
export const MIN_BASELINE_M = 0.002;

export interface PlanarityOptions {
  ransacSeed?: number;
  ransacMaxIterations?: number;
}

function isFiniteVec(v: ArrayLike<number>, n: number): boolean {
  if (v.length < n) return false;
  for (let i = 0; i < n; i++) if (!Number.isFinite(v[i])) return false;
  return true;
}

/** Representative focal length in pixels for px↔normalized conversion. */
function representativeFocalPx(c: StereoCommitment['calibration']): number {
  const a = (c.intrinsicsWide.fx + c.intrinsicsWide.fy) / 2;
  const b = (c.intrinsicsUltraWide.fx + c.intrinsicsUltraWide.fy) / 2;
  return (a + b) / 2;
}

/**
 * Effective range of THIS commitment, in meters.
 *
 * Derivation: disparity in normalized pinhole units is ≈ B/Z; its gradient
 * w.r.t. depth is B/Z². In pixel units the gradient is f·B/Z². The signal
 * can tell "flat" from "3D" only while a depth spread of
 * MIN_DEPTH_DISCRIMINATION_M moves points by more than the matcher noise
 * floor ρ = MATCHER_NOISE_SIGMA_PX·sqrt(2) (two independent views):
 *
 *   f·B/Z² · ΔZ_min ≥ ρ   ⟺   Z ≤ sqrt(f·B·ΔZ_min / ρ)
 *
 * For f ≈ 1100 px, B = 12 mm that is ≈ 2.6 m — "roughly three meters".
 */
export function effectiveRangeM(c: StereoCommitment['calibration']): number {
  const f = representativeFocalPx(c);
  const b = Math.hypot(...c.extrinsics.translationM);
  const rho = MATCHER_NOISE_SIGMA_PX * Math.SQRT2;
  return Math.sqrt((f * b * MIN_DEPTH_DISCRIMINATION_M) / rho);
}

/**
 * Median scene depth in meters by midpoint triangulation of the
 * UNDISTORTED correspondences through the committed extrinsics.
 *
 * Why triangulate instead of trusting the committed focus distance: the
 * focus distance is a device-reported number; the desk's job is to
 * recompute. When both cues exist the gate weighs the LARGER (the
 * conservative direction — the gate exists to stop overclaiming). Returns
 * null when the geometry cannot produce a depth.
 */
function triangulatedMedianDepthM(
  c: StereoCommitment['calibration'],
  pts1: Array<[number, number]>,
  pts2: Array<[number, number]>,
): number | null {
  const R = c.extrinsics.rotation;
  const t = c.extrinsics.translationM;
  const depths: number[] = [];
  for (let k = 0; k < pts1.length; k++) {
    // Unnormalized rays so the scale parameter IS the depth (P = Z·[x,y,1]).
    const u1 = [pts1[k][0], pts1[k][1], 1];
    const u2 = [pts2[k][0], pts2[k][1], 1];
    // a = R·u1: the primary ray expressed in the secondary frame, where the
    // secondary camera sits at t. Solve s2·u2 − s1·a = t by least squares.
    const a = [
      R[0] * u1[0] + R[1] * u1[1] + R[2],
      R[3] * u1[0] + R[4] * u1[1] + R[5],
      R[6] * u1[0] + R[7] * u1[1] + R[8],
    ];
    const aa = a[0] * a[0] + a[1] * a[1] + a[2] * a[2];
    const au = a[0] * u2[0] + a[1] * u2[1] + a[2] * u2[2];
    const uu = u2[0] * u2[0] + u2[1] * u2[1] + u2[2] * u2[2];
    const at = a[0] * t[0] + a[1] * t[1] + a[2] * t[2];
    const ut = u2[0] * t[0] + u2[1] * t[1] + u2[2] * t[2];
    const det = aa * uu - au * au;
    if (Math.abs(det) < 1e-12) continue;
    // [ aa  -au ] [s1]   [-at]
    // [ -au  uu ] [s2] = [ ut ]
    const s1 = (-at * uu + au * ut) / det;
    if (Number.isFinite(s1) && s1 > 0.01 && s1 < 1e4) depths.push(s1);
  }
  if (depths.length === 0) return null;
  depths.sort((x, y) => x - y);
  return depths[Math.floor(depths.length / 2)];
}

const RANGE_SENTENCE = (rangeM: number): string =>
  rangeM > 0
    ? `Effective within roughly three meters (this commitment: ${rangeM.toFixed(1)} m, from its ` +
      `${'committed baseline and intrinsics'}).`
    : 'Effective within roughly three meters when calibration is present (this commitment: range unknown — calibration unusable).';

const FRAMING = 'This is a signal a person weighs, not a verdict.';

export function assessPlanarity(
  commitment: StereoCommitment,
  correspondences: Correspondence[],
  opts: PlanarityOptions = {},
): PlanaritySignal {
  const cal = commitment.calibration;

  // --- Unsupported: the commitment itself cannot carry the computation. ---
  const unsupported = (reason: string, range: number): PlanaritySignal => ({
    state: 'unsupported',
    effectiveRangeM: range,
    text:
      `Cannot be evaluated from this commitment: ${reason}. Nothing was measured — ` +
      `an absent signal is not suspicion and not clearance. ${RANGE_SENTENCE(range)} ${FRAMING}`,
  });

  const rangeUnknown = 0;
  if (!cal || !cal.intrinsicsWide || !cal.intrinsicsUltraWide || !cal.extrinsics) {
    return unsupported('missing calibration block', rangeUnknown);
  }
  const iw = cal.intrinsicsWide;
  const iu = cal.intrinsicsUltraWide;
  if (!(iw.fx > 0) || !(iw.fy > 0) || !(iu.fx > 0) || !(iu.fy > 0) ||
      ![iw.cx, iw.cy, iu.cx, iu.cy].every(Number.isFinite)) {
    return unsupported('intrinsics are missing or non-finite', rangeUnknown);
  }
  if (!isFiniteVec(cal.extrinsics.rotation, 9)) {
    return unsupported('extrinsic rotation missing or malformed (need 9 finite numbers)', rangeUnknown);
  }
  if (!isFiniteVec(cal.extrinsics.translationM, 3)) {
    return unsupported('extrinsic translation missing or malformed', rangeUnknown);
  }
  const baselineM = Math.hypot(...cal.extrinsics.translationM);
  if (baselineM < MIN_BASELINE_M) {
    return unsupported(
      `baseline ${(baselineM * 1000).toFixed(2)} mm is below the ${MIN_BASELINE_M * 1000} mm floor — stereo geometry is decorative at this spacing`,
      rangeUnknown,
    );
  }
  if (cal.distortionLut) {
    const lut = cal.distortionLut;
    const sane =
      lut.width >= 2 && lut.height >= 2 &&
      lut.values.length >= lut.width * lut.height * 2 &&
      Number.isFinite(lut.domainRadius) && lut.domainRadius > 0;
    if (!sane) return unsupported('committed distortion LUT is malformed', rangeUnknown);
    // A LUT whose domain does not cover the frame would silently clamp at
    // the edges — refuse rather than extrapolate a lens model.
    if (lut.domainRadius < frameDomainRadius(iu) * 0.9) {
      return unsupported('committed distortion LUT domain does not cover the frame', rangeUnknown);
    }
  }

  const rangeM = effectiveRangeM(cal);
  const fPx = representativeFocalPx(cal);

  // --- Undistort both views into normalized pinhole coordinates. ---
  // Primary = wide, secondary = ultra-wide (the P3 pairing). The
  // correspondence extractor plugs in upstream; here we only normalize.
  const pts1: Array<[number, number]> = [];
  const pts2: Array<[number, number]> = [];
  for (const corr of correspondences) {
    pts1.push(undistortPixel(corr.primary[0], corr.primary[1], iw, cal.distortionLut));
    pts2.push(undistortPixel(corr.secondary[0], corr.secondary[1], iu, cal.distortionLut));
  }

  // --- The distance gate, evaluated BEFORE any planarity claim. ---
  const triangulatedM = pts1.length >= 2 ? triangulatedMedianDepthM(cal, pts1, pts2) : null;
  const focusM = commitment.metadataBlock?.focusDistanceM;
  const hasFocus = typeof focusM === 'number' && Number.isFinite(focusM) && focusM > 0;
  // Conservative cue: the LARGER of what the device committed and what the
  // geometry recomputes. The gate exists to stop overclaiming, so it errs
  // toward 'insufficient-geometry'.
  const depthCueM = Math.max(hasFocus ? focusM : 0, triangulatedM ?? 0);
  const depthSource =
    hasFocus && triangulatedM !== null
      ? `committed focus distance ${focusM!.toFixed(2)} m, recomputed disparity depth ${triangulatedM.toFixed(2)} m`
      : hasFocus
        ? `committed focus distance ${focusM!.toFixed(2)} m (no disparity depth available)`
        : triangulatedM !== null
          ? `recomputed disparity depth ${triangulatedM.toFixed(2)} m (no focus distance committed)`
          : 'no depth cue at all';

  if (depthCueM > rangeM) {
    return {
      state: 'insufficient-geometry',
      effectiveRangeM: rangeM,
      text:
        `Beyond effective range — insufficient geometry: scene depth cue ${depthCueM.toFixed(2)} m ` +
        `(${depthSource}) exceeds the ${rangeM.toFixed(1)} m reach of this ${(baselineM * 1000).toFixed(0)} mm baseline. ` +
        `Disparity falls as 1/Z and depth discrimination as 1/Z², so beyond range a flat surface and a real 3D scene ` +
        `are geometrically indistinguishable to this signal. This is a limit of the geometry, not suspicion, ` +
        `and it clears nothing. ${RANGE_SENTENCE(rangeM)} ${FRAMING}`,
    };
  }

  // --- Too few correspondences: no model can be supported. ---
  if (correspondences.length < MIN_CORRESPONDENCES) {
    return {
      state: 'insufficient-geometry',
      effectiveRangeM: rangeM,
      text:
        `Insufficient geometry: only ${correspondences.length} correspondences (minimum ${MIN_CORRESPONDENCES}) — ` +
        `no homography can be supported, so nothing was measured. This is a data limit, not suspicion, ` +
        `and it clears nothing. ${RANGE_SENTENCE(rangeM)} ${FRAMING}`,
    };
  }

  // --- Fit: one homography for both views, in pixel-calibrated units. ---
  const thrNorm = RANSAC_INLIER_THRESHOLD_PX / fPx;
  const fit = fitHomographyRansac(pts1, pts2, {
    threshold: thrNorm,
    maxIterations: opts.ransacMaxIterations ?? 500,
    confidence: 0.99,
    seed: opts.ransacSeed ?? 0x5eed,
  });

  if (!fit) {
    return {
      state: 'insufficient-geometry',
      effectiveRangeM: rangeM,
      text:
        `Insufficient geometry: RANSAC found no stable homography in ${correspondences.length} correspondences — ` +
        `the data supports no single model, so nothing was measured. Likely a matching failure; not suspicion, ` +
        `and it clears nothing. ${RANGE_SENTENCE(rangeM)} ${FRAMING}`,
    };
  }

  const inlierCount = fit.inliers.filter(Boolean).length;
  const inlierRatio = inlierCount / correspondences.length;
  const residualPx = fit.residualMedian * fPx;
  const residualP90Px = fit.residualP90 * fPx;

  if (inlierCount < MIN_INLIERS) {
    return {
      state: 'insufficient-geometry',
      inlierRatio,
      effectiveRangeM: rangeM,
      text:
        `Insufficient geometry: only ${inlierCount} of ${correspondences.length} correspondences agree on any ` +
        `single homography (minimum ${MIN_INLIERS}) — no stable model, nothing measured. Often a matching failure; ` +
        `not suspicion, and it clears nothing. ${RANGE_SENTENCE(rangeM)} ${FRAMING}`,
    };
  }

  const depthPhrase =
    depthCueM > 0 ? `scene depth cue ${depthCueM.toFixed(2)} m (${depthSource})` : 'no scene depth cue';

  if (residualPx <= PLANAR_MAX_RESIDUAL_PX && inlierRatio >= MIN_INLIER_RATIO_PLANAR) {
    return {
      state: 'planar',
      residualPx,
      inlierRatio,
      effectiveRangeM: rangeM,
      text:
        `Consistent with a single flat surface at ${depthPhrase}: median inlier residual ${residualPx.toFixed(2)} px ` +
        `(p90 ${residualP90Px.toFixed(2)} px, ceiling ${PLANAR_MAX_RESIDUAL_PX} px), ` +
        `${(inlierRatio * 100).toFixed(0)}% of ${correspondences.length} correspondences explained by one homography. ` +
        `A genuine photograph of any flat thing — a wall, a document, a table — produces this same signal, ` +
        `and curved screens or prints can evade it, so this is NOT a verdict of recapture and NOT clearance: ` +
        `absence of a flag is not evidence of authenticity. ${RANGE_SENTENCE(rangeM)} ${FRAMING}`,
    };
  }

  const driver =
    residualPx > PLANAR_MAX_RESIDUAL_PX
      ? `median inlier residual ${residualPx.toFixed(2)} px exceeds the ${PLANAR_MAX_RESIDUAL_PX} px ceiling ` +
        `(p90 ${residualP90Px.toFixed(2)} px) — a flat surface inside range would sit near the matcher noise floor`
      : `only ${(inlierRatio * 100).toFixed(0)}% of ${correspondences.length} correspondences agree on the best ` +
        `homography (a flat scene with matcher noise explains nearly all of them; the rejected points are ` +
        `themselves the depth signal)`;
  return {
    state: 'non-planar',
    residualPx,
    inlierRatio,
    effectiveRangeM: rangeM,
    text:
      `Not consistent with a single flat surface at ${depthPhrase}: ${driver}. ` +
      `This indicates real 3D structure, or a feature-matching failure. It is NOT a verdict of authenticity ` +
      `and NOT proof of tampering. ${RANGE_SENTENCE(rangeM)} ${FRAMING}`,
  };
}

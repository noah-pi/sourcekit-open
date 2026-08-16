/**
 * Multi-baseline stereo planarity signal — three-lens rigs (ultra-wide,
 * wide, telephoto).
 *
 * This module extends the two-view planarity pipeline (planarity.ts) from
 * ONE baseline to N over-determined baselines. Per lens pair it runs the
 * same committed-input pipeline — undistort through the per-lens committed
 * calibration → injected correspondences → RANSAC homography → residual +
 * distance gate — reusing the sibling homography fit, constants, and the
 * effective-range formula unchanged.
 *
 * THE OVER-DETERMINED CHECK a two-baseline rig cannot perform: with three
 * lenses the three pairwise homographies are not independent. For any
 * single scene geometry, the homography relating the ultra-wide and tele
 * views MUST equal the composition of the two chained ones:
 *
 *   H_uw→t  =  H_w→t ∘ H_uw→w        (as projective maps, up to scale)
 *
 * A single planar surface (a screen, a print) fools ONE pair — that is the
 * known two-baseline weakness. But an attacker who shows DIFFERENT pairs
 * DIFFERENT geometry (mixed recapture: one pair sees the screen, another
 * sees past it, or a composite where each pair was fed a different plane)
 * produces three pairwise fits that each look fine alone yet DISAGREE with
 * their composition. We measure that disagreement as the composition-
 * consistency residual: the symmetric transfer error between the directly
 * fit H_uw→t and the composed H_w→t ∘ H_uw→w, evaluated on the shared
 * correspondences of the uw↔t pair, in pixel-equivalent units.
 *
 * Distance gates stay PER PAIR: the baselines of a three-lens rig differ
 * (UW↔W ~12 mm, W↔T ~14 mm, UW↔T ~26 mm on current phones), so each pair's
 * effective range is computed from ITS committed extrinsics and intrinsics
 * — never hardcoded. A pair beyond its range contributes
 * 'insufficient-geometry' and the overall state degrades gracefully:
 *
 *   ≥2 pairs with sufficient geometry → full decision (agreement check
 *     runs when three mutually-fit planar pairs exist);
 *   1 pair → the decision rests on that pair alone and the text says so
 *     (a two-baseline rig never has more than this);
 *   0 pairs → 'insufficient-geometry'.
 *
 * Standing framing rules carry over from planarity.ts: the output is a
 * signal a person weighs, never a verdict. 'consistent' is NOT a verdict
 * of recapture and NOT clearance — a genuine photograph of a flat thing
 * produces the same signal. 'inconsistent' indicates 3D structure, mixed
 * scene geometry across pairs, or a matching failure — not proof of
 * tampering. Absence of a flag is not evidence of authenticity, and every
 * text below says so, with the per-pair effective ranges attached.
 */

import type {
  CameraExtrinsics,
  CameraIntrinsics,
  Correspondence,
  DistortionLut,
  StereoMetadataBlock,
} from './types';
import {
  effectiveRangeM,
  MATCHER_NOISE_SIGMA_PX,
  MIN_BASELINE_M,
  MIN_CORRESPONDENCES,
  MIN_INLIERS,
  MIN_INLIER_RATIO_PLANAR,
  PLANAR_MAX_RESIDUAL_PX,
  RANSAC_INLIER_THRESHOLD_PX,
  type PlanarityOptions,
} from './planarity';
import {
  fitHomographyRansac,
  mat3Invert,
  mat3Mul,
  type Mat3,
} from './homography';
import { frameDomainRadius, undistortPixel } from './undistort';

export const MULTIBASELINE_METHOD_VERSION = '0.1.0-p5-scaffold';

/**
 * Composition-consistency ceiling for 'consistent', in pixel-equivalent
 * units. Justification: on a true single-geometry scene each pairwise fit
 * interpolates its inliers to roughly the matcher noise floor. Composing
 * two fits accumulates two independent noise draws and the direct fit
 * contributes a third, so the composed-vs-direct discrepancy on an honest
 * planar scene sits near √3 × the per-pair noise-scaled residual — at the
 * assumed σ = 0.5 px floor and the rig's focal mismatches, ≈ 1.5–2 px
 * (measured on the synthetic fixtures in test-stereo-multibaseline.mts).
 * 4.0 px is ≈ 2.5× that expectation — honest planar triples pass with
 * margin — while the plane-mismatch discrepancies the check exists to
 * catch are tens of pixels (different depths over a 26 mm baseline move
 * the composition by B·Δ(1/Z) normalized units). Like the sibling
 * thresholds, this is a first-principles placeholder pending the P6
 * corpus-measured ROC operating point.
 */
export const AGREEMENT_MAX_RESIDUAL_PX = 4.0;

/** A lens name as committed by the rig ('ultra-wide', 'wide', 'tele', …). */
export type LensId = string;

/**
 * Canonical key for an unordered lens pair: `${lensA}|${lensB}` with the
 * two ids in the rig's sorted order. For committed extrinsics and injected
 * correspondences the key is DIRECTIONAL — 'A|B' means the transform/maps
 * run A → B (P_B = R·P_A + t; correspondence primary is in A). The verifier
 * inverts when only the reverse direction was committed.
 */
export type PairKey = string;

/**
 * Everything the desk needs to recompute multi-baseline geometry without
 * trusting any device-computed number. Same P3/P4 rule as StereoCommitment:
 * the device commits the INPUTS (frames, calibration, sync deltas,
 * metadata), never a verdict.
 */
export interface MultiCamCommitment {
  /** Identifier of the physical rig these calibrations describe. */
  rigId: string;
  /**
   * The committed frame for each lens — a content hash, a filesystem path
   * the desk reads, or the raw bytes. The verifier requires an entry per
   * calibrated lens: a missing frame means that lens's pairs cannot be
   * re-derived from pixels by the matcher when it lands, so they are
   * 'unsupported' today.
   */
  frames: Map<LensId, { hash: string } | { path: string } | { bytes: Uint8Array }>;
  calibrations: {
    /** Pinhole intrinsics per lens. */
    intrinsics: Map<LensId, CameraIntrinsics>;
    /**
     * Pairwise rigid transforms, keyed 'A|B' with the convention
     * P_B = R·P_A + t (rotation row-major 3×3, translation in meters).
     * |t| is that pair's baseline — it sets the pair's effective range,
     * so it is committed, never assumed. Either direction may be
     * committed; the verifier inverts as needed. All three of UW↔W,
     * W↔T, UW↔T are required for the over-determined check: UW↔T must
     * NOT be derived by chaining, it must be committed independently —
     * otherwise the agreement check would be circular.
     */
    extrinsics: Map<PairKey, CameraExtrinsics>;
    /** Optional per-lens forward distortion LUTs (AVCameraCalibrationData-style). */
    distortionLuts?: Map<LensId, DistortionLut>;
  };
  /** Hardware sync deltas per pair, milliseconds, keyed as extrinsics. */
  syncTimestampDeltasMs: Map<PairKey, number>;
  /** The committed camera metadata block per lens (P3 item 14). */
  metadata: Map<LensId, StereoMetadataBlock>;
}

/** The per-pair signal, in the same honest four states as the two-view pipeline. */
export interface PairAssessment {
  /** Canonical pair key 'A|B' (sorted lens order). */
  pairKey: PairKey;
  lensA: LensId;
  lensB: LensId;
  state: 'planar' | 'non-planar' | 'insufficient-geometry' | 'unsupported';
  /** This pair's committed baseline in meters, when available. */
  baselineM?: number;
  /**
   * The geometric reach of THIS pair's baseline+intrinsics, in meters —
   * computed per pair from the committed extrinsics (disparity gradient
   * d/dZ = f·B/Z² vs the matcher noise floor). Always reported.
   */
  effectiveRangeM: number;
  /** Median symmetric transfer error of inliers, pixel-equivalent, when computed. */
  residualPx?: number;
  /** Fraction of correspondences consistent with the best homography. */
  inlierRatio?: number;
  /** Short per-pair signal text; the overall text carries the framing. */
  text: string;
  // --- Fit internals, exposed for the over-determined agreement check. ---
  /** Homography mapping lensA normalized pinhole coords → lensB, when a trusted fit exists. */
  H?: Mat3;
  /** Undistorted normalized points per lens, aligned with the input correspondences. */
  ptsA?: Array<[number, number]>;
  ptsB?: Array<[number, number]>;
  /** Inlier flags of the pair fit, aligned with ptsA/ptsB. */
  inliers?: boolean[];
  /** Representative focal lengths (px) used to pixelize each view's residuals. */
  focalAPx?: number;
  focalBPx?: number;
}

/**
 * The multi-baseline signal output. Four honest states:
 *
 *  - 'consistent': every pair with sufficient geometry is consistent with
 *    a single flat surface, AND — when three mutually-fit planar pairs
 *    exist — the pairwise homographies agree with their composition. NOT
 *    a verdict of recapture and NOT clearance.
 *  - 'inconsistent': at least one in-range pair is not explained by one
 *    homography, OR the pairwise fits disagree with their composition
 *    (the mixed-geometry finding a two-baseline rig cannot produce).
 *    Indicates 3D structure, mixed scene geometry, or matching failure —
 *    NOT a verdict of authenticity and NOT proof of tampering.
 *  - 'insufficient-geometry': no pair carried measurable geometry (all
 *    beyond range or too few correspondences). A limit of the geometry,
 *    not suspicion; it clears nothing.
 *  - 'unsupported': the commitment itself cannot be evaluated.
 */
export interface MultiBaselineSignal {
  state: 'consistent' | 'inconsistent' | 'insufficient-geometry' | 'unsupported';
  /** Per-pair assessments, keyed by canonical pair key. */
  perPair: Map<PairKey, PairAssessment>;
  /**
   * The worst composition-consistency residual over all fully-fit planar
   * lens triples, in pixel-equivalent units — the over-determined
   * measurement. Undefined when no complete triple could be evaluated.
   */
  agreementResidualPx?: number;
  /** The ceiling the agreement residual was weighed against. */
  agreementCeilingPx: number;
  /** How many pairs had sufficient geometry to carry a planarity reading. */
  sufficientPairs: number;
  /** How many pairs could be evaluated at all (calibration present). */
  evaluatedPairs: number;
  /** Human-readable signal text with the bounds attached. Never a verdict. */
  text: string;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function pairKeyOf(a: LensId, b: LensId): PairKey {
  return `${a}|${b}`;
}

/** Deterministic per-pair RANSAC seed: same commitment → same answer, every run. */
function seedFor(pairKey: PairKey, base: number): number {
  let h = base >>> 0;
  for (let i = 0; i < pairKey.length; i++) {
    h ^= pairKey.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function isFiniteVec(v: ArrayLike<number> | undefined, n: number): boolean {
  if (!v || v.length < n) return false;
  for (let i = 0; i < n; i++) if (!Number.isFinite(v[i])) return false;
  return true;
}

/** Apply a 3×3 projective map (scale-invariant, as all homographies are). */
function applyMat3(m: Mat3, x: number, y: number): [number, number] {
  const w = m[6] * x + m[7] * y + m[8];
  return [(m[0] * x + m[1] * y + m[2]) / w, (m[3] * x + m[4] * y + m[5]) / w];
}

/** Rigid inverse: P_A = Rᵀ·P_B − Rᵀ·t. */
function invertExtrinsics(e: CameraExtrinsics): CameraExtrinsics {
  const R = e.rotation;
  const t = e.translationM;
  const Rt = [R[0], R[3], R[6], R[1], R[4], R[7], R[2], R[5], R[8]];
  return {
    rotation: Rt,
    translationM: [
      -(Rt[0] * t[0] + Rt[1] * t[1] + Rt[2] * t[2]),
      -(Rt[3] * t[0] + Rt[4] * t[1] + Rt[5] * t[2]),
      -(Rt[6] * t[0] + Rt[7] * t[1] + Rt[8] * t[2]),
    ],
  };
}

/**
 * The committed extrinsics for the ordered pair (A → B), inverting the
 * reverse direction when that is what the rig committed. Null when absent.
 */
function extrinsicsFor(
  extrinsics: Map<PairKey, CameraExtrinsics>,
  a: LensId,
  b: LensId,
): CameraExtrinsics | null {
  const fwd = extrinsics.get(pairKeyOf(a, b));
  if (fwd) return fwd;
  const rev = extrinsics.get(pairKeyOf(b, a));
  return rev ? invertExtrinsics(rev) : null;
}

/** Injected correspondences for the ordered pair (A → B), swapping when needed. */
function correspondencesFor(
  all: Map<PairKey, Correspondence[]>,
  a: LensId,
  b: LensId,
): Correspondence[] {
  const fwd = all.get(pairKeyOf(a, b));
  if (fwd) return fwd;
  const rev = all.get(pairKeyOf(b, a));
  if (!rev) return [];
  return rev.map((c) => ({ primary: c.secondary, secondary: c.primary }));
}

function focalMeanPx(i: CameraIntrinsics): number {
  return (i.fx + i.fy) / 2;
}

/**
 * Median scene depth by midpoint triangulation of the undistorted
 * correspondences through the committed extrinsics — the same method
 * planarity.ts uses privately, duplicated here because the two-view module
 * (correctly) does not export its internals. The desk recomputes depth; it
 * never trusts the device-committed focus distance alone.
 */
function triangulatedMedianDepthM(
  ext: CameraExtrinsics,
  pts1: Array<[number, number]>,
  pts2: Array<[number, number]>,
): number | null {
  const R = ext.rotation;
  const t = ext.translationM;
  const depths: number[] = [];
  for (let k = 0; k < pts1.length; k++) {
    const u1 = [pts1[k][0], pts1[k][1], 1];
    const u2 = [pts2[k][0], pts2[k][1], 1];
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
    const s1 = (-at * uu + au * ut) / det;
    if (Number.isFinite(s1) && s1 > 0.01 && s1 < 1e4) depths.push(s1);
  }
  if (depths.length === 0) return null;
  depths.sort((x, y) => x - y);
  return depths[Math.floor(depths.length / 2)];
}

// ---------------------------------------------------------------------------
// Per-pair pipeline: the existing two-view planarity math, per lens pair.
// ---------------------------------------------------------------------------

function assessPair(
  commitment: MultiCamCommitment,
  lensA: LensId,
  lensB: LensId,
  correspondences: Correspondence[],
  opts: PlanarityOptions,
): PairAssessment {
  const pairKey = pairKeyOf(lensA, lensB);
  const label = `${lensA}↔${lensB}`;
  const base: PairAssessment = {
    pairKey, lensA, lensB, state: 'unsupported', effectiveRangeM: 0, text: '',
  };
  const unsupported = (reason: string): PairAssessment => ({
    ...base,
    text: `${label}: cannot be evaluated — ${reason}. Nothing was measured for this pair.`,
  });

  const ia = commitment.calibrations.intrinsics.get(lensA);
  const ib = commitment.calibrations.intrinsics.get(lensB);
  if (!ia || !ib) return unsupported('missing intrinsics for one or both lenses');
  if (!(ia.fx > 0) || !(ia.fy > 0) || !(ib.fx > 0) || !(ib.fy > 0) ||
      ![ia.cx, ia.cy, ib.cx, ib.cy].every(Number.isFinite)) {
    return unsupported('intrinsics are missing or non-finite');
  }
  if (!commitment.frames.has(lensA) || !commitment.frames.has(lensB)) {
    return unsupported('a committed frame is missing for one of the lenses — the pair cannot be re-derived from pixels');
  }

  const ext = extrinsicsFor(commitment.calibrations.extrinsics, lensA, lensB);
  if (!ext) return unsupported('no committed extrinsics for this pair (either direction)');
  if (!isFiniteVec(ext.rotation, 9)) {
    return unsupported('extrinsic rotation missing or malformed (need 9 finite numbers)');
  }
  if (!isFiniteVec(ext.translationM, 3)) {
    return unsupported('extrinsic translation missing or malformed');
  }
  const baselineM = Math.hypot(...ext.translationM);
  if (baselineM < MIN_BASELINE_M) {
    return unsupported(
      `baseline ${(baselineM * 1000).toFixed(2)} mm is below the ${MIN_BASELINE_M * 1000} mm floor — stereo geometry is decorative at this spacing`,
    );
  }

  const luts = commitment.calibrations.distortionLuts;
  for (const [lens, intr] of [[lensA, ia], [lensB, ib]] as Array<[LensId, CameraIntrinsics]>) {
    const lut = luts?.get(lens);
    if (!lut) continue;
    const sane =
      lut.width >= 2 && lut.height >= 2 &&
      lut.values.length >= lut.width * lut.height * 2 &&
      Number.isFinite(lut.domainRadius) && lut.domainRadius > 0;
    if (!sane) return unsupported(`committed distortion LUT for ${lens} is malformed`);
    if (lut.domainRadius < frameDomainRadius(intr) * 0.9) {
      return unsupported(`committed distortion LUT for ${lens} does not cover the frame`);
    }
  }

  // Per-pair effective range, from THIS pair's committed baseline and
  // intrinsics via the two-view module's formula — never hardcoded.
  const rangeM = effectiveRangeM({ intrinsicsWide: ia, intrinsicsUltraWide: ib, extrinsics: ext });
  const fRep = (focalMeanPx(ia) + focalMeanPx(ib)) / 2;
  const rangePhrase = `baseline ${(baselineM * 1000).toFixed(1)} mm, effective range ${rangeM.toFixed(1)} m`;

  // Undistort both views through their OWN committed calibration.
  const ptsA: Array<[number, number]> = [];
  const ptsB: Array<[number, number]> = [];
  for (const corr of correspondences) {
    ptsA.push(undistortPixel(corr.primary[0], corr.primary[1], ia, luts?.get(lensA)));
    ptsB.push(undistortPixel(corr.secondary[0], corr.secondary[1], ib, luts?.get(lensB)));
  }

  // Distance gate BEFORE any planarity claim: the conservative cue is the
  // LARGER of the two lenses' committed focus distances and the desk's own
  // triangulated depth.
  const triangulatedM = ptsA.length >= 2 ? triangulatedMedianDepthM(ext, ptsA, ptsB) : null;
  const focusA = commitment.metadata.get(lensA)?.focusDistanceM;
  const focusB = commitment.metadata.get(lensB)?.focusDistanceM;
  const validFocus = [focusA, focusB].filter(
    (f): f is number => typeof f === 'number' && Number.isFinite(f) && f > 0,
  );
  const focusMax = validFocus.length > 0 ? Math.max(...validFocus) : 0;
  const depthCueM = Math.max(focusMax, triangulatedM ?? 0);
  const depthSource =
    validFocus.length > 0 && triangulatedM !== null
      ? `committed focus distance ${focusMax.toFixed(2)} m, recomputed disparity depth ${triangulatedM.toFixed(2)} m`
      : validFocus.length > 0
        ? `committed focus distance ${focusMax.toFixed(2)} m (no disparity depth available)`
        : triangulatedM !== null
          ? `recomputed disparity depth ${triangulatedM.toFixed(2)} m (no focus distance committed)`
          : 'no depth cue at all';

  if (depthCueM > rangeM) {
    return {
      ...base,
      state: 'insufficient-geometry',
      baselineM,
      effectiveRangeM: rangeM,
      text:
        `${label}: beyond effective range — depth cue ${depthCueM.toFixed(2)} m (${depthSource}) exceeds the ` +
        `${rangeM.toFixed(1)} m reach of this ${(baselineM * 1000).toFixed(0)} mm baseline (${rangePhrase}). ` +
        `Disparity falls as 1/Z and depth discrimination as 1/Z², so beyond range a flat surface and a real 3D ` +
        `scene are geometrically indistinguishable to this pair. A limit of the geometry, not suspicion.`,
    };
  }

  if (correspondences.length < MIN_CORRESPONDENCES) {
    return {
      ...base,
      state: 'insufficient-geometry',
      baselineM,
      effectiveRangeM: rangeM,
      text:
        `${label}: only ${correspondences.length} correspondences (minimum ${MIN_CORRESPONDENCES}) — ` +
        `no homography can be supported for this pair (${rangePhrase}). A data limit, not suspicion.`,
    };
  }

  const fit = fitHomographyRansac(ptsA, ptsB, {
    threshold: RANSAC_INLIER_THRESHOLD_PX / fRep,
    maxIterations: opts.ransacMaxIterations ?? 500,
    confidence: 0.99,
    seed: seedFor(pairKey, opts.ransacSeed ?? 0x5eed),
  });

  if (!fit) {
    return {
      ...base,
      state: 'insufficient-geometry',
      baselineM,
      effectiveRangeM: rangeM,
      text:
        `${label}: RANSAC found no stable homography in ${correspondences.length} correspondences — ` +
        `the data supports no single model (${rangePhrase}). Likely a matching failure; not suspicion.`,
    };
  }

  const inlierCount = fit.inliers.filter(Boolean).length;
  const inlierRatio = inlierCount / correspondences.length;
  const residualPx = fit.residualMedian * fRep;

  const withFit: PairAssessment = {
    ...base,
    baselineM,
    effectiveRangeM: rangeM,
    inlierRatio,
    H: fit.H,
    ptsA,
    ptsB,
    inliers: fit.inliers,
    focalAPx: focalMeanPx(ia),
    focalBPx: focalMeanPx(ib),
  };

  if (inlierCount < MIN_INLIERS) {
    return {
      ...withFit,
      state: 'insufficient-geometry',
      H: undefined,
      text:
        `${label}: only ${inlierCount} of ${correspondences.length} correspondences agree on any single ` +
        `homography (minimum ${MIN_INLIERS}; ${rangePhrase}). Often a matching failure; not suspicion.`,
    };
  }

  const depthPhrase =
    depthCueM > 0 ? `depth cue ${depthCueM.toFixed(2)} m (${depthSource})` : 'no depth cue';

  if (residualPx <= PLANAR_MAX_RESIDUAL_PX && inlierRatio >= MIN_INLIER_RATIO_PLANAR) {
    return {
      ...withFit,
      state: 'planar',
      residualPx,
      text:
        `${label}: consistent with a single flat surface — median residual ${residualPx.toFixed(2)} px ` +
        `(ceiling ${PLANAR_MAX_RESIDUAL_PX} px), ${(inlierRatio * 100).toFixed(0)}% of ${correspondences.length} ` +
        `correspondences on one homography; ${rangePhrase}; ${depthPhrase}.`,
    };
  }

  const driver =
    residualPx > PLANAR_MAX_RESIDUAL_PX
      ? `median residual ${residualPx.toFixed(2)} px exceeds the ${PLANAR_MAX_RESIDUAL_PX} px ceiling`
      : `only ${(inlierRatio * 100).toFixed(0)}% of ${correspondences.length} correspondences agree on the best homography`;
  return {
    ...withFit,
    state: 'non-planar',
    residualPx,
    text:
      `${label}: not consistent with a single flat surface — ${driver}; ${rangePhrase}; ${depthPhrase}. ` +
      `Indicates real 3D structure, or a matching failure.`,
  };
}

// ---------------------------------------------------------------------------
// The over-determined agreement check.
// ---------------------------------------------------------------------------

/**
 * Composition-consistency residual for one lens triple, in pixel-equivalent
 * units: on the shared correspondences of the (A,C) pair, compare the
 * directly fit H_A→C against the composed H_B→C ∘ H_A→B, symmetrically in
 * both directions. Homographies are applied as projective maps, which is
 * scale-invariant, so no normalization of the composed matrix is needed
 * beyond what mat3Mul already produces.
 *
 * Returns null when any of the three fits is missing — the check is only
 * as strong as its weakest link, and an absent fit must never be replaced
 * by a guess.
 */
export function compositionResidualPx(
  pairAB: PairAssessment,
  pairBC: PairAssessment,
  pairAC: PairAssessment,
): number | null {
  if (!pairAB.H || !pairBC.H || !pairAC.H) return null;
  if (!pairAC.ptsA || !pairAC.ptsB || !pairAC.inliers) return null;
  if (!pairAC.focalAPx || !pairAC.focalBPx) return null;
  const hACinv = mat3Invert(pairAC.H);
  const hABinv = mat3Invert(pairAB.H);
  const hBCinv = mat3Invert(pairBC.H);
  if (!hACinv || !hABinv || !hBCinv) return null;
  const hComposed = mat3Mul(pairBC.H, pairAB.H); // A → C via B
  const hComposedInv = mat3Mul(hABinv, hBCinv); // C → A via B
  const fA = pairAC.focalAPx;
  const fC = pairAC.focalBPx!;
  const errs: number[] = [];
  for (let k = 0; k < pairAC.ptsA.length; k++) {
    if (!pairAC.inliers[k]) continue;
    const [px, py] = pairAC.ptsA[k];
    const [qx, qy] = pairAC.ptsB[k];
    // Forward: two predictions of the C-frame point from the A-frame point.
    const [d1x, d1y] = applyMat3(pairAC.H, px, py);
    const [c1x, c1y] = applyMat3(hComposed, px, py);
    const dFwd = Math.hypot(d1x - c1x, d1y - c1y) * fC;
    // Backward: two predictions of the A-frame point from the C-frame point.
    const [d2x, d2y] = applyMat3(hACinv, qx, qy);
    const [c2x, c2y] = applyMat3(hComposedInv, qx, qy);
    const dBwd = Math.hypot(d2x - c2x, d2y - c2y) * fA;
    errs.push(Math.sqrt(dFwd * dFwd + dBwd * dBwd));
  }
  if (errs.length < MIN_INLIERS) return null;
  errs.sort((x, y) => x - y);
  return errs[Math.floor(errs.length / 2)];
}

// ---------------------------------------------------------------------------
// The multi-baseline signal.
// ---------------------------------------------------------------------------

const FRAMING = 'This is a signal a person weighs, not a verdict.';

function rangeSummary(pairs: PairAssessment[]): string {
  if (pairs.length === 0) return 'Effective range per pair: unavailable (no pair could be evaluated).';
  return (
    'Effective range per pair: ' +
    pairs
      .map((p) =>
        p.effectiveRangeM > 0
          ? `${p.lensA}↔${p.lensB} ${p.effectiveRangeM.toFixed(1)} m (${((p.baselineM ?? 0) * 1000).toFixed(0)} mm baseline)`
          : `${p.lensA}↔${p.lensB} unknown`,
      )
      .join('; ') +
    '.'
  );
}

function pairDigest(pairs: PairAssessment[]): string {
  return 'Per-pair: ' + pairs.map((p) => p.text).join(' ');
}

/**
 * Recompute the multi-baseline planarity signal from a committed
 * three-lens (or N-lens, N ≥ 2) capture.
 *
 * Correspondences are INJECTED BY THE CALLER, keyed by pair ('A|B',
 * primary in A) — feature extraction is a later dependency, deliberately
 * kept out of this scaffold exactly as in the two-view pipeline. What is
 * verified today is the math: per-pair undistortion, homography fits,
 * per-pair distance gates, and the over-determined composition-consistency
 * check — deterministically, from the committed inputs.
 */
export function assessMultiBaseline(
  commitment: MultiCamCommitment,
  correspondences: Map<PairKey, Correspondence[]>,
  opts: PlanarityOptions = {},
): MultiBaselineSignal {
  const empty = new Map<PairKey, PairAssessment>();
  const unsupported = (reason: string): MultiBaselineSignal => ({
    state: 'unsupported',
    perPair: empty,
    agreementCeilingPx: AGREEMENT_MAX_RESIDUAL_PX,
    sufficientPairs: 0,
    evaluatedPairs: 0,
    text:
      `Cannot be evaluated from this commitment: ${reason}. Nothing was measured — an absent signal is ` +
      `not suspicion and not clearance. Effective range per pair: unavailable (calibration unusable). ${FRAMING}`,
  });

  if (!commitment || !commitment.calibrations || !(commitment.calibrations.intrinsics instanceof Map)) {
    return unsupported('missing calibration block');
  }
  if (!(commitment.frames instanceof Map)) {
    return unsupported('missing committed frames');
  }
  if (!(commitment.calibrations.extrinsics instanceof Map)) {
    return unsupported('missing pairwise extrinsics');
  }

  // Lenses with committed intrinsics AND a committed frame — a lens without
  // a frame cannot be re-derived from pixels, so its pairs are unsupported.
  const lenses = [...commitment.calibrations.intrinsics.keys()]
    .filter((l) => commitment.frames.has(l))
    .sort();
  if (lenses.length < 2) {
    return unsupported(
      `fewer than two lenses carry both intrinsics and a committed frame (rig '${commitment.rigId ?? '?'}')`,
    );
  }

  // --- Every unordered lens pair through the two-view pipeline. ---
  const perPair = new Map<PairKey, PairAssessment>();
  for (let i = 0; i < lenses.length; i++) {
    for (let j = i + 1; j < lenses.length; j++) {
      const a = lenses[i];
      const b = lenses[j];
      const corrs = correspondences instanceof Map ? correspondencesFor(correspondences, a, b) : [];
      perPair.set(pairKeyOf(a, b), assessPair(commitment, a, b, corrs, opts));
    }
  }

  const all = [...perPair.values()];
  const evaluated = all.filter((p) => p.state !== 'unsupported');
  const sufficient = all.filter((p) => p.state === 'planar' || p.state === 'non-planar');
  const ranges = rangeSummary(evaluated.length > 0 ? evaluated : all);
  const digest = pairDigest(all);

  const base = {
    perPair,
    agreementCeilingPx: AGREEMENT_MAX_RESIDUAL_PX,
    sufficientPairs: sufficient.length,
    evaluatedPairs: evaluated.length,
  };

  if (evaluated.length === 0) {
    return {
      ...base,
      state: 'unsupported',
      text:
        `Cannot be evaluated from this commitment: every lens pair is unsupported. ${digest} ` +
        `Nothing was measured — an absent signal is not suspicion and not clearance. ${ranges} ${FRAMING}`,
    };
  }

  if (sufficient.length === 0) {
    return {
      ...base,
      state: 'insufficient-geometry',
      text:
        `Insufficient geometry on every evaluated pair — none of the ${evaluated.length} lens pair(s) of this ` +
        `${lenses.length}-lens rig carried measurable geometry, so no planarity reading exists at any baseline. ` +
        `${digest} This is a limit of the geometry, not suspicion, and it clears nothing: a scene beyond every ` +
        `committed baseline's reach is simply unmeasured. ${ranges} ${FRAMING}`,
    };
  }

  // --- The over-determined agreement check over all fully-fit planar triples. ---
  let agreementResidual: number | undefined;
  let triplesChecked = 0;
  for (let i = 0; i < lenses.length; i++) {
    for (let j = i + 1; j < lenses.length; j++) {
      for (let k = j + 1; k < lenses.length; k++) {
        const pIJ = perPair.get(pairKeyOf(lenses[i], lenses[j]))!;
        const pJK = perPair.get(pairKeyOf(lenses[j], lenses[k]))!;
        const pIK = perPair.get(pairKeyOf(lenses[i], lenses[k]))!;
        // Only trusted single-surface fits count: the finding is decisive
        // exactly when each pair looks 'planar' on its own.
        if (pIJ.state !== 'planar' || pJK.state !== 'planar' || pIK.state !== 'planar') continue;
        const r = compositionResidualPx(pIJ, pJK, pIK);
        if (r === null) continue;
        triplesChecked++;
        agreementResidual = agreementResidual === undefined ? r : Math.max(agreementResidual, r);
      }
    }
  }

  const degradedPairs = all.filter((p) => p.state === 'insufficient-geometry' || p.state === 'unsupported');
  const degradedNote =
    degradedPairs.length > 0
      ? ` ${degradedPairs.length} of ${all.length} pairs did not contribute (${degradedPairs
          .map((p) => `${p.lensA}↔${p.lensB}: ${p.state}`)
          .join(', ')}).`
      : '';

  // --- 1 pair: a two-baseline rig never has more than this. Say so. ---
  if (sufficient.length === 1) {
    const p = sufficient[0];
    const state = p.state === 'planar' ? 'consistent' : 'inconsistent';
    const reading =
      p.state === 'planar'
        ? `consistent with a single flat surface (median residual ${(p.residualPx ?? NaN).toFixed(2)} px)`
        : `not consistent with a single flat surface — real 3D structure or a matching failure`;
    return {
      ...base,
      agreementResidualPx: agreementResidual,
      state,
      text:
        `Single-baseline decision: only one of ${all.length} pairs (${p.lensA}↔${p.lensB}) had sufficient ` +
        `geometry, and it is ${reading}. The over-determined agreement check — the whole point of a ` +
        `${lenses.length}-lens rig — needs at least two shared fits and could not run, so this reading is ` +
        `exactly what a two-baseline verifier would give, no stronger.${degradedNote} ` +
        `${p.state === 'planar'
          ? `A genuine photograph of any flat thing produces this same signal, so this is NOT a verdict of ` +
            `recapture and NOT clearance: absence of a flag is not evidence of authenticity. `
          : `This indicates 3D structure or a matching failure — NOT a verdict of authenticity and NOT proof ` +
            `of tampering. `}` +
        `${digest} ${ranges} ${FRAMING}`,
    };
  }

  // --- ≥2 pairs with sufficient geometry: full decision. ---
  const nonPlanar = sufficient.filter((p) => p.state === 'non-planar');
  if (nonPlanar.length > 0) {
    return {
      ...base,
      agreementResidualPx: agreementResidual,
      state: 'inconsistent',
      text:
        `Not consistent with a single flat surface: ${nonPlanar.length} of ${sufficient.length} in-range ` +
        `pairs (${nonPlanar.map((p) => `${p.lensA}↔${p.lensB}`).join(', ')}) reject a single homography — ` +
        `real 3D structure, or a matching failure.${degradedNote} This is NOT a verdict of authenticity and ` +
        `NOT proof of tampering. ${digest} ${ranges} ${FRAMING}`,
    };
  }

  // All sufficient pairs read planar. Did the over-determined check run?
  if (agreementResidual !== undefined && agreementResidual > AGREEMENT_MAX_RESIDUAL_PX) {
    return {
      ...base,
      agreementResidualPx: agreementResidual,
      state: 'inconsistent',
      text:
        `The pairwise homographies DISAGREE with their composition: composition-consistency residual ` +
        `${agreementResidual.toFixed(2)} px exceeds the ${AGREEMENT_MAX_RESIDUAL_PX} px ceiling across ` +
        `${triplesChecked} lens triple(s). Each pair on its own looks consistent with a flat surface — ` +
        `but no single scene geometry explains all of them: the direct fit and the chained composition ` +
        `(e.g. H_uw↔t vs H_w↔t ∘ H_uw↔w) describe different planes. This is the mixed-geometry finding a ` +
        `two-baseline verifier CANNOT see — different pairs shown different planes (mixed recapture), or a ` +
        `matching failure, produce exactly this signal. It is NOT proof of tampering and NOT a verdict of ` +
        `authenticity; it is a discrepancy a person weighs.${degradedNote} ${digest} ${ranges} ${FRAMING}`,
    };
  }

  const agreementNote =
    agreementResidual !== undefined
      ? `The over-determined check a two-baseline rig cannot perform agrees: the pairwise homographies are ` +
        `consistent with their composition (residual ${agreementResidual.toFixed(2)} px, ceiling ` +
        `${AGREEMENT_MAX_RESIDUAL_PX} px, ${triplesChecked} lens triple(s)) — one scene geometry explains ` +
        `every baseline.`
      : `The over-determined agreement check could not run (no complete triple of mutually-fit planar pairs), ` +
        `so the decision rests on the ${sufficient.length} pairwise readings alone.`;
  return {
    ...base,
    agreementResidualPx: agreementResidual,
    state: 'consistent',
    text:
      `All ${sufficient.length} in-range pairs are consistent with a single flat surface. ${agreementNote} ` +
      `A genuine photograph of any flat thing — a wall, a document, a table, and equally a screen or a print ` +
      `shown to every lens — produces this same signal, and curved screens or prints can evade it, so this is ` +
      `NOT a verdict of recapture and NOT clearance: absence of a flag is not evidence of authenticity.` +
      `${degradedNote} ${digest} ${ranges} ${FRAMING}`,
  };
}

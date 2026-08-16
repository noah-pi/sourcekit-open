/**
 * Desk-side stereo geometry verifier — public entry point.
 *
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ FEATURE EXTRACTION PLUGS IN HERE.                                   │
 * │                                                                     │
 * │ verifyStereoCommitment takes correspondences INJECTED BY THE CALLER: │
 * │ ORB/SIFT detection + matching between the two committed frames is a  │
 * │ later dependency (decoder + descriptor pipeline), deliberately kept  │
 * │ OUT of this scaffold. What is verified TODAY is the math: given the  │
 * │ committed calibration and a set of 2D–2D correspondences, the desk   │
 * │ recomputes undistortion, homography fit, residuals, and the distance │
 * │ gate — deterministically, from the committed inputs, trusting no     │
 * │ device-computed number.                                              │
 * │                                                                     │
 * │ When the matcher lands, it reads `commitment.secondaryFrame` (path   │
 * │ or bytes), extracts features on both frames, and calls the same      │
 * │ entry point. Nothing downstream changes.                             │
 * └─────────────────────────────────────────────────────────────────────┘
 *
 * Standing framing rules (P4/P6): the output is a signal a person weighs,
 * never a verdict. 'planar' is consistent with a flat surface — not a
 * recapture verdict, not clearance. 'non-planar' indicates 3D structure or
 * matching failure — not an authenticity verdict. 'insufficient-geometry'
 * is a limit of the ~10–12mm baseline physics, not suspicion. Absence of a
 * flag is not evidence of authenticity, and every output text says so.
 */

import type { Correspondence, PlanaritySignal, StereoCommitment } from './types';
import { assessPlanarity, type PlanarityOptions } from './planarity';

export * from './types';
export {
  assessPlanarity,
  effectiveRangeM,
  STEREO_METHOD_VERSION,
  PLANAR_MAX_RESIDUAL_PX,
  RANSAC_INLIER_THRESHOLD_PX,
  MATCHER_NOISE_SIGMA_PX,
  MIN_DEPTH_DISCRIMINATION_M,
  MIN_CORRESPONDENCES,
  MIN_INLIERS,
  MIN_INLIER_RATIO_PLANAR,
  MIN_BASELINE_M,
  type PlanarityOptions,
} from './planarity';
export {
  pixelToNormalized,
  normalizedToPixel,
  undistortPixel,
  distortNormalized,
  undistortNormalized,
  sampleLut,
  frameDomainRadius,
} from './undistort';
export {
  fitHomographyDlt,
  fitHomographyRansac,
  symmetricTransferError,
  mat3Mul,
  mat3Invert,
  type HomographyOptions,
  type HomographyResult,
  type Mat3,
} from './homography';

/**
 * Recompute the planarity signal from a committed stereo pair.
 *
 * The commitment carries the frames, calibration, sync delta, and metadata
 * (P3: commit the inputs, not the answer). Correspondences are injected by
 * the caller — see the header. Everything the desk concludes is recomputed
 * here from those committed inputs.
 */
export function verifyStereoCommitment(
  commitment: StereoCommitment,
  correspondences: Correspondence[],
  opts: PlanarityOptions = {},
): PlanaritySignal {
  return assessPlanarity(commitment, correspondences, opts);
}

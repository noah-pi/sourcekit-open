// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Lens-distortion removal for committed frames.
 *
 * WHY this exists: a homography relates two PINHOLE views of a plane. Real
 * phone lenses (ultra-wide especially) bend straight lines, so pixel
 * coordinates must be normalized through the committed intrinsics AND the
 * committed distortion LUT before any projective math is meaningful. Skipping
 * this step would manufacture false 'non-planar' residuals at the frame
 * edges — a flag born of our own sloppiness, not of the scene.
 *
 * The committed LUT is a FORWARD table (undistorted → distorted), matching
 * AVCameraCalibrationData.lensDistortionLookupTable. Undistorting is the
 * inverse problem, solved by fixed-point iteration: for a distorted point d,
 * iterate u ← d − disp(u) from u₀ = d. Lens distortion is a small,
 * Lipschitz-≪1 perturbation, so a handful of iterations converges to well
 * below the matcher noise floor. Bilinear sampling between LUT nodes.
 */

import type { CameraIntrinsics, DistortionLut } from './types';

/** Distorted pixel → normalized pinhole coordinate, no distortion model. */
export function pixelToNormalized(u: number, v: number, intr: CameraIntrinsics): [number, number] {
  return [(u - intr.cx) / intr.fx, (v - intr.cy) / intr.fy];
}

/** Normalized pinhole coordinate → distorted pixel. */
export function normalizedToPixel(x: number, y: number, intr: CameraIntrinsics): [number, number] {
  return [intr.fx * x + intr.cx, intr.fy * y + intr.cy];
}

/**
 * Bilinear sample of the forward LUT at normalized pinhole (x, y).
 * Coordinates outside the committed grid clamp to the edge node — we would
 * rather use the nearest committed displacement than extrapolate a lens
 * model the device never gave us.
 */
export function sampleLut(lut: DistortionLut, x: number, y: number): [number, number] {
  const gx = (x / lut.domainRadius * 0.5 + 0.5) * (lut.width - 1);
  const gy = (y / lut.domainRadius * 0.5 + 0.5) * (lut.height - 1);
  const x0 = Math.max(0, Math.min(lut.width - 1, Math.floor(gx)));
  const y0 = Math.max(0, Math.min(lut.height - 1, Math.floor(gy)));
  const x1 = Math.min(lut.width - 1, x0 + 1);
  const y1 = Math.min(lut.height - 1, y0 + 1);
  const tx = Math.max(0, Math.min(1, gx - x0));
  const ty = Math.max(0, Math.min(1, gy - y0));
  const at = (ix: number, iy: number, c: number): number =>
    lut.values[(iy * lut.width + ix) * 2 + c];
  const bilerp = (c: number): number =>
    (at(x0, y0, c) * (1 - tx) + at(x1, y0, c) * tx) * (1 - ty) +
    (at(x0, y1, c) * (1 - tx) + at(x1, y1, c) * tx) * ty;
  return [bilerp(0), bilerp(1)];
}

/** Forward map: normalized pinhole → distorted normalized coordinate. */
export function distortNormalized(x: number, y: number, lut: DistortionLut): [number, number] {
  const [dx, dy] = sampleLut(lut, x, y);
  return [x + dx, y + dy];
}

/** Fixed-point iterations for the inverse LUT lookup. */
export const UNDISTORT_ITERATIONS = 8;

/**
 * Inverse lookup: distorted normalized coordinate → undistorted normalized
 * pinhole coordinate. See the header for why fixed-point iteration is
 * legitimate here (small, contractive displacement field).
 */
export function undistortNormalized(
  xd: number,
  yd: number,
  lut: DistortionLut,
  iterations: number = UNDISTORT_ITERATIONS,
): [number, number] {
  let ux = xd;
  let uy = yd;
  for (let i = 0; i < iterations; i++) {
    const [dx, dy] = sampleLut(lut, ux, uy);
    ux = xd - dx;
    uy = yd - dy;
  }
  return [ux, uy];
}

/**
 * Full undistortion of one distorted pixel coordinate to a normalized
 * pinhole coordinate. With no committed LUT the lens is treated as
 * distortion-free — which the signal text must not hide: callers know from
 * the commitment whether a LUT was present.
 */
export function undistortPixel(
  u: number,
  v: number,
  intr: CameraIntrinsics,
  lut?: DistortionLut,
): [number, number] {
  const [xd, yd] = pixelToNormalized(u, v, intr);
  return lut ? undistortNormalized(xd, yd, lut) : [xd, yd];
}

/**
 * Largest |normalized coordinate| over the frame — the value a commitment's
 * domainRadius SHOULD cover. Used by the verifier to sanity-check a
 * committed LUT before trusting it.
 */
export function frameDomainRadius(intr: CameraIntrinsics): number {
  const xs = [Math.abs((0 - intr.cx) / intr.fx), Math.abs((intr.width - intr.cx) / intr.fx)];
  const ys = [Math.abs((0 - intr.cy) / intr.fy), Math.abs((intr.height - intr.cy) / intr.fy)];
  return Math.max(...xs, ...ys);
}

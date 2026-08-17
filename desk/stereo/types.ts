// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Stereo planarity signal — committed-input types.
 *
 * P3/P4 design rule: the device commits the INPUTS (both frames, calibration,
 * sync timestamps, metadata), never a verdict. The desk recomputes everything
 * from those committed frames. A verdict-only blob would be unfalsifiable, so
 * nothing in this file is a device-computed answer — it is the raw material the
 * desk needs to redo the geometry itself.
 *
 * AVDepthData is explicitly NOT part of this contract: it is ML-smoothed and
 * inpainted by the device, so it can never be fed to the verifier as ground
 * truth (P4 item 21).
 */

/** Pinhole intrinsics for one physical camera, in pixels. */
export interface CameraIntrinsics {
  /** Focal length in pixels (x and y; phones are near-square-pixel). */
  fx: number;
  fy: number;
  /** Principal point in pixels. */
  cx: number;
  cy: number;
  /** Full-resolution frame size these intrinsics describe. */
  width: number;
  height: number;
}

/**
 * Rigid transform relating the two physical cameras.
 *
 * rotation is row-major 3×3, translationM is meters, such that a point P in
 * the PRIMARY camera frame maps to the SECONDARY camera frame as:
 *
 *   P_secondary = R · P_primary + t
 *
 * |t| is the stereo baseline (~10–12mm between wide and ultra-wide on current
 * phones). The baseline magnitude is what sets the effective range of the
 * planarity signal, so it is committed rather than assumed.
 */
export interface CameraExtrinsics {
  rotation: number[]; // 9 elements, row-major
  translationM: [number, number, number];
}

/**
 * Lens distortion lookup table, AVCameraCalibrationData-style.
 *
 * Apple commits a FORWARD table (lensDistortionLookupTable): sampled at
 * undistorted normalized pinhole coordinates, each entry is the displacement
 * to the distorted position. Undistorting therefore requires an INVERSE
 * lookup, which undistort.ts does by fixed-point iteration with bilinear
 * sampling — the desk cannot ask the device to undo its own distortion and
 * stay honest.
 *
 * Domain: normalized pinhole coordinates (x, y) are divided by `domainRadius`
 * (the maximum |x| or |y| over the frame, so the frame maps into [-1, 1]²),
 * then bilinearly sampled over the (width × height) grid. values is row-major
 * with 2 floats per node: [dx, dy] displacement in normalized coordinates.
 */
export interface DistortionLut {
  width: number;
  height: number;
  /** Scale mapping normalized pinhole coords into the [-1, 1] LUT domain. */
  domainRadius: number;
  /** Row-major (height × width) grid, 2 floats per node: [dx, dy]. */
  values: ArrayLike<number>;
}

/**
 * The camera metadata block committed alongside the frames (P3 item 14).
 * focusDistanceM matters to the verifier: the distance gate is part of the
 * signal, and the committed focus distance is one of two independent depth
 * cues the gate weighs (the other is disparity itself).
 */
export interface StereoMetadataBlock {
  /** Committed lens focus distance in meters, if the device reported one. */
  focusDistanceM?: number;
  focalLengthMm: number;
  aperture: number;
  exposureS: number;
  iso: number;
  /** Which physical device fired as primary (e.g. 'wide', 'ultra-wide'). */
  devicePosition: string;
  antiBandingState: string;
}

/**
 * Everything the desk needs to recompute stereo geometry without trusting
 * any device-computed number.
 */
export interface StereoCommitment {
  /** Content hash of the primary (full-resolution) frame. */
  primaryFrameHash: string;
  /**
   * The secondary frame itself (downsampled ~640×480 per P3) — a filesystem
   * path the desk reads, or the raw bytes. The verifier never accepts a
   * hash-only secondary: it must be able to recompute from pixels.
   */
  secondaryFrame: { path: string } | { bytes: Uint8Array };
  calibration: {
    intrinsicsWide: CameraIntrinsics;
    intrinsicsUltraWide: CameraIntrinsics;
    extrinsics: CameraExtrinsics;
    distortionLut?: DistortionLut;
  };
  /** Hardware sync delta between the two frames, milliseconds. */
  syncTimestampDeltaMs: number;
  /**
   * The per-capture metadata block. OPTIONAL since photo
   * commitments carry it; VIDEO pair commitments carry none (the module
   * commits no per-pair block), so the distance gate then weighs the
   * disparity cue alone. The planarity gate's use was already
   * optional-chained — an absent block narrows the depth cues, it never
   * fabricates one.
   */
  metadataBlock?: StereoMetadataBlock;
}

/** One 2D–2D correspondence between the two views, in pixel coordinates. */
export interface Correspondence {
  /** Pixel coordinate in the primary frame. */
  primary: [number, number];
  /** Pixel coordinate in the secondary frame. */
  secondary: [number, number];
}

/**
 * The planarity signal output. Four honest states:
 *
 *  - 'planar': the two views are consistent with a single flat surface,
 *    within the effective range. This is NOT a verdict of recapture and NOT
 *    evidence of authenticity — a real photograph of a flat surface (a wall,
 *    a document, a table) looks exactly the same.
 *  - 'non-planar': the two views are NOT explained by one homography, within
 *    effective range. This indicates real 3D structure (or a matching
 *    failure). It is NOT a verdict of authenticity either.
 *  - 'insufficient-geometry': the scene is beyond the effective range of the
 *    ~10–12mm baseline (disparity falls as 1/Z), or too few correspondences
 *    survived to support the model. This is a limit of the geometry, not
 *    suspicion.
 *  - 'unsupported': the commitment itself cannot be evaluated (missing or
 *    malformed calibration, degenerate baseline, frame unreadable).
 *
 * Every `text` carries the effective-range bound and the "signal, not a
 * verdict" framing inline, because absence of a flag must never read as
 * proof of authenticity.
 */
export interface PlanaritySignal {
  state: 'planar' | 'non-planar' | 'insufficient-geometry' | 'unsupported';
  /** Median symmetric transfer error of inliers, in pixels, when computed. */
  residualPx?: number;
  /** Fraction of correspondences consistent with the best homography. */
  inlierRatio?: number;
  /**
   * The geometric reach of THIS commitment's baseline+intrinsics, in meters:
   * the scene depth at which the depth-discrimination the signal can resolve
   * falls to the matcher noise floor (disparity gradient d/dZ = f·B/Z²).
   * Always reported, in every state, because it bounds what the result means.
   */
  effectiveRangeM: number;
  /** Human-readable signal text with the bounds attached. Never a verdict. */
  text: string;
}

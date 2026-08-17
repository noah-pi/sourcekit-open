// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * TYPE-ONLY stand-in for the app's withheld camera bridge
 * (src/lib/exhibitCamera.ts). attest.mts and stereoGlue.mts import these
 * types for the capture-contract shapes only; type imports are erased at
 * runtime and the lab never runs camera code. The declarations below mirror
 * the committed-record contract — the same shapes the public record schema
 * and the desk's stereo verifier consume — and deliberately omit every
 * function, method, and implementation detail of the withheld module.
 * If the app's contract drifts from this file, the staged strict typecheck
 * fails. That is the point.
 */

/** The app narrows this to a named union of NativeException-derived codes;
 * the lab never constructs one, so the shim keeps it wide. */
export type ExhibitCameraErrorCode = string;

/**
 * Three-state honesty for every committed artifact: recorded, attempted-
 * and-failed (stated verbatim), or never-attempted (unreached, never red).
 * There is no silent middle state. Paths are plain filesystem paths.
 */
export type EvidencePath =
  | { state: 'path'; path: string }
  | { state: 'error'; code: ExhibitCameraErrorCode; message: string }
  | { state: 'never-recorded'; reason: string };

/** Depth-map sidecar metadata, committed alongside the PNG. */
export interface DepthArtifactMetadata {
  mime: 'image/png';
  mapSemantics: 'disparity' | 'depth';
  filtered: boolean;
  width: number;
  height: number;
  /** The COLOR image's dimensions — what the map gets stretched to fit. */
  photoWidth: number;
  photoHeight: number;
  accuracy?: unknown;
  accuracyRaw?: unknown;
  /** The normalization window (the map encoding's value bounds). */
  normalizationMin: number;
  normalizationMax: number;
  nonFinitePixelCount: number;
  note?: unknown;
  /** Calibration dict when the platform delivered it. */
  cameraCalibration?: Record<string, unknown> | null;
}

/** Sensor-log handoff fields on the capture result. */
export interface SensorLogEvidence {
  sensorLogPath?: string | null;
  /** Which IMU-sink case this capture is. */
  sensorLogState?: string;
  sensorLogError?: string;
}

/** Full session-calibration payload (extrinsics, distortion LUTs). */
export interface SerializedCalibrationData {
  device: string;
  intrinsicMatrixRowMajor: number[]; // 9
  intrinsicMatrixReferenceDimensions: { width: number; height: number };
  extrinsicMatrixRowMajor: number[]; // 12 (4×3)
  pixelSizeMicrometers: number;
  lensDistortionCenter: { x: number; y: number };
  lensDistortionLookupTable: number[] | null;
  inverseLensDistortionLookupTable: number[] | null;
}

/** The calibration file written per capture. */
export interface CalibrationFile {
  primaryIntrinsicsRowMajor: number[] | null;
  secondaryIntrinsicsRowMajor: number[] | null;
  primaryFull: SerializedCalibrationData | null;
  secondaryFull: SerializedCalibrationData | null;
  calibrationSource: {
    intrinsics: 'frame-attachments' | 'unavailable';
    full: 'session-photo-capture' | 'unavailable';
  };
}

/**
 * The capture handoff: every evidence artifact in three-state form, plus the
 * committed hashes/dimensions for the full-sensor stills and depth maps.
 * Only the fields the lab reads are mirrored; the app's interface carries
 * more (settings read-backs, stereo status detail) — all additive.
 */
export interface CaptureResult extends SensorLogEvidence {
  captureId: string;
  /** Plain filesystem path, not a file:// URI. */
  deliveryPath: string;
  capturedAtMs: number;
  /** Stereo session capability/state string — opaque in the lab. */
  stereo: string;
  secondaryFrame: EvidencePath;
  calibration: EvidencePath;
  timestamps: EvidencePath;
  metadata: EvidencePath;
  rawDng: EvidencePath;
  synchronizedDeltaMs: number | null;
  droppedPairCount: number;
  hardwareCost: number | null;
  physicalDevices: { primary: string | null; secondary: string | null };
  fullResStill?: EvidencePath;
  fullResStillSha256?: string | null;
  fullResStillDimensions?: { width: number; height: number } | null;
  fullResSecondary?: EvidencePath;
  fullResSecondarySha256?: string | null;
  fullResSecondaryDimensions?: { width: number; height: number } | null;
  fullResStillDepth?: EvidencePath;
  fullResStillDepthSha256?: string | null;
  fullResStillDepthMetadata?: DepthArtifactMetadata | null;
  fullResSecondaryDepth?: EvidencePath;
  depth?: EvidencePath;
  depthSha256?: string | null;
  depthMetadata?: DepthArtifactMetadata | null;
}

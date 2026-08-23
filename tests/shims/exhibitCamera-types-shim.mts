// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Type-only stand-in for the app's withheld camera bridge
 * (src/lib/exhibitCamera.ts). attest.mts and stereoGlue.mts import these
 * shapes; type imports are erased at runtime and the lab never runs camera
 * code. Mirrors the committed-record contract and omits every function and
 * implementation detail. Drift from the app's contract fails the staged
 * strict typecheck.
 */

/** The app narrows this to a union of NativeException-derived codes; the
 * lab never constructs one, so the shim keeps it wide. */
export type ExhibitCameraErrorCode = string;

/**
 * Three states per committed artifact: recorded, attempted and failed, or
 * never attempted. Paths are plain filesystem paths.
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
  /** The color image's dimensions; the map is stretched to fit these. */
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
 * The capture handoff: every evidence artifact in three-state form, plus
 * committed hashes and dimensions for the full-sensor stills and depth
 * maps. Only the fields the lab reads are mirrored; the app's interface
 * carries more, all additive.
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

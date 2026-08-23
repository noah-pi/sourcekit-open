// Not exercised by CI; validated by the on-device soak checklist.
/**
 * Bridge to the native ExhibitCamera module (modules/exhibit-camera): the
 * app's single camera session — native preview, chrome, synchronized stereo
 * pair capture with committed calibration, timestamps and metadata,
 * periodic stereo pairs during video, and true Bayer RAW opt-in.
 *
 * Emits commit inputs, not computed answers (Spec-Camera-Module-0.13).
 * Absent on web, Android, simulators, and old builds, so callers check
 * `isExhibitCameraAvailable()` first and take the stated fallback path.
 *
 * Vocabulary: 'unsupported' hardware means unreached and renders gray, not
 * red; absence is stated rather than omitted.
 *
 * No network I/O.
 */

import { Platform } from 'react-native';
import { requireNativeModule, requireNativeViewManager, EventEmitter } from 'expo-modules-core';
import type { ComponentType } from 'react';

// ---------------------------------------------------------------------------
// Enums / literals
// ---------------------------------------------------------------------------

/** Physical lens stack selection: optical devices, not a crop. */
export type ExhibitLens = 'ultraWide' | 'wide' | 'telephoto';
export type ExhibitFacing = 'back' | 'front';
export type ExhibitTorch = 'off' | 'on';

/**
 * Photo-strobe preference: AVCapturePhotoSettings.flashMode on the photo
 * output for stills. Separate from ExhibitTorch, the video-only continuous
 * light, which this preference never drives.
 */
export type PhotoFlashMode = 'auto' | 'on' | 'off';

/**
 * Hardware probe result (spec §7). 'unsupported' and 'unreached' share one
 * gray visual treatment.
 *  - 'available'   — multicam, both back devices, permission granted
 *  - 'unsupported' — this device cannot do stereo
 *  - 'unreached'   — not probed, no permission, or module absent
 */
export type StereoAvailability = 'available' | 'unsupported' | 'unreached';

/**
 * Per-session stereo state. 'degraded-thermal' is a mid-session event
 * (thermal policy detached the secondary, spec §6), distinct from both
 * 'available' and 'unsupported'.
 */
export type StereoSessionState = 'available' | 'degraded-thermal' | 'unsupported';

/**
 * Three-state result of the capture's IMU (accel+gyro) sink. Mirrors the
 * audio module's SensorLogState; kept as its own copy so this library stays
 * self-contained.
 */
export type SensorLogState =
  /** The JSONL exists at sensorLogPath and covers the capture window. */
  | 'recorded'
  /** The sink was requested but failed (write error). */
  | 'failed'
  /** No IMU on this device, thermal pressure parked the sink, or no log
   * was requested. */
  | 'unavailable';

/**
 * IMU evidence-sink fields carried by both photo and video results. The
 * JSONL uses the CaptureKit SensorLogger line format: accel+gyro at the
 * 100 Hz target sliced from a 60 s ring — [-2 s, +0.5 s] around the shutter
 * for a still, the recording window (tail-truncated beyond 60 s, stated in
 * the file's `window` line) for video. A failed or absent log never blocks
 * the capture.
 *
 * Older native builds omit these fields; callers map undefined to
 * 'never-recorded', as with the audio sink.
 */
export interface SensorLogEvidence {
  /** Plain filesystem path; non-null only when sensorLogState is 'recorded'. */
  sensorLogPath?: string | null;
  /** Which IMU-sink case this capture is. */
  sensorLogState?: SensorLogState;
  /** The first write error's message; present only when 'failed'. */
  sensorLogError?: string;
}

/** NamedException-derived error codes (do not rename; native matches). */
export type ExhibitCameraErrorCode =
  | 'E_PERMISSION'
  | 'E_BUSY'
  | 'E_NO_SESSION'
  | 'E_PLATFORM'
  | 'E_WRITER'
  | 'E_STALE_PAIR'
  | 'E_THERMAL'
  | 'E_HARDWARE_COST'
  | 'E_SINK';

// ---------------------------------------------------------------------------
// EvidencePath — three-state honesty for every committed artifact (spec §5)
// ---------------------------------------------------------------------------

/**
 * Every artifact the module commits reports exactly one of three states:
 *  - { state: 'path', path }               — the file exists on disk
 *  - { state: 'error', code, message }     — attempted and failed
 *  - { state: 'never-recorded', reason }   — not attempted (toggle off,
 *                                            unsupported hardware, or not
 *                                            requested)
 * All paths are plain filesystem paths (url.path), never file:// URIs.
 */
export type EvidencePath =
  | { state: 'path'; path: string }
  | { state: 'error'; code: ExhibitCameraErrorCode; message: string }
  | { state: 'never-recorded'; reason: string };

/**
 * Maps an EvidencePath onto the store's sink-state vocabulary: the path when
 * recorded, otherwise a display-safe explanation. Callers record
 * 'never-recorded' and 'enabled-but-failed' as distinct facts (rule 4b).
 */
export function describeEvidencePath(
  ep: EvidencePath,
): { recorded: true; path: string } | { recorded: false; state: 'error' | 'never-recorded'; detail: string } {
  if (ep.state === 'path') return { recorded: true, path: ep.path };
  if (ep.state === 'error') return { recorded: false, state: 'error', detail: `${ep.code}: ${ep.message}` };
  return { recorded: false, state: 'never-recorded', detail: ep.reason };
}

// ---------------------------------------------------------------------------
// Committed blocks (spec §4.2 / §5): inputs, not computed answers.
// ---------------------------------------------------------------------------

/** Anti-banding state: region-derived, not measured flicker (iOS has no
 * flicker query API). The literal note is part of the contract. */
export interface ExhibitAntiBanding {
  mainsHz: 50 | 60;
  exposureSec: number | null;
  note: 'region-derived';
}

/**
 * Per-device camera metadata block. Every field is a device read-back or an
 * explicit null.
 *
 * The pro-control fields (spec §14) are device-reported applied values,
 * labeled `controlsReportedBy: 'device'`. Device enums are emitted both
 * mapped (stable string) and raw (Int). The device cannot distinguish
 * 'locked' from 'manual' for focus and WB — both report 'locked' — so
 * manual intent shows up in lensPosition / whiteBalanceTemperatureTint.
 */
export interface CameraMetadataBlock {
  /** AVCaptureDevice.DeviceType raw value: which physical device fired. */
  physicalDevice: string;
  modelID: string;
  // ---- pro controls (spec §14): applied values, device-reported ----
  /** 'auto' | 'locked' | 'custom' (mapped; raw enum in exposureModeRaw). */
  exposureMode: 'auto' | 'locked' | 'custom' | 'unknown';
  exposureModeRaw: number;
  exposureDurationSec: number | null;
  iso: number;
  exposureBias: number;
  /** 'auto' | 'continuous' | 'locked'. 'manual' intent reports 'locked'. */
  focusMode: 'auto' | 'continuous' | 'locked' | 'unknown';
  focusModeRaw: number;
  /** Unitless focus motor position, 0–1. Committed, not interpreted. */
  lensPosition: number;
  /** 'auto' | 'continuous' | 'locked'. 'manual' intent reports 'locked'. */
  whiteBalanceMode: 'auto' | 'continuous' | 'locked' | 'unknown';
  whiteBalanceModeRaw: number;
  whiteBalanceGains: { r: number; g: number; b: number } | null;
  /** Only when the device reports WB mode-locked: temperature and tint
   * computed from device-reported gains via the OS converter. */
  whiteBalanceTemperatureTint: { temperature: number; tint: number; note: string } | null;
  /** 0 when off; null on devices with no torch hardware. */
  torchLevel: number | null;
  /** "<deviceType.rawValue>:<index>", stable per device model and OS. */
  formatID: string | null;
  /** Connection read-back: 'off' | 'standard' | 'cinematic' | 'auto'. */
  stabilizationMode: string | null;
  /** Connection read-back; null when the active format has no HDR. */
  hdrEnabled: boolean | null;
  /** Literal label: every pro-control field is read back from the device
   * or connection, not from the module's request log. */
  controlsReportedBy: 'device';
  /**
   * Always null: iOS exposes no public focus-distance-in-meters API, and it
   * is not derived from lensPosition.
   */
  focusDistanceMeters: null;
  /** Pixel focal lengths from committed calibration; null when absent. */
  focalLengthPixels: { fx: number; fy: number } | null;
  fieldOfViewDegrees: number;
  apertureFNumber: number;
  antiBanding: ExhibitAntiBanding;
  activeFormat: { width: number; height: number; fps: number };
  /** session.hardwareCost at capture time, committed so thermal questions
   * have a number. */
  hardwareCost: number;
  /** Inter-frame PTS delta: the sync measurement, uninterpreted. */
  synchronizedDeltaMs: number | null;
  droppedPairCount: number;
  /** Every iOS frame passes the platform's computational pipeline; stated
   * so no manifest implies unprocessed sensor data for a JPEG. */
  platformProcessing: 'apple-default-pipeline';
}

/** Calibration file contents (calibration-*.json, spec §4.2). */
export interface CalibrationFile {
  /** Row-major 3×3 per-frame intrinsics from sample-buffer attachments;
   * null when the OS attached none. */
  primaryIntrinsicsRowMajor: number[] | null;
  secondaryIntrinsicsRowMajor: number[] | null;
  /** Full calibration (extrinsics, distortion LUTs) from the session
   * one-shot photo capture; null when unsupported. */
  primaryFull: SerializedCalibrationData | null;
  secondaryFull: SerializedCalibrationData | null;
  /** Which path produced which numbers, so a desk can tell per-frame from
   * session-fixed and full from intrinsics-only. */
  calibrationSource: {
    intrinsics: 'frame-attachments' | 'unavailable';
    full: 'session-photo-capture' | 'unavailable';
  };
}

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

/** Timestamps file contents (timestamps-*.json). */
export interface SyncTimestampsFile {
  captureId: string;
  capturedAtMs: number;
  primaryHostSeconds: number | null;
  secondaryHostSeconds: number | null;
  synchronizedDeltaMs: number | null;
  clockNote: string;
}

// ---------------------------------------------------------------------------
// Committed capture settings (device read-backs at the commit instant)
// ---------------------------------------------------------------------------

/**
 * White-balance temperature and tint computed by the OS's own converter from
 * the device-reported gains (temperatureAndTintValues(for:)). Transient
 * unless the device reports WB mode-locked; the note states this verbatim.
 */
export interface WhiteBalanceTemperatureTint {
  temperature: number;
  tint: number;
  note: string;
}

/**
 * The full camera state committed at shutter time. Every value is an
 * AVCaptureDevice or AVCapturePhotoOutput read at commit time
 * (`controlsReportedBy: 'device'`) or an explicit null. `photoExif` carries
 * only the EXIF the OS wrote into the full-res photo's metadata, and
 * `flashFired` comes from that same metadata; both are null when no
 * full-res photo ran this shutter.
 */
export interface CaptureSettings {
  /** The delivery still's pixels are a video-frame encode at session
   * resolution, resampled rather than a full-sensor readout. The
   * full-sensor still is the separate fullResStill artifact. */
  deliveryStillSource: string;
  iso: number;
  exposureDurationSec: number | null;
  /** Unitless focus motor position, 0–1 (iOS has no focus-distance API). */
  lensPosition: number;
  whiteBalanceGains: { r: number; g: number; b: number } | null;
  whiteBalanceTemperatureTint: WhiteBalanceTemperatureTint | null;
  apertureFNumber: number;
  exposureTargetBias: number;
  /** Device zoom factor actually on the primary device at shutter time. */
  videoZoomFactor: number;
  exposureMode: 'auto' | 'locked' | 'custom' | 'unknown';
  focusMode: 'auto' | 'continuous' | 'locked' | 'unknown';
  whiteBalanceMode: 'auto' | 'continuous' | 'locked' | 'unknown';
  /** AVCaptureDevice.DeviceType raw value: the lens stack in use. */
  physicalDevice: string;
 /** The strobe preference written into the photo settings. */
  photoFlashMode: PhotoFlashMode;
  photoFlashHardware: boolean;
  /** Device-reported supported flash modes ([] = unknown, no session). */
  photoFlashSupportedModes: string[];
  /** null means no full-res photo ran, or its metadata carried no Flash
   * tag. Not inferred. */
  flashFired: boolean | null;
  /** EXIF numbers exactly as the OS wrote them into the full-res photo
   * (ISOSpeedRatings, ExposureTime, FNumber, ExposureBiasValue, FocalLength,
   * FocalLengthIn35mmFilm, Flash, WhiteBalance; absent tags stay absent).
   * null when no full-res photo ran. Never synthesized. */
  photoExif: Record<string, number> | null;
  /** What the strobe request became on the photo output. */
  photoFlashApplied?: {
    requested: PhotoFlashMode;
    /** false means the requested mode was not in supportedFlashModes; the
     * capture went strobe-free and the note says why. */
    applied: boolean;
    note: string | null;
  };
  /** Literal label: every field above is a device/photo read-back. */
  controlsReportedBy: 'device';
}

// ---------------------------------------------------------------------------
// API payloads
// ---------------------------------------------------------------------------

export interface ExhibitCameraPermissions {
  camera: boolean;
  microphone: boolean;
}

export interface ConfigureSessionOptions {
  lens?: ExhibitLens;
  facing?: ExhibitFacing;
  /** Default true. False runs single-cam even on capable hardware. */
  stereo?: boolean;
  /** IMU evidence sink: accel+gyro stream into a 60 s ring for the session
   * so stills and video commit a signed sensor log (sensorLog* fields on
   * the results). Default false. Older native builds ignore the flag and
   * omit the fields. */
  sensorLog?: boolean;
  /** Shutter-burst sink: each still commits the 3 pre-shutter and 4
   * post-shutter frames it was cut from into evidenceDir/ring-<captureId>/
   * (ringBufferDir and ringFrameCount on the result). A sink failure is an
   * 'error' EvidencePath; the capture never rejects for it. Default false.
   * Older builds ignore the flag and omit the fields. */
  ring?: boolean;
  /** Selectable stereo partner stack: 'auto' (the UW↔W/T pairing, default)
   * or an explicit rear stack. Applies at session build; live swaps go
   * through setSecondaryLens. Older builds ignore the flag. */
  secondaryLens?: SecondaryLensPreference;
}

/** Selectable secondary stack vocabulary. 'auto' is the native UW↔W/T
 * pairing chosen by the primary lens. */
export type SecondaryLensPreference = 'auto' | 'ultraWide' | 'wide' | 'telephoto';

export interface SessionStart {
  sessionId: string;
  startedAtMs: number;
  /** 'available' or 'unsupported' at session start. Never 'unreached':
   * the session started, so the probe ran. */
  stereo: 'available' | 'unsupported';
  hardwareCost: number | null;
  /** Which rear-stereo graph the session runs: 'virtual-dual-wide' (one
   * input, constituent ports, hardware-synced; the default) or
   * 'multi-input' (two device inputs, restorable via Diagnostics A/B).
   * Absent on older builds. */
  graph?: 'virtual-dual-wide' | 'multi-input';
}

export interface CaptureOptions {
  /** file:// or plain path for the delivery still (primary, full res). */
  deliveryPath: string;
  /** Directory for secondary/calibration/timestamps/metadata/RAW. */
  evidenceDir: string;
  /** True Bayer RAW opt-in (spec §9). Not ProRAW, which the platform
   * processes computationally. */
  raw?: boolean;
}

/**
 * The native depth artifact's committed facts (D1). Every field is a
 * capture-side claim; nothing is derived JS-side. The artifact is a 16-bit
 * grayscale PNG, min/max-normalized over [normalizationMin,
 * normalizationMax], with non-finite pixels written as 0 and counted.
 * accuracy, accuracyRaw, note and cameraCalibration are typed unknown
 * because their Swift-side types are unspecified; pass them through.
 */
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

export interface CaptureResult extends SensorLogEvidence {
  captureId: string;
  /** Plain filesystem path, not a file:// URI. */
  deliveryPath: string;
  capturedAtMs: number;
  stereo: StereoSessionState;
  secondaryFrame: EvidencePath;
  calibration: EvidencePath;
  timestamps: EvidencePath;
  metadata: EvidencePath;
  /** True Bayer RAW DNG. When absent, 'never-recorded' with reason
   * 'not-requested' or 'raw-unsupported'; both render gray. */
  rawDng: EvidencePath;
  synchronizedDeltaMs: number | null;
  droppedPairCount: number;
  hardwareCost: number | null;
  physicalDevices: { primary: string | null; secondary: string | null };
  // ---- full-sensor stills. Absent on older native builds; callers treat
  // undefined as "not committed this capture". ----
  /** Full-sensor-resolution JPEG from the primary photo output, distinct
   * from deliveryPath (a video-frame encode; see
   * captureSettings.deliveryStillSource). 'never-recorded' in video mode or
   * without a photo output; 'error' states the failure verbatim. */
  fullResStill?: EvidencePath;
  /** SHA-256 (hex) of the exact fullResStill bytes on disk; null when the
   * artifact is not in the 'path' state. */
  fullResStillSha256?: string | null;
  /** Resolved photo dimensions (iOS 16+); null when unavailable. */
  fullResStillDimensions?: { width: number; height: number } | null;
  /** Stereo partner's full-sensor still. 'never-recorded' with the same
   * reason vocabulary as secondaryFrame when stereo is off or detached. */
  fullResSecondary?: EvidencePath;
  fullResSecondarySha256?: string | null;
  fullResSecondaryDimensions?: { width: number; height: number } | null;
  // ---- every camera setting, device-read at the commit instant ----
  /** The committed settings block. { unavailable: true } means the session
   * died mid-capture and the device reference was gone at commit time. */
  captureSettings?: CaptureSettings | { unavailable: true; note: string };
  // ---- degraded single-lens fallback and mirroring state. Absent on older
  // native builds; callers treat undefined as "not committed". ----
  /** Stereo evidence state for this capture. 'ok' means a synchronized
   * secondary frame was committed; 'unavailable' means no fresh
   * synchronized pair at shutter (single-lens fallback, where the delivery
   * still is the photo output's full-sensor still) or the secondary half
   * dropped, with stereoUnavailableReason stating which. Absent on
   * single-cam sessions and older builds. */
  stereoStatus?: 'ok' | 'unavailable';
  /** Machine-checkable reason when stereoStatus is 'unavailable', e.g.
   * 'no fresh synchronized frame within 900ms at shutter (dropped pairs:
   * N, …)'. */
  stereoUnavailableReason?: string;
  /** The primary connection's mirroring state at capture. Preview layers
   * auto-mirror the front camera but data and photo outputs do not, so the
   * native side sets it explicitly (front mirrors, matching the preview the
   * user composed on) and commits the read-back. null when no connection
   * existed to read. */
  frontMirrored?: boolean | null;
  // ---- D1 depth artifacts. Absent on older native builds and on some
  // early-exit branches; callers treat undefined as "not committed". ----
  /** Primary photo output's depth map: 16-bit grayscale PNG, min/max-
   * normalized with the window committed in fullResStillDepthMetadata.
   * 'never-recorded' reasons: depth-disabled / depth-unsupported /
   * depth-not-delivered / photo-capture-failed / photo-write-failed. */
  fullResStillDepth?: EvidencePath;
  /** SHA-256 (hex) of the exact depth bytes on disk. Undefined (not null)
   * on some early-exit branches, meaning "not committed". */
  fullResStillDepthSha256?: string | null;
  fullResStillDepthMetadata?: DepthArtifactMetadata | null;
  /** Stereo partner's depth map, same vocabulary. */
  fullResSecondaryDepth?: EvidencePath;
  fullResSecondaryDepthSha256?: string | null;
  fullResSecondaryDepthMetadata?: DepthArtifactMetadata | null;
  /** Degraded (video-frame) path's depth map, same vocabulary. */
  depth?: EvidencePath;
  depthSha256?: string | null;
  depthMetadata?: DepthArtifactMetadata | null;
  // ---- shutter-burst sink. Absent on older builds and on sessions
  // configured without `ring`. ----
  /** Directory holding the 3 pre-shutter and 4 post-shutter frames the
   * delivery still was cut from, plus a JSON index. 'never-recorded'
   * reasons: not-requested, no-synchronized-pair-at-shutter,
   * not-available-during-video-recording. 'error' states a sink failure
   * verbatim; the capture itself still succeeded. */
  ringBufferDir?: EvidencePath;
  /** Frames committed into ringBufferDir; 0 on never-recorded and error. */
  ringFrameCount?: number;
}

export interface StartVideoOptions {
  deliveryPath: string;
  evidenceDir: string;
  /** Seconds between committed stereo pairs (spec §8). Default 5, min 2.
   * Periodic rather than continuous, for thermal and power headroom. */
  pairIntervalSec?: number;
  /** Raw-audio-master sink: tee the mic buffers to an LPCM mono 16 kHz
   * 16-bit CAF in the evidence dir while the delivery writer consumes the
   * same native buffers, so a sink failure never touches delivery.
   * Default false. */
  rawPcm?: boolean;
}

export interface VideoStart {
  sessionId: string;
  startedAtMs: number;
  pairIntervalSec: number;
  stereo: StereoSessionState;
}

export interface VideoResult extends SensorLogEvidence {
  deliveryPath: string;
  durationMs: number;
  /** false means the delivery file has no audio track: the mic never
   * delivered. */
  audioTrack: boolean;
  pairsCommitted: number;
  pairsMissed: number;
  /** Raw-audio-master sink: a string path means recorded, null means
   * enabled but failed. The disabled case never reaches here; the caller
   * owns the toggle and states 'never-recorded' itself. */
  rawPcmPath: string | null;
  /** ENF anchor and integrity summary for the committed master; present
   * only when rawPcmPath is a string. firstSampleWallClockUtcMs anchors the
   * first written sample to wall clock (mach-PTS converted, or the append
   * instant — firstSampleAnchor says which), so a desk can cross-correlate
   * the 50/60 Hz mains trace against a reference ENF series in absolute
   * time. fileSha256 binds the analysis to the exact committed bytes. */
  rawPcmInfo?: {
    firstSampleWallClockUtcMs: number | null;
    firstSampleAnchor: string | null;
    sampleCount: number;
    sampleRate: number;
    fileSha256: string | null;
    /** The finalized CAF's own container facts, read back at stop and
     *  committed alongside the writer's counters.
     *  framesMatchContainer:false records a writer/container divergence as
     *  sealed data. */
    containerSampleRate?: number;
    containerFormatFlags?: number;
    containerBytesPerFrame?: number;
    containerChannels?: number;
    containerBitsPerChannel?: number;
    containerPayloadBytes?: number;
    containerFrames?: number;
    framesMatchContainer?: boolean;
  } | null;
  /** Audio tap liveness counter for the take. 0 with the master requested
   * means the tap never delivered: an audio-session or permission fact,
   * not a conversion failure. */
  audioBufferCount?: number;
  hardwareCost: number | null;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export interface ExhibitCameraErrorEvent {
  code: ExhibitCameraErrorCode;
  message: string;
}

/** Thermal/system-pressure state changes (spec §6). */
export interface HardwarePressureEvent {
  state: 'serious' | 'critical';
  action: 'pair-cadence-halved' | 'stereo-detached';
  degraded?: 'stereo-detached';
  thermalState: string;
}

/** Fired per committed periodic stereo pair during video (spec §8). */
export interface StereoPairCapturedEvent {
  index: number;
  secondaryPath: string | null;
  calibrationPath: string | null;
  primaryHostSeconds: number | null;
  synchronizedDeltaMs: number | null;
}

/**
 * Fired once per session when the frame pipeline stalls (preview keeps
 * painting but synchronized frames stop) and a synchronizer rebind did not
 * recover it. The response is a session rebuild, owned by the capture
 * screen's lifecycle effect.
 */
export interface SyncStalledEvent {
  ageSeconds: number;
  droppedPairCount: number;
  droppedPrimaryCount?: number;
  droppedSecondaryHalfCount?: number;
  /** Diagnostics split, absent on older builds. secondaryAbsent means the
   * synchronizer returned no secondary data object; secondaryDropped means
   * an object was present but failed the sync window. Complete pairs, stale
   * shutters and reseat state separate a dead secondary stream from
   * shutter-timing rejection. */
  secondaryAbsentCount?: number;
  secondaryDroppedCount?: number;
  completePairCount?: number;
  staleShutterCount?: number;
  secondaryReseatDone?: boolean;
}

/** Preview-readiness (view event). `signal` names which readiness signal
 * fired. */
export interface PreviewReadyEvent {
  signal: 'first-synchronized-frame' | string;
}

// ---------------------------------------------------------------------------
// Chrome result payloads. No-ops when hardware lacks support.
// ---------------------------------------------------------------------------

export interface ChromeResult {
  applied: boolean;
  reason?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Pro controls (spec §14). Every setter returns { applied: false, reason }
// on hardware lacking the capability rather than throwing. Availability
// comes from capabilities().
// ---------------------------------------------------------------------------

export type ExposureModeSetting = 'auto' | 'locked' | 'custom';
export type FocusModeSetting = 'auto' | 'locked' | 'manual';
export type WhiteBalanceModeSetting = 'auto' | 'locked' | 'manual';
export type StabilizationModeSetting = 'off' | 'standard' | 'cinematic' | 'auto';

export interface SetExposureModeOptions {
  mode: ExposureModeSetting;
  /** Required when mode === 'custom'. Clamped to the active format's
   * min/max ISO (not the device-global range). */
  iso?: number;
  /** Required when mode === 'custom'. Clamped to the active format's
   * min/max exposure duration. */
  durationSeconds?: number;
}

export interface ExposureModeResult extends ChromeResult {
  exposureMode?: ExposureModeSetting;
  /** Requested values after clamping (custom mode). The device-settled
   * values are committed per capture in the metadata block. */
  iso?: number;
  durationSeconds?: number;
  isoClamped?: boolean;
  durationClamped?: boolean;
}

export interface SetFocusModeOptions {
  mode: FocusModeSetting;
  /** Required when mode === 'manual'. Unitless, 0–1, clamped. iOS has no
   * focus-distance API, so lensPosition is the manual control. */
  lensPosition?: number;
}

export interface FocusModeResult extends ChromeResult {
  focusMode?: FocusModeSetting;
  lensPosition?: number;
  lensPositionClamped?: boolean;
}

export interface SetWhiteBalanceModeOptions {
  mode: WhiteBalanceModeSetting;
  /** Required when mode === 'manual'. Converted to gains via the
   * device's own converter; gains clamped to maxWhiteBalanceGain. */
  temperature?: number;
  tint?: number;
}

export interface WhiteBalanceModeResult extends ChromeResult {
  whiteBalanceMode?: WhiteBalanceModeSetting;
  gains?: { r: number; g: number; b: number };
  gainsClamped?: boolean;
  /** Round-tripped temperature and tint of the clamped gains: what the
   * hardware accepted. */
  appliedTemperature?: number;
  appliedTint?: number;
  maxWhiteBalanceGain?: number;
}

export interface TorchLevelResult extends ChromeResult {
  /** 0 = off. Clamped to the documented 1.0 API ceiling natively; device max enforced via throw. */
  torchLevel?: number;
  levelClamped?: boolean;
  maxTorchLevel?: number;
}

export interface FormatInfo {
  /** "<deviceType.rawValue>:<index>", stable per device model and OS. */
  formatID: string;
  width: number;
  height: number;
  frameRateRanges: Array<{ minFPS: number; maxFPS: number }>;
  isVideoHDRSupported: boolean;
  isVideoBinned: boolean;
  fieldOfViewDegrees: number;
  minISO: number;
  maxISO: number;
  minExposureDurationSec: number;
  maxExposureDurationSec: number;
}

export interface LensFormatList {
  present: boolean;
  deviceType?: string;
  formats?: FormatInfo[];
}

export interface ListFormatsResult {
  lenses: Record<'ultraWide' | 'wide' | 'telephoto' | 'frontWide', LensFormatList>;
  multiCamSupported: boolean;
  /** null means unknown without a running session, not unsupported. */
  rawSupported: boolean | null;
  rawNote: string;
}

export interface SetFormatOptions {
  formatID: string;
  /** Pinned min==max frame duration, clamped into the format's ranges. */
  frameRate?: number;
}

export interface SetFormatResult extends ChromeResult {
  formatID?: string;
  width?: number;
  height?: number;
  frameRate?: number;
  frameRateClamped?: boolean;
  /** Device format feeds both paths; always 'photo-and-video'. */
  appliesTo?: string;
  hardwareCost?: number;
}

export interface StabilizationResult extends ChromeResult {
  stabilizationMode?: StabilizationModeSetting;
  /** Connection read-back of the mode actually on the pipeline. */
  activeMode?: string;
}

export interface HDRResult extends ChromeResult {
  hdrEnabled?: boolean;
  /** Connection read-back. */
  activeHDR?: boolean;
}

/** Photo-strobe preference result. */
export interface PhotoFlashResult extends ChromeResult {
  photoFlash?: PhotoFlashMode;
  /** Strobe hardware present on the active device. */
  hasFlash?: boolean;
  /** Device-reported supported modes; [] = unknown without a session. */
  supportedModes?: string[];
  note?: string;
}

/** Zoom-ramp result: ramp(toVideoZoomFactor:withRate:). */
export interface ZoomSmoothResult extends ChromeResult {
  zoomFactor?: number;
  clamped?: boolean;
  /** The rate actually used (clamped natively to [1, 60]). */
  rate?: number;
}

/**
 * Per-constituent-device zoom ceilings. `qualityCap` is an app-chosen
 * digital-quality ceiling, not a hardware limit (see zoomQualityNote);
 * `hardwareMax` is the device's own maxAvailableVideoZoomFactor. Absent
 * lenses are omitted.
 */
export interface LensZoomCap {
  lens: ExhibitLens;
  deviceType: string;
  hardwareMax: number;
  qualityCap: number;
}

/**
 * The active device's zoom contract. min/max are the device's own supported
 * range. Two optional fields, absent on older native builds:
 *  - qualityCap: app-chosen digital-quality ceiling for this device, not a
 *    hardware limit; the UI clamps to min(max, qualityCap).
 *  - switchOverFactors: the containing virtual device's
 *    virtualDeviceSwitchOverVideoZoomFactors, the hardware hand-off points
 *    the UI's optical stops should match.
 */
export interface ZoomRange {
  min: number;
  max: number;
  qualityCap?: number;
  switchOverFactors?: number[];
}

/**
 * What this hardware can do; the UI hides controls that report false. null
 * fields mean unknown without a session, and absent lenses in listFormats()
 * report present:false.
 */
export interface ExhibitCameraCapabilities {
  sessionActive: boolean;
  devicePresent: boolean;
  physicalDevice?: string;
  stereo: StereoAvailability;
  exposureModes?: { auto: boolean; locked: boolean; custom: boolean };
  exposurePointOfInterestSupported?: boolean;
  focusModes?: { auto: boolean; locked: boolean; manual: boolean };
  focusPointOfInterestSupported?: boolean;
  whiteBalanceModes?: { auto: boolean; locked: boolean; manual: boolean };
  maxWhiteBalanceGain?: number;
  torch?: { available: boolean; maxTorchLevel: number | null };
  activeFormatHDRSupported?: boolean;
  stabilizationModesSupported?: string[];
  stabilizationNote?: string;
  rawSupported?: boolean | null;
  activeFormatISO?: { min: number; max: number };
  activeFormatExposureDurationSec?: { min: number; max: number };
  zoomRange?: ZoomRange;
  /** Per-constituent-device ceilings; absent on older builds. */
  lensZoomCaps?: LensZoomCap[];
  /** States that qualityCap is a quality choice, not a hardware limit.
   * Part of the contract. */
  zoomQualityNote?: string;
  /** The selectable secondary stack: every rear stack present on this
   * hardware in the bridge's lens vocabulary, plus the current preference
   * ('auto' when unset). */
  secondaryLensOptions?: string[];
  secondaryLens?: string;
  /** Hardware probe for an opportunistic third synchronized view. The view
   * itself is gated behind the thirdViewEnabled debug flag, which is
   * untested on hardware and off by default. */
  thirdViewCapable?: boolean;
}

/** KVO-driven focus-settling signal (spec §14). Avoid capturing while
 * adjusting is true. */
export interface AdjustingFocusEvent {
  adjusting: boolean;
}

// ---------------------------------------------------------------------------
// Native wiring
// ---------------------------------------------------------------------------

interface ExhibitCameraNative {
  requestPermissions(): Promise<ExhibitCameraPermissions>;
  stereoAvailability(): Promise<StereoAvailability>;
  configureSession(opts: ConfigureSessionOptions): Promise<SessionStart>;
  stopSession(): Promise<{ stopped: boolean; reason?: string }>;
  capture(opts: CaptureOptions): Promise<CaptureResult>;
  startVideo(opts: StartVideoOptions): Promise<VideoStart>;
  stopVideo(): Promise<VideoResult>;
  setLens(lens: ExhibitLens): Promise<ChromeResult>;
  setSecondaryLens(lens: string): Promise<ChromeResult>;
  setFacing(facing: ExhibitFacing): Promise<ChromeResult>;
  setZoom(factor: number): Promise<ChromeResult>;
  setZoomSmooth(factor: number, rate: number): Promise<ZoomSmoothResult>;
  setPhotoFlashMode(mode: PhotoFlashMode): Promise<PhotoFlashResult>;
  setTorch(mode: ExhibitTorch): Promise<ChromeResult>;
  setFocusPoint(x: number, y: number): Promise<ChromeResult>;
  setExposureBias(bias: number): Promise<ChromeResult>;
  setExposureMode(opts: SetExposureModeOptions): Promise<ExposureModeResult>;
  setExposurePoint(x: number, y: number): Promise<ChromeResult>;
  setFocusMode(opts: SetFocusModeOptions): Promise<FocusModeResult>;
  setWhiteBalanceMode(opts: SetWhiteBalanceModeOptions): Promise<WhiteBalanceModeResult>;
  setTorchLevel(level: number | null): Promise<TorchLevelResult>;
  listFormats(): Promise<ListFormatsResult>;
  setFormat(opts: SetFormatOptions): Promise<SetFormatResult>;
  setVideoStabilizationMode(mode: StabilizationModeSetting): Promise<StabilizationResult>;
  setHDREnabled(enabled: boolean): Promise<HDRResult>;
  capabilities(): Promise<ExhibitCameraCapabilities>;
  setDebugFlag(key: string, value: boolean): Promise<SetDebugFlagResult>;
  getDebugFlags(): Promise<ExhibitDebugFlags>;
}

let native: ExhibitCameraNative | null = null;
try {
  if (Platform.OS === 'ios') {
    native = requireNativeModule<ExhibitCameraNative>('ExhibitCamera');
  }
} catch {
  native = null;
}

let emitter: InstanceType<typeof EventEmitter> | null = null;
function getEmitter(): InstanceType<typeof EventEmitter> | null {
  if (!native) return null;
  if (!emitter) emitter = new EventEmitter(native as never);
  return emitter;
}

/**
 * False on simulator, web, Android and older builds: callers take the
 * fallback path and stereoAvailability() reports 'unreached'.
 */
export function isExhibitCameraAvailable(): boolean {
  return native !== null;
}

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

export async function requestExhibitCameraPermissions(): Promise<ExhibitCameraPermissions> {
  if (!native) return { camera: false, microphone: false };
  return native.requestPermissions();
}

/**
 * Hardware probe; starts nothing. Module absence maps to 'unreached', which
 * gets the same gray treatment as 'unsupported' (spec §7).
 */
export async function stereoAvailability(): Promise<StereoAvailability> {
  if (!native) return 'unreached';
  return native.stereoAvailability();
}

/** Starts the one session (preview mode). Watchdog rejects after 10 s
 * without frames rather than hanging the UI. */
export async function configureSession(opts: ConfigureSessionOptions): Promise<SessionStart> {
  if (!native) throw new Error('ExhibitCamera module unavailable');
  return native.configureSession(opts);
}

export async function stopSession(): Promise<{ stopped: boolean; reason?: string }> {
  if (!native) return { stopped: false, reason: 'module-unavailable' };
  return native.stopSession();
}

/**
 * Stereo pair capture (spec §4/§5). The delivery still lands or the call
 * rejects; every evidence artifact is a three-state EvidencePath.
 */
export async function capture(opts: CaptureOptions): Promise<CaptureResult> {
  if (!native) throw new Error('ExhibitCamera module unavailable');
  return native.capture(opts);
}

export async function startVideo(opts: StartVideoOptions): Promise<VideoStart> {
  if (!native) throw new Error('ExhibitCamera module unavailable');
  return native.startVideo(opts);
}

export async function stopVideo(): Promise<VideoResult> {
  if (!native) throw new Error('ExhibitCamera module unavailable');
  return native.stopVideo();
}

// ---- chrome (spec §3) ----

export async function setLens(lens: ExhibitLens): Promise<ChromeResult> {
  if (!native) return { applied: false, reason: 'module-unavailable' };
  return native.setLens(lens);
}

/**
 * Selectable stereo partner: 'auto' restores the native UW↔W/T pairing, an
 * explicit rear stack pins the partner. Applies live on a running back
 * session, otherwise stored for the next configureSession. A conflict with
 * the primary lens or an absent stack returns applied:false with a reason,
 * as do older native builds lacking the method.
 */
export async function setSecondaryLens(lens: SecondaryLensPreference): Promise<ChromeResult> {
  if (!native || typeof native.setSecondaryLens !== 'function') {
    return { applied: false, reason: 'module-unavailable' };
  }
  return native.setSecondaryLens(lens);
}

export async function setZoom(factor: number): Promise<ChromeResult> {
  if (!native) return { applied: false, reason: 'module-unavailable' };
  return native.setZoom(factor);
}

/**
 * Ramped device zoom: ramp(toVideoZoomFactor:withRate:) for UI-driven scrub
 * ramps; lens jumps use the instant setZoom. `rate` defaults to 8 and is
 * clamped natively to [1, 60]. Absent on older native builds, where the
 * caller falls back to setZoom.
 */
export async function setZoomSmooth(factor: number, rate = 8): Promise<ZoomSmoothResult> {
  if (!native) return { applied: false, reason: 'module-unavailable' };
  if (typeof native.setZoomSmooth !== 'function') {
    return native.setZoom(factor);
  }
  return native.setZoomSmooth(factor, rate);
}

/**
 * Photo-strobe preference: sets the flashMode used by the photo output's
 * stills captures. Leaves the torch (video-only continuous light) alone. No
 * session required; the preference persists natively and is validated
 * against supportedFlashModes at capture time. No-op on older builds.
 */
export async function setPhotoFlashMode(mode: PhotoFlashMode): Promise<PhotoFlashResult> {
  if (!native) return { applied: false, reason: 'module-unavailable' };
  if (typeof native.setPhotoFlashMode !== 'function') {
    return { applied: false, reason: 'photo-flash-unsupported-on-this-native-build' };
  }
  return native.setPhotoFlashMode(mode);
}

export async function setTorch(mode: ExhibitTorch): Promise<ChromeResult> {
  if (!native) return { applied: false, reason: 'module-unavailable' };
  return native.setTorch(mode);
}

/** Tap-to-focus: x/y are normalized view coordinates (0–1, top-left). */
export async function setFocusPoint(x: number, y: number): Promise<ChromeResult> {
  if (!native) return { applied: false, reason: 'module-unavailable' };
  return native.setFocusPoint(x, y);
}

export async function setExposureBias(bias: number): Promise<ChromeResult> {
  if (!native) return { applied: false, reason: 'module-unavailable' };
  return native.setExposureBias(bias);
}

// ---- pro controls (spec §14) ----
// All return { applied: false, reason } when the module or the hardware
// capability is absent. Check capabilities() first to hide controls the
// device does not have.

export async function setExposureMode(opts: SetExposureModeOptions): Promise<ExposureModeResult> {
  if (!native) return { applied: false, reason: 'module-unavailable' };
  return native.setExposureMode(opts);
}

/** Exposure point-of-interest, independent of focus (x/y normalized 0–1). */
export async function setExposurePoint(x: number, y: number): Promise<ChromeResult> {
  if (!native) return { applied: false, reason: 'module-unavailable' };
  return native.setExposurePoint(x, y);
}

export async function setFocusMode(opts: SetFocusModeOptions): Promise<FocusModeResult> {
  if (!native) return { applied: false, reason: 'module-unavailable' };
  return native.setFocusMode(opts);
}

export async function setWhiteBalanceMode(opts: SetWhiteBalanceModeOptions): Promise<WhiteBalanceModeResult> {
  if (!native) return { applied: false, reason: 'module-unavailable' };
  return native.setWhiteBalanceMode(opts);
}

/** Torch with level: null turns it off; clamped to maxTorchLevel natively. */
export async function setTorchLevel(level: number | null): Promise<TorchLevelResult> {
  if (!native) return { applied: false, reason: 'module-unavailable' };
  return native.setTorchLevel(level);
}

/** Per-lens format inventory. No session required. */
export async function listFormats(): Promise<ListFormatsResult | null> {
  if (!native) return null;
  return native.listFormats();
}

/** Applies to the current primary device; switch lenses first. */
export async function setFormat(opts: SetFormatOptions): Promise<SetFormatResult> {
  if (!native) return { applied: false, reason: 'module-unavailable' };
  return native.setFormat(opts);
}

export async function setVideoStabilizationMode(mode: StabilizationModeSetting): Promise<StabilizationResult> {
  if (!native) return { applied: false, reason: 'module-unavailable' };
  return native.setVideoStabilizationMode(mode);
}

/** Explicit HDR, not the system default (spec §14). */
export async function setHDREnabled(enabled: boolean): Promise<HDRResult> {
  if (!native) return { applied: false, reason: 'module-unavailable' };
  return native.setHDREnabled(enabled);
}

/** Capability inventory for the UI. Module absence returns null. */
export async function capabilities(): Promise<ExhibitCameraCapabilities | null> {
  if (!native) return null;
  return native.capabilities();
}

// ---- wave-7 isolation debug flags ----

/**
 * Wave-7 isolation switches, in the native UserDefaults suite
 * "exhibit.debug" and persisted across relaunches. A flipped flag takes
 * effect at the next configureSession, since photo connections and policies
 * are constructed at session build; the running session is unaffected.
 */
export type ExhibitDebugFlagKey =
  | 'photoConnectionRotation'
  | 'photoMaxDimensionsPolicy'
  | 'depthCapture'
  | 'thirdViewEnabled'
  | 'legacyMultiInputGraph';

export interface ExhibitDebugFlags {
  photoConnectionRotation: boolean;
  photoMaxDimensionsPolicy: boolean;
  /** Returned by getDebugFlags; absent on older builds, where consumers
   * default them off. */
  depthCapture?: boolean;
  /** Untested third-view extension-point gate. Off by default, must stay
   * off in shipping builds, and has no settings row. */
  thirdViewEnabled?: boolean;
  /** A/B switch: on runs the two-device-input rear-stereo graph, off (the
   * default) runs the dual-wide virtual-device graph — one input,
   * constituent ports, hardware-synced. The legacy graph delivered zero
   * secondary frames on iPhone 17 with no error callback, which is why the
   * virtual-device graph is the default. Takes effect at the next
   * configureSession. */
  legacyMultiInputGraph?: boolean;
}

interface SetDebugFlagResult {
  applied: boolean;
  key?: string;
  value?: boolean;
  /** 'unknown-key', with acceptedKeys, when the key is not recognized. */
  reason?: string;
  acceptedKeys?: string[];
}

/**
 * Flip one isolation flag. A missing module or a build without the method
 * returns applied:false rather than throwing into a settings toggle.
 */
export async function setExhibitDebugFlag(
  key: ExhibitDebugFlagKey,
  value: boolean
): Promise<{ applied: boolean; reason?: string }> {
  if (!native || typeof native.setDebugFlag !== 'function') {
    return { applied: false, reason: 'module-unavailable' };
  }
  const res = await native.setDebugFlag(key, value);
  return { applied: res.applied, reason: res.reason };
}

/** Current flag states. Module absence returns the native defaults: the
 * 12 MP clamp true, the other flags false. */
export async function getExhibitDebugFlags(): Promise<ExhibitDebugFlags> {
  if (!native || typeof native.getDebugFlags !== 'function') {
    return { photoConnectionRotation: false, photoMaxDimensionsPolicy: true };
  }
  return native.getDebugFlags();
}

// ---------------------------------------------------------------------------
// The native preview view (spec §2)
// ---------------------------------------------------------------------------

export interface ExhibitCameraPreviewProps {
  lens?: ExhibitLens;
  torch?: ExhibitTorch;
  /** 1.0 is no zoom; clamped natively to the device's supported range. */
  zoom?: number;
  /**
   * Alt-view PiP: with a second camera attached, its live feed renders in a
   * corner inset, bound natively to the secondary input's video port so the
   * inset shows what the evidence pipeline sees. No partner, no inset.
   */
  altPreview?: boolean;
  onPreviewReady?: (event: { nativeEvent: PreviewReadyEvent }) => void;
  style?: unknown;
}

/**
 * The native preview component. Grid and level are JS overlays drawn over
 * this view (spec §3) and are never in the committed pixels.
 *
 * Loosely typed at the native boundary: requireNativeViewManager's prop
 * typing happens at runtime, and the interface above is the contract.
 */
export const ExhibitCameraPreview: ComponentType<ExhibitCameraPreviewProps> | null =
  Platform.OS === 'ios' && native
    ? requireNativeViewManager<ExhibitCameraPreviewProps>('ExhibitCamera')
    : null;

// ---------------------------------------------------------------------------
// Event subscriptions (each returns its unsubscribe function)
// ---------------------------------------------------------------------------

export function onSessionError(cb: (e: ExhibitCameraErrorEvent) => void): () => void {
  const sub = getEmitter()?.addListener('onSessionError', cb);
  return () => sub?.remove();
}

export function onHardwarePressure(cb: (e: HardwarePressureEvent) => void): () => void {
  const sub = getEmitter()?.addListener('onHardwarePressure', cb);
  return () => sub?.remove();
}

export function onStereoPairCaptured(cb: (e: StereoPairCapturedEvent) => void): () => void {
  const sub = getEmitter()?.addListener('onStereoPairCaptured', cb);
  return () => sub?.remove();
}

export function onAdjustingFocus(cb: (e: AdjustingFocusEvent) => void): () => void {
  const sub = getEmitter()?.addListener('onAdjustingFocus', cb);
  return () => sub?.remove();
}

export function onSyncStalled(cb: (e: SyncStalledEvent) => void): () => void {
  const sub = getEmitter()?.addListener('onSyncStalled', cb);
  return () => sub?.remove();
}

/** Native pipeline diagnostics: one-line facts — graph wiring outcomes,
 * format picks, the live connection census, interruption boundaries.
 * Forwarded to the persistent diagnostics log; never throws. */
export interface CameraDiagnosticEvent {
  message: string;
}

export function onCameraDiagnostic(cb: (e: CameraDiagnosticEvent) => void): () => void {
  const sub = getEmitter()?.addListener('onCameraDiagnostic', cb);
  return () => sub?.remove();
}

// UNBUILT — rides EAS build 2; validated by on-device soak checklist, not CI.
/**
 * Bridge to the native ExhibitCamera module (modules/exhibit-camera) — the
 * app's ONE camera session: native preview, chrome, synchronized stereo
 * pair capture with committed calibration + timestamps + metadata, periodic
 * stereo pairs during video, and true Bayer RAW opt-in.
 *
 * The camera commits, it never concludes (Spec-Camera-Module-0.13): this
 * module emits commit inputs, never computed answers. Absent on web,
 * Android, simulators, or old builds — callers check
 * `isExhibitCameraAvailable` first; the fallback path is stated, never
 * faked.
 *
 * Honesty vocabulary used throughout:
 *  - 'unsupported' hardware = UNREACHED — gray, informative, never red.
 *  - absence is stated, never suspicion.
 *  - nothing here is a verdict; signals carry their bounds in their text.
 *
 * No network I/O.
 */

import { Platform } from 'react-native';
import { requireNativeModule, requireNativeViewManager, EventEmitter } from 'expo-modules-core';
import type { ComponentType } from 'react';

// ---------------------------------------------------------------------------
// Enums / literals
// ---------------------------------------------------------------------------

/** Physical lens stack selection — genuine optical devices, never a crop. */
export type ExhibitLens = 'ultraWide' | 'wide' | 'telephoto';
export type ExhibitFacing = 'back' | 'front';
export type ExhibitTorch = 'off' | 'on';

/**
 * Photo-strobe preference (W2.2): AVCapturePhotoSettings.flashMode on the
 * photo output for stills. Distinct from ExhibitTorch — the torch is the
 * video-only continuous light and is never driven by this preference.
 */
export type PhotoFlashMode = 'auto' | 'on' | 'off';

/**
 * Hardware probe result (spec §7). 'unsupported' and 'unreached' share one
 * visual treatment (gray, informative): unreached is not suspicion.
 *  - 'available'   — multicam + both back devices + permission granted
 *  - 'unsupported' — this device cannot do stereo (unreached, never red)
 *  - 'unreached'   — not probed / no permission / module absent
 */
export type StereoAvailability = 'available' | 'unsupported' | 'unreached';

/**
 * Per-session stereo state: adds 'degraded-thermal' — a stated mid-session
 * event (thermal policy detached the secondary, spec §6), distinct from
 * both 'available' and the never-red 'unsupported'.
 */
export type StereoSessionState = 'available' | 'degraded-thermal' | 'unsupported';

/**
 * Three-state result of the capture's IMU (accel+gyro) sink — the same
 * honesty vocabulary as the audio module's SensorLogState (media parity).
 * Own copy: this library stays self-contained, like the Swift pods.
 */
export type SensorLogState =
  /** The JSONL exists at sensorLogPath and covers the capture window. */
  | 'recorded'
  /** The sink was requested but failed (write error) — stated as a failure, never hidden. */
  | 'failed'
  /** No IMU on this device, thermal pressure parked the sink, or no log was
   * requested — nothing was ever going to be recorded. */
  | 'unavailable';

/**
 * IMU evidence-sink fields carried by BOTH photo and video results (native
 * 0.15+; frozen contract). The JSONL file uses the CaptureKit SensorLogger
 * line format: accel+gyro at the 100 Hz target sliced from a 60 s ring —
 * [-2 s, +0.5 s] around the shutter for a still, the recording window
 * (tail-truncated beyond 60 s, stated in the file's `window` line) for
 * video. A failed or absent log NEVER blocks the capture.
 *
 * All fields are ABSENT (undefined) on pre-0.15 native builds — callers
 * map undefined to 'never-recorded', exactly like the audio sink.
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
 * Every artifact the module commits reports exactly one of three states.
 * There is no silent middle state:
 *  - { state: 'path', path }               — the file exists on disk
 *  - { state: 'error', code, message }     — attempted, failed; stated
 *  - { state: 'never-recorded', reason }   — not attempted (toggle off,
 *                                            unsupported hardware, not
 *                                            requested); unreached, never red
 * All paths are PLAIN filesystem paths (url.path), never file:// URIs.
 */
export type EvidencePath =
  | { state: 'path'; path: string }
  | { state: 'error'; code: ExhibitCameraErrorCode; message: string }
  | { state: 'never-recorded'; reason: string };

/**
 * Maps an EvidencePath onto the store's sink-state vocabulary. Returns the
 * path when recorded; otherwise a compact, display-safe explanation. The
 * caller records 'never-recorded' vs 'enabled-but-failed' distinctly —
 * they are different facts (rule 4b).
 */
export function describeEvidencePath(
  ep: EvidencePath,
): { recorded: true; path: string } | { recorded: false; state: 'error' | 'never-recorded'; detail: string } {
  if (ep.state === 'path') return { recorded: true, path: ep.path };
  if (ep.state === 'error') return { recorded: false, state: 'error', detail: `${ep.code}: ${ep.message}` };
  return { recorded: false, state: 'never-recorded', detail: ep.reason };
}

// ---------------------------------------------------------------------------
// Committed blocks (spec §4.2 / §5 — inputs, never computed answers)
// ---------------------------------------------------------------------------

/** Anti-banding state: region-derived, NEVER measured flicker (iOS has no
 * flicker query API). The literal note is part of the contract. */
export interface ExhibitAntiBanding {
  mainsHz: 50 | 60;
  exposureSec: number | null;
  note: 'region-derived';
}

/**
 * Per-device camera metadata block. Every field is literally true or an
 * explicit null. Nothing here says what the scene WAS.
 *
 * The pro-control fields (spec §14) are DEVICE-REPORTED applied values —
 * manual decisions become signed evidence — and are labeled via
 * `controlsReportedBy: 'device'`. Device enums are emitted both mapped
 * (stable string) and raw (Int) so nothing is lost in translation. Note:
 * the device cannot distinguish 'locked' from 'manual' for focus/WB —
 * both report 'locked'; the manual intent is visible via lensPosition /
 * whiteBalanceTemperatureTint alongside the locked mode.
 */
export interface CameraMetadataBlock {
  /** AVCaptureDevice.DeviceType raw value — which physical device fired. */
  physicalDevice: string;
  modelID: string;
  // ---- pro controls (spec §14): ACTUAL applied values, device-reported ----
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
  /** Only when the device reports WB mode-locked: temperature/tint
   * computed FROM device-reported gains via the OS converter. */
  whiteBalanceTemperatureTint: { temperature: number; tint: number; note: string } | null;
  /** 0 when off; null on devices with no torch hardware. */
  torchLevel: number | null;
  /** "<deviceType.rawValue>:<index>" — stable per device model + OS. */
  formatID: string | null;
  /** Connection read-back: 'off' | 'standard' | 'cinematic' | 'auto'. */
  stabilizationMode: string | null;
  /** Connection read-back; null when the active format has no HDR. */
  hdrEnabled: boolean | null;
  /** Literal label: every pro-control field is read back from the device
   * or connection, never from the module's request log. */
  controlsReportedBy: 'device';
  /**
   * ALWAYS null: iOS exposes no public focus-distance-in-meters API.
   * Stated, never fabricated from lensPosition.
   */
  focusDistanceMeters: null;
  /** Pixel focal lengths from committed calibration; null when absent. */
  focalLengthPixels: { fx: number; fy: number } | null;
  fieldOfViewDegrees: number;
  apertureFNumber: number;
  antiBanding: ExhibitAntiBanding;
  activeFormat: { width: number; height: number; fps: number };
  /** session.hardwareCost at capture time — committed so later thermal
   * disputes have a number. */
  hardwareCost: number;
  /** Inter-frame PTS delta — the sync measurement, uninterpreted. */
  synchronizedDeltaMs: number | null;
  droppedPairCount: number;
  /** Every iOS frame passes the platform's computational pipeline; stated
   * so no manifest implies "unprocessed sensor data" for a JPEG (§10). */
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
  /** Which path produced which numbers — the desk distinguishes per-frame
   * from session-fixed, full from intrinsics-only. */
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
// Committed capture settings (W2.4 — device read-backs at the commit instant)
// ---------------------------------------------------------------------------

/**
 * White-balance temperature/tint computed by the OS's OWN converter from
 * the device-reported gains (temperatureAndTintValues(for:)) — never our
 * estimate. Transient unless the device reports WB mode-locked; the note
 * states this verbatim.
 */
export interface WhiteBalanceTemperatureTint {
  temperature: number;
  tint: number;
  note: string;
}

/**
 * The full camera state committed at shutter time. Every value traces to
 * an actual AVCaptureDevice / AVCapturePhotoOutput read at commit time —
 * `controlsReportedBy: 'device'` — or is an explicit null stating absence.
 * Nothing is synthesized; in particular `photoExif` carries ONLY the EXIF
 * numbers the OS itself wrote into the full-res photo's metadata (null
 * when no full-res photo ran this shutter), and `flashFired` comes from
 * that same metadata (null = no photo strobe capture happened — no strobe
 * claim at all).
 */
export interface CaptureSettings {
  /** Honesty note: the DELIVERY still's pixels are a video-frame encode at
   * session resolution — resampled, not a full-sensor readout. The
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
  /** AVCaptureDevice.DeviceType raw value — the lens stack in use. */
  physicalDevice: string;
  /** The strobe preference written into the photo settings (W2.2). */
  photoFlashMode: PhotoFlashMode;
  photoFlashHardware: boolean;
  /** Device-reported supported flash modes ([] = unknown, no session). */
  photoFlashSupportedModes: string[];
  /** null = no full-res photo ran (or its metadata carried no Flash tag) —
   * stated, never inferred. */
  flashFired: boolean | null;
  /** EXIF numbers exactly as the OS wrote them into the full-res photo
   * (ISOSpeedRatings, ExposureTime, FNumber, ExposureBiasValue, FocalLength,
   * FocalLengthIn35mmFilm, Flash, WhiteBalance — subset; absent tags are
   * absent). null when no full-res photo ran. NEVER synthesized. */
  photoExif: Record<string, number> | null;
  /** What the strobe request became on the photo output. */
  photoFlashApplied?: {
    requested: PhotoFlashMode;
    /** false = the requested mode was not in supportedFlashModes; the
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
  /** IMU evidence sink (native 0.15+): when true, accel+gyro stream into a
   * 60 s ring for the session so stills and video commit a signed sensor
   * log (sensorLog* fields on the results). Default false. Older native
   * builds ignore the flag and omit the fields — stated via absence. */
  sensorLog?: boolean;
  /** Shutter-burst sink (newer native builds): when true, each still commits the
   * 3 pre-shutter + 4 post-shutter frames it was cut from into
   * evidenceDir/ring-<captureId>/ (ringBufferDir + ringFrameCount on the
   * result). A sink failure is an 'error' EvidencePath state — the capture
   * itself never rejects for the burst. Default false. Older builds ignore
   * the flag and omit the fields. */
  ring?: boolean;
  /** Selectable stereo partner stack (newer native builds): 'auto' (default —
   * the UW↔W/T pairing) or an explicit rear stack. Applies at session
   * build; live swaps go through setSecondaryLens. Older builds ignore
   * the flag. */
  secondaryLens?: SecondaryLensPreference;
}

/** The selectable secondary stack vocabulary. 'auto' = the
 * native UW↔W/T pairing chosen by the primary lens. */
export type SecondaryLensPreference = 'auto' | 'ultraWide' | 'wide' | 'telephoto';

export interface SessionStart {
  sessionId: string;
  startedAtMs: number;
  /** 'available' | 'unsupported' at session start (never 'unreached' —
   * the session started, so the probe ran). */
  stereo: 'available' | 'unsupported';
  hardwareCost: number | null;
  /** (additive; absent on older builds): which rear-stereo graph the
   * session runs — 'virtual-dual-wide' (one input, constituent ports,
   * hardware-synced; the default) or 'multi-input' (two device
   * inputs, the pre-graph, restorable via Diagnostics A/B). */
  graph?: 'virtual-dual-wide' | 'multi-input';
}

export interface CaptureOptions {
  /** file:// or plain path for the delivery still (primary, full res). */
  deliveryPath: string;
  /** Directory for secondary/calibration/timestamps/metadata/RAW. */
  evidenceDir: string;
  /** True Bayer RAW opt-in (spec §9). ProRAW is NOT this path — ProRAW is
   * computationally processed by the platform. */
  raw?: boolean;
}

/**
 * The native depth artifact's committed facts (D1,). Every field is
 * a capture-side claim, verbatim — nothing is derived JS-side. The artifact
 * is a 16-bit grayscale PNG, min/max-normalized over
 * [normalizationMin, normalizationMax]; non-finite pixels were written as 0
 * and counted. accuracy/accuracyRaw/note/cameraCalibration are typed
 * unknown — their Swift-side types weren't stated in the contract review;
 * consumers pass them through, never interpret.
 */
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
  /** True Bayer RAW DNG — 'never-recorded' with reason 'not-requested' or
   * 'raw-unsupported' when absent. Both are gray states, never red. */
  rawDng: EvidencePath;
  synchronizedDeltaMs: number | null;
  droppedPairCount: number;
  hardwareCost: number | null;
  physicalDevices: { primary: string | null; secondary: string | null };
  // ---- W2.1: full-sensor stills (additive; ABSENT on pre-W2 native
  // builds — callers treat undefined as "not committed this capture") ----
  /** Full-sensor-resolution JPEG from the primary photo output. Distinct
   * from deliveryPath, whose pixels are a video-frame encode (see
   * captureSettings.deliveryStillSource). 'never-recorded' in video mode
   * or without a photo output; 'error' states the failure verbatim. */
  fullResStill?: EvidencePath;
  /** SHA-256 (hex) of the exact fullResStill bytes on disk; null when the
   * artifact is not in the 'path' state. */
  fullResStillSha256?: string | null;
  /** Resolved photo dimensions (iOS 16+); null when unavailable. */
  fullResStillDimensions?: { width: number; height: number } | null;
  /** Stereo partner's full-sensor still — 'never-recorded' with the same
   * reason vocabulary as secondaryFrame when stereo is off/detached. */
  fullResSecondary?: EvidencePath;
  fullResSecondarySha256?: string | null;
  fullResSecondaryDimensions?: { width: number; height: number } | null;
  // ---- W2.4: every camera setting, device-read at the commit instant ----
  /** The committed settings block. The { unavailable: true } shape is the
   * honest degradation when the session died mid-capture (the device
   * reference was gone at commit time) — stated, never omitted silently. */
  captureSettings?: CaptureSettings | { unavailable: true; note: string };
  // ---- degraded single-lens fallback + mirroring truth (additive;
  // ABSENT on pre-native builds — callers treat undefined as "not
  // committed this capture") ----
  /** Stereo evidence state for THIS capture: 'ok' = a synchronized
   * secondary frame was committed; 'unavailable' = the capture degraded —
   * no fresh synchronized pair at shutter (single-lens fallback: the
   * delivery still is the photo output's full-sensor still) or the
   * secondary half dropped at shutter — stereoUnavailableReason states why,
   * verbatim. Absent on single-cam sessions (the `stereo` capability
   * string already says unsupported) and pre-builds. */
  stereoStatus?: 'ok' | 'unavailable';
  /** Machine-checkable reason when stereoStatus is 'unavailable' — e.g.
   * 'no fresh synchronized frame within 900ms at shutter (dropped pairs:
   * N, …)'. A fact, never a euphemism. */
  stereoUnavailableReason?: string;
  /** The primary connection's ACTUAL mirroring state at capture. Preview
   * layers auto-mirror the front camera; data/photo outputs do NOT — the
   * native side sets it explicitly (front mirrors, so evidence matches the
   * preview the user composed on) and commits the read-back value. null
   * when no connection existed to read. */
  frontMirrored?: boolean | null;
  // ---- D1: depth artifacts (additive; ABSENT on pre-D1 native
  // builds AND on some early-exit branches — callers treat undefined as
  // "not committed this capture") ----
  /** Primary photo output's depth map: 16-bit grayscale PNG, min/max-
   * normalized with the window committed in fullResStillDepthMetadata.
   * 'never-recorded' reasons: depth-disabled / depth-unsupported /
   * depth-not-delivered / photo-capture-failed / photo-write-failed. */
  fullResStillDepth?: EvidencePath;
  /** SHA-256 (hex) of the exact depth bytes on disk; ABSENT (not null) on
   * some early-exit branches — undefined means "not committed". */
  fullResStillDepthSha256?: string | null;
  fullResStillDepthMetadata?: DepthArtifactMetadata | null;
  /** Stereo partner's depth map — same vocabulary. */
  fullResSecondaryDepth?: EvidencePath;
  fullResSecondaryDepthSha256?: string | null;
  fullResSecondaryDepthMetadata?: DepthArtifactMetadata | null;
  /** Degraded (video-frame) path's depth map — same vocabulary. */
  depth?: EvidencePath;
  depthSha256?: string | null;
  depthMetadata?: DepthArtifactMetadata | null;
  // ---- shutter-burst sink (additive; ABSENT on pre-builds
  // and on sessions configured without `ring` — callers treat undefined as
  // "not committed this capture") ----
  /** Directory holding the 3 pre-shutter + 4 post-shutter frames the
   * delivery still was cut from, plus a JSON index. 'never-recorded'
   * reasons: not-requested / no-synchronized-pair-at-shutter /
   * not-available-during-video-recording; 'error' states a sink failure
   * verbatim (the capture still succeeded — the burst is evidence-only). */
  ringBufferDir?: EvidencePath;
  /** Frames actually committed into ringBufferDir (0 on the
   * never-recorded/error states). */
  ringFrameCount?: number;
}

export interface StartVideoOptions {
  deliveryPath: string;
  evidenceDir: string;
  /** Seconds between committed stereo pairs (spec §8). Default 5, min 2.
   * Periodic pairs, not continuous — thermal/power headroom is real, and
   * a burst of timestamped pairs is enough geometry. */
  pairIntervalSec?: number;
  /** Raw-audio-master sink (settings toggle → startVideo): tee the mic
   * buffers to an LPCM mono 16 kHz 16-bit CAF in the evidence dir while
   * the delivery writer consumes the same native buffers (rule 4 tee —
   * a sink failure never touches delivery). Default false. */
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
  /** false = the delivery file has no audio track (mic never delivered) —
   * a structural fact, stated. Never a silently missing track. */
  audioTrack: boolean;
  pairsCommitted: number;
  pairsMissed: number;
  /** Raw-audio-master sink, three states carried by the seal record:
   * string path = recorded; null = enabled but failed. The disabled case
   * never arrives here — the caller owns the toggle and states
   * 'never-recorded' itself. */
  rawPcmPath: string | null;
  /** ENF anchor + integrity summary for the committed master (* present only when rawPcmPath is a string). firstSampleWallClockUtcMs
   * anchors the first WRITTEN sample to wall clock (mach-PTS → wall, or
   * the append instant — firstSampleAnchor states which, verbatim), so a
   * desk can cross-correlate the 50/60 Hz mains trace against a reference
   * ENF series in absolute time. fileSha256 binds the analysis to the
   * exact committed bytes. All nullable fields are stated null, never
   * omitted. */
  rawPcmInfo?: {
    firstSampleWallClockUtcMs: number | null;
    firstSampleAnchor: string | null;
    sampleCount: number;
    sampleRate: number;
    fileSha256: string | null;
  } | null;
  /** Audio tap liveness counter for the take. 0 while
   * the master was requested = the tap never delivered — an audio-session/
   * permission fact, stated, not a conversion failure. */
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
 * Fired ONCE per session when the frame pipeline stalls (preview keeps
 * painting but synchronized frames stop) AND a cheap synchronizer rebind
 * did not recover it. The honest response is a session rebuild — the
 * capture screen's lifecycle effect owns configure/stop.
 */
export interface SyncStalledEvent {
  ageSeconds: number;
  droppedPairCount: number;
  droppedPrimaryCount?: number;
  droppedSecondaryHalfCount?: number;
  /** diagnostics split (additive; absent on older builds):
   * secondary-absent = synchronizer returned NO secondary data object;
   * secondary-dropped = an object was present but failed the sync window;
   * complete-pairs / stale-shutters / reseat state isolate a dead
   * secondary stream from shutter-timing rejection. */
  secondaryAbsentCount?: number;
  secondaryDroppedCount?: number;
  completePairCount?: number;
  staleShutterCount?: number;
  secondaryReseatDone?: boolean;
}

/** Preview-readiness (view event). `signal` states WHICH readiness signal
 * fired — never an ambiguous "ready". */
export interface PreviewReadyEvent {
  signal: 'first-synchronized-frame' | string;
}

// ---------------------------------------------------------------------------
// Chrome result payloads (all honest no-ops when hardware lacks support)
// ---------------------------------------------------------------------------

export interface ChromeResult {
  applied: boolean;
  reason?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Pro controls (spec §14). Every setter no-ops safely ({ applied: false,
// reason }) on hardware lacking the capability — they never throw into JS
// for capability absence. Availability comes from capabilities.
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
  /** Requested-clamped values (custom mode). The device-SETTLED values
   * are committed per capture in the metadata block, device-reported. */
  iso?: number;
  durationSeconds?: number;
  isoClamped?: boolean;
  durationClamped?: boolean;
}

export interface SetFocusModeOptions {
  mode: FocusModeSetting;
  /** Required when mode === 'manual'. Unitless, 0–1, clamped. iOS has no
   * focus-distance API — lensPosition is the honest manual control. */
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
  /** Round-tripped temperature/tint of the CLAMPED gains — what the
   * hardware actually accepted. */
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
  /** "<deviceType.rawValue>:<index>" — stable per device model + OS. */
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
  /** null = unknown without a running session — NOT unsupported. */
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
  /** Device format feeds both paths — always 'photo-and-video'. */
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

/** Photo-strobe preference result (W2.2). */
export interface PhotoFlashResult extends ChromeResult {
  photoFlash?: PhotoFlashMode;
  /** Strobe hardware present on the active device. */
  hasFlash?: boolean;
  /** Device-reported supported modes; [] = unknown without a session. */
  supportedModes?: string[];
  note?: string;
}

/** Zoom-ramp result (W2.3): ramp(toVideoZoomFactor:withRate:). */
export interface ZoomSmoothResult extends ChromeResult {
  zoomFactor?: number;
  clamped?: boolean;
  /** The rate actually used (clamped natively to [1, 60]). */
  rate?: number;
}

/**
 * Per-constituent-device zoom ceilings (W2.3). `qualityCap` is a
 * conservative APP-CHOSEN digital-quality ceiling — NOT a hardware limit
 * (see zoomQualityNote); `hardwareMax` is the device's own
 * maxAvailableVideoZoomFactor. Absent lenses are omitted entirely.
 */
export interface LensZoomCap {
  lens: ExhibitLens;
  deviceType: string;
  hardwareMax: number;
  qualityCap: number;
}

/**
 * The active device's zoom contract. min/max are the device's own
 * supported range (unchanged hardware semantics). The W2.3 additions are
 * optional — ABSENT on pre-W2 native builds:
 *  - qualityCap: app-chosen digital-quality ceiling for THIS device (a
 *    quality choice, not a hardware limit); the UI clamps to
 *    min(max, qualityCap).
 *  - switchOverFactors: the containing virtual device's
 *    virtualDeviceSwitchOverVideoZoomFactors — the exact hardware hand-off
 *    points the UI's optical stops should match.
 */
export interface ZoomRange {
  min: number;
  max: number;
  qualityCap?: number;
  switchOverFactors?: number[];
}

/**
 * What this hardware can do — the UI hides controls that report false.
 * null fields mean "unknown without a session" (stated, never guessed);
 * absent lenses in listFormats report present:false (unreached, never
 * red).
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
  /** W2.3: per-constituent-device ceilings; absent on pre-W2 builds. */
  lensZoomCaps?: LensZoomCap[];
  /** W2.3: states verbatim that qualityCap is a quality choice, not a
   * hardware limit. Part of the contract. */
  zoomQualityNote?: string;
  /** (additive): the selectable secondary stack — every rear stack
   * present on this hardware in the bridge's lens vocabulary, and the
   * current preference ('auto' when unset). */
  secondaryLensOptions?: string[];
  secondaryLens?: string;
  /** hardware probe for an opportunistic third synchronized view.
   * The view itself is gated behind the thirdViewEnabled debug flag
   * (UNTESTED ON HARDWARE — off by default); this only states what the
   * hardware could do. */
  thirdViewCapable?: boolean;
}

/** KVO-driven focus-settling signal (spec §14). The UI should avoid
 * capturing while adjusting is true. */
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
 * Graceful absence (simulator / web / Android / older builds): when false,
 * callers use the fallback path and stereoAvailability reports
 * 'unreached' — disclosed, never faked, never red.
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
 * Hardware probe; starts nothing. Module absence maps to 'unreached' —
 * the same gray treatment as 'unsupported', because unreached is not
 * suspicion (spec §7).
 */
export async function stereoAvailability(): Promise<StereoAvailability> {
  if (!native) return 'unreached';
  return native.stereoAvailability();
}

/** Starts the one session (preview mode). Watchdog: rejects after 10 s
 * without frames — never hangs the UI. */
export async function configureSession(opts: ConfigureSessionOptions): Promise<SessionStart> {
  if (!native) throw new Error('ExhibitCamera module unavailable');
  return native.configureSession(opts);
}

export async function stopSession(): Promise<{ stopped: boolean; reason?: string }> {
  if (!native) return { stopped: false, reason: 'module-unavailable' };
  return native.stopSession();
}

/**
 * Stereo pair capture (spec §4/§5). The delivery still always lands or the
 * call rejects; every evidence artifact is a three-state EvidencePath.
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
 * Selectable stereo partner: 'auto' restores the native UW↔W/T
 * pairing; an explicit rear stack (e.g. 'telephoto' on a triple-lens Pro)
 * pins the partner. Applies live on a running back session, else stored
 * for the next configureSession. A conflict with the primary lens or an
 * absent stack resolves applied:false with a stated reason — the partner
 * never swaps silently. Older native builds lack the method entirely:
 * reported applied:false, never a thrown wedge.
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
 * Ramped device zoom (W2.3): ramp(toVideoZoomFactor:withRate:) for
 * UI-driven scrub ramps. Lens jumps stay on the instant setZoom. `rate`
 * defaults to 8 (the pre-W2 ramp rate) and is clamped natively to [1, 60].
 * On pre-W2 native builds the function is absent — the caller's fallback
 * is setZoom (an instant set is a degenerate ramp).
 */
export async function setZoomSmooth(factor: number, rate = 8): Promise<ZoomSmoothResult> {
  if (!native) return { applied: false, reason: 'module-unavailable' };
  if (typeof native.setZoomSmooth !== 'function') {
    return native.setZoom(factor);
  }
  return native.setZoomSmooth(factor, rate);
}

/**
 * Photo-strobe preference (W2.2): sets the flashMode used by the photo
 * output's stills captures. Torch is untouched — it stays the video-only
 * continuous light. No session required: the preference persists natively
 * and is validated against supportedFlashModes at capture time. On pre-W2
 * native builds: honest no-op.
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
// All no-op safely ({ applied: false, reason }) when the module or the
// hardware capability is absent. Check capabilities first to hide
// controls the device doesn't have.

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

/** Torch with level: null → off; clamped to maxTorchLevel natively. */
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

/** Explicit HDR — never a silent system default (spec §14). */
export async function setHDREnabled(enabled: boolean): Promise<HDRResult> {
  if (!native) return { applied: false, reason: 'module-unavailable' };
  return native.setHDREnabled(enabled);
}

/** Capability inventory for the UI. Module absence → null (unreached). */
export async function capabilities(): Promise<ExhibitCameraCapabilities | null> {
  if (!native) return null;
  return native.capabilities();
}

// ---- diagnostic debug flags ----

/**
 * Wave-7 isolation switches (native UserDefaults suite "exhibit.debug",
 * BOTH DEFAULT FALSE, persisted across relaunches). A flipped flag takes
 * effect at the NEXT configureSession — photo connections and policies
 * are constructed at session build, so the already-running session is
 * unaffected. Settings states this honestly beside the switches.
 */
export type ExhibitDebugFlagKey =
  | 'photoConnectionRotation'
  | 'photoMaxDimensionsPolicy'
  | 'depthCapture'
  | 'sessionCalibrationPhoto'
  | 'thirdViewEnabled'
  | 'legacyMultiInputGraph';

export interface ExhibitDebugFlags {
  photoConnectionRotation: boolean;
  photoMaxDimensionsPolicy: boolean;
  /** keys (native returns them from getDebugFlags; absent on older
   * builds — consumers default them off). */
  depthCapture?: boolean;
  /** The session-calibration dual-photo one-shot. Off by default: a photo
   * capture can leave the secondary video output unwilling to deliver.
   * Takes effect at the next configureSession. */
  sessionCalibrationPhoto?: boolean;
  /** UNTESTED third-view extension-point gate. OFF by default; MUST stay
   * off in shipping builds. Intentionally has no settings row. */
  thirdViewEnabled?: boolean;
  /** A/B: ON restores the pre-two-device-input rear-stereo
   * graph. OFF (default) runs the dual-wide virtual-device graph — one
   * input, constituent ports, hardware-synced — the fix path for the
   * iPhone 17 dead-secondary-stream failure. Takes effect at the next
   * configureSession. */
  legacyMultiInputGraph?: boolean;
}

interface SetDebugFlagResult {
  applied: boolean;
  key?: string;
  value?: boolean;
  /** 'unknown-key' (with acceptedKeys) when the key isn't one of the two. */
  reason?: string;
  acceptedKeys?: string[];
}

/**
 * Flip one isolation flag. Graceful absence like the other chrome setters:
 * a missing module, or an older build without the method, reports
 * applied:false — never a thrown wedge into a settings toggle.
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

/** Current flag states. Module absence = the native defaults (the
 * 12 MP clamp defaults TRUE; the other flags default false). */
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
  /** 1.0 = no zoom; clamped natively to the device's supported range. */
  zoom?: number;
  /**
   * Alt-view PiP (transparency): when true AND a second camera is actually
   * attached, its live feed renders in a corner inset — bound natively to
   * the secondary input's video port, so the inset shows exactly what the
   * evidence pipeline sees. No partner, no feed (never a fabricated inset).
   */
  altPreview?: boolean;
  onPreviewReady?: (event: { nativeEvent: PreviewReadyEvent }) => void;
  style?: unknown;
}

/**
 * The native preview component. Grid and level are JS overlays drawn over
 * this view (spec §3) — they are never in the committed pixels.
 *
 * Typed loosely at the native boundary: requireNativeViewManager's prop
 * typing happens at runtime; the interface above is the contract.
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

/** Native pipeline diagnostics: verbatim one-line facts — graph
 * wiring outcomes, format picks, the live connection census, interruption
 * boundaries. Forwarded to the persistent diagnostics log; never errors. */
export interface CameraDiagnosticEvent {
  message: string;
}

export function onCameraDiagnostic(cb: (e: CameraDiagnosticEvent) => void): () => void {
  const sub = getEmitter()?.addListener('onCameraDiagnostic', cb);
  return () => sub?.remove();
}

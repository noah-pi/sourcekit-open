// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Capture — the cryptographic camera.
 *
 * Pipeline, entirely on-device:
 *   shutter → sensor context snapshot → SHA-256 → ECDSA sign →
 *   C2PA embed (JPEG APP11 / BMFF uuid box) → AES-GCM vault.
 *
 * No network call in this file.
 */

import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Animated,
  Platform,
  PanResponder,
  ScrollView,
  Linking,
  type GestureResponderEvent,
  type TextStyle,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { DeviceMotion } from 'expo-sensors';
import * as Haptics from 'expo-haptics';
import * as FileSystem from 'expo-file-system/legacy';
import * as LocalAuthentication from 'expo-local-authentication';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { BlurView } from 'expo-blur';
import { useFocusEffect, useRouter } from 'expo-router';

import { colors, spacing, radii, type, fontSize, useThemedStyles, useEffectiveScheme } from '../../src/theme';
import { useStore } from '../../src/store/useStore';
import { collectContext, requestCapturePermissions } from '../../src/sensors/context';
import { type PoseSample } from '../../src/sensors/motion';
import { enqueuePhotoSeal, enqueueVideoSeal, enqueueAudioSeal, resumeSealQueue, subscribeSeals, subscribeSealCompletions } from '../../src/provenance/sealQueue';
import { logDiagnostic } from '../../src/lib/diagnosticsLog';
import { getDeviceKey } from '../../src/lib/deviceKey';
import { identityForCapture } from '../../src/lib/identity';
import {
  isExhibitCameraAvailable,
  requestExhibitCameraPermissions,
  configureSession,
  stopSession,
  capture,
  startVideo,
  stopVideo,
  setLens as setNativeLens,
  setZoom as setNativeZoom,
  setZoomSmooth as setNativeZoomSmooth,
  setPhotoFlashMode,
  setTorchLevel,
  setFocusPoint,
  setExposurePoint,
  setExposureBias,
  setExposureMode,
  setFocusMode,
  setWhiteBalanceMode,
  capabilities,
  listFormats,
  onSessionError,
  onHardwarePressure,
  onAdjustingFocus,
  onStereoPairCaptured,
  onSyncStalled,
  onCameraDiagnostic,
  ExhibitCameraPreview,
  type ExhibitLens,
  type StereoAvailability,
  type StereoPairCapturedEvent,
  type ExposureModeSetting,
  type FocusModeSetting,
  type WhiteBalanceModeSetting,
  type ExhibitCameraCapabilities,
  type ListFormatsResult,
  type SensorLogEvidence,
  type CaptureResult,
  type LensZoomCap,
} from '../../src/lib/exhibitCamera';
import { sanitizeExif } from '../../src/lib/exif';
import {
  audioCaptureAvailable,
  requestAudioPermissions,
  startCapture,
  stopCapture,
  onTranscript,
  onLevel,
  onInterrupted,
  onCaptureError,
  type AudioStopResult,
  type TranscriptionOffReason,
} from '../../src/lib/audioCapture';
import type { EventSubscription } from 'expo-modules-core';
import type { CaptureEvidencePaths, EvidencePath } from '../../src/provenance/manifest';
import { ValueRibbon, type RibbonConfig } from '../../src/components/camera/ValueRibbon';
import { classifyGesture, type GestureZone } from '../../src/components/camera/gestureClassify';
import { ZoomHud, ZoomWheel } from '../../src/components/camera/ZoomControl';
import { ModeSwitcher } from '../../src/components/camera/ModeSwitcher';
import { LiveChannel, type LiveZoom } from '../../src/components/camera/liveChannel';
import {
  buildStops,
  baseMmFromFov,
  clampZoom,
  factorForLens,
  stopFor,
  toDeviceFactor,
  firstOpticalFactor,
  stackZoomFloor,
  stackZoomCeiling,
  MAX_RELATIVE_ZOOM,
} from '../../src/components/camera/zoomModel';

/**
 * Signed-EXIF assembly. Standard EXIF tags from the capture's committed
 * settings, carried to the com.verify.exif assertion by the seal job.
 * Values come from the photo's own EXIF first, then AVCaptureDevice
 * read-backs for gaps; a field with no real value is omitted.
 * FocalLength and FocalLengthIn35mmFilm come only from the photo's own
 * metadata. sanitizeExif's closed allowlist is the final gate.
 */
function buildCaptureExif(cs: CaptureResult['captureSettings']): Record<string, number | string> | null {
  if (!cs || 'unavailable' in cs) return null;
  const raw: Record<string, number> = {};
  if (cs.photoExif) {
    for (const [k, v] of Object.entries(cs.photoExif)) {
      if (typeof v === 'number' && Number.isFinite(v)) raw[k] = v;
    }
  }
  if (raw.ISOSpeedRatings === undefined && Number.isFinite(cs.iso)) raw.ISOSpeedRatings = cs.iso;
  if (raw.ExposureTime === undefined && cs.exposureDurationSec !== null && Number.isFinite(cs.exposureDurationSec)) {
    raw.ExposureTime = cs.exposureDurationSec;
  }
  if (raw.FNumber === undefined && Number.isFinite(cs.apertureFNumber)) raw.FNumber = cs.apertureFNumber;
  if (raw.ExposureBiasValue === undefined && Number.isFinite(cs.exposureTargetBias)) raw.ExposureBiasValue = cs.exposureTargetBias;
  // EXIF WhiteBalance: 0 = auto, 1 = manual, mapped from the device-reported
  // mode ('locked' is manual-with-gains).
  if (raw.WhiteBalance === undefined) raw.WhiteBalance = cs.whiteBalanceMode === 'locked' ? 1 : 0;
  const exif = sanitizeExif(raw);
  return Object.keys(exif).length > 0 ? exif : null;
}

const BUFFER_LIMIT = 13000; // ~2.2 min at 100 Hz — covers a max-length video clip

// Video length cap (see toggleVideo): the seal path reads the whole file
// into memory for AES-GCM. The cap is stated to the user when it stops a take.
const MAX_VIDEO_SECONDS = 120;
const VIDEO_CAP_NOTICE =
  "Clips are capped at two minutes in this build: sealing currently reads the whole file into memory. The cap lifts when sealing moves native. It's a limit of this build, not of the evidence.";

// HUD color language, inlined here rather than in src/theme.ts. The
// identifying chips (Location, Byline) share a warm clay; the sage green is
// reserved for "locked and sealed". No pure yellow or blue in the HUD.
const HUD_IDENT_ON = '#C08552'; // clay/terracotta — the embedding chips
const HUD_SEAL_GREEN = '#809263'; // sage, matched to the aperture mark
const HUD_INK = '#0A0D10'; // label/icon ink on a filled ON pill

// Mode-transition veil. BlurView intensity is a plain prop, so the 380 ms
// pulse runs on the JS driver.
const AnimatedBlur = Animated.createAnimatedComponent(BlurView);

type Mode = 'audio' | 'picture' | 'video';

// ---------------------------------------------------------------------------
// Pro-param model. Every tray capsule and precision-bar session uses this
// shape. 'ladder' params (FLASH/FOCUS/WB) ride the bar as integer rung
// indices with a detent per rung; 'continuous' params (EV/ISO/SHTR) scrub
// their native range. Auto/manual is two-state: the AUTO pill on the bar.
// ---------------------------------------------------------------------------
type ProParamId = 'flash' | 'ev' | 'focus' | 'wb' | 'iso' | 'shtr';
interface ProParam {
  id: ProParamId;
  label: string;
  valueText: string;
  mode: 'auto' | 'manual';
  kind: 'ladder' | 'continuous';
  /** Set when another param holds the hardware (EV under manual ISO+shutter).
   *  The capsule stays, dimmed with value '—', and explains itself on tap. */
  overridden?: boolean;
}

/**
 * Maps the audio recorder's IMU-sink report onto the three-state
 * EvidencePath vocabulary: a path, null for enabled-but-failed, or
 * 'never-recorded'.
 */
function audioSensorLogEvidence(result: AudioStopResult, sensorsEnabled: boolean): EvidencePath {
  if (!sensorsEnabled) return 'never-recorded'; // capture-evidence sensors toggle off
  if (result.sensorLogState === undefined) return 'never-recorded'; // older native build: no IMU sink
  if (result.sensorLogState === 'recorded' && typeof result.sensorLogPath === 'string') {
    return result.sensorLogPath;
  }
  if (result.sensorLogState === 'unavailable') return 'never-recorded'; // the device provided no motion data
  return null; // 'failed': the sink was enabled and errored
}

/**
 * Camera counterpart of audioSensorLogEvidence. Maps a stills or video
 * session's IMU sensor-log report onto the same three-state EvidencePath
 * vocabulary. Every SensorLogEvidence field is optional, so an older native
 * build's absence commits 'never-recorded'.
 */
function cameraSensorLogEvidence(result: SensorLogEvidence, sensorsEnabled: boolean): EvidencePath {
  if (!sensorsEnabled) return 'never-recorded'; // capture-evidence sensors toggle off
  if (result.sensorLogState === undefined) return 'never-recorded'; // older native build: no IMU sink
  if (result.sensorLogState === 'recorded' && typeof result.sensorLogPath === 'string') {
    return result.sensorLogPath;
  }
  if (result.sensorLogState === 'unavailable') return 'never-recorded'; // the device provided no motion data
  return null; // 'failed': the sink was enabled and errored
}

/**
 * Shutter-burst sink, mapped onto the same three-state EvidencePath
 * vocabulary. Toggle off, or a native build without the sink, commits
 * 'never-recorded', as does a native 'never-recorded' state (its reason
 * rides the CaptureResult into the record's exhibitCapture). A native
 * 'error' state commits null.
 */
function ringBufferEvidence(result: CaptureResult, ringEnabled: boolean): EvidencePath {
  if (!ringEnabled) return 'never-recorded'; // capture-evidence ring toggle off
  const ep = result.ringBufferDir;
  if (ep === undefined) return 'never-recorded'; // older native build: no ring sink
  if (ep.state === 'path') return ep.path;
  if (ep.state === 'error') return null; // the sink was enabled and errored
  return 'never-recorded'; // native-stated reason (e.g. no synchronized pair at shutter)
}

/** Distance between the first two active touches (for pinch). */
function pinchDistance(evt: GestureResponderEvent): number {
  const t = evt.nativeEvent.touches;
  if (t.length < 2) return 0;
  const dx = t[0].pageX - t[1].pageX;
  const dy = t[0].pageY - t[1].pageY;
  return Math.sqrt(dx * dx + dy * dy);
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

// Physical lens stack selection (ExhibitCamera): optical devices, not crops.
// Reported per device by the native module's listFormats().
const LENS_ORDER: ExhibitLens[] = ['ultraWide', 'wide', 'telephoto'];

/** Single-stack zoom model (front camera, or a back inventory not yet
 *  reported): one 1x stop, no crossing, everything above 1x is digital. */
const FRONT_STOPS = [{ lens: 'wide' as ExhibitLens, factor: 1, label: '1x' }];

/** The mode row's visual order — horizontal swipes walk this list. */
const MODE_ORDER: Mode[] = ['audio', 'picture', 'video'];

/**
 * Lens chip labels ('.5', '1x', '4'). Display-only: the record commits the
 * true per-format field of view. The ultra-wide is labeled ".5" on every
 * model to date; the telephoto factor comes from the FOV ratio (tan cancels
 * the sensor-width term), snapped to whole steps within tolerance. A naive
 * wide-FOV/lens-FOV ratio reads wrong when the active format crops the
 * sensor.
 */
function computeLensLabels(fmts: ListFormatsResult): Partial<Record<ExhibitLens, string>> {
  const fov = (l: ExhibitLens): number | null => fmts.lenses[l]?.formats?.[0]?.fieldOfViewDegrees ?? null;
  const out: Partial<Record<ExhibitLens, string>> = { wide: '1x' };
  if (fmts.lenses.ultraWide?.present) out.ultraWide = '.5';
  const wide = fov('wide');
  const tele = fov('telephoto');
  if (wide && tele && wide > 0 && tele > 0 && tele < wide) {
    const ratio = Math.tan((wide * Math.PI) / 360) / Math.tan((tele * Math.PI) / 360);
    const steps = [2, 3, 4, 5, 8];
    let best = steps[0];
    let bestRel = Infinity;
    for (const s of steps) {
      const rel = Math.abs(ratio - s) / s;
      if (rel < bestRel) { bestRel = rel; best = s; }
    }
    out.telephoto = String(bestRel <= 0.22 ? best : Math.max(2, Math.round(ratio)));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Pro param ladders. Ladder params ride the precision bar as integer rung
// indices (rung 0 = AUTO where the hardware has one); continuous params
// scrub their native range. The bridge clamps to the active format's range,
// not the device-global range, and hands the clamped value back, so the
// capsule shows what was applied.
// ---------------------------------------------------------------------------

/** ISO ladder: tick marks on the ISO ribbon, clamped per device to the
 *  active format's range. */
const ISO_LADDER = [32, 50, 80, 125, 200, 400, 800, 1600, 3200];
/** Exposure-duration ladder in seconds, ascending (1/8000 … 1 s): the SHTR
 *  ribbon's tick marks. The scrub itself is continuous, in stops. */
const SHUTTER_LADDER = [
  1 / 8000, 1 / 4000, 1 / 2000, 1 / 1000, 1 / 500, 1 / 250, 1 / 125,
  1 / 60, 1 / 30, 1 / 15, 1 / 8, 1 / 4, 1 / 2, 1,
];
/** Manual focus: the lens-motor positions the FOCUS ladder offers (rung 0
 *  is AUTO). iOS exposes no focus-distance-in-meters API, so the metadata
 *  block commits focusDistanceMeters: null. */
const FOCUS_LADDER = [0, 0.25, 0.5, 0.75, 1];
/** Manual white balance: temperature only, tint fixed at 0 (the bridge
 *  round-trips and reports the applied tint ≈ 0). The ladder is the common
 *  presets plus the 2500/7500 K ends. */
const WB_LADDER = [2500, 3200, 4000, 5000, 5500, 6500, 7500];
/** Exposure compensation (precision bar): −2…+2 EV, continuous with
 *  1/10-stop snap. The bridge clamps to the device's real bias range. */
const BIAS_MIN = -2;
const BIAS_MAX = 2;
// Pinch zoom speed limit: the target follows the fingers 1:1, but the
// applied factor lerps toward it at ~2.6 octaves/s at most.
const PINCH_LERP = 0.32; // per-frame approach toward the target (60 fps)
const PINCH_MAX_LOG2_PER_FRAME = 2.6 / 60;

/** Shutter display: fractions for sub-second ("1/250"), "1 s" at 1. */
function formatShutter(seconds: number): string {
  if (seconds >= 1) return `${Math.round(seconds)}s`;
  return `1/${Math.round(1 / seconds)}`;
}

/** Index of the ladder entry nearest to v (for stepping from an applied,
 *  possibly clamped, value that may sit between rungs). */
function nearestLadderIndex(ladder: number[], v: number): number {
  let best = 0;
  for (let i = 1; i < ladder.length; i++) {
    if (Math.abs(ladder[i] - v) < Math.abs(ladder[best] - v)) best = i;
  }
  return best;
}

/** "0", "+1.3", "−1.7" — one decimal is exact for 1/3-stop steps at this
 *  granularity (⅓ ≈ 0.3, ⅔ ≈ 0.7); the committed value is device-read-back. */
function formatBias(v: number): string {
  if (Math.abs(v) < 0.05) return '0';
  return `${v > 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}`;
}

/**
 * ExhibitCamera returns plain filesystem paths (never file:// URIs); expo
 * FileSystem calls below want the URI form. Idempotent.
 */
function toFileUri(p: string): string {
  return p.startsWith('file://') ? p : `file://${p}`;
}

/**
 * Watchdog for native ExhibitCamera awaits, so a call that never settles
 * cannot freeze the app. On timeout the abandoned promise is swallowed, so
 * it raises no unhandled rejection when it eventually settles, and the
 * caller surfaces the failure.
 */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => {
      p.then(() => {}, () => {});
      reject(new Error(`${label} did not answer within ${Math.round(ms / 1000)}s`));
    }, ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

export default function CaptureScreen() {
  const styles = useThemedStyles(buildStyles);
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { settings, saveSettings } = useStore();

  // Camera/mic permission state, probed through the ExhibitCamera bridge
  // (the native module requests both; null = not yet answered).
  const [perms, setPerms] = useState<{ camera: boolean; microphone: boolean } | null>(null);

  const poseBuffer = useRef<PoseSample[]>([]);
  const recordStartMs = useRef(0);
  // True exactly while the native ExhibitCamera session is configured
  // (screen focused, photo/video mode). Chrome calls no-op without it.
  const sessionActive = useRef(false);
  // Native graph signal: on 'virtual-dual-wide' the wide and ultra-wide
  // constituents are both live on one virtual device, so the device zoom
  // factor is the relative factor across the sweep and the lens pills are
  // zoom-stop jumps, not input swaps.
  const graphRef = useRef<'virtual-dual-wide' | 'multi-input' | null>(null);
  // The MAX_VIDEO_SECONDS video cap drives a JS-side stopVideo; the UI
  // stopwatch is <RecordTimer/>, mounted exactly while `recording` is true.
  const videoStopTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recordingRef = useRef(false);
  const flashAnim = useRef(new Animated.Value(0)).current;

  const [mode, setMode] = useState<Mode>('picture');
  const modeRef = useRef<Mode>('picture');
  const [facing, setFacing] = useState<'back' | 'front'>('back');
  // The light is per mode. PHOTO keeps a flash preference (auto/on/off, the
  // photo output's strobe flashMode via setPhotoFlashMode); VIDEO keeps a
  // torch on/off. `torch` is the continuous light applied to the session
  // right now: always off in photo mode, and re-derived from the incoming
  // mode's preference on every mode switch.
  const [torch, setTorch] = useState(false);
  // Zoom is tracked as the factor relative to the wide lens's 1x, the number
  // on the pills. `zoomFactor` is the committed value (gesture end or lens
  // switch); live gesture values ride zoomChannel, so a pinch or wheel scrub
  // never re-renders the viewfinder tree.
  const [zoomFactor, setZoomFactor] = useState(1);
  const zoomFactorRef = useRef(1);
  const zoomChannel = useRef(new LiveChannel<LiveZoom>({ factor: 1, active: false })).current;
  // Device-reported zoom range of the active lens (capabilities()); {1,1}
  // until known.
  const [zoomRange, setZoomRange] = useState<{ min: number; max: number; qualityCap?: number }>({ min: 1, max: 1 });
  // Per-constituent-device quality caps from capabilities(). null until
  // fetched, or on older builds, where maxRelativeZoom falls back to
  // MAX_RELATIVE_ZOOM.
  const [lensCaps, setLensCaps] = useState<LensZoomCap[] | null>(null);
  const lensCapsRef = useRef<LensZoomCap[] | null>(null);
  useEffect(() => { lensCapsRef.current = lensCaps; }, [lensCaps]);
  const pinchStartDist = useRef(0);
  const pinchStartLog = useRef(0);
  const pinchTargetLog = useRef(0);
  const pinchCurrentLog = useRef(0);
  const pinchRaf = useRef<ReturnType<typeof requestAnimationFrame> | null>(null);
  const pinchRef = useRef(false);
  // Physical lens selection: listFormats() reports which lens stacks this
  // hardware has, and absent lenses are hidden. Switching lenses is optical
  // zoom (a different sensor and lens stack), not a crop.
  const [lenses, setLenses] = useState<ExhibitLens[]>([]);
  // Lens chip labels derived from the hardware's reported FOVs
  // (computeLensLabels). buildStops() falls back to '.5'/'1x'/'T' labels when
  // the FOVs are unreported.
  const [lensLabels, setLensLabels] = useState<Partial<Record<ExhibitLens, string>>>({});
  const [lens, setLens] = useState<ExhibitLens>('wide');
  const lensRef = useRef<ExhibitLens>('wide');
  // Optical stops (lens, relative factor, label) the zoom wheel and pinch
  // cross through. The telephoto factor is null when the hardware reported no
  // FOVs; the pill shows its label and crossing through it is disabled.
  const stops = buildStops(lenses, lensLabels);
  // The front camera is one stack, so the zoom model collapses to a single
  // 1x stop with floor 1.
  const activeStops = facing === 'back' && stops.length > 0 ? stops : FRONT_STOPS;
  const stopsRef = useRef(activeStops);
  stopsRef.current = activeStops;
  // Sweep ceiling: the current stack's stop times its native quality cap when
  // the caps have reported, else the MAX_RELATIVE_ZOOM fallback. The sweep
  // stays on one stack; crossing into another is an explicit pill tap. On the
  // virtual dual-wide graph the sweep runs on the virtual device, whose
  // upscale headroom is the wide stack's, so the cap keys to 'wide' (keying
  // it to the ultra-wide would clamp the sweep at ~1x).
  const zoomCeiling = () =>
    stackZoomCeiling(
      stopsRef.current,
      lensCapsRef.current,
      graphRef.current === 'virtual-dual-wide' ? 'wide' : lensRef.current,
    );
  // 35mm-equivalent of the wide stack, from its reported FOV; the basis of
  // the effective-mm readout. null when unreported.
  const [baseMm, setBaseMm] = useState<number | null>(null);
  // The precision bar: which pro param is docked (null = closed).
  const [ribbonParam, setRibbonParam] = useState<ProParamId | null>(null);
  // Session lifecycle: null = no probe yet; 'unsupported' renders one quiet
  // gray caption; 'unreached' renders nothing.
  const [stereo, setStereo] = useState<StereoAvailability>('unreached');
  // Native session failures surface as a card (audioBlocked pattern).
  const [sessionError, setSessionError] = useState<string | null>(null);
  // Bumped when the native stall watchdog escalates: the session-lifecycle
  // effect re-runs and rebuilds the capture session from scratch.
  const [sessionEpoch, setSessionEpoch] = useState(0);

  // ---- PRO strip (spec §14) ----
  // Per-shoot session state, deliberately not in settings, so a fresh app
  // session starts fully auto. Capsule values are the bridge's applied
  // (clamped, round-tripped) values, which is what the metadata block
  // commits.
  const [proCaps, setProCaps] = useState<ExhibitCameraCapabilities | null>(null);
  const [proOpen, setProOpen] = useState(false);
  const proAnim = useRef(new Animated.Value(0)).current;
  // Mode-transition veil: a short blur pulse while the fresh session settles.
  // JS driver, since BlurView intensity is not native-animatable.
  const modeBlurAnim = useRef(new Animated.Value(0)).current;
  const [exposureMode, setExposureModeState] = useState<ExposureModeSetting>('auto');
  const [iso, setIso] = useState(200);
  const [shutter, setShutter] = useState(1 / 125);
  const [focusMode, setFocusModeState] = useState<FocusModeSetting>('auto');
  const [lensPosition, setLensPosition] = useState(0.5);
  const [focusAdjusting, setFocusAdjusting] = useState(false);
  const [wbMode, setWbModeState] = useState<WhiteBalanceModeSetting>('auto');
  const [wbTemp, setWbTemp] = useState(5000);
  // EV bias is continuous (Value Ribbon, 1/10-stop snap); no ladder.
  const [bias, setBias] = useState(0);
  // Ref mirror so the session-lifecycle effect (deps only mode/facing) can
  // re-apply the current pro state after a fresh configure.
  const proStateRef = useRef({ exposureMode, iso, shutter, focusMode, lensPosition, wbMode, wbTemp, bias });
  proStateRef.current = { exposureMode, iso, shutter, focusMode, lensPosition, wbMode, wbTemp, bias };
  const [recording, setRecording] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [fingerprint, setFingerprint] = useState<string>('');
  // The seal pill, the camera's one status element. Three states: steady
  // ("Sealing on · key"), busy ("Sealing…" while the queue drains), and the
  // completion flash ("Sealed"), fired only by the queue's completion
  // signal, never by enqueue.
  const [pendingSeals, setPendingSeals] = useState(0);
  const [sealedFlash, setSealedFlash] = useState(false);
  // Face check: with the toggle on, capture start runs an OS biometric check
  // and the boolean outcome rides to the seal as an event record
  // (captureIntegrity.biometricGatePassed). Null means the toggle is off.
  const faceGateFlag = useRef<boolean | null>(null);

  // ---- Audio mode (the standalone Audio tab, folded in as a camera mode) ----
  // `recording` is shared with video; the modes are mutually exclusive and the
  // mode row is locked while any recording runs. The stopwatch and level meter
  // are leaf components (<RecordTimer/>, <LevelMeter/>, bottom of file) that
  // own their ticking state, so their updates never re-render this screen.
  const [audioStopping, setAudioStopping] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  // Why transcription is off, verbatim from the native layer.
  const [transcriptOffReason, setTranscriptOffReason] = useState<TranscriptionOffReason>(null);
  // Set when the recognizer dies mid-recording (the recording itself is fine).
  const [transcriptionIssue, setTranscriptionIssue] = useState<string | null>(null);
  // The audio level meter lives in <LevelMeter/> (bottom of file): it owns the
  // onLevel subscription and its own dB state, so ~30 updates/s re-render that
  // leaf only.
  const [partial, setPartial] = useState('');
  const [committed, setCommitted] = useState('');
  const [audioBlocked, setAudioBlocked] = useState<{ message: string; needsSettings: boolean } | null>(null);
  const audioSubs = useRef<(EventSubscription | null)[]>([]);
  const audioStarting = useRef(false);
  // Ref mirrors so the interruption callback (created once per recording)
  // reads the live transcript, not a stale render closure.
  const committedRef = useRef('');
  const partialRef = useRef('');
  // The transcript fades on screen when a recording starts, out when it ends.
  const transcriptFade = useRef(new Animated.Value(0)).current;

  // Pinch-to-zoom (dependency-free PanResponder). It claims a gesture only
  // with two or more fingers down, so single taps (tap-to-focus, shutter,
  // mode, flip, light) are untouched. Zoom drives the camera's own
  // optical+digital zoom and never touches pixels after the fact, so the
  // signing pipeline is unaffected.
  // Gesture arbitration: a two-finger pinch zooms; a single-finger horizontal
  // swipe switches capture mode. The responder claims a gesture only once
  // intent is clear (24 px of dominant horizontal travel).
  // The pinch target follows the finger ratio 1:1, but the applied factor
  // lerps toward it on a rAF loop capped at PINCH_MAX_LOG2_PER_FRAME, and the
  // loop writes the live channel and throttled native calls, never React
  // state.
  const gestureKind = useRef<'pinch' | 'swipe' | null>(null);
  const swipeFired = useRef(false);
  const modeSwipeRef = useRef<(dir: 1 | -1) => void>(() => {});
  // Mode-swipe exclusion zones: a horizontal drag starting on the pro tray or
  // the docked precision bar is a dial adjustment, not a mode switch. The
  // zones are window-Y spans measured off the wrappers at render, each
  // consulted only while its control is open.
  const trayZone = useRef<{ y0: number; y1: number } | null>(null);
  const ribbonZone = useRef<{ y0: number; y1: number } | null>(null);
  const trayWrapRef = useRef<View>(null);
  const ribbonWrapRef = useRef<View>(null);
  const proOpenRef = useRef(false);
  proOpenRef.current = proOpen;
  const ribbonOpenRef = useRef(false);
  ribbonOpenRef.current = ribbonParam !== null;
  const measureGestureZones = () => {
    trayWrapRef.current?.measureInWindow((_x, y, _w, h) => {
      trayZone.current = { y0: y - 8, y1: y + h + 8 };
    });
    ribbonWrapRef.current?.measureInWindow((_x, y, _w, h) => {
      ribbonZone.current = { y0: y - 8, y1: y + h + 8 };
    });
  };
  // onLayout reports parent-relative geometry only: docking the ribbon shifts
  // the tray's window position without firing it, so re-measure one frame
  // later whenever either control mounts, docks, or the mode hides them.
  useEffect(() => {
    const raf = requestAnimationFrame(measureGestureZones);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- measureGestureZones reads only refs
  }, [proOpen, ribbonParam, mode]);
  const applyLiveZoomRef = useRef<(relative: number) => void>(() => {});
  const commitZoomRef = useRef<(relative: number) => void>(() => {});
  // Pinch floor tracks the current stack's optical stop; the sweep never
  // leaves the stack, and the lens inventory arrives async.
  const zoomFloorLog = useRef(Math.log2(1));
  zoomFloorLog.current = Math.log2(
    graphRef.current === 'virtual-dual-wide' ? firstOpticalFactor(activeStops) : stackZoomFloor(activeStops, lens),
  );
  // The lerp tick, hoisted so a move event can restart the loop after it
  // converged: fingers held still park the loop, fingers moving wake it.
  const pinchTickRef = useRef<() => void>(() => {});
  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: (evt) => evt.nativeEvent.touches.length >= 2,
      onMoveShouldSetPanResponder: (evt, g) => {
        if (evt.nativeEvent.touches.length >= 2) return true;
        // classifyGesture (gestureClassify.ts) decides: a drag that started on
        // the pro tray or the precision bar belongs to that control, and while
        // the bar is docked the mode swipe is disabled entirely.
        const startY = evt.nativeEvent.pageY - g.dy;
        const zone: GestureZone =
          proOpenRef.current && trayZone.current && startY >= trayZone.current.y0 && startY <= trayZone.current.y1
            ? 'tray'
            : ribbonOpenRef.current && ribbonZone.current && startY >= ribbonZone.current.y0 && startY <= ribbonZone.current.y1
              ? 'ribbon'
              : 'field';
        return classifyGesture(g.dx, g.dy, zone, !ribbonOpenRef.current) === 'mode-swipe';
      },
      onPanResponderGrant: (evt) => {
        if (evt.nativeEvent.touches.length >= 2) {
          gestureKind.current = 'pinch';
          pinchStartDist.current = pinchDistance(evt);
          pinchStartLog.current = Math.log2(zoomFactorRef.current);
          pinchTargetLog.current = pinchStartLog.current;
          pinchCurrentLog.current = pinchStartLog.current;
          pinchRef.current = true;
          zoomChannel.emit({ factor: zoomFactorRef.current, active: true });
          // Speed-limited lerp loop. JS-side, but it only emits the channel
          // and throttled native calls; React renders nothing outside the
          // zoom leaves.
          pinchTickRef.current = () => {
            if (gestureKind.current !== 'pinch') { pinchRaf.current = null; return; }
            const target = pinchTargetLog.current;
            let next = pinchCurrentLog.current + (target - pinchCurrentLog.current) * PINCH_LERP;
            next = Math.min(
              pinchCurrentLog.current + PINCH_MAX_LOG2_PER_FRAME,
              Math.max(pinchCurrentLog.current - PINCH_MAX_LOG2_PER_FRAME, next),
            );
            pinchCurrentLog.current = next;
            if (Math.abs(target - next) > 0.0005) {
              applyLiveZoomRef.current(Math.pow(2, next));
              pinchRaf.current = requestAnimationFrame(pinchTickRef.current);
            } else {
              applyLiveZoomRef.current(Math.pow(2, target));
              pinchRaf.current = null;
            }
          };
          pinchRaf.current = requestAnimationFrame(pinchTickRef.current);
        } else {
          gestureKind.current = 'swipe';
          swipeFired.current = false;
        }
      },
      onPanResponderMove: (evt, g) => {
        if (gestureKind.current === 'swipe') {
          // One switch per gesture, at a decisive 64 px. switchMode's own
          // guards (recording lock, pro reset) apply unchanged.
          if (!swipeFired.current && Math.abs(g.dx) > 64) {
            swipeFired.current = true;
            modeSwipeRef.current(g.dx < 0 ? 1 : -1);
          }
          return;
        }
        const d = pinchDistance(evt);
        if (d > 0 && pinchStartDist.current > 0) {
          // Multiplicative ratio, clamped to the optical floor and the
          // digital ceiling.
          pinchTargetLog.current = Math.min(
            Math.log2(zoomCeiling()),
            Math.max(zoomFloorLog.current, pinchStartLog.current + Math.log2(d / pinchStartDist.current)),
          );
          // The loop parks once converged; a new move target wakes it.
          if (gestureKind.current === 'pinch' && !pinchRaf.current) {
            pinchRaf.current = requestAnimationFrame(pinchTickRef.current);
          }
        }
      },
      onPanResponderRelease: () => {
        if (gestureKind.current === 'pinch') {
          pinchStartDist.current = 0;
          if (pinchRaf.current) cancelAnimationFrame(pinchRaf.current);
          pinchRaf.current = null;
          commitZoomRef.current(Math.pow(2, pinchCurrentLog.current));
          // The ref clears a beat later so a tap-to-focus onTouchEnd trailing
          // the pinch's finger-lift is not mistaken for a focus tap.
          setTimeout(() => { pinchRef.current = false; }, 250);
        }
        gestureKind.current = null;
        swipeFired.current = false;
      },
      onPanResponderTerminate: () => {
        if (gestureKind.current === 'pinch' && pinchRaf.current) cancelAnimationFrame(pinchRaf.current);
        pinchRaf.current = null;
        pinchStartDist.current = 0;
        pinchRef.current = false;
        commitZoomRef.current(Math.pow(2, pinchCurrentLog.current));
        gestureKind.current = null;
        swipeFired.current = false;
      },
    })
  ).current;

  // Permissions on first focus, via the ExhibitCamera bridge; the native
  // module owns both the camera and mic prompts.
  useEffect(() => {
    if (!isExhibitCameraAvailable()) {
      setPerms({ camera: false, microphone: false });
      return;
    }
    requestExhibitCameraPermissions().then(setPerms).catch(() => setPerms({ camera: false, microphone: false }));
  }, []);

  useEffect(() => {
    if (perms?.camera && settings.includeLocation) requestCapturePermissions(true);
  }, [perms, settings.includeLocation]);

  // Ref mirrors read by the session-lifecycle effect below (its deps are
  // only mode/facing, so lens/torch/zoom reach it through refs).
  useEffect(() => { lensRef.current = lens; }, [lens]);
  useEffect(() => { modeRef.current = mode; }, [mode]);
  useEffect(() => { zoomFactorRef.current = zoomFactor; }, [zoomFactor]);
  const torchRef = useRef(false);
  useEffect(() => { torchRef.current = torch; }, [torch]);
  useEffect(() => { recordingRef.current = recording; }, [recording]);

  // Photo and video ride one native session (startVideo/stopVideo reconfigure
  // it in place); only audio mode needs the camera torn down.
  const needsCamera = mode !== 'audio';

  /**
   * Session lifecycle: one native session, configured when the screen is
   * focused in photo/video mode, stopped on blur and whenever audio mode owns
   * the microphone. Chrome state (torch, zoom) is re-applied after each
   * configure, since a fresh session starts at defaults. A wedged native
   * start surfaces as a card after the 10 s watchdog.
   *
   * The effect keys on `needsCamera`, not `mode`: photo/video hops ride the
   * same running native session, so rebuilding per hop cost a blocking
   * startRunning, a calibration one-shot, and PiP teardown on every switch.
   */
  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      const boot = async () => {
        if (!needsCamera) return; // the audio recorder owns the mic here
        if (!isExhibitCameraAvailable()) {
          setSessionError('The native camera module is not in this build, so photo and video capture are unavailable on this device.');
          return;
        }
        const doConfigure = () => withTimeout(
          // Alternate view off means do not collect: the secondary camera is
          // never attached and the record's stereo sections commit their
          // never-recorded states. Applies from the next session configure
          // (screen re-enter), like lens.
          // IMU evidence sink: the top-level includeSensors toggle arms the
          // session's 60 s sensor ring. Per-session flag, same lifecycle as
          // stereo; older native builds ignore it and report nothing, which
          // commits 'never-recorded' by absence.
          configureSession({
            // On the virtual dual-wide graph (stereo on) the ultra-wide
            // "lens" is a zoom stop, not an input: the graph only forms from a
            // wide anchor (native gates on lens == .wide). Reconfiguring with
            // ultraWide here would tear the pair down to the multi-input graph
            // on every blur or refocus. The parked 0.5 zoom is re-applied
            // after start.
            lens: settings.captureEvidence.altView && lensRef.current === 'ultraWide' ? 'wide' : lensRef.current,
            facing,
            stereo: settings.captureEvidence.altView,
            sensorLog: settings.includeSensors,
            // Shutter-burst sink: arms the 3 pre + 4 post frame commit per
            // still. Older builds ignore the flag and the record commits
            // 'never-recorded' by absence.
            ring: settings.captureEvidence.ring,
            // Stereo partner is always 'auto', which keeps the native UW/W/T
            // pairing. Older builds ignore the key.
            secondaryLens: 'auto',
          }),
          10000,
          'Camera session start',
        );
        try {
          let start;
          try {
            start = await doConfigure();
          } catch (e) {
            // A session orphaned by an interrupted teardown rejects E_BUSY
            // "already running", after which every capture and mode tap
            // dead-loops until an app restart. Force-stop the orphan and retry
            // once; a failed retry still shows the error card.
            if (e instanceof Error && e.message.includes('already running')) {
              await stopVideo().catch(() => {});
              await stopSession().catch(() => {});
              if (cancelled) return;
              start = await doConfigure();
            } else {
              throw e;
            }
          }
          if (cancelled) {
            void stopSession().catch(() => {});
            return;
          }
          sessionActive.current = true;
          setSessionError(null);
          setStereo(start.stereo);
          graphRef.current = start.graph ?? null;
          void setTorchLevel(torchRef.current ? 1.0 : null);
          // The persisted photo-strobe preference rides the photo output's
          // flashMode, never the torch. A fresh session inherits the stored
          // native preference; re-apply it explicitly.
          void setPhotoFlashMode(settings.photoFlash).catch(() => {});
          // A fresh session starts at 1x device zoom, so re-apply the
          // committed factor. It survives photo/video hops; lens switches and
          // flips reset it to the stop.
          {
            const device = clampZoom(
              deviceFactorFor(zoomFactorRef.current, stopsRef.current),
              graphRef.current === 'virtual-dual-wide' ? Math.min(0.5, zoomRange.min) : 1,
              zoomCeiling(),
            );
            if (Math.abs(device - 1) > 0.001) void setNativeZoom(device).catch(() => {});
          }
          // Re-apply the pro strip's session state after a fresh configure,
          // same rule as torch and zoom. Pro choices are per-shoot: they
          // survive a flip or a photo/video hop, and only the trip to audio
          // resets them (see switchMode). Skipped while the dual-view graph is
          // armed, where manual per-device controls are not offered.
          const p = proStateRef.current;
          if (!settings.captureEvidence.altView) {
          if (p.exposureMode !== 'auto') {
            void setExposureMode(p.exposureMode === 'custom'
              ? { mode: 'custom', iso: p.iso, durationSeconds: p.shutter }
              : { mode: p.exposureMode }).catch(() => {});
          }
          if (p.focusMode !== 'auto') {
            void setFocusMode(p.focusMode === 'manual'
              ? { mode: 'manual', lensPosition: p.lensPosition }
              : { mode: p.focusMode }).catch(() => {});
          }
          if (p.wbMode !== 'auto') {
            void setWhiteBalanceMode(p.wbMode === 'manual'
              ? { mode: 'manual', temperature: p.wbTemp, tint: 0 }
              : { mode: p.wbMode }).catch(() => {});
          }
          if (p.bias !== 0) void setExposureBias(p.bias).catch(() => {});
          }
          const caps = await capabilities().catch(() => null);
          if (cancelled) return;
          if (caps?.zoomRange) setZoomRange(caps.zoomRange);
          // Per-device quality caps drive the sweep ceiling (maxRelativeZoom);
          // absent on older builds, which fall back to the constant.
          setLensCaps(caps?.lensZoomCaps ?? null);
          // Pro-strip capability inventory: the strip hides any control the
          // hardware does not report, and the PRO button itself when nothing
          // manual exists. Re-fetched per session, since front/back and lens
          // changes can change the active format's ISO and duration ranges.
          setProCaps(caps);
          const fmts = await listFormats().catch(() => null);
          if (!cancelled && fmts) {
            setLenses(LENS_ORDER.filter((l) => fmts.lenses[l]?.present === true));
            setLensLabels(computeLensLabels(fmts));
            // Basis for the effective-mm readout: the wide stack's reported
            // FOV. Unreported leaves it null and the readout hidden.
            setBaseMm(baseMmFromFov(fmts.lenses.wide?.formats?.[0]?.fieldOfViewDegrees));
          }
        } catch (e) {
          if (!cancelled) {
            sessionActive.current = false;
            setSessionError(e instanceof Error ? `Camera session failed to start: ${e.message}` : 'Camera session failed to start.');
          }
        }
      };
      void boot();
      return () => {
        cancelled = true;
        sessionActive.current = false;
        graphRef.current = null;
        // Blur or an audio-mode switch mid-video finalizes the take through
        // the normal stop path before the session stops. Keys off the
        // recording ref, not the possibly stale mode closure.
        if (recordingRef.current) {
          void finishVideoRef.current().then(() => stopSession().catch(() => {}));
        } else {
          void stopSession().catch(() => {});
        }
      };
      // needsCamera collapses photo and video into one session lifetime.
      // altView is a dep: without it, toggling Multiple Lenses left the old
      // graph running, so dual-off kept the virtual graph (lens pills became
      // zoom-stop jumps that switch nothing) and dual-on never attached the
      // partner.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [needsCamera, facing, sessionEpoch, settings.captureEvidence.altView])
  );

  // Torch: the toggle is a level, 1.0 on and null off. Native clamps to
  // maxTorchLevel; hardware without a torch no-ops with applied:false.
  useEffect(() => {
    if (sessionActive.current) void setTorchLevel(torch ? 1.0 : null);
  }, [torch]);

  // Native session errors surface as a card. A terminal error mid-recording
  // (E_WRITER / E_PLATFORM / E_NO_SESSION) runs the same stop path as a manual
  // stop, so no JS promise is left pending. Sink-level degradations never stop
  // a recording.
  useEffect(() => {
    return onSessionError((e) => {
      setSessionError(`${e.code}: ${e.message}`);
      if (
        recordingRef.current &&
        (e.code === 'E_WRITER' || e.code === 'E_PLATFORM' || e.code === 'E_NO_SESSION')
      ) {
        void finishVideoRef.current();
      }
    });
  }, []);

  // Focus-settling signal (spec §14): a quiet "focusing…" state on the focus
  // capsule while the lens motor moves. Also the capture guardrail, since the
  // UI avoids capturing mid-adjustment.
  useEffect(() => {
    return onAdjustingFocus((e) => setFocusAdjusting(e.adjusting));
  }, []);

  // Thermal and system pressure, stated quietly: the recording continues and
  // only the stereo partner detaches.
  useEffect(() => {
    return onHardwarePressure((e) => {
      if (e.degraded === 'stereo-detached' || e.action === 'stereo-detached') {
        showToast('Thermal pressure: stereo capture detached; capture continues on the primary lens.');
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Stall escalation: the native watchdog already tried one cheap synchronizer
  // rebind, so a still-stalled pipeline rebuilds the session by bumping the
  // epoch. Skipped mid-recording, where a rebuild would kill the take and
  // failures surface through their own error path.
  useEffect(() => {
    return onSyncStalled(() => {
      if (recordingRef.current) return;
      setSessionEpoch((e) => e + 1);
    });
  }, []);

  // Native pipeline diagnostics (graph wiring outcomes, format picks, the live
  // connection census, interruption boundaries) forwarded verbatim into the
  // persistent log, so a field screenshot self-explains.
  useEffect(() => {
    return onCameraDiagnostic((e) => {
      logDiagnostic({ t: Date.now(), kind: 'camera', outcome: 'info', message: e.message });
    });
  }, []);

  // Periodic stereo pairs (video, spec §8): the module dumps
  // pair-%04d-{secondary.jpg,calibration.json} under the evidence dir and
  // reports each dump here. The events are the per-pair anchors; no
  // per-pair timestamps file exists. Collected while recording; the seal job
  // carries them to the stereo ingestion path.
  const videoPairEvents = useRef<StereoPairCapturedEvent[]>([]);
  useEffect(() => {
    return onStereoPairCaptured((e) => {
      if (recordingRef.current) videoPairEvents.current.push(e);
    });
  }, []);

  // Device fingerprint for the seal pill, plus queue wiring for its states.
  useEffect(() => {
    getDeviceKey().then((k) => setFingerprint(k.fingerprint.slice(0, 12))).catch(() => {});
    void resumeSealQueue();
    let flashTimer: ReturnType<typeof setTimeout> | null = null;
    const unsubCount = subscribeSeals(setPendingSeals);
    const unsubDone = subscribeSealCompletions(() => {
      setSealedFlash(true);
      if (flashTimer) clearTimeout(flashTimer);
      flashTimer = setTimeout(() => setSealedFlash(false), 2200);
    });
    return () => {
      unsubCount();
      unsubDone();
      if (flashTimer) clearTimeout(flashTimer);
    };
  }, []);

  // Fused DeviceMotion feed while the screen is focused: gyro rotation rate,
  // fused attitude, and gravity-free acceleration, which is the signed pose
  // trace. A null component skips the sample rather than writing zeros.
  //
  // This is the committed path: poseBuffer feeds collectContext's signed pose
  // trace on every capture, so it stays at the full 100 Hz and keeps the full
  // BUFFER_LIMIT window. There is no display-only IMU subscription in this
  // file.
  useFocusEffect(
    useCallback(() => {
      if (!settings.includeSensors || Platform.OS === 'web') return;
      let sub: { remove: () => void } | null = null;
      let mounted = true;
      (async () => {
        const available = await DeviceMotion.isAvailableAsync();
        if (!available || !mounted) return;
        DeviceMotion.setUpdateInterval(10);
        sub = DeviceMotion.addListener((m) => {
          if (!m.acceleration || !m.rotationRate || !m.rotation) return;
          const buf = poseBuffer.current;
          // expo-sensors reports BOTH attitude and rotation rate with
          // CoreMotion's axis names: alpha = z (yaw), beta = y (pitch),
          // gamma = x (roll). Mapped to device axes here so the signed
          // trace's rx/ry/rz are what a desk expects.
          // Units: expo's native module converts rotationRate to degrees per
          // second (radiansToDegrees, DeviceMotionModule.swift) before JS sees
          // it, while PoseSample.rx/ry/rz are rad/s and every consumer
          // (motion.ts quantization, the Motion Trace card, desk imuflow) is
          // built on that. Convert at the edge.
          const DEG2RAD = Math.PI / 180;
          buf.push({
            t: Date.now(),
            ax: m.acceleration.x, ay: m.acceleration.y, az: m.acceleration.z,
            rx: m.rotationRate.gamma * DEG2RAD, ry: m.rotationRate.beta * DEG2RAD, rz: m.rotationRate.alpha * DEG2RAD,
            roll: (m.rotation.gamma * 180) / Math.PI,
            pitch: (m.rotation.beta * 180) / Math.PI,
            yaw: (m.rotation.alpha * 180) / Math.PI,
          });
          // Trim in chunks, not per sample: splicing a ~13k array every 10 ms
          // is O(n) each time. Letting the buffer run to BUFFER_LIMIT + 1000
          // before trimming keeps every sample inside the same window at a
          // fraction of the housekeeping cost.
          if (buf.length > BUFFER_LIMIT + 1000) buf.splice(0, buf.length - BUFFER_LIMIT);
        });
      })();
      return () => {
        mounted = false;
        sub?.remove();
      };
    }, [settings.includeSensors])
  );

  const showToast = useCallback((msg: string, ms: number = 2600) => {
    setToast(msg);
    setTimeout(() => setToast(null), ms);
  }, []);

  const shutterFlash = () => {
    Animated.sequence([
      Animated.timing(flashAnim, { toValue: 1, duration: 70, useNativeDriver: true }),
      Animated.timing(flashAnim, { toValue: 0, duration: 160, useNativeDriver: true }),
    ]).start();
  };

  // ------------------------------------------------------------------
  // Zoom engine. One path for pinch and wheel:
  //   applyLiveZoom(relative) — clamps to the current stack, emits the live
  //     channel, applies natively ramped (setZoomSmooth), throttled and
  //     trailing. Never switches lenses.
  //   commitZoom(relative)    — gesture end: an instant native apply
  //     (setZoom) plus the committed React state.
  // The relative ceiling is the current stack's native quality-cap ceiling
  // when the caps have reported, else the MAX_RELATIVE_ZOOM fallback
  // (zoomModel).
  // ------------------------------------------------------------------
  const zoomNativeAt = useRef(0);
  const zoomNativeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const applyDeviceZoom = (device: number) => {
    if (!sessionActive.current) return;
    const d = clampZoom(device, zoomRange.min, Math.min(zoomRange.max, zoomRange.qualityCap ?? MAX_RELATIVE_ZOOM));
    const now = Date.now();
    if (now - zoomNativeAt.current >= 50) {
      zoomNativeAt.current = now;
      void setNativeZoomSmooth(d).catch(() => {});
    } else if (!zoomNativeTimer.current) {
      zoomNativeTimer.current = setTimeout(() => {
        zoomNativeTimer.current = null;
        zoomNativeAt.current = Date.now();
        const dd = clampZoom(
          deviceFactorFor(zoomFactorRef.current, stopsRef.current),
          zoomRange.min,
          Math.min(zoomRange.max, zoomRange.qualityCap ?? MAX_RELATIVE_ZOOM),
        );
        void setNativeZoomSmooth(dd).catch(() => {});
      }, 50);
    }
  };

  /** Zoom floor for the current lens: its own optical stop. A pinch never
   *  walks the lens down; the .5 pill does that. On a lens whose stop factor
   *  the hardware could not report, the model is the device factor, so the
   *  floor is 1. */
  // On the dual-wide virtual device the sweep covers both constituents: the
  // floor is the lowest optical stop (the ultra-wide) and the relative factor
  // maps to the device factor 1:1, since the virtual device hands off
  // internally at 1.0. The per-stack divide is the physical-swap model and
  // applies only off the virtual graph.
  // Both helpers take an optional explicit lens. selectLens commits the zoom
  // for the lens it just switched to, but lensRef only updates in a
  // post-render effect, so reading it here would clamp against the previous
  // lens's floor.
  const zoomFloorFor = (c: ReturnType<typeof buildStops>, forLens?: ExhibitLens) =>
    graphRef.current === 'virtual-dual-wide' ? firstOpticalFactor(c) : stackZoomFloor(c, forLens ?? lensRef.current);
  const deviceFactorFor = (relative: number, c: ReturnType<typeof buildStops>, forLens?: ExhibitLens) =>
    graphRef.current === 'virtual-dual-wide' ? relative : toDeviceFactor(relative, c, forLens ?? lensRef.current);

  const applyLiveZoom = (relativeIn: number) => {
    const c = stopsRef.current;
    // The sweep stays on the current physical stack: no lens crossing
    // mid-gesture, so the session never reconfigures under the user's
    // fingers.
    const relative = clampZoom(relativeIn, zoomFloorFor(c), zoomCeiling());
    zoomFactorRef.current = relative;
    zoomChannel.emit({ factor: relative, active: true });
    applyDeviceZoom(deviceFactorFor(relative, c));
  };
  applyLiveZoomRef.current = applyLiveZoom;

  const commitZoom = (relativeIn: number, forLens?: ExhibitLens) => {
    const c = stopsRef.current;
    const relative = clampZoom(relativeIn, zoomFloorFor(c, forLens), zoomCeiling());
    zoomFactorRef.current = relative;
    // Virtual graph: the pill label tracks the constituent the device is
    // showing, since a pinch across the 1.0 hand-off crosses cameras with no
    // pill tap.
    if (graphRef.current === 'virtual-dual-wide') setLens(relative < 1 ? 'ultraWide' : 'wide');
    // An explicit lens switch carries its target synchronously; the state
    // effect lands post-render, too late for this commit's floor math.
    if (forLens) lensRef.current = forLens;
    setZoomFactor(relative);
    zoomChannel.emit({ factor: relative, active: false });
    if (sessionActive.current) {
      const requested = clampZoom(deviceFactorFor(relative, c, forLens), zoomRange.min, Math.min(zoomRange.max, zoomRange.qualityCap ?? MAX_RELATIVE_ZOOM));
      void setNativeZoom(requested).then((res) => {
        // The committed number rests on what the device reports it applied,
        // never the request. A zoom-locked multi-cam format (native resolves
        // applied:false, reason 'format-zoom-locked') snaps the HUD back to
        // the real factor.
        const appliedDevice = typeof res?.zoomFactor === 'number'
          ? res.zoomFactor
          : (!res?.applied && typeof res?.maxZoom === 'number' ? res.maxZoom : null);
        if (appliedDevice === null) return;
        const stop = factorForLens(stopsRef.current, lensRef.current) || 1;
        const appliedRelative = graphRef.current === 'virtual-dual-wide' ? appliedDevice : appliedDevice * stop;
        if (Number.isFinite(appliedRelative) && Math.abs(appliedRelative - zoomFactorRef.current) > 0.001) {
          zoomFactorRef.current = appliedRelative;
          setZoomFactor(appliedRelative);
          zoomChannel.emit({ factor: appliedRelative, active: false });
        }
      }).catch(() => {});
    }
  };
  commitZoomRef.current = commitZoom;

  // Byline is self-asserted. Organization affiliation is not typed in: it
  // rides the org credential's X.509 chain, embedded in the signature when one
  // is installed. Disclosure level is the CAWG-aligned per-capture identity
  // mode; the byline embeds only while the Name HUD toggle is on.
  const identity = identityForCapture(settings);

  /**
   * Face check: the OS biometric check, run at capture start when the toggle
   * is on. Capture proceeds either way; the seal records the outcome as a
   * boolean event record and never any biometric data. Returns null when the
   * toggle is off.
   */
  const runFaceGate = async (): Promise<boolean | null> => {
    if (!settings.faceCheckEnabled) return null;
    try {
      const res = await LocalAuthentication.authenticateAsync({
        promptMessage: 'Face check: a face match is required for this capture',
        cancelLabel: 'Cancel',
      });
      return res.success === true;
    } catch {
      return false; // an errored check is an honest 'did not pass'
    }
  };

  const motionSamplesNow = () =>
    poseBuffer.current.map((s) => ({ x: s.ax, y: s.ay, z: s.az, t: s.t }));

  const snapshotContext = async (capturedAtMs: number = Date.now()) =>
    collectContext({
      includeLocation: settings.includeLocation,
      includeSensors: settings.includeSensors,
      includeWifi: settings.includeWifi,
      motionSamples: motionSamplesNow(),
      poseSamples: [...poseBuffer.current],
      capturedAtMs,
    });

  // Burst intent queue: a shutter tap during an in-flight capture enqueues an
  // intent (cap 5) with a haptic ack, and each queued shot fires sequentially
  // as the previous settles. Every queued shot is a real capture with its own
  // seal job.
  const captureQueue = useRef(0);
  const capturePhotoRef = useRef<() => void>(() => {});

  const capturePhoto = async () => {
    if (!sessionActive.current) return;
    if (capturing) {
      if (captureQueue.current < 5) {
        captureQueue.current += 1;
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        if (captureQueue.current === 5) showToast('Camera is catching up; queued shots fire in order');
      } else {
        showToast('Burst queue full. Tap again in a moment');
      }
      return;
    }
    setCapturing(true);
    try {
      shutterFlash();
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      // Face check at capture start, before any bytes exist.
      faceGateFlag.current = await runFaceGate();

      // ExhibitCamera stills path: the delivery still plus the synchronized
      // stereo partner, committed calibration, timestamps, and per-device
      // metadata, each a three-state EvidencePath. Adds full-sensor stills
      // (own hash), the committed capture-settings block, and photo EXIF. The
      // full CaptureResult rides the seal job; the pump stores the artifact
      // files under the sealed record's evidence dir.
      const stamp = Date.now();
      const evidenceDir = `${FileSystem.documentDirectory}capture/evidence-${stamp}/`;
      await FileSystem.makeDirectoryAsync(evidenceDir, { intermediates: true }).catch(() => {});
      // A stalled pipeline kicks its own synchronizer rebind at the freshness
      // deadline, so one retry after a beat usually lands on a live frame.
      // Only genuinely fresh pairs commit; the retry changes when we ask, not
      // which pixels get sealed. With the IMU sink armed the native call gains
      // ~0.55 s of post-shutter ring drain, so the 20 s watchdog must not be
      // tightened.
      const attemptCapture = () => withTimeout(
        capture({
          deliveryPath: `${FileSystem.cacheDirectory}capture-${stamp}.jpg`,
          evidenceDir,
        }),
        20000,
        'Native capture',
      );
      let result;
      try {
        result = await attemptCapture();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!/E_STALE_PAIR|E_NO_SESSION|pipeline stalled/.test(msg)) throw e;
        await new Promise((r) => setTimeout(r, 700));
        result = await attemptCapture();
      }

      // Capture is not seal: enqueue the raw frame with the sensor context and
      // the exact moment. Hashing, Enclave signing, TSA countersigning, C2PA
      // embedding and vault encryption run in the background queue while the
      // camera stays live for the next shot.
      const context = await snapshotContext(result.capturedAtMs);
      await enqueuePhotoSeal({
        photoUri: toFileUri(result.deliveryPath),
        context,
        identity,
        // The standard-EXIF subset of the committed capture settings: the
        // photo's own EXIF first, device read-backs filling gaps, a field with
        // no real value absent. Signed as com.verify.exif by attestPhoto.
        exif: buildCaptureExif(result.captureSettings),
        // Three state per sink. The PCM master is a video-session sink, so
        // stills commit 'never-recorded' structurally. The stills ring maps
        // the capture result's own three-state report through the shared
        // vocabulary; a build without the sink reports nothing and commits
        // 'never-recorded'. The IMU sensor log rides the SensorLogEvidence
        // contract. Stereo artifacts carry their own three-state vocabulary in
        // exhibitCapture.
        captureEvidence: {
          rawPcmPath: 'never-recorded',
          sensorLogPath: cameraSensorLogEvidence(result, settings.includeSensors),
          ringBufferDir: ringBufferEvidence(result, settings.captureEvidence.ring),
        },
        exhibitCapture: result,
        biometricGatePassed: faceGateFlag.current,
      });
      showToast(
        result.stereoStatus === 'unavailable'
          // The still landed as a single-lens, full-sensor photo; the toast
          // states the degradation.
          ? 'Captured · single-lens; stereo unavailable at shutter'
          : 'Captured',
      );
      // The toast fades in 3 s; the diagnostics log keeps the fact.
      if (result.stereoStatus === 'unavailable') {
        logDiagnostic({
          t: Date.now(),
          kind: 'photo',
          outcome: 'captured-degraded',
          message: result.stereoUnavailableReason,
        });
      } else {
        logDiagnostic({ t: Date.now(), kind: 'photo', outcome: 'captured' });
      }
    } catch (e) {
      logDiagnostic({ t: Date.now(), kind: 'photo', outcome: 'failed', message: e instanceof Error ? e.message : String(e) });
      showToast(e instanceof Error ? `Capture failed: ${e.message}` : 'Capture failed');
    } finally {
      setCapturing(false);
      // Fire the next queued burst intent. A short beat lets the pipeline
      // breathe; the native ring drain already keeps captures sequential.
      if (captureQueue.current > 0) {
        captureQueue.current -= 1;
        setTimeout(() => capturePhotoRef.current(), 200);
      }
    }
  };
  capturePhotoRef.current = () => { void capturePhoto(); };

  /**
   * Video stop, reached by a manual stop, the cap timer, and terminal native
   * errors. The native module finalizes the delivery file; the pose trace
   * spans the whole clip at an adaptive rate (<= 240 samples), anchored to the
   * native session's first-frame clock rather than the JS stopwatch. Periodic
   * stereo pairs were committed into the evidence dir during recording, and
   * the seal job carries the session facts (audio track presence, pair
   * counts).
   */
  const finishVideo = async () => {
    if (videoStopping.current) return; // a double stop must not double-finalize
    videoStopping.current = true;
    if (videoStopTimer.current) {
      clearTimeout(videoStopTimer.current);
      videoStopTimer.current = null;
    }
    setRecording(false);
    try {
      const v = await withTimeout(stopVideo(), 30000, 'Native finalize');
      const context = await collectContext({
        includeLocation: settings.includeLocation,
        includeSensors: settings.includeSensors,
        includeWifi: settings.includeWifi,
        motionSamples: motionSamplesNow(),
        poseSamples: [...poseBuffer.current],
        capturedAtMs: recordStartMs.current,
        poseTraceOpts: {
          beforeMs: 1000,
          afterMs: v.durationMs + 500,
          hz: Math.min(20, Math.max(1, 240 / Math.max(1, v.durationMs / 1000))),
          maxSamples: 240,
        },
      });
      // ENF anchor: when the PCM master committed, its first-sample
      // wall-clock anchor and integrity summary ride the sealed context, so
      // the details screen (and a desk with a reference ENF series) can place
      // the mains trace in absolute time. Absent when no master committed;
      // captureEvidence.rawPcmPath states which case.
      if (v.rawPcmInfo && typeof v.rawPcmPath === 'string') {
        context.enfAnchor = v.rawPcmInfo;
      }
      await enqueueVideoSeal({
        videoUri: toFileUri(v.deliveryPath),
        context,
        identity,
        // Three state per sink. The native stop payload reports the recorded
        // raw-audio path or null (enabled-but-failed); the toggle-off case
        // commits 'never-recorded' here. The IMU sensor log rides the same
        // SensorLogEvidence contract as stills; a build without it reports
        // nothing and commits 'never-recorded'. The ring sink is stills-only,
        // so video commits 'never-recorded' structurally.
        captureEvidence: {
          rawPcmPath: settings.captureEvidence.rawPcm ? v.rawPcmPath ?? null : 'never-recorded',
          sensorLogPath: cameraSensorLogEvidence(v, settings.includeSensors),
          ringBufferDir: 'never-recorded',
        },
        exhibitVideo: {
          audioTrack: v.audioTrack,
          pairsCommitted: v.pairsCommitted,
          pairsMissed: v.pairsMissed,
          hardwareCost: v.hardwareCost,
          evidenceDir: videoEvidenceDir.current,
          // Session stereo availability as probed at configure time, plus the
          // collected pair events (the per-pair enumeration and anchors for
          // the stereo ingestion path).
          stereo,
          pairEvents: [...videoPairEvents.current],
        },
        biometricGatePassed: faceGateFlag.current,
      });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      showToast('Captured');
      // VideoResult carries no stereoStatus field, since stereo session state
      // is probed at configure time rather than in the stop payload, so
      // 'captured' is the only outcome to log here.
      logDiagnostic({ t: Date.now(), kind: 'video', outcome: 'captured' });
    } catch (e) {
      // A session stopped before its first frame rejects E_WRITER
      // ("no frames"), surfaced as a "too short" message.
      const code = (e as { code?: string } | null)?.code;
      const msg = e instanceof Error ? e.message : '';
      const tooShort = code === 'E_WRITER' && /no frames/i.test(msg);
      logDiagnostic({ t: Date.now(), kind: 'video', outcome: 'failed', message: msg || 'unknown error' });
      showToast(tooShort ? 'Too short; nothing captured' : `Recording failed: ${msg || 'unknown error'}`);
    } finally {
      videoStopping.current = false;
    }
  };
  const finishVideoRef = useRef(finishVideo);
  finishVideoRef.current = finishVideo;
  // Re-entrancy guard for finishVideo, plus the evidence dir of the in-flight
  // video session (set at startVideo).
  const videoStopping = useRef(false);
  const videoEvidenceDir = useRef<string>('');

  const toggleVideo = async () => {
    if (!recording) {
      if (!sessionActive.current) {
        showToast('The camera session is not running, so recording cannot start.');
        return;
      }
      if (!perms?.microphone) {
        const p = await requestExhibitCameraPermissions().catch(() => null);
        if (p) setPerms(p);
        if (!p?.microphone) {
          showToast('Microphone permission is needed for video. Enable it in Settings → Source Kit');
          return;
        }
      }
      faceGateFlag.current = await runFaceGate(); // face check at capture start
      try {
        const stamp = Date.now();
        const evidenceDir = `${FileSystem.documentDirectory}capture/evidence-${stamp}/`;
        await FileSystem.makeDirectoryAsync(evidenceDir, { intermediates: true }).catch(() => {});
        // pairIntervalSec left at the native default (5 s, min 2): periodic
        // stereo pairs, not continuous, for thermal headroom.
        const start = await withTimeout(
          startVideo({
            deliveryPath: `${FileSystem.cacheDirectory}capture-${stamp}.mp4`,
            evidenceDir,
            // The settings toggle drives a real sink: the module tees PCM, so
            // the record can say more than 'never-recorded'.
            rawPcm: settings.captureEvidence.rawPcm,
          }),
          15000,
          'Video start',
        );
        videoEvidenceDir.current = evidenceDir;
        videoPairEvents.current = []; // pair events accumulate per recording
        setRibbonParam(null); // recording safety: the wheel/ribbon park while rolling
        setRecording(true);
        recordStartMs.current = start.startedAtMs;
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        // The MAX_VIDEO_SECONDS cap keeps the whole-file AES-GCM seal in
        // memory. The timer runs the same stop path as a manual tap and states
        // the reason on screen.
        videoStopTimer.current = setTimeout(() => {
          showToast(VIDEO_CAP_NOTICE, 7000);
          void finishVideoRef.current();
        }, MAX_VIDEO_SECONDS * 1000);
      } catch (e) {
        showToast(e instanceof Error ? `Recording failed: ${e.message}` : 'Recording failed');
      }
    } else {
      void finishVideoRef.current();
    }
  };

  /**
   * The one audio save path; manual stop and interruption both land here. The
   * native module has already finalized the .m4a, and it seals like any
   * completed recording.
   */
  const saveAudioResult = useCallback(async (result: AudioStopResult, interrupted: boolean) => {
    audioSubs.current.forEach((s) => s?.remove());
    audioSubs.current = [];
    setRecording(false);
    Animated.timing(transcriptFade, { toValue: 0, duration: 200, useNativeDriver: true }).start();

    // Delivery-file sink, declared natively: nothing durable reached disk, so
    // there is no take to seal and this fails loudly rather than minting an
    // empty exhibit.
    if (result.fileState === 'failed' || !result.path) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      logDiagnostic({ t: Date.now(), kind: 'audio', outcome: 'failed', message: result.fileError ?? 'nothing reached storage' });
      showToast(`Recording could not be saved; nothing reached storage${result.fileError ? `: ${result.fileError}` : ''}. Please try again.`);
      return;
    }

    const context = await collectContext({
      includeLocation: settings.includeLocation,
      includeSensors: false, // a recording's scene is the conversation, not the accelerometer
      includeWifi: settings.includeWifi,
      motionSamples: [],
    });

    // A manual stop waits ~4s for the final transcript; an interruption does
    // not, so fall back to the last live partial for the words cut off.
    const fallback = interrupted
      ? [committedRef.current.trim(), partialRef.current.trim()].filter(Boolean).join(' ')
      : committedRef.current.trim();
    const text = result.transcript.trim() || fallback;
    const segments = result.segments ?? [];
    // The take's gyro JSONL rides into the seal like a video sensor log. The
    // ring stays a stills sink, so audio commits 'never-recorded'
    // structurally. The raw PCM master is real for audio takes: the stop
    // result's three-state report, mapped through the shared vocabulary as in
    // video (toggle off commits 'never-recorded', enabled-but-failed null).
    const captureEvidence: CaptureEvidencePaths = {
      rawPcmPath: settings.captureEvidence.rawPcm ? result.rawPcmPath ?? null : 'never-recorded',
      ringBufferDir: 'never-recorded',
      sensorLogPath: audioSensorLogEvidence(result, settings.includeSensors),
    };
    await enqueueAudioSeal({
      audioUri: result.path,
      context,
      identity,
      // The transcription toggle decides whether the words ride inside the
      // signed file; off means audio-only.
      transcript: settings.includeTranscript && text ? { text, segments, engine: 'apple-speech-ondevice' } : null,
      biometricGatePassed: faceGateFlag.current,
      captureEvidence,
    });
    // The queue copied the draft, so the raw capture file has no further job.
    await FileSystem.deleteAsync(result.path, { idempotent: true }).catch(() => {});

    // A partial take still seals, keeping custody of what survived, with the
    // truncation stated.
    const isPartial = result.fileState === 'partial';
    Haptics.notificationAsync(isPartial ? Haptics.NotificationFeedbackType.Warning : Haptics.NotificationFeedbackType.Success);
    // A partial take still sealed, stated on the toast, with the truncation
    // reason kept verbatim in the log.
    logDiagnostic({
      t: Date.now(),
      kind: 'audio',
      outcome: 'captured',
      message: isPartial ? `partial: ${result.fileError ?? 'the end could not be written'}` : undefined,
    });
    showToast(
      isPartial
        ? `Partial recording saved: the end could not be written${result.fileError ? ` (${result.fileError})` : ''}. Sealing what survived.`
        : interrupted
          ? (text ? 'Interrupted · saved what we had, with transcript' : 'Interrupted · recording saved')
          : (text ? 'Recording saved · sealing with transcript' : 'Recording saved · sealing in the background')
    );
  }, [settings, identity, showToast, transcriptFade]);

  const startAudio = async () => {
    if (audioStarting.current || recording) return; // a double-tap must not double-start the engine
    audioStarting.current = true;
    setAudioBlocked(null);
    try {
      const perms = await requestAudioPermissions();
      if (!perms.microphone) {
        setAudioBlocked({
          message:
            'Source Kit does not have microphone access, so it cannot record. iOS only asks once, so tap below to open Settings and turn the Microphone on for Source Kit.',
          needsSettings: true,
        });
        return;
      }
      const dir = `${FileSystem.documentDirectory}capture/`;
      await FileSystem.makeDirectoryAsync(dir, { intermediates: true }).catch(() => {});
      const stamp = Date.now();
      const path = `${dir}note-${stamp}.m4a`;
      // The recorder's gyro sink writes the take's IMU trace here, anchor line
      // first, spanning exactly the recorded window. Only when the
      // capture-evidence sensors toggle is on; off commits 'never-recorded'.
      const sensorLogPath = settings.includeSensors ? `${dir}note-${stamp}.sensors.jsonl` : null;
      // Raw-audio sink: the toggle video honors also records an uncompressed
      // LPCM master for audio takes, the tap's hardware frames written
      // straight through and sealed as captureEvidence.rawPcmPath.
      const rawPcmPath = settings.captureEvidence.rawPcm ? `${dir}note-${stamp}.raw.caf` : null;

      // Face check at capture start, same contract as photo and video.
      faceGateFlag.current = await runFaceGate();

      committedRef.current = '';
      partialRef.current = '';
      audioSubs.current = [
        onTranscript((e) => {
          if (e.isFinal) {
            setCommitted((c) => {
              const next = (c ? c + ' ' : '') + e.text;
              committedRef.current = next;
              return next;
            });
            setPartial('');
            partialRef.current = '';
          } else {
            setPartial(e.text);
            partialRef.current = e.text;
          }
        }),
        // The level meter subscribes itself (<LevelMeter/>), keeping ~30 dB
        // updates/s out of this component's render path.
        // iOS seized the session (phone call, Siri, alarm): the native module
        // already finalized the file at the last good frame, so save it like a
        // manual stop.
        onInterrupted((e) => {
          void saveAudioResult(e, true).catch((err) => {
            logDiagnostic({ t: Date.now(), kind: 'audio', outcome: 'failed', message: err instanceof Error ? err.message : 'Save failed' });
            showToast(err instanceof Error ? `Save failed: ${err.message}` : 'Save failed');
          });
        }),
        // Native-side hiccups (speech service, session) are surfaced rather
        // than swallowed.
        onCaptureError((e) => {
          setTranscriptionIssue(e.message);
          showToast(`Audio warning: ${e.message}`);
        }),
      ];

      const res = await startCapture(path, sensorLogPath, rawPcmPath);
      setTranscribing(res.transcribing);
      setTranscriptOffReason(res.transcriptionOffReason);
      setTranscriptionIssue(null);
      setCommitted('');
      setPartial('');
      setRecording(true);
      transcriptFade.setValue(0);
      Animated.timing(transcriptFade, { toValue: 1, duration: 450, useNativeDriver: true }).start();
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    } catch (e) {
      setAudioBlocked({
        message: e instanceof Error ? `Recording could not start: ${e.message}` : 'Recording could not start.',
        needsSettings: false,
      });
    } finally {
      audioStarting.current = false;
    }
  };

  const stopAudio = async () => {
    if (!recording || audioStopping) return;
    setAudioStopping(true);
    try {
      const result = await stopCapture();
      await saveAudioResult(result, false);
    } catch (e) {
      // An interruption that beat the tap already saved the take natively, so
      // "Not recording" here is a no-op, not a failure.
      if (!(e instanceof Error && e.message.includes('Not recording'))) {
        logDiagnostic({ t: Date.now(), kind: 'audio', outcome: 'failed', message: e instanceof Error ? e.message : 'Save failed' });
        showToast(e instanceof Error ? `Save failed: ${e.message}` : 'Save failed');
      }
    } finally {
      setAudioStopping(false);
    }
  };

  const switchMode = (m: Mode) => {
    if (recording) return;
    // The light is per mode: entering a mode re-derives the applied light from
    // that mode's persisted preference, and audio always goes dark. Photo and
    // video hops ride the same native session, so this is a chrome call, not a
    // rebuild.
    setRibbonParam(null);
    if (m === 'audio') setTorch(false);
    else if (m === 'video') setTorch(settings.videoTorch);
    else {
      // Entering photo mode turns the continuous light off and re-applies the
      // persisted strobe preference to the photo output.
      setTorch(false);
      void setPhotoFlashMode(settings.photoFlash).catch(() => {});
    }
    if (m === 'audio') {
      // The pro strip is per-shoot session state. Switching to audio collapses
      // it and returns exposure, focus, WB and bias to auto.
      resetProControls();
    }
    setMode(m);
    // A short blur veil over the preview while the fresh session settles,
    // hiding the reconfigure pop between modes.
    modeBlurAnim.setValue(0);
    Animated.sequence([
      Animated.timing(modeBlurAnim, { toValue: 30, duration: 120, useNativeDriver: false }),
      Animated.timing(modeBlurAnim, { toValue: 0, duration: 260, useNativeDriver: false }),
    ]).start();
  };

  // Swipe-to-switch wiring: a leftward swipe advances AUDIO → PHOTO → VIDEO
  // (the mode row's visual order), rightward retreats. Assigned per render, so
  // the once-created PanResponder always reads the current closure.
  modeSwipeRef.current = (dir) => {
    const i = MODE_ORDER.indexOf(mode);
    const next = MODE_ORDER[i + dir];
    if (next) switchMode(next);
  };

  const flipCamera = () => {
    // Each facing reports its own lens list; a telephoto selection doesn't
    // exist on the front camera, so always land back on the wide lens. The
    // session lifecycle effect reconfigures on the facing change.
    setRibbonParam(null);
    setLens('wide');
    commitZoom(1);
    setFacing((f) => (f === 'back' ? 'front' : 'back'));
  };

  const selectLens = async (l: ExhibitLens) => {
    // A same-lens tap must not return early on the JS state alone: if the
    // state and the live session drift (a graph teardown, or a rebuild that
    // landed on a different stack), the pill would go dead and stay dead. The
    // native call is idempotent, answering 'already-selected' when the session
    // truly is on that lens, so with a live session even same-lens taps go
    // native and the chip follows the result, which also re-parks the zoom on
    // the stop.
    if (l === lens && !sessionActive.current) return;
    if (!sessionActive.current) {
      // No live session, so nothing native to fail. The session lifecycle
      // effect applies the stored lens when the next session configures.
      setLens(l);
      commitZoom(factorForLens(stopsRef.current, l), l);
      return;
    }
    // On the virtual dual-wide graph both lenses are already live and the
    // native swap refuses every non-wide request, so the 0.5 pill is a
    // zoom-stop jump instead: the device hands off to the ultra-wide
    // constituent at 0.5 by itself. The telephoto is not on this graph.
    if (graphRef.current === 'virtual-dual-wide') {
      if (l === 'telephoto') {
        showToast('The telephoto can\u2019t join while Multiple lenses is on — turn it off in Settings to use the telephoto');
        return;
      }
      setLens(l);
      commitZoom(factorForLens(stopsRef.current, l), l);
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
      return;
    }
    // The native switch can resolve applied:false or reject outright, so the
    // chip label updates only on applied:true and states the reason
    // otherwise.
    try {
      const res = await setNativeLens(l);
      if (!res.applied) {
        // Refusals go to the diagnostics log verbatim, so a field report after
        // a dead-pill tap carries the native reason.
        logDiagnostic({ t: Date.now(), kind: 'camera', outcome: 'info', message: `lens switch to ${l} refused: ${res.reason ?? 'no reason'}` });
        showToast(res.reason === 'no-session-or-front-facing'
          ? 'Lens switch is only available on the back camera'
          : `Lens not applied${res.reason ? `: ${res.reason}` : ''}`);
        return;
      }
      // The partner stack is re-derived natively, and the old partner can be
      // the lens just switched to. Adopt the reported stereo state so the PiP
      // and the stereo caption never claim a partner that is gone.
      if (res.stereo === 'available' || res.stereo === 'unsupported') setStereo(res.stereo);
    } catch (e) {
      logDiagnostic({ t: Date.now(), kind: 'camera', outcome: 'info', message: `lens switch to ${l} errored: ${e instanceof Error ? e.message : String(e)}` });
      showToast(e instanceof Error ? `Lens unavailable: ${e.message}` : 'Lens unavailable on this device');
      return;
    }
    // An explicit lens switch taps back.
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    // A tapped pill parks the zoom at that lens's optical stop.
    setLens(l);
    commitZoom(factorForLens(stopsRef.current, l), l);
    // The new device stack has its own active format, so refresh the pro
    // ranges and zoom range to clamp against this lens.
    void capabilities()
      .then((c) => {
        if (!c) return;
        setProCaps(c);
        if (c.zoomRange) setZoomRange(c.zoomRange);
        setLensCaps(c.lensZoomCaps ?? null);
      })
      .catch(() => {});
  };

  /**
   * Tap-to-focus: a single-finger tap on the preview sets the focus and
   * exposure points together (normalized 0-1, top-left origin). The pinch
   * guard keeps the trailing finger-lift of a zoom gesture from re-focusing.
   * With the Value Ribbon docked, the first preview tap closes it and does not
   * move the focus point.
   */
  const previewSize = useRef({ w: 0, h: 0 });
  const handlePreviewTap = (e: GestureResponderEvent) => {
    if (mode === 'audio' || !sessionActive.current || pinchRef.current) return;
    if (ribbonParam) {
      setRibbonParam(null);
      return;
    }
    const { w, h } = previewSize.current;
    if (w <= 0 || h <= 0) return;
    const x = clamp01(e.nativeEvent.locationX / w);
    const y = clamp01(e.nativeEvent.locationY / h);
    void setFocusPoint(x, y);
    void setExposurePoint(x, y);
  };

  // ------------------------------------------------------------------
  // Pro strip logic (spec §14). Every setter goes through withTimeout, so a
  // wedged native call surfaces as a one-line toast rather than a frozen
  // strip. Capsules store the bridge's applied values (clamped ISO, duration
  // and lensPosition, round-tripped WB temperature), which is what the next
  // capture's metadata block commits.
  // ------------------------------------------------------------------

  /** The strip renders only when the hardware reports a manual control. */
  const proAvailable = !!proCaps && !!(
    proCaps.exposureModes?.locked || proCaps.exposureModes?.custom ||
    proCaps.focusModes?.locked || proCaps.focusModes?.manual ||
    proCaps.whiteBalanceModes?.locked || proCaps.whiteBalanceModes?.manual
  );
  /** True while the dual-view graph is live: second camera attached, both
   *  lenses streaming. The 0.5/1 pills are zoom stops on this graph rather
   *  than switches, so they hide while this holds. The pro tray stays; only
   *  the per-constituent controls (focus/WB/ISO/shutter) hide, while
   *  flash/torch and EV keep working on the fused device (see
   *  visibleProParams). Turning Multiple Lenses off rebuilds the session
   *  (altView is a lifecycle dep) and everything returns. */
  const dualLive = facing === 'back' && stereo === 'available' && settings.captureEvidence.altView;
  /** True when this capture's optics were chosen by hand; the metadata
   *  carries the device read-back values. */
  const proManualActive =
    exposureMode !== 'auto' || focusMode !== 'auto' || wbMode !== 'auto' || bias !== 0;

  const togglePro = () => {
    if (proOpen) {
      // Collapsing keeps the applied settings: the strip is a view onto
      // session state, not the state itself. The precision bar docks with a
      // capsule, so it closes with the tray.
      setRibbonParam(null);
      Animated.timing(proAnim, { toValue: 0, duration: 160, useNativeDriver: true })
        .start(() => setProOpen(false));
    } else {
      proAnim.setValue(0);
      setProOpen(true);
      Animated.timing(proAnim, { toValue: 1, duration: 200, useNativeDriver: true }).start();
    }
  };

  const resetProControls = () => {
    proAnim.setValue(0);
    setProOpen(false);
    setRibbonParam(null);
    setExposureModeState('auto');
    setFocusModeState('auto');
    setWbModeState('auto');
    setBias(0);
    if (sessionActive.current) {
      void setExposureMode({ mode: 'auto' }).catch(() => {});
      void setFocusMode({ mode: 'auto' }).catch(() => {});
      void setWhiteBalanceMode({ mode: 'auto' }).catch(() => {});
      void setExposureBias(0).catch(() => {});
    }
  };

  const applyExposure = async (m: ExposureModeSetting, nextIso?: number, nextShutter?: number) => {
    try {
      const res = await withTimeout(
        setExposureMode(m === 'custom' ? { mode: m, iso: nextIso, durationSeconds: nextShutter } : { mode: m }),
        5000,
        'Exposure',
      );
      if (!res.applied) {
        showToast(`Exposure not applied${res.reason ? `: ${res.reason}` : ''}`);
        return;
      }
      setExposureModeState(m);
      // The capsule shows the clamped values the device accepted.
      if (m === 'custom') {
        if (typeof res.iso === 'number') setIso(res.iso);
        if (typeof res.durationSeconds === 'number') setShutter(res.durationSeconds);
      }
    } catch (e) {
      showToast(e instanceof Error ? `Exposure failed: ${e.message}` : 'Exposure failed');
    }
  };

  const applyFocus = async (m: FocusModeSetting, lp?: number) => {
    try {
      const res = await withTimeout(
        setFocusMode(m === 'manual' ? { mode: m, lensPosition: lp } : { mode: m }),
        5000,
        'Focus',
      );
      if (!res.applied) {
        showToast(`Focus not applied${res.reason ? `: ${res.reason}` : ''}`);
        return;
      }
      setFocusModeState(m);
      if (m === 'manual' && typeof res.lensPosition === 'number') setLensPosition(res.lensPosition);
    } catch (e) {
      showToast(e instanceof Error ? `Focus failed: ${e.message}` : 'Focus failed');
    }
  };

  const applyWhiteBalance = async (m: WhiteBalanceModeSetting, temp?: number) => {
    try {
      const res = await withTimeout(
        setWhiteBalanceMode(m === 'manual' ? { mode: m, temperature: temp, tint: 0 } : { mode: m }),
        5000,
        'White balance',
      );
      if (!res.applied) {
        showToast(`White balance not applied${res.reason ? `: ${res.reason}` : ''}`);
        return;
      }
      setWbModeState(m);
      // Round-tripped from the clamped gains — what the hardware accepted.
      if (m === 'manual' && typeof res.appliedTemperature === 'number') {
        setWbTemp(Math.round(res.appliedTemperature));
      }
    } catch (e) {
      showToast(e instanceof Error ? `White balance failed: ${e.message}` : 'White balance failed');
    }
  };

  const applyBias = async (v: number) => {
    try {
      const res = await withTimeout(setExposureBias(v), 5000, 'Exposure bias');
      if (!res.applied) {
        showToast(`Exposure bias not applied${res.reason ? `: ${res.reason}` : ''}`);
        return;
      }
      setBias(v);
    } catch (e) {
      showToast(e instanceof Error ? `Bias failed: ${e.message}` : 'Bias failed');
    }
  };

  // ------------------------------------------------------------------
  // The precision bar, the only adjustment surface. Every pro param docks
  // here: ladder params scrub integer rung indices (snap 1, a detent per rung,
  // rung 0 = AUTO where the hardware has one), continuous params scrub their
  // native range (SHTR in stops, so a uniform drag is a uniform exposure
  // change). Live scrubs apply natively on a throttle without React state,
  // since the ribbon leaf owns its drag; the commit lands the bridge's applied
  // value in state. The AUTO pill is the auto/manual toggle, and scrubbing a
  // value enters manual.
  // ------------------------------------------------------------------
  /** ISO range of the active format (device-reported), else the ladder's own
   *  ends. */
  const isoRange: [number, number] = proCaps?.activeFormatISO
    ? [proCaps.activeFormatISO.min, proCaps.activeFormatISO.max]
    : [ISO_LADDER[0], ISO_LADDER[ISO_LADDER.length - 1]];
  const durRange: [number, number] = proCaps?.activeFormatExposureDurationSec
    ? [proCaps.activeFormatExposureDurationSec.min, proCaps.activeFormatExposureDurationSec.max]
    : [SHUTTER_LADDER[0], SHUTTER_LADDER[SHUTTER_LADDER.length - 1]];

  const ribbonLiveAt = useRef(0);
  const ribbonLive = (fn: () => void) => {
    const now = Date.now();
    if (now - ribbonLiveAt.current < 80 || !sessionActive.current) return;
    ribbonLiveAt.current = now;
    fn();
  };

  /** Builds every param's ribbon session: config plus handlers, described
   *  uniformly per the pro-param model. */
  const ribbonFor = (
    p: ProParamId | null,
  ): { config: RibbonConfig; onLive: (v: number) => void; onCommit: (v: number) => void; onReset: () => void } | null => {
    switch (p) {
      // FLASH/TORCH has no ribbon; it is a two- or three-state preference and
      // the capsule alternates on tap (see cycleLight). The default arm keeps
      // ribbonFor correct if a stale ribbonParam ever names it.
      case 'ev':
        return {
          config: {
            title: 'EV',
            min: BIAS_MIN,
            max: BIAS_MAX,
            value: bias,
            snap: 0.1,
            detents: [-2, -1, 0, 1, 2],
            ticks: [-2, -1.5, -1, -0.5, 0, 0.5, 1, 1.5, 2],
            format: formatBias,
            isAuto: bias === 0,
            // EV's auto is zero compensation, a value, so the bar stays
            // docked.
            onAuto: () => void applyBias(0),
          },
          onLive: (v) => ribbonLive(() => void setExposureBias(v).catch(() => {})),
          onCommit: (v) => void applyBias(v),
          onReset: () => void applyBias(0),
        };
      case 'focus': {
        // A five-rung ladder would make the whole manual range four coarse
        // jumps. [0,1) is the AUTO zone; [1, 11] is continuous lensPosition
        // ((v-1)/10 with snap 0.05 = 0.005 motor steps), with haptic detents
        // and tick marks at the ladder positions as landmarks.
        const AUTO_ZONE = 1;
        const domain = { min: 0, max: 11 };
        const toLens = (v: number) => Math.min(1, Math.max(0, (v - AUTO_ZONE) / 10));
        const fromLens = (p: number) => AUTO_ZONE + p * 10;
        const marks = [0, ...FOCUS_LADDER.map(fromLens)];
        const toAuto = () => {
          void applyFocus('auto');
          setRibbonParam(null); // auto has no scrubbable value — close
        };
        return {
          config: {
            title: 'FOCUS',
            ...domain,
            value: focusMode === 'manual' ? fromLens(lensPosition) : 0,
            snap: 0.05,
            detents: marks,
            ticks: marks,
            format: (v) => (v < AUTO_ZONE ? 'AUTO' : toLens(v).toFixed(2)),
            isAuto: focusMode === 'auto',
            onAuto: toAuto,
          },
          onLive: (v) => {
            if (v >= AUTO_ZONE) {
              ribbonLive(() => void setFocusMode({ mode: 'manual', lensPosition: toLens(v) }).catch(() => {}));
            }
          },
          onCommit: (v) => {
            if (v < AUTO_ZONE) toAuto();
            else void applyFocus('manual', toLens(v));
          },
          onReset: toAuto,
        };
      }
      case 'wb': {
        // Rung 0 is AUTO; rungs 1..N are the WB_LADDER temperatures.
        const rungs = WB_LADDER.map((_, i) => i + 1);
        const domain = { min: 0, max: WB_LADDER.length };
        const rungValue = (v: number) => WB_LADDER[Math.min(Math.max(Math.round(v) - 1, 0), WB_LADDER.length - 1)];
        const toAuto = () => {
          void applyWhiteBalance('auto');
          setRibbonParam(null);
        };
        return {
          config: {
            title: 'WB',
            ...domain,
            value: wbMode === 'manual' ? nearestLadderIndex(WB_LADDER, wbTemp) + 1 : 0,
            snap: 1,
            detents: [0, ...rungs],
            ticks: [0, ...rungs],
            format: (v) => (Math.round(v) <= 0 ? 'AUTO' : `${rungValue(v)}K`),
            isAuto: wbMode === 'auto',
            onAuto: toAuto,
          },
          onLive: (v) => {
            if (Math.round(v) >= 1) {
              ribbonLive(() => void setWhiteBalanceMode({ mode: 'manual', temperature: rungValue(v), tint: 0 }).catch(() => {}));
            }
          },
          onCommit: (v) => {
            if (Math.round(v) <= 0) toAuto();
            else void applyWhiteBalance('manual', rungValue(v));
          },
          onReset: toAuto,
        };
      }
      case 'iso': {
        const [lo, hi] = isoRange;
        const toAuto = () => {
          void applyExposure('auto');
          setRibbonParam(null);
        };
        // ISO rides a log2 domain like SHTR: one doubling is one stop and a
        // uniform drag step, the ladder ticks space evenly instead of bunching
        // at the low end, and 1/3-stop snap matches the shutter ribbon.
        const loL = Math.log2(lo);
        const hiL = Math.log2(hi);
        const ticks = ISO_LADDER.filter((v) => v >= lo && v <= hi).map((v) => Math.log2(v));
        return {
          config: {
            title: 'ISO',
            min: loL,
            max: hiL,
            value: Math.min(hiL, Math.max(loL, Math.log2(Math.min(hi, Math.max(lo, iso))))),
            snap: 1 / 3,
            detents: ticks,
            ticks,
            format: (v) => String(Math.round(Math.pow(2, v))),
            // Scrubbing ISO puts the exposure in custom mode, which is
            // manual. AUTO returns the whole exposure to auto.
            isAuto: exposureMode !== 'custom',
            onAuto: toAuto,
          },
          onLive: (v) =>
            ribbonLive(() => void setExposureMode({ mode: 'custom', iso: Math.round(Math.pow(2, v)), durationSeconds: shutter }).catch(() => {})),
          onCommit: (v) => void applyExposure('custom', Math.round(Math.pow(2, v)), shutter),
          onReset: toAuto,
        };
      }
      case 'shtr': {
        // Stop domain: log2(seconds), so a uniform drag is a uniform exposure
        // change across 1/8000…1 s; 1/3-stop snap.
        const lo = Math.log2(durRange[0]);
        const hi = Math.log2(durRange[1]);
        const ticks = SHUTTER_LADDER.filter((d) => d >= durRange[0] && d <= durRange[1]).map((d) => Math.log2(d));
        const toAuto = () => {
          void applyExposure('auto');
          setRibbonParam(null);
        };
        return {
          config: {
            title: 'SHTR',
            min: lo,
            max: hi,
            value: Math.min(hi, Math.max(lo, Math.log2(shutter))),
            snap: 1 / 3,
            detents: ticks,
            ticks,
            format: (v) => formatShutter(Math.pow(2, v)),
            isAuto: exposureMode !== 'custom',
            onAuto: toAuto,
          },
          onLive: (v) =>
            ribbonLive(() => void setExposureMode({ mode: 'custom', iso, durationSeconds: Math.pow(2, v) }).catch(() => {})),
          onCommit: (v) => void applyExposure('custom', iso, Math.pow(2, v)),
          onReset: toAuto,
        };
      }
      default:
        return null;
    }
  };

  // On the dual-view graph the tray stays, filtered to the controls that apply
  // to the fused virtual device. Flash/torch is an output-level policy and EV
  // is metering compensation on the virtual device, so both work. The
  // per-constituent manual controls (focus motor, WB gains, custom
  // ISO/shutter) target one sensor of a fused pair and error there, so they
  // hide while dual is live. A ribbon docked on a hidden param is suppressed
  // with its capsule.
  const DUAL_SAFE_PARAMS: readonly ProParamId[] = ['flash', 'ev'];
  const ribbon = ribbonFor(dualLive && ribbonParam && !DUAL_SAFE_PARAMS.includes(ribbonParam) ? null : ribbonParam);

  /** Capsule tap docks the precision bar with that param; re-tap dismisses. */
  const toggleRibbon = (p: ProParamId) => {
    Haptics.selectionAsync();
    setRibbonParam((cur) => (cur === p ? null : p));
  };

  /** Swipe-down dismiss is not a commit: live scrubs already reached the
   *  device, so re-apply the committed pro state on the way out. */
  const dismissRibbon = () => {
    const p = proStateRef.current;
    if (sessionActive.current) {
      void setExposureMode(p.exposureMode === 'custom'
        ? { mode: 'custom', iso: p.iso, durationSeconds: p.shutter }
        : { mode: p.exposureMode }).catch(() => {});
      void setFocusMode(p.focusMode === 'manual'
        ? { mode: 'manual', lensPosition: p.lensPosition }
        : { mode: p.focusMode }).catch(() => {});
      void setWhiteBalanceMode(p.wbMode === 'manual'
        ? { mode: 'manual', temperature: p.wbTemp, tint: 0 }
        : { mode: p.wbMode }).catch(() => {});
      void setExposureBias(p.bias).catch(() => {});
    }
    setRibbonParam(null);
  };

  // The tray: one row of equal-width capsules built from the pro-param model.
  // Capability-gated, so a control the hardware does not report is not shown.
  // Geometry is flex-equalized, so widths never change on tap, on value, or on
  // active state.
  const proParams: ProParam[] = [
    {
      id: 'flash',
      label: mode === 'video' ? 'TORCH' : 'FLASH',
      valueText: mode === 'video' ? (settings.videoTorch ? 'ON' : 'OFF') : settings.photoFlash.toUpperCase(),
      mode: (mode === 'video' ? settings.videoTorch : settings.photoFlash !== 'auto') ? 'manual' : 'auto',
      kind: 'ladder',
    },
    {
      id: 'ev',
      label: 'EV',
      // Manual ISO+shutter supersedes metering compensation: while the
      // exposure is custom, EV shows as overruled (value '—') and its capsule
      // explains itself on tap instead of scrubbing a dead value.
      valueText: exposureMode === 'custom' ? '—' : formatBias(bias),
      mode: bias !== 0 ? 'manual' : 'auto',
      kind: 'continuous',
      overridden: exposureMode === 'custom',
    },
  ];
  if (proCaps?.focusModes?.manual) {
    proParams.push({
      id: 'focus',
      label: 'FOCUS',
      valueText: focusMode === 'manual' ? lensPosition.toFixed(2) : focusMode === 'locked' ? 'LOCK' : 'AUTO',
      mode: focusMode === 'auto' ? 'auto' : 'manual',
      kind: 'ladder',
    });
  }
  if (proCaps?.whiteBalanceModes?.manual) {
    proParams.push({
      id: 'wb',
      label: 'WB',
      valueText: wbMode === 'manual' ? `${wbTemp}K` : wbMode === 'locked' ? 'LOCK' : 'AUTO',
      mode: wbMode === 'auto' ? 'auto' : 'manual',
      kind: 'ladder',
    });
  }
  if (proCaps?.exposureModes?.custom) {
    proParams.push(
      {
        id: 'iso',
        label: 'ISO',
        valueText: exposureMode === 'custom' ? String(Math.round(iso)) : 'AUTO',
        mode: exposureMode === 'custom' ? 'manual' : 'auto',
        kind: 'continuous',
      },
      {
        id: 'shtr',
        label: 'SHTR',
        valueText: exposureMode === 'custom' ? formatShutter(shutter) : 'AUTO',
        mode: exposureMode === 'custom' ? 'manual' : 'auto',
        kind: 'continuous',
      },
    );
  }

  // Declared after proParams is fully built, so the dual-live filter reads
  // the complete param list.
  const visibleProParams = dualLive ? proParams.filter((p) => DUAL_SAFE_PARAMS.includes(p.id)) : proParams;

  // ------------------------------------------------------------------
  // Light, per mode: PHOTO has a flash preference (auto/on/off, bolt glyph
  // plus state badge), VIDEO has the torch (on/off, flashlight glyph). Both
  // persist in settings and never share a light state.
  // ------------------------------------------------------------------

  /**
   * Photo-flash preference: persists in settings and drives the photo output's
   * flashMode via the native setPhotoFlashMode bridge. It never drives the
   * torch, which stays the video-only continuous light. The preference is
   * validated natively against supportedFlashModes at capture time, and the
   * capture commits what happened (captureSettings.photoFlashApplied and
   * .flashFired).
   */
  const setPhotoFlashPreference = (pref: 'auto' | 'on' | 'off') => {
    void saveSettings({ photoFlash: pref });
    if (modeRef.current === 'picture') void setPhotoFlashMode(pref).catch(() => {});
  };

  /** Video continuous light: persist the preference and apply it while the
   *  video session is live. */
  const setVideoTorchPreference = (on: boolean) => {
    void saveSettings({ videoTorch: on });
    if (modeRef.current === 'video') setTorch(on);
  };

  // The light capsule is an alternating button, not a slider: each tap
  // advances the mode's preference one rung and applies it immediately (photo
  // auto → on → off → auto; video torch off → on → off). The capsule's
  // valueText states the new rung.
  const cycleLight = () => {
    if (mode === 'video') {
      setVideoTorchPreference(!settings.videoTorch);
      return;
    }
    const order: Array<'auto' | 'on' | 'off'> = ['auto', 'on', 'off'];
    const next = order[(order.indexOf(settings.photoFlash) + 1) % order.length] ?? 'auto';
    setPhotoFlashPreference(next);
  };

  // Audio subscriptions, the video cap timer, the pinch lerp loop and the zoom
  // throttle timer all die with the screen.
  useEffect(() => () => {
    audioSubs.current.forEach((s) => s?.remove());
    if (videoStopTimer.current) clearTimeout(videoStopTimer.current);
    if (pinchRaf.current) cancelAnimationFrame(pinchRaf.current);
    if (zoomNativeTimer.current) clearTimeout(zoomNativeTimer.current);
  }, []);

  // ---- permission gates ----
  if (!perms) return <View style={styles.root} />;
  if (!perms.camera) {
    return (
      <SafeAreaView style={styles.root}>
        <View style={styles.permissionBox}>
          <Ionicons name="camera-outline" size={44} color={colors.textFaint} />
          <Text style={styles.permissionTitle}>Camera access required</Text>
          <Text style={styles.permissionBody}>
            Source Kit captures and signs media entirely on this device. Nothing leaves it.
            {isExhibitCameraAvailable()
              ? ''
              : ' The native camera module is not in this build, so photo and video capture stay unavailable even with permission granted.'}
          </Text>
          {isExhibitCameraAvailable() ? (
            <TouchableOpacity
              style={styles.permissionButton}
              onPress={() => {
                void requestExhibitCameraPermissions().then(setPerms).catch(() => {});
              }}
            >
              <Text style={styles.permissionButtonText}>Grant camera access</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      </SafeAreaView>
    );
  }

  return (
    <View style={styles.root} {...panResponder.panHandlers}>
      {/* The native ExhibitCamera preview. Grid, HUD and controls are JS
          overlays drawn above it, never in the committed pixels. Single-finger
          taps here are tap-to-focus (focus and exposure point together);
          pinches are claimed by the root PanResponder before they reach this
          wrapper. */}
      <View
        style={StyleSheet.absoluteFill}
        onLayout={(e) => {
          previewSize.current = { w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height };
        }}
        onTouchEnd={handlePreviewTap}
      >
        {ExhibitCameraPreview ? (
          <ExhibitCameraPreview
            style={StyleSheet.absoluteFill}
            lens={lens}
            // Alt-view PiP: the second camera's live feed in a corner inset,
            // shown while it is attached. Natively bound to the secondary
            // input.
            altPreview={
              facing === 'back' && mode !== 'audio' && stereo === 'available' && settings.captureEvidence.altView
            }
          />
        ) : (
          <View style={[StyleSheet.absoluteFill, { backgroundColor: '#000' }]} />
        )}
      </View>

      {/* Mode-transition veil: a short blur pulse while the fresh session
          settles. Renders under the scrims and chrome. */}
      <AnimatedBlur
        intensity={modeBlurAnim}
        tint="dark"
        pointerEvents="none"
        style={StyleSheet.absoluteFill}
      />

      {/* Gradient translucency: the chrome floats on near-black scrims that
          fade into the viewfinder. No solid bars, no card backgrounds under
          the shutter row. */}
      <LinearGradient
        colors={['rgba(0,0,0,0.55)', 'transparent']}
        style={styles.scrimTop}
        pointerEvents="none"
      />
      <LinearGradient
        colors={['transparent', 'rgba(0,0,0,0.6)']}
        style={styles.scrimBottom}
        pointerEvents="none"
      />

      {/* Audio mode: the viewfinder dims and the recording stage floats over
          it, with no header and no separate screen. The transcript fades on as
          you speak; the words seal inside the file only while the
          transcription toggle beside the shutter is on.
          Z-order: this full-screen dim renders before the HUD, so the seal
          pill, lock badge, toggles and timer sit above it. */}
      {mode === 'audio' ? (
        <View style={styles.audioStage} pointerEvents="none">
          {recording ? (
            <View style={styles.audioRecBox}>
              <View style={styles.audioLiveRow}>
                <View style={styles.recDot} />
                <RecordTimer style={styles.audioLiveText} />
              </View>
              <LevelMeter />
              {settings.includeTranscript && transcribing && !transcriptionIssue ? (
                <Animated.View style={[styles.audioTranscriptWrap, { opacity: transcriptFade }]}>
                  <ScrollView style={styles.audioTranscriptScroll} contentContainerStyle={{ paddingVertical: spacing.sm }}>
                    {committed ? <Text style={styles.audioTranscriptFinal}>{committed} </Text> : null}
                    {partial ? (
                      <Text style={styles.audioTranscriptPartial}>{partial}</Text>
                    ) : !committed ? (
                      <Text style={styles.audioHint}>Listening. Transcription appears here as you speak.</Text>
                    ) : null}
                  </ScrollView>
                </Animated.View>
              ) : (
                <Text style={styles.audioHint}>
                  {transcriptionIssue
                    ? `Transcription stopped (${transcriptionIssue}). The recording is still signed and sealed.`
                    : !settings.includeTranscript
                      ? 'Transcription is off. The toggle beside the shutter seals the words inside the file.'
                      : transcriptOffReason === 'denied'
                        ? 'Transcription is off: speech recognition permission wasn’t granted. The note is still signed and sealed. Enable it in Settings → Source Kit → Speech Recognition.'
                        : transcriptOffReason === 'restricted'
                          ? 'Transcription is off: speech recognition is restricted on this device (Screen Time / MDM). The note is still signed and sealed.'
                          : 'On-device transcription is not available for this device or language. The note is still signed and sealed.'}
                </Text>
              )}
            </View>
          ) : (
            <View style={styles.audioIdleBox}>
              <Ionicons name="mic-outline" size={34} color={colors.onDark.dim} />
              <Text style={styles.audioHint}>
                {audioCaptureAvailable()
                  ? 'Signed and sealed on this device, exactly like a photo. Nothing leaves the device for transcription.'
                  : 'Audio recording needs the native audio module, which isn’t in this build. It appears after the next TestFlight build.'}
              </Text>
            </View>
          )}
        </View>
      ) : null}

      {/* The top HUD is one column stack, laid out by flexbox, so the seal
          pill and the proof-toggle row cannot overlap; the toggle row wraps
          and its pills shrink rather than spilling off the edges.
          The seal pill is the camera's one status element, with three states:
          Sealing on / Sealing… / Sealed. Every pill is the hudpill:
          translucent dark glass (blur 8), a 1px hairline, a status dot and a
          10.5/700 label. The "Sealed" flash is a green gradient, fired only on
          a real completion. */}
      <SafeAreaView edges={['top']} style={styles.hudStack} pointerEvents="box-none">
        {sealedFlash ? (
          <LinearGradient
            colors={[colors.accentGradStart, colors.accentGradEnd]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={[styles.hudPill, styles.sealPill, styles.sealPillFlash]}
          >
            <View style={[styles.hudDot, { backgroundColor: '#FFFFFF' }]} />
            <Text style={[styles.hudPillText, { color: '#FFFFFF' }]}>Sealed</Text>
          </LinearGradient>
        ) : (
          <BlurView intensity={8} tint="dark" style={[styles.hudPill, styles.sealPill]}>
            {/* Sage = sealing armed (steady),
                clay = the queue is draining. */}
            <View style={[styles.hudDot, pendingSeals > 0 ? styles.hudDotBusy : styles.hudDotGreen]} />
            <Text style={styles.hudPillText}>
              {pendingSeals > 0 ? 'Sealing…' : 'Sealing on'}
            </Text>
            {pendingSeals === 0 ? (
              <Text style={styles.sealPillFp}>{fingerprint || '………'}</Text>
            ) : null}
          </BlurView>
        )}

        {/* Proof HUD: what will be embedded, visible before the shutter.
            Each is a glass pill with a status dot, filled and tinted when on,
            a hollow ring when off, so the dot's shape carries the state. */}
        <View style={styles.hudToggleRow}>
          <HudPillToggle
            label="Location"
            on={settings.includeLocation}
            onColor={HUD_IDENT_ON}
            accessibilityLabel={`Location embedding ${settings.includeLocation ? 'on' : 'off'}`}
            onPress={() => {
              void saveSettings({ includeLocation: !settings.includeLocation });
              if (!settings.includeLocation) void requestCapturePermissions(true);
            }}
          />
          <HudPillToggle
            label="Byline"
            on={settings.includeByline}
            onColor={HUD_IDENT_ON}
            accessibilityLabel={`Byline embedding ${settings.includeByline ? 'on' : 'off'}`}
            onPress={() =>
              void saveSettings(
                settings.includeByline
                  ? { includeByline: false }
                  // Turning Byline on sets the capture identity to 'named' so
                  // the byline genuinely embeds.
                  : { includeByline: true, identityMode: 'named' }
              )
            }
          />
        </View>
      </SafeAreaView>

      {/* Top-left HUD column: the sealing lock, green whenever sealing is on.
          Tapping the lock replays the onboarding tour. The flash/torch control
          is not here; it is the first chip of the pro strip. */}
      <SafeAreaView edges={['top']} style={styles.hudLock} pointerEvents="box-none">
        <TouchableOpacity
          style={styles.hudLockBadge}
          hitSlop={12}
          onPress={() => router.push('/onboarding')}
          accessibilityLabel="Replay the intro"
        >
          <Ionicons name="lock-closed-outline" size={14} color={HUD_SEAL_GREEN} />
        </TouchableOpacity>
      </SafeAreaView>

      {/* Recording indicator (photo/video; the audio stage carries its own).
          Safe-area wrapped: the HUD stack above it is inset-padded, and top:96
          clears the stack (seal pill, toggle row, breathing room) in the same
          inset space, including on Dynamic-Island devices. */}
      {recording && mode !== 'audio' ? (
        <SafeAreaView edges={['top']} style={styles.recWrap} pointerEvents="none">
          <View style={styles.recIndicator}>
            <View style={styles.recDot} />
            <RecordTimer style={styles.recText} />
          </View>
        </SafeAreaView>
      ) : null}

      {/* Zoom readout: the 35mm-equivalent focal length ("≈27mm") only, while
          a pinch or wheel drives the zoom, or whenever zoomed off an optical
          stop. No x factor and no digital marker; the lens pills below carry
          the factor. Stacks under the recording pill (96 + pill height) in
          shared inset space. It is a leaf on the live channel, so the
          viewfinder tree never re-renders for it. */}
      {mode !== 'audio' ? (
        <SafeAreaView edges={['top']} style={styles.zoomWrap} pointerEvents="none">
          <ZoomHud channel={zoomChannel} stops={activeStops} baseMm={baseMm} />
        </SafeAreaView>
      ) : null}

      {/* Bottom controls, lifted clear of the floating pill tab bar (dock
          offset 12 + pill height 64 + 14 breathing room), honoring the
          home-indicator inset when it is larger. */}
      <View style={[styles.controls, { paddingBottom: Math.max(insets.bottom, 12) + 64 + 14 }]}>
        {/* Selfie camera with the second-lens toggle on but no partner stack
            on the front camera. Shown only while the toggle is on, and the
            longer stereo caption never shows on the selfie camera. */}
        {facing === 'front' && settings.captureEvidence.altView && mode !== 'audio' ? (
          <Text style={styles.stereoCaption}>Dual camera not available</Text>
        ) : /* Stereo availability: 'unsupported' is one quiet gray caption;
               'unreached' (not probed, or no permission) renders nothing.
               One wording everywhere. Gated on the Multiple Lenses toggle,
               since with it off the dual path is not expected. */
        stereo === 'unsupported' && facing === 'back' && mode !== 'audio' && settings.captureEvidence.altView ? (
          <Text style={styles.stereoCaption}>Dual camera not available</Text>
        ) : null}

        {/* Zoom control: optical pills for the lenses the hardware reports (a
            tap is a genuine optical jump between real cameras, not a crop),
            and a horizontal drag anywhere on the row turns it into the smooth
            zoom wheel. Hidden while recording and in audio mode. On the
            single-stack front camera the wheel sweeps 1x to the digital
            cap. */}
        {!recording && mode !== 'audio' ? (
          <ZoomWheel
            channel={zoomChannel}
            stops={activeStops}
            currentLens={lens}
            maxZoom={zoomCeiling()}
            onJump={(l) => void selectLens(l)}
            onLive={applyLiveZoom}
            onCommit={commitZoom}
            // No .5/1 pills while the dual-view graph is live, the same
            // condition as the PiP: they vanish while the second camera is
            // attached and return when Multiple Lenses is off.
            hidePills={dualLive}
          />
        ) : null}
        {/* Pro tray: quiet and horizontal, above the mode/shutter cluster.
            Equal-width capsules built from the pro-param model; a tap docks the
            precision bar, the only adjustment surface. Values are the bridge's
            applied values, so a device clamp shows the clamped number. The row
            leads with the mode's light (FLASH / TORCH), then EV, FOCUS, WB,
            ISO, SHTR as the hardware reports them. */}
        {proOpen && (proAvailable || dualLive) && mode !== 'audio' ? (
          // alignSelf stretch is required here: `controls` centers its
          // children, and an unstyled wrapper shrink-wraps to content, which
          // collapses the capsules to strips.
          <View ref={trayWrapRef} onLayout={measureGestureZones} collapsable={false} style={styles.trayWrap}>
          <Animated.View
            style={[
              styles.proStrip,
              {
                opacity: proAnim,
                transform: [{ translateY: proAnim.interpolate({ inputRange: [0, 1], outputRange: [14, 0] }) }],
              },
            ]}
          >
            {/* One row of equal-width capsules from the pro-param model: flex:1
                each, same padding, typography, radius and hairline, with a 5px
                clay dot when manual. A tap docks the precision bar; the capsule
                has no gestures of its own.
                Manual ISO+shutter supersedes metering compensation, so the EV
                capsule shows as overruled (dimmed, '—') while the exposure is
                custom. FLASH/TORCH leads the row, and the label says TORCH in
                video mode. */}
            <View style={styles.proTrayRow}>
              {visibleProParams.map((p) => (
                <ParamCapsule
                  key={p.id}
                  label={p.label}
                  valueText={p.valueText}
                  manual={p.mode === 'manual'}
                  overridden={p.overridden}
                  busy={p.id === 'focus' && focusAdjusting}
                  open={ribbonParam === p.id}
                  accessibilityLabel={
                    p.overridden
                      ? `${p.label} overruled by manual ISO and shutter`
                      : p.id === 'flash'
                        ? `${p.label} ${p.valueText}, tap to switch`
                        : `${p.label} ${p.valueText}, tap to adjust`
                  }
                  onPress={() => {
                    if (p.overridden) {
                      showToast('Manual ISO and shutter set the exposure');
                      return;
                    }
                    if (p.id === 'flash') {
                      cycleLight();
                      return;
                    }
                    toggleRibbon(p.id);
                  }}
                />
              ))}
            </View>
          </Animated.View>
          </View>
        ) : null}

        {/* The precision-bar dock, directly above the mode/shutter cluster.
            One param at a time, keyed so a param switch remounts the bar at
            the right value. */}
        {ribbon && mode !== 'audio' ? (
          <View ref={ribbonWrapRef} onLayout={measureGestureZones} collapsable={false} style={styles.trayWrap}>
            <ValueRibbon
              key={ribbonParam}
              config={ribbon.config}
              onLive={ribbon.onLive}
              onCommit={ribbon.onCommit}
              onReset={ribbon.onReset}
              onDismiss={dismissRibbon}
            />
          </View>
        ) : null}

        {/* Mode labels with the sliding highlight pill: crossfade and
            translate on the native driver, traveling toward the newly active
            label. */}
        <ModeSwitcher mode={mode} onSwitch={switchMode} disabled={recording} />

        <View style={styles.shutterRow}>
          {mode === 'audio' ? (
            // Transcription toggle: the same pill language as the HUD, filled
            // with dark ink when on, dim outline icon when off.
            <TouchableOpacity
              style={[styles.sideButton, styles.transcriptToggle, settings.includeTranscript && styles.transcriptToggleOn]}
              hitSlop={8}
              accessibilityLabel={`Transcription ${settings.includeTranscript ? 'on' : 'off'}`}
              onPress={() => void saveSettings({ includeTranscript: !settings.includeTranscript })}
            >
              <Ionicons
                name={settings.includeTranscript ? 'document-text' : 'document-text-outline'}
                size={20}
                color={settings.includeTranscript ? HUD_INK : colors.onDark.dim}
              />
            </TouchableOpacity>
          ) : proAvailable ? (
            // Capture settings: a dials glyph on the shutter row's left slot
            // opens the pro tray. The light (flash / torch) is the tray's first
            // chip, not a HUD button. The accent color signals that this
            // capture's optics were chosen by hand. The button stays while the
            // dual-view graph is live; the tray narrows to the dual-safe
            // controls (visibleProParams filters to DUAL_SAFE_PARAMS).
            <TouchableOpacity
              style={styles.sideButton}
              hitSlop={8}
              onPress={togglePro}
              disabled={recording}
              accessibilityLabel={`Capture settings ${proOpen ? 'open' : 'closed'}`}
            >
              <Ionicons
                name="options-outline"
                size={22}
                color={proOpen || proManualActive ? colors.onDark.accent : colors.onDark.dim}
              />
            </TouchableOpacity>
          ) : (
            // No manual controls on this hardware: keep the shutter centered.
            <View style={styles.sideButton} />
          )}

          <TouchableOpacity
            onPress={mode === 'picture' ? capturePhoto : mode === 'video' ? toggleVideo : recording ? stopAudio : startAudio}
            activeOpacity={0.8}
            disabled={mode === 'audio' && audioStopping}
            style={[styles.shutterOuter, (mode !== 'picture' && recording) && styles.shutterOuterRec]}
          >
            <View style={[styles.shutterInner, mode !== 'picture' && styles.shutterInnerVideo, recording && styles.shutterInnerRec]} />
          </TouchableOpacity>

          {mode === 'audio' ? (
            // Layout placeholder, keeping the shutter centered without a
            // camera-flip in audio mode.
            <View style={styles.sideButton} />
          ) : (
            <TouchableOpacity style={styles.sideButton} onPress={flipCamera} disabled={recording}>
              <Ionicons name="camera-reverse-outline" size={24} color={recording ? colors.onDark.faint : colors.onDark.dim} />
            </TouchableOpacity>
          )}
        </View>
      </View>

      {/* Audio start failure: a card, not a one-line footnote. */}
      {audioBlocked ? (
        <View style={styles.audioBlockedCard}>
          <Ionicons name="warning-outline" size={18} color={colors.warn} />
          <Text style={styles.audioBlockedText}>{audioBlocked.message}</Text>
          {audioBlocked.needsSettings ? (
            <TouchableOpacity style={styles.audioBlockedButton} onPress={() => Linking.openSettings()}>
              <Text style={styles.audioBlockedButtonText}>Open Settings</Text>
            </TouchableOpacity>
          ) : null}
          <TouchableOpacity onPress={() => setAudioBlocked(null)}>
            <Text style={styles.audioBlockedDismiss}>Dismiss</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      {/* Native session failure, same card pattern as the audio start
          failure: a card with a dismiss. */}
      {sessionError ? (
        <View style={styles.audioBlockedCard}>
          <Ionicons name="warning-outline" size={18} color={colors.warn} />
          <Text style={styles.audioBlockedText}>{sessionError}</Text>
          <TouchableOpacity onPress={() => setSessionError(null)}>
            <Text style={styles.audioBlockedDismiss}>Dismiss</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      {/* Shutter flash */}
      <Animated.View pointerEvents="none" style={[styles.flashOverlay, { opacity: flashAnim }]} />

      {/* Toast — tap to open the exhibits grid */}
      {toast ? (
        <TouchableOpacity style={styles.toast} activeOpacity={0.8} onPress={() => router.push('/exhibits')}>
          <Ionicons name="albums-outline" size={15} color={colors.onDark.accent} />
          <Text style={styles.toastText}>{toast}</Text>
          <Ionicons name="chevron-forward" size={13} color={colors.onDark.faint} />
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

/**
 * Recording stopwatch. Owns its own 1 s interval and seconds state, so the
 * tick re-renders this leaf only, never the camera screen. Mounted exactly
 * while a recording runs, so mount time is zero for both audio and video.
 */
function RecordTimer({ style }: { style?: TextStyle }) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <Text style={style}>
      {String(Math.floor(seconds / 60)).padStart(2, '0')}:{String(seconds % 60).padStart(2, '0')}
    </Text>
  );
}

/**
 * Audio level meter. Owns the onLevel subscription and its own dB state, so
 * ~30 metering updates/s re-render this leaf only. Mounted exactly while an
 * audio recording runs; unmount removes the subscription. Maps −60…0 dB to a
 * 0…1 fill, so quiet speech is still visible.
 */
function LevelMeter() {
  const styles = useThemedStyles(buildStyles);
  const [fill, setFill] = useState(0);
  useEffect(() => {
    const sub = onLevel((e) => setFill(clamp01((e.db + 55) / 45)));
    return () => sub?.remove();
  }, []);
  return (
    <View style={styles.audioLevelTrack}>
      <View style={[styles.audioLevelFill, { flex: fill }]} />
      <View style={{ flex: 1 - fill }} />
    </View>
  );
}

/** '#C08552' + 0.35 → 'rgba(192,133,82,0.35)', a status color's hairline tint. */
function withAlpha(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

/**
 * HUD proof toggle (.hudpill): a translucent glass pill with blur 8, a 1px
 * hairline, a status dot and a 10.5/700 label. On fills the dot with the
 * toggle's state color and tints the label and hairline; off is a hollow
 * ring, so the dot's shape carries the state.
 */
function HudPillToggle({
  label,
  on,
  onColor,
  onPress,
  accessibilityLabel,
}: {
  label: string;
  on: boolean;
  /** The pill's ON state color (dot fill, label tint, hairline tint). */
  onColor: string;
  onPress: () => void;
  accessibilityLabel: string;
}) {
  const styles = useThemedStyles(buildStyles);
  return (
    <TouchableOpacity onPress={onPress} hitSlop={10} accessibilityLabel={accessibilityLabel}>
      <BlurView
        intensity={8}
        tint="dark"
        style={[styles.hudToggle, on && { borderColor: withAlpha(onColor, 0.35) }]}
      >
        <View
          style={[
            styles.hudToggleDot,
            on && { backgroundColor: onColor, borderColor: onColor },
          ]}
        />
        <Text style={[styles.hudToggleLabel, on && { color: onColor }]}>{label}</Text>
      </BlurView>
    </TouchableOpacity>
  );
}

/**
 * Param capsule: an equal-width (flex:1) glass capsule with the param's label,
 * its bridge-applied value in mono, and a 5px clay state dot when the param is
 * manual. It has no gestures of its own; the tap docks the precision bar.
 * Widths never change on tap, on value, or on active state. An overridden
 * param (EV under manual ISO+shutter) renders dimmed and explains itself on
 * tap.
 */
function ParamCapsule({
  label,
  valueText,
  manual,
  overridden,
  busy,
  open,
  accessibilityLabel,
  onPress,
}: {
  label: string;
  valueText: string;
  manual?: boolean;
  overridden?: boolean;
  /** Transient device feedback (AF running): the value turns clay. */
  busy?: boolean;
  open?: boolean;
  accessibilityLabel?: string;
  onPress: () => void;
}) {
  const styles = useThemedStyles(buildStyles);
  return (
    <TouchableOpacity
      style={[
        styles.paramCapsule,
        manual && styles.paramCapsuleManual,
        open && styles.paramCapsuleOpen,
        overridden && styles.paramCapsuleOverridden,
      ]}
      onPress={onPress}
      accessibilityLabel={accessibilityLabel ?? `${label} ${valueText}, tap to adjust`}
    >
      <View style={styles.paramLabelRow}>
        {manual ? <View style={styles.paramDot} /> : null}
        <Text style={styles.paramLabel} numberOfLines={1}>
          {label}
        </Text>
      </View>
      <Text
        style={[styles.paramValue, manual && styles.paramValueManual, busy && styles.paramValueBusy]}
        numberOfLines={1}
      >
        {valueText}
      </Text>
    </TouchableOpacity>
  );
}

const buildStyles = () => StyleSheet.create({
  // A camera screen is black end-to-end; the paper-white theme background
  // otherwise flashes between the preview and a session reconfigure.
  root: { flex: 1, backgroundColor: '#000' },
  scrimTop: { position: 'absolute', top: 0, left: 0, right: 0, height: 170 },
  scrimBottom: { position: 'absolute', bottom: 0, left: 0, right: 0, height: 300 },
  // One column stack for the seal pill and proof toggles, laid out by flexbox
  // so the rows cannot overlap. Side gutters reserve the top-left lock and
  // flash column, and the toggle row wraps inside them.
  hudStack: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    alignItems: 'center',
    paddingHorizontal: 56,
  },
  hudToggleRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  // The hudpill, shared by every HUD element: translucent dark glass (BlurView
  // intensity 8 at the call sites), a 1px hairline, borderRadius 999, a status
  // dot and a 10.5/700 label.
  hudPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    backgroundColor: 'rgba(13,13,15,0.55)',
    borderWidth: 1,
    borderColor: 'rgba(232,232,236,0.14)',
    borderRadius: radii.full,
    paddingHorizontal: 12,
    paddingVertical: 7,
    overflow: 'hidden', // clip the blur to the pill's radius
  },
  hudPillText: { color: colors.onDark.text, fontSize: 10.5, fontWeight: '700', letterSpacing: 0.4 },
  hudDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.onDark.faint },
  // The two status-dot colors: sage (steady) and clay (busy).
  hudDotGreen: { backgroundColor: HUD_SEAL_GREEN },
  hudDotBusy: { backgroundColor: HUD_IDENT_ON },
  // Proof toggles, the same glass pill. On tints the hairline and label with
  // the state color (inline at the call site); off is a hollow dot ring.
  hudToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: radii.full,
    backgroundColor: 'rgba(13,13,15,0.55)',
    borderWidth: 1,
    borderColor: 'rgba(232,232,236,0.14)',
    overflow: 'hidden',
  },
  hudToggleDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    borderWidth: 1.5,
    borderColor: colors.onDark.faint,
    backgroundColor: 'transparent',
  },
  hudToggleLabel: { color: colors.onDark.text, fontSize: 10.5, fontWeight: '700' },
  hudLock: { position: 'absolute', top: 0, left: 0 },
  hudLockBadge: {
    marginTop: spacing.sm,
    marginLeft: spacing.md,
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: 'rgba(13,13,15,0.55)',
    borderWidth: 1,
    borderColor: 'rgba(232,232,236,0.14)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  sealPill: { marginTop: spacing.sm },
  // The "Sealed" completion flash: the green-pill hairline tint.
  sealPillFlash: { borderColor: 'rgba(52,199,89,0.35)' },
  sealPillFp: { color: colors.onDark.accent, fontFamily: type.mono, fontSize: fontSize.xs },
  recWrap: { position: 'absolute', top: 96, left: 0, right: 0, alignItems: 'center' },
  recIndicator: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    backgroundColor: 'rgba(13,13,15,0.55)',
    borderWidth: 1,
    borderColor: 'rgba(232,232,236,0.14)',
    borderRadius: radii.full,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  recDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.danger },
  recText: { color: colors.onDark.text, fontFamily: type.mono, fontSize: fontSize.sm },
  zoomWrap: { position: 'absolute', top: 140, left: 0, right: 0, alignItems: 'center' },
  controls: { position: 'absolute', bottom: 0, left: 0, right: 0, paddingBottom: 34, alignItems: 'center' },
  // Quiet hardware caption: gray, one line.
  stereoCaption: {
    color: colors.onDark.faint,
    fontSize: fontSize.xs,
    letterSpacing: 0.3,
    marginBottom: spacing.sm,
  },
  shutterRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xxl },
  sideButton: {
    width: 46,
    height: 46,
    borderRadius: 23,
    // No card background; the button floats on the bottom gradient scrim.
    alignItems: 'center',
    justifyContent: 'center',
  },
  // The shutter: a large ink ring with a subtle inner disc and a visible gap
  // between them.
  shutterOuter: {
    width: 74,
    height: 74,
    borderRadius: 37,
    borderWidth: 4,
    borderColor: colors.shutterRing,
    alignItems: 'center',
    justifyContent: 'center',
  },
  shutterOuterRec: { borderColor: colors.danger },
  shutterInner: { width: 54, height: 54, borderRadius: 27, backgroundColor: colors.shutterRing },
  shutterInnerVideo: { backgroundColor: colors.danger },
  shutterInnerRec: { width: 28, height: 28, borderRadius: 6 },
  proStrip: { alignSelf: 'stretch', marginBottom: spacing.md },
  // Full-width wrapper for the tray and ribbon inside the centered `controls`
  // column; without it the stretch below has nothing to stretch against.
  trayWrap: { alignSelf: 'stretch' },
  // The tray row: flex-equalized capsules, 6px gutters, screen padding both
  // sides. No scroll and no wrap; every param the hardware reports fits at
  // once at 393pt (6 capsules ≈ 55pt each, and the longest value text,
  // '1/4000' at 11px mono ≈ 40px, fits).
  proTrayRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: spacing.md,
  },
  // The capsule: dark glass (charcoal) over the viewfinder, a 1px hairline,
  // radius 8, a 9px/800 label over an 11px mono value. Equal width via flex:1.
  // Manual is marked by the clay dot, clay hairline and brighter value;
  // overridden dims the whole capsule.
  paramCapsule: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
    minHeight: 46,
    backgroundColor: 'rgba(13,13,15,0.55)',
    borderWidth: 1,
    // The HUD's dark-glass hairline. colors.border is the light scheme's
    // divider gray and glows white over the viewfinder.
    borderColor: 'rgba(232,232,236,0.14)',
    borderRadius: 8,
    paddingHorizontal: 4,
    paddingVertical: 5,
  },
  paramCapsuleManual: { borderColor: 'rgba(192,133,82,0.75)' },
  paramCapsuleOpen: { borderColor: colors.onDark.accent },
  paramCapsuleOverridden: { opacity: 0.45 },
  paramLabelRow: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  paramDot: { width: 5, height: 5, borderRadius: 2.5, backgroundColor: HUD_IDENT_ON },
  // onDark tokens always: the camera chrome is dark in both schemes, and a
  // scheme color (textFaint) goes near-invisible on the glass in light mode.
  paramLabel: { color: colors.onDark.faint, fontSize: 9, fontWeight: '800', letterSpacing: 0.7 },
  paramValue: { color: colors.onDark.dim, fontSize: 11, fontWeight: '700', fontFamily: type.mono },
  paramValueManual: { color: colors.onDark.text },
  paramValueBusy: { color: HUD_IDENT_ON },
  transcriptToggle: {
    backgroundColor: 'rgba(13,13,15,0.55)',
    borderWidth: 1,
    borderColor: 'rgba(232,232,236,0.14)',
  },
  transcriptToggleOn: { backgroundColor: colors.accent, borderColor: colors.accent },
  audioStage: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(10,13,16,0.82)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
  },
  audioIdleBox: { alignItems: 'center', gap: spacing.md },
  audioRecBox: { alignItems: 'center', alignSelf: 'stretch', gap: spacing.lg },
  audioLiveRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  audioLiveText: { color: colors.onDark.text, fontFamily: type.mono, fontSize: fontSize.lg, fontWeight: '600' },
  audioLevelTrack: {
    flexDirection: 'row',
    height: 3,
    width: '55%',
    borderRadius: 2,
    backgroundColor: 'rgba(237,241,244,0.22)',
    overflow: 'hidden',
  },
  audioLevelFill: { backgroundColor: colors.accent },
  audioTranscriptWrap: {
    alignSelf: 'stretch',
    maxHeight: 220,
    backgroundColor: 'rgba(10,13,16,0.6)',
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: 'rgba(237,241,244,0.25)',
    paddingHorizontal: spacing.md,
  },
  audioTranscriptScroll: { flexGrow: 0 },
  audioTranscriptFinal: { fontFamily: type.display, fontSize: fontSize.lg, color: colors.onDark.text, lineHeight: 26 },
  audioTranscriptPartial: { fontFamily: type.display, fontSize: fontSize.lg, color: colors.onDark.faint, lineHeight: 26 },
  audioHint: {
    color: colors.onDark.dim,
    fontSize: fontSize.sm,
    lineHeight: 20,
    textAlign: 'center',
    maxWidth: 320,
  },
  audioBlockedCard: {
    position: 'absolute',
    bottom: 190,
    alignSelf: 'center',
    marginHorizontal: spacing.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.lg,
    padding: spacing.md,
    alignItems: 'center',
    gap: spacing.sm,
  },
  audioBlockedText: { color: colors.warn, fontSize: fontSize.sm, textAlign: 'center', lineHeight: 20 },
  audioBlockedButton: {
    backgroundColor: colors.accent,
    borderRadius: radii.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: 10,
  },
  audioBlockedButtonText: { color: colors.onAccent, fontWeight: '700', fontSize: fontSize.sm },
  audioBlockedDismiss: { color: colors.textFaint, fontSize: fontSize.xs, padding: 4 },
  hint: { color: 'rgba(237,241,244,0.65)', fontSize: fontSize.xs, marginTop: spacing.md, letterSpacing: 0.3 },
  flashOverlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: '#fff' },
  toast: {
    position: 'absolute',
    bottom: 168,
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.full,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
  },
  toastText: { color: colors.text, fontSize: fontSize.sm, fontWeight: '600' },
  permissionBox: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.xl },
  permissionTitle: { color: colors.text, fontSize: fontSize.xl, fontWeight: '800', letterSpacing: -0.5, marginTop: spacing.md },
  permissionBody: { color: colors.textDim, fontSize: fontSize.sm, textAlign: 'center', lineHeight: 20, marginTop: spacing.sm },
  permissionButton: {
    backgroundColor: colors.accent,
    borderRadius: radii.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: 10,
    marginTop: spacing.lg,
  },
  permissionButtonText: { color: colors.onAccent, fontWeight: '700', fontSize: fontSize.sm },
});

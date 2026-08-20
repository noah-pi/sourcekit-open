// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Capture — the cryptographic camera.
 *
 * Pipeline (entirely on-device):
 *   shutter → sensor context snapshot → SHA-256 → ECDSA sign →
 *   C2PA embed (JPEG APP11 / BMFF uuid box) → AES-GCM vault.
 *
 * No network call exists in this file. That is a feature.
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
 * Signed-EXIF assembly (W2.4): the standard-tag subset of the capture's
 * committed settings, destined for the com.verify.exif assertion via the
 * seal job. Source discipline (never synthesized):
 *  - the full-res photo's OWN OS-written EXIF numbers win verbatim;
 *  - AVCaptureDevice read-backs (ISO / exposure / aperture / bias) fill
 *    only gaps the photo EXIF didn't write;
 *  - a field with no real value is simply absent (absence, never a guess).
 * FocalLength/FocalLengthIn35mmFilm ride ONLY from the photo's metadata —
 * the device reports no mm number itself. sanitizeExif's closed allowlist
 * is the final gate.
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
  // EXIF WhiteBalance: 0 = auto, 1 = manual — a mapping of the
  // device-reported mode ('locked' covers the manual-with-gains intent).
  if (raw.WhiteBalance === undefined) raw.WhiteBalance = cs.whiteBalanceMode === 'locked' ? 1 : 0;
  const exif = sanitizeExif(raw);
  return Object.keys(exif).length > 0 ? exif : null;
}

const BUFFER_LIMIT = 13000; // ~2.2 min at 100 Hz — covers a max-length video clip

// Video length cap (see toggleVideo): the current seal path reads the whole
// file into memory for AES-GCM, so clips are capped in THIS build. The cap
// lifts when sealing moves native. Stated to the user verbatim at the cap —
// never a silent stop.
const MAX_VIDEO_SECONDS = 120;
const VIDEO_CAP_NOTICE =
  "Clips are capped at two minutes in this build: sealing currently reads the whole file into memory. The cap lifts when sealing moves native. It's a limit of this build, not of the evidence.";

// HUD color language (0.18.1 — the landed palette of the app icon: sage
// green, cream, charcoal, warm neutrals). Inlined here rather than in
// src/theme.ts. The identifying chips (Location, Byline) share a muted
// warm clay; the seal green is the icon's sage and stays RESERVED for
// "locked and sealed". No pure yellow, no pure blue anywhere in the HUD.
const HUD_IDENT_ON = '#C08552'; // clay/terracotta — the embedding chips
const HUD_SEAL_GREEN = '#809263'; // sage, matched to the aperture mark
const HUD_INK = '#0A0D10'; // label/icon ink on a filled ON pill

// Mode-transition veil. BlurView's intensity is a plain prop, so the pulse
// runs on the JS driver — a 380 ms transition, not a hot path.
const AnimatedBlur = Animated.createAnimatedComponent(BlurView);

type Mode = 'audio' | 'picture' | 'video';

// ---------------------------------------------------------------------------
// The single pro-param model (0.18.2). Every capsule in the tray and every
// precision-bar session is described by this ONE uniform shape — no
// special-cased dials, no per-param control types. 'ladder' params (FLASH/
// FOCUS/WB) ride the bar as integer rung indices with a detent per rung;
// 'continuous' params (EV/ISO/SHTR) scrub their native range. Auto/manual
// is two-state by design: the bar's AUTO pill is the only toggle.
// ---------------------------------------------------------------------------
type ProParamId = 'flash' | 'ev' | 'focus' | 'wb' | 'iso' | 'shtr';
interface ProParam {
  id: ProParamId;
  label: string;
  valueText: string;
  mode: 'auto' | 'manual';
  kind: 'ladder' | 'continuous';
  /** Set when another param holds the hardware (EV under manual
   *  ISO+shutter): the capsule stays — dimmed, value '—' — and explains
   *  itself on tap instead of silently scrubbing a value the device is
   *  ignoring. Never a fake control. */
  overridden?: boolean;
}

/**
 * Media parity: map the audio recorder's IMU-sink report onto the
 * three-state EvidencePath vocabulary — path / enabled-but-failed
 * null / 'never-recorded'. No silent middle states: a desk never has to
 * guess which case an audio exhibit's poseTrace absence is.
 */
function audioSensorLogEvidence(result: AudioStopResult, sensorsEnabled: boolean): EvidencePath {
  if (!sensorsEnabled) return 'never-recorded'; // capture-evidence sensors toggle off
  if (result.sensorLogState === undefined) return 'never-recorded'; // pre-parity native build: no IMU sink exists
  if (result.sensorLogState === 'recorded' && typeof result.sensorLogPath === 'string') {
    return result.sensorLogPath;
  }
  if (result.sensorLogState === 'unavailable') return 'never-recorded'; // the device could not provide motion data
  return null; // 'failed' — the sink was enabled and died: a failure, stated as one
}

/**
 * Camera counterpart of audioSensorLogEvidence: map a stills/video
 * session's IMU sensor-log report (the FROZEN SensorLogEvidence contract —
 * all fields optional so this type-checks against pre-parity native builds,
 * where absence commits 'never-recorded', never a silent gap) onto the same
 * three-state EvidencePath vocabulary — path / enabled-but-failed null /
 * 'never-recorded'. One vocabulary per sink; a desk never has to guess
 * which case an absence is.
 */
function cameraSensorLogEvidence(result: SensorLogEvidence, sensorsEnabled: boolean): EvidencePath {
  if (!sensorsEnabled) return 'never-recorded'; // capture-evidence sensors toggle off
  if (result.sensorLogState === undefined) return 'never-recorded'; // pre-parity native build: no IMU sink exists
  if (result.sensorLogState === 'recorded' && typeof result.sensorLogPath === 'string') {
    return result.sensorLogPath;
  }
  if (result.sensorLogState === 'unavailable') return 'never-recorded'; // the device could not provide motion data
  return null; // 'failed' — the sink was enabled and died: a failure, stated as one
}

/**
 * Shutter-burst sink (native 0.17.2+) mapped onto the same three-state
 * EvidencePath vocabulary: toggle off or a pre-0.17.2 build (field absent)
 * commits 'never-recorded'; a native 'never-recorded' state (e.g. no
 * synchronized pair at shutter) is also 'never-recorded' — its reason rides
 * the CaptureResult into the record's exhibitCapture; a native 'error'
 * state is enabled-but-failed → null (a failure, stated as one — the
 * capture itself still landed).
 */
function ringBufferEvidence(result: CaptureResult, ringEnabled: boolean): EvidencePath {
  if (!ringEnabled) return 'never-recorded'; // capture-evidence ring toggle off
  const ep = result.ringBufferDir;
  if (ep === undefined) return 'never-recorded'; // pre-0.17.2 native build: no ring sink exists
  if (ep.state === 'path') return ep.path;
  if (ep.state === 'error') return null; // the sink was enabled and died: a failure, stated as one
  return 'never-recorded'; // native-stated reason (e.g. no-synchronized-pair-at-shutter)
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

// Physical lens stack selection (ExhibitCamera): genuine optical devices,
// never a crop. Reported per device by the native module's listFormats().
const LENS_ORDER: ExhibitLens[] = ['ultraWide', 'wide', 'telephoto'];

/** The single-stack zoom model (front camera, or a back inventory not yet
 *  reported): one 1x stop, no crossing, everything above 1x is DIGITAL. */
const FRONT_STOPS = [{ lens: 'wide' as ExhibitLens, factor: 1, label: '1x' }];

/** The mode row's visual order — horizontal swipes walk this list. */
const MODE_ORDER: Mode[] = ['audio', 'picture', 'video'];

/**
 * Apple-style chip labels ('.5', '1x', '4'). Display-only chrome — the
 * record commits the true per-format field of view; the chip just says
 * which physical stack is live, the way Apple's own camera labels them.
 * (0.14.0 lesson: a naive wide-FOV÷lens-FOV ratio reads '.7' on iPhone 17
 * because the reported active format crops the sensor. The ultra-wide is
 * Apple's ".5" on every model to date; the telephoto factor comes from the
 * FOVs via the focal-length ratio — tan cancels the sensor-width term —
 * snapped to Apple's whole steps when within tolerance.)
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
// PRO param ladders (0.18.2 — the single param model). Ladder params ride
// the precision bar as integer rung indices (rung 0 = AUTO where the
// hardware has one); continuous params scrub their native range. The
// bridge clamps to the ACTIVE FORMAT's range (not the device-global range)
// and hands the clamped values back — the capsule always shows what was
// applied, so a clamped value is the truth of what will be committed, not
// an error to decorate.
// ---------------------------------------------------------------------------

/** Log-ish ISO ladder — tick marks on the ISO ribbon, clamped per device
 *  to the active format's range. */
const ISO_LADDER = [32, 50, 80, 125, 200, 400, 800, 1600, 3200];
/** Exposure-duration ladder in SECONDS, ascending (1/8000 … 1 s) — the
 *  SHTR ribbon's tick marks (the scrub itself is continuous in stops). */
const SHUTTER_LADDER = [
  1 / 8000, 1 / 4000, 1 / 2000, 1 / 1000, 1 / 500, 1 / 250, 1 / 125,
  1 / 60, 1 / 30, 1 / 15, 1 / 8, 1 / 4, 1 / 2, 1,
];
/** Manual focus: the lens-motor positions the FOCUS ladder offers (rung 0
 *  of the ribbon is AUTO). iOS exposes no focus-distance-in-meters API
 *  (the metadata block commits focusDistanceMeters: null) — the motor
 *  position is the honest control, never a fabricated distance. */
const FOCUS_LADDER = [0, 0.25, 0.5, 0.75, 1];
/** Manual white balance: temperature only, one honest axis (tint fixed at
 *  0 — green–magenta is a correction control, not a scene choice; the
 *  bridge still round-trips and reports the applied tint ≈ 0). The WB
 *  ladder is the common presets plus the 2500/7500 K ends. */
const WB_LADDER = [2500, 3200, 4000, 5000, 5500, 6500, 7500];
/** Exposure compensation (precision bar): −2…+2 EV, continuous with
 *  1/10-stop snap. The bridge clamps to the device's real bias range. */
const BIAS_MIN = -2;
const BIAS_MAX = 2;
// Pinch zoom speed limit (the "too quickly" complaint): the target follows
// the fingers 1:1, but the applied factor lerps toward it at at most
// ~2.6 octaves/s — a fast pinch can no longer slam the zoom end-to-end.
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
 * Watchdog for native ExhibitCamera awaits: a native call that never settles
 * must never freeze the app (the 0.12.0/0.12.1 lesson — a wedged session
 * owner froze capture). On timeout the abandoned promise is swallowed (no
 * unhandled rejection when it eventually settles) and the caller surfaces
 * the failure honestly.
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
  // 0.18.4 graph signal (native, additive): on 'virtual-dual-wide' the
  // wide AND ultra-wide constituents are both live on one virtual device —
  // device zoom factor IS the relative factor across the whole sweep, and
  // the lens pills are zoom-stop jumps, not input swaps.
  const graphRef = useRef<'virtual-dual-wide' | 'multi-input' | null>(null);
  // The MAX_VIDEO_SECONDS video cap drives a JS-side stopVideo; the UI
  // stopwatch is <RecordTimer/>, mounted exactly while `recording` is true.
  const videoStopTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recordingRef = useRef(false);
  const flashAnim = useRef(new Animated.Value(0)).current;

  const [mode, setMode] = useState<Mode>('picture');
  const modeRef = useRef<Mode>('picture');
  const [facing, setFacing] = useState<'back' | 'front'>('back');
  // The light is PER MODE (0.15.0 Drop 2; W2.2): PHOTO keeps a flash
  // preference (auto/on/off — the photo output's real strobe flashMode via
  // setPhotoFlashMode, since Native Wave 2), VIDEO keeps a torch on/off.
  // `torch` is the CONTINUOUS light actually applied to the session right
  // now; it is always off in photo mode (the strobe does the lighting) and
  // re-derived from the incoming mode's preference on every mode switch.
  const [torch, setTorch] = useState(false);
  // Zoom (0.15.0 Drop 2): tracked as the factor RELATIVE to the wide lens's
  // 1x — the number on the pills. `zoomFactor` is the COMMITTED value
  // (gesture end / lens switch); live gesture values ride zoomChannel so a
  // pinch or wheel scrub never re-renders the viewfinder tree.
  const [zoomFactor, setZoomFactor] = useState(1);
  const zoomFactorRef = useRef(1);
  const zoomChannel = useRef(new LiveChannel<LiveZoom>({ factor: 1, active: false })).current;
  // Device-reported zoom range of the ACTIVE lens (capabilities());
  // {1,1} until known — mapping onto an unknown range would be a guess.
  const [zoomRange, setZoomRange] = useState<{ min: number; max: number; qualityCap?: number }>({ min: 1, max: 1 });
  // W2.3: per-constituent-device quality caps from capabilities(). null
  // until fetched / on pre-W2 builds — maxRelativeZoom then falls back to
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
  // Physical lens selection: the native module's listFormats() reports which
  // lens stacks this hardware genuinely has; absent lenses are hidden
  // (unreached, never red). Switching lenses is genuine optical zoom (a
  // different sensor+lens stack), not a crop.
  const [lenses, setLenses] = useState<ExhibitLens[]>([]);
  // Apple-style chip labels derived from the hardware's reported FOVs
  // (computeLensLabels); buildStops() falls back to '.5'/'1x'/'T' labels
  // when unreported — never a number that could be wrong.
  const [lensLabels, setLensLabels] = useState<Partial<Record<ExhibitLens, string>>>({});
  const [lens, setLens] = useState<ExhibitLens>('wide');
  const lensRef = useRef<ExhibitLens>('wide');
  // Optical stops (lens + relative factor + label) the zoom wheel/pinch
  // cross through; the telephoto factor is null when the hardware didn't
  // report FOVs (pill shows its label, crossing through it is disabled).
  const stops = buildStops(lenses, lensLabels);
  // The front camera is one stack: the zoom model collapses to a single
  // 1x stop (no crossing, floor 1) — the readout never claims a ".5×" the
  // front camera can't deliver.
  const activeStops = facing === 'back' && stops.length > 0 ? stops : FRONT_STOPS;
  const stopsRef = useRef(activeStops);
  stopsRef.current = activeStops;
  // W2.3 sweep ceiling: the native per-device quality-cap ceiling when the
  // caps have reported (a quality choice, honestly exposed by the bridge),
  // else the MAX_RELATIVE_ZOOM fallback — never a guessed-tight cap.
  // 0.17.1 (the Halide model): the sweep's ceiling is per-stack — the
  // current lens's stop × its quality cap. Crossing into another stack is
  // an explicit pill tap, never an automatic mid-gesture hand-off.
  // 0.18.6: on the virtual dual-wide graph the sweep runs on the virtual
  // device whose upscale headroom is the WIDE stack's — keying the cap to
  // the ultra-wide (whose own cap is small) would clamp the sweep at ~1x.
  const zoomCeiling = () =>
    stackZoomCeiling(
      stopsRef.current,
      lensCapsRef.current,
      graphRef.current === 'virtual-dual-wide' ? 'wide' : lensRef.current,
    );
  // 35mm-equivalent of the wide stack, from its reported FOV — the basis
  // of the effective-mm readout. null when unreported (never a guess).
  const [baseMm, setBaseMm] = useState<number | null>(null);
  // The precision bar: which pro param is docked (null = closed).
  const [ribbonParam, setRibbonParam] = useState<ProParamId | null>(null);
  // Session lifecycle honesty: null = no probe yet; 'unsupported' renders one
  // quiet gray caption (never red); 'unreached' renders nothing.
  const [stereo, setStereo] = useState<StereoAvailability>('unreached');
  // Native session failures surface as an honest card (audioBlocked pattern).
  const [sessionError, setSessionError] = useState<string | null>(null);
  // Bumped when the native stall watchdog escalates: the session-lifecycle
  // effect re-runs and rebuilds the capture session from scratch.
  const [sessionEpoch, setSessionEpoch] = useState(0);

  // ---- PRO strip (spec §14) ----
  // Per-shoot session state, deliberately NOT in settings: pro choices belong
  // to this capture session, so a fresh app session starts fully auto. The
  // capsule values are the bridge's APPLIED (clamped / round-tripped) values —
  // what the hardware accepted, which is what the metadata block will commit.
  const [proCaps, setProCaps] = useState<ExhibitCameraCapabilities | null>(null);
  const [proOpen, setProOpen] = useState(false);
  const proAnim = useRef(new Animated.Value(0)).current;
  // Mode-transition veil (Apple-style): a short blur pulse while the fresh
  // session settles. JS driver — BlurView intensity is not native-animatable.
  const modeBlurAnim = useRef(new Animated.Value(0)).current;
  const [exposureMode, setExposureModeState] = useState<ExposureModeSetting>('auto');
  const [iso, setIso] = useState(200);
  const [shutter, setShutter] = useState(1 / 125);
  const [focusMode, setFocusModeState] = useState<FocusModeSetting>('auto');
  const [lensPosition, setLensPosition] = useState(0.5);
  const [focusAdjusting, setFocusAdjusting] = useState(false);
  const [wbMode, setWbModeState] = useState<WhiteBalanceModeSetting>('auto');
  const [wbTemp, setWbTemp] = useState(5000);
  // EV bias is continuous now (Value Ribbon, 1/10-stop snap) — no ladder.
  const [bias, setBias] = useState(0);
  // Ref mirror so the session-lifecycle effect (deps only mode/facing) can
  // re-apply the current pro state after a fresh configure.
  const proStateRef = useRef({ exposureMode, iso, shutter, focusMode, lensPosition, wbMode, wbTemp, bias });
  proStateRef.current = { exposureMode, iso, shutter, focusMode, lensPosition, wbMode, wbTemp, bias };
  const [recording, setRecording] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [fingerprint, setFingerprint] = useState<string>('');
  // The camera's ONE status element: the seal pill. Three honest
  // states — steady ("Sealing on · key"), busy ("Sealing…" while the queue
  // drains), and the completion flash ("Sealed", fired ONLY by the queue's
  // completion signal, never by enqueue). No GPS/motion/key chips: the info
  // pile is cut, the proof is in the file.
  const [pendingSeals, setPendingSeals] = useState(0);
  const [sealedFlash, setSealedFlash] = useState(false);
  // Face check: when the toggle is on, capture START runs an OS
  // biometric check; the boolean outcome rides to the seal as an event
  // record (captureIntegrity.biometricGatePassed). Null = toggle off.
  const faceGateFlag = useRef<boolean | null>(null);

  // ---- Audio mode (the standalone Audio tab, folded in as a camera mode) ----
  // `recording` is shared with video — the modes are mutually exclusive
  // (the mode row is locked while any recording runs). The stopwatch and
  // level meter are leaf components (<RecordTimer/>/<LevelMeter/>, bottom
  // of file) that own their own ticking state (render-storm fix).
  const [audioStopping, setAudioStopping] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  // Why transcription is off, verbatim from the native layer — never a guess.
  const [transcriptOffReason, setTranscriptOffReason] = useState<TranscriptionOffReason>(null);
  // Set when the recognizer dies mid-recording (the recording itself is fine).
  const [transcriptionIssue, setTranscriptionIssue] = useState<string | null>(null);
  // The audio level meter lives in <LevelMeter/> (bottom of file): it owns
  // the onLevel subscription and its own dB state — ~30 updates/s re-render
  // that leaf only, never this screen (render-storm fix).
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

  // Pinch-to-zoom (dependency-free PanResponder). Only claims a gesture when
  // two or more fingers are down, so single taps (tap-to-focus, shutter,
  // mode, flip, light buttons) are untouched. Zoom is a factor relative to
  // wide 1x driving the camera's own optical+digital zoom — it never touches
  // the pixels-after-the-fact, so the signing pipeline is unaffected.
  // Gesture arbitration (0.14.0): two-finger pinch zooms; a single-finger
  // HORIZONTAL swipe switches capture mode (the Apple Camera pattern —
  // TestFlight 0.13.0 had tap-only mode switching). The responder claims a
  // gesture only once intent is clear (24 px of dominant horizontal travel),
  // so taps still reach tap-to-focus untouched.
  // 0.15.0 Drop 2 ("too quickly, no in-between"): the pinch target follows
  // the finger ratio 1:1, but the APPLIED factor lerps toward it on a rAF
  // loop capped at PINCH_MAX_LOG2_PER_FRAME — and the loop writes the live
  // channel + throttled native calls, never React state.
  const gestureKind = useRef<'pinch' | 'swipe' | null>(null);
  const swipeFired = useRef(false);
  const modeSwipeRef = useRef<(dir: 1 | -1) => void>(() => {});
  // Mode-swipe exclusion zones (0.18.1): a horizontal drag that STARTS on
  // the pro tray or the docked precision bar is a dial adjustment, never a
  // mode switch — the root responder used to claim those drags mid-dial
  // ("adjusting the dials gets interpreted as slide between modes"). The
  // zones are window-Y spans measured off the wrappers at render; each is
  // consulted only while its control is actually open.
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
  // onLayout only reports parent-relative geometry: docking the ribbon
  // shifts the tray's WINDOW position without firing it, so re-measure
  // (post-layout, one frame later) whenever either control mounts, docks
  // or the mode hides them.
  useEffect(() => {
    const raf = requestAnimationFrame(measureGestureZones);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- measureGestureZones reads only refs
  }, [proOpen, ribbonParam, mode]);
  const applyLiveZoomRef = useRef<(relative: number) => void>(() => {});
  const commitZoomRef = useRef<(relative: number) => void>(() => {});
  // Pinch floor tracks the CURRENT stack's optical stop (0.17.1 — the
  // sweep never leaves the stack; the lens inventory arrives async).
  const zoomFloorLog = useRef(Math.log2(1));
  zoomFloorLog.current = Math.log2(
    graphRef.current === 'virtual-dual-wide' ? firstOpticalFactor(activeStops) : stackZoomFloor(activeStops, lens),
  );
  // The lerp tick, hoisted so a move event can restart the loop after it
  // converged (fingers held still → loop parks; fingers move → loop wakes).
  const pinchTickRef = useRef<() => void>(() => {});
  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: (evt) => evt.nativeEvent.touches.length >= 2,
      onMoveShouldSetPanResponder: (evt, g) => {
        if (evt.nativeEvent.touches.length >= 2) return true;
        // ONE pure classifier decides (gestureClassify.ts): a drag that
        // STARTED on the pro tray or the precision bar is that control's
        // business, never a mode swipe; and while the bar is docked the
        // mode swipe is disabled entirely — the simplest correct gate.
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
          // Speed-limited lerp loop — JS-side, but it only emits the
          // channel and (throttled) native calls; React renders nothing
          // outside the zoom leaves.
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
          // One switch per gesture, at a decisive 64 px — like paging, not
          // scrubbing. switchMode's own guards (recording lock, pro reset)
          // apply unchanged.
          if (!swipeFired.current && Math.abs(g.dx) > 64) {
            swipeFired.current = true;
            modeSwipeRef.current(g.dx < 0 ? 1 : -1);
          }
          return;
        }
        const d = pinchDistance(evt);
        if (d > 0 && pinchStartDist.current > 0) {
          // Multiplicative ratio — the natural pinch mapping — clamped to
          // the optical floor and the digital ceiling.
          pinchTargetLog.current = Math.min(
            Math.log2(zoomCeiling()),
            Math.max(zoomFloorLog.current, pinchStartLog.current + Math.log2(d / pinchStartDist.current)),
          );
          // The loop parks once converged (fingers held still); a new move
          // target wakes it again.
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
          // the pinch's finger-lift isn't mistaken for a focus tap.
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

  // Permissions on first focus, via the ExhibitCamera bridge (the native
  // module owns both camera and mic prompts now — one session owner).
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

  // 0.14.2: photo and video ride ONE native session (startVideo/stopVideo
  // reconfigure it in place); only audio mode needs the camera torn down.
  const needsCamera = mode !== 'audio';

  /**
   * Session lifecycle (0.13.0): ONE native session, configured when the
   * screen is focused in photo/video mode, stopped on blur and whenever
   * audio mode owns the microphone. Chrome state (torch, zoom) is
   * re-applied after each configure — a fresh session starts at defaults.
   * The 10 s watchdog is the 0.12.x lesson: a wedged native start must
   * surface as an honest card, never a frozen screen.
   *
   * 0.14.2: the effect keys on `needsCamera`, not `mode` — photo↔video hops
   * ride the SAME running native session (startVideo/stopVideo reconfigure
   * in place), so rebuilding per hop was pure churn: blocking startRunning,
   * a calibration one-shot, and PiP death on every switch, i.e. the
   * mode-switch freeze.
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
          // Alternate view (0.14.0 toggle): OFF means DO NOT COLLECT — the
          // secondary camera is never attached, and the record's stereo
          // sections commit their honest never-recorded states. Applies
          // from the next session configure (screen re-enter), like lens.
          // IMU evidence sink (frozen A1 contract, native 0.15+): the
          // sensors toggle (top-level includeSensors) arms the session's
          // 60 s sensor ring — per-session flag, same lifecycle as stereo
          // (applies from this configure; older native builds ignore it and
          // report nothing, which commits 'never-recorded' by absence).
          configureSession({
            // 0.18.6: on the virtual dual-wide graph (stereo on) the
            // ultra-wide "lens" is a zoom stop, not an input — the graph
            // only forms from a wide anchor (native 0.18.4: lens == .wide
            // gate). Reconfiguring with ultraWide here would tear the
            // pair down to the multi-input graph on every blur/refocus.
            // The parked 0.5 zoom is re-applied after start, unchanged.
            lens: settings.captureEvidence.altView && lensRef.current === 'ultraWide' ? 'wide' : lensRef.current,
            facing,
            stereo: settings.captureEvidence.altView,
            sensorLog: settings.includeSensors,
            // Shutter-burst sink (native 0.17.2+): arms the 3 pre + 4 post
            // frame commit per still; older builds ignore the flag and the
            // record commits 'never-recorded' by absence.
            ring: settings.captureEvidence.ring,
            // Stereo partner (native 0.17.2+): always 'auto' — the picker
            // is gone; 'auto' keeps the native UW↔W/T pairing. Older
            // builds ignore the key.
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
            // 0.14.1 wedge: a session orphaned by an interrupted teardown
            // rejects E_BUSY "already running", after which every capture
            // and mode tap dead-loops until an app restart. Force-stop the
            // orphan and retry ONCE; if the retry fails, the honest error
            // card still shows (never a silent wedge).
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
          // W2.2: the persisted photo-strobe preference rides the photo
          // output (real flashMode), never the torch. A fresh session
          // inherits the stored native preference; re-apply to be explicit.
          void setPhotoFlashMode(settings.photoFlash).catch(() => {});
          // A fresh session starts at 1x device zoom: re-apply the
          // committed factor (it survives photo↔video hops; lens switches
          // and flips reset it to the stop).
          {
            const device = clampZoom(
              deviceFactorFor(zoomFactorRef.current, stopsRef.current),
              graphRef.current === 'virtual-dual-wide' ? Math.min(0.5, zoomRange.min) : 1,
              zoomCeiling(),
            );
            if (Math.abs(device - 1) > 0.001) void setNativeZoom(device).catch(() => {});
          }
          // Re-apply the pro strip's session state after a fresh configure
          // (same rule as torch/zoom: the new session starts at defaults).
          // Pro choices are per-shoot — they survive a flip or a photo↔video
          // hop; only the trip to audio resets them (see switchMode).
          // 0.18.6: skipped while the dual-view graph is armed — manual
          // per-device controls aren't offered there (the strip hides), so
          // nothing is re-applied onto the virtual device either.
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
          // W2.3: per-device quality caps drive the sweep ceiling
          // (maxRelativeZoom); absent on pre-W2 builds → fallback constant.
          setLensCaps(caps?.lensZoomCaps ?? null);
          // Pro-strip capability inventory: the strip hides any control the
          // hardware doesn't report (and the PRO button itself when nothing
          // manual exists). Re-fetched per session — front/back and lens
          // changes can change the active format's ISO/duration ranges.
          setProCaps(caps);
          const fmts = await listFormats().catch(() => null);
          if (!cancelled && fmts) {
            setLenses(LENS_ORDER.filter((l) => fmts.lenses[l]?.present === true));
            setLensLabels(computeLensLabels(fmts));
            // The effective-mm readout's basis: the wide stack's reported
            // FOV. Unreported → null → the readout stays hidden (never a
            // guessed focal length).
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
        // Blur (or audio-mode switch) mid-video: finalize the take through
        // the normal stop path BEFORE the session stops — a recording in
        // flight is never dropped silently. Keys off the recording ref, not
        // the (possibly stale) mode closure — photo↔video hops no longer
        // re-run this cleanup at all, but a focused-blur mid-take still
        // finalizes.
        if (recordingRef.current) {
          void finishVideoRef.current().then(() => stopSession().catch(() => {}));
        } else {
          void stopSession().catch(() => {});
        }
      };
      // needsCamera collapses photo+video into one session lifetime —
      // photo↔video hops no longer rebuild the native session (0.14.2).
      // 0.18.6 (Noah): altView IS a dep — without it, toggling Multiple
      // lenses left the old graph running: dual-off kept the virtual graph
      // (lens pills became zoom-stop jumps that switch nothing — "the lens
      // switch doesn't work even when dual lens is off"), dual-on never
      // attached the partner.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [needsCamera, facing, sessionEpoch, settings.captureEvidence.altView])
  );

  // Torch: the toggle is a level — 1.0 on, null off (native clamps to
  // maxTorchLevel; no torch hardware no-ops with applied:false).
  useEffect(() => {
    if (sessionActive.current) void setTorchLevel(torch ? 1.0 : null);
  }, [torch]);

  // Native session errors surface as an honest card. A terminal error
  // mid-recording (E_WRITER / E_PLATFORM / E_NO_SESSION) triggers the same
  // stop path as a manual stop so no JS promise is left pending; sink-level
  // degradations never stop a recording.
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
  // capsule while the lens motor is moving. Also the capture guardrail — the
  // UI avoids capturing mid-adjustment.
  useEffect(() => {
    return onAdjustingFocus((e) => setFocusAdjusting(e.adjusting));
  }, []);

  // Thermal/system pressure: stated quietly, never red — the recording
  // itself continues; only the stereo partner detaches.
  useEffect(() => {
    return onHardwarePressure((e) => {
      if (e.degraded === 'stereo-detached' || e.action === 'stereo-detached') {
        showToast('Thermal pressure: stereo capture detached; capture continues on the primary lens.');
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Stall escalation (0.14.0): the native watchdog already tried one cheap
  // synchronizer rebind; still stalled → rebuild the session by bumping the
  // epoch. Skipped mid-recording: a rebuild would kill the take, and
  // recording failures surface through their own error path.
  useEffect(() => {
    return onSyncStalled(() => {
      if (recordingRef.current) return;
      setSessionEpoch((e) => e + 1);
    });
  }, []);

  // Native pipeline diagnostics (0.18.2): graph wiring outcomes, format
  // picks, the live connection census, interruption boundaries — forwarded
  // verbatim into the persistent log so a field screenshot self-explains.
  useEffect(() => {
    return onCameraDiagnostic((e) => {
      logDiagnostic({ t: Date.now(), kind: 'camera', outcome: 'info', message: e.message });
    });
  }, []);

  // Periodic stereo pairs (video, spec §8): the module dumps
  // pair-%04d-{secondary.jpg,calibration.json} under the evidence dir and
  // reports each dump here — the events ARE the per-pair anchors (no
  // timestamps file exists per pair). Collected while recording; the seal
  // job carries them to the stereo ingestion path.
  const videoPairEvents = useRef<StereoPairCapturedEvent[]>([]);
  useEffect(() => {
    return onStereoPairCaptured((e) => {
      if (recordingRef.current) videoPairEvents.current.push(e);
    });
  }, []);

  // Device fingerprint for the seal pill + queue wiring for its three states.
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

  // Fused DeviceMotion feed while the screen is focused: true gyro
  // rotation rate + fused attitude + gravity-free acceleration — the signed
  // pose trace. A null component skips
  // the sample rather than fabricating zeros.
  //
  // RATE AUDIT (0.14.3): this is the COMMITTED path — poseBuffer feeds
  // collectContext's signed pose trace on every capture — so it stays at
  // the full 100 Hz and keeps the full BUFFER_LIMIT window. Slowing it
  // would thin the evidence. There is no display-only IMU subscription in
  // this file (the HUD renders no live motion readout), so nothing here
  // drops to a display rate.
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
          // UNITS (0.18.4-R5): expo's native module converts rotationRate to
          // DEGREES per second (radiansToDegrees, DeviceMotionModule.swift)
          // before JS sees it; PoseSample.rx/ry/rz are documented rad/s and
          // every consumer (motion.ts quantization, the Motion Trace card,
          // desk imuflow) is built on that. Convert at the edge. Captures
          // sealed before this fix carry deg/s mislabeled as rad/s — their
          // displayed °/s figures read 57.3× high.
          const DEG2RAD = Math.PI / 180;
          buf.push({
            t: Date.now(),
            ax: m.acceleration.x, ay: m.acceleration.y, az: m.acceleration.z,
            rx: m.rotationRate.gamma * DEG2RAD, ry: m.rotationRate.beta * DEG2RAD, rz: m.rotationRate.alpha * DEG2RAD,
            roll: (m.rotation.gamma * 180) / Math.PI,
            pitch: (m.rotation.beta * 180) / Math.PI,
            yaw: (m.rotation.alpha * 180) / Math.PI,
          });
          // Trim in chunks, not per sample: splicing a ~13k array on every
          // 10 ms tick is O(n) each time. Letting the buffer run up to
          // BUFFER_LIMIT + 1000 before trimming back cuts that work ~1000×
          // while keeping every sample inside the same ~2.2 min window —
          // the committed data is unchanged, only the housekeeping is
          // cheaper.
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
  // Zoom engine (0.15.0 Drop 2; W2.3). ONE path for pinch and wheel:
  //   applyLiveZoom(relative) — clamps to the current stack, emits the
  //     live channel, applies natively RAMPED (setZoomSmooth) throttled,
  //     trailing. Never switches lenses (0.17.1, the Halide model).
  //   commitZoom(relative)    — gesture end: final INSTANT native apply
  //     (setZoom) + the committed React state.
  // The relative ceiling is the current stack's native per-device
  // quality-cap ceiling when the caps have reported, else the
  // MAX_RELATIVE_ZOOM fallback (zoomModel).
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

  /** Zoom floor for the CURRENT lens: its own optical stop (pinch never
   *  walks the lens down — a tap on the .5 pill does that); on a lens
   *  whose stop factor the hardware couldn't report (e.g. an FOV-less
   *  telephoto) the model IS the device factor, so the floor is 1 —
   *  never a ".5×" on a tele. */
  // 0.18.6 (field: the 0.5 pill errored on the virtual graph): on the
  // dual-wide virtual device the sweep covers BOTH constituent cameras —
  // the floor is the lowest optical stop (the ultra-wide), and the
  // relative factor maps to the device factor 1:1 (the virtual device
  // hands off internally at 1.0). The per-stack divide is the physical
  // -swap model and only applies off the virtual graph.
  // 0.18.8 (field: "touch 0.5, the camera changes but the button doesn't"):
  // both helpers take an OPTIONAL explicit lens. selectLens commits the zoom
  // for the lens it just switched to, but lensRef only updates in a
  // post-render effect — reading it here clamped 0.5 against the OLD lens's
  // floor (1), the emit carried factor 1, and the "1" pill stayed lit while
  // the hardware genuinely jumped. Pass the target lens explicitly.
  const zoomFloorFor = (c: ReturnType<typeof buildStops>, forLens?: ExhibitLens) =>
    graphRef.current === 'virtual-dual-wide' ? firstOpticalFactor(c) : stackZoomFloor(c, forLens ?? lensRef.current);
  const deviceFactorFor = (relative: number, c: ReturnType<typeof buildStops>, forLens?: ExhibitLens) =>
    graphRef.current === 'virtual-dual-wide' ? relative : toDeviceFactor(relative, c, forLens ?? lensRef.current);

  const applyLiveZoom = (relativeIn: number) => {
    const c = stopsRef.current;
    // The sweep stays on the current physical stack (the Halide model):
    // no lens crossing mid-gesture — the session never reconfigures under
    // the user's fingers.
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
    // actually showing — a pinch across the 1.0 hand-off crosses cameras
    // without any pill tap, and the label must not claim otherwise.
    if (graphRef.current === 'virtual-dual-wide') setLens(relative < 1 ? 'ultraWide' : 'wide');
    // An explicit lens switch carries its target synchronously — the state
    // effect lands post-render, too late for this commit's floor math.
    if (forLens) lensRef.current = forLens;
    setZoomFactor(relative);
    zoomChannel.emit({ factor: relative, active: false });
    if (sessionActive.current) {
      void setNativeZoom(
        clampZoom(deviceFactorFor(relative, c, forLens), zoomRange.min, Math.min(zoomRange.max, zoomRange.qualityCap ?? MAX_RELATIVE_ZOOM)),
      ).catch(() => {});
    }
  };
  commitZoomRef.current = commitZoom;

  // Byline is self-asserted (a name, never proof of identity). Organization
  // affiliation is not typed in — it is carried by a real org credential's
  // X.509 chain, which is embedded in the signature itself when one is installed.
  // Disclosure level is the CAWG-aligned per-capture identity mode;
  // the byline itself embeds only while the Name HUD toggle is on.
  const identity = identityForCapture(settings);

  /**
   * Face check: the OS biometric check, run at capture start when
   * the toggle is on. Capture proceeds either way — the seal records the
   * OUTCOME as a boolean event record, never a gate on the shutter and
   * never any biometric data. Returns null when the toggle is off.
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

  // Burst intent queue (0.16.2, field report 8/13): rapid shutter taps used
  // to be silently dropped while a capture was in flight — burst felt
  // broken. Now a tap during an in-flight capture enqueues an intent (cap
  // 5) with a haptic ack; each queued shot fires sequentially as the
  // previous settles. Every queued shot is a REAL capture with its own seal
  // job — the shutter never dead-ends, and nothing is ever fabricated.
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
      // Face check at capture start — before any bytes exist.
      faceGateFlag.current = await runFaceGate();

      // ExhibitCamera stills path (0.13.0 — the ONE camera session): the
      // delivery still plus the synchronized stereo partner, committed
      // calibration, timestamps, and per-device metadata, each a three-state
      // EvidencePath. W2.1 adds full-sensor stills (own hash) and W2.4 the
      // committed capture-settings block + photo EXIF. The full
      // CaptureResult rides the seal job; the pump stores the artifact
      // files under the sealed record's evidence dir.
      const stamp = Date.now();
      const evidenceDir = `${FileSystem.documentDirectory}capture/evidence-${stamp}/`;
      await FileSystem.makeDirectoryAsync(evidenceDir, { intermediates: true }).catch(() => {});
      // 0.14.2: a stalled pipeline now kicks its own synchronizer rebind at
      // the freshness deadline, so one quiet retry after a beat usually lands
      // on a live frame. Only genuinely fresh pairs ever commit — the retry
      // changes WHEN we ask, never which pixels get sealed.
      // With the IMU sink armed (0.15+), the native call gains ~0.55 s of
      // post-shutter ring drain — the 20 s watchdog has ample headroom and
      // must NOT be tightened into fighting it.
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

      // Capture ≠ seal: enqueue the raw frame with the sensor context and
      // the exact moment — hashing, Enclave signing, TSA countersigning,
      // C2PA embedding and vault encryption all run in the background queue
      // while the camera stays live for the next shot.
      const context = await snapshotContext(result.capturedAtMs);
      await enqueuePhotoSeal({
        photoUri: toFileUri(result.deliveryPath),
        context,
        identity,
        // W2.4: the standard-EXIF subset of the committed capture settings
        // (the full-res photo's own OS-written EXIF first, device
        // read-backs filling gaps; nothing synthesized — a field with no
        // real value is absent). Signed as com.verify.exif by attestPhoto.
        exif: buildCaptureExif(result.captureSettings),
        // Three-state honesty per sink. The PCM master is a video-session
        // sink — structural 'never-recorded' on stills. The stills ring is
        // REAL as of native 0.17.2 — the capture result's own three-state
        // report, mapped through the shared vocabulary; a pre-0.17.2 build
        // reports nothing and commits 'never-recorded'. The IMU sensor log
        // rides the frozen SensorLogEvidence contract (native 0.15+). The
        // stereo artifacts carry their own three-state vocabulary in
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
          // 0.15.1 degraded fallback: the still LANDED (single-lens,
          // full-sensor photo) — the toast states the degradation, it
          // never pretends stereo happened.
          ? 'Captured · single-lens; stereo unavailable at shutter'
          : 'Captured',
      );
      // The toast fades in 3 s — the diagnostics log keeps the fact.
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
      // Fire the next queued burst intent — a short beat lets the pipeline
      // breathe between captures (the native ring drain already keeps them
      // strictly sequential).
      if (captureQueue.current > 0) {
        captureQueue.current -= 1;
        setTimeout(() => capturePhotoRef.current(), 200);
      }
    }
  };
  capturePhotoRef.current = () => { void capturePhoto(); };

  /**
   * Video stop — manual stop, the 120 s cap timer, and terminal native
   * errors all land here. The native module finalizes the delivery file;
   * the pose trace spans the whole clip at an adaptive rate (≤ 240 samples),
   * anchored to the native session's first-frame clock, not the JS
   * stopwatch. Periodic stereo pairs (pairIntervalSec default) were
   * committed into the evidence dir during recording; the seal job carries
   * the honest session facts (audio track presence, pair counts).
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
      // ENF anchor (0.18.0, native 0.17.2): when the PCM master committed,
      // its first-sample wall-clock anchor + integrity summary ride the
      // sealed context so the details screen (and a desk with a reference
      // ENF series) can place the mains trace in absolute time. Absent when
      // no master committed — captureEvidence.rawPcmPath states which case.
      if (v.rawPcmInfo && typeof v.rawPcmPath === 'string') {
        context.enfAnchor = v.rawPcmInfo;
      }
      await enqueueVideoSeal({
        videoUri: toFileUri(v.deliveryPath),
        context,
        identity,
        // Three-state honesty per sink: the raw-audio master is REAL as of
        // 0.14.0 — the native stop payload reports the recorded path or
        // null (enabled-but-failed); the toggle-off case is stated
        // 'never-recorded' here. The IMU sensor log rides the same frozen
        // SensorLogEvidence contract as stills (native 0.15+) — a pre-parity
        // build reports nothing and commits 'never-recorded'. The ring sink
        // is stills-only — structural 'never-recorded' on videos, stated,
        // never silently absent.
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
          // Session stereo availability as probed at configure time, plus
          // the collected pair events (the per-pair enumeration + anchors
          // for the stereo ingestion path).
          stereo,
          pairEvents: [...videoPairEvents.current],
        },
        biometricGatePassed: faceGateFlag.current,
      });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      showToast('Captured');
      // VideoResult carries no stereoStatus field (stereo session state is
      // probed at configure time, not in the stop payload) — so there is no
      // degraded branch to log here; 'captured' is the honest outcome.
      logDiagnostic({ t: Date.now(), kind: 'video', outcome: 'captured' });
    } catch (e) {
      // Fail-closed native contract: a session stopped before its first
      // frame rejects E_WRITER ("no frames") — a user-facing "too short",
      // not a crash.
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
  // Re-entrancy guard for finishVideo + the evidence dir of the in-flight
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
        // pairIntervalSec left at the native default (5 s, min 2) — periodic
        // stereo pairs, never continuous, for thermal headroom.
        const start = await withTimeout(
          startVideo({
            deliveryPath: `${FileSystem.cacheDirectory}capture-${stamp}.mp4`,
            evidenceDir,
            // The settings toggle drives a REAL sink (0.13.0: it was a dead
            // control — the module had no PCM tee, so the record could only
            // ever say 'never-recorded').
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
        // MAX_VIDEO_SECONDS cap keeps the whole-file AES-GCM seal comfortably
        // in memory; the timer runs the same stop path as a manual tap and
        // states the reason verbatim on screen — never a silent stop.
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
   * The single audio save path — manual stop and interruption both land here.
   * The native module finalized the .m4a already (or just did, for a manual
   * stop); we seal it like any completed recording.
   */
  const saveAudioResult = useCallback(async (result: AudioStopResult, interrupted: boolean) => {
    audioSubs.current.forEach((s) => s?.remove());
    audioSubs.current = [];
    setRecording(false);
    Animated.timing(transcriptFade, { toValue: 0, duration: 200, useNativeDriver: true }).start();

    // Delivery-file sink, declared natively: nothing durable reached disk →
    // there is no take to seal, and pretending otherwise would mint an empty
    // exhibit. Fail loudly, in the user's favor.
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
    // not, so fall back to the last live partial for the words cut off mid-way.
    const fallback = interrupted
      ? [committedRef.current.trim(), partialRef.current.trim()].filter(Boolean).join(' ')
      : committedRef.current.trim();
    const text = result.transcript.trim() || fallback;
    const segments = result.segments ?? [];
    // Media parity: the take's gyro JSONL rides into the seal exactly like a
    // CaptureKit video sensor log. The ring stays a stills sink (structural
    // 'never-recorded'); the raw PCM master is real for audio takes as of
    // native 0.18.3 — the stop result's three-state report, mapped through
    // the shared vocabulary exactly like video (toggle off commits
    // 'never-recorded'; enabled-but-failed commits null).
    const captureEvidence: CaptureEvidencePaths = {
      rawPcmPath: settings.captureEvidence.rawPcm ? result.rawPcmPath ?? null : 'never-recorded',
      ringBufferDir: 'never-recorded',
      sensorLogPath: audioSensorLogEvidence(result, settings.includeSensors),
    };
    await enqueueAudioSeal({
      audioUri: result.path,
      context,
      identity,
      // The transcription toggle decides whether the words ride inside
      // the signed file — off means audio-only, no silent embedding.
      transcript: settings.includeTranscript && text ? { text, segments, engine: 'apple-speech-ondevice' } : null,
      biometricGatePassed: faceGateFlag.current,
      captureEvidence,
    });
    // The queue copied the draft — the raw capture file has no further job.
    await FileSystem.deleteAsync(result.path, { idempotent: true }).catch(() => {});

    // A partial take still seals (custody of what survived is the user's to
    // keep) — but the truncation is stated plainly, never passed off as the
    // whole recording.
    const isPartial = result.fileState === 'partial';
    Haptics.notificationAsync(isPartial ? Haptics.NotificationFeedbackType.Warning : Haptics.NotificationFeedbackType.Success);
    // A partial take still sealed (stated on the toast) — captured, with
    // the truncation reason kept verbatim in the log.
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
      // Media parity: the recorder's gyro sink writes the take's IMU trace
      // here (anchor line first, exactly the recorded window). Only when the
      // capture-evidence sensors toggle is on — off means 'never-recorded',
      // stated as such, never silently skipped.
      const sensorLogPath = settings.includeSensors ? `${dir}note-${stamp}.sensors.jsonl` : null;
      // Raw-audio sink (0.18.3): the toggle that video honors now records an
      // uncompressed LPCM master for audio takes too — the tap's hardware
      // frames written straight through, sealed as captureEvidence.rawPcmPath.
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
        // The level meter subscribes itself (<LevelMeter/>) — keeping ~30
        // dB updates/s out of this component's render path.
        // iOS seized the session (phone call, Siri, alarm): the native module
        // already finalized the file at the last good frame — save it like a
        // manual stop.
        onInterrupted((e) => {
          void saveAudioResult(e, true).catch((err) => {
            logDiagnostic({ t: Date.now(), kind: 'audio', outcome: 'failed', message: err instanceof Error ? err.message : 'Save failed' });
            showToast(err instanceof Error ? `Save failed: ${err.message}` : 'Save failed');
          });
        }),
        // Native-side hiccups (speech service, session) are surfaced, not
        // swallowed — silent failures are how "transcription isn't working"
        // reports happen.
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
      // An interruption that beat the tap already saved the take natively —
      // "Not recording" then is a no-op, not a failure.
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
    // The light is per mode (0.15.0 Drop 2): entering a mode re-derives
    // the applied light from THAT mode's persisted preference — photo's
    // flash pref and video's torch never carry into each other, and the
    // trip to audio always goes dark. (0.14.2: photo↔video hops ride the
    // same native session, so this is a chrome call, not a rebuild.)
    setRibbonParam(null);
    if (m === 'audio') setTorch(false);
    else if (m === 'video') setTorch(settings.videoTorch);
    else {
      // W2.2: entering PHOTO mode goes dark (continuous light off) and
      // re-applies the persisted strobe preference to the photo output —
      // the flash strobe does photo lighting now, never the torch.
      setTorch(false);
      void setPhotoFlashMode(settings.photoFlash).catch(() => {});
    }
    if (m === 'audio') {
      // Fresh capture, fresh state: the pro strip is per-shoot session state.
      // Switching to audio collapses it and returns exposure/focus/WB (+bias)
      // to auto — manual optics never silently carry into the next capture.
      resetProControls();
    }
    setMode(m);
    // Apple-style transition: a short blur veil over the preview while the
    // fresh session settles — hides the reconfigure pop between modes.
    modeBlurAnim.setValue(0);
    Animated.sequence([
      Animated.timing(modeBlurAnim, { toValue: 30, duration: 120, useNativeDriver: false }),
      Animated.timing(modeBlurAnim, { toValue: 0, duration: 260, useNativeDriver: false }),
    ]).start();
  };

  // Swipe-to-switch wiring: a leftward swipe advances AUDIO → PHOTO → VIDEO
  // (the mode row's visual order), rightward retreats. Assigned per render —
  // the PanResponder (created once) always reads the current closure.
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
    // 0.18.7 (field: "the 0.5 doesn't work when the multiple lenses is
    // off"): a same-lens tap used to return early on the JS state alone —
    // if the state and the live session ever drifted (a graph teardown or
    // a rebuild that landed on a different stack), the pill went dead and
    // stayed dead. The native call is idempotent (it answers
    // 'already-selected' when the session truly is on that lens), so with
    // a live session even same-lens taps go native: the session is the
    // truth and the chip follows the result, which also re-parks the zoom
    // on the stop.
    if (l === lens && !sessionActive.current) return;
    if (!sessionActive.current) {
      // No live session: nothing native to fail. The session lifecycle
      // effect applies the stored lens when the next session configures.
      setLens(l);
      commitZoom(factorForLens(stopsRef.current, l), l);
      return;
    }
    // 0.18.6 (field: "the 0.5 still doesn't work — same error"): on the
    // virtual dual-wide graph BOTH lenses are already live and the native
    // swap refuses every non-wide request ("both lenses are live — zoom
    // to 0.5x…"), so the 0.5 pill read as a permanent error. On this
    // graph the pill is a zoom-stop JUMP: the device hands off to the
    // ultra-wide constituent at 0.5 by itself. The telephoto is genuinely
    // not on this graph — stated, with the way out.
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
    // Honesty fix (TestFlight 0.13.0): the native switch can resolve
    // applied:false or reject outright. Updating the chip before the result
    // made the buttons look dead — or worse, lie about which lens sealed
    // the capture. Apply the label only on applied:true; say why otherwise.
    try {
      const res = await setNativeLens(l);
      if (!res.applied) {
        // 0.18.7: refusals go to the diagnostics log verbatim — the field
        // report after a dead-pill tap then carries the native reason.
        logDiagnostic({ t: Date.now(), kind: 'camera', outcome: 'info', message: `lens switch to ${l} refused: ${res.reason ?? 'no reason'}` });
        showToast(res.reason === 'no-session-or-front-facing'
          ? 'Lens switch is only available on the back camera'
          : `Lens not applied${res.reason ? `: ${res.reason}` : ''}`);
        return;
      }
      // The partner stack was re-derived natively (the old partner can be
      // the lens we just switched TO). Adopt the reported stereo state so
      // the PiP and the stereo caption never claim a partner that is gone.
      if (res.stereo === 'available' || res.stereo === 'unsupported') setStereo(res.stereo);
    } catch (e) {
      logDiagnostic({ t: Date.now(), kind: 'camera', outcome: 'info', message: `lens switch to ${l} errored: ${e instanceof Error ? e.message : String(e)}` });
      showToast(e instanceof Error ? `Lens unavailable: ${e.message}` : 'Lens unavailable on this device');
      return;
    }
    // Halide's tactile lens switcher: an explicit lens switch taps back.
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    // A tapped pill parks the zoom at that lens's optical stop — the pill
    // jump is the optical detent, never a carried-over crop.
    setLens(l);
    commitZoom(factorForLens(stopsRef.current, l), l);
    // The new device stack has its own active format — refresh the pro
    // ranges and zoom range so they clamp to THIS lens's truth.
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
   * Tap-to-focus: a single-finger tap on the preview sets the focus AND
   * exposure points together (normalized 0–1, top-left origin). The pinch
   * guard keeps the trailing finger-lift of a zoom gesture from re-focusing.
   * Tap-elsewhere dismisses the Value Ribbon: with the ribbon docked, the
   * first preview tap closes it and does NOT move the focus point.
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
  // PRO strip logic (spec §14). Every setter goes through withTimeout —
  // a wedged native call surfaces as a one-line toast, never a frozen
  // strip. Capsules store the bridge's APPLIED values (clamped ISO /
  // duration / lensPosition, round-tripped WB temperature): the value on
  // screen is what the next capture's metadata block will commit, so a
  // clamped value needs no label — it is simply honest.
  // ------------------------------------------------------------------

  /** The strip renders only when the hardware reports ANY manual control. */
  const proAvailable = !!proCaps && !!(
    proCaps.exposureModes?.locked || proCaps.exposureModes?.custom ||
    proCaps.focusModes?.locked || proCaps.focusModes?.manual ||
    proCaps.whiteBalanceModes?.locked || proCaps.whiteBalanceModes?.manual
  );
  /** 0.18.6 (Noah): the dual-view graph is LIVE — second camera attached,
   *  both lenses streaming. The 0.5/1 pills are zoom stops on this graph,
   *  not switches, so they hide exactly while this holds. 0.18.7 (Noah):
   *  the pro tray no longer hides wholesale — only the controls that
   *  errored in the field (per-constituent focus/WB/ISO/shutter) hide;
   *  flash/torch and EV keep working on the fused device and stay (see
   *  visibleProParams). Everything returns when Multiple lenses turns off
   *  (the session rebuilds — altView is a lifecycle dep). */
  const dualLive = facing === 'back' && stereo === 'available' && settings.captureEvidence.altView;
  /** One glance on the PRO button: this capture's optics were chosen, and
   *  the record will say so (metadata carries device-read-back values). */
  const proManualActive =
    exposureMode !== 'auto' || focusMode !== 'auto' || wbMode !== 'auto' || bias !== 0;

  const togglePro = () => {
    if (proOpen) {
      // Collapsing KEEPS the applied settings — the strip is a view onto
      // session state, not the state itself. The precision bar docks with
      // a capsule, so it closes with the tray (no orphan surface).
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
  // The precision bar (0.18.2) — the ONLY adjustment surface. Every pro
  // param docks here: ladder params scrub integer rung indices (snap 1, a
  // detent per rung, rung 0 = AUTO where the hardware has one), continuous
  // params scrub their native range (SHTR in stops, so a uniform drag is a
  // uniform exposure change). Live scrubs apply natively on a throttle
  // WITHOUT React state (the ribbon leaf owns its drag); the commit lands
  // the bridge's APPLIED value in state. The AUTO pill on the bar is the
  // one auto/manual toggle; scrubbing a value IS entering manual.
  // ------------------------------------------------------------------
  /** ISO range of the ACTIVE FORMAT (device-reported), else the ladder's
   *  own ends — never a guessed-tight range. */
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

  /** One builder for every param's ribbon session — config + handlers
   *  described uniformly, per the single param model. */
  const ribbonFor = (
    p: ProParamId | null,
  ): { config: RibbonConfig; onLive: (v: number) => void; onCommit: (v: number) => void; onReset: () => void } | null => {
    switch (p) {
      // 0.18.4-R5 (owner directive): FLASH/TORCH has no ribbon — it is a
      // preference with two or three states, so the capsule itself
      // alternates on tap (see cycleLight). The default arm keeps
      // ribbonFor honest if a stale ribbonParam ever names it.
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
            // EV's "auto" is zero compensation — a value, so the bar
            // stays docked.
            onAuto: () => void applyBias(0),
          },
          onLive: (v) => ribbonLive(() => void setExposureBias(v).catch(() => {})),
          onCommit: (v) => void applyBias(v),
          onReset: () => void applyBias(0),
        };
      case 'focus': {
        // 0.18.4 (Noah: "the focus has huge jumps"): the five-rung ladder
        // made the whole manual range four coarse jumps. [0,1) stays the
        // AUTO zone; [1, 11] is now CONTINUOUS lensPosition ((v−1)/10 with
        // snap 0.05 = 0.005 motor steps), with haptic detents and tick marks
        // at the old ladder positions so the familiar landmarks remain.
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
        // 0.18.4 (Noah: "ISO moves exponentially", "sliders need to be more
        // consistently sized"): ISO rides a log2 domain exactly like SHTR —
        // one doubling = one stop = a uniform drag step, the ladder ticks
        // space evenly instead of bunching at the low end, and 1/3-stop snap
        // matches the shutter ribbon's granularity.
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
            // Scrubbing ISO puts the exposure in custom mode — that IS
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
        // Stop domain: log2(seconds), so a uniform drag is a uniform
        // exposure change across 1/8000…1 s; 1/3-stop snap.
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

  // 0.18.7 (Noah: "only hide the controls that were disabled — still
  // include the ones that work, e.g. flash and EV"): on the dual-view
  // graph the tray STAYS, filtered to the controls that genuinely apply
  // to the fused virtual device. Flash/torch is an output-level policy
  // and EV is metering compensation on the virtual device — both honor
  // live. Per-constituent manual controls (focus motor, WB gains, custom
  // ISO/shutter) target one sensor of a fused pair and errored in the
  // field, so they hide exactly while dual is live. A ribbon docked on a
  // now-hidden param is suppressed with its capsule.
  const DUAL_SAFE_PARAMS: readonly ProParamId[] = ['flash', 'ev'];
  const ribbon = ribbonFor(dualLive && ribbonParam && !DUAL_SAFE_PARAMS.includes(ribbonParam) ? null : ribbonParam);

  /** Capsule tap → dock the precision bar with that param; re-tap dismisses. */
  const toggleRibbon = (p: ProParamId) => {
    Haptics.selectionAsync();
    setRibbonParam((cur) => (cur === p ? null : p));
  };

  /** Swipe-down dismiss is NOT a commit: live scrubs already reached the
   *  device, so re-apply the COMMITTED pro state on the way out — the
   *  capsules never display one thing while the hardware holds another. */
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

  // The tray: ONE row of equal-width capsules built from the single param
  // model. Capability-gated (a control the hardware doesn't report is
  // never shown); geometry is flex-equalized so widths never change on
  // tap, on value, or on active state.
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
      // exposure is custom, EV is stated as overruled (value '—') and its
      // capsule explains itself on tap instead of scrubbing a dead value.
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

  // Declared after proParams is fully built (0.18.7 ordering fix): the
  // dual-live filter reads the complete param list, never a partial one.
  const visibleProParams = dualLive ? proParams.filter((p) => DUAL_SAFE_PARAMS.includes(p.id)) : proParams;

  // ------------------------------------------------------------------
  // Light, per mode (0.15.0 Drop 2): PHOTO has a flash preference
  // (auto/on/off, bolt glyph + state badge), VIDEO has the torch (on/off,
  // flashlight glyph). The preferences persist in settings; the two modes
  // never share a light state and never conflate icons.
  // ------------------------------------------------------------------

  /**
   * Photo-flash preference (W2.2 — REAL strobe path): the preference
   * persists in settings and drives the photo output's flashMode via the
   * native setPhotoFlashMode bridge. The torch is NEVER driven by this —
   * it stays the video-only continuous light. The preference itself is
   * validated natively against supportedFlashModes at capture time, and
   * the capture commits what actually happened (captureSettings
   * .photoFlashApplied/.flashFired).
   */
  const setPhotoFlashPreference = (pref: 'auto' | 'on' | 'off') => {
    void saveSettings({ photoFlash: pref });
    if (modeRef.current === 'picture') void setPhotoFlashMode(pref).catch(() => {});
  };

  /** VIDEO continuous light: persist the preference and apply it when the
   *  video session is the live one. */
  const setVideoTorchPreference = (on: boolean) => {
    void saveSettings({ videoTorch: on });
    if (modeRef.current === 'video') setTorch(on);
  };

  // 0.18.4-R5 (owner directive): the light capsule is an alternating
  // BUTTON, not a slider — each tap advances the mode's preference one
  // rung and applies it immediately: photo auto → on → off → auto; video
  // torch off → on → off. The capsule's valueText states the new rung.
  const cycleLight = () => {
    if (mode === 'video') {
      setVideoTorchPreference(!settings.videoTorch);
      return;
    }
    const order: Array<'auto' | 'on' | 'off'> = ['auto', 'on', 'off'];
    const next = order[(order.indexOf(settings.photoFlash) + 1) % order.length] ?? 'auto';
    setPhotoFlashPreference(next);
  };

  // Audio subscriptions, the video cap timer, the pinch lerp loop and the
  // zoom throttle timer all die with the screen.
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
      {/* The native ExhibitCamera preview — the ONE camera session. Grid,
          HUD and controls are JS overlays drawn above it, never in the
          committed pixels. Single-finger taps here are tap-to-focus (focus
          + exposure point together); pinches are claimed by the root
          PanResponder before they reach this wrapper. */}
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
            // Alt-view PiP (transparency): the second camera's live feed in
            // a corner inset, shown exactly while it is attached — native
            // bound to the secondary input, so it can never fabricate a feed.
            altPreview={
              facing === 'back' && mode !== 'audio' && stereo === 'available' && settings.captureEvidence.altView
            }
          />
        ) : (
          <View style={[StyleSheet.absoluteFill, { backgroundColor: '#000' }]} />
        )}
      </View>

      {/* Mode-transition veil (Apple-style): a short blur pulse while the
          fresh session settles. Renders under the scrims and chrome. */}
      <AnimatedBlur
        intensity={modeBlurAnim}
        tint="dark"
        pointerEvents="none"
        style={StyleSheet.absoluteFill}
      />

      {/* Apple-style gradient translucency: the chrome floats on
          near-black scrims that fade into the viewfinder — no solid bars,
          no card backgrounds under the shutter row. */}
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

      {/* Audio mode: the viewfinder dims and the recording stage floats
          over it — no header, no separate screen. The transcript fades on
          as you speak; the words seal inside the file only while the
          transcription toggle beside the shutter is on.
          Z-ORDER RULE (TestFlight 0.13.0: "all the top ui should be on
          top"): this full-screen dim renders BEFORE the HUD — the seal
          pill, lock badge, toggles and timer always sit above it. */}
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

      {/* The top HUD is ONE column stack (0.15.0 overlap fix): the seal pill
          and the proof toggles were two independently-positioned rows
          (top:0 and top:52), so a long fingerprint pill or a narrow device
          could land the toggle row ON the pill. One stack, laid out by
          flexbox, can never overlap itself; the toggle row wraps and its
          pills shrink instead of spilling off the edges.
          The seal pill is the camera's ONE status element.
          Deadpan states only: Sealing on / Sealing… / Sealed. Every pill is
          the mockup's hudpill — translucent dark glass (blur 8), a 1px
          hairline, a status dot and a 10.5/700 label. The "Sealed" flash
          stays the camera's one moment of glow — a green gradient, earned
          only on a real completion (never on enqueue, never on failure). */}
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
            {/* Sage = sealing armed (steady), clay = the queue is
                draining — the palette's two status-dot colors. */}
            <View style={[styles.hudDot, pendingSeals > 0 ? styles.hudDotBusy : styles.hudDotGreen]} />
            <Text style={styles.hudPillText}>
              {pendingSeals > 0 ? 'Sealing…' : 'Sealing on'}
            </Text>
            {pendingSeals === 0 ? (
              <Text style={styles.sealPillFp}>{fingerprint || '………'}</Text>
            ) : null}
          </BlurView>
        )}

        {/* Proof HUD: what will be embedded, visible BEFORE the shutter.
            Mockup hudpill language: a glass pill with a status dot — filled
            + tinted when ON, a hollow ring when OFF (the dot's SHAPE says
            the state, never color alone). */}
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
                  // Turning Byline on opts the capture identity into 'named' so
                  // the byline genuinely embeds — the toggle never lies.
                  : { includeByline: true, identityMode: 'named' }
              )
            }
          />
        </View>
      </SafeAreaView>

      {/* Top-left HUD column: the sealing lock. The lock is green whenever
          sealing is on — the capture is being cryptographically sealed.
          Green is the reserved locked-and-sealed color; the seal pill stays
          as-is. Tapping the lock replays the onboarding (the honest-limits
          tour).
          The HUD is exactly the mockup: the lock badge, the seal pills,
          nothing else. The flash/torch control is NOT here — it is the
          first chip of the pro strip (0.17.1, owner directive). */}
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

      {/* Recording indicator (photo/video — the audio stage carries its
          own). Safe-area wrapped: the HUD stack above it is inset-padded,
          and an unadjusted top:110 landed exactly ON it on Dynamic-Island
          devices (TestFlight 0.13.0 overlap). top:96 clears the stack
          (seal pill + toggle row + breathing room) in the same inset
          space. */}
      {recording && mode !== 'audio' ? (
        <SafeAreaView edges={['top']} style={styles.recWrap} pointerEvents="none">
          <View style={styles.recIndicator}>
            <View style={styles.recDot} />
            <RecordTimer style={styles.recText} />
          </View>
        </SafeAreaView>
      ) : null}

      {/* Zoom readout: ONLY the 35mm-equivalent focal length ("≈27mm")
          while a pinch/wheel drives the zoom (or whenever zoomed off an
          optical stop) — no × factor, no DIGITAL marker; the lens pills
          below already carry the factor. Same safe-area discipline as the
          timer: it stacks UNDER the recording pill (96 + pill height) in
          shared inset space. The HUD is a leaf on the live channel — the
          viewfinder tree never re-renders for it. */}
      {mode !== 'audio' ? (
        <SafeAreaView edges={['top']} style={styles.zoomWrap} pointerEvents="none">
          <ZoomHud channel={zoomChannel} stops={activeStops} baseMm={baseMm} />
        </SafeAreaView>
      ) : null}

      {/* Bottom controls — lifted clear of the floating pill tab bar
          (dock offset 12 + pill height 64 + 14 breathing room), honoring
          the home-indicator inset when it's larger. */}
      <View style={[styles.controls, { paddingBottom: Math.max(insets.bottom, 12) + 64 + 14 }]}>
        {/* Dual-camera honesty, selfie camera: the second-lens toggle is ON
            but the front camera has no partner stack. Exactly five words,
            shown ONLY while the toggle is on (owner directive) — and the
            longer stereo caption never shows on the selfie camera, so this
            is the one message here. */}
        {facing === 'front' && settings.captureEvidence.altView && mode !== 'audio' ? (
          <Text style={styles.stereoCaption}>Dual camera not available</Text>
        ) : /* Stereo availability honesty: 'unsupported' is one quiet gray
               caption, never red; 'unreached' (not probed / no permission)
               renders nothing — absence is stated, never suspicion.
               0.18.6 (Noah): one wording everywhere — "Dual camera not
               available", no "on this device" tail, no second vocabulary.
               0.18.8 (Noah): gated on the Multiple Lenses toggle — with the
               toggle OFF the dual path is not expected, so its absence is
               not stated. */
        stereo === 'unsupported' && facing === 'back' && mode !== 'audio' && settings.captureEvidence.altView ? (
          <Text style={styles.stereoCaption}>Dual camera not available</Text>
        ) : null}

        {/* Zoom control (0.15.0 Drop 2): optical pills for the lenses the
            hardware reports (a tap is a genuine optical jump — these are
            real cameras, never crops), and a horizontal drag anywhere on
            the row turns it into the smooth zoom wheel (the "no
            in-between" fix). Hidden while recording (Kino-style recording
            safety) and in audio mode. On the single-stack front camera the
            wheel still sweeps 1x → the digital cap. */}
        {!recording && mode !== 'audio' ? (
          <ZoomWheel
            channel={zoomChannel}
            stops={activeStops}
            currentLens={lens}
            maxZoom={zoomCeiling()}
            onJump={(l) => void selectLens(l)}
            onLive={applyLiveZoom}
            onCommit={commitZoom}
            // 0.18.6 (Noah): no .5/1 pills while the dual-view graph is
            // live — same condition as the PiP, so the pills vanish exactly
            // while the second camera is attached and return when Multiple
            // lenses is off (real lens switches again).
            hidePills={dualLive}
          />
        ) : null}
        {/* Pro tray — quiet, horizontal, above the mode/shutter cluster.
            ONE capsule language (0.18.2): equal-width capsules built from
            the single param model; a tap docks the precision bar, which is
            the only adjustment surface. Values are the bridge's APPLIED
            values; a device clamp shows the clamped number, which is the
            truth of what will be committed. The row leads with the mode's
            light (FLASH / TORCH), then EV, FOCUS, WB, ISO, SHTR as the
            hardware reports them. */}
        {proOpen && (proAvailable || dualLive) && mode !== 'audio' ? (
          // alignSelf stretch is mandatory here: `controls` centers its
          // children, and an unstyled wrapper shrink-wraps to content —
          // which is exactly how the capsules collapsed to strips in the
          // 0.18.2 field build.
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
            {/* ONE row of equal-width capsules (0.18.2), built from the
                single param model: flex:1 each, same padding/typography/
                radius/hairline, a 5px clay dot when manual. A tap docks
                the precision bar — the capsule itself has no gestures.
                Manual ISO+shutter supersedes metering compensation, so the
                EV capsule is stated as overruled (dimmed, '—') while the
                exposure is custom — never a silent dead control.
                FLASH/TORCH first (owner directive): the mode's light leads
                the row. The label says TORCH in video mode — a continuous
                light is never passed off as a strobe. */}
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

        {/* The precision-bar dock — directly above the mode/shutter
            cluster. One param at a time, keyed so a param switch remounts
            the bar at the right value. */}
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

        {/* Mode labels with the sliding highlight pill (0.15.0 Drop 2,
            research §7): crossfade/translate on the native driver, travel
            always toward the newly active label — never inverted. */}
        <ModeSwitcher mode={mode} onSwitch={switchMode} disabled={recording} />

        <View style={styles.shutterRow}>
          {mode === 'audio' ? (
            // Transcription toggle: same pill language as the HUD — filled
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
            // Capture settings: a dials glyph on the shutter row's left
            // slot opens the pro tray. The light (flash / torch) is the
            // tray's FIRST chip, not a HUD button (0.17.1, owner
            // directive). The accent color is the one-glance signal: this
            // capture's optics were chosen by hand, and the record says so.
            // 0.18.8 (Noah): the button STAYS while the dual-view graph is
            // live — the tray itself narrows to the dual-safe controls
            // (visibleProParams filters to DUAL_SAFE_PARAMS), so honesty is
            // the reduced set, not a vanished button.
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
            // Layout placeholder — keeps the shutter centered without a
            // meaningless camera-flip in audio mode.
            <View style={styles.sideButton} />
          ) : (
            <TouchableOpacity style={styles.sideButton} onPress={flipCamera} disabled={recording}>
              <Ionicons name="camera-reverse-outline" size={24} color={recording ? colors.onDark.faint : colors.onDark.dim} />
            </TouchableOpacity>
          )}
        </View>
      </View>

      {/* Audio start failure — a proper card, not a one-line footnote. */}
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

      {/* Native session failure — same honest-card pattern as the audio
          start failure: a real card with a dismiss, never a silent state. */}
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
 * Recording stopwatch (render-storm fix): owns its own 1 s interval and
 * seconds state, so the tick re-renders this leaf only, never the camera
 * screen. Mounted exactly while a recording runs — mount time IS zero, for
 * both audio and video.
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
 * Audio level meter (render-storm fix): owns the onLevel subscription and
 * its own dB state, so ~30 metering updates/s re-render this leaf only,
 * never the camera screen. Mounted exactly while an audio recording runs —
 * unmount removes the subscription. Audio level: map −60…0 dB to a 0…1
 * fill, quiet speech still visible.
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

/** '#C08552' + 0.35 → 'rgba(192,133,82,0.35)' — a status color's hairline tint. */
function withAlpha(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

/**
 * HUD proof toggle (mockup .hudpill): one translucent glass pill — blur 8,
 * a 1px hairline, a status dot and a 10.5/700 label. ON fills the dot with
 * the toggle's state color and tints the label + hairline; OFF is a hollow
 * ring — the dot's SHAPE carries the state, never color alone.
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
 * Param capsule (0.18.2): the tray's ONE component — an equal-width
 * (flex:1) glass capsule with the param's label, its bridge-APPLIED value
 * in mono, and a 5px clay state dot when the param is manual (glyph +
 * hairline, never color alone). The capsule has NO gestures of its own:
 * the tap docks the precision bar, full stop. Widths never change on tap,
 * on value, or on active state — the row is flex-equalized. An overridden
 * param (EV under manual ISO+shutter) renders dimmed and explains itself
 * on tap rather than pretending to adjust.
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
  /** Transient device feedback (AF running) — the value turns clay. */
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
  // A camera screen is black end-to-end: the app's paper-white theme bg
  // flashed between the preview and a session reconfigure (TestFlight 0.13.0
  // "janky with a white screen" on mode switch).
  root: { flex: 1, backgroundColor: '#000' },
  scrimTop: { position: 'absolute', top: 0, left: 0, right: 0, height: 170 },
  scrimBottom: { position: 'absolute', bottom: 0, left: 0, right: 0, height: 300 },
  // ONE column stack for the seal pill + proof toggles (0.15.0 overlap
  // fix): flexbox lays the rows out, so they can never land on each other
  // the way the old top:0 / top:52 pair could. Side gutters reserve the
  // top-left lock/flash column; the toggle row wraps inside them.
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
  // The mockup's hudpill, shared by every HUD element: translucent dark
  // glass (BlurView intensity 8 at the call sites), a 1px hairline,
  // borderRadius 999, a status dot and a 10.5/700 label.
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
  // The palette's two status-dot colors: sage (steady) and clay (busy).
  hudDotGreen: { backgroundColor: HUD_SEAL_GREEN },
  hudDotBusy: { backgroundColor: HUD_IDENT_ON },
  // Proof toggles: the same glass pill; ON tints the hairline/label with
  // the state color (inline at the call site), OFF is a hollow dot ring.
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
  // The "Sealed" completion flash: the mockup's green-pill hairline tint.
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
  // Quiet hardware-honesty caption: gray, one line, never red.
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
    // No card background: the button floats on the bottom
    // gradient scrim, like Apple's camera chrome.
    alignItems: 'center',
    justifyContent: 'center',
  },
  // The mockup's shutter: a large ink ring with a subtle inner disc — a
  // visible gap between ring and disc, never a heavy filled button.
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
  // Full-width wrapper for the tray/ribbon inside the centered `controls`
  // column — without it the stretch below has nothing to stretch against.
  trayWrap: { alignSelf: 'stretch' },
  // The tray row (0.18.2): flex-equalized capsules, 6px gutters, screen
  // padding both sides. No scroll, no wrap — every param the hardware
  // reports fits at once at 393pt (6 capsules ≈ 55pt each; the longest
  // value text, '1/4000' at 11px mono ≈ 40px, fits with room).
  proTrayRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: spacing.md,
  },
  // The ONE capsule: dark glass (charcoal) over the viewfinder, a 1px
  // hairline, radius 8, a 9px/800 label over an 11px mono value. Equal
  // width via flex:1 — never a width change on tap, value, or state.
  // MANUAL is told by the clay dot + clay hairline + brighter value
  // (glyph, never color alone); OVERRIDDEN dims the whole capsule.
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
    // The HUD's dark-glass hairline — colors.border is the LIGHT scheme's
    // divider gray and glowed white over the viewfinder (0.18.2 field).
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
  // onDark tokens, always: the camera chrome is dark in BOTH schemes, so a
  // scheme color (textFaint) went near-invisible on the glass in light mode.
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

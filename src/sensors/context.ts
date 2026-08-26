// Source Kit 0.1.0 — Capture-time context collection: GPS, compass heading, barometer
// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Capture-time context collection: GPS, compass heading, barometer.
 *
 * Every reading is OPTIONAL and individually disclosed in the attestation
 * record as 'redacted' (user opted out), 'unavailable' (hardware/permission
 * missing), or the value itself. Nothing here is ever fabricated — a null
 * sensor is recorded as null.
 */

import { Platform } from 'react-native';
import * as Location from 'expo-location';
import { Barometer } from 'expo-sensors';
import type { SensorContext, LocationClaim, WifiClaim } from '../provenance/manifest';
import { getCurrentWifi } from '../lib/wifi';
import { analyzeMotion, analyzeTiming, buildPoseTrace, type MotionSample, type PoseSample, type PoseTraceOptions } from './motion';

const LOCATION_TIMEOUT_MS = 4000;

export function altitudeFromPressure(pressureHPa: number): number {
  // International barometric formula, sea-level reference 1013.25 hPa.
  return Math.round(44330 * (1 - Math.pow(pressureHPa / 1013.25, 0.1902949)) * 10) / 10;
}

async function getLocationClaim(): Promise<LocationClaim | 'unavailable'> {
  try {
    const { status } = await Location.getForegroundPermissionsAsync();
    if (status !== 'granted') return 'unavailable';
    const pos = await Promise.race([
      Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), LOCATION_TIMEOUT_MS)),
    ]);
    if (!pos) return 'unavailable';
    return {
      lat: Math.round(pos.coords.latitude * 1e5) / 1e5,
      lon: Math.round(pos.coords.longitude * 1e5) / 1e5,
      accuracyM: pos.coords.accuracy != null ? Math.round(pos.coords.accuracy) : null,
    };
  } catch {
    return 'unavailable';
  }
}

/**
 * The Wi-Fi network the phone reports (W5.7). No permission request happens
 * here — iOS decides from existing state: no location authorization, no
 * Wi-Fi Information entitlement, or no Wi-Fi association all come back as
 * 'unavailable'. The claim is self-reported and spoofable — see WifiClaim.
 */
async function getWifiClaim(): Promise<WifiClaim | 'unavailable'> {
  const claim = await getCurrentWifi();
  return claim ?? 'unavailable';
}

/**
 * The one-shot compass read. 0.18.6: this is NO LONGER the sealed pointing
 * direction — Apple defines CLHeading as the azimuth of the TOP EDGE's
 * horizontal projection, which for the actual shooting stance (phone
 * upright, top edge at the sky) is a near-degenerate number that flips
 * 180° with the sign of the tilt (the field report: "check your sun
 * position map — i'm not sure it's calculated right in the overlay"). The
 * read still runs, for two things: the DECLINATION (trueHeading −
 * magHeading — a property of place and time, independent of how the
 * phone is held), and as the fallback when no pose sample exists.
 */
async function getCompassRead(): Promise<{ trueHeading: number; magHeading: number; accuracy: number } | null> {
  try {
    const { status } = await Location.getForegroundPermissionsAsync();
    if (status !== 'granted') return null;
    const heading = await Location.getHeadingAsync();
    if (heading == null || heading.trueHeading < 0 || heading.magHeading < 0) return null;
    return heading;
  } catch {
    return null;
  }
}

const wrap360 = (deg: number): number => ((deg % 360) + 360) % 360;
const wrap180 = (deg: number): number => ((((deg + 180) % 360) + 360) % 360) - 180;

/**
 * Camera azimuth from the fused attitude (0.18.6; CORRECTED 0.20.5). The
 * rear camera looks out the BACK of the phone — the device −Z axis — and
 * the pose buffer already holds the attitude at 100 Hz, anchored to the
 * shutter instant, so the pointing direction comes from the sample nearest
 * the shutter instead of a compass read taken after the capture call
 * returned (by which time the phone has usually moved). Convention:
 * expo DeviceMotion runs xMagneticNorthZVertical (sdk-54
 * SensorsUtils.swift) and passes CM's attitude through verbatim
 * (DeviceMotionModule.swift: alpha=yaw, beta=pitch, gamma=roll).
 *
 * 0.20.5 CORRECTION — the 0.18.6 comment asserted R = Rz(yaw)·Ry(roll)·Rx(pitch).
 * That was the WRONG chart. CM's documented composition is
 * R = Rz(yaw)·Rx(pitch)·Ry(roll) (Z–X′–Y″: pitch is the asin-clamped
 * middle angle, range [−90°,90°]; the Z-Y-X chart would clamp ROLL, which
 * CM documents as ±180° — contradiction proved the error). Under Z–X′–Y″
 * the device +Z axis in world (third column of R) is:
 *   dz = (sinα·sinβ·cosγ + sinγ·cosα,  sinα·sinγ − sinβ·cosα·cosγ,  cosβ·cosγ)
 * The old formula silently flipped the azimuth ~180° on exactly the common
 * stance of phone-tipped-back (roll ≈ ±180°) — the field failure: camera
 * pointed straight AT the sun (south, 61° elevation → CM reports
 * roll=180, pitch=29, yaw=−90) while the overlay read the sealed heading
 * as north and announced "Sun behind the camera". Verified numerically
 * against constructed poses including that exact one.
 *
 * facing (0.20.5): the FRONT camera looks out device +Z, so its azimuth
 * uses the +z column directly (rear negates it). The result is
 * MAGNETIC-referenced; the caller adds the declination. Returns null when
 * the aim is within ~10° of straight up/down — a bearing is undefined
 * there and no number is invented.
 */
export function cameraAzimuthMagneticDeg(
  rollDeg: number,
  pitchDeg: number,
  yawDeg: number,
  facing: 'front' | 'back' = 'back',
): number | null {
  const RAD = Math.PI / 180;
  const a = yawDeg * RAD;
  const b = pitchDeg * RAD;
  const g = rollDeg * RAD;
  // Device +Z in world = third column of R = Rz(yaw)·Rx(pitch)·Ry(roll).
  const dzx = Math.sin(a) * Math.sin(b) * Math.cos(g) + Math.sin(g) * Math.cos(a);
  const dzy = Math.sin(a) * Math.sin(g) - Math.sin(b) * Math.cos(a) * Math.cos(g);
  // Rear camera = device −Z; front camera = device +Z (0.20.5).
  const cx = facing === 'front' ? dzx : -dzx;
  const cy = facing === 'front' ? dzy : -dzy;
  if (Math.hypot(cx, cy) < 0.17) return null; // sin(10°): aim vertical, bearing undefined
  // Compass azimuth, clockwise from (magnetic) north: east = −Y, north = X.
  return wrap360((Math.atan2(-cy, cx) * 180) / Math.PI);
}

/** The sealed heading: camera azimuth (true north) at the shutter when the
 *  pose buffer reaches it; the plain compass read when it doesn't.
 *  facing (0.20.5): which camera produced the frame — the front camera's
 *  azimuth comes from device +Z, the rear's from −Z.
 *  0.23.0: also returns the declination (true − magnetic) the OS applied.
 *  headingDeg folds it in (azMag + declination), so it is unrecoverable
 *  from the sealed heading — it must be sealed directly, beside it. */
async function getHeadingDeg(
  poseSamples: PoseSample[] | undefined,
  capturedAtMs: number,
  facing: 'front' | 'back' = 'back',
): Promise<{ headingDeg: number | null; declinationDeg: number | null }> {
  const compass = await getCompassRead();
  // The compass's own error cancels in the difference — this is the field
  // model the device applied, and a property of place and time, so it is
  // NOT gated on headingAccuracy (unlike the plain-compass heading below).
  const declinationDeg = compass
    ? Math.round(wrap180(compass.trueHeading - compass.magHeading) * 10) / 10
    : null;
  if (poseSamples && poseSamples.length > 0) {
    let nearest: PoseSample | null = null;
    for (const s of poseSamples) {
      if (!nearest || Math.abs(s.t - capturedAtMs) < Math.abs(nearest.t - capturedAtMs)) nearest = s;
    }
    if (nearest) {
      const azMag = cameraAzimuthMagneticDeg(nearest.roll, nearest.pitch, nearest.yaw, facing);
      if (azMag !== null && declinationDeg !== null) {
        return { headingDeg: Math.round(wrap360(azMag + declinationDeg)), declinationDeg };
      }
      // Degenerate aim or no declination read: fall through to the plain
      // compass value rather than mix a magnetic azimuth into a
      // true-north-referenced field.
    }
  }
  // 0.21.1: the plain-compass fallback seals only a read whose OWN stated
  // accuracy is meaningful. iOS reports headingAccuracy (±°); a read taken
  // near steel, in a car, or mid-stance-change can be ±50° or worse, and a
  // heading that wrong draws a confidently wrong sun ring — strictly worse
  // than no heading (the Capture row then shows '—', honestly). The
  // declination use above is unaffected (a property of place and time).
  return {
    headingDeg: compass && compass.accuracy >= 0 && compass.accuracy <= 25 ? Math.round(compass.trueHeading) : null,
    declinationDeg,
  };
}

let lastPressure: number | null = null;
let barometerSub: { remove: () => void } | null = null;

/** Start the slow barometer feed once per app session. */
export async function startBarometerFeed(): Promise<void> {
  if (barometerSub || Platform.OS === 'web') return;
  try {
    const available = await Barometer.isAvailableAsync();
    if (!available) return;
    Barometer.setUpdateInterval(1000);
    barometerSub = Barometer.addListener(({ pressure }) => {
      lastPressure = pressure;
    });
  } catch {
    // Sensor absent — pressure will be recorded as null.
  }
}

export function stopBarometerFeed(): void {
  barometerSub?.remove();
  barometerSub = null;
}

export async function collectContext(params: {
  includeLocation: boolean;
  includeSensors: boolean;
  /**
   * Wi-Fi network claim (W5.7) — strictly opt-in (Settings default off).
   * Collected whenever enabled, regardless of the location toggle: if the
   * user already granted location permission it succeeds, otherwise iOS
   * returns nothing and the record honestly says 'unavailable'. Always
   * stripped on the de-identify path.
   */
  includeWifi: boolean;
  motionSamples: MotionSample[];
  /** Fused DeviceMotion buffer for the signed pose trace (0.10.0). */
  poseSamples?: PoseSample[];
  /** Shutter moment the pose trace anchors to (default: now). */
  capturedAtMs?: number;
  /** Trace window override — video passes its clip duration. */
  poseTraceOpts?: PoseTraceOptions;
  /** 0.20.5: which camera produced the frame — the azimuth (and the desk's
   *  sun/horizon projections) differ by axis: front looks out device +Z,
   *  rear out −Z. Absent/old callers default to 'back'. */
  cameraFacing?: 'front' | 'back' | null;
  /** 0.20.5: the PRIMARY camera's sealed horizontal field of view
   *  (activeFormat.videoFieldOfView at capture) — drives the horizon
   *  position and the sun in-frame window on the desk. */
  hfovDeg?: number | null;
}): Promise<SensorContext> {
  const { includeLocation, includeSensors, includeWifi, motionSamples } = params;

  const location = includeLocation ? await getLocationClaim() : 'redacted';
  const wifi = includeWifi ? await getWifiClaim() : 'redacted';
  // 0.18.6: heading = camera azimuth AT THE SHUTTER from the pose buffer
  // (true-north via the compass declination); plain compass read only when
  // no pose sample exists. See getHeadingDeg. 0.20.5: facing-aware.
  // 0.23.0: the declination the OS applied is sealed alongside (it is
  // folded into headingDeg and otherwise unrecoverable).
  const heading =
    includeSensors && includeLocation
      ? await getHeadingDeg(params.poseSamples, params.capturedAtMs ?? Date.now(), params.cameraFacing ?? 'back')
      : { headingDeg: null, declinationDeg: null };
  const pressure =
    includeSensors && lastPressure != null ? Math.round(lastPressure * 10) / 10 : null;
  const altitudeM = pressure != null ? altitudeFromPressure(pressure) : null;
  const motion = includeSensors ? analyzeMotion(motionSamples) : null;
  const sensorTiming = includeSensors ? analyzeTiming(motionSamples) : null;
  const poseTrace =
    includeSensors && params.poseSamples
      ? buildPoseTrace(params.poseSamples, params.capturedAtMs ?? Date.now(), params.poseTraceOpts)
      : null;

  return {
    location, headingDeg: heading.headingDeg, declinationDeg: heading.declinationDeg,
    pressureHPa: pressure, altitudeM, motion, sensorTiming, poseTrace, wifi,
    // 0.20.5 additive: only present when the capture path supplied them
    // (absent on older/native-less records — desk falls back to 'back'/26°).
    ...(params.cameraFacing ? { cameraFacing: params.cameraFacing } : {}),
    ...(params.hfovDeg != null ? { hfovDeg: params.hfovDeg } : {}),
  };
}

/** Request the permissions capture needs, up front, with system prompts. */
export async function requestCapturePermissions(includeLocation: boolean): Promise<void> {
  if (includeLocation) {
    try {
      await Location.requestForegroundPermissionsAsync();
    } catch {
      // Denied — location will simply be recorded as 'unavailable'.
    }
  }
}

// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Capture-time context collection: GPS, compass heading, barometer.
 *
 * Every reading is optional and disclosed in the attestation record as
 * 'redacted' (opted out), 'unavailable' (hardware or permission missing), or
 * the value itself. A null sensor is recorded as null.
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
 * The Wi-Fi network the phone reports. No permission is requested here; iOS
 * decides from existing state, and missing location authorization, a missing
 * Wi-Fi Information entitlement, or no association all return 'unavailable'.
 * The claim is self-reported and spoofable — see WifiClaim.
 */
async function getWifiClaim(): Promise<WifiClaim | 'unavailable'> {
  const claim = await getCurrentWifi();
  return claim ?? 'unavailable';
}

/**
 * One-shot compass read. Not the sealed pointing direction: CLHeading is the
 * azimuth of the top edge's horizontal projection, which in the shooting
 * stance (phone upright, top edge skyward) is near-degenerate and flips 180°
 * with the sign of the tilt. It is read for two things: the declination
 * (trueHeading − magHeading, a property of place and time), and as the
 * fallback when no pose sample exists.
 */
async function getCompassRead(): Promise<{ trueHeading: number; magHeading: number } | null> {
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
 * Camera azimuth from the fused attitude. The camera looks out the back of
 * the phone (device −Z), and the pose buffer holds attitude at 100 Hz
 * anchored to the shutter, so the direction comes from the sample nearest
 * the shutter rather than a compass read taken after capture returned.
 * Convention: expo DeviceMotion runs xMagneticNorthZVertical and its Euler
 * angles compose as R = Rz(yaw)·Ry(roll)·Rx(pitch), device→world, with world
 * X = magnetic north, Y = west, Z = up. The result is magnetic-referenced;
 * the caller adds declination. Returns null when the aim is within ~10° of
 * straight up or down, where a bearing is undefined.
 */
export function cameraAzimuthMagneticDeg(rollDeg: number, pitchDeg: number, yawDeg: number): number | null {
  const RAD = Math.PI / 180;
  const a = yawDeg * RAD;
  const b = pitchDeg * RAD;
  const g = rollDeg * RAD;
  // Device +Z in world = third column of R; the camera is −Z.
  const dzx = Math.cos(a) * Math.sin(g) * Math.cos(b) + Math.sin(a) * Math.sin(b);
  const dzy = Math.sin(a) * Math.sin(g) * Math.cos(b) - Math.cos(a) * Math.sin(b);
  const cx = -dzx;
  const cy = -dzy;
  if (Math.hypot(cx, cy) < 0.17) return null; // sin(10°): aim vertical, bearing undefined
  // Compass azimuth, clockwise from (magnetic) north: east = −Y, north = X.
  return wrap360((Math.atan2(-cy, cx) * 180) / Math.PI);
}

/** The sealed heading: camera azimuth (true north) at the shutter when the
 *  pose buffer reaches it, otherwise the plain compass read. */
async function getHeadingDeg(poseSamples: PoseSample[] | undefined, capturedAtMs: number): Promise<number | null> {
  const compass = await getCompassRead();
  if (poseSamples && poseSamples.length > 0) {
    let nearest: PoseSample | null = null;
    for (const s of poseSamples) {
      if (!nearest || Math.abs(s.t - capturedAtMs) < Math.abs(nearest.t - capturedAtMs)) nearest = s;
    }
    if (nearest) {
      const azMag = cameraAzimuthMagneticDeg(nearest.roll, nearest.pitch, nearest.yaw);
      if (azMag !== null && compass) {
        const declination = wrap180(compass.trueHeading - compass.magHeading);
        return Math.round(wrap360(azMag + declination));
      }
      // Degenerate aim or no declination read: fall through to the plain
      // compass value rather than put a magnetic azimuth in a
      // true-north-referenced field.
    }
  }
  return compass ? Math.round(compass.trueHeading) : null;
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
    // Sensor absent: pressure is recorded as null.
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
   * Wi-Fi network claim; opt-in, Settings default off. Collected whenever
   * enabled, regardless of the location toggle: it succeeds if location
   * permission was already granted, otherwise iOS returns nothing and the
   * record says 'unavailable'. Always stripped on the de-identify path.
   */
  includeWifi: boolean;
  motionSamples: MotionSample[];
  /** Fused DeviceMotion buffer for the signed pose trace. */
  poseSamples?: PoseSample[];
  /** Shutter moment the pose trace anchors to (default: now). */
  capturedAtMs?: number;
  /** Trace window override; video passes its clip duration. */
  poseTraceOpts?: PoseTraceOptions;
}): Promise<SensorContext> {
  const { includeLocation, includeSensors, includeWifi, motionSamples } = params;

  const location = includeLocation ? await getLocationClaim() : 'redacted';
  const wifi = includeWifi ? await getWifiClaim() : 'redacted';
  // Heading is the camera azimuth at the shutter from the pose buffer,
  // true-north via the compass declination; the plain compass read is used
  // only when no pose sample exists. See getHeadingDeg.
  const headingDeg =
    includeSensors && includeLocation
      ? await getHeadingDeg(params.poseSamples, params.capturedAtMs ?? Date.now())
      : null;
  const pressure =
    includeSensors && lastPressure != null ? Math.round(lastPressure * 10) / 10 : null;
  const altitudeM = pressure != null ? altitudeFromPressure(pressure) : null;
  const motion = includeSensors ? analyzeMotion(motionSamples) : null;
  const sensorTiming = includeSensors ? analyzeTiming(motionSamples) : null;
  const poseTrace =
    includeSensors && params.poseSamples
      ? buildPoseTrace(params.poseSamples, params.capturedAtMs ?? Date.now(), params.poseTraceOpts)
      : null;

  return { location, headingDeg, pressureHPa: pressure, altitudeM, motion, sensorTiming, poseTrace, wifi };
}

/** Request the permissions capture needs, up front, with system prompts. */
export async function requestCapturePermissions(includeLocation: boolean): Promise<void> {
  if (includeLocation) {
    try {
      await Location.requestForegroundPermissionsAsync();
    } catch {
      // Denied: location is recorded as 'unavailable'.
    }
  }
}

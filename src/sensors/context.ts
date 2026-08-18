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

async function getHeadingDeg(): Promise<number | null> {
  try {
    const { status } = await Location.getForegroundPermissionsAsync();
    if (status !== 'granted') return null;
    const heading = await Location.getHeadingAsync();
    if (heading == null || heading.trueHeading < 0) return null;
    return Math.round(heading.trueHeading);
  } catch {
    return null;
  }
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
  /** Fused DeviceMotion buffer for the signed pose trace. */
  poseSamples?: PoseSample[];
  /** Shutter moment the pose trace anchors to (default: now). */
  capturedAtMs?: number;
  /** Trace window override — video passes its clip duration. */
  poseTraceOpts?: PoseTraceOptions;
}): Promise<SensorContext> {
  const { includeLocation, includeSensors, includeWifi, motionSamples } = params;

  const location = includeLocation ? await getLocationClaim() : 'redacted';
  const wifi = includeWifi ? await getWifiClaim() : 'redacted';
  const headingDeg = includeSensors && includeLocation ? await getHeadingDeg() : null;
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
      // Denied — location will simply be recorded as 'unavailable'.
    }
  }
}

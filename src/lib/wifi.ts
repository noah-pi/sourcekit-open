// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Bridge to the native Wi-Fi info module (modules/wifi-info).
 *
 * Returns the network iOS reports the device is connected to — a SELF-REPORT
 * (network names and MACs are spoofable), signed as a lead for a desk, never
 * proof of place. Null on web, Expo Go, Android, old builds, missing Wi-Fi
 * Information entitlement, missing location permission, or no Wi-Fi
 * association — callers record 'unavailable' and move on; a null here never
 * blocks a capture.
 */

import { Platform } from 'react-native';
import { requireNativeModule } from 'expo-modules-core';
import type { WifiClaim } from '../provenance/manifest';

interface WifiInfoNative {
  /** { ssid, bssid } as iOS reports them, or null when gated/absent. */
  currentWifi(): Promise<{ ssid: string; bssid: string } | null>;
}

let native: WifiInfoNative | null = null;
try {
  if (Platform.OS === 'ios') {
    native = requireNativeModule<WifiInfoNative>('WifiInfo');
  }
} catch {
  native = null;
}

export function wifiInfoAvailable(): boolean {
  return native !== null;
}

/**
 * The network the phone reports right now, or null when iOS won't say.
 * Never throws — capture must survive a missing module or a denied entitlement.
 */
export async function getCurrentWifi(): Promise<WifiClaim | null> {
  if (!native) return null;
  try {
    const net = await native.currentWifi();
    if (!net) return null;
    return {
      // the SSID is deliberately NOT embedded. Anyone can name a network
      // anything (unreliable as evidence) and a network name is a privacy
      // leak ("Starbucks Wi-Fi" places you). The BSSID is the corroboratable
      // claim — a desk can look it up; the app never does.
      ssid: null,
      bssid: typeof net.bssid === 'string' && net.bssid.length > 0 ? net.bssid : null,
    };
  } catch {
    return null;
  }
}

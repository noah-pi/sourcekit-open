// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Bridge to the native Wi-Fi info module (modules/wifi-info).
 *
 * Returns the network iOS reports, a self-report signed as a lead rather than
 * proof of place. Null on web, Expo Go, Android, a missing Wi-Fi Information
 * entitlement, missing location permission, or no association; callers record
 * 'unavailable' and continue, and a null never blocks a capture.
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
 * The network the phone reports right now, or null when iOS will not say.
 * Never throws: capture must survive a missing module or denied entitlement.
 */
export async function getCurrentWifi(): Promise<WifiClaim | null> {
  if (!native) return null;
  try {
    const net = await native.currentWifi();
    if (!net) return null;
    return {
      // SSID is not embedded: a network name is freely chosen and leaks
      // location. The BSSID is the corroboratable claim, which a desk can
      // look up; the app never does. Older sealed records may still carry a
      // name.
      ssid: null,
      bssid: typeof net.bssid === 'string' && net.bssid.length > 0 ? net.bssid : null,
    };
  } catch {
    return null;
  }
}

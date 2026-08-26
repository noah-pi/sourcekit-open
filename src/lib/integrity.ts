// Source Kit 0.1.0 — Device integrity signals
// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Device integrity signals. Signed and self-reported, not a capture gate: a
 * compromised device can lie, so the value is that the claim is bound to the
 * capture and cannot be softened afterwards.
 */

import * as Device from 'expo-device';
import * as FileSystem from 'expo-file-system/legacy';
import { Platform } from 'react-native';
import { enclaveDeviceIntegrity } from './enclave';

export interface DeviceIntegritySignals {
  checkedAt: string;
  /** expo-device believes this is not a physical device. */
  emulatorSuspected: boolean;
  /** Jailbreak indicator paths present on disk (empty = none found). */
  jailbreakIndicators: string[];
  /** Native runtime-instrumentation state; null off iOS or when unavailable. Self-reported. */
  runtimeInstrumentation?: { debuggerAttached: boolean; injectedLibraries: string[] } | null;
  /** Rendered alongside the signals. */
  note: 'self-reported';
}

/** Paths whose presence strongly suggests a jailbroken iOS device. */
const JAILBREAK_PATHS = [
  '/Applications/Cydia.app',
  '/private/var/lib/apt',
  '/private/var/stash',
  '/usr/sbin/frida-server',
];

export async function collectIntegritySignals(): Promise<DeviceIntegritySignals> {
  const found: string[] = [];
  if (Platform.OS === 'ios') {
    for (const path of JAILBREAK_PATHS) {
      try {
        const info = await FileSystem.getInfoAsync(`file://${path}`);
        if (info.exists) found.push(path);
      } catch {
        // Sandboxed reads can fail; recorded as not found.
      }
    }
  }
  return {
    checkedAt: new Date().toISOString(),
    emulatorSuspected: Device.isDevice === false,
    jailbreakIndicators: found,
    runtimeInstrumentation: Platform.OS === 'ios' ? enclaveDeviceIntegrity() : null,
    note: 'self-reported',
  };
}

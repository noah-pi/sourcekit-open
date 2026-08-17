// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Device integrity signals (0.9.0) — a SIGNED, SELF-REPORTED assertion, never
 * a capture gate. A compromised device can lie about being compromised; the
 * value is commitment — the claim is bound to the capture and cannot be
 * retroactively softened. Gating would lock out exactly the journalists whose
 * devices are most attacked while stopping no motivated adversary.
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
  /** Native runtime-instrumentation state; null on old builds / non-iOS. Same ceiling: self-reported, patchable. */
  runtimeInstrumentation?: { debuggerAttached: boolean; injectedLibraries: string[] } | null;
  /** Always shown with the signals — the honest ceiling. */
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
        // Sandboxed reads can fail — absence of evidence, recorded as none.
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

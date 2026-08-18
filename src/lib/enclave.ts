// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Bridge to the native Secure Enclave module (modules/secure-enclave).
 * Absent on web, Expo Go, Android, or old builds — callers must check
 * `enclaveAvailable` and fall back to the software signer.
 */

import { Platform } from 'react-native';
import { requireNativeModule } from 'expo-modules-core';
import { base64ToBytes, bytesToBase64 } from './bytes';

interface SecureEnclaveNative {
  isAvailable(): boolean;
  /** base64 65-byte uncompressed point, or null when no key exists. */
  getPublicKey(): string | null;
  /** Creates the Enclave key if needed; returns base64 public key. */
  generateKey(): string;
  /** ECDSA over a 32-byte digest; returns DER signature base64. */
  sign(digestBase64: string): string;
  deleteKey(): void;
  /** Biometric-bound key: every capture requires Face ID/Touch ID. */
  getBioPublicKey(): string | null;
  generateBioKey(): string;
  signBio(digestBase64: string): string;
  deleteBioKey(): void;
  /**
   * Native seal: SHA-256(payload) AND the Enclave signature in
   * one native call — the payload is never hashed in JS. Returns DER base64.
   */
  seal(payloadBase64: string): string;
  /**
   * Biometric seal: ONE Face ID/Touch ID evaluation, then every payload is
   * signed with that freshly evaluated context, which is invalidated before
   * the call returns. Per-use evaluation — there is no reusable session.
   */
  sealBio(payloadsBase64: string[], reason: string): Promise<string[]>;
  /** Active runtime-instrumentation findings. */
  deviceIntegrity(): { debuggerAttached: boolean; injectedLibraries: string[] };
}

let native: SecureEnclaveNative | null = null;
try {
  if (Platform.OS === 'ios') {
    native = requireNativeModule<SecureEnclaveNative>('SecureEnclave');
  }
} catch {
  native = null;
}

export function enclaveAvailable(): boolean {
  try {
    return native !== null && native.isAvailable();
  } catch {
    return false;
  }
}

export function enclaveGetPublicKey(): Uint8Array | null {
  if (!native) return null;
  const b64 = native.getPublicKey();
  return b64 ? base64ToBytes(b64) : null;
}

export function enclaveGenerateKey(): Uint8Array {
  if (!native) throw new Error('Secure Enclave module unavailable');
  return base64ToBytes(native.generateKey());
}

/** Signs a 32-byte digest inside the Secure Enclave. Returns the DER signature. */
export function enclaveSignDigest(digest: Uint8Array): Uint8Array {
  if (!native) throw new Error('Secure Enclave module unavailable');
  return base64ToBytes(native.sign(bytesToBase64(digest)));
}

export function enclaveDeleteKey(): void {
  native?.deleteKey();
}

export function enclaveBioGetPublicKey(): Uint8Array | null {
  if (!native) return null;
  const b64 = native.getBioPublicKey();
  return b64 ? base64ToBytes(b64) : null;
}

export function enclaveBioGenerateKey(): Uint8Array {
  if (!native) throw new Error('Secure Enclave module unavailable');
  return base64ToBytes(native.generateBioKey());
}

/** Signs inside the Enclave behind a Face ID/Touch ID prompt. Returns DER. */
export function enclaveBioSignDigest(digest: Uint8Array): Uint8Array {
  if (!native) throw new Error('Secure Enclave module unavailable');
  return base64ToBytes(native.signBio(bytesToBase64(digest)));
}

export function enclaveBioDeleteKey(): void {
  native?.deleteBioKey();
}

/**
 * Native seal: SHA-256 + Enclave signature in one native
 * call — the payload is hashed inside the native module, never in JS, which
 * narrows the runtime-instrumentation hook surface. Returns the DER
 * signature. Falls back to null on old native builds so callers can use the
 * JS digest path.
 */
export function enclaveSeal(payload: Uint8Array): Uint8Array | null {
  if (!native || typeof native.seal !== 'function') return null;
  return base64ToBytes(native.seal(bytesToBase64(payload)));
}

/**
 * Biometric native seal: ONE Face ID/Touch ID evaluation covers exactly the
 * payloads in this call; the authenticated context is invalidated natively
 * before the call returns — per-use evaluation, no reusable session (a
 * reusable primed window would let a runtime-instrumented process mint
 * extra signatures silently inside the window). Null on old native builds.
 */
export async function enclaveSealBio(payloads: Uint8Array[], reason: string): Promise<Uint8Array[] | null> {
  if (!native || typeof native.sealBio !== 'function') return null;
  const sigs = await native.sealBio(payloads.map(bytesToBase64), reason);
  return sigs.map(base64ToBytes);
}

/** Active runtime-instrumentation findings; null when the module is absent/old. */
export function enclaveDeviceIntegrity(): { debuggerAttached: boolean; injectedLibraries: string[] } | null {
  if (!native || typeof native.deviceIntegrity !== 'function') return null;
  try {
    return native.deviceIntegrity();
  } catch {
    return null;
  }
}

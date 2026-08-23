// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * ML-DSA-65 key custody. A 32-byte seed in SecureStore is the whole secret;
 * the keypair derives from it on demand, since the 4032-byte ML-DSA secret key
 * exceeds the keychain's per-item value limit. Losing the seed loses the key.
 * Software-protected, not Secure Enclave: it signs alongside the P-256 device
 * key and gates nothing. Assignment mode and de-identified copies must not use
 * it — a long-lived per-device key would re-link captures meant to be
 * unlinkable. Callers enforce that; the store itself is dumb.
 */

import * as SecureStore from 'expo-secure-store';
import { randomBytes } from '@noble/hashes/utils';
import { bytesToBase64, base64ToBytes } from './bytes';
import { pqKeyPairFromSeed, type PqCaptureKey } from './pq';

const STORE_KEY = 'verify_pq_seed_v1';
/** This device only, unlocked only — same protection class as the vault keys. */
const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

let cached: PqCaptureKey | null = null;

/**
 * Returns this device's PQ key, generating and enrolling it on first use.
 * `enrolledAt` is set once at generation and travels in every committed pqKey
 * block; it is device-reported.
 */
export async function getOrCreatePqKey(): Promise<PqCaptureKey> {
  if (cached) return cached;
  const existing = await SecureStore.getItemAsync(STORE_KEY, OPTIONS).catch(() => null);
  if (existing) {
    try {
      const parsed = JSON.parse(existing) as { v?: number; seed?: string; enrolledAt?: string };
      if (parsed.v === 1 && typeof parsed.seed === 'string' && typeof parsed.enrolledAt === 'string') {
        const kp = pqKeyPairFromSeed(base64ToBytes(parsed.seed));
        cached = { ...kp, enrolledAt: parsed.enrolledAt };
        return cached;
      }
    } catch { /* malformed entry — regenerate below */ }
  }
  const seed = randomBytes(32);
  const enrolledAt = new Date().toISOString();
  const kp = pqKeyPairFromSeed(seed);
  await SecureStore.setItemAsync(STORE_KEY, JSON.stringify({ v: 1, seed: bytesToBase64(seed), enrolledAt }), OPTIONS);
  cached = { ...kp, enrolledAt };
  return cached;
}

/** Display info without deriving more than necessary — null when not yet enrolled. */
export async function pqEnrollmentInfo(): Promise<{ fingerprint: string; enrolledAt: string } | null> {
  const existing = await SecureStore.getItemAsync(STORE_KEY, OPTIONS).catch(() => null);
  if (!existing) return null;
  try {
    const parsed = JSON.parse(existing) as { v?: number; seed?: string; enrolledAt?: string };
    if (parsed.v !== 1 || typeof parsed.seed !== 'string') return null;
    const kp = pqKeyPairFromSeed(base64ToBytes(parsed.seed));
    return { fingerprint: kp.fingerprint, enrolledAt: typeof parsed.enrolledAt === 'string' ? parsed.enrolledAt : '' };
  } catch {
    return null;
  }
}

/** Drops the memoized key (app lock). The seed stays in the keychain. */
export function forgetPqKey(): void {
  cached = null;
}

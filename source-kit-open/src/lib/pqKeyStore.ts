/**
 * PQ key custody — the ML-DSA-65 SOFTWARE key.
 *
 * What lives here: a 32-byte seed in the OS keychain (SecureStore), from
 * which the full keypair is derived deterministically on demand. The full
 * 4032-byte ML-DSA secret key exceeds the keychain's per-item value limit;
 * the seed is the whole secret. Losing it loses the key — there is no
 * recovery, and that is honest: this layer is future-proofing against a
 * P-256 break, not identity custody. The classical key remains the device's
 * root of capture identity.
 *
 * Custody honesty (pinned in src/lib/pq.ts): this key is SOFTWARE — keychain
 * protection, not Secure Enclave. It is never displayed as a hardware
 * anchor, and it never gates anything: it signs alongside, never instead.
 *
 * Linkage rule: assignment mode and de-identified copies deliberately do NOT
 * use this key — a long-lived per-device key would re-link captures that
 * exist to be unlinkable. Callers enforce this; the store itself is dumb.
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
 * Returns this device's PQ layer, generating and enrolling it on first use
 * (first capture after the 0.10.0 upgrade). `enrolledAt` is recorded once at
 * generation and travels in every committed pqKey block — device-reported,
 * like every timestamp this app makes.
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

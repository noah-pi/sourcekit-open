/**
 * App-lock passcode: a 6-digit PIN hashed with PBKDF2-SHA256 and a random
 * 128-bit salt, stored in the OS keychain. The PIN itself is never stored.
 *
 * The work factor is recorded per record, so a PIN set under an older,
 * lower iteration count still verifies and is re-derived at the current
 * count on the next successful unlock.
 *
 * Scope: this is a lock, not a vault. The vault's encryption key lives in
 * the keychain and is not derived from the PIN, so a copy of the app's
 * files is useless without the device keychain as well.
 */

import * as SecureStore from 'expo-secure-store';
import { pbkdf2 } from '@noble/hashes/pbkdf2';
import { sha256 } from '@noble/hashes/sha256';
import { randomBytes } from '@noble/hashes/utils';
import { bytesToHex, hexToBytes, utf8ToBytes, equalBytes } from '../lib/bytes';

const STORE_KEY = 'verify_passcode_v1';
const ITERATIONS = 600000;

const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

interface StoredPasscode {
  saltHex: string;
  hashHex: string;
  iterations: number;
}

function derive(pin: string, salt: Uint8Array, iterations: number): Uint8Array {
  return pbkdf2(sha256, utf8ToBytes(pin), salt, { c: iterations, dkLen: 32 });
}

export async function hasPasscode(): Promise<boolean> {
  const raw = await SecureStore.getItemAsync(STORE_KEY, OPTIONS);
  return raw != null;
}

export async function setupPasscode(pin: string): Promise<void> {
  if (!/^\d{6}$/.test(pin)) throw new Error('Passcode must be exactly 6 digits');
  const salt = randomBytes(16);
  const stored: StoredPasscode = {
    saltHex: bytesToHex(salt),
    hashHex: bytesToHex(derive(pin, salt, ITERATIONS)),
    iterations: ITERATIONS,
  };
  await SecureStore.setItemAsync(STORE_KEY, JSON.stringify(stored), OPTIONS);
}

export async function verifyPasscode(pin: string): Promise<boolean> {
  const raw = await SecureStore.getItemAsync(STORE_KEY, OPTIONS);
  if (!raw) return false;
  try {
    const stored: StoredPasscode = JSON.parse(raw);
    const candidate = derive(pin, hexToBytes(stored.saltHex), stored.iterations);
    if (!equalBytes(candidate, hexToBytes(stored.hashHex))) return false;
    // Re-derive at the current work factor. Best-effort: the unlock has
    // already succeeded, so a failed rewrite simply retries next time.
    if (stored.iterations < ITERATIONS) {
      try {
        const salt = randomBytes(16);
        const upgraded: StoredPasscode = {
          saltHex: bytesToHex(salt),
          hashHex: bytesToHex(derive(pin, salt, ITERATIONS)),
          iterations: ITERATIONS,
        };
        await SecureStore.setItemAsync(STORE_KEY, JSON.stringify(upgraded), OPTIONS);
      } catch {
        // A migration failure must never turn a good PIN into a rejection.
      }
    }
    return true;
  } catch {
    return false;
  }
}

export async function removePasscode(): Promise<void> {
  await SecureStore.deleteItemAsync(STORE_KEY, OPTIONS);
}

// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * App-lock passcode: 6-digit PIN, PBKDF2-SHA256 (600,000 iterations) with a
 * random 128-bit salt, stored in the OS keychain — never the PIN itself.
 * Iterations are stored per record: PINs set before the 60k → 600k raise
 * still verify at their recorded work factor, and re-derive to the current
 * one on the next successful unlock.
 *
 * A 6-digit PIN is a lock, not a vault: the vault's actual encryption key
 * lives in the keychain and does not derive from the PIN, so a stolen backup
 * of app files is useless without the device keychain too. The Settings
 * screen says this in plain words.
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
    // Work-factor migration: a record written before the 60k → 600k raise
    // re-derives and re-stores at the current iterations on this successful
    // verify. Best-effort — the unlock already succeeded, and a failed
    // rewrite simply retries at the next one.
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
        // See above — migration failure never turns a good PIN into a failure.
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

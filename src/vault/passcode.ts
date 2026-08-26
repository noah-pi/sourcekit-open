// Source Kit 0.1.0 — app-lock passcode: 6-digit PIN, PBKDF2-SHA256 with a random
// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * App-lock passcode: 6-digit PIN, PBKDF2-SHA256 with a random 128-bit salt,
 * stored in the OS keychain — never the PIN itself. Iterations are stored per
 * record, so a record written at a lower work factor still verifies and
 * re-derives at the current one on the next successful unlock.
 * The vault's encryption key lives in the keychain and does not derive from
 * the PIN.
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
    // Work-factor migration: re-derive and re-store at the current iterations.
    // Best-effort; a failed rewrite retries on the next successful verify.
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
        // Migration failure never fails a good PIN.
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

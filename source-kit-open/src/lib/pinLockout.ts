// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * pinLockout.ts — escalating PIN lockout.
 *
 * Why: the 6-digit PIN gates vault and identity. PBKDF2-SHA256 (600,000
 * iterations — see passcode.ts) makes brute force expensive, but with no
 * attempt counter a patient attacker (or a curious child) gets unlimited
 * tries.
 *
 * Policy: the first 4 failures are free. From the 5th onward each failure
 * locks the keypad, doubling from 30 s up to a 5-minute ceiling:
 *   5th → 30 s, 6th → 60 s, 7th → 2 min, 8th → 4 min, 9th+ → 5 min.
 * A successful unlock resets the counter.
 *
 * Persistence: attempts and the lock-until timestamp live in SecureStore, so
 * force-quitting the app does not reset the lockout. This is device-local
 * hardening, stated plainly: it raises the cost of casual probing; it is not a
 * substitute for iOS's own passcode and hardware protections.
 *
 * Clock note: the lock is wall-clock based. Someone
 * holding the UNLOCKED device can expire a lockout early by rolling the
 * system clock forward. Accepted: React Native exposes no monotonic clock,
 * and that attacker already holds the device — the lock remains a
 * casual-probing speed bump, priced as such.
 */
import * as SecureStore from 'expo-secure-store';

const KEY = 'vault_pin_lockout_v1';
// Same keychain accessibility as passcode.ts: this device only, unlocked only —
// a lockout counter has no business migrating to a new device in a backup.
const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};
const FREE_FAILURES = 4;
const BASE_LOCK_MS = 30_000;
const MAX_LOCK_MS = 300_000;

export type LockoutState = { attempts: number; untilMs: number };

export async function getLockoutState(): Promise<LockoutState> {
  try {
    const raw = await SecureStore.getItemAsync(KEY, OPTIONS);
    if (!raw) return { attempts: 0, untilMs: 0 };
    const parsed = JSON.parse(raw) as LockoutState;
    if (typeof parsed.attempts !== 'number' || typeof parsed.untilMs !== 'number') {
      return { attempts: 0, untilMs: 0 };
    }
    return parsed;
  } catch {
    return { attempts: 0, untilMs: 0 };
  }
}

async function save(s: LockoutState): Promise<void> {
  try {
    await SecureStore.setItemAsync(KEY, JSON.stringify(s), OPTIONS);
  } catch {}
}

export type FailureResult = { attempts: number; lockedForMs: number };

/** Record a failed attempt; returns how long the keypad is now locked (0 if not). */
export async function recordFailure(): Promise<FailureResult> {
  const s = await getLockoutState();
  const attempts = s.attempts + 1;
  let untilMs = 0;
  if (attempts > FREE_FAILURES) {
    const ms = Math.min(BASE_LOCK_MS * 2 ** (attempts - FREE_FAILURES - 1), MAX_LOCK_MS);
    untilMs = Date.now() + ms;
  }
  await save({ attempts, untilMs });
  return { attempts, lockedForMs: Math.max(0, untilMs - Date.now()) };
}

/** Successful unlock — clear the counter. */
export async function resetLockout(): Promise<void> {
  await save({ attempts: 0, untilMs: 0 });
}

/** Remaining lockout in whole seconds (0 when not locked). */
export function lockedSecondsRemaining(untilMs: number): number {
  return Math.max(0, Math.ceil((untilMs - Date.now()) / 1000));
}

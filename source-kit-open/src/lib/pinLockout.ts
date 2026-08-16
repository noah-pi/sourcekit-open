/**
 * Escalating lockout for the app-lock PIN.
 *
 * The first 4 failures are free. From the 5th onward each failure locks the
 * keypad, doubling from 30s to a 5-minute ceiling (30s, 60s, 2m, 4m, then
 * 5m). A successful unlock resets the counter.
 *
 * Attempts and the lock-until timestamp persist in SecureStore, so
 * force-quitting does not clear a lockout.
 *
 * Scope: this raises the cost of casual probing. It is wall-clock based, so
 * someone holding an unlocked device can expire a lockout early by moving
 * the system clock — React Native exposes no monotonic clock. It is not a
 * substitute for the iOS passcode and hardware protections.
 */
import * as SecureStore from 'expo-secure-store';

const KEY = 'vault_pin_lockout_v1';

// Same accessibility class as the passcode record this lockout protects.
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

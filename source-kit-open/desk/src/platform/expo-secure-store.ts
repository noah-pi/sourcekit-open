/**
 * Desk boundary for 'expo-secure-store'.
 *
 * The desk shares the app's verification core (../src) verbatim, and that
 * core's trustProvider imports rosterStore, which imports the Expo keychain
 * module — an API that does not exist in a desktop browser or the Node CLI.
 * The desk never RUNS rosterStore (trust is resolved in
 * core/deskCore.resolveSignerTrust from in-memory rosters the operator
 * imports explicitly), but the shared engine imports its types, so the
 * module must resolve for tsc and for Vite.
 *
 * Rather than a blind `declare module` (which would turn every use into
 * `any` and hide a real runtime need), this is a minimal typed storage
 * adapter implementing exactly the surface rosterStore.ts uses: localStorage
 * in the desk UI, an in-memory map in the Node CLI. If desk code ever does
 * call into it, it behaves like a per-device, this-device-only store — the
 * same honesty semantics as the app keychain, minus the hardware backing
 * (which a desk does not have; nothing here claims otherwise).
 */

export const WHEN_UNLOCKED_THIS_DEVICE_ONLY = 'WHEN_UNLOCKED_THIS_DEVICE_ONLY';

export interface SecureStoreOptions {
  keychainAccessible?: string;
}

/** In-memory fallback for non-browser runtimes (the desk CLI). */
const mem = new Map<string, string>();

const backing = {
  get(key: string): string | null {
    if (typeof localStorage !== 'undefined') return localStorage.getItem(key);
    return mem.has(key) ? mem.get(key)! : null;
  },
  set(key: string, value: string): void {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(key, value);
      return;
    }
    mem.set(key, value);
  },
  remove(key: string): void {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(key);
      return;
    }
    mem.delete(key);
  },
};

export async function getItemAsync(
  key: string,
  _options?: SecureStoreOptions
): Promise<string | null> {
  return backing.get(key);
}

export async function setItemAsync(
  key: string,
  value: string,
  _options?: SecureStoreOptions
): Promise<void> {
  backing.set(key, value);
}

export async function deleteItemAsync(
  key: string,
  _options?: SecureStoreOptions
): Promise<void> {
  backing.remove(key);
}

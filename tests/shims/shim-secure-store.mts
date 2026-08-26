// Source Kit 0.1.0 — lab shim for expo-secure-store
// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Lab shim for expo-secure-store: in-memory keychain stand-in for
 * rosterStore/trustProvider. Each suite gets a fresh module instance.
 */
export const WHEN_UNLOCKED_THIS_DEVICE_ONLY = 'WHEN_UNLOCKED_THIS_DEVICE_ONLY';

export interface SecureStoreOptions {
  keychainAccessible?: string;
  requireAuthentication?: boolean;
  /**
   * Face ID prompt message. Accepted and ignored; the type must carry it or
   * the staged typecheck fails on real app code.
   */
  authenticationPrompt?: string;
  /**
   * vaultFs/pinLockout set WHEN_UNLOCKED_THIS_DEVICE_ONLY and
   * requireAuthentication; the in-memory map accepts and ignores both.
   */
}

const mem = new Map<string, string>();

export async function getItemAsync(key: string, _options?: SecureStoreOptions): Promise<string | null> {
  return mem.has(key) ? mem.get(key)! : null;
}

export async function setItemAsync(key: string, value: string, _options?: SecureStoreOptions): Promise<void> {
  mem.set(key, value);
}

export async function deleteItemAsync(key: string, _options?: SecureStoreOptions): Promise<void> {
  mem.delete(key);
}

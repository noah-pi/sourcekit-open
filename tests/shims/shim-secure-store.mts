// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Lab shim for expo-secure-store: in-memory keychain stand-in so
 * rosterStore/trustProvider can be staged and tested as the real code.
 * Persistence semantics don't matter in the lab — each suite gets a fresh
 * module instance.
 */
export const WHEN_UNLOCKED_THIS_DEVICE_ONLY = 'WHEN_UNLOCKED_THIS_DEVICE_ONLY';

export interface SecureStoreOptions {
  keychainAccessible?: string;
  requireAuthentication?: boolean;
  /**
   * The message iOS shows on the Face ID prompt. The lab never prompts, so
   * this is accepted and ignored — but the app sets it, so the type has to
   * carry it or the staged typecheck fails on real code.
   */
  authenticationPrompt?: string;
  /**
   * The app's vaultFs/pinLockout entries set WHEN_UNLOCKED_THIS_DEVICE_ONLY
   * (+ requireAuthentication on the vault key). The lab's in-memory map
   * accepts and ignores both — accessibility policy is keychain behavior,
   * not lab behavior.
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

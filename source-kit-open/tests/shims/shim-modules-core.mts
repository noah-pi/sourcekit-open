// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Lab shim for expo-modules-core: requireNativeModule returns null — exactly
 * the "module absent" case enclave.ts is written to handle (enclaveAvailable()
 * → false, callers fall back to the software signer). The Secure Enclave is
 * device hardware; the lab never exercises it.
 */
export function requireNativeModule<T>(_name: string): T | null {
  return null;
}

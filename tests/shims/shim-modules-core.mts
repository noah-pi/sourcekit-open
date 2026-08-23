// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Lab shim for expo-modules-core. requireNativeModule returns null, the
 * "module absent" case enclave.ts handles by falling back to the software
 * signer. The Secure Enclave is device hardware and is never exercised here.
 */
export function requireNativeModule<T>(_name: string): T | null {
  return null;
}

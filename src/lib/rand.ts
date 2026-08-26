// Source Kit 0.1.0 — CSPRNG bootstrap
// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * CSPRNG bootstrap. Hermes has no global crypto.getRandomValues, which the
 * noble libraries need, so this installs one backed by expo-crypto's
 * synchronous native CSPRNG. Called once from the app entry, before any
 * crypto code runs.
 */

import * as ExpoCrypto from 'expo-crypto';

export function ensureCryptoPolyfill(): void {
  const g = globalThis as Record<string, unknown>;
  const existing = g.crypto as { getRandomValues?: unknown } | undefined;
  if (existing && typeof existing.getRandomValues === 'function') return;

  g.crypto = {
    ...(existing ?? {}),
    getRandomValues: (arr: Uint8Array): Uint8Array => {
      const bytes = ExpoCrypto.getRandomBytes(arr.byteLength);
      arr.set(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
      return arr;
    },
  };
}

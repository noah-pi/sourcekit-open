// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * CSPRNG bootstrap.
 *
 * The noble libraries call crypto.getRandomValues, which Hermes (React
 * Native's JS engine) does not provide globally. expo-crypto exposes a
 * synchronous native CSPRNG, so we install a minimal polyfill before any
 * crypto code runs. Called once from the app entry.
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

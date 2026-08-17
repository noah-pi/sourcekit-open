// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * AES-256-GCM vault encryption. Pure — depends only on @noble/ciphers.
 *
 * File layout: [ 12-byte nonce ][ ciphertext ][ 16-byte GCM tag ]
 * (noble's gcm() appends the tag to the ciphertext.)
 *
 * The vault key is a random 256-bit value kept in the OS keychain
 * (see src/vault/vaultFs.ts). This module never touches storage.
 */

import { gcm } from '@noble/ciphers/aes';
import { randomBytes } from '@noble/hashes/utils';
import { concatBytes } from './bytes';

const NONCE_LEN = 12;

export function encryptBytes(key: Uint8Array, plaintext: Uint8Array): Uint8Array {
  if (key.length !== 32) throw new Error('Vault key must be 32 bytes');
  const nonce = randomBytes(NONCE_LEN);
  const sealed = gcm(key, nonce).encrypt(plaintext);
  return concatBytes(nonce, sealed);
}

export function decryptBytes(key: Uint8Array, blob: Uint8Array): Uint8Array {
  if (key.length !== 32) throw new Error('Vault key must be 32 bytes');
  if (blob.length < NONCE_LEN + 16) throw new Error('Encrypted blob too short');
  const nonce = blob.subarray(0, NONCE_LEN);
  const sealed = blob.subarray(NONCE_LEN);
  // Throws on authentication-tag mismatch — tampering is never silent.
  return gcm(key, nonce).decrypt(sealed);
}

export function generateVaultKey(): Uint8Array {
  return randomBytes(32);
}

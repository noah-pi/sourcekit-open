// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * WS2 Phase 1: per-leaf salts from one master seed (docs/INTEGRITY.md — selective disclosure).
 *   salt = HKDF-SHA256(ikm = masterSeed, salt = none,
 *                      info = 'exhibit-leaf-v1' || claimId || rungBE, L = 32)
 *   leafDigest = SHA-256('leaf-v1' || canonical(ContextClaim) || salt)
 * The info encoding is injective: claimIds are [a-z0-9.-] and the trailing
 * big-endian rung bytes contain NULs, which that charset never does.
 */

import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import { asciiToBytes, concatBytes, utf8ToBytes } from '../lib/bytes';
import { canonicalize, type JsonValue } from '../lib/canonical';
import type { ContextClaim } from './inventory';

export const LEAF_SALT_INFO_PREFIX = 'exhibit-leaf-v1';
export const LEAF_DIGEST_DOMAIN = 'leaf-v1';
export const MASTER_SEED_BYTES = 32;
export const LEAF_SALT_BYTES = 32;

/** Derive the 32-byte salt committing exactly one (claimId, rung) leaf. */
export function deriveLeafSalt(masterSeed: Uint8Array, claimId: string, rung: number): Uint8Array {
  if (!(masterSeed instanceof Uint8Array) || masterSeed.length !== MASTER_SEED_BYTES) {
    throw new Error(`salts: master seed must be ${MASTER_SEED_BYTES} bytes`);
  }
  if (!Number.isInteger(rung) || rung < 0 || rung > 0xffffffff) {
    throw new Error(`salts: rung must be a uint32, got ${rung}`);
  }
  const rungBE = new Uint8Array(4);
  new DataView(rungBE.buffer).setUint32(0, rung, false);
  const info = concatBytes(utf8ToBytes(LEAF_SALT_INFO_PREFIX), utf8ToBytes(claimId), rungBE);
  return hkdf(sha256, masterSeed, undefined, info, LEAF_SALT_BYTES);
}

/** The committed leaf digest; the salt binds it to the master seed — no seed, no recomputation. */
export function leafDigest(claim: ContextClaim, salt: Uint8Array): Uint8Array {
  if (!(salt instanceof Uint8Array) || salt.length !== LEAF_SALT_BYTES) {
    throw new Error(`salts: leaf salt must be ${LEAF_SALT_BYTES} bytes`);
  }
  const canonical = canonicalize(claim as unknown as JsonValue);
  return sha256(concatBytes(asciiToBytes(LEAF_DIGEST_DOMAIN), utf8ToBytes(canonical), salt));
}

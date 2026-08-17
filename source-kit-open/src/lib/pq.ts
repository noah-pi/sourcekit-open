// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Post-quantum dual-signature layer — ML-DSA-65 (FIPS 204) alongside classical
 * ES256, hedging a future P-256 break. The hedge's teeth: the PQ public key is
 * committed INSIDE the classically signed payload (record.pqKey, OTS-anchored),
 * so stripping the unprotected-header PQ signature is DETECTABLE while forgery
 * stays infeasible. The key is SOFTWARE — no enclave ML-DSA — and no defense
 * against a compromised device. Pure @noble code shared by desk, CLI, and lab.
 */

import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToBase64, base64ToBytes, bytesToHex, utf8ToBytes } from './bytes';

export const PQ_ALG = 'ML-DSA-65';
/** The honest custody label — must appear wherever this layer is displayed. */
export const PQ_CUSTODY = 'software';

/** ML-DSA-65 (FIPS 204) byte sizes — pinned by the test suite. */
export const PQ_SIZES = { publicKey: 1952, secretKey: 4032, signature: 3309 } as const;

/** FIPS 204 context string: domain-separates our signatures from every other protocol's. Fixed forever. */
const PQ_CONTEXT = utf8ToBytes('verify.app/pq-layer-v1');

/** The PQ public-key block committed INSIDE the signed payload — the binding that makes the layer meaningful. */
export interface PqPublicKeyBlock {
  alg: typeof PQ_ALG;
  custody: typeof PQ_CUSTODY;
  /** 1952-byte ML-DSA-65 public key, base64. */
  publicKey: string;
  /** SHA-256 of the public key bytes, hex. */
  fingerprint: string;
  /** When this device generated its PQ key (UTC ISO-8601, device-reported). */
  enrolledAt: string;
}

export interface PqKeyPair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
  /** SHA-256 of the public key bytes, hex. */
  fingerprint: string;
}

/** Capture-side PQ inputs. The secret key never leaves the device; `enrolledAt` is device-reported. */
export interface PqCaptureKey {
  secretKey: Uint8Array;
  publicKey: Uint8Array;
  fingerprint: string;
  enrolledAt: string;
}

/** Adapter for the C2PA claim signer slot — signs the COSE Sig_structure. */
export function pqClaimSigner(pq: PqCaptureKey): { publicKey: Uint8Array; fingerprint: string; sign: (message: Uint8Array) => Uint8Array } {
  return { publicKey: pq.publicKey, fingerprint: pq.fingerprint, sign: (message) => pqSign(pq.secretKey, message) };
}

export function pqFingerprint(publicKey: Uint8Array): string {
  return bytesToHex(sha256(publicKey));
}

/** Fresh ML-DSA-65 keypair. Requires a CSPRNG (app installs the polyfill; Node has crypto). */
export function generatePqKeyPair(): PqKeyPair {
  const { publicKey, secretKey } = ml_dsa65.keygen();
  return { publicKey: new Uint8Array(publicKey), secretKey: new Uint8Array(secretKey), fingerprint: pqFingerprint(new Uint8Array(publicKey)) };
}

/**
 * Deterministic keypair from a 32-byte seed — stored this way because the full
 * ML-DSA secret key (4032 bytes) exceeds the OS keychain's per-item limit.
 * Losing the seed loses the key: no recovery, by design.
 */
export function pqKeyPairFromSeed(seed: Uint8Array): PqKeyPair {
  const { publicKey, secretKey } = ml_dsa65.keygen(seed);
  return { publicKey: new Uint8Array(publicKey), secretKey: new Uint8Array(secretKey), fingerprint: pqFingerprint(new Uint8Array(publicKey)) };
}

/** Reconstruct the public half from a stored secret key (ML-DSA secret keys embed it). */
export function pqPublicKeyFromSecret(secretKey: Uint8Array): Uint8Array {
  return new Uint8Array(ml_dsa65.getPublicKey(secretKey));
}

/** The block committed into signed payloads. */
export function pqPublicBlock(publicKey: Uint8Array, enrolledAt: string): PqPublicKeyBlock {
  return {
    alg: PQ_ALG,
    custody: PQ_CUSTODY,
    publicKey: bytesToBase64(publicKey),
    fingerprint: pqFingerprint(publicKey),
    enrolledAt,
  };
}

/** Parse + shape-check a committed block. Null on anything malformed — fails closed. */
export function pqPublicBlockFrom(x: unknown): { publicKey: Uint8Array; fingerprint: string; enrolledAt: string } | null {
  if (typeof x !== 'object' || x === null) return null;
  const b = x as Record<string, unknown>;
  if (b.alg !== PQ_ALG || b.custody !== PQ_CUSTODY || typeof b.publicKey !== 'string' || typeof b.fingerprint !== 'string') return null;
  try {
    const publicKey = base64ToBytes(b.publicKey);
    if (publicKey.length !== PQ_SIZES.publicKey) return null;
    return { publicKey, fingerprint: b.fingerprint, enrolledAt: typeof b.enrolledAt === 'string' ? b.enrolledAt : '' };
  } catch {
    return null;
  }
}

/** ML-DSA-65 signature over the message (3309 bytes). */
export function pqSign(secretKey: Uint8Array, message: Uint8Array): Uint8Array {
  return new Uint8Array(ml_dsa65.sign(message, secretKey, { context: PQ_CONTEXT }));
}

/** Boolean verification — never throws; malformed input is simply invalid. */
export function pqVerify(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
  try {
    if (publicKey.length !== PQ_SIZES.publicKey || signature.length !== PQ_SIZES.signature) return false;
    return ml_dsa65.verify(signature, message, publicKey, { context: PQ_CONTEXT });
  } catch {
    return false;
  }
}

/**
 * PQ layer check, for display: `present` vs legacy/stripped, `keyCommitted`
 * is the strip detector, custody always reported for honest labeling.
 */
export interface PqLayerCheck {
  present: boolean;
  /** PQ public key was committed inside the signed payload. */
  keyCommitted: boolean;
  /** Embedded/committed public key matches its stated fingerprint. */
  keyFingerprintMatches: boolean;
  /** The ML-DSA signature itself verified. */
  signatureValid: boolean;
  custody: typeof PQ_CUSTODY;
}

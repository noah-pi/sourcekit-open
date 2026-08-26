// Source Kit 0.1.0 — ECDSA P-256 signing and verification of attestation records
// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * ECDSA P-256 (ES256) signing and verification of attestation records.
 * Pure — depends only on @noble libraries and byte utilities.
 *
 * Requires a CSPRNG: on React Native the app entry installs a polyfill backed
 * by expo-crypto (see src/lib/rand.ts). Node provides crypto natively.
 */

import { p256 } from '@noble/curves/p256';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToBase64, base64ToBytes, bytesToHex, hexToBytes, utf8ToBytes } from './bytes';
import { canonicalize } from './canonical';
import { pqFingerprint, pqPublicBlockFrom, pqSign, pqVerify, PQ_CUSTODY, type PqLayerCheck } from './pq';
import type { AttestationRecord } from '../provenance/manifest';
import { signedPayload } from '../provenance/manifest';

export interface DeviceKeyPair {
  /** 32-byte secret scalar, hex. Null when the key lives in the Secure Enclave. */
  privateKeyHex: string | null;
  /** Uncompressed 65-byte point, base64. */
  publicKeyBase64: string;
  /** SHA-256 of the public key bytes, hex. */
  fingerprint: string;
}

/** Hash of the canonical signed payload — this is what ECDSA signs. */
export function payloadDigest(record: AttestationRecord): Uint8Array {
  return sha256(payloadBytes(record));
}

/** The canonical bytes whose SHA-256 the key signs (native seal). */
export function payloadBytes(record: AttestationRecord): Uint8Array {
  return utf8ToBytes(canonicalize(signedPayload(record)));
}

/**
 * Returns a new record with the signature field populated. With signPayload
 * (Secure Enclave backends) the digest and signature happen in one hop inside
 * the native seal, never in JS.
 *
 * With `pq`, the same canonical payload is also signed with ML-DSA-65: one
 * commitment, two signatures. The PQ key is software (src/lib/pq.ts).
 */
export async function signRecord(
  record: AttestationRecord,
  signDigest: (digest: Uint8Array) => Promise<Uint8Array>,
  signPayload?: (payload: Uint8Array) => Promise<Uint8Array>,
  pq?: { secretKey: Uint8Array } | null
): Promise<AttestationRecord> {
  const payload = payloadBytes(record);
  const sigDer = signPayload ? await signPayload(payload) : await signDigest(payloadDigest(record));
  return { ...record, signature: bytesToBase64(sigDer), ...(pq ? { pqSignature: bytesToBase64(pqSign(pq.secretKey, payload)) } : {}) };
}

export interface RecordVerification {
  /** True if the ECDSA signature is valid for the embedded public key. */
  signatureValid: boolean;
  /** Recomputed fingerprint of the embedded public key (must match signer.fingerprint). */
  fingerprintMatches: boolean;
  /**
   * PQ layer evaluation; null when the record carries neither a committed
   * pqKey nor a pqSignature. keyCommitted=true with present=false means the PQ
   * signature was stripped after signing: the commitment sits inside the
   * signed payload, so the gap stays visible.
   */
  pq: PqLayerCheck | null;
}

export function verifyRecordSignature(record: AttestationRecord): RecordVerification {
  const pq = evaluateRecordPq(record);
  if (!record.signature) return { signatureValid: false, fingerprintMatches: false, pq };
  try {
    const pub = base64ToBytes(record.signer.publicKey);
    const fingerprintMatches = bytesToHex(sha256(pub)) === record.signer.fingerprint;
    const signatureValid = p256.verify(base64ToBytes(record.signature), payloadDigest(record), pub, {
      format: 'der',
      lowS: true,
    });
    return { signatureValid, fingerprintMatches, pq };
  } catch {
    return { signatureValid: false, fingerprintMatches: false, pq };
  }
}

/** Evaluates the record's PQ layer — committed key, fingerprint, signature. */
function evaluateRecordPq(record: AttestationRecord): PqLayerCheck | null {
  const block = record.pqKey ? pqPublicBlockFrom(record.pqKey) : null;
  if (!block && !record.pqSignature) return null;
  const keyFingerprintMatches = !!block && pqFingerprint(block.publicKey) === block.fingerprint;
  let signatureValid = false;
  if (block && record.pqSignature) {
    try {
      signatureValid = pqVerify(block.publicKey, payloadBytes(record), base64ToBytes(record.pqSignature));
    } catch {
      signatureValid = false;
    }
  }
  return {
    present: !!record.pqSignature,
    keyCommitted: !!block,
    keyFingerprintMatches,
    signatureValid,
    custody: PQ_CUSTODY,
  };
}

export function sha256Hex(bytes: Uint8Array): string {
  return bytesToHex(sha256(bytes));
}

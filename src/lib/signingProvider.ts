// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * SigningProvider — the pluggable signing seam (portable trust).
 *
 * The rule: certificate and key are supplied at build or runtime by whoever
 * ships the app — never bundled, never hardcoded, no assumption about
 * assurance level. An adopter who later earns a C2PA Trust List certificate
 * implements this one interface and everything upstream (C2PA manifest
 * construction, record signing, verification display) upgrades with no
 * rearchitecting.
 *
 * Reference implementations provided here:
 *   - `fromDeviceSigner`  — the Enclave-backed path (attested / biometric /
 *                           plain Enclave / keychain software fallback), the
 *                           app's production signer.
 *   - `pemSigner`         — a file-based key supplied at runtime (desk
 *                           tooling, adopter CA-issued keys, testing).
 *   - `ephemeralSigner`   — a one-time key that exists only for a single
 *                           operation; used by de-identify re-keying so a
 *                           stripped copy cannot be linked back to the
 *                           device's long-lived fingerprint.
 *
 * The assurance level is a property of the implementation, honestly
 * reported — the UI must never display one tier as another.
 */

import { p256 } from '@noble/curves/p256';
import { sha256 } from '@noble/hashes/sha256';
import { base64ToBytes, bytesToBase64, bytesToHex, hexToBytes } from './bytes';
import type { DeviceSigner } from './deviceKey';

export type AssuranceLevel =
  | 'enclave-attested'   // Secure Enclave key + Apple hardware attestation bound to it
  | 'enclave-biometric' // Secure Enclave key, every signature Face ID-gated (attestation N/A)
  | 'enclave'           // Secure Enclave key, non-extractable
  | 'software'          // keychain-held software key — labeled as such everywhere
  | 'external';         // supplied by an adopter (PEM file, desk key, future Trust List cert)

export interface SigningProvider {
  /** Stable identifier for display and logs — 'device', 'pem:…', 'ephemeral'. */
  readonly id: string;
  readonly assurance: AssuranceLevel;
  /** Uncompressed 65-byte P-256 point, base64. */
  readonly publicKeyBase64: string;
  /** SHA-256 of the public key bytes, hex — the signer's public identity. */
  readonly fingerprint: string;
  /** ECDSA signature over a 32-byte digest, DER, low-S normalized. */
  signDigest(digest: Uint8Array): Promise<Uint8Array>;
  /**
   * Signs sha256(payload). Enclave backends produce digest +
   * signature in one native call. Absent on providers that predate the
   * native seal — callers fall back to signDigest(sha256(payload)).
   */
  signPayload?(payload: Uint8Array): Promise<Uint8Array>;
}

/** Adapts the device signer (any backend) to the provider interface. */
export function fromDeviceSigner(signer: DeviceSigner): SigningProvider {
  const assurance: AssuranceLevel =
    signer.backend === 'secure-enclave-attested'
      ? 'enclave-attested'
      : signer.biometricBound
        ? 'enclave-biometric'
        : signer.backend === 'secure-enclave'
          ? 'enclave'
          : 'software';
  return {
    id: 'device',
    assurance,
    publicKeyBase64: signer.publicKeyBase64,
    fingerprint: signer.fingerprint,
    signDigest: signer.signDigest,
    signPayload: signer.signPayload,
  };
}

function softwareProvider(id: string, assurance: AssuranceLevel, privateKeyHex: string): SigningProvider {
  const pub = p256.getPublicKey(hexToBytes(privateKeyHex), false);
  return {
    id,
    assurance,
    publicKeyBase64: bytesToBase64(pub),
    fingerprint: bytesToHex(sha256(pub)),
    signDigest: async (digest) => p256.sign(digest, hexToBytes(privateKeyHex), { lowS: true }).toDERRawBytes(),
    signPayload: async (payload) => p256.sign(sha256(payload), hexToBytes(privateKeyHex), { lowS: true }).toDERRawBytes(),
  };
}

/**
 * A file-based key supplied at runtime — base64 or hex of the 32-byte
 * secret scalar (the "file-based PEM" reference implementation; PEM armor
 * is a transport detail — strip it before calling). For desk tooling and
 * adopter keys. The key never ships inside the app.
 */
export function pemSigner(keyMaterial: string, id?: string): SigningProvider {
  const clean = keyMaterial.trim();
  const privateKeyHex = /^[0-9a-fA-F]{64}$/.test(clean)
    ? clean.toLowerCase()
    : bytesToHex(base64ToBytes(clean));
  return softwareProvider(id ?? `external:${privateKeyHex.slice(0, 8)}…`, 'external', privateKeyHex);
}

/**
 * A one-time key for a single operation. De-identify re-keying uses this so
 * the anonymised copy's fingerprint shares nothing with the device's — the
 * linkage between identified and anonymised copies is broken by
 * construction, not by promise.
 */
export function ephemeralSigner(id = 'ephemeral'): { provider: SigningProvider; publicKey: Uint8Array } {
  const priv = p256.utils.randomPrivateKey();
  const pub = p256.getPublicKey(priv, false);
  return {
    provider: softwareProvider(id, 'external', bytesToHex(priv)),
    publicKey: pub,
  };
}

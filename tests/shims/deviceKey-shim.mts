// Source Kit 0.1.0 — Keychain tag of the Enclave key; absent for
// Written with AI assistance. Verification: docs/PROVENANCE.md.

import { p256 } from '@noble/curves/p256';
import { sha256 } from '@noble/hashes/sha256';
import { buildSelfSignedCert } from './cert.mts';
import { bytesToBase64, bytesToHex } from './bytes.mts';
import { derNormalizeLowS } from './der.mts';

export interface DeviceSigner {
  backend: 'secure-enclave-attested' | 'secure-enclave' | 'software';
  publicKeyBase64: string;
  fingerprint: string;
  privateKeyHex: string | null;
  biometricBound?: boolean;
  /** Keychain tag of the Enclave key; absent for software signers. */
  enclaveKeyTag?: string;
  signDigest(digest: Uint8Array): Promise<Uint8Array>;
  /** Signs sha256(payload) in one hop — mirrors deviceKey.ts. */
  signPayload(payload: Uint8Array): Promise<Uint8Array>;
}

const priv = p256.utils.randomPrivateKey();
const pub = p256.getPublicKey(priv, false);
// Every signer normalizes to low-S, matching deviceKey.ts.
const signDigest = async (d: Uint8Array) => derNormalizeLowS(p256.sign(d, priv).toDERRawBytes());
const signPayload = async (p: Uint8Array) => derNormalizeLowS(p256.sign(sha256(p), priv).toDERRawBytes());
let certCache: Uint8Array | null = null;

export function labSigner(): DeviceSigner {
  return {
    backend: 'software',
    publicKeyBase64: bytesToBase64(pub),
    fingerprint: bytesToHex(sha256(pub)),
    privateKeyHex: bytesToHex(priv),
    signDigest,
    signPayload,
  };
}

/** Mirrors OrgCredential['info'] (src/lib/orgCert.ts): the fields attest.mts
 * copies into the signed record when an org credential is active. The lab
 * never attaches one — org is always null here. */
export interface ShimOrgInfo {
  subjectOrg: string | null;
  subjectCN: string | null;
  issuerOrg: string | null;
  issuerCN: string | null;
  serialHex: string;
  notBefore: string;
  notAfter: string;
}

export async function getDeviceCertChain(): Promise<{ chain: Uint8Array[]; org: ShimOrgInfo | null; orgStale: boolean }> {
  if (!certCache) certCache = await buildSelfSignedCert(pub, signDigest);
  return { chain: [certCache], org: null, orgStale: false };
}

// Source Kit 0.1.0 — device signing identity
// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Device signing identity.
 *
 * Primary path (iOS): a P-256 key generated INSIDE the Secure Enclave via the
 * native module. The private key is non-extractable — it never exists in app
 * memory and cannot be read out by any process; signing happens on the chip.
 *
 * Fallback path (Android / dev / Expo Go): a software P-256 key stored in the
 * OS keychain via expo-secure-store with WHEN_UNLOCKED_THIS_DEVICE_ONLY —
 * hardware-encrypted at rest, but extractable by the running app. The UI and
 * README state which backend is active; nothing is overstated.
 *
 * The public fingerprint is the device's identity either way, and every
 * attestation it signs is verifiable offline, forever.
 */

import * as SecureStore from 'expo-secure-store';
import { p256 } from '@noble/curves/p256';
import { sha256 } from '@noble/hashes/sha256';
import { buildSelfSignedCert, CERT_ORGANIZATION, CERT_COMMON_NAME } from './cert';
import { parseCertificate } from './x509';
import { base64ToBytes, bytesToBase64, bytesToHex, hexToBytes } from './bytes';
import { derNormalizeLowS } from './der';
import {
  enclaveAvailable,
  enclaveBioDeleteKey,
  enclaveBioGenerateKey,
  enclaveBioGetPublicKey,
  enclaveBioSignDigest,
  enclaveDeleteKey,
  enclaveGenerateKey,
  enclaveGetPublicKey,
  enclaveSeal,
  enclaveSealBio,
  enclaveSignDigest,
  ENCLAVE_KEY_TAG,
  ENCLAVE_BIO_KEY_TAG,
} from './enclave';
import { appAttestSupported, clearAttestation, getAttestState } from './appAttest';
import { orgCertChainForKey, type OrgCredential } from './orgCert';
import { useStore } from '../store/useStore';

const STORE_KEY = 'verify_device_signing_key_v1';
const CERT_KEY = 'verify_device_cert_v2';

const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

export interface DeviceSigner {
  backend: 'secure-enclave-attested' | 'secure-enclave' | 'software';
  /** Uncompressed 65-byte point, base64. */
  publicKeyBase64: string;
  /** SHA-256 of the public key bytes, hex. */
  fingerprint: string;
  /**
   * Software private key, hex — ONLY present for the software fallback.
   * Null for Secure Enclave keys (non-extractable by design).
   */
  privateKeyHex: string | null;
  /** ECDSA signature over a 32-byte digest. Returns DER, low-S normalized. */
  signDigest(digest: Uint8Array): Promise<Uint8Array>;
  /**
   * Signs sha256(payload). On Secure Enclave backends the
   * digest AND the signature are produced in one native call (the payload is
   * never hashed in JS); on the biometric-bound key this is one per-use
   * Face ID/Touch ID evaluation. Returns DER, low-S normalized.
   */
  signPayload(payload: Uint8Array): Promise<Uint8Array>;
  /**
   * True when every signature required Face ID/Touch ID (biometric-bound
   * Enclave key). Mutually exclusive with the attested backend: the App
   * Attest attestation binds the plain Enclave signing key, so while
   * biometric signing is active the bio key signs and the attestation
   * simply doesn't apply; the UI presents that trade-off explicitly.
   */
  biometricBound?: boolean;
  /**
   * Keychain tag of the Secure Enclave key backing this signer, when the
   * backend is an Enclave one (0.20.1 audit, Patch 2). The SDK signing path
   * (c2pa-swift) queries the keychain by tag — without it, sign() falls
   * back to the default tag and a biometric capture would sign with the
   * non-bio key against the bio cert chain.
   */
  enclaveKeyTag?: string;
}

let cached: DeviceSigner | null = null;
let cachedForBio = false;
let cachedCert: Uint8Array | null = null;
let cachedCertFor: string | null = null; // fingerprint the cached cert was built for

/**
 * Signer backed by the biometric-bound Enclave key. Per-use evaluation:
 * every signPayload is ONE Face ID/Touch ID scan whose
 * authenticated context is invalidated natively before the call returns —
 * there is no reusable primed session, so a runtime-instrumented
 * process cannot mint extra signatures silently inside a window.
 */
function bioEnclaveSigner(publicKey: Uint8Array): DeviceSigner {
  return {
    backend: 'secure-enclave',
    publicKeyBase64: bytesToBase64(publicKey),
    fingerprint: bytesToHex(sha256(publicKey)),
    privateKeyHex: null,
    signDigest: async (digest) => derNormalizeLowS(enclaveBioSignDigest(digest)),
    signPayload: async (payload) => {
      const sealed = await enclaveSealBio([payload], 'Authorize signing this capture');
      if (!sealed) {
        // Old native build: hash in JS, per-signature prompt — same semantics.
        return derNormalizeLowS(enclaveBioSignDigest(sha256(payload)));
      }
      return derNormalizeLowS(sealed[0]);
    },
    biometricBound: true,
    enclaveKeyTag: ENCLAVE_BIO_KEY_TAG,
  };
}

function bioPreferred(): boolean {
  try {
    const st = useStore.getState();
    return st.settingsLoaded && st.settings.biometricSigning;
  } catch {
    return false;
  }
}

function softwareSigner(privateKeyHex: string): DeviceSigner {
  const pub = p256.getPublicKey(hexToBytes(privateKeyHex), false);
  return {
    backend: 'software',
    publicKeyBase64: bytesToBase64(pub),
    fingerprint: bytesToHex(sha256(pub)),
    privateKeyHex,
    signDigest: async (digest) =>
      p256.sign(digest, hexToBytes(privateKeyHex), { lowS: true }).toDERRawBytes(),
    signPayload: async (payload) =>
      p256.sign(sha256(payload), hexToBytes(privateKeyHex), { lowS: true }).toDERRawBytes(),
  };
}

function enclaveSigner(publicKey: Uint8Array): DeviceSigner {
  return {
    backend: 'secure-enclave',
    publicKeyBase64: bytesToBase64(publicKey),
    fingerprint: bytesToHex(sha256(publicKey)),
    privateKeyHex: null,
    // The Enclave may emit high-S signatures; normalize for canonical form.
    signDigest: async (digest) => derNormalizeLowS(enclaveSignDigest(digest)),
    signPayload: async (payload) => {
      const sealed = enclaveSeal(payload);
      if (!sealed) return derNormalizeLowS(enclaveSignDigest(sha256(payload))); // old native build
      return derNormalizeLowS(sealed);
    },
    enclaveKeyTag: ENCLAVE_KEY_TAG,
  };
}

export async function getDeviceKey(): Promise<DeviceSigner> {
  const bio = bioPreferred();
  if (cached && cachedForBio === bio) return cached;
  cachedForBio = bio;

  // 0. Biometric-bound Enclave key (explicit user choice — takes precedence;
  //    every signature then requires Face ID, but App Attest cannot apply).
  if (bio && enclaveAvailable()) {
    let pub = enclaveBioGetPublicKey();
    if (!pub) {
      try {
        pub = enclaveBioGenerateKey();
      } catch {
        pub = null; // fall through rather than lock the user out of signing
      }
    }
    if (pub) {
      cached = bioEnclaveSigner(pub);
      return cached;
    }
  }

  // 1. Secure Enclave (iOS, production builds). When Apple's App Attest
  //    attestation is bound to exactly this key (see appAttest.ts), the
  //    backend upgrades to 'secure-enclave-attested' — same key, same
  //    on-chip signing, plus a hardware certificate any verifier can
  //    check offline.
  if (enclaveAvailable()) {
    let pub = enclaveGetPublicKey();
    if (!pub) {
      try {
        pub = enclaveGenerateKey();
      } catch {
        pub = null; // fall through to software on unexpected Enclave failure
      }
    }
    if (pub) {
      const signer = enclaveSigner(pub);
      const attest = appAttestSupported() ? await getAttestState() : null;
      if (attest && attest.boundFingerprint === signer.fingerprint) {
        cached = { ...signer, backend: 'secure-enclave-attested' as const };
        return cached;
      }
      cached = signer;
      return cached;
    }
  }

  // 3. Software fallback (Android, Expo Go, dev).
  const existing = await SecureStore.getItemAsync(STORE_KEY, OPTIONS);
  if (existing) {
    cached = softwareSigner(existing);
    return cached;
  }
  const privateKeyHex = bytesToHex(p256.utils.randomPrivateKey());
  await SecureStore.setItemAsync(STORE_KEY, privateKeyHex, OPTIONS);
  cached = softwareSigner(privateKeyHex);
  return cached;
}

/**
 * True when a DER ECDSA signature carries a non-minimal INTEGER (a leading
 * 0x00 the value doesn't need). Strict DER consumers reject such signatures
 * outright. Lenient reads never throw, so this scans the two INTEGER bodies
 * directly; anything it can't parse returns false — other paths judge that.
 */
function signatureHasNonMinimalDer(sig: Uint8Array): boolean {
  try {
    if (sig[0] !== 0x30) return false;
    let off = 2;
    if (sig[1] & 0x80) off = 2 + (sig[1] & 0x7f);
    for (let k = 0; k < 2; k++) {
      if (sig[off] !== 0x02) return false;
      const len = sig[off + 1];
      if (len > 1 && sig[off + 2] === 0x00 && (sig[off + 3] & 0x80) === 0) return true;
      off += 2 + len;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * The device's self-signed X.509 certificate (DER), embedded as the COSE
 * x5chain in every C2PA signature. Built once from the device key — the
 * Enclave signs the certificate's own TBS — and cached in the keychain.
 */
export async function getDeviceCert(): Promise<Uint8Array> {
  const signer = await getDeviceKey();
  if (cachedCert && cachedCertFor === signer.fingerprint) return cachedCert;
  const certKey = CERT_KEY + '_' + signer.fingerprint.slice(0, 16);
  const stored = await SecureStore.getItemAsync(certKey, OPTIONS);
  if (stored) {
    const storedDer = base64ToBytes(stored);
    // 0.18.2 staleness migration: the subject is the only place the app name
    // lives in the cert, and a Keychain-cached cert minted under the old name
    // ("Exhibit A") survives the update. Same key, same storage key — when
    // the cached subject no longer matches the current constants, fall
    // through to the rebuild below and re-store. Old sealed files are
    // unaffected: their certs travel embedded in the files themselves, and
    // no verification path re-reads this cache.
    let stale = false;
    try {
      const parsed = parseCertificate(storedDer);
      // 0.18.9 heal (auditor: pre-fix derNormalizeLowS emitted a non-minimal
      // INTEGER about once per 128 signatures — one coin flip per install,
      // cached permanently, and embedded in every file that phone sealed).
      // A cached cert whose own signature is non-minimal is treated as stale
      // and rebuilt with the SAME key below. Files sealed before the heal
      // keep their embedded cert — no cache re-read touches them.
      stale = parsed.subjectOrg !== CERT_ORGANIZATION || parsed.subjectCN !== CERT_COMMON_NAME
        || signatureHasNonMinimalDer(parsed.signature);
    } catch {
      stale = false; // parse hiccup — keep the working cert, never brick it
    }
    if (!stale) {
      cachedCert = storedDer;
      cachedCertFor = signer.fingerprint;
      return cachedCert;
    }
  }
  const cert = await buildSelfSignedCert(base64ToBytes(signer.publicKeyBase64), signer.signDigest);
  await SecureStore.setItemAsync(certKey, bytesToBase64(cert), OPTIONS);
  cachedCert = cert;
  cachedCertFor = signer.fingerprint;
  return cert;
}

/**
 * The x5chain for signing: an org credential chain when one is installed for
 * the current key, otherwise the self-signed device cert. `org` carries the
 * credential's display info (issuer, serial, expiry) for the signed record.
 */
export async function getDeviceCertChain(): Promise<{ chain: Uint8Array[]; org: OrgCredential['info'] | null; orgStale: boolean }> {
  const signer = await getDeviceKey();
  const devicePub = base64ToBytes(signer.publicKeyBase64);
  const orgChain = await orgCertChainForKey(devicePub);
  if (orgChain === 'stale') {
    const self = await getDeviceCert();
    return { chain: [self], org: null, orgStale: true };
  }
  if (orgChain) return { chain: orgChain.chain, org: orgChain.info, orgStale: false };
  const self = await getDeviceCert();
  return { chain: [self], org: null, orgStale: false };
}

/** Compromised or sold device? Rotate. Old attestations stay verifiable. */
export async function regenerateDeviceKey(): Promise<DeviceSigner> {
  const bio = bioPreferred();
  cachedForBio = bio;
  if (bio && enclaveAvailable()) {
    enclaveBioDeleteKey();
    const pub = enclaveBioGenerateKey();
    cached = bioEnclaveSigner(pub);
  } else if (
    cached?.backend === 'secure-enclave' ||
    cached?.backend === 'secure-enclave-attested' ||
    (enclaveAvailable() && !cached)
  ) {
    // The old attestation was bound to the old key and goes stale here;
    // the user re-binds on demand (Settings → attest now, 0.9.5).
    enclaveDeleteKey();
    const pub = enclaveGenerateKey();
    cached = enclaveSigner(pub);
  } else {
    const privateKeyHex = bytesToHex(p256.utils.randomPrivateKey());
    await SecureStore.setItemAsync(STORE_KEY, privateKeyHex, OPTIONS);
    cached = softwareSigner(privateKeyHex);
  }
  cachedCert = null; // cert is rebuilt lazily against the new key
  return cached;
}

export async function deleteDeviceKey(): Promise<void> {
  cached = null;
  cachedCert = null;
  try {
    enclaveDeleteKey();
    enclaveBioDeleteKey();
  } catch { /* module absent on this platform */ }
  try {
    await clearAttestation();
  } catch { /* absent */ }
  await SecureStore.deleteItemAsync(STORE_KEY, OPTIONS);
}

// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Device signing identity.
 *
 * Primary path (iOS): a P-256 key generated inside the Secure Enclave via the
 * native module. The private key is non-extractable and signing happens on
 * the chip.
 *
 * Fallback path (Android, dev, Expo Go): a software P-256 key in the OS
 * keychain via expo-secure-store with WHEN_UNLOCKED_THIS_DEVICE_ONLY;
 * hardware-encrypted at rest but extractable by the running app.
 *
 * Either way the device's identity is the public-key fingerprint.
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
  /** Software private key, hex. Null for Secure Enclave keys. */
  privateKeyHex: string | null;
  /** ECDSA signature over a 32-byte digest. Returns DER, low-S normalized. */
  signDigest(digest: Uint8Array): Promise<Uint8Array>;
  /**
   * Signs sha256(payload). Secure Enclave backends produce the digest and the
   * signature in one native call; the biometric-bound key adds one Face
   * ID/Touch ID evaluation per call. Returns DER, low-S normalized.
   */
  signPayload(payload: Uint8Array): Promise<Uint8Array>;
  /**
   * True for the biometric-bound Enclave key, where every signature requires
   * Face ID/Touch ID. Excludes the attested backend: App Attest binds the
   * plain Enclave key, so its attestation does not cover the bio key.
   */
  biometricBound?: boolean;
  /**
   * Keychain tag of the Enclave key this signer uses. The c2pa-swift arm needs
   * it explicitly: without it that path falls back to the default tag and a
   * biometric capture would sign with the non-bio key against the bio
   * certificate. Absent for software signers, which have no keychain key.
   */
  enclaveKeyTag?: string;
}

/** The tags SecureEnclaveModule.swift stores the two Enclave keys under. */
export const ENCLAVE_KEY_TAG = 'com.verify.camera.signing-key';
export const ENCLAVE_BIO_KEY_TAG = 'com.verify.camera.signing-key-bio';

let cached: DeviceSigner | null = null;
let cachedForBio = false;
let cachedCert: Uint8Array | null = null;
let cachedCertFor: string | null = null; // fingerprint the cached cert was built for

/**
 * Signer backed by the biometric-bound Enclave key. Each signPayload is one
 * Face ID/Touch ID scan whose authenticated context is invalidated natively
 * before the call returns, leaving no primed session behind.
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
        // No native sealBio: hash in JS, one prompt per signature.
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
      if (!sealed) return derNormalizeLowS(enclaveSignDigest(sha256(payload))); // no native seal
      return derNormalizeLowS(sealed);
    },
    enclaveKeyTag: ENCLAVE_KEY_TAG,
  };
}

export async function getDeviceKey(): Promise<DeviceSigner> {
  const bio = bioPreferred();
  if (cached && cachedForBio === bio) return cached;
  cachedForBio = bio;

  // 0. Biometric-bound Enclave key, when the setting is on. Takes precedence;
  //    every signature requires Face ID and App Attest does not apply.
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

  // 1. Secure Enclave (iOS, production builds). When an App Attest
  //    attestation is bound to this exact key (see appAttest.ts), the backend
  //    reports 'secure-enclave-attested'.
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
 * The device's self-signed X.509 certificate (DER), embedded as the COSE
 * x5chain in every C2PA signature. Built once from the device key (the
 * Enclave signs the certificate's own TBS) and cached in the keychain.
 */
export async function getDeviceCert(): Promise<Uint8Array> {
  const signer = await getDeviceKey();
  if (cachedCert && cachedCertFor === signer.fingerprint) return cachedCert;
  const certKey = CERT_KEY + '_' + signer.fingerprint.slice(0, 16);
  const stored = await SecureStore.getItemAsync(certKey, OPTIONS);
  if (stored) {
    const storedDer = base64ToBytes(stored);
    // A cached cert whose subject no longer matches CERT_ORGANIZATION /
    // CERT_COMMON_NAME is rebuilt and re-stored under the same key. Sealed
    // files carry their own embedded certs and never read this cache.
    let stale = false;
    try {
      const parsed = parseCertificate(storedDer);
      stale = parsed.subjectOrg !== CERT_ORGANIZATION || parsed.subjectCN !== CERT_COMMON_NAME;
    } catch {
      stale = false; // parse failure: keep the working cert
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

/** Rotates the device key. Attestations signed by the old key stay verifiable. */
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
    // The App Attest attestation was bound to the old key and goes stale
    // here; re-bind from Settings.
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

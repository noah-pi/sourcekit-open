// Source Kit 0.1.0 — Apple certifies that this is genuine Apple hardware
// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * App Attest — Apple certifies that this is genuine Apple hardware running an
 * unmodified build, bound to this device's Secure Enclave signing key.
 *
 * Apps get no SecKey access to App Attest keys, so those keys can never sign
 * manifests. The binding uses emulated key attestation instead:
 *
 *   clientDataHash = SHA256(challenge ‖ signingPublicKey)
 *
 * The binding is embedded in every C2PA manifest as the com.verify.app-attest
 * assertion and re-checks offline against Apple's App Attest root:
 *
 *   nonce (attestation leaf cert, extension 1.2.840.113635.100.8.2)
 *     == SHA256(authData ‖ SHA256(challenge ‖ signingPublicKey))
 *
 * Signing always uses the Enclave key; attestation never gates it.
 *
 * No registry address ships with the app. Attestation runs on first launch
 * with a locally generated challenge and retries on later launches while
 * absent, so no network is required. An org registry (Settings → advanced) is
 * an upgrade path: a server-issued, single-use challenge it verifies itself.
 */

import { Platform } from 'react-native';
import { requireNativeModule } from 'expo-modules-core';
import * as SecureStore from 'expo-secure-store';
import { sha256 } from '@noble/hashes/sha256';
import { p256 } from '@noble/curves/p256';
import { base64ToBytes, bytesToBase64, bytesToHex, concatBytes, utf8ToBytes } from './bytes';
import { enclaveAvailable, enclaveGenerateKey, enclaveGetPublicKey } from './enclave';

interface AppAttestNative {
  isSupported(): boolean;
  hasAttestedKey(): boolean;
  generateAttestKey(): Promise<string>; // keyId
  attestKey(keyId: string, clientDataHashBase64: string): Promise<string>; // attestation object b64
  deleteAttestKey(): void;
}

let native: AppAttestNative | null = null;
try {
  if (Platform.OS === 'ios') native = requireNativeModule<AppAttestNative>('AppAttest');
} catch {
  native = null;
}

const STATE_KEY = 'verify_app_attest_v2';
const SERVER_URL_KEY = 'verify_attest_server_url';
const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

/**
 * The configured registry, or null when none was set. No default is bundled.
 * Any registry speaking the open format in server/ works; the user picks one
 * in Settings.
 */
export async function getAttestServerUrl(): Promise<string | null> {
  const stored = await SecureStore.getItemAsync(SERVER_URL_KEY, OPTIONS).catch(() => null);
  const url = (stored ?? '').trim().replace(/\/+$/, '');
  return url || null;
}

export async function setAttestServerUrl(url: string): Promise<void> {
  await SecureStore.setItemAsync(SERVER_URL_KEY, url.trim(), OPTIONS);
}

export interface AttestState {
  /** App Attest keyId (identifies Apple's attested key, not the signing key). */
  keyId: string;
  /** The Apple attestation object, base64. */
  attestationBase64: string;
  /** The challenge this attestation answered, base64 (registry-issued or local). */
  challengeBase64: string;
  /** SHA-256 of the bound Secure Enclave signing public key, hex. */
  boundFingerprint: string;
  registeredAt: string;
  /** Where the challenge came from. Absent means registry. */
  origin?: 'local' | 'registry';
}

let cachedState: AttestState | null | undefined; // undefined = not loaded

export function appAttestSupported(): boolean {
  try {
    return native !== null && native.isSupported();
  } catch {
    return false;
  }
}

export async function getAttestState(): Promise<AttestState | null> {
  if (cachedState !== undefined) return cachedState;
  const raw = await SecureStore.getItemAsync(STATE_KEY, OPTIONS);
  cachedState = raw ? (JSON.parse(raw) as AttestState) : null;
  return cachedState;
}

/**
 * The assertion payload embedded in C2PA manifests (UTF-8 JSON). Carries
 * everything a verifier needs to re-check the binding offline: the Apple
 * attestation object, the challenge it answered, and the fingerprint of the
 * signing key it is bound to (which must equal the manifest signer's key).
 */
export async function getAttestationAssertion(): Promise<Uint8Array | null> {
  const state = await getAttestState();
  if (!state) return null;
  return utf8ToBytes(
    JSON.stringify({
      format: 'exhibit-app-attest/2',
      attestationBase64: state.attestationBase64,
      challengeBase64: state.challengeBase64,
      boundFingerprint: state.boundFingerprint,
    }),
  );
}

/** The Secure Enclave signing public key (base64), creating the key if needed. */
function enclaveSigningPublicKeyBase64(): string {
  if (!enclaveAvailable()) {
    throw new Error('attestation requires the Secure Enclave signing key');
  }
  let pub = enclaveGetPublicKey();
  if (!pub) pub = enclaveGenerateKey();
  return bytesToBase64(pub);
}

/**
 * Runs the full attestation against `serverUrl`, binding Apple's attestation
 * to `signingPublicKeyBase64` (defaults to the device's Enclave signing key).
 * Idempotent: returns the existing state if it is already bound to that key;
 * re-attests when the signing key has rotated. Throws on failure — the caller
 * decides whether to fall back to the unattested Enclave key.
 */
export async function attestThisDevice(
  serverUrl: string,
  signingPublicKeyBase64?: string,
): Promise<AttestState> {
  if (!native) throw new Error('App Attest module unavailable');
  if (!appAttestSupported()) throw new Error('App Attest not supported on this device');

  const pubB64 = signingPublicKeyBase64 ?? enclaveSigningPublicKeyBase64();
  const pubBytes = base64ToBytes(pubB64);
  const boundFingerprint = bytesToHex(sha256(pubBytes));

  const existing = await getAttestState();
  if (existing && existing.boundFingerprint === boundFingerprint) return existing;

  // 1. Registry challenge (single-use, 5 min TTL).
  const chRes = await fetch(`${serverUrl}/challenge`);
  if (!chRes.ok) throw new Error(`challenge failed: HTTP ${chRes.status}`);
  const { challenge } = (await chRes.json()) as { challenge: string };

  // 2. App Attest key + Apple attestation, with the signing key bound into
  //    the clientDataHash. Apple signs SHA256(authData ‖ clientDataHash) into
  //    the attestation's nonce extension.
  const keyId = await native.generateAttestKey();
  const clientDataHash = sha256(concatBytes(base64ToBytes(challenge), pubBytes));
  const attestationBase64 = await native.attestKey(keyId, bytesToBase64(clientDataHash));

  // 3. Register with the device registry. The server re-derives the same
  //    clientDataHash from challenge + signingPublicKey and rejects the
  //    attestation if Apple's nonce doesn't match it.
  const regRes = await fetch(`${serverUrl}/attest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ challenge, attestation: attestationBase64, signingPublicKey: pubB64 }),
  });
  const reg = (await regRes.json()) as { ok?: boolean; error?: string; fingerprint?: string };
  if (!regRes.ok || !reg.ok) throw new Error(reg.error ?? `registration failed: HTTP ${regRes.status}`);

  const state: AttestState = {
    keyId,
    attestationBase64,
    challengeBase64: challenge,
    boundFingerprint,
    registeredAt: new Date().toISOString(),
    origin: 'registry',
  };
  await SecureStore.setItemAsync(STATE_KEY, JSON.stringify(state), OPTIONS);
  cachedState = state;
  return state;
}

/**
 * Registry-free attestation: the challenge is 32 fresh random bytes generated
 * on-device, no server round-trip. Verifier math is identical; a registry adds
 * only its own independent check.
 */
export async function attestThisDeviceLocally(
  signingPublicKeyBase64?: string,
): Promise<AttestState> {
  if (!native) throw new Error('App Attest module unavailable');
  if (!appAttestSupported()) throw new Error('App Attest not supported on this device');

  const pubB64 = signingPublicKeyBase64 ?? enclaveSigningPublicKeyBase64();
  const pubBytes = base64ToBytes(pubB64);
  const boundFingerprint = bytesToHex(sha256(pubBytes));

  const existing = await getAttestState();
  if (existing && existing.boundFingerprint === boundFingerprint) return existing;

  const challenge = bytesToBase64(p256.utils.randomPrivateKey());
  const keyId = await native.generateAttestKey();
  const clientDataHash = sha256(concatBytes(base64ToBytes(challenge), pubBytes));
  const attestationBase64 = await native.attestKey(keyId, bytesToBase64(clientDataHash));

  const state: AttestState = {
    keyId,
    attestationBase64,
    challengeBase64: challenge,
    boundFingerprint,
    registeredAt: new Date().toISOString(),
    origin: 'local',
  };
  await SecureStore.setItemAsync(STATE_KEY, JSON.stringify(state), OPTIONS);
  cachedState = state;
  return state;
}

/**
 * Launch entry point. Returns the current state when it is bound to the active
 * signing key; otherwise attests silently, via the configured registry when
 * one is set, else with a local challenge. Key rotation invalidates the old
 * binding, so a stale state is replaced. Never throws: any failure resolves
 * null and is retried at the next launch.
 */
export async function ensureAttestation(): Promise<AttestState | null> {
  try {
    if (!native || !appAttestSupported()) return null;
    const pubB64 = enclaveSigningPublicKeyBase64();
    const current = bytesToHex(sha256(base64ToBytes(pubB64)));
    const existing = await getAttestState();
    if (existing && existing.boundFingerprint === current) return existing;
    const registry = await getAttestServerUrl();
    return registry ? await attestThisDevice(registry, pubB64) : await attestThisDeviceLocally(pubB64);
  } catch {
    return null;
  }
}

export async function clearAttestation(): Promise<void> {
  try {
    native?.deleteAttestKey();
  } catch { /* absent */ }
  cachedState = null;
  await SecureStore.deleteItemAsync(STATE_KEY, OPTIONS);
}

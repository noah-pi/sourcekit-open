// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Per-assignment signing keys. No UI path reaches this — there is no
 * assignment picker and useStore clears a stale assignmentId on load — but
 * the signing path still accepts an assignment label.
 *
 * Each label gets its own software key in the OS keychain (not the Secure
 * Enclave), so assignments are unlinkable to each other and to the device
 * fingerprint; captures within one assignment share a key fingerprint and
 * carry the label as plain text in the signed record. Such captures have no
 * hardware attestation and no org credential, which verification reports in
 * the signer block and the "checks not performed" list. The keychain alias is
 * a hash of the label, so labels are not enumerable.
 */

import * as SecureStore from 'expo-secure-store';
import { p256 } from '@noble/curves/p256';
import { sha256 } from '@noble/hashes/sha256';
import { base64ToBytes, bytesToBase64, bytesToHex, hexToBytes, utf8ToBytes } from './bytes';
import { buildSelfSignedCert } from './cert';
import type { DeviceSigner } from './deviceKey';

const KEY_PREFIX = 'verify_assignment_key_';
const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

function aliasFor(label: string): string {
  return KEY_PREFIX + bytesToHex(sha256(utf8ToBytes(label.trim().toLowerCase()))).slice(0, 24);
}

function signerFrom(privateKeyHex: string): DeviceSigner {
  const pub = p256.getPublicKey(hexToBytes(privateKeyHex), false);
  return {
    backend: 'software',
    publicKeyBase64: bytesToBase64(pub),
    fingerprint: bytesToHex(sha256(pub)),
    privateKeyHex,
    signDigest: async (d) => p256.sign(d, hexToBytes(privateKeyHex), { lowS: true }).toDERRawBytes(),
    signPayload: async (p) => p256.sign(sha256(p), hexToBytes(privateKeyHex), { lowS: true }).toDERRawBytes(),
  };
}

/**
 * Signing key for an assignment, generated on first use. Rotation happens
 * only through regenerateAssignmentKey.
 */
export async function getAssignmentKey(label: string): Promise<DeviceSigner> {
  const alias = aliasFor(label);
  const existing = await SecureStore.getItemAsync(alias, OPTIONS);
  if (existing) return signerFrom(existing);
  const privateKeyHex = bytesToHex(p256.utils.randomPrivateKey());
  await SecureStore.setItemAsync(alias, privateKeyHex, OPTIONS);
  return signerFrom(privateKeyHex);
}

/** Fresh key for the assignment; past captures stay verifiable under the old fingerprint. */
export async function regenerateAssignmentKey(label: string): Promise<DeviceSigner> {
  const privateKeyHex = bytesToHex(p256.utils.randomPrivateKey());
  await SecureStore.setItemAsync(aliasFor(label), privateKeyHex, OPTIONS);
  return signerFrom(privateKeyHex);
}

export async function deleteAssignmentKey(label: string): Promise<void> {
  await SecureStore.deleteItemAsync(aliasFor(label), OPTIONS);
}

/** Self-signed certificate for an assignment key (the x5chain for its manifests). */
export async function assignmentCert(signer: DeviceSigner): Promise<Uint8Array> {
  return buildSelfSignedCert(base64ToBytes(signer.publicKeyBase64), signer.signDigest);
}

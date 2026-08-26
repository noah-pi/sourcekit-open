// Source Kit 0.1.0 — Per-assignment signing keys
// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Per-assignment signing keys (0.9.0 source protection).
 *
 * When assignment mode is on, captures sign with a dedicated key per
 * assignment instead of the device's long-lived key:
 *   - assignments are unlinkable to each other and to the device
 *     fingerprint by construction (independent random keys);
 *   - rotating an assignment key breaks linkability across rotations;
 *   - a desk that holds the newsroom roster can still vouch for an
 *     assignment key — the editor adds its fingerprint to the roster,
 *     which is exactly what the roster format is for.
 *
 * The honest cost, stated wherever this is configured: assignment keys are
 * SOFTWARE keys in the OS keychain (not the Secure Enclave), and captures
 * signed with them carry no hardware attestation and no org credential.
 * Verification shows exactly that — the record's signer block and the
 * "checks not performed" list never dress it up.
 *
 * Keys are stored per assignment label (hashed into the keychain alias, so
 * the label itself is not a keychain enumeration leak).
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
 * The signing key for an assignment, generated on first use. Rotation is a
 * deliberate user act (regenerateAssignmentKey), never implicit.
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

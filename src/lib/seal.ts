// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Sealed capture — encryption to a newsroom desk key.
 *
 * Threat model: a seized device should hold ciphertext the photographer
 * cannot open. When a newsroom roster carries a desk encryption key, captures
 * destined for the desk are sealed to that key: the copy that leaves the
 * vault (the share sheet) is readable only by whoever can reconstruct the
 * desk private key from its Shamir shares. The photographer cannot, and
 * neither can anyone holding the device.
 *
 * Construction (ECDH + HKDF + AES-256-GCM, all @noble):
 *   ephemeral X25519 keypair
 *   shared  = X25519(ephemeral private, desk public)
 *   key     = HKDF-SHA256(shared, salt = ephemeralPub || deskPub, info = FORMAT)
 *   payload = AES-256-GCM(key, nonce, plaintext, AAD = header JSON)
 *
 * File layout:
 *   [ 4-byte LE header length ][ header JSON ][ 12-byte nonce ][ ciphertext || 16-byte tag ]
 *
 * The header is the GCM AAD — tampering with it (including swapping the
 * ephemeral key) breaks decryption loudly. It carries ONLY the format tag,
 * the ephemeral public key, and the desk-key fingerprint: enough for a desk
 * to recognize "this is sealed to our key", nothing about the content. The
 * media hash lives INSIDE the ciphertext (in the proof bundle) — a plaintext
 * hash would hand anyone holding the media an equality oracle.
 *
 * Plaintext container:
 *   [ 4-byte LE proof JSON length (0 = none) ][ proof JSON ][ media bytes ]
 *
 * What this does NOT do (honest notes the UI repeats):
 *  - The photographer's own vault copy stays protected by the vault passcode;
 *    sealing protects the desk-bound copies. Seizure guidance stays: lock /
 *    wipe before a crossing.
 *  - The desk key is a software key. Its custody is the Shamir split —
 *    one stolen laptop must not decrypt everything; K shares together, in
 *    one machine's memory, are the whole key while they are there.
 *  - Sealing hides CONTENTS. It never hides that a sealed artifact exists.
 */

import { x25519 } from '@noble/curves/ed25519';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import { gcm } from '@noble/ciphers/aes';
import { randomBytes } from '@noble/hashes/utils';
import { base64ToBytes, bytesToBase64, bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from './bytes';

export const SEAL_FORMAT = 'verify-sealed/1';

export interface SealHeader {
  format: typeof SEAL_FORMAT;
  /** Ephemeral X25519 public key for this artifact (32 bytes, base64). */
  ephemeralPublicKeyBase64: string;
  /** SHA-256 of the desk public key (hex) — which desk key this is sealed to. */
  deskKeyFingerprint: string;
}

export interface SealedContents {
  header: SealHeader;
  /** The proof bundle JSON, if one was sealed alongside the media. */
  proofJson: string | null;
  media: Uint8Array;
}

export function generateDeskKeyPair(): { publicKey: Uint8Array; privateKey: Uint8Array } {
  const privateKey = randomBytes(32);
  return { publicKey: x25519.getPublicKey(privateKey), privateKey };
}

/** Full 64-hex SHA-256 of the desk public key bytes. Never a prefix. */
export function deskKeyFingerprint(publicKey: Uint8Array): string {
  return bytesToHex(sha256(publicKey));
}

function deriveKey(shared: Uint8Array, ephemeralPub: Uint8Array, deskPub: Uint8Array): Uint8Array {
  return hkdf(sha256, shared, concatBytes(ephemeralPub, deskPub), utf8ToBytes(SEAL_FORMAT), 32);
}

/**
 * Seals media (+ optional proof bundle JSON) to a desk public key.
 * Pure and synchronous — no storage, no network.
 */
export function sealToDeskKey(
  media: Uint8Array,
  proofJson: string | null,
  deskPublicKey: Uint8Array,
): Uint8Array {
  if (deskPublicKey.length !== 32) throw new Error('a desk public key is 32 bytes (X25519)');
  const ephemeral = generateDeskKeyPair();
  const shared = x25519.getSharedSecret(ephemeral.privateKey, deskPublicKey);
  const key = deriveKey(shared, ephemeral.publicKey, deskPublicKey);

  const header: SealHeader = {
    format: SEAL_FORMAT,
    ephemeralPublicKeyBase64: bytesToBase64(ephemeral.publicKey),
    deskKeyFingerprint: deskKeyFingerprint(deskPublicKey),
  };
  const headerBytes = utf8ToBytes(JSON.stringify(header));

  const proofBytes = proofJson === null ? new Uint8Array(0) : utf8ToBytes(proofJson);
  const proofLen = new Uint8Array(4);
  new DataView(proofLen.buffer).setUint32(0, proofBytes.length, true);
  const plaintext = concatBytes(proofLen, proofBytes, media);

  const nonce = randomBytes(12);
  const sealed = gcm(key, nonce, headerBytes).encrypt(plaintext);

  const headerLen = new Uint8Array(4);
  new DataView(headerLen.buffer).setUint32(0, headerBytes.length, true);
  return concatBytes(headerLen, headerBytes, nonce, sealed);
}

/**
 * Reads the plaintext header of a sealed artifact — all a desk can know
 * BEFORE reconstructing the private key. Throws if this is not a sealed
 * capture at all.
 */
export function parseSealedHeader(bytes: Uint8Array): SealHeader {
  if (bytes.length < 4) throw new Error('not a sealed capture (too short)');
  const headerLen = new DataView(bytes.buffer, bytes.byteOffset).getUint32(0, true);
  if (headerLen < 2 || headerLen > 4096 || bytes.length < 4 + headerLen + 12 + 16) {
    throw new Error('not a sealed capture (bad header)');
  }
  let header: SealHeader;
  try {
    header = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + headerLen)));
  } catch {
    throw new Error('not a sealed capture (header is not JSON)');
  }
  if (header.format !== SEAL_FORMAT) throw new Error('not a verify-sealed/1 artifact');
  if (typeof header.ephemeralPublicKeyBase64 !== 'string' || typeof header.deskKeyFingerprint !== 'string') {
    throw new Error('sealed capture header is missing fields');
  }
  return header;
}

/**
 * Opens a sealed artifact with the desk private key.
 * Throws — loudly, never a partial result — if the artifact is tampered,
 * sealed to a different desk key, or the key is wrong.
 */
export function unsealWithDeskKey(bytes: Uint8Array, deskPrivateKey: Uint8Array): SealedContents {
  if (deskPrivateKey.length !== 32) throw new Error('a desk private key is 32 bytes (X25519)');
  const header = parseSealedHeader(bytes);
  const deskPub = x25519.getPublicKey(deskPrivateKey);
  if (deskKeyFingerprint(deskPub) !== header.deskKeyFingerprint) {
    throw new Error('this artifact is sealed to a DIFFERENT desk key; check the fingerprint against the roster');
  }
  const headerLen = new DataView(bytes.buffer, bytes.byteOffset).getUint32(0, true);
  const headerBytes = Uint8Array.from(bytes.subarray(4, 4 + headerLen));
  const nonce = bytes.subarray(4 + headerLen, 4 + headerLen + 12);
  const sealed = bytes.subarray(4 + headerLen + 12);

  const ephemeralPub = base64ToBytes(header.ephemeralPublicKeyBase64);
  if (ephemeralPub.length !== 32) throw new Error('sealed capture header has a bad ephemeral key');
  const shared = x25519.getSharedSecret(deskPrivateKey, ephemeralPub);
  const key = deriveKey(shared, ephemeralPub, deskPub);
  // Throws on GCM tag mismatch — tampering (header or payload) is never silent.
  const plaintext = gcm(key, nonce, headerBytes).decrypt(sealed);

  const proofLen = new DataView(plaintext.buffer, plaintext.byteOffset).getUint32(0, true);
  if (plaintext.length < 4 + proofLen) throw new Error('sealed capture payload is truncated');
  const proofJson = proofLen === 0 ? null : new TextDecoder().decode(plaintext.subarray(4, 4 + proofLen));
  return { header, proofJson, media: Uint8Array.from(plaintext.subarray(4 + proofLen)) };
}

/** Convenience: hex forms for UI surfaces. */
export function deskKeyPairFromPrivateHex(privateKeyHex: string): { publicKey: Uint8Array; privateKey: Uint8Array } {
  const privateKey = hexToBytes(privateKeyHex);
  if (privateKey.length !== 32) throw new Error('a desk private key is 64 hex characters');
  return { publicKey: x25519.getPublicKey(privateKey), privateKey };
}

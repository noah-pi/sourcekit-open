/**
 * Shamir secret sharing over GF(256) — desk-key custody.
 *
 * The newsroom desk private key (seal-to-desk) must never sit whole on
 * one laptop: one stolen machine must not decrypt every capture. This module
 * splits a secret (the 32-byte X25519 private key) into N shares, any K of
 * which reconstruct it — the doc-2 constraint, implemented.
 *
 * Share layout (binary): [ x-coordinate: 1 byte ][ y bytes: secret.length ][ tag: 4 bytes ]
 * The tag is the first 4 bytes of SHA-256(secret) — NOT a security boundary
 * (any K shares already yield the key), but a loud error check: shares from
 * different splits, a mistyped share, or K-1 shares padded with garbage all
 * reconstruct the WRONG secret, and the tag catches that instead of silently
 * producing a key that decrypts nothing.
 *
 * Honest limits, stated here because the UI repeats them:
 *  - Fewer than K shares reveal NOTHING about the secret (information-theoretic,
 *    per Shamir's construction over GF(256)).
 *  - Shares do not identify which desk key they belong to beyond the 4-byte
 *    tag — keep them labeled.
 *  - This protects the key at rest. While K shares are combined in a desk
 *    machine's memory to decrypt captures, that machine holds the whole key.
 */

import { randomBytes } from '@noble/hashes/utils';
import { sha256 } from '@noble/hashes/sha256';
import { base64ToBytes, bytesToBase64 } from './bytes';

/* GF(256), reducing polynomial x^8 + x^4 + x^3 + x + 1 (0x11b) — the AES field. */
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  // Generator 3: each step multiplies by 3 — (x << 1) ^ x — reducing mod 0x11b.
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x = (x << 1) ^ x;
    if (x & 0x100) x ^= 0x11b;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

function gmul(a: number, b: number): number {
  return a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]];
}

export interface ShamirShare {
  /** x-coordinate, 1..255. Never 0 (that would BE the secret). */
  x: number;
  /** y-values, one per secret byte. */
  y: Uint8Array;
  /** First 4 bytes of SHA-256(secret) — reconstruction error check. */
  tag: Uint8Array;
}

export const SHARE_TEXT_PREFIX = 'verify-share-v1';

/**
 * Splits `secret` into `count` shares, any `threshold` of which reconstruct it.
 * threshold 2..count, count ≤ 255. Each byte gets its own random polynomial —
 * coefficients from a CSPRNG, thrown away immediately.
 */
export function splitSecret(secret: Uint8Array, threshold: number, count: number): ShamirShare[] {
  if (secret.length === 0) throw new Error('nothing to split');
  if (!Number.isInteger(threshold) || !Number.isInteger(count)) throw new Error('threshold and count must be integers');
  if (threshold < 2) throw new Error('threshold below 2 is not sharing; refuse');
  if (count > 255) throw new Error('at most 255 shares');
  if (threshold > count) throw new Error('threshold cannot exceed the share count');
  const tag = sha256(secret).subarray(0, 4);
  const shares: ShamirShare[] = [];
  for (let x = 1; x <= count; x++) shares.push({ x, y: new Uint8Array(secret.length), tag: Uint8Array.from(tag) });
  for (let byte = 0; byte < secret.length; byte++) {
    // coefficients[0] IS the secret byte; the rest are random.
    const coeffs = randomBytes(threshold);
    coeffs[0] = secret[byte];
    for (const share of shares) {
      // Horner evaluation at x, highest degree first.
      let y = 0;
      for (let c = threshold - 1; c >= 0; c--) y = gmul(y, share.x) ^ coeffs[c];
      share.y[byte] = y;
    }
  }
  return shares;
}

/**
 * Reconstructs the secret from `threshold` or more distinct shares.
 * Throws — never returns a wrong secret silently — on duplicate x-coordinates,
 * mixed share lengths, or a tag mismatch (wrong/mistyped/mismatched shares).
 */
export function combineShares(shares: ShamirShare[]): Uint8Array {
  if (shares.length < 2) throw new Error('reconstruction needs at least 2 shares');
  const len = shares[0].y.length;
  const tag = shares[0].tag;
  const seen = new Set<number>();
  for (const s of shares) {
    if (s.y.length !== len) throw new Error('these shares are not from the same split (lengths differ)');
    if (s.x === 0 || s.x > 255) throw new Error('invalid share coordinate');
    if (seen.has(s.x)) throw new Error(`share #${s.x} was provided twice; shares must be distinct`);
    seen.add(s.x);
    for (let i = 0; i < 4; i++) {
      if (s.tag[i] !== tag[i]) throw new Error('these shares are not from the same split (tags differ)');
    }
  }
  const secret = new Uint8Array(len);
  for (let byte = 0; byte < len; byte++) {
    // Lagrange interpolation at x = 0.
    let acc = 0;
    for (let i = 0; i < shares.length; i++) {
      let num = 1;
      let den = 1;
      for (let j = 0; j < shares.length; j++) {
        if (i === j) continue;
        num = gmul(num, shares[j].x); // (0 - x_j) == x_j in GF(2^n)
        den = gmul(den, shares[i].x ^ shares[j].x); // (x_i - x_j) == (x_i + x_j)
      }
      // divide by den via the multiplicative inverse
      const term = gmul(gmul(shares[i].y[byte], num), EXP[255 - LOG[den]]);
      acc ^= term;
    }
    secret[byte] = acc;
  }
  const check = sha256(secret);
  for (let i = 0; i < 4; i++) {
    if (check[i] !== tag[i]) {
      throw new Error('the shares do not reconstruct a consistent secret: one is mistyped, or they are from different splits');
    }
  }
  return secret;
}

/* ---- Text encoding — shares are meant to be printed, pasted, AirDropped. ---- */

export function shareToBytes(share: ShamirShare): Uint8Array {
  const out = new Uint8Array(1 + share.y.length + 4);
  out[0] = share.x;
  out.set(share.y, 1);
  out.set(share.tag, 1 + share.y.length);
  return out;
}

export function shareFromBytes(bytes: Uint8Array): ShamirShare {
  if (bytes.length < 1 + 1 + 4) throw new Error('not a share (too short)');
  return {
    x: bytes[0],
    y: Uint8Array.from(bytes.subarray(1, bytes.length - 4)),
    tag: Uint8Array.from(bytes.subarray(bytes.length - 4)),
  };
}

/** Human-carryable form: `verify-share-v1:<base64>`. */
export function shareToText(share: ShamirShare): string {
  return `${SHARE_TEXT_PREFIX}:${bytesToBase64(shareToBytes(share))}`;
}

export function shareFromText(text: string): ShamirShare {
  const trimmed = text.trim();
  if (!trimmed.startsWith(`${SHARE_TEXT_PREFIX}:`)) {
    throw new Error(`not a Source Kit key share; expected it to start with "${SHARE_TEXT_PREFIX}:"`);
  }
  try {
    return shareFromBytes(base64ToBytes(trimmed.slice(SHARE_TEXT_PREFIX.length + 1)));
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('not a share')) throw e;
    throw new Error('the share text is corrupted; copy it again in full');
  }
}

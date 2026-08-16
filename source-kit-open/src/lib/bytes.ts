/**
 * Byte-level utilities. Pure — no React Native or Node dependencies.
 * Shared by the signer, the JPEG embedder, and the verifier.
 */

const HEX = '0123456789abcdef';

export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += HEX[bytes[i] >> 4] + HEX[bytes[i] & 15];
  }
  return out;
}

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || /[^0-9a-fA-F]/.test(hex)) {
    throw new Error('Invalid hex string');
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return out;
}

export function utf8ToBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export function bytesToUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_LOOKUP = new Int16Array(128).fill(-1);
for (let i = 0; i < B64.length; i++) B64_LOOKUP[B64.charCodeAt(i)] = i;

export function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/=+$/, '').replace(/\s/g, '');
  const len = clean.length;
  // Strict validation: B64_LOOKUP[bad] would fall through `|| 0` — and
  // since 'A' legitimately maps to 0, invalid characters decoded as 'A',
  // turning malformed input into silent garbage instead of an error.
  // Reject anything outside the alphabet.
  for (let i = 0; i < len; i++) {
    const code = clean.charCodeAt(i);
    if (code > 127 || B64_LOOKUP[code] < 0) throw new Error('base64: invalid character');
  }
  const out = new Uint8Array(Math.floor((len * 3) / 4));
  // Chars past the end of the final partial group decode as 0 (padding).
  const v = (i: number) => (i < len ? B64_LOOKUP[clean.charCodeAt(i)] : 0);
  let p = 0;
  for (let i = 0; i < len; i += 4) {
    const c1 = v(i);
    const c2 = v(i + 1);
    const c3 = v(i + 2);
    const c4 = v(i + 3);
    if (p < out.length) out[p++] = (c1 << 2) | (c2 >> 4);
    if (p < out.length) out[p++] = ((c2 & 15) << 4) | (c3 >> 2);
    if (p < out.length) out[p++] = ((c3 & 3) << 6) | c4;
  }
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice = bytes.subarray(i, Math.min(i + CHUNK, bytes.length));
    out += String.fromCharCode.apply(null, slice as unknown as number[]);
  }
  if (typeof btoa !== 'undefined') return btoa(out);
  // Minimal fallback — never hit on Hermes or Node >= 16 (both provide btoa).
  let res = '';
  for (let i = 0; i < out.length; i += 3) {
    const a = out.charCodeAt(i);
    const b = i + 1 < out.length ? out.charCodeAt(i + 1) : NaN;
    const c = i + 2 < out.length ? out.charCodeAt(i + 2) : NaN;
    res += B64[a >> 2] + B64[((a & 3) << 4) | (b >> 4)];
    res += isNaN(b) ? '==' : B64[((b & 15) << 2) | (c >> 6)] + (isNaN(c) ? '=' : B64[c & 63]);
  }
  return res;
}

export function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const a of arrays) total += a.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

/** Constant-time equality for fixed-length comparisons. */
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export function asciiToBytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0x7f;
  return out;
}

/**
 * ECDSA signature format plumbing: DER ↔ IEEE P1363 (raw r‖s), plus low-S
 * normalization. COSE requires P1363; iOS Security returns DER; low-S keeps
 * signatures canonical (BIP-62 style) so every verifier accepts them.
 * Pure module.
 */

/** Parses a DER ECDSA signature into its r and s integers (32 bytes each). */
export function derToRS(der: Uint8Array): { r: Uint8Array; s: Uint8Array } {
  if (der[0] !== 0x30) throw new Error('not a DER signature');
  let i = 2; // skip SEQUENCE tag + short length
  if (der[1] & 0x80) i = 2 + (der[1] & 0x7f);
  const readInt = (): Uint8Array => {
    if (der[i] !== 0x02) throw new Error('expected INTEGER');
    const len = der[i + 1];
    let v = der.subarray(i + 2, i + 2 + len);
    i += 2 + len;
    // strip leading zero padding, left-pad to 32
    while (v.length > 32 && v[0] === 0) v = v.subarray(1);
    if (v.length > 32) throw new Error('integer too large');
    if (v.length === 32) return v;
    const out = new Uint8Array(32);
    out.set(v, 32 - v.length);
    return out;
  };
  const r = readInt();
  const s = readInt();
  return { r, s };
}

/** DER → 64-byte P1363 r‖s, with low-S normalization applied. */
export function derToP1363LowS(der: Uint8Array): Uint8Array {
  const { r, s } = derToRS(der);
  const out = new Uint8Array(64);
  out.set(r, 0);
  out.set(lowS(s), 32);
  return out;
}

/** DER → DER with s normalized to the lower half of the curve order. */
export function derNormalizeLowS(der: Uint8Array): Uint8Array {
  const { r, s } = derToRS(der);
  const sLow = lowS(s);
  const enc = (v: Uint8Array): Uint8Array => {
    const needsPad = v[0] & 0x80;
    const body = needsPad ? prepend(v, 0) : v;
    const out = new Uint8Array(2 + body.length);
    out[0] = 0x02;
    out[1] = body.length;
    out.set(body, 2);
    return out;
  };
  const er = enc(r);
  const es = enc(sLow);
  const total = er.length + es.length;
  const out = new Uint8Array(2 + total);
  out[0] = 0x30;
  out[1] = total;
  out.set(er, 2);
  out.set(es, 2 + er.length);
  return out;
}

// P-256 group order n and n/2, as 32-byte big-endian values.
const N = hex(
  'ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551'
);
const N_HALF = hex(
  '7fffffff800000007fffffffffffffffde737d56d38bcf4279dce5617e3192a8'
);

function hex(s: string): Uint8Array {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function prepend(v: Uint8Array, b: number): Uint8Array {
  const out = new Uint8Array(v.length + 1);
  out[0] = b;
  out.set(v, 1);
  return out;
}

function cmp(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < 32; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

/** Returns min(s, n−s) as 32 bytes. */
function lowS(s: Uint8Array): Uint8Array {
  if (cmp(s, N_HALF) <= 0) return s;
  const out = new Uint8Array(32);
  let borrow = 0;
  for (let i = 31; i >= 0; i--) {
    const d = N[i] - s[i] - borrow;
    if (d < 0) { out[i] = d + 256; borrow = 1; } else { out[i] = d; borrow = 0; }
  }
  return out;
}

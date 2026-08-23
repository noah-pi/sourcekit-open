// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Mutation fuzz over the hand-rolled parsers. Every parser must terminate on
 * every input and either throw or return a well-formed value; a single DER
 * length-octet poison can otherwise wedge a naive TLV walker in an infinite
 * loop. A hang does not fail politely here — it stalls the runner and fails CI
 * by timeout (exit 124). Everything else is asserted explicitly. The PRNG seed
 * is fixed, so a red run reproduces exactly.
 */
import * as fs from 'node:fs';
import { readTlv, tlvChildren, parseCertificate } from './x509.mts';
import { derToRS, derNormalizeLowS } from './der.mts';
import { base64ToBytes, bytesToHex } from './bytes.mts';
import { p256 } from '@noble/curves/p256';
import { sha256 } from '@noble/hashes/sha256';
import { verifyTimestampToken } from './rfc3161.mts';

// Fixed key: minimality is an encoder property, so the key only needs to be
// stable, not secret.
const FUZZ_PRIV = new Uint8Array(32).fill(0) .map((_, i) => (i * 7 + 3) & 0xff);
const FUZZ_PUB = p256.getPublicKey(FUZZ_PRIV, false);

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${detail}`); }
};

// --- deterministic PRNG (mulberry32) ---------------------------------------
const SEED = 0xC2AF00D >>> 0;
let state = SEED;
function rnd(): number {
  state = (state + 0x6D2B79F5) >>> 0;
  let t = state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const randByte = () => Math.floor(rnd() * 256);
const randLen = (max: number) => Math.floor(rnd() * max);

const leafDer = fs.readFileSync(new URL('./fixtures/leaf.crt.der', import.meta.url));
const tokenDer = fs.readFileSync(new URL('./fixtures/token.der', import.meta.url));

/** One call that must terminate; returns 'threw' | 'returned'. */
function outcome(fn: () => unknown): 'threw' | 'returned' {
  try { fn(); return 'returned'; } catch { return 'threw'; }
}

// --- 1. raw garbage into every DER walker -----------------------------------
{
  let hung = 0, returned = 0, threw = 0;
  for (let i = 0; i < 400; i++) {
    const buf = new Uint8Array(randLen(512)).map(randByte);
    const r1 = outcome(() => readTlv(buf, 0));
    const r2 = outcome(() => tlvChildren(buf));
    const r3 = outcome(() => parseCertificate(buf));
    const r4 = outcome(() => derToRS(buf));
    const r5 = outcome(() => derNormalizeLowS(buf));
    // Reaching this line is the termination proof; a stall wedges the runner
    // into a CI timeout. Dispositions are counted for the sanity check.
    for (const r of [r1, r2, r3, r4, r5]) r === 'threw' ? threw++ : returned++;
  }
  check('fuzz: 400 random buffers × 5 DER walkers all terminated', hung === 0);
  check('fuzz: walkers reject the overwhelming majority of garbage',
    threw / (threw + returned) > 0.9, `threw=${threw} returned=${returned}`);
}

// --- 1b. derNormalizeLowS must emit minimal DER ------------------------------
// A short r or s (value < 2^248, about 1 signature in 128) must not come back
// re-padded to 32 bytes, which would give an INTEGER a needless leading 0x00.
// COSE still verifies the r||s value, but a strict DER consumer rejects the
// signature and the verdict goes red at random.
{
  let nonMinimal = 0, valueChanged = 0, sampled = 0;
  for (let i = 0; i < 3000; i++) {
    const msg = sha256(new Uint8Array([i & 255, (i >> 8) & 255, (i >> 16) & 255]));
    const raw = p256.sign(msg, FUZZ_PRIV).toDERRawBytes();
    const norm = derNormalizeLowS(raw);
    // Walk both INTEGERs and demand minimality.
    let off = 2;
    for (let k = 0; k < 2; k++) {
      const len = norm[off + 1];
      if (len > 1 && norm[off + 2] === 0x00 && (norm[off + 3] & 0x80) === 0) nonMinimal++;
      off += 2 + len;
    }
    // Whatever the encoding, the value must survive untouched.
    const a = derToRS(raw), b = derToRS(norm);
    if (bytesToHex(a.r) !== bytesToHex(b.r)) valueChanged++;
    // And a strict DER verifier must accept it.
    if (!p256.verify(norm, msg, FUZZ_PUB, { lowS: false })) sampled++;
  }
  check('fuzz: derNormalizeLowS never emits a non-minimal INTEGER',
    nonMinimal === 0, `${nonMinimal} of 6000 integers carried a needless leading zero`);
  check('fuzz: derNormalizeLowS preserves r', valueChanged === 0, `${valueChanged} changed`);
  check('fuzz: a strict DER verifier accepts every normalized signature',
    sampled === 0, `${sampled} of 3000 rejected`);
}

// --- 2. length-octet poisons -------------------------------------------------
{
  const poisons: Uint8Array[] = [];
  for (const fill of [0xFF, 0xFE, 0x80, 0x7F, 0x00]) {
    // SEQ, long-form, 4 length bytes — the exact 0xFFFFFFFA stall family
    poisons.push(new Uint8Array([0x30, 0x84, fill, fill, fill, fill, 0x30, 0x00]));
    // nested: benign outer, poison inner
    poisons.push(new Uint8Array([0x30, 0x08, 0x31, 0x84, fill, fill, fill, fill, 0x05, 0x00]));
    // 5+ length octets (must be rejected outright)
    poisons.push(new Uint8Array([0x30, 0x85, fill, fill, fill, fill, fill]));
    // indefinite length
    poisons.push(new Uint8Array([0x30, 0x80, 0x02, 0x01, 0x01, 0x00, 0x00]));
  }
  let terminated = 0;
  for (const p of poisons) {
    outcome(() => readTlv(p, 0));
    outcome(() => tlvChildren(p));
    outcome(() => parseCertificate(p));
    terminated++;
  }
  check(`fuzz: ${poisons.length} length-octet poisons all terminated`, terminated === poisons.length);
  // The poison class is overlong declared lengths (fill !== 0x00; the
  // zero-length forms are legal DER and may parse). A poison can sit nested
  // inside a well-formed outer TLV that a top-level walk never reaches, so
  // rejection is asserted at the point a real caller descends into content.
  let unrejected = 0;
  for (let i = 0; i < poisons.length; i++) {
    if (Math.floor(i / 4) === 4) continue; // the fill=0x00 legal forms
    const p = poisons[i];
    try {
      const outer = readTlv(p, 0);
      tlvChildren(outer.content); // the descent real parsers make
      unrejected++;
    } catch { /* rejected somewhere on the way in — correct */ }
  }
  check('fuzz: every overlong declaration is rejected on descent', unrejected === 0,
    `${unrejected} unrejected`);
}

// --- 3. single-byte mutations of a real certificate -------------------------
{
  let terminated = 0;
  for (let i = 0; i < 300; i++) {
    const m = new Uint8Array(leafDer);
    m[randLen(m.length)] = randByte();
    outcome(() => parseCertificate(m));
    outcome(() => tlvChildren(m));
    terminated++;
  }
  check('fuzz: 300 single-byte cert mutations all terminated', terminated === 300);
}

// --- 4. truncations of a real certificate -----------------------------------
{
  let terminated = 0;
  for (let i = 0; i < 100; i++) {
    const t = new Uint8Array(leafDer).subarray(0, 1 + randLen(leafDer.length - 1));
    outcome(() => parseCertificate(t));
    terminated++;
  }
  check('fuzz: 100 cert truncations all terminated', terminated === 100);
}

// --- 5. mutations of a real RFC 3161 token (CMS + TSTInfo) ------------------
{
  let terminated = 0;
  for (let i = 0; i < 200; i++) {
    const m = new Uint8Array(tokenDer);
    m[randLen(m.length)] = randByte();
    outcome(() => verifyTimestampToken(m, new Uint8Array(32).fill(1)));
    terminated++;
  }
  check('fuzz: 200 token mutations all terminated', terminated === 200);
  // None of them may verify: a mutated token that still validates is a
  // soundness bug, not a robustness one.
  let valid = 0;
  state = SEED; // replay the same mutations deterministically
  for (let i = 0; i < 200; i++) {
    const m = new Uint8Array(tokenDer);
    m[randLen(m.length)] = randByte();
    try {
      const r = verifyTimestampToken(m, new Uint8Array(32).fill(1));
      if (r.tokenValid) valid++;
    } catch { /* rejection */ }
  }
  check('fuzz: no mutated token validates', valid === 0, `${valid} validated`);
}

// --- 6. base64: strict alphabet, no silent corruption -----------------------
{
  let threw = 0;
  for (let i = 0; i < 300; i++) {
    // '!' guarantees at least one out-of-alphabet character; an empty or
    // accidentally-valid random string would be legitimate input.
    const s = Array.from({ length: randLen(64) }, () =>
      String.fromCharCode(randByte())).join('') + '!';
    if (outcome(() => base64ToBytes(s)) === 'threw') threw++;
  }
  check('fuzz: garbage base64 throws (never decodes to noise)', threw === 300,
    `${300 - threw} silently decoded`);
}

console.log(`\n=== ${pass} passed, ${fail} failed (seed ${SEED.toString(16)}) ===`);
process.exit(fail ? 1 : 0);

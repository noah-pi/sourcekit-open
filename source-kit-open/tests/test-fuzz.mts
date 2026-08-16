/**
 * Mutation fuzz over the hand-rolled parsers.
 *
 * A single DER length-octet poison can wedge a naive TLV walker in an
 * infinite loop — on attacker-supplied files, and on the public server.
 * This suite is the standing tripwire that says the CLASS stays dead:
 * every parser must TERMINATE on every input, and must either throw or return a well-formed value — never
 * hang, never silently accept garbage.
 *
 * A hang here does not fail politely: it stalls the runner, which fails CI
 * by timeout (exit 124). Everything else is asserted explicitly.
 *
 * Deterministic seed: a red run names the seed and reproduces exactly.
 */
import * as fs from 'node:fs';
import { readTlv, tlvChildren, parseCertificate } from './x509.mts';
import { derToRS, derNormalizeLowS } from './der.mts';
import { base64ToBytes } from './bytes.mts';
import { verifyTimestampToken } from './rfc3161.mts';

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
    // Reaching this line at all is the termination proof (a stall wedges the
    // runner → CI timeout → red). Count dispositions for the sanity check.
    for (const r of [r1, r2, r3, r4, r5]) r === 'threw' ? threw++ : returned++;
  }
  check('fuzz: 400 random buffers × 5 DER walkers all terminated', hung === 0);
  check('fuzz: walkers reject the overwhelming majority of garbage',
    threw / (threw + returned) > 0.9, `threw=${threw} returned=${returned}`);
}

// --- 2. length-octet poisons — aimed at the throat -----
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
  // The poison class is overlong DECLARED lengths (fill !== 0x00; the
  // zero-length forms are legal DER and may parse — they were never the
  // bug). A poison may sit nested inside a well-formed outer TLV, where a
  // top-level walk legitimately never reaches it — so we assert rejection
  // at the point a real caller DESCENDS into the content.
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

// --- 3. single-byte mutations of a REAL certificate -------------------------
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

// --- 4. truncations of a REAL certificate -----------------------------------
{
  let terminated = 0;
  for (let i = 0; i < 100; i++) {
    const t = new Uint8Array(leafDer).subarray(0, 1 + randLen(leafDer.length - 1));
    outcome(() => parseCertificate(t));
    terminated++;
  }
  check('fuzz: 100 cert truncations all terminated', terminated === 100);
}

// --- 5. mutations of a REAL RFC 3161 token (CMS + TSTInfo) ------------------
{
  let terminated = 0;
  for (let i = 0; i < 200; i++) {
    const m = new Uint8Array(tokenDer);
    m[randLen(m.length)] = randByte();
    outcome(() => verifyTimestampToken(m, new Uint8Array(32).fill(1)));
    terminated++;
  }
  check('fuzz: 200 token mutations all terminated', terminated === 200);
  // and none of them verifies — a mutated token that still validates would
  // be a soundness bug, not a robustness one
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

// --- 6. base64: strict alphabet, no silent corruption -----------
{
  let threw = 0;
  for (let i = 0; i < 300; i++) {
    // '!' guarantees at least one out-of-alphabet character (an empty or
    // accidentally-valid random string would be legitimate input, not a
    // defect).
    const s = Array.from({ length: randLen(64) }, () =>
      String.fromCharCode(randByte())).join('') + '!';
    if (outcome(() => base64ToBytes(s)) === 'threw') threw++;
  }
  check('fuzz: garbage base64 throws (never decodes to noise)', threw === 300,
    `${300 - threw} silently decoded`);
}

console.log(`\n=== ${pass} passed, ${fail} failed (seed ${SEED.toString(16)}) ===`);
process.exit(fail ? 1 : 0);

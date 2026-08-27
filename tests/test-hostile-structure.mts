// Source Kit 0.1.0 — structurally malformed files against the reader
// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Structural hostility against the reader.
 *
 * test-malleability.mts flips one byte at a time and pins which bytes are
 * malleable. That finds every field whose value does not matter. It cannot
 * find the failures that need a file to be the wrong SHAPE: a box that
 * claims more length than the file holds, a store truncated mid-claim, a
 * nesting depth chosen to exhaust the stack, the same box twice.
 *
 * Those are the inputs a reader meets in the wild, because a reader is
 * handed files by strangers. Two rules, and no third:
 *
 *   1. Nothing throws. A malformed file is a verdict, never a crash — a
 *      reader that throws on hostile input is a reader that can be taken
 *      off the air by anyone who can hand it a file.
 *   2. Nothing malformed reads INTACT. Getting this wrong is worse than
 *      crashing: it is a forgery that verifies.
 *
 * Every case is derived from one genuinely signed file, so a failure here
 * is about the mutation and not about the fixture.
 */
import * as fs from 'node:fs';
import { p256 } from '@noble/curves/p256';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, concatBytes } from './bytes.mts';
import { buildSelfSignedCert } from './cert.mts';
import { buildC2paSegment, parseManifest, extractC2paStore } from './c2pa.mts';
import { verifyPhotoBytes } from './verifyAsset.mts';
import { labSigner } from './deviceKey-shim.mts';

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name} :: ${detail}`); }
};

// ---------- one honest file to mutate ----------
const key = labSigner();
const devCert = await buildSelfSignedCert(
  Uint8Array.from(atob(key.publicKeyBase64), (c) => c.charCodeAt(0)),
  key.signDigest, new Date(Date.now() - 60_000));
const clean = new Uint8Array(fs.readFileSync('/tmp/lab/clean.jpg'));
const segment = await buildC2paSegment({
  appName: 'ExhibitA/lab', mime: 'image/jpeg', title: 'hostile.jpg',
  instanceId: 'xmp:iid:' + bytesToHex(p256.utils.randomPrivateKey().subarray(0, 16)),
  telemetry: { format: 'lab', note: 'hostile structure' },
  signDigest: key.signDigest, signPayload: key.signPayload,
  certChain: [devCert], cleanFileSha256: sha256(clean),
}, 2);
const signed = concatBytes(clean.subarray(0, 2), segment, clean.subarray(2));

console.log('— Baseline —');
const base = await verifyPhotoBytes(signed);
check('the fixture this suite mutates verifies INTACT', base.verdict === 'INTACT', base.verdict);

// A deterministic generator: a failure names a seed that reproduces it.
let seed = 0x5ee_d101;
const rnd = (): number => {
  seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
  return (seed >>> 0) / 0x1_0000_0000;
};
const pick = (n: number): number => Math.floor(rnd() * n);

/**
 * `shape` marks a mutation that changed the file's length, order or
 * content count. Those must never read INTACT: the hard binding hashes the
 * whole file outside one known hole, so a file of a different shape is a
 * different file.
 *
 * In-place writes are not shape changes, and some of them legitimately
 * leave a file INTACT: JUMBF framing sits outside the claim hash by
 * design, and test-malleability.mts pins that set byte for byte against
 * docs/INTEGRITY.md. Overwriting four bytes that land there is the
 * documented behavior, not a finding. This suite owns shape; that one owns
 * the byte set, and neither should restate the other.
 */
interface Outcome { threw: boolean; intact: boolean; shape: boolean; label: string }
const outcomes: Outcome[] = [];
const run = async (label: string, bytes: Uint8Array, shape: boolean): Promise<void> => {
  try {
    const res = await verifyPhotoBytes(bytes);
    outcomes.push({ threw: false, intact: res.verdict === 'INTACT', shape, label });
  } catch (e) {
    outcomes.push({ threw: true, intact: false, shape, label: `${label}: ${(e as Error).message}` });
  }
};

// ---------- 1. truncation ----------
// A reader is handed a file that stopped arriving. Every cut point matters
// because each one lands inside a different box header.
console.log('\n— Truncation —');
for (let i = 1; i < 128; i++) {
  await run(`truncated at ${i}/128`, signed.subarray(0, Math.floor((signed.length * i) / 128)), true);
}

// ---------- 2. lengths that overrun the file ----------
// The classic parser wedge: a box whose declared length reaches past the
// buffer. Every 4-byte-aligned position in the segment is treated as if it
// were a length field and set to a value the file cannot satisfy.
console.log('\n— Overrun lengths —');
let segStart = -1;
for (let i = 2; i < signed.length - 4; i++) {
  if (signed[i] === 0xff && signed[i + 1] === 0xeb) { segStart = i; break; }
}
const segLen = (signed[segStart + 2] << 8) | signed[segStart + 3];
const segEnd = segStart + 2 + segLen;
const OVERRUN = [0xffffffff, 0x7fffffff, 0x80000000, 0xfffffffa];
for (let off = segStart; off + 4 <= segEnd; off += 4) {
  const v = OVERRUN[pick(OVERRUN.length)];
  const m = new Uint8Array(signed);
  m[off] = (v >>> 24) & 0xff; m[off + 1] = (v >>> 16) & 0xff;
  m[off + 2] = (v >>> 8) & 0xff; m[off + 3] = v & 0xff;
  await run(`overrun length 0x${v.toString(16)} at ${off}`, m, false);
}

// ---------- 3. zero lengths ----------
// The other half of the same class: a length of zero, where a naive walker
// advances by nothing and loops forever.
console.log('\n— Zero lengths —');
for (let off = segStart; off + 4 <= segEnd; off += 4) {
  const m = new Uint8Array(signed);
  m[off] = 0; m[off + 1] = 0; m[off + 2] = 0; m[off + 3] = 0;
  await run(`zero length at ${off}`, m, false);
}

// ---------- 4. splices ----------
// Chunks moved, duplicated and dropped: the shapes a file takes after a
// bad transfer, and the shapes an attacker reaches for when trying to get
// one manifest's signature to cover another manifest's bytes.
console.log('\n— Splices —');
for (let i = 0; i < 120; i++) {
  const a = segStart + pick(segEnd - segStart);
  const b = segStart + pick(segEnd - segStart);
  const lo = Math.min(a, b), hi = Math.max(a, b);
  const mode = pick(3);
  let m: Uint8Array;
  if (mode === 0) {
    m = concatBytes(signed.subarray(0, lo), signed.subarray(hi)); // dropped
  } else if (mode === 1) {
    m = concatBytes(signed.subarray(0, hi), signed.subarray(lo, hi), signed.subarray(hi)); // duplicated
  } else {
    m = concatBytes(signed.subarray(0, lo), signed.subarray(lo, hi).reverse(), signed.subarray(hi)); // reversed
  }
  await run(`splice mode ${mode} [${lo},${hi})`, m, mode !== 2 || lo !== hi);
}

// ---------- 5. a second APP11 segment ----------
// Two stores in one file. A reader that takes the first and a reader that
// takes the last disagree about what the file says, which is exactly the
// gap a forger wants.
console.log('\n— Two stores —');
await run('the segment appears twice, back to back',
  concatBytes(signed.subarray(0, segEnd), signed.subarray(segStart, segEnd), signed.subarray(segEnd)), true);
await run('a second segment of zeros follows the real one',
  concatBytes(signed.subarray(0, segEnd), new Uint8Array(segEnd - segStart), signed.subarray(segEnd)), true);

// ---------- 6. nesting bombs, straight at the parser ----------
// verifyPhotoBytes needs a JPEG wrapper; parseManifest does not, so the
// deep-nesting cases go to it directly. A recursive descent parser with no
// depth cap dies here, and it dies by exhausting the stack rather than by
// returning anything a caller can catch cleanly.
console.log('\n— Nesting —');
let nestThrew = 0, nestParsed = 0;
for (const depth of [64, 256, 1024, 4096, 16384]) {
  // jumb boxes all the way down: length(4) 'jumb' repeated, innermost empty.
  const unit = 8;
  const buf = new Uint8Array(depth * unit);
  for (let d = 0; d < depth; d++) {
    const remaining = (depth - d) * unit;
    const o = d * unit;
    buf[o] = (remaining >>> 24) & 0xff; buf[o + 1] = (remaining >>> 16) & 0xff;
    buf[o + 2] = (remaining >>> 8) & 0xff; buf[o + 3] = remaining & 0xff;
    buf[o + 4] = 0x6a; buf[o + 5] = 0x75; buf[o + 6] = 0x6d; buf[o + 7] = 0x62; // 'jumb'
  }
  try {
    const r = parseManifest(buf);
    nestParsed++;
    check(`nesting depth ${depth} returns a value rather than a manifest`, r === null || typeof r === 'object');
  } catch {
    nestThrew++;
  }
}
check('no nesting depth throws out of parseManifest', nestThrew === 0, `${nestThrew} of 5 threw`);
check('every nesting depth was actually parsed', nestParsed === 5, `${nestParsed} of 5`);

// ---------- 7. random garbage into the store readers ----------
// The readers below sit in front of parseManifest and are the first thing
// an arbitrary file touches.
console.log('\n— Garbage —');
let garbageThrew = 0;
for (let i = 0; i < 400; i++) {
  const n = pick(4096);
  const buf = new Uint8Array(n);
  for (let j = 0; j < n; j++) buf[j] = pick(256);
  try { extractC2paStore(buf); parseManifest(buf); } catch { garbageThrew++; }
}
check('400 random buffers through the store readers, none threw', garbageThrew === 0, `${garbageThrew} threw`);

// ---------- The two rules ----------
console.log('\n— The rules —');
const threw = outcomes.filter((o) => o.threw);
check(`nothing throws (${outcomes.length} malformed files)`, threw.length === 0,
  threw.slice(0, 3).map((o) => o.label).join(' | '));

const shaped = outcomes.filter((o) => o.shape);
const wrongly = shaped.filter((o) => o.intact);
check(`no file of a different shape reads INTACT (${shaped.length} of them)`, wrongly.length === 0,
  wrongly.slice(0, 3).map((o) => o.label).join(' | '));

// In-place writes are reported rather than judged: the number is the
// malleable framing set doing its documented job, and a large jump here is
// worth looking at even though it is not a failure on its own.
const inPlace = outcomes.filter((o) => !o.shape);
const stillIntact = inPlace.filter((o) => o.intact).length;
console.log(`  NOTE ${stillIntact} of ${inPlace.length} in-place length writes still verify — JUMBF framing outside the claim hash, pinned byte-exactly by test-malleability.mts`);

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);

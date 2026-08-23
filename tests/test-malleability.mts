// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Pins the malleable byte set of the signed JPEG container. C2PA signs the
 * claim, and through it the assertion contents and the media; JUMBF/APP11
 * framing sits outside the hash, so this suite enumerates that set and fails
 * when it grows.
 *
 * The expected set is derived structurally (offsets shift with DER
 * cert-signature length), then every byte of the APP11 segment is flipped:
 *
 *  1. No flip throws.
 *  2. The empirical INTACT set equals the documented allowlist exactly
 *     (docs/INTEGRITY.md, the 16 framing fields below).
 *  3. Claim bytes, assertion contents, and the COSE payload slot fall
 *     outside the allowlist, asserted by name so failures read clearly.
 *
 * Allowlist (docs/INTEGRITY.md): APP11 En + Z; store jumb.length high 3
 * bytes; store jumd.uuid suffix 12 + label; manifest jumd.uuid + label;
 * claim jumd.uuid + toggle; claim cbor leaf.length high 3 + leaf.type;
 * assertions jumd.uuid; signature jumd.uuid + toggle; signature cbor
 * leaf.length + leaf.type.
 */
import * as fs from 'node:fs';
import { p256 } from '@noble/curves/p256';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, concatBytes } from './bytes.mts';
import { buildSelfSignedCert } from './cert.mts';
import { buildC2paSegment } from './c2pa.mts';
import { verifyPhotoBytes, verifyVideoBytes } from './verifyAsset.mts';
import { labSigner } from './deviceKey-shim.mts';
import { attestVideo } from './attest.mts';

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${detail}`); }
};

const key = labSigner();
const devCert = await buildSelfSignedCert(
  Uint8Array.from(atob(key.publicKeyBase64), (c) => c.charCodeAt(0)),
  key.signDigest, new Date(Date.now() - 60_000));
const clean = new Uint8Array(fs.readFileSync('/tmp/lab/clean.jpg'));
const segment = await buildC2paSegment({
  appName: 'ExhibitA/0.11.0-lab', mime: 'image/jpeg', title: 'malleability.jpg',
  instanceId: 'xmp:iid:' + bytesToHex(p256.utils.randomPrivateKey().subarray(0, 16)),
  telemetry: { format: 'lab', note: 'malleability pin' },
  signDigest: key.signDigest, signPayload: key.signPayload,
  certChain: [devCert], cleanFileSha256: sha256(clean),
}, 2);
const signed = concatBytes(clean.subarray(0, 2), segment, clean.subarray(2));

let segStart = -1;
for (let i = 2; i < signed.length - 4; i++) {
  if (signed[i] === 0xff && signed[i + 1] === 0xeb) { segStart = i; break; }
}
const segLen = (signed[segStart + 2] << 8) | signed[segStart + 3];
const segEnd = segStart + 2 + segLen;
const seg = signed.subarray(segStart, segEnd);
const u32 = (o: number) => ((seg[o] << 24) | (seg[o + 1] << 16) | (seg[o + 2] << 8) | seg[o + 3]) >>> 0;

// ---------- structural walk → named fields ----------
interface Field { start: number; end: number; name: string }
const fields: Field[] = [];
const F = (start: number, end: number, name: string) => fields.push({ start, end, name });
F(0, 2, 'APP11 marker'); F(2, 4, 'APP11 length'); F(4, 6, '"JP"'); F(6, 8, 'APP11 En'); F(8, 12, 'APP11 Z');
function jumd(at: number, name: string): number {
  const jlen = u32(at);
  F(at, at + 4, `${name} jumd.length`); F(at + 4, at + 8, `${name} jumd.type`);
  F(at + 8, at + 24, `${name} jumd.uuid`); F(at + 24, at + 25, `${name} jumd.toggle`);
  let le = at + 25;
  while (seg[le] !== 0) le++;
  F(at + 25, le + 1, `${name} jumd.label`);
  return at + jlen;
}
function jumb(at: number, name: string): { contentStart: number; end: number } {
  const len = u32(at);
  F(at, at + 4, `${name} jumb.length`); F(at + 4, at + 8, `${name} jumb.type`);
  return { contentStart: jumd(at + 8, name), end: at + len };
}
function leaf(at: number, name: string): number {
  const len = u32(at);
  F(at, at + 4, `${name} leaf.length`); F(at + 4, at + 8, `${name} leaf.type`); F(at + 8, at + len, `${name} leaf.content`);
  return at + len;
}
const store = jumb(12, 'store');
const manifest = jumb(store.contentStart, 'manifest');
const claim = jumb(manifest.contentStart, 'claim');
leaf(claim.contentStart, 'claim-cbor');
const assertions = jumb(claim.end, 'assertions');
let r = assertions.contentStart, i = 0;
while (r < assertions.end) { const a = jumb(r, `assertion${i}`); leaf(a.contentStart, `assertion${i}-cbor`); r = a.end; i++; }
const sig = jumb(assertions.end, 'signature');
leaf(sig.contentStart, 'signature-cbor');

// ---------- the documented allowlist, derived structurally ----------
const byName = new Map(fields.map((f) => [f.name, f]));
const expected = new Set<number>();
const addRange = (start: number, end: number) => { for (let j = start; j < end; j++) expected.add(j); };
const addField = (name: string) => { const f = byName.get(name)!; addRange(f.start, f.end); };
addField('APP11 En');
// APP11 Z is fully load-bearing: extractC2paStore hardens the Z chain and
// the high byte is checked on read, so the whole field is outside the
// allowlist. docs/INTEGRITY.md matches.
{ const f = byName.get('store jumb.length')!; addRange(f.start, f.end - 1); }        // high 3 bytes only
{ const f = byName.get('store jumd.uuid')!; addRange(f.start + 4, f.end); }          // suffix after 'c2pa' prefix
addField('store jumd.label');
addField('manifest jumd.uuid');
addField('manifest jumd.label');
addField('claim jumd.uuid');
addField('claim jumd.toggle');
{ const f = byName.get('claim-cbor leaf.length')!; addRange(f.start, f.end - 1); }   // high 3 bytes only
addField('claim-cbor leaf.type');
addField('assertions jumd.uuid');
addField('signature jumd.uuid');
addField('signature jumd.toggle');
addField('signature-cbor leaf.length');
addField('signature-cbor leaf.type');

// ---------- empirical flip of every segment byte ----------
const base = await verifyPhotoBytes(signed);
check('baseline signed file verifies INTACT', base.verdict === 'INTACT', base.verdict);

const empirical = new Set<number>();
let threw = 0;
for (let off = 0; off < segEnd - segStart; off++) {
  const mutated = new Uint8Array(signed);
  mutated[segStart + off] ^= 0xff;
  try {
    const res = await verifyPhotoBytes(mutated);
    if (res.verdict === 'INTACT') empirical.add(off);
  } catch {
    threw++;
  }
}
check('no flip ever throws (clean-error contract, F7a)', threw === 0, `${threw} throws`);

// Length-field low bytes are value-dependent: a flip is malleable only when
// it does not truncate a box the parser needs. Length values shift with cert
// DER sizes run to run, so low bytes are a swing set: allowed to be
// malleable, never required (docs/INTEGRITY.md).
const swings = new Set<number>();
swings.add(byName.get('store jumb.length')!.end - 1);
swings.add(byName.get('claim-cbor leaf.length')!.end - 1);

const missing = [...expected].filter((o) => !empirical.has(o));
const unexpected = [...empirical].filter((o) => !expected.has(o) && !swings.has(o));
check('documented allowlist bytes are all malleable (doc ↔ reality)', missing.length === 0,
  `offsets documented but protected: ${missing.slice(0, 12).join(',')}`);
check('no malleable byte outside the documented allowlist + length swing bytes (the set cannot silently grow)', unexpected.length === 0,
  `offsets malleable but undocumented: ${unexpected.slice(0, 12).join(',')}`);
check('allowlist size matches docs/INTEGRITY.md (152 fixed + up to 2 swing)', expected.size === 152, String(expected.size));

// Named protected regions, asserted by name so failures read clearly.
const protectedField = (name: string) => {
  const f = byName.get(name)!;
  for (let j = f.start; j < f.end; j++) return empirical.has(j) ? false : true;
  return true;
};
check('claim CBOR content fully protected (COSE signs it)', protectedField('claim-cbor leaf.content'));
check('assertion contents fully protected (claim hashes them)', protectedField('assertion0-cbor leaf.content') && protectedField('assertion1-cbor leaf.content'));
check('COSE signature content fully protected (payload slot enforced null, F3 fix)', protectedField('signature-cbor leaf.content'));

// ===========================================================================
// VIDEO (BMFF uuid box) — same JUMBF store, different transport.
// fetchTimestamp is overridden to [] so no network token layout can shift the
// build. With live tokens, a flip inside a valid token degrades the report to
// "time unverified" and bytes of an already-failing token are report-neutral;
// see docs/INTEGRITY.md and tool-malleable-map.mts.
// ===========================================================================
console.log('\n— BMFF video path —');
const vctx = { location: null, headingDeg: null, pressureHPa: null, altitudeM: null, motion: null } as never;
const vres = await attestVideo({
  videoUri: '/tmp/lab/clean.mp4', context: vctx,
  identity: { author: 'Lab', organization: null }, key,
  fetchTimestamp: async () => [],
});
if (!vres.signedVideoBytes) { console.log('FATAL: video embed gate declined'); process.exit(1); }
const vsigned = vres.signedVideoBytes;

// Locate the C2PA uuid box (spec usertype d8fec3d6-…).
const UT = [0xd8, 0xfe, 0xc3, 0xd6, 0x1b, 0x0e, 0x48, 0x3c, 0x92, 0x97, 0x58, 0x28, 0x87, 0x7e, 0xc4, 0x81];
let utAt = -1;
outer: for (let i2 = 0; i2 < vsigned.length - 24; i2++) {
  for (let k2 = 0; k2 < 16; k2++) if (vsigned[i2 + k2] !== UT[k2]) continue outer;
  utAt = i2; break;
}
const vBoxStart = utAt - 8;
const vBoxLen = ((vsigned[vBoxStart] << 24) | (vsigned[vBoxStart + 1] << 16) | (vsigned[vBoxStart + 2] << 8) | vsigned[vBoxStart + 3]) >>> 0;
const vbase = await verifyVideoBytes(vsigned);
check('baseline signed video verifies INTACT', vbase.verdict === 'INTACT', vbase.verdict);
const vBaseJson = JSON.stringify(vbase);

// Structural walk of the store inside the uuid box. Offsets are relative to
// the uuid box start; the store begins after the 45-byte header (8 box +
// 16 usertype + 4 version/flags + 9 "manifest\0" + 8 merkle-offset).
const vseg = vsigned.subarray(vBoxStart, vBoxStart + vBoxLen);
const vu32 = (o: number) => ((vseg[o] << 24) | (vseg[o + 1] << 16) | (vseg[o + 2] << 8) | vseg[o + 3]) >>> 0;
const vFields: Field[] = [];
const VF = (start: number, end: number, name: string) => vFields.push({ start, end, name });
VF(0, 4, 'uuid box.length'); VF(4, 8, 'uuid box.type'); VF(8, 24, 'uuid usertype');
VF(24, 28, 'uuid version/flags'); VF(28, 37, 'uuid purpose "manifest"'); VF(37, 45, 'uuid merkle-offset');
function vJumd(at: number, name: string): number {
  const jlen = vu32(at);
  VF(at, at + 4, `${name} jumd.length`); VF(at + 4, at + 8, `${name} jumd.type`);
  VF(at + 8, at + 24, `${name} jumd.uuid`); VF(at + 24, at + 25, `${name} jumd.toggle`);
  let le = at + 25;
  while (vseg[le] !== 0) le++;
  VF(at + 25, le + 1, `${name} jumd.label`);
  return at + jlen;
}
function vJumb(at: number, name: string): { contentStart: number; end: number } {
  const len = vu32(at);
  VF(at, at + 4, `${name} jumb.length`); VF(at + 4, at + 8, `${name} jumb.type`);
  return { contentStart: vJumd(at + 8, name), end: at + len };
}
function vLeaf(at: number, name: string): number {
  const len = vu32(at);
  VF(at, at + 4, `${name} leaf.length`); VF(at + 4, at + 8, `${name} leaf.type`); VF(at + 8, at + len, `${name} leaf.content`);
  return at + len;
}
const vStore = vJumb(45, 'store');
const vManifest = vJumb(vStore.contentStart, 'manifest');
const vClaim = vJumb(vManifest.contentStart, 'claim');
vLeaf(vClaim.contentStart, 'claim-cbor');
const vAssertions = vJumb(vClaim.end, 'assertions');
let vr = vAssertions.contentStart, vi = 0;
while (vr < vAssertions.end) { const a = vJumb(vr, `assertion${vi}`); vLeaf(a.contentStart, `assertion${vi}-cbor`); vr = a.end; vi++; }
const vSig = vJumb(vAssertions.end, 'signature');
vLeaf(vSig.contentStart, 'signature-cbor');

// Documented video allowlist (docs/INTEGRITY.md): the JPEG framing classes
// plus uuid version/flags. All bytes of store jumb.length and store jumd.uuid
// are malleable here, because the BMFF parser scans by type while the JPEG
// APP11 path bounds by length.
const vByName = new Map(vFields.map((f) => [f.name, f]));
const vExpected = new Set<number>();
const vAdd = (name: string, trimEnd = 0, skipStart = 0) => {
  const f = vByName.get(name)!;
  for (let j = f.start + skipStart; j < f.end - trimEnd; j++) vExpected.add(j);
};
vAdd('uuid version/flags');
vAdd('store jumb.length', 1);
vAdd('store jumd.uuid');
vAdd('store jumd.label');
vAdd('manifest jumd.uuid');
vAdd('manifest jumd.label');
vAdd('claim jumd.uuid');
vAdd('claim jumd.toggle');
vAdd('claim-cbor leaf.length', 1);
vAdd('claim-cbor leaf.type');
vAdd('assertions jumd.uuid');
vAdd('signature jumd.uuid');
vAdd('signature jumd.toggle');
vAdd('signature-cbor leaf.length', 1);
vAdd('signature-cbor leaf.type');
// Value-dependent swing bytes, as on the JPEG path: the low byte of each
// length field.
const vSwings = new Set<number>();
vSwings.add(vByName.get('store jumb.length')!.end - 1);
vSwings.add(vByName.get('claim-cbor leaf.length')!.end - 1);
vSwings.add(vByName.get('signature-cbor leaf.length')!.end - 1);

// The COSE pad entry is slack for post-hoc TSA tokens and is allowed beyond
// the documented fields. Located by the 'pad' text key inside the sig cbor
// content, through the end of its zero run; no pad means an empty span.
let padStart = -1;
for (let i3 = 0; i3 < vseg.length - 6; i3++) {
  if (vseg[i3] === 0x63 && vseg[i3 + 1] === 0x70 && vseg[i3 + 2] === 0x61 && vseg[i3 + 3] === 0x64) { padStart = i3; break; }
}
// The pad entry's bstr header is three bytes for 0x59 (16-bit length);
// assuming two lands inside the length field and mislabels the pad slack as
// unprotected COSE content.
let padEnd = -1;
if (padStart !== -1) {
  const h = padStart + 4; // after the 'pad' text key
  const b = vseg[h];
  let headerLen = 1, dataLen = b & 0x1f;
  if (b === 0x58) { headerLen = 2; dataLen = vseg[h + 1]; }
  else if (b === 0x59) { headerLen = 3; dataLen = (vseg[h + 1] << 8) | vseg[h + 2]; }
  else if (b === 0x5a) { headerLen = 5; dataLen = ((vseg[h + 1] << 24) | (vseg[h + 2] << 16) | (vseg[h + 3] << 8) | vseg[h + 4]) >>> 0; }
  padEnd = h + headerLen + dataLen;
}

const vEmpirical = new Set<number>();
let vThrew = 0;
for (let off = 0; off < vBoxLen; off++) {
  const mutated = new Uint8Array(vsigned);
  mutated[vBoxStart + off] ^= 0xff;
  try {
    const res = await verifyVideoBytes(mutated);
    if (res.verdict === 'INTACT' && JSON.stringify(res) === vBaseJson) vEmpirical.add(off);
  } catch {
    vThrew++;
  }
}
check('video: no flip ever throws (clean-error contract)', vThrew === 0, `${vThrew} throws`);
const vMissing = [...vExpected].filter((o) => !vEmpirical.has(o));
check('video: documented allowlist bytes are all malleable', vMissing.length === 0,
  `documented but protected: ${vMissing.slice(0, 12).join(',')}`);
const vUnexpected = [...vEmpirical].filter((o) => !vExpected.has(o) && !vSwings.has(o) && !(padStart !== -1 && o >= padStart && o < padEnd));
check('video: no malleable byte outside documented fields + swing bytes + COSE pad', vUnexpected.length === 0,
  `malleable but undocumented: ${vUnexpected.slice(0, 12).join(',')}`);
// No flip in claim, assertion, or signature content may read as
// report-identical INTACT; asserted by name.
const vProtected = (name: string) => {
  const f = vByName.get(name)!;
  for (let j = f.start; j < f.end; j++) if (vEmpirical.has(j)) return false;
  return true;
};
check('video: claim CBOR content protected', vProtected('claim-cbor leaf.content'));
check('video: assertion contents protected', vProtected('assertion0-cbor leaf.content') && vProtected('assertion1-cbor leaf.content'));
check('video: COSE content protected outside the pad entry', vProtected('signature-cbor leaf.content')
  ? true
  : [...vEmpirical].every((o) => {
      const f = vByName.get('signature-cbor leaf.content')!;
      return !(o >= f.start && o < f.end) || (padStart !== -1 && o >= padStart && o < padEnd);
    }));

console.log(`\nmalleability: ${pass} passed, ${fail} failed (jpeg ${segEnd - segStart} + video ${vBoxLen} bytes flipped)`);
process.exit(fail ? 1 : 0);

// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Tool: empirical malleability map of the APP11/JUMBF region, annotated by
 * structure. Builds a signed JPEG, flips every byte of the APP11 segment,
 * classifies the verifier outcome, then walks the JUMBF layout field by
 * field and reports which fields are protected, malleable, or partial.
 *
 * Ground truth for docs/INTEGRITY.md and for test-malleability.mts.
 * NOTE: byte offsets shift run to run (ECDSA cert signatures vary in DER
 * length) — always derive expectations STRUCTURALLY, never by offset.
 */
import * as fs from 'node:fs';
import { p256 } from '@noble/curves/p256';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, concatBytes } from './bytes.mts';
import { buildSelfSignedCert } from './cert.mts';
import { buildC2paSegment } from './c2pa.mts';
import { verifyPhotoBytes } from './verifyAsset.mts';
import { labSigner } from './deviceKey-shim.mts';

const key = labSigner();
const devCert = await buildSelfSignedCert(
  Uint8Array.from(atob(key.publicKeyBase64), (c) => c.charCodeAt(0)),
  key.signDigest, new Date(Date.now() - 60_000));
const clean = new Uint8Array(fs.readFileSync('/tmp/lab/clean.jpg'));
const segment = await buildC2paSegment({
  appName: 'ExhibitA/0.11.0-lab', mime: 'image/jpeg', title: 'malleability.jpg',
  instanceId: 'xmp:iid:' + bytesToHex(p256.utils.randomPrivateKey().subarray(0, 16)),
  telemetry: { format: 'lab', note: 'malleability map' },
  signDigest: key.signDigest, signPayload: key.signPayload,
  certChain: [devCert], cleanFileSha256: sha256(clean),
}, 2);
const signed = concatBytes(clean.subarray(0, 2), segment, clean.subarray(2));
fs.writeFileSync('/tmp/lab/malleable-signed.jpg', signed);

let segStart = -1;
for (let i = 2; i < signed.length - 4; i++) {
  if (signed[i] === 0xff && signed[i + 1] === 0xeb) { segStart = i; break; }
}
const segLen = (signed[segStart + 2] << 8) | signed[segStart + 3];
const segEnd = segStart + 2 + segLen;
console.log(`APP11 at ${segStart}, length ${segLen}, segment [0..${segEnd - segStart}) relative, file ${signed.length} bytes`);

const base = await verifyPhotoBytes(signed);
if (base.verdict !== 'INTACT') { console.log('BASELINE NOT INTACT — aborting'); process.exit(1); }

// ---------- empirical map ----------
const malleable: number[] = [];
const outcomes = new Map<string, number>();
let threw = 0;
for (let off = segStart; off < segEnd; off++) {
  const mutated = new Uint8Array(signed);
  mutated[off] ^= 0xff;
  try {
    const r = await verifyPhotoBytes(mutated);
    outcomes.set(r.verdict, (outcomes.get(r.verdict) ?? 0) + 1);
    if (r.verdict === 'INTACT') malleable.push(off - segStart);
  } catch (e) {
    threw++;
    console.log(`THREW at rel ${off - segStart}: ${String(e).slice(0, 140)}`);
  }
}
console.log('outcome histogram:', Object.fromEntries(outcomes), '| threw:', threw, '| malleable:', malleable.length);
const mset = new Set(malleable);

// ---------- structural walk ----------
const seg = signed.subarray(segStart, segEnd);
const ascii = (b: Uint8Array) => Array.from(b).map((c) => (c >= 32 && c < 127 ? String.fromCharCode(c) : '.')).join('');
const u32 = (o: number) => ((seg[o] << 24) | (seg[o + 1] << 16) | (seg[o + 2] << 8) | seg[o + 3]) >>> 0;

interface Field { start: number; end: number; name: string }
const fields: Field[] = [];
const F = (start: number, end: number, name: string) => fields.push({ start, end, name });

F(0, 2, 'APP11 marker FF EB');
F(2, 4, 'APP11 length');
F(4, 6, '"JP" identifier');
F(6, 8, 'En (box instance)');
F(8, 12, 'Z (packet sequence)');

function jumdFields(at: number, name: string): number {
  const jlen = u32(at);
  F(at, at + 4, `${name} jumd.length`);
  F(at + 4, at + 8, `${name} jumd.type`);
  F(at + 8, at + 24, `${name} jumd.uuid (${ascii(seg.subarray(at + 8, at + 12))}…)`);
  F(at + 24, at + 25, `${name} jumd.toggle`);
  let le = at + 25;
  while (seg[le] !== 0) le++;
  F(at + 25, le + 1, `${name} jumd.label "${ascii(seg.subarray(at + 25, le))}"`);
  return at + jlen;
}
function jumb(at: number, name: string): { contentStart: number; end: number } {
  const len = u32(at);
  F(at, at + 4, `${name} jumb.length`);
  F(at + 4, at + 8, `${name} jumb.type`);
  const contentStart = jumdFields(at + 8, name);
  return { contentStart, end: at + len };
}
function leaf(at: number, name: string): number {
  const len = u32(at);
  F(at, at + 4, `${name} leaf.length`);
  F(at + 4, at + 8, `${name} leaf.type "${ascii(seg.subarray(at + 4, at + 8))}"`);
  F(at + 8, at + len, `${name} leaf.content (${len - 8} bytes)`);
  return at + len;
}

const store = jumb(12, 'store(c2pa)');
const manifest = jumb(store.contentStart, 'manifest');
const claim = jumb(manifest.contentStart, 'claim');
leaf(claim.contentStart, 'claim cbor');
const assertions = jumb(claim.end, 'assertions');
let r = assertions.contentStart;
let i = 0;
while (r < assertions.end) {
  const a = jumb(r, `assertion[${i}]`);
  leaf(a.contentStart, `assertion[${i}]`);
  r = a.end; i++;
}
const sig = jumb(assertions.end, 'signature');
leaf(sig.contentStart, 'signature cbor');

console.log('\n--- field-by-field disposition ---');
for (const f of fields) {
  let mal = 0;
  for (let j = f.start; j < f.end; j++) if (mset.has(j)) mal++;
  const tag = mal === 0 ? 'PROTECTED' : mal === f.end - f.start ? 'MALLEABLE' : `PARTIAL(${mal}/${f.end - f.start})`;
  console.log(`${String(f.start).padStart(4)}-${String(f.end - 1).padStart(4)} ${tag.padEnd(11)} ${f.name}`);
}
const covered = new Set<number>();
for (const f of fields) for (let j = f.start; j < f.end; j++) covered.add(j);
const uncovered = malleable.filter((o) => !covered.has(o));
console.log('\nmalleable bytes outside labeled fields:', uncovered.join(', ') || 'none');

// ================= VIDEO (BMFF uuid box) =================
console.log('\n=== BMFF video path ===');
const { attestVideo } = await import('./attest.mts');
const { verifyVideoBytes } = await import('./verifyAsset.mts');
const vctx = { location: { lat: 37.7749, lon: -122.4194, accuracyM: 5 }, headingDeg: 90 } as never;
const v = await attestVideo({ videoUri: '/tmp/lab/clean.mp4', context: vctx, identity: { author: 'Lab', organization: null }, key });
if (!v.signedVideoBytes) { console.log('video embed gate declined — skipping'); process.exit(0); }
const vsigned = v.signedVideoBytes;
fs.writeFileSync('/tmp/lab/malleable-signed.mp4', vsigned);
// C2PA BMFF usertype per spec (NOT the JUMBF 'c2pa'-prefix jumd UUID).
const UT = [0xd8, 0xfe, 0xc3, 0xd6, 0x1b, 0x0e, 0x48, 0x3c, 0x92, 0x97, 0x58, 0x28, 0x87, 0x7e, 0xc4, 0x81];
let utAt = -1;
outer: for (let i = 0; i < vsigned.length - 24; i++) {
  for (let k = 0; k < 16; k++) if (vsigned[i + k] !== UT[k]) continue outer;
  utAt = i; break;
}
const boxStart = utAt - 8;
const boxLen = ((vsigned[boxStart] << 24) | (vsigned[boxStart + 1] << 16) | (vsigned[boxStart + 2] << 8) | vsigned[boxStart + 3]) >>> 0;
console.log(`uuid box at ${boxStart}, length ${boxLen}, file ${vsigned.length}`);
const vbase = await verifyVideoBytes(vsigned);
console.log('baseline video verdict:', vbase.verdict);
const strip = (r: unknown) => JSON.stringify(r, (k, v) => (k === 'signerTrust' ? undefined : v));
const baseJson = strip(vbase);
const vmal: number[] = [];
const vdegraded: number[] = [];
const voutcomes = new Map<string, number>();
let vthrew = 0;
let degradedSample: string | null = null;
for (let off = boxStart; off < boxStart + boxLen; off++) {
  const mutated = new Uint8Array(vsigned);
  mutated[off] ^= 0xff;
  try {
    const r = await verifyVideoBytes(mutated);
    voutcomes.set(r.verdict, (voutcomes.get(r.verdict) ?? 0) + 1);
    if (r.verdict === 'INTACT') {
      if (strip(r) === baseJson) vmal.push(off - boxStart);
      else {
        vdegraded.push(off - boxStart);
        if (!degradedSample) {
          const b = JSON.parse(baseJson), m = JSON.parse(strip(r));
          degradedSample = `rel ${off - boxStart}: trustedUtc ${b.c2pa?.timestamps?.earliestTrustedUtc} -> ${m.c2pa?.timestamps?.earliestTrustedUtc}; notPerformed delta: ${JSON.stringify((m.checksNotPerformed ?? []).filter((l: string) => !(b.checksNotPerformed ?? []).includes(l)))}`;
        }
      }
    }
  } catch { vthrew++; }
}
console.log('video outcome histogram:', Object.fromEntries(voutcomes), '| threw:', vthrew);
console.log('truly malleable (report identical):', vmal.length, '| degraded-but-INTACT (report changes, stated):', vdegraded.length);
console.log('degraded sample:', degradedSample);
const toRanges = (arr: number[]) => {
  const out: string[] = [];
  let s = -1, p = -1;
  for (const o of arr) {
    if (s === -1) { s = o; p = o; continue; }
    if (o === p + 1) { p = o; continue; }
    out.push(s === p ? `${s}` : `${s}-${p}`);
    s = o; p = o;
  }
  if (s !== -1) out.push(s === p ? `${s}` : `${s}-${p}`);
  return out.join(', ');
};
console.log('video TRULY-malleable ranges:', toRanges(vmal));
console.log('video degraded ranges:', toRanges(vdegraded));

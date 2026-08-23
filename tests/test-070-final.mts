// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * End-to-end validation for every format: sign → verify → tamper-reject →
 * c2patool, plus spot checks for manifest transplant, truncation, and
 * unsigned files.
 */
import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { attestPhoto, attestPng, attestVideo, attestAudio } from './attest.mts';
import { verifyPhotoBytes, verifyVideoBytes } from './verifyAsset.mts';
const verifyPhoto = (path: string) => verifyPhotoBytes(new Uint8Array(fs.readFileSync(path)));
const verifyVideo = (path: string) => verifyVideoBytes(new Uint8Array(fs.readFileSync(path)));
import { labSigner } from './deviceKey-shim.mts';

const key = labSigner();
const ctx = {
  location: { lat: 37.7749, lon: -122.4194, accuracyM: 5 },
  headingDeg: 90, pressureHPa: 1013, altitudeM: 15,
  motion: { verdict: 'handheld', peakHz: 3.2 },
} as any;
const identity = { author: 'Final Check', organization: null };
const transcript = { text: 'final validation transcript', locale: 'en-US', onDevice: true,
  startedAt: new Date().toISOString(), endedAt: new Date().toISOString() } as any;

let pass = 0, fail = 0, skipped = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name} :: ${detail}`); }
};
const skip = (name: string, why: string) => { skipped++; console.log(`  SKIP ${name} :: ${why}`); };
// c2patool is optional; when absent its checks SKIP and are excluded from the
// pass/fail tally. See README ▸ Requirements.
const c2patoolBin = process.env.C2PATOOL ?? '/tmp/bin/c2patool';
let c2patoolAvailable = false;
try { execFileSync(c2patoolBin, ['--version'], { stdio: 'pipe' }); c2patoolAvailable = true; } catch { /* not installed */ }
if (!c2patoolAvailable) console.log('  NOTE: c2patool not found — gold-standard checks below will SKIP, not fail');
const c2patool = (f: string): { ok: boolean; why: string } => {
  try {
    const out = execFileSync(c2patoolBin, [f], { encoding: 'utf8', stdio: ['pipe','pipe','pipe'] });
    const vs = JSON.parse(out).validation_status ?? [];
    return vs.length === 0 ? { ok: true, why: '' } : { ok: false, why: JSON.stringify(vs).slice(0, 160) };
  } catch (e: any) {
    // c2patool exits non-zero with validation errors printed to stderr
    const msg = String(e.stderr ?? e.message ?? e).slice(0, 160);
    return { ok: false, why: msg };
  }
};
const c2patoolRejects = (f: string): boolean => !c2patool(f).ok;

// ---------- JPEG ----------
console.log('— JPEG —');
const j = await attestPhoto({ photoUri: '/tmp/lab/clean.jpg', context: ctx, identity, key });
fs.writeFileSync('/tmp/lab/s070.jpg', j.signedPhotoBytes!);
check('jpeg verifies INTACT', (await verifyPhoto('/tmp/lab/s070.jpg')).verdict === 'INTACT');
if (c2patoolAvailable) { const cj = c2patool('/tmp/lab/s070.jpg'); check('c2patool validates jpeg', cj.ok, cj.why); }
else skip('c2patool validates jpeg', 'c2patool not installed');
const tj = new Uint8Array(j.signedPhotoBytes!); tj[tj.length - 100] ^= 0xff;
fs.writeFileSync('/tmp/lab/s070-tampered.jpg', tj);
check('tampered jpeg rejected (app)', (await verifyPhoto('/tmp/lab/s070-tampered.jpg')).verdict !== 'INTACT');
if (c2patoolAvailable) check('tampered jpeg rejected (c2patool)', c2patoolRejects('/tmp/lab/s070-tampered.jpg'));
else skip('tampered jpeg rejected (c2patool)', 'c2patool not installed');

// ---------- PNG ----------
console.log('— PNG —');
const p = await attestPng({ pngBytes: fs.readFileSync('/tmp/lab/clean.png'), context: ctx, identity, key });
fs.writeFileSync('/tmp/lab/s070.png', p.signedPngBytes!);
check('png verifies INTACT', (await verifyPhoto('/tmp/lab/s070.png')).verdict === 'INTACT');
if (c2patoolAvailable) { const cp = c2patool('/tmp/lab/s070.png'); check('c2patool validates png', cp.ok, cp.why); }
else skip('c2patool validates png', 'c2patool not installed');
const tp = new Uint8Array(p.signedPngBytes!); tp[390] ^= 0xff; // pixel region — caBX starts at 769
fs.writeFileSync('/tmp/lab/s070-tampered.png', tp);
check('tampered png rejected (app)', (await verifyPhoto('/tmp/lab/s070-tampered.png')).verdict !== 'INTACT');
if (c2patoolAvailable) check('tampered png rejected (c2patool)', c2patoolRejects('/tmp/lab/s070-tampered.png'));
else skip('tampered png rejected (c2patool)', 'c2patool not installed');

// ---------- MP4 ----------
console.log('— MP4 —');
const v = await attestVideo({ videoUri: '/tmp/lab/clean.mp4', context: ctx, identity, key });
fs.writeFileSync('/tmp/lab/s070.mp4', v.signedVideoBytes!);
check('mp4 verifies INTACT', (await verifyVideo('/tmp/lab/s070.mp4')).verdict === 'INTACT');
if (c2patoolAvailable) { const cv = c2patool('/tmp/lab/s070.mp4'); check('c2patool validates mp4', cv.ok, cv.why); }
else skip('c2patool validates mp4', 'c2patool not installed');

// ---------- MOV (quicktime mime path) ----------
console.log('— MOV —');
const m = await attestVideo({ videoUri: '/tmp/lab/clean.mov', context: ctx, identity, key });
if (m.signedVideoBytes) {
  fs.writeFileSync('/tmp/lab/s070.mov', m.signedVideoBytes);
  check('mov verifies INTACT', (await verifyVideo('/tmp/lab/s070.mov')).verdict === 'INTACT');
  if (c2patoolAvailable) { const cm = c2patool('/tmp/lab/s070.mov'); check('c2patool validates mov', cm.ok, cm.why); }
  else skip('c2patool validates mov', 'c2patool not installed');
  check('mov record mime is quicktime', m.record.asset.mime === 'video/quicktime', m.record.asset.mime);
} else { check('mov embed (in scope)', false, 'embed gate declined for mov'); }

// ---------- M4A (with transcript) ----------
console.log('— M4A —');
const a = await attestAudio({ audioUri: '/tmp/lab/clean.m4a', context: ctx, identity, key, transcript });
fs.writeFileSync('/tmp/lab/s070.m4a', a.signedAudioBytes!);
check('m4a verifies INTACT', (await verifyVideo('/tmp/lab/s070.m4a')).verdict === 'INTACT');
if (c2patoolAvailable) { const ca = c2patool('/tmp/lab/s070.m4a'); check('c2patool validates m4a', ca.ok, ca.why); }
else skip('c2patool validates m4a', 'c2patool not installed');

// ---------- red-team spot checks ----------
console.log('— red team —');
// transplant: jpeg manifest bytes spliced onto the png (different asset) must not verify
const signedJ = fs.readFileSync('/tmp/lab/s070.jpg');
fs.writeFileSync('/tmp/lab/rt-transplant.jpg', Buffer.concat([signedJ.subarray(0, 2000), Buffer.from(cleanPngHack())]));
function cleanPngHack() { return fs.readFileSync('/tmp/lab/clean.png'); }
const rt = await verifyPhoto('/tmp/lab/rt-transplant.jpg');
check('transplanted manifest rejected', rt.verdict !== 'INTACT', rt.verdict);
// truncation
fs.writeFileSync('/tmp/lab/rt-trunc.png', p.signedPngBytes!.subarray(0, 400));
const tr = await verifyPhoto('/tmp/lab/rt-trunc.png');
check('truncated png rejected', tr.verdict !== 'INTACT', tr.verdict);
// unsigned
check('unsigned jpeg → NO_ATTESTATION', (await verifyPhoto('/tmp/lab/clean.jpg')).verdict === 'NO_ATTESTATION');
check('unsigned mp4 → NO_ATTESTATION', (await verifyVideo('/tmp/lab/clean.mp4')).verdict === 'NO_ATTESTATION');

console.log(`\n=== ${pass} passed, ${fail} failed, ${skipped} skipped ===`);
process.exit(fail ? 1 : 0);

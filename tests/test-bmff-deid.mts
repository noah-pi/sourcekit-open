// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Validates deidentifyBmff (BMFF de-identification).
 *  1. Sign an MP4 video and an M4A (with transcript) via the real attest paths.
 *  2. De-identify both via deidentifyBmff.
 *  3. App-verify the copies: signature and asset hash hold, identity/location
 *     read 'redacted', transcript is gone.
 *  4. c2patool validates the de-identified files.
 *  5. Tampering with a de-identified copy fails verification.
 */
import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { attestVideo, attestAudio, deidentifyBmff } from './attest.mts';
import { verifyVideoBytes } from './verifyAsset.mts';
const verifyVideo = (path: string) => verifyVideoBytes(new Uint8Array(fs.readFileSync(path)));
import { labSigner } from './deviceKey-shim.mts';

const key = labSigner();
const ctx = {
  location: { lat: 37.7749, lon: -122.4194, accuracyM: 5 },
  headingDeg: 90, pressureHPa: 1013, altitudeM: 15,
  motion: { verdict: 'handheld', peakHz: 3.2 },
} as any;
const identity = { author: 'Lab Test', organization: null };

let pass = 0, fail = 0, skipped = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${detail}`); }
};
const skip = (name: string, why: string) => { skipped++; console.log(`  SKIP ${name} :: ${why}`); };
// c2patool is optional: when absent its checks skip loudly and are excluded
// from the pass/fail tally. See README ▸ Requirements.
const c2patoolBin = process.env.C2PATOOL ?? '/tmp/bin/c2patool';
let c2patoolAvailable = false;
try { execFileSync(c2patoolBin, ['--version'], { stdio: 'pipe' }); c2patoolAvailable = true; } catch { /* not installed */ }
if (!c2patoolAvailable) console.log('  NOTE: c2patool not found — gold-standard checks below will SKIP, not fail');

// ---------- 1. sign a video ----------
const v = await attestVideo({ videoUri: '/tmp/lab/clean.mp4', context: ctx, identity, key });
if (!v.signedVideoBytes) { console.log('FATAL: video embed gate declined'); process.exit(1); }
fs.writeFileSync('/tmp/lab/signed.mp4', v.signedVideoBytes);
console.log('signed mp4:', v.signedVideoBytes.length, 'bytes');

// ---------- 2. sign audio WITH a transcript ----------
const transcript = {
  text: 'my secret plan to meet at the docks at midnight',
  locale: 'en-US', onDevice: true,
  startedAt: new Date().toISOString(), endedAt: new Date().toISOString(),
} as any;
const a = await attestAudio({ audioUri: '/tmp/lab/clean.m4a', context: ctx, identity, key, transcript });
if (!a.signedAudioBytes) { console.log('FATAL: audio embed gate declined'); process.exit(1); }
fs.writeFileSync('/tmp/lab/signed.m4a', a.signedAudioBytes);
console.log('signed m4a:', a.signedAudioBytes.length, 'bytes');

// ---------- 3. de-identify both ----------
const ORIGINAL_TS = '2026-07-01T10:00:00.000Z';
const dv = await deidentifyBmff({ bytes: v.signedVideoBytes, mime: 'video/mp4', kind: 'video', key, capturedAt: ORIGINAL_TS });
fs.writeFileSync('/tmp/lab/deid.mp4', dv.signedBytes);
const da = await deidentifyBmff({ bytes: a.signedAudioBytes, mime: 'audio/mp4', kind: 'audio', key });
fs.writeFileSync('/tmp/lab/deid.m4a', da.signedBytes);
console.log('de-identified mp4:', dv.signedBytes.length, '| m4a:', da.signedBytes.length);

// ---------- 4. app-side verification of de-identified copies ----------
fs.writeFileSync('/tmp/lab/deid-v.mp4', dv.signedBytes);
fs.writeFileSync('/tmp/lab/deid-a.m4a', da.signedBytes);
const vv = await verifyVideo('/tmp/lab/deid-v.mp4');
const va = await verifyVideo('/tmp/lab/deid-a.m4a'); // audio verifies through the BMFF path
console.log('video verdict:', vv.verdict, '| audio verdict:', va.verdict);
check('de-id video verifies valid', vv.verdict === 'INTACT', vv.verdict);
check('de-id audio verifies valid', va.verdict === 'INTACT', va.verdict);

const rv = vv.record, ra = va.record;
check('video identity redacted', rv?.identity === 'redacted');
check('audio identity redacted', ra?.identity === 'redacted');
check('video location redacted', (rv?.context.location as any) === 'redacted');
check('audio location redacted', (ra?.context.location as any) === 'redacted');
check('video device model dropped', rv?.device.model == null, String(rv?.device.model));
check('audio device model dropped', ra?.device.model == null, String(ra?.device.model));
check('video deidentified marker lists fields', !!rv?.deidentified && rv.deidentified.fields.includes('identity'));
check('audio deidentified marker includes transcript', !!ra?.deidentified && ra.deidentified.fields.includes('transcript'));
check('no transcript in de-id audio record', (ra as any)?.transcript == null);
check('original capturedAt carried into de-id copy', rv?.capturedAt === ORIGINAL_TS, String(rv?.capturedAt));

// The spoken words must not survive anywhere in the de-identified bytes.
const haystack = Buffer.from(da.signedBytes).toString('latin1');
check('transcript text absent from de-id m4a bytes',
  !haystack.includes('secret plan') && !haystack.includes('docks'));
const haySigned = Buffer.from(a.signedAudioBytes).toString('latin1');
check('transcript text present in ORIGINAL signed m4a (sanity)', haySigned.includes('secret plan'));

// ---------- 5. c2patool gold standard on de-identified files ----------
for (const f of ['deid.mp4', 'deid.m4a']) {
  if (!c2patoolAvailable) { skip(`c2patool validates ${f}`, 'c2patool not installed'); continue; }
  try {
    const out = execFileSync(c2patoolBin, [`/tmp/lab/${f}`], { encoding: 'utf8' });
    const j = JSON.parse(out);
    const vs = j.validation_status ?? [];
    check(`c2patool validates ${f}`, vs.length === 0, JSON.stringify(vs).slice(0, 200));
  } catch (e: any) {
    check(`c2patool validates ${f}`, false, String(e).slice(0, 200));
  }
}

// ---------- 6. tamper the de-identified copy → must fail ----------
const tampered = new Uint8Array(dv.signedBytes);
tampered[tampered.length - 8] ^= 0xff; // flip a byte in mdat (payload)
fs.writeFileSync('/tmp/lab/deid-tampered.mp4', tampered);
const vt = await verifyVideo('/tmp/lab/deid-tampered.mp4');
check('tampered de-id video rejected', vt.verdict !== 'INTACT', vt.verdict);

// ---------- 7. de-identify a clean, never-signed file ----------
const dl = await deidentifyBmff({ bytes: fs.readFileSync('/tmp/lab/clean.mp4'), mime: 'video/mp4', kind: 'video', key });
fs.writeFileSync('/tmp/lab/deid-legacy.mp4', dl.signedBytes);
const vl = await verifyVideo('/tmp/lab/deid-legacy.mp4');
check('clean-input de-id verifies valid', vl.verdict === 'INTACT', vl.verdict);

console.log(`\n${pass} passed, ${fail} failed, ${skipped} skipped`);
process.exit(fail ? 1 : 0);

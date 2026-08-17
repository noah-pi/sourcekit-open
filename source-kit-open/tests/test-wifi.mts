// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Wi-Fi SSID/BSSID opt-in capture.
 *
 * The native module can't run in the lab (iOS-only, entitlement-gated), so
 * this suite pins everything the lab CAN prove — the signed-format contract:
 *
 *  1. A wifi claim rides INSIDE the signed payload: it round-trips intact
 *     and any tamper with ssid/bssid breaks the record signature.
 *  2. Tri-state honesty: 'redacted' (opt-in off — the default) and
 *     'unavailable' (iOS returned nothing) both sign and verify; a legacy
 *     record with no wifi key at all verifies neutral.
 *  3. The real photo path: attestPhoto carries the claim into the signed
 *     JPEG, verifyPhotoBytes reads INTACT, and c2patool (gold standard)
 *     validates the file.
 *  4. deID always strips it: deidentifyPhoto, deidentifyPhotoToPng and
 *     deidentifyBmff all emit wifi:'redacted' + list 'wifi' in the stripped
 *     fields, the copies still verify, and the original is untouched.
 */
import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { sha256 } from '@noble/hashes/sha256';
import { asciiToBytes, base64ToBytes, bytesToHex, concatBytes, utf8ToBytes } from './bytes.mts';
import { buildRecord } from './manifest.mts';
import { signRecord, verifyRecordSignature } from './sign.mts';
import { attestPhoto, deidentifyPhoto, deidentifyPhotoToPng, deidentifyBmff, attestVideo } from './attest.mts';
import { verifyPhotoBytes } from './verifyAsset.mts';
import { labSigner } from './deviceKey-shim.mts';

const key = labSigner();
const WIFI = { ssid: 'Newsroom-5G', bssid: 'a4:5e:60:12:34:56' };
const ctxWith = {
  location: { lat: 37.7749, lon: -122.4194, accuracyM: 5 },
  headingDeg: 90, pressureHPa: 1013, altitudeM: 15,
  motion: { verdict: 'handheld', peakHz: 3.2 },
  wifi: { ...WIFI },
} as any;
const identity = { author: 'Wifi Test', organization: null };

let pass = 0, fail = 0, skipped = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${detail}`); }
};
const skip = (name: string, why: string) => { skipped++; console.log(`  SKIP ${name} :: ${why}`); };
// c2patool is the optional gold standard: when absent, its checks SKIP loudly
// (excluded from the pass/fail tally) instead of failing. See README ▸ Requirements.
const c2patoolBin = process.env.C2PATOOL ?? 'c2patool';
let c2patoolAvailable = false;
try { execFileSync(c2patoolBin, ['--version'], { stdio: 'pipe' }); c2patoolAvailable = true; } catch { /* not installed */ }
if (!c2patoolAvailable) console.log('  NOTE: c2patool not found — gold-standard checks below will SKIP, not fail');

const mkRecord = (ctx: any) => buildRecord({
  assetSha256: bytesToHex(sha256(utf8ToBytes('wifi-media-bytes'))),
  assetBytes: 16,
  mime: 'image/jpeg',
  kind: 'photo',
  capturedAt: new Date().toISOString(),
  appVersion: '0.10.0-lab',
  deviceModel: 'lab',
  platform: 'lab',
  identity,
  context: ctx,
  publicKeyBase64: key.publicKeyBase64,
  fingerprint: key.fingerprint,
});

// ---------- 1. wifi is inside the signed payload ----------
{
  const signed = await signRecord(mkRecord(ctxWith), key.signDigest, key.signPayload);
  const v = verifyRecordSignature(signed);
  check('wifi claim signs and verifies', v.signatureValid && v.fingerprintMatches);
  const w = (signed.context as any).wifi;
  check('wifi claim round-trips intact', w?.ssid === WIFI.ssid && w?.bssid === WIFI.bssid);

  const tamperSsid = JSON.parse(JSON.stringify(signed));
  tamperSsid.context.wifi.ssid = 'EvilTwin';
  check('SSID tamper breaks the signature', !verifyRecordSignature(tamperSsid).signatureValid);

  const tamperBssid = JSON.parse(JSON.stringify(signed));
  tamperBssid.context.wifi.bssid = '00:11:22:33:44:55';
  check('BSSID tamper breaks the signature', !verifyRecordSignature(tamperBssid).signatureValid);

  const removeWifi = JSON.parse(JSON.stringify(signed));
  delete removeWifi.context.wifi;
  check('stripping the wifi key breaks the signature', !verifyRecordSignature(removeWifi).signatureValid);
}

// ---------- 2. tri-state honesty + legacy neutrality ----------
{
  for (const state of ['redacted', 'unavailable'] as const) {
    const signed = await signRecord(mkRecord({ ...ctxWith, wifi: state }), key.signDigest, key.signPayload);
    check(`wifi '${state}' signs and verifies`, verifyRecordSignature(signed).signatureValid);
  }
  const nullMembers = await signRecord(
    mkRecord({ ...ctxWith, wifi: { ssid: null, bssid: null } }), key.signDigest, key.signPayload);
  check('wifi with null ssid/bssid signs and verifies', verifyRecordSignature(nullMembers).signatureValid);

  const legacyCtx = { ...ctxWith };
  delete legacyCtx.wifi;
  const legacy = await signRecord(mkRecord(legacyCtx), key.signDigest, key.signPayload);
  check('legacy record (no wifi key) verifies neutral', verifyRecordSignature(legacy).signatureValid
    && !('wifi' in (legacy.context as any)));
}

// ---------- 3. real photo path ----------
const j = await attestPhoto({ photoUri: '/tmp/lab/clean.jpg', context: ctxWith, identity, key });
if (!j.signedPhotoBytes) { console.log('FATAL: photo embed gate declined'); process.exit(1); }
fs.writeFileSync('/tmp/lab/wifi-signed.jpg', j.signedPhotoBytes);
{
  const w = (j.record.context as any).wifi;
  check('attestPhoto carries the wifi claim', w?.ssid === WIFI.ssid && w?.bssid === WIFI.bssid);
  const report = await verifyPhotoBytes(j.signedPhotoBytes);
  check('wifi-bearing photo verifies INTACT', report.verdict === 'INTACT', `got ${report.verdict}`);
  if (!c2patoolAvailable) {
    skip('c2patool validates the wifi-bearing JPEG', 'c2patool not installed');
  } else try {
    execFileSync(c2patoolBin, ['/tmp/lab/wifi-signed.jpg'], { stdio: 'pipe' });
    check('c2patool validates the wifi-bearing JPEG', true);
  } catch {
    check('c2patool validates the wifi-bearing JPEG', false);
  }
}

// ---------- 4. deID always strips the wifi claim ----------
{
  const d = await deidentifyPhoto({ photoUri: '/tmp/lab/wifi-signed.jpg', key, capturedAt: j.record.capturedAt });
  check('deidentifyPhoto marks wifi redacted', (d.record.context as any).wifi === 'redacted');
  check('deidentifyPhoto lists wifi among stripped fields', !!d.record.deidentified?.fields.includes('wifi'));
  const dv = await verifyPhotoBytes(d.signedPhotoBytes);
  check('de-identified copy still verifies INTACT', dv.verdict === 'INTACT', `got ${dv.verdict}`);
  const origW = (j.record.context as any).wifi;
  check('original record keeps its wifi claim', origW?.ssid === WIFI.ssid && origW?.bssid === WIFI.bssid);
}

{
  const pngBytes = new Uint8Array(fs.readFileSync('/tmp/lab/clean.png'));
  const dp = await deidentifyPhotoToPng({ pngBytes, key, capturedAt: j.record.capturedAt });
  check('deidentifyPhotoToPng marks wifi redacted', (dp.record.context as any).wifi === 'redacted');
  check('deidentifyPhotoToPng lists wifi among stripped fields', !!dp.record.deidentified?.fields.includes('wifi'));
  check('PNG deID copy signature verifies', verifyRecordSignature(dp.record).signatureValid);
}

{
  const v = await attestVideo({ videoUri: '/tmp/lab/clean.mp4', context: ctxWith, identity, key });
  if (!v.signedVideoBytes) { console.log('FATAL: video embed gate declined'); process.exit(1); }
  check('attestVideo carries the wifi claim', (v.record.context as any).wifi?.ssid === WIFI.ssid);
  const db = await deidentifyBmff({ bytes: v.signedVideoBytes, mime: 'video/mp4', kind: 'video', key, capturedAt: v.record.capturedAt });
  check('deidentifyBmff marks wifi redacted', (db.record.context as any).wifi === 'redacted');
  check('deidentifyBmff lists wifi among stripped fields', !!db.record.deidentified?.fields.includes('wifi'));
  check('BMFF deID copy signature verifies', verifyRecordSignature(db.record).signatureValid);
}

console.log(`\n=== ${pass} passed, ${fail} failed, ${skipped} skipped ===`);
process.exit(fail ? 1 : 0);

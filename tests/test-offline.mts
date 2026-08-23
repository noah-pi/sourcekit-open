// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Full-offline chain (zero-dependency).
 *
 * With every network call failing: capture signs, the signed file verifies,
 * tampering is caught, and every export builds. The capture path's only
 * fetches are the RFC 3161 timestamp authorities; without them capture
 * succeeds and the report states zero tokens.
 *
 * Verification must perform zero network calls; the fetch counter below is
 * the tripwire.
 *
 * Run from tests/.staged:  ./node_modules/.bin/tsx test-offline.mts
 */
import * as fs from 'node:fs';
import { attestPhoto } from './attest.mts';
import { verifyPhotoBytes } from './verifyAsset.mts';
import { labSigner } from './deviceKey-shim.mts';
import { buildHashClaim, isHashClaim, exportEntriesToCsv, exportEntriesToGeoJson, exportEntriesToKml } from './proofBundle.mts';
import { payloadDigest } from './sign.mts';
import { bytesToHex } from './bytes.mts';

let fetchCalls = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (async () => {
  fetchCalls += 1;
  throw new Error('offline: every network call rejects (test stub)');
}) as typeof fetch;

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name} :: ${detail}`); }
};

/**
 * Failure detail line. SIGNATURE_INVALID has four causes in verifyAsset and
 * only the check flags say which fired, so print them plus any skip reasons.
 */
const why = (report: any) =>
  [report.verdict,
   `checks=${JSON.stringify(report.checks ?? null)}`,
   `notPerformed=${JSON.stringify(report.checksNotPerformed ?? [])}`,
  ].join(' ');

const JPEG_1PX = Buffer.from(
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQBAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhADEAAAAc//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAEFAs//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/ASf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/ASf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAY/As//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/IV//2gAMAwEAAgADAAAAEP/EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQMBAT8QH//EABQQAQAAAAAAAAAAAAAAAAAAABD/2gAIAQIBAT8QH//EABQQAQAAAAAAAAAAAAAAAAAAABD/2gAIAQEAAT8QH//Z',
  'base64'
);

const ctx = {
  location: { lat: 37.7749, lon: -122.4194, accuracyM: 5 },
  headingDeg: 90, pressureHPa: 1013, altitudeM: 15,
  motion: { verdict: 'handheld', rms: 0.02, peakHz: 3.2 },
} as any;

console.log('— full-offline chain —');

// 1. Capture signs with the network fully down.
const tmp = '/tmp/offline-clean.jpg';
fs.writeFileSync(tmp, JPEG_1PX);
const signed = await attestPhoto({ photoUri: tmp, context: ctx, identity: { author: 'Offline Tester', organization: null }, key: labSigner() });
check('capture signs with every network call rejecting', !!signed.signedPhotoBytes && !!signed.record);
check(
  'capture-integrity signals still recorded offline',
  signed.record.captureIntegrity?.note === 'self-reported' && typeof signed.record.captureIntegrity?.captureToSignatureMs === 'number'
);

// 2. Verification is INTACT and performs zero network calls.
fetchCalls = 0;
const report = await verifyPhotoBytes(signed.signedPhotoBytes!);
check('signed photo verifies INTACT offline', report.verdict === 'INTACT', why(report));
check('verification performs zero network calls', fetchCalls === 0, `${fetchCalls} fetch attempts during verify`);

// 3. Time evidence: no tokens, reported as zero.
check(
  'timestamp tokens honestly absent (present=0, valid=0)',
  (report.c2pa?.timestamps.present ?? -1) === 0 && (report.c2pa?.timestamps.valid ?? -1) === 0
);
check('App Attest honestly absent on an unattested device', report.c2pa?.appAttest.present === false);

// 4. Tampering is still caught with no network.
const tampered = new Uint8Array(signed.signedPhotoBytes!);
tampered[tampered.length - 100] ^= 0xff;
const tamperedReport = await verifyPhotoBytes(tampered);
check('tampered copy rejected offline', tamperedReport.verdict === 'CONTENT_MODIFIED', why(tamperedReport));

// 5. Every export builds offline.
const claim = buildHashClaim(signed.record);
check('hash-only claim builds and round-trips', isHashClaim(JSON.parse(JSON.stringify(claim))));
check('claim binds the record payload digest', claim.payloadDigestHex === bytesToHex(payloadDigest(signed.record)));
const entry = {
  id: 'offline-1', createdAt: signed.record.capturedAt, kind: 'photo',
  sha256: signed.record.asset.sha256, bytes: signed.record.asset.bytes,
  fingerprint: signed.record.signer.fingerprint, motionVerdict: 'handheld',
  lat: 37.7749, lon: -122.4194, locationState: 'present' as const,
  otsState: 'none' as const, otsBlockHeight: null,
};
const csv = exportEntriesToCsv([entry]);
const geo = exportEntriesToGeoJson([entry]);
const kml = exportEntriesToKml([entry]);
check('CSV / GeoJSON / KML exports build offline',
  csv.includes(signed.record.asset.sha256) && geo.includes('-122.4194') && kml.includes('<kml'));

globalThis.fetch = realFetch;
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) { console.error('OFFLINE CHAIN TEST FAILED'); process.exit(1); }
console.log('OFFLINE CHAIN TEST PASSED');

// Source Kit 0.1.0 — reference corpus builder
// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Reference corpus builder. Produces tests/corpus/: real files paired with
 * expected verdicts, signed fresh with a random lab key on every build.
 * Consumed by test-corpus.mts in CI, by the c2patool / ProofCheck
 * comparison harness, and as the before/after oracle for an engine swap.
 *
 * Run from tests/.staged:  ../node_modules/.bin/tsx ../build-corpus.mts
 * (paths below resolve relative to .staged; output lands in ../corpus).
 *
 * Categories: signed, tampered, stripped, hostile, recaptured. A recapture
 * (photo of a photo) verifies INTACT because a signature covers custody only;
 * its expectation file pins that verdict.
 */
import * as fs from 'node:fs';
import { attestPhoto, attestPng } from './attest.mts';
import { stripManifest } from './jpegApp11.mts';
import { labSigner } from './deviceKey-shim.mts';

const OUT = new URL('../corpus/', import.meta.url).pathname;
fs.mkdirSync(OUT, { recursive: true });

// 1×1 white JPEG and PNG. Lab media; the pixels are irrelevant.
const JPEG_1PX = Buffer.from(
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQBAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhADEAAAAc//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAEFAs//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/ASf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/ASf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAY/As//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/IV//2gAMAwEAAgADAAAAEP/EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQMBAT8QH//EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQIBAT8QH//EABQQAQAAAAAAAAAAAAAAAAAAABD/2gAIAQEAAT8QH//Z',
  'base64'
);
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

const key = labSigner();
const ctx = {
  location: { lat: 37.7749, lon: -122.4194, accuracyM: 5 },
  headingDeg: 90, pressureHPa: 1013, altitudeM: 15,
  motion: { verdict: 'handheld', rms: 0.02, peakHz: 3.2 },
} as any;
const identity = { author: 'Corpus Builder', organization: null };

type Expectation = {
  file: string;
  category: 'signed' | 'tampered' | 'stripped' | 'hostile' | 'recaptured';
  expect: { verdict: string; assetHashMatches?: boolean; signatureValid?: boolean };
  note: string;
};
const expectations: Expectation[] = [];
const write = (name: string, bytes: Uint8Array) => fs.writeFileSync(OUT + name, bytes);

// --- 1. signed (valid) ---
const tmpClean = '/tmp/corpus-clean.jpg';
fs.writeFileSync(tmpClean, JPEG_1PX);
const signed = await attestPhoto({ photoUri: tmpClean, context: ctx, identity, key });
write('signed-valid.jpg', signed.signedPhotoBytes!);
expectations.push({
  file: 'signed-valid.jpg', category: 'signed',
  expect: { verdict: 'INTACT', assetHashMatches: true, signatureValid: true },
  note: 'A genuine capture. Everything checks.',
});

// --- 2. tampered (pixel flipped after signing) ---
const tampered = new Uint8Array(signed.signedPhotoBytes!);
tampered[tampered.length - 100] ^= 0xff;
write('tampered-pixel.jpg', tampered);
expectations.push({
  file: 'tampered-pixel.jpg', category: 'tampered',
  expect: { verdict: 'CONTENT_MODIFIED', assetHashMatches: false, signatureValid: true },
  note: 'One byte flipped outside the manifest. Signature valid, media changed.',
});

// --- 3. stripped (credentials removed) ---
write('stripped.jpg', stripManifest(signed.signedPhotoBytes!));
expectations.push({
  file: 'stripped.jpg', category: 'stripped',
  expect: { verdict: 'NO_ATTESTATION' },
  note: 'Manifest removed. Absence of credentials proves nothing either way — and must say so.',
});

// --- 4. hostile (claim tampered inside the manifest) ---
const hostile = new Uint8Array(signed.signedPhotoBytes!);
const marker = Buffer.from('com.verify.telemetry', 'utf8');
const idx = Buffer.from(hostile).indexOf(marker);
if (idx < 0) throw new Error('telemetry marker not found — corpus builder drifted');
hostile[idx + marker.length + 4] ^= 0xff; // corrupt claim content so COSE fails
write('hostile-claim.jpg', hostile);
expectations.push({
  file: 'hostile-claim.jpg', category: 'hostile',
  expect: { verdict: 'SIGNATURE_INVALID' },
  note: 'Manifest content altered after signing. The signature must fail, never downgrade quietly.',
});

// --- 5. recaptured (the analog hole, pinned behavior) ---
// A recapture is another genuine signing pass, cryptographically
// indistinguishable from the original.
const recaptured = await attestPhoto({ photoUri: tmpClean, context: ctx, identity, key });
write('recaptured-screen.jpg', recaptured.signedPhotoBytes!);
expectations.push({
  file: 'recaptured-screen.jpg', category: 'recaptured',
  expect: { verdict: 'INTACT', assetHashMatches: true, signatureValid: true },
  note: 'Simulates a photo of a screen (the analog hole). Verifies INTACT — a signature proves custody, not what the camera pointed at. This expectation exists so nobody ever "fixes" it.',
});

// --- PNG coverage: signed + tampered ---
const signedPng = await attestPng({ pngBytes: new Uint8Array(PNG_1PX), context: ctx, identity, key });
write('signed-valid.png', signedPng.signedPngBytes);
expectations.push({
  file: 'signed-valid.png', category: 'signed',
  expect: { verdict: 'INTACT', assetHashMatches: true, signatureValid: true },
  note: 'PNG path — caBX chunk, same hard binding.',
});
const tamperedPng = new Uint8Array(signedPng.signedPngBytes);
// Flip a byte inside the IDAT pixel data, located dynamically: a fixed
// offset lands in the caBX manifest chunk, where a flip may hit a
// timestamp token and leave the verdict unchanged.
const idatAt = Buffer.from(tamperedPng).indexOf('IDAT');
if (idatAt < 0) throw new Error('IDAT not found — corpus builder drifted');
tamperedPng[idatAt + 8] ^= 0xff; // +4 length, +4 type: inside the data
write('tampered-pixel.png', tamperedPng);
expectations.push({
  file: 'tampered-pixel.png', category: 'tampered',
  expect: { verdict: 'CONTENT_MODIFIED', assetHashMatches: false, signatureValid: true },
  note: 'One byte flipped in the pixel region of a signed PNG.',
});

fs.writeFileSync(
  OUT + 'expected-verdicts.json',
  JSON.stringify(
    {
      format: 'verify-corpus/1',
      builtAt: new Date().toISOString(),
      signerFingerprint: key.fingerprint,
      semantics: 'verdict = VerificationReport.verdict from verifyPhoto; assetHashMatches/signatureValid = report.checks fields where applicable',
      files: expectations,
    },
    null,
    2
  )
);
console.log(`corpus built: ${expectations.length} files → ${OUT}`);

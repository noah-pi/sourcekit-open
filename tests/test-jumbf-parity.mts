// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * JUMBF assertions + media parity.
 *
 *   - com.verify.streamedChunks / contextTree / poseTrace / captureIntegrity
 *     ride as REAL JUMBF assertion boxes (hashed into the claim via the
 *     standard assertionHashes path) — not as JSON blobs inside telemetry;
 *   - THE PARITY PRINCIPLE: the same assertion label set for photo, video,
 *     and audio — the only divergences are the named exceptions;
 *   - a tampered custom assertion fails the claim's assertion-hash binding;
 *   - golden: the assertion-box layout is byte-stable for fixed inputs.
 *
 * Run from tests/.staged:  ./node_modules/.bin/tsx test-jumbf-parity.mts
 */
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sha256 } from '@noble/hashes/sha256';
import { attestAudio, attestPhoto, attestVideo } from './attest.mts';
import {
  extractC2paStore,
  parseManifest,
  verifyManifest,
  type C2paManifest,
} from './c2pa.mts';
import { extractC2paStoreBmff } from './bmff.mts';
import { labSigner } from './deviceKey-shim.mts';
import { utf8ToBytes } from './bytes.mts';

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name} :: ${detail}`); }
};
const section = (t: string) => console.log(`\n— ${t} —`);

// Repo-relative default: stage.mjs copies this suite INTO tests/.staged, so
// the staged dir is this file's own directory. VERIFY_STAGED_DIR overrides
// when running the un-staged source against a lab staged elsewhere.
const STAGED = process.env.VERIFY_STAGED_DIR ?? fileURLToPath(new URL('.', import.meta.url));
const key = labSigner();
const sensorLog = Array.from(
  { length: 50 },
  (_, i) => `{"t":${(i * 0.01).toFixed(2)},"kind":"gyro","x":0.001,"y":-0.002,"z":0.003}`
).join('\n') + '\n';
const evidenceEnabled = { ring: true, rawPcm: true, sensors: true };

/** The parity set (present for EVERY media kind). */
const PARITY_LABELS = [
  'com.verify.captureIntegrity',
  'com.verify.contextTree',
  'com.verify.poseTrace',
  'com.verify.streamedChunks',
].sort();

// ---------------------------------------------------------------------------
section('seal one asset of each kind with the full evidence context');

const ctx = {
  location: { lat: 37.7749, lon: -122.4194, accuracyM: 5 },
  headingDeg: 90,
  captureEvidence: { ringBufferDir: '/tmp/ring', rawPcmPath: '/tmp/a.pcm', sensorLogPath: '/tmp/s.jsonl' },
} as any;

const photo = await attestPhoto({
  photoUri: `${STAGED}/clean.jpg`,
  context: ctx,
  identity: { author: 'Parity', organization: 'Lab' },
  key,
  sensorLogText: sensorLog,
  evidenceEnabled,
});
const video = await attestVideo({
  videoUri: `${STAGED}/clean.mp4`,
  context: ctx,
  identity: { author: 'Parity', organization: 'Lab' },
  key,
  sensorLogText: sensorLog,
  evidenceEnabled,
});
const audio = await attestAudio({
  audioUri: `${STAGED}/clean.m4a`,
  context: ctx,
  identity: { author: 'Parity', organization: 'Lab' },
  key,
  sensorLogText: sensorLog,
  evidenceEnabled,
});
check('all three kinds sealed', !!photo.signedPhotoBytes && !!video.signedVideoBytes && !!audio.signedAudioBytes);

function manifestOf(kind: 'photo' | 'video' | 'audio'): C2paManifest {
  const bytes = kind === 'photo' ? photo.signedPhotoBytes! : kind === 'video' ? video.signedVideoBytes! : audio.signedAudioBytes!;
  const store = kind === 'photo' ? extractC2paStore(bytes) : extractC2paStoreBmff(bytes);
  return parseManifest(store!.payload)!;
}
const manifests = { photo: manifestOf('photo'), video: manifestOf('video'), audio: manifestOf('audio') };

// ---------------------------------------------------------------------------
section('the parity principle: the same label set for every kind');

for (const kind of ['photo', 'video', 'audio'] as const) {
  const m = manifests[kind];
  const present = PARITY_LABELS.filter((l) => m.customAssertions[l] !== undefined).sort();
  check(`${kind}: the full parity set rides as JUMBF assertions`,
    JSON.stringify(present) === JSON.stringify(PARITY_LABELS),
    `present=${JSON.stringify(present)}`);
  check(`${kind}: every parity label is hashed into the claim (assertionHashes)`,
    PARITY_LABELS.every((l) => m.assertionHashes[l] instanceof Uint8Array));
  check(`${kind}: every parity label is REFERENCED by the signed claim (A-I-1)`,
    PARITY_LABELS.every((l) => m.referencedAssertionLabels.includes(l) && m.customAssertions[l]?.referenced === true));
}

// The ONLY allowed divergences by media kind — each named, none silent.
{
  const sc = (k: 'photo' | 'video' | 'audio') => manifests[k].customAssertions['com.verify.streamedChunks']?.data as any;
  check('photo streamedChunks is the structural zero-track assertion',
    sc('photo').tracks.length === 0 && sc('photo').note.includes('No elementary streams'));
  check('video streamedChunks commits its track(s)', sc('video').tracks.length >= 1);
  check('audio streamedChunks commits exactly one audio track',
    sc('audio').tracks.length === 1 && sc('audio').tracks[0].trackId === 'audio');
  const ci = (k: 'photo' | 'video' | 'audio') => manifests[k].customAssertions['com.verify.captureIntegrity']?.data as any;
  check('captureIntegrity carries the same fields for every kind',
    ['photo', 'video', 'audio'].every((k) => {
      const a = ci(k as 'photo');
      return a.v === 1 && a.note === 'self-reported' &&
        typeof a.captureToSignatureMs === 'number' &&
        'evidenceEnabled' in a && 'evidenceComplete' in a && 'biometricGatePassed' in a;
    }));
  check('evidenceComplete is true when every enabled sink produced its file',
    ['photo', 'video', 'audio'].every((k) => ci(k as 'photo').evidenceComplete === true));
  const ct = (k: 'photo' | 'video' | 'audio') => manifests[k].customAssertions['com.verify.contextTree']?.data as any;
  check('contextTree commits the same schema for every kind',
    ['photo', 'video', 'audio'].every((k) => {
      const a = ct(k as 'photo');
      return a.version === '1.0.0-ws2' && typeof a.root === 'string' && Array.isArray(a.entries) && Array.isArray(a.neverRecorded);
    }));
  check('contextTree roots differ per asset (fresh master seed each seal)',
    ct('photo').root !== ct('video').root && ct('video').root !== ct('audio').root);
  const pt = (k: 'photo' | 'video' | 'audio') => manifests[k].customAssertions['com.verify.poseTrace']?.data as any;
  check('poseTrace commits the same trace for every kind',
    ['photo', 'video', 'audio'].every((k) => pt(k as 'photo').sampleCount === 50 && pt(k as 'photo').gyroPriorAuthenticated === false));
}

// ---------------------------------------------------------------------------
section('a tampered custom assertion fails the claim binding');

{
  // Flip one byte inside the com.verify.poseTrace box of the signed JPEG and
  // confirm the claim's assertion hash no longer matches the box bytes.
  const tampered = new Uint8Array(photo.signedPhotoBytes!);
  const needle = utf8ToBytes('gyroPriorAuthenticated');
  let at = -1;
  outer: for (let i = 0; i + needle.length <= tampered.length; i++) {
    for (let j = 0; j < needle.length; j++) if (tampered[i + j] !== needle[j]) continue outer;
    at = i;
    break;
  }
  check('located the poseTrace box bytes in the file', at > 0);
  tampered[at + 20] ^= 0x01;
  const tm = parseManifest(extractC2paStore(tampered)!.payload)!;
  const v = verifyManifest(tampered, tm);
  check('tampered poseTrace fails the claim assertion-hash binding', v.claimAssertionsMatch === false, JSON.stringify(v));
  // The binding check is over the box bytes — the parsed claim's hash for the
  // tampered label must differ from a recomputation over the tampered box.
  const intact = verifyManifest(photo.signedPhotoBytes!, manifests.photo);
  check('the untampered manifest verifies clean',
    intact.signatureValid && intact.assetHashMatches && intact.claimAssertionsMatch,
    JSON.stringify(intact).slice(0, 300));
}

// ---------------------------------------------------------------------------
section('golden: the assertion-box layout is byte-stable for fixed inputs');

{
  // Build two manifests from byte-identical inputs; the custom assertion
  // boxes must be byte-identical (JSON.stringify field order is the schema).
  const build = async () => attestPhoto({
    photoUri: `${STAGED}/clean.jpg`,
    context: { location: null, captureEvidence: { ringBufferDir: 'never-recorded', rawPcmPath: 'never-recorded', sensorLogPath: '/tmp/s.jsonl' } } as any,
    identity: 'redacted',
    key,
    capturedAt: '2026-08-06T10:00:00.000Z',
    sensorLogText: sensorLog,
    evidenceEnabled,
  });
  const a1 = await build();
  const a2 = await build();
  const m1 = parseManifest(extractC2paStore(a1.signedPhotoBytes!)!.payload)!;
  const m2 = parseManifest(extractC2paStore(a2.signedPhotoBytes!)!.payload)!;
  // captureToSignatureMs is excluded: it derives from wall-clock at seal
  // time, so two builds from a fixed capturedAt honestly differ on it.
  const stripClock = (d: unknown) => {
    const c = { ...(d as Record<string, unknown>) };
    delete c.captureToSignatureMs;
    return JSON.stringify(c);
  };
  check('fixed inputs → byte-identical assertion bodies',
    JSON.stringify(m1.customAssertions['com.verify.poseTrace']?.data) === JSON.stringify(m2.customAssertions['com.verify.poseTrace']?.data) &&
    stripClock(m1.customAssertions['com.verify.captureIntegrity']?.data) === stripClock(m2.customAssertions['com.verify.captureIntegrity']?.data));
  // The contextTree root differs ONLY because the master seed is fresh —
  // the inventory ENTRIES (states, never-recorded) must be stable.
  const e1 = m1.customAssertions['com.verify.contextTree']?.data as any;
  const e2 = m2.customAssertions['com.verify.contextTree']?.data as any;
  check('fixed inputs → identical inventory entries + never-recorded declaration',
    JSON.stringify(e1.entries) === JSON.stringify(e2.entries) &&
    JSON.stringify(e1.neverRecorded) === JSON.stringify(e2.neverRecorded));
  // Golden: the exact JSON serialization of the zero-track streamedChunks
  // assertion (schema stability — a field rename breaks this on purpose).
  const expectedStill =
    '{"label":"com.verify.streamedChunks","v":2,"alg":"sha256-merkle","chunkBytes":1048576,"tracks":[],' +
    '"superRoot":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855","binding":"delivery-file",' +
    '"note":"No elementary streams: a still image commits its whole file byte-for-byte via the c2pa.hash.data hard binding. Structural absence of tracks, stated — the assertion set is identical across media kinds."}';
  check('golden: zero-track streamedChunks serialization is pinned',
    JSON.stringify(m1.customAssertions['com.verify.streamedChunks']?.data) === expectedStill);
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);

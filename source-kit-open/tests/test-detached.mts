/**
 * Detached-manifest custody matching.
 *
 * The platform-stripping story, made testable: credentials ride in metadata;
 * platforms strip metadata; the sidecar manifest bundle + this matcher let a
 * desk prove EXACT custody of the stripped file's bytes — no recovery
 * service, no similarity guessing.
 *
 * Run from tests/.staged:  ./node_modules/.bin/tsx test-detached.mts
 */
import * as fs from 'node:fs';
import { attestPhoto, attestPng, attestVideo } from './attest.mts';
import { verifyPhotoBytes, verifyVideoBytes } from './verifyAsset.mts';
import { extractC2paStore } from './c2pa.mts';
import { extractC2paStoreBmff } from './bmff.mts';
import { extractCaBx, stripCaBx } from './png.mts';
import { matchDetachedManifest } from './detached.mts';
import { labSigner } from './deviceKey-shim.mts';
import { concatBytes, asciiToBytes } from './bytes.mts';

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name} :: ${detail}`); }
};

const key = labSigner();
const ctx = { location: { lat: 37.7749, lon: -122.4194, accuracyM: 5 }, headingDeg: 90 } as any;
const identity = { author: 'Detached Test', organization: null };

// ---------- JPEG ----------
console.log('— JPEG, APP11 stripped —');
const j = await attestPhoto({ photoUri: '/tmp/lab/clean.jpg', context: ctx, identity, key });
const jBytes = j.signedPhotoBytes!;
const jStore = extractC2paStore(jBytes)!;
check('sanity: signed jpeg carries a store', !!jStore);
const jStripped = concatBytes(jBytes.subarray(0, jStore.segmentStart), jBytes.subarray(jStore.segmentStart + jStore.segmentLength));
check('sanity: stripped jpeg reports NO_ATTESTATION', (await verifyPhotoBytes(jStripped)).verdict === 'NO_ATTESTATION');

const jMatch = matchDetachedManifest(jStripped, jStore.payload);
check('stripped jpeg matches its detached manifest — EXACT after strip', jMatch !== null && jMatch.how === 'stripped-container');
check('match carries a verified COSE signature', jMatch?.signatureValid === true && jMatch?.claimAssertionsMatch === true);

const jWhole = matchDetachedManifest(jBytes, jStore.payload);
check('unstripped jpeg matches via the exclusion ranges', jWhole !== null && jWhole.how === 'exclusion-ranges');

const jTampered = Uint8Array.from(jStripped);
jTampered[jTampered.length - 100] ^= 0xff; // inside the scan data
check('tampered stripped jpeg does NOT match (exact means exact)', matchDetachedManifest(jTampered, jStore.payload) === null);

// Two captures of the SAME source file: the asset hash commits to BYTES, not
// to a capture event — so the same bytes match, correctly and honestly.
const jSame = await attestPhoto({ photoUri: '/tmp/lab/clean.jpg', context: { ...ctx, headingDeg: 180 }, identity, key });
const jSameStore = extractC2paStore(jSame.signedPhotoBytes!)!;
check('same source bytes match across captures (the commitment is to bytes)', matchDetachedManifest(jStripped, jSameStore.payload) !== null);
const jOther = await attestPhoto({ photoUri: '/tmp/lab/other.jpg', context: ctx, identity, key });
const jOtherStore = extractC2paStore(jOther.signedPhotoBytes!)!;
check('DIFFERENT media bytes do NOT match', matchDetachedManifest(jStripped, jOtherStore.payload) === null);

// ---------- PNG ----------
console.log('— PNG, caBX stripped —');
const p = await attestPng({ pngBytes: new Uint8Array(fs.readFileSync('/tmp/lab/clean.png')), context: ctx, identity, key });
const pBytes = p.signedPngBytes!;
const pStore = extractCaBx(pBytes)!;
const pStripped = stripCaBx(pBytes);
check('sanity: stripped png reports NO_ATTESTATION', (await verifyPhotoBytes(pStripped)).verdict === 'NO_ATTESTATION');
const pMatch = matchDetachedManifest(pStripped, pStore.store);
check('stripped png matches its detached manifest — EXACT after strip', pMatch !== null && pMatch.how === 'stripped-container');

// ---------- MP4 ----------
console.log('— MP4, uuid box stripped —');
const v = await attestVideo({ videoUri: '/tmp/lab/clean.mp4', context: ctx, identity, key });
const vBytes = v.signedVideoBytes!;
const vStore = extractC2paStoreBmff(vBytes)!;
check('sanity: signed mp4 carries a uuid store', !!vStore);
const vStripped = concatBytes(vBytes.subarray(0, vStore.boxStart), vBytes.subarray(vStore.boxStart + vStore.boxSize));
check('sanity: stripped mp4 reports NO_ATTESTATION', (await verifyVideoBytes(vStripped)).verdict === 'NO_ATTESTATION');
const vMatch = matchDetachedManifest(vStripped, vStore.payload);
check('stripped mp4 matches its detached manifest — EXACT (box-relative hash)', vMatch !== null && vMatch.how === 'stripped-container');
check('mp4 match carries a verified COSE signature', vMatch?.signatureValid === true && vMatch?.claimAssertionsMatch === true);

const vTampered = Uint8Array.from(vStripped);
const mdatAt = vTampered.findIndex((_, i) => i > 4 && vTampered[i - 4] === 0x6d && vTampered[i - 3] === 0x64 && vTampered[i - 2] === 0x61 && vTampered[i - 1] === 0x74);
if (mdatAt > 0) vTampered[mdatAt + 200] ^= 0xff;
check('tampered stripped mp4 does NOT match', mdatAt > 0 && matchDetachedManifest(vTampered, vStore.payload) === null);

check('garbage store payload never matches', matchDetachedManifest(vStripped, new Uint8Array([1, 2, 3, 4])) === null);
check('garbage media never matches', matchDetachedManifest(new Uint8Array([0xff, 0xd8, 1, 2]), jStore.payload) === null);

// ---------- UNSUPPORTED verdict ----------
// A manifest whose uuid box references merkle aux boxes is one this build
// cannot check: the honest verdict is UNSUPPORTED (unchecked), never
// SIGNATURE_INVALID (condemned credentials we never evaluated).
{
  const u32 = (n: number) => new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
  const bx = (t: string, c: Uint8Array) => concatBytes(u32(c.length + 8), asciiToBytes(t), c);
  const ftyp = bx('ftyp', concatBytes(asciiToBytes('isom'), u32(0), asciiToBytes('isom')));
  const C2PA_UUID = [0xd8, 0xfe, 0xc3, 0xd6, 0x1b, 0x0e, 0x48, 0x3c, 0x92, 0x97, 0x58, 0x28, 0x87, 0x7e, 0xc4, 0x81];
  const merkleUuid = bx('uuid', concatBytes(
    new Uint8Array(C2PA_UUID), new Uint8Array(4), asciiToBytes('manifest'), new Uint8Array([0]),
    new Uint8Array([0, 0, 0, 0, 0, 0, 0, 42]), // merkle offset ≠ 0 → aux boxes we can't walk
    new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
  ));
  const mdat = bx('mdat', new Uint8Array(64));
  const fragFile = concatBytes(ftyp, merkleUuid, mdat);
  const ru = await verifyVideoBytes(fragFile);
  check('merkle-aux manifest: UNSUPPORTED (unchecked), not condemned', ru.verdict === 'UNSUPPORTED', ru.verdict);
  check('UNSUPPORTED states the reason in checksNotPerformed',
    (ru.checksNotPerformed ?? []).some((l) => /merkle|unsupported/i.test(l)));
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);

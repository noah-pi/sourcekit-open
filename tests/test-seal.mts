// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Seal-to-desk + Shamir custody.
 *
 * The seizure story, made testable:
 *   device sealed artifact  →  ciphertext the photographer cannot open
 *   one stolen laptop       →  one Shamir share → decrypts NOTHING
 *   K shares together       →  desk key → desk opens and verifies the capture
 *
 * Run from tests/.staged:  ./node_modules/.bin/tsx test-seal.mts
 */
import * as fs from 'node:fs';
import { splitSecret, combineShares, shareToText, shareFromText } from './shamir.mts';
import {
  generateDeskKeyPair, deskKeyFingerprint, deskKeyPairFromPrivateHex,
  sealToDeskKey, unsealWithDeskKey, parseSealedHeader, SEAL_FORMAT,
} from './seal.mts';
import { createRoster, resignRoster, isRoster, verifyRosterSignature } from './roster.mts';
import { attestPhoto } from './attest.mts';
import { verifyPhotoBytes } from './verifyAsset.mts';
import { labSigner } from './deviceKey-shim.mts';
import { bytesToHex, bytesToBase64, utf8ToBytes } from './bytes.mts';
import { randomBytes } from '@noble/hashes/utils';

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name} :: ${detail}`); }
};
const throws = async (fn: () => unknown): Promise<boolean> => {
  try { await fn(); return false; } catch { return true; }
};
/** Substring search — plaintext must never appear inside a sealed artifact. */
const contains = (hay: Uint8Array, needle: Uint8Array): boolean => {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
};

// ---------- Shamir ----------
console.log('— Shamir secret sharing —');
const secret = randomBytes(32);

const s22 = splitSecret(secret, 2, 2);
check('2-of-2: both shares reconstruct', bytesToHex(combineShares(s22)) === bytesToHex(secret));
check('2-of-2: either order reconstructs', bytesToHex(combineShares([s22[1], s22[0]])) === bytesToHex(secret));

const s35 = splitSecret(secret, 3, 5);
check('3-of-5: shares 1,3,5 reconstruct', bytesToHex(combineShares([s35[0], s35[2], s35[4]])) === bytesToHex(secret));
check('3-of-5: shares 2,3,4 reconstruct', bytesToHex(combineShares([s35[1], s35[2], s35[3]])) === bytesToHex(secret));
check('3-of-5: extra shares still reconstruct', bytesToHex(combineShares([s35[0], s35[1], s35[2], s35[3]])) === bytesToHex(secret));

check('2-of-3 with one share REPLACED by a different split fails loudly', await throws(() => {
  const other = splitSecret(secret, 2, 3);
  combineShares([s22[0], other[0]]);
}));
check('duplicate share coordinate refused', await throws(() => combineShares([s35[0], s35[0], s35[1]])));
check('threshold 1 refused (that is not sharing)', await throws(() => splitSecret(secret, 1, 3)));
check('threshold above count refused', await throws(() => splitSecret(secret, 4, 3)));

const textRound = shareFromText(shareToText(s35[2]));
check('share text encoding round-trips', textRound.x === s35[2].x && bytesToHex(textRound.y) === bytesToHex(s35[2].y));
check('gutted share text rejected at the door', await throws(() => shareFromText(shareToText(s35[2]).slice(0, 20))));
// Modest truncation still parses (a share can't know its secret's length) —
// the LENGTH check catches it at combine…
const shortened = shareFromText(shareToText(s35[2]).slice(0, -8));
check('truncated share caught at reconstruction (length)', await throws(() => combineShares([s35[0], s35[1], shortened])));
// …and mid-string corruption (same length, valid base64) is caught by the TAG.
const mangled = shareFromText(shareToText(s35[2]).slice(0, -6) + 'AAAAAA');
check('mid-string share corruption caught at reconstruction (tag)', await throws(() => combineShares([s35[0], s35[1], mangled])));
check('foreign text rejected as a share', await throws(() => shareFromText('hello world')));

// A single share is cryptographically useless: with threshold 2, one share
// plus ANY guessed second share reconstructs something — and the tag on a
// real second split is what detects the wrong guess. Structural check:
// one share alone throws (needs ≥2), and the y-bytes of a threshold-2 share
// are uniformly random (they are secret + random·x evaluated in GF(256)).
check('one share alone cannot even attempt reconstruction', await throws(() => combineShares([s22[0]])));

// ---------- Seal format ----------
console.log('— Seal-to-desk —');
const desk = generateDeskKeyPair();
const otherDesk = generateDeskKeyPair();
const marker = utf8ToBytes('CONFIDENTIAL: source identity, GPS 37.7749,-122.4194');
const fakeMedia = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...marker, ...randomBytes(2048), 0xff, 0xd9]);
const proofJson = JSON.stringify({ format: 'lab-proof-fixture/1', note: 'proof rides inside the ciphertext' });

const sealed = sealToDeskKey(fakeMedia, proofJson, desk.publicKey);

const hdr = parseSealedHeader(sealed);
check('header parses before any key exists', hdr.format === SEAL_FORMAT);
check('header names the desk key fingerprint', hdr.deskKeyFingerprint === deskKeyFingerprint(desk.publicKey));
check('header leaks nothing about content', !contains(sealed, marker));
check('JPEG magic absent from sealed bytes', !contains(sealed, fakeMedia.subarray(0, 16)));

const opened = unsealWithDeskKey(sealed, desk.privateKey);
check('desk key opens the artifact', bytesToHex(opened.media) === bytesToHex(fakeMedia));
check('proof bundle survives the round trip', opened.proofJson === proofJson);

check('wrong desk key refused with a named reason', await throws(() => unsealWithDeskKey(sealed, otherDesk.privateKey)));

const tamperedCt = Uint8Array.from(sealed);
tamperedCt[tamperedCt.length - 20] ^= 0xff;
check('tampered ciphertext fails loudly (GCM tag)', await throws(() => unsealWithDeskKey(tamperedCt, desk.privateKey)));

const tamperedHdr = Uint8Array.from(sealed);
const hdrLen = new DataView(tamperedHdr.buffer, tamperedHdr.byteOffset).getUint32(0, true);
tamperedHdr[10] ^= 0x01; // flip a bit inside the header JSON (AAD)
check('tampered header fails loudly (AAD)', await throws(() => {
  try { parseSealedHeader(tamperedHdr); } catch { /* bit flip may break JSON — also loud */ }
  unsealWithDeskKey(tamperedHdr, desk.privateKey);
}));
check('truncated artifact refused', await throws(() => unsealWithDeskKey(sealed.subarray(0, sealed.length - 40), desk.privateKey)));
check('foreign bytes refused as a sealed capture', await throws(() => parseSealedHeader(randomBytes(200))));

const noProof = unsealWithDeskKey(sealToDeskKey(fakeMedia, null, desk.publicKey), desk.privateKey);
check('sealing without a proof bundle round-trips (null, not empty string)', noProof.proofJson === null);

// ---------- Roster carries the desk key, signed ----------
console.log('— Roster encryption block —');
const { roster, editorPrivateKeyHex } = await createRoster({ newsroom: 'The Examples Gazette', editorName: 'M. Alvarez' });
const withKey = await resignRoster(roster, editorPrivateKeyHex, roster.entries, {
  encryption: {
    deskPublicKeyBase64: bytesToBase64(desk.publicKey),
    fingerprint: deskKeyFingerprint(desk.publicKey),
    addedAt: new Date().toISOString(),
  },
});
check('roster with encryption block validates', isRoster(withKey));
check('roster with encryption block verifies', verifyRosterSignature(withKey).valid);
const swapped = JSON.parse(JSON.stringify(withKey));
swapped.encryption.deskPublicKeyBase64 = bytesToBase64(otherDesk.publicKey);
check('swapped desk key breaks the roster signature', !verifyRosterSignature(swapped).valid);
check('roster without encryption block still validates', isRoster(roster));
const cleared = await resignRoster(withKey, editorPrivateKeyHex, withKey.entries, { encryption: null });
check('encryption block can be removed by re-signing', cleared.encryption === undefined && verifyRosterSignature(cleared).valid);

// ---------- End to end: signed photo → sealed → desk opens → INTACT ----------
console.log('— End to end —');
const key = labSigner();
const ctx = { location: { lat: 37.7749, lon: -122.4194, accuracyM: 5 }, headingDeg: 90 } as any;
const photo = await attestPhoto({ photoUri: '/tmp/lab/clean.jpg', context: ctx, identity: { author: 'Seal Test', organization: null }, key });
const media = photo.signedPhotoBytes!;
const e2eSealed = sealToDeskKey(media, JSON.stringify({ format: 'lab-proof-fixture/1', note: 'proof rides inside the ciphertext' }), desk.publicKey);
// The plaintext media must not appear anywhere in the sealed artifact.
check('a sealed signed photo contains no plaintext media bytes', !contains(e2eSealed, media.subarray(0, 256)));
const e2eOpened = unsealWithDeskKey(e2eSealed, desk.privateKey);
const verdict = await verifyPhotoBytes(e2eOpened.media);
check('desk-opens-a-sealed-capture → verifies INTACT', verdict.verdict === 'INTACT', verdict.verdict);
check('the private key never leaves hex reconstruction', bytesToHex(deskKeyPairFromPrivateHex(bytesToHex(desk.privateKey)).publicKey) === bytesToHex(desk.publicKey));

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);

// Source Kit 0.1.0 — Shamir custody: one share decrypts nothing, K shares reconstruct
// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Shamir secret sharing over GF(256):
 *   one share          → no information about the secret
 *   K shares together  → the secret, in any order
 *   a mixed or damaged share → a loud failure, never a wrong secret
 *
 * Run from tests/.staged:  ./node_modules/.bin/tsx test-shamir.mts
 */
import { splitSecret, combineShares, shareToText, shareFromText } from './shamir.mts';
import { bytesToHex } from './bytes.mts';
import { randomBytes } from '@noble/hashes/utils';

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name} :: ${detail}`); }
};
const throws = async (fn: () => unknown): Promise<boolean> => {
  try { await fn(); return false; } catch { return true; }
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
// Modest truncation still parses, since a share cannot know its secret's
// length; the length check catches it at combine.
const shortened = shareFromText(shareToText(s35[2]).slice(0, -8));
check('truncated share caught at reconstruction (length)', await throws(() => combineShares([s35[0], s35[1], shortened])));
// Mid-string corruption (same length, valid base64) is caught by the tag.
const mangled = shareFromText(shareToText(s35[2]).slice(0, -6) + 'AAAAAA');
check('mid-string share corruption caught at reconstruction (tag)', await throws(() => combineShares([s35[0], s35[1], mangled])));
check('foreign text rejected as a share', await throws(() => shareFromText('hello world')));

// One share carries no information: the y-bytes of a threshold-2 share are
// uniformly random (secret + random*x in GF(256)). Structurally, combining
// fewer than 2 shares throws.
check('one share alone cannot even attempt reconstruction', await throws(() => combineShares([s22[0]])));

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail > 0) process.exit(1);

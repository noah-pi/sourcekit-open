// Source Kit 0.1.0 — tool: the sample files a release ships
// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Tool: builds the sample files a release ships, and the verdict table that
 * says what each one should do.
 *
 * Every claim on the project page is checkable, and until now checking one
 * meant building the app first. These are four files and a table: a sealed
 * photo, a sealed video, and a single altered byte in each. Anyone can run
 * them through this repository's verifier, or through c2patool, or through
 * Adobe's page, and see whether the answers match what is written down.
 *
 * The failing files matter more than the sealed pair. A file that verifies
 * proves the verifier says yes to something; a file that fails proves it
 * says no. A sample set with only good files demonstrates nothing an empty
 * verifier could not.
 *
 * Two failures, because they are not the same failure. Change the picture
 * and the signature still checks out while the media no longer matches what
 * it covers: CONTENT_MODIFIED, someone edited the photograph. Change the
 * manifest and the signature itself stops verifying: SIGNATURE_INVALID,
 * someone attacked the label. A verifier that collapses those two into one
 * word is telling a reader less than it knows.
 *
 * Run: node tests/stage.mjs && (cd tests/.staged && ./node_modules/.bin/tsx tool-samples.mts)
 * Output: tests/.staged/samples/ — copy into samples/ at the repo root to
 * publish. README.md rather than a bare list, so browsing to the directory
 * on GitHub renders the verdict table without anyone opening a file.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from './bytes.mts';
import { attestPhoto, attestVideo } from './attest.mts';
import { verifyPhotoBytes, verifyVideoBytes } from './verifyAsset.mts';
import { labSigner } from './deviceKey-shim.mts';

const OUT = path.join(process.cwd(), 'samples');
fs.mkdirSync(OUT, { recursive: true });

const key = labSigner();
const ctx = {
  location: { lat: 37.7749, lon: -122.4194, accuracyM: 5 },
  headingDeg: 90, pressureHPa: null, altitudeM: null, motion: null,
} as never;
const identity = { author: 'Source Kit sample', organization: null };

/** One bit deep in the media, well past the manifest: a changed picture. */
function alterMedia(bytes: Uint8Array, label: string): { bytes: Uint8Array; at: number } {
  const at = Math.floor(bytes.length * 0.75);
  const copy = new Uint8Array(bytes);
  copy[at] ^= 0x01; // one bit, the smallest edit that exists
  console.log(`  ${label}: flipped the low bit of byte ${at} of ${bytes.length}`);
  return { bytes: copy, at };
}

/** One bit inside the APP11 segment: a changed label.
 *
 *  Most of that segment is covered by the claim, but not all of it — the
 *  JUMBF framing is malleable by design and documented as such. So this
 *  walks to the first byte whose flip actually breaks the signature, rather
 *  than assuming a byte that happens to be load-bearing.
 *
 *  It starts a quarter of the way in, where the claim and the assertions
 *  sit, and not at the midpoint, where the signature and its timestamp
 *  tokens do. A flip inside a token corrupts DER that c2patool refuses to
 *  parse at all: it exits with an error instead of a verdict, which makes a
 *  poor sample. The point of this file is that a broken signature is
 *  reported as a broken signature. */
async function alterManifest(bytes: Uint8Array): Promise<{ bytes: Uint8Array; at: number }> {
  let segStart = -1;
  for (let i = 2; i < bytes.length - 4; i++) {
    if (bytes[i] === 0xff && bytes[i + 1] === 0xeb) { segStart = i; break; }
  }
  if (segStart < 0) throw new Error('no APP11 segment in the sealed photo');
  const segLen = (bytes[segStart + 2] << 8) | bytes[segStart + 3];
  const segEnd = segStart + 2 + segLen;
  for (let at = segStart + Math.floor((segEnd - segStart) / 4); at < segEnd; at++) {
    const copy = new Uint8Array(bytes);
    copy[at] ^= 0x01;
    if ((await verifyPhotoBytes(copy)).verdict === 'SIGNATURE_INVALID') {
      console.log(`  manifest: flipped the low bit of byte ${at}, inside the APP11 segment`);
      return { bytes: copy, at };
    }
  }
  throw new Error('no byte in the second half of the segment breaks the signature');
}

/** c2patool, when it is here. The point of these files is that an
 *  independent verifier agrees, so what it says is recorded from the tool
 *  rather than asserted from memory: the failure codes differ by container
 *  and by which part of the credential was attacked, and guessing them
 *  wrong would put a wrong claim in the very document that exists to be
 *  checked. Absent, the column says so. */
const C2PATOOL = process.env.C2PATOOL ?? '/tmp/bin/c2patool/c2patool';
const haveC2patool = ((): boolean => {
  try { execFileSync(C2PATOOL, ['--version'], { stdio: 'pipe' }); return true; } catch { return false; }
})();

function c2patoolSays(file: string): string {
  if (!haveC2patool) return 'not checked';
  let out: string;
  try {
    out = execFileSync(C2PATOOL, [path.join(OUT, file)], { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  } catch (e) {
    const err = e as { stdout?: Buffer; stderr?: Buffer };
    out = (err.stdout?.toString() ?? '') || (err.stderr?.toString() ?? '');
  }
  try {
    const parsed = JSON.parse(out) as { validation_results?: Record<string, { failure?: { code?: string }[] }> };
    const codes: string[] = [];
    for (const v of Object.values(parsed.validation_results ?? {})) {
      for (const f of v.failure ?? []) if (f.code) codes.push(f.code);
    }
    return codes.length > 0 ? [...new Set(codes)].join(', ') : 'no failures';
  } catch {
    return `no verdict (${out.split('\n')[0].slice(0, 60)})`;
  }
}

interface Row {
  file: string; sha256: string; bytes: number;
  expect: string; got: string; note: string; foreign: string;
}
const rows: Row[] = [];
const record = (file: string, bytes: Uint8Array, expect: string, got: string, note: string): void => {
  fs.writeFileSync(path.join(OUT, file), bytes);
  rows.push({
    file, sha256: bytesToHex(sha256(bytes)), bytes: bytes.length,
    expect, got, note, foreign: c2patoolSays(file),
  });
};

console.log('— Sealing —');
const photo = await attestPhoto({ photoUri: '/tmp/lab/clean.jpg', context: ctx, identity, key });
const photoBytes = photo.signedPhotoBytes!;
const video = await attestVideo({
  videoUri: '/tmp/lab/clean.mp4', context: ctx, identity, key,
  fetchTimestamp: async () => [],
});
if (!video.signedVideoBytes) { console.log('FATAL: the video embed gate declined'); process.exit(1); }
const videoBytes = video.signedVideoBytes;

console.log('— Altering —');
const photoBad = alterMedia(photoBytes, 'photo');
const videoBad = alterMedia(videoBytes, 'video');
const manifestBad = await alterManifest(photoBytes);

console.log('— Verifying —');
const vPhoto = await verifyPhotoBytes(photoBytes);
const vPhotoBad = await verifyPhotoBytes(photoBad.bytes);
const vVideo = await verifyVideoBytes(videoBytes);
const vVideoBad = await verifyVideoBytes(videoBad.bytes);
const vManifestBad = await verifyPhotoBytes(manifestBad.bytes);

record('sealed-photo.jpg', photoBytes, 'INTACT', vPhoto.verdict,
  'A sealed capture. The signature covers the media bytes and the assertion contents.');
record('altered-photo.jpg', photoBad.bytes, 'CONTENT_MODIFIED', vPhotoBad.verdict,
  `The same file with the low bit of byte ${photoBad.at} flipped — one bit, inside the picture. The signature still verifies; the media no longer matches what it covers.`);
record('sealed-video.mp4', videoBytes, 'INTACT', vVideo.verdict,
  'A sealed video. Same manifest, carried in a C2PA uuid box after ftyp.');
record('altered-video.mp4', videoBad.bytes, 'CONTENT_MODIFIED', vVideoBad.verdict,
  `The same file with the low bit of byte ${videoBad.at} flipped.`);
record('attacked-manifest.jpg', manifestBad.bytes, 'SIGNATURE_INVALID', vManifestBad.verdict,
  `The sealed photo with the low bit of byte ${manifestBad.at} flipped, inside the credential rather than the picture. The claim commits a hash of every assertion, so an edited assertion no longer matches what the claim says it is — the credential contradicts itself. A different failure from an edited picture, and both tools say so in their own vocabulary.`);

const lines: string[] = [];
lines.push('# Sample files', '');
lines.push('Five files and what each one should do. Run them through this');
lines.push("repository's verifier, through `c2patool`, or through Adobe's Content");
lines.push('Credentials page, and compare.', '');
lines.push('| File | This verifier | c2patool 0.14.0 | Bytes |');
lines.push('|---|---|---|---|');
for (const r of rows) {
  lines.push(`| \`${r.file}\` | ${r.expect} | \`${r.foreign}\` | ${r.bytes.toLocaleString('en-US')} |`);
}
lines.push('');
lines.push('These hashes are of the files in this release, not of a');
lines.push('reproducible build. Regenerating them produces different bytes: an');
lines.push('ECDSA signature varies in DER length run to run, and a capture');
lines.push('carries the time it was made. The hashes are here so you can tell');
lines.push('whether the file you downloaded is the file that was published.', '');
lines.push('| File | SHA-256 |');
lines.push('|---|---|');
for (const r of rows) lines.push(`| \`${r.file}\` | \`${r.sha256}\` |`);
lines.push('');
for (const r of rows) lines.push(`**\`${r.file}\`** — ${r.note}`, '');
lines.push('## What another C2PA tool will say', '');
lines.push('The signing certificate is self-signed by the device. No authority on');
lines.push('the C2PA conformance list issued it, so every third-party verifier');
lines.push('reports the signer as untrusted while confirming the signature and the');
lines.push('media binding. That is the expected result, not a failure: it is a');
lines.push('statement about *who* signed, never about *whether* the signature held.', '');
lines.push('The failure codes in the table above are what c2patool actually');
lines.push('printed when these files were built, not what anyone expected it to');
lines.push('print. They differ by container and by which part of the credential');
lines.push('was attacked, and that is the useful part: a JPEG whose picture');
lines.push('changed, a video whose picture changed, and a credential that was');
lines.push('edited are three different findings, not one.', '');

const mismatches = rows.filter((r) => r.expect !== r.got);
fs.writeFileSync(path.join(OUT, 'README.md'), lines.join('\n'));
fs.writeFileSync(path.join(OUT, 'verdicts.json'), JSON.stringify(rows, null, 2) + '\n');

console.log('');
for (const r of rows) {
  console.log(`  ${r.expect === r.got ? 'ok  ' : 'FAIL'} ${r.file.padEnd(20)} expected ${r.expect}, got ${r.got}`);
}
console.log(`\nwrote ${rows.length} files + README.md to ${OUT}`);
if (mismatches.length > 0) {
  console.log(`\n${mismatches.length} file(s) did not do what the table says. Not shippable.`);
  process.exit(1);
}

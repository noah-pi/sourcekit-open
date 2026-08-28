// Source Kit 0.1.0 — the capture-evidence digests
// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * The sidecars are bound to the record by digest, so this suite checks the
 * three properties the binding rests on:
 *
 *   1. A file's digest is SHA-256 over its bytes — the same number any
 *      other tool prints for the same file.
 *   2. A directory's digest is stable across listing order and changes when
 *      any frame changes. Order is the interesting one: readDirectoryAsync
 *      makes no promise, and an order-dependent digest would disagree
 *      between two readers holding identical frames.
 *   3. A stated absence stays absent. 'never-recorded' is a claim about the
 *      capture, not a missing file, and it must never acquire a digest.
 */

import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { digestFile, digestDirectory, digestCaptureEvidence } from './evidenceDigest.mts';

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

const ROOT = '/tmp/lab/fs/evidence';
fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(`${ROOT}/ring`, { recursive: true });

const pcm = Buffer.from('raw lpcm master bytes');
fs.writeFileSync(`${ROOT}/master.caf`, pcm);
fs.writeFileSync(`${ROOT}/sensors.ndjson`, '{"t":0}\n{"t":1}\n');
fs.writeFileSync(`${ROOT}/ring/002.jpg`, 'frame two');
fs.writeFileSync(`${ROOT}/ring/001.jpg`, 'frame one');

console.log('\nEvidence digests\n');

// 1. A file digest is plain SHA-256 over the bytes.
const expected = createHash('sha256').update(pcm).digest('hex');
const got = await digestFile(`${ROOT}/master.caf`);
check('file digest matches node crypto', got === expected, `${got} vs ${expected}`);

// 2. Directory digests are order independent and content sensitive.
const dirA = await digestDirectory(`${ROOT}/ring`);
check('directory digest is produced', typeof dirA === 'string' && dirA.length === 64);

// Rewriting the same frames in the opposite order changes readdir order on
// some filesystems and must not change the digest.
fs.rmSync(`${ROOT}/ring`, { recursive: true, force: true });
fs.mkdirSync(`${ROOT}/ring`);
fs.writeFileSync(`${ROOT}/ring/001.jpg`, 'frame one');
fs.writeFileSync(`${ROOT}/ring/002.jpg`, 'frame two');
const dirB = await digestDirectory(`${ROOT}/ring`);
check('directory digest is order independent', dirA === dirB, `${dirA} vs ${dirB}`);

fs.writeFileSync(`${ROOT}/ring/002.jpg`, 'frame two, altered');
const dirC = await digestDirectory(`${ROOT}/ring`);
check('a changed frame changes the digest', dirC !== null && dirC !== dirB);

// A renamed frame changes it too: the name is hashed alongside the bytes.
fs.renameSync(`${ROOT}/ring/002.jpg`, `${ROOT}/ring/003.jpg`);
const dirD = await digestDirectory(`${ROOT}/ring`);
check('a renamed frame changes the digest', dirD !== null && dirD !== dirC);

// 3. Absences, missing files and empty directories all report null.
check('never-recorded has no digest', (await digestFile('never-recorded')) === null);
check('undefined has no digest', (await digestFile(undefined)) === null);
check('a missing file yields null, not a throw', (await digestFile(`${ROOT}/gone.caf`)) === null);
fs.mkdirSync(`${ROOT}/empty`, { recursive: true });
check('an empty directory yields null', (await digestDirectory(`${ROOT}/empty`)) === null);
check('never-recorded directory has no digest', (await digestDirectory('never-recorded')) === null);

// The whole block, as attest.ts builds it before signing.
const evidence = await digestCaptureEvidence({
  rawPcmPath: `${ROOT}/master.caf`,
  sensorLogPath: `${ROOT}/sensors.ndjson`,
  ringBufferDir: 'never-recorded',
});
check('block digests the raw master', evidence?.rawPcmSha256 === expected);
check('block digests the sensor log', typeof evidence?.sensorLogSha256 === 'string');
check('block leaves a stated absence null', evidence?.ringBufferSha256 === null);
check('block preserves the paths', evidence?.rawPcmPath === `${ROOT}/master.caf`);
check('a null block stays null', (await digestCaptureEvidence(null)) === null);

// Every sink unreadable is a valid capture, not a failed one.
const allGone = await digestCaptureEvidence({
  rawPcmPath: `${ROOT}/gone.caf`,
  sensorLogPath: 'never-recorded',
  ringBufferDir: `${ROOT}/gone`,
});
check('unreadable sinks report null rather than throwing',
  allGone?.rawPcmSha256 === null && allGone?.sensorLogSha256 === null && allGone?.ringBufferSha256 === null);

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);

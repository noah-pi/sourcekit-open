// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Reference corpus validation.
 *
 * Runs our verifier against tests/corpus/ and demands the expected verdicts
 * from expected-verdicts.json. The corpus is rebuilt by build-corpus.mts;
 * this runner is the CI gate — and the oracle for engine swaps: results
 * must be identical before and after.
 *
 * Run from tests/.staged:  ./node_modules/.bin/tsx test-corpus.mts
 */
import * as fs from 'node:fs';
import { verifyPhotoBytes, verifyVideoBytes } from './verifyAsset.mts';
const verifyPhoto = (path: string) => verifyPhotoBytes(new Uint8Array(fs.readFileSync(path)));
const verifyVideo = (path: string) => verifyVideoBytes(new Uint8Array(fs.readFileSync(path)));
import { attestVideo } from './attest.mts';
import { labSigner } from './deviceKey-shim.mts';

const CORPUS = new URL('../corpus/', import.meta.url).pathname;
const manifest = JSON.parse(fs.readFileSync(CORPUS + 'expected-verdicts.json', 'utf8'));

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name} :: ${detail}`); }
};

console.log('— reference corpus —');
for (const entry of manifest.files) {
  const path = CORPUS + entry.file;
  if (!fs.existsSync(path)) { check(`${entry.file} exists`, false, 'missing — run build-corpus.mts'); continue; }
  let report;
  try {
    report = await verifyPhoto(path);
  } catch (e) {
    check(`${entry.file} [${entry.category}]`, false, `verifier threw: ${e instanceof Error ? e.message : e}`);
    continue;
  }
  const bits: string[] = [];
  let ok = report.verdict === entry.expect.verdict;
  if (!ok) bits.push(`verdict ${report.verdict} ≠ ${entry.expect.verdict}`);
  if (entry.expect.assetHashMatches !== undefined && report.checks.assetHashMatches !== entry.expect.assetHashMatches) {
    ok = false; bits.push(`assetHashMatches ${report.checks.assetHashMatches}`);
  }
  if (entry.expect.signatureValid !== undefined && report.checks.signatureValid !== entry.expect.signatureValid) {
    ok = false; bits.push(`signatureValid ${report.checks.signatureValid}`);
  }
  check(`${entry.file} [${entry.category}] → ${entry.expect.verdict}`, ok, bits.join('; '));
}

// Capture-integrity signals ride in the signed record.
{
  const report = await verifyPhoto(CORPUS + 'signed-valid.jpg');
  const ci = report.record?.captureIntegrity;
  check('captureIntegrity present and self-reported on signed captures',
    !!ci && ci.note === 'self-reported' && typeof ci.captureToSignatureMs === 'number' && ci.captureToSignatureMs >= 0);
}
{
  // The signed pose trace (gyro evidence): it rides the signed record and
  // the sealed video still verifies INTACT.
  const ctx = {
    location: 'unavailable', headingDeg: null, pressureHPa: null, altitudeM: null,
    motion: { verdict: 'handheld', rms: 0.03, peakHz: 4 },
    sensorTiming: { samples: 100, intervalCv: 0.12 },
    poseTrace: {
      hz: 20, anchor: 5, samples: 12,
      rotRate: Array.from({ length: 36 }, (_, i) => (i % 7) - 3),
      attitude: Array.from({ length: 36 }, () => 450),
      accel: Array.from({ length: 36 }, () => 2),
    },
  };
  const signer = labSigner();
  let payloadSigs = 0;
  let digestSigs = 0;
  const counted = {
    ...signer,
    signDigest: async (d: Uint8Array) => { digestSigs++; return signer.signDigest(d); },
    signPayload: async (p: Uint8Array) => { payloadSigs++; return signer.signPayload(p); },
  };
  const { signedVideoBytes, record } = await attestVideo({
    videoUri: new URL('./clean.mp4', import.meta.url).pathname,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    context: ctx as any, identity: 'redacted', key: counted,
  });
  check('pose trace signs into the record',
    record.context?.poseTrace?.samples === 12 && record.captureIntegrity?.sensorTiming?.samples === 100);
  // The BMFF hash fixpoint sizes with a dummy signature and signs ONCE
  // on the converged round — record + claim = exactly two signatures per
  // video, regardless of how many rounds the fixpoint runs.
  // The corpus suite stages the REAL network TSA client, so token bytes can drift between a
  // sizing probe and the real fetch; drift forces one extra CONVERGED round (each converged round
  // signs exactly once — sizing rounds never sign). The strict "exactly one claim signature" pin
  // lives in test-roundtrip with deterministic mock TSAs. Here we pin the core invariants: the
  // record signature plus at least one claim signature, all via the one-hop payload path, and
  // NEVER a digest-path call.
  check('video sealing signs only via the one-hop payload path (record + claim rounds), never per sizing round',
    payloadSigs >= 2 && digestSigs === 0, `payload=${payloadSigs} digest=${digestSigs}`);
  if (signedVideoBytes) {
    const tmp = new URL('./.posetrace-check.mp4', import.meta.url).pathname;
    fs.writeFileSync(tmp, signedVideoBytes);
    const v = await verifyVideo(tmp);
    check('sealed trace-carrying video verifies INTACT', v.verdict === 'INTACT', `verdict ${v.verdict}`);
    const vReport = await verifyVideo(tmp);
    check('verifier surfaces the pose trace as signed evidence',
      vReport.checksPerformed.some((s) => s.includes('pose trace')));
    fs.rmSync(tmp, { force: true });
  } else {
    check('sealed trace-carrying video verifies INTACT', false, 'attestVideo returned no bytes');
    check('verifier surfaces the pose trace as signed evidence', false, 'attestVideo returned no bytes');
  }
}

console.log('\n— two-verifier conformance —');
// Desk and the app share this verifier. Conformance means: every corpus file
// yields the SAME verdict through the routing both sides use (magic bytes —
// JPEG/PNG → photo verifier, 'ftyp'@4 → video verifier), the un-routed
// verifier refuses cleanly with its NOT_* code, and repeated runs are
// byte-identical — no hidden nondeterminism that could make two verifiers
// disagree on the same file.
for (const entry of manifest.files) {
  const bytes = new Uint8Array(fs.readFileSync(CORPUS + entry.file));
  const photoRoute =
    (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) ||
    (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47);
  const videoRoute = bytes.length > 12 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70;
  check(`${entry.file}: exactly one container route claims it`, photoRoute !== videoRoute);
  const run = () => (photoRoute ? verifyPhotoBytes(bytes) : verifyVideoBytes(bytes));
  const first = await run();
  const second = await run();
  check(`${entry.file}: verdict + checks are byte-identical across runs`,
    first.verdict === second.verdict && JSON.stringify(first.checks) === JSON.stringify(second.checks));
  const cross = photoRoute ? await verifyVideoBytes(bytes) : await verifyPhotoBytes(bytes);
  check(`${entry.file}: the other verifier refuses cleanly (${photoRoute ? 'NOT_BMFF' : 'NOT_JPEG'})`,
    cross.verdict === (photoRoute ? 'NOT_BMFF' : 'NOT_JPEG'), `got ${cross.verdict}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
console.log('CORPUS VERDICTS MATCH EXPECTATIONS');

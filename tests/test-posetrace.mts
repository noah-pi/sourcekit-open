// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * The signed poseTrace commitment.
 *
 *   - 100 Hz gyro JSONL commits under a Merkle root (disclosure tree builder);
 *   - the assertion round-trips through a real seal and verifies against the
 *     exported trace;
 *   - one altered sample line breaks the root, named;
 *   - gyroPriorAuthenticated is locked false (self-reported);
 *   - no gyro samples means no assertion;
 *   - a truncated tail line is skipped and counted;
 *   - the audio recorder's IMU log (anchor line + mach-ticks gyro lines)
 *     commits and verifies through the identical math.
 *
 * Run from tests/.staged:  ./node_modules/.bin/tsx test-posetrace.mts
 */
import {
  buildPoseTraceAssertion,
  nominalHz,
  parseGyroJsonl,
  poseTraceLeafDigest,
  verifyPoseTraceAssertion,
} from './poseTrace.mts';
import { fileURLToPath } from 'node:url';
import { buildTree } from './disclosure-tree.mts';
import { attestPhoto } from './attest.mts';
import { extractC2paStore, parseManifest } from './c2pa.mts';
import { labSigner } from './deviceKey-shim.mts';
import { bytesToHex } from './bytes.mts';
import type { PoseTraceAssertion } from './manifest.mts';

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name} :: ${detail}`); }
};
const section = (t: string) => console.log(`\n— ${t} —`);

// stage.mjs copies this suite into tests/.staged, so the staged dir is this
// file's own directory. VERIFY_STAGED_DIR overrides it when running the
// un-staged source against a lab staged elsewhere.
const STAGED = process.env.VERIFY_STAGED_DIR ?? fileURLToPath(new URL('.', import.meta.url));

function gyroJsonl(n: number, hz = 100): string {
  const dt = 1 / hz;
  const lines: string[] = [];
  for (let i = 0; i < n; i++) {
    lines.push(`{"t":${(i * dt).toFixed(3)},"kind":"gyro","x":${(i * 0.0001).toFixed(6)},"y":-0.002,"z":0.003}`);
  }
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
section('commit + verify');

{
  const trace = gyroJsonl(300);
  const a = buildPoseTraceAssertion(trace)!;
  check('assertion built', !!a);
  check('300 samples committed', a.sampleCount === 300);
  check('hz derived from the trace intervals', a.hz === 100, String(a.hz));
  check('gyroPriorAuthenticated locked false', a.gyroPriorAuthenticated === false);
  check('the note names self-reporting', a.note.includes('self-reported') && a.note.includes('not a verdict'));
  const v = verifyPoseTraceAssertion(a, trace);
  check('the trace verifies against its commitment', v.ok, JSON.stringify(v.failures));

  // The root is the disclosure-tree root over the per-line leaves, so the
  // desk recomputes it from the exported JSONL without canonical-JSON.
  const { gyro } = parseGyroJsonl(trace);
  const tree = buildTree(gyro.map((g) => poseTraceLeafDigest(g.line)));
  check('root = Merkle root over the exact line bytes', tree.root === a.root);
}

// ---------------------------------------------------------------------------
section('one altered line breaks the commitment, named');

{
  const trace = gyroJsonl(120);
  const a = buildPoseTraceAssertion(trace)!;
  const altered = trace.replace('"z":0.003}', '"z":0.004}');
  check('the fixture actually changed', altered !== trace);
  const v = verifyPoseTraceAssertion(a, altered);
  check('altered sample is caught', !v.ok && v.failures.some((f) => f.includes('root mismatch')), JSON.stringify(v.failures));

  const forged: PoseTraceAssertion = { ...a, gyroPriorAuthenticated: true as never };
  const vf = verifyPoseTraceAssertion(forged, trace);
  check('gyroPriorAuthenticated cannot be flipped true', !vf.ok && vf.failures.some((f) => f.includes('declared false')));

  const fewer = verifyPoseTraceAssertion(a, gyroJsonl(119));
  check('a dropped sample line is caught by count', !fewer.ok && fewer.failures.some((f) => f.includes('sampleCount')));
}

// ---------------------------------------------------------------------------
section('hz derivation edge cases');

{
  check('two samples → nominal 100 Hz (stated, not measured)', nominalHz(parseGyroJsonl(gyroJsonl(2)).gyro) === 100);
  const hz50 = gyroJsonl(60, 50);
  check('50 Hz trace derives 50', buildPoseTraceAssertion(hz50)!.hz === 50, String(buildPoseTraceAssertion(hz50)!.hz));
}

// ---------------------------------------------------------------------------
section('honest absence + malformed tails');

{
  check('no gyro samples → no assertion (absence, never empty commitment)',
    buildPoseTraceAssertion('{"t":0.01,"kind":"accel","x":0,"y":0,"z":1}\n') === null);
  check('empty document → no assertion', buildPoseTraceAssertion('') === null);
  const withTail = gyroJsonl(10) + '{"t":0.11,"kind":"gyro","x":';
  const { gyro, skippedLines } = parseGyroJsonl(withTail);
  check('truncated tail line skipped AND counted', gyro.length === 10 && skippedLines === 1, `${gyro.length}/${skippedLines}`);
  const a = buildPoseTraceAssertion(withTail)!;
  check('a trace with a truncated tail still commits (10 real samples)', a.sampleCount === 10);
}

// ---------------------------------------------------------------------------
section('round-trip through a real seal');

{
  const key = labSigner();
  const trace = gyroJsonl(200);
  const r = await attestPhoto({
    photoUri: `${STAGED}/clean.jpg`,
    context: { location: null } as any,
    identity: 'redacted',
    key,
    sensorLogText: trace,
  });
  const m = parseManifest(extractC2paStore(r.signedPhotoBytes!)!.payload)!;
  const a = m.customAssertions['com.verify.poseTrace']?.data as PoseTraceAssertion;
  check('sealed manifest carries com.verify.poseTrace', a?.v === 1 && a.sampleCount === 200);
  const v = verifyPoseTraceAssertion(a, trace);
  check('the exported trace verifies against the sealed root', v.ok, JSON.stringify(v.failures));
  check('the sealed root equals the direct build', a.root === buildPoseTraceAssertion(trace)!.root);
  const noLog = await attestPhoto({
    photoUri: `${STAGED}/clean.jpg`,
    context: { location: null } as any,
    identity: 'redacted',
    key: labSigner(),
  });
  const mNoLog = parseManifest(extractC2paStore(noLog.signedPhotoBytes!)!.payload)!;
  check('no poseTrace without a sensor log (honest absence)',
    mNoLog.customAssertions['com.verify.poseTrace'] === undefined);
}

// ---------------------------------------------------------------------------
section('audio-recorder format (modules/audio-capture AudioMotionLog)');

// The audio IMU sink writes the same CaptureKit SensorLogger JSONL the video
// side emits: an anchor line first, then gyro lines carrying a mach-ticks
// field and boot-relative seconds at 9 decimal places. The commitment math
// must consume it unchanged.
function audioGyroJsonl(n: number): string {
  const lines: string[] = [
    '{"kind":"anchor","startedAtMs":1754530000000,"machAtAnchor":123456789,"bootSecAtAnchor":5142.5}',
  ];
  for (let i = 0; i < n; i++) {
    lines.push(
      `{"t":${(5142.5 + i * 0.01).toFixed(9)},"mach":${123456789 + i * 24000},"kind":"gyro","x":${(i * 0.0001).toFixed(6)},"y":-0.002,"z":0.003}`,
    );
  }
  return lines.join('\n') + '\n';
}

{
  const trace = audioGyroJsonl(500);
  const { gyro, skippedLines } = parseGyroJsonl(trace);
  check('anchor line is neither a sample nor a skip', gyro.length === 500 && skippedLines === 0, `${gyro.length}/${skippedLines}`);
  const a = buildPoseTraceAssertion(trace)!;
  check('audio-format log commits', !!a && a.sampleCount === 500);
  check('hz measured from the trace intervals (100 Hz target stated as measured)',
    a.hz === 100, String(a.hz));
  check('gyroPriorAuthenticated locked false on the audio path too', a.gyroPriorAuthenticated === false);
  const v = verifyPoseTraceAssertion(a, trace);
  check('audio-format trace verifies against its commitment', v.ok, JSON.stringify(v.failures));

  const tampered = trace.replace('"z":0.003}', '"z":0.004}');
  check('one-digit tamper breaks the root', tampered !== trace
    && !verifyPoseTraceAssertion(a, tampered).ok);

  const anchorOnly = '{"kind":"anchor","startedAtMs":1754530000000,"machAtAnchor":123456789,"bootSecAtAnchor":5142.5}\n';
  check('anchor-only log (zero gyro samples) → no assertion', buildPoseTraceAssertion(anchorOnly) === null);

  const degraded = audioGyroJsonl(20)
    + '{"kind":"sinkFailed","error":"FileHandle write threw"}\n'
    + '{"t":5143.0,"kind":"gyro","x":';
  const pd = parseGyroJsonl(degraded);
  check('sink-failed marker parses as a non-gyro line; corrupt tail skipped AND counted',
    pd.gyro.length === 20 && pd.skippedLines === 1, `${pd.gyro.length}/${pd.skippedLines}`);
  const ad = buildPoseTraceAssertion(degraded)!;
  check('degraded log still commits its 20 real samples', ad.sampleCount === 20);
  check('degraded log verifies', verifyPoseTraceAssertion(ad, degraded).ok);
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);

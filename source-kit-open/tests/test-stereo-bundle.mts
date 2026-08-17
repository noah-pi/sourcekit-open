// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Stereo-artifact bundle suite — end to end through the REAL seal pipeline.
 *
 * A synthetic stereo capture (fixture JPEGs + calibration/timestamps/metadata
 * JSON, all generated in-test with known geometry) is committed via
 * src/provenance/stereoArtifacts.ts, sealed through attestPhoto (the
 * context.stereo-* claims ride the REAL com.verify.contextTree manifest
 * assertion), exported as an 'exhibit-proof-bundle/2' proof bundle, and read
 * back through the desk path (desk/cli/stereoVerify.ts). Checked:
 *
 *   (a) artifact hashes match the committed values (bundle section AND
 *       context-tree claim values), and the manifest's contextTree carries
 *       the five stereo entries;
 *   (b) never-recorded declarations appear in the inventory meta-leaf —
 *       the entries list whose digest rides at tree index 0 (audit A-01);
 *   (c) a tampered secondary frame fails CLOSED as PROVEN TAMPER — red-class,
 *       distinct from absence (the never-recorded DNG stays gray next to it);
 *   (d) an old-format ('exhibit-proof-bundle/1') bundle is rejected at the
 *       format gate with the versions named — no migration, no legacy reader;
 *   (e) a null-with-error artifact surfaces its committed error string, and
 *       the planarity signal runs on the clean bundle with the signal text
 *       printed VERBATIM (bounds included).
 *
 * Run (staged lab): node stage.mjs && cd .staged && npm install --no-audit --no-fund
 *   && ./node_modules/.bin/tsx test-stereo-bundle.mts
 */
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sha256 } from '@noble/hashes/sha256';
import { randomBytes } from '@noble/hashes/utils';
import {
  commitStereoArtifacts,
  buildStereoCommitment,
  checkStereoSectionIntegrity,
  isStereoBundleSection,
  STEREO_ARTIFACT_IDS,
  STEREO_CLAIM_IDS,
  utf8ToBytes,
  type StereoCaptureArtifacts,
} from './stereoArtifacts.mts';
import {
  buildProofBundle,
  isProofBundle,
  proofBundleGate,
  PROOF_BUNDLE_FORMAT,
} from './proofBundle.mts';
import { commitCaptureEvidence } from './disclosure-captureCommit.mts';
import { inventoryDigest } from './disclosure-inventory.mts';
import { verifyBundle } from './disclosure-bundle.mts';
import { attestPhoto } from './attest.mts';
import { extractC2paStore, parseManifest } from './c2pa.mts';
import { labSigner } from './deviceKey-shim.mts';
import { base64ToBytes, bytesToBase64, bytesToHex } from './bytes.mts';
import { verifyStereoCommitment, type Correspondence } from './index.mts';
import { analyzeStereoBundle } from './stereoVerify.mts';

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name} :: ${detail}`); }
};
const section = (t: string) => console.log(`\n— ${t} —`);

const STAGED = process.env.VERIFY_STAGED_DIR ?? fileURLToPath(new URL('.', import.meta.url));

// ---------------------------------------------------------------------------
// Synthetic rig — the SAME wide ↔ ultra-wide geometry as the planarity suite.
// ---------------------------------------------------------------------------

const WIDE = { fx: 1100, fy: 1100, cx: 640, cy: 480, width: 1280, height: 960 };
const UW = { fx: 560, fy: 560, cx: 320, cy: 240, width: 640, height: 480 };
const IDENTITY3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const BASELINE_T: [number, number, number] = [-0.012, 0, 0];

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Correspondences for a TRUE PLANE at 1 m (known geometry, no noise). */
function planarCorrespondences(): Correspondence[] {
  const rnd = mulberry32(11);
  const out: Correspondence[] = [];
  for (let i = 0; i < 40; i++) {
    const Z = 1.0;
    const X = (rnd() * 2 - 1) * 0.4 * Z;
    const Y = (rnd() * 2 - 1) * 0.4 * Z;
    out.push({
      primary: [WIDE.fx * (X / Z) + WIDE.cx, WIDE.fy * (Y / Z) + WIDE.cy],
      secondary: [UW.fx * ((X + BASELINE_T[0]) / Z) + UW.cx, UW.fy * (Y / Z) + UW.cy],
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Fixture artifacts — the native module's per-capture payload, synthesized.
// ---------------------------------------------------------------------------

const primaryBytes = new Uint8Array(fs.readFileSync(`${STAGED}/clean.jpg`));
const secondaryBytes = new Uint8Array(fs.readFileSync(`${STAGED}/other.jpg`));
const primarySha256 = bytesToHex(sha256(primaryBytes));

const CALIBRATION_JSON = JSON.stringify({
  calibrationSource: 'avcamera-calibration-data',
  intrinsicsWide: WIDE,
  intrinsicsUltraWide: UW,
  extrinsics: { rotation: IDENTITY3, translationM: BASELINE_T, baselineMeters: 0.012 },
});
const TIMESTAMPS_JSON = JSON.stringify({
  primaryPtsSeconds: 412345.678,
  secondaryPtsSeconds: 412345.6781,
  wallClockAnchorIso: '2026-08-06T10:20:30.123Z',
  synchronizedDeltaMs: 0.1,
});
const METADATA_JSON = JSON.stringify({
  controlsReportedBy: 'device',
  focusDistanceMeters: null, // null by construction — iOS exposes no focus-distance API
  focalLengthMm: 4.25,
  apertureFNumber: 1.8,
  exposureDurationSec: 1 / 120,
  iso: 100,
  physicalDevice: 'wide',
  antiBanding: '60Hz (region-derived)',
  lensPosition: 0.5,
  platformProcessing: 'apple-default-pipeline',
  hardwareCost: 0.6,
  synchronizedDeltaMs: 0.1,
});

function makeArtifacts(overrides: Partial<StereoCaptureArtifacts> = {}): StereoCaptureArtifacts {
  return {
    secondaryFrame: { path: '/evidence/secondary-1.jpg', bytes: secondaryBytes },
    calibration: { path: '/evidence/calibration-1.json', bytes: utf8ToBytes(CALIBRATION_JSON) },
    timestamps: { path: '/evidence/timestamps-1.json', bytes: utf8ToBytes(TIMESTAMPS_JSON) },
    metadata: { path: '/evidence/metadata-1.json', bytes: utf8ToBytes(METADATA_JSON) },
    rawDng: { path: 'never-recorded', reason: 'raw-unsupported' },
    ...overrides,
  };
}

const CAPTURE_INPUT = {
  capturedAt: '2026-08-06T10:20:30.123Z',
  location: { lat: 37.7749, lon: -122.4194 } as const,
  identity: { author: 'Rana', organization: null } as const,
  fingerprint: 'ab'.repeat(32),
  sensorLogRecorded: false,
};

// ---------------------------------------------------------------------------
section('(a) commit: hashes match, bundle section well-formed, claims carry the states');
// ---------------------------------------------------------------------------

const committed = commitStereoArtifacts(makeArtifacts(), primarySha256);
const secondarySha256 = bytesToHex(sha256(secondaryBytes));

check('(a) every artifact accounted for in the bundle section (no silent absence)',
  STEREO_ARTIFACT_IDS.every((id) => committed.section.artifacts[id] !== undefined));
check('(a) secondary frame hash matches the committed value',
  committed.section.artifacts.secondaryFrame.sha256 === secondarySha256,
  `${committed.section.artifacts.secondaryFrame.sha256} vs ${secondarySha256}`);
check('(a) JSON artifacts hash to their fixture bytes',
  committed.section.artifacts.calibration.sha256 === bytesToHex(sha256(utf8ToBytes(CALIBRATION_JSON))) &&
  committed.section.artifacts.timestamps.sha256 === bytesToHex(sha256(utf8ToBytes(TIMESTAMPS_JSON))) &&
  committed.section.artifacts.metadata.sha256 === bytesToHex(sha256(utf8ToBytes(METADATA_JSON))));
check('(a) secondary + JSON artifacts ride the bundle inline; the DNG is hash-only (stated)',
  typeof committed.section.artifacts.secondaryFrame.dataBase64 === 'string' &&
  typeof committed.section.artifacts.calibration.dataBase64 === 'string' &&
  committed.section.artifacts.rawDng.dataBase64 === undefined &&
  committed.section.artifacts.rawDng.state === 'never-recorded');
check('(a) context claims carry the three states as committed VALUES',
  committed.contextClaims.find((c) => c.claimId === STEREO_CLAIM_IDS.secondaryFrame)?.value === `sha256:${secondarySha256}` &&
  committed.contextClaims.find((c) => c.claimId === STEREO_CLAIM_IDS.rawDng)?.value === 'never-recorded:raw-unsupported');
check('(a) the section passes its own guard after a JSON round-trip',
  isStereoBundleSection(JSON.parse(JSON.stringify(committed.section))));

// Contract violations throw — a capture that cannot state a state must not commit.
{
  let threw = '';
  try { commitStereoArtifacts(makeArtifacts({ secondaryFrame: { path: '/evidence/x.jpg' } }), primarySha256); }
  catch (e) { threw = (e as Error).message; }
  check('(a) recorded path without bytes refuses to commit', threw.includes('no bytes') || threw.includes('carries no bytes'), threw);
  threw = '';
  try { commitStereoArtifacts(makeArtifacts({ calibration: { path: null } }), primarySha256); }
  catch (e) { threw = (e as Error).message; }
  check('(a) null-without-error refuses to commit (the failure must be stated)', threw.includes('error string'), threw);
}

// ---------------------------------------------------------------------------
section('(b) seal: the inventory meta-leaf binds the never-recorded declaration');
// ---------------------------------------------------------------------------

{
  const seed = randomBytes(32);
  const { committed: ctx } = commitCaptureEvidence(seed, { ...CAPTURE_INPUT, stereoClaims: committed.contextClaims });
  const entries = ctx.inventoryAssertion.entries;
  const metaLeaf = bytesToHex(ctx.tree.layers[0][0]);
  check('(b) all five stereo entries appear in the inventory assertion',
    STEREO_ARTIFACT_IDS.every((id) => entries.some((e) => e.claimId === STEREO_CLAIM_IDS[id])),
    JSON.stringify(entries.filter((e) => e.claimId.startsWith('context.stereo-'))));
  check('(b) the inventory meta-leaf at tree index 0 digests those entries (A-01 binding)',
    metaLeaf === bytesToHex(inventoryDigest(entries)));
  check('(b) the never-recorded declaration is a committed leaf value, bound by the root',
    ctx.leaves.find((c) => c.claimId === STEREO_CLAIM_IDS.rawDng)?.value === 'never-recorded:raw-unsupported' &&
    ctx.inventoryAssertion.root === ctx.tree.root);
  // Rewriting the declaration after the fact breaks the meta-leaf — the
  // A-01 property the never-recorded binding exists for.
  const doctored = entries.map((e) => e.claimId === STEREO_CLAIM_IDS.rawDng ? { ...e, state: 'never-recorded' as const } : e);
  check('(b) a retroactive reclassification changes the meta-leaf digest',
    bytesToHex(inventoryDigest(doctored)) !== metaLeaf);
}

// ---------------------------------------------------------------------------
section('seal through the real pipeline: attestPhoto → manifest → proof bundle → desk');
// ---------------------------------------------------------------------------

const key = labSigner();
const sealed = await attestPhoto({
  photoUri: `${STAGED}/clean.jpg`,
  context: { location: { lat: 37.7749, lon: -122.4194, accuracyM: 5 } } as any,
  identity: { author: 'Rana', organization: null },
  key,
  capturedAt: '2026-08-06T10:20:30.123Z',
  stereoClaims: committed.contextClaims,
});

const store = extractC2paStore(sealed.signedPhotoBytes!)!;
const manifest = parseManifest(store.payload)!;
const contextTree = manifest.customAssertions['com.verify.contextTree']?.data as any;
check('seal: the manifest contextTree carries the five stereo entries (19 fixed + 5 stereo)',
  contextTree?.entries?.length === 24 &&
  STEREO_ARTIFACT_IDS.every((id) => contextTree.entries.some((e: any) => e.claimId === STEREO_CLAIM_IDS[id])),
  `entries=${contextTree?.entries?.length}`);
check('seal: the disclosure claims carry the stereo states',
  sealed.disclosure!.claims.some((c) => c.claimId === STEREO_CLAIM_IDS.secondaryFrame && c.value === `sha256:${secondarySha256}`));
check('seal: the Sealed-profile bundle verifies against the manifest root',
  verifyBundle(sealed.disclosure!.sealedBundle, contextTree.root, contextTree).ok);
check('seal: the section pairs with the sealed delivery file',
  committed.section.primaryFrameSha256 === sealed.record.asset.sha256,
  `${committed.section.primaryFrameSha256} vs ${sealed.record.asset.sha256}`);

const bundle = buildProofBundle(sealed.record, bytesToBase64(store.payload), null, committed.section);
const bundleJson = JSON.parse(JSON.stringify(bundle));
check(`bundle: format is ${PROOF_BUNDLE_FORMAT}`, bundleJson.format === 'exhibit-proof-bundle/2', bundleJson.format);
check('bundle: passes the format gate after a JSON round-trip',
  proofBundleGate(bundleJson).ok && isProofBundle(bundleJson));

// The desk readback, clean bundle + known-geometry correspondences.
const corrs = planarCorrespondences();
const clean = analyzeStereoBundle(bundleJson, corrs);
check('desk: the clean bundle takes the planarity path', clean.planarityPath === 'clean', clean.planarityPath);
check('desk: every recorded artifact hashes to its committed value',
  clean.artifacts!.filter((a) => a.state === 'recorded').every((a) => a.integrity === 'hash-match'),
  JSON.stringify(clean.artifacts!.map((a) => [a.id, a.integrity])));
check('desk: the never-recorded DNG is printed as an unreached state (never red)',
  clean.artifacts!.find((a) => a.id === 'rawDng')!.line.includes('never-recorded (reason: raw-unsupported)') &&
  clean.artifacts!.find((a) => a.id === 'rawDng')!.line.includes('never suspicion'));
check('desk: the planarity signal is planar at 1 m (known geometry)',
  clean.signal?.state === 'planar', `${clean.signal?.state} residual=${clean.signal?.residualPx}`);
check('desk: the signal text prints VERBATIM, bounds included',
  clean.lines.some((l) => l === clean.signal!.text) &&
  clean.signal!.text.includes('Effective within roughly three meters') &&
  clean.signal!.text.includes('not a verdict'));
check('desk: no line says "passed" or "authentic"',
  !clean.lines.some((l) => /\bpassed\b|\bauthentic\b/i.test(l)),
  clean.lines.filter((l) => /\bpassed\b|\bauthentic/i.test(l)).join(' | '));

// Shape conformance, behaviorally: the app-side builder's output feeds the
// REAL desk verifier directly (desk/stereo/types.ts is the canonical type).
{
  const commitment = buildStereoCommitment(committed.section);
  const sig = verifyStereoCommitment(commitment as any, corrs);
  check('conformance: buildStereoCommitment output runs through verifyStereoCommitment',
    sig.state === 'planar', sig.state);
  check('conformance: primaryFrameHash binds the delivery file',
    commitment.primaryFrameHash === `sha256:${sealed.record.asset.sha256}`);
  check('conformance: focusDistanceM is absent (null by construction — the gate weighs recomputed geometry)',
    !('focusDistanceM' in commitment.metadataBlock));
}

// ---------------------------------------------------------------------------
section('(c) a tampered secondary frame fails CLOSED as PROVEN TAMPER');
// ---------------------------------------------------------------------------

{
  const tampered = JSON.parse(JSON.stringify(bundleJson));
  const bytes = base64ToBytes(tampered.stereo.artifacts.secondaryFrame.dataBase64);
  bytes[100] ^= 0xff; // flip one byte of the geometry input
  tampered.stereo.artifacts.secondaryFrame.dataBase64 = bytesToBase64(bytes);

  const report = analyzeStereoBundle(tampered, corrs);
  const sec = report.artifacts!.find((a) => a.id === 'secondaryFrame')!;
  check('(c) the tampered frame is PROVEN TAMPER', sec.integrity === 'PROVEN-TAMPER', sec.integrity);
  check('(c) the tamper line is red-class and distinct from absence',
    sec.line.includes('PROVEN TAMPER') && sec.line.includes('distinct from absence'), sec.line);
  check('(c) planarity fails closed — nothing measured from altered bytes',
    report.planarityPath === 'tamper' && report.signal === undefined &&
    report.lines.some((l) => l.includes('fails closed')));
  check('(c) absence is not conflated: the never-recorded DNG stays an unreached state',
    report.artifacts!.find((a) => a.id === 'rawDng')!.integrity === 'never-recorded');
  let threw = '';
  try { buildStereoCommitment(tampered.stereo); } catch (e) { threw = (e as Error).message; }
  check('(c) the commitment builder refuses tampered input', threw.includes('PROVEN TAMPER'), threw);

  // A tampered hash field (bytes intact) is the same class: the bundle's
  // own commitment is violated either way.
  const tamperedHash = JSON.parse(JSON.stringify(bundleJson));
  tamperedHash.stereo.artifacts.secondaryFrame.sha256 = '0'.repeat(64);
  check('(c) tampering the committed hash is PROVEN TAMPER too',
    analyzeStereoBundle(tamperedHash, corrs).artifacts!.find((a) => a.id === 'secondaryFrame')!.integrity === 'PROVEN-TAMPER');
}

// ---------------------------------------------------------------------------
section("(d) old-format bundles are rejected at the format gate — no migration");
// ---------------------------------------------------------------------------

{
  const oldBundle = JSON.parse(JSON.stringify(bundleJson));
  oldBundle.format = 'exhibit-proof-bundle/1';
  const gate = proofBundleGate(oldBundle);
  check('(d) the /1 bundle fails the gate', !gate.ok);
  check('(d) the error names both versions and the no-migration rule',
    !gate.ok && gate.error.includes('exhibit-proof-bundle/1') &&
    gate.error.includes('exhibit-proof-bundle/2') && gate.error.includes('no migration'),
    gate.ok ? '(gate passed!)' : gate.error);
  check('(d) isProofBundle rejects it as well', !isProofBundle(oldBundle));
  const report = analyzeStereoBundle(oldBundle, corrs);
  check('(d) the desk path reports the rejection, never a silent skip',
    !report.gate.ok && report.lines[0].startsWith('REJECTED at the format gate'), report.lines[0]);
  {
    const nonBundle = proofBundleGate({ hello: 'world' });
    check('(d) a non-bundle JSON is told apart from a wrong-version bundle',
      !nonBundle.ok && !nonBundle.ok && (nonBundle as { ok: false; error: string }).error.includes('not an exhibit proof bundle'));
  }
}

// ---------------------------------------------------------------------------
section('(e) null-with-error: the committed error string surfaces, amber not red');
// ---------------------------------------------------------------------------

{
  const failed = commitStereoArtifacts(
    makeArtifacts({
      calibration: { path: null, error: 'E_THERMAL: stereo secondary detached to protect the device' },
    }),
    primarySha256,
  );
  check('(e) the error state carries the committed string',
    failed.section.artifacts.calibration.state === 'error' &&
    failed.section.artifacts.calibration.error === 'E_THERMAL: stereo secondary detached to protect the device');
  check('(e) the context claim commits the error string verbatim',
    failed.contextClaims.find((c) => c.claimId === STEREO_CLAIM_IDS.calibration)?.value ===
      'error:E_THERMAL: stereo secondary detached to protect the device');

  const failedBundle = JSON.parse(JSON.stringify(buildProofBundle(sealed.record, bytesToBase64(store.payload), null, failed.section)));
  const report = analyzeStereoBundle(failedBundle, corrs);
  const cal = report.artifacts!.find((a) => a.id === 'calibration')!;
  check('(e) the desk prints the committed error string',
    cal.integrity === 'record-error' && cal.line.includes('E_THERMAL: stereo secondary detached to protect the device'), cal.line);
  check('(e) a stated error is NOT tamper and NOT absence',
    report.planarityPath === 'incomplete' && report.signal === undefined &&
    !report.lines.some((l) => l.includes('PROVEN TAMPER')));
  check('(e) the planarity skip says absence is not suspicion and not clearance',
    report.lines.some((l) => l.includes('not suspicion') && l.includes('not clearance')));
}

// ---------------------------------------------------------------------------
section('no correspondences: extraction still runs, geometry honestly unmeasured');
// ---------------------------------------------------------------------------

{
  const report = analyzeStereoBundle(bundleJson, null);
  check('no-correspondences: integrity still checked',
    report.planarityPath === 'no-correspondences' &&
    report.artifacts!.filter((a) => a.state === 'recorded').every((a) => a.integrity === 'hash-match'));
  check('no-correspondences: the unmeasured geometry is stated, never implied',
    report.lines.some((l) => l.includes('no correspondences supplied') && l.includes('Nothing geometric was measured')));
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);

/**
 * VIDEO stereo-pair suite — end to end through the REAL seal pipeline.
 *
 * A synthetic video capture with N=3 periodic pairs (fixture JPEGs +
 * native-shape calibration JSON per pair, generated in-test with known
 * geometry) is mapped through the seal-side glue (stereoGlue.ts), committed
 * via commitStereoVideoArtifacts (stereoArtifacts.ts), sealed through
 * attestVideo (the context.stereo-video-* claims ride the REAL
 * com.verify.contextTree manifest assertion), exported as an
 * 'exhibit-proof-bundle/2' proof bundle (additive videoStereo section), and
 * read back through the desk path (desk/cli/stereoVerify.ts). Checked:
 *
 *   (a) all N pairs committed — hashes verify, entries ordered, the four
 *       signed claims carry the counts verbatim + the pairs-root;
 *   (b) the seal binds the claims into the real context tree, and the
 *       section pairs with the delivery file's asset hash;
 *   (c) the bundle round-trips through isProofBundle / the format gate;
 *   (d) one corrupted pair artifact → PROVEN TAMPER named AT that pairIndex,
 *       fail-closed per pair (the other pairs still report);
 *   (e) a missed pair appears as the declared count — printed verbatim,
 *       never silently absent, never suspicion;
 *   (f) planarity runs PER PAIR when correspondences are injected for that
 *       pairIndex (signal text verbatim); uninjected pairs state so;
 *   (g) three-state contract violations refuse to commit.
 *
 * Run (staged lab): node stage.mjs && cd .staged && npm install --no-audit --no-fund
 *   && ./node_modules/.bin/tsx test-stereo-video.mts
 */
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sha256 } from '@noble/hashes/sha256';
import { randomBytes } from '@noble/hashes/utils';
import {
  commitStereoVideoArtifacts,
  checkVideoStereoSectionIntegrity,
  isVideoStereoBundleSection,
  canonicalVideoPairs,
  STEREO_VIDEO_CLAIM_IDS,
  utf8ToBytes,
  type StereoVideoPairInput,
} from './stereoArtifacts.mts';
import { buildStereoVideoPairInputs, type StereoVideoPairEvent } from './stereoGlue.mts';
import {
  buildProofBundle,
  isProofBundle,
  proofBundleGate,
  PROOF_BUNDLE_FORMAT,
} from './proofBundle.mts';
import { commitCaptureEvidence } from './disclosure-captureCommit.mts';
import { inventoryDigest } from './disclosure-inventory.mts';
import { verifyBundle } from './disclosure-bundle.mts';
import { attestVideo } from './attest.mts';
import { parseManifest } from './c2pa.mts';
import { extractC2paStoreBmff } from './bmff.mts';
import { labSigner } from './deviceKey-shim.mts';
import { base64ToBytes, bytesToBase64, bytesToHex, bytesToUtf8 } from './bytes.mts';
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
// Synthetic rig — the SAME wide ↔ ultra-wide geometry as the photo suite.
// The committed desk shape wants P_secondary = R·P_primary + t with
// (IDENTITY, BASELINE_T); the native 4×3 is secondary→primary, so the glue
// inverts: native R=IDENTITY, t = −BASELINE_T.
// ---------------------------------------------------------------------------

const WIDE = { fx: 1100, fy: 1100, cx: 640, cy: 480, width: 1280, height: 960 };
const UW = { fx: 560, fy: 560, cx: 320, cy: 240, width: 640, height: 480 };
const IDENTITY3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const BASELINE_T: [number, number, number] = [-0.012, 0, 0];
const NATIVE_T = [0.012, 0, 0]; // −BASELINE_T (R=I ⇒ the inverse translation)
const NATIVE_M12 = [
  IDENTITY3[0], IDENTITY3[1], IDENTITY3[2], NATIVE_T[0],
  IDENTITY3[3], IDENTITY3[4], IDENTITY3[5], NATIVE_T[1],
  IDENTITY3[6], IDENTITY3[7], IDENTITY3[8], NATIVE_T[2],
];

function nativeCalJson(): string {
  const full = (device: string, fx: number, w: number, h: number) => ({
    device,
    intrinsicMatrixRowMajor: [fx, 0, w / 2, 0, fx, h / 2, 0, 0, 1],
    intrinsicMatrixReferenceDimensions: { width: w, height: h },
    extrinsicMatrixRowMajor: NATIVE_M12,
    pixelSizeMicrometers: 1.4,
    lensDistortionCenter: null,
    lensDistortionLookupTable: null,
    inverseLensDistortionLookupTable: null,
  });
  return JSON.stringify({
    primaryIntrinsicsRowMajor: [WIDE.fx, 0, WIDE.cx, 0, WIDE.fy, WIDE.cy, 0, 0, 1],
    secondaryIntrinsicsRowMajor: [UW.fx, 0, UW.cx, 0, UW.fy, UW.cy, 0, 0, 1],
    primaryFull: full('builtInWideAngleCamera', WIDE.fx, WIDE.width, WIDE.height),
    secondaryFull: full('builtInUltraWideCamera', UW.fx, UW.width, UW.height),
    calibrationSource: { intrinsics: 'frame-attachments', full: 'session-photo-capture' },
  });
}

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
// Synthetic pair events + a virtual evidence dir (the module's per-pair
// writes, synthesized; distinct bytes per pair so hashes name their pair).
// ---------------------------------------------------------------------------

const primaryBytes = new Uint8Array(fs.readFileSync(`${STAGED}/clean.mp4`));
const primarySha256 = bytesToHex(sha256(primaryBytes));
const baseSecondary = new Uint8Array(fs.readFileSync(`${STAGED}/other.jpg`));
const CAL_JSON = nativeCalJson();

const N_PAIRS = 3;
const pairSecondaryBytes: Uint8Array[] = [];
const events: StereoVideoPairEvent[] = [];
const virtualFs = new Map<string, Uint8Array>();
for (let i = 0; i < N_PAIRS; i++) {
  const sec = new Uint8Array([...baseSecondary, i]); // distinct per pair
  pairSecondaryBytes.push(sec);
  const secondaryPath = `/evidence/pairs/pair-${String(i).padStart(4, '0')}-secondary.jpg`;
  const calibrationPath = `/evidence/pairs/pair-${String(i).padStart(4, '0')}-calibration.json`;
  virtualFs.set(secondaryPath, sec);
  virtualFs.set(calibrationPath, utf8ToBytes(CAL_JSON));
  events.push({
    index: i,
    secondaryPath,
    calibrationPath,
    primaryHostSeconds: 412300 + i * 5.0,
    synchronizedDeltaMs: 0.1,
  });
}
const readBytes = async (uri: string): Promise<Uint8Array> => {
  const b = virtualFs.get(uri.replace('file://', ''));
  if (!b) throw new Error(`ENOENT: ${uri}`);
  return b;
};

const COUNTS = { pairsCommitted: N_PAIRS, pairsMissed: 1, hardwareCost: 0.62 };

// ---------------------------------------------------------------------------
section('(a) commit: all N pairs committed, hashes verify, claims carry counts + root');
// ---------------------------------------------------------------------------

const glue = await buildStereoVideoPairInputs(events, readBytes);
check('(a) the glue enumerates every pair event, ordered', glue.pairs.length === N_PAIRS && glue.pairs.every((p, i) => p.pairIndex === i));
check('(a) the calibration converts to the committed desk shape per pair',
  glue.pairs.every((p) => typeof p.artifacts.calibration.path === 'string' && p.artifacts.calibration.bytes instanceof Uint8Array));

const committed = commitStereoVideoArtifacts(glue.pairs, COUNTS, primarySha256);
check('(a) every pair entry committed, ascending pairIndex',
  committed.section.pairs.length === N_PAIRS && committed.section.pairs.every((p, i) => p.pairIndex === i));
check('(a) secondary hashes match the committed values',
  committed.section.pairs.every((p, i) => p.artifacts.secondaryFrame.sha256 === bytesToHex(sha256(pairSecondaryBytes[i]))));
check('(a) calibration bytes committed in the CONVERTED shape (the glue\'s inversion is what hashes)',
  committed.section.pairs.every((p) => bytesToUtf8(base64ToBytes(p.artifacts.calibration.dataBase64!)).includes('intrinsicsWide')));
check('(a) anchors ride the entries verbatim',
  committed.section.pairs.every((p, i) => p.anchors.primaryHostSeconds === 412300 + i * 5 && p.anchors.synchronizedDeltaMs === 0.1));
check('(a) counts committed verbatim from the stop result',
  committed.section.pairsCommitted === 3 && committed.section.pairsMissed === 1 && committed.section.hardwareCost === 0.62);
check('(a) the four claims carry the counts verbatim + the pairs-root',
  committed.contextClaims.find((c) => c.claimId === STEREO_VIDEO_CLAIM_IDS.pairsCommitted)?.value === '3' &&
  committed.contextClaims.find((c) => c.claimId === STEREO_VIDEO_CLAIM_IDS.pairsMissed)?.value === '1' &&
  committed.contextClaims.find((c) => c.claimId === STEREO_VIDEO_CLAIM_IDS.hardwareCost)?.value === '0.62' &&
  committed.contextClaims.find((c) => c.claimId === STEREO_VIDEO_CLAIM_IDS.pairsRoot)?.value ===
    `sha256:${bytesToHex(sha256(utf8ToBytes(canonicalVideoPairs(committed.section.pairs))))}`);
check('(a) integrity: every committed artifact hash-matches its embedded bytes',
  checkVideoStereoSectionIntegrity(committed.section).every((r) =>
    (['secondaryFrame', 'calibration'] as const).every((id) => r.results[id].integrity === 'hash-match')));
check('(a) the section passes its own guard after a JSON round-trip',
  isVideoStereoBundleSection(JSON.parse(JSON.stringify(committed.section))));

// ---------------------------------------------------------------------------
section('(b) seal: the claims bind into the REAL context tree; missed pair declared');
// ---------------------------------------------------------------------------

{
  const seed = randomBytes(32);
  const { committed: ctx } = commitCaptureEvidence(seed, {
    capturedAt: '2026-08-06T10:20:30.123Z',
    location: { lat: 37.7749, lon: -122.4194 } as const,
    identity: { author: 'Rana', organization: null } as const,
    fingerprint: 'ab'.repeat(32),
    sensorLogRecorded: false,
    stereoClaims: committed.contextClaims,
  });
  const entries = ctx.inventoryAssertion.entries;
  const metaLeaf = bytesToHex(ctx.tree.layers[0][0]);
  check('(b) all four stereo-video entries appear in the inventory assertion',
    Object.values(STEREO_VIDEO_CLAIM_IDS).every((id) => entries.some((e) => e.claimId === id)));
  check('(b) the inventory meta-leaf digests those entries (A-01 binding)',
    metaLeaf === bytesToHex(inventoryDigest(entries)));
  check('(b) the missed-pair declaration is a committed leaf value, bound by the root',
    ctx.leaves.find((c) => c.claimId === STEREO_VIDEO_CLAIM_IDS.pairsMissed)?.value === '1' &&
    ctx.inventoryAssertion.root === ctx.tree.root);
}

const key = labSigner();
const sealed = await attestVideo({
  videoUri: `${STAGED}/clean.mp4`,
  context: { location: { lat: 37.7749, lon: -122.4194, accuracyM: 5 } } as any,
  identity: { author: 'Rana', organization: null },
  key,
  capturedAt: '2026-08-06T10:20:30.123Z',
  stereoClaims: committed.contextClaims,
});
const store = extractC2paStoreBmff(sealed.signedVideoBytes!)!;
const manifest = parseManifest(store.payload)!;
const contextTree = manifest.customAssertions['com.verify.contextTree']?.data as any;
check('(b) the manifest contextTree carries the four stereo-video entries',
  Object.values(STEREO_VIDEO_CLAIM_IDS).every((id) => contextTree?.entries?.some((e: any) => e.claimId === id)),
  JSON.stringify((contextTree?.entries ?? []).filter((e: any) => e.claimId.startsWith('context.stereo'))));
check('(b) the Sealed-profile bundle verifies against the manifest root',
  verifyBundle(sealed.disclosure!.sealedBundle, contextTree.root, contextTree).ok);
check('(b) the section pairs with the sealed delivery file',
  committed.section.primaryVideoSha256 === sealed.record.asset.sha256,
  `${committed.section.primaryVideoSha256} vs ${sealed.record.asset.sha256}`);

// ---------------------------------------------------------------------------
section('(c) bundle: additive /2 section round-trips the format gate');
// ---------------------------------------------------------------------------

const bundle = buildProofBundle(sealed.record, bytesToBase64(store.payload), sealed.chunkMaps ?? null, null, committed.section);
const bundleJson = JSON.parse(JSON.stringify(bundle));
check(`(c) format is ${PROOF_BUNDLE_FORMAT} with the videoStereo section present`,
  bundleJson.format === 'exhibit-proof-bundle/2' && bundleJson.videoStereo !== undefined);
check('(c) passes the format gate + isProofBundle after a JSON round-trip',
  proofBundleGate(bundleJson).ok && isProofBundle(bundleJson));
check('(c) a corrupted section shape is REFUSED by the guard',
  !isProofBundle({ ...bundleJson, videoStereo: { ...bundleJson.videoStereo, pairsCommitted: -1 } }));

// ---------------------------------------------------------------------------
section('(d) tamper: one corrupted pair artifact names its pairIndex, fail-closed per pair');
// ---------------------------------------------------------------------------

{
  const tampered = JSON.parse(JSON.stringify(bundleJson));
  const raw = base64ToBytes(tampered.videoStereo.pairs[1].artifacts.secondaryFrame.dataBase64);
  raw[10] ^= 0xff;
  tampered.videoStereo.pairs[1].artifacts.secondaryFrame.dataBase64 = bytesToBase64(raw);
  const integrity = checkVideoStereoSectionIntegrity(tampered.videoStereo);
  check('(d) the corrupted pair reports PROVEN-TAMPER at pairIndex 1',
    integrity.find((r) => r.pairIndex === 1)?.results.secondaryFrame.integrity === 'PROVEN-TAMPER');
  check('(d) the other pairs still hash-match',
    integrity.filter((r) => r.pairIndex !== 1).every((r) => r.results.secondaryFrame.integrity === 'hash-match'));
  const report = analyzeStereoBundle(tampered, null);
  check('(d) desk: the section reports tamper, named at pair 1',
    report.video?.tamper === true && report.video.pairs.find((p) => p.pairIndex === 1)?.planarityPath === 'tamper');
  check('(d) desk: tampered pair measures nothing; the others still report',
    report.video!.pairs.filter((p) => p.pairIndex !== 1).every((p) => p.planarityPath === 'no-correspondences'));
  check('(d) desk: the tamper line is printed verbatim',
    report.lines.some((l) => l.includes('PROVEN TAMPER') && l.includes('pair 1')));
}

// ---------------------------------------------------------------------------
section('(e) the missed pair appears as declared — printed verbatim, never silently absent');
// ---------------------------------------------------------------------------

{
  const report = analyzeStereoBundle(bundleJson, null);
  check('(e) desk: counts printed verbatim (3 committed, 1 missed)',
    report.video?.pairsCommitted === 3 && report.video.pairsMissed === 1 &&
    report.lines.some((l) => l.includes('3 committed') && l.includes('1 missed')));
  check('(e) the missed count is declared, not suspicion',
    report.lines.some((l) => l.includes('declared count') && l.includes('never suspicion')));
  check('(e) no desk line says "passed" or "authentic"',
    !report.lines.some((l) => /\bpassed\b|\bauthentic\b/i.test(l)));
}

// ---------------------------------------------------------------------------
section('(f) planarity runs per pair when correspondences are injected for that pairIndex');
// ---------------------------------------------------------------------------

{
  const corrs = planarCorrespondences();
  // Sanity: the converted per-pair commitment feeds the real verifier.
  const { buildStereoVideoPairCommitment } = await import('./stereoArtifacts.mts');
  const commitment = buildStereoVideoPairCommitment(committed.section, 1);
  const signal = verifyStereoCommitment(commitment, corrs);
  check('(f) the per-pair commitment verifies against known-geometry correspondences',
    signal.state === 'planar', `${signal.state} :: ${signal.text}`);

  const report = analyzeStereoBundle(bundleJson, null, { 1: corrs });
  const p1 = report.video?.pairs.find((p) => p.pairIndex === 1);
  check('(f) desk: pair 1 takes the planarity path with injected correspondences',
    p1?.planarityPath === 'clean' && p1.signal?.state === 'planar', p1?.planarityPath);
  check('(f) desk: uninjected pairs state that nothing was measured',
    report.video!.pairs.filter((p) => p.pairIndex !== 1).every((p) => p.planarityPath === 'no-correspondences'));
  check('(f) desk: the signal text prints verbatim with its bounds',
    report.lines.some((l) => l.includes('pair 1 planarity signal state:')) &&
    report.lines.some((l) => l.includes('signal') && l.includes('verdict')));
  check('(f) desk: the absent per-pair metadata block is stated, not patched over',
    report.lines.some((l) => l.includes('no per-pair metadata block')));
}

// ---------------------------------------------------------------------------
section('(g) contract violations refuse to commit');
// ---------------------------------------------------------------------------

{
  const goodPair = (): StereoVideoPairInput => ({
    pairIndex: 0,
    anchors: { primaryHostSeconds: 1, synchronizedDeltaMs: 0.1 },
    artifacts: {
      secondaryFrame: { path: '/x.jpg', bytes: pairSecondaryBytes[0] },
      calibration: { path: '/x.json', bytes: utf8ToBytes(CAL_JSON) },
    },
  });
  let threw = '';
  try {
    const p = goodPair();
    p.artifacts.secondaryFrame = { path: '/x.jpg' };
    commitStereoVideoArtifacts([p], COUNTS, primarySha256);
  } catch (e) { threw = (e as Error).message; }
  check('(g) recorded path without bytes refuses to commit', threw.includes('no bytes'), threw);
  threw = '';
  try {
    const p = goodPair();
    p.artifacts.calibration = { path: null };
    commitStereoVideoArtifacts([p], COUNTS, primarySha256);
  } catch (e) { threw = (e as Error).message; }
  check('(g) null-without-error refuses to commit (the failure must be stated)', threw.includes('error string'), threw);
  threw = '';
  try {
    const p = goodPair();
    (p.anchors as any).synchronizedDeltaMs = NaN;
    commitStereoVideoArtifacts([p], COUNTS, primarySha256);
  } catch (e) { threw = (e as Error).message; }
  check('(g) a malformed anchor refuses to commit (event values, verbatim)', threw.includes('anchors'), threw);
  threw = '';
  try { commitStereoVideoArtifacts([goodPair()], { ...COUNTS, pairsMissed: -1 }, primarySha256); }
  catch (e) { threw = (e as Error).message; }
  check('(g) a negative missed count refuses to commit', threw.includes('pairsMissed'), threw);
}

// A pair with a null calibrationPath (the module's own sink-failure report)
// commits as a stated error entry — a declared degradation, never silent.
{
  const evs: StereoVideoPairEvent[] = [{ index: 0, secondaryPath: '/evidence/pairs/pair-0000-secondary.jpg', calibrationPath: null, primaryHostSeconds: 1, synchronizedDeltaMs: null }];
  const g2 = await buildStereoVideoPairInputs(evs, readBytes);
  const c2 = commitStereoVideoArtifacts(g2.pairs, { pairsCommitted: 1, pairsMissed: 0, hardwareCost: null }, primarySha256);
  check('(g) a null calibration path commits as a stated error entry',
    c2.section.pairs[0].artifacts.calibration.state === 'error' &&
    typeof c2.section.pairs[0].artifacts.calibration.error === 'string' &&
    c2.section.pairs[0].artifacts.calibration.error!.includes('null calibrationPath'));
  check('(g) hardwareCost null commits as not-reported, stated',
    c2.contextClaims.find((c) => c.claimId === STEREO_VIDEO_CLAIM_IDS.hardwareCost)?.value === 'not-reported');
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);

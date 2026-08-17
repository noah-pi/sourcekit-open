// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Multi-baseline stereo suite — SYNTHETIC three-lens rigs with known geometry.
 *
 * Synthetic rig (committed in-test, never hardcoded in the verifier):
 *   ultra-wide  f =  560 px, 640×480
 *   wide        f = 1100 px, 1280×960
 *   tele        f = 2200 px, 1280×960
 * Identity rotations; baselines UW↔W 12 mm, W↔T 14 mm, UW↔T 26 mm.
 *
 *   (a) one plane at 1 m, all three pairs          → 'consistent', tiny
 *       agreement residual (noiseless ≈ 0; σ = 0.25 px matcher noise stays
 *       far under the agreement ceiling)
 *   (b) real 3D depth spread, all pairs            → 'inconsistent'
 *       (per-pair non-planar; NOT a verdict of authenticity)
 *   (c) ADVERSARIAL mixed geometry: uw↔w sees plane A, w↔t sees plane B,
 *       uw↔t sees plane C — every pair individually 'planar' (this is what
 *       a two-baseline verifier sees and CANNOT catch), but the three fits
 *       disagree with their composition → 'inconsistent' via the agreement
 *       residual. The multi-baseline finding.
 *   (d) graceful degradation with depth: 3.0 m → uw↔w beyond its 2.7 m
 *       range ('insufficient-geometry'), decision on the two tele pairs;
 *       4.5 m → only uw↔t remains → honest single-baseline decision;
 *       8.0 m → nothing in range → overall 'insufficient-geometry'.
 *       Per-pair ranges are recomputed in-test from the range formula and
 *       the committed extrinsics — proving nothing is hardcoded.
 *   (e) unsupported commitment + honesty sweep: every overall text carries
 *       per-pair ranges and the "signal, not a verdict" framing; no string
 *       claims "passed" / "verified" / "authentic".
 *
 * Run (staged lab): node stage.mjs && cd .staged && npm install --no-audit --no-fund
 *   && ./node_modules/.bin/tsx test-stereo-multibaseline.mts
 */
import {
  assessMultiBaseline,
  AGREEMENT_MAX_RESIDUAL_PX,
  MULTIBASELINE_METHOD_VERSION,
  type MultiCamCommitment,
  type MultiBaselineSignal,
  type PairAssessment,
} from './multibaseline.mts';
import {
  MATCHER_NOISE_SIGMA_PX,
  MIN_DEPTH_DISCRIMINATION_M,
} from './planarity.mts';
import type { CameraIntrinsics, Correspondence } from './types.mts';

let passed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failures.push(name); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rnd: () => number, sigma: number): number {
  const u = Math.max(rnd(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd()) * sigma;
}

// ---------------------------------------------------------------------------
// Synthetic three-lens rig.
// ---------------------------------------------------------------------------

type Lens = 'ultra-wide' | 'wide' | 'tele';
const CAMS: Record<Lens, CameraIntrinsics> = {
  'ultra-wide': { fx: 560, fy: 560, cx: 320, cy: 240, width: 640, height: 480 },
  wide: { fx: 1100, fy: 1100, cx: 640, cy: 480, width: 1280, height: 960 },
  tele: { fx: 2200, fy: 2200, cx: 640, cy: 480, width: 1280, height: 960 },
};
type V3 = [number, number, number];
const IDENTITY3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
/** Camera origins expressed as P_lens = P_uw + offset (identity rotations). */
const OFFSET: Record<Lens, V3> = {
  'ultra-wide': [0, 0, 0],
  wide: [-0.012, 0, 0],
  tele: [-0.026, 0, 0],
};

function makeRig(
  focusM: Record<Lens, number | undefined>,
  opts: { dropExtrinsics?: boolean } = {},
): MultiCamCommitment {
  const lenses: Lens[] = ['ultra-wide', 'wide', 'tele'];
  const frames = new Map(
    lenses.map((l) => [l, { hash: 'sha256:' + l.length.toString(16).padStart(64, '0') }]),
  );
  const intrinsics = new Map(lenses.map((l) => [l, CAMS[l]]));
  const extrinsics = new Map(
    opts.dropExtrinsics
      ? []
      : [
          ['ultra-wide|wide', { rotation: IDENTITY3, translationM: [-0.012, 0, 0] as V3 }],
          ['wide|tele', { rotation: IDENTITY3, translationM: [-0.014, 0, 0] as V3 }],
          ['ultra-wide|tele', { rotation: IDENTITY3, translationM: [-0.026, 0, 0] as V3 }],
        ],
  );
  const sync = new Map([
    ['ultra-wide|wide', 0.1],
    ['wide|tele', 0.1],
    ['ultra-wide|tele', 0.2],
  ]);
  const metadata = new Map(
    lenses.map((l) => [
      l,
      {
        focusDistanceM: focusM[l],
        focalLengthMm: l === 'tele' ? 8.5 : l === 'wide' ? 4.25 : 2.2,
        aperture: 1.8,
        exposureS: 1 / 120,
        iso: 100,
        devicePosition: l,
        antiBandingState: '60Hz',
      },
    ]),
  );
  return {
    rigId: 'synthetic-three-lens-rig-0',
    frames,
    calibrations: { intrinsics, extrinsics },
    syncTimestampDeltasMs: sync,
    metadata,
  };
}

/** Project a scene point (in the ultra-wide frame) into one lens. */
function projectToLens(P: V3, lens: Lens): [number, number] {
  const o = OFFSET[lens];
  const cam = CAMS[lens];
  const x = (P[0] + o[0]) / (P[2] + o[2]);
  const y = (P[1] + o[1]) / (P[2] + o[2]);
  return [cam.fx * x + cam.cx, cam.fy * y + cam.cy];
}

/**
 * Correspondences for one pair from scene points. Directions are kept
 * inside the TELE frame (±0.24, ±0.17 normalized) — the narrowest FOV —
 * so every lens of every pair can see every point.
 */
function pairCorrs(
  seed: number,
  n: number,
  depthOf: (X: number, Y: number, k: number) => number,
  a: Lens,
  b: Lens,
  noiseSigmaPx = 0,
): Correspondence[] {
  const rnd = mulberry32(seed);
  const out: Correspondence[] = [];
  for (let k = 0; k < n; k++) {
    const dx = (rnd() * 2 - 1) * 0.24;
    const dy = (rnd() * 2 - 1) * 0.17;
    const Z = depthOf(dx, dy, k);
    const P: V3 = [dx * Z, dy * Z, Z];
    const pa = projectToLens(P, a);
    const pb = projectToLens(P, b);
    out.push({
      primary: [pa[0] + gaussian(rnd, noiseSigmaPx), pa[1] + gaussian(rnd, noiseSigmaPx)],
      secondary: [pb[0] + gaussian(rnd, noiseSigmaPx), pb[1] + gaussian(rnd, noiseSigmaPx)],
    });
  }
  return out;
}

/** All three pairs from the SAME scene points (the honest-capture case). */
function sceneCorrs(
  seed: number,
  n: number,
  depthOf: (X: number, Y: number, k: number) => number,
  noiseSigmaPx = 0,
): Map<string, Correspondence[]> {
  const rnd = mulberry32(seed);
  const pts: V3[] = [];
  for (let k = 0; k < n; k++) {
    const dx = (rnd() * 2 - 1) * 0.24;
    const dy = (rnd() * 2 - 1) * 0.17;
    const Z = depthOf(dx, dy, k);
    pts.push([dx * Z, dy * Z, Z]);
  }
  const map = new Map<string, Correspondence[]>();
  const mk = (a: Lens, b: Lens, s: number): Correspondence[] => {
    const nrnd = mulberry32(s);
    return pts.map((P) => {
      const pa = projectToLens(P, a);
      const pb = projectToLens(P, b);
      return {
        primary: [pa[0] + gaussian(nrnd, noiseSigmaPx), pa[1] + gaussian(nrnd, noiseSigmaPx)],
        secondary: [pb[0] + gaussian(nrnd, noiseSigmaPx), pb[1] + gaussian(nrnd, noiseSigmaPx)],
      };
    });
  };
  map.set('ultra-wide|wide', mk('ultra-wide', 'wide', seed + 1));
  map.set('wide|tele', mk('wide', 'tele', seed + 2));
  map.set('ultra-wide|tele', mk('ultra-wide', 'tele', seed + 3));
  return map;
}

/** The effective range formula, recomputed in-test from first principles. */
function expectedRangeM(fRepPx: number, baselineM: number): number {
  const rho = MATCHER_NOISE_SIGMA_PX * Math.SQRT2;
  return Math.sqrt((fRepPx * baselineM * MIN_DEPTH_DISCRIMINATION_M) / rho);
}

const signals: Record<string, MultiBaselineSignal> = {};

// ---------------------------------------------------------------------------
console.log('— multi-baseline: (a) one plane at 1 m, all three pairs —');
// ---------------------------------------------------------------------------

{
  const corrs = sceneCorrs(101, 60, () => 1.0);
  const sig = assessMultiBaseline(
    makeRig({ 'ultra-wide': 1.0, wide: 1.0, tele: 1.0 }),
    corrs,
  );
  signals.consistent = sig;
  console.log('  text:', sig.text);
  check('(a) state is consistent', sig.state === 'consistent', sig.state);
  check('(a) all three pairs planar',
    [...sig.perPair.values()].every((p) => p.state === 'planar'),
    [...sig.perPair.values()].map((p) => `${p.pairKey}:${p.state}`).join(','));
  check('(a) noiseless agreement residual is tiny (< 0.1 px)',
    (sig.agreementResidualPx ?? 99) < 0.1, `residual=${sig.agreementResidualPx}`);
  check('(a) agreement ceiling exported', sig.agreementCeilingPx === AGREEMENT_MAX_RESIDUAL_PX);
  check('(a) sufficient pairs = 3', sig.sufficientPairs === 3, `${sig.sufficientPairs}`);
  check('(a) text carries the agreement framing', sig.text.includes('composition'));

  // Determinism: same committed inputs → same answer, every run.
  const again = assessMultiBaseline(makeRig({ 'ultra-wide': 1.0, wide: 1.0, tele: 1.0 }), corrs);
  check('(a) deterministic: identical agreement residual on re-run',
    again.agreementResidualPx === sig.agreementResidualPx,
    `${again.agreementResidualPx} vs ${sig.agreementResidualPx}`);

  // With matcher noise σ = 0.25 px the honest planar scene must stay
  // 'consistent' and the agreement residual must stay far under the ceiling.
  const noisy = assessMultiBaseline(
    makeRig({ 'ultra-wide': 1.0, wide: 1.0, tele: 1.0 }),
    sceneCorrs(102, 60, () => 1.0, 0.25),
  );
  signals.consistentNoisy = noisy;
  console.log('  noisy agreement residual px:', noisy.agreementResidualPx,
    'per-pair residuals:', [...noisy.perPair.values()].map((p) => `${p.pairKey}=${p.residualPx?.toFixed(2)}`).join(' '));
  check('(a) noisy planar scene still consistent', noisy.state === 'consistent', noisy.state);
  check('(a) noisy agreement residual under ceiling with margin',
    (noisy.agreementResidualPx ?? 99) < AGREEMENT_MAX_RESIDUAL_PX / 2,
    `residual=${noisy.agreementResidualPx}`);
}

// ---------------------------------------------------------------------------
console.log('\n— multi-baseline: (b) real 3D depth spread —');
// ---------------------------------------------------------------------------

{
  const rnd = mulberry32(202);
  const corrs = sceneCorrs(203, 80, () => 0.5 + rnd() * 1.5);
  const sig = assessMultiBaseline(
    makeRig({ 'ultra-wide': 1.2, wide: 1.2, tele: 1.2 }),
    corrs,
  );
  signals.inconsistent3d = sig;
  console.log('  text:', sig.text);
  check('(b) state is inconsistent', sig.state === 'inconsistent', sig.state);
  check('(b) per-pair readings are non-planar',
    [...sig.perPair.values()].filter((p) => p.state === 'non-planar').length >= 2,
    [...sig.perPair.values()].map((p) => `${p.pairKey}:${p.state}`).join(','));
  check('(b) text frames 3D-structure-not-verdict', sig.text.includes('NOT a verdict of authenticity'));
}

// ---------------------------------------------------------------------------
console.log('\n— multi-baseline: (c) adversarial mixed geometry — the case two-baseline CANNOT catch —');
// ---------------------------------------------------------------------------

{
  // Each pair is fed a DIFFERENT plane: uw↔w a screen at 0.7 m, w↔t a
  // tilted plane near 1.5 m, uw↔t a tilted plane near 1.1 m. Every pair
  // fits its own homography beautifully — a two-baseline verifier sees a
  // 'planar' reading and stops. The composition check catches the lie.
  const corrs = new Map<string, Correspondence[]>([
    ['ultra-wide|wide', pairCorrs(301, 60, () => 0.7, 'ultra-wide', 'wide')],
    ['wide|tele', pairCorrs(302, 60, (x, y) => 1.5 + 0.15 * x - 0.10 * y, 'wide', 'tele')],
    ['ultra-wide|tele', pairCorrs(303, 60, (x, y) => 1.1 - 0.12 * x + 0.10 * y, 'ultra-wide', 'tele')],
  ]);
  const sig = assessMultiBaseline(
    makeRig({ 'ultra-wide': 1.2, wide: 1.2, tele: 1.2 }),
    corrs,
  );
  signals.mixed = sig;
  console.log('  text:', sig.text);
  console.log('  agreement residual px:', sig.agreementResidualPx);
  const pairStates = [...sig.perPair.values()].map((p) => `${p.pairKey}:${p.state}`);
  check('(c) EVERY pair alone reads planar (the two-baseline blind spot)',
    pairStates.filter((s) => s.endsWith('planar')).length === 3, pairStates.join(','));
  check('(c) composition residual flags the mix (> ceiling)',
    (sig.agreementResidualPx ?? 0) > AGREEMENT_MAX_RESIDUAL_PX, `residual=${sig.agreementResidualPx}`);
  check('(c) overall state is inconsistent despite three "planar" pairs',
    sig.state === 'inconsistent', sig.state);
  check('(c) text names the composition disagreement', sig.text.includes('DISAGREE with their composition'));
  check('(c) text says the finding two-baseline cannot see', sig.text.includes('CANNOT see'));
}

// ---------------------------------------------------------------------------
console.log('\n— multi-baseline: (d) graceful degradation with depth —');
// ---------------------------------------------------------------------------

{
  // Per-pair ranges, recomputed in-test from the committed extrinsics via
  // the range formula — nothing may be hardcoded in the verifier.
  const rUW_W = expectedRangeM((560 + 1100) / 2, 0.012);
  const rW_T = expectedRangeM((1100 + 2200) / 2, 0.014);
  const rUW_T = expectedRangeM((560 + 2200) / 2, 0.026);
  console.log(`  recomputed ranges: uw↔w ${rUW_W.toFixed(2)} m, w↔t ${rW_T.toFixed(2)} m, uw↔t ${rUW_T.toFixed(2)} m`);
  check('(d) ranges differ per pair (baselines differ)',
    rUW_W < rW_T && rW_T < rUW_T, `${rUW_W.toFixed(2)} < ${rW_T.toFixed(2)} < ${rUW_T.toFixed(2)}`);

  // 3.0 m: beyond uw↔w (2.65 m), inside both tele pairs.
  const d1 = assessMultiBaseline(
    makeRig({ 'ultra-wide': 3.0, wide: 3.0, tele: 3.0 }),
    sceneCorrs(401, 60, () => 3.0),
  );
  signals.degraded = d1;
  console.log('  text:', d1.text);
  const byPair = (s: MultiBaselineSignal, frag: string): PairAssessment =>
    [...s.perPair.values()].find((p) => p.pairKey.includes(frag))!;
  check('(d) 3 m: uw↔w pair is insufficient-geometry (beyond its committed range)',
    byPair(d1, 'ultra-wide|wide').state === 'insufficient-geometry', byPair(d1, 'ultra-wide|wide').state);
  check('(d) per-pair ranges match the recomputed formula (never hardcoded)',
    Math.abs(byPair(d1, 'ultra-wide|wide').effectiveRangeM - rUW_W) < 1e-9 &&
    Math.abs(byPair(d1, 'tele|wide').effectiveRangeM - rW_T) < 1e-9 &&
    Math.abs(byPair(d1, 'tele|ultra-wide').effectiveRangeM - rUW_T) < 1e-9,
    [...d1.perPair.values()].map((p) => `${p.pairKey}=${p.effectiveRangeM.toFixed(3)}`).join(' '));
  check('(d) 3 m: decision still reached on the remaining two pairs',
    d1.state === 'consistent' && d1.sufficientPairs === 2, `${d1.state} sufficient=${d1.sufficientPairs}`);
  check('(d) 3 m: text is honest that the agreement check could not run',
    d1.text.includes('could not run'), d1.text.slice(0, 200));
  check('(d) 3 m: text names the pair that dropped out', d1.text.includes('ultra-wide↔wide'));

  // 4.5 m: only uw↔t (5.04 m reach) survives → single-baseline decision.
  const d2 = assessMultiBaseline(
    makeRig({ 'ultra-wide': 4.5, wide: 4.5, tele: 4.5 }),
    sceneCorrs(402, 60, () => 4.5),
  );
  signals.singleBaseline = d2;
  console.log('  text:', d2.text);
  check('(d) 4.5 m: exactly one pair carries the decision', d2.sufficientPairs === 1, `${d2.sufficientPairs}`);
  check('(d) 4.5 m: decision on that pair (consistent with the plane)',
    d2.state === 'consistent', d2.state);
  check('(d) 4.5 m: text says SINGLE-baseline, no stronger',
    d2.text.includes('Single-baseline decision') && d2.text.includes('no stronger'));

  // 8.0 m: nothing in range → the only honest overall output.
  const d3 = assessMultiBaseline(
    makeRig({ 'ultra-wide': 8.0, wide: 8.0, tele: 8.0 }),
    sceneCorrs(403, 60, () => 8.0),
  );
  signals.allOutOfRange = d3;
  console.log('  text:', d3.text);
  check('(d) 8 m: overall insufficient-geometry', d3.state === 'insufficient-geometry', d3.state);
  check('(d) 8 m: not suspicion, clears nothing', d3.text.includes('not suspicion'));
}

// ---------------------------------------------------------------------------
console.log('\n— multi-baseline: (e) unsupported commitment + honesty sweep —');
// ---------------------------------------------------------------------------

{
  const broken = assessMultiBaseline(
    makeRig({ 'ultra-wide': 1.0, wide: 1.0, tele: 1.0 }, { dropExtrinsics: true }),
    sceneCorrs(501, 60, () => 1.0),
  );
  signals.unsupported = broken;
  console.log('  text:', broken.text);
  check('(e) rig with no committed extrinsics → unsupported', broken.state === 'unsupported', broken.state);
  check('(e) unsupported offers no agreement number dressed as evidence',
    broken.agreementResidualPx === undefined);

  for (const [name, sig] of Object.entries(signals)) {
    check(`(e) ${name}: text carries the per-pair effective ranges`,
      sig.text.includes('Effective range'), sig.text.slice(0, 120));
    check(`(e) ${name}: text carries signal-not-verdict framing`,
      sig.text.includes('not a verdict'), sig.text.slice(0, 120));
    check(`(e) ${name}: no verdict vocabulary in overall text`,
      !/\bpassed\b/i.test(sig.text) && !/\bverified\b/i.test(sig.text) && !/\bauthentic\b/i.test(sig.text));
    for (const p of sig.perPair.values()) {
      check(`(e) ${name}/${p.pairKey}: no verdict vocabulary in per-pair text`,
        !/\bpassed\b/i.test(p.text) && !/\bverified\b/i.test(p.text) && !/\bauthentic\b/i.test(p.text));
    }
  }
  const states = new Set(Object.values(signals).map((s) => s.state));
  check('(e) suite exercised all four overall states',
    states.has('consistent') && states.has('inconsistent') &&
    states.has('insufficient-geometry') && states.has('unsupported'),
    [...states].join(','));
  check('(e) method version is a scaffold string, not a claim',
    typeof MULTIBASELINE_METHOD_VERSION === 'string' && MULTIBASELINE_METHOD_VERSION.includes('scaffold'));
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.log('FAILURES:', failures.join(' | '));
  process.exit(1);
}
console.log('ALL MULTI-BASELINE STEREO TESTS PASSED');

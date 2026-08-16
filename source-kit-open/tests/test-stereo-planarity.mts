/**
 * Stereo planarity signal suite — SYNTHETIC fixtures with known geometry.
 *
 * Every fixture is generated in-test: 3D points imaged by two synthetic
 * pinhole cameras (known intrinsics, identity rotation, 12 mm baseline —
 * the wide ↔ ultra-wide pairing P3 commits). No device data, no network.
 *
 *   (a) true plane at 1 m              → 'planar', residual ≈ 0
 *   (b) real 3D depth spread           → 'non-planar' (a 3D scene, NOT a
 *                                        verdict of authenticity)
 *   (c) plane at 8 m, 12 mm baseline   → 'insufficient-geometry' (disparity
 *                                        below the noise floor) — and the
 *                                        gate must fire whether the depth
 *                                        cue is the committed focus distance
 *                                        or the desk's own triangulation
 *   (d) plane at 2 m with σ ≈ 0.5 px matcher noise → still 'planar'
 *                                        (documents noise tolerance)
 *   (e) degenerate commitment inputs   → 'unsupported'
 *   (f) distortion-LUT path: barrel-distorted projections of a true plane
 *       undistort back to 'planar'; the inverse lookup round-trips
 *   (g) honesty invariants: EVERY state's text carries the effective-range
 *       bound and the "signal, not a verdict" framing, and no string
 *       claims "passed" / "verified scene" / authenticity.
 *
 * Run (staged lab): node stage.mjs && cd .staged && npm install --no-audit --no-fund
 *   && ./node_modules/.bin/tsx test-stereo-planarity.mts
 */
import {
  verifyStereoCommitment,
  effectiveRangeM,
  undistortPixel,
  distortNormalized,
  normalizedToPixel,
  pixelToNormalized,
  PLANAR_MAX_RESIDUAL_PX,
  type Correspondence,
  type DistortionLut,
  type PlanaritySignal,
  type StereoCommitment,
} from './index.mts';

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
  // Box–Muller; guard the log at zero.
  const u = Math.max(rnd(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd()) * sigma;
}

// ---------------------------------------------------------------------------
// Synthetic camera rig: wide primary + ultra-wide secondary, 12 mm baseline.
// ---------------------------------------------------------------------------

const WIDE = { fx: 1100, fy: 1100, cx: 640, cy: 480, width: 1280, height: 960 };
const UW = { fx: 560, fy: 560, cx: 320, cy: 240, width: 640, height: 480 };
const IDENTITY3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
/** P_secondary = R·P_primary + t; secondary sits 12 mm to the side. */
const BASELINE_T: [number, number, number] = [-0.012, 0, 0];

function makeCommitment(overrides: {
  focusDistanceM?: number;
  translationM?: [number, number, number];
  distortionLut?: DistortionLut;
  malformedLut?: boolean;
}): StereoCommitment {
  return {
    primaryFrameHash: 'sha256:' + '0'.repeat(64),
    secondaryFrame: { bytes: new Uint8Array([0xff, 0xd8, 0xff]) }, // stand-in; the matcher is a later dependency
    calibration: {
      intrinsicsWide: WIDE,
      intrinsicsUltraWide: UW,
      extrinsics: {
        rotation: IDENTITY3,
        translationM: overrides.translationM ?? BASELINE_T,
      },
      distortionLut: overrides.malformedLut
        ? { width: 4, height: 4, domainRadius: 0.6, values: [0, 0, 0] } // too short for the grid
        : overrides.distortionLut,
    },
    syncTimestampDeltaMs: 0.1,
    metadataBlock: {
      focusDistanceM: overrides.focusDistanceM,
      focalLengthMm: 4.25,
      aperture: 1.8,
      exposureS: 1 / 120,
      iso: 100,
      devicePosition: 'wide',
      antiBandingState: '60Hz',
    },
  };
}

type V3 = [number, number, number];

/** Project a point in the primary camera frame into each synthetic camera. */
function projectPair(P: V3, lut?: DistortionLut): Correspondence {
  const inCam = (
    Q: V3,
    cam: typeof WIDE,
  ): [number, number] => {
    const x = Q[0] / Q[2];
    const y = Q[1] / Q[2];
    if (lut) {
      const [dx, dy] = distortNormalized(x, y, lut);
      return normalizedToPixel(dx, dy, cam);
    }
    return [cam.fx * x + cam.cx, cam.fy * y + cam.cy];
  };
  const P2: V3 = [P[0] + BASELINE_T[0], P[1] + BASELINE_T[1], P[2] + BASELINE_T[2]];
  return { primary: inCam(P, WIDE), secondary: inCam(P2, UW) };
}

/** n scene points: directions within ±0.4 normalized (both FOVs), given depths. */
function scenePoints(seed: number, depths: number[]): V3[] {
  const rnd = mulberry32(seed);
  return depths.map((Z) => [(rnd() * 2 - 1) * 0.4 * Z, (rnd() * 2 - 1) * 0.4 * Z, Z]);
}

function correspondencesFor(points: V3[], opts: { lut?: DistortionLut; noiseSigmaPx?: number; seed?: number } = {}): Correspondence[] {
  const rnd = mulberry32(opts.seed ?? 1234);
  return points.map((P) => {
    const c = projectPair(P, opts.lut);
    if (opts.noiseSigmaPx) {
      const s = opts.noiseSigmaPx;
      return {
        primary: [c.primary[0] + gaussian(rnd, s), c.primary[1] + gaussian(rnd, s)] as [number, number],
        secondary: [c.secondary[0] + gaussian(rnd, s), c.secondary[1] + gaussian(rnd, s)] as [number, number],
      };
    }
    return c;
  });
}

const signals: Record<string, PlanaritySignal> = {};

// ---------------------------------------------------------------------------
console.log('— stereo planarity: (a) true plane at 1 m —');
// ---------------------------------------------------------------------------

{
  const pts = scenePoints(11, Array.from({ length: 60 }, () => 1.0));
  const corrs = correspondencesFor(pts);
  const sig = verifyStereoCommitment(makeCommitment({ focusDistanceM: 1.0 }), corrs);
  signals.planar = sig;
  console.log('  text:', sig.text);
  check('(a) state is planar', sig.state === 'planar', sig.state);
  check('(a) residual near zero (< 0.5 px)', (sig.residualPx ?? 99) < 0.5, `residual=${sig.residualPx}`);
  check('(a) inlier ratio ≈ 1', (sig.inlierRatio ?? 0) > 0.95, `ratio=${sig.inlierRatio}`);
  const range = effectiveRangeM(makeCommitment({}).calibration);
  check('(a) effective range is “roughly three meters”', range > 2 && range < 4, `range=${range.toFixed(2)} m`);
  check('(a) signal reports its own range', Math.abs(sig.effectiveRangeM - range) < 1e-9);
}

// ---------------------------------------------------------------------------
console.log('\n— stereo planarity: (b) real 3D depth spread —');
// ---------------------------------------------------------------------------

{
  // Depths uniform in [0.5, 2.0] m: disparity spread no single homography
  // can absorb inside the effective range.
  const rnd = mulberry32(22);
  const pts = scenePoints(23, Array.from({ length: 80 }, () => 0.5 + rnd() * 1.5));
  const corrs = correspondencesFor(pts);
  const sig = verifyStereoCommitment(makeCommitment({ focusDistanceM: 1.2 }), corrs);
  signals.nonPlanar = sig;
  console.log('  text:', sig.text);
  check('(b) state is non-planar', sig.state === 'non-planar', sig.state);
  check('(b) text frames 3D-structure-not-verdict', sig.text.includes('NOT a verdict of authenticity'));
}

// ---------------------------------------------------------------------------
console.log('\n— stereo planarity: (c) plane at 8 m, 12 mm baseline —');
// ---------------------------------------------------------------------------

{
  const pts = scenePoints(31, Array.from({ length: 60 }, () => 8.0));
  const corrs = correspondencesFor(pts);

  const withFocus = verifyStereoCommitment(makeCommitment({ focusDistanceM: 8.0 }), corrs);
  signals.rangeFocus = withFocus;
  console.log('  text:', withFocus.text);
  check('(c) committed focus 8 m → insufficient-geometry', withFocus.state === 'insufficient-geometry', withFocus.state);
  check('(c) text says “Beyond effective range — insufficient geometry”',
    withFocus.text.includes('Beyond effective range — insufficient geometry'));
  check('(c) insufficient-geometry is not suspicion', withFocus.text.includes('not suspicion'));

  // The desk must not need the device's number: with no focus distance
  // committed, its own triangulation of the same correspondences must
  // still trip the gate.
  const triangulated = verifyStereoCommitment(makeCommitment({ focusDistanceM: undefined }), corrs);
  signals.rangeTriangulated = triangulated;
  check('(c) desk-recomputed depth also trips the gate', triangulated.state === 'insufficient-geometry', triangulated.state);
}

// ---------------------------------------------------------------------------
console.log('\n— stereo planarity: (d) planar at 2 m with σ ≈ 0.5 px noise —');
// ---------------------------------------------------------------------------

{
  const pts = scenePoints(41, Array.from({ length: 60 }, () => 2.0));
  const corrs = correspondencesFor(pts, { noiseSigmaPx: 0.5, seed: 42 });
  const sig = verifyStereoCommitment(makeCommitment({ focusDistanceM: 2.0 }), corrs);
  signals.noisy = sig;
  console.log('  text:', sig.text);
  check('(d) noisy planar scene still planar', sig.state === 'planar', `${sig.state} residual=${sig.residualPx}`);
  check('(d) residual under the planar ceiling', (sig.residualPx ?? 99) < PLANAR_MAX_RESIDUAL_PX, `residual=${sig.residualPx}`);
  check('(d) noise did not collapse the inlier ratio', (sig.inlierRatio ?? 0) >= 0.75, `ratio=${sig.inlierRatio}`);
}

// ---------------------------------------------------------------------------
console.log('\n— stereo planarity: (e) unsupported inputs —');
// ---------------------------------------------------------------------------

{
  const pts = scenePoints(51, Array.from({ length: 60 }, () => 1.0));
  const corrs = correspondencesFor(pts);

  const zeroBaseline = verifyStereoCommitment(makeCommitment({ focusDistanceM: 1.0, translationM: [0, 0, 0] }), corrs);
  signals.unsupportedBaseline = zeroBaseline;
  console.log('  text:', zeroBaseline.text);
  check('(e) zero baseline → unsupported', zeroBaseline.state === 'unsupported', zeroBaseline.state);
  check('(e) unsupported offers no residual number dressed as evidence', zeroBaseline.residualPx === undefined);

  const badLut = verifyStereoCommitment(makeCommitment({ focusDistanceM: 1.0, malformedLut: true }), corrs);
  check('(e) malformed LUT → unsupported', badLut.state === 'unsupported', badLut.state);

  const few = verifyStereoCommitment(makeCommitment({ focusDistanceM: 1.0 }), corrs.slice(0, 6));
  check('(e) too few correspondences → insufficient-geometry, never a number',
    few.state === 'insufficient-geometry' && few.residualPx === undefined, few.state);
  signals.few = few;
}

// ---------------------------------------------------------------------------
console.log('\n— stereo planarity: (f) distortion LUT path —');
// ---------------------------------------------------------------------------

{
  // Synthetic barrel distortion: forward displacement k·r² along the radial
  // direction (k = 0.08 — pronounced, phone-ultra-wide scale). Committed as
  // a forward LUT; the verifier must invert it.
  const K = 0.08;
  const R_DOMAIN = 0.65; // covers both frames' normalized extents
  const LW = 17;
  const LH = 13;
  const values: number[] = [];
  for (let j = 0; j < LH; j++) {
    for (let i = 0; i < LW; i++) {
      const x = ((i / (LW - 1)) * 2 - 1) * R_DOMAIN;
      const y = ((j / (LH - 1)) * 2 - 1) * R_DOMAIN;
      const r2 = x * x + y * y;
      values.push(x * K * r2, y * K * r2);
    }
  }
  const lut: DistortionLut = { width: LW, height: LH, domainRadius: R_DOMAIN, values };

  // Inverse-lookup round-trip accuracy through the full pixel path.
  let worstPx = 0;
  const rnd = mulberry32(61);
  for (let i = 0; i < 200; i++) {
    const u = 100 + rnd() * 1080;
    const v = 80 + rnd() * 800;
    const [xn, yn] = pixelToNormalized(u, v, WIDE);
    const [dxn, dyn] = distortNormalized(xn, yn, lut);
    const [ud, vd] = normalizedToPixel(dxn, dyn, WIDE);
    const [rx, ry] = undistortPixel(ud, vd, WIDE, lut);
    const [pu, pv] = normalizedToPixel(rx, ry, WIDE);
    worstPx = Math.max(worstPx, Math.hypot(pu - u, pv - v));
  }
  check('(f) inverse LUT lookup round-trips below 0.05 px', worstPx < 0.05, `worst=${worstPx.toFixed(4)} px`);

  // End-to-end: a true plane seen THROUGH the distortion must still read
  // planar — otherwise the signal would flag real flat scenes at the edges.
  const pts = scenePoints(62, Array.from({ length: 60 }, () => 1.5));
  const corrs = correspondencesFor(pts, { lut });
  const sig = verifyStereoCommitment(makeCommitment({ focusDistanceM: 1.5, distortionLut: lut }), corrs);
  signals.distorted = sig;
  check('(f) distorted projections of a true plane undistort to planar',
    sig.state === 'planar' && (sig.residualPx ?? 99) < 0.5, `${sig.state} residual=${sig.residualPx}`);
}

// ---------------------------------------------------------------------------
console.log('\n— stereo planarity: (g) honesty invariants —');
// ---------------------------------------------------------------------------

{
  for (const [name, sig] of Object.entries(signals)) {
    check(`(g) ${name}: text carries the effective-range bound`,
      sig.text.includes('Effective within roughly three meters'), sig.text.slice(0, 120));
    check(`(g) ${name}: text carries signal-not-verdict framing`,
      sig.text.includes('not a verdict'), sig.text.slice(0, 120));
    check(`(g) ${name}: no verdict vocabulary`,
      !/\bpassed\b/i.test(sig.text) && !/verified scene/i.test(sig.text) && !/\bauthentic\b/i.test(sig.text));
  }
  const states = new Set(Object.values(signals).map((s) => s.state));
  check('(g) suite exercised all four states',
    states.has('planar') && states.has('non-planar') && states.has('insufficient-geometry') && states.has('unsupported'),
    [...states].join(','));
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.log('FAILURES:', failures.join(' | '));
  process.exit(1);
}
console.log('ALL STEREO PLANARITY TESTS PASSED');

/**
 * Stereo matcher suite — the feature-extraction front end feeding
 * verifyStereoCommitment. Every fixture is rendered IN-TEST: a synthetic
 * texture is warped into two pinhole views through the committed-style
 * calibration (the wide ↔ ultra-wide rig, 12 mm baseline, small relative
 * rotation), so ground-truth planarity is known by construction.
 *
 *   (a) textured plane at 1.3 m        → matches recovered end-to-end, and
 *                                        verifyStereoCommitment on the
 *                                        REAL matcher output reads 'planar'
 *   (b) same texture, right half at    → 'non-planar' (real 3D structure;
 *       0.7 m (depth discontinuity)      NOT a verdict of authenticity)
 *   (c) flat gradient (low texture)    → few matches → 'insufficient-geometry'
 *                                        (a data limit, never a wrong verdict)
 *   (d) fixtures (a)+(b) round-tripped → same states (documents JPEG q≈85
 *       through JPEG at quality 85       compression tolerance)
 *   (e) honesty sweep: no report field or signal text says
 *       'passed'/'authentic'; the match-quality report is counts, not
 *       adjectives.
 *
 * No device data, no network. Run (staged lab):
 *   node stage.mjs && cd .staged && npm install --no-audit --no-fund
 *   && ./node_modules/.bin/tsx test-stereo-match.mts
 */
import * as jpeg from 'jpeg-js';
import {
  matchFrames,
  MATCH_METHOD_VERSION,
  EPIPOLAR_SAMPSON_PX,
  type DecodedFrame,
  type MatchReport,
} from './match.mts';
import {
  verifyStereoCommitment,
  mat3Mul,
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

// ---------------------------------------------------------------------------
// Synthetic rig — same geometry family as test-stereo-planarity.mts, plus a
// small committed relative rotation (real phone rigs are not perfectly
// parallel; the matcher must tolerate what the calibration commits).
// ---------------------------------------------------------------------------

const WIDE = { fx: 1100, fy: 1100, cx: 640, cy: 480, width: 1280, height: 960 };
const UW = { fx: 560, fy: 560, cx: 320, cy: 240, width: 640, height: 480 };
const BASELINE_T: [number, number, number] = [-0.012, 0, 0];

function rotZ(deg: number): number[] {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return [c, -s, 0, s, c, 0, 0, 0, 1];
}
function rotY(deg: number): number[] {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return [c, 0, s, 0, 1, 0, -s, 0, c];
}
/** ~1.5° roll + 0.4° pitch: mounting tolerance + hand tilt at capture. */
const RIG_R = mat3Mul(rotZ(1.5), rotY(0.4));

function makeCommitment(focusDistanceM: number | undefined): StereoCommitment {
  return {
    primaryFrameHash: 'sha256:' + '0'.repeat(64),
    secondaryFrame: { bytes: new Uint8Array([0xff, 0xd8, 0xff]) }, // decoded frames are passed directly here
    calibration: {
      intrinsicsWide: WIDE,
      intrinsicsUltraWide: UW,
      extrinsics: { rotation: RIG_R, translationM: BASELINE_T },
    },
    syncTimestampDeltaMs: 0.1,
    metadataBlock: {
      focusDistanceM,
      focalLengthMm: 4.25,
      aperture: 1.8,
      exposureS: 1 / 120,
      iso: 100,
      devicePosition: 'wide',
      antiBandingState: '60Hz',
    },
  };
}

// ---------------------------------------------------------------------------
// Synthetic scene rendering: texture plane(s) warped into both pinhole views.
// ---------------------------------------------------------------------------

/** Texture spans normalized pinhole ±SPAN_X / ±SPAN_Y — covers both FOVs. */
const TW = 1240;
const TH = 930;
const SPAN_X = 0.62;
const SPAN_Y = 0.465;

/** Multi-scale texture: octaves + blobs + pixel noise, deterministic. */
function makeTexture(seed: number): Float64Array {
  const rnd = mulberry32(seed);
  const t = new Float64Array(TW * TH);
  for (let y = 0; y < TH; y++) {
    for (let x = 0; x < TW; x++) {
      t[y * TW + x] =
        128 +
        34 * Math.sin(x / 13 + 0.7) * Math.cos(y / 19) +
        26 * Math.sin((x + 2 * y) / 37 + 1.3) * Math.sin(x / 53) +
        (rnd() - 0.5) * 70;
    }
  }
  for (let i = 0; i < 420; i++) {
    const bx = Math.floor(rnd() * TW);
    const by = Math.floor(rnd() * TH);
    const br = 1 + Math.floor(rnd() * 7);
    const v = rnd() * 255;
    for (let y = Math.max(0, by - br); y <= Math.min(TH - 1, by + br); y++) {
      for (let x = Math.max(0, bx - br); x <= Math.min(TW - 1, bx + br); x++) {
        if ((x - bx) ** 2 + (y - by) ** 2 <= br * br) t[y * TW + x] = v;
      }
    }
  }
  return t;
}

function sampleTexture(tex: Float64Array, xn: number, yn: number): number {
  const tx = Math.min(TW - 1.001, Math.max(0, (xn / (2 * SPAN_X) + 0.5) * TW));
  const ty = Math.min(TH - 1.001, Math.max(0, (yn / (2 * SPAN_Y) + 0.5) * TH));
  const x0 = Math.floor(tx);
  const y0 = Math.floor(ty);
  const fx = tx - x0;
  const fy = ty - y0;
  const a = tex[y0 * TW + x0];
  const b = tex[y0 * TW + x0 + 1];
  const c = tex[(y0 + 1) * TW + x0];
  const d = tex[(y0 + 1) * TW + x0 + 1];
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

interface SceneSpec {
  /** Depth of the main plane in the PRIMARY frame, meters. */
  mainDepthM: number;
  /** Optional nearer region: right half at a different depth. */
  region?: { xnMin: number; depthM: number };
}

function mat3Vec(m: number[], v: [number, number, number]): [number, number, number] {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}
function mat3Transpose(m: number[]): number[] {
  return [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
}

/**
 * Render the primary view: the plane(s) in normalized coords. Depth cancels
 * in the primary's own mapping (both scene planes are fronto-parallel and
 * share the texture mapping), so the region boundary shows up here only
 * through the secondary view's parallax — as it should.
 */
function renderPrimary(tex: Float64Array, _scene: SceneSpec): DecodedFrame {
  const { width: w, height: h } = WIDE;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const xn = (x - WIDE.cx) / WIDE.fx;
      const yn = (y - WIDE.cy) / WIDE.fy;
      const v = sampleTexture(tex, xn, yn);
      const o = (y * w + x) * 4;
      data[o] = data[o + 1] = data[o + 2] = v;
      data[o + 3] = 255;
    }
  }
  return { data, width: w, height: h };
}

/**
 * Render the secondary view by inverse warp through the rig transform
 * (P2 = R·P1 + t): each secondary pixel's ray is intersected with the
 * scene plane (expressed in the primary frame), then the texture is
 * sampled at the primary normalized coordinate. This IS the homography
 * warp, written out per pixel so nothing upstream of the matcher is trusted.
 */
function renderSecondary(tex: Float64Array, scene: SceneSpec): DecodedFrame {
  const { width: w, height: h } = UW;
  const data = new Uint8ClampedArray(w * h * 4);
  const Rt = mat3Transpose(RIG_R);
  const RtT = mat3Vec(Rt, BASELINE_T);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const ux = (x - UW.cx) / UW.fx;
      const uy = (y - UW.cy) / UW.fy;
      const ru = mat3Vec(Rt, [ux, uy, 1]); // Rᵀ·u2: ray in the primary frame
      // First intersect with the MAIN plane to learn which side of the
      // discontinuity this pixel is on, then reshoot at the right depth.
      let s = (scene.mainDepthM + RtT[2]) / ru[2];
      const xnMain = (s * ru[0] - RtT[0]) / scene.mainDepthM;
      const Z = scene.region && xnMain >= scene.region.xnMin ? scene.region.depthM : scene.mainDepthM;
      s = (Z + RtT[2]) / ru[2];
      const p1x = s * ru[0] - RtT[0];
      const p1y = s * ru[1] - RtT[1];
      const v = sampleTexture(tex, p1x / Z, p1y / Z);
      const o = (y * w + x) * 4;
      data[o] = data[o + 1] = data[o + 2] = v;
      data[o + 3] = 255;
    }
  }
  return { data, width: w, height: h };
}

/** Flat gradient — texture below the FAST/Harris floors by construction. */
function makeFlatPair(): { primary: DecodedFrame; secondary: DecodedFrame } {
  const mk = (w: number, h: number, phase: number): DecodedFrame => {
    const data = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const v = 120 + 14 * Math.sin(x / 240 + phase) + 10 * Math.cos(y / 190);
        const o = (y * w + x) * 4;
        data[o] = data[o + 1] = data[o + 2] = v;
        data[o + 3] = 255;
      }
    }
    return { data, width: w, height: h };
  };
  return { primary: mk(WIDE.width, WIDE.height, 0), secondary: mk(UW.width, UW.height, 0.35) };
}

function jpegRoundTrip(frame: DecodedFrame, quality: number): DecodedFrame {
  const enc = jpeg.encode(
    { data: Buffer.from(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength), width: frame.width, height: frame.height },
    quality,
  );
  const dec = jpeg.decode(enc.data, { useTArray: true });
  return { data: dec.data, width: dec.width, height: dec.height };
}

const signals: Record<string, PlanaritySignal> = {};
const reports: Record<string, MatchReport> = {};

// ---------------------------------------------------------------------------
console.log('— stereo match: (a) textured plane at 1.3 m —');
// ---------------------------------------------------------------------------

const TEX = makeTexture(7);
const SCENE_A: SceneSpec = { mainDepthM: 1.3 };
const aPrimary = renderPrimary(TEX, SCENE_A);
const aSecondary = renderSecondary(TEX, SCENE_A);

let aResult: ReturnType<typeof matchFrames>;
{
  const t0 = Date.now();
  aResult = matchFrames(aPrimary, aSecondary, makeCommitment(1.3).calibration);
  const elapsedMs = Date.now() - t0;
  reports.a = aResult.report;
  const r = aResult.report;
  console.log(`  pipeline ${elapsedMs.toFixed(0)} ms; timings:`, JSON.stringify(r.timingsMs));
  console.log(
    `  primary ${r.primary.rawFastCorners} FAST → ${r.primary.keptCorners} kept; ` +
      `secondary ${r.secondary.rawFastCorners} FAST → ${r.secondary.keptCorners} kept; ` +
      `matches: cross-check ${r.matchesAfterCrossCheck}, ratio(A-side) ${r.matchesAfterRatio}, ` +
      `epipolar ${r.matchesAfterEpipolar}`,
  );
  check('(a) corners detected in both views', r.primary.keptCorners > 50 && r.secondary.keptCorners > 50,
    `kept ${r.primary.keptCorners}/${r.secondary.keptCorners}`);
  check('(a) raw FAST ≥ kept corners (filtering, not fabrication)',
    r.primary.rawFastCorners >= r.primary.keptCorners && r.secondary.rawFastCorners >= r.secondary.keptCorners);
  check('(a) enough matches survive the epipolar gate', r.matchesAfterEpipolar >= 40, `${r.matchesAfterEpipolar}`);
  check('(a) full pipeline under 30 s', elapsedMs < 30_000, `${elapsedMs} ms`);

  let inBounds = true;
  for (const c of aResult.correspondences) {
    const [px, py] = c.primary;
    const [sx, sy] = c.secondary;
    if (!(px >= 0 && px < WIDE.width && py >= 0 && py < WIDE.height)) inBounds = false;
    if (!(sx >= 0 && sx < UW.width && sy >= 0 && sy < UW.height)) inBounds = false;
  }
  check('(a) correspondences are in ORIGINAL pixel coordinates of both frames', inBounds);

  const again = matchFrames(aPrimary, aSecondary, makeCommitment(1.3).calibration);
  check('(a) deterministic: same frames → same correspondences',
    JSON.stringify(again.correspondences) === JSON.stringify(aResult.correspondences));

  const sig = verifyStereoCommitment(makeCommitment(1.3), aResult.correspondences);
  signals.a = sig;
  console.log('  text:', sig.text);
  check('(a) real matcher output verifies planar', sig.state === 'planar',
    `${sig.state} residual=${sig.residualPx} ratio=${sig.inlierRatio}`);
  check('(a) inlier ratio above the planar floor', (sig.inlierRatio ?? 0) >= 0.75, `ratio=${sig.inlierRatio}`);
}

// ---------------------------------------------------------------------------
console.log('\n— stereo match: (b) depth discontinuity (right half at 0.7 m) —');
// ---------------------------------------------------------------------------

let bResult: ReturnType<typeof matchFrames>;
{
  const sceneB: SceneSpec = { mainDepthM: 1.3, region: { xnMin: 0.0, depthM: 0.7 } };
  const bPrimary = renderPrimary(TEX, sceneB);
  const bSecondary = renderSecondary(TEX, sceneB);
  bResult = matchFrames(bPrimary, bSecondary, makeCommitment(1.0).calibration);
  reports.b = bResult.report;
  console.log(
    `  matches: cross-check ${bResult.report.matchesAfterCrossCheck}, epipolar ${bResult.report.matchesAfterEpipolar}`,
  );
  check('(b) matches exist on both depth layers', bResult.correspondences.length >= 40,
    `${bResult.correspondences.length}`);
  const bothSides = { left: 0, right: 0 };
  for (const c of bResult.correspondences) {
    if (c.primary[0] >= WIDE.cx) bothSides.right++;
    else bothSides.left++;
  }
  check('(b) correspondences span the discontinuity', bothSides.left >= 20 && bothSides.right >= 20,
    JSON.stringify(bothSides));
  const sig = verifyStereoCommitment(makeCommitment(1.0), bResult.correspondences);
  signals.b = sig;
  console.log('  text:', sig.text);
  check('(b) depth discontinuity reads non-planar', sig.state === 'non-planar',
    `${sig.state} residual=${sig.residualPx} ratio=${sig.inlierRatio}`);
  check('(b) text frames 3D-structure-not-verdict', sig.text.includes('NOT a verdict of authenticity'));
}

// ---------------------------------------------------------------------------
console.log('\n— stereo match: (c) low-texture gradient —');
// ---------------------------------------------------------------------------

{
  const { primary, secondary } = makeFlatPair();
  const res = matchFrames(primary, secondary, makeCommitment(1.0).calibration);
  reports.c = res.report;
  console.log(
    `  kept corners ${res.report.primary.keptCorners}/${res.report.secondary.keptCorners}, ` +
      `matches after epipolar ${res.report.matchesAfterEpipolar}`,
  );
  check('(c) flat gradient yields few matches', res.correspondences.length < 12,
    `${res.correspondences.length}`);
  const sig = verifyStereoCommitment(makeCommitment(1.0), res.correspondences);
  signals.c = sig;
  console.log('  text:', sig.text);
  check('(c) insufficient-geometry, not a wrong verdict', sig.state === 'insufficient-geometry', sig.state);
  check('(c) text frames data-limit-not-suspicion', sig.text.includes('not suspicion'));
}

// ---------------------------------------------------------------------------
console.log('\n— stereo match: (d) JPEG quality 85 round-trip —');
// ---------------------------------------------------------------------------

{
  const q = 85;
  const sceneB: SceneSpec = { mainDepthM: 1.3, region: { xnMin: 0.0, depthM: 0.7 } };
  const aP = jpegRoundTrip(renderPrimary(TEX, SCENE_A), q);
  const aS = jpegRoundTrip(renderSecondary(TEX, SCENE_A), q);
  const resA = matchFrames(aP, aS, makeCommitment(1.3).calibration);
  reports.dPlanar = resA.report;
  const sigA = verifyStereoCommitment(makeCommitment(1.3), resA.correspondences);
  signals.dPlanar = sigA;
  console.log('  (a)@q85 text:', sigA.text);
  check('(d) planar scene still planar after JPEG q85', sigA.state === 'planar',
    `${sigA.state} residual=${sigA.residualPx} ratio=${sigA.inlierRatio}`);

  const bP = jpegRoundTrip(renderPrimary(TEX, sceneB), q);
  const bS = jpegRoundTrip(renderSecondary(TEX, sceneB), q);
  const resB = matchFrames(bP, bS, makeCommitment(1.0).calibration);
  reports.dNonPlanar = resB.report;
  const sigB = verifyStereoCommitment(makeCommitment(1.0), resB.correspondences);
  signals.dNonPlanar = sigB;
  console.log('  (b)@q85 text:', sigB.text);
  check('(d) depth discontinuity still non-planar after JPEG q85', sigB.state === 'non-planar',
    `${sigB.state} residual=${sigB.residualPx} ratio=${sigB.inlierRatio}`);
}

// ---------------------------------------------------------------------------
console.log('\n— stereo match: (e) honesty sweep —');
// ---------------------------------------------------------------------------

{
  for (const [name, rep] of Object.entries(reports)) {
    const json = JSON.stringify(rep);
    check(`(e) report ${name}: counts, not adjectives`,
      !/\bpassed\b/i.test(json) && !/\bauthentic\w*\b/i.test(json) && !/\bgenuine\b/i.test(json) &&
        !/\bsuccess\b/i.test(json) && !/\bfail(ed|ure)?\b/i.test(json));
    check(`(e) report ${name}: stage counts are monotone-sane`,
      rep.matchesAfterCrossCheck >= rep.matchesAfterEpipolar &&
        rep.matchesAfterEpipolar === rep.finalCorrespondences &&
        rep.primary.rawFastCorners >= rep.primary.keptCorners &&
        rep.secondary.rawFastCorners >= rep.secondary.keptCorners);
  }
  for (const [name, sig] of Object.entries(signals)) {
    check(`(e) signal ${name}: no verdict vocabulary`,
      !/\bpassed\b/i.test(sig.text) && !/\bauthentic\b/i.test(sig.text), sig.text.slice(0, 100));
    check(`(e) signal ${name}: carries signal-not-verdict framing`, sig.text.includes('not a verdict'));
  }
  check('(e) method version is stamped on every report',
    Object.values(reports).every((r) => r.methodVersion === MATCH_METHOD_VERSION));
}

// ---------------------------------------------------------------------------
console.log('\n— stereo match: (f) epipolar survival rate —');
// ---------------------------------------------------------------------------

{
  for (const [name, rep] of Object.entries(reports)) {
    const s = rep.epipolarSurvivalRate;
    check(`(f) ${name}: survival-rate fields consistent with stage counts`,
      !!s &&
        s.threshold === EPIPOLAR_SAMPSON_PX &&
        s.inliers === rep.matchesAfterEpipolar &&
        s.total === rep.matchesAfterCrossCheck &&
        (s.total === 0
          ? s.value === 0
          : Math.abs(s.value - s.inliers / s.total) < 1e-12) &&
        s.value >= 0 && s.value <= 1,
      JSON.stringify(s));
  }
  check('(f) textured plane: most putative matches survive the epipolar gate',
    reports.a.epipolarSurvivalRate.total > 0 && reports.a.epipolarSurvivalRate.value >= 0.5,
    JSON.stringify(reports.a.epipolarSurvivalRate));
  // The signal is a characterization, never a verdict: no banned vocabulary.
  for (const [name, rep] of Object.entries(reports)) {
    const json = JSON.stringify(rep.epipolarSurvivalRate);
    check(`(f) ${name}: survival rate is counts, not adjectives`,
      !/\bpassed\b/i.test(json) && !/\bauthentic\w*\b/i.test(json) &&
        !/\bfail(ed|ure)?\b/i.test(json));
  }
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.log('FAILURES:', failures.join(' | '));
  process.exit(1);
}
console.log('ALL STEREO MATCH TESTS PASSED');

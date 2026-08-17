// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Parallax analyzer suite — synthetic scenes with KNOWN geometry.
 *
 *   - a FLAT scene (one plane, known similarity warp per frame) must
 *     measure planar-consistent: small planar residual, small depth spread;
 *   - a 3D scene (two planes at different depths, different parallax shift)
 *     must show depth spread MATERIALLY above the flat scene's;
 *   - gyro-integrated rotation compensation must recover a rotated burst;
 *   - every insufficient-data path must say 'insufficient' with the specific
 *     reason — never a number dressed up as evidence.
 *
 * Frames are synthesized as RGBA, round-tripped through jpeg-js (the same
 * codec the desk CLI uses on ring dumps), and analyzed as luma rasters.
 * No network, no ffmpeg.
 *
 * Run (staged lab): node stage.mjs && cd .staged && npm install --no-audit --no-fund
 *   && ./node_modules/.bin/tsx test-parallax.mts
 */
import * as jpeg from 'jpeg-js';
import {
  analyzeParallaxBurst, parseSensorLogJsonl, grayPlaneFromRgba,
  PARALLAX_METHOD_VERSION, type GrayPlane, type GyroLog,
} from './parallax.mts';

let passed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failures.push(name); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

// ---------------------------------------------------------------------------
// Synthetic scene rendering
// ---------------------------------------------------------------------------

const FW = 320; // frame size = analysis raster (long side 320 → scale 1)
const FH = 240;
const WW = 480; // world canvas the "camera" crops warps from
const WH = 360;
const N_FRAMES = 8;

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

/** Multi-scale textured world: blobs + gratings + fine noise, deterministic. */
function makeWorld(seed: number): Float64Array {
  const rnd = mulberry32(seed);
  const w = new Float64Array(WW * WH);
  for (let y = 0; y < WH; y++) {
    for (let x = 0; x < WW; x++) {
      w[y * WW + x] =
        128 +
        40 * Math.sin(x / 17 + 1) * Math.cos(y / 23) +
        30 * Math.sin((x + y) / 41) +
        (rnd() - 0.5) * 60;
    }
  }
  // Large distinctive blobs so block matches are unambiguous.
  for (let i = 0; i < 260; i++) {
    const bx = Math.floor(rnd() * WW);
    const by = Math.floor(rnd() * WH);
    const br = 2 + Math.floor(rnd() * 6);
    const v = rnd() * 255;
    for (let y = Math.max(0, by - br); y <= Math.min(WH - 1, by + br); y++) {
      for (let x = Math.max(0, bx - br); x <= Math.min(WW - 1, bx + br); x++) {
        if ((x - bx) ** 2 + (y - by) ** 2 <= br * br) w[y * WW + x] = v;
      }
    }
  }
  return w;
}

function sampleBilinear(world: Float64Array, x: number, y: number): number {
  const x0 = Math.max(0, Math.min(WW - 2, Math.floor(x)));
  const y0 = Math.max(0, Math.min(WH - 2, Math.floor(y)));
  const fx = Math.max(0, Math.min(1, x - x0));
  const fy = Math.max(0, Math.min(1, y - y0));
  return (
    world[y0 * WW + x0] * (1 - fx) * (1 - fy) + world[y0 * WW + x0 + 1] * fx * (1 - fy) +
    world[(y0 + 1) * WW + x0] * (1 - fx) * fy + world[(y0 + 1) * WW + x0 + 1] * fx * fy
  );
}

export interface WarpSpec {
  /** Camera translation this frame, px (per scene region when two-depth). */
  nearX: number;
  nearY: number;
  farX?: number;
  farY?: number;
  /** Content rotation about the frame center, rad. */
  rot: number;
  /** Region boundary (out-frame x): left = near plane, right = far plane. */
  splitX?: number;
}

/** Render one frame: world coord = R(rot)·(p − c) + c + center + offset(region). */
function renderFrame(world: Float64Array, spec: WarpSpec): Uint8Array {
  const rgba = new Uint8Array(FW * FH * 4);
  const cx = FW / 2;
  const cy = FH / 2;
  const cos = Math.cos(spec.rot);
  const sin = Math.sin(spec.rot);
  for (let y = 0; y < FH; y++) {
    for (let x = 0; x < FW; x++) {
      const near = spec.splitX === undefined || x < spec.splitX;
      const ox = near ? spec.nearX : spec.farX!;
      const oy = near ? spec.nearY : spec.farY!;
      const rx = x - cx;
      const ry = y - cy;
      const wx = cos * rx - sin * ry + cx + ox + (WW - FW) / 2;
      const wy = sin * rx + cos * ry + cy + oy + (WH - FH) / 2;
      const v = Math.max(0, Math.min(255, Math.round(sampleBilinear(world, wx, wy))));
      const o = (y * FW + x) * 4;
      rgba[o] = v;
      rgba[o + 1] = v;
      rgba[o + 2] = v;
      rgba[o + 3] = 255;
    }
  }
  return rgba;
}

/** RGBA → JPEG(q90) → decode → luma raster: the real codec path the CLI runs. */
function jpegRoundTrip(rgba: Uint8Array): GrayPlane {
  const enc = jpeg.encode({ data: rgba, width: FW, height: FH }, 90);
  const dec = jpeg.decode(enc.data, { maxMemoryUsageInMB: 64 });
  return grayPlaneFromRgba(dec.data, dec.width, dec.height, 320);
}

function burstPlanes(world: Float64Array, specs: WarpSpec[]): GrayPlane[] {
  return specs.map((s) => jpegRoundTrip(renderFrame(world, s)));
}

/** Constant-rate gyro log: 100 Hz, y-axis roll, covering the whole burst. */
function makeGyroLog(rollRadPerSec: number): GyroLog {
  const lines: string[] = ['{"kind":"anchor","startedAtMs":1754000000000,"clock":"mach"}'];
  const totalSec = 0.27; // generously covers 8 frames at 1/30 s
  for (let i = 0; i <= Math.round(totalSec * 100); i++) {
    lines.push(JSON.stringify({ t: i / 100, kind: 'gyro', x: 0, y: rollRadPerSec, z: 0 }));
  }
  return parseSensorLogJsonl(lines.join('\n'));
}

// ---------------------------------------------------------------------------
// Scenes
// ---------------------------------------------------------------------------

console.log('\n— parallax: synthetic flat scene (no gyro, small rotation) —');

const worldFlat = makeWorld(42);
// Handheld-like burst: 2 px/frame drift + tiny rotation (0.002 rad/frame,
// 0.014 rad total — under the gyro-less large-rotation refusal).
const flatSpecs: WarpSpec[] = Array.from({ length: N_FRAMES }, (_, k) => ({
  nearX: 2 * k,
  nearY: 0.6 * k,
  rot: 0.002 * k,
}));
const flat = analyzeParallaxBurst(burstPlanes(worldFlat, flatSpecs));

check('flat: measurement produced (not insufficient)', flat.insufficient === false, String(flat.insufficient));
check('flat: tracks used ≥ 30', flat.tracksUsed >= 30, `tracks=${flat.tracksUsed}`);
check('flat: rotation compensated from image fit (no gyro → flag false)', flat.rotationCompensated === false);
check('flat: planar residual median ≤ 2 px', flat.planarResidualPx.median <= 2, `median=${flat.planarResidualPx.median} p90=${flat.planarResidualPx.p90}`);
check('flat: depth spread small (≤ 6 disparity-px)', flat.depthSpreadEstimate.value <= 6, `spread=${flat.depthSpreadEstimate.value}`);
check('flat: inlier ratio ≥ 0.6', flat.inlierRatio >= 0.6, `inlier=${flat.inlierRatio}`);
check('flat: baseline measured ≥ 10 px', flat.baselinePx >= 10, `baseline=${flat.baselinePx}`);
check('flat: method version + corpus limitation fixed',
  flat.methodVersion === PARALLAX_METHOD_VERSION && flat.limitations.some((l) => l.includes('corpus characterization pending; no error rates published')));

console.log('\n— parallax: synthetic flat scene WITH gyro rotation compensation —');

// Same drift but real rotation: 0.01 rad/frame (0.07 rad total) — refused
// without a gyro; must succeed with one.
const rotSpecs: WarpSpec[] = Array.from({ length: N_FRAMES }, (_, k) => ({
  nearX: 2 * k,
  nearY: 0.5 * k,
  rot: 0.01 * k,
}));
const gyro = makeGyroLog(0.01 * 30); // 0.01 rad/frame at 30 fps = 0.3 rad/s
const flatGyro = analyzeParallaxBurst(burstPlanes(worldFlat, rotSpecs), { gyro });

check('gyro: measurement produced (not insufficient)', flatGyro.insufficient === false, String(flatGyro.insufficient));
check('gyro: rotationCompensated=true', flatGyro.rotationCompensated === true);
check('gyro: gyroPriorAuthenticated is literal false (sidecar is unauthenticated this phase)',
  flatGyro.gyroPriorAuthenticated === false && flat.gyroPriorAuthenticated === false);
check('gyro: planar residual median ≤ 2 px', flatGyro.planarResidualPx.median <= 2, `median=${flatGyro.planarResidualPx.median} p90=${flatGyro.planarResidualPx.p90}`);
check('gyro: depth spread small (≤ 6 disparity-px)', flatGyro.depthSpreadEstimate.value <= 6, `spread=${flatGyro.depthSpreadEstimate.value}`);
check('gyro: limitations disclose the gyro-prior use', flatGyro.limitations.some((l) => l.includes('geometric prior')));
check('gyro: limitations ALWAYS disclose the unauthenticated sidecar',
  flat.limitations.some((l) => l.includes('unauthenticated sidecar')) &&
  flatGyro.limitations.some((l) => l.includes('unauthenticated sidecar')));

console.log('\n— parallax: FORGED gyro log at 4× the true rate —');

// The severe attack: the sensor log is an unauthenticated sidecar, and a
// cosine-only gate is scale-invariant — a forged log with the true
// rotation's shape at 4× its rate passes with cos=1.00 and injects an
// affine de-rotation error that makes a FLAT burst read depthSpread 47 px
// (honest: ~2.7 px; a real 3D scene: ~21 px). The magnitude gate must
// refuse the forged prior and fall back to image-fit compensation.
const forged4x = makeGyroLog(4 * 0.01 * 30); // 4× the true 0.3 rad/s
const forgedBig = analyzeParallaxBurst(burstPlanes(worldFlat, rotSpecs), { gyro: forged4x });
check('forged 4×: gyro prior REFUSED (rotationCompensated=false), not silently used',
  forgedBig.rotationCompensated === false);
check('forged 4×: magnitude disagreement named in the limitations',
  forgedBig.limitations.some((l) => l.includes('MAGNITUDE') && l.includes('NOT used')),
  forgedBig.limitations.filter((l) => l.includes('gyro')).join(' | '));
check('forged 4×: fallback to image-fit with large rotation is refused as insufficient (clean handling, no fabricated numbers)',
  typeof forgedBig.insufficient === 'string' && forgedBig.insufficient.includes('no usable gyro log') &&
  forgedBig.depthSpreadEstimate.value === 0, String(forgedBig.insufficient));

// Same forgery against the small-rotation burst: the fallback is usable
// there, so the measurement must survive with the honest (small) spread.
const forgedSmall = analyzeParallaxBurst(burstPlanes(worldFlat, flatSpecs), { gyro: forged4x });
check('forged 4× on small-rotation burst: falls back to image fit and still measures',
  forgedSmall.insufficient === false && forgedSmall.rotationCompensated === false, String(forgedSmall.insufficient));
check('forged 4× on small-rotation burst: depth spread stays the HONEST small value (attack neutralized)',
  forgedSmall.depthSpreadEstimate.value <= 6, `spread=${forgedSmall.depthSpreadEstimate.value}`);

// Sanity: an honest log at the true rate still passes the magnitude gate
// (the flatGyro case above), and a mildly noisy log within tolerance does too.
const noisyGyro = makeGyroLog(0.01 * 30 * 1.1); // +10% — inside the 20% tolerance
const noisy = analyzeParallaxBurst(burstPlanes(worldFlat, rotSpecs), { gyro: noisyGyro });
check('within-tolerance gyro (+10% rate) still compensates',
  noisy.rotationCompensated === true && noisy.insufficient === false, String(noisy.insufficient));

console.log('\n— parallax: synthetic 3D scene (two depths) —');

const world3d = makeWorld(7);
// Near plane (left half) shifts 4 px/frame, far plane (right half) 1 px/frame.
const specs3d: WarpSpec[] = Array.from({ length: N_FRAMES }, (_, k) => ({
  nearX: 4 * k,
  nearY: 0,
  farX: 1 * k,
  farY: 0,
  rot: 0,
  splitX: 160,
}));
const deep = analyzeParallaxBurst(burstPlanes(world3d, specs3d));

check('3D: measurement produced (not insufficient)', deep.insufficient === false, String(deep.insufficient));
check('3D: tracks used ≥ 30', deep.tracksUsed >= 30, `tracks=${deep.tracksUsed}`);
check('3D: depth spread materially above flat scene',
  deep.depthSpreadEstimate.value > Math.max(10, 3 * flat.depthSpreadEstimate.value),
  `3d=${deep.depthSpreadEstimate.value} flat=${flat.depthSpreadEstimate.value}`);
check('3D: planar residual p90 materially above flat scene (single homography cannot explain it)',
  deep.planarResidualPx.p90 > Math.max(4, 3 * flat.planarResidualPx.p90),
  `3d=${deep.planarResidualPx.p90} flat=${flat.planarResidualPx.p90}`);
check('3D: common-direction model fits better than planar (translational parallax)',
  deep.depthModelResidualPx !== null && deep.depthModelResidualPx.median < deep.planarResidualPx.median,
  `depth=${deep.depthModelResidualPx?.median} planar=${deep.planarResidualPx.median}`);

console.log('\n— parallax: insufficient-data paths (reasons, never numbers) —');

const few = analyzeParallaxBurst([...burstPlanes(worldFlat, flatSpecs).slice(0, 4), null, null, null, null]);
check('insufficient: <5 decodable frames refused with reason',
  typeof few.insufficient === 'string' && few.insufficient.includes('decodable'), String(few.insufficient));
check('insufficient: <5 frames offers no measurement numbers',
  few.tracksUsed === 0 && few.planarResidualPx.median === 0 && few.depthSpreadEstimate.value === 0);

const blank: GrayPlane = { width: FW, height: FH, gray: new Float64Array(FW * FH).fill(128) };
const featureless = analyzeParallaxBurst(Array.from({ length: N_FRAMES }, () => blank));
check('insufficient: featureless burst refused with track-count reason',
  typeof featureless.insufficient === 'string' && featureless.insufficient.includes('feature tracks'), String(featureless.insufficient));

const noGyroBigRot = analyzeParallaxBurst(burstPlanes(worldFlat, rotSpecs));
check('insufficient: gyro absent + large rotation refused with reason',
  typeof noGyroBigRot.insufficient === 'string' && noGyroBigRot.insufficient.includes('no usable gyro log'), String(noGyroBigRot.insufficient));

const stillSpecs: WarpSpec[] = Array.from({ length: N_FRAMES }, () => ({ nearX: 0, nearY: 0, rot: 0 }));
const still = analyzeParallaxBurst(burstPlanes(worldFlat, stillSpecs));
check('insufficient: static burst refused with baseline reason',
  typeof still.insufficient === 'string' && still.insufficient.includes('barely moved'), String(still.insufficient));

console.log('\n— parallax: sensor-log parsing honesty —');

const parsed = parseSensorLogJsonl(
  '{"kind":"anchor","startedAtMs":1}\n{"t":0.0,"kind":"gyro","x":0,"y":0.3,"z":0}\nnot-json\n{"t":0.01,"kind":"accel","x":0,"y":0,"z":-9.8}\n{"t":0.01,"kind":"gyro","x":0,"y":0.3,"z":0}\n',
);
check('parser: gyro samples kept, accel/anchor skipped, malformed counted',
  parsed.tMs.length === 2 && parsed.anchor !== null && parsed.issues.some((i) => i.includes('malformed')),
  JSON.stringify({ n: parsed.tMs.length, issues: parsed.issues }));

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.log('FAILURES:', failures.join(' | '));
  process.exit(1);
}
console.log('ALL PARALLAX TESTS PASSED');

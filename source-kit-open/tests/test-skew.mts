// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Rolling-shutter skew vs IMU suite — synthetic frames
 * with KNOWN row-time skew:
 *
 *   - frames rendered with a KNOWN per-row vertical displacement gradient
 *     (dy = g·row + c, the rolling-shutter signature under rotation) must
 *     measure a slope ≈ g;
 *   - a gyro log whose rate series tracks the per-pair gradient must show
 *     strong shape consistency (resolved axis disclosed);
 *   - an UNRELATED gyro log must NOT be injected — consistency reports
 *     not-measurable and says why; a missing gyro reports not-available;
 *   - featureless / too-few frames report 'insufficient' with the specific
 *     reason — never a number dressed up as evidence.
 *
 * The design rules are asserted verbatim: no score, no probability, no
 * verdict — per-pair numbers raw.
 *
 * No network, no ffmpeg.
 *
 * Run (staged lab): node stage.mjs && cd .staged && npm install --no-audit --no-fund
 *   && ./node_modules/.bin/tsx test-skew.mts
 */
import {
  analyzeRollingShutterSkew, SKEW_METHOD_VERSION,
} from './rollingShutter.mts';
import { parseSensorLogJsonl, type GrayPlane, type GyroLog } from './parallax.mts';

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

const FW = 160;
const FH = 120;
const WW = 240;
const WH = 200;
const FPS = 10;
const NOW = new Date('2026-08-05T12:00:00Z');

/** High-contrast deterministic texture (noise + blobs), like the parallax suite's world. */
function makeWorld(seed: number): Float64Array {
  const rnd = mulberry32(seed);
  const w = new Float64Array(WW * WH);
  for (let y = 0; y < WH; y++) {
    for (let x = 0; x < WW; x++) {
      w[y * WW + x] = 128 + 50 * Math.sin(x / 9 + 1) * Math.cos(y / 7) + (rnd() - 0.5) * 140;
    }
  }
  for (let i = 0; i < 160; i++) {
    const bx = Math.floor(rnd() * WW);
    const by = Math.floor(rnd() * WH);
    const br = 2 + Math.floor(rnd() * 5);
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
  const fx = x - x0;
  const fy = y - y0;
  return (
    world[y0 * WW + x0] * (1 - fx) * (1 - fy) + world[y0 * WW + x0 + 1] * fx * (1 - fy) +
    world[(y0 + 1) * WW + x0] * (1 - fx) * fy + world[(y0 + 1) * WW + x0 + 1] * fx * fy
  );
}

/**
 * Frame k of a synthetic rolling-shutter clip: pair k gets the incremental
 * per-row warp dy(row) = g_k·row + c (rows read later are displaced more —
 * the skew signature of rotation during readout). W_k(row) = Σ_{j≤k}(g_j·row + c).
 */
function renderClip(world: Float64Array, gradients: number[], c: number): GrayPlane[] {
  const frames: GrayPlane[] = [];
  let accG = 0;
  let accC = 0;
  for (let k = 0; k <= gradients.length; k++) {
    if (k > 0) {
      accG += gradients[k - 1];
      accC += c;
    }
    const gray = new Float64Array(FW * FH);
    for (let y = 0; y < FH; y++) {
      const warp = accG * y + accC;
      for (let x = 0; x < FW; x++) {
        const v = sampleBilinear(world, x + 40, y + 40 - warp);
        gray[y * FW + x] = Math.max(0, Math.min(255, v));
      }
    }
    frames.push({ width: FW, height: FH, gray });
  }
  return frames;
}

/** Gyro log at 100 Hz: x-axis rate piecewise-constant per pair, ∝ the pair's gradient. */
function makeGyroLog(ratePerPair: number[], fps: number): GyroLog {
  const lines: string[] = ['{"kind":"anchor","startedAtMs":1754000000000}'];
  const totalSec = ratePerPair.length / fps;
  for (let i = 0; i <= Math.round(totalSec * 100); i++) {
    const t = i / 100;
    const pair = Math.min(ratePerPair.length - 1, Math.floor(t * fps));
    lines.push(JSON.stringify({ t, kind: 'gyro', x: ratePerPair[pair], y: 0, z: 0 }));
  }
  return parseSensorLogJsonl(lines.join('\n'));
}

console.log('\n— skew: known gradients + consistent gyro —');

const world = makeWorld(17);
const GRADS = [0.02, 0.03, 0.04, 0.05, 0.035];
{
  const frames = renderClip(world, GRADS, 1);
  const gyro = makeGyroLog(GRADS.map((g) => g * 100), FPS); // ω ∝ g, x-axis
  const ev = analyzeRollingShutterSkew(frames, { gyro, frameIntervalSec: 1 / FPS, now: NOW });
  check('measured (not insufficient)', ev.insufficient === false, String(ev.insufficient));
  check('per-pair slopes recovered in order (≥3 of 5 within ±0.015 of the known gradient)',
    ev.perPair.filter((p, i) => Math.abs(p.bandGradientPxPerRow - GRADS[i]) <= 0.015).length >= 3,
    JSON.stringify(ev.perPair.map((p) => p.bandGradientPxPerRow)));
  check('skew estimate unit + no-time honesty note fixed',
    ev.skewEstimate !== null && ev.skewEstimate.unit === 'px-per-row-at-analysis-raster' &&
    ev.skewEstimate.note.includes('NOT a time'));
  check('gyro consistency measured with resolved axis disclosed',
    ev.gyroConsistency !== null && ev.gyroConsistency.axisResolved.includes('x-axis'),
    JSON.stringify(ev.gyroConsistency));
  check('gyro consistency correlation strong (≥ 0.8)',
    ev.gyroConsistency !== null && ev.gyroConsistency.correlation !== null && ev.gyroConsistency.correlation >= 0.8,
    `r=${ev.gyroConsistency?.correlation}`);
  check('gyroPriorAuthenticated literal false (sidecar unauthenticated)', ev.gyroPriorAuthenticated === false);
  check('G1 rules stated verbatim in limitations',
    ev.limitations.some((l) => l.includes('no ML score, no metadata-statistical score, no combined probability, no per-frame aggregation')));
  check('corpus characterization pending limitation fixed',
    ev.limitations.some((l) => l.includes('corpus characterization pending; no error rates published')));
  check('method version + injected clock', ev.methodVersion === SKEW_METHOD_VERSION && ev.computedAt === NOW.toISOString());
}

console.log('\n— skew: UNRELATED gyro log is not injected —');

{
  const frames = renderClip(world, GRADS, 1);
  // Constant-rate gyro: no relation to the varying slope series.
  const gyro = makeGyroLog([0.5, 0.5, 0.5, 0.5, 0.5], FPS);
  const ev = analyzeRollingShutterSkew(frames, { gyro, frameIntervalSec: 1 / FPS, now: NOW });
  check('skew still measured', ev.insufficient === false, String(ev.insufficient));
  check('consistency NOT measured (no axis relates), reason disclosed',
    ev.gyroConsistency === null && ev.limitations.some((l) => l.includes('no axis related to the skew slope series')),
    ev.limitations.filter((l) => l.includes('gyro') || l.includes('axis')).join(' | '));
}

console.log('\n— skew: no gyro — skew measured, consistency honestly not available —');

{
  const frames = renderClip(world, GRADS, 1);
  const ev = analyzeRollingShutterSkew(frames, { frameIntervalSec: 1 / FPS, now: NOW });
  check('skew measured without gyro', ev.insufficient === false && ev.skewEstimate !== null, String(ev.insufficient));
  check('gyroConsistency null + NOT AVAILABLE disclosed',
    ev.gyroConsistency === null && ev.limitations.some((l) => l.includes('NOT AVAILABLE')),
    ev.limitations.filter((l) => l.includes('gyro')).join(' | '));
}

console.log('\n— skew: insufficient-data paths (reasons, never numbers) —');

{
  const blank: GrayPlane = { width: FW, height: FH, gray: new Float64Array(FW * FH).fill(128) };
  const evFlat = analyzeRollingShutterSkew(Array.from({ length: 6 }, () => blank), { frameIntervalSec: 1 / FPS, now: NOW });
  check('featureless clip → insufficient with pair-count reason',
    evFlat.status === 'insufficient' && typeof evFlat.insufficient === 'string' && evFlat.insufficient.includes('usable frame pairs'),
    String(evFlat.insufficient));
  check('featureless clip → no skew number, no per-pair rows',
    evFlat.skewEstimate === null && evFlat.perPair.length === 0);

  const frames = renderClip(world, GRADS, 1);
  const evFew = analyzeRollingShutterSkew(frames.slice(0, 3), { frameIntervalSec: 1 / FPS, now: NOW });
  check('<4 frames → insufficient with frame-count reason',
    evFew.status === 'insufficient' && typeof evFew.insufficient === 'string' && evFew.insufficient.includes('decodable'),
    String(evFew.insufficient));

  const evNull = analyzeRollingShutterSkew(null, { frameIntervalSec: 1 / FPS, now: NOW });
  check('absent frames → "not available", never fabricated',
    evNull.status === 'insufficient' && typeof evNull.insufficient === 'string' && evNull.insufficient.includes('not available'),
    String(evNull.insufficient));
}

console.log('\n— skew: determinism —');

{
  const a = analyzeRollingShutterSkew(renderClip(world, GRADS, 1), { frameIntervalSec: 1 / FPS, now: NOW });
  const b = analyzeRollingShutterSkew(renderClip(world, GRADS, 1), { frameIntervalSec: 1 / FPS, now: NOW });
  check('identical input + clock → identical evidence', JSON.stringify(a) === JSON.stringify(b));
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.log('FAILURES:', failures.join(' | '));
  process.exit(1);
}
console.log('ALL ROLLING-SHUTTER SKEW TESTS PASSED');

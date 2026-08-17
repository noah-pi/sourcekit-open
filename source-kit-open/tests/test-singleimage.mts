// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * P5 single-image physics checks — synthetic-fixture suite.
 *
 * Every fixture is generated in-test with KNOWN structure, and the analyzer
 * (desk/singleimage/*) must land on the state the geometry dictates:
 *
 *   (a) channels warped by a radial CA field → 'consistent-radial';
 *   (b) uniform channel shift (screen-recapture tell) → 'no-radial-structure';
 *   (c) JPEG-compressed buffer presented as raw-linear → 'grid-detected';
 *   (d) clean synthetic RAW-noise buffer → 'no-grid';
 *   (e) Poisson-noise fixture → 'expected-profile'; uniform-noise fixture →
 *       'anomalous-profile'; committed reference pattern → 'reference-match';
 *   (f) jpegGrid on declared 'jpeg-delivery' pixels → 'not-applicable'
 *       (the provenance gate — never a false positive factory);
 *   (g) honesty sweep: no output string contains 'passed' / 'authentic' /
 *       'verified', and every check text carries the uncharacterized-error
 *       framing.
 *
 * Run (staged lab): node stage.mjs && cd .staged && npm install --no-audit --no-fund
 *   && tsx test-singleimage.mts
 */
import { createRequire } from 'node:module';
import {
  analyzeSingleImage,
  SINGLE_IMAGE_LIMITATIONS,
} from './singleimageIndex.mts';
import { analyzeCaRadial } from './caRadial.mts';
import { analyzeJpegGrid, fft2dMagnitudes } from './jpegGrid.mts';
import { analyzePoissonPrnu } from './poissonPrnu.mts';

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name} :: ${detail}`); }
};
const section = (t: string) => console.log(`\n— ${t} —`);

const require = createRequire(import.meta.url);
const jpeg = require('jpeg-js') as {
  encode(img: { data: Uint8Array; width: number; height: number }, quality?: number): { data: Uint8Array };
  decode(data: Uint8Array): { width: number; height: number; data: Uint8Array };
};

// ---------------------------------------------------------------------------
// Synthetic image machinery (known structure, deterministic).
// ---------------------------------------------------------------------------

const W = 256, H = 256, N = W * H;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gaussian(rnd: () => number): number {
  const u = Math.max(rnd(), 1e-12), v = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Smooth textured base image 0..255: blurred noise + fine grain + gradients. */
function makeTexture(seed: number, grain = 3): Float64Array {
  const rnd = mulberry32(seed);
  const coarse = new Float64Array(N);
  for (let i = 0; i < N; i++) coarse[i] = rnd();
  // Two box-blur passes for band-limited texture.
  for (let pass = 0; pass < 2; pass++) {
    const tmp = new Float64Array(N);
    const r = 3, win = 2 * r + 1;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let s = 0;
        for (let k = -r; k <= r; k++) s += coarse[y * W + Math.min(Math.max(x + k, 0), W - 1)];
        tmp[y * W + x] = s / win;
      }
    }
    for (let x = 0; x < W; x++) {
      for (let y = 0; y < H; y++) {
        let s = 0;
        for (let k = -r; k <= r; k++) s += tmp[Math.min(Math.max(y + k, 0), H - 1) * W + x];
        coarse[y * W + x] = s / win;
      }
    }
  }
  const out = new Float64Array(N);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      out[i] = 40 + 170 * coarse[i] + 30 * (x / W) + 20 * (y / H) + grain * gaussian(rnd);
    }
  }
  return out;
}

function bilinear(img: Float64Array, x: number, y: number): number {
  const x0 = Math.max(0, Math.min(W - 2, Math.floor(x)));
  const y0 = Math.max(0, Math.min(H - 2, Math.floor(y)));
  const fx = Math.max(0, Math.min(1, x - x0)), fy = Math.max(0, Math.min(1, y - y0));
  const i = y0 * W + x0;
  return (
    img[i] * (1 - fx) * (1 - fy) + img[i + 1] * fx * (1 - fy) +
    img[i + W] * (1 - fx) * fy + img[i + W + 1] * fx * fy
  );
}

/** Warp a channel by displacement field δ(p). */
function warp(img: Float64Array, delta: (x: number, y: number) => [number, number]): Float64Array {
  const out = new Float64Array(N);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const [dx, dy] = delta(x, y);
    out[y * W + x] = bilinear(img, x + dx, y + dy);
  }
  return out;
}

function planesFrom(r: Float64Array, g: Float64Array, b: Float64Array) {
  return { width: W, height: H, r, g, b };
}

function lumaOf(p: { r: Float64Array; g: Float64Array; b: Float64Array }): Float64Array {
  const out = new Float64Array(N);
  for (let i = 0; i < N; i++) out[i] = 0.299 * p.r[i] + 0.587 * p.g[i] + 0.114 * p.b[i];
  return out;
}

function toJpegBytes(planes: { r: Float64Array; g: Float64Array; b: Float64Array }, quality: number): Uint8Array {
  const rgba = new Uint8Array(N * 4);
  for (let i = 0; i < N; i++) {
    rgba[i * 4] = Math.max(0, Math.min(255, Math.round(planes.r[i])));
    rgba[i * 4 + 1] = Math.max(0, Math.min(255, Math.round(planes.g[i])));
    rgba[i * 4 + 2] = Math.max(0, Math.min(255, Math.round(planes.b[i])));
    rgba[i * 4 + 3] = 255;
  }
  return jpeg.encode({ data: rgba, width: W, height: H }, quality).data;
}

function planesFromJpegBytes(bytes: Uint8Array) {
  const img = jpeg.decode(Buffer.from(bytes));
  const r = new Float64Array(N), g = new Float64Array(N), b = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    r[i] = img.data[i * 4]; g[i] = img.data[i * 4 + 1]; b[i] = img.data[i * 4 + 2];
  }
  return { r, g, b };
}

const base = makeTexture(7);
const allTexts: string[] = [];
const collect = (r: { text: string }): void => { allTexts.push(r.text); };

// ---------------------------------------------------------------------------
section('(a) radial CA warp → consistent-radial');
// ---------------------------------------------------------------------------

{
  const cx = W / 2, cy = H / 2;
  const kR = 0.008, kB = -0.008;
  const planes = planesFrom(
    warp(base, (x, y) => [kR * (x - cx), kR * (y - cy)]),
    base,
    warp(base, (x, y) => [kB * (x - cx), kB * (y - cy)]),
  );
  const res = analyzeCaRadial(planes);
  collect(res);
  check('(a) state is consistent-radial', res.state === 'consistent-radial',
    `${res.state} radialCorr=${res.radialCorrelation} dir=${res.directionAlignment} cells=${res.cellsUsed}/${res.cellsTotal}`);
  check('(a) radial correlation is strong and direction is lens-consistent',
    Math.abs(res.radialCorrelation ?? 0) >= 0.5 && Math.abs(res.directionAlignment ?? 0) >= 0.7,
    `radialCorr=${res.radialCorrelation} dir=${res.directionAlignment}`);
  check('(a) enough cells were measured', res.cellsUsed >= 9, `${res.cellsUsed}/${res.cellsTotal}`);
}

// ---------------------------------------------------------------------------
section('(b) uniform channel shift → no radial structure');
// ---------------------------------------------------------------------------

{
  const planes = planesFrom(
    warp(base, () => [1.5, -0.5]),
    base,
    warp(base, () => [-1.0, 1.0]),
  );
  const res = analyzeCaRadial(planes);
  collect(res);
  check('(b) state is no-radial-structure', res.state === 'no-radial-structure',
    `${res.state} radialCorr=${res.radialCorrelation} dir=${res.directionAlignment}`);
  check('(b) radial correlation stays low under a uniform shift',
    Math.abs(res.radialCorrelation ?? 1) < 0.5, `${res.radialCorrelation}`);
}

// ---------------------------------------------------------------------------
section('FFT sanity: a planted cosine peaks at its bin');
// ---------------------------------------------------------------------------

{
  const n = 256;
  const plane = new Float64Array(n * n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    plane[y * n + x] = Math.cos((2 * Math.PI * 32 * x) / n) * Math.cos((2 * Math.PI * 64 * y) / n);
  }
  const mag = fft2dMagnitudes(plane, n);
  const peak = mag[64 * n + 32];
  let other = 0;
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    if ((x === 32 || x === n - 32) && (y === 64 || y === n - 64)) continue;
    if (x === 0 && y === 0) continue;
    other = Math.max(other, mag[y * n + x]);
  }
  check('FFT: planted cosine bin dominates by >100×', peak > 100 * other, `peak=${peak} other=${other}`);
}

// ---------------------------------------------------------------------------
section('(c) JPEG-compressed buffer as raw-linear → grid detected');
// ---------------------------------------------------------------------------

let gridScoreDb = 0, cleanScoreDb = 0;
{
  const planes = planesFrom(base, base, base);
  const compressed = planesFromJpegBytes(toJpegBytes(planes, 75));
  const luma = lumaOf(compressed);
  const res = analyzeJpegGrid(luma, W, H, { provenance: 'raw-linear' });
  collect(res);
  gridScoreDb = res.score ?? 0;
  check('(c) state is grid-detected', res.state === 'grid-detected',
    `${res.state} score=${res.score?.toFixed(1)}dB`);
  check('(c) the peak clears the floor with margin', gridScoreDb >= 5 + 2,
    `${gridScoreDb.toFixed(1)} dB vs threshold 5 dB`);
}

// ---------------------------------------------------------------------------
section('(d) clean synthetic RAW-noise buffer → no grid');
// ---------------------------------------------------------------------------

let rawLuma: Float64Array;
{
  const rnd = mulberry32(19);
  rawLuma = new Float64Array(N);
  for (let i = 0; i < N; i++) rawLuma[i] = base[i] + Math.sqrt(Math.max(base[i], 1)) * gaussian(rnd);
  const res = analyzeJpegGrid(rawLuma, W, H, { provenance: 'raw-linear' });
  collect(res);
  cleanScoreDb = res.score ?? 0;
  check('(d) state is no-grid', res.state === 'no-grid', `${res.state} score=${res.score?.toFixed(1)}dB`);
  check('(d) the clean buffer sits below the floor with margin', cleanScoreDb <= 5 - 5,
    `${cleanScoreDb.toFixed(1)} dB vs threshold 5 dB`);
  check('(c)+(d) detection margin between the fixtures is wide',
    gridScoreDb - cleanScoreDb >= 8, `${gridScoreDb.toFixed(1)} vs ${cleanScoreDb.toFixed(1)} dB`);
}

// ---------------------------------------------------------------------------
section('(e) Poisson profile, uniform-noise anomaly, reference leg');
// ---------------------------------------------------------------------------

{
  const res = analyzePoissonPrnu(rawLuma!, W, H);
  collect(res); collect(res.reference as { text: string });
  check('(e) Poisson fixture → expected-profile', res.state === 'expected-profile',
    `${res.state} slope=${res.poissonSlope?.toExponential(2)} R2=${res.varianceFitR2} t=${res.slopeT}`);
  check('(e) the fit is tight and the slope significant',
    (res.varianceFitR2 ?? 0) >= 0.6 && (res.slopeT ?? 0) >= 3,
    `R2=${res.varianceFitR2} t=${res.slopeT}`);
  check('(e) reference leg without a pattern is not-applicable, never fabricated',
    res.reference.state === 'not-applicable');
}

{
  const rnd = mulberry32(23);
  const uniform = new Float64Array(N);
  for (let i = 0; i < N; i++) uniform[i] = base[i] + 6 * gaussian(rnd);
  const res = analyzePoissonPrnu(uniform, W, H);
  collect(res); collect(res.reference as { text: string });
  check('(e) uniform-noise fixture → anomalous-profile', res.state === 'anomalous-profile',
    `${res.state} slope=${res.poissonSlope?.toExponential(2)} R2=${res.varianceFitR2} t=${res.slopeT}`);
}

{
  // Multiplicative pattern baked in: img = base·(1 + 0.03·pat) + shot noise.
  const rnd = mulberry32(29);
  const pat = new Float64Array(N);
  for (let i = 0; i < N; i++) pat[i] = gaussian(rnd);
  const rnd2 = mulberry32(31);
  const mult = new Float64Array(N);
  for (let i = 0; i < N; i++) mult[i] = base[i] * (1 + 0.03 * pat[i]) + 1.5 * gaussian(rnd2);
  const res = analyzePoissonPrnu(mult, W, H, { referencePattern: pat });
  collect(res); collect(res.reference as { text: string });
  check('(e) committed reference pattern → reference-match',
    res.reference.state === 'reference-match' && Math.abs(res.reference.correlation ?? 0) >= 0.3,
    `${res.reference.state} r=${res.reference.correlation}`);
}

// ---------------------------------------------------------------------------
section('(f) the provenance gate: jpeg-delivery is refused, never scored');
// ---------------------------------------------------------------------------

{
  const res = analyzeJpegGrid(rawLuma!, W, H, { provenance: 'jpeg-delivery' });
  collect(res);
  check("(f) 'jpeg-delivery' → not-applicable", res.state === 'not-applicable');
  check('(f) the refusal says WHY (grid expected from the container)',
    res.text.includes('EXPECTED') && res.text.includes('refuses'));
  check('(f) no score is produced for declared JPEG pixels', res.score === undefined);
  let threw = '';
  try { analyzeJpegGrid(rawLuma!, W, H, { provenance: 'unspecified' as never }); } catch (e) { threw = (e as Error).message; }
  check('(f) undeclared provenance throws — undeclared pixels are never scored', threw.includes('provenance'), threw);
}

// ---------------------------------------------------------------------------
section('orchestration: analyzeSingleImage on a raw-linear buffer');
// ---------------------------------------------------------------------------

{
  const cx = W / 2, cy = H / 2;
  // Physically ordered: the OPTICS warp the clean scene per channel, THEN
  // the sensor adds its shot noise. (Warping already-noisy channels would
  // interpolate the noise away — not how a capture works.)
  const rnd = mulberry32(37);
  // 0.35 scales electrons-per-luma-unit to a realistic base-ISO SNR; the
  // Poisson SHAPE (variance ∝ mean) is what the profile measures.
  const shot = (img: Float64Array): Float64Array => {
    const out = new Float64Array(N);
    for (let i = 0; i < N; i++) out[i] = img[i] + 0.35 * Math.sqrt(Math.max(img[i], 1)) * gaussian(rnd);
    return out;
  };
  const planes = planesFrom(
    shot(warp(base, (x, y) => [0.008 * (x - cx), 0.008 * (y - cy)])),
    shot(base),
    shot(warp(base, (x, y) => [-0.008 * (x - cx), -0.008 * (y - cy)])),
  );
  const report = analyzeSingleImage(planes, { provenance: 'raw-linear' });
  check('orchestration: all three checks ran with first-class states',
    ['consistent-radial', 'no-radial-structure', 'insufficient-data'].includes(report.checks.caRadial.state) &&
    ['grid-detected', 'no-grid', 'insufficient-data', 'not-applicable'].includes(report.checks.jpegGrid.state) &&
    ['expected-profile', 'anomalous-profile', 'insufficient-data'].includes(report.checks.poissonPrnu.state));
  check('orchestration: the raw-linear synthetic reads as expected end-to-end',
    report.checks.caRadial.state === 'consistent-radial' &&
    report.checks.jpegGrid.state === 'no-grid' &&
    report.checks.poissonPrnu.state === 'expected-profile',
    `${report.checks.caRadial.state} / ${report.checks.jpegGrid.state} / ${report.checks.poissonPrnu.state}`);
  check('orchestration: standing limitations are attached',
    report.limitations.length === SINGLE_IMAGE_LIMITATIONS.length && report.limitations.length >= 5);
  collect(report.checks.caRadial); collect(report.checks.jpegGrid); collect(report.checks.poissonPrnu);
}

// ---------------------------------------------------------------------------
section('(g) honesty sweep');
// ---------------------------------------------------------------------------

{
  const banned = /\bpassed\b|\bauthentic\b|\bverified\b/i;
  const hits = [...allTexts, ...SINGLE_IMAGE_LIMITATIONS].filter((t) => banned.test(t));
  check("(g) no output string says 'passed', 'authentic', or 'verified'",
    hits.length === 0, hits.join(' | '));
  const framing = /uncharacterized/i;
  const missing = allTexts.filter((t) => !framing.test(t));
  check('(g) every check text carries the uncharacterized-error framing',
    missing.length === 0, `${missing.length} texts missing it`);
  check('(g) the sweep actually collected texts', allTexts.length >= 12, `${allTexts.length}`);
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);

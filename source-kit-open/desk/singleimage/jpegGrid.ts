/**
 * P5 single-image physics: 8×8 DCT periodicity ("JPEG grid") in a buffer
 * that claims to be RAW/uncompressed (Plan-0.13.0 P5 item 23).
 *
 * JPEG compression quantizes 8×8-pixel DCT blocks; the blocking leaves an
 * 8-px-periodic signal in the pixel domain, visible in the 2D FFT as peaks
 * at the 1/8-period spatial frequencies. A TRUE raw-linear buffer (sensor
 * readout, demosaiced, never DCT-quantized) has no physical reason to carry
 * an 8-px grid — its periodic structure is the 2-px Bayer/mosaic lattice,
 * which sits at the Nyquist bins, nowhere near 1/8.
 *
 * THE PROVENANCE GATE (hard honesty rule): on a JPEG DELIVERY file an 8-px
 * grid is EXPECTED — the file format guarantees it — so scoring one would
 * manufacture a false positive from the container, not the pixels. The
 * caller MUST declare the pixel provenance; 'jpeg-delivery' is refused
 * outright (state 'not-applicable'), never scored.
 *
 * METHOD (pure, deterministic):
 *   1. Luma, center-cropped and box-decimated to a 256×256 power-of-two
 *      plane; best-fit plane removed (DC/tilt). NO apodization window: the
 *      blocking steps are a plane-uniform periodic signal, and windowing
 *      suppresses their sharp localized edges disproportionately (measured:
 *      a Hann window inverted the peak-to-floor ratio on a q80 JPEG
 *      fixture). De-tilt plus the annulus floor handles leakage instead.
 *   2. 2D FFT via a small pure-TS radix-2 implementation (below).
 *   3. Peak = mean magnitude at the four axis grid bins (±N/8, 0), (0, ±N/8);
 *      floor = median magnitude over the surrounding frequency annulus
 *      (guard bands around the grid bins and DC excluded). Score is
 *      20·log10(peak/floor), dB.
 *
 * LIMITS (carried in every text): a JPEG that was resized or re-cropped
 * off-grid after compression loses the 8-px alignment, so 'no-grid' clears
 * nothing; heavy noise/texture raises the floor; the threshold is a
 * first-principles placeholder until the P6 corpus ROC lands. This is a
 * statistical signal a person weighs, never a verdict.
 */

export const JPEG_GRID_METHOD_VERSION = '0.1.0-p5-scaffold';

/** FFT plane edge (power of two). 256 balances grid visibility vs runtime. */
export const JPEG_GRID_FFT_SIZE = 256;
/**
 * Peak/floor floor, dB (placeholder, P6). Under white noise the 4 averaged
 * grid bins sit within a couple dB of the annulus median (measured ≈ −2 dB
 * on clean synthetic RAW noise); a q80 JPEG over busy texture measured
 * ≈ +5.4 dB, over moderate texture ≈ +7 dB. 5 dB sits above chance with
 * room for texture variation — to be replaced by the corpus ROC.
 */
export const JPEG_GRID_MIN_DB = 5;

export type PixelProvenance = 'raw-linear' | 'jpeg-delivery';
export type JpegGridState = 'grid-detected' | 'no-grid' | 'insufficient-data' | 'not-applicable';

export interface JpegGridOptions {
  /** REQUIRED pixel provenance — see the header. No default: refusing to declare is refusing to score. */
  provenance: PixelProvenance;
  /** FFT plane edge (power of two ≥ 64); default 256. */
  size?: number;
}

export interface JpegGridResult {
  state: JpegGridState;
  /** Peak-to-floor ratio, dB (present when a plane was scored). */
  score?: number;
  /** Linear peak/floor ratio. */
  peakRatio?: number;
  fftSize?: number;
  methodVersion: string;
  text: string;
}

const FRAMING =
  'This is a statistical signal a person weighs, never a verdict; its error rates are uncharacterized until the corpus benchmark lands.';

// ---------------------------------------------------------------------------
// Minimal pure-TS radix-2 FFT (iterative, in-place, separate re/im arrays).
// ---------------------------------------------------------------------------

function fft1d(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  // Bit-reversal permutation.
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cwr = 1, cwi = 0;
      for (let k = 0; k < half; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + half] * cwr - im[i + k + half] * cwi;
        const vi = re[i + k + half] * cwi + im[i + k + half] * cwr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + half] = ur - vr; im[i + k + half] = ui - vi;
        const nwr = cwr * wr - cwi * wi;
        cwi = cwr * wi + cwi * wr;
        cwr = nwr;
      }
    }
  }
}

/** 2D FFT of a square plane (rows then columns), returning magnitudes. */
export function fft2dMagnitudes(plane: Float64Array, n: number): Float64Array {
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const work = Float64Array.from(plane);
  // Rows.
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) { re[x] = work[y * n + x]; im[x] = 0; }
    fft1d(re, im);
    for (let x = 0; x < n; x++) work[y * n + x] = re[x]; // stash re; im in a second pass array
  }
  const workIm = new Float64Array(n * n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) { re[x] = plane[y * n + x]; im[x] = 0; }
    fft1d(re, im);
    for (let x = 0; x < n; x++) workIm[y * n + x] = im[x];
  }
  // Columns.
  const out = new Float64Array(n * n);
  for (let x = 0; x < n; x++) {
    for (let y = 0; y < n; y++) { re[y] = work[y * n + x]; im[y] = workIm[y * n + x]; }
    fft1d(re, im);
    for (let y = 0; y < n; y++) out[y * n + x] = Math.hypot(re[y], im[y]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Plane preparation: decimate, de-tilt, window.
// ---------------------------------------------------------------------------

/** Center-crop to square and box-decimate to n×n. Returns null when too small. */
function decimateToPlane(luma: ArrayLike<number>, w: number, h: number, n: number): Float64Array | null {
  if (w < n || h < n) return null;
  const side = Math.min(w, h);
  const x0 = Math.floor((w - side) / 2);
  const y0 = Math.floor((h - side) / 2);
  const scale = side / n;
  const out = new Float64Array(n * n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      // Box average over the source cell — decimation, never interpolation.
      const sx0 = x0 + Math.floor(x * scale), sx1 = x0 + Math.floor((x + 1) * scale);
      const sy0 = y0 + Math.floor(y * scale), sy1 = y0 + Math.floor((y + 1) * scale);
      let s = 0, c = 0;
      for (let sy = sy0; sy < Math.max(sy1, sy0 + 1); sy++) {
        for (let sx = sx0; sx < Math.max(sx1, sx0 + 1); sx++) { s += luma[sy * w + sx]; c++; }
      }
      out[y * n + x] = s / c;
    }
  }
  return out;
}

function removeBestFitPlane(p: Float64Array, n: number): void {
  // Least-squares fit v = a·x + b·y + c over the plane; subtract it.
  let sx = 0, sy = 0, sv = 0, sxx = 0, sxy = 0, sxv = 0, syy = 0, syv = 0, cnt = 0;
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const v = p[y * n + x];
    sx += x; sy += y; sv += v; sxx += x * x; sxy += x * y; sxv += x * v; syy += y * y; syv += y * v; cnt++;
  }
  // Solve the 3×3 normal equations via Cramer (well-conditioned for a grid).
  const m = [
    [sxx, sxy, sx],
    [sxy, syy, sy],
    [sx, sy, cnt],
  ];
  const rhs = [sxv, syv, sv];
  const det = (a: number[][]): number =>
    a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1]) -
    a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0]) +
    a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0]);
  const d0 = det(m);
  if (Math.abs(d0) < 1e-9) { const mean = sv / cnt; for (let i = 0; i < p.length; i++) p[i] -= mean; return; }
  const coef = [0, 1, 2].map((col) => det(m.map((row, ri) => row.map((v, ci) => (ci === col ? rhs[ri] : v)))) / d0);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) p[y * n + x] -= coef[0] * x + coef[1] * y + coef[2];
}

function medianOf(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

// ---------------------------------------------------------------------------
// The check.
// ---------------------------------------------------------------------------

export function analyzeJpegGrid(
  luma: ArrayLike<number>,
  width: number,
  height: number,
  opts: JpegGridOptions,
): JpegGridResult {
  const base = { methodVersion: JPEG_GRID_METHOD_VERSION, text: '' };

  if (opts.provenance === 'jpeg-delivery') {
    return {
      ...base,
      state: 'not-applicable',
      text:
        'Not applicable: the caller declared a JPEG delivery file, and an 8-px DCT grid is EXPECTED in JPEG ' +
        'pixels — the container guarantees it. Scoring one would manufacture a positive from the file format, ' +
        'not from the pixels, so this check refuses to run. It is meaningful ONLY on a buffer claimed to be ' +
        'raw-linear. ' + FRAMING,
    };
  }
  if (opts.provenance !== 'raw-linear') {
    throw new Error(`jpegGrid: provenance must be declared as 'raw-linear' or 'jpeg-delivery' (got '${String(opts.provenance)}') — undeclared pixels are never scored`);
  }

  const n = opts.size ?? JPEG_GRID_FFT_SIZE;
  if ((n & (n - 1)) !== 0 || n < 64) throw new Error(`jpegGrid: FFT size must be a power of two ≥ 64 (got ${n})`);
  const plane = decimateToPlane(luma, width, height, n);
  if (!plane) {
    return {
      ...base,
      state: 'insufficient-data',
      text:
        `Insufficient data: the frame (${width}×${height}) is smaller than the ${n}×${n} analysis plane. ` +
        'Nothing was measured. ' + FRAMING,
    };
  }

  removeBestFitPlane(plane, n);
  // No apodization window — see the header. De-tilt + annulus floor it is.
  const mag = fft2dMagnitudes(plane, n);
  const at = (x: number, y: number): number => mag[((y + n) % n) * n + ((x + n) % n)];

  const k = n / 8;
  const peakBins: Array<[number, number]> = [[k, 0], [-k, 0], [0, k], [0, -k]];
  const peak = peakBins.reduce((a, [x, y]) => a + at(x, y), 0) / peakBins.length;

  // Noise floor: median over the annulus around the grid frequency,
  // excluding a ±2-bin guard around every grid bin and the DC region.
  const floorSamples: number[] = [];
  const nearGrid = (x: number, y: number): boolean => {
    const gx = Math.min(Math.abs(x), n - Math.abs(x));
    const gy = Math.min(Math.abs(y), n - Math.abs(y));
    const near = (bx: number, by: number): boolean => Math.abs(gx - bx) <= 2 && Math.abs(gy - by) <= 2;
    return near(k, 0) || near(0, k) || near(k, k) || near(k, n - k) || near(0, 0);
  };
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const cx = Math.min(x, n - x), cy = Math.min(y, n - y);
      const r = Math.hypot(cx, cy);
      if (r >= k * 0.6 && r <= k * 1.6 && !nearGrid(x, y)) floorSamples.push(mag[y * n + x]);
    }
  }
  const floor = medianOf(floorSamples);
  const ratio = floor > 0 ? peak / floor : (peak > 0 ? Infinity : 0);
  const scoreDb = Number.isFinite(ratio) ? 20 * Math.log10(Math.max(ratio, 1e-9)) : 60;
  const grid = scoreDb >= JPEG_GRID_MIN_DB;

  const measured =
    `peak ${peak.toFixed(2)} vs floor ${floor.toFixed(2)} at the 1/8-period bins ` +
    `(ratio ${Number.isFinite(ratio) ? ratio.toFixed(1) : '∞'}, ${scoreDb.toFixed(1)} dB, floor ${JPEG_GRID_MIN_DB} dB, ${n}×${n} FFT)`;

  if (grid) {
    return {
      ...base,
      state: 'grid-detected',
      score: scoreDb,
      peakRatio: ratio,
      fftSize: n,
      text:
        `8-px DCT-periodic grid DETECTED in a buffer declared raw-linear (${measured}): these pixels carry the ` +
        'blocking signature of JPEG quantization, which a true raw-linear readout has no physical reason to ' +
        'contain. Consistent with JPEG compression somewhere upstream — screen or file rephotography, or a ' +
        'recompressed source — and with ANY 8-px-periodic process; the specific cause is not measured here. ' +
        'A resized or off-grid-cropped JPEG evades this check, so its absence clears nothing. ' + FRAMING,
    };
  }
  return {
    ...base,
    state: 'no-grid',
    score: scoreDb,
    peakRatio: ratio,
    fftSize: n,
    text:
      `No 8-px DCT-periodic grid (${measured}): consistent with an uncompressed raw-linear buffer — and also ` +
      'with a JPEG that was resized or re-cropped off the 8-px lattice, so this is NOT clearance. ' + FRAMING,
  };
}

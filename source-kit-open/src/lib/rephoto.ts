/**
 * Screen re-photography analysis — desk-side DSP core.
 *
 * Photographing a screen leaves statistical fingerprints a natural scene
 * rarely produces: rolling-shutter banding from backlight PWM, moiré from
 * the display pixel grid aliasing against the sensor grid, a lifted black
 * floor (no OLED/LCD renders true sensor black), and hard-clipped display
 * gamut. These analyzers measure those fingerprints.
 *
 * HONESTY — three hard rules:
 *  1. EVIDENCE, NEVER A VERDICT. Every function returns measurements and a
 *     descriptive strength band. Nothing here decides anything; a person
 *     weighs the numbers. No UI may gate on these values.
 *  2. NO FALSE POSITIVES ON FLAT SUBJECTS BY CONSTRUCTION. When a signal
 *     has no meaningful energy above its own noise floor, the analyzer
 *     reports 'insufficient-signal' — flat walls, blank skies, and pure
 *     noise must not "detect" anything.
 *  3. THRESHOLDS ARE CORPUS-CALIBRATED, NOT SCIENCE. The strength bands
 *     ship with ROC data before gaining any prominence; until then
 *     they are descriptive labels on raw numbers, which are always shown.
 *
 * All functions are pure (no DOM, no IO) so the open test suite exercises
 * them on synthetic patterns. The desk feeds them downsampled planes from
 * a canvas; they are not in the capture path.
 */

export type SignalStrength = 'insufficient-signal' | 'none' | 'weak' | 'moderate' | 'strong';

export interface BandingResult {
  /** Dominant row-stripe frequency, cycles per row (0 = none found). */
  peakFreq: number;
  /** Peak spectral power at that frequency. */
  peakPower: number;
  /** Median spectral floor (robust noise estimate). */
  floorMedian: number;
  /** Peak/floor ratio in dB. Higher = more periodic striping. */
  snrDb: number;
  strength: SignalStrength;
}

export interface MoireResult {
  /** Peak location in the 2D spectrum (normalized cycles/pixel, 0..0.5). */
  peakU: number;
  peakV: number;
  snrDb: number;
  strength: SignalStrength;
}

export interface BlackFloorResult {
  /** Darkest pixel luminance observed. */
  minLuma: number;
  /** 0.5th-percentile luminance — robust dark-end estimate. */
  p005: number;
  /** Fraction of pixels at near-zero luminance (< 4). */
  trueBlackFraction: number;
  /** Estimated black lift (p005, clamped ≥ 0). */
  liftEstimate: number;
}

export interface GamutResult {
  /** Fraction of pixels with one channel ≥250 while another ≤5. */
  hardSaturatedFraction: number;
  /** Fraction of pixels with any channel pinned at 0 or 255. */
  channelClipFraction: number;
}

// --- small radix-2 FFT (iterative, in-place) --------------------------------

function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
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
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cwr = 1;
      let cwi = 0;
      for (let j = 0; j < len / 2; j++) {
        const ur = re[i + j];
        const ui = im[i + j];
        const vr = re[i + j + len / 2] * cwr - im[i + j + len / 2] * cwi;
        const vi = re[i + j + len / 2] * cwi + im[i + j + len / 2] * cwr;
        re[i + j] = ur + vr;
        im[i + j] = ui + vi;
        re[i + j + len / 2] = ur - vr;
        im[i + j + len / 2] = ui - vi;
        const nwr = cwr * wr - cwi * wi;
        cwi = cwr * wi + cwi * wr;
        cwr = nwr;
      }
    }
  }
}

function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

/** Descriptive band from a peak/floor SNR in dB. Corpus-calibrated. */
export function snrStrength(snrDb: number): SignalStrength {
  if (!Number.isFinite(snrDb)) return 'insufficient-signal';
  if (snrDb < 6) return 'none';
  if (snrDb < 10) return 'weak';
  if (snrDb < 16) return 'moderate';
  return 'strong';
}

/**
 * Rolling-shutter banding: periodic brightness stripes across sensor rows
 * (backlight PWM beating against the rolling readout). Row means are
 * detrended (linear fit removed — smooth gradients are not banding), then
 * FFT'd; the peak above the robust spectral floor is the measurement.
 */
export function analyzeBanding(gray: ArrayLike<number>, width: number, height: number): BandingResult {
  const none: BandingResult = { peakFreq: 0, peakPower: 0, floorMedian: 0, snrDb: Number.NEGATIVE_INFINITY, strength: 'insufficient-signal' };
  if (width < 8 || height < 32 || gray.length < width * height) return none;

  // Row means.
  const rows = new Float64Array(height);
  for (let y = 0; y < height; y++) {
    let s = 0;
    const base = y * width;
    for (let x = 0; x < width; x++) s += gray[base + x];
    rows[y] = s / width;
  }

  // Detrend: remove the least-squares line (smooth illumination gradient).
  const n = height;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) {
    sx += i; sy += rows[i]; sxx += i * i; sxy += i * rows[i];
  }
  const denom = n * sxx - sx * sx;
  const slope = denom !== 0 ? (n * sxy - sx * sy) / denom : 0;
  const intercept = (sy - slope * sx) / n;
  let residualEnergy = 0;
  for (let i = 0; i < n; i++) {
    rows[i] -= intercept + slope * i;
    residualEnergy += rows[i] * rows[i];
  }
  // Flat-subject guard: no residual structure → nothing to analyze.
  if (residualEnergy / n < 1e-6) return none;

  // FFT on a zero-padded power-of-two window.
  const size = nextPow2(n);
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  re.set(rows);
  fft(re, im);

  // Magnitudes over bins 2..N/2 (skip DC and the ultra-low trend bin).
  const half = size >> 1;
  const mags: number[] = [];
  for (let k = 2; k <= half; k++) {
    mags.push(re[k] * re[k] + im[k] * im[k]);
  }
  const sorted = [...mags].sort((a, b) => a - b);
  const floorMedian = sorted[Math.floor(sorted.length / 2)];
  let peakIdx = 0;
  for (let i = 1; i < mags.length; i++) if (mags[i] > mags[peakIdx]) peakIdx = i;
  const peakPower = mags[peakIdx];
  if (floorMedian <= 0) return none;
  const snrDb = 10 * Math.log10(peakPower / floorMedian);
  return {
    peakFreq: (peakIdx + 2) / size,
    peakPower,
    floorMedian,
    snrDb,
    strength: snrStrength(snrDb),
  };
}

/**
 * Moiré: aliasing between the display's pixel grid and the sensor's —
 * isolated high-frequency peaks in the 2D spectrum. The input is
 * box-downsampled to ≤128 on the long side for a fixed-cost 2D FFT.
 */
export function analyzeMoire(gray: ArrayLike<number>, width: number, height: number): MoireResult {
  const none: MoireResult = { peakU: 0, peakV: 0, snrDb: Number.NEGATIVE_INFINITY, strength: 'insufficient-signal' };
  if (width < 32 || height < 32 || gray.length < width * height) return none;

  // Box-downsample to at most 128×128 (keeps the FFT cheap and the
  // analysis at the frequencies moiré actually lives in).
  const scale = Math.max(1, Math.floor(Math.max(width, height) / 128));
  const w = Math.floor(width / scale);
  const h = Math.floor(height / scale);
  if (w < 16 || h < 16) return none;
  const small = new Float64Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          s += gray[(y * scale + dy) * width + (x * scale + dx)];
        }
      }
      small[y * w + x] = s / (scale * scale);
    }
  }

  // Remove the mean (DC carries brightness, not structure).
  let mean = 0;
  for (let i = 0; i < small.length; i++) mean += small[i];
  mean /= small.length;
  let energy = 0;
  for (let i = 0; i < small.length; i++) {
    small[i] -= mean;
    energy += small[i] * small[i];
  }
  if (energy / small.length < 1e-6) return none; // flat-subject guard

  // 2D FFT via row passes then column passes (sizes already arbitrary —
  // zero-pad each axis to a power of two).
  const wp = nextPow2(w);
  const hp = nextPow2(h);
  const plane = new Float64Array(wp * hp);
  const planeIm = new Float64Array(wp * hp);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) plane[y * wp + x] = small[y * w + x];
  }
  const rre = new Float64Array(wp);
  const rim = new Float64Array(wp);
  for (let y = 0; y < hp; y++) {
    rre.set(plane.subarray(y * wp, y * wp + wp));
    rim.set(planeIm.subarray(y * wp, y * wp + wp));
    fft(rre, rim);
    plane.set(rre, y * wp);
    planeIm.set(rim, y * wp);
  }
  const cre = new Float64Array(hp);
  const cim = new Float64Array(hp);
  for (let x = 0; x < wp; x++) {
    for (let y = 0; y < hp; y++) {
      cre[y] = plane[y * wp + x];
      cim[y] = planeIm[y * wp + x];
    }
    fft(cre, cim);
    for (let y = 0; y < hp; y++) {
      plane[y * wp + x] = cre[y];
      planeIm[y * wp + x] = cim[y];
    }
  }

  // Scan the high-frequency annulus (0.15..0.5 cycles/pixel), skipping DC.
  const mags: { mag: number; u: number; v: number }[] = [];
  for (let y = 0; y < hp; y++) {
    const fv = Math.min(y, hp - y) / hp;
    for (let x = 0; x < wp; x++) {
      const fu = Math.min(x, wp - x) / wp;
      const r = Math.hypot(fu, fv);
      if (r < 0.15 || r > 0.5) continue;
      mags.push({ mag: plane[y * wp + x] ** 2 + planeIm[y * wp + x] ** 2, u: fu, v: fv });
    }
  }
  if (mags.length === 0) return none;
  const sorted = mags.map((m) => m.mag).sort((a, b) => a - b);
  const floorMedian = sorted[Math.floor(sorted.length / 2)];
  let peak = mags[0];
  for (const m of mags) if (m.mag > peak.mag) peak = m;
  if (floorMedian <= 0) return none;
  const snrDb = 10 * Math.log10(peak.mag / floorMedian);
  return { peakU: peak.u, peakV: peak.v, snrDb, strength: snrStrength(snrDb) };
}

/**
 * Black floor: a photographed screen's "black" is the display's own
 * backlight/OLED floor plus reflections — lifted above true sensor black.
 * Natural photos of dark scenes still reach near-zero luminance somewhere
 * (shadows, noise floor); screen re-photos characteristically don't.
 */
export function analyzeBlackFloor(gray: ArrayLike<number>, width: number, height: number): BlackFloorResult {
  const n = Math.min(gray.length, width * height);
  if (n === 0) return { minLuma: 0, p005: 0, trueBlackFraction: 0, liftEstimate: 0 };
  // 256-bin luminance histogram → robust percentiles, no full sort.
  const hist = new Uint32Array(256);
  for (let i = 0; i < n; i++) {
    const v = gray[i];
    hist[Math.max(0, Math.min(255, Math.round(v)))]++;
  }
  let minLuma = 0;
  while (minLuma < 256 && hist[minLuma] === 0) minLuma++;
  const target = Math.max(1, Math.floor(n * 0.005));
  let cum = 0;
  let p005 = 0;
  while (p005 < 256) {
    cum += hist[p005];
    if (cum >= target) break;
    p005++;
  }
  let blacks = 0;
  for (let b = 0; b < 4; b++) blacks += hist[b];
  return {
    minLuma,
    p005,
    trueBlackFraction: blacks / n,
    liftEstimate: Math.max(0, p005),
  };
}

/**
 * Display gamut: panels render saturated colors by pinning channels —
 * one channel at the rail while another sits near zero. Natural scenes
 * (even vivid ones) rarely produce large populations of railed pixels.
 */
export function analyzeGamut(rgba: ArrayLike<number>, pixelCount: number): GamutResult {
  if (pixelCount <= 0 || rgba.length < pixelCount * 4) {
    return { hardSaturatedFraction: 0, channelClipFraction: 0 };
  }
  let hardSat = 0;
  let clipped = 0;
  for (let i = 0; i < pixelCount; i++) {
    const o = i * 4;
    const r = rgba[o];
    const g = rgba[o + 1];
    const b = rgba[o + 2];
    const hi = Math.max(r, g, b);
    const lo = Math.min(r, g, b);
    if (hi >= 250 && lo <= 5) hardSat++;
    if (hi === 255 || lo === 0) clipped++;
  }
  return {
    hardSaturatedFraction: hardSat / pixelCount,
    channelClipFraction: clipped / pixelCount,
  };
}

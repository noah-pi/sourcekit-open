/**
 * Desk-side onset-alignment A/V desync analyzer.
 *
 * Input: the video's audio track (mono PCM) and a motion series — global-
 * motion magnitude per sampled frame pair from the SAME shared estimator
 * the desk's IMU↔flow check uses (src/lib/opticalflow.ts), rasterized by
 * the browser adapter or ffmpeg.
 *
 * Method — PURE DETERMINISTIC SIGNAL MEASUREMENT:
 *  1. The audio is reduced to an RMS envelope on windows ALIGNED to the
 *     motion sample times (same interval, same centers) — both channels
 *     then share one time base and one sampling grid.
 *  2. Activity signals: audio flux = max(0, Δlog(RMS)) (onset emphasis;
 *     sustained loudness is not an onset), motion flux = max(0, Δ|motion|).
 *  3. The measured offset is the lag of peak normalized cross-correlation
 *     between the two flux series over ±MAX_LAG_MS, reported in ms with
 *     the peak correlation. Sign convention: positive offset = audio
 *     onsets occur LATER than motion onsets (audio lags video).
 *  4. Secondary measurement: the strongest single onset in each channel
 *     and their time difference — one event pair, stated as such.
 *
 * Dubbing relevance: a direct capture locks its onsets together (a clap
 * and the hands meeting share t=0); a dubbed track drifts or shifts. The
 * analyzer reports the MEASURED offset and correlation — it never decides
 * whether an offset is dubbing. Encoding/interleave offsets are real and
 * container-dependent, so small offsets are expected on honest files; what
 * counts as suspicious is a corpus question (error rates pending).
 *
 * OUTPUT: evidence for a person to weigh. Insufficient data (no audio,
 * no onsets, too few samples) reports 'insufficient' with the specific
 * reason — never a number dressed up as evidence. Never a dubbing verdict.
 */

export const AVSYNC_METHOD_VERSION = '1.0.0-ws5-t1';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Global-motion magnitude per sampled frame pair (px/frame at the analysis raster). */
export interface MotionSample {
  /** Midpoint of the frame pair, seconds from video start (container time base). */
  tSec: number;
  magnitude: number;
}

export interface AvSyncEvidence {
  status: 'measured' | 'insufficient';
  /** false, or the specific reason no measurement could be made. */
  insufficient: false | string;
  /**
   * Measured onset-alignment offset, ms. Positive = audio onsets LATER
   * than motion onsets (audio lags video). Null when insufficient.
   */
  offsetMs: number | null;
  /** Peak normalized cross-correlation at the reported lag (−1..1). */
  correlation: number | null;
  /** Lag range searched, ms. */
  lagRangeMs: [number, number];
  /** Motion-sample interval the alignment was measured on, ms. */
  sampleIntervalMs: number | null;
  audioOnsets: number;
  motionOnsets: number;
  /** Secondary measurement: strongest-onset pair difference, ms (same sign convention). */
  strongestOnset: null | { audioAtSec: number; motionAtSec: number; offsetMs: number };
  samplesUsed: number;
  methodVersion: typeof AVSYNC_METHOD_VERSION;
  computedAt: string;
  limitations: string[];
}

// ---------------------------------------------------------------------------
// Constants — stated, not hidden
// ---------------------------------------------------------------------------

/** Lag search range, ms — beyond this an "alignment" is coincidence. */
const MAX_LAG_MS = 600;
/** Minimum motion samples (and aligned envelope windows). */
const MIN_SAMPLES = 8;
/** Onset gate: flux peaks above mean + ONSET_K×std count as onsets. */
const ONSET_K = 2;
/** Peak correlation below which the lag is coincidence, not alignment. */
const MIN_PEAK_CORR = 0.5;

const FIXED_LIMITATIONS = [
  'corpus characterization pending; no error rates published',
  'an alignment measurement for human review — evidence a person weighs, never a dubbing verdict and never a gate',
  'small offsets are EXPECTED on honest files: container A/V interleave, encoder delay, and the motion sampler\'s frame cadence all contribute; what offset is suspicious is a corpus question and no threshold is published',
  'onset-free content (continuous speech, static scenes, music without transients) yields no measurement — reported as insufficient, never as zero offset',
  'a strong offset is dubbing-RELEVANT evidence: it is also produced by innocent re-muxing and transcoding; the analyzer measures the offset, it never attributes it',
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const round3 = (v: number): number => Math.round(v * 1000) / 1000;

function meanStd(xs: number[]): { mean: number; std: number } {
  const mean = xs.reduce((s, v) => s + v, 0) / xs.length;
  const std = Math.sqrt(xs.reduce((s, v) => s + (v - mean) ** 2, 0) / xs.length);
  return { mean, std };
}

/** Positive first difference (flux). Index i is the rise INTO sample i. */
function flux(xs: number[]): number[] {
  const out = [0];
  for (let i = 1; i < xs.length; i++) out.push(Math.max(0, xs[i] - xs[i - 1]));
  return out;
}

// ---------------------------------------------------------------------------
// The analyzer
// ---------------------------------------------------------------------------

export interface AvSyncOptions {
  /** Lag search range override, ms. */
  maxLagMs?: number;
  /** Injection point for tests. */
  now?: Date;
}

/**
 * @param audio Mono PCM + sample rate, or null when the track is absent —
 *   the caller states why (three-state honesty: absent vs never-recorded).
 * @param motion Global-motion magnitude series on the container time base.
 */
export function analyzeOnsetAlignment(
  audio: { sampleRateHz: number; samples: ArrayLike<number> } | null,
  motion: MotionSample[] | null,
  opts: AvSyncOptions = {},
): AvSyncEvidence {
  const computedAt = (opts.now ?? new Date()).toISOString();
  const limitations: string[] = [...FIXED_LIMITATIONS];
  const maxLagMs = opts.maxLagMs ?? MAX_LAG_MS;

  const insufficient = (reason: string): AvSyncEvidence => ({
    status: 'insufficient',
    insufficient: reason,
    offsetMs: null,
    correlation: null,
    lagRangeMs: [-maxLagMs, maxLagMs],
    sampleIntervalMs: null,
    audioOnsets: 0,
    motionOnsets: 0,
    strongestOnset: null,
    samplesUsed: motion?.length ?? 0,
    methodVersion: AVSYNC_METHOD_VERSION,
    computedAt,
    limitations,
  });

  // ---- availability (three-state honesty) ----------------------------------
  if (motion === null) {
    return insufficient('motion series not available — the caller states why (video undecodable or never-recorded); no measurement offered');
  }
  if (audio === null) {
    return insufficient('audio track not available — the caller states why (no audio stream, undecodable, or never-recorded); a video-only file yields no A/V alignment and none is fabricated');
  }
  if (motion.length < MIN_SAMPLES) {
    return insufficient(`only ${motion.length} motion samples (need ${MIN_SAMPLES}) — clip too short for onset alignment`);
  }

  // ---- shared time grid -----------------------------------------------------
  const times = motion.map((m) => m.tSec);
  const dts: number[] = [];
  for (let i = 1; i < times.length; i++) dts.push(times[i] - times[i - 1]);
  const dt = [...dts].sort((a, b) => a - b)[Math.floor(dts.length / 2)];
  if (!(dt > 0)) {
    return insufficient('degenerate motion time base — sample times do not advance');
  }
  const nonUniform = dts.filter((d) => Math.abs(d - dt) > dt / 4).length;
  if (nonUniform > 0) {
    limitations.push(`${nonUniform} of ${dts.length} motion sample intervals deviate >25% from the median ${round3(dt * 1000)} ms — the envelope was resampled onto the median grid; stated, not hidden`);
  }

  // ---- audio RMS envelope aligned to the motion grid -------------------------
  const fs = audio.sampleRateHz;
  const win = Math.max(1, Math.round(dt * fs));
  const env: number[] = [];
  for (const t of times) {
    const center = Math.round(t * fs);
    const start = Math.max(0, center - Math.floor(win / 2));
    const end = Math.min(audio.samples.length, start + win);
    if (end - start < win / 2) {
      env.push(0);
      continue;
    }
    let sq = 0;
    for (let i = start; i < end; i++) sq += audio.samples[i] * audio.samples[i];
    env.push(Math.sqrt(sq / (end - start)));
  }

  // ---- flux + onset counts ----------------------------------------------------
  const aFlux = flux(env.map((v) => Math.log(v + 1e-8)));
  const mFlux = flux(motion.map((m) => m.magnitude));
  const countOnsets = (f: number[]): number => {
    const { mean, std } = meanStd(f);
    return f.filter((v) => v > mean + ONSET_K * std && v > 0).length;
  };
  const audioOnsets = countOnsets(aFlux);
  const motionOnsets = countOnsets(mFlux);
  if (audioOnsets === 0) {
    return insufficient('no audio onset in the clip (silence, continuous level, or music without transients) — reported as no-measurement, never as zero offset');
  }
  if (motionOnsets === 0) {
    return insufficient('no motion onset in the clip (static scene or continuous motion without transients) — reported as no-measurement, never as zero offset');
  }

  // ---- normalized cross-correlation over the lag range ------------------------
  const maxLag = Math.max(1, Math.round(maxLagMs / 1000 / dt));
  let best: { lag: number; r: number } | null = null;
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    const xs: number[] = [];
    const ys: number[] = [];
    for (let i = 0; i < aFlux.length; i++) {
      const j = i + lag;
      if (j < 0 || j >= mFlux.length) continue;
      xs.push(aFlux[i]);
      ys.push(mFlux[j]);
    }
    if (xs.length < MIN_SAMPLES) continue;
    const a = meanStd(xs);
    const b = meanStd(ys);
    if (a.std < 1e-12 || b.std < 1e-12) continue;
    let num = 0;
    for (let i = 0; i < xs.length; i++) num += (xs[i] - a.mean) * (ys[i] - b.mean);
    const r = num / (xs.length * a.std * b.std);
    if (!best || r > best.r) best = { lag, r };
  }
  if (!best || best.r < MIN_PEAK_CORR) {
    return insufficient(
      `no coherent alignment found (peak correlation ${best ? round3(best.r) : 'n/a'} < ${MIN_PEAK_CORR} over ±${maxLagMs} ms) — ` +
      'onsets exist but do not lock at any lag; reported as no-measurement, NOT as a dubbing finding (a person weighs the raw series, not an absent number)',
    );
  }

  // Sign convention: corr(aFlux[i], mFlux[i+lag]) peaks at lag L → the audio
  // flux at index i matches the motion flux at i+L → audio LEADS motion by
  // L·dt; audio-minus-motion offset = −L·dt (positive = audio LATER).
  const offsetMs = -best.lag * dt * 1000;

  // ---- secondary: strongest single onset pair ---------------------------------
  const argmax = (f: number[]): number => {
    let k = 0;
    for (let i = 1; i < f.length; i++) if (f[i] > f[k]) k = i;
    return k;
  };
  const aIdx = argmax(aFlux);
  const mIdx = argmax(mFlux);
  const strongestOnset = {
    audioAtSec: round3(times[aIdx]),
    motionAtSec: round3(times[mIdx]),
    offsetMs: round3((times[aIdx] - times[mIdx]) * 1000),
  };

  return {
    status: 'measured',
    insufficient: false,
    offsetMs: round3(offsetMs),
    correlation: round3(best.r),
    lagRangeMs: [-maxLagMs, maxLagMs],
    sampleIntervalMs: round3(dt * 1000),
    audioOnsets,
    motionOnsets,
    strongestOnset,
    samplesUsed: motion.length,
    methodVersion: AVSYNC_METHOD_VERSION,
    computedAt,
    limitations,
  };
}

// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Desk-side display-beat analyzer.
 *
 * Input: a luma series — mean luma per sampled frame with its time — from
 * the video track (CLI: ffmpeg rasterization) or from the preview ring
 * frames (CLI: the ring dump, uniform spacing assumed and disclosed).
 *
 * Method — PURE DETERMINISTIC SIGNAL MEASUREMENT (G1 design rules apply):
 *  1. The luma series is detrended (mean + linear trend removed) and Hann
 *     windowed; its magnitude spectrum is evaluated by direct DFT on a
 *     quarter-bin grid from just above DC to Nyquist.
 *  2. Display-refresh families (50 / 59.94 / 60 Hz — mains and NTSC/PAL
 *     display standards) are folded through the actual sample rate: each
 *     harmonic k×f0 aliases to a definite position in the measured band.
 *     Every candidate is reported with its aliased position and its SNR
 *     against the local noise floor — including candidates that alias
 *     BELOW the frequency resolution (e.g. exactly-30 fps sampling of a
 *     60 Hz display aliases to DC) which are marked NOT ASSESSABLE rather
 *     than silently scored as zero.
 *  3. Independently of the families, the strongest periodic component
 *     anywhere in the band is reported (measured frequency + SNR). A
 *     screen recapture typically beats where display refresh and capture
 *     cadence disagree; mains lighting beats at the same families for
 *     innocent reasons — the analyzer measures, it never decides which.
 *
 * OUTPUT: an evidence object for a person to weigh — measured beat
 * frequency and strength with a method note. NEVER a recapture verdict,
 * never a gate. Insufficient data (too few frames, flat luma) reports
 * 'insufficient' with the specific reason — never a number dressed up as
 * evidence. A strong beat is CONSISTENT WITH screen recapture and with
 * other periodic illumination; a missing beat proves nothing (flicker-free
 * displays, DC-aliased sampling). Both directions are stated inline.
 */

export const DISPLAY_BEAT_METHOD_VERSION = '1.0.0-ws5-t1';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One luma observation: mean frame luma at a video time. */
export interface LumaSample {
  tSec: number;
  luma: number;
}

export interface DisplayBeatCandidate {
  /** Display family this candidate belongs to: 50, 59.94, or 60 Hz. */
  familyHz: number;
  /** Harmonic number k — the physical modulation would be at k×familyHz. */
  harmonic: number;
  /** k×familyHz before aliasing. */
  sourceHz: number;
  /** Where k×familyHz lands in the measured band after folding at the sample rate. */
  aliasedHz: number;
  /**
   * SNR of the spectral peak near the aliased position against the band's
   * noise floor, dB. Null when the candidate is not assessable at this
   * sample rate / duration (aliases below frequency resolution).
   */
  snrDb: number | null;
  assessable: boolean;
  /** Set when assessable is false — the reason, stated not hidden. */
  note: string | null;
}

export interface DisplayBeatEvidence {
  status: 'measured' | 'insufficient';
  /** false, or the specific reason no measurement could be made. */
  insufficient: false | string;
  samplesUsed: number;
  sampleRateHz: number;
  durationSec: number;
  /**
   * The strongest periodic luma component anywhere in the measurable band,
   * whatever its origin. Null when no component rises above the noise floor
   * by MIN_BEAT_SNR_DB — reported as 'no periodic component measured', never
   * as 'no recapture'.
   */
  strongestBeat: null | {
    frequencyHz: number;
    snrDb: number;
    note: string;
  };
  /** Per-family candidate evaluations (assessable ones carry snrDb). */
  candidates: DisplayBeatCandidate[];
  methodVersion: typeof DISPLAY_BEAT_METHOD_VERSION;
  computedAt: string;
  limitations: string[];
}

// ---------------------------------------------------------------------------
// Constants — stated, not hidden
// ---------------------------------------------------------------------------

/** Display-refresh families, Hz: PAL/SECAM mains, NTSC pull-down, nominal 60. */
const FAMILIES = [50, 59.94, 60];
/** Harmonics evaluated per family (k×f0 ≤ 240 Hz covers 2×120-class panels). */
const MAX_HARMONIC = 4;
/** Minimum samples for a meaningful spectrum. */
const MIN_SAMPLES = 16;
/** Minimum luma variance (ITU-R 601 units²) — below this the series is flat. */
const MIN_LUMA_VAR = 0.25;
/** SNR above the noise floor for a component to be reported as measured. */
const MIN_BEAT_SNR_DB = 6;

const FIXED_LIMITATIONS = [
  'corpus characterization pending; no error rates published',
  'a signal measurement for human review — evidence a person weighs, never a recapture verdict and never a gate',
  'a periodic luma beat at a display family is CONSISTENT WITH screen recapture and with innocent periodic illumination (mains lighting flickers at the same 50/60 Hz families); this analyzer measures the beat, it never attributes it',
  'a missing beat proves nothing: flicker-free / high-PWM displays, DC-aliased sampling (display rate an exact multiple of the frame rate), and short clips all yield no measurable beat',
  'mean-luma analysis discards spatial information — rolling brightness bands that average out across the frame are invisible to this measurement (visual banding is the rephoto analyzer\'s signal, run separately)',
];

// ---------------------------------------------------------------------------
// Small numeric helpers
// ---------------------------------------------------------------------------

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length)));
  return sorted[i];
}

const round3 = (v: number): number => Math.round(v * 1000) / 1000;

/** Fold a physical frequency into [0, fs/2] at sample rate fs. */
function aliasInto(fHz: number, fsHz: number): number {
  const m = ((fHz % fsHz) + fsHz) % fsHz;
  return m <= fsHz / 2 ? m : fsHz - m;
}

// ---------------------------------------------------------------------------
// The analyzer
// ---------------------------------------------------------------------------

export interface DisplayBeatOptions {
  /**
   * Sample rate of the luma series, Hz. Required — for the ring dump the
   * CLI passes the assumed uniform frame interval (1/30 s by default) and
   * the limitation says so.
   */
  sampleRateHz: number;
  /** Origin note for the limitations list (e.g. 'video track, ffmpeg fps=30' or '8-frame ring dump, uniform spacing assumed'). */
  sourceNote?: string;
  /** Injection point for tests. */
  now?: Date;
}

export function analyzeDisplayBeat(
  seriesIn: LumaSample[] | null,
  opts: DisplayBeatOptions,
): DisplayBeatEvidence {
  const computedAt = (opts.now ?? new Date()).toISOString();
  const limitations: string[] = [...FIXED_LIMITATIONS];
  const fs = opts.sampleRateHz;
  if (opts.sourceNote) limitations.push(`luma source: ${opts.sourceNote}`);

  const series = seriesIn ?? [];
  const durationSec = series.length >= 2 ? series[series.length - 1].tSec - series[0].tSec : 0;

  const insufficient = (reason: string): DisplayBeatEvidence => ({
    status: 'insufficient',
    insufficient: reason,
    samplesUsed: series.length,
    sampleRateHz: fs,
    durationSec: round3(durationSec),
    strongestBeat: null,
    candidates: [],
    methodVersion: DISPLAY_BEAT_METHOD_VERSION,
    computedAt,
    limitations,
  });

  // ---- 0. input availability (three-state honesty: absent ≠ flat) --------
  if (seriesIn === null) {
    return insufficient('luma series not available — the caller states why (video undecodable, ring absent, or never-recorded); no measurement offered');
  }
  if (!Number.isFinite(fs) || fs <= 0) {
    return insufficient('sample rate not available — the luma series has no usable time base');
  }
  if (series.length < MIN_SAMPLES) {
    return insufficient(`only ${series.length} luma samples (need ${MIN_SAMPLES}) — clip too short or too few frames decoded for a periodicity measurement`);
  }

  // ---- 1. detrend + window -----------------------------------------------
  const n = series.length;
  const t0 = series[0].tSec;
  const times = series.map((s) => s.tSec - t0);
  const T = times[n - 1];
  if (T <= 0) {
    return insufficient('degenerate time base — all samples at the same timestamp');
  }
  // Frequency resolution: a component must complete ≥1.5 cycles to be
  // assessed (quarter-bin scan grid; below this it is indistinguishable
  // from the trend we removed).
  const fMin = 1.5 / T;
  const df = 1 / (4 * T);
  const fMax = fs / 2;

  const xs = series.map((s) => s.luma);
  const mean = xs.reduce((s, v) => s + v, 0) / n;
  // Linear trend removal (least squares slope).
  let stt = 0;
  let stx = 0;
  for (let i = 0; i < n; i++) {
    stt += (times[i] - T / 2) ** 2;
    stx += (times[i] - T / 2) * (xs[i] - mean);
  }
  const slope = stt > 1e-12 ? stx / stt : 0;
  const detrended = xs.map((v, i) => v - mean - slope * (times[i] - T / 2));
  const variance = detrended.reduce((s, v) => s + v * v, 0) / n;
  if (variance < MIN_LUMA_VAR) {
    return insufficient(
      `luma is flat within noise (variance ${round3(variance)} < ${MIN_LUMA_VAR}) — no periodic component is present to measure; ` +
      'a flicker-free display or a static real scene both produce this, so it is not evidence in either direction',
    );
  }
  // Hann window.
  const win = detrended.map((v, i) => v * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1))));

  // ---- 2. magnitude spectrum on a quarter-bin grid ------------------------
  const mags: { f: number; m: number }[] = [];
  for (let f = df; f <= fMax + 1e-12; f += df) {
    let re = 0;
    let im = 0;
    for (let i = 0; i < n; i++) {
      const ph = -2 * Math.PI * f * times[i];
      re += win[i] * Math.cos(ph);
      im += win[i] * Math.sin(ph);
    }
    mags.push({ f, m: Math.hypot(re, im) / n });
  }
  // Noise floor: median magnitude over ALL bins ≥ fMin — no guard-band
  // exclusion. A real beat raises its own floor slightly; median-of-all-bins
  // is robust to that and keeps the estimator simple and stated.
  const floorPool = mags.filter((b) => b.f >= fMin).map((b) => b.m).sort((a, b) => a - b);
  const floor = percentile(floorPool, 50);
  if (floor <= 1e-12) {
    return insufficient('spectral noise floor is zero — the luma series is noiseless (synthetic or degenerate input); no honest SNR can be stated');
  }

  const peakNear = (fTarget: number): { f: number; m: number } | null => {
    let best: { f: number; m: number } | null = null;
    for (const b of mags) {
      if (Math.abs(b.f - fTarget) > 1.5 * df * 4) continue; // ±1.5 bins
      if (!best || b.m > best.m) best = b;
    }
    return best;
  };

  // ---- 3. display-family candidates ---------------------------------------
  const candidates: DisplayBeatCandidate[] = [];
  let sawUnassessable = false;
  for (const f0 of FAMILIES) {
    for (let k = 1; k <= MAX_HARMONIC; k++) {
      const source = round3(f0 * k);
      const aliased = aliasInto(f0 * k, fs);
      if (aliased < fMin || aliased > fMax) {
        sawUnassessable = true;
        candidates.push({
          familyHz: f0,
          harmonic: k,
          sourceHz: source,
          aliasedHz: round3(aliased),
          snrDb: null,
          assessable: false,
          note:
            aliased < fMin
              ? `aliases to ${round3(aliased)} Hz — below the ${round3(fMin)} Hz frequency resolution at ${n} samples / ${round3(T)} s (display rate near-commensurate with the sample rate folds the beat onto DC); NOT assessable, stated rather than scored as absent`
              : `aliases above Nyquist (${round3(fMax)} Hz) at this sample rate; NOT assessable`,
        });
        continue;
      }
      const p = peakNear(aliased);
      const snrDb = p ? 20 * Math.log10(p.m / floor) : null;
      candidates.push({
        familyHz: f0,
        harmonic: k,
        sourceHz: source,
        aliasedHz: round3(aliased),
        snrDb: snrDb === null ? null : round3(snrDb),
        assessable: true,
        note: null,
      });
    }
  }
  if (sawUnassessable) {
    limitations.push('one or more display-family harmonics alias below the frequency resolution at this sample rate — marked NOT assessable per candidate, never counted as absent');
  }

  // ---- 4. strongest periodic component anywhere in the band ---------------
  let strongest: { f: number; m: number } | null = null;
  for (const b of mags) {
    if (b.f < fMin) continue;
    if (!strongest || b.m > strongest.m) strongest = b;
  }
  let strongestBeat: DisplayBeatEvidence['strongestBeat'] = null;
  if (strongest) {
    const snrDb = 20 * Math.log10(strongest.m / floor);
    if (snrDb >= MIN_BEAT_SNR_DB) {
      strongestBeat = {
        frequencyHz: round3(strongest.f),
        snrDb: round3(snrDb),
        note:
          `strongest periodic luma component at ${round3(strongest.f)} Hz, ${round3(snrDb)} dB above the band noise floor; ` +
          'measured, not attributed — compare against the display-family candidates and the sample-rate aliasing disclosed per candidate',
      };
    }
  }

  return {
    status: 'measured',
    insufficient: false,
    samplesUsed: n,
    sampleRateHz: fs,
    durationSec: round3(T),
    strongestBeat,
    candidates,
    methodVersion: DISPLAY_BEAT_METHOD_VERSION,
    computedAt,
    limitations,
  };
}

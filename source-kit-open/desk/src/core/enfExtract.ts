/**
 * Desk-side audio ENF extractor — EXTRACT ONLY. There is deliberately NO
 * reference matching at Tier 1: matching against a grid reference is a
 * separate tier and needs reference data this analyzer neither has nor
 * simulates.
 *
 * Input: mono LPCM (the capture module records raw 16 kHz mono alongside
 * the delivery track) plus the capture's `mainsHz` anti-banding hint
 * — region-derived (iOS exposes no anti-banding API; the hint is 50/60 Hz
 * from the device region, never a measured flicker). When the hint is
 * absent BOTH families are evaluated and the choice is disclosed.
 *
 * Method — PURE DETERMINISTIC SIGNAL MEASUREMENT:
 *  1. The signal is heterodyned to baseband at the nominal mains frequency
 *     (multiply by e^(−i2πf0·t), boxcar low-pass over SMOOTH_SEC).
 *  2. Per WINDOW_SEC window (HOP_SEC hop) the instantaneous mains frequency
 *     is the lag-1 autocorrelation phase estimator over the smoothed
 *     baseband: f = f0 + (fs/2π)·arg(Σ b[n]·conj(b[n−1])). Deterministic,
 *     O(N), no iterative fit.
 *  3. Per-window quality: Goertzel power at the estimated frequency vs the
 *     MEDIAN of a wide guard-bin set (±2…±8 Hz) → SNR dB. Windows below
 *     MIN_SNR_DB carry no usable mains hum and are marked unusable — their
 *     frequency values are still reported (transparency) but excluded from
 *     the quality aggregates. A trace is reported only when the hum is
 *     SUSTAINED (≥MIN_USABLE_WINDOWS windows, ≥50% coverage, coherent
 *     frequency) — broadband noise selecting a few windows is chance, not
 *     coupling, and is reported as no-extraction.
 *
 * THE 30-SECOND RULE (Tier-1 law): under 30 s of audio
 * the report is `insufficient` — NO trace, NO mean frequency, nothing that
 * could be quoted as an ENF number. A short-window estimate is a number
 * that looks like evidence without the support for it.
 *
 * OUTPUT: the extracted trace + its quality metrics, explicitly labeled
 * "extract only; no reference matching at Tier 1". Never a verdict, never
 * a gate, never a match score. The trace's timestamps are the container's
 * own — nothing here ties them to wall-clock; that claim is Tier 2's.
 */

export const ENF_EXTRACT_METHOD_VERSION = '1.0.0-ws5-t1';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EnfTracePoint {
  /** Window center, seconds from audio start (container time base). */
  tSec: number;
  /** Estimated instantaneous mains frequency, Hz. */
  hz: number;
  /** Per-window hum SNR against guard bins, dB. */
  snrDb: number;
  /** False when snrDb < MIN_SNR_DB — value reported but excluded from aggregates. */
  usable: boolean;
}

export interface EnfExtractEvidence {
  status: 'extracted' | 'insufficient';
  /** false, or the specific reason no extraction is offered. */
  insufficient: false | string;
  /** Literal true — the Tier-1 contract: extraction, never matching. */
  extractOnly: true;
  /** The capture's mainsHz hint as received (50/60), or null when absent. */
  mainsHintHz: 50 | 60 | null;
  /** Provenance of the hint — region-derived is NOT a measurement. */
  mainsHintBasis: 'region-derived' | 'absent';
  /** The nominal family the trace was extracted around. Null when insufficient. */
  nominalHz: number | null;
  /**
   * How the nominal was chosen: the hint, or — hint absent — the family
   * with the higher mean hum SNR (disclosed, both evaluated).
   */
  nominalBasis: 'mainsHz-hint' | 'strongest-hum-of-both-families' | null;
  durationSec: number;
  sampleRateHz: number;
  /** The trace. Null whenever status is 'insufficient' — never a partial number. */
  trace: EnfTracePoint[] | null;
  /** Quality aggregates over usable windows. Null whenever insufficient. */
  quality: null | {
    windowsTotal: number;
    windowsUsable: number;
    /** windowsUsable / windowsTotal. */
    coverage: number;
    meanSnrDb: number;
    /** Stddev of the usable trace frequencies, Hz — trace stability. */
    hzStd: number;
  };
  /**
   * Mean hum SNR per family when the hint was absent and both were
   * evaluated — the basis for nominalBasis, stated not hidden.
   */
  bothFamilyMeanSnrDb: { at50Hz: number; at60Hz: number } | null;
  methodVersion: typeof ENF_EXTRACT_METHOD_VERSION;
  computedAt: string;
  limitations: string[];
}

// ---------------------------------------------------------------------------
// Constants — stated, not hidden
// ---------------------------------------------------------------------------

/** Tier-1 law: under this duration the report is 'insufficient'. */
export const ENF_MIN_DURATION_SEC = 30;
/** Window / hop for the instantaneous-frequency estimator, seconds. */
const WINDOW_SEC = 2;
const HOP_SEC = 1;
/** Baseband smoothing, seconds (kills speech/music above ~2 Hz). */
const SMOOTH_SEC = 0.25;
/**
 * Guard-bin offsets for the hum SNR, Hz around the estimated frequency:
 * the floor is the MEDIAN of these (a two-bin floor is itself noisy and
 * lets broadband noise "select" a fake hum window — the median of eight
 * bins across the band is stable; stated, not hidden).
 */
const GUARD_OFFSETS_HZ = [-8, -6, -4, -2, 2, 4, 6, 8];
/** Widest guard excursion, for the Nyquist pre-check. */
const GUARD_HZ = 8;
/**
 * Per-window hum SNR below which the window is unusable, dB. Set high
 * enough that a single Goertzel bin over broadband noise (χ²₂-distributed,
 * dozens of windows to select from) cannot carry a window by chance; the
 * corpus characterization will revisit this with measured noise floors.
 */
const MIN_SNR_DB = 6;
/**
 * Sustained-coupling gate: a trace is only reported when the hum is
 * present for MOST of the clip AND at a coherent frequency — a few noisy
 * windows above the SNR gate are chance, not coupling, and must never
 * fabricate a trace. Erring toward 'insufficient' is the honest direction
 * until the corpus publishes real error rates.
 */
const MIN_USABLE_WINDOWS = 5;
const MIN_COVERAGE = 0.5;
/** Usable-trace frequency spread above which the "trace" is incoherent noise. */
const MAX_TRACE_HZ_STD = 0.5;
/** RMS floor — below this the audio is silence and no trace is meaningful. */
const MIN_RMS = 1e-5;

const FIXED_LIMITATIONS = [
  'corpus characterization pending; no error rates published',
  'extract only; no reference matching at Tier 1 — this trace is never compared against any grid reference here, and no consistency-with-claims conclusion follows from it by itself',
  'evidence a person weighs, never a verdict and never a gate',
  'the mainsHz hint is region-derived (iOS exposes no anti-banding API) — it selects the extraction family, it is NOT a measured flicker and must not be quoted as one',
  'trace timestamps are the container\'s own time base — nothing here ties them to wall-clock; binding an ENF trace to absolute time is a separate tier with grid-reference data, which this analyzer deliberately does not do',
  'mains hum reaches a microphone only when the recorder is electrically or acoustically coupled to the grid; a weak or absent trace is common in honest recordings and proves nothing',
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const round3 = (v: number): number => Math.round(v * 1000) / 1000;

/** Goertzel power at fHz over samples[start..start+len). */
function goertzelPower(x: ArrayLike<number>, start: number, len: number, fs: number, fHz: number): number {
  const w = (2 * Math.PI * fHz) / fs;
  const c = 2 * Math.cos(w);
  let s0 = 0;
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < len; i++) {
    s0 = x[start + i] + c * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return s1 * s1 + s2 * s2 - c * s1 * s2;
}

interface FamilyResult {
  nominal: number;
  trace: EnfTracePoint[];
  meanSnrDb: number; // over usable windows; 0 when none
}

/** Heterodyne + lag-1 autocorrelation extraction around one nominal family. */
function extractFamily(samples: Float64Array, fs: number, nominal: number): FamilyResult {
  const n = samples.length;
  const smoothN = Math.max(2, Math.round(SMOOTH_SEC * fs));
  const winN = Math.round(WINDOW_SEC * fs);
  const hopN = Math.round(HOP_SEC * fs);

  // Heterodyne to baseband, then low-pass with the boxcar CASCADED TWICE
  // (triangular impulse response, ~2×SMOOTH_SEC span): speech/music
  // heterodyned to tens of Hz leaks through a single boxcar's sidelobes
  // and biases the phase estimator — the cascade squares the attenuation.
  const bre = new Float64Array(n);
  const bim = new Float64Array(n);
  for (let pass = 0; pass < 2; pass++) {
    let accRe = 0;
    let accIm = 0;
    const qRe = new Float64Array(smoothN);
    const qIm = new Float64Array(smoothN);
    for (let i = 0; i < n; i++) {
      let re: number;
      let im: number;
      if (pass === 0) {
        const ph = -2 * Math.PI * nominal * (i / fs);
        re = samples[i] * Math.cos(ph);
        im = samples[i] * Math.sin(ph);
      } else {
        re = bre[i];
        im = bim[i];
      }
      const q = i % smoothN;
      accRe += re - qRe[q];
      accIm += im - qIm[q];
      qRe[q] = re;
      qIm[q] = im;
      bre[i] = accRe / smoothN;
      bim[i] = accIm / smoothN;
    }
  }

  // Pass 1: per-window frequency estimates (lag-1 autocorrelation phase).
  const starts: number[] = [];
  const estHz: number[] = [];
  for (let start = 0; start + winN <= n; start += hopN) {
    let zre = 0;
    let zim = 0;
    for (let i = start + 1; i < start + winN; i++) {
      zre += bre[i] * bre[i - 1] + bim[i] * bim[i - 1];
      zim += bim[i] * bre[i - 1] - bre[i] * bim[i - 1];
    }
    starts.push(start);
    estHz.push(nominal + (fs / (2 * Math.PI)) * Math.atan2(zim, zre));
  }
  // Pass 2: per-window hum SNR evaluated at the GLOBAL median estimated
  // frequency — NEVER at the window's own estimate. Evaluating power at
  // the frequency the window itself picked is circular: broadband noise
  // always has SOME peak near the estimate, so the SNR would be inflated
  // and a hum-free recording could "select" itself a fake trace. The
  // global median is one frequency for the whole clip; real grid drift
  // (≪ 0.5 Hz over a clip) sits inside the 2 s window's mainlobe.
  const sortedEst = [...estHz].sort((a, b) => a - b);
  const globalHz = sortedEst.length > 0 ? sortedEst[Math.floor(sortedEst.length / 2)] : nominal;
  const trace: EnfTracePoint[] = [];
  for (let k = 0; k < starts.length; k++) {
    const start = starts[k];
    const pSig = goertzelPower(samples, start, winN, fs, globalHz);
    const guards = GUARD_OFFSETS_HZ
      .map((off) => (globalHz + off > 1 ? goertzelPower(samples, start, winN, fs, globalHz + off) : null))
      .filter((p): p is number => p !== null)
      .sort((a, b) => a - b);
    const floor = guards.length > 0 ? guards[Math.floor(guards.length / 2)] : 0;
    const snrDb = floor > 0 ? 10 * Math.log10((pSig + 1e-30) / floor) : 0;
    trace.push({
      tSec: round3((start + winN / 2) / fs),
      hz: round3(estHz[k]),
      snrDb: round3(snrDb),
      usable: snrDb >= MIN_SNR_DB,
    });
  }
  const usable = trace.filter((p) => p.usable);
  const meanSnrDb = usable.length > 0 ? usable.reduce((s, p) => s + p.snrDb, 0) / usable.length : 0;
  return { nominal, trace, meanSnrDb };
}

// ---------------------------------------------------------------------------
// The analyzer
// ---------------------------------------------------------------------------

export interface EnfExtractOptions {
  /** The capture's mainsHz hint (region-derived), or null when absent. */
  mainsHz?: 50 | 60 | null;
  /** Injection point for tests. */
  now?: Date;
}

/**
 * @param samples Mono PCM, any scale (frequency estimation is scale-free).
 *   Null = audio not available — the caller states why (absent vs
 *   never-recorded) and this analyzer reports 'not available', never fails
 *   and never fabricates.
 * @param sampleRateHz PCM sample rate (the capture module records 16 kHz mono).
 */
export function extractEnfTrace(
  samples: ArrayLike<number> | null,
  sampleRateHz: number,
  opts: EnfExtractOptions = {},
): EnfExtractEvidence {
  const computedAt = (opts.now ?? new Date()).toISOString();
  const limitations: string[] = [...FIXED_LIMITATIONS];
  const hint = opts.mainsHz ?? null;
  const n = samples?.length ?? 0;
  const durationSec = sampleRateHz > 0 ? n / sampleRateHz : 0;

  const insufficient = (reason: string): EnfExtractEvidence => ({
    status: 'insufficient',
    insufficient: reason,
    extractOnly: true,
    mainsHintHz: hint,
    mainsHintBasis: hint === null ? 'absent' : 'region-derived',
    nominalHz: null,
    nominalBasis: null,
    durationSec: round3(durationSec),
    sampleRateHz,
    trace: null,
    quality: null,
    bothFamilyMeanSnrDb: null,
    methodVersion: ENF_EXTRACT_METHOD_VERSION,
    computedAt,
    limitations,
  });

  // ---- availability (three-state honesty: absent ≠ never-recorded ≠ present)
  if (samples === null) {
    return insufficient('audio not available — the caller states why (no audio track, undecodable, or never-recorded); no extraction offered');
  }
  if (!Number.isFinite(sampleRateHz) || sampleRateHz < 200) {
    return insufficient(`sample rate ${sampleRateHz} Hz unusable — mains frequencies (50/60 Hz + guard bins) must sit well inside the band`);
  }
  if (hint !== null && 2 * (hint + GUARD_HZ + 2) >= sampleRateHz) {
    return insufficient(`mains family ${hint} Hz too close to Nyquist at ${sampleRateHz} Hz — extraction would alias`);
  }

  // ---- THE 30-second rule: no trace, no mean, no number that looks like evidence
  if (durationSec < ENF_MIN_DURATION_SEC) {
    return insufficient(
      `audio duration ${round3(durationSec)} s < ${ENF_MIN_DURATION_SEC} s — under 30 s no ENF trace is reported at Tier 1: ` +
      'a short-window estimate would be a number that looks like evidence without the support for it',
    );
  }

  const x = Float64Array.from(samples as ArrayLike<number>);
  const rms = Math.sqrt(x.reduce((s, v) => s + v * v, 0) / x.length);
  if (rms < MIN_RMS) {
    return insufficient('audio is silence within numerical noise — no mains hum present to extract (and none claimed)');
  }

  // ---- extract around the nominal family ----------------------------------
  let nominal: number;
  let nominalBasis: EnfExtractEvidence['nominalBasis'];
  let result: FamilyResult;
  let both: EnfExtractEvidence['bothFamilyMeanSnrDb'] = null;
  if (hint !== null) {
    nominal = hint;
    nominalBasis = 'mainsHz-hint';
    result = extractFamily(x, sampleRateHz, hint);
  } else {
    // Hint absent: evaluate BOTH families, keep the stronger hum, disclose.
    const r50 = extractFamily(x, sampleRateHz, 50);
    const r60 = extractFamily(x, sampleRateHz, 60);
    result = r50.meanSnrDb >= r60.meanSnrDb ? r50 : r60;
    nominal = result.nominal;
    nominalBasis = 'strongest-hum-of-both-families';
    both = { at50Hz: round3(r50.meanSnrDb), at60Hz: round3(r60.meanSnrDb) };
    limitations.push(
      `mainsHz hint absent — both families extracted (mean hum SNR 50 Hz: ${round3(r50.meanSnrDb)} dB, 60 Hz: ${round3(r60.meanSnrDb)} dB); ` +
      `trace extracted around ${nominal} Hz as the stronger. The hint is region-derived when present — its absence changes the basis, not the physics`,
    );
  }

  const usable = result.trace.filter((p) => p.usable);
  const meanHz = usable.length > 0 ? usable.reduce((s, p) => s + p.hz, 0) / usable.length : 0;
  const hzStd = usable.length > 1
    ? Math.sqrt(usable.reduce((s, p) => s + (p.hz - meanHz) ** 2, 0) / (usable.length - 1))
    : 0;
  if (usable.length < MIN_USABLE_WINDOWS || usable.length / result.trace.length < MIN_COVERAGE || hzStd > MAX_TRACE_HZ_STD) {
    return {
      ...insufficient(
        `mains hum not sustained: ${usable.length} of ${result.trace.length} windows above ${MIN_SNR_DB} dB SNR, trace σ=${round3(hzStd)} Hz ` +
        `(need ≥${MIN_USABLE_WINDOWS} windows, ≥${MIN_COVERAGE * 100}% coverage, σ ≤ ${MAX_TRACE_HZ_STD} Hz) — the recording is not coupled to the grid ` +
        'strongly enough for a trace; a handful of noisy windows is chance, not coupling, and is reported as no-extraction, never as a trace',
      ),
      nominalHz: nominal,
      nominalBasis,
    };
  }

  return {
    status: 'extracted',
    insufficient: false,
    extractOnly: true,
    mainsHintHz: hint,
    mainsHintBasis: hint === null ? 'absent' : 'region-derived',
    nominalHz: nominal,
    nominalBasis,
    durationSec: round3(durationSec),
    sampleRateHz,
    trace: result.trace,
    quality: {
      windowsTotal: result.trace.length,
      windowsUsable: usable.length,
      coverage: round3(usable.length / result.trace.length),
      meanSnrDb: round3(result.meanSnrDb),
      hzStd: round3(hzStd),
    },
    bothFamilyMeanSnrDb: both,
    methodVersion: ENF_EXTRACT_METHOD_VERSION,
    computedAt,
    limitations,
  };
}

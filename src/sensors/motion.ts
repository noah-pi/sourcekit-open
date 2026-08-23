// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Motion-signature analysis of the accelerometer stream captured while the
 * shutter was open. A context signal, not a biometric: it distinguishes
 * handheld from still, and identifies nobody.
 *
 * Method: remove gravity with an exponential moving average, take the
 * magnitude of the residual, compute RMS, and find the dominant frequency
 * between 1–25 Hz with a small radix-2 FFT. Hand tremor clusters around
 * 8–12 Hz; that band is reported as telemetry.
 *
 * Pure module: no React Native dependencies.
 */

import type { MotionSummary, PoseTrace } from '../provenance/manifest';

export interface MotionSample {
  x: number;
  y: number;
  z: number;
  /** Milliseconds. */
  t: number;
}

const TARGET_HZ = 100;
const MIN_SAMPLES = 64;

/** RMS thresholds (in g) for the human-readable verdicts. */
const RMS_STEADY = 0.008;
const RMS_MOVING = 0.35;

function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

/** In-place radix-2 Cooley–Tukey FFT. */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 0, j = 0; i < n; i++) {
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
    let m = n >> 1;
    while (m >= 1 && j >= m) { j -= m; m >>= 1; }
    j += m;
  }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const step = (-2 * Math.PI) / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < half; k++) {
        const angle = step * k;
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        const aR = re[i + k];
        const aI = im[i + k];
        const bR = re[i + k + half] * cos - im[i + k + half] * sin;
        const bI = re[i + k + half] * sin + im[i + k + half] * cos;
        re[i + k] = aR + bR;
        im[i + k] = aI + bI;
        re[i + k + half] = aR - bR;
        im[i + k + half] = aI - bI;
      }
    }
  }
}

export interface SensorTiming {
  /** Raw samples observed in the window. */
  samples: number;
  /**
   * Coefficient of variation of inter-sample intervals (stddev/mean; 0 is
   * perfectly regular). Synthetic feeds tend to be too regular or too
   * bursty. A bounded signal, not a verdict (docs/INTEGRITY.md).
   */
  intervalCv: number;
}

/** Inter-sample interval regularity of the raw sensor feed. */
export function analyzeTiming(raw: MotionSample[]): SensorTiming | null {
  if (raw.length < 8) return null;
  const intervals: number[] = [];
  for (let i = 1; i < raw.length; i++) {
    const d = raw[i].t - raw[i - 1].t;
    if (d > 0 && d < 1000) intervals.push(d);
  }
  if (intervals.length < 4) return null;
  const mean = intervals.reduce((a, b) => a + b, 0) / intervals.length;
  if (mean <= 0) return null;
  const variance = intervals.reduce((a, b) => a + (b - mean) * (b - mean), 0) / intervals.length;
  const cv = Math.sqrt(variance) / mean;
  return { samples: raw.length, intervalCv: Math.round(cv * 1000) / 1000 };
}

export function analyzeMotion(raw: MotionSample[]): MotionSummary {
  if (raw.length < MIN_SAMPLES) {
    return { verdict: 'insufficient-data', rms: 0, peakHz: 0 };
  }

  // 1. Resample to a uniform grid (expo-sensors delivers irregularly).
  const fs = TARGET_HZ;
  const dt = 1000 / fs;
  const t0 = raw[0].t;
  const duration = raw[raw.length - 1].t - t0;
  const n = Math.floor(duration / dt);
  if (n < MIN_SAMPLES) {
    return { verdict: 'insufficient-data', rms: 0, peakHz: 0 };
  }

  const mag = new Float64Array(n);
  const sigX = new Float64Array(n); // signed residual; the FFT needs the sign to preserve tremor frequency
  let idx = 0;
  // 2. Gravity removal via EMA (~0.5 s time constant).
  const alpha = 0.5 / (0.5 + dt / 1000);
  let gx = raw[0].x;
  let gy = raw[0].y;
  let gz = raw[0].z;
  for (let i = 0; i < n; i++) {
    const target = t0 + i * dt;
    while (idx < raw.length - 2 && raw[idx + 1].t < target) idx++;
    const s0 = raw[idx];
    const s1 = raw[idx + 1];
    const span = s1.t - s0.t;
    const f = span > 0 ? Math.min(1, Math.max(0, (target - s0.t) / span)) : 0;
    const x = s0.x + (s1.x - s0.x) * f;
    const y = s0.y + (s1.y - s0.y) * f;
    const z = s0.z + (s1.z - s0.z) * f;
    gx = alpha * gx + (1 - alpha) * x;
    gy = alpha * gy + (1 - alpha) * y;
    gz = alpha * gz + (1 - alpha) * z;
    const dx = x - gx;
    const dy = y - gy;
    const dz = z - gz;
    mag[i] = Math.sqrt(dx * dx + dy * dy + dz * dz);
    sigX[i] = dx;
  }

  // 3. RMS of the gravity-compensated magnitude.
  let sumSq = 0;
  for (let i = 0; i < n; i++) sumSq += mag[i] * mag[i];
  const rms = Math.sqrt(sumSq / n);

  // 4. Dominant frequency in 1–25 Hz (Hann-windowed FFT on the signed residual,
  //    so a 9 Hz tremor reads as 9 Hz rather than its rectified harmonic).
  const N = nextPow2(n);
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  for (let i = 0; i < n; i++) {
    const w = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
    re[i] = sigX[i] * w;
  }
  fft(re, im);
  const binHz = fs / N;
  let peakHz = 0;
  let peakPower = 0;
  for (let k = 1; k <= N / 2; k++) {
    const hz = k * binHz;
    if (hz < 1 || hz > 25) continue;
    const power = re[k] * re[k] + im[k] * im[k];
    if (power > peakPower) {
      peakPower = power;
      peakHz = hz;
    }
  }

  const r3 = (v: number) => Math.round(v * 1000) / 1000;
  const r1 = (v: number) => Math.round(v * 10) / 10;

  let verdict: MotionSummary['verdict'];
  if (rms < RMS_STEADY) verdict = 'steady';
  else if (rms > RMS_MOVING) verdict = 'moving';
  else verdict = 'handheld';

  return { verdict, rms: r3(rms), peakHz: r1(peakHz) };
}


// ---------------------------------------------------------------------------
// Signed pose trace.
// ---------------------------------------------------------------------------

/**
 * One fused DeviceMotion sample: CoreMotion's rotation rate, attitude, and
 * gravity-free user acceleration. A sample missing any component is skipped
 * rather than zero-filled.
 */
export interface PoseSample {
  /** Milliseconds epoch. */
  t: number;
  /** User acceleration with gravity removed, g. */
  ax: number;
  ay: number;
  az: number;
  /** Rotation rate (gyro), rad/s. */
  rx: number;
  ry: number;
  rz: number;
  /** Fused attitude, degrees (roll = gamma, pitch = beta, yaw = alpha). */
  roll: number;
  pitch: number;
  yaw: number;
}

export interface PoseTraceOptions {
  /** Window before the shutter moment, ms (default 3000). */
  beforeMs?: number;
  /** Window after the shutter moment, ms (default 500, covering shutter lag). */
  afterMs?: number;
  /** Decimated sample rate, Hz (default 20). */
  hz?: number;
  /** Hard cap on emitted samples (default 70 ≈ 3.5 s at 20 Hz). */
  maxSamples?: number;
}

const TRACE_MIN_SAMPLES = 8;
const clampI16 = (v: number) => Math.max(-32768, Math.min(32767, Math.round(v)));

/**
 * Decimates and quantizes a raw pose buffer into the signed PoseTrace that
 * rides in the attestation record. Returns null when the window holds too
 * little data. Deterministic, so a desk can reproduce the trace.
 *
 * Decimation buckets samples onto the hz grid anchored at the first sample
 * in the window and keeps the sample nearest each bucket center; no
 * interpolation. The shutter anchor is the emitted sample nearest
 * capturedAtMs.
 */
export function buildPoseTrace(
  samples: PoseSample[],
  capturedAtMs: number,
  opts: PoseTraceOptions = {},
): PoseTrace | null {
  const beforeMs = opts.beforeMs ?? 3000;
  const afterMs = opts.afterMs ?? 500;
  const hz = opts.hz ?? 20;
  const maxSamples = opts.maxSamples ?? 70;
  if (!samples.length) return null;

  const window = samples
    .filter((s) => s.t >= capturedAtMs - beforeMs && s.t <= capturedAtMs + afterMs)
    .sort((a, b) => a.t - b.t);
  if (window.length < TRACE_MIN_SAMPLES) return null;

  const stepMs = 1000 / hz;
  const t0 = window[0].t;
  const buckets = new Map<number, PoseSample>();
  for (const s of window) {
    const b = Math.round((s.t - t0) / stepMs);
    const center = t0 + b * stepMs;
    const prev = buckets.get(b);
    if (!prev || Math.abs(s.t - center) < Math.abs(prev.t - center)) buckets.set(b, s);
  }
  let decimated = [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([, s]) => s);
  // Overflow trims symmetrically around the shutter, keeping the anchor central.
  if (decimated.length > maxSamples) {
    const nearest = decimated.reduce(
      (best, s, i) => (Math.abs(s.t - capturedAtMs) < Math.abs(decimated[best].t - capturedAtMs) ? i : best),
      0,
    );
    const half = Math.floor(maxSamples / 2);
    let lo = Math.max(0, nearest - half);
    const hi = Math.min(decimated.length, lo + maxSamples);
    lo = Math.max(0, hi - maxSamples);
    decimated = decimated.slice(lo, hi);
  }
  if (decimated.length < TRACE_MIN_SAMPLES) return null;

  const rotRate: number[] = [];
  const attitude: number[] = [];
  const accel: number[] = [];
  let anchor = 0;
  decimated.forEach((s, i) => {
    if (Math.abs(s.t - capturedAtMs) < Math.abs(decimated[anchor].t - capturedAtMs)) anchor = i;
    rotRate.push(clampI16(s.rx * 1000), clampI16(s.ry * 1000), clampI16(s.rz * 1000));
    attitude.push(clampI16(s.roll * 10), clampI16(s.pitch * 10), clampI16(s.yaw * 10));
    accel.push(clampI16(s.ax * 1000), clampI16(s.ay * 1000), clampI16(s.az * 1000));
  });

  return { hz, anchor, samples: decimated.length, rotRate, attitude, accel };
}

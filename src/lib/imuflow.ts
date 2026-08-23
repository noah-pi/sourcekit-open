// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * IMU/optical-flow consistency. The signed pose trace states how the camera
 * moved; the frames show how the scene moved. Faking both consistently
 * requires a motion rig replaying a screen, per the threat model.
 *
 * What this computes:
 *  - Roll: flow recovers content rotation in radians/frame and the gyro's
 *    roll rate integrates to the same quantity with no scale assumption, so
 *    it compares directly — correlation plus sign agreement.
 *  - Pan: horizontal flow vs yaw rate, vertical flow vs pitch rate. Pixels
 *    and radians cannot be equated without intrinsics, so only the shape of
 *    the series is correlated (lag-tolerant).
 *
 * Correlations are reported raw with sample counts and coverage, and
 * 'insufficient-data' is a first-class answer (short clip, no pose trace,
 * featureless video). Strength bands are descriptive until corpus-calibrated;
 * genuine captures can correlate weakly on moving subjects, low texture, or
 * rolling-shutter wobble. This panel gates nothing.
 */

import type { PoseTrace } from '../provenance/manifest';
import type { GlobalMotion } from './opticalflow';

export interface FlowSample {
  /** Midpoint of the frame pair, ms since epoch (same clock base as capturedAt). */
  tMs: number;
  /** Frame-pair interval, ms (gyro is integrated over [tMs-dt/2, tMs+dt/2]). */
  dtMs: number;
  motion: GlobalMotion;
  /** Index of the pair's second frame in the extractor's frame list; the
      desk overlay draws vectors on it. Ignored by this analyzer. */
  frameBIndex?: number;
}

export type ConsistencyStrength = 'insufficient-data' | 'weak' | 'moderate' | 'strong';

export interface ConsistencyReport {
  /** Frame pairs analyzed. */
  samples: number;
  /** Mean block-match coverage across pairs (texture reliability). */
  coverageMean: number;
  /** Pearson correlation: flow content-roll vs gyro roll integrated. */
  rollCorrelation: number | null;
  /** Sign agreement fraction on roll where both magnitudes are non-trivial. */
  rollSignAgreement: number | null;
  /** Shape correlation: horizontal flow vs yaw rate. */
  panXCorrelation: number | null;
  /** Shape correlation: vertical flow vs pitch rate. */
  panYCorrelation: number | null;
  strength: ConsistencyStrength;
  /** One-line summary for the dossier, including limits. */
  note: string;
}

const MIN_SAMPLES = 5;
/** Gyro-rotation magnitude (rad) below which sign is meaningless noise. */
const SIGN_FLOOR_RAD = 0.002;

/** Pearson correlation, lag-tolerant: max |r| over shifts of ±maxLag samples. */
function laggedCorrelation(a: number[], b: number[], maxLag: number): { r: number; lag: number } | null {
  if (a.length !== b.length || a.length < MIN_SAMPLES) return null;
  let best: { r: number; lag: number } | null = null;
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    const xs: number[] = [];
    const ys: number[] = [];
    for (let i = 0; i < a.length; i++) {
      const j = i + lag;
      if (j < 0 || j >= b.length) continue;
      xs.push(a[i]);
      ys.push(b[j]);
    }
    if (xs.length < MIN_SAMPLES) continue;
    const mx = xs.reduce((s, v) => s + v, 0) / xs.length;
    const my = ys.reduce((s, v) => s + v, 0) / ys.length;
    let num = 0;
    let dx2 = 0;
    let dy2 = 0;
    for (let i = 0; i < xs.length; i++) {
      const dx = xs[i] - mx;
      const dy = ys[i] - my;
      num += dx * dy;
      dx2 += dx * dx;
      dy2 += dy * dy;
    }
    if (dx2 < 1e-12 || dy2 < 1e-12) continue; // a constant series correlates with nothing
    const r = num / Math.sqrt(dx2 * dy2);
    if (!best || Math.abs(r) > Math.abs(best.r)) best = { r, lag };
  }
  return best;
}

/**
 * Integrate a gyro rate series (rad/s at trace times, ms) over [t0Ms, t1Ms]
 * by trapezoids, interpolating endpoints. Times outside the trace contribute
 * nothing.
 */
export function integrateRate(times: number[], rate: number[], t0Ms: number, t1Ms: number): number {
  const at = (t: number): number | null => {
    if (t < times[0] || t > times[times.length - 1]) return null;
    for (let i = 1; i < times.length; i++) {
      if (t <= times[i]) {
        const f = (t - times[i - 1]) / (times[i] - times[i - 1]);
        return rate[i - 1] + f * (rate[i] - rate[i - 1]);
      }
    }
    return rate[rate.length - 1];
  };
  const start = Math.max(t0Ms, times[0]);
  const end = Math.min(t1Ms, times[times.length - 1]);
  if (end <= start) return 0;
  let area = 0;
  let prevT = start;
  let prevR = at(start)!;
  for (let i = 0; i < times.length; i++) {
    if (times[i] <= start || times[i] >= end) continue;
    area += ((prevR + rate[i]) / 2) * ((times[i] - prevT) / 1000);
    prevT = times[i];
    prevR = rate[i];
  }
  area += ((prevR + at(end)!) / 2) * ((end - prevT) / 1000);
  return area;
}

/**
 * The consistency report. `poseTrace` comes from the signed record, with
 * times reconstructed as capturedAt + (i-anchor)*1000/hz as the builder
 * defined them; `flow` is the desk's frame-pair series.
 */
export function analyzeImuFlowConsistency(
  poseTrace: PoseTrace | null | undefined,
  capturedAtMs: number,
  flow: FlowSample[],
): ConsistencyReport {
  const insufficient = (note: string): ConsistencyReport => ({
    samples: flow.length,
    coverageMean: flow.length > 0 ? flow.reduce((s, f) => s + f.motion.coverage, 0) / flow.length : 0,
    rollCorrelation: null,
    rollSignAgreement: null,
    panXCorrelation: null,
    panYCorrelation: null,
    strength: 'insufficient-data',
    note,
  });
  if (!poseTrace || poseTrace.samples < 4) {
    return insufficient('no signed pose trace on this capture, so there is nothing to cross-check');
  }
  const usable = flow.filter((f) => f.motion.matches >= 4);
  if (usable.length < MIN_SAMPLES) {
    return insufficient(
      `only ${usable.length} usable frame pairs (need ${MIN_SAMPLES}); clip too short or too featureless for a cross-check`,
    );
  }

  // Reconstruct the gyro series (mrad/s → rad/s; xyz-interleaved).
  const n = poseTrace.samples;
  const times: number[] = [];
  const rx: number[] = [];
  const ry: number[] = [];
  const rz: number[] = [];
  for (let i = 0; i < n; i++) {
    times.push(capturedAtMs + (i - poseTrace.anchor) * (1000 / poseTrace.hz));
    rx.push(poseTrace.rotRate[i * 3] / 1000);
    ry.push(poseTrace.rotRate[i * 3 + 1] / 1000);
    rz.push(poseTrace.rotRate[i * 3 + 2] / 1000);
  }

  // Expected per-pair rotations from the gyro. Device and content rotation
  // are opposite-handed, so correlation is evaluated on magnitude and sign is
  // reported raw rather than assumed.
  const gyroRoll: number[] = [];
  const gyroPitchRate: number[] = [];
  const gyroYawRate: number[] = [];
  const flowRoll: number[] = [];
  const flowTx: number[] = [];
  const flowTy: number[] = [];
  for (const f of usable) {
    const t0 = f.tMs - f.dtMs / 2;
    const t1 = f.tMs + f.dtMs / 2;
    gyroRoll.push(integrateRate(times, ry, t0, t1));
    gyroPitchRate.push(integrateRate(times, rx, t0, t1) / (f.dtMs / 1000));
    gyroYawRate.push(integrateRate(times, rz, t0, t1) / (f.dtMs / 1000));
    flowRoll.push(f.motion.rotRad);
    flowTx.push(f.motion.tx);
    flowTy.push(f.motion.ty);
  }

  const maxLag = 1; // one flow-sample lag ≈ the timestamp-skew tolerance
  const roll = laggedCorrelation(flowRoll, gyroRoll, maxLag);
  const panX = laggedCorrelation(flowTx, gyroYawRate, maxLag);
  const panY = laggedCorrelation(flowTy, gyroPitchRate, maxLag);

  // Roll sign agreement where both sides show non-trivial rotation.
  // Handedness is a constant of mounting/orientation, so the dominant sign
  // convention in the data is taken as correct and agreement measured against
  // it; per-frame sign flips are the suspicious case.
  let signPairs = 0;
  let rawSame = 0;
  for (let i = 0; i < flowRoll.length; i++) {
    if (Math.abs(flowRoll[i]) < SIGN_FLOOR_RAD || Math.abs(gyroRoll[i]) < SIGN_FLOOR_RAD) continue;
    signPairs++;
    if (Math.sign(flowRoll[i]) === Math.sign(gyroRoll[i])) rawSame++;
  }
  const signAgreement = signPairs > 0 ? Math.max(rawSame, signPairs - rawSame) / signPairs : null;

  const corrs = [roll?.r, panX?.r, panY?.r].filter((v): v is number => v !== null && v !== undefined).map(Math.abs);
  const meanAbs = corrs.length > 0 ? corrs.reduce((s, v) => s + v, 0) / corrs.length : 0;
  const strength: ConsistencyStrength =
    corrs.length === 0 ? 'insufficient-data' : meanAbs >= 0.8 ? 'strong' : meanAbs >= 0.6 ? 'moderate' : 'weak';

  const coverageMean = usable.reduce((s, f) => s + f.motion.coverage, 0) / usable.length;
  const parts = [
    roll ? `roll r=${roll.r.toFixed(2)}` : 'roll n/a',
    panX ? `yaw-pan r=${panX.r.toFixed(2)}` : 'yaw-pan n/a',
    panY ? `pitch-pan r=${panY.r.toFixed(2)}` : 'pitch-pan n/a',
  ];
  return {
    samples: usable.length,
    coverageMean,
    rollCorrelation: roll?.r ?? null,
    rollSignAgreement: signAgreement,
    panXCorrelation: panX?.r ?? null,
    panYCorrelation: panY?.r ?? null,
    strength,
    note: `${usable.length} frame pairs cross-checked (${parts.join(', ')}): correlations between the signed gyro trace and motion observed in the frames; evidence for a reviewer, not a verdict`,
  };
}

// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Desk-side parallax / scene-flatness analyzer.
 *
 * Input: the CaptureKit ring dump (evidenceDir/ring-<uuid>/f000.jpg…f007.jpg,
 * 8 pre-shutter JPEGs, oldest first) plus, optionally, the session's
 * full-rate sensor log (JSONL; the gyro enables rotation compensation).
 *
 * Method — PURE DETERMINISTIC GEOMETRY (G1 design rules, locked):
 *  1. Feature points are sampled on a grid over the first ring frame and
 *     tracked frame-to-frame with the SAME SAD block matcher the desk's
 *     global-motion estimator uses (src/lib/opticalflow.ts matchBlock —
 *     shared, not reinvented). Flat or ambiguous matches die honestly.
 *  2. Inter-frame rotation is compensated before disparity is measured.
 *     With a gyro log, the roll rate is integrated per frame interval
 *     (src/lib/imuflow.ts integrateRate — the same trapezoid integrator as
 *     the IMU↔flow cross-check); the gyro is used ONLY as a geometric prior
 *     inside the solve — never as a second trajectory scored for similarity
 *     (G1 rule 5). The roll axis and its handedness are device-dependent, so
 *     they are resolved ONCE from the data (the axis/sign whose integrated
 *     rotation matches the image-fit rotation), stated in the output.
 *     Without a gyro, rotation is taken from the image fit itself and
 *     rotationCompensated is false; if that fit shows large rotation the
 *     measurement is refused as insufficient rather than guessed.
 *  3. After de-rotation, each pair's global translation is the MEDIAN track
 *     displacement (robust to the depth-dependent spread we are measuring).
 *     Per-track residual disparity accumulates over the burst.
 *  4. Flatness is a MEASUREMENT, never a score: a small-baseline planar
 *     model (accumulated disparity affine in image position — a single
 *     homography's first-order form) is least-squares fit to the disparity
 *     field, and its residual distribution is reported. A real 3D scene
 *     under translation leaves disparity spread the planar model cannot
 *     absorb (disparity ∝ inverse depth per track); a plane (screen, print)
 *     is explained by the single fit. No fundamental matrix, no ML, no
 *     metadata statistics, no probability — G1 rules 1–4.
 *
 * OUTPUT: an evidence object for a person to weigh. It is never a verdict,
 * never a gate, and it carries its limitations inline. Insufficient data
 * reports 'insufficient' with the specific reason — never a number dressed
 * up as evidence.
 */

import { estimateGlobalMotion, matchBlock, solve3 } from '@exhibit/lib/opticalflow';
import { integrateRate } from '@exhibit/lib/imuflow';

export const PARALLAX_METHOD_VERSION = '1.0.0-ws4';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A grayscale analysis raster (long side already capped by the adapter). */
export interface GrayPlane {
  width: number;
  height: number;
  /** ITU-R 601 luma, row-major. */
  gray: Float64Array;
}

/** Parsed gyro series from the session sensor log. Rates in rad/s. */
export interface GyroLog {
  /** Sample times, ms (boot-relative clock from the log's `t` seconds). */
  tMs: number[];
  x: number[];
  y: number[];
  z: number[];
  /** The anchor line verbatim, when present — alignment context, not parsed further. */
  anchor: Record<string, unknown> | null;
  /** Non-fatal parse issues, disclosed in the evidence object. */
  issues: string[];
}

export interface ParallaxEvidence {
  /** Full-span feature tracks the measurement rests on. */
  tracksUsed: number;
  /** Fraction of tracks consistent with the best planar fit (≤ 2 px residual). */
  inlierRatio: number;
  /** Residual of the best-fit planar (affine disparity) model, px at analysis raster. */
  planarResidualPx: { median: number; p90: number };
  /**
   * Spread of accumulated per-track disparities projected on the principal
   * (epipolar) direction (p90 − p10), px at analysis raster. ~0 is
   * consistent with a single plane; materially above tracker noise
   * indicates depth variation across tracked points.
   */
  depthSpreadEstimate: { value: number; unit: 'disparity-px'; note: string };
  /** True when gyro integration drove the rotation compensation. */
  rotationCompensated: boolean;
  /**
   * Whether the gyro prior is authenticated under the capture signature.
   * Literal false in this build: the sensor log is an unauthenticated
   * sidecar — only its PATH is signed, never its bytes — so
   * `rotationCompensated: true` must never read as a trust upgrade.
   * Signed poseTrace binding is future work.
   */
  gyroPriorAuthenticated: false;
  /** false, or the specific reason no measurement could be made. */
  insufficient: false | string;
  methodVersion: typeof PARALLAX_METHOD_VERSION;
  computedAt: string;
  limitations: string[];
  // ---- supporting measurements (additive, all at analysis-raster scale) ----
  /** Ring frames successfully decoded and used. */
  framesDecoded: number;
  /** Accumulated camera translation over the burst, px (median-track estimate). */
  baselinePx: number;
  /** Per-pair in-plane rotation applied during compensation, radians. */
  rotationPerPairRad: number[];
  /** Residual of the common-direction (translational-parallax) fit, median px. */
  depthModelResidualPx: { median: number } | null;
}

// ---------------------------------------------------------------------------
// Constants — stated, not hidden
// ---------------------------------------------------------------------------

const MIN_FRAMES = 5;
const MIN_TRACKS = 30;
/** Grid stride for candidate feature points at analysis-raster scale. */
const DETECT_STRIDE = 12;
const MAX_CANDIDATES = 600;
/** Per-pair search radius for the block matcher (px). */
const TRACK_SEARCH_RADIUS = 10;
/** Burst-total rotation above which a gyro-less burst is refused, rad (~3°). */
const LARGE_ROTATION_RAD = 0.05;
/** Accumulated translation below which disparity is tracker noise, px. */
const MIN_BASELINE_PX = 2.0;
/** Gyro↔image rotation agreement below which the gyro is declared unusable. */
const MIN_GYRO_FIT_CORR = 0.5;
/**
 * Gyro↔image magnitude agreement: cosine similarity is scale-invariant,
 * so a forged log with the true rotation's SHAPE at an arbitrary multiple
 * of its RATE would pass a direction-only gate and inject an affine
 * de-rotation error that reads as depth. Per pair the integrated gyro
 * rotation must also match the image fit in SCALE:
 *   |gyro − image| ≤ max(GYRO_RATE_TOL_REL × |gyro|, GYRO_RATE_TOL_ABS rad)
 */
const GYRO_RATE_TOL_REL = 0.2;
const GYRO_RATE_TOL_ABS = 0.005;

const FIXED_LIMITATIONS = [
  'corpus characterization pending; no error rates published',
  'a geometric measurement for human review — evidence a person weighs, never a verdict and never a gate',
  'small-baseline model: planar fit is first-order (affine disparity); large depth relief at wide baseline violates it and inflates planar residual honestly',
  'integer-px block matching: per-pair track noise is roughly ±1 px at the analysis raster; disparities near that floor are noise, not depth',
  'the sensor log is an unauthenticated sidecar: rotation compensation treats it as an untrusted prior — a crafted log can bias the measurement; an exhibit\'s signed poseTrace commitment is what binds a log to the media',
];

// ---------------------------------------------------------------------------
// Small numeric helpers
// ---------------------------------------------------------------------------

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length)));
  return sorted[i];
}

function medians2(xs: number[], ys: number[]): { x: number; y: number } {
  const sx = [...xs].sort((a, b) => a - b);
  const sy = [...ys].sort((a, b) => a - b);
  return { x: percentile(sx, 50), y: percentile(sy, 50) };
}

const round3 = (v: number): number => Math.round(v * 1000) / 1000;

/**
 * Cosine similarity of two equal-length series (no mean subtraction — these
 * are integrated angles, where a CONSTANT rotation per pair is the common
 * case and Pearson would degenerate). Null when either side is ~zero.
 */
function cosineSim(a: number[], b: number[]): number | null {
  if (a.length !== b.length || a.length === 0) return null;
  let num = 0;
  let a2 = 0;
  let b2 = 0;
  for (let i = 0; i < a.length; i++) {
    num += a[i] * b[i];
    a2 += a[i] * a[i];
    b2 += b[i] * b[i];
  }
  if (a2 < 1e-12 || b2 < 1e-12) return null;
  return num / Math.sqrt(a2 * b2);
}

// ---------------------------------------------------------------------------
// Input adapters
// ---------------------------------------------------------------------------

/**
 * RGBA → luma analysis raster, long side capped (bilinear resample). The
 * same caps and luma math as the desk's other adapters — parity by
 * construction, and the raster size rides in the evidence limitations.
 */
export function grayPlaneFromRgba(
  rgba: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  longSide = 320,
): GrayPlane {
  const scale = Math.min(1, longSide / Math.max(width, height));
  const w = Math.max(8, Math.round(width * scale));
  const h = Math.max(8, Math.round(height * scale));
  const gray = new Float64Array(w * h);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(height - 1, (y + 0.5) / scale - 0.5);
    const y0 = Math.max(0, Math.floor(sy));
    const y1 = Math.min(height - 1, y0 + 1);
    const fy = sy - y0;
    for (let x = 0; x < w; x++) {
      const sx = Math.min(width - 1, (x + 0.5) / scale - 0.5);
      const x0 = Math.max(0, Math.floor(sx));
      const x1 = Math.min(width - 1, x0 + 1);
      const fx = sx - x0;
      const luma = (xx: number, yy: number): number => {
        const o = (yy * width + xx) * 4;
        return 0.299 * rgba[o] + 0.587 * rgba[o + 1] + 0.114 * rgba[o + 2];
      };
      gray[y * w + x] =
        luma(x0, y0) * (1 - fx) * (1 - fy) + luma(x1, y0) * fx * (1 - fy) +
        luma(x0, y1) * (1 - fx) * fy + luma(x1, y1) * fx * fy;
    }
  }
  return { width: w, height: h, gray };
}

/**
 * Parse a session sensor log: an optional anchor line, then one
 * {"t",kind,"x","y","z"} sample per line. Only gyro samples are used by this
 * analyzer (rotation compensation); accel/baro/loc lines are skipped, never
 * misread. Malformed lines are counted and disclosed, never silently dropped.
 */
export function parseSensorLogJsonl(text: string): GyroLog {
  const log: GyroLog = { tMs: [], x: [], y: [], z: [], anchor: null, issues: [] };
  let malformed = 0;
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let j: Record<string, unknown>;
    try {
      j = JSON.parse(t);
    } catch {
      malformed++;
      continue;
    }
    if (j.kind === 'anchor') {
      log.anchor = j;
      continue;
    }
    if (j.kind !== 'gyro') continue;
    if (typeof j.t !== 'number' || typeof j.x !== 'number' || typeof j.y !== 'number' || typeof j.z !== 'number') {
      malformed++;
      continue;
    }
    log.tMs.push(j.t * 1000); // boot-relative seconds → ms
    log.x.push(j.x);
    log.y.push(j.y);
    log.z.push(j.z);
  }
  if (malformed > 0) log.issues.push(`${malformed} malformed sensor-log line(s) skipped`);
  if (log.tMs.length < 2) log.issues.push('fewer than 2 gyro samples — gyro unusable');
  // Gyro rate units follow CMMotionManager rotationRate: rad/s. Stated, not assumed silently.
  log.issues.push('gyro rates read as rad/s (CMMotionManager convention)');
  return log;
}

// ---------------------------------------------------------------------------
// The analyzer
// ---------------------------------------------------------------------------

export interface ParallaxOptions {
  /** Parsed sensor log; null/omitted → image-fit rotation compensation. */
  gyro?: GyroLog | null;
  /**
   * Assumed ring-frame interval, seconds. The ring dump records no
   * per-frame timestamps, so gyro alignment assumes uniform spacing ending
   * at the last gyro sample — disclosed in limitations.
   */
  frameIntervalSec?: number;
  /** Injection point for tests. */
  now?: Date;
}

interface Track {
  x0: number;
  y0: number;
  /** Position per frame index; null once the match dies. */
  px: (number | null)[];
  py: (number | null)[];
}

export function analyzeParallaxBurst(
  framesIn: (GrayPlane | null)[],
  opts: ParallaxOptions = {},
): ParallaxEvidence {
  const computedAt = (opts.now ?? new Date()).toISOString();
  const limitations: string[] = [...FIXED_LIMITATIONS];

  const insufficient = (reason: string, extra: Partial<ParallaxEvidence> = {}): ParallaxEvidence => ({
    tracksUsed: 0,
    inlierRatio: 0,
    planarResidualPx: { median: 0, p90: 0 },
    depthSpreadEstimate: {
      value: 0,
      unit: 'disparity-px',
      note: 'not computed — insufficient data; the reason states why, no number is offered as evidence',
    },
    rotationCompensated: false,
    gyroPriorAuthenticated: false,
    insufficient: reason,
    methodVersion: PARALLAX_METHOD_VERSION,
    computedAt,
    limitations,
    framesDecoded: framesIn.filter((f): f is GrayPlane => f !== null).length,
    baselinePx: 0,
    rotationPerPairRad: [],
    depthModelResidualPx: null,
    ...extra,
  });

  // ---- 1. decodable frames ------------------------------------------------
  const frames = framesIn.filter((f): f is GrayPlane => f !== null).slice(0, 8);
  if (frames.length < MIN_FRAMES) {
    return insufficient(`only ${frames.length} of 8 ring frames decodable (need ${MIN_FRAMES}) — JPEG decode failed or dump incomplete`);
  }
  const w = frames[0].width;
  const h = frames[0].height;
  if (!frames.every((f) => f.width === w && f.height === h)) {
    return insufficient('ring frames disagree on dimensions — not a uniform burst');
  }
  limitations.push(`analysis raster ${w}×${h} px; all pixel figures are at this scale`);

  // ---- 2. per-pair global image fit (rotation estimate + sanity) ----------
  const pairFits = frames.slice(1).map((f, k) => estimateGlobalMotion(frames[k].gray, f.gray, w, h));
  const fitRot = pairFits.map((m) => m?.rotRad ?? 0);
  const failedFits = pairFits.filter((m) => m === null).length;
  if (failedFits > 0) {
    limitations.push(`${failedFits} of ${pairFits.length} frame pairs produced no global motion fit (treated as zero rotation — disclosed, not hidden)`);
  }

  // ---- 3. rotation compensation -------------------------------------------
  let rotationCompensated = false;
  let theta = [...fitRot];
  const gyro = opts.gyro ?? null;
  if (gyro && gyro.tMs.length >= 2) {
    // Uniform-spacing alignment: the burst is assumed to end at the last
    // gyro sample (the ring is pre-shutter; the log ends at session stop).
    const dtMs = (opts.frameIntervalSec ?? 1 / 30) * 1000;
    const n = frames.length;
    const tEnd = gyro.tMs[gyro.tMs.length - 1];
    const axes: { name: 'x' | 'y' | 'z'; rate: number[] }[] = [
      { name: 'x', rate: gyro.x },
      { name: 'y', rate: gyro.y },
      { name: 'z', rate: gyro.z },
    ];
    // Resolve roll axis + handedness ONCE from the data: the axis whose
    // integrated per-pair rotation best matches the image-fit rotation.
    let best: { theta: number[]; r: number; desc: string } | null = null;
    for (const ax of axes) {
      const integ: number[] = [];
      for (let k = 0; k < n - 1; k++) {
        const t0 = tEnd - (n - 1 - k) * dtMs;
        integ.push(integrateRate(gyro.tMs, ax.rate, t0, t0 + dtMs));
      }
      const r = cosineSim(integ, fitRot);
      if (r === null) continue;
      // Sign is part of the similarity: the best axis×sign wins outright.
      if (!best || r > best.r) {
        best = { theta: integ.map((v) => v * Math.sign(r)), r, desc: `gyro ${ax.name}-axis, sign ${r > 0 ? '+' : '−'}, agreement cos=${Math.abs(r).toFixed(2)}` };
      }
    }
    // Magnitude gate: cosine agreement is scale-invariant, so direction
    // agreement alone would let a forged log at α× the true rate pass with
    // cos=1.00 and inject an affine de-rotation error that inflates the
    // depth reading. The gyro must ALSO match the image fit in scale, per
    // pair; the worst ratio is disclosed.
    let magnitudeOk = false;
    let worstRatio = 0;
    if (best && Math.abs(best.r) >= MIN_GYRO_FIT_CORR) {
      magnitudeOk = true;
      for (let k = 0; k < best.theta.length; k++) {
        const g = best.theta[k];
        const dev = Math.abs(g - fitRot[k]);
        const tol = Math.max(GYRO_RATE_TOL_REL * Math.abs(g), GYRO_RATE_TOL_ABS);
        const ratio = Math.abs(fitRot[k]) > 1e-9 ? Math.abs(g / fitRot[k]) : (Math.abs(g) > GYRO_RATE_TOL_ABS ? Infinity : 1);
        if (Number.isFinite(ratio)) worstRatio = Math.max(worstRatio, ratio);
        if (dev > tol) magnitudeOk = false;
      }
    }
    if (best && Math.abs(best.r) >= MIN_GYRO_FIT_CORR && magnitudeOk) {
      theta = best.theta;
      rotationCompensated = true;
      limitations.push(`rotation compensated from integrated gyro (${best.desc}, worst gyro/image rate ratio ${worstRatio.toFixed(2)}); gyro used only as a geometric prior inside the solve, never as a second scored trajectory`);
      limitations.push(`ring frames carry no timestamps — gyro aligned by uniform ${(opts.frameIntervalSec ?? 1 / 30).toFixed(4)} s spacing ending at the last gyro sample; misalignment shows up as residual rotation in the numbers, stated not hidden`);
    } else if (best && Math.abs(best.r) >= MIN_GYRO_FIT_CORR) {
      limitations.push(
        `gyro log agrees with the image fit in DIRECTION (${best.desc}) but not in MAGNITUDE ` +
        `(worst gyro/image rate ratio ${worstRatio.toFixed(2)} — tolerance ${GYRO_RATE_TOL_REL}× or ${GYRO_RATE_TOL_ABS} rad/pair) — ` +
        'a scaled or shifted sensor log would steer the compensation, so it was refused; fell back to image-fit rotation; gyro NOT used'
      );
    } else {
      limitations.push(`gyro log present but no axis agreed with the image-fit rotation (best r=${best ? best.r.toFixed(2) : 'n/a'} < ${MIN_GYRO_FIT_CORR}) — fell back to image-fit rotation; gyro NOT used`);
    }
  }
  if (!rotationCompensated) {
    const totalRot = theta.reduce((s, v) => s + Math.abs(v), 0);
    if (totalRot > LARGE_ROTATION_RAD) {
      return insufficient(
        `no usable gyro log and the image fit shows ${round3(totalRot)} rad total rotation across the burst (> ${LARGE_ROTATION_RAD} rad) — rotation compensation would be guesswork; re-capture with the sensor log enabled`,
        { rotationPerPairRad: theta.map(round3) },
      );
    }
    limitations.push('no gyro log — rotation compensated from the image fit itself; adequate only for the small rotation measured here');
  }
  for (const issue of gyro?.issues ?? []) limitations.push(`sensor log: ${issue}`);

  // ---- 4. feature tracks ---------------------------------------------------
  const margin = 4 + TRACK_SEARCH_RADIUS + 2;
  let stride = DETECT_STRIDE;
  while (((w - 2 * margin) / stride) * ((h - 2 * margin) / stride) > MAX_CANDIDATES) stride += 4;
  const tracks: Track[] = [];
  for (let y = margin; y <= h - margin; y += stride) {
    for (let x = margin; x <= w - margin; x += stride) {
      tracks.push({ x0: x, y0: y, px: [x], py: [y] });
    }
  }
  for (const tr of tracks) {
    for (let k = 1; k < frames.length; k++) {
      const prevX = tr.px[k - 1];
      const prevY = tr.py[k - 1];
      if (prevX === null || prevY === null) {
        tr.px.push(null);
        tr.py.push(null);
        continue;
      }
      const m = matchBlock(frames[k - 1].gray, frames[k].gray, w, h, prevX, prevY, {
        searchRadius: TRACK_SEARCH_RADIUS,
      });
      if (!m) {
        tr.px.push(null);
        tr.py.push(null);
        continue;
      }
      tr.px.push(prevX + m.dx);
      tr.py.push(prevY + m.dy);
    }
  }
  const fullSpan = tracks.filter((t) => t.px.every((p) => p !== null));
  const partial = tracks.length - fullSpan.length;
  if (fullSpan.length < MIN_TRACKS) {
    return insufficient(
      `only ${fullSpan.length} feature tracks survived all ${frames.length} frames (need ${MIN_TRACKS}) — scene too featureless, too dark, or motion too large for the tracker`,
    );
  }
  if (partial > fullSpan.length) {
    limitations.push(`${partial} candidate points died mid-burst and were dropped; the measurement rests on the ${fullSpan.length} full-span tracks only`);
  }

  // ---- 5. de-rotate + remove global translation → residual disparity ------
  const cx = w / 2;
  const cy = h / 2;
  const nPairs = frames.length - 1;
  // Per-pair residual displacement per track.
  const residual: { dx: number; dy: number }[][] = fullSpan.map(() => []);
  const baselinePerPair: number[] = [];
  for (let k = 0; k < nPairs; k++) {
    const th = theta[k] ?? 0;
    const cos = Math.cos(-th);
    const sin = Math.sin(-th);
    const dxs: number[] = [];
    const dys: number[] = [];
    const disp = fullSpan.map((t) => {
      const px0 = t.px[k]!;
      const py0 = t.py[k]!;
      // De-rotate the frame k+1 position around the frame center.
      const rx = t.px[k + 1]! - cx;
      const ry = t.py[k + 1]! - cy;
      const dx = rx * cos - ry * sin + cx - px0;
      const dy = rx * sin + ry * cos + cy - py0;
      dxs.push(dx);
      dys.push(dy);
      return { dx, dy };
    });
    const g = medians2(dxs, dys);
    baselinePerPair.push(Math.hypot(g.x, g.y));
    for (let i = 0; i < fullSpan.length; i++) {
      residual[i].push({ dx: disp[i].dx - g.x, dy: disp[i].dy - g.y });
    }
  }
  const baseline = baselinePerPair.reduce((s, v) => s + v, 0);
  if (baseline < MIN_BASELINE_PX) {
    return insufficient(
      `burst camera translation ≈${round3(baseline)} px at the analysis raster (below ${MIN_BASELINE_PX} px) — the camera barely moved; any disparity would be tracker noise, not depth. Hold looser or move slightly between frames`,
      { baselinePx: round3(baseline), rotationPerPairRad: theta.map(round3) },
    );
  }

  // ---- 6. accumulated disparity + planar-vs-depth measurement -------------
  const D = fullSpan.map((t, i) => ({
    x0: t.x0,
    y0: t.y0,
    dx: residual[i].reduce((s, r) => s + r.dx, 0),
    dy: residual[i].reduce((s, r) => s + r.dy, 0),
  }));
  const mags = D.map((d) => Math.hypot(d.dx, d.dy)).sort((a, b) => a - b);

  // Planar model (small-baseline first-order homography): disparity affine
  // in image position. Least squares per component via the shared solve3.
  const fitAffine = (vals: number[]): number[] | null => {
    let sxx = 0;
    let sxy = 0;
    let syy = 0;
    let sx = 0;
    let sy = 0;
    let sxv = 0;
    let syv = 0;
    let sv = 0;
    const n = D.length;
    for (let i = 0; i < n; i++) {
      const x = D[i].x0 - cx;
      const y = D[i].y0 - cy;
      sxx += x * x;
      sxy += x * y;
      syy += y * y;
      sx += x;
      sy += y;
      sxv += x * vals[i];
      syv += y * vals[i];
      sv += vals[i];
    }
    return solve3(
      [
        [sxx, sxy, sx],
        [sxy, syy, sy],
        [sx, sy, n],
      ],
      [sxv, syv, sv],
    );
  };
  const axX = fitAffine(D.map((d) => d.dx));
  const axY = fitAffine(D.map((d) => d.dy));
  const planarRes: number[] = [];
  if (axX && axY) {
    for (const d of D) {
      const x = d.x0 - cx;
      const y = d.y0 - cy;
      planarRes.push(Math.hypot(d.dx - (axX[0] * x + axX[1] * y + axX[2]), d.dy - (axY[0] * x + axY[1] * y + axY[2])));
    }
  } else {
    planarRes.push(...mags);
    limitations.push('planar fit was singular — residual reported against zero disparity instead');
  }
  planarRes.sort((a, b) => a - b);

  // Depth model (translational parallax): all disparity vectors share one
  // direction (the epipolar direction), magnitude ∝ inverse depth. Fit the
  // common direction as the principal axis of the disparity vectors.
  let depthModelResidual: { median: number } | null = null;
  let axis: { ex: number; ey: number } | null = null;
  {
    let sxx = 0;
    let sxy = 0;
    let syy = 0;
    for (const d of D) {
      sxx += d.dx * d.dx;
      sxy += d.dx * d.dy;
      syy += d.dy * d.dy;
    }
    const trace = sxx + syy;
    const det = sxx * syy - sxy * sxy;
    const disc = Math.sqrt(Math.max(0, (trace / 2) ** 2 - det));
    const lambda = trace / 2 + disc;
    // Two algebraically equivalent eigenvector forms; use the better-conditioned.
    let ex = sxy;
    let ey = lambda - sxx;
    if (Math.hypot(ex, ey) < Math.hypot(lambda - syy, sxy)) {
      ex = lambda - syy;
      ey = sxy;
    }
    const len = Math.hypot(ex, ey);
    if (len > 1e-9) {
      ex /= len;
      ey /= len;
      axis = { ex, ey };
      const perp = D.map((d) => Math.abs(d.dx * -ey + d.dy * ex)).sort((a, b) => a - b);
      depthModelResidual = { median: round3(percentile(perp, 50)) };
    }
  }

  const inliers = planarRes.filter((r) => r <= 2.0).length;
  // Depth spread: spread of the disparity projections onto the principal
  // (epipolar) direction. Magnitude-only spread would miss the two-plane
  // case where near/far disparities are symmetric about the median motion;
  // signed projections separate the depth clusters.
  const spread = axis
    ? percentile(D.map((d) => d.dx * axis.ex + d.dy * axis.ey).sort((a, b) => a - b), 90) -
      percentile(D.map((d) => d.dx * axis.ex + d.dy * axis.ey).sort((a, b) => a - b), 10)
    : percentile(mags, 90) - percentile(mags, 10);

  return {
    tracksUsed: fullSpan.length,
    inlierRatio: round3(inliers / fullSpan.length),
    planarResidualPx: { median: round3(percentile(planarRes, 50)), p90: round3(percentile(planarRes, 90)) },
    depthSpreadEstimate: {
      value: round3(spread),
      unit: 'disparity-px',
      note: 'p90−p10 of accumulated per-track disparity projected on the principal (epipolar) direction, after rotation compensation and global-motion removal; ~0 is consistent with a single plane (screen/print), materially above tracker noise (~±1 px/pair at the analysis raster) indicates depth variation across the scene. A measurement for a reviewer, never a verdict.',
    },
    rotationCompensated,
    gyroPriorAuthenticated: false,
    insufficient: false,
    methodVersion: PARALLAX_METHOD_VERSION,
    computedAt,
    limitations,
    framesDecoded: frames.length,
    baselinePx: round3(baseline),
    rotationPerPairRad: theta.map(round3),
    depthModelResidualPx: depthModelResidual,
  };
}

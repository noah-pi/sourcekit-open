/**
 * Pure-TypeScript homography estimation: normalized DLT inside RANSAC.
 *
 * WHY a homography: two pinhole views of a PLANAR surface are related by a
 * single 3×3 projective transform, regardless of camera motion. A scene
 * with real depth is not — under translation, points at different depths
 * move by different amounts (disparity ∝ 1/Z), and no single homography can
 * absorb that. The residual of the best fit is therefore a geometric
 * measurement of "how un-flat is what both cameras saw", computed entirely
 * from committed pixels. No ML, no metadata statistics.
 *
 * Everything here is small dense linear algebra written out by hand:
 *   - 3×3 matrix ops for H itself;
 *   - cyclic Jacobi sweeps for the smallest eigenvector of the symmetric
 *     9×9 AᵀA (the DLT null-space solve) — Jacobi is slow in the abstract
 *     and irrelevant at 9×9, and it has no dependency surface to audit;
 *   - deterministic mulberry32 sampling so a desk run is reproducible:
 *     given the same committed frames and correspondences, the desk MUST
 *     get the same answer every time.
 *
 * Coordinates: the fit runs on UNDISTORTED, NORMALIZED pinhole coordinates
 * (f = 1). Residuals are reported in pixel-equivalent units by scaling with
 * a representative focal length supplied by the caller, so thresholds stay
 * in the same "pixels of matcher error" units the corpus will characterize.
 */

export type Mat3 = number[]; // 9 elements, row-major

export interface HomographyOptions {
  /** Inlier threshold on symmetric transfer error, in the fit's coordinate units. */
  threshold: number;
  /** Hard cap on RANSAC trials. */
  maxIterations?: number;
  /** Desired confidence that at least one all-inlier minimal set was sampled. */
  confidence?: number;
  /** PRNG seed — deterministic by contract. */
  seed?: number;
}

export interface HomographyResult {
  /** Best homography mapping view-1 normalized coords → view-2 normalized coords. */
  H: Mat3;
  /** Inlier flags, aligned with the input correspondence order. */
  inliers: boolean[];
  /** Median symmetric transfer error over inliers (fit coordinate units). */
  residualMedian: number;
  /** 90th-percentile symmetric transfer error over inliers. */
  residualP90: number;
  /** RANSAC trials actually executed (adaptive stop may cut this short). */
  iterations: number;
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

// ---------------------------------------------------------------------------
// 3×3 helpers
// ---------------------------------------------------------------------------

export function mat3Mul(a: Mat3, b: Mat3): Mat3 {
  const out = new Array<number>(9).fill(0);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      out[r * 3 + c] =
        a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
    }
  }
  return out;
}

/** Inverse of a 3×3, or null when singular (a degenerate fit must fail, not guess). */
export function mat3Invert(m: Mat3): Mat3 | null {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = c * h - b * i;
  const C = b * f - c * e;
  const det = a * A + d * B + g * C;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-18) return null;
  const inv = 1 / det;
  return [
    A * inv, B * inv, C * inv,
    (f * g - d * i) * inv, (a * i - c * g) * inv, (c * d - a * f) * inv,
    (d * h - e * g) * inv, (b * g - a * h) * inv, (a * e - b * d) * inv,
  ];
}

function applyMat3(m: Mat3, x: number, y: number): [number, number] {
  const w = m[6] * x + m[7] * y + m[8];
  return [(m[0] * x + m[1] * y + m[2]) / w, (m[3] * x + m[4] * y + m[5]) / w];
}

// ---------------------------------------------------------------------------
// Symmetric tridiagonal-free eigensolve: cyclic Jacobi on a symmetric n×n.
// Returns the eigenvector of the SMALLEST eigenvalue — the DLT null vector.
// ---------------------------------------------------------------------------

function smallestEigenvector(aIn: number[][], n: number): number[] {
  const a = aIn.map((row) => row.slice());
  let v: number[][] = Array.from({ length: n }, (_, r) =>
    Array.from({ length: n }, (_, c) => (r === c ? 1 : 0)),
  );
  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += a[p][q] * a[p][q];
    if (off < 1e-24) break;
    for (let p = 0; p < n - 1; p++) {
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(a[p][q]) < 1e-30) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < n; k++) {
          const akp = a[k][p];
          const akq = a[k][q];
          a[k][p] = c * akp - s * akq;
          a[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p][k];
          const aqk = a[q][k];
          a[p][k] = c * apk - s * aqk;
          a[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = v[k][p];
          const vkq = v[k][q];
          v[k][p] = c * vkp - s * vkq;
          v[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }
  let minIdx = 0;
  for (let k = 1; k < n; k++) if (a[k][k] < a[minIdx][minIdx]) minIdx = k;
  return v.map((row) => row[minIdx]);
}

// ---------------------------------------------------------------------------
// Normalized DLT (Hartley & Zisserman, Multiple View Geometry, §4.1)
// Normalization matters: raw pixel-scale coordinates make AᵀA horribly
// conditioned, and the "residual" would measure conditioning, not geometry.
// ---------------------------------------------------------------------------

interface Normalization {
  T: Mat3;
  invScale: number;
}

function similarityNormalization(pts: Array<[number, number]>): Normalization {
  let mx = 0;
  let my = 0;
  for (const [x, y] of pts) {
    mx += x;
    my += y;
  }
  mx /= pts.length;
  my /= pts.length;
  let meanDist = 0;
  for (const [x, y] of pts) meanDist += Math.hypot(x - mx, y - my);
  meanDist /= pts.length;
  const s = meanDist > 1e-12 ? Math.SQRT2 / meanDist : 1;
  return {
    T: [s, 0, -s * mx, 0, s, -s * my, 0, 0, 1],
    invScale: 1 / s,
  };
}

function dltFromNormalizedPairs(
  p1: Array<[number, number]>,
  p2: Array<[number, number]>,
): Mat3 | null {
  const n = p1.length;
  // A is 2n×9; accumulate AᵀA (9×9 symmetric) directly.
  const ata = Array.from({ length: 9 }, () => new Array<number>(9).fill(0));
  const row = new Array<number>(9);
  const accum = (r: number[]): void => {
    for (let i = 0; i < 9; i++) {
      if (r[i] === 0) continue;
      for (let j = i; j < 9; j++) ata[i][j] += r[i] * r[j];
    }
  };
  for (let k = 0; k < n; k++) {
    const [x, y] = p1[k];
    const [u, v] = p2[k];
    row.fill(0);
    row[0] = -x; row[1] = -y; row[2] = -1;
    row[6] = u * x; row[7] = u * y; row[8] = u;
    accum(row);
    row.fill(0);
    row[3] = -x; row[4] = -y; row[5] = -1;
    row[6] = v * x; row[7] = v * y; row[8] = v;
    accum(row);
  }
  for (let i = 0; i < 9; i++) for (let j = 0; j < i; j++) ata[i][j] = ata[j][i];
  const h = smallestEigenvector(ata, 9);
  if (h.some((v) => !Number.isFinite(v))) return null;
  const norm = Math.hypot(...h);
  if (norm < 1e-12) return null;
  return h.map((v) => v / norm);
}

/** Normalized-DLT homography from ≥4 point pairs; null on degenerate input. */
export function fitHomographyDlt(
  p1: Array<[number, number]>,
  p2: Array<[number, number]>,
): Mat3 | null {
  if (p1.length < 4 || p1.length !== p2.length) return null;
  const n1 = similarityNormalization(p1);
  const n2 = similarityNormalization(p2);
  const q1 = p1.map(([x, y]) => applyMat3(n1.T, x, y));
  const q2 = p2.map(([x, y]) => applyMat3(n2.T, x, y));
  const Hn = dltFromNormalizedPairs(q1, q2);
  if (!Hn) return null;
  const T2inv = mat3Invert(n2.T);
  if (!T2inv) return null;
  return mat3Mul(T2inv, mat3Mul(Hn, n1.T));
}

// ---------------------------------------------------------------------------
// Symmetric transfer error — measures both directions so the residual does
// not depend on which view we happened to call "primary".
// ---------------------------------------------------------------------------

export function symmetricTransferError(H: Mat3, Hinv: Mat3, p1: [number, number], p2: [number, number]): number {
  const [fx, fy] = applyMat3(H, p1[0], p1[1]);
  const [bx, by] = applyMat3(Hinv, p2[0], p2[1]);
  const d1 = (fx - p2[0]) ** 2 + (fy - p2[1]) ** 2;
  const d2 = (bx - p1[0]) ** 2 + (by - p1[1]) ** 2;
  return Math.sqrt(d1 + d2);
}

/** Minimal-set sanity: reject samples with a near-collinear triple — their DLT is rank-deficient. */
function sampleIsDegenerate(p1: Array<[number, number]>, idx: number[]): boolean {
  for (let a = 0; a < 4; a++) {
    for (let b = a + 1; b < 4; b++) {
      for (let c = b + 1; c < 4; c++) {
        const [x1, y1] = p1[idx[a]];
        const [x2, y2] = p1[idx[b]];
        const [x3, y3] = p1[idx[c]];
        const area = (x2 - x1) * (y3 - y1) - (x3 - x1) * (y2 - y1);
        const scale = Math.hypot(x2 - x1, y2 - y1) * Math.hypot(x3 - x1, y3 - y1);
        if (Math.abs(area) < 1e-9 * Math.max(scale, 1e-12)) return true;
      }
    }
  }
  return false;
}

/**
 * RANSAC around the normalized DLT. The trial count adapts to the observed
 * inlier ratio (standard log(1−conf)/log(1−w⁴) stopping rule), capped so a
 * pathological correspondence set cannot spin forever. Deterministic: the
 * same inputs and seed always produce the same fit.
 */
export function fitHomographyRansac(
  p1: Array<[number, number]>,
  p2: Array<[number, number]>,
  opts: HomographyOptions,
): HomographyResult | null {
  const n = p1.length;
  if (n < 4 || n !== p2.length || !(opts.threshold > 0)) return null;
  const maxIter = Math.max(1, opts.maxIterations ?? 500);
  const confidence = Math.min(0.9999, Math.max(0.5, opts.confidence ?? 0.99));
  const rnd = mulberry32(opts.seed ?? 0x5eed);

  let best: { H: Mat3; inliers: boolean[]; errs: number[] } | null = null;
  let trials = 0;
  let required = maxIter;

  while (trials < required && trials < maxIter) {
    trials++;
    // Sample a 4-point minimal set without replacement.
    const idx: number[] = [];
    while (idx.length < 4) {
      const k = Math.floor(rnd() * n);
      if (!idx.includes(k)) idx.push(k);
    }
    if (sampleIsDegenerate(p1, idx)) continue;
    const H = fitHomographyDlt(idx.map((k) => p1[k]), idx.map((k) => p2[k]));
    if (!H) continue;
    const Hinv = mat3Invert(H);
    if (!Hinv) continue;
    const inliers = new Array<boolean>(n).fill(false);
    const errs: number[] = [];
    let count = 0;
    for (let k = 0; k < n; k++) {
      const e = symmetricTransferError(H, Hinv, p1[k], p2[k]);
      if (e <= opts.threshold) {
        inliers[k] = true;
        errs.push(e);
        count++;
      }
    }
    if (!best || count > best.errs.length) {
      best = { H, inliers, errs };
      // Adaptive stop: with inlier ratio w, P(miss all-inlier set) < conf.
      const w = count / n;
      if (w > 0.01) {
        const denom = Math.log(1 - Math.pow(w, 4));
        if (denom < 0) {
          required = Math.min(maxIter, Math.ceil(Math.log(1 - confidence) / denom));
        }
      }
    }
  }

  if (!best || best.errs.length < 4) return null;

  // Refit on ALL inliers: the minimal-set H is only a scout.
  const inlierIdx = best.inliers.map((b, k) => (b ? k : -1)).filter((k) => k >= 0);
  const refined = fitHomographyDlt(inlierIdx.map((k) => p1[k]), inlierIdx.map((k) => p2[k]));
  const H = refined ?? best.H;
  const Hinv = mat3Invert(H);
  if (!Hinv) return null;
  const errs = inlierIdx
    .map((k) => symmetricTransferError(H, Hinv, p1[k], p2[k]))
    .sort((a, b) => a - b);
  const median = errs[Math.floor(errs.length / 2)];
  const p90 = errs[Math.min(errs.length - 1, Math.floor(errs.length * 0.9))];
  return {
    H,
    inliers: best.inliers,
    residualMedian: median,
    residualP90: p90,
    iterations: trials,
  };
}

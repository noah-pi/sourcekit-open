// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Global motion estimation between two frames.
 *
 * Block matching plus a least-squares similarity fit: samples a grid of small
 * blocks in frame A, finds each block's best SAD match in frame B, then fits a
 * 3-parameter global model (translation + rotation) to the correspondences.
 * Output is camera motion — pan (tx, ty in px/frame), roll (radians/frame),
 * and a match-quality measure — which the IMU/flow consistency check compares
 * against the signed pose trace.
 *
 * Constraints:
 *  - The single global model assumes the dominant scene motion is the
 *    camera's. Large moving subjects pollute the fit; median-based outlier
 *    rejection limits that, and coverage/match counts are surfaced so a
 *    reader can judge reliability.
 *  - Flat blocks (sky, walls) are skipped by a variance gate.
 *  - Roll is in radians (rotation of the displacement field about the frame
 *    center), directly comparable to the gyro's roll rate with no
 *    focal-length assumption. Pan stays in pixels and is focal-dependent, so
 *    the consistency check correlates pan shape with yaw/pitch shape rather
 *    than absolute units.
 *
 * Pure, no DOM: the caller feeds downsampled grayscale planes.
 */

export interface GlobalMotion {
  /** Horizontal translation, px/frame (+ = scene moves right = camera pans left). */
  tx: number;
  /** Vertical translation, px/frame. */
  ty: number;
  /** Rotation about the frame center, radians/frame (+ = image content rotates CCW). */
  rotRad: number;
  /** Block correspondences used after outlier rejection. */
  matches: number;
  /** Fraction of sampled blocks that produced usable correspondences. */
  coverage: number;
  /**
   * The inlier correspondences behind the numbers, in the coordinate space of
   * the planes passed in, so the desk's overlay can draw exactly the matches
   * the fit used.
   */
  vectors: Correspondence[];
}

export interface FlowOptions {
  /** Block half-size (block is 2h+1 square). Default 4 (9x9, subsampled x2). */
  blockHalf?: number;
  /** Search radius in px. Default 12. */
  searchRadius?: number;
  /** Grid stride in px. Default 16. */
  stride?: number;
  /** Minimum block stddev to attempt a match (flat-block gate). Default 5. */
  minStddev?: number;
}

interface Correspondence {
  ax: number;
  ay: number;
  bx: number;
  by: number;
}

function blockStddev(gray: ArrayLike<number>, w: number, cx: number, cy: number, half: number): number {
  let sum = 0;
  let sq = 0;
  let n = 0;
  for (let y = cy - half; y <= cy + half; y += 2) {
    for (let x = cx - half; x <= cx + half; x += 2) {
      const v = gray[y * w + x];
      sum += v;
      sq += v * v;
      n++;
    }
  }
  const mean = sum / n;
  return Math.sqrt(Math.max(0, sq / n - mean * mean));
}

function sad(a: ArrayLike<number>, b: ArrayLike<number>, w: number, ax: number, ay: number, bx: number, by: number, half: number): number {
  let d = 0;
  for (let y = -half; y <= half; y += 2) {
    const ra = (ay + y) * w;
    const rb = (by + y) * w;
    for (let x = -half; x <= half; x += 2) {
      d += Math.abs(a[ra + ax + x] - b[rb + bx + x]);
    }
  }
  return d;
}

function median(values: number[]): number {
  const s = [...values].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
}

/** Solve a 3x3 linear system: forward elimination + back-substitution. Null if singular. */
export function solve3(m: number[][], v: number[]): number[] | null {
  const a = m.map((row, i) => [...row, v[i]]);
  for (let col = 0; col < 3; col++) {
    let piv = col;
    for (let r = col + 1; r < 3; r++) if (Math.abs(a[r][col]) > Math.abs(a[piv][col])) piv = r;
    if (Math.abs(a[piv][col]) < 1e-12) return null;
    const tmp = a[col];
    a[col] = a[piv];
    a[piv] = tmp;
    for (let r = col + 1; r < 3; r++) {
      const f = a[r][col] / a[col][col];
      for (let c = col; c < 4; c++) a[r][c] -= f * a[col][c];
    }
  }
  const x = [0, 0, 0];
  for (let r = 2; r >= 0; r--) {
    let s = a[r][3];
    for (let c = r + 1; c < 3; c++) s -= a[r][c] * x[c];
    x[r] = s / a[r][r];
  }
  return x;
}

export interface BlockMatch {
  /** Displacement of the best match, px (integer — SAD grid resolution). */
  dx: number;
  dy: number;
  /** best/second SAD ratio; closer to 1 means an ambiguous match. */
  ambiguity: number;
}

/**
 * Single-block SAD match, shared by feature tracks and the global fit. Finds
 * the best block match for (ax, ay) from plane A inside plane B within
 * `searchRadius`, using the same flat-block and ambiguity gates as the global
 * estimator. Null when the block is flat, ambiguous, or out of bounds.
 */
export function matchBlock(
  a: ArrayLike<number>,
  b: ArrayLike<number>,
  width: number,
  height: number,
  ax: number,
  ay: number,
  opts: FlowOptions = {},
): BlockMatch | null {
  const half = opts.blockHalf ?? 4;
  const radius = opts.searchRadius ?? 12;
  const minStd = opts.minStddev ?? 5;
  const margin = half + 1;
  if (ax < margin + radius || ax > width - 1 - margin - radius) return null;
  if (ay < margin + radius || ay > height - 1 - margin - radius) return null;
  if (blockStddev(a, width, Math.round(ax), Math.round(ay), half) < minStd) return null;
  let best = Infinity;
  let second = Infinity;
  let bdx = 0;
  let bdy = 0;
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const d = sad(a, b, width, Math.round(ax), Math.round(ay), Math.round(ax) + dx, Math.round(ay) + dy, half);
      if (d < best) {
        second = best;
        best = d;
        bdx = dx;
        bdy = dy;
      } else if (d < second) {
        second = d;
      }
    }
  }
  if (second > 0 && best / second > 0.9) return null; // repeating-texture accident, not motion
  return { dx: bdx, dy: bdy, ambiguity: second > 0 ? best / second : 0 };
}

/**
 * Estimates global motion A to B; both planes are width x height grayscale.
 * Null when too few textured blocks match.
 */
export function estimateGlobalMotion(
  a: ArrayLike<number>,
  b: ArrayLike<number>,
  width: number,
  height: number,
  opts: FlowOptions = {},
): GlobalMotion | null {
  const half = opts.blockHalf ?? 4;
  const radius = opts.searchRadius ?? 12;
  const stride = opts.stride ?? 16;
  const minStd = opts.minStddev ?? 5;
  const margin = half + radius + 1;
  if (width < margin * 2 + stride || height < margin * 2 + stride) return null;

  const correspondences: Correspondence[] = [];
  let sampled = 0;
  for (let cy = margin; cy <= height - margin; cy += stride) {
    for (let cx = margin; cx <= width - margin; cx += stride) {
      sampled++;
      if (blockStddev(a, width, cx, cy, half) < minStd) continue;
      let best = Infinity;
      let second = Infinity;
      let bdx = 0;
      let bdy = 0;
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const d = sad(a, b, width, cx, cy, cx + dx, cy + dy, half);
          if (d < best) {
            second = best;
            best = d;
            bdx = dx;
            bdy = dy;
          } else if (d < second) {
            second = d;
          }
        }
      }
      // Ambiguity gate: a match barely better than its runner-up is usually
      // a repeating-texture accident, not motion.
      if (second > 0 && best / second > 0.9) continue;
      correspondences.push({ ax: cx, ay: cy, bx: cx + bdx, by: cy + bdy });
    }
  }
  if (correspondences.length < 4) return null;

  // Outlier rejection: median displacement, keep matches within 3px.
  const mdx = median(correspondences.map((c) => c.bx - c.ax));
  const mdy = median(correspondences.map((c) => c.by - c.ay));
  const inliers = correspondences.filter(
    (c) => Math.abs(c.bx - c.ax - mdx) <= 3 && Math.abs(c.by - c.ay - mdy) <= 3,
  );
  if (inliers.length < 4) return null;

  // Least-squares fit of displacement to [tx, ty, theta] about the center:
  // dx_i = tx - theta*(ay_i - cy0),  dy_i = ty + theta*(ax_i - cx0)
  const cx0 = width / 2;
  const cy0 = height / 2;
  const n = inliers.length;
  let sxr = 0;
  let syr = 0;
  let srr = 0;
  let sdx = 0;
  let sdy = 0;
  let srdx = 0;
  for (const c of inliers) {
    const px = -(c.ay - cy0); // theta coefficient in dx
    const py = c.ax - cx0; // theta coefficient in dy
    const ddx = c.bx - c.ax;
    const ddy = c.by - c.ay;
    sxr += px;
    syr += py;
    srr += px * px + py * py;
    sdx += ddx;
    sdy += ddy;
    srdx += px * ddx + py * ddy;
  }
  const solved = solve3(
    [
      [n, 0, sxr],
      [0, n, syr],
      [sxr, syr, srr],
    ],
    [sdx, sdy, srdx],
  );
  if (!solved) return null;
  return {
    tx: solved[0],
    ty: solved[1],
    rotRad: solved[2],
    matches: inliers.length,
    coverage: sampled > 0 ? inliers.length / sampled : 0,
    vectors: inliers,
  };
}

// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * P5 single-image physics: chromatic-aberration RADIAL STRUCTURE.
 *
 * Real optics produce lateral chromatic aberration that grows with distance
 * from the principal point and points along the radius (lens-consistent
 * direction). Screens, renders, and recompressions have no physical reason
 * to carry a consistent radial displacement field between color channels.
 * Geometric measurement, not ML.
 *
 * METHOD (pure, deterministic):
 *   1. A coarse lattice of patch cells across the frame. Per cell, the
 *      displacement of R relative to G and B relative to G is estimated by
 *      normalized cross-correlation over integer shifts (±SEARCH_PX), with
 *      parabolic subpixel refinement. Flat cells (no texture) carry no
 *      displacement information and are marked unusable — never filled in.
 *   2. A radial model is fitted: displacement ∝ distance from the principal
 *      point, along the radius. Two measurements result:
 *        - radial correlation: Pearson r between cell radius and the radial
 *          component of the measured displacement;
 *        - direction alignment: median cos between the displacement vector
 *          and the radial direction (signed, so a consistent inward/outward
 *          lens direction scores near ±1; a uniform screen-recapture shift
 *          scatters around 0).
 *
 * WHAT THE STATES MEAN (read before quoting any of them):
 *   - 'consistent-radial': the channels ARE related by a lens-like radial
 *     field. This is consistency with optics, NOT proof of a real scene:
 *     re-photographing a PHOTOGRAPH carries the original picture's CA
 *     straight through, so the tell is evadable and says nothing by itself.
 *   - 'no-radial-structure': no consistent radial field measured. This is
 *     expected for renders and screen recaptures — and ALSO for genuine
 *     captures whose CA was corrected in-camera (most phones correct
 *     lateral CA in the pipeline) or that are too smooth to measure.
 *     Absence of this structure is NOT suspicion.
 *   - 'insufficient-data': too few textured cells to fit anything.
 *
 * Error rates are UNCHARACTERIZED until the P6 corpus ROC lands; every
 * threshold below is a first-principles placeholder. This is a statistical
 * signal a person weighs, never a verdict.
 */

export const CA_RADIAL_METHOD_VERSION = '0.1.0-p5-scaffold';

/** Displacement search half-window, px. Lateral CA on phone lenses is ≲1–2 px. */
export const CA_SEARCH_PX = 6;
/** Patch edge for NCC, px. 32 keeps texture statistics meaningful per cell. */
export const CA_PATCH_PX = 32;
/** Below this median |displacement| (px) there is no measurable CA to model. */
export const CA_MIN_MEDIAN_DISP_PX = 0.03;
/** Radial-correlation floor for 'consistent-radial' (placeholder, P6). */
export const CA_MIN_RADIAL_CORR = 0.5;
/** Direction-alignment floor: median cos with the radius (placeholder, P6). */
export const CA_MIN_DIRECTION_COS = 0.7;
/** Minimum textured cells for a fit at all. */
export const CA_MIN_CELLS = 9;

export interface PlaneSet {
  width: number;
  height: number;
  /** Planar channel buffers, length width*height, linear light. */
  r: ArrayLike<number>;
  g: ArrayLike<number>;
  b: ArrayLike<number>;
}

export interface CaRadialOptions {
  /** Principal point in pixels; defaults to the frame center. */
  principalPoint?: [number, number];
  /** Target lattice density (cells per side); actual count adapts to the frame. */
  cellsPerSide?: number;
}

export type CaRadialState = 'consistent-radial' | 'no-radial-structure' | 'insufficient-data';

export interface CaRadialResult {
  state: CaRadialState;
  /** 0..1: radial correlation gated by direction alignment (best channel pair). */
  score?: number;
  /** Pearson r between cell radius and radial displacement (best pair). */
  radialCorrelation?: number;
  /** Median signed cos between displacement and radial direction (best pair). */
  directionAlignment?: number;
  /** Which channel pair produced the score ('R/G' or 'B/G'). */
  channelPair?: 'R/G' | 'B/G';
  /** Median displacement magnitude across usable cells, px. */
  medianDisplacementPx?: number;
  cellsUsed: number;
  cellsTotal: number;
  methodVersion: string;
  text: string;
}

const FRAMING =
  'This is a statistical signal a person weighs, never a verdict; its error rates are uncharacterized until the corpus benchmark lands.';
const EVASION =
  'A consistent radial field is evadable (re-photographing a photograph carries the original picture\'s CA through), and its absence is produced by any CA-correcting pipeline — neither direction of this signal is suspicion or clearance by itself.';

/** Normalized cross-correlation of two equal-size patches; win is the overlap guard. */
function nccAtShift(
  a: ArrayLike<number>, b: ArrayLike<number>,
  w: number, h: number,
  x0: number, y0: number, size: number,
  dx: number, dy: number,
  guard: number,
): number {
  // Compare a[y0+guard .. y0+size-guard) with b shifted by (dx,dy).
  let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0, n = 0;
  for (let y = y0 + guard; y < y0 + size - guard; y++) {
    const ya = y * w;
    const yb = (y + dy) * w;
    for (let x = x0 + guard; x < x0 + size - guard; x++) {
      const va = a[ya + x];
      const vb = b[yb + x + dx];
      sa += va; sb += vb; saa += va * va; sbb += vb * vb; sab += va * vb; n++;
    }
  }
  if (n === 0) return 0;
  const ma = sa / n, mb = sb / n;
  const va = saa / n - ma * ma, vb = sbb / n - mb * mb;
  if (va <= 1e-9 || vb <= 1e-9) return 0;
  return (sab / n - ma * mb) / Math.sqrt(va * vb);
}

/** Peak + parabolic subpixel refinement over the shift grid. */
function estimateDisplacement(
  a: ArrayLike<number>, b: ArrayLike<number>,
  w: number, h: number, x0: number, y0: number, size: number, search: number,
): { dx: number; dy: number; peak: number } | null {
  const guard = search + 1;
  const ncc: number[][] = [];
  let best = -2, bx = 0, by = 0;
  for (let dy = -search; dy <= search; dy++) {
    const row: number[] = [];
    for (let dx = -search; dx <= search; dx++) {
      const v = nccAtShift(a, b, w, h, x0, y0, size, dx, dy, guard);
      row.push(v);
      if (v > best) { best = v; bx = dx; by = dy; }
    }
    ncc.push(row);
  }
  if (best < 0.3) return null; // no stable match — the cell is unusable, not zero
  const at = (dx: number, dy: number): number =>
    (dx >= -search && dx <= search && dy >= -search && dy <= search)
      ? ncc[dy + search][dx + search]
      : best; // border: clamp (subpixel bias admitted, only at the rim)
  const sub = (vm: number, v0: number, vp: number): number => {
    const d = vm - 2 * v0 + vp;
    return Math.abs(d) < 1e-9 ? 0 : 0.5 * (vm - vp) / d;
  };
  return {
    dx: bx + sub(at(bx - 1, by), best, at(bx + 1, by)),
    dy: by + sub(at(bx, by - 1), best, at(bx, by + 1)),
    peak: best,
  };
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function pearson(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n < 3) return 0;
  const mx = xs.reduce((a, v) => a + v, 0) / n;
  const my = ys.reduce((a, v) => a + v, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
  }
  return sxx <= 1e-12 || syy <= 1e-12 ? 0 : sxy / Math.sqrt(sxx * syy);
}

interface CellMeasurement {
  px: number; py: number;       // cell center
  dx: number; dy: number;       // measured displacement, px
}

function analyzePair(
  cells: CellMeasurement[],
  pp: [number, number],
): { radialCorrelation: number; directionAlignment: number; medianDisp: number } {
  const radii: number[] = [];
  const radialComp: number[] = [];
  const cosines: number[] = [];
  const mags: number[] = [];
  for (const c of cells) {
    const ux = c.px - pp[0], uy = c.py - pp[1];
    const r = Math.hypot(ux, uy);
    const m = Math.hypot(c.dx, c.dy);
    mags.push(m);
    if (r < 1e-6 || m < 1e-6) continue; // center cell / no displacement: no direction to weigh
    radii.push(r);
    radialComp.push((c.dx * ux + c.dy * uy) / r);
    cosines.push((c.dx * ux + c.dy * uy) / (r * m));
  }
  return {
    radialCorrelation: pearson(radii, radialComp),
    directionAlignment: median(cosines),
    medianDisp: median(mags),
  };
}

export function analyzeCaRadial(planes: PlaneSet, opts: CaRadialOptions = {}): CaRadialResult {
  const { width: w, height: h } = planes;
  const pp: [number, number] = opts.principalPoint ?? [w / 2, h / 2];
  const size = CA_PATCH_PX, search = CA_SEARCH_PX;
  const margin = search + 2;
  const base = (over: Partial<CaRadialResult>): CaRadialResult => ({
    cellsUsed: 0, cellsTotal: 0, methodVersion: CA_RADIAL_METHOD_VERSION, text: '', ...over,
  } as CaRadialResult);

  const span = Math.min(w, h);
  const perSide = Math.max(3, Math.min(opts.cellsPerSide ?? 8, Math.floor(span / (size + margin))));
  const stepX = perSide > 1 ? (w - 2 * (size / 2 + margin)) / (perSide - 1) : 0;
  const stepY = perSide > 1 ? (h - 2 * (size / 2 + margin)) / (perSide - 1) : 0;
  const origins: Array<[number, number]> = [];
  for (let j = 0; j < perSide; j++) {
    for (let i = 0; i < perSide; i++) {
      const x0 = Math.round(margin + i * stepX);
      const y0 = Math.round(margin + j * stepY);
      if (x0 + size + search < w && y0 + size + search < h) origins.push([x0, y0]);
    }
  }

  if (origins.length < CA_MIN_CELLS) {
    return base({
      state: 'insufficient-data', cellsTotal: origins.length,
      text:
        `Insufficient data for CA structure: the frame (${w}×${h}) supports only ${origins.length} measurement cells ` +
        `(minimum ${CA_MIN_CELLS}). Nothing was measured. ${FRAMING}`,
    });
  }

  const cellsRG: CellMeasurement[] = [];
  const cellsBG: CellMeasurement[] = [];
  for (const [x0, y0] of origins) {
    // Texture gate: a flat cell has no displacement information.
    let s = 0, ss = 0, n = 0;
    for (let y = y0; y < y0 + size; y += 4) for (let x = x0; x < x0 + size; x += 4) {
      const v = planes.g[y * w + x]; s += v; ss += v * v; n++;
    }
    const variance = ss / n - (s / n) * (s / n);
    if (variance < 1e-10) continue; // flat cell: no displacement information, never interpolated
    const center: [number, number] = [x0 + size / 2, y0 + size / 2];
    const dRG = estimateDisplacement(planes.g, planes.r, w, h, x0, y0, size, search);
    if (dRG) cellsRG.push({ px: center[0], py: center[1], dx: dRG.dx, dy: dRG.dy });
    const dBG = estimateDisplacement(planes.g, planes.b, w, h, x0, y0, size, search);
    if (dBG) cellsBG.push({ px: center[0], py: center[1], dx: dBG.dx, dy: dBG.dy });
  }

  const best = cellsRG.length >= cellsBG.length
    ? { pair: 'R/G' as const, cells: cellsRG }
    : { pair: 'B/G' as const, cells: cellsBG };

  if (best.cells.length < CA_MIN_CELLS) {
    return base({
      state: 'insufficient-data', cellsUsed: best.cells.length, cellsTotal: origins.length,
      text:
        `Insufficient data for CA structure: only ${best.cells.length} of ${origins.length} cells carried usable texture ` +
        `(minimum ${CA_MIN_CELLS}) — flat or unmatched regions carry no displacement information and are never interpolated. ` +
        `Nothing was measured. ${FRAMING}`,
    });
  }

  const stats = analyzePair(best.cells, pp);
  // Sign-free: lateral CA points inward OR outward depending on the channel
  // and the lens — the lens-consistent structure is the RADIALITY, not the
  // sign. The signed components ride along for interpretation.
  const radial = Math.abs(stats.radialCorrelation);
  const direction = Math.abs(stats.directionAlignment);
  const significant = stats.medianDisp >= CA_MIN_MEDIAN_DISP_PX;
  const consistent =
    radial >= CA_MIN_RADIAL_CORR &&
    direction >= CA_MIN_DIRECTION_COS &&
    significant;
  // The score is the correlation gated by direction agreement and by whether
  // there is any displacement to model at all; the raw components ride along.
  const score = significant ? radial * direction : 0;

  const measured =
    `channel pair ${best.pair}, ${best.cells.length}/${origins.length} cells: radial correlation ${stats.radialCorrelation.toFixed(2)} ` +
    `(|r| floor ${CA_MIN_RADIAL_CORR}), direction alignment ${stats.directionAlignment.toFixed(2)} ` +
    `(|cos| floor ${CA_MIN_DIRECTION_COS}), median displacement ${stats.medianDisp.toFixed(3)} px — sign-free: ` +
    'lateral CA points inward or outward by channel and lens, the lens-consistent structure is the radiality itself';

  if (consistent) {
    return base({
      state: 'consistent-radial', score,
      radialCorrelation: stats.radialCorrelation, directionAlignment: stats.directionAlignment,
      channelPair: best.pair, medianDisplacementPx: stats.medianDisp,
      cellsUsed: best.cells.length, cellsTotal: origins.length,
      text:
        `Consistent radial CA structure (${measured}): the color channels are related by a lens-like radial ` +
        `displacement field growing from the principal point. This is consistency WITH optics, not a finding about ` +
        `the scene. ${EVASION} ${FRAMING}`,
    });
  }
  return base({
    state: 'no-radial-structure', score,
    radialCorrelation: stats.radialCorrelation, directionAlignment: stats.directionAlignment,
    channelPair: best.pair, medianDisplacementPx: stats.medianDisp,
    cellsUsed: best.cells.length, cellsTotal: origins.length,
    text:
      `No consistent radial CA structure (${measured}): the channels show no lens-consistent radial displacement ` +
      `field. Renders and screen recaptures look like this — and so do genuine captures after in-camera CA ` +
      `correction, so this is NOT suspicion by itself. ${EVASION} ${FRAMING}`,
  });
}

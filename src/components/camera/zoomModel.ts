// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Zoom model — pure math, no React.
 *
 * Zoom is tracked as ONE number: the factor relative to the wide lens's 1x,
 * the same number Apple prints on its pills (".5", "1", "5"). A relative
 * factor maps onto the running session as:
 *
 *   device factor = relative factor / current lens's optical stop
 *
 * so 5.2x on a 5x telephoto is 1.04x of device zoom on the tele stack, and
 * 3x with the wide lens selected is 3x of device zoom on the wide stack
 * (a digital crop between optical stops — stated, see DIGITAL_MARKER_NOTE).
 *
 * Honesty rules carried by this file:
 *  - Optical stops come from the hardware (listFormats FOVs → labels);
 *    a lens whose factor can't be derived shows its label ('T'), never a
 *    guessed number.
 *  - Past the last optical stop everything is digital resampling; the UI
 *    marks it (the "DIGITAL" underline) rather than implying more lens.
 */

import type { ExhibitLens, LensZoomCap } from '../../lib/exhibitCamera';

/**
 * Fallback digital-zoom ceiling, relative to wide 1x, used ONLY when the
 * native per-device quality caps haven't reported (pre-W2 native builds,
 * capabilities() not yet fetched, or a lens the caps omit).
 *
 * Native Wave 2 (W2.3) landed the contract this constant was standing in
 * for: capabilities().lensZoomCaps carries each constituent device's
 * hardware max AND an app-chosen digital-quality cap (a quality choice,
 * honestly documented — not a hardware limit). maxRelativeZoom() below
 * derives the ceiling from that data whenever it is available; this
 * conservative constant is the fallback, applied on top of the device's
 * own clamp. Digital zoom is resampling — stated by the DIGITAL marker.
 */
export const MAX_RELATIVE_ZOOM = 10;

/**
 * The relative (wide-1x-based) zoom ceiling from the native per-device
 * quality caps (W2.3). For each optical stop whose lens the caps cover,
 * the ceiling is stopFactor × min(hardwareMax, qualityCap) — how far a
 * sweep on THAT stack may go; the ceiling of the sweep itself is the best
 * across stacks (a pinch crosses lenses). Falls back to MAX_RELATIVE_ZOOM
 * when no cap data is available — never a guessed-tight cap.
 */
export function maxRelativeZoom(
  stops: OpticalStop[],
  caps: LensZoomCap[] | null | undefined,
): number {
  let best = 0;
  for (const s of stops) {
    if (s.factor === null) continue;
    const cap = caps?.find((c) => c.lens === s.lens);
    if (!cap) continue;
    const deviceCeiling = Math.min(cap.hardwareMax, cap.qualityCap);
    if (Number.isFinite(deviceCeiling) && deviceCeiling > 0) {
      best = Math.max(best, s.factor * deviceCeiling);
    }
  }
  return best > 0 ? best : MAX_RELATIVE_ZOOM;
}

/** One optical detent: a physical lens stack and its factor relative to
 *  wide 1x. `factor: null` = the hardware couldn't tell us (FOV
 *  unreported) — the pill shows its label, and pinch/wheel crossing
 *  through it is disabled (we never guess a number). */
export interface OpticalStop {
  lens: ExhibitLens;
  factor: number | null;
  label: string;
}

/** Fixed stops for the lenses the hardware reports, in optical order. */
export function buildStops(
  lenses: ExhibitLens[],
  labels: Partial<Record<ExhibitLens, string>>,
): OpticalStop[] {
  const stops: OpticalStop[] = [];
  if (lenses.includes('ultraWide')) stops.push({ lens: 'ultraWide', factor: 0.5, label: labels.ultraWide ?? '.5' });
  if (lenses.includes('wide')) stops.push({ lens: 'wide', factor: 1, label: labels.wide ?? '1x' });
  if (lenses.includes('telephoto')) {
    const label = labels.telephoto ?? 'T';
    const parsed = Number(label);
    stops.push({ lens: 'telephoto', factor: Number.isFinite(parsed) && parsed > 1 ? parsed : null, label });
  }
  return stops;
}

export function stopFor(stops: OpticalStop[], lens: ExhibitLens): OpticalStop | undefined {
  return stops.find((s) => s.lens === lens);
}

/**
 * 0.17.1 — the Halide model. A pinch/wheel sweep stays on the CURRENT
 * physical stack and zooms digitally within it; lens switching is an
 * explicit pill tap (with haptic), never an automatic hand-off mid-
 * gesture. Rationale: mid-gesture hand-off requires the OS-managed
 * virtual device; swapping physical inputs mid-gesture reconfigures the
 * session (exposure jump, black frames, ping-pong at the stop boundary)
 * — the "chaotic zoom" bug. Apple-Camera-style auto hand-off is a planned
 * follow-up via the virtual device, which also migrates Second lens onto
 * the synchronized secret-port topology.
 *
 * The sweep's limits are therefore per-stack: the floor is the stack's
 * own optical stop, the ceiling is stop × min(hardwareMax, qualityCap).
 */
export function stackZoomFloor(stops: OpticalStop[], lens: ExhibitLens): number {
  const stop = stopFor(stops, lens);
  return stop && stop.factor !== null ? stop.factor : 1;
}

export function stackZoomCeiling(
  stops: OpticalStop[],
  caps: LensZoomCap[] | null | undefined,
  lens: ExhibitLens,
): number {
  const stop = stopFor(stops, lens);
  const base = stop && stop.factor !== null ? stop.factor : 1;
  const cap = caps?.find((c) => c.lens === lens);
  if (cap) {
    const deviceCeiling = Math.min(cap.hardwareMax, cap.qualityCap);
    if (Number.isFinite(deviceCeiling) && deviceCeiling > 0) return base * deviceCeiling;
  }
  return base * MAX_RELATIVE_ZOOM;
}

/** The highest KNOWN optical factor — everything above it is digital
 *  resampling on the last stack and gets the DIGITAL marker. */
export function lastOpticalFactor(stops: OpticalStop[]): number {
  let max = 1;
  for (const s of stops) if (s.factor !== null && s.factor > max) max = s.factor;
  return max;
}

/** The lowest known optical factor — pinch/wheel never go below it
 *  (below the ultra-wide there is no sensor to crop from). */
export function firstOpticalFactor(stops: OpticalStop[]): number {
  let min = 1;
  for (const s of stops) if (s.factor !== null && s.factor < min) min = s.factor;
  return min;
}

/** relative factor → factor on the current device stack. */
export function toDeviceFactor(relative: number, stops: OpticalStop[], lens: ExhibitLens): number {
  const stop = stopFor(stops, lens)?.factor ?? 1;
  return relative / stop;
}

/** The relative factor a fresh lens selection sits at (its optical stop;
 *  1 = device-relative when the stop is unknown). */
export function factorForLens(stops: OpticalStop[], lens: ExhibitLens): number {
  return stopFor(stops, lens)?.factor ?? 1;
}

export const clampZoom = (f: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, f));

/**
 * 35 mm-equivalent focal length of the wide stack from its reported
 * horizontal FOV: focal = 18 / tan(hfov/2) (the 36 mm frame width).
 * Returns null when the hardware didn't report a FOV — never a guess.
 */
export function baseMmFromFov(wideFovDegrees: number | null | undefined): number | null {
  if (!wideFovDegrees || wideFovDegrees <= 0) return null;
  return 18 / Math.tan((wideFovDegrees * Math.PI) / 360);
}

/** Effective mm-equivalent while zooming (Blackmagic-style readout). */
export function effectiveMm(baseMm: number | null, relative: number): number | null {
  return baseMm === null ? null : Math.round(baseMm * relative);
}

/** Apple-style factor text: '.5', '1', '1.2', '5'. */
export function formatFactor(f: number): string {
  if (f < 0.995) return String(Math.round(f * 10) / 10).replace(/^0/, '');
  const rounded = Math.round(f * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

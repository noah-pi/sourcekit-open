// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Zoom model. Pure math, no React. Zoom is one number: the factor relative to
 * the wide lens's 1x (".5", "1", "5"), mapped onto the session as
 * device factor = relative factor / current lens's optical stop.
 *
 * Optical stops come from the hardware (listFormats FOVs to labels); a lens
 * whose factor cannot be derived shows its label ('T') instead of a number.
 * Past the last optical stop the zoom is digital resampling, marked in the UI
 * by the DIGITAL underline.
 */

import type { ExhibitLens, LensZoomCap } from '../../lib/exhibitCamera';

/**
 * Fallback digital-zoom ceiling, relative to wide 1x. Used only when
 * capabilities.lensZoomCaps has not reported for a lens; maxRelativeZoom
 * derives the ceiling from that cap data otherwise. Applied on top of the
 * device's own clamp.
 */
export const MAX_RELATIVE_ZOOM = 10;

/**
 * Relative (wide-1x-based) zoom ceiling from the native per-device quality
 * caps. Per stack the ceiling is stopFactor × min(hardwareMax, qualityCap);
 * the sweep's own ceiling is the best across stacks, since a pinch crosses
 * lenses. Falls back to MAX_RELATIVE_ZOOM when no cap data is available.
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
 *  wide 1x. `factor: null` means the FOV was unreported; the pill shows its
 *  label and pinch/wheel cannot cross through it. */
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
 * A pinch or wheel sweep stays on the current physical stack and zooms
 * digitally within it; lens switching is an explicit pill tap. Swapping
 * physical inputs mid-gesture reconfigures the session (exposure jump, black
 * frames, ping-pong at the stop boundary); auto hand-off needs the OS-managed
 * virtual device. Sweep limits are per-stack: floor is the stack's optical
 * stop, ceiling is stop × min(hardwareMax, qualityCap).
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

/** Highest known optical factor. Above it is digital resampling on the last
 *  stack, which gets the DIGITAL marker. */
export function lastOpticalFactor(stops: OpticalStop[]): number {
  let max = 1;
  for (const s of stops) if (s.factor !== null && s.factor > max) max = s.factor;
  return max;
}

/** Lowest known optical factor. Pinch/wheel floor: below the ultra-wide there
 *  is no sensor to crop from. */
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
 * 35 mm-equivalent focal length of the wide stack from its reported horizontal
 * FOV: focal = 18 / tan(hfov/2) (the 36 mm frame width). Null when the
 * hardware reported no FOV.
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

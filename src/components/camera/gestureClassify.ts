// Source Kit 0.1.0 — gesture classifier for the camera screen's bottom controls
/**
 * Gesture classifier for the camera screen's bottom controls. Every responder
 * (mode swipe, pro tray, precision bar) calls this with the touch-start zone
 * and locks the first non-'none' answer for the gesture; the lock lives in the
 * callers, this function is stateless. Pure, so the decision matrix is
 * unit-tested in scripts/test-protray-gestures.mts.
 *
 * Zones:
 *  - 'ribbon': |dx| > 6 and 1.5× dominant scrubs; dy > 8 and 2× dominant is
 *    the close swipe, committed at 30px (CLOSE_COMMIT_DY). Never a mode swipe.
 *  - 'tray': capsules are tap targets, so drags classify 'none'.
 *  - 'field': |dx| > 24 and 1.5× dominant is a mode swipe, only while the
 *    ribbon is closed (`modeSwipeEnabled`).
 */

export type GestureZone = 'ribbon' | 'tray' | 'field';

export type GestureClass = 'scrub' | 'close' | 'mode-swipe' | 'none';

/** Scrub intent: |dx| beyond this AND 1.5× dominant over |dy|. */
export const SCRUB_MIN_DX = 6;
export const SCRUB_DOMINANCE = 1.5;
/** Close intent: downward dy beyond this AND 2× dominant over |dx|. */
export const CLOSE_MIN_DY = 8;
export const CLOSE_DOMINANCE = 2;
/** The ribbon dismisses once a close-intent gesture travels this far down. */
export const CLOSE_COMMIT_DY = 30;
/** Mode swipe: |dx| beyond this and 1.5× dominant. The one-switch-per-gesture
 *  commit at 64px of travel lives in the screen. */
export const MODE_SWIPE_MIN_DX = 24;
export const MODE_SWIPE_DOMINANCE = 1.5;

export function classifyGesture(
  dx: number,
  dy: number,
  zone: GestureZone,
  modeSwipeEnabled = true,
): GestureClass {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (zone === 'ribbon') {
    // Horizontal first: a diagonal drag crossing both thresholds on the same
    // event reads as a scrub, since the scrub dominance bar is lower.
    if (ax > SCRUB_MIN_DX && ax > ay * SCRUB_DOMINANCE) return 'scrub';
    if (dy > CLOSE_MIN_DY && dy > ax * CLOSE_DOMINANCE) return 'close';
    return 'none';
  }
  if (zone === 'tray') return 'none';
  if (modeSwipeEnabled && ax > MODE_SWIPE_MIN_DX && ax > ay * MODE_SWIPE_DOMINANCE) {
    return 'mode-swipe';
  }
  return 'none';
}

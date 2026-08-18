/**
 * Gesture classifier — the ONE place touch intent is decided for
 * the camera screen's bottom controls. Pure and dependency-free so the
 * whole decision matrix is unit-tested (scripts/test-protray-gestures.mts).
 *
 * The bug class this kills: three separate responders (the root
 * mode swipe, the pro tray, the precision bar) each carried their own
 * ad-hoc thresholds, so one physical drag could be read as two different
 * gestures. Now every responder asks THIS function, with the touch-start
 * zone, and locks the first non-'none' answer for the life of the gesture
 * (the intent lock lives in the callers — this function is stateless).
 *
 * Rules:
 *  - 'ribbon' zone: horizontal intent (|dx| > 6 and 1.5× dominant) scrubs;
 *    clearly-vertical-from-the-start (dy > 8 and 2× dominant) is the close
 *    swipe, which the ribbon commits at 30px of travel (CLOSE_COMMIT_DY).
 *    A ribbon gesture can never be a mode swipe.
 *  - 'tray' zone: the capsules are tap targets; a drag that starts on the
 *    tray is never a mode swipe. Classified 'none' — the touch simply
 *    doesn't become a gesture.
 *  - 'field' zone (everything else): a decisive horizontal swipe
 *    (|dx| > 24 and 1.5× dominant) is a mode swipe — but only while the
 *    ribbon is CLOSED (`modeSwipeEnabled`). While the ribbon is open the
 *    mode swipe is disabled entirely: the simplest correct gate.
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
/** Mode swipe: |dx| beyond this AND 1.5× dominant (one switch per gesture
 *  fires at 64px of travel — that commit threshold stays in the screen). */
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
    // Horizontal first: a truly diagonal drag that crosses both thresholds
    // on the same event is a scrub (the scrub dominance bar is lower).
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

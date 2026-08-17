// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Zoom control (0.15.0 Drop 2, research §5) — replaces the "too fast, no
 * in-between" zoom UI.
 *
 * <ZoomWheel/> — the bottom row: optical pills (.5 / 1 / tele factor, only
 * the lenses the hardware reports) you TAP to jump to, and a DRAG anywhere
 * on the row turns it into a smooth zoom wheel sweeping the in-between
 * factors (the complaint was "no in-between"). Haptic tick at each optical
 * detent crossed. The wheel is a leaf: live values ride the LiveChannel,
 * so scrubbing never re-renders the viewfinder tree.
 *
 * <ZoomHud/> — the top readout while zooming: ONLY the effective
 * mm-equivalent ("≈27mm", Blackmagic-style, derived from the hardware's
 * reported wide FOV — never shown when unreported). No × factor, no
 * DIGITAL marker: the lens pills below already carry the factor.
 *
 * Pinch lives on the screen's root responder (it owns two-finger
 * gestures); it drives the same channel, so pill row and HUD agree.
 */

import React, { useRef, useState, useSyncExternalStore } from 'react';
import { PanResponder, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import { colors, radii, spacing, type, fontSize } from '../../theme';
import type { ExhibitLens } from '../../lib/exhibitCamera';
import type { LiveChannel, LiveZoom } from './liveChannel';
import {
  type OpticalStop,
  effectiveMm,
  formatFactor,
  stackZoomFloor,
  stopFor,
  MAX_RELATIVE_ZOOM,
  clampZoom,
} from './zoomModel';

// ---------------------------------------------------------------------------
// ZoomHud — top readout
// ---------------------------------------------------------------------------

export function ZoomHud({
  channel,
  stops,
  baseMm,
}: {
  channel: LiveChannel<LiveZoom>;
  stops: OpticalStop[];
  /** 35 mm-equivalent of the wide stack; null when the hardware didn't
   *  report a FOV — the readout simply doesn't render (never a guess). */
  baseMm: number | null;
}) {
  const { factor, active } = useSyncExternalStore(channel.subscribe, channel.get);
  // Hidden when idle AND parked exactly on an optical stop (the pills
  // already say which lens is live — a readout would be noise).
  const parked = !active && stops.some((s) => s.factor !== null && Math.abs(factor - s.factor) < 0.01);
  if (parked) return null;
  // The readout is the 35mm-equivalent focal length ONLY ("≈27mm") — the
  // same effectiveMm math as before (zoom factor × base wide equiv), with
  // the × factor and DIGITAL marker cut: the pills below carry the factor.
  const mm = effectiveMm(baseMm, factor);
  if (mm === null) return null;
  return (
    <View style={styles.hudPill} pointerEvents="none">
      <Text style={styles.hudMm}>≈{mm}mm</Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// ZoomWheel — optical pills + drag-to-wheel
// ---------------------------------------------------------------------------

/** Horizontal travel per octave of zoom on the wheel — a full sweep of the
 *  .5→10x range is ~4.3 octaves, so the wheel covers it in ~950 px with
 *  fine control around each stop. */
const PX_PER_OCTAVE = 220;

export function ZoomWheel({
  channel,
  stops,
  currentLens,
  maxZoom = MAX_RELATIVE_ZOOM,
  onJump,
  onLive,
  onCommit,
}: {
  channel: LiveChannel<LiveZoom>;
  stops: OpticalStop[];
  /** The lens the session is ACTUALLY on (post-honesty-check) — pills
   *  highlight from this, never from intent. */
  currentLens: ExhibitLens;
  /** Relative ceiling of the wheel sweep (W2.3): the native per-device
   *  quality-cap ceiling when the caps have reported, else the
   *  MAX_RELATIVE_ZOOM fallback. */
  maxZoom?: number;
  /** Tap on a pill: jump to that lens's optical stop (a real lens switch,
   *  honesty-checked by the screen). */
  onJump: (lens: ExhibitLens) => void;
  /** Wheel scrub: live relative factor (native apply + crossing, no state). */
  onLive: (relative: number) => void;
  /** Wheel released: commit this relative factor. */
  onCommit: (relative: number) => void;
}) {
  const { factor, active } = useSyncExternalStore(channel.subscribe, channel.get);
  const [wheeling, setWheeling] = useState(false);
  const startLog = useRef(0);
  const liveRef = useRef(factor);
  liveRef.current = factor;
  const cb = useRef({ onJump, onLive, onCommit });
  cb.current = { onJump, onLive, onCommit };
  const stopsRef = useRef(stops);
  stopsRef.current = stops;
  const lensRef = useRef(currentLens);
  lensRef.current = currentLens;
  // The ceiling moves when the native caps land — read through a ref so the
  // once-created pan responder always sees the current value.
  const maxZoomRef = useRef(maxZoom);
  maxZoomRef.current = maxZoom;
  const lastHapticStop = useRef<number | null>(null);
  // The exact factor last scrubbed to — the release commits THIS, not the
  // (possibly one frame behind) channel snapshot.
  const wheelValue = useRef(factor);

  const pan = useRef(
    PanResponder.create({
      // Taps fall through to the pill buttons; only a decisive horizontal
      // drag turns the row into the wheel (and beats the root mode-swipe
      // responder to the claim, since the row is deeper).
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponder: (_evt, g) => Math.abs(g.dx) > 8 && Math.abs(g.dx) > Math.abs(g.dy),
      onPanResponderGrant: () => {
        setWheeling(true);
        startLog.current = Math.log2(liveRef.current);
        lastHapticStop.current = null;
      },
      onPanResponderMove: (_evt, g) => {
        const c = stopsRef.current;
        // Bounds re-derived per move: the lens inventory (and thus the
        // stack floor) can arrive after the responder was created. The
        // wheel never leaves the current stack (0.17.1, the Halide model).
        const lo = stackZoomFloor(c, lensRef.current);
        const next = clampZoom(
          Math.pow(2, startLog.current + g.dx / PX_PER_OCTAVE),
          lo,
          maxZoomRef.current,
        );
        wheelValue.current = next;
        // Haptic tick at each optical detent the wheel sweeps across.
        const crossed = c.some(
          (s) => s.factor !== null &&
            (liveRef.current - s.factor) * (next - s.factor) < 0 &&
            lastHapticStop.current !== s.factor,
        );
        if (crossed) {
          const nearest = c.reduce<OpticalStop | null>((best, s) => {
            if (s.factor === null) return best;
            return !best || Math.abs((s.factor ?? 0) - next) < Math.abs((best.factor ?? 0) - next) ? s : best;
          }, null);
          lastHapticStop.current = nearest?.factor ?? null;
          void Haptics.selectionAsync();
        }
        cb.current.onLive(next);
      },
      onPanResponderRelease: () => {
        setWheeling(false);
        cb.current.onCommit(wheelValue.current);
      },
      onPanResponderTerminate: () => {
        setWheeling(false);
        cb.current.onCommit(wheelValue.current);
      },
    }),
  ).current;

  /** Which pill is live: the factor parked on a known stop (within a
   *  whisper), or — for a lens whose factor the hardware couldn't report
   *  ('T') — simply being the lens the session is on. */
  const activeStop = (s: OpticalStop) =>
    (s.factor !== null && Math.abs(factor - s.factor) < (wheeling || active ? 0.03 : 0.01)) ||
    (s.factor === null && s.lens === currentLens);

  // Apple behavior: while zoomed between stops, the in-between value
  // appears as its own pill so the current factor is always visible. (On
  // a factor-unknown lens parked at 1 the lens pill already says it.)
  const unknownLensParked =
    stopFor(stops, currentLens)?.factor === null && Math.abs(factor - 1) < 0.03;
  const between =
    !unknownLensParked && !stops.some((s) => s.factor !== null && Math.abs(factor - s.factor) < 0.03);

  return (
    <View style={styles.wheelRow} {...pan.panHandlers}>
      {stops.map((s) => (
        <TouchableOpacity
          key={s.lens}
          style={[styles.pill, activeStop(s) && styles.pillActive]}
          onPress={() => cb.current.onJump(s.lens)}
          accessibilityLabel={`${s.label} lens`}
        >
          <Text style={[styles.pillText, activeStop(s) && styles.pillTextActive]}>{s.label}</Text>
        </TouchableOpacity>
      ))}
      {between ? (
        <View style={[styles.pill, styles.pillLive]} pointerEvents="none">
          <Text style={[styles.pillText, styles.pillTextActive]}>{formatFactor(factor)}</Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  // --- HUD ---
  hudPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    backgroundColor: 'rgba(10,13,16,0.6)',
    borderRadius: radii.full,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  hudMm: { color: colors.onDark.text, fontFamily: type.mono, fontSize: fontSize.sm, fontWeight: '700' },
  // --- wheel ---
  wheelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.md,
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.sm,
  },
  // Apple's own zoom control language: translucent circles, factor text,
  // the live stop carries the ring. Labels are FOV-derived from hardware.
  // Mockup .zp: 10.5/700 translucent pills; the active stop is the mockup's
  // ok-bright green on its 13% wash.
  pill: {
    minWidth: 34,
    height: 34,
    paddingHorizontal: 10,
    borderRadius: 999,
    backgroundColor: 'rgba(13,13,15,0.55)',
    borderWidth: 1,
    borderColor: 'rgba(232,232,236,0.14)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  pillActive: {
    backgroundColor: 'rgba(126,214,164,0.13)',
    borderColor: '#7ED6A4',
  },
  pillLive: { backgroundColor: 'rgba(13,13,15,0.75)' },
  pillText: { color: colors.onDark.faint, fontSize: 10.5, fontWeight: '700' },
  pillTextActive: { color: '#7ED6A4', fontWeight: '700' },
});

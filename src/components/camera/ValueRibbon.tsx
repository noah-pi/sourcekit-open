// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Value Ribbon — the camera's ONE adjustment surface. Every pro
 * param, ladder or continuous, is edited HERE and nowhere else: a capsule
 * tap docks the ribbon with that param, a horizontal drag scrubs it, and
 * the ribbon's own AUTO pill returns the param to auto. There are no
 * per-capsule gestures, no hidden long-press ladders, no second dial
 * widget — one surface, one pattern.
 *
 * Interaction spec:
 *  - Center needle is fixed; the tick scale slides under it. Horizontal
 *    drag anywhere on the track scrubs the value (relative, so the finger
 *    never has to hunt for the current position). Ladder params ride the
 *    same track as integer indices with a detent per rung (snap 1).
 *  - The AUTO pill (right of the track) is the ONLY auto/manual toggle;
 *    it is filled clay while the param is in auto. Double-tap on the
 *    track does the same reset — both are documented in the hint line.
 *  - Floating value pill floats above the needle while dragging.
 *  - Light haptic tick at each detent crossed; a stronger pulse at the
 *    range ends.
 *  - Gestures are classified by classifyGesture (gestureClassify.ts —
 *    the same pure function the screen's mode swipe consults): scrub on
 *    clear horizontal intent, close on a clearly-vertical-from-the-start
 *    swipe down (commit at CLOSE_COMMIT_DY), and the intent is locked for
 *    the life of the gesture, so a diagonal drift mid-scrub can never
 *    dismiss the ribbon.
 *  - Dragging a manual param (focus/WB/ISO/SHTR) puts the device in the
 *    corresponding manual mode; AUTO returns it. The value shown is what
 *    the bridge applies — device clamping is reported back on commit by
 *    the screen.
 *
 * Perf: the ribbon is a leaf. Drag state lives here (never in the screen),
 * so scrubbing re-renders only this strip; the screen hears throttled
 * `onLive` (native apply, no React state) and a single `onCommit`.
 */

import React, { useEffect, useRef, useState } from 'react';
import { Animated, PanResponder, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import { colors, radii, spacing, type, fontSize } from '../../theme';
import { classifyGesture, CLOSE_COMMIT_DY } from './gestureClassify';

/** The landed palette's clay — "chosen by hand" (matches index.tsx's
 *  HUD_IDENT_ON; the camera chrome is scheme-independent dark glass). */
const CLAY = '#C08552';

export interface RibbonConfig {
  /** Short label in the floating pill ('EV', 'FOCUS', 'WB'). */
  title: string;
  min: number;
  max: number;
  /** Committed value the ribbon opens at (and returns to after a reset
   *  while still open — the screen pushes it back through this prop). */
  value: number;
  /** Snap quantum (EV: 0.1 stops; ladders: 1 — one index per rung). Omit
   *  for fully continuous. */
  snap?: number;
  /** Haptic detents (ladder rungs, WB presets, EV whole stops). */
  detents?: number[];
  /** Tick values to draw (subset near the live value is rendered). */
  ticks?: number[];
  format: (v: number) => string;
  /** True while the param is in auto — the AUTO pill renders filled. */
  isAuto?: boolean;
  /** The ONE auto/manual toggle: the ribbon's AUTO pill. Omit only for a
   *  param with no meaningful auto (none today). */
  onAuto?: () => void;
}

interface Props {
  config: RibbonConfig;
  /** Throttled by the caller — native apply only, no React state. */
  onLive: (v: number) => void;
  /** Gesture finished: persist/state-sync this value. */
  onCommit: (v: number) => void;
  /** Double-tap: same reset the AUTO pill performs. */
  onReset: () => void;
  /** Swipe down: dismiss the ribbon. */
  onDismiss: () => void;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function ValueRibbon({ config, onLive, onCommit, onReset, onDismiss }: Props) {
  const { min, max } = config;
  const [live, setLive] = useState(config.value);
  const [dragging, setDragging] = useState(false);
  const [trackWidth, setTrackWidth] = useState(0);
  const enter = useRef(new Animated.Value(0)).current;

  // Ref mirrors read by the (created-once) PanResponder closures.
  const liveRef = useRef(live);
  liveRef.current = live;
  const draggingRef = useRef(false);
  const startValue = useRef(config.value);
  const lastTapAt = useRef(0);
  const dismissed = useRef(false);
  const lastHapticAt = useRef(0);
  // Latest config/callbacks — the PanResponder is created once and reads
  // these refs, so a param switch (new range/snap/detents) and the
  // measured track width reach the gesture closures.
  const cb = useRef({ onLive, onCommit, onReset, onDismiss });
  cb.current = { onLive, onCommit, onReset, onDismiss };
  const configRef = useRef(config);
  configRef.current = config;
  const pxPerUnitRef = useRef(1);
  pxPerUnitRef.current = trackWidth > 0 ? (trackWidth * 1.5) / (max - min) : 1;

  // Entrance: fade + rise, native driver, one shot.
  useEffect(() => {
    Animated.timing(enter, { toValue: 1, duration: 180, useNativeDriver: true }).start();
  }, [enter]);

  // External value changes (reset, AUTO, a capsule re-tap) re-seat the
  // dial whenever the user isn't holding it.
  useEffect(() => {
    if (!draggingRef.current) setLive(config.value);
  }, [config.value]);

  /** Full range spans ~1.5 track widths — fine control without endless travel. */
  const pxPerUnit = pxPerUnitRef.current;

  const scrubTo = (raw: number) => {
    const c = configRef.current;
    let v = clamp(raw, c.min, c.max);
    if (c.snap) v = Math.round(v / c.snap) * c.snap;
    v = Math.round(v * 10000) / 10000;
    const prev = liveRef.current;
    if (v === prev) return;
    liveRef.current = v;
    setLive(v);
    cb.current.onLive(v);
    const now = Date.now();
    if (now - lastHapticAt.current >= 70) {
      const crossedDetent = (c.detents ?? []).some(
        (d) => (prev - d) * (v - d) < 0 || v === d,
      );
      const hitEnd = (v === c.min || v === c.max) && prev !== c.min && prev !== c.max;
      if (hitEnd) {
        lastHapticAt.current = now;
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      } else if (crossedDetent) {
        lastHapticAt.current = now;
        void Haptics.selectionAsync();
      }
    }
  };

  // Gesture intent is classified by the shared pure function and locked on
  // the first non-'none' answer: one gesture, one behavior. A scrub can
  // never turn into a close mid-drag, and a touch that hasn't declared
  // itself moves nothing.
  const intent = useRef<'undecided' | 'scrub' | 'close'>('undecided');

  const pan = useRef(
    PanResponder.create({
      // The ribbon owns every touch that lands on it (taps included — the
      // double-tap reset needs them) — including horizontal scrubs the
      // root responder would otherwise read as a mode swipe.
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_evt, g) =>
        classifyGesture(g.dx, g.dy, 'ribbon') === 'scrub',
      onPanResponderGrant: () => {
        dismissed.current = false;
        intent.current = 'undecided';
        startValue.current = liveRef.current;
      },
      onPanResponderMove: (_evt, g) => {
        if (dismissed.current) return;
        if (intent.current === 'undecided') {
          const cls = classifyGesture(g.dx, g.dy, 'ribbon');
          // 'none': intent not yet clear, value holds still. 'mode-swipe'
          // is unreachable in the ribbon zone — the guard just narrows the
          // type for the intent lock below.
          if (cls === 'none' || cls === 'mode-swipe') return;
          intent.current = cls;
          if (cls === 'scrub') {
            draggingRef.current = true;
            setDragging(true);
          }
        }
        if (intent.current === 'close') {
          // Swipe down dismisses (decisive vertical travel).
          if (g.dy > CLOSE_COMMIT_DY && g.dy > Math.abs(g.dx) * 1.5) {
            dismissed.current = true;
            intent.current = 'undecided';
            draggingRef.current = false;
            setDragging(false);
            cb.current.onDismiss();
          }
          return;
        }
        scrubTo(startValue.current + g.dx / pxPerUnitRef.current);
      },
      onPanResponderRelease: (_evt, g) => {
        const wasScrubbing = intent.current === 'scrub';
        intent.current = 'undecided';
        draggingRef.current = false;
        setDragging(false);
        if (dismissed.current) return;
        // A gesture that actually scrubbed always commits — even when it
        // drifted back near its origin (that is not a tap; the live value
        // moved and the committed value must catch up).
        if (wasScrubbing) {
          cb.current.onCommit(liveRef.current);
          return;
        }
        const wasTap = Math.abs(g.dx) < 6 && Math.abs(g.dy) < 6;
        if (wasTap) {
          const now = Date.now();
          if (now - lastTapAt.current < 300) {
            lastTapAt.current = 0;
            cb.current.onReset();
            return; // the reset owns the value now — no commit of the old one
          }
          lastTapAt.current = now;
          return; // a lone tap changes nothing
        }
        // An abandoned close swipe (or an intent-less flick) leaves the
        // committed value untouched.
      },
      onPanResponderTerminate: () => {
        const wasScrubbing = intent.current === 'scrub';
        intent.current = 'undecided';
        draggingRef.current = false;
        setDragging(false);
        if (!dismissed.current && wasScrubbing) cb.current.onCommit(liveRef.current);
      },
    }),
  ).current;

  // Ticks: draw only the window around the live value; positions derive
  // from (tick - live), so the scale slides under the fixed needle.
  const half = trackWidth / 2;
  const visibleTicks = (config.ticks ?? []).filter(
    (t) => Math.abs(t - live) * pxPerUnit <= half + 8,
  );
  const visibleDetents = (config.detents ?? []).filter(
    (d) => Math.abs(d - live) * pxPerUnit <= half + 8,
  );

  return (
    <Animated.View
      style={[
        styles.wrap,
        {
          opacity: enter,
          transform: [{ translateY: enter.interpolate({ inputRange: [0, 1], outputRange: [10, 0] }) }],
        },
      ]}
    >
      {/* Floating value pill — above the needle, always the live value. */}
      <View style={styles.pill} pointerEvents="none">
        <Text style={styles.pillTitle}>{config.title}</Text>
        <Text style={styles.pillValue}>{config.format(live)}</Text>
      </View>

      <View style={styles.trackRow}>
        <View
          style={styles.track}
          // Generous touch target: the track sits between the tray and the
          // mode row — the slop keeps a slightly-high or slightly-low
          // finger on the slider.
          hitSlop={{ top: 10, bottom: 10, left: 8, right: 8 }}
          onLayout={(e) => setTrackWidth(e.nativeEvent.layout.width)}
          {...pan.panHandlers}
        >
          {visibleTicks.map((t) => (
            <View
              key={`t${t}`}
              style={[styles.tick, { left: half + (t - live) * pxPerUnit }]}
            />
          ))}
          {visibleDetents.map((d) => (
            <View
              key={`d${d}`}
              style={[styles.detent, { left: half + (d - live) * pxPerUnit }]}
            />
          ))}
          <View style={styles.needle} pointerEvents="none" />
        </View>

        {/* The ONE auto/manual toggle: filled clay while the param is in
            auto, a quiet outline while manual — tap returns to auto. */}
        {config.onAuto ? (
          <TouchableOpacity
            style={[styles.autoPill, config.isAuto && styles.autoPillActive]}
            onPress={config.onAuto}
            hitSlop={8}
            accessibilityLabel={`${config.title} back to auto`}
          >
            <Text style={[styles.autoPillText, config.isAuto && styles.autoPillTextActive]}>AUTO</Text>
          </TouchableOpacity>
        ) : null}
      </View>

      <Text style={styles.hint}>
        {dragging ? '' : 'double-tap resets · swipe down closes'}
      </Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignSelf: 'stretch', marginBottom: spacing.sm },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'center',
    gap: 6,
    backgroundColor: 'rgba(10,13,16,0.78)',
    borderRadius: radii.full,
    paddingHorizontal: 12,
    paddingVertical: 5,
    marginBottom: 6,
  },
  pillTitle: { color: colors.onDark.faint, fontSize: 9, fontWeight: '700', letterSpacing: 1 },
  pillValue: { color: colors.onDark.text, fontFamily: type.mono, fontSize: fontSize.sm, fontWeight: '700' },
  trackRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginHorizontal: spacing.md,
  },
  track: {
    flex: 1,
    height: 44,
    borderRadius: radii.md,
    backgroundColor: 'rgba(10,13,16,0.55)',
    overflow: 'hidden',
    justifyContent: 'center',
  },
  tick: {
    position: 'absolute',
    top: 12,
    width: 1,
    height: 10,
    backgroundColor: 'rgba(237,241,244,0.35)',
  },
  // Detents are told by the ONE accent color plus their diamond shape —
  // never color alone.
  detent: {
    position: 'absolute',
    top: 26,
    width: 5,
    height: 5,
    marginLeft: -2,
    borderRadius: 2.5,
    backgroundColor: colors.onDark.accent,
  },
  needle: {
    position: 'absolute',
    alignSelf: 'center',
    top: 6,
    bottom: 6,
    width: 2,
    borderRadius: 1,
    backgroundColor: colors.onDark.accent,
  },
  autoPill: {
    borderRadius: radii.full,
    borderWidth: 1,
    borderColor: 'rgba(232,232,236,0.2)',
    backgroundColor: 'rgba(10,13,16,0.55)',
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  autoPillActive: { borderColor: CLAY },
  autoPillText: { color: colors.onDark.faint, fontSize: 9, fontWeight: '800', letterSpacing: 0.7 },
  autoPillTextActive: { color: CLAY },
  hint: {
    alignSelf: 'center',
    color: 'rgba(237,241,244,0.45)',
    fontSize: 9,
    letterSpacing: 0.4,
    marginTop: 4,
    height: 12,
  },
});

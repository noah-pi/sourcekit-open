// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Value Ribbon — the camera's single adjustment surface. A capsule tap docks
 * the ribbon with that param, a horizontal drag scrubs it, and the AUTO pill
 * returns it to auto.
 *
 * Interaction:
 *  - The center needle is fixed; the tick scale slides under it. Drag is
 *    relative, anywhere on the track. Ladder params ride the same track as
 *    integer indices with a detent per rung (snap 1).
 *  - The AUTO pill right of the track is the auto/manual toggle, filled clay
 *    while in auto. Double-tap on the track does the same reset.
 *  - Value pill floats above the needle while dragging.
 *  - Light haptic at each detent crossed, stronger at the range ends.
 *  - classifyGesture (gestureClassify.ts) picks scrub vs close, and the
 *    intent is locked for the gesture, so diagonal drift mid-scrub cannot
 *    dismiss the ribbon. Close commits at CLOSE_COMMIT_DY.
 *  - Dragging a manual param (focus/WB/ISO/SHTR) puts the device in that
 *    manual mode; AUTO returns it. Device clamping comes back on commit.
 *
 * Drag state lives here, not in the screen, so scrubbing re-renders only
 * this strip; the screen gets throttled `onLive` and one `onCommit`.
 */

import React, { useEffect, useRef, useState } from 'react';
import { Animated, PanResponder, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import { colors, radii, spacing, type, fontSize } from '../../theme';
import { classifyGesture, CLOSE_COMMIT_DY } from './gestureClassify';

/** Clay accent, matching index.tsx's HUD_IDENT_ON. Camera chrome is
 *  scheme-independent dark glass. */
const CLAY = '#C08552';

export interface RibbonConfig {
  /** Short label in the floating pill ('EV', 'FOCUS', 'WB'). */
  title: string;
  min: number;
  max: number;
  /** Committed value the ribbon opens at. A reset pushes the new value back
   *  through this prop. */
  value: number;
  /** Snap quantum (EV: 0.1 stops; ladders: 1 — one index per rung). Omit
   *  for fully continuous. */
  snap?: number;
  /** Haptic detents (ladder rungs, WB presets, EV whole stops). */
  detents?: number[];
  /** Tick values to draw (subset near the live value is rendered). */
  ticks?: number[];
  format: (v: number) => string;
  /** True while the param is in auto; the AUTO pill renders filled. */
  isAuto?: boolean;
  /** Auto/manual toggle behind the AUTO pill. Omit for a param with no
   *  meaningful auto. */
  onAuto?: () => void;
}

interface Props {
  config: RibbonConfig;
  /** Throttled by the caller. Native apply only, no React state. */
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
  // The PanResponder is created once and reads these refs, so a param switch
  // and the measured track width reach the gesture closures.
  const cb = useRef({ onLive, onCommit, onReset, onDismiss });
  cb.current = { onLive, onCommit, onReset, onDismiss };
  const configRef = useRef(config);
  configRef.current = config;
  const pxPerUnitRef = useRef(1);
  pxPerUnitRef.current = trackWidth > 0 ? (trackWidth * 1.5) / (max - min) : 1;

  // Entrance: fade and rise, native driver, one shot.
  useEffect(() => {
    Animated.timing(enter, { toValue: 1, duration: 180, useNativeDriver: true }).start();
  }, [enter]);

  // External value changes (reset, AUTO, capsule re-tap) re-seat the dial
  // when the user is not holding it.
  useEffect(() => {
    if (!draggingRef.current) setLive(config.value);
  }, [config.value]);

  /** Full range spans ~1.5 track widths. */
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

  // Intent locks on the first non-'none' classification and holds for the
  // gesture, so a scrub cannot become a close mid-drag.
  const intent = useRef<'undecided' | 'scrub' | 'close'>('undecided');

  const pan = useRef(
    PanResponder.create({
      // The ribbon owns every touch that lands on it, taps included (the
      // double-tap reset needs them) and horizontal scrubs the root responder
      // would otherwise read as a mode swipe.
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
          // 'none' means intent is not yet clear and the value holds still.
          // 'mode-swipe' is unreachable here; the guard narrows the type.
          if (cls === 'none' || cls === 'mode-swipe') return;
          intent.current = cls;
          if (cls === 'scrub') {
            draggingRef.current = true;
            setDragging(true);
          }
        }
        if (intent.current === 'close') {
          // Swipe down dismisses, on decisive vertical travel.
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
        // A gesture that scrubbed always commits, even when it drifted back
        // near its origin: the live value moved, so the committed value must.
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
            return; // the reset owns the value; do not commit the old one
          }
          lastTapAt.current = now;
          return; // a lone tap changes nothing
        }
        // An abandoned close swipe or intent-less flick commits nothing.
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

  // Draw only the tick window around the live value; positions derive from
  // (tick - live), so the scale slides under the fixed needle.
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
      {/* Floating value pill, above the needle, showing the live value. */}
      <View style={styles.pill} pointerEvents="none">
        <Text style={styles.pillTitle}>{config.title}</Text>
        <Text style={styles.pillValue}>{config.format(live)}</Text>
      </View>

      <View style={styles.trackRow}>
        <View
          style={styles.track}
          // The track sits between the tray and the mode row; the slop keeps
          // a slightly high or low finger on the slider.
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

        {/* Auto/manual toggle: filled clay in auto,
            outline while manual. */}
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
  // Detents are marked by shape as well as the accent color, not color alone.
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

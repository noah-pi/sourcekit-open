// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Mode switcher — AUDIO / PHOTO / VIDEO in a
 * horizontal track above the shutter, with a highlight pill that slides to
 * the active slot on every switch.
 *
 * SIMPLIFIED (build-24 field fix): the first cut stacked a second label row
 * inside the pill and counter-translated it with Animated.multiply on the
 * native driver — on device that rendered both rows misaligned on top of
 * each other (the "overlapping labels" garble). This version keeps exactly
 * ONE label row: the pill translates underneath, and each label's color
 * crossfades dim↔bright on mode commit. Mode changes are discrete commits
 * (never mid-gesture), so a per-label Animated.timing on the native driver
 * is the whole cost — no layout, no measurement, no stacked rows.
 *
 * Direction honesty (the iOS 26 "Classic Mode Switching" lesson — never
 * invert a learned swipe): the pill physically travels toward the newly
 * active label along the row's visual order, and the screen's swipe
 * mapping (leftward swipe advances AUDIO → PHOTO → VIDEO) is unchanged.
 */

import React, { useEffect, useRef } from 'react';
import { Animated, StyleSheet, TouchableOpacity, View } from 'react-native';
import { colors, fontSize } from '../../theme';

export type CameraMode = 'audio' | 'picture' | 'video';

const MODES: { key: CameraMode; label: string }[] = [
  { key: 'audio', label: 'AUDIO' },
  { key: 'picture', label: 'PHOTO' },
  { key: 'video', label: 'VIDEO' },
];

// Fixed slot metrics — the pill's travel is pure translateX arithmetic.
const SLOT_W = 74;
const SLOT_GAP = 8;
const step = SLOT_W + SLOT_GAP;

export function ModeSwitcher({
  mode,
  onSwitch,
  disabled,
}: {
  mode: CameraMode;
  onSwitch: (m: CameraMode) => void;
  disabled?: boolean;
}) {
  const pillX = useRef(new Animated.Value(MODES.findIndex((m) => m.key === mode) * step)).current;
  // One brightness value per slot (1 = active). Driven on commit only.
  const bright = useRef(MODES.map((m) => new Animated.Value(m.key === mode ? 1 : 0))).current;

  useEffect(() => {
    const idx = MODES.findIndex((m) => m.key === mode);
    Animated.parallel([
      Animated.timing(pillX, { toValue: idx * step, duration: 200, useNativeDriver: true }),
      ...bright.map((b, i) =>
        Animated.timing(b, { toValue: i === idx ? 1 : 0, duration: 200, useNativeDriver: true }),
      ),
    ]).start();
  }, [mode, pillX, bright]);

  return (
    <View style={styles.row}>
      {/* Highlight pill: translates only, sits under the single label row. */}
      <Animated.View
        style={[styles.pill, { transform: [{ translateX: pillX }] }]}
        pointerEvents="none"
      />

      {MODES.map((m, i) => (
        <TouchableOpacity
          key={m.key}
          style={styles.slot}
          onPress={() => onSwitch(m.key)}
          disabled={disabled}
          accessibilityLabel={`${m.label} mode`}
        >
          <Animated.Text
            style={[
              styles.label,
              {
                color: bright[i].interpolate({
                  inputRange: [0, 1],
                  outputRange: [colors.onDark.dim, colors.onDark.text],
                }),
              },
            ]}
          >
            {m.label}
          </Animated.Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    gap: SLOT_GAP,
    marginBottom: 24,
  },
  slot: { width: SLOT_W, alignItems: 'center', paddingVertical: 4 },
  label: { fontSize: fontSize.sm, fontWeight: '700', letterSpacing: 1.5 },
  pill: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    width: SLOT_W,
    borderRadius: 999,
    backgroundColor: 'rgba(245,245,247,0.14)',
  },
});

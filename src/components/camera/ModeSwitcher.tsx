// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Mode switcher: AUDIO / PHOTO / VIDEO in a horizontal track above the
 * shutter, with a highlight pill that slides to the active slot.
 *
 * One label row only. The pill translates underneath it and each label's color
 * crossfades dim to bright on mode commit; stacking a counter-translated
 * second row inside the pill misrenders on device. Mode changes are discrete
 * commits, so the cost is one native-driver Animated.timing per label.
 * The pill travels toward the newly active label in the row's visual order;
 * a leftward swipe advances AUDIO to PHOTO to VIDEO.
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

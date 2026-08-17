// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * SealBreakDemo — the onboarding's one teach-by-watching beat.
 *
 * A mock photo drawn entirely from views (no assets, no network). The dot
 * travels from "as shot" to "edited" and back ON ITS OWN (0.18.3, Noah:
 * the drag interaction was janky — "it should just be an automatic
 * animation that plays on that page"): crossing the mark turns the
 * picture lurid and flips the seal chip from intact to broken. The point
 * lands in one loop — the seal covers the bytes, and any change breaks it.
 *
 * Honesty note: the chip says "changed", never "fake". An edit breaking
 * the seal says nothing about the scene — that line belongs to panel 3.
 */

import React, { useEffect, useRef, useState } from 'react';
import { Animated, Easing, StyleSheet, Text, View } from 'react-native';
import { colors, spacing, radii, fontSize, useThemedStyles } from '../../theme';
import { Chip } from '../ui';

const THUMB = 34;
const HOT = 14; // padding around the dot — keeps translateX aligned to the track
const SLIDE_MS = 1700; // one-way travel time — slow enough to read the flip
const HOLD_MS = 1100;  // dwell at each end so the two states land

export function SealBreakDemo() {
  const styles = useThemedStyles(buildStyles);
  const [trackW, setTrackW] = useState(0);
  const [broken, setBroken] = useState(false);
  const anim = useRef(new Animated.Value(0)).current;

  const track = Math.max(trackW - THUMB, 1);

  // The seal state is driven by the dot's actual position — the picture,
  // the chip and the dot can never disagree.
  useEffect(() => {
    const id = anim.addListener(({ value }) => {
      const isBroken = value > track * 0.4;
      setBroken((prev) => (prev === isBroken ? prev : isBroken));
    });
    return () => anim.removeListener(id);
  }, [anim, track]);

  // The loop starts once the track has a width to travel. Dwell, slide to
  // "edited", dwell, slide back — forever, until the page unmounts.
  useEffect(() => {
    if (trackW <= 0) return;
    anim.setValue(0);
    const slide = (to: number) =>
      Animated.timing(anim, { toValue: to, duration: SLIDE_MS, easing: Easing.inOut(Easing.cubic), useNativeDriver: true });
    const loop = Animated.loop(
      Animated.sequence([Animated.delay(HOLD_MS), slide(track), Animated.delay(HOLD_MS), slide(0)]),
    );
    loop.start();
    return () => loop.stop();
  }, [anim, track, trackW]);

  return (
    <View style={styles.demo}>
      {/* The "photo": calm palette as shot, lurid once edited. Views only.
          Decorative — VoiceOver gets the story from the label below. */}
      <View
        style={[styles.photo, { backgroundColor: broken ? '#2E2140' : '#A8C6DE' }]}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        <View
          style={[
            styles.sun,
            { backgroundColor: broken ? '#E23DA0' : '#F2C14E' },
            broken && { transform: [{ translateX: 26 }, { translateY: -8 }] },
          ]}
        />
        <View style={[styles.hill, styles.hillLeft, { backgroundColor: broken ? '#4A2E63' : '#6FA287' }]} />
        <View style={[styles.hill, styles.hillRight, { backgroundColor: broken ? '#1E152B' : colors.accent }]} />
      </View>

      {/* The track: end labels and the self-driving dot. No gestures —
          the animation is the teacher. */}
      <View
        style={styles.trackRow}
        accessibilityLabel="Demonstration: the photo moves between as shot and edited on its own. Editing the photo breaks its seal."
      >
        <Text style={styles.trackLabel}>as shot</Text>
        {/* Width is measured on the track itself — the thumb's travel must
            match the bar, not the wider row with its end labels. */}
        <View style={styles.track} onLayout={(e) => setTrackW(e.nativeEvent.layout.width)}>
          <Animated.View style={[styles.thumbHot, { transform: [{ translateX: anim }] }]}>
            <View style={styles.thumb} />
          </Animated.View>
        </View>
        <Text style={styles.trackLabel}>edited</Text>
      </View>

      <Chip
        tone={broken ? 'bad' : 'good'}
        icon={broken ? 'alert-circle-outline' : 'lock-closed-outline'}
        label={broken ? 'Changed · the seal is broken' : 'Unchanged since the shutter'}
      />
    </View>
  );
}

const buildStyles = () => StyleSheet.create({
  demo: {
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    padding: spacing.md,
    gap: spacing.md,
    shadowColor: '#000',
    shadowOpacity: 0.06,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 4 },
    elevation: 2,
  },
  photo: {
    height: 120,
    borderRadius: radii.md,
    overflow: 'hidden',
    justifyContent: 'flex-end',
  },
  sun: {
    position: 'absolute',
    top: 18,
    right: 26,
    width: 34,
    height: 34,
    borderRadius: 17,
  },
  hill: { position: 'absolute', bottom: -46, borderRadius: 999 },
  hillLeft: { left: -30, width: 190, height: 110 },
  hillRight: { right: -40, width: 230, height: 120 },
  trackRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  trackLabel: { color: colors.textFaint, fontSize: fontSize.xs, width: 44 },
  track: {
    flex: 1,
    height: 6,
    borderRadius: radii.full,
    backgroundColor: colors.surface2,
    justifyContent: 'center',
  },
  thumbHot: { padding: HOT, marginLeft: -HOT, alignSelf: 'flex-start' },
  thumb: {
    width: THUMB,
    height: THUMB,
    borderRadius: THUMB / 2,
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    shadowColor: '#000',
    shadowOpacity: 0.12,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 3,
  },
});

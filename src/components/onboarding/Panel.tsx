// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Panel — one onboarding block's entrance.
 *
 * A short fade-and-rise (250ms, native driver, transform + opacity only)
 * that replays each time its panel becomes the active page. Blocks on the
 * same page pass a small stagger delay so the headline lands before the
 * body — cheap enough to re-run on every page change with zero perf cost.
 */

import React, { useEffect, useRef } from 'react';
import { Animated, StyleProp, ViewStyle } from 'react-native';

export function Panel({ active, delay = 0, style, children }: {
  active: boolean;
  delay?: number;
  style?: StyleProp<ViewStyle>;
  children: React.ReactNode;
}) {
  const opacity = useRef(new Animated.Value(0)).current;
  const rise = useRef(new Animated.Value(10)).current;

  useEffect(() => {
    if (!active) return;
    opacity.setValue(0);
    rise.setValue(10);
    Animated.parallel([
      Animated.timing(opacity, { toValue: 1, duration: 250, delay, useNativeDriver: true }),
      Animated.timing(rise, { toValue: 0, duration: 250, delay, useNativeDriver: true }),
    ]).start();
  }, [active, delay, opacity, rise]);

  return (
    <Animated.View style={[style, { opacity, transform: [{ translateY: rise }] }]}>
      {children}
    </Animated.View>
  );
}

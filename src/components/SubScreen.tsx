// Source Kit 0.1.0 — a pushed settings screen
// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * The shell for a screen pushed from Settings: a back control, a title, and
 * a scrolling body. Everything a Settings row would otherwise have had to
 * explain on the main page lives inside one of these.
 */

import React from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { colors, spacing, fontSize, radii, type, useThemedStyles } from '../theme';

export function SubScreen({ title, back = 'Settings', children }: {
  title: string;
  /** Where the back control lands. Labeled, matching the exhibit detail
   *  screen — a back control that names its destination is the app's
   *  pattern, and two patterns for one gesture is one too many. */
  back?: string;
  children: React.ReactNode;
}) {
  const styles = useThemedStyles(buildStyles);
  const router = useRouter();
  return (
    <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
      <View style={styles.nav}>
        <TouchableOpacity
          onPress={() => router.back()}
          style={styles.back}
          accessibilityRole="button"
          accessibilityLabel={`Back to ${back}`}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
        >
          <Ionicons name="chevron-back" size={18} color={colors.accent} />
          <Text style={styles.backLabel}>{back}</Text>
        </TouchableOpacity>
      </View>
      <ScrollView
        contentContainerStyle={styles.body}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        // The keyboard covered the field being typed in. iOS insets the
        // scroll view by the keyboard's height when asked, and scrolls the
        // focused field into view.
        automaticallyAdjustKeyboardInsets
      >
        <Text style={styles.title}>{title}</Text>
        {children}
      </ScrollView>
    </SafeAreaView>
  );
}

/**
 * A numbered instruction. Setup on these screens is a sequence a person
 * performs partly off the phone, and a numbered list is the honest shape
 * for that — it says how many steps there are before you start.
 */
export function Step({ n, children }: { n: number; children: React.ReactNode }) {
  const styles = useThemedStyles(buildStyles);
  return (
    <View style={styles.step}>
      <Text style={styles.stepNum}>{n}</Text>
      <Text style={styles.stepBody}>{children}</Text>
    </View>
  );
}

/** A key, full width and left aligned. Never a right-aligned value that
 *  wraps ragged across three lines. */
export function KeyBox({ value }: { value: string }) {
  const styles = useThemedStyles(buildStyles);
  return (
    <View style={styles.keyBox}>
      <Text style={styles.keyMono} selectable>{value || '…'}</Text>
    </View>
  );
}

/** The one quiet line under a control. Same rank as Settings' rowDetail. */
export function RowDetail({ children }: { children: React.ReactNode }) {
  const styles = useThemedStyles(buildStyles);
  return <Text style={styles.detail}>{children}</Text>;
}

const buildStyles = () =>
  StyleSheet.create({
    safe: { flex: 1, backgroundColor: colors.bg },
    nav: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs,
      paddingHorizontal: spacing.md,
      paddingBottom: spacing.xs,
    },
    back: { flexDirection: 'row', alignItems: 'center', gap: 1, paddingVertical: spacing.xs, paddingRight: spacing.sm },
    backLabel: { color: colors.accent, fontSize: fontSize.md, fontWeight: '500' },
    title: { color: colors.text, fontSize: fontSize.xl, fontWeight: '700', marginBottom: spacing.xs },
    body: { padding: spacing.md, paddingBottom: spacing.xl, gap: spacing.sm },
    detail: { color: colors.textFaint, fontSize: fontSize.sm, lineHeight: 18 },
    step: { flexDirection: 'row', gap: spacing.sm, alignItems: 'flex-start' },
    stepNum: {
      color: colors.accent,
      fontSize: fontSize.sm,
      fontWeight: '700',
      lineHeight: 20,
      minWidth: 14,
      fontVariant: ['tabular-nums'],
    },
    stepBody: { flex: 1, color: colors.text, fontSize: fontSize.sm, lineHeight: 20 },
    keyBox: {
      backgroundColor: colors.surface2,
      borderRadius: radii.sm,
      paddingHorizontal: spacing.sm + 2,
      paddingVertical: spacing.sm,
    },
    keyMono: { color: colors.accent, fontFamily: type.mono, fontSize: fontSize.sm, lineHeight: 19 },
  });

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
import { colors, spacing, fontSize, useThemedStyles } from '../theme';

export function SubScreen({ title, children }: { title: string; children: React.ReactNode }) {
  const styles = useThemedStyles(buildStyles);
  const router = useRouter();
  return (
    <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
      <View style={styles.nav}>
        <TouchableOpacity
          onPress={() => router.back()}
          style={styles.back}
          accessibilityRole="button"
          accessibilityLabel="Back"
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
        >
          <Ionicons name="chevron-back" size={22} color={colors.accent} />
        </TouchableOpacity>
        <Text style={styles.title} numberOfLines={1}>{title}</Text>
      </View>
      <ScrollView
        contentContainerStyle={styles.body}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
      >
        {children}
      </ScrollView>
    </SafeAreaView>
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
      paddingBottom: spacing.sm,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
    },
    back: { paddingVertical: spacing.xs, paddingRight: spacing.xs },
    title: { color: colors.text, fontSize: fontSize.lg, fontWeight: '600', flex: 1 },
    body: { padding: spacing.md, paddingBottom: spacing.xl, gap: spacing.sm },
    detail: { color: colors.textFaint, fontSize: fontSize.sm, lineHeight: 18 },
  });

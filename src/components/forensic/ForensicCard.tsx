// Source Kit 0.1.0 — shared shell for the Forensic Checks modules
// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * ForensicCard — shared shell for the Forensic Checks modules. Flat card
 * (1px hairline, radius 14, no elevation), 10.5px/800 uppercase title, and a
 * one-line sub naming what the module compares; the body is the module's own
 * juxtaposition. Absence renders as a neutral gray "Not recorded" line; red
 * is reserved for proven tamper.
 */

import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { colors, spacing, fontSize, type, useThemedStyles } from '../../theme';

export function ForensicCard({ title, sub, children }: {
  title: string;
  /** What this module compares / where its data comes from — one line. */
  sub: string;
  children: React.ReactNode;
}) {
  const styles = useThemedStyles(buildStyles);
  return (
    <View style={styles.card}>
      <Text style={styles.title}>{title}</Text>
      <Text style={styles.sub}>{sub}</Text>
      {children}
    </View>
  );
}

/** The neutral absence line every module uses to say nothing was recorded. */
export function NotRecorded({ reason }: { reason?: string }) {
  const styles = useThemedStyles(buildStyles);
  return (
    <Text style={styles.absent}>{reason ? `Not recorded: ${reason}` : 'Not recorded'}</Text>
  );
}

/** A factual mono row inside a forensic card (hashes, counts). */
export function ForensicMono({ label, value }: { label: string; value: string }) {
  const styles = useThemedStyles(buildStyles);
  return (
    <View style={styles.monoRow}>
      <Text style={styles.monoLabel}>{label}</Text>
      <Text selectable style={styles.monoValue}>{value}</Text>
    </View>
  );
}

const buildStyles = () => StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 14,
    padding: spacing.sm + 6,
    marginBottom: spacing.sm,
  },
  title: {
    color: colors.textFaint,
    fontSize: 10.5,
    fontWeight: '800',
    letterSpacing: 1.9,
    textTransform: 'uppercase',
  },
  sub: { color: colors.textDim, fontSize: fontSize.xs, lineHeight: 17, marginTop: 3 },
  absent: { color: colors.textDim, fontSize: fontSize.sm, marginTop: spacing.sm },
  monoRow: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.md, marginTop: spacing.xs + 2 },
  monoLabel: { color: colors.textFaint, fontSize: fontSize.xs },
  monoValue: {
    flex: 1,
    color: colors.textDim,
    fontSize: 9.5,
    fontFamily: type.mono,
    letterSpacing: 0.2,
    textAlign: 'right',
  },
});

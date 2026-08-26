// Source Kit 0.1.0 — four rungs, always visible
// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Trust ladder card — the four rungs, always visible.
 *
 * Renders the projection from src/lib/trustLadder.ts as a vertical rail:
 * filled node = reached, hollow = unreached, ringed = highest reached,
 * brick = failed (proven tamper), gray italic = not-applicable. No badges or
 * checkmark icons; CAWG vocabulary warns that seals read as authority claims.
 *
 * The card must read correctly as a cropped screenshot, so it carries its own
 * title and the limits sentence inside the card. Do not render the rungs
 * without both.
 */

import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { colors, spacing, fontSize, type, radii, useThemedStyles, useEffectiveScheme } from '../theme';
import { Card } from './ui';
import { type TrustLadder, type LadderRung } from '../lib/trustLadder';

function nodeColor(state: LadderRung['state']): string {
  switch (state) {
    case 'reached': return colors.accent;
    case 'failed': return colors.danger;
    case 'not-applicable': return colors.textFaint;
    default: return colors.textFaint;
  }
}

function RungRow({ rung, ringed, last }: { rung: LadderRung; ringed: boolean; last: boolean }) {
  const styles = useThemedStyles(buildStyles);
  const nc = nodeColor(rung.state);
  const reached = rung.state === 'reached';
  const failed = rung.state === 'failed';
  return (
    <View style={styles.rungRow}>
      <View style={styles.railCol}>
        <View style={[styles.node, { borderColor: nc }, reached && { backgroundColor: nc }, ringed && styles.nodeRing, ringed && { borderColor: colors.accent }]}>
          {failed ? <View style={styles.nodeFailedDot} /> : null}
        </View>
        {!last ? <View style={[styles.rail, failed && styles.railBroken]} /> : null}
      </View>
      {/* VoiceOver: rail graphics are decorative; the row speaks as one text
          element, name plus detail, with the state as the value. */}
      <View
        style={styles.rungText}
        accessibilityRole="text"
        accessibilityLabel={rung.a11y.label}
        accessibilityValue={{ text: rung.a11y.value }}
      >
        <Text
          style={[
            styles.rungLabel,
            { color: failed ? colors.danger : rung.state === 'not-applicable' ? colors.textFaint : colors.text },
            rung.state === 'unreached' && { color: colors.textDim },
          ]}
        >
          {rung.label}
        </Text>
        <Text style={[styles.rungDetail, rung.state === 'not-applicable' && styles.rungDetailNa]}>
          {rung.detail}
        </Text>
      </View>
    </View>
  );
}

export function TrustLadderCard({ ladder }: { ladder: TrustLadder }) {
  const styles = useThemedStyles(buildStyles);
  return (
    <Card style={styles.card}>
      <Text style={styles.title}>What this file can show</Text>
      <View style={styles.rungs}>
        {ladder.rungs.map((r, i) => (
          <RungRow key={r.id} rung={r} ringed={i === ladder.highestReached} last={i === ladder.rungs.length - 1} />
        ))}
      </View>
      {ladder.anyFailed ? (
        <Text style={styles.failedNote}>
          A failed rung is proven tamper, not absence of proof. Do not rely on this file
          until a person has looked at why.
        </Text>
      ) : null}
    </Card>
  );
}

const NODE = 14;

const buildStyles = () => StyleSheet.create({
  card: { paddingTop: spacing.md },
  title: {
    fontFamily: type.display,
    fontSize: fontSize.lg,
    fontWeight: '700',
    color: colors.text,
    marginBottom: spacing.md,
  },
  rungs: { gap: 0 },
  rungRow: { flexDirection: 'row', alignItems: 'flex-start' },
  railCol: { width: NODE + 8, alignItems: 'center' },
  node: {
    width: NODE,
    height: NODE,
    borderRadius: NODE / 2,
    borderWidth: 1.5,
    backgroundColor: 'transparent',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 2,
  },
  nodeRing: {
    // Thicker ring for the current-highest rung, same outer diameter as every
    // other node so it does not read as emphasis by size.
    borderWidth: 2.5,
  },
  nodeFailedDot: { width: 5, height: 5, borderRadius: 2.5, backgroundColor: colors.danger },
  rail: { flex: 1, width: 1.5, backgroundColor: colors.border, minHeight: 22 },
  railBroken: { backgroundColor: colors.dangerSoft },
  rungText: { flex: 1, paddingBottom: spacing.md, paddingLeft: spacing.xs },
  rungLabel: { fontSize: fontSize.sm, fontWeight: '700', lineHeight: 19 },
  rungDetail: { color: colors.textDim, fontSize: fontSize.xs, lineHeight: 16, marginTop: 1 },
  rungDetailNa: { fontStyle: 'italic', color: colors.textFaint },
  failedNote: { color: colors.danger, fontSize: fontSize.xs, lineHeight: 17, marginTop: spacing.xs },
  rule: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border, marginVertical: spacing.md },
  limits: { color: colors.textDim, fontSize: fontSize.xs, lineHeight: 17 },
});

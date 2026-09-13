// Source Kit 0.1.0 — the shared vocabulary of the Inspect and Exhibit detail screens
// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * The detail kit — the shared vocabulary of the Inspect and Exhibit detail
 * screens.
 *
 * One grammar runs through all of it: every entry is a FACT and WHO
 * ESTABLISHED IT. The establisher is either a party a reader can name —
 * Apple, Google, DigiCert, a Bitcoin block, a trust list — or the phrase
 * "Device reported (unverified)". A maker this app has never heard of fills
 * the same slot with no new copy, which is the point: the vocabulary has to
 * survive hardware nobody here has seen.
 *
 * What the kit deliberately does not have:
 *
 *   No verdict badge. No checkmark, no score, no color that means "real".
 *   A tag says what was established, never what to conclude.
 *
 *   No popups. Explanation opens in place, as a drawer under the thing it
 *   explains, and closes the same way. A modal over a photograph interrupts
 *   the one thing the reader came to look at.
 *
 *   No red for absence. A file with no seal is the normal case, not a
 *   finding. Absence renders in the neutral register; only a CONTRADICTION
 *   — bytes that do not match a signature that covers them — earns danger.
 */

import React from 'react';
import { View, Text, Pressable, Modal, ScrollView, SafeAreaView, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { colors, spacing, fontSize, radii, type, useThemedStyles } from '../../theme';

/**
 * What a tag is allowed to mean.
 *
 * 'established' — a nameable party stands behind this.
 * 'neutral'     — nothing establishes it, which is ordinary and not a flaw.
 * 'attention'   — a number disagrees with another number. Worth a look.
 * 'broken'      — a signature covers these bytes and does not match them.
 */
export type Tone = 'established' | 'neutral' | 'attention' | 'broken';

/**
 * The unit of the whole screen: a fact, and who established it.
 *
 * `by` is a party's name, or the standing phrase for nothing having
 * established it. It is never a verdict and never a percentage.
 */
export function Fact({ label, value, by, mono }: {
  label: string;
  value: string;
  /** Who established it. Omitted when the label already carries that. */
  by?: string;
  mono?: boolean;
}) {
  const styles = useThemedStyles(buildStyles);
  return (
    <View style={styles.fact}>
      <Text style={styles.factLabel}>{label}</Text>
      <View style={styles.factRight}>
        <Text style={[styles.factValue, mono && styles.factMono]} selectable={mono}>{value}</Text>
        {by ? <Text style={styles.factBy}>{by}</Text> : null}
      </View>
    </View>
  );
}

/** The standing phrase for a fact nothing stands behind. */
export { DEVICE_REPORTED } from './words';

/**
 * A scene-evidence row: an icon, one line, and a body that opens under it.
 * One line is the constraint — a check that cannot be named in one line is
 * a check the reader will not follow.
 */
export function SceneRow({ icon, label, open, onToggle, children }: {
  icon: React.ComponentProps<typeof Ionicons>['name'];
  label: string;
  open: boolean;
  onToggle: () => void;
  children?: React.ReactNode;
}) {
  const styles = useThemedStyles(buildStyles);
  return (
    <View>
      <Pressable
        style={styles.sceneRow}
        onPress={onToggle}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={label}
      >
        <View style={styles.sceneIcon}>
          <Ionicons name={icon} size={17} color={colors.accent} />
        </View>
        <Text style={styles.sceneLabel}>{label}</Text>
        <Ionicons name={open ? 'chevron-up' : 'chevron-forward'} size={15} color={colors.textFaint} />
      </Pressable>
      {open && children ? <View style={styles.sceneBody}>{children}</View> : null}
    </View>
  );
}


export function ExplainerScreen({ visible, title, sub, lede, onClose, children }: {
  visible: boolean;
  title: string;
  /** The question that opened this sheet, restated under the title. */
  sub?: string;
  /** One sentence. If it needs two, the diagram is not doing its job. */
  lede?: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const styles = useThemedStyles(buildStyles);
  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} presentationStyle="pageSheet">
      <SafeAreaView style={styles.exScreen}>
        <View style={styles.exBar}>
          <Pressable onPress={onClose} hitSlop={12} accessibilityRole="button" accessibilityLabel="Back to details">
            <Text style={styles.exBack}>‹ Details</Text>
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={styles.exBody}>
          <Text style={styles.exTitle}>{title}</Text>
          {sub ? <Text style={styles.exSub}>{sub}</Text> : null}
          {lede ? <Text style={styles.exLede}>{lede}</Text> : null}
          {children}
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

/**
 * The strip on the picture's bottom edge: the maker on the left, stamps on
 * the right, over a gradient so it belongs to the frame. Stamps are states
 * of the file, never vendors, and a file with no seal has no strip.
 */
export function SealStrip({ maker, stamps, edge = 'bottom' }: { maker: string; stamps: { label: string; tone: Tone }[]; /** Top for media whose player controls own the bottom edge. */ edge?: 'top' | 'bottom' }) {
  const styles = useThemedStyles(buildStyles);
  return (
    <View style={[styles.strip, edge === 'top' ? styles.stripTop : styles.stripBottom]} pointerEvents="none">
      <LinearGradient colors={edge === 'top' ? ['rgba(0,0,0,0.78)', 'rgba(0,0,0,0)'] : ['rgba(0,0,0,0)', 'rgba(0,0,0,0.78)']} style={StyleSheet.absoluteFill} />
      {/* One line, always. The maker gives way first; the stamps never wrap. */}
      <Text style={styles.stripMaker} numberOfLines={1} ellipsizeMode="tail">{maker.toUpperCase()}</Text>
      <Text style={styles.stripStamps} numberOfLines={1}>
        {stamps.map((s, i) => (
          <Text key={s.label} style={s.tone === 'broken' ? styles.stampBad : styles.stampOk}>
            {i > 0 ? '   ' : ''}{s.tone === 'broken' ? '✕ ' : ''}{s.label.toUpperCase()}
          </Text>
        ))}
      </Text>
    </View>
  );
}

/** A hairline between rows inside a section body. */
export function Rule() {
  const styles = useThemedStyles(buildStyles);
  return <View style={styles.rule} />;
}

const buildStyles = () =>
  StyleSheet.create({
    fact: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md, paddingVertical: 5 },
    factLabel: { color: colors.textDim, fontSize: fontSize.sm, flexShrink: 0 },
    factRight: { flex: 1, alignItems: 'flex-end' },
    factValue: { color: colors.text, fontSize: fontSize.sm, textAlign: 'right' },
    factMono: { fontFamily: type.mono, fontSize: fontSize.xs, lineHeight: 17 },
    factBy: { color: colors.textFaint, fontSize: fontSize.xs, textAlign: 'right', marginTop: 1 },

    sceneRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm + 2, paddingVertical: spacing.sm + 1 },
    sceneIcon: {
      width: 34,
      height: 34,
      borderRadius: radii.sm - 2,
      backgroundColor: colors.accentSoft,
      alignItems: 'center',
      justifyContent: 'center',
    },
    sceneLabel: { flex: 1, color: colors.text, fontSize: fontSize.sm, lineHeight: 19 },
    sceneBody: { paddingBottom: spacing.sm, gap: spacing.sm },


    rule: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border, marginVertical: 2 },

    strip: {
      position: 'absolute',
      left: 0,
      right: 0,
      height: 42,
      flexDirection: 'row',
      justifyContent: 'space-between',
      gap: spacing.sm + 2,
      paddingHorizontal: spacing.sm + 2,
    },
    stripBottom: { bottom: 0, alignItems: 'flex-end', paddingBottom: spacing.sm },
    stripTop: { top: 0, alignItems: 'flex-start', paddingTop: spacing.sm },
    stripMaker: { color: '#FFFFFF', fontFamily: type.mono, fontSize: 9.5, letterSpacing: 0.4, fontWeight: '600', flexShrink: 1 },
    stripStamps: { fontFamily: type.mono, fontSize: 9.5, letterSpacing: 0.4, fontWeight: '600', flexShrink: 0 },
    stampOk: { color: '#7ED6A4' },
    stampBad: { color: colors.danger },

    exScreen: { flex: 1, backgroundColor: colors.bg },
    // A page sheet has no status bar above it, so the back control sits
    // lower than a full screen's would, to keep the same distance from the edge.
    exBar: { paddingHorizontal: spacing.md, paddingTop: spacing.md + 4, paddingBottom: spacing.sm + 2 },
    exBack: { color: colors.accent, fontSize: fontSize.md, fontWeight: '500' },
    exBody: { paddingHorizontal: spacing.md, paddingBottom: spacing.xxl, gap: spacing.sm },
    exTitle: { color: colors.text, fontSize: 26, fontWeight: '700', letterSpacing: -0.4 },
    exSub: { color: colors.textFaint, fontSize: fontSize.xs, fontWeight: '600', marginTop: -2 },
    exLede: { color: colors.textDim, fontSize: fontSize.sm, lineHeight: 20, marginBottom: spacing.sm },

  });

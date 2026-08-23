// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Shared UI primitives — the "darkroom paper" kit.
 */

import React from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  ViewStyle,
  TextStyle,
  StyleProp,
  Switch,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, spacing, radii, type, fontSize, useThemedStyles, useEffectiveScheme } from '../theme';

export function ScreenTitle({ title, subtitle, tag }: { title: string; subtitle?: string; tag?: string }) {
  const styles = useThemedStyles(buildStyles);
  return (
    <View style={styles.titleBlock}>
      <View style={styles.titleRow}>
        <Text style={styles.title}>{title}</Text>
        {tag ? <Text style={styles.titleTag}>{tag}</Text> : null}
      </View>
      {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
    </View>
  );
}

export function Card({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  const styles = useThemedStyles(buildStyles);
  return <View style={[styles.card, style]}>{children}</View>;
}

export function SectionLabel({ text }: { text: string }) {
  const styles = useThemedStyles(buildStyles);
  return <Text style={styles.sectionLabel}>{text}</Text>;
}

export function Mono({ children, size = 'sm', color = colors.textDim, style }: {
  children: string;
  size?: keyof typeof fontSize;
  color?: string;
  style?: StyleProp<TextStyle>;
}) {
  useEffectiveScheme(); // re-render on palette flip; this component reads colors.* inline
  return (
    <Text
      selectable
      style={[{ fontFamily: type.mono, fontSize: fontSize[size], color, letterSpacing: 0.2 }, style]}
    >
      {children}
    </Text>
  );
}

export function Chip({ label, tone = 'neutral', icon }: {
  label: string;
  tone?: 'good' | 'warn' | 'bad' | 'info' | 'neutral';
  icon?: keyof typeof Ionicons.glyphMap;
}) {
  const styles = useThemedStyles(buildStyles);
  const map = {
    good: { fg: colors.accent, bg: colors.accentSoft },
    warn: { fg: colors.warn, bg: colors.warnSoft },
    bad: { fg: colors.danger, bg: colors.dangerSoft },
    info: { fg: colors.info, bg: colors.infoSoft },
    neutral: { fg: colors.textDim, bg: colors.surface2 },
  } as const;
  const t = map[tone];
  return (
    <View style={[styles.chip, { backgroundColor: t.bg }]}>
      {icon ? <Ionicons name={icon} size={12} color={t.fg} style={{ marginRight: 5 }} /> : null}
      <Text style={[styles.chipText, { color: t.fg }]}>{label}</Text>
    </View>
  );
}

export function Button({ label, onPress, tone = 'primary', icon, disabled, loading, small }: {
  label: string;
  onPress: () => void;
  tone?: 'primary' | 'secondary' | 'danger' | 'ghost';
  icon?: keyof typeof Ionicons.glyphMap;
  disabled?: boolean;
  loading?: boolean;
  small?: boolean;
}) {
  const styles = useThemedStyles(buildStyles);
  // Primary is the scheme's ink fill with the scheme's canvas as the label,
  // both from tokens: a hard-coded label goes black-on-black in one scheme.
  // Ghost is a hairline outline, danger a translucent red one. No gradients.
  const stylesByTone = {
    primary: { bg: colors.text, fg: colors.bg, border: 'transparent' },
    secondary: { bg: colors.surface2, fg: colors.text, border: 'transparent' },
    danger: { bg: 'transparent', fg: colors.danger, border: 'rgba(229,72,77,0.4)' },
    ghost: { bg: 'transparent', fg: colors.textDim, border: colors.border },
  } as const;
  const t = stylesByTone[tone];
  const isDisabled = disabled || loading;
  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={isDisabled}
      activeOpacity={0.75}
      style={[
        styles.button,
        small && styles.buttonSmall,
        { backgroundColor: t.bg, borderColor: t.border, opacity: isDisabled ? 0.45 : 1 },
      ]}
    >
      {loading ? (
        <ActivityIndicator color={t.fg} size="small" />
      ) : (
        <>
          {icon ? <Ionicons name={icon} size={small ? 15 : 17} color={t.fg} style={{ marginRight: 7 }} /> : null}
          <Text style={[styles.buttonText, small && styles.buttonTextSmall, { color: t.fg }]}>{label}</Text>
        </>
      )}
    </TouchableOpacity>
  );
}

export function ToggleRow({ label, detail, value, onChange }: {
  label: string;
  detail?: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  const styles = useThemedStyles(buildStyles);
  return (
    <View style={styles.toggleRow}>
      <View style={{ flex: 1, paddingRight: spacing.md }}>
        <Text style={styles.toggleLabel}>{label}</Text>
        {detail ? <Text style={styles.toggleDetail}>{detail}</Text> : null}
      </View>
      <Switch
        value={value}
        onValueChange={onChange}
        trackColor={{ false: colors.surface2, true: colors.accent }}
        thumbColor="#FFFFFF"
        ios_backgroundColor={colors.surface2}
      />
    </View>
  );
}

export function KeyValueRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  const styles = useThemedStyles(buildStyles);
  return (
    <View style={styles.kvRow}>
      <Text style={styles.kvLabel}>{label}</Text>
      {mono ? (
        // Wrapper constrains width (kvValue does not apply to Mono), so long
        // values like registry URLs wrap instead of overrunning the card.
        <View style={styles.kvValueWrap}>
          <Mono size="sm" color={colors.text} style={{ textAlign: 'right' }}>{value}</Mono>
        </View>
      ) : (
        <Text style={styles.kvValue} selectable>{value}</Text>
      )}
    </View>
  );
}

export function Divider() {
  const styles = useThemedStyles(buildStyles);
  return <View style={styles.divider} />;
}

export function EmptyState({ icon, title, body }: {
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  body: string;
}) {
  const styles = useThemedStyles(buildStyles);
  return (
    <View style={styles.empty}>
      <Ionicons name={icon} size={40} color={colors.textFaint} />
      <Text style={styles.emptyTitle}>{title}</Text>
      <Text style={styles.emptyBody}>{body}</Text>
    </View>
  );
}

const buildStyles = () => StyleSheet.create({
  titleBlock: { marginBottom: spacing.lg },
  titleRow: { flexDirection: 'row', alignItems: 'baseline', gap: spacing.sm },
  title: { color: colors.text, fontSize: fontSize.hero, fontWeight: '700', letterSpacing: -1.0, fontFamily: type.display },
  titleTag: { color: colors.textDim, fontSize: fontSize.xs, fontWeight: '600' },
  subtitle: { color: colors.textDim, fontSize: fontSize.md, marginTop: spacing.xs, lineHeight: 21 },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    marginBottom: 10,
  },
  sectionLabel: {
    color: colors.textFaint,
    fontSize: 10.5,
    fontWeight: '800',
    letterSpacing: 1.9,
    textTransform: 'uppercase',
    marginBottom: spacing.sm,
    marginTop: spacing.md,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: radii.full,
    paddingHorizontal: 10,
    paddingVertical: 5,
    alignSelf: 'flex-start',
  },
  chipText: { fontSize: fontSize.xs, fontWeight: '600', letterSpacing: 0.2 },
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.sm,
    borderWidth: 1,
    paddingVertical: 12,
    paddingHorizontal: spacing.md,
  },
  buttonSmall: { paddingVertical: 8, paddingHorizontal: 12 },
  buttonText: { fontSize: fontSize.sm, fontWeight: '700', letterSpacing: 0.1 },
  buttonTextSmall: { fontSize: fontSize.xs },
  toggleRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: spacing.sm + 2 },
  toggleLabel: { color: colors.text, fontSize: fontSize.md, fontWeight: '500' },
  toggleDetail: { color: colors.textFaint, fontSize: fontSize.sm, marginTop: 2, lineHeight: 18 },
  kvRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    paddingVertical: 7,
    gap: spacing.md,
  },
  kvLabel: { color: colors.textFaint, fontSize: fontSize.sm, width: 110 },
  kvValue: { color: colors.text, fontSize: fontSize.sm, flex: 1, textAlign: 'right' },
  kvValueWrap: { flex: 1, alignItems: 'flex-end' },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border, marginVertical: spacing.sm },
  empty: { alignItems: 'center', paddingVertical: spacing.xxl, paddingHorizontal: spacing.lg },
  emptyTitle: { color: colors.text, fontSize: fontSize.lg, fontWeight: '600', marginTop: spacing.md },
  emptyBody: { color: colors.textDim, fontSize: fontSize.sm, textAlign: 'center', marginTop: spacing.xs, lineHeight: 20 },
});

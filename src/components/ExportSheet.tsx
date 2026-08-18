// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * ExportSheet — two cards up front, plain words:
 *
 *   Share without identifying details  TOP + DEFAULT. A re-sealed copy with
 *                                      name, organization and location redacted.
 *   Share original                     The file exactly as sealed.
 *
 * Everything else — proof without the media, per-field disclosure — sits
 * under "More ways to share". The encrypted desk handoff, when configured,
 * renders below — visibly NOT one of the share options.
 *
 * Same bottom-sheet pattern: Modal + scrim + grabber, Animated slide-in.
 */

import React, { useEffect, useRef, useState } from 'react';
import { Animated, Dimensions, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, spacing, radii, fontSize, useThemedStyles, useEffectiveScheme } from '../theme';

const SHEET_MAX = Dimensions.get('window').height * 0.52;

export type ExportOption = 'basic' | 'full' | 'proof-only' | 'custom';

/** Identifying facets genuinely embedded in the signed record (chips). */
export interface ExportPii {
  location: boolean;
  name: boolean;
  sensors: boolean;
  transcript: boolean;
  wifi: boolean;
  org: boolean;
  face: boolean;
}


export function ExportSheet({ visible, name, kind, pii, deskNewsroom, onBasic, onFull, onProofOnly, onCustom, onDesk, onCancel }: {
  visible: boolean;
  /** Display name quoted in the title. */
  name: string;
  kind: 'photo' | 'video' | 'audio';
  pii: ExportPii;
  /** When a desk key is configured, the encrypted handoff renders below the share options. */
  deskNewsroom?: string | null;
  /** Share without identifying details — de-identified, re-sealed copy. */
  onBasic: (format: 'jpeg' | 'png') => void;
  /** Share original — the file exactly as sealed. */
  onFull: () => void;
  /** Proof without the media — the JSON proof bundle. */
  onProofOnly: () => void;
  /** Choose what to open — the per-field disclosure toggles. */
  onCustom: () => void;
  onDesk?: () => void;
  onCancel: () => void;
}) {
  const styles = useThemedStyles(buildStyles);
  const slide = useRef(new Animated.Value(1)).current; // 1 = parked below, 0 = shown
  // The private copy carries a format choice for photos — it opens the
  // segment and a Share button rather than firing on first tap.
  const [privateOpen, setPrivateOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [format, setFormat] = useState<'jpeg' | 'png'>('jpeg');

  useEffect(() => {
    if (visible) {
      setPrivateOpen(false);
      setMoreOpen(false);
      setFormat('jpeg');
      slide.setValue(1);
      Animated.timing(slide, { toValue: 0, duration: 240, useNativeDriver: true }).start();
    }
  }, [visible]);

  if (!visible) return null;

  const translateY = slide.interpolate({ inputRange: [0, 1], outputRange: [0, 900] });

  return (
    <Modal transparent visible animationType="none" onRequestClose={onCancel} statusBarTranslucent>
      <View style={styles.root}>
        <Pressable style={styles.scrim} onPress={onCancel} accessibilityLabel="Dismiss export sheet" />
        <Animated.View style={[styles.sheet, { transform: [{ translateY }] }]}>
          <View style={styles.grabber} />
          <Text style={styles.titleKicker}>Share</Text>
          <Text style={styles.title}>{name}</Text>

          <ScrollView style={{ maxHeight: SHEET_MAX }} showsVerticalScrollIndicator={false}>
            <Pressable
              style={styles.shareCard}
              onPress={() => (kind === 'photo' ? setPrivateOpen((o) => !o) : onBasic('jpeg'))}
              accessibilityRole="button"
            >
              <Ionicons name="shield-outline" size={20} color={colors.text} />
              <View style={{ flex: 1 }}>
                <Text style={styles.shareCardTitle}>Share without identifying details</Text>
                <Text style={styles.shareCardSub}>
                  A re-sealed copy with name, organization and location redacted.
                </Text>
              </View>
              <Ionicons name={kind === 'photo' ? (privateOpen ? 'chevron-up' : 'chevron-down') : 'chevron-forward'} size={15} color={colors.textFaint} />
            </Pressable>

            {/* The photo format choice belongs to the private copy: JPEG
                keeps the pixels; PNG re-encodes (which also drops EXIF). */}
            {privateOpen && kind === 'photo' ? (
              <View style={styles.privateBody}>
                <View style={styles.segment}>
                  {(['jpeg', 'png'] as const).map((f) => (
                    <Pressable
                      key={f}
                      style={[styles.segmentCell, format === f && styles.segmentCellActive]}
                      onPress={() => setFormat(f)}
                    >
                      <Text style={[styles.segmentText, format === f && styles.segmentTextActive]}>
                        {f.toUpperCase()}
                      </Text>
                    </Pressable>
                  ))}
                </View>
                <Text style={styles.segmentNote}>
                  {format === 'png'
                    ? 'PNG re-encodes the pixels, dropping the JPEG’s EXIF.'
                    : 'Same pixels as the sealed photo.'}
                </Text>
                <Pressable style={styles.primaryButton} onPress={() => onBasic(format)}>
                  <Text style={styles.primaryLabel}>Share</Text>
                </Pressable>
              </View>
            ) : null}


            <Pressable style={styles.shareCard} onPress={onFull} accessibilityRole="button">
              <Ionicons name="document-outline" size={20} color={colors.text} />
              <View style={{ flex: 1 }}>
                <Text style={styles.shareCardTitle}>Share original</Text>
                <Text style={styles.shareCardSub}>The file exactly as sealed, with everything in it.</Text>
              </View>
              <Ionicons name="chevron-forward" size={15} color={colors.textFaint} />
            </Pressable>

            <Pressable style={styles.moreRow} onPress={() => setMoreOpen((o) => !o)} hitSlop={8}>
              <Text style={styles.moreText}>More ways to share</Text>
              <Ionicons name={moreOpen ? 'chevron-up' : 'chevron-forward'} size={14} color={colors.textDim} />
            </Pressable>
            {moreOpen ? (
              <>
                <Pressable style={styles.shareCard} onPress={onProofOnly} accessibilityRole="button">
                  <Ionicons name="finger-print-outline" size={20} color={colors.text} />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.shareCardTitle}>Proof without the media</Text>
                    <Text style={styles.shareCardSub}>Just the record and hashes, as a file. The photo never leaves.</Text>
                  </View>
                  <Ionicons name="chevron-forward" size={15} color={colors.textFaint} />
                </Pressable>
                <Pressable style={styles.shareCard} onPress={onCustom} accessibilityRole="button">
                  <Ionicons name="options-outline" size={20} color={colors.text} />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.shareCardTitle}>Choose what to open</Text>
                    <Text style={styles.shareCardSub}>Pick which details travel.</Text>
                  </View>
                  <Ionicons name="chevron-forward" size={15} color={colors.textFaint} />
                </Pressable>
              </>
            ) : null}
          </ScrollView>

          {/* The encrypted desk handoff is transport, not a share option —
              visibly separated, and only present when configured. */}
          {deskNewsroom && onDesk ? (
            <>
              <View style={styles.handoffRule} />
              <Pressable style={styles.handoffRow} onPress={onDesk}>
                <Ionicons name="lock-closed-outline" size={16} color={colors.text} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.handoffLabel}>Send to {deskNewsroom}</Text>
                  <Text style={styles.handoffDetail}>Encrypted to their key.</Text>
                </View>
                <Ionicons name="chevron-forward" size={14} color={colors.textFaint} />
              </Pressable>
            </>
          ) : null}

          <Pressable style={styles.cancelButton} onPress={onCancel} hitSlop={8}>
            <Text style={styles.cancelLabel}>Cancel</Text>
          </Pressable>
        </Animated.View>
      </View>
    </Modal>
  );
}

const buildStyles = () => StyleSheet.create({
  root: { flex: 1, justifyContent: 'flex-end' },
  scrim: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.45)' },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radii.lg + 4,
    borderTopRightRadius: radii.lg + 4,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.xl + spacing.md,
  },
  grabber: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.border,
    marginBottom: spacing.md,
  },
  titleKicker: {
    color: colors.textFaint,
    fontSize: 10.5,
    fontWeight: '800',
    letterSpacing: 1.9,
    textTransform: 'uppercase',
    textAlign: 'center',
  },
  title: {
    color: colors.text,
    fontSize: fontSize.lg,
    fontWeight: '700',
    textAlign: 'center',
    lineHeight: 23,
    marginTop: 3,
    marginBottom: spacing.lg,
  },
  shareCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm + 2,
    backgroundColor: colors.surface2,
    borderRadius: radii.md,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  shareCardTitle: { color: colors.text, fontSize: fontSize.sm, fontWeight: '700' },
  shareCardSub: { color: colors.textDim, fontSize: fontSize.xs, lineHeight: 16, marginTop: 2 },
  moreRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingVertical: spacing.sm,
    marginBottom: spacing.xs,
  },
  moreText: { color: colors.textDim, fontSize: fontSize.sm, fontWeight: '600' },
  privateBody: { marginBottom: spacing.sm },
  segment: {
    flexDirection: 'row',
    backgroundColor: colors.surface2,
    borderRadius: radii.sm,
    padding: 3,
    marginTop: spacing.sm,
  },
  segmentCell: { flex: 1, alignItems: 'center', paddingVertical: 8, borderRadius: radii.sm - 2 },
  segmentCellActive: { backgroundColor: colors.surface },
  segmentText: { color: colors.textDim, fontSize: fontSize.sm, fontWeight: '600', letterSpacing: 0.4 },
  segmentTextActive: { color: colors.text },
  segmentNote: { color: colors.textFaint, fontSize: fontSize.xs, lineHeight: 16, marginTop: spacing.xs, textAlign: 'center' },
  primaryButton: {
    backgroundColor: colors.accent,
    borderRadius: radii.md,
    paddingVertical: 14,
    paddingHorizontal: spacing.md,
    alignItems: 'center',
    marginTop: spacing.lg,
  },
  primaryLabel: { color: colors.onAccent, fontSize: fontSize.md, fontWeight: '700' },
  handoffRule: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border, marginTop: spacing.lg },
  handoffRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.md,
  },
  handoffLabel: { color: colors.text, fontSize: fontSize.sm, fontWeight: '700' },
  handoffDetail: { color: colors.textFaint, fontSize: fontSize.xs, lineHeight: 16, marginTop: 2 },
  cancelButton: { alignItems: 'center', paddingVertical: spacing.md },
  cancelLabel: { color: colors.textDim, fontSize: fontSize.md, fontWeight: '600' },
});

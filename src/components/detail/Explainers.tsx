// Source Kit 0.1.0 — the figures the detail sheets carry
// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * The three figures the detail sheets carry, and the one sentence each
 * needs. They used to be screens of their own behind "Learn" rows; now the
 * sheet a reader opens for a question is where the mechanism is drawn, so
 * the explanation sits beside the facts it explains.
 *
 * Each is a picture and the fewest words that make the picture legible. No
 * numbered lists, no bullets.
 */

import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { colors, spacing, fontSize, radii, useThemedStyles } from '../../theme';

export const SEAL_LEDE_RECORD =
  'At the shutter the frame was hashed and signed by a key in this phone’s Secure Enclave. The bytes you have are the bytes that were signed.';
export const SEAL_LEDE_FOREIGN =
  'The signer hashed the file and signed the hash with its certificate. This device checked that signature over the bytes it has.';
export const SEAL_LEDE_ALTERED =
  'The seal is genuine. The bytes in this file are not the bytes that were signed. Everything below describes the original, not this copy.';
export const SEAL_LEDE_NONE =
  'There is no manifest in this file. Anything its metadata says about a camera is something anything can write.';
export const TIME_LEDE =
  'A phone’s clock can be set to anything. Source Kit seals the official time from a timestamping authority, and puts a hash of the capture into the Bitcoin ledger.';
export const PLACE_LEDE = 'GPS claims remain easily spoofable. Inspect claim accuracy using forensic checks.';
export const IDENTITY_LEDE = 'Every name on a capture comes from a credential the signer holds. Nothing typed reaches a file.';

/* ---------------------------------------------------------------------------
   1. Where the signature happens
   ------------------------------------------------------------------------ */

/**
 * Four columns, because two makers that used to share one do not sign at
 * the same place. A sensor that signs its own readout puts no code between
 * the light and the signature. Camera firmware signs a finished file before
 * any general-purpose operating system sees it. An app on a phone's main
 * processor signs whatever the operating system's pipeline hands it, which
 * is where both the Pixel 10 and Source Kit sit; what separates them is
 * what the silicon attests, and that is said under each name rather than
 * in a column. Export software signs on save.
 *
 * Where the key lives is a different question from where the bytes are
 * signed, so it is a caption, not a column. Default phone cameras produce
 * no seal at all, and three hollow rings state that completely.
 */
const STAGES = ['Sensor', 'Camera\nfirmware', 'Main\nprocessor', 'Export\nsoftware'] as const;

const MAKERS: { name: string; sub: string; key?: string; at: number | null; note?: string; me?: boolean }[] = [
  {
    name: 'iPhone 18 Pro, Reference mode',
    sub: 'The main camera’s sensor signs its own readout. Developed on Apple’s servers, stills only',
    key: 'in the sensor',
    at: 0,
  },
  { name: 'Dedicated cameras', sub: 'Leica and others, since 2023. Firmware signs the finished file', key: 'in a secure chip', at: 1 },
  {
    name: 'Pixel 10',
    sub: 'Pixel Camera signs the merged frame. Android attests the OS and the app, and the chip signs the time',
    key: 'in the Titan M2',
    at: 2,
  },
  {
    name: 'Source Kit',
    sub: 'Signs the frame iOS hands it. Apple attests the app and the key',
    key: 'in the Secure Enclave',
    at: 2,
    note: 'The ceiling for any third-party iOS app',
    me: true,
  },
  { name: 'Content Credentials software', sub: 'Photoshop and others. Signs on export, whatever the file was before', key: 'in software', at: 3 },
  { name: 'Default smartphone cameras', sub: 'Only metadata, which anything can rewrite or strip', at: null },
];

export function SealChart() {
  const styles = useThemedStyles(buildStyles);
  return (
    <View>
      <Text style={styles.figLabel}>Where the signature happens</Text>
      <View style={styles.chainHead}>
        <View style={styles.chainName} />
        {STAGES.map((label) => (
          <Text key={label} style={styles.chainCol}>{label}</Text>
        ))}
      </View>
      {MAKERS.map((m) => (
        <View key={m.name} style={[styles.chainRow, m.me && styles.chainRowMe]}>
          <View style={styles.chainName}>
            <Text style={styles.chainMaker}>{m.name}</Text>
            <Text style={styles.chainSub}>{m.sub}</Text>
            {m.key ? (
              <Text style={styles.chainKey}>
                Key <Text style={styles.chainKeyStrong}>{m.key}</Text>
              </Text>
            ) : null}
            {m.note ? <Text style={styles.chainNote}>{m.note}</Text> : null}
          </View>
          {STAGES.map((_, col) => (
            <View key={col} style={styles.chainCell}>
              <View style={m.at === col ? styles.dotOn : styles.dotOff} />
            </View>
          ))}
        </View>
      ))}
      <Text style={styles.chainLegend}>
        Further left, less code between the light and the signature. Where the key lives is a
        separate question, answered under each name.
      </Text>
    </View>
  );
}

/* ---------------------------------------------------------------------------
   2. The GPS claim and the checks that can be run on it
   ------------------------------------------------------------------------ */

const PLACE_CHECKS: { name: string; sub: string }[] = [
  { name: 'Compass', sub: 'vs expected\nmagnetic field' },
  { name: 'Barometer', sub: 'vs reported\nweather' },
  { name: 'Level', sub: 'vs perceived\nhorizon' },
];

export function PlaceFigure() {
  const styles = useThemedStyles(buildStyles);
  return (
    <View style={styles.placeFig}>
      <View style={styles.claimCard}>
        <View style={styles.claimDot} />
        <Text style={styles.claimLabel}>GPS claim</Text>
      </View>
      <View style={styles.dropFromClaim} />
      <View style={styles.bracketRow}>
        {PLACE_CHECKS.map((c, i) => (
          <View key={c.name} style={styles.bracketCol}>
            <View style={styles.bracketTop}>
              <View style={[styles.bracketHalf, i === 0 && styles.bracketHalfOff]} />
              <View style={[styles.bracketHalf, i === PLACE_CHECKS.length - 1 && styles.bracketHalfOff]} />
            </View>
            <View style={styles.bracketDrop} />
            <Text style={styles.checkName}>{c.name}</Text>
            <Text style={styles.checkSub}>{c.sub}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

/* ---------------------------------------------------------------------------
   3. The window a capture happened inside
   ------------------------------------------------------------------------ */

/**
 * Two Bitcoin blocks appear on this line, pointing opposite ways, and that
 * is the whole reason the figure exists.
 *
 * The first was already mined when the shutter fired, and its hash is sealed
 * inside the record. A block hash cannot be known before the block exists,
 * so the capture came after it. The second is a later block carrying a hash
 * of the capture, submitted afterwards, so the capture came before it.
 */
const TIME_MARKS: { name: string; sub: string; capture?: boolean }[] = [
  { name: 'block', sub: 'already mined,\nsealed into the file' },
  { name: 'Capture', sub: 'the phone’s clock', capture: true },
  { name: 'authority', sub: 'countersigns' },
  { name: 'block', sub: 'carries the hash,\nhours later' },
];

export function TimeFigure() {
  const styles = useThemedStyles(buildStyles);
  return (
    <View>
      {/* Two rows, not four columns: the labels sit in one row and the
          rail in another, so the rail is one straight line whatever the
          labels' heights, and each mark is still under its own label. */}
      <View style={styles.timeFig}>
        <View style={styles.timeHeads}>
          {TIME_MARKS.map((m, i) => (
            <View key={`${m.name}-${i}`} style={styles.timeHead}>
              <Text style={styles.markName}>{m.name}</Text>
              <Text style={styles.markSub}>{m.sub}</Text>
            </View>
          ))}
        </View>
        <View style={styles.timeRails}>
          {TIME_MARKS.map((m, i) => (
            <View key={`${m.name}-${i}`} style={styles.railRow}>
              <View style={[styles.rail, i > 0 && styles.railLit]} />
              {m.capture ? <View style={styles.captureRing} /> : <View style={styles.tick} />}
              <View style={[styles.rail, i < TIME_MARKS.length - 1 && styles.railLit]} />
            </View>
          ))}
        </View>
      </View>
      <Text style={styles.windowNote}>The capture happened inside this window</Text>
    </View>
  );
}

const COL_W = 46;

const buildStyles = () =>
  StyleSheet.create({
    figLabel: {
      color: colors.textFaint,
      fontSize: 10.5,
      fontWeight: '700',
      letterSpacing: 0.9,
      textTransform: 'uppercase',
      marginTop: spacing.sm,
    },
    chainHead: {
      flexDirection: 'row',
      alignItems: 'flex-end',
      paddingBottom: spacing.sm,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
      marginTop: spacing.xs,
    },
    chainCol: { width: COL_W, textAlign: 'center', color: colors.textDim, fontSize: 10, fontWeight: '700', lineHeight: 12.5 },
    chainRow: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: spacing.sm + 4,
      paddingHorizontal: spacing.xs,
      marginHorizontal: -spacing.xs,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
    },
    chainRowMe: { backgroundColor: colors.accentSoft, borderRadius: radii.sm, borderBottomWidth: 0 },
    chainName: { flex: 1, paddingRight: spacing.sm },
    chainMaker: { color: colors.text, fontSize: fontSize.sm, fontWeight: '700', lineHeight: 18 },
    chainSub: { color: colors.textDim, fontSize: fontSize.xs, lineHeight: 16, marginTop: 2 },
    chainKey: { color: colors.textFaint, fontSize: fontSize.xs, lineHeight: 16, marginTop: 3 },
    chainKeyStrong: { color: colors.textDim, fontWeight: '600' },
    chainNote: { color: colors.accent, fontSize: fontSize.xs, fontWeight: '700', lineHeight: 16, marginTop: 4 },
    chainLegend: { color: colors.textFaint, fontSize: fontSize.xs, lineHeight: 16, marginTop: spacing.sm + 2 },
    chainCell: { width: COL_W, alignItems: 'center' },
    dotOn: { width: 12, height: 12, borderRadius: 6, backgroundColor: colors.accent },
    dotOff: { width: 12, height: 12, borderRadius: 6, borderWidth: 1.5, borderColor: colors.textFaint },

    placeFig: { marginTop: spacing.sm, alignItems: 'stretch' },
    claimCard: {
      alignSelf: 'center',
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      backgroundColor: colors.surface2,
      borderRadius: radii.full,
      paddingVertical: spacing.sm + 2,
      paddingHorizontal: spacing.md,
    },
    claimDot: { width: 11, height: 11, borderRadius: 6, backgroundColor: colors.warn },
    claimLabel: { color: colors.text, fontSize: fontSize.sm, fontWeight: '700' },
    dropFromClaim: { alignSelf: 'center', width: 1, height: 20, backgroundColor: colors.border },
    bracketRow: { flexDirection: 'row', alignItems: 'flex-start' },
    bracketCol: { flex: 1, alignItems: 'center' },
    bracketTop: { flexDirection: 'row', width: '100%', height: 1 },
    bracketHalf: { flex: 1, height: 1, backgroundColor: colors.border },
    bracketHalfOff: { backgroundColor: 'transparent' },
    bracketDrop: { width: 1, height: 16, backgroundColor: colors.border },
    checkName: { color: colors.text, fontSize: 11.5, fontWeight: '600', textAlign: 'center', marginTop: spacing.sm },
    checkSub: { color: colors.textFaint, fontSize: 10, lineHeight: 13, textAlign: 'center', marginTop: 2 },

    timeFig: { marginTop: spacing.sm },
    timeHeads: { flexDirection: 'row', alignItems: 'flex-end' },
    timeHead: { flex: 1, justifyContent: 'flex-end', paddingHorizontal: 2 },
    timeRails: { flexDirection: 'row', alignItems: 'center', height: 24, marginTop: spacing.sm },
    markName: { color: colors.text, fontSize: 11, fontWeight: '600', textAlign: 'center' },
    markSub: { color: colors.textFaint, fontSize: 9.5, lineHeight: 12.5, textAlign: 'center', marginTop: 1 },
    railRow: { flex: 1, flexDirection: 'row', alignItems: 'center' },
    rail: { flex: 1, height: 2, backgroundColor: colors.border },
    railLit: { backgroundColor: colors.accentSoft },
    tick: { width: 2.5, height: 22, backgroundColor: colors.accent },
    captureRing: { width: 15, height: 15, borderRadius: 8, borderWidth: 2.5, borderColor: colors.warn, backgroundColor: colors.bg },
    windowNote: { color: colors.text, fontSize: 11.5, fontWeight: '600', textAlign: 'center', marginTop: spacing.md },
  });

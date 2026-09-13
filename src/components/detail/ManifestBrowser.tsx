// Source Kit 0.1.0 — every field the manifest holds, grouped
// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Everything in the manifest — every field the record can hold, grouped, with
 * the ones this file leaves out available behind a toggle.
 *
 * Two things this exists to do that a list of populated fields cannot:
 *
 *   1. Show a reader what a record COULD carry. A field absent from every
 *      other screen is indistinguishable from a field that does not exist,
 *      and "this file has no barometer reading" is itself information.
 *
 *   2. Reach the raw manifest without leaving the screen's language. The
 *      full JSON pushes over the top, uncapped, exactly as parsed — the
 *      shared ManifestReel, so both detail screens show one thing.
 *
 * A sheet now, opened from the label's footer and from the seal sheet.
 *
 * Absence is stated, never inferred. A field this build does not populate
 * reads as a dash, not as zero and not as a warning.
 */

import React, { useMemo, useState } from 'react';
import { View, Text, Modal, Pressable, ScrollView, StyleSheet, SafeAreaView } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, spacing, fontSize, radii, useThemedStyles } from '../../theme';
import { Fact, ExplainerScreen, DEVICE_REPORTED } from './DetailKit';
import { declinationLine } from '../Juxtapose';
import { ManifestReel } from '../ManifestReel';
import type { AttestationRecord } from '../../provenance/manifest';
import type { C2paManifest } from '../../../archive/handrolled-verifier/c2pa';
import { readForeignManifest } from '../../reader/foreign';

type Row = [label: string, value: string | null, by?: string];
type Group = [name: string, rows: Row[]];

const dash = '—';

function num(n: number | null | undefined, unit = ''): string | null {
  return typeof n === 'number' && Number.isFinite(n) ? `${n}${unit}` : null;
}

/**
 * The upper end of the Bitcoin window, stated as one value.
 *
 * A receipt is either in a block or waiting for one; both are facts about
 * the same anchor, so both are one row.
 */
function otsUpper(record: AttestationRecord): string | null {
  const ots = record.ots;
  if (!ots) return null;
  const n = ots.submissions.length;
  return ots.submissions.some((x) => x.state === 'confirmed')
    ? 'Confirmed in a block'
    : `Submitted to ${n} calendar${n === 1 ? '' : 's'}, awaiting a block`;
}

/**
 * The catalog. Every group names fields this record format defines, whether
 * or not this particular record carries them — which is what makes the
 * "fields this file does not carry" toggle meaningful rather than decorative.
 */
/**
 * The catalog for a file another signer sealed. There is no record, so the
 * manifest is read directly: the claim, the certificate, the declared
 * actions and metadata, the ingredients. Same grouping discipline — every
 * group names fields a manifest can hold, so absence stays visible.
 */
function foreignCatalog(manifest: C2paManifest): Group[] {
  const f = readForeignManifest(manifest);
  const c = f.signer;
  const day = (iso: string | null) => (iso ? iso.slice(0, 10) : null);
  const exifRows: Row[] = manifest.exif?.data
    ? Object.entries(manifest.exif.data)
        .filter(([, v]) => v != null && v !== '')
        .map(([k, v]) => [k, String(v)] as Row)
    : [];
  return [
    ['Asset', [
      ['Signed digest', f.signedDigestHex, 'The bytes the signature covers'],
      ['Declared type', f.assetTypes.length > 0 ? f.assetTypes.join(', ') : null],
      ['Manifests in store', String(f.manifestCount), f.manifestCount > 1 ? 'Only the active one is checked' : undefined],
    ]],
    ['Claim', [
      ['Generator', f.generator, 'Self-declared'],
      ['Claim version', f.claimVersion === 2 ? 'c2pa.claim.v2' : 'c2pa.claim'],
      ['Manifest label', f.manifestLabel],
      ['Assertions', f.assertions.length > 0 ? `${f.assertions.length} referenced by the claim` : null],
    ]],
    ['Signing certificate', [
      ['Subject', c?.name ?? null],
      ['Organization', c?.org ?? null],
      ['Issuer', c?.issuer ?? c?.issuerOrg ?? null],
      ['Valid from', day(c?.validFromIso ?? null)],
      ['Valid until', day(c?.validUntilIso ?? null)],
      ['Chain length', c ? `${c.chainLength} certificate${c.chainLength === 1 ? '' : 's'}` : null, c?.chainLength === 1 ? 'Self-signed' : undefined],
    ]],
    ['Time anchors', [
      ['Declared creation', f.createdAt, DEVICE_REPORTED],
      ['Countersignatures', f.timestampTokens > 0 ? `${f.timestampTokens} timestamp token${f.timestampTokens === 1 ? '' : 's'}` : null],
    ]],
    ['Location', [
      ['Declared coordinates', f.location ? `${f.location.lat.toFixed(5)}, ${f.location.lon.toFixed(5)}` : null, DEVICE_REPORTED],
    ]],
    ...(f.assertions.length > 0
      ? ([['Assertions', f.assertions.map((label) => [label, 'Signed'] as Row)]] as Group[])
      : []),
    ...(f.ingredients.length > 0
      ? ([['Ingredients', f.ingredients.map((i, n) => [
          i.title ?? `Ingredient ${n + 1}`,
          [i.relationship, i.format].filter(Boolean).join(' · ') || 'Declared',
        ] as Row)]] as Group[])
      : []),
    ...(f.metadata.length > 0
      ? ([['Declared metadata', f.metadata.map(([k, v]) => [k, v] as Row)]] as Group[])
      : []),
    ...(f.trainingMining.length > 0
      ? ([['Training and mining', f.trainingMining.map(([use, stance]) => [use.replace(/^c2pa\./, ''), stance] as Row)]] as Group[])
      : []),
    ...(exifRows.length > 0 ? ([['Camera settings', exifRows]] as Group[]) : []),
  ];
}

function catalog(record: AttestationRecord | null, manifest: C2paManifest | null): Group[] {
  if (!record) return manifest ? foreignCatalog(manifest) : [];
  const ctx = record.context ?? ({} as AttestationRecord['context']);
  const loc = ctx.location && typeof ctx.location === 'object' ? ctx.location : null;
  const ident = record.identity === 'redacted' ? null : record.identity;
  const ev = ctx.captureEvidence ?? null;
  // Wi-Fi is a three-state claim: a reading, a stated redaction, or a
  // stated absence. Only the first has fields to read.
  const wifi = ctx.wifi && typeof ctx.wifi === 'object' ? ctx.wifi : null;
  const decl = ctx ? declinationLine(ctx, record.capturedAt ? new Date(record.capturedAt) : null) : null;

  // EXIF is the camera's own account of the exposure. It travels inside the
  // manifest and is signed with everything else, so it belongs in the
  // catalog rather than in a group of its own two screens away.
  const exif = manifest?.exif?.data ?? null;
  const exifRows: Row[] = exif
    ? Object.entries(exif)
        .filter(([, v]) => v != null && v !== '')
        .map(([k, v]) => [k, String(v)] as Row)
    : [];

  const sink = (path: unknown, digest?: string | null): string | null => {
    if (path === 'never-recorded') return 'Not collected';
    if (path === null) return 'Enabled, but failed';
    if (typeof path !== 'string' || !path) return null;
    return digest ? 'Collected, hash sealed' : 'Collected';
  };

  return [
    ['Asset', [
      ['Media SHA-256', record.asset.sha256, 'The exact bytes that were signed'],
      ['Bytes', record.asset.bytes.toLocaleString('en-US')],
      ['Type', record.asset.mime],
      ['Kind', record.asset.kind],
    ]],
    ['Capture', [
      ['Signed at', record.capturedAt, DEVICE_REPORTED],
      ['App', `${record.app.name} ${record.app.version}`],
      ['Device model', record.device.model, DEVICE_REPORTED],
      ['Platform', record.device.platform],
      ['Sealing engine', manifest ? (manifest.claimVersion === 2 ? 'c2pa-swift · claim v2' : 'Source Kit signer · claim v1') : null],
      ['Identity', ident?.author ?? (record.identity === 'redacted' ? 'Redacted by signer' : null)],
      ['Organization', ident?.organization ?? record.orgCredential?.subject ?? null],
    ]],
    ['Sensors', [
      ['Location', loc ? `${loc.lat.toFixed(5)}, ${loc.lon.toFixed(5)}` : null, DEVICE_REPORTED],
      ['Accuracy', loc ? num(loc.accuracyM, ' m') : null],
      ['GPS altitude', num(ctx.altitudeM, ' m')],
      ['Heading', num(ctx.headingDeg, '°')],
      // The one sensor row that carries its own check: the sealed compass
      // angle against what the world magnetic model expects at that place
      // and date. Computed here, not asserted by the device.
      ['Compass', decl ?? num(ctx.declinationDeg, '°'), decl ? 'Compared against the world magnetic model' : undefined],
      ['Barometer', num(ctx.pressureHPa, ' hPa')],
      ['Motion', ctx.motion ? ctx.motion.verdict : null],
      ['Pose trace', ctx.poseTrace ? `${ctx.poseTrace.samples} samples` : null],
      ['Sensor timing', record.captureIntegrity?.sensorTiming ? `${record.captureIntegrity.sensorTiming.samples} samples` : null],
      ['Wi-Fi SSID', wifi?.ssid ?? null],
      ['Wi-Fi BSSID', wifi?.bssid ?? null],
    ]],
    ['Evidence collected', [
      ['Raw audio master', sink(ev?.rawPcmPath, ev?.rawPcmSha256)],
      ['Motion log', sink(ev?.sensorLogPath, ev?.sensorLogSha256)],
      ['Shutter burst', sink(ev?.ringBufferDir, ev?.ringBufferSha256)],
      ['Second lens frame', record.stereo || record.videoStereo ? 'Collected' : null],
    ]],
    ['Signature', [
      ['Algorithm', `${record.signer.alg} · ${record.signer.curve}`],
      ['Key fingerprint', record.signer.fingerprint],
      ['Certificate chain', record.orgCredential ? `Chains to ${record.orgCredential.issuer ?? 'an organization CA'}` : 'Self-signed device certificate'],
      ['Post-quantum key', record.pqKey ? 'ML-DSA-65, committed in the signed payload' : null],
      ['Post-quantum signature', record.pqSignature ? 'Present' : null],

    ]],
    // One ledger, two ends, in time order — the same grammar the Timestamp
    // section states. Splitting the receipt into a submission count and a
    // state made a file with a beacon and no receipt read as having no
    // Bitcoin at all, two rows under a screen that had just named one.
    ['Time anchors', [
      ['Device clock', record.capturedAt, DEVICE_REPORTED],
      ['Bitcoin block before capture', record.beacon ? `Height ${record.beacon.blockHeight.toLocaleString('en-US')}` : null, record.beacon ? 'Mined before the shutter, sealed into the file' : undefined],
      ['Block observed', record.beacon ? record.beacon.observedAt : null, DEVICE_REPORTED],
      ['Bitcoin block after capture', otsUpper(record), record.ots ? 'The receipt puts this capture\u2019s hash in a later block' : undefined],
    ]],
    ...(exifRows.length > 0 ? ([['Camera settings', exifRows]] as Group[]) : []),
  ];
}

export function ManifestSheet({ record, manifest, visible, onClose }: {
  record: AttestationRecord | null;
  manifest: C2paManifest | null;
  visible: boolean;
  onClose: () => void;
}) {
  const styles = useThemedStyles(buildStyles);
  const [showAbsent, setShowAbsent] = useState(false);
  const [raw, setRaw] = useState(false);

  const groups = useMemo(() => catalog(record, manifest), [record, manifest]);
  const absentCount = useMemo(
    () => groups.reduce((n, [, rows]) => n + rows.filter(([, v]) => v == null).length, 0),
    [groups],
  );

  return (
    <>
      <ExplainerScreen
        visible={visible}
        title="Everything in the manifest"
        lede="Every field this record can hold, grouped. A field this file leaves out reads as absent, not as missing."
        onClose={onClose}
      >
        <View style={styles.body}>
          {groups.map(([name, rows]) => {
            const shown = rows.filter(([, v]) => (showAbsent ? true : v != null));
            if (shown.length === 0) return null;
            return (
              <View key={name} style={styles.group}>
                <Text style={styles.groupName}>{name}</Text>
                {shown.map(([label, value, by]) => (
                  <Fact
                    key={label}
                    label={label}
                    value={value ?? dash}
                    by={value == null ? 'Not in this file' : by}
                    mono={value != null && (label === 'Media SHA-256' || label === 'Key fingerprint' || label === 'Signed digest')}
                  />
                ))}
              </View>
            );
          })}

          <Pressable style={styles.toggle} onPress={() => setShowAbsent((v) => !v)} accessibilityRole="button">
            <Text style={styles.toggleText}>
              {showAbsent ? 'Hide fields this file does not carry' : 'Show fields this file does not carry'}
            </Text>
            <Text style={styles.toggleCount}>{absentCount}</Text>
          </Pressable>

          <Pressable style={styles.rawRow} onPress={() => setRaw(true)} accessibilityRole="button">
            <Text style={styles.rawLabel}>Raw manifest</Text>
            <Ionicons name="chevron-forward" size={14} color={colors.textFaint} />
          </Pressable>
        </View>
      </ExplainerScreen>

    </>
  );
}

const buildStyles = () =>
  StyleSheet.create({
    body: { backgroundColor: colors.surface, borderRadius: radii.md, paddingHorizontal: spacing.md - 2, paddingBottom: spacing.md - 2 },
    group: { gap: 1, paddingTop: spacing.xs },
    groupName: {
      color: colors.textFaint,
      fontSize: 10.5,
      fontWeight: '700',
      letterSpacing: 0.7,
      textTransform: 'uppercase',
      paddingTop: spacing.sm,
      paddingBottom: 2,
    },
    toggle: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: spacing.sm,
      backgroundColor: colors.surface2,
      borderRadius: radii.sm,
      paddingHorizontal: spacing.sm + 2,
      paddingVertical: spacing.sm + 1,
      marginTop: spacing.sm,
    },
    toggleText: { color: colors.textDim, fontSize: fontSize.sm, flex: 1 },
    toggleCount: { color: colors.textFaint, fontSize: fontSize.xs, fontWeight: '600' },
    rawRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingTop: spacing.sm + 2,
    },
    rawLabel: { color: colors.textDim, fontSize: fontSize.sm - 1, fontWeight: '600' },

    rawScreen: { flex: 1, backgroundColor: colors.bg },
    rawBar: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm + 2,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
    },
    rawBack: { color: colors.accent, fontSize: fontSize.md, fontWeight: '500', width: 90 },
    rawTitle: { flex: 1, color: colors.text, fontSize: fontSize.md, fontWeight: '600', textAlign: 'center' },
    rawSpacer: { width: 90 },
    rawBody: { padding: spacing.md, paddingBottom: spacing.xl },
    rawNone: { color: colors.textDim, fontSize: fontSize.sm, lineHeight: 20 },
  });

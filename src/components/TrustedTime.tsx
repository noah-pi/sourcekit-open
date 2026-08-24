// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * TrustedTime — the TIME section, shared by the Inspect result and the
 * exhibit detail screen. Copy v5 (0.17.0): icon rows, minimal words.
 *
 *   ● Certificate authority · Aug 12, 7:41 PM
 *   ○ Public ledger · pending
 *
 * Icons carry status, words carry facts. A countersignature renders as
 * "Certificate authority" exactly when the verifier pinned its operator;
 * a genuine token from an unpinned operator says so; a failed token is
 * named as failed (proven tamper, never absence of proof). The device
 * clock appears only when it disagrees with a countersigned anchor — or
 * when it is the only time there is.
 */

import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, spacing, fontSize, useThemedStyles } from '../theme';
import type { VerificationReport } from '../../archive/handrolled-verifier/verifyAsset';

/** Ledger-anchor state as far as the calling screen has checked it. */
export interface OtsView {
  state: 'pending' | 'confirmed' | 'invalid' | 'mismatch';
  height?: number;
  binding?: 'verified' | 'failed' | 'unchecked';
  queueDelayMs?: number;
}

/** Device clock vs countersigned time: agreement tolerance. */
const DEVICE_CLOCK_TOLERANCE_MS = 5 * 60 * 1000;

function fmtWhen(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

interface TimeRow {
  icon: keyof typeof Ionicons.glyphMap;
  text: string;
  color: string;
}

function ledgerRows(ots: OtsView): TimeRow[] {
  switch (ots.state) {
    case 'pending':
      return [{
        icon: 'ellipse-outline',
        color: colors.textDim,
        text:
          'Public ledger · pending' +
          (ots.queueDelayMs !== undefined && ots.queueDelayMs > 60_000
            ? ` · submitted ${Math.round(ots.queueDelayMs / 60_000)} min late, device was offline`
            : ''),
      }];
    case 'invalid':
      return [{ icon: 'close-circle', color: colors.danger, text: 'Public ledger · receipt failed' }];
    case 'mismatch':
      return [{ icon: 'close-circle', color: colors.danger, text: 'Public ledger · receipt commits to a different record' }];
    default:
      if (ots.binding === 'verified') {
        return [{ icon: 'ellipse', color: colors.accent, text: `Public ledger · block #${ots.height ?? '—'}` }];
      }
      if (ots.binding === 'failed') {
        return [{ icon: 'close-circle', color: colors.danger, text: `Public ledger · receipt does not match block #${ots.height ?? '—'}` }];
      }
      return [{
        icon: 'ellipse-outline',
        color: colors.textDim,
        text: ots.height
          ? `Public ledger · block #${ots.height} · not fetched on this device`
          : 'Public ledger · confirmed on-chain · block binding unchecked',
      }];
  }
}

export function TrustedTimeSection({ report, otsView }: { report: VerificationReport; otsView: OtsView | null }) {
  const styles = useThemedStyles(buildStyles);
  const ts = report.c2pa?.timestamps ?? null;
  const rec = report.record ?? null;

  const rows: TimeRow[] = [];
  if (ts) {
    if (ts.trusted > 0 && ts.earliestTrustedUtc) {
      rows.push({ icon: 'ellipse', color: colors.accent, text: `Countersigned · ${fmtWhen(ts.earliestTrustedUtc)}` });
    }
    const trustedLc = ts.trustedNames.map((n) => n.toLowerCase());
    for (const name of ts.tsaNames.filter((n) => !trustedLc.includes(n.toLowerCase()))) {
      rows.push({ icon: 'ellipse-outline', color: colors.textDim, text: `${name} · not a pinned authority` });
    }
    const failed = ts.present - ts.valid;
    if (failed > 0) {
      rows.push({
        icon: 'close-circle',
        color: colors.danger,
        text: `${failed} timestamp token${failed === 1 ? '' : 's'} failed`,
      });
    }
  }
  if (otsView) rows.push(...ledgerRows(otsView));

  // The device clock is a claim. It appears when it disagrees with a
  // countersigned anchor (amber — a wrong clock is possible without
  // tampering), or when it is the only time on the file.
  if (rec) {
    const capturedMs = Date.parse(rec.capturedAt);
    const anchorIso = ts?.earliestTrustedUtc ?? ts?.earliestValidUtc ?? null;
    const anchorMs = anchorIso ? Date.parse(anchorIso) : NaN;
    if (anchorIso && !isNaN(capturedMs) && !isNaN(anchorMs)) {
      if (Math.abs(capturedMs - anchorMs) > DEVICE_CLOCK_TOLERANCE_MS) {
        rows.push({
          icon: 'warning-outline',
          color: colors.warn,
          text: `Device clock said ${fmtWhen(rec.capturedAt)}; does not agree with the countersigned time`,
        });
      }
    } else if (rows.length === 0) {
      rows.push({
        icon: 'ellipse-outline',
        color: colors.textDim,
        text: `Device clock only · ${fmtWhen(rec.capturedAt)}`,
      });
    }
  }

  if (rows.length === 0) return null;

  return (
    <View style={styles.rows}>
      {rows.map((r, i) => (
        <View key={i} style={styles.row}>
          <Ionicons name={r.icon} size={r.icon.startsWith('ellipse') ? 9 : 14} color={r.color} style={r.icon.startsWith('ellipse') ? { marginTop: 5, marginHorizontal: 3 } : { marginTop: 1 }} />
          <Text style={[styles.rowText, { color: r.color }]}>{r.text}</Text>
        </View>
      ))}
    </View>
  );
}

const buildStyles = () => StyleSheet.create({
  rows: { gap: 8 },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  rowText: { fontSize: fontSize.sm, lineHeight: 19, flex: 1 },
});

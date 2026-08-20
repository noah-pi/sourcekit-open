/**
 * The Reader — RN surface widgets.
 *
 * These components render the engine's output (src/reader/*) in the Reader's
 * visual grammar:
 *
 *   - five states, five glyphs: ⬤ agrees · ⬥ diverges · ◐ insufficient ·
 *     ○ not run · — not applicable. Agreement renders DIM; divergence is the
 *     only saturated status on the page (the amber tick). No verdict color
 *     ever attaches to a check name.
 *   - the collapsed encoding of every measurement card is the UNIVERSAL GAP
 *     GAUGE: tolerance band shaded, measured value plotted as a tick, in the
 *     check's own units — a position, never a score. Expand for the
 *     prediction / measurement / gap / consistent-with rows (Glance → Read).
 *   - bespoke widgets (sun dial, dome, overlays) stay web-side: what the
 *     engine emits is rendered honestly in text rows here.
 *
 * Drawn with plain Views (no SVG dependency). Colors come from theme.ts, so
 * both schemes work — dark is the Reader palette, light is the app's.
 */

import React, { useState } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { colors, spacing, radii, fontSize, type, useThemedStyles, useEffectiveScheme } from '../theme';
import type { CheckState, EvidenceCard, RungResult, AgreementMatrix, Claim } from '../reader/types';

// ---------------------------------------------------------------------------
// The five states
// ---------------------------------------------------------------------------

export const STATE_GLYPH: Record<CheckState, string> = {
  agrees: '⬤',
  diverges: '⬥',
  insufficient: '◐',
  'not-run': '○',
  'not-applicable': '—',
};

export const STATE_WORD: Record<CheckState, string> = {
  agrees: 'agrees',
  diverges: 'diverges',
  insufficient: 'insufficient',
  'not-run': 'not run',
  'not-applicable': 'not applicable',
};

/** Agreement renders dim; divergence is the only saturated status. */
function stateColor(state: CheckState): string {
  switch (state) {
    case 'agrees': return colors.accent;
    case 'diverges': return colors.warn;
    case 'insufficient': return colors.textDim;
    default: return colors.textFaint; // not-run · not-applicable
  }
}

export function StateGlyph({ state, size = 13 }: { state: CheckState; size?: number }) {
  const styles = useThemedStyles(buildStyles);
  return (
    <Text style={[styles.glyph, { color: stateColor(state), fontSize: size, lineHeight: size + 3 }]}>
      {STATE_GLYPH[state]}
    </Text>
  );
}

// ---------------------------------------------------------------------------
// Section headers — the wireframe's .sec / .secnote
// ---------------------------------------------------------------------------

export function ReaderSection({ title, note, subnote }: { title: string; note?: string; subnote?: string }) {
  const styles = useThemedStyles(buildStyles);
  return (
    <View style={styles.sec}>
      <View style={styles.secHead}>
        <Text style={styles.secTitle}>{title}</Text>
        {note ? <Text style={styles.secNote}>{note}</Text> : null}
      </View>
      {subnote ? <Text style={styles.secSubnote}>{subnote}</Text> : null}
    </View>
  );
}

// ---------------------------------------------------------------------------
// The universal gap gauge — tolerance band + measured tick, own units
// ---------------------------------------------------------------------------

export function GapGauge({ gauge, state }: { gauge: NonNullable<EvidenceCard['gauge']>; state: CheckState }) {
  const styles = useThemedStyles(buildStyles);
  const [lo, hi] = gauge.band;
  const span = hi - lo;
  // Display range: the band plus symmetric padding, so a tick outside the
  // band is still plotted (clamped at the rail ends) — a position, stated.
  const pad = span * 0.6;
  const dmin = lo - pad;
  const dmax = hi + pad;
  const pct = (v: number): number => Math.min(99, Math.max(1, ((v - dmin) / (dmax - dmin)) * 100));
  const bandLeft = ((lo - dmin) / (dmax - dmin)) * 100;
  const bandWidth = (span / (dmax - dmin)) * 100;
  const tickColor = state === 'diverges' ? colors.warn : state === 'agrees' ? colors.text : colors.textDim;

  return (
    <View style={styles.gaugeWrap} accessibilityLabel={`gauge: ${gauge.value} on a band of ${lo} to ${hi} ${gauge.units}`}>
      <View style={styles.gaugeRailArea}>
        <View style={styles.gaugeRail} />
        <View style={[styles.gaugeBand, { left: `${bandLeft}%`, width: `${bandWidth}%` }]} />
        {lo <= 0 && hi >= 0 ? <View style={[styles.gaugeZero, { left: `${pct(0)}%` }]} /> : null}
        <View style={[styles.gaugeTick, { left: `${pct(gauge.value)}%`, backgroundColor: tickColor }]} />
        <Text style={[styles.gaugeTickLabel, { left: `${pct(gauge.value)}%`, color: tickColor }]}>
          {gauge.value}
        </Text>
      </View>
      <View style={styles.gaugeLabels}>
        <Text style={[styles.gaugeLabel, { left: `${bandLeft}%` }]}>{lo}</Text>
        <Text style={[styles.gaugeLabel, styles.gaugeLabelRight, { right: `${100 - bandLeft - bandWidth}%` }]}>{hi}</Text>
        <Text style={styles.gaugeUnits}>{gauge.units}</Text>
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Custody ladder — connector line, checkable rows one tap down
// ---------------------------------------------------------------------------

function RungRow({ rung, last }: { rung: RungResult; last: boolean }) {
  const styles = useThemedStyles(buildStyles);
  const [open, setOpen] = useState(false);
  const rows = rung.rows ?? [];
  return (
    <View style={styles.rung}>
      {!last ? <View style={styles.rungConnector} /> : null}
      <View style={styles.rungGlyphCol}>
        <StateGlyph state={rung.state} />
      </View>
      <View style={styles.rungBody}>
        <Text style={styles.rungTitle}>{rung.title}</Text>
        <Text style={styles.rungDetail}>{rung.detail}</Text>
        {rows.length > 0 ? (
          <>
            <Pressable style={styles.rungDisclosure} onPress={() => setOpen((o) => !o)} hitSlop={8}>
              <Ionicons name={open ? 'chevron-down' : 'chevron-forward'} size={11} color={colors.textFaint} />
              <Text style={styles.rungDisclosureText}>
                Read ▸ {rows.length} checkable row{rows.length === 1 ? '' : 's'}
              </Text>
            </Pressable>
            {open ? (
              <View style={styles.rungRows}>
                {rows.map((r, i) => (
                  <View key={i} style={styles.rungRowLine}>
                    <Text style={styles.rungRowLabel}>{r.label}</Text>
                    <Text style={styles.rungRowValue}>{r.value}</Text>
                  </View>
                ))}
              </View>
            ) : null}
          </>
        ) : null}
      </View>
    </View>
  );
}

export function CustodyLadderView({ rungs }: { rungs: RungResult[] }) {
  const styles = useThemedStyles(buildStyles);
  return (
    <View style={styles.ladder}>
      {rungs.map((r, i) => <RungRow key={r.rung} rung={r} last={i === rungs.length - 1} />)}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Evidence card — collapsed: glyph, name, gauge. Expanded: P/M/G rows.
// ---------------------------------------------------------------------------

const ROW_LABELS: [string, keyof Pick<EvidenceCard, 'prediction' | 'measurement' | 'gap' | 'interpretation'>][] = [
  ['Prediction', 'prediction'],
  ['Measurement', 'measurement'],
  ['Gap', 'gap'],
  ['Consistent with', 'interpretation'],
];

export function EvidenceCardView({ card }: { card: EvidenceCard }) {
  const styles = useThemedStyles(buildStyles);
  const [open, setOpen] = useState(false);
  const headValue = card.gauge ? `${card.gauge.value} ${card.gauge.units}` : STATE_WORD[card.state];
  // Collapsed shows the gauge (the measurement's position) and, when the
  // card could not decide or run, the stated reason in place of a number.
  const collapsedNote = card.state === 'agrees' || card.state === 'diverges' ? null : card.gap;
  return (
    <View style={styles.ecard}>
      <Pressable style={styles.ecardHead} onPress={() => setOpen((o) => !o)} hitSlop={4}>
        <StateGlyph state={card.state} />
        <Text style={styles.ecardTitle} numberOfLines={1}>{card.title}</Text>
        <Text style={styles.ecardValue} numberOfLines={1}>{headValue}</Text>
        <Ionicons name={open ? 'chevron-down' : 'chevron-forward'} size={13} color={colors.textFaint} />
      </Pressable>
      {card.gauge ? <GapGauge gauge={card.gauge} state={card.state} /> : null}
      {collapsedNote ? <Text style={styles.ecardCollapsedNote}>{collapsedNote}</Text> : null}
      {open ? (
        <View style={styles.ecardBody}>
          {ROW_LABELS.map(([label, key]) => {
            const text = card[key];
            if (!text) return null;
            return (
              <View key={key} style={styles.ecardRow}>
                <Text style={styles.ecardRowLabel}>{label}</Text>
                <Text style={styles.ecardRowValue}>{text}</Text>
              </View>
            );
          })}
          {card.method ? <Text style={styles.ecardMethod}>{card.method}</Text> : null}
          {card.audit ? <Text style={styles.ecardMethod}>{card.audit}</Text> : null}
        </View>
      ) : null}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Agreement matrix — checks × claims, monospace grid, the five-state key
// ---------------------------------------------------------------------------

/** Display names for matrix rows: the check's name, not its outcome. */
export function matrixRowName(id: string): string {
  switch (id) {
    case 'custody.seal': return 'seal';
    case 'time.capture-to-seal': return 'shutter→seal';
    case 'time.beacon-lower-bound': return 'beacon bound';
    case 'time.ots-submission': return 'ledger order';
    case 'coherence.solar': return 'sun position';
    case 'coherence.horizon': return 'horizon';
    default: return id;
  }
}

export function AgreementMatrixView({ matrix }: { matrix: AgreementMatrix }) {
  const styles = useThemedStyles(buildStyles);
  const names = matrix.checks.map(matrixRowName);
  // Monospace grid laid out with fixed-width cells so each glyph can carry
  // its own state color — divergence stays the only saturated cell.
  const nameW = Math.max(...names.map((n) => n.length), 6);
  const nameColW = (nameW + 2) * 6.6;
  const cellColW = 46;
  return (
    <View style={styles.matrix}>
      <View style={styles.matrixRow}>
        <Text style={[styles.matrixCell, styles.matrixHeadCell, { width: nameColW }]}> </Text>
        {matrix.claims.map((c) => (
          <Text key={c} style={[styles.matrixCell, styles.matrixHeadCell, { width: cellColW }]}>{c}</Text>
        ))}
      </View>
      {matrix.checks.map((id, i) => (
        <View key={id} style={styles.matrixRow}>
          <Text style={[styles.matrixCell, { width: nameColW }]}>{names[i]}</Text>
          {matrix.claims.map((c: Claim) => {
            const st = matrix.cells[id]?.[c];
            return (
              <Text
                key={c}
                style={[styles.matrixCell, { width: cellColW, color: st ? stateColor(st) : colors.border }]}
              >
                {st ? STATE_GLYPH[st] : '—'}
              </Text>
            );
          })}
        </View>
      ))}
      <Text style={styles.matrixKey}>⬤ agrees · ⬥ diverges · ◐ insufficient · ○ not run · — not applicable</Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// The File Says — declared facts, ◌ = self-reported by the device
// ---------------------------------------------------------------------------

export interface FileSaysRow {
  label: string;
  value: string;
  /** True = the device said this about itself (a claim, not a measurement). */
  self?: boolean;
}

export function TheFileSaysView({ rows, note }: { rows: FileSaysRow[]; note?: string }) {
  const styles = useThemedStyles(buildStyles);
  return (
    <View style={styles.fileSays}>
      {rows.map((r, i) => (
        <View key={i} style={styles.fileSaysRow}>
          <Text style={styles.fileSaysLabel}>{r.label}</Text>
          <Text style={styles.fileSaysValue}>
            {r.value}
            {r.self ? <Text style={styles.fileSaysSelf}> ◌</Text> : null}
          </Text>
        </View>
      ))}
      <Text style={styles.fileSaysLegend}>◌ device-reported: a claim, not a measurement</Text>
      {note ? <Text style={styles.fileSaysLegend}>{note}</Text> : null}
    </View>
  );
}

// ---------------------------------------------------------------------------

const buildStyles = () => StyleSheet.create({
  glyph: { width: 15, textAlign: 'center', fontWeight: '700' },

  sec: { marginTop: spacing.lg, marginBottom: spacing.sm },
  secHead: { flexDirection: 'row', alignItems: 'baseline', gap: spacing.sm },
  secTitle: {
    color: colors.textFaint, fontSize: fontSize.xs, fontWeight: '800',
    letterSpacing: 1.8, textTransform: 'uppercase',
  },
  secNote: { color: colors.textFaint, fontSize: fontSize.xs, flex: 1 },
  secSubnote: { color: colors.textFaint, fontSize: fontSize.xs, lineHeight: 16, marginTop: 4 },

  // gauge
  gaugeWrap: { marginTop: spacing.sm + 4, marginBottom: 2 },
  gaugeRailArea: { height: 26, justifyContent: 'center' },
  gaugeRail: {
    position: 'absolute', left: 0, right: 0, top: 17,
    height: StyleSheet.hairlineWidth, backgroundColor: colors.border,
  },
  gaugeBand: {
    position: 'absolute', top: 11, height: 13,
    backgroundColor: colors.surface2,
    borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, borderRadius: 2,
  },
  gaugeZero: { position: 'absolute', top: 8, height: 19, width: 1, backgroundColor: colors.border },
  gaugeTick: { position: 'absolute', top: 5, height: 25, width: 2, borderRadius: 1, marginLeft: -1 },
  gaugeTickLabel: {
    position: 'absolute', top: -8, marginLeft: -14, width: 28, textAlign: 'center',
    fontSize: 9, fontWeight: '700', fontFamily: type.mono,
  },
  gaugeLabels: { height: 14, marginTop: 2 },
  gaugeLabel: {
    position: 'absolute', top: 0, marginLeft: -10, width: 20, textAlign: 'center',
    color: colors.textFaint, fontSize: 8.5, fontFamily: type.mono,
  },
  gaugeLabelRight: { marginLeft: 0, marginRight: -10 },
  gaugeUnits: {
    position: 'absolute', right: 0, top: 0,
    color: colors.textFaint, fontSize: 8.5, fontFamily: type.mono,
  },

  // ladder
  ladder: { paddingVertical: 2 },
  rung: { flexDirection: 'row', gap: 10, paddingVertical: 7 },
  rungConnector: {
    position: 'absolute', left: 7, top: 26, bottom: -8,
    width: StyleSheet.hairlineWidth, backgroundColor: colors.border,
  },
  rungGlyphCol: { width: 15, alignItems: 'center', paddingTop: 2 },
  rungBody: { flex: 1 },
  rungTitle: { color: colors.text, fontSize: fontSize.sm, fontWeight: '600' },
  rungDetail: { color: colors.textDim, fontSize: fontSize.xs, lineHeight: 17, marginTop: 2 },
  rungDisclosure: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 6, alignSelf: 'flex-start' },
  rungDisclosureText: { color: colors.textFaint, fontSize: fontSize.xs },
  rungRows: {
    marginTop: 6, backgroundColor: colors.bg, borderRadius: radii.sm,
    padding: spacing.sm + 2, gap: 5,
  },
  rungRowLine: { flexDirection: 'row', gap: spacing.sm },
  rungRowLabel: { color: colors.textFaint, fontSize: 10, width: 118 },
  rungRowValue: { color: colors.textDim, fontSize: 10, flex: 1, fontFamily: type.mono, lineHeight: 15 },

  // evidence cards
  ecard: {
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border,
    borderRadius: radii.md, paddingHorizontal: spacing.sm + 4, paddingVertical: spacing.sm + 2,
    marginBottom: spacing.sm,
  },
  ecardHead: { flexDirection: 'row', alignItems: 'center', gap: 9 },
  ecardTitle: { color: colors.text, fontSize: fontSize.sm, fontWeight: '600', flex: 1 },
  ecardValue: { color: colors.textDim, fontSize: fontSize.xs, fontFamily: type.mono, flexShrink: 1 },
  ecardCollapsedNote: { color: colors.textDim, fontSize: fontSize.xs, lineHeight: 17, marginTop: 6 },
  ecardBody: { marginTop: spacing.sm, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border, paddingTop: spacing.sm },
  ecardRow: { flexDirection: 'row', gap: 10, paddingVertical: 2 },
  ecardRowLabel: { color: colors.textFaint, fontSize: fontSize.xs, width: 88 },
  ecardRowValue: { color: colors.textDim, fontSize: fontSize.xs, lineHeight: 17, flex: 1 },
  ecardMethod: { color: colors.textFaint, fontSize: 9.5, lineHeight: 14, marginTop: 6 },

  // matrix
  matrix: {
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border,
    borderRadius: radii.md, padding: spacing.sm + 4,
  },
  matrixRow: { flexDirection: 'row' },
  matrixCell: { fontFamily: type.mono, fontSize: 10.5, lineHeight: 17, color: colors.textDim },
  matrixHeadCell: { color: colors.textFaint },
  matrixKey: { color: colors.textFaint, fontSize: 8.5, marginTop: spacing.sm },

  // the file says
  fileSays: {
    backgroundColor: colors.surface2, borderWidth: 1, borderColor: colors.border,
    borderRadius: radii.md, padding: spacing.sm + 4,
  },
  fileSaysRow: { flexDirection: 'row', gap: 10, paddingVertical: 2 },
  fileSaysLabel: { color: colors.textFaint, fontSize: 10.5, fontFamily: type.mono, width: 88 },
  fileSaysValue: { color: colors.textDim, fontSize: 10.5, fontFamily: type.mono, lineHeight: 17, flex: 1 },
  fileSaysSelf: { color: colors.warn },
  fileSaysLegend: { color: colors.textFaint, fontSize: 9, lineHeight: 14, marginTop: spacing.sm },
});

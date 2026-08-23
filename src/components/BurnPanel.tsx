// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * BurnPanel: the selective-disclosure lock surface. User-facing language is
 * "lock forever", not "burn". Locking destroys the master seed, the only key
 * material that opens the sealed details; the seal itself is unaffected. Every
 * lock is written to the event log, and a scheduled lock fires on the next
 * foreground after the deadline, not at the wall-clock instant. The
 * confirmation sheet shows BURN_FINALITY_WORDING verbatim
 * (src/disclosure/burn.ts).
 */

import React, { useState } from 'react';
import { View, Text, StyleSheet, Modal, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, spacing, radii, fontSize, useThemedStyles, useEffectiveScheme } from '../theme';
import { Button, Chip, Divider } from './ui';
import { BURN_FINALITY_WORDING, type DisclosureItemState } from '../disclosure/burn';

/** Policy options. `undefined` = the default: never burn. */
const POLICIES: { label: string; hours?: number }[] = [
  { label: 'Never', hours: undefined },
  { label: '24 hours after capture', hours: 24 },
  { label: '7 days after capture', hours: 24 * 7 },
  { label: '30 days after capture', hours: 24 * 30 },
];

function fmt(iso: string): string {
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toLocaleString() : iso;
}

/** The scheduled burn's wall-clock deadline, when a policy is set. */
export function burnDeadline(state: DisclosureItemState): Date | null {
  if (state.burnAfterHours === undefined) return null;
  const t = Date.parse(state.createdAt);
  if (!Number.isFinite(t)) return null;
  return new Date(t + state.burnAfterHours * 3600_000);
}

export function BurnPanel({ state, busy, onSetPolicy, onBurnNow }: {
  state: DisclosureItemState;
  busy: boolean;
  /** Persist a new policy (hours) or the never-default (undefined). */
  onSetPolicy: (hours?: number) => void;
  /** Burn immediately. The caller runs applyBurn once this sheet confirms. */
  onBurnNow: () => void;
}) {
  const styles = useThemedStyles(buildStyles);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [policyOpen, setPolicyOpen] = useState(false);
  const burned = state.masterSeedHex === undefined;
  const deadline = burnDeadline(state);

  return (
    <View>
      {/* ---- policy ------------------------------------------------------ */}
      {!burned ? (
        <View>
          <Text style={styles.blockNoteFirst}>
            Details like your name and location are locked inside this exhibit. They can be opened
            one at a time, or locked forever so no one can ever open them. The seal is unaffected
            either way.
          </Text>
          <View style={styles.statusRow}>
            <Text style={styles.statusKey}>Status</Text>
            <Text style={styles.statusVal}>Can be opened</Text>
          </View>
          <Pressable
            style={styles.statusRow}
            onPress={() => setPolicyOpen((o) => !o)}
            disabled={busy}
            accessibilityRole="button"
          >
            <Text style={styles.statusKey}>Lock automatically</Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
              <Text style={[styles.statusVal, { color: colors.text }]}>
                {POLICIES.find((p) => p.hours === state.burnAfterHours)?.label ?? 'Never'}
              </Text>
              <Ionicons name={policyOpen ? 'chevron-up' : 'chevron-forward'} size={13} color={colors.textFaint} />
            </View>
          </Pressable>
          {policyOpen ? (
            <View>
              {POLICIES.map((p) => {
                const active = state.burnAfterHours === p.hours;
                return (
                  <Pressable
                    key={p.label}
                    style={[styles.policyRow, active && styles.policyRowActive]}
                    onPress={() => { onSetPolicy(p.hours); setPolicyOpen(false); }}
                    disabled={busy}
                    accessibilityRole="button"
                  >
                    <Ionicons
                      name={active ? 'radio-button-on' : 'radio-button-off'}
                      size={17}
                      color={active ? colors.accent : colors.textFaint}
                    />
                    <Text style={[styles.policyLabel, active && { color: colors.text }]}>{p.label}</Text>
                  </Pressable>
                );
              })}
              <Text style={styles.blockNote}>
                A scheduled lock runs when the app next opens after the deadline; it is not a wall-clock timer.
              </Text>
            </View>
          ) : null}
          {deadline ? (
            <Text style={styles.deadline}>
              Scheduled: locked forever on the next app open after {deadline.toLocaleString()}.
            </Text>
          ) : null}
          <View style={{ marginTop: spacing.md }}>
            <Button
              small
              tone="danger"
              icon="lock-closed-outline"
              label="Lock forever"
              onPress={() => setConfirmOpen(true)}
              disabled={busy}
            />
          </View>
        </View>
      ) : (
        <View>
          <View style={styles.statusRow}>
            <Text style={styles.statusKey}>Status</Text>
            <Text style={[styles.statusVal, { color: colors.danger }]}>
              Locked forever{state.burnedAt ? ` · ${fmt(state.burnedAt)}` : ''}
            </Text>
          </View>
          <Text style={styles.burnedWording}>{BURN_FINALITY_WORDING}</Text>
        </View>
      )}

      {/* ---- record ------------------------------------------------------ */}
      <Divider />
      <Text style={styles.blockTitle}>Record</Text>
      {state.events.map((e, i) => (
        <View key={`${e.at}-${i}`} style={styles.eventRow}>
          <Ionicons
            name={e.type === 'burn' ? 'lock-closed' : e.type === 'open' ? 'lock-open-outline' : 'git-commit-outline'}
            size={14}
            color={e.type === 'burn' ? colors.danger : colors.textDim}
          />
          <Text style={styles.eventText}>
            {e.type === 'commit'
              ? `Committed at capture · ${fmt(e.at)}`
              : e.type === 'open'
                ? `Opened '${e.profile ?? '?'}' · ${fmt(e.at)}`
                : `Locked forever · ${fmt(e.at)}`}
          </Text>
        </View>
      ))}
      {state.burnFailure ? (
        <View style={styles.failureBox}>
          <Text style={styles.failureTitle}>
            A scheduled lock failed · {fmt(state.burnFailure.at)}
          </Text>
          <Text selectable style={styles.failureError}>{state.burnFailure.error}</Text>
          <Text style={styles.failureNote}>
            Nothing was destroyed. The lock retries the next time the app opens.
          </Text>
        </View>
      ) : null}

      {/* ---- finality sheet ---------------------------------------------- */}
      <Modal visible={confirmOpen} transparent animationType="fade" onRequestClose={() => setConfirmOpen(false)}>
        <View style={styles.scrim}>
          <View style={styles.sheet}>
            <Ionicons name="flame" size={26} color={colors.danger} />
            <Text style={styles.sheetTitle}>Lock forever?</Text>
            <Text style={styles.sheetWording}>{BURN_FINALITY_WORDING}</Text>
            <Text style={styles.sheetNote}>
              This happens now, whatever the schedule says, and it is recorded in this exhibit’s log.
            </Text>
            <Button
              tone="danger"
              icon="lock-closed"
              label="Lock forever · this is final"
              onPress={() => {
                setConfirmOpen(false);
                onBurnNow();
              }}
            />
            <View style={{ height: spacing.sm }} />
            <Button tone="ghost" label="Cancel" onPress={() => setConfirmOpen(false)} />
          </View>
        </View>
      </Modal>
    </View>
  );
}

const buildStyles = () => StyleSheet.create({
  blockTitle: {
    color: colors.textFaint,
    fontSize: fontSize.xs,
    fontWeight: '700',
    letterSpacing: 1.4,
    textTransform: 'uppercase',
    marginBottom: spacing.sm,
  },
  blockNote: { color: colors.textDim, fontSize: fontSize.xs, lineHeight: 17, marginTop: spacing.sm },
  blockNoteFirst: { color: colors.textDim, fontSize: fontSize.sm, lineHeight: 20, marginBottom: spacing.sm },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 9,
  },
  statusKey: { color: colors.textDim, fontSize: fontSize.sm },
  statusVal: { color: colors.textDim, fontSize: fontSize.sm },
  policyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: 9,
    paddingHorizontal: spacing.sm,
    borderRadius: radii.md,
  },
  policyRowActive: { backgroundColor: colors.accentSoft },
  policyLabel: { color: colors.textDim, fontSize: fontSize.sm, fontWeight: '500' },
  deadline: { color: colors.warn, fontSize: fontSize.xs, lineHeight: 17, marginTop: spacing.sm },
  burnedWording: { color: colors.text, fontSize: fontSize.sm, lineHeight: 20, marginTop: spacing.sm },
  eventRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: 5 },
  eventText: { color: colors.textDim, fontSize: fontSize.sm },
  failureBox: {
    backgroundColor: colors.dangerSoft,
    borderRadius: radii.md,
    padding: spacing.md,
    marginTop: spacing.sm,
  },
  failureTitle: { color: colors.danger, fontSize: fontSize.sm, fontWeight: '700' },
  failureError: { color: colors.danger, fontSize: fontSize.xs, marginTop: spacing.xs },
  failureNote: { color: colors.textDim, fontSize: fontSize.xs, lineHeight: 17, marginTop: spacing.sm },
  scrim: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.lg,
  },
  sheet: {
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    padding: spacing.lg,
    width: '100%',
    maxWidth: 420,
  },
  sheetTitle: { color: colors.text, fontSize: fontSize.lg, fontWeight: '700', marginTop: spacing.sm },
  sheetWording: {
    color: colors.text,
    fontSize: fontSize.md,
    lineHeight: 22,
    marginTop: spacing.sm,
    fontWeight: '600',
  },
  sheetNote: { color: colors.textDim, fontSize: fontSize.xs, lineHeight: 17, marginVertical: spacing.md },
});

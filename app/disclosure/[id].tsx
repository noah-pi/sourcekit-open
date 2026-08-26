// Source Kit 0.1.0 — disclosure screen: what this capture committed to, what
// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Disclosure screen: what this capture committed to, what is open, what is
 * held, and the burn schedule.
 *
 * Reads the per-item disclosure state (documentDirectory/disclosure/{id}.json,
 * vault-sealed) through the same DisclosureStore the scheduler uses. Every
 * claim is listed in one of three states:
 *
 *   open           — the selected profile opens this claim into the bundle,
 *                    and its value is shown.
 *   held           — committed at capture, withheld from the selected bundle;
 *                    the row is still listed.
 *   never-recorded — declared at commit time and immutable under the signed
 *                    root. Nothing to open, as distinct from withheld.
 *
 * Export derives the bundle from the master seed via exportForItem (salts are
 * re-derived at open time; there is no salt table), runs the full bundle
 * verification, and renders residual failures verbatim. After a burn, opening
 * throws the locked 'burned:' wording, shown as-is.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, Pressable, Switch, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as Sharing from 'expo-sharing';
import * as FileSystem from 'expo-file-system/legacy';

import { colors, spacing, radii, fontSize, type, useThemedStyles } from '../../src/theme';
import { Button, Card, Chip, Mono } from '../../src/components/ui';
import { SinkStates } from '../../src/components/SinkStates';
import { BurnPanel } from '../../src/components/BurnPanel';
import { vaultDisclosureStore } from '../../src/provenance/sealQueue';
import { getRecord } from '../../src/vault/vaultFs';
import {
  applyBurn,
  exportForItem,
  burnedOpenError,
  type DisclosureItemState,
} from '../../src/disclosure/burn';
import { profileSelection, type DisclosureProfile } from '../../src/disclosure/bundle';
import type { ClaimFamily } from '../../src/disclosure/inventory';
import type { AttestationRecord } from '../../src/provenance/manifest';

const PROFILE_LABELS: { profile: DisclosureProfile; title: string; detail: string }[] = [
  { profile: 'sealed', title: 'Sealed (default)', detail: 'Opens nothing. The bundle carries the root and the never-recorded declaration only: proof the commitment exists, no values.' },
  { profile: 'short', title: 'Short', detail: 'Opens coarse time (down to the day), coarse location, and the signer key fingerprint. Sensor claims stay held.' },
  { profile: 'full', title: 'Full', detail: 'Opens everything that was committed. Never-recorded claims stay declared; there is nothing to open.' },
  { profile: 'custom', title: 'Custom', detail: 'You pick exactly which committed claims to open, one by one.' },
];

/**
 * Disclosure categories: identity, location, device attestation, timestamps,
 * auxiliary evidence. Committed context claims map onto four of the five;
 * device attestation has no context-tree claims, since hardware-attestation
 * identifiers live in the file's credential layer and travel as a block with
 * the Basic/Full exports. That group renders a note instead of a toggle.
 */
const CATEGORY_ORDER: { key: string; title: string; families: ClaimFamily[] }[] = [
  { key: 'identity', title: 'Identity', families: ['identity'] },
  { key: 'location', title: 'Location', families: ['location'] },
  { key: 'attestation', title: 'Device attestation', families: [] },
  { key: 'timestamps', title: 'Timestamps', families: ['time'] },
  { key: 'auxiliary', title: 'Auxiliary evidence', families: ['sensor', 'context'] },
];

export default function DisclosureScreen() {
  const styles = useThemedStyles(buildStyles);
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();

  const [state, setState] = useState<DisclosureItemState | null>(null);
  const [record, setRecord] = useState<AttestationRecord | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [profile, setProfile] = useState<DisclosureProfile>('sealed');
  const [customIds, setCustomIds] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [residuals, setResiduals] = useState<string[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      if (!id) return;
      const store = vaultDisclosureStore();
      const [s, rec] = await Promise.all([store.load(id), getRecord(id).catch(() => null)]);
      setState(s);
      setRecord(rec ?? null);
      setLoaded(true);
    })();
  }, [id]);

  const burned = state != null && state.masterSeedHex === undefined;

  /** The exact selection the chosen profile opens; the core uses this function too. */
  const selected = useMemo(() => {
    if (!state) return new Set<string>();
    const sel = profileSelection(profile, profile === 'custom' ? customIds : undefined);
    return new Set(state.claims.filter((c) => sel(c)).map((c) => c.claimId));
  }, [state, profile, customIds]);

  /**
   * Live summary of what the current selection's bundle will and will not
   * contain, recomputed on every toggle: opened leaves, proofs, root,
   * inventory, withheld count, never-recorded declaration. No media, no held
   * values.
   */
  const bundleSummary = useMemo(() => {
    if (!state) return null;
    const openedByCategory = CATEGORY_ORDER
      .map((cat) => ({
        title: cat.title,
        n: state.claims.filter((c) => selected.has(c.claimId) && cat.families.includes(c.family)).length,
      }))
      .filter((x) => x.n > 0);
    const held = state.claims.length - selected.size;
    const never = state.inventoryAssertion.entries.filter((e) => e.state === 'never-recorded').length;
    const openedText =
      openedByCategory.length === 0
        ? 'no claim values at all'
        : `opened claim values: ${openedByCategory.map((x) => `${x.title.toLowerCase()} (${x.n})`).join(', ')}`;
    return {
      will:
        `${openedText}; the commitment root with each opened claim’s inclusion proof; ` +
        `the never-recorded declaration (${never}); a count of what is held.`,
      wont:
        'the media itself (this bundle is proofs, not pixels); ' +
        (held > 0
          ? `the ${held} held claim${held === 1 ? '' : 's'}, stated inside the bundle as held, not included; `
          : 'no committed claim stays held (everything committed is opened); ') +
        'anything declared never-recorded.',
    };
  }, [state, selected]);

  const persist = async (next: DisclosureItemState) => {
    await vaultDisclosureStore().save(next);
    setState(next);
  };

  const setPolicy = async (hours?: number) => {
    if (!state || busy || burned) return;
    setBusy(true);
    try {
      const next: DisclosureItemState = { ...state };
      if (hours === undefined) delete next.burnAfterHours;
      else next.burnAfterHours = hours;
      await persist(next);
    } finally {
      setBusy(false);
    }
  };

  const burnNow = async () => {
    if (!state || busy || burned) return;
    setBusy(true);
    setFailure(null);
    try {
      await persist(applyBurn(state, new Date()));
    } catch (e) {
      // Shown verbatim, not paraphrased.
      setFailure(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const doExport = async () => {
    if (!state || busy) return;
    setBusy(true);
    setResiduals(null);
    setFailure(null);
    try {
      const ids = profile === 'custom' ? [...customIds].sort() : undefined;
      const out = exportForItem(state, profile, ids);
      // Opening is an action: persist the state carrying the 'open' event.
      await persist(out.state);
      setResiduals(out.residuals);
      const name = `verify-disclosure-${id}-${profile}.json`;
      const path = `${FileSystem.cacheDirectory}${name}`;
      await FileSystem.writeAsStringAsync(path, JSON.stringify(out.bundle, null, 2) + '\n');
      if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(path, { mimeType: 'application/json' });
    } catch (e) {
      // The burned-open error wording is locked ("burned: …").
      setFailure(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const toggleCustom = (claimId: string) => {
    setCustomIds((cur) => {
      const next = new Set(cur);
      if (next.has(claimId)) next.delete(claimId);
      else next.add(claimId);
      return next;
    });
  };

  if (!loaded) {
    return (
      <SafeAreaView style={styles.safe}>
        <ActivityIndicator color={colors.accent} style={{ marginTop: 80 }} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <View style={styles.topBar}>
        <Button small tone="ghost" icon="chevron-back" label="Exhibit" onPress={() => router.back()} />
        {state ? (
          burned ? (
            <Chip tone="bad" icon="flame" label="Proof material burned" />
          ) : (
            <Chip tone="info" icon="lock-closed" label="Seed intact · profiles open on demand" />
          )
        ) : null}
      </View>

      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={styles.title}>Selective disclosure</Text>

        {!state ? (
          <Card>
            <Text style={styles.noStateTitle}>No disclosure state for this item</Text>
            <Text style={styles.noStateBody}>
              This item has no readable disclosure record. That means it was sealed before
              commit-at-capture shipped, or its vault-sealed disclosure file could not be read.
              The store returns the same answer for both, so this screen does not guess which.
              Nothing here claims the capture committed to anything.
            </Text>
          </Card>
        ) : (
          <>
            {/* ---- what the capture committed to ------------------------- */}
            <Card>
              <Text style={styles.sectionTitle}>Committed at capture</Text>
              <Text style={styles.body}>
                At capture time this device committed {state.claims.length} context claims under one
                Merkle root, carried in the signed record. Every claim below is in exactly one state:
                open, held, or never-recorded.
              </Text>
              <View style={styles.rootRow}>
                <Text style={styles.rootLabel}>Root</Text>
                <View style={{ flex: 1 }}>
                  <Mono size="xs" color={colors.text}>{state.root}</Mono>
                </View>
              </View>
              <View style={styles.rootRow}>
                <Text style={styles.rootLabel}>Committed</Text>
                <Text style={styles.rootValue}>{new Date(state.createdAt).toLocaleString()}</Text>
              </View>
              <View style={styles.countRow}>
                <Chip tone="good" label={`${selected.size} open in '${profile}'`} />
                <Chip tone="warn" label={`${state.claims.length - selected.size} held`} />
                <Chip
                  tone="neutral"
                  label={`${state.inventoryAssertion.entries.filter((e) => e.state === 'never-recorded').length} never recorded`}
                />
              </View>
            </Card>

            {/* ---- profile picker ---------------------------------------- */}
            <Card>
              <Text style={styles.sectionTitle}>What this bundle opens</Text>
              {PROFILE_LABELS.map((p) => {
                const active = profile === p.profile;
                return (
                  <Pressable
                    key={p.profile}
                    style={[styles.profileRow, active && styles.profileRowActive]}
                    onPress={() => setProfile(p.profile)}
                    accessibilityRole="button"
                  >
                    <Ionicons
                      name={active ? 'radio-button-on' : 'radio-button-off'}
                      size={17}
                      color={active ? colors.accent : colors.textFaint}
                    />
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.profileTitle, active && { color: colors.text }]}>{p.title}</Text>
                      <Text style={styles.profileDetail}>{p.detail}</Text>
                    </View>
                  </Pressable>
                );
              })}
              <Text style={styles.body}>
                Values appear below only for claims the selected bundle opens; those are what would
                leave this phone. Held values stay here.
              </Text>
              {bundleSummary ? (
                <View style={styles.summaryBox}>
                  <Text style={styles.summaryTitle}>With this selection, the bundle will contain</Text>
                  <Text style={styles.summaryLine}>{bundleSummary.will}</Text>
                  <Text style={[styles.summaryTitle, { marginTop: spacing.sm }]}>It will not contain</Text>
                  <Text style={styles.summaryLine}>{bundleSummary.wont}</Text>
                </View>
              ) : null}
              <View style={{ marginTop: spacing.sm }}>
                <Button
                  icon="share-outline"
                  label={burned ? 'Export unavailable (burned)' : `Export '${profile}' proof bundle`}
                  onPress={doExport}
                  loading={busy}
                  disabled={burned || (profile === 'custom' && customIds.size === 0)}
                />
              </View>
              {profile === 'custom' && customIds.size === 0 ? (
                <Text style={styles.hint}>Pick at least one committed claim below to export a custom bundle.</Text>
              ) : null}
              {burned ? (
                <Text selectable style={styles.burnedError}>
                  {burnedOpenError(state).message}
                </Text>
              ) : null}
              {failure ? (
                <Text selectable style={styles.burnedError}>{failure}</Text>
              ) : null}
              {residuals ? (
                residuals.length === 0 ? (
                  <View style={styles.residualOk}>
                    <Ionicons name="checkmark-circle" size={15} color={colors.accent} />
                    <Text style={styles.residualOkText}>
                      The exported bundle matches the committed root; no residuals.
                    </Text>
                  </View>
                ) : (
                  <View style={styles.residualBad}>
                    <Text style={styles.residualBadTitle}>
                      The exported bundle did NOT verify clean. Every failure, as reported:
                    </Text>
                    {residuals.map((r, i) => (
                      <Text key={i} selectable style={styles.residualItem}>• {r}</Text>
                    ))}
                  </View>
                )
              ) : null}
            </Card>

            {/* ---- claim inventory, grouped by disclosure category --------- */}
            <Card>
              <Text style={styles.sectionTitle}>Every claim, in its state</Text>
              {CATEGORY_ORDER.map((cat) => {
                // Device attestation carries no committed context claims, so
                // the group renders a note rather than a header or a toggle
                // (see CATEGORY_ORDER above).
                if (cat.families.length === 0) {
                  return (
                    <View key={cat.key} style={{ marginTop: spacing.sm }}>
                      <Text style={styles.familyTitle}>{cat.title}</Text>
                      <Text style={styles.claimNote}>
                        Not a per-field toggle: attestation identifiers live in the file’s
                        credential layer, not in the committed context tree. They travel with the
                        Full export and are withheld by the Basic copy; there is nothing here
                        to open claim by claim.
                      </Text>
                    </View>
                  );
                }
                const entries = state.inventoryAssertion.entries.filter((e) => cat.families.includes(e.family));
                if (entries.length === 0) return null;
                return (
                  <View key={cat.key} style={{ marginTop: spacing.sm }}>
                    <Text style={styles.familyTitle}>{cat.title}</Text>
                    {entries.map((entry) => {
                      if (entry.state === 'never-recorded') {
                        return (
                          <View key={entry.claimId} style={styles.claimRow}>
                            <View style={{ flex: 1 }}>
                              <Text style={styles.claimId}>{entry.claimId}</Text>
                              <Text style={styles.claimNote}>
                                Never recorded: declared at capture time and immutable under the
                                root. Nothing was collected; there is nothing to open. This is not
                                a held value.
                              </Text>
                            </View>
                            <Chip tone="neutral" label="never recorded" />
                          </View>
                        );
                      }
                      const claim = state.claims.find((c) => c.claimId === entry.claimId);
                      if (!claim) return null;
                      const isOpen = selected.has(claim.claimId);
                      return (
                        <View key={entry.claimId} style={styles.claimRow}>
                          <View style={{ flex: 1 }}>
                            <Text style={styles.claimId}>{claim.claimId}</Text>
                            {isOpen ? (
                              <Text selectable style={styles.claimValue}>{claim.value}</Text>
                            ) : (
                              <Text style={styles.claimNote}>
                                Held: committed at capture, withheld in the '{profile}' bundle.
                                Opening it takes a profile that selects it
                                {burned ? ', and the seed is burned, so no profile ever will again' : ''}.
                              </Text>
                            )}
                          </View>
                          {profile === 'custom' && !burned ? (
                            <Switch
                              value={isOpen}
                              onValueChange={() => toggleCustom(claim.claimId)}
                              trackColor={{ false: colors.surface2, true: colors.accent }}
                              thumbColor="#FFFFFF"
                              ios_backgroundColor={colors.surface2}
                            />
                          ) : (
                            <Chip tone={isOpen ? 'good' : 'warn'} label={isOpen ? 'open' : 'held'} />
                          )}
                        </View>
                      );
                    })}
                  </View>
                );
              })}
            </Card>

            {/* ---- burn ---------------------------------------------------- */}
            <Card>
              <Text style={styles.sectionTitle}>Burn</Text>
              <BurnPanel state={state} busy={busy} onSetPolicy={(h) => void setPolicy(h)} onBurnNow={() => void burnNow()} />
            </Card>
          </>
        )}

        {/* ---- evidence sinks ------------------------------------------- */}
        <Card>
          <Text style={styles.sectionTitle}>Capture evidence sinks</Text>
          <Text style={styles.body}>
            The raw evidence files the capture session did or did not produce. Each sink is in
            exactly one state, stated literally: a failure is never rendered as "off", and
            never-recorded is never rendered as a failure.
          </Text>
          <SinkStates captureEvidence={record?.context?.captureEvidence ?? undefined} />
        </Card>
      </ScrollView>
    </SafeAreaView>
  );
}

const buildStyles = () => StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
  },
  scroll: { paddingHorizontal: spacing.md, paddingBottom: spacing.xxl },
  title: {
    color: colors.text,
    fontSize: fontSize.hero,
    fontWeight: '700',
    letterSpacing: -1.0,
    fontFamily: type.display,
    marginBottom: spacing.md,
    marginTop: spacing.xs,
  },
  sectionTitle: {
    color: colors.textFaint,
    fontSize: fontSize.xs,
    fontWeight: '700',
    letterSpacing: 1.4,
    textTransform: 'uppercase',
    marginBottom: spacing.sm,
  },
  body: { color: colors.textDim, fontSize: fontSize.sm, lineHeight: 20, marginBottom: spacing.sm },
  noStateTitle: { color: colors.text, fontSize: fontSize.md, fontWeight: '700', marginBottom: spacing.sm },
  noStateBody: { color: colors.textDim, fontSize: fontSize.sm, lineHeight: 20 },
  rootRow: { flexDirection: 'row', gap: spacing.md, paddingVertical: 4, alignItems: 'flex-start' },
  rootLabel: { color: colors.textFaint, fontSize: fontSize.sm, width: 80 },
  rootValue: { color: colors.text, fontSize: fontSize.sm, flex: 1 },
  countRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.sm },
  profileRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    padding: spacing.sm,
    borderRadius: radii.md,
    marginBottom: spacing.xs,
  },
  profileRowActive: { backgroundColor: colors.accentSoft },
  profileTitle: { color: colors.textDim, fontSize: fontSize.sm, fontWeight: '700' },
  profileDetail: { color: colors.textFaint, fontSize: fontSize.xs, lineHeight: 17, marginTop: 2 },
  hint: { color: colors.textFaint, fontSize: fontSize.xs, marginTop: spacing.sm },
  summaryBox: {
    backgroundColor: colors.surface2,
    borderRadius: radii.md,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  summaryTitle: {
    color: colors.textFaint,
    fontSize: fontSize.xs,
    fontWeight: '700',
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  },
  summaryLine: { color: colors.textDim, fontSize: fontSize.sm, lineHeight: 20, marginTop: 2 },
  burnedError: {
    color: colors.danger,
    fontSize: fontSize.sm,
    lineHeight: 20,
    marginTop: spacing.sm,
    fontFamily: type.mono,
  },
  residualOk: { flexDirection: 'row', gap: spacing.sm, alignItems: 'flex-start', marginTop: spacing.sm },
  residualOkText: { flex: 1, color: colors.accent, fontSize: fontSize.sm, lineHeight: 20 },
  residualBad: {
    backgroundColor: colors.dangerSoft,
    borderRadius: radii.md,
    padding: spacing.md,
    marginTop: spacing.sm,
  },
  residualBadTitle: { color: colors.danger, fontSize: fontSize.sm, fontWeight: '700', marginBottom: spacing.xs },
  residualItem: { color: colors.danger, fontSize: fontSize.xs, lineHeight: 18, fontFamily: type.mono },
  familyTitle: { color: colors.text, fontSize: fontSize.sm, fontWeight: '700', marginBottom: spacing.xs },
  claimRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderSoft,
  },
  claimId: { color: colors.text, fontSize: fontSize.sm, fontWeight: '600', fontFamily: type.mono },
  claimValue: { color: colors.accent, fontSize: fontSize.sm, fontFamily: type.mono, marginTop: 2 },
  claimNote: { color: colors.textFaint, fontSize: fontSize.xs, lineHeight: 17, marginTop: 2 },
});

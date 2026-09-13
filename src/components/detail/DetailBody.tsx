// Source Kit 0.1.0 — the detail body: the label and the sheets its rows open
// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * The detail body: the label, and the sheets its rows open.
 *
 * The label is five questions a reader asks, in the order they ask them:
 * changed since it was sealed, when, where, by whom, and does the scene hold
 * up. Each row is the question, the answer set large, one line under it,
 * and one word naming who says so. Nothing else is on the label. Every
 * explanation, every figure and every full account lives on the sheet the
 * row opens, so the label can be read by counting colors before reading a
 * word. The grammar is decided once, in derive.ts.
 *
 * The strip of stamps that belongs to the picture is the screen's to place,
 * on the media's bottom edge; deriveStrip and SealStrip give it the words.
 *
 * Rendered the same way from Inspect and from an exhibit.
 */

import React, { useMemo, useState } from 'react';
import { View, Text, Pressable, Linking, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, spacing, fontSize, radii, type, useThemedStyles } from '../../theme';
import { Fact, ExplainerScreen, SceneRow, Rule, DEVICE_REPORTED, type Tone } from './DetailKit';
import {
  SealChart, PlaceFigure, TimeFigure,
  SEAL_LEDE_RECORD, SEAL_LEDE_FOREIGN, SEAL_LEDE_ALTERED, SEAL_LEDE_NONE,
  TIME_LEDE, PLACE_LEDE, IDENTITY_LEDE,
} from './Explainers';
import { ManifestSheet } from './ManifestBrowser';
import { deriveLabel } from './derive';
export { deriveStrip } from './derive';
import { HorizonCard, ShadowCard, type JuxtaInputs } from '../Juxtapose';
import { MultipleLensCard, type SecondaryFrameRef, type VideoPairFrameRef } from '../forensic/MultipleLensCard';
import { MotionTraceCard, VideoMotionCard } from '../forensic/MotionTraceCard';
import { RawAudioCard, type EnfAnchor } from '../forensic/RawAudioCard';
import { EnvironmentCard } from '../forensic/EnvironmentCard';
import type { AttestationRecord } from '../../provenance/manifest';
import type { C2paManifest } from '../../../archive/handrolled-verifier/c2pa';
import type { ForeignFacts } from '../../reader/foreign';

/** What the seal establishes. */
export interface SealState {
  /** The maker the file names, e.g. "Source Kit on iPhone 15 Pro". */
  device: string;
  key: { value: string };
  app: { value: string };
  establishedBy: string;
  /** Bytes against signature. Only a contradiction is 'altered'. */
  media: 'intact' | 'altered' | 'unsigned';
  /** Who vouches for the signer, when anyone does. */
  signer: string | null;
  attestation: 'proven' | 'refused' | 'none';
  /** Why an attestation was refused, when one was. */
  reason: string | null;
  signedDigest: string | null;
  fileDigest: string | null;
  alg: string | null;
  keyFingerprint: string | null;
}

export interface TimeCheck {
  name: string;
  detail: string;
  met: boolean;
}

export interface TimeState {
  signedAt: string;
  signedAtIso: string | null;
  checks: TimeCheck[];
  tag: string;
  established: boolean;
  authority: { name: string | null; trusted: boolean; at: string | null } | null;
  ledger: { beaconHeight: number | null; anchoredHeight: number | null; pending: boolean } | null;
}

export interface PlaceState {
  coords: string | null;
  accuracy: string | null;
  mapsUrl: string | null;
  placeName: string | null;
  compass: { sealed: string; detail: string; agrees: boolean } | null;
}

export interface SignerIdentityState {
  tag: string;
  tone: Tone;
  name: string;
  by: string | null;
  domain: string | null;
  org?: string | null;
}

/** One row of the label. */
export interface LabelRow {
  id: 'edits' | 'seal' | 'time' | 'place' | 'who';
  question: string;
  answer: string;
  caption: string;
  /** Who says so. Empty for a thing to look at. */
  word: string;
  tone: Tone | 'none';
  mono?: boolean;
  /** A link that ends the caption line. */
  link?: { label: string; url: string };
}

export interface StripItem {
  label: string;
  tone: Tone;
}

export interface StripState {
  maker: string;
  stamps: StripItem[];
}

export interface LabelState {
  /** Null when the file has no seal: there is nothing to stamp. */
  strip: StripState | null;
  rows: LabelRow[];
  unsigned: boolean;
  /** One line above the rows when they describe a file other than this one. */
  notice: string | null;
}

type SceneKey = 'lenses' | 'motion' | 'horizon' | 'shadows' | 'weather' | 'audio';
type SheetId = LabelRow['id'] | 'manifest' | 'export' | null;


export function DetailBody({
  record,
  manifest,
  foreign = null,
  seal,
  signerIdentity,
  time,
  place,
  kind,
  mediaUri,
  secondary,
  secondaryPts = null,
  secondaryError = null,
  videoFrames,
  juxta,
  enfAnchor,
  sealedWhenWhere,
  edits,
  actions,
}: {
  /** Null for a file another signer sealed: the manifest is then the record. */
  record: AttestationRecord | null;
  manifest: C2paManifest | null;
  foreign?: ForeignFacts | null;
  seal: SealState;
  signerIdentity: SignerIdentityState;
  time: TimeState;
  place: PlaceState;
  kind: 'photo' | 'video' | 'audio';
  mediaUri: string | null;
  secondary: SecondaryFrameRef | null;
  secondaryPts?: number | null;
  secondaryError?: string | null;
  videoFrames: VideoPairFrameRef[] | null;
  juxta: JuxtaInputs | null;
  enfAnchor: EnfAnchor | null;
  sealedWhenWhere: string;
  /** Declared edits, if the manifest declares any. Never a detection. */
  edits: { by: string | null; list: string[] } | null;
  actions: { label: string; icon: React.ComponentProps<typeof Ionicons>['name']; onPress: () => void }[];
}) {
  const styles = useThemedStyles(buildStyles);
  const [sheet, setSheet] = useState<SheetId>(null);
  const [scene, setScene] = useState<Record<string, boolean>>({});
  const toggleScene = (k: SceneKey) => setScene((o) => ({ ...o, [k]: !o[k] }));

  const ctx = record?.context;
  const loc = ctx?.location && typeof ctx.location === 'object' ? ctx.location : null;
  const pose = ctx?.poseTrace ?? null;
  const level = juxta && juxta.rollDeg != null && juxta.pitchDeg != null
    ? { rollDeg: juxta.rollDeg, pitchDeg: juxta.pitchDeg }
    : null;

  // Scene rows are declared once, each with the condition that makes it
  // real. A row without its input is not rendered.
  const sceneRows: { key: SceneKey; short: string; icon: React.ComponentProps<typeof Ionicons>['name']; label: string; body: React.ReactNode }[] = [];
  const visual = kind !== 'audio';
  const pairsPromised = kind === 'video' && (record?.videoStereo?.pairsCommitted ?? 0) > 0;
  if (visual && (secondary || (videoFrames && videoFrames.length > 0) || secondaryError || pairsPromised)) {
    sceneRows.push({
      key: 'lenses', short: 'two lenses', icon: 'copy-outline', label: 'Parallax between the two lenses',
      body: <MultipleLensCard kind={kind} primaryUri={mediaUri} secondaryFrame={secondary} primaryFrameTimeSeconds={secondaryPts} recordError={secondaryError} videoFrames={videoFrames} />,
    });
  }
  if (kind === 'video') {
    sceneRows.push({
      key: 'motion', short: 'drift', icon: 'pulse-outline', label: 'Picture drift against the gyroscope',
      body: <VideoMotionCard videoFrames={videoFrames} sensorLogPath={ctx?.captureEvidence?.sensorLogPath} hfovDeg={juxta?.hfovDeg ?? null} />,
    });
  } else if (visual && (ctx?.captureEvidence?.ringBufferDir || pose)) {
    sceneRows.push({
      key: 'motion', short: 'motion', icon: 'pulse-outline', label: 'Picture drift against the gyroscope',
      body: <MotionTraceCard ringBufferDir={ctx?.captureEvidence?.ringBufferDir} poseTrace={pose} motion={ctx?.motion ?? null} hfovDeg={juxta?.hfovDeg ?? null} />,
    });
  }
  if (visual && level) {
    sceneRows.push({
      key: 'horizon', short: 'level', icon: 'reorder-two-outline', label: 'Level against gravity from the accelerometer',
      body: <HorizonCard rollDeg={level.rollDeg} pitchDeg={level.pitchDeg} facing={juxta?.facing ?? null} hfovDeg={juxta?.hfovDeg ?? null} frameUri={mediaUri} />,
    });
  }
  if (visual && loc && record?.capturedAt) {
    sceneRows.push({
      key: 'shadows', short: 'shadows', icon: 'sunny-outline', label: 'Shadows from the sealed time and place',
      body: <ShadowCard lat={loc.lat} lon={loc.lon} at={new Date(record.capturedAt)} sealedWhenWhere={sealedWhenWhere} />,
    });
    sceneRows.push({
      key: 'weather', short: 'weather', icon: 'cloud-outline', label: 'Weather archive for that hour',
      body: <EnvironmentCard lat={loc.lat} lon={loc.lon} atIso={record.capturedAt} sealedWhenWhere={sealedWhenWhere} />,
    });
  }
  if (kind !== 'photo' && record) {
    sceneRows.push({
      key: 'audio', short: 'audio master', icon: 'mic-outline', label: 'The uncompressed audio master',
      body: <RawAudioCard kind={kind} rawPcmPath={ctx?.captureEvidence?.rawPcmPath} rawPcmSha256={ctx?.captureEvidence?.rawPcmSha256} enfAnchor={enfAnchor} />,
    });
  }
  const label = useMemo(
    () => deriveLabel({ record, foreign, seal, time, place, identity: signerIdentity, edits }),
    [record, foreign, seal, time, place, signerIdentity, edits],
  );

  const wordStyle = (t: Tone | 'none') =>
    t === 'established' ? styles.wordOk : t === 'attention' ? styles.wordWarn : t === 'broken' ? styles.wordBad : styles.wordDim;

  const questionOf = (id: LabelRow['id']) => label.rows.find((r) => r.id === id)?.question;
  // The identity word the label shows; Anonymous is two words on the label.
  const identityWord = signerIdentity.tag === 'Anonymous'
    ? (signerIdentity.name === 'Removed' ? 'Redacted' : 'Not provided')
    : signerIdentity.tag;
  const altered = seal.media === 'altered';
  const sealLede = label.unsigned ? SEAL_LEDE_NONE : altered ? SEAL_LEDE_ALTERED : record ? SEAL_LEDE_RECORD : SEAL_LEDE_FOREIGN;
  const short = (hex: string | null) => (hex ? `${hex.slice(0, 4)}…${hex.slice(-4)}` : null);
  const clock = (iso: string | null) => {
    if (!iso) return null;
    const d = new Date(iso);
    return isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  };
  const h = (n: number | null) => (n ? n.toLocaleString('en-US') : null);
  const humanAction = (action: string) => {
    const leaf = action.replace(/^c2pa\./, '').replace(/_/g, ' ');
    return leaf.charAt(0).toUpperCase() + leaf.slice(1);
  };

  return (
    <View style={styles.wrap}>
      {label.notice ? <Text style={styles.notice}>{label.notice}</Text> : null}

      <View style={styles.card}>
        {label.rows.map((r, i) => (
          <Pressable
            key={r.id}
            style={[styles.row, i > 0 && styles.rowRule]}
            onPress={() => setSheet(r.id)}
            accessibilityRole="button"
            accessibilityLabel={`${r.question} ${r.answer}. ${r.caption}${r.word ? `. ${r.word}` : ''}`}
          >
            <View style={styles.rowTop}>
              <Text style={styles.question}>{r.question}</Text>
              <View style={styles.rowSide}>
                {r.word ? <Text style={[styles.word, wordStyle(r.tone)]} numberOfLines={1}>{r.word}</Text> : null}
                <Ionicons name="chevron-forward" size={14} color={colors.textFaint} />
              </View>
            </View>
            <Text style={[styles.answer, r.mono && styles.answerMono]} selectable={r.mono}>{r.answer}</Text>
            {r.caption || r.link ? (
              <Text style={styles.caption}>
                {r.caption}
                {r.link ? (
                  <Text style={styles.captionLink} onPress={() => void Linking.openURL(r.link!.url)} accessibilityRole="link">
                    {r.caption ? ' · ' : ''}{r.link.label}{' '}
                    <Ionicons name="open-outline" size={12} color={colors.text} />
                  </Text>
                ) : null}
              </Text>
            ) : null}
          </Pressable>
        ))}
      </View>

      {sceneRows.length > 0 ? (
        <>
          <Text style={styles.sectionLabel}>Scene evidence</Text>
          <View style={styles.card}>
            {sceneRows.map((r, i) => (
              <View key={r.key}>
                {i > 0 ? <Rule /> : null}
                <SceneRow icon={r.icon} label={r.label} open={!!scene[r.key]} onToggle={() => toggleScene(r.key)}>
                  {r.body}
                </SceneRow>
              </View>
            ))}
          </View>
        </>
      ) : null}

      {actions.length > 0 ? (
        <Pressable style={styles.exportButton} onPress={() => setSheet('export')} accessibilityRole="button">
          <Ionicons name="share-outline" size={16} color={colors.text} />
          <Text style={styles.exportLabel}>Export</Text>
        </Pressable>
      ) : null}
      <Pressable style={styles.manifestButton} onPress={() => setSheet('manifest')} accessibilityRole="button">
        <Ionicons name="list-outline" size={16} color={colors.accent} />
        <Text style={styles.manifestLabel}>Everything in the manifest</Text>
      </Pressable>
      <View style={styles.foot} />

      {/* ---- The seal ---- */}
      <ExplainerScreen visible={sheet === 'seal'} title="The seal" sub={questionOf('seal')} lede={sealLede} onClose={() => setSheet(null)}>
        <View style={styles.sheetCard}>
          {altered ? (
            <>
              <Fact label="Bytes" value="Do not match" by={short(seal.fileDigest) ? `sha256 of this file · ${short(seal.fileDigest)}` : undefined} />
              <Fact label="Signed digest" value={short(seal.signedDigest) ?? '—'} by="What the seal covers" mono />
            </>
          ) : label.unsigned ? (
            <Fact label="Seal" value="None" />
          ) : (
            <Fact label="Bytes" value="Match the signature" by={short(seal.signedDigest) ? `sha256 · ${short(seal.signedDigest)}` : undefined} />
          )}
          {!label.unsigned ? (
            <>
              <Fact label="Device key" value={seal.key.value} by={seal.attestation === 'proven' ? 'Proven by Apple App Attest' : seal.attestation === 'refused' ? seal.reason ?? 'Attestation did not verify' : 'No attestation this device can check'} />
              <Fact label="App" value={seal.app.value} by={seal.attestation === 'proven' ? 'This build, this phone, this capture' : undefined} />
              {seal.alg || seal.keyFingerprint ? (
                <Fact label="Signed with" value={seal.alg ?? '—'} by={short(seal.keyFingerprint) ? `key · ${short(seal.keyFingerprint)}` : undefined} />
              ) : null}
              {seal.signer ? <Fact label="Vouched for by" value={seal.signer} /> : null}
            </>
          ) : null}
        </View>
        <SealChart />
        <Pressable style={styles.sheetLink} onPress={() => setSheet('manifest')} accessibilityRole="button">
          <Text style={styles.footLink}>Raw manifest ›</Text>
        </Pressable>
      </ExplainerScreen>

      {/* ---- Timestamp ---- */}
      <ExplainerScreen visible={sheet === 'time'} title="Timestamp" sub={questionOf('time')} lede={TIME_LEDE} onClose={() => setSheet(null)}>
        <View style={styles.sheetCard}><TimeFigure /></View>
        <View style={styles.sheetCard}>
          {time.ledger?.beaconHeight ? (
            <Fact label="Bitcoin block before" value={h(time.ledger.beaconHeight) as string} by="Fetched before signing, hash sealed into the file" mono />
          ) : null}
          {time.authority ? (
            <Fact
              label="Authority"
              value={clock(time.authority.at) ?? '—'}
              by={`${time.authority.name ?? 'Unnamed'} · ${time.authority.trusted ? 'on a pinned list' : 'unlisted, on no list this device carries'}`}
            />
          ) : null}
          {time.ledger && (time.ledger.anchoredHeight || time.ledger.pending) ? (
            <Fact
              label="Bitcoin block after"
              value={time.ledger.anchoredHeight ? (h(time.ledger.anchoredHeight) as string) : 'Awaiting a block'}
              by={time.ledger.anchoredHeight ? 'OpenTimestamps receipt, confirmed' : 'OpenTimestamps receipt, submitted'}
              mono={!!time.ledger.anchoredHeight}
            />
          ) : null}
          <Fact label={record ? 'Phone’s clock' : 'Declared creation'} value={time.signedAt} by={time.established ? 'Reported · inside the window' : DEVICE_REPORTED} />
          {!time.authority && !time.ledger ? <Fact label="Countersignature" value="None" by="Nothing outside the phone confirms this time" /> : null}
        </View>
      </ExplainerScreen>

      {/* ---- Location ---- */}
      <ExplainerScreen visible={sheet === 'place'} title="Location" sub={questionOf('place')} lede={PLACE_LEDE} onClose={() => setSheet(null)}>
        <View style={styles.sheetCard}>
          {place.placeName ? <Fact label="Place" value={place.placeName} by="Named in the file" /> : null}
          {place.coords ? <Fact label="Coordinates" value={place.coords} by={[place.accuracy, record ? 'reported by the phone' : 'declared in the file'].filter(Boolean).join(' · ')} mono /> : null}
          {place.compass ? (
            <View style={styles.compassRow}>
              <Text style={styles.compassLabel}>Compass</Text>
              <View style={styles.compassRight}>
                <Text style={[styles.compassValue, !place.compass.agrees && styles.compassOff]}>{place.compass.sealed}</Text>
                <Text style={[styles.compassDetail, !place.compass.agrees && styles.compassOff]}>{place.compass.detail}</Text>
              </View>
            </View>
          ) : null}
          {typeof ctx?.headingDeg === 'number' ? <Fact label="Heading" value={`${Math.round(ctx.headingDeg)}°`} by="Reported by the phone" /> : null}
        </View>
        <View style={styles.sheetCard}><PlaceFigure /></View>
      </ExplainerScreen>

      {/* ---- Identity ---- */}
      <ExplainerScreen visible={sheet === 'who'} title="Identity" sub={questionOf('who')} lede={IDENTITY_LEDE} onClose={() => setSheet(null)}>
        <View style={styles.sheetCard}>
          <Fact label="Name" value={signerIdentity.name} by={signerIdentity.by ?? undefined} />
          {signerIdentity.org ? <Fact label="Organization" value={signerIdentity.org} /> : null}
          {signerIdentity.domain ? (
            <View style={styles.fact}>
              <Text style={styles.factLabel}>Website</Text>
              <Pressable style={styles.factLink} onPress={() => void Linking.openURL(`https://${signerIdentity.domain}`)} accessibilityRole="link" hitSlop={6}>
                <Text style={styles.factLinkText}>{signerIdentity.domain}</Text>
                <Ionicons name="open-outline" size={12} color={colors.textFaint} />
              </Pressable>
            </View>
          ) : null}
          {seal.keyFingerprint ? <Fact label="Signing key" value={short(seal.keyFingerprint) as string} by="The one identity every file carries" mono /> : null}
        </View>
        {/* The word on the left is the word the label uses. The right side
            says what earns it. "This file" marks the one that applies. */}
        <Text style={styles.figLabel}>What the word means</Text>
        <View style={styles.sheetCard}>
          {([
            ['Verified', 'An authority checked the person'],
            ['Certified', 'An organization’s certificate on a trust list'],
            ['Domain verified', 'A website published the signing key'],
            ['Unverified', 'A name with nothing behind it'],
            ['Not provided', 'No name attached'],
            ['Redacted', 'A name taken out of this copy before sharing'],
          ] as const).map(([word, means]) => (
            <Fact key={word} label={word} value={means} by={identityWord === word ? 'This file' : undefined} />
          ))}
        </View>
      </ExplainerScreen>

      {/* ---- Edits declared ---- */}
      <ExplainerScreen
        visible={sheet === 'edits'}
        title="Edits declared"
        sub={questionOf('edits')}
        lede="Declared by the software that made the file. Nothing here is a detection; an edit that was never declared leaves no trace in this list."
        onClose={() => setSheet(null)}
      >
        <View style={styles.sheetCard}>
          {(manifest?.actions?.list ?? []).filter((a) => !/c2pa\.created$/.test(a.action)).map((a, i) => (
            <Fact key={`${a.action}-${i}`} label={humanAction(a.action)} value={a.action} by={[a.softwareAgent, a.when ? clock(a.when) : null, a.description].filter(Boolean).join(' · ') || undefined} mono />
          ))}
          {edits?.by ? <Fact label="By" value={edits.by} /> : null}
        </View>
      </ExplainerScreen>

      {/* ---- Export ---- */}
      <ExplainerScreen visible={sheet === 'export'} title="Export" onClose={() => setSheet(null)}>
        <View style={styles.sheetCard}>
          {actions.map((a, i) => (
            <View key={a.label}>
              {i > 0 ? <Rule /> : null}
              {/* Close this sheet before the action runs: an action that
                  presents its own sheet cannot do so over this one. */}
              <Pressable style={styles.actionRow} onPress={() => { setSheet(null); setTimeout(a.onPress, 400); }} accessibilityRole="button">
                <Ionicons name={a.icon} size={18} color={colors.textDim} />
                <Text style={styles.actionLabel}>{a.label}</Text>
                <Ionicons name="chevron-forward" size={14} color={colors.textFaint} />
              </Pressable>
            </View>
          ))}
        </View>
      </ExplainerScreen>

      <ManifestSheet record={record} manifest={manifest} visible={sheet === 'manifest'} onClose={() => setSheet(null)} />
    </View>
  );
}

const buildStyles = () =>
  StyleSheet.create({
    /** The body owns its own gutter. A caller that already pads must cancel it. */
    wrap: { paddingHorizontal: spacing.md, paddingTop: spacing.sm },
    card: { backgroundColor: colors.surface, borderRadius: radii.md, paddingHorizontal: spacing.md - 2, paddingTop: 2, paddingBottom: 4 },
    sheetCard: { backgroundColor: colors.surface, borderRadius: radii.md, paddingHorizontal: spacing.md - 2, paddingVertical: spacing.sm, marginBottom: spacing.sm },

    notice: { color: colors.textDim, fontSize: fontSize.sm, paddingHorizontal: 2, paddingTop: spacing.sm, paddingBottom: spacing.sm + 2 },
    exportButton: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      backgroundColor: colors.surface,
      borderRadius: radii.sm + 2,
      paddingVertical: spacing.sm + 4,
      marginTop: spacing.sm + 2,
    },
    exportLabel: { color: colors.text, fontSize: fontSize.sm, fontWeight: '600' },
    manifestButton: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      backgroundColor: colors.accentSoft,
      borderRadius: radii.sm + 2,
      paddingVertical: spacing.sm + 4,
      marginTop: spacing.sm,
    },
    manifestLabel: { color: colors.accent, fontSize: fontSize.sm, fontWeight: '600' },

    sectionLabel: {
      color: colors.textFaint,
      fontSize: 10.5,
      fontWeight: '700',
      letterSpacing: 1.1,
      textTransform: 'uppercase',
      marginTop: spacing.md,
      marginBottom: spacing.sm,
      paddingHorizontal: 2,
    },

    // The word sits on the question line, so the answer and caption get
    // the card's full width. Rows are given room rather than packed.
    row: { paddingTop: spacing.md - 1, paddingBottom: spacing.md },
    rowRule: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
    rowTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm, marginBottom: 5 },
    rowSide: { flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 0 },
    question: { color: colors.textFaint, fontSize: fontSize.xs, fontWeight: '600', flexShrink: 1 },
    answer: { color: colors.text, fontSize: fontSize.lg, fontWeight: '600', lineHeight: 23 },
    answerMono: { fontFamily: type.mono, fontSize: fontSize.md },
    caption: { color: colors.textDim, fontSize: fontSize.sm, lineHeight: 19, marginTop: 4, fontVariant: ['tabular-nums'] },
    captionLink: { color: colors.text, fontWeight: '600' },
    word: { fontSize: fontSize.xs, fontWeight: '700' },
    wordOk: { color: colors.accent },
    wordDim: { color: colors.textDim },
    wordWarn: { color: colors.warn },
    wordBad: { color: colors.danger },

    foot: { height: spacing.md },
    footLink: { color: colors.textDim, fontSize: fontSize.sm - 1, fontWeight: '600' },
    sheetLink: { paddingTop: spacing.sm, paddingHorizontal: 2 },
    figLabel: { color: colors.textFaint, fontSize: 10.5, fontWeight: '700', letterSpacing: 0.9, textTransform: 'uppercase', marginTop: spacing.sm, marginBottom: spacing.sm, paddingHorizontal: 2 },

    compassRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md, paddingVertical: 5 },
    compassLabel: { color: colors.textDim, fontSize: fontSize.sm, flexShrink: 0 },
    compassRight: { flex: 1, alignItems: 'flex-end' },
    compassValue: { color: colors.text, fontSize: fontSize.sm, textAlign: 'right' },
    compassDetail: { color: colors.textFaint, fontSize: fontSize.xs, textAlign: 'right', marginTop: 1 },
    compassOff: { color: colors.warn },
    mapsRow: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingTop: spacing.sm, paddingBottom: 2 },

    // A link that sits where a fact's value sits: right-aligned under the name.
    fact: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md, paddingVertical: 5 },
    factLabel: { color: colors.textDim, fontSize: fontSize.sm, flexShrink: 0 },
    factLink: { flex: 1, flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', gap: 5 },
    factLinkText: { color: colors.text, fontSize: fontSize.sm, textAlign: 'right' },

    actionRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm + 2, paddingVertical: spacing.sm + 2 },
    actionLabel: { flex: 1, color: colors.text, fontSize: fontSize.sm, fontWeight: '500' },
  });

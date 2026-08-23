// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Inspect — check a file against its seal. Mirrors the exhibit details page
 * 1:1: verdict card, one Capture claims card in the exhibit's format (When and
 * where / Device / The seal / Sensors / Camera settings), Capture integrity,
 * the Forensic Checks modules (the same shared cards), the sealing ladder,
 * Signer and Media. Declared edits and the raw manifest sit one drawer down in
 * Full details. All cryptography runs locally.
 */

import React, { useState, useEffect, useRef, useMemo } from 'react';
import { View, Text, StyleSheet, ScrollView, ActivityIndicator, Pressable, LayoutAnimation, Linking } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as DocumentPicker from 'expo-document-picker';
import * as Sharing from 'expo-sharing';
import * as FileSystem from 'expo-file-system/legacy';
import * as Location from 'expo-location';
import { Image } from 'expo-image';
import * as VideoThumbnails from 'expo-video-thumbnails';
import { useVideoPlayer, VideoView } from 'expo-video';
import { Ionicons } from '@expo/vector-icons';

import { colors, spacing, radii, fontSize, type, useThemedStyles } from '../../src/theme';
import { ScreenTitle, Card, Mono, SectionLabel } from '../../src/components/ui';
import { InspectGuide } from '../../src/components/InspectGuide';
import type { AttestationRecord } from '../../src/provenance/manifest';
import type { OtsView } from '../../src/components/TrustedTime';
import {
  MultipleLensCard,
  MotionTraceCard,
  VideoMotionCard,
  EnvironmentCard,
  RawAudioCard,
  type SecondaryFrameRef,
  type EnfAnchor,
} from '../../src/components/forensic';
import {
  verifyPhotoBytes,
  verifyVideoBytes,
  type VerificationReport,
  type VerdictCode,
} from '../../src/c2pa/verifyAsset';
import {
  HorizonLineOverlay,
  GravityPlumbOverlay,
  SunAzimuthOverlay,
  horizonTiltDeg,
  aimDownDeg,
  juxtaInputs,
  compass8,
  type JuxtaInputs,
} from '../../src/components/Juxtapose';
import { solarPosition } from '../../src/reader/verify/solar';
import { getDeviceKey } from '../../src/lib/deviceKey';
import { resolveSignerTrust, type SignerTrust, type TrustTier } from '../../src/lib/trustProvider';
import { projectTrustLadder, type LadderInput, type TrustLadder } from '../../src/lib/trustLadder';
import { TrustLadderCard } from '../../src/components/TrustLadder';
import { listItems } from '../../src/vault/vaultFs';
import { payloadDigest } from '../../src/lib/sign';
import { bytesToHex, base64ToBytes, bytesToBase64 } from '../../src/lib/bytes';
import { verifyOtsReceipt } from '../../src/lib/ots';
import { fetchBlockHeader } from '../../src/lib/otsClient';
import { extractC2paStore, parseManifest, type C2paManifest, type EditAction, type IngredientInfo } from '../../src/c2pa/c2pa';
import { extractC2paStoreBmff } from '../../src/c2pa/bmff';
import { ManifestReel } from '../../src/components/ManifestReel';
import { readFileBytes, writeFileBytes } from '../../src/lib/fileHash';

// ---------------------------------------------------------------------------
// Verdict language.
// ---------------------------------------------------------------------------

interface VerdictContext {
  /** Who vouches for the signing key. Anchors live outside the file. */
  tier: TrustTier;
  /** Roster says the capture was signed after revocation / before joining. */
  rosterRedFlag: boolean;
  /** Display names resolved by the caller, when the tier carries them. */
  signerName?: string | null;
  voucherName?: string | null;
  orgName?: string | null;
  /**
   * The binding is void: the exclusions exempt the hash input, the exclusion
   * set is malformed, or the signed claim references no media binding, so the
   * signature verifies but commits to nothing.
   */
  bindingVoid: boolean;
}

/**
 * The headline is a function of the math and the trust tier together: green
 * requires both a verifying file and an outside vouch for the key. Seven
 * verdicts.
 */
function verdictCopy(v: VerdictCode, ctx: VerdictContext): { headline: string; subline: string; tone: 'good' | 'bad' | 'warn' | 'neutral'; icon: keyof typeof Ionicons.glyphMap } {
  switch (v) {
    case 'INTACT': {
      if (ctx.rosterRedFlag) {
        return {
          headline: 'Unchanged since sealing · signed after revocation',
          subline: 'The file hasn’t changed, but the key was revoked from its roster, or not yet valid, when this was signed. A genuine capture by this member would not look like this.',
          tone: 'bad',
          icon: 'warning-outline',
        };
      }
      if (ctx.tier === 'roster' || ctx.tier === 'trust-list') {
        return {
          headline: 'Unchanged since sealing.',
          subline: `Sealed by ${ctx.signerName ?? 'a known signer'}, certified by ${ctx.voucherName ?? 'a certificate authority'}.`,
          tone: 'good',
          icon: 'checkmark-circle',
        };
      }
      if (ctx.tier === 'org') {
        return {
          headline: 'Unchanged since sealing. The organization vouches for itself.',
          subline: `Ask ${ctx.orgName ?? 'the organization'} for their fingerprint directly and compare all 64 characters. A signer can claim any name.`,
          tone: 'warn',
          icon: 'business-outline',
        };
      }
      return {
        headline: 'Unchanged since sealing. Signer unknown.',
        subline: 'The signature is valid. Whose key it is, nothing here says.',
        tone: 'warn',
        icon: 'finger-print-outline',
      };
    }
    case 'CONTENT_MODIFIED':
      return {
        headline: 'Edited after sealing',
        subline: 'The seal holds. The pixels no longer match it. Keep the file; don’t re-save or re-share it.',
        tone: 'bad',
        icon: 'cut-outline',
      };
    case 'SIGNATURE_INVALID':
      if (ctx.bindingVoid) {
        return {
          headline: 'The seal covers no pixels',
          subline: 'A valid signature attached to nothing. Treat this file as unsealed.',
          tone: 'bad',
          icon: 'close-circle-outline',
        };
      }
      return {
        headline: 'The seal doesn’t hold',
        subline: 'Treat this file as unsealed. Keep the file; don’t re-save or re-share it.',
        tone: 'bad',
        icon: 'close-circle-outline',
      };
    case 'UNSUPPORTED':
      // The credentials use a structure this build cannot evaluate. Neutral,
      // like unreadable.
      return {
        headline: 'Can’t check this one',
        subline: 'This build doesn’t read this seal’s structure. Unchecked, not rejected.',
        tone: 'neutral',
        icon: 'alert-circle-outline',
      };
    case 'NO_ATTESTATION':
      // Unsigned is the normal state for most photos: gray, not amber or red.
      // Red is for proven tamper.
      return {
        headline: 'No seal on this file',
        subline: 'Most photos don’t have one, and messaging apps strip the ones that do.',
        tone: 'neutral',
        icon: 'help-circle-outline',
      };
    default:
      return {
        headline: 'Couldn’t open this file',
        subline: 'Messaging apps and social platforms re-encode images, which destroys the seal. Ask for the file straight off the camera or phone: AirDrop, email, or a file transfer.',
        tone: 'neutral',
        icon: 'alert-circle-outline',
      };
  }
}

function toneColor(tone: 'good' | 'bad' | 'warn' | 'neutral'): string {
  return tone === 'good' ? colors.accent : tone === 'bad' ? colors.danger : tone === 'warn' ? colors.warn : colors.textDim;
}

function fmtWhen(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** "Aug 15, 2026 at 6:08 PM": the timestamp row's date shape. Same formatter
 *  as the exhibit page's Timestamp row; keep the two 1:1. */
function fmtAt(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const date = d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `${date} at ${time}`;
}

function fmtBytes(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)} MB`;
  if (n >= 1_000) return `${Math.round(n / 1_000)} KB`;
  return `${n} bytes`;
}

function motionLabel(v: string): string {
  switch (v) {
    case 'handheld': return 'Handheld motion';
    case 'steady': return 'Device still';
    case 'moving': return 'Device moving';
    default: return 'Insufficient data';
  }
}


/**
 * The committed second-camera frame for the MultipleLensCard: the photo stereo
 * section's secondary frame, or the first recorded video pair's frame with its
 * PTS anchor. Hash-committed states are mirrored rather than recomputed; the
 * card decodes the committed bytes. Same derivation as the exhibit page, and
 * the frame rides inside the signed record, so a dropped file carries it.
 */
function secondaryFrameFor(record: AttestationRecord): { frame: SecondaryFrameRef | null; ptsSeconds: number | null; recordError: string | null; videoFrames: import('../../src/components/forensic/MultipleLensCard').VideoPairFrameRef[] | null } {
  if (record.asset.kind === 'photo') {
    const f = record.stereo?.artifacts?.secondaryFrame;
    if (f?.state === 'recorded' && f.dataBase64) {
      return { frame: { dataBase64: f.dataBase64, mime: f.mime, sha256: f.sha256 }, ptsSeconds: null, recordError: null, videoFrames: null };
    }
    return { frame: null, ptsSeconds: null, recordError: f?.state === 'error' ? f.error ?? 'the native module reported an error' : null, videoFrames: null };
  }
  if (record.asset.kind === 'video') {
    // Every recorded pair frame: the filmstrip surface.
    const recordedPairs = (record.videoStereo?.pairs ?? []).filter(
      (p) => p.artifacts?.secondaryFrame?.state === 'recorded' && !!p.artifacts.secondaryFrame.dataBase64,
    );
    const videoFrames = recordedPairs.map((p) => {
      const f = p.artifacts.secondaryFrame;
      return {
        frame: { dataBase64: f.dataBase64!, mime: f.mime, sha256: f.sha256 },
        pairIndex: p.pairIndex,
        // The pair's own primary PTS anchor; a filmstrip tap re-seeks the
        // blend's primary frame to that pair's moment.
        ptsSeconds: p.anchors.primaryHostSeconds ?? null,
      };
    });
    const pair = recordedPairs[0];
    const f = pair?.artifacts.secondaryFrame;
    if (f?.state === 'recorded' && f.dataBase64) {
      return {
        frame: { dataBase64: f.dataBase64, mime: f.mime, sha256: f.sha256 },
        ptsSeconds: pair?.anchors.primaryHostSeconds ?? null,
        recordError: null,
        videoFrames: videoFrames.length > 0 ? videoFrames : null,
      };
    }
    // A committed pair whose frame errored is a stated failure; zero committed
    // pairs is an unreached state, shown as "Not recorded".
    const errPair = record.videoStereo?.pairs?.find((p) => p.artifacts?.secondaryFrame?.state === 'error');
    const ef = errPair?.artifacts.secondaryFrame;
    return {
      frame: null,
      ptsSeconds: null,
      recordError: ef?.state === 'error' ? ef.error ?? 'the native module reported an error' : null,
      videoFrames: null,
    };
  }
  return { frame: null, ptsSeconds: null, recordError: null, videoFrames: null };
}

/**
 * Video pair frames for an exported file. The sealed telemetry record does not
 * carry them (they ride the proof bundle on-device); in the file they are the
 * c2pa.thumbnail.ingredient.jpeg{.#} boxes, one per committed pair, and each
 * embedded frame is the vaulted pair JPEG since the ingredient's data hash
 * commits exactly those bytes. Referenced-gated, because an unreferenced box is
 * not claim content, and labeled by the capture-side pair sequence number from
 * the label suffix or the ingredient title. Absent boxes stay "Not recorded".
 */
function manifestSecondaryFrames(manifest: C2paManifest): import('../../src/components/forensic/MultipleLensCard').VideoPairFrameRef[] {
  const titlePairIndex = new Map<string, number>();
  for (const ing of manifest.ingredients) {
    const m = ing.title ? /pair #(\d+)/.exec(ing.title) : null;
    if (m && ing.label) {
      // The ingredient's thumbnail identifier is the ingredient label with
      // the 'c2pa.ingredient.v3' prefix swapped for the thumbnail prefix —
      // same suffix by emission construction.
      const suffix = /\.(\d+)$/.exec(ing.label ?? '')?.[0] ?? '';
      titlePairIndex.set(suffix, parseInt(m[1], 10));
    }
  }
  const frames: import('../../src/components/forensic/MultipleLensCard').VideoPairFrameRef[] = [];
  for (const t of manifest.thumbnails) {
    if (!t.referenced) continue;
    if (!t.label.startsWith('c2pa.thumbnail.ingredient.jpeg')) continue;
    if (t.bytes.length === 0) continue;
    const suffix = /\.(\d+)$/.exec(t.label)?.[0] ?? '';
    const pairIndex = titlePairIndex.get(suffix)
      ?? (suffix ? parseInt(suffix.slice(1), 10) : 0);
    frames.push({
      frame: { dataBase64: bytesToBase64(t.bytes), mime: 'image/jpeg' },
      pairIndex,
    });
  }
  frames.sort((a, b) => a.pairIndex - b.pairIndex);
  return frames;
}

/**
 * ENF anchor fields (firstSampleWallClockUtcMs / sampleRate / sampleCount) may
 * be absent on a record, so read tolerantly from the plausible homes and omit
 * the row when missing. Same reader the exhibit page uses.
 */
function readEnfAnchor(record: AttestationRecord): EnfAnchor | null {
  const top = record as unknown as Record<string, unknown>;
  const ctx = record.context as unknown as Record<string, unknown> | undefined;
  const cand = top.enfAnchor ?? top.audioEnfAnchor ?? ctx?.enfAnchor ?? ctx?.audioEnfAnchor;
  if (cand && typeof cand === 'object') {
    const c = cand as Record<string, unknown>;
    if (
      typeof c.firstSampleWallClockUtcMs === 'number' &&
      typeof c.sampleRate === 'number' &&
      typeof c.sampleCount === 'number'
    ) {
      return {
        firstSampleWallClockUtcMs: c.firstSampleWallClockUtcMs,
        sampleRate: c.sampleRate,
        sampleCount: c.sampleCount,
      };
    }
  }
  return null;
}

/** Round to `sig` significant digits; trailing zeros drop via Number. */
function sigFig(v: number, sig: number): number {
  if (v === 0) return 0;
  const d = Math.ceil(Math.log10(Math.abs(v)));
  const f = Math.pow(10, sig - d);
  return Math.round(v * f) / f;
}

/** Camera-settings labels: the signed key names, made readable. */
const EXIF_LABELS: Record<string, string> = {
  ExposureBiasValue: 'ExposureBias',
  FocalLengthIn35mmFilm: 'FocalLength (35mm equiv)',
  'FocalLength(35mmEquiv)': 'FocalLength (35mm equiv)',
  ISOSpeedRatings: 'ISO',
};

/**
 * Significant figures for the camera-settings rows: 1/120 s rather than
 * 0.0083333, integer ISO, f/1.8 rather than 1.7999999523162842. Same formatting
 * as the exhibit page's Camera Settings (Device-reported) block.
 */
function formatExifValue(key: string, v: unknown): string {
  const num = typeof v === 'number' && Number.isFinite(v) ? v : null;
  if (num === null) return String(v);
  switch (key) {
    case 'ExposureTime':
      return num > 0 && num < 1 ? `1/${Math.round(1 / num)} s` : `${sigFig(num, 3)} s`;
    case 'ShutterSpeedValue': {
      // APEX: exposure time = 2^-value.
      const t = Math.pow(2, -num);
      return t > 0 && t < 1 ? `1/${Math.round(1 / t)} s` : `${sigFig(t, 3)} s`;
    }
    case 'ISO':
    case 'ISOSpeedRatings':
      return String(Math.round(num));
    case 'FNumber':
      return `f/${sigFig(num, 2)}`;
    case 'ApertureValue':
      // APEX: f-number = 2^(value/2).
      return `f/${sigFig(Math.pow(2, num / 2), 2)}`;
    case 'ExposureBiasValue':
      return `${sigFig(num, 2)} EV`;
    case 'FocalLength':
    case 'FocalLengthIn35mmFilm':
    case 'FocalLength(35mmEquiv)':
      return `${sigFig(num, 3)} mm`;
    case 'DigitalZoomRatio':
      return `${sigFig(num, 2)}×`;
    default:
      return String(sigFig(num, 3));
  }
}

// ---------------------------------------------------------------------------
// Standard C2PA edit history: humanized action names and icons.
// ---------------------------------------------------------------------------

/** 'c2pa.color_adjustments' → 'Color adjusted'; unknown vendor actions pass through, capitalized. */
function actionLabel(name: string): string {
  const bare = name.replace(/^c2pa\./, '').replace(/[_.-]+/g, ' ').trim();
  const known: Record<string, string> = {
    created: 'Created',
    opened: 'Opened',
    edited: 'Edited',
    cropped: 'Cropped',
    resized: 'Resized',
    'color adjustments': 'Color adjusted',
    orientation: 'Orientation changed',
    reformatted: 'Converted to a new format',
    filtered: 'Filter applied',
    placed: 'Placed into a layout',
    drawing: 'Drawing or paint added',
    composited: 'Combined with other media',
    redacted: 'Content redacted',
    deleted: 'Content deleted',
    published: 'Published',
    produced: 'Produced',
    assembled: 'Assembled',
    transcoded: 'Transcoded',
    repackaged: 'Repackaged',
    saved: 'Saved',
    printed: 'Printed',
    watermarked: 'Watermarked',
    unknown: 'Unspecified edit',
  };
  return known[bare] ?? (bare ? bare.charAt(0).toUpperCase() + bare.slice(1) : 'Unspecified edit');
}

function actionIcon(name: string): keyof typeof Ionicons.glyphMap {
  const bare = name.replace(/^c2pa\./, '');
  if (bare === 'created') return 'add-circle-outline';
  if (bare === 'cropped') return 'crop-outline';
  if (bare.includes('color')) return 'color-palette-outline';
  if (bare === 'composited' || bare === 'placed' || bare === 'assembled') return 'layers-outline';
  if (bare === 'redacted' || bare === 'deleted') return 'eye-off-outline';
  if (bare === 'reformatted' || bare === 'transcoded' || bare === 'repackaged') return 'swap-horizontal-outline';
  if (bare === 'published' || bare === 'printed') return 'share-outline';
  return 'pencil-outline';
}

// ---------------------------------------------------------------------------
// The label
// ---------------------------------------------------------------------------

function LabelRow({ label, value, valueColor, detail, detailColor, mono, children }: {
  label: string;
  value: string;
  valueColor?: string;
  detail?: string;
  detailColor?: string;
  mono?: boolean;
  children?: React.ReactNode;
}) {
  const styles = useThemedStyles(buildStyles);
  return (
    <View style={styles.labelRow}>
      <Text style={styles.labelRowLabel}>{label}</Text>
      <View style={styles.labelRowValueWrap}>
        <Text
          style={[styles.labelRowValue, mono ? { fontFamily: type.mono } : null, valueColor ? { color: valueColor } : null]}
          selectable
        >
          {value}
        </Text>
        {detail ? (
          <Text style={[styles.labelRowDetail, detailColor ? { color: detailColor } : null]}>{detail}</Text>
        ) : null}
        {children}
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// The collapsible group card. Same pattern as the exhibit details page's
// Capture / Integrity / Advanced cards: icon, title, chevron, a one-line peek,
// and the whole header block as the tap target.
// ---------------------------------------------------------------------------

function GroupCard({ icon, title, peek, open, onToggle, children }: {
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  peek: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  const styles = useThemedStyles(buildStyles);
  return (
    <View style={styles.groupCard}>
      <Pressable style={styles.groupHeadBlock} onPress={onToggle} accessibilityLabel={`${title} section`} accessibilityRole="button">
        <View style={styles.groupHead}>
          <Ionicons name={icon} size={15} color={colors.textDim} />
          <Text style={styles.groupTitle}>{title}</Text>
          <Ionicons name={open ? 'chevron-down' : 'chevron-forward'} size={14} color={colors.textFaint} />
        </View>
        <Text style={styles.groupPeek}>{peek}</Text>
      </Pressable>
      {open ? <View style={styles.groupBody}>{children}</View> : null}
    </View>
  );
}

/** Muted clay: the identifying accent, matching the exhibit page's
 *  HUD.identifying (the Location row's value color). */
const IDENT_CLAY = '#C08552';

/** Bitcoin calendar row value: the same strings the exhibit page's
 *  TimestampBlock derives, minus the row-label prefix. Keep the two 1:1. */
function bitcoinCalendarValue(ots: OtsView): { text: string; color?: string } {
  switch (ots.state) {
    case 'pending':
      return {
        text:
          'stamp pending, not yet confirmed in a block' +
          (ots.queueDelayMs !== undefined && ots.queueDelayMs > 60_000
            ? ` · submitted ${Math.round(ots.queueDelayMs / 60_000)} min late (device was offline)`
            : ''),
      };
    case 'invalid':
      return { text: 'receipt FAILED verification', color: colors.danger };
    case 'mismatch':
      return { text: 'receipt commits to a different record', color: colors.danger };
    default:
      if (ots.binding === 'verified') {
        return { text: `confirmed in block #${ots.height ?? '—'} · receipt matches the block`, color: colors.accent };
      }
      if (ots.binding === 'failed') {
        return { text: `receipt does NOT match block #${ots.height ?? '—'}`, color: colors.danger };
      }
      return {
        text: ots.height
          ? `anchored in block #${ots.height} · confirmation not fetched (offline)`
          : 'confirmed on-chain · block binding unchecked',
      };
  }
}

/**
 * The seal rows: the manifest lines in the Capture claims card, in the exhibit
 * page's row format. Each row carries its own detail copy, so a failure says
 * what failed.
 */
function SealRows({ report }: { report: VerificationReport }) {
  const c2pa = report.c2pa;
  const rec = report.record;
  const attest = c2pa?.appAttest;
  const attestText = !attest || !attest.present
    ? 'Not present in this file'
    : attest.valid
      ? `Passed · Apple App Attest${attest.attestationEnv ? ` (${attest.attestationEnv} authenticator)` : ''}`
      : `Failed · ${attest.reason ?? 'the embedded assertion did not verify'}`;
  const attestDetail = !attest || !attest.present
    ? 'No Apple device-integrity assertion rides inside this file.'
    : attest.valid
      ? "Apple's device-integrity assertion rides inside the signed file; checkable offline against Apple's root."
      : 'The hardware check failed. A Source Kit attestation can be checked offline against Apple’s root.';
  const chain = c2pa?.certChain;
  // checked === false means this verifier could not evaluate the chain at all
  // (unsupported structure or algorithm). Shown in neutral words; red is
  // reserved for chains that parsed and failed cryptographically.
  const chainUnchecked = !!chain && chain.checked === false;
  const chainText = !chain
    ? 'Device key, self-signed · no organization credential'
    : chainUnchecked
      ? `${chain.length} certificate${chain.length === 1 ? '' : 's'} · structure not checkable by this build${chain.topSubject ? ` · top: ${chain.topSubject}` : ''}`
      : `${chain.length} certificate${chain.length === 1 ? '' : 's'} · structure ${chain.linksValid ? 'valid' : 'INVALID'}${chain.topSubject ? ` · top: ${chain.topSubject}` : ''}`;
  const chainFailed = !!chain && chain.length > 1 && !chain.linksValid && !chainUnchecked;
  const chainDetail = !chain || chain.length <= 1
    ? 'Device-issued and self-signed: the seal holds, but who the key belongs to is not shown. External tools read "valid signature, untrusted issuer"; expected for any device certificate.'
    : chainUnchecked
      ? `${chain.reason ?? 'This build cannot parse the chain.'} That is a limitation of this verifier — it is not a finding against the file.`
      : chain.linksValid
        ? 'Structurally valid, ending at a self-asserted root. The certificates link correctly; that the CA vouches for the key can only be checked out of band, against the organization’s published fingerprint.'
        : `${chain.reason ?? 'The chain failed verification.'} The signer-identity claims cannot be checked.`;
  const pq = c2pa?.pq;
  const pqAny = pq?.claim?.present || pq?.record?.present;
  const pqOk = (pq?.claim?.present ? pq.claim.signatureValid && pq.claim.keyFingerprintMatches : true) &&
    (pq?.record ? pq.record.signatureValid && pq.record.keyFingerprintMatches : true);
  const pqText = !pqAny
    ? 'None on this file'
    : pqOk
      ? 'ML-DSA-65 dual signature valid · software-key custody, not a hardware anchor'
      : 'ML-DSA-65 layer FAILED · the raw manifest has the bytes';
  return (
    <View>
      <LabelRow label="Signed with" value="ES256 · ECDSA P-256 over a COSE claim" />
      <LabelRow
        label="Hardware attestation"
        value={attestText}
        valueColor={attest?.present && !attest.valid ? colors.danger : undefined}
        detail={attestDetail}
        detailColor={attest?.present && !attest.valid ? colors.danger : undefined}
      />
      <LabelRow
        label="Credential chain"
        value={chainText}
        valueColor={chainFailed ? colors.danger : undefined}
        detail={chainDetail}
        detailColor={chainFailed ? colors.danger : undefined}
      />
      <LabelRow
        label="Post-quantum layer"
        value={pqText}
        valueColor={pqAny && !pqOk ? colors.danger : undefined}
      />
      {rec ? (
        <LabelRow label="Media SHA-256" value={rec.asset.sha256} mono detail="The exact bytes that were signed." />
      ) : null}
    </View>
  );
}

// Signer identity resolves against anchors outside the file, through the
// TrustProvider chain: this device, signed newsroom roster, org credential
// chain, then 'unknown'. Four tiers, four distinct display states. A curated
// C2PA trust list slots in above roster. The roster is editor-signed,
// revocable, and evaluated at the verified signing time.

type EditHistoryView = {
  generator: string | null;
  manifestCount: number;
  actions: { list: EditAction[]; referenced: boolean } | null;
  ingredients: (IngredientInfo & { referenced: boolean })[];
};

function VerdictCard({ report, identity, ladder }: { report: VerificationReport; identity: SignerTrust; ladder: TrustLadder | null }) {
  const styles = useThemedStyles(buildStyles);
  // Byline and org live on the seal record's identity block (or 'redacted'),
  // not on the c2pa summary.
  const sealedIdentity =
    report.record && report.record.identity !== 'redacted' ? report.record.identity : null;
  let copy = verdictCopy(report.verdict, {
    tier: identity.tier,
    rosterRedFlag:
      identity.tier === 'roster' &&
      !!identity.roster &&
      (identity.roster.state === 'revoked' || identity.roster.state === 'not-yet-valid'),
    signerName:
      identity.tier === 'roster'
        ? identity.roster?.entry.name ?? null
        : (sealedIdentity?.author ?? report.record?.device?.model ?? null),
    voucherName:
      identity.tier === 'roster'
        ? identity.roster?.roster.newsroom ?? null
        : identity.tier === 'trust-list'
          ? report.c2pa?.certChain?.topSubject ?? 'a curated trust list'
          : null,
    orgName: identity.tier === 'org' ? report.c2pa?.certChain?.topSubject ?? sealedIdentity?.organization ?? null : null,
    bindingVoid: report.c2pa?.assetHashFailure === 'void-binding',
  });
  // ── Headline/rung coherence ──────────────────────────────────
  // verdictCopy keys on the verdict code alone; the ladder sees the rungs.
  // A failed rung dominates the headline and tone, and "unchanged"-style
  // headlines require rung 1 to be reached.
  const failedRung = ladder?.rungs.find((r) => r.state === 'failed') ?? null;
  const bytesRungUnreached = ladder?.rungs[0]?.state === 'unreached';
  if (failedRung && copy.tone !== 'bad') {
    copy = {
      headline: `A check failed: ${failedRung.label.charAt(0).toLowerCase()}${failedRung.label.slice(1)}`,
      subline: `${failedRung.detail} The media itself ${report.checks.assetHashMatches === true ? 'still matches the seal' : 'could not be confirmed against the seal'} `,
      tone: 'bad',
      icon: 'warning-outline',
    };
  } else if (bytesRungUnreached && (copy.tone === 'good' || copy.tone === 'warn')) {
    copy = {
      ...copy,
      subline: `${copy.subline} Not every check ran on this file — the rungs below say which.`,
    };
  }
  const color = toneColor(copy.tone);
  return (
    <Card style={[styles.labelCard, { borderColor: color }]}>
      <View style={styles.verdictHeader}>
        <Ionicons name={copy.icon} size={28} color={color} />
        <Text style={[styles.verdictText, { color }]}>{copy.headline}</Text>
      </View>
      <Text style={styles.verdictSubline}>{copy.subline}</Text>
    </Card>
  );
}

/**
 * The picked file, shown at the top of its own result: a photo renders as the
 * image, a video renders a still frame, and an audio-only container gets a
 * placeholder. The picked URI is already local (document-picker cache copy).
 */
/** Video playback: a tap on the still swaps in the real player with native
 *  controls, so the OS handles fullscreen and rotation, the same contract as
 *  the exhibit page's viewer. The forensic overlays annotate the still;
 *  playback replaces it rather than drawing over moving video. */
function InspectVideoPlayer({ uri, style }: { uri: string; style: object }) {
  const player = useVideoPlayer(uri, (p) => {
    p.loop = false;
    p.play();
  });
  return <VideoView player={player} style={style} contentFit="contain" nativeControls />;
}

function PickedMedia({ uri, name, kind, audioHint, overlay, onOverlay, juxta, fallbackUri }: {
  uri: string;
  name: string;
  kind: 'photo' | 'bmff';
  audioHint: boolean | null;
  overlay: string;
  onOverlay: (key: string) => void;
  juxta: JuxtaInputs | null;
  /** The manifest's own embedded claim thumbnail, materialized to cache: the
   *  preview when this device cannot extract a frame from the container.
   *  Referenced-gated. */
  fallbackUri?: string | null;
}) {
  const styles = useThemedStyles(buildStyles);
  const [thumb, setThumb] = useState<string | null>(null);
  const [thumbFailed, setThumbFailed] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [playing, setPlaying] = useState(false);
  useEffect(() => {
    if (kind !== 'bmff' || audioHint === true) return;
    let mounted = true;
    setThumb(null);
    setThumbFailed(false);
    setPlaying(false);
    // Try several offsets before declaring no frame: a fixed 250 ms seek fails
    // on very short takes and on containers AVFoundation seeks poorly in.
    (async () => {
      for (const time of [250, 0, 1000]) {
        try {
          const t = await VideoThumbnails.getThumbnailAsync(uri, { time });
          if (mounted) setThumb(t.uri);
          return;
        } catch { /* try the next offset */ }
      }
      if (mounted) setThumbFailed(true);
    })();
    return () => { mounted = false; };
  }, [uri, kind, audioHint]);

  const placeholderIcon =
    audioHint === true ? 'mic-outline' : audioHint === false ? 'videocam-outline' : 'document-outline';

  // The overlay dropdown. Clean is always the default. Horizon and Gravity need
  // the sealed attitude; Sun needs the sealed when/where, and its on-photo
  // arrow also needs the sealed heading (without one only the text badge
  // renders). An option whose inputs were not sealed does not appear.
  const options: { key: string; label: string }[] = [{ key: 'clean', label: 'Clean' }];
  if (juxta?.rollDeg != null && juxta?.pitchDeg != null) options.push({ key: 'horizon', label: 'Horizon' });
  if (juxta?.lat != null && juxta?.lon != null && juxta?.at) options.push({ key: 'sun', label: 'Sun position' });
  if (juxta?.rollDeg != null && juxta?.pitchDeg != null) options.push({ key: 'gravity', label: 'Gravity' });
  const active = options.find((o) => o.key === overlay) ?? options[0];
  const showOverlays = !playing && (kind === 'photo' || (kind === 'bmff' && audioHint !== true && (!!thumb || (thumbFailed && !!fallbackUri))));

  return (
    <Card style={styles.mediaCard}>
      <View style={styles.mediaFrame}>
        {kind === 'photo' ? (
          <Image source={{ uri }} style={styles.mediaStill} contentFit="contain" transition={100} />
        ) : audioHint === true ? (
          <View style={[styles.mediaStill, styles.mediaPlaceholder]}>
            <Ionicons name={placeholderIcon} size={30} color={colors.textFaint} />
            <Text style={styles.mediaPlaceholderText}>Audio file · no frame to show</Text>
          </View>
        ) : playing ? (
          <InspectVideoPlayer uri={uri} style={styles.mediaStill} />
        ) : thumbFailed && fallbackUri ? (
          <Pressable onPress={() => setPlaying(true)} accessibilityLabel="Play the video">
            <Image source={{ uri: fallbackUri }} style={styles.mediaStill} contentFit="contain" transition={100} />
            <View style={styles.playBadge} pointerEvents="none">
              <Ionicons name="play" size={26} color="#E8E8EC" />
            </View>
          </Pressable>
        ) : thumbFailed ? (
          // No still to show, so offer playback directly.
          <Pressable
            style={[styles.mediaStill, styles.mediaPlaceholder]}
            onPress={() => setPlaying(true)}
            accessibilityLabel="Play the video"
          >
            <Ionicons name="play-circle-outline" size={34} color={colors.textFaint} />
            <Text style={styles.mediaPlaceholderText}>Tap to play</Text>
          </Pressable>
        ) : thumb ? (
          <Pressable onPress={() => setPlaying(true)} accessibilityLabel="Play the video">
            <Image source={{ uri: thumb }} style={styles.mediaStill} contentFit="contain" transition={100} />
            <View style={styles.playBadge} pointerEvents="none">
              <Ionicons name="play" size={26} color="#E8E8EC" />
            </View>
          </Pressable>
        ) : (
          <View style={[styles.mediaStill, styles.mediaPlaceholder]}>
            <ActivityIndicator color={colors.accent} />
          </View>
        )}
        {showOverlays && active.key === 'horizon' && juxta?.rollDeg != null && juxta?.pitchDeg != null ? (
          <HorizonLineOverlay rollDeg={juxta.rollDeg} pitchDeg={juxta.pitchDeg} />
        ) : null}
        {showOverlays && active.key === 'gravity' && juxta?.rollDeg != null && juxta?.pitchDeg != null ? (
          <>
            {/* The plumb line annotates the photo; the badge carries the
                numbers, from the same sealed line as the horizon card. */}
            <GravityPlumbOverlay rollDeg={juxta.rollDeg} pitchDeg={juxta.pitchDeg} />
            <View style={styles.overlayBadge}>
              <Text style={styles.overlayBadgeText}>
                Tilt {Math.abs(horizonTiltDeg(juxta.rollDeg, juxta.pitchDeg)).toFixed(1)}° · aimed {aimDownDeg(juxta.rollDeg, juxta.pitchDeg) >= 0 ? 'down' : 'up'} {Math.abs(aimDownDeg(juxta.rollDeg, juxta.pitchDeg)).toFixed(1)}°
              </Text>
            </View>
          </>
        ) : null}
        {showOverlays && active.key === 'sun' && juxta?.lat != null && juxta?.lon != null && juxta?.at ? (
          juxta.headingDeg != null ? (
            <>
              <SunAzimuthOverlay lat={juxta.lat} lon={juxta.lon} at={juxta.at} headingDeg={juxta.headingDeg} />
              <SunBadge lat={juxta.lat} lon={juxta.lon} at={juxta.at} />
            </>
          ) : (
            <SunBadge lat={juxta.lat} lon={juxta.lon} at={juxta.at} />
          )
        ) : null}
        {showOverlays && options.length > 1 ? (
          <View style={styles.overlayMenuWrap}>
            <Pressable style={styles.overlayChip} onPress={() => setMenuOpen((o) => !o)} hitSlop={8}>
              <Text style={styles.overlayChipText}>{active.label} ▾</Text>
            </Pressable>
            {menuOpen ? (
              <View style={styles.overlayMenu}>
                {options.map((o) => (
                  <Pressable
                    key={o.key}
                    style={styles.overlayMenuItem}
                    onPress={() => { onOverlay(o.key); setMenuOpen(false); }}
                    hitSlop={4}
                  >
                    <Text style={[styles.overlayMenuText, o.key === active.key && { color: colors.accent }]}>
                      {o.key === active.key ? '✓ ' : '  '}{o.label}
                    </Text>
                  </Pressable>
                ))}
              </View>
            ) : null}
          </View>
        ) : null}
      </View>
      <Text style={styles.mediaName} numberOfLines={1}>{name}</Text>
    </Card>
  );
}

/** Sun-position badge: elevation and compass bearing for the sealed when/where. */
function SunBadge({ lat, lon, at }: { lat: number; lon: number; at: Date }) {
  const styles = useThemedStyles(buildStyles);
  const pos = solarPosition(lat, lon, at);
  const up = pos.elevationDeg >= 0;
  return (
    <View style={styles.overlayBadge}>
      <Text style={styles.overlayBadgeText}>
        {up
          ? `Sun ${pos.elevationDeg.toFixed(0)}° up, ${compass8(pos.azimuthDeg)}`
          : 'Sun below the horizon'}
      </Text>
    </View>
  );
}

export default function InspectScreen() {
  const styles = useThemedStyles(buildStyles);
  const [busy, setBusy] = useState<string | null>(null);
  const [report, setReport] = useState<VerificationReport | null>(null);
  // Neutral "can't read this format" card; not an error state.
  const [note, setNote] = useState<string | null>(null);
  const [ownFingerprint, setOwnFingerprint] = useState<string | null>(null);
  const [identity, setIdentity] = useState<SignerTrust>({ tier: 'unknown' });
  // The file under inspection, shown at the top of the result.
  const [picked, setPicked] = useState<{ uri: string; name: string; kind: 'photo' | 'bmff'; audioHint: boolean | null } | null>(null);
  // The parsed manifest, feeding the Advanced group's raw-manifest reel (the
  // shared ManifestReel component, full and windowed).
  const [parsedManifest, setParsedManifest] = useState<C2paManifest | null>(null);
  // Group cards: the same Capture / Integrity / Advanced pattern and icons as
  // the exhibit details page.
  const [groupOpen, setGroupOpen] = useState({ capture: true, integrity: false, advanced: false });
  const toggleGroup = (id: 'capture' | 'integrity' | 'advanced') => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setGroupOpen((s) => ({ ...s, [id]: !s[id] }));
  };
  // Standard C2PA edit history (c2pa.actions / ingredients) from the active
  // manifest. This is where a Canon-to-Photoshop file's edits surface.
  const [editHistory, setEditHistory] = useState<{
    generator: string | null;
    manifestCount: number;
    actions: { list: EditAction[]; referenced: boolean } | null;
    ingredients: (IngredientInfo & { referenced: boolean })[];
  } | null>(null);
  // Camera settings (com.verify.exif) from the active manifest: the
  // "Camera Settings (Device-reported)" claims block.
  const [manifestExif, setManifestExif] = useState<{ referenced: boolean; data: Record<string, unknown> } | null>(null);
  // Reverse-geocoded place name for the sealed coordinates. Runs only while a
  // result with a location is on screen; any failure falls back to the bare
  // coordinates. Same resolver the exhibit page uses.
  const [placeName, setPlaceName] = useState<string | null>(null);
  // Local signer history: prior exhibits in this device's collection by the
  // same fingerprint. Computed for every tier so the sealing ladder's rung 2
  // can state it for this-device signers. Local evidence only; never vouches.
  const [localHand, setLocalHand] = useState<{ priorCaptures: number; firstSeen: string } | null>(null);
  // ── Reader inputs: the exact media bytes (in a ref, so large videos do not
  //    cost a re-render), the rosters this device holds, and any Bitcoin block
  //    headers fetched for the ledger binding. ──
  const mediaBytesRef = useRef<Uint8Array | null>(null);
  const [blockHeaders, setBlockHeaders] = useState<Record<number, Uint8Array>>({});
  // Hero overlay: the "Clean ▾" dropdown picks which juxtaposition layer, if
  // any, sits on the inspected media. Clean is always the default.
  const [overlay, setOverlay] = useState<string>('clean');
  // The empty state links to the field guide and scrolls straight to it.
  const scrollRef = useRef<ScrollView>(null);

  useEffect(() => {
    getDeviceKey().then((k) => setOwnFingerprint(k.fingerprint)).catch(() => {});
  }, []);

  // Signer identity, resolved against anchors outside the file through the
  // TrustProvider chain (this device, roster, org chain). Membership is
  // evaluated at the verified signing time, not the phone's clock.
  const signerFp = report?.c2pa?.signerFingerprint ?? report?.record?.signer?.fingerprint ?? null;
  // Roster membership is evaluated at pinned-authority time only: an unpinned
  // TSA's genTime is self-asserted and could backdate a capture around a
  // revocation.
  const verifiedAtMs = report?.c2pa?.timestamps.earliestTrustedUtc
    ? Date.parse(report.c2pa.timestamps.earliestTrustedUtc)
    : null;
  // The trust resolver handed into verification, so the trust axis is computed
  // inside the data model and travels on the report. The useEffect below is the
  // fallback for reports without one.
  const trustResolver = async ({ fingerprint, verifiedAtMs: atMs, orgChain }: {
    fingerprint: string;
    verifiedAtMs: number | null;
    orgChain: { linksValid: boolean; topSubject: string | null; issuer: string | null } | null;
  }) => {
    let localHistory: { priorCaptures: number; firstSeen: string } | null = null;
    try {
      const matches = (await listItems()).filter((i) => i.fingerprint === fingerprint);
      if (matches.length > 0) {
        const firstSeen = matches.reduce((a, b) => (a.createdAt < b.createdAt ? a : b)).createdAt;
        localHistory = { priorCaptures: matches.length, firstSeen };
      }
    } catch { /* collection unavailable; no history to state */ }
    return resolveSignerTrust({ fingerprint, ownFingerprint, orgChain, atMs, localHistory });
  };

  useEffect(() => {
    let cancelled = false;
    if (!signerFp) { setIdentity({ tier: 'unknown' }); setLocalHand(null); return; }
    (async () => {
      // Local hand history ("Known hand"): prior exhibits in this device's
      // collection sealed by the same fingerprint. Local evidence only; it
      // never promotes a tier. A locked or empty collection means no history.
      // Computed for every tier; the ladder states it on rung 2.
      let localHistory: { priorCaptures: number; firstSeen: string } | null = null;
      try {
        const matches = (await listItems()).filter((i) => i.fingerprint === signerFp);
        if (matches.length > 0) {
          const firstSeen = matches.reduce((a, b) => (a.createdAt < b.createdAt ? a : b)).createdAt;
          localHistory = { priorCaptures: matches.length, firstSeen };
        }
      } catch { /* collection unavailable; no history to state */ }
      if (!cancelled) setLocalHand(localHistory);
      if (report?.signerTrust) { if (!cancelled) setIdentity(report.signerTrust); return; }
      return resolveSignerTrust({
        fingerprint: signerFp,
        ownFingerprint,
        orgChain: report?.c2pa?.certChain
          ? { linksValid: report.c2pa.certChain.linksValid, topSubject: report.c2pa.certChain.topSubject, issuer: null }
          : null,
        atMs: verifiedAtMs,
        localHistory,
      })
        .then((t) => { if (!cancelled) setIdentity(t); })
        .catch(() => { if (!cancelled) setIdentity({ tier: 'unknown' }); });
    })().catch(() => { if (!cancelled) setIdentity({ tier: 'unknown' }); });
    return () => { cancelled = true; };
  }, [signerFp, ownFingerprint, verifiedAtMs, report]);

  // Ledger time: OpenTimestamps receipts travel inside the record but outside
  // the signed payload, since they upgrade after signing; each is verified
  // against the record's payload digest instead. Displayed separately from the
  // RFC 3161 authority time above: two independent claims, never one line.
  const [otsView, setOtsView] = useState<null | {
    state: 'pending' | 'confirmed' | 'invalid' | 'mismatch';
    height?: number;
    binding?: 'verified' | 'failed' | 'unchecked';
    queueDelayMs?: number;
  }>(null);
  useEffect(() => {
    let cancelled = false;
    const rec = report?.record ?? null;
    const ots = rec?.ots ?? null;
    if (!rec || !ots) { setOtsView(null); setBlockHeaders({}); return; }
    (async () => {
      const digest = payloadDigest(rec);
      if (ots.digestHex !== bytesToHex(digest)) { if (!cancelled) setOtsView({ state: 'mismatch' }); return; }
      const results = ots.submissions.map((s) => {
        try { return { s, v: verifyOtsReceipt(base64ToBytes(s.receipt), digest) }; }
        catch { return { s, v: null }; }
      });
      if (results.some((r) => !r.v || !r.v.receiptValid)) { if (!cancelled) setOtsView({ state: 'invalid' }); return; }
      const delay = ots.submissions.find((s) => s.queueDelayMs !== undefined)?.queueDelayMs;
      const conf = results.find((r) => r.s.state === 'confirmed');
      if (!conf) { if (!cancelled) setOtsView({ state: 'pending', queueDelayMs: delay }); return; }
      const height = conf.s.blockHeight;
      if (!height) { if (!cancelled) setOtsView({ state: 'confirmed', binding: 'unchecked', queueDelayMs: delay }); return; }
      // Completing the binding requires fetching the block header — network.
      // Offline the anchor shows with the binding unchecked.
      // Every confirmed submission's height is fetched (deduped): the
      // Reader's custody rung 4 consumes the same headers via blockHeaders.
      const heights = [...new Set(
        results.filter((r) => r.s.state === 'confirmed' && r.s.blockHeight).map((r) => r.s.blockHeight!),
      )];
      const fetched = await Promise.all(heights.map((h) => fetchBlockHeader(h).catch(() => null)));
      if (cancelled) return;
      const headers: Record<number, Uint8Array> = {};
      heights.forEach((h, i) => { if (fetched[i]) headers[h] = fetched[i]!; });
      setBlockHeaders(headers);
      const header = headers[height] ?? null;
      if (!header) { setOtsView({ state: 'confirmed', height, binding: 'unchecked', queueDelayMs: delay }); return; }
      const bound = verifyOtsReceipt(base64ToBytes(conf.s.receipt), digest, header);
      setOtsView({
        state: 'confirmed', height,
        binding: bound.blockBindingValid === true ? 'verified' : 'failed',
        queueDelayMs: delay,
      });
    })();
    return () => { cancelled = true; };
  }, [report]);

  const record = report?.record ?? null;

  // Place name for the sealed coordinates via the platform reverse geocoder
  // (CLGeocoder), as the exhibit page resolves it. Runs only while a result
  // with a location is on screen; any failure falls back to the coordinates.
  useEffect(() => {
    let cancelled = false;
    const l = record?.context?.location;
    if (!l || typeof l !== 'object') { setPlaceName(null); return; }
    Location.reverseGeocodeAsync({ latitude: l.lat, longitude: l.lon })
      .then((r) => {
        if (cancelled) return;
        const p = r?.[0];
        setPlaceName(p?.city ?? p?.region ?? null);
      })
      .catch(() => { if (!cancelled) setPlaceName(null); });
    return () => { cancelled = true; };
  }, [record]);

  // The sealed when/where as one line for the juxtaposition cards: the
  // reverse-geocoded place name when it resolved, the coordinates otherwise.
  const sealedWhenWhere = useMemo(() => {
    if (!record) return '';
    const loc = record.context?.location;
    const where = loc && typeof loc === 'object'
      ? placeName ?? `${loc.lat.toFixed(4)}, ${loc.lon.toFixed(4)}`
      : null;
    return [fmtWhen(record.capturedAt), where].filter(Boolean).join(' · ');
  }, [record, placeName]);
  const juxta = useMemo<JuxtaInputs | null>(
    () => (record ? juxtaInputs(record, sealedWhenWhere) : null),
    [record, sealedWhenWhere],
  );

  // ── How this was sealed: the four rungs, projected from the evidence by
  //    src/lib/trustLadder. Presentation only; nothing is recomputed here.
  //    'this-device' maps to rung 2 unreached with the local-history wording;
  //    localHand rides along when this collection has seen the key before. ──
  const ladder = useMemo(() => {
    if (!report) return null;
    const ots: LadderInput['ots'] = !otsView
      ? 'none'
      : otsView.state === 'pending'
        ? 'pending'
        : otsView.state === 'invalid' || otsView.state === 'mismatch'
          ? 'invalid'
          : otsView.binding === 'verified'
            ? 'confirmed-verified'
            : 'confirmed-unchecked';
    return projectTrustLadder({
      manifestFound: report.checks.manifestFound,
      verdict: report.verdict,
      signatureValid: report.checks.signatureValid,
      fingerprintMatches: report.checks.fingerprintMatches,
      assetHashMatches: report.checks.assetHashMatches,
      bindingVoid: report.c2pa?.assetHashFailure === 'void-binding',
      tier: identity.tier,
      // This-device signers get the local history stated on rung 2, at the same
      // threshold the trust resolver applies (a single stray capture is not a
      // track record). At the unknown floor the resolver already attached it.
      localHand:
        identity.tier === 'this-device'
          ? localHand && localHand.priorCaptures >= 2 ? localHand : null
          : identity.localHand ?? null,
      rosterState: identity.tier === 'roster' && identity.roster ? identity.roster.state : null,
      rosterNewsroom: identity.tier === 'roster' && identity.roster ? identity.roster.roster.newsroom : null,
      trustListName: null,
      orgChain: report.c2pa?.certChain
        ? { linksValid: report.c2pa.certChain.linksValid, topSubject: report.c2pa.certChain.topSubject }
        : null,
      appAttest: report.c2pa
        ? {
            present: report.c2pa.appAttest.present,
            valid: report.c2pa.appAttest.valid,
            attestationEnv: report.c2pa.appAttest.attestationEnv,
          }
        : { present: false, valid: false },
      hardwareNotApplicable: record?.deidentified ? 'deidentified' : null,
      timestamps: report.c2pa
        ? { present: report.c2pa.timestamps.present, valid: report.c2pa.timestamps.valid, trusted: report.c2pa.timestamps.trusted, unchecked: report.c2pa.timestamps.unchecked ?? 0 }
        : { present: 0, valid: 0, trusted: 0 },
      ots,
    });
  }, [report, identity, localHand, otsView, record]);

  // ── Forensic Checks inputs, derived once from the dropped file's
  //    verification report. Where a check needs on-device capture context the
  //    file does not carry (burst frames, the raw audio master), the card's own
  //    neutral state says so. ──
  const secondary = useMemo(() => {
    const fromRecord = record
      ? secondaryFrameFor(record)
      : { frame: null, ptsSeconds: null, recordError: null, videoFrames: null };
    // An exported file's embedded frames are the fallback when the sealed
    // record carries none: video pairs ride the proof bundle on-device but are
    // embedded in the file. See manifestSecondaryFrames.
    if (fromRecord.frame || !parsedManifest) return fromRecord;
    const embedded = manifestSecondaryFrames(parsedManifest);
    if (embedded.length === 0) return fromRecord;
    return {
      frame: embedded[0].frame,
      ptsSeconds: null,
      recordError: null,
      videoFrames: embedded.length > 0 ? embedded : null,
    };
  }, [record, parsedManifest]);
  const enfAnchor = useMemo(() => (record ? readEnfAnchor(record) : null), [record]);

  // The manifest's embedded claim thumbnail, materialized once. Used as
  // PickedMedia's preview when this device cannot extract a frame from the
  // sealed container. Referenced-gated.
  const [manifestThumbUri, setManifestThumbUri] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setManifestThumbUri(null);
    const t = parsedManifest?.thumbnails.find(
      (x) => x.referenced && x.label === 'c2pa.thumbnail.claim.jpeg' && x.bytes.length > 0,
    );
    if (!t || !picked) return;
    const path = `${FileSystem.cacheDirectory}inspect-claim-thumb-${picked.name.replace(/[^A-Za-z0-9._-]/g, '_')}-${t.bytes.length}.jpg`;
    writeFileBytes(path, t.bytes)
      .then(() => { if (!cancelled) setManifestThumbUri(path); })
      .catch(() => { if (!cancelled) setManifestThumbUri(null); });
    return () => { cancelled = true; };
  }, [parsedManifest, picked]);
  const forensicKind: 'photo' | 'video' | 'audio' =
    picked?.kind === 'photo' ? 'photo' : picked?.audioHint === true ? 'audio' : 'video';

  // The organization claim: the signed byline block first, then the org
  // credential mirror. Self-asserted either way.
  const orgValue =
    (record && record.identity !== 'redacted' && record.identity.organization) ||
    record?.orgCredential?.issuer ||
    record?.orgCredential?.subject ||
    null;
  // The Time claims card renders when there is anything time-shaped to
  // show: a record (its device clock) or any countersignature/ledger state.
  const hasTimeRows = (report?.c2pa?.timestamps.present ?? 0) > 0 || otsView !== null;

  // The Timestamp row mirrors the exhibit page's derivation: the countersigned
  // anchor when a pinned authority countersigned, else the device clock. Same
  // status strings, same disagreement rule.
  const tsInfo = report?.c2pa?.timestamps ?? null;
  const tsAnchorIso = tsInfo && tsInfo.trusted > 0
    ? tsInfo.earliestTrustedUtc
    : tsInfo && tsInfo.valid > 0
      ? tsInfo.earliestValidUtc
      : null;
  const tsBigIso = record
    ? tsInfo && tsInfo.trusted > 0 && tsInfo.earliestTrustedUtc
      ? tsInfo.earliestTrustedUtc
      : record.capturedAt
    : null;
  const tsStatus = tsInfo && tsInfo.trusted > 0
    ? { text: 'Countersigned by independent authority', color: colors.accent }
    : tsInfo && tsInfo.valid > 0
      ? { text: 'Countersigned', color: colors.textDim }
      : { text: 'Not countersigned — device clock only', color: colors.textDim };
  // Only tokens that fully parsed and failed cryptographically count here.
  // Unchecked tokens (parse or coverage gaps) get their own row.
  const tsFailed = tsInfo ? tsInfo.present - tsInfo.valid - (tsInfo.unchecked ?? 0) : 0;
  const tsUnchecked = tsInfo?.unchecked ?? 0;
  const tsDisagrees = !!(
    record && tsAnchorIso &&
    Number.isFinite(Date.parse(record.capturedAt)) && Number.isFinite(Date.parse(tsAnchorIso)) &&
    // A de-identified copy is a re-sign: the original device-clock assertion is
    // re-countersigned later, so its gap is allowed up to 15 minutes. Original
    // seals stay at 5.
    Math.abs(Date.parse(record.capturedAt) - Date.parse(tsAnchorIso)) >
      (record.deidentified ? 15 : 5) * 60 * 1000
  );

  // Declared edits (c2pa.actions / ingredients) get a flag on the result, not
  // just a drawer, carrying the covered-by-the-seal / not-referenced
  // distinction inline. The file's own c2pa.created declaration is filtered
  // upstream, so a file with no declared edits raises no flag.
  const editFlag = useMemo(() => {
    if (!editHistory) return null;
    const actions = editHistory.actions?.list ?? [];
    // The flag is for declarations that say something: edit actions, multiple
    // sources, or derivation from an earlier file. Source's own manifests carry
    // exactly one componentOf ingredient (the committed second-camera
    // viewpoint), which is the capture itself, not a composition.
    const sources = editHistory.ingredients.filter(
      (ing, i, all) => all.length > 1 || ing.relationship === 'parentOf',
    );
    if (actions.length === 0 && sources.length === 0) return null;
    const who = editHistory.generator ?? 'the sealing software';
    if (actions.length > 0) {
      const names = [...new Set(actions.map((a) => actionLabel(a.action)))].slice(0, 3);
      const covered = editHistory.actions && !editHistory.actions.referenced
        ? 'Not referenced by the signed claim, so the list binds to nothing.'
        : 'Covered by the seal.';
      return `Edits declared: ${names.join(', ')}${actions.length > 3 ? ` +${actions.length - 3} more` : ''} · by ${who}. ${covered}`;
    }
    const covered = sources.every((i) => i.referenced)
      ? 'Covered by the seal.'
      : 'Not all sources are referenced by the signed claim, so those bind to nothing.';
    return `Built from ${sources.length} source file${sources.length === 1 ? '' : 's'}, declared by ${who}. ${covered}`;
  }, [editHistory]);

  // Parse the manifest once: the edit history and camera-settings claims derive
  // from it, and the parsed object feeds the Advanced group's raw-manifest reel
  // (the shared ManifestReel, full manifest).
  useEffect(() => {
    setParsedManifest(null);
    setEditHistory(null);
    setManifestExif(null);
    if (!report?.c2pa || !picked) return;
    let cancelled = false;
    void (async () => {
      try {
        const bytes = await readFileBytes(picked.uri);
        const store = picked.kind === 'photo' ? extractC2paStore(bytes) : extractC2paStoreBmff(bytes);
        const m = store ? parseManifest(store.payload) : null;
        if (!m || cancelled) return;
        if (!cancelled) {
          setParsedManifest(m);
          // c2pa.created is the file's creation declaration, required by C2PA
          // 2.1+. Creation is not an edit, so it never raises the edits flag
          // and never lists as one. The raw reel above still shows it.
          const declaredEdits = m.actions
            ? { list: m.actions.list.filter((a) => a.action !== 'c2pa.created'), referenced: m.actions.referenced }
            : null;
          setEditHistory({
            generator: m.claimGenerator,
            manifestCount: m.manifestCount,
            actions: declaredEdits,
            ingredients: m.ingredients,
          });
          setManifestExif(m.exif ? { referenced: m.exif.referenced, data: m.exif.data } : null);
        }
      } catch {
        /* no reel; the state stays null */
      }
    })();
    return () => { cancelled = true; };
  }, [report, picked]);

  /**
   * Omni import: one picker, any file. Uses the document picker rather than the
   * image picker, because verification needs the exact original bytes and the
   * image picker may re-encode. Routing is by sniffed type, not the file's
   * claimed one: JPEG/PNG to the photo verifier, MP4/MOV/M4A to the BMFF
   * verifier, and neutral "not supported yet" cards for HEIC, MP3/WAV and
   * unknown formats.
   */
  type SniffedType = 'photo' | 'heic' | 'bmff' | 'mp3' | 'wav' | 'unknown';

  const sniffMediaType = async (uri: string): Promise<SniffedType> => {
    try {
      const b64 = await FileSystem.readAsStringAsync(uri, {
        encoding: FileSystem.EncodingType.Base64,
        position: 0,
        length: 16,
      });
      const b = base64ToBytes(b64);
      const ascii = (from: number, to: number) => String.fromCharCode(...b.subarray(from, Math.min(to, b.length)));
      if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'photo'; // JPEG
      if (b.length >= 4 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'photo'; // PNG
      if (b.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE') return 'wav';
      if (b.length >= 2 && (ascii(0, 3) === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0))) return 'mp3';
      if (b.length >= 12 && ascii(4, 8) === 'ftyp') {
        const brand = ascii(8, 12);
        if (['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'].includes(brand)) return 'heic';
        return 'bmff'; // mp4 / mov / m4a — the BMFF verifier path
      }
      return 'unknown';
    } catch {
      return 'unknown';
    }
  };

  const unreadableReport = (): VerificationReport => ({
    verdict: 'UNREADABLE',
    record: null,
    checks: { manifestFound: false, signatureValid: null, fingerprintMatches: null, assetHashMatches: null, recomputedSha256: null },
    checksPerformed: [],
    checksNotPerformed: ['file could not be read; no checks were possible'],
  });

  const pickAndVerify = async () => {
    try {
      setReport(null); // clear any stale verdict before sniffing
      setNote(null);
      setPicked(null);
      setBlockHeaders({});
      mediaBytesRef.current = null;
      setBusy('Reading file…');
      const doc = await DocumentPicker.getDocumentAsync({ type: '*/*', copyToCacheDirectory: true });
      if (doc.canceled || !doc.assets[0]) return;
      const uri = doc.assets[0].uri;
      const sniffed = await sniffMediaType(uri);
      // A new file resets the group cards to their defaults (Capture open).
      setGroupOpen({ capture: true, integrity: false, advanced: false });
      switch (sniffed) {
        case 'photo':
          setBusy('Checking signature & hash…');
          setPicked({ uri, name: doc.assets[0].name ?? 'Picked file', kind: 'photo', audioHint: false });
          {
            // Read the bytes once here (verifyFs reads and discards its own
            // copy) so the Reader's custody rung can re-hash the media for its
            // byte-binding row without a second read.
            const bytes = await readFileBytes(uri);
            mediaBytesRef.current = bytes;
            setReport(await verifyPhotoBytes(bytes, { trustResolver }));
          }
          break;
        case 'bmff': {
          setBusy('Checking signature & hash…');
          const bytes = await readFileBytes(uri);
          mediaBytesRef.current = bytes;
          const r = await verifyVideoBytes(bytes, { trustResolver });
          // Audio containers (M4A) get the placeholder rather than a black
          // frame. The record's mime wins; the picker's mime is the fallback.
          const mime = r.record?.asset.mime ?? doc.assets[0].mimeType ?? null;
          setPicked({ uri, name: doc.assets[0].name ?? 'Picked file', kind: 'bmff', audioHint: mime ? mime.startsWith('audio/') : null });
          setReport(r);
          break;
        }
        case 'heic':
          // Neutral, not an error state: this build cannot parse HEIC
          // credentials.
          setNote('This is a HEIC file. This build can’t read HEIC credentials yet. Unchecked, not rejected.');
          break;
        case 'mp3':
        case 'wav':
          setNote('This build can’t read MP3 or WAV credentials yet. Unchecked, not rejected.');
          break;
        default:
          setNote("We can't read this format yet. That's a gap in this tool, not a finding about the file.");
      }
    } catch (e) {
      setReport(unreadableReport());
    } finally {
      setBusy(null);
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView ref={scrollRef} contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        {/* Beta tag: the same ScreenTitle `tag` pill the Settings screen
            uses. */}
        <ScreenTitle
          title="Inspect"
          tag="in beta"
          subtitle="Checked on this device. Nothing uploads."
        />

        <Card>
          {/* Local themed pill, not the shared Button: the shared primary tone
              pairs a `colors.text` fill with a hard-coded dark label, which is
              dark-on-dark in light mode. This pill is inverted ink in both
              schemes: dark pill with paper text in light, the reverse in
              dark. */}
          <Pressable
            style={[styles.pickButton, busy ? styles.pickButtonDisabled : null]}
            onPress={pickAndVerify}
            disabled={!!busy}
            accessibilityRole="button"
          >
            <Ionicons name="search-outline" size={17} color={styles.pickButtonText.color} style={{ marginRight: 7 }} />
            <Text style={styles.pickButtonText}>Choose a photo, video or audio file</Text>
          </Pressable>
          <Text style={styles.helperText}>
            Only original files carry a seal; chat apps strip it. Ask for the original.
          </Text>
        </Card>

        {busy ? (
          <Card style={styles.busyCard}>
            <ActivityIndicator color={colors.accent} />
            <Text style={styles.busyText}>{busy}</Text>
          </Card>
        ) : null}

        {note && !busy ? (
          <Card>
            <View style={styles.noteRow}>
              <Ionicons name="help-circle-outline" size={20} color={colors.textDim} />
              <Text style={styles.noteText}>{note}</Text>
            </View>
          </Card>
        ) : null}

        {report && !busy ? (
          <View>
            {/* The integrity outcome comes FIRST — then the checks. Identity,
                provenance and claims follow; this is a forensic reader, not
                a trophy case. */}
            <VerdictCard report={report} identity={identity} ladder={ladder} />

            {editFlag ? (
              <Card style={{ borderColor: colors.warn, borderWidth: 1 }}>
                <View style={{ flexDirection: 'row', gap: spacing.sm, alignItems: 'flex-start' }}>
                  <Ionicons name="construct-outline" size={15} color={colors.warn} style={{ marginTop: 1 }} />
                  <Text style={styles.editFlagText}>{editFlag}</Text>
                </View>
              </Card>
            ) : null}

            {picked ? (
              <PickedMedia
                uri={picked.uri}
                name={picked.name}
                kind={picked.kind}
                audioHint={picked.audioHint}
                overlay={overlay}
                onOverlay={setOverlay}
                juxta={juxta}
                fallbackUri={manifestThumbUri}
              />
            ) : null}

            {/* Declared edits, above Capture claims. Only the C2PA actions
                themselves: no ingredients, no disclaimer copy. Hidden entirely
                when there are none; c2pa.created is filtered upstream. */}
            {editHistory && (editHistory.actions?.list.length ?? 0) > 0 ? (
              <View>
                <SectionLabel text="Declared edits" />
                <Card>
                  <View style={{ gap: 10 }}>
                    {editHistory.actions!.list.map((a, i) => (
                      <View key={i} style={styles.editRow}>
                        <Ionicons name={actionIcon(a.action)} size={15} color={colors.textDim} style={{ marginTop: 1 }} />
                        <View style={{ flex: 1 }}>
                          <Text style={styles.editAction}>{actionLabel(a.action)}</Text>
                          <Text style={styles.editMeta}>
                            {[a.action, a.softwareAgent ?? null, a.when ? fmtWhen(a.when) : null, a.description ?? null]
                              .filter(Boolean)
                              .join(' · ')}
                          </Text>
                        </View>
                      </View>
                    ))}
                  </View>
                </Card>
              </View>
            ) : null}

            {/* Capture: the same collapsible group card and time-outline icon
                as the exhibit details page. When and where / Device / The
                seal / Sensors / Camera settings. */}
            {record || hasTimeRows ? (
              <View>
                <GroupCard
                  icon="time-outline"
                  title="Capture"
                  peek="When, where, on what."
                  open={groupOpen.capture}
                  onToggle={() => toggleGroup('capture')}
                >
                  <Text style={styles.subHead}>When &amp; where</Text>
                  {record && tsBigIso ? (
                    <View>
                      <LabelRow label="Timestamp" value={fmtAt(tsBigIso)} detail={tsStatus.text} detailColor={tsStatus.color} />
                      {tsAnchorIso ? (
                        <LabelRow
                          label="Device clock"
                          value={fmtAt(record.capturedAt)}
                          valueColor={tsDisagrees ? colors.danger : undefined}
                          detail={tsDisagrees ? 'Does not agree with the countersigned time' : undefined}
                          detailColor={tsDisagrees ? colors.danger : undefined}
                        />
                      ) : null}
                      {tsFailed > 0 ? (
                        <LabelRow
                          label="Countersignatures"
                          value={`${tsFailed} token${tsFailed === 1 ? '' : 's'} FAILED verification`}
                          valueColor={colors.danger}
                        />
                      ) : tsUnchecked > 0 ? (
                        <LabelRow
                          label="Countersignatures"
                          value={`${tsUnchecked} token${tsUnchecked === 1 ? '' : 's'} not checkable by this build`}
                          detail="A limitation of this verifier — not a finding against the file."
                        />
                      ) : null}
                      {otsView ? (
                        (() => {
                          const line = bitcoinCalendarValue(otsView);
                          return <LabelRow label="Bitcoin calendar" value={line.text} valueColor={line.color} />;
                        })()
                      ) : null}
                      {/* "Redacted" is only for de-identified copies (the
                          re-seal marker); an anonymous-mode capture never
                          provided a name, so it reads Not provided. */}
                      {record.identity === 'redacted' ? (
                        <LabelRow label="Byline" value={record.deidentified ? 'Redacted by signer' : 'Not provided'} />
                      ) : record.identity?.author ? (
                        <LabelRow label="Byline" value={record.identity.author} />
                      ) : (
                        <LabelRow label="Byline" value="Not provided" />
                      )}
                      {(() => {
                        const loc = record.context?.location;
                        if (loc && typeof loc === 'object') {
                          return (
                            <>
                              {/* The reverse-geocoded place is Inspect-only
                                  context from the same sealed coordinates; the
                                  claim itself is the Location row below. */}
                              {placeName ? <LabelRow label="Place" value={placeName} detail="Reverse-geocoded from the sealed coordinates." /> : null}
                              <LabelRow
                                label="Location"
                                value={`${loc.lat.toFixed(5)}, ${loc.lon.toFixed(5)}`}
                                valueColor={IDENT_CLAY}
                                detail="Device-reported."
                              >
                                <Pressable
                                  style={styles.mapsChip}
                                  hitSlop={6}
                                  accessibilityLabel="Open in Google Maps"
                                  onPress={() => void Linking.openURL(`https://www.google.com/maps/search/?api=1&query=${loc.lat},${loc.lon}`)}
                                >
                                  <Ionicons name="map-outline" size={12} color={colors.info} />
                                  <Text style={styles.mapsChipText}>Google Maps</Text>
                                </Pressable>
                              </LabelRow>
                            </>
                          );
                        }
                        if (loc === 'redacted' || record.deidentified) {
                          return <LabelRow label="Location" value="Redacted by signer" />;
                        }
                        if (loc === 'unavailable') {
                          return <LabelRow label="Location" value="Unavailable at capture" />;
                        }
                        return <Text style={styles.claimAbsent}>No location sealed with this file.</Text>;
                      })()}
                      {record.context?.wifi === 'redacted' ? (
                        <LabelRow label="Wi-Fi" value="Redacted by signer" />
                      ) : record.context?.wifi === 'unavailable' ? (
                        <LabelRow label="Wi-Fi" value="Unavailable at capture" />
                      ) : record.context?.wifi ? (
                        record.context.wifi.bssid ? (
                          <LabelRow label="Wi-Fi BSSID" value={record.context.wifi.bssid} mono />
                        ) : (
                          <LabelRow label="Wi-Fi" value={record.context.wifi.ssid ?? '(none reported)'} detail="A lead, not proof of place." />
                        )
                      ) : null}
                    </View>
                  ) : (
                    <View>
                      {/* No record, but time-shaped evidence exists (a
                          countersignature or ledger state without a parsed
                          record): show what there is. */}
                      {report.c2pa && report.c2pa.timestamps.present > 0 ? (
                        <LabelRow
                          label="Countersignatures"
                          value={(() => {
                            const t = report.c2pa.timestamps;
                            const unchecked = t.unchecked ?? 0;
                            if (unchecked > 0 && t.valid === 0) return `${t.present} embedded · not checkable by this build`;
                            return `${t.present} embedded · ${t.valid} verified${unchecked > 0 ? ` · ${unchecked} not checkable by this build` : ''}${t.trusted === 0 && t.valid > 0 ? ' · authority not pinned' : ''}`;
                          })()}
                          detail={(report.c2pa.timestamps.unchecked ?? 0) > 0 && report.c2pa.timestamps.valid === 0
                            ? 'A limitation of this verifier — not a finding against the file.'
                            : report.c2pa.timestamps.trusted === 0 && report.c2pa.timestamps.valid > 0
                              ? 'The token is genuine, but the countersigning authority is not on the pinned list.'
                              : undefined}
                        />
                      ) : null}
                      {otsView ? (
                        (() => {
                          const line = bitcoinCalendarValue(otsView);
                          return <LabelRow label="Bitcoin calendar" value={line.text} valueColor={line.color} />;
                        })()
                      ) : null}
                    </View>
                  )}

                  {record ? (
                    <View style={styles.subSection}>
                      <Text style={styles.subHead}>Device</Text>
                      <LabelRow label="Device model" value={record.device.model ?? '—'} />
                      <LabelRow label="Platform" value={record.device.platform === 'ios' ? 'iOS' : record.device.platform} />
                      {/* Same capture-software claim as the exhibit page: the
                          sealed claim-generator string, with the record's own
                          app block as the fallback. */}
                      <LabelRow label="Capture software" value={report.c2pa?.generator ?? `${record.app.name} ${record.app.version}`} />
                      {/* An absent org credential is not a warning. */}
                      {orgValue ? <LabelRow label="Organization" value={orgValue} /> : null}
                    </View>
                  ) : null}

                  {/* The seal: the manifest lines, each fact once, with failure
                      copy riding as the row's own detail. */}
                  <View style={styles.subSection}>
                    <Text style={styles.subHead}>The seal</Text>
                    <SealRows report={report} />
                    {signerFp ? (
                      <View style={styles.monoBlock}>
                        <Text style={styles.monoBlockLabel}>SIGNER FINGERPRINT · COMPARE ALL 64</Text>
                        <Mono size="sm" color={colors.accent}>{signerFp}</Mono>
                      </View>
                    ) : null}
                  </View>

                  {record?.context && (record.context.headingDeg != null || record.context.pressureHPa != null || record.context.altitudeM != null || record.context.motion || record.context.sensorTiming) ? (
                    <View style={styles.subSection}>
                      <Text style={styles.subHead}>Sensors (Device-reported)</Text>
                      {record.context.headingDeg != null ? (
                        <LabelRow label="Heading" value={`${record.context.headingDeg}°`} />
                      ) : null}
                      {record.context.pressureHPa != null ? (
                        <LabelRow label="Barometer" value={`${record.context.pressureHPa} hPa`} />
                      ) : null}
                      {record.context.altitudeM != null ? (
                        <LabelRow label="Altitude (baro.)" value={`${record.context.altitudeM} m`} />
                      ) : null}
                      {record.context.motion ? (
                        <LabelRow label="Motion" value={`${motionLabel(record.context.motion.verdict)} · ${record.context.motion.peakHz} Hz peak`} />
                      ) : null}
                    </View>
                  ) : null}

                  {/* Media type and size sit at the bottom of Camera Settings,
                      under White Balance. */}
                  {(manifestExif && Object.keys(manifestExif.data).filter((k) => k !== 'note').length > 0) || record ? (
                    <View style={styles.subSection}>
                      <Text style={styles.subHead}>Camera Settings (Device-reported)</Text>
                      {/* The sealed block's `note` key is provenance
                          boilerplate, not a camera setting, so it gets no row.
                          The head carries the device-reported caveat. */}
                      {manifestExif
                        ? Object.entries(manifestExif.data).filter(([k]) => k !== 'note').map(([k, v]) => (
                            <LabelRow key={k} label={EXIF_LABELS[k] ?? k} value={formatExifValue(k, v)} />
                          ))
                        : null}
                      {manifestExif && !manifestExif.referenced ? (
                        <Text style={styles.helperText}>This block is not referenced by the signed claim, so it binds to nothing.</Text>
                      ) : null}
                      {record ? (
                        <LabelRow
                          label="Media"
                          value={`${(record.asset.mime.split('/')[1] ?? record.asset.kind).toUpperCase()} · ${fmtBytes(record.asset.bytes)}`}
                        />
                      ) : null}
                    </View>
                  ) : null}
                </GroupCard>
              </View>
            ) : null}

            {/* Integrity: the capture-integrity rows in the exhibit page's
                Integrity group, same lock-closed-outline icon. App Attest is
                not repeated here; it rides in The seal above. */}
            {record?.captureIntegrity ? (
              <View>
                <GroupCard
                  icon="lock-closed-outline"
                  title="Integrity"
                  peek="Shutter-to-signature, sensor timing, the OS face check."
                  open={groupOpen.integrity}
                  onToggle={() => toggleGroup('integrity')}
                >
                  <Text style={styles.subHead}>Capture integrity</Text>
                  <LabelRow
                    label="Shutter → signature"
                    value={
                      record.captureIntegrity.captureToSignatureMs < 1000
                        ? `${record.captureIntegrity.captureToSignatureMs} ms`
                        : `${(record.captureIntegrity.captureToSignatureMs / 1000).toFixed(1)} s`
                    }
                    detail="How long the bytes sat unsigned after the shutter. A long gap is room for them to have been altered."
                  />
                  {record.captureIntegrity.sensorTiming ? (
                    <LabelRow
                      label="Sensor-frame timing"
                      value={`${record.captureIntegrity.sensorTiming.samples} samples · regularity ${record.captureIntegrity.sensorTiming.intervalCv}`}
                      detail="How evenly sensor frames arrived during capture. Real sensors jitter; synthetic feeds run too regular or too bursty."
                    />
                  ) : null}
                  {record.captureIntegrity.biometricGatePassed === true ? (
                    <LabelRow label="Face check" value="OS check passed at capture" />
                  ) : record.captureIntegrity.biometricGatePassed === false ? (
                    <LabelRow label="Face check" value="OS check ran and did not pass" />
                  ) : null}
                </GroupCard>
              </View>
            ) : null}

            {/* Forensic checks: the same shared module cards the exhibit page
                renders, juxtaposing sealed data with what should be true.
                Where a check needs on-device capture context the dropped file
                does not carry (burst frames, the raw audio master), the card's
                own neutral state says so. */}
            {report.checks.manifestFound ? (
              <View>
                <SectionLabel text="Forensic checks" />
                {/* Lens, motion-trace and environment checks read picture
                    evidence, so they are hidden on audio captures; the
                    raw-audio card is the audio-applicable one. */}
                {forensicKind !== 'audio' ? (
                  <>
                    <MultipleLensCard
                      kind={forensicKind}
                      primaryUri={picked?.uri ?? null}
                      secondaryFrame={secondary.frame}
                      primaryFrameTimeSeconds={secondary.ptsSeconds}
                      recordError={secondary.recordError}
                      videoFrames={secondary.videoFrames}
                    />
                    {forensicKind === 'video' ? (
                      // A video take's motion trace: the committed pair frames
                      // (embedded in the dropped file) against the gyro log
                      // when this device can read it. The gyro lane states its
                      // absence on a foreign file; the picture lane is the
                      // file's own committed content.
                      <VideoMotionCard
                        videoFrames={secondary.videoFrames}
                        sensorLogPath={record?.context?.captureEvidence?.sensorLogPath}
                      />
                    ) : (
                      <MotionTraceCard
                        ringBufferDir={record?.context?.captureEvidence?.ringBufferDir}
                        poseTrace={record?.context?.poseTrace}
                        motion={record?.context?.motion}
                      />
                    )}
                    <EnvironmentCard
                      lat={juxta?.lat ?? null}
                      lon={juxta?.lon ?? null}
                      atIso={record?.capturedAt ?? null}
                      rollDeg={juxta?.rollDeg ?? null}
                      pitchDeg={juxta?.pitchDeg ?? null}
                      sealedWhenWhere={sealedWhenWhere}
                    />
                  </>
                ) : null}
                <RawAudioCard
                  kind={forensicKind}
                  rawPcmPath={record?.context?.captureEvidence?.rawPcmPath}
                  enfAnchor={enfAnchor}
                />
              </View>
            ) : null}

            {/* How this was sealed: the sealing path as a ladder of rungs,
                each reached / not reached / not applicable with one line —
                bytes unchanged, signer identified, key attested by Apple
                hardware, time countersigned, public-ledger anchor. Projected
                by src/lib/trustLadder from the evidence. */}
            {ladder ? (
              <View>
                <SectionLabel text="How this was sealed" />
                <TrustLadderCard ladder={ladder} />
              </View>
            ) : null}

            {/* Advanced: the same cog-outline group card as the exhibit
                details page, holding the raw C2PA manifest reel — the full
                manifest exactly as recovered, with copy as the way it leaves
                the phone. */}
            {report.checks.manifestFound ? (
              <View>
                <GroupCard
                  icon="cog-outline"
                  title="Advanced"
                  peek="The full C2PA manifest, exactly as recovered."
                  open={groupOpen.advanced}
                  onToggle={() => toggleGroup('advanced')}
                >
                  {parsedManifest ? (
                    <ManifestReel manifest={parsedManifest} />
                  ) : (
                    <Text style={styles.claimAbsent}>The manifest could not be parsed for display.</Text>
                  )}
                </GroupCard>
              </View>
            ) : null}

            {/* Export links. */}
            {picked ? (
              <View style={styles.exportRow}>
                <Pressable
                  hitSlop={8}
                  onPress={() => {
                    void (async () => {
                      if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(picked.uri);
                    })();
                  }}
                >
                  <Text style={styles.exportLink}>Export original</Text>
                </Pressable>
                <Pressable
                  hitSlop={8}
                  onPress={() => {
                    void (async () => {
                      const out = {
                        file: picked.name,
                        verdict: report.verdict,
                        sha256: record?.asset.sha256 ?? null,
                        signerFingerprint: signerFp,
                        capturedAt: record?.capturedAt ?? null,
                      };
                      const uri = `${FileSystem.cacheDirectory}inspection-report.json`;
                      await FileSystem.writeAsStringAsync(uri, JSON.stringify(out, null, 2));
                      if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(uri);
                    })();
                  }}
                >
                  <Text style={styles.exportLink}>Export report</Text>
                </Pressable>
                <Pressable hitSlop={8} onPress={() => void Linking.openURL('https://contentcredentials.org/verify')}>
                  <Text style={styles.exportLink}>Verify elsewhere</Text>
                </Pressable>
              </View>
            ) : null}
          </View>
        ) : null}
        {/* The FAQ sits at the bottom of Inspect, below the result or the
            empty state. */}
        {!busy ? (
          <View style={{ marginTop: spacing.md }}>
            <InspectGuide />
          </View>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const buildStyles = () => StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  scroll: { padding: spacing.md, paddingBottom: spacing.xxl },
  // Group cards: the same values as the exhibit details page's buildGrp —
  // flat surface, hairline border, whole header block as the tap target.
  groupCard: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 14,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
    marginBottom: spacing.md,
  },
  groupHead: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 4 },
  groupHeadBlock: { marginHorizontal: -spacing.sm, paddingHorizontal: spacing.sm, paddingVertical: 2, borderRadius: 10 },
  groupTitle: { flex: 1, color: colors.text, fontSize: fontSize.md, fontWeight: '700' },
  groupPeek: { color: colors.textDim, fontSize: fontSize.xs, lineHeight: 17, marginTop: 2 },
  groupBody: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    marginTop: spacing.sm,
    paddingTop: spacing.sm,
  },
  helperText: { color: colors.textFaint, fontSize: fontSize.xs, lineHeight: 17, marginTop: spacing.md },
  // The file-picker pill: inverted ink, legible in both schemes.
  pickButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.text,
    borderRadius: radii.sm,
    paddingVertical: 12,
    paddingHorizontal: spacing.md,
  },
  pickButtonDisabled: { opacity: 0.45 },
  pickButtonText: { color: colors.bg, fontSize: fontSize.sm, fontWeight: '700', letterSpacing: 0.1 },
  busyCard: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  busyText: { color: colors.textDim, fontSize: fontSize.sm },
  noteRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  noteText: { color: colors.textDim, fontSize: fontSize.sm, lineHeight: 20, flex: 1 },

  // --- the picked file, shown above its verdict ---
  mediaCard: { padding: spacing.sm },
  mediaStill: { width: '100%', height: 260, borderRadius: radii.md, backgroundColor: '#000' },
  mediaPlaceholder: { alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface2, gap: spacing.sm },
  mediaPlaceholderText: { color: colors.textFaint, fontSize: fontSize.xs },
  // The tap-to-play badge over a video still.
  playBadge: {
    position: 'absolute',
    top: '50%',
    left: '50%',
    width: 56,
    height: 56,
    borderRadius: 28,
    marginTop: -28,
    marginLeft: -28,
    backgroundColor: 'rgba(13,13,15,0.6)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  mediaName: { color: colors.textDim, fontSize: fontSize.xs, marginTop: spacing.sm, marginHorizontal: spacing.xs },

  // --- the label ---
  labelCard: { paddingTop: spacing.md },
  labelKicker: {
    color: colors.textFaint,
    fontSize: fontSize.xs,
    fontWeight: '700',
    letterSpacing: 2.2,
  },
  thickRule: { height: 3, backgroundColor: colors.accent, borderRadius: 2, marginTop: spacing.sm, marginBottom: spacing.md, width: 44 },
  thinRule: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border, marginVertical: spacing.md },
  verdictHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  verdictText: { fontFamily: type.display, fontSize: fontSize.xl, fontWeight: '700', flex: 1, lineHeight: 28 },
  verdictSubline: { color: colors.textDim, fontSize: fontSize.sm, lineHeight: 20, marginTop: spacing.sm },
  // The exhibit page's NlRow styles (buildNl): plain small label left, value
  // right-aligned, 7px row rhythm.
  labelRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: spacing.md, paddingVertical: 7 },
  // 126: "Countersignatures" is the longest label rendered; at 110 it wrapped
  // mid-word. flexShrink: 0 keeps it intact.
  labelRowLabel: { color: colors.textFaint, fontSize: fontSize.sm, width: 126, flexShrink: 0 },
  labelRowValueWrap: { flex: 1, alignItems: 'flex-end' },
  labelRowValue: { color: colors.text, fontSize: fontSize.sm, textAlign: 'right' },
  labelRowDetail: { color: colors.textFaint, fontSize: fontSize.xs, lineHeight: 16, marginTop: 2, textAlign: 'right' },
  // The exhibit page's sub-head and section rhythm inside a group card
  // (buildNl drawerHead / drawerSection, same values).
  subHead: {
    color: colors.textFaint, fontSize: 10.5, fontWeight: '800',
    letterSpacing: 1.9, textTransform: 'uppercase', marginBottom: spacing.xs,
  },
  subSection: { marginTop: spacing.md },
  mapsChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: radii.full,
    backgroundColor: colors.infoSoft,
  },
  mapsChipText: { color: colors.info, fontSize: fontSize.xs, fontWeight: '600' },
  deidNote: { color: colors.textDim, fontSize: fontSize.xs, lineHeight: 17, marginTop: spacing.sm, fontStyle: 'italic' },
  editsFlag: {
    flexDirection: 'row', gap: spacing.sm, alignItems: 'flex-start',
    marginTop: spacing.sm, padding: spacing.sm,
    borderWidth: 1, borderColor: colors.warn, borderRadius: radii.sm,
    backgroundColor: 'rgba(245,179,1,0.08)',
  },
  editsFlagText: { color: colors.text, fontSize: fontSize.xs, lineHeight: 17, flex: 1 },
  finePrint: { color: colors.textFaint, fontSize: fontSize.xs, lineHeight: 17 },
  disclosure: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: spacing.md, alignSelf: 'flex-start' },
  disclosureText: { color: colors.textDim, fontSize: fontSize.sm, fontWeight: '600' },

  checkRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  checkText: { color: colors.textDim, fontSize: fontSize.sm, flex: 1 },
  warnText: { color: colors.danger, fontSize: fontSize.xs, lineHeight: 17, marginTop: spacing.md },
  warnTextFlush: { color: colors.danger, fontSize: fontSize.xs, lineHeight: 17, marginBottom: spacing.sm },

  // --- the accordion body: sections of one extended card, separated by
  //     hairlines rather than detached squircles ---
  detailBody: { marginTop: spacing.xs },
  detailSection: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    marginTop: spacing.md,
    paddingTop: spacing.md,
  },

  // --- forensic-detail card headers and the empty-state guide link ---
  cardHead: { marginBottom: spacing.sm },
  cardHeadTitleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  cardHeadTick: { width: 14, height: 3, borderRadius: 2, backgroundColor: colors.textFaint },
  cardHeadTitle: { color: colors.textDim, fontSize: fontSize.xs, fontWeight: '700', letterSpacing: 1.6, textTransform: 'uppercase', flex: 1, lineHeight: 17 },
  cardHeadSubnote: { color: colors.textFaint, fontSize: fontSize.xs, lineHeight: 17, marginTop: spacing.xs },
  guideLink: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.sm,
    marginTop: spacing.md, backgroundColor: colors.surface2,
    borderRadius: radii.sm, paddingVertical: 10, paddingHorizontal: spacing.md,
  },
  guideLinkText: { color: colors.textDim, fontSize: fontSize.sm, fontWeight: '600', flex: 1 },
  editRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  editAction: { color: colors.textDim, fontSize: fontSize.sm, fontWeight: '600' },
  editMeta: { color: colors.textFaint, fontSize: fontSize.xs, lineHeight: 16, marginTop: 1 },
  fingerprintBox: {
    backgroundColor: colors.bg,
    borderRadius: radii.sm,
    padding: spacing.sm + 2,
    marginTop: spacing.md,
  },

  // --- the seal-says block and the manifest drawers ---
  sealSays: { color: colors.textFaint, fontSize: fontSize.xs, fontWeight: '700', letterSpacing: 1.4, textTransform: 'uppercase' },
  helperTextFlush: { color: colors.textFaint, fontSize: fontSize.xs, lineHeight: 17, marginBottom: spacing.sm },
  drawerHeadRow: { flexDirection: 'row', alignItems: 'center' },
  drawerHead: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 4 },
  drawerTitle: { color: colors.textDim, fontSize: fontSize.sm, fontWeight: '600' },
  monoBlock: { backgroundColor: colors.bg, borderRadius: radii.sm, padding: spacing.sm + 2, marginTop: spacing.sm, gap: 4 },
  monoBlockLabel: { color: colors.textFaint, fontSize: 9, fontWeight: '700', letterSpacing: 1.2 },
  codeBox: { backgroundColor: colors.bg, borderRadius: radii.sm, padding: spacing.sm + 2, marginTop: spacing.sm, maxHeight: 320 },
  codeText: { fontFamily: type.mono, color: colors.textDim, fontSize: fontSize.xs, lineHeight: 17 },
  mediaFrame: { position: 'relative', borderRadius: radii.md, overflow: 'hidden' },
  overlayMenuWrap: { position: 'absolute', top: spacing.sm, right: spacing.sm, alignItems: 'flex-end' },
  overlayChip: {
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderRadius: radii.md,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
  },
  overlayChipText: { color: '#fff', fontSize: fontSize.xs, fontWeight: '600' },
  overlayMenu: {
    marginTop: 4,
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    paddingVertical: 4,
    minWidth: 120,
  },
  overlayMenuItem: { paddingHorizontal: spacing.sm + 2, paddingVertical: 6 },
  overlayMenuText: { color: colors.text, fontSize: fontSize.sm },
  overlayBadge: {
    position: 'absolute',
    left: spacing.sm,
    bottom: spacing.sm,
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderRadius: radii.md,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
  },
  overlayBadgeText: { color: '#fff', fontSize: fontSize.xs, fontWeight: '600' },
  signerLine: { color: colors.text, fontSize: fontSize.sm, lineHeight: 19 },
  signerSub: { color: colors.textDim, fontSize: fontSize.sm, lineHeight: 19 },
  signerFaint: { color: colors.textFaint, fontSize: fontSize.xs, lineHeight: 17, marginTop: 4 },
  editFlagText: { color: colors.text, fontSize: fontSize.sm, lineHeight: 19, flex: 1 },
  // A neutral fact line inside a claims card, stating an absence. Body text;
  // never below the muted token.
  claimAbsent: { color: colors.textDim, fontSize: fontSize.sm, lineHeight: 19, marginTop: spacing.xs },
  exportRow: { flexDirection: 'row', justifyContent: 'center', gap: spacing.lg, paddingVertical: spacing.sm },
  exportLink: { color: colors.accent, fontSize: fontSize.sm },
});

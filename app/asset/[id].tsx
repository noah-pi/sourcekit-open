// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Asset detail — media, live re-verification, sealed metadata, and actions.
 *
 * Opening an item re-runs the full verification against the decrypted bytes,
 * so the badge you see is computed now, not remembered from capture time.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Alert,
  ActivityIndicator,
  Dimensions,
  Pressable,
  PanResponder,
  Linking,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Image } from 'expo-image';
import { useVideoPlayer, VideoView, type VideoPlayer } from 'expo-video';
import { useEvent } from 'expo';
import * as Sharing from 'expo-sharing';
import * as Location from 'expo-location';
import * as MediaLibrary from 'expo-media-library/legacy';
import * as FileSystem from 'expo-file-system/legacy';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import * as Clipboard from 'expo-clipboard';

import { colors, spacing, radii, fontSize, type, useThemedStyles, useEffectiveScheme } from '../../src/theme';
import { Button, Card } from '../../src/components/ui';
import { MediaViewer } from '../../src/components/MediaViewer';
import { ExportSheet } from '../../src/components/ExportSheet';
import { type OtsView } from '../../src/components/TrustedTime';
import { juxtaInputs } from '../../src/components/Juxtapose';
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
  decryptItemToCache,
  getRecord,
  deleteItem,
  listItems,
  unsealVaultJson,
  type VaultIndexEntry,
} from '../../src/vault/vaultFs';
import { verdictHeadline, type VerdictCode, type VerificationReport } from '../../src/c2pa/verifyAsset';
import { verifyPhoto, verifyVideo, verifyWithSidecar } from '../../src/provenance/verifyFs';
import { resolveSignerTrust, type SignerTrust } from '../../src/lib/trustProvider';
import { projectTrustLadder, type LadderInput } from '../../src/lib/trustLadder';
import { TrustLadderCard } from '../../src/components/TrustLadder';
import { ManifestReel } from '../../src/components/ManifestReel';
import { upgradePendingOts } from '../../src/provenance/otsQueue';
import { recordToSidecarJson, deidentifyPhoto, deidentifyPhotoToPng, deidentifyBmff } from '../../src/provenance/attest';
import { extractC2paStoreBmff } from '../../src/c2pa/bmff';
import { extractC2paStore, parseManifest, type TranscriptAssertion, type C2paManifest } from '../../src/c2pa/c2pa';
import { bytesToBase64, base64ToBytes, bytesToHex } from '../../src/lib/bytes';
import { buildHashClaim, buildProofBundle } from '../../src/lib/proofBundle';
import { buildChunkMapSidecar } from '../../src/provenance/trackChunks';
import {
  type AttestationRecord,
  type ChunkMapSidecar,
  type MotionVerdict,
  type SensorContext,
  type StreamedChunksTrackId,
  type TrackChunkMap,
} from '../../src/provenance/manifest';
import { sha256Hex, payloadDigest } from '../../src/lib/sign';
import { verifyOtsReceipt } from '../../src/lib/ots';
import { fetchBlockHeader } from '../../src/lib/otsClient';
import { listRosters } from '../../src/lib/rosterStore';
import { sealToDeskKey } from '../../src/lib/seal';
import { transcriptToSrt, transcriptToTxt } from '../../src/lib/transcript';
import { getDeviceKey } from '../../src/lib/deviceKey';
import { writeFileBytes, readFileBytes } from '../../src/lib/fileHash';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { useStore } from '../../src/store/useStore';

const W = Dimensions.get('window').width;

/**
 * HUD accents for this screen (0.18.2 — the landed palette of the app icon:
 * sage, cream, warm neutrals, muted clay). Identity/name and identifying
 * details share the muted warm clay, matching the camera HUD's byline and
 * location chips (app/(tabs)/index.tsx); the pure blue and pure yellow are
 * gone. Verdict semantics are unchanged: green is earned twice (INTACT and
 * a roster vouch), red is reserved for proven tamper, absence of proof is
 * neutral gray — never red, never alarming.
 */
const HUD = {
  identity: '#C08552',    // muted clay — the signer name/byline
  identifying: '#C08552', // muted clay — identifying details (was #F5B301)
  seal: '#809263',        // sage, matched to the aperture mark
  ink: '#0A0D10',
} as const;

/** Facets of a signed asset that could identify the signer if shared as-is. */
interface PiiFacets {
  byline: boolean;
  location: boolean;
  sensors: boolean;
  transcript: boolean;
  wifi: boolean;
  org: boolean;
  face: boolean;
}

/**
 * What a recipient could learn from this file beyond the pixels. Device model
 * is stripped by de-identification too, but it is not doxxing-grade, so it
 * never triggers the warning on its own. This gates the anti-doxxing interstitial.
 * Every facet is true ONLY when genuinely embedded in the signed record —
 * 'redacted' / 'unavailable' / 'never-recorded' sentinels all mean absent.
 */
function detectPii(record: AttestationRecord | null, transcript: TranscriptAssertion | null): PiiFacets {
  const identity = record?.identity;
  const ctx = record?.context;
  const orgCred = record?.orgCredential;
  return {
    byline: !!(identity && identity !== 'redacted' && identity.author),
    location: !!(ctx && typeof ctx.location === 'object'),
    sensors: !!(ctx && (ctx.motion != null || ctx.pressureHPa != null || ctx.altitudeM != null || ctx.headingDeg != null)),
    transcript: !!transcript,
    // A Wi-Fi network claim is a lead on where the signer was.
    wifi: !!(ctx && typeof ctx.wifi === 'object' && ctx.wifi != null),
    // An org credential in the signing identity (mirrored into the record)
    // or an org name in the identity claim names the signer's employer.
    org: !!(orgCred && (orgCred.issuer || orgCred.subject)) ||
      !!(identity && identity !== 'redacted' && identity.organization),
    // The face-check event flag: true only when the OS check actually ran and passed.
    face: record?.captureIntegrity?.biometricGatePassed === true,
  };
}

// ---------------------------------------------------------------------------
// Status pill — short labels only, wrapping inside the pill border.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Inline players — a quiet dark surface, a play/pause button, a draggable
// scrubber (PanResponder on a thin accent track), elapsed/total. No
// thumbnail theater, no fullscreen detour.
// ---------------------------------------------------------------------------

function fmtClock(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '0:00';
  const s = Math.floor(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function PlayerBar({ player }: { player: VideoPlayer }) {
  const styles = useThemedStyles(buildStyles);
  // Truth comes from the player: reaching the end flips the button back to play.
  const { isPlaying } = useEvent(player, 'playingChange', { isPlaying: player.playing });
  const [pos, setPos] = useState(0);
  const [dur, setDur] = useState(0);
  const trackWRef = useRef(0);
  const durRef = useRef(0);
  const scrubbingRef = useRef(false);

  // expo-video's time updates are polled here — cheap, and it keeps the
  // scrubber honest without depending on event cadence.
  useEffect(() => {
    const tick = setInterval(() => {
      const d = player.duration;
      const dd = Number.isFinite(d) && d > 0 ? d : 0;
      durRef.current = dd;
      setDur(dd);
      if (!scrubbingRef.current) {
        const t = player.currentTime;
        setPos(Number.isFinite(t) && t > 0 ? t : 0);
      }
    }, 250);
    return () => clearInterval(tick);
  }, [player]);

  const pan = useMemo(() => {
    const seek = (x: number) => {
      const w = trackWRef.current;
      const d = durRef.current;
      if (w <= 0 || d <= 0) return;
      const r = Math.min(1, Math.max(0, x / w));
      player.currentTime = r * d;
      setPos(r * d);
    };
    return PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      // Never cede the drag to the enclosing ScrollView mid-gesture.
      onPanResponderTerminationRequest: () => false,
      onShouldBlockNativeResponder: () => true,
      onPanResponderGrant: (e) => {
        scrubbingRef.current = true;
        seek(e.nativeEvent.locationX);
      },
      onPanResponderMove: (e) => seek(e.nativeEvent.locationX),
      onPanResponderRelease: () => {
        scrubbingRef.current = false;
      },
      onPanResponderTerminate: () => {
        scrubbingRef.current = false;
      },
    });
  }, [player]);

  const toggle = () => {
    if (isPlaying) {
      player.pause();
      return;
    }
    if (durRef.current > 0 && player.currentTime >= durRef.current - 0.05) {
      player.currentTime = 0; // replay from the top after a full listen
    }
    player.play();
  };

  const ratio = dur > 0 ? Math.min(1, Math.max(0, pos / dur)) : 0;
  return (
    <View style={styles.playerBar}>
      <Pressable
        style={styles.playerPlay}
        hitSlop={8}
        accessibilityLabel={isPlaying ? 'Pause' : 'Play'}
        onPress={toggle}
      >
        <Ionicons name={isPlaying ? 'pause' : 'play'} size={16} color="#fff" />
      </Pressable>
      <Text style={styles.playerTime}>{fmtClock(pos)}</Text>
      <View
        style={styles.playerTrackWrap}
        onLayout={(e) => {
          trackWRef.current = e.nativeEvent.layout.width;
        }}
        {...pan.panHandlers}
        accessibilityLabel="Seek"
      >
        {/* Children are pointerEvents="none" so the WRAP is always the touch
            target — otherwise a touch landing on the track/thumb reports
            locationX relative to that child and the scrubber jumps. */}
        <View style={styles.playerTrack} pointerEvents="none">
          <View style={[styles.playerTrackFill, { width: `${ratio * 100}%` }]} />
        </View>
        <View style={[styles.playerThumb, { left: `${ratio * 100}%` }]} pointerEvents="none" />
      </View>
      <Text style={styles.playerTime}>{fmtClock(dur)}</Text>
    </View>
  );
}

/** Inline video: the player surface itself, custom quiet controls beneath. */
function VideoPane({ uri }: { uri: string }) {
  const styles = useThemedStyles(buildStyles);
  const player = useVideoPlayer(uri, (p) => {
    p.loop = false;
  });
  return (
    <View>
      <View style={[styles.media, styles.videoSurface]}>
        <VideoView player={player} style={StyleSheet.absoluteFill} contentFit="contain" nativeControls={false} />
      </View>
      <PlayerBar player={player} />
    </View>
  );
}

/** Audio playback reuses the AVPlayer under expo-video — no waveform theater, just the essentials. */
function AudioPane({ uri }: { uri: string }) {
  const styles = useThemedStyles(buildStyles);
  const player = useVideoPlayer(uri, (p) => {
    p.loop = false;
  });
  return (
    <View style={styles.audioCard}>
      <View style={styles.audioHero}>
        <Ionicons name="mic" size={30} color={colors.onDark.faint} />
      </View>
      <PlayerBar player={player} />
    </View>
  );
}

// ---------------------------------------------------------------------------
// Nutrition label rows + trusted-time lines (folded in from TrustedTime —
// TSA operator names are deliberately never printed here; the authority is
// described, not branded).
// ---------------------------------------------------------------------------

function NlRow({ label, value, valueColor, detail, detailColor, mono }: {
  label: string;
  value: string;
  valueColor?: string;
  detail?: string;
  detailColor?: string;
  mono?: boolean;
}) {
  const nl = useThemedStyles(buildNl);
  return (
    <View style={nl.row}>
      <Text style={nl.label}>{label}</Text>
      <View style={nl.valueWrap}>
        <Text
          style={[nl.value, mono ? { fontFamily: type.mono } : null, valueColor ? { color: valueColor } : null]}
          selectable
        >
          {value}
        </Text>
        {detail ? <Text style={[nl.detail, detailColor ? { color: detailColor } : null]}>{detail}</Text> : null}
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Plan A: the collapsible group card — icon, title, chevron, and a
// one-line peek that stays visible whether open or closed. Three of these
// (Capture / Integrity / Advanced) replace the old always-visible nutrition
// label plus drawer.
// ---------------------------------------------------------------------------

function GroupCard({ icon, title, peek, open, onToggle, children }: {
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  peek: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  const grp = useThemedStyles(buildGrp);
  return (
    <View style={grp.card}>
      {/* The WHOLE header is the toggle: icon, title, peek
          line and chevron sit inside one Pressable — the old head-row-only
          target was a fingertip-miss machine. */}
      <Pressable style={grp.headBlock} onPress={onToggle} accessibilityLabel={`${title} section`} accessibilityRole="button">
        <View style={grp.head}>
          <Ionicons name={icon} size={15} color={colors.textDim} />
          <Text style={grp.title}>{title}</Text>
          <Ionicons name={open ? 'chevron-down' : 'chevron-forward'} size={14} color={colors.textFaint} />
        </View>
        <Text style={grp.peek}>{peek}</Text>
      </Pressable>
      {open ? <View style={grp.body}>{children}</View> : null}
    </View>
  );
}

/**
 * The one plain sentence (Plan A). Compression, never omission: signer, date,
 * place, seal state, time anchor — with "reported by the device" intact on
 * the location clause. Proven tamper turns the sentence red; absence of proof
 * stays neutral gray; nothing here ever says "authentic".
 */
function SummaryLine({ record, report, signerTrust, placeName }: {
  record: AttestationRecord;
  report: VerificationReport | null;
  signerTrust: SignerTrust;
  placeName: string | null;
}) {
  const sumStyles = useThemedStyles(buildSumStyles);
  const identity = record.identity;
  const loc = record.context?.location;
  const ts = report?.c2pa?.timestamps ?? null;

  let signer: string;
  if (record.deidentified) signer = 'A de-identified copy, re-signed on this phone';
  else if (identity && identity !== 'redacted' && identity.author) signer = `Sealed by ${identity.author}`;
 // De-identified copies are caught above; identity
  // 'redacted' HERE is an anonymous-mode capture — nothing was redacted,
  // no byline was ever provided. Say that, not the act.
  else if (identity === 'redacted') signer = 'Sealed without a byline';
  else if (signerTrust.tier === 'this-device') signer = 'Sealed by this phone';
  else if (signerTrust.tier === 'roster' && signerTrust.roster) signer = `Sealed by ${signerTrust.roster.roster.newsroom}`;
  else if (signerTrust.tier === 'org' && signerTrust.org) signer = `Sealed under ${signerTrust.org.subject}`;
  else signer = 'Sealed by an unnamed signer';

  const when = record.capturedAt ? fmtWhen(record.capturedAt) : null;

  // Proven tamper is named as such; "checking" is a transient neutral state.
  const bytesFailed =
    report?.checks.assetHashMatches === false ||
    report?.checks.signatureValid === false ||
    report?.c2pa?.assetHashFailure === 'void-binding';
  const bytesOk = report?.checks.assetHashMatches === true && report?.checks.signatureValid === true && !bytesFailed;

  return (
    <View style={sumStyles.card}>
      <Text style={sumStyles.text}>
        <Text style={sumStyles.strong}>{signer}</Text>
        {when ? <Text> on <Text style={sumStyles.strong}>{when}</Text></Text> : null}
        {loc && typeof loc === 'object' ? (
          <Text>, {placeName ? 'near ' : 'at the coordinates below'}{placeName ? <Text style={sumStyles.strong}>{placeName}</Text> : null}</Text>
        ) : null}
        <Text>. </Text>
        {bytesFailed ? (
          <Text style={sumStyles.bad}>The bytes NO LONGER match the seal. Changed after signing. </Text>
        ) : bytesOk ? (
          <Text style={sumStyles.good}>The bytes still match the seal</Text>
        ) : (
          <Text style={sumStyles.dim}>The seal is being checked… </Text>
        )}
        {bytesOk && ts && ts.trusted > 0 ? <Text>, and the time was countersigned</Text> : null}
        {bytesOk && ts && ts.present > 0 && ts.trusted === 0 ? <Text>, and a countersigned time rides with it (authority trust unchecked)</Text> : null}
        {bytesOk && (!ts || ts.present === 0) ? <Text>, but there is no independent time anchor; the date is the device's own</Text> : null}
        {bytesOk ? <Text>. </Text> : null}
        {loc === 'redacted' ? (
          <Text style={sumStyles.dim}>Location was redacted by the signer.</Text>
        ) : loc === 'unavailable' ? (
          <Text style={sumStyles.dim}>Location was unavailable at capture.</Text>
        ) : loc && typeof loc === 'object' ? (
          <Text style={sumStyles.dim}>Location is device-reported.</Text>
        ) : null}
      </Text>
    </View>
  );
}

/** Device clock vs countersigned time: disagreement beyond this turns red. */
const DEVICE_CLOCK_TOLERANCE_MS = 5 * 60 * 1000;
/** De-identified copies re-sign after the fact — a wider, stated tolerance. */
const DEID_CLOCK_TOLERANCE_MS = 15 * 60 * 1000;

function fmtWhen(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

interface TimeLine {
  icon: keyof typeof Ionicons.glyphMap;
  text: string;
  color: string;
}

function bitcoinCalendarLine(ots: OtsView): TimeLine {
  switch (ots.state) {
    case 'pending':
      return {
        icon: 'logo-bitcoin',
        color: colors.textDim,
        text:
          'Bitcoin calendar · stamp pending, not yet confirmed in a block' +
          (ots.queueDelayMs !== undefined && ots.queueDelayMs > 60_000
            ? ` · submitted ${Math.round(ots.queueDelayMs / 60_000)} min late (device was offline)`
            : ''),
      };
    case 'invalid':
      return { icon: 'logo-bitcoin', color: colors.danger, text: 'Bitcoin calendar · receipt FAILED verification' };
    case 'mismatch':
      return { icon: 'logo-bitcoin', color: colors.danger, text: 'Bitcoin calendar · receipt commits to a different record' };
    default:
      if (ots.binding === 'verified') {
        return { icon: 'logo-bitcoin', color: HUD.seal, text: `Bitcoin calendar · confirmed in block #${ots.height ?? '—'} · receipt matches the block` };
      }
      if (ots.binding === 'failed') {
        return { icon: 'logo-bitcoin', color: colors.danger, text: `Bitcoin calendar · receipt does NOT match block #${ots.height ?? '—'}` };
      }
      return {
        icon: 'logo-bitcoin',
        color: colors.textDim,
        text: ots.height
          ? `Bitcoin calendar · anchored in block #${ots.height} · confirmation not fetched (offline)`
          : 'Bitcoin calendar · confirmed on-chain · block binding unchecked',
      };
  }
}

/** "Aug 15, 2026 at 6:08 PM" — the timestamp row's date shape. Same
 *  formatter the Inspect screen's Timestamp row uses (keep the two 1:1). */
function fmtAt(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const date = d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `${date} at ${time}`;
}

/**
 * The timestamp row: a standard nutrition-label row — label left,
 * value right — never a giant heading. The value is the countersigned
 * authority time when a pinned token exists, the device clock otherwise;
 * the countersign state rides as the smaller sub-line in the app's existing
 * words: a genuine token whose authority is not pinned reads
 * "Countersigned"; no token reads "Not countersigned — device clock only",
 * neutral, never red. The device clock gets its own row when an anchor
 * exists, and turns red ONLY when it disagrees with the anchor by more
 * than the stated tolerance. Failed tokens are named as failed: proven
 * tamper, never absence of proof. Ledger time (the Bitcoin calendar) stays
 * a strictly separate row below. Same derivation and strings as the
 * Inspect screen's Timestamp row — the two never drift.
 */
function TimestampBlock({ report, otsView, capturedAt, deidentified }: {
  report: VerificationReport | null;
  otsView: OtsView | null;
  capturedAt: string;
  /** A de-identified copy is re-signed after the fact — its clock/anchor gap gets a wider tolerance. */
  deidentified?: boolean;
}) {
  useEffectiveScheme(); // re-render on palette flip — this component reads colors.* inline
  const ts = report?.c2pa?.timestamps ?? null;

  const anchorIso = ts && ts.trusted > 0 ? ts.earliestTrustedUtc : ts && ts.valid > 0 ? ts.earliestValidUtc : null;
  const anchorMs = anchorIso ? Date.parse(anchorIso) : NaN;
  const capturedMs = Date.parse(capturedAt);

  // The value: the countersigned anchor when a pinned authority
  // countersigned, else the device clock.
  const bigIso = ts && ts.trusted > 0 && ts.earliestTrustedUtc ? ts.earliestTrustedUtc : capturedAt;

  const statusLine = ts && ts.trusted > 0
    ? { text: 'Countersigned by independent authority', color: HUD.seal }
    : ts && ts.valid > 0
      ? { text: 'Countersigned', color: colors.textDim }
      : { text: 'Not countersigned — device clock only', color: colors.textDim };

  // The device clock, red only on a real disagreement with the anchor.
  const disagrees =
    anchorIso !== null && !isNaN(anchorMs) && !isNaN(capturedMs) &&
    Math.abs(capturedMs - anchorMs) > (deidentified ? DEID_CLOCK_TOLERANCE_MS : DEVICE_CLOCK_TOLERANCE_MS);

  // Unchecked tokens (parse/coverage gaps in this verifier) are disclosed
  // on their own neutral row — never folded into the red failure count.
  const failed = ts ? ts.present - ts.valid - (ts.unchecked ?? 0) : 0;
  const uncheckedTokens = ts?.unchecked ?? 0;

  return (
    <View>
      <NlRow label="Timestamp" value={fmtAt(bigIso)} detail={statusLine.text} detailColor={statusLine.color} />
      {anchorIso !== null && !isNaN(capturedMs) ? (
        <NlRow
          label="Device clock"
          value={fmtAt(capturedAt)}
          valueColor={disagrees ? colors.danger : undefined}
          detail={disagrees ? 'Does not agree with the countersigned time' : undefined}
          detailColor={disagrees ? colors.danger : undefined}
        />
      ) : null}
      {failed > 0 ? (
        <NlRow
          label="Countersignatures"
          value={`${failed} token${failed === 1 ? '' : 's'} FAILED verification`}
          valueColor={colors.danger}
        />
      ) : uncheckedTokens > 0 ? (
        <NlRow
          label="Countersignatures"
          value={`${uncheckedTokens} token${uncheckedTokens === 1 ? '' : 's'} not checkable by this build`}
          detail="A limitation of this verifier — not a finding against the file."
        />
      ) : null}
      {otsView ? (
        (() => {
          const line = bitcoinCalendarLine(otsView);
          return (
            <NlRow
              label="Bitcoin calendar"
              value={line.text.replace(/^Bitcoin calendar · /, '')}
              valueColor={line.color === colors.textDim ? undefined : line.color}
            />
          );
        })()
      ) : null}
    </View>
  );
}

function motionLabel(v: MotionVerdict): string {
  switch (v) {
    case 'handheld': return 'Handheld motion';
    case 'steady': return 'Device still';
    case 'moving': return 'Device moving';
    default: return 'Insufficient data';
  }
}

/** Round to `sig` significant digits — trailing zeros drop via Number. */
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
 * Sane significant figures for the camera-settings rows: 1/120 s, not
 * 0.0083333; ISO integers; f/1.8, not 1.7999999523162842.
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

/**
 * The committed second-camera frame for the MultipleLensCard: the photo
 * stereo section's secondary frame, or the first recorded video pair's
 * frame with its PTS anchor (so the comparison frame comes from the moment
 * the pair was taken). Hash-committed states are mirrored, never recomputed
 * here — the card decodes the committed bytes.
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
    // Every recorded pair frame — the filmstrip surface.
    const recordedPairs = (record.videoStereo?.pairs ?? []).filter(
      (p) => p.artifacts?.secondaryFrame?.state === 'recorded' && !!p.artifacts.secondaryFrame.dataBase64,
    );
    const videoFrames = recordedPairs.map((p) => {
      const f = p.artifacts.secondaryFrame;
      return {
        frame: { dataBase64: f.dataBase64!, mime: f.mime, sha256: f.sha256 },
        pairIndex: p.pairIndex,
 // The pair's own primary PTS anchor — a filmstrip
        // tap re-seeks the blend's primary frame to THAT pair's moment.
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
    // A committed pair whose frame errored is a stated failure; zero pairs
    // committed is an unreached state — neutral "Not recorded".
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
 * ENF anchor fields (firstSampleWallClockUtcMs / sampleRate / sampleCount)
 * are being added capture-side and may not exist on any record yet — read
 * tolerantly from the plausible homes and omit the row when absent.
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

export default function AssetScreen() {
  const styles = useThemedStyles(buildStyles);
  const nl = useThemedStyles(buildNl);
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { bumpVault } = useStore();

  const [entry, setEntry] = useState<VaultIndexEntry | null>(null);
  const [record, setRecord] = useState<AttestationRecord | null>(null);
  const [mediaUri, setMediaUri] = useState<string | null>(null);
  const [verdict, setVerdict] = useState<VerdictCode | null>(null);
  const [report, setReport] = useState<VerificationReport | null>(null);
  const [signerTrust, setSignerTrust] = useState<SignerTrust>({ tier: 'unknown' });
  const [ownFingerprint, setOwnFingerprint] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [viewerOpen, setViewerOpen] = useState(false);
 // Plan A: the nutrition-label drawer is gone — three collapsible
  // groups carry the same facts (Capture open by default; Integrity and
  // Advanced collapsed behind a one-line peek each).
  const [groupOpen, setGroupOpen] = useState({ capture: true, integrity: false, advanced: false });
  // Reverse-geocoded place for the one-line summary. Uses the platform
  // geocoder on the owner's OWN coordinates, only while this screen is open;
  // failure just falls back to "at the coordinates below" — never a fake place.
  const [placeName, setPlaceName] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<TranscriptAssertion | null>(null);
  // The parsed C2PA manifest: drives the transcript, the Camera Settings
  // rows, and the raw manifest shown open at the bottom of Advanced.
  const [manifest, setManifest] = useState<C2paManifest | null>(null);
  const [legacyVideo, setLegacyVideo] = useState(false);
  // The export sheet: one bottom sheet with the four bundle
  // options — Basic / Full / Proof-Only / Custom — replacing the old two-step
  // share menu + share sheet.
  const [exportOpen, setExportOpen] = useState(false);
  /**
   * Seal-to-desk target: present only when a trusted roster
   * carries a desk encryption key. Invisible until a newsroom configures it —
   * a personal device never sees this.
   */
  const [deskTarget, setDeskTarget] = useState<{ newsroom: string; publicKeyBase64: string; fingerprint: string } | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const rosters = await listRosters();
        const withKey = rosters.find((r) => r.encryption);
        setDeskTarget(
          withKey?.encryption
            ? { newsroom: withKey.newsroom, publicKeyBase64: withKey.encryption.deskPublicKeyBase64, fingerprint: withKey.encryption.fingerprint }
            : null
        );
      } catch {
        setDeskTarget(null); // a roster read failure hides the option, never blocks the page
      }
    })();
  }, []);

  useEffect(() => {
    (async () => {
      try {
        if (!id) return;
        const items = await listItems();
        const found = items.find((i) => i.id === id) ?? null;
        setEntry(found);
        if (!found) return;
        const [rec, uri, key] = await Promise.all([
          getRecord(id),
          decryptItemToCache(id),
          getDeviceKey().catch(() => null),
        ]);
        setRecord(rec);
        setMediaUri(uri);
        setOwnFingerprint(key?.fingerprint ?? null);

        // OTS receipts upgrade lazily: a pending submission becomes a
        // confirmed Bitcoin anchor hours later. Re-ask the calendars when
        // the record is viewed; persist any upgrade into the vault.
        if (rec?.ots?.submissions.some((s) => s.state === 'pending')) {
          void upgradePendingOts(id, rec).then((next) => {
            if (next) setRecord((cur) => (cur ? { ...cur, ots: next } : cur));
          }).catch(() => {});
        }

        // Re-verify now, against the decrypted bytes. Video and audio carry
        // the manifest inside the container; pre-0.6 videos fall back to the
        // sidecar record honestly (the UI then says so).
        if (rec) {
          if (found.kind === 'photo') {
            const r = await verifyPhoto(uri);
            setReport(r);
            setVerdict(r.verdict);
          } else {
            const r = await verifyVideo(uri);
            if (r.verdict === 'NO_ATTESTATION') {
              setLegacyVideo(true);
              const legacy = await verifyWithSidecar(uri, rec, {
                // Same trust axis as the c2pa path —
                // the report carries the tier, not just the UI effect.
                trustResolver: ({ fingerprint, verifiedAtMs, orgChain }) =>
                  resolveSignerTrust({ fingerprint, ownFingerprint, orgChain, atMs: verifiedAtMs }),
              });
              // The sidecar path verifies the pair honestly; its report
              // drives the ladder as-is (fewer c2pa facets by nature).
              setReport(legacy);
              setVerdict(legacy.verdict);
            } else {
              setReport(r);
              setVerdict(r.verdict);
            }
          }
        }

        // The embedded manifest — read from the signed file, never from a
        // side database. Drives the transcript (audio), the Camera Settings
        // rows, and the raw manifest view in Advanced.
        try {
          const bytes = await readFileBytes(uri);
          const store = found.kind === 'photo' ? extractC2paStore(bytes) : extractC2paStoreBmff(bytes);
          const m = store ? parseManifest(store.payload) : null;
          setManifest(m);
          if (found.kind === 'audio' && m?.transcript) setTranscript(m.transcript);
        } catch { /* manifest display is best-effort */ }
      } catch {
        // A corrupted vault entry must never white-screen the app: the page
        // stays up with whatever loaded, and the delete action still works.
      }
    })();
  }, [id]);

  // Signer trust resolves against anchors OUTSIDE the file (this device →
  // newsroom roster → org chain), membership at the verified signing time
  // only — the same rule the Inspect tab applies.
  const signerFp = report?.c2pa?.signerFingerprint ?? report?.record?.signer?.fingerprint ?? null;
  const verifiedAtMs = report?.c2pa?.timestamps.earliestTrustedUtc
    ? Date.parse(report.c2pa.timestamps.earliestTrustedUtc)
    : null;
  useEffect(() => {
    let cancelled = false;
    if (!signerFp) { setSignerTrust({ tier: 'unknown' }); return; }
    resolveSignerTrust({
      fingerprint: signerFp,
      ownFingerprint,
      orgChain: report?.c2pa?.certChain
        ? { linksValid: report.c2pa.certChain.linksValid, topSubject: report.c2pa.certChain.topSubject, issuer: null }
        : null,
      atMs: verifiedAtMs,
    })
      .then((t) => { if (!cancelled) setSignerTrust(t); })
      .catch(() => { if (!cancelled) setSignerTrust({ tier: 'unknown' }); });
    return () => { cancelled = true; };
  }, [signerFp, ownFingerprint, verifiedAtMs, report]);

  /**
   * Local signer history for the honesty fix below: when the signer is only
   * SELF-RECOGNIZED (this device recognizing its own key), the ladder gets
   * the unidentified floor with this device's collection history stated as
   * what it is — local history, not vouching. Other devices cannot
   * recognize this signer; only an org credential or a roster/trust-list
   * vouch lights the identified rung.
   */
  const [localHand, setLocalHand] = useState<{ priorCaptures: number; firstSeen: string } | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (!signerFp || signerTrust.tier !== 'this-device') { setLocalHand(null); return; }
    (async () => {
      try {
        const items = await listItems();
        const mine = items.filter((i) => i.fingerprint === signerFp);
        if (mine.length === 0) { if (!cancelled) setLocalHand(null); return; }
        const firstSeen = mine.reduce((a, b) => (a.createdAt < b.createdAt ? a : b)).createdAt;
        if (!cancelled) setLocalHand({ priorCaptures: mine.length, firstSeen });
      } catch {
        if (!cancelled) setLocalHand(null);
      }
    })();
    return () => { cancelled = true; };
  }, [signerFp, signerTrust.tier]);

  /**
   * Ledger time: the Bitcoin anchor's block-header check is fetched
   * AUTOMATICALLY when a network path exists — never behind a tap. Offline,
   * the anchor is shown with the binding honestly unchecked ("confirmation
   * not fetched"). Receipts are verified against the record's payload digest;
   * ledger time stays strictly separate from RFC 3161 authority time. The
   * fetch is one 80-byte block header from a public Esplora API — the event
   * is disclosed in the Inspect tab's field guide, never hidden.
   */
  const [otsView, setOtsView] = useState<OtsView | null>(null);
  useEffect(() => {
    let cancelled = false;
    const rec = record ?? null;
    const ots = rec?.ots ?? null;
    if (!rec || !ots) { setOtsView(null); return; }
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
      // Completing the binding requires the block header — network. Fetched
      // automatically; offline the anchor shows with the binding unchecked.
      const header = await fetchBlockHeader(height).catch(() => null);
      if (cancelled) return;
      if (!header) { setOtsView({ state: 'confirmed', height, binding: 'unchecked', queueDelayMs: delay }); return; }
      const bound = verifyOtsReceipt(base64ToBytes(conf.s.receipt), digest, header);
      setOtsView({
        state: 'confirmed', height,
        binding: bound.blockBindingValid === true ? 'verified' : 'failed',
        queueDelayMs: delay,
      });
    })();
    return () => { cancelled = true; };
  }, [record]);

  // One-line summary place name: reverse-geocode the owner's own coordinates
  // (CLGeocoder). Runs only while this screen is open; any failure falls back
  // to "at the coordinates below" — a wrong place name would be worse than none.
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

  /**
   * The plain cache is shredded on lock/background — and iOS can purge
   * Caches/ at any time — so the `mediaUri` captured at mount can dangle by
   * the time the user taps an action. Every action re-materializes from the encrypted vault
   * (decryptItemToCache self-heals on a cache miss) instead of trusting the
   * mount-time URI. Display state is healed along the way.
   */
  const freshUri = async (): Promise<string | null> => {
    if (!id) return null;
    try {
      const uri = await decryptItemToCache(id);
      setMediaUri(uri);
      return uri;
    } catch {
      return null;
    }
  };

  /** Fullscreen opens on a freshly materialized URI — the cache may have been shredded since mount. */
  const openViewer = async () => {
    await freshUri();
    setViewerOpen(true);
  };

  const shareAsIs = async () => {
    if (!mediaUri) return;
    setBusy('Preparing media…');
    try {
      const uri = await freshUri();
      if (!uri) throw new Error('Could not decrypt the item. Is the vault locked?');
      if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(uri);
    } catch (e) {
      Alert.alert('Share failed', e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setBusy(null);
    }
  };

  /**
   * Detachable proof: proof that travels without the media.
   * Hash-only releases nothing but hashes, times, and the key fingerprint —
   * the source-protection primitive. Proof-only adds the full record and
   * embedded manifest; a desk verifies every claim except the pixels and
   * matches the media later by hash.
   */
  const shareProofJson = async (mode: 'hash-only' | 'proof-only') => {
    if (!record || !mediaUri) return;
    setBusy('Building proof…');
    try {
      let json: string;
      let name: string;
      if (mode === 'hash-only') {
        json = JSON.stringify(buildHashClaim(record), null, 2) + '\n';
        name = `verify-hash-${id}.json`;
      } else {
        // Include the embedded manifest so a desk can inspect the C2PA layer
        // without the media. Photos/PNG: APP11/caBX segment; BMFF: uuid box.
        let manifestB64: string | null = null;
        let chunkMaps: ChunkMapSidecar | null = null;
        try {
          const uri = await freshUri();
          if (!uri) throw new Error('vault locked');
          const bytes = await readFileBytes(uri);
          const store = entry?.kind === 'photo' ? extractC2paStore(bytes) : extractC2paStoreBmff(bytes);
          if (store) manifestB64 = bytesToBase64(store.payload);
          // Chunk-map sidecar: the v2 chunk maps stored at seal time
          // ride the bundle so the desk can RANGE-verify the delivery file.
          // Absent is fine — stills, degraded v2 builds, older items: the
          // field is honestly omitted, root-only verification remains.
          try {
            const sealedMaps = await unsealVaultJson<Partial<Record<StreamedChunksTrackId, TrackChunkMap>>>(
              await readFileBytes(`${FileSystem.documentDirectory}disclosure/${id}.chunks.json`),
            );
            if (sealedMaps && Object.keys(sealedMaps).length > 0) {
              // Binds the SIGNED delivery bytes — the file the desk will hash.
              chunkMaps = buildChunkMapSidecar(sha256Hex(bytes), sealedMaps);
            }
          } catch { /* no stored chunk maps — the sidecar is honestly absent */ }
        } catch { /* proof without the manifest segment is still complete */ }
        // Stereo section (format /2): persisted on the vault record at seal
        // time; absent for pre-0.13 or non-stereo captures — omitted field,
        // honest absence.
        json = JSON.stringify(buildProofBundle(record, manifestB64, chunkMaps, record.stereo ?? null, record.videoStereo ?? null), null, 2) + '\n';
        name = `verify-proof-${id}.json`;
      }
      const path = `${FileSystem.cacheDirectory}${name}`;
      await FileSystem.writeAsStringAsync(path, json);
      if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(path, { mimeType: 'application/json' });
    } finally {
      setBusy(null);
    }
  };

  /**
   * Seal-to-desk: the capture and its proof, encrypted to the
   * newsroom's desk key. What leaves the phone is ciphertext only the desk's
   * key-share holders can open — the seizure case. The vault copy is
   * untouched; this seals a COPY for the desk.
   */
  const sealForDesk = async () => {
    if (!record || !mediaUri || !deskTarget) return;
    setBusy('Encrypting & sealing…');
    try {
      const uri = await freshUri();
      if (!uri) throw new Error('Could not decrypt the item. Is the vault locked?');
      let manifestB64: string | null = null;
      const bytes = await readFileBytes(uri);
      try {
        const store = entry?.kind === 'photo' ? extractC2paStore(bytes) : extractC2paStoreBmff(bytes);
        if (store) manifestB64 = bytesToBase64(store.payload);
      } catch { /* proof without the manifest segment is still complete */ }
      // Chunk-map sidecar (same as the proof-only export above): the v2
      // chunk maps stored at seal time ride the sealed
      // proof so the desk can RANGE-verify the delivery file. Absent is fine
      // — stills, degraded v2 builds, older items: the field is honestly
      // omitted, root-only verification remains.
      let chunkMaps: ChunkMapSidecar | null = null;
      try {
        const sealedMaps = await unsealVaultJson<Partial<Record<StreamedChunksTrackId, TrackChunkMap>>>(
          await readFileBytes(`${FileSystem.documentDirectory}disclosure/${id}.chunks.json`),
        );
        if (sealedMaps && Object.keys(sealedMaps).length > 0) {
          // Binds the SIGNED delivery bytes — the file the desk will hash.
          chunkMaps = buildChunkMapSidecar(sha256Hex(bytes), sealedMaps);
        }
      } catch { /* no stored chunk maps — the sidecar is honestly absent */ }
      const proofJson = JSON.stringify(buildProofBundle(record, manifestB64, chunkMaps, record.stereo ?? null, record.videoStereo ?? null), null, 2) + '\n';
      const sealed = sealToDeskKey(bytes, proofJson, base64ToBytes(deskTarget.publicKeyBase64));
      const path = `${FileSystem.cacheDirectory}exhibit-sealed-${id}.vseal`;
      await writeFileBytes(path, sealed);
      if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(path, { mimeType: 'application/octet-stream' });
    } finally {
      setBusy(null);
    }
  };

  const confirmSealForDesk = () => {
    if (!deskTarget) return;
    Alert.alert(
      `Seal to ${deskTarget.newsroom}`,
      `This capture and its proof are encrypted to the newsroom's desk key (${deskTarget.fingerprint.slice(0, 16)}…).\n\nWhat leaves the phone is ciphertext only the desk's key-share holders can open: not you, not us. Your vault copy stays exactly as it is.\n\nSealing hides WHAT you shared. It never hides THAT you shared something.`,
      [
        { text: 'Seal & share', onPress: () => void sealForDesk() },
        { text: 'Cancel', style: 'cancel' },
      ]
    );
  };

  /**
   * Export sheet: every media/proof share routes through the one bottom
   * sheet — Basic (private, withheld-fields copy) is the pre-selected
   * default, Full is the honest identifying alternative. No Alert.alert in
   * the share path. The sheet changes UX only; the freshUri() self-heal
   * plumbing underneath stays.
   */
  const shareMedia = () => {
    if (!mediaUri || !entry) return;
    setExportOpen(true);
  };

  /** De-identified photo share — same format (JPEG) or a PNG format change. */
  const shareDeidentifiedPhoto = async (format: 'jpeg' | 'png') => {
    if (!mediaUri || entry?.kind !== 'photo') return;
    setBusy(format === 'png' ? 'Making a de-identified PNG · re-encoding & re-signing…' : 'Making a de-identified copy · removing identity & re-signing…');
    try {
      const key = await getDeviceKey();
      const uri = await freshUri();
      if (!uri) throw new Error('Could not decrypt the photo. Is the vault locked?');
      if (format === 'png') {
        // Re-encode pixels to PNG (this drops the JPEG's EXIF), then de-identify
        // & re-sign so the PNG is itself fully verifiable.
        const context = ImageManipulator.manipulate(uri);
        const rendered = await context.renderAsync();
        const out = await rendered.saveAsync({ format: SaveFormat.PNG });
        const pngBytes = await readFileBytes(out.uri);
        const { signedPngBytes } = await deidentifyPhotoToPng({ pngBytes, key, capturedAt: record?.capturedAt, source: { context: record?.context ?? null, deviceModel: record?.device?.model ?? null } });
        const path = `${FileSystem.cacheDirectory}exhibit-deidentified-${entry.id}.png`;
        await writeFileBytes(path, signedPngBytes);
        if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(path, { mimeType: 'image/png' });
      } else {
        const { signedPhotoBytes } = await deidentifyPhoto({ photoUri: uri, key, capturedAt: record?.capturedAt, source: { context: record?.context ?? null, deviceModel: record?.device?.model ?? null } });
        const path = `${FileSystem.cacheDirectory}exhibit-deidentified-${entry.id}.jpg`;
        await writeFileBytes(path, signedPhotoBytes);
        if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(path, { mimeType: 'image/jpeg' });
      }
    } catch (e) {
      Alert.alert('De-identify failed', e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setBusy(null);
    }
  };

  /** De-identified video/audio share — drops byline/location/Wi-Fi/key linkage and any transcript; carries the non-identifying evidence (motion, sensors, second views) verbatim. */
  const shareDeidentifiedBmff = async () => {
    if (!mediaUri || !entry || (entry.kind !== 'video' && entry.kind !== 'audio')) return;
    setBusy('Making a de-identified copy · removing identity & re-signing…');
    try {
      const key = await getDeviceKey();
      const uri = await freshUri();
      if (!uri) throw new Error('Could not decrypt the item. Is the vault locked?');
      const bytes = await readFileBytes(uri);
      const mime = record?.asset.mime ?? (entry.kind === 'audio' ? 'audio/mp4' : 'video/mp4');
      const { signedBytes } = await deidentifyBmff({ bytes, mime, kind: entry.kind, key, capturedAt: record?.capturedAt, source: { context: record?.context ?? null, deviceModel: record?.device?.model ?? null } });
      const ext = mime === 'video/quicktime' ? 'mov' : entry.kind === 'audio' ? 'm4a' : 'mp4';
      const path = `${FileSystem.cacheDirectory}verify-deidentified-${entry.id}.${ext}`;
      await writeFileBytes(path, signedBytes);
      if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(path, { mimeType: mime });
    } catch (e) {
      Alert.alert('De-identify failed', e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setBusy(null);
    }
  };

  const exportAttestation = async () => {
    if (!record || !entry) return;
    setBusy('Exporting attestation…');
    try {
      const path = `${FileSystem.cacheDirectory}attestation-${entry.id}.json`;
      await FileSystem.writeAsStringAsync(path, recordToSidecarJson(record));
      if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(path, { mimeType: 'application/json' });
    } finally {
      setBusy(null);
    }
  };

  const exportTranscript = async (format: 'txt' | 'srt') => {
    if (!transcript || !record || !entry) return;
    setBusy('Exporting transcript…');
    try {
      const content =
        format === 'srt' ? transcriptToSrt(transcript.segments) : transcriptToTxt(transcript.text, record.capturedAt);
      const path = `${FileSystem.cacheDirectory}transcript-${entry.id}.${format}`;
      await FileSystem.writeAsStringAsync(path, content);
      if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(path, { mimeType: 'text/plain' });
    } finally {
      setBusy(null);
    }
  };

  const saveToPhotos = async () => {
    if (!mediaUri || !entry || entry.kind === 'audio') return;
    setBusy('Saving to Photos…');
    try {
      const uri = await freshUri();
      if (!uri) throw new Error('Could not decrypt the item. Is the vault locked?');
      await MediaLibrary.saveToLibraryAsync(uri);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      Alert.alert('Saved', 'The signed file, attestation embedded, is in your camera roll.');
    } catch (e) {
      Alert.alert('Save failed', e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setBusy(null);
    }
  };

  const confirmDelete = () => {
    Alert.alert('Delete permanently?', 'The encrypted original and its attestation will be destroyed. This cannot be undone.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          if (!id) return;
          await deleteItem(id);
          bumpVault();
          router.back();
        },
      },
    ]);
  };

 // The raw manifest reel is the shared ManifestReel component —
  // the FULL manifest, uncapped, windowed so a video manifest's telemetry
  // actually renders. See src/components/ManifestReel.tsx.

  // Forensic Checks inputs, derived once from the sealed record.
  const secondary = useMemo(
    () => (record ? secondaryFrameFor(record) : { frame: null, ptsSeconds: null, recordError: null, videoFrames: null }),
    [record],
  );
  const enfAnchor = useMemo(() => (record ? readEnfAnchor(record) : null), [record]);
  // The sealed when/where, as one line for the environment modules — the
  // reverse-geocoded place name when it resolved, the coordinates otherwise.
  const sealedWhenWhere = useMemo(() => {
    if (!record) return '';
    const l = record.context?.location;
    const where =
      l && typeof l === 'object' ? placeName ?? `${l.lat.toFixed(4)}, ${l.lon.toFixed(4)}` : null;
    return [fmtWhen(record.capturedAt), where].filter(Boolean).join(' · ');
  }, [record, placeName]);
  const juxta = useMemo(
    () => (record ? juxtaInputs(record, sealedWhenWhere) : null),
    [record, sealedWhenWhere],
  );

  if (!entry) {
    return (
      <SafeAreaView style={styles.safe}>
        <ActivityIndicator color={colors.accent} style={{ marginTop: 80 }} />
      </SafeAreaView>
    );
  }

  const ctx: SensorContext | undefined = record?.context;
  const loc = ctx?.location;
  const identity = record?.identity;
  const orgValue =
    (identity && identity !== 'redacted' && identity.organization) ||
    record?.orgCredential?.issuer ||
    record?.orgCredential?.subject ||
    null;
  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <View style={styles.topBar}>
        <Button small tone="ghost" icon="chevron-back" label="Exhibits" onPress={() => router.back()} />
        {/* The corner status pill was removed: it duplicated the
            trust ladder two scrolls down and read as decoration. State lives
            in the ladder, once. */}
      </View>

      <ScrollView contentContainerStyle={{ paddingBottom: spacing.xxl }}>
        <View style={styles.mediaWrap}>
          {mediaUri ? (
            entry.kind === 'photo' ? (
              <Image
                source={{ uri: mediaUri }}
                style={styles.media}
                contentFit="contain"
                transition={100}
                onError={() => void freshUri()}
              />
            ) : entry.kind === 'video' ? (
              <VideoPane uri={mediaUri} />
            ) : (
              <AudioPane uri={mediaUri} />
            )
          ) : (
            <View style={[styles.media, styles.mediaLoading]}>
              <ActivityIndicator color={colors.accent} />
            </View>
          )}
          {mediaUri && entry.kind === 'photo' ? (
            <Pressable style={styles.expandHint} onPress={() => void openViewer()} hitSlop={12} accessibilityLabel="View fullscreen">
              <Ionicons name="expand-outline" size={16} color="#fff" />
            </Pressable>
          ) : null}
        </View>

        {viewerOpen && mediaUri && entry.kind === 'photo' ? (
          <MediaViewer uri={mediaUri} kind={entry.kind} onClose={() => setViewerOpen(false)} />
        ) : null}

        {/* Plan A: one plain sentence up top — signer, when, where,
            seal state, time anchor. Compression, never omission. */}
        {record ? (
          <View style={{ paddingHorizontal: spacing.md, marginTop: spacing.md }}>
            <SummaryLine record={record} report={report} signerTrust={signerTrust} placeName={placeName} />
          </View>
        ) : null}

        {/* Exactly three actions (Noah's call, 0.14.0): Share opens the
            export sheet (0.15.0 Drop 2 — Basic / Full / Proof-Only /
            Custom); Download and Delete are their own buttons. */}
        <View style={styles.actions}>
          <View style={styles.actionCell}>
            <Button
              small
              icon="share-outline"
              label="Share"
              tone="secondary"
              onPress={shareMedia}
              loading={
                busy === 'Preparing media…' ||
                busy === 'Making a de-identified copy · removing identity & re-signing…' ||
                busy === 'Making a de-identified PNG · re-encoding & re-signing…' ||
                busy === 'Building proof…' ||
                busy === 'Exporting attestation…' ||
                busy === 'Encrypting & sealing…'
              }
            />
          </View>
          <View style={styles.actionCell}>
            <Button
              small
              icon="download-outline"
              label="Download"
              tone="secondary"
              onPress={saveToPhotos}
              loading={busy === 'Saving to Photos…'}
              disabled={entry.kind === 'audio'}
            />
          </View>
          <View style={styles.actionCell}>
            <Button small icon="trash-outline" label="Delete" tone="danger" onPress={confirmDelete} />
          </View>
        </View>

        {/* Export defaults are stated in the export sheet itself. This
            spacer holds the rhythm that copy would occupy — two lines at
            fontSize.xs — so the layout doesn't collapse upward. */}
        <View style={styles.sharePrivacySpacer} />

        {transcript ? (
          <View style={styles.transcriptWrap}>
            <Card>
              <Text style={styles.transcriptTitle}>Transcript</Text>
              <Text style={styles.transcriptBody}>{transcript.text}</Text>
              <Text style={styles.transcriptNote}>
                Transcribed on-device at capture time and sealed inside the signed file.
              </Text>
              <View style={styles.transcriptActions}>
                <Button small icon="document-outline" label=".txt" tone="secondary" onPress={() => exportTranscript('txt')} loading={busy === 'Exporting transcript…'} />
                <Button small icon="time-outline" label=".srt" tone="secondary" onPress={() => exportTranscript('srt')} loading={busy === 'Exporting transcript…'} />
              </View>
            </Card>
          </View>
        ) : null}

        {/* Plan A: three collapsible groups replace the nutrition
            label + drawer. Capture (open by default) answers "when, where,
            on what" — device-originated claims are grouped under heads that
            carry the device-reported caveat once. */}
        {record ? (
          <View style={{ paddingHorizontal: spacing.md, marginBottom: spacing.md }}>
            <GroupCard
              icon="time-outline"
              title="Capture"
              peek="When, where, on what."
              open={groupOpen.capture}
              onToggle={() => setGroupOpen((g) => ({ ...g, capture: !g.capture }))}
            >
              <Text style={nl.drawerHead}>When &amp; Where</Text>
              <TimestampBlock report={report} otsView={otsView} capturedAt={record.capturedAt} deidentified={!!record.deidentified} />
              {/* 0.18.6 (Noah): 'redacted' in an anonymous-mode capture means
                  no byline was ever provided — the word "redacted" asserts a
                  removal that never happened. Only a de-identified COPY
                  (the marker is set by the re-seal) earns "Redacted by
                  signer"; everything else with no name reads Not provided. */}
              {identity === 'redacted' ? (
                <NlRow label="Byline" value={record.deidentified ? 'Redacted by signer' : 'Not provided'} />
              ) : identity?.author ? (
                <NlRow label="Byline" value={identity.author} valueColor={HUD.identity} />
              ) : (
                <NlRow label="Byline" value="Not provided" />
              )}
              {loc === 'redacted' ? (
                <NlRow label="Location" value="Redacted by signer" />
              ) : loc === 'unavailable' ? (
                <NlRow label="Location" value="Unavailable at capture" />
              ) : loc ? (
                <View style={nl.row}>
                  <Text style={nl.label}>Location</Text>
                  <View style={nl.valueWrap}>
                    <Text style={[nl.value, { color: HUD.identifying }]} selectable>
                      {`${loc.lat.toFixed(5)}, ${loc.lon.toFixed(5)}`}
                    </Text>
                    <Text style={nl.detail}>Device-reported.</Text>
                    <Pressable
                      style={nl.mapsButton}
                      hitSlop={6}
                      accessibilityLabel="Open in Google Maps"
                      onPress={() => void Linking.openURL(`https://www.google.com/maps/search/?api=1&query=${loc.lat},${loc.lon}`)}
                    >
                      <Ionicons name="map-outline" size={12} color={colors.info} />
                      <Text style={nl.mapsButtonText}>Google Maps</Text>
                    </Pressable>
                  </View>
                </View>
              ) : null}

              {ctx?.wifi === 'redacted' ? (
                <NlRow label="Wi-Fi" value="Redacted by signer" />
              ) : ctx?.wifi === 'unavailable' ? (
                <NlRow label="Wi-Fi" value="Unavailable at capture" />
              ) : ctx?.wifi ? (
                <>
                  {/* The BSSID is the corroboratable claim; the
                      network name is kept off this page (anyone can name
                      a network anything — and it's a privacy leak). */}
                  {ctx.wifi.bssid ? <NlRow label="Wi-Fi BSSID" value={ctx.wifi.bssid} mono /> : (
                    <NlRow label="Wi-Fi" value={ctx.wifi.ssid ?? '(none reported)'} detail="A lead, never proof of place." />
                  )}
                </>
              ) : null}

              <View style={nl.drawerSection}>
                <Text style={nl.drawerHead}>Device</Text>
                <NlRow label="Device model" value={record.device.model ?? '—'} />
                <NlRow
                  label="Platform"
                  value={record.device.platform === 'ios' ? 'iOS' : record.device.platform}
                />
                {/* The capture software is a capture claim like any
                    other — the sealed claim-generator string ("Source Kit/
                    0.18.0 (com.verify.camera)"), the record's own app block
                    as the honest fallback. */}
                <NlRow
                  label="Capture software"
                  value={manifest?.claimGenerator ?? report?.c2pa?.generator ?? `${record.app.name} ${record.app.version}`}
                />
                {/* An absent org credential says nothing — never a warning. */}
                {orgValue ? <NlRow label="Organization" value={orgValue} /> : null}
                {/* Byline renders once — in When & Where above (0.14.0
                    dedupe). */}
              </View>

              {/* Sensors sit at the bottom of Capture; the head carries the
                  device-reported caveat once, not on every row. */}
              {ctx?.headingDeg != null || ctx?.pressureHPa != null || ctx?.altitudeM != null || ctx?.motion || ctx?.sensorTiming ? (
                <View style={nl.drawerSection}>
                  <Text style={nl.drawerHead}>Sensors (Device-reported)</Text>
                  {ctx?.headingDeg != null ? <NlRow label="Heading" value={`${ctx.headingDeg}°`} /> : null}
                  {ctx?.pressureHPa != null ? <NlRow label="Barometer" value={`${ctx.pressureHPa} hPa`} /> : null}
                  {/* Altitude rides the same sensors block here as on
                      the Inspect screen — same sealed claim, same row. */}
                  {ctx?.altitudeM != null ? <NlRow label="Altitude (baro.)" value={`${ctx.altitudeM} m`} /> : null}
                  {ctx?.motion ? (
                    <NlRow label="Motion" value={`${motionLabel(ctx.motion.verdict)} · ${ctx.motion.peakHz} Hz peak`} />
                  ) : null}
                  {/* Sensor timing renders once — under Integrity, where
                      sampler regularity belongs as an integrity signal
                      (0.14.0 dedupe). */}
                </View>
              ) : null}

              {/* Mains frequency: removed from this page. It was
                  region-derived, never measured — decoration, not
                  evidence. The ENF question moves to the raw-audio
                  master, where it can be measured for real. */}

              {manifest?.exif && Object.keys(manifest.exif.data).filter((k) => k !== 'note').length > 0 ? (
                <View style={nl.drawerSection}>
                  <Text style={nl.drawerHead}>Camera Settings (Device-reported)</Text>
                  {/* The sealed block's `note` key is provenance boilerplate
                      ("camera-pipeline-reported, signed as self-reported
                      metadata"), not a camera setting — never a row (0.18.1).
                      The head already carries the device-reported caveat. */}
                  {Object.entries(manifest.exif.data).filter(([k]) => k !== 'note').map(([k, v]) => (
                    <NlRow key={k} label={EXIF_LABELS[k] ?? k} value={formatExifValue(k, v)} />
                  ))}
                  {/* Not boilerplate — a conditional security fact: an
                      unreferenced block binds to nothing signed. */}
                  {manifest.exif.referenced ? null : (
                    <Text style={nl.detail}>This block is not referenced by the signed claim, so it binds to nothing.</Text>
                  )}
                </View>
              ) : null}
            </GroupCard>
          </View>
        ) : null}

        {/* Integrity (Plan A): the custody story in one collapsed group —
            capture integrity, the Forensic Checks modules, then the five
            rungs computed NOW from the live re-verification. Ledger state
            comes from otsView, whose block-header check is auto-fetched
            when a network path exists (offline: honestly "unchecked",
            never hidden). */}
        {report && record ? (
          <View style={{ paddingHorizontal: spacing.md, marginBottom: spacing.md }}>
            <GroupCard
              icon="lock-closed-outline"
              title="Integrity"
              peek="What was checked, and everything captured alongside it."
              open={groupOpen.integrity}
              onToggle={() => setGroupOpen((g) => ({ ...g, integrity: !g.integrity }))}
            >
              {record.captureIntegrity || report ? (
                <View style={{ marginBottom: spacing.md }}>
                  <Text style={nl.drawerHead}>Capture integrity</Text>
                  <NlRow
                    label="App Attest"
                    value={
                      report.c2pa?.appAttest.present
                        ? report.c2pa.appAttest.valid
                          ? 'Assertion embedded'
                          : 'Assertion embedded · FAILED verification'
                        : 'Not embedded'
                    }
                    valueColor={
                      report.c2pa?.appAttest.present && !report.c2pa.appAttest.valid ? colors.danger : undefined
                    }
                    detail={
                      report.c2pa?.appAttest.present
                        ? report.c2pa.appAttest.valid
                          ? `Apple's device-integrity assertion rides inside the signed file${report.c2pa.appAttest.attestationEnv ? ` (${report.c2pa.appAttest.attestationEnv} authenticator)` : ''}.`
                          : (report.c2pa.appAttest.reason ?? 'The embedded assertion did not verify.')
                        : 'No Apple device-integrity assertion rides inside this file.'
                    }
                  />
                  {record.captureIntegrity ? (
                    <NlRow
                      label="Shutter → signature"
                      value={
                        record.captureIntegrity.captureToSignatureMs < 1000
                          ? `${record.captureIntegrity.captureToSignatureMs} ms`
                          : `${(record.captureIntegrity.captureToSignatureMs / 1000).toFixed(1)} s`
                      }
                      detail="How long the bytes sat unsigned after the shutter. A long gap is room for them to have been altered."
                    />
                  ) : null}
                  {record.captureIntegrity?.sensorTiming ? (
                    <NlRow
                      label="Sensor-frame timing"
                      value={`${record.captureIntegrity.sensorTiming.samples} samples · regularity ${record.captureIntegrity.sensorTiming.intervalCv}`}
                      detail="How evenly sensor frames arrived during capture. Real sensors jitter; synthetic feeds run too regular or too bursty."
                    />
                  ) : null}
                  {record.captureIntegrity?.biometricGatePassed === true ? (
                    <NlRow label="Face check" value="OS check passed at capture" />
                  ) : record.captureIntegrity?.biometricGatePassed === false ? (
                    <NlRow label="Face check" value="OS check ran and did not pass" />
                  ) : null}
                </View>
              ) : null}

              {/* Forensic Checks: sealed data juxtaposed with what should be
                  true. Each module measures on this device or fetches from a
                  stated source; none of them concludes. Lens, motion-trace
                  and environment checks read PICTURE evidence — they hide on
                  audio captures (0.18.3, Noah); the raw-audio master is the
                  one audio-applicable check and always renders. */}
              <View style={{ marginBottom: spacing.md }}>
                <Text style={nl.drawerHead}>Forensic Checks</Text>
                {entry.kind !== 'audio' ? (
                  <>
                    <MultipleLensCard
                      kind={entry.kind}
                      primaryUri={mediaUri}
                      secondaryFrame={secondary.frame}
                      primaryFrameTimeSeconds={secondary.ptsSeconds}
                      recordError={secondary.recordError}
                      videoFrames={secondary.videoFrames}
                    />
                    {entry.kind === 'video' ? (
                      // 0.18.6 (Noah: "we're not doing pose trace for video
                      // too!"): a video take has no shutter burst — its
                      // serial photography is the committed pair frames and
                      // its pose trace is the sealed sensor JSONL.
                      <VideoMotionCard
                        videoFrames={secondary.videoFrames}
                        sensorLogPath={record.context?.captureEvidence?.sensorLogPath}
                      />
                    ) : (
                      <MotionTraceCard
                        ringBufferDir={record.context?.captureEvidence?.ringBufferDir}
                        poseTrace={record.context?.poseTrace}
                        motion={record.context?.motion}
                      />
                    )}
                    <EnvironmentCard
                      lat={juxta?.lat ?? null}
                      lon={juxta?.lon ?? null}
                      atIso={record.capturedAt ?? null}
                      rollDeg={juxta?.rollDeg ?? null}
                      pitchDeg={juxta?.pitchDeg ?? null}
                      sealedWhenWhere={sealedWhenWhere}
                    />
                  </>
                ) : null}
                <RawAudioCard
                  kind={entry.kind}
                  rawPcmPath={record.context?.captureEvidence?.rawPcmPath}
                  enfAnchor={enfAnchor}
                />
              </View>

              {(() => {
              const ots: LadderInput['ots'] = !otsView
                ? 'none'
                : otsView.state === 'pending'
                  ? 'pending'
                  : otsView.state === 'invalid' || otsView.state === 'mismatch'
                    ? 'invalid'
                    : otsView.binding === 'verified'
                      ? 'confirmed-verified'
                      : 'confirmed-unchecked';
              // Honesty fix: tier 'this-device' is SELF-recognition — this
              // device recognizing its own key. That must not light the
              // identified rung ("Signer identified"): only an org credential
              // or a roster/trust-list vouch earns it. Fed to the ladder as
              // the unidentified floor with the local history stated.
              const selfRecognized = signerTrust.tier === 'this-device';
              const ladder = projectTrustLadder({
                manifestFound: report.checks.manifestFound,
                verdict: report.verdict,
                signatureValid: report.checks.signatureValid,
                fingerprintMatches: report.checks.fingerprintMatches,
                assetHashMatches: report.checks.assetHashMatches,
                bindingVoid: report.c2pa?.assetHashFailure === 'void-binding',
                tier: selfRecognized ? 'unknown' : signerTrust.tier,
                localHand: selfRecognized ? localHand : null,
                rosterState: signerTrust.tier === 'roster' && signerTrust.roster ? signerTrust.roster.state : null,
                rosterNewsroom: signerTrust.tier === 'roster' && signerTrust.roster ? signerTrust.roster.roster.newsroom : null,
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
                hardwareNotApplicable: record.deidentified
                  ? 'deidentified'
                  : record.assignment
                    ? 'assignment'
                    : null,
                timestamps: report.c2pa
                  ? { present: report.c2pa.timestamps.present, valid: report.c2pa.timestamps.valid, trusted: report.c2pa.timestamps.trusted, unchecked: report.c2pa.timestamps.unchecked ?? 0 }
                  : { present: 0, valid: 0, trusted: 0 },
                ots,
              });
              return ladder ? <TrustLadderCard ladder={ladder} /> : null;
              })()}
            </GroupCard>
          </View>
        ) : null}

        {legacyVideo ? (
          <View style={{ paddingHorizontal: spacing.md }}>
            <Text style={styles.sidecarHint}>
              This video was signed before credentials lived inside the file: share both the video
              and its attestation .json; the recipient verifies the pair together.
            </Text>
          </View>
        ) : null}

        {/* Advanced (Plan A): desk-grade surfaces — the media hash, the desk
            exports, the full check report, and the raw C2PA manifest. One
            collapsed group; a reader never has to see any of it. */}
        {record ? (
          <View style={{ paddingHorizontal: spacing.md }}>
            <GroupCard
              icon="cog-outline"
              title="Advanced"
              peek="Hashes, the full check report, the raw C2PA manifest."
              open={groupOpen.advanced}
              onToggle={() => setGroupOpen((g) => ({ ...g, advanced: !g.advanced }))}
            >
              <NlRow
                label="Media SHA-256"
                value={record.asset.sha256}
                mono
                detail="The exact bytes that were signed."
              />
              <View style={{ flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm, flexWrap: 'wrap' }}>
                <Button small icon="document-text-outline" label="Signed record (.json)" tone="secondary" onPress={() => void exportAttestation()} loading={busy === 'Exporting attestation…'} />
                <Button small icon="finger-print-outline" label="Hash-only claim" tone="secondary" onPress={() => void shareProofJson('hash-only')} loading={busy === 'Building proof…'} />
              </View>

              {/* The "Full report" drawer (AttestationView) was
                  removed — it re-rendered signature timing, sensor-frame
                  timing, the pose trace and the signer fingerprint, all of
                  which already live once in the Capture / Integrity groups
                  above (and again, by design, in the raw manifest reel
                  below). One fact, one place. */}

              {/* The raw C2PA manifest: shown OPEN at the bottom of Advanced
                  — the FULL manifest, windowed, never behind a drawer. Copy
                  is how the manifest leaves the phone; what you see is what
                  you copy (0.18.3, Noah: "it needs to be the FULL manifest"). */}
              {manifest ? <ManifestReel manifest={manifest} /> : null}
            </GroupCard>
          </View>
        ) : (
          <View style={{ paddingHorizontal: spacing.md }}>
            <Card>
              <Text style={styles.noRecord}>No attestation record found for this item.</Text>
            </Card>
          </View>
        )}
      </ScrollView>

      {/* The four export bundles: Basic (private — withheld
          fields stated inside the copy), Full (identifying, unchanged),
          Proof-Only (no media), Custom (per-field toggles, one screen down).
          The desk handoff, when configured, rides below the four — transport,
          not a bundle option. */}
      <ExportSheet
        visible={exportOpen}
        name={
          `${entry.kind === 'photo' ? 'photo' : entry.kind === 'video' ? 'video' : 'recording'} · ` +
          new Date(entry.createdAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
        }
        kind={entry.kind}
        pii={(() => {
          const p = detectPii(record, transcript);
          return {
            location: p.location,
            name: p.byline,
            sensors: p.sensors,
            transcript: p.transcript,
            wifi: p.wifi,
            org: p.org,
            face: p.face,
          };
        })()}
        deskNewsroom={deskTarget?.newsroom ?? null}
        onCancel={() => setExportOpen(false)}
        onBasic={(format) => {
          setExportOpen(false);
          if (entry.kind === 'photo') void shareDeidentifiedPhoto(format);
          else void shareDeidentifiedBmff();
        }}
        onFull={() => {
          setExportOpen(false);
          void shareAsIs();
        }}
        onProofOnly={() => {
          setExportOpen(false);
          void shareProofJson('proof-only');
        }}
        onCustom={() => {
          setExportOpen(false);
          router.push(`/disclosure/${entry.id}`);
        }}
        onDesk={deskTarget ? () => {
          setExportOpen(false);
          confirmSealForDesk();
        } : undefined}
      />
    </SafeAreaView>
  );
}

const buildStyles = () => StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderWidth: 1,
    borderRadius: radii.full,
    paddingHorizontal: 10,
    paddingVertical: 5,
    maxWidth: W * 0.6,
    flexShrink: 1,
  },
  pillText: { fontSize: fontSize.xs, fontWeight: '600', letterSpacing: 0.2, flexShrink: 1 },
  mediaWrap: { backgroundColor: HUD.ink },
  media: { width: W, height: W * 0.8 },
  videoSurface: { backgroundColor: '#000' },
  expandHint: {
    position: 'absolute',
    right: 10,
    bottom: 10,
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  mediaLoading: { alignItems: 'center', justifyContent: 'center' },
  audioCard: { backgroundColor: HUD.ink },
  audioHero: { height: 120, alignItems: 'center', justifyContent: 'center' },
  playerBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: HUD.ink,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
  },
  playerPlay: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: 'rgba(255,255,255,0.14)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  playerTime: {
    fontFamily: type.mono,
    fontSize: fontSize.xs,
    color: colors.onDark.faint,
    width: 38,
    textAlign: 'center',
  },
  playerTrackWrap: { flex: 1, height: 28, justifyContent: 'center' },
  playerTrack: { height: 3, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.22)' },
  playerTrackFill: { height: 3, borderRadius: 2, backgroundColor: colors.onDark.accent },
  playerThumb: {
    position: 'absolute',
    width: 12,
    height: 12,
    borderRadius: 6,
    marginLeft: -6,
    backgroundColor: '#fff',
  },
  transcriptWrap: { paddingHorizontal: spacing.md, marginTop: spacing.md },
  transcriptTitle: { fontSize: fontSize.xs, fontWeight: '700', letterSpacing: 1.6, color: colors.textFaint, marginBottom: spacing.sm },
  transcriptBody: { fontFamily: type.display, fontSize: fontSize.md, color: colors.text, lineHeight: 23 },
  transcriptNote: { color: colors.textFaint, fontSize: fontSize.xs, lineHeight: 17, marginTop: spacing.sm },
  transcriptActions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md },
  actions: {
    flexDirection: 'row',
    gap: spacing.sm,
    padding: spacing.md,
  },
  actionCell: { flex: 1 },
  noRecord: { color: colors.textDim, fontSize: fontSize.md },
  // Empty spacer holding the two-line rhythm the removed export-defaults
  // explainer occupied (same outer margins, 2 × 17px line height).
  sharePrivacySpacer: {
    height: 34,
    marginTop: -spacing.sm,
    marginBottom: spacing.md,
  },
  sidecarHint: {
    color: colors.textFaint,
    fontSize: fontSize.xs,
    lineHeight: 17,
    marginBottom: spacing.md,
  },
  codeBox: {
    // Mockup .hash: #101013 inset, radius 8, hairline border.
    backgroundColor: '#101013',
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    padding: spacing.sm + 2,
  },
  reelNote: {
    color: colors.textFaint,
    fontSize: fontSize.xs,
    lineHeight: 17,
    marginBottom: spacing.sm,
  },
  codeText: {
    fontFamily: type.mono,
    fontSize: 9.5,
    lineHeight: 16,
    color: '#A9A9B2',
    letterSpacing: 0.2,
  },
});

/** Nutrition-label rows — label left, value right, detail one sentence max. */
const buildNl = () => StyleSheet.create({
  title: {
    color: colors.textFaint,
    fontSize: fontSize.xs,
    fontWeight: '700',
    letterSpacing: 1.4,
    textTransform: 'uppercase',
    marginBottom: spacing.sm,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    paddingVertical: 7,
    gap: spacing.md,
  },
  label: { color: colors.textFaint, fontSize: fontSize.sm, width: 126, flexShrink: 0 },
  valueWrap: { flex: 1, alignItems: 'flex-end' },
  value: { color: colors.text, fontSize: fontSize.sm, textAlign: 'right' },
  detail: { color: colors.textFaint, fontSize: fontSize.xs, lineHeight: 16, marginTop: 2, textAlign: 'right' },
  mapsButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: radii.full,
    backgroundColor: colors.infoSoft,
  },
  mapsButtonText: { color: colors.info, fontSize: fontSize.xs, fontWeight: '600' },
  timeBlock: { paddingVertical: 7 },
  timeRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  timeText: { fontSize: fontSize.sm, lineHeight: 19, flex: 1 },
  drawerToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: spacing.sm,
    marginTop: spacing.xs,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  drawerToggleText: { color: colors.textDim, fontSize: fontSize.sm, fontWeight: '600' },
  // The drawer is not a separate card: same squircle, same background, the
  // chevron just unrolls more of it.
  drawer: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    paddingTop: spacing.sm,
  },
  drawerSection: { marginTop: spacing.md },
  // Mockup .sec h2: 10.5px / 800 / wide tracking / dim ink / uppercase.
  drawerHead: {
    color: colors.textFaint,
    fontSize: 10.5,
    fontWeight: '800',
    letterSpacing: 1.9,
    textTransform: 'uppercase',
    marginBottom: spacing.xs,
  },
});

/** Plan A group cards — paper surface, header row, peek, chevron body. */
const buildGrp = () => StyleSheet.create({
  card: {
    // Mockup .card: flat surface, 1px hairline border, radius 14.
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 14,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 4 },
  // The whole collapsed header block (title row + peek) is the tap target.
  headBlock: { marginHorizontal: -spacing.sm, paddingHorizontal: spacing.sm, paddingVertical: 2, borderRadius: 10 },
  title: { flex: 1, color: colors.text, fontSize: fontSize.md, fontWeight: '700' },
  peek: { color: colors.textDim, fontSize: fontSize.xs, lineHeight: 17, marginTop: 2 },
  body: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    marginTop: spacing.sm,
    paddingTop: spacing.sm,
  },
});

/** The one plain sentence — paper card, book weight, verdict colors only
 *  where a verdict was genuinely earned (green) or proven (red). */
const buildSumStyles = () => StyleSheet.create({
  card: {
    // Mockup .card: flat surface, 1px hairline border, radius 14.
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 14,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 4,
  },
  text: { color: colors.text, fontSize: fontSize.sm + 0.5, lineHeight: 21 },
  strong: { fontWeight: '700' },
  good: { color: colors.accent, fontWeight: '700' },
  bad: { color: colors.danger, fontWeight: '700' },
  dim: { color: colors.textDim },
});

// Source Kit 0.1.0 — media, live re-verification, sealed metadata, and actions
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
  TouchableOpacity,
  Linking,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Image } from 'expo-image';
import { useVideoPlayer, VideoView, type VideoPlayer } from 'expo-video';
import { useEvent } from 'expo';
import * as Sharing from 'expo-sharing';
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
import { GAP_DISCLAIMER } from '../../src/lib/copy';

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
import { verdictHeadline, type VerdictCode, type VerificationReport } from '../../archive/handrolled-verifier/verifyAsset';
import { verifyPhoto, verifyVideo, verifyWithSidecar } from '../../src/provenance/verifyFs';
import { resolveSignerTrust, type SignerTrust } from '../../src/lib/trustProvider';
import { manifestSecondaryFrames } from '../../src/components/forensic/manifestFrames';
import { SealStrip } from '../../src/components/detail/DetailKit';
import { DetailBody, deriveStrip } from '../../src/components/detail/DetailBody';
import { getSiteCredential } from '../../src/lib/siteCredential';
import { deriveSeal, deriveSignerIdentity, deriveTime, derivePlace, deriveEdits, type ReportView, type SignerView } from '../../src/components/detail/derive';
import { upgradePendingOts } from '../../src/provenance/otsQueue';
import { recordToSidecarJson, deidentifyPhoto, deidentifyPhotoToPng, deidentifyBmff } from '../../src/provenance/attest';
import { extractC2paStoreBmff } from '../../archive/handrolled-verifier/bmff';
import { extractC2paStore, parseManifest, type TranscriptAssertion, type C2paManifest } from '../../archive/handrolled-verifier/c2pa';
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
import { transcriptToSrt, transcriptToTxt } from '../../src/lib/transcript';
import { getDeviceKey } from '../../src/lib/deviceKey';
import { writeFileBytes, readFileBytes } from '../../src/lib/fileHash';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { useStore } from '../../src/store/useStore';

const W = Dimensions.get('window').width;

/**
 * HUD accents for this screen (0.18.2 — the landed palette of the app icon:
 * sage, cream, warm neutrals, muted clay). Identity/name and identifying
 * details share the muted warm clay, matching the camera HUD's signer and
 * location chips (app/(tabs)/index.tsx); the pure blue and pure yellow are
 * gone. Verdict semantics are unchanged: green is earned twice (INTACT and
 * a roster vouch), red is reserved for proven tamper, absence of proof is
 * neutral gray — never red, never alarming.
 */
const HUD = {
  identity: '#C08552',    // muted clay — the signer name
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


/**
 * The one plain sentence (Plan A). Compression, never omission: signer, date,
 * place, seal state, time anchor — with "reported by the phone" intact on
 * the location clause. Proven tamper turns the sentence red; absence of proof
 * stays neutral gray; nothing here ever says "authentic".
 * 0.23.0: the place NAME is gone — resolving it was a reverse-geocoding
 * network call to Apple (Noah: removed entirely). The sentence points at
 * the coordinates below instead.
 */
function SummaryLine({ record, report, signerTrust }: {
  record: AttestationRecord;
  report: VerificationReport | null;
  signerTrust: SignerTrust;
}) {
  const sumStyles = useThemedStyles(buildSumStyles);
  const identity = record.identity;
  const loc = record.context?.location;
  const ts = report?.c2pa?.timestamps ?? null;

  let signer: string;
  if (record.deidentified) signer = 'A de-identified copy, re-signed on this phone';
  else if (identity && identity !== 'redacted' && identity.author) signer = `Sealed by ${identity.author}`;
  // De-identified copies are caught above; identity 'redacted' HERE is an
  // anonymous-mode capture — nothing was redacted, no name was ever
  // attached. Say that, not the act.
  else if (identity === 'redacted') signer = 'Sealed anonymously';
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
          <Text>, at the coordinates below</Text>
        ) : null}
        <Text>. </Text>
        {bytesFailed ? (
          <Text style={sumStyles.bad}>The file no longer matches the seal. It was changed after signing. </Text>
        ) : bytesOk ? (
          <Text style={sumStyles.good}>The file still matches the seal</Text>
        ) : (
          <Text style={sumStyles.dim}>Checking the seal… </Text>
        )}
        {bytesOk && ts && ts.trusted > 0 ? <Text>, and the time was countersigned</Text> : null}
        {bytesOk && ts && ts.present > 0 && ts.trusted === 0 ? <Text>, and it carries a countersigned time from an authority this app does not recognize</Text> : null}
        {bytesOk && (!ts || ts.present === 0) ? <Text>, but nothing outside the file confirms the time, so the date is the phone’s own</Text> : null}
        {bytesOk ? <Text>. </Text> : null}
        {loc === 'redacted' ? (
          <Text style={sumStyles.dim}>Location was redacted by the signer.</Text>
        ) : loc === 'unavailable' ? (
          <Text style={sumStyles.dim}>Location was unavailable at capture.</Text>
        ) : loc && typeof loc === 'object' ? (
          <Text style={sumStyles.dim}>Location was reported by the phone.</Text>
        ) : null}
      </Text>
    </View>
  );
}

/** Device clock vs countersigned time: disagreement beyond this turns red. */
/** De-identified copies re-sign after the fact — a wider, stated tolerance. */

function fmtWhen(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}







/** Camera-settings labels: the signed key names, made readable. */


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
    // 0.18.5 post-field: every recorded pair frame — the filmstrip surface.
    const recordedPairs = (record.videoStereo?.pairs ?? []).filter(
      (p) => p.artifacts?.secondaryFrame?.state === 'recorded' && !!p.artifacts.secondaryFrame.dataBase64,
    );
    const videoFrames = recordedPairs.map((p) => {
      const f = p.artifacts.secondaryFrame;
      return {
        frame: { dataBase64: f.dataBase64!, mime: f.mime, sha256: f.sha256 },
        pairIndex: p.pairIndex,
        // 0.18.6 (Noah): the pair's own primary PTS anchor — a filmstrip
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
  // Plan A (0.14.0): the nutrition-label drawer is gone — three collapsible
  // groups carry the same facts (Capture open by default; Integrity and
  // Advanced collapsed behind a one-line peek each).
  // the reverse-geocoded place name is REMOVED — the
  // platform geocoder (CLGeocoder) sends the owner's coordinates to Apple.
  // The summary points at the coordinates instead.
  const [transcript, setTranscript] = useState<TranscriptAssertion | null>(null);
  // The parsed C2PA manifest: drives the transcript, the Camera Settings
  // rows, and the raw manifest shown open at the bottom of Advanced.
  const [manifest, setManifest] = useState<C2paManifest | null>(null);
  const [legacyVideo, setLegacyVideo] = useState(false);
  // The export sheet (0.15.0 Drop 2): one bottom sheet with the four bundle
  // options — Basic / Full / Proof-Only / Custom — replacing the old two-step
  // share menu + share sheet.
  const [exportOpen, setExportOpen] = useState(false);

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

  // Forensic Checks inputs, derived once from the sealed record.
  // The record's committed pairs first; the frames embedded in the file
  // when the record carries none. The same fallback Inspect uses, so an
  // exhibit never shows less of its own file than a stranger's copy would.
  const secondary = useMemo(() => {
    const fromRecord = record
      ? secondaryFrameFor(record)
      : { frame: null, ptsSeconds: null, recordError: null, videoFrames: null };
    if (fromRecord.frame || !manifest) return fromRecord;
    const embedded = manifestSecondaryFrames(manifest);
    if (embedded.length === 0) return fromRecord;
    return { frame: embedded[0].frame, ptsSeconds: null, recordError: null, videoFrames: embedded };
  },
    [record, manifest],
  );
  const enfAnchor = useMemo(() => (record ? readEnfAnchor(record) : null), [record]);
  // The sealed when/where, as one line for the environment modules —
  // coordinates only (0.23.0: no reverse geocoding — that was a network
  // call to Apple with the sealed coordinate).
  const sealedWhenWhere = useMemo(() => {
    if (!record) return '';
    const l = record.context?.location;
    const where =
      l && typeof l === 'object' ? `${l.lat.toFixed(4)}, ${l.lon.toFixed(4)}` : null;
    return [fmtWhen(record.capturedAt), where].filter(Boolean).join(' · ');
  }, [record]);
  const juxta = useMemo(
    () => (record ? juxtaInputs(record, sealedWhenWhere) : null),
    [record, sealedWhenWhere],
  );


  /**
   * A domain claim is shown only when this device can check it: a site
   * credential it holds, whose fingerprint is the one that signed this file.
   * A foreign file could name a domain, but confirming that needs a fetch to
   * a stranger's website, and a reader screen does not reach out over the
   * network to decide what a label says.
   */
  const [siteCred, setSiteCred] = useState<{ domain: string; fingerprint: string } | null>(null);
  useEffect(() => {
    let cancelled = false;
    void getSiteCredential().then((c) => {
      if (!cancelled) setSiteCred(c ? { domain: c.domain, fingerprint: c.fingerprint } : null);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);
  const siteForSigner =
    siteCred && record?.signer.fingerprint === siteCred.fingerprint ? { domain: siteCred.domain } : null;

  // The strip on the hero: the picture is this screen's, so the strip is too.
  const stripState = useMemo(() => {
    if (!record) return null;
    return deriveStrip({
      seal: deriveSeal(record, report as unknown as ReportView | null, signerTrust as unknown as SignerView),
      time: deriveTime(record, report as unknown as ReportView | null, otsView && otsView.state === 'confirmed' ? { state: 'confirmed', height: otsView.height } : otsView ? { state: otsView.state } : null),
      identity: deriveSignerIdentity(record, siteForSigner),
      foreign: null,
      edits: deriveEdits(manifest?.actions?.list),
    });
  }, [record, report, signerTrust, otsView, siteForSigner, manifest]);


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
        <TouchableOpacity
          onPress={() => router.back()}
          style={styles.backCtl}
          accessibilityRole="button"
          accessibilityLabel="Back to Exhibits"
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
        >
          <Ionicons name="chevron-back" size={18} color={colors.accent} />
          <Text style={styles.backLabel}>Exhibits</Text>
        </TouchableOpacity>
        {/* The corner status pill was removed (0.14.0): it duplicated the
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
                contentFit="cover"
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
          {stripState ? <SealStrip maker={stripState.maker} stamps={stripState.stamps} edge={entry.kind === 'photo' ? 'bottom' : 'top'} /> : null}
          {mediaUri && entry.kind === 'photo' ? (
            <Pressable style={styles.expandHint} onPress={() => void openViewer()} hitSlop={12} accessibilityLabel="View fullscreen">
              <Ionicons name="expand-outline" size={16} color="#fff" />
            </Pressable>
          ) : null}
        </View>

        {viewerOpen && mediaUri && entry.kind === 'photo' ? (
          <MediaViewer uri={mediaUri} kind={entry.kind} onClose={() => setViewerOpen(false)} />
        ) : null}

        {/* Plan A (0.14.0): one plain sentence up top — signer, when, where,
            seal state, time anchor. Compression, never omission. */}
        {record ? (
          <View style={{ paddingHorizontal: spacing.md, marginTop: spacing.md }}>
            <SummaryLine record={record} report={report} signerTrust={signerTrust} />
          </View>
        ) : null}

        {/* Share, Download, Delete — what to do with this copy: send it,
            keep it, destroy it. The row at the foot of the body is the
            evidence handoff (Export original, Export report, Verify
            elsewhere), and Export original opens this same sheet: one door,
            reachable from the top of the screen and from the end of the
            read, because those are two different moments. */}
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

        {/* 0.18.2: the export-defaults explainer was removed (stated in the
            export sheet itself). The spacer keeps the rhythm the copy
            occupied — two lines at fontSize.xs — so the layout doesn't
            collapse upward. */}
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

        {/* The detail body (0.25.0). One kit, two screens: Inspect and an
            exhibit describe a file in exactly the same words, because the
            words are decided once in src/components/detail. The three
            collapsible groups this replaces answered "what fields are
            there"; the sections answer "can I use this", which is the
            question a reader actually arrives with. */}
        {record ? (
          <DetailBody
            record={record}
            manifest={manifest}
            signerIdentity={deriveSignerIdentity(record, siteForSigner)}
            seal={deriveSeal(record, report as unknown as ReportView | null, signerTrust as unknown as SignerView)}
            time={deriveTime(record, report as unknown as ReportView | null, otsView && otsView.state === 'confirmed' ? { state: 'confirmed', height: otsView.height } : otsView ? { state: otsView.state } : null)}
            place={derivePlace(record)}
            kind={entry.kind}
            mediaUri={mediaUri}
            secondary={secondary.frame}
            secondaryPts={secondary.ptsSeconds}
            secondaryError={secondary.recordError}
            videoFrames={secondary.videoFrames}
            juxta={juxta}
            enfAnchor={enfAnchor}
            sealedWhenWhere={sealedWhenWhere}
            edits={deriveEdits(manifest?.actions?.list)}
            actions={[
              { label: 'Export original', icon: 'share-outline', onPress: shareMedia },
              { label: 'Export attestation', icon: 'document-text-outline', onPress: () => void exportAttestation() },
              { label: 'Verify elsewhere', icon: 'open-outline', onPress: () => void Linking.openURL('https://contentcredentials.org/verify') },
            ]}
          />
        ) : (
          <View style={{ paddingHorizontal: spacing.md }}>
            <Card>
              <Text style={styles.noRecord}>No attestation record found for this item.</Text>
            </Card>
          </View>
        )}
      </ScrollView>

      {/* The four export bundles (0.15.0 Drop 2): Basic (private — withheld
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
      />
    </SafeAreaView>
  );
}

const buildStyles = () => StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  backCtl: { flexDirection: 'row', alignItems: 'center', gap: 1, paddingVertical: spacing.xs, paddingRight: spacing.sm },
  backLabel: { color: colors.accent, fontSize: fontSize.md, fontWeight: '500' },
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
  // Two thirds of the screen, filled: a portrait frame no longer sits
  // between black bars. The full framing is one tap away in the viewer.
  media: { width: W, height: Math.round(Dimensions.get('window').height * 0.65) },
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

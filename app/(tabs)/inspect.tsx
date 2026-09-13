// Source Kit 0.1.0 — check a file against its seal
// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Inspect — check a file against its seal (0.18.2). The result is a
 * forensic reader, not a trophy case — and it mirrors the exhibit details
 * page 1:1 (Noah: "almost identical, especially the manifest points"):
 * the verdict card first, then ONE Capture claims card in the exhibit's
 * own format (When and where / Device / The seal / Sensors / Camera
 * settings — the old Manifest details drawer merged in, each fact exactly
 * once), then Capture integrity, the Forensic Checks modules (the same
 * shared cards the exhibit page renders), the sealing ladder, Signer and
 * Media. Declared edits and the raw manifest live one drawer down in Full
 * details.
 *
 * Copy v5 (binding): plain declarative facts. No persuasion, no
 * defensiveness, no "confirmed"/"checks out" — icons carry status,
 * words carry facts.
 *
 * All cryptography runs locally. Verdicts never overclaim: the strongest
 * thing we are entitled to say is "unchanged since sealing".
 */

import React, { useState, useEffect, useRef, useMemo } from 'react';
import { View, Text, StyleSheet, ScrollView, ActivityIndicator, Pressable, LayoutAnimation, Linking } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from 'expo-router';
import * as DocumentPicker from 'expo-document-picker';
import * as Sharing from 'expo-sharing';
import * as FileSystem from 'expo-file-system/legacy';
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
} from '../../archive/handrolled-verifier/verifyAsset';
import {
  HorizonLineOverlay,
  GravityPlumbOverlay,
  SunAzimuthOverlay,
  horizonTiltDeg,
  aimForFacing,
  juxtaInputs,
  compass8,
  declinationLine,
  sensorTimingVerdict,
  type JuxtaInputs,
} from '../../src/components/Juxtapose';
import { GAP_DISCLAIMER } from '../../src/lib/copy';

import { solarPosition } from '../../src/reader/verify/solar';
import { getDeviceKey } from '../../src/lib/deviceKey';
import { resolveSignerTrust, type SignerTrust, type TrustTier } from '../../src/lib/trustProvider';
import { listItems } from '../../src/vault/vaultFs';
import { payloadDigest } from '../../src/lib/sign';
import { bytesToHex, base64ToBytes, bytesToBase64 } from '../../src/lib/bytes';
import { verifyOtsReceipt } from '../../src/lib/ots';
import { fetchBlockHeader } from '../../src/lib/otsClient';
import { extractC2paStore, parseManifest, type C2paManifest, type EditAction, type IngredientInfo } from '../../archive/handrolled-verifier/c2pa';
import { extractC2paStoreBmff } from '../../archive/handrolled-verifier/bmff';
import { DetailBody, deriveStrip } from '../../src/components/detail/DetailBody';
import { SealStrip } from '../../src/components/detail/DetailKit';
import { readForeignManifest } from '../../src/reader/foreign';
import { manifestSecondaryFrames } from '../../src/components/forensic/manifestFrames';
import { getSiteCredential } from '../../src/lib/siteCredential';
import { deriveSeal, deriveSignerIdentity, deriveTime, derivePlace, deriveEdits, type ReportView, type SignerView } from '../../src/components/detail/derive';
import { readFileBytes, writeFileBytes } from '../../src/lib/fileHash';

// ---------------------------------------------------------------------------
// Verdict language — plain sentences, never overclaimed
// ---------------------------------------------------------------------------

function fmtWhen(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}





/**
 * The committed second-camera frame for the MultipleLensCard: the photo
 * stereo section's secondary frame, or the first recorded video pair's
 * frame with its PTS anchor. Hash-committed states are mirrored, never
 * recomputed — the card decodes the committed bytes. Same derivation the
 * exhibit page uses. NOTE (0.20.4): the frame rides the on-device vault
 * record / proof bundle — the SIGNED record strips the stereo sections by
 * design (their states/counts are bound by the signed context claims), so
 * an exported file carries the frame only as the manifest's committed
 * ingredient thumbnail; see manifestSecondaryFrames for that fallback.
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
 * tolerantly from the plausible homes and omit the row when absent. Same
 * reader the exhibit page uses.
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




// ---------------------------------------------------------------------------
// Standard C2PA edit history — humanized action names + icons
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// The label
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// The collapsible group card — identical pattern to the exhibit details
// page's Capture / Integrity / Advanced cards: icon, title, chevron, a
// one-line peek, and the WHOLE header block as the tap target.
// ---------------------------------------------------------------------------





// Signer identity resolves against anchors OUTSIDE the file, through the
// TrustProvider chain: this device → signed newsroom
// roster → org credential chain → honestly "unknown". Four trust tiers,
// four distinct display states — never collapsed into one badge. A curated
// C2PA trust list slots in above roster when one ships. The roster is
// editor-signed, revocable, and evaluated at the verified signing time.

type EditHistoryView = {
  generator: string | null;
  manifestCount: number;
  actions: { list: EditAction[]; referenced: boolean } | null;
  ingredients: (IngredientInfo & { referenced: boolean })[];
};


/**
 * The picked file, shown at the top of its own result: a photo
 * renders as the image; a video renders a still frame; an audio-only
 * container has no frame to show — an honest placeholder, never a broken
 * image. The picked URI is local already (document-picker cache copy).
 */
/** 0.18.6 (field: "videos are shown now but don't actually play back"):
 *  the Inspect preview was a still frame with no playback path. A tap on
 *  the still swaps in the real player (native controls — the OS's own
 *  fullscreen/rotate handling, same contract as the exhibit page's
 *  viewer). The forensic overlays annotate the STILL; playback replaces
 *  it, never draws over moving video. */
function InspectVideoPlayer({ uri, style }: { uri: string; style: object }) {
  const player = useVideoPlayer(uri, (p) => {
    p.loop = false;
    p.play();
  });
  return <VideoView player={player} style={style} contentFit="contain" nativeControls />;
}

function PickedMedia({ uri, name, kind, audioHint, overlay, onOverlay, juxta, fallbackUri, strip }: {
  uri: string;
  /** The seal strip, drawn on the frame's bottom edge. */
  strip?: React.ReactNode;
  name: string;
  kind: 'photo' | 'bmff';
  audioHint: boolean | null;
  overlay: string;
  onOverlay: (key: string) => void;
  juxta: JuxtaInputs | null;
  /** 0.18.6: the manifest's own embedded claim thumbnail, materialized to
      cache — the preview when this device can't extract a frame from the
      container. It is sealed content (referenced-gated), not a guess. */
  fallbackUri?: string | null;
}) {
  const styles = useThemedStyles(buildStyles);
  const [thumb, setThumb] = useState<string | null>(null);
  const [thumbFailed, setThumbFailed] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [playing, setPlaying] = useState(false);
  // 0.21.0: the displayed still's width/height ratio. The overlays'
  // % coordinates are only honest over the DISPLAYED image rectangle —
  // a fixed-height box with contentFit="contain" letterboxes the still,
  // which displaced every overlay horizontally on portrait photos (the
  // field's "sun ring bottom-left when the sun is center-right"). The
  // media box now takes the still's own aspect, and overlays wait for it.
  const [aspect, setAspect] = useState<number | null>(null);
  useEffect(() => { setAspect(null); }, [uri, kind]);
  const onStillLoad = (e: { source?: { width?: number; height?: number } }) => {
    const s = e.source;
    if (s && typeof s.width === 'number' && typeof s.height === 'number' && s.width > 0 && s.height > 0) {
      setAspect(s.width / s.height);
    }
  };
  useEffect(() => {
    if (kind !== 'bmff' || audioHint === true) return;
    let mounted = true;
    setThumb(null);
    setThumbFailed(false);
    setPlaying(false);
    // 0.18.6: try several offsets before declaring no frame — a fixed
    // 250 ms seek fails on very short takes and on containers this
    // device's AVFoundation seeks poorly in.
    (async () => {
      for (const time of [250, 0, 1000]) {
        try {
          const t = await VideoThumbnails.getThumbnailAsync(uri, { time });
          if (mounted) {
            setThumb(t.uri);
            // The thumbnail's own dims = the displayed still's aspect.
            if (t.width > 0 && t.height > 0) setAspect(t.width / t.height);
          }
          return;
        } catch { /* try the next offset */ }
      }
      if (mounted) setThumbFailed(true);
    })();
    return () => { mounted = false; };
  }, [uri, kind, audioHint]);

  const placeholderIcon =
    audioHint === true ? 'mic-outline' : audioHint === false ? 'videocam-outline' : 'document-outline';

  // The overlay dropdown: Clean is the default, always. Horizon and Gravity
  // need the sealed attitude; the Sun needs the sealed when/where (and its
  // on-photo arrow needs the sealed heading too — without one the text
  // badge alone renders, no invented arrow). An option whose inputs weren't
  // sealed simply doesn't appear.
  const options: { key: string; label: string }[] = [{ key: 'clean', label: 'Clean' }];
  if (juxta?.rollDeg != null && juxta?.pitchDeg != null) options.push({ key: 'horizon', label: 'Horizon' });
  if (juxta?.lat != null && juxta?.lon != null && juxta?.at) options.push({ key: 'sun', label: 'Sun position' });
  if (juxta?.rollDeg != null && juxta?.pitchDeg != null) options.push({ key: 'gravity', label: 'Gravity' });
  const active = options.find((o) => o.key === overlay) ?? options[0];
  // 0.21.0: no aspect → no overlays at all. A displaced ring is worse
  // than no ring (it reads as a measurement, so it must BE one).
  const showOverlays = !playing && aspect != null && (kind === 'photo' || (kind === 'bmff' && audioHint !== true && (!!thumb || (thumbFailed && !!fallbackUri))));
  // The media box takes the still's own aspect once known; until then the
  // legacy fixed-height box (no overlays ride it — see above).
  const mediaSize = aspect != null ? { aspectRatio: aspect } : { height: 260 };

  return (
    <Card style={styles.mediaCard}>
      <View style={styles.mediaFrame}>
        {kind === 'photo' ? (
          <Image source={{ uri }} style={[styles.mediaStill, mediaSize]} contentFit="contain" transition={100} onLoad={onStillLoad} />
        ) : audioHint === true ? (
          <View style={[styles.mediaStill, mediaSize, styles.mediaPlaceholder]}>
            <Ionicons name={placeholderIcon} size={30} color={colors.textFaint} />
            <Text style={styles.mediaPlaceholderText}>Audio file · no frame to show</Text>
          </View>
        ) : playing ? (
          <InspectVideoPlayer uri={uri} style={[styles.mediaStill, mediaSize]} />
        ) : thumbFailed && fallbackUri ? (
          <Pressable onPress={() => setPlaying(true)} accessibilityLabel="Play the video">
            <Image source={{ uri: fallbackUri }} style={[styles.mediaStill, mediaSize]} contentFit="contain" transition={100} onLoad={onStillLoad} />
            <View style={styles.playBadge} pointerEvents="none">
              <Ionicons name="play" size={26} color="#E8E8EC" />
            </View>
          </Pressable>
        ) : thumbFailed ? (
          // No still to show, but the file itself is right here — offer
          // playback directly, never a dead end.
          <Pressable
            style={[styles.mediaStill, mediaSize, styles.mediaPlaceholder]}
            onPress={() => setPlaying(true)}
            accessibilityLabel="Play the video"
          >
            <Ionicons name="play-circle-outline" size={34} color={colors.textFaint} />
            <Text style={styles.mediaPlaceholderText}>Tap to play</Text>
          </Pressable>
        ) : thumb ? (
          <Pressable onPress={() => setPlaying(true)} accessibilityLabel="Play the video">
            <Image source={{ uri: thumb }} style={[styles.mediaStill, mediaSize]} contentFit="contain" transition={100} />
            <View style={styles.playBadge} pointerEvents="none">
              <Ionicons name="play" size={26} color="#E8E8EC" />
            </View>
          </Pressable>
        ) : (
          <View style={[styles.mediaStill, mediaSize, styles.mediaPlaceholder]}>
            <ActivityIndicator color={colors.accent} />
          </View>
        )}
        {showOverlays && active.key === 'horizon' && juxta?.rollDeg != null && juxta?.pitchDeg != null ? (
          <HorizonLineOverlay rollDeg={juxta.rollDeg} pitchDeg={juxta.pitchDeg} facing={juxta.facing} hfovDeg={juxta.hfovDeg} aspect={aspect} />
        ) : null}
        {showOverlays && active.key === 'gravity' && juxta?.rollDeg != null && juxta?.pitchDeg != null ? (
          <>
            {/* The plumb line annotates the photo itself; the badge carries
                the numbers — the same sealed line the horizon card shows.
                0.20.5: the badge's aim goes through the same facing-aware
                helper as the overlay (front camera aims along device +Z). */}
            <GravityPlumbOverlay rollDeg={juxta.rollDeg} pitchDeg={juxta.pitchDeg} facing={juxta.facing} />
            <View style={styles.overlayBadge}>
              <Text style={styles.overlayBadgeText}>
                Tilt {Math.abs(horizonTiltDeg(juxta.rollDeg, juxta.pitchDeg)).toFixed(1)}° · aimed {aimForFacing(juxta.facing, juxta.rollDeg, juxta.pitchDeg) >= 0 ? 'down' : 'up'} {Math.abs(aimForFacing(juxta.facing, juxta.rollDeg, juxta.pitchDeg)).toFixed(1)}°
              </Text>
            </View>
          </>
        ) : null}
        {showOverlays && active.key === 'sun' && juxta?.lat != null && juxta?.lon != null && juxta?.at ? (
          juxta.headingDeg != null ? (
            // 0.21.0: the overlay already labels EVERY branch itself —
            // the extra SunBadge here stacked a second, redundant pill
            // over the ring's label (visible in the field screenshots).
            <SunAzimuthOverlay lat={juxta.lat} lon={juxta.lon} at={juxta.at} headingDeg={juxta.headingDeg} hfovDeg={juxta.hfovDeg} rollDeg={juxta.rollDeg} pitchDeg={juxta.pitchDeg} facing={juxta.facing} aspect={aspect} />
          ) : (
            <SunBadge lat={juxta.lat} lon={juxta.lon} at={juxta.at} />
          )
        ) : null}
        {strip}
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
  // Neutral "can't read this format" card — never an error state.
  const [note, setNote] = useState<string | null>(null);
  const [ownFingerprint, setOwnFingerprint] = useState<string | null>(null);
  const [identity, setIdentity] = useState<SignerTrust>({ tier: 'unknown' });
  // The file under inspection — shown at the top of the result.
  const [picked, setPicked] = useState<{ uri: string; name: string; kind: 'photo' | 'bmff'; audioHint: boolean | null } | null>(null);
  // The parsed manifest, feeding the Advanced group's raw-manifest reel
  // (the shared ManifestReel component — full, windowed).
  const [parsedManifest, setParsedManifest] = useState<C2paManifest | null>(null);
  // Standard C2PA edit history (c2pa.actions / ingredients) from the active
  // manifest — how a Canon→Photoshop file's edits surface here.
  const [editHistory, setEditHistory] = useState<{
    generator: string | null;
    manifestCount: number;
    actions: { list: EditAction[]; referenced: boolean } | null;
    ingredients: (IngredientInfo & { referenced: boolean })[];
  } | null>(null);
  // Camera settings (com.verify.exif) from the active manifest — the
  // "Camera settings" claims block.
  const [manifestExif, setManifestExif] = useState<{ referenced: boolean; data: Record<string, unknown> } | null>(null);
  // 0.23.0 (Noah): the reverse-geocoded Place row is REMOVED — the platform
  // geocoder (CLGeocoder) sends the sealed coordinates to Apple, a network
  // disclosure the reader never asked for. The coordinates themselves stay,
  // verbatim, on the Location row.
  // Local signer history (prior exhibits in THIS device's collection by
  // the same fingerprint) — computed for every tier so the sealing
  // ladder's rung 2 can state it for this-device signers too. Purely
  // local evidence, never vouching.
  const [localHand, setLocalHand] = useState<{ priorCaptures: number; firstSeen: string } | null>(null);
  // ── Reader inputs: the exact media bytes (kept in a ref — large videos
  //    must not cost a re-render), the rosters this device holds, and any
  //    Bitcoin block headers fetched for the ledger binding. ──
  const mediaBytesRef = useRef<Uint8Array | null>(null);
  const [blockHeaders, setBlockHeaders] = useState<Record<number, Uint8Array>>({});
  // Hero overlay: the "Clean ▾" dropdown — which juxtaposition layer, if
  // any, sits on the inspected media. Clean is the default, always.
  const [overlay, setOverlay] = useState<string>('clean');
  // #34: the empty state links to the field guide — an obvious entry point
  // that scrolls straight to it.
  const scrollRef = useRef<React.ComponentRef<typeof ScrollView>>(null);

  /**
   * Tapping Inspect while already on Inspect scrolls back to the top.
   * A verification report runs long, and the tab is the control a person
   * reaches for when they want to start over — every other iOS app answers
   * that gesture this way.
   */
  const navigation = useNavigation();
  useEffect(() => {
    const unsub = navigation.addListener('tabPress' as never, () => {
      scrollRef.current?.scrollTo({ y: 0, animated: true });
    });
    return unsub;
  }, [navigation]);

  useEffect(() => {
    getDeviceKey().then((k) => setOwnFingerprint(k.fingerprint)).catch(() => {});
  }, []);

  // Signer identity — resolved against anchors that live OUTSIDE the file,
  // through the TrustProvider chain (this device → roster → org chain).
  // Membership is evaluated at the VERIFIED signing time only — never the
  // phone's clock.
  const signerFp = report?.c2pa?.signerFingerprint ?? report?.record?.signer?.fingerprint ?? null;
  // Roster membership is evaluated at PINNED-authority time only — an
  // unpinned TSA's genTime is self-asserted and could backdate a capture
  // around a revocation.
  const verifiedAtMs = report?.c2pa?.timestamps.earliestTrustedUtc
    ? Date.parse(report.c2pa.timestamps.earliestTrustedUtc)
    : null;
  // The trust resolver handed INTO verification: the
  // trust axis is computed inside the data model and travels on the report —
  // scripting consumers of the same code path see the same amber. The
  // useEffect below is the fallback for reports without one.
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
    } catch { /* collection unavailable — no history to state */ }
    return resolveSignerTrust({ fingerprint, ownFingerprint, orgChain, atMs, localHistory });
  };

  useEffect(() => {
    let cancelled = false;
    if (!signerFp) { setIdentity({ tier: 'unknown' }); setLocalHand(null); return; }
    (async () => {
      // Local hand history ("Known hand"): count prior exhibits in
      // THIS device's collection sealed by the same fingerprint. Purely
      // local evidence — never vouching, never a tier promotion. A locked
      // or empty collection simply means no history to state. Computed
      // for EVERY tier: the sealing ladder states it on rung 2 for
      // this-device signers too.
      let localHistory: { priorCaptures: number; firstSeen: string } | null = null;
      try {
        const matches = (await listItems()).filter((i) => i.fingerprint === signerFp);
        if (matches.length > 0) {
          const firstSeen = matches.reduce((a, b) => (a.createdAt < b.createdAt ? a : b)).createdAt;
          localHistory = { priorCaptures: matches.length, firstSeen };
        }
      } catch { /* collection unavailable — no history to state */ }
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

  // Ledger time: OpenTimestamps receipts travel inside the record,
  // excluded from the signed payload because they upgrade AFTER signing —
  // each is verified against the record's payload digest instead. Display
  // stays strictly separate from the RFC 3161 authority time above: two
  // independent claims, never merged into one "time" line.
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
      // Offline we show the anchor with the binding honestly unchecked.
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

  // The sealed when/where, as one line for the juxtaposition cards.
  // 0.23.0: coordinates only — the reverse-geocoded place name is gone
  // (the platform geocoder is a network call to Apple).
  const sealedWhenWhere = useMemo(() => {
    if (!record) return '';
    const loc = record.context?.location;
    const where = loc && typeof loc === 'object'
      ? `${loc.lat.toFixed(4)}, ${loc.lon.toFixed(4)}`
      : null;
    return [fmtWhen(record.capturedAt), where].filter(Boolean).join(' · ');
  }, [record]);
  const juxta = useMemo<JuxtaInputs | null>(
    () => (record ? juxtaInputs(record, sealedWhenWhere) : null),
    [record, sealedWhenWhere],
  );
  // 0.23.0: "12.4°E sealed · 12.1°E expected · Δ 0.3°" — one computation,
  // guarded against an unparseable capturedAt (never an Invalid Date into
  // the WMM). Null when the record seals no declination.
  const declLine = useMemo(() => {
    if (!record?.context) return null;
    const ms = Date.parse(record.capturedAt);
    return declinationLine(record.context, Number.isFinite(ms) ? new Date(ms) : null);
  }, [record]);


  // ── Forensic Checks inputs, derived once from the dropped file's
  //    verification report. Where a check needs on-device capture context
  //    the file doesn't carry (burst frames, the raw audio master), the
  //    card's own neutral state says so — inputs are never fabricated. ──
  const secondary = useMemo(() => {
    const fromRecord = record
      ? secondaryFrameFor(record)
      : { frame: null, ptsSeconds: null, recordError: null, videoFrames: null };
    // 0.18.6: an exported file's embedded frames are the fallback when the
    // sealed record carries none (video pairs ride the proof bundle
    // on-device, but ARE embedded in the file — see manifestSecondaryFrames).
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

  // A file another signer sealed: no record, so the manifest itself is what
  // the detail sections read. Null whenever a record is present, so a
  // Source Kit file is never described from its manifest by mistake.
  const foreign = useMemo(
    () => (!record && parsedManifest ? readForeignManifest(parsedManifest) : null),
    [record, parsedManifest],
  );

  // 0.18.6: the manifest's embedded claim thumbnail, materialized once —
  // PickedMedia's preview when this device can't extract a frame from the
  // sealed container. Referenced-gated; absence stays absence.
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

  // The strip on the picture: computed here because the picture is this
  // screen's, not the body's.
  const stripState = useMemo(() => {
    if (!report) return null;
    const sealState = deriveSeal(record, report as unknown as ReportView | null, identity as unknown as SignerView, foreign);
    return deriveStrip({
      seal: sealState,
      time: deriveTime(record, report as unknown as ReportView | null, null, foreign),
      identity: deriveSignerIdentity(record, siteForSigner, foreign, report as unknown as ReportView | null),
      foreign,
      edits: deriveEdits(parsedManifest?.actions?.list),
    });
  }, [report, record, identity, foreign, siteForSigner, parsedManifest]);

  const forensicKind: 'photo' | 'video' | 'audio' =
    picked?.kind === 'photo' ? 'photo' : picked?.audioHint === true ? 'audio' : 'video';

  // The organization claim: the signed byline block first, then the org
  // credential mirror — self-asserted either way, and absent says nothing.
  const orgValue =
    (record && record.identity !== 'redacted' && record.identity.organization) ||
    record?.orgCredential?.issuer ||
    record?.orgCredential?.subject ||
    null;
  // The Time claims card renders when there is anything time-shaped to
  // show: a record (its device clock) or any countersignature/ledger state.

  // The Timestamp row mirrors the exhibit page's Timestamp row derivation
  // exactly: the countersigned anchor when a pinned authority countersigned,
  // else the device clock — same status strings, same disagreement rule.
  const tsInfo = report?.c2pa?.timestamps ?? null;
  const tsAnchorIso = tsInfo && tsInfo.trusted > 0
    ? tsInfo.earliestTrustedUtc
    : tsInfo && tsInfo.valid > 0
      ? tsInfo.earliestValidUtc
      : null;
  const tsGapMs =
    record && tsAnchorIso &&
    Number.isFinite(Date.parse(record.capturedAt)) && Number.isFinite(Date.parse(tsAnchorIso))
      ? Math.abs(Date.parse(record.capturedAt) - Date.parse(tsAnchorIso))
      : null;
  const tsDisagrees = !!(
    tsGapMs !== null &&
    // A de-identified copy is a legitimate RE-SIGN: the original device-clock
    // assertion is re-countersigned later, so its gap is allowed up to 15
    // minutes. Original seals stay strict at 5.
    tsGapMs > (record!.deidentified ? 15 : 5) * 60 * 1000
  );
  // 0.23.0 (handoff §03): the gap is in hand — show it, a fact not a flag.
  const tsGapMinutes = tsGapMs !== null ? Math.round(tsGapMs / 60000) : null;


  // Parse the manifest once: the edit history and camera-settings claims
  // derive from it, and the parsed object itself feeds the Advanced group's
  // raw-manifest reel (the shared ManifestReel — the FULL manifest, 0.18.3).
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
          // c2pa.created is the file's own CREATION declaration — C2PA
          // 2.1+ requires it, and Source's own manifests carry exactly
          // it and nothing else. Creation is not an edit, whoever wrote the
          // manifest, so it never raises the edits flag and never lists as
          // an edit. (The raw reel above still shows it — nothing is hidden.)
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
        /* a missing reel is a missing reel — the state stays null */
      }
    })();
    return () => { cancelled = true; };
  }, [report, picked]);

  /**
   * Omni import: one picker, any file. We use the document
   * picker — not the image picker — because verification needs the exact
   * original bytes (the image picker may re-encode, breaking signatures).
   * Routing is by SNIFFED type, never by the user's say-so: JPEG/PNG to the
   * photo verifier, MP4/MOV/M4A to the BMFF verifier, and honest neutral
   * "not supported yet" cards for HEIC, MP3/WAV, and unknown formats.
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
      setBusy('Reading the file…');
      const doc = await DocumentPicker.getDocumentAsync({ type: '*/*', copyToCacheDirectory: true });
      if (doc.canceled || !doc.assets[0]) return;
      const uri = doc.assets[0].uri;
      const sniffed = await sniffMediaType(uri);
      switch (sniffed) {
        case 'photo':
          setBusy('Checking the signature…');
          setPicked({ uri, name: doc.assets[0].name ?? 'Picked file', kind: 'photo', audioHint: false });
          {
            // The bytes are read ONCE here (verifyFs reads them internally
            // and discards them) so the Reader's custody rung can re-hash
            // the media for its byte-binding row without a second IO.
            const bytes = await readFileBytes(uri);
            mediaBytesRef.current = bytes;
            setReport(await verifyPhotoBytes(bytes, { trustResolver }));
          }
          break;
        case 'bmff': {
          setBusy('Checking the signature…');
          const bytes = await readFileBytes(uri);
          mediaBytesRef.current = bytes;
          const r = await verifyVideoBytes(bytes, { trustResolver });
          // Audio containers (M4A) get the honest placeholder, not a black
          // frame: the record's mime wins, the picker's mime is the fallback.
          const mime = r.record?.asset.mime ?? doc.assets[0].mimeType ?? null;
          setPicked({ uri, name: doc.assets[0].name ?? 'Picked file', kind: 'bmff', audioHint: mime ? mime.startsWith('audio/') : null });
          setReport(r);
          break;
        }
        case 'heic':
          // Neutral, never an error state: this build can't parse HEIC
          // credentials — absence of a verdict, honestly labeled.
          setNote(`This app cannot read the seals inside HEIC files yet. ${GAP_DISCLAIMER}`);
          break;
        case 'mp3':
        case 'wav':
          setNote(`This app cannot read the seals inside MP3 or WAV files yet. ${GAP_DISCLAIMER}`);
          break;
        default:
          setNote(`This app cannot read this format yet. ${GAP_DISCLAIMER}`);
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
        {/* 0.18.2: the beta tag belongs on the screen header (Noah) — the
            same ScreenTitle `tag` pill the Settings screen uses, verbatim. */}
        <ScreenTitle
          title="Inspect"
          tag="in beta"
          subtitle="Checked on this device. Nothing uploads."
        />

        <Card>
          {/* Local themed pill, not the shared Button: the shared primary
              tone pairs a `colors.text` fill with a hard-coded dark label —
              dark-on-dark in light mode (0.18.1 field report). The pill is
              the inverted-ink pair in BOTH schemes: dark pill / paper text
              in light, paper pill / dark text in dark. */}
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
            Chat apps and social media often strip seals. Request originals.
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
                strip={stripState ? <SealStrip maker={stripState.maker} stamps={stripState.stamps} edge={picked.kind === 'photo' ? 'bottom' : 'top'} /> : null}
              />
            ) : null}

            {/* The detail body (0.25.0) — the same sections an exhibit
                shows, from the same kit. A file dropped in here and a file
                sealed by this phone are described in identical words, which
                is the only way a reader can compare them. */}
            {/* The scroll container pads 16 for the rest of Inspect; the
                detail body brings its own gutter, so cancel one here or the
                sections sit narrower than the same sections on an exhibit. */}
            {/* A record or a manifest is enough. Any C2PA file gets the
                same sections; the derive functions read the manifest when
                there is no record to read. */}
            {record || parsedManifest ? (
              <View style={{ marginHorizontal: -spacing.md }}>
              <DetailBody
                record={record}
                manifest={parsedManifest}
                foreign={foreign}
                signerIdentity={deriveSignerIdentity(record, siteForSigner, foreign, report as unknown as ReportView | null)}
                seal={deriveSeal(record, report as unknown as ReportView | null, identity as unknown as SignerView, foreign)}
                time={deriveTime(record, report as unknown as ReportView | null, null, foreign)}
                place={derivePlace(record, foreign)}
                kind={forensicKind}
                mediaUri={picked?.uri ?? null}
                secondary={secondary.frame}
                secondaryPts={secondary.ptsSeconds}
                secondaryError={secondary.recordError}
                videoFrames={secondary.videoFrames}
                juxta={juxta}
                enfAnchor={enfAnchor}
                sealedWhenWhere={juxta?.sealedWhenWhere ?? ''}
                edits={deriveEdits(parsedManifest?.actions?.list)}
                actions={[
                  {
                    label: 'Export original',
                    icon: 'share-outline',
                    onPress: () => {
                      void (async () => {
                        if (picked && (await Sharing.isAvailableAsync())) await Sharing.shareAsync(picked.uri);
                      })();
                    },
                  },
                  {
                    label: 'Export attestation',
                    icon: 'document-text-outline',
                    onPress: () => {
                      void (async () => {
                        if (!picked) return;
                        const out = {
                          file: picked.name,
                          verdict: report.verdict,
                          sha256: record?.asset.sha256 ?? report.checks.recomputedSha256 ?? null,
                          signerFingerprint: signerFp,
                          capturedAt: record?.capturedAt ?? null,
                        };
                        const uri = `${FileSystem.cacheDirectory}inspection-report.json`;
                        await FileSystem.writeAsStringAsync(uri, JSON.stringify(out, null, 2));
                        if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(uri);
                      })();
                    },
                  },
                  {
                    label: 'Verify elsewhere',
                    icon: 'open-outline',
                    onPress: () => void Linking.openURL('https://contentcredentials.org/verify'),
                  },
                ]}
              />
              </View>
            ) : null}
          </View>
        ) : null}
        {/* The FAQ lives at the bottom of Inspect, below whatever is on
            screen — result or empty state alike. */}
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
  // The pill tab bar is absolutely positioned over this screen, so the
  // scroll has to end above it: the layout's own convention, inset + the
  // 64pt pill + breathing room. Without it the last line sits under the bar.
  scroll: { padding: spacing.md, paddingBottom: spacing.xxl + 64 + spacing.md },
  // Group cards — the same values as the exhibit details page's buildGrp:
  // flat surface, hairline border, the whole header block as the tap target.
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
  // The file-picker pill: inverted ink — legible in both schemes.
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
  // 0.21.0: height moved out — the caller sizes the box to the still's
  // own aspect once measured (mediaSize), legacy fixed 260 until then.
  mediaStill: { width: '100%', borderRadius: radii.md, backgroundColor: '#000' },
  mediaPlaceholder: { alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface2, gap: spacing.sm },
  mediaPlaceholderText: { color: colors.textFaint, fontSize: fontSize.xs },
  // 0.18.6: the tap-to-play badge over a video still (playback is a tap
  // away, never a dead still — the field report's "videos don't play").
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
  // 0.18.2 parity: these ARE the exhibit page's NlRow styles (buildNl) —
  // plain small label left, value right-aligned, 7px row rhythm.
  labelRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: spacing.md, paddingVertical: 7 },
  // 126: "Countersignatures" is the longest label we render; at 110 it
  // wrapped mid-word ("Countersignature s"). flexShrink: 0 keeps it intact.
  labelRowLabel: { color: colors.textFaint, fontSize: fontSize.sm, width: 126, flexShrink: 0 },
  labelRowValueWrap: { flex: 1, alignItems: 'flex-end' },
  labelRowValue: { color: colors.text, fontSize: fontSize.sm, textAlign: 'right' },
  labelRowDetail: { color: colors.textFaint, fontSize: fontSize.xs, lineHeight: 16, marginTop: 2, textAlign: 'right' },
  // The exhibit page's sub-head + section rhythm inside a group card
  // (buildNl drawerHead / drawerSection — same values).
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

  // --- the accordion body: sections of the ONE extended card, separated by
  //     hairlines — never detached squircles (0.15.0 Drop 2) ---
  detailBody: { marginTop: spacing.xs },
  detailSection: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    marginTop: spacing.md,
    paddingTop: spacing.md,
  },

  // --- forensic-detail card headers + the empty-state guide link ---
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
  fingerprintBox: {
    backgroundColor: colors.bg,
    borderRadius: radii.sm,
    padding: spacing.sm + 2,
    marginTop: spacing.md,
  },

  // --- "here's what the seal says" + the manifest drawers ---
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
  // A neutral fact line inside a claims card — absence said out loud, never
  // suspicion (body text: never below the muted token).
  claimAbsent: { color: colors.textDim, fontSize: fontSize.sm, lineHeight: 19, marginTop: spacing.xs },
  exportRow: { flexDirection: 'row', justifyContent: 'center', gap: spacing.lg, paddingVertical: spacing.sm },
  exportLink: { color: colors.accent, fontSize: fontSize.sm },
});

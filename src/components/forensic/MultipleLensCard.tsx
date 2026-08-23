// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * MultipleLensCard — the second camera's committed frame, next to the
 * primary view.
 *
 * What it does and does not do:
 *  - HIDDEN entirely for audio exhibits (the module does not apply).
 *  - No secondary capture → one neutral "Not recorded" line.
 *  - A committed secondary frame → an interactive overlay (primary view,
 *    secondary blended on top through a draggable opacity slider) and an
 *    on-device parallax measurement: both frames decoded small (96 px
 *    grayscale), a grid of patches NCC-matched within a horizontal window.
 *    The card reports ONLY the matched-patch count and the median
 *    horizontal disparity in pixels — no interpretation, no verdict.
 *  - Decode failure anywhere → "Parallax could not be computed on this
 *    device", neutral. Never red: absence and failure are not tamper.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, StyleSheet, PanResponder, ScrollView, Pressable } from 'react-native';
import { Image } from 'expo-image';
import { getThumbnailAsync } from 'expo-video-thumbnails';

import * as FileSystem from 'expo-file-system/legacy';

import { sha256 } from '@noble/hashes/sha256';

import { colors, spacing, fontSize, useThemedStyles } from '../../theme';
import { base64ToBytes, bytesToHex } from '../../lib/bytes';
import { writeFileBytes } from '../../lib/fileHash';
import { ForensicCard, NotRecorded } from './ForensicCard';
import { decodeBytesToGray, decodeUriToGray, measureParallax, type ParallaxResult } from './grayMatch';

/** A committed secondary frame (from record.stereo / record.videoStereo). */
export interface SecondaryFrameRef {
  /** The frame bytes, base64 (JPEG), as committed in the bundle section. */
  dataBase64: string;
  mime?: string;
  /** Committed SHA-256 (hex) of the frame bytes — shown, never recomputed here. */
  sha256?: string;
}

type ParallaxState =
  | { state: 'computing' }
  | { state: 'done'; result: ParallaxResult }
  | { state: 'unavailable' };

/** The primary view: the photo itself, or — for video — a thumbnail
    extracted at the pair's primary PTS anchor. (0.18.6 field fix: a
    paused VideoView sat at frame 0 and rendered BLACK for the whole
    blend box, so the slider blended the second camera against nothing.
    A thumbnail is also exactly what the parallax measurement below
    compares against — one frame, both uses.) */
function PrimaryView({ kind, uri, atSeconds, style }: {
  kind: 'photo' | 'video';
  uri: string;
  atSeconds?: number | null;
  style: object;
}) {
  if (kind === 'video') return <VideoPrimary uri={uri} atSeconds={atSeconds ?? 0} style={style} />;
  return <Image source={{ uri }} style={style} contentFit="cover" />;
}

function VideoPrimary({ uri, atSeconds, style }: { uri: string; atSeconds: number; style: object }) {
  const [thumbUri, setThumbUri] = useState<string | null>(null);
  const [exhausted, setExhausted] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setExhausted(false);
    // 0.18.8 field fix ("fades from the original view to a black box" on
    // exported videos): ONE seek attempt meant a single bad extract (t=0 on
    // a moov-last export, a slow content-uri read) left the whole blend box
    // on its near-black background. Walk the same fallback ladder the
    // parallax measurement already uses before declaring failure.
    const anchorMs = Math.max(0, Math.round(atSeconds * 1000));
    const attempts = [anchorMs, 0, 250, 1000].filter((v, i, a) => a.indexOf(v) === i);
    (async () => {
      for (const time of attempts) {
        try {
          const t = await getThumbnailAsync(uri, { time });
          if (!cancelled) setThumbUri(t.uri);
          return;
        } catch { /* try the next offset */ }
      }
      if (!cancelled) setExhausted(true);
    })();
    return () => { cancelled = true; };
  }, [uri, atSeconds]);
  if (!thumbUri) {
    // Total failure is stated, never a silent black box.
    return exhausted ? (
      <View style={[style, { alignItems: 'center', justifyContent: 'center' }]}>
        <Text style={{ color: colors.textFaint, fontSize: fontSize.xs, textAlign: 'center', paddingHorizontal: 16 }}>
          The primary frame could not be extracted from this file on this device.
        </Text>
      </View>
    ) : <View style={style} />;
  }
  return <Image source={{ uri: thumbUri }} style={style} contentFit="cover" />;
}

/** One committed video pair frame for the filmstrip. */
export interface VideoPairFrameRef {
  frame: SecondaryFrameRef;
  /** The capture-side pair sequence number — the label, never a time claim. */
  pairIndex: number;
  /** The pair's primary PTS anchor (s) when the record carries it — the
      moment the blend/parallax primary frame is pulled from when this
      pair is selected. Null → unknown, the first frame is used. */
  ptsSeconds?: number | null;
}

/** A video pair frame materialized to cache once (expo-image caches decodes
    by URI — the path keys on the committed sha256, same discipline as the
    compare view's frame). */
function FilmstripThumb({ frameRef, selected, onSelect }: {
  frameRef: VideoPairFrameRef;
  selected: boolean;
  onSelect: () => void;
}) {
  const styles = useThemedStyles(buildStyles);
  const [uri, setUri] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const key = (frameRef.frame.sha256?.slice(0, 16)
      ?? `${frameRef.frame.dataBase64.length}-${frameRef.frame.dataBase64.slice(0, 24)}`)
      .replace(/[^A-Za-z0-9-]/g, '');
    const path = `${FileSystem.cacheDirectory}forensic-video-pair-${key}.jpg`;
    writeFileBytes(path, base64ToBytes(frameRef.frame.dataBase64))
      .then(() => { if (!cancelled) setUri(path); })
      .catch(() => { if (!cancelled) setUri(null); });
    return () => { cancelled = true; };
  }, [frameRef]);
  return (
 // The strip frames are tappable — a tap swaps THAT
    // pair into the blend view + parallax above.
    <Pressable
      style={({ pressed }) => [styles.stripItem, pressed && { opacity: 0.7 }]}
      onPress={onSelect}
      accessibilityLabel={`Show pair ${frameRef.pairIndex} in the compare view`}
    >
      {uri ? (
        <Image source={{ uri }} style={[styles.stripImage, selected && styles.stripImageSelected]} contentFit="cover" />
      ) : (
        <View style={[styles.stripImage, selected && styles.stripImageSelected]} />
      )}
      <Text style={styles.stripLabel}>{`pair #${frameRef.pairIndex}`}</Text>
    </Pressable>
  );
}

export function MultipleLensCard({ kind, primaryUri, secondaryFrame, primaryFrameTimeSeconds, recordError, videoFrames }: {
  kind: 'photo' | 'video' | 'audio';
  /** The decrypted media URI — the primary view (photo or video). */
  primaryUri: string | null;
  /** The committed secondary frame, or null when none was committed. */
  secondaryFrame: SecondaryFrameRef | null;
  /** Video only: the pair's primary PTS anchor (s), so the parallax frame
      comes from the moment the pair was taken. Null → the first frame. */
  primaryFrameTimeSeconds?: number | null;
  /** The committed native error string when the sink was enabled but failed
      at capture — a failure, stated as one (never "Not recorded"). */
  recordError?: string | null;
 /** Video only: every committed pair frame — the
      second camera's view ACROSS the take, not only the compared moment. */
  videoFrames?: VideoPairFrameRef[] | null;
}) {
  const styles = useThemedStyles(buildStyles);
  // 0 = primary only, 1 = secondary fully blended over the primary.
  const [mix, setMix] = useState(0.5);
 // Which take pair the blend view shows. Null → the
  // card's own secondaryFrame (the first recorded pair). A filmstrip tap
  // swaps the pair in — frame AND its PTS anchor.
  const [activePair, setActivePair] = useState<number | null>(null);
  useEffect(() => { setActivePair(null); }, [secondaryFrame]);
  const activeRef = activePair != null
    ? (videoFrames ?? []).find((f) => f.pairIndex === activePair) ?? null
    : null;
  const shownFrame = activeRef?.frame ?? secondaryFrame;
  const shownPtsSeconds = (activeRef?.ptsSeconds ?? primaryFrameTimeSeconds) ?? null;
  const trackW = useRef(0);
  const mixRef = useRef(0.5);
  const [parallax, setParallax] = useState<ParallaxState>({ state: 'computing' });

  // expo-image does not reliably render data: URIs on every platform, so
  // the committed frame bytes are materialized to the (plain, shred-on-lock)
  // cache once and shown from there.
  const [secondaryUri, setSecondaryUri] = useState<string | null>(null);
  // A materialized frame that expo-image cannot DECODE rendered as
  // an opaque black layer over the primary — the field's "fades to a black
  // box". A decode failure is a fact about this device, stated in words,
  // never pixels.
  const [secondaryDecodeFailed, setSecondaryDecodeFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setSecondaryDecodeFailed(false);
    if (!shownFrame) {
      setSecondaryUri(null);
      return;
    }
    // The materialized path must be UNIQUE per
    // frame — expo-image caches decodes by URI, so a constant path showed
    // the FIRST exhibit's secondary frame on every later exhibit (the
    // bytes on disk were correct; the decode cache was not). Key the file
    // by the committed sha256; fall back to a cheap content fingerprint
    // when a legacy bundle lacks it.
    // 0.18.6 field fix (the Inspect second-view vanish): the fallback
    // fingerprint is raw base64 — a '/' in it made the cache path traverse
    // a nonexistent directory, the write failed, and the blend view
    // silently disappeared. Strip to a path-safe alphabet.
    // Exported-video frames carry no committed sha256, and the old
    // fallback fingerprint (length + first 24 base64 chars) was effectively
    // "length + the universal JFIF header" — every real JPEG shares those
    // 24 characters, so two same-length frames COLLIDED on one cache path
    // and expo-image's URI-keyed decode cache served the wrong (or a stale,
    // half-overwritten) image. Hash the decoded bytes: unique per frame,
    // stable across visits.
    const frameBytes = base64ToBytes(shownFrame.dataBase64);
    const frameKey = (shownFrame.sha256?.slice(0, 16) ?? bytesToHex(sha256(frameBytes)).slice(0, 16))
      .replace(/[^A-Za-z0-9-]/g, '');
    const path = `${FileSystem.cacheDirectory}forensic-secondary-view-${frameKey}.jpg`;
    writeFileBytes(path, frameBytes)
      .then(() => {
        if (!cancelled) setSecondaryUri(path);
      })
      .catch(() => {
        if (!cancelled) setSecondaryUri(null);
      });
    return () => {
      cancelled = true;
    };
  }, [shownFrame]);

  const slider = useMemo(
    () =>
      PanResponder.create({
        // 0.18.6 field fix, corrected: the drag-thief was the detail
        // screen's swipe-back gesture, now disabled on that screen — so
        // the wrap claims its touches directly again (tap sets the blend,
        // a drag follows the finger). The wrap is a dedicated 44 px
        // control row; page scroll starts above or below it.
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        // 0.18.1 field fix ("the compare slider doesn't work"): once a
        // horizontal drag IS claimed, never cede it to the enclosing
        // ScrollView mid-gesture — the default termination request lets a
        // parent scroller steal the responder, freezing the thumb.
        onPanResponderTerminationRequest: () => false,
        onShouldBlockNativeResponder: () => true,
        onPanResponderGrant: (e) => {
          const w = trackW.current;
          if (w > 0) {
            mixRef.current = Math.min(1, Math.max(0, e.nativeEvent.locationX / w));
            setMix(mixRef.current);
          }
        },
        onPanResponderMove: (e) => {
          const w = trackW.current;
          if (w > 0) {
            mixRef.current = Math.min(1, Math.max(0, e.nativeEvent.locationX / w));
            setMix(mixRef.current);
          }
        },
      }),
    [],
  );

  // The honest parallax measurement: both views decoded to the same 96×64
  // gray grid, a patch grid NCC-matched within a ±14 px horizontal window.
  // Numbers only — matched count and median disparity. Any failure along
  // the way lands in the neutral "could not be computed" state.
  useEffect(() => {
    let cancelled = false;
    if (!shownFrame || !primaryUri || kind === 'audio') return;
    setParallax({ state: 'computing' });
    (async () => {
      try {
        const secBytes = base64ToBytes(shownFrame.dataBase64);
        const secondary = await decodeBytesToGray(secBytes, 96, 64, 'forensic-secondary.jpg');
        let primarySource = primaryUri;
        if (kind === 'video') {
          // Try the pair's moment first, then fall back through
          // fixed offsets before declaring the measurement uncomputable —
          // one bad seek (e.g. t=0 on a moov-last file) must not kill it.
          const anchorMs = Math.max(0, Math.round((shownPtsSeconds ?? 0) * 1000));
          const attempts = [anchorMs, 0, 250, 1000].filter((v, i, a) => a.indexOf(v) === i);
          let thumbUri: string | null = null;
          for (const time of attempts) {
            try {
              thumbUri = (await getThumbnailAsync(primaryUri, { time })).uri;
              break;
            } catch { /* try the next offset */ }
          }
          if (!thumbUri) throw new Error('no frame could be extracted');
          primarySource = thumbUri;
        }
        const primary = await decodeUriToGray(primarySource, 96, 64);
        const result = measureParallax(primary, secondary);
        if (!cancelled) setParallax({ state: 'done', result });
      } catch {
        if (!cancelled) setParallax({ state: 'unavailable' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [shownFrame, primaryUri, kind, shownPtsSeconds]);

  // Audio exhibits: the module does not apply — the card hides entirely.
  if (kind === 'audio') return null;

  return (
    <ForensicCard title="Multiple Lenses" sub="Compares the committed second-camera frame with the primary view.">
      {!secondaryFrame && recordError ? (
        <Text style={styles.lead}>{`Enabled but failed at capture: ${recordError}`}</Text>
      ) : !secondaryFrame ? (
        <NotRecorded />
      ) : (
        <View>
          <Text style={styles.lead}>Two synchronized views of the same moment</Text>
          {secondaryDecodeFailed ? (
            <Text style={styles.parallaxText}>The committed second-camera frame is on the file, but this device could not decode it for display.</Text>
          ) : null}
          {primaryUri && secondaryUri && !secondaryDecodeFailed ? (
            <View>
              <View style={styles.compareBox}>
                {/* 0.18.6 (Noah): the primary frame follows the SELECTED
                    pair's anchor — tapping a strip frame re-seeks the
                    primary thumbnail to that pair's moment. */}
                <PrimaryView kind={kind} uri={primaryUri} atSeconds={shownPtsSeconds} style={StyleSheet.absoluteFill} />
                <View style={[StyleSheet.absoluteFill, { opacity: mix }]}>
                  <Image
                    source={{ uri: secondaryUri }}
                    style={StyleSheet.absoluteFill}
                    contentFit="cover"
                    onError={() => setSecondaryDecodeFailed(true)}
                  />
                </View>
                <View style={[styles.mixTag, { left: 8 }]}>
                  <Text style={styles.mixTagText}>Primary</Text>
                </View>
                <View style={[styles.mixTag, { right: 8 }]}>
                  <Text style={styles.mixTagText}>Second camera</Text>
                </View>
              </View>
              <View
                style={styles.sliderWrap}
                onLayout={(e) => {
                  trackW.current = e.nativeEvent.layout.width;
                }}
                {...slider.panHandlers}
                accessibilityLabel="Blend between primary and second camera"
              >
                {/* pointerEvents="none" on the children: the WRAP must stay
                    the touch target — a touch landing on the track/thumb
                    otherwise reports locationX relative to that child (the
                    thumb is 14 px wide) and the blend jumps to ~0 (0.18.1
                    field fix). */}
                <View style={styles.sliderTrack} pointerEvents="none">
                  <View style={[styles.sliderFill, { width: `${mix * 100}%` }]} />
                </View>
                <View style={[styles.sliderThumb, { left: `${mix * 100}%` }]} pointerEvents="none" />
              </View>
              <Text style={styles.sliderLab}>Drag to blend the second camera's frame over the primary view.</Text>
            </View>
          ) : null}

          <View style={styles.parallaxBlock}>
            {!primaryUri || parallax.state === 'unavailable' ? (
              <Text style={styles.parallaxText}>Parallax could not be computed on this device</Text>
            ) : parallax.state === 'computing' ? (
              <Text style={styles.parallaxText}>Computing parallax on this device…</Text>
            ) : (
              <View>
                <Text style={styles.parallaxText}>
                  {`${parallax.result.matched} of ${parallax.result.total} patches matched`}
                </Text>
                <Text style={styles.parallaxText}>
                  {`Median horizontal disparity: ${Math.round(parallax.result.medianDisparityPx * 10) / 10} px`}
                </Text>
                <Text style={styles.parallaxNote}>
                  {`Both views decoded at 96 px grayscale; a patch counts as matched at cross-correlation ≥ ${parallax.result.matchThreshold}. Numbers only.`}
                </Text>
              </View>
            )}
          </View>

          {/* 0.18.5 post-field: the whole take's second camera — every
              committed pair frame as a strip, labeled by its capture-side
              sequence number (never a time claim: the anchors are host
              clock, not take-relative). */}
          {kind === 'video' && videoFrames && videoFrames.length > 1 ? (
            <View style={styles.stripBlock}>
              <Text style={styles.stripHead}>
                {`${videoFrames.length} second-camera frames across the take`}
              </Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                {videoFrames.map((f) => (
                  <FilmstripThumb
                    key={f.pairIndex}
                    frameRef={f}
                    selected={(activePair ?? videoFrames[0]?.pairIndex) === f.pairIndex}
                    onSelect={() => setActivePair(f.pairIndex)}
                  />
                ))}
              </ScrollView>
            </View>
          ) : null}
        </View>
      )}
    </ForensicCard>
  );
}

const buildStyles = () => StyleSheet.create({
  lead: { color: colors.text, fontSize: fontSize.sm, fontWeight: '600', marginTop: spacing.sm },
  compareBox: {
    marginTop: spacing.sm,
    aspectRatio: 4 / 3,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: '#101013',
    overflow: 'hidden',
  },
  mixTag: {
    position: 'absolute',
    bottom: 6,
    backgroundColor: 'rgba(13,13,15,0.55)',
    borderRadius: 999,
    paddingHorizontal: 7,
    paddingVertical: 2,
  },
  mixTagText: { color: '#E8E8EC', fontSize: 9.5, fontWeight: '700' },
  sliderWrap: { height: 44, justifyContent: 'center', marginTop: spacing.xs },
  sliderTrack: { height: 3, borderRadius: 2, backgroundColor: colors.surface2 },
  sliderFill: { height: 3, borderRadius: 2, backgroundColor: colors.textDim },
  sliderThumb: {
    position: 'absolute',
    width: 18,
    height: 18,
    borderRadius: 9,
    marginLeft: -9,
    backgroundColor: colors.text,
  },
  sliderLab: { color: colors.textFaint, fontSize: 9.5, marginTop: 2 },
  parallaxBlock: { marginTop: spacing.sm, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border, paddingTop: spacing.sm },
  parallaxText: { color: colors.text, fontSize: fontSize.sm, lineHeight: 19 },
  parallaxNote: { color: colors.textFaint, fontSize: 9.5, lineHeight: 14, marginTop: spacing.xs },
  stripBlock: { marginTop: spacing.sm, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border, paddingTop: spacing.sm },
  stripHead: { color: colors.textDim, fontSize: fontSize.xs, fontWeight: '700', marginBottom: spacing.xs },
  stripItem: { width: 108, marginRight: spacing.xs },
  stripImage: {
    width: 108,
    height: 81,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: '#101013',
  },
 // The selected strip frame — an accent ring, nothing
  // more (selection is UI state, not a claim about the frame).
  stripImageSelected: { borderColor: colors.text, borderWidth: 2 },
  stripLabel: { color: colors.textFaint, fontSize: 9.5, marginTop: 2, textAlign: 'center' },
});

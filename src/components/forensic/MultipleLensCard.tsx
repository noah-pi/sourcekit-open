// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * MultipleLensCard — the second camera's committed frame, next to the primary
 * view.
 *  - Hidden entirely for audio exhibits.
 *  - No secondary capture: one neutral "Not recorded" line.
 *  - A committed secondary frame: an overlay (primary view with the secondary
 *    blended over it through a draggable opacity slider) plus an on-device
 *    parallax measurement — both frames decoded at 96 px grayscale, a patch
 *    grid NCC-matched within a horizontal window. Reports the matched-patch
 *    count and median horizontal disparity only.
 *  - Decode failure anywhere: neutral "Parallax could not be computed on this
 *    device". Never red; absence and failure are not tamper.
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

/** The primary view: the photo itself, or for video a thumbnail extracted at
    the pair's primary PTS anchor. A paused VideoView sits at frame 0 and
    renders black across the blend box, and the thumbnail is also what the
    parallax measurement compares against. */
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
    // Walk the same fallback ladder the parallax measurement uses before
    // declaring failure: a single bad extract (t=0 on a moov-last export, a
    // slow content-uri read) would otherwise leave the blend box black.
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
    // Total failure is stated in words rather than a black box.
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
  /** Capture-side pair sequence number; a label, not a time claim. */
  pairIndex: number;
  /** The pair's primary PTS anchor (s) when the record carries it: the moment
      the blend/parallax primary frame comes from while this pair is selected.
      Null uses the first frame. */
  ptsSeconds?: number | null;
}

/** A video pair frame materialized to cache once. expo-image caches decodes
    by URI, so the path keys on the committed sha256, as in the compare view. */
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
    // Strip frames are tappable: a tap swaps that pair into the blend view
    // and parallax above.
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
  /** Decrypted media URI for the primary view (photo or video). */
  primaryUri: string | null;
  /** The committed secondary frame, or null when none was committed. */
  secondaryFrame: SecondaryFrameRef | null;
  /** Video only: the pair's primary PTS anchor (s), so the parallax frame
      comes from the moment the pair was taken. Null uses the first frame. */
  primaryFrameTimeSeconds?: number | null;
  /** Committed native error string when the sink was enabled but failed at
      capture. Rendered as a failure, not as "Not recorded". */
  recordError?: string | null;
  /** Video only: every committed pair frame, the second camera's view across
      the take rather than the compared moment alone. */
  videoFrames?: VideoPairFrameRef[] | null;
}) {
  const styles = useThemedStyles(buildStyles);
  // 0 = primary only, 1 = secondary fully blended over the primary.
  const [mix, setMix] = useState(0.5);
  // Which take pair the blend view shows. Null uses the card's own
  // secondaryFrame (the first recorded pair); a filmstrip tap swaps in
  // another pair's frame and PTS anchor.
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
  // A materialized frame expo-image cannot decode renders as an opaque black
  // layer over the primary, so a decode failure is stated in words instead.
  const [secondaryDecodeFailed, setSecondaryDecodeFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setSecondaryDecodeFailed(false);
    if (!shownFrame) {
      setSecondaryUri(null);
      return;
    }
    // The materialized path must be unique per frame: expo-image caches
    // decodes by URI, so a shared path serves one exhibit's frame for every
    // other. Key the file by the committed sha256, and for frames without one
    // (exported video) by a hash of the decoded bytes — a fingerprint over the
    // leading base64 collides, since every JPEG shares the JFIF header. The
    // key is stripped to a path-safe alphabet; a '/' in it makes the write
    // traverse a nonexistent directory and fail.
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
        // The wrap claims its touches directly: tap sets the blend, drag
        // follows the finger. It is a dedicated 44 px control row, so page
        // scroll starts above or below it.
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        // Once a horizontal drag is claimed, do not cede it to the enclosing
        // ScrollView: the default termination request lets a parent scroller
        // steal the responder and freeze the thumb.
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

  // Parallax measurement: both views decoded to the same 96×64 gray grid, a
  // patch grid NCC-matched within a ±14 px horizontal window. Reports matched
  // count and median disparity; any failure lands in "could not be computed".
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
          // Try the pair's moment first, then fixed offsets, before calling
          // the measurement uncomputable; one bad seek (t=0 on a moov-last
          // file) should not end it.
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

  // Audio exhibits: the card is hidden.
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
                {/* The primary frame follows the selected pair's anchor:
                    tapping a strip frame re-seeks the primary thumbnail to
                    that pair's moment. */}
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
                {/* pointerEvents="none" on the children keeps the wrap as the
                    touch target: a touch landing on the track or the 14 px
                    thumb reports locationX relative to that child, sending the
                    blend to ~0. */}
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

          {/* The whole take's second camera — every
              committed pair frame as a strip, labeled by its capture-side
              sequence number (not a time claim: the anchors are host
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
  // Selected strip frame: an accent ring only. Selection is UI state, not a
  // claim about the frame.
  stripImageSelected: { borderColor: colors.text, borderWidth: 2 },
  stripLabel: { color: colors.textFaint, fontSize: 9.5, marginTop: 2, textAlign: 'center' },
});

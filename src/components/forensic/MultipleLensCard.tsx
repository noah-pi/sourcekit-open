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
import { View, Text, StyleSheet, PanResponder } from 'react-native';
import { Image } from 'expo-image';
import { useVideoPlayer, VideoView } from 'expo-video';
import { getThumbnailAsync } from 'expo-video-thumbnails';

import * as FileSystem from 'expo-file-system/legacy';

import { colors, spacing, fontSize, useThemedStyles } from '../../theme';
import { base64ToBytes } from '../../lib/bytes';
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

/** The primary view: the photo itself, or the paused video surface. */
function PrimaryView({ kind, uri, style }: { kind: 'photo' | 'video'; uri: string; style: object }) {
  if (kind === 'video') return <VideoPrimary uri={uri} style={style} />;
  return <Image source={{ uri }} style={style} contentFit="cover" />;
}

function VideoPrimary({ uri, style }: { uri: string; style: object }) {
  const player = useVideoPlayer(uri, (p) => {
    p.loop = false;
    p.muted = true;
  });
  return <VideoView player={player} style={style} contentFit="cover" nativeControls={false} />;
}

export function MultipleLensCard({ kind, primaryUri, secondaryFrame, primaryFrameTimeSeconds, recordError }: {
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
}) {
  const styles = useThemedStyles(buildStyles);
  // 0 = primary only, 1 = secondary fully blended over the primary.
  const [mix, setMix] = useState(0.5);
  const trackW = useRef(0);
  const mixRef = useRef(0.5);
  const [parallax, setParallax] = useState<ParallaxState>({ state: 'computing' });

  // expo-image does not reliably render data: URIs on every platform, so
  // the committed frame bytes are materialized to the (plain, shred-on-lock)
  // cache once and shown from there.
  const [secondaryUri, setSecondaryUri] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (!secondaryFrame) {
      setSecondaryUri(null);
      return;
    }
    // The materialized path must be UNIQUE per
    // frame — expo-image caches decodes by URI, so a constant path showed
    // the FIRST exhibit's secondary frame on every later exhibit (the
    // bytes on disk were correct; the decode cache was not). Key the file
    // by the committed sha256; fall back to a cheap content fingerprint
    // when a legacy bundle lacks it.
    const frameKey = secondaryFrame.sha256?.slice(0, 16)
      ?? `${secondaryFrame.dataBase64.length}-${secondaryFrame.dataBase64.slice(0, 24)}`;
    const path = `${FileSystem.cacheDirectory}forensic-secondary-view-${frameKey}.jpg`;
    writeFileBytes(path, base64ToBytes(secondaryFrame.dataBase64))
      .then(() => {
        if (!cancelled) setSecondaryUri(path);
      })
      .catch(() => {
        if (!cancelled) setSecondaryUri(null);
      });
    return () => {
      cancelled = true;
    };
  }, [secondaryFrame]);

  const slider = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        // Never cede
        // the drag to the enclosing ScrollView mid-gesture — the default
        // termination request lets a parent scroller steal the responder,
        // freezing the thumb.
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
    if (!secondaryFrame || !primaryUri || kind === 'audio') return;
    setParallax({ state: 'computing' });
    (async () => {
      try {
        const secBytes = base64ToBytes(secondaryFrame.dataBase64);
        const secondary = await decodeBytesToGray(secBytes, 96, 64, 'forensic-secondary.jpg');
        let primarySource = primaryUri;
        if (kind === 'video') {
          const thumb = await getThumbnailAsync(primaryUri, {
            time: Math.max(0, Math.round((primaryFrameTimeSeconds ?? 0) * 1000)),
          });
          primarySource = thumb.uri;
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
  }, [secondaryFrame, primaryUri, kind, primaryFrameTimeSeconds]);

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
          {primaryUri && secondaryUri ? (
            <View>
              <View style={styles.compareBox}>
                <PrimaryView kind={kind} uri={primaryUri} style={StyleSheet.absoluteFill} />
                <View style={[StyleSheet.absoluteFill, { opacity: mix }]}>
                  <Image source={{ uri: secondaryUri }} style={StyleSheet.absoluteFill} contentFit="cover" />
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
                {/* Children are pointerEvents="none" so the wrap stays the
                    touch target. A touch landing on the track or thumb would
                    report locationX relative to that child, and the 14 px
                    thumb would snap the blend to ~0. */}
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
                  {`Both views decoded at 96 px grayscale; a patch counts as matched at cross-correlation ≥ ${parallax.result.matchThreshold}. Numbers only; what they mean is for a person to weigh.`}
                </Text>
              </View>
            )}
          </View>
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
  sliderWrap: { height: 34, justifyContent: 'center', marginTop: spacing.xs },
  sliderTrack: { height: 3, borderRadius: 2, backgroundColor: colors.surface2 },
  sliderFill: { height: 3, borderRadius: 2, backgroundColor: colors.textDim },
  sliderThumb: {
    position: 'absolute',
    width: 14,
    height: 14,
    borderRadius: 7,
    marginLeft: -7,
    backgroundColor: colors.text,
  },
  sliderLab: { color: colors.textFaint, fontSize: 9.5, marginTop: 2 },
  parallaxBlock: { marginTop: spacing.sm, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border, paddingTop: spacing.sm },
  parallaxText: { color: colors.text, fontSize: fontSize.sm, lineHeight: 19 },
  parallaxNote: { color: colors.textFaint, fontSize: 9.5, lineHeight: 14, marginTop: spacing.xs },
});

// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * ManifestReel — the full C2PA manifest as parsed: every claim, assertion,
 * telemetry block, edit action and ingredient, uncapped.
 *
 * Two substitutions, both stated in the UI:
 *
 *   1. Binary blobs over 64 bytes (thumbnails, depth maps, signatures) show
 *      as a labelled byte count; megabytes of base64 lay out as a blank box.
 *      Byte strings ≤64 bytes (hashes) render as base64 in full.
 *
 *   2. The JSON is split into lines and rendered through a FlatList, since a
 *      single <Text> cannot lay out a video manifest's telemetry. Every line
 *      is in the list, and copy puts the unmodified text on the clipboard.
 *
 * Used by the exhibit details page and the Inspect screen (Advanced group).
 */

import React, { useMemo } from 'react';
import { View, Text, StyleSheet, Pressable, Alert, FlatList } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';

import { colors, spacing, fontSize, radii, type, useThemedStyles } from '../theme';
import { bytesToBase64 } from '../lib/bytes';
import type { C2paManifest } from '../c2pa/c2pa';

/** Display projection: the union of the fields both screens show. */
function projectManifest(m: C2paManifest): Record<string, unknown> {
  return {
    manifestLabel: m.manifestLabel,
    manifestCount: m.manifestCount,
    certChainLength: m.certChainLength,
    claimGenerator: m.claimGenerator,
    claim: m.claim,
    referencedAssertionLabels: m.referencedAssertionLabels,
    telemetry: m.telemetry,
    exif: m.exif ? { referenced: m.exif.referenced, data: m.exif.data } : null,
    identity: m.identity,
    transcript: m.transcript,
    actions: m.actions,
    ingredients: m.ingredients,
    customAssertions: Object.fromEntries(
      Object.entries(m.customAssertions).map(([label, a]) => [label, { referenced: a.referenced, data: a.data }]),
    ),
  };
}

/** Full-fidelity JSON: no string, array, depth, or character caps. The one
 *  substitution is large binary blobs, replaced by a labelled byte count.
 *  Returns whether that fired so the view can say so. */
function manifestToText(m: C2paManifest): { text: string; binaryCounted: boolean } {
  let binaryCounted = false;
  const walk = (v: unknown): unknown => {
    if (v instanceof Uint8Array) {
      if (v.length <= 64) return `base64:${bytesToBase64(v)}`;
      binaryCounted = true;
      return `[binary: ${v.length.toLocaleString('en-US')} bytes]`;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x)]));
    }
    return v;
  };
  return { text: JSON.stringify(walk(projectManifest(m)), null, 2), binaryCounted };
}

const LINE_HEIGHT = 17;

export function ManifestReel({ manifest }: { manifest: C2paManifest }) {
  const styles = useThemedStyles(buildStyles);
  const reel = useMemo(() => {
    try {
      const { text, binaryCounted } = manifestToText(manifest);
      return { text, binaryCounted, lines: text.split('\n') };
    } catch {
      return null;
    }
  }, [manifest]);

  if (!reel) return null;

  return (
    <View style={{ marginTop: spacing.md }}>
      <View style={styles.headRow}>
        <Text style={styles.head}>Raw C2PA manifest</Text>
        <View style={{ flex: 1 }} />
        <Pressable
          hitSlop={8}
          accessibilityLabel="Copy raw manifest"
          onPress={() => {
            void Clipboard.setStringAsync(reel.text);
            void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
            Alert.alert('Copied', 'The raw C2PA manifest is on your clipboard.');
          }}
        >
          <Ionicons name="copy-outline" size={15} color={colors.accent} />
        </Pressable>
      </View>
      {reel.binaryCounted ? (
        <Text style={styles.note}>
          Embedded binary fields (thumbnails, signatures) are shown as byte counts — the complete bytes export
          with the proof bundle.
        </Text>
      ) : null}
      <View style={styles.codeBox}>
        <FlatList
          data={reel.lines}
          keyExtractor={(_, i) => String(i)}
          renderItem={({ item }) => <Text style={styles.codeLine}>{item === '' ? ' ' : item}</Text>}
          getItemLayout={(_, index) => ({ length: LINE_HEIGHT, offset: LINE_HEIGHT * index, index })}
          initialNumToRender={40}
          maxToRenderPerBatch={80}
          windowSize={9}
          showsVerticalScrollIndicator
          nestedScrollEnabled
        />
      </View>
    </View>
  );
}

const buildStyles = () =>
  StyleSheet.create({
    headRow: { flexDirection: 'row', alignItems: 'center' },
    head: { color: colors.textDim, fontSize: fontSize.xs, fontWeight: '700', letterSpacing: 0.4, textTransform: 'uppercase' },
    note: { color: colors.textFaint, fontSize: fontSize.xs, lineHeight: 17, marginTop: 4 },
    codeBox: {
      backgroundColor: colors.bg,
      borderRadius: radii.sm,
      padding: spacing.sm + 2,
      marginTop: spacing.sm,
      height: 320,
    },
    codeLine: { fontFamily: type.mono, color: colors.textDim, fontSize: fontSize.xs, lineHeight: LINE_HEIGHT },
  });

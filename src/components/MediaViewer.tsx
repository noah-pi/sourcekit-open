// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Fullscreen media viewer.
 *
 * Opened deliberately (the expand badge on the asset page), dismissed three
 * ways so nobody can ever get trapped: the close button (its own top layer,
 * above the media), a tap on the black backdrop for photos, and the system
 * back gesture. Video uses the native player controls, which include the
 * system fullscreen/rotate handling.
 */

import React from 'react';
import { Modal, View, StyleSheet, Pressable, StatusBar } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Image } from 'expo-image';
import { useVideoPlayer, VideoView } from 'expo-video';
import { Ionicons } from '@expo/vector-icons';

function FullscreenVideo({ uri }: { uri: string }) {
  const player = useVideoPlayer(uri, (p) => {
    p.loop = false;
    p.play();
  });
  return <VideoView player={player} style={styles.fill} contentFit="contain" nativeControls />;
}

export function MediaViewer({ uri, kind, onClose }: { uri: string; kind: 'photo' | 'video'; onClose: () => void }) {
  const insets = useSafeAreaInsets();
  return (
    <Modal visible animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <View style={styles.backdrop}>
        <StatusBar hidden />
        {kind === 'photo' ? (
          // The whole surface dismisses — the single most forgiving exit.
          <Pressable style={styles.fill} onPress={onClose} accessibilityLabel="Close viewer">
            <Image source={{ uri }} style={styles.fill} contentFit="contain" transition={80} pointerEvents="none" />
          </Pressable>
        ) : (
          <FullscreenVideo uri={uri} />
        )}
        {/* Close control lives in its own layer, above the media, always tappable. */}
        <View style={[styles.closeWrap, { top: insets.top + 8 }]} pointerEvents="box-none">
          <Pressable style={styles.close} onPress={onClose} hitSlop={20} accessibilityLabel="Close viewer">
            <Ionicons name="close" size={22} color="#fff" />
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: '#000' },
  fill: { flex: 1 },
  closeWrap: {
    position: 'absolute',
    right: 12,
    alignItems: 'flex-end',
    zIndex: 10,
    elevation: 10,
  },
  close: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: 'rgba(60,60,60,0.75)',
    alignItems: 'center',
    justifyContent: 'center',
  },
});

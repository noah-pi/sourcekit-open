// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Set / change passcode: enter 6 digits → confirm → saved.
 * Query param: mode=set (default). Change = remove + set, handled by Settings.
 */

import React, { useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { colors, spacing, radii, fontSize, useThemedStyles, useEffectiveScheme } from '../src/theme';
import { useStore } from '../src/store/useStore';
import { setupPasscode } from '../src/vault/passcode';
import { upgradeVaultKeyAcl } from '../src/vault/vaultFs';

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', 'del'];

export default function SetPasscodeScreen() {
  const styles = useThemedStyles(buildStyles);
  const router = useRouter();
  const { setPasscodeSet, setUnlocked } = useStore();
  const [stage, setStage] = useState<'enter' | 'confirm'>('enter');
  const [first, setFirst] = useState('');
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);

  const press = async (k: string) => {
    setError(null);
    if (k === 'del') return setPin((p) => p.slice(0, -1));
    if (!k || pin.length >= 6) return;
    const next = pin + k;
    setPin(next);
    if (next.length < 6) return;

    if (stage === 'enter') {
      setFirst(next);
      setPin('');
      setStage('confirm');
      return;
    }
    if (next !== first) {
      setError("Passcodes didn't match. Start over");
      setPin('');
      setFirst('');
      setStage('enter');
      return;
    }
    await setupPasscode(next);
    setPasscodeSet(true);
    upgradeVaultKeyAcl().catch(() => {});
    setUnlocked(true);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    router.back();
  };

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={12}>
          <Ionicons name="close" size={26} color={colors.textDim} />
        </TouchableOpacity>
      </View>
      <View style={styles.center}>
        <Text style={styles.title}>{stage === 'enter' ? 'Choose a passcode' : 'Confirm passcode'}</Text>
        <Text style={styles.sub}>
          {error ?? 'Six digits. It locks the app; the vault itself is encrypted separately.'}
        </Text>
        <View style={styles.dots}>
          {Array.from({ length: 6 }).map((_, i) => (
            <View key={i} style={[styles.dot, pin.length > i && styles.dotFilled]} />
          ))}
        </View>
        <View style={styles.pad}>
          {KEYS.map((k, i) =>
            k === '' ? (
              <View key={i} style={styles.key} />
            ) : (
              <TouchableOpacity key={i} style={styles.key} onPress={() => press(k)} activeOpacity={0.6}>
                {k === 'del' ? (
                  <Ionicons name="backspace-outline" size={24} color={colors.textDim} />
                ) : (
                  <Text style={styles.keyText}>{k}</Text>
                )}
              </TouchableOpacity>
            )
          )}
        </View>
      </View>
    </SafeAreaView>
  );
}

const buildStyles = () => StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  header: { padding: spacing.md, alignItems: 'flex-end' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.xl, paddingBottom: spacing.xxl },
  title: { color: colors.text, fontSize: fontSize.xl, fontWeight: '700' },
  sub: { color: colors.textDim, fontSize: fontSize.sm, marginTop: spacing.sm, textAlign: 'center', lineHeight: 19, minHeight: 38 },
  dots: { flexDirection: 'row', gap: 14, marginVertical: spacing.xl },
  dot: { width: 12, height: 12, borderRadius: 6, borderWidth: 1.5, borderColor: colors.border },
  dotFilled: { backgroundColor: colors.accent, borderColor: colors.accent },
  pad: { flexDirection: 'row', flexWrap: 'wrap', width: 280, justifyContent: 'center' },
  key: { width: 280 / 3 - 10, height: 68, alignItems: 'center', justifyContent: 'center', margin: 5, borderRadius: radii.md },
  keyText: { color: colors.text, fontSize: 26, fontWeight: '500' },
});

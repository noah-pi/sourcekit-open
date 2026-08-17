// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Lock screen: Face ID (if enabled) and/or 6-digit passcode.
 */

import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Vibration } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as LocalAuthentication from 'expo-local-authentication';
import * as Haptics from 'expo-haptics';
import { colors, spacing, radii, fontSize, useThemedStyles, useEffectiveScheme } from '../src/theme';
import { useStore } from '../src/store/useStore';
import { verifyPasscode } from '../src/vault/passcode';
import { upgradeVaultKeyAcl } from '../src/vault/vaultFs';
import {
  getLockoutState,
  recordFailure,
  resetLockout,
  lockedSecondsRemaining,
} from '../src/lib/pinLockout';

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', 'del'];

export default function LockScreen() {
  const styles = useThemedStyles(buildStyles);
  const router = useRouter();
  const { settings, setUnlocked } = useStore();
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  // Lockout: timestamp until which the keypad is locked; countdown
  // ticks once a second while active. Persisted in SecureStore, so restarting
  // the app does not clear it.
  const [lockUntilMs, setLockUntilMs] = useState(0);
  const [lockSecondsLeft, setLockSecondsLeft] = useState(0);
  const isLocked = lockSecondsLeft > 0;

  const unlock = () => {
    // The user just authenticated — move the vault key behind the OS
    // keychain's user-presence access control while that presence is fresh.
    upgradeVaultKeyAcl().catch(() => {});
    setUnlocked(true);
    router.replace('/');
  };

  const tryBiometrics = async () => {
    try {
      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: 'Unlock Source Kit',
        cancelLabel: 'Use passcode',
        disableDeviceFallback: true,
      });
      if (result.success) unlock();
    } catch {
      // User can fall back to the keypad.
    }
  };

  useEffect(() => {
    if (settings.biometricsEnabled) tryBiometrics();
    // Restore a lockout that was in progress when the app was last closed.
    getLockoutState().then((s) => {
      if (s.untilMs > Date.now()) setLockUntilMs(s.untilMs);
    });
  }, []);

  useEffect(() => {
    if (!lockUntilMs) {
      setLockSecondsLeft(0);
      return;
    }
    const tick = () => {
      const left = lockedSecondsRemaining(lockUntilMs);
      setLockSecondsLeft(left);
      if (left === 0) {
        setLockUntilMs(0);
        setPin('');
      }
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [lockUntilMs]);

  const press = async (k: string) => {
    if (isLocked) return;
    setError(null);
    if (k === 'del') {
      setPin((p) => p.slice(0, -1));
      return;
    }
    if (!k || pin.length >= 6) return;
    const next = pin + k;
    setPin(next);
    if (next.length === 6) {
      setChecking(true);
      const ok = await verifyPasscode(next);
      setChecking(false);
      if (ok) {
        await resetLockout();
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        unlock();
      } else {
        Vibration.vibrate([0, 60, 80, 60]);
        const { attempts, lockedForMs } = await recordFailure();
        if (lockedForMs > 0) {
          setLockUntilMs(Date.now() + lockedForMs);
          setError(null); // countdown line below takes over
        } else {
          const triesLeft = 5 - attempts;
          setError(`Incorrect passcode · ${triesLeft} ${triesLeft === 1 ? 'try' : 'tries'} before lockout`);
        }
        setPin('');
      }
    }
  };

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.center}>
        <View style={styles.mark}>
          <Ionicons name="pricetag-outline" size={30} color={colors.accent} />
        </View>
        <Text style={styles.title}>Locked.</Text>
        <Text style={styles.subtitle}>Work already in progress finishes in the background.</Text>
        <Text style={styles.error}>
          {isLocked ? `Too many attempts. Try again in ${lockSecondsLeft}s` : (error ?? ' ')}
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
              <TouchableOpacity
                key={i}
                style={styles.key}
                onPress={() => press(k)}
                disabled={checking || isLocked}
                activeOpacity={0.6}
              >
                {k === 'del' ? (
                  <Ionicons name="backspace-outline" size={24} color={colors.textDim} />
                ) : (
                  <Text style={styles.keyText}>{k}</Text>
                )}
              </TouchableOpacity>
            )
          )}
        </View>

        {settings.biometricsEnabled ? (
          <TouchableOpacity onPress={tryBiometrics} style={styles.bioButton}>
            <Ionicons name="scan-outline" size={18} color={colors.accent} />
            <Text style={styles.bioText}>Unlock with Face ID</Text>
          </TouchableOpacity>
        ) : null}
      </View>
    </SafeAreaView>
  );
}

const buildStyles = () => StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.xl },
  mark: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.lg,
  },
  title: { color: colors.text, fontSize: fontSize.xl, fontWeight: '700' },
  subtitle: { color: colors.textDim, fontSize: fontSize.sm, marginTop: spacing.sm, textAlign: 'center' },
  error: { color: colors.danger, fontSize: fontSize.sm, marginTop: spacing.sm, height: 20 },
  dots: { flexDirection: 'row', gap: 14, marginVertical: spacing.xl },
  dot: { width: 12, height: 12, borderRadius: 6, borderWidth: 1.5, borderColor: colors.border },
  dotFilled: { backgroundColor: colors.accent, borderColor: colors.accent },
  pad: { flexDirection: 'row', flexWrap: 'wrap', width: 280, justifyContent: 'center' },
  key: { width: 280 / 3 - 10, height: 68, alignItems: 'center', justifyContent: 'center', margin: 5, borderRadius: radii.md },
  keyText: { color: colors.text, fontSize: 26, fontWeight: '500' },
  bioButton: { flexDirection: 'row', alignItems: 'center', gap: 7, marginTop: spacing.xl, padding: spacing.sm },
  bioText: { color: colors.accent, fontSize: fontSize.md, fontWeight: '600' },
});

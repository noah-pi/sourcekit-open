// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Root layout: bootstrap, gating, and the lock lifecycle.
 *
 * Gate order: loading → onboarding → lock (if passcode set) → tabs.
 * Going to background locks the app (when a passcode is set) and shreds the
 * decrypted-media cache.
 */

import React, { useEffect, useState } from 'react';
import { View, AppState } from 'react-native';
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { useStore } from '../src/store/useStore';
import { hasPasscode } from '../src/vault/passcode';
import { ensureVaultDirs, wipePlainCache, releaseVaultKeyIfIdle } from '../src/vault/vaultFs';
import { startBarometerFeed } from '../src/sensors/context';
import { getDeviceKey } from '../src/lib/deviceKey';
import { ensureAttestation } from '../src/lib/appAttest';
import { drainOtsQueue } from '../src/provenance/otsQueue';
import { refreshBeacon, nextRefreshDelayMs, setBeaconEndpoint } from '../src/lib/beacon';
import { colors, useEffectiveScheme } from '../src/theme';

export default function RootLayout() {
  const { settingsLoaded, onboarded, unlocked, passcodeSet, loadSettings, setPasscodeSet, setUnlocked } =
    useStore();
  // Effective color scheme ('device' → OS, or the pinned override). A flip
  // re-renders here and the keyed provider below remounts the navigator, so
  // mounted screens re-read the mutated `colors` object; react-navigation
  // would otherwise memoize screen content past the parent re-render. The
  // remount resets navigation state to the initial tab.
  const scheme = useEffectiveScheme();
  const [ready, setReady] = useState(false);
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    (async () => {
      await loadSettings();
      const pc = await hasPasscode();
      setPasscodeSet(pc);
      setUnlocked(!pc);
      await ensureVaultDirs();
      // Cold start: shred any decrypted media left over from a previous session.
      await wipePlainCache();
      startBarometerFeed();
      // Generate (or load) the device identity at launch so first capture is instant.
      getDeviceKey().catch(() => {});
      // Hardware attestation: ensured at every launch with a local
      // challenge, no registry contact, retried while absent. Does not block
      // startup.
      void getDeviceKey()
        .then(() => ensureAttestation())
        .catch(() => {});
      // Ledger anchoring: digests queued while offline submit now; the
      // queue delay is recorded in each record.
      void drainOtsQueue(useStore.getState().settings.otsCalendars ?? undefined).catch(() => {});
      setBeaconEndpoint(useStore.getState().settings.beaconEndpoint);
      setReady(true);
    })();
  }, []);

  // Bitcoin beacon refresh: jittered schedule, not a per-capture fetch, so
  // network traffic cannot be correlated with captures. Seals read the cache.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    const tick = () => {
      void refreshBeacon()
        .catch(() => {})
        .finally(() => {
          if (!stopped) timer = setTimeout(tick, nextRefreshDelayMs());
        });
    };
    tick();
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') void refreshBeacon().catch(() => {});
    });
    const unsubSettings = useStore.subscribe((s) => {
      setBeaconEndpoint(s.settings.beaconEndpoint);
    });
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      sub.remove();
      unsubSettings();
    };
  }, []);

  // No dead-man's switch: no scheduler and no vault upload path exist.

  // Background → shred plaintext cache + lock.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      // 'background' only: share sheets, Face ID prompts, and permission
      // dialogs surface as 'inactive', and locking on those would interrupt
      // the user mid-action.
      if (state === 'background') {
        wipePlainCache();
        // Drop the cached vault key, unless a seal is mid-write: then the
        // key survives until that write finishes.
        releaseVaultKeyIfIdle();
        if (useStore.getState().passcodeSet) setUnlocked(false);
        // No seal-queue wipe: drafts are vault-sealed at capture, so
        // nothing plaintext rests in the queue.
      }
    });
    return () => sub.remove();
  }, []);

  // Gate navigation.
  useEffect(() => {
    if (!ready || !settingsLoaded) return;
    const inOnboarding = segments[0] === 'onboarding';
    const inLock = segments[0] === 'lock';
    const inSetPasscode = segments[0] === 'set-passcode';

    if (!onboarded) {
      if (!inOnboarding) router.replace('/onboarding');
      return;
    }
    // An onboarded user can reopen /onboarding (the HUD lock badge replays
    // the tour) and that screen exits itself via router.back(). This gate
    // must not bounce them to '/': the replace races the push and crashes.
    if (passcodeSet && !unlocked && !inLock && !inSetPasscode) {
      router.replace('/lock');
    }
  }, [ready, settingsLoaded, onboarded, unlocked, passcodeSet, segments]);

  if (!ready || !settingsLoaded) {
    // Inline, not a module StyleSheet, so the boot screen reads the
    // effective scheme at render: an override lands during loadSettings,
    // after module styles were captured.
    return <View style={{ flex: 1, backgroundColor: colors.bg }} />;
  }

  return (
    <SafeAreaProvider key={scheme}>
      {/* Status-bar ink follows the effective scheme, not the OS alone. */}
      <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: colors.bg },
          animation: 'fade',
        }}
      >
        <Stack.Screen name="onboarding" />
        <Stack.Screen name="lock" />
        <Stack.Screen name="set-passcode" options={{ animation: 'slide_from_bottom' }} />
        <Stack.Screen name="(tabs)" />
        {/* Swipe-back off: the screen-edge gesture steals horizontal drags
            from the compare sliders. The Exhibits back button is the way
            out. */}
        <Stack.Screen name="asset/[id]" options={{ animation: 'slide_from_right', gestureEnabled: false }} />
      </Stack>
    </SafeAreaProvider>
  );
}

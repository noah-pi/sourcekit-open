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
  // re-renders here; the keyed provider below remounts the navigator so
  // mounted screens re-read the mutated `colors` object (react-navigation
  // memoizes screen content against parent re-renders otherwise). Cost of
  // the remount: navigation state resets to the initial tab — accepted for
  // a deliberate, rare switch, and the same rebuild the camera tab already
  // asks users to do by hand for its own switches.
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
 // Hardware attestation is set-and-forget: ensured silently at
      // every launch — local challenge, no registry contact, retried while
      // absent, never blocks startup. After the enclave key exists the first
      // run typically completes before the first capture.
      void getDeviceKey()
        .then(() => ensureAttestation())
        .catch(() => {});
      // Ledger anchoring: digests that couldn't reach the free
      // OpenTimestamps calendars while offline submit now; the recorded
      // queue delay becomes part of each record's evidence.
      void drainOtsQueue(useStore.getState().settings.otsCalendars ?? undefined).catch(() => {});
      setBeaconEndpoint(useStore.getState().settings.beaconEndpoint);
      setReady(true);
    })();
  }, []);

  // Bitcoin beacon refresh: jittered schedule DECOUPLED from
  // shutter events — never a per-capture fetch, so an observer cannot
  // correlate network traffic with captures. Seals read whatever is cached.
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

  // There is deliberately no dead-man's switch: an automatic upload of the
  // entire vault would be the largest blast radius in the app. No scheduler,
  // no upload path, nothing to fire.

  // Background → shred plaintext cache + lock.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      // 'background' only: share sheets, Face ID prompts, and permission
      // dialogs surface as 'inactive' — locking then would kick users out
      // mid-action.
      if (state === 'background') {
        wipePlainCache();
        // Drop the cached vault key too — unless a seal is mid-write, in
        // which case the key survives until that work finishes (the lock
        // screen says exactly this; never a silent abort).
        releaseVaultKeyIfIdle();
        if (useStore.getState().passcodeSet) setUnlocked(false);
        // No seal-queue wipe here: drafts are vault-sealed at
        // capture, so nothing plaintext rests in the queue — locking loses
        // no captures and leaves nothing readable behind.
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
    // NOTE: an ONBOARDED user may open /onboarding deliberately — the HUD
    // lock badge replays the tour, and the screen handles its own exit
    // (X-out / Done → router.back()). This gate must NOT bounce them back
    // to '/': the replace raced the push and crashed the app (TestFlight
    // 0.13.0 report, 2026-08-10).
    if (passcodeSet && !unlocked && !inLock && !inSetPasscode) {
      router.replace('/lock');
    }
  }, [ready, settingsLoaded, onboarded, unlocked, passcodeSet, segments]);

  if (!ready || !settingsLoaded) {
    // Inline, not a module StyleSheet: read at render so the boot screen
    // already matches the effective scheme (an override lands during
    // loadSettings, after module styles were captured).
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
        {/* 0.18.6 field fix: the screen-edge swipe-back gesture was
            stealing horizontal drags from the compare sliders on this
            screen ("dragging horizontally closed the detail view"). The
            Exhibits back button stays the way out. */}
        <Stack.Screen name="asset/[id]" options={{ animation: 'slide_from_right', gestureEnabled: false }} />
      </Stack>
    </SafeAreaProvider>
  );
}

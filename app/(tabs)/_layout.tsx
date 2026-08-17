// Written with AI assistance. Verification: docs/PROVENANCE.md.
import React, { useEffect, useState } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { Tabs } from 'expo-router';
// Local structural type for the custom tab bar. expo-router supplies the
// bottom-tabs navigator at runtime; we must not hard-import its package
// (absent from package.json — an EAS `npm ci` would fail to resolve it).
interface PillTabBarProps {
  state: { index: number; routes: { key: string; name: string }[] };
  descriptors: Record<string, { options: Record<string, unknown> } | undefined>;
  navigation: {
    navigate: (name: string) => void;
    emit: (e: { type: 'tabPress'; target: string; canPreventDefault: true }) => { defaultPrevented: boolean };
  };
}
import { Ionicons } from '@expo/vector-icons';
import { BlurView } from 'expo-blur';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, useEffectiveScheme } from '../../src/theme';
import { subscribeSealJobs } from '../../src/provenance/sealQueue';
import { subscribeVaultNotices } from '../../src/vault/vaultFs';

// Mockup (.pillbar / app-0.17.0.html): a floating translucent pill, 64pt tall,
// radius 32, hairline border, blurred backdrop, active tab wrapped in a soft
// green pill. The bar overlays content rather than pushing it up.
// 0.18.1 contrast fix: the mockup's #7ED6A4 active green fails WCAG on the
// light-mode bar (≈1.6:1 on white). Dark mode keeps it; light mode uses the
// theme accent (#1F6B45, 5.6:1 on white) with accentSoft as the pill wash.
const ACTIVE_GREEN_DARK = '#7ED6A4'; // mockup --ok-bright
const ACTIVE_BG_DARK = 'rgba(126,214,164,0.13)';

const TAB_ICONS: Record<string, keyof typeof Ionicons.glyphMap> = {
  index: 'radio-button-on-outline',
  exhibits: 'albums-outline',
  inspect: 'locate-outline',
  settings: 'menu-outline',
};

/** 0.18.2: BETA moved off the tab labels onto the screen headers (Noah). */

function PillTabBar({ state, descriptors, navigation }: PillTabBarProps) {
  const scheme = useEffectiveScheme();
  const insets = useSafeAreaInsets();
  const [failedSeals, setFailedSeals] = useState(0);
  useEffect(
    () => subscribeSealJobs((jobs) => setFailedSeals(jobs.filter((j) => j.state === 'failed').length)),
    [],
  );
  // Contrast-safe active treatment, per scheme (see the constants above).
  const activeTint = scheme === 'dark' ? ACTIVE_GREEN_DARK : colors.accent;
  const activeBg = scheme === 'dark' ? ACTIVE_BG_DARK : colors.accentSoft;

  return (
    <View pointerEvents="box-none" style={[styles.dock, { bottom: Math.max(insets.bottom, 12) }]}>
      <BlurView
        intensity={32}
        tint={scheme === 'dark' ? 'dark' : 'light'}
        style={[
          styles.pill,
          {
            borderColor: colors.border,
            backgroundColor: scheme === 'dark' ? 'rgba(21,21,25,0.72)' : 'rgba(255,255,255,0.78)',
          },
        ]}
      >
        {state.routes.map((route, index) => {
          const focused = state.index === index;
          const options = descriptors[route.key]?.options;
          const label = (options?.title as string) ?? route.name;
          const icon = TAB_ICONS[route.name] ?? 'ellipse-outline';
          const tint = focused ? activeTint : colors.textFaint;
          const onPress = () => {
            const event = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
            if (!focused && !event.defaultPrevented) navigation.navigate(route.name);
          };
          return (
            <Pressable
              key={route.key}
              accessibilityRole="button"
              accessibilityState={focused ? { selected: true } : {}}
              accessibilityLabel={label}
              onPress={onPress}
              style={styles.tab}
            >
              <View style={[styles.tabInner, focused && { backgroundColor: activeBg }]}>
                <View>
                  <Ionicons name={icon} size={19} color={tint} />
                  {route.name === 'exhibits' && failedSeals > 0 ? (
                    <View style={styles.badge}>
                      <Text style={styles.badgeText}>{failedSeals > 9 ? '9+' : failedSeals}</Text>
                    </View>
                  ) : null}
                </View>
                <Text style={[styles.tabLabel, { color: tint }]}>{label}</Text>
              </View>
            </Pressable>
          );
        })}
      </BlurView>
    </View>
  );
}

const styles = StyleSheet.create({
  dock: {
    position: 'absolute',
    left: 14,
    right: 14,
  },
  pill: {
    height: 64,
    borderRadius: 32,
    borderWidth: 1,
    overflow: 'hidden',
    flexDirection: 'row',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.45,
    shadowRadius: 28,
    shadowOffset: { width: 0, height: 8 },
    elevation: 12,
  },
  tab: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  tabInner: {
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 24,
    paddingHorizontal: 14,
    paddingVertical: 6,
    gap: 2,
  },
  tabLabel: { fontSize: 9.5, fontWeight: '600', letterSpacing: 0.2 },
  badge: {
    position: 'absolute',
    top: -6,
    right: -12,
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    paddingHorizontal: 4,
    backgroundColor: '#C08552', // warm clay — 0.18.1 palette (no pure yellow)
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: { color: '#141414', fontSize: 9, fontWeight: '800' },
  // Vault-notice banner — floats above the pill bar, same register (surface,
  // hairline, soft shadow). Colors inline so a scheme flip re-tints it.
  noticeWrap: {
    position: 'absolute',
    left: 14,
    right: 14,
    alignItems: 'center',
  },
  notice: {
    borderRadius: 20,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 8,
    shadowColor: '#000',
    shadowOpacity: 0.18,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  noticeText: { fontSize: 12, fontWeight: '600', letterSpacing: 0.1 },
});

export default function TabsLayout() {
  useEffectiveScheme(); // re-read the palette on flip — tab chrome follows the scheme
  const insets = useSafeAreaInsets();
  // Brief vault notices (0.18.2: "Collection index repaired…") — a quiet
  // banner above the pill bar, auto-dismissing. This layout is always
  // mounted, so the notice surfaces whichever tab triggered the read.
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsub = subscribeVaultNotices((message) => {
      setNotice(message);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => setNotice(null), 4000);
    });
    return () => {
      unsub();
      if (timer) clearTimeout(timer);
    };
  }, []);
  return (
    <View style={{ flex: 1 }}>
      <Tabs
        tabBar={(props) => <PillTabBar {...props} />}
        screenOptions={{ headerShown: false }}
      >
        <Tabs.Screen name="index" options={{ title: 'Capture' }} />
        <Tabs.Screen name="exhibits" options={{ title: 'Exhibits' }} />
        <Tabs.Screen name="inspect" options={{ title: 'Inspect' }} />
        <Tabs.Screen name="settings" options={{ title: 'Settings' }} />
      </Tabs>
      {notice ? (
        <View
          pointerEvents="none"
          style={[styles.noticeWrap, { bottom: Math.max(insets.bottom, 12) + 64 + 10 }]}
        >
          <View style={[styles.notice, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <Text style={[styles.noticeText, { color: colors.text }]}>{notice}</Text>
          </View>
        </View>
      ) : null}
    </View>
  );
}

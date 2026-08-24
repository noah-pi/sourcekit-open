// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Onboarding: a wordmark opening page, then three panels, said plainly.
 *
 * The arc is the honesty rules in miniature: (1) the problem — fakes are
 * free and perfect now, and eyes can't settle it; (2) what this camera
 * does — seals each shot at the shutter, taught by the self-playing
 * seal-break demo; (3) the limit — the camera commits, it never
 * concludes. Every claim here is literally true: we say the seal covers
 * the bytes, never that it proves a scene was real.
 *
 * The mechanics that worked are unchanged: real swipe paging, back, skip
 * on every screen, and first-launch gating via the store (replays from
 * the camera HUD get an X-out instead). The beta line on panel 3 is
 * protected copy — keep it verbatim.
 */

import React, { useRef, useState } from 'react';
import {
  View,
  Text,
  Image,
  StyleSheet,
  ScrollView,
  Dimensions,
  TouchableOpacity,
  NativeSyntheticEvent,
  NativeScrollEvent,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { colors, spacing, radii, fontSize, type, useThemedStyles } from '../src/theme';
import { useStore } from '../src/store/useStore';
import { Panel } from '../src/components/onboarding/Panel';
import { SealBreakDemo } from '../src/components/onboarding/SealBreakDemo';

const { width } = Dimensions.get('window');

type Slide = {
  icon?: keyof typeof Ionicons.glyphMap;
  title: string;
  body: string;
  demo?: boolean;
  caveat?: string;
};

const SLIDES: Slide[] = [
  {
    icon: 'camera-outline',
    title: 'Every capture, sealed at the shutter.',
    body: 'The moment you shoot, the phone signs the bytes, the time and what its sensors said. Nothing about the file can change afterwards without breaking that seal.',
    demo: true,
  },
  {
    icon: 'search-outline',
    title: 'Anyone can check the file.',
    body: 'No account, no server, nothing to install on their end. Open the file here, or anywhere the record format is understood, and the seal either holds or it doesn\u2019t.',
  },
  {
    icon: 'albums-outline',
    title: 'It proves the file. Not the scene.',
    body: 'A seal says these bytes haven\u2019t changed since this phone signed them. What the phone recorded alongside (time, place, motion) is evidence you can check yourself.',
    caveat: 'One more limit: this is early software. Don\u2019t keep your only copy of anything important here.',
  },
];

/**
 * The footer's primary action. The shared ui.tsx primary Button pairs its
 * ink fill with a hard-coded near-black label — black-on-black in light
 * mode (the 0.18.0 illegibility report). This one is theme-aware by
 * construction: ink fill (colors.text) with the scheme's canvas color
 * (colors.bg) as the label — legible in BOTH light and dark. The styles
 * come from the screen's useThemedStyles, so a scheme flip re-themes it.
 */
function PrimaryButton({ label, onPress, icon, styles }: {
  label: string;
  onPress: () => void;
  icon?: keyof typeof Ionicons.glyphMap;
  styles: ReturnType<typeof buildStyles>;
}) {
  return (
    <TouchableOpacity style={styles.primaryBtn} activeOpacity={0.75} onPress={onPress} accessibilityLabel={label}>
      {icon ? <Ionicons name={icon} size={17} color={colors.bg} style={styles.primaryBtnIcon} /> : null}
      <Text style={styles.primaryBtnText}>{label}</Text>
    </TouchableOpacity>
  );
}

export default function Onboarding() {
  const styles = useThemedStyles(buildStyles);
  const router = useRouter();
  const { setOnboarded, onboarded } = useStore();
  const [page, setPage] = useState(0);
  const scrollRef = useRef<React.ComponentRef<typeof ScrollView>>(null);

  // Replayed from the camera HUD lock badge after first run: offer an X-out
  // (first run has none — the tour is the gate into the app).
  const replaying = onboarded;

  // One count so the dots, the swipe, and the final button always agree
  // with how many pages actually exist (+1: the wordmark opening page).
  const TOTAL_PAGES = SLIDES.length + 1;
  const LAST_PAGE = TOTAL_PAGES - 1;

  const finish = async () => {
    await setOnboarded(true);
    if (replaying) router.back();
    else router.replace('/');
  };

  const goTo = (i: number) => {
    setPage(i);
    scrollRef.current?.scrollTo({ x: i * width, animated: true });
  };

  // Swiping is real paging: keep the dots honest about where the user is.
  const onScrollEnd = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    setPage(Math.round(e.nativeEvent.contentOffset.x / width));
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      {replaying ? (
        <View style={styles.closeRow}>
          <TouchableOpacity
            style={styles.closeBtn}
            hitSlop={12}
            onPress={() => router.back()}
            accessibilityLabel="Close the intro"
          >
            <Ionicons name="close" size={22} color={colors.textDim} />
          </TouchableOpacity>
        </View>
      ) : null}
      <ScrollView
        ref={scrollRef}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onMomentumScrollEnd={onScrollEnd}
        style={{ flex: 1 }}
      >
        {/* Page 0 — the wordmark. The aperture mark gets the iOS icon
            treatment (rounded-continuous corners, hairline), large and
            centered; the subhead is verbatim owner copy — ship as-is. */}
        <View key="intro" style={[styles.slide, { width }]}>
          <Panel active={page === 0} style={styles.introPanel}>
            <Image
              source={require('../assets/icons/icon-light.png')}
              style={styles.introIcon}
              accessibilityLabel="Source Kit aperture mark"
            />
          </Panel>
          <Panel active={page === 0} delay={90} style={styles.introPanel}>
            <Text style={styles.brandTitle}>Source Kit</Text>
            <Text style={styles.introSub}>Fuck Deepfakes. Prove your work.</Text>
          </Panel>
        </View>
        {SLIDES.map((s, i) => {
          const active = page === i + 1;
          return (
            <View key={s.title} style={[styles.slide, { width }]}>
              <Panel active={active}>
                {s.icon ? (
                  <View style={styles.iconRing}>
                    <Ionicons name={s.icon} size={40} color={colors.accent} />
                  </View>
                ) : null}
                <Text style={styles.slideTitle}>{s.title}</Text>
              </Panel>
              <Panel active={active} delay={90}>
                <Text style={styles.slideBody}>{s.body}</Text>
                {s.demo ? <SealBreakDemo /> : null}
                {s.caveat ? <Text style={styles.slideCaveat}>{s.caveat}</Text> : null}
              </Panel>
            </View>
          );
        })}
      </ScrollView>

      <View style={styles.footer}>
        <View style={styles.navRow}>
          {page > 0 ? (
            <TouchableOpacity
              style={styles.navSide}
              hitSlop={8}
              onPress={() => goTo(page - 1)}
              accessibilityLabel="Back"
            >
              <Ionicons name="chevron-back" size={15} color={colors.textDim} />
              <Text style={styles.navText}>Back</Text>
            </TouchableOpacity>
          ) : (
            <View style={styles.navSide} />
          )}
          <View style={styles.dots}>
            {Array.from({ length: TOTAL_PAGES }).map((_, i) => (
              <View key={i} style={[styles.dot, page === i && styles.dotActive]} />
            ))}
          </View>
          <TouchableOpacity
            style={[styles.navSide, styles.navSideRight]}
            hitSlop={8}
            onPress={finish}
            accessibilityLabel="Skip the intro"
          >
            <Text style={styles.navText}>Skip for now</Text>
          </TouchableOpacity>
        </View>
        {page < LAST_PAGE ? (
          <PrimaryButton label="Continue" onPress={() => goTo(page + 1)} styles={styles} />
        ) : replaying ? (
          <PrimaryButton label="Done" onPress={finish} styles={styles} />
        ) : (
          <PrimaryButton label="Start shooting" icon="camera-outline" onPress={finish} styles={styles} />
        )}
      </View>
    </SafeAreaView>
  );
}

const buildStyles = () => StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  closeRow: { flexDirection: 'row', justifyContent: 'flex-end', paddingHorizontal: spacing.md },
  closeBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  slide: { flex: 1, justifyContent: 'center', paddingHorizontal: spacing.xl },
  iconRing: {
    width: 84,
    height: 84,
    borderRadius: 42,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.lg,
  },
  slideTitle: {
    color: colors.text,
    fontSize: fontSize.hero,
    fontWeight: '700',
    letterSpacing: -1.0,
    fontFamily: type.display,
    marginBottom: spacing.md,
  },
  slideBody: { color: colors.textDim, fontSize: fontSize.md, lineHeight: 24, marginBottom: spacing.lg },
  brandTitle: { color: colors.text, fontSize: fontSize.hero, fontWeight: '800', letterSpacing: -1.0, fontFamily: type.display },
  introPanel: { alignItems: 'center' },
  introIcon: {
    width: 120,
    height: 120,
    // The iOS icon treatment: continuous-corner squircle (~22.5% radius)
    // with a hairline, so the asset reads as the app icon, not a picture.
    borderRadius: 27,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    marginBottom: spacing.lg,
  },
  introSub: {
    color: colors.textDim,
    fontSize: fontSize.md,
    fontWeight: '600',
    letterSpacing: 0.2,
    marginTop: spacing.sm,
    textAlign: 'center',
  },
  primaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.sm,
    paddingVertical: 12,
    paddingHorizontal: spacing.md,
    backgroundColor: colors.text,
  },
  primaryBtnIcon: { marginRight: 7 },
  primaryBtnText: { color: colors.bg, fontSize: fontSize.sm, fontWeight: '700', letterSpacing: 0.1 },
  slideCaveat: { color: colors.textFaint, fontSize: fontSize.sm, lineHeight: 19 },
  footer: { paddingHorizontal: spacing.xl, paddingBottom: spacing.lg, gap: spacing.lg },
  navRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  navSide: { flexDirection: 'row', alignItems: 'center', minWidth: 56, minHeight: 32 },
  navSideRight: { justifyContent: 'flex-end' },
  navText: { color: colors.textDim, fontSize: fontSize.sm },
  dots: { flexDirection: 'row', justifyContent: 'center', gap: 7 },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.border },
  dotActive: { backgroundColor: colors.accent, width: 18 },
});

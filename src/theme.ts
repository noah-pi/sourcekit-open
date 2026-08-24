// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Design tokens — modern minimal.
 *
 * Light-first, generous whitespace, sans display type (SF), soft borderless
 * surfaces with gentle elevation. Gradients are RARE and load-bearing: they
 * mark the two moments of action (a primary button, the seal pill) — never
 * decoration, never on evidence surfaces.
 *
 * What did NOT change, deliberately: the verdict semantics. Deep green =
 * intact/signed (and primary actions), amber = caution/unknown, brick red =
 * invalid/tampered, slate = information. Verdict colors stay muted — this is
 * a document, not a dashboard — and unsigned stays neutral gray, never red.
 *
 * The camera screen is the one exception: its chrome floats over the live
 * viewfinder (dark), so it uses the onDark tokens.
 *
 * APPEARANCE (0.15.x, Track E): the palette is now dual — light below, dark
 * further down (the approved Reader design system, mapped onto these same
 * keys). `colors` is mutated in place when the effective scheme changes, so
 * every existing `import { colors }` keeps working with no per-screen
 * rewrites. Resolution: preference 'device' follows the OS (seeded
 * synchronously from Appearance at module load, then kept live via an
 * Appearance listener); 'dark'/'light' pin the palette regardless of the OS.
 *
 * Known limit, stated honestly: styles built once at module scope
 * (`StyleSheet.create` at file bottom) capture their colors at module
 * evaluation, so an in-session override flip restyles everything read at
 * render time (icons, tints, gradients, inline styles) immediately and the
 * static style blocks on the next full tree rebuild — the root layout
 * remounts the navigator on scheme change to force exactly that. In the
 * default 'device' mode every module style is correct from first paint.
 */

import { Appearance, Platform, StyleSheet } from 'react-native';
import { useEffect, useMemo, useState } from 'react';

export const colors = {
  bg: '#F6F6F8',          // cool system neutral (Apple systemGray6 register)
  surface: '#FFFFFF',     // cards
  surface2: '#EEEEF2',    // inset areas, tracks, neutral chips
  border: '#E6E6EB',      // rare hairlines (dividers only)
  borderSoft: '#EFEFF3',

  text: '#1D1D1F',        // Apple label
  textDim: '#6E6E73',
  // WCAG AA: 4.07:1 on bg #F6F6F8, 4.39:1 on surface #FFFFFF (was #AEAEB2
  // at 2.05:1 — it carried the product's honesty sentences and failed AA).
  textFaint: '#78787D',

  accent: '#1F6B45',                   // brand green, lifted from darkroom
  accentSoft: 'rgba(31, 107, 69, 0.10)',
  accentGradStart: '#2E9E66',          // primary-action gradient (the only
  accentGradEnd: '#1B7A4B',            //  place color gets to glow)
  // WCAG AA for body text: 5.64:1 on white, 5.22:1 on bg (was #A4741C at
  // 4.13:1 on white — under the 4.5:1 AA line).
  warn: '#8A5F12',
  warnSoft: 'rgba(164, 116, 28, 0.10)',
  danger: '#C03527',
  dangerSoft: 'rgba(192, 53, 39, 0.08)',
  info: '#3D6B8E',
  infoSoft: 'rgba(61, 107, 142, 0.10)',

  onAccent: '#FFFFFF',    // text/icons on accent-filled buttons

  // Camera chrome floats over the dark viewfinder.
  shutterRing: '#F5F5F7',
  onDark: {
    text: '#F5F5F7',
    dim: '#C7C7CC',
    faint: '#8E8E93',
    accent: '#7ED6A4',     // accent readable on dark scrims
  },
};

/* ------------------------------------------------------------------ *
 * Appearance — dual palette + preference resolution.                  *
 * ------------------------------------------------------------------ */

export type ColorPalette = typeof colors;
export type AppearancePreference = 'device' | 'dark' | 'light';
export type EffectiveScheme = 'light' | 'dark';

/** Snapshot of the light palette — the return trip when the scheme flips. */
const lightColors: ColorPalette = { ...colors, onDark: { ...colors.onDark } };

/**
 * Dark palette — the approved Reader design system, so the app and Reader
 * agree. Approved values map straight onto the existing keys; keys with no
 * approved dark counterpart are derived in the same temperature/saturation
 * family and say how.
 */
const darkColors: ColorPalette = {
  bg: '#0D0D0F',            // approved: Reader bg
  surface: '#151519',       // approved: Reader card
  // Derived: no approved value. Light surface2 is one step DARKER than bg
  // (inset areas, tracks, chips), so the dark twin steps below dark bg.
  surface2: '#08080A',
  border: '#26262C',        // approved: Reader hairline
  // Derived: no approved value. Light borderSoft sits between bg and border
  // (the softer hairline); same halfway step here.
  borderSoft: '#1A1A1F',

  text: '#E8E8EC',          // approved: Reader ink
  textDim: '#A9A9B2',       // approved: Reader muted
  textFaint: '#71717A',     // approved: Reader dim

  accent: '#4E7A62',        // approved: Reader ok-dim — verdict green stays muted in dark, by design
  // Derived: same key role as light accentSoft — the accent at low alpha.
  accentSoft: 'rgba(78, 122, 98, 0.16)',
  // Derived: the single-hue primary-action gradient, ok-dim lifted +0.10
  // lightness (HSL, saturation +15%) at the start and ok-dim itself at the
  // end — mirroring light's lighter-start/accent-end shape.
  accentGradStart: '#5E9D7B',
  accentGradEnd: '#4E7A62',
  // 0.18.2: was the approved Reader warn #F5B301 — a pure yellow that
  // clashes with the landed palette (sage/cream/clay). Now a muted, warmer
  // amber in the same family; 7.4:1 on bg, 7.0:1 on surface (AA).
  warn: '#C9974F',
  // Derived: the warn at low alpha, light warnSoft's role.
  warnSoft: 'rgba(201, 151, 79, 0.14)',
  danger: '#E5484D',        // approved: Reader red
  // Derived: the approved red at low alpha, light dangerSoft's role.
  dangerSoft: 'rgba(229, 72, 77, 0.14)',
  // Derived: no approved value. Light info #3D6B8E lifted to 0.66 lightness
  // (same hue/saturation) so the slate reads on dark surfaces.
  info: '#86ADCB',
  infoSoft: 'rgba(134, 173, 203, 0.14)',

  onAccent: '#FFFFFF',      // unchanged: reads on ok-dim as it did on the light accent

  // Camera chrome floats over the dark viewfinder in BOTH schemes — the
  // dark-register tokens below are scheme-independent and stay put.
  shutterRing: '#F5F5F7',
  onDark: {
    text: '#F5F5F7',
    dim: '#C7C7CC',
    faint: '#8E8E93',
    accent: '#7ED6A4',
  },
};

/**
 * Resolution state. Seeded SYNCHRONOUSLY from the OS at module load: in the
 * default 'device' mode every module-scope StyleSheet evaluates with the
 * correct palette before first paint. The persisted preference arrives
 * later (settings load pushes it via setAppearancePreference).
 */
let systemScheme: EffectiveScheme = Appearance.getColorScheme() === 'dark' ? 'dark' : 'light';
let preference: AppearancePreference = 'device';
let effectiveScheme: EffectiveScheme = systemScheme;

const schemeListeners = new Set<() => void>();

function applyScheme(next: EffectiveScheme): void {
  if (next === effectiveScheme) return;
  effectiveScheme = next;
  // Mutate the exported object in place — import sites keep the same
  // reference and read the new values on their next render.
  Object.assign(colors, next === 'dark' ? darkColors : lightColors);
  schemeListeners.forEach((l) => l());
}

const resolve = (): EffectiveScheme => (preference === 'device' ? systemScheme : preference);

// 'device' mode tracks the OS live (Control Centre toggle, sunset schedule).
Appearance.addChangeListener(({ colorScheme }) => {
  systemScheme = colorScheme === 'dark' ? 'dark' : 'light';
  applyScheme(resolve());
});

// Seed for module evaluation (see note above).
if (effectiveScheme === 'dark') Object.assign(colors, darkColors);

/** Persisted preference pushed in from the settings store. */
export function setAppearancePreference(next: AppearancePreference): void {
  if (next === preference) return;
  preference = next;
  applyScheme(resolve());
}

/** React binding: re-renders the subscriber when the effective scheme flips. */
export function useEffectiveScheme(): EffectiveScheme {
  const [scheme, setScheme] = useState<EffectiveScheme>(effectiveScheme);
  useEffect(() => {
    // Re-sync on subscribe in case a flip landed between render and effect.
    setScheme(effectiveScheme);
    const listener = () => setScheme(effectiveScheme);
    schemeListeners.add(listener);
    return () => {
      schemeListeners.delete(listener);
    };
  }, []);
  return scheme;
}

/**
 * Themed styles that follow the scheme. Module-scope `StyleSheet.create`
 * snapshots whatever palette was current at import — the screen then stays
 * light after a flip. Resolve the sheet per render instead: the builder
 * reads the (mutated-in-place) `colors` AFTER any flip, and the scheme
 * subscription forces the re-render that recomputes it.
 *
 *   const buildStyles = () => StyleSheet.create({ … colors.x … });
 *   const styles = useThemedStyles(buildStyles);
 */
// RN 0.87's strict types no longer export StyleSheet.NamedStyles; the
// create() parameter is the same constraint and survives the flip.
type StyleMap = Parameters<typeof StyleSheet.create>[0];

export function useThemedStyles<T extends StyleMap>(build: () => T): T {
  const scheme = useEffectiveScheme();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- scheme is the invalidation key; colors mutates in place before listeners fire
  return useMemo(() => StyleSheet.create(build()), [scheme]);
}

export const spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 48,
};

export const radii = {
  sm: 10,
  md: 14,
  lg: 20,
  full: 999,
};

export const type = {
  mono: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
  system: Platform.select({ ios: 'System', default: undefined as unknown as string }),
  // Display: SF/system sans with tight tracking — verdict headlines, screen
  // titles, onboarding. The serif register is retired.
  display: Platform.select({ ios: 'System', default: undefined as unknown as string }),
};

export const fontSize = {
  xs: 11,
  sm: 13,
  md: 15,
  lg: 17,
  xl: 22,
  xxl: 28,
  hero: 34,
};

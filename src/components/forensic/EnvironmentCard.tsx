// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * EnvironmentCard — sun/shadow, horizon, and weather for the sealed time
 * and place, in the same juxtaposition style as the Inspect screen.
 *
 * The horizon and shadow modules REUSE the Inspect screen's components
 * (src/components/Juxtapose.tsx — HorizonCard / ShadowCard) so the two
 * screens can never drift apart; weather renders in the same card language
 * but fetches BY DEFAULT when a location is present (Inspect puts the fetch
 * behind a tap). Offline the weather module says "Network not available",
 * neutral. Every module juxtaposes the sealed claim with what should be
 * true and never concludes.
 */

import React, { useState } from 'react';
import { View, Text, StyleSheet, Pressable, Linking, ActivityIndicator } from 'react-native';

import { colors, spacing, fontSize, useThemedStyles } from '../../theme';
import { HorizonCard, ShadowCard } from '../Juxtapose';
import { ForensicCard, NotRecorded } from './ForensicCard';
import { useStore } from '../../store/useStore';

// Open-Meteo archive weather-code words (same table the Inspect screen uses).
const WEATHER_WORDS: Record<number, string> = {
  0: 'Clear', 1: 'Mostly clear', 2: 'Partly cloudy', 3: 'Overcast',
  45: 'Fog', 48: 'Fog',
  51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle',
  61: 'Light rain', 63: 'Rain', 65: 'Heavy rain',
  66: 'Freezing rain', 67: 'Freezing rain',
  71: 'Light snow', 73: 'Snow', 75: 'Heavy snow', 77: 'Snow grains',
  80: 'Light showers', 81: 'Showers', 82: 'Heavy showers',
  85: 'Snow showers', 86: 'Snow showers',
  95: 'Thunderstorm', 96: 'Thunderstorm with hail', 99: 'Thunderstorm with hail',
};

function windWords(kmh: number): string {
  if (kmh < 12) return 'light wind';
  if (kmh < 30) return 'breezy';
  return 'strong wind';
}

/** Weather: the official archive reading for the sealed hour — fetched by
 *  default (a location is present), offline stated as "Network not available". */
function AutoWeather({ lat, lon, at, sealedWhenWhere }: {
  lat: number;
  lon: number;
  at: Date;
  sealedWhenWhere: string;
}) {
  const styles = useThemedStyles(buildStyles);
  const weatherLookupEnabled = useStore((st) => st.settings.weatherLookupEnabled);
  const [state, setState] = useState<'idle' | 'loading' | 'done' | 'offline'>('idle');
  const [reading, setReading] = useState<string | null>(null);

  const check = async () => {
    setState('loading');
    try {
      const day = at.toISOString().slice(0, 10);
      const url =
        `https://archive-api.open-meteo.com/v1/archive?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}` +
        `&start_date=${day}&end_date=${day}&hourly=temperature_2m,weather_code,wind_speed_10m&timezone=UTC`;
      const res = await fetch(url);
      const json = await res.json();
      const hour = at.getUTCHours();
      const code = json?.hourly?.weather_code?.[hour];
      const temp = json?.hourly?.temperature_2m?.[hour];
      const wind = json?.hourly?.wind_speed_10m?.[hour];
      if (code === undefined || temp === undefined) throw new Error('no reading');
      setReading(`${WEATHER_WORDS[code] ?? 'Unknown'} · ${Math.round(temp)}°C · ${windWords(wind ?? 0)}`);
      setState('done');
    } catch {
      setState('offline');
    }
  };


  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>Weather</Text>
      <Text style={styles.cardSub}>Official weather for the sealed time and location.</Text>
      {!weatherLookupEnabled ? (
        <Text style={styles.weatherBtnText}>
          Weather archive lookup is off. Turn it on in Settings to check the archive — the lookup sends the sealed coordinate and day over the network.
        </Text>
      ) : state === 'idle' ? (
        <Pressable style={styles.weatherBtn} onPress={() => void check()} hitSlop={6}>
          <Text style={styles.weatherBtnText}>Check the archive · sends the sealed coordinates</Text>
        </Pressable>
      ) : state === 'loading' ? (
        <View style={styles.weatherBtn}>
          <ActivityIndicator color={colors.accent} size="small" />
        </View>
      ) : state === 'offline' ? (
        <Pressable style={styles.weatherBtn} onPress={() => void check()} hitSlop={6}>
          <Text style={styles.weatherBtnText}>Network not available. Tap to retry</Text>
        </Pressable>
      ) : (
        <View style={styles.pair}>
          <View style={styles.half}>
            <Text style={styles.halfKey}>Sealed</Text>
            <Text style={styles.halfVal}>{sealedWhenWhere}</Text>
          </View>
          <View style={styles.half}>
            <Text style={styles.halfKey}>Should have been</Text>
            <Text style={styles.halfVal}>{reading ?? ''}</Text>
          </View>
        </View>
      )}
      {weatherLookupEnabled ? (
        <Pressable onPress={() => void Linking.openURL('https://open-meteo.com/')} hitSlop={6}>
          <Text style={styles.sourceLink}>Source: Open-Meteo archive ↗</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export function EnvironmentCard({ lat, lon, atIso, rollDeg, pitchDeg, facing, hfovDeg, sealedWhenWhere }: {
  /** Sealed location claim (device-reported), when present. */
  lat: number | null;
  lon: number | null;
  /** Sealed capture time (ISO), when parseable. */
  atIso: string | null;
  /** Sealed pose-trace attitude at the shutter, degrees, when present. */
  rollDeg: number | null;
  pitchDeg: number | null;
  /** 0.20.5: sealed camera facing / horizontal FOV — the horizon card's
   *  projection inputs (absent on older records → nominal fallbacks). */
  facing?: 'front' | 'back' | null;
  hfovDeg?: number | null;
  /** "Aug 12 · 2:41 PM · Austin" — the sealed time/place line, caller-formatted. */
  sealedWhenWhere: string;
}) {
  const at = atIso ? new Date(atIso) : null;
  const atValid = at && Number.isFinite(at.getTime()) ? at : null;
  const hasPlace = lat !== null && lon !== null && atValid !== null;
  const hasHorizon = rollDeg !== null && pitchDeg !== null;

  if (!hasPlace && !hasHorizon) {
    return (
      <ForensicCard
        title="Environment"
        sub="What the sun, the horizon, and the weather record say about the sealed time and place."
      >
        <NotRecorded reason="no location or pose trace sealed with this capture" />
      </ForensicCard>
    );
  }

  // The modules render as sibling cards in the Inspect screen's own style.
  return (
    <View>
      {hasHorizon ? <HorizonCard rollDeg={rollDeg} pitchDeg={pitchDeg} facing={facing} hfovDeg={hfovDeg} /> : null}
      {hasPlace ? (
        <ShadowCard lat={lat} lon={lon} at={atValid} sealedWhenWhere={sealedWhenWhere} />
      ) : null}
      {hasPlace ? (
        <AutoWeather lat={lat} lon={lon} at={atValid} sealedWhenWhere={sealedWhenWhere} />
      ) : null}
    </View>
  );
}

const buildStyles = () => StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 14,
    padding: spacing.sm + 4,
    marginBottom: spacing.sm,
  },
  cardTitle: { color: colors.text, fontSize: fontSize.sm, fontWeight: '700' },
  cardSub: { color: colors.textDim, fontSize: fontSize.xs, lineHeight: 17, marginTop: 2 },
  weatherBtn: {
    marginTop: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingVertical: 10,
    alignItems: 'center',
  },
  weatherBtnText: { color: colors.textDim, fontSize: fontSize.xs, fontWeight: '600' },
  pair: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm + 2 },
  half: { flex: 1 },
  halfKey: {
    color: colors.textFaint,
    fontSize: 8.5,
    fontWeight: '800',
    letterSpacing: 1.4,
    textTransform: 'uppercase',
    marginBottom: 3,
  },
  halfVal: { color: colors.textDim, fontSize: fontSize.xs, lineHeight: 17 },
  sourceLink: { color: colors.textFaint, fontSize: fontSize.xs, marginTop: spacing.sm },
});

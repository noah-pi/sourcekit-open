/**
 * Juxtapose — the "What should be true" cards.
 *
 * The pivot: these cards never detect and never conclude. Each puts what was
 * SEALED next to what SHOULD BE true, and leaves the match to the person
 * looking at the photo. No error bands, no agrees/diverges, no scores.
 *
 *   The horizon  — the committed gravity (pose-trace roll/pitch at the
 *                  shutter) places the level line on a rectangle standing in
 *                  for the frame. Nothing in the pixels is analyzed.
 *   Shadows      — the committed time and place fix the sun (NOAA ephemeris,
 *                  src/reader/verify/solar.ts); one sundial-style graphic —
 *                  a gnomon rising from a perspective-tilted ground plane,
 *                  its shadow drawn on the plane in the sun-opposite
 *                  direction at the computed length ratio — shows where
 *                  shadows run and how long they should be, in the object's
 *                  own heights (NSEW, never bare degrees).
 *   Weather      — the official archive reading for the sealed time and
 *                  place, fetched on tap (network, stated).
 *   Motion       — the sealed gyro trace around the shutter, drawn as-is.
 *
 * Location honesty: horizon and motion need only the pose trace; shadows and
 * weather need the committed location too — cards whose inputs are absent
 * simply don't render (the caller checks), matching the mockup's rule.
 */

import React, { useState } from 'react';
import { View, Text, StyleSheet, Pressable, Linking, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { colors, spacing, radii, fontSize, type, useThemedStyles } from '../theme';
import type { AttestationRecord, PoseTrace } from '../provenance/manifest';
import { solarPosition, shadowGrammar } from '../reader/verify/solar';

// ---------------------------------------------------------------------------
// Sealed inputs, derived once from the record
// ---------------------------------------------------------------------------

export interface JuxtaInputs {
  /** Pose-trace attitude at the shutter sample, degrees. Null without a trace. */
  rollDeg: number | null;
  pitchDeg: number | null;
  trace: PoseTrace | null;
  lat: number | null;
  lon: number | null;
  /** Device compass heading at capture (degrees CW from north), when sealed. */
  headingDeg: number | null;
  at: Date | null;
  /** "Aug 12 · 2:41 PM · Austin" — the sealed time/place line, caller-formatted. */
  sealedWhenWhere: string;
}

export function juxtaInputs(record: AttestationRecord, sealedWhenWhere: string): JuxtaInputs {
  const trace = record.context?.poseTrace ?? null;
  let rollDeg: number | null = null;
  let pitchDeg: number | null = null;
  if (trace && Number.isInteger(trace.anchor)) {
    const i = trace.anchor * 3;
    if (i + 2 < trace.attitude.length) {
      const r = trace.attitude[i];
      const p = trace.attitude[i + 1];
      if (Number.isFinite(r)) rollDeg = r / 10;
      if (Number.isFinite(p)) pitchDeg = p / 10;
    }
  }
  const loc = record.context?.location;
  const lat = loc && typeof loc === 'object' && typeof loc.lat === 'number' ? loc.lat : null;
  const lon = loc && typeof loc === 'object' && typeof loc.lon === 'number' ? loc.lon : null;
  const heading = record.context?.headingDeg;
  const at = new Date(record.capturedAt);
  return {
    rollDeg, pitchDeg, trace, lat, lon,
    headingDeg: typeof heading === 'number' && Number.isFinite(heading) ? heading : null,
    at: Number.isFinite(at.getTime()) ? at : null,
    sealedWhenWhere,
  };
}

/** Degrees clockwise from north → 8-wind compass label. */
export function compass8(deg: number): string {
  const winds = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return winds[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
}

const round1 = (v: number): number => Math.round(v * 10) / 10;

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

function Pair({ sealed, shouldBe, shouldLabel = 'Should be' }: { sealed: string; shouldBe: string; shouldLabel?: string }) {
  const styles = useThemedStyles(buildStyles);
  return (
    <View style={styles.pair}>
      <View style={styles.half}>
        <Text style={styles.halfKey}>Sealed</Text>
        <Text style={styles.halfVal}>{sealed}</Text>
      </View>
      <View style={styles.half}>
        <Text style={styles.halfKey}>{shouldLabel}</Text>
        <Text style={styles.halfVal}>{shouldBe}</Text>
      </View>
    </View>
  );
}

function Card({ title, sub, children }: { title: string; sub: string; children: React.ReactNode }) {
  const styles = useThemedStyles(buildStyles);
  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>{title}</Text>
      <Text style={styles.cardSub}>{sub}</Text>
      {children}
    </View>
  );
}

// ---------------------------------------------------------------------------
// The horizon — committed gravity places the level line on the frame
// ---------------------------------------------------------------------------

/**
 * Sealed attitude → frame geometry, as an actual 3D model (0.18.2 — Noah's
 * field note: the overlays ignored what happens when the phone points DOWN
 * or UP, and the lines pivoted off-center). The trace commits expo
 * DeviceMotion attitude (roll = gamma, pitch = beta, decidegrees ÷ 10).
 * The 0.18.1 field bug stands as recorded below: the web/CoreMotion Euler
 * chart (Z–X′–Y″) hits gimbal lock at beta ≈ ±90° — exactly an upright
 * phone taking a photo — so neither raw Euler angle is trustworthy alone.
 *
 * The robust quantities come from the GRAVITY VECTOR. With device axes
 * x = right, y = top, z = out of screen, gravity in device coords is
 * proportional to g = (cos β·sin γ, −sin β, −cos β·cos γ), and the camera
 * looks along −z. Then, with no Euler-chart assumptions anywhere:
 *
 *   gravityTiltDeg — the plumb lean on screen: the direction of gravity's
 *                    projection onto the image plane, atan2(cos β·sin γ, sin β).
 *   horizonTiltDeg — the horizon's tilt: roll ROTATES the horizon around
 *                    the image center; the perpendicular of the plumb.
 *   aimDownDeg     — how far the lens points BELOW horizontal: the angle
 *                    between the camera axis (0,0,−1) and the horizontal
 *                    plane, asin(−ẑ·ĝ) = asin(cos β·cos γ). Roll AND pitch
 *                    both count — a phone rolled onto its side and tilted
 *                    forward reads correctly, where the old |β|−90 did not.
 *   horizonTopPct  — pitch TRANSLATES the horizon: a pinhole maps elevation
 *                    angle to vertical offset by the tangent, so aimed down
 *                    the horizon rises by tan(aim)/tan(half the vertical
 *                    field of view) — and LEAVES THE FRAME entirely past
 *                    the FOV edge (horizonInFrame says when).
 *   plumbMagnitude — |gravity's projection onto the image plane| = |cos aim|:
 *                    1 aimed level, 0 aimed straight down or up — where the
 *                    plumb DIRECTION stops meaning anything at all.
 *
 * Standing caveat, stated honestly: with no orientation sealed in the
 * record, the portrait image-plane mapping is assumed; a landscape capture
 * gets the same formulas applied to the displayed (EXIF-normalized) frame.
 * The half-FOV is nominal for a phone main camera (26°); the mapping is
 * illustrative but monotone, and honest about the horizon leaving frame.
 */
const RAD_D = Math.PI / 180;
const HALF_VFOV_DEG = 26;
const clamp1 = (v: number): number => Math.min(1, Math.max(-1, v));

export function gravityTiltDeg(rollDeg: number, pitchDeg: number): number {
  const b = pitchDeg * RAD_D;
  const g = rollDeg * RAD_D;
  return (Math.atan2(Math.cos(b) * Math.sin(g), Math.sin(b)) * 180) / Math.PI;
}

export function horizonTiltDeg(rollDeg: number, pitchDeg: number): number {
  return -gravityTiltDeg(rollDeg, pitchDeg);
}

/** Degrees the lens aims BELOW horizontal (negative = aimed up). */
export function aimDownDeg(rollDeg: number, pitchDeg: number): number {
  const b = pitchDeg * RAD_D;
  const g = rollDeg * RAD_D;
  return (Math.asin(clamp1(Math.cos(b) * Math.cos(g))) * 180) / Math.PI;
}

/**
 * Horizon line position, % from the top of the frame: the pinhole tangent
 * mapping. Aimed level → 50 (centered); aimed down by the half-FOV → 0
 * (the top edge); aimed up symmetrically → 100.
 */
export function horizonTopPct(aimDown: number): number {
  return 50 - (Math.tan(aimDown * RAD_D) / Math.tan(HALF_VFOV_DEG * RAD_D)) * 50;
}

/** False when the horizon sits outside the frame at this aim (small margin). */
export function horizonInFrame(aimDown: number): boolean {
  return Math.abs(Math.tan(aimDown * RAD_D) / Math.tan(HALF_VFOV_DEG * RAD_D)) <= 0.94;
}

/** |gravity projection onto the image plane|, 0..1 — the plumb's meaning. */
export function plumbMagnitude(rollDeg: number, pitchDeg: number): number {
  return Math.abs(Math.cos(aimDownDeg(rollDeg, pitchDeg) * RAD_D));
}

/** Below this projection (|aim| past 60°) a plumb LINE says nothing. */
const PLUMB_LINE_MIN = 0.5;

export function HorizonLineOverlay({ rollDeg, pitchDeg }: { rollDeg: number; pitchDeg: number }) {
  const styles = useThemedStyles(buildStyles);
  const aim = aimDownDeg(rollDeg, pitchDeg);
  const tilt = horizonTiltDeg(rollDeg, pitchDeg);
  if (!horizonInFrame(aim)) {
    // Out of frame: never a line clamped to a meaningless position — an
    // edge chevron points to where the level sits, the badge states the aim.
    const above = aim > 0; // aimed down → the horizon is above the frame
    return (
      <View style={StyleSheet.absoluteFill} pointerEvents="none">
        <View style={[styles.edgeChevronWrap, above ? { top: spacing.sm } : { bottom: spacing.sm + 22 }]}>
          <Ionicons name={above ? 'chevron-up' : 'chevron-down'} size={18} color={colors.onDark.accent} />
        </View>
        <View style={[styles.aimBadgeWrap, above ? { top: spacing.sm + 24 } : { bottom: spacing.sm + 46 }]}>
          <View style={styles.aimBadgeChip}>
            <Text style={styles.aimBadgeText}>
              {`horizon ${above ? 'above' : 'below'} the frame · aimed ${aim > 0 ? 'down' : 'up'} ${round1(Math.abs(aim))}°`}
            </Text>
          </View>
        </View>
      </View>
    );
  }
  const line = { top: `${horizonTopPct(aim)}%` as const };
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      {/* Roll rotates the horizon around the IMAGE CENTER: the
          wrapper carries the rotation, the line carries the pitch offset. */}
      <View style={[StyleSheet.absoluteFill, { transform: [{ rotate: `${tilt}deg` }] }]}>
        <View style={[styles.horizonOverlayBacking, line]} />
        <View style={[styles.horizonOverlayLine, line]} />
      </View>
    </View>
  );
}

/**
 * The gravity (level) overlay: the projection of gravity onto the image
 * plane, drawn ON the photo. Aimed near level that's a plumb line through
 * the frame center, leaning with the measured gravity, its length ∝ the
 * projection magnitude |cos aim| — against a faint screen-true vertical
 * for reference. Aimed steeply down or up (|aim| past ~60°) the projection
 * collapses and no line direction is honest: a center target renders
 * instead — filled core = gravity points INTO the scene (aimed down),
 * hollow = OUT toward the viewer (aimed up). It visualizes the sealed
 * attitude; it says nothing about the pixels.
 */
export function GravityPlumbOverlay({ rollDeg, pitchDeg }: { rollDeg: number; pitchDeg: number }) {
  const styles = useThemedStyles(buildStyles);
  const tilt = gravityTiltDeg(rollDeg, pitchDeg);
  const aim = aimDownDeg(rollDeg, pitchDeg);
  const m = plumbMagnitude(rollDeg, pitchDeg);
  if (m < PLUMB_LINE_MIN) {
    return (
      <View style={StyleSheet.absoluteFill} pointerEvents="none">
        <View style={styles.plumbTargetWrap}>
          <View style={styles.plumbTargetRing}>
            <View style={aim > 0 ? styles.plumbTargetCore : styles.plumbTargetCoreHollow} />
          </View>
        </View>
        <View style={[styles.aimBadgeWrap, { bottom: spacing.sm + 22 }]}>
          <View style={styles.aimBadgeChip}>
            <Text style={styles.aimBadgeText}>
              {`aimed ${aim > 0 ? 'down' : 'up'} ${round1(Math.abs(aim))}° · gravity points ${aim > 0 ? 'into the scene' : 'out toward you'}`}
            </Text>
          </View>
        </View>
      </View>
    );
  }
  // The line pivots at the IMAGE CENTER (its view is centered) and its
  // length follows the projection magnitude — shorter as the aim steepens.
  const inset = `${50 - 40 * m}%` as const;
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      <View style={styles.plumbReference} />
      <View style={[styles.plumbBacking, { top: inset, bottom: inset, transform: [{ rotate: `${tilt}deg` }] }]} />
      <View style={[styles.plumbLine, { top: inset, bottom: inset, transform: [{ rotate: `${tilt}deg` }] }]} />
    </View>
  );
}

/** Wrap a signed angle into (−180, 180]. */
function wrap180(deg: number): number {
  return ((((deg + 180) % 360) + 360) % 360) - 180;
}

/**
 * The sun overlay: an edge marker on the photo pointing toward the sun's
 * azimuth, computed from the sealed time/place (NOAA ephemeris) against the
 * sealed device heading. In frame (within ±35° of the camera axis) the
 * marker sits on the top edge at its bearing; off-frame it becomes an edge
 * arrow — right, left, or "behind the camera". Needs the sealed heading;
 * without one the caller renders the text badge only (no invented arrow).
 */
export function SunAzimuthOverlay({ lat, lon, at, headingDeg }: { lat: number; lon: number; at: Date; headingDeg: number }) {
  const styles = useThemedStyles(buildStyles);
  const pos = solarPosition(lat, lon, at);
  const wind = compass8(pos.azimuthDeg);
  if (pos.elevationDeg <= 0) {
    return (
      <View style={styles.sunBadge} pointerEvents="none">
        <Text style={styles.sunBadgeText}>Sun below the horizon</Text>
      </View>
    );
  }
  const rel = wrap180(pos.azimuthDeg - headingDeg);
  const label = `Sun ${Math.round(pos.elevationDeg)}° up, ${wind}`;
  let markerStyle;
  let icon: keyof typeof Ionicons.glyphMap;
  if (Math.abs(rel) <= 35) {
    // In frame: top edge, positioned by bearing across a ±35° field of view.
    const xPct = 50 + (rel / 35) * 38;
    markerStyle = { top: spacing.sm, left: `${xPct}%` as const, marginLeft: -40 };
    icon = 'arrow-up';
  } else if (rel > 35 && rel <= 145) {
    markerStyle = { right: spacing.sm, top: '44%' as const };
    icon = 'arrow-forward';
  } else if (rel < -35 && rel >= -145) {
    markerStyle = { left: spacing.sm, top: '44%' as const };
    icon = 'arrow-back';
  } else {
    markerStyle = { bottom: spacing.sm + 22, alignSelf: 'center' as const };
    icon = 'arrow-down';
  }
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      <View style={[styles.sunMarker, markerStyle]}>
        <Ionicons name={icon} size={14} color="#0A0D10" />
        <Text style={styles.sunMarkerText}>
          {Math.abs(rel) > 145 ? 'Sun behind the camera' : label}
        </Text>
      </View>
    </View>
  );
}

export function HorizonCard({ rollDeg, pitchDeg }: { rollDeg: number; pitchDeg: number }) {
  const styles = useThemedStyles(buildStyles);
  const aim = aimDownDeg(rollDeg, pitchDeg);
  const inFrame = horizonInFrame(aim);
  const tilt = horizonTiltDeg(rollDeg, pitchDeg);
  const sealed =
    `Tilt ${round1(Math.abs(tilt))}° · aimed ${aim >= 0 ? 'down' : 'up'} ${round1(Math.abs(aim))}°`;
  return (
    <Card title="Horizon" sub="Estimated horizon position, from the sealed accelerometer.">
      <View style={styles.hrect}>
        <View style={styles.hrectCrossH} />
        <View style={styles.hrectCrossV} />
        {inFrame ? (
          <>
            {/* Same model as the photo overlay: roll rotates about the rect
                center, pitch translates by the tangent mapping. */}
            <View style={[StyleSheet.absoluteFill, { transform: [{ rotate: `${tilt}deg` }] }]}>
              <View style={[styles.hline, { top: `${horizonTopPct(aim)}%` }]} />
            </View>
            <Text style={[styles.htag, { top: `${Math.min(82, Math.max(2, horizonTopPct(aim) - 13))}%` }]}>
              parallel with horizon
            </Text>
          </>
        ) : (
          <Text style={[styles.htag, aim > 0 ? { top: '2%' } : { bottom: '2%' }]}>
            {`horizon ${aim > 0 ? 'above' : 'below'} this frame`}
          </Text>
        )}
      </View>
      <Pair
        sealed={sealed}
        shouldBe={
          inFrame
            ? 'A flat scene puts the horizon on the line above.'
            : `Aimed ${aim > 0 ? 'down' : 'up'} this steeply, a flat scene's horizon is out of frame; nothing in the photo should look level.`
        }
      />
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Shadows — the committed time and place fix the sun; shadows follow
// ---------------------------------------------------------------------------

/** Sundial geometry (px): a perspective ground plane — an ellipse tilted
 *  ~35° (ry/rx = sin 35° ≈ 0.57) — with the gnomon rising from its center.
 *  North is the FAR edge (top of the ellipse). A ground direction at
 *  compass bearing θ projects to screen (sin θ, −cos θ · SQUASH). */
const GROUND_RX = 74;
const GROUND_RY = 42;
const GROUND_SQUASH = GROUND_RY / GROUND_RX; // ≈ 0.568 — the ~35° tilt
const DIAL_CX = 90; // container is 180 wide
const DIAL_CY = 64; // container is 114 tall: 22px of headroom above the far edge

/**
 * The condition glyph (asked for weather-style icons). The
 * HONESTY RULE: the sealed record carries NO weather field (checked
 * src/provenance/manifest.ts), so the glyph is derived from sun elevation
 * alone — sun by day, an outlined sun near the horizon, a moon at night.
 * Clouds and rain would be fabricated conditions; they need a capture-time
 * weather API decision (flagged to Noah), so they never render here.
 */
function sunCondition(elevationDeg: number): { icon: keyof typeof Ionicons.glyphMap; words: string } {
  if (elevationDeg <= 0) return { icon: 'moon-outline', words: 'Nighttime. Not applicable.' };
  if (elevationDeg < 12) return { icon: 'sunny-outline', words: `Low sun · ${Math.round(elevationDeg)}° up, near the horizon` };
  return { icon: 'sunny', words: `Day · sun ${Math.round(elevationDeg)}° up` };
}

export function ShadowCard({ lat, lon, at, sealedWhenWhere }: { lat: number; lon: number; at: Date; sealedWhenWhere: string }) {
  const styles = useThemedStyles(buildStyles);
  const pos = solarPosition(lat, lon, at);
  const condition = sunCondition(pos.elevationDeg);
  if (pos.elevationDeg <= 0) {
    // Night: the sundial becomes plain language — Noah's verbatim.
    return (
      <Card title="Shadows" sub="Where the sun was, from the sealed time and place.">
        <View style={styles.conditionRow}>
          <Ionicons name={condition.icon} size={13} color={colors.textDim} />
          <Text style={styles.conditionText}>{condition.words}</Text>
        </View>
        <Pair sealed={sealedWhenWhere} shouldBe="The sun was below the horizon; no shadow grammar applies." />
      </Card>
    );
  }
  const shadow = shadowGrammar(pos)!;
  const wind = compass8(shadow.bearingDeg);
  const ratio = Math.round((shadow.poleShadowCm / 100) * 100) / 100;
  /* ONE shared unit keeps the drawing to scale on the tilted plane: the
     gnomon stands 1.2 × unit px tall (a slight vertical emphasis is the
     perspective convention) and the shadow runs ratio × unit px across the
     ground from its base. When a low sun would overflow the plane the unit
     shrinks; the proportion never does; past ~11× the tip clips at the
     ellipse edge — honestly long. The bearing math is shadowGrammar's: the
     shadow points OPPOSITE the sun azimuth ((azimuth + 180) mod 360 —
     verified against the NOAA ephemeris, e.g. an evening sun at 277° over
     Austin throws a 2.9× shadow at 97°, east). Only the projection changed
     in 0.18.2 — perspective now, the math untouched. */
  const unit = Math.max(6, Math.min(20, (GROUND_RX - 10) / ratio));
  const gnomonH = Math.round(unit * 1.2 * 10) / 10;
  const shadowWorld = Math.min(ratio * unit, GROUND_RX - 10);
  const brg = shadow.bearingDeg * (Math.PI / 180);
  const sdx = Math.sin(brg) * shadowWorld;
  const sdy = -Math.cos(brg) * GROUND_SQUASH * shadowWorld;
  const shadowLen = Math.hypot(sdx, sdy);
  const shadowAng = (Math.atan2(sdy, sdx) * 180) / Math.PI; // screen y-down: rotate clockwise
  // 0.18.5 post-field (Noah: "the sun arc is totally off — remove the sun
  // and the arc; the rest works without"): the sun dot and the dotted day
  // track are GONE. The dial keeps only what reads unambiguously — the
  // gnomon and its shadow on the ground plane; the sun's own position stays
  // in the words above ("Day · sun 36° up") and the SHOULD BE sentence.
  return (
    <Card title="Shadows" sub="Where the sun was, from the sealed time and place.">
      {/* The condition glyph: sun geometry ONLY (see sunCondition) — never
          a fabricated sky. */}
      <View style={styles.conditionRow}>
        <Ionicons name={condition.icon} size={13} color={colors.textDim} />
        <Text style={styles.conditionText}>{condition.words}</Text>
      </View>
      <View style={styles.sundialPersp}>
        {/* The ground plane: a soft fill under a hairline ring, both drawn
            as circles squashed to the ~35° tilt. */}
        <View style={styles.groundFill} pointerEvents="none" />
        <View style={styles.groundRing} pointerEvents="none" />
        {/* N — the far edge of the plane. */}
        <Text style={styles.groundN} pointerEvents="none">N</Text>
        {/* The shadow: ON the plane, from the gnomon's base toward
            azimuth + 180°, length = ratio × unit before projection. */}
        <View
          style={[
            styles.shadowLinePersp,
            { width: shadowLen, transform: [{ rotate: `${shadowAng}deg` }] },
          ]}
          pointerEvents="none"
        />
        {/* The gnomon: a short shaded bar rising from the plane's center —
            1 m at the dial's own scale. */}
        <View style={[styles.gnomonBar, { height: gnomonH, top: DIAL_CY - gnomonH }]} pointerEvents="none">
          <View style={styles.gnomonShade} />
        </View>
        <View style={styles.gnomonBase} pointerEvents="none" />
        {/* 0.18.1: the bottom direction readout was removed — the shadow
            direction is already stated in the SHOULD BE sentence below,
            and the duplicated label read as a second, conflicting dial. */}
      </View>
      <Text style={styles.sratioLab}>1 m tall → {ratio} m shadow</Text>
      <Pair sealed={sealedWhenWhere} shouldBe={`Shadows run ${wind.toLowerCase() === 'n' ? 'north' : wind === 'NE' ? 'northeast' : wind === 'E' ? 'east' : wind === 'SE' ? 'southeast' : wind === 'S' ? 'south' : wind === 'SW' ? 'southwest' : wind === 'W' ? 'west' : 'northwest'}, about ${ratio}× the object's height.`} />
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Weather — the official archive for the sealed time and place, on tap
// ---------------------------------------------------------------------------

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

export function WeatherCard({ lat, lon, at, sealedWhenWhere }: { lat: number; lon: number; at: Date; sealedWhenWhere: string }) {
  const styles = useThemedStyles(buildStyles);
  const [state, setState] = useState<'idle' | 'loading' | 'done' | 'failed'>('idle');
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
      setState('failed');
    }
  };

  return (
    <Card title="Weather" sub="Official weather for the sealed time and location.">
      {state === 'idle' ? (
        <Pressable style={styles.weatherBtn} onPress={() => void check()} hitSlop={6}>
          <Text style={styles.weatherBtnText}>Check the archive · needs network</Text>
        </Pressable>
      ) : state === 'loading' ? (
        <View style={styles.weatherBtn}><ActivityIndicator color={colors.accent} size="small" /></View>
      ) : state === 'failed' ? (
        <Pressable style={styles.weatherBtn} onPress={() => void check()} hitSlop={6}>
          <Text style={styles.weatherBtnText}>Couldn't reach the archive. Tap to retry</Text>
        </Pressable>
      ) : (
        <Pair sealed={sealedWhenWhere} shouldLabel="Should have been" shouldBe={reading ?? ''} />
      )}
      <Pressable onPress={() => void Linking.openURL('https://open-meteo.com/')} hitSlop={6}>
        <Text style={styles.sourceLink}>Source: Open-Meteo archive ↗</Text>
      </Pressable>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Motion at the shutter — the sealed trace, drawn as-is
// ---------------------------------------------------------------------------

/** Rotation-rate magnitude per sample, normalized 0..1 for the spark bars. */
function traceMagnitudes(trace: PoseTrace): number[] {
  const out: number[] = [];
  let peak = 0;
  for (let i = 0; i < trace.samples; i++) {
    const j = i * 3;
    const m = Math.hypot(trace.rotRate[j] ?? 0, trace.rotRate[j + 1] ?? 0, trace.rotRate[j + 2] ?? 0);
    out.push(m);
    if (m > peak) peak = m;
  }
  return peak > 0 ? out.map((m) => m / peak) : out.map(() => 0);
}

export function MotionCard({ trace }: { trace: PoseTrace }) {
  const styles = useThemedStyles(buildStyles);
  const bars = traceMagnitudes(trace);
  return (
    <Card title="Motion at the shutter" sub="How the phone was moving at the shutter.">
      <View style={styles.sparkRow}>
        {bars.map((v, i) => (
          <View
            key={i}
            style={[
              styles.sparkBar,
              { height: 4 + v * 30 },
              i === trace.anchor ? styles.sparkBarAnchor : null,
            ]}
          />
        ))}
      </View>
      <Text style={styles.sparkLab}>Gyro at {trace.hz} Hz around the shutter · the marked sample is the shutter</Text>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// The section — renders only the cards whose sealed inputs exist
// ---------------------------------------------------------------------------

export function WhatShouldBeTrue({ inputs }: { inputs: JuxtaInputs }) {
  const styles = useThemedStyles(buildStyles);
  const cards: React.ReactNode[] = [];
  if (inputs.rollDeg !== null && inputs.pitchDeg !== null) {
    cards.push(<HorizonCard key="h" rollDeg={inputs.rollDeg} pitchDeg={inputs.pitchDeg} />);
  }
  if (inputs.lat !== null && inputs.lon !== null && inputs.at) {
    cards.push(<ShadowCard key="s" lat={inputs.lat} lon={inputs.lon} at={inputs.at} sealedWhenWhere={inputs.sealedWhenWhere} />);
    cards.push(<WeatherCard key="w" lat={inputs.lat} lon={inputs.lon} at={inputs.at} sealedWhenWhere={inputs.sealedWhenWhere} />);
  }
  if (inputs.trace) {
    cards.push(<MotionCard key="m" trace={inputs.trace} />);
  }
  if (cards.length === 0) return null;
  return (
    <View>
      <Text style={styles.secTitle}>What should be true</Text>
      {cards}
    </View>
  );
}

// ---------------------------------------------------------------------------

const buildStyles = () => StyleSheet.create({
  secTitle: {
    color: colors.textFaint, fontSize: fontSize.xs, fontWeight: '800',
    letterSpacing: 1.8, textTransform: 'uppercase',
    marginTop: spacing.lg, marginBottom: spacing.sm,
  },
  card: {
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border,
    borderRadius: radii.md, padding: spacing.sm + 4, marginBottom: spacing.sm,
  },
  cardTitle: { color: colors.text, fontSize: fontSize.sm, fontWeight: '700' },
  cardSub: { color: colors.textDim, fontSize: fontSize.xs, lineHeight: 17, marginTop: 2 },

  pair: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm + 2 },
  half: { flex: 1 },
  halfKey: {
    color: colors.textFaint, fontSize: 8.5, fontWeight: '800',
    letterSpacing: 1.4, textTransform: 'uppercase', marginBottom: 3,
  },
  halfVal: { color: colors.textDim, fontSize: fontSize.xs, lineHeight: 17 },

  // horizon
  hrect: {
    marginTop: spacing.sm, aspectRatio: 4 / 3, borderRadius: radii.sm,
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bg,
    overflow: 'hidden',
  },
  hrectCrossH: {
    position: 'absolute', left: 0, right: 0, top: '50%',
    height: StyleSheet.hairlineWidth, backgroundColor: colors.border,
  },
  hrectCrossV: {
    position: 'absolute', top: 0, bottom: 0, left: '50%',
    width: StyleSheet.hairlineWidth, backgroundColor: colors.border,
  },
  hline: {
    position: 'absolute', left: '6%', right: '6%', height: 3, borderRadius: 1.5,
    backgroundColor: colors.accent,
  },
  htag: {
    position: 'absolute', right: '6%', alignSelf: 'flex-end',
    color: colors.accent, fontSize: 8.5, fontWeight: '700',
  },
  // Overlay lines sit on arbitrary photos: a bright-green core (readable on
  // dark and light scenes) over a dark backing halo — never subtle. Bumped
 // a second time: still too faint over a bright sky at 7+3 px /
  // 0.55 alpha, so the halo goes to 9 px / 0.70 and the core to 4 px, the
  // core now CENTERED in the halo (marginTop splits the height difference).
  horizonOverlayBacking: {
    position: 'absolute', left: '4%', right: '4%', height: 9, borderRadius: 4.5,
    backgroundColor: 'rgba(10,13,16,0.70)',
  },
  horizonOverlayLine: {
    position: 'absolute', left: '4%', right: '4%', height: 4, borderRadius: 2,
    marginTop: 2.5,
    backgroundColor: colors.onDark.accent,
  },

  // gravity / plumb overlay (same second bump as the horizon line)
  // Top/bottom insets now come inline (∝ the projection magnitude)
  // and the bob is gone — it sat at a fixed bottom offset while the line
  // rotated, floating off the line's end ("the offset anchor looks wrong").
  plumbReference: {
    position: 'absolute', top: '10%', bottom: '10%', left: '50%', marginLeft: -0.75,
    width: 1.5, backgroundColor: 'rgba(255,255,255,0.60)',
  },
  plumbBacking: {
    position: 'absolute', left: '50%', marginLeft: -4.5,
    width: 9, borderRadius: 4.5, backgroundColor: 'rgba(10,13,16,0.70)',
  },
  plumbLine: {
    position: 'absolute', left: '50%', marginLeft: -2,
    width: 4, borderRadius: 2, backgroundColor: colors.onDark.accent,
  },
  // The steep-aim plumb state: gravity points into (filled core) or out of
  // (hollow core) the scene — a center target, never a meaningless line.
  plumbTargetWrap: {
    position: 'absolute', left: 0, right: 0, top: 0, bottom: 0,
    alignItems: 'center', justifyContent: 'center',
  },
  plumbTargetRing: {
    width: 34, height: 34, borderRadius: 17,
    borderWidth: 2.5, borderColor: colors.onDark.accent,
    backgroundColor: 'rgba(10,13,16,0.45)',
    alignItems: 'center', justifyContent: 'center',
  },
  plumbTargetCore: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.onDark.accent },
  plumbTargetCoreHollow: {
    width: 10, height: 10, borderRadius: 5,
    borderWidth: 2, borderColor: colors.onDark.accent,
  },
  // Out-of-frame affordances: an edge chevron toward the level, and a
  // centered aim badge stating the aim in words and degrees.
  edgeChevronWrap: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
  aimBadgeWrap: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
  aimBadgeChip: {
    backgroundColor: 'rgba(10,13,16,0.62)',
    borderRadius: radii.full,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  aimBadgeText: { color: '#fff', fontSize: 9.5, fontWeight: '700' },

  // sun overlay — filled accent pill, now with a dark halo ring and a step
  // larger type/icon so it holds up over a bright sky.
  sunMarker: {
    position: 'absolute',
    flexDirection: 'row', alignItems: 'center', gap: 5,
    backgroundColor: colors.onDark.accent,
    borderRadius: radii.full,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderWidth: 1.5,
    borderColor: 'rgba(10,13,16,0.60)',
  },
  sunMarkerText: { color: '#0A0D10', fontSize: 10.5, fontWeight: '800' },
  sunBadge: {
    position: 'absolute', left: spacing.sm, bottom: spacing.sm,
    backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: radii.md,
    paddingHorizontal: spacing.sm, paddingVertical: 4,
  },
  sunBadgeText: { color: '#fff', fontSize: fontSize.xs, fontWeight: '600' },

 // shadows — the perspective sundial: a tilted ground plane
  // (hairline ellipse over a soft fill), N on the far edge, a shaded
 // charcoal gnomon, ONE sage shadow line — and the clay sun dot
  // moving with azimuth AND elevation, opposite its shadow.
  sundialPersp: {
    width: 2 * DIAL_CX, height: 114,
    alignSelf: 'center', marginTop: spacing.sm + 2,
  },
  // The plane is a circle of radius GROUND_RX squashed to the tilt — the
  // squash thins the stroke at the near/far edges, which reads as depth.
  groundFill: {
    position: 'absolute', left: DIAL_CX - GROUND_RX, top: DIAL_CY - GROUND_RX,
    width: 2 * GROUND_RX, height: 2 * GROUND_RX, borderRadius: GROUND_RX,
    backgroundColor: colors.surface2, opacity: 0.55,
    transform: [{ scaleY: GROUND_SQUASH }],
  },
  groundRing: {
    position: 'absolute', left: DIAL_CX - GROUND_RX, top: DIAL_CY - GROUND_RX,
    width: 2 * GROUND_RX, height: 2 * GROUND_RX, borderRadius: GROUND_RX,
    borderWidth: 1, borderColor: colors.border,
    transform: [{ scaleY: GROUND_SQUASH }],
  },
  groundN: {
    position: 'absolute', top: DIAL_CY - GROUND_RY - 15, left: 0, right: 0,
    textAlign: 'center', color: colors.textFaint, fontSize: 7.5, fontWeight: '700',
  },
  // The clay sun dot — the one warm accent. 12px (0.18.3, Noah: ~40%
  // bigger than the old 8px), positioned by the polar projection above.
  sunDotPersp: {
    position: 'absolute', width: 12, height: 12, borderRadius: 6,
    backgroundColor: '#C08552',
  },
  // The dotted day-track the sun dot rides (same clay, quiet).
  sunPathDot: {
    position: 'absolute', width: 3, height: 3, borderRadius: 1.5,
    backgroundColor: 'rgba(192,133,82,0.45)',
  },
  // The shadow: rotated about its left-center end, which sits exactly on
  // the gnomon's base (DIAL_CX, DIAL_CY).
  shadowLinePersp: {
    position: 'absolute', left: DIAL_CX, top: DIAL_CY - 1.5,
    height: 3, borderRadius: 1.5,
    backgroundColor: colors.accent,
    transformOrigin: '0% 50%',
  },
  // The gnomon: a 5px bar with a darker right edge — a round pole in light
  // that comes from the sun side, not a hairline.
  gnomonBar: {
    position: 'absolute', left: DIAL_CX - 2.5, width: 5, borderRadius: 2.5,
    backgroundColor: colors.text,
    flexDirection: 'row', justifyContent: 'flex-end', overflow: 'hidden',
  },
  gnomonShade: { width: 1.8, backgroundColor: 'rgba(0,0,0,0.22)' },
  gnomonBase: {
    position: 'absolute', left: DIAL_CX - 4.5, top: DIAL_CY - 2.2,
    width: 9, height: 4.5, borderRadius: 4.5, backgroundColor: colors.text,
  },
  sratioLab: { color: colors.textDim, fontSize: fontSize.xs, marginTop: spacing.sm - 1, textAlign: 'center' },
  // The condition glyph row (sun-elevation-derived icon + plain words).
  conditionRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: spacing.sm },
  conditionText: { color: colors.textDim, fontSize: fontSize.xs, lineHeight: 17 },

  // weather
  weatherBtn: {
    marginTop: spacing.sm, borderWidth: 1, borderColor: colors.border, borderRadius: radii.sm,
    paddingVertical: 10, alignItems: 'center',
  },
  weatherBtnText: { color: colors.textDim, fontSize: fontSize.xs, fontWeight: '600' },
  sourceLink: { color: colors.textFaint, fontSize: fontSize.xs, marginTop: spacing.sm },

  // motion
  sparkRow: {
    flexDirection: 'row', alignItems: 'flex-end', gap: 2,
    height: 36, marginTop: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border,
  },
  sparkBar: { flex: 1, borderRadius: 1, backgroundColor: colors.textDim, minHeight: 2 },
  sparkBarAnchor: { backgroundColor: colors.accent },
  sparkLab: { color: colors.textFaint, fontSize: 9.5, marginTop: 5 },
});

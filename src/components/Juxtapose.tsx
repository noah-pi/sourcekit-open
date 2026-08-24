/**
 * Juxtapose — the "What should be true" cards (0.17.0).
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
 *   Motion       — the sealed gyro trace around the shutter, drawn as-is.
 *
 * Weather lives in src/components/forensic/EnvironmentCard.tsx, because it is
 * the one card that reaches the network and it stays behind a tap there.
 *
 * Location honesty: horizon and motion need only the pose trace; shadows need
 * the committed location too — cards whose inputs are absent simply don't
 * render (the caller checks), matching the mockup's rule.
 */

import React, { useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { colors, spacing, radii, fontSize, type, useThemedStyles } from '../theme';
import type { AttestationRecord, PoseTrace, SensorContext } from '../provenance/manifest';
import { solarPosition, shadowGrammar } from '../reader/verify/solar';
import { wmmDeclination } from '../reader/verify/geomag';
import { useStore } from '../store/useStore';

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
  /** 0.20.5: which camera produced the frame, when sealed (absent on
   *  pre-0.20.5 records → treated as 'back'). The front camera aims along
   *  device +Z, so its aim sign flips. */
  facing: 'front' | 'back' | null;
  /** 0.20.5: the primary camera's sealed horizontal FOV in degrees, when
   *  present — drives the horizon position and the sun in-frame window.
   *  Absent → nominal fallbacks (unchanged rendering of old records). */
  hfovDeg: number | null;
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
  const facingRaw = record.context?.cameraFacing;
  const hfovRaw = record.context?.hfovDeg;
  return {
    rollDeg, pitchDeg, trace, lat, lon,
    headingDeg: typeof heading === 'number' && Number.isFinite(heading) ? heading : null,
    at: Number.isFinite(at.getTime()) ? at : null,
    facing: facingRaw === 'front' || facingRaw === 'back' ? facingRaw : null,
    hfovDeg: typeof hfovRaw === 'number' && Number.isFinite(hfovRaw) && hfovRaw > 0 ? hfovRaw : null,
    sealedWhenWhere,
  };
}

/** Degrees clockwise from north → 8-wind compass label. */
export function compass8(deg: number): string {
  const winds = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return winds[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
}

/** the sensor-timing row states the FINDING first and
 *  keeps the number for anyone checking the work. intervalCv is the
 *  coefficient of variation of sensor-frame intervals in the capture window.
 *  The bands, stated plainly so the test is repeatable:
 *    • fewer than 30 samples → unknown (a short window proves nothing);
 *    • cv in [0.05, 0.5] → the jitter real handheld hardware produces;
 *    • outside → outside that usual range (synthetic feeds run too even or
 *      too bursty) — a bounded signal, stated neutrally, NEVER a verdict.
 *  The unknown state is mandatory: the verdict wording never ships without
 *  it. Same helper on both screens — the parallel rule. */
export function sensorTimingVerdict(st: { samples: number; intervalCv: number }): { value: string; detail: string } {
  const numbers = `${st.samples} samples, irregularity ${st.intervalCv}. A synthetic feed runs either too even or too bursty.`;
  if (st.samples < 30) return { value: 'Too few samples to tell', detail: numbers };
  if (st.intervalCv >= 0.05 && st.intervalCv <= 0.5) return { value: 'Jitter typical of real hardware', detail: numbers };
  return { value: 'Jitter outside the usual range for real hardware', detail: numbers };
}

/** "12.4°E sealed · 12.1°E expected · Δ 0.3°", or the
 *  sealed value alone when the record redacts location (declination redacts
 *  with location — it bands the capture to a few hundred km). The expected
 *  value is the WMM2025 model at the sealed coordinate and capture instant;
 *  null outside the model window or without a coordinate — never invented. */
export function declinationLine(ctx: SensorContext, at: Date | null): string | null {
  const sealed = ctx.declinationDeg;
  if (sealed == null) return null;
  const fmt = (d: number) => `${Math.abs(d).toFixed(1)}°${d >= 0 ? 'E' : 'W'}`;
  const loc = ctx.location;
  const has = typeof loc === 'object' && loc !== null && typeof loc.lat === 'number' && typeof loc.lon === 'number';
  const model = has && at ? wmmDeclination(loc.lat, loc.lon, at) : null;
  if (model == null) return `${fmt(sealed)} sealed`;
  return `${fmt(sealed)} sealed · ${fmt(model)} expected · Δ ${Math.abs(sealed - model).toFixed(1)}°`;
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
 *
 * 0.20.5 — two sealed inputs now sharpen this (absent on older records,
 * which render exactly as before):
 *  - hfovDeg: the primary camera's device-reported horizontal FOV at
 *    capture. For the portrait frame the vertical half-angle equals half
 *    the horizontal FOV (the frame's long axis is the sensor's width), so
 *    halfVfov = hfovDeg/2 replaces the nominal 26° — which read ~7° narrow
 *    for the real wide camera and misplaced the horizon accordingly.
 *  - facing: the FRONT camera aims along device +Z (the rear along −Z), so
 *    its aim sign flips — and its committed pixels are mirrored by the
 *    pipeline, which leaves the gravity-tilt mapping unchanged.
 */
const RAD_D = Math.PI / 180;
const HALF_VFOV_DEG = 26;
const clamp1 = (v: number): number => Math.min(1, Math.max(-1, v));

/** The vertical half-FOV in play: sealed hfov/2 when present, else the
 *  nominal 26° every pre-0.20.5 record was rendered with. */
function halfVfovFor(hfovDeg?: number | null): number {
  return hfovDeg != null && hfovDeg > 0 ? hfovDeg / 2 : HALF_VFOV_DEG;
}

/** 0.21.0: BOTH half-FOVs for the displayed frame. hfovDeg is the sensor's
 *  long-axis FOV, so the frame's long-axis half-angle is hfov/2 and the
 *  short-axis half-angle is atan(tan(hfov/2) / (long/short)) — a portrait
 *  3:4 frame's horizontal half-angle is ≈26.9°, NOT 34°. Using hfov/2 for
 *  the horizontal axis too (0.20.5–0.20.9) squished every portrait x
 *  position ~21% toward center. aspect = displayed width/height; absent
 *  (or a pre-0.20.5 record with no sealed hfov) → legacy behavior. */
export function halfFovsForFrame(hfovDeg?: number | null, aspect?: number | null): { halfX: number; halfY: number } {
  if (hfovDeg == null || hfovDeg <= 0) return { halfX: 35, halfY: HALF_VFOV_DEG };
  const long = hfovDeg / 2;
  if (aspect == null || !(aspect > 0)) return { halfX: long, halfY: long };
  const longOverShort = Math.max(aspect, 1 / aspect);
  const short = (Math.atan(Math.tan(long * RAD_D) / longOverShort) * 180) / Math.PI;
  return aspect >= 1 ? { halfX: long, halfY: short } : { halfX: short, halfY: long };
}

/** Signed aim for THIS camera: front aims along device +Z, so the
 *  rear-facing formula's sign flips (0.20.5). Exported for the inspect
 *  screen's gravity badge, which must quote the same number the overlay
 *  draws. */
export function aimForFacing(facing: 'front' | 'back' | null | undefined, rollDeg: number, pitchDeg: number): number {
  const aim = aimDownDeg(rollDeg, pitchDeg);
  return facing === 'front' ? -aim : aim;
}

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
export function horizonTopPct(aimDown: number, halfVfovDeg: number = HALF_VFOV_DEG): number {
  return 50 - (Math.tan(aimDown * RAD_D) / Math.tan(halfVfovDeg * RAD_D)) * 50;
}

/** False when the horizon sits outside the frame at this aim (small margin). */
export function horizonInFrame(aimDown: number, halfVfovDeg: number = HALF_VFOV_DEG): boolean {
  return Math.abs(Math.tan(aimDown * RAD_D) / Math.tan(halfVfovDeg * RAD_D)) <= 0.94;
}

/** |gravity projection onto the image plane|, 0..1 — the plumb's meaning. */
export function plumbMagnitude(rollDeg: number, pitchDeg: number): number {
  return Math.abs(Math.cos(aimDownDeg(rollDeg, pitchDeg) * RAD_D));
}

/** Below this projection (|aim| past 60°) a plumb LINE says nothing. */
const PLUMB_LINE_MIN = 0.5;

export function HorizonLineOverlay({ rollDeg, pitchDeg, facing, hfovDeg, aspect }: { rollDeg: number; pitchDeg: number; facing?: 'front' | 'back' | null; hfovDeg?: number | null; aspect?: number | null }) {
  const styles = useThemedStyles(buildStyles);
  // 0.21.0: the vertical half-angle of the DISPLAYED frame — hfov/2 in
  // portrait, the aspect-corrected short axis in landscape.
  const halfVfov = halfFovsForFrame(hfovDeg, aspect).halfY;
  const aim = aimForFacing(facing, rollDeg, pitchDeg);
  const tilt = horizonTiltDeg(rollDeg, pitchDeg);
  if (!horizonInFrame(aim, halfVfov)) {
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
  const line = { top: `${horizonTopPct(aim, halfVfov)}%` as const };
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      {/* Roll rotates the horizon around the IMAGE CENTER (0.18.2): the
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
export function GravityPlumbOverlay({ rollDeg, pitchDeg, facing }: { rollDeg: number; pitchDeg: number; facing?: 'front' | 'back' | null }) {
  const styles = useThemedStyles(buildStyles);
  const tilt = gravityTiltDeg(rollDeg, pitchDeg);
  const aim = aimForFacing(facing, rollDeg, pitchDeg);
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
 * sealed camera heading (0.20.5: facing-aware at seal time — the field bug
 * "pointing directly at the sun, it says it's beneath the frame" was the
 * wrong Euler chart in context.ts, fixed there). In frame (within the
 * camera's half-hfov of the camera axis — sealed value, nominal 35° on old
 * records) the marker sits on the top edge at its bearing; off-frame it
 * becomes an edge arrow — right, left, or "behind the camera". Needs the
 * sealed heading; without one the caller renders the text badge only (no
 * invented arrow).
 */
export function SunAzimuthOverlay({ lat, lon, at, headingDeg, hfovDeg, rollDeg, pitchDeg, facing, aspect }: { lat: number; lon: number; at: Date; headingDeg: number; hfovDeg?: number | null; rollDeg?: number | null; pitchDeg?: number | null; facing?: 'front' | 'back' | null; aspect?: number | null }) {
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
  // 0.20.5: the in-frame window is the camera's SEALED half-hfov when the
  // record carries it (the nominal 35° was a fudge that happened to sit
  // near a wide camera's real ~34°). headingDeg is the camera's azimuth —
  // facing-aware as sealed (context.ts 0.20.5).
  // 0.21.0: aspect-corrected — the horizontal half-angle of a PORTRAIT
  // frame is the sensor's short axis (≈26.9° for the sealed 68.16° wide),
  // not hfov/2; using hfov/2 for x squished off-center suns toward center.
  const { halfX: halfHfov, halfY } = halfFovsForFrame(hfovDeg, aspect);
  const rel = wrap180(pos.azimuthDeg - headingDeg);
  const label = `Sun ${Math.round(pos.elevationDeg)}° up, ${wind}`;
  // 0.21.1: the sealed-input readout rides EVERY branch, not just the
  // ring — the field's clearest bad case rendered "Sun behind the camera"
  // on a centered sun, a branch the ring-only readout would never show.
  const readout = `sealed hdg ${Math.round(headingDeg)}° · rel ${Math.round(rel)}°${rollDeg != null && pitchDeg != null
    ? ` · aim ${aimForFacing(facing, rollDeg, pitchDeg) >= 0 ? 'down' : 'up'} ${round1(Math.abs(aimForFacing(facing, rollDeg, pitchDeg)))}°`
    : ''}`;

  // 0.20.7 (Noah: "dead center shot of the sun — I expect a circle drawn
  // clearly around it"): with the sealed POSE the sun projects into the
  // frame in 2-D — azimuth against half-hfov, elevation against the
  // camera's aim (the same aimForFacing the horizon overlay uses) — and
  // the marker becomes a RING at the sun's actual position, rotated with
  // the sealed roll exactly like the horizon line. A dead-center sun
  // rings dead center. Without a sealed pose (old records) the ring
  // would invent a vertical position, so those keep the top-edge badge.
  if (rollDeg != null && pitchDeg != null && Math.abs(rel) <= halfHfov) {
    const halfVfov = halfY;
    // aim is DOWN-positive (aimForFacing); the sun's elevation is
    // up-positive, so the relative elevation over the camera axis is
    // elevation + aim.
    const dEl = pos.elevationDeg + aimForFacing(facing, rollDeg, pitchDeg);
    if (Math.abs(dEl) <= halfVfov) {
      // In frame: % offsets from center (y down), then the SAME rotation
      // the horizon wrapper applies (CSS rotate about the image center) —
      // a world-fixed point rides the world's apparent rotation.
      // REVIEW-CHECK (front camera): x sign assumes the saved selfie is
      // the sensor's own orientation (unmirrored), same convention as
      // rear; a mirrored save would negate x0. Rear is the field case.
      const x0 = (rel / halfHfov) * 50;
      const y0 = -(dEl / halfVfov) * 50;
      const t = (horizonTiltDeg(rollDeg, pitchDeg) * Math.PI) / 180;
      const x = 50 + x0 * Math.cos(t) - y0 * Math.sin(t);
      const y = 50 + x0 * Math.sin(t) + y0 * Math.cos(t);
      return (
        <View style={StyleSheet.absoluteFill} pointerEvents="none">
          <View style={[styles.sunRingBox, { left: `${x}%` as const, top: `${y}%` as const }]}>
            <View style={styles.sunRingHalo} />
            <View style={styles.sunRing} />
          </View>
          <View style={[styles.sunRingLabel, { left: `${x}%` as const, top: `${y}%` as const }]}>
            <Text style={styles.sunMarkerText}>{label}</Text>
            {/* 0.21.0: the exact sealed inputs behind this projection. The
                field report "accurate dead-center, completely inaccurate
                most others" is invisible to the lab without the bad case's
                numbers — now any wrong ring self-reports them in one
                screenshot. Facts only; they argue nothing. */}
            <Text style={styles.sunRingReadout}>{readout}</Text>
          </View>
        </View>
      );
    }
    // In the azimuth window but out vertically: an edge arrow at the
    // sun's bearing, stating above/below — position honest, never clamped
    // into the frame.
    const above = dEl > halfVfov;
    const xPct = 50 + (rel / halfHfov) * 38;
    return (
      <View style={StyleSheet.absoluteFill} pointerEvents="none">
        <View style={[styles.sunMarker, above ? { top: spacing.sm, left: `${xPct}%` as const, marginLeft: -40 } : { bottom: spacing.sm + 22, left: `${xPct}%` as const, marginLeft: -40 }]}>
          <Ionicons name={above ? 'arrow-up' : 'arrow-down'} size={14} color="#0A0D10" />
          <Text style={styles.sunMarkerText}>{`Sun ${above ? 'above' : 'below'} the frame · ${label}\n${readout}`}</Text>
        </View>
      </View>
    );
  }

  let markerStyle;
  let icon: keyof typeof Ionicons.glyphMap;
  if (Math.abs(rel) <= halfHfov) {
    // In frame (no sealed pose): top edge, positioned by bearing across
    // the half-FOV.
    const xPct = 50 + (rel / halfHfov) * 38;
    markerStyle = { top: spacing.sm, left: `${xPct}%` as const, marginLeft: -40 };
    icon = 'arrow-up';
  } else if (rel > halfHfov && rel <= 145) {
    markerStyle = { right: spacing.sm, top: '44%' as const };
    icon = 'arrow-forward';
  } else if (rel < -halfHfov && rel >= -145) {
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
          {`${Math.abs(rel) > 145 ? 'Sun behind the camera' : label}\n${readout}`}
        </Text>
      </View>
    </View>
  );
}

export function HorizonCard({ rollDeg, pitchDeg, facing, hfovDeg }: { rollDeg: number; pitchDeg: number; facing?: 'front' | 'back' | null; hfovDeg?: number | null }) {
  const styles = useThemedStyles(buildStyles);
  const halfVfov = halfVfovFor(hfovDeg);
  const aim = aimForFacing(facing, rollDeg, pitchDeg);
  const inFrame = horizonInFrame(aim, halfVfov);
  const tilt = horizonTiltDeg(rollDeg, pitchDeg);
  const sealed =
    `Tilt ${round1(Math.abs(tilt))}° · aimed ${aim >= 0 ? 'down' : 'up'} ${round1(Math.abs(aim))}°`;
  return (
    <Card title="Horizon" sub="Where level should sit, from the sealed accelerometer.">
      <View style={styles.hrect}>
        <View style={styles.hrectCrossH} />
        <View style={styles.hrectCrossV} />
        {inFrame ? (
          <>
            {/* Same model as the photo overlay: roll rotates about the rect
                center, pitch translates by the tangent mapping. */}
            <View style={[StyleSheet.absoluteFill, { transform: [{ rotate: `${tilt}deg` }] }]}>
              <View style={[styles.hline, { top: `${horizonTopPct(aim, halfVfov)}%` }]} />
            </View>
            <Text style={[styles.htag, { top: `${Math.min(82, Math.max(2, horizonTopPct(aim, halfVfov) - 13))}%` }]}>
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
 * The condition glyph (0.18.2 — Noah asked for weather-style icons). The
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
        {/* The gnomon's foot on the plane (drawn UNDER the shadow: a short
            midday shadow must stay visible — 0.20.5, Noah's field note
            "at midday there's no shadow even when there should be some";
            the 9 px base used to swallow the ~6 px shadow whole). */}
        <View style={styles.gnomonBase} pointerEvents="none" />
        {/* The shadow: ON the plane, from the gnomon's base toward
            azimuth + 180°, length = ratio × unit before projection. The
            tip dot marks where the gnomon TIP's shadow lands — the actual
            reading point of a sundial, and what keeps a short noon shadow
            legible (clarity reference: tpeach90.github.io/sundials). */}
        <View
          style={[
            styles.shadowLinePersp,
            { width: shadowLen, transform: [{ rotate: `${shadowAng}deg` }] },
          ]}
          pointerEvents="none"
        />
        <View
          style={[
            styles.shadowTip,
            { left: DIAL_CX + sdx - 2.5, top: DIAL_CY + sdy - 2.5 },
          ]}
          pointerEvents="none"
        />
        {/* The gnomon: a short shaded bar rising from the plane's center —
            1 m at the dial's own scale. */}
        <View style={[styles.gnomonBar, { height: gnomonH, top: DIAL_CY - gnomonH }]} pointerEvents="none">
          <View style={styles.gnomonShade} />
        </View>
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
    <Card title="Motion at the shutter" sub="From the sealed motion sensors, at the moment of capture.">
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

const buildStyles = () => StyleSheet.create({
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
  // a second time (0.18.2): still too faint over a bright sky at 7+3 px /
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
  // 0.18.2: top/bottom insets now come inline (∝ the projection magnitude)
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
  // larger type/icon so it holds up over a bright sky (0.18.2 bump).
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
  // 0.20.7: the in-frame sun ring (see SunAzimuthOverlay). The sun's
  // neighborhood is usually the brightest part of the photo, so the dark
  // ring rides a white hairline halo — legible on blown-out sky AND on
  // dark scenes. 70px ≈ 8–9° on a wide frame: about the sealed compass's
  // honest uncertainty, never a pretense of arcminute precision.
  sunRingBox: {
    position: 'absolute', width: 70, height: 70, marginLeft: -35, marginTop: -35,
    alignItems: 'center', justifyContent: 'center',
  },
  sunRingHalo: {
    position: 'absolute', width: 70, height: 70, borderRadius: 35,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.85)',
  },
  sunRing: {
    width: 62, height: 62, borderRadius: 31,
    borderWidth: 2.5, borderColor: '#0A0D10',
  },
  sunRingLabel: {
    position: 'absolute', marginLeft: -60, marginTop: 40, width: 120,
    alignItems: 'center',
    backgroundColor: colors.onDark.accent,
    borderRadius: radii.full,
    paddingHorizontal: 8, paddingVertical: 4,
    borderWidth: 1.5, borderColor: 'rgba(10,13,16,0.60)',
  },
  // 0.21.0: the sealed-input readout under the ring label (see
  // SunAzimuthOverlay) — small, quiet, dark-on-accent like the label.
  sunRingReadout: {
    color: '#0A0D10', fontSize: 8, fontWeight: '600', opacity: 0.72,
    textAlign: 'center', marginTop: 1,
  },
  sunBadge: {
    position: 'absolute', left: spacing.sm, bottom: spacing.sm,
    backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: radii.md,
    paddingHorizontal: spacing.sm, paddingVertical: 4,
  },
  sunBadgeText: { color: '#fff', fontSize: fontSize.xs, fontWeight: '600' },

  // shadows — the perspective sundial (0.18.2): a tilted ground plane
  // (hairline ellipse over a soft fill), N on the far edge, a shaded
  // charcoal gnomon, ONE sage shadow line — and (0.18.3) the clay sun dot
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
  // 0.18.5: the dotted day-track the sun dot rides (same clay, quiet).
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
    // 0.20.5: 9→6 px — the base marks the foot, it must not swallow a
    // short midday shadow.
    position: 'absolute', left: DIAL_CX - 3, top: DIAL_CY - 1.5,
    width: 6, height: 3, borderRadius: 3, backgroundColor: colors.text,
  },
  // The shadow's tip marker — where the gnomon tip's shadow lands (0.20.5).
  shadowTip: {
    position: 'absolute', width: 5, height: 5, borderRadius: 2.5,
    backgroundColor: colors.accent,
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

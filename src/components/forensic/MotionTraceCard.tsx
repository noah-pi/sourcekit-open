// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * MotionTraceCard — the shutter-burst frames next to the sealed gyro trace.
 *
 * What it compares, in plain words: how the PICTURE drifted between the
 * burst frames around the shutter (decoded to 48 px grayscale, consecutive
 * pairs block-matched for whole-frame translation) against how the GYRO
 * says the phone was twisting at that same moment. Two maps, then the
 * sealed claim — never a score: agreement corroborates, disagreement is a
 * fact to weigh, not a verdict. The copy says so on the card.
 *
 * States, honestly: "Not recorded" (burst off or not applicable — neutral),
 * a plainly stated read failure (the frames are no longer on this device,
 * or they could not be decoded — neutral), then the juxtaposition.
 *
 * 0.18.6 post-field viz (Noah: "these values are directional right? we can
 * assess both how much movement but also where" — Option 2, approved): the
 * two per-time bar lanes are replaced by two TRAJECTORY maps at fixed
 * scales, so motion can be compared across exhibits:
 *   • "drift" — the cumulative Σ(dx, dy) path of the frames, in a fixed
 *     ±32 px grid (sage). Direction and distance of the wander, not just
 *     magnitude per pair.
 *   • "twist" — the phone's rotation-rate path, yaw rate (rz) against
 *     pitch rate (ry) per sample, in a fixed ±200 °/s grid (clay).
 *   • roll stays a number (peak °/s) — a third map buys nothing.
 * Dot spacing encodes time (one dot per interval/sample, drawn in capture
 * order, fading in along the path; hollow dot = start, filled dot = end).
 * These are phase maps, not time series, so the old millisecond axis and
 * shutter hairline are gone; the filmstrip still marks the frames in
 * order. Paths clip at the grid edge and the lane label always states the
 * TRUE peak.
 */

import React, { useEffect, useState } from 'react';
import { Text, StyleSheet, View, ScrollView } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import { Image } from 'expo-image';

import { colors, spacing, fontSize, useThemedStyles } from '../../theme';
import type { EvidencePath, MotionSummary, PoseTrace } from '../../provenance/manifest';
import { ForensicCard, NotRecorded } from './ForensicCard';
import { decodeUriToGray, measureFrameShift, toFileUri, type FrameShift } from './grayMatch';
import { base64ToBytes } from '../../lib/bytes';
import { writeFileBytes } from '../../lib/fileHash';
import type { VideoPairFrameRef } from './MultipleLensCard';

/** Cap on decoded burst frames — enough for the shift estimate, bounded cost. */
const MAX_FRAMES = 10;
const GRID_W = 48;
const GRID_H = 36;

// The landed palette's two data colors: sage for the frames, clay for the
// gyro — distinct in both schemes, never verdict colors.
const SERIES_FRAMES = '#809263';
const SERIES_GYRO = '#C08552';

// FIXED map scales — never per-capture normalization. A flatline must LOOK
// flat in every exhibit, or cross-exhibit comparison is a lie of
// presentation (scale rule, carried into the maps). The
// drift grid is ±32 px per axis; the twist grid is ±200 °/s per axis (the
// old gyro lane's full-scale). Paths clip at the grid edge; the lane
// label always states the true peak.
const DRIFT_HALF_PX = 32;
const TWIST_HALF_DPS = 200;
const MAP_HEIGHT = 92;

type MapPoint = { x: number; y: number };

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** The cumulative wander of the frames: start at the origin and add each
 *  interval's signed shift. The widest |point| is how far the framing
 *  actually strayed. */
function driftPathFromShifts(shifts: { dx: number; dy: number }[]): MapPoint[] {
  const pts: MapPoint[] = [{ x: 0, y: 0 }];
  let x = 0;
  let y = 0;
  for (const s of shifts) {
    x += s.dx;
    y += s.dy;
    pts.push({ x, y });
  }
  return pts;
}

/** True peak radius of a path, and whether any point leaves the grid. */
function mapStats(points: MapPoint[], half: number): { peak: number; clipped: boolean } {
  let peak = 0;
  let clipped = false;
  for (const p of points) {
    peak = Math.max(peak, Math.hypot(p.x, p.y));
    if (Math.abs(p.x) > half || Math.abs(p.y) > half) clipped = true;
  }
  return { peak, clipped };
}

/**
 * TrajectoryMap — a phase-space path in a fixed ±half grid, pure Views
 * (no SVG in the dependency tree). Points are in data units, chronological.
 * +x renders right, +y renders DOWN (image coordinates for the drift map;
 * the twist map uses the same screen convention so the two maps read
 * alike). Each consecutive pair is a hairline connector rotated into
 * place; dots ride the vertices when the path is short enough. Time runs
 * hollow → filled, fading in.
 */
function TrajectoryMap({ points, half, color, hint }: {
  points: MapPoint[];
  half: number;
  color: string;
  hint: string;
}) {
  const styles = useThemedStyles(buildStyles);
  const [width, setWidth] = useState(0);
  const px: MapPoint[] = width > 0
    ? points.map((p) => ({
        x: width / 2 + (clamp(p.x, -half, half) / half) * (width / 2 - 6),
        y: MAP_HEIGHT / 2 + (clamp(p.y, -half, half) / half) * (MAP_HEIGHT / 2 - 6),
      }))
    : [];
  return (
    <View style={styles.map} onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
      {px.length > 0 ? (
        <>
          <View style={[styles.mapCross, { left: 0, right: 0, top: MAP_HEIGHT / 2, height: StyleSheet.hairlineWidth }]} />
          <View style={[styles.mapCross, { top: 0, bottom: 0, left: width / 2, width: StyleSheet.hairlineWidth }]} />
          <Text style={styles.mapHint}>{hint}</Text>
          {px.slice(1).map((b, i) => {
            const a = px[i] as MapPoint;
            const len = Math.hypot(b.x - a.x, b.y - a.y);
            if (len < 0.6) return null;
            const angle = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
            const t = (i + 1) / (px.length - 1);
            return (
              <View
                key={`seg${i}`}
                style={[
                  styles.mapSeg,
                  {
                    left: (a.x + b.x) / 2 - len / 2,
                    top: (a.y + b.y) / 2 - 0.5,
                    width: len,
                    backgroundColor: color,
                    opacity: 0.3 + 0.65 * t,
                    transform: [{ rotate: `${angle}deg` }],
                  },
                ]}
              />
            );
          })}
          {px.length <= 60
            ? px.map((p, i) => (
                <View
                  key={`dot${i}`}
                  style={[
                    styles.mapDot,
                    {
                      left: p.x - 1.5,
                      top: p.y - 1.5,
                      backgroundColor: color,
                      opacity: 0.35 + 0.6 * (px.length > 1 ? i / (px.length - 1) : 1),
                    },
                  ]}
                />
              ))
            : null}
          <View style={[styles.mapDotStart, { left: (px[0] as MapPoint).x - 4, top: (px[0] as MapPoint).y - 4, borderColor: color }]} />
          <View style={[styles.mapDotEnd, { left: (px[px.length - 1] as MapPoint).x - 3, top: (px[px.length - 1] as MapPoint).y - 3, backgroundColor: color }]} />
        </>
      ) : null}
    </View>
  );
}

/** One drift lane + one twist lane + the roll line — shared by the stills
 *  and video cards so both surfaces read identically. Lanes degrade
 *  independently: an absent series gets its stated empty message. */
function MotionLanes({ drift, driftMsg, twist, twistMsg, rollPeakDps }: {
  drift: MapPoint[] | null;
  driftMsg: string;
  twist: MapPoint[] | null;
  twistMsg: string;
  rollPeakDps: number | null;
}) {
  const styles = useThemedStyles(buildStyles);
  const driftStats = drift ? mapStats(drift, DRIFT_HALF_PX) : null;
  const twistStats = twist ? mapStats(twist, TWIST_HALF_DPS) : null;
  return (
    <View style={styles.mapWrap}>
      <View style={styles.laneLabels}>
        <Text style={styles.laneName}>{`Picture drift · px (±${DRIFT_HALF_PX})`}</Text>
        <Text style={styles.lanePeak}>
          {driftStats
            ? `peak ${(Math.round(driftStats.peak * 10) / 10).toFixed(1)} px${driftStats.clipped ? ' · clipped' : ''}`
            : '—'}
        </Text>
      </View>
      {drift ? (
        <TrajectoryMap points={drift} half={DRIFT_HALF_PX} color={SERIES_FRAMES} hint="±32 px · dot spacing = time" />
      ) : (
        <Text style={styles.dim}>{driftMsg}</Text>
      )}
      <View style={[styles.laneLabels, styles.laneLabelsSecond]}>
        <Text style={styles.laneName}>{`Phone twist · °/s (±${TWIST_HALF_DPS})`}</Text>
        <Text style={styles.lanePeak}>
          {twistStats
            ? `peak ${Math.round(twistStats.peak)}°/s${twistStats.clipped ? ' · clipped' : ''}`
            : '—'}
        </Text>
      </View>
      {twist ? (
        <TrajectoryMap points={twist} half={TWIST_HALF_DPS} color={SERIES_GYRO} hint="yaw → · pitch ↓ · ±200 °/s" />
      ) : (
        <Text style={styles.dim}>{twistMsg}</Text>
      )}
      <View style={[styles.laneLabels, styles.laneLabelsSecond]}>
        <Text style={styles.laneName}>Roll</Text>
        <Text style={styles.lanePeak}>
          {rollPeakDps !== null ? `peak ${Math.round(rollPeakDps)}°/s` : 'not recorded'}
        </Text>
      </View>
      <View style={styles.legend}>
        <View style={[styles.legendDot, { backgroundColor: SERIES_FRAMES }]} />
        <Text style={styles.legendText}>picture drift</Text>
        {twist ? (
          <>
            <View style={[styles.legendDot, { backgroundColor: SERIES_GYRO }]} />
            <Text style={styles.legendText}>phone twist</Text>
          </>
        ) : null}
      </View>
    </View>
  );
}

/** The twist path from a sealed pose trace: yaw rate (rz) against pitch
 *  rate (ry) per sample, °/s, over the window bracketing the shutter
 *  (anchor ± the frame-interval count, the old chart's window). Roll
 *  (rx) is tracked as a peak number only. rotRate is xyz-interleaved
 *  millirad/s; the sampler maps x=gamma→roll, y=beta→pitch, z=alpha→yaw. */
function twistFromPose(trace: PoseTrace, intervals: number): { pts: MapPoint[]; rollPeakDps: number } | null {
  if (trace.samples < 3) return null;
  const n = Math.max(1, intervals);
  const lo = Math.max(0, trace.anchor - n);
  const hi = Math.min(trace.samples - 1, trace.anchor + n);
  const pts: MapPoint[] = [];
  let rollPeakDps = 0;
  for (let i = lo; i <= hi; i++) {
    const j = i * 3;
    const roll = ((trace.rotRate[j] ?? 0) / 1000) * (180 / Math.PI);
    const pitch = ((trace.rotRate[j + 1] ?? 0) / 1000) * (180 / Math.PI);
    const yaw = ((trace.rotRate[j + 2] ?? 0) / 1000) * (180 / Math.PI);
    pts.push({ x: yaw, y: pitch });
    rollPeakDps = Math.max(rollPeakDps, Math.abs(roll));
  }
  return pts.length > 0 ? { pts, rollPeakDps } : null;
}

// ---------------------------------------------------------------------------
// stills — sealed ring buffer + pose trace
// ---------------------------------------------------------------------------

type TraceState =
  | { state: 'reading' }
  | {
      state: 'done';
      /** Signed per-interval frame shifts — the drift map's segments. */
      shiftsXY: { dx: number; dy: number }[];
      /** Distinct primary capture timestamps across the committed frames,
       *  from the ring's own index — null when the index is absent or
 * unreadable. Fewer than `committed` means the retained
       *  frames did not advance: the flatline is a stated fact, not a
       *  "no motion" reading. */
      distinctTimestamps: number | null;
      committed: number | null;
      /** Unique 8×8 luma dHash values across the committed frames, from the
       *  ring's own index — null when the index carries no hashes (a
       *  pre-0.18.6 ring) or is unreadable. The pixel-distinctness fact
 * Noah asked for, stated from committed data. */
      distinctHashes: number | null;
      hashedFrames: number | null;
      /** The burst frame file URIs in capture order — the filmstrip
       *  surface (0.18.5 post-field, Noah: "I don't see any burst
       *  images"). The same frames the shift estimate measured. */
      frameUris: string[];
    }
  | { state: 'unavailable'; reason: string };

export function MotionTraceCard({ ringBufferDir, poseTrace, motion }: {
  /** The sealed three-state ring-buffer path (record.context.captureEvidence). */
  ringBufferDir: EvidencePath | undefined;
  /** The sealed gyro trace around the shutter, when the record carries one. */
  poseTrace?: PoseTrace | null;
  /** The sealed motion summary claim, when the record carries one. */
  motion?: MotionSummary | null;
}) {
  const styles = useThemedStyles(buildStyles);
  const [trace, setTrace] = useState<TraceState>({ state: 'reading' });

  const recorded = typeof ringBufferDir === 'string' && ringBufferDir !== 'never-recorded';

  useEffect(() => {
    let cancelled = false;
    if (!recorded) return;
    setTrace({ state: 'reading' });
    (async () => {
      try {
        const dir = toFileUri(ringBufferDir as string).replace(/\/$/, '');
        const dirNames = await FileSystem.readDirectoryAsync(dir);
        // PRIMARY frames only. Sorted, the -secondary.jpg files interleave
        // with the primaries, so consecutive "pairs" would measure
        // cross-CAMERA jumps as frame motion (the two lenses see different
        // views).
        const names = dirNames
          .filter((n) => /-primary\.jpe?g$/i.test(n))
          .sort()
          .slice(0, MAX_FRAMES);
        if (names.length < 2) throw new Error('fewer than two burst frames on this device');
        // The ring index (written at commit, same dir) carries each frame's
        // capture timestamp. When the committed frames share timestamps —
        // a starved pipeline redelivering one buffer — that fact is stated
        // beside the measurement. Best-effort: an absent/unreadable index
        // changes nothing else.
        let distinctTimestamps: number | null = null;
        let committed: number | null = null;
        let distinctHashes: number | null = null;
        let hashedFrames: number | null = null;
        try {
          const indexName = dirNames.find((n) => /\.json$/i.test(n));
          if (indexName) {
            const doc = JSON.parse(await FileSystem.readAsStringAsync(`${dir}/${indexName}`)) as {
              frames?: { primaryHostSeconds?: unknown; primaryDHash64?: unknown }[];
            };
            const pts = (doc.frames ?? [])
              .map((f) => f?.primaryHostSeconds)
              .filter((v): v is number => typeof v === 'number');
            if (pts.length > 0) {
              distinctTimestamps = new Set(pts).size;
              committed = pts.length;
            }
            // The committed per-frame dHashes — pixel distinctness
            // stated from the ring's own index, never inferred.
            const hashes = (doc.frames ?? [])
              .map((f) => f?.primaryDHash64)
              .filter((v): v is string => typeof v === 'string');
            if (hashes.length > 0) {
              distinctHashes = new Set(hashes).size;
              hashedFrames = hashes.length;
            }
          }
        } catch {
          /* the index is a courtesy to the reader; the JPEGs still measure */
        }
        const shifts: FrameShift[] = [];
        let prev = await decodeUriToGray(`${dir}/${names[0]}`, GRID_W, GRID_H);
        for (let i = 1; i < names.length; i++) {
          const next = await decodeUriToGray(`${dir}/${names[i]}`, GRID_W, GRID_H);
          shifts.push(measureFrameShift(prev, next));
          prev = next;
        }
        if (!cancelled) {
          setTrace({ state: 'done', shiftsXY: shifts.map((s) => ({ dx: s.dx, dy: s.dy })), distinctTimestamps, committed, distinctHashes, hashedFrames, frameUris: names.map((name) => `${dir}/${name}`) });
        }
      } catch (e) {
        if (!cancelled) {
          setTrace({
            state: 'unavailable',
            reason: e instanceof Error && /fewer than two/.test(e.message)
              ? 'fewer than two burst frames remain on this device'
              : 'the burst frames could not be read on this device',
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [recorded, ringBufferDir]);

  const twist = poseTrace && trace.state === 'done'
    ? twistFromPose(poseTrace, trace.shiftsXY.length)
    : null;

  return (
    <ForensicCard
      title="Motion Trace"
      sub="How the picture drifted between the frames around the shutter, next to how the gyro says the phone was twisting at that same moment."
    >
      {ringBufferDir === null ? (
        <Text style={styles.line}>Enabled but failed at capture; the record commits the failure.</Text>
      ) : !recorded ? (
        <NotRecorded />
      ) : trace.state === 'reading' ? (
        <Text style={styles.line}>Reading the burst frames…</Text>
      ) : trace.state === 'unavailable' ? (
        <Text style={styles.line}>{`Frames recorded at capture: ${trace.reason}.`}</Text>
      ) : (
        <View style={styles.juxta}>
          {/* 0.18.5 post-field (Noah: "I don't see any burst images in the
              pose data"): the measured frames themselves, in capture order
              — the analysis below reads these exact JPEGs. */}
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.stripScroll}>
            {trace.frameUris.map((uri, i) => (
              <View key={uri} style={styles.stripItem}>
                <Image source={{ uri }} style={styles.stripImage} contentFit="cover" recyclingKey={uri} />
                <Text style={styles.stripLabel}>{`frame ${i + 1}`}</Text>
              </View>
            ))}
          </ScrollView>
          <MotionLanes
            drift={driftPathFromShifts(trace.shiftsXY)}
            driftMsg="No burst frames readable on this device."
            twist={twist ? twist.pts : null}
            twistMsg="No gyro trace sealed with this capture, so the twist map stands empty."
            rollPeakDps={twist ? twist.rollPeakDps : null}
          />
          {/* 0.18.6 post-field (Noah: "the copy frames…gyro peak at the
              bottom is redundant and can be cut"): the lane labels state
              the true peaks — the old bottom summary line is gone. The
              evidentiary fact lines below stay. */}
          {/* When the committed frames carry fewer distinct capture
              timestamps than frames, the pipeline retained the same frame
              repeatedly — the fact is stated from the ring's own index, so
              a flatline never reads as "no motion" on its own. */}
          {trace.distinctTimestamps !== null && trace.committed !== null && trace.distinctTimestamps < trace.committed ? (
            <Text style={styles.line}>
              {`The ${trace.committed} committed frames carry ${trace.distinctTimestamps} distinct capture timestamp${trace.distinctTimestamps === 1 ? '' : 's'} — the retained frames did not advance during this capture.`}
            </Text>
          ) : null}
          {/* 0.18.6 (Noah: "pixel for pixel… no pixel movement ever
              registered"): the frames' own committed hashes state the
              distinctness — a number, from the ring index, never an
              inference. Identical frames read as 1 unique; a real serial
              burst reads as all-unique. */}
          {trace.distinctHashes !== null && trace.hashedFrames !== null ? (
            <Text style={styles.line}>
              {`Pixel distinctness: ${trace.distinctHashes} unique frame hash${trace.distinctHashes === 1 ? '' : 'es'} across ${trace.hashedFrames} committed frame${trace.hashedFrames === 1 ? '' : 's'} (8×8 luma dHash).`}
            </Text>
          ) : null}
          {/* Juxtapose, never conclude: still pixels against fast rotation
              (or the reverse) is a fact on display — the weighing is the
              reader's, this card never scores it. */}
          {motion ? (
            <Text style={styles.dim}>
              {`Sealed motion claim: ${
                motion.verdict === 'handheld'
                  ? 'handheld motion'
                  : motion.verdict === 'steady'
                    ? 'device still'
                    : motion.verdict === 'moving'
                      ? 'device moving'
                      : 'insufficient data'
              } · ${motion.peakHz} Hz peak`}
            </Text>
          ) : null}
        </View>
      )}
    </ForensicCard>
  );
}

// ---------------------------------------------------------------------------
// Video motion trace (0.18.6 — Noah: "it seems weird that we're not doing
// pose trace for video too! that's where it'd probably be most effective")
// ---------------------------------------------------------------------------

/** One gyro instant from the sealed sensor JSONL, take-relative. */
interface GyroPoint {
  /** Seconds after the take's start (the window line's requestedStart). */
  off: number;
  /** Rotation-rate magnitude, degrees/second. */
  dps: number;
  /** Per-axis rates, degrees/second — z=yaw, y=pitch, x=roll (the
   *  sampler's alpha/beta/gamma mapping). 0.18.6 post-field: the twist
   *  map needs the axes, not just the magnitude. */
  yawDps: number;
  pitchDps: number;
  rollDps: number;
}

/** Parse the sealed video sensor JSONL into take-relative gyro instants.
    Pure (string in, points out) so the lab runs the exact shipped code.

    0.18.6 field fix: pre-fix field files wrote the FLUSH instant as the
    anchor's bootSecAtAnchor (the take's END), which re-zeroed every sample
    to a negative offset and pushed the whole gyro lane off-card. The window
    line's requestedStart is the take start on the same boot clock in BOTH
    formats, so it is the base; the anchor line (written as the take start
    from 0.18.6 on) is the fallback, then the first sample. Returns null
    when the log carries no usable gyro samples. */
export function parseVideoGyroLog(raw: string): { gyro: GyroPoint[]; bootBase: number } | null {
  let anchorBoot: number | null = null;
  let windowStart: number | null = null;
  const pts: { t: number; dps: number; yawDps: number; pitchDps: number; rollDps: number }[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let rec: { kind?: unknown; t?: unknown; x?: unknown; y?: unknown; z?: unknown; bootSecAtAnchor?: unknown; requestedStart?: unknown };
    try { rec = JSON.parse(trimmed); } catch { continue; }
    if (rec.kind === 'anchor' && typeof rec.bootSecAtAnchor === 'number') {
      anchorBoot = rec.bootSecAtAnchor;
    } else if (rec.kind === 'window' && typeof rec.requestedStart === 'number') {
      windowStart = rec.requestedStart;
    } else if (
      rec.kind === 'gyro' && typeof rec.t === 'number' &&
      typeof rec.x === 'number' && typeof rec.y === 'number' && typeof rec.z === 'number'
    ) {
      pts.push({
        t: rec.t,
        dps: Math.hypot(rec.x, rec.y, rec.z) * (180 / Math.PI),
        yawDps: rec.z * (180 / Math.PI),
        pitchDps: rec.y * (180 / Math.PI),
        rollDps: rec.x * (180 / Math.PI),
      });
    }
  }
  const bootBase = windowStart ?? anchorBoot ?? (pts.length > 0 ? pts[0].t : null);
  if (bootBase === null || pts.length === 0) return null;
  return {
    gyro: pts.map((p) => ({ off: p.t - (bootBase as number), dps: p.dps, yawDps: p.yawDps, pitchDps: p.pitchDps, rollDps: p.rollDps })),
    bootBase,
  };
}

type VideoTraceState =
  | { state: 'reading' }
  | {
      state: 'done';
      /** Drift map: signed consecutive-pair shifts across the take. */
      shiftsXY: { dx: number; dy: number }[] | null;
      /** Twist map: bucketed yaw/pitch means over the take window, null
       *  when no sensor log was sealed/readable. */
      twist: MapPoint[] | null;
      rollPeakDps: number | null;
    }
  | { state: 'unavailable'; reason: string };

/** Cap on decoded pair frames — the take's pair cadence keeps this ≤ ~30
 *  in practice; the cap is stated when it bites. */
const MAX_VIDEO_TRACE_FRAMES = 48;
/** Display buckets for the twist map (a 60 s take logs ~6,000 samples). */
const GYRO_BUCKETS = 120;

/**
 * VideoMotionCard — the motion trace of a VIDEO take. A video
 * take has no shutter burst; its serial photography is the committed
 * second-camera pair frames across the take, and its pose trace is the
 * sealed sensor JSONL's gyro stream. Same juxtaposition discipline as the
 * stills card, same trajectory maps: the picture's
 * cumulative drift against the phone's yaw/pitch twist path on fixed
 * scales, numbers only — the weighing is the reader's.
 *
 * Lanes degrade independently and honestly: no second-camera frames
 * (Multiple lenses off) → the drift map states its absence; no sensor
 * log → the twist map states its absence. Both absent → "Not recorded".
 */
export function VideoMotionCard({ videoFrames, sensorLogPath }: {
  /** The take's committed second-camera frames in pair order (the card's
      own derivation — record.videoStereo via secondaryFrameFor). */
  videoFrames: VideoPairFrameRef[] | null;
  /** The sealed three-state sensor-log path (record.context.captureEvidence). */
  sensorLogPath: EvidencePath | undefined;
}) {
  const styles = useThemedStyles(buildStyles);
  const [trace, setTrace] = useState<VideoTraceState>({ state: 'reading' });

  const hasFrames = (videoFrames?.length ?? 0) >= 2;
  const logRecorded = typeof sensorLogPath === 'string' && sensorLogPath !== 'never-recorded';
  const anything = hasFrames || logRecorded;

  useEffect(() => {
    let cancelled = false;
    if (!anything) return;
    setTrace({ state: 'reading' });
    (async () => {
      try {
        // --- Twist map: the sealed sensor JSONL (the take's own log —
        // anchor line binds the boot clock to the recording start).
        let gyro: GyroPoint[] | null = null;
        if (logRecorded) {
          try {
            const raw = await FileSystem.readAsStringAsync(toFileUri(sensorLogPath as string));
            const parsed = parseVideoGyroLog(raw);
            if (parsed) {
              gyro = parsed.gyro;
            }
          } catch {
            // The log path points at the capture device — on any other
            // device (an exported file in Inspect) it is simply absent.
            // The lane states its absence; the drift map still renders.
            gyro = null;
          }
        }

        // --- Drift map: consecutive committed pair frames, same camera
        // across time — decoded 48×36 grayscale, block-matched like the
        // stills burst, signed (dx, dy) per interval.
        let shiftsXY: { dx: number; dy: number }[] | null = null;
        if (hasFrames && videoFrames) {
          const capped = videoFrames.slice(0, MAX_VIDEO_TRACE_FRAMES);
          const uris: string[] = [];
          for (const f of capped) {
            const key = (f.frame.sha256?.slice(0, 16)
              ?? `${f.frame.dataBase64.length}-${f.frame.dataBase64.slice(0, 24)}`)
              .replace(/[^A-Za-z0-9-]/g, '');
            const path = `${FileSystem.cacheDirectory}motion-video-pair-${key}.jpg`;
            await writeFileBytes(path, base64ToBytes(f.frame.dataBase64));
            uris.push(path);
          }
          const out: { dx: number; dy: number }[] = [];
          let prev = await decodeUriToGray(uris[0], GRID_W, GRID_H);
          for (let i = 1; i < uris.length; i++) {
            const next = await decodeUriToGray(uris[i], GRID_W, GRID_H);
            const s = measureFrameShift(prev, next);
            out.push({ dx: s.dx, dy: s.dy });
            prev = next;
          }
          shiftsXY = out;
        }

        if (!gyro && !shiftsXY) {
          throw new Error('neither the sensor log nor the pair frames could be read');
        }

        // Twist path: bucket the raw stream (~100 Hz) down to GYRO_BUCKETS
        // display points; each bucket is the MEAN yaw/pitch rate over its
        // slice (the map wants the representative direction, not the
        // loudest instant). Empty buckets are skipped — a gap in the
        // stream must not drag the path to the origin.
        let twist: MapPoint[] | null = null;
        let rollPeakDps: number | null = null;
        if (gyro && gyro.length > 0) {
          const windowSec = Math.max(gyro[gyro.length - 1].off, 0.001);
          const pts: MapPoint[] = [];
          for (let b = 0; b < GYRO_BUCKETS; b++) {
            const from = (b / GYRO_BUCKETS) * windowSec;
            const to = ((b + 1) / GYRO_BUCKETS) * windowSec;
            let yawSum = 0;
            let pitchSum = 0;
            let n = 0;
            for (const p of gyro) {
              if (p.off >= from && p.off < to) { yawSum += p.yawDps; pitchSum += p.pitchDps; n++; }
            }
            if (n > 0) pts.push({ x: yawSum / n, y: pitchSum / n });
          }
          twist = pts.length > 0 ? pts : null;
          rollPeakDps = gyro.reduce((m, p) => Math.max(m, Math.abs(p.rollDps)), 0);
        }

        if (!cancelled) {
          setTrace({ state: 'done', shiftsXY, twist, rollPeakDps });
        }
      } catch {
        if (!cancelled) {
          setTrace({ state: 'unavailable', reason: 'the take\'s motion data could not be read on this device' });
        }
      }
    })();
    return () => { cancelled = true; };
  }, [anything, logRecorded, sensorLogPath, videoFrames, hasFrames]);

  return (
    <ForensicCard
      title="Motion Trace"
      sub="How the picture drifted between the take's second-camera frames, next to how the gyro says the phone was twisting at those moments."
    >
      {!anything ? (
        <NotRecorded />
      ) : trace.state === 'reading' ? (
        <Text style={styles.line}>Reading the take's motion data…</Text>
      ) : trace.state === 'unavailable' ? (
        <Text style={styles.line}>{`Recorded at capture: ${trace.reason}.`}</Text>
      ) : (
        <View style={styles.juxta}>
          <MotionLanes
            drift={trace.shiftsXY ? driftPathFromShifts(trace.shiftsXY) : null}
            driftMsg="No second-camera frames sealed with this take, so the drift map stands empty."
            twist={trace.twist}
            twistMsg="No gyro trace readable from this file, so the twist map stands empty."
            rollPeakDps={trace.rollPeakDps}
          />
          {/* 0.18.6 (Noah: "the copy frames…gyro peak at the bottom is
              redundant and can be cut"): the lane labels state the true
              peaks — no bottom copy line. */}
        </View>
      )}
    </ForensicCard>
  );
}

const buildStyles = () => StyleSheet.create({
  line: { color: colors.text, fontSize: fontSize.sm, lineHeight: 19, marginTop: spacing.xs + 2 },
  dim: { color: colors.textDim, fontSize: fontSize.xs, lineHeight: 17, marginTop: spacing.xs },
  juxta: { marginTop: spacing.xs },
  stripScroll: { marginTop: spacing.xs, marginBottom: 2 },
  stripItem: { width: 86, marginRight: spacing.xs },
  stripImage: {
    width: 86,
    height: 64,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: '#101013',
  },
  stripLabel: { color: colors.textFaint, fontSize: 9.5, marginTop: 2, textAlign: 'center' },
  // The trajectory maps (0.18.6 post-field — Option 2 replaces the 0.18.3
  // dual bar lanes): two phase-space maps at fixed scales + the roll line.
  mapWrap: { marginTop: spacing.sm },
  laneLabels: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline',
    marginBottom: 5,
  },
  laneLabelsSecond: { marginTop: 14 },
  laneName: { color: colors.textFaint, fontSize: fontSize.xs, letterSpacing: 0.2 },
  lanePeak: { color: colors.textFaint, fontSize: fontSize.xs, fontVariant: ['tabular-nums'] },
  map: {
    height: MAP_HEIGHT,
    borderRadius: 8,
    backgroundColor: '#101013',
    overflow: 'hidden',
    position: 'relative',
  },
  mapCross: {
    position: 'absolute',
    backgroundColor: '#26262b',
  },
  mapSeg: {
    position: 'absolute',
    height: 1,
    borderRadius: 0.5,
  },
  mapDot: {
    position: 'absolute',
    width: 3,
    height: 3,
    borderRadius: 1.5,
  },
  mapDotStart: {
    position: 'absolute',
    width: 8,
    height: 8,
    borderRadius: 4,
    borderWidth: 1.5,
    backgroundColor: 'transparent',
  },
  mapDotEnd: {
    position: 'absolute',
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  mapHint: {
    position: 'absolute',
    top: 4,
    left: 6,
    color: colors.textFaint,
    fontSize: 9,
  },
  legend: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 8 },
  legendDot: { width: 6, height: 6, borderRadius: 3 },
  legendText: { color: colors.textFaint, fontSize: fontSize.xs, marginRight: spacing.sm },
});

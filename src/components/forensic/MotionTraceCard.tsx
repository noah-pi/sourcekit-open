// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * MotionTraceCard — the shutter-burst frames next to the sealed gyro trace.
 *
 * What it compares, in plain words: how much the PICTURE moved between the
 * burst frames around the shutter (decoded to 48 px grayscale, consecutive
 * pairs block-matched for whole-frame translation) against how fast the
 * GYRO says the phone was rotating at that same moment. Two short lines,
 * then the sealed claim — never a score: agreement corroborates,
 * disagreement is a fact to weigh, not a verdict (0.18.2 — Noah didn't
 * understand what the card was doing; the copy now says it plainly).
 *
 * States, honestly: "Not recorded" (burst off or not applicable — neutral),
 * a plainly stated read failure (the frames are no longer on this device,
 * or they could not be decoded — neutral), then the juxtaposition.
 */

import React, { useEffect, useState } from 'react';
import { Text, StyleSheet, View } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';

import { colors, spacing, fontSize, useThemedStyles } from '../../theme';
import type { EvidencePath, MotionSummary, PoseTrace } from '../../provenance/manifest';
import { ForensicCard, NotRecorded } from './ForensicCard';
import { decodeUriToGray, measureFrameShift, toFileUri, type FrameShift } from './grayMatch';

/** Cap on decoded burst frames — enough for the shift estimate, bounded cost. */
const MAX_FRAMES = 10;
const GRID_W = 48;
const GRID_H = 36;

type TraceState =
  | { state: 'reading' }
  | {
      state: 'done';
      pairs: number;
      meanShift: number;
      meanDx: number;
      meanDy: number;
      mags: number[];
      /** Distinct primary capture timestamps across the committed frames,
       *  from the ring's own index — null when the index is absent or
       *  unreadable. Fewer than `committed` means the retained
       *  frames did not advance: the flatline is a stated fact, not a
       *  "no motion" reading. */
      distinctTimestamps: number | null;
      committed: number | null;
    }
  | { state: 'unavailable'; reason: string };

/** Mean rotation-rate magnitude (°/s) over the samples bracketing the shutter. */
function shutterRotationDps(trace: PoseTrace): number {
  const half = 3; // samples either side of the anchor
  const lo = Math.max(0, trace.anchor - half);
  const hi = Math.min(trace.samples - 1, trace.anchor + half);
  let sum = 0;
  let n = 0;
  for (let i = lo; i <= hi; i++) {
    const j = i * 3;
    const mrad = Math.hypot(trace.rotRate[j] ?? 0, trace.rotRate[j + 1] ?? 0, trace.rotRate[j + 2] ?? 0);
    sum += (mrad / 1000) * (180 / Math.PI);
    n++;
  }
  return n > 0 ? sum / n : 0;
}

function directionWord(dx: number, dy: number): string {
  if (Math.abs(dx) < 0.25 && Math.abs(dy) < 0.25) return 'no consistent direction';
  if (Math.abs(dx) >= Math.abs(dy)) return dx > 0 ? 'toward the right' : 'toward the left';
  return dy > 0 ? 'downward' : 'upward';
}

// The landed palette's two data colors: sage for the frames, clay for the
// gyro — distinct in both schemes, never verdict colors.
const SERIES_FRAMES = '#809263';
const SERIES_GYRO = '#C08552';

// FIXED scales — never per-capture peaks. A flatline must LOOK flat in every
// exhibit, or cross-exhibit comparison is a lie of presentation: 8 px per
// frame fills the picture lane, 200°/s fills the gyro lane. Bars beyond the
// scale clip at full height; the peak label always states the true value.
// (0.18.3 redesign — the per-lane "own peak" normalization made a 0.4 px
// flatline fill the lane exactly like a 6.2 px jolt.)
const FRAMES_FULL_DPS = 8;   // px per frame
const GYRO_FULL_DPS = 200;   // degrees per second

/**
 * TraceChart (0.18.3 — Noah: the overlay was unreadable; redesign approved
 * from the mockup). TWO lanes, ONE time axis, shutter-centered: the picture
 * lane shows frame-to-frame pixel shift (one sage bar per interval), the
 * gyro lane shows the sealed pose trace's rotation rate resampled into the
 * same window (one clay bar per frame instant). A hairline marks the shutter
 * across both lanes; the axis reads in milliseconds off the signed sample
 * grid (sample i sits at (i − anchor) × 1000/hz ms — the format pins it).
 * Lane labels carry unit + scale; the right side carries the true peak.
 * No interpretive copy — the juxtaposition is the content. Pure Views.
 */
function TraceChart({ frameMags, poseTrace }: { frameMags: number[]; poseTrace?: PoseTrace | null }) {
  const styles = useThemedStyles(buildStyles);
  const n = frameMags.length;
  const instants = n + 1;

  // The gyro window: 2n+1 samples centered on the anchor (clamped to the
  // trace), bucket-averaged down to the n+1 frame instants.
  let gyro: number[] | null = null;
  let shutterPct: number | null = null;
  let axisTicks: { pct: number; label: string; shutter: boolean }[] | null = null;
  if (poseTrace && poseTrace.samples >= 3) {
    const lo = Math.max(0, poseTrace.anchor - n);
    const hi = Math.min(poseTrace.samples - 1, poseTrace.anchor + n);
    const mags: number[] = [];
    for (let i = lo; i <= hi; i++) {
      const j = i * 3;
      mags.push((Math.hypot(poseTrace.rotRate[j] ?? 0, poseTrace.rotRate[j + 1] ?? 0, poseTrace.rotRate[j + 2] ?? 0) / 1000) * (180 / Math.PI));
    }
    gyro = Array.from({ length: instants }, (_, b) => {
      const from = Math.floor((b / instants) * mags.length);
      const to = Math.max(from + 1, Math.floor(((b + 1) / instants) * mags.length));
      let sum = 0;
      for (let k = from; k < to; k++) sum += mags[k] ?? 0;
      return sum / (to - from);
    });
    shutterPct = ((poseTrace.anchor - lo + 0.5) / mags.length) * 100;
    const msPerSample = 1000 / poseTrace.hz;
    const pctPerMs = 100 / (mags.length * msPerSample);
    const leftMs = Math.round((poseTrace.anchor - lo) * msPerSample);
    const rightMs = Math.round((hi - poseTrace.anchor) * msPerSample);
    const tick = (ms: number, label: string, shutter: boolean) => ({
      // clamped so edge labels stay inside the card
      pct: Math.min(92, Math.max(8, (shutterPct as number) + ms * pctPerMs)),
      label,
      shutter,
    });
    axisTicks = [
      tick(-leftMs, `−${leftMs} ms`, false),
      tick(-leftMs / 2, `−${Math.round(leftMs / 2)} ms`, false),
      tick(0, 'shutter', true),
      tick(rightMs / 2, `+${Math.round(rightMs / 2)} ms`, false),
      tick(rightMs, `+${rightMs} ms`, false),
    ];
  }

  const peakFrames = Math.round(Math.max(...frameMags, 0) * 10) / 10;
  const peakGyro = gyro ? Math.round(Math.max(...gyro, 0)) : null;
  const frameBarH = (v: number) => Math.min(100, Math.max(3, (v / FRAMES_FULL_DPS) * 100));
  const gyroBarH = (v: number) => Math.min(100, Math.max(3, (v / GYRO_FULL_DPS) * 100));

  return (
    <View style={styles.chartWrap}>
      <View style={styles.laneLabels}>
        <Text style={styles.laneName}>{`Picture · px per frame (0–${FRAMES_FULL_DPS})`}</Text>
        <Text style={styles.lanePeak}>{`peak ${peakFrames} px`}</Text>
      </View>
      <View style={styles.lane}>
        {frameMags.map((v, i) => (
          <View
            key={`f${i}`}
            style={[
              styles.chartBarFrames,
              {
                left: `${(((i + 0.5) / instants) * 100 - 26 / instants)}%`,
                width: `${(52 / instants)}%`,
                height: `${frameBarH(v)}%`,
              },
            ]}
          />
        ))}
        <View style={styles.chartBaseline} />
        {shutterPct !== null ? <View style={[styles.chartShutter, { left: `${shutterPct}%` }]} /> : null}
      </View>
      {gyro ? (
        <>
          <View style={[styles.laneLabels, styles.laneLabelsSecond]}>
            <Text style={styles.laneName}>{`Gyro · °/s (0–${GYRO_FULL_DPS})`}</Text>
            <Text style={styles.lanePeak}>{`peak ${peakGyro}°/s`}</Text>
          </View>
          <View style={styles.lane}>
            {gyro.map((v, b) => (
              <View
                key={`g${b}`}
                style={[
                  styles.chartBarGyro,
                  { left: `${(b / instants) * 100}%`, height: `${gyroBarH(v)}%` },
                ]}
              />
            ))}
            <View style={styles.chartBaseline} />
            {shutterPct !== null ? <View style={[styles.chartShutter, { left: `${shutterPct}%` }]} /> : null}
          </View>
          {axisTicks ? (
            <View style={styles.axis}>
              {axisTicks.map((t) => (
                <Text
                  key={t.label}
                  style={[styles.axisTick, t.shutter ? styles.axisTickShutter : null, { left: `${t.pct}%` }]}
                >
                  {t.label}
                </Text>
              ))}
            </View>
          ) : null}
        </>
      ) : null}
      <View style={styles.legend}>
        <View style={[styles.legendDot, { backgroundColor: SERIES_FRAMES }]} />
        <Text style={styles.legendText}>frames · px per frame</Text>
        {gyro ? (
          <>
            <View style={[styles.legendDot, { backgroundColor: SERIES_GYRO }]} />
            <Text style={styles.legendText}>gyro · °/s</Text>
          </>
        ) : null}
      </View>
      {!gyro ? (
        <Text style={styles.dim}>No gyro trace sealed with this capture, so the frames series stands alone.</Text>
      ) : null}
    </View>
  );
}

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
        // PRIMARY frames only. The glob used to take every JPEG in
        // the ring dir — sorted, the -secondary.jpg files interleave with
        // the primaries, and consecutive "pairs" then measured cross-CAMERA
        // jumps as frame motion (the two lenses see different views).
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
        try {
          const indexName = dirNames.find((n) => /\.json$/i.test(n));
          if (indexName) {
            const doc = JSON.parse(await FileSystem.readAsStringAsync(`${dir}/${indexName}`)) as {
              frames?: { primaryHostSeconds?: unknown }[];
            };
            const pts = (doc.frames ?? [])
              .map((f) => f?.primaryHostSeconds)
              .filter((v): v is number => typeof v === 'number');
            if (pts.length > 0) {
              distinctTimestamps = new Set(pts).size;
              committed = pts.length;
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
        const n = shifts.length;
        const meanDx = shifts.reduce((s, x) => s + x.dx, 0) / n;
        const meanDy = shifts.reduce((s, x) => s + x.dy, 0) / n;
        const meanShift = shifts.reduce((s, x) => s + Math.hypot(x.dx, x.dy), 0) / n;
        if (!cancelled) {
          setTrace({ state: 'done', pairs: n, meanShift, meanDx, meanDy, mags: shifts.map((x) => Math.hypot(x.dx, x.dy)), distinctTimestamps, committed });
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

  const round1 = (v: number) => Math.round(v * 10) / 10;
  const dps = poseTrace ? shutterRotationDps(poseTrace) : null;

  return (
    <ForensicCard
      title="Motion Trace"
      sub="How much the picture moved between the frames around the shutter, next to how fast the gyro says the phone was rotating at that same moment."
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
          <TraceChart frameMags={trace.mags} poseTrace={poseTrace} />
          <Text style={styles.line}>
            {`Frames: ${round1(trace.meanShift)} px per frame, ${directionWord(trace.meanDx, trace.meanDy)} (${trace.pairs} pairs) · Gyro: ${dps !== null ? `${Math.round(dps)}°/s at the shutter` : 'no trace sealed'}.`}
          </Text>
          {/* 0.18.4: when the committed frames carry fewer distinct capture
              timestamps than frames, the pipeline retained the same frame
              repeatedly — the fact is stated from the ring's own index, so
              a flatline never reads as "no motion" on its own. */}
          {trace.distinctTimestamps !== null && trace.committed !== null && trace.distinctTimestamps < trace.committed ? (
            <Text style={styles.line}>
              {`The ${trace.committed} committed frames carry ${trace.distinctTimestamps} distinct capture timestamp${trace.distinctTimestamps === 1 ? '' : 's'} — the retained frames did not advance during this capture.`}
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

const buildStyles = () => StyleSheet.create({
  line: { color: colors.text, fontSize: fontSize.sm, lineHeight: 19, marginTop: spacing.xs + 2 },
  dim: { color: colors.textDim, fontSize: fontSize.xs, lineHeight: 17, marginTop: spacing.xs },
  juxta: { marginTop: spacing.xs },
  // The dual-lane chart: two stacked lanes, one shared time axis around the
  // shutter (0.18.3 redesign — lanes replace the overlaid strip).
  chartWrap: { marginTop: spacing.sm },
  laneLabels: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline',
    marginBottom: 5,
  },
  laneLabelsSecond: { marginTop: 14 },
  laneName: { color: colors.textFaint, fontSize: fontSize.xs, letterSpacing: 0.2 },
  lanePeak: { color: colors.textFaint, fontSize: fontSize.xs, fontVariant: ['tabular-nums'] },
  lane: { height: 48, position: 'relative' },
  chartBaseline: {
    position: 'absolute', left: 0, right: 0, bottom: 0,
    height: StyleSheet.hairlineWidth, backgroundColor: colors.border,
  },
  chartBarFrames: {
    position: 'absolute', bottom: 0,
    borderRadius: 1.5, backgroundColor: SERIES_FRAMES,
  },
  chartBarGyro: {
    position: 'absolute', bottom: 0,
    width: 4, marginLeft: -2,
    borderRadius: 1.5, backgroundColor: SERIES_GYRO,
  },
  chartShutter: {
    position: 'absolute', top: 0, bottom: 0,
    width: 1.5, marginLeft: -0.75,
    backgroundColor: colors.textDim,
  },
  axis: {
    position: 'relative', height: 18, marginTop: 4,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.borderSoft,
  },
  axisTick: {
    position: 'absolute', top: 3, width: 64, marginLeft: -32,
    textAlign: 'center', color: colors.textFaint, fontSize: 10,
    fontVariant: ['tabular-nums'],
  },
  axisTickShutter: { color: colors.textDim },
  legend: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 5 },
  legendDot: { width: 6, height: 6, borderRadius: 3 },
  legendText: { color: colors.textFaint, fontSize: fontSize.xs, marginRight: spacing.sm },
});

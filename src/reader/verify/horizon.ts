// Source Kit 0.1.0 — dead-code gate does not remove
/**
 * NO SCREEN RENDERS THIS YET. Kept deliberately, and listed in knip.json so
 * the dead-code gate does not remove it. The logic is finished; what it is
 * missing is the injected edge measurement described below, which nothing in
 * the app currently supplies. Without that it would answer 'insufficient'
 * every time, which is why it is not wired rather than why it is not written.
 *
 * Horizon vs gravity — does the horizon in the pixels agree with the
 * gravity the IMU committed at the shutter?
 *
 * Prediction side: the signed pose trace (verify-core/provenance/manifest.ts
 * PoseTrace) commits the fused attitude — roll/pitch/yaw in decidegrees,
 * xyz-interleaved, sample `anchor` nearest the shutter. Camera roll is the
 * horizon's tilt in the frame: the committed attitude predicts where the
 * horizon should sit.
 *
 * Measurement side: the strongest horizontal edge in the image is PIXEL
 * analysis this engine does not run. It is INJECTED (same adapter pattern
 * as deskCore's DeskAdapters — the measurement arrives from a rasterizer
 * the host provides, and the card names its source). Without it the card
 * is 'insufficient' with the prediction exposed, never silently green;
 * without a committed pose trace it is 'not-run' — no attitude was
 * committed, so there is nothing to predict from. Nothing is fabricated:
 * the committed fixtures carry no poseTrace, so they render not-run and
 * the demo says exactly that.
 *
 * Quantization honesty: attitude is committed in decidegrees (±0.05° per
 * axis, stated in manifest.ts) — the prediction carries that floor, and
 * the gap text says so. Error bounds carry the standing caveat verbatim:
 * "error bounds are provisional pending corpus characterization".
 */

import type { AttestationRecord, PoseTrace } from '../../provenance/manifest';
import { makeCard, makeNotRun, makeInsufficient } from '../interpret/cards';
import type { EvidenceCard } from '../types';

/** The standing caveat, verbatim — stated once, applies to every number here. */
export const HORIZON_CAVEAT = 'error bounds are provisional pending corpus characterization';

/**
 * Expected agreement band, degrees of horizon tilt, from the Reader mock's
 * own gauge (±3°): inside the band a gap is consistent with hand-held
 * capture and an uncorrected lens; outside it the pixels and the committed
 * gravity disagree.
 */
export const HORIZON_BAND_DEG = 3;

/** Attitude quantization floor, degrees (manifest.ts: decidegrees). */
export const ATTITUDE_QUANTIZATION_DEG = 0.05;

/**
 * The injected pixel-side measurement: the dominant horizon edge angle in
 * the frame, degrees clockwise from level, as measured by the host's image
 * analyzer. `source` names that analyzer — the card quotes it, never
 * invents it.
 */
export interface HorizonObservation {
  angleDeg: number;
  /** e.g. 'strongest horizontal edge, Hough over luma, 0.1° resolution'. */
  source: string;
}

/**
 * Predicted horizon tilt from the committed attitude at the shutter sample,
 * degrees clockwise from level. Roll is axis 0 of the xyz-interleaved
 * decidegree array; sample `anchor` is nearest the shutter (manifest.ts).
 * Null when the trace is structurally unusable — stated by the caller.
 */
export function predictedHorizonTiltDeg(trace: PoseTrace): number | null {
  const i = trace.anchor * 3;
  if (!Number.isInteger(trace.anchor) || trace.anchor < 0 || i + 2 >= trace.attitude.length) {
    return null;
  }
  const rollDecideg = trace.attitude[i];
  if (typeof rollDecideg !== 'number' || !Number.isFinite(rollDecideg)) return null;
  return rollDecideg / 10;
}

/** Wrap a signed angle difference into [0, 90] degrees of tilt mismatch. */
function tiltGapDeg(a: number, b: number): number {
  let d = Math.abs(a - b) % 180;
  if (d > 90) d = 180 - d;
  return d;
}

const round1 = (v: number): number => Math.round(v * 10) / 10;
const round2 = (v: number): number => Math.round(v * 100) / 100;

export function horizonCard(
  record: AttestationRecord,
  observation?: HorizonObservation | null,
): EvidenceCard {
  const id = 'coherence.horizon';
  const title = 'Horizon vs gravity';
  const methodBase =
    `Read ▸ committed attitude (decidegrees, ±${ATTITUDE_QUANTIZATION_DEG}° quantization) at the shutter-anchored pose-trace sample; ` +
    `${HORIZON_CAVEAT}`;

  const trace = record.context?.poseTrace;
  if (!trace) {
    return makeNotRun(
      id, title,
      'the record commits no pose trace: sensors were off, the capture predates 0.10.0, or the trace was stripped on the de-identify path; there is no committed gravity to predict a horizon from',
      { method: methodBase, audit: 'Audit ▸ SensorContext.poseTrace (0.10.0+); absent on older records and every de-identified copy' },
    );
  }

  const predicted = predictedHorizonTiltDeg(trace);
  if (predicted === null) {
    return makeNotRun(
      id, title,
      'the committed pose trace is structurally unusable (anchor outside the attitude array, or non-numeric samples), so no prediction can be read from it',
      { method: methodBase, audit: `Audit ▸ poseTrace.anchor=${trace.anchor}, attitude[]=${trace.attitude.length} entries` },
    );
  }

  const prediction =
    `committed gravity at the shutter (roll ${round1(predicted)}°, ±${ATTITUDE_QUANTIZATION_DEG}° quantization ◌ self-reported IMU): the horizon should sit at that tilt in the frame`;
  const audit =
    'Audit ▸ poseTrace.attitude[3·anchor] → roll; yaw/pitch travel with the trace for the full gravity vector in the complete Reader';

  if (!observation) {
    return makeInsufficient(
      id, title, prediction,
      'no horizon edge has been measured: pixel analysis is injected by the host (a rasterizer), and none was supplied',
      'the prediction is shown next to the photo; this engine cannot read the pixels itself',
      {
        gauge: { value: round1(predicted), band: [-HORIZON_BAND_DEG, HORIZON_BAND_DEG], units: '° predicted horizon tilt' },
        method: methodBase, audit,
      },
    );
  }

  const gap = tiltGapDeg(observation.angleDeg, predicted);
  const measurement =
    `strongest horizontal edge at ${round1(observation.angleDeg)}° (${observation.source})`;
  const method =
    `${methodBase}; measurement injected: ${observation.source}`;
  const gauge = {
    value: round2(observation.angleDeg - predicted),
    band: [-HORIZON_BAND_DEG, HORIZON_BAND_DEG] as [number, number],
    units: '° observed − predicted',
  };

  if (gap <= HORIZON_BAND_DEG) {
    return makeCard({
      id, title, state: 'agrees', prediction, measurement, method, audit, gauge,
      gap: `${round1(gap)}° inside the ±${HORIZON_BAND_DEG}° band (quantization floor ±${ATTITUDE_QUANTIZATION_DEG}° on the prediction side)`,
      interpretation:
        'consistent with hand-held capture and an uncorrected lens: the pixels and the committed gravity tell the same story',
    });
  }
  return makeCard({
    id, title, state: 'diverges', prediction, measurement, method, audit, gauge,
    gap: `${round1(gap)}° OUTSIDE the ±${HORIZON_BAND_DEG}° band`,
    interpretation:
      'the horizon in the pixels and the gravity the IMU committed disagree; consistent with a manipulated frame, a synthetic feed, or a mis-committed attitude — the data does not say which',
  });
}
